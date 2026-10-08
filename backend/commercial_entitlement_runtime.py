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
    """Apply the Platform Owner's commercial module/page selection as a hard cap.

    This function runs while building the authenticated user for /auth/me.
    Commercial licensing is fail-closed: a module is visible only when it is
    licensed AND has at least one explicitly selected page in selected_features.
    A missing/empty selected_features entry never expands a module to full access.
    """
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

    alias_lookup = {
        "taskosphere": {"taskosphere", "tasks"},
        "finix": {"finix", "invoicing", "accounting"},
        "compliance": {"compliance"},
        "records": {"records"},
        "proposals": {"proposals", "client_proposals", "client-proposals", "leadsense"},
        "people_matrix": {"people_matrix", "people-matrix", "hrms", "peoplematrix"},
        "aiweave": {"aiweave", "ai-weave"},
    }

    def selected_for(module_id: str) -> set[str]:
        values = raw_selected.get(module_id)
        if values is None:
            accepted = {str(x).strip().lower().replace("-", "_") for x in alias_lookup.get(module_id, {module_id})}
            for raw_key, candidate in raw_selected.items():
                if str(raw_key).strip().lower().replace("-", "_") in accepted:
                    values = candidate
                    break
        if not isinstance(values, (list, tuple, set)):
            return set()
        allowed = set(_MODULE_PAGES.get(module_id, ()))
        return {str(flag).strip() for flag in values if str(flag).strip() in allowed}

    permissions = dict(normalized.get("permissions") or {})

    for module_id, module_flag in _MODULE_FLAGS.items():
        if module_id not in modules:
            permissions[module_flag] = False
            for page_flag in _MODULE_PAGES[module_id]:
                permissions[page_flag] = False
            continue

        selected = selected_for(module_id)

        # Module visibility exists only when at least one page was explicitly
        # granted by the Platform Owner.
        permissions[module_flag] = bool(selected)

        # No dashboard/report is derived from another selection. Every page is
        # individually controlled by selected_features.
        for page_flag in _MODULE_PAGES[module_id]:
            permissions[page_flag] = page_flag in selected

    # Keep legacy aliases synchronized with the same selected-page ceiling.
    finix = selected_for("finix")
    records = selected_for("records")
    proposals = selected_for("proposals")
    permissions["can_manage_invoices"] = "can_view_sale" in finix
    permissions["can_view_clients"] = "can_view_all_clients" in records
    permissions["can_edit_clients"] = "can_edit_clients" in records
    permissions["can_approve_clients"] = "can_approve_clients" in records
    permissions["can_view_passwords"] = "can_view_passwords" in records
    permissions["can_edit_passwords"] = "can_edit_passwords" in records
    permissions["can_approve_whatsapp_wishes"] = "can_approve_whatsapp_wishes" in records
    permissions["can_approve_email_wishes"] = "can_approve_email_wishes" in records
    permissions["can_view_all_leads"] = "can_view_all_leads" in proposals
    permissions["can_create_quotations"] = "can_create_quotations" in proposals

    normalized["permissions"] = permissions
    normalized["licensed_modules"] = sorted(modules)
    normalized["selected_features"] = {
        module_id: sorted(selected_for(module_id))
        for module_id in modules
    }
    return normalized


if not hasattr(_dependencies, "_normalize_permissions_original"):
    _dependencies._normalize_permissions_original = _dependencies._normalize_permissions
    _dependencies._normalize_permissions = apply_license_cap
