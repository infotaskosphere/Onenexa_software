"""Shared master data (Company / Clients / Users) must stay usable from every
licensed module, even when the Records module is not part of the license.

Reproduces the licensee error:
    403  "This company license does not include the records module."
raised from Invoicing > Quick Add Client > Extract & Fill (POST
/clients/parse-multi-documents) and Save & Use (POST /clients).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend import commercial_module_guard as guard
from backend.models import User

# Finix-only licence (Essential-style: Invoicing, no Records).
FINIX_SELECTED = {"finix": ["can_view_finix_dashboard", "can_view_sale", "can_view_purchase"]}


def _request(path: str, method: str) -> Request:
    return Request({"type": "http", "method": method, "path": "/api" + path, "headers": []})


def _license(modules, selected):
    return {
        "id": "lic-1",
        "customer_id": "cust-1",
        "modules": list(modules),
        "selected_features": dict(selected),
        "page_catalog_version": 2,
    }


def _admin():
    return User(id="admin-1", email="a@x.com", role="admin", company_id="co-1", permissions={})


def _staff(perms):
    return User(id="staff-1", email="s@x.com", role="staff", company_id="co-1", permissions=perms)


async def _call(monkeypatch, path, method="GET", user=None, modules=("finix",), selected=None):
    user = user or _admin()
    lic = _license(modules, FINIX_SELECTED if selected is None else selected)

    async def fake_base(_c):
        return user

    async def fake_license(_u, *_a, **_k):
        return lic

    async def fake_sync(u, _l):
        return u

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)
    monkeypatch.setattr("backend.commercial_licensee_admin.sync_user_to_licensee_admin", fake_sync)
    return await guard.get_current_user_with_commercial_guard(
        _request(path, method), credentials=type("C", (), {"credentials": "t"})()
    )


async def _denied(monkeypatch, path, method="GET", **kw):
    with pytest.raises(HTTPException) as exc:
        await _call(monkeypatch, path, method, **kw)
    assert exc.value.status_code == 403
    return exc.value.detail


# ── The reported bug ────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/clients/parse-multi-documents"),   # Extract & Fill
        ("POST", "/clients"),                          # Save & Use
        ("POST", "/clients/parse-pdf"),
        ("POST", "/clients/parse-excel-row"),
        ("POST", "/clients/parse-mds-excel"),
        ("GET", "/clients"),
        ("GET", "/clients/search"),
        ("GET", "/clients/check-gstin"),
        ("GET", "/clients/pending"),
        ("GET", "/clients/fetch-mca-details"),
        ("GET", "/users"),
        ("GET", "/companies/list"),
    ],
)
async def test_finix_only_admin_can_use_shared_master_data(monkeypatch, method, path):
    user = await _call(monkeypatch, path, method)
    assert user.id == "admin-1"


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/clients/parse-multi-documents"),
        ("POST", "/clients"),
        ("GET", "/clients/search"),
        ("GET", "/users"),
    ],
)
async def test_staff_with_a_selected_licensed_page_can_use_shared_master_data(monkeypatch, method, path):
    staff = _staff({"can_access_finix": True, "can_view_sale": True})
    user = await _call(monkeypatch, path, method, user=staff)
    assert user.id == "staff-1"


# ── Admin > Master Data: tenant admin manages clients without Records ───────
@pytest.mark.parametrize(
    "method,path",
    [
        ("PUT", "/clients/abc"),
        ("DELETE", "/clients/abc"),
        ("POST", "/clients/import"),
        ("POST", "/clients/abc/approve"),
        ("POST", "/clients/abc/reject"),
    ],
)
async def test_tenant_admin_can_manage_client_master_data(monkeypatch, method, path):
    user = await _call(monkeypatch, path, method)
    assert user.id == "admin-1"


@pytest.mark.parametrize(
    "method,path",
    [
        ("PUT", "/clients/abc"),
        ("DELETE", "/clients/abc"),
        ("POST", "/clients/import"),
        ("POST", "/clients/abc/approve"),
        ("POST", "/clients/abc/reject"),
    ],
)
async def test_non_admin_cannot_manage_client_master_data_without_records(monkeypatch, method, path):
    staff = _staff({"can_access_finix": True, "can_view_sale": True})
    await _denied(monkeypatch, path, method, user=staff)


# ── Shared master data must NOT open the Records module itself ──────────────
RECORDS_ONLY = [
    ("GET", "/records-dashboard"),
    ("GET", "/documents"),
    ("GET", "/passwords"),
    ("GET", "/dsc"),
    ("GET", "/client-approvals"),
    ("POST", "/clients/merge"),
    ("PUT", "/clients/abc/link-drive-folder"),
    ("POST", "/clients/abc/send-birthday-wish"),
    ("POST", "/clients/parse-itr-computation-pdf"),
]


@pytest.mark.parametrize("method,path", RECORDS_ONLY)
async def test_records_pages_stay_gated_for_admin(monkeypatch, method, path):
    await _denied(monkeypatch, path, method)


@pytest.mark.parametrize("method,path", RECORDS_ONLY)
async def test_records_pages_stay_gated_for_staff(monkeypatch, method, path):
    staff = _staff({"can_access_finix": True, "can_view_sale": True})
    await _denied(monkeypatch, path, method, user=staff)


async def test_explicit_records_licence_still_works(monkeypatch):
    selected = {**FINIX_SELECTED, "records": ["can_view_clients_page", "can_view_documents"]}
    user = await _call(monkeypatch, "/documents", "GET", modules=("finix", "records"), selected=selected)
    assert user.id == "admin-1"


# ── Fail closed ────────────────────────────────────────────────────────────
async def test_staff_without_any_page_permission_is_denied(monkeypatch):
    await _denied(monkeypatch, "/clients", "POST", user=_staff({}))
    await _denied(monkeypatch, "/users", "GET", user=_staff({}))


async def test_licence_with_no_selected_pages_is_denied(monkeypatch):
    await _denied(monkeypatch, "/clients", "POST", selected={})
    await _denied(monkeypatch, "/clients/parse-multi-documents", "POST", selected={})


async def test_unlicensed_module_routes_stay_blocked(monkeypatch):
    await _denied(monkeypatch, "/tasks", "GET")      # taskosphere not licensed
    await _denied(monkeypatch, "/leave", "GET")      # people_matrix not licensed


# ── Pure path classifier ───────────────────────────────────────────────────
def test_classifier_shared_tier():
    from backend.commercial_shared_master_data import shared_master_data_kind as k

    assert k("POST", "/clients") == "clients"
    assert k("POST", "/api/clients/") == "clients"
    assert k("POST", "/clients/parse-multi-documents") == "clients"
    assert k("get", "/clients/search?q=abc") == "clients"
    assert k("GET", "/users") == "users"
    assert k("GET", "/companies/list") == "companies"
    # never in the shared tier
    for method, path in [
        ("PUT", "/clients/abc"), ("DELETE", "/clients/abc"), ("POST", "/clients/import"),
        ("POST", "/clients/abc/approve"), ("POST", "/users"), ("PUT", "/users/abc"),
        ("GET", "/users/abc/assigned-clients"), ("GET", "/users/abc/permissions"),
        ("GET", "/clients-export"), ("GET", "/clientsx"), ("GET", "/passwords"),
        ("POST", "/clients/merge"), ("POST", "/clients/parse-itr-computation-pdf"),
        ("POST", "/companies"),
    ]:
        assert k(method, path) is None, (method, path)


def test_classifier_admin_tier():
    from backend.commercial_shared_master_data import admin_master_data_kind as k

    assert k("PUT", "/clients/abc") == "clients"
    assert k("DELETE", "/api/clients/abc/") == "clients"
    assert k("POST", "/clients/import") == "clients"
    assert k("POST", "/clients/abc/approve") == "clients"
    assert k("GET", "/users") == "users"
    for method, path in [
        ("POST", "/clients/merge"), ("PUT", "/clients/abc/link-drive-folder"),
        ("POST", "/clients/abc/send-birthday-wish"), ("DELETE", "/clients/abc/def"),
        ("POST", "/users"), ("DELETE", "/users/abc"),
    ]:
        assert k(method, path) is None, (method, path)
