import hashlib
import os
import time
import logging
import uuid
import re
import io
import json
from datetime import datetime, timezone
from typing import Any

from backend.dependencies import db
from backend.ai.fingerprint import generate_document_fingerprint
from backend.services.gemini_client import get_gemini_client

logger = logging.getLogger("document_classifier")

SUPPORTED_DOCUMENT_TYPES = [
    "Purchase Invoice",
    "Sales Invoice",
    "Credit Note",
    "Debit Note",
    "Bank Statement",
    "GST Notice",
    "ROC Filing",
    "Income Tax Notice",
    "TDS Certificate",
    "Salary Slip",
    "Expense Bill",
    "Receipt",
    "Quotation",
    "Purchase Order",
    "Delivery Challan",
    "Agreement",
    "Excel Import",
    "CSV Import",
    "Other"
]

def map_db_document_type(doc_type: str) -> str:
    if not doc_type:
        return "Other"
    dt = str(doc_type).strip().upper()
    if dt in ("PURCHASE", "PURCHASE INVOICE"):
        return "Purchase Invoice"
    if dt in ("SALE", "SALES", "SALES INVOICE"):
        return "Sales Invoice"
    
    # Check for direct case-insensitive match
    for t in SUPPORTED_DOCUMENT_TYPES:
        if t.upper() == dt:
            return t
            
    # Try fuzzy matches
    dt_clean = re.sub(r'[^A-Z]', '', dt)
    for t in SUPPORTED_DOCUMENT_TYPES:
        t_clean = re.sub(r'[^A-Z]', '', t.upper())
        if t_clean == dt_clean:
            return t
            
    return "Other"

def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()

