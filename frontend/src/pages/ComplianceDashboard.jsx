import React, { useEffect, useState } from 'react';
import {
  ShieldCheck, ArrowLeftRight, Shield, AlertTriangle, CalendarClock,
  CheckCircle2, Layers, ListChecks, FileBarChart2, Receipt, Landmark,
} from 'lucide-react';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner, StatCard, LinkCard, HUB_COLORS } from '@/components/SectionHub.jsx';

// Every module that lives inside the "CompliGenie" sidebar section. Each
// entry is only shown to users who hold the matching permission (admins
// always see everything) — same rule DashboardLayout's sidebar uses.
const MODULES = [
  {
    path: '/compliance', icon: ShieldCheck, label: 'Compliance Tracker',
    description: 'Track statutory filings, due dates and assignment status across every client.',
    color: HUB_COLORS.mediumBlue, permission: 'can_view_compliance',
  },
  {
    path: '/gst-reconciliation', icon: ArrowLeftRight, label: 'GST Sphere',
    description: 'Match GSTR-2B / purchase register data, Live GST Portal sync and resolve ITC mismatches.',
    color: HUB_COLORS.emeraldGreen, permission: 'can_view_gst_reconciliation',
  },
  {
    path: '/trademark-sphere', icon: Shield, label: 'Trademark Sphere',
    description: 'Run trademark class searches, view verdicts and manage bulk searches.',
    color: '#7C3AED', permission: 'can_view_trademark_sphere',
  },
  {
    path: '/roc-sphere', icon: Landmark, label: 'ROC Sphere',
    description: 'Company master data, board resolutions, meeting notices and ROC compliance checklists.',
    color: '#0D9488', permission: 'can_view_roc_sphere',
  },
  {
    path: '/mis-report', icon: FileBarChart2, label: 'MIS Report',
    description: 'Financial Dashboard, Receivables, Payables, Revenue, Expense and Profitability MIS per client.',
    color: '#0EA5E9', permission: 'can_view_mis_report',
  },
  {
    path: '/salary-slips', icon: Receipt, label: 'Salary Slip Generator',
    description: 'Generate and manage payslips for client companies’ employees, with a reusable employee master.',
    color: '#F59E0B', permission: 'can_view_salary_slips',
  },
];

