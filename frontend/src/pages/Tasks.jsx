import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import useDark from '../hooks/useDark';
import { useAuth } from '../contexts/AuthContext';

// ✅ UI COMPONENTS (fixed)
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Checkbox } from '../components/ui/checkbox';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '../components/ui/command';

// ✅ OTHER LIBS
import { toast } from 'sonner';
import api from '../lib/api';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';

// ✅ ICONS
import {
  Plus, Edit, Trash2, Search, Calendar, Building2, User, Users,
  LayoutGrid, List, Circle, ArrowRight, Check, Repeat, Sparkles,
  MessageSquare, Bell, FileText, Calendar as CalendarIcon,
  X, ChevronDown, Filter, Clock, AlertCircle, CheckCircle2,
  TrendingUp, MoreHorizontal, Copy, SlidersHorizontal,
  Briefcase, Target, Activity, ChevronRight, Sun,
  Loader2, Mail, Send, Trophy, Medal, Star, Zap, Crown, ChevronsUpDown,
  Minimize2, ClipboardList, Info, Settings2, ArrowUp, ArrowDown, Eye, EyeOff,
  BellRing, CheckSquare, Square,
} from 'lucide-react';
import AIFileInsights from '@/components/ui/AIFileInsights.jsx';
import { useFormMinimizer } from '@/contexts/MinimizedFormsContext';
import { getTasksCache, setTasksCache, prefetchTasksData } from '@/lib/tasksPrefetch';


// ── Tasks session cache (shared with Dashboard's prefetcher) ────────────────
// Dashboard warms this exact cache before you ever reach this page, so the
// New Task form's dropdowns are populated on first paint.
// ─── API Helpers ─────────────────────────────────────────────────────────────
const API_BASE = api.defaults.baseURL;
const getAuthHeader = () => {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// ─── Brand Colors ────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen:   '#5CCB5F',
  coral:        '#FF6B6B',
  amber:        '#F59E0B',
};

// ─── Spring Physics (matches Dashboard) ─────────────────────────────────────
const springPhysics = {
  card:   { type: 'spring', stiffness: 280, damping: 22, mass: 0.85 },
  lift:   { type: 'spring', stiffness: 320, damping: 24, mass: 0.9  },
  button: { type: 'spring', stiffness: 400, damping: 28 },
  tap:    { type: 'spring', stiffness: 500, damping: 30 },
};

// ─── Department categories ───────────────────────────────────────────────────
const DEPARTMENTS = [
  { value: 'gst',          label: 'GST' },
  { value: 'income_tax',   label: 'INCOME TAX' },
  { value: 'accounts',     label: 'ACCOUNTS' },
  { value: 'tds',          label: 'TDS' },
  { value: 'roc',          label: 'ROC' },
  { value: 'trademark',    label: 'TRADEMARK' },
  { value: 'msme_smadhan', label: 'MSME SMADHAN' },
  { value: 'fema',         label: 'FEMA' },
  { value: 'dsc',          label: 'DSC' },
  { value: 'other',        label: 'OTHER' },
];

const TASK_CATEGORIES = DEPARTMENTS;

const RECURRENCE_PATTERNS = [
  { value: 'daily',   label: 'Daily' },
  { value: 'weekly',  label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly',  label: 'Yearly' },
];

// ─── CA/CS Compliance Workflow Templates ─────────────────────────────────────
const COMPLIANCE_WORKFLOWS = [
  {
    id: 1, name: "Monthly GST Compliance", category: "gst",
    title: "Monthly GST Filing - GSTR-1 & GSTR-3B",
    description: "- Reconcile GSTR-2B with purchase register\n- Prepare GSTR-1 (B2B/B2C/CDNR)\n- File GSTR-3B\n- Pay tax & generate challan\n- Reconcile ITC\n- Review for notices\n- Update books of accounts\n- Check HSN/SAC codes",
    recurrence_pattern: "monthly", recurrence_interval: 1, priority: "high", estimatedDays: 5, estimatedHours: 18, frequency: "Monthly"
  },
  {
    id: 2, name: "Quarterly TDS Compliance", category: "tds",
    title: "Quarterly TDS Return - 24Q/26Q/27Q",
    description: "- Download Form 16A/27D from TRACES\n- Reconcile TDS with books\n- Prepare & file quarterly return\n- Generate TDS certificates\n- Pay TDS before due date\n- Update challan status\n- Check late fee/interest",
    recurrence_pattern: "monthly", recurrence_interval: 3, priority: "high", estimatedDays: 7, estimatedHours: 22, frequency: "Quarterly"
  },
  {
    id: 3, name: "ROC Annual Filing (Private Ltd)", category: "roc",
    title: "Annual ROC Filing - AOC-4 & MGT-7",
    description: "- Prepare financial statements\n- File AOC-4 XBRL\n- File MGT-7\n- File MGT-8 (if applicable)\n- Board & AGM minutes\n- DIR-12 for director changes\n- Check DIN status\n- Update registers",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "critical", estimatedDays: 15, estimatedHours: 45, frequency: "Annual"
  },
  {
    id: 4, name: "Income Tax Return (Company)", category: "income_tax",
    title: "ITR-6 Filing + Tax Audit (if applicable)",
    description: "- Reconcile 26AS & AIS\n- Prepare ITR-6\n- File Tax Audit Report (3CD)\n- Pay advance tax / self assessment tax\n- Check Form 3CA/3CB\n- Upload balance sheet\n- Claim deductions u/s 10AA/80\n- MAT calculation",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "critical", estimatedDays: 20, estimatedHours: 55, frequency: "Annual"
  },
  {
    id: 5, name: "DSC Renewal & PAN TAN", category: "dsc",
    title: "DSC Renewal + PAN/TAN Compliance",
    description: "- Check DSC expiry (30 days prior)\n- Renew Class 3 DSC\n- Update PAN/TAN details\n- Link Aadhaar with PAN\n- Update DSC in MCA & GST portal\n- Verify e-filing credentials",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "medium", estimatedDays: 3, estimatedHours: 8, frequency: "Annual"
  },
  {
    id: 6, name: "MSME Samadhan Filing", category: "msme_smadhan",
    title: "MSME Delayed Payment Complaint",
    description: "- Identify delayed payments >45 days\n- File Udyam Samadhan application\n- Follow up with buyer\n- Generate reference number\n- Monitor status on portal\n- Prepare supporting documents",
    recurrence_pattern: "monthly", recurrence_interval: 1, priority: "medium", estimatedDays: 4, estimatedHours: 12, frequency: "Monthly"
  },
  {
    id: 7, name: "FEMA Annual Return", category: "fema",
    title: "FC-GPR / FLA / Annual FEMA Return",
    description: "- Collect foreign investment details\n- File FLA return on RBI portal\n- File FC-GPR for fresh allotment\n- File FC-TRS for transfer\n- Maintain LOU/LOC records\n- Check ECB compliance",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "high", estimatedDays: 10, estimatedHours: 30, frequency: "Annual"
  },
  {
    id: 8, name: "Trademark Renewal", category: "trademark",
    title: "Trademark Renewal & Monitoring",
    description: "- Check renewal due date (6 months prior)\n- File TM-R application\n- Pay renewal fee\n- Monitor opposition period\n- File TM-M for modification\n- Update trademark register",
    recurrence_pattern: "yearly", recurrence_interval: 10, priority: "medium", estimatedDays: 5, estimatedHours: 15, frequency: "Every 10 Years"
  },
  {
    id: 9, name: "GSTR-9 Annual Reconciliation", category: "gst",
    title: "Annual GST Return - GSTR-9 & GSTR-9C",
    description: "- Reconcile GSTR-1, 3B & 2B\n- Prepare GSTR-9\n- Audit GSTR-9C (if turnover >5Cr)\n- Reconcile ITC & output tax\n- File before 31st Dec",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "critical", estimatedDays: 12, estimatedHours: 35, frequency: "Annual"
  },
  {
    id: 10, name: "PF & ESIC Monthly", category: "accounts",
    title: "Monthly PF & ESIC Contribution & Return",
    description: "- Calculate PF & ESIC on salary\n- Deposit contribution by 15th\n- File ECR return\n- Reconcile challan\n- Generate Form 3A/6A",
    recurrence_pattern: "monthly", recurrence_interval: 1, priority: "high", estimatedDays: 3, estimatedHours: 10, frequency: "Monthly"
  },
  {
    id: 11, name: "Board Meeting Compliance", category: "roc",
    title: "Quarterly Board Meeting & Minutes",
    description: "- Schedule board meeting\n- Prepare agenda & notes\n- Record minutes in MBP-1\n- File MGT-14 for resolutions\n- Update registers",
    recurrence_pattern: "monthly", recurrence_interval: 3, priority: "medium", estimatedDays: 4, estimatedHours: 14, frequency: "Quarterly"
  },
  {
    id: 12, name: "Income Tax TDS/TCS Quarterly", category: "tds",
    title: "TDS/TCS Quarterly Return & Certificates",
    description: "- File 26Q/27Q/27EQ\n- Issue Form 16/16A\n- Reconcile with 26AS\n- Pay late fee if any",
    recurrence_pattern: "monthly", recurrence_interval: 3, priority: "high", estimatedDays: 6, estimatedHours: 20, frequency: "Quarterly"
  },
  {
    id: 13, name: "Company Secretarial Annual", category: "roc",
    title: "Annual Secretarial Compliance Package",
    description: "- AGM Notice & Minutes\n- File AOC-4, MGT-7\n- DIR-3 KYC\n- DPT-3 if applicable\n- MBP-1, MBP-2 update",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "critical", estimatedDays: 18, estimatedHours: 50, frequency: "Annual"
  },
  {
    id: 14, name: "GST Annual Audit (if applicable)", category: "gst",
    title: "GST Audit u/s 35(5) + GSTR-9C",
    description: "- Reconcile books with GST returns\n- Prepare reconciliation statement\n- File GSTR-9C\n- Issue audit report",
    recurrence_pattern: "yearly", recurrence_interval: 1, priority: "critical", estimatedDays: 25, estimatedHours: 60, frequency: "Annual"
  },
];

// ─── Status & Priority Styles ─────────────────────────────────────────────────
const STATUS_STYLES = {
  pending:     { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-200',    dot: 'bg-red-500',    label: 'To Do' },
  in_progress: { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200',  dot: 'bg-amber-500',  label: 'In Progress' },
  completed:   { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200',   dot: 'bg-blue-500',   label: 'Completed' },
  overdue:     { bg: 'bg-red-100',   text: 'text-red-800',    border: 'border-red-300',    dot: 'bg-red-700',    label: 'Overdue' },
  due_today:   { bg: 'bg-amber-100', text: 'text-amber-900',  border: 'border-amber-300',  dot: 'bg-amber-500',  label: 'Due Today' },
};

const PRIORITY_STYLES = {
  low: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    text: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-200 dark:border-emerald-800',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
    label: 'Low',
    shortLabel: 'LOW',
  },
  medium: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-800',
    badge: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
    label: 'Medium',
    shortLabel: 'MED',
  },
  high: {
    bg: 'bg-rose-50 dark:bg-rose-950/40',
    text: 'text-rose-700 dark:text-rose-300',
    border: 'border-rose-200 dark:border-rose-800',
    badge: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800',
    dot: 'bg-rose-500',
    bar: 'bg-rose-500',
    label: 'High',
    shortLabel: 'HIGH',
  },
  critical: {
    bg: 'bg-red-50 dark:bg-red-950/40',
    text: 'text-red-700 dark:text-red-300',
    border: 'border-red-200 dark:border-red-800',
    badge: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800',
    dot: 'bg-red-600',
    bar: 'bg-red-600',
    label: 'Critical',
    shortLabel: 'CRIT',
  },
};

const getPriorityStyle = (priority) => {
  const p = String(priority || 'medium').trim().toLowerCase();
  return PRIORITY_STYLES[p] || PRIORITY_STYLES.medium;
};

const getStripeColor = (task, overdue, dueToday) => {
  if (overdue) return 'bg-red-700';
  if (dueToday) return 'bg-amber-500';
  const s = (task.status || '').toLowerCase();
  if (s === 'completed')   return 'bg-blue-600';
  if (s === 'in_progress') return 'bg-amber-500';
  if (s === 'pending') {
    const p = (task.priority || '').toLowerCase();
    if (p === 'critical') return 'bg-red-600';
    if (p === 'high')     return 'bg-rose-500';
    if (p === 'low')      return 'bg-emerald-500';
    return 'bg-amber-400';
  }
  return 'bg-slate-300';
};

// Stable shared reference for "no comments yet" — using a fresh [] per
// render here would give React.memo() a new prop identity every time and
// force every row to re-render even when nothing about it changed.
const EMPTY_ARR = [];

// ─── Animation variants ───────────────────────────────────────────────────────
const containerVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0, delayChildren: 0 } },
};
const itemVariants = {
  hidden:  { opacity: 0, y: 18, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 28 } },
};

