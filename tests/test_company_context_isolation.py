"""Owner / licensee / Commercial Console company-context isolation."""
import asyncio
from types import SimpleNamespace

import pytest


def _match(q, d):
    if not q:
        return True
    if "$and" in q and not all(_match(i, d) for i in q["$and"]):
        return False
    if "$or" in q and not any(_match(i, d) for i in q["$or"]):
        return False
    for k, v in q.items():
        if k in ("$and", "$or"):
            continue
        a = d.get(k)
        if isinstance(v, dict):
            if "$in" in v and a not in v["$in"]:
                return False
            if "$nin" in v and a in v["$nin"]:
                return False
        elif a != v:
            return False
    return True


class Cur:
    def __init__(self, rows): self.rows = rows
    def sort(self, f, d=1): self.rows.sort(key=lambda r: str(r.get(f) or "")); return self
    async def to_list(self, n=None): return [dict(r) for r in self.rows]


class Col:
    def __init__(self, rows): self.rows = rows
    def find(self, q=None, proj=None): return Cur([r for r in self.rows if _match(q or {}, r)])
    async def find_one(self, q=None, proj=None):
        return next((dict(r) for r in self.rows if _match(q or {}, r)), None)
    async def update_one(self, q, u):
        for r in self.rows:
            if _match(q, r):
                r.update(u.get("$set", {})); return


class DB:
    def __init__(self, companies, users, licenses):
        self.companies, self.users, self.commercial_licenses = Col(companies), Col(users), Col(licenses)


OWNER = SimpleNamespace(id="owner-1", email="info.taskosphere@gmail.com", role="admin",
                        company_id=None, commercial_customer_id=None, license_id=None)
LIC_ADMIN = SimpleNamespace(id="u-admin", email="manthan.mda@gmail.com", role="admin",
                            company_id="cust-1", commercial_customer_id="cust-1", license_id="lic-1")
LIC_USER = SimpleNamespace(id="u-mgr", email="info.msadvisory@gmail.com", role="manager",
                           company_id="cust-1", commercial_customer_id="cust-1", license_id="lic-1")


@pytest.fixture
def q(monkeypatch):
    from backend import quotations
    companies = [
        {"id": "own-a", "name": "Owner Firm A", "created_by": "owner-1"},
        {"id": "own-b", "name": "Owner Firm B", "created_by": "owner-1", "commercial_customer_id": ""},
        # license-generated record (legacy: company id == customer id)
        {"id": "cust-1", "name": "Manthan Desai", "source": "commercial-license",
         "commercial_customer_id": "cust-1", "license_id": "lic-1"},
        # legacy companies created by the licensee's admin, NO markers
        {"id": "legacy-1", "name": "Manthan Desai And Associates", "created_by": "u-admin"},
        {"id": "legacy-2", "name": "Manthan Desai And Associates 2", "created_by": "u-admin"},
        # another tenant
        {"id": "cust-2", "name": "Other Licensee", "source": "commercial-license",
         "commercial_customer_id": "cust-2", "license_id": "lic-2"},
    ]
    users = [
        {"id": "u-admin", "commercial_customer_id": "cust-1"},
        {"id": "u-mgr", "commercial_customer_id": "cust-1"},
        {"id": "u-other", "commercial_customer_id": "cust-2"},
        {"id": "owner-1"},
    ]
    licenses = [{"id": "lic-1", "customer_id": "cust-1"}, {"id": "lic-2", "customer_id": "cust-2"}]
    fake = DB(companies, users, licenses)
    monkeypatch.setattr(quotations, "_tenant_raw_db", lambda: fake)
    monkeypatch.setattr(quotations, "is_platform_owner", lambda u: u.id == "owner-1")

    async def _bank(c): return c
    monkeypatch.setattr(quotations, "_hydrate_company_bank", _bank)
    return quotations


def names(rows): return sorted(r["id"] for r in rows)


