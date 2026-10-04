"""
auth_password_reset.py
─────────────────────
Handles forgot-password OTP flow and password resets:
  POST /auth/forgot-password  →  generate & email 6-digit OTP + reset link
  POST /auth/reset-password   →  verify OTP, update password, invalidate sessions, send alert
"""

import os
import secrets
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from passlib.context import CryptContext
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, Request
from dateutil import parser as dateutil_parser

from backend.dependencies import db
from backend.security.rate_limiter import RateLimiter
from backend.security.audit_security import AuditSecurity
from backend.email_service.service import email_service
from backend.email_service.recovery_service import AccountRecoveryService

logger      = logging.getLogger(__name__)
router      = APIRouter()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _hash_reset_token(token: str) -> str:
    """Hash reset OTPs before persistence so the reset secret is never stored plaintext."""
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


# ── Pydantic models ───────────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    email: str
    token: str
    new_password: str


# ── Backward-compatible helper ────────────────────────────────────────────────

async def _send_otp_email(to_email: str, subject: str, body: str) -> None:
    """Delegates to central email service with fallback."""
    try:
        await email_service.send_email(
            to_email=to_email,
            subject=subject,
            body_plain=body,
            template_code="PASSWORD_RESET",
            email_type="auth",
        )
    except Exception as e:
        logger.error("Failed to send OTP via central email service: %s", e)
        raise


# ── Routes ────────────────────────────────────────────────────────────────────

async def _enforce_otp_rate_limit(request: Request, email: str, limit_per_minute: int):
    """
    Throttles OTP request/verify by client IP + email, so an attacker can't
    spam OTP emails or brute-force a 6-digit OTP within its window.
    """
    client_ip = request.client.host if request and request.client else "unknown"
    key = f"otp:{client_ip}:{(email or '').lower()}"
    try:
        if await RateLimiter.is_rate_limited(key, limit_per_minute=limit_per_minute):
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait a minute and try again.",
            )
    except HTTPException:
        raise
    except Exception:
        logger.warning("Rate limiter check failed; allowing request through.")


@router.post("/auth/forgot-password")
async def forgot_password(data: ForgotPasswordRequest, request: Request):
    """
    Always returns 200 to prevent email enumeration.
    Generates a 6-digit OTP, stores it in DB, emails it via Central Email Service.
    OTP expires in 15 minutes (or as configured in recovery settings).
    """
    email = data.email.strip().lower()
    await _enforce_otp_rate_limit(request, email, limit_per_minute=3)

    settings = await AccountRecoveryService.get_recovery_settings()
    if not settings.enable_forgot_password:
        return {"message": "If that email is registered, password recovery instructions have been sent."}

    user = await db.users.find_one({"email": email})

    if user:
        otp = str(secrets.randbelow(900000) + 100000)
        expiry_mins = settings.password_reset_token_expiry_minutes or 15
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=expiry_mins)).isoformat()

        await db.password_reset_tokens.delete_many({"email": email})
        await db.password_reset_tokens.insert_one({
            "email":       email,
            "token_hash":  _hash_reset_token(otp),
            "expires_at":  expires_at,
            "user_id":     str(user.get("id") or user.get("_id")),
        })

        base_url = (request.base_url._url if request and request.base_url else "http://localhost:3000").rstrip("/")
        reset_link = f"{base_url}/forgot-password?email={email}&token={otp}"

        try:
            await email_service.send_template_email(
                to_email=data.email.strip(),
                template_code="PASSWORD_RESET",
                context={
                    "user_name": user.get("full_name") or "Valued User",
                    "email": email,
                    "otp": otp,
                    "reset_link": reset_link,
                    "expiry_minutes": expiry_mins,
                },
                related_user_id=str(user.get("id") or user.get("_id")),
            )
            logger.info("Password reset OTP sent to %s", email)
        except Exception as e:
            logger.error("Failed to send OTP email to %s: %s", email, e)

        try:
            await AuditSecurity.log_security_event(
                event_type="password_reset_requested",
                actor_id=str(user.get("id") or email),
                company_id=str(user.get("company_id") or ""),
                severity="info",
                details=f"Password reset requested for {email}.",
            )
        except Exception:
            pass

    return {"message": "If that email is registered, password recovery instructions have been sent."}


@router.post("/auth/reset-password")
async def reset_password(data: ResetPasswordRequest, request: Request):
    """
    Verifies the OTP/token, updates password, increments password_version,
    invalidates previous sessions, and sends PASSWORD_CHANGED alert.
    """
    email = data.email.strip().lower()
    await _enforce_otp_rate_limit(request, email, limit_per_minute=10)

    supplied_token = data.token.strip()
    record = await db.password_reset_tokens.find_one(
        {
            "email": email,
            "$or": [
                {"token_hash": _hash_reset_token(supplied_token)},
                # Temporary compatibility for reset codes issued before Phase 2.
                {"token": supplied_token},
            ],
        }
    )

    if not record:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP.")

    expires_at = dateutil_parser.isoparse(record["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires_at:
        await db.password_reset_tokens.delete_many({"email": email})
        raise HTTPException(
            status_code=400,
            detail="OTP has expired. Please request a new one."
        )

    if len(data.new_password) < 12:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 12 characters."
        )

    user = await db.users.find_one({"email": email})
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    user_id = str(user.get("id") or user.get("_id"))
    hashed = pwd_context.hash(data.new_password)

    # If user has SaaS scrypt hashes, update them as well
    updates = {"password": hashed}
    if user.get("password_salt"):
        salt = secrets.token_hex(16)
        scrypt_hash = hashlib.scrypt(
            data.new_password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            maxmem=64 * 1024 * 1024,
        ).hex()
        updates["password_hash"] = scrypt_hash
        updates["password_salt"] = salt

    updates["password_version"] = int(user.get("password_version") or 1) + 1
    await db.users.update_one({"email": email}, {"$set": updates})
    await db.password_reset_tokens.delete_many({"email": email})

    # Invalidate existing sessions and dispatch alert
    client_ip = request.client.host if request and request.client else "unknown"
    await AccountRecoveryService.on_password_reset_success(user_id=user_id, client_ip=client_ip)

    logger.info("Password reset successful and sessions invalidated for %s", email)
    return {"message": "Password updated successfully. Please log in with your new credentials."}
