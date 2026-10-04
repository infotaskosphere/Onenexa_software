import os
import logging
import secrets as _secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId
from backend.models import User, AuditLog
from backend.tenant_runtime import set_authenticated_company, set_platform_owner, TenantAwareDatabase
from backend.platform_owner import is_platform_owner
logger=logging.getLogger("dependencies")
def personal_birthday_candidates(client):
    candidates=[]
    if (client.get("client_type") or "").strip().lower()=="proprietor" and client.get("birthday"):candidates.append({"name":client.get("company_name") or "Valued Client","phone":client.get("phone"),"email":client.get("email"),"birthday":client["birthday"]})
    for cp in client.get("contact_persons") or []:
        if cp.get("birthday"):candidates.append({"name":cp.get("name") or client.get("company_name") or "Friend","phone":cp.get("phone"),"email":cp.get("email"),"birthday":cp["birthday"]})
    return candidates
MONGO_URL=os.getenv("MONGO_URL") or os.getenv("MONGODB_URI")
DB_NAME=os.getenv("DB_NAME") or os.getenv("MONGODB_DB_NAME","taskosphere_commercial")
import uuid
class MockCursor:
    def __init__(self,data):self._data,self._index=data,0
    def limit(self,n):self._data=self._data[:n];return self
    def sort(self,*a,**k):return self
    def skip(self,n):self._data=self._data[n:];return self
    async def to_list(self,length=None):return self._data[:length] if length is not None else self._data
    def __aiter__(self):self._index=0;return self
    async def __anext__(self):
        if self._index>=len(self._data):raise StopAsyncIteration
        v=self._data[self._index];self._index+=1;return v
class MockCollection:
    def __init__(self,name):self.name=name;self._store={}
    async def find_one(self,q=None,*a,**k):
        for d in self._store.values():
            if self._matches(d,q or {}):return d.copy()
        return None
    def find(self,q=None,*a,**k):return MockCursor([d.copy() for d in self._store.values() if self._matches(d,q or {})])
    async def insert_one(self,d):
        d=d.copy();d.setdefault("_id",str(uuid.uuid4()));self._store[str(d["_id"])]=d
        class R:pass
        r=R();r.inserted_id=d["_id"];return r
    async def insert_many(self,docs):
        ids=[]
        for d in docs:
            d=d.copy();d.setdefault("_id",str(uuid.uuid4()));self._store[str(d["_id"])]=d;ids.append(d["_id"])
        class R:pass
        r=R();r.inserted_ids=ids;return r
    async def update_one(self,q,u,upsert=False,*a,**k):
        d=await self.find_one(q)
        if not d:
            if upsert:
                nd=q.copy();nd.update(u.get("$set",{}));await self.insert_one(nd)
                class R:pass
                r=R();r.matched_count=0;r.modified_count=1;r.upserted_id=nd["_id"];return r
            class R:pass
            r=R();r.matched_count=0;r.modified_count=0;r.upserted_id=None;return r
        for op,vals in u.items():
            if op=="$set":d.update(vals)
            elif op=="$unset":
                for key in vals:d.pop(key,None)
            elif op=="$push":
                for key,val in vals.items():d.setdefault(key,[]).append(val)
        self._store[str(d["_id"])]=d
        class R:pass
        r=R();r.matched_count=1;r.modified_count=1;r.upserted_id=None;return r
    async def delete_one(self,q,*a,**k):
        d=await self.find_one(q)
        if d:self._store.pop(str(d["_id"]),None)
        class R:pass
        r=R();r.deleted_count=1 if d else 0;return r
    async def delete_many(self,q,*a,**k):
        keys=[key for key,d in self._store.items() if self._matches(d,q)]
        for key in keys:self._store.pop(key,None)
        class R:pass
        r=R();r.deleted_count=len(keys);return r
    async def count_documents(self,q,*a,**k):return sum(1 for d in self._store.values() if self._matches(d,q))
    def _matches(self,d,q):
        for key,val in q.items():
            if key=="$or":
                if not any(self._matches(d,x) for x in val):return False
                continue
            if key=="$and":
                if not all(self._matches(d,x) for x in val):return False
                continue
            actual=d.get(key)
            if isinstance(val,dict):
                for op,target in val.items():
                    if op=="$in" and actual not in target:return False
                    if op=="$nin" and actual in target:return False
                    if op=="$ne" and actual==target:return False
                    if op=="$gt" and(actual is None or actual<=target):return False
                    if op=="$gte" and(actual is None or actual<target):return False
                    if op=="$lt" and(actual is None or actual>=target):return False
                    if op=="$lte" and(actual is None or actual>target):return False
            elif str(actual)!=str(val):return False
        return True
