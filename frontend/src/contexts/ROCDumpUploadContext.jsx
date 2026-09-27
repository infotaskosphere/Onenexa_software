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
  return `roc-dump-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      // Use bounded, resumable chunks instead of one large multipart request.
      // This is transparent to the single chooser and supports mixed files,
      // folders and ZIP/RAR archives without changing the UI.
      const CHUNK_SIZE = 8 * 1024 * 1024;
      const metadata = job.files.map((file, index) => ({
        index,
        filename: file.rocRelativePath || file.webkitRelativePath || file.name,
        size_bytes: file.size || 0,
        total_chunks: Math.max(1, Math.ceil((file.size || 0) / CHUNK_SIZE)),
      }));

      const init = await api.post(
        `/roc-sphere/companies/${job.companyId}/roc-dump/upload/initiate`,
        { files: metadata },
        { _skipReadyGate: true },
      );
      const uploadId = init.data?.upload_id;
      if (!uploadId) throw new Error('Backend did not return a ROC upload session ID');

      let uploadedBytes = 0;
      for (let fileIndex = 0; fileIndex < job.files.length; fileIndex += 1) {
        const file = job.files[fileIndex];
        const totalChunks = metadata[fileIndex].total_chunks;
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(file.size, start + CHUNK_SIZE);
          const blob = file.slice(start, end);

          let lastError = null;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              const form = new FormData();
              form.append('upload_id', uploadId);
              form.append('file_index', String(fileIndex));
              form.append('chunk_index', String(chunkIndex));
              form.append('total_chunks', String(totalChunks));
              form.append('chunk', blob, file.name || 'chunk');
              await api.post(
                `/roc-sphere/companies/${job.companyId}/roc-dump/upload/chunk`,
                form,
                {
                  _skipReadyGate: true,
                  timeout: 120000,
                  headers: { 'Content-Type': 'multipart/form-data' },
                },
              );
              lastError = null;
              break;
            } catch (chunkError) {
              lastError = chunkError;
              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
              }
            }
          }
          if (lastError) throw lastError;

          uploadedBytes += blob.size;
          const progress = Math.min(98, Math.round((uploadedBytes / Math.max(totalBytes, 1)) * 98));
          updateJob(job.id, {
            status: 'uploading',
            progress,
            loadedBytes: uploadedBytes,
            totalBytes,
            message: `Uploading ${fileIndex + 1}/${job.files.length}: ${file.name}`,
          });
        }
      }

      const { data } = await api.post(
        `/roc-sphere/companies/${job.companyId}/roc-dump/upload/finalize`,
        { upload_id: uploadId },
        { _skipReadyGate: true },
      );
      const serverJobId = data?.job_id;
      if (!serverJobId) {
        throw new Error('Backend did not return a ROC Forms Dump job ID');
      }

      updateJob(job.id, {
        serverJobId,
        status: 'processing',
        progress: 99,
        loadedBytes: totalBytes,
        message: 'Upload received. Backend is processing the ROC Forms Dump in the background…',
      });

      let consecutivePollFailures = 0;
      while (true) {
        try {
          const statusResponse = await api.get(
            `/roc-sphere/companies/${job.companyId}/roc-dump/jobs/${serverJobId}`,
            { _silent: true, _skipReadyGate: true },
          );
          const serverJob = statusResponse.data || {};
          consecutivePollFailures = 0;

          if (serverJob.status === 'COMPLETED') {
            updateJob(job.id, {
              status: 'done',
              progress: 100,
              loadedBytes: totalBytes,
              finishedAt: Date.now(),
              result: serverJob,
              message: serverJob.message || 'ROC Forms Dump processed successfully.',
            });
            window.dispatchEvent(new CustomEvent('roc-dump-completed', {
              detail: { companyId: job.companyId, jobId: serverJobId },
            }));
            toast.success('ROC Forms Dump processed and Company Summary updated');
            break;
          }

          if (serverJob.status === 'FAILED') {
            throw new Error(serverJob.error || serverJob.message || 'ROC Forms Dump processing failed');
          }

          const processed = Number(serverJob.processed_files || 0);
          const expanded = Number(serverJob.expanded_files || 0);
          const fileCount = Math.max(Number(serverJob.file_count || job.fileCount || 1), 1);
          const progress = Math.max(1, Math.min(99, Math.round((processed / fileCount) * 100)));
          updateJob(job.id, {
            status: 'processing',
            progress,
            message: serverJob.message || (expanded
              ? `Backend processed ${expanded} ROC file(s); continuing…`
              : 'Backend is processing the ROC Forms Dump in the background…'),
          });
        } catch (pollError) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= 20) throw pollError;
          updateJob(job.id, {
            status: 'processing',
            message: 'Backend temporarily unavailable; retrying ROC job status…',
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

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
