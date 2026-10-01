/**
 * TrademarkSphere.jsx — v3 (Dashboard-aligned design + persistent branding)
 *
 * Changes vs v2:
 *  1. Design aligned with Dashboard metric cards (Tailwind classes, same card style)
 *  2. BrandingPanel: "Save as Default" persists company to localStorage + backend user prefs
 *  3. On load: auto-fill branding from saved default company
 *  4. Re-brand old reports: history items now have a "Re-brand PDF" button that
 *     calls /api/trademark-qc/searches/{id}/pdf with branding query params
 *  5. PDF generation passes branding (logo, footer, tagline, watermark) to backend
 *  6. Minor layout alignment with Dashboard: page header matches DashboardLayout style
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useDark } from "@/hooks/useDark";
import api from "@/lib/api";
import { normalizeCompanies } from "@/lib/companies";
import {
  generateReport, listHistory, getReport, bulkReports, bulkExport,
  findClasses, pdfDownloadUrl, deleteReport,
} from "@/lib/trademark-qc-api";

// Inlined helper — not exported by older versions of trademark-qc-api.js
const shareLinkFor = (reportId) =>
  `${window.location.origin}/trademark-sphere?report=${reportId}`;

import {
  Shield, Search, Upload, X, ChevronDown, ChevronRight,
  FileText, AlertTriangle, CheckCircle2, Clock, Building2,
  Download, Link2, Layers, Compass, BarChart3, Users,
  Sparkles, RefreshCw, Eye, ArrowUpRight, Copy, Check,
  ImageIcon, Type, Stamp, Tag, Hash, Zap, TrendingUp,
  Info, Filter, SlidersHorizontal, Plus, Trash2, Star,
  BookmarkCheck, Paintbrush, RotateCcw, Code,
} from "lucide-react";
import ApiDeveloperPanel from "@/components/trademark/ApiDeveloperPanel.jsx";

// ─── Design tokens (mirrors Dashboard COLORS exactly) ─────────────────────────
const COLORS = {
  deepBlue:     "#0D3B66",
  mediumBlue:   "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  lightGreen:   "#5CCB5F",
  coral:        "#FF6B6B",
  amber:        "#F59E0B",
  violet:       "#8B5CF6",
  blueLight:    "#3B82F6",
};

// Dynamic token getter (matches dashboard dark/light tokens)
function useTokens(isDark) {
  return {
    bg:      isDark ? "#0f172a" : "#F4F6FA",
    card:    isDark ? "#1e293b" : "#ffffff",
    raised:  isDark ? "#263348" : "#f1f5f9",
    border:  isDark ? "#334155" : "#e2e8f0",
    text:    isDark ? "#f1f5f9" : "#0f172a",
    muted:   isDark ? "#94a3b8" : "#475569",
    dimmer:  isDark ? "#64748b" : "#94a3b8",
    blue:    COLORS.mediumBlue,
    blueL:   COLORS.blueLight,
    emerald: COLORS.emeraldGreen,
    amber:   COLORS.amber,
    red:     isDark ? "#EF4444" : "#DC2626",
    violet:  COLORS.violet,
  };
}

const VERDICT_CFG = {
  AVAILABLE: { color: COLORS.emeraldGreen, bg: "rgba(31,175,90,0.12)",  border: "rgba(31,175,90,0.3)",  label: "Available",  dot: "#4ade80" },
  CAUTION:   { color: COLORS.amber,        bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)", label: "Caution",    dot: "#fbbf24" },
  CONFLICT:  { color: "#DC2626",           bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.3)",  label: "Conflict",   dot: "#f87171" },
};

const STATUS_COLOR = (T) => ({
  Registered: T.red, Accepted: T.red, Advertised: T.red,
  Opposed: T.amber, Objected: T.amber, "Under Examination": T.amber,
  Pending: T.amber, Abandoned: T.dimmer, Refused: T.dimmer,
  Withdrawn: T.dimmer, Removed: T.dimmer, Unknown: T.dimmer,
});

const BRANDING_STORAGE_KEY = "tm_sphere_branding_v1";

const DEFAULT_BRANDING = { logo: null, logoName: null, footer: "", tagline: "", watermark: "", customWatermark: "", defaultCompanyId: null, defaultCompanyName: null };

function loadSavedBranding() {
  try {
    const raw = localStorage.getItem(BRANDING_STORAGE_KEY);
    if (raw) return { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_BRANDING;
}

function saveBrandingToStorage(branding) {
  try { localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(branding)); } catch {}
}

// Builds PDF URL with branding params encoded (GET, no logo)
function brandedPdfUrl(reportId, branding) {
  const base = api.defaults.baseURL || "";
  const params = new URLSearchParams();
  if (branding?.footer)  params.set("footer",   branding.footer);
  if (branding?.tagline) params.set("tagline",  branding.tagline);
  const wm = branding?.watermark === "CUSTOM" ? branding.customWatermark : branding?.watermark;
  if (wm)                params.set("watermark", wm);
  const qs = params.toString();
  return `${base}/trademark-qc/searches/${reportId}/pdf${qs ? `?${qs}` : ""}`;
}

// POST-based PDF download — required when a logo needs to be sent (too large for query params)
async function downloadBrandedPdfWithLogo(reportId, branding, clientInfo = {}, brandName = "") {
  const wm = branding?.watermark === "CUSTOM" ? branding.customWatermark : branding?.watermark;
  const body = {
    logo_data_url:    branding?.logo || null,
    footer:           branding?.footer || "",
    tagline:          branding?.tagline || "Trademark Availability Report",
    watermark:        wm || "",
    custom_watermark: branding?.customWatermark || "",
    client_name:      clientInfo.client_name   || "",
    client_mobile:    clientInfo.client_mobile || "",
    report_date:      clientInfo.report_date   || "",
    prepared_by:      clientInfo.prepared_by   || "",
  };
  // Use the axios instance so the JWT Authorization header is sent automatically
  const res = await api.post(
    `/trademark-qc/searches/${reportId}/pdf`,
    body,
    { responseType: "blob", timeout: 60000 }
  );
  const blob = res.data;
  const url  = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
  const a    = document.createElement("a");
  a.href = url;
  a.download = brandName
    ? `${brandName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}_trademark_report.pdf`
    : `trademark_report_${reportId.slice(0, 8)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

const fadeUp = {
  hidden:  { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: [0.23, 1, 0.32, 1] } },
};
const stagger = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const springCard = { type: "spring", stiffness: 280, damping: 22, mass: 0.85 };

// ─── Shared primitives ─────────────────────────────────────────────────────────
// Card — matches Dashboard metricCardCls pattern
const Card = ({ children, className = "", style = {}, onClick }) => {
  const isDark = useDark();
  const border = isDark ? "#334155" : "#e2e8f0";
  const bg     = isDark ? "#1e293b" : "#ffffff";
  return (
    <div
      onClick={onClick}
      style={{ background: bg, border: `1px solid ${border}`, borderRadius: 16, ...style }}
      className={`shadow-sm ${onClick ? "cursor-pointer" : ""} ${className}`}
    >
      {children}
    </div>
  );
};

// MetricCard — exact same visual structure as Dashboard
const MetricCard = ({ label, value, sub, color, icon: Icon, iconBg, onClick, children }) => {
  const isDark = useDark();
  const defaultBg   = isDark ? "bg-slate-800 border-slate-700 hover:border-slate-600" : "bg-white border-slate-200/80 hover:border-slate-300";
  return (
    <motion.div
      whileHover={{ y: -3, transition: springCard }}
      whileTap={{ scale: 0.985 }}
      onClick={onClick}
      className={`rounded-2xl shadow-sm hover:shadow-lg transition-all cursor-pointer group border ${defaultBg}`}
    >
      <div className="p-4 flex flex-col justify-between min-h-[110px]">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1 mr-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
            <p className="text-2xl font-bold mt-1 tracking-tight" style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>
              {value}
            </p>
            {sub && <p className={`text-[10px] mt-0.5 ${isDark ? "text-slate-500" : "text-slate-400"}`}>{sub}</p>}
          </div>
          {Icon && (
            <div className="p-2 rounded-xl group-hover:scale-110 transition-transform flex-shrink-0"
              style={{ backgroundColor: iconBg }}>
              <Icon className="h-4 w-4" style={{ color }} />
            </div>
          )}
        </div>
        {children}
      </div>
    </motion.div>
  );
};

const SectionHeader = ({ icon: Icon, color, label, sub, T }) => (
  <div className="flex items-center gap-3 mb-5">
    <div style={{ background: `${color}22`, borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Icon size={18} style={{ color }} />
    </div>
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: T.dimmer, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 13, color: T.muted, marginTop: 1 }}>{sub}</div>}
    </div>
  </div>
);

const Badge = ({ status, T }) => {
  const sc = STATUS_COLOR(T);
  const color = sc[status] || T.dimmer;
  return (
    <span style={{ background: `${color}22`, border: `1px solid ${color}44`, color, borderRadius: 99, padding: "2px 10px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
};

const MatchBadge = ({ type, T }) => {
  const cfg = { exact: [T.red, "Exact"], phonetic: [T.amber, "Phonetic"], contains: [T.blueL, "Contains"], similar: [T.violet, "Similar"], weak: [T.dimmer, "Weak"] };
  const [color, label] = cfg[type] || [T.dimmer, type];
  return <span style={{ background: `${color}22`, color, border: `1px solid ${color}44`, borderRadius: 99, padding: "1px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>;
};

const Pill = ({ label, active, onClick, T }) => (
  <button onClick={onClick} style={{
    background: active ? T.blueL : T.raised, color: active ? "#fff" : T.muted,
    border: `1px solid ${active ? T.blueL : T.border}`, borderRadius: 99,
    padding: "4px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
  }}>{label}</button>
);

const Input = ({ T, style = {}, ...props }) => (
  <input style={{
    background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10,
    color: T.text, padding: "10px 14px", fontSize: 14, outline: "none",
    width: "100%", fontFamily: "inherit", transition: "border-color 0.15s", ...style,
  }} {...props} />
);

const Textarea = ({ T, style = {}, ...props }) => (
  <textarea style={{
    background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10,
    color: T.text, padding: "10px 14px", fontSize: 14, outline: "none",
    width: "100%", fontFamily: "inherit", resize: "vertical", ...style,
  }} {...props} />
);

const Btn = ({ children, variant = "primary", onClick, disabled, style = {}, T, ...props }) => {
  const base = { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", border: "none", transition: "all 0.15s", opacity: disabled ? 0.5 : 1, fontFamily: "inherit", ...style };
  const v = {
    primary: { background: COLORS.mediumBlue, color: "#fff" },
    ghost:   { background: T?.raised || "#f1f5f9", color: T?.muted || "#475569", border: `1px solid ${T?.border || "#e2e8f0"}` },
    danger:  { background: "rgba(239,68,68,0.15)", color: "#DC2626", border: "1px solid rgba(239,68,68,0.3)" },
    success: { background: "rgba(31,175,90,0.15)", color: COLORS.emeraldGreen, border: `1px solid rgba(31,175,90,0.3)` },
    save:    { background: `${COLORS.emeraldGreen}18`, color: COLORS.emeraldGreen, border: `1px solid ${COLORS.emeraldGreen}44` },
  };
  return <button style={{ ...base, ...(v[variant] || v.primary) }} onClick={onClick} disabled={disabled} {...props}>{children}</button>;
};

const VerdictBadge = ({ status, large }) => {
  const cfg = VERDICT_CFG[status] || VERDICT_CFG.CAUTION;
  return (
    <span style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color, borderRadius: 99, padding: large ? "6px 18px" : "3px 12px", fontSize: large ? 13 : 11, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.dot, display: "inline-block" }} />
      {cfg.label}
    </span>
  );
};

function Collapsible({ title, icon: Icon, iconColor, badge, defaultOpen = false, children, T }) {
  const [open, setOpen] = useState(defaultOpen);
  const color = iconColor || T.blueL;
  return (
    <Card style={{ overflow: "hidden" }}>
      <button onClick={() => setOpen(v => !v)} style={{ width: "100%", background: "none", border: "none", padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", color: T.text }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ background: `${color}22`, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon size={16} style={{ color }} />
          </div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{title}</div>
            {badge && <div style={{ fontSize: 11, color: T.dimmer, marginTop: 2 }}>{badge}</div>}
          </div>
        </div>
        <ChevronDown size={16} style={{ color: T.dimmer, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} style={{ overflow: "hidden" }}>
            <div style={{ borderTop: `1px solid ${T.border}`, padding: "20px" }}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

const Skeleton = ({ h = 20, w = "100%", r = 8, mb = 0, T }) => (
  <div style={{ height: h, width: w, borderRadius: r, background: `linear-gradient(90deg, ${T.raised} 25%, ${T.border} 50%, ${T.raised} 75%)`, backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite", marginBottom: mb }} />
);

// ─── Report Branding Panel — v3 with Save as Default ─────────────────────────
function BrandingPanel({ branding, onChange, companies, T, preparedBy, onPreparedByChange, trademarkUsers }) {
  const fileRef = useRef();
  const [selectedCompanyId, setSelectedCompanyId] = useState(branding.defaultCompanyId || "");
  const [saving, setSaving] = useState(false);

  // Sync dropdown to branding.defaultCompanyId when it changes externally
  useEffect(() => {
    if (branding.defaultCompanyId) setSelectedCompanyId(branding.defaultCompanyId);
  }, [branding.defaultCompanyId]);

  const handleLogo = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 500_000) return toast.error("Logo must be under 500 KB");
    const reader = new FileReader();
    reader.onload = () => onChange({ ...branding, logo: reader.result, logoName: f.name });
    reader.readAsDataURL(f);
  };

  const handleCompanySelect = (e) => {
    const id = e.target.value;
    setSelectedCompanyId(id);
    if (!id) { onChange({ ...branding, logo: null, logoName: null, footer: "", tagline: "", defaultCompanyId: null, defaultCompanyName: null }); return; }
    const co = companies.find(c => String(c.id) === id);
    if (!co) return;
    onChange({
      ...branding,
      logo: co.tm_logo_base64 || co.logo_base64 || branding.logo,
      logoName: (co.tm_logo_base64 || co.logo_base64) ? co.name : branding.logoName,
      footer: `Prepared by ${co.name}${co.gstin ? ` · GSTIN: ${co.gstin}` : ""}`,
      tagline: branding.tagline || "Trademark Availability Report",
      defaultCompanyId: null, // not yet saved as default
      defaultCompanyName: null,
    });
  };

  const handleSaveAsDefault = async () => {
    if (!selectedCompanyId) return toast.error("Select a company first");
    setSaving(true);
    try {
      const co = companies.find(c => String(c.id) === selectedCompanyId);
      const updated = { ...branding, defaultCompanyId: selectedCompanyId, defaultCompanyName: co?.name || "" };
      onChange(updated);
      saveBrandingToStorage(updated);
      // Also persist to backend for cross-device sync
      await api.post("/trademark-qc/branding-preference", {
        default_company_id:   selectedCompanyId,
        default_company_name: co?.name || "",
        footer:   branding.footer,
        tagline:  branding.tagline,
        watermark: branding.watermark,
      }).catch(() => {}); // graceful if endpoint not yet wired
      toast.success(`"${co?.name}" saved as default reporting company`);
    } finally { setSaving(false); }
  };

  const handleClearDefault = () => {
    const updated = { ...branding, defaultCompanyId: null, defaultCompanyName: null };
    onChange(updated);
    saveBrandingToStorage(updated);
    toast("Default company cleared");
  };

  const WATERMARKS = ["", "CONFIDENTIAL", "DRAFT", "FOR REVIEW", "PRIVILEGED", "CUSTOM"];
  const isDefault = !!branding.defaultCompanyId && branding.defaultCompanyId === selectedCompanyId;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>

      {/* Company selector — full width */}
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Report Under Company
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <Building2 size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.dimmer, pointerEvents: "none" }} />
            <select value={selectedCompanyId} onChange={handleCompanySelect}
              style={{ background: T.raised, border: `1px solid ${isDefault ? COLORS.emeraldGreen : T.border}`, borderRadius: 10, color: selectedCompanyId ? T.text : T.dimmer, padding: "10px 14px 10px 34px", fontSize: 13, width: "100%", outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
              <option value="">Select company (optional)</option>
              {companies.map(co => (
                <option key={co.id} value={String(co.id)}>
                  {co.name}{co.gstin ? ` — ${co.gstin}` : ""}{String(co.id) === branding.defaultCompanyId ? " ★ Default" : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={14} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: T.dimmer, pointerEvents: "none" }} />
          </div>

          {/* Save as Default button */}
          {selectedCompanyId && !isDefault && (
            <Btn variant="save" T={T} onClick={handleSaveAsDefault} disabled={saving} style={{ whiteSpace: "nowrap", padding: "9px 14px", fontSize: 12 }}>
              <BookmarkCheck size={13} /> {saving ? "Saving…" : "Set Default"}
            </Btn>
          )}
          {isDefault && (
            <Btn variant="ghost" T={T} onClick={handleClearDefault} style={{ whiteSpace: "nowrap", padding: "9px 14px", fontSize: 12 }}>
              <X size={13} /> Clear Default
            </Btn>
          )}
        </div>

        {/* Company info chip */}
        {selectedCompanyId && (() => {
          const co = companies.find(c => String(c.id) === selectedCompanyId);
          const logoSrc = co?.tm_logo_base64 || co?.logo_base64;
          return co ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "8px 12px", background: isDefault ? `${COLORS.emeraldGreen}14` : `${COLORS.mediumBlue}14`, border: `1px solid ${isDefault ? COLORS.emeraldGreen : COLORS.mediumBlue}33`, borderRadius: 8 }}>
              {logoSrc
                ? <img src={logoSrc} alt="logo" style={{ height: 22, maxWidth: 80, objectFit: "contain", borderRadius: 4, background: "#fff", padding: 2 }} />
                : <Building2 size={14} style={{ color: T.blueL }} />}
              <span style={{ fontSize: 12, color: isDefault ? COLORS.emeraldGreen : T.blueL, fontWeight: 600 }}>{co.name}</span>
              {isDefault
                ? <span style={{ fontSize: 11, color: COLORS.emeraldGreen }}>★ Default company — auto-loads on next visit</span>
                : logoSrc
                  ? <span style={{ fontSize: 11, color: T.dimmer }}>· logo auto-filled</span>
                  : null}
            </div>
          ) : null;
        })()}
      </div>

      {/* Logo upload */}
      <div>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Company Logo (Header)</div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleLogo} />
        {branding.logo ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.raised, borderRadius: 10, padding: "10px 14px", border: `1px solid ${T.border}` }}>
            <img src={branding.logo} alt="logo" style={{ height: 36, width: 36, objectFit: "contain", borderRadius: 6, background: "#fff", padding: 3 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branding.logoName}</div>
              <div style={{ fontSize: 11, color: T.dimmer }}>Logo uploaded</div>
            </div>
            <button onClick={() => onChange({ ...branding, logo: null, logoName: null })} style={{ background: "none", border: "none", color: T.dimmer, cursor: "pointer", padding: 4 }}><X size={14} /></button>
          </div>
        ) : (
          <Btn variant="ghost" T={T} onClick={() => fileRef.current?.click()} style={{ width: "100%", justifyContent: "center" }}>
            <ImageIcon size={14} /> Upload Logo
          </Btn>
        )}
      </div>

      {/* Watermark */}
      <div>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Watermark</div>
        <select value={branding.watermark} onChange={e => onChange({ ...branding, watermark: e.target.value, customWatermark: e.target.value === "CUSTOM" ? branding.customWatermark : "" })}
          style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 13, width: "100%", outline: "none", fontFamily: "inherit" }}>
          {WATERMARKS.map(w => <option key={w} value={w}>{w || "No watermark"}</option>)}
        </select>
        {branding.watermark === "CUSTOM" && (
          <Input T={T} placeholder="Enter custom watermark text…" value={branding.customWatermark || ""} onChange={e => onChange({ ...branding, customWatermark: e.target.value })} style={{ marginTop: 8 }} />
        )}
      </div>

      {/* Prepared By */}
      <div>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Prepared By</div>
        <select
          value={preparedBy || ""}
          onChange={e => onPreparedByChange && onPreparedByChange(e.target.value)}
          style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: (preparedBy || "") ? T.text : T.dimmer, padding: "10px 14px", fontSize: 13, width: "100%", outline: "none", fontFamily: "inherit" }}
        >
          <option value="">Select person (optional)</option>
          {(trademarkUsers || []).map(u => (
            <option key={u.id} value={u.full_name}>{u.full_name}</option>
          ))}
        </select>
      </div>

      {/* Footer text */}
      <div style={{ gridColumn: "1 / 3" }}>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Footer Text</div>
        <Textarea T={T} rows={2} placeholder="e.g. Prepared by Shree Hanuma & Associates · Confidential · For client use only" value={branding.footer || ""} onChange={e => onChange({ ...branding, footer: e.target.value })} />
      </div>

      {/* Header tagline */}
      <div style={{ gridColumn: "3 / 4" }}>
        <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Header Tagline (below logo)</div>
        <Input T={T} placeholder="e.g. Trademark Availability Report" value={branding.tagline || ""} onChange={e => onChange({ ...branding, tagline: e.target.value })} />
      </div>

      {/* Save branding settings note */}
      {(branding.footer || branding.tagline || branding.watermark) && !branding.defaultCompanyId && (
        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", background: `${COLORS.amber}12`, border: `1px solid ${COLORS.amber}33`, borderRadius: 8 }}>
          <Info size={13} style={{ color: COLORS.amber, marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: T.muted }}>Select a company and click <strong style={{ color: T.text }}>Set Default</strong> to auto-load these branding settings on future visits.</span>
        </div>
      )}
    </div>
  );
}

