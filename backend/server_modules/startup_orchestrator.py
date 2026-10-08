from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


async def run_startup_orchestration(*, server_module, db, configure_holiday_event_loop, configure_attendance_event_loop, initialize_startup_indexes, register_scheduler_jobs, start_bootstrap_tasks, scheduler, startup_dependencies):
    # Commercial Phase 1D: production must prove that a real MongoDB backend is
    # reachable before indexes, schedulers, or background jobs are started.
    try:
        from backend.commercial_core_isolation import verify_production_runtime
        await verify_production_runtime()
    except Exception:
        logger.exception("COMMERCIAL SECURITY: production runtime verification failed.")
        raise
    """Run the existing startup sequence in its original order.

    This is an orchestration-only layer. The underlying index, scheduler,
    and bootstrap subsystems remain responsible for their own behavior.
    """
    server_module.app_event_loop = asyncio.get_event_loop()
    configure_holiday_event_loop(server_module.app_event_loop)
    configure_attendance_event_loop(server_module.app_event_loop)

    try:
        await initialize_startup_indexes(
            db,
            **startup_dependencies["index_factories"],
        )
    except Exception as e:
        logger.warning(f"Index creation warning (non-fatal): {e}")

    try:
        from backend.identity_hierarchy import migrate_hierarchical_identities
        identity_result = await migrate_hierarchical_identities(db)
        logger.info(
            "Hierarchical identity bootstrap: %s",
            identity_result.get("status") if isinstance(identity_result, dict) else identity_result,
        )
    except Exception as identity_err:
        # Identity migration is additive and must never stop unrelated startup
        # services. Authentication will still fail safely for unresolved legacy
        # identities until the migration can complete.
        logger.exception("Hierarchical identity bootstrap warning: %s", identity_err)

    try:
        register_scheduler_jobs(
            scheduler,
            **startup_dependencies["scheduler_jobs"],
        )
        scheduler.start()
        logger.info("APScheduler started successfully.")
    except Exception as e:
        logger.error(f"APScheduler startup failed: {e}")

    await start_bootstrap_tasks(db=db, logger_instance=logger)
