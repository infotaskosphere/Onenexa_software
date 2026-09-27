"""
ROC Sphere — Companies Act (India) compliance & document automation module.

Self-contained backend router. Nothing here is imported by any other
existing module, so dropping this file into backend/ does not touch any
existing behaviour. It is wired into the app with exactly two lines in
server.py (see INTEGRATION.md):

    from backend.roc_sphere import router as roc_sphere_router
    api_router.include_router(roc_sphere_router)

Covers:
  - Company master (linked to an existing Client, or standalone)
  - Directors / shareholders register
  - Upload & best-effort parse of AOC-4 / MGT-7 / MGT-7A / ADT-1 / DPT-3
    PDFs plus the separate macro-enabled MGT-7A shareholder workbook
  - Share-transfer register, SH-4 instrument and share-certificate drafts
  - Companies Act 2013 compliance checklist engine (heuristic, based on
    company category/size — see COMPLIANCE_RULES below)
  - Word (.docx) generation for: Board Resolution, Notice of Meeting
    (Board/EGM/AGM), Minutes of Meeting (Board/General), Register of
    Members / List of Shareholders, and a printable Compliance Checklist

IMPORTANT — legal disclaimer baked into the product, not just this
comment: MCA thresholds and formats change (e.g. the "small company"
paid-up capital/turnover limits were revised effective 1 Dec 2025). The
checklist engine is a drafting aid, not a substitute for a professional's
judgement, and COMPLIANCE_RULES should be reviewed periodically against
the current Companies Act / MCA rules.
"""

import io
import logging
import base64
import re
import uuid
from datetime import datetime, timezone, date, timedelta
from typing import Optional, List, Any, Dict

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, ConfigDict

from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

from backend.dependencies import db, get_current_user, check_module_permission
from backend.models import User

# Permission flags used here (see backend/models.py DEFAULT_ROLE_PERMISSIONS
# and backend/dependencies.py MODULE_ACTION_MAP):
#   can_view_roc_sphere   — open the page, view company masters/checklist,
#                            generate & download documents
#   can_manage_roc_sphere — create/edit/delete company masters, upload
#                            AOC-4/MGT-7 to prefill them
# Admin-granted-only by default (same pattern as GST Reconciliation,
# Trademark Sphere and the Salary Slip Generator) — toggled per-user from
# Settings → Permission Governance → Compliance → "ROC Sphere".
VIEW = check_module_permission("roc_sphere", "view")
CREATE = check_module_permission("roc_sphere", "create")
EDIT = check_module_permission("roc_sphere", "edit")
DELETE = check_module_permission("roc_sphere", "delete")

logger = logging.getLogger("roc_sphere")
router = APIRouter(prefix="/roc-sphere", tags=["roc-sphere"])

COMPANIES = db.roc_companies
DOCS_LOG = db.roc_documents
CLIENTS = db.clients

COMPANY_CLIENT_TYPES = {"pvt_ltd", "PVT_LTD", "public_ltd", "section_8", "llp", "LLP", "opc"}


def _uid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _who(user: User) -> str:
    return getattr(user, "full_name", None) or getattr(user, "username", None) or "—"


def _fmt_date(v: Any) -> str:
    if not v:
        return "—"
    if isinstance(v, (datetime, date)):
        return v.strftime("%d-%m-%Y")
    s = str(v)
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s[:10], fmt).strftime("%d-%m-%Y")
        except ValueError:
            continue
    return s


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ─────────────────────────────────────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────────────────────────────────────

