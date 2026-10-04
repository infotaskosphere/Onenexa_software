"""SSE authentication compatibility for the commercial SaaS session token.

The Unified Inbox EventSource cannot send an Authorization header, so the
frontend supplies the access token as ``?token=...``.  Commercial logins use
an opaque SaaS session token, while the original SSE handler only attempted
JWT decoding.  This shim validates both token types and preserves the existing
SSE event stream without changing the WhatsApp message/inbox behavior.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.dependencies.utils import get_dependant
from fastapi.responses import StreamingResponse
import jwt

from backend import whatsapp_hub
from backend import dependencies as _dependencies
from backend.dependencies import (
    ALGORITHM,
    JWT_SECRET,
    _get_saas_session_user,
)


async def _consume_stream_token(raw_token: str):
    """Consume a short-lived, single-use SSE credential atomically."""
    if not raw_token:
        return None
    raw_db = getattr(_dependencies, "_raw_db", None)
    if raw_db is None:
        return None
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    record = await raw_db.whatsapp_sse_tokens.find_one({
        "token_hash": token_hash,
        "used": False,
        "expires_at": {"$gt": now},
    })
    if not record:
        return None
    result = await raw_db.whatsapp_sse_tokens.update_one(
        {"_id": record.get("_id"), "used": False},
        {"$set": {"used": True, "used_at": now}},
    )
    if getattr(result, "modified_count", 0) != 1:
        return None
    return record


async def _resolve_user(request: Request, token: Optional[str]):
    auth_header = request.headers.get("Authorization", "")
    bearer_token = auth_header[7:] if auth_header.startswith("Bearer ") else None

    # Preferred path: the query parameter contains only a 60-second, single-use
    # stream credential, never the long-lived bearer/session token.
    if token:
        record = await _consume_stream_token(token)
        if record:
            raw_db = getattr(_dependencies, "_raw_db", None)
            user_doc = None
            if raw_db is not None:
                user_doc = await raw_db.users.find_one(
                    {"id": str(record.get("user_id") or ""), "status": "active"}
                )
            if user_doc:
                stored_company_id = str(user_doc.get("company_id") or "").strip()
                minted_company_id = str(record.get("company_id") or "").strip()
                if minted_company_id and stored_company_id and minted_company_id != stored_company_id:
                    raise HTTPException(401, "Invalid stream credential")
                user_doc.pop("_id", None)
                user_doc = _dependencies._normalize_permissions(user_doc)
                try:
                    return _dependencies.User(**user_doc)
                except Exception:
                    pass
        raise HTTPException(401, "Invalid or expired stream credential")

    if not bearer_token:
        raise HTTPException(401, "Authentication required")

    # Authorization-header path remains available for trusted internal callers.
    user = await _get_saas_session_user(bearer_token)
    if user is not None:
        return user

    # Keep compatibility with legacy JWT access tokens.
    try:
        payload = jwt.decode(bearer_token, JWT_SECRET, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
    except jwt.PyJWTError:
        user_id = None

    if not user_id:
        raise HTTPException(401, "Invalid token")

    db = whatsapp_hub._db()
    user_doc = await db["users"].find_one({"id": str(user_id)})
    if not user_doc:
        raise HTTPException(401, "User not found")

    user_doc.pop("_id", None)
    from backend.dependencies import _normalize_permissions
    from backend.models import User
    user_doc = _normalize_permissions(user_doc)
    try:
        return User(**user_doc)
    except Exception:
        raise HTTPException(401, "Invalid user session")


async def hub_events_compat(request: Request, token: Optional[str] = None):
    current_user = await _resolve_user(request, token)
    if not await whatsapp_hub._has_hub_access(current_user):
        raise HTTPException(403, "No WhatsApp Hub access")

    queue: asyncio.Queue = asyncio.Queue()
    whatsapp_hub._sse_queues.append(queue)

    async def generator():
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    # SSE comment keeps the Render/browser connection alive.
                    yield ": keepalive\n\n"
                    continue

                event_name = payload.get("event", "message")
                data = payload.get("data", {})
                yield f"event: {event_name}\ndata: {json.dumps(data, default=str)}\n\n"
        finally:
            try:
                whatsapp_hub._sse_queues.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def install() -> None:
    """Install the short-lived SSE credential endpoint and stream handler."""
    async def issue_stream_token(current_user=Depends(_dependencies.get_current_user)):
        raw_db = getattr(_dependencies, "_raw_db", None)
        if raw_db is None:
            raise HTTPException(503, "Session store unavailable")
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        now = datetime.now(timezone.utc)
        await raw_db.whatsapp_sse_tokens.insert_one({
            "token_hash": token_hash,
            "user_id": str(getattr(current_user, "id", "") or ""),
            "company_id": str(getattr(current_user, "company_id", "") or ""),
            "created_at": now,
            "expires_at": now + timedelta(seconds=60),
            "used": False,
        })
        return {"stream_token": raw_token, "expires_in": 60}

    token_path = "/whatsapp/hub/events-token"
    if not any(getattr(route, "path", "") == token_path for route in whatsapp_hub.router.routes):
        whatsapp_hub.router.add_api_route(token_path, issue_stream_token, methods=["POST"])

    for route in whatsapp_hub.router.routes:
        if getattr(route, "path", "") == "/whatsapp/hub/events":
            route.endpoint = hub_events_compat
            route.dependant = get_dependant(path=route.path, call=hub_events_compat)
            break
