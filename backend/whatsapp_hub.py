"""
whatsapp_hub.py — v3.0 (media support + SSE real-time + full history)
  ★ filename/file_size stored on all incoming messages
  ★ SSE /events endpoint for real-time frontend push
  ★ _push_sse called on every incoming webhook message
  ★ hub_conversation default limit raised to 200
  ★ Groups support + @lid safety (unchanged from v2.1)
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.dependencies import require_commercial_admin_module, require_commercial_admin_page, get_current_user, require_admin
from backend.models import User
from backend.commercial_user_company_scope import _scope_user_query
from backend.platform_owner import is_platform_owner as _is_platform_owner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/whatsapp/hub", tags=["whatsapp-hub"])


# ── WhatsApp natural-language lead automation (additive) ────────────────────
# This feature is intentionally isolated from Telegram and from the existing
# WhatsApp message/inbox behavior. It runs in a background task after the
# incoming message has already been stored successfully.
WHATSAPP_LEAD_AI_MIN_CONFIDENCE = 0.75


async def _process_whatsapp_lead_in_background(
    *,
    message: str,
    jid: str,
    session_id: str,
    message_id: str,
    sender_phone: Optional[str],
    sender_name: Optional[str],
    group_subject: Optional[str],
) -> None:
    """
    AI-read one WhatsApp group message and create/update an existing Lead.

    This is deliberately best-effort: a failure here must NEVER make the
    existing WhatsApp webhook fail or affect message storage/SSE.
    """
    try:
        from backend.whatsapp_lead_ai import detect_and_extract_whatsapp_lead

        result = await detect_and_extract_whatsapp_lead(message)
        if not result.get("is_lead"):
            return

        confidence = float(result.get("confidence") or 0.0)
        if confidence < WHATSAPP_LEAD_AI_MIN_CONFIDENCE:
            logger.info(
                "WhatsApp lead AI skipped low-confidence message: confidence=%.2f group=%s message_id=%s",
                confidence, group_subject, message_id,
            )
            return

        lead = result.get("lead") or {}
        db = _db()

        phone = (lead.get("phone") or sender_phone or "").strip() or None
        contact_name = (lead.get("contact_name") or sender_name or "").strip() or None
        company_name = (lead.get("company_name") or "").strip() or None
        trademark_name = (lead.get("trademark_name") or "").strip() or None
        services = lead.get("services") or []
        notes = (lead.get("notes") or "").strip() or None

        # Existing LeadCreate historically requires company_name. Until that
        # field is made optional in a separate additive update, use the most
        # meaningful available identity rather than inventing a company.
        if not company_name:
            company_name = contact_name or trademark_name or "WhatsApp Lead"

        # Prevent duplicate creation when the same WhatsApp lead is received
        # again. Phone is the strongest match; otherwise use contact/company
        # + trademark when available.
        existing = None
        if phone:
            digits = "".join(ch for ch in phone if ch.isdigit())
            if len(digits) >= 7:
                existing = await db.leads.find_one({
                    "phone": {"$regex": digits[-10:] + "$"}
                })

        if not existing and contact_name and trademark_name:
            existing = await db.leads.find_one({
                "contact_name": contact_name,
                "whatsapp_original_message": {"$exists": True},
                "whatsapp_group_jid": jid,
                "trademark_name": trademark_name,
            })

        if existing:
            lead_id = str(existing.get("_id"))
            await db.leads.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "updated_at": datetime.now(timezone.utc),
                    "whatsapp_message_id": message_id,
                    "whatsapp_original_message": message,
                    "whatsapp_group_name": group_subject,
                    "whatsapp_group_jid": jid,
                    "whatsapp_sender_phone": sender_phone,
                    "whatsapp_sender_name": sender_name,
                }, "$addToSet": {
                    "services": {"$each": services},
                }},
            )
            await db.whatsapp_hub_messages.update_one(
                {"message_id": message_id, "session_id": session_id},
                {"$set": {
                    "lead_automation": "duplicate_updated",
                    "lead_id": lead_id,
                    "lead_ai_confidence": confidence,
                }},
            )
            logger.info("WhatsApp lead duplicate updated: lead_id=%s group=%s", lead_id, group_subject)
            return

        # Use an admin account as the system creator so normal Lead Management
        # ownership/visibility rules remain compatible with existing leads.
        creator = await db.users.find_one(
            {"role": {"$in": ["admin", "Admin"]}},
            {"id": 1},
        )
        created_by = (creator or {}).get("id")
        if not created_by:
            logger.warning("WhatsApp lead not created: no admin user available for created_by")
            return

        now = datetime.now(timezone.utc)
        lead_doc = {
            "company_name": company_name,
            "contact_name": contact_name,
            "email": lead.get("email"),
            "phone": phone,
            "services": services,
            "status": "new",
            "source": "whatsapp",
            "notes": notes,
            "assigned_to": None,
            "created_by": created_by,
            "created_at": now,
            "updated_at": now,
            "checklist_sent": False,
            "documents_received": False,
            "whatsapp_group_jid": jid,
            "whatsapp_group_name": group_subject,
            "whatsapp_message_id": message_id,
            "whatsapp_sender_phone": sender_phone,
            "whatsapp_sender_name": sender_name,
            "whatsapp_original_message": message,
            "lead_ai_confidence": confidence,
        }
        if trademark_name:
            lead_doc["trademark_name"] = trademark_name

        result = await db.leads.insert_one(lead_doc)
        lead_id = str(result.inserted_id)

        await db.whatsapp_hub_messages.update_one(
            {"message_id": message_id, "session_id": session_id},
            {"$set": {
                "lead_automation": "lead_created",
                "lead_id": lead_id,
                "lead_ai_confidence": confidence,
            }},
        )
        logger.info(
            "WhatsApp lead created: lead_id=%s contact=%s group=%s",
            lead_id, contact_name, group_subject,
        )
    except Exception:
        logger.exception(
            "WhatsApp lead automation failed without affecting message webhook: group=%s message_id=%s",
            group_subject, message_id,
        )

# ── SSE client registry ──────────────────────────────────────────────────────
_sse_queues: List[asyncio.Queue] = []


def _push_sse(event: str, data: dict) -> None:
    """Push an event to all connected SSE clients (non-blocking)."""
    if not _sse_queues:
        return
    payload = {"event": event, "data": data}
    dead = []
    for q in list(_sse_queues):
        try:
            q.put_nowait(payload)
        except Exception:
            dead.append(q)
    for q in dead:
        try:
            _sse_queues.remove(q)
        except ValueError:
            pass


def _safe(doc: dict) -> dict:
    """Strip MongoDB _id (ObjectId) so FastAPI can serialize the document."""
    if not doc:
        return {}
    from bson import ObjectId
    from datetime import datetime
    out = {}
    for k, v in doc.items():
        if k == "_id":
            continue
        if isinstance(v, ObjectId):
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, dict):
            out[k] = _safe(v)
        elif isinstance(v, list):
            out[k] = [_safe(i) if isinstance(i, dict) else i for i in v]
        else:
            out[k] = v
    return out


def _db():
    from backend.server import db
    return db


def _is_real_name(name: Optional[str], phone: str) -> bool:
    """A 'real' name is non-empty and isn't just the phone number/digits."""
    if not name:
        return False
    name = name.strip()
    if not name:
        return False
    digits_only = name.replace("+", "").replace(" ", "")
    if digits_only.isdigit():
        return False
    if phone and name == phone:
        return False
    return True


