// Permission Matrix: canonical governance UI shared with Users permissions.
// PermissionMatrix.jsx — Admin → Permission Matrix.
// Uses the same Access Governance module tree as Users → Permissions and exposes
// the same six permission scopes: Modules, View, Operations, Edit, Cross-User, Clients.
// The admin page edits the same /users/{id}/permissions payload used by Users.jsx.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ShieldCheck, Users as UsersIcon, KeyRound, UserCog,
  Zap, Eye, Settings, Pencil, Briefcase, Layers, Fingerprint, FileText,
  Calendar, BarChart2, CheckCircle, Activity, Target, Star, User as UserIcon,
  Receipt, MessageSquare, MessageCircle, Shield, ArrowUpRight, Clock, Bell,
  Download, Trash2, XCircle, Inbox, MapPin, Edit, Check, X, Loader2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import {
  PageShell, PageBanner, StatRow, LoadingState, EmptyState, HUB_COLORS,
} from '@/components/ui/PageKit';
import AccessGovernancePanel, { GovCard } from '@/components/governance/AccessGovernancePanel';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_TEMPLATE_ROLES } from '@/lib/permissionTemplates';
import { GLOBAL_PERMS, OPS_PERMS, EDIT_PERMS, permTabs as PERM_TABS, MODULE_PERM_KEYS } from '@/lib/permissionCatalog';

const TXT = { overflowWrap: 'break-word', wordBreak: 'normal' };
const PERMISSION_ICON_MAP = {
  Layers, Briefcase, Fingerprint, FileText, Calendar, BarChart2, CheckCircle,
  Activity, Target, UsersIcon, Eye, Star, UserIcon, ShieldCheck, Receipt,
  MessageSquare, MessageCircle, ArrowUpRight, Clock, Edit, Bell, Download,
  Settings, Trash2, XCircle, Inbox, MapPin, Pencil, Zap,
};

const initialOf = (u) => (u.full_name || u.email || '?').trim().charAt(0).toUpperCase();

function PermissionMatrixSummary({ permissions }) {
  const moduleKeys = [
    'can_access_taskosphere', 'can_access_finix', 'can_access_aiweave',
    'can_access_compliance', 'can_access_records', 'can_access_proposals',
    'can_access_people_matrix',
    'can_manage_invoices', 'can_view_sale', 'can_view_purchase', 'can_view_bank',
    'can_view_chart_of_accounts', 'can_manage_chart_of_accounts',
    'can_view_journal_entries', 'can_post_journal_entries', 'can_match_bank',
    'can_view_accounting_reports', 'can_view_passwords', 'can_edit_passwords',
    'can_view_gst_reconciliation', 'can_view_trademark_sphere', 'can_view_client_portal',
    'can_reset_client_passwords', 'can_manage_whatsapp', 'can_create_quotations',
    'can_view_mis_report', 'can_manage_mis_report', 'can_view_salary_slips',
    'can_manage_salary_slips', 'can_view_recruitment', 'can_manage_recruitment',
  ];
  const all = [...GLOBAL_PERMS, ...OPS_PERMS, ...EDIT_PERMS];
  const granted = all.filter((p) => permissions?.[p.key]).length +
    MODULE_PERM_KEYS.filter((key) => permissions?.[key]).length;
  const total = all.length + MODULE_PERM_KEYS.length;
  const pct = total ? Math.round((granted / total) * 100) : 0;
  return (
    <GovCard icon={ShieldCheck} title="Permission Coverage" badge={`${granted}/${total}`} color={HUB_COLORS.emeraldGreen}>
      <div className="p-4 flex flex-wrap items-center gap-4">
        <div className="relative w-16 h-16 shrink-0">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" className="text-slate-200 dark:text-slate-700" stroke="currentColor" strokeWidth="5" />
            <circle cx="24" cy="24" r="20" fill="none" className="text-emerald-500" stroke="currentColor" strokeWidth="5"
              strokeDasharray={2 * Math.PI * 20}
              strokeDashoffset={2 * Math.PI * 20 * (1 - pct / 100)}
              strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-black text-slate-800 dark:text-slate-100">{pct}%</span>
        </div>
        <div className="min-w-[220px] flex-1">
          <p className="text-lg font-bold text-slate-900 dark:text-white">Permission Coverage</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">{granted} of {total} permissions enabled</p>
          <div className="mt-2 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
            <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </GovCard>
  );
}

