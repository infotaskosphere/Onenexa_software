import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, FileArchive, Loader2, Maximize2, RotateCcw, UploadCloud, ListChecks, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useROCDumpUploads } from '@/contexts/ROCDumpUploadContext.jsx';

function formatBytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function ROCDumpUploadDock() {
  const { jobs, retryJob, dismissJob } = useROCDumpUploads();
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();

  const visible = jobs.filter((job) => (
    ['queued', 'uploading', 'processing', 'done', 'error', 'interrupted'].includes(job.status)
  ));
  if (!visible.length) return null;

  const activeCount = visible.filter((job) => ['queued', 'uploading', 'processing'].includes(job.status)).length;
  const openROC = () => navigate('/roc-sphere');

  return (
    <div className="fixed bottom-5 right-5 z-40">
      {collapsed ? (
        (() => {
          const total = visible.length;
          const done = visible.filter((job) => job.status === 'done').length;
          const errored = visible.filter((job) => job.status === 'error').length;
          const finished = done + errored;
          const interrupted = visible.filter((job) => job.status === 'interrupted').length;
          const pct = total ? Math.round((finished / total) * 100) : 0;
          const allDone = finished === total;
          const activeCompanies = new Set(
            visible
              .filter((job) => ['queued', 'uploading', 'processing'].includes(job.status))
              .map((job) => job.companyName || 'Company')
          );

          return (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="ml-auto flex items-center gap-3 rounded-full shadow-xl pl-2 pr-4 py-2 hover:brightness-110 transition"
              style={{ background: 'linear-gradient(135deg, #0D3B66 0%, #1F6FB2 100%)' }}
              title="Expand ROC upload status"
            >
              <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center flex-shrink-0">
                {allDone
                  ? <ListChecks className="h-4 w-4 text-white" />
                  : <UploadCloud className="h-4 w-4 text-white animate-pulse" />}
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-semibold text-white leading-none">
                  {allDone ? 'ROC uploads complete' : `ROC upload… ${pct}%`}
                </p>
                <p className="text-[10.5px] text-white/70 mt-1 whitespace-nowrap">
                  {finished}/{total} done
                  {activeCompanies.size > 1 && ` · ${activeCompanies.size} companies`}
                  {interrupted > 0 && ` · ${interrupted} interrupted`}
                  {allDone && ' · click to view'}
                </p>
              </div>
              <Maximize2 className="h-3.5 w-3.5 text-white/70 flex-shrink-0" />
            </button>
          );
        })()
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <FileArchive size={14} className="text-blue-600" />
              <span className="text-xs font-bold text-slate-700">ROC Forms Dump</span>
              {activeCount > 0 && <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-700">{activeCount} active</span>}
            </div>
            <button type="button" onClick={() => setCollapsed(true)} className="rounded-md p-1 text-slate-500 hover:bg-slate-200" title="Minimize progress dock">
              <ChevronDown size={14} />
            </button>
          </div>

          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {visible.slice(-5).map((job) => {
              const active = ['queued', 'uploading', 'processing'].includes(job.status);
              return (
                <div key={job.id} className="px-3.5 py-3">
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                      {active ? <Loader2 size={15} className="animate-spin" /> : job.status === 'done' ? <CheckCircle2 size={15} className="text-emerald-600" /> : <FileArchive size={15} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-800">{job.companyName}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {job.fileCount} file{job.fileCount === 1 ? '' : 's'} · {formatBytes(job.totalBytes)}
                      </p>
                      <p className="mt-1 text-[10px] text-slate-600">
                        {job.status === 'processing'
                          ? 'Server is extracting, classifying and rebuilding the Company Summary…'
                          : job.status === 'uploading'
                            ? `Uploading to backend · ${job.progress}%`
                            : job.status === 'queued'
                              ? 'Queued…'
                              : job.status === 'done'
                                ? 'Completed — Company Summary updated'
                                : job.status === 'interrupted'
                                  ? job.message
                                  : job.message}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {(job.status === 'error' || job.status === 'interrupted') && (
                        <button type="button" onClick={() => retryJob(job.id)} className="rounded-md p-1.5 text-blue-600 hover:bg-blue-50" title="Retry upload">
                          <RotateCcw size={13} />
                        </button>
                      )}
                      {active && (
                        <button
                          type="button"
                          onClick={() => setCollapsed(false)}
                          className="rounded-md p-1.5 text-blue-600 hover:bg-blue-50"
                          title="Expand ROC upload status"
                          aria-label="Expand ROC upload status"
                        >
                          <Maximize2 size={13} />
                        </button>
                      )}
                      {!active && (
                        <button type="button" onClick={() => dismissJob(job.id)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500" title="Dismiss">
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {active && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full bg-blue-600 transition-all duration-300"
                        style={{ width: `${job.status === 'processing' ? 100 : job.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
