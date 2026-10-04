"""Phase 2 — authentication/session security regression tests."""
from __future__ import annotations

import asyncio

from fastapi import HTTPException


class _Result:
    def __init__(self, modified_count=0):
        self.modified_count = modified_count


class _FakeCollection:
    def __init__(self, documents):
        self.documents = list(documents)
        self.calls = []

    async def update_many(self, query, update):
        self.calls.append(("update_many", query, update))
        matched = 0
        for doc in self.documents:
            if query.get("user_id") == doc.get("user_id") and (
                "status" not in query or query["status"] == doc.get("status")
            ):
                if "$set" in update:
                    doc.update(update["$set"])
                matched += 1
        return _Result(matched)

    async def update_one(self, query, update):
        self.calls.append(("update_one", query, update))
        for doc in self.documents:
            if all(doc.get(k) == v for k, v in query.items() if k != "$or"):
                if "$set" in update:
                    doc.update(update["$set"])
                return _Result(1)
        return _Result(0)

    async def find_one(self, query, projection=None):
        if "token_hash" in query:
            for doc in self.documents:
                if doc.get("token_hash") == query["token_hash"]:
                    return dict(doc)
        if "session_token" in query:
            for doc in self.documents:
                if doc.get("session_token") == query["session_token"]:
                    return dict(doc)
        if "user_id" in query:
            for doc in self.documents:
                if doc.get("user_id") == query["user_id"]:
                    return dict(doc)
        return None


class _FakeDb:
    def __init__(self):
        self.session_manager = _FakeCollection([
            {"session_token": "sess-1", "user_id": "user-1", "status": "active"},
            {"session_token": "sess-other", "user_id": "user-2", "status": "active"},
        ])
        self.sessions = _FakeCollection([
            {"session_token": "sess-1", "token_hash": "hash-1", "user_id": "user-1", "status": "active"},
            {"session_token": "sess-other", "token_hash": "hash-other", "user_id": "user-2", "status": "active"},
        ])


def test_revoke_all_user_sessions_hits_both_session_stores(monkeypatch):
    from backend.security import session_manager

    fake_db = _FakeDb()
    monkeypatch.setattr(session_manager, "_raw_db", lambda: fake_db)

    revoked = asyncio.run(
        session_manager.SessionManager.revoke_all_user_sessions(
            "user-1",
            reason="password_changed",
        )
    )

    assert revoked == 2
    assert fake_db.session_manager.documents[0]["status"] == "revoked"
    assert fake_db.sessions.documents[0]["status"] == "revoked"
    assert fake_db.session_manager.documents[1]["status"] == "active"
    assert fake_db.sessions.documents[1]["status"] == "active"
    assert fake_db.session_manager.documents[0]["revoked_reason"] == "password_changed"
    assert fake_db.sessions.documents[0]["revoked_reason"] == "password_changed"


def test_revoke_all_user_sessions_does_not_cross_user_boundary(monkeypatch):
    from backend.security import session_manager

    fake_db = _FakeDb()
    monkeypatch.setattr(session_manager, "_raw_db", lambda: fake_db)

    asyncio.run(
        session_manager.SessionManager.revoke_all_user_sessions(
            "user-1",
            reason="account_disabled",
        )
    )

    assert fake_db.session_manager.documents[1]["status"] == "active"
    assert fake_db.sessions.documents[1]["status"] == "active"


def test_session_replaced_constant_is_stable():
    from backend.security.session_manager import SESSION_REPLACED_DETAIL

    assert SESSION_REPLACED_DETAIL == "SESSION_REPLACED"

def test_session_creation_persists_expiry_in_both_stores(monkeypatch):
    from backend.security import session_manager

    fake_db = _FakeDb()
    monkeypatch.setattr(session_manager, "_raw_db", lambda: fake_db)
    monkeypatch.setattr(session_manager.dependencies, "ACCESS_TOKEN_EXPIRE_MINUTES", 60)
    monkeypatch.setattr(session_manager, "uuid", type("U", (), {"uuid4": staticmethod(lambda: type("X", (), {"hex": "abc123"})())}))

    token = asyncio.run(
        session_manager.SessionManager.create_user_session(
            "user-3", "127.0.0.1", "test-agent", "u3@example.com"
        )
    )

    assert token == "sess_abc123"
    legacy = fake_db.session_manager.documents[-1]
    mirror = fake_db.sessions.documents[-1]
    assert legacy["status"] == "active"
    assert mirror["status"] == "active"
    assert legacy.get("expires_at") is not None
    assert mirror.get("expires_at") is not None


def test_saas_session_rejects_user_session_company_mismatch(monkeypatch):
    from backend import dependencies

    class _Collection:
        async def find_one(self, query, *args, **kwargs):
            if "token_hash" in query:
                return {
                    "_id": "sess-1",
                    "token_hash": query["token_hash"],
                    "user_id": "user-1",
                    "company_id": "tenant-b",
                    "status": "active",
                    "expires_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc) + __import__("datetime").timedelta(hours=1),
                }
            if query.get("id") == "user-1":
                return {
                    "id": "user-1",
                    "email": "user@example.com",
                    "company_id": "tenant-a",
                    "status": "active",
                    "role": "staff",
                }
            return None

        def __getattr__(self, name):
            return self

    class _DB:
        sessions = _Collection()
        users = _Collection()
        companies = _Collection()
        subscriptions = _Collection()

        def __getitem__(self, name):
            return getattr(self, name)

    monkeypatch.setattr(dependencies, "_raw_db", _DB(), raising=False)
    monkeypatch.setattr(dependencies, "MONGO_URL", "mongodb://test", raising=False)
    result = asyncio.run(dependencies._get_saas_session_user("session-token"))
    assert result is None
