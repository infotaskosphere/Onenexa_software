import pytest
import os

os.environ["EMAIL_ENCRYPT_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
os.environ["PASSWORD_REPO_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
os.environ["JWT_SECRET"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

def test_commercial_console_api_routes():
    from backend.commercial_console_api import router
    paths = [r.path for r in router.routes]
    assert "/api/commercial-console/system-health" in paths
    assert "/api/commercial-console/analytics" in paths
    assert "/api/commercial-console/activity" in paths
    assert "/api/commercial-console/omni-settings" in paths
    assert "/api/commercial-console/domains" in paths
    assert "/api/commercial-console/plans" in paths


def test_commercial_console_rejects_licensee_admin():
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.commercial_console_api import require_commercial_admin

    tenant_admin = SimpleNamespace(
        email="tenant-admin@example.com",
        role="admin",
        company_id="tenant-company",
        license_id="tenant-license",
        commercial_customer_id="tenant-customer",
    )

    try:
        require_commercial_admin(tenant_admin)
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Commercial Console must reject tenant admins")
