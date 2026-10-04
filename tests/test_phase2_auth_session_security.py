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
