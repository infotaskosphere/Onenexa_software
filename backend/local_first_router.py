"""Authenticated API for the initial OneNexa local-first pilot store.

These endpoints operate on the local SQLite pilot store only. They do not
replace the existing MongoDB-backed ERP APIs, and outbound cloud sync remains
disabled until a separately authenticated sync protocol is implemented.
"""

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.dependencies import get_current_user
from backend import local_first_store
from backend import local_first_records
from backend import local_first_sync
from backend.local_first_auth import get_local_first_principal, issue_local_session, LocalFirstPrincipal

router = APIRouter(prefix="/desktop/local-first", tags=["OneNexa Desktop Local-First"])


class LocalRecordRequest(BaseModel):
    id: str | None = Field(default=None, min_length=1, max_length=200)
    record: dict[str, Any]


class SyncPushRequest(BaseModel):
    device_id: str
    company_id: str
    changes: list[dict[str, Any]]


class SyncTriggerRequest(BaseModel):
    sync_target_url: str | None = None


def _ensure_local_first_enabled() -> None:
    """Keep pilot local-disk APIs disabled on hosted deployments by default."""
    if os.getenv("ONENEXA_LOCAL_FIRST_ENABLED", "").strip() != "1":
        raise HTTPException(status_code=404, detail="Local-first desktop API is not enabled on this server")


def _ensure_pilot_entity(entity_type: str) -> None:
    norm = str(entity_type or "").strip().lower()
    if norm not in local_first_records._ALLOWED_ENTITY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported local entity type. Allowed: {', '.join(sorted(local_first_records._ALLOWED_ENTITY_TYPES))}"
        )


def _require_local_permission(principal: LocalFirstPrincipal, action: str) -> None:
    role = str(principal.role or "").lower()
    permissions = principal.permissions or {}
    if action == "view":
        return
    if action == "edit" and (role in {"admin", "manager"} or permissions.get("can_edit_clients") is True or permissions.get("can_edit_tasks") is True):
        return
    if action == "delete" and (role == "admin" or permissions.get("can_delete_data") is True):
        return
    raise HTTPException(status_code=403, detail=f"Permission denied for local {action}")


@router.post("/session")
async def create_local_first_session(current_user=Depends(get_current_user)):
    """Exchange a valid online session for a short-lived device-local token."""
    _ensure_local_first_enabled()
    return issue_local_session(current_user)


def _authenticated_company_id(current_user: Any) -> str:
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")
    return company_id


@router.get("/status")
async def get_local_first_status(current_user=Depends(get_local_first_principal)):
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    status_data = local_first_store.get_sync_status(company_id)
    # Do not expose local filesystem paths to browser clients.
    status_data.pop("local_store_path", None)
    return status_data


@router.get("/records/{entity_type}")
async def get_local_first_records(
    entity_type: str,
    limit: int = Query(default=100, ge=1, le=500),
    current_user=Depends(get_local_first_principal),
):
    _ensure_local_first_enabled()
    _ensure_pilot_entity(entity_type)
    company_id = _authenticated_company_id(current_user)
    _require_local_permission(current_user, "view")
    try:
        can_view_all = current_user.role in {"admin", "manager"} or current_user.permissions.get("can_view_all_clients") is True
        items = local_first_records.list_local_records(
            company_id=company_id,
            entity_type=entity_type,
            limit=limit,
            created_by=None if can_view_all or entity_type != "client" else current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"items": items, "count": len(items), "source": "local_sqlite"}


@router.post("/records/{entity_type}")
async def save_local_first_record(
    entity_type: str,
    request: LocalRecordRequest,
    current_user=Depends(get_local_first_principal),
):
    _ensure_local_first_enabled()
    _ensure_pilot_entity(entity_type)
    company_id = _authenticated_company_id(current_user)
    _require_local_permission(current_user, "edit")
    try:
        record_data = dict(request.record)
        if entity_type == "client":
            if request.id:
                existing = local_first_records.get_local_record(company_id=company_id, entity_type=entity_type, entity_id=request.id)
                privileged = current_user.role in {"admin", "manager"}
                if existing and not privileged and str(existing["record"].get("created_by") or "") != current_user.id:
                    raise HTTPException(status_code=403, detail="You cannot edit another user's local client")
                if existing:
                    record_data["created_by"] = existing["record"].get("created_by") or current_user.id
                else:
                    record_data["created_by"] = current_user.id
            else:
                record_data["created_by"] = current_user.id
        saved = local_first_records.save_local_record(
            company_id=company_id,
            entity_type=entity_type,
            entity_id=request.id,
            record=record_data,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return saved


@router.delete("/records/{entity_type}/{entity_id}")
async def delete_local_first_record(
    entity_type: str,
    entity_id: str,
    current_user=Depends(get_local_first_principal),
):
    _ensure_local_first_enabled()
    _ensure_pilot_entity(entity_type)
    company_id = _authenticated_company_id(current_user)
    _require_local_permission(current_user, "delete")
    try:
        deleted = local_first_records.delete_local_record(
            company_id=company_id, entity_type=entity_type, entity_id=entity_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Local record not found")
    return {"deleted": True, "id": entity_id, "entity_type": entity_type}


@router.post("/sync/push")
async def sync_push(
    body: SyncPushRequest,
    current_user=Depends(get_local_first_principal),
):
    """Admin PC or Cloud endpoint: receive batch of changes from a workstation."""
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    if body.company_id != company_id:
        raise HTTPException(status_code=403, detail="Cross-tenant synchronization rejected")
    ack_ids = local_first_sync.process_inbound_push(
        company_id=company_id,
        device_id=body.device_id,
        changes=body.changes,
    )
    return {"status": "ok", "acknowledged_ids": ack_ids}


@router.get("/sync/pull")
async def sync_pull(
    since_cursor: int = Query(default=0),
    limit: int = Query(default=100, ge=1, le=500),
    exclude_device_id: str | None = Query(default=None),
    current_user=Depends(get_local_first_principal),
):
    """Workstation endpoint: pull updates committed by other PCs since the last cursor."""
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    return local_first_sync.process_inbound_pull(
        company_id=company_id,
        since_cursor=since_cursor,
        limit=limit,
        exclude_device_id=exclude_device_id,
    )


@router.post("/sync/trigger")
async def sync_trigger(
    body: SyncTriggerRequest,
    current_user=Depends(get_local_first_principal),
):
    """Trigger a local synchronization cycle against the designated Hub or Cloud target."""
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    target_url = body.sync_target_url or os.getenv("ONENEXA_SYNC_TARGET", "").strip() or os.getenv("ONENEXA_CLOUD_TARGET", "").strip()
    if not target_url:
        return {
            "status": "skipped",
            "message": "No sync target configured. Set ONENEXA_SYNC_TARGET to your Admin PC or Cloud server IP.",
        }
    token = getattr(current_user, "offline_token", None) or "local-token"
    result = await local_first_sync.run_client_sync_cycle(
        sync_target_url=target_url,
        company_id=company_id,
        token=token,
    )
    return result

