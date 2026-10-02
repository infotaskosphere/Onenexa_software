import io
import os
import logging
import time
import uuid
import base64
from typing import Dict, Any, List, Optional, Tuple
from PIL import Image

# Import helper modules
from backend.ai.pdf_text_extractor import is_searchable_pdf, extract_searchable_pdf_text
from backend.ai.page_splitter import split_pdf_pages, split_image_or_other
from backend.ai.image_preprocessor import preprocess_image_for_ocr
from backend.ai.image_optimizer import optimize_image_for_ocr
from backend.ai.ocr_selector import select_best_ocr_engine, register_ocr_engine, BaseOCREngine, estimate_metrics
from backend.ai.ocr_quality import evaluate_image_quality
from backend.ai.language_detector import detect_language
from backend.ai.ocr_storage import store_ocr_history, store_ocr_quality_report

logger = logging.getLogger("ocr_pipeline")

# Concrete Engines implementation

class GeminiVisionEngine(BaseOCREngine):
    def get_name(self) -> str:
        return "gemini_vision"
        
    def is_available(self) -> bool:
        import os
        return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
        
    async def extract_text_from_image(self, img_bytes: bytes, mime_type: str) -> Tuple[str, float]:
        # Route all OCR through ai_provider (Gemini path).
        from backend.ai.ai_provider import vision_single
        b64 = base64.b64encode(img_bytes).decode()
        prompt = (
            "You are a professional OCR engine. Transcribe all text from this image exactly as it appears. "
            "Do not add summaries, commentary, notes, or interpretations. Just output the verbatim transcribed text."
        )
        try:
            text = await vision_single(b64, mime_type, prompt)
            return text or "", 0.95
        except Exception as e:
            logger.error(f"Gemini Vision OCR extraction failed: {e}")
            raise

class GroqVisionEngine(BaseOCREngine):
    def get_name(self) -> str:
        return "groq_vision"
        
    def is_available(self) -> bool:
        import os
        return bool(os.environ.get("GROQ_API_KEY"))
        
    async def extract_text_from_image(self, img_bytes: bytes, mime_type: str) -> Tuple[str, float]:
        # Route all OCR through ai_provider (Groq path uses groq_batch_processor
        # internally for multi-image calls; single-image goes direct).
        from backend.ai.ai_provider import vision_single
        import os as _os
        b64 = base64.b64encode(img_bytes).decode()
        prompt = "Transcribe all text from this image verbatim. Do not summarize or explain."
        # Force Groq for this engine call regardless of global AI_PROVIDER,
        # so the OCR selector's engine choice is honoured.
        _prev = _os.environ.get("AI_PROVIDER")
        _os.environ["AI_PROVIDER"] = "groq"
        try:
            text = await vision_single(b64, mime_type, prompt)
            return text or "", 0.90
        except Exception as e:
            logger.error(f"Groq Vision OCR extraction failed: {e}")
            raise
        finally:
            if _prev is None:
                _os.environ.pop("AI_PROVIDER", None)
            else:
                _os.environ["AI_PROVIDER"] = _prev

class TesseractEngine(BaseOCREngine):
    def get_name(self) -> str:
        return "tesseract"
        
    def is_available(self) -> bool:
        try:
            import pytesseract
            # Check if tesseract binary is in path
            pytesseract.get_tesseract_version()
            return True
        except Exception:
            return False
            
    async def extract_text_from_image(self, img_bytes: bytes, mime_type: str) -> Tuple[str, float]:
        try:
            import pytesseract
            img = Image.open(io.BytesIO(img_bytes))
            text = pytesseract.image_to_string(img)
            # Estimate confidence based on orientation/data
            return text or "", 0.78
        except Exception as e:
            logger.error(f"Tesseract OCR failed: {e}")
            raise

