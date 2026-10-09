"""Hub-and-spoke multi-PC synchronization engine for OneNexa desktop.

Enables offline workstations to persist data locally in SQLite, and
automatically synchronize/merge with the Admin PC and Platform Owner
when network connectivity is established.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx

from backend import local_first_records as records
from backend import local_first_store as store

logger = logging.getLogger("local_first_sync")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_sync_changelog_table(connection) -> None:
    """Server-side table tracking all changes across devices for incremental pull."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_changelog (
            changelog_id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            operation_id TEXT NOT NULL UNIQUE,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            server_received_at_utc TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_changelog_company_cursor "
        "ON sync_changelog (company_id, changelog_id)"
    )


def apply_inbound_change(
    connection,
    *,
    company_id: str,
    device_id: str,
    change: dict[str, Any],
) -> bool:
    """Apply a change from a remote node into the local store with Last-Write-Wins (LWW)."""
    operation_id = str(change.get("operation_id") or "").strip()
    entity_type = str(change.get("entity_type") or "").strip().lower()
    entity_id = str(change.get("entity_id") or "").strip()
    operation = str(change.get("operation") or "").strip().lower()
    payload = change.get("payload") or {}
    created_at = str(change.get("created_at_utc") or _now()).strip()

    if not operation_id or not entity_type or not entity_id:
        return False

    records._ensure_records_table(connection)

    # Check if local record is newer (conflict resolution: LWW)
    existing = connection.execute(
        "SELECT updated_at_utc FROM local_records "
        "WHERE company_id = ? AND entity_type = ? AND entity_id = ?",
        (company_id, entity_type, entity_id),
    ).fetchone()

    if existing and existing["updated_at_utc"] and existing["updated_at_utc"] > created_at:
        logger.info(
            "Conflict resolution: skipping older change for %s/%s (local %s > remote %s)",
            entity_type, entity_id, existing["updated_at_utc"], created_at
        )
        return True

    server_now = _now()
    if operation in ("create", "update"):
        payload_data = dict(payload)
        payload_data["id"] = entity_id
        payload_data["company_id"] = company_id
        record_json = json.dumps(payload_data, ensure_ascii=False, separators=(",", ":"))
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
            (company_id, entity_type, entity_id, record_json, created_at, server_now),
        )
    elif operation == "delete":
        connection.execute(
            """
            UPDATE local_records SET deleted_at_utc = ?, updated_at_utc = ?
            WHERE company_id = ? AND entity_type = ? AND entity_id = ?
            """,
            (server_now, server_now, company_id, entity_type, entity_id),
        )

    # Log into changelog if running in Hub / Master mode
    _ensure_sync_changelog_table(connection)
    connection.execute(
        """
        INSERT INTO sync_changelog (
            company_id, device_id, operation_id, entity_type, entity_id,
            operation, payload_json, created_at_utc, server_received_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO NOTHING
        """,
        (
            company_id,
            device_id,
            operation_id,
            entity_type,
            entity_id,
            operation,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            created_at,
            server_now,
        ),
    )
    return True


def process_inbound_push(
    *,
    company_id: str,
    device_id: str,
    changes: list[dict[str, Any]],
) -> list[int]:
    """Server-side endpoint: process a batch of changes pushed from a workstation."""
    if not company_id or not device_id:
        raise ValueError("company_id and device_id are required")

    acknowledged_ids: list[int] = []
    store.initialize_local_store()

    with store._connection() as connection:
        for item in changes:
            client_change_id = item.get("id")
            if apply_inbound_change(
                connection,
                company_id=company_id,
                device_id=device_id,
                change=item,
            ):
                if client_change_id is not None:
                    acknowledged_ids.append(client_change_id)

    return acknowledged_ids