def _better_name(candidate: Optional[str], existing: Optional[str], phone: str) -> Optional[str]:
    """
    Decide what a contact's display_name should become.

    Root cause this guards against: every incoming message (and every row in
    a bulk history sync) used to unconditionally overwrite the contact's
    stored display_name with that single message's `contact_name`. Since
    `contact_name` is sourced from WhatsApp's `pushName` field — which is
    frequently empty/unreliable on synced history and, for some message
    shapes, reflects the *connected account's own* profile name rather than
    the actual sender — a contact's real, address-book-derived name kept
    getting clobbered back down to a phone number (or someone else's name)
    on the very next message. This makes the update an "upgrade only" merge:
    a real name is never replaced by a worse one (missing, or just digits).
    """
    if _is_real_name(candidate, phone) and not _is_real_name(existing, phone):
        return candidate.strip()
    if _is_real_name(existing, phone):
        return existing
    return candidate if candidate else (existing or phone)


def _last10(phone: str) -> str:
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else digits


_NAME_CACHE_TTL_S = 120
_crm_name_cache: Dict[str, tuple] = {}  # phone10 -> (name_or_None, fetched_at_epoch)


async def _lookup_crm_name(db, phone: str) -> Optional[str]:
    """
    Cross-reference a WhatsApp phone number against Taskosphere's own data —
    Clients (company + each saved contact person) and Users (staff) — and
    return the best human name on file, if any.

    This exists because WhatsApp's own address-book sync (via the unofficial
    Baileys library) is well known to be inconsistent — sometimes it never
    arrives at all, even for numbers genuinely saved on the connected phone
    (this is a widely reported upstream limitation, not something fixable
    from the bridge side). For a CRM like Taskosphere, the phone numbers of
    real contacts are usually already on file under Clients/Users, so that's
    a far more reliable source of truth than waiting on WhatsApp's sync.
    """
    p10 = _last10(phone)
    if len(p10) < 7:
        return None

    import time
    cached = _crm_name_cache.get(p10)
    if cached and (time.time() - cached[1]) < _NAME_CACHE_TTL_S:
        return cached[0]

    name = None
    try:
        client = await db["clients"].find_one(
            {"$or": [{"phone": {"$regex": p10 + "$"}}, {"contact_persons.phone": {"$regex": p10 + "$"}}]},
            {"company_name": 1, "contact_persons": 1, "phone": 1},
        )
        if client:
            person_match = next(
                (cp for cp in (client.get("contact_persons") or []) if _last10(cp.get("phone") or "") == p10),
                None,
            )
            if person_match and person_match.get("name"):
                company = client.get("company_name")
                name = f"{person_match['name']} ({company})" if company else person_match["name"]
            elif client.get("company_name"):
                name = client["company_name"]
        if not name:
            user = await db["users"].find_one(
                {"phone": {"$regex": p10 + "$"}}, {"full_name": 1, "email": 1}
            )
            if user:
                name = user.get("full_name") or user.get("email")
    except Exception as e:
        logger.warning("CRM name lookup failed for %s: %s", p10, e)

    _crm_name_cache[p10] = (name, time.time())
    return name


