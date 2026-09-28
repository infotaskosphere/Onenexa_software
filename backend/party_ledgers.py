"""
Party Ledgers — automatic Customer/Vendor sub-ledgers under the Accounts
Receivable / Accounts Payable control accounts (Tally / Zoho Books /
QuickBooks / ERPNext style).

- Every customer/vendor gets its own Chart-of-Accounts ledger the first time
  they're posted against — no manual ledger creation.
- `party_ledgers` collection is the dedup/identity map (by external id,
  GSTIN, PAN, email, mobile, or normalized name) so the same party never
  gets two ledgers.
- Renaming a party renames its ledger in place — same internal id (`id` in
  party_ledgers, `account_id`/CoA id never changes), so history stays intact.
- Control Account balance = sum of that party_type's ledger balances is
  verified by /control-accounts/verify.
"""

import re
import uuid
from datetime import datetime, timezone, date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.accounting.models_party_ledgers import RenameRequest

from backend.models import User
from backend.accounting_core import ensure_default_chart_of_accounts

router = APIRouter(tags=["Party Ledgers"])

CONTROL_CODE = {"customer": "1100", "vendor": "2000"}
CONTROL_LABEL = {"customer": "Accounts Receivable", "vendor": "Accounts Payable"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _clean_mobile(m: str) -> Optional[str]:
    digits = re.sub(r"\D", "", m or "")
    return digits[-10:] if len(digits) >= 10 else (digits or None)


async def get_or_create_party_account(
    company_id: str, party_type: str, name: str,
    external_id: Optional[str] = None, gstin: Optional[str] = None,
    pan: Optional[str] = None, email: Optional[str] = None,
    mobile: Optional[str] = None, created_by: str = "system",
) -> Optional[dict]:
    """Returns {"account_id", "account_name", "party_id"} for this party's
    ledger, creating it (and the underlying Chart-of-Accounts sub-ledger)
    on first use. Safe no-op (returns None) if no usable name is given."""
    name = (name or "").strip()
    if not name or party_type not in CONTROL_CODE:
        return None
    gstin = (gstin or "").strip().upper() or None
    pan = (pan or "").strip().upper() or None
    email = (email or "").strip().lower() or None
    mobile = _clean_mobile(mobile)

    base = {"company_id": company_id, "party_type": party_type}
    party = None
    for key, val in (("external_id", external_id), ("gstin", gstin), ("pan", pan),
                      ("email", email), ("mobile", mobile)):
        if val and not party:
            party = await db.party_ledgers.find_one({**base, key: val})
    if not party:
        party = await db.party_ledgers.find_one({**base, "name_key": _norm(name)})

    now = datetime.now(timezone.utc).isoformat()
    if party:
        updates = {}
        for key, val in (("external_id", external_id), ("gstin", gstin), ("pan", pan),
                          ("email", email), ("mobile", mobile)):
            if val and not party.get(key):
                updates[key] = val
        if updates:
            updates["updated_at"] = now
            await db.party_ledgers.update_one({"id": party["id"]}, {"$set": updates})
        return {"account_id": party["account_id"], "account_name": party["name"], "party_id": party["id"]}

    await ensure_default_chart_of_accounts(company_id, created_by)
    parent_code = CONTROL_CODE[party_type]
    acct_type = "asset" if party_type == "customer" else "liability"
    sub_type = "accounts_receivable" if party_type == "customer" else "accounts_payable"
    party_id = str(uuid.uuid4())
    account_id = str(uuid.uuid4())
    code = f"{parent_code}-{party_id[:8]}"
    await db.chart_of_accounts.insert_one({
        "id": account_id, "company_id": company_id, "code": code, "name": name,
        "type": acct_type, "sub_type": sub_type, "is_system": False, "is_active": True,
        "is_party_ledger": True, "party_ledger_id": party_id, "party_type": party_type,
        "parent_code": parent_code, "created_by": created_by, "created_at": now,
    })
    await db.party_ledgers.insert_one({
        "id": party_id, "company_id": company_id, "party_type": party_type,
        "external_id": external_id, "name": name, "name_key": _norm(name),
        "gstin": gstin, "pan": pan, "email": email, "mobile": mobile,
        "account_id": account_id, "created_by": created_by, "created_at": now, "updated_at": now,
    })
    return {"account_id": account_id, "account_name": name, "party_id": party_id}


async def rename_party_ledger(company_id: str, party_type: str, party_id: str, new_name: str) -> bool:
    """Renames a party's ledger in place — same id/account_id/UUID, so all
    prior journal lines and reports still resolve to the same ledger."""
    new_name = (new_name or "").strip()
    if not new_name:
        return False
    party = await db.party_ledgers.find_one({"id": party_id, "company_id": company_id, "party_type": party_type})
    if not party:
        return False
    now = datetime.now(timezone.utc).isoformat()
    await db.party_ledgers.update_one(
        {"id": party_id}, {"$set": {"name": new_name, "name_key": _norm(new_name), "updated_at": now}}
    )
    await db.chart_of_accounts.update_one({"id": party["account_id"]}, {"$set": {"name": new_name}})
    return True


def _perm_view(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_view_journal_entries") or perms.get("can_view_accounting_reports"))


@router.get("/party-ledgers")
async def list_party_ledgers(
    company_id: str = Query(""), party_type: str = Query(""), current_user: User = Depends(get_current_user)
):
    if not _perm_view(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"company_id": company_id}
    if party_type:
        q["party_type"] = party_type
    return await db.party_ledgers.find(q, {"_id": 0}).sort("name", 1).to_list(5000)


@router.get("/party-ledgers/{party_type}/{party_id}")
async def get_party_ledger(party_type: str, party_id: str, current_user: User = Depends(get_current_user)):
    if not _perm_view(current_user):
        raise HTTPException(403, "Access denied.")
    party = await db.party_ledgers.find_one({"id": party_id, "party_type": party_type}, {"_id": 0})
    if not party:
        raise HTTPException(404, "Ledger not found.")

    lines = await db.journal_lines.find({"account_id": party["account_id"]}, {"_id": 0}).sort("entry_date", 1).to_list(20000)
    balance = round(sum(float(l.get("debit") or 0) - float(l.get("credit") or 0) for l in lines), 2)
    entry_ids = list({l["entry_id"] for l in lines})
    entries = await db.journal_entries.find({"id": {"$in": entry_ids}}, {"_id": 0}).to_list(len(entry_ids) or 1)
    entry_by_id = {e["id"]: e for e in entries}
    ledger_rows = [
        {
            "date": l.get("entry_date"), "narration": entry_by_id.get(l["entry_id"], {}).get("narration", ""),
            "source": entry_by_id.get(l["entry_id"], {}).get("source", ""),
            "voucher_no": entry_by_id.get(l["entry_id"], {}).get("voucher_no", ""),
            "debit": l.get("debit") or 0, "credit": l.get("credit") or 0, "memo": l.get("memo", ""),
        }
        for l in lines
    ]

    today = date.today()
    ageing = {"0-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    if party_type == "customer":
        coll = db.invoices
        q = {"company_id": party["company_id"], "client_id": party["external_id"]} if party.get("external_id") \
            else {"company_id": party["company_id"], "client_name": party["name"]}
    else:
        coll = db.purchase_invoices
        q = {"company_id": party["company_id"], "supplier_gstin": party["gstin"]} if party.get("gstin") \
            else {"company_id": party["company_id"], "supplier_name": party["name"]}
    docs = await coll.find(q, {"_id": 0}).sort("invoice_date", -1).to_list(2000)
    outstanding = 0.0
    for d in docs:
        due = float(d.get("amount_due") or 0)
        if due <= 0:
            continue
        outstanding += due
        ref_date = d.get("due_date") or d.get("invoice_date")
        try:
            days = (today - datetime.fromisoformat(str(ref_date)[:10]).date()).days
        except Exception:
            days = 0
        bucket = "0-30" if days <= 30 else "31-60" if days <= 60 else "61-90" if days <= 90 else "90+"
        ageing[bucket] += due

    return {
        "party": party, "balance": balance, "outstanding": round(outstanding, 2),
        "ageing": {k: round(v, 2) for k, v in ageing.items()},
        "documents": docs, "ledger": ledger_rows,
    }



@router.put("/party-ledgers/{party_type}/{party_id}/rename")
async def rename_party_ledger_route(
    party_type: str, party_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    if current_user.role != "admin":
        raise HTTPException(403, "Only an admin can rename a ledger.")
    party = await db.party_ledgers.find_one({"id": party_id, "party_type": party_type})
    if not party:
        raise HTTPException(404, "Ledger not found.")
    new_name = (payload.get("name") or "").strip()
    if not new_name:
        raise HTTPException(400, "New name is required.")
    ok = await rename_party_ledger(party["company_id"], party_type, party_id, new_name)
    if not ok:
        raise HTTPException(400, "Rename failed.")
    return {"success": True, "name": new_name}


@router.get("/control-accounts/verify")
async def verify_control_accounts(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Control Account Balance = Sum of all Customer/Vendor Ledgers.
    Any gap is generic (non-party) postings still sitting on the raw
    1100/2000 control account rather than a specific customer/vendor
    ledger — a signal for entries that still need a party attached."""
    if not _perm_view(current_user):
        raise HTTPException(403, "Access denied.")
    results = []
    for party_type, code in CONTROL_CODE.items():
        control_acct = await db.chart_of_accounts.find_one({"company_id": company_id, "code": code}, {"_id": 0, "id": 1})
        control_lines = await db.journal_lines.find({"account_id": control_acct["id"]}, {"_id": 0}).to_list(50000) if control_acct else []
        control_balance = round(sum(float(l.get("debit") or 0) - float(l.get("credit") or 0) for l in control_lines), 2)

        parties = await db.party_ledgers.find({"company_id": company_id, "party_type": party_type}, {"_id": 0, "account_id": 1}).to_list(5000)
        party_account_ids = [p["account_id"] for p in parties]
        party_lines = await db.journal_lines.find({"account_id": {"$in": party_account_ids}}, {"_id": 0}).to_list(200000) if party_account_ids else []
        party_total = round(sum(float(l.get("debit") or 0) - float(l.get("credit") or 0) for l in party_lines), 2)

        results.append({
            "account": CONTROL_LABEL[party_type], "party_type": party_type,
            "unassigned_on_control_account": control_balance,
            "sum_of_party_ledgers": party_total,
            "combined_total": round(control_balance + party_total, 2),
            "fully_migrated": abs(control_balance) < 0.01,
        })
    return results
