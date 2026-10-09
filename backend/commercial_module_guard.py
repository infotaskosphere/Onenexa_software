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
from backend.commercial_licensee_admin import (
    resolve_license_modules,
    get_all_admin_permissions,
    normalize_license_selected_features,
)
from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

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


CORE_PREFIXES = (
    "/users",
    "/master",
    "/companies",
    "/settings",
)

CORE_REPORT_PREFIXES = ()

COMMERCIAL_BLOCKED_PREFIXES = (
    "/v2/search",
    "/v2/platform",
    "/v2/exports",
)

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
        "/dashboard",
        "/activity",
        "/staff-activity",
        "/reports/efficiency",
        "/reports/performance-rankings",
        "/reports/export",
        "/task-audit",
        "/audit-logs",
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
        "/v2/exports/ledger",
        "/finix",
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
        "/whatsapp-hub",
        "/automation/approvals",
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
        "/v2/copilot",
        "/ai/",
    ),
    "people_matrix": (
        "/people-matrix",
        "/leave",
        "/payroll",
        "/hr",
        "/recruitment",
        "/performance",
    ),
}


FEATURE_PREFIXES = {
    "core": {
        "can_view_reports": ("/reports/efficiency", "/reports/performance-rankings"),
        "can_download_reports": ("/reports/export",),
        "can_view_staff_activity": ("/activity", "/staff-activity"),
        "can_view_user_page": ("/users", "/users/manage"),
        "can_manage_settings": ("/settings",),
        "can_view_master_data": ("/master-data",),
        "can_manage_master_data": ("/master-data/manage",),
        "can_view_roles": ("/roles",),
        "can_manage_roles": ("/roles/manage",),
        "can_manage_permissions": ("/permission-matrix",),
    },
    "taskosphere": {
        "can_view_dashboard": ("/dashboard",),
        "can_view_tasks": ("/tasks",),
        "can_view_todo_dashboard": ("/todos", "/todo"),
        "can_view_attendance": ("/attendance",),
        "can_view_reminders": ("/reminders",),
        "can_view_action_center": ("/action-center",),
        "can_view_client_visits": ("/visits",),
        "can_view_client_portal": ("/client-portal-manager",),
        "can_reset_client_passwords": ("/client-portal-manager/password", "/client-portal-manager/reset"),
        "can_view_staff_activity": ("/activity", "/staff-activity"),
        "can_view_reports": ("/reports/efficiency", "/reports/performance-rankings"),
        "can_download_reports": ("/reports/export",),
        "can_view_audit_logs": ("/task-audit", "/audit-logs"),
    },
    "finix": {
        "can_view_finix_dashboard": ("/finix-dashboard",),
        "can_view_sale": ("/invoicing", "/sales", "/invoices"),
        "can_view_purchase": ("/purchase", "/purchase-invoices"),
        "can_view_bank": ("/bank-accounts", "/bank-reconciliation"),
        "can_view_chart_of_accounts": ("/chart-of-accounts",),
        "can_manage_chart_of_accounts": ("/chart-of-accounts/manage",),
        "can_view_journal_entries": ("/journal-entries",),
        "can_post_journal_entries": ("/journal-entries/post",),
        "can_view_zero_touch_entries": ("/zero-touch-entry",),
        "can_view_accounting_reports": ("/accounting-reports",),
        "can_view_extended_accounts_reports": (
            "/day-book", "/cash-bank-book", "/cash-flow", "/outstanding-report",
            "/depreciation", "/tds-tcs", "/financial-ratios", "/comparative-report",
            "/yearly-report", "/opening-balances", "/accounting-audit-trail",
            "/bulk-import", "/due-dates", "/import-invoices",
            "/reports/day-book", "/reports/journal-register", "/reports/cash-bank-book",
            "/reports/cash-flow", "/reports/outstanding", "/reports/financial-ratios",
            "/reports/comparative", "/reports/yearly",
        ),
        "can_view_gst_portal_sync": ("/gst-portal-sync",),
        "can_view_accounting_integrity": ("/accounting-integrity",),
        # Report-data endpoints are shared by Finix Dashboard and Accounting Reports.
        # _permission_flag allows either explicitly selected page to read the data;
        # the frontend still controls which page is visible in navigation.
        "can_read_finix_report_data": (
            "/reports/profit-loss", "/reports/balance-sheet", "/reports/trial-balance",
            "/reports/validation-engine", "/reports/finix-dashboard", "/reports/mis-compliance",
            "/reports/parties", "/reports/party-ledger", "/reports/ledger-by-code",
            "/reports/journal-register",
        ),
        # Compatibility/action flags used by older endpoints, not license checkboxes.
        "can_match_bank": ("/bank-reconciliation",),
        "can_view_import_invoices": ("/import-invoices",),
        "can_view_bulk_import": ("/bulk-import",),
        "can_view_due_dates": ("/due-dates",),
        "can_view_depreciation": ("/depreciation",),
        "can_view_tds_tcs": ("/tds-tcs",),
        "can_view_financial_ratios": ("/financial-ratios",),
        "can_view_comparative_report": ("/comparative-report",),
        "can_view_yearly_report": ("/yearly-report",),
        "can_view_opening_balances": ("/opening-balances",),
        "can_view_accounting_audit_trail": ("/accounting-audit-trail",),
        "can_view_finix_ai": ("/finix", "/v2/exports/ledger"),
    },
    "compliance": {
        "can_view_compliance_dashboard": ("/compliance-dashboard",),
        "can_view_compliance": ("/compliance",),
        "can_manage_compliance": ("/compliance/manage",),
        "can_view_gst_reconciliation": ("/gst-reconciliation", "/gst-sphere"),
        "can_view_trademark_sphere": ("/trademark-sphere",),
        "can_view_roc_sphere": ("/roc-sphere",),
        "can_view_mis_report": ("/mis-report",),
        "can_manage_mis_report": ("/mis-report/manage",),
        "can_view_salary_slips": ("/salary-slips",),
        "can_manage_salary_slips": ("/salary-slips/manage",),
    },
    "records": {
        "can_view_records_dashboard": ("/records-dashboard",),
        "can_view_all_dsc": ("/dsc",),
        "can_view_documents": ("/documents",),
        "can_view_passwords": ("/passwords",),
        "can_edit_passwords": ("/passwords/manage",),
        "can_view_clients_page": ("/clients",),
        "can_edit_clients": ("/clients/manage",),
        "can_view_client_approvals": ("/client-approvals",),
        "can_approve_clients": ("/clients/approve", "/client-approvals/approve"),
        "can_approve_whatsapp_wishes": ("/automation/whatsapp",),
        "can_approve_email_wishes": ("/automation/email",),
        "can_access_whatsapp_hub": ("/whatsapp-hub",),
        "can_view_automation_approvals": ("/automation/approvals",),
        # Legacy flag retained only so old saved grants continue to be enforced.
        "can_view_clients": (),
    },
    "proposals": {
        "can_view_proposals_dashboard": ("/client-proposals-dashboard",),
        "can_view_all_leads": ("/leads",),
        "can_view_quotations": ("/quotations",),
        "can_create_quotations": ("/quotations/create",),
        "can_view_client_discussion": ("/client-discussion",),
        "can_manage_client_discussion": ("/client-discussion/manage",),
    },
    "aiweave": {
        "can_view_aiweave": ("/ai", "/aiweave", "/ai-reader", "/v2/copilot"),
    },
    "people_matrix": {
        "can_view_people_matrix_dashboard": ("/people-matrix",),
        "can_view_leave": ("/leave",),
        "can_manage_leave": ("/leave/manage",),
        "can_view_payroll": ("/payroll",),
        "can_manage_payroll": ("/payroll/manage",),
        "can_view_hr": ("/hr",),
        "can_manage_hr": ("/hr/manage",),
        "can_view_recruitment": ("/recruitment",),
        "can_manage_recruitment": ("/recruitment/manage",),
        "can_view_performance": ("/performance",),
        "can_manage_performance": ("/performance/manage",),
        # Legacy flag retained only for old records while Users is a core admin page.
        "can_view_people_matrix": (),
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

    if _matches(normalized, CORE_PREFIXES) or _matches(normalized, CORE_REPORT_PREFIXES):
        return "core"

    # Read-only client master data is a shared lookup used by licensed pages
    # across Finix, Compliance, LeadSense, Records and other workspaces. The
    # standalone Clients page is still gated by its frontend route/page flag;
    # contextual reads are validated separately by the tenant-page access helper.
    if method.upper() == "GET" and _matches(normalized, ("/clients",)):
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

    # All User Directory APIs belong to non-billable CORE administration.
    if normalized == "/users" or normalized.startswith("/users/"):
        return "core", "can_view_user_page"

    # GET client lookups are shared contextual data. The endpoint performs
    # role/visibility filtering; standalone page navigation remains Records-gated.
    if method.upper() == "GET" and _matches(normalized, ("/clients",)):
        return None

    if normalized == "/clients" or normalized.startswith("/clients/"):
        return "records", "can_access_records"

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

    # The user's explicit license link is authoritative. Never select a
    # different active license just because it happens to contain the module
    # requested by the current route; that can cross entitlement boundaries.
    user_license_id = str(getattr(user, "license_id", "") or "").strip()
    if user_license_id:
        linked_doc = await db.commercial_licenses.find_one(
            {"id": user_license_id},
            {"_id": 0},
        )
        valid_linked_doc = await _valid(linked_doc)
        if valid_linked_doc:
            return valid_linked_doc
        # An explicitly linked but inactive/missing license must fail closed.
        return None

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


def _hydrate_tenant_user(user: User, license_doc: dict) -> User:
    data = user.model_dump()
    original_permissions = getattr(user, "permissions", None)
    if hasattr(original_permissions, "model_dump"):
        explicit_ai_access = bool(
            getattr(original_permissions, "can_access_aiweave", False)
        )
        explicit_ai_view = bool(
            getattr(original_permissions, "can_view_aiweave", False)
        )
        original_permissions = original_permissions.model_dump()
    else:
        if not isinstance(original_permissions, dict):
            original_permissions = {}
        explicit_ai_access = bool(original_permissions.get("can_access_aiweave", False))
        explicit_ai_view = bool(original_permissions.get("can_view_aiweave", False))

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

    data["selected_features"] = normalize_license_selected_features(license_doc)

    if not _is_admin_role(user):
        return User.model_validate(data)

    # Ordinary licensed modules remain role-granted to the tenant admin.
    # AIWeave is the exception: preserve only the administrator's previously
    # explicit AIWeave grant from the user's actual permission state. A license
    # purchase alone must never recreate that grant.
    source_permissions = getattr(user, "permissions", None)
    if hasattr(source_permissions, "model_dump"):
        source_permissions = source_permissions.model_dump()
    if not isinstance(source_permissions, dict):
        source_permissions = {}
    admin_permissions = get_all_admin_permissions(license_doc)
    stored_permissions = dict(source_permissions)
    if not stored_permissions:
        fallback_permissions = data.get("permissions") or {}
        if hasattr(fallback_permissions, "model_dump"):
            fallback_permissions = fallback_permissions.model_dump()
        if isinstance(fallback_permissions, dict):
            stored_permissions = dict(fallback_permissions)
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

    hydrated_user = User.model_validate(data)
    # Re-apply the explicit tenant-admin AIWeave grant to the final Pydantic
    # permission object. AIWeave remains user-governed and is never recreated
    # merely because the commercial license contains the module.
    if "aiweave" in resolve_license_modules(license_doc):
        hydrated_user.permissions.can_access_aiweave = explicit_ai_access
        hydrated_user.permissions.can_view_aiweave = explicit_ai_view
    return hydrated_user


def _hydrate_admin(user: User, license_doc: dict) -> User:
    return _hydrate_tenant_user(user, license_doc)


def _licensed_module(module: str, license_doc: dict) -> bool:
    if module == "core":
        return True
    return module in resolve_license_modules(license_doc)


def _selected_license_features(
    license_doc: dict,
    module: str,
) -> set[str]:
    """Resolve selected page flags through the shared backward-compatible normalizer."""
    all_module_flags = set(FEATURE_PREFIXES.get(module, {}).keys())
    if not _licensed_module(module, license_doc):
        return set()

    raw = license_doc.get("selected_features")
    if not isinstance(raw, dict):
        if str(license_doc.get("package_id") or "").strip().lower() in {
            "custom", "custom-modules", "page-selective", "selective",
        }:
            return set()
        return all_module_flags

    normalized = normalize_license_selected_features(license_doc)
    values = normalized.get(module)
    if not isinstance(values, (list, tuple, set)):
        return set()
    return {
        str(flag).strip()
        for flag in values
        if str(flag).strip() in all_module_flags
    }


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

    if module == "finix" and flag == "can_read_finix_report_data":
        selected_pages = _selected_license_features(license_doc, "finix")
        data_pages = {"can_view_finix_dashboard", "can_view_accounting_reports"}
        if not selected_pages.intersection(data_pages):
            return False
        if is_admin:
            return True
        permissions = getattr(user, "permissions", None)
        if hasattr(permissions, "model_dump"):
            permissions = permissions.model_dump()
        if not isinstance(permissions, dict):
            return False
        if permissions.get("can_access_finix") is False:
            return False
        return any(
            page in selected_pages and permissions.get(page) is True
            for page in data_pages
        )

    if module is not None:
        # AIWeave follows the same Platform Owner page-selection rule as
        # every other commercial module.
        if module == "aiweave":
            selected_pages = _selected_license_features(license_doc, module)
            return "can_view_aiweave" in selected_pages

        # Every commercial role, including the licensee administrator, is
        # capped by the Platform Owner's explicit page selection.
        selected_pages = _selected_license_features(
            license_doc,
            module,
        )
        if flag not in selected_pages:
            return False

        if is_admin:
            return True

        # Non-admin licensee user: licensee admin has full control over user permissions
        # for modules permitted by the commercial console license.
        permissions = getattr(user, "permissions", None)
        if hasattr(permissions, "model_dump"):
            permissions = permissions.model_dump()
        if not isinstance(permissions, dict):
            return False

        module_flag_map = {
            "taskosphere": "can_access_taskosphere",
            "finix": "can_access_finix",
            "compliance": "can_access_compliance",
            "records": "can_access_records",
            "proposals": "can_access_proposals",
            "people_matrix": "can_access_people_matrix",
        }
        mod_flag = module_flag_map.get(module)
        if mod_flag and permissions.get(mod_flag) is False:
            return False

        if flag in permissions and permissions.get(flag) is not None:
            return bool(permissions.get(flag))

        dashboard_flags = {
            "taskosphere": "can_view_dashboard",
            "finix": "can_view_finix_dashboard",
            "compliance": "can_view_compliance_dashboard",
            "records": "can_view_records_dashboard",
            "proposals": "can_view_proposals_dashboard",
            "people_matrix": "can_view_people_matrix_dashboard",
        }
        if flag == dashboard_flags.get(module) and permissions.get(flag) is not False:
            return True

        if flag == "can_view_client_discussion" and permissions.get("can_view_all_leads") is True:
            return True

        return bool(permissions.get(flag, False))

    # Routes without an explicit module mapping are never implicitly granted
    # to a commercial tenant admin. Known module/page routes are checked above.
    if is_admin:
        return False

    permissions = getattr(user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()

    if not isinstance(permissions, dict):
        return False

    if flag in permissions and permissions.get(flag) is not None:
        return bool(permissions.get(flag))

    dashboard_flags = {
        "taskosphere": "can_view_dashboard",
        "finix": "can_view_finix_dashboard",
        "compliance": "can_view_compliance_dashboard",
        "records": "can_view_records_dashboard",
        "proposals": "can_view_proposals_dashboard",
        "people_matrix": "can_view_people_matrix_dashboard",
    }
    for m_id, d_flag in dashboard_flags.items():
        if flag == d_flag:
            m_flag = f"can_access_{m_id}"
            if permissions.get(m_flag) is not False and permissions.get(flag) is not False:
                return True

    if str(getattr(user, "role", "")).strip().lower() == "manager" and permissions.get(flag) is not False:
        return True

    return bool(
        permissions.get(
            flag,
            False,
        )
    )


def _shared_client_read_allowed(user: User, license_doc: dict) -> bool:
    """Permit shared client lookups only within a licensed, selected module/page.

    Client master data is reused as contextual data by Finix, Compliance,
    LeadSense and other workspaces. The standalone Records > Clients page is
    still independently gated by its route/page flag. Tenant scoping and
    user-specific client visibility remain enforced by the client endpoints.
    """
    permissions = getattr(user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    if not isinstance(permissions, dict):
        permissions = {}

    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin" or not _licensed_module(module_id, license_doc):
            continue
        selected_pages = _selected_license_features(license_doc, module_id)
        if not selected_pages:
            continue
        if _is_admin_role(user):
            return True
        module_flag = module_def.get("flag")
        if module_flag and permissions.get(module_flag) is False:
            continue
        for page in module_def.get("pages", []) or []:
            flag = str(page.get("flag") or "").strip()
            if flag and flag in selected_pages and permissions.get(flag) is True:
                return True
    return False


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

    # Preserve the authenticated administrator's explicit AIWeave grant before
    # commercial hydration applies role/license defaults.
    pre_hydration_permissions = getattr(user, "permissions", None)
    if hasattr(pre_hydration_permissions, "model_dump"):
        pre_hydration_ai_access = bool(
            getattr(pre_hydration_permissions, "can_access_aiweave", False)
        )
        pre_hydration_ai_view = bool(
            getattr(pre_hydration_permissions, "can_view_aiweave", False)
        )
        pre_hydration_permissions = pre_hydration_permissions.model_dump()
    else:
        if not isinstance(pre_hydration_permissions, dict):
            pre_hydration_permissions = {}
        pre_hydration_ai_access = bool(
            pre_hydration_permissions.get("can_access_aiweave", False)
        )
        pre_hydration_ai_view = bool(
            pre_hydration_permissions.get("can_view_aiweave", False)
        )

    user = _hydrate_admin(
        user,
        commercial,
    )

    if _is_admin_role(user) and "aiweave" in resolve_license_modules(commercial):
        permissions = getattr(user, "permissions", None)
        if permissions is not None:
            selected_ai = _selected_license_features(commercial, "aiweave")
            object.__setattr__(
                permissions,
                "can_access_aiweave",
                bool(selected_ai),
            )
            object.__setattr__(
                permissions,
                "can_view_aiweave",
                "can_view_aiweave" in selected_ai,
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

    # Licensee Admin control-plane/shared-master-data APIs must remain available
    # even when the customer purchased only one operational module. These routes
    # back Admin Dashboard, User Administration and tenant-wide reporting.
    # They remain tenant-scoped by the authenticated company and are still denied
    # to non-admin users through the normal module/page checks below.
    normalized_request_path = str(request.url.path or "").split("?", 1)[0]
    if normalized_request_path.startswith("/api"):
        normalized_request_path = normalized_request_path[4:] or "/"

    # Activity telemetry is an internal part of an enabled Taskosphere
    # workspace, not a separately purchasable page. Permit the signed-in user
    # to submit their own activity interval only when Taskosphere has at least
    # one explicitly selected page; viewing staff activity remains separately gated.
    if (
        str(request.method or "GET").upper() == "POST"
        and normalized_request_path == "/activity/log"
    ):
        if _licensed_module("taskosphere", commercial) and _selected_license_features(commercial, "taskosphere"):
            return user
        raise _deny(
            request,
            user,
            "Taskosphere activity tracking is not enabled for this license.",
            commercial,
        )

    # Shared client master data may be read as contextual data while using any
    # explicitly selected licensed page. The clients endpoint still performs
    # tenant and per-user visibility filtering; writes are never covered here.
    if (
        str(request.method or "GET").upper() == "GET"
        and _matches(normalized_request_path, ("/clients",))
    ):
        if _shared_client_read_allowed(user, commercial):
            return user
        raise _deny(
            request,
            user,
            "Client data is available only through an explicitly permitted licensed page.",
            commercial,
        )

    COMMERCIAL_ADMIN_SHARED_DATA_PREFIXES = (
        "/users",
        "/clients",
        "/reports",
    )
    if _is_admin_role(user) and any(
        normalized_request_path == prefix
        or normalized_request_path.startswith(prefix + "/")
        for prefix in COMMERCIAL_ADMIN_SHARED_DATA_PREFIXES
    ):
        return user

    normalized_request_path = request.url.path.split("?", 1)[0]
    normalized_without_api = normalized_request_path.removeprefix("/api") or "/"

    # Resolve explicit ownership first. A route that already belongs to a
    # billable module must never be shadowed by a broad legacy blocked prefix.
    module = module_for_path(
        request.url.path,
        request.method,
    )

    for blocked_prefix in COMMERCIAL_BLOCKED_PREFIXES:
        if not module and _matches(normalized_without_api, (blocked_prefix,)):
            raise _deny(
                request,
                user,
                f"This API route is not commercially assigned and is disabled for customer tenants: {blocked_prefix}.",
                commercial,
            )

    core_admin_shared = (
        _is_admin_role(user)
        and _matches(
            normalized_without_api,
            ("/users", "/clients", "/companies", "/master", "/settings"),
        )
    )

    if module and not core_admin_shared and not _licensed_module(
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

        if not core_admin_shared and not _licensed_module(
            feature_module,
            commercial,
        ):
            raise _deny(
                request,
                user,
                f"This company license does not include the {feature_module} module.",
                commercial,
            )

        explicit_ai_feature_grant = None

        if not core_admin_shared and not (
            explicit_ai_feature_grant
            if explicit_ai_feature_grant is not None
            else _permission_flag(
                user,
                feature_flag,
                commercial,
                feature_module,
            )
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


GUARD_RULES_VERSION = "2026-10-08.explicit-license-page-governance"


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
