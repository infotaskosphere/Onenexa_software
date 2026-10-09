import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useDark } from "@/hooks/useDark";
import api from "@/lib/api";
import { toast } from "sonner";
import { ArrowLeft, Cloud, Database, RefreshCw, Save, Trash2, WifiOff } from "lucide-react";
import { useNavigate } from "react-router-dom";

const EMPTY_FORM = {
  company_name: "",
  client_type: "proprietor",
  phone: "",
  email: "",
  address: "",
  city: "",
  state: "",
  services: "",
  notes: "",
};

function sessionStorageKey(user) {
  return "onenexa_local_session:" + String(user?.company_id || "") + ":" + String(user?.id || "");
}

export default function LocalFirstClients() {
  const { user } = useAuth();
  const isDark = useDark();
  const navigate = useNavigate();
  const [localToken, setLocalToken] = useState("");
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const handleTriggerSync = async () => {
    if (!localToken) return;
    setSyncing(true);
    try {
      const res = await api.post(
        "/desktop/local-first/sync/trigger",
        {},
        {
          headers: { Authorization: "Bearer " + localToken },
          timeout: 15000,
        }
      );
      if (res.data?.status === "success") {
        await loadLocalClients();
      }
    } catch {
      // Silent sync fallback
    } finally {
      setSyncing(false);
    }
  };

  const headers = useMemo(
    () => localToken ? { Authorization: "Bearer " + localToken } : {},
    [localToken]
  );

  const loadLocalClients = useCallback(async (token = localToken) => {
    if (!token) return;
    setLoading(true);
    try {
      const response = await api.get("/desktop/local-first/records/client", {
        headers: { Authorization: "Bearer " + token },
        timeout: 7000,
      });
      setClients((response.data?.items || []).map((item) => item.record).filter(Boolean));
      setError("");
      try {
        const statusResponse = await api.get("/desktop/local-first/status", {
          headers: { Authorization: "Bearer " + token },
          timeout: 5000,
        });
        setSyncStatus(statusResponse.data || null);
      } catch {
        setSyncStatus(null);
      }
    } catch (requestError) {
      const message = requestError?.response?.data?.detail || requestError?.message || "Could not read local clients";
      setError(message);
      toast.error("Could not load local clients", { description: message });
    } finally {
      setLoading(false);
    }
  }, [localToken]);

  useEffect(() => {
    let cancelled = false;
    const initializeSession = async () => {
      setSessionLoading(true);
      setError("");
      const key = sessionStorageKey(user);
      const cachedToken = localStorage.getItem(key) || "";
      try {
        // The cloud-issued bearer token is used only to renew a device-local
        // session while online. All pilot record reads/writes use the local token.
        const response = await api.post(
          "/desktop/local-first/session",
          {},
          { timeout: 4000 }
        );
        const token = response.data?.offline_token;
        if (!token) throw new Error("The local session was not returned by the backend");
        localStorage.setItem(key, token);
        localStorage.setItem("onenexa_desktop_cached_user", JSON.stringify(user));
        if (!cancelled) setLocalToken(token);
      } catch {
        // A previously issued device token allows the pilot workspace to open
        // without a fresh cloud/MongoDB lookup, until its expiry.
        if (cachedToken && !cancelled) {
          setLocalToken(cachedToken);
        } else if (!cancelled) {
          setError("Connect to the internet and sign in once to enable this device's local Clients workspace. After that, it can be used offline until the local session expires.");
        }
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    };
    if (user?.id && user?.company_id) initializeSession();
    else {
      setSessionLoading(false);
      setError("A signed-in company user is required to use local Clients.");
    }
    return () => { cancelled = true; };
  }, [user?.id, user?.company_id]);

  useEffect(() => {
    if (localToken) loadLocalClients(localToken);
  }, [localToken, loadLocalClients]);

  const visibleClients = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter((client) =>
      [client.company_name, client.phone, client.email, client.city, client.gstin]
        .some((value) => String(value || "").toLowerCase().includes(term))
    );
  }, [clients, query]);

  const updateField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const resetForm = () => {
    setEditingId("");
    setForm(EMPTY_FORM);
  };

  const handleEdit = (client) => {
    setEditingId(client.id);
    setForm({
      ...EMPTY_FORM,
      ...client,
      services: Array.isArray(client.services) ? client.services.join(", ") : String(client.services || ""),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!localToken) {
      toast.error("Local session is not available");
      return;
    }
    if (!form.company_name.trim()) {
      toast.error("Client / company name is required");
      return;
    }
    setSaving(true);
    try {
      const record = {
        ...form,
        company_name: form.company_name.trim(),
        services: form.services.split(",").map((value) => value.trim()).filter(Boolean),
        client_type: form.client_type || "proprietor",
        status: editingId ? (clients.find((client) => client.id === editingId)?.status || "active") : "active",
      };
      const payload = editingId ? { id: editingId, record } : { record };
      await api.post("/desktop/local-first/records/client", payload, {
        headers,
        timeout: 7000,
      });
      toast.success(editingId ? "Client saved on this computer" : "Client created on this computer");
      resetForm();
      await loadLocalClients(localToken);
    } catch (requestError) {
      const message = requestError?.response?.data?.detail || requestError?.message || "Could not save client locally";
      toast.error("Local save failed", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (client) => {
    if (!localToken || !window.confirm("Delete " + client.company_name + " from this computer's local pilot workspace?")) return;
    try {
      await api.delete("/desktop/local-first/records/client/" + encodeURIComponent(client.id), {
        headers,
        timeout: 7000,
      });
      toast.success("Client removed from the local workspace");
      if (editingId === client.id) resetForm();
      await loadLocalClients(localToken);
    } catch (requestError) {
      const message = requestError?.response?.data?.detail || requestError?.message || "Could not delete client";
      toast.error("Delete failed", { description: message });
    }
  };

  const canDelete = String(user?.role || "").toLowerCase() === "admin" || user?.permissions?.can_delete_data === true;
  const pageBg = isDark ? "#0b1220" : "#f4f7fb";
  const cardBg = isDark ? "#111c2e" : "#ffffff";
  const borderColor = isDark ? "#26354a" : "#dbe4ef";
  const textColor = isDark ? "#e5edf7" : "#10233f";
  const mutedColor = isDark ? "#9aabc1" : "#62748a";
  const inputStyle = {
    width: "100%",
    minWidth: 0,
    border: "1px solid " + borderColor,
    background: isDark ? "#0b1627" : "#fff",
    color: textColor,
    borderRadius: 9,
    padding: "10px 12px",
    fontSize: 13,
    outline: "none",
  };

  return (
    <div className="min-h-full space-y-5 p-1" style={{ background: pageBg, color: textColor }}>
      <div className="rounded-2xl p-5 sm:p-7 text-white shadow-sm" style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15"><Database className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold">Local Clients · Offline Pilot</h1>
            <p className="mt-1 max-w-3xl text-sm text-blue-100">Pilot records are stored in this computer's OneNexa SQLite database. They are separate from the live cloud Clients list while this stage is being tested.</p>
          </div>
          <button onClick={() => navigate("/clients")} className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20">
            <ArrowLeft className="h-4 w-4" /> Online Clients
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5"><WifiOff className="h-3.5 w-3.5" /> Local-first SQLite</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5">
            <Cloud className="h-3.5 w-3.5" /> {syncStatus?.sync_enabled ? `Sync Enabled (${syncStatus.sync_target})` : "Standalone Node"}
          </span>
          {syncStatus && <span className="rounded-full bg-white/15 px-3 py-1.5">{syncStatus.pending || 0} queued outbox change(s)</span>}
          <button
            type="button"
            disabled={syncing}
            onClick={handleTriggerSync}
            className="inline-flex items-center gap-1.5 rounded-full bg-white text-blue-900 px-3 py-1.5 font-bold hover:bg-blue-50 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing with Hub…" : "Sync with Admin / Cloud"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border p-4 text-sm" style={{ borderColor: "#f59e0b", background: isDark ? "#2a2113" : "#fffbeb", color: isDark ? "#fde68a" : "#92400e" }}>
          {error}
        </div>
      )}

      {(sessionLoading || loading) && (
        <div className="rounded-xl border p-4 text-sm" style={{ background: cardBg, borderColor, color: mutedColor }}>
          {sessionLoading ? "Checking this device's local session…" : "Loading local clients…"}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <form onSubmit={handleSave} className="space-y-4 rounded-2xl border p-5 shadow-sm" style={{ background: cardBg, borderColor }}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold">{editingId ? "Edit local client" : "Add local client"}</h2>
              <p className="mt-1 text-xs" style={{ color: mutedColor }}>Saved to this computer; no cloud write is performed.</p>
            </div>
            {editingId && <button type="button" onClick={resetForm} className="text-xs font-semibold" style={{ color: mutedColor }}>Cancel edit</button>}
          </div>
          <label className="block text-xs font-semibold">Client / Company name *
            <input required maxLength={240} value={form.company_name} onChange={(e) => updateField("company_name", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="e.g. Example Private Limited" />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold">Constitution
              <select value={form.client_type} onChange={(e) => updateField("client_type", e.target.value)} style={{ ...inputStyle, marginTop: 6 }}>
                <option value="proprietor">Proprietor</option>
                <option value="pvt_ltd">Private Limited</option>
                <option value="llp">LLP</option>
                <option value="partnership">Partnership</option>
                <option value="huf">HUF</option>
                <option value="trust">Trust</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="block text-xs font-semibold">Phone
              <input value={form.phone || ""} onChange={(e) => updateField("phone", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="Phone number" />
            </label>
            <label className="block text-xs font-semibold">Email
              <input type="email" value={form.email || ""} onChange={(e) => updateField("email", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="name@example.com" />
            </label>
            <label className="block text-xs font-semibold">City
              <input value={form.city || ""} onChange={(e) => updateField("city", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="City" />
            </label>
            <label className="block text-xs font-semibold">State
              <input value={form.state || ""} onChange={(e) => updateField("state", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="State" />
            </label>
            <label className="block text-xs font-semibold">Services (comma-separated)
              <input value={form.services || ""} onChange={(e) => updateField("services", e.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="GST, ROC, Trademark" />
            </label>
          </div>
          <label className="block text-xs font-semibold">Address
            <textarea rows={2} value={form.address || ""} onChange={(e) => updateField("address", e.target.value)} style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} placeholder="Registered / communication address" />
          </label>
          <label className="block text-xs font-semibold">Notes
            <textarea rows={2} value={form.notes || ""} onChange={(e) => updateField("notes", e.target.value)} style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} placeholder="Internal notes for this pilot record" />
          </label>
          <button type="submit" disabled={!localToken || saving || sessionLoading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}>
            <Save className="h-4 w-4" /> {saving ? "Saving locally…" : editingId ? "Save changes locally" : "Create client locally"}
          </button>
        </form>

        <section className="min-w-0 rounded-2xl border p-5 shadow-sm" style={{ background: cardBg, borderColor }}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Clients on this computer</h2>
              <p className="mt-1 text-xs" style={{ color: mutedColor }}>{clients.length} local record(s) · stored independently of cloud clients</p>
            </div>
            <button onClick={() => loadLocalClients()} disabled={!localToken || loading} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50" style={{ borderColor, color: textColor }}>
              <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} /> Refresh
            </button>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} style={{ ...inputStyle, marginTop: 16 }} placeholder="Search local clients by name, phone, email or city…" />
          <div className="mt-4 space-y-2">
            {!loading && visibleClients.length === 0 && (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor, color: mutedColor }}>
                {clients.length ? "No clients match your search." : "No local clients yet. Create the first record using the form."}
              </div>
            )}
            {visibleClients.map((client) => (
              <div key={client.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3" style={{ borderColor }}>
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl font-bold text-white" style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}>
                  {String(client.company_name || "?").charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-bold">{client.company_name}</p>
                  <p className="mt-1 break-words text-xs" style={{ color: mutedColor }}>{[client.phone, client.email, client.city, client.state].filter(Boolean).join(" · ") || "No contact details"}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide" style={{ color: mutedColor }}>{client.client_type || "proprietor"} · Local only</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleEdit(client)} className="rounded-lg border px-3 py-2 text-xs font-semibold" style={{ borderColor, color: textColor }}>Edit</button>
                  {canDelete && <button onClick={() => handleDelete(client)} className="rounded-lg border px-3 py-2 text-xs font-semibold text-red-600" style={{ borderColor }} title="Delete local pilot client"><Trash2 className="h-3.5 w-3.5" /></button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <p className="px-1 text-xs" style={{ color: mutedColor }}>Pilot safety: these records are stored locally and are not yet synchronized to the cloud, another workstation, invoices, or the main Clients list. The device-local session expires after 72 hours unless renewed online.</p>
    </div>
  );
}
