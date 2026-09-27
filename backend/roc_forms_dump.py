"""
ROC Forms Dump — historical MCA filing archive, extraction, provenance and
company-state reconciliation.

This module is intentionally separate from the existing ROC filing uploader.
The dump is an evidence/archive layer: it never treats a newly uploaded form
as the current truth without recording the source, confidence and conflicts.
Unknown MCA forms are retained and classified generically instead of rejected.
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

from backend.dependencies import db, check_module_permission, get_current_user
from backend.models import User

logger = logging.getLogger("roc_forms_dump")

router = APIRouter(tags=["roc-forms-dump"])

VIEW = check_module_permission("roc_sphere", "view")
CREATE = check_module_permission("roc_sphere", "create")
EDIT = check_module_permission("roc_sphere", "edit")

async def roc_job_access(current_user: User = Depends(get_current_user)):
    """Allow users who can operate ROC Sphere to follow their background jobs.

    Job polling is part of the upload workflow. A user may legitimately have
    create/manage access without a separate read flag being present in an
    older permission profile. Treat ROC read or manage access as sufficient
    for job-status reads, while keeping the module permission boundary intact.
    """
    if getattr(current_user, "role", None) == "admin":
        return current_user

    permissions = getattr(current_user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    elif not isinstance(permissions, dict):
        permissions = {}

    if permissions.get("can_view_roc_sphere") or permissions.get("can_manage_roc_sphere"):
        return current_user

    raise HTTPException(
        status_code=403,
        detail="Permission required: roc_sphere.view or roc_sphere.manage",
    )

COMPANIES = db.roc_companies
DUMP = db.roc_form_dump
CHUNKS = db.roc_form_dump_chunks
DOCS = db.roc_documents
# Persistent, per-classification keyword-weight table. This is what lets the
# classifier improve as reviewers verify or correct filings — a genuine
# incremental (Naive-Bayes-style) learning loop, not a marketing label.
LEARNING = db.roc_form_dump_learning

# Files accepted directly. ZIP/RAR archives are expanded and every eligible
# member inside (including nested folders and nested ZIP/RAR files) is run
# through the same pipeline as a directly uploaded file.
ALLOWED_EXT = (".pdf", ".xlsx", ".xlsm", ".xls", ".csv", ".docx")
ARCHIVE_EXT = (".zip", ".rar")
# .doc (legacy binary Word) and password-protected/scanned files cannot be
# read reliably without extra OCR/conversion infrastructure; they are still
# accepted and archived, just flagged NEEDS_REVIEW instead of silently
# rejected.
UNREADABLE_BUT_ACCEPTED_EXT = (".doc",)
CHUNK_SIZE = 512 * 1024
MAX_BATCH = 500 * 1024 * 1024
MAX_TEXT_STORE = 150_000
MAX_ZIP_MEMBERS = 2000
MAX_ZIP_NESTING = 5
MAX_ZIP_MEMBER_BYTES = 100 * 1024 * 1024
MAX_EXPANDED_FILES = 5000

ROC_JOBS = db.roc_form_dump_jobs
ROC_UPLOADS = db.roc_form_dump_uploads
ROC_STAGING_ROOT = Path(tempfile.gettempdir()) / "taskosphere_roc_dump_jobs"
ROC_STAGING_ROOT.mkdir(parents=True, exist_ok=True)
ROC_JOB_LOCK = asyncio.Lock()
ROC_JOB_TASKS = set()


def _now():
    return datetime.now(timezone.utc)


def _uid():
    return str(uuid.uuid4())


def _who(user):
    return getattr(user, "full_name", None) or getattr(user, "username", None) or "—"


def _safe_name(value):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_") or "ROC_Dump"


def _clean_text(text):
    return re.sub(r"[ \t\r]+", " ", str(text or "")).strip()


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _extract_pdf_text(raw):
    """Extract text from text-based PDFs, with pypdf as a second parser."""
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            page_count = len(pdf.pages)
            parts = []
            for page in pdf.pages:
                parts.append(page.extract_text(x_tolerance=1, y_tolerance=3) or "")
            text = "\n".join(parts).strip()
            if text:
                return text, page_count
    except Exception as exc:
        logger.warning("ROC dump pdfplumber extraction failed: %s", exc)

    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        parts = [(page.extract_text() or "") for page in reader.pages]
        return "\n".join(parts), len(reader.pages)
    except Exception as exc:
        logger.warning("ROC dump pypdf extraction failed: %s", exc)
        return "", 0


def _extract_workbook_text(filename, raw):
    try:
        lower_name = str(filename or "").lower()

        if lower_name.endswith(".xls"):
            import xlrd
            book = xlrd.open_workbook(file_contents=raw, on_demand=True)
            lines = []
            try:
                for sheet in book.sheets():
                    lines.append(f"[SHEET: {sheet.name}]")
                    for row_index in range(sheet.nrows):
                        values = [
                            _clean_text(sheet.cell_value(row_index, col_index))
                            for col_index in range(sheet.ncols)
                        ]
                        values = [value for value in values if value]
                        if values:
                            lines.append(" | ".join(values))
            finally:
                book.release_resources()
            return "\n".join(lines), 0

        import openpyxl
        # data_only=True gives the cached/display value of formula cells.
        # A second pass with formulas enabled fills cells where the workbook
        # has no cached result, so formula-heavy ROC workbooks are not blank.
        wb_values = openpyxl.load_workbook(
            io.BytesIO(raw),
            read_only=True,
            data_only=True,
            keep_vba=lower_name.endswith(".xlsm"),
        )
        wb_formulas = None
        try:
            lines = []
            for ws in wb_values.worksheets:
                lines.append(f"[SHEET: {ws.title}]")
                for row in ws.iter_rows(values_only=True):
                    values = [_clean_text(value) for value in row if value is not None]
                    if values:
                        lines.append(" | ".join(values))

            if not any(line.strip() for line in lines[1:]):
                wb_formulas = openpyxl.load_workbook(
                    io.BytesIO(raw),
                    read_only=True,
                    data_only=False,
                    keep_vba=lower_name.endswith(".xlsm"),
                )
                lines = []
                for ws in wb_formulas.worksheets:
                    lines.append(f"[SHEET: {ws.title}]")
                    for row in ws.iter_rows(values_only=True):
                        values = [_clean_text(value) for value in row if value is not None]
                        if values:
                            lines.append(" | ".join(values))
            return "\n".join(lines), 0
        finally:
            wb_values.close()
            if wb_formulas is not None:
                wb_formulas.close()
    except Exception as exc:
        logger.warning("ROC dump workbook extraction failed for %s: %s", filename, exc)
        return "", 0


def _extract_docx_text(raw):
    """Read DOCX body, tables, headers and footers without losing table data."""
    try:
        doc = DocxDocument(io.BytesIO(raw))
        lines = []

        for section in doc.sections:
            for para in section.header.paragraphs:
                text = _clean_text(para.text)
                if text:
                    lines.append(f"[HEADER] {text}")
            for para in section.footer.paragraphs:
                text = _clean_text(para.text)
                if text:
                    lines.append(f"[FOOTER] {text}")

        for block in doc.paragraphs:
            text = _clean_text(block.text)
            if text:
                lines.append(text)

        for table in doc.tables:
            for row in table.rows:
                cells = [_clean_text(cell.text) for cell in row.cells]
                cells = [cell for cell in cells if cell]
                if cells:
                    lines.append(" | ".join(cells))

        return "\n".join(lines), 0
    except Exception as exc:
        logger.warning("ROC dump .docx extraction failed: %s", exc)
        return "", 0


def _decode_text_bytes(raw):
    """Decode CSV/text payloads with UTF-8 first, then a detected legacy encoding."""
    try:
        return raw.decode("utf-8-sig"), 0
    except UnicodeDecodeError:
        pass

    try:
        import chardet
        detected = chardet.detect(raw)
        encoding = detected.get("encoding") if detected else None
        if encoding:
            return raw.decode(encoding, errors="replace"), 0
    except Exception as exc:
        logger.warning("ROC dump text encoding detection failed: %s", exc)

    return raw.decode("utf-8", errors="replace"), 0


def _extract_legacy_doc_text(raw):
    """Best-effort extraction for old binary .doc files when a system extractor exists."""
    with tempfile.TemporaryDirectory(prefix="roc_doc_") as temp_dir:
        source = f"{temp_dir}/document.doc"
        with open(source, "wb") as handle:
            handle.write(raw)

        for command in ("antiword", "catdoc"):
            try:
                result = subprocess.run(
                    [command, source],
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
            except (FileNotFoundError, subprocess.SubprocessError):
                continue
            if result.returncode == 0:
                text = result.stdout.decode("utf-8", errors="replace").strip()
                if text:
                    return text, 0
    return "", 0


def _extract_text(filename, raw):
    name = str(filename or "").lower()
    if name.endswith(".pdf"):
        return _extract_pdf_text(raw)
    if name.endswith((".xlsx", ".xlsm", ".xls")):
        return _extract_workbook_text(name, raw)
    if name.endswith(".docx"):
        return _extract_docx_text(raw)
    if name.endswith(UNREADABLE_BUT_ACCEPTED_EXT):
        return _extract_legacy_doc_text(raw)
    return _decode_text_bytes(raw)


def _safe_relative_path(name: str) -> str:
    """Normalize user/ZIP supplied paths before storing them as provenance."""
    raw_name = str(name or "").replace("\\", "/")
    parts = []
    for part in raw_name.split("/"):
        part = part.strip()
        if not part or part == ".":
            continue
        if part == "..":
            continue
        part = re.sub(r"^[A-Za-z]:$", "", part)
        part = re.sub(r"[\\x00-\\x1f]", "", part)
        if part:
            parts.append(part)
    return "/".join(parts) or "roc-form"



def _archive_kind(filename: str) -> str:
    lower = str(filename or "").lower()
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(".rar"):
        return "rar"
    return ""


def _rar_member_payloads_with_7zip(raw: bytes, archive_name: str) -> List[Tuple[str, bytes]]:
    """RAR fallback that does not require the Python rarfile module at import time.

    Render images can have 7-Zip available even when the optional Python
    wrapper is absent. Listing and extracting one eligible member at a time
    keeps the same path/size limits used by the native ZIP/RAR path.
    """
    tool = shutil.which("7z") or shutil.which("7zz") or shutil.which("7zr")
    if not tool:
        raise RuntimeError(
            "RAR5 support is unavailable: neither rarfile nor a 7-Zip executable is installed."
        )

    with tempfile.TemporaryDirectory(prefix="roc_rar_") as temp_dir:
        archive_path = Path(temp_dir) / "upload.rar"
        archive_path.write_bytes(raw)

        listed = subprocess.run(
            [tool, "l", "-slt", str(archive_path)],
            capture_output=True,
            timeout=120,
            check=False,
        )
        if listed.returncode != 0:
            detail = listed.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(f"7-Zip could not read RAR archive: {detail or 'unknown error'}")

        listing = listed.stdout.decode("utf-8", errors="replace")
        names: List[str] = []
        current: Dict[str, str] = {}
        for line in listing.splitlines() + [""]:
            if not line.strip():
                if current.get("Path") and current.get("Folder") != "+":
                    names.append(current["Path"])
                current = {}
                continue
            key, separator, value = line.partition(" = ")
            if separator:
                current[key.strip()] = value

        members: List[Tuple[str, bytes]] = []
        state = {"files": 0, "bytes": 0}

        for member_name in names:
            if state["files"] >= MAX_EXPANDED_FILES:
                break

            safe_name = _safe_relative_path(member_name)
            base = safe_name.rsplit("/", 1)[-1]
            if not base or base.startswith("."):
                continue
            if "__MACOSX" in safe_name or base.lower() in {"thumbs.db", "desktop.ini"}:
                continue

            lower = base.lower()
            if not lower.endswith(ALLOWED_EXT + UNREADABLE_BUT_ACCEPTED_EXT + ARCHIVE_EXT):
                continue

            # Extract exactly this member to stdout. No archive contents are
            # written into a path controlled by the archive.
            extracted = subprocess.run(
                [tool, "x", "-so", str(archive_path), "--", member_name],
                capture_output=True,
                timeout=120,
                check=False,
            )
            if extracted.returncode != 0:
                logger.warning(
                    "ROC dump 7-Zip member unreadable %s: %s",
                    safe_name,
                    extracted.stderr.decode("utf-8", errors="replace").strip(),
                )
                continue

            member_raw = extracted.stdout
            if len(member_raw) > MAX_ZIP_MEMBER_BYTES:
                logger.warning("ROC dump RAR member too large: %s", safe_name)
                continue
            if state["bytes"] + len(member_raw) > MAX_BATCH:
                logger.warning("ROC dump RAR expansion reached MAX_BATCH at %s", safe_name)
                break

            state["files"] += 1
            state["bytes"] += len(member_raw)
            members.append((f"{archive_name}/{safe_name}", member_raw))

        return members


def _iter_archive_members(
    raw: bytes,
    path_prefix: str = "",
    depth: int = 0,
    state: Optional[Dict[str, int]] = None,
) -> List[Tuple[str, bytes]]:
    """Expand ZIP/RAR recursively while preserving paths and bounding expansion."""
    if state is None:
        state = {"files": 0, "bytes": 0}

    members: List[Tuple[str, bytes]] = []
    if depth > MAX_ZIP_NESTING:
        logger.warning("ROC dump archive nesting limit reached at %s", path_prefix)
        return members

    kind = _archive_kind(path_prefix or "archive.zip")

    if kind == "zip":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                infos = [info for info in archive.infolist() if not info.is_dir()]
                for info in infos:
                    if state["files"] >= MAX_EXPANDED_FILES:
                        logger.warning("ROC dump archive expansion stopped at %s files", MAX_EXPANDED_FILES)
                        break
                    name = _safe_relative_path(info.filename)
                    base = name.rsplit("/", 1)[-1]
                    if not base or base.startswith("."):
                        continue
                    if "__MACOSX" in name or base.lower() in {"thumbs.db", "desktop.ini"}:
                        continue
                    if info.file_size > MAX_ZIP_MEMBER_BYTES:
                        logger.warning("ROC dump ZIP member too large: %s (%s bytes)", name, info.file_size)
                        continue
                    if state["bytes"] + info.file_size > MAX_BATCH:
                        logger.warning("ROC dump ZIP expansion reached MAX_BATCH at %s", name)
                        break
                    try:
                        member_raw = archive.read(info)
                    except Exception as exc:
                        logger.warning("ROC dump ZIP member unreadable %s: %s", name, exc)
                        continue
                    if len(member_raw) > MAX_ZIP_MEMBER_BYTES:
                        logger.warning("ROC dump ZIP member expanded beyond limit: %s", name)
                        continue
                    if state["bytes"] + len(member_raw) > MAX_BATCH:
                        logger.warning("ROC dump ZIP expansion reached MAX_BATCH at %s", name)
                        break

                    relative_name = f"{path_prefix}/{name}" if path_prefix else name
                    lower = base.lower()
                    if lower.endswith(ARCHIVE_EXT):
                        state["bytes"] += len(member_raw)
                        members.extend(_iter_archive_members(member_raw, relative_name, depth + 1, state))
                    elif lower.endswith(ALLOWED_EXT + UNREADABLE_BUT_ACCEPTED_EXT):
                        state["files"] += 1
                        state["bytes"] += len(member_raw)
                        members.append((relative_name, member_raw))
        except zipfile.BadZipFile as exc:
            raise ValueError(f"not a valid ZIP archive ({exc})") from exc
        return members

    if kind == "rar":
        try:
            import rarfile

            with rarfile.RarFile(io.BytesIO(raw)) as archive:
                infos = [info for info in archive.infolist() if not info.isdir()]
                for info in infos:
                    if state["files"] >= MAX_EXPANDED_FILES:
                        logger.warning("ROC dump archive expansion stopped at %s files", MAX_EXPANDED_FILES)
                        break
                    name = _safe_relative_path(info.filename)
                    base = name.rsplit("/", 1)[-1]
                    if not base or base.startswith("."):
                        continue
                    if "__MACOSX" in name or base.lower() in {"thumbs.db", "desktop.ini"}:
                        continue

                    declared_size = int(getattr(info, "file_size", 0) or 0)
                    if declared_size > MAX_ZIP_MEMBER_BYTES:
                        logger.warning("ROC dump RAR member too large: %s (%s bytes)", name, declared_size)
                        continue
                    if declared_size and state["bytes"] + declared_size > MAX_BATCH:
                        logger.warning("ROC dump RAR expansion reached MAX_BATCH at %s", name)
                        break

                    lower = base.lower()
                    if not lower.endswith(ALLOWED_EXT + UNREADABLE_BUT_ACCEPTED_EXT + ARCHIVE_EXT):
                        continue

                    try:
                        member_raw = archive.read(info)
                    except Exception as exc:
                        logger.warning("ROC dump RAR member unreadable %s: %s", name, exc)
                        continue
                    if len(member_raw) > MAX_ZIP_MEMBER_BYTES:
                        logger.warning("ROC dump RAR member expanded beyond limit: %s", name)
                        continue
                    if state["bytes"] + len(member_raw) > MAX_BATCH:
                        logger.warning("ROC dump RAR expansion reached MAX_BATCH at %s", name)
                        break

                    relative_name = f"{path_prefix}/{name}" if path_prefix else name
                    if lower.endswith(ARCHIVE_EXT):
                        state["bytes"] += len(member_raw)
                        members.extend(_iter_archive_members(member_raw, relative_name, depth + 1, state))
                    else:
                        state["files"] += 1
                        state["bytes"] += len(member_raw)
                        members.append((relative_name, member_raw))
            return members
        except ModuleNotFoundError:
            # Do not make application startup dependent on an optional Python
            # package. The production build installs 7-Zip and this fallback
            # keeps RAR5 processing available even if the Python wrapper was
            # omitted by a custom Render build command.
            fallback = _rar_member_payloads_with_7zip(raw, path_prefix or "archive.rar")
            for relative_name, member_raw in fallback:
                base = relative_name.rsplit("/", 1)[-1].lower()
                if base.endswith(ARCHIVE_EXT):
                    state["bytes"] += len(member_raw)
                    members.extend(_iter_archive_members(member_raw, relative_name, depth + 1, state))
                else:
                    state["files"] += 1
                    state["bytes"] += len(member_raw)
                    members.append((relative_name, member_raw))
            return members
        except Exception as exc:
            if isinstance(exc, (ValueError, OSError)):
                raise ValueError(f"not a readable RAR archive ({exc})") from exc
            raise


    raise ValueError(f"unsupported archive format: {path_prefix}")



def _form_number(filename, text):
    hay = f"{filename}\n{text[:12000]}"
    patterns = (
        r"\bFORM\s*(?:NO\.?\s*)?([A-Z]{1,8})\s*[-/]?\s*(\d{1,3})\b",
        r"\bE[- ]?FORM\s*(?:NO\.?\s*)?([A-Z]{1,8})\s*[-/]?\s*(\d{1,3})\b",
        r"\b([A-Z]{1,8})\s*[-/]\s*(\d{1,3})\b",
        r"\b([A-Z]{1,8})(\d{1,3})\b",
    )
    for pattern in patterns:
        match = re.search(pattern, hay, re.I)
        if match:
            prefix = match.group(1).upper()
            number = int(match.group(2))
            return f"{prefix}-{number}", prefix, number
    # Numeric form references are retained too (useful for old MCA forms).
    match = re.search(r"\bFORM\s*(?:NO\.?\s*)?(\d{1,3})\b", hay, re.I)
    if match:
        number = int(match.group(1))
        return f"FORM-{number}", "FORM", number
    return "UNKNOWN", "UNKNOWN", None


def _classify(form, text):
    hay = f"{form}\n{text[:18000]}".lower()
    if re.search(r"\b(sh[- ]?4|securities transfer form|transferor.*transferee)", hay):
        return "share_transfer"
    if re.search(r"\bdir[- ]?12\b|appointment.*director|cessation.*director|change.*designation", hay):
        return "director_change"
    if re.search(r"\bdir[- ]?11\b|notice of resignation", hay):
        return "director_resignation"
    if re.search(r"\bpas[- ]?3\b|return of allotment|intimation of allotment", hay):
        return "share_allotment"
    if re.search(r"\b(aoc[- ]?4|aoc[- ]?4xbrl)\b|balance sheet|statement of profit", hay):
        return "financial"
    if re.search(r"\bmgt[- ]?(7a?|6)\b|annual return|register of members", hay):
        return "annual_return"
    if re.search(r"\bdpt[- ]?3\b|amount of outstanding loan|non.?deposit|deposits", hay):
        return "loan_deposit"
    if re.search(r"\bchg[- ]?\d+\b|charge holder|creation of charge|modification of charge|satisfaction of charge", hay):
        return "charge"
    if re.search(r"\badt[- ]?1\b|appointment of auditor|statutory auditor", hay):
        return "auditor"
    if re.search(r"\binc[- ]?22\b|registered office", hay):
        return "registered_office"
    if re.search(r"\bmgt[- ]?14\b|resolution.*registrar", hay):
        return "resolution"
    if re.search(r"\b(dir[- ]?3|dir[- ]?3\s*kyc)\b", hay):
        return "director_kyc"
    if re.search(r"\bspice|inc[- ]?7|inc[- ]?20|inc[- ]?32|inc[- ]?33|inc[- ]?34\b|certificate of incorporation", hay):
        return "incorporation"
    return "other"


CLASSIFICATION_LABELS = (
    "share_transfer", "director_change", "director_resignation", "share_allotment",
    "financial", "annual_return", "loan_deposit", "charge", "auditor",
    "registered_office", "resolution", "director_kyc", "incorporation", "other",
)
_TOKEN_RE = re.compile(r"[a-z]{4,}")


def _tokenize(text: str) -> List[str]:
    # Common words carry no classification signal and would just dilute the
    # learned weight table, so they're dropped before counting.
    stop = {
        "shall", "form", "company", "companies", "pursuant", "section", "rules",
        "please", "signature", "date", "number", "name", "registrar", "office",
        "under", "with", "that", "this", "have", "been", "were", "from", "their",
    }
    return [t for t in _TOKEN_RE.findall((text or "").lower()) if t not in stop]


async def _learned_weights(company_id: Optional[str] = None) -> Dict[str, Counter]:
    """Load the persistent keyword-weight table. Company-scoped weights are
    blended with the global table so patterns learned on one client's filings
    also help classify a brand-new client's forms from day one."""
    weights: Dict[str, Counter] = {label: Counter() for label in CLASSIFICATION_LABELS}
    async for doc in LEARNING.find({"scope": {"$in": ["global"] + ([company_id] if company_id else [])}}):
        counts = doc.get("token_counts") or {}
        bucket = weights.setdefault(doc.get("classification", "other"), Counter())
        for token, count in counts.items():
            bucket[token] += int(count or 0)
    return weights


