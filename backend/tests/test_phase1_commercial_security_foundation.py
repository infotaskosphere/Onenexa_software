"""Phase 1 regression tests: Core identity and commercial module isolation."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend import commercial_module_guard as guard
from backend import commercial_core_isolation as core


def test_users_are_core_not_people_matrix():
    assert guard.module_for_path("/users") == core.CORE_MODULE
    assert guard.module_for_path("/users/123") == core.CORE_MODULE
    assert guard.feature_for_path("/users") == (
        core.CORE_MODULE,
        "can_view_user_page",
    )


def test_core_does_not_require_billable_license_module():
    license_doc = {"modules": []}
    assert guard._licensed_module(core.CORE_MODULE, license_doc) is True


def test_unlicensed_billable_module_remains_blocked():
    license_doc = {"modules": []}
    assert guard._licensed_module("finix", license_doc) is False
    assert guard._licensed_module("taskosphere", license_doc) is False


def test_core_user_permission_is_still_user_governed_for_non_admins():
    user = SimpleNamespace(
        role="staff",
        permissions={"can_view_user_page": False},
    )
    license_doc = {"modules": []}
    assert guard._permission_flag(
        user,
        "can_view_user_page",
        license_doc,
        core.CORE_MODULE,
    ) is False


def test_admin_can_use_core_without_people_matrix():
    user = SimpleNamespace(
        role="admin",
        permissions={},
    )
    license_doc = {"modules": []}
    assert guard._permission_flag(
        user,
        "can_view_user_page",
        license_doc,
        core.CORE_MODULE,
    ) is True
