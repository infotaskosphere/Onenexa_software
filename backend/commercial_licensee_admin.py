"""Commercial Licensee Admin Management.

The email recorded on a commercial license is the default administrator for
that license. It receives normal admin rights inside the licensed tenant, but
those rights are hard-capped by the modules/features actually present on the
active license.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from passlib.context import CryptContext
from fastapi import HTTPException

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.identity_hierarchy import ensure_licensee_uid, ensure_license_uid, ensure_user_uid
from backend.models import DEFAULT_ROLE_PERMISSIONS, User
from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

logger = logging.getLogger("commercial_licensee_admin")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

LICENSE_MODULE_ALIASES = {
    "tasks": "taskosphere",
    "taskosphere": "taskosphere",
    "invoicing": "finix",
    "accounting": "finix",
    "finix": "finix",
    "hrms": "people_matrix",
    "people_matrix": "people_matrix",
    "people-matrix": "people_matrix",
    "compliance": "compliance",
    "records": "records",
    "proposals": "proposals",
    "client_proposals": "proposals",
    "client-proposals": "proposals",
    "leadsense": "proposals",
    "aiweave": "aiweave",
    "ai-weave": "aiweave",
}

# These legacy permissions are still consumed by older pages/components. They
# must be reset together with the centralized page flags, otherwise an admin
# permission such as can_manage_invoices can accidentally keep an unselected
# commercial page visible. The commercial license is the cap; role=admin must
# never restore one of these flags after the cap is applied.
COMMERCIAL_LEGACY_PAGE_FLAGS = {
    "can_manage_invoices",
    "can_create_quotations",
    "can_view_clients",
    "can_view_all_clients",
    "can_edit_clients",
    "can_approve_clients",
    "can_view_all_leads",
    "can_view_passwords",
    "can_edit_passwords",
    "can_approve_whatsapp_wishes",
    "can_approve_email_wishes",
}


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def resolve_license_modules(license_doc: Dict[str, Any]) -> set[str]:
    resolved: set[str] = set()
    for raw in license_doc.get("modules") or license_doc.get("licensed_modules") or []:
        key = str(raw).strip().lower()
        mapped = LICENSE_MODULE_ALIASES.get(key)
        if mapped:
            resolved.add(mapped)
    return resolved


def normalize_license_selected_features(
    license_doc: Optional[Dict[str, Any]],
) -> Dict[str, list[str]]:
    """Normalize commercial feature selections, including legacy numeric counts.

    Older license documents stored the number of selected pages per module
    instead of the actual page-flag list. Those counts in the current data are
    full-module counts (for example 9/9, 10/10, 4/4). Rehydrate such records
    to the canonical page-flag representation so authentication, API guards
    and the frontend all evaluate the same entitlement.
    """
    if not isinstance(license_doc, dict):
        return {}

    licensed_modules = resolve_license_modules(license_doc)
    raw = license_doc.get("selected_features")
    if not isinstance(raw, dict):
        raw = {}

    aliases = {
        "taskosphere": {"taskosphere", "tasks"},
        "finix": {"finix", "invoicing", "accounting"},
        "compliance": {"compliance"},
        "records": {"records"},
        "proposals": {"proposals", "client_proposals", "client-proposals", "leadsense"},
        "people_matrix": {"people_matrix", "people-matrix", "hrms", "peoplematrix"},
        "aiweave": {"aiweave", "ai-weave"},
    }

    normalized: Dict[str, list[str]] = {}

    for module_id in licensed_modules:
        module_def = MODULE_HIERARCHY.get(module_id, {})
        all_flags = [
            str(page.get("flag")).strip()
            for page in module_def.get("pages", []) or []
            if page.get("flag")
        ]

        values = raw.get(module_id)
        if values is None:
            accepted = {
                str(alias).strip().lower().replace("-", "_")
                for alias in aliases.get(module_id, {module_id})
            }
            for raw_key, candidate in raw.items():
                if str(raw_key).strip().lower().replace("-", "_") in accepted:
                    values = candidate
                    break

        # Page-selective commercial licenses are fail-closed. A missing module
        # entry or an explicitly empty page list means the Platform Owner did
        # not grant any page in that module.
        if values is None or (
            isinstance(values, (list, tuple, set)) and len(values) == 0
        ):
            normalized[module_id] = []
            continue

        # Legacy commercial records sometimes persisted only the selected-page
        # count. A count equal to the module's complete page count is safely
        # equivalent to selecting every page. A smaller count cannot identify
        # which pages were selected, so fail closed for that module.
        if isinstance(values, (int, float)) and not isinstance(values, bool):
            count = int(values)
            normalized[module_id] = list(all_flags) if count >= len(all_flags) else []
            continue

        if isinstance(values, str) and values.strip().isdigit():
            count = int(values.strip())
            normalized[module_id] = list(all_flags) if count >= len(all_flags) else []
            continue

        if not isinstance(values, (list, tuple, set)):
            normalized[module_id] = []
            continue

        selected = []
        allowed = set(all_flags)
        for flag in values:
            flag = str(flag).strip()
            if flag in allowed and flag not in selected:
                selected.append(flag)

        normalized[module_id] = selected

    return normalized


def get_all_admin_permissions(license_doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return tenant-admin permissions capped by the active license's module/page selections.

    Both module and page access come from the Platform Owner's explicit
    `modules` and `selected_features` selections. A purchased module alone
    never grants every page in that module. The same ceiling is applied to
    Manager/Staff accounts.

    The reset of legacy aliases below is intentional. Several existing UI/API
    paths predate MODULE_HIERARCHY and still inspect flags such as
    can_manage_invoices. Leaving the admin defaults intact would silently
    re-open pages that belong to a module not on the license at all.
    """
    if license_doc is None:
        admin_perms = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
        admin_perms["can_access_whatsapp_hub"] = True
        return admin_perms

    permissions = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
    licensed_modules = resolve_license_modules(license_doc)
    selected_features = normalize_license_selected_features(
        license_doc
    )

    # Start from the internal admin template, then hard-cap every commercial
    # operational page. This preserves tenant-admin control-plane privileges
    # while making the six licensed modules fail closed by default.
    for flag in COMMERCIAL_LEGACY_PAGE_FLAGS:
        permissions[flag] = False
    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        module_flag = module_def.get("flag")
        if module_flag:
            permissions[module_flag] = False
        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if flag:
                permissions[flag] = False

    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        module_allowed = module_id in licensed_modules
        module_flag = module_def.get("flag")
        if module_flag:
            # AIWeave is licensed separately but never auto-granted to the
            # tenant admin. The admin must explicitly enable the module AND
            # page through Permission Matrix / Access Governance.
            permissions[module_flag] = module_allowed

        # The licensee admin is also capped by the Platform Owner page
        # selections. Manager/Staff permissions can only further reduce access.
        if module_allowed:
            # A purchased module is only the ceiling. The Platform Owner's
            # selected_features is the source of truth for which pages the
            # licensee administrator may see and access.
            selected = set(selected_features.get(module_id) or [])
        else:
            selected = set()
        # No module has a special bypass. AIWeave follows the same explicit
        # Platform Owner module/page selection rule as every other module.
        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if flag:
                permissions[flag] = bool(module_allowed and flag in selected)

        # Compatibility mappings for legacy screens. These are derived from
        # the same selected page flags; they are not independent entitlements.
        if module_id == "finix":
            permissions["can_manage_invoices"] = bool(module_allowed and "can_view_sale" in selected)
        elif module_id == "records":
            permissions["can_view_clients"] = bool(module_allowed and "can_view_all_clients" in selected)
            permissions["can_edit_clients"] = bool(module_allowed and "can_edit_clients" in selected)
            permissions["can_approve_clients"] = bool(module_allowed and "can_approve_clients" in selected)
            permissions["can_view_passwords"] = bool(module_allowed and "can_view_passwords" in selected)
            permissions["can_edit_passwords"] = bool(module_allowed and "can_edit_passwords" in selected)
            permissions["can_approve_whatsapp_wishes"] = bool(module_allowed and "can_approve_whatsapp_wishes" in selected)
            permissions["can_approve_email_wishes"] = bool(module_allowed and "can_approve_email_wishes" in selected)
        elif module_id == "proposals":
            permissions["can_view_all_leads"] = bool(module_allowed and "can_view_all_leads" in selected)
            permissions["can_create_quotations"] = bool(module_allowed and "can_create_quotations" in selected)

    return permissions


