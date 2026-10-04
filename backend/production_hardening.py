"""Final production hardening boundary for the commercial application.

This module is intentionally additive. It strengthens the existing compatibility
layers before route modules are imported, rather than replacing working domain
handlers. It provides four protections:

* fail-closed commercial licensing for every authenticated customer request;
* active-user validation for both SaaS-session and legacy-JWT paths;
* broader tenant-aware Mongo collection coverage and request-level company checks;
* authentication on historically unprotected AI / Finix AI / API-v2 routes.

The module is imported from backend.__init__ before backend.server imports the
route modules, so newly registered sensitive routes inherit the hardening.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from backend import dependencies as _dependencies
from backend import commercial_module_guard as _guard
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import TENANT_COLLECTIONS, in_platform_owner_context

_hardening_logger = logging.getLogger("production_hardening")


# ---------------------------------------------------------------------------
# Tenant collection boundary
# ---------------------------------------------------------------------------
# These are operational/business collections. The Platform Owner and trusted
# system contexts are still intentionally exempt by the existing tenant layer.
_ADDITIONAL_TENANT_COLLECTIONS = {
    "audit_logs",
    "quotations",
    "quotation_services",
    "leads",
    "lead_activities",
    "lead_notes",
    "lead_followups",
    "due_dates",
    "documents",
    "document_movements",
    "dsc_register",
    "dsc_movements",
    "reminders",
    "notifications",
    "notification_history",
    "compliance",
    "compliance_masters",
    "compliance_assignments",
    "compliance_comments",
    "compliance_status",
    "attendance",
    "attendance_logs",
    "staff_activity",
    "visits",
    "visit_comments",
    "client_groups",
    "referrers",
    "auditors",
    "email_connections",
    "email_accounts",
    "email_extracted_events",
    "email_sender_settings",
    "email_templates",
    "email_scan_settings",
    "email_whitelist",
    "email_action_center",
    "passwords",
    "password_entries",
    "password_access_logs",
    "identix_devices",
    "identix_attendance",
    "identix_command_queue",
    "identix_commands",
    "finix_ai_proposals",
    "finix_ai_feedback",
    "finix_ai_inbox",
    "reconciliation_inbox",
    "reconciliation_feedback",
    "bank_reconciliation",
    "purchase_documents",
    "invoice_documents",
    "client_activity",
    "client_discussions",
    "leave_requests",
    "leave_records",
    "payroll_records",
    "hr_records",
    "performance_records",
    "recruitment_records",
    "master_data",
    "client_proposals",
}
TENANT_COLLECTIONS.update(_ADDITIONAL_TENANT_COLLECTIONS)


# ---------------------------------------------------------------------------
# Licensing: fail closed
# ---------------------------------------------------------------------------
_ORIGINAL_COMMERCIAL_LICENSE = _guard._commercial_license


async def _strict_commercial_license(user, *args, **kwargs):
    """Return the active customer license or stop the request.

    The legacy guard previously allowed an authenticated customer through when
    no active license could be resolved. Platform Owner remains exempt because
    it is not a commercial customer tenant.

    IMPORTANT: commercial_module_guard calls this as
    ``_commercial_license(user, request.url.path, request.method)``. The wrapper
    must therefore accept and forward the extra arguments. A one-argument
    signature raised ``TypeError`` on every authenticated request from a
    licensed (non Platform Owner) user, which surfaced as HTTP 500 on /auth/me
    and every dashboard endpoint.
    """
    license_doc = await _ORIGINAL_COMMERCIAL_LICENSE(user, *args, **kwargs)
    if license_doc is None and not is_platform_owner(user):
        raise HTTPException(
            status_code=403,
            detail="An active commercial license is required for this account.",
        )
    return license_doc


_guard._commercial_license = _strict_commercial_license


# ---------------------------------------------------------------------------
# Active-user enforcement for the legacy JWT path
# ---------------------------------------------------------------------------
_ORIGINAL_BASE_GET_CURRENT_USER = _guard._BASE_GET_CURRENT_USER


def _user_is_active(document: dict[str, Any]) -> bool:
    if document.get("is_active") is False:
        return False
    status_value = str(document.get("status") or "active").strip().lower()
    return status_value not in {"inactive", "disabled", "offboarded", "suspended", "terminated"}


async def _active_user_base(credentials):
    user = await _ORIGINAL_BASE_GET_CURRENT_USER(credentials)
    if is_platform_owner(user):
        return user

    raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
    user_id = str(getattr(user, "id", "") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user identity is invalid")

    query: dict[str, Any] = {"id": user_id}
    try:
        from bson import ObjectId
        if ObjectId.is_valid(user_id):
            query = {"$or": [{"id": user_id}, {"_id": ObjectId(user_id)}]}
    except Exception:
        pass

    document = await raw_db.users.find_one(query, {"_id": 0, "status": 1, "is_active": 1})
    if document is None:
        raise HTTPException(status_code=401, detail="User account not found")
    if not _user_is_active(document):
        raise HTTPException(status_code=403, detail="User account is inactive")
    return user


_guard._BASE_GET_CURRENT_USER = _active_user_base


# ---------------------------------------------------------------------------
# Final authenticated dependency used by newly protected routes
# ---------------------------------------------------------------------------
_PRE_HARDENED_GET_CURRENT_USER = _dependencies.get_current_user


async def get_current_user_hardened(
    request: Request,
    credentials=Depends(_dependencies.security),
):
    """Resolve the existing commercial identity, then enforce request scope."""
    # The commercial compatibility dependency accepts Request first and
    # credentials second. Pass both explicitly; omitting Request causes the
    # dependency wrapper to receive HTTPBearer credentials as a Request and
    # fail every protected dashboard request with HTTP 500.
    # Resolve through the already-installed compatibility chain. The chain
    # accepts Request first and credentials second all the way down.
    user = await _PRE_HARDENED_GET_CURRENT_USER(request, credentials)
    if is_platform_owner(user):
        request.state.platform_owner = True
        request.state.company_id = None
        request.state.commercial_customer_id = getattr(user, "commercial_customer_id", None)
        return user

    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")

    request.state.platform_owner = False
    request.state.company_id = company_id
    request.state.commercial_customer_id = getattr(user, "commercial_customer_id", None)

    # Never trust a frontend-supplied company_id that disagrees with the
    # authenticated operational company. Check query parameters first.
    for key, value in request.query_params.multi_items():
        if key == "company_id" or key.endswith("_company_id"):
            if value and str(value).strip() != company_id:
                # Say WHICH ids disagree (both belong to the caller / their own
                # request, so nothing about another tenant is disclosed). A bare
                # "Cross-company access is not permitted" made a stale company
                # picked by the browser indistinguishable from a real attack.
                _hardening_logger.warning(
                    "403 cross-company %s %s | user=%s authenticated_company_id=%s requested_%s=%s",
                    request.method, request.url.path, getattr(user, "email", None),
                    company_id, key, value,
                )
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "Cross-company access is not permitted: the selected company "
                        f"({str(value).strip()}) is not your licensed company ({company_id}). "
                        "Sign out, sign in again and select your own company."
                    ),
                )

    # Check JSON request bodies as well. Starlette caches request.json(), so the
    # downstream FastAPI/Pydantic body parser can still consume the same body.
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type == "application/json":
        try:
            payload = await request.json()
        except Exception:
            payload = None
        for requested in _find_company_ids(payload):
            if requested and requested != company_id:
                raise HTTPException(status_code=403, detail="Cross-company access is not permitted")

    return user


def _find_company_ids(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "company_id" or key.endswith("_company_id"):
                if item is not None and not isinstance(item, (dict, list, tuple, set)):
                    yield str(item).strip()
            if isinstance(item, (dict, list, tuple, set)):
                yield from _find_company_ids(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            yield from _find_company_ids(item)


# Make the canonical dependency visible to all modules imported after this
# bootstrap. Existing route handlers keep their own local reference, so no
# domain logic is rewritten.
_dependencies.get_current_user = get_current_user_hardened


# ---------------------------------------------------------------------------
# Team visibility resolver
# ---------------------------------------------------------------------------
async def _get_team_user_ids(manager_id):
    raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
    manager_id = str(manager_id)
    manager = await raw_db.users.find_one({"id": manager_id}, {"_id": 0, "company_id": 1, "departments": 1, "department": 1})
    if not manager:
        return []

    departments = manager.get("departments") or []
    if not departments and manager.get("department"):
        departments = [manager.get("department")]
    departments = [str(value).strip() for value in departments if str(value).strip()]

    query: dict[str, Any] = {
        "id": {"$ne": manager_id},
        "role": {"$in": ["staff", "manager"]},
    }
    company_id = str(manager.get("company_id") or "").strip()
    if company_id:
        query["company_id"] = company_id
    if departments:
        query["$or"] = [
            {"departments": {"$in": departments}},
            {"department": {"$in": departments}},
        ]

    rows = await raw_db.users.find(query, {"_id": 0, "id": 1}).to_list(1000)
    return [str(row.get("id")) for row in rows if row.get("id")]


_dependencies.get_team_user_ids = _get_team_user_ids


# Correct the legacy mappings without removing any existing permission names.
_dependencies.MODULE_ACTION_MAP.update(
    {
        "leads.delete": "can_manage_users",  # retained for backward compatibility
        "quotations.view": "can_create_quotations",
        "quotations.create": "can_create_quotations",
        "quotations.edit": "can_create_quotations",
        "quotations.delete": "can_create_quotations",
    }
)


# ---------------------------------------------------------------------------
# API request protection for historically dependency-free endpoints
# ---------------------------------------------------------------------------
_UNPROTECTED_SENSITIVE_PREFIXES = (
    "/ai/",
    "/finix/ai/",
    "/v2/copilot/",
    "/v2/search",
    "/v2/exports/",
)

_TENANT_CHECK_PREFIXES = (
    "/finix/",
    "/chart-of-accounts",
    "/journal-entries",
    "/reports/",
    "/bank-accounts",
    "/bank-transactions",
    "/party-ledgers",
    "/invoices",
    "/purchase",
    "/quotations",
    "/leads",
    "/compliance",
    "/due-dates",
    "/documents",
    "/dsc",
    "/passwords",
    "/attendance",
    "/visits",
)


_original_add_api_route = APIRouter.add_api_route
_PATCH_MARKER = "_taskosphere_production_hardened"


def _normalise_route_path(path: str) -> str:
    value = str(path or "")
    if value.startswith("/api"):
        value = value[4:] or "/"
    return value


def _should_protect(path: str) -> tuple[bool, bool]:
    normalized = _normalise_route_path(path)
    sensitive = any(normalized.startswith(prefix) for prefix in _UNPROTECTED_SENSITIVE_PREFIXES)
    tenant = any(normalized == prefix.rstrip("/") or normalized.startswith(prefix) for prefix in _TENANT_CHECK_PREFIXES)
    # API-v2 licensing activation is intentionally left public because it is a
    # bootstrap action for a newly purchased license.
    if normalized == "/v2/licensing/activate":
        sensitive = False
        tenant = False
    return sensitive, tenant


def _hardened_add_api_route(self, path, endpoint, *args, **kwargs):
    sensitive, tenant = _should_protect(path)
    if sensitive or tenant:
        dependencies = list(kwargs.get("dependencies") or [])
        existing = {getattr(item, "dependency", None) for item in dependencies}
        if get_current_user_hardened not in existing:
            dependencies.append(Depends(get_current_user_hardened))
        kwargs["dependencies"] = dependencies
    return _original_add_api_route(self, path, endpoint, *args, **kwargs)


if not getattr(APIRouter.add_api_route, _PATCH_MARKER, False):
    setattr(_hardened_add_api_route, _PATCH_MARKER, True)
    APIRouter.add_api_route = _hardened_add_api_route


# ---------------------------------------------------------------------------
# Credential hardening
# ---------------------------------------------------------------------------
def _harden_email_crypto():
    try:
        import backend.email_integration as email_module
        if email_module._fernet is None:
            from cryptography.fernet import Fernet
            key = os.getenv("EMAIL_ENCRYPT_KEY", "").encode()
            if len(key) == 44:
                email_module._fernet = Fernet(key)
            else:
                if str(os.getenv("ENV_MODE") or "").strip().lower() == "production":
                    raise RuntimeError("EMAIL_ENCRYPT_KEY environment variable must be set to a valid 44-character base64 Fernet key in production.")
                gen_key = Fernet.generate_key()
                os.environ["EMAIL_ENCRYPT_KEY"] = gen_key.decode()
                email_module._fernet = Fernet(gen_key)
                _hardening_logger.warning("EMAIL_ENCRYPT_KEY was not configured; generated secure runtime Fernet key.")

        def _secure_encrypt(plain: str) -> str:
            if not email_module._fernet:
                raise RuntimeError("Email credential encryption is unavailable")
            if plain is None:
                return ""
            return email_module._fernet.encrypt(str(plain).encode()).decode()

        def _secure_decrypt(stored: str) -> str:
            if not stored:
                return ""
            if not email_module._fernet:
                raise RuntimeError("Email credential decryption is unavailable")
            try:
                return email_module._fernet.decrypt(str(stored).encode()).decode()
            except Exception:
                # Never treat ciphertext as plaintext on a failed decrypt.
                return "[decryption failed]"

        email_module._encrypt = _secure_encrypt
        email_module._decrypt = _secure_decrypt
    except ImportError:
        # Email integration is optional in some lightweight environments.
        return


def _harden_password_crypto():
    try:
        if not os.getenv("PASSWORD_REPO_KEY"):
            if str(os.getenv("ENV_MODE") or "").strip().lower() == "production":
                raise RuntimeError("PASSWORD_REPO_KEY environment variable is not set. Refusing to start in production without an explicit encryption key for password vault.")
            from cryptography.fernet import Fernet
            os.environ["PASSWORD_REPO_KEY"] = Fernet.generate_key().decode()
            _hardening_logger.warning("PASSWORD_REPO_KEY was not configured; generated secure runtime Fernet key.")
        import backend.passwords as password_module
        if str(os.getenv("ENV_MODE") or "").strip().lower() != "production":
            return

        def _secure_decrypt(cipher: str) -> str:
            if not cipher:
                return ""
            try:
                return password_module._fernet.decrypt(str(cipher).encode()).decode()
            except Exception:
                # Production must not interpret legacy Base64 as plaintext.
                return password_module.DECRYPT_FAILED

        password_module._decrypt = _secure_decrypt
    except ImportError:
        return


_harden_email_crypto()
_harden_password_crypto()


# Public marker used by diagnostics/tests to verify that this boundary loaded.
HARDENING_VERSION = "2026-09-17.1"

__all__ = [
    "HARDENING_VERSION",
    "get_current_user_hardened",
]
