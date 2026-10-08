"""
activity_monitor.py
────────────────────────────────────────────────────────────────────────────────
Backend routes for the Taskosphere Computer Activity Monitor.

Two flows:
  PUSH  — Agent on staff PC pushes daily report to POST /api/activity/report
  PULL  — Admin fetches stored reports via GET /api/activity/report/:user_id

The agent calls POST at end of day (or every hour). The admin panel calls GET.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from datetime import datetime, date
from typing import Optional
from bson import ObjectId
from backend.dependencies import get_current_user, get_db, admin_required

router = APIRouter(prefix="/activity", tags=["activity"])

# ── Helper ────────────────────────────────────────────────────────────────────

def _today() -> str:
    return date.today().isoformat()

# ── PUSH: Agent posts daily report ───────────────────────────────────────────

@router.post("/report")
async def push_activity_report(
    payload: dict,
    db=Depends(get_db),
):
    """
    Called by the local agent on staff PC to push today's activity report.
    The agent includes the staff user_id and machine name in the payload.

    Payload shape (mirrors activityMonitor.js getReport() output):
    {
      "user_id": "...",
      "machine": "DESKTOP-ABC",
      "date": "2026-01-15",
      "sessions": [{"start": "...", "end": "..."}],
      "totalActive": "6h 23m",
      "totalIdle": "1h 12m",
      "activeSeconds": 22980,
      "idleSeconds": 4320,
      "topApps": [{"name": "Chrome", "seconds": 8000, "human": "2h 13m"}],
      "topWebsites": [{"domain": "google.com", "seconds": 3000, "human": "50m"}]
    }
    """
    user_id = payload.get("user_id")
    report_date = payload.get("date", _today())

    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    # Upsert: one document per user per date
    await db.computer_activity.update_one(
        {"user_id": user_id, "date": report_date},
        {"$set": {
            **payload,
            "updated_at": datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    return {"success": True, "message": "Report saved"}

# ── GET: Admin fetches report for a staff member ──────────────────────────────

@router.get("/report/{user_id}")
async def get_activity_report(
    user_id: str,
    date: Optional[str] = Query(default=None),
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Returns the stored activity report for a given user on a given date.
    Admin only. Staff can only see their own report.
    """
    is_admin = getattr(current_user, "role", None) == "admin"
    own_id   = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))

    # Non-admin can only see own data
    if not is_admin and user_id != own_id:
        raise HTTPException(status_code=403, detail="Access denied")

    report_date = date or _today()

    doc = await db.computer_activity.find_one(
        {"user_id": user_id, "date": report_date},
        {"_id": 0},
    )

    if not doc:
        return {"success": False, "error": "No report found for this date"}

    return {"success": True, "report": doc}

# ── GET: Admin fetches all staff reports for a date ───────────────────────────

@router.get("/reports/daily")
async def get_all_daily_reports(
    date: Optional[str] = Query(default=None),
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns all staff activity reports for a given date. Admin only."""
    is_admin = getattr(current_user, "role", None) == "admin"
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    report_date = date or _today()
    docs = await db.computer_activity.find(
        {"date": report_date},
        {"_id": 0},
    ).to_list(length=200)

    return {"success": True, "date": report_date, "reports": docs}

# ── GET: Date range report for a user ─────────────────────────────────────────

@router.get("/report/{user_id}/range")
async def get_activity_range(
    user_id: str,
    from_date: Optional[str] = Query(default=None, alias="from"),
    to_date:   Optional[str] = Query(default=None, alias="to"),
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):
    """Returns reports for a user across a date range. Admin only."""
    is_admin = getattr(current_user, "role", None) == "admin"
    own_id   = str(getattr(current_user, "id", "") or getattr(current_user, "_id", ""))

    if not is_admin and user_id != own_id:
        raise HTTPException(status_code=403, detail="Access denied")

    query = {"user_id": user_id}
    if from_date: query["date"] = {"$gte": from_date}
    if to_date:
        query.setdefault("date", {})
        query["date"]["$lte"] = to_date

    docs = await db.computer_activity.find(query, {"_id": 0}).sort("date", 1).to_list(length=365)
    return {"success": True, "reports": docs}
