"""
Accounting Extended — Taskosphere Accounting Module v2
======================================================
Adds the following endpoints on top of accounting_core.py:

  GET  /api/reports/day-book                  Day Book
  GET  /api/reports/cash-bank-book            Cash / Bank Book
  GET  /api/reports/cash-flow                 Cash Flow (indirect method)
  GET  /api/reports/journal-register          Journal Register
  GET  /api/reports/outstanding/receivable    Customer outstanding + aging
  GET  /api/reports/outstanding/payable       Vendor outstanding + aging
  GET  /api/reports/financial-ratios          Liquidity / Profitability / Solvency
  GET  /api/reports/comparative               Two-period P&L + Balance Sheet comparison
  GET  /api/reports/yearly                    Year-wise report summary

  GET  /api/opening-balances                  Get opening balances
  POST /api/opening-balances                  Set / update opening balances

  POST /api/bank-reconciliation/upload        Upload bank statement (CSV / Excel / PDF)
  GET  /api/bank-reconciliation/{bank_id}     Get reconciliation data for a bank account
  POST /api/bank-reconciliation/{bank_id}/match   Match a bank-statement row to a journal line
  POST /api/bank-reconciliation/{bank_id}/unmatch Un-match a row

  POST /api/depreciation/asset                Register a fixed asset
  GET  /api/depreciation/schedule             Depreciation schedule
  POST /api/depreciation/run                  Run depreciation for a period (background)

  GET  /api/tds-tcs                           TDS/TCS summary ledger
  POST /api/tds-tcs/entry                     Record TDS/TCS deduction

  GET  /api/audit-trail                       Accounting audit trail
  POST /api/bulk-import/journals              Bulk import journal entries (async background)
  GET  /api/bulk-import/status/{job_id}       Poll bulk import job status

Integration:
  1. In backend/server.py add two lines after the existing accounting imports:

       from backend.accounting_extended import router as accounting_ext_router
       from backend.accounting_extended import create_accounting_extended_indexes

  2. Register the router:

       api_router.include_router(accounting_ext_router)

  3. Call in the startup block alongside other create_*_indexes calls:

       await create_accounting_extended_indexes()

All existing accounting_core endpoints remain unchanged and fully compatible.
"""

import asyncio
import io
import csv
import uuid
import re
from datetime import datetime, date, timezone, timedelta
from typing import Optional, List, Dict, Any
from decimal import Decimal, ROUND_HALF_UP
from collections import defaultdict

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks, UploadFile, File, Form
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.accounting.models_extended import OpeningBalanceLine, OpeningBalanceRequest, MatchRequest, FixedAssetRequest, TDSTCSEntry, BulkJournalLine, BulkJournalEntry, BulkImportRequest, _run_bulk_import

from backend.models import User
from backend.accounting_core import get_default_account_id

# ── Try importing AI clients (optional — degrade gracefully if missing) ───
try:
    import groq as _groq_module
    _GROQ_API_KEY = __import__('os').environ.get('GROQ_API_KEY', '')
    _groq_client = _groq_module.Groq(api_key=_GROQ_API_KEY) if _GROQ_API_KEY else None
except Exception:
    _groq_client = None

try:
    import google.generativeai as genai
    _GEMINI_KEY = __import__('os').environ.get('GOOGLE_API_KEY', '')
    if _GEMINI_KEY:
        genai.configure(api_key=_GEMINI_KEY)
    _gemini_client = genai.GenerativeModel('gemini-1.5-flash') if _GEMINI_KEY else None
except Exception:
    _gemini_client = None

router = APIRouter(tags=["Accounting Extended"])


# ─────────────────────────────────────────────────────────────────────────────
# Permission helpers (mirror accounting_core pattern)
# ─────────────────────────────────────────────────────────────────────────────

def _perms(user: User) -> dict:
    p = user.permissions
    if isinstance(p, dict):
        return p
    return p.model_dump() if p else {}

