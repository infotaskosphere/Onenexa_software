import uuid
import logging
import re
import base64
import tempfile
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders
from datetime import datetime, timezone, date
from io import BytesIO
from typing import List, Optional, Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.dependencies import (
    db,
    get_current_user,
    require_admin,
    check_module_permission,
    _get_perm,
)
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.pincode_lookup import get_state_from_pincode

try:
    from fpdf import FPDF
    from fpdf.enums import Align, XPos, YPos
except ImportError:
    import subprocess
    import sys

    subprocess.check_call([sys.executable, "-m", "pip", "install", "fpdf2"])
    from fpdf import FPDF
    from fpdf.enums import Align, XPos, YPos

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Quotations"])


# ═══════════════════════════════════════════════════════════════════════════════
# DOCUMENT CHECKLISTS per service
# ═══════════════════════════════════════════════════════════════════════════════
SERVICE_CHECKLISTS: Dict[str, List[str]] = {
    "GST Registration": [
        "PAN Card of Applicant / Business",
        "Aadhaar Card of Proprietor / Partners / Directors",
        "Photograph (Passport Size)",
        "Address Proof of Business Premises (Electricity Bill / Rent Agreement)",
        "Bank Account Statement / Cancelled Cheque",
        "Constitution Proof (Partnership Deed / MOA-AOA / Certificate of Incorporation)",
        "Digital Signature Certificate (for Companies/LLP)",
        "Letter of Authorization / Board Resolution",
        "Mobile Number & Email ID",
    ],
    "GST Return Filing": [
        "GSTIN",
        "GST Username & Password",
        "Sales Invoices / Register",
        "Purchase Invoices / Register",
        "Bank Statement",
        "Credit / Debit Notes (if any)",
        "Previous Return Copy (GSTR-3B / GSTR-1)",
        "E-way Bill Records (if applicable)",
    ],
    "GST Annual Return (GSTR-9)": [
        "GSTIN",
        "GSTR-1 Filed Returns (All months)",
        "GSTR-3B Filed Returns (All months)",
        "Audited Financial Statements",
        "Purchase & Sales Ledger",
        "Input Tax Credit (ITC) Reconciliation",
        "HSN/SAC Code Summary",
    ],
    "Income Tax Return (ITR) - Individual": [
        "PAN Card",
        "Aadhaar Card",
        "Form 16 (from Employer)",
        "Bank Statements (All accounts)",
        "Interest Certificates (FD/Savings)",
        "Investment Proofs (80C, 80D, etc.)",
        "Rental Income Details (if any)",
        "Capital Gains Statements",
        "Previous Year ITR Copy",
    ],
    "Income Tax Return (ITR) - Business": [
        "PAN Card of Business / Proprietor",
        "Aadhaar Card",
        "Audited Financial Statements (P&L, Balance Sheet)",
        "Bank Statements (All accounts)",
        "TDS Certificates / Form 26AS",
        "GST Returns (if applicable)",
        "Loan Statements",
        "Investment / Asset Details",
        "Previous Year ITR Copy",
    ],
    "TDS Return Filing": [
        "TAN (Tax Deduction Account Number)",
        "PAN of Deductee(s)",
        "Challan Details (BSR Code, Date, Amount, Challan No.)",
        "Nature of Payment & Rate of TDS",
        "Previous Quarter TDS Return Copy",
        "Form 16 / 16A Data",
    ],
    "Tax Audit (Form 3CA/3CB)": [
        "PAN Card of Business",
        "Audited Financial Statements",
        "Books of Accounts (Ledger, Cash Book, Journal)",
        "Bank Statements",
        "GST Returns",
        "ITR Filed Copies",
        "Stock Valuation Report",
        "Fixed Asset Register",
        "Loan & Advance Details",
    ],
    "Company Registration (Pvt. Ltd.)": [
        "PAN Card of all Proposed Directors",
        "Aadhaar Card of all Proposed Directors",
        "Passport Size Photographs of all Directors",
        "Address Proof of Registered Office (Electricity Bill / NOC)",
        "Rent Agreement (if rented premises)",
        "Email IDs & Mobile Numbers of all Directors",
        "Proposed Company Name(s) (2-3 Options)",
        "Object Clause / Business Description",
        "DSC (Digital Signature Certificate) - will be applied",
        "DIN (Director Identification Number) - will be applied",
    ],
    "LLP Registration": [
        "PAN Card of all Designated Partners",
        "Aadhaar Card of all Designated Partners",
        "Passport Size Photographs",
        "Address Proof of Registered Office",
        "Proposed LLP Name(s)",
        "LLP Agreement Draft",
        "DPIN / DIN of Partners",
        "Email IDs & Mobile Numbers",
    ],
    "ROC Annual Compliance": [
        "Certificate of Incorporation",
        "MOA & AOA",
        "Audited Financial Statements",
        "Board Resolution",
        "Minutes of AGM / Board Meeting",
        "Shareholding Pattern",
        "List of Directors",
        "DIN of all Directors",
        "DSC of Authorized Signatory",
        "Previous Year Filed Forms",
    ],
    "Trademark Registration": [
        "PAN Card of Applicant",
        "Aadhaar Card",
        "Trademark (Logo / Word / Device) in JPEG format",
        "Business Proof (MSME / GST Certificate / MOA / Partnership Deed)",
        "TM Class Description (Goods/Services)",
        "Power of Attorney (TM-48)",
        "Prior Use Evidence (if claiming use before date)",
    ],
    "MSME / Udyam Registration": [
        "Aadhaar Card of Proprietor / Director / Partner",
        "PAN Card",
        "GSTIN (if applicable)",
        "Bank Account Details",
        "Business Address Proof",
        "NIC Code (Business Activity)",
    ],
    "Accounting & Bookkeeping": [
        "Bank Statements (All accounts)",
        "Sales Invoices",
        "Purchase Invoices",
        "Expense Vouchers / Bills",
        "Payroll Details (if employees)",
        "Loan Statements",
        "Credit Card Statements (if any)",
        "Opening Balance Sheet / Previous Year Data",
    ],
    "Payroll Processing": [
        "Employee Details (Name, PAN, Aadhaar, Bank Account)",
        "Salary Structure / CTC Breakup",
        "Attendance Records",
        "Leave Records",
        "ESI & PF Registration Numbers",
        "Professional Tax Registration",
        "Investment Declarations (Form 12BB)",
    ],
    "FEMA / RBI Compliance": [
        "PAN Card",
        "Certificate of Incorporation",
        "MOA & AOA",
        "Foreign Inward Remittance Certificate (FIRC)",
        "Valuation Report",
        "CS Certificate",
        "Board Resolution for Foreign Investment",
        "Form FC-GPR / FC-TRS (as applicable)",
    ],
    "DSC (Digital Signature Certificate)": [
        "PAN Card",
        "Aadhaar Card",
        "Passport Size Photograph",
        "Mobile Number (linked to Aadhaar)",
        "Email ID",
        "Organisation Certificate (for Class-3 Org DSC)",
    ],
    "Other / Custom Service": [
        "PAN Card",
        "Aadhaar Card",
        "Address Proof",
        "Bank Account Details",
        "Photograph",
        "Any specific document advised by our team",
    ],
}

ALL_SERVICES = list(SERVICE_CHECKLISTS.keys())


# ═══════════════════════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# ═══════════════════════════════════════════════════════════════════════════════


class CompanyProfile(BaseModel):
    id: Optional[str] = None
    name: str
    address: str = ""
    city: str = ""
    # Registered PIN code of the company/firm itself. Used to auto-derive
    # `state` / `state_code` below (see backend/pincode_lookup.py) so every
    # invoice raised from this company can auto-decide CGST+SGST vs IGST by
    # comparing this state_code against the client's / place-of-supply's.
    pincode: str = ""
    state: str = ""
    state_code: str = ""
    phone: str = ""
    email: str = ""
    website: str = ""
    gstin: str = ""
    pan: str = ""
    bank_account_name: str = ""
    bank_name: str = ""
    bank_account_no: str = ""
    bank_ifsc: str = ""
    logo_base64: Optional[str] = None
    signature_base64: Optional[str] = None
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_name: str = ""
    created_by: Optional[str] = None
    created_at: Optional[str] = None


class QuotationItem(BaseModel):
    description: str
    quantity: float = 1.0
    unit: str = "service"
    unit_price: float = 0.0
    amount: float = 0.0


class QuotationCreate(BaseModel):
    company_id: str
    lead_id: Optional[str] = None
    client_id: Optional[str] = None  # NEW: link to clients collection
    client_name: str
    client_address: str = ""
    client_email: str = ""
    client_phone: str = ""
    service: str
    subject: str = ""
    scope_of_work: List[str] = []
    items: List[QuotationItem] = []
    gst_rate: float = 18.0
    payment_terms: str = ""
    timeline: str = ""
    validity_days: int = 30
    advance_terms: str = ""
    extra_terms: List[str] = []
    notes: str = ""
    extra_checklist_items: List[str] = []
    attach_checklist: bool = True
    status: str = "draft"
    # Theme/template selection — persists per quotation so PDF, preview and the
    # converted invoice all stay visually consistent. Falls back to the
    # company's defaults when not set.
    invoice_template: str = ""
    invoice_theme: str = ""
    invoice_custom_color: str = ""
    invoice_id: Optional[str] = None
    invoice_no: Optional[str] = None
    converted_at: Optional[str] = None
    # If provided by the frontend (pre-fetched via /quotations/next-number,
    # scoped to the selected company), use it after a duplicate check;
    # otherwise the backend auto-generates one scoped to company_id.
    quotation_no: Optional[str] = None


class QuotationOut(QuotationCreate):
    id: str
    quotation_no: str
    date: str
    created_by: str
    created_at: str
    updated_at: str
    subtotal: float
    gst_amount: float
    total: float


class EmailSendRequest(BaseModel):
    to_email: str
    subject: str = ""
    body: str = ""
    pdf_type: str = "quotation"  # "quotation" or "checklist"


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════


def _safe_str(value: Any, max_len: int = 0) -> str:
    if value is None:
        return ""
    text = str(value)
    text = text.encode("latin-1", errors="replace").decode("latin-1")
    if max_len and len(text) > max_len:
        text = text[:max_len]
    return text


def _compute_item_amount(item: QuotationItem) -> float:
    return round(item.quantity * item.unit_price, 2)


