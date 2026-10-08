"""Regression tests for commercial licensee-admin permission ceilings."""

def test_licensee_admin_gets_all_pages_in_purchased_finix_module():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-finix-only",
        "customer_id": "customer-1",
        "modules": ["finix"],
        # Deliberately incomplete granular selection. A licensee admin's access
        # is capped by purchased modules; this list must not remove purchased
        # Finix pages from the tenant admin.
        "selected_features": {
            "finix": ["can_view_sale"],
        },
    }

    permissions = get_all_admin_permissions(license_doc)

    assert permissions["can_access_finix"] is True
    assert permissions["can_view_accounting_reports"] is True
    assert permissions["can_view_sale"] is True
    assert permissions["can_view_purchase"] is True
    assert permissions["can_view_bank"] is True
    assert permissions["can_view_chart_of_accounts"] is True
    assert permissions["can_view_journal_entries"] is True
    assert permissions["can_post_journal_entries"] is True
    assert permissions["can_match_bank"] is True

    # Unpurchased modules remain closed.
    assert permissions["can_access_taskosphere"] is False
    assert permissions["can_access_compliance"] is False


def test_aiweave_remains_explicitly_governed_for_licensee_admin():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-all",
        "customer_id": "customer-1",
        "modules": ["finix", "aiweave"],
        "selected_features": {
            "finix": [],
            "aiweave": ["can_view_aiweave"],
        },
    }

    permissions = get_all_admin_permissions(license_doc)

    assert permissions["can_access_finix"] is True
    assert permissions["can_access_aiweave"] is False
    assert permissions["can_view_aiweave"] is False


def test_request_guard_allows_licensee_admin_purchased_finix_pages():
    from backend.commercial_module_guard import _permission_flag
    from backend.models import User

    user = User(
        id="tenant-admin",
        email="admin@example.com",
        role="admin",
        company_id="company-1",
        permissions={},
    )
    license_doc = {
        "id": "license-finix-only",
        "customer_id": "customer-1",
        "modules": ["finix"],
        "selected_features": {"finix": ["can_view_sale"]},
    }

    assert _permission_flag(
        user,
        "can_view_accounting_reports",
        license_doc,
        "finix",
    ) is False
    assert _permission_flag(
        user,
        "can_view_sale",
        license_doc,
        "finix",
    ) is True
    assert _permission_flag(
        user,
        "can_view_purchase",
        license_doc,
        "finix",
    ) is True
    assert _permission_flag(
        user,
        "can_view_bank",
        license_doc,
        "finix",
    ) is False


def test_finix_catalog_contains_every_operational_finix_page():
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    flags = {
        page["flag"]
        for page in MODULE_HIERARCHY["finix"]["pages"]
    }

    expected = {
        "can_view_accounting_reports",
        "can_view_sale",
        "can_view_purchase",
        "can_view_bank",
        "can_view_chart_of_accounts",
        "can_manage_chart_of_accounts",
        "can_view_journal_entries",
        "can_post_journal_entries",
        "can_match_bank",
        "can_view_zero_touch_entries",
        "can_view_extended_accounts_reports",
        "can_view_gst_portal_sync",
        "can_view_accounting_integrity",
        "can_view_depreciation",
        "can_view_tds_tcs",
        "can_view_financial_ratios",
        "can_view_comparative_report",
        "can_view_yearly_report",
        "can_view_opening_balances",
        "can_view_accounting_audit_trail",
        "can_view_bulk_import",
        "can_view_due_dates",
        "can_view_import_invoices",
    }

    assert expected.issubset(flags)


def test_all_commercial_modules_have_catalog_pages():
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    required = {
        "taskosphere": {
            "can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard",
            "can_view_attendance", "can_view_reminders", "can_view_action_center",
            "can_view_client_visits", "can_view_client_portal",
            "can_reset_client_passwords", "can_view_staff_activity",
            "can_view_reports", "can_view_audit_logs",
        },
        "finix": {
            "can_view_accounting_reports", "can_view_sale", "can_view_purchase",
            "can_view_bank", "can_view_chart_of_accounts",
            "can_manage_chart_of_accounts", "can_view_journal_entries",
            "can_post_journal_entries", "can_match_bank",
            "can_view_zero_touch_entries", "can_view_extended_accounts_reports",
            "can_view_gst_portal_sync", "can_view_accounting_integrity",
            "can_view_depreciation", "can_view_tds_tcs",
            "can_view_financial_ratios", "can_view_comparative_report",
            "can_view_yearly_report", "can_view_opening_balances",
            "can_view_accounting_audit_trail", "can_view_bulk_import",
            "can_view_due_dates", "can_view_import_invoices",
        },
        "aiweave": {"can_view_aiweave"},
        "compliance": {
            "can_view_compliance", "can_manage_compliance",
            "can_view_gst_reconciliation", "can_view_trademark_sphere",
            "can_view_mis_report", "can_manage_mis_report",
            "can_view_salary_slips", "can_manage_salary_slips",
            "can_view_roc_sphere", "can_manage_roc_sphere",
        },
        "records": {
            "can_view_all_dsc", "can_view_documents", "can_view_passwords",
            "can_edit_passwords", "can_view_all_clients", "can_edit_clients",
            "can_approve_clients", "can_access_whatsapp_hub",
            "can_view_automation_approvals", "can_approve_whatsapp_wishes",
            "can_approve_email_wishes",
        },
        "proposals": {
            "can_view_all_leads", "can_create_quotations",
            "can_view_client_discussion", "can_manage_client_discussion",
        },
        "people_matrix": {
            "can_view_leave", "can_manage_leave", "can_view_payroll",
            "can_manage_payroll", "can_view_hr", "can_manage_hr",
            "can_view_recruitment", "can_manage_recruitment",
            "can_view_performance", "can_manage_performance",
        },
    }

    for module_id, flags in required.items():
        actual = {p["flag"] for p in MODULE_HIERARCHY[module_id]["pages"]}
        assert flags.issubset(actual), f"{module_id} missing {sorted(flags - actual)}"


def test_licensee_admin_does_not_get_taskosphere_linked_admin_pages_without_taskosphere():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-finix-only",
        "customer_id": "customer-1",
        "modules": ["finix"],
        "selected_features": {"finix": ["can_view_sale"]},
    }

    permissions = get_all_admin_permissions(license_doc)
    assert permissions["can_view_staff_activity"] is False
    assert permissions["can_view_reports"] is False
    assert permissions["can_view_audit_logs"] is False


def test_licensee_admin_records_linked_pages_require_explicit_selection():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-records-only",
        "customer_id": "customer-1",
        "modules": ["records"],
        "selected_features": {
            "records": ["can_view_documents", "can_access_whatsapp_hub"],
        },
    }

    permissions = get_all_admin_permissions(license_doc)
    assert permissions["can_view_documents"] is True
    assert permissions["can_access_whatsapp_hub"] is True
    assert permissions["can_view_automation_approvals"] is False
