import React, { useRef, useState } from 'react';
import {
  Sparkles, Paperclip, Send, UploadCloud, AlertTriangle, CheckCircle2,
  XCircle, Scale, RefreshCw, FileText, Receipt, Landmark, TrendingUp,
  TrendingDown, Building2, Calculator
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

const QUICK_PROMPTS = [
  { label: 'Sales Invoice', icon: TrendingUp, prompt: 'Invoice customer for ₹1,50,000 consulting services with 18% GST' },
  { label: 'Purchase Bill', icon: TrendingDown, prompt: 'Received purchase bill from vendor for ₹45,000 including 18% GST' },
  { label: 'Bank Transfer', icon: Landmark, prompt: 'Transfer ₹60,000 from SBI Current Account to HDFC Bank' },
  { label: 'Office Rent', icon: Building2, prompt: 'Paid ₹40,000 office rent and deduct 10% TDS u/s 194I' },
  { label: 'Salary Accrual', icon: Calculator, prompt: 'Accrue staff salaries of ₹3,20,000 for this month' },
  { label: 'Customer Receipt', icon: Receipt, prompt: 'Received ₹75,000 from customer against outstanding invoice' },
];

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function FinixAICommandCenter({ companyId, isDark = false }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (value) => {
    const prompt = String(value ?? text).trim();
    if (!prompt || !companyId || companyId === '__all__') {
      if (!companyId || companyId === '__all__') toast.error('Select one company/book before using AI Accounting.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { data } = await api.post('/finix/ai/agent/propose', {
        text: prompt,
        company_id: companyId,
        accounting_date: new Date().toISOString().split('T')[0],
      });
      setResult({ ...data, prompt });
      setText('');
      if (data?.success) toast.success('Finix prepared a governed double-entry proposal.');
      else toast.info('Finix needs clarification before preparing the voucher.');
    } catch (err) {
      setResult({ error: err?.response?.data?.detail || 'Finix AI could not process this transaction.' });
      toast.error('Finix AI transaction processing failed.');
    } finally {
      setLoading(false);
    }
  };

  const upload = async (file) => {
    if (!file || !companyId || companyId === '__all__') {
      if (!companyId || companyId === '__all__') toast.error('Select one company/book before uploading.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('company_id', companyId);
      form.append('accounting_date', new Date().toISOString().split('T')[0]);
      const { data } = await api.post('/finix/ai/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult({ ...data, source_filename: file.name });
      toast.success(`Finix analyzed ${file.name}.`);
    } catch (err) {
      setResult({ error: err?.response?.data?.detail || 'Finix could not read the uploaded document.' });
      toast.error('Finix document analysis failed.');
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const action = async (actionName) => {
    if (!result?.proposal_id) return;
    setLoading(true);
    try {
      const { data } = await api.post('/finix/ai/inbox/action', {
        proposal_id: result.proposal_id,
        action: actionName,
      });
      setResult((current) => ({ ...current, ...data }));
      if (actionName === 'APPROVE') toast.success('Approved and posted through the Finix accounting ledger.');
      else toast.info('AI proposal rejected. Nothing was posted.');
    } catch (err) {
      setResult((current) => ({ ...current, error: err?.response?.data?.detail || 'Finix could not complete the requested action.' }));
      toast.error('Finix accounting action failed.');
    } finally {
      setLoading(false);
    }
  };

  const lines = Array.isArray(result?.lines) ? result.lines : [];
  const debit = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);
  const credit = lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0);
  const balanced = debit > 0 && Math.abs(debit - credit) < 0.05;
  const questions = Array.isArray(result?.needs_clarification) ? result.needs_clarification : [];

  return (
    <section id="finix-ai-accounting" className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/80 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className="px-5 py-4 md:px-6 md:py-5 border-b border-slate-200/70 dark:border-slate-700">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-emerald-600 font-extrabold text-xs uppercase tracking-wider">
              <Sparkles className="w-4 h-4" /> Finix AI Accounting
            </div>
            <h2 className="text-xl font-extrabold mt-1">Describe a transaction. Finix prepares the books.</h2>
            <p className="text-xs text-slate-400 mt-1 max-w-3xl">
              Natural-language accounting, document ingestion, GST/TDS evaluation and governed double-entry posting are part of Finix itself.
            </p>
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            AI proposes → you approve → Finix posts
          </div>
        </div>

        <div className="mt-4 rounded-2xl p-2 flex items-center gap-2 border border-emerald-500/20 bg-emerald-500/[0.04]">
          <button
            type="button"
            className="p-2.5 text-slate-400 hover:text-emerald-600"
            title="Upload invoice, bill, bank statement or accounting document"
            onClick={() => fileRef.current?.click()}
            disabled={loading}
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,.xlsx,.xls,.csv,.txt,image/*"
            onChange={(event) => upload(event.target.files?.[0])}
          />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && !event.shiftKey && submit()}
            placeholder="e.g. Paid ₹40,000 office rent to Apex Properties with 10% TDS u/s 194I"
            className={`min-w-0 flex-1 bg-transparent px-2 text-sm outline-none ${isDark ? 'text-slate-100 placeholder:text-slate-500' : 'text-slate-800 placeholder:text-slate-400'}`}
          />
          <Button
            type="button"
            disabled={loading || !text.trim()}
            onClick={() => submit()}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-2"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span className="hidden sm:inline">{loading ? 'Processing' : 'Process'}</span>
          </Button>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
          <UploadCloud className="w-3.5 h-3.5" />
          PDF / Excel / CSV / text documents can be analyzed before anything is posted.
        </div>
      </div>

      <div className="p-5 md:p-6">
        <div className="flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                disabled={loading}
                onClick={() => submit(item.prompt)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition hover:border-emerald-500 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
              >
                <Icon className="w-3.5 h-3.5 text-emerald-600" />
                {item.label}
              </button>
            );
          })}
        </div>

        {result && (
          <div className={`mt-5 rounded-2xl border p-4 md:p-5 ${isDark ? 'border-slate-700 bg-slate-900/50' : 'border-slate-200 bg-slate-50/70'}`}>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase font-extrabold tracking-wider text-emerald-600">
                  {result.status === 'POSTED' ? 'Posted by Finix' : 'AI Accounting Proposal'}
                </div>
                <div className="font-bold mt-1">{result.event || result.source_filename || 'Transaction review'}</div>
              </div>
              {result.confidence_band && (
                <span className="text-[10px] font-bold rounded-full px-2.5 py-1 border border-emerald-500/30 text-emerald-600 bg-emerald-500/10">
                  {result.confidence_band} · {Math.round((Number(result.confidence) || 0) * 100)}%
                </span>
              )}
            </div>

            {result.error && <div className="mt-3 text-sm text-red-500">{result.error}</div>}

            {!result.error && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
                  <div className="rounded-xl border p-3">
                    <div className="text-[9px] uppercase font-bold text-slate-400">Amount</div>
                    <div className="font-mono font-bold text-emerald-600 mt-1">{money(result.amount)}</div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <div className="text-[9px] uppercase font-bold text-slate-400">Party</div>
                    <div className="text-xs font-semibold mt-1 truncate">{result.party_name || '—'}</div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <div className="text-[9px] uppercase font-bold text-slate-400">Debits</div>
                    <div className="font-mono font-bold mt-1">{money(debit)}</div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <div className="text-[9px] uppercase font-bold text-slate-400">Credits</div>
                    <div className="font-mono font-bold mt-1">{money(credit)}</div>
                  </div>
                </div>

                {questions.length > 0 && (
                  <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <div className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Clarification required</div>
                    <ul className="mt-1.5 list-disc list-inside space-y-1">{questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  </div>
                )}

                {lines.length > 0 && (
                  <div className="mt-4 rounded-xl border overflow-hidden">
                    <div className="px-3 py-2 flex items-center justify-between bg-slate-100/70 dark:bg-slate-800/70">
                      <span className="text-[10px] uppercase font-bold flex items-center gap-1.5 text-slate-500">
                        <Scale className="w-3.5 h-3.5" /> Double-entry preview
                      </span>
                      <span className={`text-[10px] font-bold ${balanced ? 'text-emerald-600' : 'text-red-500'}`}>
                        {balanced ? 'Balanced Dr = Cr' : 'Review balance'}
                      </span>
                    </div>
                    <div className="max-h-44 overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
                      {lines.map((line, index) => (
                        <div key={index} className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2 text-xs">
                          <span className="font-medium">{line.account_name || line.account_id}</span>
                          <span className="text-right font-mono text-emerald-600">{Number(line.debit) ? money(line.debit) : '—'}</span>
                          <span className="text-right font-mono text-purple-600">{Number(line.credit) ? money(line.credit) : '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result.gst_split && (
                  <div className="mt-3 rounded-xl border p-3 text-xs">
                    <div className="font-bold text-blue-600">GST split · {result.gst_split.status}</div>
                    <div className="mt-1 flex flex-wrap gap-4 text-slate-500">
                      <span>CGST {money(result.gst_split.cgst)}</span>
                      <span>SGST {money(result.gst_split.sgst)}</span>
                      <span>IGST {money(result.gst_split.igst)}</span>
                    </div>
                  </div>
                )}

                {result.tds_result?.applicable && (
                  <div className="mt-3 rounded-xl border p-3 text-xs">
                    <div className="font-bold text-purple-600">TDS · {result.tds_result.statutory_reference}</div>
                    <div className="mt-1 text-slate-500">
                      Rate {result.tds_result.effective_rate}% · Deduction {money(result.tds_result.deduction_amount)}
                    </div>
                  </div>
                )}

                <div className="mt-4 pt-3 border-t flex flex-wrap items-center justify-between gap-3">
                  {result.status === 'POSTED' ? (
                    <div className="flex items-center gap-2 text-sm font-bold text-emerald-600">
                      <CheckCircle2 className="w-4 h-4" /> Posted to General Ledger
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400">Nothing is posted until you approve this proposal.</div>
                  )}
                  {result.proposal_id && result.status !== 'POSTED' && result.status !== 'REJECTED' && balanced && (
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => action('REJECT')} disabled={loading} className="text-red-600 border-red-300">
                        <XCircle className="w-3.5 h-3.5 mr-1" /> Reject
                      </Button>
                      <Button type="button" size="sm" onClick={() => action('APPROVE')} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve &amp; Post
                      </Button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
