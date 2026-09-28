"""Deterministic GST controls for Finix.

The engine never invents an intra/inter-state treatment when the location
identity required to determine it is missing. Tax arithmetic uses Decimal and
all tax decisions carry an explicit review state where evidence is incomplete.
"""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Dict, Any, Tuple, Optional
import re
import logging

logger = logging.getLogger("gst_engine")
PAISE = Decimal("0.01")
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z0-9]{13}$")


def _money(value: Any) -> Decimal:
    try:
        amount = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError("Invalid GST monetary value.") from exc
    if not amount.is_finite():
        raise ValueError("GST monetary values must be finite.")
    return amount.quantize(PAISE, rounding=ROUND_HALF_UP)


def _state_code(value: Any) -> Optional[str]:
    """Return a canonical two-digit Indian state/UT code, or None if invalid."""
    text = str(value or "").strip()
    if not text:
        return None
    if not re.fullmatch(r"\\d{2}", text):
        return None
    return text


class GSTEngine:
    @staticmethod
    def validate_gstin(gstin: Any) -> bool:
        value = str(gstin or "").strip().upper()
        return bool(GSTIN_RE.fullmatch(value))

    @staticmethod
    def determine_gst_split(
        company_gstin: str,
        vendor_gstin: str,
        total_tax_amount: float,
        *,
        place_of_supply_state: Optional[str] = None,
        supplier_state: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Determine GST split only when the jurisdiction evidence is sufficient."""
        total_tax = _money(total_tax_amount)
        if total_tax < 0:
            raise ValueError("GST cannot be negative.")
        if total_tax == 0:
            return {"cgst": 0.0, "sgst": 0.0, "igst": 0.0, "status": "NO_TAX"}

        company = str(company_gstin or "").strip().upper()
        vendor = str(vendor_gstin or "").strip().upper()
        company_state = company[:2] if GSTEngine.validate_gstin(company) else None
        vendor_state = vendor[:2] if GSTEngine.validate_gstin(vendor) else None

        # Explicit place-of-supply/supplier evidence takes precedence. A supplied
        # but malformed state code is not evidence and must fail closed rather
        # than being silently normalized into a different jurisdiction.
        pos = _state_code(place_of_supply_state)
        supplier_explicit = _state_code(supplier_state)
        if place_of_supply_state not in (None, "") and pos is None:
            return {
                "cgst": 0.0, "sgst": 0.0, "igst": 0.0,
                "status": "REVIEW_REQUIRED",
                "reason": "Invalid place-of-supply state evidence.",
            }
        if supplier_state not in (None, "") and supplier_explicit is None:
            return {
                "cgst": 0.0, "sgst": 0.0, "igst": 0.0,
                "status": "REVIEW_REQUIRED",
                "reason": "Invalid supplier state evidence.",
            }

        supplier = supplier_explicit or vendor_state

        # For a normal registered supplier transaction, place of supply is the
        # decisive jurisdiction. If explicit place-of-supply evidence is absent,
        # a valid supplier GSTIN supplies the jurisdiction. Otherwise the
        # company/vendor GSTIN states are used as the registered fallback.
        if pos and supplier:
            interstate = pos != supplier
        elif company_state and vendor_state:
            interstate = company_state != vendor_state
        else:
            return {
                "cgst": 0.0, "sgst": 0.0, "igst": 0.0,
                "status": "REVIEW_REQUIRED",
                "reason": "Insufficient state/place-of-supply evidence to determine GST jurisdiction.",
            }

        if interstate:
            return {"cgst": 0.0, "sgst": 0.0, "igst": float(total_tax), "status": "INTER_STATE"}
        cgst = (total_tax / 2).quantize(PAISE, rounding=ROUND_HALF_UP)
        sgst = total_tax - cgst
        return {"cgst": float(cgst), "sgst": float(sgst), "igst": 0.0, "status": "INTRA_STATE"}

    @staticmethod
    def evaluate_rcm(
        vendor_profile: Optional[Dict[str, Any]] = None,
        extracted_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Return an evidence-based RCM decision; keyword matches are never proof."""
        vendor_profile = vendor_profile or {}
        extracted_data = extracted_data or {}
        if vendor_profile.get("is_rcm_applicable") is True:
            return {"applicable": True, "confidence": 1.0, "evidence": "vendor_profile"}
        explicit = extracted_data.get("rcm_applicable")
        if explicit is True:
            return {"applicable": True, "confidence": 1.0, "evidence": "document_explicit_flag"}
        if explicit is False:
            return {"applicable": False, "confidence": 1.0, "evidence": "document_explicit_flag"}
        return {
            "applicable": False,
            "confidence": 0.0,
            "requires_review": True,
            "evidence": "RCM cannot be established deterministically from the available data.",
        }

    @staticmethod
    def check_itc_eligibility(
        account_code: str,
        vendor_profile: Optional[Dict[str, Any]] = None,
        *,
        explicit_status: Optional[str] = None,
        business_use_percent: Optional[float] = None,
    ) -> str:
        """Conservative ITC classification; unknown facts require review."""
        profile = vendor_profile or {}
        status = str(explicit_status or profile.get("itc_status") or "").strip().lower()
        if status in {"blocked", "eligible"}:
            return status.upper()
        if business_use_percent is not None:
            try:
                pct = float(business_use_percent)
            except (TypeError, ValueError):
                return "REVIEW_REQUIRED"
            if pct <= 0:
                return "BLOCKED"
            if pct < 100:
                return "PARTIALLY_ELIGIBLE"
        return "REVIEW_REQUIRED"

    @classmethod
    def validate_gst_calculations(
        cls,
        taxable_value: float,
        cgst: float,
        sgst: float,
        igst: float,
        total_tax: float,
        cess: float = 0.0,
    ) -> Tuple[bool, str]:
        """Validate GST arithmetic to exact paise, including cess."""
        taxable = _money(taxable_value)
        parts = [_money(cgst), _money(sgst), _money(igst), _money(cess)]
        total = _money(total_tax)
        if taxable < 0 or any(part < 0 for part in parts) or total < 0:
            return False, "GST values cannot be negative."
        calculated = sum(parts, Decimal("0.00"))
        if calculated != total:
            return False, f"GST components {calculated} do not equal total tax {total}."
        if _money(cgst) and _money(sgst) and _money(cgst) != _money(sgst):
            return False, "CGST and SGST must reconcile exactly for a standard intra-state split."
        if _money(igst) and (_money(cgst) or _money(sgst)):
            return False, "IGST cannot coexist with CGST/SGST in the same standard tax split."
        return True, "GST calculations are balanced and valid."