def _learning_boost(text: str, weights: Dict[str, Counter]) -> Tuple[Optional[str], float]:
    """Score the document's tokens against everything learned from prior
    reviewer corrections/confirmations. Returns the best-matching learned
    classification and a 0..1 confidence contribution — this is what lets
    the archive keep getting more accurate the more it is used, without any
    hardcoded regex for the pattern reviewers just confirmed."""
    tokens = _tokenize(text[:20000])
    if not tokens:
        return None, 0.0
    token_counts = Counter(tokens)
    scores: Dict[str, float] = {}
    for label, bucket in weights.items():
        if not bucket:
            continue
        total = sum(bucket.values()) or 1
        score = sum(token_counts[t] * (bucket.get(t, 0) / total) for t in token_counts)
        if score:
            scores[label] = score
    if not scores:
        return None, 0.0
    best_label = max(scores, key=scores.get)
    top = scores[best_label]
    runner_up = sorted(scores.values(), reverse=True)[1] if len(scores) > 1 else 0.0
    margin = (top - runner_up) / top if top else 0.0
    return best_label, min(0.25, round(margin * 0.25, 3))


async def _classify_with_learning(form: str, text: str, company_id: Optional[str] = None):
    """Static regex classification is the reliable baseline; the learned
    table only steps in when the regexes found nothing (classification ==
    'other') and only if it has already seen enough confirmed examples of a
    pattern to be useful."""
    base = _classify(form, text)
    weights = await _learned_weights(company_id)
    learned_label, boost = _learning_boost(text, weights)
    if base == "other" and learned_label and learned_label != "other" and boost > 0.05:
        return learned_label, boost, True
    return base, 0.0, False