function PermToggleRow({ item, permissions, setPermissions, disabled }) {
  const Icon = PERMISSION_ICON_MAP[item.icon] || FileText;
  const enabled = permissions?.[item.key] === true;
  return (
    <div className="flex items-start gap-3 p-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800/60">
      <Checkbox
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(checked) => setPermissions((prev) => ({ ...prev, [item.key]: !!checked }))}
        className="mt-0.5 h-[18px] w-[18px]"
        aria-label={item.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[#1F6FB2] shrink-0" />
          <span style={TXT} className="text-sm font-semibold text-slate-800 dark:text-slate-100">{item.label}</span>
          {enabled && <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Enabled</span>}
        </div>
        <p style={TXT} className="text-[11px] mt-1 text-slate-500 dark:text-slate-400">{item.desc}</p>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, color, count }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </span>
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</h3>
      </div>
      {count !== undefined && <span className="text-xs font-bold text-slate-400">{count} enabled</span>}
    </div>
  );
}

function CrossUserTab({ permissions, users, selectedUserId, setPermissions, isDark, disabled }) {
  const sections = [
    { key: 'view_other_tasks', label: 'Tasks', icon: Layers },
    { key: 'view_other_attendance', label: 'Attendance', icon: Clock },
    { key: 'view_other_reports', label: 'Reports', icon: BarChart2 },
    { key: 'view_other_todos', label: 'Todos', icon: CheckCircle },
    { key: 'view_other_activity', label: 'Activity', icon: Activity },
    { key: 'view_other_visits', label: 'Visits', icon: MapPin },
  ];
  return (
    <div className="space-y-4">
      <SectionHeader icon={UsersIcon} title="Cross-User Data Access" color={HUB_COLORS.emeraldGreen} />
      <p className="text-sm text-slate-500 dark:text-slate-400">Select users whose data this user can view. Cross-visibility is explicit — only selected users will be visible.</p>
      {sections.map((section) => {
        const Icon = section.icon;
        const selected = permissions?.[section.key] || [];
        return (
          <GovCard key={section.key} icon={Icon} title={section.label} badge={selected.length} color={HUB_COLORS.emeraldGreen}>
            <div className="p-3 flex flex-wrap gap-2">
              {users.filter((u) => u.id !== selectedUserId).map((u) => {
                const active = selected.includes(u.id);
                return (
                  <button key={u.id} type="button" disabled={disabled}
                    onClick={() => setPermissions((prev) => ({ ...prev, [section.key]: active ? selected.filter((id) => id !== u.id) : [...selected, u.id] }))}
                    className="px-3 py-2 text-xs font-semibold border rounded-xl transition-all disabled:opacity-50"
                    style={active ? { background: HUB_COLORS.emeraldGreen, color: '#fff', borderColor: HUB_COLORS.emeraldGreen } : isDark ? { background: '#1e293b', color: '#94a3b8', borderColor: '#334155' } : { background: '#f8fafc', color: '#475569', borderColor: '#e2e8f0' }}>
                    {active ? '✓ ' : ''}{u.full_name || u.email}
                  </button>
                );
              })}
            </div>
          </GovCard>
        );
      })}
    </div>
  );
}

