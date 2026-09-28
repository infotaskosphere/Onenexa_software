"""Platform-owner legal company master-data bridge.

A commercial customer is the billing/license account. A legal company is the
operational tenant. One commercial customer may own multiple legal companies;
each employee/user remains attached to exactly one legal company.

This router is deliberately limited to the Platform Owner. It manages the
commercial-to-legal-company relationship without exposing customer
operational data such as clients, tasks, invoices or HR records.
"""
import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from backend.dependencies import db, get_current_user, create_audit_log
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.licensing_api import _expiry_reason

router = APIRouter(prefix="/commercial-master-data", tags=["commercial-company-master"])


async def _require_platform_owner(current_user: User) -> None:
    if not is_platform_owner(current_user):
        raise HTTPException(
            status_code=403,
            detail="Commercial company master administration is restricted to the platform owner.",
        )


async def _active_customer_license(customer_id: str):
    licenses = await db.commercial_licenses.find(
        {"customer_id": str(customer_id), "status": "active"},
        {"_id": 0},
    ).sort("issued_at", -1).limit(20).to_list(20)
    for license_doc in licenses:
        if not _expiry_reason(license_doc):
            return license_doc
    return None


def _company_public(company: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(company or {})
    out.pop("_id", None)
    return out


def _is_licensee_company(company: Dict[str, Any]) -> bool:
    """Return True when a company record belongs to a commercial licensee."""
    source = str(company.get("source") or "").strip().lower()
    customer_id = str(company.get("commercial_customer_id") or "").strip().lower()
    license_id = str(company.get("license_id") or "").strip().lower()
    return (
        source in {"commercial-license", "commercial", "license"}
        or bool(customer_id and customer_id != "platform-owner")
        or bool(license_id and license_id != "platform-owner-license")
    )


@router.get("/company-directory")
async def company_directory(current_user: User = Depends(get_current_user)):
    """Return commercial customers and their legal-company relationships.

    This is commercial metadata only. It intentionally does not return users,
    clients or any other customer operational collection.
    """
    await _require_platform_owner(current_user)

    customers = await db.commercial_license_customers.find(
        {}, {"_id": 0}
    ).sort("company_name", 1).to_list(5000)
    licenses = await db.commercial_licenses.find(
        {"status": "active"}, {"_id": 0}
    ).sort("issued_at", -1).to_list(5000)
    companies = await db.companies.find({}, {"_id": 0}).sort("name", 1).to_list(5000)

    license_by_customer = {}
    for license_doc in licenses:
        customer_id = str(license_doc.get("customer_id") or "")
        if not customer_id or customer_id in license_by_customer:
            continue
        if _expiry_reason(license_doc):
            continue
        license_by_customer[customer_id] = license_doc

    customer_ids = {str(c.get("id")) for c in customers if c.get("id")}
    grouped = {customer_id: [] for customer_id in customer_ids}
    unlinked = []

    for company in companies:
        customer_id = str(company.get("commercial_customer_id") or "").strip()
        # Legacy commercial records used the customer id as the company id.
        # Treat that record as belonging to the same customer until it is
        # explicitly migrated by the normal onboarding flow.
        if not customer_id and str(company.get("id") or "") in customer_ids:
            customer_id = str(company.get("id"))
        if customer_id in grouped:
            grouped[customer_id].append(_company_public(company))
        elif not _is_licensee_company(company):
            # Never surface a licensee company as an "unlinked" platform company.
            unlinked.append(_company_public(company))

    platform_companies = [
        _company_public(company)
        for company in companies
        if not _is_licensee_company(company)
    ]

    customer_rows = []
    for customer in customers:
        customer_id = str(customer.get("id") or "")
        license_doc = license_by_customer.get(customer_id)
        customer_rows.append({
            "id": customer_id,
            "company_name": customer.get("company_name"),
            "contact_name": customer.get("contact_name"),
            "email": customer.get("email"),
            "phone": customer.get("phone"),
            "gstin": customer.get("gstin"),
            "license": {
                "id": license_doc.get("id"),
                "license_key": license_doc.get("license_key"),
                "status": license_doc.get("status"),
                "expires_at": license_doc.get("expires_at"),
                "max_users": int(license_doc.get("max_users", 1)),
                "modules": list(license_doc.get("modules") or []),
                "selected_features": license_doc.get("selected_features") or {},
            } if license_doc else None,
            "legal_companies": grouped.get(customer_id, []),
        })

    return {
        "customers": customer_rows,
        # Keep the legacy response key, but it is now strictly platform-owned.
        # Licensee companies are available only inside their customer row.
        "companies": platform_companies,
        "unlinked_companies": unlinked,
        "platform_owner": True,
    }


@router.post("/company-directory", status_code=201)
async def create_legal_company(
    payload: Dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """Create a legal company under an existing licensed commercial customer."""
    await _require_platform_owner(current_user)

    customer_id = str(payload.get("commercial_customer_id") or "").strip()
    name = str(payload.get("name") or payload.get("company_name") or "").strip()
    if not customer_id:
        raise HTTPException(status_code=400, detail="A licensed commercial customer is required.")
    if not name:
        raise HTTPException(status_code=400, detail="Legal company name is required.")

    customer = await db.commercial_license_customers.find_one(
        {"id": customer_id}, {"_id": 0}
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Commercial customer was not found.")

    license_doc = await _active_customer_license(customer_id)
    if not license_doc:
        raise HTTPException(status_code=403, detail="This commercial customer does not have an active license.")

    duplicate = await db.companies.find_one(
        {
            "commercial_customer_id": customer_id,
            "name": {"$regex": f"^{name}$", "$options": "i"},
        },
        {"_id": 0, "id": 1},
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="A legal company with this name already exists for this commercial customer.")

    now = __import__("datetime").datetime.utcnow().isoformat() + "+00:00"
    company_id = str(uuid.uuid4())
    doc = {
        "id": company_id,
        "commercial_customer_id": customer_id,
        "commercial_customer_name": customer.get("company_name"),
        "name": name,
        "company_name": name,
        "email": str(payload.get("email") or "").strip(),
        "phone": str(payload.get("phone") or "").strip(),
        "website": str(payload.get("website") or "").strip(),
        "address": str(payload.get("address") or "").strip(),
        "city": str(payload.get("city") or "").strip(),
        "state": str(payload.get("state") or "").strip(),
        "pincode": str(payload.get("pincode") or "").strip(),
        "gstin": str(payload.get("gstin") or "").strip().upper(),
        "pan": str(payload.get("pan") or "").strip().upper(),
        "has_gst": payload.get("has_gst") is not False,
        "licensed_modules": list(license_doc.get("modules") or []),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "status": "active",
        "source": "platform-company-master",
        "created_by": str(current_user.id),
        "created_at": now,
        "updated_at": now,
    }

    await db.companies.insert_one(doc)
    safe = _company_public(doc)
    await create_audit_log(
        current_user,
        "CREATE_LEGAL_COMPANY",
        "company_master",
        company_id,
        new_data=safe,
    )
    return safe


@router.post("/company-directory/{company_id}/link")
async def link_existing_company(
    company_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """Link an existing legacy Company Master record to a licensed customer."""
    await _require_platform_owner(current_user)
    customer_id = str(payload.get("commercial_customer_id") or "").strip()
    if not customer_id:
        raise HTTPException(status_code=400, detail="A commercial customer is required.")
    customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    if not customer:
        raise HTTPException(status_code=404, detail="Commercial customer was not found.")
    license_doc = await _active_customer_license(customer_id)
    if not license_doc:
        raise HTTPException(status_code=403, detail="This commercial customer does not have an active license.")
    existing = await db.companies.find_one({"id": str(company_id)}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company Master record was not found.")
    if existing.get("commercial_customer_id") and str(existing.get("commercial_customer_id")) != customer_id:
        raise HTTPException(status_code=409, detail="This company is already linked to another commercial customer.")

    update = {
        "commercial_customer_id": customer_id,
        "commercial_customer_name": customer.get("company_name"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "updated_at": __import__("datetime").datetime.utcnow().isoformat() + "+00:00",
    }
    await db.companies.update_one({"id": str(company_id)}, {"$set": update})
    updated = await db.companies.find_one({"id": str(company_id)}, {"_id": 0})
    await create_audit_log(
        current_user,
        "LINK_LEGAL_COMPANY",
        "company_master",
        str(company_id),
        old_data=existing,
        new_data=update,
    )
    return _company_public(updated or {})


from backend.permission_governance import router as _permission_governance_router
_permission_governance_router.include_router(router)
