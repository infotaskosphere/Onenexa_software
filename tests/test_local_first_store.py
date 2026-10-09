"""Unit tests for the durable local-first sync outbox."""

import os
import tempfile
import unittest
from pathlib import Path

from backend import local_first_store as store


class LocalFirstStoreTests(unittest.TestCase):
    def setUp(self):
        self._temporary_directory = tempfile.TemporaryDirectory()
        self._previous_data_dir = os.environ.get("ONENEXA_DATA_DIR")
        os.environ["ONENEXA_DATA_DIR"] = self._temporary_directory.name
        store.initialize_local_store()

    def tearDown(self):
        if self._previous_data_dir is None:
            os.environ.pop("ONENEXA_DATA_DIR", None)
        else:
            os.environ["ONENEXA_DATA_DIR"] = self._previous_data_dir
        self._temporary_directory.cleanup()

    def test_store_is_created_in_configured_local_directory(self):
        path = store.initialize_local_store()
        self.assertEqual(path, Path(self._temporary_directory.name) / "onenexa-local.db")
        self.assertTrue(path.exists())

    def test_outbox_persists_payload_and_scopes_by_company(self):
        operation_id = store.enqueue_change(
            company_id="company-a",
            entity_type="client",
            entity_id="client-1",
            operation="create",
            payload={"name": "Example Client"},
        )
        store.enqueue_change(
            company_id="company-b",
            entity_type="client",
            entity_id="client-2",
            operation="update",
            payload={"name": "Other Client"},
        )

        changes = store.get_pending_changes(company_id="company-a")
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["operation_id"], operation_id)
        self.assertEqual(changes[0]["payload"], {"name": "Example Client"})

    def test_repeated_operation_id_is_idempotent(self):
        kwargs = {
            "company_id": "company-a",
            "entity_type": "task",
            "entity_id": "task-1",
            "operation": "update",
            "payload": {"title": "Prepare filing"},
            "operation_id": "stable-operation-id",
        }
        store.enqueue_change(**kwargs)
        store.enqueue_change(**kwargs)
        self.assertEqual(len(store.get_pending_changes()), 1)

    def test_sync_acknowledgement_and_retry_status(self):
        store.enqueue_change(
            company_id="company-a",
            entity_type="task",
            entity_id="task-1",
            operation="update",
            payload={"title": "Updated"},
        )
        change = store.get_pending_changes()[0]
        store.record_sync_error([change["id"]], "Temporary network error")
        status = store.get_sync_status("company-a")
        self.assertEqual(status["pending"], 1)
        self.assertEqual(status["retrying"], 1)

        self.assertEqual(store.mark_changes_synced([change["id"]]), 1)
        self.assertEqual(store.get_sync_status("company-a")["pending"], 0)

    def test_cursor_round_trip(self):
        store.save_sync_cursor("company-a", "cursor-123")
        self.assertEqual(store.get_sync_cursor("company-a"), "cursor-123")

    def test_invalid_operations_are_rejected(self):
        with self.assertRaises(ValueError):
            store.enqueue_change(
                company_id="company-a",
                entity_type="task",
                entity_id="task-1",
                operation="upsert",
                payload={},
            )

    def test_company_id_is_required(self):
        with self.assertRaises(ValueError):
            store.enqueue_change(
                company_id="",
                entity_type="task",
                entity_id="task-1",
                operation="create",
                payload={},
            )


if __name__ == "__main__":
    unittest.main()
