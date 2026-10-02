"""Portable Taskosphere customer backup / restore.

The portable .taskosphere file is a single encrypted container. It stores a
manifest, MongoDB documents in Canonical Extended JSON (BSON type preserving),
and index definitions. Full backups cover every tenant-scoped MongoDB
collection plus tenant-linked settings. Custom backups can select modules or
individual collections.

Authentication sessions/tokens are never exported. On cross-license restore,
the target company/license and the administrator's live authentication
credentials are preserved so a restore cannot lock the target account out.
"""

from __future__ import annotations

import base64
import asyncio
import logging
import inspect
import json
import os
import secrets
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId, json_util
from bson.json_util import CANONICAL_JSON_OPTIONS
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from starlette.background import BackgroundTask

from backend.dependencies import DB_NAME, MONGO_URL, client, db, get_current_user, get_user_permissions
from backend.models import User
from backend.tenant_runtime import TENANT_COLLECTIONS
from backend.permission_governance import GOVERNED_MODULES
from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)

# Backup is a Permission Governance capability. Admins and the platform owner
# retain their bypass; other users must be approved for this flag before they
# can create or inspect backups. Restore remains administrator/platform-owner only.
GOVERNED_MODULES.setdefault(
    "backup_restore",
    {"flag": "can_view_backup_restore", "label": "Backup & Restore"},
)

router = APIRouter(prefix="/app-backup", tags=["Application Backup"])

FORMAT_MAGIC = b"TASKOSPHERE-BACKUP-V1\n"
FORMAT_VERSION = 1
PBKDF2_ITERATIONS = 390_000
CHUNK_SIZE = 1024 * 1024
MAX_BACKUP_UPLOAD_BYTES = 100 * 1024 * 1024
NEW_BACKUP_EXTENSION = ".onenexa"
LEGACY_BACKUP_EXTENSIONS = {".taskosphere"}
SUPPORTED_BACKUP_EXTENSIONS = {NEW_BACKUP_EXTENSION, *LEGACY_BACKUP_EXTENSIONS}
LEGACY_SOURCE_APPLICATION = "Final-Taskosphere-3"

BACKUP_HISTORY_COLLECTION = "backup_history"
BACKUP_GRIDFS_BUCKET = "taskosphere_backups"

EXCLUDED_COLLECTIONS = {
    "sessions", "refresh_tokens", "access_tokens", "password_resets",
    "password_reset_tokens", "verification_tokens", "email_verification_tokens",
    "oauth_states", "oauth_tokens", "rate_limits",
    # Internal backup-management data must never be recursively captured by a backup.
    BACKUP_HISTORY_COLLECTION,
    f"{BACKUP_GRIDFS_BUCKET}.files",
    f"{BACKUP_GRIDFS_BUCKET}.chunks",
}

AUTH_FIELDS_TO_PRESERVE = {
    "password", "password_hash", "hashed_password", "hash", "auth_provider",
    "google_id", "google_sub", "mfa_secret", "two_factor_secret",
    "reset_token", "reset_token_expires", "verification_token",
    "token_version", "session_version", "security_stamp",
}

USER_LINKED_FIELDS = {
    "user_id", "created_by", "updated_by", "owner_id", "assigned_to",
    "assigned_to_user_id", "employee_id", "requested_by", "approved_by",
    "decided_by", "actor_user_id", "admin_id", "manager_id", "staff_id",
}
IDENTITY_FIELDS = {"company_id", "license_id", "commercial_customer_id"}

MODULE_COLLECTION_MAP = {
    "taskosphere": {"tasks", "todos", "reminders", "notification_history", "notifications"},
    "records": {"clients", "knowledge_base", "learning_events", "documents", "passwords"},
    "proposals": {"leads", "quotations", "proposals", "client_discussions", "client_activities"},
    "finix": {
        "invoices", "payments", "purchase_invoices", "purchase_payments", "purchases",
        "bank_accounts", "bank_transactions", "chart_of_accounts", "journal_entries", "journal_lines",
    },
    "people_matrix": {"attendance", "leave_requests", "payroll_records", "hr_records", "performance_records", "recruitment"},
    "compliance": {"compliance", "gst_reconciliation", "roc_records", "salary_slips", "due_dates"},
    "automation": {"workflow_definitions", "workflow_instances", "workflow_history", "approval_requests", "approval_history", "automation_rules", "business_events", "workflow_audit"},
    "analytics": {"analytics_data", "kpi_history", "recommendation_history", "learning_audit"},
    "settings": {"settings", "app_settings", "general_settings", "email_settings", "whatsapp_settings", "automation_settings", "feature_settings", "user_settings", "notification_settings", "integration_settings", "role_definitions"},
}


def _is_admin(user: User) -> bool:
    return str(getattr(user, "role", "")).lower() == "admin" or is_platform_owner(user)


def _require_backup_access(user: User) -> None:
    if _is_admin(user):
        return
    permissions = get_user_permissions(user)
    if permissions.get("can_view_backup_restore", False):
        return
    raise HTTPException(status_code=403, detail="Backup access has not been approved for your account.")


def _require_admin(user: User) -> None:
    if _is_admin(user):
        return
    raise HTTPException(status_code=403, detail="Only an administrator can restore an application backup.")


def _raw_db():
    raw = getattr(db, "_database", None)
    return raw if raw is not None else client[DB_NAME]


def _backup_gridfs(raw):
    return AsyncIOMotorGridFSBucket(raw, bucket_name=BACKUP_GRIDFS_BUCKET, chunk_size_bytes=CHUNK_SIZE)


async def _ensure_backup_history_indexes(raw):
    await raw[BACKUP_HISTORY_COLLECTION].create_index([("company_id", 1), ("created_at", -1)])
    await raw[BACKUP_HISTORY_COLLECTION].create_index([("artifact_file_id", 1)], sparse=True)


def _history_document(doc: dict) -> dict:
    size = int(doc.get("file_size_bytes") or 0)
    return {
        "id": str(doc.get("_id")),
        "filename": doc.get("filename"),
        "created_at": doc.get("created_at"),
        "created_by": doc.get("created_by_name") or doc.get("created_by") or "Administrator",
        "mode": doc.get("mode") or "full",
        "company_name": doc.get("company_name"),
        "collection_count": int(doc.get("collection_count") or 0),
        "document_count": int(doc.get("document_count") or 0),
        "file_size_bytes": size,
        "file_size": f"{size:,} bytes",
        "collections": doc.get("collections") or [],
        "deletable": bool(doc.get("artifact_file_id")),
    }


