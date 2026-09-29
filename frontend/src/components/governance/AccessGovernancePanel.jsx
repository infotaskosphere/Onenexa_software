// AccessGovernancePanel.jsx — the SINGLE shared Module → Page permission
// editor used by BOTH:
//
//   • Admin → Permission Matrix  (src/pages/PermissionMatrix.jsx)
//   • Users → edit user → Access Governance tab (src/pages/Users.jsx)
//
// Because both screens render this one component, the two places can never
// drift apart again: same module tree, same cascade rules, same guidance
// notes (src/lib/permissionGuidance.js), same high-risk warnings.
//
// Usage — controlled (Users dialog already holds permissions in form state):
//   <AccessGovernancePanel
//      value={formData.permissions}
//      onChange={(next) => setFormData(f => ({ ...f, permissions: next }))}
//      isAdminUser={formData.role === 'admin'}
//   />
//
// Usage — self-loading (Permission Matrix page, one user at a time):
//   <AccessGovernancePanel userId={selectedUserId} showSave />
//
// ── LAYOUT NOTES (why this file avoids <SectionCard>) ─────────────────────
// The app ships global "enterprise" CSS that targets *elements*, not classes:
//
//   commercial-business-ui.css   #root header        { height: 64px !important }
//                                #root header + div  { height: 40px !important }
//                                #root header + div button { height: 40px … }
//   enterprise-design.css        #root p, span, label, button { overflow-wrap: anywhere }
//
// <SectionCard> renders a real <header> followed by a <div>, so its body was
// being squashed to 40px (clipped "Module access" rows, overlapping cards,
// 40px-tall checkboxes) and text was breaking in the middle of words.
// Everything below is therefore built from plain <div>s (no <header>), and
// text elements carry an inline overflow-wrap so the global rule cannot win.

import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, Check, X, ShieldAlert, Info, Save, Loader2, Search,
  ChevronsDownUp, ChevronsUpDown, Layers,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import { GuidanceNote, LoadingState, HUB_COLORS } from '@/components/ui/PageKit';
import { moduleNote, pageNote, actionNote, isHighRisk } from '@/lib/permissionGuidance';

const MODULE_COLOR = {
  taskosphere: HUB_COLORS.mediumBlue,
  finix: '#7C3AED',
  aiweave: '#2563EB',
  compliance: '#F59E0B',
  records: HUB_COLORS.emeraldGreen,
  proposals: '#DB2777',
  people_matrix: '#0EA5E9',
  admin: HUB_COLORS.deepBlue,
};

// Inline so it beats the global `#root p/span/label/button { overflow-wrap:anywhere }`.
// `break-word` only splits a word when it genuinely cannot fit on its own line.
const TXT = { overflowWrap: 'break-word', wordBreak: 'normal' };

const CHIP_TONES = {
  slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  blue: 'bg-[#1F6FB2]/10 text-[#1F6FB2] dark:text-sky-300',
};

function Chip({ tone = 'slate', className = '', children, ...rest }) {
  return (
    <span
      style={TXT}
      className={`inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 text-[10px] font-bold leading-4 ${CHIP_TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * GovCard — the card chrome used on the Permission Matrix screen.
 * Plain <div>s only (see LAYOUT NOTES above). Exported so the page can reuse
 * the exact same card look for the Users list.
 */
export function GovCard({
  icon: Icon, title, badge, color = HUB_COLORS.mediumBlue, actions,
  children, className = '', bodyClassName = '',
}) {
  const isDark = useDark();
  return (
    <div
      className={`min-w-0 max-w-full border rounded-2xl ${
        isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-200 shadow-sm'
      } ${className}`}
    >
      {(title || actions) && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b ${
            isDark ? 'border-slate-700/80' : 'border-slate-100'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {Icon && (
              <span
                className="flex items-center justify-center w-8 h-8 shrink-0"
                style={{ background: `${color}18` }}
              >
                <Icon className="w-4 h-4" style={{ color }} />
              </span>
            )}
            <span
              style={TXT}
              className={`text-sm font-bold min-w-0 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}
            >
              {title}
            </span>
            {badge !== undefined && badge !== null && (
              <span
                className="text-[10px] font-extrabold px-2 py-0.5 shrink-0"
                style={{ background: `${color}18`, color }}
              >
                {badge}
              </span>
            )}
          </div>
          {actions}
        </div>
      )}
      <div className={`min-w-0 max-w-full ${bodyClassName}`}>{children}</div>
    </div>
  );
}