async def _company_has_gst(company_id: str) -> bool:
    """Whether the ISSUING company (the one raising the quotation, not the
    buyer/client) is GST-registered. GST only ever applies based on the
    seller's own registration status — a buyer having a GSTIN never makes
    an otherwise-unregistered seller's document a GST document. Defaults to
    True (GST applies) when there's no company_id yet or no explicit
    `has_gst: false` on the company profile, so existing companies that
    never touched the toggle keep behaving as before."""
    if not company_id:
        return True
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "has_gst": 1})
    if not company:
        return True
    return company.get("has_gst") is not False


def _compute_totals(items: List[QuotationItem], gst_rate: float):
    subtotal = sum(i.amount for i in items)
    gst_amount = round(subtotal * gst_rate / 100, 2)
    total = round(subtotal + gst_amount, 2)
    return subtotal, gst_amount, total


def _permission_ok(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = (
        user.permissions
        if isinstance(user.permissions, dict)
        else (user.permissions.model_dump() if user.permissions else {})
    )
    return bool(perms.get("can_create_quotations", False))


async def _next_qtn_number(
    company_id: str = None,
    prefix: str = "QTN",
    separator: str = "/",
    include_fy: bool = True,
    fy_format: str = "short",
    include_month: bool = False,
    number_padding: int = 3,
) -> str:
    """Generate the next available quotation number.

    FIX (numbering continuity bug): the previous implementation used
    count_documents on a global (not per-company) query, which caused
    two problems:
      1. It was NOT scoped per company, so every company created in the
         system shared one single counter instead of each company having
         its own continuing sequence (unlike invoice numbering, which was
         already correctly scoped per company).
      2. It used a plain COUNT instead of scanning for the MAX existing
         sequence number, so deleting/renaming any quotation would cause
         the counter to fall out of sync and could mint a duplicate
         number the next time a quotation was created.

    This version mirrors the (correct) invoice numbering logic in
    invoicing.py::_next_invoice_no -- it is scoped per company_id and is
    MAX-based (scans existing quotation numbers for that company and picks
    the highest sequence + 1), so numbering always continues correctly
    from the previous quotation for that company, regardless of
    deletions, renames, or how many other companies exist.
    """
    today = date.today()
    fy_start = today.year if today.month >= 4 else today.year - 1

    if fy_format == "long":
        fy_label = f"{fy_start}-{fy_start + 1}"
    else:
        fy_label = f"{fy_start % 100:02d}-{(fy_start + 1) % 100:02d}"

    month_str = f"{today.month:02d}"
    sep = separator if separator and separator.lower() != "none" else ""

    # Build regex to scan existing quotations with this exact format
    scan_parts = [re.escape(prefix)]
    if include_fy:
        scan_parts.append(re.escape(fy_label))
    if include_month:
        scan_parts.append(re.escape(month_str))
    scan_parts.append(r"(\d+)")
    pattern = re.escape(sep).join(scan_parts)
    pattern = f"^{pattern}$"

    query: dict = {"quotation_no": {"$regex": f"^{re.escape(prefix)}"}}
    if company_id:
        query["company_id"] = company_id

    cursor = db.quotations.find(query, {"_id": 0, "quotation_no": 1})
    max_seq = 0
    async for doc in cursor:
        m = re.match(pattern, doc.get("quotation_no", ""))
        if m:
            seq = int(m.group(1))
            if seq > max_seq:
                max_seq = seq

    def _build(seq: int) -> str:
        parts = [prefix]
        if include_fy:
            parts.append(fy_label)
        if include_month:
            parts.append(month_str)
        parts.append(str(seq).zfill(number_padding))
        return sep.join(parts)

    candidate_seq = max_seq + 1
    for _ in range(50):
        candidate = _build(candidate_seq)
        dup_filter: dict = {"quotation_no": candidate}
        if company_id:
            dup_filter["company_id"] = company_id
        taken = await db.quotations.find_one(dup_filter)
        if not taken:
            return candidate
        candidate_seq += 1

    return _build(candidate_seq)


async def _update_lead_status_for_quotation(lead_id: str, new_status: str):
    if not lead_id:
        return
    try:
        from bson import ObjectId

        now = datetime.now(timezone.utc)
        update_payload = {"$set": {"status": new_status, "updated_at": now}}
        updated = False

        if ObjectId.is_valid(lead_id):
            result = await db.leads.update_one(
                {"_id": ObjectId(lead_id)}, update_payload
            )
            if result.matched_count > 0:
                updated = True

        if not updated:
            result = await db.leads.update_one({"id": lead_id}, update_payload)
            if result.matched_count > 0:
                updated = True

        if not updated:
            logger.warning(f"Lead '{lead_id}' not found")

    except Exception as e:
        logger.warning(f"Could not update lead {lead_id} status: {e}")


def _extract_dominant_color_from_b64(logo_b64: str):
    FALLBACK = (13, 59, 102)
    if not logo_b64:
        return FALLBACK
    try:
        from PIL import Image
        import io as _io

        raw = re.sub(r"^data:image/[^;]+;base64,", "", logo_b64)
        img_bytes = base64.b64decode(raw)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        img = img.resize((50, 50))
        pixels = list(img.getdata())
        filtered = [
            p
            for p in pixels
            if not (p[0] > 220 and p[1] > 220 and p[2] > 220)
            and not (p[0] < 30 and p[1] < 30 and p[2] < 30)
        ]
        if not filtered:
            return FALLBACK
        r = int(sum(p[0] for p in filtered) / len(filtered))
        g = int(sum(p[1] for p in filtered) / len(filtered))
        b = int(sum(p[2] for p in filtered) / len(filtered))
        return (r, g, b)
    except Exception as e:
        logger.warning(f"Dominant colour extraction failed: {e}")
        return FALLBACK


def _lighten(color: tuple, factor: float = 0.85) -> tuple:
    return tuple(int(c + (255 - c) * factor) for c in color)


def _darken(color: tuple, factor: float = 0.6) -> tuple:
    return tuple(int(c * factor) for c in color)


def _safe_pdf_output(pdf: FPDF) -> BytesIO:
    """
    Return BytesIO object containing raw PDF bytes for fpdf2.
    fpdf2's output() method returns bytes directly.
    We write those bytes into a BytesIO buffer.
    """
    output_buffer = BytesIO()
    try:
        pdf_bytes = pdf.output()  # fpdf2 returns bytes
        output_buffer.write(pdf_bytes)
        output_buffer.seek(0)
        return output_buffer
    except Exception as e:
        logger.error(f"Error during PDF output: {e}")
        raise RuntimeError(f"PDF output failed: {e}")


def _embed_logo(pdf, logo_b64: str, x: float, y: float, h: float) -> None:
    if not logo_b64:
        return
    tmp_path = None
    try:
        raw = re.sub(r"^data:image/[^;]+;base64,", "", logo_b64)
        img_bytes = base64.b64decode(raw)
        suffix = (
            ".jpg" if ("jpeg" in logo_b64[:30] or "jpg" in logo_b64[:30]) else ".png"
        )
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(img_bytes)
        tmp.close()
        tmp_path = tmp.name
        pdf.image(tmp_path, x=x, y=y, h=h)
    except Exception as e:
        logger.warning(f"Logo embed failed: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def _cell(pdf, w, h, txt="", border=0, align="L", fill=False, nl=False):
    pdf.cell(w, h, txt, border, 1 if nl else 0, align, fill)


def _mcell(pdf, w, h, txt, border=0, align="L", fill=False):
    pdf.multi_cell(w, h, txt, border, align, fill)


# ═══════════════════════════════════════════════════════════════════════════════
# PDF BUILDER – QUOTATION
# ═══════════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS — hex color, amount in words (needed by PDF builder)
# ═══════════════════════════════════════════════════════════════════════════════

_ONES = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
]
_TENS = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
]


def _hex_to_rgb(hex_color: str) -> tuple:
    """Convert a CSS hex color string to an (R, G, B) tuple."""
    try:
        h = hex_color.strip().lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        return (13, 59, 102)


