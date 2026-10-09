"""Local-first record storage for the first OneNexa offline pilot.

This store is intentionally separate from the existing MongoDB-backed ERP
collections. Only the allowlisted pilot entity types can be written here.
Each local record mutation and its outbound sync-outbox entry are committed in
one SQLite transaction so a crash cannot save one without the other.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from backend import local_first_store as store

_ALLOWED_ENTITY_TYPES = {"client", "task"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_scope(company_id: str, entity_type: str) -> tuple[str, str]:
    normalized_company = str(company_id or "").strip()
    normalized_type = str(entity_type or "").strip().lower()
    if not normalized_company:
        raise ValueError("company_id is required")
    if normalized_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError("entity_type must be one of: client, task")
    return normalized_company, normalized_type


def _ensure_records_table(connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS local_records (
            company_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            record_json TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            deleted_at_utc TEXT,
            PRIMARY KEY (company_id, entity_type, entity_id)
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_local_records_listing "
        "ON local_records (company_id, entity_type, deleted_at_utc, updated_at_utc)"
    )


def save_local_record(
    *,
    company_id: str,
    entity_type: str,
    record: dict[str, Any],
    entity_id: str | None = None,
) -> dict[str, Any]:
    """Create/update a local pilot record and enqueue its sync operation atomically."""
    normalized_company, normalized_type = _validate_scope(company_id, entity_type)
    if not isinstance(record, dict):
        raise ValueError("record must be a JSON object")
    normalized_id = str(entity_id or record.get("id") or uuid.uuid4()).strip()
    if not normalized_id:
        raise ValueError("record id cannot be empty")
    try:
        # Serialize before opening the transaction so invalid payloads cannot
        # leave partial writes behind.
        record_data = dict(record)
        record_data["id"] = normalized_id
        record_data["company_id"] = normalized_company
        record_json = json.dumps(record_data, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("record must contain JSON-serializable values") from exc

    store.initialize_local_store()
    timestamp = _now()
    operation_id = str(uuid.uuid4())
    with store._connection() as connection:
        _ensure_records_table(connection)
        existing = connection.execute(
            "SELECT created_at_utc, deleted_at_utc FROM local_records "
            "WHERE company_id = ? AND entity_type = ? AND entity_id = ?",
            (normalized_company, normalized_type, normalized_id),
        ).fetchone()
        operation = "update" if existing and not existing["deleted_at_utc"] else "create"
        created_at = existing["created_at_utc"] if existing else timestamp
        connection.execute(
            """
            INSERT INTO local_records (
                company_id, entity_type, entity_id, record_json,
                created_at_utc, updated_at_utc, deleted_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(company_id, entity_type, entity_id) DO UPDATE SET
                record_json=excluded.record_json,
                updated_at_utc=excluded.updated_at_utc,
                deleted_at_utc=NULL
            """,
            (normalized_company, normalized_type, normalized_id, record_json, created_at, timestamp),
        )
        connection.execute(
            """
            INSERT INTO sync_outbox (
                operation_id, company_id, entity_type, entity_id, operation,
                payload_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (operation_id, normalized_company, normalized_type, normalized_id, operation, record_json, timestamp),
        )
    return {
        "id": normalized_id,
        "company_id": normalized_company,
        "entity_type": normalized_type,
        "record": record_data,
        "operation": operation,
        "updated_at_utc": timestamp,
        "sync_status": "pending",
    }


def list_local_records(
    *,
    company_id: str,
    entity_type: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List only non-deleted records belonging to the authenticated company."""
    normalized_company, normalized_type = _validate_scope(company_id, entity_type)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    store.initialize_local_store()
    with store._connection() as connection:
        _ensure_records_table(connection)
        rows = connection.execute(
            """
            SELECT record_json, created_at_utc, updated_at_utc
            FROM local_records
            WHERE company_id = ? AND entity_type = ? AND deleted_at_utc IS NULL
            ORDER BY updated_at_utc DESC, entity_id ASC
            LIMIT ?
            """,
            (normalized_company, normalized_type, limit),
        ).fetchall()
    return [
        {
            "record": json.loads(row["record_json"]),
            "created_at_utc": row["created_at_utc"],
            "updated_at_utc": row["updated_at_utc"],
        }
        for row in rows
    ]


def delete_local_record(*, company_id: str, entity_type: str, entity_id: str) -> bool:
    """Soft-delete a local record and queue a deletion tombstone atomically."""
    normalized_company, normalized_type = _validate_scope(company_id, entity_type)
    normalized_id = str(entity_id or "").strip()
    if not normalized_id:
        raise ValueError("entity_id is required")
    store.initialize_local_store()
    timestamp = _now()
    operation_id = str(uuid.uuid4())
    with store._connection() as connection:
        _ensure_records_table(connection)
        existing = connection.execute(
            """
            SELECT 1 FROM local_records
            WHERE company_id = ? AND entity_type = ? AND entity_id = ?
              AND deleted_at_utc IS NULL
            """,
            (normalized_company, normalized_type, normalized_id),
        ).fetchone()
        if not existing:
            return False
        connection.execute(
            """
            UPDATE local_records SET deleted_at_utc = ?, updated_at_utc = ?
            WHERE company_id = ? AND entity_type = ? AND entity_id = ?
              AND deleted_at_utc IS NULL
            """,
            (timestamp, timestamp, normalized_company, normalized_type, normalized_id),
        )
        connection.execute(
            """
            INSERT INTO sync_outbox (
                operation_id, company_id, entity_type, entity_id, operation,
                payload_json, created_at_utc
            ) VALUES (?, ?, ?, ?, 'delete', '{}', ?)
            """,
            (operation_id, normalized_company, normalized_type, normalized_id, timestamp),
        )
    return True
