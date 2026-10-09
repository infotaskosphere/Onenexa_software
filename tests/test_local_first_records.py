"""Tests for OneNexa's transactional local-first pilot record store."""

import os
import tempfile
import unittest

from backend import local_first_store as store
from backend import local_first_records as records


class LocalFirstRecordTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.previous_data_dir = os.environ.get("ONENEXA_DATA_DIR")
        os.environ["ONENEXA_DATA_DIR"] = self.temporary_directory.name
        store.initialize_local_store()

    def tearDown(self):
        if self.previous_data_dir is None:
            os.environ.pop("ONENEXA_DATA_DIR", None)
        else:
            os.environ["ONENEXA_DATA_DIR"] = self.previous_data_dir
        self.temporary_directory.cleanup()

    def test_save_persists_record_and_outbox_together(self):
        saved = records.save_local_record(
            company_id="company-a",
            entity_type="client",
            entity_id="client-1",
            record={"name": "Example Client"},
        )
        self.assertEqual(saved["operation"], "create")
        self.assertEqual(saved["record"]["company_id"], "company-a")
        pending = store.get_pending_changes(company_id="company-a")
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["entity_id"], "client-1")
        self.assertEqual(pending[0]["payload"]["name"], "Example Client")

    def test_update_queues_update_and_preserves_creation(self):
        first = records.save_local_record(
            company_id="company-a",
            entity_type="task",
            entity_id="task-1",
            record={"title": "Draft"},
        )
        second = records.save_local_record(
            company_id="company-a",
            entity_type="task",
            entity_id="task-1",
            record={"title": "Reviewed"},
        )
        self.assertEqual(first["operation"], "create")
        self.assertEqual(second["operation"], "update")
        listed = records.list_local_records(company_id="company-a", entity_type="task")
        self.assertEqual(listed[0]["record"]["title"], "Reviewed")
        self.assertEqual(len(store.get_pending_changes(company_id="company-a")), 2)

    def test_records_are_isolated_by_company(self):
        records.save_local_record(
            company_id="company-a",
            entity_type="client",
            entity_id="shared-id",
            record={"name": "A"},
        )
        records.save_local_record(
            company_id="company-b",
            entity_type="client",
            entity_id="shared-id",
            record={"name": "B"},
        )
        a = records.list_local_records(company_id="company-a", entity_type="client")
        b = records.list_local_records(company_id="company-b", entity_type="client")
        self.assertEqual(a[0]["record"]["name"], "A")
        self.assertEqual(b[0]["record"]["name"], "B")

    def test_delete_hides_record_and_queues_tombstone(self):
        records.save_local_record(
            company_id="company-a",
            entity_type="client",
            entity_id="client-1",
            record={"name": "Remove me"},
        )
        self.assertTrue(records.delete_local_record(
            company_id="company-a", entity_type="client", entity_id="client-1"
        ))
        self.assertEqual(records.list_local_records(company_id="company-a", entity_type="client"), [])
        pending = store.get_pending_changes(company_id="company-a")
        self.assertEqual(pending[-1]["operation"], "delete")
        self.assertEqual(pending[-1]["entity_id"], "client-1")
        self.assertFalse(records.delete_local_record(
            company_id="company-a", entity_type="client", entity_id="client-1"
        ))

    def test_client_records_can_be_filtered_to_their_creator(self):
        records.save_local_record(
            company_id="company-a",
            entity_type="client",
            entity_id="client-a",
            record={"company_name": "A", "created_by": "user-a"},
        )
        records.save_local_record(
            company_id="company-a",
            entity_type="client",
            entity_id="client-b",
            record={"company_name": "B", "created_by": "user-b"},
        )
        visible = records.list_local_records(
            company_id="company-a", entity_type="client", created_by="user-a"
        )
        self.assertEqual(len(visible), 1)
        self.assertEqual(visible[0]["record"]["company_name"], "A")

    def test_rejects_unapproved_entity_types(self):
        with self.assertRaises(ValueError):
            records.save_local_record(
                company_id="company-a",
                entity_type="user",
                entity_id="user-1",
                record={"name": "Not allowed"},
            )

    def test_company_scope_is_required(self):
        with self.assertRaises(ValueError):
            records.list_local_records(company_id="", entity_type="client")


if __name__ == "__main__":
    unittest.main()