def _amount_in_words(n: float) -> str:
    try:
        rupees = int(n)
        paise = round((n - rupees) * 100)

        def _grp(num):
            if num == 0:
                return ""
            if num < 20:
                return _ONES[num] + " "
            if num < 100:
                return (
                    _TENS[num // 10] + (" " + _ONES[num % 10] if num % 10 else "") + " "
                )
            return _ONES[num // 100] + " Hundred " + _grp(num % 100)

        def _convert(num):
            if num == 0:
                return "Zero "
            r = ""
            cr = num // 10_000_000
            num %= 10_000_000
            lk = num // 100_000
            num %= 100_000
            th = num // 1000
            num %= 1000
            if cr:
                r += _grp(cr) + "Crore "
            if lk:
                r += _grp(lk) + "Lakh "
            if th:
                r += _grp(th) + "Thousand "
            r += _grp(num)
            return r

        r = _convert(rupees).strip()
        p = f" and {_convert(paise).strip()} Paise" if paise else ""
        return f"Rupees {r}{p} Only"
    except Exception:
        return f"Rupees {n:.2f} Only"


# ═══════════════════════════════════════════════════════════════════════════════
# PDF BUILDER – QUOTATION  (matches Invoice PDF layout exactly)
# ═══════════════════════════════════════════════════════════════════════════════


def _build_quotation_pdf(q: dict, company: dict) -> BytesIO:
    """
    Quotation PDF — identical layout to Invoice PDF (_build_invoice_pdf).
    Only differences:
      - Heading reads "QUOTATION" instead of "Tax Invoice"
      - Right info block shows Quotation Details instead of DUE DATE
      - Quotation-specific extras appended (Scope of Work, Document Checklist)
    """
    # ── Resolve brand color (same logic as invoice) ──────────────────────────
    raw_color = (
        q.get("invoice_custom_color")
        or company.get("invoice_custom_color")
        or company.get("brand_color")
        or "#0D3B66"
    )
    BRAND = _hex_to_rgb(raw_color)
    BL = _lighten(BRAND, 0.92)
    DARK = (30, 41, 59)
    MUTED = (100, 116, 139)
    WHITE = (255, 255, 255)

    _q = q
    _MUTED = MUTED

    class PDF(FPDF):
        def header(self):
            pass

        def footer(self):
            self.set_y(-12)
            self.set_font("Helvetica", "I", 7)
            self.set_text_color(*_MUTED)
            _cell(
                self,
                0,
                5,
                _safe_str(
                    f"This is a computer-generated document.  \u00b7  {_q.get('quotation_no', '')}  \u00b7  Page {self.page_no()}"
                ),
                align="C",
                nl=True,
            )

    pdf = PDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()

    M = 14  # left/right margin
    CW = pdf.w - M * 2  # content width ~182 mm

    # ═══════════════════════════════════════════════════════
    # HEADER BAND  (identical to invoice)
    # ═══════════════════════════════════════════════════════
    HEADER_H = 44
    pdf.set_fill_color(*BRAND)
    pdf.rect(0, 0, pdf.w, HEADER_H, "F")

    if company.get("logo_base64"):
        _embed_logo(pdf, company["logo_base64"], x=M, y=7, h=16)
        logo_offset = 20
    else:
        logo_offset = 0

    # Company info — left column
    pdf.set_xy(M + logo_offset, 7)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*WHITE)
    _cell(pdf, CW * 0.55, 6, _safe_str(company.get("name", "")), nl=True)

    pdf.set_x(M + logo_offset)
    pdf.set_font("Helvetica", "", 7.5)
    pdf.set_text_color(210, 225, 245)

    addr = _safe_str(company.get("address", ""))
    if addr:
        _mcell(pdf, CW * 0.55, 4, addr)
        pdf.set_x(M + logo_offset)

    contact_parts = []
    if company.get("phone"):
        contact_parts.append(f"Ph: {company['phone']}")
    if company.get("email"):
        contact_parts.append(company["email"])
    if contact_parts:
        _cell(pdf, CW * 0.55, 4, _safe_str("  \u00b7  ".join(contact_parts)), nl=True)
        pdf.set_x(M + logo_offset)

    if company.get("gstin"):
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.set_text_color(*WHITE)
        _cell(pdf, CW * 0.55, 4, _safe_str(f"GSTIN: {company['gstin']}"), nl=True)
    if company.get("pan"):
        pdf.set_font("Helvetica", "", 7.5)
        pdf.set_text_color(210, 225, 245)
        pdf.set_x(M + logo_offset)
        _cell(pdf, CW * 0.55, 4, _safe_str(f"PAN: {company['pan']}"), nl=True)

    # Document type — right column  ("QUOTATION" instead of "Tax Invoice")
    right_col_x = M + CW * 0.60
    right_col_w = CW * 0.40

    pdf.set_xy(right_col_x, 7)
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*WHITE)
    _cell(pdf, right_col_w, 10, "QUOTATION", align="R", nl=True)

    pdf.set_x(right_col_x)
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(210, 225, 245)
    _cell(
        pdf,
        right_col_w,
        5,
        _safe_str(f"# {q.get('quotation_no', '')}"),
        align="R",
        nl=True,
    )

    pdf.set_x(right_col_x)
    _cell(
        pdf, right_col_w, 5, _safe_str(f"Date: {q.get('date', '')}"), align="R", nl=True
    )

    # ═══════════════════════════════════════════════════════
    # BILL TO  /  QUOTATION DETAILS  (matches invoice layout)
    # ═══════════════════════════════════════════════════════
    info_y = HEADER_H + 5
    pdf.set_xy(M, info_y)

    # Left: Bill To
    bill_w = CW * 0.56
    pdf.set_font("Helvetica", "B", 7.5)
    pdf.set_text_color(*MUTED)
    _cell(pdf, bill_w, 5, "BILL TO", nl=True)

    pdf.set_x(M)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*DARK)
    _cell(pdf, bill_w, 6, _safe_str(q.get("client_name", ""), 50), nl=True)

    pdf.set_x(M)
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(*MUTED)
    if q.get("client_address"):
        _mcell(pdf, bill_w, 4, _safe_str(q["client_address"], 90))
        pdf.set_x(M)

    contact_c = []
    if q.get("client_phone"):
        contact_c.append(q["client_phone"])
    if q.get("client_email"):
        contact_c.append(q["client_email"])
    if contact_c:
        _cell(pdf, bill_w, 4, _safe_str("  \u00b7  ".join(contact_c)), nl=True)

    if q.get("client_gstin"):
        pdf.set_x(M)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(*DARK)
        _cell(pdf, bill_w, 4, _safe_str(f"GSTIN: {q['client_gstin']}"), nl=True)

    # Right: Quotation Details (mirrors invoice DUE DATE block)
    due_x = M + CW * 0.62
    due_w = CW * 0.38
    pdf.set_xy(due_x, info_y)

    pdf.set_font("Helvetica", "B", 7.5)
    pdf.set_text_color(*MUTED)
    _cell(pdf, due_w, 5, "QUOTATION DETAILS", align="R", nl=True)

    pdf.set_x(due_x)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*DARK)
    _cell(pdf, due_w, 6, _safe_str(q.get("quotation_no", "")), align="R", nl=True)

    pdf.set_x(due_x)
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(*MUTED)
    _cell(pdf, due_w, 5, _safe_str(f"Date: {q.get('date', '')}"), align="R", nl=True)

    valid_days = q.get("validity_days", 30)
    pdf.set_x(due_x)
    _cell(pdf, due_w, 5, _safe_str(f"Valid For: {valid_days} days"), align="R", nl=True)

    if q.get("payment_terms"):
        pdf.set_x(due_x)
        _cell(pdf, due_w, 5, _safe_str(q["payment_terms"], 30), align="R", nl=True)

    is_inter = q.get("is_interstate", False)
    supply_label = "Interstate (IGST)" if is_inter else "Intrastate (CGST+SGST)"
    pdf.set_x(due_x)
    _cell(pdf, due_w, 5, _safe_str(supply_label), align="R", nl=True)

    # Divider
    div_y = max(pdf.get_y(), info_y + 30) + 2
    pdf.set_draw_color(*_lighten(BRAND, 0.70))
    pdf.set_line_width(0.3)
    pdf.line(M, div_y, M + CW, div_y)
    pdf.set_line_width(0.2)

    # ═══════════════════════════════════════════════════════
    # ITEMS TABLE  (matches invoice columns exactly)
    # ═══════════════════════════════════════════════════════
    table_y = div_y + 3
    pdf.set_xy(M, table_y)

    # Column widths — same as invoice PDF
    sr_w = 7
    hsn_w = 20
    qty_w = 13
    disc_w = 13
    rate_w = 24
    amt_w = 26
    tax_w = 18  # per CGST / SGST / IGST column
    n_tax_cols = 1 if is_inter else 2
    desc_w = CW - sr_w - hsn_w - qty_w - disc_w - rate_w - tax_w * n_tax_cols - amt_w

    def _th(txt, w, a="C"):
        pdf.set_fill_color(*BRAND)
        pdf.set_text_color(*WHITE)
        pdf.set_font("Helvetica", "B", 7)
        _cell(pdf, w, 7, txt, align=a, fill=True, nl=False)

    _th("Sr", sr_w)
    _th("Description", desc_w, "L")
    _th("HSN/SAC", hsn_w)
    _th("Qty", qty_w)
    _th("Disc%", disc_w)
    _th("Rate", rate_w, "R")
    if is_inter:
        _th("IGST%", tax_w)
    else:
        _th("CGST%", tax_w)
        _th("SGST%", tax_w)
    _th("Amount", amt_w, "R")
    _cell(pdf, 0, 0, "", nl=True)

    # Compute per-item amounts matching invoice logic
    gst_rate_q = float(q.get("gst_rate", 0))
    items = q.get("items", []) or []

    subtotal = 0.0
    total_discount = 0.0
    total_taxable = 0.0
    total_cgst = 0.0
    total_sgst = 0.0
    total_igst = 0.0

    computed_items = []
    for it in items:
        qty = float(it.get("quantity", 1))
        price = float(it.get("unit_price", 0))
        disc_pct = float(it.get("discount_pct", 0))
        disc = price * qty * disc_pct / 100
        taxable = round(price * qty - disc, 2)
        subtotal += price * qty
        total_discount += disc

        if is_inter:
            igst = round(taxable * gst_rate_q / 100, 2)
            cgst = 0
            sgst = 0
            total_igst += igst
        else:
            half = gst_rate_q / 2
            cgst = round(taxable * half / 100, 2)
            sgst = round(taxable * half / 100, 2)
            total_cgst += cgst
            total_sgst += sgst
            igst = 0

        total_taxable += taxable
        total_amount = round(taxable + cgst + sgst + igst, 2)

        computed_items.append(
            {
                "description": it.get("description", ""),
                "hsn_sac": it.get("hsn_sac", ""),
                "quantity": qty,
                "unit": it.get("unit", "service"),
                "unit_price": price,
                "discount_pct": disc_pct,
                "gst_rate": gst_rate_q,
                "taxable_value": taxable,
                "cgst_rate": 0 if is_inter else gst_rate_q / 2,
                "sgst_rate": 0 if is_inter else gst_rate_q / 2,
                "igst_rate": gst_rate_q if is_inter else 0,
                "cgst_amount": cgst,
                "sgst_amount": sgst,
                "igst_amount": igst,
                "total_amount": total_amount,
            }
        )

    grand_total = round(total_taxable + total_cgst + total_sgst + total_igst, 2)

    for idx, it in enumerate(computed_items, 1):
        row_bg = BL if idx % 2 == 0 else WHITE
        pdf.set_fill_color(*row_bg)
        pdf.set_text_color(*DARK)
        pdf.set_font("Helvetica", "", 7.5)

        _cell(pdf, sr_w, 7, str(idx), align="C", fill=True, nl=False)
        _cell(
            pdf,
            desc_w,
            7,
            _safe_str(it.get("description", ""), 42),
            align="L",
            fill=True,
            nl=False,
        )
        _cell(
            pdf,
            hsn_w,
            7,
            _safe_str(it.get("hsn_sac", "")[:12]),
            align="C",
            fill=True,
            nl=False,
        )
        _cell(
            pdf,
            qty_w,
            7,
            f"{it.get('quantity', 1):.2f}",
            align="C",
            fill=True,
            nl=False,
        )
        _cell(
            pdf,
            disc_w,
            7,
            f"{it.get('discount_pct', 0):.1f}%",
            align="C",
            fill=True,
            nl=False,
        )
        _cell(
            pdf,
            rate_w,
            7,
            f"Rs.{it.get('unit_price', 0):,.2f}",
            align="R",
            fill=True,
            nl=False,
        )
        if is_inter:
            _cell(
                pdf,
                tax_w,
                7,
                f"{it.get('igst_rate', 0):.1f}%",
                align="C",
                fill=True,
                nl=False,
            )
        else:
            _cell(
                pdf,
                tax_w,
                7,
                f"{it.get('cgst_rate', 0):.1f}%",
                align="C",
                fill=True,
                nl=False,
            )
            _cell(
                pdf,
                tax_w,
                7,
                f"{it.get('sgst_rate', 0):.1f}%",
                align="C",
                fill=True,
                nl=False,
            )
        _cell(
            pdf,
            amt_w,
            7,
            f"Rs.{it.get('total_amount', 0):,.2f}",
            align="R",
            fill=True,
            nl=True,
        )

        # Sub-detail line (unit)
        sub_parts = []
        if it.get("unit"):
            sub_parts.append(_safe_str(it["unit"]))
        if sub_parts:
            pdf.set_x(M + sr_w)
            pdf.set_font("Helvetica", "I", 6.5)
            pdf.set_text_color(*MUTED)
            pdf.set_fill_color(*row_bg)
            sub_w = (
                desc_w + hsn_w + qty_w + disc_w + rate_w + tax_w * n_tax_cols + amt_w
            )
            _cell(
                pdf,
                sub_w,
                4,
                _safe_str("  ".join(sub_parts)),
                align="L",
                fill=True,
                nl=True,
            )

    # ═══════════════════════════════════════════════════════
    # TOTALS BLOCK  (matches invoice exactly)
    # ═══════════════════════════════════════════════════════
    def _trow(label, value, bold=False):
        bg = BRAND if bold else BL
        tc = WHITE if bold else DARK
        pdf.set_fill_color(*bg)
        pdf.set_text_color(*tc)
        pdf.set_font("Helvetica", "B" if bold else "", 8 if not bold else 9)
        _cell(pdf, CW - amt_w, 7, label, align="R", fill=True, nl=False)
        _cell(
            pdf, amt_w, 7, f"Rs.{abs(float(value)):,.2f}", align="R", fill=True, nl=True
        )

    pdf.set_x(M)
    _trow("Subtotal", subtotal)
    if total_discount > 0:
        _trow("Discount", total_discount)
    _trow("Taxable Value", total_taxable)

    tt = total_taxable or 1
    if is_inter:
        igst_pct = round(total_igst / tt * 100, 1)
        _trow(f"IGST ({igst_pct:.1f}%)", total_igst)
    else:
        cgst_pct = round(total_cgst / tt * 100, 1)
        sgst_pct = round(total_sgst / tt * 100, 1)
        _trow(f"CGST ({cgst_pct:.1f}%)", total_cgst)
        _trow(f"SGST ({sgst_pct:.1f}%)", total_sgst)

    _trow("GRAND TOTAL", grand_total, bold=True)

    # Amount in words
    pdf.set_x(M)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*MUTED)
    _cell(pdf, CW, 5, _safe_str(_amount_in_words(grand_total)), nl=True)

    # ═══════════════════════════════════════════════════════
    # GST SUMMARY  (matches invoice exactly)
    # ═══════════════════════════════════════════════════════
    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*BRAND)
    _cell(pdf, 0, 5, "GST Summary", nl=True)
    pdf.set_draw_color(*_lighten(BRAND, 0.70))
    pdf.line(M, pdf.get_y(), M + CW, pdf.get_y())
    pdf.ln(1)

    gst_sum = {}
    for it in computed_items:
        r = float(it.get("gst_rate", 0))
        if r not in gst_sum:
            gst_sum[r] = {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0}
        gst_sum[r]["taxable"] += float(it.get("taxable_value", 0))
        gst_sum[r]["cgst"] += float(it.get("cgst_amount", 0))
        gst_sum[r]["sgst"] += float(it.get("sgst_amount", 0))
        gst_sum[r]["igst"] += float(it.get("igst_amount", 0))

    g_w = CW / 5
    pdf.set_fill_color(*BRAND)
    pdf.set_text_color(*WHITE)
    pdf.set_font("Helvetica", "B", 7.5)
    for col_hdr in ["GST Rate", "Taxable Amt", "CGST", "SGST / IGST", "Total GST"]:
        _cell(pdf, g_w, 6, col_hdr, align="C", fill=True, nl=False)
    _cell(pdf, 0, 0, "", nl=True)

    pdf.set_font("Helvetica", "", 7.5)
    for i, (rate, row) in enumerate(sorted(gst_sum.items())):
        pdf.set_fill_color(*(BL if i % 2 == 0 else WHITE))
        pdf.set_text_color(*DARK)
        gst_tot = row["cgst"] + row["sgst"] + row["igst"]
        _cell(pdf, g_w, 6, f"{rate:.1f}%", align="C", fill=True, nl=False)
        _cell(pdf, g_w, 6, f"Rs.{row['taxable']:,.2f}", align="C", fill=True, nl=False)
        _cell(pdf, g_w, 6, f"Rs.{row['cgst']:,.2f}", align="C", fill=True, nl=False)
        _cell(
            pdf,
            g_w,
            6,
            f"Rs.{row['sgst'] or row['igst']:,.2f}",
            align="C",
            fill=True,
            nl=False,
        )
        _cell(pdf, g_w, 6, f"Rs.{gst_tot:,.2f}", align="C", fill=True, nl=True)

    # ═══════════════════════════════════════════════════════
    # SCOPE OF WORK  (quotation-specific)
    # ═══════════════════════════════════════════════════════
    scope = q.get("scope_of_work", []) or []
    if isinstance(scope, str):
        scope = [scope]
    scope = [s for s in scope if s]
    if scope:
        pdf.ln(5)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*BRAND)
        _cell(pdf, 0, 5, "Scope of Work / Services", nl=True)
        pdf.set_draw_color(*_lighten(BRAND, 0.70))
        pdf.line(M, pdf.get_y(), M + CW, pdf.get_y())
        pdf.ln(2)
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(*DARK)
        for s in scope:
            pdf.set_x(M)
            _cell(pdf, 6, 5, "-", align="C", nl=False)
            _mcell(pdf, CW - 6, 5, _safe_str(s))
        pdf.ln(2)

    # ═══════════════════════════════════════════════════════
    # TERMS & NOTES  (matches invoice)
    # ═══════════════════════════════════════════════════════
    all_terms = []
    if q.get("validity_days"):
        all_terms.append(f"Validity of Quotation: {q['validity_days']} days")
    if q.get("payment_terms"):
        all_terms.append(f"Payment Terms: {q['payment_terms']}")
    if q.get("timeline"):
        all_terms.append(f"Timeline: {q['timeline']}")
    if q.get("advance_terms"):
        all_terms.append(f"Advance: {q['advance_terms']}")
    for t in q.get("extra_terms") or []:
        if t:
            all_terms.append(t)

    if all_terms or q.get("notes"):
        pdf.ln(5)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*BRAND)
        _cell(pdf, 0, 5, "Terms & Notes", nl=True)
        pdf.set_draw_color(*_lighten(BRAND, 0.70))
        pdf.line(M, pdf.get_y(), M + CW, pdf.get_y())
        pdf.ln(1)
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(*DARK)
        if all_terms:
            for i, t in enumerate(all_terms, 1):
                pdf.set_x(M)
                _mcell(pdf, CW, 5, _safe_str(f"{i}. {t}"))
        if q.get("notes"):
            pdf.set_x(M)
            pdf.set_font("Helvetica", "I", 8)
            pdf.set_text_color(*MUTED)
            _mcell(pdf, CW, 4, _safe_str(f"Note: {q['notes']}"))

    # ═══════════════════════════════════════════════════════
    # BANK DETAILS  (matches invoice exactly)
    # ═══════════════════════════════════════════════════════
    if company.get("bank_account_no") or company.get("bank_name"):
        pdf.ln(5)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*BRAND)
        _cell(pdf, 0, 5, "Bank Details for Payment", nl=True)
        pdf.set_draw_color(*_lighten(BRAND, 0.70))
        pdf.line(M, pdf.get_y(), M + CW, pdf.get_y())
        pdf.ln(1)
        half_w = CW / 2
        for lbl, val in [
            ("Account Name", company.get("bank_account_name", "")),
            ("Bank Name", company.get("bank_name", "")),
            ("Account No", company.get("bank_account_no", "")),
            ("IFSC Code", company.get("bank_ifsc", "")),
        ]:
            pdf.set_font("Helvetica", "B", 8)
            pdf.set_text_color(*DARK)
            _cell(pdf, half_w * 0.42, 5, _safe_str(f"{lbl}:"), nl=False)
            pdf.set_font("Helvetica", "", 8)
            _cell(pdf, half_w * 0.58, 5, _safe_str(val), nl=True)

    # ═══════════════════════════════════════════════════════
    # DOCUMENT CHECKLIST  (quotation-specific)
    # ═══════════════════════════════════════════════════════
    _svc = q.get("service", "Other / Custom Service")
    _base = SERVICE_CHECKLISTS.get(
        _svc, SERVICE_CHECKLISTS.get("Other / Custom Service", [])
    )
    _extras = [e for e in (q.get("extra_checklist_items") or []) if str(e).strip()]
    _all_docs = _base + _extras

    if _all_docs and q.get("attach_checklist", True):
        pdf.ln(5)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*BRAND)
        _cell(pdf, 0, 5, "Document Checklist", nl=True)
        pdf.set_draw_color(*_lighten(BRAND, 0.70))
        pdf.line(M, pdf.get_y(), M + CW, pdf.get_y())
        pdf.ln(2)
        _csr = 8
        _cdc = CW - _csr
        pdf.set_fill_color(*BRAND)
        pdf.set_text_color(*WHITE)
        pdf.set_font("Helvetica", "B", 7)
        _cell(pdf, _csr, 5, "Sr.", align="C", fill=True, nl=False)
        _cell(pdf, _cdc, 5, "Document Required", fill=True, nl=True)
        for _i, _doc in enumerate(_all_docs, 1):
            _bg = BL if _i % 2 == 0 else WHITE
            _doc_text = _safe_str(_doc, 250)
            pdf.set_fill_color(*_bg)
            pdf.set_text_color(*DARK)
            pdf.set_font("Helvetica", "", 8)
            _row_y = pdf.get_y()
            _cell(pdf, _csr, 5, str(_i), align="C", fill=True, nl=False)
            pdf.set_xy(M + _csr, _row_y)
            pdf.multi_cell(_cdc, 5, _doc_text, align="L", fill=True)
        pdf.ln(2)

    # ═══════════════════════════════════════════════════════
    # SIGNATURE  (matches invoice exactly)
    # ═══════════════════════════════════════════════════════
    pdf.ln(8)
    sig_y = pdf.get_y()
    sig_x = M + CW - 58
    sig_w = 55

    sig_b64 = company.get("signature_base64", "")
    if sig_b64:
        _embed_logo(pdf, sig_b64, x=sig_x, y=sig_y, h=14)
        sig_y += 16

    pdf.set_draw_color(*BRAND)
    pdf.set_line_width(0.4)
    pdf.line(sig_x, sig_y, sig_x + sig_w, sig_y)
    pdf.set_line_width(0.2)

    pdf.set_xy(sig_x, sig_y + 1)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*DARK)
    _cell(
        pdf, sig_w, 5, _safe_str(f"For {company.get('name', '')}"), align="C", nl=True
    )

    pdf.set_x(sig_x)
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(*MUTED)
    _cell(pdf, sig_w, 4, "Authorised Signatory", align="C", nl=True)

    buf = BytesIO()
    buf.write(pdf.output())
    buf.seek(0)
    return buf


