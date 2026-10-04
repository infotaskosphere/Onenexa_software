import imaplib
import email
import email.header
import email.utils
import re
import json
import asyncio
import logging
import html
import difflib
import uuid as _uuid
from html.parser import HTMLParser
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Set, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from bson import ObjectId

from backend.dependencies import get_current_user, db, check_module_permission, get_team_user_ids

_EMAIL_ENCRYPTION_PRODUCTION = str(os.environ.get("ENV_MODE") or "").strip().lower() == "production"
try:
    from cryptography.fernet import Fernet
    import os as _os
    _fernet_key = _os.environ.get("EMAIL_ENCRYPT_KEY", "").encode()
    _fernet = Fernet(_fernet_key) if len(_fernet_key) == 44 else None
    if _EMAIL_ENCRYPTION_PRODUCTION and _fernet is None:
        raise RuntimeError(
            "EMAIL_ENCRYPT_KEY must be configured with a valid Fernet key in production."
        )
except Exception:
    if _EMAIL_ENCRYPTION_PRODUCTION:
        raise
    _fernet = None

try:
    import google.generativeai as genai
    import os as _os2
    _gemini_key = _os2.environ.get("GEMINI_API_KEY", "")
    if _gemini_key:
        genai.configure(api_key=_gemini_key)
        _gemini = genai.GenerativeModel("gemini-2.0-flash-lite")
    else:
        _gemini = None
except Exception:
    _gemini = None

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/email", tags=["email"])

IST = ZoneInfo("Asia/Kolkata")

# =============================================================================
# IMAP PROVIDER DEFAULTS
# =============================================================================
PROVIDER_IMAP: Dict[str, tuple] = {
    "gmail.com":      ("imap.gmail.com",        993, "gmail"),
    "googlemail.com": ("imap.gmail.com",        993, "gmail"),
    "outlook.com":    ("outlook.office365.com", 993, "outlook"),
    "hotmail.com":    ("outlook.office365.com", 993, "outlook"),
    "live.com":       ("outlook.office365.com", 993, "outlook"),
    "yahoo.com":      ("imap.mail.yahoo.com",   993, "yahoo"),
    "ymail.com":      ("imap.mail.yahoo.com",   993, "yahoo"),
    "icloud.com":     ("imap.mail.me.com",      993, "icloud"),
    "me.com":         ("imap.mail.me.com",      993, "icloud"),
}

COL_CONNECTIONS      = "email_connections"
COL_EVENTS           = "email_extracted_events"
COL_AUTO_PREFS       = "email_auto_save_prefs"
COL_SCAN_SCHEDULE    = "email_scan_schedule"
COL_SENDER_WHITELIST = "email_sender_whitelist"
COL_SCAN_SETTINGS    = "email_scan_settings"

# =============================================================================
# PYDANTIC SCHEMAS
# =============================================================================

class ConnectionCreateRequest(BaseModel):
    email_address: str
    app_password: str
    imap_host: Optional[str] = None
    imap_port: Optional[int] = 993
    label: Optional[str] = None
    linked_page: Optional[str] = "all"
    auto_sync: Optional[bool] = False
    # Keyword filtering — only emails whose Subject matches these are pulled
    # from the mailbox during a sync. Empty/None disables keyword filtering
    # (normal "all recent mail" behaviour).
    keywords: Optional[List[str]] = None
    # "or"  → any keyword in subject is a match (default)
    # "and" → every keyword must appear in subject
    keyword_match_mode: Optional[str] = "or"
    # When False (default) keyword matching is case-insensitive.
    keyword_case_sensitive: Optional[bool] = False
    # When True (default) keyword-matched emails are auto-saved to reminders.
    # When False, they still appear in the preview panel for manual confirmation.
    keyword_auto_save: Optional[bool] = True

class ConnectionUpdateRequest(BaseModel):
    label: Optional[str] = None
    is_active: Optional[bool] = None
    linked_page: Optional[str] = None
    auto_sync: Optional[bool] = None
    keywords: Optional[List[str]] = None
    keyword_match_mode: Optional[str] = None          # "or" | "and"
    keyword_case_sensitive: Optional[bool] = None
    keyword_auto_save: Optional[bool] = None
    # ── Admin overrides (only writable by admin) ───────────────────────────
    admin_paused: Optional[bool] = None
    admin_disabled: Optional[bool] = None
    # ── Admin-only: assign users to see this connection in Action Center ──
    linked_user_ids: Optional[List[str]] = None

class ConnectionOut(BaseModel):
    email_address: str
    imap_host: str
    imap_port: int
    label: Optional[str] = None
    provider: str
    is_active: bool
    last_synced: Optional[str] = None
    connected_at: Optional[str] = None
    sync_error: Optional[str] = None
    linked_page: Optional[str] = "all"
    auto_sync: Optional[bool] = False
    keywords: Optional[List[str]] = None
    keyword_match_mode: Optional[str] = "or"
    keyword_case_sensitive: Optional[bool] = False
    keyword_auto_save: Optional[bool] = True
    # ── Admin overrides ────────────────────────────────────────────────────
    admin_paused: Optional[bool] = False
    admin_disabled: Optional[bool] = False
    # ── Owner identity (populated for admin/manager listings) ─────────────
    owner_user_id: Optional[str] = None
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    # Linked users: non-owner users assigned by admin to see this email scraping
    linked_user_ids: Optional[List[str]] = None
    linked_users: Optional[List[Dict[str, Any]]] = None

class ExtractedEventOut(BaseModel):
    id: Optional[str] = None
    title: str
    event_type: str
    date: Optional[str] = None
    time: Optional[str] = None
    location: Optional[str] = None
    organizer: Optional[str] = None
    description: Optional[str] = None
    urgency: str = "medium"
    source_subject: str
    source_from: str
    source_date: str
    raw_snippet: Optional[str] = None
    email_account: Optional[str] = None
    save_category: Optional[str] = None   # "todo" | "reminder" | "visit"
    tm_app_no: Optional[str] = None       # TM Application Number
    # Keyword sync metadata — populated when the email was pulled because its
    # Subject matched one of the connection's `keywords`.
    matched_keywords: Optional[List[str]] = None
    auto_saved: Optional[bool] = False           # True = silently saved to reminders
    requires_confirmation: Optional[bool] = False # True = waiting in preview panel

class AutoSavePrefRequest(BaseModel):
    auto_save_reminders: bool
    auto_save_visits: bool
    auto_save_todos: bool = False
    scan_time_hour: int = 12
    scan_time_minute: int = 0

class AutoSavePrefOut(BaseModel):
    auto_save_reminders: bool
    auto_save_visits: bool
    auto_save_todos: bool = False
    scan_time_hour: int
    scan_time_minute: int
    next_scan_at: Optional[str] = None

class ManualSaveReminderRequest(BaseModel):
    # event_id is optional — manual reminders created from the Reminders page
    # (rather than from an Action Center email event) don't have one. When
    # omitted, the backend generates a synthetic id so dedup logic still works.
    event_id: Optional[str] = None
    title: str
    description: Optional[str] = None
    remind_at: str
    # Optional Trademark Hearing outcome fields — only stored when provided.
    brand_name: Optional[str] = None
    hearing_attended: Optional[str] = None     # "yes" | "no"
    hearing_decision: Optional[str] = None     # "favourable" | "unfavourable"
    hearing_adjourned: Optional[bool] = None
    hearing_next_date_disclosed: Optional[bool] = None  # only meaningful when hearing_adjourned is True
    hearing_notes: Optional[str] = None

class ManualSaveVisitRequest(BaseModel):
    event_id: str
    title: str
    visit_date: str
    notes: Optional[str] = None

class MarkEventSavedRequest(BaseModel):
    # Free-form label for what the event became — "task" from the Action
    # Center "Add Task" flow, or "reminder" | "todo" | "visit" if ever called
    # from elsewhere. Not restricted to an enum since new save types may be
    # added later without a backend change.
    category: str
    saved_id: Optional[str] = None

class SenderWhitelistEntry(BaseModel):
    email_address: str
    label: Optional[str] = None
    # Per-sender subject keyword filter (optional). Empty list = accept all subjects from this sender.
    keywords: Optional[List[str]] = None
    keyword_match_mode: Optional[str] = "or"          # "or" | "and"
    keyword_case_sensitive: Optional[bool] = False

class SenderWhitelistOut(BaseModel):
    senders: List[Dict[str, Any]]


# =============================================================================
# HELPERS — encryption
# =============================================================================

def _encrypt(plain: str) -> str:
    if _fernet:
        return _fernet.encrypt(plain.encode()).decode()
    if _EMAIL_ENCRYPTION_PRODUCTION:
        raise RuntimeError("Email credential encryption is unavailable in production.")
    return plain

def _decrypt(stored: str) -> str:
    if _fernet:
        try:
            return _fernet.decrypt(stored.encode()).decode()
        except Exception:
            # Legacy plaintext records can still be read during migration while
            # a valid production encryption key remains configured.
            return stored
    if _EMAIL_ENCRYPTION_PRODUCTION:
        raise RuntimeError("Email credential decryption is unavailable in production.")
    return stored

def _infer_provider(email_address: str):
    domain = email_address.split("@")[-1].lower()
    return PROVIDER_IMAP.get(domain, (f"imap.{domain}", 993, "other"))

def _clean_password(password: str) -> str:
    return password.replace(" ", "").strip()


# =============================================================================
# TEXT CLEANING
# =============================================================================

class _HTMLTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "p", "div", "br", "tr", "td", "th", "li", "ul", "ol",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "blockquote", "pre", "hr", "section", "article", "header",
        "footer", "table", "thead", "tbody", "tfoot",
    }
    SKIP_TAGS = {"script", "style", "head", "noscript", "iframe", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []
        self._skip_depth: int = 0

    def handle_starttag(self, tag: str, attrs):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str):
        if self._skip_depth > 0:
            return
        self._parts.append(data)

    def get_text(self) -> str:
        return "".join(self._parts)


def _html_to_text(html_content: str) -> str:
    if not html_content:
        return ""
    text = html.unescape(html_content)
    text = text.replace("\xa0", " ").replace("&nbsp;", " ")
    try:
        extractor = _HTMLTextExtractor()
        extractor.feed(text)
        text = extractor.get_text()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", text)
    lines = [line.strip() for line in text.splitlines()]
    cleaned: List[str] = []
    prev_blank = False
    for line in lines:
        is_blank = (line == "")
        if is_blank and prev_blank:
            continue
        cleaned.append(line)
        prev_blank = is_blank
    return "\n".join(cleaned).strip()


def _clean_text(text: str, max_chars: int = 0) -> str:
    if not text:
        return ""
    text = html.unescape(text)
    text = text.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    text  = "\n".join(lines).strip()
    if max_chars and len(text) > max_chars:
        text = text[:max_chars].rstrip()
    return text


# =============================================================================
# IP INDIA EMAIL PARSER
# =============================================================================

_MONTH_MAP = {
    "january": 1,  "february": 2,  "march": 3,    "april": 4,
    "may": 5,      "june": 6,      "july": 7,      "august": 8,
    "september": 9,"october": 10,  "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4,
    "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _extract_tm_app_no(text: str) -> Optional[str]:
    """
    Extract TM application number from text.
    Priority: explicit "No" prefix first → bare 7-digit fallback.
    """
    for pat in [
        r"Application\s+No\.?\s*(\d{5,9})",
        r"\bNo\.?\s*(\d{5,9})(?:\s|$|[^\d])",
        r"Application\s+Number\s*[:\-]?\s*(\d{5,9})",
        r"App(?:lication)?\s*#\s*(\d{5,9})",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            candidate = m.group(1)
            if 5 <= len(candidate) <= 9:
                return candidate

    for m in re.finditer(r"\b(\d{7})\b", text):
        return m.group(1)

    for m in re.finditer(r"\b(\d{5,9})\b", text):
        candidate = m.group(1)
        if 2000 <= int(candidate) <= 2099:
            continue
        return candidate

    return None


def _parse_date_from_text(text: str) -> Optional[str]:
    """Extract first plausible date from text. Returns 'YYYY-MM-DD' or None."""
    for m in re.finditer(r"\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b", text):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= d <= 31 and 2020 <= y <= 2035:
            try:
                return datetime(y, mo, d).strftime("%Y-%m-%d")
            except ValueError:
                continue

    for m in re.finditer(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})\b",
        text, re.IGNORECASE
    ):
        d, mo_str, y = int(m.group(1)), m.group(2).lower(), int(m.group(3))
        mo = _MONTH_MAP.get(mo_str)
        if mo and 1 <= d <= 31 and 2020 <= y <= 2035:
            try:
                return datetime(y, mo, d).strftime("%Y-%m-%d")
            except ValueError:
                continue

    for m in re.finditer(
        r"\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b",
        text, re.IGNORECASE
    ):
        mo_str, d, y = m.group(1).lower(), int(m.group(2)), int(m.group(3))
        mo = _MONTH_MAP.get(mo_str)
        if mo and 1 <= d <= 31 and 2020 <= y <= 2035:
            try:
                return datetime(y, mo, d).strftime("%Y-%m-%d")
            except ValueError:
                continue

    return None


def _extract_tm_class(text: str) -> Optional[str]:
    """Extract trademark class number from subject/body."""
    for pat in [
        r"in\s+class\s+(\d{1,2})\b",
        r"(?:class|वर्ग)\s*(?:no\.?)?\s*(\d{1,2})\b",
        r"वर्ग\s*/\s*in\s+class\s+(\d{1,2})\b",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def _is_adjournment(subject: str, body: str) -> bool:
    combined = (subject + " " + body[:600]).lower()
    return any(kw in combined for kw in [
        "adjourned", "adjournment", "rescheduled", "reschedule",
        "new date", "revised date", "postponed", "new hearing date",
        "hearing rescheduled", "changed to",
    ])


def _get_reminder_sequence(subject: str) -> int:
    """Returns 0=original, 1=Reminder-I, 2=Reminder-II, 3=Reminder-III …"""
    m = re.search(r"Reminder[-\s]*(I{1,3}|IV|V?\d*)", subject, re.IGNORECASE)
    if not m:
        return 0
    roman_map = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5}
    return roman_map.get(m.group(1).upper(), 1)


class _IPIndiaResult:
    __slots__ = [
        "event_type", "tm_app_no", "tm_class",
        "event_date",
        "reply_deadline",
        "new_date",
        "title", "description", "urgency", "save_category",
        "reminder_seq", "is_adjournment",
    ]
    def __init__(self):
        for a in self.__slots__:
            setattr(self, a, None)
        self.reminder_seq   = 0
        self.is_adjournment = False


