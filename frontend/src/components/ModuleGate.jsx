import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canAccessPath, firstAccessiblePath, isPlatformOwner as matrixIsPlatformOwner, moduleForPath, isCommercialTenant } from '@/lib/commercialPermissionMatrix';
import { checkLicensePermissions, normalizeModuleKey, LicenseRouteGate } from '@/lib/licenseRouteGate.jsx';
import NoModuleAccess from '@/components/NoModuleAccess.jsx';

const MODULE_FLAGS = {
  taskosphere: 'can_access_taskosphere',
  finix: 'can_access_finix',
  compliance: 'can_access_compliance',
  records: 'can_access_records',
  proposals: 'can_access_proposals',
  peopleMatrix: 'can_access_people_matrix',
  people_matrix: 'can_access_people_matrix',
  accounting: 'can_access_finix',
  aiweave: 'can_access_aiweave',
};

// Commercial fallback pages are resolved from the same page-entitlement map
// below. A module purchase alone must never become a route fallback.
const MODULE_HOME = [
  ['can_access_taskosphere', '/dashboard'],
  ['can_access_finix', '/finix-dashboard'],
  ['can_access_compliance', '/compliance-dashboard'],
  ['can_access_records', '/records-dashboard'],
  ['can_access_proposals', '/client-proposals-dashboard'],
  ['can_access_people_matrix', '/people-matrix'],
  ['can_access_aiweave', '/ai-reader'],
];

// Commercial licenses select pages independently from the parent module.
// Keep this route-to-permission table in the existing route gate. Unknown
// commercial routes fail closed instead of inheriting the module purchase.
//
// IMPORTANT: can_view_accounting_reports represents the Finix Dashboard in the
// commercial catalog. Legacy accounting-report URLs are intentionally omitted
// so selecting the Dashboard feature cannot unlock them.
const ROUTE_PAGE_PREFIXES = {
  taskosphere: [
    ['can_view_dashboard', '/dashboard'],
    ['can_view_tasks', '/tasks'],
    ['can_view_todo_dashboard', '/todos'],
    ['can_view_attendance', '/attendance'],
    ['can_view_reminders', '/reminders'],
    ['can_view_action_center', '/action-center'],
    ['can_view_client_visits', '/visits'],
    ['can_view_client_portal', '/client-portal-manager'],
    ['can_reset_client_passwords', '/client-portal-manager/password'],
    ['can_reset_client_passwords', '/client-portal-manager/reset'],
  ],
  finix: [
    ['can_view_accounting_reports','/finix-dashboard'], ['can_view_sale','/invoicing'], ['can_view_purchase','/purchase'],
    ['can_view_bank','/bank-accounts'], ['can_view_chart_of_accounts','/chart-of-accounts'], ['can_manage_chart_of_accounts','/chart-of-accounts/manage'],
    ['can_view_journal_entries','/journal-entries'], ['can_post_journal_entries','/journal-entries/post'], ['can_view_zero_touch_entries','/zero-touch-entry'],
    ['can_view_accounting_reports','/accounting-reports'], ['can_view_extended_accounts_reports','/day-book'], ['can_view_extended_accounts_reports','/cash-bank-book'],
    ['can_view_extended_accounts_reports','/cash-flow'], ['can_view_extended_accounts_reports','/outstanding-report'], ['can_match_bank','/bank-reconciliation'],
    ['can_view_gst_portal_sync','/gst-portal-sync'], ['can_view_accounting_integrity','/accounting-integrity'], ['can_view_depreciation','/depreciation'],
    ['can_view_tds_tcs','/tds-tcs'], ['can_view_financial_ratios','/financial-ratios'], ['can_view_comparative_report','/comparative-report'],
    ['can_view_yearly_report','/yearly-report'], ['can_view_opening_balances','/opening-balances'], ['can_view_accounting_audit_trail','/accounting-audit-trail'],
    ['can_view_bulk_import','/bulk-import'], ['can_view_due_dates','/due-dates'], ['can_view_import_invoices','/import-invoices'],
    ['can_view_accounting_reports','/reports/day-book'], ['can_view_accounting_reports','/reports/journal-register'],
    ['can_view_accounting_reports','/reports/cash-bank-book'], ['can_view_accounting_reports','/reports/cash-flow'],
    ['can_view_accounting_reports','/reports/outstanding'], ['can_view_accounting_reports','/reports/financial-ratios'],
    ['can_view_accounting_reports','/reports/comparative'], ['can_view_accounting_reports','/reports/yearly'],
    ['can_view_accounting_reports','/reports/trial-balance'], ['can_view_accounting_reports','/reports/profit-loss'],
    ['can_view_accounting_reports','/reports/balance-sheet'], ['can_view_accounting_reports','/reports/mis-compliance'],
    ['can_view_accounting_reports','/reports/parties'], ['can_view_accounting_reports','/reports/party-ledger'],
    ['can_view_accounting_reports','/reports/validation-engine'], ['can_view_accounting_reports','/reports/ledger-by-code'],
  ],
  compliance: [
    ['can_view_compliance', '/compliance-dashboard'],
    ['can_view_compliance', '/compliance'],
    ['can_view_gst_reconciliation', '/gst-reconciliation'],
    ['can_view_trademark_sphere', '/trademark-sphere'],
    ['can_view_mis_report', '/mis-report'],
    ['can_view_salary_slips', '/salary-slips'],
    ['can_view_roc_sphere', '/roc-sphere'],
  ],
  records: [
    ['can_view_documents', '/records-dashboard'],
    ['can_view_all_dsc', '/dsc'],
    ['can_view_documents', '/documents'],
    ['can_view_all_clients', '/clients'],
    ['can_view_clients', '/client-approvals'],
    ['can_view_passwords', '/passwords'],
  ],
  proposals: [
    ['can_view_all_leads', '/client-proposals-dashboard'],
    ['can_view_all_leads', '/leads'],
    ['can_create_quotations', '/quotations'],
    ['can_view_client_discussion', '/client-discussion'],
  ],
  aiweave: [
    ['can_view_aiweave', '/aiweave'],
    ['can_view_aiweave', '/ai-reader'],
  ],
  peopleMatrix: [
    ['can_view_user_page', '/people-matrix'],
    ['can_view_user_page', '/users'],
    ['can_view_leave', '/leave'],
    ['can_view_payroll', '/payroll'],
    ['can_view_hr', '/hr'],
    ['can_view_recruitment', '/recruitment'],
    ['can_view_performance', '/performance'],
  ],
};

