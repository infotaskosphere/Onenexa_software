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
import json
import os
import secrets
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId, json_util
from bson.json_util import CANONICAL_JSON_OPTIONS
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from backend.dependencies import DB_NAME, MONGO_URL, client, db, get_current_user, get_user_permissions
from backend.models import User
from backend.tenant_runtime import TENANT_COLLECTIONS
from backend.permission_governance import GOVERNED_MODULES
from backend.platform_owner import is_platform_owner

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

EXCLUDED_COLLECTIONS = {
    "sessions", "refresh_tokens", "access_tokens", "password_resets",
    "password_reset_tokens", "verification_tokens", "email_verification_tokens",
    "oauth_states", "oauth_tokens", "rate_limits",
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


def _encrypt(zip_path: str, output_path: str, password: str) -> None:
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    encryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce)).encryptor()
    with open(output_path, "wb") as out, open(zip_path, "rb") as source:
        out.write(_header(salt, nonce))
        while chunk := source.read(CHUNK_SIZE):
            out.write(encryptor.update(chunk))
        out.write(encryptor.finalize())
        out.write(encryptor.tag)


def _decrypt(source_path: str, password: str) -> str:
    with open(source_path, "rb") as source:
        salt, nonce = _read_header(source)
        payload = source.read()
    if len(payload) <= 16:
        raise HTTPException(status_code=400, detail="Backup payload is incomplete.")
    ciphertext, tag = payload[:-16], payload[-16:]
    try:
        decryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce, tag)).decryptor()
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Backup password is incorrect or the backup is corrupted.") from exc
    fd, path = tempfile.mkstemp(prefix="taskosphere-restore-", suffix=".zip")
    os.close(fd)
    with open(path, "wb") as out:
        out.write(plaintext)
    return path


def _dump(value: Any) -> str:
    return json_util.dumps(value, json_options=CANONICAL_JSON_OPTIONS)


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


async def _build_archive(user: User, password: str, requested: list[str] | None):
    company_id, company, user_ids, identities, selected = await _resolve_collections(user, requested)
    raw = _raw_db()
    manifest = {"format": "taskosphere-backup", "version": FORMAT_VERSION, "created_at": datetime.now(timezone.utc).isoformat(), "database": DB_NAME, "scope": "single_customer_tenant", "source_company_id": company_id, "source_license_id": next(iter(identities["license_id"]), None), "source_commercial_customer_id": next(iter(identities["commercial_customer_id"]), None), "owner_user_id": _s(user.id), "company_name": (company or {}).get("name"), "bson_encoding": "MongoDB Extended JSON v2 canonical", "encryption": "AES-256-GCM + PBKDF2-HMAC-SHA256", "selection": "full" if not requested else "custom", "collections": {}, "excluded_collections": sorted(EXCLUDED_COLLECTIONS)}
    fd, zip_path = tempfile.mkstemp(prefix="taskosphere-backup-", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in selected:
                docs = await _collection_docs(raw, name, company_id, user_ids, identities, company)
                if not docs:
                    continue
                safe = name.replace("/", "_")
                archive.writestr(f"collections/{safe}.jsonl", "".join(_dump(d) + "\n" for d in docs))
                try:
                    indexes = await raw[name].list_indexes().to_list(1000)
                    indexes = [idx for idx in indexes if idx.get("name") != "_id_"]
                    if indexes:
                        archive.writestr(f"indexes/{safe}.json", _dump(indexes))
                except Exception:
                    pass
                manifest["collections"][name] = {"documents": len(docs), "safe_name": safe}
            archive.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=True))
        fd, output = tempfile.mkstemp(prefix="taskosphere-backup-", suffix=".taskosphere")
        os.close(fd)
        _encrypt(zip_path, output, password)
        return output, manifest
    except Exception:
        try:
            os.unlink(locals().get("output", ""))
        except (FileNotFoundError, TypeError):
            pass
        raise
    finally:
        try:
            os.unlink(zip_path)
        except FileNotFoundError:
            pass