def _build_checklist_pdf(q: dict, company: dict) -> BytesIO:
    BRAND = _extract_dominant_color_from_b64(company.get("logo_base64", ""))
    BRAND_DARK = _darken(BRAND, 0.7)
    BRAND_LITE = _lighten(BRAND, 0.88)
    DARK_TEXT = (30, 41, 59)
    MUTED = (100, 116, 139)
    WHITE = (255, 255, 255)

    _q = q
    _MUTED = MUTED

    class PDF(FPDF):
        def header(self):
            pass

        def footer(self):
            self.set_y(-12)
            self.set_font("Helvetica", "I", 7)
            self.set_text_color(*_MUTED)
            _cell(
                self,
                0,
                5,
                _safe_str(
                    f"Document Checklist - {_q.get('client_name', '')}  |  Page {self.page_no()}"
                ),
                align="C",
                nl=True,
            )

    pdf = PDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    W = pdf.w - 28

    # ── Logo ──────────────────────────────────────────────────────────────────
    _embed_logo(pdf, company.get("logo_base64", ""), x=14, y=12, h=16)

    pdf.set_xy(14, 30)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*BRAND_DARK)
    _cell(pdf, 0, 6, _safe_str(company.get("name", "")), nl=True)

    # ── Title band ────────────────────────────────────────────────────────────
    band_y = 50
    pdf.set_fill_color(*BRAND)
    pdf.rect(14, band_y, W, 10, "F")
    pdf.set_xy(14, band_y + 1.5)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(*WHITE)
    _cell(pdf, W, 7, "DOCUMENT CHECKLIST", align="C", nl=True)

    # ── Client info block ─────────────────────────────────────────────────────
    pdf.set_xy(14, band_y + 14)
    pdf.set_fill_color(*BRAND_LITE)
    pdf.rect(14, band_y + 14, W, 20, "F")
    pdf.set_xy(16, band_y + 16)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*DARK_TEXT)
    _cell(
        pdf, W / 2, 5, _safe_str(f"Client Name: {q.get('client_name', '')}"), nl=False
    )
    _cell(pdf, W / 2, 5, _safe_str(f"Date: {q.get('date', '')}"), align="R", nl=True)
    pdf.set_x(16)
    pdf.set_font("Helvetica", "", 9)
    _cell(pdf, W / 2, 5, _safe_str(f"Service: {q.get('service', '')}"), nl=False)
    _cell(
        pdf,
        W / 2,
        5,
        _safe_str(f"Ref: {q.get('quotation_no', '')}"),
        align="R",
        nl=True,
    )
    pdf.set_x(16)
    pdf.set_text_color(*MUTED)
    pdf.set_font("Helvetica", "I", 8)
    _cell(
        pdf,
        0,
        4,
        "All documents must be self-attested. Originals may be required for verification.",
        nl=True,
    )

    # ── Document list ─────────────────────────────────────────────────────────
    service = q.get("service", "Other / Custom Service")
    base_docs = SERVICE_CHECKLISTS.get(
        service, SERVICE_CHECKLISTS["Other / Custom Service"]
    )
    extras = q.get("extra_checklist_items", []) or []
    all_docs = base_docs + extras

    pdf.ln(6)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*BRAND)
    _cell(pdf, 0, 6, "Required Documents", nl=True)
    pdf.set_draw_color(*BRAND)
    pdf.line(14, pdf.get_y(), 14 + W, pdf.get_y())
    pdf.ln(2)

    col_sr = 12
    col_recv = 22
    col_rem = 28
    col_doc = W - col_sr - col_recv - col_rem

    # Table header
    pdf.set_fill_color(*BRAND)
    pdf.set_text_color(*WHITE)
    pdf.set_font("Helvetica", "B", 8)
    _cell(pdf, col_sr, 7, "Sr.", align="C", fill=True, nl=False)
    _cell(pdf, col_doc, 7, "Document Name", fill=True, nl=False)
    _cell(pdf, col_recv, 7, "Received", align="C", fill=True, nl=False)
    _cell(pdf, col_rem, 7, "Remarks", fill=True, nl=True)

    # Table rows
    for idx, doc_name in enumerate(all_docs, 1):
        fill_color = BRAND_LITE if idx % 2 == 0 else WHITE
        pdf.set_fill_color(*fill_color)
        pdf.set_text_color(*DARK_TEXT)
        pdf.set_font("Helvetica", "", 8)
        _cell(pdf, col_sr, 8, str(idx), align="C", fill=True, nl=False)
        _cell(pdf, col_doc, 8, _safe_str(doc_name, max_len=60), fill=True, nl=False)
        _cell(pdf, col_recv, 8, "", align="C", fill=True, border=1, nl=False)
        _cell(pdf, col_rem, 8, "", fill=True, border=1, nl=True)

    # ── Sign-off ──────────────────────────────────────────────────────────────
    pdf.ln(8)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*DARK_TEXT)
    half = W / 2
    _cell(pdf, half, 5, "Checked By: _______________________", nl=False)
    _cell(pdf, half, 5, "Signature: _______________________", align="R", nl=True)

    # ── Client confirmation block ─────────────────────────────────────────────
    pdf.ln(10)
    confirm_y = pdf.get_y()
    pdf.set_fill_color(*BRAND_LITE)
    pdf.rect(14, confirm_y, W, 22, "F")
    pdf.set_xy(16, confirm_y + 2)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*BRAND)
    _cell(pdf, 0, 5, "Client Confirmation", nl=True)
    pdf.set_x(16)
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(*DARK_TEXT)
    _cell(
        pdf,
        0,
        5,
        "I confirm that the above documents have been submitted / will be submitted.",
        nl=True,
    )
    pdf.set_x(16)
    _cell(pdf, 0, 5, "", nl=True)
    pdf.set_x(16)
    _cell(
        pdf,
        0,
        5,
        "Client Signature: _________________________       Date: ______________",
        nl=True,
    )

    return _safe_pdf_output(pdf)