def test_platform_owner_sees_only_own_companies(q):
    rows = asyncio.run(q.get_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_owner_dropdown_never_exposes_licensee_companies(q):
    rows = asyncio.run(q.list_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_licensee_admin_sees_own_tenant_incl_legacy_unmarked(q):
    rows = asyncio.run(q.get_companies(LIC_ADMIN))
    assert names(rows) == ["cust-1", "legacy-1", "legacy-2"]
    assert "cust-2" not in names(rows) and "own-a" not in names(rows)


def test_licensee_user_sees_only_attached_company(q):
    rows = asyncio.run(q.get_companies(LIC_USER))
    assert names(rows) == ["cust-1"]


def test_legacy_records_are_stamped_and_then_hidden_from_owner(q):
    asyncio.run(q.get_companies(LIC_ADMIN))          # heals markers
    rows = asyncio.run(q.get_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_owner_cannot_open_licensee_company_by_id(q):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        asyncio.run(q.get_company("cust-1", OWNER))
    assert e.value.status_code == 404


def test_licensee_cannot_open_other_tenant_company(q):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(q.get_company("cust-2", LIC_ADMIN))
    assert asyncio.run(q.get_company("cust-1", LIC_ADMIN))["id"] == "cust-1"


def test_owner_marker_companies_stay_visible_to_owner(q):
    q._tenant_raw_db().companies.rows.append(
        {"id": "own-c", "name": "Owner Practice", "created_by": "owner-1",
         "commercial_customer_id": "platform-owner", "license_id": "platform-owner-license"}
    )
    assert "own-c" in names(asyncio.run(q.get_companies(OWNER)))
    assert "own-c" not in names(asyncio.run(q.get_companies(LIC_ADMIN)))


# ---- one test per row of the agreed visibility matrix -------------------

def test_matrix_licensee_user_sees_only_attached_company_even_if_creator(q):
    q._tenant_raw_db().companies.rows.append(
        {"id": "mgr-made", "name": "Made by manager", "created_by": "u-mgr",
         "commercial_customer_id": "cust-1"}
    )
    assert names(asyncio.run(q.get_companies(LIC_USER))) == ["cust-1"]
    assert names(asyncio.run(q.list_companies(LIC_USER))) == ["cust-1"]


def test_matrix_admin_includes_auto_generated_license_company(q):
    assert "cust-1" in names(asyncio.run(q.get_companies(LIC_ADMIN)))


def test_matrix_licensee_blocked_from_other_licensee_and_owner_companies(q):
    from fastapi import HTTPException
    for cid in ("cust-2", "own-a", "own-b"):
        for user in (LIC_ADMIN, LIC_USER):
            with pytest.raises(HTTPException):
                asyncio.run(q.get_company(cid, user))
    listed = names(asyncio.run(q.get_companies(LIC_ADMIN)))
    assert not ({"cust-2", "own-a", "own-b"} & set(listed))


def test_matrix_licensee_cannot_edit_or_delete_foreign_company(q):
    from fastapi import HTTPException
    for cid in ("cust-2", "own-a"):
        with pytest.raises(HTTPException):
            asyncio.run(q.update_company(cid, {"name": "x"}, LIC_ADMIN))
        with pytest.raises(HTTPException):
            asyncio.run(q.delete_company(cid, LIC_ADMIN))


def test_matrix_owner_cannot_edit_or_delete_licensee_company_from_operational_api(q):
    from fastapi import HTTPException
    for cid in ("cust-1", "cust-2"):
        with pytest.raises(HTTPException):
            asyncio.run(q.update_company(cid, {"name": "x"}, OWNER))
        with pytest.raises(HTTPException):
            asyncio.run(q.delete_company(cid, OWNER))


def test_matrix_user_without_tenant_link_fails_closed(q):
    stray = SimpleNamespace(id="stray", email="x@y.z", role="manager",
                            company_id="", commercial_customer_id="", license_id="")
    assert names(asyncio.run(q.get_companies(stray))) == []


def test_matrix_commercial_console_directory_still_reaches_licensee_companies():
    from backend.commercial_company_master import _is_licensee_company
    assert _is_licensee_company({"id": "cust-1", "source": "commercial-license",
                                 "commercial_customer_id": "cust-1"})
