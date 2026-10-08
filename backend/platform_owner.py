"""Platform owner identity helpers for the commercial distribution console.

The account used by the software owner to issue and manage customer licenses is
not itself a customer tenant. Keep this identity separate from commercial
license enforcement while allowing the email list to be extended through the
environment for additional internal owners.
"""

import os

# Canonical platform-owner fallback identities. When PLATFORM_OWNER_EMAILS or
# PLATFORM_OWNER_EMAIL environment variables are configured, they take precedence.
DEFAULT_PLATFORM_OWNER_EMAILS = {
    "info.taskosphere@gmail.com",
    "infotaskosphere@gmail.com",
    "admin@taskosphere.com",
}


def platform_owner_emails() -> set[str]:
    configured = os.getenv("PLATFORM_OWNER_EMAILS", "") or os.getenv("PLATFORM_OWNER_EMAIL", "")
    values = {item.strip().lower() for item in configured.split(",") if item.strip()}
    return values if values else DEFAULT_PLATFORM_OWNER_EMAILS


def _install_owner_auth_compat() -> None:
    """Install lazy authentication compatibility helpers after auth loads.

    ``platform_owner`` is imported very early by the authentication stack, so
    importing compatibility modules at module import time would create a
    circular import. ``is_platform_owner`` is called from authentication only
    after the dependency module has been initialized, making this the safe
    installation point.
    """
    try:
        from backend import platform_owner_session_compat
        platform_owner_session_compat.install()
    except Exception:
        # The owner compatibility layer is optional; authentication remains
        # fail-closed if it cannot be installed.
        pass

    try:
        # Legacy customer users can legitimately pre-date company_id on their
        # user document. Install deterministic tenant recovery for all users,
        # not just platform owners. This never guesses: it requires exactly
        # one explicit company/customer/license ownership link.
        from backend import auth_company_recovery
        auth_company_recovery.install()
    except Exception:
        pass


def is_platform_owner(user) -> bool:
    if not user:
        return False

    # Install the lazy auth compatibility/recovery layer for every authenticated
    # identity. This function is called from get_current_user after the auth
    # module is fully initialized, so this cannot create the old import cycle.
    _install_owner_auth_compat()

    if isinstance(user, dict):
        email = str(user.get("email") or "").strip().lower()
        user_id = str(user.get("id") or user.get("_id") or "").strip()
        role = str(user.get("role") or "").strip().lower()
        is_owner_flag = bool(user.get("is_platform_owner") or user.get("isPlatformOwner"))
    else:
        email = str(getattr(user, "email", "") or "").strip().lower()
        user_id = str(getattr(user, "id", "") or "").strip()
        role = str(getattr(user, "role", "") or "").strip().lower()
        is_owner_flag = bool(getattr(user, "is_platform_owner", False) or getattr(user, "isPlatformOwner", False))

    if is_owner_flag or role in {"platform_owner", "superadmin", "saas_admin"}:
        return True

    company_id = str(
        user.get("company_id") or user.get("company", {}).get("id") or ""
        if isinstance(user, dict)
        else getattr(user, "company_id", None) or ""
    ).strip().lower()

    owner_emails = platform_owner_emails()
    # Canonical Platform Owner identities win over stale tenant markers left by
    # historical migrations. This preserves the real Platform Owner account.
    if (
        (email and email in owner_emails)
        or (user_id and user_id in {"saas-bootstrap-admin", "usr-admin-01"})
        or company_id == "platform-owner-48fe785fdd75127f"
        or company_id.startswith("platform-owner-")
    ):
        return True

    # Any remaining account carrying commercial ownership markers is a tenant.
    commercial_identity = bool(
        (user.get("license_id") if isinstance(user, dict) else getattr(user, "license_id", None))
        or (user.get("commercial_customer_id") if isinstance(user, dict) else getattr(user, "commercial_customer_id", None))
        or (user.get("company", {}).get("commercial_customer_id") if isinstance(user, dict) else False)
    )
    if commercial_identity:
        return False

    return False
