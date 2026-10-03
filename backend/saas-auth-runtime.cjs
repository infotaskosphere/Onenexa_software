const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "taskosphere_commercial";
const SESSION_TTL_DAYS = Number(process.env.SAAS_SESSION_TTL_DAYS || 30);
const BOOTSTRAP_EMAIL = String(process.env.SAAS_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const BOOTSTRAP_PASSWORD = String(process.env.SAAS_BOOTSTRAP_ADMIN_PASSWORD || "");
const BOOTSTRAP_COMPANY = String(process.env.SAAS_BOOTSTRAP_COMPANY_NAME || "Taskosphere Commercial").trim();
const BOOTSTRAP_PACKAGE = String(process.env.SAAS_BOOTSTRAP_PACKAGE_ID || "professional").trim();

const PLATFORM_OWNER_EMAILS = new Set(
  String(
    process.env.PLATFORM_OWNER_EMAILS ||
    process.env.PLATFORM_OWNER_EMAIL ||
    BOOTSTRAP_EMAIL ||
    "info.taskosphere@gmail.com,infotaskosphere@gmail.com,admin@taskosphere.com"
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function isPlatformOwnerAccount(user) {
  if (!user) return false;
  const role = String(user.role || "").trim().toLowerCase();
  const email = String(user.email || "").trim().toLowerCase();
  return Boolean(
    user.is_platform_owner ||
    user.isPlatformOwner ||
    ["platform_owner", "superadmin", "saas_admin"].includes(role) ||
    (email && PLATFORM_OWNER_EMAILS.has(email))
  );
}



let client = null;
let db = null;
let bootstrapPromise = null;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const actual = Buffer.from(hashPassword(password, record.salt), "hex");
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const COMMERCIAL_MODULE_ALIASES = {
  tasks: "taskosphere",
  taskosphere: "taskosphere",
  invoicing: "finix",
  accounting: "finix",
  finix: "finix",
  hrms: "people_matrix",
  people_matrix: "people_matrix",
  "people-matrix": "people_matrix",
  compliance: "compliance",
  records: "records",
  proposals: "proposals",
  client_proposals: "proposals",
  "client-proposals": "proposals"
};

const COMMERCIAL_MODULE_FLAGS = {
  taskosphere: "can_access_taskosphere",
  finix: "can_access_finix",
  compliance: "can_access_compliance",
  records: "can_access_records",
  proposals: "can_access_proposals",
  people_matrix: "can_access_people_matrix"
};

const COMMERCIAL_PAGE_FLAGS = {
  taskosphere: [
    "can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard",
    "can_view_attendance", "can_view_reminders", "can_view_action_center",
    "can_view_client_visits", "can_view_ai_document_reader",
    "can_view_client_portal", "can_reset_client_passwords"
  ],
  finix: [
    "can_view_accounting_reports", "can_view_sale", "can_view_purchase",
    "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts",
    "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"
  ],
  compliance: [
    "can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation",
    "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report",
    "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere",
    "can_manage_roc_sphere"
  ],
  records: [
    "can_view_all_dsc", "can_view_documents", "can_view_passwords",
    "can_edit_passwords", "can_view_all_clients", "can_edit_clients",
    "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"
  ],
  proposals: [
    "can_view_all_leads", "can_create_quotations", "can_view_client_discussion",
    "can_manage_client_discussion"
  ],
  people_matrix: [
    "can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll",
    "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment",
    "can_manage_recruitment", "can_view_performance", "can_manage_performance"
  ]
};

function normalizeCommercialModules(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
    const moduleId = COMMERCIAL_MODULE_ALIASES[key];
    if (moduleId && !result.includes(moduleId)) result.push(moduleId);
  }
  return result;
}

function commercialEntitlements(user, licenseDoc) {
  if (!licenseDoc) return null;

  const modules = normalizeCommercialModules(licenseDoc.modules || licenseDoc.licensed_modules);
  const rawSelected = licenseDoc.selected_features;
  const selectedFeatures = rawSelected && typeof rawSelected === "object" && !Array.isArray(rawSelected) ? rawSelected : {};
  const permissions = { ...(user.permissions || {}) };

  // The active commercial license is the hard ceiling for the tenant. A
  // customer-admin role never restores an unselected module/page.
  for (const [moduleId, moduleFlag] of Object.entries(COMMERCIAL_MODULE_FLAGS)) {
    const moduleAllowed = modules.includes(moduleId);
    permissions[moduleFlag] = moduleAllowed;
    const selected = new Set(Array.isArray(selectedFeatures[moduleId]) ? selectedFeatures[moduleId].map((flag) => String(flag).trim()) : []);
    for (const pageFlag of COMMERCIAL_PAGE_FLAGS[moduleId] || []) {
      permissions[pageFlag] = Boolean(moduleAllowed && selected.has(pageFlag));
    }
  }

  // Legacy screens still inspect these aliases. Keep them derived from the
  // same commercial page selections so old admin checks cannot reopen pages.
  permissions.can_manage_invoices = Boolean(modules.includes("finix") && Array.isArray(selectedFeatures.finix) && selectedFeatures.finix.includes("can_view_sale"));
  permissions.can_create_quotations = Boolean(modules.includes("proposals") && Array.isArray(selectedFeatures.proposals) && selectedFeatures.proposals.includes("can_create_quotations"));
  permissions.can_view_clients = Boolean(modules.includes("records") && Array.isArray(selectedFeatures.records) && selectedFeatures.records.includes("can_view_all_clients"));

  return {
    permissions,
    licensed_modules: modules,
    selected_features: selectedFeatures,
    license_id: licenseDoc.id || user.license_id || null,
    license_key: licenseDoc.license_key || user.license_key || null
  };
}

function publicUser(user, company, subscription, licenseDoc = null) {
  const commercial = commercialEntitlements(user, licenseDoc);
  return {
    id: String(user.id || user._id),
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    phone: user.phone || null,
    birthday: user.birthday || null,
    profile_picture: user.profile_picture || null,
    permissions: commercial ? commercial.permissions : (user.permissions || {}),
    company_id: String(user.company_id),
    company: company ? {
      id: String(company._id),
      name: company.name,
      slug: company.slug,
      status: company.status,
      licensed_modules: commercial?.licensed_modules || company.licensed_modules || [],
      selected_features: commercial?.selected_features || company.selected_features || {}
    } : null,
    licensed_modules: commercial?.licensed_modules || user.licensed_modules || subscription?.modules || [],
    selected_features: commercial?.selected_features || user.selected_features || company?.selected_features || {},
    license_id: commercial?.license_id || user.license_id || company?.license_id || null,
    license_key: commercial?.license_key || user.license_key || company?.license_key || null,
    subscription: subscription ? {
      package_id: subscription.package_id,
      status: subscription.status,
      modules: subscription.modules,
      max_users: subscription.max_users,
      max_installations: subscription.max_installations,
      starts_at: subscription.starts_at,
      expires_at: subscription.expires_at
    } : null
  };
}

async function findActiveCommercialLicense(database, user, company) {
  const clauses = [];
  if (user?.license_id) clauses.push({ id: String(user.license_id) });
  if (company?.license_id) clauses.push({ id: String(company.license_id) });
  if (user?.commercial_customer_id) clauses.push({ customer_id: String(user.commercial_customer_id) });
  if (company?.commercial_customer_id) clauses.push({ customer_id: String(company.commercial_customer_id) });
  if (!clauses.length) return null;

  const candidates = await database.collection("commercial_licenses")
    .find({ $or: clauses, status: { $in: ["active", "trial"] } })
    .sort({ issued_at: -1 })
    .limit(10)
    .toArray();

  const now = Date.now();
  return candidates.find((license) => {
    if (!license.expires_at) return true;
    const expiry = new Date(license.expires_at).getTime();
    return Number.isNaN(expiry) || expiry >= now;
  }) || null;
}

async function getDb() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (db) return db;
  if (!client) {
    client = new MongoClient(MONGODB_URI, { maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20) });
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
  }
  return db;
}

