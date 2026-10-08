import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, ShieldCheck, Activity, Settings, Database, Fingerprint, ScrollText, Phone, Building2, PackageCheck, UserCheck, FileClock, BarChart3 } from 'lucide-react';
import useDark from '@/hooks/useDark';
import api from '@/lib/api';
import { canAccessPath, isCommercialTenant } from '@/lib/commercialPermissionMatrix';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner, LinkCard, HUB_COLORS } from '@/components/SectionHub.jsx';

const list = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};
const count = (data) => typeof data?.total === 'number' ? data.total : typeof data?.count === 'number' ? data.count : list(data).length;

function useAdminFacts() {
  return useQuery({
    queryKey: ['adminDashboardFacts'],
    queryFn: async () => {
      const results = await Promise.allSettled([
        api.get('/users', { _silent: true }),
        api.get('/companies/list', { _silent: true }),
        api.get('/role-admin/roles', { _silent: true }),
        api.get('/audit-logs', { _silent: true }),
        api.get('/auth/me', { _silent: true }),
      ]);
      const [u, c, r, a, me] = results;
      const users = u.status === 'fulfilled' ? list(u.value.data) : [];
      const companies = c.status === 'fulfilled' ? list(c.value.data) : [];
      const roles = r.status === 'fulfilled' ? list(r.value.data) : [];
      const user = me.status === 'fulfilled' ? me.value.data : null;
      const pendingUsers = users.filter(x => x?.status === 'pending_approval');
       const activeUsers = users.filter(x => x?.is_active !== false && x?.status !== 'inactive').length;
      const customRoles = roles.filter(x => x?.is_builtin === false).length;
      const licensedModules = [
        ['can_access_taskosphere', 'Taskosphere'], ['can_access_finix', 'Finix'], ['can_access_compliance', 'CompliGenie'],
        ['can_access_records', 'Records'], ['can_access_proposals', 'LeadSense'], ['can_access_people_matrix', 'People Matrix'],
      ].filter(([flag]) => user?.permissions?.[flag] === true).map(([, label]) => label);
      return {
        users, companies, roles, user, pendingUsers, activeUsers, customRoles, licensedModules,
        companiesCount: c.status === 'fulfilled' ? count(c.value.data) : null,
        auditCount: a.status === 'fulfilled' ? count(a.value.data) : null,
      };
    },
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}

function FactCard({ icon: Icon, label, value, detail, color, isDark }) {
  return <div className={`min-w-0 rounded-2xl border p-4 flex items-center gap-3 ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100 shadow-sm'}`}>
    <div className="p-2.5 rounded-xl shrink-0" style={{ background: `${color}18` }}><Icon className="h-5 w-5" style={{ color }} /></div>
    <div className="min-w-0"><p className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p><p className={`text-xl font-extrabold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{value}</p>{detail && <p className={`text-[10px] mt-0.5 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{detail}</p>}</div>
  </div>;
}

export default function AdminDashboard() {
  const isDark = useDark();
  const { user: authUser } = useAuth();
  const { data, isLoading, isError, refetch } = useAdminFacts();
  const user = authUser || data?.user;
  const companyName = user?.company_name || 'Current tenant';
  const scopeLabel = user?.company_id ? `${companyName} · license admin` : 'Platform administration';
  const links = [
    // People Matrix owns the dedicated Users page only when that module is licensed.
    // Without People Matrix, the same shared user master is available from Admin → Master Data.
    { path: '/users', icon: Users, label: 'Users', description: 'Manage users for this tenant. This shared user master remains available to the Licensee Admin regardless of purchased operational modules.', color: HUB_COLORS.mediumBlue },
    { path: '/permission-matrix', icon: ShieldCheck, label: 'Permission Matrix', description: 'Review module, page and action access.', color: HUB_COLORS.emeraldGreen },
    { path: '/task-audit', icon: ScrollText, label: 'Audit Logs', description: 'Review recorded changes and administrative activity.', color: '#F59E0B' },
    { path: '/settings/general', icon: Settings, label: 'Settings', description: 'Manage organisation-level configuration.', color: HUB_COLORS.deepBlue },
    { path: '/master-data', icon: Database, label: 'Master Data', description: 'Manage company profiles, clients and staff master records.', color: '#7C3AED' },
    { path: '/roles', icon: Fingerprint, label: 'Roles', description: 'Define roles and their default permission templates.', color: '#DB2777' },
    { path: '/staff-activity', icon: Activity, label: 'Team Activity', description: 'Monitor login sessions, productivity and desktop activity.', color: HUB_COLORS.lightGreen },
    { path: '/reports', icon: BarChart3, label: 'Reports', description: 'Performance rankings, attendance and workforce reports.', color: '#F59E0B' },
    { path: '/contact-details', icon: Phone, label: 'Contact Details', description: 'Manage company and department contact information.', color: '#0EA5E9' },
  ];
  const visibleLinks = links.filter((link) => {
    if (!user || !isCommercialTenant(user)) return true;
    return canAccessPath(user, link.path);
  });
  return <div className="w-full min-w-0 p-3 sm:p-4 lg:p-6 space-y-4 sm:space-y-6">
    <HubBanner icon={ShieldCheck} eyebrow="Admin Control Plane" title="Administration" subtitle={`${scopeLabel}. Live figures below are read from the current tenant APIs; unavailable endpoints are not fabricated.`} isDark={isDark} />
    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
      <FactCard icon={Users} label="User accounts" value={isLoading ? '…' : data?.users.length ?? '—'} detail="Current tenant user directory" color={HUB_COLORS.mediumBlue} isDark={isDark} />
      <FactCard icon={UserCheck} label="Active users" value={isLoading ? '…' : data?.activeUsers ?? '—'} detail="Not marked inactive" color={HUB_COLORS.emeraldGreen} isDark={isDark} />
      <FactCard icon={Building2} label="Company profiles" value={isLoading ? '…' : data?.companiesCount ?? '—'} detail="Visible to this administrator" color="#7C3AED" isDark={isDark} />
      <FactCard icon={Fingerprint} label="Roles" value={isLoading ? '…' : data?.roles.length ?? '—'} detail={isLoading ? 'Loading…' : `${data?.customRoles ?? 0} custom`} color="#DB2777" isDark={isDark} />
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
      <div className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100 shadow-sm'}`}>
        <div className="flex items-center gap-3 mb-3"><PackageCheck className="h-5 w-5 text-emerald-500 shrink-0" /><div className="min-w-0"><h2 className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Licensed modules</h2><p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Modules currently enabled for this authenticated account.</p></div></div>
        {isLoading ? <p className="text-sm text-slate-400">Loading…</p> : data?.licensedModules?.length ? <div className="flex flex-wrap gap-2">{data.licensedModules.map(module => <span key={module} className="rounded-full px-3 py-1.5 text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{module}</span>)}</div> : <p className="text-sm text-slate-400">No licensed operational modules are reported for this account.</p>}
      </div>
      <div className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100 shadow-sm'}`}>
        <div className="flex items-center gap-3 mb-3"><FileClock className="h-5 w-5 text-amber-500 shrink-0" /><div className="min-w-0"><h2 className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Audit activity</h2><p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Count returned by the audit-log service for this tenant.</p></div></div>
        <p className={`text-3xl font-extrabold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{isLoading ? '…' : data?.auditCount ?? '—'}</p>
        {isError && <p className="text-[11px] text-amber-600 mt-1">Some dashboard endpoints could not be read. Unavailable values are shown as — rather than guessed.</p>}
        <button onClick={() => refetch()} className="mt-3 text-xs font-bold text-blue-600 hover:underline">Refresh facts</button>
      </div>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">{visibleLinks.map(link => <LinkCard key={link.path} {...link} isDark={isDark} />)}</div>
  </div>;
}