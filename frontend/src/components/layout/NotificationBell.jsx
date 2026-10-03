import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, CheckCheck, Trash2, Info, ChevronRight,
  CheckSquare, ClipboardList, Users, CalendarOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import api from "@/lib/api";
import { toast } from "sonner";

// ── App brand blue (matches the dashboard banner / header gradient) ──────────
const BRAND_DEEP_BLUE   = "#0D3B66";
const BRAND_MEDIUM_BLUE = "#1F6FB2";
const HEADER_GRADIENT   = `linear-gradient(120deg, ${BRAND_DEEP_BLUE}, ${BRAND_MEDIUM_BLUE})`;

// ── Icon per notification type ────────────────────────────────────────────────
const TYPE_META = {
  task:       { icon: ClipboardList, color: "text-indigo-500",  bg: "bg-indigo-50"  },
  assignment: { icon: ClipboardList, color: "text-indigo-500",  bg: "bg-indigo-50"  },
  todo:       { icon: CheckSquare,   color: "text-emerald-500", bg: "bg-emerald-50" },
  lead:               { icon: Users, color: "text-amber-500",   bg: "bg-amber-50"   },
  follow_up_reminder: { icon: Users, color: "text-amber-500",   bg: "bg-amber-50"   },
  leave:  { icon: CalendarOff,   color: "text-rose-600",    bg: "bg-rose-50"    },
  system: { icon: Info,          color: "text-slate-500",   bg: "bg-slate-100"  },
  dsc:    { icon: Info,          color: "text-purple-500",  bg: "bg-purple-50"  },
};

const getMeta = (type) => TYPE_META[type] ?? TYPE_META.system;

// ── Where a notification should take the user when clicked ───────────────────
// Maps a notification `type` to the route that best represents it inside the
// app. Falls back to the dashboard for anything unmapped so a click never
// dead-ends.
const TYPE_ROUTE_MAP = {
  // Taskosphere
  task: "/tasks",
  assignment: "/tasks",
  todo: "/todos",
  attendance: "/attendance",
  reminder: "/reminders",
  action_center: "/action-center",
  visit: "/visits",
  client_visit: "/visits",
  ai_document_reader: "/ai-reader",

  // Compliance
  compliance: "/compliance-dashboard",
  gst: "/gst-reconciliation",
  trademark: "/trademark-sphere",
  mis_report: "/mis-report",
  salary_slip: "/salary-slips",
  roc: "/roc-sphere",

  // Records
  dsc: "/dsc",
  document: "/documents",
  password: "/passwords",
  client_approval: "/client-approvals",

  // Client Proposals
  lead: "/leads",
  // Follow-up reminders are generated from the `clients` collection by the
  // automation job, not from Leads. Keep the client reference from the
  // notification message so the Clients page can open the exact record.
  follow_up_reminder: "/clients",
  quotation: "/quotations",
  client_discussion: "/client-discussion",

  // Finix
  invoice: "/invoicing",
  tax_invoice: "/invoicing",
  credit_note: "/invoicing",
  debit_note: "/invoicing",
  approved_zte_journal: "/zero-touch-entry",
  purchase: "/purchase",
  bank: "/bank-accounts",
  journal_entry: "/journal-entries",
  renewal_alert: "/due-dates",
  whatsapp: "/whatsapp-hub",

  // People Matrix
  hr: "/hr",
  birthday: "/hr",
  performance: "/people-matrix",
  recruitment: "/recruitment",
  payroll: "/payroll",
  leave: "/leave",
  roles: "/roles",

  // Admin / automation / system
  approval_request: "/automation/approvals",
  automation_approval: "/automation/approvals",
  master_data: "/master-data",
  holding_company: "/master-data",
  login_failed: "/staff-activity",
  login_success: "/staff-activity",
  logout: "/staff-activity",
  rule: "/action-center",
  rule_optimization_proposal: "/action-center",
  workflow_definition: "/action-center",
  workflow_instance: "/action-center",
  recommendation_accepted: "/action-center",
  learning_task_exhausted: "/action-center",
};

// Build the destination path for a notification click.
const resolveNotificationPath = (n) => {
  const base = TYPE_ROUTE_MAP[n.type] || "/dashboard";

  if (n.type === "follow_up_reminder") {
    // Current reminders carry the client id as "(ref:<id>)". Older
    // notifications without a reference still land on the Clients page.
    const clientId = String(n.message || "").match(/\(ref:([^)]+)\)/)?.[1];
    return clientId
      ? `${base}?clientId=${encodeURIComponent(clientId)}`
      : base;
  }

  // Task-type notifications: deep-link straight into the task detail when we
  // have a task_id — Tasks.jsx already knows how to open `?taskId=`.
  if ((n.type === "task" || n.type === "assignment") && n.task_id) {
    return `${base}?taskId=${encodeURIComponent(n.task_id)}`;
  }

  return base;
};

