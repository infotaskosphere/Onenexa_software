// CompanyProfiles.jsx — shared "Company Profile" management UI.
//
// This is the single source of truth for company details (name, address,
// GSTIN/PAN, bank accounts, logos, SMTP) used across the app — Quotations,
// Invoicing, Trademark Sphere, WhatsApp/Email settings, GST Portal Sync, etc.
// all read from the same `/companies` records this component manages.
//
// Originally lived inline inside Quotations.jsx as `CompanyManager` +
// `CompanyListModal`. Extracted here so the Admin → Master Data page can
// embed the same list/form without duplicating (and drifting from) the logic.
import React, { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { fetchCompanies as fetchCompanyRecords } from "@/lib/companies";
import { toast } from 'sonner';
import { mirrorBankToSettings } from '@/lib/bankSync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MiniLoader } from '@/components/ui/GifLoader.jsx';
import {
  Plus, Edit, Trash2, Building2, Landmark, Tag, Info, Mail, Phone,
  CreditCard, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react';

export const COMPANY_COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber:        '#F59E0B',
  coral:        '#EF4444',
  purple:       '#7C3AED',
};

const stringifyDetail = (d) => {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        const loc = Array.isArray(e.loc) ? e.loc.filter(x => x !== 'body').join('.') : '';
        return [loc, e.msg || e.message || ''].filter(Boolean).join(': ');
      }
      return String(e);
    }).filter(Boolean).join(' • ');
  }
  if (typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
  return String(d);
};
const getErrMsg = (err, fallback = 'Something went wrong') => {
  const data = err?.response?.data;
  if (!data) return err?.message || fallback;
  return stringifyDetail(data.detail) || stringifyDetail(data.message) || err?.message || fallback;
};

