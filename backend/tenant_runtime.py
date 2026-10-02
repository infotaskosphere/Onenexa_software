"""Central tenant-isolation helpers for the commercial SaaS backend."""

from __future__ import annotations

import inspect
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Mapping

from fastapi import HTTPException, status

from backend.platform_owner import is_platform_owner

COMPANY_FIELD = "company_id"
COMPANY_ID_FIELD = "id"

TENANT_COLLECTIONS = {
    # Tasks & Todos & Visits
    "tasks", "todos", "reminders", "visits", "due_dates",
    # Clients, Drive, & Discussions
    "clients", "client_activities", "client_drive_visibility", "client_discussions",
    "client_portal_users", "client_portal_activity",
    # Invoicing, Banking, & Accounting
    "invoices", "payments", "purchase_invoices", "purchase_payments", "purchases",
    "bank_accounts", "bank_transactions", "bank_rules", "bank_reconciliation",
    "bank_reconciliation_matches", "bank_reconciliation_audit", "bank_statistics",
    "bank_transaction_history", "bank_learning", "bank_statement_templates", "cashflow_history",
    "chart_of_accounts", "accounting_audit_trail", "bulk_import_jobs", "finix_ai_proposals", "finix_ai_documents", "finix_ai_learning", "journal_entries", "journal_lines",
    "accounting_audit", "accounting_audit_locks", "accounting_audit_sequences",
    "accounting_locks", "accounting_posting_failures", "accounting_rules", "accounting_sequences",
    "adjustment_note_overrides", "ledger_learning", "posting_history", "posting_audit", "journal_templates", "voucher_history",
    "party_ledgers", "opening_balances", "fixed_assets", "depreciation_runs",
    "tds_tcs_entries", "einvoice_history", "ewaybill_history", "standalone_govt_fees", "financial_validations", "reconciliation_events",
    # Leads & Quotations
    "leads", "quotations",
    # Records & Vaults
    "dsc_register", "passwords", "password_access_logs", "documents",
    # Compliance & Filings
    "compliances", "compliance_records", "compliance_masters", "compliance_assignments",
    "compliance_comments", "trademark_sphere", "trademark_sphere_reminders",
    "trademark_qc_reports", "trademark_qc_branding", "roc_companies", "roc_documents",
    "gst_reconciliation_history", "gst_reconciliation_sessions", "gst_returns",
    "gst_compliances", "gst_portal_snapshots", "gst_portal_registrations",
    "gst_trade_names", "gst_vendor_profiles", "gst_portal_audit_risk", "vendor_profiles", "vendor_rule_overrides", "vendor_learning_history",
    # HR, Attendance & Payroll
    "attendance", "identix_attendance", "salary_slips", "salary_employees",
    "salary_manual_companies", "interview_candidates", "leaves", "holidays", "staff_activity",
    # MIS & Analytics
    "mis_manual", "mis_transactions", "mis_uploads", "analytics_data", "kpi_history",
    # AI & Workflow
    "knowledge_base", "learning_events", "manual_corrections", "recommendation_history",
    "learning_audit", "template_usage_history", "ai_validation_results", "ai_confidence_history", "ai_anomaly_history",
    "ai_document_memory", "ai_document_workspace", "ai_workspace_knowledge", "document_classifications",
    "ocr_processing_history", "ocr_quality_reports",
    "workflow_definitions", "workflow_instances", "workflow_history", "aiweave_conversations", "aiweave_executions", "aiweave_provider_accounts", "aiweave_provider_models", "aiweave_routing_rules",
    "approval_requests", "approval_history", "automation_rules", "business_events",
    "notification_history", "workflow_audit", "notifications",
    "whatsapp_hub_contacts", "whatsapp_hub_groups", "whatsapp_hub_messages",
    "zte_processed_documents", "zte_category_rules", "template_library"
}

COMPANY_REGISTRY_COLLECTION = "companies"

_current_company: ContextVar[str | None] = ContextVar("taskosphere_company_id", default=None)
_current_platform_owner: ContextVar[bool] = ContextVar("taskosphere_platform_owner", default=False)
_system_context: ContextVar[bool] = ContextVar("taskosphere_system_context", default=False)


def set_authenticated_company(company_id: Any):
    value = str(company_id).strip() if company_id is not None else ""
    if not value:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")
    return _current_company.set(value)


def reset_authenticated_company(token) -> None:
    _current_company.reset(token)


