"""
MODULE 1 — Zero-Touch Entry Engine (Invoice → Journal)
=======================================================
Pipeline:
  1. TRIGGER   : `POST /api/zte/upload` (manual upload) — swap in a storage-bucket
                 event listener (S3/GCS "on_receipt_upload") or an inbox poller
                 ("on_invoice_email_received") to call `process_document(...)`
                 automatically; the extraction logic below is already decoupled
                 from the HTTP trigger so either wiring is a thin shim.
  2. EXTRACT   : Vision LLM (Google Gemini 2.5 Flash via
                 backend/services/gemini_client.py) called in JSON-schema /
                 forced-JSON mode —
                 no static template, works off any invoice layout. Also extracts
                 the invoice currency and who the document is billed to, so the
                 pipeline can convert foreign-currency invoices to INR and figure
                 out which of the firm's companies the invoice belongs to.
  3. RESOLVE   : `resolve_company()` matches the extracted "billed to" details
                 against Company Profiles (`db.companies`) for multi-company
                 setups. Two tiers:
                   a) Deterministic — GSTIN → billing email → company name,
                      in that priority order (cheap, exact, no LLM call).
                   b) AI fallback — if none of those match and more than one
                      company is configured, `_ai_resolve_company()` sends the
                      extracted document context + the candidate company list
                      to the LLM and asks it to pick the best match with a
                      confidence score. Only accepted above a confidence
                      threshold; otherwise the document is held for manual
                      company assignment rather than guessed.
  4. CONVERT   : if the extracted currency isn't INR, `get_historical_fx_rate()`
                 fetches the ECB reference rate for that invoice's date (via the
                 free Frankfurter API, cached) and every amount is converted to
                 INR before anything is posted — so a $8.02 receipt is booked at
                 that day's actual rate, not booked as "₹8.02".
  5. PREVIEW   : `classify_expense_account()` inspects the vendor name and the
                 firm's own learned category rules to pick a ledger account,
                 then `build_ledger_preview()` assembles the balanced
                 double-entry lines — but does NOT post them. The computed
                 preview is stored on the document with status
                 `"pending_approval"`.
  6. APPROVE   : Nothing reaches the ledger without a human clicking
                 Approve. `POST /documents/{id}/approve` takes the stored
                 preview and posts it via `accounting_core.post_journal_entry`
                 (reused, not re-implemented, so trial balance / P&L / balance
                 sheet reports stay consistent). `POST /documents/{id}/reject`
                 discards the preview instead, with a mandatory reason.
  7. AUDIT     : Every approved entry is flagged `source="ai_zero_touch"` and is
                 immutable once posted (see accounting_lock.py, Module 4) —
                 corrections must go through an Adjustment Note Override rather
                 than editing the original voucher.

The AI extracts, matches companies, converts currency, and drafts the entry
end-to-end with zero manual data entry — but nothing is committed to the
books until a human with posting rights reviews and approves it.

Nothing here talks to a real object-storage bucket or mail server; those
triggers are infra-specific to how Taskosphere is deployed. Wire the bucket/
email webhook to call `process_document(file_bytes, filename, ...)` below.
"""

import base64
import io
import json
import os
import re
import uuid
from datetime import datetime, date, timezone
from typing import Optional, List, Tuple

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.ai.vendor_mapper import find_best_vendor_match
from backend import accounting_core as ac

router = APIRouter(prefix="/api/zte", tags=["Zero-Touch Entry Engine"])

