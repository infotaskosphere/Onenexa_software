import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect
} from 'react';
import { toast } from 'sonner';
import api, { BASE_URL, getToken } from '@/lib/api';

const BackupContext = createContext(null);

const BACKUP_RETRY_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function formatBytes(value) {
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

export function formatEta(seconds) {
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

function normalizeBackupDetail(detail) {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return String(item);
        const field = Array.isArray(item.loc) && item.loc.length ? String(item.loc[item.loc.length - 1]) : 'field';
        return item.msg ? field + ': ' + item.msg : item.message || JSON.stringify(item);
      })
      .filter(Boolean);
    if (messages.length) return messages.join(' · ');
  }
  if (detail && typeof detail === 'object') {
    return detail.msg || detail.message || JSON.stringify(detail);
  }
  return '';
}

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
        } catch { /* ignore non-JSON */ }
        const fatal = new Error(detail || 'Backup download failed (' + response.status + ')');
        fatal.fatal = true;
        throw fatal;
      }

      if (loaded > 0 && response.status === 200) {
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

  throw new Error('Download interrupted after ' + maxAttempts + ' attempts. The backup is safely saved in History.');
}

const initialTransferState = {
  active: false,
  visible: false,
  isMinimized: false,
  phase: '',
  percent: 0,
  etaSeconds: null,
  processed: 0,
  total: 0,
  detail: '',
  mode: 'full',
  progressId: null,
  historyId: null,
  downloadUrl: null,
  downloadReady: false,
  downloadBlobInstance: null,
};

