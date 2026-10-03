import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  AlertTriangle,
  Database,
  Download,
  HardDriveDownload,
  History,
  LockKeyhole,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import api, { BASE_URL, getToken } from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import { useBackupManager } from '@/contexts/BackupContext';

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

function normalizeBackupDetail(detail) {
  if (typeof detail === 'string' && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return String(item);
        const field = Array.isArray(item.loc) && item.loc.length
          ? String(item.loc[item.loc.length - 1])
          : 'field';
        return item.msg
          ? field + ': ' + item.msg
          : item.message || JSON.stringify(item);
      })
      .filter(Boolean);

    if (messages.length) return messages.join(' · ');
  }

  if (detail && typeof detail === 'object') {
    return detail.msg || detail.message || JSON.stringify(detail);
  }

  return '';
}

async function getBackupErrorMessage(error) {
  const responseData = error?.response?.data;

  if (typeof Blob !== 'undefined' && responseData instanceof Blob) {
    try {
      const raw = await responseData.text();
      const parsed = JSON.parse(raw);
      return (
        normalizeBackupDetail(parsed?.detail) ||
        normalizeBackupDetail(parsed?.message) ||
        'Backup failed'
      );
    } catch {
      return error?.message || 'Backup failed';
    }
  }

  return (
    normalizeBackupDetail(responseData?.detail) ||
    normalizeBackupDetail(responseData?.message) ||
    error?.message ||
    'Backup failed'
  );
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

async function readResponseWithProgress(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !response.body.getReader) {
    const blob = await response.blob();
    onProgress({ loaded: blob.size, total: total || blob.size, percent: 100, etaSeconds: 0 });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  const started = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;

    const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
    const speed = loaded / elapsed;
    const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
    const remaining = total > 0 ? Math.max(0, total - loaded) : 0;
    onProgress({
      loaded,
      total,
      percent,
      etaSeconds: speed > 0 && total > 0 ? remaining / speed : null,
    });
  }

  const blob = new Blob(chunks, {
    type: response.headers.get('content-type') || 'application/octet-stream',
  });
  onProgress({
    loaded,
    total: total || loaded,
    percent: 100,
    etaSeconds: 0,
  });
  return blob;
}

