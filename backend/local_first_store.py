"""Durable local-first sync primitives for the OneNexa desktop runtime.

This module deliberately does not connect to the cloud or mutate ERP collections.
It provides a transaction-safe local outbox so API handlers can later record
business changes locally before a separate, authenticated sync worker transmits
them. The ERP is not offline-capable until its write paths use this outbox.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


_SCHEMA_VERSION = 1
_MAX_BATCH_SIZE = 500
_ALLOWED_OPERATIONS = {"create", "update", "delete"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_local_data_dir() -> Path:
    """Return the per-user OneNexa data directory; allow an explicit override."""
    override = os.getenv("ONENEXA_DATA_DIR", "").strip()
    if override:
        directory = Path(override).expanduser()
    elif os.getenv("LOCALAPPDATA"):
        directory = Path(os.environ["LOCALAPPDATA"]) / "OneNexa" / "data"
    elif os.getenv("XDG_DATA_HOME"):
        directory = Path(os.environ["XDG_DATA_HOME"]).expanduser() / "onenexa"
    else:
        directory = Path.home() / ".local" / "share" / "onenexa"

    directory.mkdir(parents=True, exist_ok=True)
    try:
        if os.name != "nt":
            directory.chmod(0o700)
    except OSError:
        # Directory creation must remain portable; deployment checks should
        # separately verify filesystem permissions on supported platforms.
        pass
    return directory


def get_database_path() -> Path:
    return get_local_data_dir() / "onenexa-local.db"


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(str(get_database_path()), timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


@contextmanager
def _connection():
    """Ensure SQLite connections are closed after every operation."""
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_local_store() -> Path:
    """Create the local metadata and durable outbound-change tables idempotently."""
    database_path = get_database_path()
    with _connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS local_store_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_id TEXT NOT NULL UNIQUE,
                company_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
                payload_json TEXT NOT NULL,
                created_at_utc TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                synced_at_utc TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
                ON sync_outbox (synced_at_utc, id);
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_company
                ON sync_outbox (company_id, synced_at_utc, id);

            CREATE TABLE IF NOT EXISTS sync_cursors (
                scope TEXT PRIMARY KEY,
                cursor_value TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            );

            PRAGMA user_version = 1;
            """
        )
        row = connection.execute(
            "SELECT value FROM local_store_metadata WHERE key = 'device_id'"
        ).fetchone()
        if not row:
            connection.execute(
                "INSERT INTO local_store_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)",
                ("device_id", str(uuid.uuid4()), _utc_now()),
            )
        connection.execute(
            "INSERT INTO local_store_metadata (key, value, updated_at_utc) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_utc=excluded.updated_at_utc",
            ("schema_version", str(_SCHEMA_VERSION), _utc_now()),
        )
    try:
        if os.name != "nt":
            database_path.chmod(0o600)
    except OSError:
        pass
    return database_path


def get_device_id() -> str:
    initialize_local_store()
    with _connection() as connection:
        row = connection.execute(
            "SELECT value FROM local_store_metadata WHERE key = 'device_id'"
        ).fetchone()
        if not row:
            raise RuntimeError("OneNexa local device identity could not be initialized")
        return str(row["value"])


def enqueue_change(
    *,
    company_id: str,
    entity_type: str,
    entity_id: str,
    operation: str,
    payload: dict[str, Any] | None = None,
    operation_id: str | None = None,
) -> str:
    """Persist one tenant-scoped change for later idempotent synchronization."""
    normalized_company = str(company_id or "").strip()
    normalized_type = str(entity_type or "").strip()
    normalized_entity = str(entity_id or "").strip()
    normalized_operation = str(operation or "").strip().lower()

    if not normalized_company:
        raise ValueError("company_id is required for every queued change")
    if not normalized_type or not normalized_entity:
        raise ValueError("entity_type and entity_id are required")
    if normalized_operation not in _ALLOWED_OPERATIONS:
        raise ValueError("operation must be create, update, or delete")
    if payload is not None and not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object or None")

    try:
        payload_json = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("payload must contain JSON-serializable values") from exc

    stable_operation_id = str(operation_id or uuid.uuid4()).strip()
    if not stable_operation_id:
        raise ValueError("operation_id cannot be empty")

    initialize_local_store()
    with _connection() as connection:
        connection.execute(
            """
            INSERT INTO sync_outbox (
                operation_id, company_id, entity_type, entity_id, operation,
                payload_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING
            """,
            (
                stable_operation_id,
                normalized_company,
                normalized_type,
                normalized_entity,
                normalized_operation,
                payload_json,
                _utc_now(),
            ),
        )
    return stable_operation_id


