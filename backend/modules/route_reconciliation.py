"""Final route ownership reconciliation metadata and checks."""
from __future__ import annotations

from types import MappingProxyType

from backend.modules.route_ownership import ROUTE_OWNERSHIP

RECONCILED_OWNERS = MappingProxyType({
    "taskosphere.tasks": "backend.modules.taskosphere.tasks.router",
    "taskosphere.attendance": "backend.modules.taskosphere.attendance.router",
    "taskosphere.clients": "backend.modules.taskosphere.clients.router",
    "taskosphere.dsc": "backend.modules.taskosphere.dsc.router",
    "taskosphere.dashboard": "backend.modules.taskosphere.dashboard.router",
    "finix_ai.accounting": "backend.modules.finix_ai.accounting.service",
    "finix_ai.accounting_extended": "backend.accounting_extended",
    "finix_ai.banking": "backend.modules.finix_ai.banking.service",
    "finix_ai.reconciliation": "backend.modules.finix_ai.reconciliation.router",
    "finix_ai.ai": "backend.modules.finix_ai.ai.service",
    "aiweave.router": "backend.modules.aiweave.router.router",
    "compligenie.compliance": "backend.modules.compligenie.compliance.router",
    "leadsense.leads": "backend.modules.leadsense.leads.router",
    "leadsense.activities": "backend.modules.leadsense.activities.service",
    "leadsense.quotations": "backend.modules.leadsense.quotations.router",
    "people_matrix.permissions": "backend.modules.people_matrix.permissions.router",
    "people_matrix.roles": "backend.modules.people_matrix.roles.router",
    "people_matrix.governance": "backend.modules.people_matrix.governance.router",
    "records.documents": "backend.modules.records.documents.router",
    "trademark.sphere": "backend.modules.trademark.sphere.service",
    "trademark.portals": "backend.modules.trademark.portals.service",
    "trademark.quality": "backend.modules.trademark.quality.router",
})


def unresolved_owners() -> list[str]:
    return sorted(set(ROUTE_OWNERSHIP) - set(RECONCILED_OWNERS))
