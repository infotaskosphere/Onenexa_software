import os
import re
import csv
import uuid
import json
import base64
import hashlib
import hmac
import secrets
import logging
import pytz
import traceback
import asyncio
import calendar
import requests
import httpx
import shutil
import pandas as pd
from datetime import datetime, date, timezone, timedelta, time as dtime
from collections import Counter

from backend.quickcompany_trademark_router import router as qc_trademark_router
from backend.whatsapp_hub import router as whatsapp_hub_router
from backend.compliance import router as compliance_router, create_compliance_indexes
from backend.roc_sphere import router as roc_sphere_router  # ROC Sphere: Companies Act document automation
from backend.roc_forms_dump import router as roc_forms_dump_router, resume_pending_roc_dump_jobs  # Historical ROC Forms Dump
from backend.salary_slip_router import router as salary_slip_router, create_salary_slip_indexes
from backend.ai_document_reader import router as ai_document_reader_router
from backend.ai.aiweave_router import router as aiweave_router, create_aiweave_indexes
from backend.gst_reconciliation import router as gst_reconciliation_router
from backend.mis_report import router as mis_report_router
from backend.gst_reconciliation import create_gst_reconciliation_indexes
from backend.zero_touch_entry import router as zero_touch_entry_router, create_zte_indexes
from backend.learning.learning_router import router as learning_router
from backend.gst_portal_sync import router as gst_portal_sync_router, create_gst_portal_sync_indexes
from backend.accounting_lock import router as accounting_lock_router, create_accounting_integrity_indexes
from backend.reminders_router import router as reminders_router
from backend.quotations import router as quotation_router
from backend.purchases import router as purchases_router
from backend.attendance_identix import identix_router
from backend.google_auth import router as google_auth_router
from backend.website_tracking import router as website_tracking_router
from backend.invoicing import router as invoicing_router
from backend.accounting_core import router as accounting_router
from backend.party_ledgers import router as party_ledgers_router
from backend.accounting_ai.finix_ai_router import router as finix_ai_router
from backend.accounting_ai.finix_complete_router import router as finix_complete_router
from backend.accounting_extended import router as accounting_ext_router
from backend.accounting_extended import create_accounting_extended_indexes
from backend.bank_accounts import router as bank_accounts_router
from backend.permission_governance import router as permission_governance_router
from backend.roles_admin import router as roles_admin_router
from backend.governed_modules import ALL_GOVERNED_ROUTERS
from backend.security.rate_limiter import RateLimiter
from backend.security.audit_security import AuditSecurity
from backend.security.session_manager import SessionManager
from backend.security.security_monitor import SecurityMonitor
from backend.visits import router as visits_router
from backend.leads import router as leads_router
from backend.client_activity import router as client_activity_router
from backend.automation_engine import router as automation_router, expiry_router as service_expiry_router
from backend.recruitment import (
    router as recruitment_router,
    list_candidates as recruitment_list_candidates,
)
from backend.telegram import router as telegram_router
from backend.notifications import router as notification_router, create_notification, notify_admins_leave


from backend.email_integration import router as email_router
from backend.trademark_sphere import router as trademark_sphere_router
from backend.trademark_portals_router import router as trademark_portals_router

# Gemini AI instance (already configured in email_integration module)
try:
    from backend.email_integration import _gemini as _gemini_ai
except ImportError:
    _gemini_ai = None
from backend.passwords import router as passwords_router
from backend.auth_password_reset import router as auth_password_reset_router
from backend.client_portal import router as client_portal_router
from backend.activity_monitor import router as activity_monitor_router
from backend.desktop_agent import router as desktop_agent_router, create_desktop_indexes
from backend.whatsapp_integration import router as whatsapp_router
from backend.whatsapp_scheduler import (
    wa_dsc_expiry_job,
    wa_compliance_job,
)
from backend.whatsapp_integration import wa_scheduled_bulk_job, wa_bridge_keepalive_job
from backend.automation_engine import (
    birthday_automation_job,
    festival_greeting_job,
    service_expiry_alert_job,
    follow_up_reminder_job,
)

from zoneinfo import ZoneInfo
from pathlib import Path
from io import StringIO, BytesIO
from typing import List, Optional, Dict, Any
from dateutil import parser
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

from fastapi import (
    FastAPI,
    APIRouter,
    Depends,
    HTTPException,
    status,
    BackgroundTasks,
    UploadFile,
    File,
    Form,
    Query,
    Request,
    Body,
)
from fastapi.security import HTTPBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from passlib.context import CryptContext