function ClientsTab({ permissions, clients, setPermissions, search, setSearch, disabled }) {
  const assigned = permissions?.assigned_clients || [];
  const q = search.trim().toLowerCase();
  const filtered = clients.filter((c) => !q || `${c.company_name || ''} ${c.phone || ''} ${c.email || ''}`.toLowerCase().includes(q));
  const allSelected = filtered.length > 0 && filtered.every((c) => assigned.includes(c.id));
  const toggleAll = () => setPermissions((prev) => {
    const current = prev.assigned_clients || [];
    if (allSelected) {
      const remove = new Set(filtered.map((c) => c.id));
      return { ...prev, assigned_clients: current.filter((id) => !remove.has(id)) };
    }
    return { ...prev, assigned_clients: [...new Set([...current, ...filtered.map((c) => c.id)])] };
  });
  return (
    <div className="space-y-4">
      <SectionHeader icon={Briefcase} title="Client Portfolio" color="#0F766E" count={assigned.length} />
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 min-w-[220px]" />
        <Button type="button" variant="outline" onClick={toggleAll} disabled={disabled || !filtered.length}>
          {allSelected ? <><X className="h-3.5 w-3.5" /> Deselect filtered</> : <><Check className="h-3.5 w-3.5" /> Select filtered</>}
        </Button>
        {assigned.length > 0 && <Button type="button" variant="outline" onClick={() => setPermissions((p) => ({ ...p, assigned_clients: [] }))} disabled={disabled}>Clear All</Button>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {filtered.map((client) => {
          const active = assigned.includes(client.id);
          return (
            <button key={client.id} type="button" disabled={disabled}
              onClick={() => setPermissions((prev) => ({ ...prev, assigned_clients: active ? (prev.assigned_clients || []).filter((id) => id !== client.id) : [...new Set([...(prev.assigned_clients || []), client.id])] }))}
              className={`text-left p-3 border rounded-xl transition-all ${active ? 'border-teal-400 bg-teal-50 dark:bg-teal-950/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60'} disabled:opacity-50`}>
              <div className="flex items-center gap-2">
                <Checkbox checked={active} readOnly className="h-[18px] w-[18px]" />
                <span style={TXT} className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{client.company_name || client.name || client.email || 'Unnamed client'}</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1 ml-6">{client.client_type || 'Client'}</p>
            </button>
          );
        })}
        {!filtered.length && <p className="text-sm text-slate-400 py-6 text-center col-span-full">No clients match the search.</p>}
      </div>
    </div>
  );
}

export default function PermissionMatrix() {
  const isDark = useDark();
  const [users, setUsers] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [search, setSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissions, setPermissions] = useState({});
  const [baseline, setBaseline] = useState({});
  const [activePermTab, setActivePermTab] = useState('modules');
  const [saving, setSaving] = useState(false);
  const [permissionTemplates] = useState(DEFAULT_ROLE_PERMISSIONS);

  // Refs for the six always-visible governance sections. These power the
  // "Quick Reset" row's tab strip below as an in-page jump-to nav — every
  // section stays rendered on screen at once (no tab hides a category); the
  // buttons just scroll the already-visible section into view.
  const modulesSectionRef = useRef(null);
  const viewSectionRef = useRef(null);
  const opsSectionRef = useRef(null);
  const editSectionRef = useRef(null);
  const crossSectionRef = useRef(null);
  const clientsSectionRef = useRef(null);
  const sectionRefsById = {
    modules: modulesSectionRef,
    view: viewSectionRef,
    ops: opsSectionRef,
    edit: editSectionRef,
    cross: crossSectionRef,
    clients: clientsSectionRef,
  };
  const jumpToSection = (id) => {
    setActivePermTab(id);
    sectionRefsById[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    (async () => {
      try {
        const [{ data: userData }, { data: clientData }] = await Promise.all([
          api.get('/users'),
          api.get('/clients'),
        ]);
        const list = Array.isArray(userData) ? userData : userData?.users || [];
        setUsers(list);
        setClients(Array.isArray(clientData) ? clientData : clientData?.data || []);
        if (list.length) setSelectedUserId(list[0].id);
      } catch {
        // Keep user loading resilient if clients endpoint is unavailable.
        try {
          const { data } = await api.get('/users');
          const list = Array.isArray(data) ? data : data?.users || [];
          setUsers(list);
          if (list.length) setSelectedUserId(list[0].id);
        } catch {
          toast.error('Could not load users');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedUserId) return;
    let alive = true;
    setPermissionsLoading(true);
    (async () => {
      try {
        const { data } = await api.get(`/users/${selectedUserId}/permissions`);
        if (!alive) return;
        const next = data || {};
        setPermissions(next);
        setBaseline(next);
        setActivePermTab('modules');
      } catch {
        if (alive) toast.error('Could not load this user\'s permissions');
      } finally {
        if (alive) setPermissionsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selectedUserId]);

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const isAdminUser = (selectedUser?.role || '').toLowerCase() === 'admin';

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => `${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(q));
  }, [users, search]);

  const adminCount = users.filter((u) => (u.role || '').toLowerCase() === 'admin').length;
  const editingName = selectedUser ? (selectedUser.full_name || selectedUser.email) : '—';

  const changes = useMemo(() => {
    const keys = new Set([...Object.keys(permissions || {}), ...Object.keys(baseline || {})]);
    let count = 0;
    keys.forEach((key) => {
      const a = permissions?.[key];
      const b = baseline?.[key];
      if (Array.isArray(a) || Array.isArray(b)) {
        const aa = Array.isArray(a) ? [...a].sort() : [];
        const bb = Array.isArray(b) ? [...b].sort() : [];
        if (JSON.stringify(aa) !== JSON.stringify(bb)) count += 1;
      } else if ((a ?? false) !== (b ?? false)) count += 1;
    });
    return count;
  }, [permissions, baseline]);

  const handleSave = async () => {
    if (!selectedUserId || saving) return;
    setSaving(true);
    try {
      await api.put(`/users/${selectedUserId}/permissions`, permissions);
      setBaseline(permissions);
      toast.success('Permissions updated');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save permissions');
    } finally {
      setSaving(false);
    }
  };

  const isEditingDisabled = false;

  const applyPermissionTemplate = (role) => {
    const template = permissionTemplates?.[role] || DEFAULT_ROLE_PERMISSIONS?.[role] || {};
    setPermissions({ ...template });
    toast.info(`Reset to ${role} template — click Save changes to apply`);
  };

  return (
    <PageShell>
      <PageBanner
        icon={ShieldCheck}
        eyebrow="Admin"
        title="Permission Governance"
        subtitle="Module → Page → Action access, per user. The same permission scopes used in Users are available here."
      />

      <StatRow
        columns={3}
        items={[
          { icon: UsersIcon, label: 'Team members', value: users.length, color: HUB_COLORS.mediumBlue },
          { icon: ShieldCheck, label: 'Admins (unrestricted)', value: adminCount, color: HUB_COLORS.emeraldGreen },
          { icon: UserCog, label: 'Editing', value: <span className="block truncate max-w-full" title={editingName}>{editingName}</span>, color: '#7C3AED' },
        ]}
      />

      {loading ? (
        <LoadingState label="Loading permission matrix…" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] gap-5 items-start min-w-0">
          <GovCard icon={UsersIcon} title="Users" badge={filteredUsers.length} className="w-full lg:sticky lg:top-2" bodyClassName="p-3 space-y-3">
            <div className="relative w-full min-w-0">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <Input className="pl-8" placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="w-full min-w-0 space-y-1 max-h-[45vh] lg:max-h-[60vh] overflow-y-auto overflow-x-hidden">
              {filteredUsers.length === 0 && <p style={TXT} className="text-xs text-slate-400 py-6 text-center">No users match &ldquo;{search}&rdquo;.</p>}
              {filteredUsers.map((u) => {
                const active = u.id === selectedUserId;
                const admin = (u.role || '').toLowerCase() === 'admin';
                return (
                  <button key={u.id} type="button" onClick={() => setSelectedUserId(u.id)} title={u.email || undefined} aria-pressed={active}
                    className={`w-full min-w-0 text-left px-2.5 py-2 flex items-center gap-3 border-l-[3px] cursor-pointer transition-colors ${active ? 'border-[#1F6FB2] bg-[#1F6FB2]/10' : `border-transparent ${isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-100'}`}`}>
                    <span className="flex items-center justify-center w-8 h-8 shrink-0 text-xs font-bold text-white" style={{ background: `linear-gradient(135deg, ${HUB_COLORS.deepBlue}, ${HUB_COLORS.mediumBlue})` }}>{initialOf(u)}</span>
                    <span className="min-w-0 flex-1">
                      <span style={TXT} className={`block truncate text-sm ${active ? 'font-bold' : 'font-semibold'} ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{u.full_name || u.email}</span>
                      <span style={TXT} className="block truncate text-[11px] text-slate-400 capitalize">{u.role || 'user'}</span>
                    </span>
                    {admin && <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </GovCard>

          <div className="w-full min-w-0 max-w-full space-y-4">
            {!selectedUserId ? (
              <GovCard icon={KeyRound} title="Access Governance">
                <EmptyState icon={KeyRound} title="Pick a user" hint="Select someone on the left to review and change what they can reach." />
              </GovCard>
            ) : permissionsLoading ? (
              <LoadingState label="Loading access governance…" />
            ) : (
              <>
                <PermissionMatrixSummary permissions={permissions} />
                <div className="w-full min-w-0 max-w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Quick Reset:</span>
                    {PERMISSION_TEMPLATE_ROLES.map((role) => (
                      <button
                        key={role}
                        type="button"
                        onClick={() => applyPermissionTemplate(role)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all hover:shadow-sm capitalize"
                      >
                        {role === 'admin' ? 'Admin' : role === 'manager' ? 'Manager' : 'Staff'} Template
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-1.5 w-full min-w-0">
                    {PERM_TABS.map((tab) => {
                      const TabIcon = PERMISSION_ICON_MAP[tab.icon] || FileText;
                      const active = activePermTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActivePermTab(tab.id)}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold text-xs transition-all whitespace-nowrap ${
                            active
                              ? 'text-white shadow-md'
                              : isDark
                                ? 'bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-200 hover:border-slate-600'
                                : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
                          }`}
                          style={active ? { background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' } : {}}
                        >
                          <TabIcon className="h-3.5 w-3.5 shrink-0" />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 mt-2 border-t border-slate-100 dark:border-slate-700">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                      <span style={TXT}>
                        Editing <strong className="text-slate-700 dark:text-slate-200">{editingName}</strong>
                      </span>
                      {changes > 0 && <span className="font-bold text-amber-600">{changes} unsaved</span>}
                    </div>
                    <Button type="button" onClick={handleSave} disabled={saving || changes === 0} className="whitespace-nowrap">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      Save Permissions
                    </Button>
                  </div>
                </div>

                {activePermTab === 'modules' && (
                  <div ref={modulesSectionRef} className="scroll-mt-4">
                    <GovCard icon={Zap} title="Modules — Page — Action Governance" badge="Complete" color={HUB_COLORS.mediumBlue} bodyClassName="p-3">
                      <AccessGovernancePanel
                        key={`modules-${selectedUserId}`}
                        userId={selectedUserId}
                        value={permissions}
                        onChange={setPermissions}
                        isAdminUser={isAdminUser}
                        showSave={false}
                      />
                    </GovCard>
                  </div>
                )}

                {activePermTab === 'view' && (
                  <div ref={viewSectionRef} className="scroll-mt-4">
                    <GovCard icon={Eye} title="View Permissions" badge={GLOBAL_PERMS.filter((p) => permissions[p.key]).length} color={HUB_COLORS.mediumBlue}>
                      <div className="p-3 space-y-2">
                        {GLOBAL_PERMS.map((item) => <PermToggleRow key={item.key} item={item} permissions={permissions} setPermissions={setPermissions} disabled={isEditingDisabled} />)}
                      </div>
                    </GovCard>
                  </div>
                )}

                {activePermTab === 'ops' && (
                  <div ref={opsSectionRef} className="scroll-mt-4">
                    <GovCard icon={Settings} title="Operations Permissions" badge={OPS_PERMS.filter((p) => permissions[p.key]).length} color="#7C3AED">
                      <div className="p-3 space-y-2">
                        {OPS_PERMS.map((item) => <PermToggleRow key={item.key} item={item} permissions={permissions} setPermissions={setPermissions} disabled={isEditingDisabled} />)}
                      </div>
                    </GovCard>
                  </div>
                )}

                {activePermTab === 'edit' && (
                  <div ref={editSectionRef} className="scroll-mt-4">
                    <GovCard icon={Pencil} title="Edit Permissions" badge={EDIT_PERMS.filter((p) => permissions[p.key]).length} color="#F59E0B">
                      <div className="p-3 space-y-2">
                        {EDIT_PERMS.map((item) => <PermToggleRow key={item.key} item={item} permissions={permissions} setPermissions={setPermissions} disabled={isEditingDisabled} />)}
                      </div>
                    </GovCard>
                  </div>
                )}

                {activePermTab === 'cross' && (
                  <div ref={crossSectionRef} className="scroll-mt-4">
                    <GovCard icon={UsersIcon} title="Cross-User Permissions" badge="User Data Access" color={HUB_COLORS.emeraldGreen}>
                      <div className="p-3">
                        <CrossUserTab permissions={permissions} users={users} selectedUserId={selectedUserId} setPermissions={setPermissions} isDark={isDark} disabled={isEditingDisabled} />
                      </div>
                    </GovCard>
                  </div>
                )}

                {activePermTab === 'clients' && (
                  <div ref={clientsSectionRef} className="scroll-mt-4">
                    <GovCard icon={Briefcase} title="Client Permissions" badge={(permissions?.assigned_clients || []).length} color="#0F766E">
                      <div className="p-3">
                        <ClientsTab permissions={permissions} clients={clients} setPermissions={setPermissions} search={clientSearch} setSearch={setClientSearch} disabled={isEditingDisabled} />
                      </div>
                    </GovCard>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
