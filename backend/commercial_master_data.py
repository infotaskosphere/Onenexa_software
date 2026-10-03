"""Commercial tenant Master Data — company-scoped user administration.

User administration is intentionally kept outside People Matrix licensing. A
commercial customer may buy Taskosphere, Finix, Compliance, Records or any
other module individually, but the licensed company's administrator must
always be able to maintain the company's user directory from Admin → Master
Data. People Matrix consumes the same users collection and HR fields when it
is licensed; it does not own the user accounts.
"""
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.dependencies import db, get_current_user, create_audit_log
from backend.models import User
from backend.commercial_onboarding import _active_company_license, pwd_context
from backend.commercial_onboarding_extensions import _apply_feature_entitlements
from backend.platform_owner import is_platform_owner, platform_owner_emails

router = APIRouter(prefix="/commercial-master-data", tags=["commercial-master-data"])

USER_FIELDS = {
    "full_name", "email", "role", "departments", "phone", "birthday",
    "telegram_id", "punch_in_time", "grace_time", "punch_out_time",
    "profile_picture", "joining_date", "training_period_end", "payroll_date",
    "monthly_salary", "employee_code", "designation", "department_id",
    "reporting_manager_id", "employment_type", "confirmation_date", "grade",
    "cost_centre", "pan_number", "aadhaar_number", "uan_number", "pf_number",
    "esic_number", "bank_account_number", "bank_name", "ifsc_code",
}


def _now() -> str:
    return datetime.utcnow().isoformat() + "+00:00"


async def _company_context(current_user: User):
    # The platform owner is the software seller and operational administrator.
    # Provide an operational company and license context for creating tasks and staff.
    if is_platform_owner(current_user):
        company_id = str(getattr(current_user, "company_id", "") or "").strip()
        company = None
        if company_id:
            company = await db.companies.find_one({"id": company_id}, {"_id": 0})
        if not company:
            company = await db.companies.find_one({"source": {"$nin": ["commercial-license", "license"]}}, {"_id": 0})
        license_doc = {
            "id": "platform-owner-license",
            "license_key": "PLATFORM-OWNER",
            "customer_id": "platform-owner",
            "company_id": str(company.get("id") or "comp-platform-owner") if company else "comp-platform-owner",
            "status": "active",
            "max_users": 9999,
            "modules": ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE", "RECORDS", "PROPOSALS"],
            "selected_features": {},
        }
        if not company:
            company = {"id": "comp-platform-owner", "name": "Platform Owner Company"}
        return license_doc, company
    if getattr(current_user, "role", None) != "admin" or not getattr(current_user, "company_id", None):
        raise HTTPException(status_code=403, detail="Company Master user administration is available only to a licensed company administrator.")
    license_doc = await _active_company_license(current_user)
    company_id = str(current_user.company_id)
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=404, detail="Licensed company profile not found.")
    return license_doc, company


