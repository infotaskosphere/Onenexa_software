"""Compatibility layer for the public commercial onboarding endpoints.

The commercial onboarding endpoints are intentionally public: a customer uses a
license key to create the first administrator before any JWT exists. The newer
customer-wide tenant/user-limit guards therefore cannot be the only enforcement
point for these routes. This module replaces the public onboarding handlers
with raw-database, license-authoritative versions and rebuilds their FastAPI
route dependencies before the application includes the router.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import Depends, HTTPException, status
from fastapi.dependencies.utils import get_dependant
from fastapi.routing import APIRoute

from backend import dependencies as _dependencies
from backend.dependencies import create_access_token, get_current_user
from backend.models import User
from backend.licensing_api import _expiry_reason, _find_license, _now, _public_license
from backend.commercial_onboarding import (
    _apply_license_entitlements,
    _ensure_company_master,
    _find_active_license_for_company_name,
    _find_customer_for_license,
    _norm,
    pwd_context,
    router,
)


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


async def _customer_user_count(customer_id: str) -> int:
    db = _raw_db()
    company_rows = await db.companies.find(
        {"commercial_customer_id": customer_id}, {"_id": 0, "id": 1}
    ).to_list(5000)
    company_ids = [str(row.get("id")) for row in company_rows if row.get("id")]
    clauses: list[dict[str, Any]] = [{"commercial_customer_id": customer_id}]
    if company_ids:
        clauses.append({"company_id": {"$in": company_ids}})
    return int(await db.users.count_documents({"$or": clauses}))


async def _active_license(customer_id: str) -> Dict[str, Any]:
    db = _raw_db()
    docs = await db.commercial_licenses.find(
        {"customer_id": customer_id, "status": "active"}, {"_id": 0}
    ).sort("issued_at", -1).limit(10).to_list(10)
    license_doc = next((doc for doc in docs if not _expiry_reason(doc)), None)
    if not license_doc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The commercial license is inactive or expired.",
        )
    return license_doc


async def _require_user_seat(customer_id: str, requested: int = 1) -> Dict[str, Any]:
    license_doc = await _active_license(customer_id)
    max_users = max(1, int(license_doc.get("max_users") or 1))
    current = await _customer_user_count(customer_id)
    remaining = max(0, max_users - current)
    if current + requested > max_users:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"User limit reached for this license. Allowed: {max_users}; "
                f"currently used: {current}; remaining: {remaining}."
            ),
        )
    return license_doc


async def create_customer_admin_fixed(payload: Dict[str, Any]):
    license_key = str(payload.get("license_key") or "").strip().upper()
    company_name = str(payload.get("company_name") or "").strip()
    if not license_key or not company_name:
        raise HTTPException(status_code=400, detail="Company name and license number are required.")

    customer, license_doc = await _find_customer_for_license(license_key, company_name)
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "").strip()
    if not customer_id or customer_id != str(license_doc.get("customer_id") or ""):
        raise HTTPException(status_code=403, detail="The license/customer relationship is invalid.")

    company = await _ensure_company_master(customer, license_doc)
    company_id = str(company.get("id") or "").strip()
    if not company_id:
        raise HTTPException(status_code=500, detail="Licensed company could not be initialized.")

    db = _raw_db()
    # License issuance/onboarding may already have created the administrator
    # identity as a credential-pending placeholder. In that case the first
    # customer setup must COMPLETE that same account rather than being rejected
    # as a duplicate administrator.
    existing_admin = await db.users.find_one(
        {"company_id": company_id, "role": "admin", "commercial_customer_id": customer_id},
        {"_id": 0},
    )

    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")

    if existing_admin:
        existing_admin_email = str(existing_admin.get("email") or "").strip().lower()
        legacy_license_placeholder = (
            str(existing_admin.get("approved_by") or "").strip().lower() == "commercial-license"
            and existing_admin_email == str(customer.get("email") or "").strip().lower()
            and existing_admin.get("admin_credentials_pending") is not False
        )
        pending_setup = bool(
            existing_admin.get("admin_credentials_pending")
            or not existing_admin.get("password")
            or existing_admin.get("status") == "pending_admin_setup"
            or legacy_license_placeholder
        )

        if not pending_setup:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The company administrator has already been created. Please sign in with the existing administrator account.",
            )

        existing_admin_id = str(existing_admin.get("id") or "").strip()
        if not existing_admin_id:
            raise HTTPException(status_code=500, detail="The pending administrator record is missing its user ID.")

        # The email on the placeholder is intentionally reusable because this
        # request is completing the license-created administrator identity.
        if email != existing_admin_email:
            conflicting_email = await db.users.find_one(
                {"email": email, "id": {"$ne": existing_admin_id}, "status": {"$ne": "deleted"}},
                {"_id": 1},
            )
            if conflicting_email:
                raise HTTPException(status_code=409, detail="An account already exists for this email address.")

        now = _now().isoformat()
        from backend.commercial_licensee_admin import get_all_admin_permissions
        permissions = get_all_admin_permissions(license_doc)
        updates = {
            "email": email,
            "full_name": full_name,
            "password": pwd_context.hash(password),
            "permissions": permissions,
            "departments": list(existing_admin.get("departments") or []),
            "phone": customer.get("phone"),
            "is_active": True,
            "status": "active",
            "admin_credentials_pending": False,
            "approved_by": "commercial-license",
            "approved_at": now,
            "license_id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "licensed_modules": list(license_doc.get("modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
        }
        await db.users.update_one({"id": existing_admin_id}, {"$set": updates})
        await db.commercial_license_customers.update_one(
            {"id": customer_id},
            {"$set": {"email": email, "admin_name": full_name, "contact_name": full_name}},
        )
        user_doc = await db.users.find_one(
            {"id": existing_admin_id},
            {"_id": 0, "password": 0},
        )
        user_id = str(user_doc.get("id") or "")
        return {
            "access_token": create_access_token({"sub": user_id}),
            "token_type": "bearer",
            "user": user_doc,
            "company": company,
            "license": _public_license(license_doc),
        }

    # No administrator exists yet: this is the normal first-time setup and
    # consumes one customer-wide license seat.
    await _require_user_seat(customer_id, 1)

    existing_email = await db.users.find_one(
        {"email": email, "status": {"$ne": "deleted"}},
        {"_id": 0, "company_id": 1, "commercial_customer_id": 1},
    )
    if existing_email:
        existing_customer = str(existing_email.get("commercial_customer_id") or "")
        if existing_customer == customer_id:
            detail = "An account already exists for this email address in this licensed customer account."
        else:
            detail = "An account already exists for this email address. Use a different email for the licensed administrator."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)

    now = _now().isoformat()
    user_id = __import__("uuid").uuid4().hex
    from backend.commercial_licensee_admin import get_all_admin_permissions
    permissions = get_all_admin_permissions(license_doc)
    user_doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": "admin",
        "password": pwd_context.hash(password),
        "permissions": permissions,
        "departments": [],
        "phone": customer.get("phone"),
        "is_active": True,
        "status": "active",
        "admin_credentials_pending": False,
        "approved_by": "commercial-license",
        "approved_at": now,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name") or company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    try:
        await db.users.insert_one(user_doc)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to create the administrator account: {exc}") from exc

    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {
        "access_token": create_access_token({"sub": user_id}),
        "token_type": "bearer",
        "user": safe_user,
        "company": company,
        "license": _public_license(license_doc),
    }


async def verify_company_fixed(payload: Dict[str, Any]):
    customer, license_doc = await _find_active_license_for_company_name(payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "")
    active_users = await _customer_user_count(customer_id)
    max_users = max(1, int(license_doc.get("max_users") or 1))
    return {
        "valid": True,
        "company": customer,
        "license": {
            "id": license_doc.get("id"),
            "status": license_doc.get("status"),
            "expires_at": license_doc.get("expires_at"),
            "max_users": max_users,
            "active_users": active_users,
            "remaining_users": max(0, max_users - active_users),
            "modules": list(license_doc.get("modules") or []),
        },
        "company_record": company,
    }


async def create_public_licensed_user_fixed(payload: Dict[str, Any]):
    customer, license_doc = await _find_active_license_for_company_name(payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "")
    await _require_user_seat(customer_id, 1)

    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    db = _raw_db()
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    requested_role = str(payload.get("role") or "not_known").strip().lower()
    role = requested_role if requested_role in {"admin", "manager", "staff"} else "staff"
    role_label = {"admin": "Admin", "manager": "Manager", "staff": "Staff", "not_known": "Not Know"}.get(requested_role, "Not Know")
    now = _now().isoformat()
    user_id = __import__("uuid").uuid4().hex
    permissions = _apply_license_entitlements(role, list(license_doc.get("modules") or []), license_doc.get("selected_features") or {})
    user_doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": role,
        "requested_role": requested_role,
        "role_label": role_label,
        "password": pwd_context.hash(password),
        "permissions": permissions,
        "departments": [],
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": "commercial-self-registration",
        "approved_at": now,
        "created_at": now,
        "company_id": company.get("id"),
        "company_name": company.get("name"),
        "commercial_customer_id": customer_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
    }
    try:
        await db.users.insert_one(user_doc)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to create the user account: {exc}") from exc
    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": safe_user, "company": company}


async def create_staff_fixed(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only the company administrator can create staff accounts.")
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    db = _raw_db()
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=403, detail="Your account is not linked to a valid company.")
    company_name = str(payload.get("company_name") or "").strip()
    if company_name and _norm(company_name) != _norm(company.get("name")):
        raise HTTPException(status_code=403, detail="Company name does not match your company.")

    customer_id = str(company.get("commercial_customer_id") or getattr(current_user, "commercial_customer_id", "") or "").strip()
    if not customer_id:
        raise HTTPException(status_code=403, detail="Your account is not linked to a commercial customer.")
    license_doc = await _active_license(customer_id)

    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    full_name = str(payload.get("full_name") or "").strip()
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")
    await _require_user_seat(customer_id, 1)

    role = str(payload.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now().isoformat()
    user_doc = {
        "id": __import__("uuid").uuid4().hex,
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": _apply_license_entitlements(role, list(license_doc.get("modules") or []), license_doc.get("selected_features") or {}),
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name"),
        "commercial_customer_id": customer_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
    }
    try:
        await db.users.insert_one(user_doc)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to create the staff account: {exc}") from exc
    return {k: v for k, v in user_doc.items() if k != "password"}


def _replace_route(path_suffix: str, endpoint) -> None:
    full_path = f"/commercial-onboarding/{path_suffix.lstrip('/')}"
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == full_path and "POST" in (route.methods or set()):
            route.endpoint = endpoint
            route.dependant = get_dependant(path=route.path_format, call=endpoint)
            return


def install() -> None:
    _replace_route("create-admin", create_customer_admin_fixed)
    _replace_route("verify-company", verify_company_fixed)
    _replace_route("create-user", create_public_licensed_user_fixed)
    _replace_route("create-staff", create_staff_fixed)


install()
