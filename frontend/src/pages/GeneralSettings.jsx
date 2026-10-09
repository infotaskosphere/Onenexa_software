// =============================================================================
// GeneralSettings.jsx — v2 · Multi-drive integrations, improved UI
// =============================================================================
import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useDark } from "@/hooks/useDark";
import api from "@/lib/api";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  User, Camera, Phone, Calendar as CalendarIcon,
  Save, Loader2, CheckCircle2, Mail, Shield,
  Settings, Clock, Hash, Star, Trophy, TrendingUp,
  CheckSquare, Timer, Users as UsersIcon, Link2,
  HardDrive, Plug, ChevronRight, Server,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DriveIntegrations from "@/components/DriveIntegrations";
import AssignedClientsPanel from "@/components/AssignedClientsPanel";
import OfficeSyncHubManager from "@/components/OfficeSyncHubManager";

const COLORS = {
  deepBlue:     "#0D3B66",
  mediumBlue:   "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  lightGreen:   "#5CCB5F",
};

const GRADIENT   = `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`;
const GRAD_GREEN = `linear-gradient(135deg, ${COLORS.emeraldGreen} 0%, ${COLORS.lightGreen} 100%)`;

const ROLE_COLORS = {
  admin:   { bg: '#ede9fe', text: '#7C3AED', dot: '#7C3AED' },
  manager: { bg: '#dbeafe', text: '#1e40af', dot: '#3B82F6' },
  staff:   { bg: '#f1f5f9', text: '#475569', dot: '#94a3b8' },
};

const BADGE_CFG = {
  "Star Performer": { color: '#F59E0B', bg: '#FEF3C7', darkBg: '#78350f40', icon: '⭐' },
  "Top Performer":  { color: '#3B82F6', bg: '#DBEAFE', darkBg: '#1e3a8a40', icon: '🏆' },
  "Good Performer": { color: '#10B981', bg: '#D1FAE5', darkBg: '#065f4640', icon: '👍' },
};

