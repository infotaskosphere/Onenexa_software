"""Device-local, expiring session tokens for the OneNexa desktop pilot.

These tokens are signed with a random key stored in the per-user OneNexa data
directory. They are not accepted by cloud deployments and must not be used as
a replacement for normal online login. The short expiry limits the offline
authorization window until a full license-aware offline policy is implemented.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.local_first_store import get_local_data_dir

_LOCAL_TOKEN_PREFIX = "onenexa-local."
_LOCAL_SESSION_SECONDS = 72 * 60 * 60
_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class LocalFirstPrincipal:
    id: str
    company_id: str
    role: str
    permissions: dict[str, Any]
    token_expires_at: int


def _key_path() -> Path:
    return get_local_data_dir() / "local-session.key"


def _get_signing_key() -> bytes:
    path = _key_path()
    try:
        with path.open("xb") as key_file:
            key = secrets.token_bytes(32)
            key_file.write(key)
            key_file.flush()
            os.fsync(key_file.fileno())
    except FileExistsError:
        pass

    try:
        if os.name != "nt":
            path.chmod(0o600)
    except OSError:
        pass

    key = path.read_bytes()
    if len(key) != 32:
        raise RuntimeError("OneNexa local session signing key is invalid")
    return key


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def issue_local_session(user: Any) -> dict[str, Any]:
    """Issue a short-lived local token after the normal online auth succeeds."""
    user_id = str(getattr(user, "id", "") or "").strip()
    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not user_id or not company_id:
        raise HTTPException(status_code=403, detail="A user and company are required for local access")

    raw_permissions = getattr(user, "permissions", {}) or {}
    if hasattr(raw_permissions, "model_dump"):
        raw_permissions = raw_permissions.model_dump()
    elif not isinstance(raw_permissions, dict):
        try:
            raw_permissions = dict(raw_permissions)
        except Exception:
            raw_permissions = {}

    now = int(time.time())
    payload = {
        "sub": user_id,
        "company_id": company_id,
        "role": str(getattr(user, "role", "") or "").lower(),
        "permissions": raw_permissions,
        "iat": now,
        "exp": now + _LOCAL_SESSION_SECONDS,
        "jti": secrets.token_urlsafe(18),
        "token_type": "onenexa_local",
    }
    encoded = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64url(hmac.new(_get_signing_key(), encoded.encode("ascii"), hashlib.sha256).digest())
    return {
        "offline_token": _LOCAL_TOKEN_PREFIX + encoded + "." + signature,
        "expires_at": payload["exp"],
        "expires_in_seconds": _LOCAL_SESSION_SECONDS,
        "user_id": user_id,
        "company_id": company_id,
    }


def verify_local_session(token: str) -> LocalFirstPrincipal:
    """Validate a device-local token without contacting MongoDB or the internet."""
    if not isinstance(token, str) or not token.startswith(_LOCAL_TOKEN_PREFIX):
        raise HTTPException(status_code=401, detail="A OneNexa local session is required")

    parts = token[len(_LOCAL_TOKEN_PREFIX):].split(".")
    if len(parts) != 2:
        raise HTTPException(status_code=401, detail="Invalid OneNexa local session")

    encoded, supplied_signature = parts
    try:
        expected_signature = _b64url(
            hmac.new(_get_signing_key(), encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise HTTPException(status_code=401, detail="Invalid OneNexa local session")
        payload = json.loads(_unb64url(encoded).decode("utf-8"))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid OneNexa local session") from exc

    now = int(time.time())
    if payload.get("token_type") != "onenexa_local":
        raise HTTPException(status_code=401, detail="Invalid OneNexa local session")
    if not isinstance(payload.get("exp"), int) or payload["exp"] <= now:
        raise HTTPException(status_code=401, detail="OneNexa local session expired; connect online to renew it")
    if not str(payload.get("sub") or "").strip() or not str(payload.get("company_id") or "").strip():
        raise HTTPException(status_code=401, detail="Invalid OneNexa local session")

    permissions = payload.get("permissions")
    if not isinstance(permissions, dict):
        permissions = {}
    return LocalFirstPrincipal(
        id=str(payload["sub"]),
        company_id=str(payload["company_id"]),
        role=str(payload.get("role") or "").lower(),
        permissions=permissions,
        token_expires_at=payload["exp"],
    )


async def get_local_first_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> LocalFirstPrincipal:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=401, detail="A OneNexa local session is required")
    return verify_local_session(credentials.credentials)
