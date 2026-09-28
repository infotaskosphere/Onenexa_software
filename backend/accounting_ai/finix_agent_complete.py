"""Integrated Finix AI orchestration layer.

This module coordinates existing accounting, learning, invoice and bank data.
It deliberately does not replace the governed accounting posting engine.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, date, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.accounting_ai.finix_learning import get_learning_context, record_learning
from backend.accounting_ai.finix_ai_router import _build_proposal, _can_post, _can_view, _date

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Agent"])


def _safe_float(value: Any, default: float = 0.0) -> float:
    """Normalize legacy accounting values without letting one malformed field crash Finix."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _date_key(value: Any) -> str:
    """Normalize Mongo/date/string due dates to YYYY-MM-DD for forecast comparisons."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or "")[:10]


def _company(user: User, company_id: str = "") -> str:
    cid = (company_id or getattr(user, "company_id", "") or "").strip()
    if not cid:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return cid


class AgentProposalRequest(BaseModel):
    text: str = Field(..., min_length=2, max_length=4000)
    company_id: str = ""
    accounting_date: Optional[str] = None


class FeedbackRequest(BaseModel):
    proposal_id: str
    outcome: str = Field(..., pattern="^(APPROVED_POSTED|CORRECTED|REJECTED)$")
    correction: Optional[dict] = None


class InboxActionRequest(BaseModel):
    proposal_id: str
    action: str = Field(..., pattern="^(APPROVE|REJECT)$")


class AskRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=1000)
    company_id: str = ""


async def _party_history(company_id: str, party_name: str) -> dict:
    if not party_name:
        return {"transactions": [], "invoice_count": 0, "outstanding": 0.0}
    q = {"company_id": company_id, "$or": [
        {"client_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"supplier_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"customer_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"vendor_name": {"$regex": re.escape(party_name), "$options": "i"}},
    ]}
    invoices = await db.invoices.find(q, {"_id": 0}).sort("invoice_date", -1).to_list(20)
    purchases = await db.purchase_invoices.find(q, {"_id": 0}).sort("invoice_date", -1).to_list(20)
    all_docs = invoices + purchases
    return {"transactions": all_docs[:20], "invoice_count": len(all_docs), "outstanding": round(sum(_safe_float(d.get("amount_due")) for d in all_docs), 2)}


async def _learning_and_history(result: dict, cid: str) -> dict:
    result["learning"] = await get_learning_context(cid, result.get("event", ""), result.get("party_name", ""))
    result["party_history"] = await _party_history(cid, result.get("party_name", ""))
    result["agent_stage"] = "PROPOSAL_READY"
    return result


@router.post("/agent/propose")
async def agent_propose(payload: AgentProposalRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, payload.company_id)
    return await _learning_and_history(await _build_proposal(payload.text.strip(), cid, _date(payload.accounting_date), current_user), cid)


@router.post("/feedback")
async def agent_feedback(payload: FeedbackRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    if proposal.get("company_id") != getattr(current_user, "company_id", "") and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Proposal belongs to another company.")
    if proposal.get("created_by") != current_user.id and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Only the proposal owner or an admin can provide feedback.")
    await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, payload.outcome, current_user.id, payload.correction)
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {"feedback": payload.outcome, "correction": payload.correction, "feedback_by": current_user.id, "feedback_at": datetime.now(timezone.utc).isoformat()}})
    return {"success": True, "learned": True, "outcome": payload.outcome}


@router.get("/inbox")
async def agent_inbox(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)
    items = await db.finix_ai_proposals.find({"company_id": cid, "status": {"$in": ["PROPOSED", "REVIEW_REQUIRED"]}}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return {"items": items, "count": len(items)}


@router.post("/inbox/action")
async def agent_inbox_action(payload: InboxActionRequest, current_user: User = Depends(get_current_user)):
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    is_admin = str(current_user.role or "").lower() == "admin"
    if not is_admin and proposal.get("company_id") != getattr(current_user, "company_id", ""):
        raise HTTPException(403, "Proposal belongs to another company.")
    if proposal.get("created_by") != current_user.id and not is_admin:
        raise HTTPException(403, "Only the proposal owner or an admin can action this proposal.")
    if payload.action == "REJECT":
        await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {"status": "REJECTED", "updated_at": datetime.now(timezone.utc).isoformat()}})
        await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, "REJECTED", current_user.id)
        return {"success": True, "status": "REJECTED"}
    if not _can_post(current_user):
        raise HTTPException(403, "Posting requires journal-posting permission.")
    if proposal.get("status") == "POSTED":
        return {"success": True, "status": "POSTED", "journal_entry": proposal.get("journal_entry")}
    from backend import accounting_core as ac
    try:
        entry = await ac.post_journal_entry(proposal["company_id"], proposal["accounting_date"], proposal["narration"], proposal["lines"], "ai_zero_touch", proposal["id"], current_user.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Finix posting was blocked: {type(exc).__name__}: {exc}")
    now = datetime.now(timezone.utc).isoformat()
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {
        "status": "POSTED",
        "journal_entry": entry,
        "posted_by": current_user.id,
        "posted_at": now,
        "updated_at": now,
        "audit": {
            "proposal_created_by": proposal.get("created_by"),
            "approved_by": current_user.id,
            "approved_at": now,
            "accounting_date": proposal.get("accounting_date"),
            "journal_entry_id": entry.get("id") if isinstance(entry, dict) else None,
            "source": "finix_ai_agent",
        },
    }})
    await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, "APPROVED_POSTED", current_user.id)
    return {"success": True, "status": "POSTED", "journal_entry": entry}


async def _extract_upload(upload: UploadFile) -> dict:
    raw = await upload.read()
    name = (upload.filename or "upload").lower()
    text = ""
    extraction = "text"
    if name.endswith((".txt", ".csv")):
        text = raw.decode("utf-8", errors="ignore")[:50000]
        if name.endswith(".csv"):
            rows = list(csv.reader(io.StringIO(text)))[:100]
            text = "\n".join(" | ".join(r) for r in rows)
            extraction = "csv"
    elif name.endswith(".pdf"):
        extraction = "pdf"
        try:
            from pypdf import PdfReader
            text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(raw)).pages)[:50000]
        except Exception:
            text = ""
    elif name.endswith((".xlsx", ".xls")):
        extraction = "spreadsheet"
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            chunks = []
            for ws in wb.worksheets[:5]:
                for row in ws.iter_rows(max_row=100, values_only=True):
                    chunks.append(" | ".join(str(v or "") for v in row))
            text = "\n".join(chunks)[:50000]
        except Exception:
            text = ""
    else:
        extraction = "image_or_unknown"
    return {"filename": upload.filename or "upload", "size": len(raw), "extraction": extraction, "text": text}


@router.post("/upload")
async def agent_upload(file: UploadFile = File(...), company_id: str = "", accounting_date: Optional[str] = None, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)
    extracted = await _extract_upload(file)
    doc_id = str(uuid.uuid4())
    await db.finix_ai_documents.insert_one({"id": doc_id, "company_id": cid, "filename": extracted["filename"], "size": extracted["size"], "extraction": extracted["extraction"], "text": extracted["text"], "status": "EXTRACTED", "created_by": current_user.id, "created_at": datetime.now(timezone.utc).isoformat()})
    if not extracted["text"].strip():
        return {"success": True, "document_id": doc_id, "status": "REVIEW_REQUIRED", "message": "Document received; readable text could not be extracted. Finix has not posted anything."}
    result = await _build_proposal(extracted["text"], cid, _date(accounting_date), current_user)
    result["document_id"] = doc_id
    result["source_filename"] = extracted["filename"]
    if result.get("success"):
        await db.finix_ai_proposals.update_one({"id": result["proposal_id"]}, {"$set": {"source_document_id": doc_id, "source_filename": extracted["filename"]}})
    return await _learning_and_history(result, cid)


@router.post("/ask")
async def agent_ask(payload: AskRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, payload.company_id)
    q = payload.question.lower()
    result: dict[str, Any] = {"question": payload.question, "company_id": cid, "source": "live accounting data"}
    if any(x in q for x in ("profit", "loss", "p&l", "p and l")):
        entries = await db.journal_lines.find({"company_id": cid}, {"_id": 0}).to_list(100000)
        account_ids = {a.get("id"): a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0}).to_list(5000)}
        income = expense = 0.0
        for line in entries:
            acct = account_ids.get(line.get("account_id"), {})
            if acct.get("type") == "income": income += _safe_float(line.get("credit")) - _safe_float(line.get("debit"))
            elif acct.get("type") == "expense": expense += _safe_float(line.get("debit")) - _safe_float(line.get("credit"))
        result.update({"income": round(income, 2), "expenses": round(expense, 2), "profit": round(income-expense, 2)})
    elif any(x in q for x in ("receivable", "customer outstanding", "debtors")):
        docs = await db.invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
        result.update({"receivables": round(sum(_safe_float(d.get("amount_due")) for d in docs), 2), "invoice_count": len(docs)})
    elif any(x in q for x in ("payable", "vendor outstanding", "creditors")):
        docs = await db.purchase_invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
        result.update({"payables": round(sum(_safe_float(d.get("amount_due")) for d in docs), 2), "invoice_count": len(docs)})
    elif "gst" in q:
        lines = await db.journal_lines.find({"company_id": cid}, {"_id": 0}).to_list(100000)
        accounts = {a.get("id"): a for a in await db.chart_of_accounts.find({"company_id": cid, "code": {"$in": ["2100", "1200"]}}, {"_id": 0}).to_list(10)}
        output = input_tax = 0.0
        for line in lines:
            acct = accounts.get(line.get("account_id"), {})
            if acct.get("code") == "2100": output += _safe_float(line.get("credit")) - _safe_float(line.get("debit"))
            elif acct.get("code") == "1200": input_tax += _safe_float(line.get("debit")) - _safe_float(line.get("credit"))
        result.update({"output_gst": round(output, 2), "input_gst": round(input_tax, 2), "net_gst": round(output-input_tax, 2)})
    elif any(x in q for x in ("tds", "tax deducted")):
        purchases = await db.purchase_invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
        total_tds = sum(_safe_float(p.get("tds_amount")) for p in purchases)
        result.update({"total_tds_deducted": round(total_tds, 2), "challan_due": "7th of following month"})
    elif any(x in q for x in ("health", "score", "audit", "trial balance")):
        lines = await db.journal_lines.find({"company_id": cid}, {"_id": 0, "debit": 1, "credit": 1}).to_list(100000)
        dr = sum(_safe_float(l.get("debit")) for l in lines)
        cr = sum(_safe_float(l.get("credit")) for l in lines)
        result.update({"trial_balance_debits": round(dr, 2), "trial_balance_credits": round(cr, 2), "balanced": abs(dr - cr) < 0.05})
    elif any(x in q for x in ("cash flow", "forecast", "runway")):
        banks = await db.bank_accounts.find({"company_id": cid}, {"_id": 0, "current_balance": 1, "balance": 1}).to_list(100)
        total_cash = sum(_safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance")) for b in banks)
        result.update({"current_cash_bank": round(total_cash, 2), "status": "Available in Cashflow Forecast report"})
    else:
        result["message"] = "Finix can answer live accounting questions for profit/loss, receivables, payables, GST, TDS, trial balance and cash flow."
    return result


@router.get("/health-score")
async def agent_health_score(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)

    # 1. Trial Balance Equilibrium (25 pts)
    lines = await db.journal_lines.find({"company_id": cid}, {"_id": 0, "debit": 1, "credit": 1, "account_id": 1}).to_list(100000)
    total_debits = sum(_safe_float(l.get("debit")) for l in lines)
    total_credits = sum(_safe_float(l.get("credit")) for l in lines)
    tb_diff = abs(total_debits - total_credits)
    tb_balanced = tb_diff < 0.05
    tb_score = 25 if tb_balanced else max(0, 25 - int(tb_diff))

    # 2. Liquidity & Working Capital (20 pts)
    invoices = await db.invoices.find({"company_id": cid}, {"_id": 0, "amount_due": 1, "total_amount": 1, "due_date": 1, "issue_date": 1, "status": 1}).to_list(10000)
    purchases = await db.purchase_invoices.find({"company_id": cid}, {"_id": 0, "amount_due": 1, "total_amount": 1, "due_date": 1, "status": 1}).to_list(10000)
    banks = await db.bank_accounts.find({"company_id": cid}, {"_id": 0, "current_balance": 1, "balance": 1}).to_list(100)

    total_bank_cash = sum(_safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance")) for b in banks)
    total_ar = sum(_safe_float(inv.get("amount_due")) for inv in invoices)
    total_ap = sum(_safe_float(pur.get("amount_due")) for pur in purchases)

    current_assets = total_bank_cash + total_ar
    current_liabilities = total_ap
    working_capital = current_assets - current_liabilities
    current_ratio = round(current_assets / current_liabilities, 2) if current_liabilities > 0 else (2.0 if current_assets > 0 else 1.0)
    liquidity_score = 20 if current_ratio >= 1.3 else (15 if current_ratio >= 1.0 else 8)

    # 3. Profitability (20 pts)
    accounts = {a.get("id"): a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0, "id": 1, "type": 1, "code": 1}).to_list(5000)}
    income = sum(_safe_float(l.get("credit")) - _safe_float(l.get("debit")) for l in lines if accounts.get(l.get("account_id"), {}).get("type") == "income")
    expense = sum(_safe_float(l.get("debit")) - _safe_float(l.get("credit")) for l in lines if accounts.get(l.get("account_id"), {}).get("type") == "expense")
    net_profit = income - expense
    profit_margin = round((net_profit / income * 100), 1) if income > 0 else 0.0
    profit_score = 20 if net_profit > 0 and profit_margin >= 15 else (15 if net_profit > 0 else (10 if income == 0 and expense == 0 else 5))

    # 4. Debtors Aging & Overdue Quality (15 pts)
    from datetime import date
    today_str = date.today().isoformat()
    overdue_60_amt = 0.0
    for inv in invoices:
        due = _date_key(inv.get("due_date"))
        amt = _safe_float(inv.get("amount_due"))
        if amt > 0 and due and due < today_str:
            try:
                d_obj = datetime.strptime(due, "%Y-%m-%d").date()
                days = (date.today() - d_obj).days
                if days > 60:
                    overdue_60_amt += amt
            except Exception:
                pass
    overdue_ratio = (overdue_60_amt / total_ar) if total_ar > 0 else 0.0
    debtors_score = 15 if overdue_ratio < 0.1 else (10 if overdue_ratio < 0.25 else 5)

    # 5. Statutory Compliance (GST & TDS) (10 pts)
    output_gst = sum(_safe_float(l.get("credit")) - _safe_float(l.get("debit")) for l in lines if accounts.get(l.get("account_id"), {}).get("code") == "2100")
    input_gst = sum(_safe_float(l.get("debit")) - _safe_float(l.get("credit")) for l in lines if accounts.get(l.get("account_id"), {}).get("code") == "1200")
    statutory_score = 10 if abs(output_gst) >= 0 and abs(input_gst) >= 0 else 5

    # 6. Audit & Anomaly Cleanliness (10 pts)
    negative_bank = any(_safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance")) < 0 for b in banks)
    audit_score = 10 if not negative_bank and tb_balanced else 5

    total_score = min(100, tb_score + liquidity_score + profit_score + debtors_score + statutory_score + audit_score)
    grade = "A+" if total_score >= 90 else ("A" if total_score >= 80 else ("B" if total_score >= 65 else "C"))

    return {
        "company_id": cid,
        "score": total_score,
        "grade": grade,
        "trial_balance_balanced": tb_balanced,
        "trial_balance_diff": round(tb_diff, 2),
        "working_capital": round(working_capital, 2),
        "current_ratio": current_ratio,
        "net_profit": round(net_profit, 2),
        "profit_margin": profit_margin,
        "total_receivables": round(total_ar, 2),
        "overdue_60_plus": round(overdue_60_amt, 2),
        "total_payables": round(total_ap, 2),
        "cash_and_bank": round(total_bank_cash, 2),
        "breakdown": {
            "trial_balance": {"score": tb_score, "max": 25, "status": "Passed" if tb_balanced else "Out of balance"},
            "liquidity": {"score": liquidity_score, "max": 20, "ratio": current_ratio, "status": "Strong" if current_ratio >= 1.2 else "Moderate"},
            "profitability": {"score": profit_score, "max": 20, "margin": profit_margin, "status": "Healthy" if net_profit > 0 else "Underperforming"},
            "debtors_quality": {"score": debtors_score, "max": 15, "overdue_pct": round(overdue_ratio * 100, 1), "status": "Low risk" if overdue_ratio < 0.15 else "Review needed"},
            "statutory_compliance": {"score": statutory_score, "max": 10, "status": "Tracked"},
            "ledger_cleanliness": {"score": audit_score, "max": 10, "status": "Clean" if not negative_bank else "Negative bank detected"},
        }
    }


@router.get("/statutory-summary")
async def agent_statutory_summary(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)

    invoices = await db.invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
    purchases = await db.purchase_invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)

    # GST Calculation
    outward_taxable = sum(_safe_float(i.get("taxable_value") if i.get("taxable_value") not in (None, "") else i.get("subtotal")) for i in invoices)
    outward_cgst = sum(_safe_float(i.get("cgst")) for i in invoices)
    outward_sgst = sum(_safe_float(i.get("sgst")) for i in invoices)
    outward_igst = sum(_safe_float(i.get("igst")) for i in invoices)
    total_outward_tax = sum(_safe_float(i.get("total_tax")) if i.get("total_tax") not in (None, "") else (outward_cgst + outward_sgst + outward_igst) for i in invoices)

    inward_taxable = sum(_safe_float(p.get("taxable_value") if p.get("taxable_value") not in (None, "") else p.get("subtotal")) for p in purchases)
    inward_cgst = sum(_safe_float(p.get("cgst")) for p in purchases)
    inward_sgst = sum(_safe_float(p.get("sgst")) for p in purchases)
    inward_igst = sum(_safe_float(p.get("igst")) for p in purchases)
    total_inward_itc = sum(_safe_float(p.get("total_tax")) if p.get("total_tax") not in (None, "") else (inward_cgst + inward_sgst + inward_igst) for p in purchases)

    net_gst_liability = round(total_outward_tax - total_inward_itc, 2)

    # TDS Calculation
    tds_194c = sum(_safe_float(p.get("tds_amount")) for p in purchases if p.get("tds_section") == "194C")
    tds_194j = sum(_safe_float(p.get("tds_amount")) for p in purchases if p.get("tds_section") == "194J")
    tds_194i = sum(_safe_float(p.get("tds_amount")) for p in purchases if p.get("tds_section") == "194I")
    tds_194h = sum(_safe_float(p.get("tds_amount")) for p in purchases if p.get("tds_section") == "194H")
    total_tds = sum(_safe_float(p.get("tds_amount")) for p in purchases)

    return {
        "company_id": cid,
        "gst": {
            "outward_taxable": round(outward_taxable, 2),
            "outward_cgst": round(outward_cgst, 2),
            "outward_sgst": round(outward_sgst, 2),
            "outward_igst": round(outward_igst, 2),
            "total_output_liability": round(total_outward_tax, 2),
            "inward_taxable": round(inward_taxable, 2),
            "inward_cgst": round(inward_cgst, 2),
            "inward_sgst": round(inward_sgst, 2),
            "inward_igst": round(inward_igst, 2),
            "total_input_itc": round(total_inward_itc, 2),
            "net_payable": max(0.0, net_gst_liability),
            "itc_carried_forward": abs(min(0.0, net_gst_liability)),
            "next_filing_date": "20th of current month (GSTR-3B)",
            "filing_status": "Ready for Filing" if total_outward_tax > 0 else "Nil Return Ready"
        },
        "tds": {
            "total_deducted": round(total_tds, 2),
            "sections": {
                "194C_contractor": round(tds_194c, 2),
                "194J_professional": round(tds_194j, 2),
                "194I_rent": round(tds_194i, 2),
                "194H_commission": round(tds_194h, 2),
                "other": round(max(0.0, total_tds - (tds_194c + tds_194j + tds_194i + tds_194h)), 2)
            },
            "challan_due_date": "7th of following month (ITNS 281)",
            "status": "Challan Pending" if total_tds > 0 else "Up to date"
        }
    }


@router.get("/anomalies")
async def agent_anomalies(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)

    anomalies = []

    # Rule 1: High Cash Payments (> ₹10,000 u/s 40A(3))
    cash_accts = {a.get("id") for a in await db.chart_of_accounts.find({"company_id": cid, "name": {"$regex": "cash", "$options": "i"}}, {"_id": 0, "id": 1}).to_list(100)}
    if cash_accts:
        cash_lines = await db.journal_lines.find({"company_id": cid, "account_id": {"$in": list(cash_accts)}, "credit": {"$gt": 10000}}, {"_id": 0}).to_list(10)
        for cl in cash_lines:
            anomalies.append({
                "type": "CASH_LIMIT_40A3",
                "severity": "high",
                "title": "Cash Payment > ₹10,000 u/s 40A(3)",
                "description": f"Credit of ₹{cl.get('credit')} in cash ledger exceeds ₹10,000 daily limit, subject to income tax disallowance.",
                "action": "Review voucher and re-route via bank/NEFT."
            })

    # Rule 2: Negative Bank Balances
    banks = await db.bank_accounts.find({"company_id": cid}, {"_id": 0, "bank_name": 1, "account_number": 1, "current_balance": 1, "balance": 1}).to_list(100)
    for b in banks:
        bal = _safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance"))
        if bal < 0:
            anomalies.append({
                "type": "NEGATIVE_BANK_BALANCE",
                "severity": "medium",
                "title": f"Overdrawn / Negative Bank Balance ({b.get('bank_name') or 'Bank'})",
                "description": f"Current ledger balance is negative (₹{bal}). Verify bank statements or OD facility limit.",
                "action": "Reconcile unrecorded deposits or record OD interest."
            })

    # Rule 3: Missing GSTIN on B2B Invoices (> ₹2.5L)
    invoices = await db.invoices.find({"company_id": cid, "total_amount": {"$gt": 250000}}, {"_id": 0, "invoice_number": 1, "client_name": 1, "client_gstin": 1, "total_amount": 1}).to_list(20)
    for inv in invoices:
        if not (inv.get("client_gstin") or "").strip():
            anomalies.append({
                "type": "MISSING_GSTIN_HIGH_VALUE",
                "severity": "medium",
                "title": f"High Value Invoice without GSTIN (#{inv.get('invoice_number')})",
                "description": f"Invoice to {inv.get('client_name') or 'Customer'} for ₹{inv.get('total_amount')} has no GSTIN.",
                "action": "Add customer GSTIN before GSTR-1 filing."
            })

    # Rule 4: Overdue Receivables > 90 Days
    from datetime import date, timedelta
    ninety_days_ago = (date.today() - timedelta(days=90)).isoformat()
    stale_invs = await db.invoices.find({"company_id": cid, "amount_due": {"$gt": 0}, "due_date": {"$lt": ninety_days_ago}}, {"_id": 0, "invoice_number": 1, "client_name": 1, "amount_due": 1, "due_date": 1}).to_list(10)
    for si in stale_invs:
        anomalies.append({
            "type": "STALE_RECEIVABLE",
            "severity": "warning",
            "title": f"Stale Receivable > 90 Days (#{si.get('invoice_number')})",
            "description": f"{si.get('client_name') or 'Customer'} has ₹{si.get('amount_due')} overdue since {si.get('due_date')}.",
            "action": "Initiate automated payment reminder."
        })

    return {
        "company_id": cid,
        "count": len(anomalies),
        "clean": len(anomalies) == 0,
        "items": anomalies
    }


@router.get("/cashflow-forecast")
async def agent_cashflow_forecast(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)

    banks = await db.bank_accounts.find({"company_id": cid}, {"_id": 0, "current_balance": 1, "balance": 1}).to_list(100)
    current_cash = sum(_safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance")) for b in banks)

    invoices = await db.invoices.find({"company_id": cid, "amount_due": {"$gt": 0}}, {"_id": 0, "amount_due": 1, "due_date": 1}).to_list(1000)
    purchases = await db.purchase_invoices.find({"company_id": cid, "amount_due": {"$gt": 0}}, {"_id": 0, "amount_due": 1, "due_date": 1}).to_list(1000)

    from datetime import date, timedelta
    today = date.today()
    d30 = (today + timedelta(days=30)).isoformat()
    d60 = (today + timedelta(days=60)).isoformat()
    d90 = (today + timedelta(days=90)).isoformat()

    inflow_30 = sum(_safe_float(i.get("amount_due")) * 0.85 for i in invoices if _date_key(i.get("due_date")) <= d30)
    inflow_60 = inflow_30 + sum(_safe_float(i.get("amount_due")) * 0.75 for i in invoices if d30 < _date_key(i.get("due_date")) <= d60)
    inflow_90 = inflow_60 + sum(_safe_float(i.get("amount_due")) * 0.65 for i in invoices if d60 < _date_key(i.get("due_date")) <= d90)

    outflow_30 = sum(_safe_float(p.get("amount_due")) for p in purchases if _date_key(p.get("due_date")) <= d30)
    outflow_60 = outflow_30 + sum(_safe_float(p.get("amount_due")) for p in purchases if d30 < _date_key(p.get("due_date")) <= d60)
    outflow_90 = outflow_60 + sum(_safe_float(p.get("amount_due")) for p in purchases if d60 < _date_key(p.get("due_date")) <= d90)

    proj_30 = round(current_cash + inflow_30 - outflow_30, 2)
    proj_60 = round(current_cash + inflow_60 - outflow_60, 2)
    proj_90 = round(current_cash + inflow_90 - outflow_90, 2)

    monthly_burn = round(outflow_30, 2)
    runway_months = round(current_cash / monthly_burn, 1) if monthly_burn > 0 else 12.0

    chart = [
        {"period": "Today", "cash": round(current_cash, 2), "inflow": 0, "outflow": 0},
        {"period": "+30 Days", "cash": proj_30, "inflow": round(inflow_30, 2), "outflow": round(outflow_30, 2)},
        {"period": "+60 Days", "cash": proj_60, "inflow": round(inflow_60, 2), "outflow": round(outflow_60, 2)},
        {"period": "+90 Days", "cash": proj_90, "inflow": round(inflow_90, 2), "outflow": round(outflow_90, 2)},
    ]

    return {
        "company_id": cid,
        "current_cash": round(current_cash, 2),
        "runway_months": runway_months,
        "runway_status": "Comfortable" if runway_months >= 6 else ("Manageable" if runway_months >= 3 else "Tight"),
        "forecast_30d": proj_30,
        "forecast_60d": proj_60,
        "forecast_90d": proj_90,
        "chart": chart
    }