// Number of flags that differ between two permission maps (undefined ≡ false).
function countChanges(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  keys.forEach((k) => { if ((a[k] ?? false) !== (b[k] ?? false)) n += 1; });
  return n;
}

export default function AccessGovernancePanel({
  userId,
  value,
  onChange,
  isAdminUser = false,
  readOnly = false,
  showSave = false,
  onSaved,
}) {
  const isDark = useDark();
  const controlled = typeof onChange === 'function';

  const [moduleTree, setModuleTree] = useState([]);
  const [internal, setInternal] = useState({});
  const [baseline, setBaseline] = useState({});
  const [loading, setLoading] = useState(true);
  const [permsLoading, setPermsLoading] = useState(!controlled && !!userId);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  const permissions = controlled ? (value || {}) : internal;
  const setPermissions = (updater) => {
    const next = typeof updater === 'function' ? updater(permissions) : updater;
    if (controlled) onChange(next);
    else setInternal(next);
  };

  // Module tree (shared by both hosts) ────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/permission-governance/module-tree');
        if (alive) setModuleTree(Array.isArray(data) ? data : []);
      } catch {
        toast.error('Could not load the module tree');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Only the self-loading (Permission Matrix) mode fetches a user's perms.
  useEffect(() => {
    if (controlled || !userId) { setPermsLoading(false); return undefined; }
    let alive = true;
    setPermsLoading(true);
    (async () => {
      try {
        const { data } = await api.get(`/users/${userId}/permissions`);
        if (!alive) return;
        setInternal(data || {});
        setBaseline(data || {});
      } catch {
        toast.error('Could not load this user\u2019s permissions');
      } finally {
        if (alive) setPermsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [userId, controlled]);

  const searching = search.trim().length > 0;

  // [{ mod, pages }] — `pages` is what is currently visible (search-filtered).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return moduleTree.map((mod) => ({ mod, pages: mod.pages || [] }));
    return moduleTree
      .map((mod) => {
        const all = mod.pages || [];
        if ((mod.label || '').toLowerCase().includes(q)) return { mod, pages: all };
        const pages = all.filter((p) => (p.label || '').toLowerCase().includes(q));
        return pages.length ? { mod, pages } : null;
      })
      .filter(Boolean);
  }, [moduleTree, search]);

  const toggleModule = (mod, checked) => {
    setPermissions((prev) => {
      const next = { ...prev, [mod.flag]: checked };
      const matrix = { ...(prev.governance_matrix || {}) };
      if (!checked) {
        // Module OFF is a hard revoke: page flags AND every action override
        // beneath the module are removed together.
        (mod.pages || []).forEach((p) => {
          next[p.flag] = false;
          delete matrix[`${mod.module}.${p.flag}`];
        });
      } else {
        // Module ON: enable pages beneath the module so the user gets access
        // to the permitted module (admin can still deselect individual pages).
        (mod.pages || []).forEach((p) => {
          next[p.flag] = true;
          if (!Array.isArray(matrix[`${mod.module}.${p.flag}`])) {
            matrix[`${mod.module}.${p.flag}`] = [...(p.actions || [])];
          }
        });
      }
      next.governance_matrix = matrix;
      return next;
    });
  };

  const togglePage = (mod, page, checked) =>
    setPermissions((prev) => {
      const next = { ...prev, [page.flag]: checked };
      const matrix = { ...(prev.governance_matrix || {}) };
      const key = `${mod.module}.${page.flag}`;
      if (!checked) {
        delete matrix[key];
      } else if (!Array.isArray(matrix[key])) {
        // First explicit enable gets every declared action. The user can then
        // remove individual action chips without affecting the page flag.
        matrix[key] = [...(page.actions || [])];
      }
      next.governance_matrix = matrix;
      return next;
    });

  const effectiveActions = (mod, page) => {
    const key = `${mod.module}.${page.flag}`;
    const explicit = permissions?.governance_matrix?.[key];
    if (Array.isArray(explicit)) return new Set(explicit);
    if (!permissions?.[page.flag]) return new Set();
    // Legacy permission fallback: VIEW/EXPORT follow the page flag; write-like
    // actions follow a matching can_manage_* flag when that flag exists.
    const manageFlag = page.flag.startsWith('can_view_')
      ? page.flag.replace('can_view_', 'can_manage_')
      : null;
    const manageOn = manageFlag && Object.prototype.hasOwnProperty.call(permissions || {}, manageFlag)
      ? permissions[manageFlag] === true
      : permissions[page.flag] === true;
    return new Set((page.actions || []).filter((action) => {
      if (['view', 'export'].includes(action)) return permissions[page.flag] === true;
      if (['create', 'edit', 'delete', 'approve', 'print', 'share', 'update', 'upload'].includes(action)) return manageOn;
      return false;
    }));
  };

  const toggleAction = (mod, page, action) =>
    setPermissions((prev) => {
      const next = { ...prev };
      const matrix = { ...(prev.governance_matrix || {}) };
      const key = `${mod.module}.${page.flag}`;
      const current = Array.isArray(matrix[key])
        ? new Set(matrix[key])
        : effectiveActions(mod, page);
      if (current.has(action)) current.delete(action);
      else current.add(action);
      // A page with no action grants is still allowed to exist, but has no
      // usable action. This is intentional and lets "View" itself be revoked
      // independently from the page switch.
      matrix[key] = Array.from(current);
      next.governance_matrix = matrix;
      return next;
    });

  const bulkPages = (mod, pages, checked) =>
    setPermissions((prev) => {
      const next = { ...prev };
      const matrix = { ...(prev.governance_matrix || {}) };
      pages.forEach((p) => {
        next[p.flag] = checked;
        const key = `${mod.module}.${p.flag}`;
        if (checked) matrix[key] = [...(p.actions || [])];
        else delete matrix[key];
      });
      if (checked) next[mod.flag] = true;
      next.governance_matrix = matrix;
      return next;
    });

  const grantedIn = (mod) => (mod.pages || []).filter((p) => permissions[p.flag]).length;
  const totalGranted = moduleTree.reduce((n, m) => n + grantedIn(m), 0);
  const totalPages = moduleTree.reduce((n, m) => n + (m.pages?.length || 0), 0);
  const pct = totalPages ? Math.round((totalGranted / totalPages) * 100) : 0;

  const changes = !controlled ? countChanges(permissions, baseline) : 0;
  const dirty = changes > 0;

  const isOpen = (mod) => expanded[mod.module] ?? searching;
  const setAllOpen = (open) =>
    setExpanded(Object.fromEntries(filtered.map(({ mod }) => [mod.module, open])));
  const allOpen = filtered.length > 0 && filtered.every(({ mod }) => isOpen(mod));

  const handleSave = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await api.put(`/users/${userId}/permissions`, permissions);
      setBaseline(permissions);
      toast.success('Permissions updated');
      onSaved?.(permissions);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (loading || permsLoading) return <LoadingState label="Loading access governance…" />;

  const adminGovernanceNote = isAdminUser ? (
    <GuidanceNote tone="success" icon={ShieldAlert}>
      <strong>This user is an Admin.</strong> Ordinary modules remain role-governed and are not
      editable here. <strong>AIWeave is the exception:</strong> it is explicitly governed for
      every user, including Admins, and must be granted here or from the Permission Matrix.
    </GuidanceNote>
  ) : null;

  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  const divider = isDark ? 'border-slate-700/80' : 'border-slate-100';

  return (
    <div className="space-y-4 min-w-0 max-w-full">
      <GuidanceNote icon={Info}>
        <span style={TXT}>
          <strong>How access works:</strong> a user reaches a page only when the <em>module</em> switch
          and the <em>page</em> switch are both on. Turning a module off instantly revokes every page
          inside it. Anything marked <span className="font-semibold text-amber-600">High risk</span> exposes
          money, credentials or colleagues&rsquo; personal data — grant it deliberately and review it periodically.
        </span>
      </GuidanceNote>
      {adminGovernanceNote}

      {/* Toolbar — stays in view while the module list scrolls underneath. */}
      <div
        className={`sticky top-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 p-3 border rounded-xl min-w-0 ${
          isDark ? 'bg-slate-900 border-slate-700/80' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        <div className="relative flex-[1_1_260px] min-w-[220px]">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <Input
            className="pl-8"
            placeholder="Search modules and pages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0" title={`${totalGranted} of ${totalPages} pages granted`}>
          <span style={TXT} className={`text-xs font-semibold whitespace-nowrap ${muted}`}>
            {totalGranted}/{totalPages} pages granted
          </span>
          <span className={`hidden tablet-md:block w-20 h-1.5 overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
            <span className="block h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto shrink-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="whitespace-nowrap"
            onClick={() => setAllOpen(!allOpen)}
            disabled={filtered.length === 0}
          >
            {allOpen ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
          {showSave && dirty && (
            <Chip tone="amber" className="!text-[11px]">
              {changes} unsaved {changes === 1 ? 'change' : 'changes'}
            </Chip>
          )}
          {showSave && (
            <Button
              type="button"
              className="whitespace-nowrap"
              onClick={handleSave}
              disabled={saving || readOnly || !userId || !dirty}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </Button>
          )}
        </div>
      </div>

      {moduleTree.length > 0 && !searching && (
        <GovCard
          icon={Layers}
          title="All Permission Modules"
          badge={moduleTree.length}
          color={HUB_COLORS.mediumBlue}
          bodyClassName="p-3"
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {moduleTree.map((module) => {
              const moduleOn = !!permissions[module.flag];
              const moduleId = `gov-mod-${module.module}`;
              return (
                <button
                  key={module.module}
                  type="button"
                  onClick={() => {
                    setExpanded((prev) => ({ ...prev, [module.module]: true }));
                    requestAnimationFrame(() => document.getElementById(moduleId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                  }}
                  className={`min-w-0 text-left px-3 py-2 border transition-colors ${moduleOn
                    ? 'border-[#1F6FB2]/40 bg-[#1F6FB2]/5 text-[#0D3B66] dark:text-sky-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500'}`}
                >
                  <span style={TXT} className="block text-xs font-bold truncate">{module.label}</span>
                  <span className="text-[10px] text-slate-400">
                    {(module.pages || []).filter((page) => permissions[page.flag]).length}/{(module.pages || []).length} pages
                  </span>
                </button>
              );
            })}
          </div>
        </GovCard>
      )}

      {filtered.length === 0 && (
        <GuidanceNote tone="warning" icon={Search}>
          <span style={TXT}>No modules or pages match &ldquo;{search}&rdquo;.</span>
        </GuidanceNote>
      )}

      {filtered.map(({ mod, pages }) => {
        const color = MODULE_COLOR[mod.module] || HUB_COLORS.mediumBlue;
        const allPages = mod.pages || [];
        const open = isOpen(mod);
        const moduleOn = !!permissions[mod.flag];
        const adminModule = mod.module === 'admin';
        const lockedByAdmin = isAdminUser && mod.module !== 'aiweave';
        const modId = `gov-mod-${mod.module}`;

        return (
          <div
            key={mod.module}
            className={`min-w-0 max-w-full border border-l-4 rounded-2xl overflow-hidden ${
              isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-200 shadow-sm'
            }`}
            style={{ borderLeftColor: color }}
          >
            {/* Module row: master switch · title · quick actions · expand */}
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
              style={{ background: `${color}0d` }}
            >
              <Checkbox
                id={modId}
                className="h-[18px] w-[18px]"
                aria-label={`Module access for ${mod.label}`}
                checked={moduleOn}
                disabled={readOnly || adminModule || lockedByAdmin}
                onCheckedChange={(c) => toggleModule(mod, !!c)}
              />

              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded((p) => ({ ...p, [mod.module]: !open }))}
                className="flex items-center gap-2 flex-[1_1_200px] min-w-[min(100%,200px)] text-left cursor-pointer"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  <span style={TXT} className={`text-sm font-bold ${strong}`}>{mod.label}</span>
                  <Chip tone="slate">{grantedIn(mod)}/{allPages.length} pages</Chip>
                  <Chip tone={moduleOn ? 'green' : 'amber'}>
                    {moduleOn ? 'Module on' : 'Module off'}
                  </Chip>
                </span>
              </button>

              <div className="flex items-center gap-2 ml-auto shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="whitespace-nowrap"
                  disabled={readOnly || adminModule || lockedByAdmin}
                  onClick={() => bulkPages(mod, pages, true)}
                >
                  <Check className="w-3.5 h-3.5" /> Grant all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="whitespace-nowrap"
                  disabled={readOnly || adminModule || lockedByAdmin}
                  onClick={() => bulkPages(mod, pages, false)}
                >
                  <X className="w-3.5 h-3.5" /> Clear all
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={open ? `Collapse ${mod.label}` : `Expand ${mod.label}`}
                  onClick={() => setExpanded((p) => ({ ...p, [mod.module]: !open }))}
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${open ? '' : '-rotate-90'}`} />
                </Button>
              </div>
            </div>

            {open && (
              <div className={`border-t px-4 py-4 space-y-3 ${divider}`}>
                <p style={TXT} className={`text-xs leading-relaxed ${muted}`}>
                  <label htmlFor={modId} className={`font-semibold cursor-pointer ${strong}`} style={TXT}>
                    Module access.{' '}
                  </label>
                  {moduleNote(mod.module, mod.description)}
                </p>

                {!moduleOn && allPages.length > 0 && !adminModule && (
                  <GuidanceNote tone="warning" icon={ShieldAlert}>
                    <span style={TXT}>
                      Module access is off, so every page below is locked. Turn the module on
                      (checkbox at the top-left of this card) to grant individual pages.
                    </span>
                  </GuidanceNote>
                )}

                {allPages.length === 0 && (
                  <p style={TXT} className="text-xs text-slate-400">
                    No sub-pages — access to this module is all-or-nothing.
                  </p>
                )}

                {pages.length > 0 && (
                  <div
                    className="grid gap-2.5"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}
                  >
                    {pages.map((page) => {
                      const risky = isHighRisk(page.flag);
                      const pid = `gov-page-${page.flag}`;
                      const locked = readOnly || !moduleOn || lockedByAdmin;
                      return (
                        <div
                          key={page.flag}
                          className={`flex items-start gap-3 p-3 border min-w-0 ${
                            risky
                              ? isDark ? 'border-amber-500/40 bg-amber-500/5' : 'border-amber-300 bg-amber-50/60'
                              : isDark ? 'border-slate-700/80 bg-slate-900/40' : 'border-slate-200 bg-slate-50'
                          } ${!moduleOn ? 'opacity-60' : ''}`}
                        >
                          <Checkbox
                            id={pid}
                            className="mt-0.5 h-[18px] w-[18px]"
                            checked={!!permissions[page.flag]}
                            disabled={locked}
                            onCheckedChange={(c) => togglePage(mod, page, !!c)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <label
                                htmlFor={pid}
                                style={TXT}
                                className={`text-[13px] font-semibold leading-snug ${
                                  locked ? 'cursor-not-allowed' : 'cursor-pointer'
                                } ${!moduleOn ? 'text-slate-400' : strong}`}
                              >
                                {page.label}
                              </label>
                              {risky && (
                                <Chip tone="amber">
                                  <ShieldAlert className="w-3 h-3" /> High risk
                                </Chip>
                              )}
                            </div>
                            <p style={TXT} className={`text-[11px] mt-1 leading-relaxed ${muted}`}>
                              {pageNote(page.flag, page.label)}
                            </p>
                            {!!page.actions?.length && (
                              <div className="flex flex-wrap items-center gap-1 mt-2">
                                <span style={TXT} className="text-[10px] font-semibold text-slate-400">Allows:</span>
                                {page.actions.map((a) => (
                                  <Chip key={a} tone="blue" className="capitalize" title={actionNote(a)}>
                                    {a}
                                  </Chip>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