async def _persist_backup_artifact(output: str, filename: str, manifest: dict, current_user: User, progress_id: str | None = None):
    raw = _raw_db()
    await _ensure_backup_history_indexes(raw)
    bucket = _backup_gridfs(raw)
    history_id = ObjectId()
    artifact_id = None
    grid_in = None
    started_at = time.monotonic()
    total_bytes = os.path.getsize(output)
    uploaded_bytes = 0
    document_count = sum(int(meta.get("documents") or 0) for meta in (manifest.get("collections") or {}).values())
    total_documents = document_count

    try:
        grid_in = bucket.open_upload_stream(
            filename,
            chunk_size_bytes=CHUNK_SIZE,
            metadata={
                "contentType": "application/octet-stream",
                "backupHistoryId": str(history_id),
                "companyId": _s(manifest.get("source_company_id")),
                "format": "taskosphere-backup",
                "version": FORMAT_VERSION,
            },
        )
        artifact_id = grid_in._id
        _set_backup_progress(
            progress_id,
            phase="storing",
            percent=90.0,
            processed_documents=document_count,
            total_documents=total_documents,
            eta_seconds=None,
            elapsed_seconds=round(time.monotonic() - started_at, 1),
            current_collection=None,
            processed_bytes=0,
            total_bytes=total_bytes,
        )

        with open(output, "rb") as source:
            while True:
                chunk = await asyncio.to_thread(source.read, CHUNK_SIZE)
                if not chunk:
                    break
                await grid_in.write(chunk)
                uploaded_bytes += len(chunk)
                elapsed = max(0.001, time.monotonic() - started_at)
                ratio = uploaded_bytes / total_bytes if total_bytes else 1.0
                percent = 90.0 + (ratio * 10.0)
                speed = uploaded_bytes / elapsed if uploaded_bytes else 0.0
                remaining = max(0, total_bytes - uploaded_bytes)
                eta = remaining / speed if speed > 0 else None
                _set_backup_progress(
                    progress_id,
                    phase="storing",
                    percent=round(min(100.0, percent), 2),
                    processed_documents=document_count,
                    total_documents=total_documents,
                    eta_seconds=round(eta, 1) if eta is not None else None,
                    elapsed_seconds=round(elapsed, 1),
                    current_collection=None,
                    processed_bytes=uploaded_bytes,
                    total_bytes=total_bytes,
                )

        await grid_in.close()
        grid_in = None

        collection_names = sorted((manifest.get("collections") or {}).keys())
        created_at = datetime.now(timezone.utc)
        history = {
            "_id": history_id,
            "company_id": _s(manifest.get("source_company_id")),
            "company_name": manifest.get("company_name"),
            "created_at": created_at,
            "created_by": _s(getattr(current_user, "id", None)),
            "created_by_name": getattr(current_user, "full_name", None) or getattr(current_user, "name", None) or getattr(current_user, "email", None) or "Administrator",
            "filename": filename,
            "mode": "full" if manifest.get("selection") == "full" else "custom",
            "selection": manifest.get("selection") or "full",
            "collections": collection_names,
            "collection_count": len(collection_names),
            "document_count": document_count,
            "file_size_bytes": total_bytes,
            "artifact_file_id": artifact_id,
            "artifact_bucket": BACKUP_GRIDFS_BUCKET,
            "format_version": FORMAT_VERSION,
        }
        await raw[BACKUP_HISTORY_COLLECTION].insert_one(history)
        _set_backup_progress(
            progress_id,
            phase="ready",
            percent=100.0,
            processed_documents=document_count,
            total_documents=total_documents,
            eta_seconds=0.0,
            elapsed_seconds=round(time.monotonic() - started_at, 1),
            current_collection=None,
            file_size=total_bytes,
            history_id=str(history_id),
        )
        return history_id
    except Exception:
        if grid_in is not None:
            try:
                await grid_in.abort()
            except Exception:
                pass
        if artifact_id is not None:
            try:
                await bucket.delete(artifact_id)
            except Exception:
                pass
        raise



def _key(password: str, salt: bytes) -> bytes:
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="Backup password must be at least 8 characters.")
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS).derive(password.encode("utf-8"))


def _header(salt: bytes, nonce: bytes) -> bytes:
    metadata = {"format": "taskosphere-backup", "version": FORMAT_VERSION, "cipher": "AES-256-GCM", "kdf": "PBKDF2-HMAC-SHA256", "iterations": PBKDF2_ITERATIONS, "salt": base64.b64encode(salt).decode(), "nonce": base64.b64encode(nonce).decode()}
    return FORMAT_MAGIC + json.dumps(metadata, separators=(",", ":")).encode() + b"\n"


def _read_header(handle):
    if handle.readline() != FORMAT_MAGIC:
        raise HTTPException(status_code=400, detail="Invalid Taskosphere backup file.")
    try:
        metadata = json.loads(handle.readline().decode())
        if metadata.get("format") != "taskosphere-backup" or metadata.get("version") != FORMAT_VERSION:
            raise ValueError("unsupported backup version")
        salt = base64.b64decode(metadata["salt"])
        nonce = base64.b64decode(metadata["nonce"])
        if len(salt) != 16 or len(nonce) != 12:
            raise ValueError("invalid encryption parameters")
        return salt, nonce
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid backup header: {exc}") from exc


