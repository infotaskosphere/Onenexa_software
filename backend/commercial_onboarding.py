"""Commercial onboarding extensions.

This router is intentionally registered before the legacy commercial-onboarding
router so the commercial console can evolve without removing the existing
onboarding endpoints. Existing licenses remain backward compatible: when a
legacy license has only ``modules``, every page in those modules remains
licensed.
"""

import calendar
import copy
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext

from backend.dependencies import create_access_token, db, get_current_user, require_admin
from backend.models import DEFAULT_ROLE_PERMISSIONS, User
from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY
from backend.licensing_api import create_license_record, _expiry_reason, _find_license, _now, _public_license
from backend.identity_hierarchy import ensure_licensee_uid, ensure_license_uid, ensure_user_uid

# ---------------------------------------------------------------------------
# Core primitives.
#
# This module is the base that backend.commercial_onboarding_extensions and
# every backend.commercial_*_compat module import from. Keep it import-safe
# (never import back from those modules here) — everything they need to
# build on top of the commercial-onboarding flow is defined below.
# ---------------------------------------------------------------------------

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

MODULE_IDS: List[str] = list(MODULE_HIERARCHY.keys())
MODULE_FLAG_BY_ID: Dict[str, str] = {
    module_id: module_def["flag"] for module_id, module_def in MODULE_HIERARCHY.items()
}
MODULE_CATALOG: List[Dict[str, Any]] = [
    {
        "id": module_id,
        "label": module_def.get("label", module_id),
        "description": module_def.get("description", ""),
        "monthly_price": 0.0,
        "feature_prices": {},
        "active": True,
    }
    for module_id, module_def in MODULE_HIERARCHY.items()
]


