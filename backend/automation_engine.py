"""
Automation Engine
=================
Client-facing automation with an admin approval gate, plus internal nudges.

Covers, per your scoping:
  1. Birthday wishes (WhatsApp + Email) — can require admin approval before send
  2. Admin-editable templates for both channels
  3. Every sent wish is logged to the client's activity timeline
  4. Festival greetings (Diwali, New Year, etc.) — same approval gate
  5. Renewal/expiry alerts for any service (not just DSC) — internal alert to
     the assigned user/admin
  6. Follow-up reminders — internal nudge when a client hasn't been
     contacted in N days (reads from client_activities, so it plugs
     straight into the timeline module already built)

Design notes:
  - WhatsApp birthday sending already exists via whatsapp_scheduler.py /
    wa_birthday_job. This module supersedes it: disable the old cron job
    (see INTEGRATION_GUIDE) and use `birthday_automation_job` from here
    instead, since only one of the two should own the daily 9 AM send.
  - "Approval required" turns a would-be send into a queued
    `pending_client_messages` row + an admin notification. Approving it
    from the Pending Approvals panel is what actually triggers the send.
  - Renewal alerts and follow-up reminders are internal-only (staff
    notifications), not messages to the client — nobody wants an
    automated "your license is expiring" text going out unreviewed.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime, date, timedelta, timezone
import asyncio
import logging
import uuid

from backend.dependencies import db, get_current_user, personal_birthday_candidates, get_user_permissions
from backend.notifications import create_notification
from backend.client_activity import log_client_activity

router = APIRouter(prefix="/automation", tags=["Automation Engine"])
expiry_router = APIRouter(prefix="/clients/{client_id}/service-expiries", tags=["Service Expiry Alerts"])

logger = logging.getLogger(__name__)


# ── Admin-only gate ───────────────────────────────────────────────────────
# Settings, templates, festivals and renewal tracking stay strictly
# admin-only — these are structural configuration, not delegated here.
def require_admin(current_user=Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


# ── Delegated approval-rights gate ────────────────────────────────────────
# Admins can grant specific users the right to approve queued WhatsApp
# and/or Email automated wishes (Permission Matrix → Records module →
# "Automation — approve WhatsApp/Email wishes"), independent of admin
# status and independent of each other — a user can have one, both, or
# neither. Approving/rejecting still only ever touches messages on a
# channel the user is actually granted.
def _allowed_channels(current_user) -> set:
    if current_user.role == "admin":
        return {"whatsapp", "email"}
    perms = get_user_permissions(current_user)
    allowed = set()
    if perms.get("can_approve_whatsapp_wishes"):
        allowed.add("whatsapp")
    if perms.get("can_approve_email_wishes"):
        allowed.add("email")
    return allowed


def require_approval_access(current_user=Depends(get_current_user)):
    if not _allowed_channels(current_user):
        raise HTTPException(
            status_code=403,
            detail="No automation approval rights granted. Ask an admin to grant "
                   "WhatsApp/Email approval rights in the Permission Matrix.",
        )
    return current_user

DEFAULT_BIRTHDAY_EMAIL_TEMPLATE = (
    "Dear {name},\n\nOn behalf of our entire team, we wish you a very Happy Birthday! "
    "Thank you for being a valued part of our journey.\n\nBest wishes,\nTaskosphere Team"
)
DEFAULT_BIRTHDAY_WA_TEMPLATE = "🎂 Happy Birthday, {name}! Wishing you a wonderful year ahead. 🎉"


# ====================== MODELS ======================

class Festival(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    month_day: str  # "MM-DD"
    wa_template: str = "🪔 Happy {festival}! Wishing you and your family joy and prosperity."
    wa_image_url: Optional[str] = None
    email_template: str = "Dear {name},\n\nWishing you a very Happy {festival}!\n\nBest wishes,\nTaskosphere Team"
    email_attachment_url: Optional[str] = None
    enabled: bool = True


class AutomationSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = "global"
    birthday_email_enabled: bool = True
    birthday_wa_enabled: bool = True
    birthday_requires_approval: bool = True
    birthday_email_template: str = DEFAULT_BIRTHDAY_EMAIL_TEMPLATE
    birthday_wa_template: str = DEFAULT_BIRTHDAY_WA_TEMPLATE
    birthday_wa_image_url: Optional[str] = None
    festival_requires_approval: bool = True
    festivals: List[Festival] = Field(default_factory=list)
    follow_up_days_threshold: int = 30
    follow_up_enabled: bool = True
    expiry_alert_enabled: bool = True
    updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None


class AutomationSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    birthday_email_enabled: Optional[bool] = None
    birthday_wa_enabled: Optional[bool] = None
    birthday_requires_approval: Optional[bool] = None
    birthday_email_template: Optional[str] = None
    birthday_wa_template: Optional[str] = None
    birthday_wa_image_url: Optional[str] = None
    festival_requires_approval: Optional[bool] = None
    follow_up_days_threshold: Optional[int] = None
    follow_up_enabled: Optional[bool] = None
    expiry_alert_enabled: Optional[bool] = None


class PendingClientMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    company_id: Optional[str] = None
    kind: Literal["birthday", "festival"]
    channel: Literal["whatsapp", "email"]
    client_id: str
    client_name: str
    recipient_name: str
    recipient_contact: str  # phone or email
    message: str
    subject: Optional[str] = None
    media_url: Optional[str] = None
    status: Literal["pending", "approved", "rejected", "sent", "failed"] = "pending"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None


class ServiceExpiry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    company_id: Optional[str] = None
    client_id: str
    label: str  # e.g. "Trade License", "MSME Certificate", "Insurance Policy"
    expiry_date: str  # ISO date
    alert_days_before: int = 30
    notes: Optional[str] = None
    last_alert_sent_on: Optional[str] = None  # ISO date, dedupe guard
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ServiceExpiryCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: str
    expiry_date: str
    alert_days_before: int = 30
    notes: Optional[str] = None


# ====================== SETTINGS ======================

async def _get_settings() -> dict:
    doc = await db.automation_settings.find_one({"id": "global"}, {"_id": 0})
    if not doc:
        defaults = AutomationSettings().model_dump()
        await db.automation_settings.insert_one(defaults)
        return defaults
    return doc


@router.get("/settings", response_model=AutomationSettings)
async def get_automation_settings(current_user=Depends(require_admin)):
    return await _get_settings()


@router.put("/settings", response_model=AutomationSettings)
async def update_automation_settings(
    payload: AutomationSettingsUpdate, current_user=Depends(require_admin)
):
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    updates["updated_at"] = datetime.now(timezone.utc)
    updates["updated_by"] = current_user.id
    await db.automation_settings.update_one({"id": "global"}, {"$set": updates}, upsert=True)
    return await _get_settings()


@router.post("/settings/festivals", response_model=AutomationSettings)
async def add_festival(festival: Festival, current_user=Depends(require_admin)):
    await db.automation_settings.update_one(
        {"id": "global"}, {"$push": {"festivals": festival.model_dump()}}, upsert=True
    )
    return await _get_settings()


@router.delete("/settings/festivals/{festival_id}", response_model=AutomationSettings)
async def delete_festival(festival_id: str, current_user=Depends(require_admin)):
    await db.automation_settings.update_one(
        {"id": "global"}, {"$pull": {"festivals": {"id": festival_id}}}
    )
    return await _get_settings()


# ====================== PENDING APPROVALS ======================

@router.get("/pending-approvals", response_model=List[PendingClientMessage])
async def list_pending_approvals(
    status: str = Query("pending"),
    current_user=Depends(require_approval_access),
):
    allowed = _allowed_channels(current_user)
    docs = (
        await db.pending_client_messages.find(
            {"status": status, "channel": {"$in": list(allowed)}}, {"_id": 0}
        )
        .sort("created_at", -1)
        .to_list(500)
    )
    return docs


async def _dispatch_pending_message(msg: dict) -> bool:
    """Actually sends an approved message. Returns True on success."""
    from backend.whatsapp_integration import send_whatsapp_notification, send_whatsapp_media_notification

    ok = True
    if msg["channel"] == "whatsapp":
        if msg.get("media_url"):
            await send_whatsapp_media_notification(
                to=msg["recipient_contact"],
                image_url=msg["media_url"],
                caption=msg["message"],
                message_type=msg["kind"],
                context_id=msg["client_id"],
                sent_by="automation:approved",
            )
        else:
            result = await send_whatsapp_notification(
                to=msg["recipient_contact"],
                message=msg["message"],
                message_type=msg["kind"],
                context_id=msg["client_id"],
                sent_by="automation:approved",
            )
            ok = result is not False
    elif msg["channel"] == "email":
        from backend.server import send_birthday_email  # reuse existing Brevo sender
        ok = await send_birthday_email(msg["recipient_contact"], msg["recipient_name"])

    await log_client_activity(
        client_id=msg["client_id"],
        type=msg["channel"],
        content=f"{msg['kind'].title()} wish sent to {msg['recipient_name']}: {msg['message'][:150]}",
        created_by="automation",
        created_by_name="Automation Engine",
        metadata={"kind": msg["kind"], "channel": msg["channel"], "approved": True},
    )
    return ok


@router.post("/pending-approvals/{message_id}/approve")
async def approve_pending_message(message_id: str, current_user=Depends(require_approval_access)):
    msg = await db.pending_client_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg:
        raise HTTPException(status_code=404, detail="Not found")
    if msg["channel"] not in _allowed_channels(current_user):
        raise HTTPException(
            status_code=403,
            detail=f"You are not granted approval rights for {msg['channel']} messages",
        )
    if msg["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Already {msg['status']}")

    ok = await _dispatch_pending_message(msg)
    await db.pending_client_messages.update_one(
        {"id": message_id},
        {"$set": {
            "status": "sent" if ok else "failed",
            "reviewed_by": current_user.id,
            "reviewed_at": datetime.now(timezone.utc),
        }},
    )
    return {"status": "sent" if ok else "failed"}


@router.post("/pending-approvals/{message_id}/reject")
async def reject_pending_message(message_id: str, current_user=Depends(require_approval_access)):
    msg = await db.pending_client_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg:
        raise HTTPException(status_code=404, detail="Not found")
    if msg["channel"] not in _allowed_channels(current_user):
        raise HTTPException(
            status_code=403,
            detail=f"You are not granted approval rights for {msg['channel']} messages",
        )
    result = await db.pending_client_messages.update_one(
        {"id": message_id, "status": "pending"},
        {"$set": {
            "status": "rejected",
            "reviewed_by": current_user.id,
            "reviewed_at": datetime.now(timezone.utc),
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Not found or already reviewed")
    return {"status": "rejected"}


async def _queue_or_send(kind, channel, client, recipient_name, recipient_contact, message, subject, requires_approval, media_url=None):
    if requires_approval:
        entry = PendingClientMessage(
            company_id=client.get("company_id"),
            kind=kind, channel=channel, client_id=client["id"],
            client_name=client.get("company_name", ""), recipient_name=recipient_name,
            recipient_contact=recipient_contact, message=message, subject=subject,
            media_url=media_url,
        )
        await db.pending_client_messages.insert_one(entry.model_dump())
        admins = await db.users.find({"role": "admin"}, {"_id": 0, "id": 1}).to_list(50)
        for adm in admins:
            await create_notification(
                user_id=adm["id"],
                title=f"{kind.title()} wish awaiting approval",
                message=f"{recipient_name} ({client.get('company_name','')}) — {channel} {kind} wish ready to send.",
                type="automation_approval",
                popup=False,
            )
    else:
        ok = await _dispatch_pending_message({
            "kind": kind, "channel": channel, "client_id": client["id"],
            "recipient_name": recipient_name, "recipient_contact": recipient_contact,
            "message": message, "media_url": media_url,
        })
        return ok


# ====================== SERVICE EXPIRY ALERTS (renewals) ======================

@expiry_router.get("", response_model=List[ServiceExpiry])
async def list_service_expiries(client_id: str, current_user=Depends(require_admin)):
    return await db.service_expiries.find({"client_id": client_id}, {"_id": 0}).sort("expiry_date", 1).to_list(200)


@expiry_router.post("", response_model=ServiceExpiry, status_code=201)
async def create_service_expiry(client_id: str, payload: ServiceExpiryCreate, current_user=Depends(require_admin)):
    client = await db.clients.find_one({"id": client_id}, {"_id": 0, "id": 1})
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    entry = ServiceExpiry(
        company_id=client.get("company_id"),
        client_id=client_id,
        created_by=current_user.id,
        **payload.model_dump(),
    )
    await db.service_expiries.insert_one(entry.model_dump())
    await log_client_activity(
        client_id=client_id, type="document",
        content=f"Renewal tracking added: {entry.label} (expires {entry.expiry_date})",
        created_by=current_user.id, created_by_name=getattr(current_user, "full_name", "Unknown"),
    )
    return entry


@expiry_router.patch("/{expiry_id}", response_model=ServiceExpiry)
async def update_service_expiry(client_id: str, expiry_id: str, payload: ServiceExpiryCreate, current_user=Depends(require_admin)):
    updates = payload.model_dump(exclude_unset=True)
    result = await db.service_expiries.find_one_and_update(
        {"id": expiry_id, "client_id": client_id}, {"$set": updates}, return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Not found")
    result.pop("_id", None)
    return result


@expiry_router.delete("/{expiry_id}", status_code=204)
async def delete_service_expiry(client_id: str, expiry_id: str, current_user=Depends(require_admin)):
    await db.service_expiries.delete_one({"id": expiry_id, "client_id": client_id})
    return None


# ====================== SCHEDULED JOBS (async) ======================

async def run_birthday_automation():
    """Supersedes whatsapp_scheduler.wa_birthday_job — handles WA + email + approval gate."""
    settings = await _get_settings()
    today = date.today()
    clients = await db.clients.find({"status": {"$ne": "archived"}}, {"_id": 0}).to_list(5000)

    for client in clients:
        if client.get("wa_auto_birthday") is False:
            continue
        for person in personal_birthday_candidates(client):
            try:
                raw = person["birthday"]
                bday = date.fromisoformat(str(raw)[:10])
            except (ValueError, TypeError):
                continue
            if not (bday.month == today.month and bday.day == today.day):
                continue

            name = person["name"]
            if settings.get("birthday_wa_enabled") and person.get("phone"):
                phone = "".join(c for c in person["phone"] if c.isdigit())
                if len(phone) == 10:
                    phone = "91" + phone
                msg = (client.get("wa_birthday_message") or settings["birthday_wa_template"]).format(name=name)
                await _queue_or_send("birthday", "whatsapp", client, name, phone, msg, None,
                                      settings.get("birthday_requires_approval", True),
                                      media_url=settings.get("birthday_wa_image_url"))
                await asyncio.sleep(0.5)

            if settings.get("birthday_email_enabled") and person.get("email"):
                msg = settings["birthday_email_template"].format(name=name)
                await _queue_or_send("birthday", "email", client, name, person["email"], msg,
                                      f"Happy Birthday, {name}!",
                                      settings.get("birthday_requires_approval", True))


async def run_festival_greetings():
    settings = await _get_settings()
    today_md = date.today().strftime("%m-%d")
    festivals = [f for f in settings.get("festivals", []) if f.get("enabled") and f.get("month_day") == today_md]
    if not festivals:
        return

    clients = await db.clients.find({"status": "active"}, {"_id": 0}).to_list(5000)
    for festival in festivals:
        for client in clients:
            if client.get("wa_auto_birthday") is False:  # reuse same opt-out flag for all auto-greetings
                continue
            name = client.get("company_name", "Valued Client")
            if client.get("phone"):
                phone = "".join(c for c in client["phone"] if c.isdigit())
                if len(phone) == 10:
                    phone = "91" + phone
                msg = festival["wa_template"].format(name=name, festival=festival["name"])
                await _queue_or_send("festival", "whatsapp", client, name, phone, msg, None,
                                      settings.get("festival_requires_approval", True),
                                      media_url=festival.get("wa_image_url"))
                await asyncio.sleep(0.5)
            if client.get("email"):
                msg = festival["email_template"].format(name=name, festival=festival["name"])
                await _queue_or_send("festival", "email", client, name, client["email"], msg,
                                      f"Happy {festival['name']}!",
                                      settings.get("festival_requires_approval", True))


async def run_service_expiry_alerts():
    """Internal staff alert — not sent to the client."""
    settings = await _get_settings()
    if not settings.get("expiry_alert_enabled", True):
        return
    today = date.today()
    expiries = await db.service_expiries.find({}, {"_id": 0}).to_list(5000)

    for exp in expiries:
        try:
            exp_date = date.fromisoformat(exp["expiry_date"][:10])
        except (ValueError, TypeError, KeyError):
            continue
        days_until = (exp_date - today).days
        alert_at = exp.get("alert_days_before", 30)
        should_alert = days_until in (alert_at, 0) or (days_until < 0 and exp.get("last_alert_sent_on") != today.isoformat())
        if not should_alert or exp.get("last_alert_sent_on") == today.isoformat():
            continue

        client = await db.clients.find_one({"id": exp["client_id"]}, {"_id": 0})
        if not client:
            continue
        recipients = set(filter(None, [client.get("assigned_to"), client.get("created_by")]))
        admins = await db.users.find({"role": "admin"}, {"_id": 0, "id": 1}).to_list(50)
        recipients.update(a["id"] for a in admins)

        status_txt = "expires today" if days_until == 0 else (f"expired {abs(days_until)}d ago" if days_until < 0 else f"expires in {days_until}d")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title=f"Renewal due: {exp['label']}",
                message=f"{client.get('company_name')} — {exp['label']} {status_txt}.",
                type="renewal_alert",
                popup=days_until <= 0,
            )
        await log_client_activity(
            client_id=client["id"], type="system",
            content=f"Renewal alert: {exp['label']} {status_txt}",
            created_by="automation", created_by_name="Automation Engine",
        )
        await db.service_expiries.update_one({"id": exp["id"]}, {"$set": {"last_alert_sent_on": today.isoformat()}})


async def run_follow_up_reminders():
    """Internal staff nudge when a client hasn't been contacted in N days."""
    settings = await _get_settings()
    if not settings.get("follow_up_enabled", True):
        return
    threshold_days = settings.get("follow_up_days_threshold", 30)
    cutoff = datetime.now(timezone.utc) - timedelta(days=threshold_days)

    clients = await db.clients.find({"status": "active"}, {"_id": 0}).to_list(5000)
    for client in clients:
        assigned_to = client.get("assigned_to")
        if not assigned_to:
            continue
        last_activity = await db.client_activities.find_one(
            {"client_id": client["id"], "type": {"$in": ["whatsapp", "email", "call", "meeting", "note"]}},
            {"_id": 0, "created_at": 1},
            sort=[("created_at", -1)],
        )
        last_dt = last_activity["created_at"] if last_activity else None
        if isinstance(last_dt, str):
            try:
                last_dt = datetime.fromisoformat(last_dt.replace("Z", "+00:00"))
            except ValueError:
                last_dt = None
        if last_dt and last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)

        if last_dt is None or last_dt < cutoff:
            days_since = (datetime.now(timezone.utc) - last_dt).days if last_dt else None
            already_notified_today = await db.notifications.find_one({
                "user_id": assigned_to, "type": "follow_up_reminder",
                "message": {"$regex": client["id"]},
                "created_at": {"$gte": datetime.now(timezone.utc) - timedelta(hours=24)},
            })
            if already_notified_today:
                continue
            desc = f"no activity logged yet" if days_since is None else f"no contact in {days_since}d"
            await create_notification(
                user_id=assigned_to,
                title="Follow-up due",
                message=f"{client.get('company_name')} — {desc}. (ref:{client['id']})",
                type="follow_up_reminder",
                popup=False,
            )


# ─── Sync wrappers for APScheduler (matches whatsapp_scheduler.py pattern) ───

def _run_on_main_loop(coro, timeout=55):
    from backend.server import app_event_loop
    if app_event_loop is None or app_event_loop.is_closed():
        logger.warning("_run_on_main_loop: main event loop not ready, skipping automation job.")
        return
    import asyncio as _asyncio
    future = _asyncio.run_coroutine_threadsafe(coro, app_event_loop)
    future.result(timeout=timeout)


def birthday_automation_job():
    try:
        _run_on_main_loop(run_birthday_automation())
    except Exception as exc:
        logger.error("birthday_automation_job failed: %s", exc)


def festival_greeting_job():
    try:
        _run_on_main_loop(run_festival_greetings())
    except Exception as exc:
        logger.error("festival_greeting_job failed: %s", exc)


def service_expiry_alert_job():
    try:
        _run_on_main_loop(run_service_expiry_alerts())
    except Exception as exc:
        logger.error("service_expiry_alert_job failed: %s", exc)


def follow_up_reminder_job():
    try:
        _run_on_main_loop(run_follow_up_reminders())
    except Exception as exc:
        logger.error("follow_up_reminder_job failed: %s", exc)
