"""Tenant-level commercial entitlement guard.

A commercial licensee contact is a normal application administrator inside its
own licensed customer tenant. The administrator bypasses per-user governance,
but never bypasses the commercial license boundary itself. Module access and
page access are independent: a purchased module does not imply access to every
page in that module.
"""
import logging
from typing import Optional, Tuple

from fastapi import Depends, HTTPException, Request

from backend import dependencies as _dependencies
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.commercial_licensee_admin import resolve_license_modules, get_all_admin_permissions

_BASE_GET_CURRENT_USER = _dependencies.get_current_user
logger = logging.getLogger("commercial_module_guard")


def _is_admin_role(user: User) -> bool:
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


def _deny(request: Request, user: User, detail: str, license_doc: Optional[dict] = None, effective_pages=None) -> HTTPException:
    """Build a 403 and log exactly WHY, so a licensee lock-out is diagnosable from
    the server log alone (previously the log only said "403 Forbidden")."""
    try:
        logger.warning(
            "403 %s %s | user=%s role=%s company_id=%s license_id=%s | licensed_modules=%s | selected_features=%s | effective_pages=%s | reason=%s",
            request.method,
            request.url.path,
            getattr(user, "email", None),
            getattr(user, "role", None),
            getattr(user, "company_id", None),
            (license_doc or {}).get("id"),
            sorted(resolve_license_modules(license_doc)) if license_doc else None,
            {k: len(v) if isinstance(v, (list, tuple, set)) else v for k, v in ((license_doc or {}).get("selected_features") or {}).items()},
            effective_pages,
            detail,
        )
    except Exception:
        pass

    return HTTPException(status_code=403, detail=detail)


MODULE_PREFIXES = {
    "taskosphere": (
        "/tasks",
        "/todos",
        "/todo",
        "/attendance",
        "/reminders",
        "/action-center",
        "/visits",
        "/client-portal-manager",
    ),
    "finix": (
        "/finix-dashboard",
        "/invoicing",
        "/purchase",
        "/bank-accounts",
        "/chart-of-accounts",
        "/journal-entries",
        "/accounting-reports",
        "/zero-touch-entry",
        "/gst-portal-sync",
        "/accounting-integrity",
        "/day-book",
        "/cash-bank-book",
        "/cash-flow",
        "/outstanding-report",
        "/bank-reconciliation",
        "/depreciation",
        "/tds-tcs",
        "/financial-ratios",
        "/comparative-report",
        "/yearly-report",
        "/opening-balances",
        "/accounting-audit-trail",
        "/bulk-import",
        "/due-dates",
        "/import-invoices",
        "/reports/day-book",
        "/reports/journal-register",
        "/reports/cash-bank-book",
        "/reports/cash-flow",
        "/reports/outstanding",
        "/reports/financial-ratios",
        "/reports/comparative",
        "/reports/yearly",
        "/reports/trial-balance",
        "/reports/profit-loss",
        "/reports/balance-sheet",
        "/reports/mis-compliance",
        "/reports/parties",
        "/reports/party-ledger",
        "/reports/validation-engine",
        "/reports/ledger-by-code",
        "/reports/finix-dashboard",
    ),
    "compliance": (
        "/compliance-dashboard",
        "/compliance",
        "/gst-reconciliation",
        "/trademark-sphere",
        "/mis-report",
        "/salary-slips",
        "/roc-sphere",
    ),
    "records": (
        "/records-dashboard",
        "/client-approvals",
        "/dsc",
        "/documents",
        "/clients",
        "/passwords",
    ),
    "proposals": (
        "/client-proposals-dashboard",
        "/leads",
        "/quotations",
        "/client-discussion",
    ),
    "aiweave": (
        "/ai",
        "/aiweave",
        "/ai-reader",  # legacy URL; still AIWeave, never Taskosphere
    ),
    "people_matrix": (
        "/people-matrix",
        "/users",
        "/leave",
        "/payroll",
        "/hr",
        "/recruitment",
        "/performance",
    ),
}