function packageDefinition(packageId) {
  const packages = {
    essential: { max_users: 10, max_installations: 1, modules: ["TASKS", "INVOICING"] },
    professional: { max_users: 25, max_installations: 2, modules: ["TASKS", "INVOICING", "HRMS"] },
    enterprise: { max_users: 100, max_installations: 5, modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"] }
  };
  return packages[packageId] || packages.professional;
}

async function ensureBootstrap() {
  if (!BOOTSTRAP_EMAIL || !BOOTSTRAP_PASSWORD) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const database = await getDb();
    const companies = database.collection("companies");
    const users = database.collection("users");
    const subscriptions = database.collection("subscriptions");

    const existing = await users.findOne({ email: BOOTSTRAP_EMAIL });

    // The bootstrap account is controlled by the bootstrap environment
    // variables. If the account already exists, synchronize its password so
    // changing SAAS_BOOTSTRAP_ADMIN_PASSWORD can recover the initial admin
    // without requiring a manual MongoDB password-hash edit.
    if (existing) {
      if (!existing.id) {
        await users.updateOne({ _id: existing._id }, { $set: { id: String(existing._id) } });
      }
      if (existing.role !== "admin" && existing.bootstrap_managed !== true) return;

      const passwordRecord = makePasswordRecord(BOOTSTRAP_PASSWORD);
      await users.updateOne(
        { _id: existing._id },
        {
          $set: {
            password_hash: passwordRecord.hash,
            password_salt: passwordRecord.salt,
            role: "admin",
            status: "active",
            bootstrap_managed: true,
            updated_at: new Date()
          }
        }
      );

      if (existing.company_id) {
        await companies.updateOne(
          { _id: existing.company_id },
          { $set: { status: "active", updated_at: new Date() } }
        );

        const subscription = await subscriptions.findOne({ company_id: existing.company_id });
        if (!subscription) {
          const now = new Date();
          const pkg = packageDefinition(BOOTSTRAP_PACKAGE);
          await subscriptions.insertOne({
            company_id: existing.company_id,
            package_id: BOOTSTRAP_PACKAGE,
            status: "active",
            max_users: pkg.max_users,
            max_installations: pkg.max_installations,
            modules: pkg.modules,
            starts_at: now,
            expires_at: new Date(now.getTime() + 365 * 86400000),
            created_at: now,
            updated_at: now
          });
        }
      }
      return;
    }

    const now = new Date();
    const slugBase = BOOTSTRAP_COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "taskosphere-commercial";
    const company = { name: BOOTSTRAP_COMPANY, slug: slugBase, status: "active", created_at: now, updated_at: now };
    const companyResult = await companies.insertOne(company);
    const companyId = companyResult.insertedId;
    const passwordRecord = makePasswordRecord(BOOTSTRAP_PASSWORD);
    const user = {
      company_id: companyId,
      email: BOOTSTRAP_EMAIL,
      full_name: "Commercial Admin",
      password_hash: passwordRecord.hash,
      password_salt: passwordRecord.salt,
      role: "admin",
      permissions: {},
      status: "active",
      bootstrap_managed: true,
      created_at: now,
      updated_at: now
    };
    await users.insertOne(user);
    const pkg = packageDefinition(BOOTSTRAP_PACKAGE);
    await subscriptions.insertOne({
      company_id: companyId,
      package_id: BOOTSTRAP_PACKAGE,
      status: "active",
      max_users: pkg.max_users,
      max_installations: pkg.max_installations,
      modules: pkg.modules,
      starts_at: now,
      expires_at: new Date(now.getTime() + 365 * 86400000),
      created_at: now,
      updated_at: now
    });
  })().finally(() => {
    // Keep this as a concurrency guard, not a permanent cache. If the
    // bootstrap account is removed or needs recovery after a restart, the
    // next login can safely re-check and bootstrap it again.
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

async function findSession(token) {
  if (!token) return null;
  const database = await getDb();
  const session = await database.collection("sessions").findOne({
    token_hash: hashToken(token),
    status: "active",
    expires_at: { $gt: new Date() }
  });
  if (!session) return null;
  const user = await database.collection("users").findOne({ _id: session.user_id, status: "active" });
  if (!user) return null;
  const company = await database.collection("companies").findOne({ _id: user.company_id, status: "active" });
  if (!company) return null;
  const subscription = await database.collection("subscriptions").findOne({ company_id: user.company_id });
  const commercialLicense = await findActiveCommercialLicense(database, user, company);
  await database.collection("sessions").updateOne({ _id: session._id }, { $set: { last_seen_at: new Date() } });
  return { session, user, company, subscription, commercialLicense };
}

async function login(email, password) {
  await ensureBootstrap();
  const database = await getDb();
  const user = await database.collection("users").findOne({ email: String(email || "").trim().toLowerCase(), status: "active" });
  if (!user || !verifyPassword(String(password || ""), user)) return null;
  const company = await database.collection("companies").findOne({ _id: user.company_id, status: "active" });
  const subscription = await database.collection("subscriptions").findOne({ company_id: user.company_id });
  if (!company || !subscription || !["trial", "active"].includes(subscription.status) || new Date(subscription.expires_at) <= new Date()) return null;
  const commercialLicense = await findActiveCommercialLicense(database, user, company);

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();

  // Single-login policy: every new login for a non-platform-owner account
  // replaces all older active sessions for the same user. The authentication
  // middleware checks status=active, so those older browsers immediately lose
  // access on their next API request.
  // Platform Owner is the only identity allowed to keep multiple active
  // sessions. Every other account gets exactly one active browser/device
  // session at a time.
  if (!isPlatformOwnerAccount(user)) {
    await database.collection("sessions").updateMany(
      { user_id: user._id, status: "active" },
      {
        $set: {
          status: "replaced",
          replaced_at: now,
          revoked_reason: "new_login"
        }
      }
    );
  }

  await database.collection("sessions").insertOne({
    user_id: user._id,
    company_id: user.company_id,
    token_hash: hashToken(token),
    status: "active",
    expires_at: new Date(now.getTime() + SESSION_TTL_DAYS * 86400000),
    created_at: now,
    last_seen_at: now
  });
  return { access_token: token, user: publicUser(user, company, subscription, commercialLicense) };
}

async function logout(token) {
  if (!token || !MONGODB_URI) return;
  const database = await getDb();
  await database.collection("sessions").deleteOne({ token_hash: hashToken(token) });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function attach(app) {
  if (!app || app.__taskosphereSaasAuthAttached) return;
  app.__taskosphereSaasAuthAttached = true;

  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (["/api/health", "/api/auth/login"].includes(req.path)) return next();

    try {
      const suppliedToken = bearerToken(req);
      const session = await findSession(suppliedToken);
      if (!session) {
        // Distinguish a replaced session from a random/expired token so the
        // frontend can coordinate a forced logout without silently treating
        // the account as invalid.
        if (suppliedToken) {
          const database = await getDb();
          const replaced = await database.collection("sessions").findOne({
            token_hash: hashToken(suppliedToken),
            status: "replaced"
          });
          if (replaced) {
            return sendJson(res, 401, { detail: "SESSION_REPLACED" });
          }
        }
        return sendJson(res, 401, { detail: "Authentication required" });
      }
      req.saas = session;
      return next();
    } catch (error) {
      console.error("SaaS authentication error:", error);
      return sendJson(res, 503, { detail: "Commercial authentication service unavailable" });
    }
  });

  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/auth/")) return next();
    try {
      if (req.path === "/api/auth/login" && req.method === "POST") {
        if (!MONGODB_URI) return sendJson(res, 503, { detail: "Commercial SaaS database is not configured" });
        const result = await login(req.body?.email, req.body?.password);
        if (!result) return sendJson(res, 401, { detail: "Invalid email or password" });
        return sendJson(res, 200, result);
      }
      if (req.path === "/api/auth/me" && req.method === "GET") {
        return sendJson(res, 200, publicUser(req.saas.user, req.saas.company, req.saas.subscription, req.saas.commercialLicense));
      }
      if (req.path === "/api/auth/logout" && req.method === "POST") {
        await logout(bearerToken(req));
        return sendJson(res, 200, { success: true });
      }
      if (req.path === "/api/auth/sync-permissions" && req.method === "POST") {
        return sendJson(res, 200, { permissions: req.saas.user.permissions || {} });
      }
      return next();
    } catch (error) {
      console.error("SaaS auth route error:", error);
      return sendJson(res, 500, { detail: "Authentication request failed" });
    }
  });
}

module.exports = { attach };