const EMPTY_FORM = {
  title: '', description: '', assigned_to: 'unassigned', sub_assignees: [],
  due_date: '', priority: 'medium', status: 'pending', category: 'other',
  categories: [],
  client_id: '', is_recurring: false, recurrence_pattern: 'monthly', recurrence_interval: 1,
  // Per-task popup interval in minutes. Empty/null = use universal default.
  popup_interval_minutes: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MetricCard — matches Dashboard card design exactly
// ═══════════════════════════════════════════════════════════════════════════════
const MetricCard = memo(function MetricCard({ label, value, sub, accent, icon: Icon, active, onClick, progress, isDark }) {
  return (
  <motion.div
    whileHover={{ y: -3, transition: springPhysics.card }}
    whileTap={{ scale: 0.985 }}
    onClick={onClick}
    className={`rounded-2xl shadow-sm hover:shadow-lg transition-all cursor-pointer group border
      ${active
        ? 'ring-2'
        : ''
      }
      ${isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200/80 hover:border-slate-300'}
    `}
    style={active ? { ringColor: accent, borderColor: accent } : {}}
  >
    <div className="p-3.5 flex flex-col justify-between h-[100px] overflow-hidden">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1 mr-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          <p className="text-xl font-bold mt-1 tracking-tight" style={{ color: accent }}>
            {value}
          </p>
          {sub && <p className="text-[10px] mt-0.5 text-slate-400">{sub}</p>}
        </div>
        <div
          className="p-2 rounded-xl group-hover:scale-110 transition-transform flex-shrink-0"
          style={{ backgroundColor: `${accent}18` }}
        >
          <Icon className="h-4 w-4" style={{ color: accent }} />
        </div>
      </div>
      {progress !== undefined ? (
        <div className={`mt-2.5 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: `linear-gradient(90deg, ${accent}, ${accent}bb)` }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(progress, 100)}%` }}
            transition={{ duration: 0.9, ease: 'easeOut', delay: 0.2 }}
          />
        </div>
      ) : (
        <div className={`flex items-center gap-1 mt-2 text-xs font-medium group-hover:opacity-80 transition-colors ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          <span>{active ? '✓ filtered' : 'click to filter'}</span>
          <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
        </div>
      )}
    </div>
  </motion.div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// TeamTaskCard — matches other MetricCards exactly, proper alignment
// ═══════════════════════════════════════════════════════════════════════════════
const TeamTaskCard = memo(function TeamTaskCard({ stats, hasCrossVisibility, usersLoading, filterTeamOnly, setFilterTeamOnly, setFilterAssignee, setShowMyTasksOnly, teamTaskBreakdown, isDark }) {
  return (
  <motion.div
    whileHover={{ y: -3, transition: springPhysics.card }}
    whileTap={{ scale: 0.985 }}
    onClick={() => {
      if (!hasCrossVisibility || usersLoading) return;
      setFilterTeamOnly(prev => !prev);
      setFilterAssignee([]);
      setShowMyTasksOnly(false);
    }}
    className={`rounded-2xl shadow-sm hover:shadow-lg transition-all cursor-pointer group border
      ${filterTeamOnly
        ? isDark
          ? 'bg-violet-900/20 border-violet-700'
          : 'bg-violet-50/60 border-violet-300'
        : hasCrossVisibility && stats.teamTask > 0
          ? isDark
            ? 'bg-violet-900/10 border-violet-800 hover:border-violet-700'
            : 'bg-violet-50/40 border-violet-200 hover:border-violet-300'
          : isDark
            ? 'bg-slate-800 border-slate-700 hover:border-slate-600'
            : 'bg-white border-slate-200/80 hover:border-slate-300'
      }
    `}
  >
    <div className="p-3.5 flex flex-col justify-between h-[100px] overflow-hidden">
      {/* TOP ROW — identical layout to other cards */}
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1 mr-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Team Task</p>
          
          <motion.p
            key={stats.teamTask}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="text-xl font-bold mt-1 tracking-tight"
            style={{ color: hasCrossVisibility ? (isDark ? '#a78bfa' : '#7c3aed') : (isDark ? '#475569' : '#94a3b8') }}
          >
            {hasCrossVisibility ? stats.teamTask : 0}
          </motion.p>

          {/* Per-member breakdown — compact, matches dashboard */}
          {!usersLoading && hasCrossVisibility && teamTaskBreakdown.length > 0 && (
            <div className="mt-0.5 max-h-[16px] overflow-hidden">
              {teamTaskBreakdown.slice(0, 1).map(m => (
                <p key={m.id} className="text-[9px] text-slate-400 truncate">
                  {m.name.split(' ')[0].toLowerCase()}: {m.pendingCount}
                  {teamTaskBreakdown.length > 1 ? ` +${teamTaskBreakdown.length - 1} more` : ''}
                </p>
              ))}
            </div>
          )}
          {!hasCrossVisibility && (
            <p className="text-[9px] text-slate-400 mt-0.5">no access</p>
          )}
        </div>

        {/* Icon — same size/style as other cards */}
        <div
          className="p-2 rounded-xl group-hover:scale-110 transition-transform flex-shrink-0"
          style={{ backgroundColor: hasCrossVisibility ? (isDark ? 'rgba(167,139,250,0.15)' : '#ede9fe') : (isDark ? 'rgba(71,85,105,0.2)' : '#f8fafc') }}
        >
          <Users className="h-4 w-4" style={{ color: hasCrossVisibility ? '#7c3aed' : (isDark ? '#475569' : '#cbd5e1') }} />
        </div>
      </div>

      {/* BOTTOM ROW — identical to other cards */}
      <div className={`flex items-center gap-1 mt-2 text-xs font-medium transition-colors ${hasCrossVisibility ? 'group-hover:text-violet-500' : ''} ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        {hasCrossVisibility ? (
          <>
            <span>{filterTeamOnly ? '✓ filtering team' : 'click to filter'}</span>
            <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
           
          </>
        ) : (
          <span>cross visibility off</span>
        )}
      </div>
    </div>
  </motion.div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// TaskRow — unchanged logic, same compact list row
// ═══════════════════════════════════════════════════════════════════════════════
const TaskRow = memo(function TaskRow({
  task, index, isOverdue, isDueToday, statusStyle, priorityStyle, stripeColor,
  getUserName, getClientName, getRelativeDueDate, getChecklistProgress,
  parseChecklist, taskChecklists, toggleChecklistItem,
  canModifyTask, canDeleteTasks,
  handleEdit, handleDelete, handleDuplicateTask, handleQuickStatusChange,
  handleQuickPriorityChange,
  openTaskDetail, openCommentTaskId, setOpenCommentTaskId,
  fetchComments, comments: taskComments, newComment, setNewComment,
  selectedTask, setSelectedTask, handleAddComment,
  user, isDark,
  handleNudgeTask, sendingNudge, selectMode, selected, onToggleSelect,
}) {
  const [expanded, setExpanded] = useState(false);
  const checklistItems = parseChecklist(task.description);
  const checkedItems   = taskChecklists[task.id] || [];
  const progress       = getChecklistProgress(task);
  const isCompleted    = task.status === 'completed';

  return (
    <motion.div variants={itemVariants} layout>
      <div className={`relative rounded-xl border transition-all duration-200 overflow-hidden group
        ${isCompleted
          ? (isDark ? 'bg-slate-800/60 border-slate-700 opacity-70' : 'bg-slate-50 border-slate-200 opacity-70')
          : (isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm')}`}>

        <div className={`absolute left-0 top-0 h-full w-1 ${stripeColor}`} />

        <div
          className="pl-5 pr-3 py-2.5 grid items-center gap-0"
          style={{ gridTemplateColumns: '24px 24px minmax(0,1fr) 160px 88px 76px 72px 110px 110px 88px 100px' }}
        >
          {selectMode ? (
            <button onClick={() => onToggleSelect(task.id)} className="flex items-center justify-center" title="Select task">
              {selected ? <CheckSquare className="h-4 w-4 text-rose-500" /> : <Square className="h-4 w-4 text-slate-300" />}
            </button>
          ) : (
            <span className="text-[11px] font-medium text-slate-400 select-none">
              {String(index + 1).padStart(2, '0')}
            </span>
          )}

          <button
            onClick={() => {
              const next = task.status === 'pending' ? 'in_progress'
                : task.status === 'in_progress' ? 'completed' : 'pending';
              handleQuickStatusChange(task, next);
            }}
            className="flex items-center justify-center"
            title="Cycle status"
          >
            <span className="w-4 h-4 rounded-full border-2 border-slate-300 flex items-center justify-center hover:border-blue-400 transition-colors">
              {task.status === 'completed'   && <Check className="h-2.5 w-2.5 text-blue-600" />}
              {task.status === 'in_progress' && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
            </span>
          </button>

          <button
            className={`min-w-0 text-left font-medium truncate transition-colors pl-1 pr-2 text-sm
              ${isCompleted
                ? 'text-slate-400 line-through'
                : (isDark ? 'text-slate-100 hover:text-blue-400' : 'text-slate-800 hover:text-blue-700')}`}
            onClick={() => openTaskDetail(task)}
          >
            {task.title}
          </button>

          <div className="flex items-center justify-center gap-1 overflow-hidden">
            {canModifyTask(task) ? (
              <>
                {[
                  { s: 'pending',     label: 'To Do', active: 'bg-red-500 text-white border-red-500',     idle: isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:border-red-400 hover:text-red-400'    : 'bg-white text-slate-400 border-slate-200 hover:border-red-300 hover:text-red-500' },
                  { s: 'in_progress', label: 'WIP',   active: 'bg-amber-500 text-white border-amber-500', idle: isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:border-amber-400 hover:text-amber-400' : 'bg-white text-slate-400 border-slate-200 hover:border-amber-300 hover:text-amber-500' },
                  { s: 'completed',   label: 'Done',  active: 'bg-blue-600 text-white border-blue-600',   idle: isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:border-blue-400 hover:text-blue-400'   : 'bg-white text-slate-400 border-slate-200 hover:border-blue-300 hover:text-blue-500' },
                ].map(({ s, label, active, idle }) => (
                  <button key={s} onClick={() => handleQuickStatusChange(task, s)}
                    className={`h-[20px] px-2 text-[9px] font-semibold tracking-wide rounded border transition-all whitespace-nowrap
                      ${task.status === s ? active : idle}`}>
                    {label}
                  </button>
                ))}
              </>
            ) : (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap ${statusStyle.bg} ${statusStyle.text}`}>
                {statusStyle.label}
              </span>
            )}
          </div>

          <div className="flex items-center justify-center overflow-hidden">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded truncate max-w-full">
              {task.category?.toUpperCase() || 'OTHER'}
            </span>
          </div>

          <div className="flex items-center justify-center overflow-hidden">
            {canModifyTask(task) && handleQuickPriorityChange ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`group/prio inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition-all hover:scale-105 active:scale-95 cursor-pointer ${priorityStyle.badge || `${priorityStyle.bg} ${priorityStyle.text} border`}`}
                    title="Click to assign or change priority"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityStyle.dot || 'bg-slate-400'}`} />
                    <span>{priorityStyle.label}</span>
                    <ChevronDown className="h-2.5 w-2.5 opacity-50 group-hover/prio:opacity-100 transition-opacity ml-0.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-36 p-1.5 rounded-xl shadow-lg border bg-white dark:bg-slate-800" align="center" side="bottom">
                  <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 text-slate-400">
                    Assign Priority
                  </div>
                  <div className="space-y-0.5">
                    {[
                      { value: 'high', label: 'High', style: PRIORITY_STYLES.high },
                      { value: 'medium', label: 'Medium', style: PRIORITY_STYLES.medium },
                      { value: 'low', label: 'Low', style: PRIORITY_STYLES.low },
                    ].map((p) => {
                      const isSelected = (task.priority || '').toLowerCase() === p.value;
                      return (
                        <button
                          key={p.value}
                          type="button"
                          onClick={() => handleQuickPriorityChange(task, p.value)}
                          className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            isSelected
                              ? `${p.style.bg} ${p.style.text} font-bold`
                              : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${p.style.dot}`} />
                            <span>{p.label}</span>
                          </div>
                          {isSelected && <Check className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${priorityStyle.badge || `${priorityStyle.bg} ${priorityStyle.text} border`}`}>
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityStyle.dot || 'bg-slate-400'}`} />
                <span>{priorityStyle.label}</span>
              </span>
            )}
          </div>

          <div className="flex items-center justify-center overflow-hidden">
            {isOverdue ? (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 whitespace-nowrap">OVERDUE</span>
            ) : isDueToday ? (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 whitespace-nowrap flex items-center gap-0.5">
                <Zap className="h-2.5 w-2.5 text-amber-600 fill-amber-600" /> DUE TODAY
              </span>
            ) : (
              <span className="text-slate-200 text-[10px]">—</span>
            )}
          </div>

          <div className="flex items-center justify-start gap-1 overflow-hidden px-1">
            <User className="h-3 w-3 flex-shrink-0 text-slate-400" />
            <span className="text-[10px] text-slate-600 truncate">{getUserName(task.assigned_to, task.assigned_to_name)}</span>
          </div>

          <div className="flex items-center justify-start gap-1 overflow-hidden px-1">
            <User className="h-3 w-3 flex-shrink-0 text-slate-300" />
            <span className="text-[10px] text-slate-400 truncate">
              {task.created_by ? getUserName(task.created_by, task.created_by_name) : '—'}
            </span>
          </div>

          <div className={`flex items-center justify-center overflow-hidden px-1 ${isOverdue ? 'text-red-600' : isDueToday ? 'text-amber-700 font-bold' : 'text-slate-500'}`}>
            {task.due_date ? (
              isOverdue ? (
                <div className="flex flex-col items-center leading-tight text-center">
                  <span className="text-[10px] font-bold whitespace-nowrap text-red-600">
                    {getRelativeDueDate(task.due_date)}
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wide text-red-500">OVERDUE</span>
                </div>
              ) : isDueToday ? (
                <div className="flex flex-col items-center leading-tight text-center bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded border border-amber-200">
                  <span className="text-[10px] font-bold whitespace-nowrap text-amber-800 dark:text-amber-300 flex items-center gap-1">
                    <Zap className="h-2.5 w-2.5 text-amber-500 fill-amber-500" /> Today
                  </span>
                  <span className="text-[8px] font-extrabold uppercase tracking-wide text-amber-600">DUE TODAY</span>
                </div>
              ) : (
                <div className="flex flex-col items-center leading-tight text-center">
                  <span className="text-[10px] font-bold whitespace-nowrap text-slate-600">{getRelativeDueDate(task.due_date)}</span>
                  <span className="text-[9px] font-medium text-slate-400">{format(new Date(task.due_date), 'MMM dd')}</span>
                </div>
              )
            ) : <span className="text-slate-300 text-[10px]">—</span>}
          </div>

          <div className="flex items-center justify-end gap-0 opacity-100 transition-opacity overflow-hidden">
            {canModifyTask(task) && (
              <button onClick={() => setExpanded(v => !v)}
                className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Expand">
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
            )}
            {canModifyTask(task) && (
              <button onClick={() => handleEdit(task)}
                className="p-1 rounded hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors" title="Edit">
                <Edit className="h-3.5 w-3.5" />
              </button>
            )}
            {canModifyTask(task) && (
              <button onClick={() => handleDuplicateTask(task)}
                className="p-1 rounded hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors" title="Duplicate">
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
            {canModifyTask(task) && (
              <button onClick={() => { setOpenCommentTaskId(openCommentTaskId === task.id ? null : task.id); fetchComments(task.id); }}
                className="p-1 rounded hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors" title="Comments">
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
            )}
            {canModifyTask(task) && (
              <button
                onClick={() => handleNudgeTask(task)}
                disabled={sendingNudge === task.id || !task.assigned_to}
                className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title={task.assigned_to ? `Send a popup reminder to ${getUserName(task.assigned_to, task.assigned_to_name)}` : 'No assignee to notify'}>
                {sendingNudge === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
              </button>
            )}
            {canDeleteTasks && (
              <button onClick={() => handleDelete(task.id)}
                className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors" title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <AnimatePresence>
          {(expanded || openCommentTaskId === task.id) && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className={`mx-5 mb-4 space-y-3 border-t pt-3 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                {checklistItems.length > 0 && (
                  <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-100">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-emerald-700 flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5" /> Compliance Checklist
                      </span>
                      <span className="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
                        {checkedItems.length}/{checklistItems.length}
                      </span>
                    </div>
                    <div className="h-1 bg-emerald-200 rounded-full mb-3 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                      {checklistItems.map((item, idx) => (
                        <label key={idx} className="flex items-start gap-2 cursor-pointer group/check">
                          <Checkbox checked={checkedItems.includes(idx)} onCheckedChange={() => toggleChecklistItem(task.id, idx)} className="mt-0.5 flex-shrink-0" />
                          <span className={`text-xs leading-relaxed ${checkedItems.includes(idx) ? 'line-through text-slate-400' : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>
                            {item}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {openCommentTaskId === task.id && (
                  <div className="space-y-2">
                    <div className="max-h-28 overflow-y-auto space-y-1">
                      {(taskComments || []).map((comment, i) => (
                        <div key={i} className={`text-xs rounded-lg px-3 py-2 border ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-100'}`}>
                          {comment.text}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a comment…" className="h-8 text-xs"
                        onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedTask(task); handleAddComment(); } }} />
                      <Button size="sm" className="h-8 px-3 text-xs" onClick={() => { setSelectedTask(task); handleAddComment(); }}>Post</Button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMIZABLE METRIC-CARD LAYOUT
// Users can hide/show and reorder the 6 summary cards; the choice is saved
// per-browser so it survives reloads.
// ═══════════════════════════════════════════════════════════════════════════════
const CARD_DEFS = [
  { key: 'myTask',     label: 'Assigned To Me' },
  { key: 'todo',       label: 'To Do' },
  { key: 'inProgress', label: 'In Progress' },
  { key: 'completed',  label: 'Completed' },
  { key: 'overdue',    label: 'Overdue' },
  { key: 'team',       label: 'Team Task' },
];
const CARD_LAYOUT_STORAGE_KEY = 'ts_task_cards_layout_v1';

const loadCardLayout = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(CARD_LAYOUT_STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) {
      // Merge in any new card keys that were added after the user last saved.
      const savedKeys = new Set(saved.map((c) => c.key));
      const missing = CARD_DEFS.filter((c) => !savedKeys.has(c.key)).map((c) => ({ key: c.key, visible: true }));
      return [...saved.filter((c) => CARD_DEFS.some((d) => d.key === c.key)), ...missing];
    }
  } catch { /* ignore corrupt data */ }
  return CARD_DEFS.map((c) => ({ key: c.key, visible: true }));
};

const saveCardLayout = (layout) => {
  try { localStorage.setItem(CARD_LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* quota */ }
};

// Small settings panel: reorder with ↑/↓, toggle visibility with the eye icon.
const CardLayoutSettings = memo(function CardLayoutSettings({ layout, setLayout, isDark }) {
  const move = (idx, dir) => {
    setLayout((prev) => {
      const next = [...prev];
      const swapWith = idx + dir;
      if (swapWith < 0 || swapWith >= next.length) return prev;
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      saveCardLayout(next);
      return next;
    });
  };
  const toggleVisible = (idx) => {
    setLayout((prev) => {
      const next = prev.map((c, i) => (i === idx ? { ...c, visible: !c.visible } : c));
      saveCardLayout(next);
      return next;
    });
  };
  const reset = () => {
    const fresh = CARD_DEFS.map((c) => ({ key: c.key, visible: true }));
    setLayout(fresh);
    saveCardLayout(fresh);
  };
  return (
    <div className="space-y-1.5">
      {layout.map((item, idx) => {
        const def = CARD_DEFS.find((c) => c.key === item.key);
        if (!def) return null;
        return (
          <div key={item.key}
            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border
              ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-sm font-medium ${item.visible ? '' : 'opacity-40'} ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {def.label}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0}
                className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-500" title="Move up">
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => move(idx, 1)} disabled={idx === layout.length - 1}
                className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-500" title="Move down">
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => toggleVisible(idx)}
                className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500" title={item.visible ? 'Hide card' : 'Show card'}>
                {item.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" onClick={reset}
        className="text-xs font-medium text-blue-600 hover:text-blue-700 pt-1">
        Reset to default
      </button>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// BoardCard — unchanged
// ═══════════════════════════════════════════════════════════════════════════════
const BoardCard = memo(function BoardCard({
  task, index, isOverdue, isDueToday, stripeColor, statusStyle, priorityStyle,
  getUserName, getClientName, getRelativeDueDate, getChecklistProgress,
  parseChecklist, taskChecklists, toggleChecklistItem,
  canModifyTask, canDeleteTasks,
  handleEdit, handleDelete, handleDuplicateTask, handleQuickStatusChange,
  handleQuickPriorityChange,
  openTaskDetail, openCommentTaskId, setOpenCommentTaskId,
  fetchComments, comments: taskComments, newComment, setNewComment,
  selectedTask, setSelectedTask, handleAddComment,
  isDark,
}) {
  const checklistItems = parseChecklist(task.description);
  const checkedItems   = taskChecklists[task.id] || [];
  const progress       = getChecklistProgress(task);
  const isCompleted    = task.status === 'completed';

  return (
    <motion.div variants={itemVariants} layout>
      <div className={`relative rounded-xl border overflow-hidden transition-all duration-200 group
        ${isCompleted
          ? (isDark ? 'bg-slate-800/60 border-slate-700 opacity-75' : 'bg-slate-50 border-slate-200 opacity-75')
          : (isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:shadow-md' : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-md')}`}>

        <div className={`h-1 w-full ${stripeColor}`} />

        <div className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <button
              onClick={() => openTaskDetail(task)}
              className={`font-semibold text-sm leading-snug text-left flex-1 transition-colors
                ${isCompleted ? 'text-slate-400 line-through' : (isDark ? 'text-slate-100 hover:text-blue-400' : 'text-slate-800 hover:text-blue-700')}`}>
              {task.title}
            </button>
            {canModifyTask(task) && (
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button onClick={() => handleEdit(task)} className="p-1 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors">
                  <Edit className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => handleDuplicateTask(task)} className="p-1 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors">
                  <Copy className="h-3.5 w-3.5" />
                </button>
                {canDeleteTasks && (
                  <button onClick={() => handleDelete(task.id)} className="p-1 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {canModifyTask(task) && handleQuickPriorityChange ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md border transition-all hover:scale-105 active:scale-95 cursor-pointer ${priorityStyle.badge || `${priorityStyle.bg} ${priorityStyle.text} border`}`}
                    title="Click to assign or change priority"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityStyle.dot || 'bg-slate-400'}`} />
                    <span>{priorityStyle.label}</span>
                    <ChevronDown className="h-2.5 w-2.5 opacity-60 ml-0.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-36 p-1.5 rounded-xl shadow-lg border bg-white dark:bg-slate-800" align="start">
                  <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 text-slate-400">
                    Assign Priority
                  </div>
                  <div className="space-y-0.5">
                    {[
                      { value: 'high', label: 'High', style: PRIORITY_STYLES.high },
                      { value: 'medium', label: 'Medium', style: PRIORITY_STYLES.medium },
                      { value: 'low', label: 'Low', style: PRIORITY_STYLES.low },
                    ].map((p) => {
                      const isSelected = (task.priority || '').toLowerCase() === p.value;
                      return (
                        <button
                          key={p.value}
                          type="button"
                          onClick={() => handleQuickPriorityChange(task, p.value)}
                          className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            isSelected
                              ? `${p.style.bg} ${p.style.text} font-bold`
                              : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${p.style.dot}`} />
                            <span>{p.label}</span>
                          </div>
                          {isSelected && <Check className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md border ${priorityStyle.badge || `${priorityStyle.bg} ${priorityStyle.text} border`}`}>
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityStyle.dot || 'bg-slate-400'}`} />
                <span>{priorityStyle.label}</span>
              </span>
            )}
            {isOverdue && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-red-100 text-red-700 border border-red-200 flex items-center gap-1"><AlertCircle className="h-3 w-3 text-red-600" /> Overdue</span>}
            {isDueToday && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1"><Zap className="h-3 w-3 text-amber-600 fill-amber-600" /> Due Today</span>}
            {task.is_recurring && <span className="text-[10px] font-semibold bg-purple-50 text-purple-700 px-2 py-0.5 rounded-md">↺ Recurring</span>}
            {task.category && <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">{task.category}</span>}
          </div>

          {checklistItems.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-emerald-700">CHECKLIST</span>
                <span className="text-[10px] font-bold text-emerald-600">{checkedItems.length}/{checklistItems.length}</span>
              </div>
              <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          <div className={`pt-2 border-t space-y-1.5 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <User className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate max-w-[120px]">{getUserName(task.assigned_to, task.assigned_to_name)}</span>
              </div>
              {task.due_date && (
                <span className={`text-xs font-bold flex items-center gap-1 px-1.5 py-0.5 rounded ${
                  isOverdue ? 'text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200' : isDueToday ? 'text-amber-800 bg-amber-100 dark:bg-amber-900/40 border border-amber-300' : 'text-slate-500'
                }`}>
                  <Clock className="h-3.5 w-3.5" />
                  {getRelativeDueDate(task.due_date)}
                </span>
              )}
            </div>
          </div>

          {canModifyTask(task) && (
            <div className="grid grid-cols-3 gap-1 pt-1">
              {[
                { s: 'pending',     label: 'To Do', active: 'bg-red-500 text-white border-red-500' },
                { s: 'in_progress', label: 'WIP',   active: 'bg-amber-500 text-white border-amber-500' },
                { s: 'completed',   label: 'Done',  active: 'bg-blue-600 text-white border-blue-600' },
              ].map(({ s, label, active }) => (
                <button key={s} onClick={() => handleQuickStatusChange(task, s)}
                  className={`h-6 text-[10px] font-semibold rounded-lg border transition-all
                    ${task.status === s ? active : (isDark ? 'bg-slate-700 border-slate-600 text-slate-400' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300')}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {canModifyTask(task) && (
            <button
              onClick={() => { setOpenCommentTaskId(openCommentTaskId === task.id ? null : task.id); fetchComments(task.id); }}
              className={`w-full flex items-center justify-center gap-1.5 text-[10px] font-medium text-slate-400 hover:text-indigo-600 py-1 rounded-lg transition-colors border border-dashed
                ${isDark ? 'border-slate-600 hover:bg-indigo-900/30' : 'border-slate-200 hover:bg-indigo-50'}`}>
              <MessageSquare className="h-3 w-3" />
              {openCommentTaskId === task.id ? 'Close Comments' : 'Add Comment'}
            </button>
          )}

          {openCommentTaskId === task.id && (
            <div className="space-y-2">
              <div className="max-h-24 overflow-y-auto space-y-1">
                {(taskComments || []).map((c, i) => (
                  <div key={i} className={`text-[10px] rounded-lg px-2 py-1.5 border ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-100'}`}>
                    {c.text}
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5">
                <Input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Comment…" className="h-7 text-xs"
                  onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedTask(task); handleAddComment(); } }} />
                <Button size="sm" className="h-7 px-2 text-xs" onClick={() => { setSelectedTask(task); handleAddComment(); }}>Post</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Main Tasks Component
// ═══════════════════════════════════════════════════════════════════════════════
export default function Tasks() {

  // ── Auth from AuthContext (single source of truth) ───────────────────
  const { user: authUser, hasPermission, canAccessUser } = useAuth();
  const user = authUser || { id: '', full_name: 'User', role: 'staff', permissions: { view_other_tasks: [], can_view_all_tasks: false } };
  const [searchParams, setSearchParams] = useSearchParams();

  const apiFetch = React.useCallback(async (endpoint) => {
    try {
      const res = await api.get(endpoint);
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err.message;
      if (status === 403 && typeof detail === 'string' && (detail.includes('does not include') || detail.includes('license') || detail.includes('feature'))) {
        return null;
      }
      console.error(`apiFetch ${endpoint} failed:`, status, detail);
      return null;
    }
  }, []);

  const isAdmin = user?.role === 'admin';
  const isDark  = useDark();

  // GLITCH FIX: this used to be the only ownership check, but it missed the
  // cross-visibility case — a user granted cross-visibility to another user
  // (view_other_tasks) can now also edit that user's tasks per the backend
  // fix, so the row-level Edit button must show for those tasks too.
  const canModifyTask = React.useCallback((task) => {
    if (isAdmin) return true;
    if (task.assigned_to === user?.id || task.sub_assignees?.includes(user?.id) || task.created_by === user?.id) {
      return true;
    }
    return canAccessUser('view_other_tasks', task.assigned_to) || canAccessUser('view_other_tasks', task.created_by);
  }, [isAdmin, user, canAccessUser]);
  // GLITCH FIX: cross-visibility to at least one user should also unlock the
  // Assignee/Co-assignee picker, not just the admin-granted can_assign_tasks flag.
  const crossVisibleTaskUsers = (user?.permissions?.view_other_tasks) || [];
  const canAssignTasks = hasPermission('can_assign_tasks') || crossVisibleTaskUsers.length > 0;
  const canEditTasks   = hasPermission('can_edit_tasks');
  const canDeleteTasks = isAdmin || hasPermission('can_delete_tasks');

  // ── Core state ────────────────────────────────────────────────────────────
  const [tasks,          setTasks]          = useState([]);
  const [users,          setUsers]          = useState([]);
  const [clients,        setClients]        = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [sendingReminders, setSendingReminders] = useState(false);
  const [reminderResult,   setReminderResult]   = useState(null); // { emails_sent, emails_failed, total_users }
  const [dataLoading,    setDataLoading]    = useState(true);
  const [usersLoading,   setUsersLoading]   = useState(true);
  const [filterTeamOnly,      setFilterTeamOnly]      = useState(false);
  const [filterAssignedByMe,  setFilterAssignedByMe]  = useState(false);
  const [filterCreatedBy,     setFilterCreatedBy]     = useState('all');
  const [filterTodayNew,      setFilterTodayNew]      = useState(false);
  const [filterPending,       setFilterPending]       = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [clientPopoverOpen,   setClientPopoverOpen]   = useState(false);
  const [duplicateGroups,     setDuplicateGroups]     = useState([]);
  const [detectingDuplicates, setDetectingDuplicates] = useState(false);
  const [aiProvider, setAiProvider] = useState('auto'); // 'auto' | 'gemini' | 'grok' | 'local'
  const [scanProgress, setScanProgress] = useState(0);   // 0–100 progress while detecting duplicates
  const [scanStatus,   setScanStatus]   = useState('');  // human-readable status (e.g. 'Asking Gemini…')
  const scanAbortRef = useRef(null); // AbortController for in-flight duplicate-detection requests
  const [scanHistory, setScanHistory] = useState([]); // last few finished scans: { id, provider, label, groupCount, taskCount, scannedCount, durationMs, at }
  const [compareTaskIds,      setCompareTaskIds]       = useState([]);
  const [compareMode,         setCompareMode]          = useState(false);

  const [dialogOpen,         setDialogOpen]         = useState(false);
  const [editingTask,        setEditingTask]         = useState(null);
  const [formData,           setFormData]           = useState({ ...EMPTY_FORM });

  // ── Minimize/restore: lets this Create/Edit Task form be shrunk to the
  // global dock, navigated away from, and resumed later exactly as left.
  // Key is per-record so several task edits can be minimized at once.
  const taskFormKey = editingTask ? `create-task-${editingTask.id}` : 'create-task-new';
  const { minimize: minimizeTaskForm } = useFormMinimizer({
    formKey: taskFormKey,
    title: formData.title ? `Task: ${formData.title}` : (editingTask ? 'Edit Task' : 'New Task'),
    subtitle: editingTask ? 'Editing' : 'Creating',
    path: '/tasks',
    icon: 'ClipboardList',
    data: { formData, editingTaskId: editingTask?.id || null },
    onRestore: (data) => {
      setFormData(data.formData || { ...EMPTY_FORM });
      if (data.editingTaskId) {
        const found = tasks.find((t) => t.id === data.editingTaskId);
        if (found) setEditingTask(found);
      } else {
        setEditingTask(null);
      }
      setDialogOpen(true);
    },
  });
  const [viewMode,           setViewMode]           = useState('list');
  const [taskDetailOpen,     setTaskDetailOpen]     = useState(false);
  const [selectedDetailTask, setSelectedDetailTask] = useState(null);
  const [deleteDialogOpen,   setDeleteDialogOpen]   = useState(false);
  const [taskToDelete,       setTaskToDelete]       = useState(null);
  const [isDeletingTask,     setIsDeletingTask]     = useState(false);
  const [comments,           setComments]           = useState({});
  const [showCommentsDialog, setShowCommentsDialog] = useState(false);
  const [selectedTask,       setSelectedTask]       = useState(null);
  const [newComment,         setNewComment]         = useState('');
  const [openCommentTaskId,  setOpenCommentTaskId]  = useState(null);
  const [notifications,      setNotifications]      = useState([]);
  const [showNotifications,  setShowNotifications]  = useState(false);

  // ── Bulk "raise a popup" selection (Actions column + bulk bar) ──────────
  const [selectMode,     setSelectMode]     = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  const [sendingNudge,   setSendingNudge]   = useState(false);
  const [bulkNudging,    setBulkNudging]    = useState(false);
  const [bulkUpdatingPriority, setBulkUpdatingPriority] = useState(false);

  const [searchQuery,             setSearchQuery]             = useState('');
  const [filterStatus,            setFilterStatus]            = useState('all');
  const [filterPriority,          setFilterPriority]          = useState('all');
  const [filterCategory,          setFilterCategory]          = useState([]);   // multi-select array
  const [filterAssignee,          setFilterAssignee]          = useState([]);   // multi-select array
  const [sortBy,                  setSortBy]                  = useState('due_date');
  const [sortDirection,           setSortDirection]           = useState('asc');
  const [showMyTasksOnly,         setShowMyTasksOnly]         = useState(false);

  // FIX: keep filter dropdown hooks at component level.
  // The previous version created hooks inside render-time IIFEs, which can
  // change React's hook order when the Tasks page/dialog rerenders and cause
  // Minified React error #310. The original UI/behavior is retained.
  const [departmentFilterOpen, setDepartmentFilterOpen] = useState(false);
  const [assigneeFilterOpen, setAssigneeFilterOpen] = useState(false);
  const departmentFilterRef = useRef(null);
  const assigneeFilterRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (departmentFilterRef.current && !departmentFilterRef.current.contains(e.target)) {
        setDepartmentFilterOpen(false);
      }
      if (assigneeFilterRef.current && !assigneeFilterRef.current.contains(e.target)) {
        setAssigneeFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const [taskChecklists,          setTaskChecklists]          = useState({});
  const [showWorkflowLibrary,     setShowWorkflowLibrary]     = useState(false);
  const [workflowSearch,          setWorkflowSearch]          = useState('');
  const [workflowDeptFilter,      setWorkflowDeptFilter]      = useState('all');
  const [workflowFrequencyFilter, setWorkflowFrequencyFilter] = useState('all');

  const fileInputRef = useRef(null);
  const [csvAiFile, setCsvAiFile] = useState(null);

  // ── Ranking state ──────────────────────────────────────────────────────────
  const [myRanking, setMyRanking] = useState(null);
  const [rankingsLoaded, setRankingsLoaded] = useState(false);
  const [showTips, setShowTips] = useState(false);
  const [focusedMetric, setFocusedMetric] = useState(null); // which Score Breakdown row was clicked, for highlight/scroll in the Tips modal

  // When a Score Breakdown row is clicked, the Tips modal opens already
  // scrolled to (and highlighted on) that specific metric's detail card.
  useEffect(() => {
    if (!showTips || !focusedMetric) return;
    const t = setTimeout(() => {
      document.getElementById(`score-metric-${focusedMetric}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120); // small delay so the modal's mount/entry animation has started
    return () => clearTimeout(t);
  }, [showTips, focusedMetric]);


  const hasCrossVisibility = React.useMemo(() => {
    if (isAdmin) return true;
    // Cross-visibility is purely explicit (admin-curated view_other_tasks list).
    // No automatic dept-team for any role — TEAM = CROSS VISIBILITY ON USER.
    const perms = user?.permissions || {};
    return (perms.view_other_tasks && perms.view_other_tasks.length > 0) || perms.can_view_all_tasks === true;
  }, [isAdmin, user]);

  const crossVisibilityUserIds = React.useMemo(() => {
    if (isAdmin) {
      return [...new Set(tasks.map(t => t.assigned_to).filter(id => id && id !== user?.id))];
    }
    const perms = user?.permissions || {};
    const explicitList = (perms.view_other_tasks || []).filter(id => id !== user?.id);
    // Fallback: if /users returned other users (backend already filtered by cross-vis),
    // use those IDs so dropdowns and name lookups always work.
    if (explicitList.length > 0) return explicitList;
    return users.filter(u => u.id !== user?.id).map(u => u.id);
  }, [isAdmin, user, users, tasks]);

  const visibleUsers = React.useMemo(() => {
    if (isAdmin) return users;
    if (hasCrossVisibility) {
      const ids = new Set([user?.id, ...crossVisibilityUserIds]);
      return users.filter(u => ids.has(u.id));
    }
    return users.filter(u => u.id === user?.id);
  }, [isAdmin, hasCrossVisibility, crossVisibilityUserIds, users, user]);

  // Users who have created tasks that the current user can see — respects permission scope
  const visibleCreators = React.useMemo(() => {
    if (isAdmin) return users; // admin sees everyone
    // For non-admin: only show creators whose tasks are in scopedTasks
    const creatorIds = new Set(
      tasks
        .filter(t => {
          // same scope check as scopedTasks
          const visibleIds = new Set([user?.id, ...crossVisibilityUserIds]);
          return visibleIds.has(t.assigned_to) || t.sub_assignees?.some(id => visibleIds.has(id)) || t.created_by === user?.id;
        })
        .map(t => t.created_by)
        .filter(Boolean)
    );
    return users.filter(u => creatorIds.has(u.id));
  }, [isAdmin, users, tasks, user, crossVisibilityUserIds]);

  useEffect(() => {
    // Fetch every page of clients until exhausted — identical to Clients.jsx strategy
    const fetchAllClients = async () => {
      const PAGE = 200;
      let page = 1;
      let all = [];
      try {
        while (true) {
          const res = await api.get('/clients', { params: { page, page_size: PAGE } });
          const batch = Array.isArray(res.data) ? res.data : [];
          all = [...all, ...batch];
          if (batch.length < PAGE) break;
          page++;
        }
      } catch (err) {
        // Gracefully return whatever was retrieved or empty array if clients/records is forbidden
        return all;
      }
      return all;
    };

    // Always hits the network, updates state + cache. Used both for the
    // initial (no-cache) load and for the one-shot background refresh.
    const fetchFresh = async (showLoadingState) => {
      if (showLoadingState) setDataLoading(true);
      // ── All 4 API calls fire simultaneously — no sequential waterfalls ──
      // NOTE: /tasks is capped to the 500 most-recently-created tasks (server sorts
      // by created_at desc) instead of fetching the entire unbounded collection.
      // This is a stop-gap for load time — a full server-side-paginated Tasks UI
      // (search/filter hitting the server instead of the in-memory array) is a
      // larger follow-up change, not done here.
      const [tasksResult, usersResult, clientsResult, rankResult] = await Promise.allSettled([
        apiFetch('/tasks?page=1&page_size=500'),
        apiFetch('/users'),
        fetchAllClients(),
        apiFetch('/reports/performance-rankings?period=monthly'),
      ]);

      // tasks
      if (tasksResult.status === 'fulfilled') {
        const tasksData = tasksResult.value;
        const tasksArray = Array.isArray(tasksData) ? tasksData : (tasksData?.tasks || null);
        if (Array.isArray(tasksArray)) {
          setTasks(tasksArray);
          if (tasksData?.total > tasksArray.length) {
            toast.info(`Showing the ${tasksArray.length} most recent tasks (of ${tasksData.total} total). Use filters/search to narrow results.`, { duration: 5000 });
          }
        } else if (tasksData === null) toast.error("You don't have permission to view tasks.");
      } else {
        if (tasksResult.reason?.response?.status === 403)
          toast.error("You don't have permission to view tasks.");
        else console.error('Tasks fetch error:', tasksResult.reason);
      }
      setDataLoading(false);

      // users
      if (usersResult.status === 'fulfilled' && Array.isArray(usersResult.value)) {
        setUsers(usersResult.value);
      }
      setUsersLoading(false);

      // clients — fetchAllClients always returns an array
      if (clientsResult.status === 'fulfilled' && Array.isArray(clientsResult.value)) {
        setClients(clientsResult.value);
      }

      // rankings
      if (rankResult.status === 'fulfilled') {
        const rankData = rankResult.value;
        if (Array.isArray(rankData) && rankData.length > 0) {
          const mine = rankData.find(r => r.user_id === user?.id) || rankData[0];
          const ranking = { ...mine, totalUsers: rankData.length, rankings: rankData };
          setMyRanking(ranking);
          setRankingsLoaded(true);
          // Cache everything for fast revisit
          const tasksArrayForCache = tasksResult.status === 'fulfilled'
            ? (Array.isArray(tasksResult.value) ? tasksResult.value : (tasksResult.value?.tasks || []))
            : [];
          setTasksCache({
            tasks: tasksArrayForCache,
            users: usersResult.status === 'fulfilled' && Array.isArray(usersResult.value) ? usersResult.value : [],
            clients: clientsResult.status === 'fulfilled' && Array.isArray(clientsResult.value) ? clientsResult.value : [],
            ranking,
            rankings: rankData,
          });
        }
      } else {
        console.error('Tasks ranking fetch error:', rankResult.reason);
      }
    };

    const loadAll = async () => {
      // Serve from cache first (instant revisit) then background-refresh once
      const cached = getTasksCache();
      if (cached) {
        if (Array.isArray(cached.tasks)) setTasks(cached.tasks);
        if (Array.isArray(cached.users)) { setUsers(cached.users); setUsersLoading(false); }
        if (Array.isArray(cached.clients)) setClients(cached.clients);
        // Dashboard's prefetcher stores the raw `rankings` array; this page's
        // own writes store the already-resolved `ranking` object. Accept both.
        const cachedRanking = cached.ranking || (Array.isArray(cached.rankings) && cached.rankings.length
          ? (() => {
              const mine = cached.rankings.find(r => r.user_id === user?.id) || cached.rankings[0];
              return { ...mine, totalUsers: cached.rankings.length, rankings: cached.rankings };
            })()
          : null);
        if (cachedRanking) { setMyRanking(cachedRanking); setRankingsLoaded(true); }
        setDataLoading(false);
        // Silently background-refresh from the network exactly once so data
        // stays fresh (previously this called loadAll() again, which kept
        // re-reading the still-valid cache and rescheduling itself every
        // 150ms for the whole cache TTL — causing the page/dialog to appear
        // to reload repeatedly). The timer is cancelled on unmount below so
        // navigating away (e.g. back to Dashboard) doesn't leave an orphaned
        // fetch that fires after we've already left the Tasks page.
        bgRefreshTimeoutId = setTimeout(() => {
          if (isMounted) fetchFresh(false);
        }, 150);
        return;
      }
      await fetchFresh(true);
    };

    let isMounted = true;
    let bgRefreshTimeoutId = null;
    loadAll();
    return () => {
      isMounted = false;
      if (bgRefreshTimeoutId) clearTimeout(bgRefreshTimeoutId);
    };
  }, [apiFetch]);

  // ── Auto-open task detail / edit from URL param (?taskId=X&edit=1) ─────────────────
  useEffect(() => {
    const taskId = searchParams.get('taskId');
    if (!taskId || tasks.length === 0) return;
    const found = tasks.find(t => String(t.id) === String(taskId));
    if (!found) return;
    const shouldEdit = searchParams.get('edit') === '1';
    setSearchParams({}, { replace: true });
    if (shouldEdit) {
      handleEdit(found);
    } else {
      setSelectedDetailTask(found);
      setTaskDetailOpen(true);
    }
  }, [searchParams, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-open new task dialog from URL param (?newTask=1) ─────────────
  // Open before clearing the parameter so Dashboard -> Tasks always lands
  // directly in the create form instead of briefly showing the task list.
  useEffect(() => {
    if (searchParams.get('newTask') === '1') {
      setEditingTask(null);
      setFormData({ ...EMPTY_FORM });
      setDialogOpen(true);
      setSearchParams((current) => {
        current.delete('newTask');
        return current;
      }, { replace: true });
      return;
    }
    const filter = searchParams.get('filter');
    if (!filter) return;
    // Reset all filters first so dashboard clicks always start clean
    setFilterTodayNew(false);
    setFilterTeamOnly(false);
    setFilterAssignedByMe(false);
    setShowMyTasksOnly(false);
    setFilterStatus('all');

    if (filter === 'today_new') {
      setFilterTodayNew(true);
    } else if (filter === 'overdue') {
      setFilterStatus('overdue');
      setShowMyTasksOnly(true);
    } else if (filter === 'assigned-to-me' || filter === 'my-tasks') {
      setShowMyTasksOnly(true);
    } else if (filter === 'assigned-by-me') {
      setFilterAssignedByMe(true);
    } else if (filter === 'team') {
      setFilterTeamOnly(true);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  // O(1) lookup maps — built once when users/clients array changes
  const userMap   = useMemo(() => new Map(users.map(u => [u.id, u])),     [users]);
  const clientMap = useMemo(() => new Map(clients.map(c => [c.id, c])),   [clients]);

  const parseChecklist = useCallback((description) => {
    if (!description) return [];
    return description.split('\n').map(l => l.trim()).filter(l => l.startsWith('-') || l.startsWith('•')).map(l => l.replace(/^[-•]\s*/, '').trim());
  }, []);
  const toggleChecklistItem = useCallback((taskId, index) => {
    setTaskChecklists(prev => {
      const current = prev[taskId] || [];
      const next = current.includes(index) ? current.filter(i => i !== index) : [...current, index];
      return { ...prev, [taskId]: next };
    });
  }, []);
  const getChecklistProgress = useCallback((task) => {
    const items = task.description
      ? task.description.split('\n').map(l => l.trim()).filter(l => l.startsWith('-') || l.startsWith('•'))
      : [];
    if (!items.length) return 0;
    return Math.round(((taskChecklists[task.id] || []).length / items.length) * 100);
  }, [taskChecklists]);
  const getUserName      = useCallback((id, fallbackName) => userMap.get(id)?.full_name || fallbackName || 'Unassigned', [userMap]);
  const getClientName    = useCallback((id) => clientMap.get(id)?.company_name || 'No Client', [clientMap]);
  const getCategoryLabel = useCallback((v)  => TASK_CATEGORIES.find(c => c.value === v)?.label || v || 'Other', []);
  const isOverdue = useCallback((task) => {
    if (!task || task.status === 'completed' || !task.due_date) return false;
    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      const dueObj = typeof task.due_date === 'string' ? new Date(task.due_date) : task.due_date;
      if (!dueObj || isNaN(dueObj.getTime())) return false;
      const dueStr = format(dueObj, 'yyyy-MM-dd');
      return dueStr < todayStr;
    } catch {
      return false;
    }
  }, []);

  const isDueToday = useCallback((task) => {
    if (!task || task.status === 'completed' || !task.due_date) return false;
    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      const dueObj = typeof task.due_date === 'string' ? new Date(task.due_date) : task.due_date;
      if (!dueObj || isNaN(dueObj.getTime())) return false;
      const dueStr = format(dueObj, 'yyyy-MM-dd');
      return dueStr === todayStr;
    } catch {
      return false;
    }
  }, []);

  const getDisplayStatus = useCallback((task) => {
    if (isOverdue(task)) return 'overdue';
    if (isDueToday(task)) return 'due_today';
    return task.status || 'pending';
  }, [isOverdue, isDueToday]);

  const getRelativeDueDate = useCallback((dueDate) => {
    if (!dueDate) return '';
    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      const dueObj = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
      if (!dueObj || isNaN(dueObj.getTime())) return '';
      const dueStr = format(dueObj, 'yyyy-MM-dd');

      if (dueStr < todayStr) {
        const diffMs = new Date(todayStr).getTime() - new Date(dueStr).getTime();
        const diffDays = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
        return `${diffDays}d overdue`;
      }
      if (dueStr === todayStr) return 'Due Today';

      const diffMs = new Date(dueStr).getTime() - new Date(todayStr).getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 1) return 'Due Tomorrow';
      if (diffDays <= 7) return `In ${diffDays}d`;
      return format(dueObj, 'MMM dd');
    } catch {
      return '';
    }
  }, []);
  const openTaskDetail = useCallback((task) => { setSelectedDetailTask(task); setTaskDetailOpen(true); }, []);
  const resetForm = useCallback(() => { setFormData({ ...EMPTY_FORM }); setEditingTask(null); }, []);
  const toggleSubAssignee = useCallback((userId) => {
    setFormData(prev => ({ ...prev, sub_assignees: prev.sub_assignees.includes(userId) ? prev.sub_assignees.filter(id => id !== userId) : [...prev.sub_assignees, userId] }));
  }, []);
  const markAllAsRead = useCallback(() => { setNotifications(p => p.map(n => ({ ...n, is_read: true }))); toast.success('Marked all as read'); }, []);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    const taskData = {
      ...formData,
      assigned_to: formData.assigned_to === 'unassigned' ? null : formData.assigned_to,
      sub_assignees: formData.sub_assignees || [],
      client_id: formData.client_id || null,
      due_date: formData.due_date || null,
      popup_interval_minutes:
        formData.popup_interval_minutes === '' || formData.popup_interval_minutes == null
          ? null
          : Number(formData.popup_interval_minutes),
    };
    try {
      if (editingTask) {
        const res = await fetch(`${API_BASE}/tasks/${editingTask.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify(taskData) });
        if (res.ok) { const updated = await res.json(); setTasks(prev => prev.map(t => t.id === editingTask.id ? updated : t)); toast.success('Task updated!'); }
        else toast.error('Failed to update task');
      } else {
        const res = await fetch(`${API_BASE}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify(taskData) });
        if (res.ok) { const created = await res.json(); setTasks(prev => [created, ...prev]); toast.success('Task created!'); }
        else toast.error('Failed to create task');
      }
    } catch { toast.error('Network error'); }
    setDialogOpen(false); resetForm(); setLoading(false);
  };

  const handleEdit = React.useCallback((task) => {
    setEditingTask(task);
    setFormData({ title: task.title, description: task.description || '', assigned_to: task.assigned_to || 'unassigned', sub_assignees: task.sub_assignees || [], due_date: task.due_date ? format(new Date(task.due_date), 'yyyy-MM-dd') : '', priority: task.priority, status: task.status, category: task.category || 'other', categories: task.categories && task.categories.length > 0 ? task.categories : (task.category && task.category !== 'other' ? [task.category] : []), client_id: task.client_id || '', is_recurring: task.is_recurring || false, recurrence_pattern: task.recurrence_pattern || 'monthly', recurrence_interval: task.recurrence_interval || 1, popup_interval_minutes: task.popup_interval_minutes != null ? String(task.popup_interval_minutes) : '' });
    setDialogOpen(true);
  }, []);

  const handleAddToReminder = async (task) => {
    try {
      await api.post('/email/save-as-reminder', {
        title: `Task: ${task.title}`,
        description: task.description || '',
        remind_at: task.due_date ? new Date(task.due_date).toISOString() : new Date(Date.now() + 86400000).toISOString(),
      });
      toast.success('Added to Reminders!');
    } catch { toast.error('Failed to add reminder'); }
  };

  const handleDelete = React.useCallback((taskOrId) => {
    let taskObj = null;
    if (typeof taskOrId === 'object' && taskOrId !== null) {
      taskObj = taskOrId;
    } else {
      taskObj = tasks.find(t => String(t.id) === String(taskOrId)) || { id: taskOrId, title: 'this task' };
    }
    setTaskToDelete(taskObj);
    setDeleteDialogOpen(true);
  }, [tasks]);

  const handleConfirmDelete = async () => {
    if (!taskToDelete?.id) return;
    setIsDeletingTask(true);
    try {
      const res = await fetch(`${API_BASE}/tasks/${taskToDelete.id}`, {
        method: 'DELETE',
        headers: { ...getAuthHeader() },
      });
      if (res.ok) {
        setTasks(prev => prev.filter(t => t.id !== taskToDelete.id));
        toast.success('Task deleted successfully');
        setDeleteDialogOpen(false);
        setTaskToDelete(null);
        if (taskDetailOpen && selectedDetailTask?.id === taskToDelete.id) {
          setTaskDetailOpen(false);
          setSelectedDetailTask(null);
        }
      } else {
        toast.error('Failed to delete task');
      }
    } catch {
      toast.error('Network error while deleting task');
    } finally {
      setIsDeletingTask(false);
    }
  };

  const handleQuickStatusChange = React.useCallback(async (task, newStatus) => {
    const previousStatus = task.status;
    // Optimistic update — rolled back below if the server rejects it.
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: newStatus } : t));
    try {
      const res = await fetch(`${API_BASE}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify({ status: newStatus }) });
      if (!res.ok) {
        // Server rejected the update (e.g. 403 permission denied, 404, 500).
        // Roll back the optimistic change so the UI doesn't lie about what was saved.
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: previousStatus } : t));
        let detail = '';
        try { detail = (await res.json())?.detail || ''; } catch {}
        toast.error(detail || `Failed to update status (${res.status})`);
        return;
      }
      toast.success(`Marked as ${STATUS_STYLES[newStatus]?.label || newStatus}`);
    } catch {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: previousStatus } : t));
      toast.error('Network error');
    }
  }, []);

  const handleQuickPriorityChange = React.useCallback(async (task, newPriority) => {
    const previousPriority = task.priority || 'medium';
    if (String(previousPriority).toLowerCase() === String(newPriority).toLowerCase()) return;
    const normalized = String(newPriority).toLowerCase();

    // Optimistic update — rolled back below if the server rejects it.
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, priority: normalized } : t));
    setSelectedDetailTask(prev => (prev && prev.id === task.id ? { ...prev, priority: normalized } : prev));

    try {
      const res = await fetch(`${API_BASE}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ priority: normalized })
      });
      if (!res.ok) {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, priority: previousPriority } : t));
        setSelectedDetailTask(prev => (prev && prev.id === task.id ? { ...prev, priority: previousPriority } : prev));
        let detail = '';
        try { detail = (await res.json())?.detail || ''; } catch {}
        toast.error(detail || `Failed to update priority (${res.status})`);
        return;
      }
      const label = PRIORITY_STYLES[normalized]?.label || newPriority;
      toast.success(`Priority set to ${label}`);
    } catch {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, priority: previousPriority } : t));
      setSelectedDetailTask(prev => (prev && prev.id === task.id ? { ...prev, priority: previousPriority } : prev));
      toast.error('Network error');
    }
  }, []);

  const handleAddComment = React.useCallback(async () => {
    if (!newComment.trim()) return;
    const taskId = selectedTask?.id; if (!taskId) return;
    try {
      const res = await fetch(`${API_BASE}/tasks/${taskId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify({ text: newComment }) });
      if (res.ok) { const comment = await res.json(); setComments(prev => ({ ...prev, [taskId]: [...(prev[taskId] || []), comment] })); setNewComment(''); toast.success('Comment added!'); }
    } catch { toast.error('Network error'); }
  }, [newComment, selectedTask]);

  const fetchComments = React.useCallback(async (taskId) => {
    const data = await apiFetch(`/tasks/${taskId}/comments`);
    setComments(prev => ({ ...prev, [taskId]: Array.isArray(data) ? data : (prev[taskId] || []) }));
  }, [apiFetch]);

  const handleDuplicateTask = React.useCallback(async (task) => {
    const { id, created_at, updated_at, ...rest } = task;
    try {
      const res = await fetch(`${API_BASE}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify({ ...rest, title: `${task.title} (Copy)`, status: 'pending' }) });
      if (res.ok) { const created = await res.json(); setTasks(prev => [created, ...prev]); toast.success('Task duplicated!'); }
    } catch { toast.error('Network error'); }
  }, []);

  // ── Raise a popup: fires an immediate on-screen popup (and, on the
  // recipient's side, a desktop Notification() — see ReminderPopupManager)
  // for a task's assignee. Backed by POST /notifications/send with
  // popup:true, which /reminders/due-popups then folds into its poll. ──
  const buildNudgePayload = React.useCallback((task) => ({
    user_id: task.assigned_to,
    title: `Reminder: ${task.title}`,
    message: `${user?.full_name || user?.name || 'A colleague'} sent you a popup reminder for "${task.title}"${task.due_date ? ` (due ${format(new Date(task.due_date), 'MMM dd')})` : ''}.`,
    type: 'task_popup',
    popup: true,
    task_id: task.id,
  }), [user]);

  const handleNudgeTask = React.useCallback(async (task) => {
    if (!task.assigned_to) { toast.error('This task has no assignee to notify'); return; }
    setSendingNudge(task.id);
    try {
      await api.post('/notifications/send', buildNudgePayload(task));
      toast.success(`Popup sent to ${getUserName(task.assigned_to, task.assigned_to_name)}`);
    } catch {
      toast.error('Failed to send popup');
    } finally {
      setSendingNudge(false);
    }
  }, [buildNudgePayload, getUserName]);

  const toggleSelectMode = React.useCallback(() => {
    setSelectMode((v) => !v);
    setSelectedTaskIds(new Set());
  }, []);

  const toggleTaskSelected = React.useCallback((taskId) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }, []);

  const handleBulkNudge = async () => {
    const targets = displayTasks.filter((t) => selectedTaskIds.has(t.id) && t.assigned_to);
    const skipped = selectedTaskIds.size - targets.length;
    if (!targets.length) { toast.error('None of the selected tasks have an assignee'); return; }
    setBulkNudging(true);
    try {
      const results = await Promise.allSettled(
        targets.map((t) => api.post('/notifications/send', buildNudgePayload(t)))
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = targets.length - ok;
      toast.success(`Popup sent for ${ok}/${targets.length} task(s)${skipped ? ` (${skipped} had no assignee)` : ''}${failed ? ` — ${failed} failed` : ''}`);
      setSelectedTaskIds(new Set());
      setSelectMode(false);
    } catch {
      toast.error('Failed to send bulk popups');
    } finally {
      setBulkNudging(false);
    }
  };

  const handleBulkPriorityChange = React.useCallback(async (newPriority) => {
    if (selectedTaskIds.size === 0) return;
    const normalized = String(newPriority).toLowerCase();
    const ids = Array.from(selectedTaskIds);
    setBulkUpdatingPriority(true);

    const previousTasks = [...tasks];
    setTasks(prev => prev.map(t => selectedTaskIds.has(t.id) ? { ...t, priority: normalized } : t));

    try {
      const results = await Promise.allSettled(
        ids.map(id =>
          fetch(`${API_BASE}/tasks/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
            body: JSON.stringify({ priority: normalized }),
          })
        )
      );
      const ok = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
      const label = PRIORITY_STYLES[normalized]?.label || newPriority;
      toast.success(`Priority updated to ${label} for ${ok}/${ids.length} task(s)`);
      setSelectedTaskIds(new Set());
      setSelectMode(false);
    } catch {
      setTasks(previousTasks);
      toast.error('Failed to update priority for selected tasks');
    } finally {
      setBulkUpdatingPriority(false);
    }
  }, [selectedTaskIds, tasks]);

  // ── Enhanced local duplicate detection — deep field-level comparison ──
  const detectDuplicatesLocally = (taskList) => {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Jaccard similarity on word tokens (length > 2)
    const similarity = (a, b) => {
      const wa = new Set(norm(a).split(' ').filter(w => w.length > 2));
      const wb = new Set(norm(b).split(' ').filter(w => w.length > 2));
      if (!wa.size || !wb.size) return 0;
      let inter = 0;
      wa.forEach(w => { if (wb.has(w)) inter++; });
      return inter / (wa.size + wb.size - inter);
    };

    // Trigram similarity for short strings like client names
    const trigramSim = (a, b) => {
      const trig = (s) => { const r = new Set(); for (let i = 0; i < s.length - 2; i++) r.add(s.slice(i, i + 3)); return r; };
      const sa = trig(norm(a)), sb = trig(norm(b));
      if (!sa.size || !sb.size) return 0;
      let inter = 0;
      sa.forEach(t => { if (sb.has(t)) inter++; });
      return inter / (sa.size + sb.size - inter);
    };

    // Strip common CA/legal suffixes for smarter title matching
    const normTitle = (s) => norm(s)
      .replace(/\b(pvt|ltd|llp|private|limited|inc|corp|gst|registration|filing|return|application|document|compliance|annual)\b/g, '')
      .replace(/\s+/g, ' ').trim();

    const groups = [];
    const used   = new Set();

    taskList.forEach((t1, i) => {
      if (used.has(t1.id)) return;
      const group   = [t1.id];
      const reasons = [];

      taskList.forEach((t2, j) => {
        if (i === j || used.has(t2.id)) return;

        const titleSim     = similarity(t1.title, t2.title);
        const titleNormSim = similarity(normTitle(t1.title), normTitle(t2.title));
        const descSim      = similarity(t1.description, t2.description);
        const exactTitle   = norm(t1.title) === norm(t2.title);
        const sameCategory = t1.category && t2.category && t1.category === t2.category;
        const sameClient   = t1.client_id && t2.client_id && t1.client_id === t2.client_id;
        const sameAssignee = t1.assigned_to && t2.assigned_to && t1.assigned_to === t2.assigned_to;
        const samePriority = t1.priority === t2.priority;
        const sameDueDate  = t1.due_date && t2.due_date &&
          new Date(t1.due_date).toDateString() === new Date(t2.due_date).toDateString();

        // Score composite: weighted combination of signals
        let score = 0;
        score += titleSim * 50;           // raw title similarity 0-50
        score += titleNormSim * 20;       // normalised title (strips legal words) 0-20
        score += descSim * 15;            // description similarity 0-15
        if (sameCategory) score += 8;
        if (sameClient)   score += 10;
        if (sameAssignee) score += 4;
        if (samePriority) score += 3;
        if (sameDueDate)  score += 5;

        // Build human-readable reason
        const reasonParts = [];
        if (exactTitle) reasonParts.push('Exact title match');
        else if (titleSim > 0.7) reasonParts.push(`Title ${Math.round(titleSim * 100)}% similar`);
        else if (titleNormSim > 0.7) reasonParts.push(`Core title ${Math.round(titleNormSim * 100)}% similar`);
        if (sameClient)   reasonParts.push(`same client`);
        if (sameCategory) reasonParts.push(`same dept (${(t1.category || '').toUpperCase()})`);
        if (sameDueDate)  reasonParts.push(`same due date`);
        if (descSim > 0.5) reasonParts.push(`description ${Math.round(descSim * 100)}% similar`);

        // Thresholds — exact title = always flag; score >= 55 = high; >= 40 = medium
        const isDuplicate = exactTitle || score >= 40;
        if (!isDuplicate) return;

        group.push(t2.id);
        const conf = exactTitle || score >= 65 ? 'high' : 'medium';
        reasons.push({ id: t2.id, conf, score: Math.round(score), reasonParts });
      });

      if (group.length > 1) {
        const maxConf    = reasons.some(r => r.conf === 'high') ? 'high' : 'medium';
        const topReason  = reasons[0]?.reasonParts?.join(' · ') || 'Similar tasks detected';
        groups.push({
          reason: topReason,
          confidence: maxConf,
          task_ids: group.map(String),
          source: 'local',
        });
        group.forEach(id => used.add(id));
      }
    });

    return groups;
  };

  const cancelScan = () => {
    if (scanAbortRef.current) {
      try { scanAbortRef.current.abort(); } catch {}
      scanAbortRef.current = null;
    }
  };

  const handleDetectDuplicates = async () => {
    if (detectingDuplicates) return;

    // Fresh abort controller for this scan
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const { signal } = controller;
    const isAborted = () => signal.aborted;

    setDetectingDuplicates(true);
    setDuplicateGroups([]);
    setScanProgress(0);
    setScanStatus('Preparing tasks…');

    const activeTasks = scopedTasks.filter(t => t.status !== 'completed');
    const startedAt = Date.now();

    // Smoothly tween scanProgress toward a target value while a step is running.
    let progressTimer = null;
    const tweenTo = (target, stepMs = 120) => {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      progressTimer = setInterval(() => {
        if (isAborted()) { clearInterval(progressTimer); progressTimer = null; return; }
        setScanProgress(prev => {
          if (prev >= target) { clearInterval(progressTimer); progressTimer = null; return prev; }
          const next = prev + Math.max(1, Math.round((target - prev) * 0.15));
          return next >= target ? target : next;
        });
      }, stepMs);
    };
    const stopTween = () => { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } };

    // Helper: run Gemini
    const tryGemini = async () => {
      setScanStatus('✦ Asking Gemini…');
      tweenTo(60);
      const res = await fetch(`${API_BASE}/tasks/detect-duplicates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ exclude_completed: true }),
        signal,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const detail = e.detail || '';
        if (res.status === 405 || res.status === 404) {
          throw new Error('ENDPOINT_UNAVAILABLE: Gemini endpoint not available');
        }
        if (res.status === 429 || detail.toLowerCase().includes('quota') || detail.toLowerCase().includes('rate limit')) {
          throw new Error('QUOTA_EXCEEDED: Gemini API quota exceeded');
        }
        throw new Error(detail || `Server error ${res.status}`);
      }
      setScanStatus('✦ Parsing Gemini response…');
      tweenTo(85);
      const data = await res.json();
      return (Array.isArray(data.groups) ? data.groups : [])
        .map(g => ({
          ...g,
          task_ids: (g.task_ids || []).filter(id => {
            const t = tasks.find(x => String(x.id) === String(id));
            return t && t.status !== 'completed';
          }),
        }))
        .filter(g => (g.task_ids || []).length > 1)
        .map(g => ({ ...g, source: 'gemini' }));
    };

    // Helper: run Grok
    const tryGrok = async () => {
      setScanStatus('⚡ Asking Grok…');
      tweenTo(60);
      const res = await fetch(`${API_BASE}/tasks/detect-duplicates-grok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({
          tasks: activeTasks.map(t => ({
            id: t.id, title: t.title, description: t.description,
            category: t.category, client_id: t.client_id,
            assigned_to: t.assigned_to, due_date: t.due_date,
            priority: t.priority, status: t.status,
          })),
          exclude_completed: true,
        }),
        signal,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const detail = e.detail || '';
        if (res.status === 405) {
          throw new Error('ENDPOINT_UNAVAILABLE: Grok endpoint not available');
        }
        if (res.status === 404) {
          throw new Error('ENDPOINT_UNAVAILABLE: Grok endpoint not found');
        }
        if (res.status === 429 || detail.toLowerCase().includes('quota') || detail.toLowerCase().includes('rate limit') || detail.toLowerCase().includes('too many')) {
          throw new Error('QUOTA_EXCEEDED: Grok API quota exceeded');
        }
        throw new Error(detail || `Server error ${res.status}`);
      }
      setScanStatus('⚡ Parsing Grok response…');
      tweenTo(85);
      const data = await res.json();
      return (Array.isArray(data.groups) ? data.groups : [])
        .map(g => ({
          ...g,
          task_ids: (g.task_ids || []).filter(id => {
            const t = tasks.find(x => String(x.id) === String(id));
            return t && t.status !== 'completed';
          }),
        }))
        .filter(g => (g.task_ids || []).length > 1)
        .map(g => ({ ...g, source: 'grok' }));
    };

    // Helper: run local
    const runLocal = () => {
      setScanStatus('⚙ Running local algorithm…');
      tweenTo(85);
      return detectDuplicatesLocally(activeTasks).map(g => ({ ...g, source: 'local' }));
    };

    const finish = (groups, label) => {
      stopTween();
      setScanStatus(`${label} — done`);
      setScanProgress(100);
      setDuplicateGroups(groups);
      setShowDuplicateDialog(true);

      // Determine which provider actually produced the result from the label/source
      const usedProvider =
        label.includes('Gemini') ? 'gemini' :
        label.includes('Grok')   ? 'grok'   :
        label.includes('Local')  ? 'local'  :
                                   aiProvider;
      const duplicateTaskCount = groups.reduce((sum, g) => sum + (g.task_ids?.length || 0), 0);
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        provider: usedProvider,
        label,
        groupCount: groups.length,
        taskCount: duplicateTaskCount,
        scannedCount: activeTasks.length,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      };
      // Keep the most recent 5 scans
      setScanHistory(prev => [entry, ...prev].slice(0, 5));

      if (!groups.length) toast.success(`${label} scanned ${activeTasks.length} active tasks — no duplicates found ✓`);
      else toast.info(`${label} found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      setTimeout(() => {
        setDetectingDuplicates(false);
        setScanProgress(0);
        setScanStatus('');
        scanAbortRef.current = null;
      }, 600);
    };

    const handleCancelled = () => {
      stopTween();
      toast.message('Scan cancelled');
      setDetectingDuplicates(false);
      setScanProgress(0);
      setScanStatus('');
      scanAbortRef.current = null;
    };

    try {
      tweenTo(15);

      if (aiProvider === 'gemini') {
        try {
          finish(await tryGemini(), '✦ Gemini AI');
        } catch (e) {
          if (isAborted() || e?.name === 'AbortError') { handleCancelled(); return; }
          if (e?.message?.startsWith('QUOTA_EXCEEDED')) {
            setScanStatus('Gemini quota exceeded — falling back to local scan…');
            toast.info('Gemini API quota exceeded — running local duplicate scan instead');
            stopTween(); setScanProgress(55); tweenTo(70);
            if (!isAborted()) finish(runLocal(), '⚙ Local Scan (Gemini quota exceeded)');
          } else if (e?.message?.startsWith('ENDPOINT_UNAVAILABLE')) {
            setScanStatus('Gemini not configured on server — using local scan…');
            toast.info('Gemini is not configured on this server — running local scan instead');
            stopTween(); setScanProgress(55); tweenTo(70);
            if (!isAborted()) finish(runLocal(), '⚙ Local Scan (Gemini unavailable)');
          } else throw e;
        }
      } else if (aiProvider === 'grok') {
        try {
          finish(await tryGrok(), '⚡ Grok AI');
        } catch (e) {
          if (isAborted() || e?.name === 'AbortError') { handleCancelled(); return; }
          if (e?.message?.startsWith('QUOTA_EXCEEDED')) {
            setScanStatus('Grok quota exceeded — falling back to local scan…');
            toast.info('Grok API quota exceeded — running local duplicate scan instead');
            stopTween(); setScanProgress(55); tweenTo(70);
            if (!isAborted()) finish(runLocal(), '⚙ Local Scan (Grok quota exceeded)');
          } else if (e?.message?.startsWith('ENDPOINT_UNAVAILABLE')) {
            setScanStatus('Grok not configured on server — using local scan…');
            toast.info('Grok is not configured on this server — running local duplicate scan instead');
            stopTween(); setScanProgress(55); tweenTo(70);
            if (!isAborted()) finish(runLocal(), '⚙ Local Scan (Grok unavailable)');
          } else throw e;
        }
      } else if (aiProvider === 'local') {
        // Local is synchronous — only honor cancellation if it happened before we got here
        if (isAborted()) { handleCancelled(); return; }
        finish(runLocal(), '⚙ Local Scan');
      } else {
        // auto — try gemini → grok → local with per-step status
        try { finish(await tryGemini(), '✦ Gemini AI'); return; }
        catch (e) {
          if (isAborted() || e?.name === 'AbortError') { handleCancelled(); return; }
          const isQuota = e?.message?.startsWith('QUOTA_EXCEEDED');
          const isUnavailable = e?.message?.startsWith('ENDPOINT_UNAVAILABLE');
          console.warn('Gemini unavailable:', e.message);
          if (isQuota) {
            setScanStatus('Gemini quota exceeded — trying Grok…');
          } else if (isUnavailable) {
            setScanStatus('Gemini not configured — trying Grok…');
          } else {
            setScanStatus('Gemini unavailable — trying Grok…');
          }
          stopTween(); setScanProgress(35); tweenTo(45);
        }
        try { finish(await tryGrok(), '⚡ Grok AI'); return; }
        catch (e) {
          if (isAborted() || e?.name === 'AbortError') { handleCancelled(); return; }
          const isQuota = e?.message?.startsWith('QUOTA_EXCEEDED');
          const isUnavailable = e?.message?.startsWith('ENDPOINT_UNAVAILABLE');
          console.warn('Grok unavailable:', e.message);
          if (isQuota) {
            setScanStatus('Grok quota exceeded — using local scan…');
            toast.info('AI quota limits reached — running local duplicate scan instead');
          } else if (isUnavailable) {
            setScanStatus('Grok not configured — using local scan…');
          } else {
            setScanStatus('Grok unavailable — using local scan…');
          }
          stopTween(); setScanProgress(55); tweenTo(70);
        }
        if (isAborted()) { handleCancelled(); return; }
        finish(runLocal(), '⚙ Local Scan');
      }
    } catch (err) {
      if (isAborted() || err?.name === 'AbortError') { handleCancelled(); return; }
      stopTween();
      toast.error('Duplicate detection failed. Please try again.');
      console.error(err);
      setDetectingDuplicates(false);
      setScanProgress(0);
      setScanStatus('');
      scanAbortRef.current = null;
    }
  };

  const handleCsvUpload = (e) => {
    const f = e?.target?.files?.[0];
    if (f) { setCsvAiFile(f); toast.info(`${f.name} selected — AI is analysing…`); }
  };
  const handleExportCsv = () => { toast.success('Exporting CSV (stub)'); };
  const handleExportPdf = () => { toast.success('Exporting PDF (stub)'); };

  const handleSendReminders = async () => {
    if (!window.confirm('Send pending task reminder emails to all assigned users now?')) return;
    setSendingReminders(true);
    setReminderResult(null);
    try {
      const res = await api.post('/send-pending-task-reminders');
      const { emails_sent = 0, emails_failed = [], total_users = 0 } = res.data || {};
      setReminderResult({ emails_sent, emails_failed, total_users });
      if (emails_sent > 0) {
        toast.success(`✓ Reminder emails sent to ${emails_sent} of ${total_users} user${total_users !== 1 ? 's' : ''}`);
      } else if (total_users === 0) {
        toast.info('No pending tasks found — nothing to remind.');
      } else {
        toast.error(`All ${emails_failed.length} reminder email(s) failed. Check BREVO_API_KEY and SENDER_EMAIL on the server.`);
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to send reminders');
    } finally {
      setSendingReminders(false);
    }
  };

  // ── Scoping & stats ───────────────────────────────────────────────────────
  const scopedTasks = React.useMemo(() => {
    if (isAdmin) return tasks;
    if (hasCrossVisibility) {
      const visibleIds = new Set([user?.id, ...crossVisibilityUserIds]);
      return tasks.filter(t => visibleIds.has(t.assigned_to) || t.sub_assignees?.some(id => visibleIds.has(id)));
    }
    return tasks.filter(t => t.assigned_to === user?.id || t.sub_assignees?.includes(user?.id) || t.created_by === user?.id);
  }, [tasks, isAdmin, hasCrossVisibility, user, crossVisibilityUserIds]);

  const myTasks = React.useMemo(() => tasks.filter(t => t.assigned_to === user?.id || t.sub_assignees?.includes(user?.id)), [tasks, user]);

  const stats = useMemo(() => ({
    myTask:     myTasks.length,
    assignedByMe: scopedTasks.filter(t => t.created_by === user?.id).length,
    total:      scopedTasks.length,
    todo:       scopedTasks.filter(t => t.status === 'pending').length,
    inProgress: scopedTasks.filter(t => t.status === 'in_progress').length,
    completed:  scopedTasks.filter(t => t.status === 'completed').length,
    overdue:    scopedTasks.filter(t => isOverdue(t)).length,
    dueToday:   scopedTasks.filter(t => isDueToday(t)).length,
    teamTask:   hasCrossVisibility ? tasks.filter(t => { const isIncomplete = t.status !== 'completed'; const isMyTask = t.assigned_to === user?.id || (t.sub_assignees || []).includes(user?.id); const isCrossTask = crossVisibilityUserIds.includes(t.assigned_to) || (t.sub_assignees || []).some(id => crossVisibilityUserIds.includes(id)); return isIncomplete && (isMyTask || isCrossTask); }).length : 0,
  }), [myTasks, scopedTasks, tasks, hasCrossVisibility, crossVisibilityUserIds, user?.id, isOverdue, isDueToday]);

  const completionRate = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;


  const teamTaskBreakdown = React.useMemo(() => {
    if (!hasCrossVisibility) return [];
    const allUids = [...new Set([user?.id, ...crossVisibilityUserIds].filter(Boolean))];
    return allUids.map(uid => {
      const member = users.find(u => u.id === uid);
      const nameFromTask = tasks.find(t => t.assigned_to === uid)?.assigned_to_name;
      const pendingCount = tasks.filter(t => (t.assigned_to === uid || (t.sub_assignees || []).includes(uid)) && t.status !== 'completed').length;
      const label = uid === user?.id ? (member?.full_name || 'Me') : (member?.full_name || nameFromTask || 'Unknown');
      return { id: uid, name: label, pendingCount };
    }).filter(m => m.pendingCount > 0);
  }, [hasCrossVisibility, crossVisibilityUserIds, tasks, users, user?.id]);

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filteredTasks = useMemo(() => scopedTasks.filter(task => {
    const cleanQuery = (searchQuery || '').trim().toLowerCase();
    const matchesSearch = !cleanQuery ||
      Boolean(task.title && task.title.toLowerCase().includes(cleanQuery)) ||
      Boolean(task.description && task.description.toLowerCase().includes(cleanQuery));
    const taskPriority    = (task.priority || 'medium').toLowerCase();
    const matchesPriority = filterPriority === 'all' || taskPriority === filterPriority.toLowerCase();
    const matchesCategory = filterCategory.length === 0 || filterCategory.includes(task.category);
    const matchesAssignee = filterAssignee.length === 0 || filterAssignee.includes(task.assigned_to) || filterAssignee.some(id => (task.sub_assignees || []).includes(id));
    const matchesTeam     = !filterTeamOnly || task.assigned_to === user?.id || (task.sub_assignees || []).includes(user?.id) || crossVisibilityUserIds.includes(task.assigned_to) || (task.sub_assignees || []).some(id => crossVisibilityUserIds.includes(id));
    let matchesStatus = true;
    if (filterStatus !== 'all') matchesStatus = filterStatus === 'overdue' ? isOverdue(task) : filterStatus === 'due_today' ? isDueToday(task) : task.status === filterStatus;
    let matchesTodayNew = true;
    if (filterTodayNew) {
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const createdDate = task.created_at ? format(new Date(task.created_at), 'yyyy-MM-dd') : '';
      if (isAdmin) {
        // Admin: if a specific assignee is selected, show that user's today-new tasks; else show all users' today-new tasks
        matchesTodayNew = createdDate === todayStr && (filterAssignee.length === 0 || filterAssignee.includes(task.assigned_to) || filterAssignee.some(id => (task.sub_assignees || []).includes(id)));
      } else {
        const assignedToMe = task.assigned_to === user?.id || (task.sub_assignees || []).includes(user?.id);
        matchesTodayNew = createdDate === todayStr && assignedToMe;
      }
    }
    let matchesPending = true;
    if (filterPending) {
      const isNotCompleted = task.status !== 'completed';
      if (isAdmin) {
        // Admin: if a specific assignee is selected show their pending; else all pending
        matchesPending = isNotCompleted && (filterAssignee.length === 0 || filterAssignee.includes(task.assigned_to) || filterAssignee.some(id => (task.sub_assignees || []).includes(id)));
      } else {
        const assignedToMe = task.assigned_to === user?.id || (task.sub_assignees || []).includes(user?.id);
        matchesPending = isNotCompleted && assignedToMe;
      }
    }
    return matchesSearch && matchesStatus && matchesPriority && matchesCategory && matchesAssignee && matchesTeam && matchesTodayNew && matchesPending;
  }), [scopedTasks, searchQuery, filterStatus, filterPriority, filterCategory, filterAssignee,
       filterTeamOnly, filterTodayNew, filterPending, showMyTasksOnly,
       user?.id, crossVisibilityUserIds, isOverdue, isDueToday, isAdmin]);

  // ── displayTasks must be defined BEFORE filteredStats ────────────────────
  const displayTasks = React.useMemo(() => {
    let result = [...filteredTasks];
    if (showMyTasksOnly && user?.id) result = result.filter(t => t.assigned_to === user.id || t.sub_assignees?.includes(user.id));
    if (filterAssignedByMe && user?.id) result = result.filter(t => t.created_by === user.id);
    if (filterCreatedBy !== 'all') result = result.filter(t => t.created_by === filterCreatedBy);
    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'due_date') { const dA = a.due_date ? new Date(a.due_date).getTime() : Infinity; const dB = b.due_date ? new Date(b.due_date).getTime() : Infinity; cmp = dA - dB; }
      else if (sortBy === 'priority') { const prioOrder = { critical: 4, high: 3, medium: 2, low: 1 }; cmp = (prioOrder[(b.priority || 'medium').toLowerCase()] || 0) - (prioOrder[(a.priority || 'medium').toLowerCase()] || 0); }
      else if (sortBy === 'title')  cmp = a.title.localeCompare(b.title);
      else if (sortBy === 'status') cmp = (a.status || '').localeCompare(b.status || '');
      else if (sortBy === 'created_date') { const dA = a.created_at ? new Date(a.created_at).getTime() : 0; const dB = b.created_at ? new Date(b.created_at).getTime() : 0; cmp = dA - dB; }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [filteredTasks, showMyTasksOnly, sortBy, sortDirection, user, filterAssignedByMe, filterCreatedBy]);

  // ── Live filtered stats — recomputed from displayTasks whenever filters change ──
  const filteredStats = React.useMemo(() => {
    const list = displayTasks; // already fully filtered + sorted
    const todoFiltered  = list.filter(t => t.status === 'pending');
    const wipFiltered   = list.filter(t => t.status === 'in_progress');
    const doneFiltered  = list.filter(t => t.status === 'completed');
    const overdueList   = list.filter(t => isOverdue(t));
    const dueTodayList  = list.filter(t => isDueToday(t));
    const teamFiltered  = hasCrossVisibility
      ? list.filter(t => {
          const isIncomplete = t.status !== 'completed';
          const isMyTask = t.assigned_to === user?.id || (t.sub_assignees || []).includes(user?.id);
          const isCrossTask = crossVisibilityUserIds.includes(t.assigned_to) || (t.sub_assignees || []).some(id => crossVisibilityUserIds.includes(id));
          return isIncomplete && (isMyTask || isCrossTask);
        })
      : [];
    const filteredCompletionRate = list.length > 0 ? Math.round((doneFiltered.length / list.length) * 100) : 0;

    // When a creator filter is active (filterCreatedBy or filterAssignedByMe),
    // "assigned" card shows tasks assigned BY that creator TO others (not self)
    const creatorId = filterAssignedByMe ? user?.id : (filterCreatedBy !== 'all' ? filterCreatedBy : null);
    const assignedByCreator = creatorId
      ? list.filter(t => t.created_by === creatorId && t.assigned_to !== creatorId)
      : list.filter(t => t.created_by === user?.id);

    return {
      total:          list.length,
      myTask:         assignedByCreator.length,
      todo:           todoFiltered.length,
      inProgress:     wipFiltered.length,
      completed:      doneFiltered.length,
      overdue:        overdueList.length,
      dueToday:       dueTodayList.length,
      teamTask:       teamFiltered.length,
      completionRate: filteredCompletionRate,
    };
  }, [displayTasks, user, isOverdue, isDueToday, hasCrossVisibility, crossVisibilityUserIds, filterAssignedByMe, filterCreatedBy]);

  // Human-readable filter context for the live card subheadings
  const filterContextLabel = React.useMemo(() => {
    const parts = [];
    if (searchQuery)              parts.push(`"${searchQuery}"`);
    if (filterStatus !== 'all')   parts.push(STATUS_STYLES[filterStatus]?.label || filterStatus);
    if (filterPriority !== 'all') parts.push(filterPriority.toUpperCase());
    if (filterCategory.length > 0) parts.push(filterCategory.map(getCategoryLabel).join(', '));
    if (filterAssignee.length > 0) parts.push(filterAssignee.map(id => users.find(u => u.id === id)?.full_name || '').filter(Boolean).join(', '));
    if (showMyTasksOnly)          parts.push('Mine');
    if (filterTeamOnly)           parts.push('Team');
    if (filterAssignedByMe)       parts.push('By Me');
    if (filterCreatedBy !== 'all') parts.push(`By ${users.find(u => u.id === filterCreatedBy)?.full_name || ''}`);
    if (filterTodayNew)           parts.push("Today's New");
    if (filterPending)            parts.push('Pending');
    return parts.filter(Boolean).join(' · ');
  }, [searchQuery, filterStatus, filterPriority, filterCategory, filterAssignee, showMyTasksOnly, filterTeamOnly, filterAssignedByMe, filterCreatedBy, filterTodayNew, filterPending, users]);

  // useMemo instead of useEffect+setState — eliminates the extra render cycle
  const activeFilters = useMemo(() => {
    const pills = [];
    if (searchQuery)              pills.push({ key: 'search',   label: `"${searchQuery}"` });
    if (filterStatus !== 'all')   pills.push({ key: 'status',   label: STATUS_STYLES[filterStatus]?.label || filterStatus });
    if (filterPriority !== 'all') pills.push({ key: 'priority', label: filterPriority.toUpperCase() });
    if (filterCategory.length > 0) pills.push({ key: 'category', label: filterCategory.map(getCategoryLabel).join(' + ') });
    if (filterAssignee.length > 0) pills.push({ key: 'assignee', label: filterAssignee.map(id => userMap.get(id)?.full_name || id).join(' + ') });
    if (showMyTasksOnly)          pills.push({ key: 'mytasks',     label: 'Assigned To Me' });
    if (filterTeamOnly)           pills.push({ key: 'teamonly',    label: 'Team Tasks' });
    if (filterAssignedByMe)       pills.push({ key: 'assignedby',  label: 'Assigned by Me' });
    if (filterCreatedBy !== 'all') pills.push({ key: 'createdby', label: `By: ${userMap.get(filterCreatedBy)?.full_name || filterCreatedBy}` });
    if (filterTodayNew)           pills.push({ key: 'todaynew',   label: "Today's New Tasks" });
    if (filterPending)            pills.push({ key: 'pending',    label: 'Pending Tasks' });
    return pills;
  }, [searchQuery, filterStatus, filterPriority, filterCategory, filterAssignee, showMyTasksOnly, filterTeamOnly, filterAssignedByMe, filterCreatedBy, filterTodayNew, filterPending, userMap, getCategoryLabel]);

  const hasActiveFilters = activeFilters.length > 0;

  const removeFilter = (key) => {
    if (key === 'search')   setSearchQuery('');
    if (key === 'status')   setFilterStatus('all');
    if (key === 'priority') setFilterPriority('all');
    if (key === 'category') setFilterCategory([]);
    if (key === 'assignee') setFilterAssignee([]);
    if (key === 'mytasks')     setShowMyTasksOnly(false);
    if (key === 'teamonly')    setFilterTeamOnly(false);
    if (key === 'assignedby') setFilterAssignedByMe(false);
    if (key === 'createdby')  setFilterCreatedBy('all');
    if (key === 'todaynew')   setFilterTodayNew(false);
    if (key === 'pending')    setFilterPending(false);
  };

  const clearAllFilters = () => {
    setSearchQuery(''); setFilterStatus('all'); setFilterPriority('all'); setFilterCategory([]); setFilterAssignee([]);
    setShowMyTasksOnly(false); setFilterTeamOnly(false); setFilterAssignedByMe(false); setFilterCreatedBy('all'); setSortBy('due_date'); setSortDirection('asc');
    setFilterTodayNew(false);
    setFilterPending(false);
    toast.success('Filters cleared');
  };

  const filteredWorkflows = useMemo(() => COMPLIANCE_WORKFLOWS.filter(wf => {
    const matchSearch = wf.name.toLowerCase().includes(workflowSearch.toLowerCase()) || wf.title.toLowerCase().includes(workflowSearch.toLowerCase());
    const matchDept   = workflowDeptFilter      === 'all' || wf.category  === workflowDeptFilter;
    const matchFreq   = workflowFrequencyFilter === 'all' || wf.frequency.toLowerCase().includes(workflowFrequencyFilter.toLowerCase());
    return matchSearch && matchDept && matchFreq;
  }), [workflowSearch, workflowDeptFilter, workflowFrequencyFilter]);

  const applyComplianceWorkflow = (wf) => {
    const due = new Date(); due.setDate(due.getDate() + wf.estimatedDays);
    setFormData({ title: wf.title, description: wf.description, assigned_to: 'unassigned', sub_assignees: [], due_date: format(due, 'yyyy-MM-dd'), priority: wf.priority, status: 'pending', category: wf.category, client_id: '', is_recurring: true, recurrence_pattern: wf.recurrence_pattern, recurrence_interval: wf.recurrence_interval });
    setShowWorkflowLibrary(false); setDialogOpen(true); setWorkflowSearch(''); setWorkflowDeptFilter('all'); setWorkflowFrequencyFilter('all');
    toast.success(`Template loaded: ${wf.name}`);
  };

  const unreadCount         = notifications.filter(n => !n.is_read).length;
  const getBoardColumnTasks = (colStatus) => displayTasks.filter(t => t.status === colStatus);
  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <motion.div
      className="space-y-4 w-full min-w-0"
      variants={containerVariants} initial="hidden" animate="visible"
    >
      {/* Non-blocking loader */}
      {dataLoading && (
        <div className="fixed top-0 left-0 right-0 z-[99999] h-0.5 overflow-hidden">
          <div className="h-full w-full animate-pulse"
            style={{ background: `linear-gradient(90deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue}, ${COLORS.emeraldGreen})` }} />
        </div>
      )}

      {/* ── WELCOME BANNER (matches Dashboard exactly) ───────────────────── */}
      <motion.div variants={itemVariants}>
        <div
          className="relative overflow-hidden rounded-2xl px-4 sm:px-6 pt-4 sm:pt-5 pb-4"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 60%, #1a8fcc 100%)`, boxShadow: `0 8px 32px rgba(13,59,102,0.28)` }}
        >
          {/* Decorative blobs */}
          <div className="absolute right-0 top-0 w-72 h-72 rounded-full -mr-24 -mt-24 opacity-10" style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="absolute right-28 bottom-0 w-40 h-40 rounded-full mb-[-40px] opacity-5" style={{ background: 'white' }} />
          <div className="absolute left-0 bottom-0 w-48 h-48 rounded-full -ml-20 -mb-20 opacity-5" style={{ background: 'white' }} />

          <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 min-w-0">
            {/* Left — title */}
            <div className="flex-1 min-w-0">
              <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1 flex items-center gap-1.5 min-w-0 truncate">
                <Briefcase className="h-3 w-3" />
                {format(new Date(), 'EEEE, MMMM d, yyyy')}
              </p>
              <h1 className="text-lg sm:text-2xl font-bold text-white tracking-tight leading-tight truncate">Task Management</h1>
              <p className="text-white/60 text-sm mt-1">Task Updates</p>
            </div>

            {/* Right — action buttons: fixed three-column layout prevents empty cells
                and keeps New Task in the first row at desktop widths. */}
            <div className="grid grid-cols-3 gap-2 w-full lg:w-[720px] max-w-full min-w-0">
            {/* Total Tasks — admin only */}
            {isAdmin && (
              <>
                <Button variant="ghost" size="sm"
                  onClick={() => { setFilterStatus('all'); setFilterAssignee([]); setShowMyTasksOnly(false); setFilterTeamOnly(false); }}
                  className="h-8 text-xs rounded-xl gap-1.5 border font-semibold"
                  style={{ backgroundColor: 'rgba(31,175,90,0.22)', borderColor: 'rgba(31,175,90,0.55)', color: '#d1fae5' }}>
                  <Target className="h-3.5 w-3.5" /> Total: {stats.total}
                </Button>
              </>
            )}

              {/* New Task — primary action, intentionally placed in the first row. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setEditingTask(null); setFormData({ ...EMPTY_FORM }); setDialogOpen(true); }}
                className="h-8 w-full justify-center text-xs rounded-xl font-semibold gap-1.5"
                style={{
                  background: '#1FAF5A',
                  border: '1px solid #5CCB5F',
                  color: 'white',
                  boxShadow: '0 2px 8px rgba(31,175,90,0.24)',
                }}
              >
                <Plus className="h-3.5 w-3.5" /> New Task
              </Button>

              {/* Action buttons */}
              <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}
                className="h-8 text-xs rounded-xl text-white/80 hover:text-white hover:bg-white/15 border border-white/20">
                Upload CSV
              </Button>
              {/* Send Reminders — admin or can_send_reminders permission */}
              {(isAdmin || hasPermission('can_send_reminders')) && (
                <Button
                  variant="ghost" size="sm"
                  onClick={handleSendReminders}
                  disabled={sendingReminders}
                  className="h-8 text-xs rounded-xl gap-1.5 border border-white/20 font-semibold"
                  style={{
                    backgroundColor: sendingReminders ? 'rgba(255,255,255,0.08)' : 'rgba(251,191,36,0.22)',
                    borderColor: 'rgba(251,191,36,0.5)',
                    color: sendingReminders ? 'rgba(255,255,255,0.5)' : '#fef3c7',
                  }}>
                  {sendingReminders
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Sending…</>
                    : <><Mail className="h-3.5 w-3.5" />Send Reminders</>}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleExportCsv}
                className="h-8 text-xs rounded-xl text-white/80 hover:text-white hover:bg-white/15 border border-white/20">
                Export CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={handleExportPdf}
                className="h-8 text-xs rounded-xl text-white/80 hover:text-white hover:bg-white/15 border border-white/20">
                Export PDF
              </Button>
              {/* Bulk "raise a popup" — select tasks, then nudge all their assignees at once */}
              <Button
                variant="ghost" size="sm" onClick={toggleSelectMode}
                className="h-8 text-xs rounded-xl gap-1.5 border font-semibold"
                style={selectMode
                  ? { backgroundColor: 'rgba(244,63,94,0.25)', borderColor: 'rgba(244,63,94,0.55)', color: '#fecdd3' }
                  : { backgroundColor: 'transparent', borderColor: 'rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.8)' }}>
                {selectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {selectMode ? `Selecting (${selectedTaskIds.size})` : 'Select'}
              </Button>
              {canEditTasks && (
                <Button variant="ghost" size="sm" onClick={() => setShowWorkflowLibrary(true)}
                  className="h-8 text-xs rounded-xl gap-1.5 text-white/80 hover:text-white hover:bg-white/15 border border-white/20">
                  <FileText className="h-3.5 w-3.5" /> CA/CS Templates
                </Button>
              )}
              {/* Notifications */}
              <Popover open={showNotifications} onOpenChange={setShowNotifications}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="relative h-8 w-8 p-0 rounded-xl text-white/80 hover:text-white hover:bg-white/15 border border-white/20">
                    <Bell className="h-3.5 w-3.5" />
                    {unreadCount > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1">
                        {unreadCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className={`w-80 p-0 rounded-2xl shadow-xl border overflow-hidden ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200'}`} align="end">
                  <div className={`flex items-center justify-between px-5 py-3.5 border-b ${isDark ? 'border-slate-700 bg-slate-700/60' : 'border-slate-100 bg-slate-50'}`}>
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-slate-600" />
                      <h3 className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Notifications</h3>
                      {unreadCount > 0 && <span className="text-[10px] font-bold bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">{unreadCount} new</span>}
                    </div>
                    {unreadCount > 0 && <button onClick={markAllAsRead} className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors">Mark all read</button>}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="py-12 text-center"><Bell className="h-8 w-8 text-slate-200 mx-auto mb-2" /><p className="text-sm text-slate-400">No notifications</p></div>
                    ) : notifications.map((n) => (
                      <div key={n.id} className={`px-5 py-3.5 border-b border-slate-100 transition-colors ${!n.is_read ? (isDark ? 'bg-blue-900/20' : 'bg-blue-50/40') : ''}`}>
                        <p className={`text-xs ${!n.is_read ? 'font-semibold' : ''} ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{n.title}</p>
                        <p className="text-[10px] text-slate-400 mt-1">{format(new Date(n.created_at), 'MMM dd, hh:mm a')}</p>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* New Task */}
              {/* Dialog stays mounted even while permissions/data are still loading —
                  gating the whole <Dialog> made it unmount + remount (form flashed closed
                  then re-opened) when auth permissions resolved after navigation. */}
                <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}>
                  {/* GLITCH FIX: creating your own task must always be available —
                      it must not be hidden behind the universal can_edit_tasks flag,
                      which an admin may have turned off for this user without
                      intending to block them from their own tasks. */}
                  {/* Dialog form — premium redesign */}
                  <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden p-0 gap-0 flex flex-col rounded-2xl shadow-2xl">
                    {/* Fixed gradient header */}
                    <div className="flex-shrink-0 px-7 pt-6 pb-5 relative" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 60%, #1a8fcc 100%)` }}>
                      <div className="absolute right-0 top-0 w-48 h-48 rounded-full -mr-16 -mt-16 opacity-10 pointer-events-none" style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
                      {/* Minimize — shrink this form to the dock and keep working elsewhere */}
                      <button
                        type="button"
                        onClick={() => { minimizeTaskForm(); setDialogOpen(false); toast.message('Task form minimized', { description: 'Resume it anytime from the dock in the bottom-left corner.' }); }}
                        className="absolute right-12 top-5 z-10 w-7 h-7 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
                        title="Minimize (resume later without losing your progress)"
                      >
                        <Minimize2 className="h-3.5 w-3.5" />
                      </button>
                      <DialogHeader>
                        <DialogTitle className="text-xl font-bold text-white flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                            {editingTask ? <Edit className="h-4 w-4 text-white" /> : <Plus className="h-4 w-4 text-white" />}
                          </div>
                          {editingTask ? 'Edit Task' : 'Create New Task'}
                        </DialogTitle>
                        <DialogDescription className="text-white/60 text-sm flex items-center gap-3 flex-wrap mt-1.5">
                          <span>{editingTask ? 'Update the task details below.' : 'Fill in the details to create a new task.'}</span>
                          {editingTask?.created_at && (
                            <span className="flex items-center gap-1 text-[11px] font-medium bg-white/15 text-white/80 px-2.5 py-1 rounded-full border border-white/20">
                              <Clock className="h-3 w-3" />
                              Created: {format(new Date(editingTask.created_at), 'MMM dd, yyyy · hh:mm a')}
                            </span>
                          )}
                        </DialogDescription>
                      </DialogHeader>
                    </div>

                    {/* Scrollable form body */}
                    <div className="overflow-y-auto flex-1 min-h-0 bg-slate-50/40">
                      <form onSubmit={handleSubmit}>

                        {/* ── Section 1: Task Details ── */}
                        <div className="mx-6 mt-5 mb-1 rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
                          <div className="flex items-center gap-2.5 px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}22, ${COLORS.mediumBlue}22)` }}>
                              <FileText className="h-3.5 w-3.5" style={{ color: COLORS.mediumBlue }} />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Task Details</span>
                          </div>
                          <div className="p-5 space-y-4">
                            <div className="space-y-1.5">
                              <Label className="text-[11px] font-semibold text-slate-500 flex items-center gap-1">
                                Task Title <span className="text-red-400 ml-0.5">*</span>
                              </Label>
                              <Input
                                placeholder="e.g. File GST Return for March 2025"
                                value={formData.title}
                                onChange={(e) => setFormData(p => ({ ...p, title: e.target.value }))}
                                required
                                className="h-10 text-sm rounded-xl border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-colors"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-[11px] font-semibold text-slate-500">
                                Description <span className="font-normal text-slate-400 text-[10px]">— use - bullet for checklist items</span>
                              </Label>
                              <Textarea
                                placeholder={"Add notes or checklist items:\n- Step 1\n- Step 2\n- Step 3"}
                                value={formData.description}
                                onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
                                rows={3}
                                className="text-sm rounded-xl border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none transition-colors"
                              />
                            </div>
                          </div>
                        </div>

                        {/* ── Section 2: Assignment & Schedule ── */}
                        <div className="mx-6 mt-3 mb-1 rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
                          <div className="flex items-center gap-2.5 px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #10b98122, #059669aa22)' }}>
                              <Calendar className="h-3.5 w-3.5 text-emerald-600" />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Assignment &amp; Schedule</span>
                          </div>
                          <div className="p-5 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                              {/* Client dropdown */}
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-slate-500">Client</Label>
                                <Popover open={clientPopoverOpen} onOpenChange={setClientPopoverOpen}>
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      role="combobox"
                                      aria-expanded={clientPopoverOpen}
                                      className="h-10 w-full text-sm rounded-xl border-slate-200 bg-slate-50 hover:bg-white font-normal justify-between transition-colors"
                                    >
                                      <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                                        <Building2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                                        <span className="truncate text-left">
                                          {formData.client_id
                                            ? (clients.find(c => c.id === formData.client_id)?.company_name ?? 'Client')
                                            : <span className="text-slate-400">Select client…</span>}
                                        </span>
                                      </span>
                                      <ChevronsUpDown className="ml-1 h-3.5 w-3.5 flex-shrink-0 opacity-40" />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    className="p-0 rounded-xl shadow-2xl border-slate-200"
                                    align="start"
                                    style={{ zIndex: 9999, width: 'var(--radix-popover-trigger-width)' }}
                                  >
                                    <Command className="rounded-xl">
                                      <div className="flex items-center border-b border-slate-100 px-3">
                                        <Search className="h-3.5 w-3.5 text-slate-400 mr-2 flex-shrink-0" />
                                        <CommandInput placeholder="Search clients…" className="h-9 text-sm border-0 outline-none ring-0 focus:ring-0 pl-0" />
                                      </div>
                                      <CommandList
                                        className="max-h-56 overflow-y-auto py-1"
                                        onWheel={(e) => e.stopPropagation()}
                                      >
                                        <CommandEmpty className="py-6 text-center text-sm text-slate-400">No client found.</CommandEmpty>
                                        <CommandGroup>
                                          <CommandItem
                                            value="__no_client__"
                                            onSelect={() => { setFormData(p => ({ ...p, client_id: '' })); setClientPopoverOpen(false); }}
                                            className="mx-1 rounded-lg text-slate-500 text-sm cursor-pointer"
                                          >
                                            <div className="w-4 h-4 mr-2 flex-shrink-0 flex items-center justify-center">
                                              {!formData.client_id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                                            </div>
                                            <span className="italic">No Client</span>
                                          </CommandItem>
                                          {clients.map(c => (
                                            <CommandItem
                                              key={c.id}
                                              value={c.company_name}
                                              onSelect={() => {
                                                if (!editingTask) {
                                                  const uid = c?.assignments?.length > 0 ? c.assignments[0].user_id : c?.assigned_to || null;
                                                  setFormData(p => ({ ...p, client_id: c.id, assigned_to: uid || p.assigned_to }));
                                                } else {
                                                  setFormData(p => ({ ...p, client_id: c.id }));
                                                }
                                                setClientPopoverOpen(false);
                                              }}
                                              className="mx-1 rounded-lg text-sm cursor-pointer"
                                            >
                                              <div className="w-4 h-4 mr-2 flex-shrink-0 flex items-center justify-center">
                                                {formData.client_id === c.id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                                              </div>
                                              <span className="truncate">{c.company_name}</span>
                                            </CommandItem>
                                          ))}
                                        </CommandGroup>
                                      </CommandList>
                                      {clients.length > 0 && (
                                        <div className="px-3 py-2 border-t border-slate-100 text-center">
                                          <span className="text-[10px] text-slate-400">{clients.length} clients loaded</span>
                                        </div>
                                      )}
                                    </Command>
                                  </PopoverContent>
                                </Popover>
                              </div>
                              {/* Due date */}
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-slate-500">Due Date</Label>
                                <Input
                                  type="date"
                                  value={formData.due_date}
                                  onChange={(e) => setFormData(p => ({ ...p, due_date: e.target.value }))}
                                  className="h-10 text-sm rounded-xl border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-colors"
                                />
                              </div>
                            </div>

                            {/* Popup interval (minutes) — per-task override of the universal popup cadence */}
                            <div className="space-y-1.5">
                              <Label className="text-[11px] font-semibold text-slate-500">
                                Popup interval (minutes)
                                <span className="ml-1 font-normal text-slate-400">— blank uses the universal setting</span>
                              </Label>
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                placeholder="e.g. 15"
                                value={formData.popup_interval_minutes}
                                onChange={(e) => setFormData(p => ({ ...p, popup_interval_minutes: e.target.value }))}
                                className="h-10 text-sm rounded-xl border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-colors"
                              />
                            </div>


                            {canAssignTasks && (
                              <div className="grid grid-cols-2 gap-4">
                                {/* Assignee */}
                                <div className="space-y-1.5">
                                  <Label className="text-[11px] font-semibold text-slate-500 flex items-center gap-1.5">
                                    Assignee
                                    {formData.client_id && formData.assigned_to !== 'unassigned' && (
                                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">Auto</span>
                                    )}
                                  </Label>
                                  <Select value={formData.assigned_to} onValueChange={(v) => setFormData(p => ({ ...p, assigned_to: v }))}>
                                    <SelectTrigger className="h-10 text-sm rounded-xl border-slate-200 bg-slate-50"><SelectValue /></SelectTrigger>
                                    <SelectContent className="max-h-52 overflow-y-auto rounded-xl">
                                      <SelectItem value="unassigned">— Unassigned</SelectItem>
                                      {users.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {/* Co-assignees */}
                                <div className="space-y-1.5">
                                  <Label className="text-[11px] font-semibold text-slate-500">Co-assignees</Label>
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <Button variant="outline" className="w-full h-10 text-sm rounded-xl border-slate-200 bg-slate-50 hover:bg-white font-normal justify-between transition-colors">
                                        <span className="flex items-center gap-1.5">
                                          <Users className="h-3.5 w-3.5 text-slate-400" />
                                          <span className="text-sm">
                                            {formData.sub_assignees.length > 0
                                              ? `${formData.sub_assignees.length} selected`
                                              : <span className="text-slate-400">None selected</span>}
                                          </span>
                                        </span>
                                        <ChevronDown className="h-3.5 w-3.5 opacity-40" />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 rounded-xl shadow-xl p-3" style={{ zIndex: 9999 }}>
                                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5 px-1">Add Co-assignees</p>
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {users.filter(u => u.id !== formData.assigned_to).map(u => (
                                          <label key={u.id} className="flex items-center gap-2.5 cursor-pointer hover:bg-slate-50 rounded-lg px-2 py-1.5 transition-colors">
                                            <Checkbox checked={formData.sub_assignees.includes(u.id)} onCheckedChange={() => toggleSubAssignee(u.id)} />
                                            <span className="text-sm text-slate-700">{u.full_name}</span>
                                          </label>
                                        ))}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* ── Section 3: Classification ── */}
                        <div className="mx-6 mt-3 mb-1 rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
                          <div className="flex items-center gap-2.5 px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 bg-violet-50">
                              <SlidersHorizontal className="h-3.5 w-3.5 text-violet-600" />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Classification</span>
                          </div>
                          <div className="p-5 space-y-4">
                            {/* Department chips */}
                            <div className="space-y-1.5">
                              <Label className="text-[11px] font-semibold text-slate-500">Department <span className="text-slate-400 font-normal">(select one or more)</span></Label>
                              <div className="flex flex-wrap gap-1.5">
                                {DEPARTMENTS.map(dept => {
                                  const isSelected = (formData.categories || []).includes(dept.value);
                                  return (
                                  <button
                                    key={dept.value}
                                    type="button"
                                    onClick={() => setFormData(p => {
                                      const cats = p.categories || [];
                                      const next = cats.includes(dept.value)
                                        ? cats.filter(c => c !== dept.value)
                                        : [...cats, dept.value];
                                      return { ...p, categories: next, category: next[0] || 'other' };
                                    })}
                                    className={`h-7 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-all duration-150 border ${
                                      isSelected
                                        ? 'border-transparent shadow-md scale-105 text-white'
                                        : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 hover:bg-slate-50'
                                    }`}
                                    style={isSelected
                                      ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }
                                      : {}}
                                  >
                                    {dept.label}
                                  </button>
                                  );
                                })}
                              </div>
                              {(formData.categories || []).length === 0 && (
                                <p className="text-[10px] text-amber-500 font-medium">Please select at least one department</p>
                              )}
                            </div>
                            {/* Priority + Status */}
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-slate-500">Priority Level</Label>
                                <div className="grid grid-cols-3 gap-1 mb-1.5">
                                  {[
                                    { value: 'high', label: 'High', style: PRIORITY_STYLES.high },
                                    { value: 'medium', label: 'Medium', style: PRIORITY_STYLES.medium },
                                    { value: 'low', label: 'Low', style: PRIORITY_STYLES.low },
                                  ].map((p) => {
                                    const isSelected = (formData.priority || 'medium').toLowerCase() === p.value;
                                    return (
                                      <button
                                        key={p.value}
                                        type="button"
                                        onClick={() => setFormData(prev => ({ ...prev, priority: p.value }))}
                                        className={`h-8 px-1 rounded-lg text-[11px] font-bold border transition-all flex items-center justify-center gap-1 ${
                                          isSelected
                                            ? `${p.style.badge} shadow-xs ring-2 ring-offset-1 ring-current`
                                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                        }`}
                                      >
                                        <span className={`w-1.5 h-1.5 rounded-full ${p.style.dot}`} />
                                        <span>{p.label}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                                <Select value={formData.priority} onValueChange={(v) => setFormData(p => ({ ...p, priority: v }))}>
                                  <SelectTrigger className="h-9 text-xs rounded-xl border-slate-200 bg-slate-50"><SelectValue /></SelectTrigger>
                                  <SelectContent className="rounded-xl">
                                    <SelectItem value="high">🔴 High</SelectItem>
                                    <SelectItem value="medium">🟡 Medium</SelectItem>
                                    <SelectItem value="low">🟢 Low</SelectItem>
                                    <SelectItem value="critical">🚨 Critical</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-slate-500">Status</Label>
                                <Select value={formData.status} onValueChange={(v) => setFormData(p => ({ ...p, status: v }))}>
                                  <SelectTrigger className="h-10 text-sm rounded-xl border-slate-200 bg-slate-50"><SelectValue /></SelectTrigger>
                                  <SelectContent className="rounded-xl">
                                    <SelectItem value="pending">📋 To Do</SelectItem>
                                    <SelectItem value="in_progress">⚡ In Progress</SelectItem>
                                    <SelectItem value="completed">✅ Completed</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* ── Section 4: Recurrence ── */}
                        <div className="mx-6 mt-3 mb-5 rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
                          <div className="flex items-center gap-2.5 px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${formData.is_recurring ? 'bg-blue-50' : 'bg-slate-100'}`}>
                              <Repeat className={`h-3.5 w-3.5 ${formData.is_recurring ? 'text-blue-600' : 'text-slate-400'}`} />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-500 flex-1">Recurrence</span>
                            <Switch checked={formData.is_recurring} onCheckedChange={(c) => setFormData(p => ({ ...p, is_recurring: c }))} />
                          </div>
                          {formData.is_recurring ? (
                            <div className="p-5 grid grid-cols-2 gap-4 bg-blue-50/40">
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-blue-600">Repeat Pattern</Label>
                                <Select value={formData.recurrence_pattern} onValueChange={(v) => setFormData(p => ({ ...p, recurrence_pattern: v }))}>
                                  <SelectTrigger className="h-10 text-sm rounded-xl border-blue-200 bg-white"><SelectValue /></SelectTrigger>
                                  <SelectContent className="rounded-xl">
                                    {RECURRENCE_PATTERNS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-[11px] font-semibold text-blue-600">Every</Label>
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number" min="1" max="365"
                                    value={formData.recurrence_interval}
                                    onChange={(e) => setFormData(p => ({ ...p, recurrence_interval: parseInt(e.target.value) || 1 }))}
                                    className="w-20 h-10 text-sm rounded-xl border-blue-200 bg-white"
                                  />
                                  <span className="text-sm text-blue-600 font-semibold">
                                    {formData.recurrence_pattern === 'daily' && 'days'}
                                    {formData.recurrence_pattern === 'weekly' && 'weeks'}
                                    {formData.recurrence_pattern === 'monthly' && 'months'}
                                    {formData.recurrence_pattern === 'yearly' && 'years'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="px-5 py-3.5 text-[12px] text-slate-400">
                              Toggle on to make this task repeat automatically on a schedule.
                            </div>
                          )}
                        </div>

                        {/* ── Sticky Footer ── */}
                        <div className="sticky bottom-0 px-6 py-4 bg-white border-t border-slate-100 flex items-center justify-between gap-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => { setDialogOpen(false); resetForm(); }}
                            className="h-10 px-5 text-sm rounded-xl text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                          >
                            Cancel
                          </Button>
                          <div className="flex items-center gap-3">
                            {editingTask && (
                              <span className="text-[11px] text-slate-400 hidden sm:block italic">Editing task</span>
                            )}
                            <Button
                              type="submit"
                              disabled={loading}
                              className="h-10 px-7 text-sm rounded-xl font-semibold gap-2 shadow-lg hover:shadow-xl hover:brightness-110 transition-all"
                              style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`, color: 'white' }}
                            >
                              {loading ? (
                                <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                              ) : editingTask ? (
                                <><Check className="h-4 w-4" /> Update Task</>
                              ) : (
                                <><Plus className="h-4 w-4" /> Create Task</>
                              )}
                            </Button>
                          </div>
                        </div>

                      </form>
                    </div>
                  </DialogContent>
                </Dialog>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── METRIC CARDS — 6 equal, all same height/layout ──────────────── */}
      {/* ── Reminder Result Banner ── */}
      {reminderResult && (
        <motion.div
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 px-4 py-3 rounded-xl border text-sm"
          style={{
            borderColor: reminderResult.emails_sent > 0 ? '#bbf7d0' : '#fecaca',
            backgroundColor: reminderResult.emails_sent > 0
              ? (isDark ? 'rgba(31,175,90,0.08)' : '#f0fdf4')
              : (isDark ? 'rgba(239,68,68,0.08)' : '#fef2f2'),
          }}>
          <Mail className="w-4 h-4 flex-shrink-0"
            style={{ color: reminderResult.emails_sent > 0 ? '#16a34a' : '#dc2626' }} />
          <span className="flex-1 font-medium"
            style={{ color: reminderResult.emails_sent > 0
              ? (isDark ? '#86efac' : '#15803d')
              : (isDark ? '#fca5a5' : '#dc2626') }}>
            {reminderResult.emails_sent > 0
              ? `✓ Reminder emails sent to ${reminderResult.emails_sent} / ${reminderResult.total_users} users`
              : `Reminder emails failed — check BREVO_API_KEY + SENDER_EMAIL on the server`}
            {reminderResult.emails_failed?.length > 0 && (
              <span className="ml-2 text-xs opacity-70">
                (Failed: {reminderResult.emails_failed.join(', ')})
              </span>
            )}
          </span>
          <button onClick={() => setReminderResult(null)}
            className="w-6 h-6 flex items-center justify-center rounded-lg opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: reminderResult.emails_sent > 0 ? '#16a34a' : '#dc2626' }}>
            ✕
          </button>
        </motion.div>
      )}

      <motion.div
        variants={itemVariants}
        className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 [&>*]:min-w-0 items-stretch"
      >
        {/* 1. My Task */}
        <MetricCard
          label="ASSIGNED TO ME" value={stats.myTask} icon={SlidersHorizontal}
          accent={isDark ? '#60a5fa' : COLORS.deepBlue}
          active={showMyTasksOnly} isDark={isDark}
          onClick={() => setShowMyTasksOnly(p => !p)}
        />

        {/* 2. To Do */}
        <MetricCard
          label="To Do" value={stats.todo} icon={Circle}
          accent="#EF4444"
          active={filterStatus === 'pending'} isDark={isDark}
          onClick={() => setFilterStatus(filterStatus === 'pending' ? 'all' : 'pending')}
        />

        {/* 3. In Progress */}
        <MetricCard
          label="In Progress" value={stats.inProgress} icon={TrendingUp}
          accent={COLORS.amber}
          active={filterStatus === 'in_progress'} isDark={isDark}
          onClick={() => setFilterStatus(filterStatus === 'in_progress' ? 'all' : 'in_progress')}
        />

        {/* 4. Completed */}
        <MetricCard
          label="Completed" value={stats.completed} icon={CheckCircle2}
          accent={COLORS.mediumBlue}
          active={filterStatus === 'completed'} isDark={isDark}
          progress={completionRate}
          onClick={() => setFilterStatus(filterStatus === 'completed' ? 'all' : 'completed')}
        />

        {/* 5. Overdue */}
        <MetricCard
          label="Overdue" value={stats.overdue} icon={AlertCircle}
          accent={COLORS.coral}
          active={filterStatus === 'overdue'} isDark={isDark}
          onClick={() => setFilterStatus(filterStatus === 'overdue' ? 'all' : 'overdue')}
        />

        {/* 6. Team Task — now uses TeamTaskCard for perfect alignment */}
        <TeamTaskCard
          stats={stats}
          hasCrossVisibility={hasCrossVisibility}
          usersLoading={usersLoading}
          filterTeamOnly={filterTeamOnly}
          setFilterTeamOnly={setFilterTeamOnly}
          setFilterAssignee={setFilterAssignee}
          setShowMyTasksOnly={setShowMyTasksOnly}
          teamTaskBreakdown={teamTaskBreakdown}
          isDark={isDark}
        />
      </motion.div>

      {/* ── LIVE FILTER SUMMARY CARDS — always visible, updates in real time ── */}
      {(() => {
        // Build a human-friendly label for each active filter dimension
        const filterParts = [];
        if (searchQuery)               filterParts.push({ key: 'search',    icon: '🔍', text: `"${searchQuery}"` });
        if (filterStatus !== 'all')    filterParts.push({ key: 'status',    icon: '📌', text: STATUS_STYLES[filterStatus]?.label || filterStatus });
        if (filterPriority !== 'all')  filterParts.push({ key: 'priority',  icon: '⚡', text: filterPriority.toUpperCase() + ' Priority' });
        if (filterCategory.length > 0)   filterParts.push({ key: 'dept',      icon: '🏢', text: filterCategory.map(getCategoryLabel).join(' + ') });
        if (filterAssignee.length > 0)   filterParts.push({ key: 'assignee',  icon: '👤', text: filterAssignee.map(id => users.find(u => u.id === id)?.full_name || 'Assignee').join(' + ') });
        if (showMyTasksOnly)           filterParts.push({ key: 'mine',      icon: '🎯', text: 'Assigned To Me' });
        if (filterTeamOnly)            filterParts.push({ key: 'team',      icon: '👥', text: 'Team Tasks' });
        if (filterAssignedByMe)        filterParts.push({ key: 'byme',      icon: '✍️', text: 'Assigned by Me' });
        if (filterCreatedBy !== 'all') filterParts.push({ key: 'creator',   icon: '✍️', text: `By ${users.find(u => u.id === filterCreatedBy)?.full_name || 'Creator'}` });
        if (filterTodayNew)            filterParts.push({ key: 'todaynew',  icon: '⚡', text: "Today's New" });
        if (filterPending)             filterParts.push({ key: 'pending',   icon: '⏳', text: 'Pending' });

        const isFiltered = filterParts.length > 0;

        // Dynamic label builder for each mini-card heading
        const buildLabel = (base, filterKey, activeIcon = '✓') => {
          const match = filterParts.find(f => f.key === filterKey);
          if (match) return `${activeIcon} ${base}`;
          // Contextualise with the primary active filter if no direct match
          if (isFiltered) {
            const ctx = filterParts[0];
            if (ctx.key === 'assignee') return `${base} · ${filterAssignee.map(id => users.find(u => u.id === id)?.full_name?.split(' ')[0] || '').join('+')}`;
            if (ctx.key === 'mine')     return `${base} · Me`;
            if (ctx.key === 'team')     return `${base} · Team`;
            if (ctx.key === 'creator')  return `${base} · ${users.find(u => u.id === filterCreatedBy)?.full_name?.split(' ')[0] || 'Creator'}`;
            if (ctx.key === 'dept')     return `${base} · ${filterCategory.map(getCategoryLabel).join('+')}` ;
          }
          return base;
        };

        const miniCards = [
          {
            id: 'mine',
            label: buildLabel('Assigned By', 'mine'),
            value: filteredStats.myTask,
            total: stats.assignedByMe,
            accent: isDark ? '#60a5fa' : COLORS.deepBlue,
            icon: SlidersHorizontal,
            active: showMyTasksOnly,
            onClick: () => setShowMyTasksOnly(!showMyTasksOnly),
          },
          {
            id: 'todo',
            label: buildLabel('To Do', 'status', filterStatus === 'pending' ? '✓' : undefined),
            value: filteredStats.todo,
            total: stats.todo,
            accent: '#EF4444',
            icon: Circle,
            active: filterStatus === 'pending',
            onClick: () => setFilterStatus(filterStatus === 'pending' ? 'all' : 'pending'),
          },
          {
            id: 'wip',
            label: buildLabel('In Progress', 'status', filterStatus === 'in_progress' ? '✓' : undefined),
            value: filteredStats.inProgress,
            total: stats.inProgress,
            accent: COLORS.amber,
            icon: TrendingUp,
            active: filterStatus === 'in_progress',
            onClick: () => setFilterStatus(filterStatus === 'in_progress' ? 'all' : 'in_progress'),
          },
          {
            id: 'done',
            label: buildLabel('Completed', 'status', filterStatus === 'completed' ? '✓' : undefined),
            value: filteredStats.completed,
            total: stats.completed,
            accent: COLORS.mediumBlue,
            icon: CheckCircle2,
            active: filterStatus === 'completed',
            showRate: true,
            rate: filteredStats.completionRate,
            onClick: () => setFilterStatus(filterStatus === 'completed' ? 'all' : 'completed'),
          },
          {
            id: 'dueToday',
            label: buildLabel('Due Today', 'status', filterStatus === 'due_today' ? '✓' : undefined),
            value: filteredStats.dueToday,
            total: stats.dueToday,
            accent: '#f59e0b',
            icon: Zap,
            active: filterStatus === 'due_today',
            onClick: () => setFilterStatus(filterStatus === 'due_today' ? 'all' : 'due_today'),
          },
          {
            id: 'overdue',
            label: buildLabel('Overdue', 'status', filterStatus === 'overdue' ? '✓' : undefined),
            value: filteredStats.overdue,
            total: stats.overdue,
            accent: COLORS.coral,
            icon: AlertCircle,
            active: filterStatus === 'overdue',
            onClick: () => setFilterStatus(filterStatus === 'overdue' ? 'all' : 'overdue'),
          },
        ];

        return (
          <motion.div variants={itemVariants} className="space-y-1.5">
            {/* Filter context strip — shown only when filtering */}
            <AnimatePresence>
              {isFiltered && (
                <motion.div
                  key="filter-strip"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className={`flex items-center gap-2 flex-wrap px-3 py-1.5 rounded-xl border text-[10px] font-semibold ${isDark ? 'bg-blue-950/40 border-blue-900 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700'}`}
                >
                  <Activity className="h-3 w-3 flex-shrink-0" />
                  <span className="font-bold uppercase tracking-wide">Live View</span>
                  <span className={`${isDark ? 'text-blue-500' : 'text-blue-400'}`}>·</span>
                  {filterParts.map((f, i) => (
                    <span key={f.key} className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md ${isDark ? 'bg-blue-900/50 text-blue-200' : 'bg-blue-100 text-blue-800'}`}>
                      {f.icon} {f.text}
                    </span>
                  ))}
                  <span className={`ml-auto font-bold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
                    {filteredStats.total} / {stats.total} tasks
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Mini stat cards — always visible */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {miniCards.map(({ id, label, value, total, accent, icon: Icon, active, showRate, rate, hidden, onClick }) => {
                if (hidden) return null;
                const pct     = total > 0 ? Math.round((value / total) * 100) : 0;
                const delta   = value - total; // negative = fewer in filter than global
                const changed = isFiltered && value !== total;
                return (
                  <motion.div
                    key={id}
                    layout
                    onClick={onClick}
                    animate={{ scale: active ? 1.02 : 1 }}
                    transition={{ duration: 0.18 }}
                    className={`rounded-xl px-2.5 py-2 border flex flex-col gap-1 transition-all cursor-pointer select-none ${
                      active
                        ? (isDark ? 'border-slate-500 bg-slate-700 shadow-md' : 'border-slate-300 bg-white shadow-sm')
                        : (isDark ? 'bg-slate-800/60 border-slate-700 hover:bg-slate-800' : 'bg-white/80 border-slate-200/80 hover:bg-white')
                    }`}
                    style={active ? { borderColor: accent, boxShadow: `0 0 0 1.5px ${accent}40` } : {}}
                  >
                    {/* Label row */}
                    <div className="flex items-start justify-between gap-1">
                      <p className={`text-[8.5px] font-bold uppercase tracking-wide leading-tight truncate ${active ? '' : 'text-slate-400'}`}
                        style={active ? { color: accent } : {}}>
                        {label}
                      </p>
                      <div className="p-0.5 rounded-md flex-shrink-0" style={{ backgroundColor: `${accent}18` }}>
                        <Icon className="h-2.5 w-2.5" style={{ color: accent }} />
                      </div>
                    </div>

                    {/* Value row */}
                    <div className="flex items-end gap-1">
                      <motion.span
                        key={value}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                        className="text-lg font-bold leading-none tracking-tight"
                        style={{ color: accent }}
                      >
                        {value}
                      </motion.span>
                      <span className={`text-[9px] font-medium pb-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        / {total}
                      </span>
                      {/* Delta badge — shows change when filter is active */}
                      {changed && (
                        <span className={`text-[8px] font-bold ml-auto px-1 py-0.5 rounded-md leading-none ${
                          delta < 0
                            ? (isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500')
                            : (isDark ? 'bg-emerald-900/40 text-emerald-400' : 'bg-emerald-50 text-emerald-600')
                        }`}>
                          {delta < 0 ? delta : `+${delta}`}
                        </span>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className={`h-0.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: active ? accent : `${accent}88` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.45, ease: 'easeOut' }}
                      />
                    </div>

                    {/* Completion rate or pct label */}
                    {showRate ? (
                      <p className="text-[8px] font-semibold" style={{ color: accent }}>{rate}% done</p>
                    ) : (
                      <p className={`text-[8px] font-medium ${isDark ? 'text-slate-600' : 'text-slate-300'}`}>
                        {pct}% of total
                      </p>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        );
      })()}

      {/* ── PERFORMANCE SCORE WIDGET ────────────────────────────────────────── */}
      {(() => {
        // While tasks/rankings are still being fetched, reserve the widget's
        // footprint with a skeleton instead of rendering nothing — this is
        // what was causing the "page loads in stages" effect, since this
        // whole block used to return null until data arrived, then pop in
        // abruptly after everything else had already painted.
        if (dataLoading || !rankingsLoaded) {
          return (
            <motion.div variants={itemVariants} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <div className={`rounded-2xl border overflow-hidden animate-pulse ${isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200'}`}
                style={{ boxShadow: '0 4px 24px rgba(99,102,241,0.06), 0 1px 3px rgba(0,0,0,0.04)' }}>
                <div className={`h-1 w-full ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`} />
                <div className="flex flex-col lg:flex-row">
                  <div className={`flex-shrink-0 lg:w-60 px-4 py-3.5 flex flex-col gap-2.5 ${isDark ? 'border-b lg:border-b-0 lg:border-r border-slate-700' : 'border-b lg:border-b-0 lg:border-r border-slate-100'}`}>
                    <div className={`h-2.5 w-16 rounded ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                    <div className="flex items-center gap-3">
                      <div className={`rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} style={{ width: 66, height: 66 }} />
                      <div className="flex-1 flex flex-col gap-2">
                        <div className={`h-4 w-20 rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                        <div className={`h-3 w-24 rounded ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                      </div>
                    </div>
                    <div className={`h-11 w-full rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />
                    <div className="grid grid-cols-4 gap-1.5">
                      {[0,1,2,3].map(i => <div key={i} className={`h-12 rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />)}
                    </div>
                    <div className={`h-9 w-full rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />
                  </div>
                  <div className={`flex-1 min-w-0 px-4 py-3 flex flex-col gap-2 ${isDark ? 'border-b lg:border-b-0 lg:border-r border-slate-700' : 'border-b lg:border-b-0 lg:border-r border-slate-100'}`}>
                    <div className={`h-2.5 w-24 rounded ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                    {[0,1,2].map(i => <div key={i} className={`h-8 w-full rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />)}
                  </div>
                  <div className="flex-shrink-0 lg:w-56 px-4 py-3 flex flex-col gap-2">
                    <div className={`h-2.5 w-16 rounded ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                    <div className={`h-16 w-full rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />
                    <div className={`h-16 w-full rounded-lg ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`} />
                  </div>
                </div>
              </div>
            </motion.div>
          );
        }

        if (myTasks.length === 0) return null;

        // ── Working days remaining this month (Mon–Fri only) ──
        const today = new Date();
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        let workingDaysLeft = 0;
        const cursor = new Date(today);
        cursor.setHours(0, 0, 0, 0);
        while (cursor <= lastDay) {
          const dow = cursor.getDay();
          if (dow !== 0 && dow !== 6) workingDaysLeft++;
          cursor.setDate(cursor.getDate() + 1);
        }

        // ── Local metrics from actual task data ──
        const myCompleted = myTasks.filter(t => t.status === 'completed').length;
        const myTotal     = myTasks.length;
        const myPending   = myTasks.filter(t => t.status !== 'completed').length;
        const myOverdue   = myTasks.filter(t => isOverdue(t)).length;

        const completedWithDue = myTasks.filter(t => t.status === 'completed' && t.due_date);
        const onTimeCompleted  = completedWithDue.filter(t => {
          if (!t.completed_at) return false;
          return new Date(t.completed_at) <= new Date(t.due_date);
        }).length;
        const onTimeRate    = completedWithDue.length > 0 ? Math.round((onTimeCompleted / completedWithDue.length) * 100) : 0;
        const completionPct = myTotal > 0 ? Math.round((myCompleted / myTotal) * 100) : 0;
        const healthPct     = myTotal > 0 ? Math.max(0, Math.round(((myTotal - myOverdue) / myTotal) * 100)) : 100;

        // ── Composite local score (weighted) ──
        const localScore = Math.round(completionPct * 0.5 + healthPct * 0.3 + onTimeRate * 0.2);

        // ── Prefer API score/rank if loaded, fall back to local ──
        const apiRank    = rankingsLoaded && myRanking ? myRanking.rank       : null;
        const totalUsers = rankingsLoaded && myRanking ? myRanking.totalUsers  : null;
        const apiBadge   = rankingsLoaded && myRanking ? myRanking.badge       : null;
        const apiScore   = rankingsLoaded && myRanking ? myRanking.overall_score : null;
        const apiAttendance  = rankingsLoaded && myRanking ? (myRanking.attendance_percent  ?? null) : null;
        const displayScore   = apiScore !== null ? apiScore : localScore;
        // Badge thresholds must mirror the backend exactly (>=95 Star, >=85 Top,
        // else Good) — the old local fallback used 85/65 with different names,
        // so an offline/local score showed a badge the server would never give.
        const displayBadge   = apiBadge  || (localScore >= 95 ? 'Star Performer' : localScore >= 85 ? 'Top Performer' : 'Good Performer');

        // ── Improve-rank insight ──
        const dailyTarget   = workingDaysLeft > 0 ? Math.ceil(myPending / workingDaysLeft) : myPending;
        const scoreColor  = displayScore >= 95 ? COLORS.emeraldGreen : displayScore >= 85 ? COLORS.mediumBlue : displayScore >= 60 ? COLORS.amber : COLORS.coral;
        const badgeColor  = displayBadge === 'Star Performer' ? COLORS.emeraldGreen : displayBadge === 'Top Performer' ? COLORS.mediumBlue : COLORS.amber;
        // Shared quality-color helper — used everywhere in the Score Card so the
        // whole widget reads off ONE limited, meaningful palette (brand blue for
        // chrome, green/amber/coral only for genuine performance signal) instead
        // of a different arbitrary hue per element.
        const qColor = (pct) => (pct >= 85 ? COLORS.emeraldGreen : pct >= 60 ? COLORS.amber : COLORS.coral);

        const taskCompletionVal = apiScore !== null ? (myRanking.task_completion_percent ?? completionPct) : completionPct;
        const onTimeVal         = apiScore !== null ? (myRanking.todo_ontime_percent ?? onTimeRate) : onTimeRate;


        // NOTE: there is deliberately no "trend" figure here any more. The old
        // one was `apiScore - localScore` (server score minus a locally derived
        // score) — two different formulas subtracted from each other, presented
        // as "pts this month". The API exposes no historical score, so nothing
        // truthful can be plotted; the card now shows real, current components.

        // ── Scoring formula (mirrors backend exactly) ──
        // overall_score = attendance*0.25 + hours_ratio*100*0.20 + task_completion*0.25 + todo_ontime*0.15 + timely_punchin*0.15
        // Badge: >=95 Star Performer | >=85 Top Performer | else Good Performer
        const apiTimely    = rankingsLoaded && myRanking ? (myRanking.timely_punchin_percent ?? 0) : 0;
        const apiHours     = rankingsLoaded && myRanking ? (myRanking.total_hours ?? 0) : 0;
        // ── Work Hours scoring (mirrors backend) ──
        // Monthly target = 180h. Below target -> proportional points.
        // At/above target -> ALWAYS full points (extra hours never reduce them).
        // Extra hours are converted into additive Bonus Points (max 5).
        const MONTHLY_HOURS_TARGET = 180;
        const BONUS_POINTS_PER_HOUR = 0.1;
        const BONUS_POINTS_MAX = 5;
        const hoursRatioPct = Math.min((apiHours / MONTHLY_HOURS_TARGET) * 100, 100);
        const extraHours    = Math.max(0, apiHours - MONTHLY_HOURS_TARGET);
        const bonusPoints   = rankingsLoaded && myRanking && myRanking.bonus_points != null
          ? Number(myRanking.bonus_points)
          : Math.min(extraHours * BONUS_POINTS_PER_HOUR, BONUS_POINTS_MAX);

        // Per-component score contributions (out of their weighted max)
        const contribAttendance    = (apiAttendance ?? 0) * 0.25;
        const contribHours         = hoursRatioPct * 0.20;
        const contribTaskComplete  = taskCompletionVal * 0.25;
        const contribOntime        = onTimeVal * 0.15;
        const contribTimely        = apiTimely * 0.15;

        // Weakest components for targeted tips
        const components = [
          { key: 'attendance',   label: 'Attendance',         pct: apiAttendance ?? 0,   weight: 25, contrib: contribAttendance   },
          { key: 'hours',        label: 'Work Hours (180h/mo)',pct: hoursRatioPct,         weight: 20, contrib: contribHours        },
          { key: 'tasks',        label: 'Task Completion',     pct: taskCompletionVal,     weight: 25, contrib: contribTaskComplete  },
          { key: 'ontime',       label: 'To-Do On-Time Rate',  pct: onTimeVal,             weight: 15, contrib: contribOntime       },
          { key: 'punchin',      label: 'Timely Punch-in',     pct: apiTimely,             weight: 15, contrib: contribTimely       },
        ].sort((a, b) => (b.weight - b.contrib) - (a.weight - a.contrib)); // biggest gap first

        // Component with the most unclaimed points — surfaced on the score card.
        const topGapComponent = components.find(c => (c.weight - c.contrib) > 0.05) || null;

        const scoreTo85  = Math.max(0, 85  - displayScore);
        const scoreTo95  = Math.max(0, 95  - displayScore);
        const nextBadge  = displayScore >= 95 ? null : displayScore >= 85 ? 'Star Performer (95+)' : displayScore >= 0 ? 'Top Performer (85+)' : null;
        const ptsToNext  = displayScore >= 95 ? null : displayScore >= 85 ? scoreTo95 : scoreTo85;

        const tipsByComponent = {
          attendance: [
            `Attendance is worth 25% of your score. You currently score ${(apiAttendance ?? 0).toFixed(1)}% — every missed day costs you 0.25 pts.`,
            `Mark attendance daily even on WFH days. The system counts check-ins against ${22} expected working days this month.`,
            'A full attendance month = 25 pts added to your score automatically.',
          ],
          hours: [
            `Work hours contribute 20% of your score (target: ${MONTHLY_HOURS_TARGET}h/month). You have logged ${apiHours.toFixed(1)}h so far.` + (extraHours > 0 ? ` You are ${extraHours.toFixed(1)}h over target, earning +${bonusPoints.toFixed(1)} bonus pts.` : ''),
            `Every extra hour logged adds ~0.11 pts. Logging all ${Math.max(0, 180 - apiHours).toFixed(0)}h remaining would add ${(Math.min((apiHours / 180), 1) < 1 ? ((1 - Math.min((apiHours / 180), 1)) * 20).toFixed(1) : '0')} pts.`,
            'Use the Attendance module to log hours accurately — partial sessions count.',
          ],
          tasks: [
            `Task completion is 25% of your score. You have completed ${myCompleted}/${myTotal} tasks (${taskCompletionVal.toFixed(1)}%).`,
            `Completing ${Math.max(1, myPending)} more pending tasks would push this component closer to its full 25-pt contribution.`,
            'Mark tasks "Completed" as soon as done — the system counts completed tasks vs assigned tasks in this period.',
          ],
          ontime: [
            `On-time To-Do rate is 15% of your score. Complete To-Do items before their due date to earn this.`,
            `You have completed ${onTimeCompleted} of ${completedWithDue.length} tasks on time (${onTimeVal.toFixed(1)}%). Each on-time completion lifts this metric.`,
            'Set reminders on To-Do items and aim to close them a day early to stay safe.',
          ],
          punchin: [
            `Timely punch-in is 15% of your score. You punch in on time ${apiTimely.toFixed(1)}% of attended days.`,
            'Mark attendance within your firm\'s start window — late check-ins are counted as present but not timely.',
            'Setting a daily phone alarm 15 min before start time is the easiest way to improve this metric.',
          ],
        };

        return (
          <>
          {/* ── Tips Modal ── */}
          <AnimatePresence>
            {showTips && (
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center p-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <motion.div
                  className="absolute inset-0 bg-emerald-900/50 backdrop-blur-sm"
                  onClick={() => { setShowTips(false); setFocusedMetric(null); }}
                />
                <motion.div
                  className={`relative z-10 w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
                  initial={{ scale: 0.92, opacity: 0, y: 24 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.92, opacity: 0, y: 24 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                >
                  {/* Top accent bar — same gradient language as Score Card & app header */}
                  <div className="h-[3px] w-full flex-shrink-0" style={{ background: `linear-gradient(90deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue}, ${COLORS.emeraldGreen})` }} />

                  {/* Modal header */}
                  <div className="px-6 pt-5 pb-4 flex-shrink-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2.5 mb-1.5">
                          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                            <Zap className="h-4.5 w-4.5 text-white" />
                          </div>
                          <h3 className={`text-lg font-black ${isDark ? 'text-white' : 'text-slate-800'}`}>How to Improve Your Score</h3>
                        </div>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          Your score: <span className="font-black" style={{ color: COLORS.mediumBlue }}>{Math.round(displayScore)}/100</span>
                          {nextBadge && <> · <span className="font-semibold">{ptsToNext?.toFixed(1)} pts to {nextBadge}</span></>}
                        </p>
                      </div>
                      <button
                        onClick={() => { setShowTips(false); setFocusedMetric(null); }}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>

                    {/* Score formula bar */}
                    <div className={`mt-4 rounded-xl p-4 ${isDark ? 'bg-slate-900/40 border border-slate-700' : 'bg-slate-50 border border-slate-100'}`}>
                      <p className={`text-[10px] font-bold uppercase tracking-widest mb-2.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Score Formula (Weighted)</p>
                      <div className="flex gap-1 h-4 rounded-full overflow-hidden">
                        {[
                          { label: 'Attend', pct: Math.round(contribAttendance), max: 25, color: COLORS.deepBlue },
                          { label: 'Hours',  pct: Math.round(contribHours),      max: 20, color: COLORS.mediumBlue },
                          { label: 'Tasks',  pct: Math.round(contribTaskComplete),max: 25, color: COLORS.emeraldGreen },
                          { label: 'On-Time',pct: Math.round(contribOntime),     max: 15, color: COLORS.amber },
                          { label: 'Timely', pct: Math.round(contribTimely),     max: 15, color: COLORS.coral },
                        ].map(({ label, pct, max, color }) => (
                          <div key={label} className="flex flex-col items-center" style={{ flex: max }}>
                            <div className="w-full h-full rounded-sm overflow-hidden" style={{ background: isDark ? '#334155' : '#e2e8f0' }}>
                              <motion.div
                                className="h-full"
                                style={{ background: color }}
                                initial={{ width: 0 }}
                                animate={{ width: `${(pct / max) * 100}%` }}
                                transition={{ duration: 0.8, ease: 'easeOut' }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-1 mt-1.5">
                        {[
                          { label: 'Attend 25%', color: COLORS.deepBlue, val: contribAttendance },
                          { label: 'Hours 20%',  color: COLORS.mediumBlue, val: contribHours      },
                          { label: 'Tasks 25%',  color: COLORS.emeraldGreen, val: contribTaskComplete},
                          { label: 'On-Time 15%',color: COLORS.amber, val: contribOntime     },
                          { label: 'Timely 15%', color: COLORS.coral, val: contribTimely     },
                        ].map(({ label, color, val }) => (
                          <div key={label} className="flex flex-col items-center" style={{ flex: 1 }}>
                            <span className="text-[9px] font-black" style={{ color }}>{val.toFixed(1)}pts</span>
                            <span className={`text-[8px] text-center leading-tight ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Tips list — sorted weakest first */}
                  <div className="px-6 pb-6 flex flex-col gap-2.5 overflow-y-auto">
                    {components.map(({ key, label, pct, weight, contrib }, idx) => {
                      const gap = weight - contrib;
                      const tips = tipsByComponent[key] || [];
                      const isWeak = gap > weight * 0.4;
                      const qColor = contrib >= weight * 0.8 ? COLORS.emeraldGreen : contrib >= weight * 0.5 ? COLORS.amber : COLORS.coral;
                      const isFocused = focusedMetric === key;
                      return (
                        <motion.div
                          key={key}
                          id={`score-metric-${key}`}
                          className={`rounded-xl border p-3.5 transition-shadow ${isDark ? 'bg-slate-900/30 border-slate-700' : 'bg-slate-50 border-slate-100'} ${isFocused ? 'ring-2' : ''}`}
                          style={isFocused ? { boxShadow: `0 0 0 2px ${COLORS.mediumBlue}` } : undefined}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.07 }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5">
                              {isWeak && (
                                <span className="text-[9px] font-black px-1.5 py-px rounded-full" style={{ background: `${COLORS.coral}18`, color: COLORS.coral }}>
                                  IMPROVE
                                </span>
                              )}
                              <span className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{pct.toFixed(1)}%</span>
                              <span className="text-[10px] font-black" style={{ color: qColor }}>
                                {contrib.toFixed(1)}/{weight}pts
                              </span>
                            </div>
                          </div>
                          {/* Mini bar */}
                          <div className={`h-1.5 rounded-full overflow-hidden mb-2.5 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                            <div className="h-full rounded-full transition-all" style={{ width: `${Math.min((contrib / weight) * 100, 100)}%`, background: qColor }} />
                          </div>
                          <ul className="flex flex-col gap-1.5">
                            {tips.map((tip, ti) => (
                              <li key={ti} className="flex items-start gap-1.5">
                                <span className="text-[9px] mt-0.5 flex-shrink-0" style={{ color: COLORS.mediumBlue }}>▸</span>
                                <span className={`text-[10.5px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{tip}</span>
                              </li>
                            ))}
                          </ul>
                        </motion.div>
                      );
                    })}

                    {/* Badge targets */}
                    <div className={`rounded-xl border p-3.5 ${isDark ? 'bg-slate-900/30 border-slate-700' : 'bg-blue-50/60 border-blue-100'}`}>
                      <p className={`text-[11px] font-black mb-2 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>🏅 Badge Thresholds</p>
                      {[
                        { badge: 'Good Performer', min: 0,  max: 84,  color: COLORS.amber },
                        { badge: 'Top Performer',  min: 85, max: 94,  color: COLORS.mediumBlue },
                        { badge: 'Star Performer', min: 95, max: 100, color: COLORS.emeraldGreen },
                      ].map(({ badge, min, max, color }) => (
                        <div key={badge} className="flex items-center gap-2 mb-1.5 last:mb-0">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                          <span className={`text-[10.5px] font-semibold flex-1 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{badge}</span>
                          <span className="text-[10.5px] font-black" style={{ color }}>{min}–{max} pts</span>
                          {displayScore >= min && displayScore <= max && (
                            <span className="text-[9px] font-black px-1.5 py-px rounded-full" style={{ background: color, color: 'white' }}>YOU</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>


          <motion.div variants={itemVariants}>
            {/* ── Compact Score Card — limited, app-palette design ── */}
            {(() => {
              // Every color used below comes from the app's own COLORS palette
              // (deepBlue/mediumBlue = brand chrome, emerald/amber/coral = the
              // ONLY three colors used to signal quality — good/fair/needs work).
              // No arbitrary indigo/purple/cyan hues.
              const hoursWhole = Math.floor(apiHours);
              const hoursMins  = Math.round((apiHours - hoursWhole) * 60);
              const productivityVal = (taskCompletionVal + onTimeVal) / 2;

              const kpiTiles = [
                {
                  key: 'score', label: 'Overall Score', icon: Star, color: scoreColor,
                  big: `${Number(displayScore).toFixed(0)}`, unit: '/100',
                  sub: <span className="text-[9px] font-bold px-1.5 py-[1px] rounded-full" style={{ color: badgeColor, background: `${badgeColor}18` }}>{displayBadge}</span>,
                },
                {
                  key: 'tasks', label: 'Tasks', icon: ClipboardList, color: COLORS.mediumBlue,
                  big: `${myTotal}`, unit: '',
                  sub: <span className={`text-[9px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}><span className="font-bold" style={{ color: COLORS.emeraldGreen }}>{myCompleted} Done</span> · <span className="font-bold" style={{ color: COLORS.amber }}>{myPending} Pending</span></span>,
                },
                {
                  key: 'hours', label: 'Work Hours', icon: Clock, color: qColor(hoursRatioPct),
                  big: `${hoursWhole}h ${hoursMins}m`, unit: '',
                  sub: <span className={`text-[9px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{hoursRatioPct.toFixed(0)}% of {MONTHLY_HOURS_TARGET}h{bonusPoints > 0 ? <span className="font-bold" style={{ color: COLORS.emeraldGreen }}> · +{bonusPoints.toFixed(1)} bonus</span> : ''}</span>,
                },
                {
                  key: 'attendance', label: 'Attendance', icon: CheckCircle2, color: qColor(apiAttendance ?? 0),
                  big: `${(apiAttendance ?? 0).toFixed(0)}%`, unit: '',
                  sub: <span className={`text-[9px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{(apiAttendance ?? 0) >= 90 ? 'On Track' : (apiAttendance ?? 0) >= 75 ? 'Fair' : 'Needs Attention'}</span>,
                },
                {
                  key: 'productivity', label: 'Productivity', icon: TrendingUp, color: qColor(productivityVal),
                  big: `${productivityVal.toFixed(0)}%`, unit: '',
                  sub: <span className={`text-[9px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Tasks + on-time avg</span>,
                },
              ];

              return (
            <div
              className={`rounded-2xl border overflow-hidden ${isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200'}`}
              style={{ boxShadow: `0 4px 24px ${COLORS.mediumBlue}14, 0 1px 3px rgba(0,0,0,0.05)` }}
            >
              {/* Top accent bar — same gradient as app loader / welcome banner */}
              <motion.div className="h-[3px] w-full" style={{ background: `linear-gradient(90deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue}, ${COLORS.emeraldGreen})` }}
                initial={{ scaleX: 0, originX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} />

              {/* Card header */}
              <div className={`flex items-center justify-between px-3 sm:px-4 py-2 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                    <Trophy className="h-3 w-3 text-white" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h3 className={`text-sm font-bold leading-tight truncate ${isDark ? 'text-white' : 'text-slate-800'}`}>Score Card</h3>
                      <Info className={`h-3 w-3 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                    </div>
                    <p className={`text-[10px] leading-tight truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Real-time overview of your performance</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`hidden sm:inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-lg border ${isDark ? 'bg-slate-900/40 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <CalendarIcon className="h-3 w-3" />
                    {format(new Date(), 'dd MMM yyyy')}
                  </span>
                </div>
              </div>

              {/* ── KPI STRIP — 6 compact tiles ── */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 px-3 sm:px-4 pt-2">
                {kpiTiles.map((tile, i) => {
                  const Icon = tile.icon;
                  return (
                    <motion.div
                      key={tile.key}
                      className={`rounded-lg border px-2 py-1.5 flex flex-col gap-0.5 min-w-0 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-white border-slate-100'}`}
                      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                    >
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: `${tile.color}16` }}>
                          <Icon className="h-2.5 w-2.5" style={{ color: tile.color }} />
                        </div>
                        <span className={`text-[9.5px] font-semibold uppercase tracking-wide truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{tile.label}</span>
                      </div>
                      <div className="flex items-baseline gap-0.5">
                        <span className="text-base font-black tabular-nums leading-none" style={{ color: tile.color }}>{tile.big}</span>
                        {tile.unit && <span className={`text-[10px] font-semibold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{tile.unit}</span>}
                      </div>
                      <div className="truncate">{tile.sub}</div>
                    </motion.div>
                  );
                })}
              </div>

              {/* ── MAIN: breakdown (left) + gauge/composition (right) ── */}
              <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-2 px-3 sm:px-4 py-2">

                {/* LEFT — Score Breakdown */}
                <div className={`rounded-lg border p-2 flex flex-col gap-1.5 ${isDark ? 'bg-slate-900/30 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-[11px] font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Score Breakdown</span>
                    <span className={`text-[9px] font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>earned / max</span>
                  </div>

                  <div className="grid grid-cols-2 grid-flow-col grid-rows-3 gap-x-3 gap-y-0.5">
                    {components.map(({ key, label, contrib, weight }) => {
                      const iconMap = { attendance: CheckCircle2, hours: Clock, tasks: ClipboardList, ontime: Clock, punchin: Target };
                      const Icon = iconMap[key] || CheckCircle2;
                      const pct = Math.min(100, (contrib / weight) * 100);
                      const color = qColor(pct);
                      const ringR = 10, ringC = 2 * Math.PI * ringR;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => { setFocusedMetric(key); setShowTips(true); }}
                          className={`flex items-center gap-2 w-full text-left rounded-lg px-1.5 py-0.5 -mx-1.5 transition-colors ${isDark ? 'hover:bg-slate-800/70 active:bg-slate-800' : 'hover:bg-white active:bg-slate-100'}`}
                          title={`View details for ${label}`}
                        >
                          {/* Graphical radial-progress ring with icon at center, replaces the old flat bar */}
                          <div className="relative w-6 h-6 flex-shrink-0">
                            <svg viewBox="0 0 24 24" width="24" height="24" className="-rotate-90">
                              <circle cx="12" cy="12" r={ringR} fill="none" stroke={isDark ? '#334155' : '#e2e8f0'} strokeWidth="2.5" />
                              <motion.circle cx="12" cy="12" r={ringR} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
                                style={{ strokeDasharray: ringC }}
                                initial={{ strokeDashoffset: ringC }}
                                animate={{ strokeDashoffset: ringC - (ringC * pct) / 100 }}
                                transition={{ duration: 0.9, ease: 'easeOut' }} />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Icon className="h-2.5 w-2.5" style={{ color }} />
                            </div>
                          </div>
                          <span className={`text-[10px] font-medium flex-1 min-w-0 truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{label}</span>
                          <span className="text-[10px] font-black tabular-nums flex-shrink-0" style={{ color }}>{contrib.toFixed(1)}/{weight}</span>
                          <ChevronRight className={`h-3 w-3 flex-shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
                        </button>
                      );
                    })}
                  </div>

                  {bonusPoints > 0 && (
                    <div className="flex items-center justify-between rounded-md px-2 py-1"
                      style={{ background: `${COLORS.emeraldGreen}12` }}>
                      <span className="text-[10px] font-semibold" style={{ color: COLORS.emeraldGreen }}>
                        Bonus (extra {extraHours.toFixed(1)}h)
                      </span>
                      <span className="text-[10.5px] font-black tabular-nums" style={{ color: COLORS.emeraldGreen }}>
                        +{bonusPoints.toFixed(1)} pts
                      </span>
                    </div>
                  )}
                </div>

                {/* RIGHT — Single Overall Score gauge + Rank + Next Rank */}
                <div className={`rounded-lg border p-2 flex flex-col gap-1.5 ${isDark ? 'bg-slate-900/30 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                  <span className={`text-[11px] font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Overall Score</span>

                  {/* Half-dial gauge — the ONLY overall-score gauge in the card */}
                  <div className="flex flex-col items-center">
                    <div className="relative" style={{ width: 108, height: 62 }}>
                      <svg viewBox="0 0 200 112" width="108" height="62">
                        <path d="M 22 96 A 78 78 0 0 1 178 96" fill="none" stroke={isDark ? '#1e293b' : '#eef1f5'} strokeWidth="12" strokeLinecap="round" />
                        <motion.path d="M 22 96 A 78 78 0 0 1 178 96" fill="none"
                          stroke={scoreColor} strokeWidth="12" strokeLinecap="round"
                          style={{ strokeDasharray: 245.1 }}
                          initial={{ strokeDashoffset: 245.1 }}
                          animate={{ strokeDashoffset: 245.1 - (245.1 * Math.min(Math.max(displayScore, 0), 100)) / 100 }}
                          transition={{ duration: 1, ease: 'easeOut', delay: 0.1 }} />
                        {[0, 50, 100].map((v) => {
                          const angle = Math.PI * (v / 100);
                          const cx = 100, cy = 96, r = 78;
                          const x1 = cx - Math.cos(angle) * (r - 8), y1 = cy - Math.sin(angle) * (r - 8);
                          const x2 = cx - Math.cos(angle) * (r + 8), y2 = cy - Math.sin(angle) * (r + 8);
                          return <line key={v} x1={x1} y1={y1} x2={x2} y2={y2} stroke={isDark ? '#475569' : '#cbd5e1'} strokeWidth="1.5" strokeLinecap="round" />;
                        })}
                      </svg>
                      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
                        <motion.span className="text-xl font-black leading-none tabular-nums tracking-tight"
                          style={{ color: scoreColor }}
                          initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.3, duration: 0.4 }}>
                          {Number(displayScore).toFixed(0)}
                        </motion.span>
                        <span className={`text-[7px] font-semibold tracking-widest uppercase ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>out of 100</span>
                      </div>
                    </div>
                  </div>

                  {/* Rank */}
                  <div className={`rounded-md border px-2 py-1 flex items-center gap-2 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-white border-slate-100'}`}>
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${COLORS.mediumBlue}16` }}>
                      {apiRank === 1 ? <Crown className="h-3 w-3" style={{ color: COLORS.amber }} /> : <Trophy className="h-3 w-3" style={{ color: COLORS.mediumBlue }} />}
                    </div>
                    <span className={`text-[9.5px] font-semibold uppercase tracking-wide flex-1 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Rank</span>
                    <span className="text-[12px] font-black tabular-nums" style={{ color: COLORS.mediumBlue }}>
                      {apiRank !== null ? `#${apiRank}` : '—'}{totalUsers ? <span className={`text-[9px] font-semibold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>/{totalUsers}</span> : null}
                    </span>
                  </div>

                  {/* Next Rank */}
                  <div className={`rounded-md border px-2 py-1 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-white border-slate-100'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-[9.5px] font-semibold uppercase tracking-wide truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Next: {nextBadge ? nextBadge.split(' (')[0] : 'Top Tier'}
                      </span>
                      <span className="text-[10px] font-black tabular-nums" style={{ color: scoreColor }}>
                        {nextBadge ? `${Number(ptsToNext ?? 0).toFixed(1)} pts` : 'Reached 🎉'}
                      </span>
                    </div>
                    <div className={`h-1.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                      <motion.div className="h-full rounded-full" style={{ background: scoreColor }}
                        initial={{ width: 0 }} animate={{ width: `${Math.min(100, (displayScore / (displayScore >= 85 ? 95 : 85)) * 100)}%` }}
                        transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }} />
                    </div>
                  </div>
                </div>
              </div>

              {/* ── BOTTOM STRIP — Rank · Daily Pace · Consistency + View Tips ── */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 px-3 sm:px-4 pb-3">
                {/* Rank */}
                <div className={`rounded-lg border px-2 py-1.5 flex items-center gap-2 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-white border-slate-100'}`}>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${COLORS.mediumBlue}16` }}>
                    {apiRank === 1 ? <Crown className="h-3 w-3" style={{ color: COLORS.amber }} /> : <Trophy className="h-3 w-3" style={{ color: COLORS.mediumBlue }} />}
                  </div>
                  <div className="min-w-0">
                    <p className={`text-[9px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Rank</p>
                    <p className="text-[12px] font-black tabular-nums leading-tight" style={{ color: COLORS.mediumBlue }}>
                      {apiRank !== null ? `#${apiRank}` : '—'}{totalUsers ? <span className={`text-[9px] font-semibold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}> /{totalUsers}</span> : null}
                    </p>
                  </div>
                </div>

                {/* Daily Pace */}
                <div className={`rounded-lg border px-2 py-1.5 flex items-center gap-2 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-white border-slate-100'}`}>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${COLORS.amber}16` }}>
                    <Zap className="h-3 w-3" style={{ color: COLORS.amber }} />
                  </div>
                  <div className="min-w-0">
                    <p className={`text-[9px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Daily Pace</p>
                    <p className="text-[12px] font-black tabular-nums leading-tight" style={{ color: COLORS.amber }}>
                      {myPending > 0 ? `${dailyTarget}/day` : 'All clear 🎉'}
                    </p>
                  </div>
                </div>

                {/* Consistency + View Tips */}
                <div className={`rounded-lg border px-2 py-1.5 flex items-center gap-2 ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[9px] font-semibold uppercase tracking-wide truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Consistency</p>
                    <p className={`text-[10px] leading-tight truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {topGapComponent ? `Gap: ${topGapComponent.label}` : 'On track'}
                    </p>
                  </div>
                  <button onClick={() => { setFocusedMetric(null); setShowTips(true); }}
                    className="text-[10px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 whitespace-nowrap text-white"
                    style={{ background: COLORS.mediumBlue }}>
                    View Tips
                  </button>
                </div>
              </div>
            </div>
            );
            })()}
          </motion.div>
          </>
        );
      })()}
      {/* ── TOOLBAR — 2 rows, equal-width buttons, no scroll ──────────── */}
      <motion.div variants={itemVariants}
        className={`border rounded-2xl px-3 py-2.5 shadow-sm space-y-2 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>

        {/* ── ROW 1: Search + 5 filter dropdowns + view toggle ── */}
        <div className="flex items-center gap-2">

          {/* Search — wider, takes flex-[2] */}
          <div className="relative flex-[2] min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <Input
              placeholder="Search by title or description…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`pl-8 pr-7 h-8 text-xs rounded-lg w-full ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-400' : 'bg-slate-50 border-slate-200'}`}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Status — flex-1 each so all 5 dropdowns share remaining space equally */}
          <div className="flex-1 min-w-0">
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className={`h-8 w-full text-[11px] rounded-lg ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200'}`}>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">To Do</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 min-w-0">
            <Select value={filterPriority} onValueChange={setFilterPriority}>
              <SelectTrigger className={`h-8 w-full text-[11px] rounded-lg ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200'}`}>
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priorities</SelectItem>
                <SelectItem value="high">🔴 High Priority</SelectItem>
                <SelectItem value="medium">🟡 Medium Priority</SelectItem>
                <SelectItem value="low">🟢 Low Priority</SelectItem>
                <SelectItem value="critical">🚨 Critical Priority</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 min-w-0 relative">
            {/* Multi-select Dept dropdown */}
            {(() => {
              // OLD nested-hook implementation retained as comments for code preservation:
              // const [open, setOpen] = React.useState(false);
              // const ref = React.useRef(null);
              // React.useEffect(() => {
              //   const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
              //   document.addEventListener('mousedown', handler);
              //   return () => document.removeEventListener('mousedown', handler);
              // }, []);
              // FIXED: hooks now live at Tasks component level.
              const open = departmentFilterOpen;
              const setOpen = setDepartmentFilterOpen;
              const ref = departmentFilterRef;
              const toggleVal = (val) => {
                setFilterCategory(prev => prev.includes(val) ? prev.filter(v => v !== val) : prev.length < 2 ? [...prev, val] : prev);
              };
              const label = filterCategory.length === 0 ? 'All Depts' : filterCategory.map(getCategoryLabel).join(' + ');
              return (
                <div ref={ref} className="relative w-full">
                  <button type="button" onClick={() => setOpen(o => !o)}
                    className={`h-8 w-full text-[11px] rounded-lg border px-2.5 flex items-center justify-between gap-1 transition-colors
                      ${filterCategory.length > 0 ? 'border-blue-400 bg-blue-50 text-blue-700 font-semibold' : (isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-700')}`}>
                    <span className="truncate">{label}</span>
                    <svg className="h-3.5 w-3.5 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  {open && (
                    <div className={`absolute z-50 top-full left-0 mt-1 w-48 rounded-xl border shadow-xl overflow-hidden ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
                      <div className="p-1.5 border-b border-slate-100 dark:border-slate-700">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1">Select up to 2</p>
                      </div>
                      <div className="py-1 max-h-52 overflow-y-auto">
                        {TASK_CATEGORIES.map(c => {
                          const sel = filterCategory.includes(c.value);
                          const disabled = !sel && filterCategory.length >= 2;
                          return (
                            <button key={c.value} type="button"
                              onClick={() => !disabled && toggleVal(c.value)}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors text-left
                                ${sel ? 'bg-blue-50 text-blue-700 font-semibold' : disabled ? 'opacity-40 cursor-not-allowed text-slate-400' : (isDark ? 'text-slate-200 hover:bg-slate-700' : 'text-slate-700 hover:bg-slate-50')}`}>
                              <span className={`w-3.5 h-3.5 rounded flex-shrink-0 border flex items-center justify-center ${sel ? 'bg-blue-600 border-blue-600' : 'border-slate-300'}`}>
                                {sel && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                              </span>
                              {c.label}
                            </button>
                          );
                        })}
                      </div>
                      {filterCategory.length > 0 && (
                        <div className="p-1.5 border-t border-slate-100 dark:border-slate-700">
                          <button type="button" onClick={() => { setFilterCategory([]); setOpen(false); }}
                            className="w-full text-[10px] text-red-500 hover:text-red-700 font-semibold py-1">Clear</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="flex-1 min-w-0 relative">
            {/* Multi-select Assignee dropdown */}
            {(() => {
              // OLD nested-hook implementation retained as comments for code preservation:
              // const [open, setOpen] = React.useState(false);
              // const ref = React.useRef(null);
              // React.useEffect(() => {
              //   const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
              //   document.addEventListener('mousedown', handler);
              //   return () => document.removeEventListener('mousedown', handler);
              // }, []);
              // FIXED: hooks now live at Tasks component level.
              const open = assigneeFilterOpen;
              const setOpen = setAssigneeFilterOpen;
              const ref = assigneeFilterRef;
              const toggleVal = (val) => {
                setFilterAssignee(prev => prev.includes(val) ? prev.filter(v => v !== val) : prev.length < 2 ? [...prev, val] : prev);
              };
              const label = filterAssignee.length === 0 ? 'All Assignees' : filterAssignee.map(id => userMap.get(id)?.full_name?.split(' ')[0] || id).join(' + ');
              return (
                <div ref={ref} className="relative w-full">
                  <button type="button" onClick={() => setOpen(o => !o)}
                    className={`h-8 w-full text-[11px] rounded-lg border px-2.5 flex items-center justify-between gap-1 transition-colors
                      ${filterAssignee.length > 0 ? 'border-blue-400 bg-blue-50 text-blue-700 font-semibold' : (isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-700')}`}>
                    <span className="truncate">{label}</span>
                    <svg className="h-3.5 w-3.5 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  {open && (
                    <div className={`absolute z-50 top-full left-0 mt-1 w-52 rounded-xl border shadow-xl overflow-hidden ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
                      <div className="p-1.5 border-b border-slate-100 dark:border-slate-700">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1">Select up to 2</p>
                      </div>
                      <div className="py-1 max-h-52 overflow-y-auto">
                        {visibleUsers.map(u => {
                          const sel = filterAssignee.includes(u.id);
                          const disabled = !sel && filterAssignee.length >= 2;
                          return (
                            <button key={u.id} type="button"
                              onClick={() => !disabled && toggleVal(u.id)}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors text-left
                                ${sel ? 'bg-blue-50 text-blue-700 font-semibold' : disabled ? 'opacity-40 cursor-not-allowed text-slate-400' : (isDark ? 'text-slate-200 hover:bg-slate-700' : 'text-slate-700 hover:bg-slate-50')}`}>
                              <span className={`w-3.5 h-3.5 rounded flex-shrink-0 border flex items-center justify-center ${sel ? 'bg-blue-600 border-blue-600' : 'border-slate-300'}`}>
                                {sel && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                              </span>
                              {u.full_name}
                            </button>
                          );
                        })}
                      </div>
                      {filterAssignee.length > 0 && (
                        <div className="p-1.5 border-t border-slate-100 dark:border-slate-700">
                          <button type="button" onClick={() => { setFilterAssignee([]); setOpen(false); }}
                            className="w-full text-[10px] text-red-500 hover:text-red-700 font-semibold py-1">Clear</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="flex-1 min-w-0">
            <Select value={`${sortBy}-${sortDirection}`} onValueChange={(v) => { const [sb, sd] = v.split('-'); setSortBy(sb); setSortDirection(sd); }}>
              <SelectTrigger className={`h-8 w-full text-[11px] rounded-lg ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200'}`}>
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="due_date-asc">Due Date ↑</SelectItem>
                <SelectItem value="due_date-desc">Due Date ↓</SelectItem>
                <SelectItem value="created_date-asc">Created ↑</SelectItem>
                <SelectItem value="created_date-desc">Created ↓</SelectItem>
                <SelectItem value="priority-desc">Priority ↓</SelectItem>
                <SelectItem value="title-asc">Title A-Z</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* View toggle — right-aligned */}
          <div className={`flex p-0.5 rounded-lg shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
            <button onClick={() => setViewMode('list')}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${viewMode === 'list' ? (isDark ? 'bg-slate-600 shadow-sm text-slate-100' : 'bg-white shadow-sm text-slate-800') : 'text-slate-500 hover:text-slate-700'}`}>
              <List className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setViewMode('board')}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${viewMode === 'board' ? (isDark ? 'bg-slate-600 shadow-sm text-slate-100' : 'bg-white shadow-sm text-slate-800') : 'text-slate-500 hover:text-slate-700'}`}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ── Thin divider between rows ── */}
        <div className={`h-px w-full ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`} />

        {/* ── ROW 2: Creator + New Today + Pending + AI Tools — all equal flex-1 ── */}
        <div className="flex items-center gap-2">

          {/* Creator / Assigned By — flex-1 */}
          <div className="flex-1 min-w-0">
            <Select
              value={filterCreatedBy !== 'all' ? filterCreatedBy : (filterAssignedByMe ? '__me__' : 'all')}
              onValueChange={(v) => {
                if (v === '__me__') {
                  setFilterAssignedByMe(true); setFilterCreatedBy('all');
                  setShowMyTasksOnly(false); setFilterTeamOnly(false); setFilterAssignee([]);
                } else {
                  setFilterAssignedByMe(false); setFilterCreatedBy(v);
                  if (v !== 'all') { setShowMyTasksOnly(false); setFilterTeamOnly(false); }
                }
              }}
            >
              <SelectTrigger className={`h-8 w-full text-[11px] rounded-lg transition-all ${
                (filterCreatedBy !== 'all' || filterAssignedByMe)
                  ? (isDark ? 'bg-purple-900/40 border-purple-500 text-purple-300' : 'bg-purple-50 border-purple-400 text-purple-700')
                  : (isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-50 border-slate-200')
              }`}>
                <div className="flex items-center gap-1 min-w-0">
                  <User className="h-3 w-3 flex-shrink-0" />
                  <SelectValue placeholder="All Creators" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Creators</SelectItem>
                <SelectItem value="__me__">Assigned by Me</SelectItem>
                {visibleCreators.filter(u => u.id !== user?.id).map(u => (
                  <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* New Today — flex-1, equal width */}
          <button
            onClick={() => { setFilterTodayNew(p => !p); if (filterPending) setFilterPending(false); }}
            title={isAdmin
              ? filterAssignee.length === 0 ? 'Show tasks created today across all users' : 'Show tasks created today for selected user'
              : 'Show your tasks created today'}
            className={`flex-1 h-8 text-[11px] font-semibold rounded-lg border transition-all flex items-center justify-center gap-1.5 min-w-0
              ${filterTodayNew
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/30'
                : (isDark
                    ? 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-indigo-900/40 hover:border-indigo-500 hover:text-indigo-300'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700')
              }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            New Today
            {filterTodayNew && <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white/25 text-[9px] font-black leading-none">✓</span>}
          </button>

          {/* Pending — flex-1, equal width */}
          <button
            onClick={() => { setFilterPending(p => !p); if (filterTodayNew) setFilterTodayNew(false); }}
            title={isAdmin
              ? filterAssignee.length === 0 ? 'Show all pending tasks across all users' : 'Show pending tasks for selected user'
              : 'Show your pending (incomplete) tasks'}
            className={`flex-1 h-8 text-[11px] font-semibold rounded-lg border transition-all flex items-center justify-center gap-1.5 min-w-0
              ${filterPending
                ? 'bg-amber-500 text-white border-amber-500 shadow-sm shadow-amber-400/30'
                : (isDark
                    ? 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-amber-900/40 hover:border-amber-500 hover:text-amber-300'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700')
              }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Pending
            {filterPending && <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white/25 text-[9px] font-black leading-none">✓</span>}
          </button>

          {/* AI provider tabs + Scan — flex-[3] so it gets 3x the space of other flex-1 items */}
          <div className={`flex-[3] flex items-center rounded-lg border overflow-hidden min-w-0 ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
            {/* Gemini */}
            <button onClick={() => setAiProvider('gemini')} title="Use Google Gemini AI"
              className={`flex-1 h-8 text-[10px] font-bold border-r transition-all flex items-center justify-center gap-0.5 min-w-0
                ${aiProvider === 'gemini' ? 'bg-violet-600 text-white border-violet-600'
                  : (isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:bg-violet-900/30 hover:text-violet-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-violet-50 hover:text-violet-700')}`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/></svg>
              <span className="truncate">Gemini</span>
            </button>
            {/* Grok */}
            <button onClick={() => setAiProvider('grok')} title="Use xAI Grok"
              className={`flex-1 h-8 text-[10px] font-bold border-r transition-all flex items-center justify-center gap-0.5 min-w-0
                ${aiProvider === 'grok' ? 'bg-orange-500 text-white border-orange-500'
                  : (isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:bg-orange-900/30 hover:text-orange-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-orange-50 hover:text-orange-600')}`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span className="truncate">Grok</span>
            </button>
            {/* Local */}
            <button onClick={() => setAiProvider('local')} title="Use local browser algorithm (offline)"
              className={`flex-1 h-8 text-[10px] font-bold border-r transition-all flex items-center justify-center gap-0.5 min-w-0
                ${aiProvider === 'local' ? 'bg-slate-600 text-white border-slate-600'
                  : (isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:bg-slate-600 hover:text-slate-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-100 hover:text-slate-700')}`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span className="truncate">Local</span>
            </button>
            {/* Auto */}
            <button onClick={() => setAiProvider('auto')} title="Auto: tries Gemini → Grok → Local"
              className={`flex-1 h-8 text-[10px] font-bold border-r transition-all flex items-center justify-center min-w-0
                ${aiProvider === 'auto' ? 'bg-emerald-500 text-white border-emerald-500'
                  : (isDark ? 'bg-slate-700 text-slate-400 border-slate-600 hover:bg-emerald-900/30 hover:text-emerald-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-emerald-50 hover:text-emerald-600')}`}>
              <span className="truncate">Auto</span>
            </button>
            {/* Scan */}
            <button onClick={handleDetectDuplicates} disabled={detectingDuplicates}
              className={`flex-1 h-8 text-[10px] font-bold transition-all flex items-center justify-center gap-1 min-w-0
                ${aiProvider === 'gemini' ? (detectingDuplicates ? 'bg-violet-400 text-white' : 'bg-violet-600 hover:bg-violet-700 text-white') :
                  aiProvider === 'grok'   ? (detectingDuplicates ? 'bg-orange-400 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white') :
                  aiProvider === 'local'  ? (detectingDuplicates ? 'bg-slate-400 text-white'  : 'bg-slate-600 hover:bg-slate-700 text-white')  :
                                            (detectingDuplicates ? 'bg-emerald-400 text-white': 'bg-emerald-500 hover:bg-emerald-600 text-white')}`}>
              {detectingDuplicates
                ? <><Loader2 className="h-3 w-3 animate-spin shrink-0" /><span className="truncate">Scanning…</span></>
                : <><Sparkles className="h-3 w-3 shrink-0" /><span className="truncate">Scan</span></>}
            </button>
          </div>

          {/* Scan progress (only while scanning) */}
          {detectingDuplicates && (
            <div className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border min-w-[140px] shrink-0 ${
              isDark ? 'bg-slate-800 border-slate-600 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
            }`}>
              <Loader2 className="h-3 w-3 animate-spin shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-medium truncate">{scanStatus || 'Scanning…'}</div>
                <div className={`mt-0.5 h-1 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                  <div className={`h-full transition-all duration-200 ${
                    aiProvider === 'gemini' ? 'bg-violet-500' : aiProvider === 'grok' ? 'bg-orange-500' :
                    aiProvider === 'local'  ? 'bg-slate-500'  : 'bg-emerald-500'}`}
                    style={{ width: `${Math.max(2, Math.min(100, scanProgress))}%` }} />
                </div>
              </div>
              <span className="text-[10px] font-bold tabular-nums shrink-0">{scanProgress}%</span>
              <button type="button" onClick={cancelScan} title="Cancel scan"
                className={`shrink-0 inline-flex items-center justify-center h-4 w-4 rounded transition-colors ${
                  isDark ? 'text-slate-400 hover:text-white hover:bg-red-600/70' : 'text-slate-500 hover:text-white hover:bg-red-500'}`}>
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          )}
        </div>
      </motion.div>

      {/* ── Recent Scan History ──────────────────────────────────────────── */}
      <AnimatePresence>
        {scanHistory.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className={`rounded-xl border px-3 py-2 ${
              isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <Clock className={`h-3 w-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
                <span className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Recent Scans
                </span>
              </div>
              <button
                type="button"
                onClick={() => setScanHistory([])}
                title="Clear history"
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                  isDark
                    ? 'text-slate-400 hover:text-white hover:bg-slate-700'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                }`}
              >
                Clear
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {scanHistory.map(h => {
                const providerStyle =
                  h.provider === 'gemini' ? { dot: 'bg-violet-500',  badge: isDark ? 'bg-violet-900/40 text-violet-300' : 'bg-violet-50 text-violet-700',  name: 'Gemini' } :
                  h.provider === 'grok'   ? { dot: 'bg-orange-500',  badge: isDark ? 'bg-orange-900/40 text-orange-300' : 'bg-orange-50 text-orange-700',  name: 'Grok' }   :
                  h.provider === 'local'  ? { dot: 'bg-slate-500',   badge: isDark ? 'bg-slate-700 text-slate-200'      : 'bg-slate-100 text-slate-700',   name: 'Local' }  :
                                            { dot: 'bg-emerald-500', badge: isDark ? 'bg-emerald-900/40 text-emerald-300': 'bg-emerald-50 text-emerald-700', name: 'Auto' };
                const when = format(new Date(h.at), 'HH:mm:ss');
                const seconds = (h.durationMs / 1000).toFixed(1);
                const resultText = h.groupCount === 0
                  ? 'no duplicates'
                  : `${h.groupCount} group${h.groupCount !== 1 ? 's' : ''} · ${h.taskCount} task${h.taskCount !== 1 ? 's' : ''}`;
                return (
                  <li
                    key={h.id}
                    className={`flex items-center gap-2 text-[11px] py-1 px-2 rounded-lg ${
                      isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${providerStyle.dot}`} />
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${providerStyle.badge}`}>
                      {providerStyle.name}
                    </span>
                    <span className={`font-mono shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {when}
                    </span>
                    <span className={`flex-1 truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      Scanned {h.scannedCount} task{h.scannedCount !== 1 ? 's' : ''} —{' '}
                      <span className={h.groupCount === 0 ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : (isDark ? 'text-amber-300' : 'text-amber-600')}>
                        {resultText}
                      </span>
                    </span>
                    <span className={`shrink-0 tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {seconds}s
                    </span>
                    {h.groupCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowDuplicateDialog(true)}
                        title="Reopen results"
                        className={`shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-md transition-colors ${
                          isDark ? 'text-slate-400 hover:text-white hover:bg-slate-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'
                        }`}
                      >
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Active Filter Pills ──────────────────────────────────────────── */}
      <AnimatePresence>
        {activeFilters.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            className="flex flex-wrap gap-1.5 items-center">
            {activeFilters.map(pill => (
              <button key={pill.key} onClick={() => removeFilter(pill.key)}
                className="flex items-center gap-1 text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-full hover:bg-blue-100 transition-colors">
                {pill.label} <X className="h-3 w-3 ml-0.5" />
              </button>
            ))}
            <button onClick={clearAllFilters} className="text-[11px] font-medium text-slate-400 hover:text-slate-600 px-2 py-1 transition-colors">Clear all</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bulk popup action bar ────────────────────────────────────────── */}
      <AnimatePresence>
        {selectMode && selectedTaskIds.size > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border mb-2
              ${isDark ? 'bg-rose-950/40 border-rose-800' : 'bg-rose-50 border-rose-200'}`}>
            <span className={`text-sm font-semibold flex items-center gap-1.5 ${isDark ? 'text-rose-200' : 'text-rose-700'}`}>
              <BellRing className="h-4 w-4" /> {selectedTaskIds.size} task{selectedTaskIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setSelectedTaskIds(new Set())}
                className="h-7 text-xs rounded-lg">
                Clear
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" disabled={bulkUpdatingPriority}
                    className="h-7 text-xs rounded-lg gap-1 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                    {bulkUpdatingPriority ? <Loader2 className="h-3 w-3 animate-spin" /> : <SlidersHorizontal className="h-3 w-3" />}
                    Set Priority
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-40 p-1.5 rounded-xl shadow-lg border bg-white dark:bg-slate-800" align="end">
                  <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 text-slate-400">
                    Assign to Selected
                  </div>
                  <div className="space-y-0.5">
                    {[
                      { value: 'high', label: 'High', style: PRIORITY_STYLES.high },
                      { value: 'medium', label: 'Medium', style: PRIORITY_STYLES.medium },
                      { value: 'low', label: 'Low', style: PRIORITY_STYLES.low },
                    ].map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => handleBulkPriorityChange(p.value)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      >
                        <span className={`w-2 h-2 rounded-full ${p.style.dot}`} />
                        <span>{p.label} Priority</span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Button size="sm" onClick={handleBulkNudge} disabled={bulkNudging}
                className="h-7 text-xs rounded-lg gap-1.5 bg-rose-600 hover:bg-rose-700 text-white">
                {bulkNudging ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Sending…</> : <><BellRing className="h-3.5 w-3.5" />Send Popup to Selected</>}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── List / Board ─────────────────────────────────────────────────── */}
      <div className="overflow-y-auto max-h-[calc(100vh-360px)]">
        {viewMode === 'list' ? (
          <motion.div className="space-y-1.5" variants={containerVariants}>
            {/* ── Search Bar at top of Task List View ── */}
            <div className={`p-2 sm:p-2.5 rounded-xl border flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 transition-all ${
              isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200 shadow-xs'
            }`}>
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                <Input
                  type="text"
                  placeholder="Filter tasks by title or description in real-time…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full pl-9 pr-8 h-9 text-xs rounded-lg transition-colors ${
                    isDark
                      ? 'bg-slate-900/60 border-slate-700 text-slate-100 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-blue-500'
                      : 'bg-slate-50/80 border-slate-200 text-slate-800 placeholder:text-slate-400 focus-visible:bg-white focus-visible:ring-1 focus-visible:ring-blue-500'
                  }`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                    title="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0">
                <span className={`text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${
                  searchQuery
                    ? (isDark ? 'bg-blue-950/40 border-blue-800/60 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700 font-semibold')
                    : (isDark ? 'bg-slate-900/40 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500')
                }`}>
                  {searchQuery ? (
                    <>Found <strong>{displayTasks.length}</strong> matching</>
                  ) : (
                    <>{displayTasks.length} task{displayTasks.length === 1 ? '' : 's'}</>
                  )}
                </span>
                {searchQuery && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSearchQuery('')}
                    className="h-8 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 px-2"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                )}
              </div>
            </div>

            <div
              className={`hidden sm:grid items-center pl-5 pr-3 py-2 text-[10px] font-bold uppercase tracking-widest select-none border-b mb-1.5
                ${isDark ? 'text-slate-500 border-slate-700' : 'text-slate-400 border-slate-100'}`}
              style={{ gridTemplateColumns: '24px 24px minmax(0,1fr) 160px 88px 76px 72px 110px 110px 88px 100px' }}
            >
              {selectMode ? (
                <button
                  onClick={() => {
                    const allIds = displayTasks.map((t) => t.id);
                    const allSelected = allIds.length > 0 && allIds.every((id) => selectedTaskIds.has(id));
                    setSelectedTaskIds(allSelected ? new Set() : new Set(allIds));
                  }}
                  className="flex items-center justify-center" title="Select all">
                  {displayTasks.length > 0 && displayTasks.every((t) => selectedTaskIds.has(t.id))
                    ? <CheckSquare className="h-3.5 w-3.5 text-rose-500" />
                    : <Square className="h-3.5 w-3.5 text-slate-400" />}
                </button>
              ) : <span />}
              <span />
              <span className="pl-1">Task</span>
              <span className="text-center">Status</span>
              <span className="text-center">Dept</span>
              <span className="text-center">Priority</span>
              <span className="text-center">Overdue</span>
              <span className="text-center">Assignee</span>
              <span className="text-center">Assignor</span>
              <span className="text-center">Due</span>
              <span className="text-center">Actions</span>
            </div>

            {displayTasks.map((task, index) => {
              const taskIsOverdue = isOverdue(task);
              const displayStatus = getDisplayStatus(task);
              const statusStyle   = STATUS_STYLES[displayStatus] || STATUS_STYLES.pending;
              const priorityStyle = getPriorityStyle(task.priority);
              const stripeColor   = getStripeColor(task, taskIsOverdue);
              return (
                <TaskRow key={task.id} task={task} index={index}
                  isOverdue={taskIsOverdue} statusStyle={statusStyle} priorityStyle={priorityStyle} stripeColor={stripeColor}
                  getUserName={getUserName} getClientName={getClientName} getRelativeDueDate={getRelativeDueDate}
                  getChecklistProgress={getChecklistProgress} parseChecklist={parseChecklist}
                  taskChecklists={taskChecklists} toggleChecklistItem={toggleChecklistItem}
                  canModifyTask={canModifyTask} canDeleteTasks={canDeleteTasks}
                  handleEdit={handleEdit} handleDelete={handleDelete} handleDuplicateTask={handleDuplicateTask}
                  handleQuickStatusChange={handleQuickStatusChange}
                  handleQuickPriorityChange={handleQuickPriorityChange}
                  openTaskDetail={openTaskDetail}
                  openCommentTaskId={openCommentTaskId} setOpenCommentTaskId={setOpenCommentTaskId}
                  fetchComments={fetchComments} comments={comments[task.id] || EMPTY_ARR} newComment={newComment}
                  setNewComment={setNewComment} selectedTask={selectedTask} setSelectedTask={setSelectedTask}
                  handleAddComment={handleAddComment} user={user}
                  handleNudgeTask={handleNudgeTask} sendingNudge={sendingNudge}
                  selectMode={selectMode} selected={selectedTaskIds.has(task.id)} onToggleSelect={toggleTaskSelected}
                />
              );
            })}

            {displayTasks.length === 0 && (
              <div className="text-center py-16">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <Search className="h-5 w-5 text-slate-400" />
                </div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {searchQuery ? `No tasks match "${searchQuery}"` : 'No tasks found'}
                </p>
                <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                  {searchQuery
                    ? 'No tasks matched your title or description search query in real-time. Try different keywords or clear your search.'
                    : 'Try adjusting your filters'}
                </p>
                {searchQuery && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSearchQuery('')}
                    className="mt-3 text-xs gap-1.5 rounded-lg"
                  >
                    <X className="h-3.5 w-3.5" />
                    Clear Search
                  </Button>
                )}
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div className="grid grid-cols-1 lg:grid-cols-3 gap-5" variants={containerVariants}>
            {[
              { status: 'pending',     title: 'To Do',       color: 'text-red-600',   bg: 'bg-red-500',   count: stats.todo },
              { status: 'in_progress', title: 'In Progress', color: 'text-amber-600', bg: 'bg-amber-500', count: stats.inProgress },
              { status: 'completed',   title: 'Completed',   color: 'text-blue-600',  bg: 'bg-blue-600',  count: stats.completed },
            ].map((col) => {
              const colTasks = getBoardColumnTasks(col.status);
              return (
                <motion.div key={col.status} variants={itemVariants} className="space-y-3">
                  <div className="flex items-center gap-2 px-1">
                    <div className={`w-2.5 h-2.5 rounded-full ${col.bg}`} />
                    <h2 className={`text-sm font-bold ${col.color}`}>{col.title}</h2>
                    <span className="text-xs font-semibold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full ml-auto">{colTasks.length}</span>
                  </div>
                  <div className="space-y-3 min-h-[200px]">
                    {colTasks.map((task, index) => {
                      const taskIsOverdue = isOverdue(task);
                      const displayStatus = getDisplayStatus(task);
                      const statusStyle   = STATUS_STYLES[displayStatus] || STATUS_STYLES.pending;
                      const priorityStyle = getPriorityStyle(task.priority);
                      const stripeColor   = getStripeColor(task, taskIsOverdue);
                      return (
                        <BoardCard key={task.id} task={task} index={index}
                          isOverdue={taskIsOverdue} statusStyle={statusStyle} priorityStyle={priorityStyle} stripeColor={stripeColor}
                          getUserName={getUserName} getClientName={getClientName} getRelativeDueDate={getRelativeDueDate}
                          getChecklistProgress={getChecklistProgress} parseChecklist={parseChecklist}
                          taskChecklists={taskChecklists} toggleChecklistItem={toggleChecklistItem}
                          canModifyTask={canModifyTask} canDeleteTasks={canDeleteTasks}
                          handleEdit={handleEdit} handleDelete={handleDelete} handleDuplicateTask={handleDuplicateTask}
                          handleQuickStatusChange={handleQuickStatusChange}
                          handleQuickPriorityChange={handleQuickPriorityChange}
                          openTaskDetail={openTaskDetail}
                          openCommentTaskId={openCommentTaskId} setOpenCommentTaskId={setOpenCommentTaskId}
                          fetchComments={fetchComments} comments={comments[task.id] || EMPTY_ARR} newComment={newComment}
                          setNewComment={setNewComment} selectedTask={selectedTask} setSelectedTask={setSelectedTask}
                          handleAddComment={handleAddComment}
                          isDark={isDark}
                        />
                      );
                    })}
                    {colTasks.length === 0 && (
                      <div className={`flex items-center justify-center h-24 rounded-xl border-2 border-dashed ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                        <p className="text-xs text-slate-400">No tasks</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>

      {/* ── Task Detail Dialog ───────────────────────────────────────────── */}
      <Dialog open={taskDetailOpen} onOpenChange={setTaskDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold" style={{ color: COLORS.deepBlue }}>Task Details</DialogTitle>
            <DialogDescription className="sr-only">Full task details</DialogDescription>
          </DialogHeader>
          {selectedDetailTask && (() => {
            const taskIsOverdue  = isOverdue(selectedDetailTask);
            const displayStatus  = getDisplayStatus(selectedDetailTask);
            const statusStyle    = STATUS_STYLES[displayStatus] || STATUS_STYLES.pending;
            const priorityStyle  = getPriorityStyle(selectedDetailTask.priority);
            const checklistItems = parseChecklist(selectedDetailTask.description);
            const checkedItems   = taskChecklists[selectedDetailTask.id] || [];
            const progress       = getChecklistProgress(selectedDetailTask);
            return (
              <div className="space-y-5 mt-2">
                <div>
                  <h2 className={`text-xl font-bold mb-2 leading-snug ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedDetailTask.title}</h2>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${statusStyle.bg} ${statusStyle.text}`}>{taskIsOverdue ? 'Overdue' : statusStyle.label}</span>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg border transition-all hover:scale-105 active:scale-95 cursor-pointer ${priorityStyle.badge || `${priorityStyle.bg} ${priorityStyle.text} border`}`}
                          title="Click to assign or change priority"
                        >
                          <span className={`w-2 h-2 rounded-full ${priorityStyle.dot}`} />
                          <span>{priorityStyle.label} Priority</span>
                          <ChevronDown className="h-3 w-3 opacity-60 ml-0.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-36 p-1.5 rounded-xl shadow-lg border bg-white dark:bg-slate-800" align="start">
                        <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 text-slate-400">
                          Assign Priority
                        </div>
                        <div className="space-y-0.5">
                          {[
                            { value: 'high', label: 'High', style: PRIORITY_STYLES.high },
                            { value: 'medium', label: 'Medium', style: PRIORITY_STYLES.medium },
                            { value: 'low', label: 'Low', style: PRIORITY_STYLES.low },
                          ].map((p) => {
                            const isSelected = (selectedDetailTask.priority || '').toLowerCase() === p.value;
                            return (
                              <button
                                key={p.value}
                                type="button"
                                onClick={() => handleQuickPriorityChange(selectedDetailTask, p.value)}
                                className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                  isSelected
                                    ? `${p.style.bg} ${p.style.text} font-bold`
                                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className={`w-2 h-2 rounded-full ${p.style.dot}`} />
                                  <span>{p.label}</span>
                                </div>
                                {isSelected && <Check className="h-3.5 w-3.5" />}
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {selectedDetailTask.is_recurring && <span className="text-xs font-semibold bg-purple-50 text-purple-700 px-2.5 py-1 rounded-lg">↺ Recurring</span>}
                    {selectedDetailTask.category && <span className="text-xs font-semibold bg-slate-100 text-slate-600 px-2.5 py-1 rounded-lg uppercase">{getCategoryLabel(selectedDetailTask.category)}</span>}
                  </div>
                </div>
                {selectedDetailTask.description && (
                  <div className={`border rounded-xl p-4 ${isDark ? 'border-slate-600 bg-slate-700/40' : 'border-slate-200 bg-slate-50'}`}>
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">Notes</p>
                    <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{selectedDetailTask.description}</div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Assigned To', value: getUserName(selectedDetailTask.assigned_to, selectedDetailTask.assigned_to_name) },
                    { label: 'Created By',  value: selectedDetailTask.created_by ? getUserName(selectedDetailTask.created_by, selectedDetailTask.created_by_name) : '—' },
                    { label: 'Department',  value: getCategoryLabel(selectedDetailTask.category) },
                    { label: 'Client',      value: selectedDetailTask.client_id ? getClientName(selectedDetailTask.client_id) : '—' },
                    { label: 'Created On',  value: selectedDetailTask.created_at ? format(new Date(selectedDetailTask.created_at), 'MMM dd, yyyy · hh:mm a') : '—' },
                    { label: 'Due Date',    value: selectedDetailTask.due_date ? `${format(new Date(selectedDetailTask.due_date), 'MMM dd, yyyy')} · ${getRelativeDueDate(selectedDetailTask.due_date)}` : 'No due date' },
                    { label: 'Recurrence', value: selectedDetailTask.is_recurring ? `Every ${selectedDetailTask.recurrence_interval} ${selectedDetailTask.recurrence_pattern}(s)` : 'One-time' },
                  ].map(({ label, value }) => (
                    <div key={label} className={`border rounded-xl p-3.5 ${isDark ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-white'}`}>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{label}</p>
                      <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{value}</p>
                    </div>
                  ))}
                </div>
                {checklistItems.length > 0 && (
                  <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 flex items-center gap-1.5"><Check className="h-3.5 w-3.5" /> Compliance Checklist</p>
                      <span className="text-xs font-bold text-emerald-700">{checkedItems.length}/{checklistItems.length} · {progress}%</span>
                    </div>
                    <div className="h-1.5 bg-emerald-200 rounded-full mb-3 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {checklistItems.map((item, idx) => (
                        <label key={idx} className="flex items-start gap-2.5 cursor-pointer">
                          <Checkbox checked={checkedItems.includes(idx)} onCheckedChange={() => toggleChecklistItem(selectedDetailTask.id, idx)} className="mt-0.5 flex-shrink-0" />
                          <span className={`text-sm leading-relaxed ${checkedItems.includes(idx) ? 'line-through text-slate-400' : 'text-slate-700'}`}>{item}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className={`flex gap-2 border-t pt-4 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                  {canModifyTask(selectedDetailTask) && <Button onClick={() => { handleEdit(selectedDetailTask); setTaskDetailOpen(false); }} className="h-9 text-sm rounded-lg bg-blue-700 hover:bg-blue-800 text-white gap-1.5"><Edit className="h-3.5 w-3.5" /> Edit</Button>}
                  {canModifyTask(selectedDetailTask) && <Button variant="outline" onClick={() => { handleDuplicateTask(selectedDetailTask); setTaskDetailOpen(false); }} className="h-9 text-sm rounded-lg gap-1.5"><Copy className="h-3.5 w-3.5" /> Duplicate</Button>}
                  <Button variant="outline" onClick={() => handleAddToReminder(selectedDetailTask)} className="h-9 text-sm rounded-lg text-purple-600 hover:bg-purple-50 border-purple-200 gap-1.5"><Bell className="h-3.5 w-3.5" /> Add to Reminders</Button>
                  {canDeleteTasks && <Button variant="outline" onClick={() => { handleDelete(selectedDetailTask.id); setTaskDetailOpen(false); }} className="h-9 text-sm rounded-lg text-red-600 hover:bg-red-50 border-red-200 gap-1.5"><Trash2 className="h-3.5 w-3.5" /> Delete</Button>}
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Workflow Library ─────────────────────────────────────────────── */}
      <Dialog open={showWorkflowLibrary} onOpenChange={setShowWorkflowLibrary}>
        <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold" style={{ color: COLORS.deepBlue }}>CA/CS Compliance Workflow Library</DialogTitle>
            <DialogDescription className="text-sm text-slate-500">14 professionally curated compliance workflows. Click any template to pre-fill a task.</DialogDescription>
          </DialogHeader>
          <div className={`flex gap-3 sticky top-0 z-10 py-3 border-b ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input placeholder="Search templates…" value={workflowSearch} onChange={(e) => setWorkflowSearch(e.target.value)} className="pl-9 h-9 text-sm" />
            </div>
            <Select value={workflowDeptFilter} onValueChange={setWorkflowDeptFilter}>
              <SelectTrigger className="w-44 h-9 text-sm"><SelectValue placeholder="Department" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All Departments</SelectItem>{DEPARTMENTS.map(d => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={workflowFrequencyFilter} onValueChange={setWorkflowFrequencyFilter}>
              <SelectTrigger className="w-40 h-9 text-sm"><SelectValue placeholder="Frequency" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Frequencies</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="annual">Annual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
            {filteredWorkflows.map((wf) => {
              const steps = parseChecklist(wf.description);
              const priorityStyle = PRIORITY_STYLES[wf.priority] || PRIORITY_STYLES.medium;
              return (
                <button key={wf.id} onClick={() => applyComplianceWorkflow(wf)}
                  className={`text-left border rounded-xl p-5 hover:border-emerald-400 hover:shadow-md transition-all group ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 bg-slate-100 px-2 py-0.5 rounded-md">{getCategoryLabel(wf.category)}</span>
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md ${priorityStyle.bg} ${priorityStyle.text}`}>{priorityStyle.label}</span>
                      </div>
                      <h3 className={`font-bold group-hover:text-emerald-600 transition-colors leading-snug ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{wf.name}</h3>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      <div className="text-lg font-bold text-emerald-600">{wf.estimatedHours}h</div>
                      <div className="text-[10px] text-slate-400">{wf.frequency}</div>
                    </div>
                  </div>
                  <div className={`rounded-lg p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Key Steps</p>
                    <div className="space-y-1">
                      {steps.slice(0, 4).map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] text-slate-600 truncate"><Check className="h-3 w-3 text-emerald-500 flex-shrink-0" /> {s}</div>
                      ))}
                      {steps.length > 4 && <div className="text-[11px] text-emerald-600 pl-4">+{steps.length - 4} more steps</div>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-[11px] text-slate-400">Due in ~{wf.estimatedDays} days</span>
                    <span className="text-[11px] font-semibold text-emerald-600 group-hover:underline flex items-center gap-1">Use Template <ArrowRight className="h-3 w-3" /></span>
                  </div>
                </button>
              );
            })}
            {filteredWorkflows.length === 0 && <div className="col-span-2 text-center py-16 text-slate-400">No templates match your filters</div>}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AI Duplicate Detection Dialog ──────────────────────────────── */}
      <Dialog open={showDuplicateDialog} onOpenChange={(o) => { setShowDuplicateDialog(o); if (!o) { setCompareMode(false); setCompareTaskIds([]); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2" style={{ color: COLORS.deepBlue }}>
              <Sparkles className="h-5 w-5 text-purple-500" />
              AI Duplicate Task Detection
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500 flex items-center gap-2 flex-wrap">
              <span>
                {duplicateGroups.length
                  ? `Found ${duplicateGroups.length} group${duplicateGroups.length !== 1 ? 's' : ''} of potential duplicate tasks.`
                  : 'No duplicate tasks detected.'}
              </span>
              {duplicateGroups.length > 0 && (() => {
                const src = duplicateGroups[0]?.source;
                const badgeClass = src === 'gemini'
                  ? 'bg-violet-50 text-violet-700 border-violet-200'
                  : src === 'grok'
                    ? 'bg-orange-50 text-orange-700 border-orange-200'
                    : 'bg-blue-50 text-blue-700 border-blue-200';
                const badgeLabel = src === 'gemini' ? '✦ Gemini AI' : src === 'grok' ? '⚡ Grok AI' : '⚡ Local Scan';
                return (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${badgeClass}`}>
                    {badgeLabel}
                  </span>
                );
              })()}
              {duplicateGroups.length > 0 && (
                <button
                  onClick={() => { setCompareMode(p => !p); setCompareTaskIds([]); }}
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all ${
                    compareMode
                      ? 'bg-emerald-500 text-white border-emerald-500'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                  }`}
                >
                  {compareMode ? '✓ Compare Mode ON — select 2 tasks' : '⇄ Compare Mode'}
                </button>
              )}
            </DialogDescription>
          </DialogHeader>

          {/* ── Compare Panel ── */}
          {compareMode && compareTaskIds.length === 2 && (() => {
            const tA = tasks.find(t => String(t.id) === String(compareTaskIds[0]));
            const tB = tasks.find(t => String(t.id) === String(compareTaskIds[1]));
            if (!tA || !tB) return null;
            const fields = [
              { label: 'Title',      a: tA.title,                                                      b: tB.title },
              { label: 'Status',     a: STATUS_STYLES[tA.status]?.label || tA.status,                  b: STATUS_STYLES[tB.status]?.label || tB.status },
              { label: 'Priority',   a: (tA.priority || '').toUpperCase(),                             b: (tB.priority || '').toUpperCase() },
              { label: 'Department', a: getCategoryLabel(tA.category),                                 b: getCategoryLabel(tB.category) },
              { label: 'Client',     a: tA.client_id ? getClientName(tA.client_id) : '—',             b: tB.client_id ? getClientName(tB.client_id) : '—' },
              { label: 'Assignee',   a: getUserName(tA.assigned_to),                                   b: getUserName(tB.assigned_to) },
              { label: 'Due Date',   a: tA.due_date ? format(new Date(tA.due_date), 'MMM dd, yyyy') : '—', b: tB.due_date ? format(new Date(tB.due_date), 'MMM dd, yyyy') : '—' },
              { label: 'Created',    a: tA.created_at ? format(new Date(tA.created_at), 'MMM dd, yyyy') : '—', b: tB.created_at ? format(new Date(tB.created_at), 'MMM dd, yyyy') : '—' },
              { label: 'Recurring',  a: tA.is_recurring ? 'Yes' : 'No',                               b: tB.is_recurring ? 'Yes' : 'No' },
              { label: 'Description',a: (tA.description || '—').slice(0, 80),                         b: (tB.description || '—').slice(0, 80) },
            ];
            return (
              <div className={`my-3 border rounded-xl overflow-hidden ${isDark ? 'border-emerald-800 bg-slate-800' : 'border-emerald-200 bg-emerald-50/30'}`}>
                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500 text-white">
                  <span className="text-xs font-bold uppercase tracking-wide">Side-by-Side Comparison</span>
                  <button onClick={() => { setCompareTaskIds([]); setCompareMode(false); }} className="text-white/80 hover:text-white text-xs">✕ Close</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`border-b ${isDark ? 'border-slate-700 bg-slate-700' : 'border-emerald-200 bg-emerald-100/60'}`}>
                        <th className="px-3 py-2 text-left font-bold text-slate-500 w-24">Field</th>
                        <th className="px-3 py-2 text-left font-semibold text-blue-700 max-w-[220px]">
                          <button onClick={() => openTaskDetail(tA)} className="hover:underline truncate block">{tA.title.slice(0, 30)}{tA.title.length > 30 ? '…' : ''}</button>
                        </th>
                        <th className="px-3 py-2 text-left font-semibold text-purple-700 max-w-[220px]">
                          <button onClick={() => openTaskDetail(tB)} className="hover:underline truncate block">{tB.title.slice(0, 30)}{tB.title.length > 30 ? '…' : ''}</button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(({ label, a, b }) => {
                        const diff = String(a).toLowerCase() !== String(b).toLowerCase();
                        return (
                          <tr key={label} className={`border-b ${isDark ? 'border-slate-700' : 'border-emerald-100'} ${diff ? (isDark ? 'bg-amber-900/20' : 'bg-amber-50/60') : ''}`}>
                            <td className="px-3 py-1.5 font-bold text-slate-400 whitespace-nowrap">{label}</td>
                            <td className={`px-3 py-1.5 ${diff ? 'text-blue-700 font-semibold' : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>{a}</td>
                            <td className={`px-3 py-1.5 ${diff ? 'text-purple-700 font-semibold' : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>{b}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2 px-4 py-2 border-t border-emerald-200">
                  {canDeleteTasks && <button onClick={() => { handleDelete(tA.id); setCompareTaskIds([]); setCompareMode(false); }} className="h-6 px-3 text-[10px] font-semibold rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100">Delete Task A</button>}
                  {canDeleteTasks && <button onClick={() => { handleDelete(tB.id); setCompareTaskIds([]); setCompareMode(false); }} className="h-6 px-3 text-[10px] font-semibold rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100">Delete Task B</button>}
                  <button onClick={() => { setCompareTaskIds([]); }} className="h-6 px-3 text-[10px] font-semibold rounded-lg bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 ml-auto">Clear Selection</button>
                </div>
              </div>
            );
          })()}
          {compareMode && compareTaskIds.length < 2 && (
            <div className={`my-2 px-4 py-2 rounded-lg text-xs font-medium text-center ${isDark ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
              {compareTaskIds.length === 0 ? 'Click any task title below to select it for comparison (select 2)' : `1 task selected — click one more task to compare`}
            </div>
          )}

          <div className="mt-2 space-y-4">
            {duplicateGroups.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                </div>
                <p className="font-semibold text-slate-700">All Clear!</p>
                <p className="text-sm text-slate-400 mt-1">No duplicate tasks found in your current view.</p>
              </div>
            ) : duplicateGroups.map((group, gi) => {
              const groupTasks = (group.task_ids || []).map(id => tasks.find(t => String(t.id) === String(id))).filter(Boolean);
              const confColor = group.confidence === 'high' ? 'text-red-600 bg-red-50 border-red-200' : 'text-amber-600 bg-amber-50 border-amber-200';
              return (
                <div key={gi} className={`border rounded-xl overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <div className={`px-4 py-3 flex items-center justify-between gap-2 ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="text-xs font-bold text-slate-400">GROUP {gi + 1}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${confColor}`}>
                        {(group.confidence || 'medium').toUpperCase()} MATCH
                      </span>
                      <span className={`text-[10px] text-right truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{group.reason}</span>
                    </div>
                    <button
                      onClick={() => {
                        // Select all tasks in group for quick compare of first 2
                        const ids = groupTasks.slice(0, 2).map(t => String(t.id));
                        setCompareTaskIds(ids);
                        setCompareMode(true);
                      }}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 transition-all ${isDark ? 'bg-slate-700 border-slate-600 text-slate-300 hover:border-emerald-500 hover:text-emerald-400' : 'bg-white border-slate-300 text-slate-600 hover:border-emerald-400 hover:text-emerald-600'}`}
                    >
                      ⇄ Compare
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-700">
                    {groupTasks.map((task, ti) => {
                      const ps = PRIORITY_STYLES[task.priority] || PRIORITY_STYLES.medium;
                      const ss = STATUS_STYLES[task.status] || STATUS_STYLES.pending;
                      const isSelectedForCompare = compareTaskIds.includes(String(task.id));
                      return (
                        <div key={ti} className={`px-4 py-3 flex items-center justify-between gap-3 transition-all ${
                          isSelectedForCompare
                            ? (isDark ? 'bg-emerald-900/30 border-l-2 border-emerald-500' : 'bg-emerald-50 border-l-2 border-emerald-500')
                            : (isDark ? 'bg-slate-800/60' : 'bg-white')
                        }`}>
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getStripeColor(task, isOverdue(task))}`} />
                            {/* Clickable title — opens Task Detail OR selects for compare */}
                            <button
                              onClick={() => {
                                if (compareMode) {
                                  const sid = String(task.id);
                                  setCompareTaskIds(prev => {
                                    if (prev.includes(sid)) return prev.filter(i => i !== sid);
                                    if (prev.length >= 2) return [prev[1], sid];
                                    return [...prev, sid];
                                  });
                                } else {
                                  openTaskDetail(task);
                                  setShowDuplicateDialog(false);
                                }
                              }}
                              className={`text-sm font-medium truncate text-left transition-colors ${
                                compareMode
                                  ? (isSelectedForCompare
                                    ? 'text-emerald-600 font-bold'
                                    : (isDark ? 'text-slate-300 hover:text-emerald-400' : 'text-slate-700 hover:text-emerald-600'))
                                  : (isDark ? 'text-slate-100 hover:text-blue-400 underline-offset-2 hover:underline' : 'text-slate-800 hover:text-blue-700 underline-offset-2 hover:underline')
                              }`}
                              title={compareMode ? 'Click to select for comparison' : 'Click to view task details'}
                            >
                              {isSelectedForCompare && '✓ '}{task.title}
                            </button>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ss.bg} ${ss.text}`}>{ss.label}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${ps.bg} ${ps.text}`}>{ps.label}</span>
                            {task.category && <span className="text-[10px] text-slate-400 uppercase">{task.category}</span>}
                            <span className="text-[10px] text-slate-400">{getUserName(task.assigned_to, task.assigned_to_name)}</span>
                            {task.created_at && (
                              <span className="text-[10px] text-slate-400 hidden sm:inline">{format(new Date(task.created_at), 'MMM dd, yy')}</span>
                            )}
                            {/* View button */}
                            <button
                              onClick={() => { openTaskDetail(task); setShowDuplicateDialog(false); }}
                              className="h-6 px-2 text-[10px] font-semibold rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors border border-slate-200 flex-shrink-0"
                              title="View task details"
                            >
                              View
                            </button>
                            {canModifyTask(task) && (
                              <button
                                onClick={() => { handleEdit(task); setShowDuplicateDialog(false); }}
                                className="h-6 px-2 text-[10px] font-semibold rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors border border-blue-200 flex-shrink-0"
                              >
                                Edit
                              </button>
                            )}
                            {canDeleteTasks && (
                              <button
                                onClick={() => {
                                  handleDelete(task.id);
                                  setDuplicateGroups(prev =>
                                    prev.map(g => ({ ...g, task_ids: g.task_ids.filter(id => String(id) !== String(task.id)) }))
                                      .filter(g => g.task_ids.length > 1)
                                  );
                                  setCompareTaskIds(prev => prev.filter(id => id !== String(task.id)));
                                }}
                                className="h-6 px-2 text-[10px] font-semibold rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors border border-red-200 flex-shrink-0"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {groupTasks.length === 0 && (
                      <p className="px-4 py-3 text-xs text-slate-400">Task IDs not found in current view — may be filtered out.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={`flex items-center justify-between pt-4 border-t mt-2 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
            <p className="text-[10px] text-slate-400">
              {compareMode ? 'Click task titles to select for comparison · Click "View" to open details' : 'Click task titles to open details · Enable Compare Mode to compare side-by-side'}
            </p>
            <Button variant="outline" onClick={() => { setShowDuplicateDialog(false); setCompareMode(false); setCompareTaskIds([]); }} className="h-9 text-sm rounded-xl">Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Comments dialog ──────────────────────────────────────────────── */}
      <Dialog open={showCommentsDialog} onOpenChange={setShowCommentsDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle className="text-base font-bold">Comments — {selectedTask?.title}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="max-h-60 overflow-y-auto space-y-2">
              {(comments[selectedTask?.id] || []).map((c, i) => (
                <div key={i} className={`rounded-lg px-3 py-2.5 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-100'}`}>
                  <p className="text-sm text-slate-700">{c.text}</p>
                  <p className="text-[10px] text-slate-400 mt-1">{getUserName(c.user_id)} · {format(new Date(c.created_at), 'MMM dd, hh:mm a')}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Add a comment…" className="h-9 text-sm" />
              <Button className="h-9 text-sm" onClick={handleAddComment}>Post</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete Task Confirmation Modal ───────────────────────────── */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => {
        if (!isDeletingTask) {
          setDeleteDialogOpen(open);
          if (!open) setTaskToDelete(null);
        }
      }}>
        <AlertDialogContent className={`max-w-md rounded-2xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
          <AlertDialogHeader className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center">
              <Trash2 className="w-6 h-6" />
            </div>
            <div>
              <AlertDialogTitle className="text-lg font-bold">Delete Task?</AlertDialogTitle>
              <AlertDialogDescription className={`text-sm mt-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Are you sure you want to delete <span className="font-semibold text-slate-800 dark:text-slate-200">"{taskToDelete?.title || 'this task'}"</span>? This action cannot be undone.
              </AlertDialogDescription>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 flex items-center gap-2 sm:justify-end">
            <AlertDialogCancel
              onClick={() => { setDeleteDialogOpen(false); setTaskToDelete(null); }}
              disabled={isDeletingTask}
              className={`rounded-xl h-10 px-4 text-xs font-semibold ${isDark ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300' : ''}`}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirmDelete();
              }}
              disabled={isDeletingTask}
              className="rounded-xl h-10 px-4 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white flex items-center gap-2 shadow-md shadow-red-600/20"
            >
              {isDeletingTask ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  Delete Task
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <input type="file" accept=".csv" ref={fileInputRef} style={{ display: 'none' }} onChange={handleCsvUpload} />
      <AIFileInsights file={csvAiFile} label="CSV Task Data Insights" />
    </motion.div>
  );
}