// ── Relative time ─────────────────────────────────────────────────────────────
const formatDate = (dateString) => {
  if (!dateString) return "";
  const diff = Date.now() - new Date(dateString).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 1)  return "Just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
};

// ─────────────────────────────────────────────────────────────────────────────

export const NotificationBell = () => {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount]     = useState(0);
  const fetchInFlightRef = React.useRef(false);
  const [open, setOpen]                   = useState(false);
  const [loading, setLoading]             = useState(false);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchNotifications = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      const { data } = await api.get("/notifications");
      // The API can answer with [] , { items: [] } or — when the endpoint is
      // briefly unavailable — an error body. Never hand a non-array to state,
      // otherwise .filter()/.map() below throw and blank the whole header.
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.data)
            ? data.data
            : [];
      setNotifications(list);
      setUnreadCount(list.filter((n) => !n.is_read).length);
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
    } finally {
      fetchInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, 60_000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  // ── Mark single read ───────────────────────────────────────────────────────
  const markAsRead = async (notificationId) => {
    // Optimistic update
    setNotifications((prev) =>
      prev.map((n) => (n.id === notificationId ? { ...n, is_read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));

    try {
      await api.patch(`/notifications/${notificationId}/read`);
    } catch (err) {
      toast.error("Failed to mark notification as read");
      fetchNotifications();
    }
  };

  // ── Mark ALL read ──────────────────────────────────────────────────────────
  const markAllRead = async () => {
    if (loading) return;
    setLoading(true);

    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);

    try {
      await api.patch("/notifications/read-all");
      toast.success("All notifications marked as read");
    } catch (err) {
      console.error("markAllRead error:", err);
      toast.error("Failed to mark all notifications as read");
      fetchNotifications();
    } finally {
      setLoading(false);
    }
  };

  // ── Delete single ──────────────────────────────────────────────────────────
  const deleteNotification = async (e, notificationId) => {
    e.stopPropagation();

    const isUnread = notifications.find((n) => n.id === notificationId)?.is_read === false;

    // Optimistic update
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    if (isUnread) setUnreadCount((c) => Math.max(0, c - 1));

    try {
      await api.delete(`/notifications/${notificationId}`);
    } catch (err) {
      toast.error("Failed to delete notification");
      fetchNotifications();
    }
  };

  // ── Clear all ──────────────────────────────────────────────────────────────
  const clearAll = async () => {
    if (!window.confirm("Clear all notifications?")) return;

    // Optimistic update
    setNotifications([]);
    setUnreadCount(0);

    try {
      await api.delete("/notifications/clear-all");
      toast.success("All notifications cleared");
    } catch (err) {
      toast.error("Failed to clear notifications");
      fetchNotifications();
    }
  };

  // ── Click a notification: mark read + jump to the page it refers to ────────
  const handleNotificationClick = (n) => {
    if (!n.is_read) markAsRead(n.id);
    setOpen(false);
    const path = resolveNotificationPath(n);
    navigate(path);
  };

  // ── Split leave vs regular so leave shows a distinct colour + count ─────────
  const leaveUnread   = notifications.filter((n) => !n.is_read && n.type === "leave").length;
  const regularUnread = unreadCount - leaveUnread;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* ── Bell trigger ── */}
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-full border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50 hover:border-slate-300 shadow-sm transition-all dark:bg-slate-800/70 dark:border-slate-700 dark:text-slate-300 dark:hover:text-white dark:hover:bg-slate-700/70 dark:hover:border-slate-600"
          data-testid="notification-bell"
        >
          <Bell className="h-[18px] w-[18px]" />
          {/* Regular notifications — orange/rose badge (top-right) */}
          {regularUnread > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-gradient-to-br from-orange-500 to-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none ring-2 ring-white dark:ring-slate-900 shadow"
              data-testid="notification-count"
            >
              {regularUnread > 99 ? "99+" : regularUnread}
            </span>
          )}
          {/* Leave notifications — distinct rose/pink badge (top-left) */}
          {leaveUnread > 0 && (
            <span
              className="absolute -top-1 -left-1 min-w-[18px] h-[18px] px-1 bg-gradient-to-br from-rose-600 to-pink-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none ring-2 ring-white dark:ring-slate-900 shadow"
              data-testid="notification-leave-count"
              title={`${leaveUnread} leave application${leaveUnread !== 1 ? "s" : ""}`}
            >
              {leaveUnread > 99 ? "99+" : leaveUnread}
            </span>
          )}
        </Button>
      </PopoverTrigger>


      {/* ── Popover panel ── */}
      <PopoverContent
        className="w-[min(384px,calc(100vw-1.5rem))] p-0 shadow-xl border border-slate-200 rounded-xl overflow-hidden"
        align="end"
      >
        {/* Header — brand blue, matches the dashboard banner */}
        <div
          className="px-4 py-3.5 flex items-center justify-between relative overflow-hidden"
          style={{ background: HEADER_GRADIENT }}
        >
          {/* subtle decorative glow, echoes the dashboard banner treatment */}
          <div
            className="pointer-events-none absolute -top-8 -right-10 w-32 h-32 rounded-full opacity-20"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }}
          />

          <div className="flex items-center gap-2 flex-wrap relative">
            <div className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center">
              <Bell className="h-4 w-4 text-white" />
            </div>
            <h3 className="font-semibold text-white text-sm">Notifications</h3>
            {regularUnread > 0 && (
              <span className="bg-white/20 text-white text-xs font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm">
                {regularUnread} new
              </span>
            )}
            {leaveUnread > 0 && (
              <span className="bg-rose-500/90 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                {leaveUnread} leave
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 relative">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading}
                className="flex items-center gap-1 text-xs text-white/90 hover:text-white font-medium disabled:opacity-50 transition-colors"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                {loading ? "Marking…" : "Mark all read"}
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1 text-xs text-white/80 hover:text-white font-medium transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <ScrollArea className="h-[420px] bg-slate-50">
          {notifications.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-full py-16 text-slate-400"
              data-testid="no-notifications"
            >
              <Bell className="h-10 w-10 mb-3 text-slate-200" />
              <p className="text-sm font-medium">You're all caught up!</p>
              <p className="text-xs mt-1 text-slate-300">No notifications yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {notifications.map((n) => {
                const meta = getMeta(n.type);
                const Icon = meta.icon;
                const isLeave = n.type === "leave";

                return (
                  <div
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    className={`group relative flex gap-3 px-4 py-3.5 cursor-pointer transition-colors ${
                      isLeave ? "hover:bg-rose-50/70" : "hover:bg-white"
                    } ${
                      !n.is_read
                        ? isLeave
                          ? "bg-rose-50 border-l-4 border-l-rose-500"
                          : "bg-white border-l-2"
                        : isLeave
                        ? "bg-rose-50/40"
                        : "bg-slate-50"
                    }`}
                    style={!n.is_read && !isLeave ? { borderLeftColor: BRAND_MEDIUM_BLUE } : undefined}
                    onClick={() => handleNotificationClick(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleNotificationClick(n);
                      }
                    }}
                    data-testid={`notification-item-${n.id}`}
                  >
                    {/* Type icon */}
                    <div
                      className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${meta.bg}`}
                    >
                      <Icon className={`h-4 w-4 ${meta.color}`} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-sm font-medium truncate ${
                          isLeave
                            ? "text-rose-700"
                            : !n.is_read
                            ? "text-slate-900"
                            : "text-slate-600"
                        }`}
                      >
                        {n.title}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">
                        {n.message}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-1.5">
                        {formatDate(n.created_at)}
                      </p>
                    </div>

                    {/* Clickable affordance */}
                    <ChevronRight className="flex-shrink-0 h-4 w-4 text-slate-300 mt-1.5 group-hover:text-slate-400 group-hover:translate-x-0.5 transition-all" />

                    {/* Unread dot */}
                    {!n.is_read && (
                      <div
                        className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${isLeave ? "bg-rose-500" : ""}`}
                        style={!isLeave ? { backgroundColor: BRAND_MEDIUM_BLUE } : undefined}
                      />
                    )}


                    {/* Delete button — visible on hover */}
                    <button
                      onClick={(e) => deleteNotification(e, n.id)}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-50"
                      title="Remove notification"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-slate-300 hover:text-red-400 transition-colors" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {notifications.length > 0 && (
          <div className="px-4 py-2.5 bg-white border-t border-slate-100 text-center">
            <p className="text-xs text-slate-400">
              {notifications.length} notification
              {notifications.length !== 1 ? "s" : ""} total
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default NotificationBell;