// ─── Client selector ──────────────────────────────────────────────────────────
function ClientSelector({ value, onChange, T }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("search"); // "search" | "add-perm" | "add-temp"
  const [addForm, setAddForm] = useState({ company_name: "", phone: "", gstin: "" });
  const [addLoading, setAddLoading] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setMode("search");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = useCallback(async (query) => {
    setLoading(true);
    try { const { data } = await api.get("/clients/search", { params: { q: query, limit: 20 } }); setResults(data); }
    catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open && mode === "search") search(q); }, [q, open, mode, search]);

  const handleAddPermanent = async () => {
    if (!addForm.company_name.trim()) return toast.error("Client name is required");
    setAddLoading(true);
    try {
      const { data } = await api.post("/clients", {
        company_name: addForm.company_name.trim(),
        phone: addForm.phone.trim(),
        gstin: addForm.gstin.trim(),
      });
      onChange(data);
      setOpen(false);
      setMode("search");
      setAddForm({ company_name: "", phone: "", gstin: "" });
      toast.success(`Client "${data.company_name}" added and selected`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add client");
    } finally { setAddLoading(false); }
  };

  const handleAddTemp = () => {
    if (!addForm.company_name.trim()) return toast.error("Client name is required");
    onChange({
      id: `temp_${Date.now()}`,
      company_name: addForm.company_name.trim(),
      phone: addForm.phone.trim(),
      is_temporary: true,
    });
    setOpen(false);
    setMode("search");
    setAddForm({ company_name: "", phone: "", gstin: "" });
    toast.success("Temporary client set — won't be saved to client list");
  };

  const inlineForm = (isTmp) => (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        {isTmp
          ? <><Clock size={12} style={{ color: COLORS.amber }} /> Temporary Client</>
          : <><Plus size={12} style={{ color: COLORS.emeraldGreen }} /> Add New Client</>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          value={addForm.company_name}
          onChange={e => setAddForm(f => ({ ...f, company_name: e.target.value }))}
          placeholder="Client / company name *"
          autoFocus
          style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: T.text, outline: "none", fontFamily: "inherit", width: "100%" }}
        />
        <input
          value={addForm.phone}
          onChange={e => setAddForm(f => ({ ...f, phone: e.target.value }))}
          placeholder="Mobile number"
          style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: T.text, outline: "none", fontFamily: "inherit", width: "100%" }}
        />
        {!isTmp && (
          <input
            value={addForm.gstin}
            onChange={e => setAddForm(f => ({ ...f, gstin: e.target.value }))}
            placeholder="GSTIN (optional)"
            style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: T.text, outline: "none", fontFamily: "inherit", width: "100%" }}
          />
        )}
        {isTmp && (
          <p style={{ fontSize: 11, color: T.dimmer, margin: 0, lineHeight: 1.5 }}>
            Appears on this PDF only — not saved to your client list.
          </p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <Btn T={T} variant={isTmp ? "ghost" : "primary"} onClick={isTmp ? handleAddTemp : handleAddPermanent} disabled={addLoading}
            style={{ flex: 1, justifyContent: "center", padding: "7px 12px", fontSize: 12, border: isTmp ? `1px solid ${COLORS.amber}` : undefined, color: isTmp ? COLORS.amber : undefined, background: isTmp ? `${COLORS.amber}12` : undefined }}>
            {addLoading ? "Saving…" : isTmp ? "Use for This Report" : "Save & Select"}
          </Btn>
          <Btn T={T} variant="ghost" onClick={() => { setMode("search"); setAddForm({ company_name: "", phone: "", gstin: "" }); }}
            style={{ padding: "7px 12px", fontSize: 12 }}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Search Under Client</div>
      <button onClick={() => setOpen(v => !v)} style={{ width: "100%", background: T.raised, border: `1px solid ${value ? COLORS.blueLight : T.border}`, borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", color: value ? T.text : T.dimmer, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Building2 size={14} style={{ color: value ? COLORS.blueLight : T.dimmer }} />
          {value
            ? <>
                <span>{value.company_name}</span>
                {value.is_temporary && (
                  <span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700, background: `${COLORS.amber}18`, border: `1px solid ${COLORS.amber}44`, borderRadius: 4, padding: "1px 6px" }}>TEMP</span>
                )}
              </>
            : "Select a client (optional)"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {value && <button onClick={e => { e.stopPropagation(); onChange(null); }} style={{ background: "none", border: "none", color: T.dimmer, cursor: "pointer", lineHeight: 1, padding: 0 }}><X size={12} /></button>}
          <ChevronDown size={14} style={{ color: T.dimmer, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.97 }} transition={{ duration: 0.15 }}
            style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, zIndex: 50, boxShadow: "0 16px 40px rgba(0,0,0,0.2)", overflow: "hidden" }}>

            {mode === "add-perm" ? inlineForm(false)
            : mode === "add-temp" ? inlineForm(true)
            : (
              <>
                <div style={{ padding: "10px 12px", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ position: "relative" }}>
                    <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.dimmer }} />
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search clients…" autoFocus
                      style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px 7px 30px", fontSize: 13, color: T.text, width: "100%", outline: "none", fontFamily: "inherit" }} />
                  </div>
                </div>
                <div style={{ maxHeight: 180, overflowY: "auto" }}>
                  {loading && <div style={{ padding: "14px 16px", color: T.dimmer, fontSize: 13 }}>Searching…</div>}
                  {!loading && results.length === 0 && <div style={{ padding: "14px 16px", color: T.dimmer, fontSize: 13 }}>No clients found</div>}
                  {results.map(c => (
                    <button key={c.id} onClick={() => { onChange(c); setOpen(false); setQ(""); }} style={{ width: "100%", background: "none", border: "none", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", borderBottom: `1px solid ${T.border}`, color: T.text, fontFamily: "inherit", textAlign: "left" }}>
                      <div style={{ width: 30, height: 30, borderRadius: 8, background: T.raised, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Building2 size={14} style={{ color: T.blueL }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{c.company_name}</div>
                        {c.gstin && <div style={{ fontSize: 11, color: T.dimmer }}>GSTIN: {c.gstin}</div>}
                      </div>
                    </button>
                  ))}
                </div>
                {/* Footer — Add New Client / Temp Client actions */}
                <div style={{ display: "flex", borderTop: `1px solid ${T.border}` }}>
                  <button
                    onClick={() => { setMode("add-perm"); setAddForm(f => ({ ...f, company_name: q })); }}
                    style={{ flex: 1, background: "none", border: "none", borderRight: `1px solid ${T.border}`, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: COLORS.emeraldGreen, cursor: "pointer", fontFamily: "inherit" }}>
                    <Plus size={13} /> Add New Client
                  </button>
                  <button
                    onClick={() => { setMode("add-temp"); setAddForm(f => ({ ...f, company_name: q })); }}
                    style={{ flex: 1, background: "none", border: "none", padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: COLORS.amber, cursor: "pointer", fontFamily: "inherit" }}>
                    <Clock size={13} /> Temp Client
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {value && (
        <div style={{ marginTop: 8, background: value.is_temporary ? `${COLORS.amber}12` : `${COLORS.mediumBlue}12`, border: `1px solid ${value.is_temporary ? COLORS.amber : COLORS.mediumBlue}33`, borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <Info size={12} style={{ color: value.is_temporary ? COLORS.amber : T.blueL, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: T.muted }}>
            {value.is_temporary ? "Temp client for this report:" : "Report filed under"}
            {" "}<strong style={{ color: T.text }}>{value.company_name}</strong>
            {value.is_temporary && value.phone && <span style={{ color: T.dimmer }}> · {value.phone}</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Main Search Bar ──────────────────────────────────────────────────────────
function SearchBar({ onSubmit, loading, defaultClass, client, T }) {
  const [name, setName]               = useState("");
  const [klass, setKlass]             = useState(defaultClass || "");
  const [multiClasses, setMultiClasses] = useState([]);    // array of class numbers for multi-class mode
  const [multiMode, setMultiMode]     = useState(false);
  const [deviceOnly, setDeviceOnly]   = useState(false);
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [logoName, setLogoName]       = useState(null);
  const [classDropOpen, setClassDropOpen] = useState(false);
  const fileRef = useRef();
  const dropRef = useRef();

  useEffect(() => { if (defaultClass !== undefined) setKlass(String(defaultClass || "")); }, [defaultClass]);
  useEffect(() => { if (client?.company_name && !name) setName(client.company_name); }, [client]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (dropRef.current && !dropRef.current.contains(e.target)) setClassDropOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return toast.error("Please upload an image file");
    if (!/^image\//.test(f.type)) return toast.error("Please upload an image file");
    if (f.size > 350_000) return toast.error("Logo must be under 350 KB");
    const reader = new FileReader();
    reader.onload = () => { setLogoDataUrl(reader.result); setLogoName(f.name); setDeviceOnly(true); };
    reader.readAsDataURL(f);
  };

  const toggleMultiClass = (num) => {
    setMultiClasses(prev => prev.includes(num) ? prev.filter(c => c !== num) : [...prev, num].sort((a,b) => a-b));
  };

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim() || loading) return;
    if (multiMode && multiClasses.length > 0) {
      // Single call with ALL selected classes — backend scrapes each class-specific URL
      // This is more efficient than N separate calls and guarantees consistent data
      onSubmit(name.trim(), {
        class_filter: multiClasses[0],       // primary class for verdict focus
        class_filters: multiClasses,         // all classes for comprehensive scraping
        device_only: deviceOnly,
        logo_data_url: logoDataUrl,
        _multiClass: true,
        _multiTotal: multiClasses.length,
      });
      toast.info(`Running report for "${name.trim()}" across ${multiClasses.length} classes…`);
    } else {
      onSubmit(name.trim(), { class_filter: klass ? Number(klass) : null, device_only: deviceOnly, logo_data_url: logoDataUrl });
    }
  };

  const allClasses = Array.from({ length: 45 }, (_, i) => i + 1);

  return (
    <Card style={{ padding: 24 }}>
      <form onSubmit={submit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, marginBottom: 14 }}>
          {/* Brand name input */}
          <div style={{ position: "relative" }}>
            <Search size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: T.dimmer }} />
            <input data-testid="search-input" type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder={client ? `Search "${client.company_name}"…` : "Enter brand name e.g. Zorbixsynth"}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, padding: "11px 14px 11px 40px", fontSize: 14, outline: "none", width: "100%", fontFamily: "inherit" }} />
          </div>

          {/* Class selector — single or multi */}
          {!multiMode ? (
            <select value={klass} onChange={e => setKlass(e.target.value)}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: klass ? T.text : T.dimmer, padding: "11px 14px", fontSize: 13, outline: "none", fontFamily: "inherit", minWidth: 160 }}>
              <option value="">All classes</option>
              {allClasses.map(c => <option key={c} value={c}>Class {c}</option>)}
            </select>
          ) : (
            /* Multi-class dropdown */
            <div ref={dropRef} style={{ position: "relative", minWidth: 220 }}>
              <button type="button" onClick={() => setClassDropOpen(o => !o)}
                style={{ background: T.raised, border: `1px solid ${multiClasses.length ? T.blueL : T.border}`, borderRadius: 10, color: multiClasses.length ? T.text : T.dimmer, padding: "11px 14px", fontSize: 13, outline: "none", fontFamily: "inherit", width: "100%", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {multiClasses.length === 0 ? "Pick classes…" : multiClasses.map(c => `CL${c}`).join(", ")}
                </span>
                <span style={{ fontSize: 10, background: multiClasses.length ? T.blueL : T.border, color: multiClasses.length ? "#fff" : T.muted, borderRadius: 99, padding: "1px 7px", flexShrink: 0 }}>
                  {multiClasses.length || "0"}
                </span>
              </button>
              {classDropOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", zIndex: 999, maxHeight: 320, overflowY: "auto", padding: 10 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <button type="button" onClick={() => setMultiClasses(allClasses)}
                      style={{ fontSize: 11, background: `${T.blueL}18`, border: `1px solid ${T.blueL}44`, color: T.blueL, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>All</button>
                    <button type="button" onClick={() => setMultiClasses([])}
                      style={{ fontSize: 11, background: T.raised, border: `1px solid ${T.border}`, color: T.muted, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                    {allClasses.map(c => {
                      const sel = multiClasses.includes(c);
                      return (
                        <button key={c} type="button" onClick={() => toggleMultiClass(c)}
                          style={{ background: sel ? T.blueL : T.raised, border: `1px solid ${sel ? T.blueL : T.border}`, color: sel ? "#fff" : T.muted, borderRadius: 7, padding: "5px 4px", fontSize: 11, fontWeight: sel ? 700 : 400, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", transition: "all 0.12s" }}>
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <Btn T={T} type="submit" disabled={loading || !name.trim() || (multiMode && multiClasses.length === 0)} style={{ padding: "11px 24px", fontSize: 14, whiteSpace: "nowrap" }}>
            {loading
              ? <><RefreshCw size={14} style={{ animation: "spin 1s linear infinite" }} /> Analysing…</>
              : multiMode && multiClasses.length > 0
                ? <><Layers size={14} /> Run {multiClasses.length} Class{multiClasses.length > 1 ? "es" : ""}</>
                : <><Zap size={14} /> Run Report</>
            }
          </Btn>
        </div>

        {/* Options row */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 16, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          {/* Multi-class toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={multiMode} onChange={e => { setMultiMode(e.target.checked); if (!e.target.checked) setMultiClasses([]); }}
              style={{ accentColor: T.blueL, width: 15, height: 15 }} />
            <span style={{ fontSize: 13, color: T.muted, fontWeight: multiMode ? 700 : 400 }}>Multi-class search</span>
            {multiMode && <span style={{ fontSize: 11, color: T.dimmer }}>(generates one report per class)</span>}
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={deviceOnly} onChange={e => setDeviceOnly(e.target.checked)} style={{ accentColor: T.blueL, width: 15, height: 15 }} />
            <span style={{ fontSize: 13, color: T.muted }}>Device / logo marks only</span>
          </label>

          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
          <Btn T={T} type="button" variant="ghost" onClick={() => fileRef.current?.click()} style={{ padding: "6px 14px" }}>
            <ImageIcon size={13} /> {logoDataUrl ? "Replace logo" : "Upload logo (optional)"}
          </Btn>
          {logoDataUrl && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src={logoDataUrl} alt="preview" style={{ height: 28, width: 28, objectFit: "contain", borderRadius: 6, background: T.raised, border: `1px solid ${T.border}`, padding: 3 }} />
              <span style={{ fontSize: 12, color: T.muted }}>{logoName}</span>
              <button type="button" onClick={() => { setLogoDataUrl(null); setLogoName(null); }} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", gap: 3 }}><X size={12} /> Remove</button>
            </div>
          )}

          {/* Multi-class pill summary */}
          {multiMode && multiClasses.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginLeft: "auto" }}>
              {multiClasses.map(c => (
                <span key={c} onClick={() => toggleMultiClass(c)} style={{ background: `${T.blueL}18`, color: T.blueL, border: `1px solid ${T.blueL}44`, borderRadius: 99, padding: "2px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }} title="Click to remove">
                  CL{c} ×
                </span>
              ))}
            </div>
          )}
        </div>
      </form>
    </Card>
  );
}

// ─── Verdict panel ────────────────────────────────────────────────────────────
function VerdictPanel({ report, T }) {
  const cfg = VERDICT_CFG[report.overall_status] || VERDICT_CFG.CAUTION;
  const pct = report.risk_score;
  const regProb = report.overall_status === "AVAILABLE"
    ? Math.min(95, 100 - pct + 10)
    : report.overall_status === "CONFLICT"
      ? Math.max(5, 100 - pct - 15)
      : Math.max(0, 100 - pct);
  const badgeCfg = { AVAILABLE: [COLORS.emeraldGreen, "Safe to File"], CAUTION: [COLORS.amber, "Review First"], CONFLICT: ["#DC2626", "High Risk"] };
  const [badgeClr, badgeLabel] = badgeCfg[report.overall_status] || [COLORS.amber, "Caution"];
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="visible">
      <div style={{ background: "linear-gradient(135deg, #0D3B66 0%, #1F6FB2 50%, #1e3a8a 100%)", borderRadius: 18, padding: "32px 36px", position: "relative", overflow: "hidden", border: "1px solid rgba(31,111,178,0.4)" }}>
        <div style={{ position: "absolute", top: -60, right: -40, width: 260, height: 260, borderRadius: "50%", background: "rgba(255,255,255,0.06)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: -40, left: "40%", width: 180, height: 180, borderRadius: "50%", background: "rgba(56,189,248,0.1)", pointerEvents: "none" }} />
        <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto", gap: 32, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(255,255,255,0.6)", fontWeight: 700, marginBottom: 12 }}>
              TRADEMARK AVAILABILITY REPORT {report.device_only ? "· DEVICE MARKS" : ""}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <VerdictBadge status={report.overall_status} large />
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>RISK SCORE — {pct}/100</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: badgeClr, background: `${badgeClr}28`, border: `1px solid ${badgeClr}55`, borderRadius: 99, padding: "3px 10px" }}>● {badgeLabel}</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#fff", lineHeight: 1.3, maxWidth: 520, marginBottom: 24 }}>{report.headline}</div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                <span>0 — Low risk</span><span>100 — High risk</span>
              </div>
              <div style={{ height: 8, background: "rgba(255,255,255,0.15)", borderRadius: 99, overflow: "hidden" }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 1, ease: [0.23, 1, 0.32, 1] }}
                  style={{ height: "100%", borderRadius: 99, background: cfg.dot }} />
              </div>
            </div>
          </div>
          <div style={{ textAlign: "center", background: "rgba(255,255,255,0.08)", backdropFilter: "blur(8px)", border: `2px solid ${cfg.dot}44`, borderRadius: 20, padding: "24px 32px" }}>
            <div style={{ fontSize: 56, fontWeight: 800, color: cfg.dot, lineHeight: 1, letterSpacing: "-2px", fontFamily: "'JetBrains Mono', monospace" }}>{pct}</div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(255,255,255,0.5)", marginTop: 6, fontWeight: 700 }}>Risk Score</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{report.summary_counts?.total_results ?? 0} filings</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 8, fontWeight: 700 }}>{regProb}% success probability</div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Stat grid — Dashboard metric card style ──────────────────────────────────
function StatGrid({ report, T }) {
  const c = report.summary_counts || {};
  const stats = [
    { label: "Total Matches", value: c.total_results ?? 0,             color: COLORS.blueLight,    iconBg: `${COLORS.blueLight}18` },
    { label: "Exact",         value: c.exact ?? 0,                     color: COLORS.coral,         iconBg: `${COLORS.coral}18` },
    { label: "Phonetic",      value: c.phonetic ?? 0,                  color: COLORS.amber,         iconBg: `${COLORS.amber}18` },
    { label: "Similar",       value: c.contains_or_similar ?? 0,       color: COLORS.violet,        iconBg: `${COLORS.violet}18` },
    { label: "Blocking",      value: c.blocking_exact_matches ?? 0,    color: COLORS.coral,         iconBg: `${COLORS.coral}18` },
  ];
  return (
    <motion.div variants={stagger} initial="hidden" animate="visible"
      style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
      {stats.map(s => (
        <motion.div key={s.label} variants={fadeUp}>
          <MetricCard label={s.label} value={s.value} color={s.color} iconBg={s.iconBg} />
        </motion.div>
      ))}
    </motion.div>
  );
}

// ─── Report actions — with Re-brand PDF ──────────────────────────────────────
function ReportActions({ reportId, branding, clientInfo = {}, brandName = "", T }) {
  const [copied, setCopied] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  if (!reportId) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(shareLinkFor(reportId)); setCopied(true); toast.success("Share link copied"); setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("Could not copy link"); }
  };
  // Always use authenticated api call — window.open / <a href> don't send JWT
  const handlePdfDownload = async () => {
    setPdfLoading(true);
    try {
      await downloadBrandedPdfWithLogo(reportId, branding, clientInfo, brandName);
    } catch (e) {
      toast.error("PDF generation failed. Please try again.");
    } finally {
      setPdfLoading(false);
    }
  };
  const hasBrandingOrClient = !!(branding?.footer || branding?.logo || branding?.tagline || clientInfo?.client_name);
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      {hasBrandingOrClient ? (
        <Btn T={T} variant="success" style={{ fontSize: 12 }} onClick={handlePdfDownload} disabled={pdfLoading}>
          <Download size={13} /> {pdfLoading ? "Generating…" : "Download PDF"}
        </Btn>
      ) : (
        <Btn T={T} variant="ghost" onClick={handlePdfDownload} disabled={pdfLoading}>
          <Download size={14} /> {pdfLoading ? "Generating…" : "Download PDF"}
        </Btn>
      )}
      <Btn T={T} variant="ghost" onClick={copy}>
        {copied ? <Check size={14} style={{ color: COLORS.emeraldGreen }} /> : <Link2 size={14} />}
        {copied ? "Copied!" : "Copy share link"}
      </Btn>
    </div>
  );
}

// ─── Recommendations ──────────────────────────────────────────────────────────
function RecommendationsPanel({ recommendations, T }) {
    const safeRecs = Array.isArray(recommendations) ? recommendations : [];
    return (
      <Card style={{ padding: "20px 22px", height: "100%" }}>
        <SectionHeader T={T} icon={Sparkles} color={COLORS.amber} label="Recommendations" sub="Legal guidance" />
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
          {safeRecs.map((r, i) => (
            <li key={i} style={{ display: "flex", gap: 10, paddingBottom: 12, borderBottom: i < safeRecs.length - 1 ? `1px solid ${T.border}` : "none" }}>
              <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", background: `${COLORS.mediumBlue}20`, color: COLORS.mediumBlue, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
              <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.6 }}>{r}</p>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  function AlternativesPanel({ alternatives, T }) {
    const safeAlts = Array.isArray(alternatives) ? alternatives : [];
    return (
      <Card style={{ padding: "20px 22px", height: "100%" }}>
        <SectionHeader T={T} icon={Tag} color={COLORS.violet} label="Alternative Names" sub="Suggested variations" />
        {safeAlts.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {safeAlts.map((a, i) => (
              <span key={i} style={{ background: `${COLORS.violet}18`, border: `1px solid ${COLORS.violet}33`, color: COLORS.violet, borderRadius: 8, padding: "5px 12px", fontSize: 13, fontWeight: 600 }}>{a}</span>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: T.muted }}>Your mark looks largely clear — no alternatives required.</p>
        )}
      </Card>
    );
  }

// ─── Class breakdown ──────────────────────────────────────────────────────────
function ClassBreakdown({ rows, T }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return null;
  const maxTotal = Math.max(...safeRows.map(r => r.total || 0), 1);
  return (
    <Card style={{ padding: "20px 22px" }}>
      <SectionHeader T={T} icon={BarChart3} color={COLORS.violet} label="Class Breakdown" sub={`Filings across ${safeRows.length} class${safeRows.length === 1 ? "" : "es"}`} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", minWidth: 700 }}>
          <colgroup>
            <col style={{ width: 80 }} />
            <col style={{ width: "auto" }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 220 }} />
          </colgroup>
          <thead>
            <tr style={{ background: T.raised }}>
              {["Class", "Sector", "Total", "Blocking", "Dead", "Conflict bar"].map((h, i) => (
                <th key={i} style={{ padding: "9px 14px", textAlign: i >= 2 ? "center" : "left", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: T.dimmer, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {safeRows.map((r, i) => {
              const cls = r.class ?? r.class_number ?? "?";
              const blocking = r.blocking ?? r.blocking_count ?? 0;
              const dead = r.dead ?? r.dead_count ?? 0;
              const total = r.total ?? 0;
              const hint = r.hint || CLASS_HINTS[cls] || "—";
              const blockingPct = total > 0 ? (blocking / total) * 100 : 0;
              const safePct = total > 0 ? (total / maxTotal) * 100 : 0;
              return (
                <tr key={i} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "transparent" : `${T.raised}88` }}>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{ background: `${COLORS.mediumBlue}18`, color: COLORS.mediumBlue, border: `1px solid ${COLORS.mediumBlue}33`, borderRadius: 7, padding: "3px 10px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", fontFamily: "'JetBrains Mono', monospace" }}>
                      CL{String(cls).padStart(2, "0")}
                    </span>
                  </td>
                  <td style={{ padding: "10px 14px", color: T.muted, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hint}>{hint}</td>
                  <td style={{ padding: "10px 14px", textAlign: "center", fontWeight: 700, color: T.text, fontFamily: "'JetBrains Mono', monospace" }}>{total}</td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    {blocking > 0
                      ? <span style={{ fontWeight: 800, color: T.red, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{blocking}</span>
                      : <span style={{ color: T.dimmer, fontSize: 13 }}>0</span>
                    }
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center", color: T.dimmer, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{dead}</td>
                  <td style={{ padding: "10px 20px 10px 14px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {/* total bar */}
                      <div style={{ height: 6, background: T.border, borderRadius: 99, overflow: "hidden" }}>
                        <div style={{ width: `${safePct}%`, height: "100%", background: COLORS.mediumBlue, borderRadius: 99, transition: "width 0.6s ease" }} />
                      </div>
                      {/* blocking bar */}
                      <div style={{ height: 4, background: T.border, borderRadius: 99, overflow: "hidden" }}>
                        <div style={{ width: `${blockingPct}%`, height: "100%", background: blocking > 0 ? T.red : T.emerald, borderRadius: 99, transition: "width 0.6s ease" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 9, color: T.dimmer }}>total</span>
                        <span style={{ fontSize: 9, color: blocking > 0 ? T.red : T.dimmer }}>{blocking > 0 ? `${Math.round(blockingPct)}% blocking` : "no blockers"}</span>
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const CLASS_HINTS = {
  1: "Chemicals", 2: "Paints", 3: "Cosmetics & cleaning", 4: "Oils & fuels",
  5: "Pharmaceuticals", 6: "Metals", 7: "Machinery", 8: "Hand tools",
  9: "Electronics, computers, software", 10: "Medical devices",
  11: "Lighting & heating", 12: "Vehicles", 13: "Firearms", 14: "Jewellery",
  15: "Musical instruments", 16: "Paper & stationery", 17: "Rubber & plastics",
  18: "Leather goods", 19: "Building materials", 20: "Furniture",
  21: "Household utensils", 22: "Ropes & fibres", 23: "Yarns & threads",
  24: "Textiles & fabrics", 25: "Clothing, footwear, apparel",
  26: "Lace & buttons", 27: "Carpets", 28: "Games & toys",
  29: "Meat & preserved foods", 30: "Coffee, tea & spices",
  31: "Agricultural products", 32: "Beverages", 33: "Alcoholic beverages",
  34: "Tobacco", 35: "Advertising, business, retail services",
  36: "Finance & insurance", 37: "Construction & repair",
  38: "Telecommunications", 39: "Transport & travel",
  40: "Treatment of materials", 41: "Education, training, entertainment",
  42: "Scientific, technological, software services", 43: "Restaurants, hospitality",
  44: "Medical, healthcare", 45: "Legal services",
};

// ─── Matches table ────────────────────────────────────────────────────────────
function MatchesTable({ rows, T }) {
  const [matchFilter, setMatchFilter]   = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [searchQ, setSearchQ]           = useState("");
  const [page, setPage]                 = useState(1);
  const PAGE_SIZE = 50;

  const safeRows = Array.isArray(rows) ? rows : [];
  const statusOptions = ["ALL", ...Array.from(new Set(safeRows.map(r => r.status).filter(Boolean)))];
  const filtered = safeRows.filter(r => {
    if (matchFilter !== "ALL" && r.match_type !== matchFilter.toLowerCase()) return false;
    if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
    if (searchQ && !r.name?.toLowerCase().includes(searchQ.toLowerCase()) && !r.applicant?.toLowerCase().includes(searchQ.toLowerCase())) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset to page 1 when filters change
  const setFilter = (setter) => (val) => { setter(val); setPage(1); };

  if (!safeRows.length) return null;

  const COL_WIDTHS = { id: 110, name: 180, applicant: 180, status: 130, logo: 52, cls: 56, match: 90, risk: 60, filed: 100, view: 50 };

  return (
    <Card style={{ overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "18px 22px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <SectionHeader T={T} icon={Search} color={T.blueL} label="All Recorded Matches" sub={`${filtered.length} of ${safeRows.length} filings`} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ position: "relative" }}>
            <Search size={12} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.dimmer }} />
            <input value={searchQ} onChange={e => { setSearchQ(e.target.value); setPage(1); }}
              placeholder="Filter by name / applicant…"
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px 6px 28px", fontSize: 12, color: T.text, outline: "none", width: 200, fontFamily: "inherit" }} />
          </div>
          <select value={matchFilter} onChange={e => setFilter(setMatchFilter)(e.target.value)}
            style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, color: T.muted, padding: "6px 10px", fontSize: 12, outline: "none", fontFamily: "inherit" }}>
            {["ALL", "EXACT", "PHONETIC", "CONTAINS", "SIMILAR", "WEAK"].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setFilter(setStatusFilter)(e.target.value)}
            style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 8, color: T.muted, padding: "6px 10px", fontSize: 12, outline: "none", fontFamily: "inherit" }}>
            {statusOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>

      {/* Scrollable table */}
      <div style={{ overflowX: "auto", width: "100%" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", minWidth: 980 }}>
          <colgroup>
            <col style={{ width: COL_WIDTHS.id }} />
            <col style={{ width: COL_WIDTHS.name }} />
            <col style={{ width: COL_WIDTHS.applicant }} />
            <col style={{ width: COL_WIDTHS.status }} />
            <col style={{ width: COL_WIDTHS.logo }} />
            <col style={{ width: COL_WIDTHS.cls }} />
            <col style={{ width: COL_WIDTHS.match }} />
            <col style={{ width: COL_WIDTHS.risk }} />
            <col style={{ width: COL_WIDTHS.filed }} />
            <col style={{ width: COL_WIDTHS.view }} />
          </colgroup>
          <thead>
            <tr style={{ background: T.raised, position: "sticky", top: 0, zIndex: 1 }}>
              {["ID", "Name", "Applicant", "Status", "Logo", "CL", "Match", "Risk", "Filed", ""].map((h, i) => (
                <th key={i} style={{ padding: "10px 12px", textAlign: h === "Risk" ? "right" : "left", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: T.dimmer, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan={10} style={{ padding: "32px", textAlign: "center", color: T.dimmer, fontSize: 13 }}>No matches under current filters.</td></tr>
            )}
            {pageRows.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "transparent" : `${T.raised}88` }}>
                <td style={{ padding: "9px 12px", color: T.dimmer, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.application_id || "—"}>{r.application_id || "—"}</td>
                <td style={{ padding: "9px 12px", fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</td>
                <td style={{ padding: "9px 12px", color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.applicant || "—"}>{r.applicant || "—"}</td>
                <td style={{ padding: "9px 12px", overflow: "hidden" }}><Badge status={r.status} T={T} /></td>
                <td style={{ padding: "6px 12px", textAlign: "center" }}>
                  {r.mark_image_data_url
                    ? <img src={r.mark_image_data_url} alt="mark" style={{ width: 30, height: 30, objectFit: "contain", borderRadius: 4, background: "#fff", border: `1px solid ${T.border}`, padding: 2 }} />
                    : <span style={{ color: T.dimmer, fontSize: 11 }}>—</span>
                  }
                </td>
                <td style={{ padding: "9px 12px", color: T.blueL, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, whiteSpace: "nowrap" }}>{r.class ?? "—"}</td>
                <td style={{ padding: "9px 12px", overflow: "hidden" }}><MatchBadge type={r.match_type} T={T} /></td>
                <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", color: r.individual_risk_score >= 70 ? T.red : r.individual_risk_score >= 40 ? T.amber : T.emerald }}>{r.individual_risk_score}</td>
                <td style={{ padding: "9px 12px", color: T.dimmer, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.filing_date || "—"}</td>
                <td style={{ padding: "9px 12px", textAlign: "center" }}>
                  {r.detail_url && <a href={r.detail_url} target="_blank" rel="noreferrer" style={{ color: T.blueL, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3, textDecoration: "none", whiteSpace: "nowrap" }}>View <ArrowUpRight size={10} /></a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ padding: "12px 22px", borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 12, color: T.dimmer }}>
            Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 12px", fontSize: 12, color: currentPage === 1 ? T.dimmer : T.text, cursor: currentPage === 1 ? "default" : "pointer", fontFamily: "inherit" }}>← Prev</button>
            {Array.from({ length: Math.min(7, totalPages) }, (_, idx) => {
              const p = totalPages <= 7 ? idx + 1 : currentPage <= 4 ? idx + 1 : currentPage >= totalPages - 3 ? totalPages - 6 + idx : currentPage - 3 + idx;
              return (
                <button key={p} onClick={() => setPage(p)}
                  style={{ background: p === currentPage ? T.blueL : T.raised, border: `1px solid ${p === currentPage ? T.blueL : T.border}`, borderRadius: 7, padding: "5px 10px", fontSize: 12, color: p === currentPage ? "#fff" : T.text, cursor: "pointer", fontFamily: "inherit", minWidth: 32 }}>{p}</button>
              );
            })}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 12px", fontSize: 12, color: currentPage === totalPages ? T.dimmer : T.text, cursor: currentPage === totalPages ? "default" : "pointer", fontFamily: "inherit" }}>Next →</button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── History rail — with Re-brand PDF button + individual delete ───────────────
function HistoryRail({ items, onSelect, activeId, branding, onDelete, onClearAll, T }) {
  const [deletingId, setDeletingId] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };
  const hasBranding = !!(branding?.footer || branding?.logo || branding?.tagline);

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!onDelete) return;
    setDeletingId(id);
    try { await onDelete(id); } finally { setDeletingId(null); }
  };

  // Authenticated PDF download — uses axios so JWT header is included
  const handlePdfDownload = async (e, id, withBranding = false) => {
    e.stopPropagation();
    if (downloadingId) return;
    setDownloadingId(id + (withBranding ? ":brand" : ""));
    try {
      let blob;
      if (withBranding && branding?.logo) {
        // POST with logo body
        const wm = branding?.watermark === "CUSTOM" ? branding.customWatermark : branding?.watermark;
        const res = await api.post(
          `/trademark-qc/searches/${id}/pdf`,
          {
            logo_data_url:    branding.logo || null,
            footer:           branding.footer || "",
            tagline:          branding.tagline || "Trademark Availability Report",
            watermark:        wm || "",
            custom_watermark: branding.customWatermark || "",
          },
          { responseType: "blob", timeout: 60000 }
        );
        blob = res.data;
      } else {
        // GET with optional branding query params
        const params = new URLSearchParams();
        if (withBranding) {
          if (branding?.footer)  params.set("footer",    branding.footer);
          if (branding?.tagline) params.set("tagline",   branding.tagline);
          const wm = branding?.watermark === "CUSTOM" ? branding.customWatermark : branding?.watermark;
          if (wm) params.set("watermark", wm);
        }
        const qs = params.toString();
        const res = await api.get(
          `/trademark-qc/searches/${id}/pdf${qs ? `?${qs}` : ""}`,
          { responseType: "blob", timeout: 60000 }
        );
        blob = res.data;
      }
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      const a   = document.createElement("a");
      a.href     = url;
      a.download = `trademark_report_${id.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("PDF download failed. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Card style={{ overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ background: `${COLORS.mediumBlue}20`, borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Clock size={14} style={{ color: COLORS.mediumBlue }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: T.dimmer, fontWeight: 700 }}>Docket</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Recent Reports</div>
        </div>
        {onClearAll && items?.length > 0 && (
          <button
            onClick={async () => {
              if (!window.confirm(`Clear all ${items.length} report${items.length !== 1 ? "s" : ""} from docket?`)) return;
              setClearing(true);
              try { await onClearAll(); } finally { setClearing(false); }
            }}
            disabled={clearing}
            title="Clear all reports from docket"
            style={{
              background: "transparent", border: `1px solid ${T.border}`, borderRadius: 7,
              cursor: clearing ? "not-allowed" : "pointer", padding: "4px 10px",
              fontSize: 11, fontWeight: 600, color: T.dimmer, display: "flex",
              alignItems: "center", gap: 5, transition: "all 0.15s", flexShrink: 0,
              opacity: clearing ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!clearing) { e.currentTarget.style.background = "rgba(239,68,68,0.1)"; e.currentTarget.style.color = "#DC2626"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.4)"; }}}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.dimmer; e.currentTarget.style.borderColor = T.border; }}
          >
            {clearing
              ? <span style={{ display: "block", width: 10, height: 10, border: `2px solid ${T.border}`, borderTopColor: T.muted, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              : <Trash2 size={11} />
            }
            {clearing ? "Clearing…" : "Clear all"}
          </button>
        )}
      </div>

      <div style={{ maxHeight: 520, overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
        {(!items?.length) && <div style={{ padding: "20px 18px", color: T.dimmer, fontSize: 13 }}>No reports yet. Run your first search.</div>}
        {items?.map(it => {
          const active = it.id === activeId;
          const isDeleting = deletingId === it.id;
          const cfg = VERDICT_CFG[it.overall_status] || VERDICT_CFG.CAUTION;
          return (
            <div key={it.id} style={{ borderBottom: `1px solid ${T.border}`, background: active ? `${COLORS.mediumBlue}12` : "none", borderLeft: active ? `3px solid ${COLORS.blueLight}` : "3px solid transparent", transition: "all 0.15s", position: "relative" }}>
              <button onClick={() => onSelect(it)} disabled={isDeleting} style={{ width: "100%", background: "none", border: "none", padding: "12px 40px 6px 16px", textAlign: "left", cursor: isDeleting ? "not-allowed" : "pointer", opacity: isDeleting ? 0.5 : 1 }}>
                <div style={{ fontSize: 10, color: T.dimmer, marginBottom: 4 }}>{fmt(it.created_at)}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.query}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <VerdictBadge status={it.overall_status} />
                  <span style={{ fontSize: 11, color: T.dimmer, fontFamily: "'JetBrains Mono', monospace" }}>Risk {it.risk_score}</span>
                </div>
              </button>

              {/* Delete button — appears on hover */}
              {onDelete && (
                <button
                  onClick={(e) => handleDelete(e, it.id)}
                  disabled={isDeleting}
                  title="Remove from docket"
                  style={{
                    position: "absolute", top: 10, right: 10,
                    background: "transparent", border: "none",
                    cursor: isDeleting ? "not-allowed" : "pointer",
                    padding: 5, borderRadius: 6, color: T.dimmer,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={e => { if (!isDeleting) { e.currentTarget.style.background = "rgba(239,68,68,0.12)"; e.currentTarget.style.color = "#DC2626"; }}}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.dimmer; }}
                >
                  {isDeleting
                    ? <span style={{ display: "block", width: 12, height: 12, border: `2px solid ${T.border}`, borderTopColor: T.muted, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    : <Trash2 size={13} />
                  }
                </button>
              )}

              {/* Re-brand PDF row */}
              <div style={{ display: "flex", gap: 6, padding: "0 12px 10px", flexWrap: "wrap" }}>
                <Btn T={T} variant="ghost" style={{ padding: "3px 9px", fontSize: 11 }}
                  onClick={e => handlePdfDownload(e, it.id, false)}
                  disabled={downloadingId === it.id}>
                  <Download size={11} /> {downloadingId === it.id ? "…" : "PDF"}
                </Btn>
                {hasBranding && (
                  <Btn T={T} variant="save" style={{ padding: "3px 9px", fontSize: 11 }}
                    title="Re-generate this report PDF with your current branding"
                    onClick={e => handlePdfDownload(e, it.id, true)}
                    disabled={downloadingId === it.id + ":brand"}>
                    <Paintbrush size={11} /> {downloadingId === it.id + ":brand" ? "…" : "Re-brand"}
                  </Btn>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Bulk search ──────────────────────────────────────────────────────────────
function BulkPanel({ onPickReport, branding, clientInfo, T }) {
  const [text, setText] = useState("");
  const [klass, setKlass] = useState("");
  // Multi-class mode: array of selected class numbers
  const [selectedClasses, setSelectedClasses] = useState([]);
  const [multiClassMode, setMultiClassMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [combinedLoading, setCombinedLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [dlId, setDlId] = useState(null);
  const [dlAllProgress, setDlAllProgress] = useState(null); // { done, total } | null

  // Derive class_filter and class_filters from current mode
  const getClassParams = () => {
    if (multiClassMode && selectedClasses.length > 0) {
      return { class_filter: selectedClasses[0], class_filters: selectedClasses };
    }
    const cf = klass ? Number(klass) : null;
    return { class_filter: cf, class_filters: cf ? [cf] : null };
  };

  const toggleClass = (num) => {
    setSelectedClasses(prev =>
      prev.includes(num) ? prev.filter(c => c !== num) : [...prev, num].sort((a, b) => a - b)
    );
  };

  const run = async () => {
    const names = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!names.length) return toast.error("Enter at least one name");
    if (names.length > 20) return toast.error("Max 20 names per batch");
    setLoading(true); setItems([]); setAnalytics(null);
    try {
      const { class_filter, class_filters } = getClassParams();
      const data = await bulkReports(names, { class_filter, class_filters });
      setItems(data.items || []);
      setAnalytics(data.analytics || null);
      toast.success(`Batch complete — ${data.count} names processed`);
    } catch (e) { toast.error(e?.response?.data?.detail || "Bulk search failed"); }
    finally { setLoading(false); }
  };

  const downloadItemPdf = async (e, id) => {
    e.stopPropagation();
    if (dlId) return;
    setDlId(id);
    try {
      const res = await api.get(`/trademark-qc/searches/${id}/pdf`, { responseType: "blob", timeout: 60000 });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const a   = document.createElement("a");
      a.href = url; a.download = `trademark_report_${id.slice(0, 8)}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error("PDF download failed"); } finally { setDlId(null); }
  };

  /**
   * Download every successful bulk result as its OWN separate PDF file —
   * each one rendered through the exact same endpoint (and therefore the
   * exact same qc_pdf_renderer format/logo placement) as a single "Run
   * Report" download. Files land individually in the browser's downloads
   * folder; nothing is zipped or merged.
   */
  const downloadAllIndividualPdfs = async () => {
    const successful = items.filter(it => !it.error && it.id);
    if (!successful.length) return toast.error("No successful results to download");
    setDlAllProgress({ done: 0, total: successful.length });
    let failed = 0;
    for (let i = 0; i < successful.length; i++) {
      const it = successful[i];
      const safeName = (it.name || it.report?.query || `mark_${i + 1}`).replace(/[^a-zA-Z0-9-_]+/g, "_");
      try {
        const res = await api.get(`/trademark-qc/searches/${it.id}/pdf`, { responseType: "blob", timeout: 60000 });
        const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `trademark_${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        failed++;
      }
      setDlAllProgress({ done: i + 1, total: successful.length });
      // Small stagger so browsers don't throttle/block rapid-fire downloads.
      if (i < successful.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    setDlAllProgress(null);
    if (failed) toast.error(`${failed} of ${successful.length} PDFs failed to download`);
    else toast.success(`Downloaded ${successful.length} individual PDFs`);
  };

  const handleCombinedPdf = async (fmt = "pdf") => {
    const successful = items.filter(it => !it.error);
    if (!successful.length) return toast.error("No successful results to include in combined report");
    if (!branding?.footer && !branding?.logo && !branding?.tagline) {
      toast("Tip: set branding in the Report Branding panel to add your logo and company name to the PDF");
    }
    setCombinedLoading(true);
    try {
      // FIX: name is on it.name (now guaranteed by backend) or fallback to report.query
      const names = successful.map(it => it.name || it.report?.query || it.report?.report?.query).filter(Boolean);
      if (!names.length) return toast.error("Could not determine mark names for export");
      const { class_filter, class_filters } = getClassParams();
      const wm = branding?.watermark === "CUSTOM" ? branding?.customWatermark : branding?.watermark;
      await bulkExport(names, {
        class_filter,
        class_filters,
        logo_data_url:    branding?.logo    || null,
        footer:           branding?.footer  || "",
        tagline:          branding?.tagline || "Bulk Trademark Availability Report",
        watermark:        wm || "",
        custom_watermark: branding?.customWatermark || "",
        client_name:      clientInfo?.client_name   || "",
        client_mobile:    clientInfo?.client_mobile || "",
        report_date:      clientInfo?.report_date   || "",
        prepared_by:      clientInfo?.prepared_by   || "",
      }, fmt);
      toast.success(`Combined ${fmt.toUpperCase()} report downloaded`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e?.message || "Failed to generate combined report");
    } finally { setCombinedLoading(false); }
  };

  const successCount = items.filter(it => !it.error).length;

  return (
    <Collapsible T={T} title="Bulk Search" icon={Layers} iconColor={COLORS.emeraldGreen} badge="Check up to 20 names at once">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 12, marginBottom: 12 }}>
        <Textarea T={T} rows={5} value={text} onChange={e => setText(e.target.value)} placeholder={"One brand name per line:\nKunjveda\nFumera\nZorbixsynth"} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Toggle between single-class and multi-class */}
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 12, color: T.muted }}>
            <input type="checkbox" checked={multiClassMode} onChange={e => { setMultiClassMode(e.target.checked); setSelectedClasses([]); setKlass(""); }}
              style={{ accentColor: COLORS.mediumBlue }} />
            Multi-class search
          </label>

          {!multiClassMode ? (
            <select value={klass} onChange={e => setKlass(e.target.value)}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: T.muted, padding: "10px 14px", fontSize: 13, outline: "none", fontFamily: "inherit" }}>
              <option value="">All classes</option>
              {Array.from({ length: 45 }, (_, i) => i + 1).map(c => <option key={c} value={c}>Class {c}</option>)}
            </select>
          ) : (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 10px", maxHeight: 130, overflowY: "auto", background: T.raised }}>
              <div style={{ fontSize: 10, color: T.dimmer, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Select classes ({selectedClasses.length} selected)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {Array.from({ length: 45 }, (_, i) => i + 1).map(c => {
                  const sel = selectedClasses.includes(c);
                  return (
                    <button key={c} onClick={() => toggleClass(c)}
                      style={{ fontSize: 10, padding: "2px 6px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                        border: `1px solid ${sel ? COLORS.mediumBlue : T.border}`,
                        background: sel ? `${COLORS.mediumBlue}18` : T.raised,
                        color: sel ? COLORS.mediumBlue : T.muted, fontWeight: sel ? 700 : 400 }}>
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Btn T={T} onClick={run} disabled={loading} style={{ justifyContent: "center" }}>
            {loading ? "Processing…" : "Run Batch"}
          </Btn>
          <p style={{ fontSize: 11, color: T.dimmer, margin: 0 }}>Each name creates a stored report.</p>
        </div>
      </div>

      {/* Portfolio analytics summary */}
      {analytics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginBottom: 14 }}>
          {[
            ["Total",       analytics.total_marks,                          T.text],
            ["Available",   analytics.available,                            "#166534"],
            ["Caution",     analytics.caution,                              "#92400E"],
            ["Conflict",    analytics.conflict,                             "#7F1D1D"],
            ["Avg Risk",    `${analytics.average_risk}/100`,                COLORS.mediumBlue],
            ["High Risk",   analytics.high_risk_marks,                      "#B45309"],
            ["Avg Success", `${analytics.average_success_probability}%`,    "#1F6FB2"],
          ].map(([label, value, color]) => (
            <div key={label} style={{ textAlign: "center", border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 4px", background: T.raised }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dimmer, fontWeight: 600, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
            {/* Scrollable wrapper so columns never wrap */}
            <div style={{ overflowX: "auto" }}>
            {items.map((it, i) => {
              const rpt = it.report || {};
              const status    = rpt.overall_status || it.overall_status;
              const riskScore = rpt.risk_score     ?? it.risk_score ?? 0;
              const name      = rpt.query          || it.name || "—";
              const headline  = rpt.headline       || it.headline || "";
              const regProb = it.error ? null : Math.max(0, Math.min(95, status === "AVAILABLE" ? Math.min(95, 100 - riskScore + 10) : status === "CONFLICT" ? Math.max(5, 100 - riskScore - 15) : 100 - riskScore));
              const badgeCfg = { AVAILABLE: [COLORS.emeraldGreen, "Safe to File"], CAUTION: [COLORS.amber, "Review First"], CONFLICT: ["#DC2626", "High Risk"] };
              const [badgeClr, badgeLabel] = badgeCfg[status] || [COLORS.amber, "Unknown"];
              const isExpanded = expandedId === i;
              const allResults = Array.isArray(rpt.all_results) ? rpt.all_results : (Array.isArray(it.all_results) ? it.all_results : []);
              const classBreakdown = Array.isArray(rpt.class_breakdown) ? rpt.class_breakdown : (Array.isArray(it.class_breakdown) ? it.class_breakdown : []);
              const recommendations = Array.isArray(rpt.recommendations) ? rpt.recommendations : (Array.isArray(it.recommendations) ? it.recommendations : []);
              return (
                <div key={i} style={{ borderBottom: i < items.length - 1 ? `1px solid ${T.border}` : "none" }}>
                  {/* Summary row — min-width prevents column wrapping */}
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) 108px 48px 72px 96px minmax(140px,1fr) 148px", padding: "10px 14px", alignItems: "center", gap: 8, minWidth: 700 }}>
                    <span style={{ fontWeight: 600, color: T.text, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                    {it.error ? <span style={{ color: T.red, fontSize: 12 }}>Failed</span> : <VerdictBadge status={status} />}
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.muted, fontSize: 12, whiteSpace: "nowrap" }}>{it.error ? "—" : riskScore}</span>
                    {!it.error && regProb !== null ? (
                      <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.mediumBlue, whiteSpace: "nowrap" }}>{regProb}%</span>
                    ) : <span />}
                    {!it.error ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: badgeClr, background: `${badgeClr}18`, border: `1px solid ${badgeClr}44`, borderRadius: 99, padding: "2px 7px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{badgeLabel}</span>
                    ) : <span />}
                    <span style={{ fontSize: 12, color: T.dimmer, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.error || headline}</span>
                    {!it.error && it.id && (
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexShrink: 0 }}>
                        <Btn T={T} variant="ghost" onClick={() => onPickReport?.(it.id)} style={{ padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }}>View</Btn>
                        <Btn T={T} variant="ghost" style={{ padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }} disabled={dlId === it.id} onClick={e => downloadItemPdf(e, it.id)}>
                          <Download size={11} /> {dlId === it.id ? "…" : "PDF"}
                        </Btn>
                        <Btn T={T} variant="ghost" style={{ padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }} onClick={() => setExpandedId(isExpanded ? null : i)}>
                          {isExpanded ? "▲" : "▼"} Details
                        </Btn>
                      </div>
                    )}
                  </div>

                  {/* Expanded full-data row */}
                  {isExpanded && !it.error && (
                    <div style={{ padding: "12px 16px 16px", background: T.raised, borderTop: `1px solid ${T.border}` }}>
                      {/* Summary counts */}
                      {it.summary_counts && (
                        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                          {[["Total", it.summary_counts.total_results], ["Exact", it.summary_counts.exact], ["Phonetic", it.summary_counts.phonetic], ["Similar", it.summary_counts.contains_or_similar], ["Blocking", it.summary_counts.blocking_exact_matches]].map(([label, val]) => (
                            <div key={label} style={{ textAlign: "center", minWidth: 56 }}>
                              <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: "'JetBrains Mono', monospace" }}>{val ?? 0}</div>
                              <div style={{ fontSize: 10, color: T.dimmer, textTransform: "uppercase" }}>{label}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Class breakdown */}
                      {classBreakdown.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.dimmer, textTransform: "uppercase", marginBottom: 6 }}>Class Breakdown</div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {classBreakdown.map(cb => (
                              <span key={cb.class} style={{ fontSize: 11, background: `${COLORS.mediumBlue}18`, color: COLORS.mediumBlue, borderRadius: 6, padding: "3px 8px", border: `1px solid ${COLORS.mediumBlue}33` }}>
                                CL{String(cb.class).padStart(2,"0")}: {cb.total} ({cb.blocking} blocking)
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recommendations */}
                      {recommendations.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.dimmer, textTransform: "uppercase", marginBottom: 6 }}>Recommendations</div>
                          <ol style={{ margin: 0, paddingLeft: 18 }}>
                            {recommendations.map((r, ri) => (
                              <li key={ri} style={{ fontSize: 12, color: T.muted, marginBottom: 4, lineHeight: 1.5 }}>{r}</li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {/* Conflict table */}
                      {allResults.length > 0 ? (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.dimmer, textTransform: "uppercase", marginBottom: 6 }}>Conflicting Filings ({allResults.length})</div>
                          <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                              <thead>
                                <tr style={{ background: T.bg }}>
                                  {["App No.", "Name", "Applicant", "Status", "Class", "Match", "Risk"].map(h => (
                                    <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontSize: 10, textTransform: "uppercase", color: T.dimmer, fontWeight: 700, whiteSpace: "nowrap", position: "sticky", top: 0, background: T.bg }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {allResults.map((r, ri) => (
                                  <tr key={ri} style={{ borderTop: `1px solid ${T.border}` }}>
                                    <td style={{ padding: "5px 10px", color: T.dimmer, fontFamily: "'JetBrains Mono', monospace" }}>{r.application_id || "—"}</td>
                                    <td style={{ padding: "5px 10px", fontWeight: 600, color: T.text }}>
                                      {r.detail_url ? <a href={r.detail_url} target="_blank" rel="noreferrer" style={{ color: COLORS.mediumBlue, textDecoration: "none" }}>{r.name}</a> : r.name}
                                    </td>
                                    <td style={{ padding: "5px 10px", color: T.muted }}>{r.applicant || "—"}</td>
                                    <td style={{ padding: "5px 10px" }}><Badge status={r.status} T={T} /></td>
                                    <td style={{ padding: "5px 10px", color: T.muted }}>{r.class ?? "—"}</td>
                                    <td style={{ padding: "5px 10px" }}><MatchBadge type={r.match_type} T={T} /></td>
                                    <td style={{ padding: "5px 10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: r.individual_risk_score >= 70 ? T.red : r.individual_risk_score >= 40 ? T.amber : T.emerald }}>{r.individual_risk_score}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        <p style={{ fontSize: 12, color: T.dimmer, margin: 0 }}>No conflicting filings found in the QuickCompany index.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            </div>{/* end scrollable wrapper */}
          </div>

          {/* Individual PDFs action bar — one file per mark, no zip */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: `${COLORS.emeraldGreen}0e`, border: `1px solid ${COLORS.emeraldGreen}33`, borderRadius: 10, marginBottom: 10 }}>
            <div style={{ background: `${COLORS.emeraldGreen}22`, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Layers size={15} style={{ color: COLORS.emeraldGreen }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Individual PDFs</div>
              <div style={{ fontSize: 11, color: T.dimmer }}>
                {dlAllProgress
                  ? `Downloading ${dlAllProgress.done} of ${dlAllProgress.total}…`
                  : `${successCount} separate file${successCount !== 1 ? "s" : ""} · same format as Run Report · not zipped`}
              </div>
            </div>
            <Btn T={T} variant="success" onClick={downloadAllIndividualPdfs} disabled={!!dlAllProgress || successCount === 0}
              style={{ whiteSpace: "nowrap", padding: "8px 14px", fontSize: 12 }}>
              {dlAllProgress
                ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> {dlAllProgress.done}/{dlAllProgress.total}</>
                : <><Download size={13} /> Download All ({successCount})</>}
            </Btn>
          </div>

          {/* Combined report action bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: `${COLORS.mediumBlue}0e`, border: `1px solid ${COLORS.mediumBlue}33`, borderRadius: 10 }}>
            <div style={{ background: `${COLORS.mediumBlue}22`, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <FileText size={15} style={{ color: COLORS.mediumBlue }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Combined Report</div>
              <div style={{ fontSize: 11, color: T.dimmer }}>
                {successCount} mark{successCount !== 1 ? "s" : ""} · all verdicts merged into one file
                {(clientInfo?.client_name) && <> · {clientInfo.client_name}</>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn T={T} variant="primary" onClick={() => handleCombinedPdf("pdf")} disabled={combinedLoading || successCount === 0}
                style={{ whiteSpace: "nowrap", padding: "8px 14px", fontSize: 12 }}>
                {combinedLoading
                  ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> Generating…</>
                  : <><Download size={13} /> PDF</>}
              </Btn>
              <Btn T={T} variant="ghost" onClick={() => handleCombinedPdf("docx")} disabled={combinedLoading || successCount === 0}
                style={{ whiteSpace: "nowrap", padding: "8px 14px", fontSize: 12 }}>
                <Download size={13} /> DOCX
              </Btn>
              <Btn T={T} variant="ghost" onClick={() => handleCombinedPdf("xlsx")} disabled={combinedLoading || successCount === 0}
                style={{ whiteSpace: "nowrap", padding: "8px 14px", fontSize: 12 }}>
                <Download size={13} /> Excel
              </Btn>
            </div>
          </div>
        </>
      )}
    </Collapsible>
  );
}

// ─── Class finder ─────────────────────────────────────────────────────────────
function ClassFinderPanel({ onPickClass, T }) {
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  const run = async () => {
    if (desc.trim().length < 5) return toast.error("Describe your goods/services in a few words");
    setLoading(true); setSuggestions([]);
    try {
      const data = await findClasses(desc.trim(), 6);
      setSuggestions(data.suggestions || []);
      if (!data.suggestions?.length) toast("No class matched — try more specific terms");
    } catch { toast.error("Class finder failed"); }
    finally { setLoading(false); }
  };

  const CONF_COLOR = { high: COLORS.emeraldGreen, medium: COLORS.amber, low: "#94a3b8" };

  return (
    <Collapsible T={T} title="Class Finder" icon={Compass} iconColor={COLORS.violet} badge="Describe your product → get Nice classification">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 12, marginBottom: 16 }}>
        <Textarea T={T} rows={3} value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. AI-powered SaaS platform for online coaching, organic ayurvedic skincare" />
        <Btn T={T} onClick={run} disabled={loading} style={{ alignSelf: "start", justifyContent: "center", height: 44 }}>
          {loading ? "Analysing…" : "Find Classes"}
        </Btn>
      </div>
      {suggestions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {suggestions.map((s, i) => (
            <button key={s.class} onClick={() => onPickClass?.(s.class)}
              style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", textAlign: "left", cursor: "pointer", transition: "border-color 0.15s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: T.dimmer, fontWeight: 600, textTransform: "uppercase" }}>Rank {i + 1} · {s.score} pts</span>
                <span style={{ fontSize: 10, color: CONF_COLOR[s.confidence] || T.dimmer, fontWeight: 700, textTransform: "uppercase" }}>{s.confidence}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ background: `${COLORS.mediumBlue}20`, color: COLORS.mediumBlue, borderRadius: 6, padding: "3px 8px", fontSize: 12, fontWeight: 700 }}>CL{String(s.class).padStart(2, "0")}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{s.title}</span>
              </div>
              <p style={{ fontSize: 12, color: T.dimmer, margin: "0 0 8px", lineHeight: 1.5 }}>{s.summary}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {s.matched_keywords.slice(0, 4).map(k => (
                  <span key={k} style={{ background: T.card, border: `1px solid ${T.border}`, color: T.muted, borderRadius: 4, padding: "2px 7px", fontSize: 10 }}>{k}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </Collapsible>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ onScroll, T }) {
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="visible">
      <Card style={{ padding: "60px 40px", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: `${COLORS.mediumBlue}18`, border: `1px solid ${COLORS.mediumBlue}33`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <Shield size={32} style={{ color: COLORS.mediumBlue }} />
        </div>
        <h3 style={{ fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 10px" }}>Enter a brand name to generate your report</h3>
        <p style={{ fontSize: 14, color: T.muted, maxWidth: 440, margin: "0 auto 24px", lineHeight: 1.6 }}>
          Every search produces a verdict, risk score, conflicting filings, class breakdown, and alternative name suggestions — saved automatically to your docket.
        </p>
        <Btn T={T} onClick={onScroll}><Search size={14} /> Start a Search</Btn>
      </Card>
    </motion.div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function ReportSkeleton({ T }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: "linear-gradient(135deg, #0D3B66, #1F6FB2)", borderRadius: 18, padding: "32px 36px" }}>
        <Skeleton T={T} h={12} w={200} r={6} mb={16} /><Skeleton T={T} h={32} w="70%" r={8} mb={12} /><Skeleton T={T} h={20} w="45%" r={6} mb={24} /><Skeleton T={T} h={8} r={99} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
        {[1,2,3,4,5].map(i => <Card key={i} style={{ padding: "18px 20px" }}><Skeleton T={T} h={10} w={80} r={4} mb={10}/><Skeleton T={T} h={36} w={50} r={6} mb={8}/><Skeleton T={T} h={10} w={90} r={4}/></Card>)}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════════════
export default function TrademarkSphere() {
  const isDark = useDark();
  const T = useTokens(isDark);
  const { user } = useAuth();

  const [report, setReport]             = useState(null);
  const [activeId, setActiveId]         = useState(null);
  const [loading, setLoading]           = useState(false);
  const [history, setHistory]           = useState([]);
  const [error, setError]               = useState(null);
  const [lastClassFilter, setLastClassFilter] = useState(null);
  const [pinnedClass, setPinnedClass]   = useState("");
  const [searchQuery, setSearchQuery]   = useState("");
  const [selectedClient, setSelectedClient] = useState(null);
  const [reportDate, setReportDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [companies, setCompanies]       = useState([]);
  const [trademarkUsers, setTrademarkUsers] = useState([]);
  const [preparedBy, setPreparedBy]     = useState("");

  // Branding — load saved on mount
  const [branding, setBranding] = useState(loadSavedBranding);

  const searchRef = useRef();

  // Load companies and auto-apply default if saved
  useEffect(() => {
    api.get("/companies/list").then(res => {
      const cos = normalizeCompanies(res);
      setCompanies(cos);
      // Auto-apply default company branding
      const saved = loadSavedBranding();
      if (saved.defaultCompanyId) {
        const co = cos.find(c => String(c.id) === String(saved.defaultCompanyId));
        if (co) {
          setBranding(prev => ({
            ...prev,
            logo:     co.tm_logo_base64 || co.logo_base64 || prev.logo,
            logoName: (co.tm_logo_base64 || co.logo_base64) ? co.name : prev.logoName,
            footer:   prev.footer || `Prepared by ${co.name}${co.gstin ? ` · GSTIN: ${co.gstin}` : ""}`,
            tagline:  prev.tagline || "Trademark Availability Report",
          }));
        }
      }
    }).catch(err => {
      console.error("Failed to load companies for Trademark Sphere:", err);
    });

    // Load trademark department users for "Prepared By" dropdown
    api.get("/trademark-qc/trademark-users").then(res => {
      setTrademarkUsers(Array.isArray(res.data) ? res.data : []);
    }).catch(() => {});
  }, []);

  const refreshHistory = useCallback(async () => {
    try { const h = await listHistory(25); setHistory(Array.isArray(h) ? h : (h?.items ?? [])); } catch {}
  }, []);

  useEffect(() => {
    refreshHistory();
    const p = new URLSearchParams(window.location.search);
    const sid = p.get("report");
    if (sid) {
      (async () => {
        try { setLoading(true); const d = await getReport(sid); setReport(d.report); setActiveId(d.id); }
        catch { toast.error("Could not load shared report"); }
        finally { setLoading(false); }
      })();
    }
  }, [refreshHistory]);

  const handleSearch = async (name, opts = {}) => {
    setLoading(true); setError(null); setReport(null); setActiveId(null);
    setLastClassFilter(opts.class_filter ?? null);
    setSearchQuery(name);
    try {
      const effectiveLogo = opts.logo_data_url || branding.logo || null;
      const effectiveWm = branding.watermark === "CUSTOM" ? branding.customWatermark : branding.watermark;
      const data = await generateReport(name, {
        ...opts,
        logo_data_url:    effectiveLogo,
        footer:           branding.footer || "",
        tagline:          branding.tagline || "Trademark Availability Report",
        watermark:        effectiveWm || "",
        custom_watermark: branding.customWatermark || "",
        client_name:      selectedClient?.company_name || "",
        client_mobile:    selectedClient?.phone || "",
        report_date:      reportDate || "",
        prepared_by:      preparedBy || "",
      });
      setReport(data.report);
      setActiveId(data.id);
      const classInfo = opts.class_filters?.length > 1
        ? ` (${opts.class_filters.length} classes, ${data.report.summary_counts?.total_all_classes ?? data.report.summary_counts?.total_results ?? "?"} total matches)`
        : "";
      toast.success(`Report ready — ${data.report.overall_status}${classInfo}`);
      refreshHistory();
    } catch (e) {
      const msg = e?.response?.data?.detail || e.message || "Failed to generate report";
      setError(msg); toast.error(msg);
    } finally { setLoading(false); }
  };

  const handleDeleteReport = async (reportId) => {
    try {
      await deleteReport(reportId);
      if (activeId === reportId) { setReport(null); setActiveId(null); }
      await refreshHistory();
      toast.success("Report removed from docket");
    } catch (e) {
      toast.error("Failed to delete report");
    }
  };

  const handleClearAll = async () => {
    const ids = history.map(h => h.id);
    let failed = 0;
    for (const id of ids) {
      try { await deleteReport(id); } catch { failed++; }
    }
    setReport(null); setActiveId(null);
    await refreshHistory();
    if (failed > 0) toast.error(`${failed} report(s) could not be removed`);
    else toast.success(`Cleared ${ids.length} report${ids.length !== 1 ? "s" : ""} from docket`);
  };

  const handleHistorySelect = async (item) => {
    setLoading(true); setError(null); setReport(null);
    setLastClassFilter(item.class_filter || null);
    try {
      const d = await getReport(item.id);
      setReport(d.report); setActiveId(d.id);
      window.scrollTo({ top: 320, behavior: "smooth" });
    } catch { toast.error("Could not load report"); }
    finally { setLoading(false); }
  };

  const scrollToSearch = () => {
    searchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    searchRef.current?.querySelector('input[data-testid="search-input"]')?.focus();
  };

  const handleBrandingChange = (updated) => {
    setBranding(updated);
    // Auto-save footer/tagline/watermark to localStorage (not the full logo to avoid quota issues)
    saveBrandingToStorage({ ...updated, logo: null }); // logo stays in memory only
  };

  return (
    <>
      <style>{`
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        * { box-sizing: border-box; }
      `}</style>

      <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter', -apple-system, sans-serif", padding: "24px 24px 48px", overflowX: "hidden" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", width: "100%" }}>

          {/* ── Page header — aligned with Dashboard layout ── */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 44, height: 44, borderRadius: 14, background: "linear-gradient(135deg, #0D3B66, #1F6FB2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 4px 14px rgba(31,111,178,0.35)" }}>
                  <Shield size={22} style={{ color: "#fff" }} />
                </div>
                <div>
                  <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text, letterSpacing: "-0.4px" }}>Trademark Sphere</h1>
                  <p style={{ margin: 0, fontSize: 12, color: T.dimmer, marginTop: 2 }}>Data source: quickcompany.in/trademarks</p>
                </div>
              </div>
              {/* Quick stats strip + page refresh */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {report && (
                  <>
                    <VerdictBadge status={report.overall_status} large />
                    <div style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, padding: "6px 14px", display: "flex", alignItems: "center", gap: 6 }}>
                      <BarChart3 size={13} style={{ color: T.blueL }} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: "'JetBrains Mono', monospace" }}>Risk {report.risk_score}/100</span>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  title="Refresh page"
                  aria-label="Refresh page"
                  onClick={() => window.location.reload()}
                  onMouseEnter={e => { e.currentTarget.style.background = T.raised; e.currentTarget.style.transform = "rotate(90deg)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "rotate(0deg)"; }}
                  style={{
                    width: 36, height: 36, borderRadius: 10, border: `1px solid ${T.border}`,
                    background: "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", color: T.muted, flexShrink: 0, transition: "transform 0.35s ease, background 0.15s ease",
                  }}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* ── Configuration row: client + branding ── */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", gap: 16, marginBottom: 16, alignItems: "stretch" }}>
            {/* Client selector card */}
            <Card style={{ padding: "18px 20px" }}>
              <ClientSelector T={T} value={selectedClient} onChange={setSelectedClient} />
              {/* Report Date */}
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, color: T.dimmer, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  Report Date
                </div>
                <input
                  type="date"
                  value={reportDate}
                  onChange={e => setReportDate(e.target.value)}
                  style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, padding: "9px 14px", fontSize: 13, outline: "none", width: "100%", fontFamily: "inherit", cursor: "pointer" }}
                />
              </div>
            </Card>

            {/* Branding panel — always expanded, no collapsible */}
            <Card style={{ padding: "18px 22px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ background: `${COLORS.amber}20`, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Stamp size={15} style={{ color: COLORS.amber }} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Report Branding</div>
                  <div style={{ fontSize: 11, color: T.dimmer }}>Logo · watermark · footer — applied to every generated PDF</div>
                </div>
              </div>
              <BrandingPanel T={T} branding={branding} onChange={handleBrandingChange} companies={companies} preparedBy={preparedBy} onPreparedByChange={setPreparedBy} trademarkUsers={trademarkUsers} />
            </Card>
          </div>

          {/* ── Search bar ── */}
          <div ref={searchRef} style={{ marginBottom: 14 }}>
            <SearchBar T={T} onSubmit={handleSearch} loading={loading} defaultClass={pinnedClass} client={selectedClient} />
          </div>

          {/* ── Tools row: bulk search first, then class finder ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
            <BulkPanel T={T} branding={branding} clientInfo={{
              client_name:   selectedClient?.company_name || "",
              client_mobile: selectedClient?.phone || "",
              report_date:   reportDate || "",
              prepared_by:   preparedBy || "",
            }} onPickReport={async (id) => {
              const item = history.find(h => h.id === id);
              if (item) handleHistorySelect(item);
              else { try { const d = await getReport(id); setReport(d.report); setActiveId(d.id); refreshHistory(); } catch {} }
            }} />
            <ClassFinderPanel T={T} onPickClass={(cls) => { setPinnedClass(String(cls)); toast.success(`Class ${cls} pinned`); scrollToSearch(); }} />
            <Collapsible T={T} title="Developer API & Embed" icon={Code} iconColor={COLORS.violet} badge="cURL & JS REST API">
              <ApiDeveloperPanel query={report?.query || ""} classFilter={pinnedClass || report?.class_filter || ""} />
            </Collapsible>
          </div>

          {/* ── Report section (full width) ── */}
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {loading && <ReportSkeleton T={T} />}

                {!loading && error && (
                  <Card style={{ padding: "28px", borderColor: "rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <AlertTriangle size={18} style={{ color: T.red }} />
                      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, color: T.red }}>Scraper Error</span>
                    </div>
                    <p style={{ margin: 0, color: "#fca5a5", fontSize: 14 }}>{error}</p>
                    <p style={{ margin: "8px 0 0", fontSize: 12, color: T.dimmer }}>QuickCompany source may be temporarily unreachable. Please retry.</p>
                  </Card>
                )}

                {!loading && !error && report && (
                  <motion.div variants={stagger} initial="hidden" animate="visible" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <VerdictPanel T={T} report={report} />
                    <StatGrid T={T} report={report} />

                    {/* Branding preview strip */}
                    {(branding.logo || branding.watermark || branding.footer) && (
                      <Card style={{ padding: "14px 20px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          {branding.logo && <img src={branding.logo} alt="brand" style={{ height: 32, objectFit: "contain", borderRadius: 4, background: "#fff", padding: "2px 6px" }} />}
                          <div>
                            {branding.tagline && <div style={{ fontSize: 12, color: T.muted, fontWeight: 500 }}>{branding.tagline}</div>}
                            {branding.footer && <div style={{ fontSize: 11, color: T.dimmer }}>{branding.footer}</div>}
                          </div>
                          {(branding.watermark === "CUSTOM" ? branding.customWatermark : branding.watermark) && (
                            <div style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, color: T.dimmer, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", opacity: 0.6 }}>
                              {branding.watermark === "CUSTOM" ? branding.customWatermark : branding.watermark}
                            </div>
                          )}
                        </div>
                      </Card>
                    )}

                    <ReportActions T={T} reportId={activeId} branding={branding} brandName={searchQuery} clientInfo={{
                        client_name:   selectedClient?.company_name || "",
                        client_mobile: selectedClient?.phone || "",
                        report_date:   reportDate || "",
                        prepared_by:   preparedBy || "",
                      }} />

                    {/* ── 3-col row: Recommendations + Alternative Names + Recent Reports ── */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, alignItems: "stretch" }}>
                      <RecommendationsPanel T={T} recommendations={report.recommendations ?? []} />
                      <AlternativesPanel T={T} alternatives={report.alternative_name_suggestions ?? []} />
                      <HistoryRail T={T} items={history} onSelect={handleHistorySelect} activeId={activeId} branding={branding} onDelete={handleDeleteReport} onClearAll={handleClearAll} />
                    </div>

                    {/* ── Full-width: All Recorded Matches ── */}
                    <MatchesTable T={T} rows={report.all_results ?? []} />

                    {/* ── Full-width: Class Breakdown ── */}
                    <ClassBreakdown T={T} rows={report.class_breakdown ?? []} />
                  </motion.div>
                )}

                {!loading && !error && !report && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20, alignItems: "start" }}>
                    <EmptyState T={T} onScroll={scrollToSearch} />
                    <HistoryRail T={T} items={history} onSelect={handleHistorySelect} activeId={activeId} branding={branding} onDelete={handleDeleteReport} onClearAll={handleClearAll} />
                  </div>
                )}
              </div>
            </div>

          <div style={{ marginTop: 32, paddingTop: 20, borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", fontSize: 12, color: T.dimmer }}>
            <span>Data source: quickcompany.in/trademarks</span>
            <span>For informational purposes only — not legal advice</span>
          </div>
        </div>
      </div>
    </>
  );
}