# ═══════════════════════════════════════════════════════════════════════════════
# EMAIL HELPER
# ═══════════════════════════════════════════════════════════════════════════════


def _send_email_with_pdf(
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    from_name: str,
    to_email: str,
    subject: str,
    body: str,
    pdf_bytes: bytes,
    filename: str,
):
    msg = MIMEMultipart()
    msg["From"] = f"{from_name} <{smtp_user}>" if from_name else smtp_user
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    part = MIMEBase("application", "pdf")
    part.set_payload(pdf_bytes)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
    msg.attach(part)

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.starttls()
        server.login(smtp_user, smtp_password)
        server.send_message(msg)


# ═══════════════════════════════════════════════════════════════════════════════
# COMPANY ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════


# ───────────────────────────────────────────────────────────────────────────────
# Company records are ORGANIZATION-WIDE MASTER DATA (Admin → Master Data).
#
# They are created/edited in one place and consumed everywhere (Quotations,
# Invoicing, Trademark Sphere, Bank Accounts, Reports, WhatsApp/Email settings,
# Attendance, Salary Slips ...). Therefore:
#   * READING a company must only require authentication — NOT the
#     `quotations.view` permission, and NOT ownership (`created_by`).
#     Previously a company added by an admin in Master Data was invisible to
#     every other user (empty dropdowns / "Company not found" on some pages
#     while quotation pages worked), because the query was scoped to
#     {"created_by": current_user.id}.
#   * WRITING requires Master Data manage rights OR the legacy quotations
#     permission, so both the new Admin → Master Data screen and the older
#     Quotation/Invoice settings screens keep working.
# ───────────────────────────────────────────────────────────────────────────────

# Fields that must never be exposed to users who cannot manage master data.
_COMPANY_SENSITIVE_FIELDS = ("smtp_password",)


def _can_manage_companies(user: User) -> bool:
    return (
        getattr(user, "role", "") == "admin"
        or bool(_get_perm(user, "can_manage_master_data", False))
        or bool(_get_perm(user, "can_create_quotations", False))
    )


async def require_company_manage(current_user: User = Depends(get_current_user)) -> User:
    """Write access to company master data."""
    if _can_manage_companies(current_user):
        return current_user
    raise HTTPException(
        403,
        "Permission required: Master Data (manage) or Quotations",
    )


def _scrub_company(company: dict, user: User) -> dict:
    if company and not _can_manage_companies(user):
        for f in _COMPANY_SENSITIVE_FIELDS:
            company.pop(f, None)
    return company


async def _hydrate_company_bank(company: dict) -> dict:
    """Overlay the linked bank account details onto a company record."""
    link_id = (company or {}).get("linked_bank_account_id")
    if not link_id:
        return company
    ba = await db.bank_accounts.find_one({"id": link_id}, {"_id": 0})
    if ba:
        company["bank_name"] = ba.get("bank_name", "")
        company["bank_account_name"] = ba.get("account_holder", "")
        company["bank_account_holder"] = ba.get("account_holder", "")
        company["bank_account_no"] = ba.get("account_number_full") or ba.get("account_number_masked", "")
        company["bank_ifsc"] = ba.get("ifsc", "")
        company["bank_branch"] = ba.get("branch", "")
        company["bank_account_type"] = (ba.get("account_type", "current") or "current").capitalize()
        if ba.get("upi_id"):
            company["upi_id"] = ba["upi_id"]
    return company