export function BackupProvider({ children }) {
  const [transfer, setTransfer] = useState(initialTransferState);
  const activePollRef = useRef(null);
  const stoppedRef = useRef(false);

  const patchTransfer = useCallback((p) => {
    setTransfer((prev) => ({ ...prev, ...p }));
  }, []);

  const minimize = useCallback(() => {
    setTransfer((prev) => ({ ...prev, isMinimized: true }));
  }, []);

  const maximize = useCallback(() => {
    setTransfer((prev) => ({ ...prev, isMinimized: false }));
  }, []);

  const toggleMinimize = useCallback(() => {
    setTransfer((prev) => ({ ...prev, isMinimized: !prev.isMinimized }));
  }, []);

  const dismiss = useCallback(() => {
    if (activePollRef.current) {
      clearTimeout(activePollRef.current);
      clearInterval(activePollRef.current);
      activePollRef.current = null;
    }
    stoppedRef.current = true;
    setTransfer(initialTransferState);
  }, []);

  const cancelBackup = useCallback(() => {
    if (activePollRef.current) {
      clearTimeout(activePollRef.current);
      clearInterval(activePollRef.current);
      activePollRef.current = null;
    }
    stoppedRef.current = true;
    setTransfer(initialTransferState);
    toast.info('Backup operation cancelled.');
  }, []);

  const startBackup = useCallback(async ({ password, mode = 'full', collections = [] }) => {
    if (transfer.active) {
      toast.warning('A backup operation is already in progress.');
      return;
    }

    stoppedRef.current = false;
    const progressId =
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'bk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    setTransfer({
      active: true,
      visible: true,
      isMinimized: false,
      phase: 'Preparing backup…',
      percent: 2,
      etaSeconds: null,
      processed: 0,
      total: 0,
      detail: 'Starting backup job…',
      mode,
      progressId,
      historyId: null,
      downloadUrl: null,
      downloadReady: false,
      downloadBlobInstance: null,
    });

    try {
      const form = new FormData();
      form.append('password', password);
      if (mode !== 'full' && collections.length > 0) {
        form.append('collections', collections.join(','));
      }

      const response = await fetch(BASE_URL + '/app-backup/create', {
        method: 'POST',
        headers: {
          Authorization: getToken() ? 'Bearer ' + getToken() : '',
          'X-Backup-Progress-ID': progressId,
        },
        body: form,
      });

      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        const msg = normalizeBackupDetail(data?.detail) || normalizeBackupDetail(data?.message) || 'Backup could not be started (' + response.status + ')';
        throw new Error(msg);
      }

      const serverProgressId = String(data?.progress_id || progressId);

      // Poll progress until ready
      const readyState = await new Promise((resolve, reject) => {
        let transientFailures = 0;

        const poll = async () => {
          if (stoppedRef.current) {
            resolve(null);
            return;
          }
          try {
            const { data: progress } = await api.get(
              '/app-backup/create/progress/' + encodeURIComponent(serverProgressId),
              { _skipReadyGate: true, _silent: true, timeout: 25000 }
            );

            if (stoppedRef.current) return;
            if (!progress) {
              activePollRef.current = setTimeout(poll, 1200);
              return;
            }
            const phase = progress.phase;

            setTransfer((current) => ({
              ...current,
              active: !['ready', 'error'].includes(phase),
              phase:
                phase === 'creating'
                  ? 'Creating encrypted backup…'
                  : phase === 'encrypting'
                  ? 'Encrypting backup…'
                  : phase === 'preparing'
                  ? 'Preparing backup…'
                  : phase === 'queued'
                  ? 'Backup queued…'
                  : phase === 'ready'
                  ? 'Backup ready. Starting download…'
                  : phase === 'storing'
                  ? 'Saving encrypted backup to history…'
                  : phase === 'error'
                  ? 'Failed'
                  : phase || current.phase,
              percent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : current.percent,
              etaSeconds: progress.eta_seconds ?? current.etaSeconds,
              processed: progress.processed_documents ?? progress.processed_bytes ?? current.processed,
              total: progress.total_documents ?? progress.total_bytes ?? current.total,
              detail:
                progress.error
                  ? progress.error
                  : progress.download_ready
                  ? 'Backup is ready for download.'
                  : progress.current_collection
                  ? 'Collection: ' + progress.current_collection
                  : phase === 'queued'
                  ? 'Waiting for backup worker to claim the job…'
                  : phase === 'preparing'
                  ? 'Preparing backup data and schemas…'
                  : phase === 'creating'
                  ? 'Exporting application collections…'
                  : phase === 'encrypting'
                  ? 'Encrypting with AES-256-GCM…'
                  : phase === 'storing'
                  ? 'Saving encrypted backup to history…'
                  : current.detail,
            }));

            if (phase === 'error') {
              throw new Error(progress.error || 'Backup creation failed on server.');
            }

            if (phase === 'ready' && progress.download_ready) {
              if (activePollRef.current) {
                clearTimeout(activePollRef.current);
                activePollRef.current = null;
              }
              resolve(progress);
              return;
            }
          } catch (err) {
            if (stoppedRef.current) {
              resolve(null);
              return;
            }

            const isTimeout =
              err?.code === 'ECONNABORTED' ||
              String(err?.message || '').toLowerCase().includes('timeout');
            const status = err?.response?.status;
            const isTransient =
              !err?.response ||
              isTimeout ||
              [408, 425, 429, 500, 502, 503, 504].includes(status);

            if (isTransient) {
              transientFailures += 1;
              if (transientFailures <= 120) {
                if (!stoppedRef.current) {
                  activePollRef.current = setTimeout(poll, 2000);
                }
                return;
              }
            }

            if (activePollRef.current) {
              clearTimeout(activePollRef.current);
              activePollRef.current = null;
            }
            reject(err);
            return;
          }

          if (!stoppedRef.current) {
            activePollRef.current = setTimeout(poll, 1200);
          }
        };

        // Start sequential polling loop
        activePollRef.current = setTimeout(poll, 100);
      });

      if (!readyState || stoppedRef.current) return;

      const downloadUrl = readyState?.history_id
        ? BASE_URL + '/app-backup/history/' + encodeURIComponent(readyState.history_id) + '/download'
        : BASE_URL + '/app-backup/create/download/' + encodeURIComponent(serverProgressId);

      setTransfer((curr) => ({
        ...curr,
        downloadReady: true,
        downloadUrl,
        historyId: readyState?.history_id || null,
        phase: 'Downloading backup…',
        percent: 0,
        etaSeconds: null,
        detail: 'Transferring encrypted backup to your device…',
      }));

      const backupBlob = await downloadBackupWithResume(
        downloadUrl,
        ({ loaded, total, percent, etaSeconds, attempt }) => {
          setTransfer((current) => ({
            ...current,
            active: true,
            phase: 'Downloading backup…',
            percent,
            etaSeconds,
            processed: loaded,
            total,
            detail:
              (total ? formatBytes(loaded) + ' / ' + formatBytes(total) : formatBytes(loaded) + ' downloaded') +
              (attempt > 0 ? ' · resumed after interruption' : ''),
          }));
        }
      );

      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = 'onenexa-backup-' + timestamp + '.onenexa';
      downloadBlob(backupBlob, filename);

      setTransfer((curr) => ({
        ...curr,
        active: false,
        phase: 'Complete',
        percent: 100,
        etaSeconds: 0,
        processed: backupBlob.size,
        total: backupBlob.size,
        downloadBlobInstance: backupBlob,
        detail: 'Backup completed and downloaded successfully.',
      }));

      toast.success(
        mode === 'full'
          ? 'Full application backup completed and downloaded.'
          : 'Custom backup completed and downloaded.'
      );
    } catch (err) {
      console.error('[Backup Manager] Error during backup:', err);
      setTransfer((curr) => ({
        ...curr,
        active: false,
        phase: 'Failed',
        etaSeconds: null,
        detail: err?.message || 'Backup failed',
      }));
      toast.error(err?.message || 'Backup failed');
    } finally {
      if (activePollRef.current) {
        clearTimeout(activePollRef.current);
        clearInterval(activePollRef.current);
        activePollRef.current = null;
      }
    }
  }, [transfer.active]);

  const value = {
    transfer,
    patchTransfer,
    minimize,
    maximize,
    toggleMinimize,
    dismiss,
    cancelBackup,
    startBackup,
  };

  return <BackupContext.Provider value={value}>{children}</BackupContext.Provider>;
}

export function useBackupManager() {
  const context = useContext(BackupContext);
  if (!context) {
    throw new Error('useBackupManager must be used within a BackupProvider');
  }
  return context;
}
export default BackupContext;
