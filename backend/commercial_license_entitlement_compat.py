"""License-authoritative entitlement hydration for commercial customer admins.

This compatibility layer patches the existing authentication function *in place*
so every FastAPI dependency that already captured ``get_current_user`` sees the
same commercial-license hydration after login and hard refresh. No second auth
path is introduced.

Module selection and page selection are independent: a purchased module only
sets the module switch; individual page permissions come exclusively from the
license ``selected_features`` map.
"""
from __future__ import annotations

import types
from datetime import datetime, timezone
from typing import Any

from backend import dependencies as _dependencies
from backend.commercial_licensee_admin import get_all_admin_permissions
from backend.platform_owner import is_platform_owner


def _is_admin_role(user: Any) -> bool:
    """Handle both string and UserRole enum representations of the admin role."""
    role = getattr(user, "role", "")
    value = getattr(role, "value", None)
    name = getattr(role, "name", None)
    candidates = [value, name, role]

    for candidate in candidates:
        normalized = str(candidate or "").strip().lower()

        if normalized == "admin" or normalized.endswith(".admin"):
            return True

    return False


def _raw_db():
    return getattr(
        _dependencies,
        "_raw_db",
        _dependencies.db,
    )


def _aware(value: Any):
    if not value:
        return None

    if isinstance(value, datetime):
        return (
            value
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )

    try:
        parsed = datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        )

        return (
            parsed
            if parsed.tzinfo
            else parsed.replace(tzinfo=timezone.utc)
        )

    except Exception:
        return None


async def _resolve_customer_id(user: Any) -> str | None:
    direct = str(
        getattr(
            user,
            "commercial_customer_id",
            "",
        )
        or ""
    ).strip()

    if direct:
        return direct

    license_id = str(
        getattr(
            user,
            "license_id",
            "",
        )
        or ""
    ).strip()

    db = _raw_db()

    if license_id:
        license_doc = await db.commercial_licenses.find_one(
            {"id": license_id},
            {
                "_id": 0,
                "customer_id": 1,
            },
        )

        customer_id = str(
            (license_doc or {}).get("customer_id")
            or ""
        ).strip()

        if customer_id:
            return customer_id

    company_id = str(
        getattr(
            user,
            "company_id",
            "",
        )
        or ""
    ).strip()

    if not company_id:
        return None

    company = await db.companies.find_one(
        {"id": company_id},
        {
            "_id": 0,
            "commercial_customer_id": 1,
            "license_id": 1,
        },
    )

    if not company:
        return None

    customer_id = str(
        company.get("commercial_customer_id")
        or ""
    ).strip()

    if customer_id:
        return customer_id

    license_id = str(
        company.get("license_id")
        or ""
    ).strip()

    if license_id:
        license_doc = await db.commercial_licenses.find_one(
            {"id": license_id},
            {
                "_id": 0,
                "customer_id": 1,
            },
        )

        customer_id = str(
            (license_doc or {}).get("customer_id")
            or ""
        ).strip()

        return customer_id or None

    return None


