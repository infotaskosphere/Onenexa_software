/**
 * Commercial permission matrix — single frontend authority for module/page visibility.
 */

export const PLATFORM_OWNER_EMAIL = import.meta.env?.VITE_PLATFORM_OWNER_EMAIL || "info.taskosphere@gmail.com";

const getPlatformOwnerEmails = () => {
  const configured = [
    import.meta.env?.VITE_PLATFORM_OWNER_EMAIL,
    import.meta.env?.VITE_PLATFORM_OWNER_EMAILS,
  ].filter(Boolean).join(",");
  if (configured) {
    const customSet = new Set();
    configured.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((e) => customSet.add(e));
    if (customSet.size > 0) return customSet;
  }
  return new Set([PLATFORM_OWNER_EMAIL.toLowerCase(), "infotaskosphere@gmail.com", "admin@taskosphere.com"]);
};

export const MODULES = Object.freeze({
  core: { flag: null, aliases: ["core", "admin"], landing: "/users" },
  taskosphere: { flag: "can_access_taskosphere", aliases: ["taskosphere", "tasks"], landing: "/dashboard" },
  finix: { flag: "can_access_finix", aliases: ["finix", "invoicing", "accounting"], landing: "/finix-dashboard" },
  compliance: { flag: "can_access_compliance", aliases: ["compliance"], landing: "/compliance-dashboard" },
  records: { flag: "can_access_records", aliases: ["records"], landing: "/records-dashboard" },
  proposals: { flag: "can_access_proposals", aliases: ["proposals", "client_proposals", "leadsense"], landing: "/client-proposals-dashboard" },
  people_matrix: { flag: "can_access_people_matrix", aliases: ["people_matrix", "hrms", "peoplematrix"], landing: "/people-matrix" },
  aiweave: { flag: "can_access_aiweave", aliases: ["aiweave", "ai-weave"], landing: "/aiweave" },
});

