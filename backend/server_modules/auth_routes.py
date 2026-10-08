"""Phase 2 extracted subsystem: auth_routes.

The implementation below is intentionally preserved from backend.server.py.
register_auth_routes executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.
"""

def register_auth_routes(namespace):
    exec(SOURCE, namespace, namespace)
    return namespace

SOURCE = r'''
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password):
    return pwd_context.hash(password)


def _verify_saas_password(plain_password: str, user: dict) -> bool:
    """Verify the scrypt password record used by the commercial SaaS account."""
    salt_hex = user.get("password_salt")
    expected_hex = user.get("password_hash")
    if not salt_hex or not expected_hex:
        return False

    try:
        derived = hashlib.scrypt(
            str(plain_password).encode("utf-8"),
            salt=str(salt_hex).encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=64,
        ).hex()
        return hmac.compare_digest(derived, str(expected_hex))
    except (TypeError, ValueError):
        return False


def _make_saas_password_record(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16).hex()
    password_hash = hashlib.scrypt(
        str(password).encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=64,
    ).hex()
    return password_hash, salt


def _saas_object_id(value):
    """Return an ObjectId where possible, otherwise the original value."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except Exception:
        return value


async def _sync_saas_bootstrap_password() -> None:
    """Synchronize the configured bootstrap password for an existing SaaS admin."""
    bootstrap_email = str(
        os.getenv("SAAS_BOOTSTRAP_ADMIN_EMAIL", "")
    ).strip().lower()
    bootstrap_password = str(
        os.getenv("SAAS_BOOTSTRAP_ADMIN_PASSWORD", "")
    )

    if not bootstrap_email or not bootstrap_password:
        return

    existing = await db.users.find_one({"email": bootstrap_email})
    if not existing:
        return

    # Only accounts explicitly managed as bootstrap admins may be changed by
    # the bootstrap environment variables. Never overwrite a normal user.
    if existing.get("role") != "admin" and existing.get("bootstrap_managed") is not True:
        return

    password_hash, password_salt = _make_saas_password_record(bootstrap_password)
    update = {
        "$set": {
            "password_hash": password_hash,
            "password_salt": password_salt,
            "role": "admin",
            "status": "active",
            "bootstrap_managed": True,
            "updated_at": datetime.now(timezone.utc),
        }
    }
    await db.users.update_one({"_id": existing.get("_id")}, update)


async def _create_saas_session(user: dict) -> tuple[str, str, User]:
    """Create the opaque session consumed by dependencies.get_current_user()."""
    from backend.platform_owner import is_platform_owner

    is_owner = is_platform_owner(user)
    company_id = user.get("company_id")

    # The platform owner is not a commercial tenant and therefore must not be
    # blocked by customer company/subscription checks. Normal commercial users
    # continue through the existing tenant validation path unchanged.
    company = None
    if is_owner:
        company_id = None
    else:
        if company_id is None:
            raise HTTPException(
                status_code=403,
                detail="Authenticated user is not associated with a company",
            )

        company_query_id = _saas_object_id(company_id)
        # Commercial license companies are keyed by the application-level
        # company/customer id; MongoDB _id is a separate implementation id.
        company = await db.companies.find_one(
            {"id": company_id, "status": "active"}
        )
        if not company:
            company = await db.companies.find_one(
                {"_id": company_query_id, "status": "active"}
            )
        if not company and company_query_id != company_id:
            company = await db.companies.find_one(
                {"_id": company_id, "status": "active"}
            )
        if not company:
            user_license_id = str(user.get("license_id") or "").strip()
            user_customer_id = str(user.get("commercial_customer_id") or "").strip()
            refs = []
            if user_license_id:
                refs.append({"license_id": user_license_id})
            if user_customer_id:
                refs.append({"commercial_customer_id": user_customer_id})
            if refs:
                company = await db.companies.find_one(
                    {"$or": refs, "status": "active"}
                )
                if company:
                    company_id = str(company.get("id") or company_id)
        if not company:
            raise HTTPException(
                status_code=403,
                detail="Commercial company is inactive or unavailable",
            )

        # The commercial license itself is authoritative for a commercial
        # tenant. A separate legacy subscriptions row is not required.
        commercial_license = None
        license_id = str(user.get("license_id") or company.get("license_id") or "").strip()
        customer_id = str(
            user.get("commercial_customer_id")
            or company.get("commercial_customer_id")
            or ""
        ).strip()
        commercial_refs = []
        if license_id:
            commercial_refs.append({"id": license_id})
        if customer_id:
            commercial_refs.append({"customer_id": customer_id})
        commercial_refs.append({"company_id": str(company.get("id") or company_id)})

        commercial_license = await db.commercial_licenses.find_one(
            {"$or": commercial_refs, "status": {"$in": ["active", "trial"]}},
            {"_id": 0},
            sort=[("issued_at", -1)],
        )
        if commercial_license:
            expires_at = commercial_license.get("expires_at")
            if expires_at:
                if isinstance(expires_at, str):
                    try:
                        expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                    except Exception:
                        expires_at = None
                if expires_at:
                    if expires_at.tzinfo is None:
                        expires_at = expires_at.replace(tzinfo=timezone.utc)
                    if expires_at <= datetime.now(timezone.utc):
                        raise HTTPException(status_code=403, detail="Commercial license has expired")
        else:
            subscription = await db.subscriptions.find_one({"company_id": company_id})
            if not subscription:
                subscription = await db.subscriptions.find_one(
                    {"company_id": company_query_id}
                )
            if not subscription:
                raise HTTPException(
                    status_code=403,
                    detail="Commercial subscription is unavailable",
                )
            subscription_status = subscription.get("status")
            if subscription_status not in ("trial", "active"):
                raise HTTPException(
                    status_code=403,
                    detail="Commercial subscription is not active",
                )
            expires_at = subscription.get("expires_at")
            if expires_at:
                if isinstance(expires_at, str):
                    try:
                        expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                    except Exception:
                        expires_at = None
                if expires_at:
                    if expires_at.tzinfo is None:
                        expires_at = expires_at.replace(tzinfo=timezone.utc)
                    if expires_at <= datetime.now(timezone.utc):
                        raise HTTPException(
                            status_code=403,
                            detail="Commercial subscription has expired",
                        )

    session_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    ttl_days = max(1, int(os.getenv("SAAS_SESSION_TTL_DAYS", "30") or 30))
    session_user_id = user.get("_id") or user.get("id")

    user_email = str(user.get("email") or "").strip().lower()

    # Non-platform owner accounts may have only one live session. Mark every older
    # browser/mobile session as replaced before issuing the new token. The
    # platform owner is exempt and may be signed in on multiple devices.
    from backend.platform_owner import is_platform_owner
    if not is_platform_owner(user):
        # Session replacement is keyed by the canonical user id. Email is
        # deliberately NOT a fallback here: legacy data can contain duplicate
        # emails across identities, and using email could log out an unrelated
        # tenant/admin account when another identity signs in.
        user_queries = [{"user_id": session_user_id}, {"user_id": str(session_user_id)}]

        previous_sessions = []
        try:
            previous_sessions.extend(
                await db.sessions.find({"$or": user_queries}).to_list(5000)
            )
        except Exception:
            logger.warning("Could not enumerate previous SaaS sessions for %s.", session_user_id)

        seen_session_ids = set()
        for previous in previous_sessions:
            previous_id = str(previous.get("_id") or "")
            if previous_id in seen_session_ids:
                continue
            seen_session_ids.add(previous_id)
            if previous.get("status") in {"revoked", "replaced"}:
                continue
            try:
                await db.sessions.update_one(
                    {"_id": previous.get("_id")},
                    {
                        "$set": {
                            "status": "replaced",
                            "replaced_at": now,
                            "revoked_reason": "new_login",
                        }
                    },
                )
            except Exception:
                logger.warning("Could not mark a previous SaaS session as replaced.")

        try:
            await db.session_manager.update_many(
                {"$or": user_queries, "status": "active"},
                {
                    "$set": {
                        "status": "replaced",
                        "replaced_at": now.isoformat(),
                        "revoked_reason": "new_login",
                    }
                },
            )
        except Exception:
            pass

    await db.sessions.insert_one({
        "user_id": session_user_id,
        "email": user_email,
        "company_id": company_id,
        "token_hash": token_hash,
        "status": "active",
        "expires_at": now + timedelta(days=ttl_days),
        "created_at": now,
        "last_seen_at": now,
    })

    user_data = {
        key: value
        for key, value in user.items()
        if key not in {"_id", "password", "password_hash", "password_salt", "bootstrap_managed"}
    }
    user_data["id"] = str(user.get("_id") or user.get("id"))
    user_data["company_id"] = str(company_id) if company_id is not None else None
    user_data["company_name"] = company.get("name") if company else None
    user_data["status"] = "active"
    user_data["is_active"] = True
    user_data.setdefault("created_at", now)

    # The bootstrap SaaS account stores permissions as a plain dictionary.
    # Merge them with the existing admin defaults so all existing permission
    # checks continue to behave exactly as they do for legacy users.
    role_defaults = DEFAULT_ROLE_PERMISSIONS.get(
        str(user_data.get("role") or "admin"), {}
    )
    stored_permissions = user_data.get("permissions") or {}
    if hasattr(stored_permissions, "model_dump"):
        stored_permissions = stored_permissions.model_dump()
    user_data["permissions"] = {**role_defaults, **stored_permissions}

    return session_token, str(user_data["id"]), User(**user_data)


async def send_email(to_email: str, subject: str, body: str):
    """Send plain text email via Brevo API (async)."""
    try:
        await _brevo_send(to_email, subject, body)
        return True
    except Exception as e:
        raise Exception(f"Brevo API error: {str(e)}")


# ===========================================================
# Website activity
# ===========================================================



# ===========================================================
# AUTH ROUTES
# ============================================================
@api_router.get("/system/time")
async def get_system_time():
    now = datetime.now(IST)
    return {
        "server_time": now.isoformat(),
        "display_time": now.strftime("%I:%M:%S %p"),
        "date": now.strftime("%Y-%m-%d"),
    }


# =========================
# REFERRERS ROUTES
# =========================


@api_router.get("/referrers")
async def get_referrers(current_user: User = Depends(get_current_user)):
    referrers = await db.referrers.find({}, {"_id": 0}).to_list(500)
    return referrers


@api_router.post("/referrers")
async def create_referrer(data: dict, current_user: User = Depends(get_current_user)):
    name = (data.get("name") or "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Referrer name required")

    existing = await db.referrers.find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0}
    )

    if existing:
        return existing

    referrer = {
        "id": str(uuid.uuid4()),
        "name": name,
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await db.referrers.insert_one(referrer)
    # FIX: insert_one mutates `referrer` in-place by adding `_id: ObjectId(...)`.
    # Returning the dict without popping _id causes FastAPI's jsonable_encoder
    # to fail with: ValueError: [TypeError("'ObjectId' object is not iterable"),
    # TypeError('vars() argument must have __dict__ attribute')]
    referrer.pop("_id", None)
    return referrer


# =========================
# REFERRERS EDIT / DELETE
# =========================


@api_router.put("/referrers")
async def update_referrer(data: dict, current_user: User = Depends(get_current_user)):
    old_name = (data.get("old_name") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(
            status_code=400, detail="old_name and new_name are required"
        )
    conflict = await db.referrers.find_one(
        {"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}}, {"_id": 0}
    )
    if conflict and conflict.get("name", "").lower() != old_name.lower():
        raise HTTPException(
            status_code=400, detail=f'"{new_name}" already exists in the referrer list'
        )
    result = await db.referrers.update_one(
        {"name": {"$regex": f"^{re.escape(old_name)}$", "$options": "i"}},
        {"$set": {"name": new_name}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f'Referrer "{old_name}" not found')
    await db.clients.update_many(
        {"referred_by": old_name}, {"$set": {"referred_by": new_name}}
    )
    return {"ok": True, "name": new_name}


@api_router.delete("/referrers")
async def delete_referrer(name: str, current_user: User = Depends(get_current_user)):
    if not name:
        raise HTTPException(status_code=400, detail="name query param required")
    result = await db.referrers.delete_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f'Referrer "{name}" not found')
    return {"ok": True}


# =========================
# AUDITORS ROUTES
# =========================


@api_router.get("/auditors")
async def get_auditors(current_user: User = Depends(get_current_user)):
    auditors = await db.auditors.find({}, {"_id": 0}).to_list(500)
    return auditors


@api_router.post("/auditors")
async def create_auditor(data: dict, current_user: User = Depends(get_current_user)):
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Auditor name required")
    existing = await db.auditors.find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0}
    )
    if existing:
        return existing
    auditor = {
        "id": str(uuid.uuid4()),
        "name": name,
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.auditors.insert_one(auditor)
    auditor.pop("_id", None)
    return auditor


@api_router.put("/auditors")
async def update_auditor(data: dict, current_user: User = Depends(get_current_user)):
    old_name = (data.get("old_name") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(
            status_code=400, detail="old_name and new_name are required"
        )
    conflict = await db.auditors.find_one(
        {"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}}, {"_id": 0}
    )
    if conflict and conflict.get("name", "").lower() != old_name.lower():
        raise HTTPException(
            status_code=400, detail=f'"{new_name}" already exists in the auditor list'
        )
    result = await db.auditors.update_one(
        {"name": {"$regex": f"^{re.escape(old_name)}$", "$options": "i"}},
        {"$set": {"name": new_name}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f'Auditor "{old_name}" not found')
    await db.clients.update_many({"auditor": old_name}, {"$set": {"auditor": new_name}})
    return {"ok": True, "name": new_name}


@api_router.delete("/auditors")
async def delete_auditor(name: str, current_user: User = Depends(get_current_user)):
    if not name:
        raise HTTPException(status_code=400, detail="name query param required")
    result = await db.auditors.delete_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f'Auditor "{name}" not found')
    return {"ok": True}


# ==========================================================
# TODO DASHBOARD
# ==========================================================

async def _enforce_auth_rate_limit(request: Request, identifier: str, limit_per_minute: int = 10):
    """
    Throttles unauthenticated auth endpoints (login, self-register, OTP) by
    client IP + the email/identifier being targeted, so a single attacker
    can't brute-force passwords or OTP codes. Raises 429 if exceeded.
    """
    client_ip = request.client.host if request and request.client else "unknown"
    key = f"auth:{client_ip}:{(identifier or '').lower()}"
    try:
        if await RateLimiter.is_rate_limited(key, limit_per_minute=limit_per_minute):
            try:
                await AuditSecurity.log_security_event(
                    event_type="rate_limit_blocked",
                    actor_id=identifier or "unknown",
                    company_id="",
                    severity="warning",
                    details=f"Rate limit exceeded from {client_ip} for '{identifier}'.",
                )
            except Exception:
                pass
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait a minute and try again.",
            )
    except HTTPException:
        raise
    except Exception:
        # Fail open on infra errors (e.g. rate-limit store unavailable) —
        # we don't want a DB hiccup to lock everyone out of login.
        logger.warning("Rate limiter check failed; allowing request through.")


# REGISTER Endpoint
@api_router.post("/auth/register", response_model=Token)
async def register(
    user_data: UserCreate, current_user: User = Depends(get_current_user)
):
    # PERMISSION MATRIX (updated):
    # Admin   → can register users with any role
    # Manager → can register staff users only (if can_manage_users is True)
    # Staff   → can register staff users only (if can_manage_users is True)
    perms = get_user_permissions(current_user)
    is_admin = current_user.role == "admin"
    can_manage = perms.get("can_manage_users", False)

    if not is_admin and not can_manage:
        raise HTTPException(
            status_code=403, detail="You do not have permission to register users"
        )

    existing = await db.users.find_one({"email": user_data.email}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_password = get_password_hash(user_data.password)

    requested_role = (
        user_data.role.value if hasattr(user_data.role, "value") else user_data.role
    )

    if requested_role in ["admin", "manager", "superadmin"]:
        if current_user.role != "admin":
            raise HTTPException(
                status_code=400,
                detail="Only staff role can be assigned during registration by non-admin users",
            )

    role_val = requested_role
    default_permissions = DEFAULT_ROLE_PERMISSIONS.get(role_val, {})
    user_id = str(uuid.uuid4())

    def _date_str(v):
        if v is None:
            return None
        return v.isoformat() if hasattr(v, "isoformat") else str(v)

    new_user = {
        "id": user_id,
        "email": user_data.email,
        "full_name": user_data.full_name,
        "role": role_val,
        "password": hashed_password,
        "departments": user_data.departments or [],
        "phone": user_data.phone,
        "birthday": _date_str(user_data.birthday),
        "telegram_id": user_data.telegram_id,
        "punch_in_time": user_data.punch_in_time or "10:30",
        "grace_time": user_data.grace_time or "00:10",
        "punch_out_time": user_data.punch_out_time or "19:00",
        "profile_picture": user_data.profile_picture,
        "is_active": False,
        "status": "pending_approval",
        "approved_by": None,
        "approved_at": None,
        "permissions": user_data.permissions
        if user_data.permissions
        else default_permissions,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # ── Employment / Payroll ─────────────────────────────────────────────
        "joining_date": _date_str(getattr(user_data, "joining_date", None)),
        "training_period_end": _date_str(
            getattr(user_data, "training_period_end", None)
        ),
        "payroll_date": _date_str(getattr(user_data, "payroll_date", None)),
        "monthly_salary": getattr(user_data, "monthly_salary", None),
    }

    await db.users.insert_one(new_user)

    # Background sync (NON-BLOCKING)
    # Safe background runner (kept for future use if needed)
    async def run_safe_background(coro, name="task"):
        try:
            await coro
        except Exception as e:
            logger.error(f"{name} failed: {e}", exc_info=True)

    # ─────────────────────────────────────────────
    # AUTH RESPONSE LOGIC (CLEANED)
    # ─────────────────────────────────────────────

    access_token = create_access_token({"sub": user_id})

    # Remove sensitive fields
    new_user.pop("password", None)
    new_user.pop("_id", None)

    # ❌ REMOVED (Identix sync — no longer exists)
    # asyncio.create_task(run_safe_background(
    #     sync_user_to_identix_devices(new_user),
    #     "identix_sync"
    # ))

    return {"access_token": access_token, "token_type": "bearer", "user": new_user}


@api_router.post("/auth/self-register", response_model=Token)
async def self_register(user_data: UserCreate, request: Request):
    """
    Public self-registration endpoint — no auth token required.
    Role is always forced to 'staff' and status is always 'pending_approval'.
    An admin must approve the account before the user can log in.
    Used by the public /register page.
    """
    await _enforce_auth_rate_limit(request, user_data.email, limit_per_minute=5)

    existing = await db.users.find_one({"email": user_data.email}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_password = get_password_hash(user_data.password)
    default_permissions = DEFAULT_ROLE_PERMISSIONS.get("staff", {})
    user_id = str(uuid.uuid4())

    def _date_str_sr(v):
        if v is None:
            return None
        return v.isoformat() if hasattr(v, "isoformat") else str(v)

    new_user = {
        "id": user_id,
        "email": user_data.email,
        "full_name": user_data.full_name,
        "role": "staff",  # always staff for self-registration
        "password": hashed_password,
        "departments": user_data.departments or [],
        "phone": user_data.phone,
        "birthday": _date_str_sr(user_data.birthday),
        "telegram_id": user_data.telegram_id,
        "punch_in_time": user_data.punch_in_time or "10:30",
        "grace_time": user_data.grace_time or "00:10",
        "punch_out_time": user_data.punch_out_time or "19:00",
        "profile_picture": user_data.profile_picture,
        "is_active": False,
        "status": "pending_approval",  # always pending for self-registration
        "approved_by": None,
        "approved_at": None,
        "permissions": default_permissions,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # ── Employment / Payroll ─────────────────────────────────────────────
        "joining_date": _date_str_sr(getattr(user_data, "joining_date", None)),
        "training_period_end": _date_str_sr(
            getattr(user_data, "training_period_end", None)
        ),
        "payroll_date": _date_str_sr(getattr(user_data, "payroll_date", None)),
    }

    await db.users.insert_one(new_user)
    access_token = create_access_token({"sub": user_id})
    new_user.pop("password", None)
    new_user.pop("_id", None)

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": new_user,
    }


@api_router.post("/auth/login", response_model=Token)
async def login(credentials: UserLogin, request: Request):
    await _enforce_auth_rate_limit(request, credentials.email, limit_per_minute=10)
    client_ip = request.client.host if request and request.client else "unknown"
    normalized_email = str(credentials.email or "").strip().lower()

    # Commercial SaaS bootstrap credentials are stored as scrypt
    # password_hash/password_salt records, not as the legacy bcrypt
    # `password` field. Synchronize an existing bootstrap-managed admin first
    # so changing SAAS_BOOTSTRAP_ADMIN_PASSWORD actually takes effect.
    try:
        await _sync_saas_bootstrap_password()
    except Exception:
        logger.exception("SaaS bootstrap password synchronization failed.")

    user = await db.users.find_one({"email": normalized_email})

    # ── Commercial SaaS account path ────────────────────────────────────────
    if user and user.get("password_hash") and user.get("password_salt"):
        if not _verify_saas_password(credentials.password, user):
            try:
                await AuditSecurity.log_security_event(
                    event_type="login_failed",
                    actor_id=normalized_email,
                    company_id=str(user.get("company_id") or ""),
                    severity="warning",
                    details=f"Failed SaaS login attempt from {client_ip}.",
                )
            except Exception:
                pass
            raise HTTPException(status_code=401, detail="Invalid email or password")

        session_token, _, user_obj = await _create_saas_session(user)

        try:
            await AuditSecurity.log_security_event(
                event_type="login_success",
                actor_id=user_obj.id,
                company_id=str(user_obj.company_id or ""),
                severity="info",
                details=f"SaaS login from {client_ip}",
            )
        except Exception:
            logger.warning("SaaS login audit log failed; continuing.")

        return {
            "access_token": session_token,
            "token_type": "bearer",
            "user": user_obj,
            "consent_given": True,
            "session_token": session_token,
        }

    # ── Existing legacy account path ────────────────────────────────────────
    if not user or not user.get("password") or not verify_password(
        credentials.password, user["password"]
    ):
        try:
            await AuditSecurity.log_security_event(
                event_type="login_failed",
                actor_id=normalized_email,
                company_id=str(user.get("company_id") or "") if user else "",
                severity="warning",
                details=f"Failed login attempt from {client_ip}.",
            )
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_status = user.get("status")
    if user_status is not None and user_status != "active":
        raise HTTPException(
            status_code=403,
            detail=f"Your account is {user_status}. Awaiting admin approval.",
        )

    # Ensure licensee admin role & permissions derived from their active license
    try:
        from backend.commercial_licensee_admin import get_all_admin_permissions, MODULE_HIERARCHY
        from backend.platform_owner import is_platform_owner
        
        cust_id = str(user.get("commercial_customer_id") or user.get("company_id") or "")
        if not cust_id:
            cust = await db.commercial_license_customers.find_one({"email": normalized_email})
            if not cust:
                cust = await db.commercial_customers.find_one({"email": normalized_email})
            if cust:
                cust_id = str(cust.get("id") or "")
                user["role"] = "admin"
                user["company_id"] = user.get("company_id") or cust_id
                user["commercial_customer_id"] = cust_id
                user["status"] = "active"
                user["is_active"] = True

        license_doc = None
        if cust_id:
            licenses = await db.commercial_licenses.find(
                {"customer_id": cust_id, "status": {"$in": ["active", "trial"]}},
                {"_id": 0}
            ).to_list(100)
            if licenses:
                licenses.sort(key=lambda x: str(x.get("issued_at") or ""), reverse=True)
                license_doc = licenses[0]

        if license_doc:
            user["licensed_modules"] = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
            user["selected_features"] = license_doc.get("selected_features") or {}
            user["license_id"] = license_doc.get("id")
            user["license_key"] = license_doc.get("license_key")

        if is_platform_owner(user):
            admin_perms = get_all_admin_permissions()
            user["permissions"] = {**(user.get("permissions") or {}), **admin_perms}
        elif str(user.get("role", "")).lower() == "admin":
            admin_perms = get_all_admin_permissions(license_doc)
            user["permissions"] = admin_perms
            await db.users.update_one(
                {"id": user["id"]},
                {"$set": {
                    "permissions": admin_perms,
                    "licensed_modules": user.get("licensed_modules", []),
                    "selected_features": user.get("selected_features", {}),
                    "commercial_customer_id": cust_id,
                }}
            )
        else:
            current_perms = user.get("permissions", UserPermissions().model_dump())
            if isinstance(current_perms, dict) and license_doc:
                licensed_mods = set(license_doc.get("modules") or [])
                for mod_key, mod_def in MODULE_HIERARCHY.items():
                    if mod_key not in licensed_mods:
                        mod_flag = mod_def.get("flag")
                        if mod_flag:
                            current_perms[mod_flag] = False
                        for p in mod_def.get("pages", []):
                            p_flag = p.get("flag")
                            if p_flag:
                                current_perms[p_flag] = False
            user["permissions"] = current_perms
    except Exception as exc:
        logger.warning("Licensee admin login sync: %s", exc)
        user["permissions"] = user.get("permissions", UserPermissions().model_dump())

    if "created_at" in user and isinstance(user["created_at"], str):
        user["created_at"] = datetime.fromisoformat(user["created_at"])

    user.pop("_id", None)
    user_obj = User(**{k: v for k, v in user.items() if k != "password"})

    # Off-hours access notice (informational only — does not block login).
    now_hour = datetime.now().time()
    is_off_hours = now_hour > dtime(23, 0) or now_hour < dtime(5, 0)

    session_token = None
    try:
        session_token = await SessionManager.create_user_session(
            user_id=user_obj.id,
            client_ip=client_ip,
            user_agent=request.headers.get("user-agent", "unknown"),
            email=normalized_email,
        )
        await AuditSecurity.log_security_event(
            event_type="login_success",
            actor_id=user_obj.id,
            company_id=str(user_obj.company_id or ""),
            severity="info" if not is_off_hours else "warning",
            details=f"Login from {client_ip}" + (" (off-hours access)" if is_off_hours else ""),
        )
    except Exception:
        logger.exception("Session tracking failed on login; refusing partial authentication.")
        raise HTTPException(
            status_code=503,
            detail="Authentication session could not be established. Please try again.",
        )

    token_data = {
        "sub": user_obj.id,
        "email": normalized_email,
        "pwd_ver": getattr(user_obj, "password_version", 1) or 1,
    }
    if session_token:
        token_data["sid"] = session_token
    access_token = create_access_token(token_data)

    # Discretionary New Login Alert based on Commercial Console recovery policy
    try:
        from backend.email_service.recovery_service import AccountRecoveryService
        rec_settings = await AccountRecoveryService.get_recovery_settings()
        if rec_settings.enable_new_login_alerts and user_obj.email:
            from backend.email_service.service import email_service
            await email_service.send_template_email(
                to_email=user_obj.email,
                template_code="NEW_LOGIN",
                context={
                    "user_name": user_obj.full_name or "Valued User",
                    "email": user_obj.email,
                    "ip_address": client_ip,
                    "device_info": (request.headers.get("user-agent") or "Browser")[:75],
                    "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                },
                related_user_id=user_obj.id,
            )
    except Exception as nle:
        logger.warning(f"New login notification dispatch ignored: {nle}")

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user_obj,
        "consent_given": True,
        "session_token": session_token,
    }




@api_router.get("/auth/sessions")
async def list_auth_sessions(current_user: User = Depends(get_current_user)):
    """Return only this authenticated user's active server-side sessions."""
    from backend.security.session_manager import SessionManager
    return await SessionManager.list_user_sessions(str(current_user.id), include_revoked=False)


@api_router.post("/auth/sessions/{session_id}/revoke")
async def revoke_auth_session(session_id: str, current_user: User = Depends(get_current_user)):
    """Revoke one active session belonging to the authenticated user."""
    from backend.security.session_manager import SessionManager
    revoked = await SessionManager.revoke_user_session_by_id(
        str(current_user.id),
        session_id,
        reason="self_revoked",
    )
    if not revoked:
        raise HTTPException(status_code=404, detail="Active session not found.")
    return {"message": "Session revoked.", "session_id": session_id}


@api_router.post("/auth/sessions/revoke-all")
async def revoke_all_auth_sessions(current_user: User = Depends(get_current_user)):
    """Revoke every active session for the authenticated user."""
    from backend.security.session_manager import SessionManager
    revoked = await SessionManager.revoke_all_user_sessions(
        str(current_user.id),
        reason="self_revoked_all",
    )
    return {"message": "All active sessions revoked.", "revoked_count": revoked}


@api_router.post("/auth/logout")
async def logout(
    request: Request,
    session_token: Optional[str] = Body(default=None, embed=True),
    current_user: User = Depends(get_current_user),
):
    """
    Revokes the session record created at login. Note: this does NOT
    invalidate the JWT itself (the token remains cryptographically valid
    until it expires — see ACCESS_TOKEN_EXPIRE_MINUTES in dependencies.py).
    This lets a super-admin portal show/revoke "active sessions" for
    auditing purposes without changing the stateless-JWT auth model.
    """
    revoked = False
    if session_token:
        try:
            revoked = await SessionManager.revoke_session(
                session_token,
                expected_user_id=str(current_user.id),
            )
        except Exception:
            logger.warning("Session revoke failed on logout.")
    try:
        await AuditSecurity.log_security_event(
            event_type="logout",
            actor_id=current_user.id,
            company_id="",
            severity="info",
            details="User logged out.",
        )
    except Exception:
        pass
    return {"message": "Logged out.", "session_revoked": revoked}


@api_router.get("/auth/me", response_model=User)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@api_router.get("/security/scan")
async def security_scan(current_user: User = Depends(require_admin())):
    """
    Admin-only security health check: counts recent critical/warning events
    logged by AuditSecurity (failed logins, rate-limit trips, off-hours
    access, password resets). Foundation for the super-admin security
    dashboard — extend with more event types as new checks are added.
    """
    return await SecurityMonitor.run_security_scan()


@api_router.get("/security/events")
async def security_events(
    limit: int = Query(50, ge=1, le=500),
    current_user: User = Depends(require_admin()),
):
    """Admin-only: recent security events (login failures, resets, etc.)."""
    return await AuditSecurity.get_recent_security_events(limit=limit)


# ── Forgot Email ID / Username Recovery ───────────────────────────────────────

class ForgotEmailBody(BaseModel):
    identifier: str


@api_router.post("/auth/forgot-email")
async def forgot_email_endpoint(data: ForgotEmailBody, request: Request):
    """
    Recovers registered login email without account enumeration.
    Always returns a generic reassuring message.
    """
    from backend.email_service.recovery_service import AccountRecoveryService
    client_ip = request.client.host if request and request.client else "unknown"
    return await AccountRecoveryService.recover_forgot_email_id(data.identifier, client_ip=client_ip)


@app.post("/auth/forgot-email")
async def forgot_email_root_endpoint(data: ForgotEmailBody, request: Request):
    """Mirror route at root /auth/forgot-email."""
    from backend.email_service.recovery_service import AccountRecoveryService
    client_ip = request.client.host if request and request.client else "unknown"
    return await AccountRecoveryService.recover_forgot_email_id(data.identifier, client_ip=client_ip)


# ── Email Verification Endpoints ──────────────────────────────────────────────

@api_router.get("/auth/verify-email")
async def verify_email_endpoint(token: str = Query(...)):
    """Verifies user email via secure single-use token."""
    from backend.email_service.recovery_service import AccountRecoveryService
    result = await AccountRecoveryService.verify_email_token(token)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message"))
    return result


@app.get("/auth/verify-email")
async def verify_email_root_endpoint(token: str = Query(...)):
    """Mirror route at root /auth/verify-email."""
    from backend.email_service.recovery_service import AccountRecoveryService
    result = await AccountRecoveryService.verify_email_token(token)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message"))
    return result


@api_router.post("/auth/send-verification")
async def send_verification_endpoint(
    request: Request,
    current_user: User = Depends(get_current_user)
):
    """Logged in user requests verification email."""
    from backend.email_service.recovery_service import AccountRecoveryService
    base_url = (request.base_url._url if request and request.base_url else "http://localhost:3000").rstrip("/")
    user_dict = current_user.model_dump()
    sent = await AccountRecoveryService.send_verification_email(user_dict, origin_url=base_url)
    if not sent:
        raise HTTPException(status_code=500, detail="Failed to dispatch verification email.")
    return {"status": "success", "message": f"Verification email sent to {current_user.email}."}



# ── Forgot / Reset Password → moved to backend/auth_password_reset.py ─────────
# NOTE: POST /auth/sync-permissions moved to permission_governance.py


'''
