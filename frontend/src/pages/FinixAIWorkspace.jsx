import React, { useRef, useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Sparkles, Paperclip, Send, Receipt, Landmark, FileText, BarChart3,
  ArrowRight, ShieldCheck, Clock3, CheckCircle2, XCircle, MessageCircle,
  UploadCloud, AlertTriangle, Building2, HelpCircle, Layers, Check, Edit3,
  ArrowLeft, Scale, Calculator, Tag, FileCheck, RefreshCw, ChevronRight,
  TrendingUp, TrendingDown, DollarSign, BookOpen
} from 'lucide-react';
import api from '@/lib/api';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { useDark } from '@/hooks/useDark';
import { normalizeCompanies } from '@/lib/companies';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { isCommercialTenant } from '@/lib/commercialPermissionMatrix';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const QUICK_PROMPTS = [
  { label: 'Sales Invoice', icon: TrendingUp, prompt: 'Invoice client Zenith Technologies for ₹1,50,000 software consulting services with 18% GST' },
  { label: 'Vendor Bill', icon: TrendingDown, prompt: 'Received purchase bill from Delta Hardware for ₹45,000 including 18% GST' },
  { label: 'Consultancy TDS', icon: Scale, prompt: 'Paid ₹50,000 legal consultancy to Lex Advocates after deducting 10% TDS u/s 194J' },
  { label: 'Office Rent TDS', icon: Building2, prompt: 'Paid ₹40,000 office rent to Apex Properties deducting 10% TDS u/s 194I via HDFC Bank' },
  { label: 'Bank Transfer (Contra)', icon: Landmark, prompt: 'Transferred ₹60,000 from SBI Current Account to HDFC Bank' },
  { label: 'Cash Deposit (Contra)', icon: DollarSign, prompt: 'Deposited ₹35,000 cash in hand into SBI Current Account' },
  { label: 'Salary Accrual', icon: Calculator, prompt: 'Accrued staff salaries for the month amounting to ₹3,20,000' },
  { label: 'Depreciation', icon: Tag, prompt: 'Record ₹25,000 quarterly depreciation on computers and office equipment' },
];

const ACCOUNTING_LINKS = [
  { label: 'Finix Dashboard', path: '/finix-dashboard', icon: BarChart3 },
  { label: 'Sales & Invoicing', path: '/invoicing', icon: TrendingUp },
  { label: 'Vendor Purchase', path: '/purchase', icon: TrendingDown },
  { label: 'Day Book', path: '/day-book', icon: Receipt },
  { label: 'Journal Entries', path: '/journal-entries', icon: FileText },
  { label: 'Trial Balance', path: '/accounting-reports', icon: Scale },
  { label: 'Profit & Loss', path: '/accounting-reports', icon: BarChart3 },
  { label: 'Balance Sheet', path: '/accounting-reports', icon: BookOpen },
  { label: 'Bank Reconciliation', path: '/bank-reconciliation', icon: Landmark },
];

export default function FinixAIWorkspace() {
  return (
    <RequestAccessGate module="accounting_reports" moduleLabel="Finix AI Accounting" permissionFlag="can_view_accounting_reports">
      <WorkspaceInner />
    </RequestAccessGate>
  );
}

