# Load the admin identity compatibility layer before backend.server imports
# route dependencies. This is required for Render deployments that start via
# `uvicorn backend.server:app` instead of backend/run.py.
import backend.admin_identity_compat  # noqa: F401

# Authentication must resolve the user before tenant-scoped collection guards
# are active. The users collection cannot be company-scoped until the company
# identity has been recovered from the JWT/licensee record.
import backend.commercial_auth_bootstrap_compat  # noqa: F401

# Establish the commercial-customer tenant context before any route module
# captures get_current_user. This separates a licensee's multiple legal
# companies from the Platform Owner and every other licensee.
import backend.commercial_tenant_scope  # noqa: F401

# Legacy license-generated company records may carry the license id without
# the newer commercial_customer_id field. Expose only those records belonging
# to the authenticated customer's active license and normalize them when used.
import backend.commercial_legacy_company_scope_compat  # noqa: F401

# Commercial administrator accounts created before feature-level licensing may
# not have the current module/page flags persisted. Hydrate them from the
# active commercial license before installing the API entitlement guard.
import backend.commercial_admin_permission_compat as _commercial_admin_permission_compat
_commercial_admin_permission_compat.install()

# Resolve the final commercial admin permissions from the customer's ONE active
# license. This is customer-level, not legal-company-level, so all companies
# under the same license inherit the purchased modules while other licensees
# remain isolated.
import backend.commercial_license_entitlement_compat  # noqa: F401

# Install the commercial tenant module cap before route modules import
# get_current_user. Internal admins remain unrestricted; licensed company
# accounts are denied at the API boundary when a request targets an unlicensed
# module.
import backend.commercial_module_guard as _commercial_module_guard
_commercial_module_guard.install()

# Phase 1 commercial security foundation: identity/user administration is CORE,
# not a billable People Matrix dependency. Production also refuses the legacy
# in-memory Mongo fallback before any route captures get_current_user.
import backend.commercial_core_isolation as _commercial_core_isolation  # noqa: F401
_commercial_core_isolation.install()

# FastAPI compatibility shim: the original commercial guard's Request
# annotation was being interpreted as a required query parameter in the
# deployed runtime, causing authenticated GET endpoints to return 422.
# Replace only that wrapper before route modules import get_current_user.
import backend.commercial_guard_request_compat as _commercial_guard_request_compat
_commercial_guard_request_compat.install()

# Production hardening boundary: fail closed on missing commercial licenses,
# enforce active users and company scope, expand tenant-aware collections, and
# protect historically dependency-free AI/Finix/v2 routes before route modules
# capture get_current_user. This is additive and preserves existing handlers.
import backend.production_hardening as _production_hardening  # noqa: F401

# Bank Accounts compatibility: older Finix frontend builds request up to 2000
# purchase invoices. Keep that legacy read compatible with the canonical
# purchase-invoice endpoint without weakening authentication or permissions.
import backend.purchase_invoice_query_compat as _purchase_invoice_query_compat
_purchase_invoice_query_compat.install()

# Enforce the separate Commercial Control Plane boundary AFTER the Request
# compatibility wrapper so this remains the final authentication dependency
# captured by all subsequently imported route modules.
import backend.commercial_control_plane_guard as _commercial_control_plane_guard
_commercial_control_plane_guard.install()

# Load the commercial licensing extension before governed_modules registers the
# legacy commercial router. The extension registers the same public prefix
# first, so its feature-level licensing and invoice workflow takes precedence.
import backend.commercial_onboarding_extensions  # noqa: F401

# Public onboarding endpoints run before a customer has a JWT. Rebuild those
# route dependencies after the onboarding extension is loaded so license
# verification, first-admin creation, and public user creation use the raw
# customer/license records while still enforcing the license-wide user cap.
import backend.commercial_onboarding_admin_compat  # noqa: F401

# Harden public licensed user creation after the compatibility route replacement.
# This keeps the signup endpoint license-authoritative and returns controlled
# validation/duplicate/database errors rather than an opaque 500.
import backend.commercial_onboarding_create_user_compat  # noqa: F401

# Enforce one commercial license per customer and a license-wide user limit.
# This layer is installed after the licensing extension so it can wrap the
# canonical license creation function and before backend.server imports route
# modules that create or manage users.
import backend.commercial_license_user_limit  # noqa: F401