FEATURE_PREFIXES = {
    "taskosphere": {
        "can_view_dashboard": ("/dashboard",),
        "can_view_tasks": ("/tasks",),
        "can_view_todo_dashboard": ("/todos", "/todo"),
        "can_view_attendance": ("/attendance",),
        "can_view_reminders": ("/reminders",),
        "can_view_action_center": ("/action-center",),
        "can_view_client_visits": ("/visits",),
        "can_view_client_portal": ("/client-portal-manager",),
        "can_reset_client_passwords": (
            "/client-portal-manager/password",
            "/client-portal-manager/reset",
        ),
    },
    "finix": {
        "can_view_accounting_reports": (
            "/finix-dashboard",
            "/reports/profit-loss",
            "/reports/balance-sheet",
            "/reports/trial-balance",
            "/reports/validation-engine",
            "/reports/finix-dashboard",
        ),
        "can_view_sale": (
            "/invoicing",
            "/sales",
            "/invoices",
        ),
        "can_view_purchase": (
            "/purchase",
            "/purchase-invoices",
        ),
        "can_view_bank": (
            "/bank-accounts",
        ),
        "can_view_chart_of_accounts": (
            "/chart-of-accounts",
        ),
        "can_manage_chart_of_accounts": (
            "/chart-of-accounts/manage",
        ),
        "can_view_journal_entries": (
            "/journal-entries",
        ),
        "can_post_journal_entries": (
            "/journal-entries/post",
            "/zero-touch-entry",
        ),
        "can_match_bank": (
            "/bank-reconciliation",
        ),
    },
    "compliance": {
        "can_view_compliance": (
            "/compliance-dashboard",
            "/compliance",
        ),
        "can_manage_compliance": (
            "/compliance/manage",
        ),
        "can_view_gst_reconciliation": (
            "/gst-reconciliation",
        ),
        "can_view_trademark_sphere": (
            "/trademark-sphere",
        ),
        "can_view_mis_report": (
            "/mis-report",
        ),
        "can_manage_mis_report": (
            "/mis-report/manage",
        ),
        "can_view_salary_slips": (
            "/salary-slips",
        ),
        "can_manage_salary_slips": (
            "/salary-slips/manage",
        ),
        "can_view_roc_sphere": (
            "/roc-sphere",
        ),
        "can_manage_roc_sphere": (
            "/roc-sphere/manage",
        ),
    },
    "records": {
        "can_view_all_dsc": (
            "/dsc",
        ),
        "can_view_documents": (
            "/documents",
        ),
        "can_view_passwords": (
            "/passwords",
        ),
        "can_edit_passwords": (
            "/passwords/manage",
        ),
        "can_view_clients": (
            "/client-approvals",
        ),
        "can_edit_clients": (
            "/clients/manage",
        ),
        "can_approve_clients": (
            "/clients/approve",
            "/client-approvals/approve",
        ),
        "can_approve_whatsapp_wishes": (
            "/automation/whatsapp",
        ),
        "can_approve_email_wishes": (
            "/automation/email",
        ),
    },
    "proposals": {
        "can_view_all_leads": (
            "/leads",
        ),
        "can_create_quotations": (
            "/quotations",
        ),
        "can_view_client_discussion": (
            "/client-discussion",
        ),
        "can_manage_client_discussion": (
            "/client-discussion/manage",
        ),
    },
    "aiweave": {
        "can_view_aiweave": ("/ai", "/aiweave", "/ai-reader"),
    },
    "people_matrix": {
        "can_view_user_page": (
            "/users/manage",
            "/people-matrix",
        ),
        "can_view_leave": (
            "/leave",
        ),
        "can_manage_leave": (
            "/leave/manage",
        ),
        "can_view_payroll": (
            "/payroll",
        ),
        "can_manage_payroll": (
            "/payroll/manage",
        ),
        "can_view_hr": (
            "/hr",
        ),
        "can_manage_hr": (
            "/hr/manage",
        ),
        "can_view_recruitment": (
            "/recruitment",
        ),
        "can_manage_recruitment": (
            "/recruitment/manage",
        ),
        "can_view_performance": (
            "/performance",
        ),
        "can_manage_performance": (
            "/performance/manage",
        ),
    },
}


