# CLIENT PORTAL BACKEND — GOOGLE DRIVE ROBUST V2
BACKEND_VERSION = "2.0.0-per-folder-drive"
# Per-folder credential selection + service-account retention + OAuth fallback.
"""
client_portal.py  –  Taskosphere Client Portal
================================================
Handles:
  • Client Portal user creation / credential management (by admin/staff)
  • Client login (separate JWT, role = "client")
  • Client-facing endpoints (tasks, documents, invoices, compliance view)
  • Google Drive folder listing & subfolder navigation for a client
  • Share-link generation with pre-auth token
"""

import uuid
import logging
import re
import random
import asyncio
import os
import tempfile
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Literal

from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
import io
from pydantic import BaseModel, EmailStr, Field
from passlib.context import CryptContext
try:
    from jose import jwt, JWTError
except ImportError:
    import jwt
    JWTError = getattr(jwt, "PyJWTError", Exception)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from backend.dependencies import (
    db,
    JWT_SECRET as SECRET_KEY,
    ALGORITHM,
    get_current_user,
    get_user_permissions,
)
from backend.models import User
from backend.platform_owner import is_platform_owner
# Reuse the same Brevo-backed OTP emailer the main-app forgot-password flow
# uses, so client portal password resets need no separate email infra.
from backend.auth_password_reset import _send_otp_email
# Client Portal Manager lives under the Taskosphere tab and is admin-granted
# per user (see MODULE_HIERARCHY["taskosphere"] in backend/models.py). This
# guard is applied to every STAFF-facing endpoint below (the ones that take
# `current_user: User = Depends(get_current_user)`); it does not touch the
# CLIENT-facing endpoints, which authenticate separately via
# get_current_portal_client and must stay reachable by actual clients.
from backend.governance_core import require_page
_client_portal_guard = require_page("taskosphere", "can_view_client_portal")

logger = logging.getLogger(__name__)


def _can_manage_portal(user: "User") -> bool:
    """
    Return True when the staff user may access portal-management endpoints.

    Allowed when:
      • role is "admin" or "manager" (always), OR
      • the user has been explicitly granted can_view_client_portal via the
        Permission Governance module.
    """
    if getattr(user, "role", None) in ("admin", "manager"):
        return True
    return bool(get_user_permissions(user).get("can_view_client_portal", False))


router = APIRouter(prefix="/client-portal", tags=["client-portal"])

# Google Drive calls are synchronous under the hood. Keep them capped so a
# folder upload cannot exhaust Render memory/threads and restart the instance.
DRIVE_LIST_SEMAPHORE = asyncio.Semaphore(3)
DRIVE_UPLOAD_SEMAPHORE = asyncio.Semaphore(1)

# ── password hashing ──────────────────────────────────────────────────────
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ── JWT helper (shared secret with main app) ──────────────────────────────
def create_client_token(data: dict, expires_minutes: int = 60 * 24 * 7) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)
    return jwt.encode({**data, "exp": expire, "sub_type": "client"}, SECRET_KEY, algorithm=ALGORITHM)

bearer_scheme = HTTPBearer(auto_error=False)

def _normalise_portal_status(value) -> str:
    """Return one of the three supported portal states."""
    value = str(value or "live").strip().lower()
    return value if value in {"live", "maintenance", "offline"} else "live"


async def _get_portal_status() -> str:
    """Read the current portal status directly from MongoDB.

    This is intentionally queried at request time rather than cached in the
    process so changing the Admin setting takes effect on every running
    Render instance without a restart/redeploy.
    """
    doc = await db.portal_settings.find_one({}, {"_id": 0, "portal_status": 1})
    return _normalise_portal_status((doc or {}).get("portal_status"))


def _portal_status_error(status_value: str) -> HTTPException:
    if status_value == "maintenance":
        return HTTPException(
            status_code=503,
            detail={
                "code": "PORTAL_MAINTENANCE",
                "status": "maintenance",
                "message": "The Client Portal is temporarily under maintenance. Please try again later.",
            },
        )
    return HTTPException(
        status_code=503,
        detail={
            "code": "PORTAL_OFFLINE",
            "status": "offline",
            "message": "The Client Portal is currently offline. Please try again later.",
        },
    )