def get_pending_changes(limit: int = 100, company_id: str | None = None) -> list[dict[str, Any]]:
    """Read pending changes in insertion order without marking them as delivered."""
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _MAX_BATCH_SIZE:
        raise ValueError(f"limit must be between 1 and {_MAX_BATCH_SIZE}")

    initialize_local_store()
    query = (
        "SELECT id, operation_id, company_id, entity_type, entity_id, operation, "
        "payload_json, created_at_utc, attempts, last_error "
        "FROM sync_outbox WHERE synced_at_utc IS NULL"
    )
    parameters: list[Any] = []
    if company_id is not None:
        normalized_company = str(company_id).strip()
        if not normalized_company:
            raise ValueError("company_id cannot be empty when provided")
        query += " AND company_id = ?"
        parameters.append(normalized_company)
    query += " ORDER BY id ASC LIMIT ?"
    parameters.append(limit)

    with _connection() as connection:
        rows = connection.execute(query, parameters).fetchall()

    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["payload"] = json.loads(item.pop("payload_json"))
        result.append(item)
    return result


def mark_changes_synced(change_ids: Iterable[int]) -> int:
    """Mark acknowledged local outbox rows as delivered after remote confirmation."""
    ids = list(dict.fromkeys(change_ids))
    if not ids:
        return 0
    if any(isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in ids):
        raise ValueError("change_ids must contain positive integer outbox IDs")

    initialize_local_store()
    placeholders = ",".join("?" for _ in ids)
    with _connection() as connection:
        cursor = connection.execute(
            f"UPDATE sync_outbox SET synced_at_utc = ?, last_error = NULL "
            f"WHERE id IN ({placeholders}) AND synced_at_utc IS NULL",
            [_utc_now(), *ids],
        )
        return int(cursor.rowcount)


def record_sync_error(change_ids: Iterable[int], error: str) -> int:
    """Record a retryable delivery failure while preserving the queued payload."""
    ids = list(dict.fromkeys(change_ids))
    if not ids:
        return 0
    if any(isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in ids):
        raise ValueError("change_ids must contain positive integer outbox IDs")
    safe_error = str(error or "Unknown synchronization error").strip()[:1000]
    placeholders = ",".join("?" for _ in ids)
    initialize_local_store()
    with _connection() as connection:
        cursor = connection.execute(
            f"UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? "
            f"WHERE id IN ({placeholders}) AND synced_at_utc IS NULL",
            [safe_error, *ids],
        )
        return int(cursor.rowcount)


def save_sync_cursor(scope: str, cursor_value: str) -> None:
    normalized_scope = str(scope or "").strip()
    if not normalized_scope:
        raise ValueError("scope is required")
    initialize_local_store()
    with _connection() as connection:
        connection.execute(
            """
            INSERT INTO sync_cursors (scope, cursor_value, updated_at_utc)
            VALUES (?, ?, ?)
            ON CONFLICT(scope) DO UPDATE SET
                cursor_value=excluded.cursor_value,
                updated_at_utc=excluded.updated_at_utc
            """,
            (normalized_scope, str(cursor_value or ""), _utc_now()),
        )


def get_sync_cursor(scope: str) -> str | None:
    normalized_scope = str(scope or "").strip()
    if not normalized_scope:
        raise ValueError("scope is required")
    initialize_local_store()
    with _connection() as connection:
        row = connection.execute(
            "SELECT cursor_value FROM sync_cursors WHERE scope = ?",
            (normalized_scope,),
        ).fetchone()
    return str(row["cursor_value"]) if row else None


def get_sync_status(company_id: str | None = None) -> dict[str, Any]:
    """Return queue counts for the desktop sync-status indicator."""
    initialize_local_store()
    query = "SELECT COUNT(*) AS pending, MIN(created_at_utc) AS oldest_pending, "
    query += "SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS retrying "
    query += "FROM sync_outbox WHERE synced_at_utc IS NULL"
    parameters: list[Any] = []
    if company_id is not None:
        normalized_company = str(company_id).strip()
        if not normalized_company:
            raise ValueError("company_id cannot be empty when provided")
        query += " AND company_id = ?"
        parameters.append(normalized_company)
    with _connection() as connection:
        row = connection.execute(query, parameters).fetchone()
    sync_target = os.getenv("ONENEXA_SYNC_TARGET", "").strip() or os.getenv("ONENEXA_CLOUD_TARGET", "").strip()
    return {
        "device_id": get_device_id(),
        "pending": int(row["pending"] or 0),
        "retrying": int(row["retrying"] or 0),
        "oldest_pending_at_utc": row["oldest_pending"],
        "local_store_path": str(get_database_path()),
        "sync_enabled": bool(sync_target or os.getenv("ONENEXA_LOCAL_FIRST_ENABLED") == "1"),
        "sync_target": sync_target or "local_hub",
        "note": "Sync transport is active." if (sync_target or os.getenv("ONENEXA_LOCAL_FIRST_ENABLED") == "1") else "Standalone local node.",
    }
