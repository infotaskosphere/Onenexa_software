from __future__ import annotations
import os
import uuid
import base64
import hashlib
import logging
import re
from datetime import datetime, timezone
from typing import Optional, List, Any
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Response
from pydantic import BaseModel, Field, ConfigDict, ValidationError
import pandas as pd
import io
from backend.dependencies import db, get_current_user, require_admin, check_module_permission
from backend.models import User

logger = logging.getLogger(__name__)

# ── Router ────────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/passwords", tags=["password-repository"])

# ── Encryption bootstrap ──────────────────────────────────────────────────────
# SECURITY: This module stores real client credentials (GST/MCA/portal
# passwords). It must NEVER derive its key from an unrelated secret
# (MONGO_URI), fall back to a hardcoded seed, or silently store passwords in
# a reversible, non-encrypted format (base64) if the crypto library is
# missing. Any of those would let anyone with DB or repo access decrypt every
# stored client password.
from cryptography.fernet import Fernet, MultiFernet, InvalidToken


def _coerce_fernet_key(raw: str) -> bytes:
    """Accept either a real Fernet key or any human-chosen passphrase."""
    raw = (raw or "").strip()
    try:
        key = raw.encode()
        Fernet(key)  # validate it's a proper Fernet key
        return key
    except Exception:
        # Derive a proper key deterministically from the passphrase itself
        # (never from another secret).
        return base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest())


_env_key = os.getenv("PASSWORD_REPO_KEY", "").strip()

