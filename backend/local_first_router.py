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

router = APIRouter(prefix="/desktop/local-first", tags=["OneNexa Desktop Local-First"])


class LocalRecordRequest(BaseModel):
    id: str | None = Field(default=None, min_length=1, max_length=200)
    record: dict[str, Any]


def _ensure_local_first_enabled() -> None:
    """Keep pilot local-disk APIs disabled on hosted deployments by default."""
    if os.getenv("ONENEXA_LOCAL_FIRST_ENABLED", "").strip() != "1":
        raise HTTPException(status_code=404, detail="Local-first desktop API is not enabled on this server")


def _authenticated_company_id(current_user: Any) -> str:
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")
    return company_id


@router.get("/status")
async def get_local_first_status(current_user=Depends(get_current_user)):
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
    current_user=Depends(get_current_user),
):
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    try:
        items = local_first_records.list_local_records(
            company_id=company_id, entity_type=entity_type, limit=limit
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"items": items, "count": len(items), "source": "local_sqlite"}


@router.post("/records/{entity_type}")
async def save_local_first_record(
    entity_type: str,
    request: LocalRecordRequest,
    current_user=Depends(get_current_user),
):
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    try:
        saved = local_first_records.save_local_record(
            company_id=company_id,
            entity_type=entity_type,
            entity_id=request.id,
            record=request.record,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return saved


@router.delete("/records/{entity_type}/{entity_id}")
async def delete_local_first_record(
    entity_type: str,
    entity_id: str,
    current_user=Depends(get_current_user),
):
    _ensure_local_first_enabled()
    company_id = _authenticated_company_id(current_user)
    try:
        deleted = local_first_records.delete_local_record(
            company_id=company_id, entity_type=entity_type, entity_id=entity_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Local record not found")
    return {"deleted": True, "id": entity_id, "entity_type": entity_type}