def authenticated_company_id() -> str | None:
    return _current_company.get()


def set_platform_owner(value: bool = True):
    return _current_platform_owner.set(bool(value))


def reset_platform_owner(token) -> None:
    _current_platform_owner.reset(token)


def in_platform_owner_context() -> bool:
    return _current_platform_owner.get()


def in_system_context() -> bool:
    return _system_context.get()


@contextmanager
def system_context():
    """Explicitly mark trusted internal jobs as system-scoped.

    This is intentionally opt-in. It is not exposed to request handlers and
    must only be used by trusted server-side maintenance/scheduler code.
    """
    token = _system_context.set(True)
    try:
        yield
    finally:
        _system_context.reset(token)


def get_company_id(current_user: Any) -> str:
    company_id = getattr(current_user, COMPANY_FIELD, None)
    if company_id is None or not str(company_id).strip():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Authenticated user is not associated with a company")
    return str(company_id).strip()


def company_filter(current_user: Any, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    query = {COMPANY_FIELD: get_company_id(current_user)}
    if extra:
        query.update(dict(extra))
    return query


def enforce_company_value(current_user: Any, value: Any) -> str:
    # Platform owners are intentionally allowed to operate across customer
    # companies. Normal tenant users remain strictly company-scoped.
    if in_platform_owner_context():
        if value is not None and str(value).strip():
            return str(value).strip()
        company_id = getattr(current_user, COMPANY_FIELD, None)
        if company_id is not None and str(company_id).strip():
            return str(company_id).strip()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Company context is required for this operation")
    authenticated = get_company_id(current_user)
    if value is not None and str(value).strip() != authenticated:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    return authenticated


def force_company_id(current_user: Any, record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    result[COMPANY_FIELD] = enforce_company_value(current_user, result.get(COMPANY_FIELD))
    return result


def assert_record_company(current_user: Any, record: Mapping[str, Any] | None) -> None:
    if record is None:
        return
    if in_platform_owner_context():
        return
    authenticated = get_company_id(current_user)
    if record.get(COMPANY_FIELD) is None or str(record.get(COMPANY_FIELD)) != authenticated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")


def _is_commercial_control_context() -> bool:
    """Return True for commercial control-plane, licensing, and system setup operations."""
    if in_system_context():
        return True
    for frame_info in inspect.stack(context=0):
        module_name = str(frame_info.frame.f_globals.get("__name__") or "")
        if (
            module_name.startswith("backend.commercial_")
            or module_name.startswith("backend.licensing_")
            or module_name.startswith("backend.platform_owner")
            or module_name == "backend.backup_restore"
            or (module_name == "backend.invoicing" and frame_info.function in {"create_invoice", "_next_invoice_no", "recalculate_invoice_accounting"})
        ):
            return True
    return False


def _scope_query(query: Any) -> dict[str, Any]:
    company_id = authenticated_company_id()
    base = dict(query or {}) if isinstance(query, dict) else {}
    if in_platform_owner_context():
        if _is_commercial_control_context():
            return base
        # If platform owner explicitly queries a specific company_id, permit it
        if base.get(COMPANY_FIELD):
            return base
        # When platform owner operates inside normal operational modules for own practice (Tenant #1),
        # automatically isolate queries to owner's dedicated company workspace
        if company_id:
            base[COMPANY_FIELD] = company_id
        return base
    if not company_id:
        return base
    requested = base.get(COMPANY_FIELD)
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_FIELD] = company_id
    return base


def _scope_company_registry_query(query: Any) -> dict[str, Any]:
    if in_platform_owner_context():
        return query if isinstance(query, dict) else {}
    company_id = authenticated_company_id()
    if not company_id:
        return query if isinstance(query, dict) else {}
    base = dict(query or {})
    requested = base.get(COMPANY_ID_FIELD)
    if requested is not None:
        if isinstance(requested, dict) or str(requested) != company_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_ID_FIELD] = company_id
    return base


