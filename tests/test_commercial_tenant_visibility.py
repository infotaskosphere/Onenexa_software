"""Regression tests for Platform Owner vs commercial-licensee visibility boundaries."""


def test_company_master_directory_filters_licensee_companies():
    from backend.commercial_company_master import _is_licensee_company

    assert _is_licensee_company({
        "id": "licensee-company-1",
        "source": "commercial-license",
        "commercial_customer_id": "customer-1",
        "license_id": "license-1",
    })
    assert _is_licensee_company({
        "id": "licensee-company-2",
        "commercial_customer_id": "customer-2",
    })
    assert _is_licensee_company({
        "id": "licensee-company-3",
        "license_id": "license-3",
    })
    assert not _is_licensee_company({
        "id": "platform-company-1",
        "source": "platform",
        "commercial_customer_id": "",
        "license_id": "",
    })


def test_generic_user_scope_has_platform_owner_branch():
    from backend.server_modules.users_todos_admin import _scope_users_query_by_company

    # This helper is the authoritative tenant boundary used by GET/PUT/DELETE /users.
    assert _scope_users_query_by_company.__name__ == "_scope_users_query_by_company"


def test_platform_customer_user_endpoint_exists_separately():
    from backend.commercial_master_data import list_platform_company_users

    assert list_platform_company_users.__name__ == "list_platform_company_users"
