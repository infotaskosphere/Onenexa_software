"""Background synchronization worker for OneNexa desktop nodes.

Periodically inspects the local sync_outbox and automatically pushes pending
changes to the configured Admin Hub or Cloud server, while pulling remote updates.
Runs non-blockingly inside the FastAPI event loop.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from backend import local_first_store as store
from backend import local_first_sync as sync

logger = logging.getLogger("local_first_worker")

_worker_task: asyncio.Task | None = None
_sync_in_progress = False


async def _sync_loop(interval_seconds: int = 30) -> None:
    """Continuous background loop running while the desktop app is active."""
    global _sync_in_progress
    logger.info("OneNexa local-first desktop sync worker started (interval: %ds)", interval_seconds)

    while True:
        try:
            await asyncio.sleep(interval_seconds)

            sync_target = (
                os.getenv("ONENEXA_SYNC_TARGET", "").strip()
                or os.getenv("ONENEXA_CLOUD_TARGET", "").strip()
            )

            # Only sync if a target Admin PC or Cloud server is configured
            if not sync_target:
                continue

            if _sync_in_progress:
                continue

            _sync_in_progress = True
            try:
                # Find pending changes or pull updates
                company_id = os.getenv("ONENEXA_DEFAULT_COMPANY_ID", "").strip()
                if not company_id:
                    # Look up company_id from any pending outbox items
                    pending = store.get_pending_changes(limit=1)
                    if pending:
                        company_id = pending[0].get("company_id", "")

                if company_id:
                    result = await sync.run_client_sync_cycle(
                        sync_target_url=sync_target,
                        company_id=company_id,
                        token=os.getenv("ONENEXA_SYNC_TOKEN", "desktop-worker-token"),
                    )
                    if result.get("pushed", 0) > 0 or result.get("pulled", 0) > 0:
                        logger.info(
                            "Background sync complete: %d pushed, %d pulled with %s",
                            result.get("pushed", 0),
                            result.get("pulled", 0),
                            sync_target,
                        )
            finally:
                _sync_in_progress = False

        except asyncio.CancelledError:
            logger.info("OneNexa sync worker cancelled")
            break
        except Exception as exc:
            _sync_in_progress = False
            logger.debug("Background sync pass error (will retry): %s", exc)


def start_sync_worker(interval_seconds: int = 30) -> None:
    """Start the sync worker as a detached background task if local-first is active."""
    global _worker_task
    if os.getenv("ONENEXA_LOCAL_FIRST_ENABLED") != "1":
        return

    if _worker_task is None or _worker_task.done():
        try:
            loop = asyncio.get_running_loop()
            _worker_task = loop.create_task(_sync_loop(interval_seconds))
        except RuntimeError:
            pass


def stop_sync_worker() -> None:
    """Cancel the background sync worker task."""
    global _worker_task
    if _worker_task and not _worker_task.done():
        _worker_task.cancel()
        _worker_task = None
