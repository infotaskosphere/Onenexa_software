import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Loader2 } from 'lucide-react';

// Shared brand palette — mirrors DashboardLayout.jsx COLORS so every
// section hub page (Compliance / Records / Client Proposals) reads as
// part of the same design system as the sidebar + main Dashboard.
export const HUB_COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen:   '#5CCB5F',
};

/**
 * HubBanner — the big gradient header at the top of a section hub page,
 * matching the style of the main Dashboard's "Good Afternoon" banner.
 */
export function HubBanner({ icon: Icon, eyebrow, title, subtitle, isDark, stats = [] }) {
  const duplicateHeaderStats = {
    LeadSense: new Set(['Active Leads', 'Pending Quotes', 'Win Rate']),
    Records: new Set(['Clients', 'DSC Records', 'Documents', 'Pending Approval']),
    CompliGenie: new Set(['Overdue']),
  };
  const hiddenStats = duplicateHeaderStats[eyebrow] || new Set();
  const visibleStats = stats.filter((s) => !hiddenStats.has(s.label));

  return (
    <div
      className="relative overflow-hidden rounded-3xl p-6 sm:p-8 mb-6 shadow-lg"
      style={{ background: `linear-gradient(135deg, ${HUB_COLORS.deepBlue} 0%, ${HUB_COLORS.mediumBlue} 100%)` }}
    >
      <div className="absolute -right-10 -top-10 w-56 h-56 rounded-full bg-white/5" />
      <div className="absolute -right-4 bottom-0 w-32 h-32 rounded-full bg-white/5" />
      <div className="relative flex flex-col lg:flex-col xl:flex-row lg:items-start xl:items-center lg:justify-between gap-5 xl:gap-6 min-w-0">
        <div>
          {eyebrow && (
            <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-blue-200 mb-2">
              {Icon && <Icon className="h-3.5 w-3.5" />} {eyebrow}
            </p>
          )}
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">{title}</h1>
          {subtitle && <p className="text-blue-100/80 text-sm mt-1.5 max-w-xl">{subtitle}</p>}
        </div>

        {visibleStats.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 w-full xl:w-auto min-w-0">
            {visibleStats.map((s, i) => (
              <div
                key={i}
                className="min-w-0 w-full xl:min-w-[110px] rounded-xl px-3 sm:px-4 py-3 bg-white/12 backdrop-blur-sm overflow-hidden shadow-sm border-0"
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-blue-100/70 truncate">{s.label}</p>
                <p className="text-xl font-extrabold text-white mt-0.5">
                  {s.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : s.value}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * StatCard — small KPI tile used in the stat-row under the banner.
 */
export function StatCard({ icon: Icon, label, value, loading, color, isDark }) {
  return (
    <div
      className={`rounded-xl border p-4 flex items-center gap-3 transition-colors ${
        isDark ? 'bg-slate-800/80 text-slate-100' : 'bg-white text-slate-800 shadow-sm'
      }`}
      style={{
        borderColor: isDark ? '#334155' : '#e2e8f0',
      }}
    >
      <div className="p-2.5 rounded-lg shrink-0" style={{ background: `${color}18` }}>
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
        <p className={`text-lg font-extrabold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : value}
        </p>
      </div>
    </div>
  );
}

/**
 * LinkCard — clickable module tile that routes into one of the pages
 * belonging to this section (e.g. Compliance Tracker, GST Reconciliation…).
 */
export function LinkCard({ icon: Icon, label, description, path, color, isDark, badge, stats, statsLoading }) {
  const navigate = useNavigate();
  return (
    <motion.button
      onClick={() => navigate(path)}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      className={`group text-left rounded-xl border p-5 flex flex-col gap-3 transition-colors cursor-pointer ${
        isDark
          ? 'bg-slate-800/80 hover:border-slate-600'
          : 'bg-white shadow-sm hover:border-slate-300'
      }`}
      style={{
        borderColor: isDark ? '#334155' : '#e2e8f0',
      }}
    >
      <div className="flex items-start justify-between">
        <div className="p-2.5 rounded-xl" style={{ background: `${color}18` }}>
          <Icon className="h-5 w-5" style={{ color }} />
        </div>
        {badge !== undefined && badge !== null && (
          <span
            className="text-[10px] font-extrabold px-2 py-0.5 rounded-full"
            style={{ background: `${color}18`, color }}
          >
            {badge}
          </span>
        )}
      </div>
      <div>
        <h3 className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{label}</h3>
        {description && (
          <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {description}
          </p>
        )}
      </div>

      {/* Summary strip — quick-glance numbers pulled live from that module,
          so the card tells you what's inside before you even open it. */}
      {Array.isArray(stats) && stats.length > 0 && (
        <div
          className={`grid gap-2 rounded-xl border px-3 py-2 ${
            isDark ? 'bg-slate-900/40 border-slate-700/60' : 'bg-slate-50 border-slate-100'
          }`}
          style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0,1fr))` }}
        >
          {stats.map((s, i) => (
            <div key={i} className="min-w-0 text-center">
              <p className={`text-sm font-extrabold leading-tight truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                {statsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin mx-auto" style={{ color }} /> : s.value}
              </p>
              <p className={`text-[9.5px] font-semibold uppercase tracking-wide truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {s.label}
              </p>
            </div>
          ))}
        </div>
      )}

      <div
        className={`flex items-center gap-1 text-xs font-bold mt-auto pt-1 ${
          isDark ? 'text-blue-400' : 'text-blue-600'
        }`}
      >
        Open <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </motion.button>
  );
}

/**
 * Best-effort helper to pull a "count" out of whatever shape an endpoint
 * returns — a raw array, a paginated wrapper, or a summary object with a
 * count/total field. Keeps the hub pages resilient to backend variations.
 */
export function extractCount(data, field) {
  if (data == null) return null;
  if (field && typeof data === 'object' && data[field] != null) return data[field];
  if (Array.isArray(data)) return data.length;
  if (Array.isArray(data?.items)) return data.items.length;
  if (Array.isArray(data?.results)) return data.results.length;
  if (Array.isArray(data?.data)) return data.data.length;
  if (typeof data?.total === 'number') return data.total;
  if (typeof data?.count === 'number') return data.count;
  return null;
}