def _matches(path: str, prefixes: Tuple[str, ...]) -> bool:
    return any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in prefixes
    )


def module_for_path(path: str, method: str = "GET") -> Optional[str]:
    normalized = path.split("?", 1)[0]

    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"

    if method == "GET":
        # User Directory is a People Matrix page for commercial tenants.
        # Keep the route entitlement consistent for GET and mutation endpoints.
        if normalized in ("/clients", "/clients/search"):
            return None

    for module, prefixes in MODULE_PREFIXES.items():
        if _matches(normalized, prefixes):
            return module

    return None


def feature_for_path(
    path: str,
    method: str = "GET",
) -> Optional[Tuple[str, str]]:
    normalized = path.split("?", 1)[0]

    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"

    # All User Directory APIs, including approve/reject/edit/delete/permissions,
    # are actions of the People Matrix User Directory page. This prevents a
    # mutation endpoint such as POST /users/{id}/approve from falling through
    # to the module-only branch and incorrectly producing:
    # "does not include a selected page for people_matrix".
    if normalized == "/users" or normalized.startswith("/users/"):
        return "people_matrix", "can_view_user_page"

    if method == "GET":
        if normalized in ("/clients", "/clients/search"):
            return None

    for module, features in FEATURE_PREFIXES.items():
        for flag, prefixes in features.items():
            if _matches(normalized, prefixes):
                return module, flag

    return None