def _parse_ipindia_email(subject: str, body: str, msg_date: str) -> Optional["_IPIndiaResult"]:
    """
    Parse an IP India (noreply.tmr@gov.in) email with precision.
    Handles: Hearing Notices, Examination Reports, Reminder-I/II/III,
    and Adjournment emails.
    """
    r = _IPIndiaResult()
    subj_lower  = subject.lower()
    body_lower  = body.lower()
    full_lower  = subj_lower + " " + body_lower[:800]

    is_hearing = (
        "hearing notice" in subj_lower
        or ("hearing" in subj_lower and "application" in subj_lower
            and "examination" not in subj_lower)
    )
    is_exam_report = (
        "examination report" in subj_lower
        or "परीक्षा रिपोर्ट" in subject
        or ("examination report" in body_lower[:400] and "reply" not in subj_lower)
    )
    is_reminder_for_exam = (
        re.search(r"reminder[-\s]*(i{1,3}|iv|v?\d*)", subj_lower) is not None
        and any(kw in subj_lower for kw in ["examination", "reply", "response", "report"])
    )
    is_adjournment = _is_adjournment(subject, body)

    if is_reminder_for_exam:
        is_exam_report = True
        is_hearing     = False

    if not is_hearing and not is_exam_report:
        return None

    r.tm_app_no = (
        _extract_tm_app_no(subject)
        or _extract_tm_app_no(body[:800])
    )
    if not r.tm_app_no:
        return None

    r.tm_class     = _extract_tm_class(subject) or _extract_tm_class(body[:400])
    r.reminder_seq = _get_reminder_sequence(subject)
    r.is_adjournment = is_adjournment

    class_sfx     = f" (Class {r.tm_class})" if r.tm_class else ""
    is_show_cause = "show cause" in full_lower

    # ── PATH 1: HEARING NOTICE ─────────────────────────────────────────────
    if is_hearing:
        r.event_type = "Trademark Hearing"

        sched_m = re.search(
            r"scheduled\s+on\s+(\d{1,2}[-/]\d{1,2}[-/]\d{4})",
            body, re.IGNORECASE
        )
        if sched_m:
            r.event_date = _parse_date_from_text(sched_m.group(1))
        if not r.event_date:
            r.event_date = _parse_date_from_text(body[:1200])
        if not r.event_date:
            r.event_date = _parse_date_from_text(subject)
        if not r.event_date and msg_date:
            r.event_date = _parse_date_from_text(msg_date)

        if is_adjournment:
            new_m = re.search(
                r"(?:new|revised|rescheduled|adjourned\s+to|postponed\s+to)"
                r"\s+(?:date\s+is\s+)?(\d{1,2}[-/]\d{1,2}[-/]\d{4})",
                body, re.IGNORECASE
            )
            if new_m:
                r.new_date = _parse_date_from_text(new_m.group(1))
            else:
                all_dates = [
                    _parse_date_from_text(m.group(0))
                    for m in re.finditer(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b", body)
                ]
                valid_dates = sorted([d for d in all_dates if d])
                r.new_date = valid_dates[-1] if valid_dates else r.event_date

            r.event_type  = "Adjournment"
            display_date  = r.new_date or "see notice"
            r.title       = f"Adjourned: Hearing — TM App No. {r.tm_app_no}{class_sfx}"
            r.description = (
                f"Hearing for TM Application No. {r.tm_app_no}{class_sfx} has been "
                f"adjourned. New hearing date: {display_date}."
            )
            r.urgency       = "high"
            r.save_category = "reminder"
        else:
            sc_note = " (Show Cause)" if is_show_cause else ""
            r.title = f"Trademark Hearing{sc_note} — TM App No. {r.tm_app_no}{class_sfx}"
            r.description = (
                f"Hearing scheduled on {r.event_date or 'date in notice'} "
                f"for TM Application No. {r.tm_app_no}{class_sfx}."
                + (" Show Cause hearing — attendance mandatory." if is_show_cause else "")
                + " Issued by Registrar of Trade Marks (IP India)."
            )
            r.urgency       = "high"
            r.save_category = "reminder"

    # ── PATH 2: EXAMINATION REPORT ─────────────────────────────────────────
    elif is_exam_report:
        r.event_type = "Examination Report"

        dated_m = re.search(
            r"dated\s+(\d{1,2}[-/]\d{1,2}[-/]\d{4})",
            subject + " " + body[:400], re.IGNORECASE
        )
        if dated_m:
            r.event_date = _parse_date_from_text(dated_m.group(1))
        if not r.event_date:
            r.event_date = _parse_date_from_text(body[:1200])
        if not r.event_date and msg_date:
            r.event_date = _parse_date_from_text(msg_date)
        if not r.event_date:
            r.event_date = datetime.now(IST).strftime("%Y-%m-%d")

        try:
            issue_dt         = datetime.strptime(r.event_date, "%Y-%m-%d")
            r.reply_deadline = (issue_dt + timedelta(days=30)).strftime("%Y-%m-%d")
        except Exception:
            r.reply_deadline = None

        r.urgency = {0: "medium", 1: "medium", 2: "high", 3: "high"}.get(
            r.reminder_seq, "high"
        )

        roman_labels = {0: "", 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V"}
        if r.reminder_seq > 0:
            seq_lbl = roman_labels.get(r.reminder_seq, str(r.reminder_seq))
            r.title = (
                f"Reminder-{seq_lbl}: Reply to Examination Report — "
                f"TM App No. {r.tm_app_no}{class_sfx}"
            )
            r.description = (
                f"Reminder-{seq_lbl} — Reply to Examination Report for "
                f"TM Application No. {r.tm_app_no}{class_sfx}. "
                f"Deadline to file response: {r.reply_deadline or '30 days from issue date'}."
            )
        else:
            r.title = f"Examination Report — TM App No. {r.tm_app_no}{class_sfx}"
            r.description = (
                f"Examination Report issued on {r.event_date} for "
                f"TM Application No. {r.tm_app_no}{class_sfx}. "
                f"Objections raised under Trade Marks Act 1999. "
                f"File response by {r.reply_deadline or 'N/A'} (30-day deadline)."
            )

        r.save_category = "todo"

    return r


# =============================================================================
# SMART CATEGORY CLASSIFIER
# =============================================================================

_TODO_KEYWORDS = [
    "examination report", "office action", "objection raised",
    "reply to examination", "response required", "compliance notice",
    "show cause notice", "response to show cause", "notice to file",
    "deadline to respond", "reply required", "reply within",
    "opposition notice", "counter statement", "file reply",
    "scrutiny notice", "demand notice",
]
_REMINDER_KEYWORDS = [
    "hearing", "show cause hearing", "trademark hearing",
    "gstr-1", "gstr-3b", "gstr-9", "gst filing", "gst return",
    "income tax", "itr", "advance tax", "tds return",
    "roc filing", "mca", "aoc-4", "mgt-7",
    "court date", "nclt", "high court", "tribunal",
    "ip india", "ipindia", "due date", "last date", "filing date",
]
_VISIT_KEYWORDS = [
    "zoom", "google meet", "teams meeting", "microsoft teams",
    "webex", "meeting invite", "meeting scheduled",
    "visit scheduled", "office visit", "client visit",
    "appointment", "meeting at", "conference call", "video call",
]

def _classify_save_category(event_type: str, title: str, body: str) -> str:
    combined = f"{title} {body}".lower()
    for kw in _TODO_KEYWORDS:
        if kw in combined:
            return "todo"
    for kw in _VISIT_KEYWORDS:
        if kw in combined:
            return "visit"
    for kw in _REMINDER_KEYWORDS:
        if kw in combined:
            return "reminder"
    if event_type in ("Court Hearing", "Trademark Hearing", "Deadline"):
        return "reminder"
    if event_type in ("Visit", "Online Meeting", "Conference"):
        return "visit"
    return "reminder"


# =============================================================================
# WHITELIST HELPERS
# =============================================================================

def _normalize_whitelist_entry(entry: str) -> str:
    return entry.strip().lower()

def _sender_matches_whitelist(sender_email: str, whitelist: List[str]) -> bool:
    sender_lower = sender_email.strip().lower()
    for entry in whitelist:
        entry = _normalize_whitelist_entry(entry)
        if not entry:
            continue
        if entry.startswith("@"):
            domain_part = entry[1:]
            if sender_lower.endswith("@" + domain_part) or sender_lower.endswith("." + domain_part):
                return True
        else:
            if sender_lower == entry:
                return True
    return False


# =============================================================================
# IMAP HELPERS
# =============================================================================

def _test_imap_sync(host: str, port: int, email_addr: str, password: str) -> Optional[str]:
    try:
        password = _clean_password(password)
        conn = imaplib.IMAP4_SSL(host, int(port))
        conn.login(email_addr, password)
        conn.logout()
        return None
    except imaplib.IMAP4.error as e:
        return (
            f"IMAP login failed: {e}. Make sure: (1) IMAP is enabled in Gmail Settings, "
            "(2) You are using an App Password, (3) 2-Step Verification is enabled."
        )
    except ConnectionRefusedError:
        return f"Could not connect to {host}:{port} — connection refused."
    except OSError as e:
        return f"Network error connecting to {host}:{port} — {e}"
    except Exception as e:
        return f"Unexpected error: {type(e).__name__}: {e}"

def _decode_header_str(raw: str) -> str:
    if not raw:
        return ""
    try:
        parts = email.header.decode_header(raw)
        out = []
        for part, charset in parts:
            if isinstance(part, bytes):
                out.append(part.decode(charset or "utf-8", errors="replace"))
            else:
                out.append(str(part))
        return " ".join(out)
    except Exception:
        return str(raw)

def _decode_part_payload(part: email.message.Message) -> str:
    try:
        raw_bytes = part.get_payload(decode=True)
        if raw_bytes is None:
            return ""
        charset = part.get_content_charset()
        if charset:
            try:
                return raw_bytes.decode(charset, errors="replace")
            except (LookupError, UnicodeDecodeError):
                pass
        for enc in ("utf-8", "latin-1", "windows-1252", "ascii"):
            try:
                return raw_bytes.decode(enc, errors="strict")
            except (UnicodeDecodeError, LookupError):
                continue
        return raw_bytes.decode("utf-8", errors="replace")
    except Exception:
        return ""

def _get_plain_body(msg: email.message.Message, max_chars: int = 4000) -> str:
    """
    Extract clean plain-text body.
    Priority: text/plain → text/html (stripped) → raw payload
    """
    plain_parts: List[str] = []
    html_parts:  List[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp  = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            if ctype == "text/plain":
                decoded = _decode_part_payload(part)
                if decoded.strip():
                    plain_parts.append(decoded)
            elif ctype == "text/html":
                decoded = _decode_part_payload(part)
                if decoded.strip():
                    html_parts.append(decoded)
    else:
        decoded = _decode_part_payload(msg)
        if msg.get_content_type() == "text/html":
            html_parts.append(decoded)
        else:
            plain_parts.append(decoded)

    if plain_parts:
        body = _clean_text("\n\n".join(plain_parts))
    elif html_parts:
        body = _clean_text(_html_to_text("\n".join(html_parts)))
    else:
        body = ""

    if max_chars and len(body) > max_chars:
        body = body[:max_chars].rstrip() + "…"
    return body

def _extract_sender_email(from_header: str) -> str:
    m = re.search(r'<([^>]+)>', from_header)
    if m:
        return m.group(1).strip().lower()
    return from_header.strip().lower()

def _parse_email_received_at(date_header: str) -> datetime:
    """Parse RFC email Date header to UTC; fall back to now if malformed."""
    try:
        parsed = email.utils.parsedate_to_datetime(date_header or "")
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)

def _imap_since_from_dt(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%d-%b-%Y")

def _stable_message_id(email_addr: str, raw: Dict) -> str:
    """Return Message-ID, or a deterministic fallback for messages without one."""
    mid = (raw.get("message_id") or "").strip()
    if mid:
        return mid
    import hashlib
    fingerprint = "|".join([
        email_addr.lower(),
        raw.get("uid") or "",
        raw.get("msg_date") or "",
        raw.get("from_addr") or "",
        raw.get("subject") or "",
    ])
    return "fallback-" + hashlib.sha256(fingerprint.encode("utf-8", "ignore")).hexdigest()

def _scan_mailbox_sync(
    host: str, port: int, email_addr: str, password: str,
    max_msgs: int = 50, sender_whitelist: Optional[List[str]] = None,
    since_date: Optional[str] = None,
    keywords: Optional[List[str]] = None,
    keyword_match_mode: str = "or",
    keyword_case_sensitive: bool = False,
) -> List[Dict]:
    """
    since_date: IMAP-format date string "dd-Mon-yyyy" (e.g. "01-Jan-2025").
    When provided, searches SINCE that date instead of "ALL" — this is what
    powers retrospective syncing of mail older than the normal rolling window.
    max_msgs: caps how many matched messages are fetched. Pass 0 to fetch
    everything matched by the search (used for retrospective scans, capped
    upstream instead).

    keywords: when given, the mailbox is searched by SUBJECT for these terms
    (in addition to any since_date). `keyword_match_mode` controls whether
    matches require ANY ("or") or ALL ("and") keywords. IMAP's SUBSTRING
    SEARCH is case-insensitive by spec; if `keyword_case_sensitive` is True
    a second client-side filter is applied to enforce exact case.

    Returned dicts include a `matched_keywords` list — the exact keywords
    that hit each subject (empty when no keyword filter is active).
    """
    results = []
    cleaned_keywords = [k.strip() for k in (keywords or []) if k and k.strip()]
    mode = (keyword_match_mode or "or").lower()
    if mode not in ("or", "and"):
        mode = "or"
    try:
        password = _clean_password(password)
        conn = imaplib.IMAP4_SSL(host, int(port))
        conn.login(email_addr, password)
        conn.select("INBOX", readonly=True)

        # Build the IMAP search criteria. SINCE and SUBJECT clauses can be
        # combined; AND is implicit in IMAP (space-separated criteria), OR
        # is an explicit binary operator that must be chained for >2 terms.
        def _build_subject_criteria(terms: List[str], join: str) -> str:
            quoted = [f'SUBJECT "{t}"' for t in terms]
            if join == "and" or len(quoted) == 1:
                return " ".join(quoted)
            # OR is binary in IMAP — nest right-associatively:  OR a (OR b c)
            expr = quoted[-1]
            for q in reversed(quoted[:-1]):
                expr = f"OR {q} ({expr})"
            return expr

        criteria_parts = []
        if since_date:
            criteria_parts.append(f'SINCE "{since_date}"')
        if cleaned_keywords:
            criteria_parts.append(_build_subject_criteria(cleaned_keywords, mode))
        if criteria_parts:
            criteria = "(" + " ".join(criteria_parts) + ")"
            _, data = conn.search(None, criteria)
        else:
            _, data = conn.search(None, "ALL")
        if not data or not data[0]:
            conn.logout()
            return results
        ids = data[0].split()
        if max_msgs:
            ids = ids[-max_msgs:]
        for msg_id in reversed(ids):
            try:
                _, msg_data = conn.fetch(msg_id, "(RFC822)")
                if not msg_data or not msg_data[0]:
                    continue
                msg          = email.message_from_bytes(msg_data[0][1])
                msg_uid      = msg_id.decode(errors="ignore") if isinstance(msg_id, bytes) else str(msg_id)
                from_raw     = _decode_header_str(msg.get("From", ""))
                sender_clean = _extract_sender_email(from_raw)
                if sender_whitelist:
                    if not _sender_matches_whitelist(sender_clean, sender_whitelist):
                        continue
                subject_clean = _clean_text(_decode_header_str(msg.get("Subject", "")), 200)
                matched = []
                if cleaned_keywords:
                    hay = subject_clean if keyword_case_sensitive else subject_clean.lower()
                    for kw in cleaned_keywords:
                        needle = kw if keyword_case_sensitive else kw.lower()
                        if needle and needle in hay:
                            matched.append(kw)
                    # Enforce mode client-side too — IMAP's SUBJECT search is
                    # always case-insensitive, so AND / case-sensitive filters
                    # may legitimately drop results the server returned.
                    if mode == "and" and len(matched) != len(cleaned_keywords):
                        continue
                    if mode == "or" and not matched:
                        continue
                results.append({
                    "subject":          subject_clean,
                    "from_addr":        from_raw,
                    "sender_email":     sender_clean,
                    "msg_date":         msg.get("Date", ""),
                    "body":             _get_plain_body(msg, max_chars=4000),
                    "message_id":       (msg.get("Message-ID") or "").strip(),
                    "uid":              msg_uid,
                    "received_at":      _parse_email_received_at(msg.get("Date", "")).isoformat(),
                    "matched_keywords": matched,
                })
            except Exception:
                continue
        conn.logout()
    except Exception as e:
        logger.error(f"IMAP scan error for {email_addr}: {e}")
    return results


# =============================================================================
# AI EXTRACTION  (generic fallback after IP India parser)
# =============================================================================

_AI_SYSTEM = """
You are a specialized legal and tax assistant for a CA/CS/Legal firm in India.
Extract ONLY professional/legal events from the email. Be VERY strict.

STRICT RULES:
1. FOCUS ONLY ON:
   - Trademark hearings, notices, examination reports, show cause notices (IP India)
   - Court hearings (NCLT, High Court, Supreme Court, any tribunal)
   - ROC compliance deadlines (MCA21, annual filing, AOC-4, MGT-7)
   - GST deadlines (GSTR-1, GSTR-3B, GSTR-9, GST notices)
   - Income Tax deadlines (ITR filing, advance tax, notices from IT dept)
   - Client visits or scheduled meetings with clients
   - Online meetings (Zoom, Google Meet, Teams)
   - Examination reports / office actions requiring reply

2. STRICTLY DISCARD — return [] for junk:
   - Jio/Airtel/Vi bills, OTPs, bank alerts, Adobe/Canva subscriptions
   - Marketing, newsletters, LinkedIn/social media, e-commerce notifications
   - Any email NOT related to CA/CS/Legal firm work

3. DATES: If year is missing assume 2026.

4. Return ONLY a valid JSON array. No markdown, no preamble.
   Keys: title, event_type (Trademark Hearing|Court Hearing|Online Meeting|
   Deadline|Visit|Other|Examination Report|Notice), date (yyyy-MM-dd|null),
   time (HH:mm|null), organizer (string|null),
   description (plain text, max 150 chars), urgency (high|medium|low)

5. Junk/irrelevant → return exactly: []
"""

_JUNK_KEYWORDS = [
    "jio", "airtel", "vodafone", "vi mobile", "bsnl", "tata sky",
    "payment received", "payment successful", "transaction successful",
    "transaction alert", "otp", "one time password",
    "credit card statement", "bank statement", "debited", "credited",
    "adobe", "canva", "figma", "coursera", "udemy",
    "discount", "exclusive offer", "flash sale", "cashback",
    "linkedin", "facebook", "instagram", "twitter", "youtube",
    "job application", "resume", "unsubscribe", "newsletter", "promotional",
    "amazon", "flipkart", "swiggy", "zomato", "uber", "ola",
    "nykaa", "myntra", "meesho", "bigbasket",
]

async def _get_dismissed_titles(user_id: str) -> Set[str]:
    try:
        docs = await db["reminders"].find(
            {"user_id": user_id, "is_dismissed": True}, {"_id": 0, "title": 1}
        ).to_list(500)
        return {d["title"].lower().strip() for d in docs if d.get("title")}
    except Exception:
        return set()


# =============================================================================
# SAVED-EVENT TRACKING (Action Center dedup fix)
# =============================================================================
# Problem this section fixes:
#   Once a user saved an Action Center event as a Reminder / Todo / Visit /
#   Task, the underlying cached event record in `email_extracted_events` was
#   never flagged. So the very next sync (or even the next normal page load)
#   fetched that same record again and displayed it as if it had never been
#   saved — because nothing on the backend remembered the save had happened.
#
#   Two things are fixed:
#   1. `_mark_event_saved` stamps the source event document with
#      saved_category / saved_id / saved_at as soon as a save succeeds
#      (see save_as_reminder / save_as_todo / save_as_visit / mark_event_saved).
#   2. `_get_saved_event_ids` cross-checks the reminders / todos / visits
#      collections directly (the "respective pages") so an event is hidden
#      from the Action Center even if it was saved from one of those pages
#      instead of the Action Center itself, or if it predates this fix.
# =============================================================================

async def _mark_event_saved(user_id: str, event_id: Optional[str], category: str, saved_id: str = "") -> None:
    """Stamp the source `email_extracted_events` document as saved, so it is
    excluded from every future Action Center sync. Safe to call repeatedly."""
    if not event_id:
        return
    query: Dict[str, Any] = {"user_id": user_id}
    try:
        query["_id"] = ObjectId(event_id)
    except Exception:
        # Not a valid ObjectId (e.g. legacy/manual synthetic id) — try the
        # string "id" field instead, in case a migration ever backfills it.
        query["id"] = event_id
    try:
        await db[COL_EVENTS].update_one(
            query,
            {"$set": {
                "saved_category": category,
                "saved_id":       saved_id or "",
                "saved_at":       datetime.now(timezone.utc).isoformat(),
            }}
        )
    except Exception as e:
        logger.warning(f"_mark_event_saved failed for event_id={event_id}: {e}")


async def _get_saved_event_ids(user_id: str) -> Set[str]:
    """Union of `event_id` values already present in reminders / todos /
    visits for this user. Lets the Action Center hide an event even when it
    was saved directly from the Reminders / To-Do / Visits page (not via the
    Action Center's own Save button), or before saved_category existed."""
    ids: Set[str] = set()
    for col in ("reminders", "todos", "visits"):
        try:
            docs = await db[col].find(
                {"user_id": user_id, "event_id": {"$exists": True, "$ne": None}},
                {"_id": 0, "event_id": 1}
            ).to_list(5000)
            ids.update(d["event_id"] for d in docs if d.get("event_id"))
        except Exception:
            pass
    return ids


async def _extract_events_from_email(
    subject: str, body: str, from_addr: str, msg_date: str,
    dismissed_titles: Optional[Set[str]] = None,
) -> List[Dict]:
    """
    Extraction pipeline (priority order):
      1. IP India dedicated parser   → precise structured result
      2. Google Gemini AI            → general legal events
      3. Regex fallback              → last resort
    """
    sender_clean = _extract_sender_email(from_addr)
    combined     = f"{subject.lower()} {body.lower()[:500]}"

    for kw in _JUNK_KEYWORDS:
        if kw in combined:
            return []

    if dismissed_titles and subject.lower().strip() in dismissed_titles:
        return []

    # ── 1. IP India parser ────────────────────────────────────────────────────
    _IPINDIA_SENDER_PATTERNS = (
        "noreply.tmr",
        "tmr.gov.in",
        "ipindia",
        "trademarks.gov.in",
    )
    is_ipindia = any(pat in sender_clean for pat in _IPINDIA_SENDER_PATTERNS)

    if not is_ipindia:
        subj_l = subject.lower()
        is_ipindia = (
            ("hearing notice" in subj_l and "application no" in subj_l)
            or "examination report" in subj_l
            or "परीक्षा रिपोर्ट" in subject
            or (re.search(r"reminder[-\s]*(i{1,3}|iv)", subj_l) and "examination" in subj_l)
        )

    if is_ipindia:
        r = _parse_ipindia_email(subject, body, msg_date)
        if r:
            if r.is_adjournment and r.new_date:
                ev_date = r.new_date
            elif r.save_category == "todo":
                ev_date = r.reply_deadline
            else:
                ev_date = r.event_date

            ev = {
                "title":          r.title,
                "event_type":     r.event_type,
                "date":           ev_date,
                "time":           None,
                "organizer":      "IP India / Trade Marks Registry",
                "description":    r.description,
                "urgency":        r.urgency,
                "save_category":  r.save_category,
                "tm_app_no":      r.tm_app_no,
                "tm_class":       r.tm_class,
                "reminder_seq":   r.reminder_seq,
                "is_adjournment": r.is_adjournment,
                "raw_event_date": r.event_date,
                "reply_deadline": r.reply_deadline,
            }
            logger.info(
                f"[IPIndia] {r.event_type} App#{r.tm_app_no} "
                f"date={ev_date} seq={r.reminder_seq} adj={r.is_adjournment}"
            )
            return [ev]

    # ── 2. Gemini AI ──────────────────────────────────────────────────────────
    if _gemini:
        try:
            prompt = (
                f"{_AI_SYSTEM}\n\nFrom: {from_addr}\nSubject: {subject}\n"
                f"Body (plain text):\n{body[:3000]}"
            )
            resp   = await _gemini.generate_content_async(prompt)
            raw    = re.sub(r"```[a-z]*\n?|```", "", resp.text.strip())
            result = json.loads(raw)
            if isinstance(result, list):
                out = []
                for ev in result:
                    desc = ev.get("description") or ""
                    ev["description"]    = _clean_text(_html_to_text(desc) if "<" in desc else desc, 200)
                    ev["save_category"]  = _classify_save_category(ev.get("event_type",""), subject, body)
                    ev["tm_app_no"]      = _extract_tm_app_no(subject) or _extract_tm_app_no(body[:600])
                    ev["is_adjournment"] = False
                    ev["reminder_seq"]   = 0
                    out.append(ev)
                return out
        except Exception as e:
            logger.warning(f"Gemini failed for '{subject[:50]}': {e}")

    # ── 3. Regex fallback ─────────────────────────────────────────────────────
    return _regex_extract(subject, body, from_addr)


def _regex_extract(subject: str, body: str, from_addr: str) -> List[Dict]:
    text = f"{subject} {body}".lower()
    if any(j in text for j in ["offer", "discount", "otp", "statement",
                                 "transaction successful", "payment received",
                                 "jio", "airtel", "adobe", "newsletter",
                                 "unsubscribe", "cashback"]):
        return []

    date_str = _parse_date_from_text(body[:1200]) or _parse_date_from_text(subject)
    if not date_str:
        return []

    if any(w in text for w in ["trademark","ipindia","ip india","opposition","show cause"]):
        etype = "Trademark Hearing"
    elif any(w in text for w in ["court","nclt","tribunal","hearing","high court"]):
        etype = "Court Hearing"
    elif any(w in text for w in ["examination report","office action","objection"]):
        etype = "Examination Report"
    elif any(w in text for w in ["gst","gstr","income tax","itr","roc","mca","advance tax"]):
        etype = "Deadline"
    elif "visit" in text:
        etype = "Visit"
    else:
        etype = "Deadline"

    return [{
        "title":          subject[:100],
        "event_type":     etype,
        "date":           date_str,
        "time":           None,
        "organizer":      from_addr[:50],
        "description":    _clean_text(body[:200], 200),
        "urgency":        "high",
        "save_category":  _classify_save_category(etype, subject, body),
        "tm_app_no":      _extract_tm_app_no(subject) or _extract_tm_app_no(body[:600]),
        "is_adjournment": False,
        "reminder_seq":   0,
    }]


# =============================================================================
# MONGO DOC → PYDANTIC
# =============================================================================

def _doc_to_out(doc: Dict) -> ExtractedEventOut:
    # FIX: Prefer string "id" field; fall back to str(_id) for auto-saved docs
    # that were inserted before v9 (which had no string id field).
    raw_id = doc.get("id") or doc.get("_id")
    str_id = str(raw_id) if raw_id is not None else ""
    return ExtractedEventOut(
        id=str_id,
        title=doc.get("title", ""),
        event_type=doc.get("event_type", "Other"),
        date=doc.get("date"),
        time=doc.get("time"),
        location=doc.get("location"),
        organizer=doc.get("organizer"),
        description=doc.get("description"),
        urgency=doc.get("urgency", "medium"),
        source_subject=doc.get("source_subject", ""),
        source_from=doc.get("source_from", ""),
        source_date=doc.get("source_date", ""),
        raw_snippet=doc.get("raw_snippet"),
        email_account=doc.get("email_account"),
        save_category=doc.get("save_category"),
        tm_app_no=doc.get("tm_app_no"),
        matched_keywords=doc.get("matched_keywords") or [],
        auto_saved=doc.get("auto_saved", False),
        requires_confirmation=doc.get("requires_confirmation", False),
    )

def _conn_doc_to_out(doc: Dict) -> ConnectionOut:
    return ConnectionOut(
        email_address=doc.get("email_address", ""),
        imap_host=doc.get("imap_host", ""),
        imap_port=doc.get("imap_port", 993),
        label=doc.get("label"),
        provider=doc.get("provider", "other"),
        is_active=doc.get("is_active", True),
        last_synced=doc.get("last_synced"),
        connected_at=doc.get("connected_at"),
        sync_error=doc.get("sync_error"),
        linked_page=doc.get("linked_page", "all"),
        auto_sync=doc.get("auto_sync", False),
        keywords=doc.get("keywords") or [],
        keyword_match_mode=doc.get("keyword_match_mode", "or"),
        keyword_case_sensitive=doc.get("keyword_case_sensitive", False),
        keyword_auto_save=doc.get("keyword_auto_save", True),
        admin_paused=doc.get("admin_paused", False),
        admin_disabled=doc.get("admin_disabled", False),
        owner_user_id=str(doc["user_id"]) if doc.get("user_id") else None,
        owner_name=doc.get("owner_name"),
        owner_email=doc.get("owner_email"),
        linked_user_ids=doc.get("linked_user_ids") or [],
        linked_users=doc.get("linked_users") or [],
    )

# =============================================================================
# FIX v9: _reminder_to_dict — always resolves string id for GET /reminders
# =============================================================================
# ROOT CAUSE OF "Cannot delete: reminder ID is missing":
#   Auto-saved reminders inserted by _auto_save_event (v8 and earlier) had no
#   string "id" field — only MongoDB ObjectId "_id". The GET /reminders route
#   was serializing docs without always including a string id, so the frontend
#   resolveId() received undefined and could not construct the DELETE URL.
#
# FIX: _reminder_to_dict always resolves id = str(doc["id"]) if present,
#   else falls back to str(doc["_id"]). Both the "id" field AND a legacy "_id"
#   field are included in every response so the frontend triple-fallback works.
# =============================================================================

def _reminder_to_dict(doc: Dict) -> Dict:
    """
    Serialize a reminders collection document to a dict safe for API responses.
    Always includes a non-empty string "id" field — resolves from:
      1. doc["id"]  (string uuid, set by v9 inserts and migrate-fix-ids)
      2. str(doc["_id"])  (MongoDB ObjectId fallback for pre-v9 docs)
    """
    raw_id = doc.get("id") or doc.get("_id")
    str_id = str(raw_id) if raw_id is not None else ""
    return {
        "id":                str_id,
        "_id":               str_id,   # legacy field — kept so any old frontend code still works
        "user_id":           doc.get("user_id", ""),
        "title":             doc.get("title", ""),
        "description":       doc.get("description"),
        "remind_at":         doc.get("remind_at"),
        "is_dismissed":      doc.get("is_dismissed", False),
        "source":            doc.get("source"),
        "event_id":          doc.get("event_id"),
        "tm_app_no":         doc.get("tm_app_no"),
        "urgency":           doc.get("urgency", "medium"),
        "created_at":        doc.get("created_at"),
        # Trademark Hearing outcome fields — read through so the frontend
        # (and the duplicate-completeness scoring) sees the full record,
        # not just title/date.
        "brand_name":        doc.get("brand_name"),
        "hearing_attended":  doc.get("hearing_attended"),
        "hearing_decision":  doc.get("hearing_decision"),
        "hearing_adjourned": doc.get("hearing_adjourned"),
        "hearing_next_date_disclosed": doc.get("hearing_next_date_disclosed"),
        "hearing_notes":     doc.get("hearing_notes"),
    }


# =============================================================================
# REMINDER DUPLICATE DETECTION
# =============================================================================
# These helpers read EVERY relevant parameter of a reminder — not just its
# title or event_id — to decide whether two reminder documents represent the
# same real-world reminder:
#   • tm_app_no    (strongest signal — the official IP-India application no.)
#   • title        (fuzzy-matched, so "TM App No. 6384945" and "TM Application
#                    No. 6384945" are still recognised as the same thing)
#   • remind_at    (two hearings on the same TM number 30 days apart are NOT
#                    the same reminder, so proximity in time is required too)
#   • description  (used as a tie-breaker signal when nothing else decides it)
# =============================================================================

def _normalize_title_for_dedup(title: str) -> str:
    """Lowercase, strip punctuation/extra whitespace so near-identical
    titles ("TM App No. 6384945" vs "TM Application No 6384945") compare
    the same way."""
    t = (title or "").lower().strip()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _title_similarity(a: str, b: str) -> float:
    """0.0–1.0 fuzzy similarity between two reminder titles."""
    na, nb = _normalize_title_for_dedup(a), _normalize_title_for_dedup(b)
    if not na or not nb:
        return 0.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def _parse_dt_safe(iso_str: Optional[str]) -> Optional[datetime]:
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(str(iso_str).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _dates_close(a_iso: Optional[str], b_iso: Optional[str], hours: float = 36) -> bool:
    """True when both timestamps parse and land within `hours` hours of each other."""
    da, db_ = _parse_dt_safe(a_iso), _parse_dt_safe(b_iso)
    if not da or not db_:
        return False
    return abs((da - db_).total_seconds()) <= hours * 3600


def _reminders_are_duplicate(a: Dict, b: Dict) -> bool:
    """
    Read every relevant parameter of both reminders and decide whether they
    describe the same underlying reminder. Returns True only when the
    combined evidence (tm_app_no + title + date + description) makes that
    very likely, so legitimately distinct reminders are never merged.
    """
    if not a or not b:
        return False
    if str(a.get("id") or a.get("_id")) == str(b.get("id") or b.get("_id")):
        return False

    tm_a = (a.get("tm_app_no") or "").strip().lower()
    tm_b = (b.get("tm_app_no") or "").strip().lower()
    title_sim = _title_similarity(a.get("title", ""), b.get("title", ""))
    desc_sim = _title_similarity(a.get("description", "") or "", b.get("description", "") or "")
    same_window = _dates_close(a.get("remind_at"), b.get("remind_at"), hours=36)

    # Strongest signal: identical official TM application number, and the
    # reminders are scheduled within the same short window of time.
    if tm_a and tm_b and tm_a == tm_b and same_window:
        return True

    # One side is missing a tm_app_no (e.g. a manually-created reminder that
    # never had it parsed) — fall back to a very high title match instead.
    if (tm_a or tm_b) and title_sim >= 0.92 and same_window:
        return True

    # Neither side has a tm_app_no at all — require strong title AND date
    # agreement (a high description match raises confidence further).
    if not tm_a and not tm_b and title_sim >= 0.82 and same_window:
        if title_sim >= 0.95 or desc_sim >= 0.7 or (a.get("description") is None and b.get("description") is None):
            return True

    return False


def _pair_key(id_a: str, id_b: str) -> str:
    return "|".join(sorted([str(id_a), str(id_b)]))


class _DisjointSet:
    """Tiny union-find used to cluster reminders into duplicate groups."""
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[ry] = rx


async def _find_existing_duplicate(user_id: str, candidate: Dict, ignored_pairs: Optional[Set[str]] = None) -> Optional[Dict]:
    """
    Scan every one of the user's active reminders and read all of their
    parameters against `candidate` to see if a duplicate already exists.
    Used at CREATE time (manual save + email auto-save) so duplicates are
    prevented up front, not just cleaned up later.
    """
    cursor = db["reminders"].find(
        {"user_id": user_id, "is_dismissed": {"$ne": True}}
    )
    async for doc in cursor:
        existing = _reminder_to_dict(doc)
        if ignored_pairs and _pair_key(existing["id"], candidate.get("id", "")) in ignored_pairs:
            continue
        if _reminders_are_duplicate(existing, candidate):
            return existing
    return None


# =============================================================================
# AUTO-SAVE WITH TM APP NUMBER DEDUPLICATION
# =============================================================================

async def _auto_save_event(user_id: str, event: ExtractedEventOut, prefs: Dict):
    """
    Save/update event to todos / reminders / visits.

    DEDUPLICATION LOGIC:
    ─────────────────────
    IP India events (tm_app_no present):
      TODO  → key = (user_id, tm_app_no, source="email_auto", is_completed=False)
              If found & new seq > old seq: UPDATE title + urgency + reminder_seq
              If found & same seq: skip
              If not found: INSERT with UUID string "id"

      REMINDER → key = (user_id, tm_app_no, source="email_auto")
              If found & is_dismissed: skip
              If found & is_adjournment: UPDATE remind_at + description + title
              If found & not adjournment: skip
              If not found: INSERT with UUID string "id"

    Generic events (no tm_app_no):
      Deduplicate by (user_id, title, source).

    v9 FIX: All INSERT operations now pre-generate a UUID string "id" field
    so that DELETE /reminders/{id} and PATCH /reminders/{id} routes resolve
    correctly. Previously auto-saved docs only had MongoDB ObjectId (_id)
    and the string "id" field was absent, causing 404 errors on delete/update.
    """
    dismissed_check = await db["reminders"].find_one(
        {"user_id": user_id, "title": event.title, "is_dismissed": True},
        {"_id": 0, "title": 1}
    )
    if dismissed_check:
        return

    try:
        save_cat       = event.save_category or _classify_save_category(
            event.event_type, event.title, event.description or ""
        )
        email_msg_id   = getattr(event, "_message_id",    None)
        tm_app_no      = event.tm_app_no
        clean_desc     = _clean_text(event.description or "", 300)
        reminder_seq   = getattr(event, "_reminder_seq",   0) or 0
        is_adjournment = getattr(event, "_is_adjournment", False) or False

        # ──────────────────────────────────────────────────────────────────────
        #  TODO  (Examination Report / Reminder-I / Reminder-II / Reminder-III)
        # ──────────────────────────────────────────────────────────────────────
        if save_cat == "todo" and prefs.get("auto_save_todos"):
            existing = None
            if tm_app_no:
                existing = await db["todos"].find_one(
                    {
                        "user_id":      user_id,
                        "tm_app_no":    tm_app_no,
                        "source":       "email_auto",
                        "is_completed": False,
                    },
                    {"_id": 1, "reminder_seq": 1, "title": 1, "due_date": 1}
                )
            if not existing:
                existing = await db["todos"].find_one(
                    {"user_id": user_id, "title": event.title, "source": "email_auto"},
                    {"_id": 1, "reminder_seq": 1}
                )

            if existing:
                old_seq = existing.get("reminder_seq") or 0
                if reminder_seq > old_seq:
                    update_fields = {
                        "title":        event.title,
                        "urgency":      event.urgency,
                        "reminder_seq": reminder_seq,
                        "updated_at":   datetime.now(timezone.utc).isoformat(),
                    }
                    if event.date:
                        existing_due = existing.get("due_date") or ""
                        if not existing_due or event.date > existing_due:
                            update_fields["due_date"] = event.date
                    await db["todos"].update_one(
                        {"_id": existing["_id"]},
                        {"$set": update_fields}
                    )
                    logger.info(
                        f"[TODO] Updated TM#{tm_app_no}: "
                        f"seq {old_seq}→{reminder_seq}, urgency={event.urgency}"
                    )
                else:
                    logger.debug(f"[TODO] Skip duplicate seq={reminder_seq} TM#{tm_app_no}")
            else:
                # v9 FIX: generate UUID string "id" before insert
                new_id = str(_uuid.uuid4())
                await db["todos"].insert_one({
                    "id":               new_id,          # ← string id for API routes
                    "user_id":          user_id,
                    "title":            event.title,
                    "description":      (
                        f"Auto-imported from email.\n"
                        f"From: {event.source_from}\n"
                        f"Subject: {event.source_subject}\n"
                        f"Notes: {clean_desc}"
                    ),
                    "is_completed":     False,
                    "due_date":         event.date or None,
                    "source":           "email_auto",
                    "email_message_id": email_msg_id,
                    "tm_app_no":        tm_app_no,
                    "reminder_seq":     reminder_seq,
                    "urgency":          event.urgency,
                    "created_at":       datetime.now(timezone.utc).isoformat(),
                    "updated_at":       datetime.now(timezone.utc).isoformat(),
                })
                logger.info(f"[TODO] New: {event.title} (TM#{tm_app_no}, id={new_id})")

        # ──────────────────────────────────────────────────────────────────────
        #  REMINDER  (Hearing / Adjournment)
        # ──────────────────────────────────────────────────────────────────────
        elif save_cat == "reminder" and prefs.get("auto_save_reminders"):
            date_str = event.date or datetime.now(IST).strftime("%Y-%m-%d")
            time_str = event.time or "10:00"
            try:
                remind_dt = datetime.strptime(f"{date_str}T{time_str}", "%Y-%m-%dT%H:%M")
                remind_dt = remind_dt.replace(tzinfo=IST)
            except Exception:
                remind_dt = datetime.now(IST) + timedelta(days=1)

            existing = None
            if tm_app_no:
                existing = await db["reminders"].find_one(
                    {"user_id": user_id, "tm_app_no": tm_app_no, "source": "email_auto"},
                    {"_id": 1, "is_dismissed": 1, "remind_at": 1, "title": 1}
                )
            if not existing:
                existing = await db["reminders"].find_one(
                    {"user_id": user_id, "title": event.title, "source": "email_auto"},
                    {"_id": 1, "is_dismissed": 1}
                )

            if existing:
                if existing.get("is_dismissed"):
                    logger.debug(f"[REMINDER] Skip dismissed TM#{tm_app_no}")
                    return
                if is_adjournment:
                    await db["reminders"].update_one(
                        {"_id": existing["_id"]},
                        {"$set": {
                            "title":       event.title,
                            "description": (
                                f"⚠️ ADJOURNED — Hearing rescheduled.\n"
                                f"New date: {date_str}\n"
                                f"From: {event.source_from}\n"
                                f"Notes: {clean_desc}"
                            ),
                            "remind_at":   remind_dt.isoformat(),
                            "urgency":     "high",
                            "updated_at":  datetime.now(timezone.utc).isoformat(),
                        }}
                    )
                    logger.info(f"[REMINDER] Adjourned TM#{tm_app_no} → new date {date_str}")
                else:
                    logger.debug(f"[REMINDER] Skip duplicate hearing TM#{tm_app_no}")
                return

            # Extra safety net: the exact-match lookups above only catch
            # duplicates keyed on tm_app_no or an identical title. Before
            # inserting, also read every parameter of every other active
            # reminder this user has (title similarity, date proximity,
            # description) to catch near-duplicates the exact-match queries
            # would miss (e.g. same hearing re-imported with a slightly
            # reformatted subject line).
            fuzzy_candidate = {
                "id": "", "title": event.title, "tm_app_no": tm_app_no,
                "remind_at": remind_dt.isoformat(), "description": clean_desc,
            }
            fuzzy_existing = await _find_existing_duplicate(user_id, fuzzy_candidate)
            if fuzzy_existing:
                logger.debug(
                    f"[REMINDER] Skip near-duplicate of existing reminder "
                    f"{fuzzy_existing.get('id')} (TM#{tm_app_no})"
                )
                return

            # New reminder — build description
            desc_parts = []
            if event.organizer:       desc_parts.append(f"From: {event.organizer}")
            if clean_desc:            desc_parts.append(f"Notes: {clean_desc}")
            if event.source_subject:  desc_parts.append(f"Subject: {event.source_subject}")

            # v9 FIX: generate UUID string "id" before insert
            new_id = str(_uuid.uuid4())
            await db["reminders"].insert_one({
                "id":               new_id,          # ← string id for DELETE/PATCH routes
                "user_id":          user_id,
                "title":            event.title,
                "description":      "\n".join(desc_parts) or None,
                "remind_at":        remind_dt.isoformat(),
                "is_dismissed":     False,
                "source":           "email_auto",
                "email_message_id": email_msg_id,
                "tm_app_no":        tm_app_no,
                "urgency":          event.urgency,
                "created_at":       datetime.now(timezone.utc).isoformat(),
            })
            logger.info(f"[REMINDER] New: {event.title} (TM#{tm_app_no}, date={date_str}, id={new_id})")

        # ──────────────────────────────────────────────────────────────────────
        #  VISIT
        # ──────────────────────────────────────────────────────────────────────
        elif save_cat == "visit" and prefs.get("auto_save_visits"):
            date_str = event.date or datetime.now(IST).strftime("%Y-%m-%d")
            existing = await db["visits"].find_one(
                {
                    "user_id":    user_id,
                    "title":      event.title,
                    "visit_date": date_str,
                    "source":     "email_auto",
                },
                {"_id": 0}
            )
            if not existing:
                new_id = str(_uuid.uuid4())
                await db["visits"].insert_one({
                    "id":               new_id,
                    "user_id":          user_id,
                    "title":            event.title,
                    "visit_date":       date_str,
                    "notes":            clean_desc or event.source_subject or "",
                    "status":           "scheduled",
                    "source":           "email_auto",
                    "email_message_id": email_msg_id,
                    "tm_app_no":        tm_app_no,
                    "created_at":       datetime.now(timezone.utc).isoformat(),
                })
                logger.info(f"[VISIT] New: {event.title} on {date_str} (id={new_id})")

    except Exception as e:
        logger.error(f"Auto-save error '{event.title}': {e}", exc_info=True)


# =============================================================================
# HELPERS — build event doc + attach extra attrs
# =============================================================================

def _build_event_doc(user_id: str, email_addr: str, raw: Dict, ev: Dict) -> Dict:
    return {
        "user_id":        user_id,
        "email_account":  email_addr,
        "message_id":     raw.get("message_id"),
        "title":          _clean_text(ev.get("title") or raw["subject"], 120),
        "event_type":     ev.get("event_type", "Other"),
        "date":           ev.get("date"),
        "time":           ev.get("time"),
        "organizer":      _clean_text(ev.get("organizer") or "", 100),
        "description":    _clean_text(ev.get("description") or "", 300),
        "urgency":        ev.get("urgency", "medium"),
        "save_category":  ev.get("save_category", "reminder"),
        "tm_app_no":      ev.get("tm_app_no"),
        "tm_class":       ev.get("tm_class"),
        "reminder_seq":   ev.get("reminder_seq", 0),
        "is_adjournment": ev.get("is_adjournment", False),
        "raw_event_date": ev.get("raw_event_date"),
        "reply_deadline": ev.get("reply_deadline"),
        "source_subject": raw["subject"][:200],
        "source_from":    raw["from_addr"][:200],
        "source_date":    raw["msg_date"][:100],
        "received_at":    raw.get("received_at") or _parse_email_received_at(raw.get("msg_date", "")).isoformat(),
        "raw_snippet":    _clean_text(raw["body"][:500], 500),
        "created_at":     datetime.now(timezone.utc).isoformat(),
    }

def _attach_extra_attrs(ev_out: ExtractedEventOut, ev: Dict, mid: str):
    ev_out._message_id     = mid
    ev_out._reminder_seq   = ev.get("reminder_seq", 0)
    ev_out._is_adjournment = ev.get("is_adjournment", False)


# =============================================================================
# SCHEDULED SCAN LOOP
# =============================================================================

_scan_task = None

async def _scheduled_scan_loop():
    logger.info("Email scheduled scan loop started.")
    while True:
        try:
            now_ist    = datetime.now(IST)
            prefs_list = await db[COL_AUTO_PREFS].find({}).to_list(length=500)
            for pref in prefs_list:
                user_id     = pref.get("user_id")
                scan_hour   = pref.get("scan_time_hour", 12)
                scan_minute = pref.get("scan_time_minute", 0)
                target       = now_ist.replace(hour=scan_hour, minute=scan_minute, second=0, microsecond=0)
                if abs((now_ist - target).total_seconds()) > 300:
                    continue
                sched = await db[COL_SCAN_SCHEDULE].find_one({"user_id": user_id}, {"_id": 0})
                if sched and (sched.get("last_run", "")[:10] == now_ist.strftime("%Y-%m-%d")):
                    continue
                logger.info(f"Scheduled scan: user {user_id}")
                try:
                    await _run_full_scan_for_user(user_id, pref)
                    await db[COL_SCAN_SCHEDULE].update_one(
                        {"user_id": user_id},
                        {"$set": {"last_run": now_ist.isoformat(), "user_id": user_id}},
                        upsert=True
                    )
                except Exception as e:
                    logger.error(f"Scheduled scan error user {user_id}: {e}")
        except Exception as e:
            logger.error(f"Scan loop error: {e}")
        await asyncio.sleep(60)


async def _run_full_scan_for_user(user_id: str, prefs: Dict, limit: int = 50):
    conns = await db[COL_CONNECTIONS].find(
        {"user_id": user_id, "is_active": True,
         "admin_disabled": {"$ne": True}, "admin_paused": {"$ne": True}},
        {"_id": 0}
    ).to_list(50)
    if not conns:
        return

    wl_doc = await db[COL_SENDER_WHITELIST].find_one({"user_id": user_id}, {"_id": 0})
    sender_whitelist: List[str] = (
        [s.get("email_address","") for s in wl_doc.get("senders",[]) if s.get("email_address")]
        if wl_doc else []
    )
    dismissed_titles = await _get_dismissed_titles(user_id)
    loop             = asyncio.get_event_loop()

    for conn in conns:
        try:
            email_addr = conn["email_address"]
            raw_emails = await loop.run_in_executor(
                None, _scan_mailbox_sync,
                conn["imap_host"], conn["imap_port"], email_addr,
                _decrypt(conn["app_password_enc"]), limit,
                sender_whitelist or None,
            )
            for raw in raw_emails:
                mid    = _stable_message_id(email_addr, raw)
                raw["message_id"] = mid
                exists = await db[COL_EVENTS].find_one(
                    {"user_id": user_id, "message_id": mid}
                )
                if exists:
                    # Already saved by the user (Action Center or the
                    # Reminders/Todos/Visits page directly) — don't re-save it.
                    if exists.get("saved_category"):
                        continue
                    ev_out = _doc_to_out(exists)
                    ev_out._is_adjournment = exists.get("is_adjournment", False)
                    ev_out._reminder_seq   = exists.get("reminder_seq", 0)
                    ev_out._message_id     = mid
                    await _auto_save_event(user_id, ev_out, prefs)
                    continue

                extracted = await _extract_events_from_email(
                    raw["subject"], raw["body"], raw["from_addr"], raw["msg_date"],
                    dismissed_titles=dismissed_titles,
                )
                for ev in extracted:
                    doc = _build_event_doc(user_id, email_addr, raw, ev)
                    res = await db[COL_EVENTS].insert_one(doc)
                    doc["id"] = str(res.inserted_id)
                    ev_out = _doc_to_out(doc)
                    _attach_extra_attrs(ev_out, ev, mid)
                    await _auto_save_event(user_id, ev_out, prefs)

            await db[COL_CONNECTIONS].update_one(
                {"user_id": user_id, "email_address": email_addr},
                {"$set": {"last_synced": datetime.now(timezone.utc).isoformat(), "sync_error": None}}
            )
        except Exception as e:
            logger.error(f"Scan error {conn.get('email_address')}: {e}")
            await db[COL_CONNECTIONS].update_one(
                {"user_id": user_id, "email_address": conn.get("email_address")},
                {"$set": {"sync_error": str(e)}}
            )

def start_scheduled_scan_loop():
    global _scan_task
    _scan_task = asyncio.get_event_loop().create_task(_scheduled_scan_loop())
    logger.info("Scheduled email scan loop registered.")


async def create_email_indexes():
    """
    Create MongoDB indexes for email integration collections.
    Call once from app startup (lifespan / on_startup).
    """
    try:
        await db[COL_CONNECTIONS].create_index(
            [("user_id", 1), ("email_address", 1)], unique=True, background=True
        )
        await db[COL_EVENTS].create_index(
            [("user_id", 1), ("message_id", 1)], unique=True,
            sparse=True, background=True
        )
        await db[COL_EVENTS].create_index(
            [("user_id", 1), ("tm_app_no", 1)], background=True, sparse=True
        )
        await db[COL_EVENTS].create_index(
            [("user_id", 1), ("date", -1)], background=True
        )
        await db["reminders"].create_index(
            [("user_id", 1), ("tm_app_no", 1)], background=True, sparse=True
        )
        await db["reminders"].create_index(
            [("user_id", 1), ("id", 1)], background=True, sparse=True
        )
        await db["reminder_dup_ignores"].create_index(
            [("user_id", 1), ("pair_key", 1)], unique=True, background=True
        )
        await db["todos"].create_index(
            [("user_id", 1), ("tm_app_no", 1), ("is_completed", 1)],
            background=True, sparse=True
        )
        await db["todos"].create_index(
            [("user_id", 1), ("id", 1)], background=True, sparse=True
        )
        logger.info("Email integration indexes created/verified.")
    except Exception as e:
        logger.warning(f"Index creation warning (non-fatal): {e}")


# =============================================================================
# API ROUTES — CONNECTIONS
# =============================================================================

@router.get("/connections")
async def list_connections(current_user=Depends(check_module_permission("email_accounts", "view"))):
    # Issue #9: Staff sees own only; Manager sees own + team members' accounts
    if current_user.role == "admin":
        docs = await db[COL_CONNECTIONS].find(
            {}, {"app_password_enc": 0, "_id": 0}
        ).to_list(500)
    elif current_user.role == "manager":
        team_ids = await get_team_user_ids(current_user.id)
        visible_ids = [str(current_user.id)] + [str(t) for t in team_ids]
        docs = await db[COL_CONNECTIONS].find(
            {"user_id": {"$in": visible_ids}}, {"app_password_enc": 0, "_id": 0}
        ).to_list(200)
    else:
        # Staff: own connections + any connection where they are a linked user
        own_docs = await db[COL_CONNECTIONS].find(
            {"user_id": str(current_user.id)}, {"app_password_enc": 0, "_id": 0}
        ).to_list(100)
        linked_docs = await db[COL_CONNECTIONS].find(
            {"linked_user_ids": str(current_user.id)}, {"app_password_enc": 0, "_id": 0}
        ).to_list(100)
        # Merge, avoiding duplicates
        seen_emails = {d["email_address"] for d in own_docs}
        docs = own_docs + [d for d in linked_docs if d["email_address"] not in seen_emails]

    # Attach owner identity so admins/managers can label other users' accounts in the UI.
    if current_user.role in ("admin", "manager") and docs:
        try:
            from bson import ObjectId  # local import — avoids hard dep if collection lacks ObjectId ids
            owner_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
            obj_ids = []
            for oid in owner_ids:
                try: obj_ids.append(ObjectId(oid))
                except Exception: pass
            users_by_id = {}
            if obj_ids:
                async for u in db["users"].find({"_id": {"$in": obj_ids}}, {"name": 1, "full_name": 1, "email": 1, "username": 1}):
                    uid = str(u["_id"])
                    users_by_id[uid] = u
            # Also try string user_ids (in case docs store user_id as plain string)
            async for u in db["users"].find({"_id": {"$in": [oid for oid in owner_ids if oid]}}, {"name": 1, "full_name": 1, "email": 1, "username": 1}):
                users_by_id[str(u["_id"])] = u
            for d in docs:
                uid = str(d.get("user_id") or "")
                u = users_by_id.get(uid)
                if u:
                    d["owner_name"]  = u.get("full_name") or u.get("name") or u.get("username") or u.get("email")
                    d["owner_email"] = u.get("email")
        except Exception:
            pass
    # Attach linked_users details (name/email) to all docs that have linked_user_ids
    if docs:
        try:
            from bson import ObjectId as _ObjId
            all_linked_ids = []
            for d in docs:
                for uid in (d.get("linked_user_ids") or []):
                    all_linked_ids.append(uid)
            if all_linked_ids:
                linked_user_map = {}
                # Try ObjectId lookup
                obj_ids2 = []
                for uid in set(all_linked_ids):
                    try: obj_ids2.append(_ObjId(uid))
                    except Exception: pass
                if obj_ids2:
                    async for u in db["users"].find({"_id": {"$in": obj_ids2}}, {"name": 1, "full_name": 1, "email": 1, "username": 1}):
                        linked_user_map[str(u["_id"])] = {"id": str(u["_id"]), "name": u.get("full_name") or u.get("name") or u.get("username") or u.get("email"), "email": u.get("email", "")}
                for d in docs:
                    lu_ids = d.get("linked_user_ids") or []
                    d["linked_users"] = [linked_user_map[uid] for uid in lu_ids if uid in linked_user_map]
        except Exception:
            pass
    return {"connections": [_conn_doc_to_out(d) for d in docs]}

@router.post("/connections", status_code=201)
async def add_connection(body: ConnectionCreateRequest, current_user=Depends(check_module_permission("email_accounts", "create"))):
    try:
        host, port, provider = _infer_provider(body.email_address)
        host = body.imap_host or host
        port = body.imap_port or port
        err  = await asyncio.get_event_loop().run_in_executor(
            None, _test_imap_sync, host, port, body.email_address, body.app_password
        )
        if err:
            raise HTTPException(status_code=400, detail=err)
        clean_email = body.email_address.strip().lower()
        doc = {
            "user_id": str(current_user.id), "email_address": clean_email,
            "app_password_enc": _encrypt(_clean_password(body.app_password)),
            "imap_host": host, "imap_port": port,
            "label": body.label or f"{provider.capitalize()} ({clean_email})",
            "provider": provider, "is_active": True,
            "connected_at": datetime.now(timezone.utc).isoformat(),
            "linked_page": body.linked_page or "all",
            "auto_sync": body.auto_sync or False,
            "keywords": [k.strip() for k in (body.keywords or []) if k and k.strip()],
            "keyword_match_mode": (body.keyword_match_mode or "or").lower(),
            "keyword_case_sensitive": bool(body.keyword_case_sensitive),
            "keyword_auto_save": True if body.keyword_auto_save is None else bool(body.keyword_auto_save),
        }
        await db[COL_CONNECTIONS].update_one(
            {"user_id": str(current_user.id), "email_address": clean_email},
            {"$set": doc}, upsert=True
        )
        return _conn_doc_to_out(doc)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to connect email: {e}")

@router.patch("/connections/{email_address}")
async def update_connection(
    email_address: str, body: ConnectionUpdateRequest, current_user=Depends(check_module_permission("email_accounts", "edit"))
):
    # Visibility — only own account, or manager for team accounts, or admin for anyone.
    query_filter = {"email_address": email_address}
    if current_user.role != "admin":
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            visible_ids = [str(current_user.id)] + [str(t) for t in team_ids]
            query_filter["user_id"] = {"$in": visible_ids}
        else:
            query_filter["user_id"] = str(current_user.id)
    existing = await db[COL_CONNECTIONS].find_one(query_filter, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Connection not found")
    updates = {k: v for k, v in body.dict().items() if v is not None or isinstance(v, bool)}
    # Admin-only fields: strip if caller is not admin
    if current_user.role != "admin":
        for f in ("admin_paused", "admin_disabled", "linked_user_ids"):
            updates.pop(f, None)
    if updates.get("is_active"):
        updates["sync_error"] = None
    if "keywords" in updates and updates["keywords"] is not None:
        updates["keywords"] = [k.strip() for k in updates["keywords"] if k and k.strip()]
    if "keyword_match_mode" in updates and updates["keyword_match_mode"]:
        mode = updates["keyword_match_mode"].lower()
        updates["keyword_match_mode"] = mode if mode in ("or", "and") else "or"
    # Use the actual owner of the document so admin edits land on the right row.
    owner_id = existing.get("user_id") or str(current_user.id)
    await db[COL_CONNECTIONS].update_one(
        {"user_id": owner_id, "email_address": email_address}, {"$set": updates}
    )
    doc = await db[COL_CONNECTIONS].find_one(
        {"user_id": owner_id, "email_address": email_address},
        {"_id": 0, "app_password_enc": 0}
    )
    return _conn_doc_to_out(doc)

@router.delete("/connections/{email_address}", status_code=204)
async def delete_connection(email_address: str, current_user=Depends(check_module_permission("email_accounts", "delete"))):
    # Issue #7 + #9: enforce delete permission + own-only for staff (Issue #3)
    if current_user.role == "admin":
        await db[COL_CONNECTIONS].delete_one({"email_address": email_address})
    else:
        # Staff & manager can only delete their own connections
        result = await db[COL_CONNECTIONS].delete_one(
            {"user_id": str(current_user.id), "email_address": email_address}
        )
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Connection not found or not owned by you")

# ─────────────────────────────────────────────────────────────────────────────
# LINKED USERS — admin assigns which users see an email's scraping results
# in their Action Center, and each linked user can set their own keywords.
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/connections/{email_address}/linked-users")
async def get_linked_users(email_address: str, current_user=Depends(check_module_permission("email_accounts", "view"))):
    """Return linked_user_ids with user details for a given connection (admin only for full list)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    doc = await db[COL_CONNECTIONS].find_one({"email_address": email_address}, {"_id": 0, "app_password_enc": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Connection not found")
    linked_ids = doc.get("linked_user_ids") or []
    linked_keywords = doc.get("linked_user_keywords") or {}  # {user_id: [kw, ...]}
    users_out = []
    if linked_ids:
        from bson import ObjectId as _ObjId
        obj_ids = []
        for uid in linked_ids:
            try: obj_ids.append(_ObjId(uid))
            except Exception: pass
        if obj_ids:
            async for u in db["users"].find({"_id": {"$in": obj_ids}}, {"name": 1, "full_name": 1, "email": 1, "username": 1, "role": 1}):
                uid_str = str(u["_id"])
                users_out.append({
                    "id": uid_str,
                    "name": u.get("full_name") or u.get("name") or u.get("username") or u.get("email"),
                    "email": u.get("email", ""),
                    "role": u.get("role", ""),
                    "keywords": linked_keywords.get(uid_str) or [],
                })
    return {"linked_users": users_out, "linked_user_ids": linked_ids}

@router.put("/connections/{email_address}/linked-users")
async def set_linked_users(
    email_address: str,
    body: Dict[str, Any],
    current_user=Depends(check_module_permission("email_accounts", "edit"))
):
    """Admin: assign/replace the list of users linked to this email connection."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    doc = await db[COL_CONNECTIONS].find_one({"email_address": email_address}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Connection not found")
    user_ids = [str(uid) for uid in (body.get("user_ids") or []) if uid]
    await db[COL_CONNECTIONS].update_one(
        {"email_address": email_address},
        {"$set": {"linked_user_ids": user_ids}}
    )
    return {"linked_user_ids": user_ids, "message": f"Linked {len(user_ids)} user(s) to {email_address}"}

@router.patch("/connections/{email_address}/my-keywords")
async def update_my_keywords(
    email_address: str,
    body: Dict[str, Any],
    current_user=Depends(check_module_permission("email_accounts", "view"))
):
    """Any linked user can update their own keywords for a connection they are linked to."""
    uid = str(current_user.id)
    doc = await db[COL_CONNECTIONS].find_one({"email_address": email_address}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Connection not found")
    # Must be owner or a linked user
    is_owner = doc.get("user_id") == uid
    is_linked = uid in (doc.get("linked_user_ids") or [])
    if not is_owner and not is_linked and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorised")
    keywords = [k.strip() for k in (body.get("keywords") or []) if k and k.strip()]
    field = f"linked_user_keywords.{uid}"
    await db[COL_CONNECTIONS].update_one(
        {"email_address": email_address},
        {"$set": {field: keywords}}
    )
    return {"keywords": keywords, "email_address": email_address}

@router.get("/my-linked-connections")
async def get_my_linked_connections(current_user=Depends(check_module_permission("email_accounts", "view"))):
    """Return connections where current user is in linked_user_ids (not the owner)."""
    uid = str(current_user.id)
    docs = await db[COL_CONNECTIONS].find(
        {"linked_user_ids": uid, "user_id": {"$ne": uid}},
        {"app_password_enc": 0, "_id": 0}
    ).to_list(100)
    # Attach per-user keywords
    for d in docs:
        linked_kw = d.get("linked_user_keywords") or {}
        d["my_keywords"] = linked_kw.get(uid) or []
    return {"connections": [_conn_doc_to_out(d) for d in docs]}

@router.post("/connections/{email_address}/test")
async def test_connection(email_address: str, current_user=Depends(check_module_permission("email_accounts", "view"))):
    doc = await db[COL_CONNECTIONS].find_one(
        {"user_id": str(current_user.id), "email_address": email_address}, {"_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Connection not found")
    err = await asyncio.get_event_loop().run_in_executor(
        None, _test_imap_sync,
        doc["imap_host"], doc["imap_port"], email_address, _decrypt(doc["app_password_enc"])
    )
    if err:
        await db[COL_CONNECTIONS].update_one(
            {"user_id": str(current_user.id), "email_address": email_address},
            {"$set": {"sync_error": err}}
        )
        raise HTTPException(status_code=400, detail=err)
    await db[COL_CONNECTIONS].update_one(
        {"user_id": str(current_user.id), "email_address": email_address},
        {"$set": {"sync_error": None, "last_synced": datetime.now(timezone.utc).isoformat()}}
    )
    return {"status": "ok", "message": f"{email_address} connected successfully"}


# =============================================================================
# API ROUTES — SENDER WHITELIST
# =============================================================================

@router.get("/sender-whitelist")
async def get_sender_whitelist(current_user=Depends(check_module_permission("email_accounts", "view"))):
    doc = await db[COL_SENDER_WHITELIST].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    return {"senders": doc.get("senders", []) if doc else []}

@router.post("/sender-whitelist")
async def add_sender_to_whitelist(body: SenderWhitelistEntry, current_user=Depends(check_module_permission("email_accounts", "create"))):
    clean = body.email_address.strip().lower()
    if not clean or "@" not in clean:
        raise HTTPException(status_code=422, detail="Invalid email address or domain.")
    entry = {"email_address": clean, "label": body.label or clean,
             "added_at": datetime.now(timezone.utc).isoformat()}
    existing = await db[COL_SENDER_WHITELIST].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    if existing:
        if any(s.get("email_address") == clean for s in existing.get("senders", [])):
            return {"message": "Sender already in whitelist", "senders": existing.get("senders", [])}
        await db[COL_SENDER_WHITELIST].update_one(
            {"user_id": str(current_user.id)}, {"$push": {"senders": entry}}
        )
    else:
        await db[COL_SENDER_WHITELIST].insert_one({"user_id": str(current_user.id), "senders": [entry]})
    updated = await db[COL_SENDER_WHITELIST].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    return {"message": "Sender added", "senders": updated.get("senders", [])}

@router.delete("/sender-whitelist/{email_address}")
async def remove_sender_from_whitelist(email_address: str, current_user=Depends(check_module_permission("email_accounts", "delete"))):
    await db[COL_SENDER_WHITELIST].update_one(
        {"user_id": str(current_user.id)},
        {"$pull": {"senders": {"email_address": email_address.lower()}}}
    )
    updated = await db[COL_SENDER_WHITELIST].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    return {"message": "Sender removed", "senders": (updated or {}).get("senders", [])}

@router.put("/sender-whitelist")
async def replace_sender_whitelist(body: SenderWhitelistOut, current_user=Depends(check_module_permission("email_accounts", "create"))):
    senders = []
    for s in body.senders:
        addr = (s.get("email_address") or "").strip().lower()
        if not addr:
            continue
        raw_kw = s.get("keywords") or []
        kws = [str(k).strip() for k in raw_kw if str(k).strip()] if isinstance(raw_kw, list) else []
        mode = (s.get("keyword_match_mode") or "or").lower()
        if mode not in ("or", "and"):
            mode = "or"
        senders.append({
            "email_address": addr,
            "label": s.get("label") or addr,
            "added_at": datetime.now(timezone.utc).isoformat(),
            "keywords": kws,
            "keyword_match_mode": mode,
            "keyword_case_sensitive": bool(s.get("keyword_case_sensitive")),
        })
    await db[COL_SENDER_WHITELIST].update_one(
        {"user_id": str(current_user.id)},
        {"$set": {"senders": senders, "user_id": str(current_user.id)}}, upsert=True
    )
    return {"message": "Whitelist updated", "senders": senders}


# =============================================================================
# API ROUTES — AUTO-SAVE PREFERENCES
# =============================================================================

@router.get("/auto-save-prefs", response_model=AutoSavePrefOut)
async def get_auto_save_prefs(current_user=Depends(check_module_permission("email_accounts", "view"))):
    doc = await db[COL_AUTO_PREFS].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    if not doc:
        return AutoSavePrefOut(
            auto_save_reminders=False, auto_save_visits=False, auto_save_todos=False,
            scan_time_hour=12, scan_time_minute=0, next_scan_at=None
        )
    now_ist   = datetime.now(IST)
    next_scan = now_ist.replace(hour=doc.get("scan_time_hour",12),
                                minute=doc.get("scan_time_minute",0), second=0, microsecond=0)
    if next_scan <= now_ist:
        next_scan += timedelta(days=1)
    return AutoSavePrefOut(
        auto_save_reminders=doc.get("auto_save_reminders", False),
        auto_save_visits=doc.get("auto_save_visits", False),
        auto_save_todos=doc.get("auto_save_todos", False),
        scan_time_hour=doc.get("scan_time_hour", 12),
        scan_time_minute=doc.get("scan_time_minute", 0),
        next_scan_at=next_scan.isoformat()
    )

@router.post("/auto-save-prefs", response_model=AutoSavePrefOut)
async def set_auto_save_prefs(body: AutoSavePrefRequest, current_user=Depends(check_module_permission("email_accounts", "create"))):
    doc = {
        "user_id": str(current_user.id),
        "auto_save_reminders": body.auto_save_reminders,
        "auto_save_visits": body.auto_save_visits,
        "auto_save_todos": body.auto_save_todos,
        "scan_time_hour": max(0, min(23, body.scan_time_hour)),
        "scan_time_minute": max(0, min(59, body.scan_time_minute)),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db[COL_AUTO_PREFS].update_one(
        {"user_id": str(current_user.id)}, {"$set": doc}, upsert=True
    )
    return await get_auto_save_prefs(current_user)

@router.get("/auto-save-prefs/exists")
async def check_prefs_exist(current_user=Depends(check_module_permission("email_accounts", "view"))):
    doc = await db[COL_AUTO_PREFS].find_one(
        {"user_id": str(current_user.id)}, {"_id": 0, "user_id": 1}
    )
    return {"has_set_prefs": doc is not None}


# =============================================================================
# API ROUTES — MANUAL SAVE
# =============================================================================

@router.post("/save-as-reminder", status_code=201)
async def save_as_reminder(body: ManualSaveReminderRequest, current_user=Depends(check_module_permission("email_accounts", "create"))):
    try:
        try:
            remind_dt = datetime.fromisoformat(body.remind_at.replace("Z", "+00:00"))
        except Exception:
            remind_dt = datetime.now(IST) + timedelta(days=1)

        incoming_event_id = (body.event_id or "").strip() or None
        # Synthetic id for purely-manual reminders (no source email/event) —
        # keeps every reminder row keyed so later dedup/lookups stay consistent.
        event_id = incoming_event_id or f"manual-{_uuid.uuid4()}"

        # Duplicate guard. When the reminder originates from a known event
        # (Action Center / email auto-save), match on that event_id — it's a
        # far stronger key than title, since two different hearings can share
        # a generic title like "Hearing Notice". Purely manual reminders
        # (no event_id supplied) fall back to a title match, same as before.
        dup_query = {"user_id": str(current_user.id)}
        if incoming_event_id:
            dup_query["event_id"] = incoming_event_id
        else:
            dup_query["title"] = body.title
        existing = await db["reminders"].find_one(dup_query, {"_id": 0, "id": 1})
        if existing:
            # Already saved previously — make sure the source event is (still)
            # flagged so it stays out of the Action Center, then report back.
            await _mark_event_saved(str(current_user.id), incoming_event_id, "reminder", existing.get("id", ""))
            return {"status": "already_exists", "id": existing.get("id", "")}

        # Second, stronger guard: the exact-match query above only catches
        # duplicates keyed on event_id or an identical title. Read every
        # parameter (title similarity, remind_at proximity, tm_app_no,
        # description) of every other active reminder this user has to also
        # catch near-duplicates — e.g. the same hearing saved twice from two
        # slightly different Action Center rows.
        fuzzy_candidate = {
            "id": "", "title": body.title,
            "tm_app_no": _extract_tm_app_no(body.title or "") or _extract_tm_app_no(body.description or ""),
            "remind_at": remind_dt.isoformat(),
            "description": body.description or "",
        }
        fuzzy_existing = await _find_existing_duplicate(str(current_user.id), fuzzy_candidate)
        if fuzzy_existing:
            await _mark_event_saved(str(current_user.id), incoming_event_id, "reminder", fuzzy_existing.get("id", ""))
            return {"status": "already_exists", "id": fuzzy_existing.get("id", "")}

        nid = str(_uuid.uuid4())
        doc = {
            "id": nid, "user_id": str(current_user.id), "title": body.title,
            "description": _clean_text(body.description or "", 500),
            "remind_at": remind_dt.isoformat(), "is_dismissed": False,
            "source": "email_manual", "event_id": event_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        # Optional Trademark Hearing outcome fields — stored only if sent,
        # so creating a hearing reminder no longer silently drops them.
        if body.brand_name is not None:
            doc["brand_name"] = body.brand_name
        if body.hearing_attended is not None:
            doc["hearing_attended"] = body.hearing_attended
        if body.hearing_decision is not None:
            doc["hearing_decision"] = body.hearing_decision
        if body.hearing_adjourned is not None:
            doc["hearing_adjourned"] = body.hearing_adjourned
        if body.hearing_next_date_disclosed is not None:
            doc["hearing_next_date_disclosed"] = body.hearing_next_date_disclosed
        if body.hearing_notes is not None:
            doc["hearing_notes"] = body.hearing_notes

        await db["reminders"].insert_one(doc)
        # Flag the source Action Center event as saved so it never
        # resurfaces on a later sync.
        await _mark_event_saved(str(current_user.id), incoming_event_id, "reminder", nid)
        return {"status": "created", "id": nid}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save reminder: {e}")

@router.post("/save-as-visit", status_code=201)
async def save_as_visit(body: ManualSaveVisitRequest, current_user=Depends(check_module_permission("email_accounts", "create"))):
    try:
        incoming_event_id = (body.event_id or "").strip() or None
        # Duplicate guard — prefer the strong event_id key (same reasoning as
        # save-as-reminder: two visits can share a generic title), falling
        # back to title+date for older/manual rows without an event_id.
        dup_query = {"user_id": str(current_user.id)}
        if incoming_event_id:
            dup_query["event_id"] = incoming_event_id
        else:
            dup_query["title"] = body.title
            dup_query["visit_date"] = body.visit_date
        existing = await db["visits"].find_one(dup_query, {"_id": 0, "id": 1})
        if existing:
            await _mark_event_saved(str(current_user.id), incoming_event_id, "visit", existing.get("id", ""))
            return {"status": "already_exists", "id": existing.get("id", "")}
        nid = str(_uuid.uuid4())
        await db["visits"].insert_one({
            "id": nid, "user_id": str(current_user.id), "title": body.title,
            "visit_date": body.visit_date, "notes": _clean_text(body.notes or "", 500),
            "status": "scheduled", "source": "email_manual", "event_id": body.event_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        await _mark_event_saved(str(current_user.id), incoming_event_id, "visit", nid)
        return {"status": "created", "id": nid}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save visit: {e}")

@router.post("/save-as-todo", status_code=201)
async def save_as_todo(body: ManualSaveReminderRequest, current_user=Depends(check_module_permission("email_accounts", "create"))):
    try:
        incoming_event_id = (body.event_id or "").strip() or None
        dup_query = {"user_id": str(current_user.id)}
        if incoming_event_id:
            dup_query["event_id"] = incoming_event_id
        else:
            dup_query["title"] = body.title
        existing = await db["todos"].find_one(dup_query, {"_id": 0, "id": 1})
        if existing:
            await _mark_event_saved(str(current_user.id), incoming_event_id, "todo", existing.get("id", ""))
            return {"status": "already_exists", "id": existing.get("id", "")}
        nid = str(_uuid.uuid4())
        await db["todos"].insert_one({
            "id": nid, "user_id": str(current_user.id), "title": body.title,
            "description": _clean_text(body.description or "", 500),
            "is_completed": False, "due_date": body.remind_at[:10] if body.remind_at else None,
            "source": "email_manual", "event_id": body.event_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        await _mark_event_saved(str(current_user.id), incoming_event_id, "todo", nid)
        return {"status": "created", "id": nid}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save todo: {e}")


@router.post("/events/{event_id}/mark-saved", status_code=200)
async def mark_event_saved(
    event_id: str,
    body: MarkEventSavedRequest,
    current_user=Depends(check_module_permission("email_accounts", "create")),
):
    """
    Flag an Action Center event as saved without going through
    save-as-reminder/todo/visit. Used by the "Add Task" flow (Action Center →
    Create Task posts straight to /tasks, which knows nothing about
    email-extracted events), so that event also disappears from future
    Action Center syncs once a task has been created from it.
    """
    await _mark_event_saved(str(current_user.id), event_id, body.category, body.saved_id or "")
    return {"status": "ok"}


# =============================================================================
# API ROUTES — REMINDERS (GET / PATCH / DELETE)
# =============================================================================
# These routes use _reminder_to_dict to always include a resolved string "id".
# This is the primary fix for "Cannot delete: reminder ID is missing".
# =============================================================================

@router.get("/reminders")
async def get_reminders(
    current_user=Depends(check_module_permission("email_accounts", "view")),
    user_id: Optional[str] = Query(None),
):
    """
    Return all non-dismissed reminders for the current user (or a specific
    user_id if the caller has admin rights).
    Every returned doc is guaranteed to have a non-empty string "id" field
    thanks to _reminder_to_dict's fallback to str(_id).
    """
    target_uid = user_id if user_id else str(current_user.id)
    docs = await db["reminders"].find(
        {"user_id": target_uid}
    ).sort("remind_at", 1).to_list(500)
    return [_reminder_to_dict(d) for d in docs]


@router.patch("/reminders/{reminder_id}")
async def update_reminder(
    reminder_id: str,
    body: dict,
    current_user=Depends(check_module_permission("email_accounts", "create")),
):
    """
    Update a reminder by its string id (UUID) or MongoDB ObjectId string.
    Tries string "id" field first, then falls back to ObjectId "_id" match.
    """
    user_id = str(current_user.id)

    # Try string id field first (v9 docs)
    doc = await db["reminders"].find_one(
        {"user_id": user_id, "id": reminder_id}, {"_id": 1}
    )

    # Fallback: try ObjectId match (pre-v9 docs where id == str(_id))
    if not doc:
        try:
            doc = await db["reminders"].find_one(
                {"user_id": user_id, "_id": ObjectId(reminder_id)}, {"_id": 1}
            )
        except Exception:
            pass

    if not doc:
        raise HTTPException(status_code=404, detail="Reminder not found")

    allowed_fields = {
        "title", "description", "remind_at", "is_dismissed",
        "urgency", "tm_app_no", "updated_at",
        # Trademark Hearing outcome fields — previously dropped on edit.
        "brand_name", "hearing_attended", "hearing_decision",
        "hearing_adjourned", "hearing_next_date_disclosed", "hearing_notes",
    }
    updates = {k: v for k, v in body.items() if k in allowed_fields}
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()

    await db["reminders"].update_one({"_id": doc["_id"]}, {"$set": updates})

    updated = await db["reminders"].find_one({"_id": doc["_id"]}, {"_id": 0})
    return _reminder_to_dict({**updated, "_id": doc["_id"]})


@router.delete("/reminders/{reminder_id}", status_code=204)
async def delete_reminder(
    reminder_id: str,
    current_user=Depends(check_module_permission("email_accounts", "delete")),
):
    """
    Delete a reminder by its string id (UUID) or MongoDB ObjectId string.
    Tries string "id" field first, then falls back to ObjectId "_id" match.
    Returns 204 whether found or not (idempotent).
    """
    user_id = str(current_user.id)

    # Try string id field first (v9 docs and migrated docs)
    result = await db["reminders"].delete_one(
        {"user_id": user_id, "id": reminder_id}
    )

    if result.deleted_count == 0:
        # Fallback: try ObjectId match for pre-v9 docs
        try:
            await db["reminders"].delete_one(
                {"user_id": user_id, "_id": ObjectId(reminder_id)}
            )
        except Exception:
            pass  # Invalid ObjectId format — silently ignore, return 204 anyway


# =============================================================================
# API ROUTES — REMINDER DUPLICATE DETECTION
# =============================================================================
# Powers the "Duplicates" tab on the Reminders page. Unlike the create-time
# guards above (which only stop NEW duplicates from being inserted), these
# routes scan every existing reminder the user already has and group ones
# that look like duplicates of each other, so old/legacy duplicates can be
# cleaned up too.
# =============================================================================

@router.get("/reminders/duplicates")
async def get_duplicate_reminders(
    current_user=Depends(check_module_permission("email_accounts", "view")),
    user_id: Optional[str] = Query(None),
):
    """
    Reads every parameter (title, tm_app_no, remind_at, description, source)
    of every active reminder belonging to the user and groups the ones that
    are very likely duplicates of one another.

    Pairs the user has previously marked "Not a Duplicate" (via the ignore
    endpoint below) are permanently excluded from future results.
    """
    target_uid = user_id if user_id else str(current_user.id)

    docs = await db["reminders"].find(
        {"user_id": target_uid, "is_dismissed": {"$ne": True}}
    ).to_list(2000)
    reminders = [_reminder_to_dict(d) for d in docs]

    ignored_pairs: Set[str] = set()
    async for ig in db["reminder_dup_ignores"].find({"user_id": target_uid}, {"_id": 0, "pair_key": 1}):
        ignored_pairs.add(ig["pair_key"])

    n = len(reminders)
    dsu = _DisjointSet(n)
    for i in range(n):
        for j in range(i + 1, n):
            if _pair_key(reminders[i]["id"], reminders[j]["id"]) in ignored_pairs:
                continue
            if _reminders_are_duplicate(reminders[i], reminders[j]):
                dsu.union(i, j)

    clusters: Dict[int, List[Dict]] = {}
    for idx, rem in enumerate(reminders):
        root = dsu.find(idx)
        clusters.setdefault(root, []).append(rem)

    def completeness(r: Dict) -> int:
        return sum(1 for k in ("description", "tm_app_no", "brand_name") if r.get(k))

    groups = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        members_sorted = sorted(
            members,
            key=lambda r: (-completeness(r), r.get("created_at") or ""),
        )
        for i, m in enumerate(members_sorted):
            m["suggested_keep"] = (i == 0)
        groups.append({
            "group_id": members_sorted[0]["id"],
            "members": members_sorted,
        })

    groups.sort(key=lambda g: g["members"][0].get("remind_at") or "")

    return {
        "duplicate_groups": groups,
        "group_count": len(groups),
        "total_duplicate_reminders": sum(len(g["members"]) for g in groups),
    }


@router.post("/reminders/duplicates/ignore", status_code=200)
async def ignore_duplicate_reminders(
    body: dict,
    current_user=Depends(check_module_permission("email_accounts", "create")),
):
    """
    Mark a set of reminders as "Not a Duplicate" of one another. Every
    pairwise combination inside `ids` is recorded, so the group (or any
    subset of it) never gets suggested as a duplicate match again.
    body: { "ids": ["<reminder_id>", "<reminder_id>", ...] }
    """
    user_id = str(current_user.id)
    ids = [str(x) for x in (body.get("ids") or []) if x]
    if len(ids) < 2:
        raise HTTPException(status_code=400, detail="At least two reminder ids are required")

    now_iso = datetime.now(timezone.utc).isoformat()
    pairs_written = 0
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            key = _pair_key(ids[i], ids[j])
            await db["reminder_dup_ignores"].update_one(
                {"user_id": user_id, "pair_key": key},
                {"$set": {"user_id": user_id, "pair_key": key, "updated_at": now_iso},
                 "$setOnInsert": {"created_at": now_iso}},
                upsert=True,
            )
            pairs_written += 1

    return {"status": "ok", "ignored_pairs": pairs_written}


# =============================================================================
# API ROUTES — EVENT EXTRACTION ENGINE
# =============================================================================

@router.get("/extract-events", response_model=List[ExtractedEventOut])
async def extract_events(
    current_user=Depends(check_module_permission("email_accounts", "view")),
    limit: int = Query(30),
    force_refresh: bool = Query(False),
    since_date: Optional[str] = Query(
        None,
        description="YYYY-MM-DD. Re-scans mail received on/after this date instead "
                    "of just the recent rolling window — used for retrospective sync "
                    "of older mail. Safe to repeat: duplicates are skipped via Message-ID.",
    ),
    email: Optional[str] = Query(
        None, description="Restrict the sync to a single connected email account."
    ),
):
    conns = await db[COL_CONNECTIONS].find(
        {"user_id": str(current_user.id), "is_active": True, "admin_disabled": {"$ne": True}, "admin_paused": {"$ne": True}}, {"_id": 0}
    ).to_list(50)
    if email:
        conns = [c for c in conns if c["email_address"] == email]
    if not conns:
        return []

    # Convert "YYYY-MM-DD" → IMAP's "dd-Mon-yyyy" SINCE format.
    imap_since = None
    if since_date:
        try:
            imap_since = datetime.fromisoformat(since_date[:10]).strftime("%d-%b-%Y")
        except Exception:
            imap_since = None

    prefs_doc = await db[COL_AUTO_PREFS].find_one(
        {"user_id": str(current_user.id)}, {"_id": 0}
    ) or {}
    wl_doc = await db[COL_SENDER_WHITELIST].find_one({"user_id": str(current_user.id)}, {"_id": 0})
    sender_whitelist: List[str] = (
        [s.get("email_address","") for s in wl_doc.get("senders",[]) if s.get("email_address")]
        if wl_doc else []
    )
    dismissed_titles = await _get_dismissed_titles(str(current_user.id))
    saved_event_ids  = await _get_saved_event_ids(str(current_user.id))

    async def process_account(conn):
        email_addr = conn["email_address"]

        # The 30-minute result cache only applies to the normal rolling-window
        # scan. A retrospective sync (since_date) or keyword-filtered sync
        # always hits the mailbox.
        if not force_refresh and not imap_since and not (conn.get("keywords") or []) and conn.get("last_synced"):
            try:
                last = datetime.fromisoformat(conn["last_synced"])
                if (datetime.now(timezone.utc) - last).total_seconds() < 1800:
                    cached = await db[COL_EVENTS].find(
                        {
                            "user_id": str(current_user.id),
                            "email_account": email_addr,
                            # Already saved (Action Center Save button, or
                            # directly on the Reminders/Todos/Visits page) —
                            # never resurface it from the cache.
                            "saved_category": {"$exists": False},
                        }
                    ).sort("created_at", -1).limit(limit).to_list(limit)
                    return [
                        _doc_to_out(d) for d in cached
                        if str(d.get("_id", "")) not in saved_event_ids
                    ]
            except Exception:
                pass

        loop       = asyncio.get_event_loop()
        kw_list    = conn.get("keywords") or []
        kw_mode    = conn.get("keyword_match_mode", "or")
        kw_case    = bool(conn.get("keyword_case_sensitive", False))
        kw_autosave= bool(conn.get("keyword_auto_save", True))
        # Force-refresh must always ask IMAP for mail newer than the latest
        # imported email date (with a 2-day overlap), not just the newest 50
        # matching rows. Busy inboxes can otherwise get stuck on an older day
        # (for example July 9) if newer relevant messages are outside that cap.
        effective_since = imap_since
        if force_refresh and not effective_since:
            latest_doc = await db[COL_EVENTS].find_one(
                {"user_id": str(current_user.id), "email_account": email_addr, "received_at": {"$exists": True, "$ne": None}},
                {"_id": 0, "received_at": 1},
                sort=[("received_at", -1)],
            )
            if latest_doc and latest_doc.get("received_at"):
                try:
                    latest_dt = datetime.fromisoformat(str(latest_doc["received_at"]).replace("Z", "+00:00"))
                    effective_since = _imap_since_from_dt(latest_dt - timedelta(days=2))
                except Exception:
                    effective_since = _imap_since_from_dt(datetime.now(timezone.utc) - timedelta(days=30))
            else:
                effective_since = _imap_since_from_dt(datetime.now(timezone.utc) - timedelta(days=30))

        # Date-bounded scans and keyword-scoped scans are already narrowed by
        # IMAP criteria, so do not cap them before parsing.
        fetch_cap  = 300 if (effective_since or kw_list) else 100
        raw_emails = await loop.run_in_executor(
            None, _scan_mailbox_sync,
            conn["imap_host"], conn["imap_port"], email_addr,
            _decrypt(conn["app_password_enc"]), fetch_cap, sender_whitelist or None,
            effective_since, kw_list or None, kw_mode, kw_case,
        )
        acc = []
        for raw in raw_emails:
            mid    = _stable_message_id(email_addr, raw)
            raw["message_id"] = mid
            exists = await db[COL_EVENTS].find_one(
                {"user_id": str(current_user.id), "message_id": mid}
            )
            matched_kw = raw.get("matched_keywords") or []
            # When keyword filter is active but auto-save is OFF, this email
            # must surface in the preview panel for the user to confirm.
            needs_confirm = bool(matched_kw) and not kw_autosave
            may_autosave  = (not matched_kw) or kw_autosave

            if exists:
                # Already saved (Action Center Save button, or directly from
                # the Reminders/Todos/Visits page) — hide it permanently
                # instead of re-adding it to this sync's results.
                if exists.get("saved_category") or str(exists.get("_id", "")) in saved_event_ids:
                    continue
                ev_out = _doc_to_out(exists)
                ev_out.matched_keywords     = matched_kw or exists.get("matched_keywords") or []
                ev_out.requires_confirmation= needs_confirm
                ev_out._is_adjournment = exists.get("is_adjournment", False)
                ev_out._reminder_seq   = exists.get("reminder_seq", 0)
                ev_out._message_id     = mid
                acc.append(ev_out)
                if prefs_doc and may_autosave:
                    await _auto_save_event(str(current_user.id), ev_out, prefs_doc)
                    ev_out.auto_saved = True
                continue

            extracted = await _extract_events_from_email(
                raw["subject"], raw["body"], raw["from_addr"], raw["msg_date"],
                dismissed_titles=dismissed_titles,
            )
            for ev in extracted:
                doc = _build_event_doc(str(current_user.id), email_addr, raw, ev)
                if matched_kw:
                    doc["matched_keywords"] = matched_kw
                res = await db[COL_EVENTS].insert_one(doc)
                doc["id"] = str(res.inserted_id)
                ev_out = _doc_to_out(doc)
                ev_out.matched_keywords      = matched_kw
                ev_out.requires_confirmation = needs_confirm
                _attach_extra_attrs(ev_out, ev, mid)
                acc.append(ev_out)
                if prefs_doc and may_autosave:
                    await _auto_save_event(str(current_user.id), ev_out, prefs_doc)
                    ev_out.auto_saved = True

        await db[COL_CONNECTIONS].update_one(
            {"user_id": str(current_user.id), "email_address": email_addr},
            {"$set": {"last_synced": datetime.now(timezone.utc).isoformat(), "sync_error": None}}
        )
        return acc

    completed = await asyncio.gather(*[process_account(c) for c in conns], return_exceptions=True)
    final: List[ExtractedEventOut] = []
    for res in completed:
        if isinstance(res, list):
            final.extend(res)
        elif isinstance(res, Exception):
            logger.error(f"process_account error: {res}")

    final.sort(key=lambda e: e.date or "0000-00-00", reverse=True)
    return final[:limit]


# NOTE: /events/clear-all MUST be defined before /events/{event_id}
# otherwise FastAPI matches "clear-all" as an event_id and tries ObjectId("clear-all")
@router.delete("/events/clear-all", status_code=204)
async def clear_all_events(current_user=Depends(check_module_permission("email_accounts", "delete"))):
    """Clear all cached extracted events — forces fresh scan next time.
    Does NOT delete reminders, visits, or todos already saved."""
    await db[COL_EVENTS].delete_many({"user_id": str(current_user.id)})

@router.delete("/events/{event_id}", status_code=204)
async def delete_event(event_id: str, current_user=Depends(check_module_permission("email_accounts", "delete"))):
    """Delete a single cached extraction record. Does NOT cascade to reminders/visits/todos."""
    try:
        await db[COL_EVENTS].delete_one(
            {"_id": ObjectId(event_id), "user_id": str(current_user.id)}
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid event id: {e}")

@router.get("/importer/events", response_model=List[ExtractedEventOut])
async def importer_events(
    current_user=Depends(check_module_permission("email_accounts", "view")),
    limit: int = Query(30),
    force_refresh: bool = Query(False)
):
    count = await db[COL_EVENTS].count_documents({"user_id": str(current_user.id)})
    if count == 0 or force_refresh:
        return await extract_events(current_user, limit, force_refresh)
    saved_event_ids = await _get_saved_event_ids(str(current_user.id))
    docs = await db[COL_EVENTS].find(
        {"user_id": str(current_user.id), "saved_category": {"$exists": False}}
    ).sort("date", -1).limit(limit).to_list(limit)
    return [
        _doc_to_out(d) for d in docs
        if str(d.get("_id", "")) not in saved_event_ids
    ]


# =============================================================================
# API ROUTES — SCAN SETTINGS (per-user, persisted to MongoDB)
# =============================================================================

DEFAULT_SCAN_SETTINGS = {
    "scanWindowDays":        30,
    "maxEventsPerScan":      100,
    "autoSelectFuture":      True,
    "skipPastEvents":        True,
    "smartNoiseFilter":      True,
    "enforceWhitelist":      False,
    "enforceBlacklist":      True,
    "defaultCategory":       "reminder",
    "defaultReminderLead":   1,
    "syncIntervalMinutes":   15,
    "autoSyncEnabled":       False,
    "notifyOnNewEvents":     True,
    "collapsePastInPreview": True,
    "groupByAccount":        False,
    "showAttachments":       True,
}

class ScanSettingsIn(BaseModel):
    scanWindowDays:        Optional[int]  = None
    maxEventsPerScan:      Optional[int]  = None
    autoSelectFuture:      Optional[bool] = None
    skipPastEvents:        Optional[bool] = None
    smartNoiseFilter:      Optional[bool] = None
    enforceWhitelist:      Optional[bool] = None
    enforceBlacklist:      Optional[bool] = None
    defaultCategory:       Optional[str]  = None
    defaultReminderLead:   Optional[int]  = None
    syncIntervalMinutes:   Optional[int]  = None
    autoSyncEnabled:       Optional[bool] = None
    notifyOnNewEvents:     Optional[bool] = None
    collapsePastInPreview: Optional[bool] = None
    groupByAccount:        Optional[bool] = None
    showAttachments:       Optional[bool] = None


@router.get("/scan-settings")
async def get_scan_settings(current_user=Depends(check_module_permission("email_accounts", "view"))):
    """Return the current user's email scan settings, falling back to defaults."""
    doc = await db[COL_SCAN_SETTINGS].find_one(
        {"user_id": str(current_user.id)}, {"_id": 0, "user_id": 0}
    )
    merged = {**DEFAULT_SCAN_SETTINGS, **(doc or {})}
    return merged


@router.put("/scan-settings")
async def upsert_scan_settings(
    body: ScanSettingsIn,
    current_user=Depends(check_module_permission("email_accounts", "create")),
):
    """Persist the user's email scan settings to MongoDB (upsert)."""
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="No settings provided")

    # Validate numeric ranges server-side so the DB is never in a bad state.
    errors: Dict[str, str] = {}
    if "scanWindowDays" in patch and not (1 <= patch["scanWindowDays"] <= 365):
        errors["scanWindowDays"] = "Must be 1–365"
    if "maxEventsPerScan" in patch and not (10 <= patch["maxEventsPerScan"] <= 1000):
        errors["maxEventsPerScan"] = "Must be 10–1000"
    if "syncIntervalMinutes" in patch and not (5 <= patch["syncIntervalMinutes"] <= 240):
        errors["syncIntervalMinutes"] = "Must be 5–240"
    if "defaultReminderLead" in patch and not (0 <= patch["defaultReminderLead"] <= 30):
        errors["defaultReminderLead"] = "Must be 0–30"
    if "defaultCategory" in patch and patch["defaultCategory"] not in ("reminder", "todo", "visit"):
        errors["defaultCategory"] = "Must be reminder, todo, or visit"
    if errors:
        raise HTTPException(status_code=422, detail=errors)

    await db[COL_SCAN_SETTINGS].update_one(
        {"user_id": str(current_user.id)},
        {"$set": {**patch, "user_id": str(current_user.id), "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    merged = {**DEFAULT_SCAN_SETTINGS, **patch}
    logger.info(f"Scan settings updated for user {current_user.id}: {list(patch.keys())}")
    return {"status": "ok", "settings": merged}


# =============================================================================
# API ROUTES — UTILITY / ADMIN
# =============================================================================

@router.post("/scan-now", status_code=202)
async def trigger_scan_now(current_user=Depends(check_module_permission("email_accounts", "create"))):
    """
    Manually trigger a full email scan + auto-save for the current user.
    Runs in the background — returns immediately with a confirmation.
    """
    prefs = await db[COL_AUTO_PREFS].find_one(
        {"user_id": str(current_user.id)}, {"_id": 0}
    ) or {}

    async def _bg():
        try:
            await _run_full_scan_for_user(str(current_user.id), prefs, limit=50)
            logger.info(f"Manual scan complete for user {current_user.id}")
        except Exception as e:
            logger.error(f"Manual scan error for user {current_user.id}: {e}")

    asyncio.create_task(_bg())
    return {"status": "scan_started", "message": "Scan running in background. Refresh in ~30 seconds."}


@router.post("/migrate-clean", status_code=200)
async def migrate_clean_descriptions(current_user=Depends(check_module_permission("email_accounts", "create"))):
    """
    One-time migration: strip HTML from any existing description/raw_snippet
    fields saved before v6 (when HTML was stored raw).
    Safe to run multiple times. Returns counts of updated records.
    """
    user_id  = str(current_user.id)
    counts   = {"events": 0, "todos": 0, "reminders": 0, "visits": 0}
    html_sig = re.compile(r"<(?:html|head|body|div|span|p|br|table|td|tr)[^>]*>", re.IGNORECASE)

    async def _clean_collection(col_name: str, fields: List[str]) -> int:
        updated = 0
        async for doc in db[col_name].find({"user_id": user_id}, {"_id": 1, **{f: 1 for f in fields}}):
            needs_update = False
            patch: Dict[str, str] = {}
            for field in fields:
                val = doc.get(field) or ""
                if val and html_sig.search(val):
                    cleaned = _clean_text(_html_to_text(val), 500)
                    patch[field] = cleaned
                    needs_update = True
            if needs_update:
                await db[col_name].update_one({"_id": doc["_id"]}, {"$set": patch})
                updated += 1
        return updated

    counts["events"]    = await _clean_collection(COL_EVENTS,   ["description", "raw_snippet"])
    counts["todos"]     = await _clean_collection("todos",       ["description"])
    counts["reminders"] = await _clean_collection("reminders",   ["description"])
    counts["visits"]    = await _clean_collection("visits",      ["notes"])

    logger.info(f"migrate-clean complete for user {user_id}: {counts}")
    return {"status": "ok", "updated": counts}


@router.post("/migrate-fix-ids", status_code=200)
async def migrate_fix_missing_ids(current_user=Depends(check_module_permission("email_accounts", "create"))):
    """
    v9 ONE-TIME MIGRATION — backfill missing string 'id' field.

    Auto-saved reminders, todos, and visits created by v8 and earlier were
    inserted WITHOUT a string 'id' field (only MongoDB ObjectId '_id' existed).
    The frontend DELETE and PATCH routes look up by the string 'id' field,
    so those operations returned 404.

    This endpoint sets id = str(_id) on every affected document.
    Safe to call multiple times — skips documents that already have 'id'.

    Call this ONCE after deploying v9, then you can remove it in v10.
    """
    user_id = str(current_user.id)
    counts  = {"reminders": 0, "todos": 0, "visits": 0}

    for col_name in ("reminders", "todos", "visits"):
        async for doc in db[col_name].find(
            {"user_id": user_id, "id": {"$exists": False}},
            {"_id": 1}
        ):
            await db[col_name].update_one(
                {"_id": doc["_id"]},
                {"$set": {"id": str(doc["_id"])}}
            )
            counts[col_name] += 1

    logger.info(f"migrate-fix-ids complete for user {user_id}: {counts}")
    return {"status": "ok", "backfilled": counts}


@router.get("/events/by-tm/{tm_app_no}", response_model=List[ExtractedEventOut])
async def get_events_by_tm_app_no(tm_app_no: str, current_user=Depends(check_module_permission("email_accounts", "view"))):
    """
    Fetch all extracted events for a specific TM application number.
    Useful for frontend to show full history of a trademark case.
    """
    docs = await db[COL_EVENTS].find(
        {"user_id": str(current_user.id), "tm_app_no": tm_app_no}
    ).sort("date", 1).to_list(50)
    return [_doc_to_out(d) for d in docs]


# =============================================================================
# ATTENDANCE / HOLIDAY / VISIT CARD INTEGRATION
# =============================================================================

@router.get("/attendance/today-summary")
async def attendance_today_summary(current_user=Depends(check_module_permission("email_accounts", "view"))):
    try:
        u_id = (
            str(current_user.id) if hasattr(current_user, "id")
            else str(current_user.get("id") or current_user.get("_id") or "")
            if isinstance(current_user, dict) else str(current_user)
        )
        today      = datetime.now(IST).strftime("%Y-%m-%d")
        week_later = (datetime.now(IST) + timedelta(days=7)).strftime("%Y-%m-%d")
        visits = await db["visits"].find({"user_id": u_id, "visit_date": today}, {"_id": 0}).to_list(20)
        reminders = await db["reminders"].find(
            {"user_id": u_id, "is_dismissed": {"$ne": True},
             "remind_at": {"$gte": today, "$lte": week_later + "T23:59:59"}},
            {"_id": 0}
        ).sort("remind_at", 1).to_list(20)
        return {
            "today": today,
            "visits_today": [
                {"title": v.get("title","Untitled"), "status": v.get("status","scheduled"),
                 "notes": v.get("notes") or ""} for v in visits
            ],
            "upcoming_reminders": [
                {"title": r.get("title","Untitled"), "remind_at": str(r.get("remind_at",""))}
                for r in reminders
            ],
        }
    except Exception as e:
        return {"today": datetime.now(IST).strftime("%Y-%m-%d"),
                "visits_today": [], "upcoming_reminders": [], "error": str(e)}

@router.get("/holidays/upcoming")
async def upcoming_holidays(current_user=Depends(check_module_permission("email_accounts", "view"))):
    try:
        u_id  = str(current_user.id) if hasattr(current_user, "id") else str(current_user)
        today = datetime.now(IST).strftime("%Y-%m-%d")
        events = await db[COL_EVENTS].find(
            {"user_id": u_id, "date": {"$gte": today},
             "event_type": {"$in": ["Court Hearing","Trademark Hearing","Deadline","Examination Report"]}},
            {"_id": 0, "title": 1, "date": 1, "event_type": 1, "id": 1, "tm_app_no": 1}
        ).sort("date", 1).limit(10).to_list(10)
        return {"events": [
            {"id": e.get("id",""), "title": e.get("title","Notice"),
             "date": e.get("date"), "event_type": e.get("event_type"),
             "tm_app_no": e.get("tm_app_no")} for e in events
        ]}
    except Exception as e:
        return {"events": [], "error": str(e)}


# ── Phase 11 Notification Engine Delegation ────────────────────────────────

class DelegateNotificationRequest(BaseModel):
    company_id: str
    user_id: str
    channel: str
    template_name: str
    context: Dict[str, Any]


@router.post("/delegate-notification")
async def delegate_notification_to_engine(
    body: DelegateNotificationRequest,
    current_user=Depends(check_module_permission("email_accounts", "view"))
):
    """Delegates a notification dispatch to Phase 11's centralized notification engine."""
    from backend.workflow.notification_engine import NotificationEngine
    result = await NotificationEngine.send_notification(
        company_id=body.company_id,
        user_id=body.user_id,
        channel=body.channel,
        template_name=body.template_name,
        context=body.context
    )
    return result


class EmailAttachmentScanner:
    @staticmethod
    async def process_and_meter_attachment(company_id: str, file_name: str, file_bytes: bytes) -> bool:
        """Processes and increments SaaS file storage and counts metric usage under active tenant."""
        from backend.platform.storage_manager import StorageManager
        from backend.licensing.usage_tracker import UsageTracker
        
        file_size = len(file_bytes)
        # 1. Enforce SaaS storage limit checks
        quota_ok = await StorageManager.check_storage_quota(company_id, file_size)
        if not quota_ok:
            logger.warning(f"Storage limit exceeded during email attachment processing for tenant {company_id}.")
            return False
            
        # 2. Allocate and record storage stats
        await StorageManager.record_storage_allocation(company_id, file_size)
        
        # 3. Track metered count
        await UsageTracker.track_metric_usage(company_id, "email_attachments_scanned", 1)
        logger.info(f"Email attachment '{file_name}' ({file_size} bytes) successfully processed and metered.")
        return True