async def _resolve_contact_name(
    db, jid: str, phone: str, candidate: Optional[str], existing_doc: Optional[dict],
    is_group: bool, group_subject: Optional[str] = None,
) -> str:
    """
    Single source of truth for what a contact's display_name should be,
    in priority order: a manual rename always wins (never auto-overwritten);
    then a CRM match (Clients/Users — Taskosphere's own, reliable data);
    then whatever real name WhatsApp itself supplied; finally the phone
    number as a last resort, exactly like WhatsApp Web does for unsaved
    numbers.
    """
    if is_group:
        return group_subject or (existing_doc or {}).get("display_name") or "Group"
    if existing_doc and existing_doc.get("name_locked"):
        return existing_doc.get("display_name") or phone
    crm_name = await _lookup_crm_name(db, phone)
    if crm_name:
        return crm_name
    existing_name = (existing_doc or {}).get("display_name")
    return _better_name(candidate, existing_name, phone) or phone


async def _has_hub_access(user: User) -> bool:
    if user.role == "admin":
        return True
    # Users are stored with a UUID string in the "id" field, not MongoDB's "_id".
    # Querying by "_id" (ObjectId) against a UUID string always returns None →
    # every non-admin call was silently returning False (403). Fixed to use "id".
    doc = await _db()["users"].find_one({"id": user.id})
    return bool(doc and doc.get("wa_hub_access"))


async def _resolve_send_jid(jid: str, session_id: str) -> Optional[str]:
    if jid.endswith("@g.us") or jid.endswith("@s.whatsapp.net"):
        return jid
    if not jid.endswith("@lid"):
        return jid
    from backend.whatsapp_integration import _bridge_get
    try:
        import urllib.parse
        encoded = urllib.parse.quote(jid, safe="")
        result  = await _bridge_get(f"/sessions/{session_id}/resolve-jid?jid={encoded}")
        if result.get("safe_to_send"):
            return result.get("resolved_jid")
        return None
    except Exception as e:
        logger.warning("JID resolution failed for %s: %s", jid, e)
        return None


# ── Pydantic ─────────────────────────────────────────────────────────────────

class HubReply(BaseModel):
    jid: str
    message: str = Field(..., min_length=1, max_length=4096)
    session_id: Optional[str] = None


class HubReplyMedia(BaseModel):
    jid: str
    session_id: Optional[str] = None
    base64: str
    mime_type: str
    filename: str = "file"
    caption: Optional[str] = None


class ConversationAssign(BaseModel):
    user_id: Optional[str] = None


class HubAccessUpdate(BaseModel):
    user_id: str
    grant: bool


# ── Webhook: single incoming message ─────────────────────────────────────────

@router.post("/webhook/message")
async def hub_incoming_message(request: Request):
    try:
        payload: Dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    jid          = (payload.get("jid") or "").strip()
    session_id   = payload.get("session_id", "unknown")
    msg_id       = payload.get("message_id", "")
    body         = payload.get("body", "")
    is_group     = bool(payload.get("is_group"))
    sender_jid   = payload.get("sender_jid")
    sender_phone = payload.get("sender_phone")
    group_subj   = payload.get("group_subject")

    if not jid or not body:
        return {"ok": True}

    ts_raw = payload.get("timestamp")
    ts     = datetime.fromtimestamp(ts_raw, tz=timezone.utc) if ts_raw else datetime.now(timezone.utc)
    db     = _db()

    if msg_id and await db["whatsapp_hub_messages"].find_one({"message_id": msg_id, "session_id": session_id}):
        return {"ok": True, "duplicate": True}

    phone = jid.split("@")[0]
    await db["whatsapp_hub_messages"].insert_one({
        "jid":           jid,
        "message_id":    msg_id,
        "session_id":    session_id,
        "session_label": payload.get("session_label", session_id),
        "direction":     "in",
        "from":          payload.get("from", phone),
        "to":            session_id,
        "is_group":      is_group,
        "sender_jid":    sender_jid,
        "sender_phone":  sender_phone,
        "contact_name":  payload.get("contact_name"),
        "body":          body,
        "media_url":     payload.get("media_url"),
        "media_type":    payload.get("media_type"),
        "filename":      payload.get("filename"),     # ★ v3.0
        "file_size":     payload.get("file_size"),    # ★ v3.0
        "timestamp":     ts,
        "read":          False,
        "assigned_to":   None,
    })

    # Additive WhatsApp lead automation. The existing message processing above
    # remains synchronous and unchanged; AI runs in the background so it cannot
    # slow down or break the WhatsApp webhook. Telegram is not involved.
    if is_group and body.strip():
        asyncio.create_task(
            _process_whatsapp_lead_in_background(
                message=body,
                jid=jid,
                session_id=session_id,
                message_id=msg_id,
                sender_phone=sender_phone,
                sender_name=payload.get("contact_name"),
                group_subject=group_subj,
            )
        )

    contact_name = group_subj if is_group else payload.get("contact_name")
    media_type   = payload.get("media_type")
    existing_contact = await db["whatsapp_hub_contacts"].find_one({"jid": jid}, {"display_name": 1})
    resolved_name = group_subj if is_group else _better_name(
        contact_name, existing_contact.get("display_name") if existing_contact else None, phone
    )
    await db["whatsapp_hub_contacts"].update_one(
        {"jid": jid},
        {"$set": {
            "jid": jid, "phone": phone,
            "display_name": resolved_name,
            "is_group": is_group,
            "last_message_at": ts,
            "session_id": session_id,
            # Cache latest message inline — eliminates the N+1 per-contact query in GET /inbox
            "latest_message": {
                "body":         body,
                "direction":    "in",
                "timestamp":    ts,
                "sender_phone": sender_phone,
                "media_type":   media_type,
            },
        },
         "$inc": {"unread_count": 1}},
        upsert=True,
    )

    # ★ Push real-time event to all SSE subscribers
    _push_sse("message", {
        "jid":        jid,
        "session_id": session_id,
        "body":       body[:80],
        "timestamp":  ts.isoformat(),
    })
    return {"ok": True}


