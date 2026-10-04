"""Phase 1 commercial security foundation.

This compatibility boundary introduces a non-billable CORE entitlement layer
without rewriting the existing module catalog. Core owns identity and tenant
administration that every commercial customer needs regardless of purchased
modules.

The implementation is intentionally additive: existing route modules continue
to import the existing commercial guard, while this module narrows the guard's
commercial interpretation for core-owned routes.
"""
from __future__ import annotations

import os
from typing import Optional, Tuple

from backend import commercial_module_guard as _guard
from backend import dependencies as _dependencies


# ---------------------------------------------------------------------------
# Commercial product boundary
# ---------------------------------------------------------------------------

CORE_MODULE = "core"

# Core is not a purchasable module. It is required infrastructure for every
# commercial tenant and therefore must never be checked against a license's
# purchased-module list.
CORE_ROUTE_PREFIXES: Tuple[str, ...] = (
    "/users",
)

CORE_FEATURES = {
    "can_view_user_page": ("/users",),
}


def _normalize_path(path: str) -> str:
    normalized = (path or "").split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    return normalized


def _core_module_for_path(path: str) -> Optional[str]:
    normalized = _normalize_path(path)
    if any(
        normalized == prefix or normalized.startswith(prefix + "/")
        for prefix in CORE_ROUTE_PREFIXES
    ):
        return CORE_MODULE
    return None


def module_for_path(path: str, method: str = "GET") -> Optional[str]:
    core = _core_module_for_path(path)
    if core:
        return core
    return _ORIGINAL_MODULE_FOR_PATH(path, method)


def feature_for_path(
    path: str,
    method: str = "GET",
) -> Optional[Tuple[str, str]]:
    normalized = _normalize_path(path)
    if any(
        normalized == prefix or normalized.startswith(prefix + "/")
        for prefix in CORE_FEATURES["can_view_user_page"]
    ):
        return CORE_MODULE, "can_view_user_page"
    return _ORIGINAL_FEATURE_FOR_PATH(path, method)


def _core_licensed_module(module: str, license_doc: dict) -> bool:
    if module == CORE_MODULE:
        return True
    return _ORIGINAL_LICENSED_MODULE(module, license_doc)


_ORIGINAL_MODULE_FOR_PATH = _guard.module_for_path
_ORIGINAL_FEATURE_FOR_PATH = _guard.feature_for_path
_ORIGINAL_LICENSED_MODULE = _guard._licensed_module

_guard.module_for_path = module_for_path
_guard.feature_for_path = feature_for_path
_guard._licensed_module = _core_licensed_module


# ---------------------------------------------------------------------------
# Production database fail-closed foundation
# ---------------------------------------------------------------------------

def _assert_production_database_configuration() -> None:
    """Never allow the commercial application to boot on MockMongoClient.

    The existing dependency layer intentionally retains its development mock
    for local development. Production is different: silently booting against
    an in-memory database can make a deployment appear healthy while accepting
    writes that disappear on restart.
    """
    if str(os.getenv("ENV_MODE") or "").strip().lower() != "production":
        return

    mongo_url = getattr(_dependencies, "MONGO_URL", None)
    client = getattr(_dependencies, "client", None)

    if not mongo_url or client is None or client.__class__.__name__ == "MockMongoClient":
        raise RuntimeError(
            "COMMERCIAL SECURITY: production startup refused because a real "
            "MongoDB connection is not configured. Set MONGO_URL or "
            "MONGODB_URI and do not use the in-memory MongoDB fallback."
        )


_assert_production_database_configuration()


async def verify_production_runtime() -> None:
    """Actively verify the production MongoDB connection before startup completes."""
    if str(os.getenv("ENV_MODE") or "").strip().lower() != "production":
        return

    client = getattr(_dependencies, "client", None)
    if client is None or client.__class__.__name__ == "MockMongoClient":
        raise RuntimeError(
            "COMMERCIAL SECURITY: production runtime is using MockMongoClient."
        )

    ping = getattr(getattr(client, "admin", None), "command", None)
    if ping is None:
        raise RuntimeError(
            "COMMERCIAL SECURITY: MongoDB client does not expose an admin ping."
        )

    try:
        await ping("ping")
    except Exception as exc:
        raise RuntimeError(
            "COMMERCIAL SECURITY: MongoDB production health check failed; "
            "startup is refused."
        ) from exc


def install() -> None:
    """Explicit boot marker used by deployment logs and architecture tests."""
    return None


install()
