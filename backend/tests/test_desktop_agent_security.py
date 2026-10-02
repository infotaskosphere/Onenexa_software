"""Regression tests for Desktop Agent authentication and tenant binding."""

import inspect


def test_desktop_agent_push_handlers_require_current_user():
    from backend import desktop_agent

    for name in (
        "agent_heartbeat",
        "push_activity",
        "push_browser",
        "push_dsc",
        "push_usb",
        "push_productivity",
        "push_system_info",
    ):
        fn = getattr(desktop_agent, name)
        current = inspect.signature(fn).parameters.get("current_user")
        assert current is not None
        assert current.default is not inspect.Parameter.empty


def test_desktop_agent_user_binding_rejects_impersonation():
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.desktop_agent import _validate_agent_user

    with __import__("pytest").raises(HTTPException) as exc:
        _validate_agent_user(
            SimpleNamespace(id="user-a"),
            "user-b",
        )

    assert exc.value.status_code == 403