def _norm(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _add_months(value: datetime, months: int) -> datetime:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _customer_public(customer: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(customer or {})
    result.pop("_id", None)
    return result


async def _ensure_module_catalog() -> List[Dict[str, Any]]:
    for item in MODULE_CATALOG:
        await db.commercial_license_module_catalog.update_one(
            {"id": item["id"]},
            {"$setOnInsert": dict(item)},
            upsert=True,
        )
    stored = await db.commercial_license_module_catalog.find({}, {"_id": 0}).to_list(200)
    by_id = {item["id"]: item for item in stored}
    ordered = []
    for item in MODULE_CATALOG:
        record = by_id.get(item["id"], item)
        ordered.append({**item, **record})
    return ordered


async def _find_customer_for_license(license_key: Optional[str], company_name: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    key = str(license_key or "").strip().upper()
    if not key:
        raise HTTPException(status_code=400, detail="License number is required.")
    license_doc = await _find_license(key)
    if not license_doc:
        raise HTTPException(status_code=404, detail="License not found. Check the license number and try again.")
    reason = _expiry_reason(license_doc)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    if not customer:
        raise HTTPException(status_code=404, detail="The customer linked to this license was not found.")
    name = str(company_name or "").strip()
    if name and _norm(name) != _norm(customer.get("company_name")):
        raise HTTPException(status_code=403, detail="Company name does not match the licensed customer.")
    return customer, license_doc


async def _find_active_license_for_company_name(company_name: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    name = str(company_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    normalized = _norm(name)
    candidates = await db.commercial_license_customers.find({}, {"_id": 0}).to_list(5000)
    customer = next((item for item in candidates if _norm(item.get("company_name")) == normalized), None)
    if not customer:
        raise HTTPException(status_code=404, detail="No licensed customer matches that company name.")
    docs = await db.commercial_licenses.find({"customer_id": customer.get("id")}, {"_id": 0}).sort("issued_at", -1).to_list(20)
    license_doc = next((doc for doc in docs if not _expiry_reason(doc)), None)
    if not license_doc:
        raise HTTPException(status_code=403, detail="The commercial license for this company is inactive or expired.")
    return customer, license_doc


async def _ensure_company_master(customer: Dict[str, Any], license_doc: Dict[str, Any]) -> Dict[str, Any]:
    customer_id = str(customer.get("id") or "")
    existing = await db.companies.find_one({"commercial_customer_id": customer_id, "source": "commercial-license"}, {"_id": 0})
    if existing:
        patch = {
            "id": existing.get("id") or customer_id,
            "name": customer.get("company_name") or existing.get("name"),
            "gstin": customer.get("gstin") if customer.get("gstin") is not None else existing.get("gstin"),
            "address": customer.get("address") or customer.get("gst_address") or existing.get("address"),
            "state": customer.get("state") or existing.get("state"),
            "pincode": customer.get("pincode") or existing.get("pincode"),
            "email": customer.get("email") or existing.get("email"),
            "phone": customer.get("phone") or existing.get("phone"),
            "commercial_customer_id": customer_id,
            "licensee_uid": customer.get("licensee_uid") or license_doc.get("licensee_uid"),
            "identity_type": "licensee_company",
            "licensed_modules": list(license_doc.get("modules") or license_doc.get("licensed_modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
            "license_id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "source": "commercial-license",
            "status": "active",
        }
        await db.companies.update_one(
            {"commercial_customer_id": customer_id, "source": "commercial-license"},
            {"$set": patch},
        )
        existing.update(patch)
        return existing
    now = _now().isoformat()
    company_doc = {
        "id": customer_id,
        "name": customer.get("company_name"),
        "gstin": customer.get("gstin"),
        "address": customer.get("address") or customer.get("gst_address"),
        "state": customer.get("state"),
        "pincode": customer.get("pincode"),
        "email": customer.get("email"),
        "phone": customer.get("phone"),
        "commercial_customer_id": customer_id,
        "licensee_uid": customer.get("licensee_uid") or license_doc.get("licensee_uid"),
        "identity_type": "licensee_company",
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "source": "commercial-license",
        "created_at": now,
    }
    await db.companies.update_one({"id": customer_id}, {"$set": company_doc}, upsert=True)
    return company_doc


async def _active_company_license(current_user: User) -> Dict[str, Any]:
    company_id = str(getattr(current_user, "company_id", "") or "")
    if not company_id:
        raise HTTPException(status_code=403, detail="Your account is not linked to a licensed company.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    customer_id = str((company or {}).get("commercial_customer_id") or company_id)
    docs = await db.commercial_licenses.find({"customer_id": customer_id}, {"_id": 0}).sort("issued_at", -1).to_list(20)
    license_doc = next((doc for doc in docs if not _expiry_reason(doc)), None)
    if not license_doc:
        raise HTTPException(status_code=403, detail="The commercial license for your company is inactive or expired.")
    return license_doc


def _apply_license_entitlements(role: str, modules: List[str], selected_features: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Apply commercial page entitlements from the Platform Owner selection."""
    permissions = copy.deepcopy(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS["staff"]))
    selected_modules = set(modules or [])
    feature_map = selected_features if isinstance(selected_features, dict) else None

    for module_id, module_flag in MODULE_FLAG_BY_ID.items():
        allowed = module_id in selected_modules
        module_def = MODULE_HIERARCHY.get(module_id, {})

        if not allowed:
            selected_flags = set()
        elif isinstance(feature_map, dict):
            selected_flags = {
                str(flag).strip()
                for flag in (feature_map.get(module_id) or [])
                if str(flag).strip()
            }
        else:
            selected_flags = set()

        permissions[module_flag] = bool(allowed and selected_flags)

        for page in module_def.get("pages", []):
            flag = page.get("flag")
            if flag:
                permissions[flag] = bool(allowed and flag in selected_flags)

    return permissions


router = APIRouter(prefix="/commercial-onboarding", tags=["commercial-onboarding"])


def _feature_defs(module_id: str) -> List[Dict[str, Any]]:
    module = MODULE_HIERARCHY.get(module_id, {})
    return [
        {
            "id": page["flag"],
            "label": page["label"],
            "actions": list(page.get("actions") or []),
        }
        for page in module.get("pages", [])
    ]


def _all_feature_flags(module_id: str) -> List[str]:
    return [item["id"] for item in _feature_defs(module_id)]


async def _enriched_catalog() -> List[Dict[str, Any]]:
    catalog = await _ensure_module_catalog()
    result = []
    for item in catalog:
        module_id = item["id"]
        stored_prices = item.get("feature_prices") or {}
        features = []
        for feature in _feature_defs(module_id):
            price = float(stored_prices.get(feature["id"], 0) or 0)
            features.append({**feature, "monthly_price": round(price, 2)})
        result.append({
            **item,
            "monthly_price": round(float(item.get("monthly_price", 0) or 0), 2),
            "features": features,
        })
    return result


def _normalize_feature_selection(payload: Dict[str, Any], selected_modules: List[str]) -> Dict[str, List[str]]:
    raw = payload.get("selected_features") or payload.get("features") or {}
    result: Dict[str, List[str]] = {}
    for module_id in selected_modules:
        allowed = set(_all_feature_flags(module_id))
        value = raw.get(module_id) if isinstance(raw, dict) else None
        if value is None:
            # Commercial licensing is explicitly page-selective. A selected
            # module with no page list grants no pages until the Platform Owner
            # explicitly selects them.
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
    snapshot: Dict[str, Dict[str, float]] = {}
    for module_id, flags in selected_features.items():
        prices = by_id.get(module_id, {}).get("feature_prices") or {}
        snapshot[module_id] = {flag: round(float(prices.get(flag, 0) or 0), 2) for flag in flags}
    return snapshot


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
    selected_features = selected_features or {module_id: _all_feature_flags(module_id) for module_id in selected_modules}
    for module_id, module_flag in MODULE_FLAG_BY_ID.items():
        allowed = module_id in selected and bool(selected_features.get(module_id))
        permissions[module_flag] = allowed
        module_def = MODULE_HIERARCHY.get(module_id, {})
        allowed_features = set(selected_features.get(module_id) or [])
        for page in module_def.get("pages", []):
            # License is the hard cap; role permissions still decide whether
            # managers/staff receive that page individually.
            permissions[page["flag"]] = bool(allowed and page["flag"] in allowed_features and permissions.get(page["flag"], False))
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

    # Import lazily so the commercial control plane does not make invoicing's
    # optional PDF/Drive dependencies part of backend package initialization.
    from backend.invoicing import InvoiceCreate, InvoiceItem, create_invoice

    invoice_data = InvoiceCreate(
        invoice_type="tax_invoice",
        company_id=str(issuer_company_id),
        client_id=str(customer.get("id") or "") or None,
        client_name=str(customer.get("company_name") or "Licensed Customer"),
        client_address=str(customer.get("gst_address") or customer.get("address") or ""),
        client_email=str(customer.get("email") or ""),
        client_phone=str(customer.get("phone") or ""),
        client_gstin=str(customer.get("gstin") or ""),
        client_state=str(customer.get("state") or ""),
        client_pincode=str(customer.get("pincode") or ""),
        invoice_date=str(license_doc.get("issued_at") or _now().isoformat())[:10],
        due_date=str(license_doc.get("issued_at") or _now().isoformat())[:10],
        supply_state=str(issuer.get("state") or ""),
        supply_pincode=str(issuer.get("pincode") or ""),
        items=[InvoiceItem(description=description, quantity=1, unit="license", unit_price=round(float(amount or 0), 2), gst_rate=18.0)],
        gst_rate=18.0,
        payment_terms="Due on receipt",
        notes=f"Auto-generated against commercial license {license_doc.get('license_key') or license_doc.get('id')}",
        reference_no=str(license_doc.get("license_key") or ""),
        status="draft",
    )
    # Internal Master Console admin is the issuer-side user; the invoice
    # endpoint's normal accounting hooks are therefore preserved.
    from backend import dependencies as _dependencies
    from bson import ObjectId
    raw_db = getattr(_dependencies, "_raw_db", db)
    created_by_str = str(license_doc.get("created_by") or "").strip()
    admin_filter = {"id": created_by_str}
    if ObjectId.is_valid(created_by_str):
        admin_filter = {"$or": [{"id": created_by_str}, {"_id": ObjectId(created_by_str)}]}
    internal_admin = await raw_db.users.find_one(admin_filter)
    if not internal_admin:
        internal_admin = await raw_db.users.find_one({"role": "admin", "company_id": {"$in": [None, "", "null"]}})
    if not internal_admin:
        internal_admin = await raw_db.users.find_one({"role": "admin"})
    if not internal_admin:
        raise HTTPException(status_code=500, detail="Unable to resolve the Master Console administrator for invoice creation.")
    if "_id" in internal_admin and not internal_admin.get("id"):
        internal_admin["id"] = str(internal_admin["_id"])
    internal_admin = {k: v for k, v in internal_admin.items() if k != "_id"}
    current_user = User.model_validate(internal_admin)
    invoice = await create_invoice(invoice_data, current_user)
    await db.commercial_licenses.update_one(
        {"id": license_doc["id"]},
        {"$set": {"invoice_id": invoice.get("id"), "invoice_no": invoice.get("invoice_no"), "invoice_company_id": str(issuer_company_id)}},
    )
    return invoice


@router.get("/module-catalog")
async def get_custom_module_catalog(current_user: User = Depends(require_admin())):
    return {"modules": await _enriched_catalog()}


@router.put("/module-catalog/{module_id}")
async def update_custom_module_catalog(module_id: str, payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    if module_id not in MODULE_IDS:
        raise HTTPException(status_code=404, detail="Module not found.")
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
    await db.commercial_license_module_catalog.update_one(
        {"id": module_id},
        {"$set": {"monthly_price": round(module_price, 2), "feature_prices": normalized_prices, "active": bool(payload.get("active", True)), "updated_at": _now().isoformat()}},
    )
    return next(item for item in await _enriched_catalog() if item["id"] == module_id)


@router.post("/generate-license", status_code=201)
async def generate_custom_license(payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    company_name = str(payload.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    months = max(0, int(payload.get("validity_months") or 0))
    if months <= 0:
        raise HTTPException(status_code=400, detail="License duration in months is required.")

    catalog = await _ensure_module_catalog()
    active_catalog = [item for item in catalog if item.get("active", True)]
    selected_modules = []
    for raw in payload.get("selected_modules") or payload.get("modules") or []:
        module_id = str(raw).strip().lower()
        if module_id and module_id not in selected_modules:
            selected_modules.append(module_id)
    if not selected_modules:
        raise HTTPException(status_code=400, detail="Select at least one module for the license.")
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

    license_doc = await create_license_record(
        {
            **payload,
            "package_id": "essential",
            "validity_days": max(1, months * 30),
            "max_users": max(1, int(payload.get("max_users") or 1)),
            "max_installations": max(1, int(payload.get("max_installations") or 1)),
        },
        str(current_user.id),
    )
    issued_at = datetime.fromisoformat(license_doc["issued_at"].replace("Z", "+00:00"))
    expires_at = _add_months(issued_at, months)
    license_doc.update({
        "package_id": "custom-modules",
        "package_code": "TSO-CUSTOM",
        "package_name": "Custom Module License",
        "modules": selected_modules,
        "selected_features": selected_features,
        "feature_prices": feature_prices,
        "module_prices": {module_id: round(float(next((x.get("monthly_price", 0) for x in catalog if x["id"] == module_id), 0) or 0), 2) for module_id in selected_modules},
        "monthly_module_price": monthly_total,
        "calculated_amount": calculated_amount,
        "validity_months": months,
        "expires_at": expires_at.isoformat(),
        "amount_charged": round(amount_charged, 2),
        "sales_currency": str(payload.get("currency") or "INR"),
        "notes": str(payload.get("notes") or "").strip(),
    })
    await db.commercial_licenses.update_one(
        {"id": license_doc["id"]},
        {"$set": {k: license_doc[k] for k in ("package_id", "package_code", "package_name", "modules", "selected_features", "feature_prices", "module_prices", "monthly_module_price", "calculated_amount", "validity_months", "amount_charged", "expires_at", "sales_currency", "notes")}},
    )

    customer = await db.commercial_license_customers.find_one({"id": license_doc["customer_id"]}, {"_id": 0})
    customer_updates = {
        "gstin": str(payload.get("gstin") or "").strip(),
        "address": str(payload.get("address") or "").strip(),
        "gst_address": str(payload.get("gst_address") or "").strip(),
        "city": str(payload.get("city") or "").strip(),
        "state": str(payload.get("state") or "").strip(),
        "pincode": str(payload.get("pincode") or "").strip(),
        "licensed_modules": selected_modules,
        "selected_features": selected_features,
        "feature_prices": feature_prices,
        "module_prices": license_doc["module_prices"],
        "amount_charged": round(amount_charged, 2),
        "calculated_amount": calculated_amount,
        "monthly_module_price": monthly_total,
        "validity_months": months,
        "last_license_id": license_doc["id"],
    }
    await db.commercial_license_customers.update_one({"id": license_doc["customer_id"]}, {"$set": customer_updates})
    customer = {**(customer or {}), **customer_updates}
    company = await _ensure_company_master(customer, license_doc)
    company_id = company.get("id") or customer.get("id") or ""
    await db.companies.update_one({"id": company_id}, {"$set": {"licensed_modules": selected_modules, "selected_features": selected_features, "license_id": license_doc["id"], "license_key": license_doc["license_key"]}})

    # Once a license is issued by the platform owner to the licensee, the mail added in the licensee
    # account along with company id is by default admin for his company and license with all rights.
    from backend.commercial_licensee_admin import ensure_licensee_admin, get_all_admin_permissions
    await ensure_licensee_admin(customer, license_doc, company)

    invoice_company_id = str(payload.get("invoice_company_id") or "").strip()
    if not invoice_company_id:
        raise HTTPException(status_code=400, detail="Select the Company Master company that should issue this invoice.")
    invoice = await _create_license_invoice(license_doc, customer, invoice_company_id, amount_charged, selected_features)
    license_doc["invoice_id"] = invoice.get("id")
    license_doc["invoice_no"] = invoice.get("invoice_no")
    license_doc["invoice_company_id"] = invoice_company_id

    return {"license": {**license_doc, "customer": _customer_public(customer), "invoice": invoice}, "customer": _customer_public(customer), "company": company, "invoice": invoice}


# backend.commercial_license_creation_compat lazily imports this exact name
# to call through to the canonical generator after its one-customer guard.
generate_license = generate_custom_license


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
    company_id = str(company.get("id") or customer.get("id") or "")
    existing_admin = await db.users.find_one(
        {"company_id": company_id, "role": "admin"},
        {"_id": 0},
    )

    # A license creates the administrator identity before the customer has
    # chosen credentials. Complete that existing placeholder instead of
    # attempting to create a second administrator.
    if existing_admin:
        legacy_license_placeholder = (
            str(existing_admin.get("approved_by") or "") == "commercial-license"
            and str(existing_admin.get("email") or "").strip().lower()
            == str(customer.get("email") or "").strip().lower()
            and not existing_admin.get("admin_credentials_pending") is False
        )
        pending_setup = bool(
            existing_admin.get("admin_credentials_pending")
            or not existing_admin.get("password")
            or existing_admin.get("status") == "pending_admin_setup"
            or legacy_license_placeholder
        )
        if not pending_setup:
            raise HTTPException(
                status_code=409,
                detail="The company administrator has already been created. Please sign in with the existing administrator account.",
            )

        existing_admin_id = str(existing_admin.get("id") or "").strip()
        existing_admin_email = str(existing_admin.get("email") or "").strip().lower()
        # The email already attached to the license-created administrator is
        # intentionally reusable here: the licensee is completing that same
        # administrator account, not creating another account.
        if email != existing_admin_email:
            conflicting_email = await db.users.find_one(
                {
                    "identity_org_uid": (
                        str(existing_admin.get("licensee_uid") or "")
                        or str(customer.get("licensee_uid") or "")
                    ),
                    "email": email,
                    "id": {"$ne": existing_admin_id},
                    "status": {"$ne": "deleted"},
                },
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
            "phone": customer.get("phone"),
            "is_active": True,
            "status": "active",
            "admin_credentials_pending": False,
            "approved_by": "commercial-license",
            "approved_at": now,
            "license_id": license_doc.get("id"),
            "license_key": license_doc.get("license_key"),
            "licensee_uid": customer.get("licensee_uid") or license_doc.get("licensee_uid"),
            "identity_org_uid": customer.get("licensee_uid") or license_doc.get("licensee_uid"),
            "identity_type": "licensee_admin",
            "email_normalized": email,
            "license_uid": license_doc.get("license_uid"),
            "licensed_modules": list(license_doc.get("modules") or []),
            "selected_features": license_doc.get("selected_features") or {},
        }
        await db.users.update_one({"id": existing_admin_id}, {"$set": updates})
        await db.commercial_license_customers.update_one(
            {"id": customer.get("id")},
            {"$set": {"email": email, "admin_name": full_name, "contact_name": full_name}},
        )
        user_doc = await db.users.find_one(
            {"id": existing_admin_id},
            {"_id": 0, "password": 0},
        )
        user_id = str(user_doc.get("id") or "")
        return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": user_doc, "company": company, "license": _public_license(license_doc)}

    licensee_uid = str(getattr(current_user, "licensee_uid", "") or license_doc.get("licensee_uid") or "").strip()
    if not licensee_uid:
        licensee_uid = await ensure_licensee_uid(db, str(customer.get("id") or license_doc.get("customer_id") or ""), customer)
    existing_staff = await db.users.find_one(
        {
            "$or": [
                {"identity_org_uid": licensee_uid, "email_normalized": email},
                {"identity_org_uid": licensee_uid, "email": email},
                {"licensee_uid": licensee_uid, "email_normalized": email},
                {"licensee_uid": licensee_uid, "email": email},
                {"commercial_customer_id": str(customer.get("id") or ""), "email": email},
            ],
            "status": {"$ne": "deleted"},
        }
    )
    if existing_staff:
        raise HTTPException(status_code=409, detail="An account already exists for this email address in this licensee workspace.")

    now = _now().isoformat()
    user_id = str(uuid.uuid4())
    from backend.commercial_licensee_admin import get_all_admin_permissions
    permissions = get_all_admin_permissions(license_doc)
    user_doc = {
        "id": user_id, "email": email, "full_name": full_name, "role": "admin",
        "password": pwd_context.hash(password), "permissions": permissions, "departments": [],
        "phone": customer.get("phone"), "is_active": True, "status": "active",
        "admin_credentials_pending": False,
        "approved_by": "commercial-license", "approved_at": now, "created_at": now,
        "company_id": company_id, "company_name": customer.get("company_name"),
        "commercial_customer_id": str(customer.get("id") or ""),
        "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    await db.users.insert_one(user_doc)
    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": safe_user, "company": company, "license": _public_license(license_doc)}


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
    if await db.users.find_one({"email": email, "status": {"$ne": "deleted"}}):
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
    user_id = str(uuid.uuid4())
    user_uid = await ensure_user_uid(
        db,
        {"id": user_id, "email": email},
        organization_uid=licensee_uid,
        identity_type="licensee_user",
    )
    user_doc = {
        "id": user_id, "user_uid": user_uid, "email": email, "full_name": full_name, "role": role,
        "password": pwd_context.hash(password), "permissions": permissions,
        "departments": list(payload.get("departments") or []), "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True, "status": "active", "approved_by": current_user.id, "approved_at": now, "created_at": now,
        "company_id": customer.get("id"), "company_name": customer.get("company_name"),
        "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"),
        "licensee_uid": licensee_uid, "identity_org_uid": licensee_uid,
        "identity_type": "licensee_user", "email_normalized": email,
        "license_uid": license_doc.get("license_uid"),
        "licensed_modules": list(license_doc.get("modules") or []), "selected_features": license_doc.get("selected_features") or {},
    }
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

    # The Platform Owner is never a commercial tenant. Never let this cascade
    # deactivate or rename the Platform Owner's own login, even if their
    # account was ever linked to this customer/company id.
    from backend.platform_owner import platform_owner_emails
    owner_emails = list(platform_owner_emails())
    if customer_id:
        owner_linked = await db.users.find_one(
            {
                "company_id": customer_id,
                "$or": [
                    {"identity_type": {"$regex": r"^platform_owner", "$options": "i"}},
                    {"platform_owner_uid": {"$regex": r"^PO-", "$options": "i"}},
                    {"is_platform_owner": True},
                    {
                        "email": {"$in": owner_emails},
                        "licensee_uid": {"$in": [None, ""]},
                        "commercial_customer_id": {"$in": [None, ""]},
                        "license_id": {"$in": [None, ""]},
                    },
                ],
            },
            {"_id": 0, "id": 1},
        )
        if owner_linked:
            raise HTTPException(
                status_code=400,
                detail="This company/license is linked to a Platform Owner account and cannot be deleted.",
            )

    customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    await db.commercial_licenses.delete_one({"id": license_id})
    remaining = await db.commercial_licenses.count_documents({"customer_id": customer_id})
    if remaining == 0 and customer_id:
        await db.commercial_license_customers.delete_one({"id": customer_id})
        await db.companies.delete_one({"id": customer_id, "source": "commercial-license"})

        # Commercial tenant users are owned by the customer/license. When the
        # last license is removed, remove those MongoDB user documents too.
        # Platform-owner and internal control-plane identities are protected.
        customer_user_filter = {
            "$and": [
                {
                    "$or": [
                        {"company_id": customer_id},
                        {"commercial_customer_id": customer_id},
                    ]
                },
                # Do not use owner email as the primary boundary. A
                # legitimate licensee may intentionally use the same email.
                # Legacy owner-email protection remains only when the user has
                # no commercial identity markers at all.
                {
                    "$or": [
                        {"email": {"$nin": owner_emails}},
                        {"licensee_uid": {"$nin": [None, ""]}},
                        {"commercial_customer_id": {"$nin": [None, ""]}},
                        {"license_id": {"$nin": [None, ""]}},
                    ]
                },
                {"is_internal_commercial_admin": {"$ne": True}},
                {"role": {"$ne": "superadmin"}},
            ]
        }
        await db.users.delete_many(customer_user_filter)

        # Also remove any legacy commercial-company records that may still
        # reference this customer through an alternate company identifier.
        await db.companies.delete_many(
            {
                "source": "commercial-license",
                "commercial_customer_id": customer_id,
            }
        )

    return {"deleted": True, "license_id": license_id, "company_name": (customer or {}).get("company_name"), "remaining_licenses": remaining, "historical_invoices_preserved": True}


# Register before the legacy commercial-onboarding router. The latter remains
# in place for backwards compatibility with old clients and licenses.
from backend.permission_governance import router as _permission_governance_router
if not any(getattr(r, "path", "") == "/commercial-onboarding" for r in getattr(_permission_governance_router, "routes", [])):
    _permission_governance_router.include_router(router)