export const PAGE_MATRIX = Object.freeze([
  ["core", "can_view_user_page", "/users"],
  ["core", "can_view_staff_activity", "/staff-activity"],
  ["core", "can_view_reports", "/reports/efficiency"],
  ["core", "can_view_reports", "/reports/performance-rankings"],
  ["core", "can_download_reports", "/reports/export"],
  ["core", "can_manage_settings", "/settings"],
  ["core", "can_view_security_sessions", "/security/sessions"],
  ["taskosphere", "can_view_dashboard", "/dashboard"], ["taskosphere", "can_view_tasks", "/tasks"], ["taskosphere", "can_view_todo_dashboard", "/todos"], ["taskosphere", "can_view_attendance", "/attendance"], ["taskosphere", "can_view_reminders", "/reminders"], ["taskosphere", "can_view_action_center", "/action-center"], ["taskosphere", "can_view_client_visits", "/visits"], ["taskosphere", "can_view_client_portal", "/client-portal-manager"], ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/password"], ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/reset"],
  ["finix", "can_view_accounting_reports", "/finix-dashboard"],
  ["finix", "can_view_accounting_reports", "/reports/day-book"],
  ["finix", "can_view_accounting_reports", "/reports/journal-register"],
  ["finix", "can_view_accounting_reports", "/reports/cash-bank-book"],
  ["finix", "can_view_accounting_reports", "/reports/cash-flow"],
  ["finix", "can_view_accounting_reports", "/reports/outstanding"],
  ["finix", "can_view_accounting_reports", "/reports/financial-ratios"],
  ["finix", "can_view_accounting_reports", "/reports/comparative"],
  ["finix", "can_view_accounting_reports", "/reports/yearly"],
  ["finix", "can_view_accounting_reports", "/reports/trial-balance"],
  ["finix", "can_view_accounting_reports", "/reports/profit-loss"],
  ["finix", "can_view_accounting_reports", "/reports/balance-sheet"],
  ["finix", "can_view_accounting_reports", "/reports/mis-compliance"],
  ["finix", "can_view_accounting_reports", "/reports/parties"],
  ["finix", "can_view_accounting_reports", "/reports/party-ledger"],
  ["finix", "can_view_accounting_reports", "/reports/validation-engine"],
  ["finix", "can_view_accounting_reports", "/reports/ledger-by-code"],
  ["finix", "can_view_accounting_reports", "/reports/finix-dashboard"], ["finix", "can_view_accounting_reports", "/accounting-reports"], ["finix", "can_post_journal_entries", "/zero-touch-entry"], ["finix", "can_view_accounting_reports", "/gst-portal-sync"], ["finix", "can_manage_chart_of_accounts", "/accounting-integrity"], ["finix", "can_view_accounting_reports", "/day-book"], ["finix", "can_view_accounting_reports", "/cash-bank-book"], ["finix", "can_view_accounting_reports", "/cash-flow"], ["finix", "can_view_accounting_reports", "/outstanding-report"],  ["finix", "can_view_accounting_reports", "/depreciation"], ["finix", "can_view_accounting_reports", "/tds-tcs"], ["finix", "can_view_accounting_reports", "/financial-ratios"], ["finix", "can_view_accounting_reports", "/comparative-report"], ["finix", "can_view_accounting_reports", "/yearly-report"], ["finix", "can_view_accounting_reports", "/opening-balances"], ["finix", "can_view_accounting_reports", "/accounting-audit-trail"], ["finix", "can_view_accounting_reports", "/bulk-import"], ["finix", "can_view_accounting_reports", "/due-dates"], ["finix", "can_view_sale", "/import-invoices"], ["finix", "can_view_sale", "/invoicing"], ["finix", "can_view_purchase", "/purchase"], ["finix", "can_view_bank", "/bank-accounts"], ["finix", "can_view_chart_of_accounts", "/chart-of-accounts"], ["finix", "can_manage_chart_of_accounts", "/chart-of-accounts/manage"], ["finix", "can_view_journal_entries", "/journal-entries"], ["finix", "can_post_journal_entries", "/journal-entries/post"], ["finix", "can_match_bank", "/bank-reconciliation"],
  ["compliance", "can_view_compliance", "/compliance-dashboard"], ["compliance", "can_view_compliance", "/compliance"], ["compliance", "can_manage_compliance", "/compliance/manage"], ["compliance", "can_view_gst_reconciliation", "/gst-reconciliation"], ["compliance", "can_view_gst_reconciliation", "/gst-sphere"], ["compliance", "can_view_trademark_sphere", "/trademark-sphere"], ["compliance", "can_view_mis_report", "/mis-report"], ["compliance", "can_manage_mis_report", "/mis-report/manage"], ["compliance", "can_view_salary_slips", "/salary-slips"], ["compliance", "can_manage_salary_slips", "/salary-slips/manage"], ["compliance", "can_view_roc_sphere", "/roc-sphere"], ["compliance", "can_manage_roc_sphere", "/roc-sphere/manage"],
  ["records", "can_view_documents", "/records-dashboard"], ["records", "can_view_all_dsc", "/dsc"], ["records", "can_view_documents", "/documents"], ["records", "can_view_passwords", "/passwords"], ["records", "can_edit_passwords", "/passwords/manage"], ["records", "can_view_all_clients", "/clients"], ["records", "can_view_clients", "/client-approvals"], ["records", "can_edit_clients", "/clients/manage"], ["records", "can_approve_clients", "/clients/approve"], ["records", "can_approve_whatsapp_wishes", "/automation/whatsapp"], ["records", "can_approve_email_wishes", "/automation/email"],
  ["proposals", "can_view_all_leads", "/client-proposals-dashboard"], ["proposals", "can_view_all_leads", "/leads"], ["proposals", "can_create_quotations", "/quotations"], ["proposals", "can_view_client_discussion", "/client-discussion"], ["proposals", "can_manage_client_discussion", "/client-discussion/manage"],
  ["aiweave", "can_view_aiweave", "/aiweave"],
  ["people_matrix", "can_view_user_page", "/people-matrix"], ["people_matrix", "can_view_user_page", "/users"], ["people_matrix", "can_view_leave", "/leave"], ["people_matrix", "can_manage_leave", "/leave/manage"], ["people_matrix", "can_view_payroll", "/payroll"], ["people_matrix", "can_manage_payroll", "/payroll/manage"], ["people_matrix", "can_view_hr", "/hr"], ["people_matrix", "can_manage_hr", "/hr/manage"], ["people_matrix", "can_view_recruitment", "/recruitment"], ["people_matrix", "can_manage_recruitment", "/recruitment/manage"], ["people_matrix", "can_view_performance", "/performance"], ["people_matrix", "can_manage_performance", "/performance/manage"],
]);

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");

