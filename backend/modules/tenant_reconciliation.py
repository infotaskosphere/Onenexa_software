"""Tenant-isolation reconciliation for the architecture migration.

The audit compares declared domain collections with the canonical tenant
collection registry. It is intentionally read-only.
"""
from __future__ import annotations

from backend.modules.contracts import DOMAIN_CONTRACTS
from backend.tenant_runtime import TENANT_COLLECTIONS


def missing_tenant_coverage() -> dict[str, list[str]]:
    result = {}
    for domain, contract in DOMAIN_CONTRACTS.items():
        missing = [
            collection for collection in contract["owns"]
            if domain != "platform"
            and collection not in TENANT_COLLECTIONS
            and collection not in {"role_definitions", "access_requests"}
        ]
        if missing:
            result[domain] = missing
    return result


def tenant_coverage_report() -> dict[str, object]:
    return {
        "missing_owned_collection_coverage": missing_tenant_coverage(),
        "tenant_collection_count": len(TENANT_COLLECTIONS),
    }