class Director(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    din: Optional[str] = None
    designation: Optional[str] = "Director"  # Director / Managing Director / Whole-time Director / Additional Director
    date_of_appointment: Optional[str] = None
    date_of_cessation: Optional[str] = None
    pan: Optional[str] = None
    address: Optional[str] = None


class Shareholder(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    folio_no: Optional[str] = None
    pan: Optional[str] = None
    holder_type: Optional[str] = None
    category: Optional[str] = None
    details: Optional[str] = None
    class_of_shares: Optional[str] = "Equity"
    security_type: Optional[str] = None
    nationality: Optional[str] = None
    gender: Optional[str] = None
    identifier_type: Optional[str] = None
    occupation: Optional[str] = None
    shares_held: float = 0
    face_value: Optional[float] = 10
    total_value: Optional[float] = None
    percentage: Optional[float] = None
    address: Optional[str] = None


class ShareTransferRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    transfer_date: Optional[str] = None
    transferor_name: str
    transferee_name: str
    transferor_folio_no: Optional[str] = None
    transferee_folio_no: Optional[str] = None
    share_certificate_no: Optional[str] = None
    distinctive_from: Optional[str] = None
    distinctive_to: Optional[str] = None
    number_of_shares: float = 0
    class_of_shares: str = "Equity"
    nominal_value_per_share: float = 10
    consideration: float = 0
    stamp_duty: float = 0
    board_resolution_date: Optional[str] = None
    instrument_date: Optional[str] = None
    instrument_received_date: Optional[str] = None
    sh4_status: str = "Pending review"
    remarks: Optional[str] = None
    update_register: bool = True


class ShareCertificateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    certificate_no: str
    issue_date: Optional[str] = None
    holder_name: str
    holder_address: Optional[str] = None
    folio_no: Optional[str] = None
    class_of_shares: str = "Equity"
    number_of_shares: float = 0
    distinctive_from: Optional[str] = None
    distinctive_to: Optional[str] = None
    nominal_value_per_share: float = 10
    amount_paid_per_share: float = 0
    joint_holders: List[str] = Field(default_factory=list)
    remarks: Optional[str] = None


class CSPracticeRunRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    financial_year: Optional[str] = None
    assignee_id: Optional[str] = None
    lead_days: int = Field(default=15, ge=0, le=90)
    include_review_tasks: bool = True
    replace_existing: bool = False


class Auditor(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    firm_reg_no: Optional[str] = None
    membership_no: Optional[str] = None
    appointed_from: Optional[str] = None
    appointed_till: Optional[str] = None


class RocCompanyIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    client_id: Optional[str] = None
    company_name: str
    cin: Optional[str] = None
    category: str = "private"          # private | public | opc | section_8 | llp
    is_small_company: Optional[bool] = None   # None = auto-compute from capital/turnover
    listed: bool = False
    roc_office: Optional[str] = None
    pan: Optional[str] = None
    date_of_incorporation: Optional[str] = None
    registered_office_address: Optional[str] = None
    authorized_capital: Optional[float] = 0
    paid_up_capital: Optional[float] = 0
    last_year_turnover: Optional[float] = 0
    financial_year_end: Optional[str] = "31-03"
    last_agm_date: Optional[str] = None
    last_board_meeting_date: Optional[str] = None
    directors: List[Director] = Field(default_factory=list)
    designated_partners: List[Director] = Field(default_factory=list)
    partners: List[Director] = Field(default_factory=list)
    shareholders: List[Shareholder] = Field(default_factory=list)
    master_data: Dict[str, Any] = Field(default_factory=dict)
    mgt_shareholder_data: Dict[str, Any] = Field(default_factory=dict)
    financial_data: Dict[str, Any] = Field(default_factory=dict)  # key figures pulled from AOC-4 (see FINANCIAL_DATA_FIELDS)
    annual_return_data: Dict[str, Any] = Field(default_factory=dict)
    audit_report_data: Dict[str, Any] = Field(default_factory=dict)
    board_report_data: Dict[str, Any] = Field(default_factory=dict)
    # Structured ADT-1 auditor appointment data, retained separately from the
    # compact auditor card so all filed appointment particulars remain available.
    adt1_data: Dict[str, Any] = Field(default_factory=dict)
    # Structured DPT-3 return data: deposits, non-deposit loans, liquid assets,
    # charges and filing/signatory metadata, retained by financial year.
    dpt3_data: Dict[str, Any] = Field(default_factory=dict)
    share_transfers: List[Dict[str, Any]] = Field(default_factory=list)
    share_certificates: List[Dict[str, Any]] = Field(default_factory=list)
    # Persistent meeting / event history used by MGT-7/MGT-7A preparation.
    # Stored with the company master so it survives page refreshes and deployments.
    record_history: List[Dict[str, Any]] = Field(default_factory=list)
    roc_form_uploads: List[Dict[str, Any]] = Field(default_factory=list)
    auditor: Optional[Auditor] = None
    notes: Optional[str] = None


class RocCompanyOut(RocCompanyIn):
    id: str
    created_at: datetime
    updated_at: datetime
    created_by: Optional[str] = None


class ResolutionItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    particulars: str                 # short heading, e.g. "Opening of Bank Account"
    resolution_text: str             # the "RESOLVED THAT ..." body
    proposed_by: Optional[str] = None
    seconded_by: Optional[str] = None


MEETING_DRAFT_TEMPLATES = [
    {
        "key": "routine_opening_bank_account",
        "category": "Finance & Banking",
        "label": "Opening / Operation of Bank Account",
        "legal_basis": "Companies Act, 2013 — Section 179(3) and applicable banking/authorisation provisions",
        "agenda": "To consider and approve opening / operation of the Company's bank account.",
        "resolution": "pursuant to the applicable provisions of the Companies Act, 2013 and the Articles of Association, approval be and is hereby accorded for opening and operating the Company's bank account with {bank_name}, and the authorised signatories be and are hereby authorised to operate the account and execute all documents required by the bank",
    },
    {
        "key": "appointment_md",
        "category": "Directors & KMP",
        "label": "Appointment of Managing Director",
        "legal_basis": "Companies Act, 2013 — Sections 196, 197, 203 and Schedule V; applicable Rules",
        "agenda": "To consider appointment of a Managing Director.",
        "resolution": "pursuant to Sections 196, 197 and 203, Schedule V and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded, subject to such shareholder / regulatory approvals as may be required, for appointment of {person_name} as Managing Director on the terms placed before the Board",
    },
    {
        "key": "reappointment_md",
        "category": "Directors & KMP",
        "label": "Re-appointment of Managing Director",
        "legal_basis": "Companies Act, 2013 — Sections 196, 197 and Schedule V; applicable Rules",
        "agenda": "To consider re-appointment of the Managing Director.",
        "resolution": "pursuant to the applicable provisions of the Companies Act, 2013 and subject to the requisite approvals, approval be and is hereby accorded for re-appointment of {person_name} as Managing Director on the terms and conditions placed before the Board",
    },
    {
        "key": "appointment_cfo",
        "category": "Directors & KMP",
        "label": "Appointment of Chief Financial Officer",
        "legal_basis": "Companies Act, 2013 — Section 203 and applicable Rules",
        "agenda": "To consider appointment of the Chief Financial Officer.",
        "resolution": "pursuant to Section 203 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded for appointment of {person_name} as Chief Financial Officer of the Company on the terms placed before the Board",
    },
    {
        "key": "appointment_cs",
        "category": "Directors & KMP",
        "label": "Appointment of Whole-time Company Secretary",
        "legal_basis": "Companies Act, 2013 — Section 203 and applicable Rules",
        "agenda": "To consider appointment of the Whole-time Company Secretary.",
        "resolution": "pursuant to Section 203 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded for appointment of {person_name} as Whole-time Company Secretary of the Company on the terms placed before the Board",
    },
    {
        "key": "financial_statements",
        "category": "Accounts & Audit",
        "label": "Approval of Annual Financial Statements",
        "legal_basis": "Companies Act, 2013 — Section 134 and applicable provisions relating to financial statements",
        "agenda": "To consider and approve the audited financial statements for the financial year ended {fy_end}.",
        "resolution": "pursuant to the applicable provisions of the Companies Act, 2013, the audited financial statements of the Company for the financial year ended {fy_end}, together with the reports thereon, as placed before the Board, be and are hereby approved",
    },
    {
        "key": "statutory_auditor_report",
        "category": "Accounts & Audit",
        "label": "Take Note of Statutory Auditor's Report",
        "legal_basis": "Companies Act, 2013 — Sections 134 and 143 and applicable Rules",
        "agenda": "To take note of the Statutory Auditor's Report on the financial statements.",
        "resolution": "the Statutory Auditor's Report on the financial statements of the Company for the financial year ended {fy_end}, as placed before the Board, be and is hereby taken on record",
    },
    {
        "key": "secretarial_auditor",
        "category": "Accounts & Audit",
        "label": "Appointment of Secretarial Auditor",
        "legal_basis": "Companies Act, 2013 — Section 204 and applicable Rules",
        "agenda": "To consider appointment of Secretarial Auditor for the financial year.",
        "resolution": "pursuant to Section 204 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded for appointment of {auditor_name} as Secretarial Auditor for the financial year {financial_year}, on the terms placed before the Board",
    },
    {
        "key": "internal_auditor",
        "category": "Accounts & Audit",
        "label": "Appointment of Internal Auditor",
        "legal_basis": "Companies Act, 2013 — Section 138 and applicable Rules",
        "agenda": "To consider appointment of Internal Auditor for the financial year.",
        "resolution": "pursuant to Section 138 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded for appointment of {auditor_name} as Internal Auditor for the financial year {financial_year}, on the terms placed before the Board",
    },
    {
        "key": "interim_dividend",
        "category": "Dividend",
        "label": "Declaration of Interim Dividend",
        "legal_basis": "Companies Act, 2013 — Section 123 and applicable Rules",
        "agenda": "To consider declaration of Interim Dividend on Equity Shares.",
        "resolution": "pursuant to Section 123 and other applicable provisions of the Companies Act, 2013, an Interim Dividend of Rs. {dividend_per_share} per equity share be and is hereby declared out of the profits available for distribution, subject to applicable statutory requirements",
    },
    {
        "key": "recommend_final_dividend",
        "category": "Dividend",
        "label": "Recommendation of Final Dividend",
        "legal_basis": "Companies Act, 2013 — Section 123 and applicable Rules",
        "agenda": "To consider recommendation of dividend on Equity Shares.",
        "resolution": "pursuant to Section 123 and other applicable provisions of the Companies Act, 2013, a dividend of Rs. {dividend_per_share} per equity share be and is hereby recommended for consideration by the members at the ensuing Annual General Meeting",
    },
    {
        "key": "csr1",
        "category": "CSR",
        "label": "Approval for Filing of Form CSR-1",
        "legal_basis": "Companies Act, 2013 — Section 135 and applicable CSR Rules",
        "agenda": "To consider approval for filing of Form CSR-1.",
        "resolution": "pursuant to Section 135 of the Companies Act, 2013 and the applicable CSR Rules, approval be and is hereby accorded for filing Form CSR-1 and for authorising the designated person to complete and submit the filing and related documents",
    },
    {
        "key": "csr_policy_adoption",
        "category": "CSR",
        "label": "Approval and Adoption of CSR Policy",
        "legal_basis": "Companies Act, 2013 — Section 135 and Schedule VII; applicable CSR Rules",
        "agenda": "To consider and approve the Corporate Social Responsibility Policy.",
        "resolution": "pursuant to Section 135 of the Companies Act, 2013 and the applicable CSR Rules, the Corporate Social Responsibility Policy placed before the Board be and is hereby approved and adopted",
    },
    {
        "key": "csr_policy_amendment",
        "category": "CSR",
        "label": "Amendment of Existing CSR Policy",
        "legal_basis": "Companies Act, 2013 — Section 135 and applicable CSR Rules",
        "agenda": "To consider amendment to the existing CSR Policy.",
        "resolution": "pursuant to Section 135 of the Companies Act, 2013 and the applicable CSR Rules, the amendments to the existing Corporate Social Responsibility Policy placed before the Board be and are hereby approved",
    },
    {
        "key": "shareholders_agreement",
        "category": "Corporate Governance",
        "label": "Approval of Shareholders' Agreement",
        "legal_basis": "Companies Act, 2013 and the Articles of Association; applicable contractual provisions",
        "agenda": "To consider and approve the Shareholders' Agreement.",
        "resolution": "the draft Shareholders' Agreement placed before the Board for identification be and is hereby approved, subject to such member / regulatory approvals as may be required, and the authorised persons be and are hereby authorised to execute and give effect to the same",
    },
    {
        "key": "section_186_investment_loan_guarantee",
        "category": "Finance & Investments",
        "label": "Investment / Loan / Guarantee / Security under Section 186",
        "legal_basis": "Companies Act, 2013 — Section 186 and applicable Rules",
        "agenda": "To consider investment, loan, guarantee or provision of security under Section 186.",
        "resolution": "pursuant to Section 186 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded for the proposed investment / loan / guarantee / security of {amount} in favour of {recipient}, subject to applicable statutory limits and approvals",
    },
    {
        "key": "section_186_excess",
        "category": "Finance & Investments",
        "label": "Investment exceeding Section 186 limits — Members' Approval",
        "legal_basis": "Companies Act, 2013 — Section 186(3) and applicable Rules",
        "agenda": "To consider seeking members' approval for investment / loan / guarantee / security exceeding applicable Section 186 limits.",
        "resolution": "subject to the provisions of Section 186(3) and other applicable provisions of the Companies Act, 2013, approval of the members by Special Resolution be sought for the proposed transaction of {amount} in relation to {recipient}",
    },
    {
        "key": "conversion_private",
        "category": "Corporate Actions",
        "label": "Conversion of Public Company into Private Company",
        "legal_basis": "Companies Act, 2013 — Sections 13 and 14 and applicable Rules",
        "agenda": "To consider conversion of the Company from Public Limited to Private Limited.",
        "resolution": "subject to the approval of the members and the Regional Director / other authority as applicable, approval be and is hereby accorded to initiate conversion of the Company from Public Limited to Private Limited and to take all consequential steps",
    },
    {
        "key": "registered_office_shift",
        "category": "Corporate Actions",
        "label": "Shifting of Registered Office",
        "legal_basis": "Companies Act, 2013 — Section 12 and applicable Rules",
        "agenda": "To consider shifting of the Registered Office from {old_address} to {new_address}.",
        "resolution": "pursuant to Section 12 and applicable Rules, approval be and is hereby accorded for shifting the Registered Office from {old_address} to {new_address}, subject to such approvals and filings as may be required",
    },
    {
        "key": "borrowing_180",
        "category": "Finance & Borrowings",
        "label": "Borrowing beyond Section 180(1)(c) threshold",
        "legal_basis": "Companies Act, 2013 — Section 180(1)(c) and applicable provisions",
        "agenda": "To consider borrowing beyond the aggregate of paid-up capital, free reserves and securities premium.",
        "resolution": "subject to the consent of the members by Special Resolution where required, approval be and is hereby accorded to borrow up to Rs. {amount}, subject to the applicable limits and conditions under Section 180(1)(c) of the Companies Act, 2013",
    },
    {
        "key": "related_party_transaction",
        "category": "Related Party",
        "label": "Related Party Transaction",
        "legal_basis": "Companies Act, 2013 — Sections 177 and 188 and applicable Rules",
        "agenda": "To consider approval / noting of the proposed Related Party Transaction.",
        "resolution": "pursuant to Sections 177 and 188 and other applicable provisions of the Companies Act, 2013, approval be and is hereby accorded to the proposed Related Party Transaction with {related_party}, on the terms placed before the Board and subject to applicable approvals",
    },
    {
        "key": "policy_approval",
        "category": "Policies & Compliance",
        "label": "Approval / Adoption of Company Policy",
        "legal_basis": "Companies Act, 2013 and applicable Rules; Articles of Association",
        "agenda": "To consider and approve the {policy_name}.",
        "resolution": "the {policy_name} placed before the Board be and is hereby approved and adopted with effect from {effective_date}, and the authorised officers be and are hereby authorised to implement the same",
    },
    {
        "key": "policy_amendment",
        "category": "Policies & Compliance",
        "label": "Amendment of Company Policy",
        "legal_basis": "Companies Act, 2013 and applicable Rules; Articles of Association",
        "agenda": "To consider amendment to the {policy_name}.",
        "resolution": "the proposed amendments to the {policy_name}, as placed before the Board, be and are hereby approved with effect from {effective_date}",
    },
    {
        "key": "compliance_certificate",
        "category": "Compliance",
        "label": "Review of Compliance Certificate",
        "legal_basis": "Companies Act, 2013, applicable Rules and Secretarial Standard-1",
        "agenda": "To consider the Compliance Certificate covering laws applicable to the Company.",
        "resolution": "the Compliance Certificate for the relevant period, as placed before the Board, be and is hereby taken on record after review of the compliance status and action points arising therefrom",
    },
    {
        "key": "investments_borrowings_guarantees",
        "category": "Finance & Compliance",
        "label": "Review of Investments, Borrowings, Guarantees and Application of Funds",
        "legal_basis": "Secretarial Standard-1 — illustrative agenda items; applicable Companies Act provisions",
        "agenda": "To review investments, borrowings, corporate guarantees, sale of assets and sources and application of funds.",
        "resolution": "the report on investments, borrowings, corporate guarantees, sale of assets and sources and application of funds, as placed before the Board, be and is hereby reviewed and taken on record",
    },
    {
        "key": "secretarial_compliance",
        "category": "Compliance",
        "label": "Secretarial Compliance / Governance Review",
        "legal_basis": "Companies Act, 2013 — Section 118(10) and Secretarial Standard-1",
        "agenda": "To review compliance with applicable laws and governance requirements.",
        "resolution": "the compliance and governance status report for the relevant period, including material statutory and secretarial matters, be and is hereby reviewed and taken on record, and the identified action points be followed up by the authorised officers",
    },
    {
        "key": "share_transfer",
        "category": "Shares & Members",
        "label": "Approval of Share Transfers",
        "legal_basis": "Companies Act, 2013 — Section 56 and applicable Rules; Articles of Association",
        "agenda": "To consider and approve the share transfers placed before the Board.",
        "resolution": "the share transfers listed in the papers placed before the Board be and are hereby approved, subject to verification of the transfer instruments, applicable stamp duty and statutory records, and the names of the transferees be entered in the Register of Members",
    },
    {
        "key": "grant_leave",
        "category": "Routine Board Business",
        "label": "Grant Leave of Absence",
        "legal_basis": "Secretarial Standard-1 — specimen Board Meeting sequence",
        "agenda": "To grant leave of absence to Directors who have expressed inability to attend the Meeting.",
        "resolution": "leave of absence be and is hereby granted to the Directors who have expressed their inability to attend the Meeting",
    },
    {
        "key": "take_note_previous_minutes",
        "category": "Routine Board Business",
        "label": "Take Note of Previous Board Minutes",
        "legal_basis": "Secretarial Standard-1 — illustrative / specimen Board Meeting sequence",
        "agenda": "To take note of the Minutes of the previous Board / Committee Meeting.",
        "resolution": "the Minutes of the previous Board / Committee Meeting, as circulated, be and are hereby noted and taken on record",
    },
    {
        "key": "director_interest_disclosure",
        "category": "Routine Board Business",
        "label": "Disclosure of Interest by Directors",
        "legal_basis": "Companies Act, 2013 — Section 184(1); Secretarial Standard-1",
        "agenda": "To take note of disclosures of interest received from Directors.",
        "resolution": "the disclosures of interest received from the Directors pursuant to Section 184(1) of the Companies Act, 2013 be and are hereby noted and recorded",
    },
    {
        "key": "register_contracts",
        "category": "Routine Board Business",
        "label": "Register of Contracts — Section 189",
        "legal_basis": "Companies Act, 2013 — Section 189; Secretarial Standard-1",
        "agenda": "To take note of entries in the Register of Contracts in which Directors are interested.",
        "resolution": "the Register of Contracts in which Directors are interested under Section 189, as placed before the Meeting, be and is hereby noted and taken on record",
    },
    {
        "key": "independent_director_declaration",
        "category": "Directors & KMP",
        "label": "Independent Director Declaration",
        "legal_basis": "Companies Act, 2013 — Section 149(7); Secretarial Standard-1",
        "agenda": "To take note of the declaration of independence furnished by the Independent Director.",
        "resolution": "the declaration furnished by the Independent Director confirming satisfaction of the criteria of independence under Section 149(7) be and is hereby noted and taken on record",
    },
    {
        "key": "committee_minutes",
        "category": "Routine Board Business",
        "label": "Take Note of Committee Minutes",
        "legal_basis": "Secretarial Standard-1 — specimen Board Meeting sequence",
        "agenda": "To take note of Minutes of meetings of Board Committees.",
        "resolution": "the Minutes of the meetings of the relevant Board Committees, as circulated, be and are hereby noted and taken on record",
    },
    {
        "key": "circulation_resolution",
        "category": "Routine Board Business",
        "label": "Resolution Passed by Circulation",
        "legal_basis": "Companies Act, 2013 — Section 175; Secretarial Standard-1",
        "agenda": "To note the resolution passed by circulation since the last Board Meeting.",
        "resolution": "the resolution passed by circulation under Section 175 of the Companies Act, 2013 since the previous Board Meeting be and is hereby noted and taken on record",
    },
    {
        "key": "action_taken_report",
        "category": "Routine Board Business",
        "label": "Action Taken Report",
        "legal_basis": "Secretarial Standard-1 — specimen Board Meeting sequence",
        "agenda": "To review the Action Taken Report arising from previous Board decisions.",
        "resolution": "the Action Taken Report placed before the Board be and is hereby reviewed and the pending action points be followed up by the responsible officers",
    },
    {
        "key": "audited_financials_and_auditor_report",
        "category": "Accounts & Audit",
        "label": "Audited Financial Statements and Statutory Auditor's Report",
        "legal_basis": "Companies Act, 2013 — Sections 134 and 143; Secretarial Standard-1",
        "agenda": "To consider the audited financial statements and take note of the Statutory Auditor's Report for the year ended {fy_end}.",
        "resolution": "the audited financial statements for the financial year ended {fy_end}, together with the Statutory Auditor's Report thereon, be and are hereby considered and the Auditor's Report be taken on record",
    },
    {
        "key": "related_party_omnibus",
        "category": "Related Party",
        "label": "Omnibus Related Party Transaction Approval",
        "legal_basis": "Companies Act, 2013 — Sections 177 and 188 and applicable Rules; SEBI LODR where applicable",
        "agenda": "To consider omnibus approval / review of Related Party Transactions for the financial year.",
        "resolution": "the proposed Related Party Transactions placed before the Board / Audit Committee be and are hereby approved on the terms placed before the Meeting, subject to the applicable statutory conditions and periodic review",
    },
    {
        "key": "material_assets",
        "category": "Finance & Assets",
        "label": "Purchase / Sale of Material Assets",
        "legal_basis": "Companies Act, 2013 — applicable provisions including Sections 179 and 180, where applicable; Secretarial Standard-1",
        "agenda": "To consider purchase / sale of material tangible or intangible assets outside the normal course of business.",
        "resolution": "approval be and is hereby accorded for the proposed purchase / sale of the material asset described in the papers placed before the Board, subject to applicable approvals, valuation and statutory requirements",
    },
    {
        "key": "kmp_remuneration",
        "category": "Directors & KMP",
        "label": "Approval of KMP / Managerial Remuneration",
        "legal_basis": "Companies Act, 2013 — Sections 196, 197, 203 and Schedule V, where applicable",
        "agenda": "To consider and approve remuneration / terms of a KMP or managerial personnel.",
        "resolution": "subject to the applicable provisions of the Companies Act, 2013 and requisite approvals, the remuneration and terms placed before the Board for {person_name} be and are hereby approved",
    },
    {
        "key": "any_other_business",
        "category": "General",
        "label": "Any Other Item with Permission of the Chair",
        "legal_basis": "Secretarial Standard-1 — agenda / supplementary business requirements",
        "agenda": "To transact any other business with the permission of the Chair.",
        "resolution": "the additional matter placed before the Board with the requisite consent of the Directors be and is hereby considered and approved / noted, as applicable",
    },
    {
        "key": "members_adoption_financials",
        "category": "General Meetings",
        "label": "Members' Adoption of Financial Statements and Directors' Report",
        "legal_basis": "Companies Act, 2013 — Section 134 and applicable provisions governing the Annual General Meeting",
        "agenda": "To receive, consider and adopt the audited financial statements and the Directors' Report for the financial year ended {fy_end}.",
        "resolution": "the audited financial statements for the financial year ended {fy_end}, together with the Directors' Report and Auditor's Report thereon, be and are hereby received, considered and adopted",
    },
    {
        "key": "agm_dividend",
        "category": "General Meetings",
        "label": "Declaration of Dividend by Members",
        "legal_basis": "Companies Act, 2013 — Section 123 and applicable provisions governing declaration of dividend",
        "agenda": "To consider declaration of dividend on Equity Shares.",
        "resolution": "a dividend of Rs. {dividend_per_share} per equity share for the financial year be and is hereby declared out of the profits available for distribution, subject to applicable statutory requirements",
    },
    {
        "key": "agm_retiring_director",
        "category": "General Meetings",
        "label": "Re-appointment of Director Retiring by Rotation",
        "legal_basis": "Companies Act, 2013 — Section 152 and applicable provisions; Articles of Association",
        "agenda": "To appoint a Director in place of the Director retiring by rotation and eligible for re-appointment.",
        "resolution": "{person_name}, who retires by rotation and, being eligible, offers himself / herself for re-appointment, be and is hereby re-appointed as a Director of the Company",
    },
    {
        "key": "agm_auditor_reappointment",
        "category": "General Meetings",
        "label": "Re-appointment of Statutory Auditor",
        "legal_basis": "Companies Act, 2013 — Sections 139 and 142 and applicable Rules",
        "agenda": "To consider re-appointment of the Statutory Auditor and fix remuneration.",
        "resolution": "{auditor_name}, Chartered Accountants, be and is hereby re-appointed as Statutory Auditor of the Company for the period permitted under the applicable provisions, at a remuneration of Rs. {remuneration} plus applicable taxes and out-of-pocket expenses",
    },
    {
        "key": "agm_appointment_director",
        "category": "General Meetings",
        "label": "Appointment of Director",
        "legal_basis": "Companies Act, 2013 — Section 152 and applicable provisions; Articles of Association",
        "agenda": "To consider appointment of {person_name} as a Director of the Company.",
        "resolution": "{person_name}, who has furnished the requisite consent and declarations, be and is hereby appointed as a Director of the Company with effect from {effective_date}",
    },
    {
        "key": "agm_regularisation_additional_director",
        "category": "General Meetings",
        "label": "Regularisation of Additional Director",
        "legal_basis": "Companies Act, 2013 — Section 149 / Section 152, as applicable; Articles of Association",
        "agenda": "To consider regularisation of {person_name} as a Director of the Company.",
        "resolution": "{person_name}, who was appointed as an Additional Director and whose term is subject to the applicable provisions, be and is hereby appointed as a Director of the Company",
    },
    {
        "key": "agm_remuneration",
        "category": "General Meetings",
        "label": "Approval of Managerial Remuneration",
        "legal_basis": "Companies Act, 2013 — Sections 196, 197, 198 and Schedule V, where applicable",
        "agenda": "To consider and approve remuneration / terms of {person_name}.",
        "resolution": "the remuneration and terms of appointment of {person_name}, as placed before the members, be and are hereby approved subject to the applicable provisions of the Companies Act, 2013 and requisite approvals",
    },
    {
        "key": "agm_special_business_authorisation",
        "category": "General Meetings",
        "label": "Members' Approval for Special Business",
        "legal_basis": "Companies Act, 2013 and applicable provisions governing members' approval",
        "agenda": "To consider and approve the proposed special business relating to {business_description}.",
        "resolution": "the proposal relating to {business_description}, as set out in the Notice and placed before the members, be and is hereby approved, subject to the applicable statutory and contractual requirements",
    },
    {
        "key": "agm_alteration_articles",
        "category": "General Meetings",
        "label": "Alteration of Articles of Association",
        "legal_basis": "Companies Act, 2013 — Section 14 and applicable Rules",
        "agenda": "To consider alteration of the Articles of Association.",
        "resolution": "the Articles of Association of the Company be and are hereby altered in the manner set out in the draft placed before the members, and the authorised persons be and are hereby authorised to complete the consequential filings and actions",
    },
    {
        "key": "agm_alteration_memorandum",
        "category": "General Meetings",
        "label": "Alteration of Memorandum of Association",
        "legal_basis": "Companies Act, 2013 — Section 13 and applicable Rules",
        "agenda": "To consider alteration of the Memorandum of Association.",
        "resolution": "the Memorandum of Association of the Company be and is hereby altered in the manner set out in the draft placed before the members, subject to such approvals as may be required",
    },
    {
        "key": "agm_related_party",
        "category": "General Meetings",
        "label": "Members' Approval for Related Party Transaction",
        "legal_basis": "Companies Act, 2013 — Section 188 and applicable Rules",
        "agenda": "To consider approval of the Related Party Transaction with {related_party}.",
        "resolution": "approval of the members be and is hereby accorded to the proposed Related Party Transaction with {related_party}, on the terms placed before the meeting and subject to the applicable provisions and disclosures",
    },
    {
        "key": "audit_committee_rpt_omnibus",
        "category": "Audit Committee",
        "label": "Audit Committee Omnibus Approval — Related Party Transactions",
        "legal_basis": "Companies Act, 2013 — Sections 177(4)(iv), 188 and applicable Rules; SEBI LODR where applicable",
        "agenda": "To consider omnibus approval of Related Party Transactions for the financial year.",
        "resolution": "pursuant to the applicable provisions governing the Audit Committee and Related Party Transactions, omnibus approval be and is hereby granted to the proposed transactions placed before the Committee, subject to the applicable statutory conditions and periodic review",
    },
]


class BoardResolutionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_legal_basis: Optional[str] = None
    template_key: Optional[str] = None
    template_values: Dict[str, Any] = Field(default_factory=dict)
    custom_topic: Optional[str] = None
    meeting_date: str
    meeting_time: Optional[str] = "11:00 AM"
    venue: Optional[str] = "Registered Office of the Company"
    directors_present: List[str] = Field(default_factory=list)
    chairman: Optional[str] = None
    resolutions: List[ResolutionItem]


class GeneralMeetingResolutionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_legal_basis: Optional[str] = None
    template_key: Optional[str] = None
    template_values: Dict[str, Any] = Field(default_factory=dict)
    custom_topic: Optional[str] = None
    meeting_type: str = "agm"
    meeting_date: str
    meeting_time: Optional[str] = "11:00 AM"
    venue: Optional[str] = "Registered Office of the Company"
    chairman: Optional[str] = None
    members_present: List[str] = Field(default_factory=list)
    resolutions: List[ResolutionItem] = Field(default_factory=list)


class MeetingNoticeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_legal_basis: Optional[str] = None
    template_key: Optional[str] = None
    template_values: Dict[str, Any] = Field(default_factory=dict)
    custom_topic: Optional[str] = None
    selected_record_id: Optional[str] = None
    meeting_type: str = "board"      # board | agm | egm
    meeting_date: str
    meeting_time: Optional[str] = "11:00 AM"
    venue: Optional[str] = "Registered Office of the Company"
    notice_date: Optional[str] = None
    agenda_items: List[str] = Field(default_factory=list)
    special_business: List[ResolutionItem] = Field(default_factory=list)


class MinutesRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_legal_basis: Optional[str] = None
    template_key: Optional[str] = None
    template_values: Dict[str, Any] = Field(default_factory=dict)
    custom_topic: Optional[str] = None
    meeting_type: str = "board"      # board | agm | egm
    meeting_date: str
    meeting_time: Optional[str] = "11:00 AM"
    venue: Optional[str] = "Registered Office of the Company"
    chairman: Optional[str] = None
    directors_present: List[str] = Field(default_factory=list)
    directors_absent: List[str] = Field(default_factory=list)
    attendees_other: List[str] = Field(default_factory=list)
    quorum_present: bool = True
    resolutions: List[ResolutionItem] = Field(default_factory=list)
    discussion_notes: Optional[str] = None


class MeetingAttendance(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    din: Optional[str] = None
    designation: Optional[str] = None
    status: str = "Present"  # Present / Absent / Leave of Absence
    mode: Optional[str] = None  # Physical / VC / OAVM / Other
    remarks: Optional[str] = None


class RecordHistoryEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    meeting_type: str = "board"  # board / agm / egm / committee / partner / other
    meeting_number: Optional[str] = None
    meeting_date: str
    meeting_time: Optional[str] = None
    notice_date: Optional[str] = None
    venue: Optional[str] = None
    mode: Optional[str] = None
    chairman: Optional[str] = None
    quorum_present: Optional[bool] = True
    attendance: List[MeetingAttendance] = Field(default_factory=list)
    members_present_count: Optional[int] = None
    members_entitled_count: Optional[int] = None
    leave_of_absence: List[str] = Field(default_factory=list)
    agenda_items: List[str] = Field(default_factory=list)
    resolutions_passed: List[str] = Field(default_factory=list)
    special_business: List[str] = Field(default_factory=list)
    minutes_date: Optional[str] = None
    minutes_signed_date: Optional[str] = None
    adjourned: bool = False
    adjourned_to: Optional[str] = None
    auditor_attended: Optional[bool] = None
    secretarial_notes: Optional[str] = None
    attachments: List[str] = Field(default_factory=list)
    status: str = "Completed"
    remarks: Optional[str] = None



# ─────────────────────────────────────────────────────────────────────────
# COMPANY MASTER — CRUD
# ─────────────────────────────────────────────────────────────────────────

@router.get("/clients-eligible")
async def list_eligible_clients(current_user: User = Depends(VIEW)):
    """Clients that are registered entities (not proprietors) and don't yet
    have a ROC Sphere company master — used to populate the 'create from
    client' picker."""
    cursor = CLIENTS.find({"client_type": {"$in": list(COMPANY_CLIENT_TYPES)}})
    clients = [c async for c in cursor]
    existing = {c["client_id"] async for c in COMPANIES.find({"client_id": {"$ne": None}}, {"client_id": 1}) if c.get("client_id")}
    out = []
    for c in clients:
        if c.get("id") in existing:
            continue
        out.append({
            "client_id": c.get("id"),
            "company_name": c.get("company_name"),
            "client_type": c.get("client_type"),
            "pan": c.get("pan"),
            "date_of_incorporation": c.get("date_of_incorporation"),
            "address": c.get("address"),
        })
    return out


CLIENT_CATEGORY_MAP = {
    "pvt_ltd": "private", "PVT_LTD": "private",
    "private_limited": "private", "private_limited_company": "private",
    "public_ltd": "public", "public_limited": "public", "public_limited_company": "public",
    "section_8": "section_8", "section8": "section_8", "section_8_company": "section_8",
    "llp": "llp", "LLP": "llp", "limited_liability_partnership": "llp",
    "opc": "opc", "one_person_company": "opc",
}


def _normalize_roc_category(company: dict, client: Optional[dict] = None) -> str:
    """Return the reliable ROC entity category for legacy and imported records.

    Older ROC records can have category='private' even when the underlying
    client was imported as LLP.  LLPIN/master-data/name are stronger signals
    than that stale category, so they are checked first.
    """
    name = str(company.get("company_name") or "").strip().lower()
    llpin = str(company.get("llpin") or "").strip()
    master = company.get("master_data") or {}
    if not llpin:
        llpin = str(master.get("llpin") or master.get("llpin_number") or "").strip()

    raw_client_type = str((client or {}).get("client_type") or "").strip().lower().replace("-", "_").replace(" ", "_")
    mapped_client_type = CLIENT_CATEGORY_MAP.get(raw_client_type)

    # An LLP suffix / LLPIN is definitive for this filter. This deliberately
    # overrides a stale 'private' category on old records.
    if llpin or name.endswith(" llp") or name.endswith("llp") or " limited liability partnership" in name:
        return "llp"
    if mapped_client_type:
        return mapped_client_type

    raw = str(company.get("category") or "").strip().lower().replace("-", "_").replace(" ", "_")
    return CLIENT_CATEGORY_MAP.get(raw, raw or "private")


async def _sync_companies_from_clients() -> int:
    """Auto-provision a ROC Sphere company master for every Client record
    that is a registered entity (Pvt/Public Ltd, LLP, OPC, Section 8) and
    doesn't have one yet, prefilled from that client's CIN/PAN/address/
    incorporation date. Existing ROC Sphere records (and anything a user
    has since edited on them) are never touched -- this only fills the gap
    for clients that have no linked record at all. Returns count created.
    """
    cursor = CLIENTS.find({"client_type": {"$in": list(COMPANY_CLIENT_TYPES)}})
    clients = [c async for c in cursor]
    if not clients:
        return 0
    existing_client_ids = {
        c["client_id"]
        async for c in COMPANIES.find({"client_id": {"$ne": None}}, {"client_id": 1})
        if c.get("client_id")
    }
    now = _now()
    new_docs = []
    for c in clients:
        cid = c.get("id")
        if not cid or cid in existing_client_ids:
            continue
        contact_people = c.get("contact_persons") or []
        is_llp = c.get("client_type") in ("llp", "LLP")
        new_docs.append({
            "id": _uid(),
            "client_id": cid,
            "company_name": c.get("company_name") or "Unnamed Company",
            "cin": c.get("cin"),
            "category": CLIENT_CATEGORY_MAP.get(c.get("client_type"), "private"),
            "is_small_company": None,
            "listed": False,
            "roc_office": None,
            "pan": c.get("pan"),
            "date_of_incorporation": (str(c.get("date_of_incorporation"))[:10] if c.get("date_of_incorporation") else None),
            "registered_office_address": c.get("address"),
            "authorized_capital": 0,
            "paid_up_capital": 0,
            "last_year_turnover": 0,
            "financial_year_end": "31-03",
            "last_agm_date": None,
            "last_board_meeting_date": None,
            "directors": [] if is_llp else contact_people,
            "designated_partners": contact_people if is_llp else [],
            "partners": contact_people if is_llp else [],
            "shareholders": [],
            "master_data": {},
            "mgt_shareholder_data": {},
            "annual_return_data": {},
            "audit_report_data": {},
            "board_report_data": {},
            "share_transfers": [],
            "share_certificates": [],
            "roc_form_uploads": [],
            "auditor": None,
            "notes": None,
            "created_at": now,
            "updated_at": now,
            "created_by": "Auto-synced from Clients",
        })
    if new_docs:
        await COMPANIES.insert_many(new_docs)
    return len(new_docs)


@router.get("/companies")
async def list_companies(
    q: Optional[str] = Query(None),
    current_user: User = Depends(VIEW),
):
    await _sync_companies_from_clients()
    query: Dict[str, Any] = {}
    if q:
        query["company_name"] = {"$regex": re.escape(q), "$options": "i"}
    cursor = COMPANIES.find(query).sort("company_name", 1)
    items = [c async for c in cursor]

    # Repair legacy ROC masters in-place. In particular, old records may have
    # category='private' although their linked Client/name is an LLP. Doing
    # this here makes the API response and the stored value agree, so the UI
    # filter/count cannot show LLP (0) while LLP records are visible.
    client_ids = [c.get("client_id") for c in items if c.get("client_id")]
    clients_by_id = {}
    if client_ids:
        client_cursor = CLIENTS.find({"id": {"$in": client_ids}}, {"_id": 0})
        clients_by_id = {c.get("id"): c async for c in client_cursor if c.get("id")}

    for c in items:
        client = clients_by_id.get(c.get("client_id"))
        normalized = _normalize_roc_category(c, client)
        if c.get("category") != normalized:
            await COMPANIES.update_one(
                {"id": c.get("id")},
                {"$set": {"category": normalized, "updated_at": _now()}},
            )
            c["category"] = normalized
        c.pop("_id", None)
    return items


@router.post("/companies/sync-from-clients")
async def sync_from_clients_endpoint(current_user: User = Depends(CREATE)):
    """Manual re-sync trigger (e.g. a 'Sync from Clients' button) -- same
    logic as the automatic sync on GET /companies, exposed separately so
    the UI can show how many were newly added after a bulk client import."""
    created = await _sync_companies_from_clients()
    return {"created": created}


@router.get("/companies/{company_id}")
async def get_company(company_id: str, current_user: User = Depends(VIEW)):
    c = await COMPANIES.find_one({"id": company_id})
    if not c:
        raise HTTPException(404, "Company not found")
    # Client contact persons are the source for the initial ROC people list.
    # Preserve any richer ROC edits, but backfill empty registers from Client.
    if c.get("client_id"):
        client = await CLIENTS.find_one({"id": c["client_id"]}, {"_id": 0})
        if client and not _company_email(c):
            for key in ("email", "company_email", "email_address", "registered_office_email"):
                if client.get(key):
                    c["email"] = client.get(key)
                    break
        contacts = (client or {}).get("contact_persons") or []
        if contacts:
            if c.get("category") == "llp":
                c.setdefault("designated_partners", contacts)
                c.setdefault("partners", contacts)
                if not c.get("designated_partners"):
                    c["designated_partners"] = contacts
                if not c.get("partners"):
                    c["partners"] = contacts
            elif not c.get("directors"):
                c["directors"] = contacts
    c.pop("_id", None)
    return c


@router.post("/companies")
async def create_company(payload: RocCompanyIn, current_user: User = Depends(CREATE)):
    now = _now()
    doc = payload.model_dump()
    doc["id"] = _uid()
    doc["created_at"] = now
    doc["updated_at"] = now
    doc["created_by"] = _who(current_user)
    await COMPANIES.insert_one(doc)
    await _sync_company_to_client(doc)
    doc.pop("_id", None)
    return doc


@router.put("/companies/{company_id}")
async def update_company(company_id: str, payload: RocCompanyIn, current_user: User = Depends(EDIT)):
    existing = await COMPANIES.find_one({"id": company_id})
    if not existing:
        raise HTTPException(404, "Company not found")
    doc = payload.model_dump()
    doc["updated_at"] = _now()
    await COMPANIES.update_one({"id": company_id}, {"$set": doc})
    await _sync_company_to_client({**existing, **doc})
    merged = {**existing, **doc}
    merged.pop("_id", None)
    return merged


async def _sync_company_to_client(company: Dict[str, Any]) -> None:
    """Keep the linked Client as the searchable source of truth as well.

    ROC has richer role-specific records than Clients, so the compact client
    contact_persons list is populated from directors or LLP partners while
    the complete source data is retained in dedicated fields.
    """
    client_id = company.get("client_id")
    if not client_id:
        return
    is_llp = company.get("category") == "llp"
    people = (company.get("designated_partners") or []) + (company.get("partners") or []) if is_llp else (company.get("directors") or [])
    contacts = []
    for person in people:
        if not person or not person.get("name"):
            continue
        contacts.append({
            "name": person.get("name"),
            "designation": person.get("designation") or ("Designated Partner" if is_llp else "Director"),
            "din": person.get("din"),
            "pan": person.get("pan"),
            "email": person.get("email"),
            "phone": person.get("phone"),
        })
    update = {
        "company_name": company.get("company_name"),
        "pan": company.get("pan"),
        "date_of_incorporation": company.get("date_of_incorporation"),
        "address": company.get("registered_office_address"),
        "contact_persons": contacts,
        "roc_directors": company.get("directors") or [],
        "roc_designated_partners": company.get("designated_partners") or [],
        "roc_partners": company.get("partners") or [],
        "roc_shareholders": company.get("shareholders") or [],
        "roc_master_data": company.get("master_data") or {},
        "roc_mgt_shareholder_data": company.get("mgt_shareholder_data") or {},
        "roc_form_uploads": company.get("roc_form_uploads") or [],
        "roc_dpt3_data": company.get("dpt3_data") or {},
    }
    if is_llp:
        update["llpin"] = company.get("cin")
    else:
        update["cin"] = company.get("cin")
    await CLIENTS.update_one({"id": client_id}, {"$set": update})


@router.delete("/companies/{company_id}")
async def delete_company(company_id: str, current_user: User = Depends(DELETE)):
    res = await COMPANIES.delete_one({"id": company_id})
    if not res.deleted_count:
        raise HTTPException(404, "Company not found")
    await DOCS_LOG.delete_many({"company_id": company_id})
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────
# AOC-4 / MGT-7 / MGT-7A / AOC-2 / Board & Auditor report UPLOAD → EXTRACTION
# ─────────────────────────────────────────────────────────────────────────
# Every MCA acknowledgement PDF is a different form with a different
# purpose, and each field extracted here is only ever pulled from the form
# that actually carries that data on the MCA record:
#
#   Company Master fields  (CIN, name, address, authorised capital,
#                            AGM date, board meeting date)
#                             — read from whichever recognised ROC form
#                               states them (present on most of AOC-4,
#                               AOC-2, MGT-7/7A, Board's/Auditor's Report)
#   Directors / KMP register — ONLY from MGT-7 / MGT-7A (the Annual Return
#                               is the filing that carries the statutory
#                               Director/Signatory register; AOC-4, AOC-2,
#                               and the Board's/Auditor's Report extracts
#                               do not, and must never populate it)
#   Shareholders register    — ONLY from MGT-7 / MGT-7A, same reasoning
#   Financial data            — ONLY from AOC-4 (Balance Sheet / P&L /
#                               Net Worth figures; AOC-2 and the Board's/
#                               Auditor's Report extracts carry no
#                               standardised financial figures worth
#                               trusting for this)
#   Statutory Auditor details — ONLY from AOC-4 (Auditor Details block)
#
# This routing is enforced by _identify_roc_form_type() below and the
# per-form-type dispatch in upload_master_data(): a field is never applied
# from a form that isn't its statutory source, so one wrong/unusual PDF in
# a batch can no longer pollute Directors & Shareholders (this replaced an
# earlier version that scanned the full text of every uploaded form for
# anything DIN/PAN-shaped, which produced garbage director rows out of
# AOC-4/AOC-2/Board & Auditor report boilerplate — see CHANGELOG below).
#
# This is a heuristic text-scrape (same approach as backend/compliance.py's
# parse_compliance_dates), not an XBRL parser — every applied field is
# still shown to the user in the "Extracted fields" preview and can be
# corrected on the Company Master / Directors & Shareholders tabs.

ROC_FORM_ALLOWED_EXT = (".pdf", ".xlsx", ".xlsm", ".csv")
ROC_FORM_RECOGNIZED = (
    # order matters: more specific labels (mgt-7a) must be checked before
    # their substrings (mgt-7)
    ("mgt-7a", r"mgt[- ]?7a"),
    ("mgt-7", r"mgt[- ]?7\b"),
    ("mgt-7a-attachment", r"details? of (?:share|debenture)|shareholder.*(?:xls|xlsx|xlsm)"),
    ("aoc-4", r"\baoc[- ]?4\b"),
    ("aoc-2", r"\baoc[- ]?2\b"),
    ("board-report", r"extract of board.?s report|board.?s report"),
    ("auditor-report", r"extract of auditor.?s report|auditor.?s report"),
    ("dir-12", r"dir[- ]?12"),
    ("adt-1", r"adt[- ]?1"),
    ("inc-22", r"inc[- ]?22"),
    ("pas-3", r"pas[- ]?3"),
    ("mgt-14", r"mgt[- ]?14"),
    ("dpt-3", r"dpt[- ]?3"),
)

# Forms whose MCA-prescribed content includes the statutory Director/
# Signatory register and the shareholder/member register.
DIRECTOR_SHAREHOLDER_SOURCE_TYPES = {"mgt-7", "mgt-7a", "mgt-7a-attachment"}
# Form whose MCA-prescribed content includes the audited Balance Sheet,
# Statement of Profit & Loss and Auditor Details block.
FINANCIAL_SOURCE_TYPE = "aoc-4"
# ADT-1 is the filing-specific source for auditor appointment/tenure details.
AUDITOR_APPOINTMENT_SOURCE_TYPE = "adt-1"

# ── Filing-category lanes for the split "Upload ROC Forms" UI ─────────────
# The frontend now offers three separate upload lanes instead of one mixed
# dropzone, each restricted to (a) a fixed set of statutory forms and (b)
# a fixed expected filing year, so an old form uploaded into the wrong lane
# — or a current-year form that is actually a leftover from a prior year —
# is rejected instead of silently overwriting current data.
FILING_CATEGORY_FORM_TYPES: Dict[str, set] = {
    "previous_year_annual": {"aoc-4", "aoc-2", "mgt-7", "mgt-7a", "mgt-7a-attachment"},
    "current_year_other": {"dir-12", "adt-1", "inc-22", "pas-3", "mgt-14", "dpt-3"},
    "current_year_audit": {"auditor-report", "board-report"},
}
FILING_CATEGORY_LABELS: Dict[str, str] = {
    "previous_year_annual": "Previous Year Annual Filing",
    "current_year_other": "Current Year Other Forms Filing",
    "current_year_audit": "Current Year Audit Report",
}


def _category_for_form_type(form_type: str) -> Optional[str]:
    for cat, types in FILING_CATEGORY_FORM_TYPES.items():
        if form_type in types:
            return cat
    return None


def _expected_fy_for_category(category: str) -> Optional[str]:
    """FY label ('2024-25') a given upload lane's forms should belong to,
    computed off today's date the same way build_cs_practice_plan() does."""
    _, _, current_fy = _fy_dates(None)
    if category == "previous_year_annual":
        start_year = int(current_fy.split("-")[0]) - 1
        return f"{start_year}-{str(start_year + 1)[-2:]}"
    if category in ("current_year_other", "current_year_audit"):
        return current_fy
    return None


_FY_RANGE_RE = re.compile(r"\b(20\d{2})\s*[-–/]\s*(20\d{2}|\d{2})\b")
_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"]
_LONG_DATE_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(_MONTH_NAMES) + r")[,\s]+((?:19|20)\d{2})\b",
    re.I,
)
_SHORT_DATE_RE = re.compile(r"\b([0-3]?\d)[/-]([01]?\d)[/-]((?:19|20)\d{2})\b")


def _fy_label_for_date(d: date) -> str:
    start_year = d.year if d.month >= 4 else d.year - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def _extract_document_fy(text: str) -> Optional[str]:
    """Best-effort guess at which financial year this document's content
    relates to — used only to flag a likely stale/mismatched-year upload
    for review, never a legal determination. Tries an explicit year range
    first ('Financial Year From 01/04/2024 To 31/03/2025', 'F.Y. 2024-25'),
    which is how MCA forms usually print it, then falls back to the latest
    calendar date found near the top of the document (filing/appointment/
    event date on ADT-1, DIR-12 etc., which carry no year-range label)."""
    head = text[:6000]
    for y1s, y2s in _FY_RANGE_RE.findall(head):
        y1 = int(y1s)
        y2_full = int(y2s) if len(y2s) == 4 else (y1 // 100) * 100 + int(y2s)
        if y2_full == y1 + 1:
            return f"{y1}-{str(y2_full)[-2:]}"
    dates: List[date] = []
    for m in _LONG_DATE_RE.finditer(head):
        month = _MONTH_NAMES.index(m.group(2).lower()) + 1
        try:
            dates.append(date(int(m.group(3)), month, int(m.group(1))))
        except ValueError:
            pass
    for m in _SHORT_DATE_RE.finditer(head):
        d1, d2, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        for day, month in ((d1, d2), (d2, d1)):
            if 1 <= month <= 12 and 1 <= day <= 31:
                try:
                    dates.append(date(y, month, day))
                    break
                except ValueError:
                    continue
    if not dates:
        return None
    return _fy_label_for_date(max(dates))

# Keys populated on company.financial_data by an AOC-4 upload — kept as a
# named set so the frontend/UI and this parser stay in sync.
FINANCIAL_DATA_FIELDS = (
    "period_from", "period_to", "total_income", "total_expenses",
    "profit_before_tax", "profit_after_tax", "net_worth", "share_capital",
    "reserves_and_surplus", "balance_sheet_total", "turnover",
)


def _identify_roc_form_type(filename: str, text: str) -> str:
    """Best-effort filing-type label — checked against both the filename
    and the extracted text, since MCA acknowledgement PDFs are sometimes
    downloaded/renamed generically. This label is load-bearing: it decides
    which fields (if any) a given upload is allowed to touch, not just an
    audit-trail cosmetic."""
    hay = f"{filename}\n{text[:2000]}".lower()
    if (filename or "").lower().endswith((".xlsx", ".xlsm", ".csv")) and re.search(
        r"shareholder|debenture holder|security held|mgt[- ]?7", hay, re.I
    ):
        return "mgt-7a-attachment"
    for label, pattern in ROC_FORM_RECOGNIZED:
        if re.search(pattern, hay):
            return label
    return "roc-form"


def _extract_xfa_pdf_text(raw: bytes) -> str:
    """Extract data from MCA dynamic XFA PDFs when normal PDF text is empty.

    MCA eForms such as AOC-4 can expose only an Adobe Reader placeholder to
    ordinary PDF text extractors even though the real submitted values are
    stored in the AcroForm XFA datasets XML.
    """
    try:
        from pypdf import PdfReader
        import xml.etree.ElementTree as ET

        reader = PdfReader(io.BytesIO(raw))
        root = reader.trailer.get("/Root")
        if not root:
            return ""
        acro_form = root.get("/AcroForm")
        if not acro_form:
            return ""
        acro_form = acro_form.get_object()
        xfa = acro_form.get("/XFA")
        if not xfa:
            return ""

        xfa = list(xfa)
        datasets_obj = None
        for index in range(0, len(xfa) - 1, 2):
            if str(xfa[index]) == "datasets":
                datasets_obj = xfa[index + 1]
                break
        if datasets_obj is None:
            return ""

        datasets_raw = datasets_obj.get_object().get_data()
        xml_root = ET.fromstring(datasets_raw)
        leaves: Dict[str, str] = {}

        def walk(node: Any, path_parts: List[str]) -> None:
            children = list(node)
            tag = re.sub(r"\\{.*?\\}", "", str(node.tag))
            next_path = path_parts + ([tag] if tag else [])
            if not children:
                value = re.sub(r"\\s+", " ", (node.text or "")).strip()
                if value:
                    leaves["/".join(next_path)] = value
                return
            for child in children:
                walk(child, next_path)

        walk(xml_root, [])
        if not leaves:
            return ""

        aliases = {
            "HI_COMPANYNAME": "Name of the company",
            "CIN": "Corporate identity number",
            "REG_OFFICE_ADDR": "Address of the registered office",
            "FY_START_DATE": "From (DD/MM/YYYY)",
            "FY_END_DATE": "To (DD/MM/YYYY)",
            "DATE_AGM": "Date of AGM",
            "DATE_BOD_MEETING": "Date of board meeting",
            "SHARE_CAPITAL_CR": "(a) Share capital",
            "RESERVE_SURPLUS1": "(b) Reserves and surplus",
            "NET_WORTH_COMPAN": "Net Worth of the company",
            "TOTAL_REVENUE_CR": "(III) Total Income",
            "TOTAL_EXPENSES_C": "Total expenses",
            "PROFIT_BEF_TAX_C": "(IX) Profit before tax",
            "PROF_LOSS_OPER_C": "(XV) Profit /(Loss) (XI+XIV)",
            "SALES_SUPPLY_CR": "Domestic turnover",
            "NAME_AUDT_AUDTRF": "Name of the auditor or auditor's firm",
            "MEMBERSHIP_NUM_A": "Auditor's firm's registration number",
            "NAME_OF_MEMBER": "Name of auditor",
            "MEMBERSHIP_NUMBR": "Membership number of auditor",
        }

        def normalize_date(value: str) -> str:
            match = re.fullmatch(r"(\\d{4})-(\\d{2})-(\\d{2})", value)
            if match:
                return f"{match.group(3)}/{match.group(2)}/{match.group(1)}"
            return value

        lines: List[str] = [
            "XFA PDF DATA — extracted from MCA dynamic form datasets",
            "Form ID: " + str(
                leaves.get("datasets/data/data/ZTAB_FORM1_HIDDE/ZFORMID_C")
                or leaves.get("datasets/data/data/FORM_ID")
                or ""
            ),
        ]

        for field_path, value in leaves.items():
            field_name = field_path.rsplit("/", 1)[-1]
            label = aliases.get(field_name)
            if label:
                lines.append(f"{label}: {normalize_date(value)}")
            lines.append(f"XFA {field_name}: {value}")

        return "\n".join(lines)
    except Exception as exc:
        logger.warning("roc_sphere: XFA dataset extraction failed: %s", exc)
        return ""


def _extract_text_from_upload(filename: str, raw: bytes) -> str:
    name = (filename or "").lower()
    try:
        if name.endswith(".pdf"):
            import pdfplumber
            text_parts = []
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                for page in pdf.pages[:20]:
                    text_parts.append(page.extract_text() or "")
            text = "\n".join(text_parts).strip()

            # Dynamic/XFA MCA forms often expose only an Adobe Reader
            # "Please wait..." placeholder to ordinary PDF text extractors.
            # Recover the actual submitted values from AcroForm XFA datasets.
            placeholder = (
                "please wait" in text.lower()
                and "pdf viewer may not be able to display" in text.lower()
            )
            if not text or placeholder or len(re.sub(r"\\s+", "", text)) < 80:
                xfa_text = _extract_xfa_pdf_text(raw)
                if xfa_text:
                    return xfa_text
            return text
        if name.endswith((".xlsx", ".xlsm", ".xls")):
            import openpyxl
            wb = openpyxl.load_workbook(
                io.BytesIO(raw),
                data_only=True,
                read_only=True,
                keep_vba=name.endswith(".xlsm"),
            )
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    lines.append(" ".join(str(c) for c in row if c is not None))
            wb.close()
            return "\n".join(lines)
        if name.endswith(".csv"):
            return raw.decode("utf-8", errors="ignore")
        return raw.decode("utf-8", errors="ignore")
    except Exception as e:  # pragma: no cover
        logger.warning("roc_sphere: text extraction failed for %s: %s", filename, e)
        return ""


def _parse_mgt_shareholder_workbook(raw: bytes) -> List[Dict[str, Any]]:
    """Read the separate MCA MGT-7/MGT-7A shareholder attachment.

    MCA supplies this attachment as a macro-enabled workbook.  The
    shareholder table can move between sheets and the sheet may contain
    instructions above it, so locate the header row by its labels instead of
    relying on a fixed sheet/cell range.  VBA is never executed.
    """
    rows: List[Dict[str, Any]] = []
    try:
        import openpyxl
        wb = openpyxl.load_workbook(
            io.BytesIO(raw), read_only=True, data_only=True, keep_vba=True
        )
        for ws in wb.worksheets:
            header_row = None
            headers: Dict[str, int] = {}
            for row in ws.iter_rows(values_only=True):
                values = [str(v).strip() if v is not None else "" for v in row]
                lowered = [v.lower() for v in values]
                if any("name of shareholder" in v for v in lowered):
                    header_row = values
                    headers = {v.lower(): i for i, v in enumerate(values) if v}
                    break
            if not header_row:
                continue

            def cell(values: List[Any], label: str) -> Any:
                idx = next((i for h, i in headers.items() if label in h), None)
                return values[idx] if idx is not None and idx < len(values) else None

            for row in ws.iter_rows(values_only=True):
                values = list(row)
                name = cell(values, "name of shareholder")
                if not name or not str(name).strip():
                    continue
                name = re.sub(r"\s+", " ", str(name).strip())
                if name.lower().startswith("name of shareholder"):
                    continue
                share_count = _num(cell(values, "number of security"))
                face_value = _num(cell(values, "nominal value per security"))
                total_value = _num(cell(values, "total amount of securities"))
                rows.append({
                    "name": name,
                    "holder_type": cell(values, "type of shareholder"),
                    "category": cell(values, "category of shareholder"),
                    "details": cell(values, "details of shareholder"),
                    "class_of_shares": cell(values, "class of security") or cell(values, "type of security") or "Equity",
                    "folio_no": str(cell(values, "folio number") or "").strip() or None,
                    "nationality": cell(values, "nationality"),
                    "gender": cell(values, "gender"),
                    "identifier_type": cell(values, "type of identifier"),
                    "pan": cell(values, "identification no"),
                    "occupation": cell(values, "occupation"),
                    "shares_held": share_count,
                    "face_value": face_value or 10,
                    "total_value": total_value or share_count * (face_value or 10),
                    "percentage": None,
                })
        wb.close()
    except Exception as e:  # pragma: no cover
        logger.warning("roc_sphere: shareholder workbook parse failed: %s", e)
        return []

    total = sum(_num(row.get("shares_held")) for row in rows)
    if total:
        for row in rows:
            row["percentage"] = round(_num(row.get("shares_held")) / total * 100, 2)
    return rows


# ── director / shareholder register (MGT-7 / MGT-7A only) ─────────────────

def _parse_people(text: str) -> Dict[str, List[Dict[str, Any]]]:
    """Read the tabular director/signatory block in MCA MGT-7/MGT-7A text.

    A director "id" line must be a real DIN (8 digits) or a PAN
    (5 letters + 4 digits + 1 letter) — the previous version accepted any
    6-20 character alphanumeric line, which matched pincodes, page
    footers, dropdown option text and other boilerplate found on AOC-4/
    AOC-2/Board & Auditor report pages and produced garbage director rows.
    Callers must only invoke this for form_type in
    DIRECTOR_SHAREHOLDER_SOURCE_TYPES.
    """
    people: List[Dict[str, Any]] = []
    block_match = re.search(
        r"(?:Directors?/Signatory Details|Director/SignatoryDetails)(.*?)(?:Charges|No Records found|$)",
        text, re.I | re.S,
    )
    block = block_match.group(1) if block_match else text
    lines = [re.sub(r"\s+", " ", x).strip(" -:\t") for x in block.splitlines()]
    din_or_pan_re = re.compile(r"^\d{8}$|^[A-Z]{5}\d{4}[A-Z]$", re.I)
    for i, line in enumerate(lines):
        if not din_or_pan_re.fullmatch(line.replace(" ", "")):
            continue
        candidates = [x for x in lines[i + 1:i + 5] if x]
        name = next((x for x in candidates if re.search(r"[A-Za-z]", x) and len(x) >= 5
                     and not re.fullmatch(r"(Director|Promoter|Signatory|Active|Yes|No)", x, re.I)), None)
        if not name or any(p.get("din") == line for p in people):
            continue
        designation = next((x for x in candidates if re.search(
            r"director|partner|manager|secretary", x, re.I)), "Director")
        people.append({
            "name": name,
            "din": line,
            "designation": designation.title(),
            "date_of_appointment": next((x for x in candidates if re.fullmatch(
                r"\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}", x)), None),
        })
    return {"people": people}


def _parse_mgt_shareholders(text: str) -> List[Dict[str, Any]]:
    """Parse shareholder rows when the attached MGT-7/MGT-7A includes them.

    The filed MGT-7A often references a separate XLSM attachment and
    therefore contains only the shareholder count. In that case returning
    [] is correct and preserves the existing shareholder register instead
    of fabricating names. Callers must only invoke this for form_type in
    DIRECTOR_SHAREHOLDER_SOURCE_TYPES.
    """
    rows = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        m = re.match(r"^\d+\s+([A-Za-z][A-Za-z .,&'-]{3,})\s+([A-Z]{5}\d{4}[A-Z])?\s*(\d[\d,]*)\s*$", line)
        if m:
            rows.append({"name": m.group(1).strip(), "pan": m.group(2), "shares_held": _num(m.group(3).replace(",", "")), "class_of_shares": "Equity"})
    return rows


def _first_amount(text: str, patterns: List[str]) -> Optional[float]:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.M)
        if match:
            return _num(match.group(1).replace(",", ""))
    return None


def parse_mgt_annual_return(text: str) -> Dict[str, Any]:
    """Extract structured annual-return facts from MGT-7/MGT-7A.

    The separate XLSM attachment is the source for member rows; this parser
    captures the form-level facts that are useful for pre-filling filings and
    compliance decisions.
    """
    out: Dict[str, Any] = {}
    turnover = _first_amount(text, [
        r"\*?\s*Turnover\s+(-?[\d,]+(?:\.\d+)?)",
        r"Turnover\s*\(in Rs\.\)\s+(-?[\d,]+(?:\.\d+)?)",
    ])
    net_worth = _first_amount(text, [
        r"\*?\s*Net worth of the Company\s+(-?[\d,]+(?:\.\d+)?)",
        r"Net worth of the company\s+(-?[\d,]+(?:\.\d+)?)",
    ])
    paid_up = _first_amount(text, [
        r"Paid Up capital\s+(-?[\d,]+(?:\.\d+)?)",
        r"Paid-up capital\s+(-?[\d,]+(?:\.\d+)?)",
    ])
    if turnover is not None:
        out["turnover"] = turnover
    if net_worth is not None:
        out["net_worth"] = net_worth
    if paid_up is not None:
        out["paid_up_capital"] = paid_up

    count = _first_amount(text, [
        r"Number of shareholder/ debenture holder\s+([\d,]+)",
        r"Total number of shareholders \(Promoters \+ Other than promoters\)\s+([\d,]+(?:\.\d+)?)",
    ])
    if count is not None:
        out["shareholder_count"] = int(count)

    meeting_matches = re.findall(r"\*?Number of meetings held\s+([\d,]+)", text, re.I)
    meeting_count = max((_num(v) for v in meeting_matches), default=None)
    if meeting_count is not None:
        out["board_meetings_held"] = int(meeting_count)

    activity = re.search(
        r"\d+\s+([A-Z])\s+\d+\s+(.+?)\s+(\d+(?:\.\d+)?)\s*$",
        text,
        re.I | re.M,
    )
    if activity:
        out["principal_business_activity"] = {
            "main_activity_group_code": activity.group(1),
            "description": re.sub(r"\s+", " ", activity.group(2)).strip(),
            "turnover_percentage": _num(activity.group(3)),
        }

    out["filing_source"] = "MGT-7A / MGT-7"
    return out


def parse_dpt3(text: str) -> Dict[str, Any]:
    """Extract structured DPT-3 Return of Deposits / non-deposit loan data.

    DPT-3 contains a large Rule 2(1)(c) classification table.  Preserve the
    statutory row labels and all eight numeric columns rather than collapsing
    the table into one generic loan amount.  Values are retained as supplied
    by the filed form and keyed by financial/reporting period.
    """
    out: Dict[str, Any] = {"filing_source": "DPT-3", "form_no": "DPT-3"}
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    flat = "\n".join(lines)

    def first(patterns: List[str]) -> Optional[str]:
        for pattern in patterns:
            m = re.search(pattern, flat, re.I | re.M)
            if m:
                return re.sub(r"\\s+", " ", m.group(1)).strip()
        return None

    cin = first([r"Corporate identity number \\(CIN\\)\\s+([A-Z0-9]{21})"])
    name = first([r"Name of the Company\\s+(.+?)(?=\\s+\\d+\\s*\\(b\\)|\\n)"])
    period = first([r"Period for which return is being filed \\(DD/MM/YYYY\\)\\s+([0-3]\\d/[01]\\d/\\d{4})"])
    srn = first([r"eForm Service request number \\(SRN\\)\\s+([A-Z0-9]+)"])
    filing_date = first([r"eForm filing date \\(DD/MM/YYYY\\)\\s+([0-3]\\d/[01]\\d/\\d{4})"])
    if cin:
        out["cin"] = cin
    if name:
        out["company_name"] = name
    if period:
        out["return_period"] = period
    if srn:
        out["srn"] = srn
    if filing_date:
        out["filing_date"] = filing_date

    for key, patterns in {
        "paid_up_share_capital": [r"Paid up share capital\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "free_reserves": [r"Free reserves\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "securities_premium_account": [r"Securities Premium Account\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "accumulated_loss": [r"Accumulated Loss\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deferred_revenue_expenditure": [r"Balance of deferred revenue expenditure\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "accumulated_unprovided_depreciation": [r"Accumulated unprovided depreciation\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "miscellaneous_preliminary_expenses": [r"Miscellaneous expense and preliminary expenses\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "other_intangible_assets": [r"Other intangible assets\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "net_worth": [r"Net worth \\(a\\)\\s*[-–]\\s*\\(b\\)\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "maximum_deposit_limit": [r"Maximum limit of deposits.*?\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deposit_holders_beginning": [r"Total number of deposit holders as on 1st April\\s+([\\d,]+)"],
        "deposit_holders_end": [r"Total number of deposit holders at the end of financial year\\s+([\\d,]+)"],
        "existing_deposits_beginning": [r"Amount of existing deposits as at 1st April\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deposits_renewed_during_year": [r"Amount of deposits renewed during the year\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deposits_accepted_during_year": [r"Amount of deposits accepted during the year\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deposits_repaid_during_year": [r"Amount of deposits repaid during the year\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "deposits_outstanding_end": [r"Balance of deposits outstanding at the end of the year\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "matured_unclaimed": [r"Amount of deposits that have matured but not claimed\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "matured_claimed_not_paid": [r"Amount of deposits that have matured and claimed but not paid\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "charges_count": [r"Number of charges\\s+([\\d,]+)"],
        "dpt3_rule_2_1_c_total": [r"Total amounts of outstanding money or loan received by a company but not considered as deposits.*?\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
    }.items():
        value=first(patterns)
        if value is not None:
            out[key]=_num(value)

    # Liquid-asset facts.
    for key, patterns in {
        "deposits_maturing_next_period": [r"Amount of deposits maturing on or before 31st March next year.*?\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "liquid_assets_required": [r"Amount required to be invested in liquid assets\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
        "scheduled_bank_liquid_assets": [r"Amount in current or other deposits account, free from charge or lien, with.*?scheduled bank\\s+(-?[\\d,]+(?:\\.\\d+)?)"],
    }.items():
        value=first(patterns)
        if value is not None:
            out[key]=_num(value)

    # Preserve the Rule 2(1)(c) loan matrix as row objects.  The filed PDF
    # repeats the eight column headings on each page; capture numeric rows
    # following recognizable statutory category text.
    matrix_rows: List[Dict[str, Any]] = []
    current_label: Optional[str] = None
    skip_labels = {
        "opening balance", "additional loan", "during the year",
        "repaid during the year", "any other adjustment", "closing balance",
        "loans outstanding for less than or equal to 1 year",
        "loans outstanding for more than 1 year and less than 3 years",
        "loans outstanding for more than 3 years",
    }
    for line in lines:
        clean=line.strip(" -")
        if not clean:
            continue
        if clean.lower() in skip_labels:
            continue
        nums=re.findall(r"-?\\d+(?:,\\d{3})*(?:\\.\\d+)?", clean)
        if len(nums) >= 8 and current_label:
            values=[_num(n.replace(",", "")) for n in nums[-8:]]
            matrix_rows.append({
                "particular": current_label,
                "opening_balance": values[0],
                "additional_loan_during_year": values[1],
                "repaid_during_year": values[2],
                "other_adjustment": values[3],
                "closing_balance": values[4],
                "outstanding_upto_1_year": values[5],
                "outstanding_1_to_3_years": values[6],
                "outstanding_over_3_years": values[7],
            })
            current_label=None
            continue
        if not re.fullmatch(r"[-–—\\d., ]+", clean) and not re.match(r"^(Total|S\\.?No\\.?|Particulars|Details of loan|Ageing of loan)", clean, re.I):
            # Keep statutory row text; ignore ordinary table headings.
            if len(clean) > 12 and not any(x in clean.lower() for x in ("particulars", "details of loan", "ageing of loan")):
                current_label = clean if current_label is None else f"{current_label} {clean}"

    if matrix_rows:
        out["non_deposit_loan_matrix"]=matrix_rows

    # Attachments and declarations are useful evidence for compliance follow-up.
    attachment_names=[]
    if re.search(r"Copy of trust deed", text, re.I):
        attachment_names.append("Copy of trust deed")
    if re.search(r"List of depositors \\(excel format\\)", text, re.I):
        attachment_names.append("List of depositors (excel format)")
    if attachment_names:
        out["attachments_expected"]=attachment_names

    auditor_certified=bool(re.search(r"Declaration by Statutory Auditor", text, re.I))
    if auditor_certified:
        out["statutory_auditor_declaration_present"]=True
    resolution=first([r"resolution no \\*\\s*([\\dA-Za-z-]+)"])
    resolution_date=first([r"Dated \\*\\s*([0-3]\\d/[01]\\d/\\d{4})"])
    if resolution:
        out["board_resolution_no"]=resolution
    if resolution_date:
        out["board_resolution_date"]=resolution_date
    out["source_document_sections"]=[
        "Company Information","Net Worth","Deposits","Liquid Assets",
        "Charges","Rule 2(1)(c) Non-Deposit Loans","Credit Rating",
        "Attachments","Declarations","Filing Metadata"
    ]
    return out


def parse_adt1(text: str) -> Dict[str, Any]:
    """Extract the text-bearing fields of MCA Form ADT-1.

    ADT-1 is the appointment/continuance record for the statutory auditor.
    The parser deliberately stores the complete appointment particulars in
    adt1_data and also returns the compact fields that can safely populate
    Company Master.auditor. Checkbox-only choices are not guessed when the
    PDF text stream does not encode which radio button is selected.
    """
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    out: Dict[str, Any] = {
        "filing_source": "ADT-1",
        "form_no": "ADT-1",
    }

    def find_value(patterns: List[str], validator=None, start: int = 0, lookahead: int = 4) -> Optional[str]:
        for i in range(start, len(lines)):
            line = lines[i]
            for pattern in patterns:
                m = re.search(pattern, line, re.I)
                if m:
                    value = (m.group(1) if m.lastindex else "").strip(" :")
                    if value and (validator is None or validator(value)):
                        return value
                    for cand in lines[i + 1:i + 1 + lookahead]:
                        cand = cand.strip()
                        if cand and (validator is None or validator(cand)):
                            return cand
        return None

    date_re = lambda s: bool(_DATE_VALUE_RE.fullmatch(s))
    cin = find_value([r"Corporate Identity Number \\(CIN\\)\\s+([A-Z0-9]{21})"])
    name = find_value([r"Name of the company\\s+(.+)$"])
    registered_address = find_value(
        [r"Address of the registered office of the company\\s+(.+)$"],
        lambda s: len(s) >= 10,
        lookahead=6,
    )
    company_email = find_value([r"Email ID of the company\\s+(.+)$"])
    agm_date = find_value([r"If yes, date of AGM \\(DD/MM/YYYY\\)\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])
    appointment_date = find_value([r"Date of appointment \\(DD/MM/YYYY\\)\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])
    auditor_count = find_value([r"Number of auditor\\(s\\) appointed\\s+(\\d+)"])
    membership_no = find_value([r"Membership Number of Auditor signing the balance sheet of the company\\s+(\\d+)"])
    auditor_name = find_value([r"Name of the Auditor\\s+(.+)$"])
    auditor_pan = find_value([r"Income Tax permanent account number of auditor\\s+([A-Z]{5}\\d{4}[A-Z])"])
    # The first generic Email ID on ADT-1 is the company email. Locate the
    # auditor email only after the auditor address/name block (page 3).
    auditor_email = None
    auditor_name_idx = next((i for i, line in enumerate(lines) if re.search(r"Name of the Auditor\\s+", line, re.I)), -1)
    if auditor_name_idx >= 0:
        auditor_email = find_value([r"\\*?Email ID\\s+([*A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})"], start=auditor_name_idx + 1, lookahead=25)
    from_date = find_value([r"From \\(DD/MM/YYYY\\)\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])
    till_date = find_value([r"To \\(DD/MM/YYYY\\)\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])
    fy_count = find_value([r"Number of financial year\\(s\\) to which appointment relates\\s+(\\d+)"])
    previous_year_count = find_value([r"Number of financial year\\(s\\)\\s+(\\d+)"])
    filing_srn = find_value([r"eForm Service request number \\(SRN\\)\\s+([A-Z0-9]+)$"])
    filing_date = find_value([r"eForm filing date \\(DD/MM/YYYY\\)\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])
    signer_din = find_value([r"Director identification number.*"], validator=lambda s: bool(re.search(r"\\b\\d{8}\\b", s)), lookahead=8)
    if signer_din and not signer_din.isdigit():
        m_signer = re.search(r"\\b(\\d{8})\\b", signer_din)
        signer_din = m_signer.group(1) if m_signer else signer_din
    resolution_date = find_value([r"resolution number.*?dated.*?\\s+([0-3]?\\d/[01]?\\d/\\d{4})"])

    # Multi-line auditor address: the ADT-1 form has separate labelled lines.
    auditor_address_parts = []
    for label, pattern in (
        ("address_line_1", r"Address Line 1\\s+(.+)$"),
        ("address_line_2", r"Address Line 2\\s+(.+)$"),
        ("country", r"Country\\s+(.+)$"),
        ("pin_code", r"Pin Code/Zip Code\\s+([0-9A-Za-z -]+)$"),
        ("area_locality", r"Area/Locality\\s+(.+)$"),
        ("city", r"City\\s+(.+)$"),
        ("district", r"District\\s+(.+)$"),
        ("state", r"State/UT\\s+(.+)$"),
    ):
        v = find_value([pattern])
        if v:
            out[f"auditor_{label}"] = v
            if label.startswith("address_") or label in ("city", "district", "state", "area_locality", "country", "pin_code"):
                auditor_address_parts.append(v)
    if auditor_address_parts:
        out["auditor_address"] = ", ".join(dict.fromkeys(auditor_address_parts))

    # Auditor firm fields can be blank for an individual auditor.
    for key, patterns in {
        "category": [r"Category of Auditor\\s+(.+)$"],
        "firm_reg_no": [r"Firm Registration Number\\s+([A-Z0-9-]+)$"],
        "firm_name": [r"Name of the Auditor's Firm\\s+(.+)$"],
        "firm_pan": [r"Income Tax permanent account number of auditor's firm\\s+([A-Z]{5}\\d{4}[A-Z])$"],
        "firm_email": [r"Email ID\\s+([*A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})$"],
        "previous_appointment_tenure": [r"Specify the tenure of previous appointment\\(s\\).*?\\s+(.+)$"],
        "inc28_srn": [r"Specify the SRN of INC-28.*?\\s+([A-Z0-9]+)$"],
        "casual_vacancy_srn": [r"Specify the SRN of relevant form\\s+([A-Z0-9]+)$"],
        "casual_vacancy_date": [r"Mention the date of casual vacancy.*?\\s+([0-3]?\\d/[01]?\\d/\\d{4})$"],
        "vacating_firm_reg_no": [r"Registration number of auditor's firm who has vacated the office\\s+([A-Z0-9-]+)$"],
        "vacating_membership_no": [r"Membership number of the auditor\\s+(\\d+)$"],
        "casual_vacancy_reason": [r"Reasons of the casual vacancy\\s+(.+)$"],
    }.items():
        v=find_value(patterns)
        if v:
            out[key]=v

    if cin: out["cin"]=cin
    if name: out["company_name"]=name
    if registered_address: out["registered_office_address"]=registered_address
    if company_email: out["company_email"]=company_email
    if agm_date: out["agm_date"]=agm_date
    if appointment_date: out["appointment_date"]=appointment_date
    if auditor_count: out["auditor_count"]=int(_num(auditor_count))
    if membership_no: out["membership_no"]=membership_no
    if auditor_name: out["auditor_name"]=auditor_name
    if auditor_pan: out["auditor_pan"]=auditor_pan
    if auditor_email: out["auditor_email"]=auditor_email
    if from_date: out["appointed_from"]=from_date
    if till_date: out["appointed_till"]=till_date
    if fy_count: out["financial_year_count"]=int(_num(fy_count))
    if previous_year_count: out["previous_appointment_year_count"]=int(_num(previous_year_count))
    if filing_srn: out["filing_srn"]=filing_srn
    if filing_date: out["filing_date"]=filing_date
    if signer_din: out["signatory_din"]=signer_din
    if resolution_date: out["board_resolution_date"]=resolution_date

    # Attachment names are useful evidence for the filing record.
    attachments=[]
    for line in lines:
        if re.search(r"(?:intimation|consent|eligibility|resignation letter|central government order)", line, re.I):
            if ".pdf" in line.lower() or "attachment" in line.lower():
                attachments.append(line)
    if attachments:
        out["attachments"]=list(dict.fromkeys(attachments))

    return out


def parse_audit_report_shareholders(text: str) -> List[Dict[str, Any]]:
    """Best-effort extraction of a shareholding pattern from the current-year
    audit-report/financial-statement text. If the audit material does not
    contain an identifiable holder table, return [] and leave the prior MGT-7
    register unchanged rather than inventing or clearing shareholders."""
    rows: List[Dict[str, Any]] = []
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    in_section = False
    for line in lines:
        if re.search(r"shareholding pattern|pattern of shareholding|shareholders|share capital", line, re.I):
            in_section = True
            continue
        if in_section and re.search(r"(directors|key managerial|auditor|independent auditor|related parties|earnings per share|cash flows)", line, re.I):
            if rows:
                break
        if not in_section:
            continue
        # Common financial-statement table shape:
        # Holder Name | No. of Shares | % / PAN. Keep matching deliberately
        # conservative so ordinary narrative text is never treated as a holder.
        m = re.match(
            r"^([A-Za-z][A-Za-z .,&'()/-]{2,100})\s+(?:([A-Z]{5}\d{4}[A-Z])\s+)?([\d,]+)(?:\s+([\d.]+)\s*%?)?$",
            line,
            re.I,
        )
        if not m:
            continue
        name = re.sub(r"\s+", " ", m.group(1)).strip(" .-")
        if re.search(r"total|particulars|promoter|public|equity shares|authorised|issued|paid", name, re.I):
            continue
        shares = _num(m.group(3).replace(",", ""))
        if shares <= 0:
            continue
        rows.append({
            "name": name,
            "pan": m.group(2),
            "shares_held": shares,
            "percentage": _num(m.group(4)) if m.group(4) else None,
            "class_of_shares": "Equity",
        })
    return rows


def parse_auditor_report(text: str) -> Dict[str, Any]:
    """Capture audit-report facts for review and Board's Report drafting."""
    out: Dict[str, Any] = {}
    qualified = _first_amount(text, [
        r"Number of qualifications, reservation or adverse remark or disclaimer\s+([\d,]+)",
    ])
    if qualified is not None:
        out["qualifications_count"] = int(qualified)
    out["caro_applicable"] = bool(re.search(
        r"whether companies auditors report order.*?applicable.*?\bYes\b",
        text,
        re.I | re.S,
    ))
    opinion = _extract_section(text, "Opinion of the auditor", "Basis of Opinion")
    if opinion:
        out["opinion"] = opinion
    basis = _extract_section(text, "Basis of Opinion", "Emphasis of matter")
    if basis:
        out["basis_of_opinion"] = basis
    other = _extract_section(text, "State other matters as per Rule 11", "State any other matters")
    if other:
        out["rule_11_other_matters"] = other
    controls = _extract_section(text, "Reporting on the Internal Financial Controls", "Attachments")
    if controls:
        out["internal_financial_controls"] = controls
    return out


def _extract_section(text: str, start_label: str, end_label: str) -> Optional[str]:
    match = re.search(
        rf"{re.escape(start_label)}(.*?){re.escape(end_label)}",
        text,
        re.I | re.S,
    )
    if not match:
        return None
    value = re.sub(r"\s+", " ", match.group(1)).strip(" :-")
    return value[:4000] if value else None


def parse_board_report(text: str) -> Dict[str, Any]:
    """Capture Board's Report disclosures as structured filing context."""
    out: Dict[str, Any] = {}
    meetings = _first_amount(text, [r"Number of meetings held\s+([\d,]+)"])
    if meetings is not None:
        out["board_meetings_held"] = int(meetings)
    for key, label, end in (
        ("state_of_affairs", "Description of state of company’s affairs", "Disclosure relating to amounts"),
        ("reserves_recommendation", "Disclosure relating to amounts if any which is proposed to carry to any reserves", "Disclosures relating to amount recommended"),
        ("dividend_recommendation", "Disclosures relating to amount recommended to be paid as dividend", "Details of material changes"),
        ("material_changes", "Details of material changes and commitment occurred during period", "Disclosure of statement on development"),
        ("risk_management", "Disclosure of statement on development and implementation of risk management policy", "CSR details"),
        ("financial_summary", "Disclosure of financial summary or highlights", "Disclosure of change in nature of business"),
        ("business_change", "Disclosure of change in nature of business", "Details of directors or key managerial personnel"),
    ):
        value = _extract_section(text, label, end)
        if value:
            out[key] = value
    out["csr_applicable"] = bool(re.search(
        r"whether CSR is applicable as per section 135\s+Yes",
        text,
        re.I,
    ))
    return out


def _parse_mgt_annual_return_directors(text: str) -> List[Dict[str, Any]]:
    """Parse the DIN/name/attendance table embedded in MGT-7/MGT-7A."""
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    people: List[Dict[str, Any]] = []
    din_re = re.compile(r"^\d{8}$")
    for i, line in enumerate(lines):
        if not din_re.fullmatch(line):
            continue
        window = [x for x in lines[i + 1:i + 12] if x]
        name_parts: List[str] = []
        for candidate in window:
            if re.fullmatch(r"\d+(?:\.\d+)?", candidate):
                break
            if re.search(
                r"number of|meeting|attendance|whether|director|board|yes|no|name of|date of|designation|net worth|turnover|share holding|capital|pattern",
                candidate,
                re.I,
            ):
                break
            if re.search(r"[A-Za-z]", candidate):
                name_parts.append(candidate)
        name = " ".join(name_parts[:3]) if name_parts else None
        if not name or any(p.get("din") == line for p in people):
            continue
        people.append({
            "name": name,
            "din": line,
            "designation": "Director",
            "date_of_appointment": None,
            "attendance": {
                "meetings_entitled": _first_amount(
                    " ".join(window),
                    [r"(\d+)\s+\d+\s+\d+(?:\.\d+)?"],
                ),
            },
        })
    return people


def _parse_directors_for_form(form_type: str, filename: str, raw: bytes, text: str) -> List[Dict[str, Any]]:
    """Directors register — gated to MGT-7/MGT-7A. Prefers the bordered
    table-grid reader (far more reliable than a text-line scan) and only
    falls back to the text-regex scan above when no bordered table is
    found, e.g. an MGT-7A that was flattened/scanned oddly."""
    if form_type not in DIRECTOR_SHAREHOLDER_SOURCE_TYPES:
        return []
    if (filename or "").lower().endswith((".xlsx", ".xlsm", ".csv")):
        return []
    people = _parse_mgt_annual_return_directors(text) if form_type in {"mgt-7", "mgt-7a"} else []
    if not people:
        people = _parse_master_director_tables(raw) if (filename or "").lower().endswith(".pdf") else []
    if not people:
        people = _parse_people(text)["people"]
    return people


def _parse_shareholders_for_form(form_type: str, filename: str, raw: bytes, text: str) -> List[Dict[str, Any]]:
    """Shareholder register — gated to MGT-7/MGT-7A."""
    if form_type not in DIRECTOR_SHAREHOLDER_SOURCE_TYPES:
        return []
    if (filename or "").lower().endswith((".xlsx", ".xlsm")):
        return _parse_mgt_shareholder_workbook(raw)
    return _parse_mgt_shareholders(text)


# ── general Company Master fields (any recognised ROC form) ───────────────
# MCA e-form PDFs render each field as a label followed by its value —
# sometimes on the same line ("*Name of the Company PRODIGIST … LIMITED"
# on AOC-2/Board's/Auditor's Report), sometimes with the value in the box
# below the label ("*Corporate identity number (CIN)" / value on the next
# line, as on AOC-4). _extract_labeled_value() below tries the same-line
# remainder first and only falls back to scanning forward when that
# remainder doesn't validate — this is what keeps e.g. a bare label like
# "Address of the registered office of the company" (nothing left over
# after stripping the label text) from being read as its own value.

STOP_MARKER_RE = re.compile(r"^\(?[a-hj-vx-z]\)\s|^\(?[ivx]{1,4}\)\s", re.I)
_TRUNC_ENDING_WORDS = ("private", "pvt", "the", "of", "and", "&", "-")

_DATE_VALUE_RE = re.compile(r"^[0-3]?\d[/\-][01]?\d[/\-]\d{2,4}$")
_NUM_VALUE_RE = re.compile(r"^[\d,]+(\.\d+)?$")
_CIN_VALUE_RE = re.compile(r"^[A-Z0-9]{21}$")
_NAME_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 &.,'\-]{1,90}$")
_ANY_TEXT_VALUE_RE = re.compile(r"^.{4,150}$")
_ALNUM_ID_VALUE_RE = re.compile(r"^[A-Za-z0-9]{4,20}$")


def _find_label_line(lines: List[str], phrases: List[str], start: int = 0):
    """First line at/after `start` containing any phrase (longer phrases
    should be listed first so a more specific label wins over a shorter
    one that happens to be a substring of it)."""
    low = [p.lower() for p in phrases]
    for i in range(start, len(lines)):
        ll = lines[i].lower()
        for p in low:
            if p in ll:
                return i, p
    return -1, None


def _extract_labeled_value(lines: List[str], label_idx: int, phrase: str, validator, join_multiline: bool = False, max_lookahead: int = 6) -> Optional[str]:
    line = lines[label_idx]
    ll = line.lower()
    p_idx = ll.find(phrase)
    remainder = line[p_idx + len(phrase):].strip(" :()-\t*") if p_idx != -1 else ""
    if remainder and validator(remainder):
        collected = [remainder]
        # a same-line value that trails off mid-word ("… PRIVATE") is
        # completed from the immediate next line ("LIMITED"); a complete
        # value is left alone so the next label's text is never pulled in.
        if join_multiline and remainder.strip().lower().split(" ")[-1] in _TRUNC_ENDING_WORDS:
            for j in range(label_idx + 1, min(label_idx + 3, len(lines))):
                cand = lines[j].strip()
                if not cand or STOP_MARKER_RE.match(cand):
                    break
                if validator(cand):
                    collected.append(cand)
                break
        return " ".join(collected)
    collected: List[str] = []
    for j in range(label_idx + 1, min(label_idx + 1 + max_lookahead, len(lines))):
        cand = lines[j].strip()
        if not cand:
            continue
        is_stop = bool(STOP_MARKER_RE.match(cand))
        ok = bool(validator(cand))
        if is_stop and (collected or not ok):
            break
        if ok:
            collected.append(cand)
            if not join_multiline:
                break
        elif collected:
            break
    return " ".join(collected) if collected else None


# (field, label phrases — longest/most specific first, validator, join multi-line?, lookahead)
ROC_GENERAL_FIELD_SPECS = [
    ("cin", ["corporate identity number", "llpin"], lambda s: bool(_CIN_VALUE_RE.match(s)), False, 3),
    ("company_name", ["name of the company", "name of company", "llp name"], lambda s: bool(_NAME_VALUE_RE.match(s)), True, 3),
    ("registered_office_address",
     ["address of the registered office of the company", "address of the registered office", "registered office address"],
     lambda s: bool(_ANY_TEXT_VALUE_RE.match(s)), True, 6),
    ("authorized_capital", ["authorised capital of the company", "authorized capital of the company"], lambda s: bool(_NUM_VALUE_RE.match(s)), False, 3),
    ("last_agm_date", ["date of agm"], lambda s: bool(_DATE_VALUE_RE.match(s)), False, 3),
    ("last_board_meeting_date", ["date of board of directors", "date of board meeting"], lambda s: bool(_DATE_VALUE_RE.match(s)), False, 3),
]


def parse_roc_general_fields(text: str) -> Dict[str, Any]:
    """Company Master fields common to (most) ROC forms — safe to apply
    regardless of which recognised form type the upload turned out to be,
    since none of these are director/shareholder/financial data."""
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    extracted: Dict[str, Any] = {}
    for field, phrases, validator, join_multi, lookahead in ROC_GENERAL_FIELD_SPECS:
        idx, phrase = _find_label_line(lines, phrases)
        if idx == -1:
            continue
        val = _extract_labeled_value(lines, idx, phrase, validator, join_multi, lookahead)
        if val:
            extracted[field] = _num(val) if field == "authorized_capital" else val
    return extracted


# ── financial data + auditor (AOC-4 only) ──────────────────────────────────
# AOC-4's Balance Sheet / P&L segments print each line item and its
# current/previous-period figures on one line ("(IX) Profit before tax
# (VII-VIII) -94343.00 -132689.00"), so these are simple same-line regexes
# rather than the label/value scan used for the general fields above.

AOC4_FINANCIAL_PATTERNS = {
    "total_income": r"\(III\)\s*Total Income.*?(-?[\d,]+\.\d{2})",
    "total_expenses": r"Total expenses\s+(-?[\d,]+\.\d{2})",
    "profit_before_tax": r"\(IX\)\s*Profit before tax.*?(-?[\d,]+\.\d{2})",
    "profit_after_tax": r"\(XV\)\s*Profit\s*/\(Loss\).*?(-?[\d,]+\.\d{2})",
    "net_worth": r"Net Worth of the company\s+(-?[\d,]+(?:\.\d+)?)",
    "share_capital": r"\(a\)\s*Share capital\s+(-?[\d,]+)",
    "reserves_and_surplus": r"\(b\)\s*Reserves and surplus\s+(-?[\d,]+)",
    "turnover": r"Domestic turnover\s+(?:\n\s*)?(?:\(i\)\s*Sale of goods manufactured\s+)?(-?[\d,]+(?:\.\d+)?)",
}


def parse_aoc4_financials(text: str) -> Dict[str, Any]:
    """Balance Sheet / P&L key figures — only meaningful for form_type ==
    'aoc-4'; callers must gate on that before calling this."""
    out: Dict[str, Any] = {}
    for field, pattern in AOC4_FINANCIAL_PATTERNS.items():
        m = re.search(pattern, text)
        if m:
            out[field] = _num(m.group(1))
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]

    def nearby_amount(labels: List[str], lookahead: int = 12, prefer_last: bool = False) -> Optional[float]:
        for i, line in enumerate(lines):
            if not any(label.lower() in line.lower() for label in labels):
                continue
            values = []
            for candidate in lines[i + 1:i + 1 + lookahead]:
                if re.fullmatch(r"-?[\d,]+(?:\.\d+)?", candidate):
                    values.append(_num(candidate))
            if values:
                if prefer_last:
                    # Printed forms often put a two-digit row number before
                    # the actual amount and the next row's zero after it.
                    substantive = [value for value in values if abs(value) > 100]
                    return (substantive[-1] if substantive else values[-1])
                return values[0]
        return None

    # MCA's printable AOC-4 places some labels, row numbers and values on
    # separate lines. Prefer the label-aware value over a regex hit that can
    # accidentally capture a row index (for example, Net Worth's "42").
    net_worth = nearby_amount(["Net Worth of the company"], prefer_last=True)
    if net_worth is not None:
        out["net_worth"] = net_worth
    pbt = nearby_amount(["Profit before exceptional", "Profit before tax"])
    if pbt is not None:
        out["profit_before_tax"] = pbt
    pat = nearby_amount(["Profit/(Loss) for the period from continuing operations", "Profit /(Loss) (XI+XIV)"])
    if pat is not None:
        out["profit_after_tax"] = pat
    if "total_income" not in out and out.get("total_expenses") is not None and out.get("profit_before_tax") is not None:
        out["total_income"] = out["total_expenses"] + out["profit_before_tax"]
    if "turnover" not in out:
        # Fallback for PDFs where the "Domestic turnover" label is on its
        # own line and the first operating-revenue row follows later.
        m = re.search(
            r"Domestic turnover.*?\(i\)\s*Sale of goods manufactured\s+(-?[\d,]+(?:\.\d+)?)",
            text,
            re.I | re.S,
        )
        if m:
            out["turnover"] = _num(m.group(1))
    # the Balance Sheet's grand total is printed twice (Equity & Liabilities
    # total, then Assets total) with identical figures — take the first.
    m = re.search(r"^Total\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$", text, re.M)
    if m:
        out["balance_sheet_total"] = _num(m.group(1))
    idx, _ = _find_label_line(lines, ["financial year to which financial statements relates"])
    if idx != -1:
        idx_from, p1 = _find_label_line(lines, ["from (dd/mm/yyyy)"], idx)
        if idx_from != -1:
            v = _extract_labeled_value(lines, idx_from, p1, lambda s: bool(_DATE_VALUE_RE.match(s)), False, 2)
            if v:
                out["period_from"] = v
            idx_to, p2 = _find_label_line(lines, ["to (dd/mm/yyyy)"], idx_from + 1)
            if idx_to != -1:
                v = _extract_labeled_value(lines, idx_to, p2, lambda s: bool(_DATE_VALUE_RE.match(s)), False, 2)
                if v:
                    out["period_to"] = v
    return out


def parse_aoc4_auditor(text: str) -> Dict[str, Any]:
    """Statutory Auditor name, firm registration number, membership number
    and appointment period — only meaningful for form_type == 'aoc-4';
    callers must gate on that.

    firm_reg_no and membership_no used to share one _find_label_line()
    lookup (["...firm's registration number", "membership number of
    auditor"]) with a single OR match, so whichever label happened to
    appear first in the PDF's text flow silently ate both fields under
    firm_reg_no and membership_no was never populated — the working-paper
    draft always showed "—" for Membership No. regardless of what was
    uploaded. These are now two independent lookups."""
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    out: Dict[str, Any] = {}
    idx, p = _find_label_line(lines, ["name of the auditor or auditor's firm", "name of the auditor"])
    if idx != -1:
        v = _extract_labeled_value(lines, idx, p, lambda s: bool(_NAME_VALUE_RE.match(s)) and "address" not in s.lower(), True, 2)
        if v:
            out["name"] = v
    idx, p = _find_label_line(lines, ["auditor's firm's registration number", "firm's registration number"])
    if idx != -1:
        v = _extract_labeled_value(lines, idx, p, lambda s: bool(_ALNUM_ID_VALUE_RE.match(s)), False, 2)
        if v:
            out["firm_reg_no"] = v
    idx, p = _find_label_line(lines, ["membership number of auditor", "membership number"])
    if idx != -1:
        v = _extract_labeled_value(lines, idx, p, lambda s: bool(_ALNUM_ID_VALUE_RE.match(s)), False, 2)
        if v:
            out["membership_no"] = v
    idx, p = _find_label_line(lines, ["period of account for which auditor appointed", "date of appointment of auditor", "period of appointment"])
    if idx != -1:
        idx_from, p1 = _find_label_line(lines, ["from (dd/mm/yyyy)", "from"], idx)
        if idx_from != -1 and idx_from <= idx + 3:
            v = _extract_labeled_value(lines, idx_from, p1, lambda s: bool(_DATE_VALUE_RE.match(s)), False, 2)
            if v:
                out["appointed_from"] = v
            idx_to, p2 = _find_label_line(lines, ["to (dd/mm/yyyy)", "to"], idx_from + 1)
            if idx_to != -1 and idx_to <= idx_from + 3:
                v = _extract_labeled_value(lines, idx_to, p2, lambda s: bool(_DATE_VALUE_RE.match(s)), False, 2)
                if v:
                    out["appointed_till"] = v
    return out


@router.post("/companies/{company_id}/upload-master-data")
async def upload_master_data(
    company_id: str,
    files: List[UploadFile] = File(...),
    apply: bool = Form(False),
    source_type: str = Form("roc"),
    filing_category: str = Form("auto"),
    current_user: User = Depends(CREATE),
):
    """Upload ROC Forms — AOC-4, AOC-2, MGT-7, MGT-7A, Board's/Auditor's
    Report extracts, DIR-12, ADT-1, INC-22, PAS-3, MGT-14, DPT-3
    acknowledgement PDFs — and best-effort extract filing data to prefill
    the company master. Each field is only ever taken from its statutory
    source form (see the block comment above this section): Company
    Master fields from any recognised form, the Director/Signatory
    register and Shareholder register only from MGT-7/MGT-7A, and
    financial data + Auditor details only from AOC-4.

    This is the *filing extraction* path and is intentionally separate
    from the Master Data importer below (`/companies/{id}/master-data/
    fetch`), which reads the MCA "Company/LLP Master Data" export
    instead. Robust to partial batch failures: one unreadable file no
    longer aborts the whole upload.

    filing_category ("auto" | "previous_year_annual" | "current_year_other"
    | "current_year_audit") is set by which of the three Upload ROC Forms
    lanes the file was dropped into on the frontend. When it isn't "auto",
    every file is checked against that lane's fixed form-type set and its
    best-guess filing year: a wrong-lane form type, or a form whose printed
    year doesn't match what that lane expects for today's date, is skipped
    (with an explanatory error) instead of being applied — this is what
    stops an old/stale form from quietly overwriting current company data.
    """
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if not files:
        raise HTTPException(400, "Choose at least one ROC form or MGT-7/MGT-7A attachment")
    if filing_category not in ("auto", *FILING_CATEGORY_FORM_TYPES.keys()):
        filing_category = "auto"

    results = []
    errors: List[str] = []
    warnings: List[str] = []
    conflicts: List[Dict[str, Any]] = []
    roc_extracted: Dict[str, Any] = {}
    total_size = 0

    for uploaded in files:
        filename = uploaded.filename or "uploaded-file"
        if not filename.lower().endswith(ROC_FORM_ALLOWED_EXT):
            errors.append(f"{filename}: skipped — use PDF, XLSX, XLSM or CSV for ROC filing data")
            continue
        raw = await uploaded.read()
        total_size += len(raw)
        if total_size > 50 * 1024 * 1024:
            errors.append(f"{filename}: skipped — combined upload exceeds the 50MB limit")
            continue
        if not raw:
            errors.append(f"{filename}: skipped — empty file")
            continue
        try:
            text = _extract_text_from_upload(filename, raw)
        except Exception as e:  # a single corrupt/scanned PDF must not kill the batch
            logger.warning("roc_sphere upload-roc-form: failed to parse %s: %s", filename, e)
            errors.append(f"{filename}: could not be read — it may be scanned/image-only or password-protected")
            continue
        if not text.strip():
            errors.append(f"{filename}: could not be read — it may be scanned/image-only or password-protected")
            continue

        form_type = _identify_roc_form_type(filename, text)
        document_fy = _extract_document_fy(text)
        expected_fy = _expected_fy_for_category(filing_category) if filing_category != "auto" else None

        if filing_category != "auto" and form_type != "roc-form":
            allowed_types = FILING_CATEGORY_FORM_TYPES[filing_category]
            if form_type not in allowed_types:
                correct_category = _category_for_form_type(form_type)
                correct_label = FILING_CATEGORY_LABELS.get(correct_category, "a different lane")
                errors.append(
                    f"{filename}: this looks like a {form_type.upper()} form — that belongs under "
                    f"\"{correct_label}\", not \"{FILING_CATEGORY_LABELS[filing_category]}\". Skipped, not applied."
                )
                continue
            if document_fy and expected_fy and document_fy != expected_fy:
                errors.append(
                    f"{filename}: this form is for FY {document_fy}, but \"{FILING_CATEGORY_LABELS[filing_category]}\" "
                    f"expects an FY {expected_fy} form. Old/mismatched-year forms are never applied — skipped."
                )
                continue
            if not document_fy:
                warnings.append(
                    f"{filename}: could not confirm the filing year automatically — please check this is an "
                    f"FY {expected_fy} form before relying on it."
                )

        extracted: Dict[str, Any] = parse_roc_general_fields(text)

        directors = _parse_directors_for_form(form_type, filename, raw, text)
        if directors:
            extracted["_directors"] = directors
        shareholders = _parse_shareholders_for_form(form_type, filename, raw, text)
        if shareholders:
            extracted["_shareholders"] = shareholders

        if form_type == FINANCIAL_SOURCE_TYPE:
            financials = parse_aoc4_financials(text)
            if financials:
                extracted["_financials"] = financials
            auditor = parse_aoc4_auditor(text)
            if auditor:
                extracted["_auditor"] = auditor
        if form_type in {"mgt-7", "mgt-7a"} and filename.lower().endswith(".pdf"):
            annual_return = parse_mgt_annual_return(text)
            if annual_return:
                extracted["_annual_return"] = annual_return
        if form_type == "dpt-3":
            dpt3 = parse_dpt3(text)
            if dpt3:
                extracted["_dpt3"] = dpt3
        if form_type == "adt-1":
            adt1 = parse_adt1(text)
            if adt1:
                extracted["_adt1"] = adt1
                # Keep the compact auditor card in sync with appointment data.
                extracted["_auditor"] = {
                    "name": adt1.get("auditor_name"),
                    "membership_no": adt1.get("membership_no"),
                    "appointed_from": adt1.get("appointed_from"),
                    "appointed_till": adt1.get("appointed_till"),
                    "pan": adt1.get("auditor_pan"),
                    "email": adt1.get("auditor_email"),
                    "address": adt1.get("auditor_address"),
                    "category": adt1.get("category"),
                    "firm_reg_no": adt1.get("firm_reg_no"),
                    "firm_name": adt1.get("firm_name"),
                }
        if form_type == "auditor-report":
            audit_report = parse_auditor_report(text)
            audit_shareholders = parse_audit_report_shareholders(text)
            if audit_report:
                extracted["_audit_report"] = audit_report
            if audit_shareholders:
                extracted["_audit_shareholders"] = audit_shareholders
        if form_type == "board-report":
            board_report = parse_board_report(text)
            if board_report:
                extracted["_board_report"] = board_report

        extracted["_source_type"] = form_type
        fields_found = {k: v for k, v in extracted.items() if not k.startswith("_")}
        results.append({"filename": filename, "source_type": form_type, "extracted": fields_found,
                         "fields_found": len(fields_found),
                         "director_rows": len(extracted.get("_directors") or []),
                         "shareholder_rows": len(extracted.get("_shareholders") or []),
                         "filing_category": filing_category if filing_category != "auto" else None,
                         "document_fy": document_fy})
        for key, value in extracted.items():
            if not key.startswith("_") and value:
                if key in roc_extracted and roc_extracted[key] != value:
                    conflicts.append({
                        "field": key,
                        "kept": value,
                        "previous": roc_extracted[key],
                        "source": filename,
                        "message": "Later upload value is shown as the candidate; review before Apply.",
                    })
                roc_extracted[key] = value
        if extracted.get("_directors"):
            roc_extracted["_directors"] = (roc_extracted.get("_directors") or []) + extracted["_directors"]
        if extracted.get("_shareholders"):
            roc_extracted["_shareholders"] = (roc_extracted.get("_shareholders") or []) + extracted["_shareholders"]
        if extracted.get("_financials"):
            roc_extracted["_financials"] = {**(roc_extracted.get("_financials") or {}), **extracted["_financials"]}
        if extracted.get("_auditor"):
            roc_extracted["_auditor"] = {**(roc_extracted.get("_auditor") or {}), **extracted["_auditor"]}
        if extracted.get("_annual_return"):
            roc_extracted["_annual_return"] = {**(roc_extracted.get("_annual_return") or {}), **extracted["_annual_return"]}
        if extracted.get("_audit_report"):
            roc_extracted["_audit_report"] = {**(roc_extracted.get("_audit_report") or {}), **extracted["_audit_report"]}
        if extracted.get("_audit_shareholders"):
            roc_extracted["_audit_shareholders"] = (roc_extracted.get("_audit_shareholders") or []) + extracted["_audit_shareholders"]
        if extracted.get("_board_report"):
            roc_extracted["_board_report"] = {**(roc_extracted.get("_board_report") or {}), **extracted["_board_report"]}
        if extracted.get("_adt1"):
            roc_extracted["_adt1"] = {**(roc_extracted.get("_adt1") or {}), **extracted["_adt1"]}
        if extracted.get("_dpt3"):
            roc_extracted["_dpt3"] = {**(roc_extracted.get("_dpt3") or {}), **extracted["_dpt3"]}

    if not any(k for k in roc_extracted if not k.startswith("_")) and not any(
        roc_extracted.get(k) for k in ("_directors", "_shareholders", "_financials", "_auditor", "_annual_return", "_audit_report", "_board_report")
    ):
        return {
            "extracted": {},
            "results": results,
            "applied": False,
            "errors": errors,
            "warnings": warnings,
            "conflicts": conflicts,
            "message": errors[0] if errors and len(errors) == len(files) else
                       "Could not confidently extract fields from these forms — please enter details manually.",
        }

    if apply:
        clean = {k: v for k, v in roc_extracted.items() if not k.startswith("_") and v}
        if roc_extracted.get("_directors"):
            if company.get("category") == "llp":
                clean["designated_partners"] = roc_extracted["_directors"]
                clean["partners"] = roc_extracted["_directors"]
            else:
                clean["directors"] = roc_extracted["_directors"]
        if roc_extracted.get("_shareholders"):
            previous = list(roc_extracted["_shareholders"])
            previous_fy = next((r.get("document_fy") for r in results if r.get("source_type") in {"mgt-7", "mgt-7a"} and r.get("document_fy")), None)
            for holder in previous:
                holder["register_source"] = "MGT-7 / MGT-7A"
                holder["register_source_fy"] = previous_fy
                holder["audit_verified"] = False
                holder["verification_status"] = "Awaiting current-year Audit Report verification"
            clean["shareholders"] = previous
        if roc_extracted.get("_audit_shareholders"):
            current = list(company.get("shareholders") or clean.get("shareholders") or [])
            for audit_holder in roc_extracted["_audit_shareholders"]:
                key_name = str(audit_holder.get("name") or "").strip().lower()
                key_pan = str(audit_holder.get("pan") or "").strip().lower()
                match = next(
                    (h for h in current if
                     (key_pan and str(h.get("pan") or "").strip().lower() == key_pan) or
                     (key_name and str(h.get("name") or "").strip().lower() == key_name)),
                    None,
                )
                if match:
                    match.update({
                        "shares_held": audit_holder.get("shares_held", match.get("shares_held", 0)),
                        "percentage": audit_holder.get("percentage", match.get("percentage")),
                        "audit_verified": True,
                        "audit_verified_source": "Current-year Audit Report",
                        "verification_status": "Verified / updated from current-year Audit Report",
                    })
                else:
                    audit_holder["register_source"] = "Current-year Audit Report"
                    audit_holder["audit_verified"] = True
                    audit_holder["audit_verified_source"] = "Current-year Audit Report"
                    audit_holder["verification_status"] = "Added from current-year Audit Report — review against Register of Members"
                    current.append(audit_holder)
            clean["shareholders"] = current
        if roc_extracted.get("_financials"):
            clean["financial_data"] = {**(company.get("financial_data") or {}), **roc_extracted["_financials"]}
            if roc_extracted["_financials"].get("turnover") is not None:
                clean["last_year_turnover"] = roc_extracted["_financials"]["turnover"]
        if roc_extracted.get("_auditor"):
            existing_auditor = dict(company.get("auditor") or {})
            existing_auditor.update({k: v for k, v in roc_extracted["_auditor"].items() if v})
            clean["auditor"] = existing_auditor
        if roc_extracted.get("_annual_return"):
            annual_return = {**(company.get("annual_return_data") or {}), **roc_extracted["_annual_return"]}
            clean["annual_return_data"] = annual_return
            if annual_return.get("turnover") is not None:
                clean["last_year_turnover"] = annual_return["turnover"]
            if annual_return.get("paid_up_capital") is not None and not _num(company.get("paid_up_capital")):
                clean["paid_up_capital"] = annual_return["paid_up_capital"]
        if roc_extracted.get("_audit_report"):
            clean["audit_report_data"] = {**(company.get("audit_report_data") or {}), **roc_extracted["_audit_report"]}
        if roc_extracted.get("_board_report"):
            clean["board_report_data"] = {**(company.get("board_report_data") or {}), **roc_extracted["_board_report"]}
        if roc_extracted.get("_adt1"):
            clean["adt1_data"] = {**(company.get("adt1_data") or {}), **roc_extracted["_adt1"]}
        if roc_extracted.get("_dpt3"):
            dpt3_data = dict(company.get("dpt3_data") or {})
            period_key = roc_extracted["_dpt3"].get("return_period") or "latest"
            existing_period = dict(dpt3_data.get(period_key) or {})
            existing_period.update({k: v for k, v in roc_extracted["_dpt3"].items() if v is not None})
            dpt3_data[period_key] = existing_period
            dpt3_data["latest_period"] = period_key
            clean["dpt3_data"] = dpt3_data
        clean["mgt_shareholder_data"] = {k: v for k, v in roc_extracted.items() if not k.startswith("_") and k not in ("directors", "shareholders", "financial_data", "auditor")}
        clean["roc_form_uploads"] = (company.get("roc_form_uploads") or []) + [
            {"filename": r["filename"], "form_type": r["source_type"],
             "filing_category": r.get("filing_category"), "document_fy": r.get("document_fy"),
             "uploaded_at": _now().isoformat()}
            for r in results
        ]
        clean["updated_at"] = _now()
        await COMPANIES.update_one({"id": company_id}, {"$set": clean})
        await _sync_company_to_client({**company, **clean})

    visible = {k: v for k, v in roc_extracted.items() if not k.startswith("_")}
    if roc_extracted.get("_directors"):
        visible["directors"] = roc_extracted["_directors"]
    if roc_extracted.get("_shareholders"):
        visible["shareholders"] = roc_extracted["_shareholders"]
    if roc_extracted.get("_financials"):
        visible["financial_data"] = roc_extracted["_financials"]
    if roc_extracted.get("_auditor"):
        visible["auditor"] = roc_extracted["_auditor"]
    if roc_extracted.get("_annual_return"):
        visible["annual_return_data"] = roc_extracted["_annual_return"]
    if roc_extracted.get("_audit_report"):
        visible["audit_report_data"] = roc_extracted["_audit_report"]
    if roc_extracted.get("_audit_shareholders"):
        visible["audit_shareholders"] = roc_extracted["_audit_shareholders"]
    if roc_extracted.get("_board_report"):
        visible["board_report_data"] = roc_extracted["_board_report"]
    if roc_extracted.get("_adt1"):
        visible["adt1_data"] = roc_extracted["_adt1"]
    if roc_extracted.get("_dpt3"):
        visible["dpt3_data"] = roc_extracted["_dpt3"]
    return {"extracted": visible, "results": results, "applied": bool(apply), "errors": errors,
            "warnings": warnings, "conflicts": conflicts}


# ─────────────────────────────────────────────────────────────────────────
# MASTER DATA IMPORTER — separate extraction path from Upload ROC Forms
# ─────────────────────────────────────────────────────────────────────────
# Reads the MCA "View Company/LLP Master Data" export (the printable PDF
# from the MCA portal's Master Data service, or an MCA master-data
# XLSX/CSV). Own text-reading strategy (PDF text-flow order, since the
# Master Data PDF is a two-column label/value layout that default PDF text
# extraction jumbles), own label dictionary, own field mapper. Deliberately
# does not share the ROC-form parsers/upload_master_data() above — a change
# to ROC filing parsing must never silently change Master Data parsing.
#
# Behaviour mirrors "Smart Import" on the Clients page: upload → fields are
# fetched and applied to the Company Master automatically, no manual
# per-field Apply step.

MASTER_DATA_ALLOWED_EXT = (".pdf", ".xlsx", ".xls", ".csv")

# (internal field name, label phrases as they appear on the MCA export)
MASTER_DATA_LABELS: List[tuple] = [
    ("cin", ("cin", "llpin")),
    ("company_name", ("company name", "name of the company", "llp name")),
    ("roc_name", ("roc name",)),
    ("registration_number", ("registration number",)),
    ("date_of_incorporation", ("date of incorporation",)),
    ("email", ("email id", "email")),
    ("registered_office_address", ("registered address", "registered office address")),
    ("listed", ("listed in stock exchange",)),
    ("company_category_raw", ("category of company",)),
    ("company_subcategory_raw", ("subcategory of the company",)),
    ("class_of_company_raw", ("class of company",)),
    ("active_compliance_raw", ("active compliance",)),
    ("authorized_capital", ("authorised capital", "authorized capital")),
    ("paid_up_capital", ("paid up capital", "paid-up capital")),
    ("last_agm_date", ("date of last agm",)),
    ("date_of_balance_sheet", ("date of balance sheet",)),
    ("company_status", ("company status",)),
    ("roc_office", ("roc (name and office)", "roc name and office")),
    ("rd_region", ("rd (name and region)", "rd name and region")),
    ("pan", ("pan", "permanent account number")),
    # stop-only markers — never stored, just tell the collector where a
    # multi-line value (e.g. the wrapped registered address) ends
    ("_stop_books_address", ("address at which the books of account",)),
    ("_stop_index_of_charges", ("index of charges",)),
    ("_stop_jurisdiction", ("jurisdiction",)),
    ("_stop_director_block", ("director/signatory details", "director / signatory details")),
]


def _match_master_label(line_lower: str):
    for field, phrases in MASTER_DATA_LABELS:
        for p in phrases:
            if line_lower == p or line_lower.startswith(p + " ") or line_lower.startswith(p + ":"):
                return field, p
    return None, None


def _read_master_data_text(filename: str, raw: bytes) -> str:
    """Own file→text reader for Master Data uploads. PDFs use text-flow
    ordering (reading order by position rather than raw stream order) so
    the label/value pairs on the MCA export don't get scrambled — the
    default extraction used for ROC forms gets this layout wrong."""
    name = (filename or "").lower()
    try:
        if name.endswith(".pdf"):
            import pdfplumber
            parts = []
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                for page in pdf.pages[:8]:
                    t = None
                    try:
                        t = page.extract_text(use_text_flow=True)
                    except Exception:
                        t = None
                    parts.append(t or page.extract_text() or "")
            return "\n".join(parts)
        if name.endswith((".xlsx", ".xls")):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
                    if cells:
                        lines.append(" ".join(cells))
            return "\n".join(lines)
        if name.endswith(".csv"):
            return raw.decode("utf-8-sig", errors="ignore")
        return raw.decode("utf-8", errors="ignore")
    except Exception as e:  # pragma: no cover
        logger.warning("roc_sphere master-data: text extraction failed for %s: %s", filename, e)
        return ""


def _parse_master_director_tables(raw: bytes) -> List[Dict[str, Any]]:
    """Read the Director/Signatory table straight from the PDF's table
    grid (bordered on the MCA Master Data export) rather than scanning
    text lines — far more reliable than regex here since the table's
    column count varies (older exports omit the 'Category' column) but
    the last three columns are always Date of Appointment / Cessation
    Date / Signatory, letting position alone locate every field."""
    directors: List[Dict[str, Any]] = []
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    if not table or len(table) < 2:
                        continue
                    header_line = " ".join(str(c or "") for c in table[0]).lower()
                    if "din" not in header_line:
                        continue
                    for row in table[1:]:
                        if not row or len(row) < 4 or not any(row):
                            continue
                        name = str(row[2] or "").replace("\n", " ").strip()
                        din = str(row[1] or "").replace("\n", " ").strip()
                        if not name or not din or not re.search(r"[A-Za-z]", name) or not re.search(r"\d", din):
                            continue
                        appt_i, cess_i = len(row) - 3, len(row) - 2
                        directors.append({
                            "name": re.sub(r"\s+", " ", name),
                            "din": din,
                            "designation": (str(row[3] or "").replace("\n", " ").strip() or "Director"),
                            "date_of_appointment": str(row[appt_i] or "").strip() or None if appt_i > 0 else None,
                            "date_of_cessation": (str(row[cess_i] or "").strip() or None) if 0 <= cess_i < len(row) and str(row[cess_i] or "").strip() not in ("", "-") else None,
                        })
    except Exception as e:  # pragma: no cover
        logger.warning("roc_sphere master-data: director table extraction failed: %s", e)
    return directors


def _map_master_category(class_of_company_raw: Optional[str], category_raw: Optional[str], is_llp_hint: bool) -> Optional[str]:
    if is_llp_hint:
        return "llp"
    c = (class_of_company_raw or "").strip().lower()
    cat = (category_raw or "").strip().lower()
    if "one person" in cat:
        return "opc"
    if "section 8" in cat or "section-8" in cat or "u/s 8" in cat:
        return "section_8"
    if "public" in c:
        return "public"
    if "private" in c:
        return "private"
    return None


def extract_mca_master_data(filename: str, raw: bytes) -> Dict[str, Any]:
    """Parse an MCA Master Data export (PDF/XLSX/CSV) into Company Master
    fields. Separate parser/algorithm from the ROC-form parsers above —
    walks the document as an ordered label→value sequence (handling both
    same-line values like 'CIN U80900GJ...' and MCA's multi-line wrapped
    values like the registered address) rather than regex-scanning the
    whole blob."""
    text = _read_master_data_text(filename, raw)
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    lines = [x for x in lines if x]

    extracted: Dict[str, Any] = {}
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        low = line.lower().rstrip(":")
        field, phrase = _match_master_label(low)
        if not field:
            i += 1
            continue
        if field.startswith("_stop_"):
            i += 1
            continue
        remainder = line[len(phrase):].strip(" :\t-")
        if remainder:
            value_parts, j = [remainder], i + 1
        else:
            value_parts, j = [], i + 1
            while j < n:
                nxt_field, _ = _match_master_label(lines[j].lower().rstrip(":"))
                if nxt_field:
                    break
                value_parts.append(lines[j])
                j += 1
        value = " ".join(p for p in value_parts if p).strip(" ,")
        if value and value not in ("-", "—", "NA", "N/A") and field not in extracted:
            extracted[field] = value
        i = j if j > i else i + 1

    for f in ("authorized_capital", "paid_up_capital"):
        if f in extracted:
            digits = re.sub(r"[^\d.]", "", str(extracted[f]))
            extracted[f] = _num(digits) if digits else 0.0

    if "listed" in extracted:
        extracted["listed"] = str(extracted["listed"]).strip().lower().startswith("y")

    is_llp_hint = bool(re.search(r"\bLLPIN\b", text, re.I))
    mapped_category = _map_master_category(
        extracted.pop("class_of_company_raw", None), extracted.get("company_category_raw"), is_llp_hint)
    if mapped_category:
        extracted["category"] = mapped_category

    # Table-grid extraction (PDF only) is far more reliable than the
    # regex line-scan, so prefer it and only fall back for XLSX/CSV or a
    # PDF whose director table has no visible borders.
    people = _parse_master_director_tables(raw) if (filename or "").lower().endswith(".pdf") else []
    if not people:
        people = _parse_people(text)["people"]
    if people:
        extracted["_directors"] = people

    extracted["_source_type"] = "master-data"
    extracted["_source_file"] = filename
    extracted["_chars_scanned"] = len(text)
    return extracted


@router.post("/companies/{company_id}/master-data/fetch")
async def fetch_master_data(
    company_id: str,
    files: List[UploadFile] = File(...),
    current_user: User = Depends(CREATE),
):
    """Master Data tab — upload the MCA 'View Company/LLP Master Data' PDF
    (or an MCA master-data XLSX/CSV) and the Company Master + Director/
    Signatory register are fetched and applied automatically, the same way
    Smart Import on the Clients page auto-fills a client from an uploaded
    document. Always applies (no manual per-field Apply step); returns
    exactly which fields changed so the UI can summarise it."""
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if not files:
        raise HTTPException(400, "Choose at least one Master Data file")

    merged: Dict[str, Any] = {}
    directors: List[Dict[str, Any]] = []
    results, errors = [], []
    total_size = 0

    for uploaded in files:
        filename = uploaded.filename or "master-data-file"
        if not filename.lower().endswith(MASTER_DATA_ALLOWED_EXT):
            errors.append(f"{filename}: unsupported file type — use PDF, XLSX or CSV")
            continue
        raw = await uploaded.read()
        total_size += len(raw)
        if total_size > 25 * 1024 * 1024:
            errors.append(f"{filename}: skipped — combined upload exceeds the 25MB limit")
            continue
        if not raw:
            errors.append(f"{filename}: skipped — empty file")
            continue
        try:
            extracted = extract_mca_master_data(filename, raw)
        except Exception as e:
            logger.warning("roc_sphere master-data: failed to parse %s: %s", filename, e)
            errors.append(f"{filename}: could not be read — file may be corrupted or password-protected")
            continue

        fields = {k: v for k, v in extracted.items() if not k.startswith("_")}
        results.append({"filename": filename, "fields_found": len(fields)})
        for k, v in fields.items():
            if v not in (None, "", 0):
                merged[k] = v
        for d in extracted.get("_directors") or []:
            if not any((existing.get("din") or "").upper() == (d.get("din") or "").upper() and d.get("din") for existing in directors):
                directors.append(d)

    if not merged and not directors:
        return {
            "applied": False,
            "fields_applied": [],
            "results": results,
            "errors": errors or ["Could not confidently extract Master Data fields from this file — please check it's the MCA Master Data export, or enter details manually."],
        }

    clean: Dict[str, Any] = {}
    for f in ("cin", "company_name", "registered_office_address", "date_of_incorporation",
              "authorized_capital", "paid_up_capital", "last_agm_date", "pan", "category", "listed"):
        if merged.get(f) not in (None, ""):
            clean[f] = merged[f]

    effective_category = clean.get("category") or company.get("category")
    if directors:
        if effective_category == "llp":
            clean["designated_partners"] = directors
            clean["partners"] = directors
        else:
            clean["directors"] = directors

    existing_master = dict(company.get("master_data") or {})
    existing_master.update({k: v for k, v in {
        "roc_name": merged.get("roc_name"),
        "registration_number": merged.get("registration_number"),
        "email": merged.get("email"),
        "company_status": merged.get("company_status"),
        "roc_office": merged.get("roc_office"),
        "rd_region": merged.get("rd_region"),
        "date_of_balance_sheet": merged.get("date_of_balance_sheet"),
        "active_compliance": merged.get("active_compliance_raw"),
        "company_subcategory": merged.get("company_subcategory_raw"),
    }.items() if v not in (None, "")})
    existing_master["last_fetched_at"] = _now().isoformat()
    existing_master["last_fetched_by"] = _who(current_user)
    existing_master["source_files"] = [r["filename"] for r in results]
    clean["master_data"] = existing_master

    clean["roc_form_uploads"] = (company.get("roc_form_uploads") or []) + [
        {"filename": r["filename"], "form_type": "master-data", "uploaded_at": _now().isoformat()}
        for r in results
    ]
    clean["updated_at"] = _now()

    await COMPANIES.update_one({"id": company_id}, {"$set": clean})
    await _sync_company_to_client({**company, **clean})
    updated = await COMPANIES.find_one({"id": company_id})
    updated.pop("_id", None)

    return {
        "applied": True,
        "fields_applied": sorted(k for k in clean.keys() if k not in ("master_data", "roc_form_uploads", "updated_at")),
        "company": updated,
        "results": results,
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
# STATUTORY REGISTERS — share transfers, certificates and SH-4
# ─────────────────────────────────────────────────────────────────────────

def _same_holder(left: Dict[str, Any], name: str, folio: Optional[str]) -> bool:
    if folio and str(left.get("folio_no") or "").strip().lower() == str(folio).strip().lower():
        return True
    return bool(name) and str(left.get("name") or "").strip().lower() == name.strip().lower()


def _apply_transfer_to_register(
    shareholders: List[Dict[str, Any]], transfer: Dict[str, Any]
) -> Dict[str, Any]:
    """Apply a reviewed transfer to the in-app register of members.

    This intentionally reports what could not be matched instead of silently
    inventing a transferor holding. A CS can correct the register and rerun
    the record with `update_register` disabled when the legal instrument is
    still under review.
    """
    quantity = _num(transfer.get("number_of_shares"))
    if quantity <= 0:
        return {"updated": False, "reason": "Number of shares must be greater than zero"}
    transferor = next(
        (s for s in shareholders if _same_holder(s, transfer.get("transferor_name", ""), transfer.get("transferor_folio_no"))),
        None,
    )
    transferee = next(
        (s for s in shareholders if _same_holder(s, transfer.get("transferee_name", ""), transfer.get("transferee_folio_no"))),
        None,
    )
    if not transferor:
        return {"updated": False, "reason": "Transferor was not found in the current shareholder register"}
    if _num(transferor.get("shares_held")) < quantity:
        return {"updated": False, "reason": "Transferor holding is lower than the transfer quantity"}

    transferor["shares_held"] = _num(transferor.get("shares_held")) - quantity
    if transferee:
        transferee["shares_held"] = _num(transferee.get("shares_held")) + quantity
    else:
        shareholders.append({
            "name": transfer.get("transferee_name"),
            "folio_no": transfer.get("transferee_folio_no"),
            "class_of_shares": transfer.get("class_of_shares") or "Equity",
            "shares_held": quantity,
            "face_value": _num(transfer.get("nominal_value_per_share")) or 10,
            "percentage": None,
        })

    total = sum(_num(s.get("shares_held")) for s in shareholders)
    if total:
        for shareholder in shareholders:
            shareholder["percentage"] = round(_num(shareholder.get("shares_held")) / total * 100, 2)
    return {
        "updated": True,
        "transferor_remaining": transferor["shares_held"],
        "transferee_new_holding": next(
            (_num(s.get("shares_held")) for s in shareholders if _same_holder(
                s, transfer.get("transferee_name", ""), transfer.get("transferee_folio_no")
            )),
            quantity,
        ),
    }


@router.get("/companies/{company_id}/statutory-records")
async def get_statutory_records(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    shareholders = company.get("shareholders") or []
    return {
        "company_name": company.get("company_name"),
        "cin": company.get("cin"),
        "shareholders": shareholders,
        "financial_data": company.get("financial_data") or {},
        "annual_return_data": company.get("annual_return_data") or {},
        "audit_report_data": company.get("audit_report_data") or {},
        "board_report_data": company.get("board_report_data") or {},
        "share_transfers": company.get("share_transfers") or [],
        "share_certificates": company.get("share_certificates") or [],
        "register_status": {
            "members": bool(shareholders),
            "share_transfer_register": bool(company.get("share_transfers")),
            "share_certificates": bool(company.get("share_certificates")),
        },
        "disclaimer": "Generated records are working drafts. Verify the executed instrument, stamp duty, board approvals, folio balances and applicable MCA requirements before signing or filing.",
    }


def _is_first_roc_annual_filing(company: Dict[str, Any]) -> bool:
    uploads = company.get("roc_form_uploads") or []
    annual_types = {"aoc-4", "aoc4", "mgt-7", "mgt-7a"}
    has_prior_annual = any(
        str(item.get("form_type") or "").strip().lower() in annual_types
        for item in uploads
    )
    has_prior_annual_data = bool(company.get("annual_return_data")) or bool(company.get("financial_data"))
    return not has_prior_annual and not has_prior_annual_data


@router.get("/companies/{company_id}/filing-preparation")
async def get_filing_preparation(company_id: str, current_user: User = Depends(VIEW)):
    """Return source-separated working data for the next AOC-4/MGT-7A cycle."""
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    aoc4 = company.get("financial_data") or {}
    mgt7a = company.get("annual_return_data") or {}
    record_history = list(company.get("record_history") or [])
    history_summary = _record_history_summary(company)
    first_roc_filing = _is_first_roc_annual_filing(company)
    required = {
        "company_name": company.get("company_name"),
        "cin": company.get("cin"),
        "registered_office_address": company.get("registered_office_address"),
        "period_to": aoc4.get("period_to"),
        "turnover": mgt7a.get("turnover") or aoc4.get("turnover") or company.get("last_year_turnover"),
        "net_worth": mgt7a.get("net_worth") or aoc4.get("net_worth"),
        "auditor": (company.get("auditor") or {}).get("name"),
        "directors": company.get("directors") or [],
        "shareholders": company.get("shareholders") or [],
    }
    missing = [key for key, value in required.items() if value in (None, "", [])]
    return {
        "company_id": company_id,
        "aoc4": aoc4,
        "mgt7a": mgt7a,
        "audit_report": company.get("audit_report_data") or {},
        "board_report": company.get("board_report_data") or {},
        "record_history": record_history,
        "record_history_summary": history_summary,
        "mgt7_meeting_data": {
            "agm": history_summary.get("latest_agm"),
            "board_meetings": [r for r in record_history if str(r.get("meeting_type", "")).lower() == "board"],
            "egms": [r for r in record_history if str(r.get("meeting_type", "")).lower() == "egm"],
        },
        "required_working_fields": required,
        "missing_working_fields": missing,
        "first_roc_annual_filing": first_roc_filing,
        "document_requirements": {
            "previous_year_annual_filing": not first_roc_filing,
            "current_year_audit_report": True,
            "reason": (
                "No prior AOC-4/MGT-7/MGT-7A annual filing data is recorded in ROC Sphere; "
                "treat this as the first ROC annual filing workflow. Do not ask for previous-year annual filing documents."
                if first_roc_filing else
                "Prior annual filing data exists; previous-year documents may be used for year-on-year reconciliation."
            ),
        },
        "source_rules": {
            "financials_and_auditor": "AOC-4",
            "directors_and_shareholders": "MGT-7 / MGT-7A and its shareholder attachment",
            "disclosure_context": "Auditor's Report and Board's Report",
        },
    }


# ─────────────────────────────────────────────────────────────────────────
# RECORD HISTORY — persistent Board / AGM / EGM / meeting register
# ─────────────────────────────────────────────────────────────────────────

def _record_history_summary(company: Dict[str, Any]) -> Dict[str, Any]:
    records = list(company.get("record_history") or [])
    def key(r):
        try:
            return datetime.fromisoformat(str(r.get("meeting_date", "")).replace("Z", "+00:00"))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)
    ordered = sorted(records, key=key, reverse=True)
    agms = [r for r in ordered if str(r.get("meeting_type", "")).lower() == "agm"]
    boards = [r for r in ordered if str(r.get("meeting_type", "")).lower() == "board"]
    egms = [r for r in ordered if str(r.get("meeting_type", "")).lower() == "egm"]
    return {
        "total": len(records),
        "board_meetings": len(boards),
        "general_meetings": len(agms) + len(egms),
        "agms": len(agms),
        "egms": len(egms),
        "latest_board_meeting": boards[0] if boards else None,
        "latest_agm": agms[0] if agms else None,
        "latest_egm": egms[0] if egms else None,
    }


@router.get("/companies/{company_id}/record-history")
async def get_record_history(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    records = list(company.get("record_history") or [])
    # Reconcile documents generated before the persistent meeting-register
    # feature was introduced. This makes existing Board/AGM/EGM documents
    # immediately visible without requiring users to regenerate them.
    generated_docs = await DOCS_LOG.find({"company_id": company_id}).to_list(5000)
    for doc in generated_docs:
        doc_type = str(doc.get("doc_type") or "")
        if not (doc_type == "board_resolution" or doc_type.startswith("general_resolution_") or doc_type.startswith("notice_") or doc_type.startswith("minutes_")):
            continue
        filename = str(doc.get("filename") or "")
        date_match = re.search(r"(\d{4}-\d{2}-\d{2})", filename)
        meeting_date = date_match.group(1) if date_match else None
        if not meeting_date:
            continue
        meeting_type = "board" if doc_type == "board_resolution" else doc_type.split("_", 1)[1]
        match = next((r for r in records if r.get("meeting_type") == meeting_type and str(r.get("meeting_date") or "")[:10] == meeting_date), None)
        if match is None:
            match = {
                "id": _uid(), "meeting_type": meeting_type, "meeting_number": None,
                "meeting_date": meeting_date, "meeting_time": None, "notice_date": None,
                "venue": company.get("registered_office_address"), "mode": None, "chairman": None,
                "quorum_present": True, "attendance": [], "members_present_count": None,
                "members_entitled_count": None, "leave_of_absence": [], "agenda_items": [],
                "resolutions_passed": [], "resolution_items": [], "occasion": None, "special_business": [], "minutes_date": meeting_date if doc_type.startswith("minutes_") else None,
                "minutes_signed_date": None, "adjourned": False, "adjourned_to": None,
                "auditor_attended": None, "secretarial_notes": "Recovered from previously generated ROC document.",
                "attachments": [], "status": "Generated", "remarks": "", "created_at": _now().isoformat(),
                "created_by": doc.get("generated_by"), "updated_at": _now().isoformat(),
            }
            records.append(match)
        generated = list(match.get("generated_documents") or [])
        if not any(x.get("id") == doc.get("id") for x in generated):
            generated.append({
                "id": doc.get("id"), "doc_type": doc_type, "filename": doc.get("filename"),
                "generated_at": doc.get("generated_at").isoformat() if hasattr(doc.get("generated_at"), "isoformat") else str(doc.get("generated_at")),
                "generated_by": doc.get("generated_by"),
            })
            match["generated_documents"] = generated
    for record in records:
        if not record.get("occasion"):
            items = record.get("resolution_items") or []
            if items and items[0].get("particulars"):
                record["occasion"] = items[0].get("particulars")
            elif record.get("resolutions_passed"):
                record["occasion"] = "Resolution / Business recorded in meeting"
            elif record.get("agenda_items"):
                record["occasion"] = record["agenda_items"][0]
        if not record.get("resolution_items") and record.get("resolutions_passed"):
            record["resolution_items"] = [
                {"particulars": record.get("occasion") or f"Resolution {i + 1}", "resolution_text": value, "proposed_by": None, "seconded_by": None}
                for i, value in enumerate(record.get("resolutions_passed") or [])
            ]

    records.sort(key=lambda r: str(r.get("meeting_date") or ""), reverse=True)
    return {"company_id": company_id, "records": records, "summary": _record_history_summary({**company, "record_history": records})}


@router.post("/companies/{company_id}/record-history")
async def create_record_history(company_id: str, payload: RecordHistoryEntry, current_user: User = Depends(EDIT)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    record = payload.model_dump()
    record.update({"id": _uid(), "created_at": _now().isoformat(), "created_by": _who(current_user), "updated_at": _now().isoformat()})
    records = list(company.get("record_history") or [])
    records.append(record)
    clean = {"record_history": records, "updated_at": _now()}
    # Keep the master date fields synchronized for older filing/document flows.
    if record.get("meeting_type") == "agm":
        clean["last_agm_date"] = record.get("meeting_date")
    if record.get("meeting_type") == "board":
        clean["last_board_meeting_date"] = record.get("meeting_date")
    await COMPANIES.update_one({"id": company_id}, {"$set": clean})
    await _sync_company_to_client({**company, **clean})
    return {"record": record, "summary": _record_history_summary({**company, **clean})}


@router.put("/companies/{company_id}/record-history/{record_id}")
async def update_record_history(company_id: str, record_id: str, payload: RecordHistoryEntry, current_user: User = Depends(EDIT)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    records = list(company.get("record_history") or [])
    idx = next((i for i, r in enumerate(records) if r.get("id") == record_id), -1)
    if idx < 0:
        raise HTTPException(404, "Record history entry not found")
    updated = payload.model_dump()
    updated.update({"id": record_id, "created_at": records[idx].get("created_at") or _now().isoformat(), "created_by": records[idx].get("created_by") or _who(current_user), "updated_at": _now().isoformat(), "updated_by": _who(current_user)})
    records[idx] = updated
    clean = {"record_history": records, "updated_at": _now()}
    # Recalculate latest master dates from the complete history.
    ordered = sorted(records, key=lambda r: str(r.get("meeting_date") or ""), reverse=True)
    latest_agm = next((r for r in ordered if r.get("meeting_type") == "agm"), None)
    latest_board = next((r for r in ordered if r.get("meeting_type") == "board"), None)
    clean["last_agm_date"] = latest_agm.get("meeting_date") if latest_agm else None
    clean["last_board_meeting_date"] = latest_board.get("meeting_date") if latest_board else None
    await COMPANIES.update_one({"id": company_id}, {"$set": clean})
    await _sync_company_to_client({**company, **clean})
    return {"record": updated, "summary": _record_history_summary({**company, **clean})}


@router.delete("/companies/{company_id}/record-history/{record_id}")
async def delete_record_history(company_id: str, record_id: str, current_user: User = Depends(DELETE)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    records = [r for r in (company.get("record_history") or []) if r.get("id") != record_id]
    if len(records) == len(company.get("record_history") or []):
        raise HTTPException(404, "Record history entry not found")
    ordered = sorted(records, key=lambda r: str(r.get("meeting_date") or ""), reverse=True)
    latest_agm = next((r for r in ordered if r.get("meeting_type") == "agm"), None)
    latest_board = next((r for r in ordered if r.get("meeting_type") == "board"), None)
    clean = {"record_history": records, "updated_at": _now(), "last_agm_date": latest_agm.get("meeting_date") if latest_agm else None, "last_board_meeting_date": latest_board.get("meeting_date") if latest_board else None}
    await COMPANIES.update_one({"id": company_id}, {"$set": clean})
    await _sync_company_to_client({**company, **clean})
    return {"deleted": record_id, "summary": _record_history_summary({**company, **clean})}


@router.post("/companies/{company_id}/share-transfers")
async def create_share_transfer(
    company_id: str,
    payload: ShareTransferRequest,
    current_user: User = Depends(CREATE),
):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if _num(payload.number_of_shares) <= 0:
        raise HTTPException(422, "Number of shares must be greater than zero")
    transfer = payload.model_dump()
    transfer.update({"id": _uid(), "created_at": _now().isoformat(), "created_by": _who(current_user)})
    shareholders = [dict(s) for s in (company.get("shareholders") or [])]
    register_update = {"updated": False, "reason": "Register update was not requested"}
    if payload.update_register:
        register_update = _apply_transfer_to_register(shareholders, transfer)
        if not register_update["updated"]:
            raise HTTPException(422, register_update["reason"])
    transfers = list(company.get("share_transfers") or [])
    transfers.append(transfer)
    clean = {"share_transfers": transfers, "updated_at": _now()}
    if payload.update_register:
        clean["shareholders"] = shareholders
    await COMPANIES.update_one({"id": company_id}, {"$set": clean})
    await _sync_company_to_client({**company, **clean})
    return {"transfer": transfer, "register_update": register_update, "shareholders": shareholders}


@router.post("/companies/{company_id}/share-certificates")
async def create_share_certificate(
    company_id: str,
    payload: ShareCertificateRequest,
    current_user: User = Depends(CREATE),
):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    certificate = payload.model_dump()
    certificate.update({"id": _uid(), "created_at": _now().isoformat(), "created_by": _who(current_user)})
    certificates = list(company.get("share_certificates") or [])
    certificates.append(certificate)
    await COMPANIES.update_one(
        {"id": company_id},
        {"$set": {"share_certificates": certificates, "updated_at": _now()}},
    )
    return {"certificate": certificate}


# ─────────────────────────────────────────────────────────────────────────
# COMPLIANCE CHECKLIST ENGINE
# ─────────────────────────────────────────────────────────────────────────
# Heuristic, config-driven so it's easy to keep current. Review
# thresholds against the latest MCA notifications periodically —
# "small company" limits were last revised (paid-up ≤ Rs 10 cr, turnover
# ≤ Rs 100 cr) with effect from 1 Dec 2025.

SMALL_CO_PAID_UP_LIMIT = 10_00_00_000     # Rs 10 crore
SMALL_CO_TURNOVER_LIMIT = 100_00_00_000   # Rs 100 crore


def _is_llp(company: Dict[str, Any]) -> bool:
    return company.get("category") == "llp"


def _is_small_company(company: Dict[str, Any]) -> bool:
    # "Small company" is a Companies Act, 2013 concept only — never applies to an LLP.
    if _is_llp(company):
        return False
    if company.get("is_small_company") is not None:
        return bool(company["is_small_company"])
    if company.get("category") in ("public", "section_8"):
        return False
    paid_up = _num(company.get("paid_up_capital"))
    turnover = _num(company.get("last_year_turnover"))
    return paid_up <= SMALL_CO_PAID_UP_LIMIT and turnover <= SMALL_CO_TURNOVER_LIMIT


# LLP Act, 2008 / LLP Rules audit-applicability thresholds
LLP_AUDIT_TURNOVER_LIMIT = 40_00_000       # Rs. 40 lakh turnover
LLP_AUDIT_CONTRIBUTION_LIMIT = 25_00_000   # Rs. 25 lakh partners' contribution


def build_llp_compliance_checklist(company: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Compliance checklist under the LLP Act, 2008 / LLP Rules — entirely
    separate from the Companies Act, 2013 checklist below, since an LLP has
    no share capital, no Board/AGM in the company-law sense, no AOC-4/MGT-7/
    ADT-1/CSR/MGT-14/PAS-6, etc. Keyed off Designated Partners, not Directors."""
    items: List[Dict[str, Any]] = []
    num_dp = len(company.get("directors") or [])  # "directors" list doubles as Designated Partners for LLP records
    turnover = _num(company.get("last_year_turnover"))
    contribution = _num(company.get("paid_up_capital"))  # "paid_up_capital" field doubles as total partners' contribution
    audit_applicable = turnover > LLP_AUDIT_TURNOVER_LIMIT or contribution > LLP_AUDIT_CONTRIBUTION_LIMIT

    def add(form, particulars, due, frequency, applicable=True, notes=None):
        items.append({
            "form": form, "particulars": particulars, "due_date_rule": due,
            "frequency": frequency, "applicable": applicable, "notes": notes,
        })

    add("Form 11", "Annual Return of the LLP", "Within 60 days of FY close (by 30th May)", "Annual")
    add("Form 8", "Statement of Account & Solvency (incl. Statement of Solvency by Designated Partners)",
        "Within 30 days from end of 6 months of FY close (by 30th October)", "Annual")
    add("Statutory Audit", "Audit of accounts by a Chartered Accountant",
        "Before filing Form 8", "Annual",
        applicable=audit_applicable,
        notes=f"Mandatory only if turnover > ₹{LLP_AUDIT_TURNOVER_LIMIT:,} or partners' contribution > ₹{LLP_AUDIT_CONTRIBUTION_LIMIT:,}; otherwise a self-declaration of solvency suffices.")
    add("DIR-3 KYC", "KYC of every Designated Partner holding a DIN/DPIN", "By 30th September every year", "Annual", applicable=num_dp > 0)
    add("Form 3", "Filing of LLP Agreement / any changes to the LLP Agreement", "Within 30 days of execution/change", "Event-based")
    add("Form 4", "Notice of appointment/cessation/change of a partner or Designated Partner, or change of name/address of a partner",
        "Within 30 days of the event", "Event-based")
    add("Form 15", "Notice of change of registered office of the LLP", "Within 30 days of the change", "Event-based")
    add("Income Tax Return", "Filing of the LLP's income tax return",
        "31st July (no audit) / 31st October (audit applicable)", "Annual",
        notes="Due date shifts to 31st Oct if the LLP is subject to tax audit / transfer-pricing audit.")
    add("GST Returns", "GSTR-1 / GSTR-3B (and annual return GSTR-9) if GST-registered", "Monthly/Quarterly + Annual", "Periodic",
        applicable=bool(company.get("gst_registered", True)),
        notes="Applicable only if the LLP holds a GST registration — verify against the client's actual GSTIN status.")
    add("Meeting of Designated Partners", "Periodic meeting of Designated Partners as required by the LLP Agreement",
        "As per the LLP Agreement (no statutory AGM/Board Meeting requirement under the LLP Act)", "As per LLP Agreement")
    add("Register of Partners / Designated Partners", "Internal registers to be maintained & kept updated", "Ongoing", "Ongoing")

    return items


def build_compliance_checklist(company: Dict[str, Any]) -> List[Dict[str, Any]]:
    category = company.get("category", "private")
    if category == "llp":
        return build_llp_compliance_checklist(company)
    is_opc = category == "opc"
    is_small = _is_small_company(company)
    is_section8 = category == "section_8"
    num_directors = len(company.get("directors") or [])

    items: List[Dict[str, Any]] = []

    def add(form, particulars, due, frequency, applicable=True, notes=None):
        items.append({
            "form": form,
            "particulars": particulars,
            "due_date_rule": due,
            "frequency": frequency,
            "applicable": applicable,
            "notes": notes,
        })

    # Annual filings
    add("AOC-4" + (" (XBRL)" if company.get("listed") else ""), "Filing of Financial Statements", "Within 30 days of AGM", "Annual")
    add("MGT-7A" if is_small or is_opc else "MGT-7", "Annual Return", "Within 60 days of AGM", "Annual")
    add("ADT-1", "Appointment/Ratification of Statutory Auditor", "Within 15 days of AGM (on appointment)", "As applicable")
    add("DIR-3 KYC", "KYC of every Director holding a DIN", "By 30th September every year", "Annual", applicable=num_directors > 0)
    add("DPT-3", "Return of Deposits / particulars of transactions not treated as deposits", "By 30th June every year", "Annual")
    add("MSME-1", "Half-yearly return of outstanding dues to Micro & Small Enterprises", "29th April & 31st October", "Half-Yearly")

    # Meetings
    if not is_opc:
        add("AGM", "Annual General Meeting", "Within 6 months of FY end (9 months for first AGM); gap between two AGMs ≤ 15 months", "Annual", applicable=not is_opc)
    board_meetings_required = 2 if (is_small or is_opc) else 4
    add("Board Meeting", f"Minimum {board_meetings_required} Board Meetings in a calendar year, gap ≤ 120 days between two meetings",
        "Ongoing", "Quarterly" if board_meetings_required == 4 else "Half-Yearly")

    # Registers / compliance
    add("MBP-1", "Director's disclosure of interest in other entities", "First Board Meeting of the FY / on change", "Annual + event-based")
    add("DIR-8", "Director's declaration of non-disqualification", "First Board Meeting of the FY", "Annual")
    add("Register of Members / Charges / Directors", "Statutory registers to be maintained & kept updated", "Ongoing", "Ongoing")
    add("CSR-2", "Report on CSR", "As notified (with AOC-4 or separately)", "Annual",
        applicable=_num(company.get("paid_up_capital")) >= 5_00_00_000 or _num(company.get("last_year_turnover")) >= 100_00_00_000,
        notes="Applicable only if CSR provisions (Sec 135) trigger — verify against latest profit criterion too.")

    if is_section8:
        add("CSR-1", "Registration for undertaking CSR activities (if applicable)", "Before undertaking CSR work", "One-time", notes="Section 8 company specific")

    if company.get("category") == "public" or company.get("listed"):
        add("MGT-14", "Filing of certain Board/Special resolutions with ROC", "Within 30 days of passing", "Event-based")

    add("PAS-6", "Reconciliation of Share Capital Audit Report (unlisted companies with dematerialised shares)", "Within 60 days of half-year end", "Half-Yearly", applicable=not is_opc and not is_section8)

    return items


@router.get("/companies/{company_id}/compliance-checklist")
async def get_compliance_checklist(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    checklist = build_compliance_checklist(company)
    is_llp = _is_llp(company)
    return {
        "company_name": company.get("company_name"),
        "category": company.get("category"),
        "is_small_company": None if is_llp else _is_small_company(company),
        "checklist": checklist,
        "generated_at": _now().isoformat(),
        "disclaimer": (
            "Generated from the LLP's category/turnover/contribution using current "
            "LLP Act, 2008 / LLP Rules thresholds as configured in the app. Verify "
            "against the latest MCA notifications before relying on it for filing."
            if is_llp else
            "Generated from company category/capital/turnover using current "
            "Companies Act 2013 thresholds as configured in the app. Verify "
            "against the latest MCA notifications before relying on it for filing."
        ),
    }


FREQUENCY_GROUP_ORDER = [
    "Annual", "Half-Yearly", "Quarterly", "Periodic", "Event-based",
    "As applicable", "Ongoing", "As per LLP Agreement",
]


@router.get("/companies/{company_id}/applicable-compliances")
async def get_applicable_compliances(company_id: str, current_user: User = Depends(VIEW)):
    """Full list of ROC compliances currently applicable to this company —
    a dashboard view driven by the *same* checklist engine as the
    Compliance Checklist tab, but only the items that apply, grouped by
    frequency. Because Upload ROC Forms and the Master Data importer both
    write straight into the Company Master fields this reads (capital,
    turnover, director/partner count, category), applicability here always
    reflects the latest uploaded data with no separate wiring needed."""
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    checklist = build_compliance_checklist(company)
    applicable = [item for item in checklist if item.get("applicable")]

    groups: Dict[str, List[Dict[str, Any]]] = {}
    for item in applicable:
        groups.setdefault(item.get("frequency") or "Other", []).append(item)
    ordered_groups = [{"frequency": g, "items": groups[g]} for g in FREQUENCY_GROUP_ORDER if g in groups]
    ordered_groups += [{"frequency": g, "items": items} for g, items in groups.items() if g not in FREQUENCY_GROUP_ORDER]

    is_llp = _is_llp(company)
    master_data = company.get("master_data") or {}
    return {
        "company_name": company.get("company_name"),
        "category": company.get("category"),
        "cin": company.get("cin"),
        "is_small_company": None if is_llp else _is_small_company(company),
        "total_forms_tracked": len(checklist),
        "total_applicable": len(applicable),
        "not_applicable": len(checklist) - len(applicable),
        "groups": ordered_groups,
        "master_data_last_fetched": master_data.get("last_fetched_at"),
        "roc_forms_uploaded": len(company.get("roc_form_uploads") or []),
        "generated_at": _now().isoformat(),
        "disclaimer": (
            "Reflects the LLP Act, 2008 / LLP Rules obligations currently applicable to this LLP, "
            "computed live from its category/turnover/contribution. Verify against the latest MCA "
            "notifications before relying on it for filing."
            if is_llp else
            "Reflects the Companies Act, 2013 obligations currently applicable to this company, "
            "computed live from its category/capital/turnover/director count — including any values "
            "fetched from uploaded Master Data or ROC Forms. Verify against the latest MCA "
            "notifications before relying on it for filing."
        ),
    }


# ─────────────────────────────────────────────────────────────────────────
# CS PRACTICE AUTOMATION ENGINE
# ─────────────────────────────────────────────────────────────────────────
# Creates a practical annual compliance work-plan inside the existing
# Taskosphere task engine. Dates are intentionally treated as planning
# dates, not legal advice; event-based items are shown without a hard date.


def _fy_dates(financial_year: Optional[str]) -> tuple[date, date, str]:
    now = _now().date()
    if financial_year:
        m = re.match(r"^(20\d{2})[-/]?(\d{2}|20\d{2})$", str(financial_year).strip())
        if m:
            start_year = int(m.group(1))
        else:
            start_year = now.year if now.month >= 4 else now.year - 1
    else:
        start_year = now.year if now.month >= 4 else now.year - 1
    end_year = start_year + 1
    label = f"{start_year}-{str(end_year)[-2:]}"
    return date(start_year, 4, 1), date(end_year, 3, 31), label


def _plan_item(key: str, title: str, description: str, due: Optional[date], category: str,
               frequency: str, priority: str = "medium", form: Optional[str] = None,
               event_based: bool = False) -> Dict[str, Any]:
    return {
        "key": key, "title": title, "description": description,
        "due_date": due.isoformat() if due else None, "category": category,
        "frequency": frequency, "priority": priority, "form": form,
        "event_based": event_based,
    }


def build_cs_practice_plan(company: Dict[str, Any], financial_year: Optional[str] = None) -> Dict[str, Any]:
    fy_start, fy_end, fy_label = _fy_dates(financial_year)
    category = company.get("category") or "private"
    items: List[Dict[str, Any]] = []
    company_name = company.get("company_name") or "Company"
    lead_note = "Planning date — verify applicability and current MCA due date before filing."

    if category == "llp":
        audit_applicable = _num(company.get("last_year_turnover")) > LLP_AUDIT_TURNOVER_LIMIT or _num(company.get("paid_up_capital")) > LLP_AUDIT_CONTRIBUTION_LIMIT
        items.extend([
            _plan_item("llp_form11", "Prepare & file Form 11 — Annual Return", f"{company_name}: collect partner/designated-partner and contribution data. {lead_note}", date(fy_end.year, 5, 30), "LLP Annual", "Annual", "high", "Form 11"),
            _plan_item("llp_form8", "Prepare & file Form 8 — Statement of Account & Solvency", f"{company_name}: finalise accounts, solvency statement and auditor report where applicable. {lead_note}", date(fy_end.year, 10, 30), "LLP Annual", "Annual", "high", "Form 8"),
            _plan_item("dir3_kyc", "DIR-3 KYC / DP KYC review", f"Review DIN/DPIN KYC status for every designated partner. {lead_note}", date(fy_end.year, 9, 30), "Annual ROC", "Annual", "high", "DIR-3 KYC"),
            _plan_item("itr", "LLP Income-tax return readiness", f"Prepare books, audit report and tax return working. Planned date only. {lead_note}", date(fy_end.year, 10 if audit_applicable else 7, 31), "Tax coordination", "Annual", "high", "Income Tax Return"),
            _plan_item("llp_agreement_review", "LLP Agreement & partner-change review", "Review agreement, contribution, partner/DP changes and event-based Form 3/Form 4/Form 15 requirements.", None, "LLP Event", "Event-based", "medium", "Form 3 / Form 4 / Form 15", True),
        ])
    else:
        is_opc = category == "opc"
        is_small = _is_small_company(company)
        is_section8 = category == "section_8"
        mgt_form = "MGT-7A" if is_small or is_opc else "MGT-7"
        agm_due = date(fy_end.year, 9, 30)
        items.extend([
            _plan_item("dpt3", "DPT-3 readiness & filing", "Collect deposit / loan / outstanding transaction data and verify applicability.", date(fy_end.year, 6, 30), "Annual ROC", "Annual", "high", "DPT-3"),
            _plan_item("dir3_kyc", "DIR-3 KYC review", "Verify DIN status, KYC declarations and supporting records for every director.", date(fy_end.year, 9, 30), "Annual ROC", "Annual", "high", "DIR-3 KYC"),
            _plan_item("agm", "AGM planning & notice pack", "Confirm AGM date, notice, agenda, attendance, auditor and annual-document readiness. Verify first-AGM and extension rules where applicable.", agm_due, "Meeting", "Annual", "high", "AGM"),
            _plan_item("board_annual_review", "Annual Board compliance review", "Review Board meeting count, MBP-1, DIR-8, registers, minutes and pending event-based filings.", date(fy_end.year, 4, 30), "Board Compliance", "Annual", "medium", "Board compliance"),
            _plan_item("aoc4", "AOC-4 filing pack", "Finalise financial statements, auditor report, Board report and AGM-linked filing data.", agm_due + timedelta(days=30), "Annual ROC", "Annual", "high", "AOC-4"),
            _plan_item("mgt7", f"{mgt_form} filing pack", "Finalise annual return data, directors/shareholders and AGM details.", agm_due + timedelta(days=60), "Annual ROC", "Annual", "high", mgt_form),
            _plan_item("adt1", "ADT-1 appointment / reappointment review", "Verify auditor appointment/reappointment and prepare ADT-1 where filing is triggered.", agm_due + timedelta(days=15), "Annual ROC", "As applicable", "medium", "ADT-1"),
            _plan_item("msme_apr", "MSME-1 half-yearly review — April cycle", "Obtain creditor ageing and outstanding dues data from client; file if applicable.", date(fy_end.year, 4, 29), "Half-Yearly ROC", "Half-Yearly", "medium", "MSME-1"),
            _plan_item("msme_oct", "MSME-1 half-yearly review — October cycle", "Obtain creditor ageing and outstanding dues data from client; file if applicable.", date(fy_end.year, 10, 31), "Half-Yearly ROC", "Half-Yearly", "medium", "MSME-1"),
            _plan_item("event_filings", "Event-based filing review", "Check changes in directors, registered office, charges, share capital, resolutions and other events requiring ROC filing.", None, "Event-based ROC", "Event-based", "high", "Event-based", True),
            _plan_item("statutory_registers", "Statutory registers & minutes review", "Reconcile registers, minutes, share transfers/certificates and supporting board/general meeting records.", None, "Secretarial Records", "Quarterly", "medium", "Registers", True),
        ])
        if not is_opc:
            for q, q_year, q_month in (("Q1", fy_start.year, 4), ("Q2", fy_start.year, 7), ("Q3", fy_start.year, 10), ("Q4", fy_end.year, 1)):
                items.append(_plan_item(
                    f"board_{q.lower()}", f"{q} Board meeting readiness", "Prepare agenda, MBP-1/DIR-8 checks, notices, attendance, minutes and follow-up actions. Exact meeting date to be fixed by the company.", date(q_year, q_month, 15), "Board Compliance", "Quarterly", "medium", "Board Meeting"
                ))
        if category == "public" or company.get("listed"):
            items.append(_plan_item("pas6_h1", "PAS-6 half-yearly reconciliation review", "Obtain reconciliation data and verify applicability for an unlisted public company with dematerialised securities.", date(fy_end.year, 5, 30), "Capital / Securities", "Half-Yearly", "medium", "PAS-6"))
            items.append(_plan_item("pas6_h2", "PAS-6 second half-year review", "Obtain reconciliation data and verify applicability.", date(fy_end.year, 11, 29), "Capital / Securities", "Half-Yearly", "medium", "PAS-6"))
        if is_section8:
            items.append(_plan_item("section8_csr", "Section 8 / CSR compliance review", "Review Section 8 objects, CSR applicability and annual disclosures before preparing filings.", None, "Section 8", "Annual", "medium", "CSR", True))

    if True:
        # Always add a client-information follow-up task so CS practice is not
        # reduced to filing dates: it creates a repeatable information chase.
        items.insert(0, _plan_item(
            "client_data_request", "Annual client data request & document chase",
            "Send the standard annual ROC/secretarial information request: financial statements, auditor report, Board report, registers, director/shareholder changes and pending events.",
            date(fy_end.year, 4, 15), "Client Coordination", "Annual", "high", "Client Information"
        ))

    return {
        "company_id": company.get("id"),
        "company_name": company_name,
        "category": category,
        "financial_year": fy_label,
        "fy_start": fy_start.isoformat(),
        "fy_end": fy_end.isoformat(),
        "items": items,
        "disclaimer": "Automation creates an internal practice work-plan. It does not determine legal applicability or replace review of the current MCA/Companies Act/LLP rules and actual event dates.",
    }


@router.get("/companies/{company_id}/cs-practice-plan")
async def get_cs_practice_plan(company_id: str, financial_year: Optional[str] = Query(None), current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    plan = build_cs_practice_plan(company, financial_year)
    task_keys = {t.get("roc_automation_key") for t in await db.tasks.find({"roc_company_id": company_id, "roc_financial_year": plan["financial_year"]}, {"_id": 0, "roc_automation_key": 1, "status": 1}).to_list(1000)}
    for item in plan["items"]:
        item["task_created"] = item["key"] in task_keys
    plan["created_task_count"] = len(task_keys)
    return plan


@router.post("/companies/{company_id}/cs-practice-plan/run")
async def run_cs_practice_plan(company_id: str, payload: CSPracticeRunRequest, current_user: User = Depends(CREATE)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    plan = build_cs_practice_plan(company, payload.financial_year)
    assignee_id = payload.assignee_id or current_user.id
    if assignee_id != current_user.id and getattr(current_user, "role", "") != "admin":
        raise HTTPException(403, "Only an administrator can run CS automation for another assignee")
    assignee = await db.users.find_one({"id": assignee_id}, {"_id": 0, "id": 1, "full_name": 1, "username": 1})
    if not assignee:
        raise HTTPException(404, "Assignee not found")

    created = []
    skipped = []
    for item in plan["items"]:
        if item.get("event_based") and not payload.include_review_tasks:
            continue
        key = item["key"]
        existing = await db.tasks.find_one({"roc_company_id": company_id, "roc_financial_year": plan["financial_year"], "roc_automation_key": key}, {"_id": 0, "id": 1, "status": 1})
        if existing and not payload.replace_existing:
            skipped.append(key)
            continue
        due = None
        if item.get("due_date"):
            due_date = date.fromisoformat(item["due_date"])
            due = datetime.combine(due_date, datetime.min.time(), tzinfo=timezone.utc) - timedelta(days=payload.lead_days)
        task_doc = {
            "id": existing.get("id") if existing else _uid(),
            "title": f"[ROC] {item['title']} — {company.get('company_name')}",
            "description": item.get("description"),
            "assigned_to": assignee_id,
            "assigned_to_name": assignee.get("full_name") or assignee.get("username"),
            "sub_assignees": [],
            "due_date": due.isoformat() if due else None,
            "priority": item.get("priority", "medium"),
            "status": existing.get("status", "pending") if existing else "pending",
            "category": "compliance",
            "categories": ["ROC", "CS Practice", item.get("category") or "Compliance"],
            "client_id": company.get("client_id"),
            "is_recurring": False,
            "recurrence_pattern": "monthly",
            "recurrence_interval": 1,
            "recurrence_end_date": None,
            "type": "roc_compliance",
            "popup_interval_minutes": None,
            "created_by": current_user.id,
            "created_at": existing.get("created_at") if existing else _now().isoformat(),
            "updated_at": _now().isoformat(),
            "roc_company_id": company_id,
            "roc_company_name": company.get("company_name"),
            "roc_financial_year": plan["financial_year"],
            "roc_automation_key": key,
            "roc_form": item.get("form"),
            "roc_planned_due_date": item.get("due_date"),
            "roc_event_based": item.get("event_based", False),
        }
        if existing:
            await db.tasks.replace_one({"id": existing["id"]}, task_doc)
        else:
            await db.tasks.insert_one(task_doc)
        created.append(task_doc)

    return {
        "financial_year": plan["financial_year"],
        "created": len(created),
        "skipped": len(skipped),
        "tasks": created,
        "assignee": assignee.get("full_name") or assignee.get("username"),
        "message": f"CS practice plan prepared: {len(created)} task(s) created/updated, {len(skipped)} already present.",
    }


@router.get("/companies/{company_id}/cs-practice-tasks")
async def get_cs_practice_tasks(company_id: str, financial_year: Optional[str] = Query(None), current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    _, _, fy_label = _fy_dates(financial_year)
    tasks = await db.tasks.find({"roc_company_id": company_id, "roc_financial_year": fy_label}, {"_id": 0}).sort("due_date", 1).to_list(1000)
    today = _now().date()
    summary = {"total": len(tasks), "completed": 0, "pending": 0, "overdue": 0, "due_30_days": 0}
    for task in tasks:
        if task.get("status") == "completed":
            summary["completed"] += 1
        else:
            summary["pending"] += 1
            if task.get("due_date"):
                try:
                    d = datetime.fromisoformat(str(task["due_date"]).replace("Z", "+00:00")).date()
                    if d < today:
                        summary["overdue"] += 1
                    elif (d - today).days <= 30:
                        summary["due_30_days"] += 1
                except Exception:
                    pass
    return {"financial_year": fy_label, "summary": summary, "tasks": tasks}


# ─────────────────────────────────────────────────────────────────────────
# DOCX GENERATION
# ─────────────────────────────────────────────────────────────────────────

def _base_doc():
    from docx import Document
    from docx.shared import Pt
    document = Document()
    style = document.styles["Normal"]
    style.font.name = "Times New Roman"
    style.font.size = Pt(12)
    sections = document.sections
    for s in sections:
        s.top_margin = s.bottom_margin = s.left_margin = s.right_margin = document.sections[0].left_margin
    return document


def _heading(document, text, size=14, center=True, bold=True, underline=False):
    from docx.shared import Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    p = document.add_paragraph()
    if center:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(text)
    run.bold = bold
    run.underline = underline
    run.font.size = Pt(size)
    return p


def _para(document, text, center=False, bold=False, italic=False):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    p = document.add_paragraph()
    if center:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(text)
    run.bold = bold
    run.italic = italic
    return p


def _company_email(company: Dict[str, Any]) -> str:
    master = company.get("master_data") or {}
    candidates = [
        company.get("email"), company.get("company_email"), company.get("email_address"),
        company.get("registered_office_email"),
        master.get("email"), master.get("company_email"),
        master.get("email_address"), master.get("registered_office_email"),
    ]
    for value in candidates:
        if isinstance(value, str) and value.strip() and "@" in value:
            return value.strip()
    return "—"


def _meeting_financial_year(meeting_date: str) -> str:
    try:
        d = datetime.strptime(str(meeting_date)[:10], "%Y-%m-%d").date()
    except Exception:
        return "Unknown"
    return f"{d.year}-{str(d.year + 1)[-2:]}" if d.month >= 4 else f"{d.year - 1}-{str(d.year)[-2:]}"


def build_board_resolution_doc(company: Dict[str, Any], req: BoardResolutionRequest, prepared_by: str) -> bytes:
    d = _base_doc()
    section = d.sections[0]
    section.top_margin = Inches(0.60)
    section.bottom_margin = Inches(0.65)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)

    name = company.get("company_name", "").upper()
    cin = company.get("cin") or "—"
    address = company.get("registered_office_address") or "—"
    email = _company_email(company)
    is_llp = _is_llp(company)
    body_label = "Designated Partners of the LLP" if is_llp else "Board of Directors of the Company"
    present_label = "Designated Partners Present" if is_llp else "Directors Present"
    sign_label = "Designated Partner" if is_llp else "Director / Company Secretary"
    din_label = "DIN/DPIN" if is_llp else "DIN/Membership No."

    # Professional corporate header.
    p = d.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(name)
    run.bold = True
    run.font.size = Pt(15)

    p = d.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"{'LLPIN' if is_llp else 'CIN'}: {cin}")
    run.bold = True
    run.font.size = Pt(9.5)

    p = d.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"Registered Office: {address}")
    run.font.size = Pt(9)

    p = d.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"Email: {email}")
    run.font.size = Pt(9)

    d.add_paragraph()
    _heading(d, "CERTIFIED TRUE COPY OF THE RESOLUTION PASSED AT THE MEETING", size=13, underline=True)
    p = d.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"OF THE {body_label.upper()}")
    run.bold = True
    run.font.size = Pt(10.5)

    meta = d.add_table(rows=3, cols=2)
    meta.style = "Table Grid"
    for row, (label, value) in zip(meta.rows, [
        ("Meeting Date", _fmt_date(req.meeting_date)),
        ("Time / Venue", f"{req.meeting_time or '—'} / {req.venue or '—'}"),
        ("Chairman", req.chairman or "—"),
    ]):
        row.cells[0].text = label
        row.cells[1].text = str(value)
        for run in row.cells[0].paragraphs[0].runs:
            run.bold = True

    d.add_paragraph()
    if req.directors_present:
        _para(d, f"{present_label}: " + ", ".join(req.directors_present))
    if getattr(req, "template_legal_basis", None):
        _para(d, f"Drafting / legal basis: {req.template_legal_basis}", italic=True)
    d.add_paragraph()

    for i, item in enumerate(req.resolutions, 1):
        _para(d, f"{i}. {item.particulars}", bold=True)
        _para(d, f'“RESOLVED THAT {item.resolution_text.strip().rstrip(".")}.”')
        if item.proposed_by or item.seconded_by:
            bits = []
            if item.proposed_by:
                bits.append(f"Proposed by: {item.proposed_by}")
            if item.seconded_by:
                bits.append(f"Seconded by: {item.seconded_by}")
            _para(d, " | ".join(bits), italic=True)
        d.add_paragraph()

    d.add_paragraph()
    _para(d, "CERTIFIED TRUE COPY", bold=True, center=True)
    d.add_paragraph()
    _para(d, f"For {name}", bold=True)
    d.add_paragraph()
    _para(d, sign_label)
    _para(d, f"{din_label}: ______________________________")
    _para(d, f"Date: {_fmt_date(datetime.now())}")
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = footer.add_run(f"{name}  |  {'LLPIN' if is_llp else 'CIN'}: {cin}  |  ROC Sphere")
    fr.font.size = Pt(8)

    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()

def build_general_meeting_resolution_doc(company: Dict[str, Any], req: GeneralMeetingResolutionRequest, prepared_by: str) -> bytes:
    d = _base_doc()
    section = d.sections[0]
    section.top_margin = Inches(0.60)
    section.bottom_margin = Inches(0.65)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)
    name = company.get("company_name", "").upper()
    cin = company.get("cin") or "—"
    address = company.get("registered_office_address") or "—"
    meeting_label = "ANNUAL GENERAL MEETING" if req.meeting_type == "agm" else "EXTRA-ORDINARY GENERAL MEETING"
    _heading(d, name, size=15)
    _para(d, f"CIN: {cin}", center=True)
    _para(d, f"Registered Office: {address}", center=True)
    d.add_paragraph()
    _heading(d, f"CERTIFIED TRUE COPY OF THE RESOLUTION PASSED AT THE {meeting_label}", size=13, underline=True)
    meta = d.add_table(rows=4, cols=2)
    meta.style = "Table Grid"
    for row, (label, value) in zip(meta.rows, [
        ("Meeting Date", _fmt_date(req.meeting_date)),
        ("Time / Venue", f"{req.meeting_time or '—'} / {req.venue or '—'}"),
        ("Chairman", req.chairman or "—"),
        ("Members Present", ", ".join(req.members_present) or "—"),
    ]):
        row.cells[0].text = label
        row.cells[1].text = str(value)
        for run in row.cells[0].paragraphs[0].runs:
            run.bold = True
    if getattr(req, "template_legal_basis", None):
        _para(d, f"Drafting / legal basis: {req.template_legal_basis}", italic=True)
    d.add_paragraph()
    for i, item in enumerate(req.resolutions, 1):
        _para(d, f"{i}. {item.particulars}", bold=True)
        _para(d, f'“RESOLVED THAT {item.resolution_text.strip().rstrip(".")}.”')
        if item.proposed_by or item.seconded_by:
            bits = []
            if item.proposed_by: bits.append(f"Proposed by: {item.proposed_by}")
            if item.seconded_by: bits.append(f"Seconded by: {item.seconded_by}")
            _para(d, " | ".join(bits), italic=True)
        d.add_paragraph()
    _para(d, "CERTIFIED TRUE COPY", bold=True, center=True)
    d.add_paragraph()
    _para(d, f"For {name}", bold=True)
    _para(d, "Chairman / Authorised Signatory")
    _para(d, "Signature: ______________________________")
    _para(d, f"Date: {_fmt_date(datetime.now())}")
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = footer.add_run(f"{name}  |  CIN: {cin}  |  ROC Sphere")
    fr.font.size = Pt(8)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_notice_doc(company: Dict[str, Any], req: MeetingNoticeRequest, prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    is_llp = _is_llp(company)
    if is_llp:
        label = {
            "board": "NOTICE OF MEETING OF DESIGNATED PARTNERS",
            "agm": "NOTICE OF MEETING OF PARTNERS",
            "egm": "NOTICE OF MEETING OF PARTNERS (EXTRA-ORDINARY)",
        }.get(req.meeting_type, "NOTICE OF MEETING")
    else:
        label = {
            "board": "NOTICE OF BOARD MEETING",
            "agm": "NOTICE OF ANNUAL GENERAL MEETING",
            "egm": "NOTICE OF EXTRA-ORDINARY GENERAL MEETING",
        }.get(req.meeting_type, "NOTICE OF MEETING")
    sign_label = "Designated Partner" if is_llp else "Director / Company Secretary"
    order_label = "By Order of the Designated Partners" if is_llp else "By Order of the Board"
    _heading(d, name, size=16)
    _para(d, f"LLPIN: {company.get('cin') or '—'}" if is_llp else f"CIN: {company.get('cin') or '—'}", center=True)
    _para(d, f"Registered Office: {company.get('registered_office_address') or '—'}", center=True)
    d.add_paragraph()
    _heading(d, label, size=13, underline=True)
    if getattr(req, "template_legal_basis", None):
        _para(d, f"Drafting / legal basis: {req.template_legal_basis}", italic=True)
    _para(d, f"Notice dated: {_fmt_date(req.notice_date or datetime.now())}")
    d.add_paragraph()
    if req.meeting_type == "board":
        body = "Designated Partners of the LLP" if is_llp else "Board of Directors of the Company"
        _para(d, f"NOTICE is hereby given that a meeting of the {body} will be held on "
                 f"{_fmt_date(req.meeting_date)} at {req.meeting_time} at {req.venue}, to transact the following business:")
    else:
        body = "Partners of the LLP" if is_llp else "members of the Company"
        _para(d, f"NOTICE is hereby given that the {label.split('OF ')[-1].title()} of the {body} will be held on "
                 f"{_fmt_date(req.meeting_date)} at {req.meeting_time} at {req.venue}, to transact the following business:")
    d.add_paragraph()
    if req.agenda_items:
        _para(d, "ORDINARY BUSINESS / AGENDA:", bold=True)
        for i, item in enumerate(req.agenda_items, 1):
            _para(d, f"{i}. {item}")
        d.add_paragraph()
    if req.special_business:
        _para(d, "SPECIAL BUSINESS:", bold=True)
        for i, r in enumerate(req.special_business, 1):
            _para(d, f"{i}. {r.particulars}", bold=True)
            _para(d, f'"RESOLVED THAT {r.resolution_text.strip().rstrip(".")}."')
        d.add_paragraph()

    if req.meeting_type != "board":
        _para(d, "NOTES:", bold=True)
        if is_llp:
            _para(d, "1. Attendance, quorum and voting shall be governed by the provisions of the LLP Agreement.")
            _para(d, "2. A Partner may be represented by an authorised representative only if expressly permitted by the LLP Agreement.")
        else:
            _para(d, "1. A member entitled to attend and vote is entitled to appoint a proxy to attend and vote instead of "
                     "himself/herself, and such proxy need not be a member of the Company.")
            _para(d, "2. Proxies, in order to be effective, must be received at the Registered Office not less than 48 hours "
                     "before the commencement of the meeting.")
    d.add_paragraph()
    _para(d, order_label)
    _para(d, "For " + name, bold=True)
    d.add_paragraph()
    _para(d, sign_label)
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)

    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_minutes_doc(company: Dict[str, Any], req: MinutesRequest, prepared_by: str, source_record: Optional[Dict[str, Any]] = None) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    is_llp = _is_llp(company)
    record = source_record or {}

    if is_llp:
        label = {
            "board": "MINUTES OF THE MEETING OF THE DESIGNATED PARTNERS",
            "agm": "MINUTES OF THE MEETING OF THE PARTNERS",
            "egm": "MINUTES OF THE EXTRA-ORDINARY MEETING OF THE PARTNERS",
        }.get(req.meeting_type, "MINUTES OF MEETING")
        present_label = "Designated Partners Present"
        absent_label = "Designated Partners Absent / Leave of Absence"
        attendee_label = "Other Partners / Attendees"
    else:
        label = {
            "board": "MINUTES OF THE MEETING OF THE BOARD OF DIRECTORS",
            "agm": "MINUTES OF THE ANNUAL GENERAL MEETING",
            "egm": "MINUTES OF THE EXTRA-ORDINARY GENERAL MEETING",
        }.get(req.meeting_type, "MINUTES OF MEETING")
        present_label = "Directors Present" if req.meeting_type == "board" else "Members / Directors Present"
        absent_label = "Directors Absent / Leave of Absence"
        attendee_label = "Members / Attendees Present"

    # Prefer the selected persistent record, then the request values.
    meeting_date = record.get("meeting_date") or req.meeting_date
    meeting_time = record.get("meeting_time") or req.meeting_time or "11:00 AM"
    venue = record.get("venue") or req.venue or company.get("registered_office_address") or "Registered Office"
    chairman = record.get("chairman") or req.chairman
    attendance = record.get("attendance") or []
    present = req.directors_present or [a.get("name") for a in attendance if a.get("status") == "Present" and a.get("name")]
    absent = req.directors_absent or [a.get("name") for a in attendance if a.get("status") != "Present" and a.get("name")]
    other = req.attendees_other or []
    agenda_items = record.get("agenda_items") or []
    resolutions = req.resolutions or [
        ResolutionItem(particulars=f"Item {i + 1}", resolution_text=x)
        for i, x in enumerate(record.get("resolutions_passed") or [])
    ]
    special_business = record.get("special_business") or []
    discussion_notes = req.discussion_notes or record.get("secretarial_notes") or ""

    _heading(d, name, size=16)
    _para(d, f"{'LLPIN' if is_llp else 'CIN'}: {company.get('cin') or '—'}", center=True)
    _para(d, f"Registered Office: {company.get('registered_office_address') or '—'}", center=True)
    d.add_paragraph()
    _heading(d, label, size=13, underline=True)
    _para(d, f"Held on {_fmt_date(meeting_date)} from {meeting_time or '—'} at {venue}.")
    if getattr(req, "template_legal_basis", None):
        _para(d, f"Drafting basis: {req.template_legal_basis}", italic=True)
    d.add_paragraph()

    _para(d, "PRESENT:", bold=True)
    if present:
        for person in present:
            _para(d, f"{person}" + (" — Director" if not is_llp and req.meeting_type == "board" else ""))
    else:
        _para(d, "—")
    if absent:
        _para(d, f"{absent_label}: " + ", ".join(absent))
    if other:
        _para(d, f"{attendee_label}: " + ", ".join(other))
    if chairman:
        _para(d, "CHAIRMAN", bold=True)
        _para(d, f"{chairman} took the Chair and conducted the Meeting.")
    else:
        _para(d, "CHAIRMAN", bold=True)
        _para(d, "The Chairman took the Chair and conducted the Meeting.")

    if req.meeting_type != "board":
        _para(d, "QUORUM", bold=True)
        _para(d, "Quorum was present at the commencement of the Meeting and while the business was transacted.")
        _para(d, "With the consent of the Members present, the Notice convening the Meeting was taken as read.")

    if req.meeting_type == "board":
        _para(d, "LEAVE OF ABSENCE", bold=True)
        _para(d, f"Leave of absence was granted to {', '.join(absent)}." if absent else "No leave of absence was recorded.")
        _para(d, "QUORUM", bold=True)
        _para(d, "The business before the Meeting was taken up after establishing that the requisite quorum was present.")
        _para(d, "MINUTES / PREVIOUS PROCEEDINGS", bold=True)
        _para(d, "The Minutes of the previous Board Meeting, as circulated, were noted by the Board and signed by the Chairman.")
        _para(d, "COMMITTEE / CIRCULATION MATTERS", bold=True)
        _para(d, "The Minutes of relevant Committee Meetings and any resolution passed by circulation since the previous Meeting, where applicable, were noted and taken on record.")

    if agenda_items:
        _para(d, "BUSINESS TRANSACTED", bold=True)
        for i, item in enumerate(agenda_items, 1):
            _para(d, f"{i}. {item}", bold=True)
            _para(d, "The Chairman placed the item before the Meeting and the same was discussed and considered.")

    if special_business:
        _para(d, "SPECIAL BUSINESS", bold=True)
        for i, item in enumerate(special_business, 1):
            _para(d, f"{i}. {item}", bold=True)
            _para(d, "The Chairman placed the item before the Meeting and the same was discussed and considered.")

    if discussion_notes:
        _para(d, "DISCUSSION / DELIBERATIONS", bold=True)
        _para(d, discussion_notes)

    if resolutions:
        _para(d, "RESOLUTIONS PASSED / DECISIONS TAKEN", bold=True)
        for i, r in enumerate(resolutions, 1):
            _para(d, f"{i}. {r.particulars}", bold=True)
            _para(d, f'The following resolution was proposed and seconded as applicable and was considered by the Meeting:')
            _para(d, f'“RESOLVED THAT {r.resolution_text.strip().rstrip(".")}.”')
            if r.proposed_by or r.seconded_by:
                bits = []
                if r.proposed_by:
                    bits.append(f"Proposed by: {r.proposed_by}")
                if r.seconded_by:
                    bits.append(f"Seconded by: {r.seconded_by}")
                _para(d, " | ".join(bits), italic=True)
            if req.meeting_type in {"agm", "egm"}:
                _para(d, "The Chairman invited the Members to raise any queries or seek clarifications. The resolution was thereafter put to vote and declared carried by the requisite majority, subject to the actual voting record.")
            else:
                _para(d, "The resolution was considered by the Directors and was passed / noted as applicable, subject to the actual proceedings and dissent, if any.")

    _para(d, "CLOSE OF THE MEETING", bold=True)
    _para(d, "There being no other business to transact, the Meeting concluded with a vote of thanks to the Chair.")
    d.add_paragraph()
    _para(d, f"Date: {_fmt_date(meeting_date)}")
    _para(d, f"Place: {venue}")
    d.add_paragraph()
    _para(d, "CHAIRMAN", bold=True)
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)

    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()

def build_shareholders_doc(company: Dict[str, Any], prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    _heading(d, name, size=16)
    _para(d, f"CIN: {company.get('cin') or '—'}", center=True)
    d.add_paragraph()
    _heading(d, "REGISTER OF MEMBERS / LIST OF SHAREHOLDERS", size=13, underline=True)
    _para(d, f"As on: {_fmt_date(datetime.now())}")
    d.add_paragraph()

    shareholders = company.get("shareholders") or []
    total_shares = sum(_num(s.get("shares_held")) for s in shareholders) or 1

    table = d.add_table(rows=1, cols=6)
    table.style = "Table Grid"
    hdr = table.rows[0].cells
    for i, h in enumerate(["Sl. No.", "Name of Member", "Folio No. / PAN", "Class of Shares", "No. of Shares Held", "% Holding"]):
        hdr[i].text = ""
        hdr[i].paragraphs[0].add_run(h).bold = True

    for idx, s in enumerate(shareholders, 1):
        row = table.add_row().cells
        pct = s.get("percentage")
        if pct is None:
            pct = round(_num(s.get("shares_held")) / total_shares * 100, 2)
        row[0].text = str(idx)
        row[1].text = s.get("name", "")
        row[2].text = " / ".join(filter(None, [s.get("folio_no"), s.get("pan")])) or "—"
        row[3].text = s.get("class_of_shares") or "Equity"
        row[4].text = f"{_num(s.get('shares_held')):,.0f}"
        row[5].text = f"{pct}%"

    d.add_paragraph()
    _para(d, f"Total Paid-up Share Capital: Rs. {_num(company.get('paid_up_capital')):,.0f}", bold=True)
    _para(d, f"Authorized Share Capital: Rs. {_num(company.get('authorized_capital')):,.0f}", bold=True)
    d.add_paragraph()
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)

    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_share_transfer_register_doc(company: Dict[str, Any], prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    _heading(d, name, size=16)
    _para(d, f"CIN: {company.get('cin') or '—'}", center=True)
    d.add_paragraph()
    _heading(d, "REGISTER OF SHARE TRANSFERS", size=13, underline=True)
    _para(d, "Working register — update after receipt, stamping, approval and registration of the instrument.")
    d.add_paragraph()
    table = d.add_table(rows=1, cols=9)
    table.style = "Table Grid"
    headers = [
        "Sl. No.", "Date", "Transferor", "Transferee", "Folio / Certificate",
        "Distinctive Nos.", "Shares", "Consideration (Rs.)", "SH-4 Status",
    ]
    for i, header in enumerate(headers):
        table.rows[0].cells[i].text = header
    for index, transfer in enumerate(company.get("share_transfers") or [], 1):
        row = table.add_row().cells
        distinctive = " - ".join(filter(None, [
            str(transfer.get("distinctive_from") or ""),
            str(transfer.get("distinctive_to") or ""),
        ])) or "—"
        row[0].text = str(index)
        row[1].text = _fmt_date(transfer.get("transfer_date"))
        row[2].text = transfer.get("transferor_name") or "—"
        row[3].text = transfer.get("transferee_name") or "—"
        row[4].text = " / ".join(filter(None, [
            transfer.get("transferor_folio_no"),
            transfer.get("share_certificate_no"),
        ])) or "—"
        row[5].text = distinctive
        row[6].text = f"{_num(transfer.get('number_of_shares')):,.0f}"
        row[7].text = f"{_num(transfer.get('consideration')):,.2f}"
        row[8].text = transfer.get("sh4_status") or "Pending review"
    d.add_paragraph()
    _para(d, "Prepared by: " + prepared_by + " (ROC Sphere)", italic=True)
    _para(d, "This register is a controlled working draft and must be reconciled with the Register of Members and executed SH-4 instruments.", italic=True)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_sh4_doc(company: Dict[str, Any], req: ShareTransferRequest, prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    _heading(d, "FORM NO. SH-4", size=16)
    _heading(d, "SECURITIES TRANSFER FORM", size=13, underline=True)
    _para(d, "(Pursuant to Section 56 of the Companies Act, 2013 and applicable rules)", center=True, italic=True)
    d.add_paragraph()
    details = [
        ("Name of company", name),
        ("CIN", company.get("cin") or "—"),
        ("Registered office", company.get("registered_office_address") or "—"),
        ("Date of execution", _fmt_date(req.instrument_date or req.transfer_date)),
        ("Class of securities", req.class_of_shares),
        ("Number of securities transferred", f"{_num(req.number_of_shares):,.0f}"),
        ("Nominal value per security", f"Rs. {_num(req.nominal_value_per_share):,.2f}"),
        ("Consideration", f"Rs. {_num(req.consideration):,.2f}"),
        ("Distinctive numbers", " - ".join(filter(None, [req.distinctive_from, req.distinctive_to])) or "—"),
        ("Existing share certificate no.", req.share_certificate_no or "—"),
        ("Transferor / registered holder", req.transferor_name),
        ("Transferor folio no.", req.transferor_folio_no or "—"),
        ("Transferee", req.transferee_name),
        ("Transferee folio no.", req.transferee_folio_no or "To be allotted"),
        ("Stamp duty", f"Rs. {_num(req.stamp_duty):,.2f}"),
        ("Date instrument received by company", _fmt_date(req.instrument_received_date)),
    ]
    table = d.add_table(rows=0, cols=2)
    table.style = "Table Grid"
    for label, value in details:
        cells = table.add_row().cells
        cells[0].text = label
        cells[1].text = str(value)
    d.add_paragraph()
    _para(d, "Declaration by transferor", bold=True)
    _para(d, "I / We hereby transfer the above securities to the transferee named above, subject to the terms and conditions applicable to the company and the Companies Act, 2013.")
    d.add_paragraph()
    _para(d, "Transferor signature: ______________________________")
    _para(d, "Transferee signature: ______________________________")
    _para(d, "Witness name, address and signature: ______________________________")
    d.add_paragraph()
    _para(d, "For office use", bold=True)
    _para(d, "Board approval date: " + _fmt_date(req.board_resolution_date))
    _para(d, "Registration / SH-4 status: " + (req.sh4_status or "Pending review"))
    _para(d, "Company authorised signatory: ______________________________")
    _para(d, "Prepared by: " + prepared_by + " (ROC Sphere)", italic=True)
    _para(d, "Draft only — verify stamp duty, execution, witness details, board approval and applicable exemptions before use.", italic=True)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_share_certificate_doc(company: Dict[str, Any], req: ShareCertificateRequest, prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    _heading(d, name, size=16)
    _para(d, f"CIN: {company.get('cin') or '—'}", center=True)
    _heading(d, "SHARE CERTIFICATE", size=14, underline=True)
    _para(d, "Certificate No. " + req.certificate_no, center=True, bold=True)
    d.add_paragraph()
    _para(d, f"This is to certify that {req.holder_name} is/are the registered holder(s) of the following {req.class_of_shares} share(s) in the Company, subject to its Memorandum and Articles of Association.")
    table = d.add_table(rows=0, cols=2)
    table.style = "Table Grid"
    values = [
        ("Registered holder", req.holder_name),
        ("Address", req.holder_address or "—"),
        ("Folio number", req.folio_no or "—"),
        ("Class of shares", req.class_of_shares),
        ("Number of shares", f"{_num(req.number_of_shares):,.0f}"),
        ("Nominal value per share", f"Rs. {_num(req.nominal_value_per_share):,.2f}"),
        ("Amount paid per share", f"Rs. {_num(req.amount_paid_per_share):,.2f}"),
        ("Distinctive numbers", " - ".join(filter(None, [req.distinctive_from, req.distinctive_to])) or "—"),
        ("Date of issue", _fmt_date(req.issue_date)),
    ]
    for label, value in values:
        cells = table.add_row().cells
        cells[0].text = label
        cells[1].text = str(value)
    d.add_paragraph()
    _para(d, "Authorised signatory: ______________________________")
    _para(d, "Authorised signatory: ______________________________")
    _para(d, "Prepared by: " + prepared_by + " (ROC Sphere)", italic=True)
    _para(d, "Draft only — verify certificate numbering, Register of Members, share allotment/transfer records and applicable statutory requirements before issue.", italic=True)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def build_checklist_doc(company: Dict[str, Any], checklist: List[Dict[str, Any]], prepared_by: str) -> bytes:
    d = _base_doc()
    name = company.get("company_name", "").upper()
    _heading(d, name, size=16)
    _para(d, f"CIN: {company.get('cin') or '—'}", center=True)
    d.add_paragraph()
    _heading(d, "ROC / COMPANIES ACT, 2013 — COMPLIANCE CHECKLIST", size=13, underline=True)
    _para(d, f"Generated on: {_fmt_date(datetime.now())}")
    d.add_paragraph()

    table = d.add_table(rows=1, cols=5)
    table.style = "Table Grid"
    hdr = table.rows[0].cells
    for i, h in enumerate(["Form / Item", "Particulars", "Due Date Rule", "Frequency", "Applicable"]):
        hdr[i].text = ""
        hdr[i].paragraphs[0].add_run(h).bold = True
    for item in checklist:
        row = table.add_row().cells
        row[0].text = item["form"]
        row[1].text = item["particulars"] + (f" ({item['notes']})" if item.get("notes") else "")
        row[2].text = item["due_date_rule"]
        row[3].text = item["frequency"]
        row[4].text = "Yes" if item["applicable"] else "No"

    d.add_paragraph()
    _para(d, "This checklist is a drafting aid generated from the company's category, capital and turnover as "
             "recorded in Taskosphere. Please verify against the latest MCA notifications before filing.", italic=True)
    _para(d, f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)", italic=True)

    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _docx_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", text or "").strip("_") or "Document"


async def _log_doc(company_id: str, doc_type: str, filename: str, user: User, content: Optional[bytes] = None):
    doc = {
        "id": _uid(),
        "company_id": company_id,
        "doc_type": doc_type,
        "filename": filename,
        "generated_at": _now(),
        "generated_by": _who(user),
    }
    if content:
        doc["content_b64"] = base64.b64encode(content).decode("ascii")
    await DOCS_LOG.insert_one(doc)
    return doc


async def _upsert_generated_meeting_record(
    company_id: str,
    meeting_type: str,
    meeting_date: str,
    meeting_time: Optional[str],
    venue: Optional[str],
    doc: Dict[str, Any],
    agenda_items: Optional[List[str]] = None,
    resolutions: Optional[List[ResolutionItem]] = None,
    occasion_label: Optional[str] = None,
):
    """Persist generated meeting documents in the company's secretarial register."""
    company = await COMPANIES.find_one({"id": company_id}, {"record_history": 1})
    if not company:
        return

    records = list(company.get("record_history") or [])
    date_key = str(meeting_date)[:10]
    match = next(
        (r for r in records
         if r.get("meeting_type") == meeting_type and str(r.get("meeting_date"))[:10] == date_key),
        None,
    )

    if match is None:
        match = {
            "id": _uid(),
            "meeting_type": meeting_type,
            "meeting_number": None,
            "meeting_date": meeting_date,
            "meeting_time": meeting_time,
            "notice_date": None,
            "venue": venue,
            "mode": None,
            "chairman": None,
            "quorum_present": True,
            "attendance": [],
            "members_present_count": None,
            "members_entitled_count": None,
            "leave_of_absence": [],
            "agenda_items": [],
            "resolutions_passed": [],
            "resolution_items": [],
            "occasion": None,
            "special_business": [],
            "minutes_date": meeting_date if doc.get("doc_type") == f"minutes_{meeting_type}" else None,
            "minutes_signed_date": None,
            "adjourned": False,
            "adjourned_to": None,
            "auditor_attended": None,
            "secretarial_notes": "",
            "attachments": [],
            "status": "Draft / Generated",
            "remarks": "",
            "created_at": _now().isoformat(),
            "created_by": doc.get("generated_by"),
            "updated_at": _now().isoformat(),
        }
        records.append(match)

    if agenda_items:
        match["agenda_items"] = list(dict.fromkeys([*(match.get("agenda_items") or []), *agenda_items]))
    if resolutions:
        resolution_texts = [r.resolution_text for r in resolutions if r.resolution_text]
        match["resolutions_passed"] = list(dict.fromkeys([*(match.get("resolutions_passed") or []), *resolution_texts]))
        resolution_items = [
            {
                "particulars": r.particulars,
                "resolution_text": r.resolution_text,
                "proposed_by": r.proposed_by,
                "seconded_by": r.seconded_by,
                "draft_key": getattr(r, "draft_key", None),
            }
            for r in resolutions
            if r.resolution_text or r.particulars
        ]
        if resolution_items:
            match["resolution_items"] = resolution_items
            if not match.get("occasion") or occasion_label:
                match["occasion"] = occasion_label or resolution_items[0].get("particulars")
    if occasion_label:
        match["occasion"] = occasion_label
    if doc.get("doc_type") == f"minutes_{meeting_type}":
        match["minutes_date"] = meeting_date

    generated = list(match.get("generated_documents") or [])
    generated.append({
        "id": doc.get("id"),
        "doc_type": doc.get("doc_type"),
        "filename": doc.get("filename"),
        "generated_at": doc.get("generated_at").isoformat() if hasattr(doc.get("generated_at"), "isoformat") else str(doc.get("generated_at")),
        "generated_by": doc.get("generated_by"),
    })
    match["generated_documents"] = [x for i, x in enumerate(generated) if x.get("id") and x.get("id") not in {y.get("id") for y in generated[:i]}]
    match["updated_at"] = _now().isoformat()

    await COMPANIES.update_one(
        {"id": company_id},
        {"$set": {"record_history": records, "updated_at": _now()}},
    )


@router.get("/meeting-draft-templates")
async def meeting_draft_templates(current_user: User = Depends(VIEW)):
    return {"templates": MEETING_DRAFT_TEMPLATES}


def _resolve_meeting_template(template_key: Optional[str], values: Dict[str, Any], custom_topic: Optional[str]) -> Optional[Dict[str, str]]:
    if custom_topic:
        topic = custom_topic.strip()
        if topic:
            return {
                "key": "custom",
                "label": "Other",
                "category": "Custom",
                "legal_basis": "Custom item — insert the specific statutory provision(s), Rules, Articles and approvals applicable to the transaction before use.",
                "agenda": topic,
                "resolution": topic,
            }
    if not template_key:
        return None
    template = next((x for x in MEETING_DRAFT_TEMPLATES if x["key"] == template_key), None)
    if not template:
        raise HTTPException(400, "Invalid meeting draft template")
    class SafeValues(dict):
        def __missing__(self, key):
            return f"{{{key}}}"
    safe = SafeValues(values or {})
    return {k: (v.format_map(safe) if isinstance(v, str) else v) for k, v in template.items()}


@router.post("/companies/{company_id}/generate/board-resolution")
async def generate_board_resolution(company_id: str, req: BoardResolutionRequest, current_user: User = Depends(VIEW)):
    resolved = _resolve_meeting_template(req.template_key, req.template_values, req.custom_topic)
    if resolved:
        req = req.model_copy(update={
            "template_legal_basis": resolved.get("legal_basis"),
            "resolutions": (
                req.resolutions if any(r.resolution_text for r in req.resolutions)
                else [ResolutionItem(particulars=resolved.get("label") or "Other", resolution_text=resolved.get("resolution") or "")]
            ),
        })
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if not _company_email(company) and company.get("client_id"):
        client = await CLIENTS.find_one({"id": company["client_id"]}, {"_id": 0})
        if client:
            for key in ("email", "company_email", "email_address", "registered_office_email"):
                if client.get(key):
                    company["email"] = client.get(key)
                    break
    try:
        content = build_board_resolution_doc(company, req, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Board_Resolution_{_safe(company.get('company_name'))}_{_safe(req.meeting_date)}.docx"
    doc = await _log_doc(company_id, "board_resolution", fname, current_user, content)
    await _upsert_generated_meeting_record(company_id, "board", req.meeting_date, req.meeting_time, req.venue, doc, resolutions=req.resolutions, occasion_label=(resolved.get("label") if resolved else (req.resolutions[0].particulars if req.resolutions else None)))
    return _docx_response(content, fname)


@router.post("/companies/{company_id}/generate/general-resolution")
async def generate_general_meeting_resolution(company_id: str, req: GeneralMeetingResolutionRequest, current_user: User = Depends(VIEW)):
    resolved = _resolve_meeting_template(req.template_key, req.template_values, req.custom_topic)
    if resolved:
        req = req.model_copy(update={
            "template_legal_basis": resolved.get("legal_basis"),
            "resolutions": req.resolutions if any(r.resolution_text for r in req.resolutions) else [
                ResolutionItem(particulars=resolved.get("label") or "Other", resolution_text=resolved.get("resolution") or "")
            ],
        })
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if req.meeting_type not in {"agm", "egm"}:
        raise HTTPException(400, "General Meeting Resolution supports AGM or EGM only")
    try:
        content = build_general_meeting_resolution_doc(company, req, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"General_Meeting_Resolution_{req.meeting_type.upper()}_{_safe(company.get('company_name'))}_{_safe(req.meeting_date)}.docx"
    doc = await _log_doc(company_id, f"general_resolution_{req.meeting_type}", fname, current_user, content)
    await _upsert_generated_meeting_record(company_id, req.meeting_type, req.meeting_date, req.meeting_time, req.venue, doc, resolutions=req.resolutions, occasion_label=(resolved.get("label") if resolved else (req.resolutions[0].particulars if req.resolutions else None)))
    return _docx_response(content, fname)


@router.post("/companies/{company_id}/generate/notice")
async def generate_notice(company_id: str, req: MeetingNoticeRequest, current_user: User = Depends(VIEW)):
    resolved = _resolve_meeting_template(req.template_key, req.template_values, req.custom_topic)
    if resolved:
        req = req.model_copy(update={
            "template_legal_basis": resolved.get("legal_basis"),
            "agenda_items": (
                req.agenda_items if req.agenda_items else [resolved.get("agenda") or ""]
            ),
            "special_business": (
                req.special_business if req.special_business
                else [ResolutionItem(particulars=resolved.get("label") or "Other", resolution_text=resolved.get("resolution") or "")]
            ),
        })
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    try:
        content = build_notice_doc(company, req, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Notice_{req.meeting_type.upper()}_{_safe(company.get('company_name'))}_{_safe(req.meeting_date)}.docx"
    doc = await _log_doc(company_id, f"notice_{req.meeting_type}", fname, current_user, content)
    await _upsert_generated_meeting_record(company_id, req.meeting_type, req.meeting_date, req.meeting_time, req.venue, doc, agenda_items=req.agenda_items, resolutions=req.special_business, occasion_label=(resolved.get("label") if resolved else (req.special_business[0].particulars if req.special_business else None)))
    return _docx_response(content, fname)


@router.post("/companies/{company_id}/generate/minutes")
async def generate_minutes(company_id: str, req: MinutesRequest, current_user: User = Depends(VIEW)):
    resolved = _resolve_meeting_template(req.template_key, req.template_values, req.custom_topic)
    if resolved:
        req = req.model_copy(update={
            "template_legal_basis": resolved.get("legal_basis"),
            "resolutions": (
                req.resolutions if any(r.resolution_text for r in req.resolutions)
                else [ResolutionItem(particulars=resolved.get("label") or "Other", resolution_text=resolved.get("resolution") or "")]
            ),
        })
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if req.selected_record_id and not any(r.get("id") == req.selected_record_id for r in (company.get("record_history") or [])):
        raise HTTPException(404, "Selected meeting record not found")
    try:
        source_record = None
        if req.selected_record_id:
            source_record = next((r for r in (company.get("record_history") or []) if r.get("id") == req.selected_record_id), None)
            if source_record is None:
                raise HTTPException(404, "Selected meeting record not found")
            if source_record.get("meeting_type") != req.meeting_type:
                raise HTTPException(400, "Selected meeting record type does not match the Minutes meeting type")
        content = build_minutes_doc(company, req, _who(current_user), source_record=source_record)
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Minutes_{req.meeting_type.upper()}_{_safe(company.get('company_name'))}_{_safe(req.meeting_date)}.docx"
    doc = await _log_doc(company_id, f"minutes_{req.meeting_type}", fname, current_user, content)
    await _upsert_generated_meeting_record(company_id, req.meeting_type, req.meeting_date, req.meeting_time, req.venue, doc, resolutions=req.resolutions)
    return _docx_response(content, fname)


@router.get("/companies/{company_id}/generate/shareholders")
async def generate_shareholders(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    try:
        content = build_shareholders_doc(company, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Shareholders_{_safe(company.get('company_name'))}.docx"
    await _log_doc(company_id, "shareholders", fname, current_user, content)
    return _docx_response(content, fname)


@router.get("/companies/{company_id}/generate/share-transfer-register")
async def generate_share_transfer_register(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    try:
        content = build_share_transfer_register_doc(company, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Share_Transfer_Register_{_safe(company.get('company_name'))}.docx"
    await _log_doc(company_id, "share_transfer_register", fname, current_user, content)
    return _docx_response(content, fname)


@router.post("/companies/{company_id}/generate/sh-4")
async def generate_sh4(company_id: str, req: ShareTransferRequest, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    try:
        content = build_sh4_doc(company, req, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"SH-4_{_safe(req.transferor_name)}_to_{_safe(req.transferee_name)}_{_safe(req.transfer_date or datetime.now().date().isoformat())}.docx"
    await _log_doc(company_id, "sh4", fname, current_user, content)
    return _docx_response(content, fname)


@router.post("/companies/{company_id}/generate/share-certificate")
async def generate_share_certificate(company_id: str, req: ShareCertificateRequest, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    try:
        content = build_share_certificate_doc(company, req, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Share_Certificate_{_safe(req.certificate_no)}_{_safe(req.holder_name)}.docx"
    await _log_doc(company_id, "share_certificate", fname, current_user, content)
    return _docx_response(content, fname)


@router.get("/companies/{company_id}/generate/checklist")
async def generate_checklist_doc(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    checklist = build_compliance_checklist(company)
    try:
        content = build_checklist_doc(company, checklist, _who(current_user))
    except ImportError as e:
        raise HTTPException(500, f"Document generator not installed on the server: {e}")
    fname = f"Compliance_Checklist_{_safe(company.get('company_name'))}.docx"
    await _log_doc(company_id, "checklist", fname, current_user, content)
    return _docx_response(content, fname)


@router.get("/companies/{company_id}/documents/{document_id}/download")
async def download_generated_document(company_id: str, document_id: str, current_user: User = Depends(VIEW)):
    doc = await DOCS_LOG.find_one({"id": document_id, "company_id": company_id})
    if not doc:
        raise HTTPException(404, "Generated document not found")
    encoded = doc.get("content_b64")
    if not encoded:
        raise HTTPException(410, "This older document record has no stored file content. Delete it and regenerate the document.")
    try:
        content = base64.b64decode(encoded)
    except Exception:
        raise HTTPException(500, "Stored document content is invalid")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{doc.get("filename") or "ROC_Document.docx"}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.delete("/companies/{company_id}/documents/{document_id}")
async def delete_generated_document(company_id: str, document_id: str, current_user: User = Depends(DELETE)):
    result = await DOCS_LOG.delete_one({"id": document_id, "company_id": company_id})
    if not result.deleted_count:
        raise HTTPException(404, "Generated document not found")
    return {"deleted": document_id}


@router.get("/companies/{company_id}/documents")
async def list_generated_documents(company_id: str, current_user: User = Depends(VIEW)):
    cursor = DOCS_LOG.find({"company_id": company_id}).sort("generated_at", -1)
    items = [x async for x in cursor]
    for x in items:
        x.pop("_id", None)
        x["downloadable"] = bool(x.get("content_b64"))
        x.pop("content_b64", None)
    return items