# Legacy company records are also license-linked. Patch the user-seat validator
# after the core license-wide limit is installed so adding a user to a legacy
# legal company still consumes the customer's shared license seat.
import backend.commercial_legacy_user_limit_compat  # noqa: F401

# Final user-data boundary: user records are always company-scoped at request
# time. This is intentionally after the customer-level compatibility layers so
# the physical users collection can remain shared without ever merging people
# between legal companies or exposing customer users to the Platform Owner.
import backend.commercial_user_company_scope  # noqa: F401

# The custom commercial generator creates customer ids automatically. Guard
# issuance by the registered customer/company name as well so the one-license
# rule is enforced even when the UI does not submit an explicit customer_id.
import backend.commercial_license_creation_compat  # noqa: F401

# Company Master user administration is deliberately outside People Matrix
# licensing. It uses the same users collection and HR fields so every module
# can share one company-scoped user source of truth.
import backend.commercial_master_data  # noqa: F401

# Platform-owner commercial company master: manages the relationship between a
# commercial billing customer and its legal operational companies without
# exposing customer operational data.
import backend.commercial_company_master  # noqa: F401

# Platform-owner commercial customer/license registry editor. This edits only
# commercial billing/contact details and license entitlements; it never grants
# the platform owner access to customer operational data.
import backend.commercial_customer_directory  # noqa: F401

# Platform-owner Company Master must exclude the hidden operational company
# created automatically during license generation. Companies explicitly added
# through Master Data / Quotations remain visible.
import backend.commercial_company_registry_visibility  # noqa: F401

# AI Document Reader workspace: persistent company-scoped memory for multiple
# documents and cross-document reasoning. It is mounted onto the existing
# AI reader router so the existing /api/ai/analyze-document route is unchanged.
from backend.ai_document_reader import router as _ai_document_reader_router
from backend.ai.workspace_router import router as _ai_workspace_router
_ai_document_reader_router.include_router(_ai_workspace_router)

# Compatibility shims must load before backend.server imports its routers.
# The user projection shim prevents legacy HR/attendance handlers from losing
# the UUID `id` field in narrow Mongo projections. The WhatsApp SSE shim lets
# EventSource authenticate commercial opaque SaaS session tokens as well as
# legacy JWT tokens.
import backend.user_projection_compat  # noqa: F401
import backend.whatsapp_sse_compat as _whatsapp_sse_compat
_whatsapp_sse_compat.install()

# Private backend-to-bridge trust boundary. This middleware runs before the
# commercial WhatsApp webhook handlers are registered.
import backend.whatsapp_bridge_webhook_guard as _whatsapp_bridge_webhook_guard  # noqa: F401

# Load Gmail's direct OAuth integration after email_integration's helpers are
# available but before backend.server imports the email router. This mounts the
# OAuth routes at /api/email/oauth/google/* and adapts Gmail API reads into the
# existing email extraction pipeline without changing non-Gmail providers.
import backend.email_google_oauth  # noqa: F401
# Google redirects back without the authenticated browser context. Bind the
# saved OAuth state's commercial company/customer identity for the callback.
import backend.email_google_oauth_context_compat  # noqa: F401

# MongoDB ObjectId values can still exist in legacy user/company documents.
# FastAPI's default encoder raises a 500 when such an ObjectId reaches a response.
# Treat ObjectId as its canonical string representation globally so legacy
# Master Data records remain readable without changing stored data.
from bson import ObjectId
from fastapi.encoders import ENCODERS_BY_TYPE
ENCODERS_BY_TYPE[ObjectId] = str

import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any

logger = logging.getLogger("enterprise_license")

class EnterpriseLicense:
    @staticmethod
    def generate_unlimited_license(tenant_id: str, subsidiary_count: int = 10) -> Dict[str, Any]:
        """Assembles a premium holding company license template supporting multi-branch setups."""
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=365)
        return {
            "tenant_id": tenant_id,
            "license_type": "enterprise_unlimited",
            "max_users": 5000,
            "subsidiary_count_allowed": subsidiary_count,
            "status": "active",
            "expires_at": expires.isoformat()
        }