def _decrypt(source_path: str, password: str) -> str:
    # Stream GCM decryption to disk. Holding the complete encrypted payload and
    # complete plaintext ZIP in RAM at once can restart a small hosted instance
    # during restores of otherwise reasonable backup files.
    fd, path = tempfile.mkstemp(prefix="taskosphere-restore-", suffix=".zip")
    os.close(fd)
    try:
        with open(source_path, "rb") as source:
            salt, nonce = _read_header(source)
            header_end = source.tell()
            source.seek(0, os.SEEK_END)
            file_size = source.tell()
            if file_size - header_end <= 16:
                raise HTTPException(status_code=400, detail="Backup payload is incomplete.")
            tag_position = file_size - 16
            source.seek(tag_position)
            tag = source.read(16)
            source.seek(header_end)

            decryptor = Cipher(
                algorithms.AES(_key(password, salt)),
                modes.GCM(nonce, tag),
            ).decryptor()

            remaining = tag_position - header_end
            with open(path, "wb") as out:
                while remaining > 0:
                    chunk = source.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        raise HTTPException(status_code=400, detail="Backup payload is incomplete.")
                    remaining -= len(chunk)
                    out.write(decryptor.update(chunk))
                try:
                    out.write(decryptor.finalize())
                except Exception as exc:
                    raise HTTPException(
                        status_code=400,
                        detail="Backup password is incorrect or the backup is corrupted.",
                    ) from exc
        return path
    except HTTPException:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise
    except Exception as exc:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise HTTPException(
            status_code=400,
            detail="Backup password is incorrect or the backup is corrupted.",
        ) from exc


def _dump(value: Any) -> str:
    return json_util.dumps(value, json_options=CANONICAL_JSON_OPTIONS)

def _dump_batch(values: list[Any]) -> bytes:
    return (chr(10).join(_dump(value) for value in values) + chr(10)).encode("utf-8")


def _load(value: str) -> Any:
    return json_util.loads(value, json_options=CANONICAL_JSON_OPTIONS)


def _s(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _company_query(company_id: str) -> dict:
    values: list[Any] = [company_id]
    if ObjectId.is_valid(company_id):
        values.append(ObjectId(company_id))
    return {"$or": [{"company_id": value} for value in values]}


async def _tenant_context(user: User):
    company_id = _s(getattr(user, "company_id", None))
    if not company_id:
        raise HTTPException(status_code=403, detail="Your account is not attached to a customer company.")
    raw = _raw_db()
    company = await raw.companies.find_one({"id": company_id})
    if not company and ObjectId.is_valid(company_id):
        company = await raw.companies.find_one({"_id": ObjectId(company_id)})
    users = await raw.users.find(_company_query(company_id), {"_id": 1, "id": 1}).to_list(100000)
    user_ids = {_s(u.get("id")) for u in users if u.get("id")}
    user_ids.update(_s(u.get("_id")) for u in users if u.get("_id") is not None)
    identities = {field: {_s(getattr(user, field, None))} for field in IDENTITY_FIELDS}
    for field in IDENTITY_FIELDS:
        if company and company.get(field) is not None:
            identities[field].add(_s(company[field]))
        identities[field].discard("")
    return company_id, company, user_ids, identities


def _linked(doc: dict, user_ids: set[str], identities: dict[str, set[str]]) -> bool:
    for field in IDENTITY_FIELDS:
        if _s(doc.get(field)) in identities.get(field, set()):
            return True
    for field in USER_LINKED_FIELDS:
        value = doc.get(field)
        if _s(value) in user_ids:
            return True
        if isinstance(value, list) and any(_s(item) in user_ids for item in value):
            return True
    return False


async def _collection_docs(raw, name: str, company_id: str, user_ids: set[str], identities: dict[str, set[str]], company: dict | None):
    if name in EXCLUDED_COLLECTIONS:
        return []
    if name == "companies":
        docs = await raw[name].find({"id": company_id}).to_list(10)
        if not docs and company and company.get("_id") is not None:
            docs = await raw[name].find({"_id": company["_id"]}).to_list(10)
        return docs
    if name == "users" or name in TENANT_COLLECTIONS:
        return await raw[name].find(_company_query(company_id)).to_list(100000)
    docs = await raw[name].find({"$or": [{"company_id": {"$exists": True}}, {"user_id": {"$exists": True}}]}).to_list(100000)
    return [doc for doc in docs if _linked(doc, user_ids, identities)]


async def _resolve_collections(user: User, requested: list[str] | None):
    company_id, company, user_ids, identities = await _tenant_context(user)
    raw = _raw_db()
    available = sorted(set(await raw.list_collection_names()) - EXCLUDED_COLLECTIONS)
    if not requested:
        selected = available
    else:
        requested_set = {name for name in requested if name in available}
        if not requested_set:
            raise HTTPException(status_code=400, detail="No valid backup collections were selected.")
        selected = sorted(requested_set)
    return company_id, company, user_ids, identities, selected


# ---------------------------------------------------------------------------
# Resumable, proxy-safe artifact streaming
# ---------------------------------------------------------------------------
# Motor's ``open_download_stream`` is a coroutine and MUST be awaited. It was
# previously used un-awaited, so the response generator raised AttributeError
# *after* the 200 headers had been sent. The proxy then returned 502 (no CORS
# header), which the browser reported as "Network Error". Downloads are also
# served with Range support so an interrupted transfer can resume instead of
# restarting, and are marked ``Content-Encoding: identity`` so GZipMiddleware
# does not try to compress an already-encrypted (incompressible) payload.
def _parse_range_header(header: str | None, size: int):
    if not header or size <= 0 or not header.lower().startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    start_text, _, end_text = spec.partition("-")
    try:
        if start_text == "":
            suffix = int(end_text)
            if suffix <= 0:
                return None
            start, end = max(0, size - suffix), size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        raise HTTPException(
            status_code=416,
            detail="Requested range is not satisfiable.",
            headers={"Content-Range": f"bytes */{size}"},
        )
    return start, min(end, size - 1)


async def _stream_backup_artifact(request: Request, raw, doc: dict, backup_id: str):
    artifact_id = doc.get("artifact_file_id")
    if not isinstance(artifact_id, ObjectId):
        artifact_id = ObjectId(artifact_id) if ObjectId.is_valid(str(artifact_id)) else None
    if artifact_id is None:
        raise HTTPException(status_code=410, detail="The backup artifact is no longer available.")

    bucket = _backup_gridfs(raw)
    try:
        grid_out = bucket.open_download_stream(artifact_id)
        if inspect.isawaitable(grid_out):
            grid_out = await grid_out
    except Exception as exc:
        logger.error("Backup artifact missing: %s", exc, exc_info=True)
        raise HTTPException(status_code=410, detail="The backup artifact is no longer available.") from exc

    size = int(getattr(grid_out, "length", None) or doc.get("file_size_bytes") or 0)
    byte_range = _parse_range_header(request.headers.get("range"), size)
    start, end = byte_range if byte_range else (0, max(0, size - 1))
    length = (end - start + 1) if size else None

    async def stream_backup():
        skip = start
        remaining = length
        try:
            while remaining is None or remaining > 0:
                chunk = await grid_out.read(CHUNK_SIZE)
                if not chunk:
                    break
                if skip:
                    if len(chunk) <= skip:
                        skip -= len(chunk)
                        continue
                    chunk = chunk[skip:]
                    skip = 0
                if remaining is not None:
                    chunk = chunk[:remaining]
                    remaining -= len(chunk)
                yield chunk
        except Exception:
            logger.error("Backup artifact stream failed for %s", backup_id, exc_info=True)
            raise
        finally:
            try:
                await grid_out.close()
            except Exception:
                pass

    filename = (doc.get("filename") or f"onenexa-backup-{backup_id}{NEW_BACKUP_EXTENSION}").replace('"', "")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Accept-Ranges": "bytes",
        "Content-Encoding": "identity",
        "Cache-Control": "no-store",
        "X-Backup-Size": str(size),
    }
    status = 200
    if length is not None:
        headers["Content-Length"] = str(length)
    if byte_range:
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        stream_backup(),
        status_code=status,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/info")