@router.post("/companies/", include_in_schema=False)
@router.post("/companies")
async def create_company(
    data: dict,
    current_user: User = Depends(require_company_manage),
):
    # Issue #6: permission enforced via Depends above (can_create_quotations)
    now = datetime.now(timezone.utc).isoformat()
    pincode = (data.get("pincode") or "").strip()
    state = (data.get("state") or "").strip()
    state_code = (data.get("state_code") or "").strip()
    if pincode and not state:
        # Auto-derive the company's own state/state-code from its PIN code
        # so invoices can auto-decide CGST+SGST vs IGST (see pincode_lookup.py).
        resolved = get_state_from_pincode(pincode)
        if resolved:
            state = resolved.get("state") or state
            state_code = resolved.get("state_code") or state_code
    doc = {
        "id": str(uuid.uuid4()),
        "name": data.get("name", "").strip(),
        "address": data.get("address", ""),
        "city": data.get("city", ""),
        "pincode": pincode,
        "state": state,
        "state_code": state_code,
        "phone": data.get("phone", ""),
        "email": data.get("email", ""),
        "website": data.get("website", ""),
        "gstin": data.get("gstin", ""),
        "pan": data.get("pan", ""),
        "has_gst": bool(data.get("has_gst", True)),
        "bank_account_name": data.get("bank_account_name", ""),
        "bank_name": data.get("bank_name", ""),
        "bank_account_no": data.get("bank_account_no", ""),
        "bank_ifsc": data.get("bank_ifsc", ""),
        "bank_branch": data.get("bank_branch", ""),
        "bank_account_type": data.get("bank_account_type", "Current"),
        "upi_id": data.get("upi_id", ""),
        # Preferred: the bank's own registered Merchant/UPI QR image (e.g. YONO SBI,
        # BHIM SBI Pay). Bank-certified merchant QRs are treated by the receiving bank
        # as pre-vetted P2M transactions and are far less likely to be declined than a
        # QR we generate ourselves from a raw upi://pay link. When present, invoices
        # render this image directly instead of building a dynamic QR.
        "upi_qr_image_base64": data.get("upi_qr_image_base64"),
        # Optional Merchant Category Code, used to tag our own generated upi://pay
        # link as a merchant (P2M) transaction when no bank QR image is uploaded.
        "upi_mcc": data.get("upi_mcc", ""),
        "linked_bank_account_id": data.get("linked_bank_account_id", ""),
        "logo_base64": data.get("logo_base64"),
        "tm_logo_base64": data.get("tm_logo_base64"),
        "signature_base64": data.get("signature_base64"),
        "smtp_host": data.get("smtp_host", ""),
        "smtp_port": int(data.get("smtp_port", 587)),
        "smtp_user": data.get("smtp_user", ""),
        "smtp_password": data.get("smtp_password", ""),
        "smtp_from_name": data.get("smtp_from_name", ""),
        "created_by": current_user.id,
        "created_at": now,
    }
    if not doc["name"]:
        raise HTTPException(400, "Company name is required")
    await db.companies.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/companies/", include_in_schema=False)
@router.get("/companies")
async def get_companies(
    current_user: User = Depends(get_current_user),
):
    """
    Full company master records, scoped to companies created by the current user.
    Company master records are private creator-owned data; cross-user visibility
    is not permitted.
    """
    list_filter: Dict[str, Any] = {"created_by": str(current_user.id)}
    # Platform Owner operational dropdowns must never expose commercial-license
    # tenant companies. Those companies are managed through Commercial Console.
    if is_platform_owner(current_user):
        # Legacy licensee records may pre-date the commercial marker fields.
        # Resolve customer/license ownership as well, so they cannot leak into
        # Platform Owner operational company selectors.
        commercial_customers = await db.commercial_license_customers.find(
            {}, {"_id": 0, "id": 1}
        ).to_list(5000)
        commercial_licenses = await db.commercial_licenses.find(
            {}, {"_id": 0, "customer_id": 1, "company_id": 1}
        ).to_list(5000)
        legacy_licensee_ids = {
            str(item.get("id")).strip()
            for item in commercial_customers
            if item.get("id")
        }
        legacy_licensee_ids.update(
            str(item.get("company_id")).strip()
            for item in commercial_licenses
            if item.get("company_id")
        )
        legacy_licensee_ids.update(
            str(item.get("customer_id")).strip()
            for item in commercial_licenses
            if item.get("customer_id")
        )
        list_filter = {
            "created_by": str(current_user.id),
            "$and": [
                {"$or": [
                    {"source": {"$exists": False}},
                    {"source": {"$nin": ["commercial-license", "commercial", "license"]}},
                ]},
                {"$or": [
                    {"commercial_customer_id": {"$exists": False}},
                    {"commercial_customer_id": {"$in": [None, "", "platform-owner"]}},
                ]},
                {"$or": [
                    {"license_id": {"$exists": False}},
                    {"license_id": {"$in": [None, "", "platform-owner-license"]}},
                ]},
            ],
        }
        if legacy_licensee_ids:
            list_filter["id"] = {"$nin": sorted(legacy_licensee_ids)}
    tenant_company_id = str(getattr(current_user, "company_id", "") or "").strip()
    tenant_customer_id = str(getattr(current_user, "commercial_customer_id", "") or "").strip()
    if not is_platform_owner(current_user) and tenant_company_id and str(getattr(current_user, "role", "") or "").lower() == "admin":
        owned_filters: List[Dict[str, Any]] = [
            {"created_by": str(current_user.id)},
            {"id": tenant_company_id},
        ]
        if tenant_customer_id:
            owned_filters.append({"commercial_customer_id": tenant_customer_id})
        list_filter = {"$or": owned_filters}
    companies = await db.companies.find(
        list_filter, {"_id": 0}
    ).sort("name", 1).to_list(500)
    for c in companies:
        await _hydrate_company_bank(c)
        _scrub_company(c, current_user)
    return companies


@router.get("/companies/list")
async def list_companies(current_user: User = Depends(get_current_user)):
    """
    Company list for cross-module dropdowns and document rendering (Users,
    Attendance, Reports, Invoicing, Trademark Sphere, Bank Accounts ...).

    Requires authentication only and is strictly scoped by `created_by` so each
    user can access only companies they created.

    Returns the display fields pages actually need (previously only
    id/name/gstin/has_gst, which made some pages show blank
    address/bank/logo details while others worked).
    """
    projection = {
        "_id": 0,
        "id": 1,
        "name": 1,
        "address": 1,
        "city": 1,
        "pincode": 1,
        "state": 1,
        "state_code": 1,
        "phone": 1,
        "email": 1,
        "website": 1,
        "gstin": 1,
        "pan": 1,
        "has_gst": 1,
        "bank_account_name": 1,
        "bank_name": 1,
        "bank_account_no": 1,
        "bank_ifsc": 1,
        "bank_branch": 1,
        "bank_account_type": 1,
        "upi_id": 1,
        "upi_qr_image_base64": 1,
        "upi_mcc": 1,
        "linked_bank_account_id": 1,
        "logo_base64": 1,
        "tm_logo_base64": 1,
        "signature_base64": 1,
        # Tenant markers are returned so client-side selectors can apply the
        # same commercial isolation rule during rolling frontend deployments.
        "source": 1,
        "commercial_customer_id": 1,
        "license_id": 1,
    }
    # Licensed (commercial) tenant admins always own their tenant's operational
    # company record, which is created by license generation and therefore has
    # no `created_by` matching the admin. Without this clause a licensee admin
    # gets an empty list (or, worse, a stale list cached from another session),
    # and every report call is then sent with a company_id that the tenant
    # guard rejects with 403 "Cross-company access is not permitted".
    list_filter: Dict[str, Any] = {"created_by": str(current_user.id)}
    # Platform Owner must receive only its own operational companies here.
    # Licensee companies remain available only through Commercial Console.
    if is_platform_owner(current_user):
        # Legacy licensee records may pre-date the commercial marker fields.
        commercial_customers = await db.commercial_license_customers.find(
            {}, {"_id": 0, "id": 1}
        ).to_list(5000)
        commercial_licenses = await db.commercial_licenses.find(
            {}, {"_id": 0, "customer_id": 1, "company_id": 1}
        ).to_list(5000)
        legacy_licensee_ids = {
            str(item.get("id")).strip()
            for item in commercial_customers
            if item.get("id")
        }
        legacy_licensee_ids.update(
            str(item.get("company_id")).strip()
            for item in commercial_licenses
            if item.get("company_id")
        )
        legacy_licensee_ids.update(
            str(item.get("customer_id")).strip()
            for item in commercial_licenses
            if item.get("customer_id")
        )
        list_filter = {
            "created_by": str(current_user.id),
            "$and": [
                {"$or": [
                    {"source": {"$exists": False}},
                    {"source": {"$nin": ["commercial-license", "commercial", "license"]}},
                ]},
                {"$or": [
                    {"commercial_customer_id": {"$exists": False}},
                    {"commercial_customer_id": {"$in": [None, "", "platform-owner"]}},
                ]},
                {"$or": [
                    {"license_id": {"$exists": False}},
                    {"license_id": {"$in": [None, "", "platform-owner-license"]}},
                ]},
            ],
        }
        if legacy_licensee_ids:
            list_filter["id"] = {"$nin": sorted(legacy_licensee_ids)}
    tenant_company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if (
        not is_platform_owner(current_user)
        and tenant_company_id
        and str(getattr(current_user, "role", "") or "").lower() == "admin"
        and getattr(current_user, "commercial_customer_id", None)
    ):
        list_filter = {"$or": [{"created_by": str(current_user.id)}, {"id": tenant_company_id}]}
    companies = await db.companies.find(list_filter, projection).sort("name", 1).to_list(500)
    for c in companies:
        await _hydrate_company_bank(c)
    return companies


