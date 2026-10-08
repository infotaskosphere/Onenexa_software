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
    ) is True
    assert _permission_flag(
        user,
        "can_view_purchase",
        license_doc,
        "finix",
    ) is True
