import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDriveDownload,
  CheckCircle2,
  AlertCircle,
  Minimize2,
  Maximize2,
  X,
  ExternalLink,
  Download,
  Loader2,
} from 'lucide-react';
import { useBackupManager, formatEta, formatBytes, downloadBlob } from '@/contexts/BackupContext';

export default function BackupWidget() {
  const { transfer, minimize, maximize, dismiss, cancelBackup, toggleMinimize } = useBackupManager();
  const location = useLocation();
  const navigate = useNavigate();

  // If there is no active or recently completed backup transfer, render nothing
  if (!transfer.visible || !transfer.phase) {
    return null;
  }

  const isBackupPage = location.pathname === '/settings/backup';
  // If the user is on the backup page AND the card is expanded there, we don't need to duplicate the full floating card
  if (isBackupPage && !transfer.isMinimized) {
    return null;
  }

  const pct = Math.min(100, Math.max(0, Number(transfer.percent || 0)));
  const isFinished = !transfer.active && (transfer.percent >= 100 || transfer.phase === 'Complete');
  const isError = transfer.phase === 'Failed';

  const handleDownloadNow = () => {
    if (transfer.downloadBlobInstance) {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(transfer.downloadBlobInstance, `onenexa-backup-${timestamp}.onenexa`);
    } else if (transfer.downloadUrl) {
      window.open(transfer.downloadUrl, '_blank');
    }
  };

  const handleNavigateToBackupPage = () => {
    navigate('/settings/backup');
    maximize();
  };

  return (
    <AnimatePresence>
      <div
        className="fixed z-[75] flex flex-col items-end"
        style={{ right: 20, bottom: 20 }}
      >
        {transfer.isMinimized ? (
          /* Minimized pill floating button */
          <motion.div
            initial={{ scale: 0.8, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.8, opacity: 0, y: 20 }}
            className="flex items-center gap-3 px-3.5 py-2.5 rounded-full shadow-2xl border border-blue-500/30 bg-slate-900 text-white cursor-pointer select-none hover:bg-slate-800 transition-colors"
            onClick={maximize}
            title="Click to expand backup card"
          >
            {/* Progress ring / icon */}
            <div className="relative w-8 h-8 flex items-center justify-center shrink-0">
              <svg width="32" height="32" viewBox="0 0 32 32">
                <circle
                  cx="16"
                  cy="16"
                  r="13"
                  fill="none"
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth="2.5"
                />
                <circle
                  cx="16"
                  cy="16"
                  r="13"
                  fill="none"
                  stroke={isFinished ? '#10B981' : isError ? '#EF4444' : '#3B82F6'}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${(pct / 100) * 81.68} 81.68`}
                  transform="rotate(-90 16 16)"
                  style={{ transition: 'stroke-dasharray 0.3s' }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-[10px] font-extrabold text-blue-400">
                {isFinished ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : isError ? (
                  <AlertCircle className="h-4 w-4 text-red-400" />
                ) : (
                  `${Math.round(pct)}%`
                )}
              </div>
            </div>

            <div className="flex flex-col min-w-0 max-w-[190px]">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold truncate">
                  {isFinished ? 'Backup Ready' : isError ? 'Backup Failed' : 'Backup in Progress'}
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-500/20 text-blue-300 font-semibold uppercase">
                  {transfer.mode || 'full'}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 truncate mt-0.5">
                {transfer.detail || transfer.phase || 'Working…'}
              </span>
            </div>

            <div className="flex items-center gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={maximize}
                className="p-1 rounded-md hover:bg-slate-700 text-slate-300 hover:text-white"
                title="Expand backup view"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={transfer.active ? cancelBackup : dismiss}
                className="p-1 rounded-md hover:bg-slate-700 text-slate-400 hover:text-white"
                title={transfer.active ? 'Cancel backup' : 'Dismiss'}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        ) : (
          /* Expanded floating card */
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 30 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 30 }}
            className="w-84 sm:w-96 rounded-2xl shadow-2xl border border-slate-700/80 bg-slate-900 text-white overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-slate-800/80 border-b border-slate-700/60">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-lg bg-blue-600/30 text-blue-400 flex items-center justify-center shrink-0">
                  <HardDriveDownload className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs font-bold truncate">Application Backup</h4>
                  <p className="text-[10px] text-slate-400">
                    {transfer.mode === 'full' ? 'Full Archive' : 'Custom Archive'} · Running in background
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={minimize}
                  className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                  title="Minimize card to pill"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={transfer.active ? cancelBackup : dismiss}
                  className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                  title={transfer.active ? 'Cancel backup' : 'Close widget'}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">{transfer.phase}</span>
                <span className="font-extrabold text-blue-400">{pct.toFixed(1)}%</span>
              </div>

              {/* Progress bar */}
              <div className="h-2 rounded-full overflow-hidden bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isFinished ? 'bg-emerald-500' : isError ? 'bg-red-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span className="truncate max-w-[200px]">{transfer.detail || 'Working…'}</span>
                <span>{isFinished ? 'Complete' : formatEta(transfer.etaSeconds)}</span>
              </div>

              {transfer.total > 0 && (
                <div className="text-[10px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-800">
                  <span>Processed:</span>
                  <span>
                    {['queued', 'preparing', 'creating'].includes(String(transfer.phase || '').toLowerCase())
                      ? `${Number(transfer.processed || 0).toLocaleString()} / ${Number(transfer.total || 0).toLocaleString()} docs`
                      : `${formatBytes(transfer.processed)} / ${formatBytes(transfer.total)}`}
                  </span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 pt-1">
                {!isBackupPage && (
                  <button
                    type="button"
                    onClick={handleNavigateToBackupPage}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs font-semibold transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View in Backup Page
                  </button>
                )}

                {isFinished && (
                  <button
                    type="button"
                    onClick={handleDownloadNow}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-md transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" /> Download Archive
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </AnimatePresence>
  );
}
