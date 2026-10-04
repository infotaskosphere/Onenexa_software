"""Phase 1C — commercial cross-module isolation matrix.

These tests intentionally exercise the same server-side ownership functions used
by the live commercial guard. They verify that a license for one module never
creates access to another module, while Core administration remains available
to the tenant administrator.
"""
from __future__ import annotations

from starlette.requests import Request
from fastapi import HTTPException

from backend import commercial_module_guard as guard
from backend.models import User


MODULE_ROUTES = {
    "taskosphere": (
        "/tasks",
        "/attendance",
    ),
    "finix": (
        "/invoicing",
        "/journal-entries",
        "/reports/profit-loss",
        "/v2/exports/ledger",
    ),
    "compliance": (
        "/compliance",
        "/gst-reconciliation",
        "/trademark-sphere",
    ),
    "records": (
        "/clients",
        "/documents",
        "/passwords",
    ),
    "proposals": (
        "/leads",
        "/quotations",
        "/client-discussion",
    ),
    "people_matrix": (
        "/people-matrix",
        "/leave",
        "/payroll",
    ),
    "aiweave": (
        "/aiweave",
        "/ai",
        "/v2/copilot",
    ),
}

CORE_ROUTES = (
    "/users",
    "/reports/efficiency",
    "/reports/performance-rankings",
    "/reports/export",
    "/users/example-user/permissions",
    "/activity",
    "/staff-activity",
    "/settings/general",
)

ALL_BILLABLE_MODULES = tuple(MODULE_ROUTES)


def _request(path: str, method: str = "GET") -> Request:
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/api" + path,
            "headers": [],
        }
    )


def _admin_user() -> User:
    return User(
        id="tenant-admin",
        email="admin@example.com",
        role="admin",
        company_id="company-a",
        permissions={
            # AIWeave is explicitly user-governed even for tenant admins.
            "can_access_aiweave": True,
            "can_view_aiweave": True,
        },
    )


def _license(modules):
    return {
        "id": "license-test",
        "customer_id": "customer-a",
        "modules": list(modules),
        "selected_features": {},
    }


async def _run_guard(monkeypatch, path: str, license_modules):
    user = _admin_user()
    license_doc = _license(license_modules)

    async def fake_base(_credentials):
        return user

    async def fake_license(_user, *_args, **_kwargs):
        return license_doc

    async def fake_sync(_user, _license):
        return _user

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)
    monkeypatch.setattr(
        "backend.commercial_licensee_admin.sync_user_to_licensee_admin",
        fake_sync,
    )

    return await guard.get_current_user_with_commercial_guard(
        _request(path),
        credentials=type("Creds", (), {"credentials": "test"})(),
    )


def test_admin_user_model_preserves_explicit_aiweave_grant():
    user = _admin_user()
    assert user.permissions.can_access_aiweave is True
    assert user.permissions.can_view_aiweave is True


def test_every_billable_route_has_one_canonical_owner():
    owners = {}
    for module, routes in MODULE_ROUTES.items():
        for route in routes:
            assert route not in owners, f"{route} is owned by both {owners[route]} and {module}"
            owners[route] = module

    assert len(owners) == sum(len(routes) for routes in MODULE_ROUTES.values())


def test_core_routes_are_not_billable_modules():
    for route in CORE_ROUTES:
        assert guard.module_for_path(route) == "core"


def test_people_matrix_does_not_own_core_user_directory():
    assert guard.module_for_path("/users") == "core"
    assert guard.feature_for_path("/users") == ("core", "can_view_user_page")


def test_no_billable_module_can_be_enabled_by_another_module_license():
    for licensed in ALL_BILLABLE_MODULES:
        license_doc = _license([licensed])
        for candidate in ALL_BILLABLE_MODULES:
            if candidate == licensed:
                assert guard._licensed_module(candidate, license_doc) is True
            else:
                assert guard._licensed_module(candidate, license_doc) is False


