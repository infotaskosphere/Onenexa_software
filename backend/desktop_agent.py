"""
desktop_agent.py
────────────────────────────────────────────────────────────────────────────────
Backend routes for the Taskosphere Desktop Agent enterprise system.

Handles data from desktop agents running on staff machines:
  - Activity reports (extended)
  - Browser tracking
  - DSC status synchronization
  - USB device events
  - Productivity metrics
  - Agent health / heartbeat
  - Update management
  - System information

All endpoints are under /api/desktop/ prefix.
Admin-only for GET (viewing); agents push via POST with their own JWT.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from datetime import datetime, date, timezone, timedelta
from typing import Optional, List, Dict, Any
from bson import ObjectId
import logging
import uuid

from backend.dependencies import get_current_user, get_db, admin_required, db
from backend.models import User
from backend.tenant_runtime import enforce_company_value
from backend.platform_owner import is_platform_owner
from backend.commercial_user_company_scope import _scope_user_query
from pydantic import BaseModel, Field, ConfigDict

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/desktop", tags=["Desktop Agent"])

india_tz = timezone(timedelta(hours=5, minutes=30))


# ── Helpers ───────────────────────────────────────────────────────────────────


def _today() -> str:
    return date.today().isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _admin_or_self(current_user: User, target_user_id: str) -> bool:
    """Return True if the current user is admin OR is the target user."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str == "admin":
        return True
    own_id = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))
    return own_id == target_user_id


async def _desktop_scope_query(current_user: User, extra: Optional[dict] = None) -> dict:
    """Scope desktop-agent data to the authenticated tenant; preserve legacy rows by user."""
    base = dict(extra or {})
    if is_platform_owner(current_user):
        return base
    company_id = enforce_company_value(current_user, None)
    users = await db.users.find(
        _scope_user_query({}),
        {"_id": 0, "id": 1},
    ).to_list(5000)
    user_ids = [str(row.get("id")) for row in users if row.get("id")]
    scope = {
        "$or": [
            {"company_id": company_id},
            {
                "company_id": {"$in": [None, ""]},
                "user_id": {"$in": user_ids},
            },
        ]
    }
    return {"$and": [base, scope]} if base else scope


def _validate_agent_user(current_user: User, payload_user_id: str) -> None:
    if not payload_user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if is_platform_owner(current_user):
        return
    if str(payload_user_id) != str(current_user.id):
        raise HTTPException(status_code=403, detail="Agent user does not match authenticated user")




# ── Pydantic Models ──────────────────────────────────────────────────────────