function matchesPath(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function selectedPageForPath(module, pathname) {
  const entries = ROUTE_PAGE_PREFIXES[module] || [];
  return entries
    .filter(([, prefix]) => matchesPath(pathname, prefix))
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0] || null;
}

function firstAccessiblePage(module, hasPermission) {
  const entries = ROUTE_PAGE_PREFIXES[module] || [];
  return entries.find(([flag]) => hasPermission(flag))?.[1] || null;
}

function firstAccessibleHome(hasPermission, preferredModule = null) {
  if (preferredModule) {
    const preferred = firstAccessiblePage(preferredModule, hasPermission);
    if (preferred) return preferred;
  }

  for (const [moduleFlag, moduleHome] of MODULE_HOME) {
    if (!hasPermission(moduleFlag)) continue;
    const module = Object.keys(MODULE_FLAGS).find((key) => MODULE_FLAGS[key] === moduleFlag) ||
      (moduleFlag === 'can_access_people_matrix' ? 'peopleMatrix' : null);
    const entitled = module ? firstAccessiblePage(module, hasPermission) : null;
    if (entitled) return entitled;
    // Non-commercial/internal callers may legitimately rely on the module home.
    return moduleHome;
  }
  return '/login';
}

function ModuleGate({ module, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const location = useLocation();

  if (!user) return <Navigate to="/login" replace />;

  const canonical = normalizeModuleKey(module);
  const targetKey = canonical?.id || module;
  const flag = MODULE_FLAGS[targetKey] || canonical?.flag;

  // Platform Owner is outside commercial license enforcement, including AIWeave.
  // Licensees still require both explicit AIWeave module and page grants.
  if (targetKey === 'aiweave') {
    if (matrixIsPlatformOwner(user) || isPlatformOwner) return children;
    const aiGranted =
      user?.permissions?.can_access_aiweave === true &&
      user?.permissions?.can_view_aiweave === true;
    if (!aiGranted) return <NoModuleAccess />;
    return children;
  }

  if (matrixIsPlatformOwner(user) || isPlatformOwner) return children;

  // Validate active subscription and license permissions for the requested module
  const licenseCheck = checkLicensePermissions(user, targetKey);
  if (!licenseCheck.allowed) {
    const dest = firstAccessiblePath(user, targetKey);
    if (!dest || dest === '/login' || dest === location.pathname) {
      return <NoModuleAccess />;
    }
    return <Navigate to={dest} replace />;
  }

  // firstAccessiblePath() answers "/login" when the account has no entitled page
  // at all. Redirecting a signed-in user to /login bounces straight back (login is
  // a public-only route) and paints a blank white screen forever. Show an
  // explanatory screen instead, and never redirect to the page we are already on.
  const redirectOrBlock = (destination) => {
    if (!destination || destination === '/login' || destination === location.pathname) {
      return <NoModuleAccess />;
    }
    return <Navigate to={destination} replace />;
  };

  const commercial = isCommercialTenant(user);

  if (commercial) {
    // A commercial route must be explicitly represented by the central matrix.
    // Known-but-unlicensed routes are mapped with a null page flag and therefore
    // fail closed; they must never inherit access from the parent module.
    const routeModule = moduleForPath(location.pathname);
    if (routeModule) {
      if (!canAccessPath(user, location.pathname)) {
        return redirectOrBlock(firstAccessiblePath(user, targetKey));
      }
      return children;
    }
    // This component was invoked for a commercial module route that the matrix
    // does not know about. Do not grant it merely because the module is licensed.
    return redirectOrBlock(firstAccessiblePath(user, targetKey));
  }

  if (flag && !hasPermission(flag)) {
    return redirectOrBlock(firstAccessiblePath(user));
  }
  return children;
}

export { LicenseRouteGate };
export default ModuleGate;