export function isPlatformOwner(user) {
  if (!user) return false;
  if (user.is_platform_owner === true || user.isPlatformOwner === true) return true;
  const role = String(user.role || "").trim().toLowerCase();
  if (role === "platform_owner" || role === "superadmin" || role === "saas_admin") return true;
  const email = String(user.email || "").trim().toLowerCase();
  const id = String(user.id || "").trim();
  const companyId = String(user.company_id || user.company?.id || "").trim().toLowerCase();
  const ownerEmails = getPlatformOwnerEmails();
  return ownerEmails.has(email) || id === "usr-admin-01" || id === "saas-bootstrap-admin" || companyId === "platform-owner-48fe785fdd75127f" || companyId.startsWith("platform-owner-");
}

export function normalizeModules(user) {
  const sources = [user?.licensed_modules, user?.modules, user?.company?.licensed_modules, user?.company?.modules, user?.license?.modules, user?.subscription?.modules];
  const raw = sources.find((value) => Array.isArray(value) && value.length > 0) || []; const result = new Set();
  for (const value of raw) { const key = normalize(value); for (const [moduleId, def] of Object.entries(MODULES)) if (def.aliases.includes(key) || key === moduleId) result.add(moduleId); }
  return result;
}

const DASHBOARD_FLAG_BY_MODULE = Object.freeze({ core: "can_access_admin", taskosphere: "can_view_dashboard", finix: "can_view_accounting_reports", compliance: "can_view_compliance", records: "can_view_documents", proposals: "can_view_all_leads", people_matrix: "can_view_user_page" });
const ALL_PAGE_FLAGS_BY_MODULE = Object.freeze({
  core: ["can_view_user_page", "can_view_staff_activity", "can_view_reports", "can_download_reports", "can_manage_settings", "can_view_security_sessions"],
  taskosphere: ["can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard", "can_view_attendance", "can_view_reminders", "can_view_action_center", "can_view_client_visits", "can_view_client_portal", "can_reset_client_passwords"],
  finix: ["can_view_accounting_reports", "can_view_sale", "can_view_purchase", "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts", "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"],
  compliance: ["can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation", "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report", "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere", "can_manage_roc_sphere"],
  records: ["can_view_documents", "can_view_all_dsc", "can_view_passwords", "can_edit_passwords", "can_view_all_clients", "can_edit_clients", "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"],
  proposals: ["can_view_all_leads", "can_create_quotations", "can_view_client_discussion", "can_manage_client_discussion"],
  people_matrix: ["can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll", "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment", "can_manage_recruitment", "can_view_performance", "can_manage_performance"],
  aiweave: ["can_view_aiweave"],
});

export function normalizedSelectedFeatures(user) {
  // MODULE ISOLATION RULE (identical for every module):
  //  * a module that is not on the license grants nothing, even if a stale entry
  //    for it is still present in selected_features;
  //  * when explicit selected_features are present, the listed pages are the
  //    complete source of truth for that module. Missing module entries grant
  //    nothing, not full-module access;
  //  * when selected_features is completely absent, retain legacy module-only
  //    compatibility and allow all pages of each licensed module.
  const licensed = normalizeModules(user);
  const raw = user?.selected_features || user?.company?.selected_features || user?.license?.selected_features;
  const hasExplicitSelections = raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0;
  const source = hasExplicitSelections ? raw : {};
  const result = {};

  for (const [moduleKey, flags] of Object.entries(source)) {
    const normalizedModule = normalize(moduleKey);
    const moduleId = Object.entries(MODULES).find(([id, def]) => id === normalizedModule || def.aliases.includes(normalizedModule))?.[0] || normalizedModule;
    if (licensed.size > 0 && !licensed.has(moduleId)) continue;

    const list = Array.isArray(flags) ? flags.map((flag) => normalize(flag)) : [];
    const hasAll = list.some((flag) => ["all", "*", "all_features", "full", "complete"].includes(flag));
    const effectiveFlags = new Set(
      hasAll
        ? (ALL_PAGE_FLAGS_BY_MODULE[moduleId] || [])
        : list.map((flag) => String(flag).trim())
    );
    // Do NOT derive a dashboard/report entitlement from another selected page.
    // The Platform Owner must explicitly select the dashboard/report page too.
    result[moduleId] = effectiveFlags;
  }

  // Licensed modules without an explicit Platform Owner page selection
  // receive no page access. A module purchase alone never reopens stale/full access.
  for (const moduleId of licensed) {
    if (result[moduleId]) continue;
    result[moduleId] = new Set();
  }

  return result;
}

