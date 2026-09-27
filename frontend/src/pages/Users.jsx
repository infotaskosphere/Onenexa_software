import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import api from '@/lib/api';
import { normalizeCompanies } from "@/lib/companies";
import { toast } from 'sonner';
import {
  Plus, Edit, Trash2, Shield, User as UserIcon, Settings, Eye,
  CheckCircle, XCircle, Search, Users as UsersIcon, Crown, Briefcase,
  Mail, Phone, Calendar, Camera, Clock, UserCheck, UserX,
  AlertCircle, KeyRound, Receipt, Target, Zap, Lock, ChevronRight, ChevronLeft,
  Activity, BarChart2, Star, Layers, FileText, Bell,
  Hash, ArrowUpRight, SlidersHorizontal, ShieldCheck,
  ShieldOff, Fingerprint, Download, Pencil, Inbox, X,
  Monitor, Wifi, WifiOff, RefreshCw, Radar, Loader2,
  Network, Save, ClipboardList, LayoutDashboard, AlertTriangle, MapPin, UserMinus, ArrowRight,
  Building2, MessageSquare, MessageCircle, Wallet, IndianRupee, ChevronDown, ChevronUp,
  Landmark, CreditCard, ShoppingBag, BookOpen, NotebookPen, BarChart3,
  TrendingDown, CalendarClock, CalendarX2, CalendarCheck2, CalendarOff,
  Minimize2, Copy, ChevronsDownUp, ChevronsUpDown, Upload,
  CheckSquare,
} from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { useFormMinimizer } from '@/contexts/MinimizedFormsContext';
import AccessGovernancePanel from '@/components/governance/AccessGovernancePanel';
import { DEFAULT_ROLE_PERMISSIONS, EMPTY_PERMISSIONS } from '@/lib/permissionTemplates';
import { GLOBAL_PERMS, OPS_PERMS, EDIT_PERMS, permTabs, MODULE_PERM_KEYS } from '@/lib/permissionCatalog';

// ── Brand Colors ─────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen:   '#5CCB5F',
  indigo:       '#4F46E5',
  violet:       '#7C3AED',
  teal:         '#0F766E',
  amber:        '#B45309',
  coral:        '#FF6B6B',
  slate:        '#475569',
  red:          '#ef4444',
  green:        '#059669',
  border:       '#e2e8f0',
};

const GRADIENT   = `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`;
const GRAD_GREEN = `linear-gradient(135deg, ${COLORS.emeraldGreen} 0%, ${COLORS.lightGreen} 100%)`;
const PERMISSION_ICON_MAP = {
  Layers, Briefcase, Fingerprint, FileText, Calendar, BarChart2, CheckCircle,
  Activity, Target, UsersIcon, Eye, Star, UserIcon, ShieldCheck, Receipt,
  MessageSquare, MessageCircle, ArrowUpRight, Clock, Edit, Bell, Download,
  Settings, Trash2, XCircle, Inbox, MapPin, Pencil, Zap,
};


const slimScroll = {
  overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#cbd5e1 transparent',
};

if (typeof document !== 'undefined' && !document.getElementById('users-slim-scroll')) {
  const s = document.createElement('style');
  s.id = 'users-slim-scroll';
  s.textContent = `
    .users-slim::-webkit-scrollbar { width: 3px; }
    .users-slim::-webkit-scrollbar-track { background: transparent; }
    .users-slim::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
    .dark .users-slim::-webkit-scrollbar-thumb { background: #475569; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
    @keyframes admsShimmer { from { transform: translateX(-120%); } to { transform: translateX(260%); } }
  `;
  document.head.appendChild(s);
}

const springPhysics = {
  card: { type: 'spring', stiffness: 280, damping: 22, mass: 0.85 },
  lift: { type: 'spring', stiffness: 320, damping: 24, mass: 0.9  },
};

const containerVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
const itemVariants = {
  hidden:  { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] } },
};
const slideIn = {
  hidden:  { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

// ── Department Config ─────────────────────────────────────────────────────────
const DEPARTMENTS = [
  { value: 'GST',   label: 'GST',   color: '#1E3A8A', bg: '#EFF6FF' },
  { value: 'IT',    label: 'IT',    color: '#374151', bg: '#F9FAFB' },
  { value: 'ACC',   label: 'ACC',   color: '#065F46', bg: '#ECFDF5' },
  { value: 'TDS',   label: 'TDS',   color: '#1F2937', bg: '#F9FAFB' },
  { value: 'ROC',   label: 'ROC',   color: '#7C2D12', bg: '#FFF7ED' },
  { value: 'TM',    label: 'TM',    color: '#0F766E', bg: '#F0FDFA' },
  { value: 'MSME',  label: 'MSME',  color: '#92400E', bg: '#FFFBEB' },
  { value: 'FEMA',  label: 'FEMA',  color: '#334155', bg: '#F8FAFC' },
  { value: 'DSC',   label: 'DSC',   color: '#3F3F46', bg: '#FAFAFA' },
  { value: 'OTHER', label: 'OTHER', color: '#475569', bg: '#F8FAFC' },
];

const ROLE_CONFIG = {
  admin:   { gradient: 'from-violet-600 to-indigo-600', hex: '#7C3AED', icon: Crown,     label: 'Admin'   },
  manager: { gradient: 'from-blue-500 to-cyan-500',     hex: '#1F6FB2', icon: Briefcase, label: 'Manager' },
  staff:   { gradient: 'from-slate-400 to-slate-500',   hex: '#475569', icon: UserIcon,  label: 'User'    },
};

// ── Transfer Options for Offboarding Dialog ───────────────────────────────────
const TRANSFER_OPTIONS = [
  { key: 'transfer_tasks',     label: 'Tasks',     desc: 'Active & pending tasks',       icon: ClipboardList,   color: '#3B82F6', countKey: 'tasks'     },
  { key: 'transfer_clients',   label: 'Clients',   desc: 'Assigned client accounts',     icon: UsersIcon,       color: '#10B981', countKey: 'clients'   },
  { key: 'transfer_dsc',       label: 'DSC',       desc: 'Digital signature certificates', icon: Fingerprint,   color: '#8B5CF6', countKey: 'dsc'       },
  { key: 'transfer_documents', label: 'Documents', desc: 'Files & document records',     icon: FileText,        color: '#F59E0B', countKey: 'documents' },
  { key: 'transfer_todos',     label: 'To-Dos',    desc: 'Personal to-do items',         icon: CheckCircle,     color: '#06B6D4', countKey: 'todos'     },
  { key: 'transfer_visits',    label: 'Visits',    desc: 'Scheduled client visits',      icon: MapPin,          color: '#EC4899', countKey: 'visits'    },
  { key: 'transfer_leads',     label: 'Leads',     desc: 'Sales leads & prospects',      icon: Target,          color: '#F97316', countKey: 'leads'     },
];

// ── Identix helpers ───────────────────────────────────────────────────────────
const fmtTime = (iso) => {
  try { return format(new Date(iso), 'MMM dd, yyyy  hh:mm a'); }
  catch { return iso || '—'; }
};

const inputStyleIdentix = {
  width: '100%', padding: '9px 12px', border: `1.5px solid ${COLORS.border}`,
  borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', background: '#fff', transition: 'border-color 0.15s',
};

// ════════════════════════════════════════════════════════════════════════════════
// SHARED PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════════
function SectionCard({ children, className = '' }) {
  return (
    <div className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function CardHeaderRow({ iconBg, icon, title, subtitle, action, badge }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
      <div className="flex items-center gap-2.5">
        <div className={`p-1.5 rounded-lg ${iconBg}`}>{icon}</div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
            {badge !== undefined && badge > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500 text-white leading-none">{badge}</span>
            )}
          </div>
          {subtitle && <p className="text-xs text-slate-400 dark:text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

function DialogGradHeader({ gradient, icon: Icon, eyebrow, title, subtitle, onClose, onMinimize }) {
  return (
    <div className="relative overflow-hidden rounded-t-2xl" style={{ background: gradient }}>
      <div className="absolute right-0 top-0 w-56 h-56 rounded-full -mr-20 -mt-20 opacity-10"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
      <div className="relative px-7 py-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 flex-1 min-w-0">
          <div className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Icon className="h-5 w-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            {eyebrow && <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1">{eyebrow}</p>}
            <h2 className="text-xl font-bold text-white leading-snug tracking-tight">{title}</h2>
            {subtitle && <p className="text-white/55 text-sm mt-1">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
          {onMinimize && (
            <button type="button" onClick={onMinimize} title="Minimize (resume later without losing your progress)"
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all active:scale-90">
              <Minimize2 className="h-4 w-4 text-white" />
            </button>
          )}
          {onClose && (
            <button onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all active:scale-90">
              <X className="h-4 w-4 text-white" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const DeptPill = ({ dept }) => {
  const info = DEPARTMENTS.find(d => d.value === dept);
  if (!info) return null;
  return (
    <span className="inline-flex items-center font-bold rounded-xl px-2.5 py-1 text-[11px] tracking-wide"
      style={{ background: info.bg, color: info.color, border: `1px solid ${info.color}30` }}>
      {info.label}
    </span>
  );
};

const StatusBadge = ({ status, isActive }) => {
  const resolved = status || (isActive !== false ? 'active' : 'inactive');
  const cfg = {
    active:           { label: 'Active',   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400', dot: 'bg-emerald-500' },
    pending_approval: { label: 'Pending',  cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',         dot: 'bg-amber-500'   },
    rejected:         { label: 'Rejected', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',                  dot: 'bg-red-500'     },
    inactive:         { label: 'Inactive', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',             dot: 'bg-slate-400'   },
  }[resolved] || { label: 'Inactive', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400', dot: 'bg-slate-400' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${resolved === 'active' ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
};

const ModuleAccessBadges = ({ userData }) => {
  if (userData.role === 'admin') return null;
  const p = userData.permissions || {};
  const badges = [
    { label: 'Leads',    active: !!p.can_view_all_leads,    color: '#1F6FB2', icon: Target   },
    { label: 'Quotes',   active: !!p.can_create_quotations, color: '#7C3AED', icon: Receipt  },
    { label: 'Invoicing',active: !!p.can_manage_invoices,   color: '#1FAF5A', icon: FileText },
    {
      label: !p.can_view_passwords ? 'Vault' : p.can_edit_passwords ? 'Vault R/W' : 'Vault R',
      active: !!p.can_view_passwords,
      color:  p.can_edit_passwords ? '#B45309' : '#0F766E',
      icon: KeyRound,
    },
    { label: 'Client Portal', active: !!p.can_view_client_portal, color: '#0D3B66', icon: Building2 },
    { label: 'WhatsApp',      active: !!p.can_manage_whatsapp,    color: '#25D366', icon: MessageSquare },
  ];
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {badges.map((b, i) => {
        const Icon = b.icon;
        return (
          <span key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold border transition-all"
            style={b.active
              ? { background: `${b.color}12`, color: b.color, borderColor: `${b.color}30` }
              : { background: 'transparent', color: '#94a3b8', borderColor: '#e2e8f0' }}>
            <Icon className="h-3 w-3" />
            {b.label}
          </span>
        );
      })}
    </div>
  );
};

const PermissionMatrixSummary = ({ permissions }) => {
  // Include module-level perms (managed from the Modules tab) so coverage % is accurate
  const allPerms = [...GLOBAL_PERMS, ...OPS_PERMS, ...EDIT_PERMS];
  const granted  = allPerms.filter(p => permissions[p.key]).length
                 + MODULE_PERM_KEYS.filter(k => permissions[k]).length;
  const total    = allPerms.length + MODULE_PERM_KEYS.length;
  const pct      = Math.round((granted / total) * 100);
  return (
    <div className="flex gap-5 p-5 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700">
      <div className="relative w-18 h-18 flex-shrink-0" style={{ width: 72, height: 72 }}>
        <svg className="w-full h-full -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="none" stroke="#e2e8f0" strokeWidth="5" />
          <circle cx="24" cy="24" r="20" fill="none" stroke={COLORS.emeraldGreen} strokeWidth="5"
            strokeDasharray={`${2 * Math.PI * 20}`}
            strokeDashoffset={`${2 * Math.PI * 20 * (1 - pct / 100)}`}
            strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center font-black text-xl text-slate-700 dark:text-slate-100">{pct}%</div>
      </div>
      <div className="flex-1">
        <p className="font-bold text-xl tracking-tight text-slate-900 dark:text-white">Permission Coverage</p>
        <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{granted} of {total} permissions enabled</p>
        <div className="mt-3 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, background: GRAD_GREEN }} />
        </div>
      </div>
    </div>
  );
};

const PermToggleRow = ({ permKey, label, desc, icon, permissions, setPermissions }) => {
  const Icon = typeof icon === 'string' ? (PERMISSION_ICON_MAP[icon] || FileText) : icon;
  const isOn = !!permissions[permKey];
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 sm:px-4 py-3.5 rounded-xl border transition-all min-w-0 overflow-hidden ${
      isOn
        ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
    }`}>
      <div className="flex items-center gap-3.5 pr-4 flex-1 min-w-0">
        {Icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${
            isOn ? 'bg-emerald-100 dark:bg-emerald-900 text-emerald-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'
          }`}>
            <Icon className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 overflow-hidden">
          <p className={`font-semibold text-sm break-words ${isOn ? 'text-emerald-800 dark:text-emerald-200' : 'text-slate-700 dark:text-slate-200'}`}>{label}</p>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug break-words overflow-wrap-anywhere">{desc}</p>
        </div>
      </div>
      <Switch checked={isOn} onCheckedChange={val => setPermissions(p => ({ ...p, [permKey]: val }))} />
    </div>
  );
};

const ModuleAccessCard = ({ icon: Icon, title, desc, permKey, permissions, setPermissions, accentColor, badge }) => {
  const isEnabled = !!permissions[permKey];
  const accent    = accentColor || COLORS.mediumBlue;
  const toggle    = () => setPermissions(p => ({ ...p, [permKey]: !p[permKey] }));
  return (
    <motion.div
      style={{ minWidth: 0 }}
      whileHover={{ y: -2, transition: springPhysics.lift }}
      whileTap={{ scale: 0.99 }}
      onClick={toggle}
      className={`flex gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all hover:shadow-md ${
        isEnabled ? 'shadow-sm' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
      }`}
      style={isEnabled ? { borderColor: `${accent}40`, background: `${accent}06` } : {}}>
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${
        isEnabled ? 'text-white shadow-md' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'
      }`}
        style={isEnabled ? { background: `linear-gradient(135deg, ${accent}, ${accent}cc)` } : {}}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden pt-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <p className={`font-semibold text-sm ${isEnabled ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}>{title}</p>
          {badge && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
              style={{ background: `${accent}15`, color: accent }}>{badge}</span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed break-words overflow-wrap-anywhere">{desc}</p>
      </div>
      <div className="flex-shrink-0 flex items-center" onClick={e => e.stopPropagation()}>
        <Switch checked={isEnabled} onCheckedChange={toggle} />
      </div>

    </motion.div>
  );
};

const SectionHeader = ({ icon: Icon, title, count, color }) => (
  <div className="flex items-center gap-3 mb-5">
    <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${color}15` }}>
      <Icon className="h-4 w-4" style={{ color }} />
    </div>
    <p className="font-bold text-base tracking-tight text-slate-900 dark:text-white">{title}</p>
    {count !== undefined && (
      <span className="ml-auto text-xs font-bold px-3 py-1 rounded-full" style={{ background: `${color}15`, color }}>
        {count} enabled
      </span>
    )}
  </div>
);

// ════════════════════════════════════════════════════════════════════════════════
// MAIN PERMISSION MODULE HIERARCHY (Modules tab)
// ────────────────────────────────────────────────────────────────────────────
// Mirrors backend/models.py::MODULE_HIERARCHY. Seven main permission modules —
// Taskosphere, Finix, AIWeave, CompliGenie, Records, LeadSense, People Matrix —
// each own one master "module access" flag plus the individual page-level
// flags nested beneath it. A page toggle only takes effect while its
// module's master switch is on; turning the module off cascades and clears
// every page beneath it (the backend re-enforces this on every save
// regardless of what this UI sends, so the two can never drift apart).
// ════════════════════════════════════════════════════════════════════════════════
const ACCOUNT_PAGE_PERMS = [
  { permKey: 'can_view_accounting_reports', label: 'Finix Dashboard & Accounting Reports', desc: 'View P&L, Balance Sheet, ledgers & other reports', icon: BarChart3 },
  { permKey: 'can_view_sale',               label: 'Sale',                      desc: 'View the Sale invoices page',                          icon: CreditCard },
  { permKey: 'can_view_purchase',           label: 'Purchase',                  desc: 'View the Purchase invoices page',                      icon: ShoppingBag },
  { permKey: 'can_view_bank',               label: 'Bank Accounts',             desc: 'Upload statements, view bank accounts & balances',     icon: Landmark },
  { permKey: 'can_view_chart_of_accounts',  label: 'Chart of Accounts',         desc: 'View the chart of accounts',                           icon: BookOpen },
  { permKey: 'can_view_journal_entries',    label: 'Journal Entries',           desc: 'View journal entries',                                 icon: NotebookPen },
  { permKey: 'can_manage_invoices',         label: 'Sale & Purchase Invoicing', desc: 'Create GST invoices, record payments, manage product catalog', icon: FileText },
];

// Write / manage sub-permissions shown nested under their parent page.
const ACCOUNT_WRITE_PERMS = [
  { parent: 'can_view_chart_of_accounts', permKey: 'can_manage_chart_of_accounts', label: 'Manage Chart of Accounts', desc: 'Create and edit ledger accounts',           icon: Pencil },
  { parent: 'can_view_journal_entries',   permKey: 'can_post_journal_entries',     label: 'Post Journal Entries',     desc: 'Create and post manual journal entries',    icon: Pencil },
  { parent: 'can_view_bank',              permKey: 'can_match_bank',               label: 'Match / Unmatch Transactions', desc: 'Match, edit-match and unmatch bank reconciliations', icon: Pencil },
];

// Small helper: build a module's `pages` array by attaching each page's
// nested write-permission(s), if any, from a WRITE_PERMS list.
const pagesWithWritePerms = (pagePerms, writePerms) => pagePerms.map(pg => ({
  permKey: pg.permKey, label: pg.label, desc: pg.desc, icon: pg.icon,
  writePerms: writePerms.filter(w => w.parent === pg.permKey)
    .map(w => ({ permKey: w.permKey, label: w.label, desc: w.desc, icon: w.icon })),
}));

const MODULE_TREE = [
  {
    key: 'taskosphere', flag: 'can_access_taskosphere', label: 'Taskosphere', icon: ClipboardList, accent: '#1F6FB2',
    desc: 'The core workspace — Tasks, To-Do, Attendance, Reminders, Action Center, Client Visits, Client Portal Manager.',
    pages: [
      { permKey: 'can_view_dashboard',         label: 'Dashboard',         desc: 'View the personal dashboard — summary widgets, quick stats and recent activity', icon: LayoutDashboard },
      { permKey: 'can_view_tasks',              label: 'Tasks',             desc: 'View and manage assigned tasks', icon: CheckSquare },
      { permKey: 'can_view_todo_dashboard',     label: 'To-Do',             desc: 'View and manage the personal to-do list', icon: CheckSquare },
      { permKey: 'can_view_attendance',         label: 'Attendance',        desc: 'Mark and view attendance records', icon: Clock },
      { permKey: 'can_view_reminders',          label: 'Reminders',        desc: 'View and manage reminders', icon: Bell },
      { permKey: 'can_view_action_center',      label: 'Action Center',    desc: 'View pending actions and approvals awaiting the user', icon: Zap },
      { permKey: 'can_view_client_visits',      label: 'Client Visits',    desc: 'Log and view client visit records', icon: MapPin },
      { permKey: 'can_view_client_portal',      label: 'Client Portal Manager', desc: 'Create and manage client portal accounts, Drive folder visibility, portal messages and settings', icon: Building2 },
      { permKey: 'can_reset_client_passwords',  label: 'Password Reset', desc: 'Reset client portal passwords in bulk and download the credentials sheet. Off = the user cannot reset any portal password.', icon: KeyRound },
    ],
  },
  {
    key: 'finix', flag: 'can_access_finix', label: 'Finix', icon: CreditCard, accent: '#15803D',
    desc: 'Accounting & finance — Sale, Purchase, Bank Accounts, Chart of Accounts, Journal Entries and Accounting Reports.',
    pages: pagesWithWritePerms(ACCOUNT_PAGE_PERMS, ACCOUNT_WRITE_PERMS),
  },
  {
    key: 'compliance', flag: 'can_access_compliance', label: 'Compliance', icon: ShieldCheck, accent: '#1F6FB2',
    desc: 'Compliance Tracker, GST Reconciliation, Trademark Sphere, MIS Report and the Salary Slip Generator.',
    pages: [
      {
        permKey: 'can_view_compliance', label: 'Compliance Tracker', desc: 'View the Compliance Tracker page (own department categories for non-admins)', icon: ShieldCheck,
        writePerms: [{ permKey: 'can_manage_compliance', label: 'Manage Compliance Items', desc: 'Create and edit compliance masters in their department', icon: Pencil }],
      },
      { permKey: 'can_view_gst_reconciliation', label: 'GST Reconciliation', desc: 'Access the GST Reconciliation module — grant to GST department users only', icon: FileText },
      { permKey: 'can_view_trademark_sphere',   label: 'Trademark Sphere',   desc: 'Track, monitor and manage trademark applications from IP India', icon: ShieldCheck },
      {
        permKey: 'can_view_mis_report', label: 'MIS Report', desc: 'View the MIS Report — Financial Dashboard, Receivables/Payables/Revenue/Expense/Profitability per client', icon: BarChart3,
        writePerms: [{ permKey: 'can_manage_mis_report', label: 'Manage MIS Report', desc: 'Upload source documents, create periods/clients and edit manual entries', icon: Upload }],
      },
      {
        permKey: 'can_view_salary_slips', label: 'Salary Slip Generator', desc: 'Generate and view payslips for client companies\u2019 employees — payroll data is sensitive, so this is admin-granted only by default', icon: Receipt,
        writePerms: [{ permKey: 'can_manage_salary_slips', label: 'Manage Salary Slips', desc: 'Add/edit employees and companies, generate, edit and delete payslips', icon: Pencil }],
      },
    ],
  },
  {
    key: 'records', flag: 'can_access_records', label: 'Records', icon: FileText, accent: '#B45309',
    desc: 'DSC Register, Document Register, Clients (with approval workflow) and Password Vault.',
    pages: [
      { permKey: 'can_view_all_dsc',   label: 'DSC Register',      desc: 'View all Digital Signature Certificates',       icon: Fingerprint },
      { permKey: 'can_view_documents', label: 'Document Register', desc: 'Access the physical document register',        icon: FileText },
      {
        permKey: 'can_view_all_clients',
        label: 'Clients — Visibility of All Clients',
        desc: 'Every user always sees the clients assigned to them. Turn this on to let them see every other client too.',
        icon: UsersIcon,
        writePerms: [
          { permKey: 'can_edit_clients',    label: 'Client Edit & Update Access', desc: 'Edit and update any client record, not just their own assigned ones', icon: Pencil },
          { permKey: 'can_approve_clients', label: 'Approve New Clients',         desc: 'Approve or reject clients added by other users (admins always can)',  icon: ShieldCheck },
          { permKey: 'can_approve_whatsapp_wishes', label: 'Approve WhatsApp Automation', desc: 'Review and approve/reject queued birthday & festival WhatsApp wishes before they send (admins always can)', icon: MessageSquare },
          { permKey: 'can_approve_email_wishes',    label: 'Approve Email Automation',    desc: 'Review and approve/reject queued birthday & festival email wishes before they send (admins always can)', icon: Mail },
        ],
        extra: () => (
          <div className="p-4 rounded-xl border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">How client access works</p>
            <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-1 list-disc pl-4">
              <li><span className="font-semibold">Admin</span> — full view, add, edit, update, delete and approve on every client.</li>
              <li><span className="font-semibold">Every user</span> — sees and edits the clients assigned to them by default, no permission needed.</li>
              <li><span className="font-semibold">Other clients</span> — need the visibility / edit-update permissions above.</li>
              <li><span className="font-semibold">Adding clients</span> — any user can add one; it stays pending until an approver signs it off.</li>
            </ul>
          </div>
        ),
      },
      {
        permKey: 'can_view_passwords', label: 'Password Vault', desc: 'Access the secure portal credentials repository', icon: KeyRound,
        writePerms: [{ permKey: 'can_edit_passwords', label: 'Vault Write Access', desc: 'Allow adding, editing and deleting portal credentials', icon: Pencil }],
        extra: ({ permissions, setPermissions }) => (
          <div className="p-4 rounded-xl border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Vault Department Scope</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">Leave empty to allow access to all departments. Select specific departments to restrict.</p>
            <div className="flex flex-wrap gap-2">
              {DEPARTMENTS.map(dept => {
                const isSelected = (permissions.view_password_departments || []).includes(dept.value);
                return (
                  <button key={dept.value} type="button"
                    onClick={() => setPermissions(prev => ({
                      ...prev,
                      view_password_departments: isSelected
                        ? prev.view_password_departments.filter(d => d !== dept.value)
                        : [...(prev.view_password_departments || []), dept.value],
                    }))}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold border-2 transition-all hover:shadow-sm"
                    style={isSelected
                      ? { background: dept.color, color: 'white', borderColor: dept.color }
                      : { background: dept.bg, color: dept.color, borderColor: `${dept.color}30` }}>
                    {isSelected ? '\u2713 ' : ''}{dept.label}
                  </button>
                );
              })}
            </div>
            {(permissions.view_password_departments || []).length === 0 ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-medium">\u2713 Access to all departments (no restriction)</p>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 font-medium">\u26a0 Restricted to {(permissions.view_password_departments || []).join(', ')} only</p>
            )}
          </div>
        ),
      },
    ],
  },
  {
    key: 'proposals', flag: 'can_access_proposals', label: 'Client Proposals', icon: Target, accent: '#7C3AED',
    desc: 'Lead management and quotations.',
    pages: [
      { permKey: 'can_view_all_leads',    label: 'Lead Management', desc: 'Access and manage the global leads dashboard',            icon: Target },
      { permKey: 'can_create_quotations', label: 'Quotations',      desc: 'Create, edit, export and send quotations to clients',     icon: Receipt },
    ],
  },
  {
    key: 'people_matrix', flag: 'can_access_people_matrix', label: 'People Matrix', icon: Fingerprint, accent: '#0F766E',
    desc: 'User directory and Recruitment (HRMS).',
    pages: [
      { permKey: 'can_view_user_page',    label: 'User Directory',        desc: 'View the team members directory',                                icon: UsersIcon },
      { permKey: 'can_view_recruitment',  label: 'Recruitment (view)',    desc: 'Access the Recruitment page — candidate pipeline & interviews',  icon: Briefcase },
      { permKey: 'can_manage_recruitment', label: 'Recruitment (manage)', desc: 'Create, edit and delete candidates, and convert hires to users', icon: Briefcase },
    ],
  },
];

const ModuleGovernanceCard = ({ module, permissions, setPermissions, expanded = true, onToggleExpanded, searchTerm = '' }) => {
  const { flag, label, desc, icon: Icon, accent, pages, footnote } = module;

  // Every module — including Taskosphere — now has a real, editable master
  // switch: turning it off cascades and clears every page flag nested
  // beneath it (Dashboard, Tasks, To-Do, Attendance, Reminders, Action
  // Center, Client Visits, Client Portal Manager),
  // matching what the backend guarantees on save
  // (permission_governance._enforce_module_hierarchy).
  const alwaysOn = false;
  const masterOn  = !!permissions[flag];
  const pageKeys  = pages.flatMap(p => [p.permKey, ...(p.writePerms || []).map(w => w.permKey)]);
  const enabledCount = pageKeys.filter(k => permissions[k]).length;

  const toggleMaster = (val) => {
    if (alwaysOn) return; // locked always-on — no-op
    setPermissions(prev => {
      const next = { ...prev, [flag]: val };
      // Turning the module off cascades: every page (and nested write) flag
      // beneath it is cleared in the same update, matching what the backend
      // guarantees on save (_enforce_module_hierarchy).
      if (!val) pageKeys.forEach(k => { next[k] = false; });
      return next;
    });
  };

  // "Select Entire Module" — turn the module on AND grant every page (and
  // nested write-permission) flag beneath it in one click.
  const selectEntireModule = (e) => {
    e.stopPropagation();
    setPermissions(prev => {
      const next = { ...prev, [flag]: true };
      pageKeys.forEach(k => { next[k] = true; });
      return next;
    });
  };

  // "Remove Entire Module" — same cascade as switching the module off.
  // Not available for always-on modules (see alwaysOn above).
  const removeEntireModule = (e) => {
    e.stopPropagation();
    toggleMaster(false);
  };

  const q = searchTerm.trim().toLowerCase();
  const visiblePages = q
    ? pages.filter(pg =>
        pg.label.toLowerCase().includes(q) ||
        (pg.writePerms || []).some(w => w.label.toLowerCase().includes(q)))
    : pages;
  const moduleMatchesSearch = !q || label.toLowerCase().includes(q) || visiblePages.length > 0;
  if (!moduleMatchesSearch) return null;

  // While actively searching, force the section open so matches are visible
  // regardless of the collapsed/expanded state the user left it in.
  const showPages = pages.length > 0 && (expanded || !!q);

  return (
    <div className="space-y-3">
      <div
        onClick={() => !alwaysOn && toggleMaster(!masterOn)}
        className={`grid grid-cols-[auto,minmax(0,1fr),auto] gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl border-2 transition-all hover:shadow-md min-w-0 overflow-hidden ${alwaysOn ? 'cursor-default' : 'cursor-pointer'}`}
        style={masterOn ? { borderColor: `${accent}40`, background: `${accent}06` } : {}}
      >
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${
          masterOn ? 'text-white shadow-md' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'
        }`} style={masterOn ? { background: `linear-gradient(135deg, ${accent}, ${accent}cc)` } : {}}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`font-bold text-sm break-words overflow-wrap-anywhere ${masterOn ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}>{label}</p>
            {pages.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: `${accent}15`, color: accent }}>
                {alwaysOn ? `Always on · ${enabledCount}/${pageKeys.length} pages` : (masterOn ? `${enabledCount}/${pageKeys.length} pages` : 'Access off')}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
            {alwaysOn ? `${desc} Open to every signed-in user — this module can't be turned off, only the pages beneath it are individually granted.` : desc}
          </p>
          {pages.length > 0 && (
            <div className="flex items-center gap-3 mt-1.5" onClick={e => e.stopPropagation()}>
              <button type="button" onClick={selectEntireModule} className="text-[11px] font-bold hover:underline" style={{ color: accent }}>
                Select entire module
              </button>
              {!alwaysOn && (
                <>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <button type="button" onClick={removeEntireModule} className="text-[11px] font-bold text-slate-400 hover:text-red-500 hover:underline">
                    Remove entire module
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {pages.length > 0 && onToggleExpanded && (
            <button type="button" onClick={onToggleExpanded}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label={expanded ? 'Collapse module' : 'Expand module'}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
          <Switch checked={masterOn} onCheckedChange={toggleMaster} disabled={alwaysOn} />
        </div>
      </div>

      {showPages && (
        <div className={`ml-0 sm:ml-5 space-y-2 transition-opacity min-w-0 ${masterOn ? '' : 'opacity-50 pointer-events-none select-none'}`}>
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 pt-1">
            {label} pages{!masterOn ? ' — turn on module access above to edit' : ''}
          </p>
          {visiblePages.length === 0 && q && (
            <p className="text-xs text-slate-400 italic">No pages match "{searchTerm}" in this module.</p>
          )}
          {visiblePages.map(pg => (
            <React.Fragment key={pg.permKey}>
              <PermToggleRow permKey={pg.permKey} label={pg.label} desc={pg.desc} icon={pg.icon} permissions={permissions} setPermissions={setPermissions} />
              {permissions[pg.permKey] && (pg.writePerms || []).map(w => (
                <div className="ml-0 sm:ml-5 min-w-0" key={w.permKey}>
                  <PermToggleRow permKey={w.permKey} label={w.label} desc={w.desc} icon={w.icon} permissions={permissions} setPermissions={setPermissions} />
                </div>
              ))}
              {permissions[pg.permKey] && pg.extra && (
                <div className="ml-5">{pg.extra({ permissions, setPermissions })}</div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {footnote && (
        <p className="ml-5 text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed italic">{footnote}</p>
      )}
    </div>
  );
};


// ════════════════════════════════════════════════════════════════════════════════
// IDENTIX — LAN SCANNER
// ════════════════════════════════════════════════════════════════════════════════
function LanScanner({ onAddDevice }) {
  const [scanning,   setScanning]   = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [found,      setFound]      = useState([]);
  const [scanStatus, setScanStatus] = useState('');
  const [subnet,     setSubnet]     = useState('');
  const [port,       setPort]       = useState(4370);
  const pollRef = useRef(null);

  const startScan = async () => {
    setScanning(true); setFound([]); setProgress(0); setScanStatus('Starting scan…');
    try {
      const { data } = await api.post('/identix/devices/scan', { subnet: subnet || null, port });
      const scanId = data.scan_id;
      setScanStatus(data.message || 'Scanning…');
      pollRef.current = setInterval(async () => {
        try {
          const { data: status } = await api.get(`/identix/devices/scan/${scanId}`);
          setProgress(status.progress ?? 0);
          setFound(status.found ?? []);
          setScanStatus(status.message ?? 'Scanning…');
          if (status.done) {
            clearInterval(pollRef.current);
            setScanning(false);
          }
        } catch {
          clearInterval(pollRef.current);
          setScanning(false);
          setScanStatus('Scan polling failed.');
        }
      }, 1500);
    } catch (e) {
      setScanning(false);
      setScanStatus(e?.response?.data?.detail || 'Scan failed.');
      toast.error('LAN scan failed');
    }
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  return (
    <div style={{ background: 'linear-gradient(135deg, #eff6ff, #f0fdf4)', border: '1.5px solid #bfdbfe', borderRadius: 14, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: COLORS.deepBlue, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Radar size={16} color="#fff" />
        </div>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: '#0f172a' }}>Auto-Discover Devices</p>
          <p style={{ margin: 0, fontSize: 12, color: COLORS.slate }}>Scans your LAN for ZKTeco / Identix machines on port {port}</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: COLORS.slate, marginBottom: 3 }}>SUBNET (optional)</label>
          <input type="text" placeholder="e.g. 192.168.1" value={subnet} onChange={e => setSubnet(e.target.value)} disabled={scanning}
            style={{ ...inputStyleIdentix, fontSize: 12 }} />
        </div>
        <div style={{ width: 90 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: COLORS.slate, marginBottom: 3 }}>PORT</label>
          <input type="number" value={port} onChange={e => setPort(Number(e.target.value))} disabled={scanning}
            style={{ ...inputStyleIdentix, fontSize: 12 }} />
        </div>
        <button onClick={startScan} disabled={scanning}
          style={{ padding: '9px 16px', background: scanning ? '#e2e8f0' : COLORS.deepBlue, color: scanning ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: scanning ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          {scanning ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />Scanning…</> : <><Radar size={13} />Scan LAN</>}
        </button>
      </div>
      {(scanning || progress > 0) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: COLORS.slate }}>{scanStatus}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.deepBlue }}>{progress}%</span>
          </div>
          <div style={{ height: 5, background: '#dbeafe', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, borderRadius: 99, background: `linear-gradient(90deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`, transition: 'width 0.4s ease' }} />
          </div>
          {found.length > 0 && <p style={{ margin: '5px 0 0', fontSize: 12, color: COLORS.green, fontWeight: 600 }}>✓ {found.length} device(s) discovered…</p>}
        </div>
      )}
      {found.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {found.map((d, i) => (
            <div key={i} style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Wifi size={14} color={COLORS.green} />
                </div>
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{d.ip_address}:{d.port}</p>
                  <p style={{ margin: 0, fontSize: 11, color: COLORS.slate }}>
                    {d.device_info ? `S/N: ${d.device_info.serialNumber} · FW: ${d.device_info.firmware}` : 'ZKTeco device detected'}
                  </p>
                </div>
              </div>
              {d.already_registered
                ? <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.slate, padding: '5px 10px', background: '#f1f5f9', borderRadius: 8 }}>Already Registered</span>
                : <button onClick={() => onAddDevice(d)} style={{ padding: '6px 12px', background: COLORS.green, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Plus size={12} />Add Device
                  </button>
              }
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// IDENTIX — DEVICES TAB
// ════════════════════════════════════════════════════════════════════════════════
const emptyDevice = { name: '', ip_address: 'adms-domain', port: 4370, comm_password: '0', serial_number: '', location: '' };

function IdentixDevicesTab() {
  const [devices,     setDevices]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showModal,   setShowModal]   = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [form,        setForm]        = useState(emptyDevice);
  const [saving,      setSaving]      = useState(false);
  const [testingId,   setTestingId]   = useState(null);
  const [testResults, setTestResults] = useState({});
  const [syncingId,   setSyncingId]   = useState(null);
  // Real-time ADMS sync runs keyed by device id. Each run is tied to the
  // backend batch_id so the progress bar reflects the actual machine queue,
  // not merely the fact that the button was clicked.
  const [syncRuns, setSyncRuns] = useState({});

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/identix/devices'); setDevices(data.devices || []); }
    catch { toast.error('Failed to load devices'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const openNew  = (prefill = {}) => { setEditing(null);  setForm({ ...emptyDevice, ...prefill }); setShowModal(true); };
  const openEdit = (d)            => { setEditing(d);     setForm({ ...d });                        setShowModal(true); };

  const handleDiscoveredDevice = (discovered) => {
    openNew({
      ip_address:    discovered.ip_address,
      port:          discovered.port ?? 4370,
      name:          `Identix (${discovered.ip_address})`,
      serial_number: discovered.device_info?.serialNumber || '',
    });
  };

  const save = async () => {
    if (!form.name?.trim() || !form.serial_number?.trim()) { toast.error('Device Name and Serial Number are required'); return; }
    setSaving(true);
    try {
      if (editing) { await api.put(`/identix/devices/${editing.id}`, form); toast.success('Device updated'); }
      else         { await api.post('/identix/devices', form);              toast.success('Device added');   }
      setShowModal(false); load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (d) => {
    if (!window.confirm(`Delete device "${d.name}"?`)) return;
    try { await api.delete(`/identix/devices/${d.id}`); toast.success('Device deleted'); load(); }
    catch { toast.error('Delete failed'); }
  };

  const checkADMS = async (d) => {
    setTestingId(d.id); setTestResults(prev => ({ ...prev, [d.id]: { testing: true } }));
    try {
      const { data } = await api.post(`/identix/devices/${d.id}/test`);
      setTestResults(prev => ({ ...prev, [d.id]: data }));
      if (data.success) toast.success(`✓ ${d.name} is connected via ADMS`);
      else toast.error(`${d.name}: ${data.message}`);
    } catch { toast.error('ADMS check failed'); }
    finally { setTestingId(null); }
  };

  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const syncUsers = async (d) => {
    setSyncingId(d.id);
    const startedAt = new Date().toISOString();
    setSyncRuns(prev => ({
      ...prev,
      [d.id]: {
        batchId: null,
        total: 0,
        startedAt,
        phase: 'starting',
        error: null,
      },
    }));
    try {
      const { data } = await api.post(`/identix/devices/${d.id}/sync-users`);
      const total = Number(data.synced || 0);
      setSyncRuns(prev => ({
        ...prev,
        [d.id]: {
          batchId: data.batch_id || null,
          total,
          startedAt,
          phase: total ? 'queued' : 'complete',
          error: null,
        },
      }));
      toast.success(data.message || `${total} users queued for push`);
      await loadCmdQueue();
    }
    catch (e) {
      const message = e?.response?.data?.detail || 'Sync failed';
      setSyncRuns(prev => ({ ...prev, [d.id]: { ...(prev[d.id] || {}), phase: 'failed', error: message } }));
      toast.error(message);
    }
    finally { setSyncingId(null); }
  };

  const [cmdQueueCount, setCmdQueueCount] = useState(0);
  const [cmdQueue, setCmdQueue] = useState([]);
  const [showCmdQueue, setShowCmdQueue] = useState(false);

  const loadCmdQueue = async () => {
    try {
      const { data } = await api.get('/identix/cmd-queue');
      const commands = data.commands || [];
      setCmdQueue(commands);
      setCmdQueueCount(commands.filter(c => ['pending', 'sent'].includes(c.status)).length);

      setSyncRuns(prev => {
        const next = { ...prev };
        Object.entries(prev).forEach(([deviceId, run]) => {
          if (!run?.batchId || !run?.total) return;
          const batch = commands.filter(c => c.batch_id === run.batchId);
          if (!batch.length) return;
          const pending = batch.filter(c => c.status === 'pending').length;
          const sent = batch.filter(c => c.status === 'sent').length;
          const acknowledged = batch.filter(c => c.status === 'acknowledged').length;
          const failed = batch.filter(c => c.status === 'failed').length;
          const completed = acknowledged + failed;
          let phase = run.phase;
          if (failed > 0 && completed >= batch.length) phase = 'failed';
          else if (completed >= batch.length) phase = 'complete';
          else if (sent > 0 || acknowledged > 0) phase = 'delivering';
          else if (pending > 0) phase = 'waiting';
          next[deviceId] = { ...run, pending, sent, acknowledged, failed, completed, phase };
        });
        return next;
      });
    } catch { /* keep last known real-time state */ }
  };
  useEffect(() => {
    loadCmdQueue();
    const t = setInterval(loadCmdQueue, Object.values(syncRuns).some(r => ['starting', 'queued', 'waiting', 'delivering'].includes(r?.phase)) ? 2000 : 8000);
    return () => clearInterval(t);
  }, [Object.values(syncRuns).map(r => r?.phase).join('|')]);

  const clearQueue = async () => {
    try { await api.delete('/identix/cmd-queue'); toast.success('Queue cleared'); loadCmdQueue(); }
    catch { toast.error('Clear failed'); }
  };

  const setField = (field, val) => setForm(f => ({ ...f, [field]: val }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Biometric Devices</h3>
        <button onClick={() => openNew()} style={{ padding: '8px 16px', background: COLORS.deepBlue, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} />Add Device Manually
        </button>
      </div>

      {/* LAN Scanner hidden — ADMS domain mode only */}

      {/* ADMS Setup Guide */}
      <div style={{ background: '#f0f9ff', border: '1.5px solid #bae6fd', borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Network size={16} color="#0284c7" />
            <span style={{ fontWeight: 700, fontSize: 13, color: '#0c4a6e' }}>ADMS Cloud Setup</span>
            <span style={{ fontSize: 12, color: '#0369a1' }}>— Configure your machine to push attendance to this server</span>
          </div>
          <button onClick={() => setShowSetupGuide(g => !g)}
            style={{ fontSize: 12, fontWeight: 600, color: '#0284c7', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {showSetupGuide ? 'Hide' : 'Show'} Setup Guide
          </button>
        </div>
        {showSetupGuide && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#0c4a6e', fontWeight: 600, marginBottom: 10 }}>
              Set these values on your Identix machine (Menu → Comm → Cloud Server / ADMS):
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px', fontSize: 13 }}>
              {[
                ['Server Address', 'api.taskosphere.com'],
                ['Port', '443'],
                ['ADMS', 'Enable / ON'],
              ].map(([label, val]) => (
                <React.Fragment key={label}>
                  <div style={{ color: '#64748b', fontWeight: 600 }}>{label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ background: '#e0f2fe', color: '#0c4a6e', padding: '2px 8px', borderRadius: 5, fontWeight: 700, fontSize: 13 }}>{val}</code>
                    {val !== '(leave blank — not required)' && val !== 'Enable / ON' && (
                      <button onClick={() => { navigator.clipboard.writeText(val); toast.success('Copied!'); }}
                        style={{ fontSize: 11, color: '#0284c7', background: 'none', border: '1px solid #bae6fd', borderRadius: 4, padding: '1px 7px', cursor: 'pointer' }}>
                        Copy
                      </button>
                    )}
                  </div>
                </React.Fragment>
              ))}
            </div>
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, fontSize: 12, color: '#713f12', lineHeight: 1.6 }}>
              <b>⚠️ Important:</b> Use <b>api.taskosphere.com</b> (not www.taskosphere.com) as the Server Address. The machine pushes attendance to <b>api.taskosphere.com/iclock/cdata</b> automatically.<br/><br/>
              <b>Server Path:</b> Leave it <b>blank</b> — it is not needed on most Identix models.<br/><br/>
              After saving, wait <b>1–2 minutes</b> then click <b>Check ADMS</b> — status turns <b>🟢 Online</b> once connected. Users pushed from software will appear on the machine within ~1 minute.
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : !devices.length ? (
        <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 48, textAlign: 'center', color: '#94a3b8' }}>
          <Monitor size={36} color="#cbd5e1" style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>No devices registered</div>
          <div style={{ fontSize: 13 }}>Click "Add Device" and enter your machine's serial number.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {devices.map(d => {
            const tr = testResults[d.id];
            return (
              <div key={d.id} style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <Monitor size={18} color={COLORS.mediumBlue} />
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{d.name}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: d.is_active ? '#d1fae5' : '#fee2e2', color: d.is_active ? '#065f46' : '#991b1b' }}>{d.is_active ? 'Active' : 'Inactive'}</span>
                    {d.is_online
                      ? <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: '#d1fae5', color: '#065f46' }}>🟢 Online</span>
                      : <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: '#fef3c7', color: '#92400e' }}>⏳ Awaiting Heartbeat</span>
                    }
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.slate, display: 'flex', flexWrap: 'wrap', gap: '3px 16px' }}>
                    <span>🌐 ADMS (Domain)</span>
                    {d.serial_number && <span>S/N: <b>{d.serial_number}</b></span>}
                    {d.location && <span>📍 {d.location}</span>}
                    {d.last_heartbeat_at && <span>Last seen: {fmtTime(d.last_heartbeat_at)}</span>}
                    {d.last_sync_at && <span>Last sync: {fmtTime(d.last_sync_at)}</span>}
                  </div>
                  {tr && !tr.testing && (
                    <div style={{ marginTop: 8, padding: '7px 12px', borderRadius: 8, fontSize: 12, background: tr.success ? '#d1fae5' : '#fee2e2', color: tr.success ? '#065f46' : '#991b1b' }}>
                      {tr.success
                        ? `✓ ADMS Connected — S/N: ${tr.deviceInfo?.serialNumber || d.serial_number} · Last heartbeat ${tr.minutes_since_heartbeat}m ago`
                        : `✗ ${tr.message}`}
                    </div>
                  )}
                  {tr?.testing && <div style={{ marginTop: 8, fontSize: 12, color: COLORS.slate, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />Checking ADMS connection…</div>}
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', flexShrink: 0 }}>
                  {[
                    { label: 'Check ADMS', icon: Radar,     color: '#3b82f6', action: () => checkADMS(d),  loading: testingId === d.id  },
                    { label: 'Sync Users', icon: UsersIcon, color: COLORS.green, action: () => syncUsers(d), loading: syncingId === d.id },
                    { label: 'Edit',       icon: Edit,      color: '#374151', action: () => openEdit(d), loading: false },
                    { label: 'Delete',     icon: Trash2,    color: COLORS.red,  action: () => remove(d),  loading: false },
                  ].map(btn => (
                    <button key={btn.label} onClick={btn.action} disabled={btn.loading}
                      style={{ padding: '6px 11px', background: 'transparent', color: btn.loading ? '#94a3b8' : btn.color, border: `1.5px solid ${btn.loading ? '#e2e8f0' : btn.color}`, borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: btn.loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <btn.icon size={12} />
                      {btn.loading ? '…' : btn.label}
                    </button>
                  ))}
                </div>
                {(() => {
                  const run = syncRuns[d.id];
                  if (!run || !run.total) return null;
                  const total = run.total || 0;
                  const completed = run.completed || 0;
                  const sent = run.sent || 0;
                  const pending = run.pending || 0;
                  const failed = run.failed || 0;
                  const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
                  const deliveryPct = total ? Math.min(100, Math.round(((sent + completed) / total) * 100)) : 0;
                  const phaseText = run.phase === 'starting' ? 'Starting sync…'
                    : run.phase === 'queued' ? `Queued ${total} users — waiting for machine poll…`
                    : run.phase === 'waiting' ? `Waiting for ADMS machine to pick up commands (${pending} pending)`
                    : run.phase === 'delivering' ? `Machine is processing users — ${completed}/${total} confirmed`
                    : run.phase === 'failed' ? `Sync finished with ${failed} failure${failed === 1 ? '' : 's'}`
                    : `Sync complete — ${completed}/${total}`;
                  return (
                    <div style={{ width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 7 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: run.phase === 'failed' ? '#ef4444' : '#10b981', boxShadow: run.phase === 'failed' ? 'none' : '0 0 0 4px rgba(16,185,129,.12)', animation: ['starting','queued','waiting','delivering'].includes(run.phase) ? 'pulse 1.4s ease-in-out infinite' : 'none', flexShrink: 0 }} />
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{phaseText}</span>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{completed}/{total}</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden', position: 'relative' }}>
                        <div style={{ position: 'absolute', inset: 0, width: `${deliveryPct}%`, background: 'linear-gradient(90deg,#60a5fa,#22c55e)', transition: 'width .35s ease' }} />
                        <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: '#16a34a', transition: 'width .35s ease' }} />
                        {['starting','queued','waiting','delivering'].includes(run.phase) && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.65) 50%, transparent 100%)', animation: 'admsShimmer 1.3s linear infinite', width: '45%' }} />}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10.5, color: '#64748b' }}>
                        <span>Delivered: {Math.min(total, sent + completed)}</span>
                        <span>Confirmed: {completed}</span>
                        <span>Pending: {pending}</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* ADMS Command Queue */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>📤 Command Queue</span>
            {cmdQueueCount > 0 && (
              <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '2px 10px' }}>
                {cmdQueueCount} pending
              </span>
            )}
            {cmdQueueCount === 0 && (
              <span style={{ background: '#d1fae5', color: '#065f46', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '2px 10px' }}>All sent</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={loadCmdQueue} style={{ fontSize: 12, fontWeight: 600, color: '#3b82f6', background: 'none', border: '1px solid #bae6fd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>↻ Refresh</button>
            <button onClick={() => setShowCmdQueue(q => !q)} style={{ fontSize: 12, fontWeight: 600, color: '#64748b', background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>{showCmdQueue ? 'Hide' : 'Show'} Log</button>
            {cmdQueue.some(c => c.status === 'sent') && (
              <button onClick={clearQueue} style={{ fontSize: 12, fontWeight: 600, color: COLORS.red, background: 'none', border: `1px solid ${COLORS.red}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>🗑 Clear Sent</button>
            )}
            {cmdQueue.length > 0 && (
              <button onClick={async () => { if (!window.confirm('Delete ALL commands including pending? This cannot be undone.')) return; try { await api.delete('/identix/cmd-queue'); toast.success('Queue cleared'); loadCmdQueue(); } catch { toast.error('Failed'); } }}
                style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>🗑 Delete All</button>
            )}
          </div>
        </div>
        {showCmdQueue && (
          <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
            {!cmdQueue.length ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No commands in queue</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: `1px solid ${COLORS.border}` }}>
                    {['Device SN', 'Command', 'Status', 'Queued At', 'Sent At'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: COLORS.slate, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cmdQueue.map((c, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid #f8fafc` }}>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11 }}>{c.device_serial}</td>
                      <td style={{ padding: '7px 12px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.cmd_str}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: c.status === 'pending' ? '#fef3c7' : c.status === 'sent' ? '#d1fae5' : '#fee2e2',
                          color: c.status === 'pending' ? '#92400e' : c.status === 'sent' ? '#065f46' : '#991b1b',
                        }}>{c.status}</span>
                      </td>
                      <td style={{ padding: '7px 12px', color: COLORS.slate }}>{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</td>
                      <td style={{ padding: '7px 12px', color: COLORS.slate }}>{c.sent_at ? new Date(c.sent_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 12, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '8px 12px' }}>
          💡 When you click "Push to Device" or "Sync Users", a command is queued here. The machine picks it up within ~1 minute when it polls the server. After the user appears on the machine, they can enroll their fingerprint.
        </div>
      </div>

      {/* Device Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(6,78,59,0.5)', zIndex: 9900, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '40px 16px' }}
          onClick={() => setShowModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px 14px', borderBottom: `1px solid ${COLORS.border}` }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{editing ? 'Edit Device' : 'Add Identix Device'}</h3>
              <button onClick={() => setShowModal(false)} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={15} color={COLORS.slate} /></button>
            </div>
            <div style={{ padding: '18px 22px 22px' }}>
              {/* ADMS Domain badge */}
              <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f0f9ff', border: '1.5px solid #bae6fd', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>🌐</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#0c4a6e' }}>ADMS Domain Connection</div>
                  <div style={{ fontSize: 12, color: '#0369a1', marginTop: 2 }}>Machine connects to server via domain — no IP needed. Just enter the serial number and the machine handles the rest.</div>
                </div>
              </div>
              {[
                { label: 'Device Name *',   key: 'name',          type: 'text', placeholder: 'e.g. Main Entrance' },
                { label: 'Serial Number *', key: 'serial_number', type: 'text', placeholder: 'e.g. CGKK212461298  (from machine back label)' },
                { label: 'Location',        key: 'location',      type: 'text', placeholder: 'e.g. Ground Floor' },
              ].map(f => (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{f.label}</label>
                  <input type={f.type} placeholder={f.placeholder} value={form[f.key]} onChange={e => setField(f.key, e.target.value)} style={inputStyleIdentix} />
                </div>
              ))}
              {editing && (
                <div style={{ marginTop: 14 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Status</label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[true, false].map(v => (
                      <button key={String(v)} onClick={() => setField('is_active', v)} style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', border: `2px solid ${form.is_active === v ? (v ? COLORS.green : COLORS.red) : COLORS.border}`, background: form.is_active === v ? (v ? '#d1fae5' : '#fee2e2') : '#fff', color: form.is_active === v ? (v ? '#065f46' : '#991b1b') : COLORS.slate }}>
                        {v ? 'Active' : 'Inactive'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22, paddingTop: 14, borderTop: `1px solid ${COLORS.border}` }}>
                <button onClick={() => setShowModal(false)} style={{ padding: '8px 16px', background: 'transparent', color: COLORS.slate, border: `1.5px solid ${COLORS.border}`, borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button onClick={save} disabled={saving} style={{ padding: '8px 18px', background: saving ? '#e2e8f0' : COLORS.deepBlue, color: saving ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {saving ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />Saving…</> : <><Save size={13} />{editing ? 'Update' : 'Add Device'}</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// IDENTIX — ATTENDANCE SYNC TAB
// (Machine punches sync into the main attendance collection via backend)
// ════════════════════════════════════════════════════════════════════════════════
function IdentixAttendanceTab() {
  const [records, setRecords] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [page,    setPage]    = useState(1);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filters, setFilters] = useState({ from_date: '', to_date: '', department: '' });
  const LIMIT = 50;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = { page: p, limit: LIMIT };
      if (filters.from_date)  params.from_date  = filters.from_date;
      if (filters.to_date)    params.to_date    = filters.to_date;
      if (filters.department) params.department = filters.department;
      const { data } = await api.get('/identix/attendance', { params });
      setRecords(data.records || []); setTotal(data.total || 0);
    } catch { toast.error('Failed to load attendance'); }
    finally { setLoading(false); }
  }, [page, filters]);

  useEffect(() => { load(1); }, [filters]);
  useEffect(() => { load(page); }, [page]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/identix/attendance/sync', {});
      toast.success(`Synced! ${data.newRecords} new records imported into attendance`);
      load(1);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Sync failed'); }
    finally { setSyncing(false); }
  };

  const totalPages = Math.ceil(total / LIMIT);

  const pill = (bg, color, text) => (
    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: bg, color }}>{text}</span>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Machine Attendance Records</h3>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: COLORS.slate }}>Synced punches are automatically added to the main attendance system</p>
        </div>
        <button onClick={handleSync} disabled={syncing}
          style={{ padding: '8px 16px', background: syncing ? '#e2e8f0' : COLORS.green, color: syncing ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: syncing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          {syncing ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />Syncing…</> : <><RefreshCw size={13} />Sync From Machine</>}
        </button>
      </div>

      {/* Info banner */}
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <CheckCircle size={15} color={COLORS.mediumBlue} />
        <span style={{ color: '#1e40af' }}>Machine punches sync directly into the <b>main attendance</b> — users see them alongside app punch-ins in the Attendance page.</span>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {[{ label: 'FROM DATE', key: 'from_date', type: 'date', width: 150 }, { label: 'TO DATE', key: 'to_date', type: 'date', width: 150 }].map(f => (
          <div key={f.key}>
            <label style={{ fontSize: 11, color: COLORS.slate, fontWeight: 600, display: 'block', marginBottom: 3 }}>{f.label}</label>
            <input type={f.type} value={filters[f.key]} style={{ ...inputStyleIdentix, width: f.width }} onChange={e => setFilters(p => ({ ...p, [f.key]: e.target.value }))} />
          </div>
        ))}
        <div>
          <label style={{ fontSize: 11, color: COLORS.slate, fontWeight: 600, display: 'block', marginBottom: 3 }}>DEPARTMENT</label>
          <input type="text" placeholder="e.g. GST" value={filters.department} style={{ ...inputStyleIdentix, width: 160 }} onChange={e => setFilters(p => ({ ...p, department: e.target.value }))} />
        </div>
        {(filters.from_date || filters.to_date || filters.department) && (
          <div style={{ alignSelf: 'flex-end' }}>
            <button onClick={() => setFilters({ from_date: '', to_date: '', department: '' })} style={{ padding: '8px 12px', background: 'transparent', color: COLORS.red, border: `1.5px solid ${COLORS.red}`, borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <X size={12} />Clear
            </button>
          </div>
        )}
      </div>

      <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: `2px solid ${COLORS.border}` }}>
              {['Employee', 'Department', 'Punch Time', 'Type', 'Source', 'Device'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', color: COLORS.slate, fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
            ) : !records.length ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>No records. Click "Sync From Machine" to import punches.</td></tr>
            ) : records.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f8fafc' }}>
                <td style={{ padding: '10px 14px', fontWeight: 600 }}>{r.user_name || '—'}</td>
                <td style={{ padding: '10px 14px', color: COLORS.slate }}>{r.department || '—'}</td>
                <td style={{ padding: '10px 14px' }}>{fmtTime(r.punch_time)}</td>
                <td style={{ padding: '10px 14px' }}>{pill(r.punch_type === 'in' ? '#d1fae5' : '#fee2e2', r.punch_type === 'in' ? '#065f46' : '#991b1b', r.punch_type === 'in' ? 'Punch In' : 'Punch Out')}</td>
                <td style={{ padding: '10px 14px' }}>{pill('#ede9fe', '#5b21b6', 'Machine')}</td>
                <td style={{ padding: '10px 14px', color: COLORS.slate }}>{r.device_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{ padding: '6px 12px', background: 'transparent', color: COLORS.mediumBlue, border: `1.5px solid ${COLORS.mediumBlue}`, borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: page === 1 ? 'not-allowed' : 'pointer' }}>← Prev</button>
          <span style={{ fontSize: 13, color: COLORS.slate }}>Page {page} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ padding: '6px 12px', background: 'transparent', color: COLORS.mediumBlue, border: `1.5px solid ${COLORS.mediumBlue}`, borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: page === totalPages ? 'not-allowed' : 'pointer' }}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// IDENTIX — ENROLLMENT TAB
// ════════════════════════════════════════════════════════════════════════════════
function IdentixEnrollmentTab() {
  const [users,     setUsers]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [filter,    setFilter]    = useState('all'); // 'all' | 'not_enrolled' | 'enrolled'
  const [syncingId, setSyncingId] = useState(null);
  const [thumbId,   setThumbId]   = useState(null);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/identix/users'); setUsers(data.users || []); }
    catch { toast.error('Failed to load enrollment data'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const markThumb = async (userId) => {
    setThumbId(userId);
    try {
      await api.patch(`/identix/users/${userId}/thumb-enrolled`);
      toast.success('Thumb enrollment marked complete');
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, thumb_enrolled: true } : u));
    } catch { toast.error('Failed to update'); }
    finally { setThumbId(null); }
  };

  const syncToDevice = async (userId, name) => {
    setSyncingId(userId);
    try {
      const { data } = await api.post(`/identix/users/${userId}/sync-to-device`);
      toast.success(data.message || `${name} queued — machine will receive on next poll (~1 min)`);
      load();
    }
    catch (e) { toast.error(e?.response?.data?.detail || 'Sync failed'); }
    finally { setSyncingId(null); }
  };

  const filtered = users.filter(u => {
    const matchSearch = !search || u.full_name?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' ? true : filter === 'not_enrolled' ? !u.thumb_enrolled : u.thumb_enrolled;
    return matchSearch && matchFilter;
  });

  const notEnrolledCount = users.filter(u => !u.thumb_enrolled).length;
  const enrolledCount    = users.filter(u => u.thumb_enrolled).length;

  const pill = (bg, color, text) => <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: bg, color }}>{text}</span>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Biometric Enrollment</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Filter buttons */}
          {[
            { key: 'all',          label: `All (${users.length})` },
            { key: 'not_enrolled', label: `❌ Not Enrolled (${notEnrolledCount})` },
            { key: 'enrolled',     label: `✅ Enrolled (${enrolledCount})` },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1.5px solid',
                background: filter === f.key ? '#0f172a' : 'transparent',
                color:      filter === f.key ? '#fff'    : '#374151',
                borderColor: filter === f.key ? '#0f172a' : '#e2e8f0',
              }}>{f.label}</button>
          ))}
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employees…" style={{ ...inputStyleIdentix, paddingLeft: 30, width: 190 }} />
          </div>
        </div>
      </div>

      {/* Summary bar */}
      {notEnrolledCount > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 14px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12, color: '#9a3412', display: 'flex', alignItems: 'center', gap: 8 }}>
          ⚠️ <strong>{notEnrolledCount} employee{notEnrolledCount > 1 ? 's' : ''}</strong> not yet enrolled — push them to the device and have them scan their fingerprint on the machine.
        </div>
      )}

      <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: `2px solid ${COLORS.border}` }}>
              {['Name', 'Role / Dept', 'Device UID', 'Device Status', 'Fingerprint', 'Actions'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', color: COLORS.slate, fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
            ) : !filtered.length ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>No users found</td></tr>
            ) : filtered.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #f8fafc', background: !u.thumb_enrolled ? '#fffbeb' : '#fff' }}>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!u.thumb_enrolled && <span style={{ fontSize: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>NOT ENROLLED</span>}
                    {u.full_name}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.slate }}>{u.email}</div>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ textTransform: 'capitalize', color: '#374151' }}>{u.role}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{u.departments?.join(', ') || '—'}</div>
                </td>
                <td style={{ padding: '10px 14px', color: COLORS.slate, fontFamily: 'monospace' }}>
                  {u.identix_uid ?? <span style={{ color: '#94a3b8' }}>Not assigned</span>}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {pill(u.identix_enrolled ? '#d1fae5' : '#fee2e2', u.identix_enrolled ? '#065f46' : '#991b1b', u.identix_enrolled ? 'Synced' : 'Not Synced')}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {u.thumb_enrolled
                    ? pill('#dbeafe', '#1e40af', '✓ Enrolled')
                    : pill('#fee2e2', '#991b1b', '✗ Not Enrolled')}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    {!u.thumb_enrolled && (
                      <button onClick={() => markThumb(u.id)} disabled={thumbId === u.id}
                        style={{ padding: '5px 10px', background: COLORS.green, color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 11, cursor: thumbId === u.id ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Fingerprint size={11} />{thumbId === u.id ? '…' : 'Mark Thumb'}
                      </button>
                    )}
                    <button onClick={() => syncToDevice(u.id, u.full_name)} disabled={syncingId === u.id}
                      style={{ padding: '5px 10px', background: 'transparent', color: COLORS.mediumBlue, border: `1.5px solid ${COLORS.mediumBlue}`, borderRadius: 7, fontWeight: 600, fontSize: 11, cursor: syncingId === u.id ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <RefreshCw size={11} />{syncingId === u.id ? '…' : 'Push to Device'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// IDENTIX — DASHBOARD TAB
// ════════════════════════════════════════════════════════════════════════════════
function IdentixDashboardTab() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get('/identix/attendance/summary'); setSummary(data); }
    catch { toast.error('Failed to load summary'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const StatCard = ({ label, value, color, icon: Icon }) => (
    <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '16px 20px', flex: 1, minWidth: 130 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16} color={color} />
        </span>
        <span style={{ fontSize: 12, color: COLORS.slate }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a' }}>{value ?? '—'}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
          Today — {summary?.date || 'Loading…'}
        </h3>
        <button onClick={load} disabled={loading} style={{ padding: '7px 14px', background: 'transparent', color: COLORS.mediumBlue, border: `1.5px solid ${COLORS.mediumBlue}`, borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />Refresh
        </button>
      </div>

      {loading && !summary ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
            <StatCard label="Total Employees"  value={summary?.totalEmployees}         color={COLORS.mediumBlue}  icon={UsersIcon}     />
            <StatCard label="Present (Machine)" value={summary?.totalPresent}           color={COLORS.green}       icon={CheckCircle}   />
            <StatCard label="Absent"            value={summary?.totalAbsent}            color={COLORS.red}         icon={AlertTriangle} />
            <StatCard label="Pending Thumb"     value={summary?.pendingThumbEnrollment} color={COLORS.amber}       icon={Fingerprint}   />
          </div>

          {summary?.byDepartment?.length > 0 && (
            <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 700 }}>By Department</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {summary.byDepartment.map(d => (
                  <div key={d.department || '—'} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, color: '#374151', minWidth: 120 }}>{d.department || 'Unassigned'}</span>
                    <div style={{ flex: 1, height: 8, background: '#f1f5f9', borderRadius: 10, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 10, background: '#3b82f6', width: `${Math.min(100, (d.present / (summary.totalEmployees || 1)) * 100)}%` }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.green, minWidth: 65 }}>{d.present} present</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
              <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recent Machine Punches</h4>
            </div>
            {!summary?.recentActivity?.length ? (
              <div style={{ color: '#94a3b8', textAlign: 'center', padding: 24 }}>No punches recorded yet today</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: `2px solid ${COLORS.border}` }}>
                    {['Employee', 'Department', 'Punch Time', 'Type', 'Device'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 14px', color: COLORS.slate, fontWeight: 600, fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.recentActivity.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f8fafc' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>{r.user_name || '—'}</td>
                      <td style={{ padding: '9px 14px', color: COLORS.slate }}>{r.department || '—'}</td>
                      <td style={{ padding: '9px 14px' }}>{fmtTime(r.punch_time)}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: r.punch_type === 'in' ? '#d1fae5' : '#fee2e2', color: r.punch_type === 'in' ? '#065f46' : '#991b1b' }}>
                          {r.punch_type === 'in' ? 'Punch In' : 'Punch Out'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', color: COLORS.slate }}>{r.device_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT COMPONENTS (original)
// ════════════════════════════════════════════════════════════════════════════════
const PendingUserCard = ({ userData, onApprove, onReject, approving }) => (
  <motion.div variants={itemVariants} whileHover={{ y: -3, transition: springPhysics.lift }} layout
    className="bg-white dark:bg-slate-800 rounded-2xl overflow-hidden border border-amber-200 dark:border-amber-800 shadow-sm hover:shadow-xl transition-all duration-300">
    <div className="h-1.5 w-full" style={{ background: 'linear-gradient(90deg, #f59e0b, #f97316)' }} />
    <div className="p-5">
      <div className="flex items-start gap-4">
        <div className="relative flex-shrink-0">
          <div className="w-14 h-14 rounded-xl overflow-hidden shadow-sm ring-1 ring-amber-100 dark:ring-amber-900">
            {userData.profile_picture
              ? <img src={userData.profile_picture} alt={userData.full_name} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-white text-xl font-black" style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)' }}>
                  {userData.full_name?.charAt(0)?.toUpperCase()}
                </div>}
          </div>
          <div className="absolute -bottom-1 -right-1 bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-300 rounded-full p-1 border-2 border-white dark:border-slate-800">
            <Clock className="h-3 w-3" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-base text-slate-900 dark:text-white tracking-tight truncate">{userData.full_name}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{userData.email}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 capitalize">{userData.role}</span>
            <StatusBadge status={userData.status} />
          </div>
        </div>
      </div>
      {(userData.departments || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-4">{userData.departments.map(d => <DeptPill key={d} dept={d} />)}</div>
      )}
      <div className="mt-4 space-y-2 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-slate-400" />{userData.phone || '—'}</div>
        <div className="flex items-center gap-2"><Calendar className="h-3.5 w-3.5 text-slate-400" />
          Registered {userData.created_at ? format(new Date(userData.created_at), 'dd MMM yyyy') : 'N/A'}
        </div>
      </div>
      <div className="flex gap-2.5 mt-5">
        <Button onClick={() => onApprove(userData)} disabled={approving === userData.id}
          className="flex-1 h-10 rounded-xl font-semibold text-sm shadow-sm hover:shadow-md transition-all"
          style={{ background: COLORS.emeraldGreen, color: 'white' }}>
          <UserCheck className="h-4 w-4 mr-1.5" />{approving === userData.id ? 'Approving…' : 'Approve'}
        </Button>
        <Button onClick={() => onReject(userData)} disabled={approving === userData.id}
          variant="outline" className="flex-1 h-10 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-semibold text-sm">
          <UserX className="h-4 w-4 mr-1.5" />Reject
        </Button>
      </div>
    </div>
  </motion.div>
);

const UserCard = ({ userData, onEdit, onDelete, onOffboard, onPermissions, onApprove, onReject, currentUserId, isAdmin, isManager, canEditUsers, canManagePermissions, approving }) => {
  const [hovered, setHovered] = useState(false);
  const isPending = userData.status === 'pending_approval';
  const roleCfg   = ROLE_CONFIG[userData.role?.toLowerCase()] || ROLE_CONFIG.staff;
  const RoleIcon  = roleCfg.icon;
  const permCount = useMemo(() =>
    userData.permissions ? Object.entries(userData.permissions).filter(([k, v]) => k.startsWith('can_') && v === true).length : 0
  , [userData.permissions]);

  return (
    <motion.div variants={itemVariants} layout whileHover={{ y: -5, transition: springPhysics.lift }} whileTap={{ scale: 0.99 }}
      className={`group relative bg-white dark:bg-slate-800 rounded-2xl overflow-hidden border shadow-sm transition-all duration-300 ${
        isPending ? 'border-amber-200 dark:border-amber-800 hover:shadow-xl hover:shadow-amber-100/50' : hovered ? 'border-blue-200 dark:border-blue-700 hover:shadow-2xl hover:shadow-blue-100/60 dark:hover:shadow-blue-900/30' : 'border-slate-200/80 dark:border-slate-700 hover:shadow-xl'
      }`}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className={`h-1.5 w-full bg-gradient-to-r ${roleCfg.gradient}`} />
      {/* subtle role-tinted decor */}
      <div className="pointer-events-none absolute -right-12 -top-12 w-40 h-40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: `radial-gradient(circle, ${roleCfg.hex}1f 0%, transparent 70%)` }} />
      <AnimatePresence>
        {hovered && !isPending && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
            className="absolute top-4 right-4 flex gap-1.5 z-20">
            {/* Permissions button: Admin can manage anyone (except admin role targets).
                Manager with can_manage_users can manage their team STAFF only. */}
            {canManagePermissions && userData.role !== 'admin' &&
              (isAdmin || userData.role === 'staff') && (
              <button onClick={() => onPermissions(userData)} title="Manage Permissions"
                className="w-8 h-8 bg-emerald-50 dark:bg-emerald-900/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-emerald-600 dark:text-emerald-400 rounded-xl flex items-center justify-center border border-emerald-100 dark:border-emerald-800 shadow-sm transition-all">
                <Shield className="h-3.5 w-3.5" />
              </button>
            )}
            {(isAdmin || (canEditUsers && !isPending)) && (
              <button onClick={() => onEdit(userData)} title="Edit User"
                className="w-8 h-8 bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-600 dark:text-blue-400 rounded-xl flex items-center justify-center border border-blue-100 dark:border-blue-800 shadow-sm transition-all">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Delete button: Admin only per permission matrix */}
            {isAdmin && userData.id !== currentUserId && (
              <button onClick={() => onDelete(userData.id)} title="Delete User"
                className="w-8 h-8 bg-red-50 dark:bg-red-900/40 hover:bg-red-100 dark:hover:bg-red-900/60 text-red-600 dark:text-red-400 rounded-xl flex items-center justify-center border border-red-100 dark:border-red-800 shadow-sm transition-all">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            {isAdmin && userData.id !== currentUserId && (
              <button onClick={() => onOffboard(userData)} title="Offboard & Replace"
                className="w-8 h-8 bg-amber-50 dark:bg-amber-900/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-amber-600 dark:text-amber-400 rounded-xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shadow-sm transition-all">
                <UserMinus className="h-3.5 w-3.5" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="relative p-4 sm:p-5">
        <div className="flex items-start gap-3.5">
          <div className="relative flex-shrink-0">
            <div className="w-[60px] h-[60px] rounded-2xl overflow-hidden shadow-md ring-4 ring-slate-50 dark:ring-slate-700/50 group-hover:ring-blue-50 dark:group-hover:ring-blue-900/30 transition-all duration-300">
              {userData.profile_picture
                ? <img src={userData.profile_picture} alt={userData.full_name} className="w-full h-full object-cover" />
                : <div className={`w-full h-full flex items-center justify-center text-white text-2xl font-black bg-gradient-to-br ${roleCfg.gradient}`}>
                    {userData.full_name?.charAt(0)?.toUpperCase()}
                  </div>}
            </div>
            {/* live status dot */}
            <span className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ring-[3px] ring-white dark:ring-slate-800 ${
              isPending ? 'bg-amber-400' : userData.is_active ? 'bg-emerald-500' : 'bg-slate-300'
            }`} />
            <div className={`absolute -top-1 -left-1 w-5 h-5 rounded-lg bg-gradient-to-br ${roleCfg.gradient} flex items-center justify-center ring-2 ring-white dark:ring-slate-800 shadow-sm`}>
              <RoleIcon className="h-2.5 w-2.5 text-white" />
            </div>
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="font-bold text-[15px] tracking-tight text-slate-900 dark:text-white truncate">{userData.full_name}</h3>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white bg-gradient-to-r ${roleCfg.gradient} shadow-sm`}>
                <RoleIcon className="h-2.5 w-2.5" />{roleCfg.label}
              </span>
              <StatusBadge status={userData.status} isActive={userData.is_active} />
            </div>
          </div>
        </div>
        {(userData.departments || []).length > 0 && (
          <div className="mt-3.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1.5">Expertise</p>
            <div className="flex flex-wrap gap-1">{userData.departments.map(d => <DeptPill key={d} dept={d} />)}</div>
          </div>
        )}
        <ModuleAccessBadges userData={userData} />
        <div className={`mt-3.5 p-3 rounded-xl space-y-1.5 text-xs ${isPending ? 'bg-amber-50/40 dark:bg-amber-900/10' : 'bg-slate-50 dark:bg-slate-900/40'}`}>
          <div className="flex items-center gap-2 truncate text-slate-600 dark:text-slate-300"><Mail className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="truncate font-medium">{userData.email}</span></div>
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><Phone className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />{userData.phone || '—'}</div>
          {userData.company_name && (
            <div className="flex items-center gap-2 truncate text-slate-600 dark:text-slate-300"><Building2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="truncate">{userData.company_name}</span></div>
          )}
          {(userData.punch_in_time || userData.punch_out_time) && (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><Clock className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="tabular-nums">{userData.punch_in_time || '—'} → {userData.punch_out_time || '—'}</span></div>
          )}
          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><Calendar className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
            Joined {userData.created_at ? format(new Date(userData.created_at), 'dd MMM yyyy') : 'N/A'}
          </div>
        </div>
        {userData.role !== 'admin' && (
          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Permissions</span>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold"
              style={{ background: `${COLORS.mediumBlue}10`, color: COLORS.mediumBlue }}>
              <ShieldCheck className="h-3 w-3" />{permCount} active
            </div>
          </div>
        )}
        {isPending && isAdmin && (
          <div className="flex gap-2 mt-3 pt-3 border-t border-amber-100 dark:border-amber-900">
            <Button onClick={() => onApprove(userData)} disabled={approving === userData.id}
              className="flex-1 h-9 rounded-xl font-semibold text-xs" style={{ background: COLORS.emeraldGreen, color: 'white' }}>
              <UserCheck className="h-3.5 w-3.5 mr-1" />Approve
            </Button>
            <Button onClick={() => onReject(userData)} disabled={approving === userData.id}
              variant="outline" className="flex-1 h-9 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-semibold text-xs">
              <UserX className="h-3.5 w-3.5 mr-1" />Reject
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
};


// ════════════════════════════════════════════════════════════════════════════════
// OFFBOARDING DIALOG — Employee Replacement Workflow
// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
// OFFBOARDING DIALOG — Employee Replacement Workflow (REDESIGNED)
// ════════════════════════════════════════════════════════════════════════════════

function OffboardingDialog({ open, onClose, targetUser, allUsers, onComplete }) {
  const isDark = useDark();
  const [step, setStep]                   = useState(1);
  const [replacementId, setReplacementId] = useState('');
  const [searchTerm, setSearchTerm]       = useState('');
  const [newEmail, setNewEmail]           = useState('');
  const [notes, setNotes]                 = useState('');
  const [preview, setPreview]             = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [executing, setExecuting]         = useState(false);
  const [result, setResult]               = useState(null);
  const [transfers, setTransfers]         = useState({
    transfer_tasks: true, transfer_clients: true, transfer_dsc: true,
    transfer_documents: true, transfer_todos: true, transfer_visits: true,
    transfer_leads: true,
  });

  useEffect(() => {
    if (open && targetUser) {
      setStep(1); setReplacementId(''); setSearchTerm(''); setNewEmail('');
      setNotes(''); setPreview(null); setResult(null);
      setTransfers({ transfer_tasks:true, transfer_clients:true, transfer_dsc:true,
        transfer_documents:true, transfer_todos:true, transfer_visits:true, transfer_leads:true });
      (async () => {
        setLoadingPreview(true);
        try {
          const { data } = await api.get(`/users/${targetUser.id}/offboard-preview`);
          setPreview(data);
        } catch { toast.error('Failed to load offboarding preview'); }
        finally { setLoadingPreview(false); }
      })();
    }
  }, [open, targetUser?.id]);

  const eligibleUsers = useMemo(() =>
    allUsers
      .filter(u => u.id !== targetUser?.id && u.status !== 'pending_approval' && u.status !== 'rejected' && u.is_active !== false)
      .filter(u => !searchTerm || u.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) || u.email?.toLowerCase().includes(searchTerm.toLowerCase()))
  , [allUsers, targetUser?.id, searchTerm]);

  const selectedReplacement = useMemo(() => allUsers.find(u => u.id === replacementId), [allUsers, replacementId]);

  const handleExecute = async () => {
    if (!replacementId) { toast.error('Please select a replacement'); return; }
    setExecuting(true); setStep(4);
    try {
      const { data } = await api.post(`/users/${targetUser.id}/offboard`, {
        replacement_user_id: replacementId, ...transfers,
        update_email: newEmail || null, delete_old_user: true, notes: notes || null,
      });
      setResult(data);
      toast.success(data.message || 'Offboarding complete');
      if (onComplete) onComplete();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Offboarding failed');
      setStep(3);
    } finally { setExecuting(false); }
  };

  if (!open || !targetUser) return null;
  const roleCfg = ROLE_CONFIG[targetUser.role?.toLowerCase()] || ROLE_CONFIG.staff;
  const totalItems = preview?.total_items || 0;

  // Step labels for the progress indicator
  const STEPS = ['Preview', 'Select Replacement', 'Configure & Confirm'];

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !executing) onClose(); }}>
      <DialogContent
        className="p-0 overflow-hidden rounded-2xl border-0 shadow-2xl"
        style={{
          maxWidth: 680,
          width: '95vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Gradient Header ── */}
        <div className="relative overflow-hidden flex-shrink-0" style={{ background: 'linear-gradient(135deg, #7f1d1d 0%, #b91c1c 50%, #ef4444 100%)' }}>
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-24 -mt-24 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="relative px-6 py-5 flex items-start justify-between gap-4">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                <UserMinus className="h-5 w-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1">Employee Offboarding</p>
                <h2 className="text-xl font-bold text-white leading-snug tracking-tight">
                  {step === 4 && result ? 'Offboarding Complete' : `Offboard ${targetUser.full_name}`}
                </h2>
                <p className="text-white/55 text-sm mt-1">
                  {step === 4 && result ? result.message : 'Transfer data → Replace → Archive'}
                </p>
              </div>
            </div>
            {!executing && (
              <button onClick={onClose}
                className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center flex-shrink-0 transition-all active:scale-90 mt-0.5">
                <X className="h-4 w-4 text-white" />
              </button>
            )}
          </div>

          {/* Step progress bar inside header */}
          {step !== 4 && (
            <div className="px-6 pb-4">
              <div className="flex items-center gap-2">
                {STEPS.map((label, i) => {
                  const s = i + 1;
                  const isActive = s === step;
                  const isDone   = s < step;
                  return (
                    <React.Fragment key={s}>
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all ${
                          isDone   ? 'bg-white text-red-700' :
                          isActive ? 'bg-white/90 text-red-700 ring-2 ring-white/50' :
                                     'bg-white/20 text-white/60'
                        }`}>
                          {isDone ? '✓' : s}
                        </div>
                        <span className={`text-[11px] font-semibold whitespace-nowrap ${
                          isActive ? 'text-white' : isDone ? 'text-white/70' : 'text-white/40'
                        }`}>{label}</span>
                      </div>
                      {i < STEPS.length - 1 && (
                        <div className={`flex-1 h-0.5 rounded-full min-w-[16px] transition-all ${s < step ? 'bg-white/70' : 'bg-white/20'}`} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Scrollable Body ── */}
        <div className="flex-1 overflow-y-auto users-slim" style={slimScroll}>

          {/* STEP 1 — Preview */}
          {step === 1 && (
            <div className="p-6 space-y-5">
              {/* Target user card */}
              <div className={`flex items-center gap-4 p-4 rounded-2xl border ${isDark ? 'bg-red-950/20 border-red-900/40' : 'bg-red-50/80 border-red-200'}`}>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold bg-gradient-to-br ${roleCfg.gradient} flex-shrink-0`}>
                  {targetUser.full_name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-sm text-slate-900 dark:text-white">{targetUser.full_name}</p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white bg-gradient-to-r ${roleCfg.gradient}`}>
                      <roleCfg.icon className="h-2.5 w-2.5" />{roleCfg.label}
                    </span>
                    <Badge variant="destructive" className="text-[10px] h-5">Leaving</Badge>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{targetUser.email}</p>
                  {(targetUser.departments || []).length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {targetUser.departments.map(d => <DeptPill key={d} dept={d} />)}
                    </div>
                  )}
                </div>
              </div>

              {/* Data counts */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <BarChart2 className="h-4 w-4 text-blue-500" />
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">Data Owned by This Employee</h3>
                </div>
                {loadingPreview ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : preview ? (
                  <>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-3">
                      {Object.entries(preview.data_counts).map(([key, count]) => {
                        const label = key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
                        return (
                          <div key={key} className={`p-3 rounded-xl border text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                            <p className="text-2xl font-bold text-slate-900 dark:text-white leading-none">{count}</p>
                            <p className="text-[10px] text-slate-500 font-medium mt-1 leading-tight">{label}</p>
                          </div>
                        );
                      })}
                    </div>
                    <div className={`p-3.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 ${
                      totalItems > 0
                        ? isDark ? 'bg-amber-950/30 text-amber-400 border border-amber-900/50' : 'bg-amber-50 text-amber-700 border border-amber-200'
                        : isDark ? 'bg-emerald-950/30 text-emerald-400 border border-emerald-900/40' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    }`}>
                      <AlertCircle className="h-4 w-4 flex-shrink-0" />
                      {totalItems > 0
                        ? `${totalItems} total items will be transferred to the replacement`
                        : 'No data to transfer — account can be safely removed'}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          )}

          {/* STEP 2 — Select Replacement */}
          {step === 2 && (
            <div className="p-6 space-y-4">
              <div>
                <h3 className="font-bold text-sm text-slate-800 dark:text-white flex items-center gap-2 mb-1">
                  <UsersIcon className="h-4 w-4 text-blue-500" /> Select Replacement Employee
                </h3>
                <p className="text-xs text-slate-500">All data from {targetUser.full_name} will be transferred to this person</p>
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                <Input
                  placeholder="Search by name or email…"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className={`pl-10 h-10 rounded-xl text-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* User list */}
              <div className="space-y-2">
                {eligibleUsers.length === 0 ? (
                  <div className={`flex flex-col items-center py-10 rounded-2xl border border-dashed ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <UsersIcon className="h-8 w-8 text-slate-300 mb-2" />
                    <p className="text-sm text-slate-400">No eligible users found</p>
                  </div>
                ) : eligibleUsers.map(u => {
                  const uRole     = ROLE_CONFIG[u.role?.toLowerCase()] || ROLE_CONFIG.staff;
                  const URoleIcon = uRole.icon;
                  const isSelected = replacementId === u.id;
                  const depts = u.departments || [];

                  return (
                    <button
                      key={u.id}
                      onClick={() => setReplacementId(u.id)}
                      className={`w-full text-left rounded-2xl border-2 transition-all hover:shadow-sm overflow-hidden ${
                        isSelected
                          ? isDark ? 'border-emerald-500 bg-emerald-950/20' : 'border-emerald-500 bg-emerald-50'
                          : isDark ? 'border-slate-700 bg-slate-800 hover:border-slate-600' : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start gap-3.5 p-3.5">
                        {/* Avatar */}
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0 bg-gradient-to-br ${uRole.gradient}`}>
                          {u.profile_picture
                            ? <img src={u.profile_picture} alt="" className="w-full h-full object-cover rounded-xl" />
                            : u.full_name?.charAt(0)?.toUpperCase()}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          {/* Name + role badge row */}
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`font-semibold text-sm ${isSelected ? 'text-emerald-800 dark:text-emerald-200' : 'text-slate-900 dark:text-white'}`}>
                              {u.full_name}
                            </span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white bg-gradient-to-r ${uRole.gradient}`}>
                              <URoleIcon className="h-2.5 w-2.5" />{uRole.label}
                            </span>
                          </div>
                          {/* Email */}
                          <p className="text-[11px] text-slate-400 truncate mb-2">{u.email}</p>
                          {/* Dept pills — wrap freely, no truncation */}
                          {depts.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {depts.map(d => <DeptPill key={d} dept={d} />)}
                            </div>
                          )}
                        </div>

                        {/* Selected check */}
                        {isSelected && (
                          <div className="w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <CheckCircle className="h-4 w-4 text-white" />
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 3 — Configure Transfer */}
          {step === 3 && (
            <div className="p-6 space-y-5">
              {/* From → To banner */}
              <div className={`grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4 rounded-2xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0 bg-gradient-to-br ${roleCfg.gradient}`}>
                    {targetUser.full_name?.charAt(0)?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-xs text-red-600 dark:text-red-400 truncate">{targetUser.full_name}</p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">Leaving</p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <ArrowRight className="h-5 w-5 text-slate-400" />
                  <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide">Replace</p>
                </div>
                {selectedReplacement && (
                  <div className="flex items-center gap-2.5 min-w-0 justify-end">
                    <div className="min-w-0 text-right">
                      <p className="font-semibold text-xs text-emerald-600 dark:text-emerald-400 truncate">{selectedReplacement.full_name}</p>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">Replacement</p>
                    </div>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0 bg-gradient-to-br ${(ROLE_CONFIG[selectedReplacement.role?.toLowerCase()] || ROLE_CONFIG.staff).gradient}`}>
                      {selectedReplacement.full_name?.charAt(0)?.toUpperCase()}
                    </div>
                  </div>
                )}
              </div>

              {/* Transfer toggles */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <SlidersHorizontal className="h-4 w-4 text-blue-500" />
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">Transfer Options</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {TRANSFER_OPTIONS.map(opt => {
                    const Icon  = opt.icon;
                    const isOn  = !!transfers[opt.key];
                    const count = preview?.data_counts?.[opt.countKey] || 0;
                    return (
                      <div
                        key={opt.key}
                        className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                          isOn
                            ? isDark ? 'bg-emerald-950/25 border-emerald-800' : 'bg-emerald-50 border-emerald-200'
                            : isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                        onClick={() => setTransfers(p => ({ ...p, [opt.key]: !p[opt.key] }))}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${opt.color}18` }}>
                            <Icon className="h-4 w-4" style={{ color: opt.color }} />
                          </div>
                          <div>
                            <p className="font-semibold text-[13px] text-slate-800 dark:text-white">{opt.label}</p>
                            <p className="text-[11px] text-slate-400 leading-tight">{opt.desc}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                          {count > 0 && (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: `${opt.color}18`, color: opt.color }}>{count}</span>
                          )}
                          <Switch checked={isOn} onCheckedChange={v => setTransfers(p => ({ ...p, [opt.key]: v }))} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Optional email update */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Mail className="h-4 w-4 text-violet-500" />
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">Update Replacement's Email</h3>
                  <span className="text-[10px] text-slate-400 font-normal">(optional)</span>
                </div>
                <Input
                  placeholder={`e.g. ${targetUser.email}`}
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  className="h-10 rounded-xl text-sm"
                />
                <p className="text-[11px] text-slate-400 mt-1.5">Leave empty to keep {selectedReplacement?.email}</p>
              </div>

              {/* Notes */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">Offboarding Notes</h3>
                  <span className="text-[10px] text-slate-400 font-normal">(optional)</span>
                </div>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Reason for leaving, handover notes, etc."
                  rows={2}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400 transition-all ${
                    isDark ? 'bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400'
                  }`}
                />
              </div>

              {/* Warning */}
              <div className={`flex items-start gap-3 p-3.5 rounded-xl border text-xs ${isDark ? 'bg-red-950/25 border-red-900/50 text-red-300' : 'bg-red-50 border-red-200 text-red-700'}`}>
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-red-500" />
                <div>
                  <p className="font-bold mb-0.5">This action cannot be undone</p>
                  <p className="leading-relaxed">
                    {targetUser.full_name}'s account will be permanently deleted. All selected data will be transferred to {selectedReplacement?.full_name}. An audit log entry will be created.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4 — Result */}
          {step === 4 && (
            <div className="p-6">
              {executing ? (
                <div className="flex flex-col items-center py-14">
                  <Loader2 className="h-10 w-10 animate-spin text-blue-500 mb-4" />
                  <p className="font-bold text-sm text-slate-800 dark:text-white">Processing offboarding…</p>
                  <p className="text-xs text-slate-500 mt-1">Transferring data and removing account</p>
                </div>
              ) : result ? (
                <div className="space-y-5">
                  <div className="flex flex-col items-center py-6">
                    <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center mb-4">
                      <CheckCircle className="h-8 w-8 text-emerald-500" />
                    </div>
                    <p className="font-bold text-xl text-slate-900 dark:text-white">Offboarding Complete</p>
                    <p className="text-sm text-slate-500 mt-1 text-center max-w-xs">{result.message}</p>
                  </div>
                  <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <div className={`px-4 py-3 border-b text-xs font-semibold uppercase tracking-wider ${isDark ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                      Transfer Summary
                    </div>
                    <div className="p-4 grid grid-cols-2 gap-x-8 gap-y-2">
                      {Object.entries(result.transfer_summary || {}).map(([key, val]) => (
                        <div key={key} className="flex justify-between text-xs border-b border-slate-100 dark:border-slate-700/50 pb-2 last:border-0">
                          <span className="text-slate-500">{key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())}</span>
                          <span className={`font-semibold ${typeof val === 'boolean' ? (val ? 'text-emerald-600' : 'text-red-500') : 'text-slate-800 dark:text-white'}`}>
                            {typeof val === 'boolean' ? (val ? '✓' : '✗') : val}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* ── Sticky Footer ── */}
        {(step !== 4 || !result) ? (
          <div className={`px-6 py-4 border-t flex-shrink-0 flex items-center justify-between gap-4 ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-100 bg-white'}`}>
            <div className="text-xs text-slate-400">
              Step {step} of 3
            </div>
            <div className="flex gap-3">
              {step > 1 && !executing && (
                <Button variant="outline" onClick={() => setStep(s => s - 1)} className="h-10 px-5 rounded-xl text-sm">
                  ← Back
                </Button>
              )}
              {step === 1 && (
                <Button
                  onClick={() => setStep(2)}
                  className="h-10 px-6 rounded-xl font-semibold text-sm text-white"
                  style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
                >
                  Select Replacement <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}
              {step === 2 && (
                <Button
                  onClick={() => setStep(3)}
                  disabled={!replacementId}
                  className="h-10 px-6 rounded-xl font-semibold text-sm text-white"
                  style={{ background: replacementId ? 'linear-gradient(135deg, #0D3B66, #1F6FB2)' : '#94a3b8' }}
                >
                  Configure Transfer <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}
              {step === 3 && (
                <Button
                  onClick={handleExecute}
                  disabled={executing}
                  className="h-10 px-7 rounded-xl font-semibold text-sm text-white"
                  style={{ background: 'linear-gradient(135deg, #991b1b, #dc2626)' }}
                >
                  {executing ? 'Processing…' : 'Confirm Offboarding'}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className={`px-6 py-4 border-t flex-shrink-0 flex justify-end ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-100 bg-white'}`}>
            <Button onClick={onClose} className="h-10 px-8 rounded-xl font-semibold text-sm text-white" style={{ background: GRAD_GREEN }}>
              Done ✓
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// CLIENT PORTFOLIO TAB — extracted from IIFE to fix Rules-of-Hooks violation
// (useMemo + useState cannot be called inside IIFEs or regular functions)
// ════════════════════════════════════════════════════════════════════════════════
function ClientsPermTab({ permissions, clients, isDark, setPermissions, clientSearch, setClientSearch }) {
  const assignedClients = permissions.assigned_clients || [];

  const CLIENT_TYPE_LABELS = {
    pvt_ltd: 'Pvt Ltd', llp: 'LLP', partnership: 'Partnership',
    huf: 'HUF', trust: 'Trust', proprietor: 'Proprietor', other: 'Other',
  };
  const CLIENT_TYPE_COLORS = {
    pvt_ltd:     { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' },
    llp:         { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE' },
    partnership: { bg: '#FFFBEB', text: '#B45309', border: '#FDE68A' },
    huf:         { bg: '#F0FDFA', text: '#0F766E', border: '#99F6E4' },
    trust:       { bg: '#FFF1F2', text: '#BE123C', border: '#FECDD3' },
    proprietor:  { bg: '#F8FAFC', text: '#475569', border: '#CBD5E1' },
    other:       { bg: '#F0F9FF', text: '#0369A1', border: '#BAE6FD' },
  };
  const ALL_SERVICES = ['GST', 'Trademark', 'Income Tax', 'ROC', 'Audit', 'Compliance',
    'Company Registration', 'Tax Planning', 'Accounting', 'Payroll', 'Other'];

  // Hooks called at the top level of this proper component — no violations
  const presentServices = useMemo(() => {
    const s = new Set();
    clients.forEach(c => (c.services || []).forEach(sv => s.add(sv.replace('Other: ', 'Other'))));
    return ALL_SERVICES.filter(sv => s.has(sv));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  const [cpSvcFilter,  setCpSvcFilter]  = useState('');
  const [cpTypeFilter, setCpTypeFilter] = useState('');

  const filteredForTab = clients.filter(c => {
    const q = clientSearch.toLowerCase();
    if (q && !(c.company_name || '').toLowerCase().includes(q) &&
        !(c.phone || '').includes(clientSearch) &&
        !(c.email || '').toLowerCase().includes(q)) return false;
    if (cpSvcFilter && !(c.services || []).some(s => s === cpSvcFilter || s.replace('Other: ', 'Other') === cpSvcFilter)) return false;
    if (cpTypeFilter && (c.client_type || 'proprietor') !== cpTypeFilter) return false;
    return true;
  });

  const allFilteredSelected  = filteredForTab.length > 0 && filteredForTab.every(c => assignedClients.includes(c.id));
  const someFilteredSelected = filteredForTab.some(c => assignedClients.includes(c.id));

  const toggleAll = () => {
    if (allFilteredSelected) {
      const toRemove = new Set(filteredForTab.map(c => c.id));
      setPermissions(p => ({ ...p, assigned_clients: (p.assigned_clients || []).filter(id => !toRemove.has(id)) }));
    } else {
      const toAdd = filteredForTab.map(c => c.id);
      setPermissions(p => ({ ...p, assigned_clients: [...new Set([...(p.assigned_clients || []), ...toAdd])] }));
    }
  };

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <SectionHeader icon={Briefcase} title="Client Portfolio" color={COLORS.teal} />
        {assignedClients.length > 0 && (
          <button onClick={() => setPermissions(p => ({ ...p, assigned_clients: [] }))}
            className="text-xs font-semibold text-red-500 hover:text-red-600 dark:text-red-400 transition-colors -mt-5">
            Clear All
          </button>
        )}
      </div>

      {/* Stats bar */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center gap-1.5">
          <span className="text-xl font-bold" style={{ color: COLORS.teal }}>{assignedClients.length}</span>
          <span className="text-sm text-slate-500 dark:text-slate-400">assigned</span>
        </div>
        <div className={`w-px h-5 ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`} />
        <div className="flex items-center gap-1.5">
          <span className="text-xl font-bold text-slate-400">{clients.length - assignedClients.length}</span>
          <span className="text-sm text-slate-500 dark:text-slate-400">unassigned</span>
        </div>
        <div className={`w-px h-5 ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`} />
        <span className="text-xs text-slate-400">{clients.length} total</span>
        {filteredForTab.length > 0 && filteredForTab.length < clients.length && (
          <button onClick={toggleAll}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all"
            style={allFilteredSelected
              ? { background: '#fef2f2', borderColor: '#fecaca', color: '#dc2626' }
              : { background: isDark ? 'rgba(15,118,110,0.15)' : '#f0fdfa', borderColor: '#5eead4', color: COLORS.teal }}>
            {allFilteredSelected
              ? <><XCircle className="h-3 w-3" /> Deselect filtered ({filteredForTab.length})</>
              : <><CheckCircle className="h-3 w-3" /> Select filtered ({filteredForTab.length})</>}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
        <Input placeholder="Search by name, phone, email…" value={clientSearch} onChange={e => setClientSearch(e.target.value)} className="pl-11 h-10 rounded-xl" />
        {clientSearch && (
          <button onClick={() => setClientSearch('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={cpTypeFilter} onChange={e => setCpTypeFilter(e.target.value)}
          className={`h-8 px-3 rounded-xl border text-xs font-semibold appearance-none outline-none cursor-pointer transition-colors ${isDark ? 'bg-slate-700 border-slate-600 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}
          style={cpTypeFilter ? { borderColor: COLORS.teal, color: COLORS.teal } : {}}>
          <option value="">All Types</option>
          {Object.entries(CLIENT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <div className={`w-px h-5 flex-shrink-0 ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`} />
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setCpSvcFilter('')}
            className="px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all"
            style={!cpSvcFilter
              ? { background: GRADIENT, color: '#fff', borderColor: 'transparent' }
              : isDark ? { background: '#1e293b', color: '#94a3b8', borderColor: '#334155' } : { background: '#f8fafc', color: '#64748b', borderColor: '#e2e8f0' }}>
            All
          </button>
          {presentServices.map(svc => (
            <button key={svc} onClick={() => setCpSvcFilter(prev => prev === svc ? '' : svc)}
              className="px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all"
              style={cpSvcFilter === svc
                ? { background: GRADIENT, color: '#fff', borderColor: 'transparent' }
                : isDark ? { background: '#1e293b', color: '#94a3b8', borderColor: '#334155' } : { background: '#f8fafc', color: '#64748b', borderColor: '#e2e8f0' }}>
              {svc}
            </button>
          ))}
        </div>
      </div>

      {/* Select-all / deselect-all row */}
      {filteredForTab.length === clients.length && filteredForTab.length > 0 && (
        <div className="flex items-center gap-3">
          <button onClick={toggleAll}
            className="flex items-center gap-1.5 text-xs font-semibold transition-colors"
            style={{ color: allFilteredSelected ? '#dc2626' : COLORS.teal }}>
            {allFilteredSelected
              ? <><XCircle className="h-3.5 w-3.5" /> Deselect All ({clients.length})</>
              : <><CheckCircle className="h-3.5 w-3.5" /> Select All ({clients.length})</>}
          </button>
          {someFilteredSelected && !allFilteredSelected && (
            <span className="text-[10px] text-slate-400">{assignedClients.length} of {clients.length} selected</span>
          )}
        </div>
      )}

      {/* Client grid */}
      <div className="users-slim max-h-[380px] overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2 pr-1" style={slimScroll}>
        {filteredForTab.length === 0 && (
          <div className="col-span-2 flex flex-col items-center justify-center py-10 text-slate-400">
            <Briefcase className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-sm font-medium">No clients match filters</p>
            <button onClick={() => { setClientSearch(''); setCpSvcFilter(''); setCpTypeFilter(''); }}
              className="mt-2 text-xs font-semibold" style={{ color: COLORS.teal }}>Clear filters</button>
          </div>
        )}
        {filteredForTab.map(client => {
          const isAssigned = assignedClients.includes(client.id);
          const typeCfg = CLIENT_TYPE_COLORS[client.client_type] || CLIENT_TYPE_COLORS.proprietor;
          const typeLabel = CLIENT_TYPE_LABELS[client.client_type] || 'Other';
          const svcCount = (client.services || []).length;
          return (
            <button key={client.id}
              onClick={() => setPermissions(prev => ({ ...prev, assigned_clients: isAssigned ? (prev.assigned_clients || []).filter(id => id !== client.id) : [...(prev.assigned_clients || []), client.id] }))}
              className="flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all hover:shadow-sm"
              style={isAssigned
                ? { borderColor: '#1FAF5A', background: isDark ? 'rgba(31,175,90,0.12)' : '#f0fdf4' }
                : isDark ? { borderColor: '#334155', background: '#1e293b' } : { borderColor: '#e2e8f0', background: '#f8fafc' }}>
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 text-white text-sm font-bold mt-0.5 ${isAssigned ? 'bg-emerald-500' : ''}`}
                style={isAssigned ? {} : { background: `linear-gradient(135deg, ${['#0D3B66','#065f46','#7c2d12','#4c1d95','#831843'][client.company_name?.charCodeAt(0) % 5] || '#0D3B66'}, #1F6FB2)` }}>
                {isAssigned ? <CheckCircle className="h-4 w-4" /> : client.company_name?.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`font-semibold text-sm leading-tight truncate ${isAssigned ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-800 dark:text-slate-100'}`}>
                  {client.company_name}
                </p>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded-full border"
                    style={{ background: typeCfg.bg, color: typeCfg.text, borderColor: typeCfg.border }}>
                    {typeLabel}
                  </span>
                  {svcCount > 0 && (
                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                      {svcCount} svc{svcCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer summary */}
      {(cpSvcFilter || cpTypeFilter || clientSearch) && (
        <p className="text-[11px] text-slate-400 text-right">
          Showing {filteredForTab.length} of {clients.length} clients
          {filteredForTab.filter(c => assignedClients.includes(c.id)).length > 0 && (
            <> · <span style={{ color: COLORS.teal }}>{filteredForTab.filter(c => assignedClients.includes(c.id)).length} selected in view</span></>
          )}
        </p>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════════
export default function Users() {
  const { user, refreshUser, isPlatformOwner } = useAuth();
  const isDark = useDark();
  const isAdmin              = user?.role === 'admin';
  const isManager            = user?.role === 'manager';
  const perms                = user?.permissions || {};
  const canViewUserPage      = isAdmin || !!perms.can_view_user_page;
  const canEditUsers         = isAdmin || !!perms.can_manage_users;
  // Admin can manage any user's permissions.
  // Manager with can_manage_users can manage permissions for their team STAFF (not admin/manager).
  const canManagePermissions = isAdmin || (isManager && !!perms.can_manage_users);
  const isCommercialAdmin = isAdmin && !!user?.company_id && !isPlatformOwner;

  // ── Main page tab (Users vs Identix) ─────────────────────────────────────
  const [mainTab, setMainTab] = useState('users'); // 'users' | 'identix' | 'password_resets' | 'salary'
  // ── Identix sub-tab ───────────────────────────────────────────────────────
  const [identixTab, setIdentixTab] = useState('dashboard'); // 'dashboard' | 'devices' | 'enrollment' | 'logs'
  // ── Password reset requests (admin only) ──────────────────────────────────
  // ── Salary tab (admin only) ────────────────────────────────────────────────
  const [salaryMonth,     setSalaryMonth]     = useState(() => new Date().toISOString().slice(0, 7)); // 'YYYY-MM'
  const [salaryReports,   setSalaryReports]   = useState([]);
  const [salaryLoading,   setSalaryLoading]   = useState(false);
  const [salarySearch,    setSalarySearch]    = useState('');
  const [expandedSalaryId,setExpandedSalaryId]= useState(null);
  const [salaryDetail,    setSalaryDetail]    = useState({}); // { [userId]: reportWithDays }
  const [salaryDetailLoadingId, setSalaryDetailLoadingId] = useState(null);
  const [salaryDialogOpen,    setSalaryDialogOpen]    = useState(false);
  const [salaryDialogUserId,  setSalaryDialogUserId]  = useState('');
  const [salaryDialogAmount,  setSalaryDialogAmount]  = useState('');
  const [salaryDialogSaving,  setSalaryDialogSaving]  = useState(false);

  // ── Access Requests (Permission Governance) tab ────────────────────────────
  const [pgRequests, setPgRequests] = useState([]);
  const [pgGrants,   setPgGrants]   = useState([]);
  const [pgModules,  setPgModules]  = useState([]);
  const [pgLoading,  setPgLoading]  = useState(false);
  const [pgReqTab,   setPgReqTab]   = useState('pending'); // 'pending' | 'history' | 'grants'


  const [users,                setUsers]                = useState([]);
  const [clients,              setClients]              = useState([]);
  const [companies,            setCompanies]            = useState([]);
  const [searchQuery,          setSearchQuery]          = useState('');
  const [activeTab,            setActiveTab]            = useState('all');
  const [dialogOpen,           setDialogOpen]           = useState(false);
  const [permDialogOpen,       setPermDialogOpen]       = useState(false);
  const [selectedUser,         setSelectedUser]         = useState(null);
  const [selectedUserForPerms, setSelectedUserForPerms] = useState(null);
  const [approvingId,          setApprovingId]          = useState(null);
  const [loading,              setLoading]              = useState(false);
  const [clientSearch,         setClientSearch]         = useState('');
  const [activePermTab,        setActivePermTab]        = useState('modules');
  const [pwSearch,             setPwSearch]             = useState('');

  const [offboardDialogOpen, setOffboardDialogOpen] = useState(false);
  const [offboardTarget, setOffboardTarget]         = useState(null);

  const [formData, setFormData] = useState({
    full_name: '', email: '', password: '', role: 'staff',
    departments: [], phone: '', birthday: '', profile_picture: '',
    punch_in_time: '10:30', grace_time: '00:10', punch_out_time: '19:00',
    telegram_id: '', is_active: true, status: 'active',
    company_id: '', company_name: '',
    joining_date: '', training_period_end: '', payroll_date: '', monthly_salary: '',
  });
  const [permissions, setPermissions] = useState({ ...EMPTY_PERMISSIONS });
  // ── Permission Matrix (Modules tab) toolbar state ─────────────────────────
  const [moduleMatrixSearch, setModuleMatrixSearch] = useState('');
  const [collapsedModules,   setCollapsedModules]   = useState({}); // { [moduleKey]: true } = collapsed
  const [copyFromUserId,     setCopyFromUserId]     = useState('');
  const [copyingPerms,       setCopyingPerms]       = useState(false);

  // ── Minimize/restore: shrink the Add/Edit Team Member form to the global
  // dock so it can be resumed later, from any page, without losing progress.
  const userFormKey = selectedUser ? `create-user-${selectedUser.id}` : 'create-user-new';
  const { minimize: minimizeUserForm } = useFormMinimizer({
    formKey: userFormKey,
    title: formData.full_name ? `Member: ${formData.full_name}` : (selectedUser ? 'Edit Member' : 'New Team Member'),
    subtitle: selectedUser ? 'Editing' : 'Creating',
    path: '/users',
    icon: 'UserPlus',
    data: { formData, permissions, editingUserId: selectedUser?.id || null },
    onRestore: (data) => {
      if (data.formData) setFormData(data.formData);
      if (data.permissions) setPermissions(data.permissions);
      if (data.editingUserId) {
        const found = users.find((u) => u.id === data.editingUserId);
        if (found) setSelectedUser(found);
      } else {
        setSelectedUser(null);
      }
      setDialogOpen(true);
    },
  });

  useEffect(() => {
    if (canViewUserPage) { fetchUsers(); fetchClients(); fetchCompanies(); }
  }, [canViewUserPage]);

  const fetchUsers = useCallback(async () => {
    try {
      // Licensed company admins use the canonical Commercial Master Data
      // directory. It carries the same company/license user records consumed
      // by Admin → Master Data, while the legacy /users route remains
      // company-scoped for ordinary operational users.
      const res = isCommercialAdmin
        ? await api.get('/commercial-master-data/users')
        : await api.get('/users');
      const raw = res.data;
      const list = Array.isArray(raw) ? raw : (raw?.users || raw?.data || []);
      const filtered = isPlatformOwner ? list.filter((u) => {
        const isCommercialLicensee = (
          (u.commercial_customer_id && u.commercial_customer_id !== 'platform-owner') ||
          (u.license_id && u.license_id !== 'platform-owner-license')
        );
        return !isCommercialLicensee;
      }) : list;
      setUsers(filtered);
    } catch { toast.error('Failed to fetch users'); }
  }, [isPlatformOwner, isCommercialAdmin]);

  const fetchClients = useCallback(async () => {
    try {
      const res = await api.get('/clients');
      setClients(Array.isArray(res.data) ? res.data : (res.data?.data || []));
    } catch {}
  }, []);

  const fetchCompanies = useCallback(async () => {
    try {
      // Fetches companies created in the Quotations module (db.companies collection)
      const res = await api.get('/companies/list');
      setCompanies(normalizeCompanies(res));
    } catch {}
  }, []);

  // ── Password Log (admin view of all users' account/password status) ───────

  useEffect(() => {
    if (mainTab === 'password_resets' && isAdmin && !users.length) fetchUsers();
  }, [mainTab, isAdmin]);

  // ── Salary tab: fetch summary whenever the tab or selected month changes ──
  const fetchSalaryReports = useCallback(async (month) => {
    setSalaryLoading(true);
    try {
      const res = await api.get('/users/salary-report-all', { params: { month } });
      setSalaryReports(res.data?.reports || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load salary report');
      setSalaryReports([]);
    } finally { setSalaryLoading(false); }
  }, []);

  useEffect(() => {
    if (mainTab === 'salary' && isAdmin) {
      fetchSalaryReports(salaryMonth);
      setExpandedSalaryId(null);
      setSalaryDetail({});
    }
  }, [mainTab, isAdmin, salaryMonth, fetchSalaryReports]);

  const fetchPermGovData = useCallback(async () => {
    if (!isAdmin) return;
    setPgLoading(true);
    try {
      const [reqR, grantsR, modsR] = await Promise.allSettled([
        api.get('/permission-governance/requests'),
        api.get('/permission-governance/grants'),
        api.get('/permission-governance/modules'),
      ]);
      setPgRequests(reqR.status === 'fulfilled' ? (reqR.value.data || []) : []);
      setPgGrants(grantsR.status === 'fulfilled' ? (grantsR.value.data || []) : []);
      setPgModules(modsR.status === 'fulfilled' ? (modsR.value.data || []) : []);
    } catch { toast.error('Failed to load access requests'); }
    finally { setPgLoading(false); }
  }, [isAdmin]);

  useEffect(() => {
    if (mainTab === 'access_requests' && isAdmin) fetchPermGovData();
  }, [mainTab, isAdmin, fetchPermGovData]);

  const pgDecide = useCallback(async (id, action) => {
    try {
      await api.post(`/permission-governance/requests/${id}/${action}`, { note: '' });
      toast.success(action === 'approve' ? 'Access granted' : 'Request rejected');
      fetchPermGovData();
    } catch (err) { toast.error(err.response?.data?.detail || 'Action failed'); }
  }, [fetchPermGovData]);

  const pgRevoke = useCallback(async (userId, moduleKey) => {
    if (!window.confirm('Revoke this access?')) return;
    try {
      await api.post(`/permission-governance/users/${userId}/revoke?module=${moduleKey}`);
      toast.success('Access revoked'); fetchPermGovData();
    } catch { toast.error('Failed to revoke'); }
  }, [fetchPermGovData]);

  const toggleSalaryDetail = useCallback(async (userId) => {
    if (expandedSalaryId === userId) { setExpandedSalaryId(null); return; }
    setExpandedSalaryId(userId);
    if (salaryDetail[userId]?.month === salaryMonth) return; // already cached for this month
    setSalaryDetailLoadingId(userId);
    try {
      const res = await api.get(`/users/${userId}/salary-report`, { params: { month: salaryMonth } });
      setSalaryDetail(prev => ({ ...prev, [userId]: res.data }));
    } catch {
      toast.error('Failed to load day-by-day breakdown');
    } finally { setSalaryDetailLoadingId(null); }
  }, [expandedSalaryId, salaryDetail, salaryMonth]);

  // Move the selected salary month forward/back by one, e.g. '2026-07' → '2026-08'
  const shiftSalaryMonth = useCallback((delta) => {
    setSalaryMonth(prev => {
      const [y, m] = prev.split('-').map(Number);
      const d = new Date(y, (m - 1) + delta, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  }, []);

  const openSalaryDialogFor = useCallback((userId) => {
    setSalaryDialogUserId(userId || '');
    const u = users.find(x => x.id === userId);
    setSalaryDialogAmount(u?.monthly_salary != null ? String(u.monthly_salary) : '');
    setSalaryDialogOpen(true);
  }, [users]);

  const handleSaveQuickSalary = useCallback(async () => {
    if (!salaryDialogUserId) { toast.error('Please select a member'); return; }
    if (salaryDialogAmount === '' || Number(salaryDialogAmount) < 0) { toast.error('Enter a valid salary amount'); return; }
    setSalaryDialogSaving(true);
    try {
      await api.put(`/users/${salaryDialogUserId}`, { monthly_salary: Number(salaryDialogAmount) });
      toast.success('✓ Salary saved');
      setSalaryDialogOpen(false);
      setSalaryDialogUserId(''); setSalaryDialogAmount('');
      fetchSalaryReports(salaryMonth);
      fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save salary');
    } finally { setSalaryDialogSaving(false); }
  }, [salaryDialogUserId, salaryDialogAmount, salaryMonth, fetchSalaryReports, fetchUsers]);

  const fetchPermissions = useCallback(async (userId) => {
    try {
      const res = await api.get(`/users/${userId}/permissions`);
      setPermissions({ ...EMPTY_PERMISSIONS, ...(res.data || {}) });
    } catch {
      toast.error('Using default permission template');
      setPermissions({ ...EMPTY_PERMISSIONS });
    }
  }, []);

  const handleInput      = useCallback((e) => { const { name, value } = e.target; setFormData(p => ({ ...p, [name]: value })); }, []);
  const handleRoleChange = useCallback((v) => setFormData(p => ({ ...p, role: v })), []);
  const toggleDept       = useCallback((d) => setFormData(p => ({
    ...p, departments: p.departments.includes(d) ? p.departments.filter(x => x !== d) : [...p.departments, d],
  })), []);
  const handlePhoto = useCallback((e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setFormData(p => ({ ...p, profile_picture: reader.result }));
    reader.readAsDataURL(file);
  }, []);

  const handleEdit = useCallback((userData) => {
    setSelectedUser(userData);
    setFormData({
      full_name: userData.full_name || '', email: userData.email || '', password: '',
      role: userData.role || 'staff', departments: userData.departments || [],
      phone: userData.phone || '',
      birthday: userData.birthday && userData.birthday !== '' ? format(new Date(userData.birthday), 'yyyy-MM-dd') : '',
      profile_picture: userData.profile_picture || '',
      punch_in_time: userData.punch_in_time || '10:30', grace_time: userData.grace_time || '00:10',
      punch_out_time: userData.punch_out_time || '19:00',
      telegram_id: userData.telegram_id != null ? String(userData.telegram_id) : '',
      is_active: userData.is_active !== false, status: userData.status || 'active',
      company_id: userData.company_id || '', company_name: userData.company_name || '',
      joining_date: userData.joining_date ? userData.joining_date.slice(0, 10) : '',
      training_period_end: userData.training_period_end ? userData.training_period_end.slice(0, 10) : '',
      payroll_date: userData.payroll_date ? userData.payroll_date.slice(0, 10) : '',
      monthly_salary: userData.monthly_salary != null ? String(userData.monthly_salary) : '',
    });
    setDialogOpen(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!formData.full_name.trim())              { toast.error('Full name is required'); return; }
    if (!selectedUser && !formData.email.trim()) { toast.error('Email is required');     return; }
    setLoading(true);
    try {
      if (selectedUser) {
        const payload = {
          full_name: formData.full_name.trim(), phone: formData.phone || null,
          birthday: formData.birthday || null, profile_picture: formData.profile_picture || null,
          punch_in_time: formData.punch_in_time || null, grace_time: formData.grace_time || null,
          punch_out_time: formData.punch_out_time || null,
          telegram_id: formData.telegram_id !== '' ? Number(formData.telegram_id) : null,
          is_active: formData.is_active,
          company_id: formData.company_id || null,
          company_name: formData.company_name || null,
          joining_date: formData.joining_date || null,
          training_period_end: formData.training_period_end || null,
          payroll_date: formData.payroll_date || null,
          ...(isAdmin && { email: formData.email.trim(), role: formData.role, status: formData.status, departments: formData.departments }),
          ...(isAdmin && formData.password.trim() && { password: formData.password.trim() }),
          ...(isAdmin && { monthly_salary: formData.monthly_salary !== '' ? Number(formData.monthly_salary) : null }),
        };
        if (isCommercialAdmin) {
          await api.put(`/commercial-master-data/users/${selectedUser.id}`, payload);
        } else {
          await api.put(`/users/${selectedUser.id}`, payload);
        }
        if (selectedUser.id === user?.id) await refreshUser();
        toast.success('✓ User updated successfully');
      } else {
        await api.post('/auth/register', {
          full_name: formData.full_name.trim(), email: formData.email.trim(),
          password: formData.password, role: formData.role, departments: formData.departments,
          phone: formData.phone || null, birthday: formData.birthday || null,
          punch_in_time: formData.punch_in_time, grace_time: formData.grace_time,
          punch_out_time: formData.punch_out_time,
          telegram_id: formData.telegram_id !== '' ? Number(formData.telegram_id) : null,
          is_active: false, status: 'pending_approval',
          company_id: formData.company_id || null,
          company_name: formData.company_name || null,
          joining_date: formData.joining_date || null,
          training_period_end: formData.training_period_end || null,
          payroll_date: formData.payroll_date || null,
          monthly_salary: formData.monthly_salary !== '' ? Number(formData.monthly_salary) : null,
        });
        toast.success('✓ Member registered — awaiting approval');
      }
      setDialogOpen(false); fetchUsers();
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Failed to save user');
    } finally { setLoading(false); }
  }, [selectedUser, formData, isAdmin, user?.id, refreshUser, fetchUsers]);

  const handleDelete = useCallback(async (id) => {
    // Per permission matrix: DELETE users is Admin-only
    if (!isAdmin) { toast.error('Only administrators can delete users'); return; }
    if (id === user?.id) { toast.error('You cannot delete your own account'); return; }
    if (!window.confirm('Permanently delete this user and all their data?')) return;
    try { await api.delete(`/users/${id}`); toast.success('User removed'); fetchUsers(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed to delete user'); }
  }, [isAdmin, user?.id, fetchUsers]);

  const handleOffboard = useCallback((userData) => {
    setOffboardTarget(userData);
    setOffboardDialogOpen(true);
  }, []);

  const openPermissionsDialog = useCallback(async (userData) => {
    // Manager can only manage permissions for staff
    if (!isAdmin && isManager && userData.role !== 'staff') {
      toast.error('Managers can only manage permissions for users');
      return;
    }
    setSelectedUserForPerms(userData);
    setActivePermTab('modules');
    setModuleMatrixSearch('');
    setCopyFromUserId('');
    await fetchPermissions(userData.id);
    setPermDialogOpen(true);
  }, [isAdmin, isManager, fetchPermissions]);

  const handleSavePermissions = useCallback(async () => {
    if (!canManagePermissions) { toast.error('Only administrators or managers can update permissions'); return; }
    // Managers cannot update permissions for other managers or admins
    if (!isAdmin && isManager && selectedUserForPerms?.role !== 'staff') {
      toast.error('Managers can only update permissions for users');
      return;
    }
    setLoading(true);
    try {
      const ensureArray = v => Array.isArray(v) ? v : [];
      const payload = {
        ...permissions,
        view_password_departments: ensureArray(permissions.view_password_departments),
        assigned_clients: ensureArray(permissions.assigned_clients),
        view_other_tasks: ensureArray(permissions.view_other_tasks),
        view_other_attendance: ensureArray(permissions.view_other_attendance),
        view_other_reports: ensureArray(permissions.view_other_reports),
        view_other_todos: ensureArray(permissions.view_other_todos),
        view_other_activity: ensureArray(permissions.view_other_activity),
        view_other_visits: ensureArray(permissions.view_other_visits),
      };
      await api.put(`/users/${selectedUserForPerms?.id}/permissions`, payload);
      if (selectedUserForPerms?.id === user?.id) await refreshUser();
      toast.success('✓ Permissions saved');
      if (selectedUserForPerms?.id !== user?.id) {
        toast.info(`${selectedUserForPerms?.full_name || 'The user'} will see updated permissions on their next page load.`, { duration: 5000 });
      }
      setPermDialogOpen(false); fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update permissions');
    } finally { setLoading(false); }
  }, [isAdmin, isManager, canManagePermissions, permissions, selectedUserForPerms?.id, selectedUserForPerms?.role, user?.id, refreshUser, fetchUsers]);

  const resetPermissionsToRole = useCallback((role) => {
    setPermissions({ ...(DEFAULT_ROLE_PERMISSIONS[role] || EMPTY_PERMISSIONS) });
    toast.info(`Reset to ${role} defaults — click Save to apply`);
  }, []);

  // "Copy Permissions From Another User" — reuses the existing
  // GET /users/{id}/permissions endpoint (same one used to load the dialog
  // in the first place), so no new API surface is introduced.
  const copyPermissionsFromUser = useCallback(async (sourceUserId) => {
    if (!sourceUserId) return;
    setCopyingPerms(true);
    try {
      const { data } = await api.get(`/users/${sourceUserId}/permissions`);
      setPermissions({ ...EMPTY_PERMISSIONS, ...data });
      const sourceName = users.find(u => u.id === sourceUserId)?.full_name || 'selected user';
      toast.info(`Copied permissions from ${sourceName} — click Save to apply`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load that user\u2019s permissions');
    } finally {
      setCopyingPerms(false);
      setCopyFromUserId('');
    }
  }, [users]);

  const toggleModuleCollapsed = useCallback((moduleKey) => {
    setCollapsedModules(prev => ({ ...prev, [moduleKey]: !prev[moduleKey] }));
  }, []);

  const handleApprove = useCallback(async (userData) => {
    if (!isAdmin) { toast.error('Only admins can approve users'); return; }
    setApprovingId(userData.id);
    try { await api.post(`/users/${userData.id}/approve`); toast.success(`✓ ${userData.full_name} approved`); fetchUsers(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed to approve'); }
    finally { setApprovingId(null); }
  }, [isAdmin, fetchUsers]);

  const handleReject = useCallback(async (userData) => {
    if (!isAdmin) { toast.error('Only admins can reject users'); return; }
    if (!window.confirm(`Reject ${userData.full_name}?`)) return;
    setApprovingId(userData.id);
    try { await api.post(`/users/${userData.id}/reject`); toast.success(`${userData.full_name} rejected`); fetchUsers(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed to reject'); }
    finally { setApprovingId(null); }
  }, [isAdmin, fetchUsers]);

  const pendingUsers   = useMemo(() => users.filter(u => u.status === 'pending_approval'), [users]);
  const filteredUsers  = useMemo(() => users.filter(u => {
    const q = searchQuery.toLowerCase();
    const match = (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
    if (activeTab === 'pending')  return match && u.status === 'pending_approval';
    if (activeTab === 'rejected') return match && u.status === 'rejected';
    if (activeTab === 'all')      return match;
    return match && u.role?.toLowerCase() === activeTab;
  }), [users, searchQuery, activeTab]);

  const stats = useMemo(() => [
    { label: 'Total Members', value: users.length,                                icon: UsersIcon,  color: COLORS.mediumBlue   },
    { label: 'Admins',        value: users.filter(u => u.role === 'admin').length, icon: Crown,      color: COLORS.indigo       },
    { label: 'Pending',       value: pendingUsers.length,                          icon: Clock,      color: '#D97706'           },
    { label: 'Active',        value: users.filter(u => u.is_active).length,        icon: CheckCircle, color: COLORS.emeraldGreen },
  ], [users, pendingUsers.length]);

  const enabledPermCount = Object.entries(permissions).filter(([k, v]) => k.startsWith('can_') && v === true).length;

  if (!canViewUserPage) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 dark:bg-[#0a0f1c] p-8">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center max-w-sm">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6" style={{ background: 'rgba(239,68,68,0.1)' }}>
            <ShieldOff className="h-10 w-10 text-red-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Access Restricted</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">
            You need the <span className="font-semibold text-slate-700 dark:text-slate-200">View User Directory</span> permission to access this page.
          </p>
        </motion.div>
      </div>
    );
  }

  const tabs = [
    { id: 'all',      label: 'All',      count: users.length },
    { id: 'admin',    label: 'Admins',   count: users.filter(u => u.role === 'admin').length },
    { id: 'manager',  label: 'Managers', count: users.filter(u => u.role === 'manager').length },
    { id: 'staff',    label: 'Staff',    count: users.filter(u => u.role === 'staff').length },
    { id: 'rejected', label: 'Rejected', count: users.filter(u => u.status === 'rejected').length },
  ];

  const identixSubTabs = [
    { id: 'dashboard',  label: 'Dashboard',    icon: LayoutDashboard },
    { id: 'devices',    label: 'Devices',       icon: Monitor         },
    { id: 'enrollment', label: 'Enrollment',    icon: Fingerprint     },
    { id: 'logs',       label: 'Attendance Log',icon: ClipboardList   },
  ];

  return (
    <motion.div
      className={`space-y-5 min-h-full ${isDark ? 'bg-[#0a0f1c]' : 'bg-slate-50'}`}
      initial="hidden" animate="visible" variants={containerVariants}>

      {/* ── Page Header ── */}
      <motion.div variants={slideIn}>
        <div className="relative overflow-hidden rounded-3xl px-5 sm:px-8 pt-6 sm:pt-7 pb-6"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 55%, #2196d1 100%)`, boxShadow: '0 20px 48px -12px rgba(13,59,102,0.42)' }}>
          <div className="absolute -right-24 -top-24 w-80 h-80 rounded-full opacity-15"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="absolute -left-20 -bottom-20 w-72 h-72 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #5CCB5F 0%, transparent 70%)' }} />
          <div className="absolute right-40 bottom-0 w-40 h-40 rounded-full mb-[-40px] opacity-[0.06]"
            style={{ background: 'white' }} />
          <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur-md border border-white/20 flex items-center justify-center flex-shrink-0 shadow-inner">
                {mainTab === 'identix'
                  ? <Fingerprint className="h-6 w-6 text-white" />
                  : mainTab === 'salary'
                    ? <Wallet className="h-6 w-6 text-white" />
                    : mainTab === 'access_requests'
                      ? <ShieldCheck className="h-6 w-6 text-white" />
                      : <UsersIcon className="h-6 w-6 text-white" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white/10 backdrop-blur-sm border border-white/15">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                    <p className="text-white/80 text-[10px] font-bold uppercase tracking-widest">Team Management</p>
                  </span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight leading-tight">
                  {mainTab === 'identix' ? 'Identix Machine Integration' : mainTab === 'salary' ? 'Salary & Payroll' : mainTab === 'access_requests' ? 'Access Requests' : 'User Directory'}
                </h1>
                <p className="text-white/70 text-xs sm:text-sm mt-1 max-w-md">
                  {mainTab === 'identix'
                    ? 'Manage biometric devices, enrollments, and attendance logs.'
                    : mainTab === 'salary'
                      ? 'Attendance-based salary due, calculated automatically from punch records.'
                      : mainTab === 'access_requests'
                        ? 'Approve or reject account module access requests from staff members.'
                        : `Organize roles, track access, and onboard new members — ${users.length} ${users.length === 1 ? 'member' : 'members'} in your team.`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {/* Main tab switcher */}
              <div className="flex gap-1 p-1 rounded-xl bg-white/10 backdrop-blur-sm">
                {[
                  { id: 'users',           label: 'Users',           icon: UsersIcon   },
                  { id: 'identix',         label: 'Identix',         icon: Fingerprint },
                  ...(isAdmin ? [{ id: 'password_resets', label: 'Password Resets', icon: KeyRound }] : []),
                  ...(isAdmin ? [{ id: 'salary',          label: 'Salary',          icon: Wallet   }] : []),
                  ...(isAdmin ? [{ id: 'access_requests', label: 'Access Requests', icon: ShieldCheck }] : []),
                ].map(t => {
                  const Icon = t.icon;
                  return (
                    <button key={t.id} onClick={() => setMainTab(t.id)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                      style={mainTab === t.id
                        ? { background: 'rgba(255,255,255,0.25)', color: '#fff' }
                        : { color: 'rgba(255,255,255,0.6)' }}>
                      <Icon className="h-4 w-4" />{t.label}
                    </button>
                  );
                })}
              </div>
              {mainTab === 'users' && isAdmin && (
                <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    onClick={() => {
                      setSelectedUser(null);
                      setFormData({ full_name:'',email:'',password:'',role:'staff',departments:[],phone:'',birthday:'',profile_picture:'',punch_in_time:'10:30',grace_time:'00:10',punch_out_time:'19:00',telegram_id:'',is_active:true,status:'active',company_id:'',company_name:'',joining_date:'',training_period_end:'',payroll_date:'',monthly_salary:'' });
                      setDialogOpen(true);
                    }}
                    className="h-10 px-6 rounded-xl font-semibold text-sm shadow-lg bg-white/20 hover:bg-white/30 text-white border border-white/20 hover:border-white/30 transition-all">
                    <Plus className="h-4 w-4 mr-2" />Add New Member
                  </Button>
                </motion.div>
              )}
              {mainTab === 'salary' && isAdmin && (
                <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    onClick={() => openSalaryDialogFor('')}
                    className="h-10 px-6 rounded-xl font-semibold text-sm shadow-lg bg-white/20 hover:bg-white/30 text-white border border-white/20 hover:border-white/30 transition-all">
                    <Plus className="h-4 w-4 mr-2" />Add Salary
                  </Button>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* ════ USERS TAB ════ */}
      {mainTab === 'users' && (
        <>
          {/* Stats */}
          <motion.div variants={containerVariants} className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {stats.map((s, i) => {
              const Icon = s.icon;
              return (
                <motion.div key={i} variants={itemVariants} whileHover={{ y: -3, transition: springPhysics.card }} whileTap={{ scale: 0.985 }}
                  className="group relative overflow-hidden bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/80 dark:border-slate-700 shadow-sm hover:shadow-xl transition-all cursor-default">
                  <div className="absolute -right-8 -top-8 w-24 h-24 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `radial-gradient(circle, ${s.color}26 0%, transparent 70%)` }} />
                  <div className="absolute left-0 top-0 bottom-0 w-1 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: s.color }} />
                  <div className="relative p-4 sm:p-5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">{s.label}</p>
                      <p className="text-3xl font-black mt-1 tracking-tight tabular-nums" style={{ color: s.color }}>
                        {String(s.value).padStart(2, '0')}
                      </p>
                    </div>
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 transition-all duration-300 group-hover:scale-110 group-hover:rotate-3"
                      style={{ background: `${s.color}15`, boxShadow: `inset 0 0 0 1px ${s.color}22` }}>
                      <Icon className="h-5 w-5" style={{ color: s.color }} />
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>

          {/* Pending Approvals */}
          {pendingUsers.length > 0 && isAdmin && (
            <motion.div variants={itemVariants} className="space-y-4">
              <SectionCard>
                <CardHeaderRow iconBg={isDark ? 'bg-amber-900/40' : 'bg-amber-50'}
                  icon={<Clock className="h-4 w-4 text-amber-500" />}
                  title="Pending Approvals" subtitle={`${pendingUsers.length} awaiting review`} badge={pendingUsers.length} />
                <div className="p-4">
                  <motion.div variants={containerVariants} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {pendingUsers.map(u => (
                      <PendingUserCard key={u.id} userData={u} onApprove={handleApprove} onReject={handleReject} approving={approvingId} />
                    ))}
                  </motion.div>
                </div>
              </SectionCard>
            </motion.div>
          )}

          {/* Tabs + Search — unified control panel */}
          <motion.div variants={itemVariants}
            className={`flex flex-col lg:flex-row lg:items-center gap-3 p-3 rounded-2xl border shadow-sm ${
              isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200/80'
            }`}>
            <div className="flex items-center gap-2 overflow-x-auto pb-1 lg:pb-0 -mx-1 px-1 lg:flex-shrink-0">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
                    activeTab === tab.id ? 'text-white shadow-lg' : isDark ? 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                  style={activeTab === tab.id ? { background: GRADIENT, boxShadow: '0 8px 20px -6px rgba(31,111,178,0.45)' } : {}}>
                  {tab.label}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md leading-none ${
                    activeTab === tab.id ? 'bg-white/25 text-white' : isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
                  }`}>{tab.count}</span>
                </button>
              ))}
            </div>
            <div className={`hidden lg:block h-8 w-px ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
            <div className="relative flex-1 group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
              <Input placeholder="Search by name or email…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className={`pl-11 h-11 rounded-xl text-sm border-0 ${isDark ? 'bg-slate-900/60 text-slate-100 placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-blue-600' : 'bg-slate-50 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-200'}`} />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </motion.div>

          {/* Users Grid */}
          <motion.div variants={containerVariants} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredUsers.length > 0
              ? filteredUsers.map(u => (
                  <UserCard key={u.id} userData={u} onEdit={handleEdit} onDelete={handleDelete}
                    onOffboard={handleOffboard} onPermissions={openPermissionsDialog} onApprove={handleApprove} onReject={handleReject}
                    currentUserId={user?.id || ''} isAdmin={isAdmin} isManager={isManager} canEditUsers={canEditUsers}
                    canManagePermissions={canManagePermissions} approving={approvingId} />
                ))
              : (
                <motion.div variants={itemVariants} className="col-span-full">
                  <div className={`flex flex-col items-center justify-center py-20 rounded-2xl border border-dashed ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <div className={`p-4 rounded-2xl mb-4 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                      <UsersIcon className="h-8 w-8 text-slate-400" />
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 font-semibold">No users found</p>
                    <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">Try adjusting your search or filter</p>
                  </div>
                </motion.div>
              )}
          </motion.div>
        </>
      )}

      {/* ════ PASSWORD RESETS TAB (Admin only) ════ */}
      {mainTab === 'password_resets' && isAdmin && (
        <motion.div variants={itemVariants} className="space-y-4">
          {/* Info banner */}
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${
            isDark ? 'bg-blue-950/30 border-blue-900/50 text-blue-300' : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}>
            <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0 text-blue-500" />
            <span>To reset or change a user&apos;s password, open their profile via the <b>Users</b> tab → Edit (pencil icon) → New Password field.</span>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search by name, email or role…"
              value={pwSearch}
              onChange={e => setPwSearch(e.target.value)}
              className={`pl-10 h-10 rounded-xl text-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
            />
            {pwSearch && (
              <button onClick={() => setPwSearch('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Password log table */}
          <div className={`rounded-2xl border overflow-hidden shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            {/* Table header */}
            <div className={`flex items-center justify-between px-5 py-3 border-b ${isDark ? 'border-slate-700 bg-slate-800/80' : 'border-slate-100 bg-slate-50/80'}`}>
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg" style={{ background: `${COLORS.mediumBlue}15` }}>
                  <KeyRound className="h-4 w-4" style={{ color: COLORS.mediumBlue }} />
                </div>
                <div>
                  <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Account Password Log</p>
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>All users · {users.length} accounts</p>
                </div>
              </div>
              <Button onClick={fetchUsers} variant="outline" className={`h-8 px-3 rounded-lg text-xs gap-1.5 ${isDark ? 'border-slate-600 text-slate-300' : ''}`}>
                <RefreshCw className="h-3 w-3" />Refresh
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`border-b ${isDark ? 'border-slate-700/80 bg-slate-800/50' : 'border-slate-100 bg-slate-50/50'}`}>
                    {['Member', 'Role', 'Departments', 'Account Status', 'Last Updated', 'Action'].map(h => (
                      <th key={h} className={`text-left py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDark ? 'divide-slate-700/40' : 'divide-slate-50'}`}>
                  {users
                    .filter(u => {
                      const q = pwSearch.toLowerCase();
                      return !q || (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q);
                    })
                    .map(u => {
                      const roleCfg = ROLE_CONFIG[u.role?.toLowerCase()] || ROLE_CONFIG.staff;
                      const RoleIcon = roleCfg.icon;
                      return (
                        <tr key={u.id} className={`transition-colors ${isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'}`}>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center text-white text-xs font-black bg-gradient-to-br ${roleCfg.gradient}`}>
                                {u.profile_picture
                                  ? <img src={u.profile_picture} alt="" className="w-full h-full object-cover" />
                                  : u.full_name?.charAt(0)?.toUpperCase()}
                              </div>
                              <div>
                                <p className={`font-semibold text-xs leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{u.full_name}</p>
                                <p className="text-[11px] text-slate-400 truncate max-w-[160px]">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white bg-gradient-to-r ${roleCfg.gradient}`}>
                              <RoleIcon className="h-3 w-3" />{roleCfg.label}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap gap-1">
                              {(u.departments || []).slice(0, 3).map(d => <DeptPill key={d} dept={d} />)}
                              {(u.departments || []).length > 3 && <span className="text-[10px] text-slate-400">+{u.departments.length - 3}</span>}
                              {!(u.departments || []).length && <span className="text-[11px] text-slate-400">—</span>}
                            </div>
                          </td>
                          <td className="py-3 px-4"><StatusBadge status={u.status} isActive={u.is_active} /></td>
                          <td className="py-3 px-4 text-[11px] text-slate-400">
                            {u.updated_at ? format(new Date(u.updated_at), 'dd MMM yyyy') : u.created_at ? format(new Date(u.created_at), 'dd MMM yyyy') : '—'}
                          </td>
                          <td className="py-3 px-4">
                            <button
                              onClick={() => handleEdit(u)}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all"
                              style={{ color: COLORS.mediumBlue, borderColor: `${COLORS.mediumBlue}30`, background: `${COLORS.mediumBlue}08` }}>
                              <Lock className="h-3 w-3" />Set Password
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              {users.filter(u => {
                const q = pwSearch.toLowerCase();
                return !q || (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
              }).length === 0 && (
                <div className={`py-14 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <KeyRound className="h-8 w-8 mx-auto mb-2 opacity-25" />
                  <p className="text-sm font-medium">No users found</p>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* ════ SALARY TAB (Admin only) ════ */}
      {mainTab === 'salary' && isAdmin && (
        <motion.div variants={itemVariants} className="space-y-4">
          {/* Info banner explaining the policy */}
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${
            isDark ? 'bg-blue-950/30 border-blue-900/50 text-blue-300' : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}>
            <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0 text-blue-500" />
            <span>
              Salary due is auto-calculated from Attendance: <b>absent</b> = −1 day, <b>half-day</b> = −0.5 day,
              <b> late punch-in</b> (after 10:40 AM, using each user&apos;s configured grace) or <b> early punch-out</b> (before 6:00 PM) = −0.5 day each
              (capped at −1 day/date). Set an employee&apos;s monthly salary via <b>Users</b> tab → Edit → Monthly Salary.
            </span>
          </div>

          {/* Controls: month picker + search */}
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border p-1"
                style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <button onClick={() => shiftSalaryMonth(-1)}
                  className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                  title="Previous month">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                  <Input
                    type="month"
                    value={salaryMonth}
                    onChange={e => e.target.value && setSalaryMonth(e.target.value)}
                    className={`pl-9 h-9 rounded-lg text-sm w-40 border-0 ${isDark ? 'bg-slate-800' : 'bg-white'}`}
                  />
                </div>
                <button onClick={() => shiftSalaryMonth(1)}
                  className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                  title="Next month">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <Button onClick={() => fetchSalaryReports(salaryMonth)} variant="outline"
                className={`h-10 px-3 rounded-lg text-xs gap-1.5 ${isDark ? 'border-slate-600 text-slate-300' : ''}`}>
                <RefreshCw className={`h-3.5 w-3.5 ${salaryLoading ? 'animate-spin' : ''}`} />Refresh
              </Button>
            </div>
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search by name or email…"
                value={salarySearch}
                onChange={e => setSalarySearch(e.target.value)}
                className={`pl-10 h-10 rounded-xl text-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
              />
              {salarySearch && (
                <button onClick={() => setSalarySearch('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Summary cards */}
          {!salaryLoading && salaryReports.length > 0 && (() => {
            const totalGross = salaryReports.reduce((s, r) => s + (r.monthly_salary || 0), 0);
            const totalDeduction = salaryReports.reduce((s, r) => s + (r.deduction_amount || 0), 0);
            const totalPayable = salaryReports.reduce((s, r) => s + (r.payable_salary || 0), 0);
            const cards = [
              { label: 'Employees on Payroll', value: salaryReports.length, icon: UsersIcon, color: COLORS.mediumBlue },
              { label: 'Total Gross Salary', value: `₹${totalGross.toLocaleString('en-IN')}`, icon: Wallet, color: COLORS.indigo },
              { label: 'Total Deductions', value: `₹${totalDeduction.toLocaleString('en-IN')}`, icon: TrendingDown, color: '#DC2626' },
              { label: 'Total Payable', value: `₹${totalPayable.toLocaleString('en-IN')}`, icon: IndianRupee, color: COLORS.emeraldGreen },
            ];
            return (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {cards.map(c => {
                  const Icon = c.icon;
                  return (
                    <div key={c.label} className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="p-1.5 rounded-lg" style={{ background: `${c.color}15` }}>
                          <Icon className="h-3.5 w-3.5" style={{ color: c.color }} />
                        </div>
                        <p className={`text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{c.label}</p>
                      </div>
                      <p className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{c.value}</p>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Salary table */}
          <div className={`rounded-2xl border overflow-hidden shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className={`flex items-center justify-between px-5 py-3 border-b ${isDark ? 'border-slate-700 bg-slate-800/80' : 'border-slate-100 bg-slate-50/80'}`}>
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg" style={{ background: `${COLORS.mediumBlue}15` }}>
                  <Wallet className="h-4 w-4" style={{ color: COLORS.mediumBlue }} />
                </div>
                <div>
                  <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Salary Due — {format(new Date(`${salaryMonth}-01`), 'MMMM yyyy')}</p>
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{salaryReports.length} employee{salaryReports.length === 1 ? '' : 's'} with salary configured</p>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`border-b ${isDark ? 'border-slate-700/80 bg-slate-800/50' : 'border-slate-100 bg-slate-50/50'}`}>
                    {['Member', 'Monthly Salary', 'Present', 'Absent', 'Half-Day', 'Late', 'Early-Out', 'Deduction', 'Payable', ''].map(h => (
                      <th key={h} className={`text-left py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDark ? 'divide-slate-700/40' : 'divide-slate-50'}`}>
                  {salaryLoading && (
                    <tr><td colSpan={10} className="py-14 text-center">
                      <Loader2 className="h-6 w-6 mx-auto animate-spin text-slate-400" />
                    </td></tr>
                  )}
                  {!salaryLoading && salaryReports
                    .filter(r => {
                      const q = salarySearch.toLowerCase();
                      return !q || (r.full_name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q);
                    })
                    .map(r => {
                      const isOpen = expandedSalaryId === r.user_id;
                      const detail = salaryDetail[r.user_id];
                      return (
                        <React.Fragment key={r.user_id}>
                          <tr className={`transition-colors cursor-pointer ${isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'}`}
                            onClick={() => toggleSalaryDetail(r.user_id)}>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center text-white text-xs font-black bg-gradient-to-br from-blue-500 to-indigo-600">
                                  {r.profile_picture
                                    ? <img src={r.profile_picture} alt="" className="w-full h-full object-cover" />
                                    : r.full_name?.charAt(0)?.toUpperCase()}
                                </div>
                                <div>
                                  <p className={`font-semibold text-xs leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{r.full_name}</p>
                                  <p className="text-[11px] text-slate-400 truncate max-w-[160px]">{r.email}</p>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-xs font-semibold">₹{(r.monthly_salary || 0).toLocaleString('en-IN')}</td>
                            <td className="py-3 px-4 text-xs"><span className="text-emerald-600 font-semibold">{r.present_days}</span></td>
                            <td className="py-3 px-4 text-xs"><span className="text-red-500 font-semibold">{r.absent_days}</span></td>
                            <td className="py-3 px-4 text-xs"><span className="text-amber-600 font-semibold">{r.half_days}</span></td>
                            <td className="py-3 px-4 text-xs"><span className="text-orange-500 font-semibold">{r.late_days}</span></td>
                            <td className="py-3 px-4 text-xs"><span className="text-orange-500 font-semibold">{r.early_out_days}</span></td>
                            <td className="py-3 px-4 text-xs font-semibold text-red-500">−₹{(r.deduction_amount || 0).toLocaleString('en-IN')}</td>
                            <td className="py-3 px-4 text-xs font-bold" style={{ color: COLORS.emeraldGreen }}>₹{(r.payable_salary || 0).toLocaleString('en-IN')}</td>
                            <td className="py-3 px-4">
                              {isOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={10} className={`p-0 ${isDark ? 'bg-slate-900/40' : 'bg-slate-50/60'}`}>
                                <div className="px-5 py-4">
                                  {salaryDetailLoadingId === r.user_id && !detail && (
                                    <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading day-by-day breakdown…
                                    </div>
                                  )}
                                  {detail && (
                                    <>
                                      <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px]">
                                        <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                                          {detail.total_working_days} days this month · ₹{detail.per_day_salary?.toLocaleString('en-IN')}/day
                                        </span>
                                        <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                                          Late after {detail.late_after} AM · Early-out before {detail.early_out_before}
                                        </span>
                                        <span className="font-semibold text-red-500">
                                          Total deduction: {detail.total_deduction_days} day(s) = ₹{detail.deduction_amount?.toLocaleString('en-IN')}
                                        </span>
                                      </div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {(detail.days || []).map(d => {
                                          const cfg = {
                                            present:            { bg: '#DCFCE7', color: '#15803D', icon: CalendarCheck2, label: 'Present' },
                                            absent:             { bg: '#FEE2E2', color: '#B91C1C', icon: CalendarX2,     label: 'Absent'  },
                                            half_day:           { bg: '#FEF3C7', color: '#B45309', icon: CalendarClock, label: 'Half-day' },
                                            late:               { bg: '#FFEDD5', color: '#C2410C', icon: CalendarClock, label: 'Late punch-in' },
                                            early_out:          { bg: '#FFEDD5', color: '#C2410C', icon: CalendarClock, label: 'Early punch-out' },
                                            late_and_early_out: { bg: '#FEE2E2', color: '#B91C1C', icon: CalendarClock, label: 'Late & early-out' },
                                            holiday:            { bg: '#E0F2FE', color: '#0369A1', icon: CalendarOff,   label: 'Holiday' },
                                          }[d.status] || { bg: '#F1F5F9', color: '#64748B', icon: CalendarClock, label: d.status };
                                          const Icon = cfg.icon;
                                          return (
                                            <div key={d.date} title={`${d.date} — ${cfg.label}${d.deduction ? ` (−${d.deduction} day)` : ''}`}
                                              className="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-semibold"
                                              style={{ background: cfg.bg, color: cfg.color, minWidth: 44 }}>
                                              <Icon className="h-3 w-3" />
                                              <span>{format(new Date(d.date), 'd MMM')}</span>
                                              {d.deduction > 0 && <span>−{d.deduction}d</span>}
                                            </div>
                                          );
                                        })}
                                        {(detail.days || []).length === 0 && (
                                          <p className="text-xs text-slate-400">No working days elapsed yet this month.</p>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                </tbody>
              </table>
              {!salaryLoading && salaryReports.length === 0 && (
                <div className={`py-14 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Wallet className="h-8 w-8 mx-auto mb-2 opacity-25" />
                  <p className="text-sm font-medium">No employees have a monthly salary set yet</p>
                  <p className="text-xs mt-1">Open <b>Users</b> tab → Edit a member → set their Monthly Salary.</p>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}


      {/* ════ ACCESS REQUESTS TAB (Permission Governance) ════ */}
      {mainTab === 'access_requests' && isAdmin && (
        <motion.div variants={itemVariants} className="space-y-5">
          {/* Sub-tab selector */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[
              { id: 'pending', label: 'Pending', icon: Clock },
              { id: 'history', label: 'History', icon: CheckCircle },
              { id: 'grants',  label: 'Active Grants', icon: ShieldCheck },
            ].map(t => {
              const Icon = t.icon;
              const count = t.id === 'pending' ? pgRequests.filter(r => r.status === 'pending').length : undefined;
              return (
                <button key={t.id} onClick={() => setPgReqTab(t.id)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
                    pgReqTab === t.id ? 'text-white shadow-md' : isDark ? 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600 hover:text-slate-200' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
                  }`}
                  style={pgReqTab === t.id ? { background: GRADIENT } : {}}>
                  <Icon className="h-4 w-4" />{t.label}
                  {count > 0 && <span className="ml-1 text-[10px] font-bold bg-white/30 text-white px-1.5 py-0.5 rounded-full">{count}</span>}
                </button>
              );
            })}
            <button onClick={fetchPermGovData} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all ml-auto border ${isDark ? 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
              <RefreshCw className={`h-4 w-4 ${pgLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {pgLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {/* PENDING REQUESTS */}
              {pgReqTab === 'pending' && (() => {
                const pending = pgRequests.filter(r => r.status === 'pending');
                return (
                  <div className={`rounded-2xl border overflow-hidden shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    {pending.length === 0 ? (
                      <div className="py-20 text-center">
                        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: `${COLORS.emeraldGreen}15` }}>
                          <CheckCircle className="h-7 w-7" style={{ color: COLORS.emeraldGreen }} />
                        </div>
                        <p className="font-bold text-slate-700 dark:text-slate-200">No pending requests</p>
                        <p className="text-sm text-slate-400 mt-1">All access requests have been decided.</p>
                      </div>
                    ) : (
                      <div className="divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                        {pending.map(r => (
                          <div key={r.id} className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{r.user_name}</p>
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Pending</span>
                              </div>
                              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                                Requesting access to <span className="font-semibold text-slate-700 dark:text-slate-200">{r.module_label}</span>
                              </p>
                              {r.reason && <p className="text-xs text-slate-400 mt-1 italic">"{r.reason}"</p>}
                            </div>
                            <div className="flex gap-2 shrink-0">
                              <Button onClick={() => pgDecide(r.id, 'approve')}
                                className="h-9 px-5 rounded-xl font-semibold text-sm text-white shadow-sm"
                                style={{ background: GRAD_GREEN }}>
                                <CheckCircle className="h-3.5 w-3.5 mr-1.5" /> Approve
                              </Button>
                              <Button onClick={() => pgDecide(r.id, 'reject')} variant="outline"
                                className="h-9 px-5 rounded-xl font-semibold text-sm border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950">
                                <XCircle className="h-3.5 w-3.5 mr-1.5" /> Reject
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* HISTORY */}
              {pgReqTab === 'history' && (() => {
                const decided = pgRequests.filter(r => r.status !== 'pending');
                return (
                  <div className={`rounded-2xl border overflow-hidden shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    {decided.length === 0 ? (
                      <div className="py-20 text-center">
                        <p className="font-bold text-slate-400">No decisions yet</p>
                      </div>
                    ) : (
                      <div className="divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                        {decided.map(r => (
                          <div key={r.id} className="p-4 flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                                {r.user_name} — <span className="font-medium">{r.module_label}</span>
                              </p>
                              <p className="text-xs text-slate-400 mt-0.5">
                                Decided by {r.decided_by_name || '—'}
                              </p>
                            </div>
                            <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${r.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800' : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'}`}>
                              {r.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ACTIVE GRANTS */}
              {pgReqTab === 'grants' && (() => {
                const activeUsers = pgGrants.filter(u => u.role !== 'admin' && pgModules.some(m => u.permissions?.[m.flag]));
                return (
                  <div className={`rounded-2xl border overflow-hidden shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    {activeUsers.length === 0 ? (
                      <div className="py-20 text-center">
                        <p className="font-bold text-slate-400">No active grants</p>
                        <p className="text-sm text-slate-400 mt-1">No non-admin users have been granted account module access yet.</p>
                      </div>
                    ) : (
                      <div className="divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                        {activeUsers.map(u => {
                          const activeModules = pgModules.filter(m => u.permissions?.[m.flag]);
                          return (
                            <div key={u.id} className="p-4">
                              <p className={`font-bold text-sm mb-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{u.full_name || u.email}</p>
                              <div className="flex flex-wrap gap-2">
                                {activeModules.map(m => (
                                  <span key={m.module}
                                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border"
                                    style={{ background: `${COLORS.mediumBlue}10`, color: COLORS.mediumBlue, borderColor: `${COLORS.mediumBlue}30` }}>
                                    {m.label}
                                    <button onClick={() => pgRevoke(u.id, m.module)} title="Revoke access"
                                      className="hover:text-red-500 transition-colors ml-0.5">
                                      <UserX className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </motion.div>
      )}

      {/* ════ IDENTIX TAB ════ */}
      {mainTab === 'identix' && (
        <motion.div variants={itemVariants}>
          {/* Identix sub-tabs */}
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
            {identixSubTabs.map(tab => {
              const Icon = tab.icon;
              return (
                <button key={tab.id} onClick={() => setIdentixTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
                    identixTab === tab.id ? 'text-white shadow-md' : isDark ? 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600 hover:text-slate-200' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
                  }`}
                  style={identixTab === tab.id ? { background: GRADIENT } : {}}>
                  <Icon className="h-4 w-4" />{tab.label}
                </button>
              );
            })}
          </div>

          <SectionCard>
            <div className="p-5">
              <AnimatePresence mode="wait">
                <motion.div key={identixTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
                  {identixTab === 'dashboard'  && <IdentixDashboardTab />}
                  {identixTab === 'devices'    && <IdentixDevicesTab />}
                  {identixTab === 'enrollment' && <IdentixEnrollmentTab />}
                  {identixTab === 'logs'       && <IdentixAttendanceTab />}
                </motion.div>
              </AnimatePresence>
            </div>
          </SectionCard>
        </motion.div>
      )}

      {/* ════ CREATE / EDIT DIALOG ════ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto users-slim rounded-2xl p-0 border-0 shadow-2xl gap-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{selectedUser ? `Edit Member — ${selectedUser.full_name}` : 'Add New Team Member'}</DialogTitle>
            <DialogDescription>{selectedUser ? 'Update user profile and settings.' : 'Register a new team member.'}</DialogDescription>
          </DialogHeader>
          <DialogGradHeader gradient={GRADIENT} icon={selectedUser ? Pencil : Plus}
            eyebrow={selectedUser ? 'Edit Member' : 'New Member'}
            title={selectedUser ? selectedUser.full_name : 'Add Team Member'}
            subtitle={isAdmin ? 'Full administrative control' : 'Update your personal information'}
            onMinimize={() => { minimizeUserForm(); setDialogOpen(false); toast.message('Team member form minimized', { description: 'Resume it anytime from the dock in the bottom-left corner.' }); }} />
          <div className="p-6 space-y-6 bg-white dark:bg-slate-900">
            <div className="flex justify-center">
              <label className="relative group cursor-pointer">
                <div className="w-24 h-24 rounded-2xl overflow-hidden border-4 border-white dark:border-slate-800 shadow-lg ring-1 ring-slate-200 dark:ring-slate-700">
                  {formData.profile_picture
                    ? <img src={formData.profile_picture} alt="Profile" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center" style={{ background: GRADIENT }}>
                        <UserIcon className="h-10 w-10 text-white/60" />
                      </div>}
                </div>
                <div className="absolute bottom-1 right-1 w-8 h-8 bg-white dark:bg-slate-700 rounded-xl flex items-center justify-center shadow-md border border-slate-200 dark:border-slate-600 group-hover:scale-110 transition-transform">
                  <Camera className="h-4 w-4 text-blue-600" />
                </div>
                <input type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Full Name</Label>
                <Input name="full_name" value={formData.full_name} onChange={handleInput} placeholder="Full Name" className="h-11 rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Email Address</Label>
                <Input type="email" name="email" value={formData.email} onChange={handleInput}
                  disabled={!isAdmin || (selectedUser && selectedUser.id === user?.id)}
                  placeholder="name@company.com" className="h-11 rounded-xl" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Phone Number</Label>
                <Input name="phone" value={formData.phone} onChange={handleInput} placeholder="+91 98765 43210" className="h-11 rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" />{selectedUser ? 'New Password' : 'Initial Password'}
                </Label>
                <Input type="password" name="password" value={formData.password} onChange={handleInput}
                  placeholder={selectedUser ? 'Leave blank to keep current' : 'Secure password'} className="h-11 rounded-xl" />
              </div>
            </div>
            <div className={`rounded-xl p-5 border ${isDark ? 'bg-blue-950/20 border-blue-900/50' : 'bg-blue-50 border-blue-100'}`}>
              <div className="flex items-center gap-2 mb-4">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isDark ? 'bg-blue-900/60' : 'bg-blue-100'}`}>
                  <Clock className="h-3.5 w-3.5 text-blue-600" />
                </div>
                <span className="font-semibold text-sm text-blue-700 dark:text-blue-400 uppercase tracking-wider">Work Shift Schedule</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[{ label: 'Punch In', name: 'punch_in_time' }, { label: 'Grace Period', name: 'grace_time' }, { label: 'Punch Out', name: 'punch_out_time' }].map(f => (
                  <div key={f.name} className="space-y-1.5">
                    <Label className="text-xs font-medium text-blue-600 dark:text-blue-400">{f.label}</Label>
                    <Input type="time" name={f.name} value={formData[f.name]} onChange={handleInput} className="h-11 rounded-xl" />
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Birthday</Label>
                <Input type="date" name="birthday" value={formData.birthday} onChange={handleInput} className="h-11 rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Telegram ID</Label>
                <Input type="number" name="telegram_id" value={formData.telegram_id} onChange={handleInput} placeholder="123456789" className="h-11 rounded-xl" />
              </div>
            </div>

            {/* ── Employment Details ── */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 dark:bg-blue-900/10 dark:border-blue-800/40 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-blue-600" />
                <span className="font-semibold text-sm text-blue-700 dark:text-blue-400 uppercase tracking-wider">Employment Details</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Joining Date</Label>
                  <Input type="date" name="joining_date" value={formData.joining_date} onChange={handleInput} className="h-11 rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Training Period End</Label>
                  <Input type="date" name="training_period_end" value={formData.training_period_end} onChange={handleInput} className="h-11 rounded-xl" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Payroll Date</Label>
                  <Input type="date" name="payroll_date" value={formData.payroll_date} onChange={handleInput} className="h-11 rounded-xl" />
                  <p className="text-[10px] text-slate-400">Monthly salary processing date</p>
                </div>
                {isAdmin && (
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Monthly Salary (₹)</Label>
                    <div className="relative">
                      <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                      <Input type="number" min="0" step="0.01" name="monthly_salary" value={formData.monthly_salary}
                        onChange={handleInput} placeholder="e.g. 30000" className="h-11 rounded-xl pl-8" />
                    </div>
                    <p className="text-[10px] text-slate-400">Used to auto-calculate salary due in the Salary tab</p>
                  </div>
                )}
              </div>
            </div>

            {isAdmin && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Role</Label>
                    <Select value={formData.role} onValueChange={handleRoleChange}>
                      <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="staff">Staff</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Account Status</Label>
                    <Select value={formData.status} onValueChange={v => setFormData(p => ({ ...p, status: v, is_active: v === 'active' }))}>
                      <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="pending_approval">Pending Approval</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {formData.role !== 'admin' && (
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Associated Company</Label>
                    <Select
                      value={formData.company_id || '__none__'}
                      onValueChange={v => {
                        if (v === '__none__') {
                          setFormData(p => ({ ...p, company_id: '', company_name: '' }));
                        } else {
                          const co = companies.find(c => c.id === v);
                          setFormData(p => ({ ...p, company_id: v, company_name: co?.name || '' }));
                        }
                      }}>
                      <SelectTrigger className="h-11 rounded-xl"><SelectValue placeholder="No company assigned" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— No company —</SelectItem>
                        {companies.map(co => (
                          <SelectItem key={co.id} value={co.id}>{co.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2.5">
                  <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Assigned Departments</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                    {DEPARTMENTS.map(dept => {
                      const active = formData.departments.includes(dept.value);
                      return (
                        <button key={dept.value} type="button" onClick={() => toggleDept(dept.value)}
                          className="h-10 rounded-xl text-xs font-bold border-2 transition-all hover:shadow-sm"
                          style={active ? { background: dept.color, color: 'white', borderColor: dept.color } : { background: dept.bg, color: dept.color, borderColor: `${dept.color}30` }}>
                          {dept.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={`px-6 py-4 border-t flex justify-end gap-3 rounded-b-2xl ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-100 bg-slate-50'}`}>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="h-10 px-6 rounded-xl text-sm">Cancel</Button>
            <Button onClick={handleSubmit} disabled={loading} className="h-10 px-8 rounded-xl font-semibold text-sm text-white" style={{ background: GRAD_GREEN }}>
              {loading ? 'Saving…' : selectedUser ? 'Save Changes' : 'Create Member'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ════ PERMISSIONS DIALOG ════ */}
      <Dialog open={permDialogOpen} onOpenChange={setPermDialogOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:w-[calc(100vw-2rem)] max-w-5xl max-h-[92vh] overflow-x-hidden overflow-y-auto users-slim rounded-2xl p-0 border-0 shadow-2xl gap-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{`Permissions — ${selectedUserForPerms?.full_name || 'User'}`}</DialogTitle>
            <DialogDescription>Configure access levels and module permissions for this user.</DialogDescription>
          </DialogHeader>
          <DialogGradHeader gradient={GRADIENT} icon={Shield} eyebrow="Access Governance"
            title={`Permissions — ${selectedUserForPerms?.full_name || ''}`}
            subtitle="Configure access levels and module permissions" />
          <div className="p-6 space-y-5 bg-white dark:bg-slate-900">
            <PermissionMatrixSummary permissions={permissions} />
            {/* Manager scope notice */}
            {isManager && !isAdmin && (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                  <strong>Manager scope:</strong> You can only grant permissions you yourself possess. Admin-only flags (Delete, Send Reminders, Rankings) are locked and cannot be changed.
                </p>
              </div>
            )}
            {/* Stale-permissions notice — shown for non-admin targets */}
            {isAdmin && selectedUserForPerms?.role !== 'admin' && (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                <AlertCircle className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
                  <strong>Tip:</strong> If this user can't access pages their permissions allow, use <strong>Quick Reset → {selectedUserForPerms?.role} Template</strong> then re-apply any custom grants and Save. This fixes stale or missing permission flags from older accounts.
                </p>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Quick Reset:</span>
              {(isAdmin ? ['staff', 'manager', 'admin'] : ['staff']).map(role => {
                const cfg = ROLE_CONFIG[role]; const RIcon = cfg.icon;
                return (
                  <button key={role} onClick={() => resetPermissionsToRole(role)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all hover:shadow-sm capitalize"
                    style={{ borderColor: `${cfg.hex}40`, color: cfg.hex, background: `${cfg.hex}08` }}>
                    <RIcon className="h-3 w-3" />{role} Template
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-1.5 pb-1 w-full min-w-0">
              {permTabs.map(tab => {
                const TabIcon = PERMISSION_ICON_MAP[tab.icon] || FileText;
                return (
                  <button key={tab.id} onClick={() => setActivePermTab(tab.id)}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold text-xs transition-all whitespace-nowrap ${
                      activePermTab === tab.id ? 'text-white shadow-md' : isDark ? 'bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-200 hover:border-slate-600' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
                    }`}
                    style={activePermTab === tab.id ? { background: GRADIENT } : {}}>
                    <TabIcon className="h-3.5 w-3.5" />{tab.label}
                  </button>
                );
              })}
            </div>
            {activePermTab === 'modules' && (
              <AccessGovernancePanel
                value={permissions}
                onChange={setPermissions}
                isAdminUser={selectedUserForPerms?.role === 'admin'}
                readOnly={!canManagePermissions}
                showSave={false}
              />
            )}
            {activePermTab === 'view' && (
              <div>
                <SectionHeader icon={Eye} title="View Permissions" color="#3B82F6" count={GLOBAL_PERMS.filter(p => permissions[p.key]).length} />
                <div className="space-y-2">{GLOBAL_PERMS.map(p => <PermToggleRow key={p.key} permKey={p.key} label={p.label} desc={p.desc} icon={PERMISSION_ICON_MAP[p.icon] || FileText} permissions={permissions} setPermissions={setPermissions} />)}</div>
              </div>
            )}
            {activePermTab === 'ops' && (
              <div>
                <SectionHeader icon={Settings} title="Operational Controls" color="#8B5CF6" count={OPS_PERMS.filter(p => permissions[p.key]).length} />
                <div className="space-y-2">{OPS_PERMS.map(p => <PermToggleRow key={p.key} permKey={p.key} label={p.label} desc={p.desc} icon={p.icon} permissions={permissions} setPermissions={setPermissions} />)}</div>
              </div>
            )}
            {activePermTab === 'edit' && (
              <div>
                <SectionHeader icon={Pencil} title="Modification Rights" color="#F59E0B" count={EDIT_PERMS.filter(p => permissions[p.key]).length} />
                <div className="space-y-2">{EDIT_PERMS.map(p => <PermToggleRow key={p.key} permKey={p.key} label={p.label} desc={p.desc} icon={p.icon} permissions={permissions} setPermissions={setPermissions} />)}</div>
              </div>
            )}
            {activePermTab === 'cross' && (
              <div className="space-y-5">
                <SectionHeader icon={UsersIcon} title="Cross-User Data Access" color={COLORS.emeraldGreen} />
                <p className="text-sm text-slate-500 dark:text-slate-400 -mt-2">Select users whose data this user can view. Cross-visibility is fully explicit — only users selected below will be visible.</p>
                {[
                  { key: 'view_other_tasks',      label: 'Tasks',      icon: Layers,      color: '#3B82F6' },
                  { key: 'view_other_attendance', label: 'Attendance', icon: Clock,       color: '#8B5CF6' },
                  { key: 'view_other_reports',    label: 'Reports',    icon: BarChart2,   color: '#F59E0B' },
                  { key: 'view_other_todos',      label: 'Todos',      icon: CheckCircle, color: '#10B981' },
                  { key: 'view_other_activity',   label: 'Activity',   icon: Activity,    color: '#EF4444' },
                  { key: 'view_other_visits',     label: 'Visits',     icon: MapPin,      color: '#0F766E' },
                ].map(section => {
                  const SIcon = section.icon;
                  const selectedCount = (permissions[section.key] || []).length;
                  return (
                    <SectionCard key={section.key}>
                      <CardHeaderRow iconBg={isDark ? 'bg-slate-700' : 'bg-slate-50'} icon={<SIcon className="h-4 w-4" style={{ color: section.color }} />}
                        title={section.label} subtitle={`${selectedCount} member${selectedCount !== 1 ? 's' : ''} selected`} badge={selectedCount || undefined} />
                      <div className="p-4 flex flex-wrap gap-2">
                        {users.filter(u => u.id !== selectedUserForPerms?.id).map(u => {
                          const isSel = (permissions[section.key] || []).includes(u.id);
                          return (
                            <button key={u.id}
                              onClick={() => setPermissions(prev => ({ ...prev, [section.key]: isSel ? (prev[section.key] || []).filter(id => id !== u.id) : [...(prev[section.key] || []), u.id] }))}
                              className="px-3.5 py-2 rounded-xl text-xs font-semibold border-2 transition-all hover:shadow-sm"
                              style={isSel ? { background: section.color, color: 'white', borderColor: section.color } : isDark ? { background: '#1e293b', color: '#94a3b8', borderColor: '#334155' } : { background: '#f8fafc', color: '#475569', borderColor: '#e2e8f0' }}>
                              {isSel ? '✓ ' : ''}{u.full_name}
                            </button>
                          );
                        })}
                      </div>
                    </SectionCard>
                  );
                })}
              </div>
            )}
            {activePermTab === 'clients' && (
              <ClientsPermTab
                permissions={permissions}
                clients={clients}
                isDark={isDark}
                setPermissions={setPermissions}
                clientSearch={clientSearch}
                setClientSearch={setClientSearch}
              />
            )}
          </div>
          <div className={`px-6 py-4 border-t flex items-center justify-between gap-4 rounded-b-2xl ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-100 bg-slate-50'}`}>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>{enabledPermCount} permissions enabled</span>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setPermDialogOpen(false)} className="h-10 px-6 rounded-xl text-sm">Cancel</Button>
              <Button onClick={handleSavePermissions} disabled={loading} className="h-10 px-8 rounded-xl font-semibold text-sm text-white" style={{ background: GRAD_GREEN }}>
                {loading ? 'Saving…' : 'Save Permissions'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* OFFBOARDING DIALOG */}
      <OffboardingDialog
        open={offboardDialogOpen}
        onClose={() => { setOffboardDialogOpen(false); setOffboardTarget(null); }}
        targetUser={offboardTarget}
        allUsers={users}
        onComplete={() => { fetchUsers(); }}
      />

      {/* ── QUICK ADD/UPDATE SALARY DIALOG (Salary tab) ── */}
      <Dialog open={salaryDialogOpen} onOpenChange={setSalaryDialogOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-4 w-4" style={{ color: COLORS.mediumBlue }} />
              {salaryDialogUserId ? 'Update Monthly Salary' : 'Add Salary'}
            </DialogTitle>
            <DialogDescription>Set an employee&apos;s monthly salary so it appears in the Salary tab.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Member</Label>
              <Select value={salaryDialogUserId} onValueChange={v => {
                setSalaryDialogUserId(v);
                const u = users.find(x => x.id === v);
                setSalaryDialogAmount(u?.monthly_salary != null ? String(u.monthly_salary) : '');
              }}>
                <SelectTrigger className="h-11 rounded-xl">
                  <SelectValue placeholder="Select a member" />
                </SelectTrigger>
                <SelectContent>
                  {users.filter(u => u.is_active !== false).map(u => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name} {u.monthly_salary != null ? `· ₹${Number(u.monthly_salary).toLocaleString('en-IN')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Monthly Salary (₹)</Label>
              <div className="relative">
                <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <Input type="number" min="0" step="0.01" value={salaryDialogAmount}
                  onChange={e => setSalaryDialogAmount(e.target.value)}
                  placeholder="e.g. 30000" className="h-11 rounded-xl pl-8" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSalaryDialogOpen(false)} className="h-10 px-6 rounded-xl text-sm">Cancel</Button>
            <Button onClick={handleSaveQuickSalary} disabled={salaryDialogSaving}
              className="h-10 px-6 rounded-xl font-semibold text-sm text-white" style={{ background: GRAD_GREEN }}>
              {salaryDialogSaving ? 'Saving…' : 'Save Salary'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
