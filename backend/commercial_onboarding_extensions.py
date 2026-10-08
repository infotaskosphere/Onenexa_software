"""Commercial onboarding extensions.

This router is intentionally registered before the legacy commercial-onboarding
router so the commercial console can evolve without removing the existing
onboarding endpoints. Existing licenses remain backward compatible: when a
legacy license has only ``modules``, every page in those modules remains
licensed.
"""

import copy
import uuid
from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException

from backend.dependencies import create_access_token, db, get_current_user, require_admin
from backend.models import DEFAULT_ROLE_PERMISSIONS, User
from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY
from backend.licensing_api import create_license_record, _expiry_reason, _find_license, _now, _public_license
from backend.commercial_onboarding import (
    MODULE_CATALOG,
    MODULE_FLAG_BY_ID,
    MODULE_IDS,
    _add_months,
    _customer_public,
    _ensure_company_master,
    _ensure_module_catalog,
    _find_customer_for_license,
    _norm,
    _active_company_license,
    pwd_context,
)

router = APIRouter(prefix="/commercial-onboarding", tags=["commercial-onboarding"])

# Admin is a tenant control-plane role, not a commercial product/module.
COMMERCIAL_MODULE_IDS = tuple(module_id for module_id in MODULE_IDS if module_id != "admin")


def _feature_defs(module_id: str) -> List[Dict[str, Any]]:
    module = MODULE_HIERARCHY.get(module_id, {})
    return [{"id": page["flag"], "label": page["label"], "actions": list(page.get("actions") or [])} for page in module.get("pages", [])]


def _all_feature_flags(module_id: str) -> List[str]:
    return [item["id"] for item in _feature_defs(module_id)]


async def _enriched_catalog() -> List[Dict[str, Any]]:
    catalog = await _ensure_module_catalog()
    result = []
    for item in catalog:
        module_id = item["id"]
        if module_id not in COMMERCIAL_MODULE_IDS:
            continue
        stored_prices = item.get("feature_prices") or {}
        features = [{**feature, "monthly_price": round(float(stored_prices.get(feature["id"], 0) or 0), 2)} for feature in _feature_defs(module_id)]
        result.append({**item, "monthly_price": round(float(item.get("monthly_price", 0) or 0), 2), "features": features})
    return result


def _normalize_feature_selection(payload: Dict[str, Any], selected_modules: List[str]) -> Dict[str, List[str]]:
    raw = payload.get("selected_features") or payload.get("features") or {}
    result: Dict[str, List[str]] = {}
    for module_id in selected_modules:
        if module_id not in COMMERCIAL_MODULE_IDS:
            raise HTTPException(status_code=400, detail="Admin is a tenant control role and is not a licensable module.")
        allowed = set(_all_feature_flags(module_id))
        value = raw.get(module_id) if isinstance(raw, dict) else None
        if value is None:
            result[module_id] = []
            continue
        if not isinstance(value, list):
            raise HTTPException(status_code=400, detail=f"Features for {module_id} must be a list.")
        selected = []
        for flag in value:
            flag = str(flag).strip()
            if flag in allowed and flag not in selected:
                selected.append(flag)
        if not selected:
            raise HTTPException(status_code=400, detail=f"Select at least one feature in {module_id} or remove the module.")
        result[module_id] = selected
    return result


def _feature_snapshot(catalog: List[Dict[str, Any]], selected_features: Dict[str, List[str]]) -> Dict[str, Dict[str, float]]:
    by_id = {item["id"]: item for item in catalog}
    return {module_id: {flag: round(float((by_id.get(module_id, {}).get("feature_prices") or {}).get(flag, 0) or 0), 2) for flag in flags} for module_id, flags in selected_features.items()}


def _monthly_total(catalog: List[Dict[str, Any]], selected_features: Dict[str, List[str]], feature_prices: Dict[str, Dict[str, float]]) -> float:
    by_id = {item["id"]: item for item in catalog}
    total = 0.0
    for module_id, flags in selected_features.items():
        all_flags = set(_all_feature_flags(module_id))
        module_price = float(by_id.get(module_id, {}).get("monthly_price", 0) or 0)
        if set(flags) == all_flags and module_price > 0:
            total += module_price
        else:
            total += sum(float(feature_prices.get(module_id, {}).get(flag, 0) or 0) for flag in flags)
    return round(total, 2)