@router.get("/info")
async def backup_info(current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    company_id, company, user_ids, identities = await _tenant_context(current_user)
    raw = _raw_db()
    available = sorted(set(await raw.list_collection_names()) - EXCLUDED_COLLECTIONS)
    modules = {module: sorted(set(collections) & set(available)) for module, collections in MODULE_COLLECTION_MAP.items()}
    return {"format": "Taskosphere Portable Backup v1", "company_id": company_id, "company_name": (company or {}).get("name"), "user_count": len(user_ids), "collections": available, "modules": modules, "encrypted": True, "requires_password": True, "mongo_database": DB_NAME, "mongo_connection_configured": bool(MONGO_URL), "excluded_security_collections": sorted(EXCLUDED_COLLECTIONS), "notes": ["Full backup includes tenant MongoDB data, tenant-linked settings and index definitions.", "Live sessions, reset tokens and OAuth state are never exported.", "Cross-license restore remaps company/license/customer identifiers to the target tenant."]}


@router.post("/create")
async def create_backup(password: str = Form(...), collections: str = Form(""), current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    requested = [item.strip() for item in collections.split(",") if item.strip()] or None
    output, _manifest = await _build_archive(current_user, password, requested)
    filename = f"taskosphere-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.taskosphere"
    return FileResponse(output, media_type="application/octet-stream", filename=filename, background=BackgroundTask(lambda: os.path.exists(output) and os.unlink(output)))


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
                docs = [_load(line) for line in archive.read(entry).decode().splitlines() if line.strip()]
                collections.append((name, docs))
            return manifest, collections
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Backup archive is invalid: {exc}") from exc


def _replace(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [_replace(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _replace(item, replacements) for key, item in value.items()}
    return value


async def _restore(manifest: dict, collections: list[tuple[str, list[dict]]], current_user: User):
    target_company_id, target_company, target_user_ids, target_identities = await _tenant_context(current_user)
    source_company = _s(manifest.get("source_company_id"))
    source_owner = _s(manifest.get("owner_user_id"))
    if not source_company or not source_owner:
        raise HTTPException(status_code=400, detail="Backup is missing tenant ownership metadata.")
    replacements = {source_company: target_company_id, source_owner: _s(current_user.id)}
    source_license = _s(manifest.get("source_license_id"))
    source_customer = _s(manifest.get("source_commercial_customer_id"))
    target_license = next(iter(target_identities["license_id"]), "")
    target_customer = next(iter(target_identities["commercial_customer_id"]), "")
    if source_license and target_license: replacements[source_license] = target_license
    if source_customer and target_customer: replacements[source_customer] = target_customer
    raw = _raw_db()
    restored = removed = 0
    selected_names = {name for name, _ in collections}
    for name in selected_names:
        if name in EXCLUDED_COLLECTIONS or name == "companies":
            continue
        if name == "users":
            result = await raw.users.delete_many({"company_id": target_company_id, "id": {"$ne": current_user.id}})
        elif name in TENANT_COLLECTIONS:
            result = await raw[name].delete_many({"company_id": target_company_id})
        else:
            existing = await raw[name].find({}).to_list(100000)
            result = type("DeleteResult", (), {"deleted_count": 0})()
            for doc in existing:
                if _linked(doc, {_s(current_user.id)}, target_identities) and doc.get("_id") is not None:
                    result.deleted_count += (await raw[name].delete_one({"_id": doc["_id"]})).deleted_count
        removed += getattr(result, "deleted_count", 0)
    for name, docs in collections:
        if name in EXCLUDED_COLLECTIONS:
            continue
        rewritten = [_replace(doc, replacements) for doc in docs]
        if name == "companies":
            if not rewritten:
                continue
            doc = rewritten[0]
            doc["id"] = target_company_id
            if target_license: doc["license_id"] = target_license
            if target_customer: doc["commercial_customer_id"] = target_customer
            if target_company and target_company.get("_id") is not None: doc["_id"] = target_company["_id"]
            query = {"_id": target_company["_id"]} if target_company and target_company.get("_id") is not None else {"id": target_company_id}
            await raw.companies.replace_one(query, doc, upsert=True)
            restored += 1
            continue
        if name == "users":
            live_admin = await raw.users.find_one({"id": current_user.id})
            for doc in rewritten:
                if _s(doc.get("id")) == _s(current_user.id):
                    if live_admin:
                        for field in AUTH_FIELDS_TO_PRESERVE:
                            if field in live_admin: doc[field] = live_admin[field]
                    doc["id"] = current_user.id
                    doc["company_id"] = target_company_id
                else:
                    doc["company_id"] = target_company_id
                await raw.users.replace_one({"id": doc.get("id")}, doc, upsert=True)
                restored += 1
            continue
        for doc in rewritten:
            if "company_id" in doc: doc["company_id"] = target_company_id
            query = {"_id": doc["_id"]} if doc.get("_id") is not None else {"id": doc.get("id")}
            await raw[name].replace_one(query, doc, upsert=True)
            restored += 1
    return {"restored_documents": restored, "removed_documents": removed, "target_company_id": target_company_id}


@router.post("/restore")
async def restore_backup(backup: UploadFile = File(...), password: str = Form(...), confirmation: str = Form(...), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if confirmation.strip() != "RESTORE":
        raise HTTPException(status_code=400, detail="Type RESTORE exactly to confirm the operation.")
    if not backup.filename or not backup.filename.endswith(".taskosphere"):
        raise HTTPException(status_code=400, detail="Upload a .taskosphere backup file.")
    fd, source_path = tempfile.mkstemp(prefix="taskosphere-upload-", suffix=".taskosphere")
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
        if manifest.get("scope") != "single_customer_tenant":
            raise HTTPException(status_code=400, detail="Unsupported backup scope.")
        result = await _restore(manifest, collections, current_user)
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
async def _build_archive_streaming(user: User, password: str, requested: list[str] | None):
    company_id, company, user_ids, identities, selected = await _resolve_collections(user, requested)
    raw = _raw_db()
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

    try:
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        ) as archive:
            for name in selected:
                docs_cursor = raw[name].find({})
                document_count = 0

                with archive.open(
                    f"collections/{name.replace('/', '_')}.jsonl",
                    mode="w",
                    force_zip64=True,
                ) as entry:
                    # Filter tenant-linked records while streaming. This keeps
                    # the commercial tenant isolation rules intact.
                    async for doc in docs_cursor:
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
                            include_doc = (
                                _s(doc.get("company_id")) == company_id
                                or (
                                    doc.get("company_id") is not None
                                    and str(doc.get("company_id")) == str(company_id)
                                )
                            )
                        else:
                            include_doc = _linked(doc, user_ids, identities)

                        if not include_doc:
                            continue

                        entry.write((_dump(doc) + "\n").encode("utf-8"))
                        document_count += 1

                        if document_count % 250 == 0:
                            await asyncio.sleep(0)

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
                            f"indexes/{name.replace('/', '_')}.json",
                            _dump(indexes),
                        )
                except Exception:
                    pass

                if document_count:
                    manifest["collections"][name] = {
                        "documents": document_count,
                        "safe_name": name.replace("/", "_"),
                    }

            archive.writestr(
                "manifest.json",
                json.dumps(manifest, indent=2, sort_keys=True),
            )

        fd, output = tempfile.mkstemp(
            prefix="taskosphere-backup-",
            suffix=".taskosphere",
        )
        os.close(fd)
        _encrypt(zip_path, output, password)
        return output, manifest

    except Exception:
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


# The route resolves _build_archive when the request is handled, so this
# preserves the existing endpoint and tenant-aware behavior while replacing
# only the memory-heavy archive construction strategy.
_build_archive = _build_archive_streaming
