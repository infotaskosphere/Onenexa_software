import logging
from typing import Dict, Any, Optional
from backend.dependencies import db

logger = logging.getLogger("context_manager")

class ContextManager:
    @staticmethod
    async def gather_user_context(company_id: str, tenant_id: str) -> Dict[str, Any]:
        """Collects metrics, settings, and pending tasks for prompt enrichment."""
        try:
            # Query active business stats
            unpaid_invoices_count = await db.invoices.count_documents({
                "status": {"$in": ["unpaid", "pending", "overdue", "partially_paid"]}
            })
            pending_tasks_count = await db.tasks.count_documents({
                "status": {"$ne": "completed"}
            })
            clients_count = await db.clients.count_documents({})
            
            pending_invoices_to_review = await db.ai_document_memory.count_documents({
                "decision": "REQUIRES_REVIEW"
            })
            
            pending_approvals_count = await db.approval_requests.count_documents({
                "status": "PENDING"
            })
            
            return {
                "company_id": company_id,
                "tenant_id": tenant_id,
                "unpaid_invoices_count": unpaid_invoices_count,
                "pending_tasks_count": pending_tasks_count,
                "clients_count": clients_count,
                "pending_invoices_to_review": pending_invoices_to_review,
                "pending_approvals": pending_approvals_count,
                "timestamp": True
            }
        except Exception as e:
            logger.error(f"Error gathering user context: {e}")
            return {"company_id": company_id, "tenant_id": tenant_id}
