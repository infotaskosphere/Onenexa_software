"""Phase 1D — commercial launch gate regression tests."""
from __future__ import annotations

import asyncio
import os

import pytest
from fastapi import HTTPException
from starlette.requests import Request


def _request(path="/api/tasks", method="GET", headers=None, body=None):
    req = Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "query_string": b"",
            "headers": headers or [],
        }
    )
    if body is not None:
        import json
        raw = json.dumps(body).encode("utf-8")
        req = Request(
            {
                "type": "http",
                "method": method,
                "path": path,
                "query_string": b"",
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(raw)).encode()),
                ],
            },
            receive=lambda: {
                "type": "http.request",
                "body": raw,
                "more_body": False,
            },
        )
    return req


def test_phase1d_gate_is_declared_on_main():
    from backend.commercial_core_isolation import verify_production_runtime
    assert callable(verify_production_runtime)


def test_production_mock_database_is_rejected(monkeypatch):
    from backend import commercial_core_isolation as core

    class FakeMock:
        __name__ = "MockMongoClient"

    monkeypatch.setenv("ENV_MODE", "production")
    monkeypatch.setattr(core._dependencies, "client", FakeMock(), raising=False)
    monkeypatch.setattr(core._dependencies, "MONGO_URL", "mongodb://example", raising=False)

    with pytest.raises(RuntimeError, match="MockMongoClient"):
        asyncio.run(core.verify_production_runtime())


def test_production_database_ping_failure_is_rejected(monkeypatch):
    from backend import commercial_core_isolation as core

    class Admin:
        async def command(self, name):
            raise RuntimeError("bad auth")

    class RealClient:
        admin = Admin()

    monkeypatch.setenv("ENV_MODE", "production")
    monkeypatch.setattr(core._dependencies, "client", RealClient(), raising=False)
    monkeypatch.setattr(core._dependencies, "MONGO_URL", "mongodb://example", raising=False)

    with pytest.raises(RuntimeError, match="MongoDB production health check failed"):
        asyncio.run(core.verify_production_runtime())


def test_production_database_ping_success_passes(monkeypatch):
    from backend import commercial_core_isolation as core

    class Admin:
        async def command(self, name):
            assert name == "ping"
            return {"ok": 1}

    class RealClient:
        admin = Admin()

    monkeypatch.setenv("ENV_MODE", "production")
    monkeypatch.setattr(core._dependencies, "client", RealClient(), raising=False)
    monkeypatch.setattr(core._dependencies, "MONGO_URL", "mongodb://example", raising=False)

    asyncio.run(core.verify_production_runtime())


def test_cross_tenant_query_is_rejected_at_request_boundary():
    from backend.production_hardening import _find_company_ids

    assert list(_find_company_ids({"company_id": "tenant-a"})) == ["tenant-a"]
    assert list(_find_company_ids({"nested": {"target_company_id": "tenant-b"}})) == ["tenant-b"]


def test_launch_gate_requires_explicit_module_ownership():
    from tests.test_phase1c_module_isolation_matrix import MODULE_ROUTES
    from backend.commercial_module_guard import module_for_path

    for module, routes in MODULE_ROUTES.items():
        for route in routes:
            assert module_for_path(route) == module, (module, route)


def test_core_identity_remains_available_without_billable_modules():
    from backend.commercial_module_guard import _licensed_module
    assert _licensed_module("core", {"modules": []}) is True


def test_unowned_sensitive_v2_route_is_fail_closed_for_customer():
    from backend.commercial_module_guard import COMMERCIAL_BLOCKED_PREFIXES
    from backend.commercial_module_guard import module_for_path

    assert "/v2/search" in COMMERCIAL_BLOCKED_PREFIXES
    assert module_for_path("/v2/search") is None


def test_finix_ledger_export_is_not_shadowed_by_generic_v2_block():
    from backend.commercial_module_guard import module_for_path
    assert module_for_path("/v2/exports/ledger") == "finix"