const BACKUP_RETRY_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Downloads a backup with automatic resume. A 502/503/504 or a dropped
// connection mid-transfer (proxy restart, cold start, flaky network) no longer
// fails the whole backup: the transfer continues from the bytes already
// received using an HTTP Range request, with exponential backoff.
async function downloadBackupWithResume(url, onProgress, maxAttempts = 6) {
  const chunks = [];
  let loaded = 0;
  let total = 0;
  const started = performance.now();
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await sleepMs(Math.min(8000, 800 * 2 ** (attempt - 1)));
    try {
      const headers = { Authorization: getToken() ? 'Bearer ' + getToken() : '' };
      if (loaded > 0) headers.Range = 'bytes=' + loaded + '-';
      const response = await fetch(url, { method: 'GET', headers, cache: 'no-store' });

      if (!response.ok && response.status !== 206) {
        if (BACKUP_RETRY_STATUSES.has(response.status)) {
          lastError = new Error('Server temporarily unavailable (' + response.status + ')');
          continue;
        }
        let detail = '';
        try {
          const parsed = JSON.parse(await response.text());
          detail = normalizeBackupDetail(parsed?.detail) || normalizeBackupDetail(parsed?.message);
        } catch { /* non-JSON error body */ }
        const fatal = new Error(detail || 'Backup download failed (' + response.status + ')');
        fatal.fatal = true;
        throw fatal;
      }

      if (loaded > 0 && response.status === 200) {
        // Server ignored Range: restart cleanly rather than corrupting the file.
        chunks.length = 0;
        loaded = 0;
      }
      const contentRange = response.headers.get('content-range') || '';
      const rangeTotal = Number((contentRange.split('/')[1] || '').trim());
      const length = Number(response.headers.get('content-length')) || 0;
      total = rangeTotal || Number(response.headers.get('x-backup-size')) || (length ? loaded + length : total);

      if (!response.body || !response.body.getReader) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        chunks.push(buffer);
        loaded += buffer.byteLength;
      } else {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
          const speed = loaded / elapsed;
          onProgress({
            loaded,
            total,
            percent: total > 0 ? Math.min(100, (loaded / total) * 100) : 0,
            etaSeconds: speed > 0 && total > 0 ? Math.max(0, total - loaded) / speed : null,
            attempt,
          });
        }
      }

      if (total > 0 && loaded < total) {
        lastError = new Error('Connection closed early (' + loaded + ' of ' + total + ' bytes)');
        continue;
      }
      onProgress({ loaded, total: total || loaded, percent: 100, etaSeconds: 0, attempt });
      return new Blob(chunks, { type: 'application/octet-stream' });
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
  }
  throw new Error(
    'Download interrupted after ' + maxAttempts + ' attempts' +
    (lastError?.message ? ' (' + lastError.message + ')' : '') +
    '. The backup is saved in the History tab — you can download it from there.'
  );
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
  const {
    transfer,
    patchTransfer,
    minimize,
    maximize,
    toggleMinimize,
    dismiss,
    cancelBackup,
    startBackup,
  } = useBackupManager();

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
    void loadHistory();
  }, []);

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
          patchTransfer({
            active: percent < 100,
            visible: true,
            isMinimized: false,
            phase: 'Downloading stored backup…',
            percent,
            processed: loaded,
            total,
            detail: total ? formatBytes(loaded) + ' / ' + formatBytes(total) : formatBytes(loaded) + ' downloaded',
          });
        },
      });
      downloadBlob(response.data, record.filename || ('onenexa-backup-' + record.id + '.onenexa'));
      patchTransfer({
        active: false,
        visible: true,
        phase: 'Complete',
        percent: 100,
        etaSeconds: 0,
        processed: record.file_size_bytes || 0,
        total: record.file_size_bytes || 0,
        detail: 'Historical backup downloaded successfully.',
      });
      toast.success('Historical backup downloaded.');
    } catch (error) {
      patchTransfer({ active: false, phase: 'Failed', etaSeconds: null });
      toast.error(await getBackupErrorMessage(error));
    }
  };

  const deleteHistoryBackup = async (record) => {
    if (!record?.id) return;
    if (!window.confirm('Delete this backup permanently? This removes the history record and the stored backup data. This cannot be undone.')) return;
    setBusy(true);
    try {
      await api.delete('/app-backup/history/' + encodeURIComponent(record.id));
      setHistory((current) => current.filter((item) => item.id !== record.id));
      toast.success('Backup history record and stored backup data deleted.');
    } catch (error) {
      toast.error(await getBackupErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

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
      startBackup({
        password,
        mode,
        collections: customSelection,
      }).catch((err) => {
        toast.error(err?.message || 'Backup failed');
      }).finally(() => {
        void loadHistory();
      });
      setTimeout(() => setBusy(false), 500);
    } catch (error) {
      toast.error(error?.message || 'Backup failed');
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (!restoreFile) return toast.error('Choose a .onenexa backup file, or a legacy .taskosphere backup file.');
    if (restorePassword.length < 8) return toast.error('Enter the backup password.');
    if (restoreConfirm !== 'RESTORE') return toast.error('Type RESTORE exactly to confirm.');
    if (!window.confirm('Restore will replace the application data covered by this backup. Continue?')) return;

    setBusy(true);
    patchTransfer({
      active: true,
      visible: true,
      isMinimized: false,
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
        onUploadProgress: (event) => {
          const loaded = Number(event.loaded || 0);
          const total = Number(event.total || restoreFile.size || 0);
          const elapsed = Math.max(0.001, (performance.now() - uploadStarted) / 1000);
          const speed = loaded / elapsed;
          const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
          const remaining = total > 0 ? Math.max(0, total - loaded) : 0;

          patchTransfer({
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

      patchTransfer({
        active: false,
        visible: true,
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
      toast.error(error?.response?.data?.detail || 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  const card = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const heading = isDark ? 'text-slate-100' : 'text-slate-800';
  const input = 'w-full rounded-none border px-3 py-2.5 text-sm outline-none ' + (isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-800');
  const modeButton = (value) => 'text-left rounded-none border p-3 transition-all ' + (mode === value ? 'border-blue-500 ring-2 ring-blue-500/20' : (isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'));
  const radio = (value) => 'h-3.5 w-3.5 rounded-full border-2 ' + (mode === value ? 'border-blue-500 bg-blue-500' : 'border-slate-400');

  return (
    <div className="space-y-4 w-full min-w-0">
      <div className="rounded-none overflow-hidden border border-blue-900/20 shadow-sm" style={{ background: 'linear-gradient(135deg,#0D3B66 0%,#1F6FB2 100%)' }}>
        <div className="px-5 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-11 w-11 rounded-none bg-white/15 flex items-center justify-center shrink-0"><Archive className="h-5 w-5 text-white" /></div>
            <div>
              <h1 className="text-xl font-bold text-white">Backup &amp; Restore</h1>
              <p className="text-xs text-white/70 mt-0.5">Portable encrypted backup of your complete Taskosphere application</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/tasko-commercial-backup-update.zip"
              download="tasko-commercial-backup-update.zip"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-none bg-white/10 hover:bg-white/20 text-white text-xs font-semibold"
              title="Download updated files for tasko-commercial repository"
            >
              <Download className="h-3.5 w-3.5" /> Download Commercial Files (.zip)
            </a>
            <button
              type="button"
              onClick={loadInfo}
              disabled={loadingInfo || busy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-none bg-white/10 hover:bg-white/20 text-white text-xs font-semibold disabled:opacity-50"
            >
              <RefreshCw className={loadingInfo ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh
            </button>
          </div>
        </div>
      </div>

      <div className={'rounded-none border p-1 ' + card}>
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
              className={'flex items-center justify-center gap-2 rounded-none px-4 py-2.5 text-sm font-bold transition-all border-b-2 ' + (
                activeTab === value
                  ? (isDark ? 'bg-slate-700/80 text-white border-blue-500' : 'bg-blue-50 text-blue-700 border-blue-600')
                  : (isDark ? 'text-slate-400 border-transparent hover:bg-slate-700/40' : 'text-slate-500 border-transparent hover:bg-slate-50')
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {value === 'history' && history.length > 0 && <span className="ml-1 rounded-none bg-blue-600 px-2 py-0.5 text-[10px] font-extrabold text-white">{history.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {transfer.phase && (
        transfer.isMinimized ? (
          /* Minimized Compact Card */
          <div className={'rounded-2xl border p-3.5 flex items-center justify-between gap-4 transition-all ' + card}>
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <HardDriveDownload className="h-4 w-4 animate-pulse" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={'text-xs font-bold truncate ' + heading}>{transfer.phase}</span>
                  <span className="text-xs font-extrabold text-blue-600 dark:text-blue-400">
                    {Math.min(100, Math.max(0, Number(transfer.percent || 0))).toFixed(1)}%
                  </span>
                  <span className={'text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 dark:bg-slate-700 ' + muted}>
                    Minimized · Running in background
                  </span>
                </div>
                <p className={'text-[11px] truncate ' + muted}>
                  {transfer.detail || 'Backup is progressing safely… You can continue using the application.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <div className="w-28 sm:w-44 h-2 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700 hidden sm:block">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, Number(transfer.percent || 0)))}%` }}
                />
              </div>
              <button
                type="button"
                onClick={maximize}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-700/60 text-xs font-bold transition-all shadow-sm"
                title="Expand backup view"
              >
                <Maximize2 className="h-3.5 w-3.5" /> Expand
              </button>
              <button
                type="button"
                onClick={transfer.active ? cancelBackup : dismiss}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                title={transfer.active ? "Cancel backup operation" : "Dismiss"}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          /* Full Expanded Card */
          <div className={'rounded-2xl border p-4 sm:p-5 transition-all ' + card}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className={'text-sm font-bold ' + heading}>{transfer.phase}</p>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold uppercase">
                    {transfer.mode || 'full'} backup
                  </span>
                </div>
                <p className={'text-[11px] mt-1 ' + muted}>{transfer.detail || 'Working…'}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right mr-1">
                  <p className="text-lg font-extrabold text-blue-600 dark:text-blue-400">
                    {Math.min(100, Math.max(0, Number(transfer.percent || 0))).toFixed(2)}%
                  </p>
                  <p className={'text-[10px] ' + muted}>
                    {transfer.percent >= 100 ? 'Complete' : formatEta(transfer.etaSeconds)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={minimize}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60 text-xs font-semibold transition-all"
                  title="Minimize backup card so you can work while backup runs"
                >
                  <Minimize2 className="h-3.5 w-3.5" /> Minimize
                </button>
                {transfer.active && (
                  <button
                    type="button"
                    onClick={cancelBackup}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-red-200 dark:border-red-900/40 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 text-xs font-semibold transition-all"
                    title="Cancel backup operation"
                  >
                    <X className="h-3.5 w-3.5" /> Cancel
                  </button>
                )}
                {!transfer.active && (
                  <button
                    type="button"
                    onClick={dismiss}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    title="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3.5 h-2.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
                style={{ width: Math.min(100, Math.max(0, Number(transfer.percent || 0))) + '%' }}
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between text-[11px]">
              <span className={muted}>
                {transfer.total > 0
                  ? (['queued', 'preparing', 'creating'].includes(String(transfer.phase || '').toLowerCase())
                      ? `${Number(transfer.processed || 0).toLocaleString('en-IN')} / ${Number(transfer.total || 0).toLocaleString('en-IN')} documents`
                      : `${formatBytes(transfer.processed)} / ${formatBytes(transfer.total)}`)
                  : 'Processing application data…'}
              </span>
              <span className={'text-[10px] italic ' + muted}>
                💡 You can minimize this card or use other pages — backup continues in background
              </span>
            </div>
          </div>
        )
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><Database className="h-4 w-4 text-blue-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted}>MongoDB</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>Included automatically</p>
          <p className={'mt-1 text-xs ' + muted}>Application collections are captured in BSON-preserving Extended JSON.</p>
        </div>
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-emerald-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted}>Security</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>AES-256-GCM encrypted</p>
          <p className={'mt-1 text-xs ' + muted}>Password protected. Live sessions and reset tokens are never exported.</p>
        </div>
        <div className={'rounded-2xl border p-4 ' + card}>
          <div className="flex items-center gap-2"><Users className="h-4 w-4 text-violet-500" /><span className={'text-xs font-bold uppercase tracking-wider ' + muted} >Application</span></div>
          <p className={'mt-2 text-sm font-semibold ' + heading}>Standalone application</p>
          <p className={'mt-1 text-xs ' + muted}>{info?.user_count ?? '—'} users · restore preserves the active administrator</p>
        </div>
      </div>

      {activeTab === 'backup' && (
      <div className={'rounded-2xl border p-5 ' + card}>
        <div className="flex items-start gap-3">
          <HardDriveDownload className="h-5 w-5 text-blue-500 mt-0.5" />
          <div className="flex-1"><h2 className={'font-bold ' + heading}>Create Backup</h2><p className={'text-xs mt-1 ' + muted}>Full backup is the recommended one-click backup/DR format. Custom mode lets you export only selected modules or MongoDB collections.</p></div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-5">
          {[
            ['full', 'Full Application', 'All application MongoDB data, users, settings, permissions and application collections'],
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
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={createBackup}
              disabled={busy || loadingInfo || transfer.active}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 w-full sm:w-auto"
            >
              <Download className="h-4 w-4" />
              {busy ? 'Starting…' : transfer.active ? 'Backup in Progress…' : mode === 'full' ? 'Download Full Backup' : 'Download Custom Backup'}
            </button>
            {transfer.active && (
              <button
                type="button"
                onClick={cancelBackup}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-red-300 dark:border-red-800 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 text-xs font-bold transition-all w-full sm:w-auto"
                title="Cancel ongoing backup"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      )}

      {activeTab === 'restore' && (
      <div className={'rounded-2xl border p-5 ' + card}>
        <div className="flex items-start gap-3"><RotateCcw className="h-5 w-5 text-amber-500 mt-0.5" /><div><h2 className={'font-bold ' + heading}>Restore Backup</h2><p className={'text-xs mt-1 ' + muted}>Restore the application from an encrypted backup. The current administrator's live authentication credentials are preserved.</p></div></div>
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
            <div className="flex items-start gap-3">
              <History className="h-5 w-5 text-blue-500 mt-0.5" />
              <div>
                <h2 className={'font-bold ' + heading}>Backup History</h2>
                <p className={'text-xs mt-1 ' + muted}>Every completed backup is stored as an encrypted artifact. Deleting a record permanently removes its history entry and stored backup data.</p>
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
              <table className="w-full min-w-[820px] text-left">
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
                      <td className={'px-3 py-3 text-xs font-semibold ' + heading}>{record.mode || 'full'}</td>
                      <td className={'px-3 py-3 text-xs ' + muted}>{record.collection_count || 0}</td>
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

      <div className={'rounded-2xl border p-4 ' + card}><div className="flex items-start gap-2.5"><ShieldCheck className="h-4 w-4 text-emerald-500 mt-0.5" /><div><p className={'text-xs font-bold ' + heading}>Recommended backup policy</p><p className={'text-[11px] mt-1 leading-relaxed ' + muted}>Keep at least one full encrypted backup outside the application server. The .onenexa file is portable and includes MongoDB data automatically; legacy .taskosphere files remain accepted for migration; because hosted app disks can be ephemeral, long-term retention should use your MongoDB provider/object-storage backup facility rather than relying on local server files.</p></div></div></div>
    </div>
  );
}
