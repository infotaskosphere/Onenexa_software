"""Route ownership reconciliation metadata.

Keeps current runtime registrations mapped to their intended domain owner.
No router is removed or re-registered by this module.
"""
from types import MappingProxyType

ROUTE_OWNERSHIP = MappingProxyType({
    "core.identity": ("backend.dependencies", "/api/auth"),
    "core.user_admin": ("backend.server_modules.users_todos_admin", "/api/users"),
    "core.security": ("backend.server_modules.auth_routes", "/api/auth/sessions"),
    "core.settings": ("backend.server_modules.application_runtime", "/api/settings"),
    "taskosphere.tasks": ("backend.server_modules.task_routes", "/api"),
    "taskosphere.attendance": ("backend.server_modules.attendance_routes", "/api"),
    "taskosphere.clients": ("backend.server_modules.client_management", "/api"),
    "taskosphere.dsc": ("backend.server_modules.dsc_routes", "/api"),
    "taskosphere.dashboard": ("backend.server_modules.dashboard_ops", "/api"),
    "finix_ai.accounting": ("backend.accounting_core", "/api"),
    "finix_ai.banking": ("backend.bank_accounts", "/api"),
    "finix_ai.accounting_extended": ("backend.accounting_extended", "/api"),
    "finix_ai.ai": ("backend.accounting_ai.finix_ai_router", "/api"),
    "aiweave.router": ("backend.ai.aiweave_router", ""),
    "compligenie.compliance": ("backend.compliance", "/api"),
    "leadsense.leads": ("backend.leads", "/api"),
    "leadsense.activities": ("backend.client_activity", "/api"),
    "people_matrix.permissions": ("backend.permission_governance", "/api"),
    "people_matrix.roles": ("backend.roles_admin", "/api"),
    "trademark.sphere": ("backend.trademark_sphere", "/api"),
    "trademark.portals": ("backend.trademark_portals_router", ""),
})