class GoogleVisionEngine(BaseOCREngine):
    def get_name(self) -> str:
        return "google_vision"
        
    def is_available(self) -> bool:
        # Check for Google Application Credentials or package
        try:
            from google.cloud import vision
            return "GOOGLE_APPLICATION_CREDENTIALS" in os.environ
        except ImportError:
            return False
            
    async def extract_text_from_image(self, img_bytes: bytes, mime_type: str) -> Tuple[str, float]:
        try:
            from google.cloud import vision
            client = vision.ImageAnnotatorClient()
            image = vision.Image(content=img_bytes)
            response = client.document_text_detection(image=image)
            text = response.full_text_annotation.text
            return text or "", 0.97
        except Exception as e:
            logger.error(f"Google Cloud Vision OCR failed: {e}")
            raise

# Register standard engines on module import
register_ocr_engine("gemini_vision", GeminiVisionEngine())
register_ocr_engine("groq_vision", GroqVisionEngine())
register_ocr_engine("tesseract", TesseractEngine())
register_ocr_engine("google_vision", GoogleVisionEngine())


async def process_ocr_pipeline(
    contents: bytes,
    filename: str,
    document_id: Optional[str] = None
) -> Tuple[str, Dict[str, Any]]:
    """
    Orchestrates the entire modular OCR pipeline.
    Returns Tuple of (extracted_raw_text, ocr_metadata_dict)
    """
    start_time = time.time()
    doc_id = document_id or str(uuid.uuid4())
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    
    logger.info(f"OCR Pipeline: Started processing '{filename}' (ID: {doc_id})")
    
    # ── STEP 1: Detect Document Type ──
    doc_format = "Unknown"
    if ext in ("xlsx", "xlsm", "xls"):
        doc_format = "Excel"
    elif ext == "csv":
        doc_format = "CSV"
    elif ext == "pdf":
        doc_format = "PDF"
    elif ext in ("jpg", "jpeg", "png", "webp", "gif", "tiff", "tif"):
        doc_format = "Image"
    elif ext in ("doc", "docx"):
        doc_format = "Word"
    elif ext in ("txt", "text"):
        doc_format = "Text"
    elif ext == "zip":
        doc_format = "ZIP"
        
    # Non-OCR formats (Text, Excel, CSV) just return default extracted text
    if doc_format in ("Excel", "CSV", "Text"):
        logger.info(f"OCR Pipeline: Bypassing OCR for direct data format: {doc_format}")
        from backend.ai.ai_router import get_document_text_content
        text_content = get_document_text_content(contents, filename)
        duration = time.time() - start_time
        meta = {
            "engine_used": "native_text_reader",
            "processing_time": duration,
            "confidence": 1.0,
            "detected_language": "EN",
            "quality_score": 1.0,
            "pages_processed": 1
        }
        return text_content, meta

    # ── STEP 2: Detect Searchable PDF ──
    if doc_format == "PDF":
        is_searchable, embedded_text = is_searchable_pdf(contents)
        if is_searchable:
            logger.info("OCR Pipeline: Searchable PDF detected. Skipping heavy OCR and returning native text layer.")
            duration = time.time() - start_time
            detected_lang = detect_language(embedded_text)
            
            # Save to storage logs
            await store_ocr_history(
                document_id=doc_id,
                filename=filename,
                engine_used="native_pdf_reader",
                processing_time=duration,
                confidence=1.0,
                detected_language=detected_lang,
                quality_score=1.0,
                pages_processed=1
            )
            
            meta = {
                "engine_used": "native_pdf_reader",
                "processing_time": duration,
                "confidence": 1.0,
                "detected_language": detected_lang,
                "quality_score": 1.0,
                "pages_processed": 1
            }
            return embedded_text, meta

    # ── STEP 3: Split into pages (unlimited; batching handles size) ──
    pages = []
    if doc_format == "PDF":
        import os as _os
        try:
            _max_pages = int(_os.environ.get("OCR_MAX_PAGES", "0"))
        except ValueError:
            _max_pages = 0
        pages = split_pdf_pages(contents, max_pages=_max_pages or 10_000)
    else:
        pages = split_image_or_other(contents, filename)
    logger.info(f"OCR Pipeline: split into {len(pages)} page(s) for '{filename}'")
        
    if not pages:
        logger.warning("OCR Pipeline: No pages/frames could be extracted.")
        return "", {}

    # Initialize aggregators
    extracted_texts = []
    overall_confidence_sum = 0.0
    quality_score_sum = 0.0
    processed_count = 0
    engine_used = "unknown"
    fallback_engine_used = None
    
    # ── Process page-by-page ──
    for page_img, page_num in pages:
        # ── STEP 4: Quality Check ──
        quality_metrics = evaluate_image_quality(page_img)
        quality_score = quality_metrics["quality_score"]
        quality_score_sum += quality_score
        
        # Save Quality Report
        try:
            await store_ocr_quality_report(
                document_id=doc_id,
                filename=filename,
                blur=quality_metrics["blur"],
                noise=quality_metrics["noise"],
                contrast=quality_metrics["contrast"],
                rotation=quality_metrics["rotation"],
                resolution=quality_metrics["resolution"],
                ocr_confidence=quality_metrics["ocr_confidence"],
                text_completeness=quality_metrics["text_completeness"],
                quality_score=quality_score
            )
        except Exception as q_err:
            logger.error(f"Failed to store quality report: {q_err}")

        # ── STEP 5: Preprocessing ──
        # Deskew / Auto rotate based on quality/rotation if needed
        preprocessed_img = preprocess_image_for_ocr(page_img)
        
        # ── STEP 6: Image Optimization ──
        optimized_bytes = optimize_image_for_ocr(preprocessed_img)
        
        # ── STEP 7: Select Best OCR Engine ──
        selected_engine_id, fallbacks = select_best_ocr_engine(filename, quality_score)
        
        # Run OCR with dynamic retry/fallback mechanism
        page_text = ""
        engine_success = False
        tried_engines = [selected_engine_id] + fallbacks
        
        for engine_id in tried_engines:
            engine = get_registered_engines().get(engine_id)
            if not engine or not engine.is_available():
                continue
                
            try:
                logger.info(f"OCR Pipeline: Executing OCR engine '{engine_id}' for page {page_num}")
                text, conf = await engine.extract_text_from_image(optimized_bytes, "image/jpeg")
                if text.strip():
                    page_text = text
                    overall_confidence_sum += conf
                    engine_used = engine_id
                    if engine_id != selected_engine_id:
                        fallback_engine_used = engine_id
                        logger.info(f"OCR Pipeline: Fallback to engine '{engine_id}' was successful!")
                    engine_success = True
                    break
            except Exception as e:
                logger.warning(f"OCR Engine '{engine_id}' failed on page {page_num}: {e}. Trying fallback...")
                
        if not engine_success:
            logger.error(f"OCR Pipeline: All OCR engines failed for page {page_num}")
            
        extracted_texts.append(f"--- Page {page_num} ---\n{page_text}")
        processed_count += 1

    final_merged_text = "\n\n".join(extracted_texts)
    detected_lang = detect_language(final_merged_text)
    
    avg_quality = round(quality_score_sum / max(processed_count, 1), 2)
    avg_confidence = round(overall_confidence_sum / max(processed_count, 1), 2)
    duration = time.time() - start_time
    
    # Store complete execution log
    try:
        await store_ocr_history(
            document_id=doc_id,
            filename=filename,
            engine_used=engine_used,
            processing_time=duration,
            confidence=avg_confidence,
            detected_language=detected_lang,
            quality_score=avg_quality,
            pages_processed=processed_count,
            fallback_engine=fallback_engine_used
        )
    except Exception as h_err:
        logger.error(f"Failed to save final OCR history: {h_err}")

    ocr_meta = {
        "engine_used": engine_used,
        "processing_time": duration,
        "confidence": avg_confidence,
        "detected_language": detected_lang,
        "quality_score": avg_quality,
        "pages_processed": processed_count,
        "fallback_engine": fallback_engine_used
    }
    
    logger.info(f"OCR Pipeline: Finished processing. Engine: {engine_used}, Lang: {detected_lang}, Time: {duration:.2f}s")
    return final_merged_text, ocr_meta