def test_stale_selected_features_cannot_unlock_an_unlicensed_module():
    license_doc = {
        **_license(["finix"]),
        "selected_features": {
            "taskosphere": ["can_view_tasks", "can_view_dashboard"],
            "records": ["can_view_documents"],
            "finix": ["can_view_sale"],
        },
    }

    assert guard._selected_license_features(license_doc, "taskosphere") == set()
    assert guard._selected_license_features(license_doc, "records") == set()
    assert "can_view_sale" in guard._selected_license_features(license_doc, "finix")


async def test_taskosphere_only_admin_cannot_enter_finix(monkeypatch):
    try:
        await _run_guard(monkeypatch, "/invoicing", ["taskosphere"])
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Taskosphere-only admin reached a Finix route")


async def test_finix_only_admin_cannot_enter_taskosphere(monkeypatch):
    try:
        await _run_guard(monkeypatch, "/tasks", ["finix"])
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Finix-only admin reached a Taskosphere route")


async def test_records_only_admin_cannot_enter_people_matrix(monkeypatch):
    try:
        await _run_guard(monkeypatch, "/leave", ["records"])
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Records-only admin reached People Matrix")


async def test_people_matrix_only_admin_cannot_enter_compliance(monkeypatch):
    try:
        await _run_guard(monkeypatch, "/compliance", ["people_matrix"])
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("People Matrix-only admin reached Compliance")


async def test_leadsense_only_admin_cannot_enter_finix(monkeypatch):
    try:
        await _run_guard(monkeypatch, "/journal-entries", ["proposals"])
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("LeadSense-only admin reached Finix")


async def test_aiweave_only_requires_explicit_user_ai_permission(monkeypatch):
    user = _admin_user()
    user.permissions = {
        "can_access_aiweave": True,
        "can_view_aiweave": True,
    }
    await _run_guard(monkeypatch, "/aiweave", ["aiweave"])

    user.permissions = {
        "can_access_aiweave": False,
        "can_view_aiweave": False,
    }

    async def fake_base(_credentials):
        return user

    async def fake_license(_user, *_args, **_kwargs):
        return _license(["aiweave"])

    async def fake_sync(_user, _license):
        return _user

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)
    monkeypatch.setattr(
        "backend.commercial_licensee_admin.sync_user_to_licensee_admin",
        fake_sync,
    )

    try:
        await guard.get_current_user_with_commercial_guard(
            _request("/aiweave"),
            credentials=type("Creds", (), {"credentials": "test"})(),
        )
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("AIWeave license alone recreated user AI access")


async def test_aiweave_license_preserves_explicit_admin_grant_after_hydration(monkeypatch):
    user = _admin_user()
    user.permissions = {
        "can_access_aiweave": True,
        "can_view_aiweave": True,
    }
    license_doc = _license(["aiweave"])

    async def fake_base(_credentials):
        return user

    async def fake_license(_user, *_args, **_kwargs):
        return license_doc

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)

    hydrated = await guard.get_current_user_with_commercial_guard(
        _request("/aiweave"),
        credentials=type("Creds", (), {"credentials": "test"})(),
    )
    assert hydrated.permissions.can_access_aiweave is True
    assert hydrated.permissions.can_view_aiweave is True


async def test_aiweave_license_does_not_create_admin_grant_when_absent(monkeypatch):
    user = _admin_user()
    user.permissions = {
        "can_access_aiweave": False,
        "can_view_aiweave": False,
    }
    license_doc = _license(["aiweave"])

    async def fake_base(_credentials):
        return user

    async def fake_license(_user, *_args, **_kwargs):
        return license_doc

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)

    try:
        await guard.get_current_user_with_commercial_guard(
            _request("/aiweave"),
            credentials=type("Creds", (), {"credentials": "test"})(),
        )
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("AIWeave license alone recreated admin access")


async def test_core_admin_routes_remain_available_on_single_module_license(monkeypatch):
    for route in CORE_ROUTES:
        await _run_guard(monkeypatch, route, ["taskosphere"])


async def test_same_route_never_maps_to_two_billable_modules():
    route_to_modules = {}
    for module, routes in MODULE_ROUTES.items():
        for route in routes:
            route_to_modules.setdefault(route, set()).add(module)

    duplicates = {
        route: modules
        for route, modules in route_to_modules.items()
        if len(modules) > 1
    }
    assert duplicates == {}