// ════════════════════════════════════════════════════════════════════════════════
// COMPANY MANAGER — add / edit form (name, address, GST/PAN, bank, logos, SMTP)
// ════════════════════════════════════════════════════════════════════════════════
export function CompanyManager({ onClose, onSaved, editingCompany }) {
  const [form, setForm] = useState({
    name: '', address: '', phone: '', email: '', website: '', gstin: '', pan: '',
    has_gst: true,
    bank_account_name: '', bank_name: '', bank_account_no: '', bank_ifsc: '',
    bank_branch: '', bank_account_type: 'Current', upi_id: '', upi_mcc: '',
    linked_bank_account_id: '',
    logo_base64: null, tm_logo_base64: null, signature_base64: null, upi_qr_image_base64: null,
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_password: '', smtp_from_name: '',
  });
  const [saving, setSaving] = useState(false);
  const [bankAccounts, setBankAccounts] = useState([]);
  const logoInputRef = useRef(null);
  const tmLogoInputRef = useRef(null);
  const sigInputRef  = useRef(null);
  const qrImageInputRef = useRef(null);

  useEffect(() => {
    if (editingCompany) {
      setForm({
        name: editingCompany.name || '',
        address: editingCompany.address || '',
        phone: editingCompany.phone || '',
        email: editingCompany.email || '',
        website: editingCompany.website || '',
        gstin: editingCompany.gstin || '',
        pan: editingCompany.pan || '',
        has_gst: editingCompany.has_gst !== false,
        bank_account_name: editingCompany.bank_account_name || '',
        bank_name: editingCompany.bank_name || '',
        bank_account_no: editingCompany.bank_account_no || '',
        bank_ifsc: editingCompany.bank_ifsc || '',
        bank_branch: editingCompany.bank_branch || '',
        bank_account_type: editingCompany.bank_account_type || 'Current',
        upi_id: editingCompany.upi_id || '',
        upi_mcc: editingCompany.upi_mcc || '',
        linked_bank_account_id: editingCompany.linked_bank_account_id || '',
        logo_base64: editingCompany.logo_base64 || null,
        tm_logo_base64: editingCompany.tm_logo_base64 || null,
        signature_base64: editingCompany.signature_base64 || null,
        upi_qr_image_base64: editingCompany.upi_qr_image_base64 || null,
        smtp_host: editingCompany.smtp_host || '',
        smtp_port: editingCompany.smtp_port || 587,
        smtp_user: editingCompany.smtp_user || '',
        smtp_password: editingCompany.smtp_password || '',
        smtp_from_name: editingCompany.smtp_from_name || '',
      });
    }
  }, [editingCompany]);

  useEffect(() => {
    const params = editingCompany?.id ? { company_id: editingCompany.id } : {};
    api.get('/bank-accounts/picker-list', { params })
      .then(r => setBankAccounts(r.data || []))
      .catch(() => {}); // silently ignore if user has no bank access
  }, [editingCompany]);

  const handleChange = e => setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));

  const handleFileChange = (e, field) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        // tm_logo_base64 is used as a full header in TM reports — allow larger size
        const MAX = field === 'tm_logo_base64' ? 900 : 400;
        const QUALITY = field === 'tm_logo_base64' ? 0.85 : 0.7;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        setForm(prev => ({ ...prev, [field]: canvas.toDataURL('image/jpeg', QUALITY) }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  // Separate from handleFileChange: QR codes must stay lossless (PNG, not JPEG) and
  // at higher resolution, since compression artifacts or heavy downscaling can corrupt
  // fine module detail and make the code unscannable. We only downscale if the source
  // image is unusually large, and never re-encode as lossy JPEG.
  const handleQrFileChange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 640;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          setForm(prev => ({ ...prev, upi_qr_image_base64: canvas.toDataURL('image/png') }));
        } else {
          // Small/already-appropriately-sized source — keep the original bytes as-is.
          setForm(prev => ({ ...prev, upi_qr_image_base64: reader.result }));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Company name is required'); return; }
    setSaving(true);
    try {
      const res = editingCompany
        ? await api.put(`/companies/${editingCompany.id}`, form)
        : await api.post('/companies', form);

      const companyId = editingCompany?.id || res.data?.id;
      if (companyId) {
        mirrorBankToSettings(companyId, {
          bank_account_holder: form.bank_account_name,
          bank_name: form.bank_name,
          bank_account_no: form.bank_account_no,
          bank_ifsc: form.bank_ifsc,
          bank_branch: form.bank_branch,
          bank_account_type: form.bank_account_type,
          upi_id: form.upi_id,
        });
      }

      toast.success(editingCompany ? 'Company updated' : 'Company created');
      onSaved(); onClose();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to save company')); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={true} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: COMPANY_COLORS.deepBlue }}>
            <Building2 className="h-5 w-5" />{editingCompany ? 'Edit Company Profile' : 'Create New Company Profile'}
          </DialogTitle>
          <DialogDescription>Manage company details, bank info, and SMTP settings.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 py-2 max-h-[60vh] overflow-y-auto pr-4">
          {/* ── Left column ── */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Info className="h-4 w-4" />Company Details</h4>
            {[
              { label: 'Company Name *', name: 'name',    type: 'text'  },
              { label: 'Phone',          name: 'phone',   type: 'text'  },
              { label: 'Email',          name: 'email',   type: 'email' },
              { label: 'Website',        name: 'website', type: 'text'  },
              { label: 'GSTIN',          name: 'gstin',   type: 'text'  },
              { label: 'PAN',            name: 'pan',     type: 'text'  },
            ].map(f => (
              <div key={f.name} className="space-y-1.5">
                <Label className="text-xs font-semibold">{f.label}</Label>
                <Input name={f.name} value={form[f.name]} onChange={handleChange} type={f.type} className="h-9 rounded-xl text-sm" />
              </div>
            ))}

            <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-slate-50">
              <div>
                <p className="text-xs font-semibold text-slate-700">GST Registered</p>
                <p className="text-[10px] text-slate-400 mt-0.5">Enables GST on invoices &amp; quotations</p>
              </div>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, has_gst: !p.has_gst }))}
                className={`relative inline-flex items-center w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${form.has_gst ? 'bg-emerald-500' : 'bg-slate-300'}`}
                aria-checked={form.has_gst}
                role="switch"
              >
                <span
                  className={`inline-block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${form.has_gst ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Address</Label>
              <Textarea name="address" value={form.address} onChange={handleChange} rows={2} className="resize-none rounded-xl text-sm" />
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><CreditCard className="h-4 w-4" />Bank Details</h4>

            {/* ── Link to a bank account from the Bank Accounts page ── */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <Landmark className="h-3.5 w-3.5" />Link Bank Account
                <span className="text-[10px] font-normal text-slate-400">(auto-fills fields below)</span>
              </Label>
              <Select
                value={form.linked_bank_account_id || '__none__'}
                onValueChange={v => {
                  if (v === '__none__') {
                    setForm(p => ({ ...p, linked_bank_account_id: '' }));
                    return;
                  }
                  const ba = bankAccounts.find(b => b.id === v);
                  if (ba) {
                    setForm(p => ({
                      ...p,
                      linked_bank_account_id: v,
                      bank_name:         ba.bank_name         || p.bank_name,
                      bank_account_name: ba.account_holder    || p.bank_account_name,
                      bank_account_no:   ba.account_number_full || ba.account_number_masked || p.bank_account_no,
                      bank_ifsc:         ba.ifsc               || p.bank_ifsc,
                      bank_branch:       ba.branch             || p.bank_branch,
                      bank_account_type: ba.account_type       || p.bank_account_type,
                      upi_id:            ba.upi_id             || p.upi_id,
                    }));
                  }
                }}
              >
                <SelectTrigger className="h-9 rounded-xl text-sm">
                  <SelectValue placeholder={bankAccounts.length ? 'Select a bank account…' : 'No bank accounts yet — add one in Bank Accounts page'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Not linked —</SelectItem>
                  {bankAccounts.map(ba => (
                    <SelectItem key={ba.id} value={ba.id}>
                      {ba.bank_name}{ba.account_number_masked ? ` · ${ba.account_number_masked}` : ''}{ba.account_holder ? ` (${ba.account_holder})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.linked_bank_account_id && (
                <p className="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Linked — bank fields auto-populated from Bank Accounts page
                </p>
              )}
            </div>

            {[
              { label: 'Account Name', name: 'bank_account_name' },
              { label: 'Bank Name',    name: 'bank_name'         },
              { label: 'Account No.',  name: 'bank_account_no'   },
              { label: 'IFSC Code',    name: 'bank_ifsc'         },
              { label: 'Branch',       name: 'bank_branch'       },
              { label: 'UPI ID',       name: 'upi_id'            },
            ].map(f => (
              <div key={f.name} className="space-y-1.5">
                <Label className="text-xs font-semibold">{f.label}</Label>
                <Input name={f.name} value={form[f.name]} onChange={handleChange} className="h-9 rounded-xl text-sm" />
              </div>
            ))}

            {/* ── Warning: Current/business accounts commonly reject plain P2P UPI QR pushes ──
                This is the #1 cause of "Receiver's bank does not allow payments to this bank
                account" on invoice QR scans. Surface it clearly instead of letting people find
                out from an angry client screenshot. */}
            {(form.bank_account_type || 'Current').trim().toLowerCase() === 'current'
              && !form.upi_qr_image_base64 && !form.upi_mcc && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-1">
                <p className="text-[11px] font-bold text-amber-700 flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5 flex-shrink-0" />
                  Payments on this invoice may get declined
                </p>
                <p className="text-[10.5px] text-amber-700 leading-snug">
                  This is a <strong>Current</strong> account with no bank-issued QR image or Merchant Category
                  Code set. Many banks reject a plain UPI transfer into a current account with
                  "Receiver's bank does not allow payments to this bank account" — they only accept
                  tagged merchant (P2M) payments. Fix it by uploading your bank's QR image below
                  (best), or at minimum set a Merchant Category Code.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Bank's UPI QR Code <span className="text-slate-400 font-normal">(recommended)</span></Label>
              <p className="text-[10px] text-slate-400 -mt-0.5">
                Upload the merchant QR image your bank generated (e.g. YONO SBI / BHIM SBI Pay). When set, invoices
                show this image instead of a QR we build ourselves — bank-issued QRs are registered merchant
                transactions and are far less likely to be declined by the receiving bank than a generic link-based QR.
              </p>
              <Input type="file" accept="image/*" onChange={handleQrFileChange} className="h-9 rounded-xl text-sm" ref={qrImageInputRef} />
              {form.upi_qr_image_base64 && (
                <div className="flex items-center gap-2">
                  <img src={form.upi_qr_image_base64} alt="UPI QR" className="h-16 w-16 object-contain rounded border bg-white p-1" />
                  <Button variant="outline" size="sm" onClick={() => { setForm(p => ({ ...p, upi_qr_image_base64: null })); if (qrImageInputRef.current) qrImageInputRef.current.value = ''; }}>Remove</Button>
                </div>
              )}
              {!form.upi_qr_image_base64 && (
                <p className="text-[10px] text-amber-600">No bank QR uploaded yet — invoices will fall back to a QR generated from the UPI ID above.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Merchant Category Code <span className="text-slate-400 font-normal">(strongly recommended for Current accounts)</span></Label>
              <p className="text-[10px] text-slate-400 -mt-0.5">
                Only used for the fallback QR when no bank QR image is uploaded above — tags it as a merchant (business)
                payment instead of a generic transfer, which Current accounts typically require to accept UPI at all.
                Your bank can confirm this code if your UPI ID is merchant-registered. If left blank on a Current
                account, we'll default to 8931 (Accounting/Bookkeeping/Tax services) so the QR isn't sent untagged.
              </p>
              <Input name="upi_mcc" value={form.upi_mcc} onChange={handleChange} placeholder="e.g. 8931" className="h-9 rounded-xl text-sm" />
            </div>

            <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mt-4"><Tag className="h-4 w-4" />Logo &amp; Signature</h4>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Company Logo <span className="text-slate-400 font-normal">(Invoice / Quotation)</span></Label>
              <Input type="file" accept="image/*" onChange={e => handleFileChange(e, 'logo_base64')} className="h-9 rounded-xl text-sm" ref={logoInputRef} />
              {form.logo_base64 && (
                <div className="flex items-center gap-2">
                  <img src={form.logo_base64} alt="Logo" className="h-12 object-contain rounded border" />
                  <Button variant="outline" size="sm" onClick={() => { setForm(p => ({ ...p, logo_base64: null })); if (logoInputRef.current) logoInputRef.current.value = ''; }}>Remove</Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Full Logo <span className="text-slate-400 font-normal">(TM Reports &amp; other documents)</span></Label>
              <p className="text-[10px] text-slate-400 -mt-0.5">Upload the full horizontal logo with company name — used as the header in trademark reports.</p>
              <Input type="file" accept="image/*" onChange={e => handleFileChange(e, 'tm_logo_base64')} className="h-9 rounded-xl text-sm" ref={tmLogoInputRef} />
              {form.tm_logo_base64 && (
                <div className="flex items-center gap-2">
                  <img src={form.tm_logo_base64} alt="TM Logo" className="h-12 object-contain rounded border bg-slate-50 px-2" />
                  <Button variant="outline" size="sm" onClick={() => { setForm(p => ({ ...p, tm_logo_base64: null })); if (tmLogoInputRef.current) tmLogoInputRef.current.value = ''; }}>Remove</Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Signature</Label>
              <Input type="file" accept="image/*" onChange={e => handleFileChange(e, 'signature_base64')} className="h-9 rounded-xl text-sm" ref={sigInputRef} />
              {form.signature_base64 && (
                <div className="flex items-center gap-2">
                  <img src={form.signature_base64} alt="Signature" className="h-12 object-contain rounded border" />
                  <Button variant="outline" size="sm" onClick={() => { setForm(p => ({ ...p, signature_base64: null })); if (sigInputRef.current) sigInputRef.current.value = ''; }}>Remove</Button>
                </div>
              )}
            </div>

            <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mt-4"><Mail className="h-4 w-4" />SMTP Settings</h4>
            {[
              { label: 'SMTP Host',    name: 'smtp_host',      type: 'text'     },
              { label: 'SMTP Port',    name: 'smtp_port',      type: 'number'   },
              { label: 'SMTP User',    name: 'smtp_user',      type: 'text'     },
              { label: 'SMTP Password',name: 'smtp_password',  type: 'password' },
              { label: 'From Name',    name: 'smtp_from_name', type: 'text'     },
            ].map(f => (
              <div key={f.name} className="space-y-1.5">
                <Label className="text-xs font-semibold">{f.label}</Label>
                <Input name={f.name} value={form[f.name]} onChange={handleChange} type={f.type} className="h-9 rounded-xl text-sm" />
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-xl gap-2" style={{ background: COMPANY_COLORS.deepBlue }}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : `${editingCompany ? 'Update' : 'Create'} Company`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// COMPANY PROFILES LIST — inline (non-modal) list of company records.
// Used directly on the page (e.g. Admin → Master Data). Reuses CompanyManager
// for add/edit, which still opens as a dialog on top of the page.
// ════════════════════════════════════════════════════════════════════════════════
export function CompanyProfilesList({ onRefresh, dense = false, onFormOpenChange }) {
  const [companies,   setCompanies]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [editingCompany, setEditingCompany] = useState(null);
  const [showForm,    setShowForm]    = useState(false);
  const [deletingId,  setDeletingId]  = useState(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState([]);
  const [companyPage, setCompanyPage] = useState(1);
  const [companyBulkBusy, setCompanyBulkBusy] = useState(false);
  const COMPANY_PAGE_SIZE = 10;

  useEffect(() => { onFormOpenChange?.(showForm); }, [showForm]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCompanies = async () => {
    setLoading(true);
    try {
      const records = await fetchCompanyRecords({ silent: false });
      setCompanies(records);
    } catch (err) { toast.error(getErrMsg(err, 'Failed to load companies')); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchCompanies(); }, []);

  useEffect(() => { setCompanyPage(1); setSelectedCompanyIds([]); }, [companies.length]);
  useEffect(() => { const max = Math.max(1, Math.ceil(companies.length / COMPANY_PAGE_SIZE)); if (companyPage > max) setCompanyPage(max); }, [companies.length, companyPage]);

  const companyPageCount = Math.max(1, Math.ceil(companies.length / COMPANY_PAGE_SIZE));
  const paginatedCompanies = companies.slice((companyPage - 1) * COMPANY_PAGE_SIZE, companyPage * COMPANY_PAGE_SIZE);
  const pageCompanyIds = paginatedCompanies.map(c => c.id);
  const allPageCompaniesSelected = pageCompanyIds.length > 0 && pageCompanyIds.every(id => selectedCompanyIds.includes(id));
  const toggleCompanySelection = (id) => setSelectedCompanyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleAllPageCompanies = () => setSelectedCompanyIds(prev => allPageCompaniesSelected ? prev.filter(id => !pageCompanyIds.includes(id)) : [...new Set([...prev, ...pageCompanyIds])]);
  const bulkDeleteCompanies = async () => {
    if (!selectedCompanyIds.length || companyBulkBusy) return;
    if (!window.confirm(`Delete ${selectedCompanyIds.length} selected company profile${selectedCompanyIds.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setCompanyBulkBusy(true);
    try {
      const results = await Promise.allSettled(selectedCompanyIds.map(id => api.delete(`/companies/${encodeURIComponent(id)}`)));
      const failed = results.filter(r => r.status === 'rejected').length;
      const deleted = results.length - failed;
      if (deleted) toast.success(`${deleted} compan${deleted === 1 ? 'y' : 'ies'} deleted successfully`);
      if (failed) toast.error(`${failed} compan${failed === 1 ? 'y' : 'ies'} could not be deleted`);
      setSelectedCompanyIds([]);
      await fetchCompanies();
      onRefresh?.();
    } finally { setCompanyBulkBusy(false); }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete company "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await api.delete(`/companies/${id}`);
      toast.success('Company deleted');
      fetchCompanies();
      onRefresh?.();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to delete')); }
    finally { setDeletingId(null); }
  };

  return (
    <div className={dense ? '' : 'space-y-3'}>
      {dense ? (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: COMPANY_COLORS.deepBlue }}>
              <Building2 className="h-4 w-4" />Company Profiles
              <Badge className="bg-blue-100 text-blue-700">{companies.length}</Badge>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Name, address, GSTIN/PAN, bank details, logos &amp; SMTP — used across Quotations, Invoicing,
              Trademark Sphere, WhatsApp/Email settings and GST Portal Sync.
            </p>
          </div>
          <Button onClick={() => { setEditingCompany(null); setShowForm(true); }} className="rounded-xl gap-2 flex-shrink-0" style={{ background: COMPANY_COLORS.emeraldGreen }}>
            <Plus className="h-4 w-4" />Add Company
          </Button>
        </div>
      ) : (
        <div className="master-data-blue-header">
          <div className="flex items-center gap-3">
            <div className="master-data-blue-header-icon"><Building2 /></div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold">Company Profiles</h3>
                <Badge className="master-data-blue-header-badge">{companies.length}</Badge>
              </div>
              <p className="text-xs mt-1">
                Name, address, GSTIN/PAN, bank details, logos &amp; SMTP — used across Quotations, Invoicing,
                Trademark Sphere, WhatsApp/Email settings and GST Portal Sync.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0"><Button variant="outline" onClick={toggleAllPageCompanies} disabled={!paginatedCompanies.length} className="h-9 rounded-none master-data-blue-header-btn-outline">{allPageCompaniesSelected ? "Clear Page" : "Select Page"}</Button>{selectedCompanyIds.length > 0 && <Button variant="outline" onClick={bulkDeleteCompanies} disabled={companyBulkBusy} className="h-9 rounded-none text-red-600 border-red-200 hover:bg-red-50">{companyBulkBusy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin"/> : <Trash2 className="h-4 w-4 mr-1.5"/>}Delete Selected ({selectedCompanyIds.length})</Button>}<Button onClick={() => { setEditingCompany(null); setShowForm(true); }} className="h-9 rounded-none master-data-blue-header-btn-solid flex-shrink-0">
            <Plus className="h-4 w-4 mr-1.5" />Add Company
          </Button>
        </div>
        </div>
      )}

      {loading
        ? <MiniLoader height={120} />
        : companies.length === 0
          ? (
            <div className={`text-center py-10 text-slate-400 border border-dashed border-slate-200 ${dense ? 'rounded-xl' : 'rounded-none'}`}>
              <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No companies added yet.</p>
            </div>
          )
          : (
            <div className="space-y-3">
              {paginatedCompanies.map(company => (
                <div key={company.id} className={`flex items-start gap-4 p-4 border border-slate-200 hover:border-blue-200 hover:bg-blue-50/30 transition-colors ${dense ? 'rounded-xl' : 'rounded-none'}`}>
                  <div className="flex items-start gap-3 flex-1 min-w-0"><input type="checkbox" aria-label={`Select ${company.name || "company"}`} checked={selectedCompanyIds.includes(company.id)} onChange={() => toggleCompanySelection(company.id)} className="mt-1.5 h-4 w-4 accent-[#0D3B66]" /><div className={`w-12 h-12 bg-slate-100 flex-shrink-0 flex items-center justify-center overflow-hidden ${dense ? 'rounded-xl' : 'rounded-none'}`}>
                    {company.logo_base64 ? <img src={company.logo_base64} alt="logo" className="w-full h-full object-contain" /> : <Building2 className="h-5 w-5 text-slate-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{company.name}</p>
                    {company.address && <p className="text-xs text-slate-400 mt-0.5 truncate">{company.address}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-slate-500">
                      {company.gstin && <span>GSTIN: {company.gstin}</span>}
                      {company.pan && <span>PAN: {company.pan}</span>}
                      <span className={`inline-flex items-center gap-1 font-semibold ${company.has_gst === false ? 'text-amber-600' : 'text-emerald-600'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${company.has_gst === false ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                        {company.has_gst === false ? 'GST Not Registered' : 'GST Registered'}
                      </span>
                      {company.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{company.phone}</span>}
                      {company.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{company.email}</span>}
                    </div>
                    {(company.bank_name || company.bank_account_no) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-slate-500">
                        {company.bank_name && <span className="flex items-center gap-1"><Landmark className="h-3 w-3" />{company.bank_name}</span>}
                        {company.bank_account_no && <span>A/C: {company.bank_account_no}</span>}
                        {company.bank_ifsc && <span>IFSC: {company.bank_ifsc}</span>}
                      </div>
                    )}
                    <div className="flex items-center gap-1 mt-1">
                      {company.smtp_host ? <Badge className="text-[10px] px-2 py-0 bg-green-50 text-green-700 border-green-200">Email Ready</Badge> : <Badge className="text-[10px] px-2 py-0 bg-amber-50 text-amber-700 border-amber-200">SMTP Not Set</Badge>}
                      {company.logo_base64 && <Badge className="text-[10px] px-2 py-0 bg-blue-50 text-blue-700 border-blue-200">Has Logo</Badge>}
                      {company.tm_logo_base64 && <Badge className="text-[10px] px-2 py-0 bg-violet-50 text-violet-700 border-violet-200">Has TM Logo</Badge>}
                      {(company.bank_name || company.bank_account_no) && <Badge className="text-[10px] px-2 py-0 bg-teal-50 text-teal-700 border-teal-200">Bank Linked</Badge>}
                    </div>
                  </div></div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={() => { setEditingCompany(company); setShowForm(true); }} className={`gap-1 text-blue-600 border-blue-200 hover:bg-blue-50 ${dense ? 'rounded-lg' : 'rounded-none'}`}><Edit className="h-3.5 w-3.5" />Edit</Button>
                    <Button variant="outline" size="sm" onClick={() => handleDelete(company.id, company.name)} disabled={deletingId === company.id} className={`gap-1 text-red-600 border-red-200 hover:bg-red-50 ${dense ? 'rounded-lg' : 'rounded-none'}`}>
                      {deletingId === company.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}Delete
                    </Button>
                  </div>
                </div>
              ))}
              {companyPageCount > 1 && <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-1 text-xs text-slate-500">
                <span>Showing {(companyPage - 1) * COMPANY_PAGE_SIZE + 1}–{Math.min(companyPage * COMPANY_PAGE_SIZE, companies.length)} of {companies.length}</span>
                <div className="flex items-center gap-1"><Button variant="outline" size="icon" className="h-8 w-8 rounded-none" disabled={companyPage === 1} onClick={() => { setCompanyPage(p => p - 1); setSelectedCompanyIds([]); }}><ChevronLeft className="h-4 w-4"/></Button><span className="px-2 font-semibold">Page {companyPage} of {companyPageCount}</span><Button variant="outline" size="icon" className="h-8 w-8 rounded-none" disabled={companyPage === companyPageCount} onClick={() => { setCompanyPage(p => p + 1); setSelectedCompanyIds([]); }}><ChevronRight className="h-4 w-4"/></Button></div>
              </div>}
            </div>
          )
      }

      {showForm && (
        <CompanyManager
          editingCompany={editingCompany}
          onClose={() => { setShowForm(false); setEditingCompany(null); }}
          onSaved={() => { fetchCompanies(); onRefresh?.(); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// COMPANY LIST MODAL — dialog wrapper around CompanyProfilesList, kept for
// call sites (e.g. Quotations.jsx) that open company management as a popup.
// ════════════════════════════════════════════════════════════════════════════════
export function CompanyListModal({ open, onClose, onRefresh }) {
  const [formOpen, setFormOpen] = useState(false);
  return (
    <Dialog open={open && !formOpen} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: COMPANY_COLORS.deepBlue }}>
            <Building2 className="h-5 w-5" />Company Profiles
          </DialogTitle>
          <DialogDescription>Manage company profiles used in quotations and invoices.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto pr-1">
          <CompanyProfilesList onRefresh={onRefresh} dense onFormOpenChange={setFormOpen} />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose} className="rounded-xl">Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