export default function ComplianceDashboard() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);

  // Per-module quick-glance stats, keyed by path. Each module's card shows
  // whatever lands here once its (independent, best-effort) fetch resolves.
  const [moduleStats, setModuleStats] = useState({});
  const [moduleStatsLoading, setModuleStatsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/compliance/dashboard/summary', { _silent: true });
        if (!cancelled) setSummary(data);
      } catch {
        /* module may not be enabled for this user — hub still renders */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Pull a lightweight summary from each compliance module so its card can
  // show real numbers instead of just a description. Every call is fired in
  // parallel and fails silently (a module the user can't access, or one
  // that's simply offline, just won't show a stats strip on its card).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setModuleStatsLoading(true);
      const [gst, tm, roc, mis, salary] = await Promise.allSettled([
        api.get('/gst-reconciliation/dashboard-summary', { _silent: true }),
        // Trademark Sphere's stats route is mounted un-prefixed on the
        // backend (router prefix="" in trademark_sphere.py), so its real
        // path is just /api/stats rather than /api/trademark-sphere/stats.
        api.get('/stats', { _silent: true }),
        api.get('/roc-sphere/companies', { _silent: true }),
        api.get('/mis/clients', { _silent: true }),
        api.get('/compliance/salary-slips/dashboard-summary', { _silent: true }),
      ]);
      if (cancelled) return;

      const next = {};

      if (summary) {
        next['/compliance'] = [
          { label: 'Assignments', value: summary.total_assignments ?? 0 },
          { label: 'Filed', value: summary.completed_or_filed ?? 0 },
          { label: 'Overdue', value: summary.overdue ?? 0 },
        ];
      }

      if (gst.status === 'fulfilled' && gst.value?.data) {
        const d = gst.value.data;
        next['/gst-reconciliation'] = [
          { label: 'Sessions', value: d.total_sessions ?? 0 },
          { label: 'High Risk', value: d.total_high_risk_vendors ?? 0 },
          { label: 'Reversals', value: d.total_itc_reversals ?? 0 },
        ];
      }

      if (tm.status === 'fulfilled' && tm.value?.data) {
        const d = tm.value.data;
        next['/trademark-sphere'] = [
          { label: 'Total', value: d.total ?? 0 },
          { label: 'Registered', value: d.registered ?? 0 },
          { label: 'Expiring', value: d.expiring_soon ?? 0 },
        ];
      }

      if (roc.status === 'fulfilled' && Array.isArray(roc.value?.data)) {
        next['/roc-sphere'] = [
          { label: 'Companies', value: roc.value.data.length },
        ];
      }

      if (mis.status === 'fulfilled' && Array.isArray(mis.value?.data)) {
        next['/mis-report'] = [
          { label: 'Clients', value: mis.value.data.length },
        ];
      }

      if (salary.status === 'fulfilled' && salary.value?.data) {
        const d = salary.value.data;
        next['/salary-slips'] = [
          { label: 'Employees', value: d.total_employees ?? 0 },
          { label: 'Slips', value: d.total_slips ?? 0 },
          { label: 'This Month', value: d.slips_this_month ?? 0 },
        ];
      }

      setModuleStats(next);
      setModuleStatsLoading(false);
    })();
    return () => { cancelled = true; };
    // Re-run once `summary` (the Compliance Tracker's own numbers) lands too,
    // so its card's stats strip fills in alongside the others.
  }, [summary]);

  const canSee = (m) => {
    if (!m.permission) return true;
    if (user?.role === 'admin') return true;
    return hasPermission(m.permission);
  };
  const visibleModules = MODULES.filter(canSee);

  const stats = [
    { label: 'Compliance Types', value: summary?.total_compliance_types ?? '—', loading },
    { label: 'Overall Filed', value: summary ? `${summary.overall_pct}%` : '—', loading },
    { label: 'Overdue', value: summary?.overdue ?? '—', loading },
  ];

  return (
    <div>
      <HubBanner
        icon={ShieldCheck}
        eyebrow="CompliGenie"
        title="CompliGenie Dashboard"
        subtitle="A single hub for statutory tracking, GST reconciliation and trademark monitoring."
        isDark={isDark}
        stats={stats}
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatCard icon={ListChecks} label="Assignments" value={summary?.total_assignments ?? '—'} loading={loading} color={HUB_COLORS.mediumBlue} isDark={isDark} />
        <StatCard icon={CheckCircle2} label="Completed / Filed" value={summary?.completed_or_filed ?? '—'} loading={loading} color={HUB_COLORS.emeraldGreen} isDark={isDark} />
        <StatCard icon={AlertTriangle} label="Overdue" value={summary?.overdue ?? '—'} loading={loading} color="#EF4444" isDark={isDark} />
        <StatCard icon={CalendarClock} label="Due This Month" value={summary?.due_this_month ?? '—'} loading={loading} color="#F59E0B" isDark={isDark} />
      </div>

      <h2 className={`text-sm font-extrabold uppercase tracking-widest mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        CompliGenie Modules
      </h2>
      {visibleModules.length === 0 ? (
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          You don't have access to any CompliGenie modules yet. Contact your admin to request access.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleModules.map((m) => (
            <LinkCard
              key={m.path}
              {...m}
              isDark={isDark}
              stats={moduleStats[m.path]}
              statsLoading={moduleStatsLoading && !moduleStats[m.path]}
            />
          ))}
        </div>
      )}

      {summary?.by_category && Object.keys(summary.by_category).length > 0 && (
        <div className="mt-8">
          <h2 className={`text-sm font-extrabold uppercase tracking-widest mb-3 flex items-center gap-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Layers className="h-4 w-4" /> By Category
          </h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.by_category).map(([cat, count]) => (
              <span
                key={cat}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                  isDark ? 'bg-slate-800/60 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                {cat}: <span style={{ color: HUB_COLORS.mediumBlue }}>{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