async def _platform_company_context(current_user: User, identifier: str):
    """Resolve a legal company and active license for platform-owner administration only."""
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Platform-level customer user administration is restricted to the software platform owner.")
    identifier = str(identifier or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="A customer or company identifier is required.")

    # 1. Try finding by company id or commercial_customer_id or license_id
    company = await db.companies.find_one(
        {"$or": [
            {"id": identifier},
            {"commercial_customer_id": identifier},
            {"license_id": identifier},
        ]},
        {"_id": 0},
    )

    customer_doc = None
    if not company:
        customer_doc = await db.commercial_license_customers.find_one(
            {"$or": [{"id": identifier}, {"email": identifier}]},
            {"_id": 0},
        )
        if customer_doc:
            company = await db.companies.find_one(
                {"commercial_customer_id": str(customer_doc["id"])},
                {"_id": 0},
            )

    if not company:
        lic = await db.commercial_licenses.find_one(
            {"$or": [{"id": identifier}, {"license_key": identifier}]},
            {"_id": 0},
        )
        if lic:
            target_cust_id = str(lic.get("customer_id") or "")
            company = await db.companies.find_one(
                {"$or": [{"commercial_customer_id": target_cust_id}, {"license_id": str(lic.get("id") or "")}]},
                {"_id": 0},
            )
            if not customer_doc and target_cust_id:
                customer_doc = await db.commercial_license_customers.find_one({"id": target_cust_id}, {"_id": 0})

    if not company and not customer_doc:
        raise HTTPException(status_code=404, detail="Customer company not found.")

    if not company and customer_doc:
        comp_id = f"comp-{customer_doc['id']}"
        company = {
            "id": comp_id,
            "commercial_customer_id": str(customer_doc["id"]),
            "name": customer_doc.get("company_name") or "Licensee Company",
            "company_name": customer_doc.get("company_name") or "Licensee Company",
            "email": customer_doc.get("email"),
            "source": "commercial-license",
            "status": "active",
        }
        await db.companies.insert_one(dict(company))

    customer_id = str(company.get("commercial_customer_id") or (customer_doc.get("id") if customer_doc else "") or company.get("id"))
    license_doc = await db.commercial_licenses.find_one(
        {"$or": [{"customer_id": customer_id}, {"id": str(company.get("license_id") or "")}], "status": "active"},
        {"_id": 0},
        sort=[("issued_at", -1)],
    )
    if not license_doc:
        license_doc = await db.commercial_licenses.find_one(
            {"$or": [{"customer_id": customer_id}, {"id": str(company.get("license_id") or "")}]},
            {"_id": 0},
            sort=[("issued_at", -1)],
        )
    if not license_doc:
        license_doc = {
            "id": f"license-{customer_id}",
            "license_key": "COMMERCIAL-STANDARD",
            "customer_id": customer_id,
            "company_id": str(company["id"]),
            "status": "active",
            "max_users": 10,
            "modules": ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE", "RECORDS", "PROPOSALS"],
            "selected_features": {},
        }
    return license_doc, company


def _clean_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(doc or {})
    out.pop("_id", None)
    for key in ("password", "password_hash", "password_salt"):
        out.pop(key, None)
    return out


