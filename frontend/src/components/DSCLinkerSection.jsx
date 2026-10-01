// =============================================================================
// DSCLinkerSection.jsx
// Replaces the manual DSC Details section inside the Client create/edit form.
// Lets users:
//   1. Browse & link existing DSC Register entries (filtered to this client or unassigned)
//   2. See expiry status badges inline
//   3. Still add manual DSC entries (fallback for DSCs not yet in the register)
// =============================================================================
import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Shield, Plus, Trash, Link2, Unlink2, Search, Loader2, AlertTriangle, CheckCircle2, Clock, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { differenceInDays } from "date-fns";
import api from "@/lib/api";
import { toast } from "sonner";

// ─── DSC expiry helpers ────────────────────────────────────────────────────────
function getDaysLeft(dateStr) {
  if (!dateStr) return null;
  try { return differenceInDays(new Date(dateStr), new Date()); }
  catch { return null; }
}

function ExpiryBadge({ dateStr }) {
  const days = getDaysLeft(dateStr);
  if (days === null) return null;
  if (days < 0)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-red-100 text-red-700"><AlertTriangle className="h-3 w-3" /> Expired</span>;
  if (days <= 30)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-orange-100 text-orange-700"><Clock className="h-3 w-3" /> {days}d left</span>;
  if (days <= 90)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-yellow-100 text-yellow-700"><Clock className="h-3 w-3" /> {days}d left</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" /> Valid</span>;
}

function fmt(dateStr) {
  if (!dateStr) return "—";
  try { return new Date(dateStr).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return "—"; }
}