from pydantic import (
    BaseModel,
    EmailStr,
    Field,
    ConfigDict,
    field_validator,
    ValidationError,
)
from bson import ObjectId
from dotenv import load_dotenv

# --- BACKEND MODULE IMPORTS ---
import backend.models as models
from backend.models import (
    Token,
    User,
    UserCreate,
    UserLogin,
    UserPermissions,
    Todo,
    TodoCreate,
    Task,
    TaskCreate,
    BulkTaskCreate,
    Client,
    ClientCreate,
    MasterClientForm,
    Attendance,
    StaffActivityLog,
    StaffActivityCreate,
    PerformanceMetric,
    DueDate,
    DueDateCreate,
    DSC,
    DSCCreate,
    DSCListResponse,
    DSCMovementRequest,
    MovementUpdateRequest,
    Document,
    DocumentCreate,
    DocumentMovementRequest,
    DashboardStats,
    AuditLog,
    HolidayResponse,
    HolidayCreate,
    DEFAULT_ROLE_PERMISSIONS,
    Reminder,
    ReminderCreate,
    OffboardRequest,
)
from backend.tenant_runtime import system_context
from backend.dependencies import (
    db,
    client,
    get_current_user,
    create_access_token,
    check_permission,
    check_module_permission,
    assert_module_permission,
    assert_record_visibility,
    check_record_visibility,
    require_admin,
    require_manager_or_admin,
    verify_record_access,
    verify_client_access,
    can_view_client,
    get_team_user_ids,
    get_cross_visibility_union,
    get_user_permissions,   # moved to dependencies — single source of truth
    personal_birthday_candidates,
)

from fpdf import FPDF
from apscheduler.schedulers.background import BackgroundScheduler

# Single IST definition
IST = pytz.timezone("Asia/Kolkata")
india_tz = ZoneInfo("Asia/Kolkata")

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ── MCA Portal API config ─────────────────────────────────────────────────────
MCA_API_KEY = os.getenv("MCA_API_KEY", "")
MCA_API_BASE_URL = os.getenv("MCA_API_BASE_URL", "https://api.mca.gov.in/MCA21/api/v1")

# ── Main event loop reference (set at startup, used by APScheduler sync jobs) ─
app_event_loop = None

# ── Attendance proof upload directory ─────────────────────────────────────────
PROOF_UPLOAD_DIR = ROOT_DIR / "uploads" / "attendance_proof"
PROOF_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ====================== SECURITY CONFIG ===========================
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ====================== SCHEDULER ======================
scheduler = BackgroundScheduler(timezone=pytz.timezone("Asia/Kolkata"))

# IN-MEMORY CACHE for daily reminder (avoids DB query on every request)
_last_reminder_date_cache: Optional[str] = None

# ====================== APP ======================
from backend.server_modules.lifecycle import register_shutdown_handler
from backend.server_modules.holiday_jobs import fetch_indian_holidays_task, configure_event_loop as configure_holiday_event_loop
from backend.server_modules.attendance_jobs import _mark_absent_for_date, mark_absent_users_task, _force_punch_out_at_7pm, force_punch_out_11pm_task, configure_event_loop as configure_attendance_event_loop
from backend.server_modules.helpers import safe_dt, sanitize_user_data, convert_objectids, is_own_record, create_audit_log, _expected_hours_pure, calculate_expected_hours
from backend.server_modules.task_analytics import get_task_analytics as _get_task_analytics
from backend.server_modules.website_activity import register_website_activity
from backend.server_modules.task_popup import create_task_assigned_popup
from backend.server_modules.scheduler_jobs import register_scheduler_jobs
from backend.server_modules.startup_indexes import initialize_startup_indexes
from backend.server_modules.startup_bootstrap import start_bootstrap_tasks
from backend.server_modules.startup_orchestrator import run_startup_orchestration
from backend.server_modules.email_service_routes import register_email_service_routes
from backend.server_modules.task_duplicate_detection import register_task_duplicate_detection
from backend.server_modules.auth_routes import register_auth_routes
from backend.server_modules.users_todos_admin import register_users_todos_admin
from backend.server_modules.attendance_routes import register_attendance_routes
from backend.server_modules.salary_reports import register_salary_reports
from backend.server_modules.task_routes import register_task_routes
from backend.server_modules.dsc_routes import register_dsc_routes
from backend.server_modules.document_routes import register_document_routes
from backend.server_modules.compliance_due_dates import register_compliance_due_dates
from backend.server_modules.reporting_and_master import register_reporting_and_master
from backend.server_modules.client_import_parsing import register_client_import_parsing
from backend.server_modules.client_management import register_client_management
from backend.server_modules.dashboard_ops import register_dashboard_ops
from backend.server_modules.holiday_trademark_misc import register_holiday_trademark_misc
from backend.server_modules.application_runtime import register_application_runtime

