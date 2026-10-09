"""Tests for device-local OneNexa offline session tokens."""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from backend import local_first_auth as auth


class LocalFirstAuthTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.previous_data_dir = os.environ.get("ONENEXA_DATA_DIR")
        os.environ["ONENEXA_DATA_DIR"] = self.temporary_directory.name

    def tearDown(self):
        if self.previous_data_dir is None:
            os.environ.pop("ONENEXA_DATA_DIR", None)
        else:
            os.environ["ONENEXA_DATA_DIR"] = self.previous_data_dir
        self.temporary_directory.cleanup()

    def test_issued_token_verifies_without_cloud_lookup(self):
        user = SimpleNamespace(
            id="user-1",
            company_id="company-1",
            role="admin",
            permissions={"can_edit_clients": True, "can_delete_data": True},
        )
        issued = auth.issue_local_session(user)
        principal = auth.verify_local_session(issued["offline_token"])
        self.assertEqual(principal.id, "user-1")
        self.assertEqual(principal.company_id, "company-1")
        self.assertEqual(principal.role, "admin")
        self.assertTrue(principal.permissions["can_edit_clients"])
        self.assertEqual(issued["expires_in_seconds"], 72 * 60 * 60)

    def test_token_tampering_is_rejected(self):
        issued = auth.issue_local_session(SimpleNamespace(
            id="user-1", company_id="company-1", role="staff", permissions={}
        ))
        token = issued["offline_token"]
        tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
        with self.assertRaises(HTTPException):
            auth.verify_local_session(tampered)

    def test_expired_token_is_rejected(self):
        user = SimpleNamespace(
            id="user-1", company_id="company-1", role="staff", permissions={}
        )
        with patch.object(auth.time, "time", return_value=1000):
            issued = auth.issue_local_session(user)
        with patch.object(auth.time, "time", return_value=issued["expires_at"]):
            with self.assertRaises(HTTPException):
                auth.verify_local_session(issued["offline_token"])

    def test_user_without_company_cannot_receive_local_session(self):
        with self.assertRaises(HTTPException):
            auth.issue_local_session(SimpleNamespace(
                id="user-1", company_id="", role="staff", permissions={}
            ))


if __name__ == "__main__":
    unittest.main()