def _can_reports(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_view_accounting_reports"))

def _can_post(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_post_journal_entries"))

def _can_manage(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_manage_chart_of_accounts"))


# ─────────────────────────────────────────────────────────────────────────────
# Formatting helpers
# ─────────────────────────────────────────────────────────────────────────────

def _round2(v: float) -> float:
    return float(Decimal(str(v)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

def _fy_dates(fy: Optional[str]) -> tuple:
    """Return (from_date_str, to_date_str) for a financial year string like '2024-25'."""
    if fy:
        try:
            start_yr = int(fy.split('-')[0])
            return f"{start_yr}-04-01", f"{start_yr + 1}-03-31"
        except Exception:
            pass
    today = date.today()
    if today.month >= 4:
        return f"{today.year}-04-01", f"{today.year + 1}-03-31"
    return f"{today.year - 1}-04-01", f"{today.year}-03-31"

def _date_bucket(entry_date: str, bucket: str) -> str:
    """Return bucket label (day/week/month) for grouping."""
    try:
        d = date.fromisoformat(entry_date)
        if bucket == "day":
            return d.strftime("%d %b %Y")
        if bucket == "month":
            return d.strftime("%b %Y")
        # week
        start = d - timedelta(days=d.weekday())
        return start.strftime("%d %b %Y") + " (week)"
    except Exception:
        return entry_date


# ─────────────────────────────────────────────────────────────────────────────
# DB index creation
# ─────────────────────────────────────────────────────────────────────────────

async def create_accounting_extended_indexes():
    """Create indexes for all collections used by this module. Safe to re-run."""
    try:
        await db.journal_lines.create_index([("company_id", 1), ("entry_date", 1), ("account_id", 1)])
        await db.journal_lines.create_index([("company_id", 1), ("source", 1), ("entry_date", 1)])
        await db.journal_entries.create_index([("company_id", 1), ("entry_date", 1)])
        await db.journal_entries.create_index([("idempotency_key", 1)], unique=True, sparse=True)
        await db.opening_balances.create_index([("company_id", 1), ("fy", 1), ("account_id", 1)], unique=True)
        await db.fixed_assets.create_index([("company_id", 1), ("asset_date", 1)])
        await db.depreciation_runs.create_index([("company_id", 1), ("fy", 1), ("period_end", 1)])
        await db.bank_reconciliation.create_index([("bank_account_id", 1), ("statement_date", 1)])
        await db.tds_tcs_entries.create_index([("company_id", 1), ("entry_date", 1)])
        await db.accounting_audit_trail.create_index([("company_id", 1), ("created_at", -1)])
        await db.bulk_import_jobs.create_index([("job_id", 1)], unique=True)
        # Speeds up the report-time reconciliation scan (sync_*_journal_entry
        # look-ups by source/source_id, and the invoices/payments collections
        # that get pulled per company on every Trial Balance / P&L / Balance
        # Sheet / Ledger view).
        await db.journal_entries.create_index([("source", 1), ("source_id", 1)])
        await db.invoices.create_index("company_id")
        await db.purchase_invoices.create_index("company_id")
        await db.payments.create_index("company_id")
        await db.purchase_payments.create_index("company_id")
        await db.purchase_payments.create_index("purchase_invoice_id")
        # journal_lines was only indexed by (company_id, entry_date, account_id)
        # / (company_id, source, entry_date). Every lookup of "all lines for
        # this journal entry" — Party Ledger, the individual party-ledger
        # sub-account view, and the Journal Entries list — filters by
        # entry_id alone (often via a large $in list), which had no
        # supporting index and fell back to a full collection scan. This was
        # one of the biggest contributors to slow Accounting Reports loads.
        await db.journal_lines.create_index("entry_id")
        # payments.find({"invoice_id": ...}) runs on every invoice save,
        # every status change, and every Party Ledger lookup — also had no
        # index of its own (only company_id).
        await db.payments.create_index("invoice_id")
        # Party Ledger resolves a party's invoices/bills by name — index the
        # lookup pattern actually used (company_id + name) instead of
        # scanning every invoice/bill in the book.
        await db.invoices.create_index([("company_id", 1), ("client_name", 1)])
        await db.purchase_invoices.create_index([("company_id", 1), ("supplier_name", 1)])
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"[accounting_extended] index creation warning: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Audit Trail helper
# ─────────────────────────────────────────────────────────────────────────────

async def _audit(company_id: str, user_id: str, action: str, entity: str, entity_id: str, payload: dict = None):
    await db.accounting_audit_trail.insert_one({
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "user_id": user_id,
        "action": action,
        "entity": entity,
        "entity_id": entity_id,
        "payload": payload or {},
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Day Book
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/day-book")
async def day_book(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    source: str = Query(None),   # sale / purchase / bank / manual / ai_zero_touch
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    q: dict = {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}
    if source:
        q["source"] = source

    entries = await db.journal_entries.find(q, {"_id": 0}).sort("entry_date", 1).to_list(50000)
    if not entries:
        return {"from_date": fd, "to_date": td, "days": [], "total_debit": 0, "total_credit": 0}

    entry_ids = [e["id"] for e in entries]
    lines = await db.journal_lines.find(
        {"entry_id": {"$in": entry_ids}}, {"_id": 0}
    ).to_list(200000)

    lines_by_entry: dict = defaultdict(list)
    for l in lines:
        lines_by_entry[l["entry_id"]].append(l)

    days: dict = {}
    for e in entries:
        day_key = e["entry_date"]
        if day_key not in days:
            days[day_key] = {"date": day_key, "entries": [], "day_debit": 0, "day_credit": 0}
        entry_lines = lines_by_entry.get(e["id"], [])
        total_dr = sum(l.get("debit", 0) for l in entry_lines)
        total_cr = sum(l.get("credit", 0) for l in entry_lines)
        days[day_key]["entries"].append({
            "id": e["id"],
            "narration": e.get("narration", ""),
            "source": e.get("source", "manual"),
            "ref_no": e.get("ref_no", ""),
            "total_debit": _round2(total_dr),
            "total_credit": _round2(total_cr),
            "lines": entry_lines,
        })
        days[day_key]["day_debit"] = _round2(days[day_key]["day_debit"] + total_dr)
        days[day_key]["day_credit"] = _round2(days[day_key]["day_credit"] + total_cr)

    sorted_days = sorted(days.values(), key=lambda d: d["date"])
    total_dr = _round2(sum(d["day_debit"] for d in sorted_days))
    total_cr = _round2(sum(d["day_credit"] for d in sorted_days))
    return {"from_date": fd, "to_date": td, "days": sorted_days, "total_debit": total_dr, "total_credit": total_cr}


# ─────────────────────────────────────────────────────────────────────────────
# Journal Register
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/journal-register")
async def journal_register(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    source: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    q: dict = {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}
    if source:
        q["source"] = source

    total = await db.journal_entries.count_documents(q)
    skip = (page - 1) * page_size
    entries = await db.journal_entries.find(q, {"_id": 0}).sort("entry_date", 1).skip(skip).limit(page_size).to_list(page_size)

    entry_ids = [e["id"] for e in entries]
    all_lines = await db.journal_lines.find({"entry_id": {"$in": entry_ids}}, {"_id": 0}).to_list(10000)
    lines_by_entry: dict = defaultdict(list)
    for l in all_lines:
        lines_by_entry[l["entry_id"]].append(l)

    rows = []
    for e in entries:
        lines = lines_by_entry.get(e["id"], [])
        rows.append({
            "id": e["id"],
            "entry_date": e["entry_date"],
            "narration": e.get("narration", ""),
            "source": e.get("source", "manual"),
            "ref_no": e.get("ref_no", ""),
            "total_debit": _round2(sum(l.get("debit", 0) for l in lines)),
            "total_credit": _round2(sum(l.get("credit", 0) for l in lines)),
            "lines": lines,
        })

    return {
        "from_date": fd, "to_date": td,
        "total": total, "page": page, "page_size": page_size,
        "entries": rows,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Cash / Bank Book
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/cash-bank-book")
async def cash_bank_book(
    company_id: str = Query(""),
    account_id: str = Query(None),   # specific account; if None returns summary of all cash/bank
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    # Find all cash/bank accounts for the company
    acct_q: dict = {"company_id": company_id, "sub_type": {"$in": ["current_asset"]}, "type": "asset"}
    if account_id:
        acct_q["id"] = account_id
    all_accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).to_list(200)

    # Filter to cash/bank by code/name heuristic if not specified
    if not account_id:
        all_accounts = [a for a in all_accounts if any(
            kw in (a.get("name", "") + a.get("code", "")).lower()
            for kw in ["cash", "bank", "1000", "1010"]
        )]

    if not all_accounts:
        return {"from_date": fd, "to_date": td, "accounts": []}

    acct_ids = [a["id"] for a in all_accounts]
    acct_map = {a["id"]: a for a in all_accounts}

    # Opening balance (lines before from_date)
    ob_lines = await db.journal_lines.find(
        {"company_id": company_id, "account_id": {"$in": acct_ids}, "entry_date": {"$lt": fd}},
        {"_id": 0}
    ).to_list(100000)
    ob_by_acct: dict = defaultdict(float)
    for l in ob_lines:
        ob_by_acct[l["account_id"]] += l.get("debit", 0) - l.get("credit", 0)

    # Period lines
    period_lines = await db.journal_lines.find(
        {"company_id": company_id, "account_id": {"$in": acct_ids},
         "entry_date": {"$gte": fd, "$lte": td}},
        {"_id": 0}
    ).sort("entry_date", 1).to_list(100000)

    # Fetch entry narrations
    entry_ids = list({l.get("entry_id") for l in period_lines if l.get("entry_id")})
    entries_map: dict = {}
    if entry_ids:
        ents = await db.journal_entries.find({"id": {"$in": entry_ids}}, {"_id": 0}).to_list(len(entry_ids))
        entries_map = {e["id"]: e for e in ents}

    # Build per-account ledger
    results = []
    for a in all_accounts:
        aid = a["id"]
        opening = _round2(ob_by_acct.get(aid, 0))
        running = opening
        rows = []
        acct_lines = [l for l in period_lines if l.get("account_id") == aid]
        for l in acct_lines:
            ent = entries_map.get(l.get("entry_id"), {})
            dr = l.get("debit", 0)
            cr = l.get("credit", 0)
            running = _round2(running + dr - cr)
            rows.append({
                "date": l["entry_date"],
                "narration": ent.get("narration", l.get("memo", "")),
                "source": ent.get("source", ""),
                "ref_no": ent.get("ref_no", ""),
                "debit": _round2(dr),
                "credit": _round2(cr),
                "balance": running,
            })
        closing = running
        results.append({
            "account_id": aid,
            "account_code": a.get("code", ""),
            "account_name": a.get("name", ""),
            "opening_balance": opening,
            "closing_balance": closing,
            "total_debit": _round2(sum(r["debit"] for r in rows)),
            "total_credit": _round2(sum(r["credit"] for r in rows)),
            "rows": rows,
        })

    return {"from_date": fd, "to_date": td, "accounts": results}


# ─────────────────────────────────────────────────────────────────────────────
# Cash Flow Statement (Indirect Method)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/cash-flow")
async def cash_flow(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    accounts = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}

    all_lines = await db.journal_lines.find(
        {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}, {"_id": 0}
    ).to_list(200000)

    # Balances by account
    balances: dict = defaultdict(float)
    for l in all_lines:
        balances[l["account_id"]] += l.get("debit", 0) - l.get("credit", 0)

    def net(acct_type: str, sub: str = None) -> float:
        total = 0.0
        for aid, amt in balances.items():
            a = acct_map.get(aid)
            if not a:
                continue
            if a["type"] == acct_type and (sub is None or a.get("sub_type") == sub):
                if acct_type in ("asset",):
                    total += amt
                else:
                    total -= amt  # liabilities/equity: credit normal
        return _round2(total)

    # Net profit for period (income - expense)
    income_net = 0.0
    expense_net = 0.0
    for aid, amt in balances.items():
        a = acct_map.get(aid)
        if not a:
            continue
        if a["type"] == "income":
            income_net += -amt  # income is credit normal
        elif a["type"] == "expense":
            expense_net += amt

    net_profit = _round2(income_net - expense_net)

    # Changes in working capital (current assets / liabilities excl cash/bank)
    wc_items = []
    for aid, amt in balances.items():
        a = acct_map.get(aid)
        if not a:
            continue
        if a["sub_type"] == "current_asset" and "cash" not in a.get("name", "").lower() and "bank" not in a.get("name", "").lower():
            wc_items.append({"name": a["name"], "change": _round2(-amt), "type": "current_asset"})
        elif a["sub_type"] == "current_liability":
            wc_items.append({"name": a["name"], "change": _round2(amt), "type": "current_liability"})

    wc_total = _round2(sum(w["change"] for w in wc_items))

    # Investing: fixed assets
    investing = []
    for aid, amt in balances.items():
        a = acct_map.get(aid)
        if a and a["sub_type"] == "fixed_asset":
            investing.append({"name": a["name"], "amount": _round2(-amt)})
    investing_total = _round2(sum(i["amount"] for i in investing))

    # Financing: equity + long-term debt changes
    financing = []
    for aid, amt in balances.items():
        a = acct_map.get(aid)
        if a and a["type"] in ("equity",):
            financing.append({"name": a["name"], "amount": _round2(amt)})
    financing_total = _round2(sum(f["amount"] for f in financing))

    operating_total = _round2(net_profit + wc_total)
    net_change = _round2(operating_total + investing_total + financing_total)

    return {
        "from_date": fd, "to_date": td,
        "operating": {
            "net_profit": net_profit,
            "working_capital_changes": wc_items,
            "total": operating_total,
        },
        "investing": {"items": investing, "total": investing_total},
        "financing": {"items": financing, "total": financing_total},
        "net_change_in_cash": net_change,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Outstanding Receivable / Payable  (aging buckets: current, 30, 60, 90, 90+)
# ─────────────────────────────────────────────────────────────────────────────

def _aging_bucket(due_date: str, as_of: str) -> str:
    try:
        d = date.fromisoformat(due_date)
        a = date.fromisoformat(as_of)
        days = (a - d).days
        if days <= 0:    return "current"
        if days <= 30:   return "1_30"
        if days <= 60:   return "31_60"
        if days <= 90:   return "61_90"
        return "91_plus"
    except Exception:
        return "current"


@router.get("/reports/outstanding/receivable")
async def outstanding_receivable(
    company_id: str = Query(""),
    as_of: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    as_of = as_of or date.today().isoformat()

    # Fetch unpaid / partially paid sale invoices (excluding cancelled ones)
    invoices = await db.invoices.find(
        {"company_id": company_id, "status": {"$nin": ["paid", "cancelled"]}},
        {"_id": 0}
    ).to_list(10000)

    rows = []
    buckets = {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "91_plus": 0.0}
    for inv in invoices:
        outstanding = _round2(
            float(inv.get("grand_total", 0)) - float(inv.get("amount_paid", 0))
        )
        if outstanding <= 0:
            continue
        due = inv.get("due_date") or inv.get("invoice_date") or as_of
        bucket = _aging_bucket(due, as_of)
        buckets[bucket] = _round2(buckets[bucket] + outstanding)
        rows.append({
            "invoice_no": inv.get("invoice_no", ""),
            "client_name": inv.get("client_name") or inv.get("customer_name", ""),
            "invoice_date": inv.get("invoice_date", ""),
            "due_date": due,
            "grand_total": _round2(float(inv.get("grand_total", 0))),
            "amount_paid": _round2(float(inv.get("amount_paid", 0))),
            "outstanding": outstanding,
            "bucket": bucket,
        })

    rows.sort(key=lambda r: r["due_date"])
    return {
        "as_of": as_of,
        "total_outstanding": _round2(sum(r["outstanding"] for r in rows)),
        "aging": buckets,
        "rows": rows,
    }


@router.get("/reports/outstanding/payable")
async def outstanding_payable(
    company_id: str = Query(""),
    as_of: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    as_of = as_of or date.today().isoformat()

    purchases = await db.purchase_invoices.find(
        {"company_id": company_id, "status": {"$nin": ["paid", "cancelled"]}},
        {"_id": 0}
    ).to_list(10000)

    rows = []
    buckets = {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "91_plus": 0.0}
    for inv in purchases:
        outstanding = _round2(
            float(inv.get("grand_total", 0)) - float(inv.get("amount_paid", 0))
        )
        if outstanding <= 0:
            continue
        due = inv.get("due_date") or inv.get("invoice_date") or as_of
        bucket = _aging_bucket(due, as_of)
        buckets[bucket] = _round2(buckets[bucket] + outstanding)
        rows.append({
            "invoice_no": inv.get("invoice_no", ""),
            "supplier_name": inv.get("supplier_name") or inv.get("client_name", ""),
            "invoice_date": inv.get("invoice_date", ""),
            "due_date": due,
            "grand_total": _round2(float(inv.get("grand_total", 0))),
            "amount_paid": _round2(float(inv.get("amount_paid", 0))),
            "outstanding": outstanding,
            "bucket": bucket,
        })

    rows.sort(key=lambda r: r["due_date"])
    return {
        "as_of": as_of,
        "total_outstanding": _round2(sum(r["outstanding"] for r in rows)),
        "aging": buckets,
        "rows": rows,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Financial Ratios
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/financial-ratios")
async def financial_ratios(
    company_id: str = Query(""),
    as_of: str = Query(None),
    fy: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    as_of = as_of or date.today().isoformat()
    fd, td = _fy_dates(fy)

    accounts = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}

    # All-time balances (balance sheet)
    bs_lines = await db.journal_lines.find(
        {"company_id": company_id, "entry_date": {"$lte": as_of}}, {"_id": 0}
    ).to_list(200000)
    bs_bal: dict = defaultdict(float)
    for l in bs_lines:
        bs_bal[l["account_id"]] += l.get("debit", 0) - l.get("credit", 0)

    # Period lines (P&L)
    pl_lines = await db.journal_lines.find(
        {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": as_of}}, {"_id": 0}
    ).to_list(200000)
    pl_bal: dict = defaultdict(float)
    for l in pl_lines:
        pl_bal[l["account_id"]] += l.get("debit", 0) - l.get("credit", 0)

    def bal(aid: str, lines_map: dict = bs_bal) -> float:
        return lines_map.get(aid, 0.0)

    def sum_type(typ: str, sub: str = None, lines_map: dict = bs_bal) -> float:
        total = 0.0
        for aid, amt in lines_map.items():
            a = acct_map.get(aid)
            if a and a["type"] == typ and (sub is None or a.get("sub_type") == sub):
                total += amt if typ == "asset" else -amt
        return _round2(total)

    current_assets = sum_type("asset", "current_asset")
    fixed_assets   = sum_type("asset", "fixed_asset")
    total_assets   = _round2(current_assets + fixed_assets)
    current_liab   = sum_type("liability", "current_liability")
    long_term_liab = sum_type("liability", "long_term_liability")
    total_liab     = _round2(current_liab + long_term_liab)
    total_equity   = sum_type("equity")
    revenue        = _round2(sum(-v for aid, v in pl_bal.items() if acct_map.get(aid, {}).get("type") == "income"))
    expenses       = _round2(sum(v for aid, v in pl_bal.items() if acct_map.get(aid, {}).get("type") == "expense"))
    net_profit     = _round2(revenue - expenses)

    # Cash & equivalents
    cash = _round2(sum(
        v for aid, v in bs_bal.items()
        if any(kw in acct_map.get(aid, {}).get("name", "").lower() for kw in ["cash", "bank"])
        and acct_map.get(aid, {}).get("type") == "asset"
    ))

    def safe_div(n, d):
        return _round2(n / d) if d else None

    return {
        "as_of": as_of, "fy": fy,
        "liquidity": {
            "current_ratio":  safe_div(current_assets, current_liab),
            "quick_ratio":    safe_div(current_assets - cash, current_liab),
            "cash_ratio":     safe_div(cash, current_liab),
        },
        "profitability": {
            "gross_profit_margin":  safe_div(net_profit, revenue) if revenue else None,
            "net_profit_margin":    safe_div(net_profit, revenue) if revenue else None,
            "return_on_assets":     safe_div(net_profit, total_assets) if total_assets else None,
            "return_on_equity":     safe_div(net_profit, total_equity) if total_equity else None,
        },
        "solvency": {
            "debt_to_equity":   safe_div(total_liab, total_equity),
            "debt_to_assets":   safe_div(total_liab, total_assets),
            "equity_ratio":     safe_div(total_equity, total_assets),
        },
        "working_capital":  _round2(current_assets - current_liab),
        "revenue":          revenue,
        "net_profit":       net_profit,
        "total_assets":     total_assets,
        "total_equity":     total_equity,
        "total_liabilities": total_liab,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Comparative Report (two periods side by side)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/comparative")
async def comparative(
    company_id: str = Query(""),
    fy1: str = Query(None),   # e.g. 2023-24
    fy2: str = Query(None),   # e.g. 2024-25
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")

    today = date.today()
    if not fy2:
        if today.month >= 4:
            fy2 = f"{today.year}-{str(today.year + 1)[2:]}"
        else:
            fy2 = f"{today.year - 1}-{str(today.year)[2:]}"
    if not fy1:
        yr = int(fy2.split('-')[0]) - 1
        fy1 = f"{yr}-{str(yr + 1)[2:]}"

    fd1, td1 = _fy_dates(fy1)
    fd2, td2 = _fy_dates(fy2)

    accounts = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}

    async def period_pnl(fd, td):
        lines = await db.journal_lines.find(
            {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}, {"_id": 0}
        ).to_list(200000)
        income_rows, expense_rows = {}, {}
        for l in lines:
            a = acct_map.get(l["account_id"])
            if not a:
                continue
            if a["type"] == "income":
                r = income_rows.setdefault(a["id"], {"code": a["code"], "name": a["name"], "amount": 0.0})
                r["amount"] += l.get("credit", 0) - l.get("debit", 0)
            elif a["type"] == "expense":
                r = expense_rows.setdefault(a["id"], {"code": a["code"], "name": a["name"], "amount": 0.0})
                r["amount"] += l.get("debit", 0) - l.get("credit", 0)
        ti = _round2(sum(r["amount"] for r in income_rows.values()))
        te = _round2(sum(r["amount"] for r in expense_rows.values()))
        return {"income": list(income_rows.values()), "expenses": list(expense_rows.values()),
                "total_income": ti, "total_expense": te, "net_profit": _round2(ti - te)}

    p1, p2 = await asyncio.gather(period_pnl(fd1, td1), period_pnl(fd2, td2))

    # Build combined income/expense comparison
    def merge(rows1, rows2):
        keys = {r["code"]: r["name"] for r in rows1 + rows2}
        r1m = {r["code"]: r["amount"] for r in rows1}
        r2m = {r["code"]: r["amount"] for r in rows2}
        out = []
        for code, name in sorted(keys.items()):
            a1 = _round2(r1m.get(code, 0))
            a2 = _round2(r2m.get(code, 0))
            chg = _round2(a2 - a1)
            pct = _round2((chg / a1 * 100) if a1 else 0)
            out.append({"code": code, "name": name, "fy1": a1, "fy2": a2, "change": chg, "change_pct": pct})
        return out

    return {
        "fy1": fy1, "fy2": fy2,
        "income": merge(p1["income"], p2["income"]),
        "expenses": merge(p1["expenses"], p2["expenses"]),
        "summary": {
            "fy1": {"total_income": p1["total_income"], "total_expense": p1["total_expense"], "net_profit": p1["net_profit"]},
            "fy2": {"total_income": p2["total_income"], "total_expense": p2["total_expense"], "net_profit": p2["net_profit"]},
            "change": {
                "total_income": _round2(p2["total_income"] - p1["total_income"]),
                "total_expense": _round2(p2["total_expense"] - p1["total_expense"]),
                "net_profit": _round2(p2["net_profit"] - p1["net_profit"]),
            },
        },
    }



# ─────────────────────────────────────────────────────────────────────────────
# Year-wise Summary
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reports/yearly")
async def yearly_summary(
    company_id: str = Query(""),
    years: int = Query(5, le=10),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")

    today = date.today()
    cur_start_year = today.year if today.month >= 4 else today.year - 1
    periods = []
    for i in range(years):
        yr = cur_start_year - i
        fy_str = f"{yr}-{str(yr + 1)[2:]}"
        periods.append((fy_str, f"{yr}-04-01", f"{yr + 1}-03-31"))

    accounts = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}

    results = []
    for fy_str, fd, td in periods:
        lines = await db.journal_lines.find(
            {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}, {"_id": 0}
        ).to_list(200000)
        income = expense = 0.0
        for l in lines:
            a = acct_map.get(l["account_id"])
            if not a:
                continue
            if a["type"] == "income":
                income += l.get("credit", 0) - l.get("debit", 0)
            elif a["type"] == "expense":
                expense += l.get("debit", 0) - l.get("credit", 0)
        results.append({
            "fy": fy_str,
            "total_income": _round2(income),
            "total_expense": _round2(expense),
            "net_profit": _round2(income - expense),
            "from_date": fd,
            "to_date": td,
        })

    return {"years": list(reversed(results))}


# ─────────────────────────────────────────────────────────────────────────────
# Opening Balances
# ─────────────────────────────────────────────────────────────────────────────



@router.get("/opening-balances")
async def get_opening_balances(
    company_id: str = Query(""),
    fy: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"company_id": company_id}
    if fy:
        q["fy"] = fy
    rows = await db.opening_balances.find(q, {"_id": 0}).to_list(2000)

    # Enrich with account names
    acct_ids = list({r["account_id"] for r in rows})
    accounts = await db.chart_of_accounts.find({"id": {"$in": acct_ids}}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}
    for r in rows:
        a = acct_map.get(r["account_id"], {})
        r["account_code"] = a.get("code", "")
        r["account_name"] = a.get("name", "")
    return {"opening_balances": rows}


@router.post("/opening-balances")
async def set_opening_balances(
    req: OpeningBalanceRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    total_dr = _round2(sum(l.debit for l in req.lines))
    total_cr = _round2(sum(l.credit for l in req.lines))
    if abs(total_dr - total_cr) > 0.05:
        raise HTTPException(400, f"Opening balances must be balanced. Debit {total_dr} ≠ Credit {total_cr}")

    saved = []
    for line in req.lines:
        if line.debit == 0 and line.credit == 0:
            continue
        doc = {
            "id": str(uuid.uuid4()),
            "company_id": req.company_id,
            "fy": req.fy,
            "account_id": line.account_id,
            "debit": _round2(line.debit),
            "credit": _round2(line.credit),
            "date": req.date,
            "created_by": str(current_user.id),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.opening_balances.update_one(
            {"company_id": req.company_id, "fy": req.fy, "account_id": line.account_id},
            {"$set": doc},
            upsert=True,
        )
        saved.append(doc)

    # Post as a journal entry (source=opening_balance, idempotent per fy)
    ik = f"ob_{req.company_id}_{req.fy}"
    existing = await db.journal_entries.find_one({"idempotency_key": ik})
    if not existing:
        entry_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        await db.journal_entries.insert_one({
            "id": entry_id, "company_id": req.company_id, "fy": req.fy,
            "entry_date": req.date, "narration": f"Opening balances for FY {req.fy}",
            "source": "opening_balance", "idempotency_key": ik,
            "posted_by": str(current_user.id), "created_at": now_iso,
        })
        for line in req.lines:
            if line.debit == 0 and line.credit == 0:
                continue
            await db.journal_lines.insert_one({
                "id": str(uuid.uuid4()), "entry_id": entry_id,
                "company_id": req.company_id, "account_id": line.account_id,
                "debit": _round2(line.debit), "credit": _round2(line.credit),
                "entry_date": req.date, "memo": f"OB {req.fy}",
                "created_at": now_iso,
            })

    await _audit(req.company_id, str(current_user.id), "set_opening_balances", "opening_balances", req.fy, {"fy": req.fy, "lines": len(saved)})
    return {"saved": len(saved), "fy": req.fy}


# ─────────────────────────────────────────────────────────────────────────────
# Bank Reconciliation
# ─────────────────────────────────────────────────────────────────────────────

def _sniff_delimited_table(file_bytes: bytes) -> Optional["pd.DataFrame"]:
    """Many Indian bank exports (SBI, HDFC, ICICI...) label a plain tab- or
    comma-delimited text file with a `.xls` extension, and prefix the real
    transaction table with a dozen+ lines of account-info banner. This
    can't be read by pd.read_excel (it isn't a real Excel file), so we
    decode it as text, find the header row by looking for the line that
    contains both a date-like column and an amount-like column, and parse
    from there.
    """
    for encoding in ('utf-8', 'utf-8-sig', 'latin-1'):
        try:
            text = file_bytes.decode(encoding)
            break
        except Exception:
            text = None
    if text is None:
        return None

    lines = text.splitlines()
    header_idx = None
    delimiter = None
    for i, line in enumerate(lines):
        low = line.lower()
        has_date = any(k in low for k in ('date', 'txn date', 'value date'))
        has_amount = any(k in low for k in ('debit', 'credit', 'withdrawal', 'deposit'))
        if has_date and has_amount:
            header_idx = i
            delimiter = '\t' if line.count('\t') >= line.count(',') else ','
            break
    if header_idx is None:
        return None

    try:
        return pd.read_csv(
            io.StringIO(text), sep=delimiter, skiprows=header_idx,
            dtype=str, engine='python', on_bad_lines='skip',
        )
    except Exception:
        return None


def _parse_bank_statement(file_bytes: bytes, filename: str) -> List[dict]:
    """Parse CSV / Excel bank statement into list of {date, narration, debit, credit, balance}."""
    fname = filename.lower()
    rows = []

    try:
        if fname.endswith(('.xlsx', '.xls')):
            try:
                df = pd.read_excel(io.BytesIO(file_bytes), dtype=str)
            except Exception:
                # Not a real Excel file — likely a delimited text export
                # mislabeled with an .xls extension. Fall back to sniffing.
                df = _sniff_delimited_table(file_bytes)
                if df is None:
                    return []
        elif fname.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding='utf-8', on_bad_lines='skip')
        elif fname.endswith('.pdf'):
            # For PDF, attempt text extraction and basic CSV parsing
            try:
                import pdfplumber
                text_rows = []
                with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                    for page in pdf.pages:
                        for row in (page.extract_table() or []):
                            if row:
                                text_rows.append([str(c or '').strip() for c in row])
                if len(text_rows) > 1:
                    df = pd.DataFrame(text_rows[1:], columns=text_rows[0])
                else:
                    return []
            except Exception:
                return []
        else:
            # Try CSV as fallback
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding='utf-8', on_bad_lines='skip')

        df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]

        # Map common column name variants. Short abbreviations ('cr', 'dr')
        # must match a whole underscore-delimited token, not just appear as
        # a substring — otherwise e.g. "description" (which contains "cr")
        # gets mistaken for the credit column and every credit amount
        # silently parses as 0.
        def _col_matches(col: str, keywords: List[str]) -> bool:
            tokens = col.split('_')
            for k in keywords:
                if len(k.rstrip('.')) <= 3:
                    if k.rstrip('.') in tokens:
                        return True
                elif k in col:
                    return True
            return False

        col_map = {}
        for col in df.columns:
            if _col_matches(col, ['date', 'txn_date', 'value_date', 'posting']):
                col_map.setdefault('date', col)
            if _col_matches(col, ['narration', 'description', 'particulars', 'remarks', 'details']):
                col_map.setdefault('narration', col)
            if _col_matches(col, ['debit', 'withdrawal', 'dr', 'dr.']):
                col_map.setdefault('debit', col)
            if _col_matches(col, ['credit', 'deposit', 'cr', 'cr.']):
                col_map.setdefault('credit', col)
            if _col_matches(col, ['balance', 'closing', 'running']):
                col_map.setdefault('balance', col)

        for _, row in df.iterrows():
            raw_date = str(row.get(col_map.get('date', ''), '')).strip()
            if not raw_date or raw_date.lower() in ('nan', 'none', ''):
                continue
            # Parse date flexibly
            parsed_date = None
            for fmt in ('%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d', '%d %b %Y', '%d-%b-%Y', '%m/%d/%Y'):
                try:
                    parsed_date = datetime.strptime(raw_date, fmt).strftime('%Y-%m-%d')
                    break
                except Exception:
                    pass
            if not parsed_date:
                continue

            def _num(v):
                try:
                    s = str(v).replace(',', '').replace('(', '-').replace(')', '').strip()
                    return float(s) if s and s not in ('nan', 'none', '') else 0.0
                except Exception:
                    return 0.0

            rows.append({
                "id": str(uuid.uuid4()),
                "statement_date": parsed_date,
                "narration": str(row.get(col_map.get('narration', ''), '')).strip()[:500],
                "debit":   _num(row.get(col_map.get('debit', ''), 0)),
                "credit":  _num(row.get(col_map.get('credit', ''), 0)),
                "balance": _num(row.get(col_map.get('balance', ''), 0)),
                "matched": False,
                "matched_entry_id": None,
            })
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"[bank_recon] parse error: {e}")

    return rows


@router.post("/bank-reconciliation/upload")
async def upload_bank_statement(
    bank_account_id: str = Form(...),
    company_id: str = Form(""),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    contents = await file.read()
    rows = _parse_bank_statement(contents, file.filename or "statement.csv")
    if not rows:
        raise HTTPException(400, "Could not parse bank statement. Ensure it is CSV or Excel with date/narration/debit/credit columns.")

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "bank_account_id": bank_account_id,
        "company_id": company_id,
        "filename": file.filename,
        "uploaded_by": str(current_user.id),
        "uploaded_at": now_iso,
        "rows": rows,
        "total_rows": len(rows),
        "matched_rows": 0,
    }
    await db.bank_reconciliation.insert_one({"_id": doc["id"], **doc})
    await _audit(company_id, str(current_user.id), "upload_bank_statement", "bank_reconciliation", doc["id"], {"filename": file.filename, "rows": len(rows)})
    return {"statement_id": doc["id"], "total_rows": len(rows), "filename": file.filename}


@router.get("/bank-reconciliation/{bank_account_id}")
async def get_reconciliation(
    bank_account_id: str,
    company_id: str = Query(""),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")

    statements = await db.bank_reconciliation.find(
        {"bank_account_id": bank_account_id},
        {"_id": 0}
    ).sort("uploaded_at", -1).to_list(20)

    # Also fetch journal lines for cash/bank accounts for auto-suggestion
    # Find cash/bank account linked to this bank account
    bank_acct = await db.bank_accounts.find_one({"id": bank_account_id}, {"_id": 0})
    ledger_account_id = bank_acct.get("ledger_account_id") if bank_acct else None

    unmatched_journal = []
    if ledger_account_id:
        # Recent unmatched journal lines for this bank account
        uj = await db.journal_lines.find(
            {"company_id": company_id, "account_id": ledger_account_id, "reconciled": {"$ne": True}},
            {"_id": 0}
        ).sort("entry_date", -1).limit(500).to_list(500)
        unmatched_journal = uj

    return {
        "bank_account_id": bank_account_id,
        "statements": statements,
        "unmatched_journal_lines": unmatched_journal,
    }



@router.post("/bank-reconciliation/{bank_account_id}/match")
async def match_reconciliation(
    bank_account_id: str,
    req: MatchRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    # Mark row as matched in statement
    await db.bank_reconciliation.update_one(
        {"id": req.statement_id, "rows.id": req.row_id},
        {"$set": {"rows.$.matched": True, "rows.$.matched_entry_id": req.entry_id}},
    )
    # Optionally mark journal line as reconciled
    if req.line_id:
        await db.journal_lines.update_one(
            {"id": req.line_id},
            {"$set": {"reconciled": True, "reconciled_statement_id": req.statement_id}},
        )
    await _audit("", str(current_user.id), "match_reconciliation", "bank_reconciliation", req.statement_id, {"row_id": req.row_id})
    return {"matched": True}


@router.post("/bank-reconciliation/{bank_account_id}/unmatch")
async def unmatch_reconciliation(
    bank_account_id: str,
    req: MatchRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    await db.bank_reconciliation.update_one(
        {"id": req.statement_id, "rows.id": req.row_id},
        {"$set": {"rows.$.matched": False, "rows.$.matched_entry_id": None}},
    )
    if req.line_id:
        await db.journal_lines.update_one(
            {"id": req.line_id},
            {"$set": {"reconciled": False, "reconciled_statement_id": None}},
        )
    return {"unmatched": True}


# ─────────────────────────────────────────────────────────────────────────────
# Depreciation
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/depreciation/asset")
async def add_fixed_asset(
    req: FixedAssetRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": req.company_id,
        "name": req.name,
        "purchase_date": req.purchase_date,
        "cost": _round2(req.cost),
        "salvage_value": _round2(req.salvage_value),
        "useful_life_years": req.useful_life_years,
        "method": req.method,
        "asset_account_id": req.asset_account_id,
        "depreciation_account_id": req.depreciation_account_id,
        "accumulated_depreciation": 0.0,
        "book_value": _round2(req.cost),
        "status": "active",
        "created_by": str(current_user.id),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.fixed_assets.insert_one({"_id": doc["id"], **doc})
    await _audit(req.company_id, str(current_user.id), "add_fixed_asset", "fixed_assets", doc["id"], {"name": req.name, "cost": req.cost})
    return doc


@router.get("/depreciation/schedule")
async def depreciation_schedule(
    company_id: str = Query(""),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    assets = await db.fixed_assets.find({"company_id": company_id}, {"_id": 0}).to_list(500)
    result = []
    for asset in assets:
        cost = float(asset.get("cost", 0))
        salvage = float(asset.get("salvage_value", 0))
        life = int(asset.get("useful_life_years", 5))
        method = asset.get("method", "straight_line")
        dep_base = cost - salvage
        annual_dep = 0.0
        if method == "straight_line" and life > 0:
            annual_dep = _round2(dep_base / life)
        elif method in ("declining_balance", "wdv") and life > 0:
            rate = 1 - (salvage / cost) ** (1 / life) if cost > 0 else 0
            annual_dep = _round2(float(asset.get("book_value", cost)) * rate)

        schedule_rows = []
        bv = cost
        for yr in range(1, life + 1):
            if method == "straight_line":
                dep = min(annual_dep, bv - salvage)
            else:
                dep = _round2(bv * (1 - (salvage / cost) ** (1 / life)) if cost > 0 else 0)
                dep = min(dep, bv - salvage)
            dep = max(dep, 0)
            bv = _round2(bv - dep)
            schedule_rows.append({"year": yr, "depreciation": dep, "closing_book_value": bv})

        result.append({
            "id": asset.get("id"),
            "name": asset.get("name"),
            "purchase_date": asset.get("purchase_date"),
            "cost": cost,
            "salvage_value": salvage,
            "useful_life_years": life,
            "method": method,
            "accumulated_depreciation": float(asset.get("accumulated_depreciation", 0)),
            "book_value": float(asset.get("book_value", cost)),
            "status": asset.get("status", "active"),
            "schedule": schedule_rows,
        })
    return {"assets": result}


@router.post("/depreciation/run")
async def run_depreciation(
    company_id: str = Form(""),
    period_end: str = Form(...),   # YYYY-MM-DD
    fy: str = Form(None),
    current_user: User = Depends(get_current_user),
):
    """Run depreciation for all active fixed assets up to period_end. Posts journal entries."""
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")
    assets = await db.fixed_assets.find({"company_id": company_id, "status": "active"}, {"_id": 0}).to_list(500)
    posted = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for asset in assets:
        # Calculate depreciation for this period (monthly pro-rated)
        try:
            purchase = date.fromisoformat(asset["purchase_date"])
            period = date.fromisoformat(period_end)
            months_elapsed = (period.year - purchase.year) * 12 + (period.month - purchase.month)
            life_months = int(asset.get("useful_life_years", 5)) * 12
            if months_elapsed <= 0 or months_elapsed > life_months:
                continue
        except Exception:
            continue

        dep_base = float(asset["cost"]) - float(asset.get("salvage_value", 0))
        monthly_dep = _round2(dep_base / (int(asset.get("useful_life_years", 5)) * 12))
        if monthly_dep <= 0:
            continue

        # Idempotent: skip if already run for this period
        ik = f"dep_{asset['id']}_{period_end}"
        existing = await db.journal_entries.find_one({"idempotency_key": ik})
        if existing:
            continue

        entry_id = str(uuid.uuid4())
        await db.journal_entries.insert_one({
            "id": entry_id, "company_id": company_id,
            "entry_date": period_end, "fy": fy,
            "narration": f"Depreciation — {asset['name']} for {period_end[:7]}",
            "source": "depreciation", "idempotency_key": ik,
            "posted_by": str(current_user.id), "created_at": now_iso,
        })
        # asset.depreciation_account_id / asset_account_id are expected to
        # already be real chart_of_accounts ids when explicitly set on the
        # asset; the fallback must resolve the default code ("5500" / "1300")
        # to its real id the same way — posting the literal code string as
        # account_id makes the entry invisible to Trial Balance/Balance
        # Sheet/P&L, since reports join on chart_of_accounts.id, not code.
        dep_acct = asset.get("depreciation_account_id") or await get_default_account_id(company_id, "5500")
        asset_acct = asset.get("asset_account_id") or await get_default_account_id(company_id, "1300")
        if not dep_acct or not asset_acct:
            continue
        for line_acct, dr, cr in [(dep_acct, monthly_dep, 0), (asset_acct, 0, monthly_dep)]:
            await db.journal_lines.insert_one({
                "id": str(uuid.uuid4()), "entry_id": entry_id, "company_id": company_id,
                "account_id": line_acct, "debit": dr, "credit": cr,
                "entry_date": period_end, "memo": f"Dep {asset['name']}",
                "created_at": now_iso,
            })

        # Update asset book value
        new_bv = _round2(float(asset.get("book_value", asset["cost"])) - monthly_dep)
        new_accum = _round2(float(asset.get("accumulated_depreciation", 0)) + monthly_dep)
        await db.fixed_assets.update_one(
            {"id": asset["id"]},
            {"$set": {"book_value": new_bv, "accumulated_depreciation": new_accum}},
        )
        posted.append({"asset": asset["name"], "depreciation": monthly_dep, "entry_id": entry_id})

    await _audit(company_id, str(current_user.id), "run_depreciation", "depreciation", period_end, {"posted": len(posted)})
    return {"period_end": period_end, "posted": len(posted), "entries": posted}


# ─────────────────────────────────────────────────────────────────────────────
# TDS / TCS
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/tds-tcs/entry")
async def record_tds_tcs(
    req: TDSTCSEntry,
    current_user: User = Depends(get_current_user),
):
    if not _can_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = {
        "id": str(uuid.uuid4()),
        **req.model_dump(),
        "tds_amount": _round2(req.tds_amount),
        "base_amount": _round2(req.base_amount),
        "created_by": str(current_user.id),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.tds_tcs_entries.insert_one({"_id": doc["id"], **doc})

    # Post journal entry: Dr. Party A/c, Cr. TDS Payable
    entry_id = str(uuid.uuid4())
    now_iso = doc["created_at"]
    await db.journal_entries.insert_one({
        "id": entry_id, "company_id": req.company_id,
        "entry_date": req.entry_date,
        "narration": f"{'TDS' if req.payment_type == 'tds' else 'TCS'} u/s {req.section} on {req.party_name} — ₹{req.tds_amount:,.2f}",
        "source": "tds_tcs", "posted_by": str(current_user.id), "created_at": now_iso,
    })
    # TDS Payable account = "2200", Accounts Payable = "2000". Resolve to the
    # real chart_of_accounts id (not the literal code) — journal_lines.account_id
    # must match chart_of_accounts.id or these lines silently vanish from
    # Trial Balance / Balance Sheet / P&L, since every report looks entries up
    # by real account id, never by code.
    tds_payable_id = await get_default_account_id(req.company_id, "2200")
    payable_id = await get_default_account_id(req.company_id, "2000")
    for acct, dr, cr in [(tds_payable_id, 0, req.tds_amount), (payable_id, req.tds_amount, 0)]:
        if not acct:
            continue
        await db.journal_lines.insert_one({
            "id": str(uuid.uuid4()), "entry_id": entry_id,
            "company_id": req.company_id, "account_id": acct,
            "debit": _round2(dr), "credit": _round2(cr),
            "entry_date": req.entry_date, "memo": f"{req.section} {req.party_name}",
            "created_at": now_iso,
        })

    return {"id": doc["id"], "entry_id": entry_id}


@router.get("/tds-tcs")
async def get_tds_tcs(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    payment_type: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    q: dict = {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}
    if payment_type:
        q["payment_type"] = payment_type

    entries = await db.tds_tcs_entries.find(q, {"_id": 0}).sort("entry_date", 1).to_list(5000)

    tds_total = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("payment_type") == "tds"))
    tcs_total = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("payment_type") == "tcs"))
    deposited = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("status") == "deposited"))
    pending   = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("status") == "deducted"))

    return {
        "from_date": fd, "to_date": td,
        "summary": {"tds_total": tds_total, "tcs_total": tcs_total, "deposited": deposited, "pending_deposit": pending},
        "entries": entries,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Audit Trail
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/audit-trail")
async def audit_trail(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    entity: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"company_id": company_id}
    if from_date:
        q.setdefault("created_at", {})["$gte"] = from_date
    if to_date:
        q.setdefault("created_at", {})["$lte"] = to_date + "T23:59:59"
    if entity:
        q["entity"] = entity

    total = await db.accounting_audit_trail.count_documents(q)
    skip = (page - 1) * page_size
    rows = await db.accounting_audit_trail.find(q, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    return {"total": total, "page": page, "page_size": page_size, "rows": rows}


# ─────────────────────────────────────────────────────────────────────────────
# Bulk Import — async background processing
# ─────────────────────────────────────────────────────────────────────────────




@router.post("/bulk-import/journals")
async def bulk_import_journals(
    req: BulkImportRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    if not _can_post(current_user):
        raise HTTPException(403, "Access denied.")
    if len(req.entries) > 100000:
        raise HTTPException(400, "Max 100,000 entries per import job.")

    job_id = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.bulk_import_jobs.insert_one({
        "job_id": job_id, "company_id": req.company_id, "fy": req.fy,
        "total": len(req.entries), "done": 0, "skipped": 0, "errors": 0,
        "status": "running", "started_by": str(current_user.id),
        "started_at": now_iso, "finished_at": None,
    })

    background_tasks.add_task(
        _run_bulk_import,
        job_id,
        req.company_id,
        req.fy,
        [e.model_dump() for e in req.entries],
        str(current_user.id),
    )
    return {"job_id": job_id, "total": len(req.entries), "status": "running"}


@router.get("/bulk-import/status/{job_id}")
async def bulk_import_status(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    if not _can_post(current_user):
        raise HTTPException(403, "Access denied.")
    job = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    if not job:
        raise HTTPException(404, "Job not found.")
    return job