async def _commercial_license(
    user: User,
    request_path: Optional[str] = None,
    request_method: str = "GET",
) -> Optional[dict]:
    """Resolve the one license that owns this tenant, never an arbitrary newer license.

    A customer may have historical/renewed licenses. Using one ``$or`` query and
    sorting by ``issued_at`` can select a different license than the one linked
    to the logged-in tenant, which makes valid selected features appear missing
    and produces false 403 responses. An explicit license link is authoritative;
    customer-id lookup is only the fallback for legacy records without one.
    """
    db = getattr(_dependencies, "_raw_db", _dependencies.db)

    from backend.licensing_api import _expiry_reason

    async def _valid(doc: Optional[dict]) -> Optional[dict]:
        if not doc or doc.get("status") not in {"active", "trial"}:
            return None

        if _expiry_reason(doc):
            return None

        return doc

    # The tenant/company license is the canonical source of truth. A user can
    # retain a historical license_id after the platform owner edits/reissues a
    # license; trusting that stale user field first causes exactly the false
    # 403 seen when a newly-enabled Finix/Compliance module is checked.
    company_id = str(getattr(user, "company_id", "") or "").strip()
    company = None

    if company_id:
        company = await db.companies.find_one(
            {"id": company_id},
            {
                "_id": 0,
                "commercial_customer_id": 1,
                "license_id": 1,
                "source": 1,
            },
        )

        company_license_id = str(
            (company or {}).get("license_id") or ""
        ).strip()

        if company_license_id:
            doc = await db.commercial_licenses.find_one(
                {"id": company_license_id},
                {"_id": 0},
            )

            valid = await _valid(doc)

            if valid:
                # A commercial customer is intended to have one active license,
                # but older Console updates can leave the legal company's
                # license_id pointing at a previous active record while the
                # customer has already been moved to a newer active license.
                # When the current request targets a licensed module that the
                # linked record does not contain, prefer the matching active
                # customer license below instead of returning a false 403.
                requested_module = module_for_path(
                    request_path or "",
                    request_method,
                )
                if (
                    not requested_module
                    or requested_module in resolve_license_modules(valid)
                ):
                    return valid

                linked_customer_id = str(
                    valid.get("customer_id")
                    or (company or {}).get("commercial_customer_id")
                    or ""
                ).strip()

                if linked_customer_id:
                    docs = await db.commercial_licenses.find(
                        {
                            "customer_id": linked_customer_id,
                            "status": {"$in": ["active", "trial"]},
                        },
                        {"_id": 0},
                    ).sort("issued_at", -1).limit(20).to_list(20)

                    for candidate in docs:
                        candidate_valid = await _valid(candidate)
                        if not candidate_valid:
                            continue
                        if requested_module in resolve_license_modules(candidate_valid):
                            logger.info(
                                "Commercial license compatibility fallback: "
                                "company=%s linked_license=%s selected_license=%s "
                                "module=%s path=%s",
                                company_id,
                                valid.get("id"),
                                candidate_valid.get("id"),
                                requested_module,
                                request_path,
                            )
                            return candidate_valid

                return valid

    user_license_id = str(
        getattr(user, "license_id", "") or ""
    ).strip()

    if user_license_id:
        doc = await db.commercial_licenses.find_one(
            {"id": user_license_id},
            {"_id": 0},
        )

        valid = await _valid(doc)

        if valid:
            return valid

    customer_id = str(
        getattr(user, "commercial_customer_id", "") or ""
    ).strip()

    if not customer_id:
        customer_id = (
            str(
                (company or {}).get("commercial_customer_id") or ""
            ).strip()
            if company_id
            else ""
        )

    if not customer_id and company_id:
        # Legacy commercial company records may use company_id itself as the
        # customer id. Only use this fallback when no explicit license link exists.
        customer_id = company_id

    if not customer_id:
        return None

    docs = await db.commercial_licenses.find(
        {
            "customer_id": customer_id,
            "status": {
                "$in": ["active", "trial"]
            },
        },
        {
            "_id": 0
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


def _hydrate_admin(user: User, license_doc: dict) -> User:
    if not _is_admin_role(user):
        return user

    data = user.model_dump()

    data["commercial_customer_id"] = (
        data.get("commercial_customer_id")
        or license_doc.get("customer_id")
    )

    data["license_id"] = license_doc.get("id")
    data["license_key"] = license_doc.get("license_key")

    data["licensed_modules"] = list(
        license_doc.get("modules")
        or license_doc.get("licensed_modules")
        or []
    )

    data["selected_features"] = (
        license_doc.get("selected_features")
        or {}
    )

    # Ordinary licensed modules remain role-granted to the tenant admin.
    # AIWeave is the exception: preserve only the administrator's previously
    # explicit AIWeave grant from the stored permission record. A license
    # purchase alone must never recreate that grant.
    admin_permissions = get_all_admin_permissions(license_doc)
    stored_permissions = data.get("permissions") or {}
    if hasattr(stored_permissions, "model_dump"):
        stored_permissions = stored_permissions.model_dump()
    if "aiweave" in resolve_license_modules(license_doc):
        admin_permissions["can_access_aiweave"] = bool(stored_permissions.get("can_access_aiweave", False))
        admin_permissions["can_view_aiweave"] = bool(stored_permissions.get("can_view_aiweave", False))
        matrix = dict(stored_permissions.get("governance_matrix") or {})
        ai_matrix = {
            key: value for key, value in matrix.items()
            if str(key).startswith("aiweave.")
        }
        if ai_matrix:
            admin_permissions["governance_matrix"] = {
                **(admin_permissions.get("governance_matrix") or {}),
                **ai_matrix,
            }
    else:
        admin_permissions["can_access_aiweave"] = False
        admin_permissions["can_view_aiweave"] = False
    data["permissions"] = admin_permissions

    return User.model_validate(data)


def _licensed_module(module: str, license_doc: dict) -> bool:
    return module in resolve_license_modules(license_doc)


def _selected_license_features(
    license_doc: dict,
    module: str,
) -> set[str]:
    """Return the exact page flags selected in the active commercial license.

    The license document is the commercial source of truth. Accept canonical
    module ids plus legacy aliases so a historical license cannot drift from the
    permission matrix merely because its module key was stored differently.
    """
    # MODULE ISOLATION RULE (same for every module): a module that is not on the
    # license grants nothing, no matter what stale keys remain in
    # selected_features (e.g. a "taskosphere" entry left behind after the
    # license was switched to Finix). A licensed module with no explicit page
    # list (missing OR empty) grants every page of THAT module only.
    all_module_flags = set(
        FEATURE_PREFIXES.get(module, {}).keys()
    )

    if not _licensed_module(module, license_doc):
        return set()

    raw = license_doc.get("selected_features")

    if not isinstance(raw, dict):
        return all_module_flags

    values = raw.get(module)

    if values is None:
        aliases = {
            "taskosphere": {
                "taskosphere",
                "tasks",
            },
            "finix": {
                "finix",
                "invoicing",
                "accounting",
            },
            "compliance": {
                "compliance",
            },
            "records": {
                "records",
            },
            "proposals": {
                "proposals",
                "client_proposals",
                "client-proposals",
                "leadsense",
            },
            "people_matrix": {
                "people_matrix",
                "people-matrix",
                "hrms",
                "peoplematrix",
            },
            "aiweave": {
                "aiweave",
                "ai-weave",
            },
        }.get(
            module,
            {module},
        )

        for raw_key, candidate in raw.items():
            key = str(raw_key).strip().lower().replace("-", "_")

            if key in {
                str(alias).replace("-", "_")
                for alias in aliases
            }:
                values = candidate
                break

    # A module added to an existing license may not yet have a
    # selected_features entry. In that legacy/module-only case, the licensed
    # module remains available while explicit feature selections stay restrictive.
    if values is None or (
        isinstance(values, (list, tuple, set))
        and len(values) == 0
    ):
        return all_module_flags

    if not isinstance(values, (list, tuple, set)):
        return set()

    selected = {
        str(flag).strip()
        for flag in values
    }

    # Dashboard/report entry points are derived from an active module's
    # selected pages. Older licenses may not have persisted the derived flag.
    dashboard_flags = {
        "taskosphere": "can_view_dashboard",
        "finix": "can_view_accounting_reports",
        "compliance": "can_view_compliance",
        "records": "can_view_documents",
        "proposals": "can_view_all_leads",
        "people_matrix": "can_view_user_page",
    }

    dashboard_flag = dashboard_flags.get(module)

    if selected and dashboard_flag:
        selected.add(dashboard_flag)

    return selected


def _permission_flag(
    user: User,
    flag: str,
    license_doc: dict,
    module: Optional[str] = None,
) -> bool:
    # The active commercial license's MODULE list is the hard ceiling for every
    # role (checked by the caller via _licensed_module before this runs). Once
    # a module is on the license, the tenant admin — the identity the license
    # was actually issued to — receives every page inside that module, exactly
    # like an internal admin account. The narrower "selected_features" page
    # list is a restriction that only applies to non-admin licensee users.
    is_admin = _is_admin_role(user)

    if module is not None:
        # AIWeave is explicitly user-governed. A commercial license can make
        # the module available to the tenant, but never auto-grants it — not
        # even to the licensee administrator.
        if module == "aiweave":
            permissions = getattr(user, "permissions", None)
            if hasattr(permissions, "model_dump"):
                permissions = permissions.model_dump()
            return (
                isinstance(permissions, dict)
                and permissions.get("can_access_aiweave", False) is True
                and permissions.get("can_view_aiweave", False) is True
            )

        if is_admin:
            return True

        selected = _selected_license_features(
            license_doc,
            module,
        )

        if flag not in selected:
            # Client Discussion was introduced after the first commercial
            # proposals licenses were issued. Those licenses selected Lead
            # Management, while the persisted admin permissions and frontend
            # still expose the discussion page. Keep that legacy entitlement
            # coherent without opening the route for another module.
            permissions = getattr(user, "permissions", None)
            if hasattr(permissions, "model_dump"):
                permissions = permissions.model_dump()
            if not isinstance(permissions, dict):
                permissions = {}
            if not (
                flag == "can_view_client_discussion"
                and (
                    "can_view_all_leads" in selected
                    or permissions.get("can_view_all_leads") is True
                )
            ):
                return False

    # The license ceiling above has passed. A tenant admin is governed by the
    # license alone, so do not additionally require a per-user permission dict.
    if is_admin:
        return True

    permissions = getattr(user, "permissions", None)

    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()

    if not isinstance(permissions, dict):
        return False

    return bool(
        permissions.get(
            flag,
            False,
        )
    )


async def get_current_user_with_commercial_guard(
    request: Request,
    credentials=Depends(_dependencies.security),
) -> User:
    user = await _BASE_GET_CURRENT_USER(credentials)

    if is_platform_owner(user):
        return user

    try:
        commercial = await _commercial_license(
            user,
            request.url.path,
            request.method,
        )
    except TypeError as exc:
        # Some compatibility layers may replace _commercial_license with the
        # legacy one-argument resolver. Preserve the request-aware resolver
        # when available, but remain compatible with that installed signature.
        if "takes 1 positional argument" not in str(exc):
            raise
        commercial = await _commercial_license(user)

    if not commercial:
        return user

    user = _hydrate_admin(
        user,
        commercial,
    )

    # Commercial tenant users inherit the licensed tenant administrator's
    # effective module/page access. This also repairs legacy users created
    # before inheritance was introduced; explicit Permission Matrix edits can
    # opt a user out by marking the account as independently governed.
    if not _is_admin_role(user):
        try:
            from backend.commercial_licensee_admin import sync_user_to_licensee_admin
            user = await sync_user_to_licensee_admin(user, commercial)
        except Exception as exc:
            logger.warning("Tenant user permission inheritance skipped: %s", exc)

    module = module_for_path(
        request.url.path,
        request.method,
    )

    if module and not _licensed_module(
        module,
        commercial,
    ):
        raise _deny(
            request,
            user,
            f"This company license does not include the {module} module.",
            commercial,
        )

    feature = feature_for_path(
        request.url.path,
        request.method,
    )

    if feature:
        feature_module, feature_flag = feature

        if not _licensed_module(
            feature_module,
            commercial,
        ):
            raise _deny(
                request,
                user,
                f"This company license does not include the {feature_module} module.",
                commercial,
            )

        if not _permission_flag(
            user,
            feature_flag,
            commercial,
            feature_module,
        ):
            raise _deny(
                request,
                user,
                f"This company license does not include the {feature_flag} feature.",
                commercial,
                {
                    "rules": GUARD_RULES_VERSION,
                    "flag": feature_flag,
                    "license_pages": sorted(
                        _selected_license_features(
                            commercial,
                            feature_module,
                        )
                    ),
                    "user_has_flag": bool(
                        (
                            getattr(
                                user,
                                "permissions",
                                None,
                            ).model_dump()
                            if hasattr(
                                getattr(
                                    user,
                                    "permissions",
                                    None,
                                ),
                                "model_dump",
                            )
                            else (
                                getattr(
                                    user,
                                    "permissions",
                                    None,
                                )
                                or {}
                            )
                        ).get(feature_flag)
                    ),
                },
            )

    elif module:
        raise _deny(
            request,
            user,
            f"This company license does not include a selected page for {module}.",
            commercial,
        )

    return user


GUARD_RULES_VERSION = "2026-09-20.aiweave-explicit-governance"


def install() -> None:
    # Boot marker: if this line is missing from the Render log after a deploy, the
    # server is still running the OLD entitlement code.
    logger.info(
        "commercial_module_guard active: rules=%s",
        GUARD_RULES_VERSION,
    )

    if getattr(
        _dependencies.get_current_user,
        "__name__",
        "",
    ) != "get_current_user_with_commercial_guard":
        _dependencies.get_current_user = get_current_user_with_commercial_guard


install()
