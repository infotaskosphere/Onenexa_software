"""Phase 2 extracted subsystem: users_todos_admin.

The implementation below is intentionally preserved from backend.server.py.
register_users_todos_admin executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.
"""

def register_users_todos_admin(namespace):
    exec(SOURCE, namespace, namespace)
    return namespace

SOURCE = r'''@api_router.post("/todos", response_model=Todo)
async def create_todo(
    todo_data: TodoCreate, current_user: User = Depends(get_current_user)
):
    now = datetime.now(timezone.utc)
    todo = Todo(user_id=current_user.id, **todo_data.model_dump())
    doc = todo.model_dump()

    # Safe conversion with fallback
    doc["created_at"] = (doc.get("created_at") or now).isoformat()
    doc["updated_at"] = (doc.get("updated_at") or now).isoformat()

    if doc.get("due_date"):
        if isinstance(doc["due_date"], (datetime, date)):
            doc["due_date"] = doc["due_date"].isoformat()

    result = await db.todos.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@api_router.get("/todos")
async def get_todos(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    if current_user.role == "admin":
        if user_id == "all":
            query = {}
        elif user_id:
            query = {"user_id": user_id}
        else:
            query = {"user_id": current_user.id}

    else:
        permissions = (
            current_user.permissions.model_dump()
            if hasattr(current_user.permissions, "model_dump")
            else (current_user.permissions or {})
        )
        if not isinstance(permissions, dict):
            permissions = {}
        allowed_others = permissions.get("view_other_todos", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_others = list(set(allowed_others + team_ids))
        if user_id:
            if user_id != current_user.id and user_id not in allowed_others:
                raise HTTPException(status_code=403, detail="Not allowed")
            query = {"user_id": user_id}
        else:
            visible_ids = list(set(allowed_others + [current_user.id]))
            query = {"user_id": {"$in": visible_ids}}

    todos = await db.todos.find(query).to_list(1000)
    for t in todos:
        t["id"] = str(t["_id"])
        del t["_id"]
    return todos


@api_router.get("/dashboard/todo-overview")
async def get_todo_dashboard(current_user: User = Depends(get_current_user)):
    is_admin = current_user.role == "admin"
    if is_admin:
        todos = await db.todos.find().to_list(2000)
        # Replaced N+1 user queries with a single batch lookup
        user_ids = list({t["user_id"] for t in todos if t.get("user_id")})
        users_raw = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(
            1000
        )
        user_name_map = {u["id"]: u.get("full_name", "Unknown User") for u in users_raw}

        grouped_todos = {}
        all_todos_flat = []
        for todo in todos:
            user_name = user_name_map.get(todo["user_id"], "Unknown User")
            if user_name not in grouped_todos:
                grouped_todos[user_name] = []
            todo["_id"] = str(todo["_id"])
            grouped_todos[user_name].append(todo)
            all_todos_flat.append(todo)
        return {
            "role": "admin",
            "todos": all_todos_flat,
            "grouped_todos": grouped_todos,
        }
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_todos", []) or []
        if not isinstance(allowed_users, list):
            allowed_users = []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        query_ids = list(set(allowed_users + [current_user.id]))
        todos = await db.todos.find({"user_id": {"$in": query_ids}}).to_list(2000)
        for todo in todos:
            todo["_id"] = str(todo["_id"])
        return {"role": current_user.role, "todos": todos}


@api_router.post("/todos/{todo_id}/promote-to-task")
async def promote_todo(
    todo_id: str,
    task_data: dict = Body(default={}),
    current_user: User = Depends(get_current_user),
):
    try:
        todo = await db.todos.find_one({"_id": ObjectId(todo_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(
            status_code=403, detail="Not authorized to promote this todo"
        )
    now = datetime.now(IST)

    # Use edited form data from request body; fall back to todo values if not provided
    assigned_to = task_data.get("assigned_to") or todo["user_id"]
    due_date_raw = task_data.get("due_date")
    due_date = None
    if due_date_raw:
        try:
            due_date = datetime.fromisoformat(due_date_raw.replace("Z", "+00:00"))
        except Exception:
            due_date = None

    new_task = {
        "id": str(uuid.uuid4()),
        "title": task_data.get("title") or todo["title"],
        "description": task_data.get("description")
        if "description" in task_data
        else todo.get("description"),
        "assigned_to": assigned_to,
        "sub_assignees": task_data.get("sub_assignees") or [],
        "priority": task_data.get("priority") or "medium",
        "status": task_data.get("status") or "pending",
        "category": task_data.get("category") or "other",
        "client_id": task_data.get("client_id") or None,
        "due_date": due_date,
        "is_recurring": task_data.get("is_recurring", False),
        "recurrence_pattern": task_data.get("recurrence_pattern")
        if task_data.get("is_recurring")
        else None,
        "recurrence_interval": task_data.get("recurrence_interval")
        if task_data.get("is_recurring")
        else None,
        "type": "task",
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    async with await client.start_session() as session:

        async def cb(session):
            await db.tasks.insert_one(new_task, session=session)
            await db.todos.delete_one({"_id": ObjectId(todo_id)}, session=session)

        await session.with_transaction(cb)
    return {"message": "Todo promoted to task successfully"}


@api_router.delete("/todos/{todo_id}")
async def delete_todo(todo_id: str, current_user: User = Depends(get_current_user)):
    try:
        obj_id = ObjectId(todo_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    todo = await db.todos.find_one({"_id": obj_id})
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    await db.todos.delete_one({"_id": obj_id})
    return {"message": "Todo deleted successfully"}


@api_router.patch("/todos/{todo_id}")
async def update_todo(
    todo_id: str, updates: dict, current_user: User = Depends(get_current_user)
):
    try:
        todo = await db.todos.find_one({"_id": ObjectId(todo_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    now = datetime.now(IST)
    if updates.get("is_completed") is True:
        updates["completed_at"] = now
    updates["updated_at"] = now
    await db.todos.update_one({"_id": ObjectId(todo_id)}, {"$set": updates})
    return {"message": "Todo updated successfully"}



def _make_user_id_query(user_id: str, email: Optional[str] = None) -> dict[str, Any]:
    """Build a MongoDB query that matches a user document by either string id or ObjectId _id, or email."""
    from bson import ObjectId
    user_id_str = str(user_id or "").strip()
    clauses = []
    if email:
        clauses.append({"email": str(email).strip().lower()})
    if user_id_str:
        if ObjectId.is_valid(user_id_str):
            clauses.append({"_id": ObjectId(user_id_str)})
        clauses.append({"id": user_id_str})
    if not clauses:
        return {"id": user_id_str}
    return {"$or": clauses} if len(clauses) > 1 else clauses[0]


@api_router.post("/users/{user_id}/approve")
async def approve_user(user_id: str, current_user: User = Depends(get_current_user)):
    # Client / user approval is admin-only â permission governance cannot delegate this.
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Only administrators can approve users"
        )

    existing = await db.users.find_one(_make_user_id_query(user_id))

    if not existing:
        raise HTTPException(status_code=404, detail="User not found")

    if existing.get("status") != "pending_approval":
        raise HTTPException(
            status_code=400,
            detail=f"User status is {existing.get('status')}, not pending approval",
        )

    update_data = {
        "status": "active",
        "is_active": True,
        "approved_by": current_user.id,
        "approved_at": datetime.now(timezone.utc).isoformat(),
    }

    if existing.get("_id"):
        await db.users.update_one({"_id": existing["_id"]}, {"$set": update_data})
    else:
        await db.users.update_one({"id": user_id}, {"$set": update_data})

    await create_audit_log(
        current_user, "APPROVE_USER", "user", user_id, existing, update_data
    )

    try:
        from backend.email_service.service import email_service
        if existing.get("email"):
            await email_service.send_template_email(
                to_email=existing["email"],
                template_code="AUTH_WELCOME",
                context={
                    "user_name": existing.get("full_name") or "Valued User",
                    "email": existing["email"],
                    "login_url": "https://taskosphere.com/login",
                },
                related_user_id=user_id,
            )
    except Exception as em_err:
        logger.warning(f"Could not dispatch welcome email on approval: {em_err}")

    return {"message": "User approved successfully"}


@api_router.post("/users/{user_id}/reject")
async def reject_user(user_id: str, current_user: User = Depends(get_current_user)):
    # User rejection is admin-only â matches approval which is also admin-only.
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Only administrators can reject users"
        )

    existing = await db.users.find_one(_make_user_id_query(user_id))

    if not existing:
        raise HTTPException(status_code=404, detail="User not found")

    update_data = {"status": "rejected", "is_active": False}

    if existing.get("_id"):
        await db.users.update_one({"_id": existing["_id"]}, {"$set": update_data})
    else:
        await db.users.update_one({"id": user_id}, {"$set": update_data})

    await create_audit_log(
        current_user, "REJECT_USER", "user", user_id, existing, update_data
    )

    return {"message": "User rejected"}


# ============================================================
# USER MANAGEMENT
# =============================================================
async def _scope_users_query_by_company(current_user: User, base_query: Optional[dict] = None) -> dict:
    """Return the authoritative visibility scope for the operational Users surface.

    There are exactly three identity classes:
      1. Platform Owner â sees Platform Owner/internal operational users only.
      2. Commercial Licensee â sees users belonging to that commercial customer only.
      3. Legacy/internal tenant â sees users in its authenticated company only.

    The Commercial Console is deliberately separate and uses its own control-plane
    endpoints; it is the only place where cross-customer license records are
    intentionally visible.
    """
    from backend.platform_owner import is_platform_owner, platform_owner_emails

    base = dict(base_query or {})
    owner_emails = sorted(platform_owner_emails())

    if is_platform_owner(current_user):
        raw_lic_comps = await db.companies.find(
            {'': [
                {'source': {'': ['commercial-license', 'commercial', 'license']}},
                {'commercial_customer_id': {'': [None, '', 'platform-owner']}},
                {'license_id': {'': [None, '', 'platform-owner-license']}}
            ]},
            {'_id': 0, 'id': 1}
        ).to_list(5000)
        licensee_comp_ids = [str(c['id']) for c in raw_lic_comps if c.get('id')]
        platform_scope = {
            'commercial_customer_id': {'': [None, '', 'platform-owner']},
            'license_id': {'': [None, '', 'platform-owner-license']},
        }
        if licensee_comp_ids:
            platform_scope['company_id'] = {'': licensee_comp_ids}
        return {'': [base, platform_scope]} if base else platform_scope

    customer_id = str(getattr(current_user, "commercial_customer_id", "") or "").strip()
    license_id = str(getattr(current_user, "license_id", "") or "").strip()
    company_id = str(getattr(current_user, "company_id", "") or "").strip()

    # A real commercial identity must carry a customer id. license_id/company_id
    # are compatibility fallbacks for older records, but platform-owner markers
    # are always excluded.
    is_licensee = bool(
        customer_id and customer_id != "platform-owner"
    ) or bool(
        license_id and license_id != "platform-owner-license"
    )

    if is_licensee:
        scope_clauses = []
        if customer_id and customer_id != "platform-owner":
            scope_clauses.append({"commercial_customer_id": customer_id})
        if license_id and license_id != "platform-owner-license":
            scope_clauses.append({"license_id": license_id})
        if company_id:
            # Legacy fallback is allowed only for records that have not yet
            # been stamped with another commercial customer/license.
            scope_clauses.append({
                "$and": [
                    {"commercial_customer_id": {"$in": [None, ""]}},
                    {"license_id": {"$in": [None, ""]}},
                    {"company_id": company_id},
                ]
            })

        licensee_scope = {
            "$and": [
                {"$or": scope_clauses},
                {"email": {"$nin": owner_emails}},
                {"commercial_customer_id": {"$nin": ["platform-owner"]}},
                {"license_id": {"$nin": ["platform-owner-license"]}},
            ]
        }
        return {"$and": [base, licensee_scope]} if base else licensee_scope

    if not company_id:
        raise HTTPException(
            status_code=403,
            detail="Authenticated user is not associated with a tenant.",
        )

    internal_scope = {
        "company_id": company_id,
        "email": {"$nin": owner_emails},
        "commercial_customer_id": {"$in": [None, "", "platform-owner"]},
        "license_id": {"$in": [None, "", "platform-owner-license"]},
    }
    return {"$and": [base, internal_scope]} if base else internal_scope


@api_router.get("/users")
async def get_users(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    if current_user.role == "admin":
        base_q = _make_user_id_query(user_id) if user_id else {}
        query = await _scope_users_query_by_company(current_user, base_q)
        users_raw = await db.users.find(query, {"password": 0}).to_list(1000)
    elif current_user.role == "manager":
        if user_id:
            scoped_lookup = await _scope_users_query_by_company(current_user, _make_user_id_query(user_id))
            target_user = await db.users.find_one(
                scoped_lookup, {"password": 0}
            )
            if not target_user:
                raise HTTPException(status_code=404, detail="User not found")
            target_depts = target_user.get("departments", [])
            manager_depts = current_user.departments
            if not any(d in manager_depts for d in target_depts):
                raise HTTPException(
                    status_code=403, detail="User not in your departments"
                )
            users_raw = [target_user]
        else:
            # Manager: self + everyone in their cross-visibility union.
            # "Team" is now purely explicit (admin-curated view_other_* lists).
            cross_ids = await get_cross_visibility_union(current_user.id)
            visible_ids = list(set(cross_ids + [current_user.id]))
            base_q = {"$or": [{"id": {"$in": visible_ids}}, {"_id": {"$in": [ObjectId(x) for x in visible_ids if ObjectId.is_valid(x)]}}]} if any(ObjectId.is_valid(x) for x in visible_ids) else {"id": {"$in": visible_ids}}
            query = await _scope_users_query_by_company(current_user, base_q)
            users_raw = await db.users.find(query, {"password": 0}).to_list(
                1000
            )
    else:
        # Staff scope: own data always; with can_view_user_page can view the full directory.
        # Without can_view_user_page, staff still see self + their cross-visibility union.
        permissions = get_user_permissions(current_user)
        can_view_dir = permissions.get("can_view_user_page", False)

        if user_id:
            # Specific user lookup â own record always allowed
            if user_id == current_user.id:
                users_raw = await db.users.find(
                    _make_user_id_query(user_id), {"password": 0}
                ).to_list(1000)
            elif can_view_dir:
                query = await _scope_users_query_by_company(current_user, _make_user_id_query(user_id))
                users_raw = await db.users.find(
                    query, {"password": 0}
                ).to_list(1000)
            else:
                # Allow lookup if target is in any of this staff's cross-vis lists
                cross_ids = await get_cross_visibility_union(current_user.id)
                if user_id not in cross_ids:
                    raise HTTPException(status_code=403, detail="Not allowed")
                query = await _scope_users_query_by_company(current_user, _make_user_id_query(user_id))
                users_raw = await db.users.find(
                    query, {"password": 0}
                ).to_list(1000)
        elif can_view_dir:
            # Staff with can_view_user_page: return full directory (active users only, no passwords)
            # This is needed for task assignment dropdowns, cross-visibility, etc.
            query = await _scope_users_query_by_company(current_user, {"is_active": True})
            users_raw = await db.users.find(
                query,
                {
                    "password": 0,
                    "permissions": 0,
                },  # strip permissions for privacy
            ).to_list(1000)
        else:
            # No directory access â return self + cross-visibility union
            cross_ids = await get_cross_visibility_union(current_user.id)
            visible_ids = list(set(cross_ids + [current_user.id]))
            base_q = {"$or": [{"id": {"$in": visible_ids}}, {"_id": {"$in": [ObjectId(x) for x in visible_ids if ObjectId.is_valid(x)]}}]} if any(ObjectId.is_valid(x) for x in visible_ids) else {"id": {"$in": visible_ids}}
            query = await _scope_users_query_by_company(current_user, base_q)
            users_raw = await db.users.find(
                query, {"password": 0}
            ).to_list(1000)
    for u in users_raw:
        if not u.get("id") and u.get("_id"):
            u["id"] = str(u["_id"])
        u.pop("_id", None)
        if u.get("created_at") and isinstance(u["created_at"], str):
            try:
                u["created_at"] = datetime.fromisoformat(u["created_at"])
            except Exception:
                u["created_at"] = datetime.now(timezone.utc)
        else:
            u["created_at"] = datetime.now(timezone.utc)
        # Salary is sensitive â only admins, or a user looking at their own
        # record, may see it. Strip it from every other view (manager team
        # lists, staff directory, cross-visibility lookups, etc).
        if current_user.role != "admin" and u.get("id") != current_user.id:
            u.pop("monthly_salary", None)
    return convert_objectids(users_raw)


@api_router.put("/users/{user_id}", response_model=User)
async def update_user(
    user_id: str,
    user_data: dict,
    current_user: User = Depends(check_module_permission("users", "edit")),
):
    is_own = user_id == current_user.id
    is_admin = current_user.role.lower() == "admin"
    is_manager = current_user.role.lower() == "manager"
    perms = get_user_permissions(current_user)
    has_edit_users = perms.get("can_edit_users", False)

    # Manager scope check: manager with can_edit_users can edit their team staff only
    if not is_admin and not is_own and has_edit_users and is_manager:
        team_ids = await get_team_user_ids(current_user.id)
        if user_id not in team_ids:
            raise HTTPException(status_code=403, detail="User is not in your team")
        target_user = await db.users.find_one(_make_user_id_query(user_id), {"password": 0})
        if target_user and target_user.get("role") in ("admin", "manager"):
            raise HTTPException(
                status_code=403, detail="Managers can only edit staff members"
            )
    elif not is_admin and not is_own and not has_edit_users:
        raise HTTPException(
            status_code=403, detail="You can only update your own profile."
        )

    lookup_email = current_user.email if is_own else None
    existing = await db.users.find_one(_make_user_id_query(user_id, lookup_email))
    if not existing:
        raise HTTPException(status_code=404, detail="User not found.")

    target_oid = existing.get("_id")
    target_id = str(existing.get("id") or target_oid or user_id)

    if is_admin:
        # Admin can update all fields including role, permissions, status
        allowed_fields = [
            "full_name",
            "email",
            "role",
            "departments",
            "phone",
            "birthday",
            "punch_in_time",
            "grace_time",
            "punch_out_time",
            "is_active",
            "profile_picture",
            "telegram_id",
            "status",
            "permissions",
            "joining_date",
            "training_period_end",
            "payroll_date",
            "monthly_salary",
        ]
    elif is_manager and has_edit_users and not is_own:
        # Manager editing a team staff member â can update profile + work settings, not role/permissions
        allowed_fields = [
            "full_name",
            "email",
            "departments",
            "phone",
            "birthday",
            "punch_in_time",
            "grace_time",
            "punch_out_time",
            "is_active",
            "profile_picture",
            "telegram_id",
            "status",
            "joining_date",
            "training_period_end",
            "payroll_date",
        ]
    else:
        # Self-edit: own profile fields only
        allowed_fields = [
            "full_name",
            "phone",
            "birthday",
            "punch_in_time",
            "punch_out_time",
            "profile_picture",
            "telegram_id",
        ]

    update_payload = {}
    for key in allowed_fields:
        if key in user_data:
            val = user_data[key]
            update_payload[key] = val if val != "" else None
    if "monthly_salary" in update_payload and update_payload["monthly_salary"] is not None:
        try:
            update_payload["monthly_salary"] = float(update_payload["monthly_salary"])
        except (TypeError, ValueError):
            update_payload["monthly_salary"] = None
    new_password = user_data.get("password")
    if new_password and len(new_password.strip()) > 0:
        update_payload["password"] = get_password_hash(new_password)

    # Always ensure canonical id field is stored on the document
    if target_id:
        update_payload["id"] = target_id

    if update_payload:
        if target_oid:
            await db.users.update_one({"_id": target_oid}, {"$set": update_payload})
        else:
            await db.users.update_one({"id": user_id}, {"$set": update_payload})

    # Clean up any phantom commercial control plane records that shadowed this user ID
    if is_own and is_admin:
        try:
            from backend import dependencies as _dependencies
            raw_db = getattr(_dependencies, "_raw_db", db)
            await raw_db.users.delete_many({
                "company_id": "__commercial_control_plane__",
                "is_internal_commercial_admin": True,
                "$or": [
                    {"id": str(target_id)},
                    {"id": str(user_id)},
                    {"email": f"commercial-control+{user_id}@taskosphere.internal"},
                ],
            })
        except Exception as _clean_err:
            logger.warning(f"Phantom user cleanup skipped: {_clean_err}")

    await create_audit_log(
        current_user, "UPDATE_USER", "user", user_id, existing, update_payload
    )

    if target_oid:
        updated_user = await db.users.find_one(
            {"_id": target_oid}, {"password": 0, "password_hash": 0, "password_salt": 0}
        )
    else:
        updated_user = await db.users.find_one(
            {"id": user_id}, {"password": 0, "password_hash": 0, "password_salt": 0}
        )

    if updated_user:
        updated_user["id"] = str(updated_user.get("id") or updated_user.get("_id"))
        updated_user.pop("_id", None)
    return updated_user


@api_router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    current_user: User = Depends(check_module_permission("users", "delete")),
):
    # Issue #8: fully permission-based (can_manage_users flag), admin always passes via check_module_permission
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    existing = await db.users.find_one(_make_user_id_query(user_id))
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    await create_audit_log(
        current_user, "DELETE_USER", "user", record_id=user_id, old_data=existing
    )
    if existing.get("_id"):
        await db.users.delete_one({"_id": existing["_id"]})
    await db.users.delete_one({"id": user_id})
    return {"message": "User deleted successfully"}


# ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# EMPLOYEE OFFBOARDING / REPLACEMENT
# ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ


@api_router.get("/users/{user_id}/offboard-preview")
async def offboard_preview(
    user_id: str,
    current_user: User = Depends(require_admin()),
):
    """Preview what data belongs to this user before offboarding."""
    user = await db.users.find_one(_make_user_id_query(user_id), {"password": 0, "password_hash": 0, "password_salt": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    canonical_id = str(user.get("id") or user.get("_id") or user_id)

    counts = {
        "tasks_assigned": await db.tasks.count_documents({"assigned_to": {"$in": [canonical_id, user_id]}}),
        "tasks_created": await db.tasks.count_documents({"created_by": {"$in": [canonical_id, user_id]}}),
        "clients": await db.clients.count_documents({"assigned_to": {"$in": [canonical_id, user_id]}}),
        "dsc": await db.dsc_register.count_documents({"assigned_to": {"$in": [canonical_id, user_id]}}),
        "documents": await db.documents.count_documents(
            {"$or": [{"assigned_to": {"$in": [canonical_id, user_id]}}, {"created_by": {"$in": [canonical_id, user_id]}}]}
        ),
        "todos": await db.todos.count_documents({"user_id": {"$in": [canonical_id, user_id]}}),
        "visits": await db.visits.count_documents({"assigned_to": {"$in": [canonical_id, user_id]}}),
        "leads": await db.leads.count_documents({"assigned_to": {"$in": [canonical_id, user_id]}}),
    }

    return {
        "user": {
            "id": canonical_id,
            "full_name": user.get("full_name"),
            "email": user.get("email"),
            "role": user.get("role"),
            "departments": user.get("departments", []),
        },
        "data_counts": counts,
        "total_items": sum(counts.values()),
    }


@api_router.post("/users/{user_id}/offboard")
async def offboard_user(
    user_id: str,
    body: OffboardRequest,
    current_user: User = Depends(require_admin()),
):
    """
    Offboard an employee: transfer all their data to a replacement user,
    keep an audit trail, then optionally delete the old account.
    """
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot offboard yourself")
    if user_id == body.replacement_user_id:
        raise HTTPException(
            status_code=400, detail="Old and replacement user cannot be the same"
        )

    old_user = await db.users.find_one(_make_user_id_query(user_id))
    if not old_user:
        raise HTTPException(status_code=404, detail="User to offboard not found")

    new_user = await db.users.find_one(_make_user_id_query(body.replacement_user_id))
    if not new_user:
        raise HTTPException(status_code=404, detail="Replacement user not found")

    transfer_summary = {}

    # 1. Tasks
    if body.transfer_tasks:
        r1 = await db.tasks.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        r2 = await db.tasks.update_many(
            {"created_by": user_id}, {"$set": {"created_by": body.replacement_user_id}}
        )
        transfer_summary["tasks_assigned"] = r1.modified_count
        transfer_summary["tasks_created"] = r2.modified_count

    # 2. Clients
    if body.transfer_clients:
        r = await db.clients.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["clients_reassigned"] = r.modified_count

    # 3. DSC
    if body.transfer_dsc:
        r = await db.dsc_register.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["dsc_transferred"] = r.modified_count

    # 4. Documents
    if body.transfer_documents:
        r = await db.documents.update_many(
            {"$or": [{"assigned_to": user_id}, {"created_by": user_id}]},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["documents_transferred"] = r.modified_count

    # 5. Todos
    if body.transfer_todos:
        r = await db.todos.update_many(
            {"user_id": user_id}, {"$set": {"user_id": body.replacement_user_id}}
        )
        transfer_summary["todos_transferred"] = r.modified_count

    # 6. Visits
    if body.transfer_visits:
        r = await db.visits.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["visits_transferred"] = r.modified_count

    # 7. Leads
    if body.transfer_leads:
        r = await db.leads.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["leads_transferred"] = r.modified_count

    # 8. Update cross-user permission references in all other users
    for field in [
        "permissions.view_other_tasks",
        "permissions.view_other_attendance",
        "permissions.view_other_reports",
        "permissions.view_other_todos",
        "permissions.view_other_activity",
        "permissions.view_other_visits",
        "permissions.assigned_clients",
    ]:
        await db.users.update_many(
            {field: user_id},
            {"$set": {f"{field}.$[elem]": body.replacement_user_id}},
            array_filters=[{"elem": user_id}],
        )
    transfer_summary["permission_references_updated"] = True

    # 9. Optionally update the replacement user's email
    if body.update_email and body.update_email.strip():
        new_email = body.update_email.strip().lower()
        email_exists = await db.users.find_one(
            {"email": new_email, "id": {"$ne": body.replacement_user_id}},
            {"_id": 0, "id": 1},
        )
        if email_exists:
            raise HTTPException(
                status_code=400, detail=f"Email {new_email} is already in use"
            )
        await db.users.update_one(
            {"id": body.replacement_user_id}, {"$set": {"email": new_email}}
        )
        transfer_summary["email_updated"] = new_email

    # 10. Audit Log
    await create_audit_log(
        current_user,
        "OFFBOARD_USER",
        "user",
        record_id=user_id,
        old_data={
            "offboarded_user": {
                "id": old_user.get("id"),
                "full_name": old_user.get("full_name"),
                "email": old_user.get("email"),
                "role": old_user.get("role"),
                "departments": old_user.get("departments", []),
            },
            "replacement_user": {
                "id": new_user.get("id"),
                "full_name": new_user.get("full_name"),
                "email": new_user.get("email"),
            },
            "transfer_summary": transfer_summary,
            "notes": body.notes,
        },
    )

    # 11. Delete or deactivate old user
    if body.delete_old_user:
        await db.users.delete_one({"id": user_id})
        transfer_summary["old_user_deleted"] = True
    else:
        await db.users.update_one(
            {"id": user_id}, {"$set": {"is_active": False, "status": "inactive"}}
        )
        transfer_summary["old_user_deactivated"] = True

    return {
        "message": f"Successfully offboarded {old_user.get('full_name')} â {new_user.get('full_name')}",
        "transfer_summary": transfer_summary,
    }



# ====================================================================================
# ATTENDANCE ROUTES'''
