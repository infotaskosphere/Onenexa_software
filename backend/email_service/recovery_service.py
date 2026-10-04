import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from backend.dependencies import db
from backend.email_service.models import AccountRecoverySettings
from backend.email_service.service import email_service
from backend.security.audit_security import AuditSecurity

logger = logging.getLogger("account_recovery")
from backend.security.session_manager import SessionManager


def _mask_email(email_str: str) -> str:
    """Masks an email like j•••••e@domain.com for secure recovery output."""
    if not email_str or "@" not in email_str:
        return "••••••••"
    parts = email_str.split("@")
    name = parts[0]
    domain = parts[1]
    if len(name) <= 2:
        masked_name = name[0] + "•••"
    else:
        masked_name = name[0] + "•" * (min(len(name) - 2, 5)) + name[-1]
    return f"{masked_name}@{domain}"


class AccountRecoveryService:
    """Manages secure password reset, forgot email ID recovery, and email verification."""

    @staticmethod
    async def get_recovery_settings() -> AccountRecoverySettings:
        doc = await db.system_recovery_settings.find_one({"type": "account_recovery_config"}, {"_id": 0})
        if not doc:
            return AccountRecoverySettings()
        return AccountRecoverySettings(**doc)

    @staticmethod
    async def save_recovery_settings(settings: AccountRecoverySettings, updated_by: str = "admin") -> AccountRecoverySettings:
        doc = settings.model_dump()
        doc["type"] = "account_recovery_config"
        doc["updated_at"] = datetime.now(timezone.utc).isoformat()
        doc["updated_by"] = updated_by
        await db.system_recovery_settings.update_one(
            {"type": "account_recovery_config"},
            {"$set": doc},
            upsert=True,
        )
        return settings

    @classmethod
    async def generate_verification_token(cls, user_id: str, email_addr: str) -> str:
        """Generates a cryptographically secure single-use email verification token."""
        settings = await cls.get_recovery_settings()
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.email_verification_token_expiry_hours)

        # Invalidate older tokens for this user
        await db.email_verification_tokens.delete_many({"user_id": user_id})

        await db.email_verification_tokens.insert_one({
            "token_hash": token_hash,
            "user_id": user_id,
            "email": email_addr.lower().strip(),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": expires_at.isoformat(),
            "used": False,
        })
        return raw_token

    @classmethod
    async def verify_email_token(cls, raw_token: str) -> Dict[str, Any]:
        """Validates verification token and marks user email as verified."""
        if not raw_token or not raw_token.strip():
            return {"success": False, "message": "Verification token is required."}

        token_hash = hashlib.sha256(raw_token.strip().encode()).hexdigest()
        record = await db.email_verification_tokens.find_one({"token_hash": token_hash})