class MockDatabase:
    def __init__(self):self._collections={}
    def __getitem__(self,name):self._collections.setdefault(name,MockCollection(name));return self._collections[name]
    def __getattr__(self,name):return self[name]
class MockMongoClient:
    def __init__(self,*a,**k):self._db=MockDatabase()
    def __getitem__(self,name):return self._db
    def __getattr__(self,name):return self._db
if not MONGO_URL:
    print("[AI Studio] MONGO_URL/MONGODB_URI not provided. Using fallback in-memory MongoDB client.");client=MockMongoClient();db=client[DB_NAME]
else:
    try:client=AsyncIOMotorClient(MONGO_URL);db=client[DB_NAME]
    except Exception as e:print(f"[AI Studio] Failed to connect to MongoDB, falling back to mock: {e}");client=MockMongoClient();db=client[DB_NAME]
def _resolve_jwt_secret():
    secret=os.getenv("JWT_SECRET")
    if secret and secret.strip():return secret.strip()
    if os.getenv("ENV_MODE")=="production":raise RuntimeError("JWT_SECRET environment variable is not set. Refusing to start in production without an explicit secret.")
    generated=_secrets.token_hex(32);logger.warning("JWT_SECRET is not set. Generated a development-only secret.");return generated
JWT_SECRET=_resolve_jwt_secret();ALGORITHM="HS256";ACCESS_TOKEN_EXPIRE_MINUTES=60*24*7;security=HTTPBearer()
def create_access_token(data):
    payload=data.copy();payload["exp"]=datetime.now(timezone.utc)+timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES);return jwt.encode(payload,JWT_SECRET,algorithm=ALGORITHM)
def safe_dt(value):
    if not value:return None
    if isinstance(value,datetime):return value
    try:return datetime.fromisoformat(str(value).replace("Z","+00:00"))
    except Exception:return None
def _get_perm(user,key,default=False):
    perms=getattr(user,"permissions",None)
    if perms is None:return default
    if hasattr(perms,"model_dump"):return getattr(perms,key,default)
    if isinstance(perms,dict):return perms.get(key,default)
    return default
def _normalize_permissions(d):
    from backend.models import DEFAULT_ROLE_PERMISSIONS
    role=d.get("role","staff")
    template=DEFAULT_ROLE_PERMISSIONS.get(role,{})
    perms=d.get("permissions",{})
    if hasattr(perms,"model_dump"):perms=perms.model_dump()
    elif not isinstance(perms,dict):perms={}

    # Commercial tenant Manager/Staff permissions are explicit Permission Matrix
    # state. Do NOT back-fill commercial module/page flags from the generic role
    # template: doing so turns a licensed module into an implicit user grant and
    # is exactly what caused /chart-of-accounts to be requested for users whose
    # Finix permissions had been cleared by the licensee admin.
    commercial_user = bool(
        d.get("company_id")
        or d.get("license_id")
        or d.get("commercial_customer_id")
        or d.get("licensed_modules")
        or d.get("selected_features")
    )
    normalized={**template,**perms}
    if commercial_user and str(role).lower() in ("manager","staff"):
        try:
            from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY
            governed_flags=set()
            for module in MODULE_HIERARCHY.values():
                module_flag=module.get("flag")
                if module_flag:
                    governed_flags.add(module_flag)
                for page in module.get("pages",[]) or []:
                    if page.get("flag"):
                        governed_flags.add(page["flag"])
            for flag in governed_flags:
                normalized[flag]=bool(perms.get(flag,False))

            # Normalize legacy standalone Finix flags too. They are represented
            # as pages in the current hierarchy, but keeping these explicit
            # prevents old records/templates from recreating them.
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
        # A persisted session must remain bound to the same tenant as the user.
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
            except Exception: pass
        if not subscription or subscription.get("status") not in ("trial", "active"):
            return None
        expires_at=subscription.get("expires_at")
        if expires_at:
            if expires_at.tzinfo is None: expires_at=expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= datetime.now(timezone.utc): return None
        await _touch_saas_session_if_due(raw_db, session)
        user_data={k:v for k,v in user.items() if k != "_id"}
        user_data["id"]=str(user.get("_id") or user.get("id"))
        user_data["company_id"]=str(company_id)
        user_data["company_name"]=company.get("name")
        user_data=_normalize_permissions(user_data)
        return User(**user_data)
    except Exception as error:
        logger.exception("SaaS session resolution failed: %s", error)
        return None

