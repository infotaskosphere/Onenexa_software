"""Shared master data policy for commercial tenants.

Company, Clients and Users are *master data*. They are created and managed in
Admin > Master Data and are then consumed by every module (Invoicing, Tasks,
Compliance, Leads, HRMS, ...). Using that data must never depend on whether
the licensee also bought the Records module (the Records module only owns the
*Records pages*: DSC, Documents, Passwords, Client Approvals, WhatsApp Hub...).

This file is pure path/method classification (no database, no FastAPI), so it
is trivial to unit-test. The licence / permission decision itself stays in
``commercial_module_guard`` - it calls the two functions below and then applies
its normal "is any licensed page selected for this user?" check.

Two tiers:

* ``shared_master_data_kind``  - any signed-in tenant user who can use at least
  one licensed page: read shared master data, add a client (quick add) and use
  the document auto-fill parsers.  The route handlers still enforce per-user
  visibility, and non-approvers' new clients are created as "pending".

* ``admin_master_data_kind``   - tenant administrators only: everything above
  plus full client management used by Admin > Master Data (update, delete, bulk
  import, approve / reject).

Everything else under ``/clients`` (merge, Drive link, birthday wishes, activity
timeline, service expiries...) is deliberately NOT here: those are Records
features and stay behind the Records licence.
"""
from __future__ import annotations

import re
from typing import Optional

# Document auto-fill helpers used by "Quick Add Client" and Master Data.
_CLIENT_PARSE_POST = frozenset(
    {
        "/clients/parse-multi-documents",
        "/clients/parse-pdf",
        "/clients/parse-excel-row",
        "/clients/parse-mds-excel",
    }
)

_COMPANY_READ = frozenset({"/companies", "/companies/list"})

_CLIENT_ONE_SEGMENT = re.compile(r"^/clients/[^/]+$")
_CLIENT_APPROVAL_ACTION = re.compile(r"^/clients/[^/]+/(approve|reject)$")


def _normalize(path: str) -> str:
    p = (path or "").split("?", 1)[0].strip()
    if p == "/api" or p.startswith("/api/"):
        p = p[4:] or "/"
    if len(p) > 1:
        p = p.rstrip("/")
    return p


def shared_master_data_kind(method: str, path: str) -> Optional[str]:
    """Return 'clients' | 'users' | 'companies' for shared master-data calls."""
    m = (method or "GET").upper()
    p = _normalize(path)

    if m == "GET":
        if p == "/clients" or p.startswith("/clients/"):
            return "clients"
        if p == "/users":
            return "users"
        if p in _COMPANY_READ:
            return "companies"
        return None

    if m == "POST" and (p == "/clients" or p in _CLIENT_PARSE_POST):
        return "clients"

    return None


def admin_master_data_kind(method: str, path: str) -> Optional[str]:
    """Shared calls plus the client-management calls used by Admin > Master Data."""
    kind = shared_master_data_kind(method, path)
    if kind:
        return kind

    m = (method or "GET").upper()
    p = _normalize(path)

    if m == "POST" and p == "/clients/import":
        return "clients"
    if m in ("PUT", "DELETE") and _CLIENT_ONE_SEGMENT.match(p):
        return "clients"
    if m == "POST" and _CLIENT_APPROVAL_ACTION.match(p):
        return "clients"
    return None
