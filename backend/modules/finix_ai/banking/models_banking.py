"""Shared bank-account models and reconciliation helpers used by the live bank router."""

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel

from backend.dependencies import db
from backend.models import User


class BankAccountCreate(BaseModel):
    company_id: str = ""
    bank_name: str
    account_holder: str = ""
    account_number: str = ""
    ifsc: str = ""
    branch: str = ""
    account_type: str = "current"
    opening_balance: float = 0.0
    upi_id: str = ""
    notes: str = ""


def _mask_account_number(acc_no: str) -> str:
    acc_no = re.sub(r"\s+", "", acc_no or "")
    if len(acc_no) <= 4:
        return acc_no
    return "•" * (len(acc_no) - 4) + acc_no[-4:]


def normalize_description(desc: str) -> str:
    if not desc:
        return ""
    value = desc.lower()
    value = re.sub(r"\d+", " ", value)
    value = re.sub(r"[\/\-\_\,\.\:\;\#\*\+\=\[\]\(\)\{\}\&]", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


class ManualMatchInput(BaseModel):
    matched_type: str
    matched_id: str
    matched_label: str = ""
    post_journal: bool = True
    confidence: Optional[float] = None
    reason: str = ""


class UnmatchInput(BaseModel):
    reason: str = ""


class AIAutoMatchInput(BaseModel):
    bank_account_id: Optional[str] = None


class IgnoreInput(BaseModel):
    ignored: bool = True


class BankRulePayload(BaseModel):
    name: str
    pattern: str
    category: str
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    priority: int = 10


class ManualReconcilePayload(BaseModel):
    matched_record_id: Optional[str] = None
    matched_record_type: Optional[str] = None
    category: Optional[str] = None
    coa_account_id: Optional[str] = None
    company_id: str = ""


class BackfillSuspenseInput(BaseModel):
    company_id: Optional[str] = None


async def _log_recon_audit(
    txn: dict,
    action: str,
    current_user: User,
    previous_match: Optional[dict] = None,
    new_match: Optional[dict] = None,
    confidence: Optional[float] = None,
    reason: str = "",
):
    """Write a reconciliation audit entry without blocking the match action."""
    from backend.bank_ai.bank_storage import BankStorage

    record = {
        "bank_transaction_id": txn.get("id"),
        "bank_account_id": txn.get("bank_account_id"),
        "action": action,
        "match_type": "manual",
        "transaction_details": {
            "date": txn.get("date"),
            "narration": txn.get("description"),
            "reference": txn.get("reference"),
            "amount": txn.get("debit") or txn.get("credit"),
            "type": "debit" if txn.get("debit") else "credit",
        },
        "previous_match": previous_match,
        "new_match": new_match,
        "confidence": confidence,
        "reasons": [reason] if reason else [f"{action.capitalize()} by user."],
        "reason": reason,
        "matched_by_user": current_user.id,
        "performed_by_name": (
            getattr(current_user, "name", None)
            or getattr(current_user, "email", None)
        ),
    }

    if action == "matched":
        record["matched_by"] = current_user.id
        record["matched_on"] = datetime.now(timezone.utc).isoformat()
    elif action == "edited":
        record["edited_by"] = current_user.id
        record["edited_on"] = datetime.now(timezone.utc).isoformat()
    elif action == "unmatched":
        record["unmatched_by"] = current_user.id
        record["unmatched_on"] = datetime.now(timezone.utc).isoformat()

    try:
        await BankStorage.log_audit_trail(record)
    except Exception:
        pass


async def auto_match_similar_transactions(
    company_id: str,
    description: str,
    matched_type: str,
    matched_id: str,
    matched_label: str,
    post_journal: bool,
    user_id: str,
):
    """Suggest the same match for other unmatched transactions with similar narration."""
    del post_journal, user_id
    target = normalize_description(description)
    if not target:
        return

    unmatched = await db.bank_transactions.find({
        "company_id": company_id,
        "matched_type": {"$in": [None, ""]},
    }).to_list(100000)

    for txn in unmatched:
        candidate = normalize_description(txn.get("description", ""))
        similar = (
            candidate == target
            or (
                len(candidate) > 4
                and len(target) > 4
                and (candidate in target or target in candidate)
            )
        )
        if similar:
            await db.bank_transactions.update_one(
                {"id": txn["id"]},
                {"$set": {
                    "suggested_match": {
                        "matched_type": matched_type,
                        "matched_id": matched_id,
                        "matched_label": matched_label,
                        "pending_approval": True,
                    }
                }},
            )