async def _resolve_licensed_company_id(user):
    """Resolve a missing operational company for a legacy licensed account.

    Commercial licensees can own company/user master records through
    commercial_customer_id or license_id even when an older user record has
    no company_id. Only a positively linked, unique company is accepted; this
    never guesses across tenants.
    """
    customer_id=str(getattr(user,"commercial_customer_id","") or "").strip()
    license_id=str(getattr(user,"license_id","") or "").strip()
    if not customer_id and not license_id:
        return None
    raw_db=globals().get("_raw_db",db)
    clauses=[]
    if license_id: clauses.append({"license_id":license_id})
    if customer_id: clauses.append({"commercial_customer_id":customer_id})
    if not clauses:return None
    rows=await raw_db.companies.find({"$or":clauses}).limit(2).to_list(2)
    if len(rows)!=1:return None
    company=rows[0]
    company_id=str(company.get("id") or company.get("_id") or "").strip()
    return company_id or None

async def get_current_user(credentials=Depends(security)):
    unauthorized=HTTPException(status_code=401,detail="Could not validate credentials",headers={"WWW-Authenticate":"Bearer"})
    token=credentials.credentials
    saas_user=await _get_saas_session_user(token)
    if saas_user is not None:
        set_authenticated_company(saas_user.company_id)
        set_platform_owner(is_platform_owner(saas_user))
        return saas_user
    try:
        payload=jwt.decode(token,JWT_SECRET,algorithms=[ALGORITHM]);user_id=payload.get("sub")
        if user_id is None:raise unauthorized
    except JWTError:raise unauthorized
    user_query = {"id": user_id}
    if ObjectId.is_valid(user_id):
        user_query = {"$or": [{"id": user_id}, {"_id": ObjectId(user_id)}]}
    d=await db.users.find_one(user_query)
    if d is None:raise HTTPException(status_code=401,detail="User not found")
    if "pwd_ver" in payload and d.get("password_version"):
        try:
            if int(payload["pwd_ver"]) != int(d.get("password_version")):
                raise HTTPException(status_code=401, detail="Session expired due to password change. Please sign in again.")
        except HTTPException:
            raise
        except Exception:
            pass
    if "id" not in d or not d.get("id"):
        d["id"] = str(d.get("_id") or user_id)
    d.pop("_id",None)
    for key,value in list(d.items()):
        if value=="":d[key]=None
    d=_normalize_permissions(d)
    try:user=User(**d)
    except Exception as e:logger.error("User validation failed for %s: %s",user_id,e);raise HTTPException(status_code=500,detail="User profile data is corrupted")
    company_id=getattr(user,"company_id",None)
    if not company_id or not str(company_id).strip():
        if is_platform_owner(user):
            raw_db = globals().get("_raw_db", db)
            owner_comp = await raw_db.companies.find_one({"is_platform_owner_workspace": True, "status": "active"})
            owner_comp_id = str((owner_comp or {}).get("id") or "comp-platform-owner")
            user_data = user.model_dump()
            user_data["company_id"] = owner_comp_id
            user = User.model_validate(user_data)
            set_authenticated_company(owner_comp_id)
            set_platform_owner(True)
            return user
        company_id=await _resolve_licensed_company_id(user)
        if company_id:
            user_data=user.model_dump()
            user_data["company_id"]=company_id
            user=User.model_validate(user_data)
        else:
            raise HTTPException(status_code=403,detail="Authenticated user is not associated with a company")
    set_authenticated_company(company_id)
    set_platform_owner(is_platform_owner(user))
    if not is_platform_owner(user) and company_id:
        try:
            cust_id = getattr(user, "commercial_customer_id", None) or company_id
            lic = await db.commercial_licenses.find_one(
                {"$or": [{"customer_id": cust_id}, {"company_id": company_id}, {"id": str(getattr(user, "license_id", "") or "")}], "status": {"$in": ["active", "trial"]}},
                {"_id": 0},
                sort=[("issued_at", -1)],
            )
            if not lic:
                lic = await db.commercial_licenses.find_one(
                    {"$or": [{"customer_id": cust_id}, {"company_id": company_id}, {"id": str(getattr(user, "license_id", "") or "")}]},
                    {"_id": 0},
                    sort=[("issued_at", -1)],
                )
            if lic:
                u_data = user.model_dump()
                u_data["licensed_modules"] = list(lic.get("modules") or lic.get("licensed_modules") or [])
                u_data["selected_features"] = lic.get("selected_features") or {}
                u_data["license_id"] = lic.get("id")
                u_data["commercial_customer_id"] = lic.get("customer_id") or cust_id
                user = User.model_validate(u_data)
        except Exception as e:
            logger.warning(f"Could not hydrate license modules in get_current_user: {e}")
    return user

