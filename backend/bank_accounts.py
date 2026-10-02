"""
Bank Accounts — "Accounts › Bank" page.

Upload a bank statement (any bank, CSV/XLSX/PDF export) for any of the
firm's bank accounts. The app reads the transaction rows, auto-matches each
one against existing Purchase invoices (money out) and Sale invoices (money
in) by amount + date proximity, and — once matched — posts the
corresponding Journal Entry automatically so the transaction shows up in
the ledger and every report without manual re-entry.

Design note (cash-basis auto-posting): a matched transaction posts a single
journal entry — Dr Purchases / Cr Bank for a payment, or Dr Bank / Cr Sales
Income for a receipt — rather than a two-step accrual (invoice booked, then
payment against Accounts Payable/Receivable separately). That keeps
auto-posting simple and matches how most small firms actually work day to
day; the Accounts Payable/Receivable accounts are still in the Chart of
Accounts for anyone who wants to post accrual entries by hand through
Journal Entries.

A line with no confident match is auto-parked to the Suspense Account
(9998) rather than left fully unposted — the same posting the "Park to
Suspense" button already makes for a manual match. Every bank statement
line must land in the ledger at import time, matched or not: leaving a
line completely unposted means the real cash movement happened in the
bank but never in the books, so the GL Bank Accounts balance silently
drifts away from the real bank balance (and, for an unmatched receipt,
Accounts Receivable stays overstated because nothing told the ledger the
money arrived) — with no error anywhere to surface it. Suspense keeps the
bank side always correct; the unclassified side sits visibly in the
Suspense Review workflow until it's reclassified to its real head.
"""

import re
import math
import uuid
import base64
from io import BytesIO
from datetime import datetime, date, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.banking.models_banking import BankAccountCreate, ManualMatchInput, UnmatchInput, AIAutoMatchInput, IgnoreInput, BankRulePayload, ManualReconcilePayload, BackfillSuspenseInput, _mask_account_number, auto_match_similar_transactions, _log_recon_audit

from backend.models import User
from backend.accounting_core import get_default_account_id, try_auto_post

router = APIRouter(tags=["Bank Accounts"])

MAX_FILE_BYTES = 15 * 1024 * 1024  # 15 MB — statements can run to many pages


def _is_admin_role(user: User) -> bool:
    """Handle both string and UserRole enum representations of the admin role."""
    role = getattr(user, "role", "")
    value = getattr(role, "value", None)
    name = getattr(role, "name", None)
    for candidate in (value, name, role):
        normalized = str(candidate or "").strip().lower()
        if normalized == "admin" or normalized.endswith(".admin"):
            return True
    return False


def _perm_view_bank(user: User) -> bool:
    if _is_admin_role(user):
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_view_bank"))


def _perm_use_bank_picker(user: User) -> bool:
    """Allow the Master Data bank-account picker without granting Bank-page access.

    The picker is embedded in Admin → Master Data → Company Profile. It only
    reads bank-account metadata so a master-data operator can link a company
    to an existing bank account. Full Bank Accounts page access remains
    protected by _perm_view_bank().
    """
    if _is_admin_role(user):
        return True
    perms = (
        user.permissions
        if isinstance(user.permissions, dict)
        else (user.permissions.model_dump() if user.permissions else {})
    )
    return bool(
        perms.get("can_view_bank")
        or perms.get("can_view_master_data")
    )


def _perm_match_bank(user: User) -> bool:
    """Gate for actions that change reconciliation state (Match / Edit Match /
    Unmatch / Ignore) — distinct from _perm_view_bank, which only gates read
    access to the page. Admin: always allowed. Manager: allowed by default
    (can_match_bank defaults True in DEFAULT_ROLE_PERMISSIONS). Staff: view
    only unless an admin grants can_match_bank via Permission Governance."""
    if _is_admin_role(user):
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_match_bank"))


# ── Models ────────────────────────────────────────────────────────────────

# ── Cross-place sync helpers ────────────────────────────────────────────────
# Bank details are entered in three places: this Bank Accounts page, Invoice
# Settings and Quotation Settings. The company record holds the single source
# of truth for the firm's primary bank account; these helpers mirror changes
# between the company record and the bank_accounts collection so a bank account
# added/updated in any one place shows up in the other two automatically.

async def sync_bank_account_to_company(account: dict, full_account_number: str = ""):
    """Push a bank account's details onto its linked company record."""
    company_id = account.get("company_id")
    if not company_id:
        return
    update = {
        "bank_name": account.get("bank_name", ""),
        "bank_account_name": account.get("account_holder", ""),
        "bank_account_holder": account.get("account_holder", ""),
        "bank_account_no": full_account_number or account.get("account_number_full", ""),
        "bank_ifsc": account.get("ifsc", ""),
        "bank_branch": account.get("branch", ""),
        "bank_account_type": (account.get("account_type", "current") or "current").capitalize(),
    }
    if account.get("upi_id"):
        update["upi_id"] = account["upi_id"]
    await db.companies.update_one({"id": company_id}, {"$set": update})


async def sync_company_primary_bank_account(company: dict):
    """Upsert the primary bank_accounts doc for a company from its bank fields."""
    if not company:
        return
    company_id = company.get("id")
    if not company_id:
        return
    bank_name = (company.get("bank_name") or "").strip()
    acc_no = (company.get("bank_account_no") or "").strip()
    if not bank_name and not acc_no:
        return  # nothing meaningful to sync yet
    now = datetime.now(timezone.utc).isoformat()
    fields = {
        "company_id": company_id,
        "bank_name": bank_name,
        "account_holder": (company.get("bank_account_name") or company.get("bank_account_holder") or "").strip(),
        "account_number_masked": _mask_account_number(acc_no),
        "account_number_full": acc_no,
        "ifsc": (company.get("bank_ifsc") or "").strip().upper(),
        "branch": (company.get("bank_branch") or "").strip(),
        "account_type": (company.get("bank_account_type") or "current").lower(),
        "upi_id": (company.get("upi_id") or "").strip(),
        "is_primary": True,
        "updated_at": now,
    }
    existing = await db.bank_accounts.find_one({"company_id": company_id, "is_primary": True})
    if existing:
        await db.bank_accounts.update_one({"id": existing["id"]}, {"$set": fields})
    else:
        fields.update({
            "id": str(uuid.uuid4()),
            "opening_balance": 0.0,
            "notes": "Synced from Invoice / Quotation settings",
            "created_by": company.get("created_by", ""),
            "created_at": now,
        })
        await db.bank_accounts.insert_one(fields)


@router.post("/bank-accounts")
async def create_bank_account(payload: BankAccountCreate, current_user: User = Depends(get_current_user)):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    now = datetime.now(timezone.utc).isoformat()
    full_acc_no = re.sub(r"\s+", "", payload.account_number or "")
    doc = {
        "id": str(uuid.uuid4()), "company_id": payload.company_id, "bank_name": payload.bank_name.strip(),
        "account_holder": payload.account_holder.strip(), "account_number_masked": _mask_account_number(payload.account_number),
        "account_number_full": full_acc_no,
        "ifsc": payload.ifsc.strip().upper(), "branch": payload.branch.strip(), "account_type": payload.account_type,
        "opening_balance": float(payload.opening_balance or 0), "upi_id": payload.upi_id.strip(),
        "is_primary": True, "notes": payload.notes.strip(),
        "created_by": current_user.id, "created_at": now,
    }
    # A newly added account becomes this company's primary — clear the flag on
    # any previous primary so exactly one stays marked.
    if payload.company_id:
        await db.bank_accounts.update_many(
            {"company_id": payload.company_id, "is_primary": True}, {"$set": {"is_primary": False}}
        )
    await db.bank_accounts.insert_one(doc)
    # Mirror onto the company record so Invoice + Quotation settings pick it up.
    try:
        await sync_bank_account_to_company(doc, full_acc_no)
    except Exception:
        pass
    doc.pop("_id", None)
    doc.pop("account_number_full", None)
    return doc


