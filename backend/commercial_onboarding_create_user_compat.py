"""Reliable public creation endpoint for licensed customer users.

The public registration flow has no JWT, so it must use the raw database and the
commercial customer's active license as its authority. This handler also turns
unexpected persistence/validation failures into useful API errors instead of a
bare 500, while preserving the customer-wide seat limit and company isolation.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException, status
from fastapi.dependencies.utils import get_dependant
from fastapi.routing import APIRoute

from backend import dependencies as _dependencies
from backend.dependencies import create_access_token
from backend.models import User
from backend.commercial_onboarding import (
    _apply_license_entitlements,
    _ensure_company_master,
    _find_active_license_for_company_name,
    _norm,
    pwd_context,
    router,
)
from backend.licensing_api import _expiry_reason, _now
from backend.identity_hierarchy import ensure_licensee_uid, ensure_user_uid


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


async def _customer_user_count(customer_id: str) -> int:
    db = _raw_db()
    companies = await db.companies.find(
        {"commercial_customer_id": customer_id}, {"_id": 0, "id": 1}
    ).to_list(5000)
    company_ids = [str(item.get("id")) for item in companies if item.get("id")]
    clauses: list[dict[str, Any]] = [{"commercial_customer_id": customer_id}]
    if company_ids:
        clauses.append({"company_id": {"$in": company_ids}})
    return int(await db.users.count_documents({"$or": clauses}))


async def _active_license(customer_id: str) -> Dict[str, Any]:
    db = _raw_db()
    docs = await db.commercial_licenses.find(
        {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
        {"_id": 0},
    ).sort("issued_at", -1).limit(10).to_list(10)
    for doc in docs:
        if not _expiry_reason(doc):
            return doc
    raise HTTPException(status_code=403, detail="This company does not have an active commercial license.")


async def create_public_licensed_user_hardened(payload: Dict[str, Any]):
    company_name = str(payload.get("company_name") or "").strip()
    customer, license_doc = await _find_active_license_for_company_name(company_name)
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "").strip()
    licensee_uid = str(customer.get("licensee_uid") or license_doc.get("licensee_uid") or "").strip()
    if not licensee_uid:
        licensee_uid = await ensure_licensee_uid(_raw_db(), customer_id, customer)
    if not customer_id or customer_id != str(license_doc.get("customer_id") or ""):
        raise HTTPException(status_code=403, detail="The license/customer relationship is invalid.")

    license_doc = await _active_license(customer_id)
    company = await _ensure_company_master(customer, license_doc)
    company_id = str(company.get("id") or "").strip()
    if not company_id:
        raise HTTPException(status_code=500, detail="The licensed company could not be initialized.")

    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name:
        raise HTTPException(status_code=400, detail="Full name is required.")
    if not email:
        raise HTTPException(status_code=400, detail="Email address is required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must contain at least 8 characters.")

    db = _raw_db()
    existing = await db.users.find_one(
        {
            "$or": [
                {"identity_org_uid": licensee_uid, "email_normalized": email},
                {"identity_org_uid": licensee_uid, "email": email},
                {"licensee_uid": licensee_uid, "email_normalized": email},
                {"licensee_uid": licensee_uid, "email": email},
                {"commercial_customer_id": customer_id, "email": email},
                {"commercial_customer_id": customer_id, "email_normalized": email},
            ],
            "status": {"$ne": "deleted"},
        },
        {"_id": 0, "id": 1, "company_id": 1, "commercial_customer_id": 1},
    )
    if existing:
        raise HTTPException(status_code=409, detail="An account already exists for this email address in this licensed customer account.")

    max_users = max(1, int(license_doc.get("max_users") or 1))
    current_users = await _customer_user_count(customer_id)
    if current_users >= max_users:
        raise HTTPException(
            status_code=403,
            detail=f"User limit reached for this license. Allowed: {max_users}; currently used: {current_users}; remaining: 0.",
        )

    requested_role = str(payload.get("role") or "staff").strip().lower()
    role = requested_role if requested_role in {"admin", "manager", "staff"} else "staff"
    role_label = {"admin": "Admin", "manager": "Manager", "staff": "Staff"}.get(role, "Staff")
    now = _now().isoformat()
    user_id = __import__("uuid").uuid4().hex
    user_uid = await ensure_user_uid(
        db,
        {"id": user_id, "email": email},
        organization_uid=licensee_uid,
        identity_type="licensee_admin" if role == "admin" else "licensee_user",
    )
    password_hash = pwd_context.hash(password)
    permissions = _apply_license_entitlements(role, list(license_doc.get("modules") or []), license_doc.get("selected_features") or {})

    user_doc = {
        "id": user_id,
        "user_uid": user_uid,
        "email": email,
        "email_normalized": email,
        "identity_org_uid": licensee_uid,
        "licensee_uid": licensee_uid,
        "identity_type": "licensee_admin" if role == "admin" else "licensee_user",
        "full_name": full_name,
        "role": role,
        "requested_role": requested_role,
        "role_label": role_label,
        "password": password_hash,
        "permissions": permissions,
        "departments": [],
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": "commercial-self-registration",
        "approved_at": now,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name") or company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "license_uid": license_doc.get("license_uid"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }

    # Validate against the application model before touching Mongo. This makes
    # schema/field problems return a controlled 400 instead of an opaque 500.
    try:
        validated = User.model_validate(user_doc)
        user_doc = validated.model_dump(mode="python")
        user_doc["password"] = password_hash
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"The account details are invalid: {exc}") from exc

    try:
        await db.users.insert_one(user_doc)
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if "duplicate" in lowered or "e11000" in lowered or "unique" in lowered:
            raise HTTPException(status_code=409, detail="An account already exists for this email address.") from exc
        raise HTTPException(status_code=500, detail=f"Unable to create the user account: {message}") from exc

    safe_user = {key: value for key, value in user_doc.items() if key != "password"}
    try:
        token = create_access_token({"sub": user_id})
    except Exception as exc:
        # The account was created, so do not roll it back. Return a precise
        # server error instead of pretending the account was not created.
        raise HTTPException(status_code=500, detail=f"Account was created but the login token could not be issued: {exc}") from exc

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": safe_user,
        "company": company,
        "license": {
            "id": license_doc.get("id"),
            "status": license_doc.get("status"),
            "expires_at": license_doc.get("expires_at"),
            "max_users": max_users,
            "active_users": current_users + 1,
            "remaining_users": max(0, max_users - current_users - 1),
            "modules": list(license_doc.get("modules") or []),
        },
    }


def install() -> None:
    full_path = "/commercial-onboarding/create-user"
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == full_path and "POST" in (route.methods or set()):
            route.endpoint = create_public_licensed_user_hardened
            route.dependant = get_dependant(path=route.path_format, call=create_public_licensed_user_hardened)
            return


install()
