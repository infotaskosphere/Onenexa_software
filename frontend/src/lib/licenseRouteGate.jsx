import React, { useMemo } from 'react';
import { Navigate, useLocation, useNavigate, Link } from 'react-router-dom';
import { ShieldAlert, Lock, ArrowRight, LayoutDashboard, Sparkles, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext.jsx';
import {
  hasModuleAccess,
  isPlatformOwner as matrixIsPlatformOwner,
  normalizeModules,
  firstAccessiblePath,
  isCommercialTenant,
} from '@/lib/commercialPermissionMatrix';
import { Button } from '@/components/ui/button';

/**
 * Canonical module registry with alias recognition and metadata.
 * Supports 'Taskosphere', 'Records', 'Accounting' (Finix), and remaining modules.
 */
export const MODULE_REGISTRY = Object.freeze({
  taskosphere: {
    id: 'taskosphere',
    displayName: 'Taskosphere',
    aliases: ['taskosphere', 'tasks', 'task-o-sphere', 'task_o_sphere'],
    flag: 'can_access_taskosphere',
    landingPath: '/dashboard',
    themeColor: '#2563EB',
    description: 'Workflows, To-Dos, Team Attendance, Reminders & Operational Action Center.',
  },
  records: {
    id: 'records',
    displayName: 'Records',
    aliases: ['records', 'documents', 'dsc', 'record', 'vault'],
    flag: 'can_access_records',
    landingPath: '/records-dashboard',
    themeColor: '#0369A1',
    description: 'Document Repository, Digital Signatures (DSC), Client Directory & Secure Vault.',
  },
  finix: {
    id: 'finix',
    displayName: 'Accounting',
    aliases: ['accounting', 'finix', 'invoicing', 'accounts', 'finance', 'ledger'],
    flag: 'can_access_finix',
    landingPath: '/finix-dashboard',
    themeColor: '#0A67D9',
    description: 'Sales Invoicing, Purchase Bills, Bank Matching, Chart of Accounts & General Ledger.',
  },
  compliance: {
    id: 'compliance',
    displayName: 'CompliGenie',
    aliases: ['compliance', 'compligenie', 'tax', 'gst'],
    flag: 'can_access_compliance',
    landingPath: '/compliance-dashboard',
    themeColor: '#059669',
    description: 'GST Reconciliation, Trademark Sphere, ROC Returns & Compliance Tracker.',
  },
  proposals: {
    id: 'proposals',
    displayName: 'LeadSense',
    aliases: ['proposals', 'client_proposals', 'leadsense', 'leads'],
    flag: 'can_access_proposals',
    landingPath: '/client-proposals-dashboard',
    themeColor: '#0891B2',
    description: 'Lead Management, Commercial Quotations & Client Negotiation Pipeline.',
  },
  people_matrix: {
    id: 'people_matrix',
    displayName: 'People Matrix',
    aliases: ['people_matrix', 'peoplematrix', 'people-matrix', 'hrms', 'hr'],
    flag: 'can_access_people_matrix',
    landingPath: '/people-matrix',
    themeColor: '#4338CA',
    description: 'Human Resources, Payroll Calculation, Leave Management & Recruitment.',
  },
  aiweave: {
    id: 'aiweave',
    displayName: 'AIWeave',
    aliases: ['aiweave', 'ai-weave', 'ai_weave'],
    flag: 'can_access_aiweave',
    landingPath: '/aiweave',
    themeColor: '#9333EA',
    description: 'Generative AI Document Summaries, Data Extraction & Cognitive Workspaces.',
  },
});

/**
 * Normalizes user-supplied module name or alias to canonical entry.
 * Example: 'Accounting' -> MODULE_REGISTRY.finix
 *          'Taskosphere' -> MODULE_REGISTRY.taskosphere
 *          'Records' -> MODULE_REGISTRY.records
 */
export function normalizeModuleKey(rawName) {
  if (!rawName) return null;
  const cleaned = String(rawName).trim().toLowerCase().replace(/[-\s]+/g, '_');
  for (const [key, def] of Object.entries(MODULE_REGISTRY)) {
    if (key === cleaned || def.aliases.some((alias) => alias.replace(/[-\s]+/g, '_') === cleaned)) {
      return def;
    }
  }
  return null;
}

/**
 * Pure evaluation function that checks user's license and active subscription.
 *
 * @param {object} user - Authenticated user object from AuthContext
 * @param {string} targetModule - Name/alias e.g. 'Taskosphere', 'Records', 'Accounting'
 * @returns {object} { allowed: boolean, reason: string, detail: string, moduleDef: object }
 */
export function checkLicensePermissions(user, targetModule) {
  if (!user) {
    return {
      allowed: false,
      reason: 'unauthenticated',
      detail: 'You must be signed in to access this workspace.',
      moduleDef: null,
    };
  }

  // Platform owner always has full operational access across all modules
  if (matrixIsPlatformOwner(user)) {
    return {
      allowed: true,
      reason: 'platform_owner',
      detail: 'Platform owners have universal access to all commercial modules.',
      moduleDef: normalizeModuleKey(targetModule),
    };
  }

  const moduleDef = normalizeModuleKey(targetModule);
  if (!moduleDef) {
    // If not a recognized operational module, fail safe or grant if global
    return {
      allowed: true,
      reason: 'unrestricted',
      detail: 'Unrestricted or standard utility module.',
      moduleDef: null,
    };
  }

  // 1. Check Subscription Status & Expiration if subscription object is present
  const subscription = user?.subscription || user?.company?.subscription;
  if (subscription && typeof subscription === 'object') {
    const subStatus = String(subscription.status || '').trim().toLowerCase();
    if (['suspended', 'cancelled', 'inactive', 'revoked'].includes(subStatus)) {
      return {
        allowed: false,
        reason: 'subscription_inactive',
        detail: `Your ${moduleDef.displayName} subscription is currently marked as ${subStatus}.`,
        moduleDef,
      };
    }

    if (subscription.expires_at) {
      try {
        const expiryDate = new Date(subscription.expires_at);
        if (!isNaN(expiryDate.getTime()) && expiryDate.getTime() < Date.now()) {
          return {
            allowed: false,
            reason: 'subscription_expired',
            detail: `Your subscription to ${moduleDef.displayName} expired on ${expiryDate.toLocaleDateString()}.`,
            moduleDef,
          };
        }
      } catch {}
    }

    // If subscription explicitly restricts modules array
    if (Array.isArray(subscription.modules) && subscription.modules.length > 0) {
      const subModules = new Set(subscription.modules.map((m) => String(m).toLowerCase().replace(/[-\s]+/g, '_')));
      const matchesSub = moduleDef.aliases.some((a) => subModules.has(a.replace(/[-\s]+/g, '_'))) || subModules.has(moduleDef.id);
      if (!matchesSub) {
        return {
          allowed: false,
          reason: 'subscription_module_excluded',
          detail: `Your subscription plan does not include the ${moduleDef.displayName} module.`,
          moduleDef,
        };
      }
    }
  }

  // 2. Check License Validity if license object is present
  const license = user?.license || user?.company?.license;
  if (license && typeof license === 'object') {
    const licStatus = String(license.status || '').trim().toLowerCase();
    if (['suspended', 'revoked', 'expired', 'inactive'].includes(licStatus)) {
      return {
        allowed: false,
        reason: 'license_inactive',
        detail: `The commercial license for ${moduleDef.displayName} is ${licStatus}.`,
        moduleDef,
      };
    }
  }

  // 3. Check Central Commercial Entitlement Matrix
  const commercial = isCommercialTenant(user);
  if (commercial) {
    const hasAccess = hasModuleAccess(user, moduleDef.id);
    if (!hasAccess) {
      return {
        allowed: false,
        reason: 'module_not_licensed',
        detail: `Access to ${moduleDef.displayName} is restricted. Your tenant organization has not been provisioned with this module.`,
        moduleDef,
      };
    }
  } else {
    // Legacy / internal role check via permission flags
    const licensedMods = normalizeModules(user);
    const hasModuleInList = moduleDef.aliases.some((a) => licensedMods.has(a.replace(/[-\s]+/g, '_'))) || licensedMods.has(moduleDef.id);
    const hasFlag = user?.permissions?.[moduleDef.flag] === true;

    if (!hasModuleInList && !hasFlag && user?.role !== 'admin') {
      return {
        allowed: false,
        reason: 'permission_missing',
        detail: `Missing permission flag [${moduleDef.flag}] for ${moduleDef.displayName}.`,
        moduleDef,
      };
    }
  }

  return {
    allowed: true,
    reason: 'granted',
    detail: `Access granted for ${moduleDef.displayName}.`,
    moduleDef,
  };
}

/**
 * Custom React hook to check license and subscription state for a module.
 */
export function useLicenseGate(targetModule) {
  const { user, isPlatformOwner, loading } = useAuth();

  return useMemo(() => {
    if (loading) {
      return {
        allowed: false,
        loading: true,
        reason: 'loading',
        detail: 'Validating license credentials…',
        moduleDef: normalizeModuleKey(targetModule),
      };
    }

    if (isPlatformOwner) {
      return {
        allowed: true,
        loading: false,
        reason: 'platform_owner',
        detail: 'Universal platform-owner access granted.',
        moduleDef: normalizeModuleKey(targetModule),
      };
    }

    const check = checkLicensePermissions(user, targetModule);
    return {
      ...check,
      loading: false,
    };
  }, [user, targetModule, isPlatformOwner, loading]);
}

/**
 * Visual restriction fallback screen when user lacks the license/subscription.
 */
export function LicenseRestrictedNotice({ moduleDef, detail, reason }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const title = moduleDef?.displayName || 'Module';
  const accessiblePath = firstAccessiblePath(user) || '/dashboard';
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center p-6 text-slate-800">
      <div className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-slate-200 bg-white p-8 shadow-xl">
        <div
          className="absolute -right-16 -top-16 h-36 w-36 rounded-full opacity-10 blur-xl"
          style={{ backgroundColor: moduleDef?.themeColor || '#2563EB' }}
        />
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-8 ring-amber-50/50">
            <Lock size={22} />
          </div>
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Subscription & License Required
            </span>
            <h2 className="text-xl font-black text-slate-900">{title} Workspace Restricted</h2>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          {detail || `Your organization does not have an active subscription or license entitlement for ${title}.`}
        </p>

        {moduleDef?.description && (
          <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3.5 text-xs text-slate-500">
            <strong className="block font-semibold text-slate-700">{title} includes:</strong>
            {moduleDef.description}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
          <Button
            type="button"
            onClick={() => navigate(accessiblePath, { replace: true })}
            className="flex items-center gap-2 rounded-xl bg-slate-900 text-xs font-bold text-white hover:bg-slate-800"
          >
            <LayoutDashboard size={14} /> Go to Active Workspace
          </Button>

          {isAdmin && (
            <Link
              to="/admin-dashboard"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Admin Dashboard <ArrowRight size={13} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Route-gating Component for declarative route wrappers.
 *
 * Usage:
 * <LicenseRouteGate module="Taskosphere">
 *   <Tasks />
 * </LicenseRouteGate>
 *
 * <LicenseRouteGate module="Accounting">
 *   <FinixDashboard />
 * </LicenseRouteGate>
 *
 * <LicenseRouteGate module="Records">
 *   <RecordsDashboard />
 * </LicenseRouteGate>
 */
export function LicenseRouteGate({
  module,
  children,
  fallback = null,
  redirectTo = null,
}) {
  const { user, isPlatformOwner, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-[30vh] w-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (isPlatformOwner || matrixIsPlatformOwner(user)) {
    return children;
  }

  const check = checkLicensePermissions(user, module);

  if (check.allowed) {
    return children;
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  if (fallback) {
    return fallback;
  }

  return (
    <LicenseRestrictedNotice
      moduleDef={check.moduleDef}
      detail={check.detail}
      reason={check.reason}
    />
  );
}

// Named alias for convenience
export const SubscriptionRouteGate = LicenseRouteGate;

export default LicenseRouteGate;
