from __future__ import annotations
import asyncio
import logging
import os
import httpx
import pytz
from bson import ObjectId
from backend.dependencies import db
from backend.server_modules.attendance_jobs import mark_absent_users_task, force_punch_out_11pm_task
logger=logging.getLogger(__name__)

def register_startup_event(app, scheduler, set_event_loop):
    @app.on_event("startup")
    async def startup_event():
        import backend.server as _server
        for _name, _value in vars(_server).items():
            if not _name.startswith("__"):
                globals()[_name]=_value
        import backend.server as _self

        # Resolve runtime-owned helpers once from the composed server module.
        create_compliance_indexes = _server.create_compliance_indexes
        create_salary_slip_indexes = _server.create_salary_slip_indexes
        create_gst_reconciliation_indexes = _server.create_gst_reconciliation_indexes
        create_zte_indexes = _server.create_zte_indexes
        create_aiweave_indexes = _server.create_aiweave_indexes
        create_gst_portal_sync_indexes = _server.create_gst_portal_sync_indexes
        create_accounting_integrity_indexes = _server.create_accounting_integrity_indexes
        create_accounting_extended_indexes = _server.create_accounting_extended_indexes
        create_desktop_indexes = _server.create_desktop_indexes
        fetch_indian_holidays_task = _server.fetch_indian_holidays_task
        birthday_automation_job = _server.birthday_automation_job
        festival_greeting_job = _server.festival_greeting_job
        service_expiry_alert_job = _server.service_expiry_alert_job
        follow_up_reminder_job = _server.follow_up_reminder_job
        wa_dsc_expiry_job = _server.wa_dsc_expiry_job
        wa_compliance_job = _server.wa_compliance_job
        wa_scheduled_bulk_job = _server.wa_scheduled_bulk_job
        wa_bridge_keepalive_job = _server.wa_bridge_keepalive_job
        datetime = _server.datetime

        _self.app_event_loop = asyncio.get_event_loop()
        try:
            await db.tasks.create_index("assigned_to")
            # ── Activity Timeline & Automation Engine indexes ──────────────────
            await db.client_activities.create_index([("client_id", 1), ("created_at", -1)])
            await db.pending_client_messages.create_index([("status", 1), ("created_at", -1)])
            await db.service_expiries.create_index("client_id")
            await db.service_expiries.create_index("expiry_date")
            await create_compliance_indexes()
            await create_salary_slip_indexes()
            await create_gst_reconciliation_indexes()
            try:
                await db.mis_transactions.create_index([("client_id", 1), ("period", 1), ("doc_type", 1)])
                await db.mis_uploads.create_index([("client_id", 1), ("period", 1)])
                await db.mis_manual.create_index([("client_id", 1), ("period", 1)], unique=True)
            except Exception as _mis_idx_err:
                logger.warning(f"MIS index creation skipped: {_mis_idx_err}")
            await create_zte_indexes()
        
            # --- PHASE 10 SELF-LEARNING INDEXES ---
            try:
                await db.knowledge_base.create_index([("company_id", 1), ("category", 1), ("key", 1)], unique=True)
                await db.learning_events.create_index([("company_id", 1), ("created_at", -1)])
                await db.manual_corrections.create_index([("company_id", 1), ("created_at", -1)])
                await db.recommendation_history.create_index([("company_id", 1), ("status", 1)])