def process_inbound_pull(
    *,
    company_id: str,
    since_cursor: int | None = None,
    limit: int = 100,
    exclude_device_id: str | None = None,
) -> dict[str, Any]:
    """Server-side endpoint: return changes since a given changelog cursor for a company."""
    if not company_id:
        raise ValueError("company_id is required")

    cursor_num = int(since_cursor or 0)
    store.initialize_local_store()

    with store._connection() as connection:
        _ensure_sync_changelog_table(connection)
        query = (
            "SELECT changelog_id, device_id, operation_id, entity_type, entity_id, "
            "operation, payload_json, created_at_utc, server_received_at_utc "
            "FROM sync_changelog WHERE company_id = ? AND changelog_id > ?"
        )
        params: list[Any] = [company_id, cursor_num]
        if exclude_device_id:
            query += " AND device_id != ?"
            params.append(str(exclude_device_id))
        query += " ORDER BY changelog_id ASC LIMIT ?"
        params.append(min(max(limit, 1), 500))

        rows = connection.execute(query, params).fetchall()

    changes = []
    max_cursor = cursor_num
    for row in rows:
        c_id = row["changelog_id"]
        if c_id > max_cursor:
            max_cursor = c_id
        changes.append({
            "changelog_id": c_id,
            "device_id": row["device_id"],
            "operation_id": row["operation_id"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "operation": row["operation"],
            "payload": json.loads(row["payload_json"]),
            "created_at_utc": row["created_at_utc"],
            "server_received_at_utc": row["server_received_at_utc"],
        })

    return {
        "changes": changes,
        "count": len(changes),
        "cursor": max_cursor,
        "has_more": len(changes) >= limit,
    }


async def run_client_sync_cycle(
    sync_target_url: str,
    company_id: str,
    token: str,
) -> dict[str, Any]:
    """Workstation client-side: push pending changes and pull remote updates."""
    target_url = str(sync_target_url or "").strip().rstrip("/")
    if not target_url:
        return {"status": "skipped", "reason": "No sync target configured"}

    device_id = store.get_device_id()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    pushed_count = 0
    pulled_count = 0

    async with httpx.AsyncClient(timeout=15.0) as http_client:
        # Step 1: Push pending local changes
        pending = store.get_pending_changes(limit=100, company_id=company_id)
        if pending:
            payload = {
                "device_id": device_id,
                "company_id": company_id,
                "changes": pending,
            }
            try:
                push_res = await http_client.post(
                    f"{target_url}/api/desktop/local-first/sync/push",
                    json=payload,
                    headers=headers,
                )
                if push_res.status_code == 200:
                    ack_data = push_res.json()
                    ack_ids = ack_data.get("acknowledged_ids", [])
                    if ack_ids:
                        store.mark_changes_synced(ack_ids)
                        pushed_count = len(ack_ids)
                else:
                    store.record_sync_error(
                        [p["id"] for p in pending],
                        f"Server HTTP {push_res.status_code}: {push_res.text[:200]}"
                    )
            except Exception as exc:
                logger.warning("Sync push failed: %s", exc)
                store.record_sync_error([p["id"] for p in pending], str(exc))

        # Step 2: Pull remote updates
        import hashlib
        target_hash = hashlib.sha256(target_url.encode()).hexdigest()[:10]
        cursor_key = f"cursor_{target_hash}_{company_id}"
        current_cursor = store.get_sync_cursor(cursor_key) or store.get_sync_cursor(f"company_{company_id}") or "0"
        try:
            pull_res = await http_client.get(
                f"{target_url}/api/desktop/local-first/sync/pull",
                params={"since_cursor": current_cursor, "exclude_device_id": device_id},
                headers=headers,
            )
            if pull_res.status_code == 200:
                pull_data = pull_res.json()
                remote_changes = pull_data.get("changes", [])
                new_cursor = pull_data.get("cursor", current_cursor)

                if remote_changes:
                    store.initialize_local_store()
                    with store._connection() as connection:
                        for change in remote_changes:
                            apply_inbound_change(
                                connection,
                                company_id=company_id,
                                device_id=change.get("device_id", "remote"),
                                change=change,
                            )
                    pulled_count = len(remote_changes)

                store.save_sync_cursor(cursor_key, str(new_cursor))
        except Exception as exc:
            logger.warning("Sync pull failed: %s", exc)

    return {
        "status": "success",
        "device_id": device_id,
        "pushed": pushed_count,
        "pulled": pulled_count,
        "timestamp": _now(),
    }


import socket


def get_local_ip_addresses() -> list[str]:
    """Discover available local LAN IP addresses for office device pairing."""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        if primary and not primary.startswith("127."):
            ips.add(primary)
        s.close()
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ":" not in ip:
                ips.add(ip)
    except Exception:
        pass
    return sorted(list(ips)) or ["127.0.0.1"]


def get_hub_info(company_id: str) -> dict[str, Any]:
    """Provide local office discovery details for this PC."""
    device_id = store.get_device_id()
    hostname = socket.gethostname()
    ip_list = get_local_ip_addresses()
    primary_ip = ip_list[0] if ip_list else "127.0.0.1"
    port = int(os.getenv("PORT", "7432"))
    node_role = os.getenv("ONENEXA_NODE_ROLE", "admin").lower()

    clean_hex = device_id.replace("-", "")[:6].upper()
    pairing_code = f"NX-{clean_hex}"

    sync_target = (
        os.getenv("ONENEXA_SYNC_TARGET", "").strip()
        or os.getenv("ONENEXA_CLOUD_TARGET", "").strip()
    )

    return {
        "device_id": device_id,
        "hostname": hostname,
        "primary_ip": primary_ip,
        "all_ips": ip_list,
        "port": port,
        "pairing_code": pairing_code,
        "node_role": node_role,
        "hub_url": f"http://{primary_ip}:{port}",
        "cloud_target": sync_target or "None configured",
        "company_id": company_id,
    }


def list_connected_nodes(company_id: str) -> list[dict[str, Any]]:
    """List staff workstations that have synchronized with this Admin Hub."""
    store.initialize_local_store()
    nodes = []
    with store._connection() as connection:
        _ensure_sync_changelog_table(connection)
        rows = connection.execute(
            """
            SELECT device_id,
                   COUNT(*) as total_changes,
                   MAX(server_received_at_utc) as last_seen_at_utc
            FROM sync_changelog
            WHERE company_id = ?
            GROUP BY device_id
            ORDER BY last_seen_at_utc DESC
            """,
            (company_id,)
        ).fetchall()
        for r in rows:
            nodes.append({
                "device_id": r["device_id"],
                "total_changes": int(r["total_changes"] or 0),
                "last_seen_at_utc": r["last_seen_at_utc"],
            })
    return nodes


def get_database_snapshot_bytes() -> bytes:
    """Return raw binary content of the local SQLite database for USB / offline backup."""
    db_path = store.get_database_path()
    if not db_path.exists():
        raise FileNotFoundError("Local database does not exist yet")
    return db_path.read_bytes()