@router.get("/companies/{company_id}")
async def get_company(company_id: str, current_user: User = Depends(get_current_user)):
    """Single company record — used by pages that only know a company_id."""
    owner_scope = {"id": company_id, "created_by": str(current_user.id)}
    if (
        not is_platform_owner(current_user)
        and str(getattr(current_user, "role", "") or "").lower() == "admin"
        and str(getattr(current_user, "company_id", "") or "").strip()
    ):
        tenant_company_id = str(getattr(current_user, "company_id") or "").strip()
        tenant_customer_id = str(getattr(current_user, "commercial_customer_id") or "").strip()
        owned_filters: List[Dict[str, Any]] = [
            {"created_by": str(current_user.id)},
            {"id": tenant_company_id},
        ]
        if tenant_customer_id:
            owned_filters.append({"commercial_customer_id": tenant_customer_id})
        owner_scope = {"id": company_id, "$or": owned_filters}
    if is_platform_owner(current_user):
        # Platform Owner manages its own operational Company Master records.
        # Commercial-license companies remain isolated in the Commercial Console.
        owner_scope = {
            "id": company_id,
            "source": {"$nin": ["commercial-license", "commercial", "license"]},
            "commercial_customer_id": {"$in": [None, ""]},
        }
    company = await db.companies.find_one(owner_scope, {"_id": 0})
    if not company:
        raise HTTPException(404, "Company not found")
    await _hydrate_company_bank(company)
    return _scrub_company(company, current_user)


@router.put("/companies/{company_id}")
async def update_company(
    company_id: str,
    data: dict,
    current_user: User = Depends(require_company_manage),
):
    company_scope = {"id": company_id, "created_by": str(current_user.id)}
    if (
        not is_platform_owner(current_user)
        and str(getattr(current_user, "role", "") or "").lower() == "admin"
        and str(getattr(current_user, "company_id", "") or "").strip()
    ):
        tenant_company_id = str(getattr(current_user, "company_id") or "").strip()
        tenant_customer_id = str(getattr(current_user, "commercial_customer_id") or "").strip()
        owned_filters: List[Dict[str, Any]] = [
            {"created_by": str(current_user.id)},
            {"id": tenant_company_id},
        ]
        if tenant_customer_id:
            owned_filters.append({"commercial_customer_id": tenant_customer_id})
        company_scope = {"id": company_id, "$or": owned_filters}
    if is_platform_owner(current_user):
        # Platform Owner Company Master is separate from commercial license
        # tenants. Allow editing only non-commercial operational companies.
        company_scope = {
            "id": company_id,
            "source": {"$nin": ["commercial-license", "commercial", "license"]},
            "commercial_customer_id": {"$in": [None, ""]},
        }
    existing = await db.companies.find_one(company_scope, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Company not found")
    allowed = [
        "name",
        "address",
        "city",
        "pincode",
        "state",
        "state_code",
        "phone",
        "email",
        "website",
        "gstin",
        "pan",
        "has_gst",
        "bank_account_name",
        "bank_name",
        "bank_account_no",
        "bank_ifsc",
        "bank_branch",
        "bank_account_type",
        "upi_id",
        "upi_qr_image_base64",
        "upi_mcc",
        "bank_account_holder",
        "linked_bank_account_id",
        "logo_base64",
        "tm_logo_base64",
        "signature_base64",
        "smtp_host",
        "smtp_port",
        "smtp_user",
        "smtp_password",
        "smtp_from_name",
    ]
    # Allow explicit null to clear tm_logo_base64 / upi_qr_image_base64
    update = {
        k: data[k]
        for k in allowed
        if k in data and (data[k] is not None or k in ("tm_logo_base64", "upi_qr_image_base64"))
    }
    # If a PIN code was set/changed but state wasn't sent explicitly, auto-derive
    # it server-side too (frontend already does this live, this is a safety net).
    if update.get("pincode") and not update.get("state"):
        resolved = get_state_from_pincode(update["pincode"])
        if resolved:
            update["state"] = resolved.get("state") or ""
            update["state_code"] = resolved.get("state_code") or ""
    await db.companies.update_one(company_scope, {"$set": update})
    updated = await db.companies.find_one(company_scope, {"_id": 0})
    # Keep the Bank Accounts page in sync: mirror the company's primary
    # bank details into the bank_accounts collection whenever they change
    # here (Invoice/Quotation settings both save through this endpoint).
    try:
        from backend.bank_accounts import sync_company_primary_bank_account
        await sync_company_primary_bank_account(updated)
    except Exception:
        pass
    return updated


@router.delete("/companies/{company_id}")
async def delete_company(
    company_id: str,
    current_user: User = Depends(require_company_manage),
):
    company_scope = {"id": company_id, "created_by": str(current_user.id)}
    if (
        not is_platform_owner(current_user)
        and str(getattr(current_user, "role", "") or "").lower() == "admin"
        and str(getattr(current_user, "company_id", "") or "").strip()
    ):
        tenant_company_id = str(getattr(current_user, "company_id") or "").strip()
        tenant_customer_id = str(getattr(current_user, "commercial_customer_id") or "").strip()
        owned_filters: List[Dict[str, Any]] = [
            {"created_by": str(current_user.id)},
            {"id": tenant_company_id},
        ]
        if tenant_customer_id:
            owned_filters.append({"commercial_customer_id": tenant_customer_id})
        company_scope = {"id": company_id, "$or": owned_filters}
    if is_platform_owner(current_user):
        company_scope = {
            "id": company_id,
            "source": {"$nin": ["commercial-license", "commercial", "license"]},
            "commercial_customer_id": {"$in": [None, ""]},
        }
    existing = await db.companies.find_one(company_scope, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Company not found")
    await db.companies.delete_one(company_scope)
    return {"message": "Company deleted"}


# ═══════════════════════════════════════════════════════════════════════════════
# QUOTATION ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/quotations/next-number")
async def get_next_quotation_number(
    company_id: str = Query(..., description="Company ID to scope the numbering"),
    prefix: str = Query("QTN", description="Custom prefix from Quotation Settings"),
    separator: str = Query("/", description="Separator character"),
    include_fy: bool = Query(True, description="Include financial year in number"),
    fy_format: str = Query("short", description="FY format: short=25-26, long=2025-2026"),
    include_month: bool = Query(False, description="Include month in number"),
    number_padding: int = Query(3, description="Zero-pad width for sequential number"),
    current_user: User = Depends(check_module_permission("quotations", "view")),
):
    """
    Returns the next available quotation number, scoped per company and
    MAX-based (scans existing quotation numbers for that company) so it
    always continues correctly from the previous quotation for that
    company -- regardless of deletions/renames or how many other companies
    exist in the system.
    """
    next_no = await _next_qtn_number(
        company_id=company_id,
        prefix=prefix,
        separator=separator,
        include_fy=include_fy,
        fy_format=fy_format,
        include_month=include_month,
        number_padding=number_padding,
    )
    return {"number": next_no}


@router.get("/quotations/services")
async def get_services(
    _: User = Depends(check_module_permission("quotations", "view")),
):
    return {"services": ALL_SERVICES, "checklists": SERVICE_CHECKLISTS}


@router.post("/quotations/", include_in_schema=False)
@router.post("/quotations")
async def create_quotation(
    data: QuotationCreate,
    current_user: User = Depends(check_module_permission("quotations", "create")),
):

    computed_items = []
    for item in data.items:
        item.amount = _compute_item_amount(item)
        computed_items.append(item)

    # Only a GST-registered issuing company may charge GST — never decided
    # by whether the buyer/client has a GSTIN. Force the rate to zero here
    # so it can't be bypassed by whatever gst_rate the request sent.
    if not await _company_has_gst(data.company_id):
        data.gst_rate = 0.0

    subtotal, gst_amount, total = _compute_totals(computed_items, data.gst_rate)
    now = datetime.now(timezone.utc).isoformat()

    # Use frontend-supplied number if provided (after a duplicate check,
    # scoped to the same company); otherwise auto-generate one that
    # continues correctly from this company's previous quotation.
    requested_no = (data.quotation_no or "").strip()
    if requested_no:
        dup_filter: dict = {"quotation_no": requested_no}
        if data.company_id:
            dup_filter["company_id"] = data.company_id
        conflict = await db.quotations.find_one(dup_filter)
        if conflict:
            raise HTTPException(400, f"Quotation number '{requested_no}' is already in use. Please choose a different number.")
        qtn_no = requested_no
    else:
        # Fallback: auto-generate scoped to this company. This path is a
        # safety net for callers that don't pre-fetch a number via
        # /quotations/next-number.
        qtn_no = await _next_qtn_number(company_id=data.company_id)

    doc = {
        "id": str(uuid.uuid4()),
        "quotation_no": qtn_no,
        "date": date.today().isoformat(),
        **data.model_dump(exclude={"quotation_no"}),
        "items": [i.model_dump() for i in computed_items],
        "subtotal": subtotal,
        "gst_amount": gst_amount,
        "total": total,
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    await db.quotations.insert_one(doc)
    doc.pop("_id", None)

    if data.lead_id:
        await _update_lead_status_for_quotation(data.lead_id, "proposal")

    return doc


@router.get("/quotations/list", include_in_schema=False)
@router.get("/quotations/list/", include_in_schema=False)
@router.get("/quotations/", include_in_schema=False)
@router.get("/quotations")
async def list_quotations(
    status: Optional[str] = None,
    service: Optional[str] = None,
    lead_id: Optional[str] = None,
    current_user: User = Depends(check_module_permission("quotations", "view")),
):

    query: Dict[str, Any] = {}
    if current_user.role != "admin":
        query["created_by"] = current_user.id
    if status:
        query["status"] = status
    if service:
        query["service"] = service
    if lead_id:
        query["lead_id"] = lead_id

    quotations = (
        await db.quotations.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    )
    return quotations


@router.get("/quotations/{quotation_id}")
async def get_quotation(
    quotation_id: str,
    current_user: User = Depends(check_module_permission("quotations", "view")),
):
    q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not q:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and q.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")
    return q


@router.put("/quotations/{quotation_id}")
async def update_quotation(
    quotation_id: str,
    data: dict,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):
    existing = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and existing.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")

    items_raw = data.get("items", existing.get("items", []))
    items = []
    for i in items_raw:
        if isinstance(i, dict):
            item = QuotationItem(**i)
            item.amount = _compute_item_amount(item)
            items.append(item)

    gst_rate = float(data.get("gst_rate", existing.get("gst_rate", 18)))
    effective_company_id = data.get("company_id") or existing.get("company_id")
    if not await _company_has_gst(effective_company_id):
        gst_rate = 0.0
        data["gst_rate"] = 0.0
    subtotal, gst_amount, total = _compute_totals(items, gst_rate)

    data["items"] = [i.model_dump() for i in items]
    data["subtotal"] = subtotal
    data["gst_amount"] = gst_amount
    data["total"] = total
    data["updated_at"] = datetime.now(timezone.utc).isoformat()

    for f in ["id", "quotation_no", "created_by", "created_at"]:
        data.pop(f, None)

    await db.quotations.update_one({"id": quotation_id}, {"$set": data})

    new_status = data.get("status")
    lead_id = data.get("lead_id") or existing.get("lead_id")
    if lead_id and new_status:
        if new_status == "sent":
            await _update_lead_status_for_quotation(lead_id, "proposal")
        elif new_status == "accepted":
            await _update_lead_status_for_quotation(lead_id, "negotiation")

    updated = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    return updated


# ═══════════════════════════════════════════════════════════════════════════════
# MANUAL INVOICE LINK / UNLINK
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/quotations/{quotation_id}/link-invoice")
async def link_invoice_to_quotation(
    quotation_id: str,
    payload: dict,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):
    """
    Manually link an existing invoice to a quotation (two-way).
    Body: { "invoice_id": "<invoice_uuid>" }

    Writes:
      quotation.invoice_id  = invoice.id
      quotation.invoice_no  = invoice.invoice_no
      invoice.quotation_id  = quotation.id
    """
    invoice_id = (payload.get("invoice_id") or "").strip()
    if not invoice_id:
        raise HTTPException(400, "invoice_id is required")

    qtn = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not qtn:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and qtn.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")

    inv = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")

    # A quotation and its invoice are financial records in the same legal
    # company. Never allow a cross-company link, even for an administrator.
    quotation_company = str(qtn.get("company_id") or "").strip()
    invoice_company = str(inv.get("company_id") or "").strip()
    if quotation_company != invoice_company:
        raise HTTPException(403, "Quotation and invoice must belong to the same company.")

    now = datetime.now(timezone.utc).isoformat()

    # If this invoice was previously linked to a different quotation, clear that link.
    old_qtn_id = inv.get("quotation_id")
    if old_qtn_id and old_qtn_id != quotation_id:
        await db.quotations.update_one(
            {"id": old_qtn_id},
            {"$set": {"invoice_id": None, "invoice_no": None, "updated_at": now}},
        )

    # If this quotation was previously linked to a different invoice, clear that link.
    old_inv_id = qtn.get("invoice_id")
    if old_inv_id and old_inv_id != invoice_id:
        await db.invoices.update_one(
            {"id": old_inv_id},
            {"$set": {"quotation_id": None, "updated_at": now}},
        )

    # Write the forward link on the quotation.
    await db.quotations.update_one(
        {"id": quotation_id},
        {
            "$set": {
                "invoice_id": invoice_id,
                "invoice_no": inv.get("invoice_no", ""),
                "updated_at": now,
            }
        },
    )

    # Write the reverse link on the invoice.
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {"quotation_id": quotation_id, "updated_at": now}},
    )

    updated = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    return updated


@router.delete("/quotations/{quotation_id}/link-invoice")
async def unlink_invoice_from_quotation(
    quotation_id: str,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):
    """
    Remove the manual (or converted) invoice link from a quotation (two-way).
    Clears quotation.invoice_id / quotation.invoice_no and invoice.quotation_id.
    """
    qtn = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not qtn:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and qtn.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")

    now = datetime.now(timezone.utc).isoformat()
    linked_inv_id = qtn.get("invoice_id")

    # Clear the forward link on the quotation.
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$set": {"invoice_id": None, "invoice_no": None, "updated_at": now}},
    )

    # Clear the reverse link on the invoice (if we know which invoice it was).
    if linked_inv_id:
        await db.invoices.update_one(
            {"id": linked_inv_id},
            {"$set": {"quotation_id": None, "updated_at": now}},
        )

    updated = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    return updated


