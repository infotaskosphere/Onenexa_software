"""Phase A domain ownership contracts.

This file is intentionally declarative and dependency-free. It does not
register routers, import production modules, connect to MongoDB, or change
runtime behavior.

Each domain declares:
- collections it owns;
- collections it may consume from another domain;
- current source areas that remain in place during migration.

The contract is a migration guardrail, not a second runtime registry.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping


def _contract(
    *,
    owns: tuple[str, ...],
    consumes: tuple[str, ...],
    current_sources: tuple[str, ...],
) -> Mapping[str, tuple[str, ...]]:
    return MappingProxyType(
        {
            "owns": owns,
            "consumes": consumes,
            "current_sources": current_sources,
        }
    )


PLATFORM = _contract(
    owns=("companies", "subscriptions", "audit_logs"),
    consumes=("users",),
    current_sources=(
        "backend/platform_owner.py",
        "backend/licensing_api.py",
        "backend/security/audit_security.py",
    ),
)

CORE = _contract(
    owns=("users", "role_definitions", "access_requests"),
    consumes=("companies", "subscriptions", "audit_logs"),
    current_sources=(
        "backend/dependencies.py",
        "backend/security/session_manager.py",
        "backend/permission_governance.py",
        "backend/roles_admin.py",
        "backend/commercial_module_guard.py",
    ),
)

TASKOSPHERE = _contract(
    owns=("tasks", "attendance", "holidays", "dsc_register"),
    consumes=("users", "clients", "audit_logs", "documents"),
    current_sources=(
        "backend/server_modules/task_routes.py",
        "backend/server_modules/attendance_routes.py",
        "backend/server_modules/dsc_routes.py",
        "backend/server_modules/document_routes.py",
        "backend/server_modules/task_analytics.py",
        "backend/server_modules/task_popup.py",
        "backend/server_modules/task_duplicate_detection.py",
    ),
)

FINIX_AI = _contract(
    owns=(
        "chart_of_accounts",
        "journal_entries",
        "journal_lines",
        "bank_accounts",
        "bank_transactions",
        "payments",
        "purchase_invoices",
        "purchase_payments",
        "accounting_audit_trail",
        "bank_reconciliation",
        "bulk_import_jobs",
        "depreciation_runs",
        "fixed_assets",
        "opening_balances",
        "tds_tcs_entries",
        "finix_ai_proposals",
    ),
    consumes=("companies", "clients", "invoices", "party_ledgers"),
    current_sources=(
        "backend/accounting_core.py",
        "backend/accounting_extended.py",
        "backend/accounting_lock.py",
        "backend/accounting_ai/",
        "backend/bank_accounts.py",
        "backend/gst_reconciliation.py",
        "backend/gst_ai/",
        "backend/party_ledgers.py",
        "backend/invoicing.py",
        "backend/purchases.py",
    ),
)

AIWEAVE = _contract(
    owns=(
        "aiweave_conversations",
        "aiweave_executions",
        "aiweave_provider_accounts",
        "aiweave_provider_models",
        "aiweave_routing_rules",
    ),
    consumes=("users",),
    current_sources=(
        "backend/ai/aiweave_router.py",
        "backend/ai/omni/",
    ),
)

COMPLIGENIE = _contract(
    owns=(
        "compliance_masters",
        "compliance_assignments",
        "compliance_comments",
        "due_dates",
        "standalone_govt_fees",
    ),
    consumes=("clients", "users", "companies", "invoices"),
    current_sources=(
        "backend/compliance.py",
        "backend/server_modules/compliance_due_dates.py",
    ),
)

LEADSENSE = _contract(
    owns=("leads",),
    consumes=("clients", "quotations", "tasks", "users"),
    current_sources=(
        "backend/leads.py",
        "backend/lead_ai.py",
        "backend/client_activity.py",
    ),
)

PEOPLE_MATRIX = _contract(
    owns=(),
    consumes=("users", "companies"),
    current_sources=(
        "backend/permission_governance.py",
        "backend/roles_admin.py",
        "backend/governance_core.py",
        "backend/governed_modules.py",
        "backend/commercial_admin_permission_compat.py",
    ),
)

RECORDS = _contract(
    owns=("documents",),
    consumes=("users", "clients"),
    current_sources=("backend/server_modules/document_routes.py",),
)

TRADEMARK = _contract(
    owns=(
        "trademark_sphere",
        "trademark_qc_reports",
        "trademark_qc_branding",
        "trademark_sphere_reminders",
    ),
    consumes=("users",),
    current_sources=(
        "backend/trademark_sphere.py",
        "backend/trademark_portals_router.py",
        "backend/quickcompany_trademark_router.py",
        "backend/trademark_bulk.py",
    ),
)


DOMAIN_CONTRACTS: Mapping[str, Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        "platform": PLATFORM,
        "core": CORE,
        "taskosphere": TASKOSPHERE,
        "finix_ai": FINIX_AI,
        "aiweave": AIWEAVE,
        "compligenie": COMPLIGENIE,
        "leadsense": LEADSENSE,
        "people_matrix": PEOPLE_MATRIX,
        "records": RECORDS,
        "trademark": TRADEMARK,
    }
)


def owned_collections(domain: str) -> tuple[str, ...]:
    """Return the declared collection ownership for a domain."""
    return DOMAIN_CONTRACTS[domain]["owns"]


def consumed_collections(domain: str) -> tuple[str, ...]:
    """Return collections a domain may consume during migration."""
    return DOMAIN_CONTRACTS[domain]["consumes"]
