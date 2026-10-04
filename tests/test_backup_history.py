"""Regression tests for persistent application backup history."""

import inspect

import pytest


def test_backup_history_routes_and_storage_configuration():
    from backend import backup_restore

    routes = {(route.path, tuple(sorted(route.methods or []))) for route in backup_restore.router.routes}

    assert ("/app-backup/history", ("GET",)) in routes
    assert ("/app-backup/history/{backup_id}/download", ("GET",)) in routes
    assert ("/app-backup/history/{backup_id}", ("DELETE",)) in routes
    assert backup_restore.BACKUP_HISTORY_COLLECTION == "backup_history"
    assert backup_restore.BACKUP_GRIDFS_BUCKET == "taskosphere_backups"
    assert backup_restore.BACKUP_HISTORY_COLLECTION in backup_restore.EXCLUDED_COLLECTIONS
    assert "taskosphere_backups.files" in backup_restore.EXCLUDED_COLLECTIONS
    assert "taskosphere_backups.chunks" in backup_restore.EXCLUDED_COLLECTIONS


def test_history_document_exposes_safe_metadata_only():
    from backend.backup_restore import _history_document

    row = _history_document({
        "_id": "history-1",
        "filename": "taskosphere-backup-20261002-120000.taskosphere",
        "created_at": "2026-10-02T12:00:00+00:00",
        "created_by_name": "Administrator",
        "mode": "full",
        "company_name": "Example Company",
        "collection_count": 14,
        "document_count": 1234,
        "file_size_bytes": 2048,
        "collections": ["companies", "users", "tasks"],
        "artifact_file_id": "gridfs-id",
        "password": "must-never-leak",
    })

    assert row["id"] == "history-1"
    assert row["filename"].endswith(".taskosphere")
    assert row["document_count"] == 1234
    assert row["file_size_bytes"] == 2048
    assert row["deletable"] is True
    assert "password" not in row
    assert "artifact_file_id" not in row


def test_backup_history_requires_admin_for_delete():
    from types import SimpleNamespace
    from fastapi import HTTPException

    from backend.backup_restore import _require_admin

    with pytest.raises(HTTPException) as exc:
        _require_admin(SimpleNamespace(role="staff", company_id="company-1"))

    assert exc.value.status_code == 403


def test_delete_history_removes_metadata_and_gridfs_artifact():
    from backend.backup_restore import delete_backup_history

    source = inspect.getsource(delete_backup_history)
    assert "delete_one" in source
    assert "artifact_file_id" in source
    assert "await _backup_gridfs(raw).delete(artifact_id)" in source
    assert "history_collection.insert_one(doc)" in source


def test_create_backup_persists_completed_artifact_before_response():
    from backend.backup_restore import _run_backup_job

    source = inspect.getsource(_run_backup_job)
    assert "_persist_backup_artifact" in source
    assert "_set_backup_progress" in source
    assert "history_persisted" in source


def test_history_artifacts_are_not_recursively_backed_up():
    from backend.backup_restore import EXCLUDED_COLLECTIONS, BACKUP_GRIDFS_BUCKET

    assert "backup_history" in EXCLUDED_COLLECTIONS
    assert f"{BACKUP_GRIDFS_BUCKET}.files" in EXCLUDED_COLLECTIONS
    assert f"{BACKUP_GRIDFS_BUCKET}.chunks" in EXCLUDED_COLLECTIONS
