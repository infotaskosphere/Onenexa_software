import React, { useState, useEffect, useCallback, useRef } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import { RefreshCw, CheckCircle2, CloudOff, Laptop, Server, Settings2 } from "lucide-react";

export default function DesktopSyncWidget({ isDark }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState(false);
  const [customTarget, setCustomTarget] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const popoverRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      const res = await api.get("/desktop/local-first/status", {
        headers: token ? { Authorization: "Bearer " + token } : {},
        timeout: 4000,
      });
      if (res.data) {
        setStatus(res.data);
        if (!customTarget && res.data.sync_target) {
          setCustomTarget(res.data.sync_target === "local_hub" ? "" : res.data.sync_target);
        }
      }
    } catch {
      // Local-first API may not be enabled on pure cloud instances without desktop
    }
  }, [customTarget]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      const res = await api.post(
        "/desktop/local-first/sync/trigger",
        { sync_target_url: customTarget.trim() || undefined },
        {
          headers: token ? { Authorization: "Bearer " + token } : {},
          timeout: 20000,
        }
      );
      if (res.data?.status === "success") {
        toast.success(`Sync finished: ${res.data.pushed} pushed, ${res.data.pulled} pulled`);
        await fetchStatus();
      } else {
        toast.info(res.data?.message || "Sync checked");
      }
    } catch (err) {
      toast.error("Sync failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    const handleOnline = () => {
      triggerSync();
    };
    window.addEventListener("online", handleOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
    };
  }, [fetchStatus]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!status) return null;

  const pending = status.pending || 0;
  const isSyncing = syncing;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all ${
          isDark
            ? "border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200"
            : "border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700"
        }`}
        title="Desktop Local-First Sync Status"
      >
        <RefreshCw className={`h-3 w-3 ${isSyncing ? "animate-spin text-blue-500" : pending > 0 ? "text-amber-500" : "text-emerald-500"}`} />
        <span className="hidden sm:inline">
          {isSyncing ? "Syncing…" : pending > 0 ? `${pending} pending` : "Synced"}
        </span>
        <span
          className={`w-2 h-2 rounded-full ${
            isSyncing ? "bg-blue-500 animate-ping" : pending > 0 ? "bg-amber-500" : "bg-emerald-500"
          }`}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-80 rounded-2xl border p-4 shadow-xl z-[250] text-xs"
          style={{
            background: isDark ? "#0f172a" : "#ffffff",
            borderColor: isDark ? "#334155" : "#e2e8f0",
            color: isDark ? "#f8fafc" : "#0f172a",
          }}
        >
          <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
            <div className="flex items-center gap-2">
              <Laptop className="h-4 w-4 text-blue-500" />
              <span className="font-bold text-sm">Offline-First Sync</span>
            </div>
            <button
              onClick={() => setShowConfig((p) => !p)}
              className="text-slate-400 hover:text-blue-500 transition-colors p-1"
              title="Configure Sync Target"
            >
              <Settings2 className="h-4 w-4" />
            </button>
          </div>

          <div className="py-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Node Status</span>
              <span className="font-semibold flex items-center gap-1 text-emerald-500">
                <CheckCircle2 className="h-3 w-3" /> Local SQLite Active
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Queued Offline Changes</span>
              <span className={`font-bold ${pending > 0 ? "text-amber-500" : "text-slate-300"}`}>
                {pending} changes
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Target Server</span>
              <span className="font-mono text-[11px] truncate max-w-[150px] text-slate-300">
                {customTarget || status.sync_target || "Local Hub"}
              </span>
            </div>
          </div>

          {showConfig && (
            <div className="pt-2 pb-3 border-t space-y-1.5" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
              <label className="text-[11px] font-semibold text-slate-400">Admin PC / Cloud Sync Target URL</label>
              <input
                type="text"
                value={customTarget}
                onChange={(e) => setCustomTarget(e.target.value)}
                placeholder="e.g. http://192.168.1.50:7432"
                className={`w-full px-2.5 py-1.5 rounded-lg border text-xs outline-none ${
                  isDark ? "bg-slate-900 border-slate-700 text-white" : "bg-slate-50 border-slate-300"
                }`}
              />
            </div>
          )}

          <div className="pt-3 border-t flex gap-2" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
            <button
              disabled={isSyncing}
              onClick={triggerSync}
              className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all disabled:opacity-50 shadow-sm"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
              {isSyncing ? "Syncing with Hub…" : "Sync Now"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