async def backup_info(current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    company_id, company, user_ids, identities = await _tenant_context(current_user)
    raw = _raw_db()
    available = sorted(set(await raw.list_collection_names()) - EXCLUDED_COLLECTIONS)
    modules = {module: sorted(set(collections) & set(available)) for module, collections in MODULE_COLLECTION_MAP.items()}
    return {"format": "Taskosphere Portable Backup v1", "company_id": company_id, "company_name": (company or {}).get("name"), "user_count": len(user_ids), "collections": available, "modules": modules, "encrypted": True, "requires_password": True, "mongo_database": DB_NAME, "mongo_connection_configured": bool(MONGO_URL), "excluded_security_collections": sorted(EXCLUDED_COLLECTIONS), "notes": ["Full backup includes tenant MongoDB data, tenant-linked settings and index definitions.", "Live sessions, reset tokens and OAuth state are never exported.", "Cross-license restore remaps company/license/customer identifiers to the target tenant."]}


@router.post("/create")
async def create_backup(request: Request, current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)

    content_type = (request.headers.get("content-type") or "").lower()
    password = ""
    collections = ""
    try:
        if "multipart/form-data" in content_type:
            form = await request.form()
            password = str(form.get("password") or "")
            collections = str(form.get("collections") or "")
        elif "application/json" in content_type:
            payload = await request.json()
            if isinstance(payload, dict):
                password = str(payload.get("password") or "")
                collections = str(payload.get("collections") or "")
        else:
            try:
                payload = await request.json()
                if isinstance(payload, dict):
                    password = str(payload.get("password") or "")
                    collections = str(payload.get("collections") or "")
            except Exception:
                pass
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid backup request: {exc}") from exc

    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Backup password must be at least 8 characters.")

    requested = [item.strip() for item in collections.split(",") if item.strip()] or None
    progress_id = (request.headers.get("x-backup-progress-id") or "").strip()[:120]
    if not progress_id:
        progress_id = secrets.token_urlsafe(24)

    _set_backup_progress(progress_id, owner_user_id=_s(current_user.id), phase="queued", percent=0.0, processed_documents=0, total_documents=0, eta_seconds=None, elapsed_seconds=0.0, current_collection=None, download_ready=False)
    task = asyncio.create_task(_run_backup_job(progress_id, current_user, password, requested))
    _BACKUP_TASKS[progress_id] = task
    return {"success": True, "progress_id": progress_id, "status": "queued", "message": "Backup job started."}


async def _run_backup_job(progress_id: str, current_user: User, password: str, requested: list[str] | None):
    try:
        output, manifest = await _build_archive(current_user, password, requested, progress_id)
        filename = f"onenexa-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}{NEW_BACKUP_EXTENSION}"
        _BACKUP_OUTPUTS[progress_id] = {
            "path": output,
            "filename": filename,
            "owner_user_id": _s(current_user.id),
            "created_at": time.time(),
        }
        _set_backup_progress(
            progress_id,
            owner_user_id=_s(current_user.id),
            phase="ready",
            percent=100.0,
            eta_seconds=0.0,
            current_collection=None,
            file_size=os.path.getsize(output),
            download_ready=True,
            filename=filename,
        )
        try:
            history_id = await _persist_backup_artifact(output, filename, manifest, current_user, progress_id)
            _BACKUP_OUTPUTS[progress_id]["history_id"] = str(history_id)
            _set_backup_progress(progress_id, history_id=str(history_id), history_persisted=True, history_warning=None)
        except Exception as history_exc:
            logger.error("Backup completed but History persistence failed for %s: %s", progress_id, history_exc, exc_info=True)
            _set_backup_progress(
                progress_id,
                history_persisted=False,
                history_warning="Backup completed successfully, but History storage failed. Download the backup now; it remains available from this completed job.",
            )
        asyncio.create_task(_expire_backup_output(progress_id))
    except Exception as exc:
        previous = _BACKUP_PROGRESS.get(progress_id, {})
        _set_backup_progress(
            progress_id,
            owner_user_id=_s(current_user.id),
            phase="error",
            percent=float(previous.get("percent") or 0.0),
            processed_documents=previous.get("processed_documents", 0),
            total_documents=previous.get("total_documents", 0),
            eta_seconds=None,
            current_collection=previous.get("current_collection"),
            error=str(exc) if isinstance(exc, HTTPException) else f"Backup creation failed on the server: {exc}",
            download_ready=False,
        )
        logger.error("Background backup creation failed for %s: %s", progress_id, exc, exc_info=True)
    finally:
        _BACKUP_TASKS.pop(progress_id, None)


@router.get("/create/download/{progress_id}")
async def download_created_backup(progress_id: str, request: Request, current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    if not progress_id or len(progress_id) > 120:
        raise HTTPException(status_code=400, detail="Invalid backup progress id.")
    state = _get_backup_progress(progress_id)
    if _s(state.get("owner_user_id")) != _s(current_user.id):
        raise HTTPException(status_code=404, detail="Backup progress session not found.")
    if state.get("phase") != "ready":
        raise HTTPException(status_code=409, detail="Backup is still being created.")
    history_id = _s(state.get("history_id"))
    if ObjectId.is_valid(history_id):
        raw = _raw_db()
        doc = await raw[BACKUP_HISTORY_COLLECTION].find_one({"_id": ObjectId(history_id)})
        if doc:
            return await _stream_backup_artifact(request, raw, doc, history_id)

    item = _BACKUP_OUTPUTS.get(progress_id)
    if item and item.get("owner_user_id") == _s(current_user.id) and os.path.exists(item.get("path", "")):
        return FileResponse(item["path"], media_type="application/octet-stream", filename=item.get("filename") or "onenexa-backup.onenexa")
    raise HTTPException(status_code=409, detail="Backup is complete but no downloadable artifact is currently available.")


@router.get("/history")
async def list_backup_history(current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    company_id, _, _, _ = await _tenant_context(current_user)
    raw = _raw_db()
    await _ensure_backup_history_indexes(raw)
    cursor = raw[BACKUP_HISTORY_COLLECTION].find({"company_id": company_id}).sort("created_at", -1)
    records = []
    async for doc in cursor:
        records.append(_history_document(doc))
    return {"history": records, "count": len(records)}


@router.get("/history/{backup_id}/download")
async def download_backup_history(backup_id: str, request: Request, current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    if not ObjectId.is_valid(backup_id):
        raise HTTPException(status_code=400, detail="Invalid backup history id.")
    company_id, _, _, _ = await _tenant_context(current_user)
    raw = _raw_db()
    doc = await raw[BACKUP_HISTORY_COLLECTION].find_one({"_id": ObjectId(backup_id), "company_id": company_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Backup history record not found.")
    return await _stream_backup_artifact(request, raw, doc, backup_id)


@router.delete("/history/{backup_id}")
async def delete_backup_history(backup_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not ObjectId.is_valid(backup_id):
        raise HTTPException(status_code=400, detail="Invalid backup history id.")
    company_id, _, _, _ = await _tenant_context(current_user)
    raw = _raw_db()
    history_collection = raw[BACKUP_HISTORY_COLLECTION]
    doc = await history_collection.find_one({"_id": ObjectId(backup_id), "company_id": company_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Backup history record not found.")

    deleted_meta = await history_collection.delete_one({"_id": ObjectId(backup_id), "company_id": company_id})
    if deleted_meta.deleted_count != 1:
        raise HTTPException(status_code=409, detail="Backup history record changed before deletion. Please refresh and retry.")

    artifact_id = doc.get("artifact_file_id")
    if not isinstance(artifact_id, ObjectId):
        artifact_id = ObjectId(artifact_id) if ObjectId.is_valid(str(artifact_id)) else None
    if artifact_id is not None:
        try:
            await _backup_gridfs(raw).delete(artifact_id)
        except Exception as exc:
            try:
                await history_collection.insert_one(doc)
            except Exception:
                logger.critical("Backup history rollback failed after artifact deletion failure: %s", exc, exc_info=True)
            raise HTTPException(status_code=500, detail="Backup data could not be deleted completely. The history record was restored; please retry.") from exc

    return {"success": True, "deleted_backup_id": backup_id, "message": "Backup history record and stored backup data deleted."}


async def _read_archive(zip_path: str):
    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            names = set(archive.namelist())
            if "manifest.json" not in names:
                raise ValueError("manifest.json is missing")
            manifest = json.loads(archive.read("manifest.json").decode())
            if manifest.get("format") != "taskosphere-backup" or manifest.get("version") != FORMAT_VERSION:
                raise ValueError("unsupported backup format")
            collections = []
            for name, meta in (manifest.get("collections") or {}).items():
                entry = f"collections/{meta['safe_name']}.jsonl"
                if entry not in names:
                    raise ValueError(f"Collection payload missing: {name}")
                collections.append((name, entry))
            return manifest, collections
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Backup archive is invalid: {exc}") from exc




async def _legacy_source_context(zip_path: str, collections: list[tuple[str, str]]):
    source_company = {}
    source_company_id = ""
    company_entry = next((entry for name, entry in collections if name == "companies"), None)
    if company_entry:
        with zipfile.ZipFile(zip_path, "r") as archive:
            with archive.open(company_entry, "r") as member:
                for raw_line in member:
                    if not raw_line.strip():
                        continue
                    source_company = _load(raw_line.decode("utf-8"))
                    source_company_id = _s(
                        source_company.get("id")
                        or source_company.get("company_id")
                        or source_company.get("_id")
                    )
                    break

    if not source_company_id:
        users_entry = next((entry for name, entry in collections if name == "users"), None)
        if users_entry:
            with zipfile.ZipFile(zip_path, "r") as archive:
                with archive.open(users_entry, "r") as member:
                    for raw_line in member:
                        if not raw_line.strip():
                            continue
                        user_doc = _load(raw_line.decode("utf-8"))
                        source_company_id = _s(user_doc.get("company_id"))
                        if source_company_id:
                            break

    return source_company_id, source_company


async def _legacy_user_replacements(
    zip_path: str,
    collections: list[tuple[str, str]],
    current_user: User,
    raw,
    target_company_id: str,
    source_owner_id: str,
):
    entry = next((entry for name, entry in collections if name == "users"), None)
    replacements = {}
    if not entry:
        if source_owner_id:
            replacements[source_owner_id] = _s(current_user.id)
        return replacements

    with zipfile.ZipFile(zip_path, "r") as archive:
        with archive.open(entry, "r") as member:
            for raw_line in member:
                if not raw_line.strip():
                    continue

                doc = _load(raw_line.decode("utf-8"))
                old_id = _s(doc.get("id"))
                if not old_id:
                    continue

                old_object_id = _s(doc.get("_id"))
                if old_id == source_owner_id:
                    new_id = _s(current_user.id)
                else:
                    email = _s(doc.get("email")).lower()
                    existing = None
                    if email:
                        existing = await raw.users.find_one(
                            {
                                "company_id": target_company_id,
                                "email": doc.get("email"),
                            },
                            {"id": 1},
                        )

                    new_id = _s(existing.get("id")) if existing else old_id
                    if not new_id:
                        new_id = secrets.token_urlsafe(18)

                    if not existing:
                        collision = await raw.users.find_one({"id": new_id}, {"company_id": 1})
                        if collision and _s(collision.get("company_id")) != target_company_id:
                            new_id = secrets.token_urlsafe(18)

                replacements[old_id] = new_id
                if old_object_id:
                    replacements[old_object_id] = new_id

    if source_owner_id:
        replacements[source_owner_id] = _s(current_user.id)
    return replacements



def _replace(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [_replace(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _replace(item, replacements) for key, item in value.items()}
    return value


async def _restore(manifest: dict, collections: list[tuple[str, str]], current_user: User, zip_path: str, legacy_migration: bool = False):
    target_company_id, target_company, target_user_ids, target_identities = await _tenant_context(current_user)
    source_company = _s(manifest.get("source_company_id"))
    source_owner = _s(manifest.get("owner_user_id"))
    source_company_doc = None

    if legacy_migration:
        if not source_owner:
            raise HTTPException(status_code=400, detail="Legacy backup is missing the source administrator identity.")
        source_company, source_company_doc = await _legacy_source_context(zip_path, collections)
        replacements = await _legacy_user_replacements(
            zip_path, collections, current_user, _raw_db(), target_company_id, source_owner
        )
    else:
        if not source_company or not source_owner:
            raise HTTPException(status_code=400, detail="Backup is missing tenant ownership metadata.")
        replacements = {source_company: target_company_id, source_owner: _s(current_user.id)}
    source_license = _s(manifest.get("source_license_id"))
    source_customer = _s(manifest.get("source_commercial_customer_id"))
    target_license = next(iter(target_identities["license_id"]), "")
    target_customer = next(iter(target_identities["commercial_customer_id"]), "")
    if source_license and target_license:
        replacements[source_license] = target_license
    if source_customer and target_customer:
        replacements[source_customer] = target_customer
    if source_company:
        replacements[source_company] = target_company_id

    selected_names = [name for name, _ in collections]
    raw = _raw_db()

    # Clear target data first, preserving the live administrator account.
    removed = 0
    for name in selected_names:
        if name in EXCLUDED_COLLECTIONS or name == "companies":
            continue
        if name == "users":
            result = await raw.users.delete_many({"company_id": target_company_id, "id": {"$ne": current_user.id}})
        elif name in TENANT_COLLECTIONS or legacy_migration:
            result = await raw[name].delete_many({"company_id": target_company_id})
        else:
            result = type("DeleteResult", (), {"deleted_count": 0})()
            cursor = raw[name].find({})
            async for existing in cursor:
                if _linked(existing, {_s(current_user.id)}, target_identities) and existing.get("_id") is not None:
                    result.deleted_count += (
                        await raw[name].delete_one({"_id": existing["_id"]})
                    ).deleted_count
        removed += getattr(result, "deleted_count", 0)

    restored = 0
    live_admin = await raw.users.find_one({"id": current_user.id})

    # Process one JSONL document at a time instead of materializing every
    # collection into memory. The decrypted ZIP remains on disk.
    with zipfile.ZipFile(zip_path, "r") as archive:
        for name, entry in collections:
            if name in EXCLUDED_COLLECTIONS:
                continue
            try:
                member = archive.open(entry, "r")
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=f"Collection payload missing: {name}") from exc

            with member:
                if name == "companies":
                    first_doc = None
                    for raw_line in member:
                        if not raw_line.strip():
                            continue
                        first_doc = _replace(_load(raw_line.decode("utf-8")), replacements)
                        break
                    if first_doc is None:
                        continue
                    doc = first_doc
                    doc["id"] = target_company_id
                    if legacy_migration and source_company_doc:
                        for key, value in source_company_doc.items():
                            if key not in {"_id", "id", "license_id", "commercial_customer_id"}:
                                doc.setdefault(key, value)
                    if target_license:
                        doc["license_id"] = target_license
                    if target_customer:
                        doc["commercial_customer_id"] = target_customer
                    if target_company and target_company.get("_id") is not None:
                        doc["_id"] = target_company["_id"]
                    query = (
                        {"_id": target_company["_id"]}
                        if target_company and target_company.get("_id") is not None
                        else {"id": target_company_id}
                    )
                    await raw.companies.replace_one(query, doc, upsert=True)
                    restored += 1
                    continue

                for raw_line in member:
                    if not raw_line.strip():
                        continue
                    doc = _replace(_load(raw_line.decode("utf-8")), replacements)

                    if name == "users":
                        if _s(doc.get("id")) == _s(current_user.id):
                            if live_admin:
                                for field in AUTH_FIELDS_TO_PRESERVE:
                                    if field in live_admin:
                                        doc[field] = live_admin[field]
                            doc["id"] = current_user.id
                            doc["company_id"] = target_company_id
                        else:
                            doc["company_id"] = target_company_id
                    elif legacy_migration or "company_id" in doc:
                        doc["company_id"] = target_company_id

                    if legacy_migration and doc.get("_id") is not None:
                        existing = await raw[name].find_one({"_id": doc["_id"]}, {"company_id": 1})
                        if existing and _s(existing.get("company_id")) != target_company_id:
                            doc.pop("_id", None)

                    query = (
                        {"id": doc.get("id"), "company_id": target_company_id}
                        if legacy_migration and doc.get("id") is not None
                        else (
                            {"_id": doc["_id"]}
                            if doc.get("_id") is not None
                            else {"id": doc.get("id")}
                        )
                    )
                    await raw[name].replace_one(query, doc, upsert=True)
                    restored += 1

    return {
        "restored_documents": restored,
        "removed_documents": removed,
        "target_company_id": target_company_id,
    }

@router.post("/restore")
async def restore_backup(backup: UploadFile = File(...), password: str = Form(...), confirmation: str = Form(...), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if confirmation.strip() != "RESTORE":
        raise HTTPException(status_code=400, detail="Type RESTORE exactly to confirm the operation.")
    backup_extension = os.path.splitext(backup.filename or "")[1].lower()
    if backup_extension not in SUPPORTED_BACKUP_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Upload a .onenexa backup file. Legacy .taskosphere backups are also supported for migration.")
    fd, source_path = tempfile.mkstemp(prefix="onenexa-upload-", suffix=backup_extension)
    os.close(fd)
    zip_path = None
    try:
        total = 0
        with open(source_path, "wb") as out:
            while chunk := await backup.read(CHUNK_SIZE):
                total += len(chunk)
                if total > MAX_BACKUP_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Backup file exceeds the 100 MB upload limit.")
                out.write(chunk)
        zip_path = _decrypt(source_path, password)
        manifest, collections = await _read_archive(zip_path)
        # Older Taskosphere backup files may omit the scope field or use a
        # legacy tenant-scope label. Tenant ownership metadata is still mandatory
        # and _restore performs the authenticated target remapping.
        scope = str(manifest.get("scope") or "").strip().lower()
        legacy_migration = scope == "single_application"
        supported_scopes = {
            "",
            "single_customer_tenant",
            "single_tenant",
            "customer_tenant",
            "single_customer",
            "single_application",
        }
        if scope not in supported_scopes:
            raise HTTPException(status_code=400, detail="Unsupported backup scope.")
        if legacy_migration:
            if not _s(manifest.get("owner_user_id")):
                raise HTTPException(status_code=400, detail="Legacy backup is missing the source administrator identity.")
        elif not _s(manifest.get("source_company_id")) or not _s(manifest.get("owner_user_id")):
            raise HTTPException(status_code=400, detail="Backup is missing tenant ownership metadata.")
        result = await _restore(
            manifest,
            collections,
            current_user,
            zip_path,
            legacy_migration=legacy_migration,
        )
        return {"success": True, "message": "Application backup restored successfully.", **result}
    finally:
        try: os.unlink(source_path)
        except FileNotFoundError: pass
        if zip_path:
            try: os.unlink(zip_path)
            except FileNotFoundError: pass


# ---------------------------------------------------------------------------
# Render-safe backup builder
# ---------------------------------------------------------------------------
# Preserve the existing tenant-aware backup implementation above. This
# production builder only changes how documents are written: one document at
# a time directly into the ZIP member rather than building a giant in-memory
# string with join(). Tenant/company/license remapping remains unchanged.
# ---------------------------------------------------------------------------
# Live backup progress
# ---------------------------------------------------------------------------
_BACKUP_PROGRESS = globals().get("_BACKUP_PROGRESS", {})
_BACKUP_OUTPUTS = globals().get("_BACKUP_OUTPUTS", {})
_BACKUP_TASKS = globals().get("_BACKUP_TASKS", {})
_BACKUP_PROGRESS_TTL_SECONDS = 3600
_BACKUP_OUTPUT_TTL_SECONDS = 3600

def _cleanup_backup_output(progress_id: str):
    item = _BACKUP_OUTPUTS.pop(progress_id, None)
    if item:
        try:
            os.unlink(item.get("path", ""))
        except (FileNotFoundError, TypeError):
            pass


async def _expire_backup_output(progress_id: str):
    await asyncio.sleep(_BACKUP_OUTPUT_TTL_SECONDS)
    item = _BACKUP_OUTPUTS.get(progress_id)
    if item and time.time() - float(item.get("created_at", time.time())) >= _BACKUP_OUTPUT_TTL_SECONDS:
        _cleanup_backup_output(progress_id)

def _set_backup_progress(progress_id: str | None, **values):
    if not progress_id:
        return
    now = time.time()
    state = _BACKUP_PROGRESS.get(progress_id, {})
    state.update(values)
    state["updated_at"] = now
    _BACKUP_PROGRESS[progress_id] = state

    cutoff = now - _BACKUP_PROGRESS_TTL_SECONDS
    for key in [
        key for key, item in _BACKUP_PROGRESS.items()
        if item.get("updated_at", now) < cutoff
    ]:
        _BACKUP_PROGRESS.pop(key, None)


def _get_backup_progress(progress_id: str):
    state = _BACKUP_PROGRESS.get(progress_id)
    if not state:
        raise HTTPException(status_code=404, detail="Backup progress session not found.")
    state = dict(state)
    state.pop("updated_at", None)
    return state


@router.get("/create/progress/{progress_id}")
async def backup_create_progress(progress_id: str, current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    if not progress_id or len(progress_id) > 120:
        raise HTTPException(status_code=400, detail="Invalid backup progress id.")
    return _get_backup_progress(progress_id)


async def _count_commercial_backup_documents(raw, name, company_id, company, user_ids, identities):
    cursor = raw[name].find({})
    count = 0
    async for doc in cursor:
        if name in EXCLUDED_COLLECTIONS:
            continue

        include_doc = False
        if name == "companies":
            include_doc = (
                _s(doc.get("id")) == company_id
                or (
                    company
                    and company.get("_id") is not None
                    and doc.get("_id") == company.get("_id")
                )
            )
        elif name == "users" or name in TENANT_COLLECTIONS:
            include_doc = _s(doc.get("company_id")) == company_id
        else:
            include_doc = _linked(doc, user_ids, identities)

        if include_doc:
            count += 1
    return count


async def _build_archive(
    user: User,
    password: str,
    requested: list[str] | None,
    progress_id: str | None = None,
):
    company_id, company, user_ids, identities, selected = await _resolve_collections(user, requested)
    raw = _raw_db()
    started_at = time.monotonic()

    _set_backup_progress(
        progress_id,
        phase="preparing",
        percent=0.0,
        processed_documents=0,
        total_documents=0,
        eta_seconds=None,
        elapsed_seconds=0.0,
        current_collection=None,
    )

    total_documents = 0
    for name in selected:
        total_documents += await _count_commercial_backup_documents(
            raw, name, company_id, company, user_ids, identities
        )

    _set_backup_progress(
        progress_id,
        phase="creating",
        percent=0.0 if total_documents else 90.0,
        processed_documents=0,
        total_documents=total_documents,
        eta_seconds=None,
        elapsed_seconds=round(time.monotonic() - started_at, 1),
        current_collection=None,
    )

    manifest = {
        "format": "taskosphere-backup",
        "version": FORMAT_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "database": DB_NAME,
        "scope": "single_customer_tenant",
        "source_company_id": company_id,
        "source_license_id": next(iter(identities["license_id"]), None),
        "source_commercial_customer_id": next(iter(identities["commercial_customer_id"]), None),
        "owner_user_id": _s(user.id),
        "company_name": (company or {}).get("name"),
        "bson_encoding": "MongoDB Extended JSON v2 canonical",
        "encryption": "AES-256-GCM + PBKDF2-HMAC-SHA256",
        "selection": "full" if not requested else "custom",
        "collections": {},
        "excluded_collections": sorted(EXCLUDED_COLLECTIONS),
    }

    fd, zip_path = tempfile.mkstemp(prefix="taskosphere-backup-", suffix=".zip")
    os.close(fd)
    output = None
    processed_documents = 0

    try:
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
        ) as archive:
            for name in selected:
                safe = name.replace("/", "_")
                document_count = 0

                with archive.open(
                    f"collections/{safe}.jsonl",
                    mode="w",
                    force_zip64=True,
                ) as entry:
                    cursor = raw[name].find({})
                    pending_lines = []
                    async for doc in cursor:
                        if name in EXCLUDED_COLLECTIONS:
                            continue

                        include_doc = False
                        if name == "companies":
                            include_doc = (
                                _s(doc.get("id")) == company_id
                                or (
                                    company
                                    and company.get("_id") is not None
                                    and doc.get("_id") == company.get("_id")
                                )
                            )
                        elif name == "users" or name in TENANT_COLLECTIONS:
                            include_doc = _s(doc.get("company_id")) == company_id
                        else:
                            include_doc = _linked(doc, user_ids, identities)

                        if not include_doc:
                            continue

                        pending_lines.append(doc)
                        document_count += 1
                        processed_documents += 1
                        if len(pending_lines) >= 500:
                            payload = await asyncio.to_thread(_dump_batch, pending_lines)
                            await asyncio.to_thread(entry.write, payload)
                            pending_lines.clear()
                        if processed_documents % 500 == 0 or processed_documents == total_documents:
                            elapsed = max(0.001, time.monotonic() - started_at)
                            ratio = (
                                processed_documents / total_documents
                                if total_documents
                                else 1.0
                            )
                            percent = min(90.0, ratio * 90.0)
                            speed = processed_documents / elapsed if processed_documents else 0.0
                            remaining = max(0, total_documents - processed_documents)
                            eta = (remaining / speed) if speed > 0 else None

                            _set_backup_progress(
                                progress_id,
                                phase="creating",
                                percent=round(percent, 2),
                                processed_documents=processed_documents,
                                total_documents=total_documents,
                                eta_seconds=round(eta, 1) if eta is not None else None,
                                elapsed_seconds=round(elapsed, 1),
                                current_collection=name,
                            )

                        if processed_documents % 50 == 0:
                            await asyncio.sleep(0)

                    if pending_lines:
                        payload = await asyncio.to_thread(_dump_batch, pending_lines)
                        await asyncio.to_thread(entry.write, payload)
                        pending_lines.clear()

                try:
                    list_indexes = getattr(raw[name], "list_indexes", None)
                    indexes = (
                        await list_indexes().to_list(1000)
                        if callable(list_indexes)
                        else []
                    )
                    indexes = [idx for idx in indexes if idx.get("name") != "_id_"]
                    if indexes:
                        archive.writestr(
                            f"indexes/{safe}.json",
                            _dump(indexes),
                        )
                except Exception:
                    pass

                if document_count:
                    manifest["collections"][name] = {
                        "documents": document_count,
                        "safe_name": safe,
                    }

            archive.writestr(
                "manifest.json",
                json.dumps(manifest, indent=2, sort_keys=True),
            )

        fd, output = tempfile.mkstemp(
            prefix="onenexa-backup-",
            suffix=NEW_BACKUP_EXTENSION,
        )
        os.close(fd)

        _set_backup_progress(
            progress_id,
            phase="encrypting",
            percent=90.0,
            processed_documents=processed_documents,
            total_documents=total_documents,
            eta_seconds=None,
            elapsed_seconds=round(time.monotonic() - started_at, 1),
            current_collection=None,
        )

        await asyncio.to_thread(
            _encrypt_with_progress,
            zip_path,
            output,
            password,
            progress_id,
            90.0,
            100.0,
            started_at,
        )

        elapsed = max(0.001, time.monotonic() - started_at)
        _set_backup_progress(
            progress_id,
            phase="ready",
            percent=100.0,
            processed_documents=processed_documents,
            total_documents=total_documents,
            eta_seconds=0.0,
            elapsed_seconds=round(elapsed, 1),
            current_collection=None,
            file_size=os.path.getsize(output),
        )
        return output, manifest

    except Exception as exc:
        _set_backup_progress(
            progress_id,
            phase="error",
            percent=0.0,
            eta_seconds=None,
            elapsed_seconds=round(time.monotonic() - started_at, 1),
            current_collection=None,
            error="Backup creation failed on the server.",
        )
        logger.error("Progressive commercial backup creation failed: %s", exc, exc_info=True)
        if output:
            try:
                os.unlink(output)
            except FileNotFoundError:
                pass
        raise
    finally:
        try:
            os.unlink(zip_path)
        except FileNotFoundError:
            pass



def _encrypt_with_progress(
    zip_path: str,
    output_path: str,
    password: str,
    progress_id: str | None = None,
    progress_start: float = 90.0,
    progress_end: float = 100.0,
    started_at: float | None = None,
) -> None:
    """Encrypt the completed ZIP while reporting byte-based progress."""
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    encryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce)).encryptor()
    total_bytes = max(1, os.path.getsize(zip_path))
    encrypted_bytes = 0
    start = started_at or time.monotonic()

    with open(output_path, "wb") as out, open(zip_path, "rb") as source:
        out.write(_header(salt, nonce))
        while chunk := source.read(CHUNK_SIZE):
            encrypted_bytes += len(chunk)
            out.write(encryptor.update(chunk))

            if progress_id:
                elapsed = max(0.001, time.monotonic() - start)
                stage_percent = min(100.0, (encrypted_bytes / total_bytes) * 100.0)
                percent = progress_start + (
                    (progress_end - progress_start) * stage_percent / 100.0
                )
                remaining = max(0, total_bytes - encrypted_bytes)
                speed = encrypted_bytes / elapsed
                eta = remaining / speed if speed > 0 else None

                _set_backup_progress(
                    progress_id,
                    phase="encrypting",
                    percent=round(percent, 2),
                    processed_documents=None,
                    total_documents=None,
                    processed_bytes=encrypted_bytes,
                    total_bytes=total_bytes,
                    eta_seconds=round(eta, 1) if eta is not None else None,
                    elapsed_seconds=round(elapsed, 1),
                    current_collection=None,
                )

        out.write(encryptor.finalize())
        out.write(encryptor.tag)

