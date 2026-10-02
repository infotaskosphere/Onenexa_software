"""
GST Reconciliation Module  [ENHANCED v2]
=========================================
Extends v1 with:
  - Multi-key + fuzzy matching layer
  - AI insights: mismatch detection, ITC eligibility, correction suggestions
  - Vendor risk scoring (non-filer, irregular patterns)
  - GSTR-3B vs 2B reconciliation endpoint
  - ITC reversal tracking
  - Audit logging (every action)
  - Duplicate invoice detection
  - Amendment tracking
  - Dashboard summary endpoint
  - Configurable tolerance & fuzzy threshold per request

Backward compatible: all v1 endpoints/keys preserved.
"""

import io, re, uuid, logging, difflib
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from zoneinfo import ZoneInfo

import pandas as pd
import numpy as np
from fastapi import (
    APIRouter, Depends, HTTPException, UploadFile, File,
    Form, Query, BackgroundTasks,
)
from pydantic import BaseModel, Field, ConfigDict

from backend.dependencies import db, get_current_user, build_client_query
from backend.modules.finix_ai.reconciliation.models_gst import ReconciliationSession, SessionSaveBody, GSTR3BBody, ITCReversalBody, VendorCommunicationBody, GSTINBatchBody, TradeNameBody, TradeNamesBatchBody, SessionUpdateBody, AIInsightBody

from backend.models import User
from backend.platform_owner import is_platform_owner

logger   = logging.getLogger(__name__)
router   = APIRouter(prefix="/gst-reconciliation", tags=["gst-reconciliation"])
IST      = ZoneInfo("Asia/Kolkata")
TOLERANCE = 1.01   # ₹ default tolerance

# ─── HELPERS (v1 preserved) ──────────────────────────────────────────────────

def _now():
    return datetime.now(IST)

def _to_str(val):
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return ""
    return str(val).strip()

def _to_num(val):
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return 0.0
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0

def _normalise_invoice(val):
    """Normalise invoice number to canonical serial for matching (v2 — mirrors frontend logic).

    Strategy:
    1. Strip common software prefixes (INV-, BILL-, PO-, GST-, etc.)
    2. Split by / - . # separators into numeric parts
    3. Remove noise parts: months (1-12), 2-digit FY (13-35), 4-digit years (2000-2035)
    4. Among remaining candidates, pick the LONGEST (most digits = most specific serial)
    5. Ties → last wins
    6. Fallback: extract trailing numeric block from alphanumeric string

    Examples:
      "4930"             → "4930"    (pure numeric)
      "DB-T/4930"        → "4930"    (complex prefix)
      "T/0004930/26"     → "4930"    (FY suffix discarded)
      "GST/24-25/4930"   → "4930"    (FY range discarded)
      "INV-2024-001234"  → "1234"    (year discarded, serial wins)
      "12/0033902"       → "33902"   (month prefix discarded)
      "001/2026"         → "1"       (year discarded)
      "T1326"            → "1326"    (alpha attached)
      "INV/1234"         → "1234"    (simple prefix/serial)
    """
    import re as _re
    s = _to_str(val).upper().replace(" ", "")
    if not s:
        return ""
    if s.isdigit():
        return s.lstrip("0") or "0"

    # Strip common accounting software prefixes before splitting
    cleaned = _re.sub(
        r'^(INV|INVOICE|BILL|PO|TAX|GST|B2B|PURCHASE|PUR|RCV|RCPT|RECEIPT|VCH|VOUCHER|DR|CR|DN|CN)[/\-#]*',
        '', s
    )
    if cleaned.isdigit():
        return cleaned.lstrip("0") or "0"

    parts = _re.split(r'[/\-\.#]', s)
    numeric_parts = [p for p in parts if p.isdigit()]

    if not numeric_parts:
        # Try to extract trailing digits e.g. "T1326" → "1326"
        m = _re.search(r'(\d{3,})$', s)
        if m:
            return m.group(1).lstrip("0") or "0"
        m2 = _re.match(r'^[A-Z]+(\d+)$', s)
        if m2:
            return m2.group(1).lstrip("0") or "0"
        return s

    if len(numeric_parts) == 1:
        return numeric_parts[0].lstrip("0") or "0"

    def _is_noise(p):
        v = int(p)
        l = len(p)
        if l <= 2 and 1 <= v <= 12:   return True   # month
        if l <= 2 and 13 <= v <= 35:  return True   # 2-digit FY
        if l == 4 and 2000 <= v <= 2035: return True # 4-digit year
        return False

    serials = [p for p in numeric_parts if not _is_noise(p)]
    pool = serials if serials else numeric_parts

    # Longest stripped serial wins; rightmost on ties
    best = max(pool, key=lambda p: len(p.lstrip("0") or "0"))
    return best.lstrip("0") or "0"

def _normalise_gstin(val):
    return _to_str(val).upper()

def _find_header_row(df_raw):
    for i in range(min(15, len(df_raw))):
        for c in range(min(5, len(df_raw.columns))):
            cell = _to_str(df_raw.iloc[i, c]).lower()
            if "gstin" in cell and ("supplier" in cell or cell[:5] == "gstin"):
                return i
    return -1

# ─── SMART TOLERANCE & DATE NORMALISATION ───────────────────────────────────

def _smart_tolerance(v1: float, v2: float = 0.0) -> float:
    """Max of ₹1.01 floor and 0.1% of the larger value — prevents false
    mismatches on large invoices caused by ERP rounding differences."""
    return max(TOLERANCE, max(abs(v1), abs(v2), 1.0) * 0.001)

_DATE_FMTS = ["%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%y", "%d-%m-%y"]

def _normalise_date(raw: str) -> str:
    """Convert various Indian date formats to ISO YYYY-MM-DD for comparison."""
    s = _to_str(raw).strip()
    if not s or s in ("0", "nan"):
        return ""
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return s   # return as-is if unrecognised

# ─── FUZZY MATCHING ──────────────────────────────────────────────────────────

def _fuzzy_similarity(a, b):
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()

def _fuzzy_invoice_match(inv_a, inv_b, threshold=0.80):
    if inv_a == inv_b:
        return True
    return _fuzzy_similarity(inv_a, inv_b) >= threshold

def _levenshtein(a: str, b: str) -> int:
    """Character edit distance — used for near-GSTIN typo detection."""
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    dp = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        prev, dp[0] = dp[0], i + 1
        for j, cb in enumerate(b):
            prev, dp[j+1] = dp[j+1], prev if ca == cb else min(prev, dp[j], dp[j+1]) + 1
    return dp[len(b)]

# ─── AI INSIGHTS / RULE ENGINE ───────────────────────────────────────────────

def _detect_mismatch_reason(portal: dict, books: dict, tolerance: float = TOLERANCE) -> str:
    """Human-readable mismatch diagnosis + suggested action."""
    tol      = _smart_tolerance(portal.get("invoice_value", 0), books.get("invoice_value", 0))
    val_diff = portal.get("invoice_value", 0) - books.get("invoice_value", 0)
    tax_p    = portal.get("igst",0)+portal.get("cgst",0)+portal.get("sgst",0)
    tax_b    = books.get("igst",0)+books.get("cgst",0)+books.get("sgst",0)
    tax_diff = abs(tax_p - tax_b)
    p_inv    = max(portal.get("invoice_value", 1), 1)
    p_rate   = tax_p / p_inv * 100
    b_inv    = max(books.get("invoice_value",  1), 1)
    b_rate   = tax_b / b_inv * 100

    if abs(val_diff) < tol and tax_diff < tol:
        pd = _normalise_date(portal.get("invoice_date",""))
        bd = _normalise_date(books.get("invoice_date",""))
        if pd and bd and pd != bd:
            return f"Date mismatch: portal {pd} vs books {bd}. Verify original invoice date."
        return "Minor rounding difference — likely safe to accept."

    if abs(p_rate - b_rate) > 1.5:
        return (f"GST rate differs: portal ~{p_rate:.0f}% vs books ~{b_rate:.0f}%. "
                "Check HSN/SAC and correct tax rate in books.")

    if abs(val_diff) > tol and tax_diff < tol:
        return (f"Invoice value differs by Rs.{abs(val_diff):.2f} but tax matches. "
                "Possible GST-exclusive vs GST-inclusive entry difference.")

    if val_diff > tol:
        return (f"Portal value Rs.{abs(val_diff):.2f} higher than books. "
                "Supplier may have filed amended invoice — update books or request GSTR-1 amendment.")
    if val_diff < -tol:
        return (f"Books value Rs.{abs(val_diff):.2f} higher than portal. "
                "Vendor may have understated — request credit note or amendment.")

    reasons = []
    if abs(val_diff) > tol:
        reasons.append(f"value diff Rs.{round(abs(val_diff),2)}")
    if tax_diff > tol:
        reasons.append(f"tax diff Rs.{round(tax_diff,2)}")
    pos_p = _to_str(portal.get("place_of_supply",""))
    pos_b = _to_str(books.get("place_of_supply",""))
    if pos_p and pos_b and pos_p != pos_b:
        reasons.append(f"place of supply ({pos_p} vs {pos_b})")
    return ("Multiple mismatches: " + "; ".join(reasons)) if reasons else "Other discrepancy"

def _itc_eligibility(record):
    itc_avail = _to_str(record.get("itc_availability", "")).upper()
    rc        = _to_str(record.get("reverse_charge",   "")).upper()
    inv_type  = _to_str(record.get("invoice_type",     "")).upper()
    if itc_avail in ("INELIGIBLE", "N", "NO"):
        return {"eligible": False, "reason": "Marked ineligible in GSTR-2B"}
    if rc in ("Y", "YES"):
        return {"eligible": True, "reason": "RCM - ITC claimable after payment"}
    if inv_type in ("IMPG", "IMPGSEZ"):
        return {"eligible": True, "reason": "Import of goods - ITC eligible"}
    igst = record.get("igst", 0)
    cgst = record.get("cgst", 0)
    sgst = record.get("sgst", 0)
    total = igst + cgst + sgst
    if total == 0:
        return {"eligible": False, "reason": "Zero tax - no ITC to claim"}
    return {"eligible": True, "reason": "Eligible per GSTR-2B",
            "itc_igst": igst, "itc_cgst": cgst, "itc_sgst": sgst,
            "itc_total": round(total, 2)}

