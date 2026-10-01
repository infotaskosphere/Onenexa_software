import logging
import re
from typing import Dict, Any, List, Optional
from backend.dependencies import db

logger = logging.getLogger("tool_router")

class ToolRouter:
    @staticmethod
    async def match_tool(query: str, company_id: str) -> Optional[Dict[str, Any]]:
        """Maps user's natural language to backend commands and matches business logic."""
        q = query.lower().strip()
        
        # 1. Outstanding Payments & Invoices
        if any(k in q for k in ["payment", "outstanding", "unpaid", "bill", "invoice", "receivable", "payable", "due payment"]):
            return {
                "module": "invoices",
                "action": "list_outstanding",
                "args": {"company_id": company_id}
            }

        # 2. Tasks & Operations
        if any(k in q for k in ["task", "pending task", "overdue", "todo", "assignment"]):
            return {
                "module": "tasks",
                "action": "list_tasks",
                "args": {"company_id": company_id}
            }

        # 3. Client & Customer Info
        if any(k in q for k in ["client", "customer"]):
            return {
                "module": "clients",
                "action": "list_clients",
                "args": {"company_id": company_id}
            }

        # 4. GST Query
        if "gst" in q or "tax return" in q:
            return {
                "module": "gst",
                "action": "list_filings",
                "args": {"company_id": company_id}
            }
            
        # 5. Financial Reports
        if "balance sheet" in q or "profit and loss" in q or "p&l" in q or "financial" in q or "mis" in q:
            return {
                "module": "reports",
                "action": "generate_summary",
                "args": {"company_id": company_id}
            }
            
        # 6. Duplicate/Fraud Detection
        if "duplicate" in q or "fraud" in q or "anomaly" in q or "validate" in q:
            return {
                "module": "audit",
                "action": "detect_anomalies",
                "args": {"company_id": company_id}
            }
            
        # 7. Bank Reconciliation
        if "reconcile" in q or "bank statement" in q or "bank" in q:
            return {
                "module": "banking",
                "action": "bank_reconciliation",
                "args": {"company_id": company_id}
            }

        # 8. Predict Cash Flow
        if "cash flow" in q or "predict" in q or "trend" in q:
            return {
                "module": "analytics",
                "action": "predict_trends",
                "args": {"company_id": company_id}
            }

        # 9. ROC Filing
        if "roc" in q or "compliance" in q:
            return {
                "module": "compliance",
                "action": "list_compliance",
                "args": {"company_id": company_id}
            }
            
        return None

    @staticmethod
    async def execute_matched_tool(tool_info: Dict[str, Any]) -> Dict[str, Any]:
        """Runs the actual module logic using existing modules."""
        module = tool_info["module"]
        action = tool_info["action"]
        args = tool_info["args"]
        company_id = args.get("company_id")
        
        try:
            if module == "invoices":
                # Find unpaid / pending / overdue / partially_paid invoices
                query = {"status": {"$in": ["unpaid", "pending", "overdue", "partially_paid"]}}
                if company_id and company_id != "default_comp":
                    query["company_id"] = company_id
                invoices = await db.invoices.find(query, {"_id": 0}).sort("due_date", 1).to_list(100)
                # If nothing found with status filter, also check general open invoices
                if not invoices:
                    invoices = await db.invoices.find(
                        {"status": {"$ne": "paid"}},
                        {"_id": 0}
                    ).sort("invoice_date", -1).to_list(100)
                total_outstanding = sum(
                    float(inv.get("grand_total") or inv.get("total_amount") or inv.get("total") or 0)
                    for inv in invoices
                )
                return {
                    "status": "SUCCESS",
                    "type": "OUTSTANDING_PAYMENTS",
                    "count": len(invoices),
                    "total_outstanding": total_outstanding,
                    "invoices": [
                        {
                            "id": inv.get("id"),
                            "invoice_no": inv.get("invoice_no") or inv.get("number"),
                            "client_name": inv.get("client_name") or inv.get("customer_name"),
                            "amount": float(inv.get("grand_total") or inv.get("total_amount") or inv.get("total") or 0),
                            "due_date": str(inv.get("due_date") or ""),
                            "status": inv.get("status", "unpaid")
                        }
                        for inv in invoices[:15]
                    ]
                }

            elif module == "tasks":
                query = {"status": {"$ne": "completed"}}
                tasks = await db.tasks.find(query, {"_id": 0}).sort("due_date", 1).to_list(100)
                return {
                    "status": "SUCCESS",
                    "type": "PENDING_TASKS",
                    "count": len(tasks),
                    "tasks": [
                        {
                            "id": t.get("id"),
                            "title": t.get("title"),
                            "assigned_to": t.get("assigned_to_name") or t.get("assigned_to"),
                            "due_date": str(t.get("due_date") or ""),
                            "priority": t.get("priority", "medium"),
                            "status": t.get("status", "pending")
                        }
                        for t in tasks[:15]
                    ]
                }

            elif module == "clients":
                clients = await db.clients.find({}, {"_id": 0, "id": 1, "company_name": 1, "contact_person": 1, "phone": 1, "email": 1, "city": 1}).to_list(100)
                return {
                    "status": "SUCCESS",
                    "type": "CLIENT_LIST",
                    "count": len(clients),
                    "clients": clients[:15]
                }

            elif module == "gst":
                from backend.gst_ai.gst_engine import GSTEngine
                # Return standard list
                filings = await db.gst_reconciliation_history.find({"company_id": company_id}).to_list(100)
                return {"status": "SUCCESS", "type": "GST_FILINGS", "data": filings}
                
            elif module == "reports":
                from backend.report_engine import BIReportGenerator
                report = await BIReportGenerator.generate_bi_report(company_id)
                return {"status": "SUCCESS", "type": "FINANCIAL_SUMMARY", "data": report}
                
            elif module == "audit":
                # Find documents that require review
                docs = await db.ai_document_memory.find({
                    "company_id": company_id,
                    "decision": "REQUIRES_REVIEW"
                }).to_list(50)
                return {"status": "SUCCESS", "type": "ANOMALIES_DETECTED", "data": docs}
                
            elif module == "banking":
                # Find bank accounts to show summary
                accounts = await db.bank_accounts.find({"company_id": company_id}).to_list(50)
                return {"status": "SUCCESS", "type": "BANK_RECONCILIATION_ACCOUNTS", "data": accounts}

            elif module == "analytics":
                from backend.report_engine import AnalyticalTrendAnalyzer
                trends = await AnalyticalTrendAnalyzer.analyze_trends(company_id)
                return {"status": "SUCCESS", "type": "TRENDS_PREDICTION", "data": trends}

            elif module == "compliance":
                compliances = await db.compliance_records.find({"company_id": company_id}).to_list(100)
                return {"status": "SUCCESS", "type": "COMPLIANCE_CALENDAR", "data": compliances}
                
        except Exception as e:
            logger.error(f"Error executing copilot tool route {module}.{action}: {e}", exc_info=True)
            return {"status": "FAILED", "error": str(e)}
            
        return {"status": "FAILED", "error": "Unknown module action"}
