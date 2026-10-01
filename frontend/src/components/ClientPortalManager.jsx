import React, { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api.js';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { useDark } from '@/hooks/useDark.jsx';
import {
  X, Loader2, Eye, EyeOff, Copy, KeyRound, UserCheck, Building2,
  ClipboardList, FileText, CreditCard, Shield, FolderPlus, FolderCheck,
  Trash2, AlertTriangle, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import DriveFolderVisibility from '@/components/DriveFolderVisibility';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2' };
const GRADIENT = `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`;

const MODULES = [
  { key: 'can_view_tasks',      label: 'Tasks',      icon: ClipboardList, color: '#3B82F6' },
  { key: 'can_view_documents',  label: 'Documents',  icon: FileText,      color: '#8B5CF6' },
  { key: 'can_view_invoices',   label: 'Invoices',   icon: CreditCard,    color: '#10B981' },
  { key: 'can_view_compliance', label: 'Compliance', icon: Shield,        color: '#F59E0B' },
];

/**
 * ClientPortalManager
 * Modal panel for managing ONE client's portal access: credentials, module
 * visibility, Drive folder, and account removal. Opened from the gear icon
 * on a client's portal card (Overview / Clients tabs).
 */
export default function ClientPortalManager({ clientId, clientName, onClose }) {
  const { isDark } = useDark();

  const [loading, setLoading]   = useState(true);
  const [pu, setPu]             = useState(null);
  const [saving, setSaving]     = useState(false);

  const [revealed, setRevealed]         = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [revealing, setRevealing]       = useState(false);

  const [creatingFolder, setCreatingFolder]   = useState(false);
  const [customFolderName, setCustomFolderName] = useState('');
  const [parentFolderLink, setParentFolderLink] = useState('');
  const [showVisibility, setShowVisibility] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/client-portal/users', { params: { client_id: clientId } });
      const list = Array.isArray(res.data) ? res.data : (res.data?.users ?? res.data?.items ?? []);
      setPu(list[0] || null);
    } catch {
      toast.error('Failed to load portal user');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleReveal = async () => {
    if (!pu) return;
    if (showPassword) { setShowPassword(false); return; }
    if (revealed !== null) { setShowPassword(true); return; }
    setRevealing(true);
    try {
      const res = await api.get(`/client-portal/users/${pu.id}/reveal-password`);
      const pw = res.data?.password || '';
      if (pw === '[decryption failed]') {
        toast.error('Password decryption failed — reset the portal password to fix it.');
        return;
      }
      setRevealed(pw);
      setShowPassword(true);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not retrieve password');
    } finally {
      setRevealing(false);
    }
  };

  const copyCreds = async () => {
    if (!pu) return;
    let pwd = revealed;
    if (pwd === null) {
      try {
        const res = await api.get(`/client-portal/users/${pu.id}/reveal-password`);
        pwd = res.data?.password || '';
        if (pwd === '[decryption failed]') {
          toast.error('Password decryption failed — reset the portal password to fix it.');
          return;
        }
        setRevealed(pwd);
      } catch (err) {
        toast.error(err?.response?.data?.detail || 'Could not retrieve password');
        return;
      }
    }
    await navigator.clipboard.writeText(`User: ${pu.portal_username}  Pass: ${pwd}`);
    toast.success('Login copied to clipboard');
  };

  const patchUser = async (patch) => {
    if (!pu) return;
    setSaving(true);
    const prev = pu;
    setPu({ ...pu, ...patch }); // optimistic
    try {
      await api.put(`/client-portal/users/${pu.id}`, patch);
    } catch (err) {
      setPu(prev); // revert on failure
      toast.error(err?.response?.data?.detail || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const createFolder = async () => {
    setCreatingFolder(true);
    try {
      const res = await api.post('/client-portal/drive/create-individual-folder', {
        client_id: clientId,
        client_name: clientName,
        custom_folder_name: customFolderName.trim() || undefined,
        parent_folder_id: parentFolderLink.trim() || undefined,
      });
      toast.success(`Drive folder ready: ${res.data.folder_name}`);
      setCustomFolderName('');
      setParentFolderLink('');
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to create Drive folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDelete = async () => {
    if (!pu) return;
    setDeleting(true);
    try {
      await api.delete(`/client-portal/users/${pu.id}`);
      toast.success('Portal access removed');
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to remove portal access');
      setDeleting(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(15, 23, 42, 0.55)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
          className={`w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl shadow-2xl border ${
            isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
          }`}
        >
          {/* ── Header ── */}
          <div className="relative px-6 py-5" style={{ background: GRADIENT }}>
            <button onClick={onClose} className="absolute top-4 right-4 text-white/70 hover:text-white" title="Close">
              <X className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-3 pr-8">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <Building2 className="h-5 w-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest">Manage Portal</p>
                <h2 className="text-white font-bold text-lg truncate">{clientName}</h2>
              </div>
            </div>
          </div>

          <div className="p-6 space-y-5">
            {loading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : !pu ? (
              <div className="text-center py-8">
                <p className="text-sm text-slate-500">No portal login has been set up for this client yet.</p>
              </div>
            ) : (
              <>
                {/* ── Credentials ── */}
                <div className={`p-4 rounded-xl space-y-2.5 ${isDark ? 'bg-slate-700/50' : 'bg-slate-50'}`}>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                      <UserCheck className="h-3.5 w-3.5" /> Username
                    </span>
                    <span className="text-sm font-mono text-slate-700 dark:text-slate-200">{pu.portal_username}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                      <KeyRound className="h-3.5 w-3.5" /> Password
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-slate-700 dark:text-slate-200">
                        {showPassword ? (revealed ?? '••••••••') : '••••••••'}
                      </span>
                      <button onClick={toggleReveal} disabled={revealing} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" title={showPassword ? 'Hide' : 'Show'}>
                        {revealing ? <Loader2 className="h-4 w-4 animate-spin" /> : showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={copyCreds} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" title="Copy username & password">
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-slate-500 font-medium">Portal Access</span>
                    <button
                      onClick={() => patchUser({ is_active: !pu.is_active })}
                      disabled={saving}
                      className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                        pu.is_active
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                          : 'bg-slate-200 text-slate-500 dark:bg-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {pu.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </div>
                </div>

                {/* ── Module visibility ── */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 mb-2">Visible Modules</p>
                  <div className="grid grid-cols-2 gap-2">
                    {MODULES.map(({ key, label, icon: Icon, color }) => (
                      <button
                        key={key}
                        onClick={() => patchUser({ [key]: !pu[key] })}
                        disabled={saving}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors"
                        style={
                          pu[key]
                            ? { background: `${color}12`, color, borderColor: `${color}30` }
                            : { background: 'transparent', color: '#94a3b8', borderColor: isDark ? '#475569' : '#e2e8f0' }
                        }
                      >
                        <Icon className="h-3.5 w-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Drive folder ── */}
                <div className={`p-4 rounded-xl space-y-3 ${isDark ? 'bg-slate-700/50' : 'bg-slate-50'}`}>
                  <p className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                    <FolderCheck className="h-3.5 w-3.5" /> Drive Folder
                  </p>
                  {pu.google_drive_folder_id ? (
                    <p className="text-xs text-slate-500 break-all">
                      Linked folder: <span className="font-mono">{pu.google_drive_folder_name || pu.google_drive_folder_id}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">No Drive folder linked yet.</p>
                  )}
                  <Input
                    placeholder="Custom folder name (optional, defaults to client name)"
                    value={customFolderName}
                    onChange={(e) => setCustomFolderName(e.target.value)}
                    className="text-xs h-8"
                  />
                  <Input
                    placeholder="Parent folder link/ID override (optional — uses portal default otherwise)"
                    value={parentFolderLink}
                    onChange={(e) => setParentFolderLink(e.target.value)}
                    className="text-xs h-8"
                  />
                  <Button size="sm" onClick={createFolder} disabled={creatingFolder} className="w-full text-xs">
                    {creatingFolder ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <FolderPlus className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {pu.google_drive_folder_id ? 'Recreate Folder' : 'Create Drive Folder'}
                  </Button>
                  {pu.google_drive_folder_id && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowVisibility(true)}
                      className="w-full text-xs flex items-center justify-center gap-1.5 border-slate-300 dark:border-slate-600"
                    >
                      <FolderCheck className="h-3.5 w-3.5" />
                      Manage File &amp; Folder Visibility
                    </Button>
                  )}
                </div>

                {/* ── Danger zone ── */}
                <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
                  {!confirmDelete ? (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove portal access
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                      <span className="text-xs text-slate-500">Delete this client's portal login?</span>
                      <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting} className="text-xs">
                        {deleting ? 'Removing…' : 'Confirm delete'}
                      </Button>
                      <button onClick={() => setConfirmDelete(false)} className="text-xs text-slate-400 hover:text-slate-600">
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
      {showVisibility && pu && (
        <DriveFolderVisibility
          portalUserId={pu.id}
          portalUsername={pu.portal_username}
          onClose={() => setShowVisibility(false)}
        />
      )}
    </AnimatePresence>
  );
}
