"""Shared accounting request models and bulk-import worker used by the live accounting router."""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, Field

from backend.dependencies import db


class OpeningBalanceLine(BaseModel):
    account_id: str
    debit: float = 0.0
    credit: float = 0.0


class OpeningBalanceRequest(BaseModel):
    company_id: str = ""
    fy: str
    date: str
    lines: List[OpeningBalanceLine]


class MatchRequest(BaseModel):
    statement_id: str
    row_id: str
    entry_id: str
    line_id: str = ""


class FixedAssetRequest(BaseModel):
    company_id: str = ""
    name: str
    purchase_date: str
    cost: float
    salvage_value: float = 0.0
    useful_life_years: int = 5
    method: str = "straight_line"
    asset_account_id: str = ""
    depreciation_account_id: str = ""


class TDSTCSEntry(BaseModel):
    company_id: str = ""
    entry_date: str
    party_name: str
    party_pan: str = ""
    section: str
    base_amount: float
    tds_rate: float
    tds_amount: float
    payment_type: str = "tds"
    status: str = "deducted"
    challan_no: str = ""


class BulkJournalLine(BaseModel):
    account_id: str
    debit: float = 0.0
    credit: float = 0.0
    memo: str = ""


class BulkJournalEntry(BaseModel):
    entry_date: str
    narration: str
    ref_no: str = ""
    source: str = "bulk_import"
    lines: List[BulkJournalLine]
    idempotency_key: str = ""


class BulkImportRequest(BaseModel):
    company_id: str = ""
    fy: str = ""
    entries: List[BulkJournalEntry]


def _round2(value: float) -> float:
    return round(float(value or 0), 2)


async def _run_bulk_import(
    job_id: str,
    company_id: str,
    fy: str,
    entries: list,
    posted_by: str,
):
    """Process bulk journal entries one by one with idempotency protection."""
    done = skipped = errors = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for entry in entries:
        try:
            debit = _round2(sum(float(line.get("debit") or 0) for line in entry["lines"]))
            credit = _round2(sum(float(line.get("credit") or 0) for line in entry["lines"]))
            if abs(debit - credit) > 0.05:
                errors += 1
                continue

            idempotency_key = (
                entry.get("idempotency_key")
                or f"bulk_{company_id}_{entry['entry_date']}_{entry['narration'][:30]}"
            )
            if await db.journal_entries.find_one({"idempotency_key": idempotency_key}):
                skipped += 1
                continue

            entry_id = str(uuid.uuid4())
            await db.journal_entries.insert_one({
                "id": entry_id,
                "company_id": company_id,
                "fy": fy,
                "entry_date": entry["entry_date"],
                "narration": entry["narration"],
                "ref_no": entry.get("ref_no", ""),
                "source": entry.get("source", "bulk_import"),
                "idempotency_key": idempotency_key,
                "posted_by": posted_by,
                "created_at": now_iso,
            })

            for line in entry["lines"]:
                if not (line.get("debit") or line.get("credit")):
                    continue
                await db.journal_lines.insert_one({
                    "id": str(uuid.uuid4()),
                    "entry_id": entry_id,
                    "company_id": company_id,
                    "account_id": line["account_id"],
                    "debit": _round2(line.get("debit")),
                    "credit": _round2(line.get("credit")),
                    "entry_date": entry["entry_date"],
                    "memo": line.get("memo", ""),
                    "created_at": now_iso,
                })
            done += 1
        except Exception as exc:
            errors += 1
            import logging
            logging.getLogger(__name__).warning(
                "[bulk_import] %s error: %s", job_id, exc
            )

    await db.bulk_import_jobs.update_one(
        {"job_id": job_id},
        {"$set": {
            "status": "done",
            "done": done,
            "skipped": skipped,
            "errors": errors,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
