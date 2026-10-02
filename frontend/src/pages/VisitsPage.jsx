import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FixedSizeList as List } from "react-window";
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  isToday, parseISO, addMonths, subMonths, isBefore, getDay, isValid,
} from "date-fns";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import EmailEventImporter from "@/components/EmailEventImporter";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  MapPin, Calendar, Clock, Plus, X, ChevronLeft, ChevronRight,
  User, MessageSquare, Repeat, Building2, CheckCircle2,
  XCircle, AlertCircle, RotateCcw, Edit3, Trash2,
  Send, ChevronDown, ClipboardList, Loader2, Check,
  Mail, Info, CalendarDays, CalendarRange, Filter,
  CheckSquare, Minus, TrendingUp, Target, ArrowUpRight,
  GripVertical, Settings2,
} from "lucide-react";

// ADD THIS IMPORT AT TOP
import LayoutCustomizer from "../components/layout/LayoutCustomizer";
import { usePageLayout } from "../hooks/usePageLayout";

// ── Brand Colors (matching Dashboard) ────────────────────────────────────────
const COLORS = {
  deepBlue: "#0D3B66",
  mediumBlue: "#1F6FB2",
  emeraldGreen:"#1FAF5A",
  lightGreen: "#5CCB5F",
  coral: "#FF6B6B",
  amber: "#F59E0B",
};

// ── Spring Physics (matching Dashboard) ──────────────────────────────────────
const springPhysics = {
  card: { type: "spring", stiffness: 280, damping: 22, mass: 0.85 },
  lift: { type: "spring", stiffness: 320, damping: 24, mass: 0.9 },
  button: { type: "spring", stiffness: 400, damping: 28 },
  tap: { type: "spring", stiffness: 500, damping: 30 },
};

// ── Animation Variants (matching Dashboard) ───────────────────────────────────
const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] } },
  exit: { opacity: 0, y: 12, transition: { duration: 0.3 } },
};

// ── Slim scrollbar (matching Dashboard) ──────────────────────────────────────
const slimScroll = {
  overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: "#cbd5e1 transparent",
};

// ─── Safe date helpers (CRASH FIX) ──────────────────────────────────────────
function safeParseISO(dateStr) {
  if (!dateStr) return null;
  try {
    const d = parseISO(String(dateStr).slice(0, 10));
    return isValid(d) ? d : null;
  } catch { return null; }
}

function safeFormat(dateStr, fmt, fallback = "—") {
  const d = safeParseISO(dateStr);
  if (!d) return fallback;
  try { return format(d, fmt); } catch { return fallback; }
}