app = FastAPI(title="Taskosphere Backend", redirect_slashes=False)
api_router = APIRouter(prefix="/api")
register_shutdown_handler(app, scheduler)

_PHASE2_ROUTE_MODULES = [
    register_email_service_routes,
    register_task_duplicate_detection,
    register_auth_routes,
    register_users_todos_admin,
    register_attendance_routes,
    register_salary_reports,
    register_task_routes,
    register_dsc_routes,
    register_document_routes,
    register_compliance_due_dates,
    register_reporting_and_master,
    register_client_import_parsing,
    register_client_management,
    register_dashboard_ops,
    register_holiday_trademark_misc,
    register_website_activity,
]

for _register_phase2_routes in _PHASE2_ROUTE_MODULES:
    _register_phase2_routes(globals())



register_application_runtime(globals())

# ─────────────────────────────────────────────────────────────────────────────
# LATE ROUTER MOUNTS
# The legacy api_router is mounted by holiday_trademark_misc.py before the
# remaining Phase 2 runtime routers are appended to api_router. FastAPI copies
# router routes at include time, so those later additions would otherwise 404.
# Mount the affected legacy routers directly on the app after the full runtime
# registration. This preserves the existing route modules and avoids changing
# their prefixes or business logic.
# ─────────────────────────────────────────────────────────────────────────────
from backend.website_config import router as website_config_router
from backend.hr_core import ALL_HR_CORE_ROUTERS

app.include_router(notification_router, prefix="/api")
app.include_router(visits_router, prefix="/api")
app.include_router(email_router, prefix="/api")
app.include_router(website_config_router, prefix="/api")
app.include_router(client_portal_router, prefix="/api")
app.include_router(roc_forms_dump_router, prefix="/api/roc-sphere")
for _hr_router in ALL_HR_CORE_ROUTERS:
    app.include_router(_hr_router, prefix="/api")

# LeadSense Client Discussion collection compatibility.
# The LeadSense hub requests a collection-level /api/client-discussion feed.
# The existing client_activity router is intentionally client-scoped, so it
# cannot satisfy that collection endpoint. Expose a read-only aggregate feed
# from the same client_activities collection without changing the existing
# client activity APIs.
async def _leadsense_client_discussion_feed(current_user=Depends(get_current_user)):
    items = await db.client_activities.find(
        {},
        {"_id": 0},
    ).sort("created_at", -1).limit(500).to_list(500)
    return items

app.add_api_route(
    "/api/client-discussion",
    _leadsense_client_discussion_feed,
    methods=["GET"],
    include_in_schema=False,
)
app.add_api_route(
    "/api/client-discussion/",
    _leadsense_client_discussion_feed,
    methods=["GET"],
    include_in_schema=False,
)


from backend.legacy_router_mounts import register_legacy_router_mounts

register_legacy_router_mounts(
    app,
    (
        invoicing_router,
        accounting_router,
        party_ledgers_router,
        finix_ai_router,
        finix_complete_router,
        accounting_ext_router,
        bank_accounts_router,
        permission_governance_router,
        roles_admin_router,
        compliance_router,
        roc_sphere_router,
        gst_reconciliation_router,
        mis_report_router,
        passwords_router,
        auth_password_reset_router,
        website_tracking_router,
        quotation_router,
        purchases_router,
        telegram_router,
        leads_router,
        client_activity_router,
        automation_router,
        service_expiry_router,
        recruitment_router,
        notification_router,
        email_router,
        activity_monitor_router,
        desktop_agent_router,
        client_portal_router,
        reminders_router,
        whatsapp_router,
        trademark_sphere_router,
    ),
    (
        zero_touch_entry_router,
        learning_router,
        gst_portal_sync_router,
        accounting_lock_router,
        ai_document_reader_router,
        aiweave_router,
        trademark_portals_router,
        salary_slip_router,
        google_auth_router,
    ),
)
