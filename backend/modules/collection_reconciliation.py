"""Final collection ownership reconciliation checks."""
from __future__ import annotations

from backend.modules.contracts import DOMAIN_CONTRACTS
from backend.shared.collection_ownership import SHARED_COLLECTION_OWNERS


def duplicate_domain_owners() -> dict[str, list[str]]:
    owners = {}
    for domain, contract in DOMAIN_CONTRACTS.items():
        for collection in contract["owns"]:
            owners.setdefault(collection, []).append(domain)
    return {name: domains for name, domains in owners.items() if len(domains) > 1}


def shared_owner_mismatches() -> dict[str, tuple[str, str]]:
    mismatches = {}
    for collection, owner in SHARED_COLLECTION_OWNERS.items():
        declared = [domain for domain, contract in DOMAIN_CONTRACTS.items() if collection in contract["owns"]]
        if declared and owner not in declared:
            mismatches[collection] = (owner, declared[0])
    return mismatches


def unregistered_shared_owners() -> dict[str, str]:
    """Return shared collections whose declared owner has no domain contract."""
    return {
        collection: owner
        for collection, owner in SHARED_COLLECTION_OWNERS.items()
        if owner not in DOMAIN_CONTRACTS
    }


def unresolved_collection_ownership() -> dict[str, object]:
    return {
        "duplicate_domain_owners": duplicate_domain_owners(),
        "shared_owner_mismatches": shared_owner_mismatches(),
        "unregistered_shared_owners": unregistered_shared_owners(),
    }
