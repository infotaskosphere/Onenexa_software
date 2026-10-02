"""Finix domain models extracted from backend/accounting_ai/finix_ai_router.py."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from fastapi import HTTPException
from datetime import date
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from backend.models import User
from backend.dependencies import db
from backend.accounting_core import get_default_account_id
from backend.party_ledgers import get_or_create_party_account
from backend.accounting_ai.finix_intelligence import FinixIntelligence
from backend.accounting_ai.accounting_policy import classify_transaction

PAISE = Decimal("0.01")

class FinixAIRequest(BaseModel):
    text: str = Field(..., min_length=2, max_length=4000)
    company_id: str = ""
    accounting_date: Optional[str] = None

class FinixAIPostRequest(BaseModel):
    proposal_id: str


def _permissions(user: User) -> dict:
    p = user.permissions if isinstance(user.permissions, dict) else (
        user.permissions.model_dump() if user.permissions else {}
    )
    return p or {}


def _can_view(user: User) -> bool:
    return str(user.role or "").lower() == "admin" or bool(
        _permissions(user).get("can_view_journal_entries")
        or _permissions(user).get("can_view_accounting_reports")
        or _permissions(user).get("can_post_journal_entries")
    )


def _can_post(user: User) -> bool:
    return str(user.role or "").lower() == "admin" or bool(
        _permissions(user).get("can_post_journal_entries")
    )


def _money(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)
    except Exception:
        return Decimal("0.00")


def _date(value: Optional[str]) -> str:
    if not value:
        return date.today().isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except Exception:
        raise HTTPException(400, "Accounting date must be YYYY-MM-DD.")


def _gst_rate(text: str) -> Decimal:
    m = re.search(r"(?:gst|igst|cgst\s*\+\s*sgst)[^%]{0,20}(\d+(?:\.\d+)?)\s*%", text or "", re.I)
    if not m:
        m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*gst", text or "", re.I)
    if not m:
        return Decimal("0")
    rate = _money(m.group(1))
    return rate if rate in {Decimal("5.00"), Decimal("12.00"), Decimal("18.00"), Decimal("28.00")} else Decimal("0")


def _gst_amount(amount: Decimal, text: str) -> tuple[Decimal, Decimal]:
    rate = _gst_rate(text)
    if rate <= 0:
        return amount, Decimal("0.00")
    if re.search(r"including\s+gst|incl\.?\s*gst|inclusive\s+gst", text or "", re.I):
        taxable = (amount * Decimal("100") / (Decimal("100") + rate)).quantize(PAISE, rounding=ROUND_HALF_UP)
        return taxable, (amount - taxable).quantize(PAISE, rounding=ROUND_HALF_UP)
    tax = (amount * rate / Decimal("100")).quantize(PAISE, rounding=ROUND_HALF_UP)
    return amount, tax


async def _party_context(company_id: str, party_name: str) -> dict:
    name = (party_name or "").strip()
    if not name:
        return {}
    # Prefer the canonical party-ledger identity map. It may already contain
    # GSTIN/PAN/email/mobile learned from invoices and prior postings.
    party = await db.party_ledgers.find_one(
        {"company_id": company_id, "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}},
        {"_id": 0},
    )
    if party:
        return {"source": "party_ledger", **party}

    client = await db.clients.find_one(
        {"company_name": {"$regex": re.escape(name), "$options": "i"}},
        {"_id": 0},
    )
    if client:
        return {
            "source": "client_master",
            "external_id": client.get("id"),
            "name": client.get("company_name") or name,
            "gstin": client.get("gstin") or client.get("gst_number") or "",
            "pan": client.get("pan") or "",
            "email": client.get("email") or "",
            "mobile": client.get("phone") or client.get("mobile") or "",
        }

    return {}


async def _bank_context(company_id: str, text: str) -> dict:
    banks = await db.bank_accounts.find({"company_id": company_id}, {"_id": 0}).sort("is_primary", -1).to_list(50)
    if not banks:
        return {}
    lower = (text or "").lower()
    for bank in banks:
        label = " ".join(str(bank.get(k) or "") for k in ("bank_name", "account_holder", "ifsc", "account_number_masked"))
        if any(token and token.lower() in lower for token in [bank.get("bank_name"), bank.get("account_holder"), bank.get("ifsc")]):
            return bank
    return banks[0]


async def _account(company_id: str, code: str) -> dict:
    account_id = await get_default_account_id(company_id, code)
    if not account_id:
        raise HTTPException(400, f"Required accounting account {code} is not available for this company.")
    account = await db.chart_of_accounts.find_one({"id": account_id, "company_id": company_id}, {"_id": 0})
    if not account:
        raise HTTPException(400, f"Required accounting ledger {code} could not be resolved.")
    return account


async def _resolve_party(company_id: str, party_name: str, party_type: str, created_by: str) -> dict:
    context = await _party_context(company_id, party_name)
    return await get_or_create_party_account(
        company_id,
        party_type,
        context.get("name") or party_name,
        external_id=context.get("external_id"),
        gstin=context.get("gstin"),
        pan=context.get("pan"),
        email=context.get("email"),
        mobile=context.get("mobile"),
        created_by=created_by,
    ) or {}


def _line(account: dict, debit: Decimal = Decimal("0"), credit: Decimal = Decimal("0"), memo: str = "") -> dict:
    return {
        "account_id": account["id"],
        "account_name": account.get("name", ""),
        "debit": float(debit),
        "credit": float(credit),
        "memo": memo,
    }


async def _build_proposal(text: str, company_id: str, accounting_date: str, user: User) -> dict:
    interpreted = FinixIntelligence.interpret(text, default_company_id=company_id)
    event = interpreted["event"]
    amount = _money(interpreted.get("amount"))
    party_name = interpreted.get("party_name") or ""

    if not interpreted.get("success"):
        return {"success": False, "interpretation": interpreted, "needs_clarification": interpreted.get("needs_clarification", [])}

    policy_payload = dict(interpreted.get("draft_payload") or {})
    policy_payload["accounting_substance_confirmed"] = event not in {
        "FIXED_ASSET", "PREPAID_EXPENSE", "ADVANCE_PAYMENT", "ADVANCE_RECEIPT",
        "ACCRUAL", "PROVISION", "LOAN_RECEIPT", "LOAN_REPAYMENT", "INTEREST",
    }
    policy = classify_transaction(event, policy_payload)
    if policy.get("status") != "READY":
        return {"success": False, "interpretation": interpreted, "needs_clarification": [policy.get("reason", "Accounting clarification is required.")]}

    taxable, gst = _gst_amount(amount, text)
    gst_rate = _gst_rate(text)
    lines: List[dict] = []
    context: Dict[str, Any] = {}

    if event == "SALE":
        party = await _resolve_party(company_id, party_name, "customer", user.id)
        if not party.get("account_id"):
            raise HTTPException(400, "Customer ledger could not be resolved.")
        sales = await _account(company_id, "4000")
        ar = {"id": party["account_id"], "name": party["account_name"]}
        output = await _account(company_id, "2100")
        lines = [_line(ar, amount, memo=f"Customer: {party_name}"), _line(sales, Decimal("0"), taxable, memo="Sales income")]
        if gst > 0:
            lines.append(_line(output, Decimal("0"), gst, memo=f"GST output @ {gst_rate}%"))
        context = {"party": party, "gst_rate": float(gst_rate), "taxable_value": float(taxable), "gst": float(gst)}

    elif event == "PURCHASE":
        party = await _resolve_party(company_id, party_name, "vendor", user.id)
        if not party.get("account_id"):
            raise HTTPException(400, "Vendor ledger could not be resolved.")
        purchases = await _account(company_id, "5000")
        ap = {"id": party["account_id"], "name": party["account_name"]}
        input_gst = await _account(company_id, "1200")
        lines = [_line(purchases, taxable, memo="Purchase / inventory"), _line(ap, Decimal("0"), amount, memo=f"Vendor: {party_name}")]
        if gst > 0:
            lines.append(_line(input_gst, gst, memo=f"GST input @ {gst_rate}%"))
        context = {"party": party, "gst_rate": float(gst_rate), "taxable_value": float(taxable), "gst": float(gst)}

    elif event == "RECEIPT":
        party = await _resolve_party(company_id, party_name, "customer", user.id)
        bank = await _account(company_id, "1010")
        ar = {"id": party["account_id"], "name": party["account_name"]} if party.get("account_id") else await _account(company_id, "1100")
        lines = [_line(bank, amount, memo="Customer receipt"), _line(ar, Decimal("0"), amount, memo=f"From {party_name}")]
        context = {"party": party, "bank": await _bank_context(company_id, text)}

    elif event == "PAYMENT":
        bank = await _account(company_id, "1010")
        party = await _party_context(company_id, party_name)
        expense_code = "5200" if re.search(r"rent", text, re.I) else "5100" if re.search(r"salary|wages", text, re.I) else "5300" if re.search(r"office|stationery|admin", text, re.I) else "5000"
        if party.get("party_type") == "vendor" or re.search(r"supplier|vendor", text, re.I):
            party_ledger = await _resolve_party(company_id, party_name, "vendor", user.id)
            debit_account = {"id": party_ledger["account_id"], "name": party_ledger["account_name"]}
            memo = f"Payment to {party_name}"
        else:
            debit_account = await _account(company_id, expense_code)
            memo = f"Expense/payment: {party_name or 'business payment'}"
        lines = [_line(debit_account, amount, memo=memo), _line(bank, Decimal("0"), amount, memo="Paid from bank")]
        context = {"party": party, "bank": await _bank_context(company_id, text), "expense_account": debit_account.get("name")}

    elif event == "BANK_CHARGE":
        expense = await _account(company_id, "5400")
        bank = await _account(company_id, "1010")
        lines = [_line(expense, amount, memo="Bank charges"), _line(bank, Decimal("0"), amount, memo="Bank deduction")]
        context = {"bank": await _bank_context(company_id, text)}

    elif event == "BANK_TRANSFER":
        bank = await _account(company_id, "1010")
        lines = [_line(bank, amount, memo="Bank transfer destination"), _line(bank, Decimal("0"), amount, memo="Bank transfer source")]
        context = {"bank": await _bank_context(company_id, text), "requires_bank_selection": True}

    else:
        return {"success": False, "interpretation": interpreted, "needs_clarification": [f"Finix has understood this as {event}, but this transaction currently needs an accounting-specific confirmation before posting."]}

    total_debit = round(sum(float(x["debit"]) for x in lines), 2)
    total_credit = round(sum(float(x["credit"]) for x in lines), 2)
    if abs(total_debit - total_credit) > 0.01:
        raise HTTPException(500, "Finix generated an unbalanced proposal; posting has been blocked.")

    proposal_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    proposal = {
        "id": proposal_id,
        "company_id": company_id,
        "accounting_date": accounting_date,
        "text": text,
        "event": event,
        "amount": float(amount),
        "narration": text.strip(),
        "lines": lines,
        "context": context,
        "interpretation": interpreted,
        "policy": policy,
        "status": "PROPOSED",
        "created_by": user.id,
        "created_at": now,
        "updated_at": now,
    }
    await db.finix_ai_proposals.insert_one(dict(proposal))

    human_lines = [
        {
            "debit": x["debit"], "credit": x["credit"], "account": x["account_name"],
            "explanation": (f"Debit {x['account_name']} by ₹{x['debit']:,.2f}" if x["debit"] else f"Credit {x['account_name']} by ₹{x['credit']:,.2f}"),
        }
        for x in lines
    ]
    return {
        "success": True,
        "proposal_id": proposal_id,
        "status": "PROPOSED",
        "event": event,
        "confidence": interpreted.get("confidence"),
        "confidence_band": interpreted.get("confidence_band"),
        "amount": float(amount),
        "party_name": party_name,
        "context": context,
        "policy": policy,
        "human_explanation": f"Finix understood: {text.strip()}",
        "debit_credit": human_lines,
        "lines": lines,
        "message": "Nothing has been posted yet. Review the proposal and choose Approve & Post.",
    }