export function isCommercialTenant(user) { return Boolean(user) && !isPlatformOwner(user) && Boolean(user.company_id || user.license_id || user.commercial_customer_id || (Array.isArray(user.licensed_modules) && user.licensed_modules.length > 0) || user.company?.commercial_customer_id || user.company?.license_id); }

export function moduleForPath(pathname) { const path = String(pathname || "").split("?", 1)[0]; const match = PAGE_MATRIX.filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort((a, b) => b[2].length - a[2].length)[0]; return match?.[0] || null; }
export function pageFlagForPath(pathname) { const path = String(pathname || "").split("?", 1)[0]; const match = PAGE_MATRIX.filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort((a, b) => b[2].length - a[2].length)[0]; return match?.[1] || null; }

export function hasModuleAccess(user, moduleId) {
  if (!user) return false;
  if (isPlatformOwner(user)) return true;
  if (moduleId === "core") return isCommercialTenant(user);
  if (moduleId === "aiweave") return user.permissions?.can_access_aiweave === true && user.permissions?.can_view_aiweave === true;
  if (!MODULES[moduleId]) return false;
  const modules = normalizeModules(user);
  // Commercial license is the hard ceiling: unlicensed modules cannot be accessed by anyone in the company
  if (modules.size > 0 && !modules.has(moduleId)) return false;
  // Licensee administrator module visibility is also controlled by the
  // Platform Owner's explicit page selection.
  if (String(user.role || "").toLowerCase() === "admin") {
    return (normalizedSelectedFeatures(user)[moduleId] || new Set()).size > 0;
  };

  // Non-admin licensee users (manager/staff) are governed by the
  // licensee-admin Permission Matrix. The commercial license is only the
  // maximum ceiling; it must never become an implicit grant.
  const def = MODULES[moduleId];
  if (def?.flag) {
    // Access is fail-closed when the module flag is absent. This is important
    // after a Permission Matrix change: an unselected module must disappear
    // immediately rather than falling back to the company's licensed modules.
    return user.permissions?.[def.flag] === true;
  }

  // Fallback only for legacy module definitions without a canonical module
  // access flag: an explicitly granted page is enough to expose the module.
  const allFlags = ALL_PAGE_FLAGS_BY_MODULE[moduleId] || [];
  return allFlags.some((flag) => user.permissions?.[flag] === true);
}

export function hasPageLicense(user, pageFlag, moduleId = null) {
  if (!user || !pageFlag) return false;
  if (isPlatformOwner(user)) return true;
  if (pageFlag === "can_access_aiweave") {
    return user.permissions?.can_access_aiweave === true;
  }
  if (pageFlag === "can_view_aiweave") {
    return user.permissions?.can_access_aiweave === true && user.permissions?.can_view_aiweave === true;
  }
  const module = moduleId || Object.entries(MODULES).find(([id, def]) => {
    return ALL_PAGE_FLAGS_BY_MODULE[id]?.includes(pageFlag);
  })?.[0] || Object.entries(MODULES).find(([id]) => normalizedSelectedFeatures(user)[id]?.has(pageFlag))?.[0];

  if (!module) return false;

  // Core is non-billable and available to every authenticated commercial tenant.
  if (module === "core") {
    return true;
  }

  // Hard ceiling: company must have the module on the commercial license
  const modules = normalizeModules(user);
  if (modules.size > 0 && !modules.has(module)) return false;

  // Page access is still governed by the Platform Owner's explicit
  // selected_features grant. A licensed module alone is never sufficient.
  const selected = normalizedSelectedFeatures(user)[module] || new Set();
  return selected.has(pageFlag);
}