// ─── DSC Register Picker Modal ────────────────────────────────────────────────
function DSCPickerModal({ open, onClose, dscRegister, loadingReg, companyName, onLink, alreadyLinkedIds, isDark }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dscRegister.filter(d => {
      if (alreadyLinkedIds.has(d.id)) return false; // already linked
      if (!q) return true;
      return (
        (d.holder_name || "").toLowerCase().includes(q) ||
        (d.associated_with || "").toLowerCase().includes(q) ||
        (d.dsc_type || "").toLowerCase().includes(q) ||
        (d.serial_number || "").toLowerCase().includes(q)
      );
    });
  }, [dscRegister, query, alreadyLinkedIds]);

  // Prioritise DSCs already associated with this client company name
  const sorted = useMemo(() => {
    if (!companyName) return filtered;
    const cn = companyName.trim().toLowerCase();
    return [...filtered].sort((a, b) => {
      const aMatch = (a.associated_with || "").toLowerCase() === cn;
      const bMatch = (b.associated_with || "").toLowerCase() === cn;
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
  }, [filtered, companyName]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-emerald-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col max-h-[80vh] ${isDark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-200"}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}>
              <Link2 className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className={`font-bold text-sm ${isDark ? "text-slate-100" : "text-slate-800"}`}>Link from DSC Register</p>
              <p className="text-[11px] text-slate-400">Select a certificate to attach to this client</p>
            </div>
          </div>
          <button onClick={onClose} className={`w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 ${isDark ? "hover:bg-slate-700" : "hover:bg-slate-100"}`}>✕</button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by holder name, company, type…"
              className={`w-full h-9 pl-8 pr-3 rounded-xl text-xs border outline-none focus:ring-2 focus:ring-blue-200 ${isDark ? "bg-slate-800 border-slate-600 text-slate-100 placeholder-slate-500" : "bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400"}`}
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loadingReg ? (
            <div className="flex items-center justify-center py-10 gap-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading DSC Register…
            </div>
          ) : sorted.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">
              {dscRegister.length === 0 ? "No DSC entries found in the register." : "No unlinked DSCs match your search."}
            </div>
          ) : (
            sorted.map(dsc => {
              const isClient = companyName && (dsc.associated_with || "").toLowerCase() === companyName.trim().toLowerCase();
              return (
                <button
                  key={dsc.id}
                  onClick={() => { onLink(dsc); onClose(); }}
                  className={`w-full text-left flex items-start gap-3 px-3 py-3 rounded-xl mb-1 border transition-all hover:shadow-sm ${isDark ? "border-slate-700 hover:bg-slate-800/80 hover:border-blue-500/40" : "border-slate-100 hover:bg-blue-50/60 hover:border-blue-200"} ${isClient ? (isDark ? "bg-blue-900/20 border-blue-500/30" : "bg-blue-50/70 border-blue-200") : ""}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Shield className="h-4 w-4 text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-semibold text-sm truncate ${isDark ? "text-slate-100" : "text-slate-800"}`}>{dsc.holder_name}</span>
                      {isClient && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 uppercase tracking-wider">This Client</span>}
                      <ExpiryBadge dateStr={dsc.expiry_date} />
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {dsc.dsc_type && <span className="text-[11px] text-slate-400">{dsc.dsc_type}</span>}
                      {dsc.associated_with && <span className="text-[11px] text-slate-400 truncate">· {dsc.associated_with}</span>}
                      {dsc.expiry_date && <span className="text-[11px] text-slate-400">· Exp: {fmt(dsc.expiry_date)}</span>}
                    </div>
                  </div>
                  <div className={`text-[11px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 ${isDark ? "bg-blue-500/20 text-blue-300" : "bg-blue-50 text-blue-600"}`}>Link</div>
                </button>
              );
            })
          )}
        </div>

        <div className="px-4 py-3 border-t text-xs text-slate-400 flex items-center justify-between" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}>
          <span>{sorted.length} certificate{sorted.length !== 1 ? "s" : ""} available</span>
          <a href="/dsc-register" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-500 hover:underline">
            <ExternalLink className="h-3 w-3" /> Open DSC Register
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export default function DSCLinkerSection({
  formData,         // full form data (needs formData.dsc_details array)
  setFormData,      // setter
  updateDSC,        // (idx, field, val) => void
  addDSC,           // () => void  — adds blank manual entry
  removeDSC,        // (idx) => void
  companyName,      // string — used to pre-match DSC register entries
  isDark,
  labelCls,
  fieldCls,
}) {
  const [dscRegister, setDscRegister] = useState([]);
  const [loadingReg, setLoadingReg]   = useState(false);
  const [pickerOpen, setPickerOpen]   = useState(false);
  const [expanded, setExpanded]       = useState({}); // idx → bool (manual card expand)

  // Fetch DSC Register once when section mounts
  useEffect(() => {
    let cancelled = false;
    setLoadingReg(true);
    api.get("/dsc", { params: { limit: 500 } })
      .then(res => {
        if (cancelled) return;
        const data = res.data;
        const items = Array.isArray(data) ? data : (data?.data || data?.dscs || data?.items || []);
        setDscRegister(items);
      })
      .catch((err) => {
        console.error("DSCLinkerSection: failed to load DSC register", err);
        toast.error("Could not load DSC Register — check permissions.");
      })
      .finally(() => { if (!cancelled) setLoadingReg(false); });
    return () => { cancelled = true; };
  }, []);

  // IDs of DSC register entries already linked (stored as dsc._register_id)
  const alreadyLinkedIds = useMemo(() => {
    const s = new Set();
    (formData.dsc_details || []).forEach(d => { if (d._register_id) s.add(d._register_id); });
    return s;
  }, [formData.dsc_details]);

  // Link a DSC register entry → create a dsc_details entry pre-filled from register
  const handleLink = useCallback((regEntry) => {
    const newEntry = {
      _register_id:       regEntry.id,           // hidden link back to register
      certificate_number: regEntry.serial_number || "",
      holder_name:        regEntry.holder_name   || "",
      issue_date:         regEntry.issue_date    ? regEntry.issue_date.slice(0, 10) : "",
      expiry_date:        regEntry.expiry_date   ? regEntry.expiry_date.slice(0, 10) : "",
      notes:              regEntry.notes         || "",
      dsc_type:           regEntry.dsc_type      || "",
      associated_with:    regEntry.associated_with || "",
      _linked: true,  // flag so UI can show "linked" badge
    };
    setFormData(prev => ({ ...prev, dsc_details: [...(prev.dsc_details || []), newEntry] }));
  }, [setFormData]);

  // Unlink a register-linked entry (just removes it from form)
  const handleUnlink = useCallback((idx) => {
    setFormData(prev => ({ ...prev, dsc_details: prev.dsc_details.filter((_, i) => i !== idx) }));
  }, [setFormData]);

  const toggleExpand = (idx) => setExpanded(p => ({ ...p, [idx]: !p[idx] }));

  const dscList = formData.dsc_details || [];

  return (
    <div className={`border rounded-2xl p-6 ${isDark ? "bg-slate-800/60 border-slate-700" : "bg-slate-50/60 border-slate-100"}`}>
      {/* Section header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}>
            <Shield className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className={`font-bold text-sm leading-tight ${isDark ? "text-slate-100" : "text-slate-800"}`}>DSC Details</p>
            <p className="text-[11px] text-slate-400">Digital Signature Certificates</p>
          </div>
        </div>
        <div className="flex items-center gap-2 -mt-2">
          {/* Link from register */}
          <Button
            type="button"
            size="sm"
            onClick={() => setPickerOpen(true)}
            className="h-8 px-3 text-xs rounded-xl text-white gap-1.5"
            style={{ background: "linear-gradient(135deg,#0D3B66,#1F6FB2)" }}
          >
            {loadingReg
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Link2 className="h-3 w-3" />}
            Link from Register
          </Button>
          {/* Add manually */}
          <Button
            type="button"
            size="sm"
            onClick={addDSC}
            variant="outline"
            className="h-8 px-3 text-xs rounded-xl border-slate-200 gap-1"
          >
            <Plus className="h-3 w-3" /> Add Manual
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {dscList.length === 0 && (
        <div className={`rounded-xl border-2 border-dashed py-8 flex flex-col items-center gap-2 ${isDark ? "border-slate-600 text-slate-500" : "border-slate-200 text-slate-400"}`}>
          <Shield className="h-8 w-8 opacity-30" />
          <p className="text-sm font-medium">No DSC certificates linked</p>
          <p className="text-xs">Link from the DSC Register or add a manual entry</p>
        </div>
      )}

      {/* DSC Cards */}
      <div className="space-y-3">
        {dscList.map((dsc, idx) => {
          const isLinked  = !!dsc._linked;
          const isExpanded = expanded[idx] ?? false;

          return (
            <div
              key={idx}
              className={`border rounded-xl overflow-hidden transition-all shadow-sm ${
                isLinked
                  ? isDark ? "bg-blue-950/20 border-blue-900/50" : "bg-blue-50/50 border-blue-200"
                  : isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"
              }`}
              style={{
                borderColor: isLinked
                  ? (isDark ? 'rgba(59, 130, 246, 0.3)' : '#bfdbfe')
                  : (isDark ? '#334155' : '#e2e8f0'),
              }}
            >
              {/* Card header row */}
              <div className="flex items-center gap-3 px-4 py-3">
                {/* Index bubble */}
                <div className={`w-6 h-6 rounded-lg text-[10px] font-bold flex items-center justify-center flex-shrink-0 ${isLinked ? "bg-blue-100 text-blue-700" : isDark ? "bg-slate-700 text-slate-400" : "bg-slate-100 text-slate-500"}`}>
                  {idx + 1}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-semibold text-sm truncate ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                      {dsc.holder_name || <span className="italic text-slate-400 font-normal">Unnamed certificate</span>}
                    </span>
                    {isLinked && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 uppercase tracking-wider">
                        <Link2 className="h-2.5 w-2.5" /> Register
                      </span>
                    )}
                    {dsc.dsc_type && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isDark ? "bg-slate-700 text-slate-300" : "bg-slate-100 text-slate-500"}`}>{dsc.dsc_type}</span>
                    )}
                    <ExpiryBadge dateStr={dsc.expiry_date} />
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-400 flex-wrap">
                    {dsc.certificate_number && <span>No: {dsc.certificate_number}</span>}
                    {dsc.expiry_date && <span>Exp: {fmt(dsc.expiry_date)}</span>}
                    {isLinked && dsc.associated_with && <span>· {dsc.associated_with}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleExpand(idx)}
                    className={`w-7 h-7 flex items-center justify-center rounded-lg transition ${isDark ? "text-slate-400 hover:bg-slate-700" : "text-slate-400 hover:bg-slate-100"}`}
                    title={isExpanded ? "Collapse" : "Expand / Edit"}
                  >
                    {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => isLinked ? handleUnlink(idx) : removeDSC(idx)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition"
                    title={isLinked ? "Unlink from this client" : "Remove"}
                  >
                    {isLinked ? <Unlink2 className="h-3.5 w-3.5" /> : <Trash className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {/* Expandable edit fields */}
              {isExpanded && (
                <div className={`px-4 pb-4 pt-1 border-t ${isDark ? "border-slate-700" : "border-slate-100"}`}>
                  {isLinked && (
                    <p className={`text-[11px] mb-3 flex items-center gap-1 ${isDark ? "text-blue-300" : "text-blue-600"}`}>
                      <Link2 className="h-3 w-3" />
                      Linked from DSC Register — edits here only affect this client record, not the register entry.
                    </p>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Certificate / Serial No.</label>
                      <Input value={dsc.certificate_number || ""} onChange={e => updateDSC(idx, "certificate_number", e.target.value)} className={fieldCls(false)} />
                    </div>
                    <div>
                      <label className={labelCls}>Holder Name</label>
                      <Input value={dsc.holder_name || ""} onChange={e => updateDSC(idx, "holder_name", e.target.value)} className={fieldCls(false)} />
                    </div>
                    <div>
                      <label className={labelCls}>Issue Date</label>
                      <Input type="date" value={dsc.issue_date || ""} onChange={e => updateDSC(idx, "issue_date", e.target.value)} className={fieldCls(false)} />
                    </div>
                    <div>
                      <label className={labelCls}>Expiry Date</label>
                      <Input type="date" value={dsc.expiry_date || ""} onChange={e => updateDSC(idx, "expiry_date", e.target.value)} className={fieldCls(false)} />
                    </div>
                    <div className="md:col-span-2">
                      <label className={labelCls}>Notes</label>
                      <Textarea
                        value={dsc.notes || ""}
                        onChange={e => updateDSC(idx, "notes", e.target.value)}
                        className={`min-h-[70px] rounded-xl text-sm resize-y ${isDark ? "bg-slate-700 border-slate-600 text-slate-100" : "bg-white border-slate-200"}`}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Picker modal */}
      <DSCPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        dscRegister={dscRegister}
        loadingReg={loadingReg}
        companyName={companyName}
        onLink={handleLink}
        alreadyLinkedIds={alreadyLinkedIds}
        isDark={isDark}
      />
    </div>
  );
}
