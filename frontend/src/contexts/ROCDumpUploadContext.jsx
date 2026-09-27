import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import api from '@/lib/api.js';

const Ctx = createContext(null);
const STORAGE_KEY = 'taskosphere:rocDumpUploadQueue:v1';
const MAX_HISTORY = 8;

function loadPersisted() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_HISTORY).map((job) => (
      ['queued', 'uploading', 'processing'].includes(job.status)
        ? { ...job, status: 'interrupted', message: 'Browser session ended before this upload completed. Please upload the files again.' }
        : job
    ));
  } catch {
    return [];
  }
}

function persist(jobs) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.map(({ files, ...job }) => job)));
  } catch {
    // File objects are intentionally never persisted.
  }
}

function errorMessage(err) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg || JSON.stringify(item)).join(' | ');
  return err?.message || 'ROC Forms Dump upload failed';
}

function createJobId() {
  return \`roc-dump-\${Date.now()}-\${Math.random().toString(36).slice(2, 10)}\`;
}

export function ROCDumpUploadProvider({ children }) {
  const [jobs, setJobs] = useState(loadPersisted);
  const jobsRef = useRef(jobs);
  const workersRef = useRef(new Set());

  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  useEffect(() => { persist(jobs); }, [jobs]);

  const updateJob = useCallback((id, patch) => {
    setJobs((prev) => prev.map((job) => (
      job.id === id
        ? { ...job, ...(typeof patch === 'function' ? patch(job) : patch) }
        : job
    )));
  }, []);

  const runJob = useCallback(async (job) => {
    if (!job?.id || workersRef.current.has(job.id)) return;
    workersRef.current.add(job.id);

    const totalBytes = job.files.reduce((sum, file) => sum + (file.size || 0), 0);
    updateJob(job.id, {
      status: 'uploading',
      progress: 0,
      loadedBytes: 0,
      totalBytes,
      startedAt: Date.now(),
      message: 'Uploading files to ROC Sphere…',
    });

    try {
      const form = new FormData();
      job.files.forEach((file) => {
        const relativeName = file.rocRelativePath || file.webkitRelativePath || file.name;
        form.append('files', file, relativeName);
      });

      const { data } = await api.post(
        \`/roc-sphere/companies/\${job.companyId}/roc-dump/upload\`,
        form,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (event) => {
            const total = event.total || totalBytes || 1;
            const loaded = Math.min(event.loaded || 0, total);
            const progress = Math.min(99, Math.round((loaded / total) * 100));
            updateJob(job.id, {
              status: progress >= 99 ? 'processing' : 'uploading',
              progress,
              loadedBytes: loaded,
              totalBytes: total,
              message: progress >= 99
                ? 'Upload received. Server-side extraction and classification are continuing…'
                : 'Uploading files to ROC Sphere…',
            });
          },
        },
      );

      updateJob(job.id, {
        status: 'done',
        progress: 100,
        loadedBytes: totalBytes,
        finishedAt: Date.now(),
        result: data || null,
        message: data?.message || 'ROC Forms Dump processed successfully.',
      });
      toast.success('ROC Forms Dump processed and Company Summary updated');
    } catch (err) {
      const message = errorMessage(err);
      updateJob(job.id, {
        status: 'error',
        finishedAt: Date.now(),
        message,
      });
      toast.error(message);
    } finally {
      workersRef.current.delete(job.id);
    }
  }, [updateJob]);

  // Keep ROC uploads conservative: only one large multipart request runs at a
  // time. Additional batches remain queued in the root provider and therefore
  // cannot overload the API when the user works across multiple companies.
  useEffect(() => {
    if (workersRef.current.size > 0) return;
    const next = jobs.find((job) => job.status === 'queued' && job.files?.length);
    if (next) void runJob(next);
  }, [jobs, runJob]);

  const queueUpload = useCallback(({ companyId, companyName, files }) => {
    if (!companyId || !files?.length) return null;

    const id = createJobId();
    const job = {
      id,
      companyId,
      companyName: companyName || 'Company',
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
      loadedBytes: 0,
      progress: 0,
      status: 'queued',
      message: 'Waiting to start…',
      createdAt: Date.now(),
      files,
      result: null,
    };

    setJobs((prev) => [...prev.filter((item) => item.status !== 'done'), job].slice(-MAX_HISTORY));
    return id;
  }, [runJob]);

  const retryJob = useCallback((id) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job?.files?.length) {
      toast.error('This upload cannot be retried after a full page reload. Please select the files again.');
      return;
    }
    updateJob(id, {
      status: 'queued',
      progress: 0,
      loadedBytes: 0,
      finishedAt: null,
      message: 'Queued for retry…',
    });
  }, [updateJob]);

  const dismissJob = useCallback((id) => {
    setJobs((prev) => prev.filter((job) => job.id !== id));
  }, []);

  return (
    <Ctx.Provider value={{ jobs, queueUpload, retryJob, dismissJob }}>
      {children}
    </Ctx.Provider>
  );
}

export function useROCDumpUploads() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return { jobs: [], queueUpload: () => null, retryJob: () => {}, dismissJob: () => {} };
  }
  return ctx;
}
