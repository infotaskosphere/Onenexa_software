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
    }

    assert expected.issubset(TENANT_COLLECTIONS)
