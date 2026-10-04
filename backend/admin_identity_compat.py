"""Compatibility bootstrap for commercial deployments.

Normalize admin role values and preserve the commercial identity fields that
older Pydantic User models do not declare.  Those fields are required by the
license/customer resolvers to recover the company for a licensee account even
when a legacy user document has no company_id yet.
"""

from backend.models import DEFAULT_ROLE_PERMISSIONS, User

_original_user_init = User.__init__
_MODULE_FLAGS = (
    "can_access_taskosphere",
    "can_access_finix",
    "can_access_compliance",
    "can_access_records",
    "can_access_proposals",
    "can_access_people_matrix",
    "can_access_aiweave",
)
_COMMERCIAL_IDENTITY_FIELDS = (
    "commercial_customer_id",
    "license_id",
    "license_key",
    "licensed_modules",
    "selected_features",
)


def _normalized_user_init(self, **data):
    role = data.get("role", "staff")
    role_value = getattr(role, "value", role)
    if isinstance(role_value, str):
        role_value = role_value.strip().lower()
    data["role"] = role_value

    if role_value == "admin":
        stored = data.get("permissions")
        if hasattr(stored, "model_dump"):
            stored = stored.model_dump()
        elif not isinstance(stored, dict):
            stored = {}

        canonical = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
        # A commercial admin is identified by company_id or a commercial
        # identity field. Preserve the module flags so the live license
        # entitlement layer can cap them on every authenticated request.
        is_commercial_admin = bool(data.get("company_id")) or any(
            data.get(field) not in (None, "", [], {}) for field in _COMMERCIAL_IDENTITY_FIELDS
        )
        if is_commercial_admin:
            for flag in _MODULE_FLAGS:
                if flag in stored:
                    canonical[flag] = bool(stored[flag])

        data["permissions"] = canonical

    # Pydantic's User model intentionally ignores unknown legacy/commercial
    # fields. Keep a runtime copy on the model instance so the authentication
    # and tenant resolvers can use them without changing the public User schema.
    identity = {field: data.get(field) for field in _COMMERCIAL_IDENTITY_FIELDS}
    _original_user_init(self, **data)
    for field, value in identity.items():
        if value not in (None, "", [], {}):
            try:
                object.__setattr__(self, field, value)
            except Exception:
                pass


if getattr(User.__init__, "__name__", "") != "_normalized_user_init":
    User.__init__ = _normalized_user_init
