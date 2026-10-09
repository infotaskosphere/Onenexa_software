import React, { useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import {
  UploadCloud, Search, RefreshCw, Building2, FileText, IndianRupee,
  CheckCircle2, AlertTriangle, ShoppingBag, X, Database, Edit, Trash2, Wallet, Ban, FileSpreadsheet, Plus
} from 'lucide-react';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from '@/hooks/useDark';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';

const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber: '#F59E0B',
  coral: '#FF6B6B',
};

const PURCHASE_STATUS_META = {
  outstanding:    { label: 'Outstanding',     bg: '#FEF3C7', fg: '#B45309', border: '#FDE68A' },
  partially_paid: { label: 'Partially Paid',  bg: '#DBEAFE', fg: '#1D4ED8', border: '#BFDBFE' },
  paid:           { label: 'Paid',            bg: '#DCFCE7', fg: '#15803D', border: '#BBF7D0' },
  cancelled:      { label: 'Cancelled',       bg: '#F1F5F9', fg: '#64748B', border: '#E2E8F0' },
};

const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const fmtDate = (value) => {
  if (!value) return '—';
  try { return format(parseISO(value), 'dd MMM yyyy'); }
  catch { return value; }
};

function Purchase() {
  const isDark = useDark();
  const fileRef = useRef(null);
  const gstr2bFileRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [purchaseInvoices, setPurchaseInvoices] = useState([]);
  const [clients, setClients] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('auto');
  const [selectedCompanyId, setSelectedCompanyId] = useState('none');
  const [file, setFile] = useState(null);

  // Plain-language manual purchase entry.
  const [manualOpen, setManualOpen] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [manualForm, setManualForm] = useState({
    supplier_name: '',
    invoice_no: '',
    invoice_date: format(new Date(), 'yyyy-MM-dd'),
    grand_total: '',
    gst_rate: '0',
    company_id: 'none',
    client_id: 'none',
    supplier_gstin: '',
    notes: '',
  });

  // GSTR-2B bulk-import state
  const [gstr2bFile, setGstr2bFile] = useState(null);
  const [gstr2bCompanyId, setGstr2bCompanyId] = useState('none');
  const [gstr2bUploading, setGstr2bUploading] = useState(false);
  const [gstr2bResult, setGstr2bResult] = useState(null);

  // Editing state
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [editForm, setEditForm] = useState({
    supplier_name: '',
    invoice_no: '',
    invoice_date: '',
    grand_total: 0,
    total_gst: 0,
    taxable_amount: 0,
    client_id: '',
    company_id: '',
    supplier_gstin: '',
    buyer_gstin: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Payment recording state
  const [payingInvoice, setPayingInvoice] = useState(null);
  const [payForm, setPayForm] = useState({ amount: 0, payment_date: format(new Date(), 'yyyy-MM-dd'), payment_mode: 'bank', bank_account_id: '', reference_no: '', notes: '' });
  const [savingPayment, setSavingPayment] = useState(false);
  const [bankAccounts, setBankAccounts] = useState([]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [purchasesR, clientsR, companiesR] = await Promise.allSettled([
        api.get('/purchase-invoices', { params: { page_size: 500 } }),
        api.get('/clients', { params: { page_size: 1000 } }),
        api.get('/companies/list'),
      ]);
      setPurchaseInvoices(purchasesR.status === 'fulfilled' ? (purchasesR.value.data?.purchase_invoices || []) : []);
      setClients(clientsR.status === 'fulfilled' ? (clientsR.value.data?.clients || clientsR.value.data || []) : []);
      setCompanies(companiesR.status === 'fulfilled' ? normalizeCompanies(companiesR.value) : []);
    } catch {
      toast.error('Failed to load purchase data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  useEffect(() => {
    if (companies.length === 1) {
      setManualForm((current) => current.company_id === 'none'
        ? { ...current, company_id: companies[0].id }
        : current);
    }
  }, [companies]);

  const manualTotals = useMemo(() => {
    const grandTotal = Math.max(0, Number(manualForm.grand_total) || 0);
    const gstRate = Math.max(0, Number(manualForm.gst_rate) || 0);
    const taxableAmount = gstRate > 0 ? grandTotal / (1 + gstRate / 100) : grandTotal;
    return {
      grand_total: Math.round(grandTotal * 100) / 100,
      taxable_amount: Math.round(taxableAmount * 100) / 100,
      total_gst: Math.round((grandTotal - taxableAmount) * 100) / 100,
    };
  }, [manualForm.grand_total, manualForm.gst_rate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchaseInvoices;
    return purchaseInvoices.filter(inv =>
      (inv.client_name || '').toLowerCase().includes(q) ||
      (inv.supplier_name || '').toLowerCase().includes(q) ||
      (inv.invoice_no || '').toLowerCase().includes(q) ||
      (inv.supplier_gstin || '').toLowerCase().includes(q)
    );
  }, [purchaseInvoices, search]);

  const stats = useMemo(() => {
    const total = purchaseInvoices.reduce((s, inv) => s + Number(inv.grand_total || 0), 0);
    const outstanding = purchaseInvoices
      .filter(inv => inv.status !== 'cancelled')
      .reduce((s, inv) => s + Number(inv.amount_due ?? inv.grand_total ?? 0), 0);
    const linked = purchaseInvoices.filter(inv => inv.client_id).length;
    const suppliers = new Set(purchaseInvoices.map(inv => inv.supplier_name).filter(Boolean)).size;
    const reviewCount = purchaseInvoices.filter(inv => !inv.client_id || inv.needs_amount_review).length;
    return { total, outstanding, linked, suppliers, count: purchaseInvoices.length, unmatched: reviewCount };
  }, [purchaseInvoices]);

  const handleUpload = async () => {
    if (!file) { toast.error('Select an invoice first'); return; }
    const form = new FormData();
    form.append('file', file);
    if (selectedClientId !== 'auto') form.append('client_id', selectedClientId);
    if (selectedCompanyId !== 'none') form.append('company_id', selectedCompanyId);

    setUploading(true);
    try {
      const { data } = await api.post('/purchase-invoices/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (data?.duplicate) toast.info('Invoice already exists. Showing saved entry.');
      else toast.success(data?.matched_client ? `Invoice linked to ${data.matched_client.company_name}` : 'Invoice saved. No client match found.');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to read invoice');
    } finally {
      setUploading(false);
    }
  };

  const handleManualSave = async () => {
    if (savingManual) return;
    const supplierName = String(manualForm.supplier_name || '').trim();
    const total = Number(manualForm.grand_total);
    const companyId = manualForm.company_id !== 'none'
      ? manualForm.company_id
      : (companies.length === 1 ? companies[0].id : '');
    const companyExists = companies.some((company) => String(company.id) === String(companyId));

    if (!supplierName) { toast.error('Enter the supplier or shop name.'); return; }
    if (!manualForm.invoice_date) { toast.error('Choose the bill date.'); return; }
    if (!Number.isFinite(total) || total <= 0) { toast.error('Enter the total amount printed on the bill.'); return; }
    if (!companyId || !companyExists) {
      toast.error('Choose which company’s books this purchase belongs to.');
      return;
    }

    const client = clients.find((item) => item.id === manualForm.client_id);
    const payload = {
      company_id: companyId,
      client_id: client?.id || null,
      client_name: client?.company_name || '',
      supplier_name: supplierName,
      supplier_gstin: String(manualForm.supplier_gstin || '').trim().toUpperCase(),
      invoice_no: String(manualForm.invoice_no || '').trim(),
      invoice_date: manualForm.invoice_date,
      taxable_amount: manualTotals.taxable_amount,
      total_gst: manualTotals.total_gst,
      grand_total: manualTotals.grand_total,
      currency: 'INR',
      notes: String(manualForm.notes || '').trim(),
    };

    setSavingManual(true);
    try {
      const { data } = await api.post('/purchase-invoices', payload);
      toast.success(data?.purchase_invoice?.invoice_no
        ? 'Purchase bill saved and added to the accounts.'
        : 'Purchase bill saved and added to the accounts.');
      setManualForm({
        supplier_name: '',
        invoice_no: '',
        invoice_date: format(new Date(), 'yyyy-MM-dd'),
        grand_total: '',
        gst_rate: '0',
        company_id: companyId,
        client_id: 'none',
        supplier_gstin: '',
        notes: '',
      });
      setManualOpen(false);
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save this purchase bill.');
    } finally {
      setSavingManual(false);
    }
  };

  const GSTR2B_ACCEPTED_EXT = ['xlsx', 'xls', 'pdf', 'zip'];

  const handleGstr2bUpload = async () => {
    if (!gstr2bFile) { toast.error('Select a GSTR-2B file first (Excel, PDF, or a ZIP of either)'); return; }
    const ext = gstr2bFile.name.split('.').pop()?.toLowerCase();
    if (!GSTR2B_ACCEPTED_EXT.includes(ext)) {
      toast.error('Unsupported file type. Upload the GSTR-2B Excel (.xlsx/.xls), PDF, or a ZIP containing them.');
      return;
    }
    if (gstr2bCompanyId === 'none') { toast.error('Select which company/book this GSTR-2B belongs to'); return; }
    const form = new FormData();
    form.append('file', gstr2bFile);
    form.append('company_id', gstr2bCompanyId);

    setGstr2bUploading(true);
    setGstr2bResult(null);
    try {
      const { data } = await api.post('/purchase-invoices/upload-gstr2b', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setGstr2bResult(data);
      const fileNote = data.files_processed > 1 ? ` across ${data.files_processed} files` : '';
      if (data.created > 0) {
        toast.success(`Added ${data.created} purchase bill${data.created === 1 ? '' : 's'} from GSTR-2B${fileNote}${data.duplicates ? ` (${data.duplicates} already existed)` : ''}`);
      } else if (data.duplicates > 0) {
        toast.info(`All ${data.duplicates} invoices in this GSTR-2B${fileNote} are already in the Purchase Book.`);
      } else {
        toast.info('No B2B invoices found in this GSTR-2B upload.');
      }
      setGstr2bFile(null);
      if (gstr2bFileRef.current) gstr2bFileRef.current.value = '';
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to read GSTR-2B file');
    } finally {
      setGstr2bUploading(false);
    }
  };


  const startEdit = (inv) => {
    setEditingInvoice(inv);
    setEditForm({
      supplier_name: inv.supplier_name || '',
      invoice_no: inv.invoice_no || '',
      invoice_date: inv.invoice_date || '',
      grand_total: inv.grand_total || 0,
      total_gst: inv.total_gst || 0,
      taxable_amount: inv.taxable_amount || 0,
      client_id: inv.client_id || '',
      company_id: inv.company_id || '',
      supplier_gstin: inv.supplier_gstin || '',
      buyer_gstin: inv.buyer_gstin || '',
    });
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    try {
      await api.put(`/purchase-invoices/${editingInvoice.id}`, {
        supplier_name: editForm.supplier_name,
        invoice_no: editForm.invoice_no,
        invoice_date: editForm.invoice_date,
        grand_total: parseFloat(editForm.grand_total) || 0,
        total_gst: parseFloat(editForm.total_gst) || 0,
        taxable_amount: parseFloat(editForm.taxable_amount) || 0,
        client_id: editForm.client_id === 'none' ? '' : editForm.client_id,
        company_id: editForm.company_id === 'none' ? '' : editForm.company_id,
        supplier_gstin: editForm.supplier_gstin,
        buyer_gstin: editForm.buyer_gstin,
      });
      toast.success('Purchase invoice updated successfully');
      setEditingInvoice(null);
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update purchase invoice');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this purchase invoice?')) return;
    try {
      await api.delete(`/purchase-invoices/${id}`);
      toast.success('Purchase invoice deleted');
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete purchase invoice');
    }
  };

  const startPayment = (inv) => {
    setPayingInvoice(inv);
    setPayForm({
      amount: Number(inv.amount_due ?? inv.grand_total ?? 0),
      payment_date: format(new Date(), 'yyyy-MM-dd'),
      payment_mode: 'bank',
      bank_account_id: '',
      reference_no: '',
      notes: '',
    });
    setBankAccounts([]);
    api.get('/bank-accounts', { params: { company_id: inv.company_id || '' } })
      .then(r => {
        const accts = r.data || [];
        setBankAccounts(accts);
        const primary = accts.find(a => a.is_primary) || accts[0];
        if (primary) setPayForm(p => ({ ...p, bank_account_id: primary.id }));
      })
      .catch(() => setBankAccounts([]));
  };

  const handleSavePayment = async () => {
    if (!payingInvoice) return;
    const amt = parseFloat(payForm.amount) || 0;
    if (amt <= 0) { toast.error('Enter a payment amount greater than zero'); return; }
    if (payForm.payment_mode !== 'cash' && bankAccounts.length > 1 && !payForm.bank_account_id) {
      toast.error('Select which bank account this was paid from');
      return;
    }
    setSavingPayment(true);
    try {
      const dueNow = Number(payingInvoice.amount_due ?? payingInvoice.grand_total ?? 0);
      const status = amt >= dueNow - 0.01 ? 'paid' : 'partially_paid';
      const { data } = await api.patch(`/purchase-invoices/${payingInvoice.id}/status`, {
        status,
        amount: amt,
        payment_date: payForm.payment_date,
        payment_mode: payForm.payment_mode,
        bank_account_id: payForm.payment_mode !== 'cash' ? (payForm.bank_account_id || null) : null,
        reference_no: payForm.reference_no,
        notes: payForm.notes,
      });
      toast.success(data.status === 'paid' ? 'Marked as paid — payment entry posted to ledger' : 'Payment recorded — ledger updated');
      setPayingInvoice(null);
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to record payment');
    } finally {
      setSavingPayment(false);
    }
  };

  const handleCancelInvoice = async (inv) => {
    if (!window.confirm(`Mark bill ${inv.invoice_no || ''} as cancelled? Its ledger entry will be removed.`)) return;
    try {
      await api.patch(`/purchase-invoices/${inv.id}/status`, { status: 'cancelled' });
      toast.success('Bill cancelled and removed from the ledger');
      await fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to cancel bill');
    }
  };

  if (loading) return <GifLoader />;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="p-4 md:p-6 space-y-5 max-w-[1600px] mx-auto">
        <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg">
                <ShoppingBag className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">Accounts</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">Purchase</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">
                  Upload supplier invoices. The app reads invoice details, matches the concerned client/company, and lists the purchase under that client.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setManualOpen(true)} className="bg-white text-blue-900 hover:bg-blue-50">
                <Plus className="h-4 w-4 mr-2" /> Add manually
              </Button>
              <Button onClick={fetchAll} variant="outline" className="bg-white/10 border-white/25 text-white hover:bg-white/20">
                <RefreshCw className="h-4 w-4 mr-2" /> Refresh
              </Button>
            </div>
          </div>
        </div>

        <GuidanceNote pageKey="purchase" isDark={isDark} />

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label: 'Purchase Invoices', value: stats.count, icon: FileText, color: COLORS.mediumBlue },
            { label: 'Total Purchase', value: fmtC(stats.total), icon: IndianRupee, color: COLORS.emeraldGreen },
            { label: 'Outstanding to Pay', value: fmtC(stats.outstanding), icon: Wallet, color: stats.outstanding ? COLORS.coral : COLORS.emeraldGreen },
            { label: 'Needs Review', value: stats.unmatched, icon: AlertTriangle, color: stats.unmatched ? COLORS.amber : COLORS.emeraldGreen },
          ].map((s) => (
            <div key={s.label} className={`rounded-2xl border p-4 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400">{s.label}</p>
                  <p className={`text-xl font-bold mt-1 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{s.value}</p>
                </div>
                <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: s.color }}>
                  <s.icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          <div className="space-y-5 h-fit">
          <div className={`rounded-3xl border shadow-sm p-5 h-fit ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-3 mb-5">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: COLORS.mediumBlue }}>
                <UploadCloud className="h-5 w-5" />
              </div>
              <div>
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Upload purchase invoice</h2>
                <p className="text-xs text-slate-400">PDF and image invoices are supported.</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Concerned company</label>
                <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                  <SelectTrigger className={`mt-2 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-detect from invoice</SelectItem>
                    {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Sales company/book</label>
                <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                  <SelectTrigger className={`mt-2 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    {companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className={`border-2 border-dashed rounded-2xl p-5 text-center ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-blue-100 bg-blue-50/60'}`}>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
                <UploadCloud className="h-9 w-9 mx-auto mb-3" style={{ color: COLORS.mediumBlue }} />
                <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{file ? file.name : 'Choose invoice file'}</p>
                {file && <p className="text-xs text-slate-400 mt-1">{(file.size / 1024).toFixed(0)} KB</p>}
                <div className="mt-4 flex justify-center gap-2">
                  <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="rounded-xl">
                    Browse
                  </Button>
                  {file && (
                    <Button type="button" variant="ghost" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }} className="rounded-xl">
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              <Button onClick={handleUpload} disabled={uploading || !file} className="w-full rounded-xl text-white" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {uploading ? <MiniLoader height={18} /> : <><Database className="h-4 w-4 mr-2" /> Read & Add to Company</>}
              </Button>
            </div>
          </div>

          {/* ── GSTR-2B bulk import ── */}
          <div className={`rounded-3xl border shadow-sm p-5 h-fit ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-3 mb-5">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: `linear-gradient(135deg, ${COLORS.emeraldGreen}, #0F5C63)` }}>
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Import GSTR-2B report</h2>
                <p className="text-xs text-slate-400">Bulk-add every B2B bill from a portal Excel, PDF, or a zipped batch of months — in one go.</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Company/book</label>
                <Select value={gstr2bCompanyId} onValueChange={setGstr2bCompanyId}>
                  <SelectTrigger className={`mt-2 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select company…</SelectItem>
                    {companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className={`border-2 border-dashed rounded-2xl p-5 text-center ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-emerald-100 bg-emerald-50/60'}`}>
                <input ref={gstr2bFileRef} type="file" accept=".xlsx,.xls,.pdf,.zip" className="hidden" onChange={e => setGstr2bFile(e.target.files?.[0] || null)} />
                <FileSpreadsheet className="h-9 w-9 mx-auto mb-3" style={{ color: COLORS.emeraldGreen }} />
                <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{gstr2bFile ? gstr2bFile.name : 'Choose GSTR-2B file — Excel, PDF, or ZIP'}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Accepts .xlsx, .xls, .pdf, or a .zip bundling several monthly exports</p>
                {gstr2bFile && <p className="text-xs text-slate-400 mt-1">{(gstr2bFile.size / 1024).toFixed(0)} KB</p>}
                <div className="mt-4 flex justify-center gap-2">
                  <Button type="button" variant="outline" onClick={() => gstr2bFileRef.current?.click()} className="rounded-xl">
                    Browse
                  </Button>
                  {gstr2bFile && (
                    <Button type="button" variant="ghost" onClick={() => { setGstr2bFile(null); if (gstr2bFileRef.current) gstr2bFileRef.current.value = ''; }} className="rounded-xl">
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              <Button onClick={handleGstr2bUpload} disabled={gstr2bUploading || !gstr2bFile} className="w-full rounded-xl text-white" style={{ background: `linear-gradient(135deg, ${COLORS.emeraldGreen}, #0F5C63)` }}>
                {gstr2bUploading ? <MiniLoader height={18} /> : <><Database className="h-4 w-4 mr-2" /> Import into Purchase Book</>}
              </Button>

              {gstr2bResult && (
                <div className={`rounded-2xl border p-3 text-xs space-y-1 ${isDark ? 'bg-slate-900/60 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  {gstr2bResult.files_processed > 1 && (
                    <div className="flex justify-between"><span>Files combined</span><span className="font-semibold">{gstr2bResult.files_processed}</span></div>
                  )}
                  <div className="flex justify-between"><span>Bills added</span><span className="font-bold text-emerald-500">{gstr2bResult.created}</span></div>
                  <div className="flex justify-between"><span>Already in Purchase Book</span><span className="font-semibold">{gstr2bResult.duplicates}</span></div>
                  <div className="flex justify-between"><span>ITC not eligible</span><span className="font-semibold">{gstr2bResult.ineligible_itc}</span></div>
                  <div className="flex justify-between"><span>Total value imported</span><span className="font-semibold">{fmtC(gstr2bResult.total_value)}</span></div>
                </div>
              )}
            </div>
          </div>
          </div>

          <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="p-4 border-b flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
              <div>
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Purchase invoice list</h2>
                <p className="text-xs text-slate-400">{filtered.length} invoices shown · {stats.suppliers} suppliers</p>
              </div>
              <div className={`flex items-center gap-2 rounded-xl border px-3 h-10 min-w-[260px] ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <Search className="h-4 w-4 text-slate-400" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search supplier, company, GSTIN..." className="border-0 bg-transparent h-9 px-0 focus-visible:ring-0" />
              </div>
            </div>

            <div className="divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
              {filtered.length === 0 ? (
                <div className="py-20 text-center">
                  <FileText className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                  <p className="text-sm font-semibold text-slate-400">No purchase invoices found</p>
                  <p className="text-xs text-slate-400 mt-1">Upload an invoice to start the purchase list.</p>
                </div>
              ) : filtered.map(inv => (
                <div key={inv.id} className={`p-4 transition ${isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50'}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{inv.invoice_no || 'No invoice no.'}</p>
                        {inv.client_id ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Linked</span>
                        ) : (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Review</span>
                        )}
                        {inv.needs_amount_review && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200" title="The totals read from this invoice didn't reconcile — please verify the amount against the file.">
                            Verify amount
                          </span>
                        )}
                        {(() => {
                          const sm = PURCHASE_STATUS_META[inv.status || 'outstanding'] || PURCHASE_STATUS_META.outstanding;
                          return (
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full border"
                              style={{ background: sm.bg, color: sm.fg, borderColor: sm.border }}
                              title={inv.amount_paid ? `Paid ${fmtC(inv.amount_paid)} of ${fmtC(inv.grand_total)}` : undefined}
                            >
                              {sm.label}
                            </span>
                          );
                        })()}
                      </div>
                      <p className="text-sm text-slate-500 mt-1 truncate">
                        {inv.supplier_name || 'Unknown supplier'} {inv.supplier_gstin ? `· ${inv.supplier_gstin}` : ''}
                      </p>
                      <p className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5" /> {inv.client_name || inv.buyer_name || 'No concerned company matched'} · {fmtDate(inv.invoice_date)}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 flex flex-col items-end">
                      <p className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{fmtC(inv.grand_total)}</p>
                      <p className="text-xs text-slate-400">GST {fmtC(inv.total_gst)}</p>
                      {inv.status !== 'cancelled' && Number(inv.amount_due) > 0 && (
                        <p className="text-xs font-semibold" style={{ color: COLORS.coral }}>Due {fmtC(inv.amount_due)}</p>
                      )}
                      <p className="text-[10px] text-slate-400 mt-1 truncate max-w-[180px]">{inv.file_name}</p>
                      <div className="flex items-center gap-2 mt-2">
                        {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                          <Button
                            size="sm"
                            onClick={() => startPayment(inv)}
                            className="h-7 rounded-lg text-white px-2 text-xs"
                            style={{ background: COLORS.emeraldGreen }}
                            title="Record payment — posts a ledger entry"
                          >
                            <Wallet className="h-3.5 w-3.5 mr-1" /> Record Payment
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => startEdit(inv)}
                          className="h-7 w-7 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40"
                          title="Edit purchase invoice"
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        {inv.status !== 'cancelled' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleCancelInvoice(inv)}
                            className="h-7 w-7 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                            title="Cancel bill (removes it from the ledger)"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(inv.id)}
                          className="h-7 w-7 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                          title="Delete purchase invoice"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={manualOpen} onOpenChange={(open) => { if (!savingManual) setManualOpen(open); }}>
        <DialogContent className={`sm:max-w-2xl max-h-[90vh] overflow-y-auto ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Plus className="h-5 w-5 text-emerald-500" /> Add a purchase bill
            </DialogTitle>
          </DialogHeader>

          <div className={`rounded-xl p-3 text-sm ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-blue-50 text-blue-900'}`}>
            Enter the details printed on your supplier’s bill. The total remains the amount you enter; the GST split is calculated automatically from the rate you choose.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div>
              <label className="text-sm font-semibold">Supplier or shop name <span className="text-red-500">*</span></label>
              <Input value={manualForm.supplier_name} onChange={(e) => setManualForm({ ...manualForm, supplier_name: e.target.value })} className="mt-1 rounded-xl" placeholder="e.g. ABC Traders" />
            </div>
            <div>
              <label className="text-sm font-semibold">Bill / invoice number <span className="text-slate-400 font-normal">(optional)</span></label>
              <Input value={manualForm.invoice_no} onChange={(e) => setManualForm({ ...manualForm, invoice_no: e.target.value })} className="mt-1 rounded-xl" placeholder="e.g. BILL-104" />
            </div>
            <div>
              <label className="text-sm font-semibold">Bill date <span className="text-red-500">*</span></label>
              <Input type="date" value={manualForm.invoice_date} onChange={(e) => setManualForm({ ...manualForm, invoice_date: e.target.value })} className="mt-1 rounded-xl" />
            </div>
            <div>
              <label className="text-sm font-semibold">Which company’s books? <span className="text-red-500">*</span></label>
              <Select value={manualForm.company_id} onValueChange={(value) => setManualForm({ ...manualForm, company_id: value })}>
                <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <SelectValue placeholder="Choose a company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {companies.length === 0 && <p className="mt-1 text-xs text-amber-600">No company book was found. Add your company under Company Settings before recording a bill.</p>}
            </div>
            <div>
              <label className="text-sm font-semibold">Total bill amount (₹) <span className="text-red-500">*</span></label>
              <Input type="number" min="0.01" step="0.01" value={manualForm.grand_total} onChange={(e) => setManualForm({ ...manualForm, grand_total: e.target.value })} className="mt-1 rounded-xl" placeholder="e.g. 1180.00" />
              <p className="mt-1 text-xs text-slate-400">Enter the final amount you have to pay, including GST if shown.</p>
            </div>
            <div>
              <label className="text-sm font-semibold">GST rate shown on the bill</label>
              <Select value={manualForm.gst_rate} onValueChange={(value) => setManualForm({ ...manualForm, gst_rate: value })}>
                <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">No GST / not sure (0%)</SelectItem>
                  <SelectItem value="5">5%</SelectItem>
                  <SelectItem value="12">12%</SelectItem>
                  <SelectItem value="18">18%</SelectItem>
                  <SelectItem value="28">28%</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-slate-400">Choose the total GST rate printed on the bill. If you are unsure, keep “No GST / not sure”.</p>
            </div>
            <div>
              <label className="text-sm font-semibold">Client this bill relates to <span className="text-slate-400 font-normal">(optional)</span></label>
              <Select value={manualForm.client_id} onValueChange={(value) => setManualForm({ ...manualForm, client_id: value })}>
                <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <SelectValue placeholder="No client linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No client linked</SelectItem>
                  {clients.map((client) => <SelectItem key={client.id} value={client.id}>{client.company_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-semibold">Supplier GSTIN <span className="text-slate-400 font-normal">(optional)</span></label>
              <Input value={manualForm.supplier_gstin} onChange={(e) => setManualForm({ ...manualForm, supplier_gstin: e.target.value.toUpperCase() })} className="mt-1 rounded-xl" placeholder="15-character GSTIN, if shown" maxLength={15} />
            </div>
            <div className="sm:col-span-2">
              <label className="text-sm font-semibold">What did you buy? <span className="text-slate-400 font-normal">(optional)</span></label>
              <Input value={manualForm.notes} onChange={(e) => setManualForm({ ...manualForm, notes: e.target.value })} className="mt-1 rounded-xl" placeholder="e.g. office chairs, printer paper, computer repair" />
            </div>
          </div>

          <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-slate-50'}`}>
            <p className="text-sm font-bold mb-3">Amount summary</p>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><p className="text-xs text-slate-400">Before GST</p><p className="font-semibold mt-1">{fmtC(manualTotals.taxable_amount)}</p></div>
              <div><p className="text-xs text-slate-400">GST part</p><p className="font-semibold mt-1">{fmtC(manualTotals.total_gst)}</p></div>
              <div><p className="text-xs text-slate-400">Bill total</p><p className="font-bold mt-1 text-emerald-600">{fmtC(manualTotals.grand_total)}</p></div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setManualOpen(false)} disabled={savingManual} className="rounded-xl">Cancel</Button>
            <Button onClick={handleManualSave} disabled={savingManual || companies.length === 0} className="rounded-xl text-white" style={{ background: COLORS.emeraldGreen }}>
              {savingManual ? <MiniLoader height={18} /> : 'Save purchase bill'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editingInvoice !== null} onOpenChange={(open) => { if (!open) setEditingInvoice(null); }}>
        <DialogContent className={`sm:max-w-2xl max-h-[90vh] overflow-y-auto ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-blue-500" />
              Edit Purchase Invoice Details
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-4">
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Supplier / Vendor Name</label>
              <Input
                value={editForm.supplier_name}
                onChange={(e) => setEditForm({ ...editForm, supplier_name: e.target.value })}
                className="mt-1 rounded-xl"
                placeholder="Supplier name"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Invoice No</label>
              <Input
                value={editForm.invoice_no}
                onChange={(e) => setEditForm({ ...editForm, invoice_no: e.target.value })}
                className="mt-1 rounded-xl"
                placeholder="Invoice number"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Invoice Date</label>
              <Input
                type="date"
                value={editForm.invoice_date}
                onChange={(e) => setEditForm({ ...editForm, invoice_date: e.target.value })}
                className="mt-1 rounded-xl"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Grand Total Amount (₹)</label>
              <Input
                type="number"
                step="0.01"
                value={editForm.grand_total}
                onChange={(e) => setEditForm({ ...editForm, grand_total: e.target.value })}
                className="mt-1 rounded-xl"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Total GST (₹)</label>
              <Input
                type="number"
                step="0.01"
                value={editForm.total_gst}
                onChange={(e) => setEditForm({ ...editForm, total_gst: e.target.value })}
                className="mt-1 rounded-xl"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Taxable Amount (₹)</label>
              <Input
                type="number"
                step="0.01"
                value={editForm.taxable_amount}
                onChange={(e) => setEditForm({ ...editForm, taxable_amount: e.target.value })}
                className="mt-1 rounded-xl"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Concerned Company / Client</label>
              <Select
                value={editForm.client_id || 'none'}
                onValueChange={(val) => setEditForm({ ...editForm, client_id: val })}
              >
                <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No matched company</SelectItem>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Sales Company / Book</label>
              <Select
                value={editForm.company_id || 'none'}
                onValueChange={(val) => setEditForm({ ...editForm, company_id: val })}
              >
                <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <SelectValue placeholder="Select book" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not specified</SelectItem>
                  {companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Supplier GSTIN</label>
              <Input
                value={editForm.supplier_gstin}
                onChange={(e) => setEditForm({ ...editForm, supplier_gstin: e.target.value.toUpperCase() })}
                className="mt-1 rounded-xl"
                placeholder="Supplier GSTIN"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Buyer GSTIN</label>
              <Input
                value={editForm.buyer_gstin}
                onChange={(e) => setEditForm({ ...editForm, buyer_gstin: e.target.value.toUpperCase() })}
                className="mt-1 rounded-xl"
                placeholder="Buyer GSTIN"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <Button variant="outline" onClick={() => setEditingInvoice(null)} className="rounded-xl">
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit} className="rounded-xl text-white" style={{ background: COLORS.mediumBlue }}>
              {savingEdit ? <MiniLoader height={18} /> : 'Save Changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={payingInvoice !== null} onOpenChange={(open) => { if (!open) setPayingInvoice(null); }}>
        <DialogContent className={`sm:max-w-md ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Wallet className="h-5 w-5 text-emerald-500" />
              Record Payment
            </DialogTitle>
          </DialogHeader>

          {payingInvoice && (
            <div className="space-y-4 my-2">
              <div className={`rounded-xl p-3 text-sm ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
                <p className="font-semibold">{payingInvoice.invoice_no || 'No invoice no.'} — {payingInvoice.supplier_name}</p>
                <p className="text-slate-400 text-xs mt-1">
                  Bill total {fmtC(payingInvoice.grand_total)} · Due {fmtC(payingInvoice.amount_due ?? payingInvoice.grand_total)}
                </p>
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Amount Paid (₹)</label>
                <Input
                  type="number"
                  step="0.01"
                  value={payForm.amount}
                  onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                  className="mt-1 rounded-xl"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Payment Date</label>
                  <Input
                    type="date"
                    value={payForm.payment_date}
                    onChange={(e) => setPayForm({ ...payForm, payment_date: e.target.value })}
                    className="mt-1 rounded-xl"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Mode</label>
                  <Select value={payForm.payment_mode} onValueChange={(v) => setPayForm({ ...payForm, payment_mode: v })}>
                    <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bank">Bank / NEFT / UPI</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {payForm.payment_mode !== 'cash' && bankAccounts.length > 0 && (
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Bank Account</label>
                  <Select value={payForm.bank_account_id} onValueChange={(v) => setPayForm({ ...payForm, bank_account_id: v })}>
                    <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                      <SelectValue placeholder="Select bank account" />
                    </SelectTrigger>
                    <SelectContent>
                      {bankAccounts.map(a => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.bank_name} · {a.account_number_masked}{a.is_primary ? ' (Primary)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Reference No. (optional)</label>
                <Input
                  value={payForm.reference_no}
                  onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })}
                  className="mt-1 rounded-xl"
                  placeholder="UTR / cheque no."
                />
              </div>

              <p className="text-xs text-slate-400">
                This posts a ledger entry — Dr Accounts Payable, Cr {payForm.payment_mode === 'cash' ? 'Cash in Hand' : 'Bank Accounts'}.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <Button variant="outline" onClick={() => setPayingInvoice(null)} className="rounded-xl">
              Cancel
            </Button>
            <Button onClick={handleSavePayment} disabled={savingPayment} className="rounded-xl text-white" style={{ background: COLORS.emeraldGreen }}>
              {savingPayment ? <MiniLoader height={18} /> : 'Save Payment'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default Purchase;
