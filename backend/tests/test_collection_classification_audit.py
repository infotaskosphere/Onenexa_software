"""Phase 3 collection classification audit.

This guard scans Python source for direct Mongo collection references and makes
new collection usage explicit. Existing legacy/global collections must be added
to the allowlist with a deliberate classification.
"""
from __future__ import annotations

import re
from pathlib import Path

from backend.shared.collection_ownership import SHARED_COLLECTION_OWNERS
from backend.tenant_runtime import TENANT_COLLECTIONS


GLOBAL_OR_SYSTEM_COLLECTIONS = {
    "audit_platform",
    "commercial_domains",
    "commercial_license_module_catalog",
    "commercial_license_packages",
    "commercial_plans",
    "commercial_website_config",
    "counters",
    "feature_flags",
    "fx_rate_cache",
    "gst_api_config",
    "gst_rules",
    "identix_cmd_queue",
    "integration_logs",
    "learning_queue",
    "learning_statistics",
    "learning_versions",
    "ocr_engine_statistics",
    "organizations",
    "plugins",
    "rate_limits",
    "roc_form_dump",
    "roc_form_dump_chunks",
    "roc_form_dump_jobs",
    "roc_form_dump_learning",
    "roc_form_dump_uploads",
    "system_logs",
    "system_metrics",
    "system_recovery_settings",
    "tenants",
    "email_delivery_logs",
    "email_system_settings",
    "gst_cache",
    "commercial_licenses",
    "commercial_licenses",
    "commercial_license_customers",
    "commercial_customers",
    "subscriptions",
    "companies",
    "audit_logs",
    "platform_owner_audit",
    "platform_settings",
    "system_settings",
    "security_events",
    "password_reset_tokens",
    "email_verification_tokens",
    "email_connections",
    "email_extracted_events",
    "email_auto_save_prefs",
    "email_scan_schedule",
    "email_sender_whitelist",
    "email_scan_settings",
    "sessions",
    "session_manager",
    "whatsapp_sse_tokens",
    "license_activations",
    "licenses",
    # Global identity control-plane collections, not tenant business data.
    "identity_email_links",
    "identity_migrations",
    "identity_sequences",
}

IGNORED_MEMBERS = {
    "find",
    "find_one",
    "count_documents",
    "distinct",
    "insert_one",
    "insert_many",
    "update_one",
    "update_many",
    "replace_one",
    "delete_one",
    "delete_many",
    "aggregate",
    "bulk_write",
    "command",
    "name",
    "list_collection_names",
}


def _referenced_collections(root: Path) -> set[str]:
    found: set[str] = set()
    pattern = re.compile(r"\b(?:db|raw_db)\.([A-Za-z_][A-Za-z0-9_]*)")
    for path in root.rglob("*.py"):
        if any(part in {".git", ".venv", "__pycache__"} for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        found.update(pattern.findall(text))
    return {name for name in found if name not in IGNORED_MEMBERS}


def test_every_direct_mongo_collection_is_classified():
    root = Path(__file__).resolve().parents[1]
    referenced = _referenced_collections(root)
    classified = set(TENANT_COLLECTIONS) | set(SHARED_COLLECTION_OWNERS) | GLOBAL_OR_SYSTEM_COLLECTIONS
    unresolved = sorted(referenced - classified)
    assert not unresolved, (
        "Unclassified Mongo collections detected: "
        + ", ".join(unresolved)
        + ". Add each collection to the appropriate ownership/scoping registry."
    )


def test_shared_collection_owners_are_declared_domains():
    from backend.modules.contracts import DOMAIN_CONTRACTS

    unresolved = {
        collection: owner
        for collection, owner in SHARED_COLLECTION_OWNERS.items()
        if owner not in DOMAIN_CONTRACTS
    }
    assert unresolved == {}
