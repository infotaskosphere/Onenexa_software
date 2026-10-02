// Reminders.jsx — Dedicated Reminders & Meetings page
// WelcomeBanner + Full Calendar View + Popup Notifications

import { useDark } from "@/hooks/useDark";
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WelcomeBanner } from "@/components/ui/WelcomeBanner";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  format,
  parseISO,
  isPast,
  isToday as dateFnsIsToday,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
  getDay,
} from "date-fns";
import {
  Bell,
  BellRing,
  Plus,
  Trash2,
  X,
  Edit2,
  Clock,
  Calendar as CalendarIcon,
  Users,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Settings2,
  Search,
  List,
  LayoutGrid,
  BellOff,
  CalendarDays,
  RefreshCw,
} from "lucide-react";
import LayoutCustomizer from "../components/layout/LayoutCustomizer";
import { usePageLayout } from "../hooks/usePageLayout";

// ── Constants ────────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue: "#0D3B66",
  mediumBlue: "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  amber: "#F59E0B",
  yellow: "#EAB308",
  coral: "#FF6B6B",
  purple: "#8B5CF6",
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};
const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] },
  },
};
const springPhysics = {
  card: { type: "spring", stiffness: 280, damping: 22, mass: 0.85 },
  lift: { type: "spring", stiffness: 320, damping: 24, mass: 0.9 },
};

const slimScroll = {
  overflowY: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "#cbd5e1 transparent",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveId(r) {
  if (!r) return null;
  const id = r.id ?? r._id ?? r["_id"] ?? null;
  return id ? String(id) : null;
}

function normalizeReminder(r) {
  if (!r) return r;
  return { ...r, id: resolveId(r) };
}

const stripHtml = (str) => (str || "").replace(/<[^>]*>/g, "");

// Converts a Date (or ISO string) into the "YYYY-MM-DDTHH:mm" format a
// <input type="datetime-local"> expects, using LOCAL wall-clock time.
//
// BUG THIS FIXES: code previously did `date.toISOString().slice(0, 16)` to
// pre-fill these inputs. toISOString() always returns UTC, but a
// datetime-local input treats whatever string you give it as LOCAL time.
// So a reminder stored as 2026-08-11T10:00:00Z (= 3:30 PM IST) would show
// in the edit form as "Aug 11, 10:00 AM" — visually correct-looking but 5.5
// hours off. Saving that unedited form then re-submitted a *shifted* UTC
// time, and for reminders scheduled early enough in the local day, that
// shift silently pushed remind_at back across midnight into the previous
// calendar day — which is why editing a reminder (e.g. to mark it
// Adjourned) could make it appear to "vanish" from its original date and
// resurface a day earlier on the calendar. This helper keeps local wall-clock
// time consistent between what's stored, what's displayed, and what's re-saved.
function toDatetimeLocalValue(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime())) return "";
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

const formatReminderTime = (isoStr) => {
  if (!isoStr) return "—";
  try {
    return format(new Date(isoStr), "MMM d, yyyy · h:mm a");
  } catch {
    return "—";
  }
};

const buildGCalURL = (reminder) => {
  try {
    const start = reminder.remind_at ? new Date(reminder.remind_at) : null;
    if (!start) return "#";
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const fmt = (d) =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    return `https://calendar.google.com/calendar/r/eventedit?dates=${fmt(start)}/${fmt(end)}&text=${encodeURIComponent(reminder.title)}&details=${encodeURIComponent(reminder.description || "")}`;
  } catch {
    return "#";
  }
};

// ── Notification helpers ─────────────────────────────────────────────────────
function getFiredIds() {
  try {
    const stored = sessionStorage.getItem("rem_fired_ids");
    return new Set(stored ? JSON.parse(stored) : []);
  } catch {
    return new Set();
  }
}
function addFiredId(id) {
  try {
    const set = getFiredIds();
    set.add(String(id));
    sessionStorage.setItem("rem_fired_ids", JSON.stringify([...set]));
  } catch {}
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendBrowserNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "/favicon.ico", tag: title });
    } catch {}
  }
}

