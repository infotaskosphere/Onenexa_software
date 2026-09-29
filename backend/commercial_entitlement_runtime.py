"""Runtime commercial-license entitlement cap for authenticated users.

The commercial license is the hard ceiling for a tenant's module/page access.
This hook runs inside the existing synchronous permission normalization path so
/auth/me produces the same entitlement set after login and after a hard refresh.
It deliberately uses only entitlement data already persisted on the user record;
no database I/O or new authentication path is introduced here.
"""

from typing import Any, Dict, Iterable

from backend import dependencies as _dependencies


_MODULE_ALIASES = {
    "taskosphere": "taskosphere",
    "tasks": "taskosphere",
    "finix": "finix",
    "invoicing": "finix",
    "accounting": "finix",
    "compliance": "compliance",
    "records": "records",
    "proposals": "proposals",
    "client_proposals": "proposals",
    "client-proposals": "proposals",
    "people_matrix": "people_matrix",
    "people-matrix": "people_matrix",
    "hrms": "people_matrix",
    "peoplematrix": "people_matrix",
    "aiweave": "aiweave",
    "ai-weave": "aiweave",
}

# The page flags mirror backend.models.MODULE_HIERARCHY. Keeping this small
# explicit map here avoids importing commercial_onboarding_extensions from the
# authentication dependency path and creating a circular import.
_MODULE_PAGES = {
    "taskosphere": (
        "can_view_dashboard",
        "can_view_tasks",
        "can_view_todo_dashboard",
        "can_view_attendance",
        "can_view_reminders",
        "can_view_action_center",
        "can_view_client_visits",
        "can_view_ai_document_reader",
        "can_view_client_portal",
        "can_reset_client_passwords",
    ),
    "finix": (
        "can_view_accounting_reports",
        "can_view_sale",
        "can_view_purchase",
        "can_view_bank",
        "can_view_chart_of_accounts",
        "can_manage_chart_of_accounts",
        "can_view_journal_entries",
        "can_post_journal_entries",
        "can_match_bank",
    ),
    "compliance": (
        "can_view_compliance",
        "can_manage_compliance",
        "can_view_gst_reconciliation",
        "can_view_trademark_sphere",
        "can_view_mis_report",
        "can_manage_mis_report",
        "can_view_salary_slips",
        "can_manage_salary_slips",
        "can_view_roc_sphere",
        "can_manage_roc_sphere",
    ),
    "records": (
        "can_view_all_dsc",
        "can_view_documents",
        "can_view_passwords",
        "can_edit_passwords",
        "can_view_all_clients",
        "can_edit_clients",
        "can_approve_clients",
        "can_approve_whatsapp_wishes",
        "can_approve_email_wishes",
    ),
    "proposals": (
        "can_view_all_leads",
        "can_create_quotations",
        "can_view_client_discussion",
        "can_manage_client_discussion",
    ),
    "people_matrix": (
        "can_view_user_page",
        "can_view_leave",
        "can_manage_leave",
        "can_view_payroll",
        "can_manage_payroll",
        "can_view_hr",
        "can_manage_hr",
        "can_view_recruitment",
        "can_manage_recruitment",
        "can_view_performance",
        "can_manage_performance",
    ),
    "aiweave": (
        "can_view_aiweave",
    ),
}

_MODULE_FLAGS = {
    "taskosphere": "can_access_taskosphere",
    "finix": "can_access_finix",
    "compliance": "can_access_compliance",
    "records": "can_access_records",
    "proposals": "can_access_proposals",
    "people_matrix": "can_access_people_matrix",
    "aiweave": "can_access_aiweave",
}


def _normalized_modules(values: Iterable[Any]) -> set[str]:
    result: set[str] = set()
    for value in values or []:
        key = str(value or "").strip().lower().replace(" ", "_")
        if key in _MODULE_ALIASES:
            result.add(_MODULE_ALIASES[key])
    return result


def apply_license_cap(d: Dict[str, Any]) -> Dict[str, Any]:
    normalized = _dependencies._normalize_permissions_original(d)
    modules = _normalized_modules(
        normalized.get("licensed_modules")
        or normalized.get("modules")
        or (normalized.get("company") or {}).get("licensed_modules")
    )
    if not modules:
        return normalized

    raw_selected = normalized.get("selected_features")
    if not isinstance(raw_selected, dict):
        raw_selected = (normalized.get("company") or {}).get("selected_features")
    if not isinstance(raw_selected, dict):
        raw_selected = {}

    permissions = dict(normalized.get("permissions") or {})
    is_admin = str(normalized.get("role") or "").strip().lower() == "admin"

    for module_id, module_flag in _MODULE_FLAGS.items():
        module_allowed = module_id in modules
        permissions[module_flag] = module_allowed

        # If the license explicitly contains a feature list for this module,
        # that list is the page-level ceiling. When no list exists, retain the
        # legacy behavior: the entire licensed module remains available.
        selected_value = raw_selected.get(module_id)
        if selected_value is None:
            for raw_key, value in raw_selected.items():
                if _MODULE_ALIASES.get(str(raw_key).strip().lower().replace(" ", "_")) == module_id:
                    selected_value = value
                    break

        # An empty list is "nothing selected yet", not "everything forbidden": treat it
        # like a missing list so a licensed module grants its own pages (only its own).
        restriction_exists = selected_value is not None and not (isinstance(selected_value, list) and len(selected_value) == 0)
        selected = {str(flag).strip() for flag in (selected_value or [])} if isinstance(selected_value, list) else set()
        _dash = {"taskosphere": "can_view_dashboard", "finix": "can_view_accounting_reports", "compliance": "can_view_compliance", "records": "can_view_documents", "proposals": "can_view_all_leads", "people_matrix": "can_view_user_page"}.get(module_id)
        if module_allowed and selected and _dash:
            selected.add(_dash)

        # Backward compatibility: Client Discussion was introduced after the
        # original Proposals/Lead Management entitlement. The frontend already
        # treats can_view_all_leads as a view entitlement for Client Discussion;
        # keep the backend entitlement cap in sync so the page does not produce
        # a 403 after the frontend has decided it is accessible.
        if module_id == "proposals" and "can_view_all_leads" in selected:
            selected.add("can_view_client_discussion")

        for page_flag in _MODULE_PAGES[module_id]:
            if not module_allowed:
                permissions[page_flag] = False
            elif restriction_exists:
                permissions[page_flag] = page_flag in selected
            elif is_admin:
                # Commercial Admins receive the pages contained in the
                # licensed module when the license has no page restriction.
                # This keeps Admin access governed by the commercial license
                # while fixing older Admin records that predate these flags.
                permissions[page_flag] = True
            # Without an explicit restriction for non-admin roles, preserve
            # the role permission already normalized above.

    normalized["permissions"] = permissions
    return normalized


if not hasattr(_dependencies, "_normalize_permissions_original"):
    _dependencies._normalize_permissions_original = _dependencies._normalize_permissions
    _dependencies._normalize_permissions = apply_license_cap
