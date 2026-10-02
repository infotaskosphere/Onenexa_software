"""Regression tests: backup download must await Motor's GridFS stream and support Range resume."""

import asyncio

import pytest
from bson import ObjectId
from fastapi import HTTPException, Request

DATA = bytes(range(256)) * 3


class _GridOut:
    length = len(DATA)

    def __init__(self):
        self.pos = 0

    async def read(self, size):
        chunk = DATA[self.pos:self.pos + size]
        self.pos += len(chunk)
        return chunk

    async def close(self):
        pass


class _Bucket:
    # Mirrors Motor: open_download_stream is a coroutine and must be awaited.
    async def open_download_stream(self, _id):
        return _GridOut()


def _request(range_header=None):
    headers = [(b"range", range_header.encode())] if range_header else []
    return Request({"type": "http", "headers": headers})


async def _body(response):
    out = b""
    async for chunk in response.body_iterator:
        out += chunk
    return out


@pytest.fixture
def stream(monkeypatch):
    from backend import backup_restore

    monkeypatch.setattr(backup_restore, "_backup_gridfs", lambda raw: _Bucket())
    monkeypatch.setattr(backup_restore, "CHUNK_SIZE", 7)
    return backup_restore._stream_backup_artifact


def _doc():
    return {"artifact_file_id": ObjectId(), "filename": "x.onenexa", "file_size_bytes": len(DATA)}


def test_full_download_awaits_gridfs_stream(stream):
    response = asyncio.run(stream(_request(), None, _doc(), "id"))
    assert response.status_code == 200
    assert response.headers["content-length"] == str(len(DATA))
    assert response.headers["content-encoding"] == "identity"
    assert asyncio.run(_body(response)) == DATA


def test_range_resume_returns_partial_content(stream):
    response = asyncio.run(stream(_request("bytes=100-299"), None, _doc(), "id"))
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 100-299/{len(DATA)}"
    assert asyncio.run(_body(response)) == DATA[100:300]


def test_open_ended_range(stream):
    response = asyncio.run(stream(_request("bytes=700-"), None, _doc(), "id"))
    assert asyncio.run(_body(response)) == DATA[700:]


def test_unsatisfiable_range(stream):
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(stream(_request("bytes=9999-"), None, _doc(), "id"))
    assert excinfo.value.status_code == 416