def get_tenant_user_permissions(
    admin_user: Optional[User],
    license_doc: Dict[str, Any],
    role: str,
    existing_permissions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a tenant user's permissions from the licensee admin's effective access.

    Commercial tenant users may never exceed the tenant administrator. A newly
    created user inherits the admin's effective licensed module/page access;
    an existing user keeps their explicit grants but is capped to whatever the
    admin currently has. Admin/control-plane permissions are NOT copied.
    """
    base = dict(DEFAULT_ROLE_PERMISSIONS.get(str(role or "staff").lower(), DEFAULT_ROLE_PERMISSIONS["staff"]))
    current = dict(existing_permissions or {})
    if admin_user is not None:
        raw = getattr(admin_user, "permissions", {}) or {}
        admin_perms = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw)
    else:
        # During authentication, derive the tenant-admin ceiling from the
        # active license's explicit module/page selections.
        admin_perms = get_all_admin_permissions(license_doc)

    licensed = resolve_license_modules(license_doc)
    has_existing = existing_permissions is not None
    matrix = dict(current.get("governance_matrix") or {}) if has_existing else {}
    admin_matrix = dict(admin_perms.get("governance_matrix") or {})

    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        module_flag = module_def.get("flag")
        module_allowed = module_id in licensed
        if module_id == "aiweave":
            module_allowed = module_allowed and bool(admin_perms.get("can_access_aiweave", False))
        admin_module_on = bool(admin_perms.get(module_flag, False)) if module_flag else False
        user_module_on = bool(current.get(module_flag, False)) if has_existing and module_flag else admin_module_on
        effective_module_on = bool(module_allowed and admin_module_on and (user_module_on if has_existing else True))
        if module_flag:
            base[module_flag] = effective_module_on

        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if not flag:
                continue
            admin_page_on = bool(admin_perms.get(flag, False))
            user_page_on = bool(current.get(flag, False)) if has_existing else admin_page_on
            base[flag] = bool(effective_module_on and admin_page_on and (user_page_on if has_existing else True))

            key = f"{module_id}.{flag}"
            if not base[flag]:
                matrix.pop(key, None)
            elif has_existing:
                existing_actions = current.get("governance_matrix", {}).get(key)
                admin_actions = admin_matrix.get(key)
                if isinstance(existing_actions, list) and isinstance(admin_actions, list):
                    matrix[key] = [a for a in existing_actions if a in admin_actions]
                elif isinstance(existing_actions, list):
                    matrix[key] = list(existing_actions)
                elif isinstance(admin_actions, list):
                    matrix[key] = list(admin_actions)
            elif isinstance(admin_matrix.get(key), list):
                matrix[key] = list(admin_matrix[key])

    # Legacy commercial flags are still consumed by older endpoints. They are
    # capped to the admin in exactly the same way as the canonical page flags.
    for flag in COMMERCIAL_LEGACY_PAGE_FLAGS:
        admin_on = bool(admin_perms.get(flag, False))
        user_on = bool(current.get(flag, False)) if has_existing else admin_on
        base[flag] = bool(admin_on and (user_on if has_existing else True))

    base["governance_matrix"] = matrix
    return base



async def sync_user_to_licensee_admin(
    user: User,
    license_doc: Dict[str, Any],
) -> User:
    """Apply the current commercial license ceiling without overwriting
    explicit Licensee Admin Permission Matrix decisions."""
    if str(getattr(user, "role", "") or "").strip().lower() == "admin":
        return user

    raw_db = _raw_db()
    stored = await raw_db.users.find_one(
        {"id": str(user.id)},
        {
            "_id": 0,
            "permissions": 1,
            "permissions_inherited_from_licensee_admin": 1,
        },
    )

    stored_permissions = (stored or {}).get("permissions")
    if hasattr(stored_permissions, "model_dump"):
        stored_permissions = stored_permissions.model_dump()
    if not isinstance(stored_permissions, dict):
        stored_permissions = {}

    marker = (stored or {}).get("permissions_inherited_from_licensee_admin")
    has_explicit_matrix = bool(stored_permissions)

    # Once the licensee admin has explicitly written a Permission Matrix
    # payload, that payload is authoritative for Manager/Staff. Never replace it
    # with role defaults or license-wide grants on login.
    if has_explicit_matrix:
        effective = get_tenant_user_permissions(
            None,
            license_doc,
            str(getattr(user, "role", "staff") or "staff"),
            stored_permissions,
        )
        data = user.model_dump()
        data["permissions"] = effective
        data["permissions_inherited_from_licensee_admin"] = False
        data["licensed_modules"] = list(
            license_doc.get("modules") or license_doc.get("licensed_modules") or []
        )
        data["selected_features"] = normalize_license_selected_features(license_doc)
        return User.model_validate(data)

    # True legacy records with no stored permission map are initialized once
    # from the licensee administrator's effective licensed access.
    permissions = get_tenant_user_permissions(
        None,
        license_doc,
        str(getattr(user, "role", "staff") or "staff"),
        None,
    )
    data = user.model_dump()
    data["permissions"] = permissions
    data["permissions_inherited_from_licensee_admin"] = True
    data["licensed_modules"] = list(
        license_doc.get("modules") or license_doc.get("licensed_modules") or []
    )
    data["selected_features"] = normalize_license_selected_features(license_doc)
    await raw_db.users.update_one(
        {"id": str(user.id)},
        {"$set": {
            "permissions": permissions,
            "permissions_inherited_from_licensee_admin": True,
            "licensed_modules": data["licensed_modules"],
            "selected_features": data["selected_features"],
        }},
    )
    return User.model_validate(data)


async def ensure_licensee_admin(
    customer: Dict[str, Any],
    license_doc: Dict[str, Any],
    company: Dict[str, Any],
    password: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    raw_db = _raw_db()
    email = str(customer.get("email") or "").strip().lower()
    if not email:
        return None

    company_id = str(company.get("id") or customer.get("id") or "").strip()
    company_name = str(company.get("name") or customer.get("company_name") or "Licensed Company").strip()
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "").strip()
    license_id = str(license_doc.get("id") or "").strip()
    license_key = str(license_doc.get("license_key") or "").strip()
    licensee_uid = str(customer.get("licensee_uid") or license_doc.get("licensee_uid") or company.get("licensee_uid") or "").strip()
    if not licensee_uid:
        licensee_uid = await ensure_licensee_uid(raw_db, customer_id, customer)
    await raw_db.commercial_license_customers.update_one(
        {"id": customer_id},
        {"$set": {"licensee_uid": licensee_uid, "identity_type": "licensee"}},
    )
    license_uid = await ensure_license_uid(raw_db, licensee_uid, license_doc)
    licensed_modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    selected_features = normalize_license_selected_features(
        license_doc
    )
    admin_permissions = get_all_admin_permissions(license_doc)
    now_iso = datetime.now(timezone.utc).isoformat()

    existing_user = await raw_db.users.find_one(
        {
            "$or": [
                {"identity_org_uid": licensee_uid, "email_normalized": email},
                {"identity_org_uid": licensee_uid, "email": email},
                {"licensee_uid": licensee_uid, "email_normalized": email},
                {"licensee_uid": licensee_uid, "email": email},
                {"commercial_customer_id": customer_id, "email_normalized": email},
                {"commercial_customer_id": customer_id, "email": email},
            ],
            "status": {"$ne": "deleted"},
        }
    )

    # Never re-purpose an existing account merely because a commercial license
    # carries the same email address. This was a serious tenant-isolation edge
    # case: if a Platform Owner or another company's user used that email, the
    # old code silently moved that account into the new licensee tenant. It also
    # made the two identities share the same single-session key, so logging into
    # one could legitimately replace the other session.
    if existing_user:
        existing_company = str(existing_user.get("company_id") or "").strip()
        existing_customer = str(existing_user.get("commercial_customer_id") or "").strip()
        existing_is_owner = False
        try:
            existing_is_owner = is_platform_owner(existing_user)
        except Exception:
            existing_is_owner = False
        same_tenant = (
            not existing_is_owner
            and (
                (existing_company and existing_company == company_id)
                or (existing_customer and existing_customer == customer_id)
            )
        )
        if not same_tenant:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The license administrator email already belongs to another account. "
                    "Use a unique administrator email for this licensed company."
                ),
            )

    update_fields = {
        "role": "admin",
        "company_id": company_id,
        "company_name": company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_id,
        "license_key": license_key,
        "licensee_uid": licensee_uid,
        "identity_org_uid": licensee_uid,
        "identity_type": "licensee_admin",
        "email_normalized": email,
        "license_uid": license_uid,
        "licensed_modules": licensed_modules,
        "selected_features": selected_features,
        "permissions": admin_permissions,
    }

    if existing_user:
        # Preserve an already-established administrator login. If the existing
        # record is only the license-issued placeholder, keep it pending until
        # the licensee explicitly chooses credentials.
        if password and len(password) >= 6:
            update_fields["password"] = pwd_context.hash(password)
            update_fields["status"] = "active"
            update_fields["is_active"] = True
            update_fields["admin_credentials_pending"] = False
            update_fields["approved_by"] = "commercial-license"
            update_fields["approved_at"] = now_iso
        elif not existing_user.get("password"):
            update_fields["status"] = "pending_admin_setup"
            update_fields["is_active"] = False
            update_fields["admin_credentials_pending"] = True
        await raw_db.users.update_one({"_id": existing_user.get("_id")}, {"$set": update_fields})
        updated = await raw_db.users.find_one({"_id": existing_user.get("_id")}, {"_id": 0, "password": 0})
        logger.info("Updated licensee admin %s for customer %s/license %s", email, customer_id, license_id)
        return updated

    # License issuance creates the tenant administrator identity, but it must
    # not silently create a usable login or assign a shared/default password.
    # The licensee will complete the credentials from the public license setup
    # screen through /create-admin.
    credentials_pending = not (password and len(password) >= 6)
    user_uid = await ensure_user_uid(
        raw_db,
        {"id": str(uuid.uuid4()), "email": email},
        organization_uid=licensee_uid,
        identity_type="licensee_admin",
    )
    user_doc = {
        "id": str(uuid.uuid4()),
        "user_uid": user_uid,
        "email": email,
        "full_name": customer.get("contact_name") or f"{company_name} Admin",
        "role": "admin",
        "password": pwd_context.hash(password) if password and len(password) >= 6 else None,
        "permissions": admin_permissions,
        "departments": [],
        "phone": customer.get("phone"),
        "is_active": not credentials_pending,
        "status": "pending_admin_setup" if credentials_pending else "active",
        "admin_credentials_pending": credentials_pending,
        "approved_by": "commercial-license" if not credentials_pending else None,
        "approved_at": now_iso if not credentials_pending else None,
        "created_at": now_iso,
        "company_id": company_id,
        "company_name": company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_id,
        "license_key": license_key,
        "licensee_uid": licensee_uid,
        "identity_org_uid": licensee_uid,
        "identity_type": "licensee_admin",
        "email_normalized": email,
        "license_uid": license_uid,
        "licensed_modules": licensed_modules,
        "selected_features": selected_features,
        "permissions_inherited_from_licensee_admin": True,
    }
    try:
        await raw_db.users.insert_one(user_doc)
        logger.info("Created licensee admin %s for customer %s/license %s", email, customer_id, license_id)
        return {k: v for k, v in user_doc.items() if k not in {"password", "_id"}}
    except Exception as exc:
        logger.warning("Failed to insert licensee admin %s: %s", email, exc)
        return None


async def sync_all_licensee_admins() -> int:
    """Repair/synchronize every commercial license contact to its active license."""
    raw_db = _raw_db()
    count = 0
    try:
        customers = await raw_db.commercial_license_customers.find({}, {"_id": 0}).to_list(500)
        for customer in customers:
            customer_id = str(customer.get("id") or "").strip()
            email = str(customer.get("email") or "").strip()
            if not customer_id or not email:
                continue
            license_doc = await raw_db.commercial_licenses.find_one(
                {"customer_id": customer_id, "status": "active"},
                {"_id": 0},
                sort=[("issued_at", -1)],
            )
            if not license_doc:
                continue
            expires_at = license_doc.get("expires_at")
            if expires_at:
                try:
                    expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
                    if expiry.tzinfo is None:
                        expiry = expiry.replace(tzinfo=timezone.utc)
                    if expiry <= datetime.now(timezone.utc):
                        continue
                except Exception:
                    continue

            company = await raw_db.companies.find_one(
                {"$or": [{"commercial_customer_id": customer_id}, {"id": customer_id}]},
                {"_id": 0},
            )
            if not company:
                company = {"id": customer_id, "name": customer.get("company_name") or "Licensed Company", "commercial_customer_id": customer_id, "source": "commercial-license"}

            if await ensure_licensee_admin(customer, license_doc, company):
                count += 1
    except Exception as exc:
        logger.warning("sync_all_licensee_admins encountered an issue: %s", exc)
    return count
