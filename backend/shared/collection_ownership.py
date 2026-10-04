"""Canonical shared-collection ownership registry.

This module is declarative only. It does not access MongoDB and therefore
cannot change request behavior. Domain modules use these names to describe
which subsystem owns a collection and which subsystems may consume it.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping


SHARED_COLLECTION_OWNERS: Mapping[str, str] = MappingProxyType(
    {
        # Identity / tenant control plane
        "users": "core",
        "companies": "platform",
        "subscriptions": "platform",
        "role_definitions": "core",
        "access_requests": "core",

        # Cross-domain business records
        "clients": "records",
        "quotations": "leadsense",
        "invoices": "finix_ai",

        # Shared operational infrastructure
        "audit_logs": "platform",
    }
)


def owner_of(collection: str) -> str:
    """Return the single declared owner of a shared collection."""
    try:
        return SHARED_COLLECTION_OWNERS[collection]
    except KeyError as exc:
        raise KeyError(f"No collection owner declared for: {collection}") from exc
