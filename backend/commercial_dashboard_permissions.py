"""Dashboard-page selection normalization.

Dashboard pages are independent entries in the commercial page catalog. This
compatibility helper now preserves explicit selections exactly and does not
silently add or remove dashboard flags based on other page selections.
"""
from typing import Dict, List

DASHBOARD_FLAG_BY_MODULE = {
    "taskosphere": "can_view_dashboard",
    "finix": "can_view_finix_dashboard",
    "compliance": "can_view_compliance_dashboard",
    "records": "can_view_records_dashboard",
    "proposals": "can_view_proposals_dashboard",
    "people_matrix": "can_view_people_matrix_dashboard",
}


def normalize_dashboard_feature_selection(selected_features: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """Return selections unchanged except for removing duplicate flag values."""
    return {
        str(module_id): list(dict.fromkeys(str(flag).strip() for flag in (flags or []) if str(flag).strip()))
        for module_id, flags in (selected_features or {}).items()
    }