function WorkspaceInner() {
  const isDark = useDark();
  const { user } = useAuth();
  const navigate = useNavigate();

  const tenantCompanyId = isCommercialTenant(user) ? String(user?.company_id || '') : '';
  const tenantCompanyName = user?.company_name || user?.company?.name || 'My Company';

  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [ask, setAsk] = useState('');
  const [askResult, setAskResult] = useState(null);
  const [askLoading, setAskLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  // Initialize companies
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/companies/list');
        let list = normalizeCompanies(res);
        if (tenantCompanyId) {
          const own = list.filter((c) => c && c.id === tenantCompanyId);
          list = own.length ? own : [{ id: tenantCompanyId, name: tenantCompanyName }];
        }
        setCompanies(list);
        if (list.length) {
          const lastId = localStorage.getItem('accountingReports:lastCompanyId');
          const chosen = list.find((c) => c.id === lastId)?.id || list[0].id;
          setCompanyId(chosen);
        }
      } catch (err) {
        console.error(err);
      }
    })();
  }, [user?.id]);

  const showResult = (data) => {
    setResult(data);
    setHistory((h) => [{ text: data.source_filename || data.prompt || text, result: data, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...h].slice(0, 10));
  };

  const submit = async (value) => {
    const prompt = (value ?? text).trim();
    if (!prompt) return;
    if (!companyId) {
      toast.error('Please select a company before submitting.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const r = await api.post('/finix/ai/agent/propose', {
        text: prompt,
        company_id: companyId,
        accounting_date: new Date().toISOString().split('T')[0]
      });
      showResult({ ...r.data, prompt });
      setText('');
      toast.success('Finix AI prepared double-entry proposal.');
    } catch (e) {
      setResult({ error: e?.response?.data?.detail || 'Finix AI could not interpret this transaction.' });
      toast.error('Unable to create proposal.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file) return;
    if (!companyId) {
      toast.error('Please select a company before uploading.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('company_id', companyId);
      fd.append('accounting_date', new Date().toISOString().split('T')[0]);
      const r = await api.post('/finix/ai/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      showResult({ ...r.data, source_filename: file.name });
      toast.success(`Document "${file.name}" analyzed.`);
    } catch (err) {
      setResult({ error: err?.response?.data?.detail || 'Finix could not extract readable accounting data from this file.' });
      toast.error('Failed to parse document.');
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleAction = async (actionName) => {
    if (!result?.proposal_id) return;
    setLoading(true);
    try {
      const r = await api.post('/finix/ai/inbox/action', {
        proposal_id: result.proposal_id,
        action: actionName
      });
      setResult({ ...result, ...r.data });
      if (actionName === 'APPROVE') {
        toast.success('Journal entry posted to General Ledger and Finix AI learned from outcome!');
      } else {
        toast.info('Proposal rejected.');
      }
    } catch (e) {
      setResult({ ...result, error: e?.response?.data?.detail || 'Finix could not complete that action.' });
      toast.error('Action failed.');
    } finally {
      setLoading(false);
    }
  };

  const askFinix = async (customQuery) => {
    const q = (customQuery || ask).trim();
    if (!q) return;
    if (!companyId) {
      toast.error('Select a company first.');
      return;
    }
    setAskLoading(true);
    try {
      const r = await api.post('/finix/ai/ask', {
        question: q,
        company_id: companyId
      });
      setAskResult(r.data);
      if (!customQuery) setAsk('');
    } catch (e) {
      setAskResult({ error: e?.response?.data?.detail || 'Finix could not retrieve data for this question.' });
    } finally {
      setAskLoading(false);
    }
  };

  const questions = result?.needs_clarification || [];
  const posted = result?.status === 'POSTED';
  const totalDebit = (result?.lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = (result?.lines || []).reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.05 && totalDebit > 0;

  return (
    <div className={`min-h-screen p-4 md:p-8 ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="mx-auto max-w-7xl space-y-6">

        {/* ── Top Bar with Navigation & Company Selector ── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/finix-dashboard')}
              className="rounded-xl gap-1 text-xs"
            >
              <ArrowLeft className="w-4 h-4" /> Finix Dashboard
            </Button>
            <span className="text-xs text-slate-400">|</span>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-500" />
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Finix AI Accounting Studio
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Building2 className="w-4 h-4 text-slate-400" />
            <Select value={companyId} onValueChange={(val) => {
              setCompanyId(val);
              localStorage.setItem('accountingReports:lastCompanyId', val);
            }}>
              <SelectTrigger className={`h-9 w-[220px] rounded-xl text-xs font-semibold ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <SelectValue placeholder="Select Company" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ── Hero Banner ── */}
        <div
          className="relative overflow-hidden rounded-3xl p-6 md:p-8 text-white shadow-xl"
          style={{ background: 'linear-gradient(120deg, #0A2E52 0%, #0D3B66 40%, #0F5C63 75%, #12806B 100%)' }}
        >
          <div className="pointer-events-none absolute -right-10 -top-16 w-64 h-64 rounded-full opacity-20 bg-emerald-400 blur-2xl" />
          
          <div className="flex items-start justify-between gap-4 relative">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20 text-xs font-semibold text-emerald-200">
                <Sparkles size={14} /> NATURAL LANGUAGE ACCOUNTING
              </div>
              <h1 className="mt-3 text-2xl md:text-4xl font-extrabold tracking-tight">
                Just describe what happened.
              </h1>
              <p className="mt-2 max-w-2xl text-slate-200/90 text-sm leading-relaxed">
                Describe an invoice, bill, bank transfer, salary, or expense in plain English. Finix maps accounts according to Indian Schedule III standards, calculates CGST/SGST/IGST and TDS (Sec 194), and prepares a fully balanced double-entry voucher.
              </p>
            </div>
            <div className="hidden lg:flex p-3.5 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20">
              <ShieldCheck className="w-8 h-8 text-emerald-300" />
            </div>
          </div>

          {/* ── Prompt Input Box ── */}
          <div className="mt-6 rounded-2xl bg-white p-2 flex items-center gap-2 shadow-xl relative text-slate-900">
            <button
              className="p-3 text-slate-400 hover:text-emerald-600 transition"
              title="Upload invoice, bill or bank statement"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip size={20} />
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".txt,.csv,.pdf,.xlsx,.xls,image/*"
              onChange={(e) => handleFileUpload(e.target.files?.[0])}
            />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && submit()}
              placeholder="e.g. Paid ₹40,000 office rent to Apex Properties deducting 10% TDS u/s 194I via HDFC Bank"
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 font-medium"
            />
            <Button
              disabled={loading || !text.trim()}
              onClick={() => submit()}
              className="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 font-bold flex items-center gap-2 text-sm shadow-sm"
            >
              {loading ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Processing...</>
              ) : (
                <><Send size={16} /> Process Voucher</>
              )}
            </Button>
          </div>

          {/* Drag & drop helper text */}
          <div className="mt-3 text-xs text-slate-200/80 flex items-center gap-2">
            <UploadCloud size={14} /> Supports PDF invoices, Excel sheets (.xlsx), CSV bank statements, and scanned receipts. Governed audit trail records every approval.
          </div>
        </div>

        {/* ── Quick Prompt Chips ── */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-500" /> One-Click Transaction Templates
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-2.5">
            {QUICK_PROMPTS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => {
                    setText(item.prompt);
                    submit(item.prompt);
                  }}
                  className={`p-3 rounded-2xl border text-left transition hover:shadow-sm hover:border-emerald-500 flex items-start gap-2.5 ${isDark ? 'bg-slate-800/80 border-slate-700/80 text-slate-200' : 'bg-white border-slate-200/80 text-slate-800'}`}
                >
                  <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0 mt-0.5">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold truncate">{item.label}</div>
                    <div className="text-[10px] text-slate-400 truncate mt-0.5">{item.prompt}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Active Proposal Result Panel ── */}
        {result && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            
            {/* Left 2 Cols: Proposal Details */}
            <div className={`lg:col-span-2 rounded-3xl border p-6 shadow-sm ${isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200/80'}`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-700">
                <div>
                  <div className="text-xs font-extrabold text-emerald-600 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles size={14} /> AI Accounting Proposal
                  </div>
                  <h2 className="text-xl font-bold mt-1 flex items-center gap-2">
                    {result.error ? 'Needs Attention' : (result.event ? `${result.event} VOUCHER` : 'TRANSACTION REVIEW')}
                  </h2>
                </div>
                {result.confidence_band && (
                  <span className={`px-3 py-1 rounded-full text-xs font-bold border ${result.confidence_band === 'AUTO' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-amber-500/10 text-amber-600 border-amber-500/30'}`}>
                    Confidence: {result.confidence_band} ({Math.round((result.confidence || 0) * 100)}%)
                  </span>
                )}
              </div>

              {result.error ? (
                <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 text-sm mt-4">
                  {result.error}
                </div>
              ) : (
                <>
                  {/* Summary Metric Pills */}
                  <div className="grid grid-cols-3 gap-3 my-4">
                    <div className={`p-3.5 rounded-2xl border ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-[10px] uppercase font-bold text-slate-400">Total Amount</div>
                      <div className="text-lg font-extrabold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
                        {money(result.amount)}
                      </div>
                    </div>
                    <div className={`p-3.5 rounded-2xl border ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-[10px] uppercase font-bold text-slate-400">Party / Vendor</div>
                      <div className="text-sm font-bold truncate mt-1">
                        {result.party_name || result.vendor_or_customer_name || 'General Adjustment'}
                      </div>
                    </div>
                    <div className={`p-3.5 rounded-2xl border ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-[10px] uppercase font-bold text-slate-400">Accounting Policy</div>
                      <div className="text-sm font-bold text-blue-500 mt-1">
                        {result.policy?.substance || result.event || 'Governed'}
                      </div>
                    </div>
                  </div>

                  {/* Clarification Questions (if any) */}
                  {questions.length > 0 && (
                    <div className="my-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs">
                      <div className="font-bold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                        <AlertTriangle size={15} /> Clarification Needed for Statutory Compliance:
                      </div>
                      <ul className="mt-2 space-y-1 list-disc list-inside text-amber-900 dark:text-amber-200">
                        {questions.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Double-Entry Journal Lines Table */}
                  {result.lines && result.lines.length > 0 && (
                    <div className="my-5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                          <Scale size={14} className="text-emerald-500" /> Double-Entry General Ledger Lines
                        </span>
                        <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${isBalanced ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'}`}>
                          {isBalanced ? 'Balanced: Dr = Cr' : 'Out of Balance'}
                        </span>
                      </div>

                      <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                        <table className="w-full text-left text-xs">
                          <thead className={`${isDark ? 'bg-slate-900/80 text-slate-300' : 'bg-slate-100 text-slate-700'} font-semibold border-b ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                            <tr>
                              <th className="p-3">Account Name &amp; Code</th>
                              <th className="p-3 text-right">Debit (Dr)</th>
                              <th className="p-3 text-right">Credit (Cr)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                            {result.lines.map((l, i) => (
                              <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                                <td className="p-3 font-sans font-medium">
                                  {l.account_name || l.account_id}
                                  {l.hsn_sac && (
                                    <span className="ml-2 text-[10px] text-slate-400 font-mono">
                                      HSN: {l.hsn_sac}
                                    </span>
                                  )}
                                </td>
                                <td className="p-3 text-right font-bold text-emerald-600 dark:text-emerald-400">
                                  {Number(l.debit) > 0 ? money(l.debit) : '—'}
                                </td>
                                <td className="p-3 text-right font-bold text-purple-600 dark:text-purple-400">
                                  {Number(l.credit) > 0 ? money(l.credit) : '—'}
                                </td>
                              </tr>
                            ))}
                            <tr className={`font-bold ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                              <td className="p-3 font-sans">Total Balanced Sum</td>
                              <td className="p-3 text-right text-emerald-600">{money(totalDebit)}</td>
                              <td className="p-3 text-right text-purple-600">{money(totalCredit)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {result.narration && (
                        <div className="mt-2.5 text-xs text-slate-400">
                          <strong>Narration:</strong> {result.narration}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Statutory GST / TDS breakdown details */}
                  {(result.gst_split || result.tds_result?.applicable) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-4">
                      {result.gst_split && (
                        <div className={`p-3 rounded-xl border text-xs ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="font-bold text-blue-500 mb-1">GST Breakdown ({result.gst_split.status})</div>
                          <div className="flex justify-between text-slate-500">
                            <span>CGST: {money(result.gst_split.cgst)}</span>
                            <span>SGST: {money(result.gst_split.sgst)}</span>
                            <span>IGST: {money(result.gst_split.igst)}</span>
                          </div>
                        </div>
                      )}
                      {result.tds_result?.applicable && (
                        <div className={`p-3 rounded-xl border text-xs ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="font-bold text-purple-500 mb-1">TDS Evaluation ({result.tds_result.statutory_reference})</div>
                          <div className="flex justify-between text-slate-500">
                            <span>Rate: {result.tds_result.effective_rate}%</span>
                            <span className="font-bold text-purple-600">Deduction: {money(result.tds_result.deduction_amount)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Status & Posting Action Bar */}
                  <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      {posted ? (
                        <div className="flex items-center gap-2 text-emerald-600 font-bold text-sm">
                          <CheckCircle2 size={18} /> Posted to General Ledger (Entry #{result.journal_entry?.id || result.id})
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">
                          Waiting for your approval before posting to authoritative accounts.
                        </div>
                      )}
                    </div>

                    {result.proposal_id && !posted && result.status !== 'REJECTED' && (
                      <div className="flex items-center gap-2">
                        <Button
                          disabled={loading}
                          onClick={() => handleAction('REJECT')}
                          variant="outline"
                          size="sm"
                          className="rounded-xl border-red-300 text-red-600 hover:bg-red-50 text-xs font-semibold gap-1.5"
                        >
                          <XCircle size={15} /> Reject
                        </Button>
                        <Button
                          disabled={loading}
                          onClick={() => handleAction('APPROVE')}
                          size="sm"
                          className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs gap-1.5 shadow-sm"
                        >
                          <CheckCircle2 size={15} /> Approve &amp; Post to Books
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Right 1 Col: AI Activity Feed & Learning */}
            <div className={`rounded-3xl border p-6 shadow-sm ${isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200/80'}`}>
              <div className="flex items-center gap-2 font-bold text-sm mb-4">
                <Clock3 size={17} className="text-emerald-500" />
                Session AI Activity Stream
              </div>

              {history.length === 0 ? (
                <div className="text-center py-10 text-xs text-slate-400">
                  <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30 text-emerald-500" />
                  Your analyzed proposals and voucher creations will appear here.
                </div>
              ) : (
                <div className="space-y-3 overflow-y-auto max-h-[380px] pr-1">
                  {history.map((h, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-2xl border text-xs ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}
                    >
                      <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                        <span className="font-bold uppercase text-emerald-600">
                          {h.result?.event || 'Transaction'}
                        </span>
                        <span>{h.time}</span>
                      </div>
                      <div className="font-medium text-slate-800 dark:text-slate-200 line-clamp-2">
                        {h.text}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[10px]">
                        <span className="font-mono font-bold text-slate-500">{money(h.result?.amount)}</span>
                        <span className={`px-1.5 py-0.2 rounded font-semibold ${h.result?.status === 'POSTED' ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40' : 'text-slate-400'}`}>
                          {h.result?.status || 'Proposed'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── Natural Language Financial Query Console ── */}
        <div className={`rounded-3xl border p-6 shadow-sm ${isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200/80'}`}>
          <div className="flex items-center gap-2.5 mb-2">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600">
              <MessageCircle size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold">Ask Finix About Live Books &amp; Taxes</h2>
              <p className="text-xs text-slate-400">Autonomous analytical answers directly querying General Ledger &amp; Sub-ledgers.</p>
            </div>
          </div>

          {/* Quick Query Pills */}
          <div className="flex flex-wrap gap-2 my-3">
            {[
              "What is my Net GST liability for this month?",
              "What is my current Accounts Receivable balance?",
              "What are the pending supplier payables?",
              "Show current Profit and Loss overview",
              "Check Trial Balance debits and credits",
              "How much TDS was deducted this period?"
            ].map((q) => (
              <button
                key={q}
                onClick={() => {
                  setAsk(q);
                  askFinix(q);
                }}
                className={`text-xs px-3 py-1.5 rounded-full border transition hover:border-emerald-500 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
              >
                {q}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && askFinix()}
              placeholder="Ask anything (e.g., 'What is my current net profit margin?')"
              className={`flex-1 rounded-xl border px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-800'}`}
            />
            <Button
              disabled={askLoading || !ask.trim()}
              onClick={() => askFinix()}
              className="rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-5 text-xs font-bold"
            >
              {askLoading ? 'Querying...' : 'Ask Finix'}
            </Button>
          </div>

          {/* Structured Answer Display */}
          {askResult && (
            <div className={`mt-4 p-4 rounded-2xl border text-xs ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-bold text-emerald-600 mb-1.5">Finix Copilot Answer</div>
              {askResult.error ? (
                <div className="text-red-500">{askResult.error}</div>
              ) : (
                <div className="space-y-2">
                  {askResult.profit !== undefined && (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Income</span>
                        <div className="font-bold text-sm text-emerald-600">{money(askResult.income)}</div>
                      </div>
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Expenses</span>
                        <div className="font-bold text-sm text-red-500">{money(askResult.expenses)}</div>
                      </div>
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Net Profit</span>
                        <div className="font-bold text-sm text-blue-500">{money(askResult.profit)}</div>
                      </div>
                    </div>
                  )}

                  {askResult.receivables !== undefined && (
                    <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border flex items-center justify-between">
                      <span>Total Accounts Receivable (Debtors):</span>
                      <strong className="text-sm font-mono text-amber-600">{money(askResult.receivables)} ({askResult.invoice_count} open invoices)</strong>
                    </div>
                  )}

                  {askResult.payables !== undefined && (
                    <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border flex items-center justify-between">
                      <span>Total Accounts Payable (Creditors):</span>
                      <strong className="text-sm font-mono text-purple-600">{money(askResult.payables)} ({askResult.invoice_count} vendor bills)</strong>
                    </div>
                  )}

                  {askResult.output_gst !== undefined && (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Output GST</span>
                        <div className="font-bold text-sm text-slate-800 dark:text-slate-100">{money(askResult.output_gst)}</div>
                      </div>
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Input ITC</span>
                        <div className="font-bold text-sm text-emerald-600">{money(askResult.input_gst)}</div>
                      </div>
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border">
                        <span className="text-slate-400 text-[10px]">Net Payable</span>
                        <div className="font-bold text-sm text-blue-500">{money(askResult.net_gst)}</div>
                      </div>
                    </div>
                  )}

                  {askResult.trial_balance_debits !== undefined && (
                    <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border flex items-center justify-between">
                      <span>Trial Balance Parity:</span>
                      <strong className="text-sm font-mono text-emerald-600">
                        Dr {money(askResult.trial_balance_debits)} = Cr {money(askResult.trial_balance_credits)} ({askResult.balanced ? 'Equilibrium verified' : 'Mismatch detected'})
                      </strong>
                    </div>
                  )}

                  {askResult.total_tds_deducted !== undefined && (
                    <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border flex items-center justify-between">
                      <span>Total TDS Deductions:</span>
                      <strong className="text-sm font-mono text-purple-600">
                        {money(askResult.total_tds_deducted)} (Challan due: {askResult.challan_due})
                      </strong>
                    </div>
                  )}

                  {askResult.message && (
                    <div className="text-slate-600 dark:text-slate-300">{askResult.message}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Direct Links to Full Financial Suite ── */}
        <div className={`rounded-3xl border p-6 shadow-sm ${isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200/80'}`}>
          <div className="mb-4">
            <h2 className="text-lg font-bold">Standard Indian Accounting Modules</h2>
            <p className="text-xs text-slate-400">Access authoritative general ledger, registers, and statutory filing screens.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3">
            {ACCOUNTING_LINKS.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.label}
                  to={item.path}
                  className={`p-3.5 rounded-2xl border flex items-center gap-3 transition hover:border-emerald-500 hover:shadow-sm ${isDark ? 'bg-slate-900/50 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'}`}
                >
                  <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 shrink-0">
                    <Icon size={18} />
                  </div>
                  <span className="font-semibold text-xs flex-1">{item.label}</span>
                  <ChevronRight size={14} className="text-slate-400" />
                </Link>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
