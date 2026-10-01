// RecordsDashboard.jsx — Records ▸ Dashboard
// A data-dense overview of everything held in the Records module: clients,
// DSC certificates, physical documents and vault credentials — plus the
// actionable slices (expiring DSCs, documents out of office, clients waiting
// for admin approval) instead of just a row of counters.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText, Users, KeyRound, Archive, AlertTriangle, Clock, UserPlus,
  ShieldCheck, TrendingUp, MapPin, ArrowRight, Loader2, CheckCircle2,
} from 'lucide-react';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner, StatCard, LinkCard, HUB_COLORS, extractCount } from '@/components/SectionHub.jsx';

const MODULES = [
  {
    path: '/dsc', icon: FileText, label: 'DSC Register',
    description: 'Track digital signature certificates, expiry dates and custodians.',
    color: HUB_COLORS.mediumBlue, permission: 'can_view_all_dsc', countKey: 'dsc',
  },
  {
    path: '/documents', icon: Archive, label: 'Document Register',
    description: 'Central register of client documents received and returned.',
    color: '#F59E0B', permission: 'can_view_documents', countKey: 'documents',
  },
  {
    path: '/clients', icon: Users, label: 'Clients',
    description: 'Master list of every client, their groups, contacts and status.',
    color: HUB_COLORS.emeraldGreen, countKey: 'clients',
  },
  {
    path: '/passwords', icon: KeyRound, label: 'Password Vault',
    description: 'Securely store and retrieve client portal credentials.',
    color: '#7C3AED', permission: 'can_view_passwords', countKey: 'passwords',
  },
  {
    path: '/client-approvals', icon: UserPlus, label: 'Client Approvals',
    description: 'New clients added by the team, waiting for an admin to approve them.',
    color: '#EC4899', countKey: 'pending',
  },
];

const daysLeft = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
};

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? String(d).slice(0, 10)
    : dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
};

/* ── Small building blocks ─────────────────────────────────────────────── */