@router.delete("/quotations/{quotation_id}")
async def delete_quotation(
    quotation_id: str,
    current_user: User = Depends(check_module_permission("quotations", "delete")),
):
    existing = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and existing.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")
    await db.quotations.delete_one({"id": quotation_id})
    return {"message": "Quotation deleted"}


# ═══════════════════════════════════════════════════════════════════════════════
# PDF EXPORT ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/quotations/{quotation_id}/pdf")
async def export_quotation_pdf(
    quotation_id: str,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):

    q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not q:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and q.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")

    company = await db.companies.find_one({"id": q.get("company_id")}, {"_id": 0})
    if not company:
        raise HTTPException(
            404, "Company profile not found. Please add a company profile first."
        )

    try:
        pdf_buf = _build_quotation_pdf(q, company)
    except Exception as e:
        logger.error(
            f"Quotation PDF build failed for {quotation_id}: {e}", exc_info=True
        )
        raise HTTPException(500, f"PDF generation failed: {str(e)}")

    pdf_bytes = pdf_buf.getvalue()

    # Company name prefix in filename
    company_prefix = (
        (company.get("name", "") or "")
        .strip()
        .replace(" ", "_")
        .replace("/", "_")
        .replace("\\", "_")
    )
    safe_qtn_no = (
        (q.get("quotation_no", quotation_id) or quotation_id)
        .replace("/", "-")
        .replace("\\", "-")
    )
    filename = (
        f"{company_prefix}_Quotation_{safe_qtn_no}.pdf"
        if company_prefix
        else f"Quotation_{safe_qtn_no}.pdf"
    )

    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
            "Cache-Control": "no-cache",
        },
    )


@router.get("/quotations/{quotation_id}/checklist-pdf")
async def export_checklist_pdf(
    quotation_id: str,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):

    q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not q:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and q.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")
    if not q.get("attach_checklist", True):
        raise HTTPException(400, "Document checklist is disabled for this quotation")

    company = await db.companies.find_one({"id": q.get("company_id")}, {"_id": 0})
    if not company:
        raise HTTPException(
            404, "Company profile not found. Please add a company profile first."
        )

    try:
        pdf_buf = _build_checklist_pdf(q, company)
    except Exception as e:
        logger.error(
            f"Checklist PDF build failed for {quotation_id}: {e}", exc_info=True
        )
        raise HTTPException(500, f"PDF generation failed: {str(e)}")

    pdf_bytes = pdf_buf.getvalue()

    company_prefix = (
        (company.get("name", "") or "")
        .strip()
        .replace(" ", "_")
        .replace("/", "_")
        .replace("\\", "_")
    )
    safe_qtn_no = (
        (q.get("quotation_no", quotation_id) or quotation_id)
        .replace("/", "-")
        .replace("\\", "-")
    )
    filename = (
        f"{company_prefix}_Checklist_{safe_qtn_no}.pdf"
        if company_prefix
        else f"Checklist_{safe_qtn_no}.pdf"
    )

    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
            "Cache-Control": "no-cache",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# EMAIL SEND ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/quotations/{quotation_id}/send-email")
async def send_quotation_email(
    quotation_id: str,
    req: EmailSendRequest,
    current_user: User = Depends(check_module_permission("quotations", "edit")),
):

    q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not q:
        raise HTTPException(404, "Quotation not found")
    if current_user.role != "admin" and q.get("created_by") != current_user.id:
        raise HTTPException(403, "Not authorized")

    company = await db.companies.find_one({"id": q.get("company_id")}, {"_id": 0})
    if not company:
        raise HTTPException(404, "Company profile not found")

    smtp_host = company.get("smtp_host", "").strip()
    smtp_user = company.get("smtp_user", "").strip()
    smtp_pass = company.get("smtp_password", "").strip()
    if not smtp_host or not smtp_user or not smtp_pass:
        raise HTTPException(
            400, "SMTP not configured. Please add SMTP settings to the company profile."
        )

    # Company name prefix in filename
    company_prefix = (
        (company.get("name", "") or "")
        .strip()
        .replace(" ", "_")
        .replace("/", "_")
        .replace("\\", "_")
    )
    safe_qtn_no = (
        (q.get("quotation_no", quotation_id) or quotation_id)
        .replace("/", "-")
        .replace("\\", "-")
    )

    try:
        if req.pdf_type == "checklist":
            pdf_buf = _build_checklist_pdf(q, company)
            filename = (
                f"{company_prefix}_Checklist_{safe_qtn_no}.pdf"
                if company_prefix
                else f"Checklist_{safe_qtn_no}.pdf"
            )
        else:
            pdf_buf = _build_quotation_pdf(q, company)
            filename = (
                f"{company_prefix}_Quotation_{safe_qtn_no}.pdf"
                if company_prefix
                else f"Quotation_{safe_qtn_no}.pdf"
            )
    except Exception as e:
        logger.error(f"PDF build failed for email: {e}", exc_info=True)
        raise HTTPException(500, f"PDF generation failed: {str(e)}")

    subject = (
        req.subject
        or f"Quotation {q.get('quotation_no', '')} from {company.get('name', '')}"
    )
    body = req.body or (
        f"Dear {q.get('client_name', 'Sir/Madam')},\n\n"
        f"Please find attached our quotation {q.get('quotation_no', '')} "
        f"for {q.get('service', '')}.\n\n"
        f"Total Amount: Rs. {q.get('total', 0):,.2f}\n\n"
        f"Validity: {q.get('validity_days', 30)} days\n\n"
        f"Regards,\n{company.get('name', '')}"
    )

    try:
        _send_email_with_pdf(
            smtp_host=smtp_host,
            smtp_port=int(company.get("smtp_port", 587)),
            smtp_user=smtp_user,
            smtp_password=smtp_pass,
            from_name=company.get("smtp_from_name", company.get("name", "")),
            to_email=req.to_email,
            subject=subject,
            body=body,
            pdf_bytes=pdf_buf.getvalue(),
            filename=filename,
        )
    except smtplib.SMTPAuthenticationError:
        raise HTTPException(
            400,
            "SMTP authentication failed. Check username/password in company profile.",
        )
    except Exception as e:
        logger.error(f"Email send failed: {e}", exc_info=True)
        raise HTTPException(500, f"Email send failed: {str(e)}")

    return {"message": f"Email sent successfully to {req.to_email}"}