async def classify_document(
    contents: bytes,
    filename: str,
    raw_ocr_text: str = "",
    file_hash: str = "",
    document_id: str = ""
) -> dict:
    """
    Classifies an uploaded document using a layered strategy:
    Layer 1: Known Fingerprint -> Reuse previous classification
    Layer 2: Known Vendor -> Reuse previous document type
    Layer 3: Keyword Analysis -> Local rule-based identification
    Layer 4: Gemini Classification -> Generative AI fallback
    Layer 5: Unknown -> Other (low confidence)
    """
    start_time = time.time()
    logger.info("Classification Started")

    if not document_id:
        document_id = str(uuid.uuid4())

    if not file_hash:
        file_hash = hashlib.sha256(contents).hexdigest()

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    file_type = ext or "unknown"
    
    # Calculate page count if PDF
    page_count = 1
    if ext == "pdf":
        try:
            import pdfplumber
            with pdfplumber.open(io.BytesIO(contents)) as pdf:
                page_count = len(pdf.pages)
        except Exception:
            pass

    normalized_ocr = ""
    if raw_ocr_text.strip():
        normalized_ocr = re.sub(r'[^a-z0-9]', '', raw_ocr_text.lower().strip())[:1000]

    # Generate initial default fingerprint (based on empty values since vendor/invoice metadata isn't known yet)
    fingerprint = generate_document_fingerprint(
        vendor_name="",
        vendor_gstin="",
        invoice_number="",
        document_type="",
        raw_ocr_text=raw_ocr_text
    )

    final_doc_type = "Other"
    final_confidence = 0.0
    final_reason = "Unknown"
    layer_used = 5

    try:
        # ── LAYER 1: Known Fingerprint ──
        # Check both classifications and memory records
        classification_record = None
        if file_hash:
            classification_record = await db.document_classifications.find_one({"file_hash": file_hash})
        if not classification_record and fingerprint:
            classification_record = await db.document_classifications.find_one({"fingerprint": fingerprint})

        if classification_record:
            final_doc_type = classification_record.get("document_type", "Other")
            final_confidence = float(classification_record.get("confidence", 1.0))
            final_reason = classification_record.get("reason", "Retrieved from classification memory")
            layer_used = 1
            logger.info("Memory Classification Hit")

        if layer_used == 5:
            # Check existing AI document memory to see if we processed this exact file before
            memory_record = None
            if file_hash:
                memory_record = await db.ai_document_memory.find_one({"file_hash": file_hash})
            if not memory_record and normalized_ocr:
                memory_record = await db.ai_document_memory.find_one({"raw_ocr_text_normalized": normalized_ocr})

            if memory_record and memory_record.get("document_type"):
                final_doc_type = map_db_document_type(memory_record["document_type"])
                final_confidence = float(memory_record.get("ai_confidence", 0.95))
                final_reason = "Retrieved from existing document memory matches"
                layer_used = 1
                logger.info("Memory Classification Hit")

        # ── LAYER 2: Known Vendor ──
        if layer_used == 5 and raw_ocr_text.strip():
            # Check for GSTIN matches in raw OCR text
            gstin_re = re.compile(r'\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b', re.I)
            gstin_match = gstin_re.search(raw_ocr_text)
            if gstin_match:
                gstin = gstin_match.group(0).upper()
                prev_vendor_record = await db.ai_document_memory.find_one({"vendor_gstin": gstin})
                if prev_vendor_record and prev_vendor_record.get("document_type"):
                    final_doc_type = map_db_document_type(prev_vendor_record["document_type"])
                    final_confidence = 0.9
                    final_reason = f"Known vendor GSTIN {gstin} matching previous document type"
                    layer_used = 2
                    logger.info("Memory Classification Hit")

            if layer_used == 5:
                # Try finding matched vendor name in recent records
                known_vendors = await db.ai_document_memory.find(
                    {"vendor_name": {"$ne": "Unknown Vendor", "$exists": True}},
                    {"vendor_name": 1, "document_type": 1}
                ).sort("created_at", -1).limit(100).to_list(100)

                for kv in known_vendors:
                    v_name = kv.get("vendor_name")
                    if v_name and len(v_name) > 3:
                        v_norm = re.sub(r'[^a-z0-9]', '', v_name.lower())
                        raw_norm = re.sub(r'[^a-z0-9]', '', raw_ocr_text.lower())
                        file_norm = re.sub(r'[^a-z0-9]', '', filename.lower())
                        if v_norm in raw_norm or v_norm in file_norm:
                            final_doc_type = map_db_document_type(kv.get("document_type"))
                            final_confidence = 0.85
                            final_reason = f"Known vendor name '{v_name}' detected in document context"
                            layer_used = 2
                            logger.info("Memory Classification Hit")
                            break

        # ── LAYER 3: Keyword Analysis ──
        if layer_used == 5:
            filename_lower = filename.lower()
            text_lower = raw_ocr_text.lower()

            # Excel/CSV Import
            if ext in ("xlsx", "xlsm", "xls") and any(k in filename_lower for k in ("import", "ledger", "upload")):
                final_doc_type = "Excel Import"
                final_confidence = 0.95
                final_reason = "Excel file containing import keywords in filename"
                layer_used = 3
            elif ext == "csv" and any(k in filename_lower for k in ("import", "ledger", "upload")):
                final_doc_type = "CSV Import"
                final_confidence = 0.95
                final_reason = "CSV file containing import keywords in filename"
                layer_used = 3

            # Credit Note
            elif any(k in text_lower or k in filename_lower for k in ("credit note", "credit memo", "cn-", "creditnote")):
                final_doc_type = "Credit Note"
                final_confidence = 0.9
                final_reason = "Keywords matching credit note/memo detected"
                layer_used = 3
                
            # Debit Note
            elif any(k in text_lower or k in filename_lower for k in ("debit note", "debit memo", "dn-", "debitnote")):
                final_doc_type = "Debit Note"
                final_confidence = 0.9
                final_reason = "Keywords matching debit note/memo detected"
                layer_used = 3
                
            # Bank Statement
            elif any(k in text_lower or k in filename_lower for k in ("bank statement", "e-statement", "account statement", "statement of account", "transaction history", "bankst")):
                final_doc_type = "Bank Statement"
                final_confidence = 0.9
                final_reason = "Keywords matching bank statement detected"
                layer_used = 3
                
            # GST Notice
            elif any(k in text_lower or k in filename_lower for k in ("gst notice", "form gst", "gst-07", "gst-08", "gstr-", "gstr1", "gstr3b", "show cause notice", "gst demand")):
                final_doc_type = "GST Notice"
                final_confidence = 0.9
                final_reason = "Keywords matching GST notice or returns detected"
                layer_used = 3
                
            # ROC Filing
            elif any(k in text_lower or k in filename_lower for k in ("roc filing", "mca filing", "form mgt-7", "form aoc-4", "registrar of companies", "certificate of incorporation")):
                final_doc_type = "ROC Filing"
                final_confidence = 0.9
                final_reason = "Keywords matching ROC/MCA filing detected"
                layer_used = 3
                
            # Income Tax Notice
            elif any(k in text_lower or k in filename_lower for k in ("income tax notice", "notice under section", "it notice", "assessment year", "income tax department", "itr-v", "itr5")):
                final_doc_type = "Income Tax Notice"
                final_confidence = 0.9
                final_reason = "Keywords matching Income Tax department or notice detected"
                layer_used = 3
                
            # TDS Certificate
            elif any(k in text_lower or k in filename_lower for k in ("tds certificate", "form 16", "form 16a", "form 26as", "tax deducted at source", "tds return")):
                final_doc_type = "TDS Certificate"
                final_confidence = 0.9
                final_reason = "Keywords matching TDS certificate Form 16/26AS detected"
                layer_used = 3
                
            # Salary Slip
            elif any(k in text_lower or k in filename_lower for k in ("salary slip", "payslip", "pay slip", "earning statement", "provident fund", "salary certificate")):
                final_doc_type = "Salary Slip"
                final_confidence = 0.9
                final_reason = "Keywords matching salary payslip detected"
                layer_used = 3
                
            # Quotation
            elif any(k in text_lower or k in filename_lower for k in ("quotation", "quote", "proforma", "proforma invoice", "estimate")):
                final_doc_type = "Quotation"
                final_confidence = 0.9
                final_reason = "Keywords matching quotation/proforma detected"
                layer_used = 3
                
            # Purchase Order
            elif any(k in text_lower or k in filename_lower for k in ("purchase order", "po-", "p.o.")):
                final_doc_type = "Purchase Order"
                final_confidence = 0.9
                final_reason = "Keywords matching Purchase Order detected"
                layer_used = 3
                
            # Delivery Challan
            elif any(k in text_lower or k in filename_lower for k in ("delivery challan", "delivery note", "dispatch advice", "challan")):
                final_doc_type = "Delivery Challan"
                final_confidence = 0.9
                final_reason = "Keywords matching Delivery Challan/Note detected"
                layer_used = 3
                
            # Agreement
            elif any(k in text_lower or k in filename_lower for k in ("agreement", "contract", "mou", "non-disclosure", "nda", "lease deed", "partnership deed")):
                final_doc_type = "Agreement"
                final_confidence = 0.9
                final_reason = "Keywords matching legal agreement or contract detected"
                layer_used = 3
                
            # Expense Bill / Receipt
            elif any(k in text_lower or k in filename_lower for k in ("receipt", "expense bill", "expense receipt", "cab bill", "reimbursement", "cash receipt", "uber", "ola")):
                final_doc_type = "Receipt"
                final_confidence = 0.9
                final_reason = "Keywords matching receipt or expense bill detected"
                layer_used = 3

            # Purchase / Sales Invoices
            elif any(k in text_lower or k in filename_lower for k in ("invoice", "tax invoice", "bill", "invoice no", "inv-")):
                if any(x in text_lower or x in filename_lower for x in ("purchase", "inward", "vendor", "supplier")):
                    final_doc_type = "Purchase Invoice"
                    final_confidence = 0.85
                    final_reason = "Invoice with purchase/vendor keywords detected"
                    layer_used = 3
                elif any(x in text_lower or x in filename_lower for x in ("sales", "sale", "outward", "billed to", "invoice to")):
                    final_doc_type = "Sales Invoice"
                    final_confidence = 0.85
                    final_reason = "Invoice with sales/billed-to keywords detected"
                    layer_used = 3
                else:
                    final_doc_type = "Purchase Invoice"
                    final_confidence = 0.7
                    final_reason = "Invoice keyword matched, defaulting to Purchase Invoice"
                    layer_used = 3

            if layer_used == 3:
                logger.info("Keyword Classification")

        # ── LAYER 4: Gemini Classification ──
        if layer_used == 5:
            logger.info("Gemini Classification")
            client = get_gemini_client()
            model_name = os.environ.get("GEMINI_CLASSIFIER_MODEL", "gemini-3.5-flash")

            prompt = f"""
You are an expert document classification engine.
Your task is to classify the uploaded document into one of the following exact types:
{json.dumps(SUPPORTED_DOCUMENT_TYPES, indent=2)}

Here is the document metadata:
- Filename: {filename}
- File type/extension: {ext}

And here is the extracted text from the document (up to 15000 characters):
--- BEGIN EXTRACTED TEXT ---
{raw_ocr_text[:15000]}
--- END EXTRACTED TEXT ---

Analyze the document filename, extension, and text context.
Choose the single most appropriate document type from the list above.
Provide a confidence score between 0.0 and 1.0.
Provide a short, clear reason for your classification.

Your output must be strict JSON in the following format:
{{
  "document_type": "one of the exact strings from the supported document types list",
  "confidence": 0.85,
  "reason": "explanation of your choice"
}}
"""
            from google.genai import types as genai_types
            
            def _call_gemini():
                contents = [prompt]
                # If there's no OCR text and this is an image, we can try sending it as image part
                if not raw_ocr_text.strip() and ext in ("jpg", "jpeg", "png", "webp"):
                    contents = [
                        genai_types.Part.from_bytes(data=contents, mime_type=f"image/{ext if ext != 'jpg' else 'jpeg'}"),
                        prompt
                    ]
                cfg = genai_types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=500,
                    response_mime_type="application/json",
                )
                return client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=cfg,
                )

            import asyncio
            response = await asyncio.to_thread(_call_gemini)
            raw_text = getattr(response, "text", "")
            
            if raw_text:
                res = json.loads(_strip_json_fence(raw_text))
                g_doc_type = res.get("document_type")
                mapped = map_db_document_type(g_doc_type)
                
                final_doc_type = mapped
                final_confidence = float(res.get("confidence", 0.75))
                final_reason = res.get("reason", "Gemini generative classification")
                layer_used = 4

    except Exception as e:
        logger.error(f"Error during document classification layers: {e}", exc_info=True)
        # Error handling requirement: "If classifier fails: Return: Document Type = Other, Confidence = 0. Continue normal workflow."
        final_doc_type = "Other"
        final_confidence = 0.0
        final_reason = f"Classifier error: {str(e)}"
        layer_used = 5

    # Log metrics
    logger.info("Classification Completed")
    logger.info(f"Confidence: {final_confidence}")

    processing_time = round(time.time() - start_time, 4)

    # Save to document_classifications collection
    classification_record = {
        "document_id": document_id,
        "fingerprint": fingerprint,
        "document_type": final_doc_type,
        "confidence": final_confidence,
        "reason": final_reason,
        "classified_at": datetime.now(timezone.utc).isoformat(),
        "filename": filename,
        "page_count": page_count,
        "file_type": file_type,
        "processing_time": processing_time,
        "file_hash": file_hash
    }

    try:
        await db.document_classifications.insert_one(classification_record)
    except Exception as e:
        logger.error(f"Failed to save record to document_classifications collection: {e}")

    return {
        "document_type": final_doc_type,
        "confidence": final_confidence,
        "reason": final_reason,
        "fingerprint": fingerprint,
        "layer_used": layer_used
    }