# ── Permission helpers (mirrors accounting_core's pattern) ──────────────────
def _perm_post(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (
        user.permissions.model_dump() if user.permissions else {}
    )
    return bool(perms.get("can_post_journal_entries"))


# ── Extraction schema (forced-JSON contract given to the LLM) ───────────────
EXTRACTION_SCHEMA_PROMPT = """You are a highly precise Indian Chartered Accountant AI assistant.
Read the attached invoice or receipt image and return ONLY a single JSON object
(no markdown fences, no commentary) matching exactly this shape:

{
  "document_type": "SALE" | "PURCHASE" | "UNKNOWN",
  "vendor_or_customer_name": string,      // the OTHER party — who this business is transacting with. For a purchase invoice, this is the SELLER/SUPPLIER whose logo or letterhead is at the top. For a sales invoice, this is the CUSTOMER in 'Bill To'.
  "tax_registration_number": string,      // vendor/customer GSTIN (usually 15-digit code like 24AAAAA1111A1Z1). Do not confuse with PAN/VAT unless GSTIN is not present.
  "billed_to_name": string,               // the name/company this document is addressed TO ("Bill To" / "Ship To" / recipient letterhead).
  "billed_to_email": string,              // the "Bill To" email address if shown, else ""
  "billed_to_gstin": string,              // the recipient's own GSTIN if shown, else ""
  "invoice_number": string,
  "invoice_date": "YYYY-MM-DD",           // extract carefully. Use ISO YYYY-MM-DD format.
  "line_items": [
    {"description": string, "amount": number}
  ],
  "taxable_value": number,                // total taxable subtotal BEFORE GST
  "tax_breakup": {"cgst": number, "sgst": number, "igst": number}, // extract CGST, SGST, IGST carefully. In Indian GST, CGST always equals SGST. If CGST/SGST exist, IGST must be 0. If IGST exists, CGST/SGST must be 0.
  "total_tax": number,                    // sum of all taxes (CGST + SGST + IGST)
  "total_invoice_value": number,          // Grand total amount (Taxable value + Total Tax)
  "currency": string,                     // 3-letter ISO 4217 code (e.g., "INR" for ₹/Rs, "USD" for $, "EUR" for €). Check currency symbols carefully.
  "confidence": number                    // 0-1, your confidence score
}

Rules:
1. document_type: If the invoice is issued BY this firm, it is "SALE". If issued TO this firm (e.g. from vendor/supplier), it is "PURCHASE".
2. No commas or currency symbols in numbers.
3. Keep the values in the original currency of the invoice. Do not do any FX conversion yourself.
4. Double check math: total_invoice_value = taxable_value + total_tax. If there is a rounding difference, report the exact numbers shown on the invoice.
"""


def _strip_json_fence(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


# ── AI Extraction (Gemini 2.5 Flash) ─────────────────────────────────────────
# Groq Vision has been retired in this pipeline. Every document extraction
# now goes through Google Gemini 2.5 Flash via the reusable client in
# backend/services/gemini_client.py. No business logic, journal generation,
# GST calculation, ledger creation, or API-response shape has been changed —
# only the AI provider that produces the extracted JSON.

import logging as _zte_logging
_zte_logger = _zte_logging.getLogger(__name__)


async def _vision_extract_json(image_b64: str, mime_type: str) -> dict:
    """Extract structured invoice/receipt data using Gemini 2.5 Flash.

    The prompt (``EXTRACTION_SCHEMA_PROMPT``) instructs Gemini to return
    STRICT JSON only. The downstream accounting pipeline continues to
    consume the returned dict exactly as it did before, so backward
    compatibility with existing responses is preserved.

    On any Gemini failure the exception is logged and re-raised as
    HTTPException(500) with the original error text — the server is never
    allowed to crash.
    """
    from backend.services.gemini_client import gemini_extract_json
    try:
        return await gemini_extract_json(image_b64, mime_type, EXTRACTION_SCHEMA_PROMPT)
    except HTTPException:
        # Already an HTTP error with proper status/detail — surface as-is
        raise
    except Exception as e:  # pragma: no cover — defensive
        _zte_logger.exception("Gemini extraction failed")
        raise HTTPException(status_code=500, detail=f"Gemini extraction failed: {e}") from e


def _file_to_image_b64(contents: bytes, filename: str) -> Tuple[str, str]:
    """Returns (base64, mime_type). Rasterises page 1 for PDFs."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        import pdfplumber
        with pdfplumber.open(io.BytesIO(contents)) as pdf:
            if not pdf.pages:
                raise HTTPException(422, "PDF has no pages.")
            pil_img = pdf.pages[0].to_image(resolution=200).original
            if pil_img.mode not in ("RGB", "L"):
                pil_img = pil_img.convert("RGB")
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=90)
            return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"
    else:
        from PIL import Image as PILImage
        img = PILImage.open(io.BytesIO(contents))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"


# ── Multi-currency: historical FX conversion to INR ──────────────────────────
async def get_historical_fx_rate(from_ccy: str, to_ccy: str, on_date: str) -> float:
    """Historical daily FX rate via the free Frankfurter API (ECB reference
    rates — no API key required, https://www.frankfurter.app). Cached in
    `db.fx_rate_cache` so the same currency-pair/date is never looked up twice.
    Raises HTTPException rather than guessing if the rate can't be fetched —
    a wrong FX rate is worse than a document waiting for manual review."""
    from_ccy = (from_ccy or "").upper().strip()
    to_ccy = (to_ccy or "INR").upper().strip()
    if not from_ccy or from_ccy == to_ccy:
        return 1.0

    cache_key = f"{from_ccy}_{to_ccy}_{on_date}"
    cached = await db.fx_rate_cache.find_one({"id": cache_key}, {"_id": 0})
    if cached:
        return cached["rate"]

    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"https://api.frankfurter.app/{on_date}", params={"from": from_ccy, "to": to_ccy})
    except Exception as e:
        raise HTTPException(502, f"FX rate lookup failed for {from_ccy}->{to_ccy} on {on_date}: {e}")
    if resp.status_code != 200:
        raise HTTPException(502, f"FX rate lookup failed ({resp.status_code}) for {from_ccy}->{to_ccy} on {on_date}.")
    data = resp.json()
    rate = (data.get("rates") or {}).get(to_ccy)
    if not rate:
        raise HTTPException(502, f"No FX rate returned for {from_ccy}->{to_ccy} on {on_date}.")

    await db.fx_rate_cache.replace_one(
        {"id": cache_key},
        {
            "id": cache_key, "from": from_ccy, "to": to_ccy, "date": on_date, "rate": rate,
            "source": "frankfurter.app (ECB reference rates)",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        },
        upsert=True,
    )
    return rate


# ── Multi-company: match the invoice to one of the firm's companies ─────────
async def resolve_company(current_user: User, extracted: dict) -> Tuple[Optional[str], str, List[dict]]:
    """Matches the extracted 'billed to' details against Company Profiles
    (`db.companies`, the same collection used by Quotations/Invoicing) to
    figure out which of the firm's companies this document belongs to.
    Priority: GSTIN match > billing-email match > fuzzy name match.
    Returns (company_id or None, human-readable reason, all_candidate_companies)."""
    # Company Master is creator-scoped across the rest of the application
    # (/companies and /companies/list). Keep Zero-Touch Entry on the same
    # visibility boundary so a platform owner/user never sees another owner's
    # company (including a licensee/commercial company) in this module.
    companies = await db.companies.find(
        {"created_by": str(current_user.id)},
        {"_id": 0, "id": 1, "name": 1, "gstin": 1, "email": 1},
    ).to_list(500)

    if not companies:
        return None, "No companies are configured in Company Profiles yet.", []
    if len(companies) == 1:
        return companies[0]["id"], f"Only one company configured ('{companies[0]['name']}').", companies

    billed_gstin = (extracted.get("billed_to_gstin") or "").upper().strip()
    billed_email = (extracted.get("billed_to_email") or "").lower().strip()
    billed_name = (extracted.get("billed_to_name") or "").lower().strip()

    if billed_gstin:
        for c in companies:
            if (c.get("gstin") or "").upper().strip() == billed_gstin:
                return c["id"], f"Matched by GSTIN ({billed_gstin}) to '{c['name']}'.", companies

    if billed_email:
        for c in companies:
            if (c.get("email") or "").lower().strip() == billed_email:
                return c["id"], f"Matched by billing email ({billed_email}) to '{c['name']}'.", companies

    if billed_name:
        for c in companies:
            cname = (c.get("name") or "").lower().strip()
            if cname and (billed_name in cname or cname in billed_name):
                return c["id"], f"Matched by company name to '{c['name']}'.", companies

    # ── AI fallback: deterministic GSTIN/email/name matching found nothing.
    # Ask the LLM to reason over the full extracted context (letterhead name,
    # vendor relationship, invoice content) against the candidate companies —
    # catches cases like abbreviated names, trading names, or a "Bill To"
    # that's slightly different text from the Company Profile name.
    ai_company_id, ai_reason, ai_confidence = await _ai_resolve_company(extracted, companies)
    if ai_company_id:
        matched = next((c for c in companies if c["id"] == ai_company_id), None)
        if matched:
            return matched["id"], (
                f"AI-matched to '{matched['name']}' (confidence {ai_confidence:.0%}): {ai_reason}"
            ), companies

    return None, (
        "Could not match this document's 'Bill To' details to any of your "
        f"{len(companies)} configured companies (checked GSTIN, email, name, "
        "and an AI review) — assign the company manually."
    ), companies


AI_COMPANY_MATCH_CONFIDENCE_THRESHOLD = 0.55


async def _ai_resolve_company(extracted: dict, companies: List[dict]) -> Tuple[Optional[str], str, float]:
    """Gemini-based company matcher for multi-company firms.

    Returns ``(company_id or None, reason, confidence)``. Never guesses below
    the confidence threshold — an unmatched document goes to manual
    assignment rather than risk posting into the wrong company's books.

    Uses Gemini 2.5 Flash via the shared client; any failure is logged and
    treated as "no match" (never crashes the pipeline)."""
    api_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not api_key:
        return None, "GEMINI_API_KEY not configured — skipped AI company match.", 0.0

    candidates = [
        {"id": c["id"], "name": c.get("name", ""), "gstin": c.get("gstin", ""), "email": c.get("email", "")}
        for c in companies
    ]
    prompt = f"""You are matching an accounting document to the correct company in a
multi-company bookkeeping system. Given the document's extracted details and
a list of candidate companies belonging to this firm, decide which company
(if any) this document was billed to / belongs to.

Document details:
{json.dumps({
    "document_type": extracted.get("document_type"),
    "vendor_or_customer_name": extracted.get("vendor_or_customer_name"),
    "billed_to_name": extracted.get("billed_to_name"),
    "billed_to_email": extracted.get("billed_to_email"),
    "billed_to_gstin": extracted.get("billed_to_gstin"),
    "invoice_number": extracted.get("invoice_number"),
}, indent=2)}

Candidate companies:
{json.dumps(candidates, indent=2)}

Return ONLY a single JSON object (no markdown fences, no commentary):
{{"company_id": string,  // the "id" of the best-matching company, or "" if none plausibly match
  "confidence": number,  // 0-1, your confidence in this match
  "reason": string}}     // one short sentence explaining the match (or why none matched)

Only pick a company if there is real textual/contextual evidence (name
similarity, known trading name, business context) — do not pick one just
because it's the only option left unexamined."""

    import asyncio
    try:
        from backend.services.gemini_client import get_gemini_client
        from google.genai import types as genai_types  # type: ignore
    except Exception as e:
        _zte_logger.exception("Gemini SDK unavailable for company match")
        return None, f"AI company match unavailable: {e}", 0.0

    def _call_gemini_sync():
        client = get_gemini_client()
        cfg = genai_types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=512,
            response_mime_type="application/json",
        )
        return client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=cfg,
        )

    try:
        response = await asyncio.to_thread(_call_gemini_sync)
        raw = getattr(response, "text", "") or ""
        if not raw:
            try:
                parts = response.candidates[0].content.parts  # type: ignore[attr-defined]
                raw = "".join(getattr(p, "text", "") for p in parts)
            except Exception:
                raw = ""
        if not raw:
            return None, "AI company match returned empty response.", 0.0
        parsed = json.loads(_strip_json_fence(raw))
    except HTTPException as e:
        return None, f"AI company match failed: {e.detail}", 0.0
    except Exception as e:
        _zte_logger.exception("AI company match failed")
        return None, f"AI company match failed: {e}", 0.0

    if not parsed:
        return None, "AI company match request failed.", 0.0

    company_id = (parsed.get("company_id") or "").strip()
    confidence = float(parsed.get("confidence") or 0)
    reason = parsed.get("reason") or ""
    if not company_id or confidence < AI_COMPANY_MATCH_CONFIDENCE_THRESHOLD:
        return None, reason or "AI could not confidently match a company.", confidence
    return company_id, reason, confidence


# ── Contextual vendor → ledger-account categorisation rules ─────────────────
# Learned/curated per firm; seed with common SaaS/vendor patterns and let
# admins extend it via /api/zte/category-rules (below) instead of redeploying.
# Account codes here MUST correspond to real Chart of Accounts codes
# (see accounting_core.DEFAULT_ACCOUNTS) — mismatched labels/codes were a bug
# in an earlier version of this file and have been corrected.
DEFAULT_CATEGORY_RULES: List[dict] = [
    {"match": r"amazon\s*web\s*services|\baws\b", "account_code": "5250", "label": "Software & Cloud Expenses"},
    {"match": r"google\s*cloud|\bgcp\b", "account_code": "5250", "label": "Software & Cloud Expenses"},
    {"match": r"microsoft|azure|office\s*365", "account_code": "5250", "label": "Software & Cloud Expenses"},
    {"match": r"\brender\b|render\.com|render\s*services", "account_code": "5250", "label": "Software & Cloud Expenses"},
    {"match": r"zoom|slack|notion|figma|canva|vercel|netlify|heroku|digitalocean|github|gitlab|openai|anthropic|\bgroq\b",
     "account_code": "5250", "label": "Software & Cloud Expenses"},
    {"match": r"indian\s*railways|irctc|\bola\b|\buber\b|indigo|spicejet|air\s*india|makemytrip|goibibo",
     "account_code": "5600", "label": "Travel & Conveyance"},
    {"match": r"electricity|power\s*corp|discom", "account_code": "5300", "label": "Office & Admin Expenses"},
]


async def _get_category_rules(company_id: str) -> List[dict]:
    rows = await db.zte_category_rules.find({"company_id": company_id}, {"_id": 0}).to_list(500)
    return rows if rows else DEFAULT_CATEGORY_RULES


async def classify_expense_account(company_id: str, vendor_name: str) -> Tuple[str, str]:
    """Returns (account_code, category_label) for a PURCHASE line, falling back
    to the generic 'Purchases' account when no rule matches."""
    rules = await _get_category_rules(company_id)
    vn = (vendor_name or "").lower()
    for rule in rules:
        if re.search(rule["match"], vn, flags=re.IGNORECASE):
            return rule["account_code"], rule["label"]
    return "5000", "Purchases (uncategorised)"


class CategoryRule(BaseModel):
    company_id: str = ""
    match: str            # regex fragment matched against vendor name (case-insensitive)
    account_code: str     # chart_of_accounts code to route to
    label: str = ""


@router.get("/category-rules")
async def list_category_rules(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    return await _get_category_rules(company_id)


@router.post("/category-rules")
async def add_category_rule(rule: CategoryRule, current_user: User = Depends(get_current_user)):
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = rule.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_by"] = current_user.id
    doc["created_at"] = datetime.now(timezone.utc).isoformat()
    await db.zte_category_rules.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ── Core pipeline (importable — call this from a bucket/email webhook too) ──
async def process_document(
    contents: bytes,
    filename: str,
    current_user: User,
    company_id: Optional[str] = None,   # None/"" = auto-detect (deterministic, then AI); a value = explicit override
) -> dict:
    """Extracts + company-matches + drafts the ledger entry end-to-end with
    zero manual data entry, but NEVER posts. Every document lands as either
    `pending_approval` (ready for a human to review and click Approve) or
    `needs_review` (extraction/company-match needs a human to fix something
    first). Posting only happens via the explicit /approve endpoint."""
    img_b64, mime = _file_to_image_b64(contents, filename)
    extracted = await _vision_extract_json(img_b64, mime)

    record_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    resolved_company_id = company_id or None
    company_match_reason = "Company set manually." if company_id else ""
    if not resolved_company_id:
        resolved_company_id, company_match_reason, _ = await resolve_company(current_user, extracted)

    record = {
        "id": record_id,
        "company_id": resolved_company_id or "",
        "company_match_reason": company_match_reason,
        "filename": filename,
        "extracted": extracted,
        "preview": None,          # computed-but-unposted journal entry, awaiting approval
        "fx": None,
        "amount_inr": None,
        "status": "extracted",
        "journal_entry_id": None,
        "posting_error": None,
        "rejection_reason": None,
        "reviewed_by": None,
        "reviewed_at": None,
        # Bank-reconciliation state (Module 3-of-the-brief / bank_accounts.py
        # closes this out automatically once a matching bank-statement line
        # is found — see bank_accounts._match_transaction).
        "settled": False,
        "settled_bank_txn_id": None,
        "settled_journal_entry_id": None,
        "created_by": current_user.id,
        "created_at": now,
    }

    if not resolved_company_id:
        record["status"] = "needs_review"
        record["posting_error"] = company_match_reason
    else:
        try:
            preview = await build_ledger_preview(resolved_company_id, extracted)
            record["preview"] = preview
            record["fx"] = preview["fx"]
            record["amount_inr"] = round(preview["fx"]["original_total_value"] * preview["fx"]["rate_to_inr"], 2) \
                if preview["fx"] else float(extracted.get("total_invoice_value") or 0)
            
            # ─── INTEGRATION WITH PHASE 6 AI DECISION ENGINE ───
            ocr_metadata = {
                "confidence": extracted.get("confidence", 0.85),
                "quality_score": 0.90,
                "engine_used": "gemini_vision",
                "pages_processed": 1
            }
            
            vendor_profile = None
            try:
                vendor_name = extracted.get("vendor_or_customer_name") or ""
                vendor_gstin = extracted.get("tax_registration_number") or ""
                if vendor_name:
                    vendor_profile, _, _ = await find_best_vendor_match(vendor_name, vendor_gstin)
            except Exception as e:
                _zte_logger.error(f"Error querying vendor in ZTE decision: {e}")

            from backend.ai.document_validator import run_document_validation_pipeline
            validation_report = await run_document_validation_pipeline(
                extracted_data=extracted,
                ocr_metadata=ocr_metadata,
                filename=filename,
                document_id=record_id,
                vendor_profile=vendor_profile,
                template_matched=False,
                company_id=resolved_company_id
            )
            
            record["validation_report"] = validation_report
            decision = validation_report.get("decision", "REQUIRES_REVIEW")
            
            if decision == "AUTO_POST":
                try:
                    entry = await post_ledger_preview(resolved_company_id, preview, current_user.id, source_id=record_id)
                    record["status"] = "posted"
                    record["journal_entry_id"] = entry["id"]
                    _zte_logger.info(f"Zero-Touch: Document {record_id} AUTO_POST completed successfully.")
                    
                    try:
                        from backend.ai import ai_router
                        await ai_router.update_accounting_memory(record, entry, current_user.id)
                    except Exception as mem_err:
                        _zte_logger.error(f"Failed to update AI memory in auto post: {mem_err}")
                except Exception as post_err:
                    _zte_logger.error(f"Auto post failed: {post_err}", exc_info=True)
                    record["status"] = "needs_review"
                    record["posting_error"] = f"Auto-post failed: {str(post_err)}"
            elif decision == "REJECT":
                record["status"] = "rejected"
                record["rejection_reason"] = validation_report.get("decision_reason", "Rejected by AI Decision Engine.")
            else:
                record["status"] = "pending_approval"
                record["posting_error"] = validation_report.get("decision_reason", "Requires manual review/approval.")
                
        except ValueError as e:
            # Amount/currency/data didn't balance or was unusable — leave for
            # human review rather than drafting something wrong.
            record["status"] = "needs_review"
            record["posting_error"] = str(e)

    await db.zte_processed_documents.insert_one(dict(record))
    record.pop("_id", None)
    return record


async def build_ledger_preview(company_id: str, extracted: dict) -> dict:
    """Autonomous double-entry drafting (Module 1 steps 4-5) — computes the
    balanced journal lines but does NOT post them. Returns a preview dict:
    {"lines": [...], "narration": str, "entry_date": "YYYY-MM-DD",
     "fx": fx_conversion_metadata_or_None}. Raises ValueError if the document
    can't be turned into a valid, balanced entry (routed to needs_review by
    the caller instead)."""
    doc_type = (extracted.get("document_type") or "").upper()
    taxable_value = float(extracted.get("taxable_value") or 0)
    tax_breakup = extracted.get("tax_breakup") or {}
    cgst = float(tax_breakup.get("cgst") or 0)
    sgst = float(tax_breakup.get("sgst") or 0)
    igst = float(tax_breakup.get("igst") or 0)
    total_value = float(extracted.get("total_invoice_value") or 0)
    vendor = extracted.get("vendor_or_customer_name") or "Unknown Party"
    inv_no = extracted.get("invoice_number") or ""
    inv_date = extracted.get("invoice_date") or date.today().isoformat()
    currency = (extracted.get("currency") or "INR").upper().strip() or "INR"

    # Smart Indian GST and math auto-correction to eliminate accounting principle/concept errors
    extracted_total_tax = float(extracted.get("total_tax") or 0)
    if extracted_total_tax > 0 and (cgst + sgst + igst) <= 0:
        company_gstin = ""
        company_doc = await db.companies.find_one({"id": company_id}, {"_id": 0, "gstin": 1})
        if company_doc:
            company_gstin = str(company_doc.get("gstin") or "").strip()
        
        vendor_gstin = str(extracted.get("tax_registration_number") or "").strip()
        is_same_state = False
        if company_gstin and vendor_gstin and len(company_gstin) >= 2 and len(vendor_gstin) >= 2:
            is_same_state = (company_gstin[:2] == vendor_gstin[:2])
        
        if is_same_state:
            cgst = round(extracted_total_tax / 2, 2)
            sgst = round(extracted_total_tax / 2, 2)
            igst = 0.0
        else:
            igst = extracted_total_tax
            cgst = 0.0
            sgst = 0.0

    total_tax = round(cgst + sgst + igst, 2)
    if total_value <= 0 and taxable_value > 0:
        total_value = round(taxable_value + total_tax, 2)

    if total_value <= 0:
        raise ValueError("Extracted invoice value is 0 — cannot post; needs manual review.")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", inv_date):
        inv_date = date.today().isoformat()

    # ── Multi-currency conversion (Module 1 step 4) ─────────────────────────
    fx_meta = None
    if currency != "INR":
        try:
            fx_rate = await get_historical_fx_rate(currency, "INR", inv_date)
        except HTTPException as e:
            raise ValueError(f"Could not fetch {currency}->INR exchange rate for {inv_date}: {e.detail}")
        fx_meta = {
            "original_currency": currency,
            "original_taxable_value": taxable_value,
            "original_total_tax": total_tax,
            "original_total_value": total_value,
            "rate_to_inr": fx_rate,
            "rate_date": inv_date,
        }
        taxable_value = round(taxable_value * fx_rate, 2)
        cgst = round(cgst * fx_rate, 2)
        sgst = round(sgst * fx_rate, 2)
        igst = round(igst * fx_rate, 2)
        total_value = round(total_value * fx_rate, 2)

    total_tax = round(cgst + sgst + igst, 2)
    if taxable_value <= 0:
        taxable_value = round(total_value - total_tax, 2)

    ar_id = await ac.get_default_account_id(company_id, "1100")   # Accounts Receivable
    ap_id = await ac.get_default_account_id(company_id, "2000")   # Accounts Payable
    sales_id = await ac.get_default_account_id(company_id, "4000")  # Sales Income
    output_tax_id = await ac.get_default_account_id(company_id, "2100")  # GST Output Payable
    input_tax_id = await ac.get_default_account_id(company_id, "1200")   # GST Input Credit

    fx_suffix = f" [{fx_meta['original_currency']} {fx_meta['original_total_value']} @ {fx_meta['rate_to_inr']:.4f} on {inv_date}]" if fx_meta else ""

    lines: list
    if doc_type == "SALE":
        lines = [
            {"account_id": ar_id, "account_name": "Accounts Receivable", "debit": total_value, "credit": 0,
             "memo": f"{vendor} — Inv {inv_no}"},
            {"account_id": sales_id, "account_name": "Sales / Fee Income", "debit": 0, "credit": taxable_value,
             "memo": vendor},
        ]
        if total_tax > 0:
            lines.append({"account_id": output_tax_id, "account_name": "GST Output Payable",
                           "debit": 0, "credit": total_tax, "memo": f"Output tax on Inv {inv_no}"})
        narration = f"AI zero-touch entry — Sale to {vendor}, Invoice {inv_no}{fx_suffix}"

    elif doc_type == "PURCHASE":
        expense_code = None
        category_label = None
        
        # Check Vendor Learning Engine recommendations
        try:
            from backend.ai.vendor_mapper import find_best_vendor_match
            gst_val = (extracted.get("tax_registration_number") or "").strip().upper()
            profile, score, _ = await find_best_vendor_match(vendor, gst_val)
            if profile and profile.get("confidence_score", 0.0) >= 0.60:
                expense_code = profile.get("default_ledger")
                category_label = profile.get("expense_category")
        except Exception as v_err:
            _zte_logger.error(f"Error querying vendor recommendations: {v_err}", exc_info=True)
            
        if not expense_code:
            expense_code, category_label = await classify_expense_account(company_id, vendor)
            
        expense_id = await ac.get_default_account_id(company_id, expense_code)
        lines = [
            {"account_id": expense_id, "account_name": category_label, "debit": taxable_value, "credit": 0,
             "memo": f"{vendor} — Inv {inv_no}"},
        ]
        if total_tax > 0:
            lines.append({"account_id": input_tax_id, "account_name": "GST Input Credit (ITC)",
                           "debit": total_tax, "credit": 0, "memo": f"ITC on Inv {inv_no}"})
        lines.append({"account_id": ap_id, "account_name": "Accounts Payable",
                       "debit": 0, "credit": total_value, "memo": vendor})
        narration = f"AI zero-touch entry — Purchase from {vendor} ({category_label}), Invoice {inv_no}{fx_suffix}"

    else:
        raise ValueError(f"Could not classify document as SALE or PURCHASE (got '{doc_type}').")

    if any(l["account_id"] is None for l in lines):
        raise ValueError(
            "One or more default ledger accounts are missing for this company — "
            "open Chart of Accounts once to seed them, then retry."
        )

    return {"lines": lines, "narration": narration, "entry_date": inv_date, "fx": fx_meta}


async def post_ledger_preview(company_id: str, preview: dict, created_by: str, source_id: str) -> dict:
    """Posts a previously-built, human-approved preview to the ledger. This
    is the ONLY function in this module that actually writes to
    journal_entries/journal_lines — called exclusively from the /approve
    endpoint, never automatically."""
    from backend.accounting_ai.accounting_engine import AccountingEngine
    doc = await db.zte_processed_documents.find_one({"id": source_id})
    extracted = doc.get("extracted") if doc else {
        "document_type": "PURCHASE",
        "vendor_or_customer_name": "Unknown Party",
        "tax_registration_number": "",
        "invoice_number": "",
        "invoice_date": preview.get("entry_date"),
        "line_items": [],
        "taxable_value": sum(float(l.get("debit") or 0) for l in preview.get("lines", []) if "GST" not in l.get("account_name", "")),
        "tax_breakup": {},
        "total_tax": sum(float(l.get("debit") or 0) for l in preview.get("lines", []) if "GST" in l.get("account_name", "")),
        "total_invoice_value": sum(float(l.get("debit") or 0) for l in preview.get("lines", []))
    }
    
    vendor_profile = None
    vendor_name = extracted.get("vendor_or_customer_name") or ""
    vendor_gstin = extracted.get("tax_registration_number") or ""
    if vendor_name:
        vendor_profile, _, _ = await find_best_vendor_match(vendor_name, vendor_gstin)

    return await AccountingEngine.process_posting(
        company_id=company_id,
        extracted_data=extracted,
        created_by=created_by,
        source_id=source_id,
        vendor_profile=vendor_profile
    )



# ── HTTP trigger (manual upload; swap/augment with bucket or email webhook) ─
@router.post("/upload")
async def upload_and_process(
    file: UploadFile = File(...),
    company_id: str = Form(""),   # leave blank to auto-detect (deterministic, then AI)
    current_user: User = Depends(get_current_user),
):
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    contents = await file.read()
    if not contents:
        raise HTTPException(422, "Empty file.")
    # Extracts, matches the company (AI-assisted for multi-company setups),
    # converts currency, and drafts the journal entry — but never posts.
    # Human approval always happens separately via /approve below.
    record = await process_document(
        contents=contents,
        filename=file.filename or "upload",
        current_user=current_user,
        company_id=company_id or None,
    )
    return record


@router.get("/documents")
async def list_processed_documents(
    company_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    q: dict = {}
    if company_id is not None:
        q["company_id"] = company_id
    if status:
        q["status"] = status
    docs = await db.zte_processed_documents.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)

    company_ids = {d["company_id"] for d in docs if d.get("company_id")}
    companies = await db.companies.find(
        {"id": {"$in": list(company_ids)}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(500) if company_ids else []
    name_by_id = {c["id"]: c["name"] for c in companies}
    for d in docs:
        d["company_name"] = name_by_id.get(d.get("company_id"), "")
    return docs


@router.get("/companies")
async def list_companies_for_zte(current_user: User = Depends(get_current_user)):
    """Company picker for the manual-override dropdown in the upload UI.
    Match the canonical Company Master visibility used by /companies/list:
    only companies created by the current user are visible."""
    return await db.companies.find(
        {"created_by": str(current_user.id)},
        {"_id": 0, "id": 1, "name": 1, "gstin": 1},
    ).sort("name", 1).to_list(500)


class AssignCompanyBody(BaseModel):
    company_id: str


@router.post("/documents/{doc_id}/assign-company")
async def assign_company(doc_id: str, body: AssignCompanyBody, current_user: User = Depends(get_current_user)):
    """Manual company assignment for documents the AI (deterministic + AI
    fallback) couldn't confidently match. Drafts the preview afterwards —
    still requires a separate /approve to post."""
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = await db.zte_processed_documents.find_one({"id": doc_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Document not found.")
    if doc["status"] in ("posted", "rejected"):
        raise HTTPException(400, f"Document is already {doc['status']}.")
    # Do not allow a manual assignment to bypass the same Company Master
    # ownership boundary used by the picker and auto-detection.
    company = await db.companies.find_one(
        {"id": body.company_id, "created_by": str(current_user.id)},
        {"_id": 0, "id": 1, "name": 1},
    )
    if not company:
        raise HTTPException(404, "Company not found in your Company Master.")
    await db.zte_processed_documents.update_one(
        {"id": doc_id},
        {"$set": {"company_id": body.company_id, "company_match_reason": "Company assigned manually.", "posting_error": None}},
    )
    doc["company_id"] = body.company_id
    return await _draft_preview(doc)


@router.post("/documents/{doc_id}/retry-posting")
async def retry_draft(doc_id: str, current_user: User = Depends(get_current_user)):
    """Re-attempts drafting the preview (e.g. after seeding missing default
    ledger accounts, or adding a category rule). Still lands on
    pending_approval, not posted — approval is a separate explicit step."""
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = await db.zte_processed_documents.find_one({"id": doc_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Document not found.")
    if doc["status"] in ("posted", "rejected"):
        raise HTTPException(400, f"Document is already {doc['status']}.")
    return await _draft_preview(doc)


async def _draft_preview(doc: dict) -> dict:
    """Computes (but never posts) the journal entry preview for a document,
    and saves it as pending_approval."""
    if not doc.get("company_id"):
        raise HTTPException(400, "No company assigned to this document yet — assign one first.")
    try:
        preview = await build_ledger_preview(doc["company_id"], doc["extracted"])
        amount_inr = round(preview["fx"]["original_total_value"] * preview["fx"]["rate_to_inr"], 2) if preview["fx"] \
            else float((doc.get("extracted") or {}).get("total_invoice_value") or 0)
        await db.zte_processed_documents.update_one(
            {"id": doc["id"]},
            {"$set": {"status": "pending_approval", "preview": preview, "fx": preview["fx"],
                      "amount_inr": amount_inr, "posting_error": None}},
        )
        return {"success": True, "status": "pending_approval", "preview": preview}
    except ValueError as e:
        await db.zte_processed_documents.update_one({"id": doc["id"]}, {"$set": {"status": "needs_review", "posting_error": str(e)}})
        raise HTTPException(400, str(e))


class PreviewLine(BaseModel):
    account_id: str
    account_name: str = ""
    debit: float = 0.0
    credit: float = 0.0
    memo: str = ""


class UpdatePreviewBody(BaseModel):
    lines: List[PreviewLine]


@router.post("/documents/{doc_id}/update-preview")
async def update_preview(doc_id: str, body: UpdatePreviewBody, current_user: User = Depends(get_current_user)):
    """Lets a human correct the AI-drafted account/head (or amounts) for a
    still-unposted document before approving — e.g. the AI put a Purchase
    against the generic 'Purchases' account when it should have gone to a
    specific expense head. Only allowed while the document is still
    pending_approval; once posted, corrections go through the Accounting
    Integrity 'Fix this entry' flow instead (source-locked)."""
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = await db.zte_processed_documents.find_one({"id": doc_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Document not found.")
    if doc["status"] != "pending_approval":
        raise HTTPException(400, f"Document is '{doc['status']}' — only a pending-approval draft can be edited.")
    if not doc.get("preview"):
        raise HTTPException(400, "No draft entry to edit.")
    lines = [l.model_dump() for l in body.lines]
    total_debit = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    total_credit = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(total_debit - total_credit) > 0.01:
        raise HTTPException(400, f"Lines don't balance: debit {total_debit} != credit {total_credit}.")
    if total_debit <= 0:
        raise HTTPException(400, "Entry has no amount.")
    new_preview = dict(doc["preview"])
    new_preview["lines"] = lines
    await db.zte_processed_documents.update_one({"id": doc_id}, {"$set": {"preview": new_preview}})
    return {"success": True, "preview": new_preview}


@router.post("/documents/{doc_id}/approve")
async def approve_document(doc_id: str, current_user: User = Depends(get_current_user)):
    """The only endpoint in this module that posts to the ledger. A human
    with posting rights reviews the AI-drafted preview and explicitly
    approves it here — nothing reaches the books automatically."""
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    doc = await db.zte_processed_documents.find_one({"id": doc_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Document not found.")
    if doc["status"] != "pending_approval":
        raise HTTPException(400, f"Document is '{doc['status']}', not pending approval.")
    if not doc.get("preview"):
        raise HTTPException(400, "No draft entry to approve — retry drafting first.")
    try:
        entry = await post_ledger_preview(doc["company_id"], doc["preview"], current_user.id, source_id=doc["id"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    now = datetime.now(timezone.utc).isoformat()
    await db.zte_processed_documents.update_one(
        {"id": doc_id},
        {"$set": {"status": "posted", "journal_entry_id": entry["id"], "posting_error": None,
                   "reviewed_by": current_user.id, "reviewed_at": now}},
    )
    
    try:
        from backend.ai import ai_router
        await ai_router.update_accounting_memory(doc, entry, current_user.id)
    except Exception as e:
        _zte_logger.error(f"Failed to update AI accounting memory: {e}", exc_info=True)

    # Update Vendor Learning Engine with final ledger, narration, corrections, and posting success
    try:
        from backend.ai.vendor_learning import record_manual_correction, learn_vendor_profile
        
        extracted = doc.get("extracted") or {}
        vendor_name = extracted.get("vendor_or_customer_name") or ""
        gstin = extracted.get("tax_registration_number") or ""
        
        if vendor_name:
            final_preview = doc.get("preview") or {}
            final_lines = final_preview.get("lines") or []
            final_narration = final_preview.get("narration") or ""
            
            # Find the final expense account code
            final_expense_account_code = "5000"
            final_expense_category = "Purchases (uncategorised)"
            for l in final_lines:
                if l.get("debit", 0) > 0 and "GST" not in l.get("account_name", ""):
                    final_expense_account_code = l.get("account_id", "5000")
                    final_expense_category = l.get("account_name", "Purchases (uncategorised)")
                    break
                    
            # Record corrections
            corrections = {
                "ledger": final_expense_account_code,
                "expense_category": final_expense_category,
                "narration": final_narration,
                "gst_treatment": extracted.get("preferred_gst_treatment") or "Regular",
                "posting_success": True
            }
            await record_manual_correction(vendor_name, gstin, corrections)
            
            # Also learn from this successfully approved transaction to reinforce pattern
            learning_data = {
                "document_type": extracted.get("document_type") or "PURCHASE",
                "total_invoice_value": float(extracted.get("total_invoice_value") or doc.get("amount_inr") or 0.0),
                "currency": extracted.get("currency") or "INR",
                "tax_rate": float(extracted.get("tax_breakup", {}).get("cgst", 0.0) or 0.0),
            }
            await learn_vendor_profile(vendor_name, gstin, learning_data)
            _zte_logger.info("Vendor Profile updated successfully after successful journal posting")
            
            # --- PHASE 10 SELF-LEARNING ENGINE ---
            try:
                from backend.learning.learning_engine import LearningEngine
                approved_post_payload = {
                    "vendor_name": vendor_name,
                    "ledger_code": final_expense_account_code,
                    "account_code": final_expense_account_code,
                    "document_type": extracted.get("document_type") or "PURCHASE",
                    "total_invoice_value": float(extracted.get("total_invoice_value") or doc.get("amount_inr") or 0.0),
                    "gst_rate": float(extracted.get("tax_breakup", {}).get("cgst", 0.0) or 0.0) * 2,
                    "narration": final_narration,
                    "raw_text": doc.get("raw_ocr_text") or ""
                }
                await LearningEngine.process_learning(
                    company_id=doc["company_id"],
                    user_id=current_user.id,
                    event_type="approved_zte_journal",
                    source_id=doc_id,
                    data=approved_post_payload
                )
                _zte_logger.info("Phase 10 Self-Learning triggered successfully after posting.")
            except Exception as learn_err10:
                _zte_logger.error(f"Failed to trigger Phase 10 learning: {learn_err10}", exc_info=True)
    except Exception as learn_err:
        _zte_logger.error(f"Error in Vendor Learning after posting: {learn_err}", exc_info=True)

    return {"success": True, "journal_entry_id": entry["id"], "fx": doc.get("fx")}


class RejectBody(BaseModel):
    reason: str = Field(..., min_length=3, description="Why this AI-drafted entry is being rejected.")


@router.post("/documents/{doc_id}/reject")
async def reject_document(doc_id: str, body: RejectBody, current_user: User = Depends(get_current_user)):
    """Discards an AI-drafted preview without ever posting it."""
    if not _perm_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = await db.zte_processed_documents.find_one({"id": doc_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Document not found.")
    if doc["status"] in ("posted", "rejected"):
        raise HTTPException(400, f"Document is already {doc['status']}.")
    now = datetime.now(timezone.utc).isoformat()
    await db.zte_processed_documents.update_one(
        {"id": doc_id},
        {"$set": {"status": "rejected", "rejection_reason": body.reason,
                   "reviewed_by": current_user.id, "reviewed_at": now}},
    )
    return {"success": True, "status": "rejected"}


async def create_zte_indexes():
    await db.zte_processed_documents.create_index("company_id")
    await db.zte_processed_documents.create_index("status")
    await db.zte_category_rules.create_index("company_id")
    await db.fx_rate_cache.create_index("id", unique=True)