# ── Webhook: bulk history sync ───────────────────────────────────────────────

@router.post("/webhook/bulk-sync")
async def hub_bulk_sync(request: Request):
    try:
        raw: Dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    session_id    = raw.get("session_id", "unknown")
    session_label = raw.get("session_label", session_id)
    db = _db()
    contacts_upserted = 0
    messages_stored   = 0

    for c in raw.get("contacts", []):
        jid = (c.get("jid") or "").strip()
        if not jid:
            continue
        is_group     = bool(c.get("is_group")) or jid.endswith("@g.us")
        phone        = c.get("phone") or jid.split("@")[0]
        candidate_nm = c.get("display_name")
        last_at      = None
        ts_str       = c.get("last_message_at")
        if ts_str:
            try:
                last_at = datetime.fromisoformat(ts_str.rstrip("Z")).replace(tzinfo=timezone.utc)
            except Exception:
                pass
        last_at = last_at or datetime.now(timezone.utc)
        existing = await db["whatsapp_hub_contacts"].find_one({"jid": jid}, {"display_name": 1})
        if is_group:
            display_name = candidate_nm or (existing.get("display_name") if existing else None) or "Group"
        else:
            display_name = _better_name(candidate_nm, existing.get("display_name") if existing else None, phone)
        # Use $set (not $setOnInsert) for display_name so contacts get their real name
        # on every sync — previously $setOnInsert meant names only wrote on first insert
        # and re-syncs always left contacts showing only their phone number. The merge
        # above ensures this $set can only ever upgrade the name, never clobber a real
        # one with a worse value.
        await db["whatsapp_hub_contacts"].update_one(
            {"jid": jid},
            {"$set":         {"jid": jid, "phone": phone, "is_group": is_group,
                              "display_name": display_name, "session_id": session_id},
             "$setOnInsert": {"unread_count": 0},
             "$max":         {"last_message_at": last_at}},
            upsert=True,
        )
        contacts_upserted += 1

    # One real-name lookup per unique jid (not per message) — avoids the old
    # bug where the LAST message processed in a batch (whose `contact_name`
    # is often empty/unreliable for historical sync data) silently overwrote
    # a perfectly good name set earlier by the contacts loop above.
    _name_cache: Dict[str, Optional[str]] = {}

    for m in raw.get("messages", []):
        jid  = (m.get("jid") or "").strip()
        body = m.get("body", "")
        if not jid or not body:
            continue
        msg_id    = m.get("message_id", "")
        m_session = m.get("session_id", session_id)
        direction = m.get("direction", "in")
        is_group  = bool(m.get("is_group")) or jid.endswith("@g.us")
        ts_raw    = m.get("timestamp")
        ts        = datetime.fromtimestamp(ts_raw, tz=timezone.utc) if ts_raw else datetime.now(timezone.utc)

        if msg_id and await db["whatsapp_hub_messages"].find_one({"message_id": msg_id, "session_id": m_session}):
            continue

        phone      = jid.split("@")[0]
        contact_nm = m.get("contact_name")
        media_type = m.get("media_type")
        await db["whatsapp_hub_messages"].insert_one({
            "jid":           jid,
            "message_id":    msg_id,
            "session_id":    m_session,
            "session_label": m.get("session_label", session_label),
            "direction":     direction,
            "from":          m.get("from_phone", m.get("from", phone)),
            "to":            m_session if direction == "out" else phone,
            "is_group":      is_group,
            "sender_jid":    m.get("sender_jid"),
            "sender_phone":  m.get("sender_phone"),
            "contact_name":  contact_nm,
            "body":          body,
            "media_url":     m.get("media_url"),
            "media_type":    media_type,
            "filename":      m.get("filename"),
            "file_size":     None,
            "timestamp":     ts,
            "read":          direction == "out",
            "assigned_to":   None,
        })
        messages_stored += 1

        # Cache latest_message inline on the contact doc so the inbox GET
        # doesn't need a separate per-contact DB query (eliminates N+1).
        # $max on last_message_at ensures we only update forward in time.
        latest_msg_cache = {
            "body":         body,
            "direction":    direction,
            "timestamp":    ts,
            "sender_phone": m.get("sender_phone"),
            "media_type":   media_type,
        }
        if jid not in _name_cache:
            existing = await db["whatsapp_hub_contacts"].find_one({"jid": jid}, {"display_name": 1})
            _name_cache[jid] = existing.get("display_name") if existing else None
        if is_group:
            _name_cache[jid] = contact_nm or _name_cache[jid] or "Group"
        else:
            _name_cache[jid] = _better_name(contact_nm, _name_cache[jid], phone)

        await db["whatsapp_hub_contacts"].update_one(
            {"jid": jid},
            {"$set":         {"jid": jid, "phone": phone, "session_id": m_session,
                              "is_group": is_group,
                              "display_name": _name_cache[jid],
                              "latest_message": latest_msg_cache},
             "$max":         {"last_message_at": ts},
             "$setOnInsert": {"unread_count": 0}},
            upsert=True,
        )

    logger.info("WA Hub bulk-sync: session=%s contacts=%d messages=%d",
                session_id, contacts_upserted, messages_stored)
    _push_sse("sync", {"session_id": session_id, "contacts": contacts_upserted, "messages": messages_stored})
    return {"ok": True, "contacts_upserted": contacts_upserted, "messages_stored": messages_stored}