function MiniBar({ value, color, isDark }) {
  return (
    <div className={`h-1.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(value || 0, 100)}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="h-full rounded-full"
        style={{ background: color }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration category nav — shown inside the integrations tab
// ─────────────────────────────────────────────────────────────────────────────

const INT_SECTIONS = [
  { id: 'sync',    label: 'Office Hub & Sync', icon: Server,    desc: 'Multi-PC office network pairing & backups' },
  { id: 'drives',  label: 'Cloud Drives',      icon: HardDrive, desc: 'Google Drive, OneDrive, Dropbox & more' },
  { id: 'email',   label: 'Email',             icon: Mail,      desc: 'IMAP email account connections' },
];

function IntegrationSidebar({ active, onChange, isDark }) {
  return (
    <div className={`flex flex-row sm:flex-col gap-1 sm:gap-1.5 sm:min-w-[160px]`}>
      {INT_SECTIONS.map(s => {
        const I = s.icon;
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all text-sm font-medium w-full
              ${isActive
                ? 'bg-blue-600 text-white shadow-sm'
                : isDark
                  ? 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              }`}
          >
            <I size={15} className={isActive ? 'text-white' : ''} />
            <div className="text-left min-w-0">
              <p className="text-[13px] font-semibold truncate">{s.label}</p>
              <p className={`text-[10px] hidden sm:block truncate font-normal ${isActive ? 'text-blue-100' : isDark ? 'text-slate-500' : 'text-slate-400'}`}>{s.desc}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Placeholder for email integrations panel (renders existing EmailSettings component)
// In production: import EmailSettings from "@/components/EmailSettings";
function EmailIntegrationsPlaceholder({ isDark }) {
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const card  = isDark ? 'bg-slate-800/40 border-slate-700' : 'bg-slate-50 border-slate-200';
  return (
    <div className={`rounded-2xl border p-6 text-center ${card}`}>
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3" style={{ background: 'rgba(13,59,102,0.10)' }}>
        <Mail size={22} style={{ color: COLORS.mediumBlue }} />
      </div>
      <p className={`text-sm font-bold mb-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Email Accounts</p>
      <p className={`text-xs ${muted}`}>Manage IMAP email connections from the Email Accounts page in the sidebar.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function GeneralSettings() {
  const { user, refreshUser } = useAuth();
  const isDark  = useDark();
  const fileRef = useRef(null);

  const [activeTab, setActiveTab] = useState("profile"); // profile | clients | integrations
  const [intSection, setIntSection] = useState("drives"); // drives | email

  const [profile, setProfile] = useState({
    full_name: "", phone: "", birthday: "", profile_picture: "",
  });
  const [loading,  setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [perf,     setPerf]     = useState(null);
  const [perfLoad, setPerfLoad] = useState(true);

  useEffect(() => {
    if (!user) return;
    setProfile({
      full_name:       user.full_name || "",
      phone:           user.phone || "",
      birthday:        user.birthday ? user.birthday.slice(0, 10) : "",
      profile_picture: user.profile_picture || "",
    });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    api.get("/reports/performance-rankings?period=monthly")
      .then(res => {
        const list = res.data || [];
        const mine = list.find(r => r.user_id === user.id || r.user_id === String(user.id));
        setPerf(mine || null);
      })
      .catch(() => setPerf(null))
      .finally(() => setPerfLoad(false));
  }, [user]);

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setProfile(p => ({ ...p, profile_picture: reader.result }));
    reader.readAsDataURL(file);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!profile.full_name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      const updatePayload = {
        full_name:       profile.full_name.trim(),
        phone:           profile.phone || null,
        birthday:        profile.birthday || null,
        profile_picture: profile.profile_picture || null,
      };
      const res = await api.put(`/users/${user.id}`, updatePayload);
      const returnedUser = res?.data && typeof res.data === "object" ? { ...user, ...res.data } : { ...user, ...updatePayload };
      await refreshUser(returnedUser);
      toast.success("Profile updated");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const roleCfg  = ROLE_COLORS[user?.role] || ROLE_COLORS.staff;
  const badgeCfg = perf?.badge ? (BADGE_CFG[perf.badge] || BADGE_CFG["Good Performer"]) : null;

  return (
    <div className="space-y-4 w-full min-w-0 overflow-x-hidden">

      {/* ── TOP BANNER ──────────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div
          className="general-settings-banner relative overflow-hidden rounded-xl px-4 py-3 sm:px-5 sm:py-3.5"
          style={{ background: GRADIENT, boxShadow: "0 4px 20px rgba(13,59,102,0.18)" }}
        >
          <div className="absolute right-0 top-0 w-48 h-48 rounded-full -mr-16 -mt-16 opacity-10 pointer-events-none"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
          <div className="relative flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center flex-shrink-0">
              <Settings className="h-4 w-4 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight leading-tight">General Settings</h1>
              <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest mt-0.5">
                Manage identity &amp; preferences
              </p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── TAB BAR ─────────────────────────────────────────────────────────
          Uses the same Tabs/TabsList/TabsTrigger primitives as the rest of
          the app (e.g. Employee Master, Leave, Payroll) instead of a
          one-off custom pill bar, so this page's tabs look consistent. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="profile" id="general-settings-tab-profile" className="gap-1.5">
            <User className="h-3.5 w-3.5 shrink-0" />Profile
          </TabsTrigger>
          <TabsTrigger value="clients" id="general-settings-tab-clients" className="gap-1.5">
            <UsersIcon className="h-3.5 w-3.5 shrink-0" />All Assigned Clients
          </TabsTrigger>
          <TabsTrigger value="integrations" id="general-settings-tab-integrations" className="gap-1.5">
            <Link2 className="h-3.5 w-3.5 shrink-0" />Integrations
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ── PROFILE TAB ──────────────────────────────────────────────────── */}
      {activeTab === "profile" && (
      <>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-stretch">

        {/* LEFT: Profile card */}
        <motion.div
          initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 }}
          className="lg:col-span-2 flex flex-col"
        >
          <div className={`rounded-2xl border overflow-hidden shadow-sm flex flex-col flex-1 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>

            {/* Gradient strip */}
            <div className="h-20 relative flex-shrink-0" style={{ background: GRADIENT }}>
              <div className="absolute inset-0 opacity-10"
                style={{ background: 'radial-gradient(circle at 80% 50%, white 0%, transparent 60%)' }} />
              {perf && (
                <div className="absolute top-3 right-3 flex items-center gap-1 bg-white/20 backdrop-blur-sm px-2.5 py-1 rounded-xl">
                  <Trophy className="h-3 w-3 text-yellow-300" />
                  <span className="text-white text-[11px] font-bold">#{perf.rank}</span>
                </div>
              )}
            </div>

            {/* Avatar */}
            <div className="px-5 pb-4 -mt-[52px] flex flex-col items-center text-center">
              <div className="relative group mb-3">
                <div
                  className="w-[110px] h-[110px] rounded-2xl overflow-hidden"
                  style={{ boxShadow: `0 0 0 4px ${isDark ? '#1e293b' : '#fff'}, 0 8px 24px rgba(0,0,0,0.18)` }}
                >
                  {profile.profile_picture ? (
                    <img src={profile.profile_picture} alt="Profile" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white text-4xl font-black"
                      style={{ background: GRADIENT }}>
                      {user?.full_name?.[0]?.toUpperCase()}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="absolute -bottom-1.5 -right-1.5 w-8 h-8 rounded-xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 shadow-lg flex items-center justify-center hover:scale-110 transition-all"
                >
                  <Camera className="w-4 h-4 text-blue-500" />
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
              </div>
              <h2 className={`font-bold text-base leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{user?.full_name}</h2>
              <p className={`text-xs mt-0.5 truncate max-w-full ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{user?.email}</p>
              {badgeCfg && (
                <span
                  className="inline-flex items-center gap-1 mt-2 px-2.5 py-1 rounded-xl text-[11px] font-bold"
                  style={{ background: isDark ? badgeCfg.darkBg : badgeCfg.bg, color: badgeCfg.color }}
                >
                  {badgeCfg.icon} {perf.badge}
                </span>
              )}
            </div>

            {/* Meta rows */}
            <div className={`border-t px-4 py-3 space-y-2.5 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
              <div className="flex items-center justify-between text-xs">
                <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Hash className="h-3 w-3" />Account ID
                </span>
                <span className={`font-mono font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  #{user?.id?.slice(-6)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Star className="h-3 w-3" />Status
                </span>
                <span className="flex items-center gap-1 text-emerald-500 font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Active
                </span>
              </div>
              {user?.departments?.length > 0 && (
                <div className="flex items-start justify-between text-xs gap-2">
                  <span className={`flex items-center gap-1.5 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    <Settings className="h-3 w-3" />Depts
                  </span>
                  <span className={`font-semibold text-right leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {user.departments.join(', ')}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Trophy className="h-3 w-3" />Ranking
                </span>
                {perfLoad ? (
                  <span className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Loading…</span>
                ) : perf ? (
                  <span className="flex items-center gap-1 font-bold text-amber-500">
                    #{perf.rank}
                    <span className={`text-[10px] font-medium ml-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      · {perf.overall_score}% score
                    </span>
                  </span>
                ) : (
                  <span className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>No data yet</span>
                )}
              </div>
            </div>

            {/* Performance mini-stats */}
            <div className={`border-t px-4 py-3 space-y-3 flex-1 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
              <p className={`text-[10px] font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                This Month's Performance
              </p>
              {perfLoad ? (
                <div className={`flex items-center justify-center py-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  <span className="text-xs">Loading stats…</span>
                </div>
              ) : perf ? (
                [
                  { label: 'Attendance',      val: perf.attendance_percent,      color: '#3B82F6', icon: <Timer className="h-3 w-3" /> },
                  { label: 'Task Completion', val: perf.task_completion_percent, color: '#10B981', icon: <CheckSquare className="h-3 w-3" /> },
                  { label: 'Timely Punch-In', val: perf.timely_punchin_percent,  color: '#F59E0B', icon: <Zap className="h-3 w-3" /> },
                  { label: 'Overall Score',   val: perf.overall_score,           color: '#8B5CF6', icon: <TrendingUp className="h-3 w-3" /> },
                ].map(stat => (
                  <div key={stat.label} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[11px]" style={{ color: stat.color }}>
                        {stat.icon}{stat.label}
                      </span>
                      <span className="text-[11px] font-bold" style={{ color: stat.color }}>
                        {(stat.val || 0).toFixed(1)}%
                      </span>
                    </div>
                    <MiniBar value={stat.val} color={stat.color} isDark={isDark} />
                  </div>
                ))
              ) : (
                <p className={`text-xs text-center py-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  No performance data available yet.
                </p>
              )}
            </div>

            {/* Security tip */}
            <div className={`border-t px-4 py-3 flex items-start gap-2.5 ${isDark ? 'border-slate-700 bg-blue-950/20' : 'border-slate-100 bg-blue-50/60'}`}>
              <Shield className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
              <p className={`text-xs leading-relaxed ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                Contact your admin to change passwords or system permissions.
              </p>
            </div>
          </div>
        </motion.div>

        {/* RIGHT: Edit form */}
        <motion.div
          initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 }}
          className="lg:col-span-3 flex flex-col"
        >
          <div className={`rounded-2xl border overflow-hidden shadow-sm flex flex-col flex-1 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className={`flex items-center gap-2.5 px-5 py-3 border-b ${isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-100 bg-slate-50/60'}`}>
              <div className={`p-1.5 rounded-lg ${isDark ? 'bg-blue-900/40' : 'bg-blue-50'}`}>
                <User className="h-3.5 w-3.5 text-blue-500" />
              </div>
              <div>
                <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Personal Information</h3>
                <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Update your contact and profile details</p>
              </div>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 flex flex-col flex-1">
              <div className="space-y-1.5">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Full Name</Label>
                <Input
                  value={profile.full_name}
                  onChange={e => setProfile(p => ({ ...p, full_name: e.target.value }))}
                  className={`h-10 rounded-xl text-sm ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                  placeholder="Your full name"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Phone</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                    <Input
                      type="tel"
                      value={profile.phone}
                      onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                      className={`h-10 rounded-xl text-sm pl-9 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                      placeholder="+91 00000 00000"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Birthday</Label>
                  <div className="relative">
                    <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                    <Input
                      type="date"
                      value={profile.birthday}
                      onChange={e => setProfile(p => ({ ...p, birthday: e.target.value }))}
                      className={`h-10 rounded-xl text-sm pl-9 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                  <Input
                    value={user?.email || ""}
                    disabled
                    className={`h-10 rounded-xl text-sm pl-9 opacity-50 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'}`}
                  />
                </div>
              </div>

              {(user?.punch_in_time || user?.punch_out_time) && (
                <div className={`rounded-xl border p-3.5 ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <Clock className="h-3.5 w-3.5 text-blue-500" />
                    <span className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>Work Shift</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {[
                      { label: 'Punch In',  val: user?.punch_in_time  },
                      { label: 'Grace',     val: user?.grace_time     },
                      { label: 'Punch Out', val: user?.punch_out_time },
                    ].map(s => (
                      <div key={s.label}>
                        <p className={`text-[10px] uppercase tracking-wider mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{s.label}</p>
                        <p className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{s.val || '—'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className={`flex justify-end pt-2 border-t mt-auto ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                <motion.button
                  type="submit"
                  disabled={loading}
                  whileTap={{ scale: 0.97 }}
                  className="flex items-center gap-2 px-7 py-2.5 rounded-xl text-sm font-bold text-white shadow-lg disabled:opacity-50 transition-all hover:brightness-105"
                  style={{ background: loading ? '#94a3b8' : saved ? GRAD_GREEN : GRADIENT }}
                >
                  {loading ? (
                    <><Loader2 className="w-4 h-4 animate-spin" />Updating…</>
                  ) : saved ? (
                    <><CheckCircle2 className="w-4 h-4" />Saved!</>
                  ) : (
                    <><Save className="w-4 h-4" />Save Changes</>
                  )}
                </motion.button>
              </div>
            </form>
          </div>
        </motion.div>

      </div>
      </>
      )}

      {/* ── CLIENTS TAB ──────────────────────────────────────────────────── */}
      {activeTab === "clients" && (
        <AssignedClientsPanel isDark={isDark} />
      )}

      {/* ── INTEGRATIONS TAB ──────────────────────────────────────────────── */}
      {activeTab === "integrations" && (
        <div className="flex flex-col sm:flex-row gap-4">
          <IntegrationSidebar active={intSection} onChange={setIntSection} isDark={isDark} />
          <div className="flex-1 min-w-0">
            {intSection === "sync" && <OfficeSyncHubManager isDark={isDark} />}
            {intSection === "drives" && <DriveIntegrations isDark={isDark} />}
            {intSection === "email" && <EmailIntegrationsPlaceholder isDark={isDark} />}
          </div>
        </div>
      )}

    </div>
  );
}