def check_permission(required_permission):
    async def checker(current_user=Depends(get_current_user)):
        if current_user.role=="admin" or _get_perm(current_user,required_permission,False):return current_user
        raise HTTPException(status_code=403,detail=f"Required permission: {required_permission}")
    return checker
def require_admin():
    async def checker(current_user=Depends(get_current_user)):
        if current_user.role!="admin":raise HTTPException(status_code=403,detail="Admin access required")
        return current_user
    return checker
def require_manager_or_admin():
    async def checker(current_user=Depends(get_current_user)):
        if current_user.role not in ["admin","manager"]:raise HTTPException(status_code=403,detail="Manager or Admin access required")
        return current_user
    return checker
def can_view_task(u,t):return u.role=="admin" or _get_perm(u,"can_view_all_tasks") or t.get("assigned_to") in(_get_perm(u,"view_other_tasks",[]) or []) or t.get("assigned_to")==u.id or t.get("created_by")==u.id or u.id in t.get("sub_assignees",[])
def can_edit_task(u,t):return u.role=="admin" or _get_perm(u,"can_edit_tasks") or t.get("created_by")==u.id or t.get("assigned_to")==u.id or u.id in t.get("sub_assignees",[])
def can_delete_task(u,t):return u.role=="admin" or _get_perm(u,"can_delete_tasks") or t.get("created_by")==u.id
def can_view_todo(u,t):return u.role=="admin" or t.get("user_id") in(_get_perm(u,"view_other_todos",[]) or []) or t.get("user_id")==u.id
def can_edit_todo(u,t):return u.role=="admin" or t.get("user_id")==u.id
def can_view_client(u,c):return u.role=="admin" or _get_perm(u,"can_view_all_clients") or c.get("id") in(_get_perm(u,"assigned_clients",[]) or []) or c.get("assigned_to")==u.id
def can_edit_client(u,c):return u.role=="admin" or _get_perm(u,"can_edit_clients") or c.get("id") in(_get_perm(u,"assigned_clients",[]) or []) or c.get("assigned_to")==u.id
def can_delete_client(u):return u.role=="admin" or _get_perm(u,"can_edit_clients")
def can_view_report(u,target):return u.role=="admin" or _get_perm(u,"can_view_reports") or target in(_get_perm(u,"view_other_reports",[]) or []) or target==u.id
def can_download_report(u):return u.role=="admin" or _get_perm(u,"can_download_reports")
def can_view_attendance(u,target):return u.role=="admin" or _get_perm(u,"can_view_attendance") or target in(_get_perm(u,"view_other_attendance",[]) or []) or target==u.id
def can_view_activity(u,target):return u.role=="admin" or _get_perm(u,"can_view_staff_activity") or target in(_get_perm(u,"view_other_activity",[]) or [])
def can_view_lead(u,l):return u.role=="admin" or _get_perm(u,"can_view_all_leads") or l.get("assigned_to")==u.id or l.get("created_by")==u.id
def can_edit_lead(u,l):return u.role=="admin" or l.get("assigned_to")==u.id or l.get("created_by")==u.id
def can_delete_lead(u):return u.role=="admin" or _get_perm(u,"can_manage_users")
def can_manage_user(u):return u.role=="admin" or _get_perm(u,"can_manage_users")
def build_task_query(u,department_user_ids=None):
    if u.role=="admin" or _get_perm(u,"can_view_all_tasks"):return {}
    ors=[{"assigned_to":u.id},{"created_by":u.id},{"sub_assignees":u.id}];view=_get_perm(u,"view_other_tasks",[]) or []
    if u.role=="manager" and department_user_ids:ors +=[{"assigned_to":{"$in":department_user_ids}},{"created_by":{"$in":department_user_ids}}]
    if view:ors.append({"assigned_to":{"$in":view}})
    return {"$or":ors}