# ── Webhook: group metadata ──────────────────────────────────────────────────

@router.post("/webhook/groups")
async def hub_groups_sync(request: Request):
    try:
        raw: Dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    session_id = raw.get("session_id", "unknown")
    db = _db()
    stored = 0
    for g in raw.get("groups", []) or []:
        jid = (g.get("jid") or "").strip()
        if not jid.endswith("@g.us"):
            continue
        await db["whatsapp_hub_groups"].update_one(
            {"jid": jid},
            {"$set": {
                "jid":          jid,
                "subject":      g.get("subject"),
                "description":  g.get("description"),
                "owner":        g.get("owner"),
                "participants": g.get("participants", []),
                "created_at":   g.get("created_at"),
                "session_id":   session_id,
                "updated_at":   datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        await db["whatsapp_hub_contacts"].update_one(
            {"jid": jid},
            {"$set":         {"jid": jid, "phone": jid.split("@")[0],
                              "display_name": g.get("subject") or "Group",
                              "is_group": True, "session_id": session_id},
             "$setOnInsert": {"unread_count": 0, "last_message_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        stored += 1
    return {"ok": True, "groups_stored": stored}


# ── Inbox ────────────────────────────────────────────────────────────────────

@router.get("/inbox")
async def hub_inbox(
    session_id: Optional[str] = None,
    unread_only: bool = False,
    include_groups: bool = True,
    groups_only: bool = False,
    archived: bool = False,
    limit: int = 200,
    skip: int = 0,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "You do not have WhatsApp Hub access.")
    db = _db()
    filt: Dict[str, Any] = {}
    if session_id:  filt["session_id"]   = session_id
    if unread_only: filt["unread_count"] = {"$gt": 0}
    filt["archived"] = True if archived else {"$ne": True}
    if groups_only:
        filt["is_group"] = True
    elif not include_groups:
        filt["is_group"] = {"$ne": True}

    contacts = await db["whatsapp_hub_contacts"].find(filt) \
        .sort("last_message_at", -1).skip(skip).limit(limit).to_list(limit)

    result = []
    from datetime import datetime as _dt
    def _ts(v):
        return v.isoformat() if isinstance(v, _dt) else v

    for c in contacts:
        # Use the latest_message cached inline on the contact doc (written by both the
        # incoming-message webhook and the bulk-sync handler). This avoids the previous
        # N+1 pattern (one extra DB query per contact) which caused 500ms+ inbox loads.
        cached_latest = c.get("latest_message")
        result.append({
            "jid":             c["jid"],
            "phone":           c.get("phone"),
            "display_name":    c.get("display_name"),
            "is_group":        bool(c.get("is_group")),
            "last_message_at": _ts(c.get("last_message_at")),
            "unread_count":    c.get("unread_count", 0),
            "session_id":      c.get("session_id"),
            "profile_pic_url": c.get("profile_pic_url"),
            "archived":        bool(c.get("archived")),
            "starred":         bool(c.get("starred")),
            "latest_message": {
                "body":         cached_latest.get("body", "") if cached_latest else "",
                "direction":    cached_latest.get("direction", "in") if cached_latest else "in",
                "timestamp":    _ts(cached_latest.get("timestamp")) if cached_latest else None,
                "sender_phone": cached_latest.get("sender_phone") if cached_latest else None,
                "media_type":   cached_latest.get("media_type") if cached_latest else None,
            } if cached_latest else None,
        })
    total = await db["whatsapp_hub_contacts"].count_documents(filt)
    return {"contacts": result, "total": total}


# ── Groups list ──────────────────────────────────────────────────────────────

@router.get("/groups")
async def hub_groups_list(
    session_id: Optional[str] = None,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db    = _db()
    filt: Dict[str, Any] = {}
    if session_id: filt["session_id"] = session_id
    groups = await db["whatsapp_hub_groups"].find(filt).sort("subject", 1).to_list(500)
    return {"groups": [_safe(g) for g in groups]}


@router.get("/groups/{group_jid:path}/participants")
async def hub_group_participants(
    group_jid: str,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db  = _db()
    grp = await db["whatsapp_hub_groups"].find_one({"jid": group_jid})
    if not grp:
        raise HTTPException(404, "Group not found")
    return {
        "jid":          grp["jid"],
        "subject":      grp.get("subject"),
        "participants": grp.get("participants", []),
        "owner":        grp.get("owner"),
    }


# ── Contact profile pic ──────────────────────────────────────────────────────

@router.get("/contacts/{contact_jid:path}/profile-pic")
async def hub_contact_profile_pic(
    contact_jid: str,
    session_id: Optional[str] = None,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    from backend.whatsapp_integration import _get_cached_sessions, _bridge_get
    try:
        sessions = await _get_cached_sessions()
        conn     = [s for s in sessions if s.get("status") == "connected"]
        if not conn:
            raise HTTPException(503, "No connected session")
        sid = session_id or conn[0]["sessionId"]
        import urllib.parse
        encoded = urllib.parse.quote(contact_jid, safe="")
        result  = await _bridge_get(f"/sessions/{sid}/contacts/{encoded}/profile-pic")
        return result
    except HTTPException:
        raise
    except Exception as e:
        return {"url": None, "error": str(e)}


# ── Conversation ─────────────────────────────────────────────────────────────

@router.get("/conversations/{contact_jid:path}")
async def hub_conversation(
    contact_jid: str,
    limit: int = 200,
    before: Optional[str] = None,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db = _db()

    query: Dict[str, Any] = {"jid": contact_jid}
    if before:
        from bson import ObjectId as ObjId
        try:
            query["_id"] = {"$lt": ObjId(before)}
        except Exception:
            pass

    msgs = await db["whatsapp_hub_messages"].find(query) \
        .sort("timestamp", -1).limit(limit).to_list(limit)
    msgs.reverse()

    contact = await db["whatsapp_hub_contacts"].find_one({"jid": contact_jid})

    logger.info("WA Hub conversation: jid=%s messages_found=%d", contact_jid, len(msgs))

    def _fmt_msg(m: dict) -> dict:
        from datetime import datetime
        ts = m.get("timestamp")
        if isinstance(ts, datetime):
            ts = ts.isoformat()
        media_url = m.get("media_url")
        fname = m.get("filename") or (media_url.rsplit("/", 1)[-1] if media_url else None)
        return {
            "id":            str(m["_id"]),
            "message_id":    m.get("message_id"),
            "session_id":    m.get("session_id"),
            "session_label": m.get("session_label"),
            "direction":     m.get("direction", "in"),
            "from":          m.get("from"),
            "is_group":      bool(m.get("is_group")),
            "sender_jid":    m.get("sender_jid"),
            "sender_phone":  m.get("sender_phone"),
            "contact_name":  m.get("contact_name"),
            "body":          m.get("body", ""),
            "media_url":     media_url,
            "media_type":    m.get("media_type"),
            "filename":      fname,
            "file_size":     m.get("file_size"),
            "timestamp":     ts,
            "read":          m.get("read", False),
            "starred":       bool(m.get("starred")),
            "assigned_to":   m.get("assigned_to"),
        }

    return {
        "contact":  _safe(contact) if contact else None,
        "is_group": bool(contact and contact.get("is_group")),
        "messages": [_fmt_msg(m) for m in msgs],
    }


# ── Reply — text ─────────────────────────────────────────────────────────────

@router.post("/reply")
async def hub_reply(body: HubReply, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    from backend.whatsapp_integration import _get_cached_sessions, _bridge_post

    session_id = body.session_id
    if not session_id:
        sess = await _get_cached_sessions()
        conn = [s for s in sess if s.get("status") == "connected"]
        if not conn:
            raise HTTPException(503, "No connected WhatsApp session.")
        session_id = conn[0]["sessionId"]

    send_jid = await _resolve_send_jid(body.jid, session_id)
    if not send_jid:
        raise HTTPException(422, "Cannot send: @lid JID could not be resolved to a real phone number. Try again after receiving a message from this contact.")

    db = _db()
    result = await _bridge_post("/send", {"to": send_jid, "message": body.message, "sessionId": session_id})
    if not result.get("success"):
        raise HTTPException(502, result.get("error", "Bridge send failed"))

    ts   = datetime.now(timezone.utc)
    phone = body.jid.split("@")[0]
    await db["whatsapp_hub_messages"].insert_one({
        "jid": body.jid, "message_id": result.get("messageId", ""),
        "session_id": session_id,
        "session_label": session_id,
        "direction": "out",
        "from": session_id,
        "to": phone,
        "is_group": body.jid.endswith("@g.us"),
        "body": body.message,
        "media_url": None, "media_type": None, "filename": None, "file_size": None,
        "timestamp": ts,
        "read": True, "assigned_to": None,
    })
    await db["whatsapp_hub_contacts"].update_one(
        {"jid": body.jid},
        {"$set": {
            "last_message_at": ts,
            "latest_message": {
                "body":         body.message,
                "direction":    "out",
                "timestamp":    ts,
                "sender_phone": None,
                "media_type":   None,
            },
        }},
        upsert=False,
    )
    return {"ok": True, "messageId": result.get("messageId")}


# ── Reply — media ────────────────────────────────────────────────────────────

@router.post("/reply-media")
async def hub_reply_media(body: HubReplyMedia, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    from backend.whatsapp_integration import _get_cached_sessions, _bridge_post

    session_id = body.session_id
    if not session_id:
        sess = await _get_cached_sessions()
        conn = [s for s in sess if s.get("status") == "connected"]
        if not conn:
            raise HTTPException(503, "No connected WhatsApp session.")
        session_id = conn[0]["sessionId"]

    send_jid = await _resolve_send_jid(body.jid, session_id)
    if not send_jid:
        raise HTTPException(422, "Cannot send: @lid JID could not be resolved.")

    result = await _bridge_post("/send-media-base64", {
        "to": send_jid, "sessionId": session_id,
        "base64": body.base64, "mimeType": body.mime_type,
        "filename": body.filename, "caption": body.caption,
    })
    if not result.get("success"):
        raise HTTPException(502, result.get("error", "Bridge media send failed"))

    db  = _db()
    ts  = datetime.now(timezone.utc)
    phone = body.jid.split("@")[0]
    media_type = "image" if body.mime_type.startswith("image/") \
        else "video"    if body.mime_type.startswith("video/") \
        else "audio"    if body.mime_type.startswith("audio/") \
        else "document"
    await db["whatsapp_hub_messages"].insert_one({
        "jid": body.jid, "message_id": result.get("messageId", ""),
        "session_id": session_id,
        "direction": "out",
        "from": session_id,
        "to": phone,
        "is_group": body.jid.endswith("@g.us"),
        "body": body.caption or f"[{media_type}]",
        "media_url": None, "media_type": media_type,
        "filename": body.filename, "file_size": None,
        "timestamp": ts,
        "read": True, "assigned_to": None,
    })
    await db["whatsapp_hub_contacts"].update_one({"jid": body.jid}, {"$set": {"last_message_at": ts}}, upsert=False)
    return {"ok": True, "messageId": result.get("messageId")}


# ── Mark read ────────────────────────────────────────────────────────────────

@router.patch("/conversations/{contact_jid:path}/read")
async def hub_mark_read(contact_jid: str, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db = _db()
    await db["whatsapp_hub_messages"].update_many({"jid": contact_jid, "direction": "in"}, {"$set": {"read": True}})
    await db["whatsapp_hub_contacts"].update_one({"jid": contact_jid}, {"$set": {"unread_count": 0}})
    return {"ok": True}


# ── Unread count ─────────────────────────────────────────────────────────────

@router.get("/unread-count")
async def hub_unread_count(current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db    = _db()
    total = await db["whatsapp_hub_contacts"].aggregate([
        {"$match": {"unread_count": {"$gt": 0}, "archived": {"$ne": True}}},
        {"$group": {"_id": None, "total": {"$sum": "$unread_count"}}},
    ]).to_list(1)
    return {"total": total[0]["total"] if total else 0}


# ── Delete conversation ──────────────────────────────────────────────────────

@router.delete("/conversations/{contact_jid:path}")
async def hub_delete_conversation(contact_jid: str, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db = _db()
    await db["whatsapp_hub_messages"].delete_many({"jid": contact_jid})
    await db["whatsapp_hub_contacts"].delete_one({"jid": contact_jid})
    return {"ok": True}


# ── Assign ───────────────────────────────────────────────────────────────────

@router.patch("/conversations/{contact_jid:path}/assign")
async def hub_assign(contact_jid: str, body: ConversationAssign, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db = _db()
    await db["whatsapp_hub_messages"].update_many({"jid": contact_jid}, {"$set": {"assigned_to": body.user_id}})
    return {"ok": True, "assigned_to": body.user_id}


# ── Archive ──────────────────────────────────────────────────────────────────

@router.patch("/conversations/{contact_jid:path}/archive")
async def hub_archive_conversation(
    contact_jid: str,
    request: Request,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    try:
        data = await request.json()
        archived = bool(data.get("archived", True))
    except Exception:
        archived = True
    db = _db()
    await db["whatsapp_hub_contacts"].update_one({"jid": contact_jid}, {"$set": {"archived": archived}})
    return {"ok": True, "archived": archived}


# ── Star message ─────────────────────────────────────────────────────────────

@router.patch("/messages/{message_id}/star")
async def hub_star_message(
    message_id: str,
    request: Request,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    from bson import ObjectId
    try:
        data = await request.json()
        starred = bool(data.get("starred", True))
    except Exception:
        starred = True
    db = _db()
    await db["whatsapp_hub_messages"].update_one({"_id": ObjectId(message_id)}, {"$set": {"starred": starred}})
    return {"ok": True, "starred": starred}


# ── Starred messages ─────────────────────────────────────────────────────────

@router.get("/starred")
async def hub_starred_messages(
    session_id: Optional[str] = None,
    limit: int = 100,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    db   = _db()
    filt: Dict[str, Any] = {"starred": True}
    if session_id: filt["session_id"] = session_id
    msgs = await db["whatsapp_hub_messages"].find(filt).sort("timestamp", -1).limit(limit).to_list(limit)
    return {"messages": [{
        "id":        str(m["_id"]),
        "jid":       m.get("jid"),
        "body":      m.get("body"),
        "direction": m.get("direction"),
        "timestamp": m.get("timestamp"),
    } for m in msgs]}


# ── Conversation search ──────────────────────────────────────────────────────

@router.get("/conversations/{contact_jid:path}/search")
async def hub_conversation_search(
    contact_jid: str,
    q: str = "",
    limit: int = 50,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    if not q.strip():
        return {"messages": []}
    db  = _db()
    pat = {"$regex": q.strip(), "$options": "i"}
    msgs = await db["whatsapp_hub_messages"].find({"jid": contact_jid, "body": pat}) \
        .sort("timestamp", -1).limit(limit).to_list(limit)
    return {"messages": [{
        "id":        str(m["_id"]),
        "body":      m.get("body"),
        "direction": m.get("direction"),
        "timestamp": m.get("timestamp"),
    } for m in msgs]}


# ── SSE: real-time event stream ──────────────────────────────────────────────

@router.get("/events")
async def hub_events(
    request: Request,
    token: Optional[str] = None,
):
    """Server-Sent Events — streams new-message events to the frontend in real time.

    EventSource (browser API) cannot send custom headers, so we accept the JWT
    via ?token= query param as a fallback when no Authorization header is present.
    The frontend already appends ?token=<jwt> when opening the EventSource URL.
    """
    from backend.dependencies import JWT_SECRET, ALGORITHM
    import jwt as _jwt
    from jwt import PyJWTError as JWTError

    # Try Authorization header first; fall back to ?token= query param.
    auth_header = request.headers.get("Authorization", "")
    raw_token = None
    if auth_header.startswith("Bearer "):
        raw_token = auth_header[7:]
    elif token:
        raw_token = token

    if not raw_token:
        raise HTTPException(401, "Authentication required")

    try:
        payload = _jwt.decode(raw_token, JWT_SECRET, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(401, "Invalid token")
    except JWTError:
        raise HTTPException(401, "Invalid token")

    db = _db()
    user_doc = await db["users"].find_one({"id": user_id})
    if not user_doc:
        raise HTTPException(401, "User not found")

    # Check hub access: admin always OK; others need wa_hub_access flag
    role = user_doc.get("role", "")
    if role != "admin" and not user_doc.get("wa_hub_access"):
        raise HTTPException(403, "No WhatsApp Hub access")

    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _sse_queues.append(q)

    async def generator():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"event: {payload['event']}\ndata: {json.dumps(payload['data'])}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            try:
                _sse_queues.remove(q)
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


# ── Global search ────────────────────────────────────────────────────────────

@router.get("/search")
async def hub_global_search(
    q: str = "",
    limit: int = 30,
    current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub")),
):
    if not await _has_hub_access(current_user):
        raise HTTPException(403, "No access")
    if not q.strip():
        return {"contacts": [], "messages": []}
    db      = _db()
    pattern = {"$regex": q.strip(), "$options": "i"}

    contacts = await db["whatsapp_hub_contacts"].find({
        "$or": [{"display_name": pattern}, {"phone": pattern}]
    }).limit(limit).to_list(limit)

    messages = await db["whatsapp_hub_messages"].find({
        "body": pattern
    }).sort("timestamp", -1).limit(limit).to_list(limit)

    return {
        "contacts": [{"jid": c["jid"], "display_name": c.get("display_name"), "phone": c.get("phone")} for c in contacts],
        "messages": [{"id": str(m["_id"]), "jid": m.get("jid"), "body": m.get("body"), "timestamp": m.get("timestamp")} for m in messages],
    }


# ── Access management ─────────────────────────────────────────────────────────

@router.get("/access")
async def hub_list_access(current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    db    = _db()
    users = await db["users"].find({}, {"_id": 0, "id": 1, "name": 1, "email": 1, "role": 1, "wa_hub_access": 1}).to_list(200)
    return {"users": [{"id": u.get("id"), "name": u.get("name"), "email": u.get("email"), "role": u.get("role"), "wa_hub_access": u.get("wa_hub_access", False)} for u in users]}


@router.patch("/access/{user_id}")
async def hub_update_access(user_id: str, body: HubAccessUpdate, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    # Users are keyed by UUID string in the "id" field, not by MongoDB ObjectId "_id".
    db = _db()
    user_query = {"id": user_id}
    if not _is_platform_owner(current_user):
        user_query = _scope_user_query(user_query)
    result = await db["users"].update_one(user_query, {"$set": {"wa_hub_access": body.grant}})
    if result.matched_count == 0:
        raise HTTPException(404, "User not found")
    return {"ok": True, "user_id": user_id, "wa_hub_access": body.grant}


class HubAccessRequest(BaseModel):
    reason: str = Field(..., min_length=5, max_length=500)


@router.post("/access/request")
async def hub_request_access(body: HubAccessRequest, current_user: User = Depends(get_current_user)):
    if current_user.role == "admin" or await _has_hub_access(current_user):
        return {"message": "Already have access"}
    db       = _db()
    existing = await db["whatsapp_hub_access_requests"].find_one({"user_id": str(current_user.id), "status": "pending"})
    if existing:
        return {"message": "Request already pending"}
    await db["whatsapp_hub_access_requests"].insert_one({
        "user_id": str(current_user.id), "company_id": getattr(current_user, "company_id", None),
        "user_name": current_user.name, "user_email": current_user.email,
        "reason": body.reason, "status": "pending", "created_at": datetime.now(timezone.utc),
    })
    return {"message": "Access request submitted."}


@router.get("/access/requests")
async def hub_list_requests(current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    db   = _db()
    query = {"status": "pending"}
    if not _is_platform_owner(current_user):
        query["company_id"] = getattr(current_user, "company_id", None)
    reqs = await db["whatsapp_hub_access_requests"].find(query).to_list(100)
    return {"requests": [{"id": str(r["_id"]), "user_id": r["user_id"], "user_name": r.get("user_name"), "user_email": r.get("user_email"), "reason": r.get("reason"), "created_at": r.get("created_at")} for r in reqs]}


class HubAccessDecision(BaseModel):
    request_id: str
    approved: bool


@router.post("/access/decide")
async def hub_decide_access(body: HubAccessDecision, current_user: User = Depends(require_commercial_admin_page("records", "can_access_whatsapp_hub"))):
    from bson import ObjectId
    db  = _db()
    req_query = {"_id": ObjectId(body.request_id)}
    if not _is_platform_owner(current_user):
        req_query["company_id"] = getattr(current_user, "company_id", None)
    req = await db["whatsapp_hub_access_requests"].find_one(req_query)
    if not req:
        raise HTTPException(404, "Not found")
    status = "approved" if body.approved else "rejected"
    await db["whatsapp_hub_access_requests"].update_one(req_query, {"$set": {"status": status}})
    if body.approved:
        # req["user_id"] is a UUID string stored in the "id" field (not MongoDB "_id")
        user_query = {"id": req["user_id"]}
        if not _is_platform_owner(current_user):
            user_query = _scope_user_query(user_query)
        result = await db["users"].update_one(user_query, {"$set": {"wa_hub_access": True}})
        if result.matched_count == 0:
            raise HTTPException(404, "Requested user is outside your tenant scope.")
    return {"ok": True, "status": status}
