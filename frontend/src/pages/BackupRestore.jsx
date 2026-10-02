import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, AlertTriangle, Database, Download, HardDriveDownload, History, LockKeyhole, RefreshCw, RotateCcw, ShieldCheck, Trash2, Upload, Users } from 'lucide-react';
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) {
    return 'Calculating…';
  }
  const value = Math.max(0, Math.round(Number(seconds)));
  if (value < 60) return value + 's remaining';
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  if (minutes < 60) return minutes + 'm ' + secs + 's remaining';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm remaining';
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return amount.toFixed(index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2) + ' ' + units[index];
}

function normalizeBackupDetail(detail) {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return String(item);
      const field = Array.isArray(item.loc) && item.loc.length
        ? String(item.loc[item.loc.length - 1])
        : 'field';
      return item.msg
        ? field + ': ' + item.msg
        : item.message || JSON.stringify(item);
    }).filter(Boolean).join(' · ');
  }
  if (detail && typeof detail === 'object') {
    return detail.msg || detail.message || JSON.stringify(detail);
  }
  return '';
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
  const [activeTab, setActiveTab] = useState('backup');
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [transfer, setTransfer] = useState({
    active: false,
    phase: '',
    percent: 0,
    etaSeconds: null,
    processed: 0,
    total: 0,
    detail: '',
  });

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

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const { data } = await api.get('/app-backup/history');
      setHistory(Array.isArray(data?.history) ? data.history : []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Unable to load backup history');
    } finally {
      setHistoryLoading(false);
    }
  };

  const downloadHistoryBackup = async (record) => {
    try {
      const response = await api.get('/app-backup/history/' + encodeURIComponent(record.id) + '/download', {
        responseType: 'blob',
        onDownloadProgress: (event) => {
          const loaded = Number(event.loaded || 0);
          const total = Number(event.total || record.file_size_bytes || 0);
          const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
          setTransfer((current) => ({
            ...current,
            active: percent < 100,
            phase: 'Downloading stored backup…',
            percent,
            processed: loaded,
            total,
            detail: total ? formatBytes(loaded) + ' / ' + formatBytes(total) : formatBytes(loaded) + ' downloaded',
          }));
        },
      });
      const filename = record.filename || ('onenexa-backup-' + record.id + '.onenexa');
      downloadBlob(response.data, filename);
      setTransfer({
        active: false,
        phase: 'Complete',
        percent: 100,
        etaSeconds: 0,
        processed: record.file_size_bytes || response.data?.size || 0,
        total: record.file_size_bytes || response.data?.size || 0,
        detail: 'Historical backup downloaded successfully.',
      });
      toast.success('Historical backup downloaded.');
    } catch (error) {
      setTransfer((current) => ({
        ...current,
        active: false,
        phase: 'Failed',
        etaSeconds: null,
      }));
      toast.error(normalizeBackupDetail(error?.response?.data?.detail) || error?.message || 'Unable to download historical backup');
    }
  };

  const deleteHistoryBackup = async (record) => {
    if (!record?.id) return;
    const confirmed = window.confirm(
      'Delete this backup permanently? This removes the history record and the stored backup data. This cannot be undone.'
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.delete('/app-backup/history/' + encodeURIComponent(record.id));
      setHistory((current) => current.filter((item) => item.id !== record.id));
      toast.success('Backup history record and stored backup data deleted.');
    } catch (error) {
      toast.error(normalizeBackupDetail(error?.response?.data?.detail) || error?.message || 'Unable to delete backup history record');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadInfo();
    void loadHistory();
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

    const progressId =
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);

    setBusy(true);
    setTransfer({ active: true, phase: 'Preparing backup…', percent: 0, etaSeconds: null, processed: 0, total: 0, detail: 'Starting background backup job…' });
    let stopped = false;
    let pollTimer = null;

    try {
      const form = new FormData();
      form.append('password', password);
      if (mode !== 'full') form.append('collections', customSelection.join(','));

      const response = await fetch(BASE_URL + '/app-backup/create', {
        method: 'POST',
        headers: { Authorization: getToken() ? 'Bearer ' + getToken() : '', 'X-Backup-Progress-ID': progressId },
        body: form,
      });
      const rawResponse = await response.text();
      let data = {};
      try { data = rawResponse ? JSON.parse(rawResponse) : {}; } catch { data = {}; }
      if (!response.ok) throw new Error(normalizeBackupDetail(data?.detail) || normalizeBackupDetail(data?.message) || rawResponse || 'Backup could not be started (' + response.status + ')');
      const serverProgressId = String(data?.progress_id || progressId);

      const pollProgress = async () => {
        if (stopped) return null;
        const { data: progress } = await api.get('/app-backup/create/progress/' + encodeURIComponent(serverProgressId), { _skipReadyGate: true, _silent: true });
        if (!progress) return null;
        const phase = progress.phase;
        setTransfer((current) => ({ ...current, active: !['ready', 'error'].includes(phase), phase: phase === 'creating' ? 'Creating backup…' : phase === 'encrypting' ? 'Encrypting backup…' : phase === 'preparing' ? 'Preparing backup…' : phase === 'queued' ? 'Backup queued…' : phase === 'ready' ? 'Backup ready. Starting download…' : phase === 'error' ? 'Failed' : phase || current.phase, percent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : current.percent, etaSeconds: progress.eta_seconds ?? current.etaSeconds, processed: progress.processed_documents ?? progress.processed_bytes ?? current.processed, total: progress.total_documents ?? progress.total_bytes ?? current.total, detail: progress.error || (progress.current_collection ? 'Collection: ' + progress.current_collection : progress.download_ready ? 'Backup is ready for download.' : current.detail) }));
        if (phase === 'error') throw new Error(progress.error || 'Backup creation failed on the server.');
        return phase === 'ready' && progress.download_ready ? progress : null;
      };

      await new Promise((resolve, reject) => {
        const finish = async () => {
          try { const ready = await pollProgress(); if (ready?.download_ready) { window.clearInterval(pollTimer); stopped = true; resolve(ready); } }
          catch (error) { window.clearInterval(pollTimer); stopped = true; reject(error); }
        };
        pollTimer = window.setInterval(finish, 700);
        void finish();
      });

      setTransfer((current) => ({ ...current, active: true, phase: 'Downloading backup…', percent: 0, etaSeconds: null, processed: 0, total: 0, detail: 'Transferring encrypted backup to your device…' }));
      const downloadResponse = await fetch(BASE_URL + '/app-backup/create/download/' + encodeURIComponent(serverProgressId), { method: 'GET', headers: { Authorization: getToken() ? 'Bearer ' + getToken() : '' } });
      if (!downloadResponse.ok) throw new Error('Backup download failed (' + downloadResponse.status + ')');
      const backupBlob = await readResponseWithProgress(downloadResponse, ({ loaded, total, percent, etaSeconds }) => { setTransfer((current) => ({ ...current, active: true, phase: 'Downloading backup…', percent, etaSeconds, processed: loaded, total, detail: total ? formatBytes(loaded) + ' / ' + formatBytes(total) : formatBytes(loaded) + ' downloaded' })); });
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(backupBlob, 'onenexa-backup-' + timestamp + '.onenexa');
      setTransfer({ active: false, phase: 'Complete', percent: 100, etaSeconds: 0, processed: backupBlob.size, total: backupBlob.size, detail: 'Backup downloaded successfully.' });
      toast.success(mode === 'full' ? 'Full application backup downloaded.' : 'Custom backup downloaded.');
      void loadHistory();
    } catch (error) {
      setTransfer((current) => ({ ...current, active: false, phase: 'Failed', etaSeconds: null, detail: error?.message || '' }));
      toast.error(error?.message || 'Backup failed');
    } finally {
      stopped = true;
      if (pollTimer) window.clearInterval(pollTimer);
      setBusy(false);
    }
  };
  const restoreBackup = async () => {
    if (!restoreFile) return toast.error('Choose a .onenexa backup file, or a legacy .taskosphere file from the old application.');
    if (restorePassword.length < 8) return toast.error('Enter the backup password.');
    if (restoreConfirm !== 'RESTORE') return toast.error('Type RESTORE exactly to confirm.');
    if (!window.confirm('Restore will replace the selected tenant data from this backup. Continue?')) return;

    setBusy(true);
    setTransfer({
      active: true,
      phase: 'Uploading backup…',
      percent: 0,
      etaSeconds: null,
      processed: 0,
      total: restoreFile.size || 0,
      detail: 'Transferring encrypted backup to the server…',
    });

    try {
      const form = new FormData();
      form.append('backup', restoreFile);
      form.append('password', restorePassword);
      form.append('confirmation', restoreConfirm);
      const uploadStarted = performance.now();

      const { data } = await api.post('/app-backup/restore', form, {
        headers: {
          // FormData must let the browser/axios generate multipart/form-data with its boundary.
          // The shared API instance defaults to application/json, which causes FastAPI to return 422.
          'Content-Type': undefined,
        },
        onUploadProgress: (event) => {
          const loaded = Number(event.loaded || 0);
          const total = Number(event.total || restoreFile.size || 0);
          const elapsed = Math.max(0.001, (performance.now() - uploadStarted) / 1000);
          const speed = loaded / elapsed;
          const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
          const remaining = total > 0 ? Math.max(0, total - loaded) : 0;

          setTransfer({
            active: true,
            phase: percent >= 100 ? 'Restoring backup…' : 'Uploading backup…',
            percent,
            etaSeconds: speed > 0 && total > 0 ? remaining / speed : null,
            processed: loaded,
            total,
            detail: percent >= 100
              ? 'Upload complete. Server is restoring the backup…'
              : formatBytes(loaded) + ' / ' + formatBytes(total),
          });
        },
      });

      setTransfer({
        active: false,
        phase: 'Complete',
        percent: 100,
        etaSeconds: 0,
        processed: restoreFile.size || 0,
        total: restoreFile.size || 0,
        detail: 'Backup restored successfully.',
      });

      toast.success('Restore completed: ' + (data.restored_documents || 0) + ' documents restored.');
      setRestoreFile(null);
      setRestorePassword('');
      setRestoreConfirm('');
      if (fileRef.current) fileRef.current.value = '';
      await loadInfo();
    } catch (error) {
      setTransfer((current) => ({
        ...current,
        active: false,
        phase: 'Failed',
        etaSeconds: null,
      }));
      const detail =
        normalizeBackupDetail(error?.response?.data?.detail) ||
        error?.message ||
        'Restore failed';
      toast.error(detail);
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
          <button type="button" onClick={() => { void loadInfo(); void loadHistory(); }} disabled={loadingInfo || historyLoading || busy} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold disabled:opacity-50">
            <RefreshCw className={loadingInfo || historyLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh
          </button>
        </div>
      </div>

      <div className={'rounded-2xl border p-1 ' + card}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
          {[
            ['backup', 'Backup', HardDriveDownload],
            ['restore', 'Restore', RotateCcw],
            ['history', 'History', History],
          ].map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => { setActiveTab(value); if (value === 'history') void loadHistory(); }}
              className={'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all ' + (
                activeTab === value
                  ? (isDark ? 'bg-slate-700 text-white shadow-sm' : 'bg-blue-50 text-blue-700 shadow-sm')
                  : (isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-50')
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {value === 'history' && history.length > 0 && <span className="ml-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-extrabold text-white">{history.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {transfer.phase && (
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={'text-sm font-bold ' + heading}>{transfer.phase}</p>
              <p className={'text-[11px] mt-1 ' + muted}>{transfer.detail || 'Working…'}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-extrabold text-blue-600">{Math.min(100, Math.max(0, Number(transfer.percent || 0))).toFixed(2)}%</p>
              <p className={'text-[10px] ' + muted}>{transfer.percent >= 100 ? 'Complete' : formatEta(transfer.etaSeconds)}</p>
            </div>
          </div>
          <div className="mt-3 h-2.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
              style={{ width: Math.min(100, Math.max(0, Number(transfer.percent || 0))) + '%' }}
            />
          </div>
          {transfer.total > 0 && (
            <p className={'text-[10px] mt-2 ' + muted}>
              {formatBytes(transfer.processed)} / {formatBytes(transfer.total)}
            </p>
          )}
        </div>
      )}

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

      {activeTab === 'backup' && (
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

      )}

      {activeTab === 'restore' && (
      <div className={'rounded-2xl border p-5 ' + card}>
        <div className="flex items-start gap-3"><RotateCcw className="h-5 w-5 text-amber-500 mt-0.5" /><div><h2 className={'font-bold ' + heading}>Restore Backup</h2><p className={'text-xs mt-1 ' + muted}>Restore into this license/company or another license. The target company identity and the current administrator's live authentication credentials are preserved.</p></div></div>
        <div className={'mt-4 rounded-xl border p-3 flex gap-2 ' + (isDark ? 'border-amber-900/50 bg-amber-950/20' : 'border-amber-200 bg-amber-50')}><AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" /><p className={'text-xs leading-relaxed ' + (isDark ? 'text-amber-300' : 'text-amber-800')}>Restore replaces data covered by the backup. It is intentionally restricted to administrators and requires the exact word <b>RESTORE</b>.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          <div><label className={'text-xs font-bold ' + heading}>Backup file</label><div className="mt-1.5 flex gap-2"><input ref={fileRef} type="file" accept=".onenexa,.taskosphere,application/octet-stream" onChange={(e) => setRestoreFile(e.target.files?.[0] || null)} className={input + ' file:mr-3 file:rounded-lg file:border-0 file:px-2 file:py-1 file:text-xs'} /><Upload className="h-4 w-4 text-slate-400 shrink-0 mt-3 -ml-10 pointer-events-none" /></div>{restoreFile && <p className={'text-[11px] mt-1 ' + muted}>{restoreFile.name}</p>}</div>
          <div><label className={'text-xs font-bold ' + heading}>Backup password</label><input type="password" value={restorePassword} onChange={(e) => setRestorePassword(e.target.value)} className={input + ' mt-1.5'} autoComplete="off" /></div>
          <div><label className={'text-xs font-bold ' + heading}>Confirmation</label><input value={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.value)} className={input + ' mt-1.5'} placeholder="Type RESTORE" /></div>
          <div className="flex items-end"><button type="button" onClick={restoreBackup} disabled={busy} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-50 w-full"><RotateCcw className="h-4 w-4" />{busy ? 'Restoring…' : 'Restore Backup'}</button></div>
        </div>
      </div>

      )}

      {activeTab === 'history' && (
        <div className={'rounded-2xl border p-5 ' + card}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <History className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
              <div>
                <h2 className={'font-bold ' + heading}>Backup History</h2>
                <p className={'text-xs mt-1 ' + muted}>Every completed backup round is stored here as an encrypted, tenant-scoped artifact. Deleting a record permanently removes the history entry and its stored backup data.</p>
              </div>
            </div>
            <button type="button" onClick={() => void loadHistory()} disabled={historyLoading || busy} className={'inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold disabled:opacity-50 ' + (isDark ? 'border-slate-700 hover:bg-slate-700' : 'border-slate-200 hover:bg-slate-50')}>
              <RefreshCw className={historyLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh
            </button>
          </div>

          {historyLoading ? (
            <div className={'py-12 text-center text-sm ' + muted}>Loading backup history…</div>
          ) : history.length === 0 ? (
            <div className={'mt-4 rounded-xl border p-8 text-center ' + (isDark ? 'border-slate-700' : 'border-slate-200')}>
              <History className="mx-auto h-9 w-9 text-slate-400" />
              <p className={'mt-3 text-sm font-bold ' + heading}>No completed backups yet</p>
              <p className={'mt-1 text-xs ' + muted}>Newly completed backups will appear here automatically.</p>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full min-w-[860px] text-left">
                <thead className={isDark ? 'bg-slate-900' : 'bg-slate-50'}>
                  <tr>
                    {['Date & Time', 'Created By', 'Type', 'Collections', 'Documents', 'Size', 'Actions'].map((label) => (
                      <th key={label} className={'px-3 py-2.5 text-[10px] uppercase tracking-wider font-extrabold ' + muted}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => (
                    <tr key={record.id} className={'border-t ' + (isDark ? 'border-slate-700' : 'border-slate-100')}>
                      <td className={'px-3 py-3 text-xs font-semibold ' + heading}>{record.created_at ? new Date(record.created_at).toLocaleString('en-IN') : '—'}</td>
                      <td className={'px-3 py-3 text-xs ' + muted}>{record.created_by || 'Administrator'}</td>
                      <td className={'px-3 py-3 text-xs font-semibold capitalize ' + heading}>{record.mode || 'full'}</td>
                      <td className={'px-3 py-3 text-xs ' + muted}>{record.collection_count ?? 0}</td>
                      <td className={'px-3 py-3 text-xs ' + muted}>{Number(record.document_count || 0).toLocaleString('en-IN')}</td>
                      <td className={'px-3 py-3 text-xs ' + muted}>{record.file_size_bytes ? formatBytes(record.file_size_bytes) : '—'}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => void downloadHistoryBackup(record)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-blue-700 disabled:opacity-50">
                            <Download className="h-3.5 w-3.5" /> Download
                          </button>
                          <button type="button" onClick={() => void deleteHistoryBackup(record)} disabled={busy || !record.deletable} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-red-700 disabled:opacity-50">
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className={'rounded-2xl border p-4 ' + card}><div className="flex items-start gap-2.5"><ShieldCheck className="h-4 w-4 text-emerald-500 mt-0.5" /><div><p className={'text-xs font-bold ' + heading}>Recommended backup policy</p><p className={'text-[11px] mt-1 leading-relaxed ' + muted}>Keep at least one full encrypted backup outside the application server. The .onenexa file is portable and includes MongoDB data automatically; legacy .taskosphere files from the old application are accepted for migration; because hosted app disks can be ephemeral, long-term automatic retention should use your MongoDB provider/object-storage backup facility rather than relying on local server files.</p></div></div></div>
    </div>
  );
}
