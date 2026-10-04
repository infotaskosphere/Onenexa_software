import React, { useCallback, useEffect, useState } from "react";
import { Monitor, Smartphone, ShieldCheck, LogOut, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";

export default function SecuritySessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get("/auth/sessions");
      setSessions(Array.isArray(response?.data) ? response.data : []);
    } catch (error) {
      toast.error("Unable to load active sessions", {
        description: error?.response?.data?.detail || "Please try again.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const revoke = async (sessionId) => {
    setRevoking(sessionId);
    try {
      await api.post(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`);
      toast.success("Session revoked.");
      await loadSessions();
    } catch (error) {
      toast.error("Unable to revoke session", {
        description: error?.response?.data?.detail || "Please try again.",
      });
    } finally {
      setRevoking(null);
    }
  };

  const revokeAll = async () => {
    setRevoking("all");
    try {
      await api.post("/auth/sessions/revoke-all");
      toast.success("All active sessions revoked.");
      await loadSessions();
    } catch (error) {
      toast.error("Unable to revoke sessions", {
        description: error?.response?.data?.detail || "Please try again.",
      });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Security & Sessions</h1>
          <p className="text-sm text-slate-500 mt-1">
            Review active browser and device sessions for your account.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadSessions}
            disabled={loading || revoking}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            type="button"
            onClick={revokeAll}
            disabled={loading || revoking || sessions.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <LogOut size={16} />
            Revoke all
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading active sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-sm text-slate-500">No active server sessions found.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {sessions.map((session) => {
              const mobile = /mobile|android|iphone|ipad/i.test(session.user_agent || "");
              return (
                <div key={session.id} className="p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-1 rounded-lg bg-slate-100 p-2 text-slate-700">
                      {mobile ? <Smartphone size={18} /> : <Monitor size={18} />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-slate-900">Active session</p>
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          <ShieldCheck size={12} /> Active
                        </span>
                      </div>
                      <p className="text-sm text-slate-500 mt-1 break-all">
                        {session.user_agent || "Unknown browser/device"}
                      </p>
                      <div className="text-xs text-slate-400 mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        <span>IP: {session.client_ip || "Unavailable"}</span>
                        <span>Signed in: {session.created_at ? new Date(session.created_at).toLocaleString() : "Unavailable"}</span>
                        <span>Expires: {session.expires_at ? new Date(session.expires_at).toLocaleString() : "Unavailable"}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(session.id)}
                    disabled={!!revoking}
                    className="self-start lg:self-auto inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
                  >
                    <LogOut size={15} />
                    {revoking === session.id ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
