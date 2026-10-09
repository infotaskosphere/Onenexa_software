"""Regression tests for commercial licensee-admin permission ceilings.

Modern catalog-v2 licenses select each sidebar page independently. A module
subscription is a hard ceiling, not a grant of every page in that module.
"""


def test_licensee_admin_gets_only_selected_pages_in_purchased_finix_module():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-finix-selective",
        "customer_id": "customer-1",
        "page_catalog_version": 2,
        "modules": ["finix"],
        "selected_features": {
            "finix": [
                "can_view_finix_dashboard",
                "can_view_sale",
                "can_view_purchase",
                "can_view_accounting_reports",
            ],
        },
    }

    permissions = get_all_admin_permissions(license_doc)

    assert permissions["can_access_finix"] is True
    assert permissions["can_view_finix_dashboard"] is True
    assert permissions["can_view_sale"] is True
    assert permissions["can_view_purchase"] is True
    assert permissions["can_view_accounting_reports"] is True

    # Purchased-but-unselected Finix pages remain unavailable.
    assert permissions["can_view_bank"] is False
    assert permissions["can_view_chart_of_accounts"] is False
    assert permissions["can_view_journal_entries"] is False
    assert permissions["can_view_zero_touch_entries"] is False
    assert permissions["can_view_extended_accounts_reports"] is False
    assert permissions["can_view_gst_portal_sync"] is False
    assert permissions["can_view_accounting_integrity"] is False

    # Unpurchased modules remain closed.
    assert permissions["can_access_taskosphere"] is False
    assert permissions["can_access_compliance"] is False
    assert permissions["can_access_records"] is False


def test_aiweave_is_not_auto_granted_by_its_license():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "license-finix-aiweave",
        "customer_id": "customer-1",
        "page_catalog_version": 2,
        "modules": ["finix", "aiweave"],
        "selected_features": {
            "finix": ["can_view_sale"],
            "aiweave": ["can_view_aiweave"],
        },
    }

    permissions = get_all_admin_permissions(license_doc)

    assert permissions["can_access_finix"] is True
    assert permissions["can_access_aiweave"] is False
    assert permissions["can_view_aiweave"] is False


def test_request_guard_requires_accounting_reports_to_be_selected():
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
        "page_catalog_version": 2,
        "modules": ["finix"],
        "selected_features": {"finix": ["can_view_sale", "can_view_purchase"]},
    }

    assert _permission_flag(user, "can_view_sale", license_doc, "finix") is True
    assert _permission_flag(user, "can_view_purchase", license_doc, "finix") is True
    assert _permission_flag(user, "can_view_accounting_reports", license_doc, "finix") is False

    license_doc["selected_features"]["finix"].append("can_view_accounting_reports")
    assert _permission_flag(user, "can_view_accounting_reports", license_doc, "finix") is True


def test_legacy_module_only_finix_license_remains_compatible():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    license_doc = {
        "id": "legacy-finix-only",
        "customer_id": "customer-1",
        "modules": ["finix"],
        "selected_features": {},
    }

    permissions = get_all_admin_permissions(license_doc)

    assert permissions["can_access_finix"] is True
    assert permissions["can_view_sale"] is True
    assert permissions["can_view_purchase"] is True
    assert permissions["can_view_accounting_reports"] is True
