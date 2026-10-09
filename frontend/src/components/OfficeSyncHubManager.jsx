import React, { useState, useEffect, useCallback } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  Server, Laptop, RefreshCw, Copy, Check, Download,
  ShieldCheck, Wifi, Cloud, AlertCircle, Database
} from "lucide-react";

export default function OfficeSyncHubManager({ isDark }) {
  const [hubInfo, setHubInfo] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const fetchHubData = useCallback(async () => {
    setLoading(true);
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      const headers = token ? { Authorization: "Bearer " + token } : {};
      const [infoRes, nodesRes] = await Promise.allSettled([
        api.get("/desktop/local-first/hub/info", { headers, timeout: 5000 }),
        api.get("/desktop/local-first/hub/nodes", { headers, timeout: 5000 }),
      ]);
      if (infoRes.status === "fulfilled") setHubInfo(infoRes.value.data);
      if (nodesRes.status === "fulfilled") setNodes(nodesRes.value.data?.nodes || []);
    } catch {
      // Not on desktop
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHubData();
  }, [fetchHubData]);

  const copyToClipboard = (text, type = "url") => {
    navigator.clipboard.writeText(text);
    if (type === "url") {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
    toast.success("Copied to clipboard!");
  };

  const handleDownloadBackup = async () => {
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      const res = await api.get("/desktop/local-first/database/snapshot", {
        headers: token ? { Authorization: "Bearer " + token } : {},
        responseType: "blob",
        timeout: 15000,
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `onenexa-local-backup-${new Date().toISOString().slice(0, 10)}.db`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("Database backup downloaded successfully!");
    } catch (err) {
      toast.error("Backup download failed: " + (err.response?.data?.detail || err.message));
    }
  };

  const handleTriggerSync = async () => {
    setSyncing(true);
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      const res = await api.post("/desktop/local-first/sync/trigger", {}, {
        headers: token ? { Authorization: "Bearer " + token } : {},
        timeout: 20000,
      });
      if (res.data?.status === "success") {
        toast.success(`Sync cycle completed: ${res.data.pushed} pushed, ${res.data.pulled} pulled`);
        await fetchHubData();
      } else {
        toast.info(res.data?.message || "Sync finished");
      }
    } catch (err) {
      toast.error("Sync failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setSyncing(false);
    }
  };

  const cardBg = isDark ? "bg-slate-800/60 border-slate-700" : "bg-white border-slate-200";
  const subText = isDark ? "text-slate-400" : "text-slate-500";

  if (loading && !hubInfo) {
    return (
      <div className={`p-8 text-center rounded-2xl border ${cardBg}`}>
        <RefreshCw className="h-6 w-6 animate-spin text-blue-500 mx-auto mb-2" />
        <p className="text-sm font-semibold">Inspecting local office network configuration…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="rounded-2xl p-6 text-white shadow-sm" style={{ background: "linear-gradient(135deg, #0D3B66 0%, #1F6FB2 100%)" }}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-white/15 flex items-center justify-center">
              <Server className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Office Multi-PC Sync & Network Hub</h2>
              <p className="text-xs text-blue-100 mt-0.5">
                Each computer saves data offline into SQLite and automatically merges changes with this Admin PC and Platform Owner.
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleTriggerSync}
              disabled={syncing}
              className="px-3.5 py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-bold transition-all flex items-center gap-1.5 backdrop-blur-sm disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync All Now"}
            </button>
            <button
              onClick={handleDownloadBackup}
              className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm"
            >
              <Download className="h-3.5 w-3.5" />
              Backup .db File
            </button>
          </div>
        </div>
      </div>

      {/* Network Pairing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Hub Address */}
        <div className={`rounded-2xl border p-5 ${cardBg}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-blue-500" />
              <h3 className="font-bold text-sm">Office Hub URL</h3>
            </div>
            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500">
              Active on LAN
            </span>
          </div>
          <p className={`text-xs mb-3 ${subText}`}>
            Enter this URL on staff laptops under Desktop Sync settings to connect them to this office server:
          </p>
          <div className="flex items-center gap-2">
            <code className={`flex-1 px-3 py-2 rounded-xl border text-xs font-mono font-bold truncate ${
              isDark ? "bg-slate-900 border-slate-700 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
            }`}>
              {hubInfo?.hub_url || "http://127.0.0.1:7432"}
            </code>
            <button
              onClick={() => copyToClipboard(hubInfo?.hub_url || "http://127.0.0.1:7432", "url")}
              className={`p-2 rounded-xl border transition-all ${
                isDark ? "hover:bg-slate-700 border-slate-700" : "hover:bg-slate-100 border-slate-200"
              }`}
              title="Copy Hub URL"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Pairing Code & Platform Cloud */}
        <div className={`rounded-2xl border p-5 ${cardBg}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-indigo-500" />
              <h3 className="font-bold text-sm">Platform Owner Relay</h3>
            </div>
            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500">
              Cloud Backup
            </span>
          </div>
          <p className={`text-xs mb-3 ${subText}`}>
            When internet starts, merged changes from this hub are automatically synchronized with the Platform Owner cloud server.
          </p>
          <div className="flex items-center justify-between py-1.5 border-t" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
            <span className={`text-xs ${subText}`}>Office Pairing PIN:</span>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-500">
                {hubInfo?.pairing_code || "NX-DEFAULT"}
              </span>
              <button
                onClick={() => copyToClipboard(hubInfo?.pairing_code || "NX-DEFAULT", "code")}
                className="text-slate-400 hover:text-blue-500"
              >
                {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Connected Workstations List */}
      <div className={`rounded-2xl border overflow-hidden ${cardBg}`}>
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
          <div className="flex items-center gap-2">
            <Laptop className="h-4 w-4 text-emerald-500" />
            <h3 className="font-bold text-sm">Synchronized Staff Workstations</h3>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400">
              {nodes.length} PC{nodes.length === 1 ? "" : "s"}
            </span>
          </div>
          <button onClick={fetchHubData} className={`text-xs font-semibold hover:text-blue-500 ${subText}`}>
            Refresh List
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <AlertCircle className="h-8 w-8 text-slate-400 mx-auto" />
            <p className="text-xs font-semibold text-slate-400">No external staff workstations have synced yet.</p>
            <p className={`text-[11px] max-w-md mx-auto ${subText}`}>
              When other employees open the OneNexa .exe on their laptop and connect to this Hub URL, their PC will be listed here with its sync logs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={isDark ? "bg-slate-900/60 text-slate-400" : "bg-slate-50 text-slate-600"}>
                <tr>
                  <th className="p-3 font-semibold">Device ID</th>
                  <th className="p-3 font-semibold">Changes Merged</th>
                  <th className="p-3 font-semibold">Last Active (UTC)</th>
                  <th className="p-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: isDark ? "#334155" : "#f1f5f9" }}>
                {nodes.map((node) => (
                  <tr key={node.device_id} className={isDark ? "hover:bg-slate-800/40" : "hover:bg-slate-50/80"}>
                    <td className="p-3 font-mono font-medium">{node.device_id}</td>
                    <td className="p-3 font-bold text-blue-500">{node.total_changes} changes</td>
                    <td className={`p-3 ${subText}`}>{new Date(node.last_seen_at_utc).toLocaleString()}</td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-500">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Synchronized
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