function Panel({ title, subtitle, icon: Icon, color, isDark, action, onAction, children }) {
  return (
    <section
      className={`records-dashboard-panel ${isDark ? 'records-dashboard-panel-dark' : ''}`}
      style={{
        border: isDark ? '1px solid #334155' : '1px solid #e2e8f0',
        borderRadius: 0,
        backgroundColor: isDark ? '#1e293b' : '#ffffff'
      }}
    >
      <header
        className="records-dashboard-panel-header"
        style={{
          borderBottom: isDark ? '1px solid #334155' : '1px solid #e2e8f0',
          backgroundColor: isDark ? '#1e293b' : '#ffffff',
          borderRadius: 0
        }}
      >
        {Icon && (
          <div className="records-dashboard-panel-icon" style={{ background: `${color}18`, borderRadius: 0 }}>
            <Icon className="h-4 w-4" style={{ color }} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className={`records-dashboard-panel-title ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</h3>
          {subtitle && <p className={`records-dashboard-panel-subtitle ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{subtitle}</p>}
        </div>
        {action && (
          <button onClick={onAction} className="records-dashboard-panel-action">
            {action} <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </header>
      <div
        className="records-dashboard-panel-body"
        style={{
          backgroundColor: 'transparent',
          border: 0,
          borderRadius: 0
        }}
      >
        {children}
      </div>
    </section>
  );
}

function EmptyRow({ text, isDark }) {
  return (
    <p
      className={`records-dashboard-empty ${isDark ? 'records-dashboard-empty-dark text-slate-400' : 'text-slate-500'}`}
      style={{
        backgroundColor: 'transparent',
        border: 0,
        borderRadius: 0
      }}
    >
      {text}
    </p>
  );
}

function Bar({ label, value, max, color, isDark }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="records-dashboard-bar" style={{ backgroundColor: 'transparent', border: 0, borderRadius: 0 }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-semibold truncate pr-2 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</span>
        <span className="text-xs font-extrabold shrink-0" style={{ color }}>{value}</span>
      </div>
      <div className={`h-1.5 ${isDark ? 'bg-slate-700/80' : 'bg-slate-100'}`} style={{ borderRadius: 0 }}>
        <div className="h-1.5 transition-all" style={{ width: `${pct}%`, background: color, borderRadius: 0 }} />
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function RecordsDashboard() {
  const isDark = useDark();
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});
  const [dscList, setDscList] = useState([]);
  const [docList, setDocList] = useState([]);
  const [pendingList, setPendingList] = useState([]);

  const canSee = (m) => {
    if (!m.permission) return true;
    if (user?.role === 'admin') return true;
    return hasPermission(m.permission);
  };
  const visibleModules = MODULES.filter(canSee);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const passwordsCountRequest = api
        .get('/passwords/stats', { _silent: true })
        .catch(() =>
          api
            .get('/passwords', { params: { limit: 500 }, _silent: true })
            .catch(() => ({ data: null }))
        );

      const requests = {
        dsc:       api.get('/dsc', { params: { limit: 500 }, _silent: true }),
        documents: api.get('/documents', { _silent: true }),
        clients:   api.get('/clients', { params: { page: 1, page_size: 1 }, _silent: true }),
        passwords: passwordsCountRequest,
        pending:   api.get('/clients/pending', { _silent: true }),
      };
      const keys = Object.keys(requests);
      const results = await Promise.allSettled(keys.map((k) => requests[k]));
      if (cancelled) return;
      const next = {};
      const payloads = {};
      results.forEach((r, i) => {
        const key = keys[i];
        if (r.status === 'fulfilled') {
          const data = r.value?.data;
          payloads[key] = data;
          next[key] = extractCount(
            data,
            key === 'clients' || key === 'pending' || key === 'passwords' ? 'total' : undefined
          );
        } else {
          next[key] = null;
        }
      });
      const asArray = (d) => (Array.isArray(d) ? d : d?.items || d?.results || d?.data || []);
      setDscList(asArray(payloads.dsc));
      setDocList(asArray(payloads.documents));
      setPendingList(asArray(payloads.pending));
      setCounts(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const fmt = (v) => (v === null || v === undefined ? '—' : v);

  const dscInsight = useMemo(() => {
    const withDays = dscList
      .map((d) => ({ ...d, _days: daysLeft(d.expiry_date) }))
      .filter((d) => d._days !== null);
    const expired = withDays.filter((d) => d._days < 0);
    const expiring30 = withDays.filter((d) => d._days >= 0 && d._days <= 30);
    const expiring90 = withDays.filter((d) => d._days > 30 && d._days <= 90);
    const soon = [...expired, ...expiring30, ...expiring90]
      .sort((a, b) => a._days - b._days)
      .slice(0, 6);
    return { expired, expiring30, expiring90, soon, healthy: withDays.length - expired.length - expiring30.length };
  }, [dscList]);

  const docInsight = useMemo(() => {
    const byStatus = {};
    const byLocation = {};
    docList.forEach((d) => {
      const s = d.current_status || 'Unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
      const l = d.current_location || 'Unspecified';
      byLocation[l] = (byLocation[l] || 0) + 1;
    });
    const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const outside = docList.filter((d) => (d.current_status || '').toLowerCase().includes('out'));
    return { statuses: top(byStatus), locations: top(byLocation), outside, recent: docList.slice(0, 6) };
  }, [docList]);

  const stats = [
    { label: 'Clients', value: fmt(counts.clients), loading },
    { label: 'DSC Records', value: fmt(counts.dsc), loading },
    { label: 'Documents', value: fmt(counts.documents), loading },
    { label: 'Pending Approval', value: fmt(counts.pending ?? pendingList.length), loading },
  ];

  const maxStatus = Math.max(1, ...docInsight.statuses.map(([, v]) => v));
  const maxLoc = Math.max(1, ...docInsight.locations.map(([, v]) => v));
  const rowBase = `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
    isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'
  }`;

  return (
    <div className={`records-dashboard-root pb-4 ${isDark ? 'records-dashboard-root-dark' : ''}`}>
      <HubBanner
        icon={Archive}
        eyebrow="Records"
        title="Records Dashboard"
        subtitle="Everything you keep on file — clients, DSCs, documents and credentials — with the items that need attention first."
        isDark={isDark}
        stats={stats}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="DSC Expired" value={loading ? '' : dscInsight.expired.length} loading={loading} color="#EF4444" isDark={isDark} />
        <StatCard icon={Clock} label="DSC Expiring ≤30d" value={loading ? '' : dscInsight.expiring30.length} loading={loading} color="#F59E0B" isDark={isDark} />
        <StatCard icon={MapPin} label="Documents Out of Office" value={loading ? '' : docInsight.outside.length} loading={loading} color="#0EA5E9" isDark={isDark} />
        <StatCard icon={UserPlus} label="Clients Awaiting Approval" value={loading ? '' : (counts.pending ?? pendingList.length)} loading={loading} color="#EC4899" isDark={isDark} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Users} label="Clients" value={fmt(counts.clients)} loading={loading} color={HUB_COLORS.emeraldGreen} isDark={isDark} />
        <StatCard icon={FileText} label="DSC Records" value={fmt(counts.dsc)} loading={loading} color={HUB_COLORS.mediumBlue} isDark={isDark} />
        <StatCard icon={Archive} label="Documents" value={fmt(counts.documents)} loading={loading} color="#F59E0B" isDark={isDark} />
        <StatCard icon={KeyRound} label="Vault Credentials" value={fmt(counts.passwords)} loading={loading} color="#7C3AED" isDark={isDark} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <Panel title="DSCs needing attention" subtitle="Soonest expiry first" icon={AlertTriangle} color="#EF4444" isDark={isDark} action="DSC Register" onAction={() => navigate('/dsc')}>
          {loading ? (
            <EmptyRow text="Loading…" isDark={isDark} />
          ) : dscInsight.soon.length === 0 ? (
            <EmptyRow text="No certificates expiring in the next 90 days." isDark={isDark} />
          ) : (
            dscInsight.soon.map((d, i) => {
              const overdue = d._days < 0;
              const urgent = d._days >= 0 && d._days <= 30;
              const color = overdue ? '#EF4444' : urgent ? '#F59E0B' : '#0EA5E9';
              return (
                <div key={d.id || i} className={rowBase}>
                  <div className="w-1.5 h-8 rounded-full shrink-0" style={{ background: color }} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{d.holder_name || 'Unnamed holder'}</p>
                    <p className="text-[11px] text-slate-500 truncate">{[d.client_name, d.certificate_type, fmtDate(d.expiry_date)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full shrink-0" style={{ background: `${color}18`, color }}>
                    {overdue ? `${Math.abs(d._days)}d overdue` : `${d._days}d left`}
                  </span>
                </div>
              );
            })
          )}
        </Panel>

        <Panel title="Recent documents" subtitle="Latest entries in the register" icon={Archive} color="#F59E0B" isDark={isDark} action="Document Register" onAction={() => navigate('/documents')}>
          {loading ? (
            <EmptyRow text="Loading…" isDark={isDark} />
          ) : docInsight.recent.length === 0 ? (
            <EmptyRow text="No documents recorded yet." isDark={isDark} />
          ) : (
            docInsight.recent.map((d, i) => (
              <div key={d.id || i} className={rowBase}>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: '#F59E0B18' }}><FileText className="h-3.5 w-3.5" style={{ color: '#F59E0B' }} /></div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{d.document_type || 'Document'}</p>
                  <p className="text-[11px] text-slate-500 truncate">{[d.holder_name, d.associated_with, d.current_location].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                {d.current_status && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-600'}`}>{d.current_status}</span>
                )}
              </div>
            ))
          )}
        </Panel>

        <Panel title="Clients awaiting approval" subtitle="Added by the team, pending admin sign-off" icon={UserPlus} color="#EC4899" isDark={isDark} action="Review" onAction={() => navigate('/client-approvals')}>
          {loading ? (
            <EmptyRow text="Loading…" isDark={isDark} />
          ) : pendingList.length === 0 ? (
            <div className="records-dashboard-approval-empty" style={{ backgroundColor: 'transparent', border: 0, borderRadius: 0 }}>
              <CheckCircle2 className="h-5 w-5 mx-auto mb-2 text-emerald-500" />
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>All clients are approved.</p>
            </div>
          ) : (
            pendingList.slice(0, 6).map((c, i) => (
              <div key={c.id || i} className={rowBase}>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: '#EC489918' }}><Users className="h-3.5 w-3.5" style={{ color: '#EC4899' }} /></div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{c.company_name || 'Unnamed client'}</p>
                  <p className="text-[11px] text-slate-500 truncate">{[c.client_type, fmtDate(c.created_at)].filter(Boolean).join(' · ')}</p>
                </div>
                <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full shrink-0 bg-amber-100 text-amber-700">Pending</span>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Panel title="Document status mix" subtitle="Where every registered document stands" icon={TrendingUp} color={HUB_COLORS.mediumBlue} isDark={isDark}>
          {docInsight.statuses.length === 0
            ? <EmptyRow text={loading ? 'Loading…' : 'No status data yet.'} isDark={isDark} />
            : docInsight.statuses.map(([label, value]) => <Bar key={label} label={label} value={value} max={maxStatus} color={HUB_COLORS.mediumBlue} isDark={isDark} />)}
        </Panel>
        <Panel title="Document locations" subtitle="Top physical locations in use" icon={MapPin} color="#0EA5E9" isDark={isDark}>
          {docInsight.locations.length === 0
            ? <EmptyRow text={loading ? 'Loading…' : 'No location data yet.'} isDark={isDark} />
            : docInsight.locations.map(([label, value]) => <Bar key={label} label={label} value={value} max={maxLoc} color="#0EA5E9" isDark={isDark} />)}
        </Panel>
        <Panel title="DSC health" subtitle="Certificate validity spread" icon={ShieldCheck} color={HUB_COLORS.emeraldGreen} isDark={isDark}>
          {loading ? (
            <EmptyRow text="Loading…" isDark={isDark} />
          ) : (
            <>
              <Bar label="Expired" value={dscInsight.expired.length} max={Math.max(1, dscList.length)} color="#EF4444" isDark={isDark} />
              <Bar label="Expiring within 30 days" value={dscInsight.expiring30.length} max={Math.max(1, dscList.length)} color="#F59E0B" isDark={isDark} />
              <Bar label="Expiring in 31–90 days" value={dscInsight.expiring90.length} max={Math.max(1, dscList.length)} color="#0EA5E9" isDark={isDark} />
              <Bar label="Valid beyond 90 days" value={Math.max(0, dscList.length - dscInsight.expired.length - dscInsight.expiring30.length - dscInsight.expiring90.length)} max={Math.max(1, dscList.length)} color={HUB_COLORS.emeraldGreen} isDark={isDark} />
            </>
          )}
        </Panel>
      </div>

      <h2 className={`text-sm font-extrabold uppercase tracking-widest mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Record Modules</h2>
      {visibleModules.length === 0 ? (
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>You don't have access to any record modules yet. Contact your admin to request access.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleModules.map((m) => <LinkCard key={m.path} {...m} badge={fmt(counts[m.countKey])} isDark={isDark} />)}
        </div>
      )}
    </div>
  );
}