export function hasEffectivePermission(user, permission) {
  // Licensee Admin owns the tenant control plane. Admin/Settings navigation and
  // control-plane permissions stay available even when the customer purchased
  // only one operational module. Purchased operational modules remain the hard
  // ceiling for business-module routes and APIs.
  if (user && !isPlatformOwner(user) && String(user.role || "").trim().toLowerCase() === "admin" && user.company_id) {
    const adminControlPlanePermissions = new Set([
      "can_access_admin",
      "can_view_user_page",
      "can_manage_permissions",
      "can_view_audit_logs",
      "can_manage_settings",
      "can_view_master_data",
      "can_manage_master_data",
      "can_view_roles",
      "can_manage_roles",
      "can_view_staff_activity",
      "can_view_backup_restore",
    ]);
    if (adminControlPlanePermissions.has(permission)) return true;
  }
  if (!user || !permission) return false;
  if (isPlatformOwner(user)) return true;
  if (permission === "can_access_aiweave") return user.permissions?.can_access_aiweave === true && user.permissions?.can_view_aiweave === true;
  if (permission === "can_view_aiweave") return user.permissions?.can_access_aiweave === true && user.permissions?.can_view_aiweave === true;
  if (!isCommercialTenant(user)) return typeof user.permissions?.[permission] === "boolean" ? user.permissions[permission] : String(user.role || "").toLowerCase() === "admin";
  const moduleEntry = Object.entries(MODULES).find(([, def]) => def.flag === permission);
  if (moduleEntry) return hasModuleAccess(user, moduleEntry[0]);
  const pageEntry = PAGE_MATRIX.find(([, flag]) => flag === permission);
  if (pageEntry) {
    const [moduleId] = pageEntry;
    if (moduleId === "core") {
      if (permission === "can_view_security_sessions") return isCommercialTenant(user);
      if (String(user.role || "").toLowerCase() === "admin") return true;
      return Boolean(user.permissions?.[permission]);
    }
    if (!hasPageLicense(user, permission, moduleId)) return false;
    // Commercial licensee admins are governed by the active commercial
    // module + selected-page ceiling. Platform Owner is handled above.
    if (String(user.role || "").toLowerCase() === "admin") {
      // Tenant-admin access is also capped by the Platform Owner's explicit
      // selected page entitlements. Never trust stale stored permissions to
      // reopen a page that is not present in the active license selection.
      return hasPageLicense(user, permission, moduleId);
    }
    // For non-admin (manager, staff): verify parent module is accessible
    const modDef = MODULES[moduleId];
    if (modDef?.flag && user.permissions?.[modDef.flag] === false) return false;
    if (!hasModuleAccess(user, moduleId)) return false;

    // Explicit setting by licensee admin takes precedence
    if (user.permissions?.[permission] !== undefined) {
      return Boolean(user.permissions[permission]);
    }

    // Module dashboard landing flag is derived from module access:
    // When module is permitted by licensee admin, its dashboard landing is accessible
    const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[moduleId];
    if (dashboardFlag === permission) return true;

    return user.permissions?.[permission] === true || (permission === "can_view_client_discussion" && user.permissions?.can_view_all_leads === true);
  }
  const legacyToPage = { can_manage_invoices: "can_view_sale", can_create_quotations: "can_create_quotations", can_view_clients: "can_view_all_clients" };
  const page = legacyToPage[permission];
  if (page) return hasEffectivePermission(user, page) && user.permissions?.[permission] !== false;
  return user.permissions?.[permission] === true;
}

export function canAccessPath(user, pathname) {
  if (!user) return false;
  if (isPlatformOwner(user)) return true;

  // Licensee Admin control-plane/shared-master-data pages are tenant-wide
  // administration surfaces, not separately purchased operational modules.
  // Keep them reachable even when the tenant buys only one module.
  const normalizedPath = String(pathname || "").split("?", 1)[0];
  if (
    String(user.role || "").trim().toLowerCase() === "admin" &&
    user.company_id &&
    ["/users", "/reports"].some(
      (prefix) => normalizedPath === prefix || normalizedPath.startsWith(prefix + "/")
    )
  ) {
    return true;
  }

  const moduleId = moduleForPath(normalizedPath);
  if (!moduleId) return true;
  const flag = pageFlagForPath(normalizedPath);
  if (!flag) return false;
  return hasEffectivePermission(user, flag);
}
export function firstAccessiblePath(user, preferredModule = null) { if (!user) return "/login"; if (isPlatformOwner(user)) return "/dashboard"; const ordered = preferredModule ? [preferredModule, ...Object.keys(MODULES).filter((id) => id !== preferredModule)] : Object.keys(MODULES); for (const moduleId of ordered) { if (!hasModuleAccess(user, moduleId)) continue; const page = PAGE_MATRIX.find(([id, flag, path]) => id === moduleId && hasEffectivePermission(user, flag)); if (page) return page[2]; } return "/login"; }