def _apply_feature_entitlements(role: str, selected_modules: List[str], selected_features: Dict[str, List[str]] | None = None) -> Dict[str, Any]:
    permissions = copy.deepcopy(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS["staff"]))
    selected = set(selected_modules)
    selected_features = selected_features if isinstance(selected_features, dict) else {}
    for module_id, module_flag in MODULE_FLAG_BY_ID.items():
        # A purchased module is only the ceiling. The Platform Owner's explicit
        # page selection is the complete commercial entitlement.
        allowed = module_id in selected
        module_def = MODULE_HIERARCHY.get(module_id, {})
        allowed_features = set(selected_features.get(module_id) or []) if module_id in selected else set()
        permissions[module_flag] = bool(allowed and allowed_features)
        for page in module_def.get("pages", []):
            flag = page.get("flag")
            if flag:
                permissions[flag] = bool(allowed and flag in allowed_features)
    return permissions


async def _create_license_invoice(license_doc: Dict[str, Any], customer: Dict[str, Any], issuer_company_id: str, amount: float, selected_features: Dict[str, List[str]]) -> Dict[str, Any]:
    issuer = await db.companies.find_one({"id": issuer_company_id}, {"_id": 0})
    if not issuer:
        raise HTTPException(status_code=400, detail="The selected invoice company was not found in Company Master.")
    if str(issuer_company_id) == str(customer.get("id")):
        raise HTTPException(status_code=400, detail="Invoice issuer and licensed customer company must be different.")
    feature_labels = []
    for module_id, flags in selected_features.items():
        module = MODULE_HIERARCHY.get(module_id, {})
        labels = {page["flag"]: page["label"] for page in module.get("pages", [])}
        for flag in flags:
            feature_labels.append(f"{module.get('label', module_id)} — {labels.get(flag, flag)}")
    description = "Taskosphere Commercial License"
    if feature_labels:
        description += ": " + ", ".join(feature_labels)
    description += f" | Validity: {license_doc.get('validity_months') or 0} months"
    from backend.invoicing import InvoiceCreate, InvoiceItem, create_invoice
    invoice_data = InvoiceCreate(
        invoice_type="tax_invoice", company_id=str(issuer_company_id), client_id=str(customer.get("id") or "") or None,
        client_name=str(customer.get("company_name") or "Licensed Customer"), client_address=str(customer.get("gst_address") or customer.get("address") or ""),
        client_email=str(customer.get("email") or ""), client_phone=str(customer.get("phone") or ""), client_gstin=str(customer.get("gstin") or ""),
        client_state=str(customer.get("state") or ""), client_pincode=str(customer.get("pincode") or ""),
        invoice_date=str(license_doc.get("issued_at") or _now().isoformat())[:10], due_date=str(license_doc.get("issued_at") or _now().isoformat())[:10],
        supply_state=str(issuer.get("state") or ""), supply_pincode=str(issuer.get("pincode") or ""),
        items=[InvoiceItem(description=description, quantity=1, unit="license", unit_price=round(float(amount or 0), 2), gst_rate=18.0)],
        gst_rate=18.0, payment_terms="Due on receipt", notes=f"Auto-generated against commercial license {license_doc.get('license_key') or license_doc.get('id')}",
        reference_no=str(license_doc.get("license_key") or ""), status="draft",
    )
    internal_admin = await db.users.find_one({"id": str(license_doc.get("created_by") or "")}, {"_id": 0})
    if not internal_admin:
        internal_admin = await db.users.find_one({"role": "admin", "company_id": {"$in": [None, "", "null"]}}, {"_id": 0})
    if not internal_admin:
        raise HTTPException(status_code=500, detail="Unable to resolve the Master Console administrator for invoice creation.")
    current_user = User.model_validate(internal_admin)
    invoice = await create_invoice(invoice_data, current_user)
    await db.commercial_licenses.update_one({"id": license_doc["id"]}, {"$set": {"invoice_id": invoice.get("id"), "invoice_no": invoice.get("invoice_no"), "invoice_company_id": str(issuer_company_id)}})
    return invoice


@router.get("/module-catalog")
async def get_custom_module_catalog(current_user: User = Depends(require_admin())):
    return {"modules": await _enriched_catalog()}


