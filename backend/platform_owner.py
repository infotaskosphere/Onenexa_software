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
    "csmanthandesai@gmail.com",
}


def platform_owner_emails() -> set[str]:
    configured = os.getenv("PLATFORM_OWNER_EMAILS", "") or os.getenv("PLATFORM_OWNER_EMAIL", "")
    values = {item.strip().lower() for item in configured.split(",") if item.strip()}
    return values.union(DEFAULT_PLATFORM_OWNER_EMAILS)


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

    # A commercial tenant identity always wins over legacy email/role fallbacks.
    # This prevents a customer account from being elevated to Platform Owner merely
    # because it uses an email that historically appeared in the owner allow-list.
    identity_type = str(
        user.get("identity_type") or ""
        if isinstance(user, dict)
        else getattr(user, "identity_type", "") or ""
    ).strip().lower()
    licensee_uid = str(
        user.get("licensee_uid") or ""
        if isinstance(user, dict)
        else getattr(user, "licensee_uid", "") or ""
    ).strip()
    commercial_customer_id = str(
        user.get("commercial_customer_id") or ""
        if isinstance(user, dict)
        else getattr(user, "commercial_customer_id", "") or ""
    ).strip()
    license_id = str(
        user.get("license_id") or ""
        if isinstance(user, dict)
        else getattr(user, "license_id", "") or ""
    ).strip()
    # An explicit Platform Owner identity is authoritative. A stale legacy
    # commercial/license field must not turn the real owner account into a
    # commercial tenant and cause a 403 during login.
    if (
        is_owner_flag
        or role in {"platform_owner", "superadmin", "saas_admin"}
        or identity_type.startswith("platform_owner")
    ):
        return True

    # New stable Platform Owner hierarchy. The UID is authoritative once present.
    platform_owner_uid = str(
        user.get("platform_owner_uid") or ""
        if isinstance(user, dict)
        else getattr(user, "platform_owner_uid", "") or ""
    ).strip().upper()
    user_uid = str(
        user.get("user_uid") or ""
        if isinstance(user, dict)
        else getattr(user, "user_uid", "") or ""
    ).strip().upper()
    if platform_owner_uid.startswith("PO-") or user_uid.startswith("PO-"):
        return True

    # Commercial tenant identity wins over the legacy owner-email fallback only
    # when it is an explicit commercial organization identity. The email-link
    # layer prevents one email from being attached to both PO-* and L-* identities.
    if (
        identity_type.startswith("licensee")
        or identity_type == "commercial"
        or licensee_uid
        or commercial_customer_id
        or license_id
    ):
        return False

    owner_emails = platform_owner_emails()
    company_id = str(
        user.get("company_id") or user.get("company", {}).get("id") or ""
        if isinstance(user, dict)
        else getattr(user, "company_id", None) or ""
    ).strip().lower()
    return bool(
        (email and email in owner_emails)
        or (user_id and user_id in {"saas-bootstrap-admin", "usr-admin-01"})
        or company_id == "platform-owner-48fe785fdd75127f"
        or company_id.startswith("platform-owner-")
    )
