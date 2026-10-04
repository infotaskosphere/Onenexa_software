import hashlib
import os
import re
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from backend.dependencies import db
from backend.email_service.models import AccountRecoverySettings
from backend.email_service.service import email_service
from backend.security.audit_security import AuditSecurity
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
        if not record:
            return {"success": False, "message": "Invalid or expired verification link."}

        if record.get("used"):
            return {"success": False, "message": "This verification link has already been used."}

        expires_at_str = record.get("expires_at")
        if expires_at_str:
            expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at < datetime.now(timezone.utc):
                return {"success": False, "message": "Verification link has expired. Please request a new one."}

        # Token valid: mark used and update user
        await db.email_verification_tokens.update_one(
            {"_id": record["_id"]},
            {"$set": {"used": True, "used_at": datetime.now(timezone.utc).isoformat()}},
        )

        user_id = record["user_id"]
        now_iso = datetime.now(timezone.utc).isoformat()

        # Update in DB
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"email_verified": True, "email_verified_at": now_iso, "email_status": "active"}},
        )

        # Audit log
        await AuditSecurity.log_security_event(
            event_type="email_verified",
            actor_id=user_id,
            company_id="",
            severity="info",
            details=f"Email address {record.get('email')} successfully verified via secure token.",
        )

        return {"success": True, "message": "Email verified successfully!", "email": record.get("email")}

    @classmethod
    async def send_verification_email(cls, user_dict: Dict[str, Any], origin_url: Optional[str] = None) -> bool:
        """Dispatches verification email to a user."""
        user_id = str(user_dict.get("id") or user_dict.get("_id"))
        email_addr = (user_dict.get("email") or "").strip()
        if not email_addr:
            return False

        token = await cls.generate_verification_token(user_id, email_addr)
        base_url = (origin_url or os.getenv("VITE_API_URL") or "http://localhost:3000").rstrip("/")
        # Route to frontend /verify-email?token=...
        verify_link = f"{base_url}/verify-email?token={token}"

        settings = await cls.get_recovery_settings()

        return await email_service.send_template_email(
            to_email=email_addr,
            template_code="EMAIL_VERIFICATION",
            context={
                "user_name": user_dict.get("full_name") or "Valued User",
                "email": email_addr,
                "verification_link": verify_link,
                "expiry_hours": settings.email_verification_token_expiry_hours,
            },
            related_user_id=user_id,
        )

    @classmethod
    async def recover_forgot_email_id(cls, identifier: str, client_ip: str) -> Dict[str, Any]:
        """
        Recovers registered email for a user given a phone, license key, or organization GSTIN.
        Always returns generic message to avoid enumeration.
        """
        raw_ident = (identifier or "").strip()
        generic_response = {
            "status": "success",
            "message": "If an account exists matching this reference, account recovery details have been sent to your registered contact.",
        }

        if not raw_ident:
            return generic_response

        # Look for user by phone
        user = await db.users.find_one({
            "$or": [
                {"phone": raw_ident},
                {"phone": {"$regex": re.escape(raw_ident.replace(" ", "").replace("-", "")), "$options": "i"}},
                {"telegram_id": int(raw_ident) if raw_ident.isdigit() else -1},
            ]
        })

        found_email = None
        user_name = "Valued User"
        user_id = None

        if user and user.get("email"):
            found_email = user["email"].strip()
            user_name = user.get("full_name") or "Valued User"
            user_id = str(user.get("id") or "")
        else:
            # Check commercial licenses or customers
            license_doc = await db.commercial_licenses.find_one({
                "$or": [
                    {"license_key": raw_ident.upper()},
                    {"id": raw_ident},
                ]
            })
            if license_doc and license_doc.get("customer_id"):
                cust = await db.commercial_license_customers.find_one({"id": license_doc["customer_id"]})
                if cust and cust.get("email"):
                    found_email = cust["email"].strip()
                    user_name = cust.get("admin_name") or cust.get("company_name") or "License Administrator"

            if not found_email:
                # Check company by gstin
                company = await db.companies.find_one({"gstin": raw_ident.upper()})
                if company and company.get("email"):
                    found_email = company["email"].strip()
                    user_name = company.get("admin_name") or company.get("company_name") or "Company Admin"

        if found_email:
            masked = _mask_email(found_email)
            # Send recovery email to their registered address
            await email_service.send_template_email(
                to_email=found_email,
                template_code="FORGOT_EMAIL",
                context={
                    "user_name": user_name,
                    "masked_email": masked,
                    "identifier": raw_ident[:3] + "•••" + raw_ident[-2:] if len(raw_ident) > 5 else "••••",
                },
                related_user_id=user_id,
            )

            await AuditSecurity.log_security_event(
                event_type="forgot_email_recovered",
                actor_id=user_id or raw_ident,
                company_id="",
                severity="info",
                details=f"Forgot email recovery email sent to registered account from {client_ip}.",
            )

        return generic_response

    @classmethod
    async def on_password_reset_success(cls, user_id: str, client_ip: str = "unknown") -> None:
        """
        Invalidates existing sessions and increments password_version.
        Dispatches PASSWORD_CHANGED security alert.
        """
        now_iso = datetime.now(timezone.utc).isoformat()

        # Fetch current user
        user = await db.users.find_one({"id": user_id}) or await db.users.find_one({"_id": user_id})
        if not user:
            return

        current_ver = int(user.get("password_version") or 1)
        new_ver = current_ver + 1

        # Increment password version and record password_changed_at
        await db.users.update_one(
            {"id": user.get("id") or user_id},
            {
                "$set": {
                    "password_version": new_ver,
                    "password_changed_at": now_iso,
                    "last_password_reset_at": now_iso,
                }
            },
        )

        # Invalidate every active session in both canonical session stores.
        # Password changes must terminate all prior devices immediately.
        try:
            await SessionManager.revoke_all_user_sessions(
                str(user.get("id") or user_id),
                reason="password_changed",
            )
        except Exception:
            logger = __import__("logging").getLogger("account_recovery")
            logger.exception("Failed to revoke all sessions after password reset.")

        # Send security notification
        settings = await cls.get_recovery_settings()
        if settings.enable_password_changed_alerts and user.get("email"):
            await email_service.send_template_email(
                to_email=user["email"],
                template_code="PASSWORD_CHANGED",
                context={
                    "user_name": user.get("full_name") or "Valued User",
                    "email": user["email"],
                    "ip_address": client_ip,
                    "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                },
                related_user_id=user.get("id") or user_id,
            )

        await AuditSecurity.log_security_event(
            event_type="password_reset_completed",
            actor_id=user.get("id") or user_id,
            company_id=str(user.get("company_id") or ""),
            severity="info",
            details=f"Password reset completed. All prior sessions revoked (pwd_version -> {new_ver}).",
        )