// ── Layout Primitives ────────────────────────────────────────────────────────
function SectionCard({ children, className = "" }) {
  return (
    <div
      className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`}
    >
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
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              {title}
            </h3>
            {badge !== undefined && badge > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-500 text-white leading-none">
                {badge}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && (
        <div className="flex items-center gap-1.5 flex-shrink-0">{action}</div>
      )}
    </div>
  );
}

// ── Hearing status/colour helper ─────────────────────────────────────────────
// Determines the colour-coded status of a "Trademark Hearing" reminder:
//   • favourable            → green   (decision received, in the client's favour)
//   • unfavourable          → amber   (decision received, against the client)
//   • adjourned_no_date     → yellow  (hearing attended & adjourned, next date NOT yet declared/disclosed)
//   • adjourned_dated       → red     (hearing attended & adjourned, next hearing date IS declared/disclosed)
//   • null                  → no special hearing status (falls back to default styling)
function getHearingStatus(rem) {
  if (!rem) return null;
  if (rem.hearing_adjourned) {
    return rem.hearing_next_date_disclosed ? "adjourned_dated" : "adjourned_no_date";
  }
  if (rem.hearing_decision === "favourable") return "favourable";
  if (rem.hearing_decision === "unfavourable") return "unfavourable";
  return null;
}

const HEARING_STATUS_STYLES = {
  favourable:        { solid: "#10b981", solidTo: "#059669", tailwindDot: "bg-emerald-500", tailwindPillLight: "bg-emerald-100 text-emerald-700", tailwindPillDark: "bg-emerald-900/40 text-emerald-300" },
  unfavourable:       { solid: "#f59e0b", solidTo: "#d97706", tailwindDot: "bg-amber-500",   tailwindPillLight: "bg-amber-100 text-amber-700",   tailwindPillDark: "bg-amber-900/40 text-amber-300" },
  adjourned_no_date:  { solid: "#eab308", solidTo: "#ca8a04", tailwindDot: "bg-yellow-500",  tailwindPillLight: "bg-yellow-100 text-yellow-700", tailwindPillDark: "bg-yellow-900/40 text-yellow-300" },
  adjourned_dated:    { solid: "#ef4444", solidTo: "#b91c1c", tailwindDot: "bg-red-500",     tailwindPillLight: "bg-red-100 text-red-600",       tailwindPillDark: "bg-red-900/40 text-red-300" },
};

// ── Shared Reminder Detail Popup ─────────────────────────────────────────────
function ReminderDetailPopup({ rem, isDark, isViewingOther, onClose, onEdit, onDelete, onDismiss, onReschedule, COLORS }) {
  if (!rem) return null;
  const remId = resolveId(rem);
  const isDue = rem.remind_at && isPast(new Date(rem.remind_at));
  const gcalUrl = buildGCalURL(rem);

  return (
    <motion.div
      key="reminder-detail-popup"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{
        background: "rgba(7,15,30,0.72)",
        backdropFilter: "blur(10px)",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.88, y: 40, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.88, y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}
        className={`w-full max-w-xl rounded-3xl overflow-hidden shadow-2xl ${isDark ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Popup Header */}
        <div
          className="px-8 py-7 relative overflow-hidden"
          style={{
            background: (() => {
              const status = getHearingStatus(rem);
              if (status) {
                const s = HEARING_STATUS_STYLES[status];
                return `linear-gradient(135deg, ${s.solid}, ${s.solidTo})`;
              }
              return `linear-gradient(135deg, ${isDue ? COLORS.coral : COLORS.purple}, ${COLORS.mediumBlue})`;
            })(),
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <BellRing className="w-7 h-7 text-white" />
              </div>
              <div>
                <p className="text-white/60 text-[11px] font-semibold uppercase tracking-widest mb-1">
                  {rem.reminder_type === "meeting" ? "Meeting" : "Reminder"}
                  {rem.source === "email_auto" && " · From Email"}
                </p>
                <h2 className="text-xl font-bold text-white leading-tight">
                  {rem.title || "Untitled"}
                </h2>
                {isDue && (
                  <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/20 text-white">
                    OVERDUE
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all flex-shrink-0"
            >
              <X className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>

        {/* Popup Body */}
        <div className="px-8 py-6 space-y-5 max-h-[65vh] overflow-y-auto">

          {/* ── Overdue Quick-Action Banner ── */}
          {isDue && !isViewingOther && (
            <div className={`rounded-2xl p-4 border ${isDark ? "bg-red-950/40 border-red-800" : "bg-red-50 border-red-200"}`}>
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <p className={`text-xs font-bold uppercase tracking-wide ${isDark ? "text-red-400" : "text-red-600"}`}>
                  This reminder is overdue — take action
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => { onDismiss(remId); onClose(); }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                    isDark
                      ? "bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                      : "bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-sm"
                  }`}
                >
                  <BellOff className="h-3.5 w-3.5" /> Dismiss
                </button>
                <button
                  onClick={() => { onReschedule(rem); onClose(); }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all bg-purple-600 hover:bg-purple-700 text-white shadow-sm"
                >
                  <CalendarDays className="h-3.5 w-3.5" /> Reschedule
                </button>
              </div>
            </div>
          )}

          {/* Date & Time */}
          <div className={`flex items-start gap-3 p-4 rounded-2xl ${isDark ? "bg-slate-700/50" : "bg-slate-50"}`}>
            <Clock className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isDue ? "text-red-500" : isDark ? "text-purple-400" : "text-purple-500"}`} />
            <div>
              <p className={`text-xs font-semibold mb-0.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                Date & Time
              </p>
              <p className={`text-sm font-semibold ${isDue ? "text-red-500" : isDark ? "text-slate-100" : "text-slate-800"}`}>
                {formatReminderTime(rem.remind_at)}
              </p>
            </div>
          </div>

          {/* Description */}
          {rem.description && (
            <div className={`p-4 rounded-2xl ${isDark ? "bg-slate-700/50" : "bg-slate-50"}`}>
              <p className={`text-xs font-semibold mb-1.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                Description
              </p>
              <p className={`text-sm leading-relaxed ${isDark ? "text-slate-200" : "text-slate-700"}`}>
                {stripHtml(rem.description)}
              </p>
            </div>
          )}

          {/* ── Trademark / Hearing Outcome Details ── */}
          {(rem.brand_name || rem.hearing_attended || rem.hearing_decision || rem.hearing_adjourned || rem.hearing_notes) && (
            <div className={`rounded-2xl overflow-hidden border ${isDark ? "border-slate-600" : "border-slate-200"}`}>
              {/* Section header */}
              <div className={`px-4 py-2.5 flex items-center gap-2 ${isDark ? "bg-slate-700" : "bg-slate-100"}`}>
                <span className="text-base">™</span>
                <span className={`text-xs font-bold uppercase tracking-widest ${isDark ? "text-purple-300" : "text-purple-600"}`}>
                  Hearing Outcome
                </span>
              </div>
              <div className={`px-4 py-4 space-y-3 ${isDark ? "bg-slate-700/30" : "bg-white"}`}>
                {/* Brand Name */}
                {rem.brand_name && (
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold ${isDark ? "text-slate-400" : "text-slate-500"}`}>Brand Name</span>
                    <span className={`text-sm font-bold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{rem.brand_name}</span>
                  </div>
                )}
                {/* Attended */}
                {rem.hearing_attended && (
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold ${isDark ? "text-slate-400" : "text-slate-500"}`}>Attended</span>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${
                      rem.hearing_attended === "yes"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                    }`}>
                      {rem.hearing_attended === "yes" ? "✓ Yes" : "✗ No"}
                    </span>
                  </div>
                )}
                {/* Decision */}
                {rem.hearing_decision && (
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold ${isDark ? "text-slate-400" : "text-slate-500"}`}>Decision</span>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${
                      rem.hearing_decision === "favourable"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    }`}>
                      {rem.hearing_decision === "favourable" ? "👍 Favourable" : "👎 Unfavourable"}
                    </span>
                  </div>
                )}
                {/* Adjourned */}
                {rem.hearing_adjourned && (
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold ${isDark ? "text-slate-400" : "text-slate-500"}`}>Adjourned</span>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${
                      rem.hearing_next_date_disclosed
                        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                    }`}>
                      {rem.hearing_next_date_disclosed ? "📅 Adjourned — Next Date Set" : "⏳ Adjourned — Next Date Not Disclosed"}
                    </span>
                  </div>
                )}
                {/* Hearing Notes */}
                {rem.hearing_notes && (
                  <div>
                    <span className={`text-xs font-semibold block mb-1 ${isDark ? "text-slate-400" : "text-slate-500"}`}>Hearing Notes</span>
                    <p className={`text-sm leading-relaxed rounded-xl p-3 ${isDark ? "bg-slate-700 text-slate-200" : "bg-slate-50 text-slate-700"}`}>
                      {rem.hearing_notes}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Meta badges */}
          <div className="flex flex-wrap gap-2">
            {rem.priority && (
              <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg ${
                rem.priority === "high"
                  ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                  : rem.priority === "low"
                  ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400"
              }`}>
                {rem.priority.charAt(0).toUpperCase() + rem.priority.slice(1)} Priority
              </span>
            )}
            {rem.source === "email_auto" && (
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                From Email
              </span>
            )}
            {rem.reminder_type === "meeting" && (
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">
                Meeting
              </span>
            )}
          </div>
        </div>

        {/* Popup Footer */}
        <div
          className={`px-8 py-5 flex gap-3 border-t ${isDark ? "border-slate-700" : "border-slate-100"}`}
        >
          <a
            href={gcalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
              isDark
                ? "border-slate-600 text-slate-300 hover:bg-slate-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
            title="Add to Google Calendar"
          >
            <ExternalLink className="h-4 w-4" /> Google Cal
          </a>
          {!isViewingOther && (
            <>
              <button
                onClick={() => {
                  // Don't call onClose() here — we want activePopupReminder to remain
                  // set so the popup can re-open automatically once the edit is saved.
                  onEdit(rem);
                }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
                  isDark
                    ? "border-slate-600 text-slate-300 hover:bg-slate-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Edit2 className="h-4 w-4" /> Edit
              </button>
              <button
                onClick={() => {
                  onClose();
                  onDelete(remId);
                }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
                  isDark
                    ? "border-red-800 text-red-400 hover:bg-red-900/30"
                    : "border-red-200 text-red-500 hover:bg-red-50"
                }`}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </>
          )}
          <Button
            variant="outline"
            onClick={onClose}
            className="ml-auto rounded-xl text-xs px-4 py-2.5"
          >
            Close
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Quick Reschedule Modal ────────────────────────────────────────────────────
function RescheduleModal({ rem, isDark, onConfirm, onCancel }) {
  const [newDatetime, setNewDatetime] = useState(() => {
    // Default to tomorrow same time
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return toDatetimeLocalValue(d);
  });

  if (!rem) return null;

  return (
    <motion.div
      key="reschedule-modal"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.75)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.88, y: 30, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.88, y: 30, opacity: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 22 }}
        className={`w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl ${isDark ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5" style={{ background: "linear-gradient(135deg, #8B5CF6, #1F6FB2)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <RefreshCw className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest">Reschedule</p>
                <h3 className="text-base font-bold text-white leading-tight truncate max-w-[180px]">{rem.title}</h3>
              </div>
            </div>
            <button
              onClick={onCancel}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div className={`p-3 rounded-xl ${isDark ? "bg-amber-900/20 border border-amber-800" : "bg-amber-50 border border-amber-200"}`}>
            <p className={`text-xs font-semibold flex items-center gap-1.5 ${isDark ? "text-amber-400" : "text-amber-700"}`}>
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              Original: {rem.remind_at ? new Date(rem.remind_at).toLocaleString() : "—"}
            </p>
          </div>
          <div>
            <label className={`block text-xs font-semibold mb-1.5 ${isDark ? "text-slate-300" : "text-slate-600"}`}>
              New Date &amp; Time *
            </label>
            <input
              type="datetime-local"
              value={newDatetime}
              onChange={(e) => setNewDatetime(e.target.value)}
              className={`w-full px-3 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all ${
                isDark
                  ? "bg-slate-700 border-slate-600 text-slate-100 focus:ring-purple-900/40 focus:border-purple-500"
                  : "bg-slate-50 border-slate-200 text-slate-800 focus:ring-purple-100 focus:border-purple-400"
              }`}
            />
          </div>
          {/* Quick presets */}
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isDark ? "text-slate-500" : "text-slate-400"}`}>Quick Presets</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "Tomorrow", hours: 24 },
                { label: "+3 Days", hours: 72 },
                { label: "+1 Week", hours: 168 },
                { label: "+1 Month", days: 30 },
              ].map(({ label, hours, days }) => (
                <button
                  key={label}
                  onClick={() => {
                    const d = new Date();
                    if (days) d.setDate(d.getDate() + days);
                    else d.setHours(d.getHours() + hours);
                    setNewDatetime(toDatetimeLocalValue(d));
                  }}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all ${
                    isDark
                      ? "bg-slate-700 hover:bg-purple-800 text-slate-300 hover:text-white border border-slate-600"
                      : "bg-slate-100 hover:bg-purple-100 text-slate-600 hover:text-purple-700 border border-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 flex gap-2 border-t ${isDark ? "border-slate-700" : "border-slate-100"}`}>
          <button
            onClick={onCancel}
            className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all ${
              isDark ? "border-slate-600 text-slate-300 hover:bg-slate-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            Cancel
          </button>
          <button
            onClick={() => newDatetime && onConfirm(newDatetime)}
            disabled={!newDatetime}
            className="flex-1 py-2.5 rounded-xl text-xs font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white transition-all flex items-center justify-center gap-1.5"
          >
            <CalendarDays className="h-3.5 w-3.5" /> Save New Date
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Popup Settings Modal ─────────────────────────────────────────────────────
// Lets a user configure WHEN they get on-screen popups across the app.
// The 11:00 AM universal popup always fires for every user and can't be
// removed — everything else is a custom additional time the user picks.
function PopupSettingsModal({ isOpen, onClose }) {
  const isDark = useDark();
  const [enabled, setEnabled] = useState(true);
  const [customTimes, setCustomTimes] = useState([]);
  const [newTime, setNewTime] = useState("09:00");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api
      .get("/reminders/settings")
      .then(({ data }) => {
        setEnabled(data.enabled !== false);
        setCustomTimes(data.custom_times || []);
      })
      .catch(() => toast.error("Failed to load popup settings"))
      .finally(() => setLoading(false));
  }, [isOpen]);

  const addTime = () => {
    if (!newTime) return;
    if (customTimes.includes(newTime) || newTime === "11:00") {
      toast.error("That time is already set");
      return;
    }
    setCustomTimes((prev) => [...prev, newTime].sort());
  };

  const removeTime = (t) => {
    setCustomTimes((prev) => prev.filter((x) => x !== t));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/reminders/settings", { custom_times: customTimes, enabled });
      toast.success("Popup settings saved");
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save popup settings");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <motion.div
      className="fixed inset-0 z-[100] bg-emerald-900/40 flex items-center justify-center p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className={`w-full max-w-md rounded-2xl shadow-2xl overflow-hidden ${isDark ? "bg-slate-800" : "bg-white"}`}
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? "border-slate-700" : "border-slate-100"}`}>
          <h3 className={`font-semibold text-sm flex items-center gap-2 ${isDark ? "text-white" : "text-slate-900"}`}>
            <Bell className="h-4 w-4" /> Popup Reminder Settings
          </h3>
          <button onClick={onClose} className={isDark ? "text-slate-400 hover:text-white" : "text-slate-400 hover:text-slate-700"}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {loading ? (
            <p className={`text-sm ${isDark ? "text-slate-400" : "text-slate-500"}`}>Loading…</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-sm font-medium ${isDark ? "text-white" : "text-slate-900"}`}>Enable popups</p>
                  <p className={`text-xs ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                    Show on-screen popups on any page (task assignments &amp; visit alerts always fire even if off)
                  </p>
                </div>
                <button
                  onClick={() => setEnabled((v) => !v)}
                  className={`w-11 h-6 rounded-full transition-colors flex-shrink-0 ${enabled ? "bg-indigo-600" : "bg-slate-300"}`}
                >
                  <span
                    className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
                  />
                </button>
              </div>

              <div>
                <p className={`text-sm font-medium mb-1 ${isDark ? "text-white" : "text-slate-900"}`}>Universal daily reminder</p>
                <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${isDark ? "bg-slate-700 text-slate-300" : "bg-slate-50 text-slate-600"}`}>
                  <Clock className="h-3.5 w-3.5" />
                  Every day at <strong>11:00 AM</strong> — always on for every user
                </div>
              </div>

              <div>
                <p className={`text-sm font-medium mb-1 ${isDark ? "text-white" : "text-slate-900"}`}>Your custom popup times</p>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="time"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${isDark ? "bg-slate-700 border-slate-600 text-white" : "bg-white border-slate-200 text-slate-900"}`}
                  />
                  <Button size="sm" onClick={addTime} className="rounded-lg">
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add
                  </Button>
                </div>

                {customTimes.length === 0 ? (
                  <p className={`text-xs ${isDark ? "text-slate-500" : "text-slate-400"}`}>No custom times added yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {customTimes.map((t) => (
                      <span
                        key={t}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${isDark ? "bg-slate-700 text-slate-200" : "bg-indigo-50 text-indigo-700"}`}
                      >
                        {t}
                        <button onClick={() => removeTime(t)} className="hover:text-red-500">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <p className={`text-xs ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                You'll also get an instant popup whenever a new task is assigned to you, and on the day of any scheduled client visit (at 11:00 AM).
              </p>
            </>
          )}
        </div>

        <div className={`px-6 py-4 flex gap-2 border-t ${isDark ? "border-slate-700" : "border-slate-100"}`}>
          <button
            onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all ${isDark ? "border-slate-600 text-slate-300 hover:bg-slate-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="flex-1 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white transition-all"
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Duplicates Modal ──────────────────────────────────────────────────────
// Fetches groups of reminders that the backend has identified as likely
// duplicates (matched on tm_app_no, fuzzy title, date proximity, and
// description — every parameter of the reminder, not just its title). For
// each group, the user can either delete the extra copies or mark the group
// "Not a Duplicate" so it's never suggested again.
function DuplicatesModal({ isOpen, isDark, onClose, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/email/reminders/duplicates");
      setGroups(Array.isArray(data?.duplicate_groups) ? data.duplicate_groups : []);
    } catch {
      toast.error("Failed to load duplicate reminders");
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const removeMemberFromView = (groupId, memberId) => {
    setGroups((prev) =>
      prev
        .map((g) =>
          g.group_id !== groupId
            ? g
            : { ...g, members: g.members.filter((m) => resolveId(m) !== memberId) },
        )
        .filter((g) => g.members.length > 1),
    );
  };

  const dropGroupFromView = (groupId) => {
    setGroups((prev) => prev.filter((g) => g.group_id !== groupId));
  };

  // Delete one duplicate copy, keeping the rest of the group intact
  const handleDeleteMember = async (group, member) => {
    const memberId = resolveId(member);
    if (!memberId) return;
    setBusyId(memberId);
    try {
      await api.delete(`/email/reminders/${memberId}`);
      toast.success("Duplicate reminder deleted");
      removeMemberFromView(group.group_id, memberId);
      onChanged?.();
    } catch {
      toast.error("Failed to delete reminder");
    } finally {
      setBusyId(null);
    }
  };

  // Tell the backend this whole group is NOT actually a duplicate set —
  // every pairwise combination is recorded so it never resurfaces here.
  const handleNotDuplicate = async (group) => {
    const ids = group.members.map((m) => resolveId(m)).filter(Boolean);
    if (ids.length < 2) return;
    setBusyId(group.group_id);
    try {
      await api.post("/email/reminders/duplicates/ignore", { ids });
      toast.success("Marked as not duplicate — won't be suggested again");
      dropGroupFromView(group.group_id);
    } catch {
      toast.error("Failed to update");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, y: 30, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, y: 30, opacity: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 24 }}
        className={`w-full max-w-2xl max-h-[85vh] rounded-3xl overflow-hidden shadow-2xl flex flex-col ${isDark ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-5 flex items-center justify-between flex-shrink-0"
          style={{ background: `linear-gradient(135deg, ${COLORS.coral}, ${COLORS.purple})` }}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest">
                Duplicate Reminders
              </p>
              <h2 className="text-lg font-bold text-white">
                {loading ? "Scanning…" : `${groups.length} possible duplicate group${groups.length !== 1 ? "s" : ""}`}
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {loading ? (
            <div className={`text-center py-14 text-sm ${isDark ? "text-slate-400" : "text-slate-500"}`}>
              Comparing titles, TM numbers, dates &amp; descriptions…
            </div>
          ) : groups.length === 0 ? (
            <div className={`text-center py-14 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
              <p className="text-sm font-semibold">No duplicates found</p>
              <p className="text-xs mt-1">Every reminder looks unique.</p>
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.group_id}
                className={`rounded-2xl border overflow-hidden ${isDark ? "border-slate-600" : "border-slate-200"}`}
              >
                <div className={`px-4 py-2.5 flex items-center justify-between ${isDark ? "bg-slate-700/60" : "bg-slate-50"}`}>
                  <span className={`text-xs font-bold uppercase tracking-wide ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                    {group.members.length} similar reminders
                  </span>
                  <button
                    onClick={() => handleNotDuplicate(group)}
                    disabled={busyId === group.group_id}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-50 ${
                      isDark
                        ? "bg-slate-600 hover:bg-slate-500 text-slate-100"
                        : "bg-white hover:bg-slate-100 text-slate-700 border border-slate-200"
                    }`}
                  >
                    <CheckCircle2 className="h-3 w-3" /> Not a Duplicate
                  </button>
                </div>
                <div className="divide-y divide-slate-200/70 dark:divide-slate-700/70">
                  {group.members.map((m) => {
                    const mId = resolveId(m);
                    return (
                      <div key={mId} className="px-4 py-3 flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <h4 className={`font-semibold text-sm truncate ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                              {m.title || "Untitled"}
                            </h4>
                            {m.suggested_keep && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500 text-white flex-shrink-0">
                                SUGGESTED KEEP
                              </span>
                            )}
                            {m.source === "email_auto" && (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 flex-shrink-0">
                                Email
                              </span>
                            )}
                          </div>
                          <p className={`text-xs flex items-center gap-1.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                            <Clock className="h-3 w-3" /> {formatReminderTime(m.remind_at)}
                          </p>
                          {m.description && (
                            <p className={`text-xs mt-1 line-clamp-2 ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                              {stripHtml(m.description)}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => handleDeleteMember(group, m)}
                          disabled={busyId === mId}
                          title="Delete this duplicate"
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold flex-shrink-0 transition-all disabled:opacity-50 ${
                            isDark
                              ? "bg-red-900/30 hover:bg-red-900/50 text-red-400"
                              : "bg-red-50 hover:bg-red-100 text-red-600"
                          }`}
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function Reminders() {
  const isDark = useDark();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // State
  const [reminders, setReminders] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingReminder, setEditingReminder] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showListView, setShowListView] = useState(false);

  // ── UNIFIED popup state — shared by BOTH calendar and list views ──────────
  const [activePopupReminder, setActivePopupReminder] = useState(null);

  // Reschedule modal state
  const [rescheduleTarget, setRescheduleTarget] = useState(null);

  // Calendar state
  const [calendarMonth, setCalendarMonth] = useState(new Date());

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formDatetime, setFormDatetime] = useState("");

  // Trademark Hearing extra fields (only shown when reminder title contains trademark/hearing keywords)
  const [formBrandName, setFormBrandName] = useState("");
  const [formAttended, setFormAttended] = useState("");       // "yes" | "no" | ""
  const [formDecision, setFormDecision] = useState("");       // "favourable" | "unfavourable" | ""
  const [formAdjourned, setFormAdjourned] = useState(false);
  const [formNextDateDisclosed, setFormNextDateDisclosed] = useState(false); // true = next hearing date declared/disclosed
  const [formHearingNotes, setFormHearingNotes] = useState("");

  // Layout customizer
  const REM_SECTIONS = ["overview", "calendar_view", "reminders_list"];
  const REM_LABELS = {
    overview: {
      name: "Overview Stats",
      icon: "📊",
      desc: "Reminder statistics",
    },
    calendar_view: {
      name: "Calendar View",
      icon: "📅",
      desc: "Monthly calendar with reminders",
    },
    reminders_list: {
      name: "Reminders List",
      icon: "🔔",
      desc: "All reminders and meetings",
    },
  };
  const {
    order: remOrder,
    moveSection: remMove,
    resetOrder: remReset,
  } = usePageLayout("reminders", REM_SECTIONS);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showPopupSettings, setShowPopupSettings] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);

  // Keep a lightweight count of duplicate groups for the badge on the
  // "Duplicates" button — refreshed whenever the reminder list changes.
  const refreshDuplicateCount = useCallback(async () => {
    try {
      const { data } = await api.get("/email/reminders/duplicates");
      setDuplicateCount(Array.isArray(data?.duplicate_groups) ? data.duplicate_groups.length : 0);
    } catch {
      // Non-critical — badge just won't update
    }
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Fetch users for admin dropdown
  useEffect(() => {
    if (!isAdmin) return;
    const fetchUsers = async () => {
      try {
        const res = await api.get("/users");
        if (Array.isArray(res.data)) setAllUsers(res.data);
      } catch {}
    };
    fetchUsers();
  }, [isAdmin]);

  // Fetch reminders
  const fetchReminders = useCallback(async () => {
    setLoading(true);
    try {
      const uid = isAdmin && selectedUserId ? selectedUserId : undefined;
      const url = uid ? `/email/reminders?user_id=${uid}` : "/email/reminders";
      const res = await api.get(url);
      const raw = Array.isArray(res.data) ? res.data : [];
      setReminders(raw.map(normalizeReminder));
    } catch {
      console.error("Failed to fetch reminders");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, selectedUserId]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  useEffect(() => {
    refreshDuplicateCount();
  }, [refreshDuplicateCount, reminders.length]);

  // ── Keep popup in sync: if reminder is updated, refresh popup data ─────────
  useEffect(() => {
    if (activePopupReminder) {
      const updated = reminders.find(r => resolveId(r) === resolveId(activePopupReminder));
      if (updated) {
        setActivePopupReminder(updated);
      } else {
        // Reminder was deleted, close popup
        setActivePopupReminder(null);
      }
    }
  }, [reminders]);

  // ── Popup Reminder Notifications ──────────────────────────────────────────
  useEffect(() => {
    if (!reminders.length) return;
    const checkReminders = () => {
      const firedIds = getFiredIds();
      const now = new Date();
      reminders.forEach((rem) => {
        if (rem.is_dismissed) return;
        const remId = resolveId(rem);
        if (!remId || firedIds.has(remId)) return;
        if (!rem.remind_at) return;
        try {
          const remDate = new Date(rem.remind_at);
          const diffMs = remDate.getTime() - now.getTime();
          // Fire if within 1 minute window (past or upcoming)
          if (diffMs <= 60000 && diffMs >= -300000) {
            addFiredId(remId);
            // In-app toast notification
            toast.warning(`🔔 Reminder: ${rem.title}`, {
              description: rem.description
                ? stripHtml(rem.description).slice(0, 100)
                : formatReminderTime(rem.remind_at),
              duration: 10000,
              action: {
                label: "Dismiss",
                onClick: () => handleDismiss(remId),
              },
            });
            // Browser notification
            sendBrowserNotification(
              `🔔 ${rem.title}`,
              rem.description
                ? stripHtml(rem.description).slice(0, 100)
                : `Due: ${formatReminderTime(rem.remind_at)}`,
            );
          }
        } catch {}
      });
    };
    checkReminders();
    const interval = setInterval(checkReminders, 30000);
    return () => clearInterval(interval);
  }, [reminders]);

  // Dismiss reminder
  const handleDismiss = async (id) => {
    if (!id) return;
    try {
      await api.patch(`/email/reminders/${id}`, { is_dismissed: true });
      const rem = reminders.find(r => resolveId(r) === String(id));
      setReminders((prev) =>
        prev.map((r) =>
          resolveId(r) === String(id) ? { ...r, is_dismissed: true } : r,
        ),
      );
      // Also remove the linked email event from Action Center (best-effort)
      if (rem?.event_id) {
        api.delete(`/email/events/${rem.event_id}`).catch(() => {});
      }
    } catch {}
  };

  // Create reminder
  const handleCreate = async () => {
    if (!formTitle.trim() || !formDatetime) {
      toast.error("Title and date/time are required");
      return;
    }
    try {
      const payload = {
        title: formTitle.trim(),
        description: formDesc.trim() || "",
        remind_at: new Date(formDatetime).toISOString(),
      };
      // Include TM Hearing fields if they were filled in on the create form —
      // previously these were entered but silently discarded on creation.
      if (isTmHearing(formTitle)) {
        payload.brand_name        = formBrandName.trim()   || null;
        payload.hearing_attended  = formAttended           || null;
        payload.hearing_decision  = formDecision           || null;
        payload.hearing_adjourned = formAdjourned;
        payload.hearing_next_date_disclosed = formAdjourned ? formNextDateDisclosed : null;
        payload.hearing_notes     = formHearingNotes.trim() || null;
      }
      await api.post("/email/save-as-reminder", payload);
      toast.success("Reminder created");
      resetForm();
      await fetchReminders();
    } catch {
      toast.error("Failed to create reminder");
    }
  };

  // Update reminder
  const handleUpdate = async () => {
    if (!editingReminder) return;
    const remId = resolveId(editingReminder);
    if (!remId) {
      toast.error("Cannot update: ID missing");
      return;
    }
    try {
      const payload = {
        title: formTitle.trim(),
        description: formDesc.trim(),
        remind_at: formDatetime
          ? new Date(formDatetime).toISOString()
          : undefined,
      };
      // Include TM Hearing fields if this is a trademark hearing.
      // Always send these — even empty/false — so the backend can clear old values.
      if (isTmHearing(formTitle, editingReminder)) {
        payload.brand_name        = formBrandName.trim()   || null;
        payload.hearing_attended  = formAttended           || null;
        payload.hearing_decision  = formDecision           || null;
        payload.hearing_adjourned = formAdjourned;          // boolean — always send
        payload.hearing_next_date_disclosed = formAdjourned ? formNextDateDisclosed : null; // only meaningful when adjourned
        payload.hearing_notes     = formHearingNotes.trim() || null;
      }
      const { data: savedReminder } = await api.patch(`/email/reminders/${remId}`, payload);
      toast.success("Reminder updated");
      // Re-open the detail popup with the freshly-saved data immediately (no flicker).
      // resetForm closes the edit sheet; then we restore the popup using the PATCH response.
      const normalized = normalizeReminder(savedReminder);
      resetForm();
      setActivePopupReminder(normalized);
      // Also refresh the full list in the background so calendar/list stay in sync
      fetchReminders();
    } catch {
      toast.error("Failed to update reminder");
    }
  };

  // Delete reminder
  const handleDelete = async (id) => {
    if (!id) return;
    const rem = reminders.find(r => resolveId(r) === String(id));
    try {
      await api.delete(`/email/reminders/${id}`);
      toast.success("Reminder deleted");
      setReminders((prev) => prev.filter((r) => resolveId(r) !== String(id)));
      // Also remove the linked email event from Action Center (best-effort)
      if (rem?.event_id) {
        api.delete(`/email/events/${rem.event_id}`).catch(() => {});
      }
    } catch {
      try {
        await api.patch(`/email/reminders/${id}`, { is_dismissed: true });
        toast.success("Reminder dismissed");
        setReminders((prev) => prev.filter((r) => resolveId(r) !== String(id)));
        if (rem?.event_id) {
          api.delete(`/email/events/${rem.event_id}`).catch(() => {});
        }
      } catch {
        toast.error("Failed to delete reminder");
      }
    }
  };

  // Detect if a reminder is a Trademark Hearing (based on title keywords)
  // Show TM/Hearing extra fields for ANY email-auto reminder, or any reminder whose
  // title contains trademark/hearing keywords. Also accepts the reminder object directly.
  const isTmHearing = (title = "", reminderObj = null) => {
    if (reminderObj?.source === "email_auto") return true;
    const t = (title || "").toLowerCase();
    return (
      t.includes("trademark") || t.includes("hearing") ||
      t.includes("tm app")    || t.includes("show cause") ||
      t.includes("registration certificate") || t.includes("certificate") ||
      t.includes("ip india")  || t.includes("tmr.gov")
    );
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingReminder(null);
    setFormTitle("");
    setFormDesc("");
    setFormDatetime("");
    setFormBrandName("");
    setFormAttended("");
    setFormDecision("");
    setFormAdjourned(false);
    setFormNextDateDisclosed(false);
    setFormHearingNotes("");
    // Note: activePopupReminder is intentionally NOT cleared here.
    // After a save, handleUpdate sets it to the fresh API response.
    // After a cancel, it remains as-is so the popup re-appears.
  };

  const startEdit = (rem) => {
    setEditingReminder(rem);
    setFormTitle(rem.title || "");
    setFormDesc(stripHtml(rem.description || ""));
    try {
      setFormDatetime(toDatetimeLocalValue(rem.remind_at));
    } catch {
      setFormDatetime("");
    }
    // Populate Trademark Hearing fields if previously saved
    setFormBrandName(rem.brand_name || "");
    setFormAttended(rem.hearing_attended || "");
    setFormDecision(rem.hearing_decision || "");
    setFormAdjourned(rem.hearing_adjourned || false);
    setFormNextDateDisclosed(rem.hearing_next_date_disclosed || false);
    setFormHearingNotes(rem.hearing_notes || "");
    setShowForm(true);
  };

  // ── Open the unified detail popup ─────────────────────────────────────────
  const openDetailPopup = (rem) => {
    setActivePopupReminder(rem);
  };

  // ── Open reschedule modal ─────────────────────────────────────────────────
  const startReschedule = (rem) => {
    setRescheduleTarget(rem);
  };

  // ── Confirm reschedule: PATCH new remind_at ───────────────────────────────
  const handleRescheduleConfirm = async (newDatetime) => {
    if (!rescheduleTarget) return;
    const remId = resolveId(rescheduleTarget);
    if (!remId) return;
    try {
      const { data: saved } = await api.patch(`/email/reminders/${remId}`, {
        remind_at: new Date(newDatetime).toISOString(),
        is_dismissed: false,
      });
      toast.success("Reminder rescheduled");
      const normalized = normalizeReminder(saved);
      setRescheduleTarget(null);
      setActivePopupReminder(normalized);
      fetchReminders();
    } catch {
      toast.error("Failed to reschedule reminder");
    }
  };

  // Filtered reminders — used by list view
  const filteredReminders = useMemo(() => {
    let list = Array.isArray(reminders) ? reminders : [];

    if (filterStatus === "upcoming") {
      list = list.filter(
        (r) => !r.is_dismissed && r.remind_at && !isPast(new Date(r.remind_at)),
      );
    } else if (filterStatus === "overdue") {
      list = list.filter(
        (r) => !r.is_dismissed && r.remind_at && isPast(new Date(r.remind_at)),
      );
    } else if (filterStatus === "dismissed") {
      list = list.filter((r) => r.is_dismissed);
    } else {
      // "all" — show non-dismissed
      list = list.filter((r) => !r.is_dismissed);
    }

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter(
        (r) =>
          (r.title || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q),
      );
    }

    return list.sort((a, b) => {
      const da = a.remind_at ? new Date(a.remind_at).getTime() : 0;
      const db = b.remind_at ? new Date(b.remind_at).getTime() : 0;
      return da - db;
    });
  }, [reminders, filterStatus, searchTerm]);

  // Stats
  const stats = useMemo(() => {
    const active = reminders.filter((r) => !r.is_dismissed);
    const overdue = active.filter(
      (r) => r.remind_at && isPast(new Date(r.remind_at)),
    );
    const upcoming = active.filter(
      (r) => r.remind_at && !isPast(new Date(r.remind_at)),
    );
    const todayCount = active.filter((r) => {
      try {
        return dateFnsIsToday(new Date(r.remind_at));
      } catch {
        return false;
      }
    });
    return {
      total: active.length,
      overdue: overdue.length,
      upcoming: upcoming.length,
      today: todayCount.length,
    };
  }, [reminders]);

  // Calendar data — reminders grouped by date (ALL non-dismissed, same source as list)
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(calendarMonth);
    const monthEnd = endOfMonth(calendarMonth);
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  }, [calendarMonth]);

  const remindersByDate = useMemo(() => {
    const map = {};
    // Use same base: all non-dismissed reminders with a date
    const active = reminders.filter((r) => !r.is_dismissed && r.remind_at);
    active.forEach((r) => {
      try {
        const dateKey = format(new Date(r.remind_at), "yyyy-MM-dd");
        if (!map[dateKey]) map[dateKey] = [];
        map[dateKey].push(r);
      } catch {}
    });
    return map;
  }, [reminders]);

  const isViewingOther =
    isAdmin && selectedUserId && selectedUserId !== user?.id;
  const startDayOfWeek = getDay(startOfMonth(calendarMonth)); // 0=Sun

  return (
    <>
      <LayoutCustomizer
        isOpen={showCustomize}
        onClose={() => setShowCustomize(false)}
        sectionLabels={REM_LABELS}
        order={remOrder}
        onDragEnd={remMove}
        onReset={remReset}
        isDark={isDark}
      />

      <PopupSettingsModal
        isOpen={showPopupSettings}
        onClose={() => setShowPopupSettings(false)}
      />

      <AnimatePresence>
        {showDuplicates && (
          <DuplicatesModal
            isOpen={showDuplicates}
            isDark={isDark}
            onClose={() => setShowDuplicates(false)}
            onChanged={() => {
              fetchReminders();
              refreshDuplicateCount();
            }}
          />
        )}
      </AnimatePresence>

      <motion.div
        className="space-y-4 pb-8"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* WELCOME BANNER */}
        <motion.div variants={itemVariants}>
          <WelcomeBanner
            title="Reminders & Meetings"
            subtitle={
              isViewingOther
                ? "Viewing another user's reminders"
                : "Manage your reminders and meetings"
            }
            icon={BellRing}
            actionsClassName="lg:flex-none lg:w-[660px] lg:max-w-[660px]"
            actions={
              <div className="grid grid-cols-3 gap-2 w-full min-w-0 items-stretch">
      {isAdmin && (
        <Select value={selectedUserId || "all"} onValueChange={(v) => setSelectedUserId(v === "all" ? "" : v)}>
          <SelectTrigger className="w-auto min-w-[150px] h-9 px-3 text-xs font-semibold whitespace-nowrap rounded-none bg-white/15 border-white/20 text-white placeholder:text-white/50">
            <SelectValue placeholder="All Users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">My Reminders</SelectItem>
            {allUsers.map((u) => (
              <SelectItem key={u.id || u._id} value={String(u.id || u._id)}>{u.full_name || u.name || u.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button onClick={() => { resetForm(); setShowForm(true); }} className="h-9 px-4 whitespace-nowrap rounded-none text-xs font-semibold bg-white/15 hover:bg-white/25 text-white border border-white/20">
        <Plus className="h-4 w-4 mr-1" /> New Reminder
      </Button>
      <button onClick={() => setShowListView((v) => !v)} title={showListView ? "Show Calendar Only" : "Show List View"} className="h-9 flex items-center justify-center gap-1 px-4 rounded-none text-xs font-semibold whitespace-nowrap bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all">
        {showListView ? <CalendarIcon size={13} /> : <List size={13} />}
        {showListView ? "Calendar" : "List View"}
      </button>
      <button onClick={() => setShowCustomize(true)} className="h-9 flex items-center justify-center gap-1 px-4 rounded-none text-xs font-semibold whitespace-nowrap bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all">
        <Settings2 size={13} /> Customize
      </button>
      <button onClick={() => setShowPopupSettings(true)} className="h-9 flex items-center justify-center gap-1 px-4 rounded-none text-xs font-semibold whitespace-nowrap bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all" data-testid="popup-settings-btn">
        <Bell size={13} /> Popup Settings
      </button>
      <button onClick={() => setShowDuplicates(true)} className="relative h-9 flex items-center justify-center gap-1 px-4 rounded-none text-xs font-semibold whitespace-nowrap bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all" data-testid="duplicates-btn" title="Find and remove duplicate reminders">
        <RefreshCw size={13} /> Duplicates
        {duplicateCount > 0 && <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-coral text-[10px] font-bold flex items-center justify-center text-white" style={{ backgroundColor: COLORS.coral }}>{duplicateCount}</span>}
      </button>
    </div>
            }
          />
        </motion.div>

        {/* ORDERED SECTIONS */}
        {remOrder.map((sectionId) => {
          if (sectionId === "overview")
            return (
              <motion.div
                key="overview"
                variants={itemVariants}
                className="grid grid-cols-2 md:grid-cols-4 gap-3"
              >
                {[
                  {
                    label: "Total Active",
                    value: stats.total,
                    color: COLORS.purple,
                    icon: Bell,
                  },
                  {
                    label: "Today",
                    value: stats.today,
                    color: COLORS.mediumBlue,
                    icon: CalendarIcon,
                  },
                  {
                    label: "Upcoming",
                    value: stats.upcoming,
                    color: COLORS.emeraldGreen,
                    icon: Clock,
                  },
                  {
                    label: "Overdue",
                    value: stats.overdue,
                    color: COLORS.coral,
                    icon: AlertTriangle,
                  },
                ].map((s) => (
                  <motion.div
                    key={s.label}
                    whileHover={{ y: -3, transition: springPhysics.card }}
                    className={`rounded-2xl shadow-sm border p-4 ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"}`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          {s.label}
                        </p>
                        <p
                          className="text-2xl font-bold mt-1 tracking-tight"
                          style={{ color: s.color }}
                        >
                          {s.value}
                        </p>
                      </div>
                      <div
                        className="p-2 rounded-xl"
                        style={{ backgroundColor: `${s.color}18` }}
                      >
                        <s.icon
                          className="h-4 w-4"
                          style={{ color: s.color }}
                        />
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            );

          // ── BIG CALENDAR VIEW ──────────────────────────────────────────────
          if (sectionId === "calendar_view")
            return !showListView ? (
              <motion.div key="calendar_view" variants={itemVariants}>
                <SectionCard>
                  <CardHeaderRow
                    iconBg={isDark ? "bg-blue-900/40" : "bg-blue-50"}
                    icon={<CalendarIcon className="h-4 w-4 text-blue-500" />}
                    title="Reminder Calendar"
                    subtitle={format(calendarMonth, "MMMM yyyy")}
                    action={
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() =>
                            setCalendarMonth(subMonths(calendarMonth, 1))
                          }
                          className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-slate-100"}`}
                        >
                          <ChevronLeft className="h-4 w-4 text-slate-400" />
                        </button>
                        <button
                          onClick={() => setCalendarMonth(new Date())}
                          className={`px-2 py-1 text-xs font-semibold rounded-lg transition-colors ${isDark ? "hover:bg-slate-700 text-blue-400" : "hover:bg-slate-100 text-blue-500"}`}
                        >
                          Today
                        </button>
                        <button
                          onClick={() =>
                            setCalendarMonth(addMonths(calendarMonth, 1))
                          }
                          className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-slate-100"}`}
                        >
                          <ChevronRight className="h-4 w-4 text-slate-400" />
                        </button>
                      </div>
                    }
                  />
                  <div className="p-4">
                    {/* Day headers */}
                    <div className="grid grid-cols-7 mb-2">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                        (d) => (
                          <div
                            key={d}
                            className="text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 py-2"
                          >
                            {d}
                          </div>
                        ),
                      )}
                    </div>
                    {/* Calendar grid */}
                    <div className="grid grid-cols-7 gap-1">
                      {/* Empty cells for days before month start */}
                      {Array.from({ length: startDayOfWeek }).map((_, i) => (
                        <div
                          key={`empty-${i}`}
                          className="min-h-[80px] sm:min-h-[100px]"
                        />
                      ))}
                      {calendarDays.map((day) => {
                        const dateKey = format(day, "yyyy-MM-dd");
                        const dayReminders = remindersByDate[dateKey] || [];
                        const isToday = dateFnsIsToday(day);
                        const hasOverdue = dayReminders.some((r) =>
                          isPast(new Date(r.remind_at)),
                        );
                        const hasAdjournedDated   = dayReminders.some(r => r.hearing_adjourned && r.hearing_next_date_disclosed);
                        const hasAdjournedNoDate  = dayReminders.some(r => r.hearing_adjourned && !r.hearing_next_date_disclosed);
                        const hasUnfavourable     = dayReminders.some(r => getHearingStatus(r) === "unfavourable");
                        const hasFavourable       = dayReminders.some(r => getHearingStatus(r) === "favourable");
                        return (
                          <motion.div
                            key={dateKey}
                            whileHover={{ scale: 1.02 }}
                            className={`min-h-[80px] sm:min-h-[100px] rounded-xl border p-1.5 transition-all cursor-pointer ${
                              isToday
                                ? isDark
                                  ? "border-blue-500 bg-blue-900/20"
                                  : "border-blue-400 bg-blue-50"
                                : isDark
                                  ? "border-slate-700 hover:border-slate-600"
                                  : "border-slate-200 hover:border-slate-300"
                            }`}
                            onClick={() => {
                              if (dayReminders.length === 0) {
                                const dt = format(day, "yyyy-MM-dd'T'09:00");
                                resetForm();
                                setFormDatetime(dt);
                                setShowForm(true);
                              }
                            }}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span
                                className={`text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full ${
                                  isToday
                                    ? "bg-blue-500 text-white"
                                    : isDark
                                      ? "text-slate-300"
                                      : "text-slate-700"
                                }`}
                              >
                                {format(day, "d")}
                              </span>
                              {dayReminders.length > 0 && (
                                <span
                                  className={`text-[9px] font-bold px-1 py-0.5 rounded-full ${
                                    hasAdjournedDated
                                      ? "bg-red-500 text-white"
                                    : hasAdjournedNoDate
                                      ? "bg-yellow-500 text-white"
                                    : hasUnfavourable
                                      ? "bg-amber-500 text-white"
                                    : hasFavourable
                                      ? "bg-emerald-500 text-white"
                                    : hasOverdue
                                      ? "bg-red-500 text-white"
                                      : "bg-purple-500 text-white"
                                  }`}
                                >
                                  {dayReminders.length}
                                </span>
                              )}
                            </div>
                            <div className="space-y-0.5 overflow-hidden">
                              {dayReminders.slice(0, 2).map((rem) => (
                                <div
                                  key={resolveId(rem)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    // ── Opens the SHARED popup ──────────────
                                    openDetailPopup(rem);
                                  }}
                                  className={`text-[9px] sm:text-[10px] font-semibold px-1.5 py-0.5 rounded-md truncate cursor-pointer transition-all hover:opacity-80 ${
                                    rem.hearing_adjourned && rem.hearing_next_date_disclosed
                                      ? isDark ? "bg-red-900/40 text-red-300" : "bg-red-100 text-red-600"
                                    : rem.hearing_adjourned && !rem.hearing_next_date_disclosed
                                      ? isDark ? "bg-yellow-900/40 text-yellow-300" : "bg-yellow-100 text-yellow-700"
                                    : rem.hearing_decision === "unfavourable"
                                      ? isDark ? "bg-amber-900/40 text-amber-300" : "bg-amber-100 text-amber-700"
                                    : rem.hearing_decision === "favourable"
                                      ? isDark ? "bg-emerald-900/40 text-emerald-300" : "bg-emerald-100 text-emerald-700"
                                    : isPast(new Date(rem.remind_at))
                                      ? isDark ? "bg-red-900/30 text-red-400" : "bg-red-100 text-red-600"
                                      : isDark ? "bg-purple-900/30 text-purple-400" : "bg-purple-100 text-purple-700"
                                  }`}
                                >
                                  {rem.title}
                                </div>
                              ))}
                              {dayReminders.length > 2 && (
                                <p
                                  className={`text-[9px] font-medium text-center ${isDark ? "text-slate-500" : "text-slate-400"}`}
                                >
                                  +{dayReminders.length - 2} more
                                </p>
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                </SectionCard>
              </motion.div>
            ) : null;

          // ── LIST VIEW ──────────────────────────────────────────────────────
          if (sectionId === "reminders_list")
            return showListView ? (
              <motion.div key="reminders_list" variants={itemVariants}>
                <SectionCard>
                  <CardHeaderRow
                    iconBg={isDark ? "bg-purple-900/40" : "bg-purple-50"}
                    icon={<BellRing className="h-4 w-4 text-purple-500" />}
                    title="All Reminders"
                    subtitle={`${filteredReminders.length} reminder${filteredReminders.length !== 1 ? "s" : ""}`}
                    badge={stats.overdue > 0 ? stats.overdue : undefined}
                    action={
                      <div className="flex items-center gap-2">
                        <div
                          className={`flex gap-0.5 rounded-lg p-0.5 ${isDark ? "bg-slate-700" : "bg-slate-100"}`}
                        >
                          {["all", "upcoming", "overdue", "dismissed"].map(
                            (f) => (
                              <button
                                key={f}
                                onClick={() => setFilterStatus(f)}
                                className={`px-2 py-1 text-[10px] font-semibold rounded-md transition-all capitalize ${
                                  filterStatus === f
                                    ? isDark
                                      ? "bg-slate-600 text-white shadow-sm"
                                      : "bg-white text-slate-800 shadow-sm"
                                    : isDark
                                      ? "text-slate-400 hover:text-slate-200"
                                      : "text-slate-500 hover:text-slate-700"
                                }`}
                              >
                                {f}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    }
                  />

                  {/* Search bar */}
                  <div className="px-4 pt-3">
                    <div className="relative">
                      <Search
                        className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${isDark ? "text-slate-500" : "text-slate-400"}`}
                      />
                      <input
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search reminders..."
                        className={`w-full pl-9 pr-4 py-2 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all ${
                          isDark
                            ? "bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-400 focus:ring-purple-900/40 focus:border-purple-500"
                            : "bg-slate-50 border-slate-200 text-slate-800 placeholder:text-slate-400 focus:ring-purple-100 focus:border-purple-400"
                        }`}
                      />
                    </div>
                  </div>

                  {/* Reminders list */}
                  <div className="p-4">
                    {loading ? (
                      <div
                        className={`text-center py-12 text-sm ${isDark ? "text-slate-500" : "text-slate-400"}`}
                      >
                        Loading...
                      </div>
                    ) : filteredReminders.length === 0 ? (
                      <div
                        className={`text-center py-12 text-sm ${isDark ? "text-slate-500" : "text-slate-400"}`}
                      >
                        {searchTerm
                          ? "No reminders match your search"
                          : "No reminders found"}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {filteredReminders.map((rem) => {
                          const remId = resolveId(rem);
                          const isDue =
                            rem.remind_at && isPast(new Date(rem.remind_at));
                          const gcalUrl = buildGCalURL(rem);

                          return (
                            <div
                              key={remId}
                              className={`relative p-4 rounded-xl border transition-colors cursor-pointer ${
                                isDue
                                  ? isDark
                                    ? "bg-red-900/15 border-red-800 hover:border-red-700"
                                    : "bg-red-50/70 border-red-200 hover:border-red-300"
                                  : isDark
                                    ? "bg-slate-800 border-slate-700 hover:border-slate-600"
                                    : "bg-white border-slate-200 hover:border-slate-300"
                              }`}
                              // ── Clicking the card opens the SHARED popup ──
                              onClick={() => openDetailPopup(rem)}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 flex-1 min-w-0">
                                  <div
                                    className={`p-2 rounded-xl flex-shrink-0 mt-0.5 ${
                                      isDue
                                        ? "bg-red-100 dark:bg-red-900/30"
                                        : "bg-purple-50 dark:bg-purple-900/30"
                                    }`}
                                  >
                                    <BellRing
                                      className={`h-4 w-4 ${isDue ? "text-red-500" : "text-purple-500"}`}
                                    />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <h4
                                        className={`font-semibold text-sm ${isDark ? "text-slate-100" : "text-slate-800"}`}
                                      >
                                        {rem.title || "Untitled"}
                                      </h4>
                                      {isDue && (
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-red-500 text-white">
                                          OVERDUE
                                        </span>
                                      )}
                                      {rem.source === "email_auto" && (
                                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                                          Email
                                        </span>
                                      )}
                                    </div>
                                    {rem.description && (
                                      <p
                                        className={`text-xs mb-2 line-clamp-2 ${isDark ? "text-slate-400" : "text-slate-500"}`}
                                      >
                                        {stripHtml(rem.description)}
                                      </p>
                                    )}
                                    <div
                                      className={`flex items-center gap-1.5 text-xs ${isDark ? "text-slate-500" : "text-slate-400"}`}
                                    >
                                      <Clock className="h-3 w-3" />
                                      <span
                                        className={
                                          isDue
                                            ? "text-red-500 font-medium"
                                            : ""
                                        }
                                      >
                                        {formatReminderTime(rem.remind_at)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                                {/* Action buttons — stop propagation so they don't open popup */}
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <a
                                    href={gcalUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`p-2 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700 text-slate-400" : "hover:bg-slate-100 text-slate-400"}`}
                                    title="Add to Google Calendar"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                  {!isViewingOther && (
                                    <>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          startEdit(rem);
                                        }}
                                        className={`p-2 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700 text-slate-400" : "hover:bg-slate-100 text-slate-400"}`}
                                      >
                                        <Edit2 className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDelete(remId);
                                        }}
                                        className={`p-2 rounded-lg transition-colors ${isDark ? "hover:bg-red-900/30 text-slate-400 hover:text-red-400" : "hover:bg-red-50 text-slate-400 hover:text-red-500"}`}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </SectionCard>
              </motion.div>
            ) : null;

          return null;
        })}
      </motion.div>

      {/* ── SHARED REMINDER DETAIL POPUP (Calendar + List) ───────────────── */}
      <AnimatePresence>
        {activePopupReminder && (
          <ReminderDetailPopup
            rem={activePopupReminder}
            isDark={isDark}
            isViewingOther={isViewingOther}
            COLORS={COLORS}
            onClose={() => setActivePopupReminder(null)}
            onEdit={startEdit}
            onDelete={handleDelete}
            onDismiss={handleDismiss}
            onReschedule={startReschedule}
          />
        )}
      </AnimatePresence>

      {/* ── RESCHEDULE MODAL ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {rescheduleTarget && (
          <RescheduleModal
            rem={rescheduleTarget}
            isDark={isDark}
            onConfirm={handleRescheduleConfirm}
            onCancel={() => setRescheduleTarget(null)}
          />
        )}
      </AnimatePresence>

      {/* CREATE / EDIT MODAL */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
            style={{
              background: "rgba(7,15,30,0.72)",
              backdropFilter: "blur(10px)",
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={resetForm}
          >
            <motion.div
              initial={{ scale: 0.88, y: 40, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.88, y: 40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 22 }}
              className={`w-full max-w-md rounded-3xl overflow-hidden shadow-2xl ${isDark ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div
                className="px-6 py-5 relative overflow-hidden"
                style={{
                  background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.mediumBlue})`,
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
                      <Bell className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest">
                        {editingReminder ? "Edit Reminder" : "New Reminder"}
                      </p>
                      <h2 className="text-lg font-bold text-white">
                        {editingReminder ? "Update Details" : "Create Reminder"}
                      </h2>
                    </div>
                  </div>
                  <button
                    onClick={resetForm}
                    className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all"
                  >
                    <X className="w-4 h-4 text-white" />
                  </button>
                </div>
              </div>

              {/* Modal Body */}
              <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <div>
                  <label
                    className={`text-xs font-semibold mb-1.5 block ${isDark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    Title *
                  </label>
                  <Input
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    placeholder="Reminder title"
                    className={`rounded-xl ${isDark ? "bg-slate-700 border-slate-600" : ""}`}
                  />
                </div>
                <div>
                  <label
                    className={`text-xs font-semibold mb-1.5 block ${isDark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    Description
                  </label>
                  <Textarea
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    placeholder="Optional description..."
                    rows={3}
                    className={`rounded-xl ${isDark ? "bg-slate-700 border-slate-600" : ""}`}
                  />
                </div>
                <div>
                  <label
                    className={`text-xs font-semibold mb-1.5 block ${isDark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    Date & Time *
                  </label>
                  <Input
                    type="datetime-local"
                    value={formDatetime}
                    onChange={(e) => setFormDatetime(e.target.value)}
                    className={`rounded-xl ${isDark ? "bg-slate-700 border-slate-600" : ""}`}
                  />
                </div>

                {/* ── Trademark Hearing Fields — shown only for TM hearing reminders ── */}
                {isTmHearing(formTitle, editingReminder) && (
                  <>
                    {/* Divider */}
                    <div className="flex items-center gap-2 pt-1">
                      <div className={`flex-1 h-px ${isDark ? "bg-slate-600" : "bg-slate-200"}`} />
                      <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${isDark ? "bg-slate-700 text-purple-300" : "bg-purple-50 text-purple-600"}`}>
                        ™ Hearing Details
                      </span>
                      <div className={`flex-1 h-px ${isDark ? "bg-slate-600" : "bg-slate-200"}`} />
                    </div>

                    {/* Brand Name */}
                    <div>
                      <label className={`text-xs font-semibold mb-1.5 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                        Brand Name
                      </label>
                      <Input
                        value={formBrandName}
                        onChange={(e) => setFormBrandName(e.target.value)}
                        placeholder="e.g. TASKOSPHERE, ZARA, etc."
                        className={`rounded-xl ${isDark ? "bg-slate-700 border-slate-600" : ""}`}
                      />
                    </div>

                    {/* Attended */}
                    <div>
                      <label className={`text-xs font-semibold mb-2 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                        Attended
                      </label>
                      <div className="flex gap-2">
                        {[{val:"yes", label:"✓  Yes"}, {val:"no", label:"✗  No"}].map(opt => (
                          <button
                            key={opt.val}
                            type="button"
                            onClick={() => setFormAttended(prev => prev === opt.val ? "" : opt.val)}
                            className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition-all
                              ${formAttended === opt.val
                                ? opt.val === "yes"
                                  ? "bg-emerald-500 border-emerald-500 text-white"
                                  : "bg-rose-500 border-rose-500 text-white"
                                : isDark
                                  ? "bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400"
                                  : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"
                              }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Decision */}
                    <div>
                      <label className={`text-xs font-semibold mb-2 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                        Decision
                      </label>
                      <div className="flex gap-2">
                        {[{val:"favourable", label:"👍  Favourable"}, {val:"unfavourable", label:"👎  Unfavourable"}].map(opt => (
                          <button
                            key={opt.val}
                            type="button"
                            onClick={() => setFormDecision(prev => prev === opt.val ? "" : opt.val)}
                            className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition-all
                              ${formDecision === opt.val
                                ? opt.val === "favourable"
                                  ? "bg-emerald-500 border-emerald-500 text-white"
                                  : "bg-rose-500 border-rose-500 text-white"
                                : isDark
                                  ? "bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400"
                                  : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"
                              }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Adjourned */}
                    <div>
                      <label className={`text-xs font-semibold mb-2 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                        Adjourned
                      </label>
                      <button
                        type="button"
                        onClick={() => setFormAdjourned(prev => !prev)}
                        className={`w-full py-2 rounded-xl text-sm font-semibold border transition-all
                          ${formAdjourned
                            ? "bg-amber-500 border-amber-500 text-white"
                            : isDark
                              ? "bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400"
                              : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"
                          }`}
                      >
                        {formAdjourned ? "📅  Yes — Adjourned" : "📅  Mark as Adjourned"}
                      </button>
                    </div>

                    {/* Next Hearing Date Disclosed — only relevant when Adjourned */}
                    {formAdjourned && (
                      <div>
                        <label className={`text-xs font-semibold mb-2 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                          Next Hearing Date Declared?
                        </label>
                        <div className="flex gap-2">
                          {[
                            { val: false, label: "⏳  Not Disclosed Yet" },
                            { val: true,  label: "📅  Yes — Date Set" },
                          ].map((opt) => (
                            <button
                              key={String(opt.val)}
                              type="button"
                              onClick={() => setFormNextDateDisclosed(opt.val)}
                              className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition-all
                                ${formNextDateDisclosed === opt.val
                                  ? opt.val
                                    ? "bg-red-500 border-red-500 text-white"
                                    : "bg-yellow-500 border-yellow-500 text-white"
                                  : isDark
                                    ? "bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400"
                                    : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"
                                }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <p className={`text-[11px] mt-1.5 ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                          If no next date has been declared yet, this reminder shows{" "}
                          <span className="font-semibold text-yellow-500">yellow</span> on the calendar.
                          Once a next date is set, it shows{" "}
                          <span className="font-semibold text-red-500">red</span>.
                        </p>
                      </div>
                    )}

                    {/* Hearing Notes */}
                    <div>
                      <label className={`text-xs font-semibold mb-1.5 block ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                        Hearing Notes
                      </label>
                      <Textarea
                        value={formHearingNotes}
                        onChange={(e) => setFormHearingNotes(e.target.value)}
                        placeholder="Enter any notes about the hearing outcome, next steps, officer remarks..."
                        rows={3}
                        className={`rounded-xl ${isDark ? "bg-slate-700 border-slate-600" : ""}`}
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Modal Footer */}
              <div
                className={`px-6 py-4 flex gap-3 border-t ${isDark ? "border-slate-700" : "border-slate-100"}`}
              >
                <Button
                  variant="outline"
                  onClick={resetForm}
                  className="flex-1 rounded-xl"
                >
                  Cancel
                </Button>
                <Button
                  onClick={editingReminder ? handleUpdate : handleCreate}
                  disabled={!formTitle.trim() || !formDatetime}
                  className="flex-1 rounded-xl font-semibold"
                  style={{
                    background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.mediumBlue})`,
                  }}
                >
                  {editingReminder ? "Update" : "Create"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