def _suggest_correction(portal, books):
    val_diff = portal.get("invoice_value", 0) - books.get("invoice_value", 0)
    tax_diff = ((portal.get("igst",0)+portal.get("cgst",0)+portal.get("sgst",0)) -
                (books.get("igst",0) +books.get("cgst",0) +books.get("sgst",0)))
    if abs(val_diff) < 5 and abs(tax_diff) < 2:
        return "Minor rounding difference - verify original invoice; likely safe to accept."
    if val_diff > 0:
        return "Portal value higher - check if supplier filed amended invoice. Update books if confirmed."
    if val_diff < 0:
        return "Books value higher - supplier may have understated; request credit note/amendment."
    return "Review invoice with vendor and request GSTR-1 amendment if needed."

# ─── VENDOR RISK SCORING (NEW) ───────────────────────────────────────────────

def _compute_vendor_risk(vendor_invoices):
    flags = []
    score = 0
    total      = len(vendor_invoices)
    mismatched = sum(1 for i in vendor_invoices if i.get("status") == "mismatch")
    p_only     = sum(1 for i in vendor_invoices if i.get("status") == "missing_in_books")
    b_only     = sum(1 for i in vendor_invoices if i.get("status") == "missing_in_gst")
    if total == 0:
        return {"risk_score": 0, "risk_level": "low", "flags": []}
    if mismatched / total > 0.5:
        score += 40; flags.append("High mismatch rate (>50%)")
    elif mismatched / total > 0.2:
        score += 20; flags.append("Moderate mismatch rate (>20%)")
    if p_only > 0:
        score += 20; flags.append(f"{p_only} portal-only invoice(s) - possible ghost invoices")
    if b_only > 2:
        score += 25; flags.append(f"{b_only} book-only invoice(s) - vendor may be non-filer")
    if b_only / total > 0.3:
        score += 15; flags.append("Irregular filing pattern detected")
    level = "low" if score < 30 else ("medium" if score < 60 else "high")
    return {"risk_score": min(score,100), "risk_level": level, "flags": flags,
            "total_invoices": total, "mismatched": mismatched,
            "portal_only": p_only, "books_only": b_only}

# ─── PARSE BOOKS (v1 preserved + duplicate flag) ──────────────────────────────

def _parse_books(file_bytes, filename):
    ext    = filename.rsplit(".", 1)[-1].lower()
    engine = "xlrd" if ext == "xls" else "openpyxl"
    try:
        xl = pd.ExcelFile(io.BytesIO(file_bytes), engine=engine)
    except Exception as exc:
        raise HTTPException(400, f"Cannot open Books file: {exc}")

    sheet = next((s for s in xl.sheet_names if s.strip().lower() == "b2b"), None) or xl.sheet_names[0]
    logger.info("Books: using sheet '%s'", sheet)

    raw        = pd.read_excel(xl, sheet_name=sheet, header=None, dtype=str)
    header_idx = _find_header_row(raw)
    if header_idx == -1:
        header_idx = 2

    df = pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet,
                       engine=engine, header=header_idx, dtype=str)
    df.columns = [_to_str(c).lower().strip() for c in df.columns]

    def _col(*keys):
        for k in keys:
            for col in df.columns:
                if k.lower() in col:
                    return col
        return None

    gstin_col  = _col("gstin of supplier", "gstin")
    inv_no_col = _col("invoice number", "invoice no")
    date_col   = _col("invoice date", "date")
    val_col    = _col("invoice value")
    tax_col    = _col("taxable value")
    igst_col   = _col("integrated tax paid", "integrated tax")
    cgst_col   = _col("central tax paid", "central tax")
    sgst_col   = _col("state/ut tax paid", "state/ut tax", "state tax")
    cess_col   = _col("cess paid", "cess")
    pos_col    = _col("place of supply", "place")
    rc_col     = _col("reverse charge")
    type_col   = _col("invoice type", "type")
    rate_col   = _col("rate")
    hsn_col    = _col("hsn", "hsn/sac", "hsn code", "hsncode", "hsn_sac")

    if gstin_col is None or inv_no_col is None:
        raise HTTPException(400, "Books file: could not locate 'GSTIN of Supplier' or 'Invoice Number' columns.")

    records   = []
    seen_keys = set()
    for _, row in df.iterrows():
        gstin  = _normalise_gstin(row.get(gstin_col, ""))
        inv_no = _normalise_invoice(row.get(inv_no_col, ""))
        if not gstin or not inv_no or len(gstin) < 10:
            continue
        if gstin in ("GSTIN OF SUPPLIER",):
            continue
        dup_key       = f"{gstin}__{inv_no}"
        is_duplicate  = dup_key in seen_keys
        seen_keys.add(dup_key)
        records.append({
            "gstin":           gstin,
            "invoice_no":      inv_no,
            "invoice_no_raw":  _to_str(row.get(inv_no_col, "")),
            "invoice_date":    _to_str(row.get(date_col,  "")) if date_col else "",
            "invoice_value":   _to_num(row.get(val_col,   0))  if val_col  else 0.0,
            "taxable_value":   _to_num(row.get(tax_col,   0))  if tax_col  else 0.0,
            "igst":            _to_num(row.get(igst_col,  0))  if igst_col else 0.0,
            "cgst":            _to_num(row.get(cgst_col,  0))  if cgst_col else 0.0,
            "sgst":            _to_num(row.get(sgst_col,  0))  if sgst_col else 0.0,
            "cess":            _to_num(row.get(cess_col,  0))  if cess_col else 0.0,
            "place_of_supply": _to_str(row.get(pos_col,  ""))  if pos_col  else "",
            "reverse_charge":  _to_str(row.get(rc_col,   ""))  if rc_col   else "",
            "invoice_type":    _to_str(row.get(type_col, ""))  if type_col else "",
            "rate":            _to_num(row.get(rate_col,  0))  if rate_col else 0.0,
            "hsn":             _to_str(row.get(hsn_col,  "")) if hsn_col  else "",
            "trade_name":      "", "itc_availability": "", "filing_date": "",
            "source":          "books",
            "is_duplicate":    is_duplicate,
        })
    logger.info("Books: parsed %d invoices (%d duplicates)", len(records), sum(1 for r in records if r["is_duplicate"]))
    return pd.DataFrame(records)

# ─── PORTAL METADATA EXTRACTION ─────────────────────────────────────────────

_MONTHS_MAP = {
    "january":1,"february":2,"march":3,"april":4,"may":5,"june":6,
    "july":7,"august":8,"september":9,"october":10,"november":11,"december":12,
    "jan":1,"feb":2,"mar":3,"apr":4,"jun":6,"jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12,
}
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")

def _fmt_period(mm: int, yyyy: str) -> str:
    names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    return f"{names[mm-1]}-{yyyy[2:]}"

def _parse_period_str(raw: str) -> str:
    """Convert raw period text → 'Mon-YY' format.  Returns '' if unrecognised."""
    s = raw.strip()
    # Numeric: "102024" or "01 2025"
    m = re.match(r"^(0[1-9]|1[0-2])\s*(\d{4})$", s)
    if m:
        return _fmt_period(int(m.group(1)), m.group(2))
    # Named: "October 2024", "Oct-24", "oct 2024"
    m = re.match(r"([a-zA-Z]+)[^a-zA-Z0-9]*(\d{4})", s)
    if m:
        mon = _MONTHS_MAP.get(m.group(1).lower()[:9])
        if mon:
            return _fmt_period(mon, m.group(2))
    return s or ""

def _extract_portal_metadata(file_bytes: bytes, filename: str) -> Dict[str, str]:
    """Scan the pre-header rows of a GSTR-2B Excel to extract:
        period, taxpayer_gstin, trade_name
    Returns a dict with those keys (empty string if not found)."""
    ext    = filename.rsplit(".", 1)[-1].lower()
    engine = "xlrd" if ext == "xls" else "openpyxl"
    try:
        xl  = pd.ExcelFile(io.BytesIO(file_bytes), engine=engine)
        sheet = next((s for s in xl.sheet_names if s.strip().upper() == "B2B"), None) or xl.sheet_names[0]
        raw = pd.read_excel(xl, sheet_name=sheet, header=None, dtype=str)
    except Exception:
        return {"period": "", "taxpayer_gstin": "", "trade_name": ""}

    period = ""; taxpayer_gstin = ""; trade_name = ""

    # Only scan up to row 13 (before the column header row)
    for i in range(min(13, len(raw))):
        for j in range(min(10, len(raw.columns))):
            cell = _to_str(raw.iloc[i, j])
            if not cell:
                continue
            lo = cell.lower()

            # GSTIN of taxpayer
            if not taxpayer_gstin:
                gm = re.search(r"gstin\s*[:\-]\s*([A-Z0-9]{15})", cell, re.I)
                if gm and _GSTIN_RE.match(gm.group(1).upper()):
                    taxpayer_gstin = gm.group(1).upper()
                elif _GSTIN_RE.match(cell.upper().replace(" ", "")):
                    # standalone GSTIN cell — check neighbour says "gstin"
                    prev = _to_str(raw.iloc[i, j-1]) if j > 0 else ""
                    if "gstin" in prev.lower() or i < 6:
                        taxpayer_gstin = cell.upper().replace(" ", "")

            # Return / Tax period
            if not period:
                if "return period" in lo or "tax period" in lo or "filing period" in lo:
                    pm = re.search(r"period\s*[:\-]\s*(.+)", cell, re.I)
                    if pm:
                        period = _parse_period_str(pm.group(1).strip())
                    elif j + 1 < len(raw.columns):
                        nxt = _to_str(raw.iloc[i, j+1])
                        if nxt:
                            period = _parse_period_str(nxt)
                # Standalone "period" label
                if not period and lo.startswith("period"):
                    pm = re.search(r"period\s*[:\-]\s*(.+)", cell, re.I)
                    if pm:
                        period = _parse_period_str(pm.group(1).strip())
                    elif j + 1 < len(raw.columns):
                        nxt = _to_str(raw.iloc[i, j+1])
                        if nxt:
                            period = _parse_period_str(nxt)
                # Raw 6-digit e.g. "102024"
                if not period and re.match(r"^(0[1-9]|1[0-2])\d{4}$", cell):
                    period = _parse_period_str(cell)

            # Trade / legal name
            if not trade_name:
                if "trade name" in lo or "legal name" in lo or "trade/legal" in lo:
                    nm = re.search(r"(?:trade|legal)\s*(?:name)?\s*[:\-]\s*(.+)", cell, re.I)
                    if nm and len(nm.group(1).strip()) > 1:
                        trade_name = nm.group(1).strip()
                    elif j + 1 < len(raw.columns):
                        nxt = _to_str(raw.iloc[i, j+1])
                        if nxt and len(nxt) > 1 and not _GSTIN_RE.match(nxt.upper()):
                            trade_name = nxt

        if period and taxpayer_gstin and trade_name:
            break

    return {"period": period, "taxpayer_gstin": taxpayer_gstin, "trade_name": trade_name}