@router.get("/bank-accounts/picker-list")
async def get_bank_accounts_picker(company_id: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    if not _perm_use_bank_picker(current_user):
        raise HTTPException(403, "Access denied to the bank-account picker.")
    q = {"company_id": company_id} if company_id else {}
    accounts = await db.bank_accounts.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return accounts


@router.get("/bank-accounts")
async def list_bank_accounts(company_id: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    q = {"company_id": company_id} if company_id else {}
    accounts = await db.bank_accounts.find(q, {"_id": 0, "account_number_full": 0}).sort("created_at", -1).to_list(500)
    for a in accounts:
        txns = await db.bank_transactions.find({"bank_account_id": a["id"]}, {"_id": 0, "debit": 1, "credit": 1, "date": 1, "balance_after": 1}).to_list(100000)
        
        # Determine the latest transaction containing a valid balance_after
        latest_txn = await db.bank_transactions.find_one(
            {"bank_account_id": a["id"], "balance_after": {"$ne": None}},
            sort=[("date", -1), ("created_at", -1), ("id", -1)]
        )
        
        if latest_txn and latest_txn.get("balance_after") is not None:
            balance = latest_txn["balance_after"]
        else:
            balance = a["opening_balance"] + sum(float(t.get("credit") or 0) for t in txns) - sum(float(t.get("debit") or 0) for t in txns)
            
        a["current_balance"] = round(balance, 2)
        a["transaction_count"] = len(txns)
    return accounts


@router.put("/bank-accounts/{bank_account_id}")
async def update_bank_account(bank_account_id: str, payload: BankAccountCreate, current_user: User = Depends(get_current_user)):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    existing = await db.bank_accounts.find_one({"id": bank_account_id})
    if not existing:
        raise HTTPException(404, "Bank account not found.")
    
    full_acc_no = re.sub(r"\s+", "", payload.account_number or "")
    if "•" in full_acc_no:
        full_acc_no = existing.get("account_number_full") or ""
        masked_acc_no = existing.get("account_number_masked") or ""
    else:
        masked_acc_no = _mask_account_number(payload.account_number)

    doc = {
        "company_id": payload.company_id,
        "bank_name": payload.bank_name.strip(),
        "account_holder": payload.account_holder.strip(),
        "account_number_masked": masked_acc_no,
        "account_number_full": full_acc_no,
        "ifsc": payload.ifsc.strip().upper(),
        "branch": payload.branch.strip(),
        "account_type": payload.account_type,
        "opening_balance": float(payload.opening_balance or 0),
        "upi_id": payload.upi_id.strip(),
        "notes": payload.notes.strip(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    
    await db.bank_accounts.update_one({"id": bank_account_id}, {"$set": doc})
    
    if payload.company_id:
        try:
            await sync_bank_account_to_company({**doc, "id": bank_account_id}, full_acc_no)
        except Exception:
            pass
            
    return {"status": "success", "id": bank_account_id}


@router.delete("/bank-accounts/{bank_account_id}")
async def delete_bank_account(bank_account_id: str, current_user: User = Depends(get_current_user)):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    await db.bank_transactions.delete_many({"bank_account_id": bank_account_id})
    result = await db.bank_accounts.delete_one({"id": bank_account_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Bank account not found.")
    return {"success": True}


# ── Statement parsing ─────────────────────────────────────────────────────
_DATE_COL_HINTS = ("date", "txn date", "value date", "transaction date")
_DESC_COL_HINTS = ("narration", "description", "particulars", "details", "remarks")
_DEBIT_COL_HINTS = ("debit", "withdrawal", "dr")
_CREDIT_COL_HINTS = ("credit", "deposit", "cr")
_BALANCE_COL_HINTS = ("balance", "closing balance", "running balance")
_REF_COL_HINTS = ("ref", "reference", "chq", "cheque", "utr")


def _pick_col(columns: List[str], hints: tuple, exclude: tuple = ()) -> Optional[str]:
    lower = {c: str(c).strip().lower() for c in columns}
    for c, low in lower.items():
        if any(ex in low for ex in exclude):
            continue
        if any(h == low for h in hints):
            return c
    for c, low in lower.items():
        if any(ex in low for ex in exclude):
            continue
        if any(h in low for h in hints):
            return c
    return None


def _row_looks_like_stmt_header(cells: List[str]) -> bool:
    """True if a raw row of lowercased/stripped cell strings looks like the
    real transaction-table header of a bank statement — i.e. it has both a
    date-ish cell and a debit/credit/balance-ish cell. Used to skip past
    banner rows (account details, address, opening balance, etc.) that some
    bank exports place above the actual header row."""
    if not cells:
        return False
    has_date = any(
        any(h == c or h in c for h in _DATE_COL_HINTS) for c in cells if c
    )
    has_amount = any(
        any(h == c or h in c for h in (*_DEBIT_COL_HINTS, *_CREDIT_COL_HINTS, *_BALANCE_COL_HINTS))
        for c in cells if c
    )
    return has_date and has_amount


def _parse_amount(val) -> float:
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    if not s or s.lower() in ("nan", "none", "-"):
        return 0.0
    
    s_lower = s.lower()
    is_neg_dr = "dr" in s_lower or "dr" in s_lower.replace(" ", "")
    
    # Strip everything except digits, dots, hyphens, and parenthesis
    s_clean = re.sub(r'[^\d\.\-\(\)]', '', s_lower)
    if not s_clean:
        return 0.0
        
    neg = s_clean.startswith("(") and s_clean.endswith(")")
    s_clean = s_clean.strip("()")
    try:
        v = abs(float(s_clean))
        return -v if (neg or is_neg_dr) else v
    except Exception:
        return 0.0


def _clean_balance(val):
    """Sanitize an AI-extracted running balance (statement's own
    'balance_after' column). Unlike debit/credit, this value isn't run
    through _parse_amount() at the call sites below, so a malformed or
    non-numeric value from the AI extraction (e.g. a stray "NaN" token,
    an unparsable string) could otherwise reach the DB unchanged and later
    blow up JSON serialization when a report reads it back as a float.
    Returns None (no known balance for this row) if val is missing or
    doesn't resolve to a finite number; otherwise returns a finite float."""
    if val is None:
        return None
    parsed = _parse_amount(val)
    if not math.isfinite(parsed):
        return None
    return parsed


def _parse_stmt_date(val) -> str:
    if val is None:
        return ""
    if hasattr(val, "isoformat"):
        try:
            return val.date().isoformat() if hasattr(val, "date") else val.isoformat()
        except Exception:
            pass
    s = str(val).strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%Y-%m-%d", "%Y/%m/%d", "%d %b %Y", "%d %B %Y", "%d-%b-%Y", "%d-%b-%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            continue
    return s


def _looks_like_real_excel(contents: bytes) -> bool:
    """XLSX/XLSM files are ZIP archives (start with 'PK'); legacy binary XLS
    files are OLE2 Compound Documents (start with the D0CF11E0 magic bytes).
    Several Indian bank portals (SBI among them) label a plain tab-delimited
    text report with a '.xls' extension — that content matches neither
    signature, and must be parsed as text instead of handed to
    `pandas.read_excel`, which would raise 'Excel file format cannot be
    determined' on it."""
    return contents[:4] == b"PK\x03\x04" or contents[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _read_tabular(contents: bytes, ext: str, header_row: Optional[int] = None):
    """Reads CSV, genuine XLS/XLSX, or a text report mislabeled '.xls'/'.xlsx'
    (tab- or comma-delimited, common from Indian bank statement downloads)
    into a DataFrame, all dtype=str so amounts/dates are parsed by our own
    logic rather than pandas' locale-dependent guessing."""
    import pandas as pd
    if ext == "csv":
        return pd.read_csv(BytesIO(contents), dtype=str, keep_default_na=False, skiprows=header_row or 0)
    if _looks_like_real_excel(contents):
        return pd.read_excel(BytesIO(contents), dtype=str, skiprows=header_row or 0)
    # Mislabeled plain-text export — sniff the delimiter from the first line.
    text = contents.decode("utf-8", errors="replace")
    first_line = text.splitlines()[0] if text.splitlines() else ""
    sep = "\t" if "\t" in first_line else ("," if "," in first_line else r"\s{2,}")
    return pd.read_csv(
        BytesIO(contents), dtype=str, keep_default_na=False,
        sep=sep, engine="python", skiprows=header_row or 0,
    )


def _parse_tabular_statement(contents: bytes, filename: str) -> List[dict]:
    """CSV / XLSX / mislabeled-text statements — the overwhelming majority of
    real-world bank exports. Auto-detects the date / narration / debit /
    credit / balance columns regardless of exact header wording or bank."""
    ext = filename.rsplit(".", 1)[-1].lower()
    is_real_excel = ext != "csv" and _looks_like_real_excel(contents)

    df, date_col, columns = None, None, []
    try:
        df = _read_tabular(contents, ext)
        columns = list(df.columns)
        date_col = _pick_col(columns, _DATE_COL_HINTS)
    except Exception:
        df, date_col = None, None

    if not date_col:
        # Some bank exports have several banner rows (account details,
        # address, opening balance, etc. — exactly what SBI's export
        # includes) before the real transaction-table header, and/or aren't
        # a genuine binary spreadsheet at all despite the extension. Scan
        # raw rows for the one that looks like the real header (has both a
        # date-ish and a debit/credit-ish cell), then re-read from there.
        header_row_idx = None
        if is_real_excel:
            import pandas as pd
            try:
                raw = pd.read_excel(BytesIO(contents), header=None, dtype=str)
                for i in range(min(30, len(raw))):
                    cells = [str(v).strip().lower() for v in raw.iloc[i].tolist()]
                    if _row_looks_like_stmt_header(cells):
                        header_row_idx = i
                        break
            except Exception:
                pass
        else:
            # Plain text (real CSV, or a report mislabeled .xls/.xlsx) — scan
            # raw lines directly rather than trusting pandas with a file that
            # has ragged row widths (banner rows have far fewer delimited
            # fields than the transaction table), which is what trips up a
            # naive pandas.read_csv over the whole file in one pass.
            text = contents.decode("utf-8", errors="replace")
            lines = text.splitlines()
            sep = "\t" if any("\t" in l for l in lines[:5]) else ","
            for i, line in enumerate(lines[:30]):
                cells = [c.strip().lower() for c in line.split(sep)]
                if _row_looks_like_stmt_header(cells):
                    header_row_idx = i
                    break

        if header_row_idx is not None:
            try:
                df = _read_tabular(contents, ext, header_row=header_row_idx)
                columns = list(df.columns)
                date_col = _pick_col(columns, _DATE_COL_HINTS)
            except Exception as e:
                raise ValueError(f"Found a header row but could not read the transaction table beneath it: {e}")

    if not date_col or df is None:
        raise ValueError("Could not find a date column in this statement. Check the file has a header row with a 'Date' column.")

    desc_col = _pick_col(columns, _DESC_COL_HINTS) or ""
    debit_col = _pick_col(columns, _DEBIT_COL_HINTS, exclude=("cr/dr", "dr/cr", "cr_dr", "dr_cr", "type", "indicator"))
    credit_col = _pick_col(columns, _CREDIT_COL_HINTS, exclude=("cr/dr", "dr/cr", "cr_dr", "dr_cr", "type", "indicator"))
    balance_col = _pick_col(columns, _BALANCE_COL_HINTS)
    ref_col = _pick_col(columns, _REF_COL_HINTS) or ""

    # Fallback for single-column "Amount" bank statement exports (common in HDFC/ICICI/SBI)
    amount_col = None
    if not debit_col and not credit_col:
        amount_col = _pick_col(columns, ("amount", "transaction amount", "amt", "amount (inr)", "amount(inr)", "txn amount"))

    txns = []
    for _, row in df.iterrows():
        d = _parse_stmt_date(row.get(date_col))
        if not d:
            continue
        
        debit = 0.0
        credit = 0.0
        
        if amount_col:
            val = row.get(amount_col)
            parsed_val = _parse_amount(val)
            if parsed_val < 0:
                debit = abs(parsed_val)
                credit = 0.0
            else:
                debit = 0.0
                credit = abs(parsed_val)
        else:
            debit = _parse_amount(row.get(debit_col)) if debit_col else 0.0
            credit = _parse_amount(row.get(credit_col)) if credit_col else 0.0
            
        if not debit and not credit:
            continue
            
        txns.append({
            "date": d,
            "description": str(row.get(desc_col, "")).strip() if desc_col else "",
            "reference": str(row.get(ref_col, "")).strip() if ref_col else "",
            "debit": round(abs(debit), 2),
            "credit": round(abs(credit), 2),
            "balance_after": _parse_amount(row.get(balance_col)) if balance_col else None,
        })
    return txns


async def _parse_pdf_statement_via_ai(contents: bytes, filename: str) -> List[dict]:
    """Scanned / exported PDF statements — use Gemini 2.0 Flash text extraction when
    a digital text layer is present; otherwise fall back to the vision pipeline."""
    from backend.ai_document_reader import _groq_vision_multipage, _get_gemini_model
    import pdfplumber
    import json as _json

    # Try extracting digital text layer first for 100% accuracy and speed
    extracted_pages = []
    try:
        with pdfplumber.open(BytesIO(contents)) as pdf:
            for i, page in enumerate(pdf.pages[:30]):
                text = page.extract_text()
                if text and text.strip():
                    extracted_pages.append((i + 1, text.strip()))
    except Exception:
        extracted_pages = []

    out = []
    if extracted_pages:
        # High-precision digital PDF statement - use text-layer with Gemini 2.0 Flash page-by-page
        try:
            model = _get_gemini_model()
            for page_num, page_text in extracted_pages:
                prompt = (
                    "You are an expert financial data extraction system. Extract EVERY transaction row from this page of a bank statement.\n"
                    f"Page Number: {page_num}\n\n"
                    "Extract each row into a JSON array of objects, with these exact keys:\n"
                    '- "date": string in YYYY-MM-DD format (normalize input dates like "15 Apr 2026", "14/04/26", "23-05-2023", "01/05/23" to YYYY-MM-DD)\n'
                    '- "description": string (the full transaction description/narration/particulars)\n'
                    '- "reference": string (cheque number, UTR number, UPI transaction reference, reference number or empty string if not shown)\n'
                    '- "debit": number (withdrawal / debit / payment amount, positive number, or 0 if none)\n'
                    '- "credit": number (deposit / credit / receipt amount, positive number, or 0 if none)\n'
                    '- "balance_after": number or null (running balance or closing balance after this transaction)\n\n'
                    "Strict Constraints:\n"
                    "1. DO NOT omit any transaction. Extract ALL transactions present on this page.\n"
                    "2. Ensure debit and credit are positive numbers.\n"
                    "3. Return ONLY a valid JSON array of objects. Do not wrap in markdown fences or include any other text.\n\n"
                    f"PAGE TEXT:\n{page_text}"
                )
                try:
                    response = await model.generate_content_async(prompt)
                    answer = response.text
                    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", answer.strip(), flags=re.I | re.S).strip()
                    m = re.search(r"\[.*\]", cleaned, re.S)
                    if m:
                        cleaned = m.group(0)
                    rows = _json.loads(cleaned)
                    for r in rows if isinstance(rows, list) else []:
                        d = _parse_stmt_date(r.get("date"))
                        if not d:
                            continue
                        out.append({
                            "date": d,
                            "description": str(r.get("description", "")).strip(),
                            "reference": str(r.get("reference", "")).strip(),
                            "debit": round(abs(_parse_amount(r.get("debit"))), 2),
                            "credit": round(abs(_parse_amount(r.get("credit"))), 2),
                            "balance_after": _clean_balance(r.get("balance_after")),
                        })
                except Exception as page_err:
                    import logging
                    logging.getLogger("bank_accounts").warning(f"Failed to parse page {page_num}: {page_err}")
                    continue
            if out:
                return out
        except Exception:
            # Fall back to image-based pipeline if digital extraction or parsing fails
            pass

    # Render pages as images and route through the batched OCR pipeline. The
    # ai_provider helper transparently batches Groq to <=3 images/request
    # (retry+split, ordered merge) so callers no longer need a hard 10-page
    # cap. We still cap at 50 pages to keep memory bounded.
    page_images = []
    try:
        with pdfplumber.open(BytesIO(contents)) as pdf:
            for page in pdf.pages[:50]:
                try:
                    pil_img = page.to_image(resolution=150).original
                    if pil_img.mode not in ("RGB", "L"):
                        pil_img = pil_img.convert("RGB")
                    buf = BytesIO()
                    pil_img.save(buf, format="JPEG", quality=85)
                    page_images.append((base64.b64encode(buf.getvalue()).decode(), "image/jpeg"))
                    del pil_img, buf
                except Exception:
                    # Skip only the broken page; keep processing the rest.
                    continue
    except Exception:
        return []
    if not page_images:
        return []
    prompt = (
        "This is a bank statement. Extract every transaction row as a JSON array, "
        "one object per row, with keys: date (YYYY-MM-DD), description, reference, "
        "debit (number, 0 if none), credit (number, 0 if none), balance_after (number or null). "
        "Return ONLY the JSON array, no markdown fences, no explanation."
    )
    try:
        answer = await _groq_vision_multipage(page_images, prompt)
    except Exception:
        # Batched OCR failed entirely — return empty so the caller can surface
        # a structured "no transactions read" response instead of a hard 500.
        return []
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", (answer or "").strip(), flags=re.I | re.S).strip()
    m = re.search(r"\[.*\]", cleaned, re.S)
    if m:
        cleaned = m.group(0)
    try:
        rows = _json.loads(cleaned)
    except Exception:
        return []
    out = []
    for r in rows if isinstance(rows, list) else []:
        d = _parse_stmt_date(r.get("date"))
        if not d:
            continue
        out.append({
            "date": d, "description": str(r.get("description", "")).strip(),
            "reference": str(r.get("reference", "")).strip(),
            "debit": round(abs(_parse_amount(r.get("debit"))), 2),
            "credit": round(abs(_parse_amount(r.get("credit"))), 2),
            "balance_after": _clean_balance(r.get("balance_after")),
        })
    return out


# ── NLP Normalization and Machine Learning Learner ─────────────────────────
def normalize_description(desc: str) -> str:
    if not desc:
        return ""
    # Convert to lowercase
    s = desc.lower()
    # Strip all digits (removes transaction numbers, dates, times, cheques, timestamps)
    s = re.sub(r'\d+', ' ', s)
    # Strip common non-alphabetic punctuation and noise characters
    s = re.sub(r'[\/\-\_\,\.\:\;\#\*\+\=\[\]\(\)\{\}\&]', ' ', s)
    # Normalize whitespaces to single space
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


async def learn_transaction_match(description: str, matched_type: str, matched_id: str, matched_label: str):
    normalized = normalize_description(description)
    if len(normalized) < 4:
        return
    now = datetime.now(timezone.utc).isoformat()
    await db.bank_learned_mappings.update_one(
        {"pattern": normalized},
        {
            "$set": {
                "matched_type": matched_type,
                "matched_id": matched_id,
                "matched_label": matched_label,
                "updated_at": now
            },
            "$inc": {"score": 1}
        },
        upsert=True
    )


# ── Matching + auto journal posting ───────────────────────────────────────
async def _match_transaction(company_id: str, txn: dict) -> Optional[dict]:
    """Try to match one bank line against:
      1) a Purchase invoice / Sale invoice (the standalone Purchases/Invoicing
         modules), or
      2) an AI Zero-Touch Entry Engine document (Module 1) that already posted
         an Accounts Payable/Receivable entry and is waiting to be settled —
    by amount within a small tolerance and date within a window either side
    of the invoice date, scoped to the bank account's own company so a
    multi-company setup never matches one company's payment against another
    company's invoice. Already-settled/paid records are excluded so the same
    invoice can't be closed twice by two different statement lines. Zero-Touch
    entries are checked first for a debit line since they carry the
    AI-extracted vendor name, which gives a better match than the generic
    purchase_invoices collection when both exist.
      3) FALLBACK: A learned mapping from machine learning (Module 8) built from
         prior manual matches on the same description pattern."""
    txn_date = txn["date"]
    try:
        dt = datetime.strptime(txn_date, "%Y-%m-%d")
    except Exception:
        return None
    window_from = (dt - timedelta(days=30)).date().isoformat()
    window_to = (dt + timedelta(days=30)).date().isoformat()

    if txn["debit"] > 0:
        amount = txn["debit"]

        zte_candidates = await db.zte_processed_documents.find(
            {
                "company_id": company_id, "status": "posted", "settled": {"$ne": True},
                "extracted.document_type": "PURCHASE",
                "extracted.invoice_date": {"$gte": window_from, "$lte": window_to},
            },
            {"_id": 0},
        ).to_list(2000)
        for c in zte_candidates:
            inr_total = c.get("amount_inr") or float((c.get("extracted") or {}).get("total_invoice_value") or 0)
            if inr_total and abs(inr_total - amount) <= max(1.0, amount * 0.01):
                vendor = (c.get("extracted") or {}).get("vendor_or_customer_name") or "Zero-Touch purchase"
                return {"type": "zte_purchase", "id": c["id"], "label": vendor, "ap_amount": inr_total}

        candidates = await db.purchase_invoices.find(
            {
                "company_id": company_id, "payment_status": {"$ne": "paid"},
                "invoice_date": {"$gte": window_from, "$lte": window_to},
            },
            {"_id": 0},
        ).to_list(2000)
        for c in candidates:
            gt = float(c.get("grand_total") or 0)
            if gt and abs(gt - amount) <= max(1.0, amount * 0.01):
                return {"type": "purchase", "id": c["id"], "label": c.get("supplier_name") or c.get("invoice_no") or "Purchase invoice", "grand_total": gt}

    elif txn["credit"] > 0:
        amount = txn["credit"]

        zte_candidates = await db.zte_processed_documents.find(
            {
                "company_id": company_id, "status": "posted", "settled": {"$ne": True},
                "extracted.document_type": "SALE",
                "extracted.invoice_date": {"$gte": window_from, "$lte": window_to},
            },
            {"_id": 0},
        ).to_list(2000)
        for c in zte_candidates:
            inr_total = c.get("amount_inr") or float((c.get("extracted") or {}).get("total_invoice_value") or 0)
            if inr_total and abs(inr_total - amount) <= max(1.0, amount * 0.01):
                customer = (c.get("extracted") or {}).get("vendor_or_customer_name") or "Zero-Touch sale"
                return {"type": "zte_sale", "id": c["id"], "label": customer, "ar_amount": inr_total}

        candidates = await db.invoices.find(
            {
                "company_id": company_id, "status": {"$nin": ["paid", "cancelled"]},
                "invoice_date": {"$gte": window_from, "$lte": window_to},
            },
            {"_id": 0},
        ).to_list(2000)
        for c in candidates:
            total = float(c.get("grand_total") or c.get("total_amount") or c.get("total") or 0)
            due = c.get("amount_due")
            match_amount = float(due) if due is not None else total
            if match_amount and abs(match_amount - amount) <= max(1.0, amount * 0.01):
                return {"type": "sale", "id": c.get("id"), "label": c.get("client_name") or c.get("invoice_no") or "Sale invoice", "grand_total": total}

    # ── FALLBACK: Check Machine Learning Learned Mappings ──
    normalized = normalize_description(txn.get("description", ""))
    if normalized:
        learned = await db.bank_learned_mappings.find_one({"pattern": normalized})
        if learned:
            mtype = learned.get("matched_type")
            mid = learned.get("matched_id")
            mlabel = learned.get("matched_label")
            if mtype in ("expense", "suspense", "asset", "liability", "revenue"):
                acct = await db.chart_of_accounts.find_one({"id": mid})
                if acct:
                    return {
                        "type": mtype,
                        "id": mid,
                        "label": mlabel or acct.get("name", "Account"),
                        "source": "ml_learned"
                    }
            elif mtype == "purchase":
                amount = txn.get("debit") or 0.0
                if amount > 0:
                    bill = await db.purchase_invoices.find_one({
                        "company_id": company_id,
                        "payment_status": {"$ne": "paid"},
                        "supplier_name": mlabel,
                    })
                    if bill:
                        gt = float(bill.get("grand_total") or 0)
                        if abs(gt - amount) <= max(1.0, amount * 0.05):
                            return {
                                "type": "purchase",
                                "id": bill["id"],
                                "label": bill.get("supplier_name") or bill.get("invoice_no") or "Purchase invoice",
                                "grand_total": gt,
                                "source": "ml_learned_bill"
                            }
            elif mtype == "sale":
                amount = txn.get("credit") or 0.0
                if amount > 0:
                    invoice = await db.invoices.find_one({
                        "company_id": company_id,
                        "status": {"$nin": ["paid", "cancelled"]},
                        "client_name": mlabel,
                    })
                    if invoice:
                        gt = float(invoice.get("grand_total") or invoice.get("total_amount") or invoice.get("total") or 0)
                        if abs(gt - amount) <= max(1.0, amount * 0.05):
                            return {
                                "type": "sale",
                                "id": invoice.get("id"),
                                "label": invoice.get("client_name") or invoice.get("invoice_no") or "Sale invoice",
                                "grand_total": gt,
                                "source": "ml_learned_invoice"
                            }

    return None


async def _snapshot_prev_match_status(match: dict) -> Optional[str]:
    """Reads the matched record's current status *before* a match overwrites
    it, so Unmatch / Edit Match can restore the exact prior value instead of
    guessing a generic 'unpaid' state. Read-only — never mutates anything."""
    if match["type"] == "purchase":
        rec = await db.purchase_invoices.find_one({"id": match["id"]}, {"_id": 0, "payment_status": 1})
        return (rec or {}).get("payment_status")
    if match["type"] in ("sale",):
        rec = await db.invoices.find_one({"id": match["id"]}, {"_id": 0, "status": 1})
        return (rec or {}).get("status")
    if match["type"] in ("zte_purchase", "zte_sale"):
        rec = await db.zte_processed_documents.find_one({"id": match["id"]}, {"_id": 0, "settled": 1})
        return "settled" if (rec or {}).get("settled") else "unsettled"
    return None


async def _revert_match_effects(txn: dict):
    """Reverses only the reconciliation side-effects of a match — the journal
    entry it posted and the paid/settled flag it set on the matched record —
    restoring the record's exact prior status. Never touches the invoice,
    purchase bill, receipt, GST filing, or audit history themselves; the
    record stays fully intact and simply becomes available to match again.
    Shared by Unmatch and Edit Match so both behave identically."""
    if txn.get("journal_entry_id"):
        from backend.accounting_lock import reverse_journal_entry
        try:
            await reverse_journal_entry(
                txn["journal_entry_id"],
                "Bank reconciliation match removed or changed",
                "system",
            )
        except HTTPException:
            raise
        except Exception as exc:
            import logging
            logging.getLogger("bank_accounts").exception(
                "Unable to reverse bank reconciliation journal entry %s", txn["journal_entry_id"]
            )
            raise HTTPException(500, "Bank reconciliation could not be safely reversed.") from exc

    mtype, mid = txn.get("matched_type"), txn.get("matched_id")
    prev_status = txn.get("prev_match_status")
    now = datetime.now(timezone.utc).isoformat()

    if mtype == "purchase" and mid:
        await db.purchase_invoices.update_one(
            {"id": mid},
            {
                "$set": {"payment_status": prev_status, "updated_at": now},
                "$unset": {"paid_amount": "", "paid_date": "", "paid_bank_txn_id": "", "journal_entry_id": ""},
            },
        )
    elif mtype == "sale" and mid:
        restored_status = prev_status or "sent"
        history_entry = {"status": restored_status, "changed_at": now, "changed_by": "system (bank unmatch)"}
        rec = await db.invoices.find_one({"id": mid}, {"_id": 0, "grand_total": 1, "total_amount": 1, "total": 1})
        due_total = float((rec or {}).get("grand_total") or (rec or {}).get("total_amount") or (rec or {}).get("total") or 0)
        await db.invoices.update_one(
            {"id": mid},
            {
                "$set": {"status": restored_status, "amount_paid": 0.0, "amount_due": round(due_total, 2), "updated_at": now},
                "$unset": {"paid_bank_txn_id": "", "journal_entry_id": ""},
                "$push": {"status_history": history_entry},
            },
        )
    elif mtype in ("zte_purchase", "zte_sale") and mid:
        await db.zte_processed_documents.update_one(
            {"id": mid},
            {"$set": {"settled": False}, "$unset": {"settled_bank_txn_id": "", "settled_journal_entry_id": ""}},
        )


async def _auto_post_for_match(company_id: str, txn: dict, match: dict, created_by: str) -> Optional[str]:
    txn["prev_match_status"] = await _snapshot_prev_match_status(match)
    bank_acct_id = await get_default_account_id(company_id, "1010")  # Bank Accounts
    if not bank_acct_id:
        return None

    if match["type"] == "zte_purchase":
        # This invoice already posted Dr Expense / Dr ITC / Cr Accounts
        # Payable via the Zero-Touch Entry Engine — settle that payable
        # rather than booking the expense a second time.
        ap_acct_id = await get_default_account_id(company_id, "2000")  # Accounts Payable
        if not ap_acct_id:
            return None
        entry = await try_auto_post(
            company_id, txn["date"], f"Payment to {match['label']} — settles Zero-Touch Entry invoice (bank statement)",
            [
                {"account_id": ap_acct_id, "account_name": "Accounts Payable", "debit": txn["debit"], "credit": 0},
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": 0, "credit": txn["debit"]},
            ],
            "bank", txn["id"], created_by,
        )
        if entry:
            await db.zte_processed_documents.update_one(
                {"id": match["id"]},
                {"$set": {"settled": True, "settled_bank_txn_id": txn["id"], "settled_journal_entry_id": entry["id"]}},
            )
        return entry["id"] if entry else None

    if match["type"] == "zte_sale":
        ar_acct_id = await get_default_account_id(company_id, "1100")  # Accounts Receivable
        if not ar_acct_id:
            return None
        entry = await try_auto_post(
            company_id, txn["date"], f"Receipt from {match['label']} — settles Zero-Touch Entry invoice (bank statement)",
            [
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": txn["credit"], "credit": 0},
                {"account_id": ar_acct_id, "account_name": "Accounts Receivable", "debit": 0, "credit": txn["credit"]},
            ],
            "bank", txn["id"], created_by,
        )
        if entry:
            await db.zte_processed_documents.update_one(
                {"id": match["id"]},
                {"$set": {"settled": True, "settled_bank_txn_id": txn["id"], "settled_journal_entry_id": entry["id"]}},
            )
        return entry["id"] if entry else None

    if match["type"] in ("expense", "suspense", "asset", "liability", "revenue"):
        # Match a bank line directly to a chart-of-accounts head (any expense
        # ledger, or the parking "Suspense Account" 9998). match["id"] is the
        # chart_of_accounts.id — NOT an invoice id.
        #
        # Debit line (money paid out) → Dr <chosen head>  / Cr Bank
        # Credit line (money received) → Dr Bank            / Cr <chosen head>
        #
        # "Suspense" is just the same posting against account 9998, chosen
        # explicitly when the correct head isn't known yet. Later, the user
        # opens the Suspense ledger, unmatches, and re-matches to the real
        # expense head — the reversal + fresh posting keeps the trail clean.
        acct = await db.chart_of_accounts.find_one({"id": match["id"]}, {"_id": 0})
        if not acct:
            return None
        acct_name = acct.get("name", "Account")
        amt = float(txn.get("debit") or 0) or float(txn.get("credit") or 0)
        is_debit = bool(txn.get("debit"))
        if is_debit:
            lines = [
                {"account_id": acct["id"], "account_name": acct_name, "debit": amt, "credit": 0},
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": 0, "credit": amt},
            ]
            narration_verb = "Payment"
        else:
            lines = [
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": amt, "credit": 0},
                {"account_id": acct["id"], "account_name": acct_name, "debit": 0, "credit": amt},
            ]
            narration_verb = "Receipt"
        note = " (parked — reclassify from Suspense Review)" if match["type"] == "suspense" else ""
        entry = await try_auto_post(
            match.get("company_id") or txn.get("company_id", ""), txn["date"],
            f"{narration_verb} — {acct_name}{note} (bank statement)",
            lines, "bank", txn["id"], created_by,
        )
        return entry["id"] if entry else None


    if match["type"] == "purchase":
        # NOTE: the purchase invoice's own expense (Dr <expense head> / Dr GST
        # Input, Cr Accounts Payable) was already posted when the bill was
        # first saved (see sync_purchase_journal_entry). Settling it via a
        # bank statement match is a PAYMENT, not a fresh purchase — it must
        # clear the payable, not re-debit the expense a second time. This
        # mirrors the zte_purchase branch above, which does this correctly.
        payable_acct_id = await get_default_account_id(company_id, "2000")  # Accounts Payable
        if not payable_acct_id:
            return None
        entry = await try_auto_post(
            company_id, txn["date"], f"Payment to {match['label']} — settles Purchase Bill (bank statement)",
            [
                {"account_id": payable_acct_id, "account_name": "Accounts Payable", "debit": txn["debit"], "credit": 0},
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": 0, "credit": txn["debit"]},
            ],
            "bank", txn["id"], created_by,
        )
        if entry:
            # Close the purchase invoice itself — this is what actually makes
            # it disappear from an "outstanding purchases" view, not just the
            # bank_transactions row.
            await db.purchase_invoices.update_one(
                {"id": match["id"]},
                {"$set": {
                    "payment_status": "paid", "paid_amount": txn["debit"], "paid_date": txn["date"],
                    "paid_bank_txn_id": txn["id"], "journal_entry_id": entry["id"],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
    else:
        ar_acct_id = await get_default_account_id(company_id, "1100")  # Accounts Receivable
        if not ar_acct_id:
            return None

        # ── Guard: refuse to settle an invoice a DIFFERENT bank transaction
        # already settled ──────────────────────────────────────────────────
        # If invoice.status is already "paid" with a journal_entry_id from an
        # earlier match, and this call is for a different bank transaction,
        # posting again would Dr Bank / Cr AR a second time for money that
        # was only received once — turning "invoice already shows Paid" into
        # a duplicate ledger entry instead of a no-op. This is the case the
        # de-dup block below does NOT cover (that one only handles a manual
        # `payments` receipt recorded before the bank line arrives — the
        # opposite order to this one).
        current_inv = await db.invoices.find_one(
            {"id": match["id"]}, {"_id": 0, "status": 1, "journal_entry_id": 1, "paid_bank_txn_id": 1}
        )
        if (current_inv and current_inv.get("status") == "paid" and current_inv.get("journal_entry_id")
                and current_inv.get("paid_bank_txn_id") != txn.get("id")):
            import logging
            logging.getLogger("bank_accounts").warning(
                f"[dup-match-blocked] invoice={match['id']} already settled by bank_txn="
                f"{current_inv.get('paid_bank_txn_id')}; refused second settlement from "
                f"bank_txn={txn.get('id')}"
            )
            return None

        # ── De-duplicate before posting ──────────────────────────────────────
        # If the invoice already has payment records in db.payments (i.e. the
        # user manually recorded the receipt before uploading the bank statement),
        # those payments already posted:  Dr Bank (1010) / Cr AR (1100)
        # Posting the bank-match journal on top would be a second Dr Bank / Cr AR
        # — double-crediting AR and double-debiting Bank.
        #
        # Fix: wipe any existing payment-source journal entries for this invoice
        # before posting the bank-match journal, so there is exactly ONE
        # Dr Bank / Cr AR for this receipt.
        existing_pmts_for_inv = await db.payments.find(
            {"invoice_id": match["id"]}, {"_id": 0, "id": 1}
        ).to_list(100)
        if existing_pmts_for_inv:
            pmt_ids = [p["id"] for p in existing_pmts_for_inv]
            old_pmt_jes = await db.journal_entries.find(
                {"source": "payment", "source_id": {"$in": pmt_ids}}, {"_id": 0, "id": 1}
            ).to_list(100)
            if old_pmt_jes:
                old_je_ids = [e["id"] for e in old_pmt_jes]
                await db.journal_lines.delete_many({"entry_id": {"$in": old_je_ids}})
                await db.journal_entries.delete_many({"id": {"$in": old_je_ids}})

        entry = await try_auto_post(
            company_id, txn["date"], f"Receipt from {match['label']} — settles Invoice {match.get('label')} (bank statement)",
            [
                {"account_id": bank_acct_id, "account_name": "Bank Accounts", "debit": txn["credit"], "credit": 0},
                {"account_id": ar_acct_id, "account_name": "Accounts Receivable", "debit": 0, "credit": txn["credit"]},
            ],
            "bank", txn["id"], created_by,
        )
        if entry:
            # Same convention as PATCH /invoices/{id}/status when a user
            # manually marks an invoice paid, so reports/status filters agree
            # regardless of which path closed the invoice.
            grand_total = match.get("grand_total") or txn["credit"]
            history_entry = {
                "status": "paid", "changed_at": datetime.now(timezone.utc).isoformat(),
                "changed_by": "system (bank reconciliation)",
            }
            await db.invoices.update_one(
                {"id": match["id"]},
                {
                    "$set": {
                        "status": "paid", "amount_paid": round(float(grand_total), 2), "amount_due": 0.0,
                        "paid_bank_txn_id": txn["id"], "journal_entry_id": entry["id"],
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    "$push": {"status_history": history_entry},
                },
            )
    return entry["id"] if entry else None


async def _already_settled_by_other_txn(matched_type: str, matched_id: str, txn_id: str) -> Optional[str]:
    """Returns the OTHER bank_transaction id that already settled this
    invoice/purchase, or None if it's free to settle. Used by manual/edit
    match (which pick a target explicitly, bypassing the "already paid"
    filter that protects the candidate-search paths in _match_transaction)
    so a user picking an already-settled invoice gets a clear 409 instead
    of a transaction silently left "matched" with no journal entry — see
    the matching guard inside _auto_post_for_match's sale branch."""
    if matched_type == "sale":
        inv = await db.invoices.find_one(
            {"id": matched_id, "status": "paid", "journal_entry_id": {"$ne": None}},
            {"_id": 0, "paid_bank_txn_id": 1},
        )
        if inv and inv.get("paid_bank_txn_id") and inv.get("paid_bank_txn_id") != txn_id:
            return inv["paid_bank_txn_id"]
    elif matched_type == "purchase":
        pur = await db.purchase_invoices.find_one(
            {"id": matched_id, "payment_status": "paid", "journal_entry_id": {"$ne": None}},
            {"_id": 0, "paid_bank_txn_id": 1},
        )
        if pur and pur.get("paid_bank_txn_id") and pur.get("paid_bank_txn_id") != txn_id:
            return pur["paid_bank_txn_id"]
    return None




@router.post("/bank-accounts/{bank_account_id}/upload-statement")
async def upload_statement(
    bank_account_id: str, file: UploadFile = File(...), auto_match: bool = Form(default=True),
    current_user: User = Depends(get_current_user),
):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    bank_acct = await db.bank_accounts.find_one({"id": bank_account_id}, {"_id": 0})
    if not bank_acct:
        raise HTTPException(404, "Bank account not found.")

    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(413, "File too large — please upload a statement under 15 MB.")
    filename = file.filename or "statement"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    warnings: List[str] = []
    parsed_rows: List[dict] = []
    try:
        if ext in ("csv", "xlsx", "xls"):
            parsed_rows = _parse_tabular_statement(contents, filename)
        elif ext == "pdf":
            parsed_rows = await _parse_pdf_statement_via_ai(contents, filename)
        else:
            raise HTTPException(415, f"Unsupported file type '.{ext}'. Upload a CSV, XLSX, or PDF bank statement.")
    except HTTPException as he:
        # Structural / provider errors — surface the real reason instead of a generic message.
        if he.status_code in (413, 415):
            raise
        warnings.append(str(he.detail) if he.detail else f"HTTP {he.status_code}")
        parsed_rows = []
    except Exception as e:
        # Never bubble a 500 to the frontend; return a structured "no rows" response.
        warnings.append(f"Could not read this statement: {e}")
        parsed_rows = []

    if not parsed_rows:
        return {
            "success": False,
            "bank_account_id": bank_account_id,
            "transactions_saved": 0,
            "auto_matched": 0,
            "auto_posted": 0,
            "transactions": [],
            "warnings": warnings or [
                "No transactions could be read from this file. Try exporting the "
                "statement as CSV or XLSX for the most reliable reading."
            ],
        }

    now = datetime.now(timezone.utc).isoformat()
    saved, matched_count, posted_count, auto_suspensed_count = [], 0, 0, 0

    # ── COMPREHENSIVE MULTI-SET DEDUPLICATION ENGINE ──
    db_txns = await db.bank_transactions.find({"bank_account_id": bank_account_id}).to_list(100000)
    db_counts = {}
    db_refs = set()
    for t in db_txns:
        ref_val = str(t.get("reference") or "").strip().lower()
        if ref_val and ref_val not in ("", "-", ".", "0", "nan", "none", "n/a", "null"):
            db_refs.add(ref_val)
        
        key = (
            t["date"],
            round(float(t.get("debit") or 0.0), 2),
            round(float(t.get("credit") or 0.0), 2),
            str(t.get("description") or "").strip().lower()
        )
        db_counts[key] = db_counts.get(key, 0) + 1

    uploaded_counts = {}

    for row in parsed_rows:
        doc = {
            "id": str(uuid.uuid4()), "bank_account_id": bank_account_id, "company_id": bank_acct.get("company_id", ""),
            "date": row["date"], "description": row.get("description", ""), "reference": row.get("reference", ""),
            "debit": row.get("debit", 0.0), "credit": row.get("credit", 0.0), "balance_after": row.get("balance_after"),
            "matched_type": None, "matched_id": None, "matched_label": None, "journal_entry_id": None,
            "source_file": filename, "created_by": current_user.id, "created_at": now,
        }

        # 1. Reference number global check
        ref = str(doc.get("reference") or "").strip().lower()
        if ref and ref not in ("", "-", ".", "0", "nan", "none", "n/a", "null"):
            if ref in db_refs:
                continue

        # 2. Multi-set exact match check
        desc_key = str(doc.get("description") or "").strip().lower()
        key = (
            doc["date"],
            round(float(doc.get("debit") or 0.0), 2),
            round(float(doc.get("credit") or 0.0), 2),
            desc_key
        )
        
        already_in_db = db_counts.get(key, 0)
        already_processed = uploaded_counts.get(key, 0)
        
        if already_processed < already_in_db:
            uploaded_counts[key] = already_processed + 1
            continue
            
        uploaded_counts[key] = already_processed + 1

        if auto_match:
            match = await _match_transaction(bank_acct.get("company_id", ""), doc)
            if match:
                if match.get("source") in ("ml_learned", "ml_learned_bill", "ml_learned_invoice") or "source" in match:
                    doc["suggested_match"] = {
                        "matched_type": match["type"],
                        "matched_id": match["id"],
                        "matched_label": match["label"],
                        "pending_approval": True
                    }
                else:
                    doc["matched_type"] = match["type"]
                    doc["matched_id"] = match["id"]
                    doc["matched_label"] = match["label"]
                    matched_count += 1
                    entry_id = await _auto_post_for_match(bank_acct.get("company_id", ""), doc, match, current_user.id)
                    if entry_id:
                        doc["journal_entry_id"] = entry_id
                        posted_count += 1
            else:
                # ── No confident match: park to Suspense instead of dropping the line ──
                # A statement line that matches nothing used to stay completely
                # unposted — matched_type/journal_entry_id both None, zero impact
                # on the ledger. That's silent and cumulative: the real cash
                # movement happened in the bank, but the GL "1010 Bank Accounts"
                # balance never moved with it, so it drifts further from the
                # actual bank balance with every unmatched line. For an
                # unmatched credit specifically, it also leaves Accounts
                # Receivable overstated — the invoice still shows "due" even
                # though the money already arrived, because nothing ever told
                # the ledger this receipt happened.
                #
                # Fix: auto-park every unmatched line to the Suspense Account
                # (9998) the moment it's imported — the exact same posting the
                # "Park to Suspense" button already does for a manual match
                # (see _auto_post_for_match's "suspense" branch). This keeps
                # Bank Accounts always equal to the real statement; the
                # unclassified side sits in Suspense, visible in the Suspense
                # Review workflow, until someone reclassifies it to its real
                # expense/income head.
                suspense_id = await get_default_account_id(bank_acct.get("company_id", ""), "9998")
                if suspense_id:
                    suspense_match = {"type": "suspense", "id": suspense_id, "label": "Unclassified (auto-parked)"}
                    doc["matched_type"] = "suspense"
                    doc["matched_id"] = suspense_id
                    doc["matched_label"] = "Unclassified (auto-parked)"
                    doc["auto_suspensed"] = True
                    entry_id = await _auto_post_for_match(bank_acct.get("company_id", ""), doc, suspense_match, current_user.id)
                    if entry_id:
                        doc["journal_entry_id"] = entry_id
                        posted_count += 1
                        auto_suspensed_count += 1

        await db.bank_transactions.insert_one(doc)
        doc.pop("_id", None)
        saved.append(doc)

    return {
        "success": True,
        "bank_account_id": bank_account_id, "transactions_saved": len(saved),
        "auto_matched": matched_count, "auto_posted": posted_count,
        "auto_suspensed": auto_suspensed_count, "transactions": saved,
        "warnings": warnings,
    }


@router.get("/bank-accounts/{bank_account_id}/transactions")
async def list_transactions(
    bank_account_id: str, matched: Optional[str] = Query(None, description="matched | unmatched | all"),
    current_user: User = Depends(get_current_user),
):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"bank_account_id": bank_account_id}
    if matched == "matched":
        q["matched_type"] = {"$ne": None}
    elif matched == "unmatched":
        q["matched_type"] = None
    items = await db.bank_transactions.find(q, {"_id": 0}).sort("date", -1).to_list(20000)
    return items


@router.get("/bank-accounts/{bank_account_id}/intelligence")
async def get_bank_account_intelligence(bank_account_id: str, current_user: User = Depends(get_current_user)):
    """
    Reconciliation statistics + fraud/anomaly flags computed directly from
    the live `bank_transactions` collection — i.e. the same data
    /upload-statement and /transactions actually use.

    (The older Phase 8 BankStatistics module reads from
    bank_transaction_history / bank_reconciliation instead, which nothing
    in the live upload path writes to, so it always reports zeros. This
    endpoint reuses Phase 8's FraudDetector — which is DB-agnostic, just a
    pure function over a transaction list — against the real data instead.)
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")

    txns = await db.bank_transactions.find({"bank_account_id": bank_account_id}, {"_id": 0}).sort("date", -1).to_list(20000)

    total = len(txns)
    matched = sum(1 for t in txns if t.get("matched_type") and t.get("matched_type") != "suspense")
    suspensed = sum(1 for t in txns if t.get("matched_type") == "suspense")
    unmatched = total - matched - suspensed
    total_debit = round(sum(float(t.get("debit") or 0) for t in txns), 2)
    total_credit = round(sum(float(t.get("credit") or 0) for t in txns), 2)

    statistics = {
        "total_transactions": total,
        "matched": matched,
        "auto_suspensed": suspensed,
        "unmatched": unmatched,
        "reconciliation_rate": round((matched / total) * 100, 1) if total else 0.0,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "net_movement": round(total_credit - total_debit, 2),
    }

    # Normalise into the generic {id, amount, date, narration, type, bank_account_id}
    # shape FraudDetector.analyse_transactions expects.
    normalised = []
    for t in txns:
        debit, credit = float(t.get("debit") or 0), float(t.get("credit") or 0)
        normalised.append({
            "id": t.get("id"),
            "amount": debit or credit,
            "date": t.get("date"),
            "narration": t.get("description") or "",
            "type": "debit" if debit else "credit",
            "bank_account_id": t.get("bank_account_id"),
        })

    anomalies = []
    try:
        from backend.bank_ai.fraud_detector import FraudDetector
        anomalies = await FraudDetector.analyse_transactions(normalised)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"[bank_intelligence] fraud scan failed: {e}")

    return {"statistics": statistics, "anomalies": anomalies}





@router.post("/bank-transactions/ai-auto-match")
async def run_ai_auto_match(payload: Optional[AIAutoMatchInput] = None, current_user: User = Depends(get_current_user)):
    bank_acc_id = payload.bank_account_id if payload else None
    
    query = {"matched_type": {"$in": [None, ""]}}
    if bank_acc_id:
        query["bank_account_id"] = bank_acc_id
    
    unmatched = await db.bank_transactions.find(query).to_list(1000)
    if not unmatched:
        return {"success": True, "message": "No unmatched transactions found.", "matchedCount": 0}

    # NOTE: not pre-filtered by company_id — a multi-company setup mixes
    # every open invoice/bill here, so the per-candidate loop below checks
    # company_id against the transaction's own company before considering it.
    open_sales = await db.invoices.find({"status": {"$ne": "paid"}}, {"_id": 0}).to_list(5000)
    open_purchases = await db.purchase_invoices.find({"status": {"$ne": "paid"}}, {"_id": 0}).to_list(5000)
    coa_items = await db.chart_of_accounts.find({}, {"_id": 0}).to_list(1000)

    matched_count = 0
    posted_count = 0
    for txn in unmatched:
        txn_id = txn.get("id")
        txn_company = txn.get("company_id", "")
        desc = (txn.get("description") or "").strip().lower()
        debit = float(txn.get("debit") or 0)
        credit = float(txn.get("credit") or 0)
        amt = credit if credit > 0 else debit

        matched = False
        # 1. Match Sales (Credits)
        if credit > 0:
            for s in open_sales:
                if txn_company and s.get("company_id", "") != txn_company:
                    continue  # never match a bank line to another company's invoice
                inv_no = (s.get("invoice_no") or "").lower()
                client_name = (s.get("client_name") or s.get("party_name") or "").lower()
                tot = float(s.get("grand_total") or s.get("total_amount") or 0)

                if (inv_no and inv_no in desc) or (client_name and len(client_name) > 3 and client_name in desc) or (tot > 0 and abs(tot - amt) < 0.01):
                    # Post the actual Dr Bank / Cr Accounts Receivable entry
                    # through the shared, audited pipeline — this used to
                    # only flip invoice.status/amount_due with NO journal
                    # entry at all, which silently broke Accounts
                    # Receivable = Outstanding for every invoice matched
                    # this way. _auto_post_for_match also carries the
                    # already-settled-by-a-different-transaction guard, so
                    # a false/duplicate match here is refused instead of
                    # double-posting.
                    entry_id = await _auto_post_for_match(
                        txn_company, txn,
                        {"type": "sale", "id": s.get("id"),
                         "label": s.get("client_name") or s.get("invoice_no") or "Sale invoice", "grand_total": tot},
                        current_user.id,
                    )
                    if not entry_id:
                        continue  # already settled elsewhere, or posting failed — try the next candidate
                    await db.bank_transactions.update_one(
                        {"id": txn_id},
                        {"$set": {
                            "matched_type": "sale",
                            "matched_id": s.get("id"),
                            "matched_label": f"Invoice #{s.get('invoice_no', '')} - {s.get('client_name', '')}",
                            "confidence_score": 95,
                            "pending_approval": False,
                            "journal_entry_id": entry_id,
                        }}
                    )
                    matched_count += 1
                    posted_count += 1
                    matched = True
                    # Stop this invoice being grabbed again by a LATER
                    # transaction in this same batch — the in-memory list
                    # never reflected the DB update above, which is exactly
                    # how the same invoice could be double-matched within
                    # one "Run AI Auto-Match" click.
                    open_sales.remove(s)
                    break

        # 2. Match Purchases (Debits)
        if not matched and debit > 0:
            for p in open_purchases:
                if txn_company and p.get("company_id", "") != txn_company:
                    continue  # never match a bank line to another company's bill
                inv_no = (p.get("invoice_no") or "").lower()
                supplier_name = (p.get("supplier_name") or p.get("vendor_name") or "").lower()
                tot = float(p.get("grand_total") or p.get("total_amount") or 0)

                if (inv_no and inv_no in desc) or (supplier_name and len(supplier_name) > 3 and supplier_name in desc) or (tot > 0 and abs(tot - amt) < 0.01):
                    entry_id = await _auto_post_for_match(
                        txn_company, txn,
                        {"type": "purchase", "id": p.get("id"),
                         "label": p.get("supplier_name") or p.get("invoice_no") or "Purchase invoice", "grand_total": tot},
                        current_user.id,
                    )
                    if not entry_id:
                        continue
                    await db.bank_transactions.update_one(
                        {"id": txn_id},
                        {"$set": {
                            "matched_type": "purchase",
                            "matched_id": p.get("id"),
                            "matched_label": f"Bill #{p.get('invoice_no', '')} - {p.get('supplier_name', '')}",
                            "confidence_score": 92,
                            "pending_approval": False,
                            "journal_entry_id": entry_id,
                        }}
                    )
                    matched_count += 1
                    posted_count += 1
                    matched = True
                    open_purchases.remove(p)
                    break

        # 3. Match Chart of Accounts keywords (Salary, Rent, Interest, Taxes, Bank Charges)
        if not matched:
            target_coa = None
            if "salary" in desc or "wage" in desc:
                target_coa = next((c for c in coa_items if "salary" in c.get("name", "").lower()), None)
            elif "rent" in desc:
                target_coa = next((c for c in coa_items if "rent" in c.get("name", "").lower()), None)
            elif "interest" in desc:
                target_coa = next((c for c in coa_items if "interest" in c.get("name", "").lower()), None)
            elif "charge" in desc or "fee" in desc or "tax" in desc:
                target_coa = next((c for c in coa_items if "bank" in c.get("name", "").lower() or "charge" in c.get("name", "").lower()), None)

            if target_coa:
                await db.bank_transactions.update_one(
                    {"id": txn_id},
                    {"$set": {
                        "matched_type": "expense" if debit > 0 else "income",
                        "matched_id": target_coa.get("id"),
                        "matched_label": target_coa.get("name"),
                        "confidence_score": 88,
                        "pending_approval": False
                    }}
                )
                matched_count += 1

    return {
        "success": True,
        "message": f"AI Auto-matching complete. Matched {matched_count} transaction(s).",
        "matchedCount": matched_count
    }


@router.post("/bank-transactions/{txn_id}/match")
async def manual_match_transaction(txn_id: str, payload: ManualMatchInput, current_user: User = Depends(get_current_user)):
    if not _perm_match_bank(current_user):
        raise HTTPException(403, "Access denied. Matching bank transactions requires Match permission — request access from your admin.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    if txn.get("matched_type") == payload.matched_type and txn.get("matched_id") == payload.matched_id:
        raise HTTPException(400, "This transaction is already matched to that record.")
    if txn.get("matched_type"):
        raise HTTPException(400, "This transaction is already matched — use Edit Match to change it.")

    if payload.post_journal and payload.matched_type in ("sale", "purchase"):
        other_txn_id = await _already_settled_by_other_txn(payload.matched_type, payload.matched_id, txn_id)
        if other_txn_id:
            kind = "invoice" if payload.matched_type == "sale" else "bill"
            raise HTTPException(
                409,
                f"That {kind} is already marked Paid — it was settled by a different bank "
                f"transaction (id {other_txn_id}). Matching this transaction to it too would "
                f"post a second receipt for money that was only received once. If this really "
                f"is a separate payment, match it to the correct invoice/bill instead; if it's "
                f"a duplicate bank line, ignore or delete this transaction.",
            )

    update = {"matched_type": payload.matched_type, "matched_id": payload.matched_id, "matched_label": payload.matched_label}
    if payload.post_journal:
        entry_id = await _auto_post_for_match(
            txn.get("company_id", ""), txn,
            {"type": payload.matched_type, "id": payload.matched_id, "label": payload.matched_label}, current_user.id,
        )
        update["prev_match_status"] = txn.get("prev_match_status")
        if entry_id:
            update["journal_entry_id"] = entry_id
    await db.bank_transactions.update_one({"id": txn_id}, {"$set": update, "$unset": {"suggested_match": ""}})

    # Learn this pattern for machine learning feedback loops
    try:
        await learn_transaction_match(txn.get("description", ""), payload.matched_type, payload.matched_id, payload.matched_label)
    except Exception:
        pass

    # Auto-match other similar transactions across the system
    try:
        await auto_match_similar_transactions(
            txn.get("company_id", ""), txn.get("description", ""),
            payload.matched_type, payload.matched_id, payload.matched_label,
            payload.post_journal, current_user.id
        )
    except Exception as e:
        import logging
        logging.error(f"Error in auto-matching similar transactions: {e}")

    await _log_recon_audit(
        txn, "matched", current_user,
        new_match={"type": payload.matched_type, "id": payload.matched_id, "label": payload.matched_label},
        confidence=payload.confidence, reason=payload.reason,
    )
    return {"success": True}


@router.post("/bank-transactions/{txn_id}/edit-match")
async def edit_match_transaction(txn_id: str, payload: ManualMatchInput, current_user: User = Depends(get_current_user)):
    """Atomically replaces an existing match: reverses the previous
    reconciliation's ledger/status effects, then applies the new one. Refuses
    to 're-edit' onto the exact same record (duplicate reconciliation)."""
    if not _perm_match_bank(current_user):
        raise HTTPException(403, "Access denied. Editing a match requires Match permission — request access from your admin.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    if not txn.get("matched_type"):
        raise HTTPException(400, "This transaction isn't matched yet — use Match instead of Edit Match.")
    if txn.get("matched_type") == payload.matched_type and txn.get("matched_id") == payload.matched_id:
        raise HTTPException(400, "This transaction is already matched to that record.")

    if payload.post_journal and payload.matched_type in ("sale", "purchase"):
        other_txn_id = await _already_settled_by_other_txn(payload.matched_type, payload.matched_id, txn_id)
        if other_txn_id:
            kind = "invoice" if payload.matched_type == "sale" else "bill"
            raise HTTPException(
                409,
                f"That {kind} is already marked Paid — it was settled by a different bank "
                f"transaction (id {other_txn_id}). Re-matching this transaction to it too would "
                f"post a second receipt for money that was only received once. If this really "
                f"is a separate payment, match it to the correct invoice/bill instead; if it's "
                f"a duplicate bank line, ignore or delete this transaction.",
            )

    previous_match = {"type": txn.get("matched_type"), "id": txn.get("matched_id"), "label": txn.get("matched_label")}
    await _revert_match_effects(txn)

    update = {"matched_type": payload.matched_type, "matched_id": payload.matched_id, "matched_label": payload.matched_label,
              "journal_entry_id": None, "prev_match_status": None}
    # txn still carries the OLD journal_entry_id/matched_* in memory — clear
    # them before re-posting so _auto_post_for_match snapshots the record's
    # freshly-reverted status, not the stale one.
    txn["journal_entry_id"] = None
    if payload.post_journal:
        entry_id = await _auto_post_for_match(
            txn.get("company_id", ""), txn,
            {"type": payload.matched_type, "id": payload.matched_id, "label": payload.matched_label}, current_user.id,
        )
        update["prev_match_status"] = txn.get("prev_match_status")
        if entry_id:
            update["journal_entry_id"] = entry_id
    await db.bank_transactions.update_one({"id": txn_id}, {"$set": update, "$unset": {"suggested_match": ""}})

    # Learn this pattern for machine learning feedback loops
    try:
        await learn_transaction_match(txn.get("description", ""), payload.matched_type, payload.matched_id, payload.matched_label)
    except Exception:
        pass

    # Auto-match other similar transactions across the system
    try:
        await auto_match_similar_transactions(
            txn.get("company_id", ""), txn.get("description", ""),
            payload.matched_type, payload.matched_id, payload.matched_label,
            payload.post_journal, current_user.id
        )
    except Exception as e:
        import logging
        logging.error(f"Error in auto-matching similar transactions in edit-match: {e}")

    new_match = {"type": payload.matched_type, "id": payload.matched_id, "label": payload.matched_label}
    await _log_recon_audit(
        txn, "edited", current_user, previous_match=previous_match, new_match=new_match,
        confidence=payload.confidence, reason=payload.reason,
    )
    return {"success": True}


@router.post("/bank-transactions/{txn_id}/unmatch")
async def unmatch_transaction(txn_id: str, payload: UnmatchInput = UnmatchInput(), current_user: User = Depends(get_current_user)):
    if not _perm_match_bank(current_user):
        raise HTTPException(403, "Access denied. Unmatching requires Match permission — request access from your admin.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    if not txn.get("matched_type"):
        raise HTTPException(400, "This transaction isn't matched.")

    previous_match = {"type": txn.get("matched_type"), "id": txn.get("matched_id"), "label": txn.get("matched_label")}
    await _revert_match_effects(txn)
    await db.bank_transactions.update_one(
        {"id": txn_id},
        {"$set": {"matched_type": None, "matched_id": None, "matched_label": None, "journal_entry_id": None, "prev_match_status": None}}
    )
    await _log_recon_audit(txn, "unmatched", current_user, previous_match=previous_match, reason=payload.reason)
    return {"success": True}



@router.post("/bank-transactions/{txn_id}/ignore")
async def ignore_transaction(txn_id: str, payload: IgnoreInput = IgnoreInput(), current_user: User = Depends(get_current_user)):
    """Marks an unmatched transaction as ignored (e.g. an internal transfer or
    bank charge that will never have an invoice) so it stops showing up in
    the Unmatched queue. Persisted — unlike a client-side-only flag, it
    survives a page reload. Does not touch matched_type/matched_id, so an
    ignored transaction can still be matched later if that changes."""
    if not _perm_match_bank(current_user):
        raise HTTPException(403, "Access denied. Ignoring a transaction requires Match permission — request access from your admin.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    await db.bank_transactions.update_one({"id": txn_id}, {"$set": {"ignored": bool(payload.ignored)}})
    return {"success": True, "ignored": bool(payload.ignored)}


@router.post("/bank-transactions/{txn_id}/reject-suggestion")
async def reject_suggestion(txn_id: str, current_user: User = Depends(get_current_user)):
    """Rejects/dismisses a suggested match on an unmatched bank transaction."""
    if not _perm_match_bank(current_user):
        raise HTTPException(403, "Access denied. Rejecting a suggestion requires Match permission.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    await db.bank_transactions.update_one({"id": txn_id}, {"$unset": {"suggested_match": ""}})
    return {"success": True}


@router.delete("/bank-transactions/{txn_id}")
async def delete_transaction(txn_id: str, current_user: User = Depends(get_current_user)):
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if txn and txn.get("journal_entry_id"):
        await db.journal_lines.delete_many({"entry_id": txn["journal_entry_id"]})
        await db.journal_entries.delete_one({"id": txn["journal_entry_id"]})
    result = await db.bank_transactions.delete_one({"id": txn_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Bank transaction not found.")
    return {"success": True}


# ═══════════════════════════════════════════════════════════
# PHASE 8 – BANK INTELLIGENCE & AUTO RECONCILIATION ROUTER
# ═══════════════════════════════════════════════════════════



@router.post("/bank-accounts/{bank_account_id}/process-statement")
async def process_statement_intelligence(
    bank_account_id: str,
    company_id: str = Form(""),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    """
    Autonomous Statement processing pipeline (Phase 8).
    Extracts, classifies, matches, posts journals and calculates statistics.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    file_bytes = await file.read()
    if len(file_bytes) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds maximum size limits.")

    from backend.bank_ai.bank_engine import BankIntelligenceEngine
    try:
        res = await BankIntelligenceEngine.process_bank_statement(
            file_bytes=file_bytes,
            filename=file.filename or "statement",
            bank_account_id=bank_account_id,
            company_id=company_id,
            user_id=current_user.id
        )
        return res
    except Exception as e:
        raise HTTPException(500, f"Autonomous processing pipeline failed: {e}")


@router.get("/bank-accounts/{bank_account_id}/statistics")
async def get_bank_account_statistics(bank_account_id: str, current_user: User = Depends(get_current_user)):
    """
    Retrieves aggregated reconciliation rates and cash inflows/outflows volumes.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.bank_statistics import BankStatistics
    stats = await BankStatistics.compute_and_save(bank_account_id)
    return stats


@router.get("/bank-accounts/{bank_account_id}/cashflow")
async def get_cashflow_projections(bank_account_id: str, company_id: str = "", current_user: User = Depends(get_current_user)):
    """
    Retrieves 30-60-90 days cash flow projections and historical daily trends.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.cashflow_engine import CashflowEngine
    projections = await CashflowEngine.analyse_and_project(bank_account_id, company_id)
    return projections


@router.get("/bank-accounts/rules")
async def list_active_routing_rules(current_user: User = Depends(get_current_user)):
    """
    Exposes configured bank rules.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.bank_rules import BankRulesManager
    rules = await BankRulesManager.get_all_rules()
    return rules


@router.post("/bank-accounts/rules")
async def create_routing_rule(payload: BankRulePayload, current_user: User = Depends(get_current_user)):
    """
    Adds a new ledger routing rule for automated matching.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.bank_rules import BankRulesManager
    rule_id = await BankRulesManager.create_rule(
        name=payload.name,
        pattern=payload.pattern,
        category=payload.category,
        account_id=payload.account_id,
        account_name=payload.account_name,
        priority=payload.priority
    )
    return {"success": True, "rule_id": rule_id}


@router.delete("/bank-accounts/rules/{rule_id}")
async def delete_routing_rule(rule_id: str, current_user: User = Depends(get_current_user)):
    """
    Deactivates a custom matching rule.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.bank_rules import BankRulesManager
    success = await BankRulesManager.delete_rule(rule_id)
    if not success:
        raise HTTPException(404, "Rule not found or could not be deactivated.")
    return {"success": True}


@router.post("/bank-transactions/{txn_id}/manual-reconcile")
async def manual_reconcile_transaction_api(
    txn_id: str,
    payload: ManualReconcilePayload,
    current_user: User = Depends(get_current_user)
):
    """
    Triggers manual reconciliation, posting necessary ledger updates and ML feedback.

    NOTE: this used to delegate to backend.bank_ai.reconciliation_engine.
    ReconciliationEngine.manual_reconcile, a legacy module that (a) looked the
    transaction up in `bank_transaction_history` — a collection nothing in the
    live app writes to, so real transactions were never found — and (b) when it
    did post, set invoice.status="paid" without updating amount_paid/amount_due
    and tagged the journal entry with a source the invoice-sync engine doesn't
    recognize as "already settled." That caused the sync job to later post a
    SECOND Dr Bank / Cr Accounts Receivable entry for the same receipt, which
    Verify & Fix could never repair (it can only rebuild entries it created
    itself). This now posts through the same guarded, single write path
    (_auto_post_for_match) that /bank-accounts/run-ai-auto-match already uses,
    so there is exactly one journal entry per receipt and the invoice's
    amount_paid/amount_due/status stay in sync with it.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")

    txn = await db.bank_transactions.find_one({"id": txn_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Transaction not found.")

    company_id = payload.company_id or txn.get("company_id", "")
    match: Optional[dict] = None
    matched_label = None

    if payload.matched_record_type == "invoice" and payload.matched_record_id:
        inv = await db.invoices.find_one({"id": payload.matched_record_id}, {"_id": 0})
        if not inv:
            raise HTTPException(404, "Matched invoice not found.")
        matched_label = f"Invoice #{inv.get('invoice_no', '')} - {inv.get('client_name', '')}"
        match = {
            "type": "sale", "id": inv["id"],
            "label": inv.get("client_name") or inv.get("invoice_no") or "Sale invoice",
            "grand_total": float(inv.get("grand_total") or 0),
        }
    elif payload.matched_record_type in ("bill", "purchase") and payload.matched_record_id:
        bill = await db.purchase_invoices.find_one({"id": payload.matched_record_id}, {"_id": 0})
        if not bill:
            raise HTTPException(404, "Matched purchase bill not found.")
        matched_label = f"Bill #{bill.get('invoice_no', '')} - {bill.get('supplier_name', '')}"
        match = {
            "type": "purchase", "id": bill["id"],
            "label": bill.get("supplier_name") or bill.get("invoice_no") or "Purchase invoice",
            "grand_total": float(bill.get("grand_total") or 0),
        }
    elif payload.coa_account_id:
        acct = await db.chart_of_accounts.find_one({"id": payload.coa_account_id}, {"_id": 0})
        if not acct:
            raise HTTPException(404, "Ledger account not found.")
        acct_type = acct.get("type") if acct.get("type") in (
            "expense", "suspense", "asset", "liability", "revenue"
        ) else "expense"
        matched_label = acct.get("name", "Account")
        match = {"type": acct_type, "id": acct["id"], "label": acct.get("name", "Account"), "company_id": company_id}
    else:
        raise HTTPException(400, "Provide either matched_record_id/matched_record_type or coa_account_id.")

    entry_id = await _auto_post_for_match(company_id, txn, match, current_user.id)
    if not entry_id:
        raise HTTPException(
            409,
            "Could not post this match — the invoice/bill may already be settled by a "
            "different bank transaction. Check Bank Accounts \u2192 unmatched transactions."
        )

    await db.bank_transactions.update_one(
        {"id": txn_id},
        {"$set": {
            "matched_type": match["type"], "matched_id": match["id"],
            "matched_label": matched_label, "journal_entry_id": entry_id,
            "pending_approval": False,
        }},
    )

    # Reinforcement learning feedback — unchanged behavior from before.
    if payload.category and txn.get("description"):
        import re as _re
        pattern = _re.sub(r"\d+", "", txn.get("description", "")).strip()[:30]
        if len(pattern) > 5:
            from backend.bank_ai.bank_storage import BankStorage
            await BankStorage.update_reinforcement_feedback(pattern, payload.category, +1)

    return {"status": "success", "message": "Transaction reconciled.", "journal_entry_id": entry_id}


@router.get("/bank-transactions/{txn_id}/audit-trail")
async def get_reconciliation_audit_trail_api(txn_id: str, current_user: User = Depends(get_current_user)):
    """
    Exposes auditable matching factors and confidence reasons for reconciliation choices.
    """
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied.")
    
    from backend.bank_ai.reconciliation_audit import ReconciliationAudit
    audit = await ReconciliationAudit.get_audit_trail(txn_id)
    return audit



@router.post("/bank-transactions/backfill-unmatched-to-suspense")
async def backfill_unmatched_to_suspense(
    payload: Optional[BackfillSuspenseInput] = None, current_user: User = Depends(get_current_user),
):
    """One-time fix-up for statement lines imported *before* upload_statement
    started auto-parking unmatched lines to Suspense: every bank transaction
    still sitting with matched_type=None (and not explicitly ignored) never
    posted a journal entry, so the GL "Bank Accounts" balance has been
    silently understating/overstating the real bank balance ever since —
    and, for unmatched receipts, Accounts Receivable has stayed overstated
    because the ledger was never told the money arrived. This finds every
    such line (optionally scoped to one company) and parks each one to
    Suspense (9998) exactly like a manual "Park to Suspense" match, so
    Trial Balance / Balance Sheet / the Bank & Cash dashboard card start
    agreeing with the real statement again. Safe to re-run — only rows
    still unmatched are touched."""
    if not _perm_view_bank(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")

    q: dict = {"matched_type": {"$in": [None, ""]}, "ignored": {"$ne": True}}
    if payload and payload.company_id:
        q["company_id"] = payload.company_id
    unmatched = await db.bank_transactions.find(q, {"_id": 0}).to_list(200000)

    parked, skipped = 0, 0
    for txn in unmatched:
        company_id = txn.get("company_id", "")
        suspense_id = await get_default_account_id(company_id, "9998")
        if not suspense_id:
            skipped += 1
            continue
        match = {"type": "suspense", "id": suspense_id, "label": "Unclassified (auto-parked)"}
        entry_id = await _auto_post_for_match(company_id, txn, match, current_user.id)
        if not entry_id:
            skipped += 1
            continue
        await db.bank_transactions.update_one(
            {"id": txn["id"]},
            {"$set": {
                "matched_type": "suspense", "matched_id": suspense_id,
                "matched_label": "Unclassified (auto-parked)",
                "journal_entry_id": entry_id, "auto_suspensed": True,
            }},
        )
        parked += 1

    return {"success": True, "scanned": len(unmatched), "parked_to_suspense": parked, "skipped": skipped}
