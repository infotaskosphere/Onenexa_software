"""Production launcher for the Python/FastAPI commercial backend.

This launcher keeps backend/server.py focused on the main application while
ensuring the commercial licensing API is registered before Uvicorn starts.
The registration is idempotent so the launcher remains safe if the licensing
router is also registered by the main application module.
"""

import asyncio
import os

import uvicorn

# Compatibility bootstrap MUST run before backend.server imports any routers.
# It normalizes legacy admin role casing and stale admin permission documents
# without granting any additional access to manager/staff users.
import backend.admin_identity_compat  # noqa: F401,E402

import backend.server as server_module
from backend.licensing_api import create_licensing_indexes, router as licensing_router
from backend import platform_owner_session_compat as _owner_session_compat

app = server_module.app

# The Platform Owner has its own operational company/workspace. The owner is
# exempt from customer subscription gates, but opaque SaaS sessions must still
# carry that workspace company_id so /auth/me and normal application APIs can
# authenticate consistently. This wrapper only changes owner sessions; normal
# licensee company/subscription validation remains unchanged.
_owner_session_compat.install()
_owner_session_compat.install_server_session_patch(server_module)

# Licensing is a normal FastAPI router; there is no second Node server.
# Avoid duplicate registration if server.py also registers it.
# Newer FastAPI versions may expose included-router wrapper objects in app.routes.
# Use getattr so startup does not crash when a route wrapper has no .path attribute.
if not any(getattr(route, "path", None) == "/api/licensing/state" for route in app.routes):
    app.include_router(licensing_router, prefix="/api")


async def _prepare_licensing() -> None:
    try:
        await create_licensing_indexes()
    except Exception as exc:
        # Keep backend startup resilient if Mongo is temporarily unavailable.
        # The normal server startup/database retry path remains authoritative.
        import logging
        logging.getLogger(__name__).warning(
            "Commercial licensing index bootstrap skipped: %s", exc
        )


if __name__ == "__main__":
    asyncio.run(_prepare_licensing())
    uvicorn.run(
        app,
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "10000")),
    )
