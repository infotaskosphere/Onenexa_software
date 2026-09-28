"""Finix AI Accounting workflow.

Natural language is used only to understand and propose an accounting action.
The existing party-ledger, chart-of-accounts and guarded journal-posting
boundary remain the source of truth for the actual books.
"""
from __future__ import annotations
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.ai.models_finix_ai import FinixAIRequest, FinixAIPostRequest
from backend.models import User
from backend.accounting_core import get_default_account_id
from backend.party_ledgers import get_or_create_party_account
from backend.accounting_ai.finix_intelligence import FinixIntelligence

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Accounting"])


def _permissions(user: User) -> dict:
    perms = getattr(user, "permissions", None)
    if isinstance(perms, dict):
        return perms
    try:
        return perms.model_dump() if perms else {}
    except Exception:
        return {}


def _can_view(user: User) -> bool:
    if str(getattr(user, "role", "") or "").lower() == "admin":
        return True
    perms = _permissions(user)
    return bool(perms.get("can_view_accounting_reports") or perms.get("can_view_journal_entries") or perms.get("can_post_journal_entries"))


def _can_post(user: User) -> bool:
    if str(getattr(user, "role", "") or "").lower() == "admin":
        return True
    return bool(_permissions(user).get("can_post_journal_entries"))


def _date(value: Optional[str]) -> str:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat() if value else date.today().isoformat()
    except (TypeError, ValueError):
        return date.today().isoformat()


async def _account(company_id: str, code: str, name: str, debit: float = 0, credit: float = 0) -> dict:
    account_id = await get_default_account_id(company_id, code)
    if not account_id:
        raise HTTPException(500, f"Finix could not initialize accounting account {code} ({name}).")
    return {"account_id": account_id, "account_name": name, "debit": round(float(debit or 0), 2), "credit": round(float(credit or 0), 2)}


async def _party(company_id: str, name: str, party_type: str, debit: float = 0, credit: float = 0, created_by: str = "system") -> dict:
    party = await get_or_create_party_account(company_id, party_type, name, created_by=created_by)
    if not party:
        raise HTTPException(400, "Finix needs a valid customer/vendor name before preparing the voucher.")
    return {"account_id": party["account_id"], "account_name": party["account_name"], "debit": round(float(debit or 0), 2), "credit": round(float(credit or 0), 2)}


def _expense(text: str):
    value = str(text or "").lower()
    for words, account in (
        (("rent", "lease"), ("5200", "Rent Expense")),
        (("salary", "salaries", "payroll", "wages"), ("5100", "Salaries & Wages")),
        (("software", "saas", "cloud subscription"), ("5250", "Software & Cloud Expenses")),
        (("bank charge", "bank fee"), ("5400", "Bank Charges")),
        (("shipping", "freight", "courier"), ("5500", "Shipping & Freight")),
        (("travel", "conveyance", "taxi", "cab"), ("5600", "Travel & Conveyance")),
        (("office expense", "office supplies", "stationery"), ("5300", "Office & Admin Expenses")),
    ):
        if any(word in value for word in words):
            return account
    return None


def _tds_rate(text: str) -> Optional[float]:
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*%", str(text or ""))
    for value in matches:
        rate = float(value)
        if 0 < rate <= 100 and ("tds" in str(text or "").lower() or "tax deducted" in str(text or "").lower()):
            return rate
    return None