def _scope_company_registry_insert(document: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id() or not isinstance(document, dict):
        return document
    result = dict(document)
    requested = result.get(COMPANY_ID_FIELD)
    company_id = authenticated_company_id()
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company company creation is not permitted")
    result[COMPANY_ID_FIELD] = company_id
    return result


def _scope_company_registry_update(update: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id():
        return update
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if COMPANY_ID_FIELD in set_values and str(set_values[COMPANY_ID_FIELD]) != authenticated_company_id():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Company ID cannot be changed")
    set_values.pop(COMPANY_ID_FIELD, None)
    if set_values:
        result["$set"] = set_values
    elif "$set" in result:
        result.pop("$set", None)
    return result


def _scope_update(update: Any) -> Any:
    company_id = authenticated_company_id()
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if in_platform_owner_context():
        if _is_commercial_control_context() and (COMPANY_FIELD in set_values or COMPANY_FIELD in result):
            return update
        if not set_values.get(COMPANY_FIELD) and COMPANY_FIELD not in result and company_id:
            set_values[COMPANY_FIELD] = company_id
            result["$set"] = set_values
        return result
    if not company_id:
        return update
    if isinstance(update, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tenant update pipelines are not permitted")
    unset_values = dict(result.get("$unset") or {})
    if COMPANY_FIELD in unset_values:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="company_id cannot be removed")
    if COMPANY_FIELD in set_values and str(set_values[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    set_values[COMPANY_FIELD] = company_id
    result["$set"] = set_values
    return result


def _scope_replacement(replacement: Any) -> Any:
    company_id = authenticated_company_id()
    if not isinstance(replacement, dict):
        return replacement
    result = dict(replacement)
    if in_platform_owner_context():
        if _is_commercial_control_context() and result.get(COMPANY_FIELD):
            return result
        # For platform owner operating in normal modules, stamp owner's dedicated company_id
        if not result.get(COMPANY_FIELD) and company_id:
            result[COMPANY_FIELD] = company_id
        return result
    if not company_id:
        return result
    if result.get(COMPANY_FIELD) is not None and str(result[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    result[COMPANY_FIELD] = company_id
    return result


class TenantAwareCollection:
    def __init__(self, collection: Any, name: str):
        self._collection = collection
        self._name = name

    def _enabled(self) -> bool:
        return self._name in TENANT_COLLECTIONS and authenticated_company_id() is not None and not in_system_context()

    def _company_registry_enabled(self) -> bool:
        return self._name == COMPANY_REGISTRY_COLLECTION and authenticated_company_id() is not None and not in_system_context()

    def find(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return self._collection.find(query, *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one(query, *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.count_documents(query, *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.distinct(key, query, *args, **kwargs)

    async def insert_one(self, document, *args, **kwargs):
        if self._enabled(): document = _scope_replacement(document)
        elif self._company_registry_enabled(): document = _scope_company_registry_insert(document)
        return await self._collection.insert_one(document, *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        if self._enabled(): documents = [_scope_replacement(document) for document in documents]
        elif self._company_registry_enabled(): documents = [_scope_company_registry_insert(document) for document in documents]
        return await self._collection.insert_many(documents, *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_one(query, update, *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_many(query, update, *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, replacement = _scope_query(query), _scope_replacement(replacement)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.replace_one(query, replacement, *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.find_one_and_update(query, update, *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, replacement = _scope_query(query), _scope_replacement(replacement)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.find_one_and_replace(query, replacement, *args, **kwargs)

    async def find_one_and_delete(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one_and_delete(query, *args, **kwargs)

    async def delete_one(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_one(query, *args, **kwargs)

    async def delete_many(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_many(query, *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if self._enabled():
            pipeline = list(pipeline or [])
            if in_platform_owner_context():
                if _is_commercial_control_context():
                    return self._collection.aggregate(pipeline, *args, **kwargs)
                if authenticated_company_id():
                    pipeline.insert(0, {"$match": {COMPANY_FIELD: authenticated_company_id()}})
                return self._collection.aggregate(pipeline, *args, **kwargs)
            pipeline.insert(0, {"$match": {COMPANY_FIELD: authenticated_company_id()}})
        elif self._company_registry_enabled():
            pipeline = list(pipeline or [])
            if not in_platform_owner_context():
                pipeline.insert(0, {"$match": {COMPANY_ID_FIELD: authenticated_company_id()}})
        return self._collection.aggregate(pipeline, *args, **kwargs)

    async def bulk_write(self, requests, *args, **kwargs):
        if not self._enabled(): return await self._collection.bulk_write(requests, *args, **kwargs)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bulk writes are not permitted on tenant collections")

    def __getattr__(self, name):
        return getattr(self._collection, name)


class TenantAwareDatabase:
    def __init__(self, database: Any): self._database = database
    def __getitem__(self, name): return TenantAwareCollection(self._database[name], name)
    def __getattr__(self, name): return self[name]