if not _env_key:
    if os.getenv("ENV_MODE") == "production":
        raise RuntimeError(
            "PASSWORD_REPO_KEY environment variable is not set. Refusing to "
            "start in production without an explicit encryption key for the "
            "password vault. Generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    _env_key = Fernet.generate_key().decode()
    logger.warning(
        "PASSWORD_REPO_KEY not set — generated a random development-only "
        "key. Previously stored vault passwords will NOT decrypt, and this "
        "key will not survive a restart. Set PASSWORD_REPO_KEY in .env "
        "before deploying."
    )

_fernet_key = _coerce_fernet_key(_env_key)

# ── Key rotation support ──────────────────────────────────────────────────────
# The 422 "Password decryption failed — the encryption key may have changed"
# error happens when an entry was written with a *previous* key (e.g. the
# vault used PASSWORDS_SECRET_KEY earlier, or PASSWORD_REPO_KEY was rotated).
# Instead of failing, we now try every known historical key on read. Set
# PASSWORD_REPO_KEY_OLD (or a comma-separated PASSWORD_REPO_KEYS_OLD list) to
# the old value(s); PASSWORDS_SECRET_KEY is also tried automatically because
# earlier builds of this app used it. Whatever decrypts a record is
# transparently re-encrypted with the CURRENT key on the next save, so the old
# keys can be dropped once everything is migrated.
_legacy_raw: List[str] = []
for _name in ("PASSWORD_REPO_KEY_OLD", "PASSWORDS_SECRET_KEY", "PASSWORD_SECRET_KEY"):
    _v = os.getenv(_name, "").strip()
    if _v:
        _legacy_raw.append(_v)
for _v in (os.getenv("PASSWORD_REPO_KEYS_OLD", "") or "").split(","):
    _v = _v.strip()
    if _v:
        _legacy_raw.append(_v)

_all_keys: List[bytes] = [_fernet_key]
for _v in _legacy_raw:
    _k = _coerce_fernet_key(_v)
    if _k not in _all_keys:
        _all_keys.append(_k)

# MultiFernet encrypts with the FIRST key and decrypts with any of them.
_fernet = MultiFernet([Fernet(k) for k in _all_keys])
ENCRYPTION_AVAILABLE = True

DECRYPT_FAILED = "[decryption failed]"


def _encrypt(plain: str) -> str:
    if not plain:
        return ""
    return _fernet.encrypt(plain.encode()).decode()


def _decrypt(cipher: str) -> str:
    if not cipher:
        return ""
    try:
        # Tries the current key first, then every configured legacy key.
        return _fernet.decrypt(cipher.encode()).decode()
    except Exception:
        # Backward-compat: records written before Fernet existed here could be
        # plain base64. Recover them so they aren't lost; they get re-secured
        # by _reencrypt_if_stale()/the next save.
        try:
            decoded = base64.b64decode(cipher, validate=True).decode()
            if decoded and decoded.isprintable():
                return decoded
        except Exception:
            pass
        return DECRYPT_FAILED


def _is_current_key(cipher: str) -> bool:
    """True when `cipher` decrypts with the CURRENT (primary) key."""
    if not cipher:
        return False
    try:
        Fernet(_fernet_key).decrypt(cipher.encode())
        return True
    except Exception:
        return False


async def _reencrypt_if_stale(collection, query: dict, cipher: str, field: str = "password_encrypted") -> None:
    """
    Self-healing: if a record decrypted via a legacy key (or legacy base64),
    silently rewrite it with the current key so the error never comes back and
    the old keys can eventually be removed. Never raises.
    """
    try:
        if not cipher or _is_current_key(cipher):
            return
        plain = _decrypt(cipher)
        if not plain or plain == DECRYPT_FAILED:
            return
        await collection.update_one(query, {"$set": {field: _encrypt(plain)}})
    except Exception:  # pragma: no cover - best effort only
        logger.warning("Could not re-encrypt legacy password record", exc_info=True)


# ── Pydantic schemas ──────────────────────────────────────────────────────────
PORTAL_TYPES = [
    "MCA", "DGFT", "TRADEMARK", "GST", "INCOME_TAX", "TDS",
    "EPFO", "ESIC", "TRACES", "MSME", "RERA", "ROC", "OTHER",
]

DEPARTMENT_MAP = {
    "MCA": "ROC", "ROC": "ROC", "DGFT": "OTHER", "TRADEMARK": "TM",
    "GST": "GST", "INCOME_TAX": "IT", "TDS": "TDS", "EPFO": "ACC",
    "ESIC": "ACC", "TRACES": "TDS", "MSME": "MSME", "RERA": "OTHER",
    "OTHER": "OTHER",
}

HOLDER_TYPES = ["COMPANY", "DIRECTOR", "INDIVIDUAL", "PARTNER", "TRUSTEE", "OTHER"]
ALLOWED_SORT_FIELDS = {"portal_name", "created_at", "updated_at", "last_accessed_at"}

class PasswordEntryCreate(BaseModel):
    portal_name: str = Field(..., min_length=2, max_length=120)
    portal_type: str = "OTHER"
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None
    department: str = "OTHER"
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    holder_type: str = "COMPANY"
    holder_name: Optional[str] = None
    holder_pan: Optional[str] = None
    holder_din: Optional[str] = None
    mobile: Optional[str] = None
    trade_name: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = Field(default_factory=list)

class PasswordEntryUpdate(BaseModel):
    portal_name: Optional[str] = None
    portal_type: Optional[str] = None
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None
    department: Optional[str] = None
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    holder_type: Optional[str] = None
    holder_name: Optional[str] = None
    holder_pan: Optional[str] = None
    holder_din: Optional[str] = None
    mobile: Optional[str] = None
    trade_name: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None

class PasswordEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    portal_name: str
    portal_type: str = "OTHER"
    url: Optional[str] = None
    username: Optional[str] = None
    department: str = "OTHER"
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    holder_type: str = "COMPANY"
    holder_name: Optional[str] = None
    holder_pan: Optional[str] = None
    holder_din: Optional[str] = None
    mobile: Optional[str] = None
    trade_name: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = []
    created_by: str = ""
    created_by_name: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_accessed_at: Optional[str] = None
    has_password: bool = False

class PasswordRevealResponse(BaseModel):
    id: str
    username: Optional[str]
    password: str
    portal_name: str

class BulkImportResult(BaseModel):
    total_processed: int
    successful_imports: int
    failed_imports: int
    errors: List[dict]

class GoogleSheetLink(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    sheet_url: str = Field(..., min_length=10)
    sheet_type: str = "OTHER"
    description: Optional[str] = None

class GoogleSheetLinkUpdate(BaseModel):
    label: Optional[str] = None
    sheet_url: Optional[str] = None
    sheet_type: Optional[str] = None
    description: Optional[str] = None

# ── Helpers ───────────────────────────────────────────────────────────────────
def _get_user_perms(user: User) -> dict:
    if isinstance(user.permissions, dict):
        return user.permissions
    if user.permissions:
        try:
            return user.permissions.model_dump()
        except Exception:
            return {}
    return {}

def _can_view(user: User, entry: dict) -> bool:
    if user.role == "admin":
        return True
    perms = _get_user_perms(user)
    if not perms.get("can_view_passwords", False):
        return False
    if user.role == "manager":
        return entry.get("department") in (user.departments or [])
    allowed_depts = perms.get("view_password_departments", [])
    return (
        entry.get("department") in (user.departments or [])
        or entry.get("department") in (allowed_depts or [])
    )

def _can_reveal(user: User, entry: dict) -> bool:
    if user.role == "admin":
        return True
    perms = _get_user_perms(user)
    if not perms.get("can_view_passwords", False):
        return False
    allowed_depts = perms.get("view_password_departments", [])
    return (
        entry.get("department") in (user.departments or [])
        or entry.get("department") in (allowed_depts or [])
    )

def _can_edit(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = _get_user_perms(user)
    return perms.get("can_edit_passwords", False)

def _strip_sensitive(doc: dict) -> dict:
    """Remove encrypted password fields and set has_password flag safely."""
    doc = dict(doc)
    doc.pop("_id", None)
    doc.pop("password_encrypted", None)
    doc["has_password"] = bool(doc.get("_password_set", False))
    doc.pop("_password_set", None)
    # Ensure required fields always have safe defaults
    if not doc.get("id"):
        doc["id"] = str(uuid.uuid4())
    if not doc.get("portal_name"):
        doc["portal_name"] = "Unknown"
    if not doc.get("portal_type"):
        doc["portal_type"] = "OTHER"
    if not doc.get("department"):
        doc["department"] = "OTHER"
    if not doc.get("holder_type"):
        doc["holder_type"] = "COMPANY"
    if not doc.get("created_by"):
        doc["created_by"] = ""
    if not isinstance(doc.get("tags"), list):
        doc["tags"] = []
    return doc

def _match_contact_by_name(contact_persons: list, holder_name: str) -> Optional[dict]:
    """Find the best-matching contact_person for the given holder_name.
    Tries exact match first, then partial/contains match (case-insensitive).
    """
    if not holder_name or not contact_persons:
        return None
    needle = holder_name.strip().lower()
    # 1. Exact match
    for cp in contact_persons:
        if cp.get("name") and cp["name"].strip().lower() == needle:
            return cp
    # 2. Contains match
    for cp in contact_persons:
        name = (cp.get("name") or "").strip().lower()
        if name and (needle in name or name in needle):
            return cp
    return None

async def _autofill_from_client(
    client_id: Optional[str],
    client_name: Optional[str],
    holder_name: Optional[str],
    holder_din: Optional[str],
    mobile: Optional[str],
    holder_pan: Optional[str],
    username: Optional[str],
    trade_name: Optional[str],
) -> dict:
    """
    Fetch the client document and fill any blank fields from client data.
    Matches holder_name against contact_persons for director-specific DIN/mobile/email.
    Returns a dict with resolved values (only fills blanks, never overwrites).
    """
    result = {
        "client_name": client_name,
        "holder_din": holder_din,
        "mobile": mobile,
        "holder_pan": holder_pan,
        "username": username,
        "trade_name": trade_name,
    }

    if not client_id:
        return result

    try:
        client_doc = await db.clients.find_one(
            {"id": client_id},
            {"_id": 0, "company_name": 1, "phone": 1, "email": 1,
             "pan": 1, "contact_persons": 1}
        )
    except Exception as e:
        logger.warning(f"Could not fetch client {client_id} for autofill: {e}")
        return result

    if not client_doc:
        return result

    # Resolve client_name
    if not result["client_name"]:
        result["client_name"] = client_doc.get("company_name")

    # Resolve trade_name from company_name
    if not result["trade_name"]:
        result["trade_name"] = client_doc.get("company_name")

    contacts = client_doc.get("contact_persons") or []

    # Find the specific contact matching holder_name
    matched_contact = _match_contact_by_name(contacts, holder_name) if holder_name else None
    primary_contact = matched_contact or (contacts[0] if contacts else None)

    # Fill holder_din from matched contact > first contact
    if not result["holder_din"]:
        din = (matched_contact or {}).get("din") or (primary_contact or {}).get("din")
        if din:
            result["holder_din"] = str(din).strip()

    # Fill mobile from matched contact > client phone > first contact phone
    if not result["mobile"]:
        phone = (
            (matched_contact or {}).get("phone")
            or client_doc.get("phone")
            or (primary_contact or {}).get("phone")
        )
        if phone:
            result["mobile"] = str(phone).strip()

    # Fill username/email from matched contact > client email > first contact email
    if not result["username"]:
        email = (
            (matched_contact or {}).get("email")
            or client_doc.get("email")
            or (primary_contact or {}).get("email")
        )
        if email:
            result["username"] = str(email).strip()

    # Fill holder_pan from matched contact pan > client pan
    if not result["holder_pan"]:
        pan = (matched_contact or {}).get("pan") or client_doc.get("pan")
        if pan:
            result["holder_pan"] = str(pan).strip().upper()

    return result

def _extract_sheet_id(url: str) -> Optional[str]:
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url)
    return match.group(1) if match else None

def _extract_gid(url: str) -> Optional[str]:
    match = re.search(r"[#&?]gid=(\d+)", url)
    return match.group(1) if match else None

async def _fetch_sheet_as_csv(sheet_id: str, gid: Optional[str] = None) -> Optional[pd.DataFrame]:
    if gid:
        csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
    else:
        csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(csv_url, follow_redirects=True)
            resp.raise_for_status()
            df = pd.read_csv(io.StringIO(resp.text))
            return df
    except Exception as e:
        logger.error(f"Failed to fetch sheet {sheet_id} gid={gid}: {e}")
        return None

async def _get_all_sheet_tabs(sheet_id: str) -> List[dict]:
    try:
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, follow_redirects=True)
            html = resp.text
        tabs = []
        matches = re.findall(r'"gid"\s*:\s*"?(\d+)"?\s*,\s*"name"\s*:\s*"([^"]+)"', html)
        if not matches:
            matches = re.findall(r'name="([^"]+)"[^>]*data-sheet-id="(\d+)"', html)
        for gid, name in matches:
            tabs.append({"gid": gid, "name": name})
        return tabs
    except Exception as e:
        logger.error(f"Failed to get sheet tabs for {sheet_id}: {e}")
        return []

# ── STATIC / UTILITY ROUTES ───────────────────────────────────────────────────
@router.get("/portal-types")
async def get_portal_types(current_user: User = Depends(check_module_permission("password_vault", "view"))):
    return {
        "portal_types": PORTAL_TYPES,
        "department_map": DEPARTMENT_MAP,
        "holder_types": HOLDER_TYPES,
    }

@router.get("/clients-list")
async def get_clients_for_password(current_user: User = Depends(check_module_permission("password_vault", "view"))):
    query = {}
    if current_user.role != "admin":
        perms = _get_user_perms(current_user)
        if not perms.get("can_view_all_clients", False):
            query["$or"] = [
                {"assigned_to": current_user.id},
                {"assignments.user_id": current_user.id},
            ]
    clients = await db.clients.find(
        query,
        {"_id": 0, "id": 1, "company_name": 1, "phone": 1, "email": 1,
         "client_type": 1, "director_phone": 1, "contact_phone": 1,
         "director_name": 1, "contact_name": 1, "contact_persons": 1}
    ).sort("company_name", 1).to_list(2000)
    return clients

# ── GOOGLE SHEETS LINK ROUTES ─────────────────────────────────────────────────
@router.get("/sheet-links")
async def list_sheet_links(current_user: User = Depends(check_module_permission("password_vault", "view"))):
    links = await db.password_sheet_links.find({}, {"_id": 0}).sort("label", 1).to_list(200)
    return links

@router.post("/sheet-links", status_code=201)
async def add_sheet_link(
    data: GoogleSheetLink,
    current_user: User = Depends(require_admin),
):
    sheet_id = _extract_sheet_id(data.sheet_url)
    if not sheet_id:
        raise HTTPException(400, "Invalid Google Sheets URL — could not extract sheet ID")
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "label": data.label.strip(),
        "sheet_url": data.sheet_url.strip(),
        "sheet_id": sheet_id,
        "sheet_type": data.sheet_type.upper(),
        "description": data.description or None,
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    await db.password_sheet_links.insert_one(doc)
    doc.pop("_id", None)
    return doc

@router.put("/sheet-links/{link_id}", status_code=200)
async def update_sheet_link(
    link_id: str,
    data: GoogleSheetLinkUpdate,
    current_user: User = Depends(require_admin),
):
    existing = await db.password_sheet_links.find_one({"id": link_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Sheet link not found")
    updates: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if data.label is not None:
        updates["label"] = data.label.strip()
    if data.sheet_url is not None:
        sheet_id = _extract_sheet_id(data.sheet_url)
        if not sheet_id:
            raise HTTPException(400, "Invalid Google Sheets URL")
        updates["sheet_url"] = data.sheet_url.strip()
        updates["sheet_id"] = sheet_id
    if data.sheet_type is not None:
        updates["sheet_type"] = data.sheet_type.upper()
    if data.description is not None:
        updates["description"] = data.description or None
    await db.password_sheet_links.update_one({"id": link_id}, {"$set": updates})
    updated = await db.password_sheet_links.find_one({"id": link_id}, {"_id": 0})
    return updated

@router.delete("/sheet-links/{link_id}")
async def delete_sheet_link(
    link_id: str,
    current_user: User = Depends(require_admin),
):
    existing = await db.password_sheet_links.find_one({"id": link_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Sheet link not found")
    await db.password_sheet_links.delete_one({"id": link_id})
    return {"message": "Sheet link deleted"}

@router.post("/sheet-links/{link_id}/preview")
async def preview_sheet_data(
    link_id: str,
    current_user: User = Depends(check_module_permission("password_vault", "create")),
):
    link = await db.password_sheet_links.find_one({"id": link_id}, {"_id": 0})
    if not link:
        raise HTTPException(404, "Sheet link not found")
    sheet_id = link.get("sheet_id")
    sheet_type = link.get("sheet_type", "OTHER")
    tabs = await _get_all_sheet_tabs(sheet_id)
    gid_from_url = _extract_gid(link.get("sheet_url", ""))
    if sheet_type in ("ROC", "MCA") and tabs:
        all_dfs = []
        for tab in tabs:
            df = await _fetch_sheet_as_csv(sheet_id, tab["gid"])
            if df is not None and not df.empty:
                df["_sheet_tab"] = tab["name"]
                all_dfs.append(df)
        if not all_dfs:
            raise HTTPException(502, "Could not fetch any sheet data. Ensure the sheet is publicly shared.")
        merged = pd.concat(all_dfs, ignore_index=True)
        preview = merged.head(20).fillna("").to_dict(orient="records")
        return {
            "sheet_type": sheet_type,
            "tabs_found": [t["name"] for t in tabs],
            "tabs_fetched": len(all_dfs),
            "total_rows": len(merged),
            "columns": list(merged.columns),
            "preview": preview,
        }
    elif sheet_type == "GST" and tabs:
        last_tab = tabs[-1]
        df = await _fetch_sheet_as_csv(sheet_id, last_tab["gid"])
        if df is None or df.empty:
            raise HTTPException(502, "Could not fetch GST sheet data. Ensure the sheet is publicly shared.")
        preview = df.head(20).fillna("").to_dict(orient="records")
        return {
            "sheet_type": sheet_type,
            "tabs_found": [t["name"] for t in tabs],
            "tab_used": last_tab["name"],
            "total_rows": len(df),
            "columns": list(df.columns),
            "preview": preview,
        }
    else:
        df = await _fetch_sheet_as_csv(sheet_id, gid_from_url)
        if df is None or df.empty:
            raise HTTPException(502, "Could not fetch sheet data. Ensure the sheet is publicly shared (Anyone with link can view).")
        preview = df.head(20).fillna("").to_dict(orient="records")
        return {
            "sheet_type": sheet_type,
            "tabs_found": [t["name"] for t in tabs],
            "tab_used": "default",
            "total_rows": len(df),
            "columns": list(df.columns),
            "preview": preview,
        }

# ── TEMPLATE + BULK IMPORT ────────────────────────────────────────────────────
@router.get("/template", response_class=Response)
async def download_template(current_user: User = Depends(check_module_permission("password_vault", "view"))):
    if not _can_edit(current_user):
        raise HTTPException(403, "You do not have permission to download templates")
    template_columns = [
        "portal_name", "portal_type", "url", "username", "password_plain",
        "department", "holder_type", "holder_name", "holder_pan", "holder_din",
        "mobile", "trade_name", "client_name", "client_id", "notes", "tags"
    ]
    df = pd.DataFrame(columns=template_columns)
    example_rows = [
        {
            "portal_name": "Example GST Portal",
            "portal_type": "GST",
            "url": "https://www.gst.gov.in",
            "username": "example@gst.com",
            "password_plain": "SecurePassword123",
            "department": "GST",
            "holder_type": "COMPANY",
            "holder_name": "",
            "holder_pan": "",
            "holder_din": "",
            "mobile": "",
            "trade_name": "",
            "client_name": "Example Client Pvt Ltd",
            "client_id": "CL001",
            "notes": "GST login for quarterly filings",
            "tags": "GST,Client,Important"
        },
        {
            "portal_name": "MCA Director Login",
            "portal_type": "MCA",
            "url": "https://www.mca.gov.in",
            "username": "director@example.com",
            "password_plain": "DirectorPass@456",
            "department": "ROC",
            "holder_type": "DIRECTOR",
            "holder_name": "Rajesh Kumar",
            "holder_pan": "ABCPK1234D",
            "holder_din": "08123456",
            "mobile": "9876543210",
            "trade_name": "",
            "client_name": "Example Client Pvt Ltd",
            "client_id": "CL001",
            "notes": "MCA login for Director Rajesh Kumar",
            "tags": "MCA,Director,ROC"
        },
    ]
    for i, row in enumerate(example_rows):
        df.loc[i] = row
    output = io.BytesIO()
    df.to_excel(output, index=False, engine='openpyxl')
    output.seek(0)
    headers = {
        "Content-Disposition": "attachment; filename=password_template.xlsx",
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
    return Response(content=output.getvalue(), headers=headers)

@router.post("/bulk-import", response_model=BulkImportResult, status_code=200)
async def bulk_import_passwords(
    file: UploadFile = File(...),
    current_user: User = Depends(check_module_permission("password_vault", "create")),
):
    if not _can_edit(current_user):
        raise HTTPException(403, "You do not have permission to bulk import passwords")
    contents = await file.read()
    file_like_object = io.BytesIO(contents)
    df = None
    fname = file.filename or ""
    try:
        if fname.endswith(('.xlsx', '.xls')):
            df = pd.read_excel(file_like_object, engine='openpyxl')
        elif fname.endswith('.csv'):
            df = pd.read_csv(file_like_object)
        else:
            raise HTTPException(400, "Unsupported file type. Please upload an Excel (.xlsx, .xls) or CSV (.csv) file.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Failed to parse file: {str(e)}")

    required_columns = [
        "portal_name", "portal_type", "url", "username", "password_plain",
        "department", "client_name", "client_id", "notes", "tags"
    ]
    df.columns = df.columns.str.lower().str.strip()
    missing_columns = [col for col in required_columns if col not in df.columns]
    if missing_columns:
        raise HTTPException(400, f"Missing required columns in the file: {', '.join(missing_columns)}")

    total_processed = 0
    successful_imports = 0
    failed_imports = 0
    errors = []

    def clean(v):
        s = str(v).strip() if v is not None else ""
        return None if s.lower() in ("nan", "none", "") else s

    for index, row in df.iterrows():
        total_processed += 1
        try:
            client_name_val = str(row.get("client_name", "")).strip() or None
            client_id_val = str(row.get("client_id", "")).strip() or None
            if client_id_val and client_id_val.lower() in ("nan", "none", ""):
                client_id_val = None
            if client_name_val and client_name_val.lower() in ("nan", "none", ""):
                client_name_val = None

            holder_name_val = clean(row.get("holder_name"))
            holder_din_val = clean(row.get("holder_din"))
            mobile_val = clean(row.get("mobile"))
            holder_pan_val = clean(row.get("holder_pan"))
            username_val = clean(row.get("username"))
            trade_name_val = clean(row.get("trade_name"))

            # ── Autofill from client data (contact_persons matched by holder_name) ──
            filled = await _autofill_from_client(
                client_id=client_id_val,
                client_name=client_name_val,
                holder_name=holder_name_val,
                holder_din=holder_din_val,
                mobile=mobile_val,
                holder_pan=holder_pan_val,
                username=username_val,
                trade_name=trade_name_val,
            )
            client_name_val = filled["client_name"]

            def clean(v):
                s = str(v).strip() if v is not None else ""
                return None if s.lower() in ("nan", "none", "") else s

            entry_data = {
                "portal_name": str(row.get("portal_name", "")).strip(),
                "portal_type": str(row.get("portal_type", "OTHER")).upper(),
                "url": clean(row.get("url")),
                "username": filled["username"],
                "password_plain": clean(row.get("password_plain")),
                "department": str(row.get("department", "OTHER")).upper(),
                "holder_type": str(row.get("holder_type", "COMPANY")).upper() if clean(row.get("holder_type")) else "COMPANY",
                "holder_name": holder_name_val,
                "holder_pan": filled["holder_pan"],
                "holder_din": filled["holder_din"],
                "mobile": filled["mobile"],
                "trade_name": filled["trade_name"],
                "client_name": client_name_val,
                "client_id": client_id_val,
                "notes": clean(row.get("notes")),
                "tags": [t.strip() for t in str(row.get("tags", "")).split(',') if t.strip()] if isinstance(row.get("tags"), str) else [],
            }
            new_entry = PasswordEntryCreate(**entry_data)
            now = datetime.now(timezone.utc).isoformat()
            entry_id = str(uuid.uuid4())
            doc = {
                "id": entry_id,
                "portal_name": new_entry.portal_name,
                "portal_type": new_entry.portal_type,
                "url": new_entry.url,
                "username": new_entry.username,
                "password_encrypted": _encrypt(new_entry.password_plain or ""),
                "_password_set": bool(new_entry.password_plain),
                "department": new_entry.department,
                "holder_type": new_entry.holder_type,
                "holder_name": new_entry.holder_name,
                "holder_pan": new_entry.holder_pan,
                "holder_din": new_entry.holder_din,
                "mobile": new_entry.mobile,
                "trade_name": new_entry.trade_name,
                "client_name": new_entry.client_name,
                "client_id": new_entry.client_id,
                "notes": new_entry.notes,
                "tags": new_entry.tags,
                "created_by": current_user.id,
                "created_at": now,
                "updated_at": now,
                "last_accessed_at": now,
            }
            await db.passwords.insert_one(doc)
            await db.password_access_logs.insert_one({
                "id": str(uuid.uuid4()),
                "action": "BULK_CREATE",
                "entry_id": entry_id,
                "portal_name": new_entry.portal_name,
                "user_id": current_user.id,
                "user_name": current_user.full_name,
                "timestamp": now,
            })
            successful_imports += 1
        except ValidationError as e:
            failed_imports += 1
            errors.append({"row": index + 2, "error": e.errors(), "data": row.to_dict()})
        except Exception as e:
            failed_imports += 1
            errors.append({"row": index + 2, "error": str(e), "data": row.to_dict()})
    return {
        "total_processed": total_processed,
        "successful_imports": successful_imports,
        "failed_imports": failed_imports,
        "errors": errors
    }

# ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
@router.get("/admin/access-logs")
async def get_access_logs(
    entry_id: Optional[str] = Query(None),
    limit: int = Query(200, le=500),
    current_user: User = Depends(require_admin),
):
    query: dict = {}
    if entry_id:
        query["entry_id"] = entry_id
    logs = (
        await db.password_access_logs.find(query, {"_id": 0})
        .sort("timestamp", -1)
        .to_list(limit)
    )
    return logs

@router.get("/stats")
async def get_password_stats_user(current_user: User = Depends(check_module_permission("password_vault", "view"))):
    """Stats scoped to the current user's permitted departments."""
    p = getattr(current_user, 'permissions', None) or {}
    can_view = current_user.role == 'admin' or bool(p.get('can_view_passwords'))
    if not can_view:
        raise HTTPException(403, "Access denied")

    allowed_depts = p.get('password_departments') if isinstance(p, dict) else None
    if current_user.role == 'admin' or not allowed_depts:
        query: dict = {}
    else:
        query = {"department": {"$in": allowed_depts}}

    total = await db.passwords.count_documents(query)
    by_type: dict = {}
    docs = await db.passwords.find(query, {"_id": 0, "portal_type": 1}).to_list(5000)
    for d in docs:
        ptype = d.get("portal_type", "OTHER") or "OTHER"
        by_type[ptype] = by_type.get(ptype, 0) + 1
    return {"total": total, "by_portal_type": by_type}

@router.get("/admin/stats")
async def get_password_stats(current_user: User = Depends(require_admin)):
    total = await db.passwords.count_documents({})
    by_dept = {}
    by_type = {}
    by_holder = {}
    docs = await db.passwords.find(
        {},
        {"_id": 0, "department": 1, "portal_type": 1, "holder_type": 1}
    ).to_list(5000)
    for d in docs:
        dept = d.get("department", "OTHER") or "OTHER"
        ptype = d.get("portal_type", "OTHER") or "OTHER"
        holder = d.get("holder_type", "COMPANY") or "COMPANY"
        by_dept[dept] = by_dept.get(dept, 0) + 1
        by_type[ptype] = by_type.get(ptype, 0) + 1
        by_holder[holder] = by_holder.get(holder, 0) + 1
    return {
        "total": total,
        "by_department": by_dept,
        "by_portal_type": by_type,
        "by_holder_type": by_holder,
    }

# ── LIST + CREATE ─────────────────────────────────────────────────────────────
@router.get("", response_model=List[PasswordEntry])
async def list_passwords(
    department: Optional[str] = Query(None),
    portal_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    client_id: Optional[str] = Query(None),
    holder_type: Optional[str] = Query(None),

    # ✅ FIXED (MAIN ISSUE)
    sort_by: str = Query(default="created_at"),
    sort_order: str = Query(default="desc"),
    limit: int = Query(default=100),
    page: int = Query(default=1),

    current_user: User = Depends(check_module_permission("password_vault", "view")),
):
    query: dict = {}

    if department:
        query["department"] = department.upper()

    if portal_type:
        query["portal_type"] = portal_type.upper()

    if client_id:
        query["client_id"] = client_id

    if holder_type:
        query["holder_type"] = holder_type.upper()

    if search:
        safe = re.escape(search)
        query["$or"] = [
            {"portal_name": {"$regex": safe, "$options": "i"}},
            {"client_name": {"$regex": safe, "$options": "i"}},
            {"username": {"$regex": safe, "$options": "i"}},
            {"url": {"$regex": safe, "$options": "i"}},
            {"holder_name": {"$regex": safe, "$options": "i"}},
            {"holder_pan": {"$regex": safe, "$options": "i"}},
            {"holder_din": {"$regex": safe, "$options": "i"}},
            {"trade_name": {"$regex": safe, "$options": "i"}},
            {"mobile": {"$regex": safe, "$options": "i"}},
        ]

    # ✅ SAFE SORT (prevents crash + 422)
    sort_field = sort_by if sort_by in ALLOWED_SORT_FIELDS else "created_at"
    mongo_sort = 1 if sort_order.lower() == "asc" else -1

    # ✅ SAFE PAGINATION
    limit = max(1, min(limit, 500))
    page = max(1, page)
    skip = (page - 1) * limit

    try:
        raw = await db.passwords.find(query, {"_id": 0}) \
            .sort(sort_field, mongo_sort) \
            .skip(skip) \
            .limit(limit) \
            .to_list(length=limit)
    except Exception as e:
        logger.error(f"MongoDB query failed in list_passwords: {e}")
        raise HTTPException(500, "Database error while fetching passwords. Please try again.")

    # ✅ FIX N+1 QUERY
    user_ids = list(set([d.get("created_by") for d in raw if d.get("created_by")]))

    users = await db.users.find(
        {"id": {"$in": user_ids}},
        {"_id": 0, "id": 1, "full_name": 1}
    ).to_list(length=None)

    user_map = {u["id"]: u.get("full_name", "Unknown") for u in users}

    result = []

    for doc in raw:
        try:
            if not _can_view(current_user, doc):
                continue

            doc["created_by_name"] = user_map.get(doc.get("created_by"))

            doc = _strip_sensitive(doc)

            entry = PasswordEntry(**doc)
            result.append(entry)

        except Exception as e:
            logger.error(f"Skipping malformed password entry {doc.get('id', '?')}: {e}")
            continue

    return result


# Frontend compatibility: the application intentionally uses redirect_slashes=False,
# while the existing Password Vault client requests the collection URL with a
# trailing slash. Register the slash variant explicitly so GET /api/passwords/
# resolves to the same handler without changing global routing behavior.
router.add_api_route(
    "/",
    list_passwords,
    methods=["GET"],
    response_model=List[PasswordEntry],
    include_in_schema=False,
)


@router.post("", response_model=PasswordEntry, status_code=201)
async def create_password(
    data: PasswordEntryCreate,
    current_user: User = Depends(check_module_permission("password_vault", "create")),
):
    if not _can_edit(current_user):
        raise HTTPException(403, "You do not have permission to create passwords")

    # Autofill missing fields from linked client data (matches holder_name to contact_persons)
    filled = await _autofill_from_client(
        client_id=data.client_id,
        client_name=data.client_name,
        holder_name=(data.holder_name or "").strip() or None,
        holder_din=(data.holder_din or "").strip() or None,
        mobile=(data.mobile or "").strip() or None,
        holder_pan=(data.holder_pan or "").strip().upper() or None,
        username=(data.username or "").strip() or None,
        trade_name=(data.trade_name or "").strip() or None,
    )

    now = datetime.now(timezone.utc).isoformat()
    entry_id = str(uuid.uuid4())

    doc = {
        "id": entry_id,
        "portal_name": data.portal_name.strip(),
        "portal_type": (data.portal_type or "OTHER").upper(),
        "url": (data.url or "").strip() or None,
        "username": filled["username"],
        "password_encrypted": _encrypt(data.password_plain or ""),
        "_password_set": bool(data.password_plain),
        "department": (data.department or "OTHER").upper(),
        "holder_type": (data.holder_type or "COMPANY").upper(),
        "holder_name": (data.holder_name or "").strip() or None,
        "holder_pan": filled["holder_pan"],
        "holder_din": filled["holder_din"],
        "mobile": filled["mobile"],
        "trade_name": filled["trade_name"],
        "client_name": filled["client_name"] or None,
        "client_id": data.client_id or None,
        "notes": data.notes or None,
        "tags": data.tags or [],
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
        "last_accessed_at": now,
    }

    await db.passwords.insert_one(doc)

    await db.password_access_logs.insert_one({
        "id": str(uuid.uuid4()),
        "action": "CREATE",
        "entry_id": entry_id,
        "portal_name": data.portal_name,
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "timestamp": now,
    })

    doc = _strip_sensitive(dict(doc))  # ✅ FIX: no await
    doc["created_by_name"] = current_user.full_name

    return PasswordEntry(**doc)
# ── PARAMETERIZED ROUTES (must come LAST) ─────────────────────────────────────
@router.get("/{entry_id}", response_model=PasswordEntry)
async def get_password_entry(
    entry_id: str,
    current_user: User = Depends(check_module_permission("password_vault", "view")),
):
    doc = await db.passwords.find_one({"id": entry_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if not _can_view(current_user, doc):
        raise HTTPException(403, "Access denied")
    doc = _strip_sensitive(doc)
    return PasswordEntry(**doc)

@router.get("/{entry_id}/reveal", response_model=PasswordRevealResponse)
async def reveal_password(
    entry_id: str,
    current_user: User = Depends(check_module_permission("password_vault", "view")),
):
    doc = await db.passwords.find_one({"id": entry_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if not _can_reveal(current_user, doc):
        raise HTTPException(403, "You are not authorised to reveal this password")
    cipher = doc.get("password_encrypted", "")
    plain = _decrypt(cipher)
    if plain == DECRYPT_FAILED:
        raise HTTPException(
            422,
            "Password decryption failed — this entry was encrypted with a key "
            "this server does not have. Re-save the entry with the correct "
            "password, or set PASSWORD_REPO_KEY_OLD to the previous key so it "
            "can be migrated automatically.",
        )
    # Self-heal: entry decrypted with a legacy key → rewrite with current key.
    await _reencrypt_if_stale(db.passwords, {"id": entry_id}, cipher)
    now = datetime.now(timezone.utc).isoformat()
    await db.passwords.update_one(
        {"id": entry_id},
        {"$set": {"last_accessed_at": now}}
    )
    await db.password_access_logs.insert_one({
        "id": str(uuid.uuid4()),
        "action": "REVEAL",
        "entry_id": entry_id,
        "portal_name": doc.get("portal_name", ""),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "timestamp": now,
        "ip": None,
    })
    return {
        "id": entry_id,
        "username": doc.get("username"),
        "password": plain,
        "portal_name": doc.get("portal_name", ""),
    }

@router.put("/{entry_id}", response_model=PasswordEntry)
async def update_password_entry(
    entry_id: str,
    data: PasswordEntryUpdate,
    current_user: User = Depends(check_module_permission("password_vault", "create")),
):
    if not _can_edit(current_user):
        raise HTTPException(403, "You do not have permission to edit passwords")
    existing = await db.passwords.find_one({"id": entry_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Entry not found")
    now = datetime.now(timezone.utc).isoformat()
    updates: dict = {"updated_at": now}
    if data.portal_name is not None:
        updates["portal_name"] = data.portal_name.strip()
    if data.portal_type is not None:
        updates["portal_type"] = data.portal_type.upper()
    if data.url is not None:
        updates["url"] = data.url.strip() or None
    if data.username is not None:
        updates["username"] = data.username.strip() or None
    if data.password_plain is not None:
        updates["password_encrypted"] = _encrypt(data.password_plain)
        updates["_password_set"] = bool(data.password_plain)
    if data.department is not None:
        updates["department"] = data.department.upper()
    if data.holder_type is not None:
        updates["holder_type"] = data.holder_type.upper()
    if data.holder_name is not None:
        updates["holder_name"] = data.holder_name.strip() or None
    if data.holder_pan is not None:
        updates["holder_pan"] = data.holder_pan.strip().upper() or None
    if data.holder_din is not None:
        updates["holder_din"] = data.holder_din.strip() or None
    if data.mobile is not None:
        updates["mobile"] = data.mobile.strip() or None
    if data.trade_name is not None:
        updates["trade_name"] = data.trade_name.strip() or None
    if data.client_id is not None:
        updates["client_id"] = data.client_id or None
        if data.client_id:
            # Resolve client name + autofill blank fields from contact_persons
            holder_name_for_fill = (
                (data.holder_name or "").strip()
                or existing.get("holder_name", "")
            ) or None
            filled = await _autofill_from_client(
                client_id=data.client_id,
                client_name=data.client_name or existing.get("client_name"),
                holder_name=holder_name_for_fill,
                holder_din=data.holder_din or existing.get("holder_din"),
                mobile=data.mobile or existing.get("mobile"),
                holder_pan=data.holder_pan or existing.get("holder_pan"),
                username=data.username or existing.get("username"),
                trade_name=data.trade_name or existing.get("trade_name"),
            )
            if filled["client_name"] and not data.client_name:
                updates["client_name"] = filled["client_name"]
            # Only fill fields that are currently blank (don't overwrite user data)
            if filled["holder_din"] and not existing.get("holder_din") and data.holder_din is None:
                updates.setdefault("holder_din", filled["holder_din"])
            if filled["mobile"] and not existing.get("mobile") and data.mobile is None:
                updates.setdefault("mobile", filled["mobile"])
            if filled["holder_pan"] and not existing.get("holder_pan") and data.holder_pan is None:
                updates.setdefault("holder_pan", filled["holder_pan"])
            if filled["username"] and not existing.get("username") and data.username is None:
                updates.setdefault("username", filled["username"])
            if filled["trade_name"] and not existing.get("trade_name") and data.trade_name is None:
                updates.setdefault("trade_name", filled["trade_name"])
    if data.client_name is not None:
        updates["client_name"] = data.client_name or None
    if data.notes is not None:
        updates["notes"] = data.notes or None
    if data.tags is not None:
        updates["tags"] = data.tags
    await db.passwords.update_one({"id": entry_id}, {"$set": updates})
    await db.password_access_logs.insert_one({
        "id": str(uuid.uuid4()),
        "action": "UPDATE",
        "entry_id": entry_id,
        "portal_name": existing.get("portal_name", ""),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "timestamp": now,
    })
    updated = await db.passwords.find_one({"id": entry_id}, {"_id": 0})
    updated = _strip_sensitive(updated)
    return PasswordEntry(**updated)

@router.delete("/{entry_id}")
async def delete_password_entry(
    entry_id: str,
    current_user: User = Depends(check_module_permission("password_vault", "delete")),
):
    if current_user.role != "admin":
        raise HTTPException(403, "Only administrators can delete password entries")
    existing = await db.passwords.find_one({"id": entry_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Entry not found")
    await db.passwords.delete_one({"id": entry_id})
    now = datetime.now(timezone.utc).isoformat()
    await db.password_access_logs.insert_one({
        "id": str(uuid.uuid4()),
        "action": "DELETE",
        "entry_id": entry_id,
        "portal_name": existing.get("portal_name", ""),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "timestamp": now,
    })
    return {"message": f"Entry '{existing.get('portal_name')}' deleted successfully"}