def build_todo_query(u,target_user_id=None,department_user_ids=None):
    if u.role=="admin":return {"user_id":target_user_id} if target_user_id else {}
    if target_user_id:
        if target_user_id!=u.id and target_user_id not in(_get_perm(u,"view_other_todos",[]) or []) and not(u.role=="manager" and target_user_id in(department_user_ids or [])):raise HTTPException(status_code=403,detail="You do not have access to this user's todos")
        return {"user_id":target_user_id}
    ors=[{"user_id":u.id}];view=_get_perm(u,"view_other_todos",[]) or []
    if u.role=="manager" and department_user_ids:ors.append({"user_id":{"$in":department_user_ids}})
    if view:ors.append({"user_id":{"$in":view}})
    return {"$or":ors}
def build_client_query(u):
    if u.role=="admin" or _get_perm(u,"can_view_all_clients"):return {}
    ors=[{"assigned_to":u.id}];assigned=_get_perm(u,"assigned_clients",[]) or []
    if assigned:ors.append({"id":{"$in":assigned}})
    return {"$or":ors}
def build_attendance_query(u,target_user_id=None,department_user_ids=None):
    if u.role=="admin":return {"user_id":target_user_id} if target_user_id else {}
    if target_user_id:
        if not can_view_attendance(u,target_user_id) and not(u.role=="manager" and target_user_id in(department_user_ids or [])):raise HTTPException(status_code=403,detail="You do not have access to this user's attendance")
        return {"user_id":target_user_id}
    if _get_perm(u,"can_view_attendance"):
        if u.role=="manager" and department_user_ids:return {"user_id":{"$in":[u.id]+department_user_ids}}
        return {}
    ids=[u.id]+(_get_perm(u,"view_other_attendance",[]) or []);return {"user_id":{"$in":ids}} if len(ids)>1 else {"user_id":u.id}
def build_report_query(u,target_user_id=None):
    resolved=target_user_id or u.id
    if not can_view_report(u,resolved):raise HTTPException(status_code=403,detail="You do not have permission to view this report")
    return resolved
async def get_same_department_user_ids(user_id,include_managers=False):
    user=await db.users.find_one({"id":user_id})
    if not user or not user.get("departments"):return []
    roles=["staff"] if not include_managers else ["staff","manager"]
    rows=await db.users.find({"departments":{"$in":user["departments"]},"id":{"$ne":user_id},"role":{"$in":roles}},{"_id":0,"id":1}).to_list(500);return [u["id"] for u in rows]
async def get_team_user_ids(manager_id):return []
async def get_cross_visibility_union(user_id):
    user=await db.users.find_one({"id":user_id})
    if not user:return []
    perms=user.get("permissions",{}) or {};ids=set()
    for key in("view_other_tasks","view_other_attendance","view_other_visits","view_other_todos","view_other_reports","view_other_activity"):
        value=perms.get(key) or []
        if isinstance(value,list):ids.update(value)
    ids.discard(user_id);return list(ids)
def check_department_data_access(u,r,dept_user_ids):
    if u.role=="admin":return True
    rd=r.get("department") or r.get("departments")
    if rd:
        ud=u.departments or []
        if isinstance(rd,list):
            if not any(x in ud for x in rd):return False
        elif rd not in ud:return False
    owner=r.get("user_id") or r.get("assigned_to") or r.get("created_by");return owner==u.id or(u.role=="manager" and owner in dept_user_ids)
async def verify_record_access(current_user,record_owner_id):
    if current_user.role=="admin" or record_owner_id==current_user.id:return True
    raise HTTPException(status_code=403,detail="You do not have access to this resource")
async def verify_client_access(current_user,client):
    if can_view_client(current_user,client):return True
    raise HTTPException(status_code=403,detail="You do not have permission to access this client")
async def verify_activity_access(current_user,activity_user_id):
    if can_view_activity(current_user,activity_user_id):return True
    raise HTTPException(status_code=403,detail="You are not allowed to view this activity")
