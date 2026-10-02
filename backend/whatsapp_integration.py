"""
whatsapp_integration.py — Multi-session WhatsApp Web integration

Architecture:
  - Admin can connect MULTIPLE WhatsApp numbers via QR scan
  - Each session lives in the wa-bridge (Node.js / Baileys)
  - Taskosphere backend proxies session management to the bridge
  - All authenticated users with WA access can send from any connected number
  - Full audit trail in MongoDB (whatsapp_messages collection)

FIX SUMMARY (429 Too Many Requests on Render free tier)
─────────────────────────────────────────────────────────────────────────────
Root cause: GET /sessions and GET /status both hit the wa-bridge on every
call. Multiple open tabs + frontend polling = constant wa-bridge hammering.

Changes in this file:
  1. 15-second in-memory cache on _bridge_get("/sessions") via a module-level
     dict (_sessions_cache). All callers (list_sessions, get_wa_status) share
     the same cache, so N concurrent requests only generate ONE real bridge hit
     per 15-second window.
  2. Cache is invalidated on any session mutation (add / delete / label change
     / webhook). Next poll after any of these always gets fresh data.
  3. On 429 from the bridge after all retries: returns 429 (not 502) so the
     frontend can display a user-friendly message and back off.
  4. Existing exponential-backoff retry logic kept intact.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time as _time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field

from backend.dependencies import get_current_user, require_admin
from backend.models import User
from backend.tenant_runtime import enforce_company_value
from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)

# Guards wa_scheduled_bulk_job against overlapping runs now that it no
# longer blocks-and-waits on the coroutine (see wa_scheduled_bulk_job).
_bulk_job_running = False
router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])

WA_BRIDGE_URL = os.getenv("WA_BRIDGE_URL", "http://localhost:3002")

def _db():
    from backend.server import db
    return db

# ── In-memory sessions cache ──────────────────────────────────────────────────
# Shared by list_sessions and get_wa_status so they never both hit the bridge
# within the same 15-second window.
_SESSIONS_CACHE_TTL = 15  # seconds
_sessions_cache: Dict[str, Any] = {"data": None, "ts": 0.0}


async def _get_cached_sessions() -> List[Dict]:
    """Return bridge /sessions list, using in-memory cache if fresh."""
    now = _time.monotonic()
    if _sessions_cache["data"] is not None and now - _sessions_cache["ts"] < _SESSIONS_CACHE_TTL:
        return _sessions_cache["data"]
    try:
        data = await _bridge_get_raw("/sessions")
        result = data.get("sessions", [])
    except HTTPException:
        # On error, return stale data rather than crashing callers
        result = _sessions_cache["data"] if _sessions_cache["data"] is not None else []
    _sessions_cache["data"] = result
    _sessions_cache["ts"] = _time.monotonic()
    return result


def _invalidate_sessions_cache():
    """Force next call to _get_cached_sessions() to hit the bridge."""
    _sessions_cache["data"] = None
    _sessions_cache["ts"] = 0.0


# ── Keep-alive ping (prevents Render free-tier wa-bridge from sleeping) ──────
# Render free instances spin down after ~15 min of no inbound traffic. When
# that happens, the next real request (e.g. "Connect a WhatsApp Number")
# arrives while the instance is cold-starting, and Render's edge returns 429s
# during that window — which the browser then reports as a CORS error because
# the failed/incomplete response has no CORS headers to read.
# Pinging a cheap endpoint every few minutes keeps the instance warm so real
# user requests never hit that cold-start window.
async def ping_wa_bridge_keep_alive():
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{WA_BRIDGE_URL}/status")
            logger.info(f"WA bridge keep-alive ping: {r.status_code}")
    except Exception as e:
        logger.warning(f"WA bridge keep-alive ping failed (non-fatal): {e}")


def wa_bridge_keepalive_job():
    """APScheduler sync wrapper — run every 5 minutes to keep wa-bridge warm."""
    try:
        from backend.server import app_event_loop
        if app_event_loop is None or app_event_loop.is_closed():
            return
        future = asyncio.run_coroutine_threadsafe(ping_wa_bridge_keep_alive(), app_event_loop)
        future.result(timeout=15)
    except Exception as exc:
        logger.warning(f"wa_bridge_keepalive_job failed (non-fatal): {exc}")


# ── Pydantic models ──────────────────────────────────────────────────────────

class WASessionCreate(BaseModel):
    label: Optional[str] = None
    pairing_phone: Optional[str] = None   # e.g. "919876543210" — triggers phone pairing instead of QR

class WAAccessRequest(BaseModel):
    reason: str = Field(..., min_length=5, max_length=500)

class WAAccessDecision(BaseModel):
    user_id: str
    approved: bool
    admin_note: Optional[str] = None

class WASendMessageRequest(BaseModel):
    to: str
    message: str = Field(..., min_length=1, max_length=4096)
    message_type: str = "general"
    context_id: Optional[str] = None
    session_id: Optional[str] = None
    batch_id: Optional[str] = None
    batch_name: Optional[str] = None

class WABulkSendRequest(BaseModel):
    recipients: List[str]
    message: str
    message_type: str = "general"
    context_id: Optional[str] = None
    session_id: Optional[str] = None
    batch_id: Optional[str] = None
    batch_name: Optional[str] = None

class WASendMediaRequest(BaseModel):
    to: str
    caption: Optional[str] = None
    base64: str                        # base64-encoded file content
    mime_type: str
    filename: str
    message_type: str = "general"
    context_id: Optional[str] = None
    session_id: Optional[str] = None
    batch_id: Optional[str] = None
    batch_name: Optional[str] = None

# ── Bridge helpers ───────────────────────────────────────────────────────────

async def _bridge_get_raw(path: str, retries: int = 3) -> Dict[str, Any]:
    """Raw GET to wa-bridge — no cache. Internal use only."""
    for attempt in range(retries):
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(f"{WA_BRIDGE_URL}{path}")
                if r.status_code == 429:
                    if attempt < retries - 1:
                        wait = 2 ** (attempt + 1)
                        logger.warning(f"WA bridge 429 on GET {path}, retry in {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    # All retries exhausted — propagate 429 so frontend can back off
                    raise HTTPException(429, "WhatsApp bridge is rate-limiting requests. Please wait and try again.")
                r.raise_for_status()
                return r.json()
        except httpx.ConnectError:
            raise HTTPException(503, "WhatsApp bridge not running. Start wa-bridge.")
        except HTTPException:
            raise
        except Exception as e:
            if attempt < retries - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(502, f"WA bridge error: {e}")
    raise HTTPException(502, "WA bridge request failed after retries.")


# Keep _bridge_get as an alias so all existing callers work unchanged
async def _bridge_get(path: str, retries: int = 3) -> Dict[str, Any]:
    return await _bridge_get_raw(path, retries)


async def _bridge_post(path: str, payload: Dict, retries: int = 3) -> Dict:
    for attempt in range(retries):
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(f"{WA_BRIDGE_URL}{path}", json=payload)
                if r.status_code == 429:
                    if attempt < retries - 1:
                        wait = 2 ** (attempt + 1)
                        logger.warning(f"WA bridge 429 on POST {path}, retry in {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    raise HTTPException(429, "WhatsApp bridge is rate-limiting requests. Please wait and try again.")
                r.raise_for_status()
                return r.json()
        except httpx.ConnectError:
            raise HTTPException(503, "WhatsApp bridge not running.")
        except HTTPException:
            raise
        except Exception as e:
            if attempt < retries - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(502, f"WA bridge error: {e}")
    raise HTTPException(502, "WA bridge request failed after retries.")


async def _bridge_post_large(path: str, payload: Dict, retries: int = 2) -> Dict:
    """Like _bridge_post but with a 90-second timeout for large base64 payloads (PDFs, images).
    Only 2 retries — large files are slow; we don't want to triple the wait time on failure.
    """
    for attempt in range(retries):
        try:
            async with httpx.AsyncClient(timeout=90) as c:
                r = await c.post(f"{WA_BRIDGE_URL}{path}", json=payload)
                if r.status_code == 429:
                    if attempt < retries - 1:
                        wait = 2 ** (attempt + 1)
                        logger.warning(f"WA bridge 429 on POST {path} (media), retry in {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    raise HTTPException(429, "WhatsApp bridge is rate-limiting requests. Please wait and try again.")
                if r.status_code == 400:
                    detail = r.json().get("error", "Bad request to bridge")
                    raise HTTPException(400, f"Bridge rejected media: {detail}")
                r.raise_for_status()
                return r.json()
        except httpx.ConnectError:
            raise HTTPException(503, "WhatsApp bridge not running.")
        except HTTPException:
            raise
        except Exception as e:
            if attempt < retries - 1:
                await asyncio.sleep(3)
                continue
            raise HTTPException(502, f"WA bridge media error: {e}")
    raise HTTPException(502, "WA bridge media request failed after retries.")

async def _bridge_delete(path: str) -> Dict:
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.delete(f"{WA_BRIDGE_URL}{path}")
            r.raise_for_status()
            return r.json()
    except httpx.ConnectError:
        raise HTTPException(503, "WhatsApp bridge not running.")
    except Exception as e:
        raise HTTPException(502, f"WA bridge error: {e}")

async def _has_wa_access(user: User) -> bool:
    if user.role == "admin":
        return True
    rec = await _db()["whatsapp_access_requests"].find_one({"user_id": user.id, "status": "approved"})
    return rec is not None

async def _store_message(sent_by, to, message, message_type, context_id, status_val, session_id=None, error=None, batch_id=None, batch_name=None):
    await _db()["whatsapp_messages"].insert_one({
        "sent_by": sent_by, "to": to, "message": message,
        "message_type": message_type, "context_id": context_id,
        "session_id": session_id, "status": status_val, "error": error,
        "batch_id": batch_id, "batch_name": batch_name,
        "sent_at": datetime.now(timezone.utc).isoformat(),
    })

# ── Multi-session endpoints ──────────────────────────────────────────────────

@router.get("/numbers")
async def list_numbers(current_user: User = Depends(get_current_user)):
    """Connected WhatsApp numbers for the Hub's per-number filter row.
    The frontend (WhatsAppHub.jsx) has been calling GET /whatsapp/numbers
    since it was built, but this endpoint never existed — every call 404'd
    and was silently swallowed, so the filter row simply never appeared.
    Reuses the same bridge+label join as /sessions, filtered to connected
    numbers only, plus a per-number conversation count from the Hub's own
    contacts collection so the badge counts in the UI have real data."""
    bridge_sessions = await _get_cached_sessions()
    db = _db()
    db_records = await db["whatsapp_sessions"].find({}).to_list(100)
    labels = {d["session_id"]: d for d in db_records}

    result = []
    for s in bridge_sessions:
        if s.get("status") != "connected":
            continue
        sid = s["sessionId"]
        db_rec = labels.get(sid, {})
        conv_count = await db["whatsapp_hub_contacts"].count_documents({"session_id": sid})
        result.append({
            "id": sid,
            "number": s.get("phoneNumber"),
            "label": db_rec.get("label") or s.get("displayName") or s.get("phoneNumber") or sid,
            "conversation_count": conv_count,
        })
    return {"numbers": result}


@router.get("/sessions")
async def list_sessions(current_user: User = Depends(get_current_user)):
    # FIX: uses 15s cache — all concurrent callers share one bridge hit per window
    bridge_sessions = await _get_cached_sessions()

    db = _db()
    db_records = await db["whatsapp_sessions"].find({}).to_list(100)
    labels = {d["session_id"]: d for d in db_records}

    result = []
    for s in bridge_sessions:
        sid = s["sessionId"]
        db_rec = labels.get(sid, {})
        result.append({
            **s,
            "label": db_rec.get("label") or s.get("displayName") or sid,
            "added_by": db_rec.get("added_by_name"),
        })
    return {"sessions": result}


@router.post("/sessions")
async def add_session(body: WASessionCreate, current_user: User = Depends(require_admin())):
    session_id = f"wa_{int(_time.time() * 1000)}"
    bridge_payload: Dict[str, Any] = {"sessionId": session_id}
    if body.pairing_phone:
        # Strip any non-digit characters before sending to bridge
        bridge_payload["pairingPhone"] = "".join(c for c in body.pairing_phone if c.isdigit())
    bridge_resp = await _bridge_post("/sessions", bridge_payload)
    label = body.label or f"Number {session_id[-6:]}"
    db = _db()
    await db["whatsapp_sessions"].insert_one({
        "session_id": session_id,
        "label": label,
        "added_by": current_user.id,
        "added_by_name": current_user.full_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "connecting",
    })
    _invalidate_sessions_cache()  # force fresh data on next poll
    mode = "pair-code" if body.pairing_phone else "qr"
    return {
        "sessionId": session_id,
        "label": label,
        "message": f"Poll /whatsapp/sessions/{{id}}/{mode} for {'pairing code' if body.pairing_phone else 'QR code'}.",
    }


@router.get("/sessions/{session_id}/qr")
async def get_session_qr(session_id: str, current_user: User = Depends(require_admin())):
    return await _bridge_get(f"/sessions/{session_id}/qr")


@router.get("/sessions/{session_id}/pair-code")
async def get_session_pair_code(session_id: str, current_user: User = Depends(require_admin())):
    """
    Return the phone pairing code for a session started in phone-pairing mode.
    The wa-bridge stores the code in sessions[sessionId].pairCode after calling
    sock.requestPairingCode(). This endpoint proxies that value back to the frontend.
    Returns: { code: "ABCD1234" | null, status: str }
    """
    return await _bridge_get(f"/sessions/{session_id}/pair-code")


@router.delete("/sessions/{session_id}")
async def remove_session(session_id: str, current_user: User = Depends(require_admin())):
    await _bridge_delete(f"/sessions/{session_id}")
    await _db()["whatsapp_sessions"].delete_one({"session_id": session_id})
    _invalidate_sessions_cache()
    return {"message": f"Session {session_id} removed"}


@router.patch("/sessions/{session_id}/label")
async def update_session_label(session_id: str, body: WASessionCreate, current_user: User = Depends(require_admin())):
    await _db()["whatsapp_sessions"].update_one({"session_id": session_id}, {"$set": {"label": body.label}})
    _invalidate_sessions_cache()
    return {"message": "Label updated"}


@router.post("/bridge/sessions/{session_id}/sync")
async def force_session_sync(session_id: str, current_user: User = Depends(get_current_user)):
    """
    Proxy for the WhatsApp Hub's manual/auto "Force Sync" action.

    This route was missing entirely — the frontend (WhatsAppHub.jsx
    handleForceSync, and the auto-sync-on-connect effect) has always called
    POST /whatsapp/bridge/sessions/{id}/sync, but no backend route existed
    for it, so every call 404'd silently (swallowed by a .catch on the
    frontend). That meant sessions could show "connected" while the Hub's
    inbox stayed empty forever, with no visible error.

    The bridge's /sessions/:id/sync endpoint (now fixed to re-push cached
    chat/message history, not just groups) is what actually repopulates
    MongoDB so GET /whatsapp/hub/inbox has something to return.
    """
    from backend.whatsapp_hub import _has_hub_access
    if not (current_user.role == "admin" or await _has_hub_access(current_user)):
        raise HTTPException(403, "You do not have WhatsApp Hub access.")
    return await _bridge_post(f"/sessions/{session_id}/sync", {})


# ── Webhooks from bridge ─────────────────────────────────────────────────────

@router.post("/webhook/connected")
async def wa_connected_webhook(payload: Dict[str, Any]):
    session_id = payload.get("sessionId")
    await _db()["whatsapp_sessions"].update_one(
        {"session_id": session_id},
        {"$set": {
            "phone_number": payload.get("phoneNumber"),
            "display_name": payload.get("displayName"),
            "status": "connected",
            "connected_at": payload.get("connectedAt"),
        }},
        upsert=True,
    )
    _invalidate_sessions_cache()  # status changed — next poll gets fresh data
    logger.info("WA connected: %s (%s)", payload.get("displayName"), payload.get("phoneNumber"))
    return {"ok": True}


@router.post("/webhook/disconnected")
async def wa_disconnected_webhook(payload: Dict[str, Any]):
    session_id = payload.get("sessionId")
    if session_id:
        await _db()["whatsapp_sessions"].update_one(
            {"session_id": session_id},
            {"$set": {"status": "disconnected", "disconnected_at": datetime.now(timezone.utc).isoformat()}},
        )
    _invalidate_sessions_cache()  # status changed — next poll gets fresh data
    return {"ok": True}


# ── User access requests ─────────────────────────────────────────────────────

@router.post("/access/request")
async def request_wa_access(body: WAAccessRequest, current_user: User = Depends(get_current_user)):
    if current_user.role == "admin":
        return {"message": "Admins always have access"}
    existing = await _db()["whatsapp_access_requests"].find_one({
        "user_id": current_user.id, "status": {"$in": ["pending", "approved"]}
    })
    if existing:
        return {"message": "Request already exists", "status": existing["status"]}
    await _db()["whatsapp_access_requests"].insert_one({
        "user_id": current_user.id, "user_name": current_user.full_name,
        "user_email": current_user.email, "reason": body.reason,
        "status": "pending", "requested_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"message": "Access request submitted. Awaiting admin approval."}


@router.get("/access/my-status")
async def my_wa_access_status(current_user: User = Depends(get_current_user)):
    if current_user.role == "admin":
        return {"access": "admin", "status": "approved"}
    rec = await _db()["whatsapp_access_requests"].find_one(
        {"user_id": current_user.id}, sort=[("requested_at", -1)]
    )
    if not rec:
        return {"access": "none", "status": "not_requested"}
    return {"access": "user", "status": rec["status"], "admin_note": rec.get("admin_note")}


@router.get("/access/requests")
async def list_access_requests(status_filter: Optional[str] = None, current_user: User = Depends(require_admin())):
    query = {"status": status_filter} if status_filter else {}
    docs = await _db()["whatsapp_access_requests"].find(query).sort("requested_at", -1).to_list(200)
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return docs


@router.post("/access/decide")
async def decide_access_request(body: WAAccessDecision, current_user: User = Depends(require_admin())):
    new_status = "approved" if body.approved else "rejected"
    result = await _db()["whatsapp_access_requests"].update_one(
        {"user_id": body.user_id, "status": "pending"},
        {"$set": {"status": new_status, "decided_by": current_user.full_name,
                  "decided_at": datetime.now(timezone.utc).isoformat(), "admin_note": body.admin_note}},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Pending request not found")
    return {"message": f"Access {new_status}"}


# ── Send ─────────────────────────────────────────────────────────────────────

@router.post("/send")
async def send_message(body: WASendMessageRequest, current_user: User = Depends(get_current_user)):
    if not await _has_wa_access(current_user):
        raise HTTPException(403, "You do not have permission to send WhatsApp messages.")
    try:
        result = await _bridge_post("/send", {"to": body.to, "message": body.message, "sessionId": body.session_id})
        await _store_message(current_user.id, body.to, body.message, body.message_type, body.context_id, "sent", body.session_id, batch_id=body.batch_id, batch_name=body.batch_name)
        return {"success": True, "messageId": result.get("messageId")}
    except Exception as exc:
        await _store_message(current_user.id, body.to, body.message, body.message_type, body.context_id, "failed", body.session_id, str(exc), batch_id=body.batch_id, batch_name=body.batch_name)
        raise


@router.post("/send/bulk")
async def send_bulk(body: WABulkSendRequest, current_user: User = Depends(get_current_user)):
    if not await _has_wa_access(current_user):
        raise HTTPException(403, "WhatsApp access not granted")
    results = []
    for recipient in body.recipients:
        try:
            await _bridge_post("/send", {"to": recipient, "message": body.message, "sessionId": body.session_id})
            await _store_message(current_user.id, recipient, body.message, body.message_type, body.context_id, "sent", body.session_id, batch_id=body.batch_id, batch_name=body.batch_name)
            results.append({"to": recipient, "status": "sent"})
        except Exception as exc:
            await _store_message(current_user.id, recipient, body.message, body.message_type, body.context_id, "failed", body.session_id, str(exc), batch_id=body.batch_id, batch_name=body.batch_name)
            results.append({"to": recipient, "status": "failed", "error": str(exc)})
        await asyncio.sleep(0.8)
    return {"results": results}


@router.post("/send-media")
async def send_media(body: WASendMediaRequest, current_user: User = Depends(get_current_user)):
    """Send an image, PDF, Excel, or other document via WhatsApp.

    Calls /send-media-base64 on the bridge (a dedicated JSON endpoint that is
    NOT wrapped in multer), so the base64 payload is parsed correctly.
    Previously this called /send-media which applies multer middleware for
    multipart uploads — that caused multer to skip express.json() parsing
    and silently drop the base64 field, causing every media send to fail.
    """
    if not await _has_wa_access(current_user):
        raise HTTPException(403, "You do not have permission to send WhatsApp messages.")
    try:
        result = await _bridge_post_large("/send-media-base64", {
            "to":        body.to,
            "sessionId": body.session_id,
            "caption":   body.caption,
            "base64":    body.base64,
            "mimeType":  body.mime_type,
            "filename":  body.filename,
        })
        caption_log = f"[{body.filename}] {body.caption or ''}"
        await _store_message(current_user.id, body.to, caption_log, body.message_type, body.context_id, "sent", body.session_id, batch_id=body.batch_id, batch_name=body.batch_name)
        return {"success": True, "messageId": result.get("messageId"), "filename": body.filename}
    except Exception as exc:
        await _store_message(current_user.id, body.to, f"[media:{body.filename}]", body.message_type, body.context_id, "failed", body.session_id, str(exc), batch_id=body.batch_id, batch_name=body.batch_name)
        raise


@router.get("/status")
async def get_wa_status(current_user: User = Depends(get_current_user)):
    # FIX: uses same 15s cache as list_sessions — zero extra bridge hits
    sessions = await _get_cached_sessions()
    connected = [s for s in sessions if s.get("status") == "connected"]
    return {
        "connected": len(connected) > 0,
        "sessions_count": len(sessions),
        "connected_count": len(connected),
    }


@router.get("/messages")
async def list_messages(message_type: Optional[str] = None, batch_id: Optional[str] = None, limit: int = 50, current_user: User = Depends(get_current_user)):
    query: Dict[str, Any] = {}
    if current_user.role != "admin":
        query["sent_by"] = current_user.id
    if message_type:
        query["message_type"] = message_type
    if batch_id:
        query["batch_id"] = batch_id
    docs = await _db()["whatsapp_messages"].find(query).sort("sent_at", -1).limit(limit).to_list(limit)
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return docs


@router.get("/batches")
async def list_batches(limit: int = 100, current_user: User = Depends(get_current_user)):
    """Return WhatsApp send batches with per-batch summary.

    Groups whatsapp_messages by batch_id. Non-admins see only their own batches.
    """
    match: Dict[str, Any] = {"batch_id": {"$ne": None}}
    if current_user.role != "admin":
        match["sent_by"] = current_user.id
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$batch_id",
            "batch_name": {"$last": "$batch_name"},
            "total": {"$sum": 1},
            "sent": {"$sum": {"$cond": [{"$in": ["$status", ["sent", "delivered", "read"]]}, 1, 0]}},
            "failed": {"$sum": {"$cond": [{"$in": ["$status", ["failed", "error"]]}, 1, 0]}},
            "first_at": {"$min": "$sent_at"},
            "last_at": {"$max": "$sent_at"},
            "sent_by": {"$last": "$sent_by"},
        }},
        {"$sort": {"last_at": -1}},
        {"$limit": limit},
    ]
    docs = await _db()["whatsapp_messages"].aggregate(pipeline).to_list(limit)
    return [
        {
            "batch_id": d["_id"],
            "batch_name": d.get("batch_name") or d["_id"],
            "total": d.get("total", 0),
            "sent": d.get("sent", 0),
            "failed": d.get("failed", 0),
            "first_at": d.get("first_at"),
            "last_at": d.get("last_at"),
            "sent_by": d.get("sent_by"),
        }
        for d in docs
    ]


# ── Internal helper ──────────────────────────────────────────────────────────

async def send_whatsapp_notification(to, message, message_type="general", context_id=None, sent_by="system", session_id=None):
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{WA_BRIDGE_URL}/send", json={"to": to, "message": message, "sessionId": session_id})
            r.raise_for_status()
        status_val, error = "sent", None
    except Exception as exc:
        logger.error("WA notification failed to %s: %s", to, exc)
        status_val, error = "failed", str(exc)
    try:
        await _db()["whatsapp_messages"].insert_one({
            "sent_by": sent_by, "to": to, "message": message, "message_type": message_type,
            "context_id": context_id, "session_id": session_id, "status": status_val,
            "error": error, "sent_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        pass


async def send_whatsapp_media_notification(
    to, image_url, caption="", message_type="general", context_id=None,
    sent_by="system", session_id=None,
):
    """
    Non-route counterpart to /send-media, for internal callers (automation
    jobs, schedulers) that only have an image URL, not an uploaded file.
    Fetches the image, base64-encodes it, and posts to the bridge exactly
    like the /send-media route does. Falls back to a plain text send
    (caption only) if the image can't be fetched, so a bad/expired image
    URL never blocks the message itself from going out.
    """
    import base64 as _b64
    filename = image_url.rsplit("/", 1)[-1].split("?")[0] or "image.jpg"
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            img_resp = await c.get(image_url)
            img_resp.raise_for_status()
        mime_type = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
        b64_data = _b64.b64encode(img_resp.content).decode("ascii")

        result = await _bridge_post_large("/send-media-base64", {
            "to": to, "sessionId": session_id, "caption": caption,
            "base64": b64_data, "mimeType": mime_type, "filename": filename,
        })
        status_val, error = "sent", None
        log_text = f"[{filename}] {caption}"
    except Exception as exc:
        logger.error("WA media notification failed to %s (%s), falling back to text-only: %s", to, image_url, exc)
        # Fallback: send the caption as a plain message so the wish still goes out.
        await send_whatsapp_notification(to, caption, message_type, context_id, sent_by, session_id)
        return
    try:
        await _db()["whatsapp_messages"].insert_one({
            "sent_by": sent_by, "to": to, "message": log_text, "message_type": message_type,
            "context_id": context_id, "session_id": session_id, "status": status_val,
            "error": error, "sent_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        pass


# ── Auto-Send Settings (global) ───────────────────────────────────────────────
# Stored in the `whatsapp_settings` collection as a single doc (_id="global").
# Controls whether each automatic WhatsApp job runs, plus the default birthday
# message template. NOTHING is ever sent unless a WhatsApp number is connected.

DEFAULT_AUTO_SETTINGS = {
    "birthday_enabled": True,
    "dsc_enabled": True,
    "compliance_enabled": True,
    "birthday_template": (
        "🎂 *Happy Birthday, {name}!*\n\n"
        "Wishing you a wonderful birthday filled with joy and prosperity! 🎉\n\n"
        "Best wishes,\n_Taskosphere Team_"
    ),
}


async def get_auto_settings() -> Dict[str, Any]:
    """Return the global auto-send settings, merged over defaults."""
    try:
        doc = await _db()["whatsapp_settings"].find_one({"_id": "global"}) or {}
    except Exception:
        doc = {}
    merged = dict(DEFAULT_AUTO_SETTINGS)
    for k in DEFAULT_AUTO_SETTINGS:
        if doc.get(k) is not None:
            merged[k] = doc[k]
    return merged


class WAAutoSettings(BaseModel):
    # birthday_enabled / birthday_template are DEPRECATED — birthday
    # automation (WhatsApp + Email, approval gate, images) now lives
    # entirely in backend/automation_engine.py's AutomationSettings.
    # Left here only so old stored docs don't fail validation; the daily
    # scheduler no longer reads these two fields.
    birthday_enabled: Optional[bool] = None
    dsc_enabled: Optional[bool] = None
    compliance_enabled: Optional[bool] = None
    birthday_template: Optional[str] = None


@router.get("/auto-settings")
async def read_auto_settings(current_user: User = Depends(get_current_user)):
    return await get_auto_settings()


@router.put("/auto-settings")
async def update_auto_settings(body: WAAutoSettings, current_user: User = Depends(require_admin())):
    update = {k: v for k, v in body.dict().items() if v is not None}
    if update:
        await _db()["whatsapp_settings"].update_one(
            {"_id": "global"}, {"$set": update}, upsert=True
        )
    return await get_auto_settings()


class WAClientAutoSend(BaseModel):
    auto_birthday_enabled: Optional[bool] = None
    birthday_message: Optional[str] = None


@router.put("/client-autosend/{client_id}")
async def update_client_autosend(client_id: str, body: WAClientAutoSend, current_user: User = Depends(get_current_user)):
    """Per-client WhatsApp auto-send config (on/off + custom birthday message)."""
    if not await _has_wa_access(current_user):
        raise HTTPException(403, "WhatsApp access not granted")
    update: Dict[str, Any] = {}
    if body.auto_birthday_enabled is not None:
        update["wa_auto_birthday"] = body.auto_birthday_enabled
    if body.birthday_message is not None:
        update["wa_birthday_message"] = body.birthday_message
    if not update:
        raise HTTPException(400, "No fields to update")
    result = await _db()["clients"].update_one({"id": client_id}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Client not found")
    return {"client_id": client_id, **update}



@router.post("/jobs/run/{job_name}")
async def trigger_job_manually(job_name: str, current_user: User = Depends(require_admin())):
    from backend.whatsapp_scheduler import _send_dsc_expiry_alerts, _send_compliance_reminders
    from backend.automation_engine import run_birthday_automation
    # "birthday" is intentionally NOT _send_birthday_wishes (deprecated, see
    # whatsapp_scheduler.py) — it now runs the same automation-engine job the
    # daily cron uses, so a manual trigger still respects the approval gate,
    # email channel, and activity-timeline logging instead of bypassing them.
    JOBS = {"birthday": run_birthday_automation, "dsc_expiry": _send_dsc_expiry_alerts, "compliance": _send_compliance_reminders}
    fn = JOBS.get(job_name)
    if not fn:
        raise HTTPException(400, f"Unknown job '{job_name}'")
    try:
        await fn()
        return {"message": f"Job '{job_name}' completed"}
    except Exception as exc:
        raise HTTPException(500, f"Job failed: {exc}")


# ── Scheduled Bulk Send ──────────────────────────────────────────────────────

class WAScheduledRecipient(BaseModel):
    phone: str
    message: str
    client_id: Optional[str] = None
    client_name: Optional[str] = None

class WAScheduleBulkRequest(BaseModel):
    recipients: List[WAScheduledRecipient]
    scheduled_at: str   # ISO datetime string e.g. "2026-05-26T09:00:00"
    message_template: Optional[str] = None
    message_type: str = "bulk_scheduled"
    session_id: Optional[str] = None


@router.post("/schedule-bulk")
async def schedule_bulk_send(body: WAScheduleBulkRequest, current_user: User = Depends(get_current_user)):
    """Schedule a bulk personalized WhatsApp send at a future datetime."""
    if not await _has_wa_access(current_user):
        raise HTTPException(403, "WhatsApp access not granted")
    db = _db()
    company_id = None if is_platform_owner(current_user) else enforce_company_value(current_user, None)
    job_id = f"bulk_{int(_time.time() * 1000)}"
    job_doc = {
        "job_id": job_id,
        "company_id": company_id,
        "created_by": current_user.id,
        "created_by_name": current_user.full_name,
        "scheduled_at": body.scheduled_at,
        "message_template": body.message_template,
        "message_type": body.message_type,
        "session_id": body.session_id,
        "recipient_count": len(body.recipients),
        "recipients": [r.dict() for r in body.recipients],
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db["whatsapp_scheduled_bulk"].insert_one(job_doc)
    logger.info("Scheduled bulk WA job %s for %s (%d recipients)", job_id, body.scheduled_at, len(body.recipients))
    return {"job_id": job_id, "scheduled_at": body.scheduled_at, "recipient_count": len(body.recipients)}


@router.get("/scheduled-bulk")
async def list_scheduled_bulk(current_user: User = Depends(get_current_user)):
    """List pending scheduled bulk jobs."""
    db = _db()
    company_id = None if is_platform_owner(current_user) else enforce_company_value(current_user, None)
    query = {"status": "pending"}
    if company_id is not None:
        query["company_id"] = company_id
    if current_user.role != "admin":
        query["created_by"] = current_user.id
    jobs = await db["whatsapp_scheduled_bulk"].find(query).sort("scheduled_at", 1).to_list(100)
    for j in jobs:
        j["id"] = str(j.pop("_id"))
        j.pop("recipients", None)   # don't return full recipient list in listing
    return {"jobs": jobs}


@router.delete("/scheduled-bulk/{job_id}")
async def cancel_scheduled_bulk(job_id: str, current_user: User = Depends(get_current_user)):
    """Cancel a pending scheduled bulk job."""
    db = _db()
    company_id = None if is_platform_owner(current_user) else enforce_company_value(current_user, None)
    query = {"job_id": job_id, "status": "pending"}
    if company_id is not None:
        query["company_id"] = company_id
    if current_user.role != "admin":
        query["created_by"] = current_user.id
    result = await db["whatsapp_scheduled_bulk"].update_one(query, {"$set": {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}})
    if result.matched_count == 0:
        raise HTTPException(404, "Job not found or already processed")
    return {"message": "Job cancelled"}


async def _run_scheduled_bulk_jobs():
    """
    Called by APScheduler every minute. Finds pending jobs whose scheduled_at
    has passed and sends them via the WA bridge.
    """
    db = _db()
    # Never send unless a WhatsApp number is connected
    try:
        sessions = await _get_cached_sessions()
        if not any(s.get("status") == "connected" for s in sessions):
            logger.info("[WA Scheduled Bulk] skipped — no WhatsApp connected")
            return
    except Exception:
        logger.info("[WA Scheduled Bulk] skipped — connection check failed")
        return
    now_str = datetime.now(timezone.utc).isoformat()
    jobs = await db["whatsapp_scheduled_bulk"].find({
        "status": "pending",
        "scheduled_at": {"$lte": now_str},
    }).to_list(20)

    for job in jobs:
        job_id = job["job_id"]
        await db["whatsapp_scheduled_bulk"].update_one(
            {"job_id": job_id, "status": "pending"},
            {"$set": {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()}}
        )
        results = []
        for r in job.get("recipients", []):
            try:
                await _bridge_post("/send", {"to": r["phone"], "message": r["message"], "sessionId": job.get("session_id")})
                await _store_message(
                    sent_by=f"scheduler:bulk:{job_id}",
                    to=r["phone"], message=r["message"],
                    message_type=job.get("message_type", "bulk_scheduled"),
                    context_id=r.get("client_id"), status_val="sent", session_id=job.get("session_id"),
                )
                results.append({"phone": r["phone"], "status": "sent"})
            except Exception as exc:
                results.append({"phone": r["phone"], "status": "failed", "error": str(exc)})
            await asyncio.sleep(0.8)
        sent = sum(1 for r in results if r["status"] == "sent")
        failed = sum(1 for r in results if r["status"] == "failed")
        await db["whatsapp_scheduled_bulk"].update_one(
            {"job_id": job_id},
            {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc).isoformat(),
                      "sent_count": sent, "failed_count": failed, "results": results}}
        )
        logger.info("Bulk job %s completed: sent=%d failed=%d", job_id, sent, failed)


def wa_scheduled_bulk_job():
    """APScheduler sync wrapper — run every minute.

    APScheduler calls this from a background thread, but Motor (async MongoDB)
    is bound to the main Uvicorn event loop.  Creating a *new* event loop here
    causes "Future attached to a different loop".  Instead we schedule the
    coroutine on the already-running main loop.

    We do NOT block-and-wait here anymore: large recipient batches (each
    recipient costs ~0.8s+ network latency) can easily exceed the 60s
    scheduler interval, which previously caused this wrapper to time out,
    collide with the next scheduled run, and cascade into a growing backlog
    of missed/skipped executions. Firing-and-forgetting lets the bulk job
    run to completion on the main loop regardless of how long it takes,
    while _bulk_job_lock prevents two bulk runs from overlapping.
    """
    global _bulk_job_running
    if _bulk_job_running:
        logger.info("wa_scheduled_bulk_job: previous run still in progress, skipping this tick.")
        return
    try:
        from backend.server import app_event_loop
        if app_event_loop is None or app_event_loop.is_closed():
            logger.warning("wa_scheduled_bulk_job: main event loop not available yet, skipping.")
            return

        async def _guarded_run():
            global _bulk_job_running
            _bulk_job_running = True
            try:
                await _run_scheduled_bulk_jobs()
            except Exception as exc:
                logger.error("wa_scheduled_bulk_job failed: %s: %s", type(exc).__name__, exc)
            finally:
                _bulk_job_running = False

        asyncio.run_coroutine_threadsafe(_guarded_run(), app_event_loop)
    except Exception as exc:
        _bulk_job_running = False
        logger.error("wa_scheduled_bulk_job failed to schedule: %s: %s", type(exc).__name__, exc)
