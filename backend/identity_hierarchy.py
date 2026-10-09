"""Hierarchical identity utilities for the commercial platform.

Adds stable, human-readable organization/user identifiers without replacing
the existing MongoDB id/_id values referenced by operational data.
Platform Owners use PO-###### and commercial licensees use L-######.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException
from pymongo import ReturnDocument

PLATFORM_OWNER_UID_DEFAULT = "PO-000001"
IDENTITY_MIGRATION_KEY = "hierarchical_identity_v1"
_UID_RE = re.compile(r"^(PO|L)-(\d{6})$")
_USER_UID_RE = re.compile(r"^(PO|L)-(\d{6})-U-(\d{6})$")
_LICENSE_UID_RE = re.compile(r"^LIC-(PO|L)-(\d{6})-(\d{2,})$")
logger = logging.getLogger("identity_hierarchy")
IDENTITY_EMAIL_LINK_COLLECTION = "identity_email_links"
EMAIL_IDENTITY_LINK_MIGRATION_KEY = "email_identity_link_v2"


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _normalized_email(value: Any) -> str:
    return _clean(value).lower()


def _owner_uid() -> str:
    configured = _clean(os.getenv("PLATFORM_OWNER_UID"))
    if _UID_RE.match(configured) and configured.startswith("PO-"):
        return configured
    return PLATFORM_OWNER_UID_DEFAULT


async def _allocate_sequence_async(db, namespace: str) -> int:
    doc = await db.identity_sequences.find_one_and_update(
        {"_id": namespace},
        {
            "$inc": {"seq": 1},
            "$set": {"updated_at": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int((doc or {}).get("seq") or 1)


async def _set_counter_max(db, namespace: str, value: int) -> None:
    if int(value or 0) <= 0:
        return
    await db.identity_sequences.update_one(
        {"_id": namespace},
        {
            "$max": {"seq": int(value)},
            "$set": {"updated_at": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
    )


def _extract_seq(uid: Any, regex: re.Pattern[str], group: int) -> int:
    match = regex.match(_clean(uid))
    return int(match.group(group)) if match else 0


def is_commercial_identity_record(user: Any) -> bool:
    if not user:
        return False
    get = user.get if isinstance(user, dict) else lambda key, default=None: getattr(user, key, default)
    identity_type = _clean(get("identity_type")).lower()
    if identity_type.startswith("licensee") or identity_type == "commercial":
        return True
    if _clean(get("licensee_uid")) or _clean(get("commercial_customer_id")) or _clean(get("license_id")):
        return True
    return False


async def ensure_identity_indexes(db) -> None:
    await db.identity_email_links.create_index(
        "email_normalized", unique=True, sparse=True, background=True
    )
    await db.commercial_license_customers.create_index(
        "licensee_uid", unique=True, sparse=True, background=True
    )
    await db.commercial_licenses.create_index(
        "license_uid", unique=True, sparse=True, background=True
    )
    await db.companies.create_index(
        "licensee_uid", sparse=True, background=True
    )
    await db.users.create_index(
        "user_uid", unique=True, sparse=True, background=True
    )
    await db.users.create_index("identity_org_uid", background=True)
    await db.users.create_index("email_normalized", background=True)
    try:
        await db.users.create_index(
            [("identity_org_uid", 1), ("email_normalized", 1)],
            unique=True,
            partialFilterExpression={
                "identity_org_uid": {"$type": "string"},
                "email_normalized": {"$type": "string"},
            },
            background=True,
        )
    except Exception:
        pass


async def ensure_identity_email_link(
    db,
    email: Any,
    identity_uid: str,
    *,
    identity_type: str = "organization",
) -> str:
    """Bind one normalized email to exactly one organization identity UID.

    The UID itself is created by the licensee/platform-owner hierarchy. This
    helper only records the email -> existing UID relationship and prevents the
    same email from being bound to a different organization.
    """
    normalized = _normalized_email(email)
    uid = _clean(identity_uid).upper()
    if not normalized:
        raise HTTPException(status_code=400, detail="Email is required for identity linking.")
    if not _UID_RE.match(uid):
        raise HTTPException(status_code=400, detail="A valid organization identity is required.")

    existing = await db[IDENTITY_EMAIL_LINK_COLLECTION].find_one(
        {"email_normalized": normalized},
        {"_id": 0},
    )
    if existing:
        existing_uid = _clean(existing.get("identity_uid")).upper()
        if existing_uid and existing_uid != uid:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This email is already linked to another organization identity "
                    f"({existing_uid}). One email cannot be linked to two unique IDs."
                ),
            )
        await db[IDENTITY_EMAIL_LINK_COLLECTION].update_one(
            {"email_normalized": normalized},
            {
                "$set": {
                    "email": _clean(email),
                    "identity_uid": uid,
                    "identity_type": identity_type,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        return uid

    payload = {
        "_id": normalized,
        "email": _clean(email),
        "email_normalized": normalized,
        "identity_uid": uid,
        "identity_type": identity_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await db[IDENTITY_EMAIL_LINK_COLLECTION].insert_one(payload)
    except Exception:
        # Race-safe re-read: if another request won the unique-email insert,
        # validate that it points to the same UID rather than silently changing it.
        existing = await db[IDENTITY_EMAIL_LINK_COLLECTION].find_one(
            {"email_normalized": normalized},
            {"_id": 0},
        )
        existing_uid = _clean((existing or {}).get("identity_uid")).upper()
        if existing_uid != uid:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This email is already linked to another organization identity "
                    f"({existing_uid or 'unknown'}). One email cannot be linked to two unique IDs."
                ),
            )
    return uid


async def ensure_licensee_uid(
    db, customer_id: str, customer: Optional[dict] = None
) -> str:
    customer_id = _clean(customer_id)
    if not customer_id:
        raise HTTPException(
            status_code=400,
            detail="Commercial customer identity is required.",
        )

    existing = customer or await db.commercial_license_customers.find_one(
        {"id": customer_id}, {"_id": 0}
    )
    current = _clean((existing or {}).get("licensee_uid"))
    if _UID_RE.match(current) and current.startswith("L-"):
        return current

    seq = await _allocate_sequence_async(db, "licensee")
    candidate = f"L-{seq:06d}"
    result = await db.commercial_license_customers.update_one(
        {
            "id": customer_id,
            "$or": [
                {"licensee_uid": {"$exists": False}},
                {"licensee_uid": ""},
                {"licensee_uid": None},
            ],
        },
        {"$set": {"licensee_uid": candidate}},
    )
    if result.modified_count:
        return candidate

    refreshed = await db.commercial_license_customers.find_one(
        {"id": customer_id}, {"_id": 0}
    )
    refreshed_uid = _clean((refreshed or {}).get("licensee_uid"))
    if _UID_RE.match(refreshed_uid) and refreshed_uid.startswith("L-"):
        return refreshed_uid

    await db.commercial_license_customers.update_one(
        {"id": customer_id},
        {"$set": {"licensee_uid": candidate}},
    )
    return candidate


async def ensure_license_uid(
    db, licensee_uid: str, license_doc: Optional[dict] = None
) -> str:
    current = _clean((license_doc or {}).get("license_uid"))
    if _LICENSE_UID_RE.match(current):
        return current
    seq = await _allocate_sequence_async(db, f"{licensee_uid}:license")
    return f"LIC-{licensee_uid}-{seq:02d}"


async def ensure_user_uid(
    db,
    user: dict,
    *,
    organization_uid: Optional[str] = None,
    identity_type: Optional[str] = None,
) -> str:
    current = _clean(user.get("user_uid"))
    existing_org = _clean(user.get("identity_org_uid") or organization_uid)
    if _USER_UID_RE.match(current):
        if existing_org:
            await ensure_identity_email_link(
                db,
                user.get("email"),
                existing_org,
                identity_type="platform_owner" if existing_org.upper().startswith("PO-") else "licensee",
            )
            await _set_counter_max(
                db,
                f"{existing_org}:user",
                _extract_seq(current, _USER_UID_RE, 3),
            )
        return current

    org_uid = _clean(organization_uid or user.get("identity_org_uid"))
    if not _UID_RE.match(org_uid):
        raise HTTPException(
            status_code=400,
            detail="A valid organization identity is required for this user.",
        )

    # The login identity is email-only. The hierarchical organization UID is
    # linked to the user's email, but the UID is never entered on the login form.
    await ensure_identity_email_link(
        db,
        user.get("email"),
        org_uid,
        identity_type="platform_owner" if org_uid.startswith("PO-") else "licensee",
    )

    seq = await _allocate_sequence_async(db, f"{org_uid}:user")
    candidate = f"{org_uid}-U-{seq:06d}"
    update = {
        "user_uid": candidate,
        "identity_org_uid": org_uid,
        "email_normalized": _normalized_email(user.get("email")),
    }
    if identity_type:
        update["identity_type"] = identity_type

    key = {"_id": user.get("_id")} if user.get("_id") is not None else {"id": user.get("id")}
    await db.users.update_one(key, {"$set": update})
    return candidate


async def ensure_platform_owner_identity(db, user: Optional[dict] = None) -> str:
    uid = _owner_uid()
    if user is not None:
        existing_uid = _clean(user.get("platform_owner_uid"))
        if _UID_RE.match(existing_uid) and existing_uid.startswith("PO-"):
            uid = existing_uid

    await db.companies.update_many(
        {"is_platform_owner_workspace": True},
        {
            "$set": {
                "platform_owner_uid": uid,
                "identity_type": "platform_owner_workspace",
            }
        },
    )
    return uid


async def enrich_user_identity(db, user: dict) -> dict:
    data = dict(user or {})

    # Reserved Platform Owner email identities take precedence over stale
    # commercial fields from older records. New licensees are prevented from
    # using these emails, so this is a deterministic legacy repair.
    try:
        from backend.platform_owner import platform_owner_emails

        owner_email = _normalized_email(data.get("email"))
        if owner_email and owner_email in platform_owner_emails():
            owner_uid = await ensure_platform_owner_identity(db, data)
            data["platform_owner_uid"] = owner_uid
            data["identity_org_uid"] = owner_uid
            data["identity_type"] = (
                "platform_owner_admin"
                if str(data.get("role", "")).lower() == "admin"
                else "platform_owner_user"
            )
            data["email_normalized"] = owner_email
            data["is_platform_owner"] = True
            if not _USER_UID_RE.match(_clean(data.get("user_uid"))):
                data["user_uid"] = await ensure_user_uid(
                    db,
                    data,
                    organization_uid=owner_uid,
                    identity_type=data["identity_type"],
                )
            return data
    except Exception:
        logger.exception("Reserved Platform Owner email enrichment failed.")

    # The organization identity is authoritative for login. Once an email is
    # linked to PO-######, stale commercial fields must not turn the owner into
    # a commercial tenant and trigger a 403.
    data_identity_type = _clean(data.get("identity_type")).lower()
    data_org_uid = _clean(data.get("identity_org_uid")).upper()
    data_owner_uid = _clean(data.get("platform_owner_uid")).upper()
    data_user_uid = _clean(data.get("user_uid")).upper()
    explicit_owner_identity = (
        bool(data.get("is_platform_owner"))
        or data_identity_type.startswith("platform_owner")
        or data_org_uid.startswith("PO-")
        or data_owner_uid.startswith("PO-")
        or data_user_uid.startswith("PO-")
    )

    if explicit_owner_identity:
        try:
            owner_uid = await ensure_platform_owner_identity(db, data)
            data["platform_owner_uid"] = owner_uid
            data["identity_org_uid"] = owner_uid
            data["identity_type"] = data.get("identity_type") or (
                "platform_owner_admin"
                if str(data.get("role", "")).lower() == "admin"
                else "platform_owner_user"
            )
            data["email_normalized"] = _normalized_email(data.get("email"))
            data["is_platform_owner"] = True
            if not _USER_UID_RE.match(_clean(data.get("user_uid"))):
                data["user_uid"] = await ensure_user_uid(
                    db,
                    data,
                    organization_uid=owner_uid,
                    identity_type=data["identity_type"],
                )
            return data
        except Exception:
            logger.exception("Platform Owner identity enrichment failed.")

    if is_commercial_identity_record(data):
        customer_id = _clean(data.get("commercial_customer_id"))
        license_id = _clean(data.get("license_id"))
        active_license = None
        if license_id:
            try:
                active_license = await db.commercial_licenses.find_one(
                    {"id": license_id},
                    {"_id": 0, "id": 1, "customer_id": 1, "licensee_uid": 1, "license_uid": 1},
                )
            except Exception:
                logger.exception("Could not resolve license link while enriching tenant identity.")

        # The linked license's customer_id is authoritative for a commercial
        # login. Older rows have been observed with company_id still pointing at
        # the Platform Owner workspace, causing cross-company 403s and failed
        # background reconciliation even though the license itself is valid.
        if active_license and _clean(active_license.get("customer_id")):
            linked_customer_id = _clean(active_license.get("customer_id"))
            if customer_id and customer_id != linked_customer_id:
                logger.warning(
                    "Repairing mismatched tenant customer link for user=%s license=%s old_customer=%s linked_customer=%s",
                    _clean(data.get("email")),
                    license_id,
                    customer_id,
                    linked_customer_id,
                )
            customer_id = linked_customer_id
            data["commercial_customer_id"] = customer_id
            data["license_id"] = _clean(active_license.get("id")) or license_id
            if active_license.get("licensee_uid"):
                data["licensee_uid"] = _clean(active_license.get("licensee_uid"))
            if active_license.get("license_uid"):
                data["license_uid"] = _clean(active_license.get("license_uid"))

        current_company_id = _clean(data.get("company_id"))
        company_needs_repair = (
            not current_company_id
            or current_company_id.lower().startswith("platform-owner-")
        )
        canonical_company = None
        if customer_id and company_needs_repair:
            try:
                canonical_company = await db.companies.find_one(
                    {
                        "commercial_customer_id": customer_id,
                        "$or": [
                            {"source": "commercial-license"},
                            {"identity_type": "licensee_company"},
                            {"licensee_uid": {"$exists": True}},
                        ],
                    },
                    {"_id": 0, "id": 1, "name": 1, "commercial_customer_id": 1, "licensee_uid": 1},
                )
                if not canonical_company:
                    candidate = await db.companies.find_one(
                        {"id": customer_id},
                        {"_id": 0, "id": 1, "name": 1, "commercial_customer_id": 1, "source": 1, "identity_type": 1},
                    )
                    if candidate and (
                        str(candidate.get("source") or "") == "commercial-license"
                        or str(candidate.get("identity_type") or "") == "licensee_company"
                        or str(candidate.get("commercial_customer_id") or "") == customer_id
                    ):
                        canonical_company = candidate
            except Exception:
                logger.exception("Could not resolve canonical commercial company for user=%s", _clean(data.get("email")))

        if canonical_company and _clean(canonical_company.get("id")):
            repaired_company_id = _clean(canonical_company.get("id"))
            if repaired_company_id != current_company_id:
                data["company_id"] = repaired_company_id
                if canonical_company.get("name"):
                    data["company_name"] = canonical_company.get("name")
                logger.warning(
                    "Repaired commercial company link for user=%s old_company_id=%s new_company_id=%s customer_id=%s",
                    _clean(data.get("email")),
                    current_company_id,
                    repaired_company_id,
                    customer_id,
                )
                user_id = _clean(data.get("id"))
                if user_id:
                    await db.users.update_one(
                        {"id": user_id},
                        {
                            "$set": {
                                "company_id": repaired_company_id,
                                "company_name": data.get("company_name"),
                                "commercial_customer_id": customer_id,
                                "license_id": data.get("license_id") or license_id,
                            }
                        },
                    )

        licensee_uid = _clean(data.get("licensee_uid"))
        if not licensee_uid and customer_id:
            licensee_uid = await ensure_licensee_uid(db, customer_id)

        if licensee_uid:
            data["licensee_uid"] = licensee_uid
            data["identity_org_uid"] = licensee_uid
            data["identity_type"] = data.get("identity_type") or (
                "licensee_admin"
                if str(data.get("role", "")).lower() == "admin"
                else "licensee_user"
            )
            data["email_normalized"] = _normalized_email(data.get("email"))
            data["is_platform_owner"] = False
            if not _USER_UID_RE.match(_clean(data.get("user_uid"))):
                data["user_uid"] = await ensure_user_uid(
                    db,
                    data,
                    organization_uid=licensee_uid,
                    identity_type=data["identity_type"],
                )
            return data

    try:
        from backend.platform_owner import is_platform_owner

        if is_platform_owner(data):
            owner_uid = await ensure_platform_owner_identity(db, data)
            data["platform_owner_uid"] = owner_uid
            data["identity_org_uid"] = owner_uid
            data["identity_type"] = data.get("identity_type") or (
                "platform_owner_admin"
                if str(data.get("role", "")).lower() == "admin"
                else "platform_owner_user"
            )
            data["email_normalized"] = _normalized_email(data.get("email"))
            data["is_platform_owner"] = True
            if not _USER_UID_RE.match(_clean(data.get("user_uid"))):
                data["user_uid"] = await ensure_user_uid(
                    db,
                    data,
                    organization_uid=owner_uid,
                    identity_type=data["identity_type"],
                )
            return data
    except Exception:
        pass

    return data


async def repair_platform_owner_identity_records(db) -> int:
    """Repair legacy Platform Owner records without changing MongoDB ids."""
    from backend.platform_owner import platform_owner_emails

    owner_uid = await ensure_platform_owner_identity(db)
    emails = sorted(platform_owner_emails())
    query = {
        "$or": [
            {"is_platform_owner": True},
            {"role": {"$in": ["platform_owner", "superadmin", "saas_admin"]}},
            {"id": {"$in": ["saas-bootstrap-admin", "usr-admin-01"]}},
            {"company_id": {"$regex": r"^platform-owner-", "$options": "i"}},
            {"email": {"$in": emails}},
            {"platform_owner_uid": owner_uid},
            {"identity_org_uid": owner_uid},
        ]
    }
    users = await db.users.find(query, {"_id": 1, "id": 1, "email": 1, "role": 1, "user_uid": 1}).to_list(5000)
    repaired = 0

    for user in users:
        email = _normalized_email(user.get("email"))
        if email and email in emails:
            await db[IDENTITY_EMAIL_LINK_COLLECTION].update_one(
                {"email_normalized": email},
                {
                    "$set": {
                        "email": _clean(user.get("email")),
                        "email_normalized": email,
                        "identity_uid": owner_uid,
                        "identity_type": "platform_owner",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    "$setOnInsert": {
                        "_id": email,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    },
                },
                upsert=True,
            )

        identity_type = (
            "platform_owner_admin"
            if str(user.get("role") or "").lower() == "admin"
            else "platform_owner_user"
        )
        working = dict(user)
        working["platform_owner_uid"] = owner_uid
        working["identity_org_uid"] = owner_uid
        working["identity_type"] = identity_type
        working["email_normalized"] = email
        uid = await ensure_user_uid(
            db,
            working,
            organization_uid=owner_uid,
            identity_type=identity_type,
        )

        key = {"_id": user.get("_id")} if user.get("_id") is not None else {"id": user.get("id")}
        await db.users.update_one(
            key,
            {
                "$set": {
                    "platform_owner_uid": owner_uid,
                    "identity_org_uid": owner_uid,
                    "identity_type": identity_type,
                    "email_normalized": email,
                    "user_uid": uid,
                    "is_platform_owner": True,
                },
                "$unset": {
                    "licensee_uid": "",
                    "commercial_customer_id": "",
                    "license_id": "",
                    "license_key": "",
                    "licensed_modules": "",
                    "selected_features": "",
                },
            },
        )
        repaired += 1

    return repaired


async def _migrate_platform_owner_users(db, owner_uid: str) -> int:
    from backend.platform_owner import platform_owner_emails

    emails = sorted(platform_owner_emails())
    query = {
        "$or": [
            {"is_platform_owner": True},
            {"role": {"$in": ["platform_owner", "superadmin", "saas_admin"]}},
            {"id": {"$in": ["saas-bootstrap-admin", "usr-admin-01"]}},
            {"company_id": {"$regex": r"^platform-owner-", "$options": "i"}},
            {"email": {"$in": emails}},
        ]
    }
    users = await db.users.find(query, {"_id": 0}).to_list(5000)
    migrated = 0

    for user in users:
        user["platform_owner_uid"] = _clean(user.get("platform_owner_uid")) or owner_uid
        user["identity_org_uid"] = user["platform_owner_uid"]
        user["identity_type"] = (
            "platform_owner_admin"
            if str(user.get("role", "")).lower() == "admin"
            else "platform_owner_user"
        )
        user["email_normalized"] = _normalized_email(user.get("email"))

        # Platform Owner email addresses are reserved identities. When legacy
        # data has the same email linked to an L-* tenant, resolve the existing
        # conflict in favour of the authoritative PO-* identity before the user
        # receives its hierarchical user UID.
        if user["email_normalized"]:
            await db[IDENTITY_EMAIL_LINK_COLLECTION].update_one(
                {"email_normalized": user["email_normalized"]},
                {
                    "$set": {
                        "email": _clean(user.get("email")),
                        "email_normalized": user["email_normalized"],
                        "identity_uid": user["platform_owner_uid"],
                        "identity_type": "platform_owner",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    "$setOnInsert": {
                        "_id": user["email_normalized"],
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    },
                },
                upsert=True,
            )

        uid = await ensure_user_uid(
            db,
            user,
            organization_uid=user["platform_owner_uid"],
            identity_type=user["identity_type"],
        )
        await db.users.update_one(
            {"id": user.get("id")},
            {
                "$set": {
                    "platform_owner_uid": user["platform_owner_uid"],
                    "identity_org_uid": user["identity_org_uid"],
                    "identity_type": user["identity_type"],
                    "user_uid": uid,
                    "email_normalized": user["email_normalized"],
                    "is_platform_owner": True,
                },
                "$unset": {
                    "licensee_uid": "",
                    "commercial_customer_id": "",
                    "license_id": "",
                    "license_key": "",
                    "licensed_modules": "",
                    "selected_features": "",
                },
            },
        )
        migrated += 1

    return migrated


async def _migrate_licensees(db) -> tuple[int, int]:
    customers = await db.commercial_license_customers.find(
        {}, {"_id": 0}
    ).sort([("created_at", 1), ("id", 1)]).to_list(10000)

    max_licensee_seq = 0
    for existing_customer in customers:
        max_licensee_seq = max(
            max_licensee_seq,
            _extract_seq(existing_customer.get("licensee_uid"), _UID_RE, 2),
        )
    await _set_counter_max(db, "licensee", max_licensee_seq)

    migrated_customers = 0
    migrated_users = 0

    for customer in customers:
        customer_id = _clean(customer.get("id"))
        if not customer_id:
            continue

        licensee_uid = await ensure_licensee_uid(db, customer_id, customer)
        await db.commercial_license_customers.update_one(
            {"id": customer_id},
            {
                "$set": {
                    "licensee_uid": licensee_uid,
                    "identity_type": "licensee",
                }
            },
        )
        await db.commercial_licenses.update_many(
            {"customer_id": customer_id},
            {"$set": {"licensee_uid": licensee_uid}},
        )

        companies = await db.companies.find(
            {
                "$or": [
                    {"commercial_customer_id": customer_id},
                    {"id": customer_id},
                ]
            },
            {"_id": 0, "id": 1},
        ).to_list(100)
        company_ids = [str(c.get("id")) for c in companies if c.get("id")]

        for company_id in company_ids:
            await db.companies.update_one(
                {"id": company_id},
                {
                    "$set": {
                        "licensee_uid": licensee_uid,
                        "identity_type": "licensee_company",
                    }
                },
            )

        existing_users = await db.users.find(
            {
                "$or": [
                    {"commercial_customer_id": customer_id},
                    {"licensee_uid": licensee_uid},
                    {"company_id": {"$in": company_ids}},
                ]
            },
            {"_id": 0},
        ).to_list(10000)

        max_uid = 0
        for user in existing_users:
            value = _extract_seq(user.get("user_uid"), _USER_UID_RE, 3)
            max_uid = max(max_uid, value)

        await _set_counter_max(db, f"{licensee_uid}:user", max_uid)

        for user in existing_users:
            if str(user.get("status") or "").lower() == "deleted":
                continue

            user["licensee_uid"] = licensee_uid
            user["identity_org_uid"] = licensee_uid
            user["identity_type"] = (
                "licensee_admin"
                if str(user.get("role", "")).lower() == "admin"
                else "licensee_user"
            )
            user["email_normalized"] = _normalized_email(user.get("email"))
            uid = await ensure_user_uid(
                db,
                user,
                organization_uid=licensee_uid,
                identity_type=user["identity_type"],
            )
            await db.users.update_one(
                {"id": user.get("id")},
                {
                    "$set": {
                        "licensee_uid": licensee_uid,
                        "identity_org_uid": licensee_uid,
                        "identity_type": user["identity_type"],
                        "user_uid": uid,
                        "email_normalized": user["email_normalized"],
                    }
                },
            )
            migrated_users += 1

        licenses = await db.commercial_licenses.find(
            {"customer_id": customer_id}, {"_id": 0}
        ).to_list(1000)
        max_license_seq = 0
        await _set_counter_max(db, f"{licensee_uid}:license", 0)

        for license_doc in licenses:
            license_uid = _clean(license_doc.get("license_uid"))
            if not _LICENSE_UID_RE.match(license_uid):
                seq = await _allocate_sequence_async(db, f"{licensee_uid}:license")
                license_uid = f"LIC-{licensee_uid}-{seq:02d}"
                await db.commercial_licenses.update_one(
                    {"id": license_doc.get("id")},
                    {"$set": {"license_uid": license_uid}},
                )
            max_license_seq = max(
                max_license_seq,
                _extract_seq(license_uid, _LICENSE_UID_RE, 3),
            )

        await _set_counter_max(db, f"{licensee_uid}:license", max_license_seq)
        migrated_customers += 1

    return migrated_customers, migrated_users


async def migrate_identity_email_links(db) -> dict:
    """Backfill existing organization-email links without creating new UIDs."""
    marker = await db.identity_migrations.find_one(
        {"_id": EMAIL_IDENTITY_LINK_MIGRATION_KEY}
    )
    if marker and marker.get("completed") is True:
        return {
            "status": "already-completed",
            "linked": marker.get("linked", 0),
            "conflicts": marker.get("conflicts", 0),
        }

    await ensure_identity_indexes(db)
    linked = 0
    conflicts = 0

    try:
        owner_uid = await ensure_platform_owner_identity(db)
        owner_users = await _migrate_platform_owner_users(db, owner_uid)
        for user in await db.users.find(
            {
                "$or": [
                    {"platform_owner_uid": owner_uid},
                    {"is_platform_owner": True},
                    {"role": {"$in": ["platform_owner", "superadmin", "saas_admin"]}},
                ],
                "status": {"$ne": "deleted"},
            },
            {"email": 1},
        ).to_list(5000):
            try:
                if _normalized_email(user.get("email")):
                    await ensure_identity_email_link(
                        db,
                        user.get("email"),
                        owner_uid,
                        identity_type="platform_owner",
                    )
                    linked += 1
            except HTTPException as exc:
                conflicts += 1
                logger.warning(
                    "Identity email link conflict for platform owner email %s: %s",
                    _normalized_email(user.get("email")),
                    exc.detail,
                )

        customers = await db.commercial_license_customers.find(
            {}, {"_id": 0, "id": 1, "email": 1, "licensee_uid": 1}
        ).to_list(10000)
        for customer in customers:
            email = _normalized_email(customer.get("email"))
            licensee_uid = _clean(customer.get("licensee_uid")).upper()
            if not email or not _UID_RE.match(licensee_uid):
                continue
            try:
                await ensure_identity_email_link(
                    db,
                    customer.get("email"),
                    licensee_uid,
                    identity_type="licensee",
                )
                linked += 1
            except HTTPException as exc:
                conflicts += 1
                logger.warning(
                    "Identity email link conflict for licensee %s email %s: %s",
                    licensee_uid,
                    email,
                    exc.detail,
                )
    finally:
        await db.identity_migrations.update_one(
            {"_id": EMAIL_IDENTITY_LINK_MIGRATION_KEY},
            {
                "$set": {
                    "completed": True,
                    "linked": linked,
                    "conflicts": conflicts,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )

    return {
        "status": "completed",
        "linked": linked,
        "conflicts": conflicts,
    }


async def migrate_hierarchical_identities(db) -> dict:
    marker = await db.identity_migrations.find_one({"_id": IDENTITY_MIGRATION_KEY})
    if marker and marker.get("completed") is True:
        try:
            await repair_platform_owner_identity_records(db)
        except Exception:
            logger.exception("Platform Owner identity repair warning.")
        try:
            await migrate_identity_email_links(db)
        except Exception:
            logger.exception("Email identity link bootstrap warning.")
        return {
            "status": "already-completed",
            "platform_owner_uid": marker.get("platform_owner_uid"),
            "licensees": marker.get("licensees", 0),
            "users": marker.get("users", 0),
        }

    await ensure_identity_indexes(db)

    owner_uid = await ensure_platform_owner_identity(db)
    owner_users = await _migrate_platform_owner_users(db, owner_uid)
    try:
        owner_users += await repair_platform_owner_identity_records(db)
    except Exception:
        logger.exception("Platform Owner identity repair warning.")
    licensees, commercial_users = await _migrate_licensees(db)

    # Link the already-assigned organization UIDs to their emails only after
    # the hierarchy migration has established the L-* and PO-* identities.
    try:
        await migrate_identity_email_links(db)
    except Exception:
        logger.exception("Email identity link bootstrap warning.")

    await db.identity_migrations.update_one(
        {"_id": IDENTITY_MIGRATION_KEY},
        {
            "$set": {
                "completed": True,
                "platform_owner_uid": owner_uid,
                "platform_owner_users": owner_users,
                "licensees": licensees,
                "users": commercial_users,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )

    return {
        "status": "completed",
        "platform_owner_uid": owner_uid,
        "platform_owner_users": owner_users,
        "licensees": licensees,
        "users": commercial_users,
    }


async def resolve_user_for_login(db, email: str) -> dict:
    normalized = _normalized_email(email)
    base = {
        "status": {"$ne": "deleted"},
        "$or": [
            {"email_normalized": normalized},
            {"email": normalized},
        ],
    }

    # Canonical login resolution is email-only. The identity link chooses
    # the one organization UID to which this email is permitted to belong.
    link = await db[IDENTITY_EMAIL_LINK_COLLECTION].find_one(
        {"email_normalized": normalized},
        {"_id": 0, "identity_uid": 1},
    )
    if link and _clean(link.get("identity_uid")):
        org_uid = _clean(link.get("identity_uid")).upper()
        linked_user = await db.users.find_one(
            {
                **base,
                "identity_org_uid": org_uid,
            },
            sort=[("status", 1), ("created_at", 1)],
        )
        if linked_user:
            return linked_user

        if org_uid.startswith("PO-"):
            linked_user = await db.users.find_one(
                {
                    **base,
                    "platform_owner_uid": org_uid,
                },
                sort=[("status", 1), ("created_at", 1)],
            )
            if linked_user:
                return linked_user

        if org_uid.startswith("L-"):
            customers = await db.commercial_license_customers.find(
                {"licensee_uid": org_uid},
                {"id": 1},
            ).to_list(10)
            ids = [str(x.get("id")) for x in customers if x.get("id")]
            if ids:
                linked_user = await db.users.find_one(
                    {
                        **base,
                        "commercial_customer_id": {"$in": ids},
                    },
                    sort=[("status", 1), ("created_at", 1)],
                )
                if linked_user:
                    return linked_user

    users = await db.users.find(
        base,
        {"_id": 0},
    ).limit(10).to_list(10)
    if len(users) == 1:
        return users[0]
    if len(users) > 1:
        raise HTTPException(
            status_code=409,
            detail=(
                "This email is linked to more than one account. "
                "One email can belong to only one organization identity."
            ),
        )
    raise HTTPException(status_code=401, detail="Invalid email or password.")
    users = await db.users.find(base, {"_id": 0}).limit(10).to_list(10)
    if len(users) == 1:
        return users[0]
    if len(users) > 1:
        raise HTTPException(
            status_code=409,
            detail=(
                "This email is used in more than one workspace. "
                "Enter your Organization ID, for example L-000001 or PO-000001."
            ),
        )
    raise HTTPException(status_code=401, detail="Invalid email or password.")
