"""Commercial license seat and installation limit regression tests."""
from __future__ import annotations

import asyncio


def test_activation_engine_limits_active_installations():
    from backend.licensing_api import activate_license_record

    class Result:
        modified_count = 1

    class Cursor:
        def __init__(self, docs):
            self.docs = docs
        def __aiter__(self):
            self.i = 0
            return self
        async def __anext__(self):
            if self.i >= len(self.docs):
                raise StopAsyncIteration
            d = self.docs[self.i]
            self.i += 1
            return d

    class Collection:
        async def find_one(self, q, *args, **kwargs):
            if "license_key" in q:
                return {
                    "_id": "lic-1",
                    "license_key": "LIC-1",
                    "status": "active",
                    "max_installations": 2,
                    "activations": [
                        {"installation_id": "a", "status": "active"},
                        {"installation_id": "b", "status": "active"},
                    ],
                }
            return None
        async def update_one(self, *args, **kwargs):
            return Result()

    class DB:
        commercial_licenses = Collection()

    from backend import licensing_api
    previous = licensing_api.db
    licensing_api.db = DB()
    try:
        from fastapi import HTTPException
        try:
            asyncio.run(activate_license_record("LIC-1", "c", "Third device"))
        except HTTPException as exc:
            assert exc.status_code == 400
            assert "Installation limit reached" in str(exc.detail)
        else:
            raise AssertionError("Third installation should have been rejected")
    finally:
        licensing_api.db = previous


def test_license_user_limit_never_exceeds_max_users(monkeypatch):
    from backend import commercial_license_user_limit as mod
    from fastapi import HTTPException

    class Cursor:
        async def to_list(self, n=None):
            return []
    class Collection:
        def find(self, *args, **kwargs):
            return self
        def sort(self, *args, **kwargs):
            return self
        def limit(self, *args, **kwargs):
            return self
        async def to_list(self, n=None):
            return [{"id": "lic-1", "status": "active", "max_users": 2}]
        async def find_one(self, *args, **kwargs):
            return {"id": "company-a", "commercial_customer_id": "customer-a"}
        async def count_documents(self, *args, **kwargs):
            return 2
    class DB:
        commercial_licenses = Collection()
        companies = Collection()
        users = Collection()
    monkeypatch.setattr(mod, "_raw_db", lambda: DB())

    try:
        asyncio.run(mod._enforce_user_insert("customer-a", [{"id": "u3", "company_id": "company-a"}]))
    except HTTPException as exc:
        assert exc.status_code == 403
        assert "User limit reached" in str(exc.detail)
    else:
        raise AssertionError("License user limit was not enforced")
