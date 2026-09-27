import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileArchive, FolderUp, Loader2, Minimize2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { useROCDumpUploads } from '@/contexts/ROCDumpUploadContext.jsx';

const ACCEPTED_EXT = '.pdf,.xlsx,.xlsm,.xls,.csv,.docx,.doc,.zip,.rar';

const CLASSIFICATION_OPTIONS = [
  ['share_transfer', 'Share transfer'],
  ['director_change', 'Director change'],
  ['director_resignation', 'Director resignation'],
  ['share_allotment', 'Share allotment'],
  ['financial', 'Financial (AOC-4)'],
  ['annual_return', 'Annual return'],
  ['loan_deposit', 'Loan / deposit'],
  ['charge', 'Charge'],
  ['auditor', 'Auditor'],
  ['registered_office', 'Registered office'],
  ['resolution', 'Resolution'],
  ['director_kyc', 'Director KYC'],
  ['incorporation', 'Incorporation'],
  ['other', 'Other'],
];

function mergeFiles(existing, incoming) {
  const seen = new Set(existing.map((f) => `${f.webkitRelativePath || f.name}:${f.size}`));
  const merged = [...existing];
  incoming.forEach((file) => {
    const key = `${file.webkitRelativePath || file.name}:${file.size}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(file);
    }
  });
  return merged;
}

async function parseBlobError(err) {
  try {
    const blob = err?.response?.data;
    if (blob instanceof Blob) {
      const body = await blob.text();
      const json = JSON.parse(body);
      return json.detail || 'Something went wrong';
    }
  } catch { /* fall through */ }
  return err?.response?.data?.detail || 'Something went wrong';
}

function triggerBlobDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

function ROCFormsDumpTab({ company, isDark, text, muted }) {
  const [files, setFiles] = useState([]);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [minimized, setMinimized] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const { jobs, queueUpload } = useROCDumpUploads();
  const activeUploadJob = jobs.find((job) => (
    job.companyId === company?.id &&
    ['queued', 'uploading', 'processing'].includes(job.status)
  ));
  const busy = !!activeUploadJob || rebuilding;
  const [correctingId, setCorrectingId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const addFiles = useCallback((incoming) => {
    setFiles((prev) => mergeFiles(prev, Array.from(incoming || [])));
  }, []);

  const readDroppedEntries = useCallback(async (items) => {
    const output = [];

    const readFileEntry = (entry, relativePath) => new Promise((resolve) => {
      entry.file((file) => {
        try {
          Object.defineProperty(file, 'rocRelativePath', {
            value: relativePath,
            configurable: true,
          });
        } catch {
          // The File remains usable even if a browser refuses the custom path.
        }
        output.push(file);
        resolve();
      }, () => resolve());
    });

    const readDirectoryEntry = async (entry, parentPath = '') => {
      const directoryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const reader = entry.createReader();

      // Chromium may return only a batch (commonly 100 entries) from
      // readEntries(), so keep reading until the browser returns [].
      while (true) {
        const entries = await new Promise((resolve) => {
          reader.readEntries(resolve, () => resolve([]));
        });
        if (!entries.length) break;

        for (const child of entries) {
          if (child.isFile) {
            await readFileEntry(child, `${directoryPath}/${child.name}`);
          } else if (child.isDirectory) {
            await readDirectoryEntry(child, directoryPath);
          }
        }
      }
    };

    for (const item of Array.from(items || [])) {
      const getEntry = item?.webkitGetAsEntry || item?.getAsEntry;
      const entry = getEntry ? getEntry.call(item) : null;
      if (entry?.isFile) {
        await readFileEntry(entry, entry.name);
      } else if (entry?.isDirectory) {
        await readDirectoryEntry(entry);
      } else {
        const file = item?.getAsFile?.();
        if (file) output.push(file);
      }
    }

    return output;
  }, []);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    setDropActive(false);
    if (busy) return;
    const dropped = await readDroppedEntries(event.dataTransfer?.items || []);
    addFiles(dropped);
  }, [addFiles, busy, readDroppedEntries]);

  const appendFilesToForm = useCallback((form) => {
    files.forEach((file) => {
      const relativeName = file.rocRelativePath || file.webkitRelativePath || file.name;
      form.append('files', file, relativeName);
    });
  }, [files]);

  const load = useCallback(async () => {
    if (!company?.id) return;
    try {
      const [dump, summaryRes] = await Promise.all([
        api.get(`/roc-sphere/companies/${company.id}/roc-dump`),
        api.get(`/roc-sphere/companies/${company.id}/roc-dump/summary`),
      ]);
      setItems(dump.data?.items || []);
      setSummary(summaryRes.data || null);
    } catch (err) {
      toast.error(await parseBlobError(err) || 'Unable to load ROC Forms Dump');
    }
  }, [company?.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = (event) => {
      if (event.detail?.companyId === company?.id) {
        void load();
      }
    };
    window.addEventListener('roc-dump-completed', handler);
    return () => window.removeEventListener('roc-dump-completed', handler);
  }, [company?.id, load]);

  const upload = () => {
    if (!files.length || busy || !company?.id) return;
    queueUpload({
      companyId: company.id,
      companyName: company.company_name,
      files,
    });
    setFiles([]);
    setPickerOpen(false);
    setMinimized(true);
  };

  const rebuild = async () => {
    if (busy) return;
    setRebuilding(true);
    try {
      await api.post(`/roc-sphere/companies/${company.id}/roc-dump/rebuild-summary`);
      await load();
      toast.success('Company Summary rebuilt');
    } catch (err) {
      toast.error(await parseBlobError(err) || 'Summary rebuild failed');
    } finally {
      setRebuilding(false);
    }
  };

  const download = async (item) => {
    try {
      const res = await api.get(
        `/roc-sphere/companies/${company.id}/roc-dump/${item.id}/download`,
        { responseType: 'blob' },
      );
      triggerBlobDownload(res.data, item.filename || 'ROC_Form');
    } catch (err) {
      toast.error(await parseBlobError(err) || 'Unable to download ROC form');
    }
  };

  const review = async (item, status) => {
    try {
      const form = new FormData();
      form.append('review_status', status);
      await api.post(`/roc-sphere/companies/${company.id}/roc-dump/${item.id}/review`, form);
      await load();
      toast.success(status === 'VERIFIED'
        ? 'Filing verified — this pattern is now reinforced for future classification'
        : `Filing marked ${status}`);
    } catch (err) {
      toast.error(await parseBlobError(err) || 'Review update failed');
    }
  };

  const correctClassification = async (item, classification) => {
    if (!classification || classification === item.classification) {
      setCorrectingId(null);
      return;
    }
    try {
      const form = new FormData();
      form.append('classification', classification);
      await api.post(`/roc-sphere/companies/${company.id}/roc-dump/${item.id}/correct-classification`, form);
      await load();
      toast.success('Correction saved — the classifier learns from this for future uploads');
    } catch (err) {
      toast.error(await parseBlobError(err) || 'Correction failed');
    } finally {
      setCorrectingId(null);
    }
  };

  const card = isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200';

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border ${card} overflow-hidden`}>
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <div>
            <h3 className={`text-sm font-semibold ${text}`}>ROC Forms Dump</h3>
            <p className={`text-[11px] mt-0.5 ${muted}`}>Historical ROC forms, extraction evidence and Company Summary.</p>
          </div>
          <button type="button" onClick={() => setMinimized(true)}
            className={`p-1.5 rounded-md ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}
            title="Minimize ROC Forms Dump">
            <Minimize2 size={16} className={text} />
          </button>
        </div>

        {!minimized && (
          <div className="p-4 space-y-4">
            <div className={`rounded-lg border p-3 ${isDark ? 'border-blue-800 bg-blue-950/20' : 'border-blue-200 bg-blue-50'}`}>
              <p className={`text-xs ${text}`}>
                Upload the company's ROC forms from incorporation to date using one chooser — individual files,
                multiple files, a whole folder, or ZIP/RAR archives. PDFs, Excel/CSV sheets and Word (.docx) documents are all read
                and interpreted automatically; files inside ZIPs/RARs and folders (including nested subfolders)
                are extracted and processed the same way. Every filing is retained, classified and
                extracted, and marked for review when the source can't be read confidently. Verifying a
                filing (or correcting a wrong classification) feeds a learned pattern table that improves
                future auto-classification — the archive gets more accurate the more it's used.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_EXT}
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = '';
                  setPickerOpen(false);
                }}
                className="hidden" />
              <input ref={folderInputRef} type="file" multiple
                webkitdirectory="" directory="" mozdirectory=""
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = '';
                  setPickerOpen(false);
                }}
                className="hidden" />

              <div className="relative">
                <button type="button" disabled={busy} onClick={() => setPickerOpen((value) => !value)}
                  className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                  <FolderUp size={13} /> Choose files / folders
                </button>
                {pickerOpen && (
                  <div className={`absolute left-0 top-full mt-1 z-40 w-56 rounded-lg border shadow-lg p-1 ${card}`}>
                    <button type="button" onClick={() => fileInputRef.current?.click()}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-semibold flex items-center gap-2 ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
                      <Upload size={13} /> Files / ZIP / RAR archives
                    </button>
                    <button type="button" onClick={() => folderInputRef.current?.click()}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-semibold flex items-center gap-2 ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
                      <FolderUp size={13} /> Entire folder
                    </button>
                  </div>
                )}
              </div>

              {files.length > 0 && (
                <span className={`text-[11px] ${muted}`}>{files.length} file(s) selected</span>
              )}
              <button type="button" disabled={busy || !files.length} onClick={upload}
                className="px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {busy ? 'Processing…' : `Upload${files.length ? ` (${files.length})` : ''}`}
              </button>
              {files.length > 0 && (
                <button type="button" disabled={busy} onClick={() => setFiles([])}
                  className="px-2 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700">
                  Clear
                </button>
              )}
              <button type="button" disabled={busy} onClick={rebuild}
                className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold disabled:opacity-50">
                Rebuild Summary
              </button>
            </div>
              <div
                onDragOver={(event) => { event.preventDefault(); if (!busy) setDropActive(true); }}
                onDragLeave={() => setDropActive(false)}
                onDrop={handleDrop}
                className={`rounded-lg border-2 border-dashed p-3 text-xs transition ${dropActive
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : isDark ? 'border-slate-600 bg-slate-900/20 text-slate-300' : 'border-slate-300 bg-slate-50 text-slate-600'}`}>
                <div className="flex items-center gap-2">
                  <FileArchive size={15} />
                  <span>Drag and drop files, ZIPs, RARs, or folders here. Mixed files, multiple folders, and nested ZIP/RAR archives are supported in one upload.</span>
                  {files.length > 0 && (
                    <button type="button" onClick={() => setFiles([])}
                      className="ml-auto p-1 rounded hover:bg-black/5" title="Clear selected files">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {[
                  ['Forms', items.length],
                  ['Directors / KMP', summary.directors_and_kmp_history?.length || 0],
                  ['Transfers', summary.share_transfer_history?.length || 0],
                  ['Financial records', summary.financial_history?.length || 0],
                  ['Loans / Charges', summary.loans_and_charges_history?.length || 0],
                ].map(([label, value]) => (
                  <div key={label} className={`rounded-lg border p-2.5 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-slate-50'}`}>
                    <div className={`text-base font-bold ${text}`}>{value}</div>
                    <div className={`text-[10px] ${muted}`}>{label}</div>
                  </div>
                ))}
              </div>
            )}

            <div className={`rounded-lg border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
              <div className={`px-3 py-2 text-xs font-semibold ${isDark ? 'bg-slate-900/60 text-slate-200' : 'bg-slate-50 text-slate-700'}`}>
                ROC Forms Inventory
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className={isDark ? 'bg-slate-900/50' : 'bg-slate-50'}>
                      <th className="text-left px-3 py-2">Form</th>
                      <th className="text-left px-3 py-2">File</th>
                      <th className="text-left px-3 py-2">FY</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Confidence</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                        <td className={`px-3 py-2 font-semibold ${text}`}>{item.form_number || 'UNKNOWN'}</td>
                        <td className={`px-3 py-2 max-w-[280px] truncate ${muted}`} title={item.filename}>{item.filename}</td>
                        <td className={`px-3 py-2 ${muted}`}>{item.metadata?.financial_year || '—'}</td>
                        <td className={`px-3 py-2 ${muted}`}>{item.review?.status || item.status}</td>
                        <td className={`px-3 py-2 ${muted}`}>
                          {Math.round((item.confidence || 0) * 100)}%
                          {item.classified_by_learning && (
                            <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-purple-100 text-purple-700" title="Classified from learned reviewer patterns, not a fixed rule">
                              learned
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button type="button" onClick={() => download(item)} className="px-2 py-1 rounded border border-slate-300 mr-1">
                            <Download size={12} className="inline" />
                          </button>
                          <button type="button" onClick={() => review(item, 'VERIFIED')} className="px-2 py-1 rounded bg-emerald-600 text-white text-[11px] mr-1">
                            Verify
                          </button>
                          <button type="button" onClick={() => review(item, 'NEEDS_REVIEW')} className="px-2 py-1 rounded bg-amber-500 text-white text-[11px] mr-1">
                            Review
                          </button>
                          {correctingId === item.id ? (
                            <select autoFocus defaultValue={item.classification || 'other'}
                              onBlur={(e) => correctClassification(item, e.target.value)}
                              onChange={(e) => correctClassification(item, e.target.value)}
                              className="px-1 py-1 rounded border border-slate-300 text-[11px]">
                              {CLASSIFICATION_OPTIONS.map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                          ) : (
                            <button type="button" onClick={() => setCorrectingId(item.id)}
                              className="px-2 py-1 rounded border border-slate-300 text-[11px]"
                              title="Correct classification — this trains future auto-classification">
                              Fix type
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!items.length && (
                      <tr><td colSpan={6} className={`px-3 py-8 text-center ${muted}`}>No ROC forms dumped yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>


    </div>
  );
}


export default ROCFormsDumpTab;