async def _build_proposal(text: str, company_id: str, accounting_date: str, current_user: User) -> dict:
    interpretation = FinixIntelligence.interpret(text, default_company_id=company_id)
    result = dict(interpretation)
    result.update({"company_id": company_id, "accounting_date": accounting_date, "interpretation": interpretation})
    if not interpretation.get("success"):
        result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
        return result

    event = str(interpretation.get("event") or "").upper()
    amount = float(interpretation.get("amount") or 0)
    party_name = str(interpretation.get("party_name") or "").strip()
    lines = []
    tds_result = None

    if event == "SALE":
        lines = [await _party(company_id, party_name, "customer", debit=amount, created_by=current_user.id), await _account(company_id, "4000", "Sales / Fee Income", credit=amount)]
    elif event == "PURCHASE":
        lines = [await _account(company_id, "5000", "Purchases", debit=amount), await _party(company_id, party_name, "vendor", credit=amount, created_by=current_user.id)]
    elif event == "PAYMENT":
        expense = _expense(text)
        if not expense:
            result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
            result["needs_clarification"] = list(result.get("needs_clarification") or []) + ["Which expense/account should this payment be charged to?"]
            return result
        code, name = expense
        rate = _tds_rate(text)
        if rate:
            deduction = round(amount * rate / 100, 2)
            lines = [await _account(company_id, code, name, debit=amount), await _account(company_id, "2200", "TDS Payable", credit=deduction), await _account(company_id, "1010", "Bank Accounts", credit=amount - deduction)]
            tds_result = {"applicable": True, "rate": rate, "effective_rate": rate, "deduction_amount": deduction, "statutory_reference": "TDS payable"}
        else:
            lines = [await _account(company_id, code, name, debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "RECEIPT":
        lines = [await _account(company_id, "1010", "Bank Accounts", debit=amount), await _party(company_id, party_name, "customer", credit=amount, created_by=current_user.id)]
    elif event == "BANK_CHARGE":
        lines = [await _account(company_id, "5400", "Bank Charges", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "GST_PAYMENT":
        lines = [await _account(company_id, "2100", "GST Output Payable", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "TDS_PAYMENT":
        lines = [await _account(company_id, "2200", "TDS Payable", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "FIXED_ASSET":
        lines = [await _account(company_id, "1300", "Fixed Assets", debit=amount), await _party(company_id, party_name, "vendor", credit=amount, created_by=current_user.id)]
    else:
        result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
        return result

    debit = round(sum(float(x.get("debit") or 0) for x in lines), 2)
    credit = round(sum(float(x.get("credit") or 0) for x in lines), 2)
    if debit <= 0 or abs(debit - credit) > 0.01:
        raise HTTPException(500, "Finix generated an unbalanced accounting proposal and stopped safely.")

    now = datetime.now(timezone.utc).isoformat()
    proposal_id = str(uuid.uuid4())
    proposal = {"id": proposal_id, "company_id": company_id, "accounting_date": accounting_date, "narration": text.strip(), "event": event, "amount": amount, "party_name": party_name, "interpretation": interpretation, "lines": lines, "status": "PROPOSED", "created_by": current_user.id, "created_at": now, "updated_at": now, "source": "finix_ai_agent"}
    await db.finix_ai_proposals.insert_one(proposal)
    result.update({"success": True, "proposal_id": proposal_id, "status": "PROPOSED", "agent_stage": "PROPOSAL_READY", "lines": lines, "narration": text.strip(), "total_debit": debit, "total_credit": credit})
    if tds_result:
        result["tds_result"] = tds_result
    return result


@router.post("/interpret")
async def finix_ai_interpret(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


@router.post("/propose")
async def finix_ai_propose(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


@router.post("/post")
async def finix_ai_post(payload: FinixAIPostRequest, current_user: User = Depends(get_current_user)):
    if not _can_post(current_user):
        raise HTTPException(403, "Posting requires journal-posting permission.")
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    if proposal.get("created_by") != current_user.id and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Only the proposal owner or an admin can post this proposal.")
    if proposal.get("status") == "POSTED":
        return {"success": True, "status": "POSTED", "journal_entry": proposal.get("journal_entry")}
    try:
        from backend import accounting_core as ac
        entry = await ac.post_journal_entry(proposal["company_id"], proposal["accounting_date"], proposal["narration"], proposal["lines"], "ai_zero_touch", proposal["id"], current_user.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Finix posting was blocked: {type(exc).__name__}: {exc}")
    now = datetime.now(timezone.utc).isoformat()
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {"status": "POSTED", "journal_entry": entry, "posted_by": current_user.id, "posted_at": now, "updated_at": now, "audit": {"proposal_created_by": proposal.get("created_by"), "approved_by": current_user.id, "approved_at": now, "accounting_date": proposal.get("accounting_date"), "journal_entry_id": entry.get("id") if isinstance(entry, dict) else None, "source": "finix_ai"}}})
    return {"success": True, "status": "POSTED", "journal_entry": entry, "message": "Transaction posted through the governed accounting ledger."}


@router.get("/proposal/{proposal_id}")
async def finix_ai_get_proposal(proposal_id: str, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    proposal = await db.finix_ai_proposals.find_one({"id": proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    return proposal


@router.get("/recent")
async def finix_ai_recent(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = (company_id or getattr(current_user, "company_id", "") or "").strip()
    return await db.finix_ai_proposals.find({"company_id": cid}, {"_id": 0}).sort("created_at", -1).to_list(50)


async def create_finix_ai_indexes():
    await db.finix_ai_proposals.create_index([("company_id", 1), ("created_at", -1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("source_id", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1), ("id", 1)])
