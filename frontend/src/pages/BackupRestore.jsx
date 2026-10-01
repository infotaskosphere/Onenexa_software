import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, AlertTriangle, Database, Download, HardDriveDownload, LockKeyhole, RefreshCw, RotateCcw, ShieldCheck, Upload, Users } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';

const MODULE_LABELS = {
  taskosphere: 'Taskosphere',
  records: 'Records',
  proposals: 'Client Proposals',
  finix: 'Finix / Accounts',
  people_matrix: 'People Matrix',
  compliance: 'Compliance',
  automation: 'Automation & Workflows',
  analytics: 'Analytics & Learning',
  settings: 'Settings & Permissions',
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function BackupRestore() {
  const isDark = useDark();
  const fileRef = useRef(null);
  const [info, setInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('full');
  const [password, setPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [selectedModule, setSelectedModule] = useState('taskosphere');
  const [selectedCollections, setSelectedCollections] = useState([]);

  const loadInfo = async () => {
    setLoadingInfo(true);
    try {
      const { data } = await api.get('/app-backup/info');
      setInfo(data);
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Unable to load backup information');
    } finally {
      setLoadingInfo(false);
    }
  };

  useEffect(() => {
    loadInfo();
  }, []);

  const moduleCollections = info?.modules?.[selectedModule] || [];
  const customSelection = useMemo(() => {
    return mode === 'module' ? moduleCollections : selectedCollections;
  }, [mode, moduleCollections, selectedCollections]);

  const toggleCollection = (name) => {
    setSelectedCollections((current) => (
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
    ));
  };

  const createBackup = async () => {
    if (password.length < 8) {
      toast.error('Use a backup password of at least 8 characters.');
      return;
    }
    if (mode !== 'full' && customSelection.length === 0) {
      toast.error('Select at least one module or collection.');
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append('password', password);
      if (mode !== 'full') form.append('collections', customSelection.join(','));

      const response = await api.post('/app-backup/create', form, {
        responseType: 'blob',
      });

      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(response.data, 'taskosphere-backup-' + timestamp + '.taskosphere');
      toast.success(mode === 'full' ? 'Full application backup downloaded.' : 'Custom backup downloaded.');
    } catch (error) {
      if (error?.response?.data instanceof Blob) {
        try {
          const text = await error.response.data.text();
          const parsed = JSON.parse(text);
          toast.error(parsed.detail || 'Backup failed');
        } catch {
          toast.error('Backup failed');
        }
      } else {
        toast.error(error?.response?.data?.detail || 'Backup failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (!restoreFile) return toast.error('Choose a .taskosphere backup file.');
    if (restorePassword.length < 8) return toast.error('Enter the backup password.');
    if (restoreConfirm !== 'RESTORE') return toast.error('Type RESTORE exactly to confirm.');
    if (!window.confirm('Restore will replace the selected tenant data from this backup. Continue?')) return;

    setBusy(true);
    try {
      const form = new FormData();
      form.append('backup', restoreFile);
      form.append('password', restorePassword);
      form.append('confirmation', restoreConfirm);
      const { data } = await api.post('/app-backup/restore', form);
      toast.success('Restore completed: ' + (data.restored_documents || 0) + ' documents restored.');
      setRestoreFile(null);
      setRestorePassword('');
      setRestoreConfirm('');
      if (fileRef.current) fileRef.current.value = '';
      await loadInfo();
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  const card = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const heading = isDark ? 'text-slate-100' : 'text-slate-800';
  const input = 'w-full rounded-xl border px-3 py-2.5 text-sm outline-none ' + (isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-800');
  const modeButton = (value) => 'text-left rounded-xl border p-3 transition-all ' + (mode === value ? 'border-blue-500 ring-2 ring-blue-500/20' : (isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'));
  const radio = (value) => 'h-3.5 w-3.5 rounded-full border-2 ' + (mode === value ? 'border-blue-500 bg-blue-500' : 'border-slate-400');

  return (
    <div className="space-y-4 w-full min-w-0">
      <div className="rounded-2xl overflow-hidden border border-blue-900/20 shadow-sm" style={{ background: 'linear-gradient(135deg,#0D3B66 0%,#1F6FB2 100%)' }}>
        <div className="px-5 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-11 w-11 rounded-xl bg-white/15 flex items-center justify-center shrink-0"><Archive className="h-5 w-5 text-white" /></div>
            <div>
              <h1 className="text-xl font-bold text-white">Backup &amp; Restore</h1>
              <p className="text-xs text-white/70 mt-0.5">Portable encrypted backup of your complete Taskosphere tenant</p>
            </div>
          </div>
          <button type="button" onClick={loadInfo} disabled={loadingInfo || busy} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold disabled:opacity-50">
            <RefreshCw className={loadingInfo ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><Database className="h-4 w-4 text-blue-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted}>MongoDB</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>Included automatically</p>
          <p className={'mt-1 text-xs ' + muted}>Tenant collections are captured in BSON-preserving Extended JSON.</p>
        </div>
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-emerald-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted}>Security</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>AES-256-GCM encrypted</p>
          <p className={'mt-1 text-xs ' + muted}>Password protected. Live sessions and reset tokens are never exported.</p>
        </div>
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><Users className="h-4 w-4 text-violet-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted}>Tenant</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>{info?.company_name || 'Current company'}</p>
          <p className={'mt-1 text-xs ' + muted}>{info?.user_count ?? '—'} users · cross-license restore supported</p>
        </div>
      </div>

      <div className={'rounded-2xl border p-5 ' + card}>
        <div className="flex items-start gap-3">
          <HardDriveDownload className="h-5 w-5 text-blue-500 mt-0.5" />
          <div className="flex-1"><h2 className={'font-bold ' + heading}>Create Backup</h2><p className={'text-xs mt-1 ' + muted}>Full backup is the recommended one-click migration/DR format. Custom mode lets you export only selected modules or MongoDB collections.</p></div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-5">
          {[
            ['full', 'Full Application', 'All tenant MongoDB data, users, settings, permissions and tenant-linked collections'],
            ['module', 'One Module', 'All available collections mapped to one application module'],
            ['collections', 'Selected Data', 'Choose individual MongoDB collections'],
          ].map(([value, label, desc]) => (
            <button key={value} type="button" onClick={() => setMode(value)} className={modeButton(value)}>
              <div className="flex items-center gap-2"><span className={radio(value)} /> <span className={'text-sm font-bold ' + heading}>{label}</span></div>
              <p className={'text-[11px] mt-2 leading-relaxed ' + muted}>{desc}</p>
            </button>
          ))}
        </div>

        {mode === 'module' && (
          <div className="mt-4">
            <label className={'text-xs font-bold ' + heading}>Application module</label>
            <select value={selectedModule} onChange={(e) => setSelectedModule(e.target.value)} className={input + ' mt-1.5'}>
              {Object.keys(MODULE_LABELS).filter((key) => (info?.modules?.[key] || []).length).map((key) => (
                <option key={key} value={key}>{MODULE_LABELS[key]} ({info.modules[key].length} collections)</option>
              ))}
            </select>
          </div>
        )}

        {mode === 'collections' && (
          <div className="mt-4">
            <div className="flex items-center justify-between"><label className={'text-xs font-bold ' + heading}>MongoDB collections</label><span className={'text-[11px] ' + muted}>{selectedCollections.length} selected</span></div>
            <div className={'mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto rounded-xl border p-3 ' + (isDark ? 'border-slate-700' : 'border-slate-200')}>
              {(info?.collections || []).map((name) => (
                <label key={name} className={'flex items-center gap-2 p-2 rounded-lg cursor-pointer ' + (isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50')}>
                  <input type="checkbox" checked={selectedCollections.includes(name)} onChange={() => toggleCollection(name)} />
                  <span className={'text-xs ' + heading}>{name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1 w-full"><label className={'text-xs font-bold ' + heading}>Backup password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={input + ' mt-1.5'} placeholder="Minimum 8 characters" autoComplete="new-password" /></div>
          <button type="button" onClick={createBackup} disabled={busy || loadingInfo} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 w-full sm:w-auto"><Download className="h-4 w-4" />{busy ? 'Preparing…' : mode === 'full' ? 'Download Full Backup' : 'Download Custom Backup'}</button>
        </div>
      </div>

      <div className={'rounded-2xl border p-5 ' + card}>
        <div className="flex items-start gap-3"><RotateCcw className="h-5 w-5 text-amber-500 mt-0.5" /><div><h2 className={'font-bold ' + heading}>Restore Backup</h2><p className={'text-xs mt-1 ' + muted}>Restore into this license/company or another license. The target company identity and the current administrator's live authentication credentials are preserved.</p></div></div>
        <div className={'mt-4 rounded-xl border p-3 flex gap-2 ' + (isDark ? 'border-amber-900/50 bg-amber-950/20' : 'border-amber-200 bg-amber-50')}><AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" /><p className={'text-xs leading-relaxed ' + (isDark ? 'text-amber-300' : 'text-amber-800')}>Restore replaces data covered by the backup. It is intentionally restricted to administrators and requires the exact word <b>RESTORE</b>.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          <div><label className={'text-xs font-bold ' + heading}>Backup file</label><div className="mt-1.5 flex gap-2"><input ref={fileRef} type="file" accept=".taskosphere,application/octet-stream" onChange={(e) => setRestoreFile(e.target.files?.[0] || null)} className={input + ' file:mr-3 file:rounded-lg file:border-0 file:px-2 file:py-1 file:text-xs'} /><Upload className="h-4 w-4 text-slate-400 shrink-0 mt-3 -ml-10 pointer-events-none" /></div>{restoreFile && <p className={'text-[11px] mt-1 ' + muted}>{restoreFile.name}</p>}</div>
          <div><label className={'text-xs font-bold ' + heading}>Backup password</label><input type="password" value={restorePassword} onChange={(e) => setRestorePassword(e.target.value)} className={input + ' mt-1.5'} autoComplete="off" /></div>
          <div><label className={'text-xs font-bold ' + heading}>Confirmation</label><input value={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.value)} className={input + ' mt-1.5'} placeholder="Type RESTORE" /></div>
          <div className="flex items-end"><button type="button" onClick={restoreBackup} disabled={busy} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-50 w-full"><RotateCcw className="h-4 w-4" />{busy ? 'Restoring…' : 'Restore Backup'}</button></div>
        </div>
      </div>

      <div className={'rounded-2xl border p-4 ' + card}><div className="flex items-start gap-2.5"><ShieldCheck className="h-4 w-4 text-emerald-500 mt-0.5" /><div><p className={'text-xs font-bold ' + heading}>Recommended backup policy</p><p className={'text-[11px] mt-1 leading-relaxed ' + muted}>Keep at least one full encrypted backup outside the application server. The .taskosphere file is portable and includes MongoDB data automatically; because hosted app disks can be ephemeral, long-term automatic retention should use your MongoDB provider/object-storage backup facility rather than relying on local server files.</p></div></div></div>
    </div>
  );
}
