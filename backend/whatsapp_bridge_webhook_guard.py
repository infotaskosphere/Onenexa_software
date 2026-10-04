"""Internal WhatsApp bridge webhook authentication guard."""
from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request


async def verify(request: Request) -> None:
    expected = str(os.getenv("WA_BRIDGE_SECRET") or "").strip()
    supplied = str(request.headers.get("X-WA-Bridge-Secret") or "").strip()
    production = str(os.getenv("ENV_MODE") or "").strip().lower() == "production"

    if production and not expected:
        raise HTTPException(
            status_code=503,
            detail="WhatsApp bridge security is not configured.",
        )

    if not expected or not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=401,
            detail="Invalid WhatsApp bridge authentication.",
        )


def install(app) -> None:
    @app.middleware("http")
    async def bridge_webhook_guard(request: Request, call_next):
        path = str(request.url.path or "")
        if path.startswith("/api/whatsapp/hub/webhook/"):
            await verify(request)
        return await call_next(request)
