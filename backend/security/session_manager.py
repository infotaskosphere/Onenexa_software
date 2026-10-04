                if newer_time and curr_time and newer_time > curr_time:
                    return True
            return False
        else:
            # Session doc was replaced or not found; if another active session exists, this one was replaced
            active_other = await raw_db.session_manager.find_one({
                "$or": user_or_filters,
                "status": "active",
            })
            if not active_other:
                active_other = await raw_db.sessions.find_one({
                    "$or": user_or_filters,
                    "status": "active",
                })
            if active_other:
                return True

    # Fallback for JWT tokens without embedded sid
    try:
        active_sessions = await raw_db.session_manager.find(
            {"$or": user_or_filters, "status": "active"}
        ).to_list(1000)
    except Exception:
        return False

    if not active_sessions:
        return False

    latest_login = max(
        (
            _as_utc(session.get("login_at") or session.get("created_at"))
            for session in active_sessions
            if _as_utc(session.get("login_at") or session.get("created_at")) is not None
        ),
        default=None,
    )
    if latest_login is None or issued_at is None:
        return False

    return latest_login > issued_at.replace(microsecond=0) + timedelta(seconds=5)


async def _guarded_get_current_user(request, credentials):
    from fastapi import HTTPException

    original = dependencies.__dict__["_single_session_original_get_current_user"]
    # Keep the public dependency signature `(request, credentials)` so
    # FastAPI injects both values, but call the wrapped function with the
    # signature it actually had when this guard was installed. The auth
    # compatibility layers can leave either a one-argument function
    # `(credentials)` or a two-argument function `(request, credentials)`.
    # Passing two arguments to the former makes every protected endpoint
    # fail with an unhandled TypeError/HTTP 500.
    accepts_request = dependencies.__dict__.get(
        "_single_session_original_accepts_request",
        True,
    )
    if accepts_request:
        user = await original(request, credentials)
    else:
        user = await original(credentials)
    if await _session_was_replaced(user, credentials.credentials):
        raise HTTPException(
            status_code=401,
            detail=SESSION_REPLACED_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


class SessionManager:
    @staticmethod
    async def has_active_user_session(user_id: str, email: str = None) -> bool:
        """Return True when this account has an active session."""
        raw_db = _raw_db()
        try:
            filters = [{"user_id": str(user_id)}]
            if email:
                filters.append({"email": str(email).strip().lower()})
            session = await raw_db.session_manager.find_one(
                {"$or": filters, "status": "active"}
            )
            return session is not None
        except Exception:
            return False

    @staticmethod
    async def assert_single_device_login_allowed(user_id: str, email: str = None) -> None:
        """Allow single-session logins to proceed by superseding previous sessions."""
        return

    @staticmethod
    async def create_user_session(user_id: str, client_ip: str, user_agent: str, email: str = None) -> str:
        """Create the user's active session.

        For non-platform owners, any prior active session for the same user_id or email
        is marked as replaced so that older devices/browsers are logged out.
        Platform owners are exempted from single-device restrictions and can remain
        concurrently logged in on multiple devices.
        """
        raw_db = _raw_db()
        from backend.platform_owner import is_platform_owner

        norm_email = str(email or "").strip().lower()
        if not norm_email and user_id:
            try:
                found_user = await raw_db.users.find_one(
                    {"$or": [{"id": str(user_id)}, {"_id": user_id}]}
                )
                if found_user:
                    norm_email = str(found_user.get("email") or "").strip().lower()
            except Exception:
                pass

        user_identity = {"id": str(user_id)}
        if norm_email:
            user_identity["email"] = norm_email

        is_owner = is_platform_owner(user_identity)
        now = datetime.now(timezone.utc).isoformat()
        now_dt = datetime.now(timezone.utc)
        expires_at = now_dt + timedelta(minutes=dependencies.ACCESS_TOKEN_EXPIRE_MINUTES)

        if not is_owner:
            # Replace sessions for this exact user only. Email is metadata,
            # not an account identity, and must never evict another user's session.
            query_filters = [{"user_id": str(user_id)}]

            replace_query = {"$or": query_filters, "status": "active"}
            replacement_update = {
                "$set": {
                    "status": "replaced",
                    "replaced_at": now,
                    "revoked_reason": "new_login",
                }
            }
            try:
                await raw_db.session_manager.update_many(replace_query, replacement_update)
            except Exception:
                logger.warning("Failed to mark previous session_manager sessions replaced.")

            try:
                await raw_db.sessions.update_many(replace_query, replacement_update)
            except Exception:
                logger.warning("Failed to mark previous sessions replaced.")

        session_token = f"sess_{uuid.uuid4().hex}"
        session_doc = {
            "session_token": session_token,
            "user_id": str(user_id),
            "email": norm_email,
            "client_ip": client_ip,
            "user_agent": user_agent,
            "status": "active",
            "login_at": now,
            "created_at": now,
            "last_activity_at": now,
            "expires_at": expires_at,
        }
        await raw_db.session_manager.update_one(
            {"session_token": session_token},
            {"$set": session_doc},
            upsert=True,
        )

        # Mirror in sessions collection with sha256 token hash
        try:
            token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            await raw_db.sessions.update_one(
                {"token_hash": token_hash},
                {"$set": {
                    "session_token": session_token,
                    "token_hash": token_hash,
                    "user_id": str(user_id),
                    "email": norm_email,
                    "status": "active",
                    "created_at": now_dt,
                    "login_at": now,
                    "last_seen_at": now_dt,
                    "expires_at": expires_at,
                }},
                upsert=True,
            )
        except Exception:
            logger.warning("SaaS session mirror write failed.")

        # A commercial login must have one authoritative session represented in
        # both stores. Do not leave a partially-created session that can bypass
        # replacement detection after a restart.
        try:
            legacy_ok = await raw_db.session_manager.find_one(
                {"session_token": session_token, "user_id": str(user_id), "status": "active"},
                {"_id": 1},
            )
            mirror_ok = await raw_db.sessions.find_one(
                {"token_hash": hashlib.sha256(session_token.encode("utf-8")).hexdigest(), "user_id": str(user_id), "status": "active"},
                {"_id": 1},
            )
            if not legacy_ok or not mirror_ok:
                raise RuntimeError("Session state was not persisted consistently.")
        except Exception:
            logger.exception("Failed to establish canonical session state; rejecting login session.")
            try:
                await raw_db.session_manager.update_one(
                    {"session_token": session_token},
                    {"$set": {"status": "revoked", "revoked_reason": "session_state_incomplete"}},
                )
                await raw_db.sessions.update_one(
                    {"token_hash": hashlib.sha256(session_token.encode("utf-8")).hexdigest()},
                    {"$set": {"status": "revoked", "revoked_reason": "session_state_incomplete"}},
                )
            except Exception:
                pass
            raise