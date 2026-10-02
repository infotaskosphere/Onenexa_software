"""Tenant isolation reconciliation contracts."""
import unittest

from backend.modules.tenant_reconciliation import missing_tenant_coverage


class TenantReconciliationTests(unittest.TestCase):
    def test_operational_owned_collections_are_tenant_scoped(self):
        missing = missing_tenant_coverage()
        self.assertEqual(missing, {})


if __name__ == "__main__":
    unittest.main()


def test_company_owned_finix_audit_history_collections_are_tenant_scoped():
    from backend.tenant_runtime import TENANT_COLLECTIONS

    expected = {
        "accounting_audit",
        "accounting_audit_locks",
        "accounting_audit_sequences",
        "accounting_locks",
        "accounting_posting_failures",
        "accounting_rules",
        "accounting_sequences",
        "adjustment_note_overrides",
        "journal_templates",
        "ledger_learning",
        "posting_audit",
        "posting_history",
        "voucher_history",
        "gst_portal_audit_risk",
        "vendor_rule_overrides",
        "vendor_learning_history",
        "ai_validation_results",
        "ai_confidence_history",
        "ai_anomaly_history",
        "ai_document_memory",
        "ai_document_workspace",
        "ai_workspace_knowledge",
        "document_classifications",
        "ocr_processing_history",
        "ocr_quality_reports",
        "bank_learning",
        "bank_statement_templates",
        "cashflow_history",
        "finix_ai_documents",
        "finix_ai_learning",
        "financial_validations",
        "reconciliation_events",
        "template_usage_history",
        "gst_learning",
        "gst_processing_history",
        "gst_validation",
        "itc_register",
        "gst_audit",
        "gst_compliance",
        "departments",
        "designations",
    }

    assert expected.issubset(TENANT_COLLECTIONS)


def test_tenant_aware_collection_rejects_cross_company_query(monkeypatch):
    import asyncio
    from backend.tenant_runtime import TenantAwareCollection, set_authenticated_company, reset_authenticated_company
    from fastapi import HTTPException

    class FakeCollection:
        def __init__(self):
            self.last_query = None
        async def find_one(self, query, *args, **kwargs):
            self.last_query = query
            return {"id": "row-a", "company_id": "company-a"} if query.get("company_id") == "company-a" else None

    raw = FakeCollection()
    wrapped = TenantAwareCollection(raw, "invoices")
    token = set_authenticated_company("company-a")
    try:
        result = asyncio.run(wrapped.find_one({"id": "row-a"}))
        assert result["company_id"] == "company-a"
        assert raw.last_query == {"id": "row-a", "company_id": "company-a"}

        try:
            asyncio.run(wrapped.find_one({"id": "row-b", "company_id": "company-b"}))
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("Cross-company query should be rejected")
    finally:
        reset_authenticated_company(token)