class AgentHeartbeat(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: Optional[str] = None
    machine_name: str
    hostname: str
    platform: str = "win32"
    agent_version: str
    os_version: Optional[str] = None
    cpu_usage: Optional[float] = None
    mem_usage_mb: Optional[float] = None
    uptime_seconds: Optional[int] = None
    internet_connected: bool = True
    last_activity_at: Optional[str] = None


class AgentActivityPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: str
    machine_name: str
    date: Optional[str] = None
    sessions: Optional[List[Dict[str, Any]]] = None
    activeSeconds: Optional[float] = 0
    idleSeconds: Optional[float] = 0
    focusSeconds: Optional[float] = 0
    topApps: Optional[List[Dict[str, Any]]] = None
    topWebsites: Optional[List[Dict[str, Any]]] = None
    timeline: Optional[List[Dict[str, Any]]] = None


class AgentBrowserPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: str
    machine_name: str
    date: Optional[str] = None
    visits: Optional[List[Dict[str, Any]]] = None
    topDomains: Optional[List[Dict[str, Any]]] = None
    totalBrowseSeconds: Optional[float] = 0


class AgentDscPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: str
    machine_name: str
    plugged: bool = False
    cert: Optional[Dict[str, Any]] = None
    reader: Optional[str] = None
    connected_at: Optional[str] = None
    disconnected_at: Optional[str] = None


class AgentUsbPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: str
    machine_name: str
    events: Optional[List[Dict[str, Any]]] = None


class AgentProductivityPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    user_id: str
    machine_name: str
    date: Optional[str] = None
    focusTime: Optional[float] = 0
    idleTime: Optional[float] = 0
    productiveTime: Optional[float] = 0
    unproductiveTime: Optional[float] = 0
    appBreakdown: Optional[List[Dict[str, Any]]] = None
    score: Optional[float] = 0


class AgentSystemInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    agent_id: str
    machine_name: str
    hostname: str
    platform: str = "win32"
    os_version: Optional[str] = None
    cpu: Optional[str] = None
    ram_total_mb: Optional[int] = None
    disk_total_gb: Optional[float] = None
    disk_free_gb: Optional[float] = None
    ip_address: Optional[str] = None
    mac_address: Optional[str] = None


# ── INDEXES ──────────────────────────────────────────────────────────────────


async def create_desktop_indexes():
    """Create MongoDB indexes for desktop collections."""
    try:
        await db.desktop_agents.create_index("agent_id", unique=True)
        await db.desktop_agents.create_index("user_id")
        await db.desktop_activity.create_index([("user_id", 1), ("date", 1)])
        await db.desktop_activity.create_index("agent_id")
        await db.desktop_browser.create_index([("user_id", 1), ("date", 1)])
        await db.desktop_dsc.create_index("agent_id")
        await db.desktop_usb.create_index("agent_id")
        await db.desktop_productivity.create_index([("user_id", 1), ("date", 1)])
        await db.desktop_health.create_index("agent_id")
        await db.desktop_updates.create_index("version")
        await db.desktop_logs.create_index("agent_id")
        logger.info("[DesktopAgent] Indexes created")
    except Exception as e:
        logger.error(f"[DesktopAgent] Index creation failed: {e}")


# ── DB reference (injected by dependency) ─────────────────────────────────────


async def get_db_ref(request: Request):
    from backend.dependencies import db as _db

    return _db


# ══════════════════════════════════════════════════════════════════════════════
# AGENT PUSH ENDPOINTS (called by desktop agent with JWT)
# ══════════════════════════════════════════════════════════════════════════════

# ── 1. Agent Heartbeat ───────────────────────────────────────────────────────


@router.post("/agent/heartbeat")
async def agent_heartbeat(
    payload: AgentHeartbeat,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent sends heartbeat every 30 seconds.
    Updates agent status, CPU, memory, internet connectivity.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        now = _now_iso()
        agent_query = {"agent_id": payload.agent_id}
        if not is_platform_owner(current_user):
            agent_query["company_id"] = company_id
        await db.desktop_agents.update_one(
            agent_query,
            {
                "$set": {
                    "machine_name": payload.machine_name,
                    "hostname": payload.hostname,
                    "platform": payload.platform,
                    "os_version": payload.os_version,
                    "agent_version": payload.agent_version,
                    "cpu_usage": payload.cpu_usage,
                    "mem_usage_mb": payload.mem_usage_mb,
                    "uptime_seconds": payload.uptime_seconds,
                    "internet_connected": payload.internet_connected,
                    "last_heartbeat": now,
                    "status": "online",
                    "updated_at": now,
                    **({"user_id": payload.user_id} if payload.user_id else {}),
                },
                "$setOnInsert": {
                    "created_at": now,
                    "agent_id": payload.agent_id,
                    "company_id": company_id,
                    "user_id": payload.user_id or current_user.id,
                },
            },
            upsert=True,
        )

        # Also log health snapshot
        await db.desktop_health.insert_one(
            {
                "agent_id": payload.agent_id,
                "company_id": company_id,
                "user_id": payload.user_id or current_user.id,
                "cpu_usage": payload.cpu_usage,
                "mem_usage_mb": payload.mem_usage_mb,
                "internet_connected": payload.internet_connected,
                "timestamp": now,
            }
        )

        # Keep health docs to last 2880 (24h at 30s intervals)
        await db.desktop_health.delete_many(
            {
                "agent_id": payload.agent_id,
                "company_id": company_id,
                "timestamp": {
                    "$lt": (
                        datetime.now(timezone.utc) - timedelta(hours=24)
                    ).isoformat()
                },
            }
        )

        return {"success": True, "message": "Heartbeat recorded"}
    except Exception as e:
        logger.error(f"[DesktopAgent] Heartbeat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 2. Activity Report ───────────────────────────────────────────────────────


@router.post("/activity")
async def push_activity(
    payload: AgentActivityPayload,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes activity report (extended version).
    Upserts one doc per user per date.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        report_date = payload.date or _today()
        now = _now_iso()

        await db.desktop_activity.update_one(
            {
                "agent_id": payload.agent_id,
                "user_id": payload.user_id,
                "date": report_date,
            },
            {
                "$set": {
                    "machine_name": payload.machine_name,
                    "sessions": payload.sessions or [],
                    "activeSeconds": payload.activeSeconds or 0,
                    "idleSeconds": payload.idleSeconds or 0,
                    "focusSeconds": payload.focusSeconds or 0,
                    "topApps": payload.topApps or [],
                    "topWebsites": payload.topWebsites or [],
                    "timeline": payload.timeline or [],
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "agent_id": payload.agent_id,
                    "user_id": payload.user_id,
                    "company_id": company_id,
                    "date": report_date,
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return {"success": True, "message": "Activity report saved"}
    except Exception as e:
        logger.error(f"[DesktopAgent] Activity push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 3. Browser Report ────────────────────────────────────────────────────────


@router.post("/browser")
async def push_browser(
    payload: AgentBrowserPayload,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes browser visit data.
    Only domain, title, duration, count — no content capture.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        report_date = payload.date or _today()
        now = _now_iso()

        await db.desktop_browser.update_one(
            {
                "agent_id": payload.agent_id,
                "user_id": payload.user_id,
                "date": report_date,
            },
            {
                "$set": {
                    "machine_name": payload.machine_name,
                    "visits": payload.visits or [],
                    "topDomains": payload.topDomains or [],
                    "totalBrowseSeconds": payload.totalBrowseSeconds or 0,
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "agent_id": payload.agent_id,
                    "user_id": payload.user_id,
                    "company_id": company_id,
                    "date": report_date,
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return {"success": True, "message": "Browser report saved"}
    except Exception as e:
        logger.error(f"[DesktopAgent] Browser push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 4. DSC Status Sync ──────────────────────────────────────────────────────


@router.post("/dsc")
async def push_dsc(
    payload: AgentDscPayload,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes DSC token status changes.
    Records connection/disconnection events.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        now = _now_iso()
        doc = {
            "agent_id": payload.agent_id,
            "user_id": payload.user_id,
            "company_id": company_id,
            "machine_name": payload.machine_name,
            "plugged": payload.plugged,
            "cert": payload.cert,
            "reader": payload.reader,
            "connected_at": payload.connected_at,
            "disconnected_at": payload.disconnected_at,
            "updated_at": now,
        }

        await db.desktop_dsc.insert_one(doc)

        # Update current DSC status on agent record
        agent_query = {"agent_id": payload.agent_id}
        if not is_platform_owner(current_user):
            agent_query["company_id"] = company_id
        await db.desktop_agents.update_one(
            agent_query,
            {
                "$set": {
                    "dsc_plugged": payload.plugged,
                    "dsc_cert": payload.cert,
                    "dsc_reader": payload.reader,
                    "dsc_updated_at": now,
                }
            },
        )

        return {"success": True, "message": "DSC status saved"}
    except Exception as e:
        logger.error(f"[DesktopAgent] DSC push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 5. USB Events ────────────────────────────────────────────────────────────


@router.post("/usb")
async def push_usb(
    payload: AgentUsbPayload,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes USB device connect/disconnect events.
    Detects DSC tokens, USB drives, phones, printers, etc.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        now = _now_iso()
        events = payload.events or []
        if events:
            docs = []
            for evt in events:
                docs.append(
                    {
                        "agent_id": payload.agent_id,
                        "user_id": payload.user_id,
                        "company_id": company_id,
                        "machine_name": payload.machine_name,
                        "device_type": evt.get("device_type", "unknown"),
                        "device_name": evt.get("device_name", ""),
                        "vendor_id": evt.get("vendor_id"),
                        "product_id": evt.get("product_id"),
                        "serial": evt.get("serial"),
                        "event": evt.get("event", "connected"),
                        "timestamp": evt.get("timestamp", now),
                        "created_at": now,
                    }
                )
            await db.desktop_usb.insert_many(docs, ordered=False)

        return {"success": True, "message": f"USB events saved ({len(events)} events)"}
    except Exception as e:
        logger.error(f"[DesktopAgent] USB push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 6. Productivity Report ───────────────────────────────────────────────────


@router.post("/productivity")
async def push_productivity(
    payload: AgentProductivityPayload,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes computed productivity metrics.
    Includes focus time, idle time, app breakdown, score.
    """
    company_id = enforce_company_value(current_user, None)
    _validate_agent_user(current_user, payload.user_id)
    try:
        report_date = payload.date or _today()
        now = _now_iso()

        await db.desktop_productivity.update_one(
            {
                "agent_id": payload.agent_id,
                "user_id": payload.user_id,
                "date": report_date,
            },
            {
                "$set": {
                    "machine_name": payload.machine_name,
                    "focusTime": payload.focusTime or 0,
                    "idleTime": payload.idleTime or 0,
                    "productiveTime": payload.productiveTime or 0,
                    "unproductiveTime": payload.unproductiveTime or 0,
                    "appBreakdown": payload.appBreakdown or [],
                    "score": payload.score or 0,
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "agent_id": payload.agent_id,
                    "user_id": payload.user_id,
                    "company_id": company_id,
                    "date": report_date,
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return {"success": True, "message": "Productivity report saved"}
    except Exception as e:
        logger.error(f"[DesktopAgent] Productivity push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 7. System Info ───────────────────────────────────────────────────────────


@router.post("/system")
async def push_system_info(
    payload: AgentSystemInfo,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Desktop agent pushes system information on startup and periodically.
    """
    company_id = enforce_company_value(current_user, None)
    try:
        now = _now_iso()
        agent_query = {"agent_id": payload.agent_id}
        if not is_platform_owner(current_user):
            agent_query["company_id"] = company_id
        await db.desktop_agents.update_one(
            agent_query,
            {
                "$set": {
                    "machine_name": payload.machine_name,
                    "hostname": payload.hostname,
                    "platform": payload.platform,
                    "os_version": payload.os_version,
                    "cpu": payload.cpu,
                    "ram_total_mb": payload.ram_total_mb,
                    "disk_total_gb": payload.disk_total_gb,
                    "disk_free_gb": payload.disk_free_gb,
                    "ip_address": payload.ip_address,
                    "mac_address": payload.mac_address,
                    "system_info_updated_at": now,
                },
                "$setOnInsert": {
                    "agent_id": payload.agent_id,
                    "company_id": company_id,
                    "user_id": current_user.id,
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return {"success": True, "message": "System info saved"}
    except Exception as e:
        logger.error(f"[DesktopAgent] System info push error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── 8. Version Check ─────────────────────────────────────────────────────────


@router.get("/version")
async def get_latest_version(db=Depends(get_db)):
    """
    Desktop agent checks for the latest available version.
    Returns the latest version info and download URL.
    """
    latest = await db.desktop_updates.find_one(
        {"active": True},
        sort=[("created_at", -1)],
    )
    if not latest:
        return {"success": True, "update_available": False, "current": "latest"}

    latest.pop("_id", None)
    return {
        "success": True,
        "update_available": True,
        "version": latest.get("version"),
        "download_url": latest.get("download_url"),
        "changelog": latest.get("changelog", ""),
        "signature": latest.get("signature", ""),
        "min_version": latest.get("min_version", "0.0.0"),
        "forced": latest.get("forced", False),
    }


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN READ ENDPOINTS (called by admin panel frontend)
# ══════════════════════════════════════════════════════════════════════════════

# ── Dashboard: Connected Agents ──────────────────────────────────────────────


@router.get("/agents")
async def get_connected_agents(
    status: Optional[str] = Query(
        default=None, description="Filter: online, offline, all"
    ),
    user_id: Optional[str] = Query(default=None, description="Filter by user_id"),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=100, le=500),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Returns list of all registered desktop agents with their current status.
    Admin only.
    """
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    query = await _desktop_scope_query(current_user)

    if status == "online":
        # Online = heartbeat within last 2 minutes
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        query["last_heartbeat"] = {"$gte": cutoff}
    elif status == "offline":
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        query["last_heartbeat"] = {"$lt": cutoff}

    if user_id:
        query["user_id"] = user_id

    if search:
        query["$or"] = [
            {"machine_name": {"$regex": search, "$options": "i"}},
            {"hostname": {"$regex": search, "$options": "i"}},
            {"agent_id": {"$regex": search, "$options": "i"}},
        ]

    docs = (
        await db.desktop_agents.find(query)
        .sort("last_heartbeat", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "agents": docs, "count": len(docs)}


# ── Dashboard: Single Agent Detail ───────────────────────────────────────────


@router.get("/agent/{agent_id}")
async def get_agent_detail(
    agent_id: str,
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns detailed info for a single agent. Admin only."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    agent = await db.desktop_agents.find_one(
        {"$and": [await _desktop_scope_query(current_user), {"agent_id": agent_id}]}
    )
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent.pop("_id", None)
    return {"success": True, "agent": agent}


# ── Activity Reports ─────────────────────────────────────────────────────────


@router.get("/activity")
async def get_activity_reports(
    user_id: Optional[str] = Query(default=None),
    agent_id: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    limit: int = Query(default=50, le=200),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns activity reports. Admin sees all; staff sees own."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    own_id = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))

    query = await _desktop_scope_query(current_user)

    if role_str != "admin":
        query["user_id"] = own_id
    elif user_id:
        query["user_id"] = user_id

    if agent_id:
        query["agent_id"] = agent_id

    if date_from or date_to:
        date_query = {}
        if date_from:
            date_query["$gte"] = date_from
        if date_to:
            date_query["$lte"] = date_to
        query["date"] = date_query

    docs = (
        await db.desktop_activity.find(query)
        .sort("date", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "reports": docs}


# ── Browser Reports ──────────────────────────────────────────────────────────


@router.get("/browser")
async def get_browser_reports(
    user_id: Optional[str] = Query(default=None),
    agent_id: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    limit: int = Query(default=50, le=200),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns browser tracking reports. Admin sees all; staff sees own."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    own_id = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))

    query = await _desktop_scope_query(current_user)

    if role_str != "admin":
        query["user_id"] = own_id
    elif user_id:
        query["user_id"] = user_id
    if agent_id:
        query["agent_id"] = agent_id
    if date_from or date_to:
        date_query = {}
        if date_from:
            date_query["$gte"] = date_from
        if date_to:
            date_query["$lte"] = date_to
        query["date"] = date_query

    docs = (
        await db.desktop_browser.find(query)
        .sort("date", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "reports": docs}


# ── DSC Status ───────────────────────────────────────────────────────────────


@router.get("/dsc")
async def get_dsc_status(
    agent_id: Optional[str] = Query(default=None),
    limit: int = Query(default=50, le=200),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns DSC status events. Admin only."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    query = await _desktop_scope_query(current_user)

    if agent_id:
        query["agent_id"] = agent_id

    docs = (
        await db.desktop_dsc.find(query)
        .sort("updated_at", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "events": docs}


# ── USB Events ───────────────────────────────────────────────────────────────


@router.get("/usb")
async def get_usb_events(
    agent_id: Optional[str] = Query(default=None),
    limit: int = Query(default=100, le=500),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns USB device events. Admin only."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    query = await _desktop_scope_query(current_user)

    if agent_id:
        query["agent_id"] = agent_id

    docs = (
        await db.desktop_usb.find(query)
        .sort("timestamp", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "events": docs}


# ── Productivity Reports ─────────────────────────────────────────────────────


@router.get("/productivity")
async def get_productivity_reports(
    user_id: Optional[str] = Query(default=None),
    agent_id: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    limit: int = Query(default=50, le=200),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns productivity reports. Admin sees all; staff sees own."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    own_id = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))

    query = await _desktop_scope_query(current_user)

    if role_str != "admin":
        query["user_id"] = own_id
    elif user_id:
        query["user_id"] = user_id
    if agent_id:
        query["agent_id"] = agent_id
    if date_from or date_to:
        date_query = {}
        if date_from:
            date_query["$gte"] = date_from
        if date_to:
            date_query["$lte"] = date_to
        query["date"] = date_query

    docs = (
        await db.desktop_productivity.find(query)
        .sort("date", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "reports": docs}


# ── Agent Health ─────────────────────────────────────────────────────────────


@router.get("/agent/{agent_id}/health")
async def get_agent_health(
    agent_id: str,
    hours: int = Query(default=24, le=168),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns health history for an agent over the specified hours."""
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    docs = (
        await db.desktop_health.find(
            {
                "$and": [
                    await _desktop_scope_query(current_user),
                    {"agent_id": agent_id, "timestamp": {"$gte": cutoff}},
                ],
            }
        )
        .sort("timestamp", 1)
        .to_list(length=5000)
    )

    for doc in docs:
        doc.pop("_id", None)

    return {"success": True, "health": docs}


# ── Summary Dashboard ────────────────────────────────────────────────────────


@router.get("/summary")
async def get_desktop_summary(
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Returns a summary dashboard overview:
    - Total agents, online agents
    - Today's total active time across all agents
    - Average productivity score
    - DSC connected count
    - USB events today
    Admin only.
    """
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    today = _today()
    cutoff_online = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()

    scope = await _desktop_scope_query(current_user)
    total_agents = await db.desktop_agents.count_documents(scope)
    online_agents = await db.desktop_agents.count_documents({"$and": [scope, {"last_heartbeat": {"$gte": cutoff_online}}]})
    dsc_connected = await db.desktop_agents.count_documents({"$and": [scope, {"dsc_plugged": True}]})

    # Today's activity summary
    today_activities = await db.desktop_activity.find({"$and": [scope, {"date": today}]}).to_list(
        length=500
    )
    total_active_today = sum(a.get("activeSeconds", 0) for a in today_activities)
    total_focus_today = sum(a.get("focusSeconds", 0) for a in today_activities)

    # Productivity score average
    today_prod = await db.desktop_productivity.find({"$and": [scope, {"date": today}]}).to_list(length=500)
    avg_score = 0
    if today_prod:
        avg_score = sum(p.get("score", 0) for p in today_prod) / len(today_prod)

    # USB events today
    usb_today = await db.desktop_usb.count_documents({"$and": [scope, {"timestamp": {"$gte": today + "T00:00:00"}}]})

    return {
        "success": True,
        "summary": {
            "total_agents": total_agents,
            "online_agents": online_agents,
            "dsc_connected": dsc_connected,
            "total_active_today_seconds": total_active_today,
            "total_focus_today_seconds": total_focus_today,
            "avg_productivity_score": round(avg_score, 1),
            "usb_events_today": usb_today,
            "activity_reports_today": len(today_activities),
        },
    }


# ── Export Reports ───────────────────────────────────────────────────────────


@router.get("/export/{report_type}")
async def export_reports(
    report_type: str,
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    current_user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Export reports as JSON.
    Supported: activity, browser, productivity, dsc, usb
    Admin only.
    """
    role = current_user.role
    role_str = role.value if hasattr(role, "value") else str(role)
    if role_str != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    collection_map = {
        "activity": "desktop_activity",
        "browser": "desktop_browser",
        "productivity": "desktop_productivity",
        "dsc": "desktop_dsc",
        "usb": "desktop_usb",
    }

    if report_type not in collection_map:
        raise HTTPException(
            status_code=400, detail=f"Unknown report type: {report_type}"
        )

    collection_name = collection_map[report_type]
    query = await _desktop_scope_query(current_user)


    if date_from or date_to:
        date_query = {}
        if date_from:
            date_query["$gte"] = date_from
        if date_to:
            date_query["$lte"] = date_to
        if report_type in ("activity", "browser", "productivity"):
            query["date"] = date_query
        else:
            query["timestamp"] = date_query

    docs = (
        await db[collection_name]
        .find(query)
        .sort("date" if "date" in query else "timestamp", -1)
        .to_list(length=10000)
    )
    for doc in docs:
        doc.pop("_id", None)

    return {
        "success": True,
        "report_type": report_type,
        "count": len(docs),
        "data": docs,
    }