MODULE_ACTION_MAP={"tasks.view":"can_view_tasks","tasks.create":"can_edit_tasks","tasks.edit":"can_edit_tasks","tasks.delete":"can_delete_tasks","clients.view":"can_view_clients","clients.create":"can_edit_clients","clients.edit":"can_edit_clients","clients.delete":"can_delete_data","leads.view":"can_view_all_leads","leads.create":"can_view_all_leads","leads.edit":"can_view_all_leads","leads.delete":"can_manage_users","quotations.view":"can_create_quotations","quotations.create":"can_create_quotations","quotations.edit":"can_create_quotations","quotations.delete":"can_create_quotations","invoicing.view":"can_manage_invoices","invoicing.create":"can_manage_invoices","invoicing.edit":"can_manage_invoices","invoicing.delete":"can_manage_invoices","password_vault.view":"can_view_passwords","password_vault.create":"can_edit_passwords","password_vault.edit":"can_edit_passwords","password_vault.delete":"can_edit_passwords","password_reset.view":"can_reset_client_passwords","password_reset.create":"can_reset_client_passwords","password_reset.edit":"can_reset_client_passwords","password_reset.export":"can_reset_client_passwords","dsc_register.view":"can_view_all_dsc","dsc_register.create":"can_edit_dsc","dsc_register.edit":"can_edit_dsc","dsc_register.delete":"can_edit_dsc","document_register.view":"can_view_documents","document_register.create":"can_edit_documents","document_register.edit":"can_edit_documents","document_register.delete":"can_edit_documents","users.view":"can_view_user_page","users.create":"can_manage_users","users.edit":"can_edit_users","users.delete":"can_manage_users","task_audit_log.view":"can_view_audit_logs","email_accounts.view":"can_connect_email","email_accounts.create":"can_connect_email","email_accounts.edit":"can_connect_email","email_accounts.delete":"can_connect_email","general_settings.view":"can_manage_settings","general_settings.update":"can_manage_settings","attendance.view":"can_view_attendance","attendance.create":"can_view_attendance","reports.view":"can_view_reports","reports.download":"can_download_reports","compliance.view":"can_view_compliance","compliance.create":"can_manage_compliance","compliance.edit":"can_manage_compliance","compliance.delete":"can_manage_compliance","salary_slips.view":"can_view_salary_slips","salary_slips.create":"can_manage_salary_slips","salary_slips.edit":"can_manage_salary_slips","salary_slips.delete":"can_manage_salary_slips","roc_sphere.view":"can_view_roc_sphere","roc_sphere.create":"can_manage_roc_sphere","roc_sphere.edit":"can_manage_roc_sphere","roc_sphere.delete":"can_manage_roc_sphere"}
def check_module_permission(module,action):
    key=f"{module}.{action}";flag=MODULE_ACTION_MAP.get(key)
    async def checker(current_user=Depends(get_current_user)):
        if current_user.role=="admin":return current_user
        if flag is None:raise HTTPException(status_code=403,detail=f"No permission mapping found for {module}.{action}")
        if _get_perm(current_user,flag,False):return current_user
        raise HTTPException(status_code=403,detail=f"Permission required: {module}.{action} (flag: {flag})")
    return checker
def check_record_visibility(user,record,team_ids=None):
    if user.role=="admin":return True
    if record.get("created_by")==user.id or record.get("assigned_to")==user.id or record.get("user_id")==user.id:return True
    return user.role=="manager" and bool(team_ids) and(record.get("assigned_to") in team_ids or record.get("created_by") in team_ids or record.get("user_id") in team_ids)
def assert_record_visibility(user,record,team_ids=None):
    if not check_record_visibility(user,record,team_ids):raise HTTPException(status_code=403,detail="Access denied: record not visible to your account")
def assert_module_permission(user,module,action):
    if user.role=="admin":return
    flag=MODULE_ACTION_MAP.get(f"{module}.{action}")
    if flag is None:raise HTTPException(status_code=403,detail=f"No permission mapping found for {module}.{action}")
    if not _get_perm(user,flag,False):raise HTTPException(status_code=403,detail=f"Permission required: {module}.{action} (flag: {flag})")
async def create_audit_log(current_user,action,module,record_id,old_data=None,new_data=None):
    log_entry=AuditLog(user_id=current_user.id,user_name=getattr(current_user,"full_name","Unknown"),action=action,module=module,record_id=record_id,old_data=old_data,new_data=new_data);await db.audit_logs.insert_one(log_entry.model_dump())
def get_user_permissions(current_user):
    perms=getattr(current_user,"permissions",None)
    if perms is None:return {}
    if isinstance(perms,dict):return perms
    if hasattr(perms,"model_dump"):return perms.model_dump()
    return {}
async def get_db():yield db
admin_required=require_admin
_raw_db=db
db=TenantAwareDatabase(_raw_db)
