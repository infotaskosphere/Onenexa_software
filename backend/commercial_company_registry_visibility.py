"""Keep license-generated companies out of the Platform Owner Company Master.

License generation creates a commercial customer record plus an internal
operational company record so tenant relationships remain intact. That record
must remain visible to the License Registry and to its own licensee, but it
must not appear in the Platform Owner's normal operational Company Master.

Context rules
  * Platform Owner (operational modules)  -> licensee companies are hidden.
  * Platform Owner Commercial Console     -> unfiltered (intentional access).
  * Licensee admin / user                 -> never touched by this filter, so
                                             their own licensed company stays
                                             visible.
"""

import inspect

from backend import tenant_runtime


_ORIGINAL = tenant_runtime._scope_company_registry_query
_SELF = __name__


def _in_commercial_control_context() -> bool:
    """Commercial Console / licensing / system caller detection.

    tenant_runtime._is_commercial_control_context() matches any frame whose
    module starts with ``backend.commercial_`` -- including THIS module, which
    would make the check always true and disable the filter. Walk the stack
    ourselves and ignore this module's own frame.
    """
    if tenant_runtime.in_system_context():
        return True
    for frame_info in inspect.stack(context=0):
        module_name = str(frame_info.frame.f_globals.get("__name__") or "")
        if module_name in {_SELF, "backend.tenant_runtime"}:
            continue
        if (
            module_name.startswith("backend.commercial_")
            or module_name.startswith("backend.licensing_")
            or module_name.startswith("backend.platform_owner")
            or module_name == "backend.backup_restore"
        ):
            return True
    return False


def _scope_company_registry_query(query):
    scoped = _ORIGINAL(query)
    scoped = dict(scoped) if isinstance(scoped, dict) else {}
    # Licensee requests are already fenced to their own tenant by the tenant
    # scope. Hiding commercial records here would hide the licensee's OWN
    # company, so the filter is applied to the Platform Owner context only.
    if not tenant_runtime.in_platform_owner_context():
        return scoped
    # The Commercial Console intentionally manages licensee companies.
    if _in_commercial_control_context():
        return scoped
    # The Platform Owner's own practice may be stamped with the owner markers
    # (same markers quotations.py / commercial_company_master.py treat as owned).
    # Those must stay visible; only real licensee ownership is hidden.
    owner_markers = [None, "", "platform-owner"]
    exclusion = {
        "source": {"$nin": ["commercial-license", "commercial", "license", "commercial-customer"]},
        "commercial_customer_id": {"$in": owner_markers},
        "license_id": {"$in": owner_markers + ["platform-owner-license"]},
    }
    # Combine with, rather than overwrite, any predicate the caller supplied.
    return {"$and": [scoped, exclusion]} if scoped else exclusion


tenant_runtime._scope_company_registry_query = _scope_company_registry_query