@router.post("/extract-metadata")
async def extract_portal_metadata(
    portal_file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Extract period, taxpayer GSTIN, and trade name from a GSTR-2B Excel header.
    Used by the frontend to auto-populate the reconciliation form."""
    pb   = await portal_file.read()
    meta = _extract_portal_metadata(pb, portal_file.filename or "portal.xlsx")

    # If we got a GSTIN but no name, try a live lookup
    if meta["taxpayer_gstin"] and not meta["trade_name"]:
        try:
            info = await _scrape_gstin_name(meta["taxpayer_gstin"])
            meta["trade_name"] = info.get("trade_name") or info.get("legal_name") or ""
        except Exception:
            pass

    return {**meta, "filename": portal_file.filename or ""}


# ─── PARSE PORTAL (v1 preserved + duplicate + amendment flags) ───────────────

def _parse_portal(file_bytes, filename):
    ext    = filename.rsplit(".", 1)[-1].lower()
    engine = "xlrd" if ext == "xls" else "openpyxl"
    try:
        xl = pd.ExcelFile(io.BytesIO(file_bytes), engine=engine)
    except Exception as exc:
        raise HTTPException(400, f"Cannot open GST Portal file: {exc}")

    sheet = next((s for s in xl.sheet_names if s.strip().upper() == "B2B"), None) or xl.sheet_names[0]
    logger.info("Portal: using sheet '%s'", sheet)
    raw = pd.read_excel(xl, sheet_name=sheet, header=None, dtype=str)

    upper_idx = -1
    for i in range(min(15, len(raw))):
        cell = _to_str(raw.iloc[i, 0]).lower()
        if "gstin" in cell and "supplier" in cell:
            upper_idx = i; break
    if upper_idx == -1:
        upper_idx = 4
    sub_idx  = upper_idx + 1
    data_idx = upper_idx + 2

    upper_row = [_to_str(raw.iloc[upper_idx, c]) if c < len(raw.columns) else "" for c in range(len(raw.columns))]
    sub_row   = [_to_str(raw.iloc[sub_idx,   c]) if c < len(raw.columns) else "" for c in range(len(raw.columns))]
    combined  = [sub if sub else up for sub, up in zip(sub_row, upper_row)]

    COL_GSTIN=0; COL_NAME=1; COL_INVNO=2; COL_TYPE=3; COL_DATE=4
    COL_VALUE=5; COL_POS=6;  COL_RC=7;   COL_TAXABLE=8
    COL_IGST=9;  COL_CGST=10; COL_SGST=11; COL_CESS=12

    def _named_col(*keys):
        for k in keys:
            for idx, h in enumerate(combined):
                if k.lower() in h.lower():
                    return idx
        return None

    inv_no_idx  = _named_col("invoice number","invoice no") or COL_INVNO
    date_idx    = _named_col("invoice date")                or COL_DATE
    val_idx     = _named_col("invoice value")               or COL_VALUE
    pos_idx     = _named_col("place of supply")             or COL_POS
    rc_idx      = _named_col("reverse charge","supply attract") or COL_RC
    taxable_idx = _named_col("taxable value")               or COL_TAXABLE
    igst_idx    = _named_col("integrated tax")              or COL_IGST
    cgst_idx    = _named_col("central tax")                 or COL_CGST
    sgst_idx    = _named_col("state/ut tax","state tax")    or COL_SGST
    cess_idx    = _named_col("cess")                        or COL_CESS
    itc_idx     = _named_col("itc availability","itc avail")
    filing_idx  = _named_col("filing date","gstr-1/1a/iff")
    amend_idx   = _named_col("amendment","amended")   # NEW

    records   = []
    seen_keys = set()
    for i in range(data_idx, len(raw)):
        row = raw.iloc[i]
        def _cell(idx):
            if idx is None or idx >= len(row): return ""
            v = row.iloc[idx]
            if v is None or (isinstance(v, float) and np.isnan(v)): return ""
            return str(v).strip()
        gstin  = _normalise_gstin(_cell(COL_GSTIN))
        inv_no = _normalise_invoice(_cell(inv_no_idx))
        if not gstin or not inv_no or len(gstin) < 10: continue
        if "GSTIN" in gstin.upper() and "SUPPLIER" in gstin.upper(): continue
        dup_key      = f"{gstin}__{inv_no}"
        is_duplicate = dup_key in seen_keys
        seen_keys.add(dup_key)
        records.append({
            "gstin":            gstin,
            "invoice_no":       inv_no,
            "invoice_no_raw":   _cell(inv_no_idx),
            "invoice_date":     _cell(date_idx),
            "invoice_value":    _to_num(_cell(val_idx)),
            "taxable_value":    _to_num(_cell(taxable_idx)),
            "igst":             _to_num(_cell(igst_idx)),
            "cgst":             _to_num(_cell(cgst_idx)),
            "sgst":             _to_num(_cell(sgst_idx)),
            "cess":             _to_num(_cell(cess_idx)),
            "place_of_supply":  _cell(pos_idx),
            "reverse_charge":   _cell(rc_idx),
            "invoice_type":     _cell(COL_TYPE),
            "rate":             0.0,
            "trade_name":       _cell(COL_NAME),
            "itc_availability": _cell(itc_idx)    if itc_idx    else "",
            "filing_date":      _cell(filing_idx) if filing_idx else "",
            "is_amended":       bool(_cell(amend_idx)) if amend_idx else False,  # NEW
            "source":           "portal",
            "is_duplicate":     is_duplicate,  # NEW
        })
    logger.info("Portal: parsed %d invoices (%d duplicates)", len(records), sum(1 for r in records if r["is_duplicate"]))
    return pd.DataFrame(records)

# ─── RECONCILIATION ENGINE (v2 — extends v1) ─────────────────────────────────

def _reconcile(portal_df, books_df, tolerance=TOLERANCE, fuzzy_threshold=0.80, enable_fuzzy=True):
    if portal_df.empty and books_df.empty:
        raise HTTPException(400, "Both files produced no parseable invoice data.")

    portal_records = portal_df.to_dict("records") if not portal_df.empty else []
    books_records  = books_df.to_dict("records")  if not books_df.empty else []

    portal_map = {}
    books_map  = {}
    for r in portal_records:
        portal_map.setdefault(f"{r['gstin']}__{r['invoice_no']}", r)
    for r in books_records:
        books_map.setdefault(f"{r['gstin']}__{r['invoice_no']}", r)

    # Fuzzy lookup: gstin → list of book records
    fuzzy_books: Dict[str, list] = {}
    if enable_fuzzy:
        for r in books_records:
            fuzzy_books.setdefault(r["gstin"], []).append(r)

    matched=[];  partial=[];  portal_only=[];  books_only=[];  fuzzy_matched=[]
    books_matched_keys = set()

    for key in set(portal_map) | set(books_map):
        in_portal = key in portal_map
        in_books  = key in books_map

        if in_portal and in_books:
            p = portal_map[key]; b = books_map[key]
            books_matched_keys.add(key)
            tol      = _smart_tolerance(p["invoice_value"], b["invoice_value"])
            val_diff = abs(p["invoice_value"] - b["invoice_value"])
            tax_diff = abs((p["igst"]+p["cgst"]+p["sgst"])-(b["igst"]+b["cgst"]+b["sgst"]))
            # Taxable value: only compare when both rows have it (books often omit)
            has_taxable = p.get("taxable_value",0) > 0 and b.get("taxable_value",0) > 0
            taxable_diff = abs(p.get("taxable_value",0)-b.get("taxable_value",0)) if has_taxable else 0
            # Dates: normalise to ISO before comparing
            p_date = _normalise_date(p.get("invoice_date",""))
            b_date = _normalise_date(b.get("invoice_date",""))
            date_mismatch = bool(p_date and b_date and p_date != b_date)
            rc_p = _to_str(p.get("reverse_charge","")).upper()
            rc_b = _to_str(b.get("reverse_charge","")).upper()
            rc_mismatch = bool(rc_p and rc_b and rc_p != rc_b)
            is_credit_note = p["invoice_value"] < 0

            if val_diff <= tol and tax_diff <= tol:
                matched.append({"portal":p,"books":b,"key":key,"status":"matched",
                                "rc_mismatch": rc_mismatch, "date_mismatch": date_mismatch,
                                "is_credit_note": is_credit_note,
                                "itc_eligibility":_itc_eligibility(p),
                                "is_amended":p.get("is_amended",False)})
            else:
                reason  = _detect_mismatch_reason(p, b, tol)
                suggest = _suggest_correction(p, b)
                # Severity
                pv = max(p["invoice_value"], 1)
                diff_pct = val_diff / pv * 100
                severity = "high" if diff_pct > 5 or tax_diff > tol * 5 else ("medium" if diff_pct > 1 else "low")
                partial.append({"portal":p,"books":b,"key":key,"status":"mismatch",
                                "value_diff": round(p["invoice_value"]-b["invoice_value"],2),
                                "tax_diff":   round((p["igst"]+p["cgst"]+p["sgst"])-(b["igst"]+b["cgst"]+b["sgst"]),2),
                                "rc_mismatch": rc_mismatch, "date_mismatch": date_mismatch,
                                "is_credit_note": is_credit_note,
                                "mismatch_reason":  reason,
                                "suggested_action": suggest,
                                "severity": severity,
                                "itc_eligibility":  _itc_eligibility(p)})

        elif in_portal:
            p = portal_map[key]
            fuzzy_hit = None
            if enable_fuzzy:
                for br in fuzzy_books.get(p["gstin"], []):
                    bkey = f"{br['gstin']}__{br['invoice_no']}"
                    if bkey in books_matched_keys: continue
                    if _fuzzy_invoice_match(p["invoice_no"], br["invoice_no"], fuzzy_threshold):
                        fuzzy_hit = br; books_matched_keys.add(bkey); break
            if fuzzy_hit:
                fuzzy_matched.append({"portal":p,"books":fuzzy_hit,"key":key,"status":"fuzzy_match",
                                      "similarity":round(_fuzzy_similarity(p["invoice_no"],fuzzy_hit["invoice_no"]),3),
                                      "note":"Invoice numbers differ slightly - verify manually"})
            else:
                portal_only.append({"portal":p,"key":key,"status":"missing_in_books",
                                    "is_credit_note": p["invoice_value"] < 0,
                                    "itc_eligibility":_itc_eligibility(p)})
        else:
            b = books_map[key]
            if key not in books_matched_keys:
                # Near-GSTIN typo detection: flag if a portal-only has 1-char GSTIN diff + same invoice + value
                books_only.append({"books":b,"key":key,"status":"missing_in_gst",
                                   "is_credit_note": b["invoice_value"] < 0,
                                   "alert":"Vendor may be non-filer or invoice not in GSTR-1"})

    # ── VALUE+GSTIN secondary pass (same GSTIN, value within tolerance, no inv-no match) ──
    portal_only_idx: Dict[str, list] = {}
    for po in portal_only:
        portal_only_idx.setdefault(po["portal"]["gstin"], []).append(po)
    bo_used_value_pass = set()
    portal_only_final  = []
    for po in portal_only:
        if po["key"] in books_matched_keys: continue
        p = po["portal"]
        candidates = [bo for bo in books_only
                      if bo["books"]["gstin"] == p["gstin"]
                      and bo["key"] not in bo_used_value_pass]
        best = None; best_diff = float("inf")
        for bo in candidates:
            b   = bo["books"]
            tol = _smart_tolerance(p["invoice_value"], b["invoice_value"])
            vd  = abs(p["invoice_value"] - b["invoice_value"])
            if vd > tol: continue
            tax_d = abs((p["igst"]+p["cgst"]+p["sgst"])-(b["igst"]+b["cgst"]+b["sgst"]))
            pd    = _normalise_date(p.get("invoice_date",""))
            bd    = _normalise_date(b.get("invoice_date",""))
            if tax_d > tol and not (pd and bd and pd == bd): continue
            if vd < best_diff: best = bo; best_diff = vd
        if best:
            bo_used_value_pass.add(best["key"])
            books_matched_keys.add(best["key"])
            b = best["books"]
            reason  = _detect_mismatch_reason(p, b)
            partial.append({"portal":p,"books":b,"key":po["key"],"status":"mismatch",
                            "value_gstin_match": True,
                            "value_diff": round(p["invoice_value"]-b["invoice_value"],2),
                            "tax_diff":   round((p["igst"]+p["cgst"]+p["sgst"])-(b["igst"]+b["cgst"]+b["sgst"]),2),
                            "rc_mismatch": False,
                            "mismatch_reason": "Invoice numbers differ — matched by GSTIN + value",
                            "suggested_action": "Confirm this is the same invoice. Invoice number format may differ between portal and books.",
                            "severity": "low",
                            "itc_eligibility": _itc_eligibility(p)})
        else:
            portal_only_final.append(po)

    books_only_final = [bo for bo in books_only if bo["key"] not in bo_used_value_pass]

    # Vendor risk aggregation
    vendor_map: Dict[str,list] = {}
    for item in matched+partial+portal_only_final+books_only_final+fuzzy_matched:
        src   = item.get("portal") or item.get("books") or {}
        gstin = src.get("gstin","UNKNOWN")
        vendor_map.setdefault(gstin,[]).append({"gstin":gstin,
            "trade_name":src.get("trade_name",""),"status":item.get("status","unknown")})
    vendor_risk = {g: {"gstin":g,"trade_name":next((i.get("trade_name") for i in v if i.get("trade_name")),""),
                       **_compute_vendor_risk(v)} for g,v in vendor_map.items()}
    high_risk = [v for v in vendor_risk.values() if v.get("risk_level")=="high"]

    # Duplicates
    dup_portal = [r for r in portal_records if r.get("is_duplicate")]
    dup_books  = [r for r in books_records  if r.get("is_duplicate")]

    # ITC totals
    itc_eligible = sum((i.get("itc_eligibility") or {}).get("itc_total",0) for i in matched
                       if (i.get("itc_eligibility") or {}).get("eligible"))
    itc_at_risk  = sum((i.get("itc_eligibility") or {}).get("itc_total",0) for i in portal_only_final
                       if (i.get("itc_eligibility") or {}).get("eligible"))

    def _sv(items,src): return round(sum((i.get(src) or {}).get("invoice_value",0) for i in items),2)
    def _st(items,src): return round(sum((i.get(src) or {}).get("igst",0)+(i.get(src) or {}).get("cgst",0)+(i.get(src) or {}).get("sgst",0) for i in items),2)

    summary = {
        "total_portal":len(portal_map),"total_books":len(books_map),
        "matched_count":len(matched),"mismatch_count":len(partial),
        "portal_only_count":len(portal_only_final),"books_only_count":len(books_only_final),
        "fuzzy_matched_count":len(fuzzy_matched),
        "duplicate_portal":len(dup_portal),"duplicate_books":len(dup_books),
        "high_risk_vendors":len(high_risk),
        "matched_value":_sv(matched,"portal"),"mismatch_value":_sv(partial,"portal"),
        "portal_only_value":_sv(portal_only_final,"portal"),"books_only_value":_sv(books_only_final,"books"),
        "matched_tax":_st(matched,"portal"),"mismatch_tax":_st(partial,"portal"),
        "portal_only_tax":_st(portal_only_final,"portal"),"books_only_tax":_st(books_only_final,"books"),
        "itc_eligible_total":round(itc_eligible,2),"itc_at_risk_total":round(itc_at_risk,2),
        "tolerance_used":tolerance,"fuzzy_enabled":enable_fuzzy,"fuzzy_threshold":fuzzy_threshold,
    }
    return {"summary":summary,"matched":matched,"mismatch":partial,
            "portal_only":portal_only_final,"books_only":books_only_final,
            "fuzzy_matched":fuzzy_matched,"vendor_risk":vendor_risk,
            "high_risk_vendors":high_risk,
            "duplicate_invoices":{"portal":dup_portal,"books":dup_books}}

# ─── AUDIT LOGGER (NEW) ───────────────────────────────────────────────────────

async def _log_audit(action, user, details):
    try:
        await db.gst_audit_logs.insert_one({
            "_id":str(uuid.uuid4()),"action":action,
            "user_id":user.id,"user_name":getattr(user,"full_name",""),
            "company_id":getattr(user, "company_id", None),
            "timestamp":_now(),"details":details,
        })
    except Exception as exc:
        logger.warning("Audit log write failed: %s", exc)

# ─── PYDANTIC SCHEMAS ─────────────────────────────────────────────────────────






# ─── ENDPOINTS ────────────────────────────────────────────────────────────────

@router.get("/clients")
async def list_clients_for_gst(current_user: User=Depends(get_current_user)):
    """Return clients list for GST client-selector. Respects permission filter."""
    query = build_client_query(current_user)
    docs  = await db.clients.find({**query},
        {"_id":0,"id":1,"company_name":1,"gstin":1,"phone":1,"email":1,
         "address":1,"city":1,"state":1,"pan":1,"gst_treatment":1,"contact_persons":1},
    ).sort("company_name",1).to_list(2000)
    return {"clients": docs}


@router.post("/auto-register-client")
async def auto_register_gst_client(body: dict, current_user: User = Depends(get_current_user)):
    """Automatically register or enrich a client from autofetched GSTIN details so it appears in client lists."""
    gstin = (body.get("gstin") or "").upper().strip()
    company_name = (body.get("company_name") or body.get("name") or "").strip()
    if not gstin or not company_name:
        return {"status": "skipped", "message": "Missing GSTIN or company name"}

    now_iso = _now()
    # Check if client with this GSTIN or company name already exists
    existing = await db.clients.find_one({
        "$or": [
            {"gstin": gstin},
            {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}}
        ]
    })
    if existing:
        updates = {}
        if not existing.get("gstin"):
            updates["gstin"] = gstin
        if not existing.get("address") and body.get("address"):
            updates["address"] = body.get("address")
        if not existing.get("pan") and body.get("pan"):
            updates["pan"] = body.get("pan")
        if updates:
            await db.clients.update_one({"id": existing["id"]}, {"$set": updates})
        # Keep trade names in sync
        await db.gst_trade_names.update_one(
            {"gstin": gstin},
            {"$set": {"gstin": gstin, "name": company_name, "updated_at": now_iso, "updated_by": current_user.id}},
            upsert=True
        )
        return {
            "status": "exists",
            "client": {
                "id": existing["id"],
                "company_name": existing.get("company_name") or company_name,
                "gstin": gstin,
                "pan": existing.get("pan") or body.get("pan"),
                "address": existing.get("address") or body.get("address")
            }
        }

    # Determine client type from 4th character of PAN (pos 6 in GSTIN)
    pan = body.get("pan") or (gstin[2:12] if len(gstin) >= 12 else "")
    c_letter = pan[3] if len(pan) >= 4 else ""
    type_map = {
        "C": "pvt_ltd", "P": "proprietor", "F": "partnership",
        "L": "llp", "H": "huf", "T": "trust", "A": "other", "B": "other", "G": "other"
    }
    client_type = type_map.get(c_letter, "proprietor")

    cid = str(uuid.uuid4())
    new_doc = {
        "_id": cid,
        "id": cid,
        "company_name": company_name,
        "gstin": gstin,
        "pan": pan,
        "client_type": client_type,
        "address": body.get("address") or None,
        "city": body.get("city") or None,
        "state": body.get("state") or None,
        "phone": body.get("phone") or None,
        "email": body.get("email") or None,
        "status": "active",
        "approval_status": "approved",
        "created_by": current_user.id,
        "created_at": now_iso,
    }
    await db.clients.insert_one(new_doc)
    # Also save to shared trade names
    await db.gst_trade_names.update_one(
        {"gstin": gstin},
        {"$set": {"gstin": gstin, "name": company_name, "updated_at": now_iso, "updated_by": current_user.id}},
        upsert=True
    )
    return {
        "status": "created",
        "client": {
            "id": cid,
            "company_name": company_name,
            "gstin": gstin,
            "pan": pan,
            "client_type": client_type,
            "address": new_doc["address"]
        }
    }


@router.post("/save-session")
async def save_session_from_frontend(body: SessionSaveBody, current_user: User=Depends(get_current_user)):
    """Persist a reconciliation session run in browser."""
    client_name=body.client_name or ""; client_gstin=body.client_gstin or ""
    if body.client_id and (not client_name or not client_gstin):
        doc = await db.clients.find_one({"id":body.client_id},{"_id":0,"company_name":1,"gstin":1})
        if doc:
            client_name  = client_name  or doc.get("company_name","")
            client_gstin = client_gstin or doc.get("gstin","")
    sid = str(uuid.uuid4())
    doc = {"_id":sid,"id":sid,"period":body.period,"client_id":body.client_id,
           "client_name":client_name,"client_gstin":client_gstin,
           "portal_filename":body.portal_filename,"books_filename":body.books_filename,
           "created_at":_now(),"created_by":current_user.id,
           "created_by_name":getattr(current_user,"full_name",""),
           "summary":body.summary,
           "full_result": body.full_result or {},
           "company": body.company or {}}
    await db.gst_reconciliation_sessions.insert_one(doc)
    await _log_audit("save_session", current_user, {"session_id":sid,"client":client_name})
    return {"session_id":sid,"created_at":doc["created_at"]}


@router.post("/reconcile")
async def reconcile_files(
    background_tasks: BackgroundTasks,
    portal_file: UploadFile=File(...), books_file: UploadFile=File(...),
    period:          Optional[str]=Form(None),
    save_session:    bool =Form(False),
    tolerance:       float=Form(TOLERANCE),
    enable_fuzzy:    bool =Form(True),
    fuzzy_threshold: float=Form(0.80),
    current_user: User=Depends(get_current_user),
):
    """Reconcile GSTR-2B vs Purchase Register with AI insights, fuzzy matching & ITC analysis."""
    pb = await portal_file.read(); bb = await books_file.read()
    for name,data in [(portal_file.filename,pb),(books_file.filename,bb)]:
        if len(data) > 20*1024*1024:
            raise HTTPException(400, f"File '{name}' exceeds 20 MB limit.")
    # Extract metadata from portal file header (period, taxpayer GSTIN, trade name)
    portal_meta = _extract_portal_metadata(pb, portal_file.filename or "portal.xlsx")
    # Use auto-detected period if not supplied explicitly by caller
    effective_period = period or portal_meta.get("period") or ""
    portal_df = _parse_portal(pb, portal_file.filename or "portal.xlsx")
    books_df  = _parse_books( bb, books_file.filename  or "books.xls")
    # Auto-fetch business names from GST portal for books rows missing trade_name
    try:
        books_df = await _enrich_books_with_names(books_df)
    except Exception as _exc:
        logger.warning("Books name enrichment failed: %s", _exc)
    # Delegate reconciliation operations to modular GST Intelligence engine
    from backend.gst_ai.gst_reconciliation_engine import GSTReconciliationEngine
    books_list = books_df.to_dict("records") if not books_df.empty else []
    portal_list = portal_df.to_dict("records") if not portal_df.empty else []
    engine_res = GSTReconciliationEngine.reconcile_books_vs_portal(
        books_invoices=books_list,
        portal_invoices=portal_list,
        tolerance=tolerance,
        enable_fuzzy=enable_fuzzy,
        fuzzy_threshold=fuzzy_threshold
    )

    result    = _reconcile(portal_df, books_df,
                           tolerance=tolerance, enable_fuzzy=enable_fuzzy, fuzzy_threshold=fuzzy_threshold)
    # Inject engine analytics and results
    result["engine_summary"] = engine_res["summary"]
    if save_session:
        sid = str(uuid.uuid4())
        await db.gst_reconciliation_sessions.insert_one({
            "_id":sid,"id":sid,"period":effective_period,
            "portal_filename":portal_file.filename or "","books_filename":books_file.filename or "",
            "created_at":_now(),"created_by":current_user.id,
            "created_by_name":getattr(current_user,"full_name",""),
            "summary":result["summary"],
            "full_result":result})
        result["session_id"] = sid
    result["portal_metadata"] = portal_meta
    result["detected_period"]  = effective_period
    background_tasks.add_task(_log_audit,"reconcile",current_user,
        {"period":effective_period,"portal":portal_file.filename,"books":books_file.filename,"summary":result["summary"]})
    return result


# ─── GSTR-3B vs 2B (NEW) ──────────────────────────────────────────────────────

@router.post("/gstr3b-vs-2b")
async def gstr3b_vs_2b(body: GSTR3BBody, current_user: User=Depends(get_current_user)):
    """Compare GSTR-3B ITC vs GSTR-2B auto-populated data. Returns variance + alerts."""
    di = round(body.gstr2b_igst-body.gstr3b_igst,2)
    dc = round(body.gstr2b_cgst-body.gstr3b_cgst,2)
    ds = round(body.gstr2b_sgst-body.gstr3b_sgst,2)
    td = round(di+dc+ds,2)
    alerts=[]
    if abs(td)>100: alerts.append(f"Significant ITC variance of Rs.{abs(td):,.2f} detected")
    if di<0: alerts.append(f"IGST claimed in 3B exceeds 2B by Rs.{abs(di):,.2f} - reversal may be needed")
    if dc<0: alerts.append(f"CGST claimed in 3B exceeds 2B by Rs.{abs(dc):,.2f} - reversal may be needed")
    if ds<0: alerts.append(f"SGST claimed in 3B exceeds 2B by Rs.{abs(ds):,.2f} - reversal may be needed")
    rid = str(uuid.uuid4())
    await db.gst_reconciliation_sessions.insert_one({
        "_id":rid,"id":rid,"type":"gstr3b_vs_2b","period":body.period,
        "client_id":body.client_id,"client_name":body.client_name,
        "gstr3b":{"igst":body.gstr3b_igst,"cgst":body.gstr3b_cgst,"sgst":body.gstr3b_sgst},
        "gstr2b":{"igst":body.gstr2b_igst,"cgst":body.gstr2b_cgst,"sgst":body.gstr2b_sgst},
        "variance":{"igst":di,"cgst":dc,"sgst":ds,"total":td},
        "alerts":alerts,"created_by":current_user.id,"created_at":_now()})
    return {"record_id":rid,"gstr3b":{"igst":body.gstr3b_igst,"cgst":body.gstr3b_cgst,"sgst":body.gstr3b_sgst},
            "gstr2b":{"igst":body.gstr2b_igst,"cgst":body.gstr2b_cgst,"sgst":body.gstr2b_sgst},
            "variance":{"igst":di,"cgst":dc,"sgst":ds,"total":td},
            "alerts":alerts,"requires_reversal":td < -100}


# ─── ITC REVERSAL (NEW) ───────────────────────────────────────────────────────

@router.post("/itc-reversal")
async def record_itc_reversal(body: ITCReversalBody, current_user: User=Depends(get_current_user)):
    """Record an ITC reversal entry."""
    total = round(body.igst_reversed+body.cgst_reversed+body.sgst_reversed,2)
    rid   = str(uuid.uuid4())
    await db.gst_reconciliation_sessions.insert_one({
        "_id":rid,"id":rid,"type":"itc_reversal","period":body.period,"client_id":body.client_id,
        "reversal_reason":body.reversal_reason,"igst_reversed":body.igst_reversed,
        "cgst_reversed":body.cgst_reversed,"sgst_reversed":body.sgst_reversed,
        "total_reversed":total,"notes":body.notes,"created_by":current_user.id,"created_at":_now()})
    await _log_audit("itc_reversal",current_user,{"period":body.period,"total":total})
    return {"record_id":rid,"total_reversed":total}


@router.get("/itc-reversals")
async def list_itc_reversals(client_id: Optional[str]=Query(None),
    skip:int=Query(0,ge=0), limit:int=Query(20,ge=1,le=100),
    current_user: User=Depends(get_current_user)):
    """List ITC reversal entries."""
    query: dict = {"type":"itc_reversal"}
    if client_id: query["client_id"]=client_id
    docs  = await db.gst_reconciliation_sessions.find(query,{"_id":0}).sort("created_at",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_reconciliation_sessions.count_documents(query)
    return {"reversals":docs,"total":total}


# ─── VENDOR RISK (NEW) ────────────────────────────────────────────────────────

@router.get("/vendor-risk")
async def get_vendor_risk_profiles(
    skip:int=Query(0,ge=0), limit:int=Query(50,ge=1,le=200),
    risk_level: Optional[str]=Query(None),
    current_user: User=Depends(get_current_user)):
    """Return saved vendor risk profiles."""
    query: dict = {}
    if risk_level: query["risk_level"]=risk_level
    docs  = await db.gst_vendor_profiles.find(query,{"_id":0}).sort("risk_score",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_vendor_profiles.count_documents(query)
    return {"vendors":docs,"total":total}


# ─── VENDOR COMMUNICATION (NEW) ───────────────────────────────────────────────

@router.post("/vendor-communication")
async def generate_vendor_communication(body: VendorCommunicationBody, current_user: User=Depends(get_current_user)):
    """Generate exportable vendor discrepancy notice template."""
    vendor_name = body.trade_name or body.gstin
    period_str  = body.period or "the current period"
    issues_text = "\n".join(f"  {i+1}. {issue}" for i,issue in enumerate(body.issues)) or "  1. Invoice details do not match between GSTR-2B and books."
    template = f"""GSTIN Reconciliation - Discrepancy Notice
==========================================
Date: {_now().strftime('%d %B %Y')}
To: {vendor_name} ({body.gstin})
Period: {period_str}

Dear Vendor,

During GSTR-2B reconciliation for {period_str}, we identified discrepancies:

{issues_text}

Request for Action:
  * Verify the above invoices and file amendments in GSTR-1 if applicable.
  * Ensure all B2B invoices are correctly reported to avoid ITC mismatch.
  * Respond within 7 working days.

Regards,
{getattr(current_user,'full_name','Accounts Team')}
==========================================
"""
    return {"template":template,"gstin":body.gstin,"vendor":vendor_name}



# ─── GSTIN NAME SCRAPER (own multi-source API) ───────────────────────────────
# In-memory cache: { gstin: {trade_name, legal_name, state, status, ts} }
_GSTIN_CACHE: Dict[str, Dict[str, Any]] = {}
_GSTIN_CACHE_TTL_SEC = 60 * 60 * 24 * 7  # 7 days

def _cache_get(gstin: str) -> Optional[Dict[str, Any]]:
    rec = _GSTIN_CACHE.get(gstin)
    if not rec: return None
    if (datetime.now(timezone.utc).timestamp() - rec.get("ts", 0)) > _GSTIN_CACHE_TTL_SEC:
        _GSTIN_CACHE.pop(gstin, None)
        return None
    return rec

def _cache_set(gstin: str, data: Dict[str, Any]):
    data["ts"] = datetime.now(timezone.utc).timestamp()
    _GSTIN_CACHE[gstin] = data

GSTIN_REGEX = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")

def _is_valid_gstin(g: str) -> bool:
    return bool(g) and bool(GSTIN_REGEX.match(g.upper().strip()))

async def _scrape_gstin_name(gstin: str) -> Dict[str, Any]:
    """
    Fetch trade/legal name for a GSTIN from multiple public sources.
    Tries (in order):
      1. GST portal public API     (services.gst.gov.in/services/api/public/gstin)
      2. GST search taxpayer       (services.gst.gov.in/services/api/search/taxpayerDetails)
      3. KnowYourGST public scrape (knowyourgst.com/gst-number-search/{gstin})
    Returns dict with trade_name, legal_name, state, status, source. Always returns a dict
    (never raises) — empty strings if all sources fail.
    """
    gstin = gstin.upper().strip()
    if not _is_valid_gstin(gstin):
        return {"gstin": gstin, "trade_name": "", "legal_name": "", "error": "invalid_gstin"}

    cached = _cache_get(gstin)
    if cached:
        return {**cached, "gstin": gstin, "source": cached.get("source", "cache") + "+cache"}

    import httpx as _httpx
    headers_json = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://services.gst.gov.in/services/searchtp",
    }
    headers_html = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
    }

    # Source 1 — public GSTIN endpoint
    try:
        async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(
                f"https://services.gst.gov.in/services/api/public/gstin?gstin={gstin}",
                headers=headers_json,
            )
        if r.status_code == 200:
            d = r.json() or {}
            tn = (d.get("tradeNam") or d.get("tradeName") or "").strip()
            ln = (d.get("lgnm") or d.get("legalName") or "").strip()
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": (d.get("stj") or "").strip(), "status": (d.get("sts") or "").strip(),
                       "source": "gst_public_api"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src1 failed %s: %s", gstin, exc)

    # Source 2 — taxpayer details
    try:
        async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(
                f"https://services.gst.gov.in/services/api/search/taxpayerDetails?gstin={gstin}",
                headers=headers_json,
            )
        if r.status_code == 200:
            d = r.json() or {}
            tn = (d.get("tradeNam") or "").strip()
            ln = (d.get("lgnm") or "").strip()
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": (d.get("pradr", {}) or {}).get("addr", {}).get("stcd", "") if isinstance(d.get("pradr"), dict) else "",
                       "status": (d.get("sts") or "").strip(),
                       "source": "gst_taxpayer_api"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src2 failed %s: %s", gstin, exc)

    # Source 3 — knowyourgst public page (regex scrape; brittle but useful fallback)
    try:
        async with _httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(f"https://www.knowyourgst.com/gst-number-search/{gstin}/", headers=headers_html)
        if r.status_code == 200 and r.text:
            html = r.text
            tn = ""; ln = ""
            m = re.search(r"Trade Name[^<]*</[^>]+>\s*<[^>]+>\s*([^<]+)", html, re.I)
            if m: tn = m.group(1).strip()
            m = re.search(r"Legal Name[^<]*</[^>]+>\s*<[^>]+>\s*([^<]+)", html, re.I)
            if m: ln = m.group(1).strip()
            if not tn and not ln:
                m = re.search(r"<title>([^<]+)</title>", html, re.I)
                if m:
                    title = m.group(1).strip()
                    title = re.sub(r"\s*[\|\-]\s*KnowYourGST.*$", "", title, flags=re.I).strip()
                    if title and gstin not in title.upper():
                        tn = title
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": "", "status": "", "source": "knowyourgst_scrape"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src3 failed %s: %s", gstin, exc)

    out = {"gstin": gstin, "trade_name": "", "legal_name": "", "state": "", "status": "",
           "source": "none", "error": "all_sources_failed"}
    return out

async def _enrich_books_with_names(books_df) -> "pd.DataFrame":
    """Best-effort enrich the books DataFrame with `trade_name` for GSTINs missing names.
    Limits to 30 unique lookups per call to stay snappy."""
    if books_df is None or books_df.empty or "trade_name" not in books_df.columns:
        return books_df
    missing = books_df[(books_df["trade_name"].fillna("") == "")]["gstin"].dropna().unique().tolist()
    missing = [g for g in missing if _is_valid_gstin(g)][:30]
    if not missing:
        return books_df
    import asyncio as _asyncio
    results = await _asyncio.gather(*[_scrape_gstin_name(g) for g in missing], return_exceptions=True)
    name_map = {}
    for res in results:
        if isinstance(res, dict) and (res.get("trade_name") or res.get("legal_name")):
            name_map[res["gstin"]] = res.get("trade_name") or res.get("legal_name")
    if name_map:
        books_df["trade_name"] = books_df.apply(
            lambda row: row["trade_name"] if row.get("trade_name") else name_map.get(row.get("gstin"), ""),
            axis=1,
        )
        logger.info("Books enriched with %d trade names from GST scraper", len(name_map))
    return books_df


# ─── GSTIN NAME LOOKUP ────────────────────────────────────────────────────────

@router.get("/gstin-lookup/{gstin}")
async def gstin_name_lookup(gstin: str, current_user: User = Depends(get_current_user)):
    """Fetch trade/legal name for a GSTIN.
    IMPORTANT: This endpoint must NEVER raise an unhandled exception — an
    unhandled 500 loses CORS headers and the browser shows a misleading
    CORS error instead of the real error. Always return a JSON dict."""
    gstin = (gstin or "").upper().strip()
    if not _is_valid_gstin(gstin):
        # Return graceful empty — not a 400, so CORS headers are kept
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "invalid_gstin"}
    try:
        import asyncio as _asyncio
        result = await _asyncio.wait_for(_scrape_gstin_name(gstin), timeout=12.0)
        return result
    except _asyncio.TimeoutError:
        logger.warning("GSTIN lookup timed out for %s", gstin)
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "timeout",
                "error": "lookup_timed_out"}
    except Exception as exc:
        logger.error("GSTIN lookup error for %s: %s", gstin, exc)
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "error",
                "error": str(exc)[:120]}



@router.post("/gstin-lookup-batch")
async def gstin_name_lookup_batch(body: GSTINBatchBody, current_user: User = Depends(get_current_user)):
    """Batch GSTIN lookup. Returns {gstin: {trade_name, legal_name, ...}} for up to 50 GSTINs.
    Checks local database and shared trade names first for instant sub-second responses."""
    items = [g.upper().strip() for g in (body.gstins or []) if g and len(g.strip()) == 15][:50]
    if not items:
        return {"results": {}, "count": 0}

    results = {}
    # 1. Fast cache check from db.gst_trade_names and db.clients
    try:
        trade_docs = await db.gst_trade_names.find({"gstin": {"$in": items}}, {"_id": 0, "gstin": 1, "name": 1}).to_list(100)
        for doc in trade_docs:
            if doc.get("gstin") and doc.get("name"):
                results[doc["gstin"]] = {
                    "gstin": doc["gstin"],
                    "trade_name": doc["name"],
                    "legal_name": doc["name"],
                    "state": "",
                    "source": "db_trade_names",
                }

        client_docs = await db.clients.find({"gstin": {"$in": items}}, {"_id": 0, "gstin": 1, "company_name": 1, "state": 1}).to_list(100)
        for doc in client_docs:
            g = doc.get("gstin")
            if g and doc.get("company_name") and g not in results:
                results[g] = {
                    "gstin": g,
                    "trade_name": doc["company_name"],
                    "legal_name": doc["company_name"],
                    "state": doc.get("state") or "",
                    "source": "db_clients",
                }
    except Exception as exc:
        logger.debug("DB batch trade lookup skipped: %s", exc)

    pending = [g for g in items if g not in results]
    if pending:
        import asyncio as _asyncio
        out = await _asyncio.gather(*[_scrape_gstin_name(g) for g in pending], return_exceptions=True)
        for r in out:
            if isinstance(r, dict) and r.get("gstin"):
                g = r["gstin"]
                results[g] = r
                tn = (r.get("trade_name") or r.get("legal_name") or "").strip()
                if tn:
                    try:
                        await db.gst_trade_names.update_one(
                            {"gstin": g},
                            {"$set": {"gstin": g, "name": tn, "updated_at": _now()}},
                            upsert=True
                        )
                    except Exception:
                        pass

    return {"results": results, "count": len(results)}


# ─── HISTORY (v1 preserved) ───────────────────────────────────────────────────

@router.get("/history")
async def get_history(
    skip:        int            = Query(0,  ge=0),
    limit:       int            = Query(20, ge=1, le=200),
    client_id:   Optional[str] = Query(None),
    client_name: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Return saved reconciliation sessions (most recent first).
    Optional filters: client_id, client_name (substring, case-insensitive)."""
    query: Dict[str, Any] = {"type": {"$exists": False}}
    if client_id:
        query["client_id"] = client_id
    elif client_name:
        query["client_name"] = {"$regex": client_name.strip(), "$options": "i"}
    sessions = await db.gst_reconciliation_sessions.find(
        query, {"_id": 0, "full_result": 0}   # exclude full_result for listing (large)
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_reconciliation_sessions.count_documents(query)
    return {"sessions": sessions, "total": total}


@router.get("/history/{session_id}")
async def get_session(session_id:str, current_user: User=Depends(get_current_user)):
    doc = await db.gst_reconciliation_sessions.find_one({"id":session_id},{"_id":0})
    if not doc: raise HTTPException(404,"Session not found")
    return doc


@router.delete("/history/{session_id}")
async def delete_session(session_id:str, current_user: User=Depends(get_current_user)):
    doc = await db.gst_reconciliation_sessions.find_one({"id":session_id},{"_id":0,"created_by":1})
    if not doc: raise HTTPException(404,"Session not found")
    if current_user.role!="admin" and doc.get("created_by")!=current_user.id:
        raise HTTPException(403,"Not authorised to delete this session")
    await db.gst_reconciliation_sessions.delete_one({"id":session_id})

    await _log_audit("delete_session",current_user,{"session_id":session_id})
    return {"deleted":True}


# ─── SHARED TRADE NAMES (NEW) — one user updates = all users see it ───────────



@router.get("/trade-names")
async def get_trade_names(current_user: User = Depends(get_current_user)):
    """Return all shared GSTIN→party name mappings (shared across all users in the org)."""
    docs = await db.gst_trade_names.find({}, {"_id": 0, "gstin": 1, "name": 1}).to_list(10000)
    return {"names": {d["gstin"]: d["name"] for d in docs if d.get("gstin") and d.get("name")}}


@router.post("/trade-names")
async def save_trade_name(body: TradeNameBody, current_user: User = Depends(get_current_user)):
    """Upsert a single GSTIN→name mapping. Shared: all users will see this update."""
    gstin = body.gstin.strip().upper()
    name  = body.name.strip()
    if not gstin or not name:
        raise HTTPException(400, "gstin and name are required")
    await db.gst_trade_names.update_one(
        {"gstin": gstin},
        {"$set": {"gstin": gstin, "name": name, "updated_at": _now(), "updated_by": current_user.id,
                  "updated_by_name": getattr(current_user, "full_name", "")}},
        upsert=True,
    )
    await _log_audit("save_trade_name", current_user, {"gstin": gstin, "name": name})
    return {"ok": True, "gstin": gstin, "name": name}


@router.post("/trade-names/batch")
async def save_trade_names_batch(body: TradeNamesBatchBody, current_user: User = Depends(get_current_user)):
    """Bulk-upsert GSTIN→name mappings (up to 500 entries). Used on first load to sync localStorage → backend."""
    import pymongo as _pymongo
    entries = [
        (k.strip().upper(), v.strip())
        for k, v in (body.names or {}).items()
        if k and k.strip() and v and v.strip()
    ][:500]
    if not entries:
        return {"ok": True, "count": 0}
    ops = [
        _pymongo.UpdateOne(
            {"gstin": g},
            {"$set": {"gstin": g, "name": n, "updated_at": _now(), "updated_by": current_user.id,
                      "updated_by_name": getattr(current_user, "full_name", "")}},
            upsert=True,
        )
        for g, n in entries
    ]
    await db.gst_trade_names.bulk_write(ops)
    return {"ok": True, "count": len(entries)}


# ─── UPDATE SESSION METADATA ─────────────────────────────────────────────────


@router.patch("/history/{session_id}")
async def update_session(session_id: str, body: SessionUpdateBody,
                         current_user: User = Depends(get_current_user)):
    """Update editable metadata on an existing reconciliation session.
    Allowed fields: period, client_id, client_name, client_gstin, company,
                    portal_filename, books_filename.
    The full_result (invoice data) is never mutated here."""
    doc = await db.gst_reconciliation_sessions.find_one(
        {"id": session_id}, {"_id": 0, "created_by": 1}
    )
    if not doc:
        raise HTTPException(404, "Session not found")

    # If client_id provided and name/gstin are missing, auto-fill from client record
    client_name  = body.client_name
    client_gstin = body.client_gstin
    if body.client_id and (not client_name or not client_gstin):
        cdoc = await db.clients.find_one(
            {"id": body.client_id}, {"_id": 0, "company_name": 1, "gstin": 1}
        )
        if cdoc:
            client_name  = client_name  or cdoc.get("company_name", "")
            client_gstin = client_gstin or cdoc.get("gstin", "")

    updates: Dict[str, Any] = {"updated_at": _now(), "updated_by": current_user.id,
                                "updated_by_name": getattr(current_user, "full_name", "")}
    if body.period       is not None: updates["period"]           = body.period
    if body.client_id    is not None: updates["client_id"]        = body.client_id
    if client_name       is not None: updates["client_name"]      = client_name
    if client_gstin      is not None: updates["client_gstin"]     = client_gstin
    if body.company      is not None: updates["company"]          = body.company
    if body.portal_filename is not None: updates["portal_filename"] = body.portal_filename
    if body.books_filename  is not None: updates["books_filename"]  = body.books_filename
    if body.summary         is not None: updates["summary"]         = body.summary
    if body.full_result     is not None: updates["full_result"]     = body.full_result

    await db.gst_reconciliation_sessions.update_one({"id": session_id}, {"$set": updates})
    await _log_audit("update_session", current_user,
                     {"session_id": session_id, "fields": list(updates.keys())})
    return {"ok": True, "session_id": session_id,
            "client_name": client_name, "client_gstin": client_gstin}


# ─── AUDIT LOG (NEW) ──────────────────────────────────────────────────────────

@router.get("/audit-log")
async def get_audit_log(skip:int=Query(0,ge=0), limit:int=Query(50,ge=1,le=200),
    current_user: User=Depends(get_current_user)):
    """Return GST audit log (admin only)."""
    if current_user.role!="admin": raise HTTPException(403,"Admin only")
    if is_platform_owner(current_user):
        query = {}
    else:
        company_id = str(getattr(current_user, "company_id", "") or "").strip()
        scoped_users = await db.users.find(
            {"company_id": company_id},
            {"_id": 0, "id": 1},
        ).to_list(5000)
        user_ids = [str(row.get("id")) for row in scoped_users if row.get("id")]
        query = {
            "$or": [
                {"company_id": company_id},
                {"company_id": {"$in": [None, ""]}, "user_id": {"$in": user_ids}},
            ]
        }
    logs  = await db.gst_audit_logs.find(query,{"_id":0}).sort("timestamp",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_audit_logs.count_documents(query)
    return {"logs":logs,"total":total}


# ─── CLIENTS SUMMARY ─────────────────────────────────────────────────────────

@router.get("/clients-summary")
async def clients_summary(current_user: User = Depends(get_current_user)):
    """Return all unique clients that have reconciliation sessions, with aggregated stats.
    Groups by (client_id OR client_name) so unnamed sessions still appear.
    Returns: list of {client_id, client_name, client_gstin, session_count,
                       last_period, last_date, total_matched, total_books_only,
                       total_portal_only, total_mismatch}."""
    sessions = await db.gst_reconciliation_sessions.find(
        {"type": {"$exists": False}},
        {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
         "period": 1, "created_at": 1, "summary": 1, "company": 1}
    ).sort("created_at", -1).to_list(5000)

    groups: Dict[str, Dict[str, Any]] = {}
    # Build a reverse index: gstin → gkey, so sessions without client_id but with
    # the same GSTIN are folded into an already-created group (prevents duplication
    # when different users start sessions for the same client).
    gstin_to_gkey: Dict[str, str] = {}
    for s in sessions:
        # Group key: prefer client_id, fall back to GSTIN (normalised), then name, then "unknown"
        s_gstin = (s.get("client_gstin") or "").strip().upper()
        raw_gkey = s.get("client_id") or s_gstin or (s.get("client_name") or "").strip().lower() or "unknown"
        # If this session has no client_id but its GSTIN already maps to a group, use that group
        if not s.get("client_id") and s_gstin and s_gstin in gstin_to_gkey:
            gkey = gstin_to_gkey[s_gstin]
        else:
            gkey = raw_gkey
            if s_gstin and s_gstin not in gstin_to_gkey:
                gstin_to_gkey[s_gstin] = gkey
        sm   = s.get("summary") or {}
        if gkey not in groups:
            co = s.get("company") or {}
            groups[gkey] = {
                "client_id":    s.get("client_id")   or "",
                "client_name":  s.get("client_name") or co.get("name") or "Unknown Client",
                "client_gstin": s.get("client_gstin") or co.get("gstin") or "",
                "session_count":      0,
                "last_period":        None,
                "last_date":          None,
                "total_matched":      0,
                "total_books_only":   0,
                "total_portal_only":  0,
                "total_mismatch":     0,
                "total_matched_value":0.0,
                "sessions":           [],
            }
        g = groups[gkey]
        g["session_count"]      += 1
        g["total_matched"]      += sm.get("matched_count", 0) or 0
        g["total_books_only"]   += sm.get("books_only_count", 0) or 0
        g["total_portal_only"]  += sm.get("portal_only_count", 0) or 0
        g["total_mismatch"]     += sm.get("mismatch_count", 0) or 0
        g["total_matched_value"]+= sm.get("matched_value", 0.0) or 0.0
        if g["last_date"] is None:
            g["last_period"] = s.get("period") or ""
            g["last_date"]   = s.get("created_at")
        g["sessions"].append({
            "id":           s["id"],
            "period":       s.get("period") or "",
            "created_at":   s.get("created_at"),
            "matched":      sm.get("matched_count", 0) or 0,
            "mismatch":     sm.get("mismatch_count", 0) or 0,
            "portal_only":  sm.get("portal_only_count", 0) or 0,
            "books_only":   sm.get("books_only_count", 0) or 0,
            "matched_value":sm.get("matched_value", 0.0) or 0.0,
            "books_only_value": sm.get("books_only_value", 0.0) or 0.0,
        })

    result = sorted(groups.values(), key=lambda x: x["last_date"] or "", reverse=True)
    # Remove sessions list from top-level (available via history endpoint)
    for g in result:
        del g["sessions"]
    return {"clients": result, "total": len(result)}


@router.get("/client-sessions/{client_key}")
async def client_sessions(client_key: str, current_user: User = Depends(get_current_user)):
    """Return all sessions for a specific client (by client_id or normalised name key).
    Sessions are returned sorted by created_at desc so newest month is first."""
    import urllib.parse
    decoded = urllib.parse.unquote(client_key)
    # Try client_id first, then name match
    query: Dict[str, Any] = {"type": {"$exists": False}}
    # If the key looks like a UUID, match by client_id; otherwise match by name
    import re as _re
    if _re.match(r'^[0-9a-f-]{8,}$', decoded, _re.I):
        query["client_id"] = decoded
    else:
        name_lower = decoded.lower()
        all_sessions = await db.gst_reconciliation_sessions.find(
            {"type": {"$exists": False}},
            {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
             "period": 1, "created_at": 1, "summary": 1, "company": 1,
             "portal_filename": 1, "books_filename": 1, "created_by_name": 1}
        ).sort("created_at", -1).to_list(500)
        matched = [
            s for s in all_sessions
            if (s.get("client_name") or "").strip().lower() == name_lower
            or (s.get("client_id") or "") == decoded
        ]
        return {"sessions": matched, "total": len(matched)}

    docs = await db.gst_reconciliation_sessions.find(
        query,
        {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
         "period": 1, "created_at": 1, "summary": 1, "company": 1,
         "portal_filename": 1, "books_filename": 1, "created_by_name": 1}
    ).sort("created_at", -1).to_list(500)
    return {"sessions": docs, "total": len(docs)}


# ─── DASHBOARD SUMMARY (NEW) ──────────────────────────────────────────────────

@router.get("/dashboard-summary")
async def dashboard_summary(current_user: User=Depends(get_current_user)):
    """Aggregated stats for the GST dashboard."""
    total_sessions = await db.gst_reconciliation_sessions.count_documents({"type":{"$exists":False}})
    recent = await db.gst_reconciliation_sessions.find(
        {"type":{"$exists":False},"summary":{"$exists":True}},
        {"_id":0,"period":1,"summary":1,"created_at":1}
    ).sort("created_at",-1).limit(5).to_list(5)
    total_high_risk = await db.gst_vendor_profiles.count_documents({"risk_level":"high"})
    total_reversals = await db.gst_reconciliation_sessions.count_documents({"type":"itc_reversal"})
    return {"total_sessions":total_sessions,"total_high_risk_vendors":total_high_risk,
            "total_itc_reversals":total_reversals,"recent_sessions":recent}



# ─── AI INSIGHTS ENDPOINT (Grok / xAI) ───────────────────────────────────────


@router.post("/ai-insights")
async def generate_ai_insights(
    body: AIInsightBody,
    current_user: User = Depends(get_current_user),
):
    """
    Send reconciliation summary to Grok (xAI) and get back:
      - Executive summary
      - Key risk areas
      - Recommended actions
      - ITC impact analysis
    """
    import os
    groq_key = os.environ.get("GROQ_API_KEY", "")
    if not groq_key:
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY is not configured on the server."
        )
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=groq_key,
            base_url="https://api.groq.com/openai/v1",
        )
    except ImportError:
        raise HTTPException(status_code=500, detail="openai package not installed.")

    # Build top mismatches text
    mismatch_text = ""
    if body.top_mismatches:
        lines = []
        for i, m in enumerate(body.top_mismatches[:5], 1):
            p = m.get("portal", {})
            b = m.get("books", {})
            lines.append(
                f"  {i}. GSTIN: {p.get('gstin','')} | Invoice: {p.get('invoice_no_raw', p.get('invoice_no',''))} | "
                f"Portal Value: Rs.{p.get('invoice_value',0):,.2f} | Books Value: Rs.{b.get('invoice_value',0):,.2f} | "
                f"Reason: {m.get('mismatch_reason','')}"
            )
        mismatch_text = "\nTop Mismatches:\n" + "\n".join(lines)

    prompt = f"""You are an expert Indian GST consultant and chartered accountant.
A client has completed GSTR-2B vs Purchase Register reconciliation for period: {body.period or "current period"}.

Reconciliation Summary:
- Total Portal (GSTR-2B) Invoices: {body.summary.get("total_portal", 0)}
- Total Books Invoices: {body.summary.get("total_books", 0)}
- Matched: {body.summary.get("matched_count", 0)} invoices (Rs.{body.summary.get("matched_value", 0):,.2f})
- Mismatched: {body.mismatch_count} invoices (Rs.{body.summary.get("mismatch_value", 0):,.2f})
- Missing in Books: {body.portal_only_count} invoices (Rs.{body.summary.get("portal_only_value", 0):,.2f})
- Missing in GST Portal: {body.books_only_count} invoices (Rs.{body.summary.get("books_only_value", 0):,.2f})
- High Risk Vendors: {body.high_risk_vendors}
- ITC Eligible (matched): Rs.{body.itc_eligible_total:,.2f}
- ITC At Risk (missing in books): Rs.{body.itc_at_risk_total:,.2f}
- Fuzzy Matched: {body.summary.get("fuzzy_matched_count", 0)} invoices
- Duplicate Invoices (Portal): {body.summary.get("duplicate_portal", 0)}
- Duplicate Invoices (Books): {body.summary.get("duplicate_books", 0)}
{mismatch_text}

Please provide a concise professional analysis in the following structure:

## Executive Summary
(2-3 sentences summarising the reconciliation outcome)

## Key Risk Areas
(Bullet points of the most important issues found)

## ITC Impact Analysis
(Analysis of ITC eligible vs at-risk amounts and what actions are needed)

## Recommended Actions
(Prioritised action items the client should take immediately)

## Compliance Note
(Brief note on GST compliance status and filing deadlines if relevant)

Keep the response clear, professional, and actionable. Use Indian GST terminology.
"""

    try:
        completion = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return {
            "insights": completion.choices[0].message.content,
            "period": body.period,
            "generated_at": _now().isoformat(),
        }
    except Exception as e:
        error_msg = str(e)
        if "429" in error_msg or "quota" in error_msg.lower() or "rate" in error_msg.lower():
            raise HTTPException(
                status_code=429,
                detail="Grok API rate limit reached. Please wait a moment and try again."
            )
        raise HTTPException(status_code=422, detail=f"AI analysis failed: {error_msg}")


# ─── INDEXES (extended) ───────────────────────────────────────────────────────

async def create_gst_reconciliation_indexes():
    try:
        await db.gst_reconciliation_sessions.create_index("id",         unique=True, background=True)
        await db.gst_reconciliation_sessions.create_index("created_by", background=True)
        await db.gst_reconciliation_sessions.create_index("created_at", background=True)
        await db.gst_reconciliation_sessions.create_index("type",       background=True)
        await db.gst_reconciliation_sessions.create_index("client_id",  background=True)
        await db.gst_audit_logs.create_index("timestamp",  background=True)
        await db.gst_audit_logs.create_index("user_id",    background=True)
        await db.gst_vendor_profiles.create_index("gstin",      unique=True, background=True)
        await db.gst_vendor_profiles.create_index("risk_level", background=True)
        await db.gst_vendor_profiles.create_index("risk_score", background=True)
        logger.info("GST Reconciliation indexes ensured (v2)")
    except Exception as exc:
        logger.warning("GST Reconciliation index creation: %s", exc)