def _date_value(value):
    if value in (None, ""):
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _license_permissions(
    role: str,
    license_doc: Dict[str, Any],
    admin_user: Optional[User] = None,
    existing_permissions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Resolve a company user's effective access from the licensee admin.

    The license defines the commercial ceiling; the licensee administrator's
    current permissions define what that administrator has enabled for the
    tenant. New staff/managers inherit that enabled access, while existing
    explicit user grants remain editable but are capped to the administrator.
    """
    from backend.commercial_licensee_admin import (
        get_all_admin_permissions,
        get_tenant_user_permissions,
    )
    if str(role or "").strip().lower() == "admin":
        return get_all_admin_permissions(license_doc)
    return get_tenant_user_permissions(
        admin_user,
        license_doc,
        role,
        existing_permissions,
    )


async def _license_user_query(license_doc: Dict[str, Any], company: Dict[str, Any]) -> Dict[str, Any]:
    """Build the shared user-seat scope for one commercial license.

    User seats belong to the commercial license/customer, not to one legal
    company. New users carry ``commercial_customer_id`` directly. Older
    commercial users may not have that field, so their company is included as
    a compatibility fallback after resolving every company belonging to the
    same customer. This keeps legacy users counted without allowing users from
    another license to consume seats.
    """
    customer_id = str(
        license_doc.get("customer_id")
        or company.get("commercial_customer_id")
        or ""
    ).strip()
    if not customer_id:
        raise HTTPException(
            status_code=403,
            detail="The commercial license is not linked to a customer.",
        )

    company_ids = await db.companies.distinct(
        "id",
        {"commercial_customer_id": customer_id},
    )
    current_company_id = str(company.get("id") or "").strip()
    if current_company_id and current_company_id not in company_ids:
        company_ids.append(current_company_id)

    # Prefer the explicit customer field. The company-id branch exists only
    # for legacy users created before commercial_customer_id was persisted.
    query: Dict[str, Any] = {
        "$or": [{"commercial_customer_id": customer_id}],
    }
    if company_ids:
        query["$or"].append({"company_id": {"$in": company_ids}})
    return query


@router.get("/users")
async def list_company_users(current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raw_lic_comps = await db.companies.find(
            {"$or": [
                {"source": {"$in": ["commercial-license", "commercial", "license"]}},
                {"commercial_customer_id": {"$nin": [None, "", "platform-owner"]}},
                {"license_id": {"$nin": [None, "", "platform-owner-license"]}},
            ]},
            {"_id": 0, "id": 1},
        ).to_list(5000)
        licensee_comp_ids = {str(c["id"]) for c in raw_lic_comps if c.get("id")}

        platform_query: Dict[str, Any] = {
            "role": {"$ne": "superadmin"},
            "is_internal_commercial_admin": {"$ne": True},
            "commercial_customer_id": {"$in": [None, "", "platform-owner"]},
            "license_id": {"$in": [None, "", "platform-owner-license"]},
        }
        if licensee_comp_ids:
            platform_query["company_id"] = {"$nin": list(licensee_comp_ids)}

        users = await db.users.find(
            platform_query,
            {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
        ).sort("full_name", 1).to_list(2000)
        return {
            "company": company,
            "license": license_doc,
            "users": [_clean_user(u) for u in users],
            "platform_owner": True,
        }
    owner_emails = sorted(platform_owner_emails())
    # User seats belong to the commercial license/customer, not only the
    # currently selected legal company. _license_user_query also includes
    # legacy users through every company attached to this customer.
    tenant_user_query = await _license_user_query(license_doc, company)
    tenant_user_query.update({
        "status": {"$ne": "deleted"},
        "role": {"$ne": "superadmin"},
        "is_internal_commercial_admin": {"$ne": True},
        "email": {"$nin": owner_emails},
    })
    users = await db.users.find(
        tenant_user_query,
        {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
    ).sort("full_name", 1).to_list(2000)
    return {
        "company": company,
        "license": {
            "id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "max_users": int(license_doc.get("max_users", 1)),
            "modules": list(license_doc.get("modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
        },
        "users": [_clean_user(u) for u in users],
    }


@router.get("/platform-users")
async def list_platform_company_users(
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    license_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id or license_id
    if not target_id:
        raise HTTPException(status_code=400, detail="company_id or customer_id is required.")
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    lic_id = str(license_doc.get("id") or "")

    user_query: Dict[str, Any] = {
        "$and": [
            {"status": {"$ne": "deleted"}},
            {"role": {"$ne": "superadmin"}},
            {"is_internal_commercial_admin": {"$ne": True}},
            {"email": {"$nin": sorted(platform_owner_emails())}},
            {"$or": [
                {"company_id": comp_id},
                *([{"commercial_customer_id": cust_id}] if cust_id else []),
                *([{"license_id": lic_id}] if lic_id else []),
            ]}
        ]
    }
    users = await db.users.find(
        user_query,
        {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
    ).sort("full_name", 1).to_list(2000)
    return {
        "company": company,
        "license": {
            "id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "max_users": int(license_doc.get("max_users", 1)),
            "modules": list(license_doc.get("modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
        },
        "users": [_clean_user(u) for u in users],
        "platform_owner": True,
    }


@router.post("/platform-users", status_code=201)
async def create_platform_company_user(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    target_id = str(payload.get("company_id") or payload.get("customer_id") or payload.get("license_id") or "").strip()
    license_doc, company = await _platform_company_context(current_user, target_id)
    email = str(payload.get("email") or "").strip().lower()
    full_name = str(payload.get("full_name") or "").strip()
    password = str(payload.get("password") or "")
    if not full_name or not email:
        raise HTTPException(status_code=400, detail="Full name and email are required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    max_users = max(1, int(license_doc.get("max_users", 1)))
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    user_count_query: Dict[str, Any] = {
        "status": {"$ne": "deleted"},
        "$or": [
            {"company_id": comp_id},
            *([{"commercial_customer_id": cust_id}] if cust_id else []),
        ]
    }
    user_count = await db.users.count_documents(user_count_query)
    if user_count >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager", "admin"}:
        role = "staff"
    now = _now()
    user_id = str(uuid.uuid4())
    # Resolve the creator as the tenant administrator. The creator's effective
    # permissions are the source for inherited module/page access; the active
    # license remains the hard commercial ceiling.
    creator_admin = current_user if str(getattr(current_user, "role", "")).strip().lower() == "admin" else None
    doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": _license_permissions(role, license_doc, creator_admin),
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
        "company_id": comp_id,
        "company_name": company.get("name") or company.get("company_name"),
        "commercial_customer_id": cust_id or comp_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    hr_fields = {
        "designation", "employee_code", "department_id", "birthday", "joining_date",
        "training_period_end", "payroll_date", "confirmation_date", "employment_type",
        "grade", "cost_centre", "pan_number", "aadhaar_number", "uan_number",
        "pf_number", "esic_number", "bank_account_number", "bank_name", "ifsc_code",
        "monthly_salary", "telegram_id", "punch_in_time", "grace_time", "punch_out_time",
        "profile_picture", "reporting_manager_id",
    }
    for field in hr_fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        doc[field] = _date_value(value) if field in {"birthday", "joining_date", "training_period_end", "payroll_date", "confirmation_date"} else (value if value != "" else None)

    await db.users.insert_one(doc)
    safe = _clean_user(doc)
    await create_audit_log(current_user, "CREATE_PLATFORM_COMPANY_USER", "company_master_users", user_id, new_data=safe)
    return safe


@router.put("/platform-users/{user_id}")
async def update_platform_company_user(
    user_id: str,
    payload: Dict[str, Any],
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id or str(payload.get("company_id") or payload.get("customer_id") or "")
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")

    existing = await db.users.find_one(
        {"id": user_id, "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}]},
        {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")

    updates: Dict[str, Any] = {}
    for field in USER_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"}:
            value = _date_value(value)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        updates[field] = value if value != "" else None

    if "password" in payload and str(payload.get("password") or "").strip():
        password = str(payload["password"]).strip()
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        updates["password"] = pwd_context.hash(password)

    role = str(updates.get("role") or existing.get("role") or "staff").lower()
    if role not in {"staff", "manager", "admin"}:
        role = "staff"
    updates["role"] = role
    # Re-cap edited users to the current tenant administrator. This prevents a
    # stale permission document from retaining access after the admin changes
    # the tenant's allowed modules/pages.
    admin_user = current_user if str(getattr(current_user, "role", "")).strip().lower() == "admin" else None
    updates["permissions"] = _license_permissions(
        role,
        license_doc,
        admin_user,
        existing.get("permissions") or {},
    )
    updates["licensed_modules"] = list(license_doc.get("modules") or [])
    updates["selected_features"] = license_doc.get("selected_features") or {}

    if updates:
        await db.users.update_one({"id": user_id}, {"$set": updates})
    safe_updates = {k: v for k, v in updates.items() if k != "password"}
    await create_audit_log(current_user, "UPDATE_PLATFORM_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=safe_updates)
    updated = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    return _clean_user(updated or {})


async def _platform_change_user_status(user_id: str, identifier: str, status: str, current_user: User):
    license_doc, company = await _platform_company_context(current_user, identifier)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")

    existing = await db.users.find_one(
        {"id": user_id, "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}]},
        {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")
    if status == "active":
        max_users = max(1, int(license_doc.get("max_users", 1)))
        active_count_query: Dict[str, Any] = {
            "status": "active",
            "$or": [
                {"company_id": comp_id},
                *([{"commercial_customer_id": cust_id}] if cust_id else []),
            ]
        }
        active_count = await db.users.count_documents(active_count_query)
        if active_count >= max_users and existing.get("status") != "active":
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
        update = {"status": "active", "is_active": True, "approved_by": current_user.id, "approved_at": _now()}
        action = "ACTIVATE_PLATFORM_COMPANY_USER"
    else:
        update = {"status": "inactive", "is_active": False}
        action = "DEACTIVATE_PLATFORM_COMPANY_USER"
    await db.users.update_one({"id": user_id}, {"$set": update})
    await create_audit_log(current_user, action, "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": f"User {status} successfully", "user_id": user_id, "status": status}


@router.get("/platform-users/deleted")
async def list_platform_company_deleted_users(company_id: Optional[str] = Query(None), customer_id: Optional[str] = Query(None), license_id: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    target_id = company_id or customer_id or license_id
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    lic_id = str(license_doc.get("id") or "")
    query = {"status": "deleted", "role": {"$ne": "superadmin"}, "is_internal_commercial_admin": {"$ne": True}, "email": {"$nin": sorted(platform_owner_emails())}, "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}, {"license_id": lic_id}]}
    users = await db.users.find(query, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0}).sort("deleted_at", -1).to_list(2000)
    return {"users": [_clean_user(u) for u in users], "count": len(users)}

@router.post("/platform-users/{user_id}/restore")
async def restore_platform_company_user(user_id: str, company_id: Optional[str] = Query(None), customer_id: Optional[str] = Query(None), license_id: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    target_id = company_id or customer_id or license_id
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    existing = await db.users.find_one({"id": user_id, "status": "deleted", "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}, {"license_id": str(license_doc.get("id") or "")}]}, {"_id": 0})
    if not existing: raise HTTPException(status_code=404, detail="Deleted company user not found.")
    max_users = max(1, int(license_doc.get("max_users", 1)))
    active_count = await db.users.count_documents({"status": "active", "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}]})
    if active_count >= max_users: raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
    now = _now()
    update = {"status": "active", "is_active": True, "restored_at": now, "restored_by": current_user.id, "approved_by": current_user.id, "approved_at": now}
    await db.users.update_one({"id": user_id}, {"$set": update})
    await create_audit_log(current_user, "RESTORE_PLATFORM_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": "User restored successfully", "user_id": user_id, "status": "active"}
@router.post("/platform-users/{user_id}/activate")
async def activate_platform_company_user(
    user_id: str,
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id
    return await _platform_change_user_status(user_id, target_id, "active", current_user)


@router.post("/platform-users/{user_id}/deactivate")
async def deactivate_platform_company_user(
    user_id: str,
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id
    return await _platform_change_user_status(user_id, target_id, "inactive", current_user)


@router.delete("/platform-users/{user_id}")
async def delete_platform_company_user(
    user_id: str,
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")

    existing = await db.users.find_one(
        {"id": user_id, "$or": [{"company_id": comp_id}, {"commercial_customer_id": cust_id}]},
        {"_id": 0},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")

    now = _now()

    # Hard-delete the MongoDB user. Deleted users are no longer retained in a
    # soft-deleted state and therefore cannot consume seats or remain in the
    # Deleted Users registry. Platform/internal accounts are protected above.
    hard_delete_audit = {
        "deleted_at": now,
        "deleted_by": current_user.id,
        "hard_deleted": True,
    }
    await create_audit_log(
        current_user,
        "DELETE_PLATFORM_COMPANY_USER",
        "company_master_users",
        user_id,
        old_data=_clean_user(existing),
        new_data=hard_delete_audit,
    )
    deleted_result = await db.users.delete_one({"id": user_id})
    if deleted_result.deleted_count != 1:
        raise HTTPException(status_code=409, detail="User could not be deleted from MongoDB.")

    return {"message": "User permanently deleted", "user_id": user_id, "status": "deleted"}


@router.post("/users", status_code=201)
async def create_company_user(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    email = str(payload.get("email") or "").strip().lower()
    full_name = str(payload.get("full_name") or "").strip()
    password = str(payload.get("password") or "")
    if not full_name or not email:
        raise HTTPException(status_code=400, detail="Full name and email are required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    company_id = str(company["id"])
    if not is_platform_owner(current_user):
        max_users = max(1, int(license_doc.get("max_users", 1)))
        user_count_query = await _license_user_query(license_doc, company)
        user_count_query["status"] = "active"
        user_count = await db.users.count_documents(user_count_query)
        if user_count >= max_users:
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager"}:
        role = "staff"

    now = _now()
    user_id = str(uuid.uuid4())
    custom_perms = payload.get("permissions")
    if custom_perms and isinstance(custom_perms, dict):
        from backend.permission_governance import _enforce_module_hierarchy, _cap_permissions_to_license
        user_perms = _enforce_module_hierarchy(custom_perms)
        user_perms = await _cap_permissions_to_license(user_perms, current_user)
    else:
        user_perms = _license_permissions(role, license_doc, current_user)

    doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": user_perms,
        "permissions_inherited_from_licensee_admin": False if custom_perms else True,
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "punch_in_time": str(payload.get("punch_in_time") or "10:30"),
        "grace_time": str(payload.get("grace_time") or "00:10"),
        "punch_out_time": str(payload.get("punch_out_time") or "19:00"),
        "profile_picture": payload.get("profile_picture"),
        "is_active": False,
        "status": "pending_approval",
        "approved_by": None,
        "approved_at": None,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name") or current_user.company_name,
        "commercial_customer_id": company.get("commercial_customer_id") or license_doc.get("customer_id"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    hr_fields = {
        "joining_date", "training_period_end", "payroll_date", "confirmation_date",
        "employee_code", "designation", "department_id", "reporting_manager_id",
        "employment_type", "grade", "cost_centre", "pan_number", "aadhaar_number",
        "uan_number", "pf_number", "esic_number", "bank_account_number",
        "bank_name", "ifsc_code", "monthly_salary",
    }
    for field in hr_fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        doc[field] = _date_value(value) if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"} else (value if value != "" else None)

    await db.users.insert_one(doc)
    safe = _clean_user(doc)
    await create_audit_log(current_user, "CREATE_COMPANY_USER", "company_master_users", user_id, new_data=safe)
    return safe


@router.put("/users/{user_id}")
async def update_company_user(user_id: str, payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant and cannot edit customer users here.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")

    updates: Dict[str, Any] = {}
    for field in USER_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"}:
            value = _date_value(value)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        updates[field] = value if value != "" else None

    if "password" in payload and str(payload.get("password") or "").strip():
        password = str(payload["password"]).strip()
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        updates["password"] = pwd_context.hash(password)

    role = str(updates.get("role") or existing.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    updates["role"] = role
    if "permissions" in payload and isinstance(payload["permissions"], dict):
        updates["permissions"] = payload["permissions"]
    elif existing.get("permissions"):
        updates["permissions"] = existing.get("permissions")
    else:
        updates["permissions"] = _license_permissions(role, license_doc)
    updates["licensed_modules"] = list(license_doc.get("modules") or [])
    updates["selected_features"] = license_doc.get("selected_features") or {}

    if updates:
        await db.users.update_one({"id": user_id, "company_id": company_id}, {"$set": updates})
    safe_updates = {k: v for k, v in updates.items() if k != "password"}
    await create_audit_log(current_user, "UPDATE_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=safe_updates)
    updated = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    return _clean_user(updated or {})


async def _change_user_status(user_id: str, status: str, current_user: User):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="The company administrator cannot change their own status here.")
    if status == "active":
        max_users = max(1, int(license_doc.get("max_users", 1)))
        active_count_query = await _license_user_query(license_doc, company)
        active_count_query["status"] = "active"
        active_count = await db.users.count_documents(active_count_query)
        if active_count >= max_users:
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
        update = {"status": "active", "is_active": True, "approved_by": current_user.id, "approved_at": _now()}
        action = "APPROVE_COMPANY_USER"
    elif status == "rejected":
        update = {"status": "rejected", "is_active": False}
        action = "REJECT_COMPANY_USER"
    else:
        update = {"status": "inactive", "is_active": False}
        action = "DEACTIVATE_COMPANY_USER"
    await db.users.update_one({"id": user_id, "company_id": company_id}, {"$set": update})
    await create_audit_log(current_user, action, "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": f"User {status} successfully", "user_id": user_id, "status": status}


@router.post("/users/{user_id}/approve")
async def approve_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "active", current_user)


@router.post("/users/{user_id}/reject")
async def reject_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "rejected", current_user)


@router.post("/users/{user_id}/deactivate")
async def deactivate_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "inactive", current_user)


@router.delete("/users/{user_id}")
async def delete_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user): raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id, "status": {"$ne": "deleted"}}, {"_id": 0})
    if not existing: raise HTTPException(status_code=404, detail="Company user not found.")
    if user_id == current_user.id: raise HTTPException(status_code=400, detail="The company administrator cannot delete their own account here.")
    if str(existing.get("email") or "").strip().lower() in platform_owner_emails() or existing.get("is_internal_commercial_admin") is True:
        raise HTTPException(status_code=403, detail="Platform/internal accounts cannot be deleted from a customer tenant.")
    now = _now()

    # Hard-delete the MongoDB user instead of moving it to a soft-deleted
    # registry. Historical audit logs keep the event without retaining the
    # login/user document itself.
    hard_delete_audit = {
        "deleted_at": now,
        "deleted_by": current_user.id,
        "hard_deleted": True,
    }
    await create_audit_log(
        current_user,
        "DELETE_COMPANY_USER",
        "company_master_users",
        user_id,
        old_data=_clean_user(existing),
        new_data=hard_delete_audit,
    )
    deleted_result = await db.users.delete_one(
        {"id": user_id, "company_id": company_id}
    )
    if deleted_result.deleted_count != 1:
        raise HTTPException(status_code=409, detail="User could not be deleted from MongoDB.")

    return {"message": "User permanently deleted", "user_id": user_id, "status": "deleted"}

@router.get("/users/deleted")
async def list_deleted_company_users(current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user): raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant.")
    deleted_query = await _license_user_query(license_doc, company)
    deleted_query.update({
        "status": "deleted",
        "role": {"$ne": "superadmin"},
        "is_internal_commercial_admin": {"$ne": True},
        "email": {"$nin": sorted(platform_owner_emails())},
    })
    users = await db.users.find(
        deleted_query,
        {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
    ).sort("deleted_at", -1).to_list(2000)
    return {"users": [_clean_user(u) for u in users], "count": len(users)}

@router.post("/users/{user_id}/restore")
async def restore_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user): raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id, "status": "deleted"}, {"_id": 0})
    if not existing: raise HTTPException(status_code=404, detail="Deleted company user not found.")
    max_users = max(1, int(license_doc.get("max_users", 1)))
    q = await _license_user_query(license_doc, company); q["status"] = "active"
    if await db.users.count_documents(q) >= max_users: raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
    now = _now(); update = {"status": "active", "is_active": True, "approved_by": current_user.id, "approved_at": now, "restored_at": now, "restored_by": current_user.id}
    await db.users.update_one({"id": user_id, "company_id": company_id}, {"$set": update})
    await create_audit_log(current_user, "RESTORE_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": "User restored successfully", "user_id": user_id, "status": "active"}
from backend.permission_governance import router as _permission_governance_router
_permission_governance_router.include_router(router)
