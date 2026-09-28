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
    from backend.server_modules import users_todos_admin

    source = users_todos_admin.SOURCE

    # The module preserves the original route implementation inside SOURCE and
    # registers it into the server namespace at application composition time.
    assert "async def _scope_users_query_by_company(" in source
    assert "if is_platform_owner(current_user):" in source
    assert "async def _get_scoped_user_for_mutation(" in source
    assert "_scope_users_query_by_company(" in source
    assert "old_user = await _get_scoped_user_for_mutation(current_user, user_id)" in source
    assert "new_user = await _get_scoped_user_for_mutation(current_user, body.replacement_user_id)" in source


def test_platform_customer_user_endpoint_exists_separately():
    from backend.commercial_master_data import list_platform_company_users

    assert list_platform_company_users.__name__ == "list_platform_company_users"


class _FakeCursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, field, direction=1):
        self.rows.sort(key=lambda row: str(row.get(field) or ""), reverse=direction < 0)
        return self

    async def to_list(self, length=None):
        return list(self.rows)


def _matches_query(query, document):
    """Small Mongo-query subset used only to exercise visibility predicates."""
    if not query:
        return True
    if "$and" in query:
        if not all(_matches_query(item, document) for item in query["$and"]):
            return False
    if "$or" in query:
        if not any(_matches_query(item, document) for item in query["$or"]):
            return False

    for key, expected in query.items():
        if key in {"$and", "$or"}:
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$nin" in expected and actual in expected["$nin"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$regex" in expected:
                import re
                if re.search(str(expected["$regex"]), str(actual or "")) is None:
                    return False
        elif actual != expected:
            return False
    return True


class _FakeCollection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.last_query = None

    def find(self, query=None, *args, **kwargs):
        self.last_query = query or {}
        return _FakeCursor(
            [row for row in self.rows if _matches_query(self.last_query, row)]
        )


class _FakeDB:
    def __init__(self, companies, users):
        self.companies = _FakeCollection(companies)
        self.users = _FakeCollection(users)


def test_platform_owner_user_scope_behaves_as_owner_only_filter(monkeypatch):
    from backend import commercial_user_company_scope as scope

    monkeypatch.setattr(
        scope,
        "platform_owner_emails",
        lambda: ["owner@taskosphere.com"],
    )

    users = [
        {
            "id": "platform-user",
            "email": "owner@taskosphere.com",
            "company_id": "platform-company",
            "commercial_customer_id": "",
            "license_id": "",
        },
        {
            "id": "licensee-a-user",
            "email": "a@example.com",
            "company_id": "licensee-company-a",
            "commercial_customer_id": "customer-a",
            "license_id": "license-a",
        },
        {
            "id": "licensee-b-user",
            "email": "b@example.com",
            "company_id": "licensee-company-b",
            "commercial_customer_id": "customer-b",
            "license_id": "license-b",
        },
        {
            "id": "internal-commercial-admin",
            "email": "commercial-control+customer-a@taskosphere.internal",
            "company_id": "__commercial_control_plane__",
            "is_internal_commercial_admin": True,
        },
    ]

    query = scope._owner_user_query({})
    visible_ids = [user["id"] for user in users if _matches_query(query, user)]

    assert visible_ids == ["platform-user"]


def test_platform_owner_control_plane_caller_is_explicitly_allowlisted():
    from backend import commercial_user_company_scope as scope

    assert scope._PLATFORM_CUSTOMER_USER_CONTROL_CALLERS == frozenset({
        "list_platform_company_users",
        "create_platform_company_user",
        "update_platform_company_user",
        "list_platform_company_deleted_users",
        "restore_platform_company_user",
        "activate_platform_company_user",
        "deactivate_platform_company_user",
        "delete_platform_company_user",
        "_platform_change_user_status",
    })


def test_platform_owner_direct_licensee_user_lookup_is_still_blocked(monkeypatch):
    from backend import commercial_user_company_scope as scope

    monkeypatch.setattr(
        scope,
        "platform_owner_emails",
        lambda: ["owner@taskosphere.com"],
    )

    query = scope._owner_user_query({"id": "licensee-a-user"})
    licensee_user = {
        "id": "licensee-a-user",
        "email": "a@example.com",
        "company_id": "licensee-company-a",
        "commercial_customer_id": "customer-a",
        "license_id": "license-a",
    }

    assert not _matches_query(query, licensee_user)

    owner_query = scope._owner_user_query({"id": "platform-user"})
    owner_user = {
        "id": "platform-user",
        "email": "owner@taskosphere.com",
        "company_id": "platform-company",
        "commercial_customer_id": "",
        "license_id": "",
    }
    assert _matches_query(owner_query, owner_user)