@router.put("/module-catalog/{module_id}")
async def update_custom_module_catalog(module_id: str, payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    if module_id not in COMMERCIAL_MODULE_IDS:
        raise HTTPException(status_code=404, detail="Module not found or not commercially licensable.")
    try:
        module_price = float(payload.get("monthly_price", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Monthly module price must be a number.")
    if module_price < 0:
        raise HTTPException(status_code=400, detail="Monthly module price cannot be negative.")
    feature_prices = payload.get("feature_prices") or {}
    if not isinstance(feature_prices, dict):
        raise HTTPException(status_code=400, detail="Feature prices must be an object.")
    allowed = set(_all_feature_flags(module_id))
    normalized_prices = {}
    for flag, value in feature_prices.items():
        if flag not in allowed:
            continue
        try:
            price = float(value or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Invalid price for feature {flag}.")
        if price < 0:
            raise HTTPException(status_code=400, detail=f"Feature price cannot be negative: {flag}.")
        normalized_prices[flag] = round(price, 2)
    await _ensure_module_catalog()
    await db.commercial_license_module_catalog.update_one({"id": module_id}, {"$set": {"monthly_price": round(module_price, 2), "feature_prices": normalized_prices, "active": bool(payload.get("active", True)), "updated_at": _now().isoformat()}})
    return next(item for item in await _enriched_catalog() if item["id"] == module_id)


@router.post("/generate-license", status_code=201)
async def generate_custom_license(payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    company_name = str(payload.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    admin_name = str(payload.get("admin_name") or "").strip()
    if not admin_name:
        raise HTTPException(status_code=400, detail="Admin Name is required.")
    months = max(0, int(payload.get("validity_months") or 0))
    if months <= 0:
        raise HTTPException(status_code=400, detail="License duration in months is required.")
    catalog = await _ensure_module_catalog()
    active_catalog = [item for item in catalog if item.get("active", True) and item.get("id") in COMMERCIAL_MODULE_IDS]
    selected_modules = []
    for raw in payload.get("selected_modules") or payload.get("modules") or []:
        module_id = str(raw).strip().lower()
        if module_id and module_id not in selected_modules:
            selected_modules.append(module_id)
    if not selected_modules:
        raise HTTPException(status_code=400, detail="Select at least one module for the license.")
    if "admin" in selected_modules:
        raise HTTPException(status_code=400, detail="Admin is a tenant control role and is not a licensable module.")
    unavailable = [module_id for module_id in selected_modules if module_id not in {item["id"] for item in active_catalog}]
    if unavailable:
        raise HTTPException(status_code=400, detail=f"Selected module is unavailable: {', '.join(unavailable)}.")
    selected_features = _normalize_feature_selection(payload, selected_modules)
    feature_prices = _feature_snapshot(catalog, selected_features)
    monthly_total = _monthly_total(catalog, selected_features, feature_prices)
    calculated_amount = round(monthly_total * months, 2)
    amount_raw = payload.get("amount_charged")
    amount_charged = calculated_amount if amount_raw in (None, "") else float(amount_raw)
    if amount_charged < 0:
        raise HTTPException(status_code=400, detail="Amount charged cannot be negative.")
    license_doc = await create_license_record({**payload, "package_id": "essential", "validity_days": max(1, months * 30), "max_users": max(1, int(payload.get("max_users") or 1)), "max_installations": max(1, int(payload.get("max_installations") or 1))}, str(current_user.id))
    issued_at = datetime.fromisoformat(license_doc["issued_at"].replace("Z", "+00:00"))
    expires_at = _add_months(issued_at, months)
    license_doc.update({"admin_name": admin_name, "customer_name": admin_name, "company_name": company_name, "package_id": "custom-modules", "package_code": "TSO-CUSTOM", "package_name": "Custom Module License", "modules": selected_modules, "selected_features": selected_features, "feature_prices": feature_prices, "module_prices": {module_id: round(float(next((x.get("monthly_price", 0) for x in catalog if x["id"] == module_id), 0) or 0), 2) for module_id in selected_modules}, "monthly_module_price": monthly_total, "calculated_amount": calculated_amount, "validity_months": months, "expires_at": expires_at.isoformat(), "amount_charged": round(amount_charged, 2), "sales_currency": str(payload.get("currency") or "INR"), "notes": str(payload.get("notes") or "").strip()})
    await db.commercial_licenses.update_one({"id": license_doc["id"]}, {"$set": {k: license_doc[k] for k in ("package_id", "package_code", "package_name", "modules", "selected_features", "feature_prices", "module_prices", "monthly_module_price", "calculated_amount", "validity_months", "amount_charged", "expires_at", "sales_currency", "notes")}})
    customer = await db.commercial_license_customers.find_one({"id": license_doc["customer_id"]}, {"_id": 0})
    customer_updates = {"admin_name": admin_name, "gstin": str(payload.get("gstin") or "").strip(), "address": str(payload.get("address") or "").strip(), "gst_address": str(payload.get("gst_address") or "").strip(), "city": str(payload.get("city") or "").strip(), "state": str(payload.get("state") or "").strip(), "pincode": str(payload.get("pincode") or "").strip(), "licensed_modules": selected_modules, "selected_features": selected_features, "feature_prices": feature_prices, "module_prices": license_doc["module_prices"], "amount_charged": round(amount_charged, 2), "calculated_amount": calculated_amount, "monthly_module_price": monthly_total, "validity_months": months, "last_license_id": license_doc["id"]}
    await db.commercial_license_customers.update_one({"id": license_doc["customer_id"]}, {"$set": customer_updates})
    customer = {**(customer or {}), **customer_updates}
    company = await _ensure_company_master(customer, license_doc)
    await db.companies.update_one({"id": company["id"]}, {"$set": {"licensed_modules": selected_modules, "selected_features": selected_features, "license_id": license_doc["id"], "license_key": license_doc["license_key"]}})
    from backend.commercial_licensee_admin import ensure_licensee_admin
    await ensure_licensee_admin(customer, license_doc, company)
    invoice_company_id = str(payload.get("invoice_company_id") or "").strip()
    if not invoice_company_id:
        raise HTTPException(status_code=400, detail="Select the Company Master company that should issue this invoice.")
    invoice = await _create_license_invoice(license_doc, customer, invoice_company_id, amount_charged, selected_features)
    license_doc["invoice_id"] = invoice.get("id")
    license_doc["invoice_no"] = invoice.get("invoice_no")
    license_doc["invoice_company_id"] = invoice_company_id
    return {"license": {**license_doc, "customer": _customer_public(customer), "invoice": invoice}, "customer": _customer_public(customer), "company": company, "invoice": invoice}


@router.post("/lookup")
async def lookup_custom_license(payload: Dict[str, Any]):
    customer, license_doc = await _find_customer_for_license(payload.get("license_key"), payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)
    return {"valid": True, "customer": _customer_public(customer), "license": _public_license(license_doc), "company": company}


@router.post("/create-admin")
async def create_custom_admin(payload: Dict[str, Any]):
    customer, license_doc = await _find_customer_for_license(payload.get("license_key"), payload.get("company_name"))
    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")

    company = await _ensure_company_master(customer, license_doc)

    # License issuance already creates a locked, credentials-pending admin
    # identity. First activation must complete THAT identity rather than
    # attempting to insert a second admin and returning 409.
    existing_admin = await db.users.find_one(
        {
            "$or": [
                {"company_id": str(company.get("id") or "")},
                {"commercial_customer_id": str(customer.get("id") or "")},
            ],
            "role": "admin",
        },
        {"_id": 0},
    )

    from backend.commercial_licensee_admin import get_all_admin_permissions
    permissions = get_all_admin_permissions(license_doc)
    now = _now().isoformat()

    if existing_admin:
        existing_email = str(existing_admin.get("email") or "").strip().lower()
        pending = bool(
            existing_admin.get("admin_credentials_pending") is True
            or existing_admin.get("status") == "pending_admin_setup"
            or not existing_admin.get("password")
        )
        if not pending:
            if existing_email != email:
                raise HTTPException(
                    status_code=409,
                    detail="The company administrator has already been created. Please sign in with the existing administrator account.",
                )
            raise HTTPException(
                status_code=409,
                detail="The company administrator has already been created. Please sign in with the existing administrator account.",
            )

        if existing_email and existing_email != email:
            raise HTTPException(
                status_code=400,
                detail="Use the administrator email registered on this license.",
            )

        await db.users.update_one(
            {"id": existing_admin.get("id")},
            {
                "$set": {
                    "full_name": full_name,
                    "email": email or existing_email,
                    "password": pwd_context.hash(password),
                    "role": "admin",
                    "permissions": permissions,
                    "is_active": True,
                    "status": "active",
                    "admin_credentials_pending": False,
                    "approved_by": "commercial-license",
                    "approved_at": now,
                    "company_id": company.get("id"),
                    "company_name": customer.get("company_name"),
                    "commercial_customer_id": str(customer.get("id") or ""),
                    "license_id": license_doc.get("id"),
                    "license_key": license_doc.get("license_key"),
                    "licensed_modules": list(license_doc.get("modules") or []),
                    "selected_features": license_doc.get("selected_features") or {},
                }
            },
        )
        user_id = str(existing_admin.get("id"))
    else:
        # Compatibility for very old licenses where the issuance flow did not
        # create the pending admin placeholder.
        if await db.users.find_one({"email": email}, {"_id": 1}):
            raise HTTPException(status_code=409, detail="An account already exists for this email address.")
        user_id = str(uuid.uuid4())
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
            "company_id": company.get("id"),
            "company_name": customer.get("company_name"),
            "commercial_customer_id": str(customer.get("id") or ""),
            "license_id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "licensed_modules": list(license_doc.get("modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
        }
        await db.users.insert_one(user_doc)

    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    safe_user = dict(user or {})
    safe_user["permissions"] = permissions
    safe_user["licensed_modules"] = list(license_doc.get("modules") or [])
    safe_user["selected_features"] = license_doc.get("selected_features") or {}
    safe_user["license_id"] = license_doc.get("id")
    safe_user["license_key"] = license_doc.get("license_key")
    safe_user["company_id"] = company.get("id")
    safe_user["company_name"] = customer.get("company_name")

    return {
        "access_token": create_access_token({"sub": user_id}),
        "token_type": "bearer",
        "user": safe_user,
        "company": company,
        "license": _public_license(license_doc),
    }

@router.post("/create-staff")
async def create_custom_staff(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only the company administrator can create staff accounts.")
    company_name = str(payload.get("company_name") or "").strip()
    if _norm(company_name) != _norm(getattr(current_user, "company_name", "")):
        raise HTTPException(status_code=403, detail="Company name does not match your licensed company.")
    license_doc = await _active_company_license(current_user)
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    if not customer or _norm(customer.get("company_name")) != _norm(company_name):
        raise HTTPException(status_code=403, detail="Company name does not match the licensed company.")
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    full_name = str(payload.get("full_name") or "").strip()
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")
    active_users = await db.users.count_documents({"company_id": customer.get("id"), "is_active": True})
    max_users = int(license_doc.get("max_users", 1))
    if active_users >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
    role = str(payload.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now().isoformat()
    permissions = _apply_feature_entitlements(role, list(license_doc.get("modules") or []), license_doc.get("selected_features"))
    user_doc = {"id": str(uuid.uuid4()), "email": email, "full_name": full_name, "role": role, "password": pwd_context.hash(password), "permissions": permissions, "departments": list(payload.get("departments") or []), "phone": str(payload.get("phone") or "").strip() or None, "is_active": True, "status": "active", "approved_by": current_user.id, "approved_at": now, "created_at": now, "company_id": customer.get("id"), "company_name": customer.get("company_name"), "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"), "licensed_modules": list(license_doc.get("modules") or []), "selected_features": license_doc.get("selected_features") or {}}
    await db.users.insert_one(user_doc)
    return {k: v for k, v in user_doc.items() if k != "password"}


@router.get("/my-company")
async def get_custom_my_company(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin" or not getattr(current_user, "company_id", None):
        raise HTTPException(status_code=403, detail="Commercial company administration is unavailable for this account.")
    license_doc = await _active_company_license(current_user)
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    return {"customer": _customer_public(customer or {}), "license": license_doc}


@router.delete("/licenses/{license_id}/company")
async def delete_commercial_company(license_id: str, current_user: User = Depends(require_admin())):
    license_doc = await db.commercial_licenses.find_one({"id": license_id}, {"_id": 0})
    if not license_doc:
        raise HTTPException(status_code=404, detail="License not found.")
    customer_id = str(license_doc.get("customer_id") or "")
    from backend.platform_owner import platform_owner_emails
    owner_emails = list(platform_owner_emails())
    if customer_id:
        owner_linked = await db.users.find_one({"company_id": customer_id, "email": {"$in": owner_emails}}, {"_id": 0, "id": 1})
        if owner_linked:
            raise HTTPException(status_code=400, detail="This company/license is linked to a Platform Owner account and cannot be deleted.")
    customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    await db.commercial_licenses.delete_one({"id": license_id})
    remaining = await db.commercial_licenses.count_documents({"customer_id": customer_id})
    if remaining == 0 and customer_id:
        await db.commercial_license_customers.delete_one({"id": customer_id})
        await db.companies.delete_one({"id": customer_id, "source": "commercial-license"})
        await db.users.update_many({"company_id": customer_id, "email": {"$nin": owner_emails}}, {"$set": {"is_active": False, "status": "deleted", "commercial_deleted_at": _now().isoformat()}})
    return {"deleted": True, "license_id": license_id, "company_name": (customer or {}).get("company_name"), "remaining_licenses": remaining, "historical_invoices_preserved": True}


from backend.permission_governance import router as _permission_governance_router
if not any(getattr(r, "path", "") == "/commercial-onboarding" for r in getattr(_permission_governance_router, "routes", [])):
    _permission_governance_router.include_router(router)
