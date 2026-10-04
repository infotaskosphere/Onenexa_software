            for flag in (
                "can_view_purchase","can_view_sale","can_view_bank",
                "can_view_chart_of_accounts","can_manage_chart_of_accounts",
                "can_view_journal_entries","can_post_journal_entries",
                "can_view_accounting_reports","can_match_bank",
            ):
                normalized[flag]=bool(perms.get(flag,False))
        except Exception:
            # Permission normalization must never prevent login. The stored
            # explicit map remains authoritative if the catalog cannot load.
            pass
    d["permissions"]=normalized
    return d

async def _touch_saas_session_if_due(raw_db, session):
    """Refresh SaaS session activity at most once per minute."""
    try:
        session_id = session.get("_id")
        if session_id is None:
            return
        last_seen = session.get("last_seen_at")
        if isinstance(last_seen, str):
            try:
                last_seen = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
            except Exception:
                last_seen = None
        now = datetime.now(timezone.utc)
        if (
            isinstance(last_seen, datetime)
            and last_seen.tzinfo is None
        ):
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        if (
            isinstance(last_seen, datetime)
            and (now - last_seen).total_seconds() < 60
        ):
            return
        await raw_db.sessions.update_one(
            {"_id": session_id},
            {"$set": {"last_seen_at": now}},
        )
        session["last_seen_at"] = now
    except Exception:
        logger.warning("SaaS session heartbeat update skipped.", exc_info=True)


async def _get_saas_session_user(token: str):
    """Resolve the opaque SaaS session token created by saas-auth-runtime.cjs."""
    if not token or not MONGO_URL:
        return None
    try:
        import hashlib
        token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest()
        raw_db = globals().get("_raw_db", db)
        session=await raw_db.sessions.find_one({
            "token_hash": token_hash,
            "$or": [
                {"status": "active"},
                {"status": {"$exists": False}},
            ],
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        if not session:
            return None
        user_id=session.get("user_id")
        user=None
        if user_id is not None:
            try:
                oid=user_id if isinstance(user_id,ObjectId) else ObjectId(str(user_id))
                user=await raw_db.users.find_one({"_id": oid, "status": "active"})
            except Exception:
                user=await raw_db.users.find_one({"id": str(user_id), "status": "active"})
        if not user:
            return None

        # The platform owner is not a commercial tenant: they have no
        # company_id by design and must not be forced through the
        # company/subscription checks below (that path is only for
        # licensed customer users). Mirrors the same exemption already
        # applied in _create_saas_session() at login time.
        if is_platform_owner(user):
            await _touch_saas_session_if_due(raw_db, session)
            user_data={k:v for k,v in user.items() if k != "_id"}
            user_data["id"]=str(user.get("_id") or user.get("id"))
            user_data["company_id"]=None
            user_data["company_name"]=None
            user_data=_normalize_permissions(user_data)
            return User(**user_data)

        user_company_id = str(user.get("company_id") or "").strip()
        session_company_id = str(session.get("company_id") or "").strip()
        # A persisted session is never allowed to move an identity across
        # tenants. If both records carry a company, they must agree exactly.
        if user_company_id and session_company_id and user_company_id != session_company_id:
            logger.warning("Rejecting SaaS session with user/company mismatch for user %s.", user_id)
            return None
        company_id = user_company_id or session_company_id
        if not company_id:
            return None
        company=await raw_db.companies.find_one({"id": company_id, "status": "active"})
        if not company:
            company=await raw_db.companies.find_one({"_id": company_id, "status": "active"})
        if not company:
            try: company=await raw_db.companies.find_one({"_id": ObjectId(str(company_id)), "status": "active"})
            except Exception: pass
        if not company:
            return None
        subscription=await raw_db.subscriptions.find_one({"company_id": company_id})
        if not subscription:
            try: subscription=await raw_db.subscriptions.find_one({"company_id": ObjectId(str(company_id))})