async def _active_license(
    customer_id: str,
    license_id: str | None = None,
    company_license_id: str | None = None,
) -> dict[str, Any] | None:
    """Resolve the tenant current active license.

    The company/tenant license link is authoritative. A user license_id may
    point to a historical license after a Commercial Console update.
    """
    db = _raw_db()
    now = datetime.now(timezone.utc)

    async def _valid(
        doc: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not doc or doc.get("status") not in {
            "active",
            "trial",
        }:
            return None

        expires = _aware(
            doc.get("expires_at")
        )

        if expires and expires <= now:
            return None

        return doc

    if company_license_id:
        doc = await db.commercial_licenses.find_one(
            {"id": company_license_id},
            {"_id": 0},
        )

        valid = await _valid(doc)

        if valid:
            return valid

    if license_id:
        doc = await db.commercial_licenses.find_one(
            {"id": license_id},
            {"_id": 0},
        )

        valid = await _valid(doc)

        if valid:
            return valid

    if not customer_id:
        return None

    docs = await db.commercial_licenses.find(
        {
            "customer_id": customer_id,
            "status": {
                "$in": [
                    "active",
                    "trial",
                ]
            },
        },
        {
            "_id": 0,
        },
    ).sort(
        "issued_at",
        -1,
    ).limit(20).to_list(20)

    for doc in docs:
        valid = await _valid(doc)

        if valid:
            return valid

    return None


async def _hydrate(user: Any):
    if is_platform_owner(user):
        return user

    customer_id = await _resolve_customer_id(
        user
    )

    license_id = str(
        getattr(
            user,
            "license_id",
            "",
        )
        or ""
    ).strip() or None

    company_license_id = None

    company_id = str(
        getattr(
            user,
            "company_id",
            "",
        )
        or ""
    ).strip()

    if company_id:
        company = await _raw_db().companies.find_one(
            {"id": company_id},
            {
                "_id": 0,
                "commercial_customer_id": 1,
                "license_id": 1,
            },
        )

        company_license_id = str(
            (company or {}).get("license_id")
            or ""
        ).strip() or None

        if not customer_id:
            customer_id = str(
                (company or {}).get(
                    "commercial_customer_id"
                )
                or ""
            ).strip() or None

    if (
        not customer_id
        and not license_id
        and not company_license_id
    ):
        return user

    license_doc = await _active_license(
        customer_id or "",
        license_id,
        company_license_id,
    )

    if not license_doc:
        return user

    from backend.commercial_licensee_admin import resolve_license_modules
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    modules = list(
        license_doc.get("modules")
        or license_doc.get("licensed_modules")
        or []
    )

    data = user.model_dump()

    data["commercial_customer_id"] = (
        customer_id
        or str(
            license_doc.get("customer_id")
            or ""
        ).strip()
        or None
    )

    data["license_id"] = license_doc.get("id")
    data["license_key"] = license_doc.get("license_key")
    data["licensed_modules"] = modules

    data["selected_features"] = (
        license_doc.get("selected_features")
        or {}
    )

    if _is_admin_role(user):
        data["permissions"] = get_all_admin_permissions(
            license_doc
        )
    else:
        # Non-admin user: preserve explicit permissions permitted by the licensee admin,
        # capping only to modules present in the commercial license.
        current_perms = dict(data.get("permissions") or {})
        licensed_mods = resolve_license_modules(license_doc)
        for mod_key, mod_def in MODULE_HIERARCHY.items():
            if mod_key != "admin" and mod_key not in licensed_mods:
                mod_flag = mod_def.get("flag")
                if mod_flag:
                    current_perms[mod_flag] = False
                for p in mod_def.get("pages", []):
                    p_flag = p.get("flag")
                    if p_flag:
                        current_perms[p_flag] = False
        data["permissions"] = current_perms

    return type(user).model_validate(
        data
    )


def install() -> None:
    current = _dependencies.get_current_user

    if getattr(
        _dependencies,
        "_commercial_entitlement_patch_installed",
        False,
    ):
        return

    base = types.FunctionType(
        current.__code__,
        current.__globals__,
        current.__name__,
        current.__defaults__,
        current.__closure__,
    )

    base.__kwdefaults__ = current.__kwdefaults__

    target_globals = current.__globals__

    target_globals[
        "_commercial_entitlement_base_get_current_user"
    ] = base

    target_globals[
        "_commercial_entitlement_hydrate"
    ] = _hydrate

    target_globals[
        "_commercial_entitlement_patch_installed"
    ] = True

    async def _patched_get_current_user(
        credentials,
    ):
        user = await _commercial_entitlement_base_get_current_user(
            credentials
        )

        try:
            return await _commercial_entitlement_hydrate(
                user
            )
        except Exception:
            return user

    current.__code__ = _patched_get_current_user.__code__
    current.__kwdefaults__ = (
        _patched_get_current_user.__kwdefaults__
    )


install()