def test_platform_owner_company_user_directory_excludes_licensees(monkeypatch):
    import asyncio
    from backend import commercial_master_data as master_data

    companies = [
        {
            "id": "licensee-company-a",
            "name": "Licensee A",
            "source": "commercial-license",
            "commercial_customer_id": "customer-a",
            "license_id": "license-a",
        },
        {
            "id": "licensee-company-b",
            "name": "Licensee B",
            "source": "commercial-license",
            "commercial_customer_id": "customer-b",
            "license_id": "license-b",
        },
        {
            "id": "platform-company",
            "name": "Platform Owner Company",
            "source": "platform",
            "commercial_customer_id": "",
            "license_id": "",
        },
    ]
    users = [
        {
            "id": "platform-user",
            "full_name": "Platform User",
            "email": "owner@taskosphere.com",
            "role": "admin",
            "company_id": "platform-company",
            "commercial_customer_id": "",
            "license_id": "",
        },
        {
            "id": "licensee-a-user",
            "full_name": "Licensee A User",
            "email": "a@example.com",
            "role": "admin",
            "company_id": "licensee-company-a",
            "commercial_customer_id": "customer-a",
            "license_id": "license-a",
        },
        {
            "id": "licensee-b-user",
            "full_name": "Licensee B User",
            "email": "b@example.com",
            "role": "staff",
            "company_id": "licensee-company-b",
            "commercial_customer_id": "customer-b",
            "license_id": "license-b",
        },
    ]

    monkeypatch.setattr(
        master_data,
        "is_platform_owner",
        lambda current_user: True,
    )
    async def fake_company_context(current_user):
        return (
            {
                "id": "platform-owner-license",
                "customer_id": "platform-owner",
                "max_users": 9999,
                "modules": [],
                "selected_features": {},
            },
            companies[2],
        )

    monkeypatch.setattr(master_data, "_company_context", fake_company_context)
    monkeypatch.setattr(master_data, "db", _FakeDB(companies, users))

    result = asyncio.run(master_data.list_company_users(object()))

    assert [user["id"] for user in result["users"]] == ["platform-user"]


def test_platform_owner_customer_user_directory_remains_explicit_and_scoped(monkeypatch):
    import asyncio
    from backend import commercial_master_data as master_data

    users = [
        {
            "id": "licensee-a-user",
            "full_name": "Licensee A User",
            "email": "a@example.com",
            "role": "admin",
            "company_id": "licensee-company-a",
            "commercial_customer_id": "customer-a",
            "license_id": "license-a",
            "status": "active",
        },
        {
            "id": "licensee-b-user",
            "full_name": "Licensee B User",
            "email": "b@example.com",
            "role": "staff",
            "company_id": "licensee-company-b",
            "commercial_customer_id": "customer-b",
            "license_id": "license-b",
            "status": "active",
        },
        {
            "id": "platform-user",
            "full_name": "Platform User",
            "email": "owner@taskosphere.com",
            "role": "admin",
            "company_id": "platform-company",
            "commercial_customer_id": "",
            "license_id": "",
            "status": "active",
        },
    ]

    company = {
        "id": "licensee-company-a",
        "name": "Licensee A",
        "commercial_customer_id": "customer-a",
    }
    license_doc = {
        "id": "license-a",
        "license_key": "LIC-A",
        "customer_id": "customer-a",
        "max_users": 10,
        "modules": [],
        "selected_features": {},
    }

    async def fake_platform_company_context(current_user, identifier):
        return license_doc, company

    monkeypatch.setattr(
        master_data,
        "_platform_company_context",
        fake_platform_company_context,
    )
    monkeypatch.setattr(master_data, "db", _FakeDB([], users))

    result = asyncio.run(master_data.list_platform_company_users(
        company_id="licensee-company-a",
        current_user=object(),
    ))

    assert [user["id"] for user in result["users"]] == ["licensee-a-user"]
    assert result["platform_owner"] is True


def test_permission_governance_grants_use_tenant_scoped_user_query(monkeypatch):
    import asyncio
    from backend import permission_governance as governance

    users = [
        {
            "id": "platform-user",
            "full_name": "Platform User",
            "email": "owner@taskosphere.com",
            "role": "admin",
        },
        {
            "id": "licensee-user",
            "full_name": "Licensee User",
            "email": "licensee@example.com",
            "role": "admin",
            "commercial_customer_id": "customer-a",
            "license_id": "license-a",
        },
    ]

    captured = {}

    def fake_scope(query):
        captured["query"] = query
        return {"email": {"$in": ["owner@taskosphere.com"]}}

    monkeypatch.setattr(governance, "_scope_user_query", fake_scope)
    monkeypatch.setattr(governance, "_require_admin", lambda current_user: None)
    monkeypatch.setattr(governance, "db", _FakeDB([], users))

    result = asyncio.run(governance.list_current_grants(object()))

    assert captured["query"] == {}
    assert [user["id"] for user in result] == ["platform-user"]
