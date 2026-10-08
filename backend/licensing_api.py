import logging
import os
import secrets
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.dependencies import db, get_current_user, require_admin
from backend.identity_hierarchy import ensure_identity_email_link, ensure_licensee_uid, ensure_license_uid


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/licensing", tags=["commercial-licensing"])

LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

DEFAULT_LICENSE_PACKAGES = [
    {
        "id": "essential",
        "code": "TSO-ESSENTIAL",
        "name": "Taskosphere Essential",
        "description": "Task Management + Invoicing",
        "modules": ["TASKS", "INVOICING"],
        "max_users": 10,
        "max_installations": 1,
        "validity_days": 365,
        "price": 0,
        "active": True,
    },
    {
        "id": "professional",
        "code": "TSO-PRO",
        "name": "Taskosphere Professional",
        "description": "Task Management + Invoicing + HRMS",
        "modules": ["TASKS", "INVOICING", "HRMS"],
        "max_users": 25,
        "max_installations": 2,
        "validity_days": 365,
        "price": 0,
        "active": True,
    },
    {
        "id": "enterprise",
        "code": "TSO-ENTERPRISE",
        "name": "Taskosphere Enterprise",
        "description": "Task Management + Invoicing + Accounting + HRMS",
        "modules": ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"],
        "max_users": 100,
        "max_installations": 5,
        "validity_days": 365,
        "price": 0,
        "active": True,
    },
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _random_part(length: int = 4) -> str:
    return "".join(secrets.choice(LICENSE_ALPHABET) for _ in range(length))


async def create_licensing_indexes() -> None:
    """Create indexes and seed the three commercial packages."""
    try:
        await ensure_identity_indexes(db)
    except Exception as identity_idx_err:
        logger.warning("Hierarchical identity index creation warning: %s", identity_idx_err)
    await db.commercial_license_packages.create_index("id", unique=True, background=True)
    await db.commercial_license_customers.create_index("id", unique=True, background=True)
    await db.commercial_licenses.create_index("id", unique=True, background=True)
    await db.commercial_licenses.create_index("license_key", unique=True, background=True)
    await db.commercial_licenses.create_index("customer_id", background=True)
    await db.commercial_licenses.create_index("package_id", background=True)
    await db.commercial_licenses.create_index(
        [("activations.installation_id", 1)], background=True
    )

    for package in DEFAULT_LICENSE_PACKAGES:
        await db.commercial_license_packages.update_one(
            {"id": package["id"]},
            {"$setOnInsert": package},
            upsert=True,
        )


def _public_license(license: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(license)
    result.pop("_id", None)
    return result


async def _generate_unique_key() -> str:
    while True:
        key = "TSO-{}-{}-{}-{}".format(
            _random_part(), _random_part(), _random_part(), _random_part()
        )
        if not await db.commercial_licenses.find_one({"license_key": key}, {"_id": 1}):
            return key


async def _get_package(package_id: str) -> Optional[Dict[str, Any]]:
    package = await db.commercial_license_packages.find_one({"id": package_id}, {"_id": 0})
    if package:
        return package
    for default in DEFAULT_LICENSE_PACKAGES:
        if default["id"] == package_id:
            return dict(default)
    return None


async def _find_license(license_key: str):
    normalized = str(license_key or "").strip().upper()
    if not normalized:
        return None
    return await db.commercial_licenses.find_one({"license_key": normalized})


def _expiry_reason(license: Dict[str, Any]) -> Optional[str]:
    status = license.get("status")
    if status != "active":
        return f"License is {status or 'inactive'}"
    expires_at = license.get("expires_at")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry < _now():
                return "License expired"
        except ValueError:
            return "License has an invalid expiry date"
    return None


async def list_license_state() -> Dict[str, Any]:
    packages = await db.commercial_license_packages.find({"active": True}, {"_id": 0}).to_list(100)
    if not packages:
        packages = [dict(p) for p in DEFAULT_LICENSE_PACKAGES]

    # The customer registry is derived from real commercial license ownership.
    # Do not expose stale/orphan customer documents in the Master Console.
    # A customer with no remaining license is no longer a commercial tenant.
    licenses = await db.commercial_licenses.find({}, {"_id": 0}).sort("issued_at", -1).to_list(1000)
    licensed_customer_ids = sorted(
        {
            str(license_doc.get("customer_id") or "").strip()
            for license_doc in licenses
            if str(license_doc.get("customer_id") or "").strip()
        }
    )

    if licensed_customer_ids:
        # Hard-clean orphan commercial customer/company records left by older
        # deletion flows. This is safe because every retained customer still
        # has at least one commercial license document.
        await db.commercial_license_customers.delete_many(
            {"id": {"$nin": licensed_customer_ids}}
        )
        await db.companies.delete_many(
            {
                "source": "commercial-license",
                "commercial_customer_id": {"$nin": licensed_customer_ids},
            }
        )
        # Permanently remove legacy soft-deleted commercial users belonging to
        # customer tenants that no longer have any license. This cleans records
        # created by the previous soft-delete implementation without touching
        # active users or platform-owner/internal accounts.
        await db.users.delete_many(
            {
                "status": "deleted",
                "commercial_customer_id": {"$nin": licensed_customer_ids},
                "is_internal_commercial_admin": {"$ne": True},
            }
        )
        customers = await db.commercial_license_customers.find(
            {"id": {"$in": licensed_customer_ids}},
            {"_id": 0},
        ).sort("created_at", -1).to_list(1000)
    else:
        # No commercial licenses means there must be no commercial customer
        # registry records left behind.
        await db.commercial_license_customers.delete_many({})
        await db.companies.delete_many({"source": "commercial-license"})
        customers = []

    return {"packages": packages, "customers": customers, "licenses": licenses}


async def create_license_record(input_data: Dict[str, Any], created_by: str) -> Dict[str, Any]:
    package_id = str(input_data.get("package_id") or "essential")
    package = await _get_package(package_id)
    if not package or not package.get("active", True):
        raise HTTPException(status_code=400, detail="Selected package does not exist or is inactive.")

    company_name = str(input_data.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    admin_name = str(input_data.get("admin_name") or input_data.get("contact_name") or "").strip()
    if not admin_name:
        admin_name = company_name

    customer_id = str(input_data.get("customer_id") or f"cus-{uuid.uuid4().hex}")
    existing_customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    if existing_customer:
        customer = existing_customer
    else:
        customer = {
            "id": customer_id,
            "company_name": company_name,
            "admin_name": admin_name,
            "contact_name": str(input_data.get("contact_name") or "").strip(),
            "email": str(input_data.get("email") or "").strip(),
            "phone": str(input_data.get("phone") or "").strip(),
            "created_at": _now().isoformat(),
        }
        email = str(customer.get("email") or "").strip()
        if email:
            existing_link = await db.identity_email_links.find_one(
                {"email_normalized": email.lower()},
                {"_id": 0, "identity_uid": 1},
            )
            if existing_link:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This email is already linked to "
                        f"{existing_link.get('identity_uid') or 'another organization identity'}. "
                        "One email cannot be linked to two unique IDs."
                    ),
                )
            if email.lower() in {
                value.lower() for value in os.getenv(
                    "PLATFORM_OWNER_EMAILS",
                    "info.taskosphere@gmail.com,infotaskosphere@gmail.com,admin@taskosphere.com,csmanthandesai@gmail.com",
                ).split(",") if value.strip()
            }:
                raise HTTPException(
                    status_code=409,
                    detail="This email is reserved for the Platform Owner and cannot be linked to a licensee.",
                )
            existing_email_customer = await db.commercial_license_customers.find_one(
                {
                    "$or": [
                        {"email_normalized": email.lower()},
                        {"email": email},
                    ]
                },
                {"_id": 0, "id": 1, "licensee_uid": 1},
            )
            if existing_email_customer and str(existing_email_customer.get("id") or "") != customer_id:
                raise HTTPException(
                    status_code=409,
                    detail="This email is already linked to another licensee unique ID.",
                )
        await db.commercial_license_customers.insert_one(dict(customer))

    email_normalized = str(customer.get("email") or "").strip().lower()
    licensee_uid = await ensure_licensee_uid(db, customer["id"], customer)
    customer["licensee_uid"] = licensee_uid
    await db.commercial_license_customers.update_one(
        {"id": customer["id"]},
        {
            "$set": {
                "licensee_uid": licensee_uid,
                "identity_type": "licensee",
                "email_normalized": email_normalized,
            }
        },
    )
    if email_normalized:
        await ensure_identity_email_link(
            db,
            customer.get("email"),
            licensee_uid,
            identity_type="licensee",
        )

    issued_at = _now()
    validity_days = int(input_data.get("validity_days") if input_data.get("validity_days") is not None else package.get("validity_days", 365))
    max_users = max(1, int(input_data.get("max_users") or package.get("max_users", 1)))
    max_installations = max(1, int(input_data.get("max_installations") or package.get("max_installations", 1)))

    # The Platform Owner is the commercial control-plane identity and may not
    # exist in the customer users collection. The commercial invoice flow,
    # however, reuses the normal invoicing service and needs a valid User model
    # as its created_by/audit identity. Keep a non-loginable internal identity
    # record isolated from every customer company so invoice generation does
    # not depend on a customer administrator existing.
    created_by_id = str(created_by or "").strip()
    if created_by_id:
        from backend import dependencies as _dependencies
        from bson import ObjectId
        raw_db = getattr(_dependencies, "_raw_db", db)
        user_check_query = {"id": created_by_id}
        if ObjectId.is_valid(created_by_id):
            user_check_query = {"$or": [{"id": created_by_id}, {"_id": ObjectId(created_by_id)}]}
        internal_identity = await raw_db.users.find_one(user_check_query, {"_id": 1})
        if not internal_identity:
            await raw_db.users.insert_one({
                "id": created_by_id,
                "email": f"commercial-control+{created_by_id}@taskosphere.internal",
                "full_name": "Taskosphere Commercial Control Plane",
                "role": "admin",
                "password": None,
                "departments": [],
                "is_active": True,
                "status": "internal",
                "company_id": "__commercial_control_plane__",
                "company_name": "Taskosphere Commercial Control Plane",
                "approved_by": "system",
                "created_at": issued_at.isoformat(),
                "permissions": {},
                "is_internal_commercial_admin": True,
            })

    license_uid = await ensure_license_uid(db, licensee_uid)
    license_doc = {
        "id": f"lic-{uuid.uuid4().hex}",
        "license_uid": license_uid,
        "licensee_uid": licensee_uid,
        "license_key": await _generate_unique_key(),
        "customer_id": customer["id"],
        "customer_name": customer.get("admin_name") or customer["company_name"],
        "admin_name": customer.get("admin_name") or admin_name,
        "company_name": customer["company_name"],
        "package_id": package["id"],
        "package_code": package["code"],
        "package_name": package["name"],
        "modules": list(package.get("modules") or []),
        "status": "active",
        "issued_at": issued_at.isoformat(),
        "expires_at": None if validity_days == 0 else (issued_at + timedelta(days=validity_days)).isoformat(),
        "max_users": max_users,
        "max_installations": max_installations,
        "activations": [],
        "last_validated_at": None,
        "last_event_at": issued_at.isoformat(),
        "created_by": created_by,
    }
    await db.commercial_licenses.insert_one(dict(license_doc))

    try:
        from backend.email_service.service import email_service
        recipient_email = customer.get("email")
        if recipient_email:
            await email_service.send_template_email(
                to_email=recipient_email,
                template_code="LICENSE_CREATED",
                context={
                    "licensee_name": customer.get("admin_name") or customer.get("company_name") or "Valued Partner",
                    "company_name": customer.get("company_name") or "TaskoSphere",
                    "license_key": license_doc["license_key"],
                    "package_name": package.get("name") or "Enterprise",
                    "max_users": max_users,
                    "expiry_date": license_doc.get("expires_at", "Perpetual"),
                    "login_url": "https://taskosphere.com/login",
                },
                licensee_id=customer.get("id"),
            )
    except Exception as lic_err:
        logger.warning(f"Could not dispatch LICENSE_CREATED email: {lic_err}")

    return _public_license(license_doc)


async def update_license_status_record(license_id: str, new_status: str) -> Dict[str, Any]:
    if new_status not in {"active", "suspended", "revoked"}:
        raise HTTPException(status_code=400, detail="Invalid license status.")
    license_doc = await db.commercial_licenses.find_one({"id": license_id})
    if not license_doc:
        raise HTTPException(status_code=404, detail="License not found.")
    now = _now().isoformat()
    await db.commercial_licenses.update_one(
        {"id": license_id},
        {"$set": {"status": new_status, "last_event_at": now}},
    )
    # A suspended/revoked commercial entitlement must terminate every active
    # customer session immediately, including Manager/Staff accounts.
    if new_status in {"suspended", "revoked"}:
        try:
            from backend.security.session_manager import SessionManager
            raw_db = getattr(__import__("backend.dependencies", fromlist=["_raw_db"]), "_raw_db", db)
            customer_id = str(license_doc.get("customer_id") or "").strip()
            user_ids = set()
            if customer_id:
                rows = await raw_db.users.find(
                    {"commercial_customer_id": customer_id},
                    {"_id": 0, "id": 1},
                ).to_list(5000)
                user_ids.update(str(u.get("id") or "").strip() for u in rows if u.get("id"))
                company_rows = await raw_db.companies.find(
                    {"commercial_customer_id": customer_id},
                    {"_id": 0, "id": 1},
                ).to_list(5000)
                company_ids = [str(x.get("id") or "").strip() for x in company_rows if x.get("id")]
                if company_ids:
                    company_users = await raw_db.users.find(
                        {"company_id": {"$in": company_ids}},
                        {"_id": 0, "id": 1},
                    ).to_list(5000)
                    user_ids.update(str(u.get("id") or "").strip() for u in company_users if u.get("id"))
            license_users = await raw_db.users.find(
                {"license_id": license_id},
                {"_id": 0, "id": 1},
            ).to_list(5000)
            user_ids.update(str(u.get("id") or "").strip() for u in license_users if u.get("id"))
            for user_id in sorted(user_ids):
                await SessionManager.revoke_all_user_sessions(user_id, reason=f"license_{new_status}")
        except Exception:
            logger.exception("Failed to revoke customer sessions after license status change: %s", license_id)
    license_doc["status"] = new_status
    license_doc["last_event_at"] = now
    return _public_license(license_doc)


async def upgrade_license_record(license_id: str, package_id: str) -> Dict[str, Any]:
    license_doc = await db.commercial_licenses.find_one({"id": license_id})
    package = await _get_package(package_id)
    if not license_doc or not package or not package.get("active", True):
        raise HTTPException(status_code=404, detail="License or package not found.")
    now = _now().isoformat()
    updates = {
        "package_id": package["id"],
        "package_code": package["code"],
        "package_name": package["name"],
        "modules": list(package.get("modules") or []),
        "max_users": int(package.get("max_users", license_doc.get("max_users", 1))),
        "max_installations": int(package.get("max_installations", license_doc.get("max_installations", 1))),
        "last_event_at": now,
    }
    await db.commercial_licenses.update_one({"id": license_id}, {"$set": updates})
    license_doc.update(updates)
    return _public_license(license_doc)


async def save_package_record(package: Dict[str, Any], package_id: str) -> Dict[str, Any]:
    normalized = dict(package)
    normalized["id"] = package_id
    normalized["modules"] = list(normalized.get("modules") or [])
    normalized["max_users"] = max(1, int(normalized.get("max_users", 1)))
    normalized["max_installations"] = max(1, int(normalized.get("max_installations", 1)))
    normalized["validity_days"] = max(0, int(normalized.get("validity_days", 365)))
    normalized["active"] = bool(normalized.get("active", True))
    await db.commercial_license_packages.update_one(
        {"id": package_id}, {"$set": normalized}, upsert=True
    )
    normalized.pop("_id", None)
    return normalized


async def validate_license_record(license_key: str) -> Dict[str, Any]:
    license_doc = await _find_license(license_key)
    if not license_doc:
        return {"valid": False, "reason": "License not found"}
    reason = _expiry_reason(license_doc)
    if reason:
        return {"valid": False, "reason": reason, "license": _public_license(license_doc)}
    now = _now().isoformat()
    await db.commercial_licenses.update_one({"_id": license_doc["_id"]}, {"$set": {"last_validated_at": now}})
    license_doc["last_validated_at"] = now
    return {"valid": True, "license": _public_license(license_doc)}


async def activate_license_record(license_key: str, installation_id: str, installation_name: str = "Taskosphere Installation") -> Dict[str, Any]:
    license_doc = await _find_license(license_key)
    if not license_doc:
        raise HTTPException(status_code=404, detail="License not found.")
    reason = _expiry_reason(license_doc)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    installation_id = str(installation_id or "").strip()
    if not installation_id:
        raise HTTPException(status_code=400, detail="Installation ID is required.")

    now = _now().isoformat()
    activations = list(license_doc.get("activations") or [])
    existing = next((a for a in activations if a.get("installation_id") == installation_id), None)
    if existing:
        existing["last_seen_at"] = now
        existing["status"] = "active"
    else:
        active_count = sum(1 for a in activations if a.get("status") == "active")
        if active_count >= int(license_doc.get("max_installations", 1)):
            raise HTTPException(
                status_code=400,
                detail=f"Installation limit reached ({license_doc.get('max_installations', 1)}).",
            )
        existing = {
            "installation_id": installation_id,
            "installation_name": str(installation_name or "Taskosphere Installation"),
            "activated_at": now,
            "last_seen_at": now,
            "status": "active",
        }
        activations.append(existing)

    await db.commercial_licenses.update_one(
        {"_id": license_doc["_id"]},
        {"$set": {"activations": activations, "last_validated_at": now, "last_event_at": now}},
    )
    license_doc["activations"] = activations
    license_doc["last_validated_at"] = now
    license_doc["last_event_at"] = now
    return {"valid": True, "license": _public_license(license_doc), "activation": existing}


async def heartbeat_license_record(license_key: str, installation_id: str) -> Dict[str, Any]:
    license_doc = await _find_license(license_key)
    if not license_doc:
        return {"valid": False, "reason": "License not found"}
    reason = _expiry_reason(license_doc)
    if reason:
        return {"valid": False, "reason": reason}
    activation = next(
        (a for a in (license_doc.get("activations") or []) if a.get("installation_id") == installation_id and a.get("status") == "active"),
        None,
    )
    if not activation:
        return {"valid": False, "reason": "Installation is not activated"}
    now = _now().isoformat()
    activation["last_seen_at"] = now
    await db.commercial_licenses.update_one(
        {"_id": license_doc["_id"]},
        {"$set": {"activations": license_doc.get("activations") or [], "last_validated_at": now}},
    )
    license_doc["last_validated_at"] = now
    return {"valid": True, "license": _public_license(license_doc), "activation": activation}


async def revoke_installation_record(license_id: str, installation_id: str) -> Dict[str, Any]:
    license_doc = await db.commercial_licenses.find_one({"id": license_id})
    if not license_doc:
        raise HTTPException(status_code=404, detail="License not found.")
    activations = list(license_doc.get("activations") or [])
    activation = next((a for a in activations if a.get("installation_id") == installation_id), None)
    if not activation:
        raise HTTPException(status_code=404, detail="Installation not found.")
    activation["status"] = "revoked"
    activation["last_seen_at"] = _now().isoformat()
    await db.commercial_licenses.update_one({"id": license_id}, {"$set": {"activations": activations}})
    license_doc["activations"] = activations
    return _public_license(license_doc)


@router.get("/state")
async def get_license_state(current_user=Depends(require_admin())):
    return await list_license_state()


@router.post("/licenses", status_code=201)
async def create_license(payload: Dict[str, Any], current_user=Depends(require_admin())):
    return await create_license_record(payload, str(current_user.id))


@router.patch("/licenses/{license_id}/status")
async def update_license_status(license_id: str, payload: Dict[str, Any], current_user=Depends(require_admin())):
    return await update_license_status_record(license_id, payload.get("status"))


@router.patch("/licenses/{license_id}/package")
async def upgrade_license(license_id: str, payload: Dict[str, Any], current_user=Depends(require_admin())):
    return await upgrade_license_record(license_id, str(payload.get("package_id") or ""))


@router.put("/packages/{package_id}")
async def save_package(package_id: str, payload: Dict[str, Any], current_user=Depends(require_admin())):
    return await save_package_record(payload, package_id)


@router.post("/licenses/{license_id}/installations/{installation_id}/revoke")
async def revoke_installation(license_id: str, installation_id: str, current_user=Depends(require_admin())):
    return await revoke_installation_record(license_id, installation_id)


@router.post("/validate")
async def validate_license(payload: Dict[str, Any]):
    return await validate_license_record(payload.get("license_key"))


@router.post("/activate")
async def activate_license(payload: Dict[str, Any]):
    return await activate_license_record(
        payload.get("license_key"), payload.get("installation_id"), payload.get("installation_name")
    )


@router.post("/installation-activate")
async def installation_activate(payload: Dict[str, Any]):
    return await activate_license_record(
        payload.get("license_key"), payload.get("installation_id"), payload.get("installation_name")
    )


@router.post("/heartbeat")
async def heartbeat_license(payload: Dict[str, Any]):
    result = await heartbeat_license_record(payload.get("license_key"), payload.get("installation_id"))
    return result


@router.get("/status")
async def local_license_status():
    """Compatibility endpoint for the legacy local licensing client."""
    license_key = str(os.getenv("TASKOSPHERE_LICENSE_KEY") or "").strip()
    installation_id = str(os.getenv("TASKOSPHERE_INSTALLATION_ID") or "").strip()
    if not license_key or not installation_id:
        return {"valid": True, "enforcement_enabled": False, "reason": "Central activation is used by this deployment."}
    return await heartbeat_license_record(license_key, installation_id)


# Kept as a shared helper for the Python replacement of the old Node runtime.
def module_for_api_path(pathname: str) -> Optional[str]:
    value = str(pathname or "").replace("/api", "", 1).lstrip("/")
    if value.startswith(("tasks", "todos", "attendance", "reminders", "action-center", "visits", "ai-reader", "dashboard")):
        return "TASKS"
    if value.startswith(("invoicing", "invoices")):
        return "INVOICING"
    if value.startswith(("purchase", "purchase-invoices", "bank-accounts", "bank-transactions", "chart-of-accounts", "journal-entries", "accounting-reports", "zero-touch-entry", "gst-portal-sync", "accounting-integrity", "day-book", "cash-bank-book", "cash-flow", "outstanding-report", "bank-reconciliation", "depreciation", "tds-tcs", "financial-ratios", "comparative-report", "yearly-report", "opening-balances", "accounting-audit-trail", "bulk-import")):
        return "ACCOUNTING"
    if value.startswith(("leave", "payroll", "hr", "recruitment", "people-matrix", "staff-activity", "users")):
        return "HRMS"
    return None
