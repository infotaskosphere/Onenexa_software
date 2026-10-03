import React, { useState, useEffect, useCallback, useRef } from "react";
import { Bell, BellRing, CalendarClock, ClipboardCheck, MapPin, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { hasModuleAccess, isPlatformOwner } from "@/lib/commercialPermissionMatrix";

// How often to ask the backend "is anything due right now?"
// Default is 30 s; users can override it from the "Notification settings"
// panel on the Reminders page (writes localStorage key below).
// Per-item intervals live on the reminder/task itself (popup_interval_minutes)
// and are honoured server-side when computing remind_at.
const POPUP_POLL_LS_KEY = "universal_popup_poll_seconds";
const DEFAULT_POLL_SECONDS = 30;
const MIN_POLL_SECONDS = 5;

const readPollIntervalMs = () => {
  try {
    const raw = localStorage.getItem(POPUP_POLL_LS_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_POLL_SECONDS) {
      return parsed * 1000;
    }
  } catch {}
  return DEFAULT_POLL_SECONDS * 1000;
};

const TYPE_META = {
  task_assigned: { icon: ClipboardCheck, color: "text-indigo-600", bg: "bg-indigo-50" },
  task_popup: { icon: Bell, color: "text-rose-600", bg: "bg-rose-50" },
  daily_summary: { icon: Bell, color: "text-amber-600", bg: "bg-amber-50" },
  visit: { icon: MapPin, color: "text-emerald-600", bg: "bg-emerald-50" },
  meeting: { icon: CalendarClock, color: "text-purple-600", bg: "bg-purple-50" },
  reminder: { icon: Bell, color: "text-slate-600", bg: "bg-slate-100" },
};

const getMeta = (type) => TYPE_META[type] || TYPE_META.reminder;

// Fires a native OS-level desktop notification (via the browser Notification
// API) so the reminder is visible even when the Chrome window is minimized
// or another app is focused — the in-app <Dialog> below only ever paints
// while this tab is the visible, foregrounded one.
const fireDesktopNotification = (item) => {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(item.title || "Task-o-sphere Reminder", {
      body: item.message || "",
      tag: `tos-popup-${item.id}`,
      icon: "/favicon.ico",
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      if (item.task_id) {
        window.location.assign(`/tasks?taskId=${item.task_id}`);
      }
      n.close();
    };
  } catch {
    // Desktop notifications are a best-effort enhancement — never let a
    // failure here disrupt the in-app popup queue below.
  }
};

/**
 * Mounted once near the root of the app (inside AuthProvider, outside the
 * route switch) so it keeps polling and can pop up on top of ANY page.
 */
export default function ReminderPopupManager() {
  const { user } = useAuth();
  const [queue, setQueue] = useState([]);
  const pollRef = useRef(null);
  const fetchInFlightRef = useRef(false);

  // Ask for desktop-notification permission once per session (a no-op if
  // already granted/denied, and browsers ignore repeated prompts anyway).
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const fetchDuePopups = useCallback(async () => {
    if (!user) return;
    // Reminders are a Taskosphere feature. Do not poll this endpoint for
    // Finix-only or other module-only licenses, where a 403 is expected.
    if (!isPlatformOwner(user) && !hasModuleAccess(user, "taskosphere")) return;
    try {
      const { data } = await api.get("/reminders/due-popups");
      if (Array.isArray(data) && data.length > 0) {
        setQueue((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const fresh = data.filter((p) => !existingIds.has(p.id));
          fresh.forEach(fireDesktopNotification);
          return [...prev, ...fresh];
        });
      }
    } catch (err) {
      // Silent — popup polling should never disrupt the rest of the app
      console.error("Failed to fetch due popups:", err);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (!isPlatformOwner(user) && !hasModuleAccess(user, "taskosphere")) {
      setQueue([]);
      return;
    }
    fetchDuePopups(); // check immediately on login / page load

    const start = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(fetchDuePopups, readPollIntervalMs());
    };
    start();

    // React live to setting changes from the Notification settings panel
    const onChange = (e) => {
      if (!e || e.key === POPUP_POLL_LS_KEY || e.type === "popup-interval-changed") {
        start();
      }
    };
    window.addEventListener("storage", onChange);
    window.addEventListener("popup-interval-changed", onChange);
    return () => {
      clearInterval(pollRef.current);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("popup-interval-changed", onChange);
    };
  }, [user, fetchDuePopups]);

  const dismissCurrent = () => {
    setQueue((prev) => prev.slice(1));
  };

  const current = queue[0];
  if (!current || !user) return null;

  const meta = getMeta(current.type);
  const Icon = meta.icon;

  return (
    <Dialog open={!!current} onOpenChange={(open) => !open && dismissCurrent()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="reminder-popup"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${meta.bg}`}>
              <Icon className={`h-5 w-5 ${meta.color}`} />
            </div>
            <div className="flex-1">
              <DialogTitle>{current.title}</DialogTitle>
            </div>
          </div>
          <DialogDescription className="pt-2 text-sm text-slate-600">
            {current.message}
          </DialogDescription>
        </DialogHeader>

        {queue.length > 1 && (
          <p className="text-xs text-slate-400">
            {queue.length - 1} more reminder{queue.length - 1 !== 1 ? "s" : ""} waiting
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={dismissCurrent} data-testid="reminder-popup-dismiss">
            <X className="h-4 w-4 mr-1.5" />
            Dismiss
          </Button>
          <Button onClick={dismissCurrent} data-testid="reminder-popup-ok">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