async def get_current_portal_client(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
):
    """Validate the client JWT and enforce the current portal availability.

    The status check is deliberately inside the shared client dependency.
    That means an existing client session cannot bypass Maintenance/Offline
    mode by refreshing, opening a deep link, or calling a different portal API.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("sub_type") != "client":
            raise HTTPException(status_code=401, detail="Invalid token type")
        portal_id = payload.get("portal_id")
        if not portal_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    doc = await db.client_portal_users.find_one({"id": portal_id}, {"_id": 0})
    if not doc or not doc.get("is_active", True):
        raise HTTPException(status_code=401, detail="Portal account not found or disabled")

    portal_status = await _get_portal_status()
    if portal_status != "live":
        raise _portal_status_error(portal_status)

    return doc


# ── Password Vault sync ────────────────────────────────────────────────────
# Client Portal login passwords are stored bcrypt-hashed (irreversible) for
# actual authentication — that must never change. But admins need to be able
# to look the current password back up (to hand it to a client, re-share
# access, etc). So, alongside the hash, we also keep an *encrypted* (not
# hashed) copy using the same Fernet-based encryption the Password Vault
# already uses, and mirror it into the Password Vault as a "Client Portal"
# entry so it shows up there automatically too.
from backend.passwords import (
    _encrypt as _vault_encrypt,
    _decrypt as _vault_decrypt,
    _reencrypt_if_stale as _vault_reencrypt_if_stale,
)


async def _sync_portal_password(
    *,
    client_id: str,
    client_name: str,
    portal_username: str,
    plain_password: str,
    current_user: Optional[User] = None,
):
    """
    Store an encrypted (recoverable) copy of a client-portal password and
    upsert a matching Password Vault entry (Portal Type: Other, heading
    "Client Portal") so admins can find/retrieve it from either place.
    Safe to call repeatedly — updates the same vault entry instead of
    creating duplicates.
    """
    encrypted = _vault_encrypt(plain_password)

    await db.client_portal_users.update_one(
        {"client_id": client_id},
        {"$set": {"password_encrypted": encrypted}},
    )

    now = datetime.now(timezone.utc).isoformat()
    existing = await db.passwords.find_one(
        {"client_id": client_id, "_auto_client_portal": True}, {"_id": 0, "id": 1}
    )
    if existing:
        await db.passwords.update_one(
            {"id": existing["id"]},
            {"$set": {
                "username": portal_username,
                "password_encrypted": encrypted,
                "_password_set": True,
                "client_name": client_name,
                "updated_at": now,
            }},
        )
    else:
        await db.passwords.insert_one({
            "id": str(uuid.uuid4()),
            "portal_name": "Client Portal",
            "portal_type": "OTHER",
            "url": None,
            "username": portal_username,
            "password_encrypted": encrypted,
            "_password_set": True,
            "department": "OTHER",
            "holder_type": "COMPANY",
            "holder_name": None,
            "holder_pan": None,
            "holder_din": None,
            "mobile": None,
            "trade_name": None,
            "client_name": client_name,
            "client_id": client_id,
            "notes": "Auto-synced from Client Portal login setup.",
            "tags": ["client-portal"],
            "_auto_client_portal": True,
            "created_by": current_user.id if current_user else "system",
            "created_at": now,
            "updated_at": now,
            "last_accessed_at": now,
        })


# ═══════════════════════════════════════════════════════════════════════════
# Pydantic schemas
# ═══════════════════════════════════════════════════════════════════════════

class PortalUserCreate(BaseModel):
    client_id: str
    portal_username: str = Field(..., min_length=3, max_length=60)
    portal_password: str = Field(..., min_length=6)
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    # What data sections the client can see
    can_view_tasks: bool = True
    can_view_documents: bool = True
    can_view_invoices: bool = True
    can_view_compliance: bool = False
    # Google Drive folder id shared with this client (root folder for this client)
    google_drive_folder_id: Optional[str] = None
    google_drive_folder_name: Optional[str] = None  # human label shown in portal


class PortalUserUpdate(BaseModel):
    portal_password: Optional[str] = Field(None, min_length=6)
    display_name: Optional[str] = None
    is_active: Optional[bool] = None
    can_view_tasks: Optional[bool] = None
    can_view_documents: Optional[bool] = None
    can_view_invoices: Optional[bool] = None
    can_view_compliance: Optional[bool] = None
    google_drive_folder_id: Optional[str] = None
    google_drive_folder_name: Optional[str] = None


class PortalLoginRequest(BaseModel):
    username: str
    password: str


class PortalForgotPasswordRequest(BaseModel):
    # Accepts either the portal username or the email on file — client
    # doesn't need to remember which one was used to set up the account.
    username: str


class PortalResetPasswordRequest(BaseModel):
    username: str
    otp: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=6)


# ═══════════════════════════════════════════════════════════════════════════
# Admin / staff endpoints  (require main-app JWT)
# ═══════════════════════════════════════════════════════════════════════════


@router.post("/users", status_code=201, dependencies=[Depends(_client_portal_guard)])
async def create_portal_user(
    body: PortalUserCreate,
    current_user: User = Depends(get_current_user),
):
    """Create portal credentials for a client. Only admin/manager."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    # Verify client exists
    client_doc = await db.clients.find_one({"id": body.client_id}, {"_id": 0})
    if not client_doc:
        raise HTTPException(404, "Client not found")

    # Username must be unique
    existing = await db.client_portal_users.find_one(
        {"portal_username": body.portal_username.lower()}, {"_id": 0}
    )
    if existing:
        raise HTTPException(409, "Username already taken")

    # Auto-fill Drive folder if one was already created for this client
    # and the admin didn't explicitly provide one in the form
    drive_folder_id = _extract_folder_id(body.google_drive_folder_id)
    drive_folder_name = body.google_drive_folder_name
    if not drive_folder_id:
        saved = client_doc.get("drive_folder_id")
        if saved:
            drive_folder_id = saved
            drive_folder_name = (
                client_doc.get("drive_folder_name")
                or client_doc.get("company_name")
                or "My Documents"
            )

    portal_doc = {
        "id": str(uuid.uuid4()),
        "client_id": body.client_id,
        "portal_username": body.portal_username.lower(),
        "hashed_password": pwd_context.hash(body.portal_password),
        "email": body.email,
        "display_name": body.display_name or client_doc.get("company_name", ""),
        "is_active": True,
        "can_view_tasks": body.can_view_tasks,
        "can_view_documents": body.can_view_documents,
        "can_view_invoices": body.can_view_invoices,
        "can_view_compliance": body.can_view_compliance,
        "google_drive_folder_id": drive_folder_id,
        "google_drive_folder_name": drive_folder_name or client_doc.get("company_name") or "My Documents",
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.client_portal_users.insert_one(portal_doc)
    await _sync_portal_password(
        client_id=body.client_id,
        client_name=portal_doc["display_name"] or client_doc.get("company_name", ""),
        portal_username=portal_doc["portal_username"],
        plain_password=body.portal_password,
        current_user=current_user,
    )
    portal_doc.pop("hashed_password", None)
    portal_doc.pop("_id", None)
    return portal_doc


@router.get("/users", dependencies=[Depends(_client_portal_guard)])
async def list_portal_users(
    client_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """List all portal users (optionally filtered by client_id)."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    query = {}
    if client_id:
        query["client_id"] = client_id
    docs = await db.client_portal_users.find(query, {"_id": 0, "hashed_password": 0}).to_list(500)
    for d in docs:
        d["has_recoverable_password"] = bool(d.pop("password_encrypted", None))
    return docs


@router.put("/users/{portal_user_id}", dependencies=[Depends(_client_portal_guard)])
async def update_portal_user(
    portal_user_id: str,
    body: PortalUserUpdate,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    update: dict = {}
    if body.portal_password:
        update["hashed_password"] = pwd_context.hash(body.portal_password)
    if body.display_name is not None:
        update["display_name"] = body.display_name
    if body.is_active is not None:
        update["is_active"] = body.is_active
    if body.can_view_tasks is not None:
        update["can_view_tasks"] = body.can_view_tasks
    if body.can_view_documents is not None:
        update["can_view_documents"] = body.can_view_documents
    if body.can_view_invoices is not None:
        update["can_view_invoices"] = body.can_view_invoices
    if body.can_view_compliance is not None:
        update["can_view_compliance"] = body.can_view_compliance
    if body.google_drive_folder_id is not None:
        update["google_drive_folder_id"] = body.google_drive_folder_id
    if body.google_drive_folder_name is not None:
        update["google_drive_folder_name"] = body.google_drive_folder_name

    if not update:
        raise HTTPException(400, "Nothing to update")

    res = await db.client_portal_users.update_one({"id": portal_user_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(404, "Portal user not found")

    if body.portal_password:
        pu = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
        if pu:
            await _sync_portal_password(
                client_id=pu.get("client_id"),
                client_name=pu.get("display_name") or pu.get("client_name") or "",
                portal_username=pu.get("portal_username"),
                plain_password=body.portal_password,
                current_user=current_user,
            )
    return {"success": True}


# ═══════════════════════════════════════════════════════════════════════════
# BULK PASSWORD RESET  (Client Portal Manager → Password Reset shortcut)
# Gated by the dedicated `can_reset_client_passwords` permission ("Password
# Reset" in Access Governance). Admin always allowed.
# ═══════════════════════════════════════════════════════════════════════════

import csv
import secrets as _secrets
import string as _string

_PWD_ALPHABET = _string.ascii_uppercase + _string.ascii_lowercase + _string.digits


def _can_reset_passwords(user: "User") -> bool:
    if getattr(user, "role", None) == "admin":
        return True
    return bool(get_user_permissions(user).get("can_reset_client_passwords", False))


def _generate_portal_password(length: int = 12) -> str:
    length = max(8, min(length, 32))
    # Guarantee at least one upper, one lower and one digit.
    while True:
        pwd = "".join(_secrets.choice(_PWD_ALPHABET) for _ in range(length))
        if (any(c.islower() for c in pwd) and any(c.isupper() for c in pwd)
                and any(c.isdigit() for c in pwd)):
            return pwd


class BulkPasswordResetRequest(BaseModel):
    # Portal user ids to reset. Empty + all_users=True resets every account.
    portal_user_ids: List[str] = Field(default_factory=list)
    all_users: bool = False
    only_active: bool = True
    # Leave blank to auto-generate a strong unique password per client.
    new_password: Optional[str] = None
    password_length: int = 12


async def _reset_one_portal_user(pu: dict, new_password: str, current_user: User) -> dict:
    await db.client_portal_users.update_one(
        {"id": pu["id"]},
        {"$set": {
            "hashed_password": pwd_context.hash(new_password),
            "password_reset_at": datetime.now(timezone.utc).isoformat(),
            "password_reset_by": current_user.id,
        }},
    )
    await _sync_portal_password(
        client_id=pu.get("client_id"),
        client_name=pu.get("display_name") or pu.get("client_name") or "",
        portal_username=pu.get("portal_username"),
        plain_password=new_password,
        current_user=current_user,
    )
    return {
        "portal_user_id": pu["id"],
        "client_id": pu.get("client_id"),
        "client_name": pu.get("display_name") or pu.get("client_name") or "",
        "portal_username": pu.get("portal_username"),
        "email": pu.get("email"),
        "new_password": new_password,
    }


async def _select_portal_users(body: BulkPasswordResetRequest) -> List[dict]:
    query: dict = {}
    if not body.all_users:
        if not body.portal_user_ids:
            raise HTTPException(400, "Select at least one portal user, or set all_users=true")
        query["id"] = {"$in": body.portal_user_ids}
    if body.only_active:
        query["is_active"] = {"$ne": False}
    docs = await db.client_portal_users.find(query, {"_id": 0}).to_list(2000)
    if not docs:
        raise HTTPException(404, "No matching portal users found")
    return docs


@router.post("/users/bulk-reset-password", dependencies=[Depends(_client_portal_guard)])
async def bulk_reset_portal_passwords(
    body: BulkPasswordResetRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Reset the client-portal login password for many clients at once.

    Each account gets a freshly generated strong password (or the single
    `new_password` supplied). The bcrypt hash is stored for login and an
    encrypted recoverable copy is mirrored into the Password Vault, exactly
    like a single reset does — so this also repairs entries whose old
    encryption key is no longer available.
    """
    if not _can_reset_passwords(current_user):
        raise HTTPException(403, "You do not have the 'Password Reset' permission")

    docs = await _select_portal_users(body)
    results: List[dict] = []
    failures: List[dict] = []
    for pu in docs:
        try:
            new_password = body.new_password or _generate_portal_password(body.password_length)
            results.append(await _reset_one_portal_user(pu, new_password, current_user))
        except Exception as exc:  # keep going; report per-row
            logger.exception("Bulk portal password reset failed for %s", pu.get("id"))
            failures.append({
                "portal_user_id": pu.get("id"),
                "portal_username": pu.get("portal_username"),
                "error": str(exc),
            })

    await db.password_access_logs.insert_one({
        "id": str(uuid.uuid4()),
        "action": "BULK_PORTAL_RESET",
        "count": len(results),
        "failed": len(failures),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    return {
        "success": True,
        "reset_count": len(results),
        "failed_count": len(failures),
        "results": results,
        "failures": failures,
    }


@router.post("/users/bulk-reset-password/export", dependencies=[Depends(_client_portal_guard)])
async def export_bulk_reset_credentials(
    body: BulkPasswordResetRequest,
    current_user: User = Depends(get_current_user),
):
    """Same as bulk reset, but streams the new credentials back as a CSV file."""
    if not _can_reset_passwords(current_user):
        raise HTTPException(403, "You do not have the 'Password Reset' permission")

    data = await bulk_reset_portal_passwords(body, current_user)  # type: ignore[arg-type]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Client Name", "Portal Username", "Email", "New Password"])
    for r in data["results"]:
        writer.writerow([r["client_name"], r["portal_username"], r.get("email") or "", r["new_password"]])
    buf.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="client-portal-passwords-{stamp}.csv"'},
    )


@router.get("/users/password-reset-access", dependencies=[Depends(_client_portal_guard)])
async def portal_password_reset_access(current_user: User = Depends(get_current_user)):
    """Lets the UI show/hide the bulk reset shortcut."""
    return {"can_reset_passwords": _can_reset_passwords(current_user)}


@router.get("/users/{portal_user_id}/reveal-password", dependencies=[Depends(_client_portal_guard)])
async def reveal_portal_password(
    portal_user_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Admin: reveal the current plaintext client-portal password for a portal
    user (decrypted from the same recoverable copy mirrored into the
    Password Vault — the bcrypt hash used for actual login is never
    returned/decryptable).
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    pu = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not pu:
        raise HTTPException(404, "Portal user not found")
    encrypted = pu.get("password_encrypted")
    if not encrypted:
        raise HTTPException(
            404,
            "No recoverable password on file for this account yet — set/reset the "
            "password once to enable this.",
        )
    plain = _vault_decrypt(encrypted)
    if plain == "[decryption failed]":
        raise HTTPException(
            422,
            "Password decryption failed — this account was encrypted with a key "
            "this server does not have. Use Password Reset (bulk or single) to "
            "issue a fresh password, or set PASSWORD_REPO_KEY_OLD to the previous "
            "key so it can be migrated automatically.",
        )
    # Self-heal: re-encrypt with the current key when it came from a legacy key.
    await _vault_reencrypt_if_stale(
        db.client_portal_users, {"id": portal_user_id}, encrypted
    )
    return {
        "portal_username": pu.get("portal_username"),
        "password": plain,
    }


@router.delete("/users/{portal_user_id}", dependencies=[Depends(_client_portal_guard)])
async def delete_portal_user(
    portal_user_id: str,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    res = await db.client_portal_users.delete_one({"id": portal_user_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Portal user not found")
    return {"success": True}


# ═══════════════════════════════════════════════════════════════════════════
# Share-link endpoint  (admin generates a magic link or just returns the URL)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/users/{portal_user_id}/share-link", dependencies=[Depends(_client_portal_guard)])
async def get_share_link(
    portal_user_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Returns the portal login URL for this portal user.
    Also returns a pre-filled username hint so admins can share it easily.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    portal_user = await db.client_portal_users.find_one(
        {"id": portal_user_id}, {"_id": 0, "hashed_password": 0}
    )
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    return {
        "portal_url": "/client-portal",
        "username": portal_user["portal_username"],
        "display_name": portal_user.get("display_name", ""),
        "portal_user_id": portal_user_id,
        "is_active": portal_user.get("is_active", True),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Public endpoint  –  Client login (no main-app auth required)
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/login")
async def client_portal_login(body: PortalLoginRequest):
    # Enforce the same status at the API boundary. This prevents direct/API
    # login bypass when the public login page is stale or has not yet polled.
    portal_status = await _get_portal_status()
    if portal_status != "live":
        raise _portal_status_error(portal_status)

    doc = await db.client_portal_users.find_one(
        {"portal_username": body.username.lower()}, {"_id": 0}
    )
    if not doc or not pwd_context.verify(body.password, doc["hashed_password"]):
        raise HTTPException(401, "Invalid username or password")
    if not doc.get("is_active", True):
        raise HTTPException(403, "Account is disabled. Contact your account manager.")

    token = create_client_token({"portal_id": doc["id"], "client_id": doc["client_id"]})

    # Log login event
    await db.client_portal_activity.insert_one({
        "portal_user_id": doc["id"],
        "client_id": doc["client_id"],
        "event": "login",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    safe = {k: v for k, v in doc.items() if k != "hashed_password"}
    return {"access_token": token, "token_type": "bearer", "user": safe}


# ═══════════════════════════════════════════════════════════════════════════
# Public endpoints  –  Forgot / Reset password (no main-app auth required)
# ═══════════════════════════════════════════════════════════════════════════
# Mirrors backend/auth_password_reset.py's OTP flow used for staff accounts:
#   1. Client enters their portal username (or email) → we email a 6-digit
#      code to whatever address is on file for that account.
#   2. Client enters the code + a new password → account is updated.
# Both routes always return a generic success message so a bad actor can't
# use them to discover which usernames/emails exist in the system.
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/forgot-password")
async def portal_forgot_password(body: PortalForgotPasswordRequest):
    identifier = body.username.strip().lower()
    portal_user = await db.client_portal_users.find_one(
        {"$or": [{"portal_username": identifier}, {"email": identifier}]},
        {"_id": 0},
    )

    if portal_user and portal_user.get("is_active", True):
        # Prefer the email stored on the portal account; fall back to the
        # client's on-file email if the portal account itself has none.
        target_email = portal_user.get("email")
        if not target_email:
            client_doc = await db.clients.find_one(
                {"id": portal_user.get("client_id")}, {"_id": 0, "email": 1}
            )
            target_email = (client_doc or {}).get("email")

        if target_email:
            otp = str(random.randint(100000, 999999))
            expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()

            await db.client_portal_reset_tokens.delete_many({"portal_user_id": portal_user["id"]})
            await db.client_portal_reset_tokens.insert_one({
                "portal_user_id": portal_user["id"],
                "portal_username": portal_user["portal_username"],
                "token": otp,
                "expires_at": expires_at,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })

            subject = "Taskosphere Client Portal – Your Password Reset Code"
            email_body = (
                f"Hi {portal_user.get('display_name') or ''},\n\n"
                f"You requested to reset your Client Portal password.\n\n"
                f"Your 6-digit verification code is:\n\n"
                f"        {otp}\n\n"
                f"Enter this code on the portal to set a new password.\n"
                f"This code expires in 10 minutes.\n\n"
                f"If you did not request this, you can safely ignore this email — "
                f"your password will not be changed.\n\n"
                f"— Taskosphere"
            )

            try:
                await _send_otp_email(target_email, subject, email_body)
                logger.info(f"Client portal reset OTP sent for portal user {portal_user['id']}")
                await db.client_portal_activity.insert_one({
                    "portal_user_id": portal_user["id"],
                    "client_id": portal_user.get("client_id"),
                    "event": "forgot_password_requested",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as e:
                logger.error(f"Failed to send client portal reset OTP: {e}")
        else:
            logger.warning(
                f"Client portal forgot-password: no email on file for "
                f"portal user {portal_user.get('id')}"
            )

    # Always the same response — don't reveal whether the account exists.
    return {"message": "If that account exists, a verification code has been sent to the registered email."}


@router.post("/reset-password")
async def portal_reset_password(body: PortalResetPasswordRequest):
    identifier = body.username.strip().lower()
    portal_user = await db.client_portal_users.find_one(
        {"$or": [{"portal_username": identifier}, {"email": identifier}]},
        {"_id": 0},
    )
    if not portal_user:
        raise HTTPException(400, "Invalid or expired code.")

    record = await db.client_portal_reset_tokens.find_one(
        {"portal_user_id": portal_user["id"], "token": body.otp.strip()}
    )
    if not record:
        raise HTTPException(400, "Invalid or expired code.")

    try:
        expires_at = datetime.fromisoformat(record["expires_at"])
    except Exception:
        expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)

    if datetime.now(timezone.utc) > expires_at:
        await db.client_portal_reset_tokens.delete_many({"portal_user_id": portal_user["id"]})
        raise HTTPException(400, "Code has expired. Please request a new one.")

    hashed = pwd_context.hash(body.new_password)
    await db.client_portal_users.update_one(
        {"id": portal_user["id"]}, {"$set": {"hashed_password": hashed}}
    )
    await db.client_portal_reset_tokens.delete_many({"portal_user_id": portal_user["id"]})
    await _sync_portal_password(
        client_id=portal_user.get("client_id"),
        client_name=portal_user.get("display_name") or portal_user.get("client_name") or "",
        portal_username=portal_user.get("portal_username"),
        plain_password=body.new_password,
        current_user=None,
    )

    await db.client_portal_activity.insert_one({
        "portal_user_id": portal_user["id"],
        "client_id": portal_user.get("client_id"),
        "event": "password_reset",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    logger.info(f"Client portal password reset for portal user {portal_user['id']}")
    return {"message": "Password updated successfully. You can now sign in."}


# ═══════════════════════════════════════════════════════════════════════════
# Client-facing data endpoints  (require client portal JWT)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/me")
async def portal_me(portal_user=Depends(get_current_portal_client)):
    return portal_user


class PortalSelfUpdate(BaseModel):
    display_name: Optional[str] = None
    email: Optional[EmailStr] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = Field(None, min_length=6)


@router.put("/me")
async def update_portal_self(
    body: PortalSelfUpdate,
    portal_user=Depends(get_current_portal_client),
):
    """Allow a logged-in client to update their own display name, email, or password."""
    update: dict = {}

    if body.display_name is not None:
        update["display_name"] = body.display_name.strip() or portal_user.get("display_name", "")

    if body.email is not None:
        update["email"] = body.email

    if body.new_password:
        if not body.current_password:
            raise HTTPException(400, "Current password is required to set a new password.")
        doc = await db.client_portal_users.find_one({"id": portal_user["id"]}, {"_id": 0})
        if not doc or not pwd_context.verify(body.current_password, doc["hashed_password"]):
            raise HTTPException(400, "Current password is incorrect.")
        update["hashed_password"] = pwd_context.hash(body.new_password)

    if not update:
        raise HTTPException(400, "Nothing to update.")

    await db.client_portal_users.update_one({"id": portal_user["id"]}, {"$set": update})

    updated = await db.client_portal_users.find_one(
        {"id": portal_user["id"]}, {"_id": 0, "hashed_password": 0}
    )
    return updated


# Tasks store their "Department" classification (Edit Task modal →
# Classification → Department) using the lowercase codes from
# frontend/src/pages/Tasks.jsx's DEPARTMENTS list (e.g. "roc",
# "income_tax", "msme_smadhan"). The Contact Us helpline directory
# (Admin → Contact Details / PortalSettings.help_desk) and each staff
# member's User.departments tags use a different, uppercase code set
# (e.g. "ROC", "IT", "MSME") — see ContactDetails.jsx's DEPARTMENTS list.
# This maps the former onto the latter so a task tagged "roc" correctly
# surfaces the "ROC" helpline entry on the Client Portal.
TASK_CATEGORY_TO_HELPDESK_CODE = {
    "gst": "GST",
    "income_tax": "IT",
    "accounts": "ACC",
    "tds": "TDS",
    "roc": "ROC",
    "trademark": "TM",
    "msme_smadhan": "MSME",
    "fema": "FEMA",
    "dsc": "DSC",
    "other": "OTHER",
}


@router.get("/tasks")
async def portal_tasks(portal_user=Depends(get_current_portal_client)):
    if not portal_user.get("can_view_tasks"):
        raise HTTPException(403, "You don't have access to tasks")
    tasks = await db.tasks.find(
        {"client_id": portal_user["client_id"]},
        # Note: "description" is intentionally excluded — internal notes on a
        # task are not client-facing. Only the task header (title) plus
        # status/priority/due date and who it's assigned to are exposed.
        # "categories" IS included — that's the task's own "Department"
        # classification set in the Edit Task modal (e.g. ROC, GST, TDS),
        # which is what should drive the Contact Us match below, not the
        # assignee's general department tags.
        {"_id": 0, "title": 1, "status": 1, "due_date": 1, "priority": 1,
         "assigned_to": 1, "categories": 1, "created_at": 1}
    ).sort("created_at", -1).to_list(200)

    # Resolve assigned_to -> the assignee's display name. Also keep the
    # assignee's own department tags as a fallback for tasks that were
    # created before per-task classification existed / have no category set.
    user_ids = list({t["assigned_to"] for t in tasks if t.get("assigned_to")})
    user_map: dict = {}
    dept_map: dict = {}
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1, "departments": 1}
        ).to_list(500)
        user_map = {u["id"]: u.get("full_name", "") for u in users}
        dept_map = {u["id"]: (u.get("departments") or []) for u in users}
    for t in tasks:
        assignee_id = t.get("assigned_to", "")
        t["assigned_to_name"] = user_map.get(assignee_id, "")
        # Prefer the task's own Department classification (categories) —
        # this is what's set per-task in the Edit Task modal and is what
        # should determine which helpline shows on this specific task.
        # Translate its lowercase task-category codes to the helpline
        # directory's codes. Fall back to the assignee's general
        # department tags (already in the right code set) only if the
        # task itself has no category set.
        task_cats = t.pop("categories", None) or []
        mapped = [TASK_CATEGORY_TO_HELPDESK_CODE.get(c, c) for c in task_cats]
        t["assigned_to_departments"] = mapped or dept_map.get(assignee_id, [])

    return tasks


@router.get("/documents")
async def portal_documents(portal_user=Depends(get_current_portal_client)):
    if not portal_user.get("can_view_documents"):
        raise HTTPException(403, "You don't have access to documents")
    docs = await db.documents.find(
        {"client_id": portal_user["client_id"]},
        {"_id": 0, "name": 1, "doc_type": 1, "status": 1, "expiry_date": 1,
         "created_at": 1, "notes": 1}
    ).sort("created_at", -1).to_list(200)
    return docs


@router.get("/invoices")
async def portal_invoices(portal_user=Depends(get_current_portal_client)):
    if not portal_user.get("can_view_invoices"):
        raise HTTPException(403, "You don't have access to invoices")
    invoices = await db.invoices.find(
        {"client_id": portal_user["client_id"]},
        {"_id": 0, "invoice_number": 1, "invoice_date": 1, "due_date": 1,
         "total_amount": 1, "status": 1, "notes": 1}
    ).sort("invoice_date", -1).to_list(200)
    return invoices


@router.get("/compliance")
async def portal_compliance(portal_user=Depends(get_current_portal_client)):
    if not portal_user.get("can_view_compliance"):
        raise HTTPException(403, "You don't have access to compliance data")
    records = await db.compliances.find(
        {"client_id": portal_user["client_id"]},
        {"_id": 0, "compliance_name": 1, "due_date": 1, "status": 1,
         "filing_date": 1, "remarks": 1}
    ).sort("due_date", -1).to_list(200)
    return records


# ═══════════════════════════════════════════════════════════════════════════
# Google Drive helpers
# ═══════════════════════════════════════════════════════════════════════════


def _extract_folder_id(value):
    """
    Accept a bare Drive folder ID or any Google Drive share URL and
    return just the folder ID string. Returns None if value is empty.

    Examples:
      "1nYpYErhuHLGjYWaUUMt7ZDT2sFhAa7FB"                            -> same
      "https://drive.google.com/drive/folders/1nYp…?usp=drive_link"   -> "1nYp…"
      "https://drive.google.com/open?id=1nYp…"                        -> "1nYp…"
    """
    if not value:
        return None
    value = str(value).strip()
    m = re.search(r'/folders/([a-zA-Z0-9_-]+)', value)
    if m:
        return m.group(1)
    m = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', value)
    if m:
        return m.group(1)
    return value


def _fetch_drive_files_raw(folder_id: str, include_subfolders: bool = True) -> list:
    """
    Lists files and folders inside a given Drive folder.
    Returns both regular files and subfolders so the client can navigate.
    """
    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file

    if not _drive_configured():
        raise HTTPException(
            503,
            "Google Drive is not configured. Configure the Taskosphere Google Drive service account."
        )

    service = get_drive_service_for_folder(folder_id)
    result = service.files().list(
        q=f"'{folder_id}' in parents and trashed = false",
        fields="files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)",
        orderBy="folder,name",
        pageSize=500
    ).execute()
    return result.get("files", [])


def _get_folder_name(folder_id: str) -> str:
    """Get the display name of a Drive folder by its ID."""
    try:
        from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
        if not _drive_configured():
            return folder_id
        service = get_drive_service_for_folder(folder_id)
        result = service.files().get(fileId=folder_id, fields="id,name").execute()
        return result.get("name", folder_id)
    except Exception:
        return folder_id


# ═══════════════════════════════════════════════════════════════════════════
# Google Drive  –  Visibility management (admin)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/drive/admin/files/{portal_user_id}", dependencies=[Depends(_client_portal_guard)])
async def admin_list_drive_files(
    portal_user_id: str,
    folder_id: Optional[str] = Query(None, description="Subfolder ID to browse (defaults to client's root folder)"),
    current_user: User = Depends(get_current_user),
):
    """
    Admin endpoint – list ALL files in the portal user's linked Drive folder
    (or a subfolder), annotated with their current visibility setting.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    root_folder_id = portal_user.get("google_drive_folder_id")
    if not root_folder_id:
        return {"files": [], "message": "No Google Drive folder linked to this portal user."}

    # Browse the requested subfolder or fall back to root
    browse_id = folder_id if folder_id else root_folder_id

    loop = asyncio.get_running_loop()
    async with DRIVE_LIST_SEMAPHORE:
        files = await loop.run_in_executor(None, _fetch_drive_files_raw, browse_id)

    # Load existing visibility config
    vis_doc = await db.client_drive_visibility.find_one(
        {"portal_user_id": portal_user_id}, {"_id": 0}
    )
    hidden_ids: set = set(vis_doc.get("hidden_ids", [])) if vis_doc else set()

    for f in files:
        f["is_visible"] = f["id"] not in hidden_ids
        f["is_folder"] = f.get("mimeType") == "application/vnd.google-apps.folder"

    return {
        "files": files,
        "root_folder_id": root_folder_id,
        "current_folder_id": browse_id,
        "hidden_ids": list(hidden_ids),
        "portal_user_id": portal_user_id,
    }


class DriveVisibilityUpdate(BaseModel):
    hidden_ids: List[str] = Field(default_factory=list)


@router.put("/drive/admin/visibility/{portal_user_id}", dependencies=[Depends(_client_portal_guard)])
async def admin_update_drive_visibility(
    portal_user_id: str,
    body: DriveVisibilityUpdate,
    current_user: User = Depends(get_current_user),
):
    """Admin endpoint – save/update which Drive files are hidden for a portal user."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    await db.client_drive_visibility.update_one(
        {"portal_user_id": portal_user_id},
        {"$set": {
            "portal_user_id": portal_user_id,
            "client_id": portal_user["client_id"],
            "hidden_ids": list(set(body.hidden_ids)),
            "updated_by": current_user.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"success": True, "hidden_count": len(body.hidden_ids)}


@router.patch("/drive/admin/visibility/{portal_user_id}/toggle", dependencies=[Depends(_client_portal_guard)])
async def admin_toggle_single_file(
    portal_user_id: str,
    file_id: str = Query(..., description="Drive file ID to toggle"),
    visible: bool = Query(..., description="True = show, False = hide"),
    current_user: User = Depends(get_current_user),
):
    """Quick toggle for a single file – adds or removes from hidden_ids."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    if visible:
        await db.client_drive_visibility.update_one(
            {"portal_user_id": portal_user_id},
            {"$pull": {"hidden_ids": file_id},
             "$set": {"updated_by": current_user.id,
                      "updated_at": datetime.now(timezone.utc).isoformat(),
                      "client_id": portal_user["client_id"]}},
            upsert=True,
        )
    else:
        await db.client_drive_visibility.update_one(
            {"portal_user_id": portal_user_id},
            {"$addToSet": {"hidden_ids": file_id},
             "$set": {"updated_by": current_user.id,
                      "updated_at": datetime.now(timezone.utc).isoformat(),
                      "client_id": portal_user["client_id"]}},
            upsert=True,
        )
    return {"success": True, "file_id": file_id, "is_visible": visible}


@router.get("/drive/admin/visibility/{portal_user_id}/summary", dependencies=[Depends(_client_portal_guard)])
async def admin_visibility_summary(
    portal_user_id: str,
    current_user: User = Depends(get_current_user),
):
    """Returns the raw visibility config for a portal user."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    doc = await db.client_drive_visibility.find_one({"portal_user_id": portal_user_id}, {"_id": 0})
    return doc or {"portal_user_id": portal_user_id, "hidden_ids": []}


# ═══════════════════════════════════════════════════════════════════════════
# Google Drive  –  Client view with subfolder navigation
# ═══════════════════════════════════════════════════════════════════════════



# ═══════════════════════════════════════════════════════════════════════════
# Google Drive  –  Create predefined client folder structure (admin)
# ═══════════════════════════════════════════════════════════════════════════

DEFAULT_SUBFOLDERS = [
    "Documents", "Invoices", "Compliance",
    "Correspondence", "Reports", "Bank Statements",
]

# ═══════════════════════════════════════════════════════════════════════════
# Portal Settings  –  admin-configurable options (Client Portal -> Settings)
# ═══════════════════════════════════════════════════════════════════════════
# The Drive folder that ALL client folders/subfolders get created inside is
# no longer hard-coded in source. It is configured once by the admin on the
# Settings page (root_drive_folder) and read from the database from then on.

class PortalSettings(BaseModel):
    portal_name: Optional[str] = "Client Portal"
    welcome_message: Optional[str] = "Welcome to your client portal."
    allow_client_messages: Optional[bool] = True
    show_task_comments: Optional[bool] = True
    portal_status: Literal["live", "maintenance", "offline"] = "live"
    # Accepts either a bare Drive folder ID or a full share URL — normalised
    # to a bare ID before being saved. This is the single source of truth
    # for where client Drive folders get created. Lives in the "Advanced
    # Settings" tab now — kept here (unchanged) so nothing downstream that
    # reads root_drive_folder from the settings doc needs to change.
    root_drive_folder: Optional[str] = None
    # Data-URI (data:image/png;base64,....) of the portal logo, shown on the
    # client login screen and the client dashboard header. Kept small
    # (validated at upload time) so it can live directly on the settings
    # document instead of needing separate file storage/CDN.
    logo_url: Optional[str] = None
    # Department-wise helpline directory shown to clients on the portal's
    # "Contact Us" tab. Each entry: {department, phone, email, hours}.
    # Admin-editable from Client Portal Setting; publicly readable (no
    # sensitive data) so it also appears on the pre-login screen if needed.
    help_desk: Optional[List[Dict[str, str]]] = None
    # Individually-named contacts (e.g. "Manager", "Senior Manager") added
    # manually by admin. Each entry: {name, position, phone, email}. Shown
    # alongside the department helpline directory on Admin -> Contact
    # Details; not currently surfaced on the public/client-portal endpoint.
    people_contacts: Optional[List[Dict[str, str]]] = None


DEFAULT_HELP_DESK = [
    {"department": "General / Front Desk", "phone": "", "email": "", "hours": "Mon–Sat, 10:00 AM – 6:30 PM"},
    {"department": "Trademark & IP", "phone": "", "email": "", "hours": "Mon–Sat, 10:00 AM – 6:30 PM"},
    {"department": "Compliance & GST", "phone": "", "email": "", "hours": "Mon–Sat, 10:00 AM – 6:30 PM"},
    {"department": "Accounts & Invoicing", "phone": "", "email": "", "hours": "Mon–Sat, 10:00 AM – 6:30 PM"},
]


@router.get("/settings", dependencies=[Depends(_client_portal_guard)])
async def get_portal_settings(
    current_user: User = Depends(get_current_user),
):
    """Returns the saved portal settings (creates sane defaults if none saved yet)."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    doc = await db.portal_settings.find_one({}, {"_id": 0})
    if not doc:
        doc = PortalSettings().model_dump()
    if not doc.get("help_desk"):
        doc["help_desk"] = DEFAULT_HELP_DESK
    # Also resolve + attach the folder's display name/link so the UI can
    # show "MS ADVISORY... root folder" style confirmation without a
    # separate round trip.
    folder_id = _extract_folder_id(doc.get("root_drive_folder"))
    doc["root_drive_folder_id"] = folder_id
    doc["root_drive_folder_name"] = _get_folder_name(folder_id) if folder_id else None
    return doc


@router.put("/settings", dependencies=[Depends(_client_portal_guard)])
async def save_portal_settings(
    body: PortalSettings,
    current_user: User = Depends(get_current_user),
):
    """Saves (upserts) portal settings, including the root Drive folder."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    normalised_root = _extract_folder_id(body.root_drive_folder)

    # If a root folder was provided, verify it's actually reachable before
    # saving, so a typo/bad link doesn't silently break every future folder
    # creation. Skip the check if Drive isn't configured at all — settings
    # should still be saveable in that case.
    if normalised_root:
        try:
            from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
            if _drive_configured():
                service = get_drive_service_for_folder(normalised_root)
                service.files().get(fileId=normalised_root, fields="id,name").execute()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400, "Couldn't access that Drive folder. Check the link and make sure it's shared with the connected Google account.")

    update = body.model_dump()
    # Never persist an invalid/case-variant status. This is the authoritative
    # value consumed by both the client access guard and the public status API.
    update["portal_status"] = _normalise_portal_status(update.get("portal_status"))
    update["root_drive_folder"] = normalised_root or ""
    update["updated_by"] = current_user.id
    update["updated_at"] = datetime.now(timezone.utc).isoformat()

    await db.portal_settings.update_one({}, {"$set": update}, upsert=True)
    return {"success": True, "root_drive_folder_id": normalised_root}


@router.get("/public-settings")
async def get_public_portal_settings():
    """
    No-auth branding endpoint for the client-facing login screen and
    dashboard header — only exposes the handful of fields that are safe to
    show before a client signs in (name, welcome message, logo, whether the
    portal is live). Never returns root_drive_folder or anything internal.
    """
    doc = await db.portal_settings.find_one({}, {"_id": 0})
    if not doc:
        doc = PortalSettings().model_dump()
    return {
        "portal_name": doc.get("portal_name") or "Client Portal",
        "welcome_message": doc.get("welcome_message") or "Welcome to your client portal.",
        "logo_url": doc.get("logo_url") or None,
        "portal_status": _normalise_portal_status(doc.get("portal_status")),
        # Department helpline directory — safe to expose pre-login, no
        # internal/sensitive data. Falls back to sane defaults (empty
        # numbers) until the admin fills them in.
        "help_desk": doc.get("help_desk") or DEFAULT_HELP_DESK,
        "people_contacts": doc.get("people_contacts") or [],
    }


# Kept intentionally small — this is stored inline on the settings document
# as a data URI, not on disk/CDN, so we cap it well below Mongo's 16MB
# document limit and well below what's sensible to inline in a data URI.
MAX_LOGO_SIZE_BYTES = 1_500_000  # ~1.5 MB
ALLOWED_LOGO_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/svg+xml"}


@router.post("/settings/logo", dependencies=[Depends(_client_portal_guard)])
async def upload_portal_logo(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Uploads/replaces the portal logo shown on the client login page and dashboard."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_LOGO_TYPES:
        raise HTTPException(400, "Logo must be a PNG, JPG, WEBP or SVG image.")

    contents = await file.read()
    if len(contents) > MAX_LOGO_SIZE_BYTES:
        raise HTTPException(413, f"Logo must be smaller than {MAX_LOGO_SIZE_BYTES // 1_000_000} MB.")

    import base64
    encoded = base64.b64encode(contents).decode("ascii")
    data_uri = f"data:{content_type};base64,{encoded}"

    await db.portal_settings.update_one(
        {},
        {"$set": {
            "logo_url": data_uri,
            "logo_updated_by": current_user.id,
            "logo_updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"success": True, "logo_url": data_uri}


@router.delete("/settings/logo", dependencies=[Depends(_client_portal_guard)])
async def delete_portal_logo(
    current_user: User = Depends(get_current_user),
):
    """Removes the portal logo — the login/dashboard fall back to the default Taskosphere mark."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    await db.portal_settings.update_one({}, {"$set": {"logo_url": None}}, upsert=True)
    return {"success": True}


async def _resolve_settings_root_folder() -> Optional[str]:
    """Reads the admin-configured root Drive folder from Settings (if any)."""
    doc = await db.portal_settings.find_one({}, {"_id": 0, "root_drive_folder": 1})
    if doc and doc.get("root_drive_folder"):
        return _extract_folder_id(doc["root_drive_folder"])
    return None


async def _resolve_parent_folder_id(explicit: Optional[str] = None) -> Optional[str]:
    """
    Resolve which Drive folder new client folders should be created under.
    Priority: explicit value passed in > saved Folder Architect template's
    parent_folder_id (a per-template override) > the root Drive folder
    configured on the Settings page > None (Drive root — only if nothing
    has ever been configured anywhere).
    """
    explicit_id = _extract_folder_id(explicit)
    if explicit_id:
        return explicit_id
    tmpl = await db.portal_folder_template.find_one({}, {"_id": 0})
    if tmpl and tmpl.get("parent_folder_id"):
        return _extract_folder_id(tmpl["parent_folder_id"])
    return await _resolve_settings_root_folder()


# ═══════════════════════════════════════════════════════════════════════════
# All Clients  –  returns every client with their portal connection status
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/all-clients", dependencies=[Depends(_client_portal_guard)])
async def list_all_clients(
    current_user: User = Depends(get_current_user),
):
    """Returns all clients enriched with their portal connection status."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    clients = await db.clients.find({}, {"_id": 0}).to_list(2000)
    portal_users = await db.client_portal_users.find(
        {}, {"_id": 0, "hashed_password": 0}
    ).to_list(2000)

    portal_by_client: dict = {}
    for pu in portal_users:
        cid = pu.get("client_id")
        if cid:
            portal_by_client.setdefault(cid, []).append(pu)

    result = []
    for c in clients:
        cid = c.get("id", "")
        c["portal_users"] = portal_by_client.get(cid, [])
        c["has_portal"] = bool(c["portal_users"])
        c["has_drive"] = any(pu.get("google_drive_folder_id") for pu in c["portal_users"])
        result.append(c)

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Folder Template  –  save / load a reusable subfolder architecture
# ═══════════════════════════════════════════════════════════════════════════

class FolderTemplate(BaseModel):
    subfolders: List[str] = Field(default_factory=list)
    parent_folder_id: Optional[str] = None


@router.get("/folder-template", dependencies=[Depends(_client_portal_guard)])
async def get_folder_template(
    current_user: User = Depends(get_current_user),
):
    """Returns the saved folder architecture template."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    doc = await db.portal_folder_template.find_one({}, {"_id": 0})
    settings_root = await _resolve_settings_root_folder()
    if not doc:
        return {"subfolders": DEFAULT_SUBFOLDERS, "parent_folder_id": settings_root or ""}
    if not doc.get("parent_folder_id"):
        doc["parent_folder_id"] = settings_root or ""
    return doc


@router.put("/folder-template", dependencies=[Depends(_client_portal_guard)])
async def save_folder_template(
    body: FolderTemplate,
    current_user: User = Depends(get_current_user),
):
    """Saves (upserts) the folder architecture template."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    normalised_parent = _extract_folder_id(body.parent_folder_id)

    # Verify the folder is actually reachable before saving — otherwise a
    # typo'd/unshared link silently becomes the template's parent_folder_id,
    # which takes priority over the Settings root folder for every future
    # folder creation and fails with a 404 at creation time instead of here.
    if normalised_parent:
        try:
            from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
            if _drive_configured():
                service = get_drive_service_for_folder(normalised_parent)
                service.files().get(fileId=normalised_parent, fields="id,name").execute()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400, "Couldn't access that Drive folder. Check the link and make sure it's shared with the connected Google account.")

    await db.portal_folder_template.update_one(
        {},
        {"$set": {
            "subfolders": body.subfolders,
            "parent_folder_id": normalised_parent or "",
            "updated_by": current_user.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"success": True}


# ═══════════════════════════════════════════════════════════════════════════
# Drive Folder Creation  –  single + bulk
# ═══════════════════════════════════════════════════════════════════════════

async def _resolve_subfolders() -> List[str]:
    """
    Return the saved Folder Architect template's subfolders.

    IMPORTANT: an explicitly saved *empty* list (admin wants root-only
    folders, no subfolders) must be respected and NOT overridden by
    DEFAULT_SUBFOLDERS. We only fall back to the hard-coded defaults when
    no template has ever been saved at all (doc is None) — the previous
    `doc.get("subfolders")` truthiness check treated `[]` the same as
    "missing", which silently created the 6 default subfolders even when
    the Folder Architect UI showed "No subfolders yet".
    """
    doc = await db.portal_folder_template.find_one({}, {"_id": 0})
    if doc is not None and "subfolders" in doc:
        return doc["subfolders"]
    return DEFAULT_SUBFOLDERS


def _create_drive_folder_sync(
    service,
    client_name: str,
    parent_folder_id: Optional[str],
    subfolders: List[str],
    force_create: bool = True,
):
    """
    Synchronous helper that creates a root folder + subfolders in Drive.

    By default (force_create=True) this ALWAYS creates a brand-new root
    folder — it never searches for / reuses a pre-existing folder that
    happens to share the same name. That "find an existing folder and link
    to it" behaviour is intentionally reserved for the explicit Smart
    Connect flow (see /drive/search-folders + /clients/{id}/link-drive-folder),
    so that a same-named folder belonging to a different client (or created
    outside the app) is never silently attached to the wrong client here.

    Pass force_create=False to opt into the old reuse-if-exists behaviour.
    Returns a result dict.
    """
    # Accept full Drive URLs or bare IDs — always normalise to a bare ID
    parent_folder_id = _extract_folder_id(parent_folder_id)
    safe_name = client_name.strip()

    root_folder, created_root = None, False

    if not force_create:
        query_parts = [
            f"name='{safe_name}'",
            "mimeType='application/vnd.google-apps.folder'",
            "trashed=false",
        ]
        if parent_folder_id:
            query_parts.insert(0, f"'{parent_folder_id}' in parents")

        existing = service.files().list(
            q=" and ".join(query_parts),
            fields="files(id,name,webViewLink)",
            spaces="drive",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute().get("files", [])

        if existing:
            root_folder, created_root = existing[0], False

    if root_folder is None:
        root_meta = {"name": safe_name, "mimeType": "application/vnd.google-apps.folder"}
        if parent_folder_id:
            root_meta["parents"] = [parent_folder_id]
        root_folder = service.files().create(body=root_meta, fields="id,name,webViewLink").execute()
        created_root = True

    root_id = root_folder["id"]
    sub_created, sub_existing = [], []
    for sub_name in subfolders:
        sub_exists = service.files().list(
            q=f"'{root_id}' in parents and name='{sub_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields="files(id,name)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute().get("files", [])
        if sub_exists:
            sub_existing.append(sub_name)
        else:
            service.files().create(
                body={"name": sub_name, "mimeType": "application/vnd.google-apps.folder", "parents": [root_id]},
                fields="id",
                supportsAllDrives=True,
            ).execute()
            sub_created.append(sub_name)

    return {
        "success": True,
        "folder_id": root_id,
        "folder_name": safe_name,
        "folder_link": root_folder.get("webViewLink", ""),
        "created_root": created_root,
        "sub_folders_created": sub_created,
        "sub_folders_existing": sub_existing,
    }


class CreateFolderRequest(BaseModel):
    client_name: str
    client_id: str
    parent_folder_id: Optional[str] = None
    subfolders: Optional[List[str]] = None


@router.post("/drive/create-folders", dependencies=[Depends(_client_portal_guard)])
async def create_client_drive_folders(
    body: CreateFolderRequest,
    current_user: User = Depends(get_current_user),
):
    """Creates root + sub-folders in Drive using custom or template subfolders, auto-links to portal user."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    subfolders = body.subfolders if body.subfolders is not None else await _resolve_subfolders()

    # Always use company name from DB as the folder name
    client_doc = await db.clients.find_one({"id": body.client_id}, {"_id": 0, "company_name": 1, "name": 1})
    folder_name = (
        (client_doc.get("company_name") or client_doc.get("name") if client_doc else None)
        or body.client_name
    ).strip()

    parent_id = await _resolve_parent_folder_id(body.parent_folder_id)
    service = get_drive_service_for_folder(parent_id) if parent_id else _get_drive_service()
    result = _create_drive_folder_sync(service, folder_name, parent_id, subfolders, force_create=True)
    root_id = result["folder_id"]
    folder_link = result.get("folder_link", "")

    # Always save folder info to the clients collection so it persists
    # even if the portal user doesn't exist yet
    await db.clients.update_one(
        {"id": body.client_id},
        {"$set": {
            "drive_folder_id":   root_id,
            "drive_folder_name": folder_name,
            "drive_folder_link": folder_link,
        }},
    )

    # Also update portal user record if one already exists
    portal_user_doc = await db.client_portal_users.find_one({"client_id": body.client_id}, {"_id": 0})
    if portal_user_doc:
        await db.client_portal_users.update_one(
            {"client_id": body.client_id},
            {"$set": {
                "google_drive_folder_id":   root_id,
                "google_drive_folder_name": folder_name,
            }},
        )
    result["auto_linked_portal"] = bool(portal_user_doc)
    result["folder_name"] = folder_name
    return result


class BulkCreateFolderRequest(BaseModel):
    client_ids: Optional[List[str]] = None
    parent_folder_id: Optional[str] = None
    subfolders: Optional[List[str]] = None


@router.post("/drive/bulk-create-folders", dependencies=[Depends(_client_portal_guard)])
async def bulk_create_client_drive_folders(
    body: BulkCreateFolderRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Bulk-creates Drive folders for multiple clients (or all clients if client_ids is empty).
    Uses the saved folder template unless subfolders are explicitly provided.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    subfolders = body.subfolders if body.subfolders is not None else await _resolve_subfolders()

    # Resolve parent_folder_id: prefer explicit, else fall back to the saved
    # Folder Architect template, else the shared default folder.
    parent_id = await _resolve_parent_folder_id(body.parent_folder_id)
    service = get_drive_service_for_folder(parent_id) if parent_id else _get_drive_service()

    # Fetch clients
    query = {}
    if body.client_ids:
        query = {"id": {"$in": body.client_ids}}
    clients = await db.clients.find(query, {"_id": 0, "id": 1, "company_name": 1, "name": 1}).to_list(2000)

    results = []
    for client in clients:
        client_id = client.get("id", "")
        client_name = client.get("company_name") or client.get("name") or "Unknown"
        try:
            res = _create_drive_folder_sync(service, client_name, parent_id, subfolders, force_create=True)
            root_id = res["folder_id"]
            folder_link = res.get("folder_link", "")

            # Always persist folder info to the clients collection
            await db.clients.update_one(
                {"id": client_id},
                {"$set": {
                    "drive_folder_id":   root_id,
                    "drive_folder_name": client_name,
                    "drive_folder_link": folder_link,
                }},
            )

            # Also update existing portal user if one exists
            portal_user_doc = await db.client_portal_users.find_one({"client_id": client_id}, {"_id": 0})
            if portal_user_doc:
                await db.client_portal_users.update_one(
                    {"client_id": client_id},
                    {"$set": {
                        "google_drive_folder_id":   root_id,
                        "google_drive_folder_name": client_name,
                    }},
                )
            results.append({
                "client_id": client_id,
                "client_name": client_name,
                "success": True,
                "folder_id": root_id,
                "folder_link": folder_link,
                "auto_linked_portal": bool(portal_user_doc),
                "sub_folders_created": res.get("sub_folders_created", []),
            })
        except Exception as exc:
            results.append({"client_id": client_id, "client_name": client_name, "success": False, "error": str(exc)})

    return {
        "total": len(results),
        "succeeded": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Link Existing Drive Folder  –  admin links any pre-existing Drive folder
#   to a client without creating new folders.
#   Accepts: bare folder ID or any Google Drive share/view URL.
# ═══════════════════════════════════════════════════════════════════════════

class LinkExistingFolderRequest(BaseModel):
    folder_id_or_url: str          # paste either a folder ID or a full Drive URL
    folder_name: Optional[str] = None  # optional override; auto-fetched from Drive if blank


@router.put("/clients/{client_id}/link-drive-folder", dependencies=[Depends(_client_portal_guard)])
async def link_existing_drive_folder(
    client_id: str,
    body: LinkExistingFolderRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Link an **existing** Google Drive folder to a client.
    No new folders are created — only the stored folder ID is updated.

    The admin can paste:
      • A bare folder ID:  1nYpYErhuHLGjYWaUUMt7ZDT2sFhAa7FB
      • A share URL:       https://drive.google.com/drive/folders/1nYp…?usp=drive_link
      • An open URL:       https://drive.google.com/open?id=1nYp…

    After linking, the client's portal user(s) immediately gain access to that
    folder via the /drive/files and /drive/download endpoints.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    client_doc = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not client_doc:
        raise HTTPException(404, "Client not found")

    folder_id = _extract_folder_id(body.folder_id_or_url)
    if not folder_id:
        raise HTTPException(400, "Could not extract a valid folder ID from the provided value. "
                                 "Paste a folder ID or a Google Drive folder URL.")

    # Try to resolve the folder name from Drive if not explicitly provided
    folder_name = (body.folder_name or "").strip() or None
    if not folder_name:
        folder_name = _get_folder_name(folder_id)
    if not folder_name or folder_name == folder_id:
        # Fall back to company name if Drive lookup fails (no credentials / wrong scope)
        folder_name = client_doc.get("company_name") or client_doc.get("name") or "My Documents"

    folder_link = f"https://drive.google.com/drive/folders/{folder_id}"

    # Update the client record so the link persists even before a portal user exists
    await db.clients.update_one(
        {"id": client_id},
        {"$set": {
            "drive_folder_id":   folder_id,
            "drive_folder_name": folder_name,
            "drive_folder_link": folder_link,
        }},
    )

    # Also update every portal user linked to this client
    portal_users = await db.client_portal_users.find(
        {"client_id": client_id}, {"_id": 0, "id": 1}
    ).to_list(100)

    if portal_users:
        await db.client_portal_users.update_many(
            {"client_id": client_id},
            {"$set": {
                "google_drive_folder_id":   folder_id,
                "google_drive_folder_name": folder_name,
            }},
        )

    return {
        "success": True,
        "client_id": client_id,
        "folder_id": folder_id,
        "folder_name": folder_name,
        "folder_link": folder_link,
        "portal_users_updated": len(portal_users),
    }


# ── Admin: search Drive for existing folders by name ─────────────────────
# Powers "Smart Connect" — lets the admin find a folder that already exists
# in Drive (created outside Taskosphere) instead of having to know/paste its
# raw ID or share URL.

@router.get("/drive/admin/search-folders", dependencies=[Depends(_client_portal_guard)])
async def admin_search_drive_folders(
    query: str = Query(..., min_length=1, description="Folder name (or partial name) to search for"),
    current_user: User = Depends(get_current_user),
):
    """
    Search all of Drive for folders whose name contains `query`.
    Read-only preview — nothing is linked until the admin explicitly confirms.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    service = _get_drive_service()
    safe_query = query.replace("\\", "\\\\").replace("'", "\\'")
    q = (
        "mimeType = 'application/vnd.google-apps.folder' "
        "and trashed = false "
        f"and name contains '{safe_query}'"
    )
    try:
        result = service.files().list(
            q=q,
            fields="files(id,name,parents,webViewLink,modifiedTime)",
            orderBy="name",
            pageSize=25,
        ).execute()
    except Exception as exc:
        raise HTTPException(503, f"Could not search Google Drive: {exc}")

    folders = result.get("files", [])
    return {"query": query, "folders": folders, "total": len(folders)}


# ── Admin: browse any Drive folder (not tied to a portal user) ──────────────
# Useful for previewing a folder before linking it to a client.

@router.get("/drive/admin/browse", dependencies=[Depends(_client_portal_guard)])
async def admin_browse_drive_folder(
    folder_id: str = Query(..., description="Drive folder ID to list"),
    current_user: User = Depends(get_current_user),
):
    """
    Browse any Drive folder by ID so the admin can preview its contents
    before linking it to a client.  No portal user required.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    # Accept a bare folder ID OR a full Google Drive share URL — normalise to
    # a bare ID before hitting the Drive API. Without this, pasting a share
    # link (e.g. "https://drive.google.com/drive/u/4/folders/<id>") causes
    # the whole URL to be sent as the ID, which Drive rejects with a 404.
    resolved_folder_id = _extract_folder_id(folder_id)
    if not resolved_folder_id:
        raise HTTPException(400, "Please provide a valid Drive folder ID or share link.")

    try:
        files = _fetch_drive_files_raw(resolved_folder_id)
    except Exception as exc:
        raise HTTPException(503, f"Could not reach Google Drive: {exc}")

    for f in files:
        f["is_folder"] = f.get("mimeType") == "application/vnd.google-apps.folder"

    return {
        "folder_id": resolved_folder_id,
        "files": files,
        "total": len(files),
    }


@router.get("/drive/files")
async def portal_drive_files(
    folder_id: Optional[str] = Query(None, description="Subfolder to browse"),
    parent_folder_id: Optional[str] = Query(None, description="The parent folder that listed folder_id (for security validation)"),
    breadcrumb_json: Optional[str] = Query(None, description="JSON-encoded breadcrumb from client for continuity"),
    portal_user=Depends(get_current_portal_client),
):
    """
    Returns visible files/folders in the Google Drive folder linked to this client.
    Supports unlimited subfolder depth.

    Security model: instead of walking the Drive parent-chain (which can fail due to
    Drive API scope/permission quirks), we use a one-hop validation approach:
      - Root access: always allowed (no folder_id).
      - Subfolder access: the client must supply the parent_folder_id from which they
        navigated. We re-fetch that parent's listing and confirm folder_id is present
        and visible there. This means each hop is validated against its direct parent.
    """
    root_folder_id = portal_user.get("google_drive_folder_id")
    if not root_folder_id:
        return {
            "files": [],
            "folders": [],
            "breadcrumb": [],
            "message": "No Google Drive folder has been linked to your account. Please contact your account manager.",
        }

    root_name = portal_user.get("google_drive_folder_name") or "My Documents"
    browse_id = root_folder_id
    breadcrumb = [{"id": root_folder_id, "name": root_name}]

    # Load visibility config once
    vis_doc = await db.client_drive_visibility.find_one(
        {"portal_user_id": portal_user["id"]}, {"_id": 0}
    )
    hidden_ids: set = set(vis_doc.get("hidden_ids", [])) if vis_doc else set()

    if folder_id and folder_id != root_folder_id:
        # Determine which parent to validate against
        validate_parent = parent_folder_id if parent_folder_id else root_folder_id

        try:
            parent_files = _fetch_drive_files_raw(validate_parent)
        except Exception:
            return {"files": [], "folders": [], "breadcrumb": breadcrumb,
                    "error": "Could not reach Google Drive."}

        # Check folder_id is a visible folder in the parent listing
        visible_folder_ids = {
            f["id"] for f in parent_files
            if f.get("mimeType") == "application/vnd.google-apps.folder"
            and f["id"] not in hidden_ids
        }

        if folder_id in visible_folder_ids:
            browse_id = folder_id
            # Get folder name from parent listing
            folder_name = next((f["name"] for f in parent_files if f["id"] == folder_id), folder_id)
            # Rebuild breadcrumb: parse existing client breadcrumb + append new entry
            try:
                import json as _json
                existing_crumbs = _json.loads(breadcrumb_json) if breadcrumb_json else []
                # Ensure root is always first
                if not existing_crumbs or existing_crumbs[0].get("id") != root_folder_id:
                    existing_crumbs = [{"id": root_folder_id, "name": root_name}]
                breadcrumb = existing_crumbs + [{"id": folder_id, "name": folder_name}]
            except Exception:
                breadcrumb = [{"id": root_folder_id, "name": root_name},
                              {"id": folder_id, "name": folder_name}]
        else:
            # Not found as a visible folder — fall back to root
            browse_id = root_folder_id

    try:
        all_files = _fetch_drive_files_raw(browse_id)
    except HTTPException as e:
        if e.status_code == 503:
            return {"files": [], "folders": [], "breadcrumb": breadcrumb,
                    "message": "Google Drive integration not configured. Contact support."}
        # Log the real cause (e.g. expired/revoked OAuth refresh token) for
        # the admin, but never show internal auth/reconnect instructions to
        # the client — they can't act on those anyway.
        logger.error(f"Drive fetch failed for portal user {portal_user.get('id')}: {e.detail}")
        return {"files": [], "folders": [], "breadcrumb": breadcrumb,
                "error": "Your documents are temporarily unavailable. Please contact your "
                         "account manager if this continues."}
    except Exception as e:
        logger.warning(f"Drive fetch error for client: {e}")
        return {"files": [], "folders": [], "breadcrumb": breadcrumb,
                "error": "Could not reach Google Drive."}

    visible_all = [f for f in all_files if f["id"] not in hidden_ids]
    folders = [f for f in visible_all if f.get("mimeType") == "application/vnd.google-apps.folder"]
    files   = [f for f in visible_all if f.get("mimeType") != "application/vnd.google-apps.folder"]

    return {
        "files": files,
        "folders": folders,
        "breadcrumb": breadcrumb,
        "root_folder_id": root_folder_id,
        "current_folder_id": browse_id,
    }


# ── Google Drive proxy download ───────────────────────────────────────────────
# Files stored in Drive are private; direct /uc?export=download URLs return 403
# for any viewer who isn't logged into the owning Google account.
# This endpoint fetches the file bytes via the server's authenticated Drive
# service and streams them straight to the client.

EXPORT_MIME_MAP = {
    "application/vnd.google-apps.document":     ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet":  (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.form":         ("application/pdf", ".pdf"),
}

# MIME types the browser can render natively inside an <img>/<iframe> preview.
PREVIEWABLE_INLINE_MIMES = {
    "application/pdf",
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/bmp",
}

@router.get("/drive/download")
async def portal_drive_download(
    file_id: str = Query(..., description="Drive file ID to download"),
    token: Optional[str] = Query(None, description="Portal JWT (for direct browser downloads via <a>/window.open)"),
    disposition: str = Query("attachment", description="'attachment' forces a download, 'inline' renders in-browser for previewable types (images/PDF)"),
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
):
    """
    Proxy-downloads a Drive file through the backend using the server's OAuth
    credentials, so the client never needs their own Google account access.

    Auth: accepts EITHER an Authorization: Bearer <token> header (normal API
    calls) OR a ?token=<jwt> query param (needed when the browser opens the
    URL directly via window.open / <a href> — those cannot set headers).
    """
    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file

    # Resolve JWT from header or query param
    raw_token = credentials.credentials if credentials else token
    if not raw_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(raw_token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("sub_type") != "client":
            raise HTTPException(status_code=401, detail="Invalid token type")
        portal_id = payload.get("portal_id")
        if not portal_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    portal_user = await db.client_portal_users.find_one({"id": portal_id}, {"_id": 0})
    if not portal_user or not portal_user.get("is_active", True):
        raise HTTPException(status_code=401, detail="Portal account not found or disabled")

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    # Verify this file is not hidden for the client
    vis_doc = await db.client_drive_visibility.find_one(
        {"portal_user_id": portal_user["id"]}, {"_id": 0}
    )
    hidden_ids: set = set(vis_doc.get("hidden_ids", [])) if vis_doc else set()
    if file_id in hidden_ids:
        raise HTTPException(403, "You do not have access to this file.")

    try:
        service = get_drive_service_for_file(file_id)

        # Get file metadata to determine name and mimeType
        meta = service.files().get(
            fileId=file_id,
            fields="id,name,mimeType,size"
        ).execute()

        mime_type = meta.get("mimeType", "application/octet-stream")
        file_name = meta.get("name", file_id)

        # Google Workspace files (Docs/Sheets/Slides) can only be exported, not downloaded
        if mime_type in EXPORT_MIME_MAP:
            export_mime, ext = EXPORT_MIME_MAP[mime_type]
            request = service.files().export_media(fileId=file_id, mimeType=export_mime)
            if not file_name.endswith(ext):
                file_name += ext
            content_type = export_mime
        else:
            request = service.files().get_media(fileId=file_id)
            content_type = mime_type

        # Download into memory buffer (streaming from Drive API)
        import googleapiclient.http as gapi_http
        buf = io.BytesIO()
        downloader = gapi_http.MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        buf.seek(0)

        # Sanitise filename for Content-Disposition header
        safe_name = file_name.replace('"', "'")

        # Only honour "inline" for types the browser can actually render
        # (images / PDF). Everything else always downloads as an attachment.
        use_inline = disposition == "inline" and content_type in PREVIEWABLE_INLINE_MIMES
        disposition_value = "inline" if use_inline else "attachment"

        return StreamingResponse(
            buf,
            media_type=content_type,
            headers={
                "Content-Disposition": f'{disposition_value}; filename="{safe_name}"',
                "Cache-Control": "no-store",
                "Content-Length": str(buf.getbuffer().nbytes),
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Drive download error for file {file_id}: {e}", exc_info=True)
        raise HTTPException(500, "Failed to download file from Google Drive.")


@router.get("/drive/admin/download", dependencies=[Depends(_client_portal_guard)])
async def admin_drive_download(
    file_id: str = Query(..., description="Drive file ID to download"),
    current_user: User = Depends(get_current_user),
):
    """
    Admin/manager equivalent of /drive/download — lets Client Portal Manager
    pull a file's bytes straight through the server's Drive credentials
    (used by the "Download all" quick action so staff don't have to open
    every file one-by-one in a new Drive tab).
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    try:
        service = get_drive_service_for_file(file_id)
        meta = service.files().get(fileId=file_id, fields="id,name,mimeType,size", supportsAllDrives=True).execute()
        mime_type = meta.get("mimeType", "application/octet-stream")
        file_name = meta.get("name", file_id)

        if mime_type in EXPORT_MIME_MAP:
            export_mime, ext = EXPORT_MIME_MAP[mime_type]
            request = service.files().export_media(fileId=file_id, mimeType=export_mime)
            if not file_name.endswith(ext):
                file_name += ext
            content_type = export_mime
        else:
            request = service.files().get_media(fileId=file_id)
            content_type = mime_type

        import googleapiclient.http as gapi_http
        buf = io.BytesIO()
        downloader = gapi_http.MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        buf.seek(0)

        safe_name = file_name.replace('"', "'")
        return StreamingResponse(
            buf,
            media_type=content_type,
            headers={
                "Content-Disposition": f'attachment; filename="{safe_name}"',
                "Cache-Control": "no-store",
                "Content-Length": str(buf.getbuffer().nbytes),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Admin drive download error for file {file_id}: {e}", exc_info=True)
        raise HTTPException(500, "Failed to download file from Google Drive.")

# ═══════════════════════════════════════════════════════════════════════════
# Portal Messages  –  Admin sends, Client reads
# ═══════════════════════════════════════════════════════════════════════════

class PortalMessageCreate(BaseModel):
    to_portal_user_id: str
    subject: Optional[str] = None
    body: str
    message_type: Optional[str] = "general"   # general | dsc_expiry | compliance_due | invoice_reminder | custom

@router.get("/messages", dependencies=[Depends(_client_portal_guard)])
async def list_messages_admin(current_user: User = Depends(get_current_user)):
    """Admin: list all portal messages (scoped to this deployment)."""
    query = {} if is_platform_owner(current_user) else {"org_id": getattr(current_user, "company_id", None)}
    docs = await db.portal_messages.find(
        query, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    return docs

@router.post("/messages", status_code=201, dependencies=[Depends(_client_portal_guard)])
async def send_portal_message(
    payload: PortalMessageCreate,
    current_user: User = Depends(get_current_user),
):
    """Admin: send a message to a portal client."""
    try:
        portal_user = await db.client_portal_users.find_one({"id": payload.to_portal_user_id}, {"_id": 0})
        if not portal_user:
            raise HTTPException(404, "Portal user not found")

        # Try to fetch client name from clients collection as fallback
        client_name = portal_user.get("client_name") or portal_user.get("display_name") or ""
        client_id = portal_user.get("client_id")
        if client_id and not client_name:
            client_doc = await db.clients.find_one({"id": client_id}, {"_id": 0, "company_name": 1, "name": 1})
            if client_doc:
                client_name = client_doc.get("company_name") or client_doc.get("name") or ""

        from_name = ""
        try:
            from_name = current_user.full_name or current_user.email or ""
        except Exception:
            from_name = "Team"

        msg = {
            "id": str(uuid.uuid4()),
            "org_id": str(getattr(current_user, "company_id", "") or ""),
            "from_user_id": str(current_user.id),
            "from_user_name": from_name,
            "to_portal_user_id": payload.to_portal_user_id,
            "to_display_name": portal_user.get("display_name") or portal_user.get("portal_username") or "",
            "client_id": client_id or "",
            "client_name": client_name,
            "subject": payload.subject or "",
            "body": payload.body,
            "message_type": payload.message_type or "general",
            "is_read": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.portal_messages.insert_one(msg)
        return {"ok": True, "id": msg["id"]}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"send_portal_message error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to send message: {str(e)}")

@router.get("/my-messages")
async def get_my_messages(current_client=Depends(get_current_portal_client)):
    """Client: get messages sent to me."""
    docs = await db.portal_messages.find(
        {"to_portal_user_id": current_client["id"]}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    # Ensure replies field always exists
    for doc in docs:
        if "replies" not in doc:
            doc["replies"] = []
    return docs

@router.put("/my-messages/{msg_id}/read")
async def mark_message_read(msg_id: str, current_client=Depends(get_current_portal_client)):
    """Client: mark a message as read."""
    await db.portal_messages.update_one(
        {"id": msg_id, "to_portal_user_id": current_client["id"]},
        {"$set": {"is_read": True, "read_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"ok": True}

class ClientReplyPayload(BaseModel):
    body: str

@router.post("/my-messages/{msg_id}/reply")
async def reply_to_message(
    msg_id: str,
    payload: ClientReplyPayload,
    current_client=Depends(get_current_portal_client),
):
    """Client: send a reply to a message from the firm."""
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(400, "Reply body is required")

    reply = {
        "body": body,
        "from_client": True,
        "from_display_name": current_client.get("display_name") or current_client.get("portal_username"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    # Append reply to the message document
    result = await db.portal_messages.update_one(
        {"id": msg_id, "to_portal_user_id": current_client["id"]},
        {
            "$push": {"replies": reply},
            "$set": {"has_reply": True, "last_reply_at": reply["created_at"]},
        },
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Message not found")
    return {"ok": True, "reply": reply}


@router.delete("/messages/{msg_id}", dependencies=[Depends(_client_portal_guard)])
async def delete_portal_message(msg_id: str, current_user: User = Depends(get_current_user)):
    """Admin: delete a message."""
    query = {"id": msg_id}
    if not is_platform_owner(current_user):
        query["org_id"] = getattr(current_user, "company_id", None)
    result = await db.portal_messages.delete_one(query)
    if result.deleted_count == 0:
        raise HTTPException(404, "Message not found")
    return {"ok": True}

# ── Individual Folder endpoint ─────────────────────────────────────────────

class IndividualFolderRequest(BaseModel):
    client_id: str
    client_name: str
    custom_folder_name: Optional[str] = None   # override folder name; defaults to client_name
    parent_folder_id: Optional[str] = None
    subfolders: Optional[List[str]] = None

@router.post("/drive/create-individual-folder", dependencies=[Depends(_client_portal_guard)])
async def create_individual_folder(
    payload: IndividualFolderRequest,
    current_user: User = Depends(get_current_user),
):
    """Admin: create a Drive folder for a specific client with optional custom name and subfolders."""
    import asyncio
    folder_name = payload.custom_folder_name or payload.client_name

    # Resolve subfolders from template if not provided
    subfolders = payload.subfolders
    if subfolders is None:
        subfolders = await _resolve_subfolders()

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    # Resolve parent: explicit override > saved Folder Architect template >
    # the shared default TaskOsphere Drive folder. Previously this endpoint
    # skipped resolution entirely, so an unset parent meant the "existing
    # folder" search below ran against ALL of Drive — which is how this
    # action ended up silently linking to unrelated pre-existing folders
    # with a matching name instead of creating a fresh one inside TaskOsphere.
    parent_id = await _resolve_parent_folder_id(payload.parent_folder_id)

    loop = asyncio.get_event_loop()
    try:
        service = get_drive_service_for_folder(parent_id) if parent_id else _get_drive_service()
        result = await loop.run_in_executor(
            None,
            lambda: _create_drive_folder_sync(
                service, folder_name, parent_id, subfolders, force_create=True,
            ),
        )
    except Exception as e:
        logger.error(f"Drive folder creation failed: {e}", exc_info=True)
        if parent_id and ("not found" in str(e).lower() or "404" in str(e)):
            raise HTTPException(
                400,
                "The configured Drive parent folder could not be found or isn't shared "
                "with the connected Google account. Fix it in Client Portal → Settings "
                "(or Folder Architect) by pasting a valid folder link, then try again.",
            )
        raise HTTPException(500, f"Drive error: {e}")

    # Persist folder_id to portal user and client
    folder_id = result.get("folder_id")
    if folder_id:
        await db.client_portal_users.update_many(
            {"client_id": payload.client_id},
            {"$set": {"google_drive_folder_id": folder_id, "google_drive_folder_name": folder_name}},
        )
        await db.clients.update_one(
            {"id": payload.client_id},
            {"$set": {"google_drive_folder_id": folder_id, "has_drive": True}},
        )

    return {
        **result,
        "folder_name": folder_name,
        "subfolders_created": subfolders,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Smart Bulk Upload  –  AI classifies each document → correct Drive subfolder
# ═══════════════════════════════════════════════════════════════════════════

# Keyword→subfolder mapping used as fallback when AI is not available
KEYWORD_FOLDER_MAP = [
    # GST / Tax
    (["gstr", "gst", "tax invoice", "eway bill", "e-way", "gst return", "gstin", "gst report", "gst certificate"], "GST Returns"),
    (["income tax", "itr", "form 16", "tds", "tcs", "advance tax", "tax computation", "26as", "ais", "tax audit"], "Income Tax"),
    # Incorporation / Company
    (["pan card", "pan ", "permanent account", "aadhaar", "aadhar", "identity proof", "address proof", "kyc"], "Documents"),
    (["incorporation", "moa", "aoa", "cin ", "certificate of incorporation", "memorandum", "articles of association", "llp agreement", "partnership deed"], "Documents"),
    (["roc filing", "mgt", "dir ", "aoc", "annual return", "annual report", "board minutes", "board resolution", "eboard"], "ROC Filings"),
    # Finance
    (["invoice", "bill ", "proforma", "debit note", "credit note", "receipt", "payment voucher"], "Invoices"),
    (["bank statement", "bank passbook", "account statement", "cancelled cheque", "bank certificate"], "Bank Statements"),
    (["audit report", "audit", "statutory audit", "tax audit report", "3cd", "3ca"], "Audit Reports"),
    (["balance sheet", "p&l", "profit and loss", "financial statement", "trial balance", "cash flow", "ledger"], "Reports"),
    # Compliance
    (["compliance", "deadline", "due date", "mca filing", "pf", "esic", "provident fund", "labour"], "Compliance"),
    (["agreement", "contract", "mou", "letter of intent", "nda", "deed", "power of attorney", "legal notice"], "Agreements"),
    (["correspondence", "letter", "notice", "communication", "email"], "Correspondence"),
    (["trademark", "ip ", "copyright", "patent", "brand", "logo"], "Documents"),
]

def _keyword_classify(filename: str, text_snippet: str = "") -> str:
    """Fast keyword-based fallback classifier. Returns subfolder name or 'Documents'."""
    combined = (filename + " " + text_snippet).lower()
    for keywords, folder in KEYWORD_FOLDER_MAP:
        if any(kw in combined for kw in keywords):
            return folder
    return "Documents"


async def _ai_classify_document(filename: str, file_bytes: bytes, mime: str, available_subfolders: list) -> dict:
    """
    Use Gemini (text PDF / Excel) or Groq vision (image / scanned PDF) to classify
    a document and identify which client it belongs to.

    Returns:
        {
            "suggested_folder": str,      # one of available_subfolders
            "document_type":   str,       # human label e.g. "GST Return GSTR-3B"
            "company_name":    str | None, # company name found in the document
            "confidence":      "high"|"medium"|"low",
            "notes":           str,
        }
    """
    import io as _io
    folder_list = ", ".join(f'"{f}"' for f in available_subfolders)
    base_prompt = f"""You are an expert Indian CA firm document classifier.

Available destination folders: [{folder_list}]

Analyse this document and return ONLY a JSON object (no markdown, no explanation) with these exact keys:
{{
  "suggested_folder": "<one of the folder names above>",
  "document_type": "<concise type e.g. GST Return GSTR-3B, PAN Card, Income Tax ITR-3, Bank Statement, Audit Report>",
  "company_name": "<company or individual name found in the document, or null>",
  "confidence": "<high|medium|low>",
  "notes": "<one short sentence about what this document is>"
}}

Rules:
- suggested_folder MUST be exactly one of the listed folder names
- If unsure, use "Documents"
- company_name: extract the exact name of the company/individual the document is for
"""

    try:
        gemini_key = __import__("os").environ.get("GEMINI_API_KEY", "")
        groq_key   = __import__("os").environ.get("GROQ_API_KEY", "")
        import json as _json

        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        # ── Text PDFs → Gemini ──────────────────────────────────────────────
        if ext == "pdf" and gemini_key:
            try:
                import pdfplumber, google.generativeai as genai
                genai.configure(api_key=gemini_key)
                model = genai.GenerativeModel("gemini-2.0-flash")
                text_pages = []
                with pdfplumber.open(_io.BytesIO(file_bytes)) as pdf:
                    for page in pdf.pages[:5]:
                        t = page.extract_text()
                        if t: text_pages.append(t.strip())
                text = "\n".join(text_pages)[:8000]
                if text.strip():
                    resp = await model.generate_content_async(base_prompt + f"\n\nDOCUMENT TEXT:\n{text}")
                    raw = resp.text.strip().strip("```json").strip("```").strip()
                    result = _json.loads(raw)
                    # Validate folder
                    if result.get("suggested_folder") not in available_subfolders:
                        result["suggested_folder"] = _keyword_classify(filename, text[:500])
                    return result
            except Exception:
                pass  # fall through to Groq

        # ── Images + scanned PDFs → Groq vision ────────────────────────────
        if ext in ("pdf", "jpg", "jpeg", "png", "webp") and groq_key:
            import base64 as _b64, httpx
            images_b64 = []
            if ext == "pdf":
                try:
                    import pdfplumber
                    with pdfplumber.open(_io.BytesIO(file_bytes)) as pdf:
                        for page in pdf.pages[:3]:
                            pil = page.to_image(resolution=120).original
                            buf = _io.BytesIO()
                            pil.convert("RGB").save(buf, "JPEG", quality=80)
                            images_b64.append(("image/jpeg", _b64.b64encode(buf.getvalue()).decode()))
                except Exception:
                    pass
            else:
                from PIL import Image as PILImage
                img = PILImage.open(_io.BytesIO(file_bytes)).convert("RGB")
                buf = _io.BytesIO()
                img.save(buf, "JPEG", quality=80)
                images_b64.append(("image/jpeg", _b64.b64encode(buf.getvalue()).decode()))

            if images_b64:
                content_parts = []
                for mime_t, b64 in images_b64:
                    content_parts.append({"type": "image_url", "image_url": {"url": f"data:{mime_t};base64,{b64}"}})
                content_parts.append({"type": "text", "text": base_prompt})
                payload = {
                    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
                    "messages": [{"role": "user", "content": content_parts}],
                    "max_tokens": 512,
                }
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.post(
                        "https://api.groq.com/openai/v1/chat/completions",
                        headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                        json=payload,
                    )
                if resp.status_code == 200:
                    raw = resp.json()["choices"][0]["message"]["content"].strip().strip("```json").strip("```").strip()
                    try:
                        result = _json.loads(raw)
                        if result.get("suggested_folder") not in available_subfolders:
                            result["suggested_folder"] = _keyword_classify(filename)
                        return result
                    except Exception:
                        pass

        # ── Excel / CSV → Gemini text ───────────────────────────────────────
        if ext in ("xlsx", "xls", "csv") and gemini_key:
            try:
                import google.generativeai as genai
                genai.configure(api_key=gemini_key)
                model = genai.GenerativeModel("gemini-2.0-flash")
                if ext == "csv":
                    text = file_bytes.decode("utf-8", errors="replace")[:6000]
                else:
                    import openpyxl
                    wb = openpyxl.load_workbook(_io.BytesIO(file_bytes), read_only=True, data_only=True)
                    rows = []
                    for ws in wb.worksheets:
                        for row in ws.iter_rows(values_only=True, max_row=30):
                            rows.append("\t".join("" if v is None else str(v) for v in row))
                    text = "\n".join(rows)[:6000]
                resp = await model.generate_content_async(base_prompt + f"\n\nSPREADSHEET DATA:\n{text}")
                raw = resp.text.strip().strip("```json").strip("```").strip()
                result = _json.loads(raw)
                if result.get("suggested_folder") not in available_subfolders:
                    result["suggested_folder"] = _keyword_classify(filename, text[:500])
                return result
            except Exception:
                pass

    except Exception:
        pass

    # ── Final fallback: keyword match on filename ───────────────────────────
    folder = _keyword_classify(filename)
    return {
        "suggested_folder": folder,
        "document_type": "Unknown — classified by filename",
        "company_name": None,
        "confidence": "low",
        "notes": f"AI unavailable; classified by filename keyword matching.",
    }


class ClassifyRequest(BaseModel):
    filename: str
    available_subfolders: List[str] = Field(default_factory=list)


@router.post("/drive/classify-document", dependencies=[Depends(_client_portal_guard)])
async def classify_document_endpoint(
    filename: str = Form(...),
    available_subfolders: str = Form("[]"),   # JSON-encoded list
    file: UploadFile = File(...),
    current_user=Depends(get_current_user),
):
    """Classify a single document and suggest which Drive subfolder it belongs in."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    import json as _json
    try:
        subfolders = _json.loads(available_subfolders)
    except Exception:
        subfolders = []
    if not subfolders:
        subfolders = list(DEFAULT_SUBFOLDERS)

    file_bytes = await file.read()
    mime = file.content_type or "application/octet-stream"
    result = await _ai_classify_document(filename, file_bytes, mime, subfolders)
    return {"filename": filename, **result}


@router.post("/drive/smart-bulk-upload", dependencies=[Depends(_client_portal_guard)])
async def smart_bulk_upload(
    portal_user_id: str = Form(...),
    classifications: str = Form(...),   # JSON: [{filename, suggested_folder, override_folder?}, ...]
    files: List[UploadFile] = File(...),
    current_user=Depends(get_current_user),
):
    """
    Final upload step of the Smart Bulk Upload flow.

    Receives files + the admin-confirmed classification map, then:
    1. Resolves (or creates) the target subfolder in the client's Drive root
    2. Uploads each file to its assigned subfolder
    3. Returns per-file results with Drive links
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    root_folder_id = portal_user.get("google_drive_folder_id")
    if not root_folder_id:
        raise HTTPException(400, "This client has no Drive folder linked. Create one in Folder Architect first.")

    import json as _json, asyncio
    try:
        class_map = {item["filename"]: item for item in _json.loads(classifications)}
    except Exception:
        raise HTTPException(400, "Invalid classifications JSON")

    service = get_drive_service_for_folder(root_folder_id)

    # Cache subfolder IDs to avoid repeated Drive API calls
    subfolder_id_cache: dict = {}

    async def _get_subfolder_id(name: str) -> str:
        if name in subfolder_id_cache:
            return subfolder_id_cache[name]
        loop = asyncio.get_event_loop()
        fid = await loop.run_in_executor(None, _get_or_create_subfolder_sync, service, root_folder_id, name)
        subfolder_id_cache[name] = fid
        return fid

    results = []
    import mimetypes
    for uf in files:
        file_bytes = await uf.read()
        info = class_map.get(uf.filename, {})
        # Admin override takes priority; fall back to AI suggestion; then root
        dest_folder_name = (info.get("override_folder") or info.get("suggested_folder") or "").strip()

        if dest_folder_name:
            try:
                target_id = await _get_subfolder_id(dest_folder_name)
            except Exception as e:
                results.append({"filename": uf.filename, "status": "error", "error": f"Could not resolve subfolder: {e}", "folder": dest_folder_name})
                continue
        else:
            target_id = root_folder_id
            dest_folder_name = "(root)"

        mime = uf.content_type or mimetypes.guess_type(uf.filename)[0] or "application/octet-stream"
        try:
            loop = asyncio.get_event_loop()
            uploaded = await loop.run_in_executor(None, _upload_file_to_drive_sync, service, target_id, uf.filename, file_bytes, mime)
            results.append({
                "filename": uf.filename,
                "status": "uploaded",
                "folder": dest_folder_name,
                "drive_id": uploaded.get("id"),
                "web_link": uploaded.get("webViewLink"),
                "document_type": info.get("document_type", ""),
            })
        except Exception as e:
            results.append({"filename": uf.filename, "status": "error", "error": str(e), "folder": dest_folder_name})

    uploaded_count = sum(1 for r in results if r["status"] == "uploaded")
    return {
        "success": True,
        "portal_user_id": portal_user_id,
        "uploaded": uploaded_count,
        "failed": len(results) - uploaded_count,
        "results": results,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Simple Upload Center  –  easy drag-and-drop uploads, folder create/delete,
# and single + bulk deletion of Drive items and portal clients.
# ═══════════════════════════════════════════════════════════════════════════

def _get_or_create_subfolder_sync(service, parent_id: str, name: str) -> str:
    """Synchronous helper – find (or create) a folder named `name` inside `parent_id`."""
    safe_name = name.replace("'", "\\'").strip()
    existing = service.files().list(
        q=f"'{parent_id}' in parents and name='{safe_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields="files(id,name)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute().get("files", [])
    if existing:
        return existing[0]["id"]
    created = service.files().create(
        body={"name": name.strip(), "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]},
        fields="id",
    ).execute()
    return created["id"]


def _find_existing_file_sync(service, folder_id: str, filename: str) -> Optional[dict]:
    """Look for a non-trashed file with this exact name directly inside `folder_id`.
    Used to detect duplicate uploads before they happen, so the caller can
    ask the admin whether to overwrite or keep both instead of Drive silently
    creating a second file with the identical name."""
    safe_name = filename.replace("'", "\\'").strip()
    existing = service.files().list(
        q=f"'{folder_id}' in parents and name='{safe_name}' and trashed=false",
        fields="files(id,name,modifiedTime,size)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute().get("files", [])
    return existing[0] if existing else None


def _unique_filename_sync(service, folder_id: str, filename: str) -> str:
    """When the admin chooses 'keep both', avoid creating a second file with
    the byte-identical name (confusing in Drive's UI) by appending ' (1)',
    ' (2)', etc. — the same convention Windows/macOS/Drive's own web
    uploader use for same-name conflicts."""
    stem, dot, ext = filename.rpartition(".")
    base, ext = (stem, f".{ext}") if dot else (filename, "")
    candidate = filename
    n = 1
    while _find_existing_file_sync(service, folder_id, candidate):
        candidate = f"{base} ({n}){ext}"
        n += 1
    return candidate


def _upload_file_to_drive_sync(service, folder_id: str, filename: str, file_bytes: bytes, mime_type: str, existing_file_id: str = None) -> dict:
    """Synchronous helper – upload raw bytes to a Drive folder.
    If `existing_file_id` is given, the existing file's *content* is
    replaced in place (same file id, new revision) instead of creating a
    new file — this is the 'overwrite' path for duplicate resolution.
    Returns the created/updated file resource."""
    from googleapiclient.http import MediaIoBaseUpload
    import io as _io
    media = MediaIoBaseUpload(_io.BytesIO(file_bytes), mimetype=mime_type or "application/octet-stream", resumable=False)
    if existing_file_id:
        return service.files().update(
            fileId=existing_file_id,
            media_body=media,
            fields="id,name,webViewLink,mimeType,size,modifiedTime,iconLink",
            supportsAllDrives=True,
        ).execute()
    return service.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media,
        fields="id,name,webViewLink,mimeType,size,modifiedTime,iconLink",
        supportsAllDrives=True,
    ).execute()


def _upload_file_path_to_drive_sync(service, folder_id: str, filename: str, file_path: str, mime_type: str, existing_file_id: str = None) -> dict:
    """Upload a local temp file to Drive without loading the whole file into RAM."""
    from googleapiclient.http import MediaFileUpload

    media = MediaFileUpload(
        file_path,
        mimetype=mime_type or "application/octet-stream",
        chunksize=8 * 1024 * 1024,
        resumable=True,
    )
    if existing_file_id:
        return service.files().update(
            fileId=existing_file_id,
            media_body=media,
            fields="id,name,webViewLink,mimeType,size,modifiedTime,iconLink",
            supportsAllDrives=True,
        ).execute()
    return service.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media,
        fields="id,name,webViewLink,mimeType,size,modifiedTime,iconLink",
        supportsAllDrives=True,
    ).execute()


@router.post("/drive/ensure-root-folder", dependencies=[Depends(_client_portal_guard)])
async def ensure_root_folder(
    client_id: str = Form(...),
    client_name: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    Idempotent one-click provisioning used by the Upload Center.

    Creates a portal login for the client if one does not already exist.
    Drive folder creation is intentionally NOT done here — use the
    Folder Architect to create Drive folders manually with the desired
    subfolder structure.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    portal_user = await db.client_portal_users.find_one({"client_id": client_id}, {"_id": 0})
    generated_password = None

    if not portal_user:
        # Auto-provision a portal login so the client can log in immediately.
        base_username = re.sub(r"[^a-z0-9]+", "", client_name.lower())[:20] or "client"
        username = base_username
        suffix = 1
        while await db.client_portal_users.find_one({"portal_username": username}):
            suffix += 1
            username = f"{base_username}{suffix}"
        generated_password = f"{base_username[:4]}{random.randint(1000, 9999)}"
        new_user = {
            "id": str(uuid.uuid4()),
            "client_id": client_id,
            "client_name": client_name,
            "portal_username": username,
            "hashed_password": pwd_context.hash(generated_password),
            "display_name": client_name,
            "email": None,
            "is_active": True,
            "can_view_tasks": True,
            "can_view_documents": True,
            "can_view_invoices": True,
            "can_view_compliance": False,
            "google_drive_folder_id": None,
            "google_drive_folder_name": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": current_user.id,
        }
        await db.client_portal_users.insert_one(new_user)
        portal_user = new_user
        await _sync_portal_password(
            client_id=client_id,
            client_name=client_name,
            portal_username=username,
            plain_password=generated_password,
            current_user=current_user,
        )

    # Drive folder is NOT auto-created here. Use Folder Architect to create
    # it manually with the correct subfolder structure.
    folder_id = portal_user.get("google_drive_folder_id")

    return {
        "success": True,
        "portal_user_id": portal_user["id"],
        "portal_username": portal_user["portal_username"],
        "generated_password": generated_password,  # only present when a new account was just created
        "google_drive_folder_id": folder_id,
        "google_drive_folder_link": None,
    }


@router.post("/drive/upload-file", dependencies=[Depends(_client_portal_guard)])
async def simple_upload_file(
    portal_user_id: str = Form(...),
    folder_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
    conflict_action: Optional[str] = Form(None),  # None/"ask" | "overwrite" | "keep_both"
    current_user: User = Depends(get_current_user),
):
    """
    One-file-at-a-time upload used by the Upload Center's drag-and-drop zone.
    The frontend fires one call per file (in parallel) so uploads happen in
    the background while the admin keeps working / drops more files.

    Duplicate handling: before creating anything, we check whether a file
    with this exact name already exists directly in the target folder.
      - conflict_action is None/"ask" (default) and a duplicate exists →
        respond 409 with the existing file's id so the frontend can prompt
        the admin to choose "Overwrite" or "Keep both", instead of silently
        creating a second file with the same name.
      - conflict_action == "overwrite" → replace the existing file's
        content in place (same Drive file id, new revision).
      - conflict_action == "keep_both" → upload as a new file, auto-suffixed
        " (1)", " (2)", … if needed so it doesn't share the exact same name.
    """
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    import mimetypes

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    target_folder = folder_id or portal_user.get("google_drive_folder_id")
    if not target_folder:
        raise HTTPException(400, "This client has no Drive folder yet. Create one first.")

    # Guard against a single huge file and spool to disk instead of keeping
    # the entire file in RAM. The previous in-memory upload path could restart
    # a small Render instance during folder uploads, which the browser reports
    # as "interrupted before a response came back".
    MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB per file
    tmp_path = None
    total_bytes = 0
    try:
        with tempfile.NamedTemporaryFile(prefix="portal-upload-", suffix=".tmp", delete=False) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"\"{file.filename}\" is larger than the 100 MB per-file limit.")
                tmp.write(chunk)
    except HTTPException:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise

    mime = file.content_type or mimetypes.guess_type(file.filename)[0] or "application/octet-stream"

    loop = asyncio.get_running_loop()

    try:
        async with DRIVE_UPLOAD_SEMAPHORE:
            service = get_drive_service_for_folder(target_folder)
            existing = await loop.run_in_executor(None, _find_existing_file_sync, service, target_folder, file.filename)

            existing_file_id = None
            upload_filename = file.filename

            if existing and conflict_action in (None, "ask"):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": {
                            "conflict": True,
                            "existing_file_id": existing["id"],
                            "existing_modified_time": existing.get("modifiedTime"),
                            "filename": file.filename,
                            "message": f"\"{file.filename}\" already exists in this folder.",
                        }
                    },
                )
            elif existing and conflict_action == "overwrite":
                existing_file_id = existing["id"]
            elif existing and conflict_action == "keep_both":
                upload_filename = await loop.run_in_executor(None, _unique_filename_sync, service, target_folder, file.filename)
            # else: no existing file with this name — proceed as a normal create

            uploaded = await loop.run_in_executor(
                None, _upload_file_path_to_drive_sync, service, target_folder, upload_filename, tmp_path, mime, existing_file_id,
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Simple upload failed: {e}", exc_info=True)
        raise HTTPException(500, f"Upload failed: {e}")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return {
        "success": True,
        "id": uploaded.get("id"),
        "name": uploaded.get("name"),
        "webViewLink": uploaded.get("webViewLink"),
        "mimeType": uploaded.get("mimeType"),
        "folder_id": target_folder,
        "overwritten": bool(existing_file_id),
    }


class CreateSubfolderRequest(BaseModel):
    portal_user_id: str
    folder_name: str = Field(..., min_length=1, max_length=200)
    parent_folder_id: Optional[str] = None


@router.post("/drive/simple-create-folder", dependencies=[Depends(_client_portal_guard)])
async def simple_create_folder(
    body: CreateSubfolderRequest,
    current_user: User = Depends(get_current_user),
):
    """Create a single new folder (used by the Upload Center's '+ New Folder' button)."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    import asyncio

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    portal_user = await db.client_portal_users.find_one({"id": body.portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")

    parent_id = body.parent_folder_id or portal_user.get("google_drive_folder_id")
    if not parent_id:
        raise HTTPException(400, "This client has no Drive folder yet. Create one first.")

    service = get_drive_service_for_folder(parent_id)
    loop = asyncio.get_event_loop()
    folder_id = await loop.run_in_executor(
        None, _get_or_create_subfolder_sync, service, parent_id, body.folder_name,
    )
    return {"success": True, "id": folder_id, "name": body.folder_name, "parent_folder_id": parent_id}


class BulkDeleteRequest(BaseModel):
    portal_user_id: str
    file_ids: List[str] = Field(..., min_length=1)


@router.delete("/drive/item", dependencies=[Depends(_client_portal_guard)])
async def delete_drive_item(
    portal_user_id: str = Query(...),
    file_id: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    """Move a single Drive file/folder to Trash and drop it from any visibility list."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    import asyncio

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    service = get_drive_service_for_file(file_id)
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, lambda: service.files().update(fileId=file_id, body={"trashed": True}, supportsAllDrives=True).execute())
    except Exception as e:
        raise HTTPException(500, f"Failed to delete: {e}")

    await db.client_drive_visibility.update_one(
        {"portal_user_id": portal_user_id}, {"$pull": {"hidden_ids": file_id}}
    )
    return {"success": True, "deleted_id": file_id}


@router.post("/drive/bulk-delete", dependencies=[Depends(_client_portal_guard)])
async def bulk_delete_drive_items(
    body: BulkDeleteRequest,
    current_user: User = Depends(get_current_user),
):
    """Trash multiple Drive files/folders at once (used by the Upload Center's bulk-delete action)."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    import asyncio

    if not _drive_configured():
        raise HTTPException(503, "Google Drive not configured.")

    loop = asyncio.get_event_loop()

    deleted, errors = [], []
    for fid in body.file_ids:
        try:
            service = get_drive_service_for_file(fid)
            await loop.run_in_executor(None, lambda fid=fid, service=service: service.files().update(fileId=fid, body={"trashed": True}, supportsAllDrives=True).execute())
            deleted.append(fid)
        except Exception as e:
            errors.append({"id": fid, "error": str(e)})

    if deleted:
        await db.client_drive_visibility.update_one(
            {"portal_user_id": body.portal_user_id}, {"$pull": {"hidden_ids": {"$in": deleted}}}
        )

    return {"success": True, "deleted": deleted, "failed": errors}


class BulkUserDeleteRequest(BaseModel):
    portal_user_ids: List[str] = Field(..., min_length=1)


@router.post("/users/bulk-delete", dependencies=[Depends(_client_portal_guard)])
async def bulk_delete_portal_users(
    body: BulkUserDeleteRequest,
    current_user: User = Depends(get_current_user),
):
    """Remove multiple clients from the Client Portal at once (revokes their login; Drive files are untouched)."""
    # Was hardcoded to role == "admin" only, which ignored the
    # can_view_client_portal permission everyone else in this file already
    # respects via _can_manage_portal(). That meant a user (or manager) who
    # had been granted Client Portal access via Permission Governance could
    # view, add, edit and even single-delete portal users, but hit a 403
    # specifically on bulk delete. Aligned with every other endpoint below.
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")

    res = await db.client_portal_users.delete_many({"id": {"$in": body.portal_user_ids}})
    return {"success": True, "deleted_count": res.deleted_count}


@router.get("/drive/subfolders/{portal_user_id}", dependencies=[Depends(_client_portal_guard)])
async def list_client_subfolders(
    portal_user_id: str,
    current_user=Depends(get_current_user),
):
    """List top-level subfolders inside a client's Drive root folder."""
    if not _can_manage_portal(current_user):
        raise HTTPException(403, "Insufficient permissions")
    portal_user = await db.client_portal_users.find_one({"id": portal_user_id}, {"_id": 0})
    if not portal_user:
        raise HTTPException(404, "Portal user not found")
    root_folder_id = portal_user.get("google_drive_folder_id")
    if not root_folder_id:
        return {"subfolders": [], "root_folder_id": None}
    from backend.google_drive_service import _get_drive_service, _drive_configured, get_drive_service_for_folder, get_drive_service_for_file
    if not _drive_configured():
        return {"subfolders": [], "root_folder_id": root_folder_id}
    all_items = _fetch_drive_files_raw(root_folder_id, include_subfolders=False)
    subfolders = [{"id": f["id"], "name": f["name"]} for f in all_items if f.get("mimeType") == "application/vnd.google-apps.folder"]
    return {"subfolders": subfolders, "root_folder_id": root_folder_id}


# ── Phase 11 Integration Endpoints ──────────────────────────────────────────

class ClientApprovalDecisionRequest(BaseModel):
    decision: str  # "APPROVED" or "REJECTED"
    comment: Optional[str] = None


@router.get("/workflows")
async def client_portal_workflows(portal_user=Depends(get_current_portal_client)):
    """List workflow instances for the logged-in portal client."""
    client_id = portal_user["client_id"]
    from backend.workflow.workflow_storage import WorkflowStorage
    instances = await WorkflowStorage.list_workflow_instances({"input_data.client_id": client_id})
    return instances


@router.get("/approvals")
async def client_portal_approvals(portal_user=Depends(get_current_portal_client)):
    """List approval requests for the logged-in portal client."""
    client_id = portal_user["client_id"]
    from backend.workflow.workflow_storage import WorkflowStorage
    approvals = await WorkflowStorage.list_approval_requests({"company_id": client_id})
    return approvals


@router.post("/approvals/{approval_id}/decision")
async def client_portal_approval_decision(
    approval_id: str,
    body: ClientApprovalDecisionRequest,
    portal_user=Depends(get_current_portal_client)
):
    """Submit approval decision from the client portal."""
    portal_user_id = portal_user["id"]
    from backend.workflow.approval_engine import ApprovalEngine
    success = await ApprovalEngine.submit_decision(
        approval_id=approval_id,
        user_id=portal_user_id,
        decision=body.decision,
        comment=body.comment
    )
    if not success:
        raise HTTPException(status_code=400, detail="Failed to process approval decision.")
    return {"success": True, "message": f"Approval decision '{body.decision}' processed successfully."}


class CopilotQueryRequest(BaseModel):
    query: str
    session_id: Optional[str] = None


@router.post("/copilot/chat")
async def client_portal_copilot_chat(
    body: CopilotQueryRequest,
    portal_user=Depends(get_current_portal_client)
):
    """Initiates an automated copilot transaction chat inside the Client Portal."""
    from backend.copilot.copilot_engine import CopilotEngine
    
    # Adapt portal client to mock User object
    class PortalUserAdaptor:
        id = portal_user.get("id") or portal_user.get("user_id") or "portal_client"
        company_id = portal_user.get("client_id") or "default_comp"
        tenant_id = "default_tenant"
        role = "portal_user"
        permissions = {"can_view_reports": True}
        
    user = PortalUserAdaptor()
    try:
        return await CopilotEngine.process_copilot_request(
            user=user,
            session_id=body.session_id,
            query=body.query,
            role_preset="assistant"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