async def _record_learning_feedback(company_id: str, classification: str, text: str,
                                     previous_classification: Optional[str] = None):
    """Feed a confirmed (or reviewer-corrected) classification back into the
    persistent weight table, at both the company and global scope. This is
    the mechanism by which the archive 'evolves': every VERIFIED filing or
    manual correction makes the next similarly-worded filing easier to
    classify automatically."""
    if classification not in CLASSIFICATION_LABELS or classification == "other":
        return
    tokens = _tokenize(text[:20000])
    if not tokens:
        return
    counts = dict(Counter(tokens))
    now = _now()
    for scope in (company_id, "global"):
        await LEARNING.update_one(
            {"scope": scope, "classification": classification},
            {
                "$inc": {f"token_counts.{tok}": n for tok, n in counts.items()},
                "$set": {"updated_at": now},
                "$setOnInsert": {"scope": scope, "classification": classification, "created_at": now},
            },
            upsert=True,
        )
    # A correction is a stronger, explicit negative signal than an
    # unreviewed guess — down-weight the tokens under whichever label the
    # heuristics/learning had wrongly proposed, so the same mistake is less
    # likely next time.
    if previous_classification and previous_classification != classification and previous_classification in CLASSIFICATION_LABELS:
        for scope in (company_id, "global"):
            await LEARNING.update_one(
                {"scope": scope, "classification": previous_classification},
                {"$inc": {f"token_counts.{tok}": -max(1, n // 2) for tok, n in counts.items()}},
            )


def _find(patterns, text, flags=re.I | re.S):
    for pattern in patterns:
        match = re.search(pattern, text or "", flags)
        if match:
            value = match.group(1) if match.lastindex else match.group(0)
            value = _clean_text(value)
            if value:
                return value
    return None


def _number(value):
    if value is None:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(value).replace(",", ""))
    try:
        return float(cleaned)
    except Exception:
        return None


def _date_candidates(text):
    candidates = []
    for match in re.finditer(r"\b([0-3]?\d)[/-]([01]?\d)[/-]((?:19|20)\d{2})\b", text or ""):
        try:
            day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            if 1 <= month <= 12 and 1 <= day <= 31:
                candidates.append(f"{year:04d}-{month:02d}-{day:02d}")
        except Exception:
            pass
    return list(dict.fromkeys(candidates))


def _extract_company(text):
    cin = _find([r"\b([LU][0-9A-Z]{20})\b", r"Corporate Identity Number\s*[:\-]?\s*([A-Z0-9]{21})"], text)
    name = _find([
        r"Name of (?:the )?(?:company|entity)\s*[:\-]?\s*([^\n]{3,160})",
        r"Company Name\s*[:\-]?\s*([^\n]{3,160})",
        r"Name of the company\s*([^\n]{3,160})",
    ], text)
    address = _find([
        r"registered office(?: address)?\s*[:\-]?\s*([^\n]{10,300})",
        r"address of the registered office[^\n]*\n([^\n]{10,300})",
    ], text)
    return {"cin": cin, "company_name": name, "registered_office_address": address}


def _extract_people(text):
    people = []
    # DIN/name pairs are deliberately conservative.
    for match in re.finditer(r"\b(\d{8})\b.{0,180}?([A-Z][A-Za-z .,'&()-]{2,100})", text or "", re.S):
        din, name = match.group(1), _clean_text(match.group(2))
        if re.search(r"number|date|meeting|director identification", name, re.I):
            continue
        if any(p["din"] == din for p in people):
            continue
        people.append({"name": name.strip(" -:"), "din": din})
        if len(people) >= 100:
            break
    return people


def _extract_share_transfer(text):
    transferor = _find([
        r"Transferor(?:\(s\))?[^\n:]*[:\-]\s*([^\n]{2,160})",
        r"Name of the Transferor[^\n]*\n\s*([^\n]{2,160})",
    ], text)
    transferee = _find([
        r"Transferee(?:\(s\))?[^\n:]*[:\-]\s*([^\n]{2,160})",
        r"Name of the Transferee[^\n]*\n\s*([^\n]{2,160})",
    ], text)
    shares = _find([
        r"No\. of securities being transferred[^\d]*([\d,]+(?:\.\d+)?)",
        r"Number of securities transferred[^\d]*([\d,]+(?:\.\d+)?)",
    ], text)
    consideration = _find([r"Consideration(?: received)?[^\d]*([\d,]+(?:\.\d+)?)"], text)
    certificate = _find([r"Certificate Nos?\.?[^\d]*([A-Za-z0-9, /-]+)"], text)
    distinctive_from = _find([r"Distinctive number.*?From[^\d]*([\d]+)"], text)
    distinctive_to = _find([r"Distinctive number.*?To[^\d]*([\d]+)"], text)
    transfer_date = _find([
        r"Date of execution[^\d]*([0-3]?\d/[01]?\d/\d{4})",
        r"Date of transfer[^\d]*([0-3]?\d/[01]?\d/\d{4})",
    ], text)
    return {
        "transferor_name": transferor,
        "transferee_name": transferee,
        "number_of_shares": _number(shares),
        "consideration": _number(consideration) or 0,
        "share_certificate_no": certificate,
        "distinctive_from": distinctive_from,
        "distinctive_to": distinctive_to,
        "transfer_date": transfer_date,
        "class_of_shares": _find([r"Kind/ Class of securities\s*[:\-]?\s*([^\n]{2,80})"], text) or "Equity",
    }


def _extract_financial(text):
    fields = {}
    patterns = {
        "net_worth": [r"Net worth(?: of the company)?[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "turnover": [r"Turnover[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "total_income": [r"Total income[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "total_expenses": [r"Total expenses[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "profit_before_tax": [r"Profit before tax[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "profit_after_tax": [r"Profit(?:/| /)?\s*\(Loss\).*?(?:after tax|for the period)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "share_capital": [r"Share capital[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "reserves_and_surplus": [r"Reserves?(?: and| &) surplus[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "balance_sheet_total": [r"(?:Total assets|Balance Sheet Total)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
    }
    for key, pats in patterns.items():
        value = _find(pats, text)
        number = _number(value)
        if number is not None:
            fields[key] = number
    return fields


def _extract_loans(text):
    fields = {}
    for key, patterns in {
        "outstanding_loans": [r"(?:outstanding loan|loan outstanding|outstanding money|borrowings)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "deposits_outstanding": [r"deposits? outstanding[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "charges_count": [r"Number of charges[^\d]*([\d,]+)"],
    }.items():
        value = _find(patterns, text)
        number = _number(value)
        if number is not None:
            fields[key] = number
    lender = _find([r"(?:name of charge holder|charge holder|lender)\s*[:\-]?\s*([^\n]{3,160})"], text)
    if lender:
        fields["lender"] = lender
    return fields


def _extract_auditor(text):
    return {
        "name": _find([r"Name of (?:the )?Auditor(?:\s+or Auditor's Firm)?\s*[:\-]?\s*([^\n]{2,160})"], text),
        "firm_reg_no": _find([r"(?:Firm Registration Number|registration number of auditor.?s firm)\s*[:\-]?\s*([A-Z0-9-]+)"], text),
        "membership_no": _find([r"Membership Number(?: of Auditor)?\s*[:\-]?\s*(\d+)"], text),
    }


def _extract_metadata(form, text):
    dates = _date_candidates(text[:30000])
    srn = _find([r"(?:SRN|Service Request Number)\s*[:\-]?\s*([A-Z0-9]+)"], text)
    filing_date = _find([r"(?:eForm )?filing date\s*[:\-]?\s*([0-3]?\d/[01]?\d/\d{4})"], text)
    fy = _find([
        r"(?:financial year|F\.Y\.?|FY)\s*(?:from)?\s*[:\-]?\s*(20\d{2}\s*[-/]\s*(?:20)?\d{2})",
        r"\b(20\d{2}\s*[-/]\s*(?:20)?\d{2})\b",
    ], text[:12000])
    return {
        "srn": srn,
        "filing_date": filing_date,
        "financial_year": fy,
        "event_dates": dates[:50],
    }


def _events_for(form_type, form_number, extracted, metadata):
    events = []
    event_date = (metadata.get("event_dates") or [None])[0]
    if form_type in {"director_change", "director_resignation"}:
        for person in extracted.get("directors") or []:
            action = "resignation_or_cessation" if form_type == "director_resignation" else "director_change"
            events.append({
                "event_type": "director",
                "action": action,
                "event_date": event_date,
                "person": person,
            })
    if form_type == "share_transfer" and extracted.get("share_transfer"):
        transfer = extracted["share_transfer"]
        if transfer.get("transferor_name") and transfer.get("transferee_name") and (transfer.get("number_of_shares") or 0) > 0:
            events.append({
                "event_type": "share_transfer",
                "event_date": transfer.get("transfer_date") or event_date,
                "transfer": transfer,
                "register_eligible": True,
            })
    if form_type == "share_allotment":
        events.append({
            "event_type": "share_allotment",
            "event_date": event_date,
            "data": extracted.get("financial") or {},
        })
    if form_type == "loan_deposit":
        events.append({"event_type": "loan_or_deposit", "event_date": event_date, "data": extracted.get("loans") or {}})
    if form_type == "charge":
        events.append({"event_type": "charge", "event_date": event_date, "data": extracted.get("loans") or {}})
    if form_type == "financial":
        events.append({"event_type": "financial", "event_date": event_date, "data": extracted.get("financial") or {}})
    if form_type == "auditor":
        events.append({"event_type": "auditor", "event_date": event_date, "data": extracted.get("auditor") or {}})
    if form_type == "registered_office":
        address = extracted.get("company", {}).get("registered_office_address")
        if address:
            events.append({"event_type": "registered_office", "event_date": event_date, "data": {"address": address}})
    if form_type == "incorporation":
        events.append({"event_type": "incorporation", "event_date": event_date, "data": extracted.get("company") or {}})
    return events


def _confidence(extracted, text, form_type, learning_boost: float = 0.0):
    score = 0.35
    if text.strip():
        score += 0.20
    if extracted.get("company", {}).get("cin"):
        score += 0.15
    if extracted.get("metadata", {}).get("srn"):
        score += 0.10
    if form_type != "other":
        score += 0.10
    if extracted.get("events"):
        score += 0.10
    # Filings classified purely from learned reviewer patterns (no static
    # regex match) get a smaller, capped boost rather than the full +0.10 a
    # confident regex match earns — the system is still less sure than a
    # hand-written rule until more examples accumulate.
    score += learning_boost
    return min(score, 0.99)


def _dedupe_key(event):
    return hashlib.sha256(json.dumps(event, sort_keys=True, default=str).encode()).hexdigest()


def _summary_sections(company, filings, events):
    directors = [e for e in events if e.get("event_type") == "director"]
    transfers = [e for e in events if e.get("event_type") == "share_transfer"]
    financials = [e for e in events if e.get("event_type") == "financial"]
    loans = [e for e in events if e.get("event_type") in {"loan_or_deposit", "charge"}]
    auditors = [e for e in events if e.get("event_type") == "auditor"]
    offices = [e for e in events if e.get("event_type") == "registered_office"]
    incorporation = [e for e in events if e.get("event_type") == "incorporation"]
    return {
        "company": {
            "name": company.get("company_name"),
            "cin": company.get("cin"),
            "date_of_incorporation": company.get("date_of_incorporation"),
            "registered_office_address": company.get("registered_office_address"),
            "category": company.get("category"),
            "paid_up_capital": company.get("paid_up_capital"),
            "authorized_capital": company.get("authorized_capital"),
        },
        "current_directors": company.get("directors") or company.get("designated_partners") or [],
        "current_shareholders": company.get("shareholders") or [],
        "current_auditor": company.get("auditor") or {},
        "current_net_worth": (company.get("financial_data") or {}).get("net_worth"),
        "current_loans_and_dpt3": company.get("dpt3_data") or {},
        "incorporation_history": incorporation,
        "directors_and_kmp_history": directors,
        "share_transfer_history": transfers,
        "financial_history": financials,
        "loans_and_charges_history": loans,
        "auditor_history": auditors,
        "registered_office_history": offices,
        "filing_inventory": [
            {
                "id": f.get("id"),
                "filename": f.get("filename"),
                "form_number": f.get("form_number"),
                "classification": f.get("classification"),
                "srn": f.get("metadata", {}).get("srn"),
                "financial_year": f.get("metadata", {}).get("financial_year"),
                "filing_date": f.get("metadata", {}).get("filing_date"),
                "status": f.get("status"),
                "confidence": f.get("confidence"),
            }
            for f in filings
        ],
        "review_items": [
            {
                "filename": f.get("filename"),
                "status": f.get("status"),
                "warnings": f.get("warnings") or [],
                "errors": f.get("errors") or [],
            }
            for f in filings if f.get("status") != "SUCCESS"
        ],
    }


def _build_summary_doc(company, summary, prepared_by):
    doc = DocxDocument()
    sec = doc.sections[0]
    sec.top_margin = Pt(36)
    sec.bottom_margin = Pt(36)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(str(company.get("company_name") or "Company").upper())
    run.bold = True
    run.font.size = Pt(16)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run(f"CIN/LLPIN: {company.get('cin') or '—'}")
    doc.add_paragraph("COMPANY SUMMARY — GENERATED FROM ROC FORMS DUMP").runs[0].bold = True

    def section(title, rows):
        doc.add_heading(title, level=2)
        if isinstance(rows, dict):
            for key, value in rows.items():
                doc.add_paragraph(f"{key.replace('_', ' ').title()}: {value}")
        elif isinstance(rows, list):
            for item in rows:
                doc.add_paragraph(json.dumps(item, ensure_ascii=False, default=str))
        else:
            doc.add_paragraph(str(rows or "—"))

    section("1. Company Master", summary["company"])
    section("2. Incorporation History", summary["incorporation_history"])
    section("3. Current Directors / KMP", summary["current_directors"])
    section("4. Current Shareholders", summary["current_shareholders"])
    section("5. Current Auditor", summary["current_auditor"])
    section("6. Current Net Worth", summary["current_net_worth"])
    section("7. Current Loans / DPT-3 Data", summary["current_loans_and_dpt3"])
    section("8. Directors / KMP History", summary["directors_and_kmp_history"])
    section("9. Share Transfer History", summary["share_transfer_history"])
    section("10. Financial / Net Worth History", summary["financial_history"])
    section("11. Loans / Charges History", summary["loans_and_charges_history"])
    section("12. Auditor History", summary["auditor_history"])
    section("13. Registered Office History", summary["registered_office_history"])
    section("14. ROC Forms Inventory", summary["filing_inventory"])
    section("15. Review / Exceptions", summary["review_items"])
    doc.add_paragraph(
        "This document is an evidence-based working summary generated from uploaded ROC forms. "
        "Values with low extraction confidence or unresolved conflicts remain review items and are not "
        "silently treated as verified statutory truth."
    )
    doc.add_paragraph(f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


async def _store_chunks(filing_id, raw):
    await CHUNKS.delete_many({"filing_id": filing_id})
    for index in range(0, len(raw), CHUNK_SIZE):
        chunk = raw[index:index + CHUNK_SIZE]
        await CHUNKS.insert_one({
            "filing_id": filing_id,
            "seq": index // CHUNK_SIZE,
            "data_b64": base64.b64encode(chunk).decode("ascii"),
        })


async def _load_chunks(filing_id):
    cursor = CHUNKS.find({"filing_id": filing_id}).sort("seq", 1)
    parts = []
    async for row in cursor:
        parts.append(base64.b64decode(row["data_b64"]))
    return b"".join(parts)


async def _rebuild(company_id, prepared_by):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    events = []
    for filing in filings:
        for event in filing.get("events") or []:
            item = dict(event)
            item["filing_id"] = filing.get("id")
            item["form_number"] = filing.get("form_number")
            item["source_filename"] = filing.get("filename")
            events.append(item)

    # Deduplicate events while preserving chronological order.
    unique = {}
    for event in events:
        unique.setdefault(_dedupe_key(event), event)
    events = sorted(unique.values(), key=lambda x: (str(x.get("event_date") or "9999"), str(x.get("form_number") or "")))

    # Only high-evidence SH-4 transfer events are copied into the working
    # Share Transfer Register. This avoids treating a person's appearance in
    # MGT/AOC material as a transfer.
    existing = list(company.get("share_transfers") or [])
    for event in events:
        if event.get("event_type") != "share_transfer" or not event.get("register_eligible"):
            continue
        transfer = dict(event.get("transfer") or {})
        transfer["source_filing_id"] = event.get("filing_id")
        transfer["source_form_number"] = event.get("form_number")
        transfer["source_filename"] = event.get("source_filename")
        transfer["source"] = "ROC Forms Dump / SH-4"
        signature = _dedupe_key({
            "transferor_name": transfer.get("transferor_name"),
            "transferee_name": transfer.get("transferee_name"),
            "transfer_date": transfer.get("transfer_date"),
            "number_of_shares": transfer.get("number_of_shares"),
            "certificate": transfer.get("share_certificate_no"),
        })
        if not any(x.get("roc_dump_signature") == signature for x in existing):
            transfer["roc_dump_signature"] = signature
            transfer["verification_status"] = "Source SH-4 extracted — verify execution and registration"
            existing.append(transfer)

    summary = _summary_sections(company, filings, events)
    summary_doc = _build_summary_doc(company, summary, prepared_by)
    now = _now()

    # Replace the generated Company Summary document, retaining other vault docs.
    await DOCS.delete_many({"company_id": company_id, "doc_type": "company_summary"})
    summary_doc_record = {
        "id": _uid(),
        "company_id": company_id,
        "doc_type": "company_summary",
        "filename": f"Company_Summary_{_safe_name(company.get('company_name'))}.docx",
        "generated_at": now,
        "generated_by": prepared_by,
        "content_b64": base64.b64encode(summary_doc).decode("ascii"),
        "source": "ROC Forms Dump",
        "dump_generated_at": now,
    }
    await DOCS.insert_one(summary_doc_record)

    await COMPANIES.update_one(
        {"id": company_id},
        {"$set": {
            "share_transfers": existing,
            "roc_dump_last_rebuilt_at": now,
            "roc_dump_event_count": len(events),
            "updated_at": now,
        }},
    )
    return summary, events, summary_doc_record



async def _process_roc_dump_entries(
    company_id: str,
    entries: List[Tuple[str, bytes]],
    prepared_by: str,
):
    total = 0
    expanded_count = 0
    results = []
    now = _now()

    for filename, raw in entries:
        expanded_count += 1
        if expanded_count > MAX_EXPANDED_FILES:
            results.append({
                "filename": filename,
                "status": "FAILED",
                "error": f"Batch exceeds {MAX_EXPANDED_FILES} expanded files",
            })
            continue
        if not filename.lower().endswith(ALLOWED_EXT + UNREADABLE_BUT_ACCEPTED_EXT):
            results.append({"filename": filename, "status": "FAILED", "error": "Unsupported file type"})
            continue
        total += len(raw)
        if total > MAX_BATCH:
            results.append({"filename": filename, "status": "FAILED", "error": "Batch exceeds 500 MB"})
            continue
        if not raw:
            results.append({"filename": filename, "status": "FAILED", "error": "Empty file"})
            continue

        digest = _sha256(raw)
        duplicate = await DUMP.find_one({"company_id": company_id, "sha256": digest})
        if duplicate:
            results.append({
                "filename": filename,
                "status": "DUPLICATE",
                "filing_id": duplicate.get("id"),
                "form_number": duplicate.get("form_number"),
            })
            continue

        filing_id = _uid()
        text, page_count = _extract_text(filename, raw)
        form_number, prefix, number = _form_number(filename, text)
        classification, learning_boost, learned = await _classify_with_learning(form_number, text, company_id)
        metadata = _extract_metadata(form_number, text)
        company_extract = _extract_company(text)
        extracted = {"company": company_extract, "metadata": metadata}

        if classification in {"director_change", "director_resignation", "annual_return", "director_kyc"}:
            people = _extract_people(text)
            if people:
                extracted["directors"] = people
        if classification == "share_transfer":
            extracted["share_transfer"] = _extract_share_transfer(text)
        if classification in {"financial", "share_allotment"}:
            extracted["financial"] = _extract_financial(text)
        if classification in {"loan_deposit", "charge"}:
            extracted["loans"] = _extract_loans(text)
        if classification == "auditor":
            extracted["auditor"] = _extract_auditor(text)

        # Keep all source text for auditability, but cap the inline copy so a
        # single Mongo document never grows without bound.
        raw_text_hash = _sha256(text.encode("utf-8", errors="ignore")) if text else None
        warnings = []
        errors = []
        if not text.strip():
            warnings.append("No machine-readable text was extracted. This may be a scanned/image-only or password-protected file; manual/OCR review is required.")
        if form_number == "UNKNOWN":
            warnings.append("Form number could not be classified; the complete file is retained as UNKNOWN for manual review.")
        if classification == "other":
            warnings.append("No specialized parser matched this form. Generic metadata and source text were retained.")
        elif learned:
            warnings.append("Classified from patterns learned out of previously reviewed filings (no static rule matched); please verify.")
        if text and not extracted.get("company", {}).get("cin"):
            warnings.append("CIN/LLPIN was not confidently identified.")
        status = "SUCCESS" if text.strip() and form_number != "UNKNOWN" else "NEEDS_REVIEW"
        confidence = _confidence(extracted, text, classification, learning_boost)
        if classification != "other" and confidence >= 0.75:
            # A confidently auto-classified filing is itself training signal
            # — this is the "evolves on its own" loop: no reviewer action
            # required for well-matched forms to reinforce the pattern.
            await _record_learning_feedback(company_id, classification, text)

        events = _events_for(classification, form_number, extracted, metadata)
        filing = {
            "id": filing_id,
            "company_id": company_id,
            "filename": filename,
            "original_filename": filename,
            "sha256": digest,
            "size_bytes": len(raw),
            "page_count": page_count,
            "form_number": form_number,
            "form_prefix": prefix,
            "form_numeric": number,
            "classification": classification,
            "classified_by_learning": learned,
            "metadata": metadata,
            "extracted": extracted,
            "raw_text": text[:MAX_TEXT_STORE],
            "raw_text_truncated": len(text) > MAX_TEXT_STORE,
            "raw_text_sha256": raw_text_hash,
            "events": events,
            "status": status,
            "confidence": confidence,
            "warnings": warnings,
            "errors": errors,
            "uploaded_at": now,
            "uploaded_by": prepared_by,
            "review": {"status": "PENDING" if status != "SUCCESS" else "NOT_REQUIRED"},
        }
        await DUMP.insert_one(filing)
        await _store_chunks(filing_id, raw)
        results.append({
            "filename": filename,
            "filing_id": filing_id,
            "form_number": form_number,
            "classification": classification,
            "status": status,
            "confidence": confidence,
            "warnings": warnings,
            "event_count": len(events),
        })



    summary, events, summary_doc = await _rebuild(company_id, prepared_by)
    return {
        "company_id": company_id,
        "processed": len([r for r in results if r.get("filing_id")]),
        "results": results,
        "event_count": len(events),
        "summary_document_id": summary_doc["id"],
        "summary": summary,
        "message": "ROC Forms Dump processed and Company Summary updated.",
    }


async def _process_roc_dump_job(job_id: str):
    async with ROC_JOB_LOCK:
        job = await ROC_JOBS.find_one({"id": job_id})
        if not job:
            return

        company_id = job.get("company_id")
        prepared_by = job.get("prepared_by") or "—"
        staged_files = job.get("files") or []

        await ROC_JOBS.update_one(
            {"id": job_id},
            {"$set": {
                "status": "PROCESSING",
                "started_at": _now(),
                "message": "ROC Forms Dump is being processed in the background.",
            }},
        )

        try:
            entries: List[Tuple[str, bytes]] = []
            for staged in staged_files:
                path = Path(staged.get("path") or "")
                filename = _safe_relative_path(staged.get("filename") or "roc-form")
                if not path.exists():
                    raise RuntimeError(f"Staged upload is no longer available: {filename}")

                raw = await asyncio.to_thread(path.read_bytes)
                if filename.lower().endswith(ARCHIVE_EXT):
                    try:
                        expanded = await asyncio.to_thread(_iter_archive_members, raw, filename)
                    except ValueError as exc:
                        raise RuntimeError(f"Unable to read archive {filename}: {exc}") from exc
                    entries.extend(expanded)
                else:
                    entries.append((filename, raw))

                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
                await asyncio.sleep(0)

            result = await _process_roc_dump_entries(company_id, entries, prepared_by)

            await ROC_JOBS.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "COMPLETED",
                    "progress": 100,
                    "processed_files": result.get("processed", 0),
                    "expanded_files": len(entries),
                    "event_count": result.get("event_count", 0),
                    "summary_document_id": result.get("summary_document_id"),
                    "summary": result.get("summary"),
                    "result_count": len(result.get("results") or []),
                    "finished_at": _now(),
                    "message": result.get("message") or "ROC Forms Dump completed.",
                }},
            )
        except Exception as exc:
            logger.exception("ROC Forms Dump background job %s failed", job_id)
            await ROC_JOBS.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "FAILED",
                    "finished_at": _now(),
                    "error": str(exc),
                    "message": "ROC Forms Dump processing failed.",
                }},
            )
        finally:
            for staged in staged_files:
                try:
                    Path(staged.get("path") or "").unlink(missing_ok=True)
                except Exception:
                    pass



async def resume_pending_roc_dump_jobs():
    """Resume ROC Forms Dump jobs left pending by a process restart.

    Render/local staging is temporary, so only jobs whose staged files are
    still present can safely be resumed. Missing staging is recorded as a
    failed job instead of allowing startup to fail.
    """
    try:
        pending = await ROC_JOBS.find(
            {"status": {"$in": ["QUEUED", "PROCESSING"]}}
        ).to_list(1000)

        resumed = 0
        failed = 0

        for job in pending:
            job_id = str(job.get("id") or "")
            if not job_id:
                continue

            staged_files = job.get("files") or []
            missing = []
            for staged in staged_files:
                path = Path(staged.get("path") or "")
                if not path.exists():
                    missing.append(staged.get("filename") or "unknown file")

            if missing:
                await ROC_JOBS.update_one(
                    {"id": job_id},
                    {"$set": {
                        "status": "FAILED",
                        "finished_at": _now(),
                        "error": "Staged upload files are no longer available after restart.",
                        "message": (
                            "ROC Forms Dump could not be resumed because "
                            f"staged files are missing: {', '.join(missing[:10])}"
                        ),
                    }},
                )
                failed += 1
                continue

            await ROC_JOBS.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "QUEUED",
                    "message": "ROC Forms Dump job resumed after backend restart.",
                }},
            )
            _schedule_roc_dump_job(job_id)
            resumed += 1

        logger.info(
            "ROC Forms Dump startup recovery complete: %s resumed, %s failed.",
            resumed,
            failed,
        )
        return {"resumed": resumed, "failed": failed}
    except Exception:
        logger.exception("ROC Forms Dump startup recovery failed")
        return {"resumed": 0, "failed": 0}


def _chunk_upload_dir(upload_id: str) -> Path:
    return ROC_STAGING_ROOT / f"upload_{_safe_name(upload_id)}"


async def _create_roc_dump_job_from_staged_files(
    company_id: str,
    prepared_by: str,
    staged_files: List[Dict[str, Any]],
) -> Dict[str, Any]:
    total_bytes = sum(int(item.get("size_bytes") or 0) for item in staged_files)
    if not staged_files:
        raise HTTPException(400, "No files were staged for ROC Forms Dump")
    if total_bytes > MAX_BATCH:
        raise HTTPException(413, "Batch exceeds 500 MB")

    job_id = _uid()
    await ROC_JOBS.insert_one({
        "id": job_id,
        "company_id": company_id,
        "prepared_by": prepared_by,
        "status": "QUEUED",
        "progress": 0,
        "file_count": len(staged_files),
        "processed_files": 0,
        "expanded_files": 0,
        "total_bytes": total_bytes,
        "files": staged_files,
        "created_at": _now(),
        "message": "Upload received. Processing continues in the background.",
    })
    _schedule_roc_dump_job(job_id)
    return {
        "job_id": job_id,
        "company_id": company_id,
        "status": "QUEUED",
        "file_count": len(staged_files),
        "total_bytes": total_bytes,
        "message": "Upload received. Processing continues in the background.",
        "status_url": f"/roc-sphere/companies/{company_id}/roc-dump/jobs/{job_id}",
    }


@router.post("/companies/{company_id}/roc-dump/upload/initiate", status_code=201)
async def initiate_roc_dump_upload(
    company_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(CREATE),
):
    """Create a resumable upload session.

    Large ROC archives are uploaded in bounded chunks so a 200–500 MB archive
    does not have to survive as one long HTTP request through the Render edge.
    The normal single chooser in the browser still uses this endpoint
    transparently.
    """
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")

    incoming = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(incoming, list) or not incoming:
        raise HTTPException(400, "Select at least one ROC form")

    total_bytes = 0
    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(incoming):
        if not isinstance(item, dict):
            raise HTTPException(400, f"Invalid file metadata at index {index}")
        filename = _safe_relative_path(item.get("filename") or "roc-form")
        lower = filename.lower()
        if not lower.endswith(ALLOWED_EXT + ARCHIVE_EXT + UNREADABLE_BUT_ACCEPTED_EXT):
            raise HTTPException(400, f"Unsupported file type: {filename}")
        try:
            size = int(item.get("size_bytes") or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, f"Invalid file size for {filename}")
        if size < 0:
            raise HTTPException(400, f"Invalid file size for {filename}")
        total_bytes += size
        if total_bytes > MAX_BATCH:
            raise HTTPException(413, "Batch exceeds 500 MB")
        normalized.append({
            "index": index,
            "filename": filename,
            "size_bytes": size,
            "total_chunks": max(1, int(item.get("total_chunks") or 1)),
        })

    upload_id = _uid()
    upload_dir = _chunk_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    session = {
        "id": upload_id,
        "company_id": company_id,
        "prepared_by": _who(current_user),
        "status": "UPLOADING",
        "created_at": _now(),
        "updated_at": _now(),
        "total_bytes": total_bytes,
        "files": normalized,
    }
    try:
        await ROC_UPLOADS.insert_one(session)
    except Exception:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise

    return {
        "upload_id": upload_id,
        "company_id": company_id,
        "file_count": len(normalized),
        "total_bytes": total_bytes,
        "chunk_size": 8 * 1024 * 1024,
        "status": "UPLOADING",
    }


@router.post("/companies/{company_id}/roc-dump/upload/chunk", status_code=204)
async def upload_roc_dump_chunk(
    company_id: str,
    upload_id: str = Form(...),
    file_index: int = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    chunk: UploadFile = File(...),
    current_user: User = Depends(CREATE),
):
    """Receive one bounded chunk and persist it before acknowledging it."""
    session = await ROC_UPLOADS.find_one({"id": upload_id, "company_id": company_id})
    if not session:
        raise HTTPException(404, "ROC upload session not found")
    if session.get("status") != "UPLOADING":
        raise HTTPException(409, "ROC upload session is no longer accepting chunks")

    descriptors = session.get("files") or []
    if file_index < 0 or file_index >= len(descriptors):
        raise HTTPException(400, "Invalid file index")
    descriptor = descriptors[file_index]
    expected_chunks = int(descriptor.get("total_chunks") or 1)
    if total_chunks != expected_chunks or chunk_index < 0 or chunk_index >= expected_chunks:
        raise HTTPException(400, "Invalid chunk metadata")

    upload_dir = _chunk_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_dir = upload_dir / f"{file_index:06d}"
    file_dir.mkdir(parents=True, exist_ok=True)
    target = file_dir / f"{chunk_index:06d}.part"

    written = 0
    try:
        with target.open("wb") as output:
            while True:
                data = await chunk.read(CHUNK_SIZE)
                if not data:
                    break
                written += len(data)
                if written > 8 * 1024 * 1024 + 1024 * 1024:
                    raise HTTPException(413, "Upload chunk exceeds 9 MB")
                output.write(data)
    finally:
        await chunk.close()

    expected_size = int(descriptor.get("size_bytes") or 0)
    if expected_chunks == 1 and written != expected_size:
        target.unlink(missing_ok=True)
        raise HTTPException(400, f"Chunk size mismatch for {descriptor.get('filename')}")
    await ROC_UPLOADS.update_one(
        {"id": upload_id},
        {"$set": {"updated_at": _now()}},
    )


@router.post("/companies/{company_id}/roc-dump/upload/finalize", status_code=202)
async def finalize_roc_dump_upload(
    company_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(CREATE),
):
    upload_id = str((payload or {}).get("upload_id") or "").strip()
    if not upload_id:
        raise HTTPException(400, "upload_id is required")

    session = await ROC_UPLOADS.find_one({"id": upload_id, "company_id": company_id})
    if not session:
        raise HTTPException(404, "ROC upload session not found")
    if session.get("status") != "UPLOADING":
        raise HTTPException(409, "ROC upload session has already been finalized")

    upload_dir = _chunk_upload_dir(upload_id)
    staged_files: List[Dict[str, Any]] = []
    try:
        for descriptor in session.get("files") or []:
            index = int(descriptor.get("index") or 0)
            total_chunks = int(descriptor.get("total_chunks") or 1)
            file_dir = upload_dir / f"{index:06d}"
            if not file_dir.exists():
                raise HTTPException(409, f"File is incomplete: {descriptor.get('filename')}")

            assembled = upload_dir / f"{index:06d}.upload"
            with assembled.open("wb") as output:
                for chunk_index in range(total_chunks):
                    part = file_dir / f"{chunk_index:06d}.part"
                    if not part.exists():
                        raise HTTPException(409, f"Missing chunk {chunk_index + 1}/{total_chunks} for {descriptor.get('filename')}")
                    with part.open("rb") as source:
                        shutil.copyfileobj(source, output, length=1024 * 1024)

            size = assembled.stat().st_size
            if size != int(descriptor.get("size_bytes") or 0):
                raise HTTPException(409, f"File size mismatch after upload: {descriptor.get('filename')}")

            staged_files.append({
                "path": str(assembled),
                "filename": _safe_relative_path(descriptor.get("filename") or "roc-form"),
                "size_bytes": size,
            })
            shutil.rmtree(file_dir, ignore_errors=True)

        await ROC_UPLOADS.update_one(
            {"id": upload_id},
            {"$set": {"status": "FINALIZING", "updated_at": _now()}},
        )
        result = await _create_roc_dump_job_from_staged_files(
            company_id,
            _who(current_user),
            staged_files,
        )
        await ROC_UPLOADS.update_one(
            {"id": upload_id},
            {"$set": {
                "status": "QUEUED",
                "job_id": result["job_id"],
                "updated_at": _now(),
            }},
        )
        shutil.rmtree(upload_dir, ignore_errors=True)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ROC chunked upload finalization failed")
        await ROC_UPLOADS.update_one(
            {"id": upload_id},
            {"$set": {"status": "FAILED", "error": str(exc), "updated_at": _now()}},
        )
        raise HTTPException(500, "Unable to finalize ROC Forms Dump upload") from exc


def _schedule_roc_dump_job(job_id: str):
    task = asyncio.create_task(_process_roc_dump_job(job_id))
    ROC_JOB_TASKS.add(task)
    task.add_done_callback(ROC_JOB_TASKS.discard)


@router.post("/companies/{company_id}/roc-dump/upload", status_code=202)
async def upload_roc_dump(
    company_id: str,
    files: List[UploadFile] = File(...),
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(CREATE),
):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if not files:
        raise HTTPException(400, "Select at least one ROC form")

    job_id = _uid()
    job_dir = ROC_STAGING_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    staged_files = []
    total_bytes = 0

    try:
        for index, uploaded in enumerate(files):
            filename = _safe_relative_path(uploaded.filename or "roc-form")
            if not filename.lower().endswith(ALLOWED_EXT + ARCHIVE_EXT + UNREADABLE_BUT_ACCEPTED_EXT):
                raise HTTPException(400, f"Unsupported file type: {filename}")

            destination = job_dir / f"{index:05d}_{uuid.uuid4().hex}.upload"
            uploaded.file.seek(0)
            with destination.open("wb") as output:
                shutil.copyfileobj(uploaded.file, output, length=1024 * 1024)

            size = destination.stat().st_size
            total_bytes += size
            if total_bytes > MAX_BATCH:
                raise HTTPException(413, "Batch exceeds 500 MB")

            staged_files.append({
                "path": str(destination),
                "filename": filename,
                "size_bytes": size,
            })

        await ROC_JOBS.insert_one({
            "id": job_id,
            "company_id": company_id,
            "prepared_by": _who(current_user),
            "status": "QUEUED",
            "progress": 0,
            "file_count": len(staged_files),
            "processed_files": 0,
            "expanded_files": 0,
            "total_bytes": total_bytes,
            "files": staged_files,
            "created_at": _now(),
            "message": "Upload received. Processing continues in the background.",
        })

        if background_tasks is not None:
            background_tasks.add_task(_schedule_roc_dump_job, job_id)
        else:
            _schedule_roc_dump_job(job_id)

        return {
            "job_id": job_id,
            "company_id": company_id,
            "status": "QUEUED",
            "file_count": len(staged_files),
            "total_bytes": total_bytes,
            "message": "Upload received. Processing continues in the background.",
            "status_url": f"/roc-sphere/companies/{company_id}/roc-dump/jobs/{job_id}",
        }
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.exception("ROC Forms Dump staging failed")
        raise HTTPException(500, f"Unable to stage ROC Forms Dump upload: {exc}") from exc


@router.get("/companies/{company_id}/roc-dump/jobs/{job_id}")
async def roc_dump_job_status(
    company_id: str,
    job_id: str,
    current_user: User = Depends(roc_job_access),
):
    job = await ROC_JOBS.find_one(
        {"id": job_id, "company_id": company_id},
        {"_id": 0, "files": 0},
    )
    if not job:
        raise HTTPException(404, "ROC Forms Dump job not found")
    return job


@router.get("/companies/{company_id}/roc-dump")
async def list_roc_dump(company_id: str, current_user: User = Depends(VIEW)):
    if not await COMPANIES.find_one({"id": company_id}, {"id": 1}):
        raise HTTPException(404, "Company not found")
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("uploaded_at", -1)]
    for item in filings:
        item.pop("_id", None)
        item.pop("raw_text", None)
    return {"count": len(filings), "items": filings}


@router.get("/companies/{company_id}/roc-dump/summary")
async def roc_dump_summary(company_id: str, current_user: User = Depends(VIEW)):
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    events = []
    for filing in filings:
        events.extend(filing.get("events") or [])
    return _summary_sections(company, filings, events)


@router.get("/companies/{company_id}/roc-dump/events")
async def roc_dump_events(company_id: str, current_user: User = Depends(VIEW)):
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    events = []
    for filing in filings:
        for event in filing.get("events") or []:
            item = dict(event)
            item["filing_id"] = filing.get("id")
            item["form_number"] = filing.get("form_number")
            item["source_filename"] = filing.get("filename")
            events.append(item)
    return {"count": len(events), "events": events}



@router.get("/companies/{company_id}/roc-dump/share-transfers")
async def roc_dump_share_transfers(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id}, {"share_transfers": 1, "id": 1})
    if not company:
        raise HTTPException(404, "Company not found")
    return {"count": len(company.get("share_transfers") or []), "items": company.get("share_transfers") or []}


@router.get("/companies/{company_id}/roc-dump/{filing_id}")
async def get_roc_dump_filing(company_id: str, filing_id: str, current_user: User = Depends(VIEW)):
    filing = await DUMP.find_one({"id": filing_id, "company_id": company_id})
    if not filing:
        raise HTTPException(404, "ROC dump filing not found")
    filing.pop("_id", None)
    return filing


@router.get("/companies/{company_id}/roc-dump/{filing_id}/download")
async def download_roc_dump_filing(company_id: str, filing_id: str, current_user: User = Depends(VIEW)):
    filing = await DUMP.find_one({"id": filing_id, "company_id": company_id})
    if not filing:
        raise HTTPException(404, "ROC dump filing not found")
    raw = await _load_chunks(filing_id)
    if not raw:
        raise HTTPException(410, "Stored ROC form content is unavailable")
    filename = filing.get("filename") or "ROC_Form"
    media = "application/pdf" if filename.lower().endswith(".pdf") else "application/octet-stream"
    return Response(
        content=raw,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.post("/companies/{company_id}/roc-dump/{filing_id}/review")
async def review_roc_dump_filing(
    company_id: str,
    filing_id: str,
    review_status: str = Form(...),
    note: str = Form(""),
    current_user: User = Depends(EDIT),
):
    if review_status not in {"VERIFIED", "REVIEWED", "REJECTED", "NEEDS_REVIEW"}:
        raise HTTPException(400, "Invalid review status")
    result = await DUMP.update_one(
        {"id": filing_id, "company_id": company_id},
        {"$set": {
            "review": {"status": review_status, "note": note, "reviewed_at": _now(), "reviewed_by": _who(current_user)}
        }},
    )
    if not result.modified_count:
        raise HTTPException(404, "ROC dump filing not found")
    if review_status == "VERIFIED":
        # A human confirming the filing's classification is the strongest
        # possible training signal — reinforce it immediately.
        filing = await DUMP.find_one({"id": filing_id, "company_id": company_id},
                                      {"classification": 1, "raw_text": 1})
        if filing and filing.get("classification") and filing.get("raw_text"):
            await _record_learning_feedback(company_id, filing["classification"], filing["raw_text"])
    return {"updated": True, "review_status": review_status}


@router.post("/companies/{company_id}/roc-dump/{filing_id}/correct-classification")
async def correct_roc_dump_classification(
    company_id: str,
    filing_id: str,
    classification: str = Form(...),
    current_user: User = Depends(EDIT),
):
    """Let a reviewer correct a wrong auto-classification. The correction is
    saved on the filing AND fed back into the learned weight table (with the
    original guess down-weighted), which is how the classifier's accuracy
    compounds over time instead of repeating the same mistake."""
    if classification not in CLASSIFICATION_LABELS:
        raise HTTPException(400, f"Unknown classification. Use one of: {', '.join(CLASSIFICATION_LABELS)}")
    filing = await DUMP.find_one({"id": filing_id, "company_id": company_id},
                                  {"classification": 1, "raw_text": 1})
    if not filing:
        raise HTTPException(404, "ROC dump filing not found")
    previous = filing.get("classification")
    await DUMP.update_one(
        {"id": filing_id, "company_id": company_id},
        {"$set": {
            "classification": classification,
            "classified_by_learning": False,
            "review": {"status": "VERIFIED", "note": f"Reclassified from {previous or 'other'}",
                       "reviewed_at": _now(), "reviewed_by": _who(current_user)},
        }},
    )
    if filing.get("raw_text"):
        await _record_learning_feedback(company_id, classification, filing["raw_text"], previous_classification=previous)
    return {"updated": True, "classification": classification, "previous_classification": previous}


@router.post("/companies/{company_id}/roc-dump/rebuild-summary")
async def rebuild_roc_dump_summary(company_id: str, current_user: User = Depends(EDIT)):
    summary, events, doc = await _rebuild(company_id, _who(current_user))
    return {"summary": summary, "event_count": len(events), "summary_document_id": doc["id"]}