// ─── Status / Priority meta ─────────────────────────────────────────────────
const STATUS_META = {
  scheduled: { label: "Scheduled", icon: Clock, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/60", border: "border-blue-200 dark:border-blue-800" },
  completed: { label: "Completed", icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/60", border: "border-emerald-200 dark:border-emerald-800" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "text-slate-500 dark:text-slate-400", bg: "bg-slate-50 dark:bg-slate-800", border: "border-slate-200 dark:border-slate-700" },
  missed: { label: "Missed", icon: AlertCircle, color: "text-orange-500 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950/60", border: "border-orange-200 dark:border-orange-800" },
  rescheduled: { label: "Rescheduled", icon: RotateCcw, color: "text-purple-500 dark:text-purple-400", bg: "bg-purple-50 dark:bg-purple-950/60", border: "border-purple-200 dark:border-purple-800" },
};

const PRIORITY_META = {
  low: { label: "Low", color: "text-blue-500", dot: "bg-blue-400" },
  medium: { label: "Medium", color: "text-amber-500", dot: "bg-amber-400" },
  high: { label: "High", color: "text-orange-500", dot: "bg-orange-500" },
  urgent: { label: "Urgent", color: "text-red-600", dot: "bg-red-500" },
};

const RECURRENCE_OPTIONS = [
  { value: "none", label: "No repeat" },
  { value: "weekly", label: "Every week (same day)" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Same date each month" },
  { value: "nth_weekday", label: "Nth weekday of month…" },
  { value: "last_weekday", label: "Last weekday of month…" },
];

const WEEKDAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const WEEK_NUMBERS = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: 5, label: "5th" },
];

// ─── API helpers ────────────────────────────────────────────────────────────
const fetchVisits = (p) =>
  api.get("/visits", { params: p }).then(r => {
    const raw = r.data;
    return Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  });
const fetchClients = () => api.get("/clients").then(r => r.data).catch(e => {
  if (e?.response?.status === 403) return [];   // graceful — dropdown stays empty
  throw e;
});
const fetchUsers = () => api.get("/users").then(r => r.data).catch(e => {
  if (e?.response?.status === 403) return [];   // graceful — dropdown stays empty
  throw e;
});
const fetchSummary = (uid, month) => api.get("/visits/summary", { params: { user_id: uid, month } }).then(r => r.data);

// ─── Permission helpers ─────────────────────────────────────────────────────
function canUserWriteVisit(currentUser, visit) {
  if (!currentUser || !visit) return false;
  if (currentUser.role === "admin") return true;
  const assignedTo = visit.assigned_to;
  if (assignedTo && String(assignedTo) === String(currentUser.id)) return true;
  const perms = currentUser.permissions || {};
  return Boolean(perms.can_edit_visits);
}

function canUserDeleteVisit(currentUser, visit) {
  if (!currentUser || !visit) return false;
  if (currentUser.role === "admin") return true;
  const perms = currentUser.permissions || {};
  if (perms.can_delete_visits) return true;
  const assignedTo = visit.assigned_to;
  const isOwn = assignedTo && String(assignedTo) === String(currentUser.id);
  if (isOwn) return perms.can_delete_own_visits !== false;
  return false;
}

// ── Shared Card Shell (matching Dashboard) ────────────────────────────────────
function SectionCard({ children, className = "" }) {
  return (
    <div className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`}>
      {children}
    </div>
  );
}

// ── Card Header Row (matching Dashboard) ─────────────────────────────────────
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
          <p className="text-xs text-slate-400 dark:text-slate-500">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

// ─── Skeleton loader ─────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-11 h-14 rounded-lg bg-slate-200 dark:bg-slate-700 flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 bg-slate-200 dark:bg-slate-700 rounded-md w-2/3" />
          <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded-md w-1/2" />
        </div>
        <div className="flex gap-1.5">
          <div className="w-14 h-7 rounded-lg bg-slate-200 dark:bg-slate-700" />
          <div className="w-10 h-7 rounded-lg bg-slate-100 dark:bg-slate-800" />
        </div>
      </div>
    </div>
  );
}

// ─── Tiny reusable pieces ───────────────────────────────────────────────────
function StatusBadge({ status, size = "sm" }) {
  const m = STATUS_META[status] || STATUS_META.scheduled;
  const Icon = m.icon;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-lg font-bold border",
      m.bg, m.border, m.color,
      size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
    )}>
      <Icon className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {m.label}
    </span>
  );
}

function PriorityDot({ priority }) {
  const m = PRIORITY_META[priority] || PRIORITY_META.medium;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0 ring-1 ring-white dark:ring-slate-700", m.dot)} />
      <span className={cn("text-[10px] font-bold tracking-wide", m.color)}>{m.label}</span>
    </span>
  );
}

function Avatar({ src, name, size = 7 }) {
  const initials = (name || "?").split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase();
  return src ? (
    <img src={src} alt={name}
      className={`w-${size} h-${size} rounded-full object-cover ring-2 ring-white dark:ring-slate-800 flex-shrink-0`} />
  ) : (
    <div
      className={`w-${size} h-${size} rounded-full flex items-center justify-center text-white text-[9px] font-black flex-shrink-0 ring-2 ring-white dark:ring-slate-800`}
      style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
      {initials}
    </div>
  );
}

function DuplicateWarning({ existing }) {
  if (!existing) return null;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
      className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800">
      <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-xs font-bold text-amber-700 dark:text-amber-400">Duplicate visit detected</p>
        <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5">
          A <strong>{existing.status}</strong> visit already exists for this client on this date
          {existing.purpose ? ` — "${existing.purpose}"` : ""}.
        </p>
      </div>
    </motion.div>
  );
}

// ─── Yes / No quick-action buttons ──────────────────────────────────────────
function QuickStatusButtons({ visit, onDone }) {
  const qc = useQueryClient();
  const quickMut = useMutation({
    mutationFn: (done) => api.post(`/visits/${visit.id}/quick-status`, { done }),
    onSuccess: (_, done) => {
      toast.success(done ? "✓ Marked as completed" : "Marked as missed");
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["visits-upcoming-dashboard"] });
      onDone?.();
    },
    onError: (err) => toast.error(err.response?.data?.detail || "Update failed"),
  });
  return (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      <motion.button
        whileHover={{ scale: 1.05, transition: springPhysics.button }}
        whileTap={{ scale: 0.93, transition: springPhysics.tap }}
        disabled={quickMut.isPending}
        onClick={() => quickMut.mutate(true)}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500 hover:bg-emerald-600 text-white shadow-sm disabled:opacity-50 transition-colors">
        {quickMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}Yes
      </motion.button>
      <motion.button
        whileHover={{ scale: 1.05, transition: springPhysics.button }}
        whileTap={{ scale: 0.93, transition: springPhysics.tap }}
        disabled={quickMut.isPending}
        onClick={() => quickMut.mutate(false)}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-red-500 hover:border-red-200 dark:hover:border-red-800 disabled:opacity-50 transition-colors">
        <X className="h-3 w-3" />No
      </motion.button>
    </div>
  );
}

// ─── Bulk Delete Dialog ──────────────────────────────────────────────────────
function BulkDeleteDialog({ count, onConfirm, onCancel, isPending }) {
  const [deleteRecurrences, setDeleteRecurrences] = useState(false);
  return (
    <motion.div
      className="fixed inset-0 z-[9500] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <motion.div
        className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-700"
        initial={{ scale: 0.88, y: 40, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.88, y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800">
            <Trash2 className="h-5 w-5 text-red-500" />
          </div>
          <div>
            <h3 className="font-bold text-slate-800 dark:text-slate-100">Delete {count} Visit{count !== 1 ? "s" : ""}?</h3>
            <p className="text-xs text-slate-400 mt-0.5">This action cannot be undone.</p>
          </div>
        </div>
        <div
          onClick={() => setDeleteRecurrences(r => !r)}
          className="flex items-center gap-3 p-3 rounded-xl border dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 cursor-pointer mb-5 select-none">
          <div className={cn(
            "h-5 w-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors",
            deleteRecurrences ? "bg-red-500 border-red-500" : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
          )}>
            {deleteRecurrences && <Check className="h-3 w-3 text-white" />}
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Also delete recurring visits</p>
            <p className="text-[10px] text-slate-400">Removes all child recurrence entries for parent visits</p>
          </div>
        </div>
        <div className="flex gap-2.5">
          <Button variant="outline" onClick={onCancel} className="flex-1 rounded-xl h-10 border-slate-200 dark:border-slate-700">Cancel</Button>
          <Button onClick={() => onConfirm(deleteRecurrences)} disabled={isPending}
            className="flex-1 rounded-xl h-10 text-white font-bold"
            style={{ background: "linear-gradient(135deg, #DC2626, #B91C1C)" }}>
            {isPending
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Deleting…</>
              : <><Trash2 className="h-3.5 w-3.5 mr-1.5" />Delete {count}</>}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}


const getVisitStripeColor = (visit, isOver) => {
  if (isOver) return 'bg-red-700';
  const s = (visit.status || '').toLowerCase();
  if (s === 'completed')   return 'bg-blue-600';
  if (s === 'rescheduled') return 'bg-amber-500';
  if (s === 'missed')      return 'bg-orange-500';
  if (s === 'cancelled')   return 'bg-slate-300';
  const p = (visit.priority || '').toLowerCase();
  if (p === 'urgent')  return 'bg-red-600';
  if (p === 'high')    return 'bg-orange-500';
  if (p === 'medium')  return 'bg-amber-400';
  return 'bg-blue-400';
};

// ─── Compact Visit Card ───────────────────────────────────────────────────────
function VisitCard({ v, onClick, onEdit, currentUser, selected, onSelectToggle, selectionMode }) {
  const qc = useQueryClient();
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const menuRef = useRef(null);

  const parsedDate = safeParseISO(v.visit_date);
  const isOver = parsedDate ? isBefore(parsedDate, new Date()) && v.status === "scheduled" : false;
  const isCreatedByMe = currentUser && v.created_by && String(v.created_by) === String(currentUser.id)
    && v.assigned_to && String(v.assigned_to) !== String(currentUser.id);
  const showQuick = (v.status === "scheduled" || v.status === "rescheduled") && !selectionMode;
  const canWrite = canUserWriteVisit(currentUser, v);
  const canDelete = canUserDeleteVisit(currentUser, v);

  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowStatusMenu(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const statusMut = useMutation({
    mutationFn: (s) => api.patch(`/visits/${v.id}`, { status: s }),
    onSuccess: (_, s) => {
      toast.success(`Status → ${s}`);
      qc.invalidateQueries({ queryKey: ["visits"] });
      setShowStatusMenu(false);
      // Remove linked email event from Action Center when visit is completed (best-effort)
      if (s === "completed" && v.event_id) {
        api.delete(`/email/events/${v.event_id}`).catch(() => {});
      }
    },
    onError: (err) => toast.error(err.response?.data?.detail || "Update failed"),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/visits/${v.id}`),
    onSuccess: () => {
      toast.success("Visit deleted");
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["visits-upcoming-dashboard"] });
      // Also remove the linked email event from Action Center (best-effort)
      if (v.event_id) {
        api.delete(`/email/events/${v.event_id}`).catch(() => {});
      }
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: ["visits"] });
      if (err.response?.status === 404) toast.info("Visit was already removed — refreshing list.");
      else if (err.response?.status === 403) toast.error("You don't have permission to delete this visit.");
      else toast.error(err.response?.data?.detail || "Delete failed");
    },
  });

  const handleCardClick = () => {
    if (selectionMode) onSelectToggle?.(v.id);
    else onClick?.();
  };

  return (
    <motion.div
      variants={itemVariants} layout
      whileHover={{ y: selectionMode ? 0 : -2, transition: springPhysics.lift }}
      whileTap={{ scale: 0.99, transition: springPhysics.tap }}
      onClick={handleCardClick}
      className={cn(
        "relative bg-white dark:bg-slate-800 border rounded-xl cursor-pointer group transition-all overflow-hidden",
        selected
          ? "border-blue-400 dark:border-blue-500 ring-2 ring-blue-100 dark:ring-blue-900 shadow-sm"
          : isOver
          ? "border-orange-200 dark:border-orange-900"
          : "border-slate-200/80 dark:border-slate-700/80 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md",
      )}>
      {/* Priority/status stripe — matches Tasks page exactly */}
      <div className={`absolute left-0 top-0 h-full w-1 ${getVisitStripeColor(v, isOver)}`} />

      <div className="flex">
        <div className="flex items-center gap-3 pl-5 pr-3 py-2.5 flex-1 min-w-0">
          {selectionMode && (
            <div onClick={e => { e.stopPropagation(); onSelectToggle?.(v.id); }} className="flex-shrink-0">
              <div className={cn(
                "h-5 w-5 rounded-md border-2 flex items-center justify-center transition-colors",
                selected ? "bg-blue-500 border-blue-500" : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 hover:border-blue-400"
              )}>
                {selected && <Check className="h-3 w-3 text-white" />}
              </div>
            </div>
          )}

          {/* Date badge — CRASH FIX: safeFormat */}
          <div className="flex-shrink-0 w-12 text-center">
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm">
              <div className="py-0.5 text-[8px] font-black text-white uppercase tracking-widest"
                style={{ background: isOver ? `linear-gradient(135deg, ${COLORS.amber}, #D97706)` : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {safeFormat(v.visit_date, "MMM", "?")}
              </div>
              <div className="py-1 bg-white dark:bg-slate-800">
                <p className="text-sm font-black text-slate-800 dark:text-slate-100 leading-none">{safeFormat(v.visit_date, "d", "?")}</p>
                <p className="text-[9px] text-slate-400 font-semibold leading-tight">{safeFormat(v.visit_date, "EEE", "?")}</p>
              </div>
            </div>
            {v.visit_time && <p className="text-[9px] text-slate-400 mt-1 font-medium">{v.visit_time}</p>}
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate max-w-[220px]">
                {v.purpose || "(no purpose)"}
              </p>
              <StatusBadge status={v.status} />
              {isOver && (
                <span className="text-[9px] font-bold text-orange-500 bg-orange-50 dark:bg-orange-950/50 border border-orange-200 dark:border-orange-800 px-1.5 py-0.5 rounded-md">Overdue</span>
              )}
              {v.recurrence && v.recurrence !== "none" && (
                <span className="text-[9px] font-semibold text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                  <Repeat className="h-2 w-2" />
                  {v.recurrence === "nth_weekday"
                    ? `${WEEK_NUMBERS.find(w => w.value === v.recurrence_week_number)?.label || ""} ${WEEKDAYS[v.recurrence_weekday] || ""}`
                    : v.recurrence === "last_weekday"
                    ? `Last ${WEEKDAYS[v.recurrence_weekday] || ""}`
                    : v.recurrence}
                </span>
              )}
              {isCreatedByMe && (
                <span className="text-[9px] font-semibold text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-800 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                  <User className="h-2 w-2" />For: {v.assigned_to_name || "—"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 truncate max-w-[160px]">
                <Building2 className="h-3 w-3 flex-shrink-0 text-slate-400" />{v.client_name || "—"}
              </span>
              {v.location && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-400 truncate max-w-[120px]">
                  <MapPin className="h-2.5 w-2.5 flex-shrink-0" />{v.location.slice(0, 25)}{v.location.length > 25 ? "…" : ""}
                </span>
              )}
              {v.services?.length > 0 && (
                <div className="flex items-center gap-0.5">
                  {v.services.slice(0, 2).map(s => (
                    <span key={s} className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600">{s}</span>
                  ))}
                  {v.services.length > 2 && <span className="text-[9px] text-slate-400 font-medium">+{v.services.length - 2}</span>}
                </div>
              )}
              {v.comments?.length > 0 && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-400">
                  <MessageSquare className="h-2.5 w-2.5" />{v.comments.length}
                </span>
              )}
            </div>
          </div>

          {/* Right action cluster */}
          {!selectionMode && (
            <div className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end max-w-[40%]" onClick={e => e.stopPropagation()}>
              <PriorityDot priority={v.priority} />
              <Avatar src={v.assigned_to_picture} name={v.assigned_to_name} size={6} />
              <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />
              {showQuick && <QuickStatusButtons visit={v} />}
              {v.status === "completed" && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-600 text-[10px] font-bold">
                  <CheckCircle2 className="h-3 w-3" />Done
                </span>
              )}
              {v.status === "missed" && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-800 text-orange-500 text-[10px] font-bold">
                  <AlertCircle className="h-3 w-3" />Missed
                </span>
              )}
              {(canWrite || canDelete) && (
                <>
                  <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                  {canWrite && (
                    <motion.button whileHover={{ scale: 1.1, transition: springPhysics.button }} whileTap={{ scale: 0.9, transition: springPhysics.tap }}
                      onClick={e => { e.stopPropagation(); onEdit?.(v); }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors" title="Edit">
                      <Edit3 className="h-3.5 w-3.5" />
                    </motion.button>
                  )}
                  {canWrite && (
                    <div className="relative" ref={menuRef}>
                      <motion.button whileHover={{ scale: 1.1, transition: springPhysics.button }} whileTap={{ scale: 0.9, transition: springPhysics.tap }}
                        onClick={e => { e.stopPropagation(); setShowStatusMenu(s => !s); }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors" title="Change status">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </motion.button>
                      <AnimatePresence>
                        {showStatusMenu && (
                          <motion.div
                            className="absolute right-0 top-full mt-1.5 w-44 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden"
                            initial={{ opacity: 0, y: -8, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -8, scale: 0.95 }}
                            transition={{ type: "spring", stiffness: 320, damping: 24 }}>
                            <div className="p-1">
                              {Object.entries(STATUS_META).map(([s, m]) => (
                                <button key={s} onClick={e => { e.stopPropagation(); statusMut.mutate(s); }}
                                  disabled={statusMut.isPending}
                                  className={cn("w-full flex items-center gap-2.5 px-3 py-2 text-xs font-semibold rounded-xl transition-colors text-left",
                                    v.status === s ? "bg-slate-100 dark:bg-slate-700" : "hover:bg-slate-50 dark:hover:bg-slate-700/50")}>
                                  <m.icon className={cn("h-3 w-3 flex-shrink-0", m.color)} />
                                  <span className={m.color}>{m.label}</span>
                                  {v.status === s && <Check className="h-3 w-3 ml-auto text-slate-400" />}
                                </button>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                  {canDelete && (
                    <motion.button whileHover={{ scale: 1.1, transition: springPhysics.button }} whileTap={{ scale: 0.9, transition: springPhysics.tap }}
                      onClick={e => { e.stopPropagation(); if (window.confirm("Delete this visit? This cannot be undone.")) deleteMut.mutate(); }}
                      disabled={deleteMut.isPending}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors disabled:opacity-50" title="Delete">
                      {deleteMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </motion.button>
                  )}
                </>
              )}
            </div>
          )}

          {selectionMode && (
            <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
              <PriorityDot priority={v.priority} />
              <Avatar src={v.assigned_to_picture} name={v.assigned_to_name} size={6} />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Smart Recurrence Section ─────────────────────────────────────────────────
function RecurrenceSection({ form, set }) {
  const needsWeekday = form.recurrence === "nth_weekday" || form.recurrence === "last_weekday";

  const inferredWeekday = useMemo(() => {
    if (!form.visit_date) return 0;
    try { const jsDay = getDay(parseISO(form.visit_date)); return jsDay === 0 ? 6 : jsDay - 1; }
    catch { return 0; }
  }, [form.visit_date]);

  useEffect(() => {
    if (needsWeekday && form.recurrence_weekday === undefined) set("recurrence_weekday", inferredWeekday);
  }, [needsWeekday]);

  const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800/80 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-shadow";
  const labelCls = "block text-[10px] font-bold text-slate-400 dark:text-slate-500 mb-1 uppercase tracking-wider";

  const recurrenceSummary = useMemo(() => {
    if (form.recurrence === "none") return null;
    const wd = WEEKDAYS[form.recurrence_weekday ?? inferredWeekday] || "";
    const wn = WEEK_NUMBERS.find(w => w.value === (form.recurrence_week_number ?? 1))?.label || "1st";
    switch (form.recurrence) {
      case "weekly": return `Repeats every week on ${wd}`;
      case "biweekly": return `Repeats every 2 weeks on ${wd}`;
      case "monthly": return `Repeats on the same date each month`;
      case "nth_weekday": return `Repeats on the ${wn} ${wd} of each month`;
      case "last_weekday": return `Repeats on the last ${wd} of each month`;
      default: return null;
    }
  }, [form.recurrence, form.recurrence_weekday, form.recurrence_week_number, inferredWeekday]);

  return (
    <div className="space-y-2.5 p-3 rounded-xl bg-purple-50/60 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900">
      <div className="flex items-center gap-1.5 mb-1">
        <Repeat className="h-3.5 w-3.5 text-purple-500" />
        <span className="text-xs font-bold text-purple-700 dark:text-purple-300">Repeat Schedule</span>
      </div>
      <div>
        <label className={labelCls}>Recurrence Pattern</label>
        <select value={form.recurrence} onChange={e => set("recurrence", e.target.value)} className={inputCls}>
          {RECURRENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {needsWeekday && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Day of Week</label>
            <select value={form.recurrence_weekday ?? inferredWeekday} onChange={e => set("recurrence_weekday", Number(e.target.value))} className={inputCls}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          {form.recurrence === "nth_weekday" && (
            <div>
              <label className={labelCls}>Which Occurrence</label>
              <select value={form.recurrence_week_number ?? 1} onChange={e => set("recurrence_week_number", Number(e.target.value))} className={inputCls}>
                {WEEK_NUMBERS.map(w => <option key={w.value} value={w.value}>{w.label} of month</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      {form.recurrence !== "none" && (
        <div>
          <label className={labelCls}>Repeat Until</label>
          <input type="date" value={form.recurrence_end_date || ""} onChange={e => set("recurrence_end_date", e.target.value)} min={form.visit_date} className={inputCls} />
        </div>
      )}
      {recurrenceSummary && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
          className="flex items-center gap-2 p-2 rounded-lg bg-purple-100 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800">
          <Info className="h-3 w-3 text-purple-500 flex-shrink-0" />
          <p className="text-[11px] font-semibold text-purple-700 dark:text-purple-300">{recurrenceSummary}</p>
        </motion.div>
      )}
    </div>
  );
}

// ─── Visit Form Modal ─────────────────────────────────────────────────────────
function VisitFormModal({ visit, clients, users, currentUser, onClose }) {
  const isEdit = !!visit?.id;
  const qc = useQueryClient();

  const [form, setForm] = useState({
    client_id: visit?.client_id || "",
    assigned_to: visit?.assigned_to || currentUser.id,
    visit_date: visit?.visit_date || format(new Date(), "yyyy-MM-dd"),
    visit_time: visit?.visit_time || "",
    purpose: visit?.purpose || "",
    services: (visit?.services || []).join(", "),
    priority: visit?.priority || "medium",
    notes: visit?.notes || "",
    location: visit?.location || "",
    recurrence: visit?.recurrence || "none",
    recurrence_end_date: visit?.recurrence_end_date || "",
    recurrence_weekday: visit?.recurrence_weekday ?? undefined,
    recurrence_week_number: visit?.recurrence_week_number ?? 1,
  });

  const [bulkMode, setBulkMode] = useState(false);
  const [bulkDates, setBulkDates] = useState([]);
  const [bulkCalMonth, setBulkCalMonth] = useState(new Date());
  const [showRecur, setShowRecur] = useState(form.recurrence !== "none");
  const [dupWarning, setDupWarning] = useState(null);
  const [checkingDup, setCheckingDup] = useState(false);
  const dupDebounceRef = useRef(null);

  const calDays = eachDayOfInterval({ start: startOfMonth(bulkCalMonth), end: endOfMonth(bulkCalMonth) });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!form.client_id || !form.visit_date || !form.assigned_to || bulkMode) return;
    clearTimeout(dupDebounceRef.current);
    setDupWarning(null);
    dupDebounceRef.current = setTimeout(async () => {
      setCheckingDup(true);
      try {
        const res = await api.post("/visits/check-duplicate", { client_id: form.client_id, assigned_to: form.assigned_to, visit_date: form.visit_date });
        if (res.data.is_duplicate && res.data.existing?.id !== visit?.id) setDupWarning(res.data.existing);
        else setDupWarning(null);
      } catch {} 
      finally { setCheckingDup(false); }
    }, 500);
    return () => clearTimeout(dupDebounceRef.current);
  }, [form.client_id, form.visit_date, form.assigned_to, bulkMode]);

  const toggleBulkDate = (d) => {
    const s = format(d, "yyyy-MM-dd");
    setBulkDates(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = { ...form, services: form.services.split(",").map(s => s.trim()).filter(Boolean), client_name: clients.find(c => c.id === form.client_id)?.company_name || "" };
      if (!payload.visit_time) delete payload.visit_time;
      if (!payload.recurrence_end_date) delete payload.recurrence_end_date;
      if (payload.recurrence === "none") { delete payload.recurrence_weekday; delete payload.recurrence_week_number; }
      if (bulkMode && bulkDates.length) return api.post("/visits/bulk-schedule", { ...payload, visit_dates: bulkDates });
      if (isEdit) return api.patch(`/visits/${visit.id}`, payload);
      return api.post("/visits", payload);
    },
    onSuccess: (res) => {
      const skipped = res?.data?.skipped_duplicates?.length || 0;
      if (skipped > 0) toast.warning(`Scheduled ${res.data.created} visit(s). ${skipped} duplicate date(s) skipped.`);
      else toast.success(isEdit ? "Visit updated ✓" : "Visit(s) scheduled ✓");
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["visits-upcoming-dashboard"] });
      onClose();
    },
    onError: (err) => {
      const msg = err.response?.data?.detail || "Save failed";
      if (err.response?.status === 409) toast.error("Duplicate visit — " + msg.split(".")[0]);
      else toast.error(msg);
    },
  });

  const canAssign = currentUser.role === "admin" || currentUser.role === "manager";
  const canSave = !dupWarning && form.client_id && form.purpose && (bulkMode ? bulkDates.length > 0 : true);

  const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800/80 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-shadow";
  const labelCls = "block text-[10px] font-bold text-slate-400 dark:text-slate-500 mb-1 uppercase tracking-wider";

  return (
    <motion.div
      className="fixed inset-0 z-[9000] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <motion.div
        className="w-full max-w-xl max-h-[92vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-700"
        initial={{ scale: 0.88, y: 40, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.88, y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}>

        {/* Header matching Dashboard modal style */}
        <div className="sticky top-0 z-10 px-5 py-4 relative overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="absolute right-0 top-0 w-48 h-48 rounded-full -mr-16 -mt-16 opacity-10"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
                <CalendarDays className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest">{isEdit ? "Edit Visit" : "Schedule Visit"}</p>
                <h2 className="text-white font-bold text-base">{isEdit ? "Update visit details" : "Create a new client visit"}</h2>
              </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all active:scale-90">
              <X className="h-4 w-4 text-white" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-3.5">
          {/* Bulk toggle */}
          {!isEdit && (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50">
              <CalendarRange className="h-4 w-4 text-purple-500 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Multi-date scheduling</p>
                <p className="text-[10px] text-slate-400">Pick multiple dates at once from a calendar</p>
              </div>
              <button onClick={() => setBulkMode(b => !b)}
                className={cn("relative h-5 w-9 rounded-full transition-colors flex-shrink-0", bulkMode ? "bg-purple-500" : "bg-slate-300 dark:bg-slate-600")}>
                <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", bulkMode ? "translate-x-4" : "translate-x-0.5")} />
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Client *</label>
              <select value={form.client_id} onChange={e => set("client_id", e.target.value)} className={inputCls}>
                <option value="">Select client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
              </select>
            </div>
            {canAssign && (
              <div>
                <label className={labelCls}>Assigned To</label>
                <select value={form.assigned_to} onChange={e => set("assigned_to", e.target.value)} className={inputCls}>
                  <option value={currentUser.id}>Me ({currentUser.full_name})</option>
                  {users.filter(u => u.id !== currentUser.id && u.is_active).map(u =>
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  )}
                </select>
              </div>
            )}
          </div>

          <AnimatePresence>
            {dupWarning && <DuplicateWarning existing={dupWarning} />}
            {checkingDup && (
              <motion.div key="checking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" />Checking for duplicates…
              </motion.div>
            )}
          </AnimatePresence>

          {/* Date / bulk calendar */}
          {bulkMode ? (
            <div>
              <label className={labelCls}>
                Select Dates {bulkDates.length > 0 && <span className="ml-2 font-bold" style={{ color: COLORS.mediumBlue }}>{bulkDates.length} selected</span>}
              </label>
              <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-slate-50/50 dark:bg-slate-800/30">
                <div className="flex items-center justify-between mb-2">
                  <button onClick={() => setBulkCalMonth(m => subMonths(m, 1))} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors">
                    <ChevronLeft className="h-4 w-4 text-slate-500" />
                  </button>
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{format(bulkCalMonth, "MMMM yyyy")}</span>
                  <button onClick={() => setBulkCalMonth(m => addMonths(m, 1))} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors">
                    <ChevronRight className="h-4 w-4 text-slate-500" />
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => <div key={d} className="text-[9px] font-black text-slate-400 py-1 uppercase">{d}</div>)}
                  {Array(startOfMonth(bulkCalMonth).getDay()).fill(null).map((_, i) => <div key={`e${i}`} />)}
                  {calDays.map(d => {
                    const s = format(d, "yyyy-MM-dd");
                    const sel = bulkDates.includes(s);
                    const past = isBefore(d, new Date()) && !isToday(d);
                    return (
                      <button key={s} disabled={past} onClick={() => !past && toggleBulkDate(d)}
                        className={cn("rounded-xl py-1.5 text-xs font-semibold transition-all",
                          sel ? "text-white shadow-sm scale-105" : past ? "text-slate-300 dark:text-slate-600 cursor-not-allowed" : "text-slate-700 dark:text-slate-200 hover:bg-blue-50 dark:hover:bg-blue-950/30")}
                        style={sel ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` } : {}}>
                        {format(d, "d")}
                      </button>
                    );
                  })}
                </div>
                {bulkDates.length > 0 && (
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex flex-wrap gap-1 flex-1">
                      {bulkDates.sort().slice(0, 4).map(d => (
                        <span key={d} className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                          {safeFormat(d, "MMM d")}
                        </span>
                      ))}
                      {bulkDates.length > 4 && <span className="text-[9px] text-slate-400 font-medium">+{bulkDates.length - 4} more</span>}
                    </div>
                    <button onClick={() => setBulkDates([])} className="text-[9px] text-red-400 hover:text-red-600 font-semibold flex-shrink-0 ml-2">Clear all</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Date *</label>
                <input type="date" value={form.visit_date} onChange={e => set("visit_date", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Time</label>
                <input type="time" value={form.visit_time} onChange={e => set("visit_time", e.target.value)} className={inputCls} />
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>Purpose *</label>
            <input value={form.purpose} onChange={e => set("purpose", e.target.value)} placeholder="e.g. Annual GST review meeting" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Services</label>
              <input value={form.services} onChange={e => set("services", e.target.value)} placeholder="GST, ITR, ROC…" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Priority</label>
              <select value={form.priority} onChange={e => set("priority", e.target.value)} className={inputCls}>
                {Object.entries(PRIORITY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Location / Address</label>
            <input value={form.location} onChange={e => set("location", e.target.value)} placeholder="Address or Google Maps link" className={inputCls} />
          </div>

          {!isEdit && !bulkMode && (
            <div>
              <button type="button" onClick={() => setShowRecur(r => !r)}
                className={cn("w-full flex items-center justify-between gap-2.5 p-3 rounded-xl border transition-all text-left",
                  showRecur
                    ? "border-purple-200 dark:border-purple-800 bg-purple-50/60 dark:bg-purple-950/20"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 bg-slate-50/50 dark:bg-slate-800/30")}>
                <div className="flex items-center gap-2">
                  <Repeat className={cn("h-3.5 w-3.5", showRecur ? "text-purple-500" : "text-slate-400")} />
                  <span className={cn("text-xs font-semibold", showRecur ? "text-purple-700 dark:text-purple-300" : "text-slate-600 dark:text-slate-300")}>
                    {showRecur
                      ? (form.recurrence !== "none" ? "Recurring — " + (RECURRENCE_OPTIONS.find(o => o.value === form.recurrence)?.label || "") : "Set recurrence…")
                      : "Add recurring schedule"}
                  </span>
                </div>
                <ChevronDown className={cn("h-3.5 w-3.5 text-slate-400 transition-transform", showRecur && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showRecur && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden mt-2">
                    <RecurrenceSection form={form} set={set} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <div>
            <label className={labelCls}>Notes</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} placeholder="Any pre-visit notes or reminders…" className={cn(inputCls, "resize-none")} />
          </div>

          <div className="flex gap-2.5 pt-1">
            <Button variant="outline" onClick={onClose} className="flex-1 rounded-xl h-10 text-sm border-slate-200 dark:border-slate-700">Cancel</Button>
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !canSave}
              className="flex-1 rounded-xl h-10 text-sm text-white font-bold shadow-sm disabled:opacity-50"
              style={{ background: canSave ? `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` : undefined }}>
              {saveMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              {isEdit ? "Save Changes" : bulkMode ? `Schedule ${bulkDates.length || "…"} Visits` : "Schedule Visit"}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Visit Detail Panel ───────────────────────────────────────────────────────
function VisitDetailPanel({ visit, currentUser, onClose, onEdit, onDeleted }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [outcome, setOutcome] = useState(visit?.outcome || "");
  const [showStatusMenu, setShowStatusMenu] = useState(false);

  const isAdmin = currentUser.role === "admin";
  const canWrite = canUserWriteVisit(currentUser, visit);
  const canDelete = canUserDeleteVisit(currentUser, visit);

  const statusMut = useMutation({
    mutationFn: (status) => api.patch(`/visits/${visit.id}`, { status }),
    onSuccess: (_, status) => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["visits"] });
      setShowStatusMenu(false);
      // Remove linked email event from Action Center when visit is completed (best-effort)
      if (status === "completed" && visit.event_id) {
        api.delete(`/email/events/${visit.event_id}`).catch(() => {});
      }
      onDeleted?.();
    },
    onError: err => toast.error(err.response?.data?.detail || "Update failed"),
  });

  const outcomeMut = useMutation({
    mutationFn: () => api.patch(`/visits/${visit.id}`, { outcome }),
    onSuccess: () => { toast.success("Outcome saved ✓"); qc.invalidateQueries({ queryKey: ["visits"] }); },
    onError: err => toast.error(err.response?.data?.detail || "Save failed"),
  });

  const commentMut = useMutation({
    mutationFn: () => api.post(`/visits/${visit.id}/comments`, { text: comment }),
    onSuccess: () => { toast.success("Comment added"); setComment(""); qc.invalidateQueries({ queryKey: ["visits"] }); onDeleted?.(); },
    onError: err => toast.error(err.response?.data?.detail || "Failed"),
  });

  const deleteCommentMut = useMutation({
    mutationFn: (cid) => api.delete(`/visits/${visit.id}/comments/${cid}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["visits"] }); onDeleted?.(); },
    onError: err => toast.error(err.response?.data?.detail || "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/visits/${visit.id}`),
    onSuccess: () => {
      toast.success("Visit deleted");
      qc.invalidateQueries({ queryKey: ["visits"] });
      // Also remove the linked email event from Action Center (best-effort)
      if (visit.event_id) {
        api.delete(`/email/events/${visit.event_id}`).catch(() => {});
      }
      onDeleted?.();
      onClose();
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: ["visits"] });
      if (err.response?.status === 404) { toast.info("Visit was already removed."); onClose(); }
      else if (err.response?.status === 403) toast.error("You don't have permission to delete this visit.");
      else toast.error(err.response?.data?.detail || "Delete failed");
    },
  });

  return (
    <motion.div
      className="fixed inset-0 z-[9000] flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <motion.div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 sm:rounded-3xl rounded-t-3xl shadow-2xl border border-slate-200 dark:border-slate-700"
        initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}>
        <div className="flex justify-center pt-2.5 pb-0 sm:hidden">
          <div className="w-8 h-1 rounded-full bg-slate-300 dark:bg-slate-600" />
        </div>

        {/* Detail header matching Dashboard modal header */}
        <div className="sticky top-0 z-10 px-5 py-4 relative overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="absolute right-0 top-0 w-32 h-32 rounded-full -mr-8 -mt-8 opacity-10"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
          <div className="relative flex items-center justify-between gap-2">
            <StatusBadge status={visit.status} size="md" />
            <div className="flex items-center gap-1">
              {canWrite && (
                <>
                  <button onClick={onEdit} className="p-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white transition-all active:scale-90">
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <div className="relative">
                    <button onClick={() => setShowStatusMenu(s => !s)} className="p-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white transition-all active:scale-90">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <AnimatePresence>
                      {showStatusMenu && (
                        <motion.div
                          className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden z-50 p-1"
                          initial={{ opacity: 0, y: -6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.95 }}>
                          {Object.entries(STATUS_META).map(([s, m]) => (
                            <button key={s} onClick={() => statusMut.mutate(s)}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors text-left">
                              <m.icon className={cn("h-3 w-3", m.color)} />
                              <span className={cn("font-semibold", m.color)}>{m.label}</span>
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}
              {canDelete && (
                <button onClick={() => window.confirm("Delete this visit?") && deleteMut.mutate()} disabled={deleteMut.isPending}
                  className="p-1.5 rounded-xl bg-white/15 hover:bg-red-500/80 text-white transition-all active:scale-90">
                  {deleteMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              )}
              <button onClick={onClose} className="p-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white transition-all active:scale-90">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-bold text-base text-slate-800 dark:text-slate-100 leading-snug">{visit.purpose || "(no purpose)"}</h2>
              <PriorityDot priority={visit.priority} />
            </div>
            <div className="flex items-center gap-1.5 mt-1.5">
              <Building2 className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{visit.client_name || "—"}</span>
            </div>
          </div>

          {(visit.status === "scheduled" || visit.status === "rescheduled") && (
            <div className={`flex items-center gap-3 p-3 rounded-xl border ${false ? "" : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"}`}>
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex-1">Was this visit completed?</p>
              <QuickStatusButtons visit={visit} onDone={onDeleted} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: Calendar, label: "Date", value: safeFormat(visit.visit_date, "MMM d, yyyy") },
              { icon: Clock, label: "Time", value: visit.visit_time || "—" },
              { icon: User, label: "Assigned To", value: visit.assigned_to_name || "—" },
              { icon: MapPin, label: "Location", value: visit.location || "—" },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-start gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700">
                <Icon className="h-3.5 w-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-[9px] text-slate-400 uppercase tracking-wider font-bold">{label}</p>
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mt-0.5 break-words">{value}</p>
                </div>
              </div>
            ))}
          </div>

          {visit.recurrence && visit.recurrence !== "none" && (
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900">
              <Repeat className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />
              <p className="text-xs font-semibold text-purple-700 dark:text-purple-300">
                {visit.recurrence === "nth_weekday"
                  ? `Recurring — ${WEEK_NUMBERS.find(w => w.value === visit.recurrence_week_number)?.label || ""} ${WEEKDAYS[visit.recurrence_weekday] || ""} of each month`
                  : visit.recurrence === "last_weekday"
                  ? `Recurring — last ${WEEKDAYS[visit.recurrence_weekday] || ""} of each month`
                  : `Recurring — ${visit.recurrence}`}
                {visit.recurrence_end_date && ` until ${safeFormat(visit.recurrence_end_date, "MMM d, yyyy")}`}
              </p>
            </div>
          )}

          {visit.services?.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Services</p>
              <div className="flex flex-wrap gap-1">
                {visit.services.map(s => (
                  <span key={s} className="px-2 py-0.5 rounded-lg text-[11px] font-semibold"
                    style={{ background: `${COLORS.mediumBlue}12`, color: COLORS.mediumBlue, border: `1px solid ${COLORS.mediumBlue}20` }}>
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {visit.notes && (
            <div className="p-3 rounded-xl bg-amber-50/80 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900">
              <p className="text-[9px] font-black text-amber-600 uppercase tracking-wider mb-1">Notes</p>
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">{visit.notes}</p>
            </div>
          )}

          <div>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Outcome / Result</p>
            <div className="flex gap-2">
              <textarea value={outcome} onChange={e => setOutcome(e.target.value)} rows={2} placeholder="What happened during the visit?"
                className="flex-1 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none" />
              <button onClick={() => outcomeMut.mutate()} disabled={outcomeMut.isPending}
                className="px-3 rounded-xl text-white text-xs font-bold disabled:opacity-60 shadow-sm"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {outcomeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Comments {visit.comments?.length > 0 && `(${visit.comments.length})`}
            </p>
            <div className="space-y-1.5 mb-2 max-h-44 overflow-y-auto slim-scroll" style={slimScroll}>
              <AnimatePresence>
                {(visit.comments || []).map(c => (
                  <motion.div key={c.id} variants={itemVariants} initial="hidden" animate="visible" exit="exit"
                    className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-black flex-shrink-0"
                      style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                      {c.user_name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{c.user_name}</span>
                        <span className="text-[9px] text-slate-400">{safeFormat(c.created_at, "MMM d, h:mm a")}</span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 break-words">{c.text}</p>
                    </div>
                    {(c.user_id === currentUser.id || isAdmin) && (
                      <button onClick={() => deleteCommentMut.mutate(c.id)} className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0 mt-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
              {(!visit.comments || visit.comments.length === 0) && (
                <p className="text-xs text-slate-400 text-center py-4">No comments yet</p>
              )}
            </div>
            <div className="flex gap-2">
              <input value={comment} onChange={e => setComment(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && comment.trim() && commentMut.mutate()}
                placeholder="Add a comment (Enter to send)…"
                className="flex-1 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400" />
              <button onClick={() => comment.trim() && commentMut.mutate()} disabled={!comment.trim() || commentMut.isPending}
                className="px-3 rounded-xl text-white disabled:opacity-50"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Month Calendar ───────────────────────────────────────────────────────────
function MonthCalendar({ visits, currentMonth, onDayClick }) {
  const days = eachDayOfInterval({ start: startOfMonth(currentMonth), end: endOfMonth(currentMonth) });
  const startDay = startOfMonth(currentMonth).getDay();

  const visitsByDate = useMemo(() => {
    const map = {};
    visits.forEach(v => {
      if (!v.visit_date) return;
      if (!map[v.visit_date]) map[v.visit_date] = [];
      map[v.visit_date].push(v);
    });
    return map;
  }, [visits]);

  return (
    <div className="grid grid-cols-7 gap-1">
      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
        <div key={d} className="text-center text-[9px] font-black text-slate-400 uppercase tracking-widest py-2">{d}</div>
      ))}
      {Array(startDay).fill(null).map((_, i) => <div key={`e${i}`} />)}
      {days.map(d => {
        const key = format(d, "yyyy-MM-dd");
        const dayVis = visitsByDate[key] || [];
        const today = isToday(d);
        return (
          <motion.button key={key} whileHover={{ scale: 1.02, transition: springPhysics.lift }} whileTap={{ scale: 0.97, transition: springPhysics.tap }}
            onClick={() => onDayClick(d, dayVis)}
            className={cn("min-h-[68px] p-1.5 rounded-xl border text-left transition-all",
              today
                ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 shadow-sm"
                : "border-slate-100 dark:border-slate-800 hover:border-blue-200 dark:hover:border-blue-900 bg-white dark:bg-slate-800/50 hover:shadow-sm")}>
            <span className={cn("text-xs font-bold", today ? "text-blue-600 dark:text-blue-400" : "text-slate-600 dark:text-slate-300")}>{format(d, "d")}</span>
            <div className="mt-0.5 space-y-0.5 overflow-hidden">
              {dayVis.slice(0, 2).map(v => {
                const m = STATUS_META[v.status] || STATUS_META.scheduled;
                return (
                  <div key={v.id} className={cn("text-[8px] font-bold px-1 py-0.5 rounded-md truncate", m.bg, m.color)}>
                    {v.client_name || v.purpose || "—"}
                  </div>
                );
              })}
              {dayVis.length > 2 && <div className="text-[8px] text-slate-400 font-semibold px-1">+{dayVis.length - 2} more</div>}
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}

// ─── Virtualized Row Renderer ────────────────────────────────────────────────
const Row = ({ index, style, data }) => {
  const {
    visits,
    currentUser,
    onClick,
    onEdit,
    selectedIds,
    toggleSelect,
    selectionMode,
  } = data;

  const v = visits[index];

  // skip invalid (already handled but extra safe)
  if (!v || !v.id) return null;

  return (
    <div style={{ ...style, padding: "6px 8px" }}>
      <VisitCard
        v={v}
        currentUser={currentUser}
        onClick={() => onClick(v)}
        onEdit={onEdit}
        selected={selectedIds?.includes(v.id)}
        onSelectToggle={toggleSelect}
        selectionMode={selectionMode}
      />
    </div>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function VisitsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [viewMode, setViewMode] = useState("list");
  const [showCustomize, setShowCustomize] = useState(false);
  const VP_SECTIONS = ['key_metrics','controls','main_content'];
  const VP_LABELS = {
    key_metrics:  { name:'Key Metrics',       icon:'📊', desc:'Total, scheduled, completed and missed visits' },
    controls:     { name:'Controls & Filters',icon:'🔧', desc:'Month navigation, status filters and search' },
    main_content: { name:'Visit List / Calendar', icon:'🗓️', desc:'All visit cards in list or calendar view' },
  };
  const { order: vpOrder, moveSection: vpMove, resetOrder: vpReset } = usePageLayout('visitspage', VP_SECTIONS);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterUser, setFilterUser] = useState(() => {
    // Non-admin/non-mgr with cross-visibility: default to own visits
    const storedUser = (() => { try { return JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null'); } catch { return null; } })();
    const role = storedUser?.role;
    if (role === 'admin' || role === 'manager') return 'all';
    const perms = storedUser?.permissions || {};
    if (perms.view_other_visits?.length || perms.can_view_all_visits) return storedUser?.id || 'all';
    return 'all';
  });
  const [showForm, setShowForm] = useState(false);
  const [editingVisit, setEditingVisit] = useState(null);
  const [selectedVisit, setSelectedVisit] = useState(null);
  const [selectedDayVis, setSelectedDayVis] = useState(null);
  const [showEmailImport, setShowEmailImport] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showBulkDialog, setShowBulkDialog] = useState(false);

  const monthStr = format(currentMonth, "yyyy-MM");
  const isAdmin = user?.role === "admin";
  const isMgr = user?.role === "manager";

  const { data: visits = [], isLoading } = useQuery({
    queryKey: ["visits", monthStr, filterStatus, filterUser],
    queryFn: () => {
      // For non-admin/non-mgr cross-vis users: "all" means their own visits
      const effectiveUserId = filterUser !== "all"
        ? filterUser
        : (!isAdmin && !isMgr && hasCrossVisibility)
          ? user?.id
          : undefined;
      return fetchVisits({ month: monthStr, status: filterStatus !== "all" ? filterStatus : undefined, user_id: effectiveUserId });
    },
    staleTime: 0,
  });

  const { data: clients = [] } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: fetchUsers, enabled: true });
  // Cross-visibility: explicit perms OR backend returned other users (already filtered by cross-vis)
  const hasCrossVisibility = !!(user?.permissions?.view_other_visits?.length || user?.permissions?.can_view_all_visits || users.some(u => u.id !== user?.id));
  const summary = useMemo(() => {
    const total = visits.length;
    const by_status = {};
    visits.forEach(v => {
      const s = v.status || "scheduled";
      by_status[s] = (by_status[s] || 0) + 1;
    });
    const completed = by_status.completed || 0;
    return {
      total,
      by_status,
      completion_rate: total ? Math.round((completed / total) * 1000) / 10 : 0,
    };
  }, [visits]);

  useEffect(() => {
    if (selectedVisit) {
      const updated = visits.find(v => v.id === selectedVisit.id);
      if (updated) setSelectedVisit(updated);
    }
  }, [visits]);

  useEffect(() => {
    if (selectionMode) {
      setSelectedIds(prev => {
        const validIds = visits.map(v => v.id);
        return prev.filter(id => validIds.includes(id));
      });
    }
  }, [visits]);

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id]
    );
  }, []);

  const deletableVisits = useMemo(() => visits.filter(v => canUserDeleteVisit(user, v)), [visits, user]);
  const allDeletableSelected = deletableVisits.length > 0 && deletableVisits.every(v => selectedIds.includes(v.id));
  const someDeletableSelected = deletableVisits.some(v => selectedIds.includes(v.id));

  const toggleSelectAll = () => {
    if (allDeletableSelected) setSelectedIds([]);
    else setSelectedIds(deletableVisits.map(v => v.id));
  };

  const exitSelectionMode = () => { setSelectionMode(false); setSelectedIds([]); };

  const bulkDeleteMut = useMutation({
    mutationFn: ({ ids, deleteRecurrences }) =>
      api.post("/visits/bulk-delete", { visit_ids: ids, delete_recurrences: deleteRecurrences }),
    onSuccess: (res) => {
      const { deleted = [], forbidden = [], not_found = [] } = res.data || {};
      if (deleted.length > 0) toast.success(`Deleted ${deleted.length} visit${deleted.length !== 1 ? "s" : ""} successfully.`);
      if (forbidden.length > 0) toast.warning(`${forbidden.length} visit${forbidden.length !== 1 ? "s" : ""} could not be deleted (no permission).`);
      if (not_found.length > 0) toast.info(`${not_found.length} visit${not_found.length !== 1 ? "s were" : " was"} already removed.`);
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["visits-upcoming-dashboard"] });
      setShowBulkDialog(false);
      exitSelectionMode();
    },
    onError: (err) => toast.error(err.response?.data?.detail || "Bulk delete failed"),
  });

  // ── Metric data (matching Dashboard metric card pattern) ──────────────────
  const metricCardCls = "rounded-2xl shadow-sm hover:shadow-lg transition-all cursor-default group border";
  const metricCardDefault = "bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600";

  const statCards = [
    { label: "Total", value: summary?.total || 0, color: COLORS.deepBlue, iconBg: `${COLORS.deepBlue}12`, icon: Target },
    { label: "Completed", value: summary?.by_status?.completed || 0, color: COLORS.emeraldGreen, iconBg: `${COLORS.emeraldGreen}12`, icon: CheckCircle2, rate: summary?.completion_rate },
    { label: "Upcoming", value: (summary?.by_status?.scheduled || 0) + (summary?.by_status?.rescheduled || 0), color: COLORS.mediumBlue, iconBg: `${COLORS.mediumBlue}12`, icon: Clock },
    { label: "Missed", value: (summary?.by_status?.missed || 0) + (summary?.by_status?.cancelled || 0), color: COLORS.coral, iconBg: `${COLORS.coral}15`, icon: AlertCircle },
  ];

  const handleEmailEvent = useCallback((event) => {
    setEditingVisit({
      purpose: event.title || "",
      visit_date: event.date || format(new Date(), "yyyy-MM-dd"),
      visit_time: event.time || "",
      location: event.location || "",
      notes: [
        event.description ? `Notes: ${event.description.slice(0, 300)}` : "",
        event.organizer ? `Organiser: ${event.organizer}` : "",
        event.source_from ? `From email: ${event.source_from}` : "",
      ].filter(Boolean).join("\n"),
      priority: event.urgency === "urgent" ? "urgent" : event.urgency === "high" ? "high" : "medium",
      client_id: "",
      assigned_to: user?.id || "",
      services: event.event_type === "hearing" ? "Trademark, Legal" : "",
    });
    setShowForm(true);
  }, [user]);

  return (
    <>
      <LayoutCustomizer
      isOpen={showCustomize}
      onClose={() => setShowCustomize(false)}
      order={vpOrder}
      sectionLabels={VP_LABELS}
      onDragEnd={vpMove}
      onReset={vpReset}
      isDark={false}
    />
    <motion.div className="space-y-4" variants={containerVariants} initial="hidden" animate="visible">

    {/* ── Welcome Banner (matching Dashboard) ──────────────────────────── */}
      <motion.div variants={itemVariants}>
        <div className="relative overflow-hidden rounded-2xl px-6 py-5"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`, boxShadow: `0 8px 32px rgba(13,59,102,0.28)` }}>
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
          <div className="absolute right-24 bottom-0 w-32 h-32 rounded-full mb-[-30px] opacity-5" style={{ background: "white" }} />
          <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            <div>
              <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest mb-1">{format(currentMonth, "MMMM yyyy")} · {visits.length} visit{visits.length !== 1 ? "s" : ""}</p>
              <h1 className="text-2xl font-bold text-white tracking-tight">Client Visits 🗺️</h1>
              <p className="text-white/60 text-sm mt-1">
                Schedule and track client visits{filterStatus !== "all" ? ` · ${STATUS_META[filterStatus]?.label}` : ""}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 w-full lg:w-[720px] lg:max-w-[720px] min-w-0 items-stretch">
              {/* View toggle */}
              <div className="flex min-w-0 rounded-xl p-0.5" style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)" }}>
                {[["list", ClipboardList], ["calendar", CalendarDays]].map(([mode, Icon]) => (
                  <button key={mode} onClick={() => setViewMode(mode)}
                    className={cn("flex flex-1 min-w-0 items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all",
                      viewMode === mode ? "bg-white shadow-sm" : "text-white/70 hover:text-white")}
                    style={viewMode === mode ? { color: COLORS.deepBlue } : {}}>
                    <Icon className="h-3.5 w-3.5 flex-shrink-0" /><span className="capitalize">{mode}</span>
                  </button>
                ))}
              </div>
              <motion.button whileHover={{ scale: 1.03, y: -2, transition: springPhysics.card }} whileTap={{ scale: 0.97, transition: springPhysics.tap }}
                onClick={() => setShowEmailImport(true)}
                className="w-full min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl font-semibold text-sm whitespace-nowrap transition-all"
                style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)", color: "white" }}>
                <Mail className="h-4 w-4 flex-shrink-0" />From Email
              </motion.button>
              <motion.button whileHover={{ scale: 1.03, y: -2, transition: springPhysics.card }} whileTap={{ scale: 0.97, transition: springPhysics.tap }}
                onClick={() => { setEditingVisit(null); setShowForm(true); }}
                className="w-full min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl font-bold text-sm whitespace-nowrap bg-white/95 shadow-lg transition-all"
                style={{ color: COLORS.deepBlue }}>
                <Plus className="h-4 w-4 flex-shrink-0" />Schedule
              </motion.button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* CUSTOMIZE BUTTON */}
      <motion.div variants={itemVariants} className="flex justify-end">
        <button
          onClick={() => setShowCustomize(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold border transition-all hover:shadow-md bg-white border-slate-200 text-slate-500 hover:border-slate-300"
        >
          <Settings2 size={13} /> Customize Layout
        </button>
      </motion.div>

      {/* ORDERED SECTIONS */}
      {vpOrder.map((sectionId) => {
        if (sectionId === 'key_metrics') return (
      <React.Fragment key="key_metrics">
      {/* ── Key Metrics (matching Dashboard metric cards) ─────────────────── */}
      <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3" variants={itemVariants}>
        {statCards.map(({ label, value, color, iconBg, icon: Icon, rate }) => (
          <motion.div key={label}
            whileHover={{ y: -3, transition: springPhysics.card }}
            whileTap={{ scale: 0.985, transition: springPhysics.tap }}
            className={`${metricCardCls} ${metricCardDefault}`}>
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
                  <p className="text-2xl font-bold mt-1 tracking-tight" style={{ color }}>{value}</p>
                </div>
                <div className="p-2 rounded-xl group-hover:scale-110 transition-transform" style={{ backgroundColor: iconBg }}>
                  <Icon className="h-4 w-4" style={{ color }} />
                </div>
              </div>
              {rate !== undefined && (
                <div className="mt-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Completion</span>
                    <span className="text-[10px] font-black" style={{ color: COLORS.emeraldGreen }}>{rate}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700">
                    <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${COLORS.emeraldGreen}, ${COLORS.lightGreen})` }}
                      initial={{ width: 0 }} animate={{ width: `${rate}%` }} transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }} />
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </motion.div>

      </React.Fragment>
        );
        if (sectionId === 'controls') return (
      <React.Fragment key="controls">
      {/* ── Controls ── */}
      <motion.div variants={itemVariants} className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-2 py-1.5 shadow-sm">
          <button onClick={() => setCurrentMonth(m => subMonths(m, 1))} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
            <ChevronLeft className="h-4 w-4 text-slate-500" />
          </button>
          <span className="text-sm font-bold text-slate-700 dark:text-slate-200 w-28 text-center">{format(currentMonth, "MMM yyyy")}</span>
          <button onClick={() => setCurrentMonth(m => addMonths(m, 1))} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
            <ChevronRight className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="relative">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm">
            <option value="all">All Statuses</option>
            {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </div>
        {(isAdmin || isMgr) && (
          <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm">
            <option value="all">All Users</option>
            {users.filter(u => u.is_active).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        )}
        {!isAdmin && !isMgr && (() => {
          const perms = user?.permissions || {};
          const allowed = perms.view_other_visits || [];
          const canViewAll = !!perms.can_view_all_visits;
          // Fallback: if backend returned other users (cross-vis), show them
          const otherUsers = users.filter(u => u.is_active && u.id !== user?.id);
          if (!canViewAll && allowed.length === 0 && otherUsers.length === 0) return null;
          const permittedUsers = canViewAll
            ? otherUsers
            : allowed.length > 0 ? users.filter(u => u.is_active && allowed.includes(u.id)) : otherUsers;
          if (permittedUsers.length === 0) return null;
          return (
            <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm">
              <option value={user?.id || "all"}>My Visits</option>
              {permittedUsers.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          );
        })()}
        <button onClick={() => setCurrentMonth(new Date())}
          className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors font-semibold shadow-sm">
          Today
        </button>
        {viewMode === "list" && deletableVisits.length > 0 && (
          <button onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
            className={cn("flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-bold transition-all shadow-sm",
              selectionMode
                ? "border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30"
                : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50")}>
            {selectionMode ? <><X className="h-3.5 w-3.5" />Cancel</> : <><CheckSquare className="h-3.5 w-3.5" />Select</>}
          </button>
        )}
        {(filterStatus !== "all" || filterUser !== "all") && (
          <button onClick={() => { setFilterStatus("all"); setFilterUser((!isAdmin && !isMgr && hasCrossVisibility) ? (user?.id || "all") : "all"); }}
            className="flex items-center gap-1 px-3 py-2 rounded-xl text-sm font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 border border-red-100 dark:border-red-900 transition-colors">
            <X className="h-3.5 w-3.5" />Clear
          </button>
        )}
      </motion.div>

      {/* ── Bulk action bar ── */}
      <AnimatePresence>
        {selectionMode && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
            className="sticky top-2 z-40 flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl border bg-white/95 dark:bg-slate-800/95 border-slate-200/80 dark:border-slate-700"
            style={{ backdropFilter: "blur(12px)" }}>
            <button onClick={toggleSelectAll}
              className="flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 transition-colors">
              <div className={cn("h-5 w-5 rounded-md border-2 flex items-center justify-center transition-colors",
                allDeletableSelected ? "bg-blue-500 border-blue-500" :
                someDeletableSelected ? "bg-blue-100 border-blue-400" : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800")}>
                {allDeletableSelected ? <Check className="h-3 w-3 text-white" /> :
                 someDeletableSelected ? <Minus className="h-3 w-3 text-blue-500" /> : null}
              </div>
              {allDeletableSelected ? "Deselect all" : `Select all (${deletableVisits.length})`}
            </button>
            <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
            <span className="text-sm text-slate-500 flex-1">
              {selectedIds.length > 0 ? <><span className="font-bold text-blue-600">{selectedIds.length}</span> selected</> : "Tap visits to select"}
            </span>
            {selectedIds.length > 0 && (
              <button onClick={() => setShowBulkDialog(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-white text-sm font-bold"
                style={{ background: "linear-gradient(135deg, #DC2626, #B91C1C)" }}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />Delete {selectedIds.length}
              </button>
            )}
            <button onClick={exitSelectionMode} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      </React.Fragment>
        );
        if (sectionId === 'main_content') return (
      <React.Fragment key="main_content">
      {/* ── Main content ── */}
      <motion.div variants={itemVariants}>
        {isLoading ? (
          <div className="space-y-1.5">{Array(5).fill(0).map((_, i) => <SkeletonCard key={i} />)}</div>
        ) : visits.length === 0 ? (
          <SectionCard>
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="p-4 rounded-2xl" style={{ background: `${COLORS.deepBlue}12` }}>
                <CalendarDays className="h-7 w-7" style={{ color: COLORS.deepBlue }} />
              </div>
              <div className="text-center">
                <p className="font-bold text-slate-700 dark:text-slate-200">No visits for {format(currentMonth, "MMMM yyyy")}</p>
                <p className="text-sm text-slate-400 mt-1">Schedule a client visit to get started</p>
              </div>
              <motion.button whileHover={{ y: -2, transition: springPhysics.lift }} whileTap={{ scale: 0.97, transition: springPhysics.tap }}
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-white text-sm font-bold shadow-sm"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                <Plus className="h-4 w-4" />Schedule First Visit
              </motion.button>
            </div>
          </SectionCard>
        ) : viewMode === "calendar" ? (
          <SectionCard>
            <CardHeaderRow
              iconBg="bg-blue-50 dark:bg-blue-900/40"
              icon={<CalendarDays className="h-4 w-4 text-blue-500" />}
              title={format(currentMonth, "MMMM yyyy")}
              subtitle={`${visits.length} visits this month`}
              badge={visits.filter(v => isToday(safeParseISO(v.visit_date) || new Date(0)) && v.status === "scheduled").length || undefined}
            />
            <div className="p-4">
              <MonthCalendar visits={visits} currentMonth={currentMonth}
                onDayClick={(d, dayVis) => {
                  if (dayVis.length === 1) setSelectedVisit(dayVis[0]);
                  else if (dayVis.length > 1) setSelectedDayVis({ date: d, visits: dayVis });
                  else { setEditingVisit({ visit_date: format(d, "yyyy-MM-dd") }); setShowForm(true); }
                }} />
            </div>
          </SectionCard>
        ) : (
          <SectionCard>
            <CardHeaderRow
              iconBg="bg-teal-50 dark:bg-teal-900/40"
              icon={<MapPin className="h-4 w-4 text-teal-500" />}
              title="Client Visits"
              subtitle={`${format(currentMonth, "MMMM yyyy")} · ${visits.length} visit${visits.length !== 1 ? "s" : ""}`}
              badge={visits.filter(v => { const p = safeParseISO(v.visit_date); return p && isToday(p) && v.status === "scheduled"; }).length || undefined}
            />
            <div className="p-3">
              {/* VIRTUALIZED LIST - REPLACED THE OLD visits.map() */}
              <div style={{ height: "calc(100vh - 220px)" }}>
                <List
                  height={window.innerHeight - 220}
                  itemCount={visits.length}
                  itemSize={88}
                  width="100%"
                  itemData={{
                    visits,
                    currentUser: user,
                    onClick: (v) => {
                      setSelectedVisit(v);
                    },
                    onEdit: (v) => {
                      setEditingVisit(v);
                      setShowForm(true);
                    },
                    selectedIds,
                    toggleSelect,
                    selectionMode,
                  }}
                >
                  {Row}
                </List>
              </div>
            </div>
            {visits.length > 0 && (
              <div className={`px-4 py-2.5 border-t flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50 border-slate-100 dark:border-slate-700`}>
                <div className="flex items-center gap-3">
                  {visits.filter(v => v.status === "completed").length > 0 && <span className="text-xs font-bold text-emerald-500">{visits.filter(v => v.status === "completed").length} Completed</span>}
                  {visits.filter(v => v.status === "scheduled").length > 0 && <span className="text-xs font-bold text-blue-500">{visits.filter(v => v.status === "scheduled").length} Scheduled</span>}
                  {visits.filter(v => v.status === "missed").length > 0 && <span className="text-xs font-bold text-orange-500">{visits.filter(v => v.status === "missed").length} Missed</span>}
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  <span className="font-bold text-slate-700 dark:text-slate-300">{visits.length}</span> total
                </p>
              </div>
            )}
          </SectionCard>
        )}
      </motion.div>

      {/* ── Day multi-visit picker ── */}
      <AnimatePresence>
        {selectedDayVis && (
          <motion.div
            className="fixed inset-0 z-[9000] flex items-center justify-center p-4"
            style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={e => e.target === e.currentTarget && setSelectedDayVis(null)}>
            <motion.div
              className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 dark:border-slate-700"
              initial={{ scale: 0.88, y: 40, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.88, y: 40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 22 }}>
              <div className="px-5 py-4 relative overflow-hidden"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                <div className="absolute right-0 top-0 w-32 h-32 rounded-full -mr-8 -mt-8 opacity-10"
                  style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
                <div className="relative flex items-center justify-between">
                  <div>
                    <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest mb-0.5">Day Overview</p>
                    <h3 className="font-bold text-white">{format(selectedDayVis.date, "MMMM d, yyyy")}</h3>
                    <p className="text-white/60 text-xs">{selectedDayVis.visits.length} visits</p>
                  </div>
                  <button onClick={() => setSelectedDayVis(null)} className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all active:scale-90">
                    <X className="h-4 w-4 text-white" />
                  </button>
                </div>
              </div>
              <div className="p-3 space-y-1.5 max-h-72 overflow-y-auto slim-scroll" style={slimScroll}>
                {selectedDayVis.visits.map(v => (
                  <button key={v.id} onClick={() => { setSelectedVisit(v); setSelectedDayVis(null); }}
                    className={`w-full text-left p-3 rounded-xl border transition-all hover:shadow-sm ${
                      false
                        ? "border-blue-300"
                        : "border-slate-200 dark:border-slate-700 hover:border-blue-200 dark:hover:border-blue-800 bg-slate-50 dark:bg-slate-800 hover:bg-white dark:hover:bg-slate-700"
                    }`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{v.purpose || "(no purpose)"}</p>
                      <StatusBadge status={v.status} />
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">{v.client_name || "—"}</p>
                  </button>
                ))}
              </div>
              <div className="p-3 border-t border-slate-100 dark:border-slate-700">
                <button onClick={() => { setEditingVisit({ visit_date: format(selectedDayVis.date, "yyyy-MM-dd") }); setShowForm(true); setSelectedDayVis(null); }}
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold text-white"
                  style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                  <Plus className="h-3.5 w-3.5" />Add Visit for This Day
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Form modal ── */}
      <AnimatePresence>
        {showForm && (
          <VisitFormModal visit={editingVisit} clients={clients} users={users} currentUser={user}
            onClose={() => { setShowForm(false); setEditingVisit(null); }} />
        )}
      </AnimatePresence>

      {/* ── Detail panel ── */}
      <AnimatePresence>
        {selectedVisit && (
          <VisitDetailPanel visit={selectedVisit} currentUser={user}
            onClose={() => setSelectedVisit(null)}
            onEdit={() => { setEditingVisit(selectedVisit); setShowForm(true); setSelectedVisit(null); }}
            onDeleted={() => {
              qc.invalidateQueries({ queryKey: ["visits"] });
              const updated = visits.find(v => v.id === selectedVisit?.id);
              if (updated) setSelectedVisit(updated);
            }} />
        )}
      </AnimatePresence>

      {/* ── Bulk delete dialog ── */}
      <AnimatePresence>
        {showBulkDialog && (
          <BulkDeleteDialog count={selectedIds.length} isPending={bulkDeleteMut.isPending}
            onCancel={() => setShowBulkDialog(false)}
            onConfirm={(deleteRecurrences) => { bulkDeleteMut.mutate({ ids: selectedIds, deleteRecurrences }); }} />
        )}
      </AnimatePresence>

      </React.Fragment>
        );
        return null;
      })}

      {/* ── Email importer ── */}
      <AnimatePresence>
        {showEmailImport && (
          <EmailEventImporter mode="visit" onSelectEvent={handleEmailEvent} onClose={() => setShowEmailImport(false)} />
        )}
      </AnimatePresence>
    </motion.div>
    </>
  );
}
