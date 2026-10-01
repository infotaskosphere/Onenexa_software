import React, { useState, useEffect, useRef, useCallback } from 'react';
import GifLoader, { MiniLoader } from "@/components/ui/GifLoader.jsx";
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { toast } from 'sonner';
import {
  Plus, Edit, Trash2, AlertCircle, ArrowDownCircle, ArrowUpCircle,
  History, Search, ArrowUpDown, Printer, CheckSquare, Square,
  MinusSquare, XCircle, Key, Shield, Clock, TrendingDown,
  Sparkles, Loader2, Share2, Mail, MessageCircle, Download, Eye,
  Usb, ChevronDown, ChevronUp, CheckCircle2, Lock, Bell, BellOff,
  Zap, Settings2, Phone, Send, Timer, RefreshCw
} from 'lucide-react';
import html2canvas from 'html2canvas';
import { format } from 'date-fns';
import { detectDscDuplicates } from '@/lib/aiDuplicateEngine';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';
import WhatsAppSendDialog from '@/components/ui/WhatsAppSendDialog';
import {
  readCertFromUsbToken,
  readCertFromWebSmartCard,
  isWebSmartCardSupported,
  parseCertificateFile,
  checkLocalAgent,
  readCertFromLocalAgent,
  diagnoseDscReader,
} from '@/lib/dscTokenReader';

const DSC_AGENT_ENDPOINT = (import.meta.env?.VITE_DSC_AGENT_URL || 'http://127.0.0.1:7432').replace(/\/+$/, '');

// ─── Print styles ─────────────────────────────────────────────────────────────
const PRINT_STYLE = `
@media print {
  body * { visibility: hidden !important; }
  #dsc-print-area, #dsc-print-area * { visibility: visible !important; }
  #dsc-print-area { position: fixed; inset: 0; padding: 24px; background: #fff; }
  @page { margin: 16mm; }
}`;

// ─── USB Popup animation styles ───────────────────────────────────────────────
const USB_POPUP_STYLE = `
@keyframes dscSlideUp {
  from { transform: translateY(32px) scale(0.97); opacity: 0; }
  to   { transform: translateY(0)    scale(1);    opacity: 1; }
}
@keyframes dscPulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
@keyframes dscSpin {
  to { transform: rotate(360deg); }
}`;

// ─── Row highlight colours based on expiry ────────────────────────────────────
function getRowHighlight(expiryDate, isDark) {
  const daysLeft = Math.ceil((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0)   return isDark ? 'bg-red-950/40'    : 'bg-red-50';
  if (daysLeft <= 7)  return isDark ? 'bg-orange-950/40' : 'bg-orange-100';
  if (daysLeft <= 30) return isDark ? 'bg-yellow-950/30' : 'bg-yellow-50';
  return '';
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function PaginationBar({ currentPage, totalPages, totalItems, pageSize, onPageChange, isDark }) {
  if (totalPages <= 1) return null;
  const pageStart = (currentPage - 1) * pageSize;
  const pageWindow = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 4) return [1, 2, 3, 4, 5, '…', totalPages];
    if (currentPage >= totalPages - 3) return [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, '…', currentPage - 1, currentPage, currentPage + 1, '…', totalPages];
  })();
  const dimBg    = isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9';
  const dimHover = isDark ? 'rgba(255,255,255,0.12)' : '#e2e8f0';
  const btnBase  = { width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, transition: 'background 0.12s' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}`, background: isDark ? '#1e293b' : '#F8FAFC', flexShrink: 0 }}>
      <p style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', margin: 0 }}>
        <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{pageStart + 1}–{Math.min(pageStart + pageSize, totalItems)}</span>{' '}of{' '}
        <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{totalItems}</span> records
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button disabled={currentPage === 1} onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          style={{ ...btnBase, background: dimBg, color: currentPage === 1 ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), opacity: currentPage === 1 ? 0.4 : 1 }}
          onMouseEnter={e => { if (currentPage !== 1) e.currentTarget.style.background = dimHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = dimBg; }}>‹</button>
        {pageWindow.map((p, i) => p === '…'
          ? <span key={`e${i}`} style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: isDark ? '#475569' : '#94a3b8' }}>…</span>
          : <button key={p} onClick={() => onPageChange(p)}
              style={{ ...btnBase, fontSize: 11, fontWeight: p === currentPage ? 700 : 500, background: p === currentPage ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : dimBg, color: p === currentPage ? '#fff' : (isDark ? '#94a3b8' : '#64748b'), boxShadow: p === currentPage ? '0 2px 8px rgba(79,70,229,0.35)' : 'none' }}
              onMouseEnter={e => { if (p !== currentPage) e.currentTarget.style.background = dimHover; }}
              onMouseLeave={e => { if (p !== currentPage) e.currentTarget.style.background = dimBg; }}>{p}</button>
        )}
        <button disabled={currentPage === totalPages} onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          style={{ ...btnBase, background: dimBg, color: currentPage === totalPages ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), opacity: currentPage === totalPages ? 0.4 : 1 }}
          onMouseEnter={e => { if (currentPage !== totalPages) e.currentTarget.style.background = dimHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = dimBg; }}>›</button>
      </div>
      <p style={{ fontSize: 11, color: isDark ? '#475569' : '#cbd5e1', margin: 0 }}>Page {currentPage} / {totalPages}</p>
    </div>
  );
}

// ─── WhatsApp Message Template Settings ───────────────────────────────────────
const DEFAULT_WA_SETTINGS = {
  senderName: 'TaskOsphere Command Center',
  greetingPrefix: 'Dear',
  showSerialNumber: true,
  showOrganisation: true,
  footerNote: 'Please arrange for renewal at the earliest to avoid any disruption in filing and compliance activities.',
  expiredFooterNote: 'Please renew your DSC immediately to avoid any inconvenience in filing and compliance activities.',
};

function getWASettings() {
  try { return { ...DEFAULT_WA_SETTINGS, ...JSON.parse(localStorage.getItem('dsc_wa_msg_settings') || '{}') }; }
  catch { return DEFAULT_WA_SETTINGS; }
}

// ─── Build WhatsApp expiry alert message ──────────────────────────────────────
// NOTE: Emoji are pasted as literal characters so they survive URL-encoding
// and render correctly in both WhatsApp Web and the mobile app.
function buildExpiryAlertText(dsc, customSettings) {
  const s = customSettings || getWASettings();
  const daysLeft = Math.ceil((new Date(dsc.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
  const isExpired = daysLeft < 0;
  const expiryStr = format(new Date(dsc.expiry_date), 'dd MMM yyyy');
  const bell   = '\uD83D\uDD14'; // 🔔
  const siren  = '\uD83D\uDEA8'; // 🚨
  const warn   = '\u26A0\uFE0F'; // ⚠️
  const clock  = '\uD83D\uDD50'; // 🕐
  const clip   = '\uD83D\uDCCB'; // 📋
  const bullet = '\u2022';       // •  (plain bullet — works in WA)
  const dash   = '\u2014';       // —

  return [
    isExpired
      ? `${siren} *DSC Expiry Alert*`
      : `${bell} *DSC Expiring Soon Alert*`,
    ``,
    `${s.greetingPrefix} *${dsc.holder_name}*,`,
    ``,
    isExpired
      ? `${warn} Your Digital Signature Certificate (DSC) *has expired* on ${expiryStr}.`
      : `${clock} Your Digital Signature Certificate (DSC) is expiring in *${daysLeft} day${daysLeft !== 1 ? 's' : ''}* on *${expiryStr}*.`,
    ``,
    `${clip} *Certificate Details:*`,
    `${bullet} Type: ${dsc.dsc_type || 'Standard'}`,
    (s.showOrganisation && dsc.associated_with) ? `${bullet} Organisation: ${dsc.associated_with}` : null,
    (s.showSerialNumber && dsc.serial_number)   ? `${bullet} Serial No: ${dsc.serial_number}` : null,
    `${bullet} Expiry Date: ${expiryStr}`,
    ``,
    isExpired ? s.expiredFooterNote : s.footerNote,
    ``,
    `${dash} ${s.senderName}`,
  ].filter(line => line !== null).join('\n');
}

// ─── DSC Table ────────────────────────────────────────────────────────────────
function DSCTable({ dscList, onEdit, onDelete, onMovement, onViewLog, getDSCStatus, type, globalIndexStart, isDark, selectedIds, onToggleSelect, onToggleAll, onWhatsAppAlert }) {
  const allSelected  = dscList.length > 0 && dscList.every(d => selectedIds.has(d.id));
  const someSelected = dscList.some(d => selectedIds.has(d.id)) && !allSelected;

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full table-fixed border-collapse" style={{minWidth:700}}>
        <colgroup>
          <col style={{ width: 36 }} />
          <col style={{ width: 40 }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: 100 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: 128 }} />
        </colgroup>
        <thead className={`border-b ${isDark ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
          <tr>
            <th className="px-2 py-2.5">
              <button onClick={() => onToggleAll(dscList)} className="flex items-center justify-center">
                {allSelected
                  ? <CheckSquare className="h-4 w-4 text-indigo-500" />
                  : someSelected
                    ? <MinusSquare className="h-4 w-4 text-indigo-400" />
                    : <Square className="h-4 w-4 text-slate-400" />}
              </button>
            </th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>#</th>
            <th className={`px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Holder Name</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Type</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Associated With</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Expiry</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Status</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Last Movement</th>
            <th className={`px-2 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Actions</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${isDark ? 'divide-slate-700/60' : 'divide-slate-100'}`}>
          {dscList.map((dsc, index) => {
            const status      = getDSCStatus(dsc.expiry_date);
            const highlight   = getRowHighlight(dsc.expiry_date, isDark);
            const isSelected = selectedIds.has(dsc.id);
            const lastMove   = dsc.movement_log?.length > 0 ? dsc.movement_log[dsc.movement_log.length - 1] : null;

            return (
              <tr key={dsc.id}
                onClick={() => onViewLog(dsc)}
                className={`transition-colors cursor-pointer ${highlight} ${isSelected ? (isDark ? 'ring-1 ring-inset ring-indigo-500' : 'ring-1 ring-inset ring-indigo-300') : ''} ${isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'}`}
                title="Click to view full DSC details"
                data-testid={`dsc-row-${dsc.id}`}>
                <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onToggleSelect(dsc.id)} className="flex items-center justify-center">
                    {isSelected ? <CheckSquare className="h-4 w-4 text-indigo-500" /> : <Square className="h-4 w-4 text-slate-400" />}
                  </button>
                </td>
                <td className={`px-2 py-2.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{globalIndexStart + index + 1}</td>
                <td className={`px-3 py-2.5 text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`} title={dsc.holder_name}>{dsc.holder_name}</td>
                <td className={`px-2 py-2.5 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`} title={dsc.dsc_type || ''}>{dsc.dsc_type || '—'}</td>
                <td className={`px-2 py-2.5 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`} title={dsc.associated_with || ''}>{dsc.associated_with || '—'}</td>
                <td className={`px-2 py-2.5 text-xs whitespace-nowrap font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{format(new Date(dsc.expiry_date), 'MMM dd, yy')}</td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status.color}`} />
                    <span className={`text-[11px] font-semibold leading-none ${status.textColor}`}>{status.text}</span>
                  </div>
                </td>
                <td className="px-2 py-2.5">
                  {lastMove ? (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <Badge className={`text-[9px] px-1 py-0 font-semibold leading-tight ${lastMove.movement_type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {lastMove.movement_type}
                        </Badge>
                        <span className={`text-[11px] font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{lastMove.person_name}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-400 italic">No movement</span>
                  )}
                </td>
                <td className="px-1 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-0">
                    <Button variant="ghost" size="sm" onClick={() => onViewLog(dsc)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-slate-600' : 'hover:bg-slate-100'}`} title="View Details & Share">
                      <Eye className="h-3.5 w-3.5 text-indigo-500" />
                    </Button>
                    {onWhatsAppAlert && (
                      <Button variant="ghost" size="sm" onClick={() => onWhatsAppAlert(dsc)}
                        className={`h-7 w-7 p-0 hover:bg-emerald-50 text-emerald-600`}
                        title="Send WhatsApp expiry alert to DSC holder">
                        <MessageCircle className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => onMovement(dsc, type === 'IN' ? 'OUT' : 'IN')}
                      className={`h-7 w-7 p-0 ${type === 'IN' ? 'hover:bg-red-50 text-red-600' : 'hover:bg-emerald-50 text-emerald-600'}`}
                      title={type === 'IN' ? 'Mark as OUT' : 'Mark as IN'}>
                      {type === 'IN' ? <ArrowUpCircle className="h-3.5 w-3.5" /> : <ArrowDownCircle className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(dsc)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-indigo-900/30' : 'hover:bg-indigo-50'} text-indigo-500`}>
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onDelete(dsc.id)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-red-900/30' : 'hover:bg-red-50'} text-red-500`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Guess DSC type from device info ─────────────────────────────────────────
function guessDscType(device) {
  if (!device) return 'Class 3';
  const combined = [device.productName || '', device.manufacturerName || ''].join(' ').toLowerCase();
  if (combined.includes('class 3') || combined.includes('cl3'))  return 'Class 3';
  if (combined.includes('class 2') || combined.includes('cl2'))  return 'Class 2';
  if (combined.includes('encrypt'))                              return 'Encryption';
  if (combined.includes('sign'))                                 return 'Signature';
  if (combined.includes('combo'))                                return 'Combo';
  return 'Class 3';   // safe default for India DSC tokens
}

// ─── Default expiry (2 years from today) ─────────────────────────────────────
function defaultExpiry() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return format(d, 'yyyy-MM-dd');
}

function todayStr() {
  return format(new Date(), 'yyyy-MM-dd');
}

// ─── Entity type options ─────────────────────────────────────────────────────
// Mirrors CLIENT_TYPES in src/pages/Clients.jsx. "Firm (in-house)" and the
// generic "Client (any)" have been removed — every DSC must be linked to a
// real client (or "Other" with a manually-typed entity name).
const ENTITY_TYPE_OPTIONS = [
  { value: 'proprietor',  label: 'Proprietor' },
  { value: 'pvt_ltd',     label: 'Private Limited' },
  { value: 'llp',         label: 'LLP' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'huf',         label: 'HUF' },
  { value: 'trust',       label: 'Trust' },
  { value: 'other',       label: 'Other' },
];

// ─── USB DSC Popup Component ──────────────────────────────────────────────────
function UsbDscPopup({ device, isDark, onDismiss, onSaved, clients = [] }) {
  const [saving, setSaving]             = useState(false);
  const [saved,  setSaved]              = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Whether the current "Associated With" value is a free-text "Other" entry
  // (vs. a client picked from the dropdown).
  const [assocOther, setAssocOther] = useState(false);

  // Certificate reading state
  const [pin,          setPin]          = useState('');
  const [reading,      setReading]      = useState(false);
  const [readError,    setReadError]    = useState('');
  const [certFetched,  setCertFetched]  = useState(false);
  const certFileRef = useRef(null);
  const [agentAutoFetching, setAgentAutoFetching] = useState(false);
  const [agentConnected,   setAgentConnected]   = useState(false); // v5: agent reachable
  const [autoFillDone,     setAutoFillDone]     = useState(false); // v5: autofill succeeded

  const [form, setForm] = useState({
    holder_name:     '',
    dsc_type:        guessDscType(device),
    dsc_password:    '',
    serial_number:   '',
    associated_with: '',
    entity_type:     'proprietor',
    mobile:          '',
    email:           '',
    issue_date:      todayStr(),
    expiry_date:     defaultExpiry(),
    notes:           device ? [
      device.productName      ? `Device: ${device.productName}`      : null,
      device.manufacturerName ? `Maker: ${device.manufacturerName}`   : null,
      device.vendorId         ? `VID: 0x${device.vendorId.toString(16).toUpperCase().padStart(4,'0')}` : null,
    ].filter(Boolean).join(' · ') : '',
  });

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  // "Other" entity type → user types a custom entity name.
  const isOtherEntity = form.entity_type === 'other';

  // Associated With is ALWAYS a dropdown of every client created on the
  // Clients page, plus an "Other" option for free-text entry.
  const filteredClients = React.useMemo(() => {
    if (!Array.isArray(clients)) return [];
    return clients;
  }, [clients]);

  // When entity type changes, clear associated_with if the current pick is
  // no longer valid (e.g. switched to "Other" → keep manual entry going).
  useEffect(() => {
    if (assocOther) return;
    if (!form.associated_with) return;
    const stillThere = filteredClients.some(c => c.company_name === form.associated_with);
    if (!stillThere) setForm(prev => ({ ...prev, associated_with: '' }));
  }, [form.entity_type]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── v5: Only check whether the local DSC Agent is reachable. We DO NOT
  //   auto-fill any data on mount — the user must explicitly click "Fetch Data"
  //   (with their token PIN) or the "↻ Re-fetch" button. This prevents stale /
  //   wrong data (e.g. a previous user's email) from auto-populating the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const agentOk = await checkLocalAgent();
        if (!cancelled && agentOk) setAgentConnected(true);
      } catch { /* agent not running — silent */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── v5: Apply structured autofill from /dsc-autofill (direct field mapping) ──
  const applyAutofill = (fields) => {
    setForm(prev => ({
      ...prev,
      holder_name:     fields.holder_name     || prev.holder_name,
      serial_number:   fields.serial_number   || prev.serial_number,
      issue_date:      fields.issue_date      || prev.issue_date,
      expiry_date:     fields.expiry_date     || prev.expiry_date,
      associated_with: fields.associated_with || prev.associated_with,
      dsc_type:        fields.dsc_type        || prev.dsc_type,
      notes: [
        prev.notes,
        fields.issuer ? `Issuer: ${fields.issuer}` : null,
        fields.email  ? `Email: ${fields.email}`   : null,
        fields.pan    ? `PAN: ${fields.pan}`        : null,
      ].filter(Boolean).join('\n'),
    }));
    setCertFetched(true);
  };

  // ── Apply parsed cert data to form (legacy /dsc-status path) ─────────────────
  const applyCert = (cert) => {
    setForm(prev => ({
      ...prev,
      holder_name:     cert.holder_name                             || prev.holder_name,
      serial_number:   cert.serial_number                           || prev.serial_number,
      issue_date:      cert.issue_date                              || prev.issue_date,
      expiry_date:     cert.expiry_date                             || prev.expiry_date,
      associated_with: cert.associated_with || cert.organization    || prev.associated_with,
      dsc_type:        cert.dsc_type                                || prev.dsc_type,
      notes: [
        prev.notes,
        cert.issuer ? `Issuer: ${cert.issuer}` : null,
        cert.email  ? `Email: ${cert.email}`   : null,
        cert.pan    ? `PAN: ${cert.pan}`        : null,
      ].filter(Boolean).join('\n'),
    }));
    setCertFetched(true);
  };

  // ── 4-Tier certificate reading strategy ──────────────────────────────────────
  // Tier 1: navigator.smartCard  — Chrome PC/SC API (Windows + fixed API shape)
  // Tier 2: Local DSC Agent      — node process on localhost:7432 (most reliable on Windows)
  // Tier 3: WebUSB + CCID        — direct USB (Linux/Mac only)
  // Tier 4: File upload fallback — always works (.cer export from mToken Manager)
  const handleReadCertificate = async () => {
    if (!pin.trim()) { setReadError('Enter the token PIN first.'); return; }
    setReading(true);
    setReadError('');

    const tierErrors = [];

    // ── TIER 1: navigator.smartCard (Chrome 114+ on Windows) ─────────────────
    if (isWebSmartCardSupported()) {
      console.log('[DSC] Tier 1: trying navigator.smartCard…');
      try {
        const cert = await readCertFromWebSmartCard(pin.trim());
        if (cert && cert.holder_name) {
          applyCert(cert);
          toast.success(`Certificate read from token ✓ (method: ${cert.read_method})`);
          setReading(false);
          return;
        }
        tierErrors.push('Tier 1 (smartCard): no certificate found');
      } catch (err) {
        console.warn('[DSC] Tier 1 smartCard error:', err.message);
        // PIN / block errors are definitive — stop here
        if (err?.message?.includes('PIN') || err?.message?.includes('blocked') || err?.message?.includes('attempt')) {
          setReadError(err.message);
          setReading(false);
          return;
        }
        tierErrors.push(`Tier 1 (smartCard): ${err.message}`);
      }
    } else {
      tierErrors.push('Tier 1 (smartCard): not available in this browser');
      console.log('[DSC] Tier 1: navigator.smartCard not supported, skipping');
    }

    // ── TIER 2: Local DSC Agent (node on localhost:7432) ──────────────────────
    console.log('[DSC] Tier 2: checking local DSC agent…');
    const agentRunning = await checkLocalAgent();
    if (agentRunning) {
      try {
        const cert = await readCertFromLocalAgent(pin.trim());
        if (cert && cert.holder_name) {
          applyCert(cert);
          toast.success('Certificate read via local agent ✓');
          setReading(false);
          return;
        }
        tierErrors.push('Tier 2 (local agent): no certificate found');
      } catch (err) {
        console.warn('[DSC] Tier 2 local agent error:', err.message);
        if (err?.message?.includes('PIN') || err?.message?.includes('blocked') || err?.message?.includes('Incorrect')) {
          setReadError(err.message);
          setReading(false);
          return;
        }
        tierErrors.push(`Tier 2 (local agent): ${err.message}`);
      }
    } else {
      tierErrors.push('Tier 2 (local agent): not running on localhost:7432');
      console.log('[DSC] Tier 2: local agent not running');
    }

    // ── TIER 3: WebUSB + CCID (Linux / Mac) ───────────────────────────────────
    if (device) {
      console.log('[DSC] Tier 3: trying WebUSB…');
      try {
        if (!device.opened) await device.open();
        const cert = await readCertFromUsbToken(device, pin.trim());
        if (cert && cert.holder_name) {
          applyCert(cert);
          toast.success('Certificate read via WebUSB ✓');
          setReading(false);
          return;
        }
        tierErrors.push('Tier 3 (WebUSB): no certificate found');
      } catch (err) {
        console.warn('[DSC] Tier 3 WebUSB error:', err.message);
        tierErrors.push(`Tier 3 (WebUSB): ${err.message}`);
      }
    } else {
      tierErrors.push('Tier 3 (WebUSB): no USB device available');
    }

    // ── TIER 4: File upload (universal fallback) ──────────────────────────────
    console.log('[DSC] All tiers failed — showing file upload fallback');
    console.log('[DSC] Tier errors:\n' + tierErrors.join('\n'));
    setReadError('FILE_UPLOAD_NEEDED');
    setReading(false);
  };

  // ── Handle .cer / .pem file upload ───────────────────────────────────────────
  const handleCertFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setReadError('');
    setReading(true);
    try {
      const cert = await parseCertificateFile(file);
      if (!cert || !cert.holder_name) {
        setReadError('Could not read certificate from this file. Make sure it is a valid .cer or .pem file.');
        return;
      }
      applyCert(cert);
      toast.success(`Certificate read from ${file.name} ✓`);
    } catch (err) {
      setReadError('Failed to parse certificate file: ' + (err?.message || 'Unknown error'));
    } finally {
      setReading(false);
      if (certFileRef.current) certFileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!form.holder_name.trim()) { return; }
    setSaving(true);
    try {
      const payload = {
        holder_name:     form.holder_name.trim(),
        dsc_type:        form.dsc_type,
        dsc_password:    form.dsc_password,
        serial_number:   form.serial_number,
        associated_with: form.associated_with,
        entity_type:     form.entity_type === 'other' ? (form.entity_type_other || 'other') : form.entity_type,
        mobile:          form.mobile,
        email:           form.email,
        issue_date:      new Date(form.issue_date).toISOString(),
        expiry_date:     new Date(form.expiry_date).toISOString(),
        notes:           form.notes,
      };
      const res = await api.post('/dsc', payload);
      const newId = res.data?.id || res.data?.data?.id;

      // Auto-mark as IN immediately
      if (newId) {
        await api.post(`/dsc/${newId}/movement`, {
          movement_type: 'IN',
          person_name:   'Token Inserted',
          notes:         'Auto-detected via USB — marked IN on plug-in',
        });
      }

      setSaved(true);
      toast.success(`DSC for "${form.holder_name}" added & marked IN ✓`);
      setTimeout(() => { onSaved(); }, 1200);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to save DSC');
      setSaving(false);
    }
  };

  // ── colour palette ──────────────────────────────────────────────────────────
  const bg        = isDark ? '#0f172a' : '#ffffff';
  const surface   = isDark ? '#1e293b' : '#f8fafc';
  const border    = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const labelClr  = isDark ? '#94a3b8' : '#64748b';
  const textClr   = isDark ? '#f1f5f9' : '#0f172a';
  const inputBg   = isDark ? '#0f172a' : '#ffffff';
  const inputBdr  = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)';

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    background: inputBg, border: `1px solid ${inputBdr}`,
    borderRadius: 8, padding: '7px 10px',
    fontSize: 13, color: textClr,
    outline: 'none', fontFamily: 'inherit',
  };
  const labelStyle = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: labelClr, display: 'block', marginBottom: 4 };
  const rowStyle   = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 };

  return (
    <>
      <style>{USB_POPUP_STYLE}</style>
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center',
          justifyContent: 'center',
          padding: '16px',
          background: 'rgba(6,78,59,0.52)',
          backdropFilter: 'blur(5px)',
        }}
      >
        <div style={{
          width: '100%', maxWidth: 720,
          maxHeight: '90vh',
          background: bg, border: `1px solid ${border}`,
          borderRadius: 20, boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          animation: 'dscSlideUp 0.26s cubic-bezier(0.34,1.4,0.64,1)',
        }}>

          {/* ── Accent bar ── */}
          <div style={{ height: 3, background: 'linear-gradient(90deg,#4f46e5,#6366f1,#818cf8,#4f46e5)', backgroundSize: '200% 100%' }} />

          {/* ── Header ── */}
          <div style={{ padding: '18px 20px 12px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            {/* Icon */}
            <div style={{
              width: 46, height: 46, borderRadius: 13, flexShrink: 0,
              background: saved ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#4f46e5,#6366f1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(79,70,229,0.35)',
              transition: 'background 0.4s',
            }}>
              {saved
                ? <CheckCircle2 style={{ width: 22, height: 22, color: '#fff' }} />
                : <Key style={{ width: 22, height: 22, color: '#fff' }} />}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: textClr, lineHeight: 1.2 }}>
                  {saved ? 'DSC Added ✓' : (device ? 'DSC Token Detected' : 'Add New DSC')}
                </p>
                {/* Live USB dot */}
                {!saved && (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'dscPulse 1.4s ease-in-out infinite', flexShrink: 0 }} />
                )}
              </div>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: labelClr, lineHeight: 1.5 }}>
                {saved
                  ? `"${form.holder_name}" added to DSC Register & marked IN`
                  : device?.productName
                      ? <><span style={{ color: '#818cf8', fontWeight: 600 }}>{device.productName}</span> — fill details below</>
                      : (device ? 'Fill details to add this certificate to the register' : 'Add a new digital signature certificate')}
              </p>
            </div>

            {/* Dismiss × */}
            {!saved && (
              <button
                onClick={onDismiss}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: labelClr, padding: 4, borderRadius: 6, lineHeight: 1, fontSize: 18, flexShrink: 0 }}
                title="Dismiss"
              >×</button>
            )}
          </div>

          {/* ── Device info pill ── */}
          {device && (device.manufacturerName || device.vendorId) && !saved && (
            <div style={{ margin: '0 20px 12px', padding: '7px 12px', background: surface, borderRadius: 10, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Usb style={{ width: 13, height: 13, color: '#818cf8', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: labelClr, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {[
                  device.manufacturerName || null,
                  device.vendorId  ? `VID 0x${device.vendorId.toString(16).toUpperCase().padStart(4,'0')}`  : null,
                  device.productId ? `PID 0x${device.productId.toString(16).toUpperCase().padStart(4,'0')}` : null,
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}

          {/* ── Form ── */}
          {!saved && (
            <div style={{ padding: '0 20px 4px', overflowY: 'auto', flex: 1 }}>

              {/* ── Agent Status Banner (v5) ── */}
              {agentConnected && !certFetched && (
                <div style={{
                  marginBottom: 10, padding: '8px 12px',
                  background: isDark ? 'rgba(99,102,241,0.12)' : '#eef2ff',
                  borderRadius: 8, border: '1px solid rgba(99,102,241,0.35)',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: agentAutoFetching ? '#f59e0b' : '#10b981',
                    animation: agentAutoFetching ? 'dscPulse 1s ease-in-out infinite' : 'none',
                  }} />
                  <span style={{ fontSize: 11, color: isDark ? '#a5b4fc' : '#4338ca', fontWeight: 600, flex: 1 }}>
                    {agentAutoFetching
                      ? '⏳ DSC Agent connected — reading token certificate…'
                      : '✓ DSC Agent connected — plug in your DSC token to auto-fill all fields'}
                  </span>
                  {!agentAutoFetching && (
                    <button
                      onClick={async () => {
                        setAgentAutoFetching(true);
                        try {
                          const res = await fetch(`${DSC_AGENT_ENDPOINT}/dsc-autofill`, {
                            signal: AbortSignal.timeout(4000), cache: 'no-store',
                          });
                          if (res.ok) {
                            const d = await res.json();
                            if (d.available && d.fields?.holder_name) {
                              applyAutofill(d.fields);
                              setAutoFillDone(true);
                              toast.success('✓ DSC data auto-filled!');
                              return;
                            }
                          }
                          // fallback to /dsc-status
                          const r2 = await fetch(`${DSC_AGENT_ENDPOINT}/dsc-status`, {
                            signal: AbortSignal.timeout(3000), cache: 'no-store',
                          });
                          if (r2.ok) {
                            const d2 = await r2.json();
                            if (d2.cert?.holder_name) { applyCert(d2.cert); return; }
                          }
                          toast.info('No DSC token detected yet — plug in your token and try again.');
                        } catch { toast.error('Could not reach agent.'); }
                        finally { setAgentAutoFetching(false); }
                      }}
                      style={{
                        fontSize: 10, fontWeight: 700, padding: '3px 10px',
                        borderRadius: 5, border: '1px solid rgba(99,102,241,0.5)',
                        background: 'transparent', color: isDark ? '#a5b4fc' : '#4338ca',
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                    >
                      ↻ Re-fetch
                    </button>
                  )}
                </div>
              )}

              {/* ── Auto-fill success banner ── */}
              {autoFillDone && certFetched && (
                <div style={{
                  marginBottom: 10, padding: '8px 12px',
                  background: isDark ? 'rgba(16,185,129,0.10)' : '#f0fdf4',
                  borderRadius: 8, border: '1px solid rgba(16,185,129,0.4)',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ fontSize: 13 }}>✅</span>
                  <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700, flex: 1 }}>
                    All fields auto-filled from DSC token — verify and save.
                  </span>
                  <button
                    onClick={() => { setAutoFillDone(false); setCertFetched(false); setAgentAutoFetching(false); }}
                    style={{ fontSize: 10, background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer' }}
                  >
                    ✕ Clear
                  </button>
                </div>
              )}

              {/* ── PIN Read Section ── */}
              <div style={{ marginBottom: 14, padding: '10px 12px', background: certFetched ? (isDark ? 'rgba(16,185,129,0.1)' : '#f0fdf4') : surface, borderRadius: 10, border: `1px solid ${certFetched ? '#10b981' : readError ? '#ef4444' : border}` }}>
                <label style={{ ...labelStyle, marginBottom: 6, color: certFetched ? '#10b981' : readError ? '#ef4444' : labelClr }}>
                  {certFetched
                    ? '✓ Certificate Read from Token'
                    : agentAutoFetching
                      ? '⏳ Reading certificate from token…'
                      : agentConnected
                        ? 'PIN required? Enter below to force-read:'
                        : 'Read Certificate from Token (Optional)'}
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    style={{ ...inputStyle, flex: 1, letterSpacing: pin ? '0.2em' : 'normal' }}
                    type="password"
                    name="dsc-token-pin"
                    placeholder={agentConnected ? 'PIN only needed if auto-fill failed above' : 'Enter token PIN / password'}
                    value={pin}
                    onChange={e => { setPin(e.target.value); setReadError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleReadCertificate(); }}
                    disabled={reading}
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-form-type="other"
                    data-lpignore="true"
                    data-1p-ignore="true"
                  />
                  <button
                    type="button"
                    onClick={handleReadCertificate}
                    disabled={reading || !pin.trim()}
                    style={{
                      height: 34, padding: '0 14px', borderRadius: 8, border: 'none',
                      background: certFetched ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#4f46e5,#6366f1)',
                      color: '#fff', fontSize: 12, fontWeight: 700, cursor: reading || !pin.trim() ? 'not-allowed' : 'pointer',
                      opacity: !pin.trim() ? 0.5 : 1,
                      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                    }}
                  >
                    {reading
                      ? <><span style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'dscSpin 0.7s linear infinite' }} />Reading…</>
                      : certFetched ? '↻ Re-read' : '⬆ Fetch Data'}
                  </button>
                </div>
                {readError === 'FILE_UPLOAD_NEEDED' ? (
                  /* ── Fallback: .cer file upload + local agent option ── */
                  <div style={{ margin: '8px 0 0', padding: '10px 12px', background: isDark ? 'rgba(251,191,36,0.08)' : '#fffbeb', borderRadius: 8, border: '1px solid rgba(251,191,36,0.35)' }}>
                    <p style={{ margin: '0 0 4px', fontSize: 11, color: '#d97706', fontWeight: 700 }}>
                      🪟 Auto-read failed — upload your certificate file instead
                    </p>
                    <p style={{ margin: '0 0 6px', fontSize: 10, color: isDark ? '#fde68a' : '#92400e', lineHeight: 1.6 }}>
                      Export from <strong>mToken Manager</strong> → Certificate tab → <strong>Export</strong> → save as <code style={{ background: isDark ? '#1e1b4b' : '#e0e7ff', padding: '1px 4px', borderRadius: 3 }}>.cer</code>, then upload:
                    </p>
                    <input
                      ref={certFileRef}
                      type="file"
                      accept=".cer,.crt,.pem,.der"
                      style={{ display: 'none' }}
                      onChange={handleCertFileUpload}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => certFileRef.current?.click()}
                        disabled={reading}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                          background: 'linear-gradient(135deg,#f59e0b,#d97706)',
                          color: '#fff', fontSize: 11, fontWeight: 700,
                        }}
                      >
                        📂 Upload .cer / .pem File
                      </button>
                      <button
                        onClick={async () => {
                          const report = await diagnoseDscReader();
                          alert('DSC Diagnostic Report\n\n' + report + '\n\nThis report was also printed to the DevTools console.');
                        }}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '6px 12px', borderRadius: 6, border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`,
                          background: 'transparent', cursor: 'pointer',
                          color: isDark ? '#94a3b8' : '#64748b', fontSize: 10, fontWeight: 600,
                        }}
                        title="Run full diagnostic to see why auto-read failed"
                      >
                        🔍 Run Diagnostic
                      </button>
                    </div>
                    <p style={{ margin: '8px 0 2px', fontSize: 9.5, color: isDark ? '#6b7280' : '#9ca3af', lineHeight: 1.5 }}>
                      💡 <strong>For Windows users:</strong> Run the <code style={{ background: isDark ? '#1e293b' : '#f1f5f9', padding: '1px 3px', borderRadius: 2 }}>dsc-agent</code> locally with <code style={{ background: isDark ? '#1e293b' : '#f1f5f9', padding: '1px 3px', borderRadius: 2 }}>node index.js</code> for automatic reading.
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 9, color: isDark ? '#6b7280' : '#9ca3af' }}>
                      Your private key is never exported — only the public certificate (name, dates, serial).
                    </p>
                  </div>
                ) : readError ? (
                  <div style={{ margin: '8px 0 0', padding: '8px 10px', background: isDark ? 'rgba(239,68,68,0.12)' : '#fff1f1', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)' }}>
                    <p style={{ margin: 0, fontSize: 11, color: '#ef4444', lineHeight: 1.5, fontWeight: 600 }}>⚠ Could not read certificate</p>
                    <p style={{ margin: '3px 0 0', fontSize: 10, color: isDark ? '#fca5a5' : '#b91c1c', lineHeight: 1.5 }}>{readError}</p>
                  </div>
                ) : null}
                {!certFetched && !readError && (
                  <p style={{ margin: '5px 0 0', fontSize: 10, color: labelClr, lineHeight: 1.4 }}>
                    Optional — enter your token PIN and click “Fetch Data” to auto-fill. Or fill the form manually below.
                  </p>
                )}
              </div>

              {/* ── 3-column compact grid ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                {/* Holder Name — spans 2 cols */}
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={labelStyle}>Holder Name <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    style={{ ...inputStyle, fontSize: 13, fontWeight: 600, background: certFetched && form.holder_name ? (isDark ? 'rgba(16,185,129,0.08)' : '#f0fdf4') : inputBg, borderColor: certFetched && form.holder_name ? '#10b981' : inputBdr }}
                    placeholder="e.g. Rajesh Kumar Sharma"
                    value={form.holder_name}
                    onChange={e => set('holder_name', e.target.value)}
                    autoFocus={!certFetched}
                  />
                </div>
                <div>
                  <label style={labelStyle}>DSC Type</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.dsc_type} onChange={e => set('dsc_type', e.target.value)}>
                    {['Class 3','Class 2','Signature','Encryption','Combo','DGFT'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Serial Number</label>
                  <input
                    style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11, background: certFetched && form.serial_number ? (isDark ? 'rgba(16,185,129,0.08)' : '#f0fdf4') : inputBg, borderColor: certFetched && form.serial_number ? '#10b981' : inputBdr }}
                    placeholder="Auto-filled from token"
                    value={form.serial_number}
                    onChange={e => set('serial_number', e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Associated With</label>
                  <select
                    style={{ ...inputStyle, cursor: 'pointer' }}
                    value={assocOther ? '__other__' : (form.associated_with || '')}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === '__other__') {
                        setAssocOther(true);
                        set('associated_with', '');
                      } else {
                        setAssocOther(false);
                        set('associated_with', v);
                      }
                    }}
                  >
                    <option value="">
                      {filteredClients.length === 0 ? 'No clients found — add via Clients page' : 'Select client…'}
                    </option>
                    {filteredClients.map(c => (
                      <option key={c.id} value={c.company_name}>
                        {c.company_name}{c.client_type_label ? ` (${c.client_type_label})` : ''}
                      </option>
                    ))}
                    <option value="__other__">Other (type manually)…</option>
                  </select>
                  {assocOther && (
                    <input
                      style={{ ...inputStyle, marginTop: 6 }}
                      placeholder="Enter client / entity name"
                      value={form.associated_with}
                      onChange={e => set('associated_with', e.target.value)}
                      autoFocus
                    />
                  )}
                </div>
                <div>
                  <label style={labelStyle}>
                    <Lock style={{ width: 10, height: 10, display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
                    Token Password
                  </label>
                  <input style={inputStyle} type="text" placeholder="e.g. 12345678" value={form.dsc_password} onChange={e => set('dsc_password', e.target.value)} />
                </div>
                {/* ── Mobile & Email — needed for WhatsApp/email alerts ── */}
                <div>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Phone style={{ width: 10, height: 10 }} />
                    Mobile No. <span style={{ color: '#25d366', fontSize: 9, fontWeight: 700, marginLeft: 2 }}>for WhatsApp</span>
                  </label>
                  <input
                    style={inputStyle}
                    type="tel"
                    placeholder="e.g. 9876543210"
                    value={form.mobile}
                    onChange={e => set('mobile', e.target.value.replace(/[^0-9+\s-]/g, ''))}
                    maxLength={15}
                  />
                </div>
                <div>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Mail style={{ width: 10, height: 10 }} />
                    Email ID <span style={{ color: '#3b82f6', fontSize: 9, fontWeight: 700, marginLeft: 2 }}>for alerts</span>
                  </label>
                  <input
                    style={inputStyle}
                    type="email"
                    placeholder="e.g. holder@email.com"
                    value={form.email}
                    onChange={e => set('email', e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Issue Date <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    style={{ ...inputStyle, background: certFetched && form.issue_date ? (isDark ? 'rgba(16,185,129,0.08)' : '#f0fdf4') : inputBg, borderColor: certFetched && form.issue_date ? '#10b981' : inputBdr }}
                    type="date" value={form.issue_date} onChange={e => set('issue_date', e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Expiry Date <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    style={{ ...inputStyle, background: certFetched && form.expiry_date ? (isDark ? 'rgba(16,185,129,0.08)' : '#f0fdf4') : inputBg, borderColor: certFetched && form.expiry_date ? '#10b981' : inputBdr }}
                    type="date" value={form.expiry_date} onChange={e => set('expiry_date', e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Entity Type</label>
                  <select
                    style={{ ...inputStyle, cursor: 'pointer' }}
                    value={form.entity_type}
                    onChange={e => set('entity_type', e.target.value)}
                  >
                    {ENTITY_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {isOtherEntity && (
                    <input
                      style={{ ...inputStyle, marginTop: 6 }}
                      placeholder="Enter entity type (e.g. Society, AOP…)"
                      value={form.entity_type_other || ''}
                      onChange={e => set('entity_type_other', e.target.value)}
                      autoFocus
                    />
                  )}
                </div>
              </div>

              {/* ── Mobile & Email — full width row ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Phone style={{ width: 10, height: 10 }} />
                    Mobile Number <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ ...inputStyle, width: 44, flexShrink: 0, textAlign: 'center', color: labelClr, fontSize: 12, fontWeight: 700, padding: '7px 6px' }}>+91</span>
                    <input
                      style={{ ...inputStyle, flex: 1, borderColor: form.mobile && form.mobile.replace(/\D/g,'').length < 10 ? '#f97316' : (form.mobile ? '#10b981' : inputBdr) }}
                      type="tel"
                      placeholder="10-digit mobile number"
                      maxLength={15}
                      value={form.mobile}
                      onChange={e => set('mobile', e.target.value.replace(/[^0-9+\s-]/g, ''))}
                    />
                  </div>
                  {form.mobile && form.mobile.replace(/\D/g,'').length < 10 && (
                    <p style={{ margin: '3px 0 0', fontSize: 10, color: '#f97316' }}>Enter a valid 10-digit number</p>
                  )}
                  <p style={{ margin: '3px 0 0', fontSize: 10, color: labelClr }}>Used to send WhatsApp alerts directly</p>
                </div>
                <div>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Mail style={{ width: 10, height: 10 }} />
                    Email Address
                  </label>
                  <input
                    style={{ ...inputStyle, borderColor: form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) ? '#f97316' : (form.email ? '#10b981' : inputBdr) }}
                    type="email"
                    placeholder="holder@example.com"
                    value={form.email}
                    onChange={e => set('email', e.target.value)}
                  />
                  {form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) && (
                    <p style={{ margin: '3px 0 0', fontSize: 10, color: '#f97316' }}>Enter a valid email address</p>
                  )}
                  <p style={{ margin: '3px 0 0', fontSize: 10, color: labelClr }}>Used to send expiry alert via email</p>
                </div>
              </div>

              {/* Advanced — Notes (collapsible) */}
              <div style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(p => !p)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: labelClr, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, padding: 0, letterSpacing: '0.04em' }}
                >
                  {showAdvanced ? <ChevronUp style={{ width: 13, height: 13 }} /> : <ChevronDown style={{ width: 13, height: 13 }} />}
                  {showAdvanced ? 'Hide notes' : 'Add notes'}
                </button>
                {showAdvanced && (
                  <textarea
                    style={{ ...inputStyle, marginTop: 8, resize: 'vertical', minHeight: 60 }}
                    placeholder="Additional notes…"
                    value={form.notes}
                    onChange={e => set('notes', e.target.value)}
                    rows={2}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Footer actions ── */}
          {!saved && (
            <div style={{ padding: '0 20px 20px', display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={onDismiss}
                style={{
                  flex: 1, height: 40, borderRadius: 10, border: `1px solid ${border}`,
                  background: surface, color: labelClr, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', transition: 'opacity 0.15s',
                }}
              >
                {device ? 'Not a DSC' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !form.holder_name.trim() || !form.issue_date || !form.expiry_date}
                style={{
                  flex: 2, height: 40, borderRadius: 10, border: 'none',
                  background: saving ? '#6366f1' : 'linear-gradient(135deg,#4f46e5,#6366f1)',
                  color: '#fff', fontSize: 13, fontWeight: 700,
                  cursor: saving || !form.holder_name.trim() ? 'not-allowed' : 'pointer',
                  opacity: (!form.holder_name.trim() || !form.issue_date || !form.expiry_date) ? 0.55 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  transition: 'opacity 0.2s',
                }}
              >
                {saving
                  ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'dscSpin 0.7s linear infinite' }} />Saving…</>
                  : <><ArrowDownCircle style={{ width: 15, height: 15 }} />Add to Register & Mark IN</>}
              </button>
            </div>
          )}

          {/* ── Success state footer ── */}
          {saved && (
            <div style={{ padding: '8px 20px 22px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                ✓ Certificate saved and automatically marked as IN
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DSCRegister() {
  const isDark    = useDark();
  const { user, hasPermission } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canDeleteDSC = isAdmin || hasPermission('can_delete_data');
  const canEditDSC   = isAdmin || hasPermission('can_edit_data');
  const searchRef = useRef(null);

  const [dscList, setDscList]                       = useState([]);
  // Client list for the unified DSC popup's "Associated With" dropdown.
  // Lazily fetched once on mount; failures are silent (the dropdown just
  // shows "No clients found — add via Clients page").
  const [clients, setClients]                       = useState([]);
  const [loading, setLoading]                       = useState(false);
  const [dialogOpen, setDialogOpen]                 = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen]           = useState(false);
  const [editingDSC, setEditingDSC]                 = useState(null);
  const [selectedDSC, setSelectedDSC]               = useState(null);
  const [editingMovement, setEditingMovement]       = useState(null);
  const [searchQuery, setSearchQuery]               = useState('');
  const [rowsPerPage, setRowsPerPage]               = useState(15);
  const [currentPageIn, setCurrentPageIn]           = useState(1);
  const [currentPageOut, setCurrentPageOut]         = useState(1);
  const [currentPageExpired, setCurrentPageExpired] = useState(1);
  const [currentPageExpiring, setCurrentPageExpiring] = useState(1);
  const [sortOrder, setSortOrder]                   = useState('az');
  const [activeTab, setActiveTab]                   = useState('in');
  const [sharing, setSharing]                       = useState(false);

  // ── WhatsApp automation state ─────────────────────────────────────────────
  const [whatsappAutoOpen, setWhatsappAutoOpen]       = useState(false);
  const [waMsgSettingsOpen, setWaMsgSettingsOpen]     = useState(false);
  const [waMsgSettings, setWaMsgSettings]             = useState(getWASettings);
  const [shareChoiceDialog, setShareChoiceDialog]     = useState(null); // dsc for share-choice
  const [autoEnabled, setAutoEnabled]                 = useState(() => {
    try { return JSON.parse(localStorage.getItem('dsc_wa_auto_enabled') || 'false'); } catch { return false; }
  });
  const [autoSettings, setAutoSettings]               = useState(() => {
    try { return JSON.parse(localStorage.getItem('dsc_wa_auto_settings') || 'null') || { days: [7, 30], time: '10:00', sendExpired: true }; } catch { return { days: [7, 30], time: '10:00', sendExpired: true }; }
  });
  const [autoLastRun, setAutoLastRun]                 = useState(() => localStorage.getItem('dsc_wa_last_run') || null);
  const [autoSending, setAutoSending]                 = useState(false);
  const [waPhoneDialog, setWaPhoneDialog]             = useState(null); // dsc object for phone entry
  const [waPhoneNumber, setWaPhoneNumber]             = useState('');

  const [selectedIds, setSelectedIds]           = useState(new Set());
  const [bulkDialogOpen, setBulkDialogOpen]     = useState(false);
  const [bulkMovementType, setBulkMovementType] = useState('IN');
  const [bulkPersonName, setBulkPersonName]     = useState('');
  const [bulkNotes, setBulkNotes]               = useState('');
  const [bulkLoading, setBulkLoading]           = useState(false);

  // ── AI Duplicate detection ────────────────────────────────────────────────
  const [showDupDialog, setShowDupDialog] = useState(false);
  const [dupGroups,     setDupGroups]     = useState([]);
  const [detectingDups, setDetectingDups] = useState(false);

  const [formData, setFormData] = useState({
    holder_name: '', dsc_type: '', dsc_password: '', serial_number: '',
    associated_with: '', entity_type: 'proprietor', entity_type_other: '',
    _assocOther: false, mobile: '', email: '',
    issue_date: '', expiry_date: '', notes: '',
  });
  const [movementData, setMovementData]         = useState({ movement_type: 'IN', person_name: '', notes: '' });
  const [editMovementData, setEditMovementData] = useState({ movement_type: 'IN', person_name: '', notes: '' });

  const shareAreaRef = useRef(null);
  const cardCaptureRef = useRef(null); // captures ONLY the card body (no buttons)

  // ── USB state ──────────────────────────────────────────────────────────────
  const [usbPromptOpen, setUsbPromptOpen] = useState(false);
  const [usbDevice,     setUsbDevice]     = useState(null);
  const [usbDismissed,  setUsbDismissed]  = useState(false);
  const [usbSupported,  setUsbSupported]  = useState(false);
  const [usbPermission, setUsbPermission] = useState('unknown'); // 'unknown'|'granted'|'denied'
  const [usbGranting,   setUsbGranting]   = useState(false);

  // ── Status helpers ────────────────────────────────────────────────────────
  const getDSCInOutStatus = (dsc) => {
    if (!dsc) return 'OUT';
    if (dsc.current_status) return dsc.current_status;
    return dsc.current_location === 'with_company' ? 'IN' : 'OUT';
  };
  const getDocumentInOutStatus = getDSCInOutStatus;

  const getDSCStatus = (expiryDate) => {
    const daysLeft = Math.ceil((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0)   return { color: 'bg-red-500',    text: 'Expired',           textColor: 'text-red-600' };
    if (daysLeft <= 7)  return { color: 'bg-orange-500', text: `${daysLeft}d left`, textColor: 'text-orange-600' };
    if (daysLeft <= 30) return { color: 'bg-yellow-500', text: `${daysLeft}d left`, textColor: 'text-yellow-700' };
    return               { color: 'bg-emerald-500',      text: `${daysLeft}d left`, textColor: 'text-emerald-700' };
  };

  // ── Build share text ──────────────────────────────────────────────────────
  const buildSummaryText = (dsc) => {
    if (!dsc) return '';
    const lastMove = dsc.movement_log?.length > 0 ? dsc.movement_log[dsc.movement_log.length - 1] : null;
    return [
      `*DSC Certificate Details*`,
      ``,
      `👤 Holder: ${dsc.holder_name || 'N/A'}`,
      `🏷️ Type: ${dsc.dsc_type || 'Standard'}`,
      dsc.serial_number ? `🔢 Serial No: ${dsc.serial_number}` : null,
      `🏢 Associated With: ${dsc.associated_with || 'N/A'}`,
      `📅 Issue Date: ${dsc.issue_date ? format(new Date(dsc.issue_date), 'dd MMM yyyy') : 'N/A'}`,
      `⏳ Expiry Date: ${dsc.expiry_date ? format(new Date(dsc.expiry_date), 'dd MMM yyyy') : 'N/A'}`,
      `📍 Current Status: ${getDSCInOutStatus(dsc)}`,
      dsc.dsc_password ? `🔑 Password: ${dsc.dsc_password}` : null,
      dsc.notes ? `📝 Notes: ${dsc.notes}` : null,
      lastMove ? `\nLast Movement: ${lastMove.movement_type} by ${lastMove.person_name} on ${format(new Date(lastMove.timestamp), 'dd MMM yyyy, hh:mm a')}` : null,
      ``,
      `\u2014 ${getWASettings().senderName}`,
    ].filter(Boolean).join('\n');
  };

  // ── Share handler ─────────────────────────────────────────────────────────
  // ── Capture the card (content only, no buttons) ───────────────────────────
  const captureCard = async () => {
    const el = cardCaptureRef.current || shareAreaRef.current;
    if (!el) throw new Error('No card element');
    const canvas = await html2canvas(el, {
      backgroundColor: isDark ? '#0f172a' : '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
      // Ensure full width — no clipping
      width: el.scrollWidth,
      height: el.scrollHeight,
      windowWidth: el.scrollWidth,
    });
    return canvas;
  };

  // ── Share the screenshot: native share → WA web fallback ─────────────────
  const shareScreenshotToWhatsApp = async (dsc) => {
    setSharing(true);
    try {
      const canvas = await captureCard();
      const safeName = (dsc.holder_name || 'DSC').replace(/[^a-z0-9]/gi, '_');
      const fileName = `DSC_${safeName}.png`;
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('empty blob');
      const file = new File([blob], fileName, { type: 'image/png' });
      const alertText = buildExpiryAlertText(dsc, waMsgSettings);

      // Mobile: native OS share sheet (Android Chrome, Safari iOS)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `DSC Alert — ${dsc.holder_name}`, text: alertText });
          toast.success('Shared via WhatsApp ✓');
          return;
        } catch (e) {
          if (e?.name === 'AbortError') return; // user cancelled
          // fall through to desktop
        }
      }

      // Desktop: download image + open wa.me
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.download = fileName; a.href = url; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      try { await navigator.clipboard?.writeText(alertText); } catch { /* silent */ }
      const ph = dsc?.mobile?.replace(/[\s\-\+]/g, '');
      const phone = ph && ph.replace(/\D/g,'').length >= 10 ? (ph.startsWith('91') ? ph : '91' + ph) : '';
      window.open(phone ? `https://wa.me/${phone}?text=${encodeURIComponent(alertText)}` : `https://wa.me/?text=${encodeURIComponent(alertText)}`, '_blank');
      toast.success('Screenshot downloaded — attach it in WhatsApp chat');
    } catch (err) {
      console.error('Screenshot share error:', err);
      toast.error('Screenshot failed. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  // ── Download screenshot only ──────────────────────────────────────────────
  const downloadScreenshot = async (dsc) => {
    setSharing(true);
    try {
      const canvas = await captureCard();
      const safeName = (dsc.holder_name || 'DSC').replace(/[^a-z0-9]/gi, '_');
      const a = document.createElement('a');
      a.download = `DSC_${safeName}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
      toast.success('Screenshot downloaded');
    } catch (err) {
      toast.error('Screenshot failed');
    } finally {
      setSharing(false);
    }
  };

  const handleShare = async (method) => {
    if (!selectedDSC) return;
    if (method === 'whatsapp') { await shareScreenshotToWhatsApp(selectedDSC); return; }
    if (method === 'download') { await downloadScreenshot(selectedDSC); return; }
    if (method === 'email') {
      const summaryText = buildSummaryText(selectedDSC);
      window.location.href = `mailto:?subject=${encodeURIComponent('DSC Certificate Details — ' + selectedDSC.holder_name)}&body=${encodeURIComponent(summaryText)}`;
      return;
    }
    if (method === 'copy') {
      try { await navigator.clipboard.writeText(buildSummaryText(selectedDSC)); toast.success('DSC details copied to clipboard'); }
      catch { toast.error('Could not copy to clipboard'); }
    }
  };

  useEffect(() => { fetchDSC(); }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get('/clients');
        if (cancelled) return;
        const list = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.data || []);
        setClients(list);
      } catch { /* silent — popup falls back to "No clients found" */ }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setCurrentPageIn(1); setCurrentPageOut(1); setCurrentPageExpired(1); setCurrentPageExpiring(1); if (searchQuery.trim()) { setActiveTab('all'); } else { setActiveTab('in'); } }, [sortOrder, searchQuery]);

  // ── WhatsApp alert handlers ───────────────────────────────────────────────
  // ── WhatsApp alert handlers ───────────────────────────────────────────────
  // Row WA button: open the WhatsApp send dialog directly with auto-filled phone
  const [waAlertDsc, setWaAlertDsc] = useState(null);
  const [waAlertDialogOpen, setWaAlertDialogOpen] = useState(false);

  const handleWhatsAppAlert = (dsc) => {
    setWaAlertDsc(dsc);
    setWaAlertDialogOpen(true);
  };

  const sendWhatsAppMessage = async (dsc, phone) => {
    const msg = buildExpiryAlertText(dsc, waMsgSettings);
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.startsWith('91') ? digits : `91${digits}`;
    try {
      const res = await api.post('/whatsapp/send', {
        to: e164, message: msg, message_type: 'dsc_expiry', context_id: dsc.id
      }).catch(() => null);
      if (res?.data?.success) {
        toast.success(`Message sent directly to ${dsc.holder_name} ✓`);
        return;
      }
    } catch {}
    window.open(`https://wa.me/${e164}?text=${encodeURIComponent(msg)}`, '_blank');
    toast.success(`WhatsApp opened for ${dsc.holder_name}`);
  };

  // Send plain text alert — always opens WhatsApp Send Dialog for direct send
  const handleSendTextAlert = (dsc) => {
    setWaAlertDsc(dsc);
    setWaAlertDialogOpen(true);
  };

  // Legacy: kept for automation quick-action buttons
  const handleWhatsAppChoice = (choice, dsc) => {
    setShareChoiceDialog(null);
    if (choice === 'screenshot') { shareScreenshotToWhatsApp(dsc); }
    else { handleSendTextAlert(dsc); }
  };

  const handleWhatsAppSendWithPhone = () => {
    if (!waPhoneDialog) return;
    const phone = waPhoneNumber.replace(/\s|-|\+/g, '');
    const msg = buildExpiryAlertText(waPhoneDialog, waMsgSettings);
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.startsWith('91') ? digits : `91${digits}`;
    api.post('/whatsapp/send', { to: e164, message: msg, message_type: 'dsc_expiry', context_id: waPhoneDialog.id })
      .then(res => {
        if (res?.data?.success) toast.success(`Message sent directly to ${waPhoneDialog.holder_name} \u2713`);
        else { window.open(`https://wa.me/${e164}?text=${encodeURIComponent(msg)}`, '_blank'); toast.success(`WhatsApp opened for ${waPhoneDialog.holder_name}`); }
      })
      .catch(() => { window.open(`https://wa.me/${e164}?text=${encodeURIComponent(msg)}`, '_blank'); toast.success(`WhatsApp opened for ${waPhoneDialog.holder_name}`); });
    setWaPhoneDialog(null);
  };

  const saveAutoSettings = (settings, enabled) => {
    localStorage.setItem('dsc_wa_auto_settings', JSON.stringify(settings));
    localStorage.setItem('dsc_wa_auto_enabled', JSON.stringify(enabled));
    setAutoSettings(settings);
    setAutoEnabled(enabled);
  };

  const handleRunAutomation = () => {
    setAutoSending(true);
    // Find DSCs that match the automation criteria
    const alertDSCs = dscList.filter(dsc => {
      const daysLeft = Math.ceil((new Date(dsc.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) return autoSettings.sendExpired;
      return autoSettings.days.some(d => daysLeft <= d && daysLeft >= 0);
    });
    // Open WhatsApp for each (sequentially with delay)
    let count = 0;
    alertDSCs.forEach((dsc, i) => {
      setTimeout(() => {
        const msg = buildExpiryAlertText(dsc, getWASettings());
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
        count++;
        if (count === alertDSCs.length) {
          const now = new Date().toLocaleString('en-IN');
          localStorage.setItem('dsc_wa_last_run', now);
          setAutoLastRun(now);
          setAutoSending(false);
          toast.success(`Sent WhatsApp alerts for ${count} DSC holder(s)`);
        }
      }, i * 800);
    });
    if (alertDSCs.length === 0) {
      setAutoSending(false);
      toast.info('No DSCs match the automation criteria right now.');
    }
  };

  // ── USB DSC Token Detection ───────────────────────────────────────────────
  // WebUSB only fires 'connect' for devices that have been previously granted
  // permission. We must call requestDevice() at least once to get permission,
  // then the browser remembers it and fires 'connect' on future plug-ins.

  const DSC_VENDOR_IDS = [
    { vendorId: 0x0529 }, { vendorId: 0x08E6 }, { vendorId: 0x096E },
    { vendorId: 0x1FC9 }, { vendorId: 0x076B }, { vendorId: 0x04B9 },
    { vendorId: 0x073D }, { vendorId: 0x072F }, { vendorId: 0x22CD },
    { vendorId: 0x311F }, { vendorId: 0x058F }, { vendorId: 0x04E6 },
    { vendorId: 0x0DC3 }, { vendorId: 0x1D50 },
  ];

  const DSC_NAME_KEYWORDS = [
    'token', 'dsc', 'etoken', 'epass', 'safenet', 'feitian',
    'watchdata', 'smart card', 'smartcard', 'crypto', 'pkcs',
    'moser baer', 'ikey', 'crescendo', 'eutron', 'trustkey',
    'emudhra', 'sify', 'ncode', 'capricorn', 'e-mudhra', 'proxkey',
  ];

  const isDSCDevice = useCallback((device) => {
    if (DSC_VENDOR_IDS.some(f => f.vendorId === device.vendorId)) return true;
    const combined = [device.productName || '', device.manufacturerName || ''].join(' ').toLowerCase();
    if (DSC_NAME_KEYWORDS.some(kw => combined.includes(kw))) return true;
    if (device.deviceClass === 0x0B) return true;
    return false;
  }, []);

  // On mount: check if WebUSB is available and scan already-permitted devices
  useEffect(() => {
    if (!navigator.usb) { setUsbSupported(false); return; }
    setUsbSupported(true);

    const scanExistingDevices = async () => {
      try {
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
          setUsbPermission('granted');
          // Only auto-popup if a previously-permitted device looks like a real DSC token.
          // (A USB mouse / wireless receiver / generic HID should NOT trigger the popup.)
          const dscDev = devices.find(isDSCDevice);
          if (dscDev && !usbDismissed) {
            setUsbDevice(dscDev);
            setUsbPromptOpen(true);
          }
        }
      } catch (_) {}
    };
    scanExistingDevices();

    const handleConnect = (event) => {
      if (usbDismissed) return;
      setUsbPermission('granted');
      // Only show popup for plugged-in devices that look like a DSC token.
      if (!isDSCDevice(event.device)) return;
      setUsbDevice(event.device);
      setUsbPromptOpen(true);
    };

    const handleDisconnect = () => {
      setUsbPromptOpen(false);
    };

    navigator.usb.addEventListener('connect', handleConnect);
    navigator.usb.addEventListener('disconnect', handleDisconnect);
    return () => {
      navigator.usb.removeEventListener('connect', handleConnect);
      navigator.usb.removeEventListener('disconnect', handleDisconnect);
    };
  }, [usbDismissed]);

  // Called when user clicks "Grant USB Access" button
  const handleGrantUsbAccess = useCallback(async () => {
    if (!navigator.usb) return;
    setUsbGranting(true);
    try {
      // IMPORTANT: Use empty filters [] so Chrome shows ALL connected USB devices.
      // Vendor-ID filters cause "No compatible devices found" if the token's VID
      // isn't in our list. The user picks their DSC token from the full list.
      const device = await navigator.usb.requestDevice({ filters: [] });
      setUsbPermission('granted');
      if (!isDSCDevice(device)) {
        toast.info('Selected device does not look like a DSC token. Use “Add DSC” to enter details manually.');
        return;
      }
      if (!usbDismissed) {
        setUsbDevice(device);
        setUsbPromptOpen(true);
      }
    } catch (err) {
      if (err.name === 'NotFoundError') {
        // User closed the picker without selecting — not an error
        toast.info('No device selected. Make sure your DSC token is plugged in, then try again.');
      } else {
        setUsbPermission('denied');
        toast.error('USB access denied. Please allow USB access in browser settings.');
      }
    } finally {
      setUsbGranting(false);
    }
  }, [usbDismissed]);

  // ── Keyboard shortcut: "/" focuses search ────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.innerHTML = PRINT_STYLE;
    document.head.appendChild(styleEl);
    return () => document.head.removeChild(styleEl);
  }, []);

  const handlePrint = () => window.print();

  // ── AI Duplicate Detection ────────────────────────────────────────────────
  const handleDetectDscDuplicates = useCallback(() => {
    if (detectingDups) return;
    setDetectingDups(true);
    setTimeout(() => {
      try {
        const groups = detectDscDuplicates(dscList);
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) toast.success(`Scanned ${dscList.length} DSCs — no duplicates found ✓`);
        else toast.info(`Found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('DSC duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  }, [dscList, detectingDups]);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const extractItems = (data) => {
    if (Array.isArray(data))              return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.dscs)) return data.dscs;
    return [];
  };

  const fetchDSC = async () => {
    setLoading(true);
    try {
      const response = await api.get('/dsc', { params: { limit: 500 } });
      setDscList(extractItems(response.data));
    } catch (error) {
      toast.error('Failed to fetch DSC');
      setDscList([]);
    } finally {
      setLoading(false);
    }
  };

  const refetchAndSync = async (editingId) => {
    const response = await api.get('/dsc', { params: { limit: 500 } });
    const items = extractItems(response.data);
    setDscList(items);
    if (editingId) {
      const updated = items.find(d => d.id === editingId);
      if (updated) setEditingDSC(updated);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const dscData = {
        holder_name:     formData.holder_name,
        dsc_type:        formData.dsc_type,
        dsc_password:    formData.dsc_password,
        serial_number:   formData.serial_number || '',
        associated_with: formData.associated_with,
        entity_type:     formData.entity_type === 'other' ? (formData.entity_type_other || 'other') : formData.entity_type,
        mobile:          formData.mobile || '',
        email:           formData.email  || '',
        notes:           formData.notes,
        issue_date:      new Date(formData.issue_date).toISOString(),
        expiry_date:     new Date(formData.expiry_date).toISOString(),
      };
      if (editingDSC) {
        await api.put(`/dsc/${editingDSC.id}`, dscData);
        toast.success('DSC updated successfully!');
      } else {
        await api.post('/dsc', dscData);
        toast.success('DSC added successfully!');
      }
      setDialogOpen(false);
      resetForm();
      fetchDSC();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save DSC');
    } finally {
      setLoading(false);
    }
  };

  // ── Single movement ───────────────────────────────────────────────────────
  const handleMovement = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post(`/dsc/${selectedDSC.id}/movement`, movementData);
      toast.success(`DSC marked as ${movementData.movement_type}!`);
      setMovementDialogOpen(false);
      setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
      fetchDSC();
    } catch (error) {
      toast.error('Failed to record movement');
    } finally {
      setLoading(false);
    }
  };

  const openMovementDialog = (dsc, type) => {
    setSelectedDSC(dsc);
    setMovementData({ ...movementData, movement_type: type });
    setMovementDialogOpen(true);
  };

  const openLogDialog = (dsc) => { setSelectedDSC(dsc); setLogDialogOpen(true); };

  const handleMovementInModal = async () => {
    if (!editingDSC || !movementData.person_name) return;
    setLoading(true);
    try {
      const newType = getDSCInOutStatus(editingDSC) === 'IN' ? 'OUT' : 'IN';
      await api.post(`/dsc/${editingDSC.id}/movement`, { ...movementData, movement_type: newType });
      toast.success(`DSC marked as ${newType}!`);
      setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
      await refetchAndSync(editingDSC.id);
    } catch (error) {
      toast.error('Failed to record movement');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMovement = async (movementId) => {
    if (!editingDSC || !editMovementData.person_name) return;
    setLoading(true);
    try {
      await api.put(`/dsc/${editingDSC.id}/movement/${movementId}`, {
        movement_id:   movementId,
        movement_type: editMovementData.movement_type,
        person_name:   editMovementData.person_name,
        notes:         editMovementData.notes,
      });
      toast.success('Movement log updated successfully!');
      setEditingMovement(null);
      await refetchAndSync(editingDSC.id);
    } catch (error) {
      toast.error('Failed to update movement');
    } finally {
      setLoading(false);
    }
  };

  const startEditingMovement = (movement) => {
    setEditingMovement(movement.id || movement.timestamp);
    setEditMovementData({ movement_type: movement.movement_type, person_name: movement.person_name, notes: movement.notes || '' });
  };

  // ── Edit / Delete ─────────────────────────────────────────────────────────
  const handleEdit = (dsc) => {
    setEditingDSC(dsc);
    const knownTypes = ENTITY_TYPE_OPTIONS.map(o => o.value);
    const isKnown    = knownTypes.includes(dsc.entity_type);
    const isAssocOther = dsc.associated_with
      && Array.isArray(clients)
      && !clients.some(c => c.company_name === dsc.associated_with);
    setFormData({
      holder_name:     dsc.holder_name,
      dsc_type:        dsc.dsc_type || '',
      dsc_password:    dsc.dsc_password || '',
      serial_number:   dsc.serial_number || '',
      associated_with: dsc.associated_with || '',
      entity_type:     isKnown ? dsc.entity_type : (dsc.entity_type ? 'other' : 'proprietor'),
      entity_type_other: isKnown ? '' : (dsc.entity_type || ''),
      _assocOther:     !!isAssocOther,
      mobile:          dsc.mobile || '',
      email:           dsc.email  || '',
      issue_date:      format(new Date(dsc.issue_date), 'yyyy-MM-dd'),
      expiry_date:     format(new Date(dsc.expiry_date), 'yyyy-MM-dd'),
      notes:           dsc.notes || '',
    });
    setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
    setEditingMovement(null);
    setDialogOpen(true);
  };

  const handleDelete = async (dscId) => {
    if (!window.confirm('Are you sure you want to delete this DSC?')) return;
    try {
      await api.delete(`/dsc/${dscId}`);
      toast.success('DSC deleted successfully!');
      fetchDSC();
    } catch (error) {
      toast.error('Failed to delete DSC');
    }
  };

  const resetForm = () => {
    setFormData({ holder_name: '', dsc_type: '', dsc_password: '', serial_number: '', associated_with: '', entity_type: 'proprietor', entity_type_other: '', _assocOther: false, mobile: '', email: '', issue_date: '', expiry_date: '', notes: '' });
    setEditingDSC(null);
  };

  const filterBySearch = (dsc) => {
    if (!searchQuery.trim()) return true;
    if (!dsc) return false;
    const q = searchQuery.toLowerCase();
    return dsc.holder_name?.toLowerCase().includes(q) || dsc.dsc_type?.toLowerCase().includes(q) || dsc.associated_with?.toLowerCase().includes(q);
  };

  // ── Sort ──────────────────────────────────────────────────────────────────
  const applySortOrder = (list) => {
    const arr = [...list];
    switch (sortOrder) {
      case 'az':   return arr.sort((a, b) => (a.holder_name || '').localeCompare(b.holder_name || ''));
      case 'za':   return arr.sort((a, b) => (b.holder_name || '').localeCompare(a.holder_name || ''));
      case 'fifo': return arr.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
      case 'lifo': return arr.sort((a, b) => new Date(b.expiry_date) - new Date(a.expiry_date));
      default:     return arr;
    }
  };

  const nowDate    = new Date();
  const inDSC      = applySortOrder(dscList.filter(d => new Date(d.expiry_date) >= nowDate && getDSCInOutStatus(d) === 'IN'  && filterBySearch(d)));
  const outDSC     = applySortOrder(dscList.filter(d => new Date(d.expiry_date) >= nowDate && getDSCInOutStatus(d) === 'OUT' && filterBySearch(d)));
  const expiredDSC = applySortOrder(dscList.filter(d => new Date(d.expiry_date) < nowDate  && filterBySearch(d)));
  const expiring7DSC = applySortOrder(dscList.filter(d => {
    const dl = Math.ceil((new Date(d.expiry_date) - nowDate) / 86400000);
    return dl >= 0 && dl <= 7 && filterBySearch(d);
  }));
  const allDSC = applySortOrder(dscList.filter(d => filterBySearch(d)));

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsExpiring7  = dscList.filter(d => { const dl = Math.ceil((new Date(d.expiry_date) - nowDate) / 86400000); return dl >= 0 && dl <= 7; }).length;
  const statsExpiring30 = dscList.filter(d => { const dl = Math.ceil((new Date(d.expiry_date) - nowDate) / 86400000); return dl > 7 && dl <= 30; }).length;
  const statsExpired    = dscList.filter(d => new Date(d.expiry_date) < nowDate).length;
  const statsIn         = dscList.filter(d => new Date(d.expiry_date) >= nowDate && getDSCInOutStatus(d) === 'IN').length;
  const statsOut        = dscList.filter(d => new Date(d.expiry_date) >= nowDate && getDSCInOutStatus(d) === 'OUT').length;

  // ── Pagination ────────────────────────────────────────────────────────────
  const safePage = (cur, total) => Math.min(cur, Math.max(1, total));
  const tpIn  = Math.ceil(inDSC.length      / rowsPerPage);
  const tpOut = Math.ceil(outDSC.length     / rowsPerPage);
  const tpExp = Math.ceil(expiredDSC.length / rowsPerPage);
  const tpExpiring = Math.ceil(expiring7DSC.length / rowsPerPage);
  const spIn  = safePage(currentPageIn,      tpIn);
  const spOut = safePage(currentPageOut,     tpOut);
  const spExp = safePage(currentPageExpired, tpExp);
  const spExpiring = safePage(currentPageExpiring, tpExpiring);
  const pagedIn  = inDSC.slice((spIn  - 1) * rowsPerPage, spIn  * rowsPerPage);
  const pagedOut = outDSC.slice((spOut - 1) * rowsPerPage, spOut * rowsPerPage);
  const pagedExp = expiredDSC.slice((spExp - 1) * rowsPerPage, spExp * rowsPerPage);
  const pagedExpiring = expiring7DSC.slice((spExpiring - 1) * rowsPerPage, spExpiring * rowsPerPage);

  // ── Bulk selection ────────────────────────────────────────────────────────
  const toggleSelect   = (id)  => setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleAll      = (list) => {
    const allSel = list.every(d => selectedIds.has(d.id));
    setSelectedIds(prev => { const s = new Set(prev); list.forEach(d => allSel ? s.delete(d.id) : s.add(d.id)); return s; });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkMovement = async () => {
    if (!bulkPersonName.trim()) { toast.error('Person name is required'); return; }
    setBulkLoading(true);
    let success = 0; let failed = 0;
    for (const id of Array.from(selectedIds)) {
      try {
        await api.post(`/dsc/${id}/movement`, { movement_type: bulkMovementType, person_name: bulkPersonName.trim(), notes: bulkNotes.trim() });
        success++;
      } catch { failed++; }
    }
    setBulkLoading(false);
    toast.success(`${success} DSC(s) marked as ${bulkMovementType}${failed > 0 ? `, ${failed} failed` : ''}`);
    setBulkDialogOpen(false);
    setBulkPersonName(''); setBulkNotes('');
    clearSelection();
    fetchDSC();
  };

  const SORT_OPTIONS = [
    { value: 'az',   label: 'A → Z' },
    { value: 'za',   label: 'Z → A' },
    { value: 'fifo', label: 'FIFO (Expiry ↑)' },
    { value: 'lifo', label: 'LIFO (Expiry ↓)' },
  ];

  const renderFormBody = (isEdit) => (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="holder_name">Holder Name <span className="text-red-500">*</span></Label>
          <Input id="holder_name" placeholder="Name of certificate holder" value={formData.holder_name}
            onChange={e => setFormData({ ...formData, holder_name: e.target.value })} required data-testid="dsc-holder-name-input" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dsc_type">Type</Label>
          <Input id="dsc_type" placeholder="e.g. Class 3, Signature, Encryption" value={formData.dsc_type}
            onChange={e => setFormData({ ...formData, dsc_type: e.target.value })} data-testid="dsc-type-input" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="serial_number">Serial Number</Label>
          <Input id="serial_number" placeholder="Certificate serial number" value={formData.serial_number}
            onChange={e => setFormData({ ...formData, serial_number: e.target.value })} className="font-mono text-xs" data-testid="dsc-serial-input" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dsc_password">Password</Label>
          <Input id="dsc_password" type="text" placeholder="DSC Password" value={formData.dsc_password}
            onChange={e => setFormData({ ...formData, dsc_password: e.target.value })} data-testid="dsc-password-input" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="entity_type">Entity Type</Label>
          <Select
            value={formData.entity_type}
            onValueChange={v => setFormData({ ...formData, entity_type: v })}
          >
            <SelectTrigger data-testid="dsc-entity-type-select"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60 overflow-y-auto">
              {ENTITY_TYPE_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {formData.entity_type === 'other' && (
            <Input
              placeholder="Enter entity type (e.g. Society, AOP…)"
              value={formData.entity_type_other || ''}
              onChange={e => setFormData({ ...formData, entity_type_other: e.target.value })}
              autoFocus
            />
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="associated_with">Associated With</Label>
          <Select
            value={formData._assocOther ? '__other__' : (formData.associated_with || '__none__')}
            onValueChange={v => {
              if (v === '__other__') {
                setFormData({ ...formData, _assocOther: true, associated_with: '' });
              } else if (v === '__none__') {
                setFormData({ ...formData, _assocOther: false, associated_with: '' });
              } else {
                setFormData({ ...formData, _assocOther: false, associated_with: v });
              }
            }}
          >
            <SelectTrigger data-testid="dsc-associated-with-select"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60 overflow-y-auto">
              <SelectItem value="__none__">
                {clients.length === 0 ? 'No clients found — add via Clients page' : 'Select client…'}
              </SelectItem>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.company_name}>
                  {c.company_name}{c.client_type_label ? ` (${c.client_type_label})` : ''}
                </SelectItem>
              ))}
              <SelectItem value="__other__">Other (type manually)…</SelectItem>
            </SelectContent>
          </Select>
          {formData._assocOther && (
            <Input
              placeholder="Enter client / entity name"
              value={formData.associated_with}
              onChange={e => setFormData({ ...formData, associated_with: e.target.value })}
              autoFocus
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="issue_date">Issue Date <span className="text-red-500">*</span></Label>
          <Input id="issue_date" type="date" value={formData.issue_date}
            onChange={e => setFormData({ ...formData, issue_date: e.target.value })} required data-testid="dsc-issue-date-input" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="expiry_date">Expiry Date <span className="text-red-500">*</span></Label>
          <Input id="expiry_date" type="date" value={formData.expiry_date}
            onChange={e => setFormData({ ...formData, expiry_date: e.target.value })} required data-testid="dsc-expiry-date-input" />
        </div>
      </div>
      {/* ── Contact Details for WhatsApp & Email alerts ── */}
      <div className={`rounded-xl border p-4 space-y-3 ${isDark ? 'bg-emerald-950/20 border-emerald-800/40' : 'bg-emerald-50 border-emerald-200'}`}>
        <div className="flex items-center gap-2 mb-1">
          <MessageCircle className="h-4 w-4 text-emerald-600" />
          <p className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Contact Details for Alerts</p>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isDark ? 'bg-emerald-900/50 text-emerald-300' : 'bg-emerald-100 text-emerald-600'}`}>WhatsApp & Email</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="mobile" className="flex items-center gap-1.5 text-sm">
              <Phone className="h-3.5 w-3.5" />Mobile Number <span className="text-red-500">*</span>
            </Label>
            <div className="flex gap-2">
              <span className={`flex items-center justify-center px-3 rounded-lg border text-xs font-bold flex-shrink-0 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>+91</span>
              <Input id="mobile" type="tel" placeholder="10-digit mobile" maxLength={15}
                value={formData.mobile}
                onChange={e => setFormData({ ...formData, mobile: e.target.value.replace(/[^0-9+\s-]/g, '') })}
                className={formData.mobile && formData.mobile.replace(/\D/g,'').length >= 10 ? 'border-emerald-400 focus:border-emerald-500' : ''}
                data-testid="dsc-mobile-input" />
            </div>
            <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Used to send WhatsApp alerts directly</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email" className="flex items-center gap-1.5 text-sm">
              <Mail className="h-3.5 w-3.5" />Email Address
            </Label>
            <Input id="email" type="email" placeholder="holder@example.com"
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
              className={formData.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email) ? 'border-emerald-400 focus:border-emerald-500' : ''}
              data-testid="dsc-email-input" />
            <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Used to send expiry alert via email</p>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" placeholder="Additional notes" value={formData.notes}
          onChange={e => setFormData({ ...formData, notes: e.target.value })} rows={2} data-testid="dsc-notes-input" />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }} data-testid="dsc-cancel-btn">Cancel</Button>
        <Button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700" data-testid="dsc-submit-btn">
          {loading ? 'Saving...' : isEdit ? 'Update DSC' : 'Add DSC'}
        </Button>
      </DialogFooter>
    </>
  );

  const tabCard = () => ({
    background: isDark ? '#1e293b' : '#fff',
    borderColor: isDark ? '#334155' : '#e2e8f0',
    borderWidth: '1px',
    borderStyle: 'solid',
  });

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0f172a]' : 'bg-slate-50'}`} data-testid="dsc-page">

      {/* ── Print area ── */}
      <div id="dsc-print-area" className="hidden print:block">
        <h2 className="text-xl font-bold mb-2">DSC Register — {format(new Date(), 'dd MMM yyyy')}</h2>
        <p className="text-sm text-slate-500 mb-4">Total: {dscList.length} | IN: {statsIn} | OUT: {statsOut} | Expired: {statsExpired}</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              {['#','Holder Name','Type','Associated With','Expiry Date','Status','Last Movement'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #e2e8f0', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dscList.map((dsc, i) => {
              const s = getDSCStatus(dsc.expiry_date);
              const last = dsc.movement_log?.length > 0 ? dsc.movement_log[dsc.movement_log.length - 1] : null;
              return (
                <tr key={dsc.id} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{i + 1}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{dsc.holder_name}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{dsc.dsc_type || '-'}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{dsc.associated_with || '-'}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{format(new Date(dsc.expiry_date), 'dd MMM yyyy')}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{s.text}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{last ? `${last.movement_type} — ${last.person_name} (${format(new Date(last.timestamp), 'dd MMM yy')})` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Banner Header ── */}
      <div className="relative overflow-hidden rounded-2xl"
        style={{ background: 'linear-gradient(135deg, #0D3B66 0%, #1F6FB2 60%, #1a8fcc 100%)', boxShadow: '0 8px 32px rgba(13,59,102,0.28)' }}>
        <div className="absolute right-0 top-0 w-72 h-72 rounded-full -mr-24 -mt-24 opacity-10"
          style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
        <div className="absolute right-28 bottom-0 w-40 h-40 rounded-full mb-[-40px] opacity-5" style={{ background: 'white' }} />
        <div className="absolute left-0 bottom-0 w-48 h-48 rounded-full -ml-20 -mb-20 opacity-5" style={{ background: 'white' }} />
        <div className="relative px-4 sm:px-6 pt-4 sm:pt-5 pb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center flex-shrink-0 mt-0.5">
              <Key className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1">Registers</p>
              <h1 className="text-2xl font-bold text-white leading-tight">DSC Register</h1>
              <p className="text-white/60 text-sm mt-0.5">Click any row to view full details & share via WhatsApp</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={handlePrint}
              className="h-9 px-4 gap-2 rounded-xl text-sm bg-white/15 border-0 text-white hover:bg-white/25 backdrop-blur-sm shadow-sm">
              <Printer className="h-4 w-4" />Print
            </Button>
            {/* ── WhatsApp Automation Button ── */}
            <Button
              variant="outline"
              onClick={() => setWhatsappAutoOpen(true)}
              className="h-9 px-4 gap-2 rounded-xl text-sm backdrop-blur-sm font-semibold transition-all shadow-sm"
              style={{
                backgroundColor: autoEnabled ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.12)',
                border: 'none',
                color: autoEnabled ? '#6ee7b7' : '#fff',
              }}
              title="WhatsApp expiry alerts & automation"
            >
              {autoEnabled ? <Bell className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
              WA Alerts {autoEnabled && <span className="ml-0.5 text-[10px] bg-emerald-400/30 px-1.5 py-0.5 rounded-full">AUTO ON</span>}
            </Button>
            {/* ── USB DSC Token Button ── */}
            {usbSupported && (
              <Button
                variant="outline"
                onClick={usbPermission === 'granted' ? () => { setUsbDismissed(false); handleGrantUsbAccess(); } : handleGrantUsbAccess}
                disabled={usbGranting}
                className="h-9 px-4 gap-2 rounded-xl text-sm backdrop-blur-sm font-semibold transition-all shadow-sm"
                style={{
                  backgroundColor: usbPermission === 'granted' ? 'rgba(16,185,129,0.25)' : 'rgba(99,102,241,0.25)',
                  border: 'none',
                  color: usbPermission === 'granted' ? '#6ee7b7' : '#c7d2fe',
                }}
                title={usbPermission === 'granted' ? 'Scan for plugged-in DSC token' : 'Grant browser permission to detect DSC USB tokens'}
              >
                {usbGranting
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Scanning…</>
                  : usbPermission === 'granted'
                    ? <><Usb className="h-3.5 w-3.5" />Scan DSC Token</>
                    : <><Usb className="h-3.5 w-3.5" />Enable DSC Detection</>}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleDetectDscDuplicates}
              disabled={detectingDups || dscList.length === 0}
              className="h-9 px-4 gap-2 rounded-xl text-sm backdrop-blur-sm font-semibold transition-all disabled:opacity-40 shadow-sm"
              style={{ backgroundColor: 'rgba(139,92,246,0.30)', border: 'none', color: '#ede9fe' }}
            >
              {detectingDups
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Scanning…</>
                : <><Sparkles className="h-3.5 w-3.5" />AI Duplicates</>}
            </Button>
            {/* "Add DSC" opens the SAME unified popup as USB token detection
                (with device=null for manual entry). The legacy Dialog below is
                only used for editing existing DSCs. */}
            <Button
              onClick={() => {
                resetForm();
                setUsbDevice(null);
                setUsbDismissed(false);
                setUsbPromptOpen(true);
              }}
              className="bg-white text-indigo-700 hover:bg-blue-50 font-semibold rounded-xl px-5 shadow-lg transition-all hover:scale-105 active:scale-95 border-0"
              data-testid="add-dsc-btn"
            >
              <Plus className="mr-2 h-4 w-4" />Add DSC
            </Button>
            <Dialog open={dialogOpen && !!editingDSC} onOpenChange={open => { setDialogOpen(open); if (!open) resetForm(); }}>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="font-outfit text-2xl">{editingDSC ? 'Edit DSC' : 'Add New DSC'}</DialogTitle>
                  <DialogDescription>{editingDSC ? 'Update DSC details and view movement history' : 'Add a new digital signature certificate'}</DialogDescription>
                </DialogHeader>
                {editingDSC ? (
                  <Tabs defaultValue="details" className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="details">Details</TabsTrigger>
                      <TabsTrigger value="history">Movement History ({editingDSC?.movement_log?.length || 0})</TabsTrigger>
                    </TabsList>
                    <TabsContent value="details">
                      <form onSubmit={handleSubmit} className="space-y-4">{renderFormBody(true)}</form>
                    </TabsContent>
                    <TabsContent value="history">
                      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                        {editingDSC?.movement_log?.length > 0
                          ? [...editingDSC.movement_log].reverse().map((movement, idx) => {
                              const isEditing = editingMovement === (movement.id || movement.timestamp);
                              return (
                                <Card key={movement.id || idx} className="p-3">
                                  {isEditing ? (
                                    <div className="space-y-3">
                                      <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                          <Label className="text-xs">Movement Type</Label>
                                          <Select value={editMovementData.movement_type} onValueChange={v => setEditMovementData({ ...editMovementData, movement_type: v })}>
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="IN">IN</SelectItem>
                                              <SelectItem value="OUT">OUT</SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-xs">Person Name</Label>
                                          <Input value={editMovementData.person_name} onChange={e => setEditMovementData({ ...editMovementData, person_name: e.target.value })} />
                                        </div>
                                      </div>
                                      <div className="space-y-1">
                                        <Label className="text-xs">Notes</Label>
                                        <Textarea value={editMovementData.notes} onChange={e => setEditMovementData({ ...editMovementData, notes: e.target.value })} rows={2} />
                                      </div>
                                      <div className="flex gap-2 justify-end">
                                        <Button type="button" size="sm" variant="outline" onClick={() => setEditingMovement(null)}>Cancel</Button>
                                        <Button type="button" size="sm" className="bg-indigo-600 hover:bg-indigo-700"
                                          onClick={() => handleUpdateMovement(movement.id)} disabled={loading || !editMovementData.person_name}>
                                          {loading ? 'Saving...' : 'Save'}
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-1">
                                          <Badge className={movement.movement_type === 'IN' ? 'bg-emerald-600 text-xs' : 'bg-red-600 text-xs'}>{movement.movement_type}</Badge>
                                          <span className="text-sm font-medium">{movement.person_name}</span>
                                        </div>
                                        {movement.notes && <p className="text-xs text-slate-600">{movement.notes}</p>}
                                        {movement.edited_at && (
                                          <p className="text-xs text-slate-400 mt-1">Edited by {movement.edited_by} on {format(new Date(movement.edited_at), 'MMM dd, yyyy')}</p>
                                        )}
                                      </div>
                                      <div className="flex flex-col items-end gap-2">
                                        <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                          {format(new Date(movement.timestamp), 'MMM dd, yyyy hh:mm a')}
                                        </span>
                                        {movement.id && (
                                          <Button type="button" size="sm" variant="ghost"
                                            className="h-7 px-2 text-xs text-slate-500 hover:text-indigo-600"
                                            onClick={() => startEditingMovement(movement)}>
                                            <Edit className="h-3 w-3 mr-1" />Edit
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </Card>
                              );
                            })
                          : <div className="text-center py-8 text-slate-500"><History className="h-12 w-12 mx-auto mb-3 text-slate-300" /><p>No movement history yet</p></div>
                        }
                      </div>
                    </TabsContent>
                  </Tabs>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-4">{renderFormBody(false)}</form>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* ── Stats strip ── */}
        <div className="relative px-6 pb-6 grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Total IN',     value: statsIn,         icon: ArrowDownCircle, color: '#10b981' },
            { label: 'Total OUT',    value: statsOut,        icon: ArrowUpCircle,   color: '#ef4444' },
            { label: 'EXPIRING 7 DAYS',  value: statsExpiring7,  icon: AlertCircle,     color: '#f97316' },
            { label: 'Expiring 30d', value: statsExpiring30, icon: Clock,           color: '#f59e0b' },
            { label: 'Expired',      value: statsExpired,    icon: TrendingDown,    color: '#94a3b8' },
          ].map(stat => {
            const Icon = stat.icon;
            return (
              <div key={stat.label}
                className="rounded-xl backdrop-blur-sm px-4 py-3 flex items-center gap-3 cursor-default transition-all hover:scale-[1.03] shadow-sm hover:shadow-md"
                style={{ background: 'rgba(255,255,255,0.12)', border: 'none', outline: 'none', backdropFilter: 'blur(10px)' }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${stat.color}35` }}>
                  <Icon className="h-4 w-4" style={{ color: stat.color }} />
                </div>
                <div>
                  <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest leading-none">{stat.label}</p>
                  <p className="text-white text-2xl font-black tabular-nums leading-tight mt-0.5" style={{ fontFamily: "'Roboto Mono', monospace" }}>{stat.value}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Page body ── */}
      <div className="px-6 py-6 space-y-5">

        {/* Alert banner */}
        {dscList.filter(d => getDSCStatus(d.expiry_date).color !== 'bg-emerald-500').length > 0 && (
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${isDark ? 'bg-orange-900/20 border-orange-700/40' : 'bg-orange-50 border-orange-200'}`}>
            <AlertCircle className="h-5 w-5 text-orange-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className={`text-sm font-semibold ${isDark ? 'text-orange-300' : 'text-orange-900'}`}>Attention Required</p>
              <p className={`text-sm mt-0.5 ${isDark ? 'text-orange-400' : 'text-orange-700'}`}>
                {dscList.filter(d => getDSCStatus(d.expiry_date).color === 'bg-red-500' || getDSCStatus(d.expiry_date).color === 'bg-orange-500').length} certificate(s) expired or expiring within 7 days.{' '}
                {dscList.filter(d => getDSCStatus(d.expiry_date).color === 'bg-yellow-500').length} expiring within 30 days.
              </p>
            </div>
          </div>
        )}

        {/* Controls bar */}
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap items-center">
          <Select value={rowsPerPage.toString()} onValueChange={v => { setRowsPerPage(Number(v)); setCurrentPageIn(1); setCurrentPageOut(1); setCurrentPageExpired(1); }}>
            <SelectTrigger className={`w-[140px] focus:border-indigo-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}>
              <SelectValue placeholder="Rows per page" />
            </SelectTrigger>
            <SelectContent>
              {[15,30,50,100].map(n => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
            </SelectContent>
          </Select>

          <div className={`flex items-center gap-2 border rounded-xl px-3 h-10 ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
            <ArrowUpDown className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <div className="flex items-center gap-1">
              {SORT_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setSortOrder(opt.value)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                  style={{ background: sortOrder === opt.value ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : 'transparent', color: sortOrder === opt.value ? '#fff' : (isDark ? '#94a3b8' : '#64748b') }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input ref={searchRef} type="text" placeholder='Search… (press "/" to focus)' value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              name="dsc-search-query"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              className={`pl-10 pr-16 focus:border-indigo-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-200'}`}
              data-testid="dsc-search-input" />
            {!searchQuery && (
              <kbd className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded border ${isDark ? 'bg-slate-700 border-slate-500 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-400'}`}>/</kbd>
            )}
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${isDark ? 'bg-indigo-900/30 border-indigo-700' : 'bg-indigo-50 border-indigo-200'}`}>
            <CheckSquare className="h-4 w-4 text-indigo-500 flex-shrink-0" />
            <span className={`text-sm font-semibold ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>{selectedIds.size} DSC selected</span>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" onClick={() => { setBulkMovementType('IN'); setBulkDialogOpen(true); }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs rounded-lg gap-1">
                <ArrowDownCircle className="h-3.5 w-3.5" />Mark all IN
              </Button>
              <Button size="sm" onClick={() => { setBulkMovementType('OUT'); setBulkDialogOpen(true); }}
                className="bg-red-600 hover:bg-red-700 text-white h-8 px-3 text-xs rounded-lg gap-1">
                <ArrowUpCircle className="h-3.5 w-3.5" />Mark all OUT
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}
                className={`h-8 px-3 text-xs rounded-lg ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* Row colour legend */}
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className={`font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Row colours:</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-orange-200 inline-block border border-orange-300" />Expiring ≤ 7 days</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-yellow-100 inline-block border border-yellow-300" />Expiring ≤ 30 days</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 inline-block border border-red-300" />Expired</span>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className={`inline-flex h-11 items-center rounded-xl p-1 gap-1 ${isDark ? 'bg-slate-800 border border-slate-700' : 'bg-slate-100 border border-slate-200'}`}>
            {searchQuery.trim() && (
              <TabsTrigger value="all"
                className="rounded-lg px-5 py-2 text-sm font-semibold transition-all data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md">
                🔍 All Results ({allDSC.length})
              </TabsTrigger>
            )}
            <TabsTrigger value="in"
              className="rounded-lg px-5 py-2 text-sm font-semibold transition-all data-[state=active]:bg-emerald-500 data-[state=active]:text-white data-[state=active]:shadow-md">
              <ArrowDownCircle className="h-4 w-4 mr-1.5 inline" />IN ({inDSC.length})
            </TabsTrigger>
            <TabsTrigger value="out"
              className="rounded-lg px-5 py-2 text-sm font-semibold transition-all data-[state=active]:bg-red-500 data-[state=active]:text-white data-[state=active]:shadow-md">
              <ArrowUpCircle className="h-4 w-4 mr-1.5 inline" />OUT ({outDSC.length})
            </TabsTrigger>
            <TabsTrigger value="expired"
              className="rounded-lg px-5 py-2 text-sm font-semibold transition-all data-[state=active]:bg-amber-600 data-[state=active]:text-white data-[state=active]:shadow-md">
              <AlertCircle className="h-4 w-4 mr-1.5 inline" />EXPIRED ({expiredDSC.length})
            </TabsTrigger>
            <TabsTrigger value="expiring7"
              className="rounded-lg px-4 py-2 text-sm font-semibold transition-all data-[state=active]:bg-orange-500 data-[state=active]:text-white data-[state=active]:shadow-md relative">
              <Clock className="h-4 w-4 mr-1.5 inline" />EXPIRING 7 DAYS
              {expiring7DSC.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full text-[10px] font-bold bg-orange-500 text-white data-[state=active]:bg-white data-[state=active]:text-orange-600" style={{background: activeTab === 'expiring7' ? '#fff' : '#f97316', color: activeTab === 'expiring7' ? '#ea580c' : '#fff'}}>
                  {expiring7DSC.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ALL tab — shown only when searching */}
          <TabsContent value="all" className="mt-4">
            <div className="rounded-xl border shadow-sm overflow-hidden flex flex-col" style={tabCard()}>
              <div className={`border-b px-5 py-3 flex items-center gap-2 ${isDark ? 'bg-blue-950/40 border-blue-900/40 text-blue-300' : 'bg-blue-50/80 border-blue-100 text-blue-700'}`}>
                <Search className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                <p className="text-sm font-semibold uppercase tracking-wider">All Results for "{searchQuery}" ({allDSC.length})</p>
              </div>
              {allDSC.length === 0
                ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    <Search className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No DSC certificates found for "{searchQuery}"</p>
                  </div>
                : <DSCTable dscList={allDSC} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                    onViewLog={openLogDialog} getDSCStatus={getDSCStatus} type="IN"
                    globalIndexStart={0} isDark={isDark}
                    selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
                    onWhatsAppAlert={handleWhatsAppAlert} />
              }
            </div>
          </TabsContent>

          {/* IN tab */}
          <TabsContent value="in" className="mt-4">
            <div className="rounded-xl border shadow-sm overflow-hidden flex flex-col" style={tabCard()}>
              <div className={`border-b px-5 py-3 flex items-center gap-2 ${isDark ? 'bg-emerald-950/40 border-emerald-900/40 text-emerald-300' : 'bg-emerald-50/80 border-emerald-100 text-emerald-700'}`}>
                <ArrowDownCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                <p className="text-sm font-semibold uppercase tracking-wider">DSC IN — Available ({inDSC.length})</p>
              </div>
              {loading && inDSC.length === 0
                ? <MiniLoader />
                : inDSC.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <ArrowDownCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No DSC certificates currently IN</p>
                    </div>
                  : <DSCTable dscList={pagedIn} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} getDSCStatus={getDSCStatus} type="IN"
                      globalIndexStart={(spIn-1)*rowsPerPage} isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
                      onWhatsAppAlert={handleWhatsAppAlert} />
              }
              <PaginationBar currentPage={spIn} totalPages={tpIn} totalItems={inDSC.length} pageSize={rowsPerPage} onPageChange={setCurrentPageIn} isDark={isDark} />
            </div>
          </TabsContent>

          {/* OUT tab */}
          <TabsContent value="out" className="mt-4">
            <div className="rounded-xl border shadow-sm overflow-hidden flex flex-col" style={tabCard()}>
              <div className={`border-b px-5 py-3 flex items-center gap-2 ${isDark ? 'bg-red-950/40 border-red-900/40 text-red-300' : 'bg-red-50/80 border-red-100 text-red-700'}`}>
                <ArrowUpCircle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                <p className="text-sm font-semibold uppercase tracking-wider">DSC OUT — Taken ({outDSC.length})</p>
              </div>
              {loading && outDSC.length === 0
                ? <MiniLoader />
                : outDSC.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <ArrowUpCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No DSC certificates currently OUT</p>
                    </div>
                  : <DSCTable dscList={pagedOut} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} getDSCStatus={getDSCStatus} type="OUT"
                      globalIndexStart={(spOut-1)*rowsPerPage} isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
                      onWhatsAppAlert={handleWhatsAppAlert} />
              }
              <PaginationBar currentPage={spOut} totalPages={tpOut} totalItems={outDSC.length} pageSize={rowsPerPage} onPageChange={setCurrentPageOut} isDark={isDark} />
            </div>
          </TabsContent>

          {/* EXPIRED tab */}
          <TabsContent value="expired" className="mt-4">
            <div className="rounded-xl border shadow-sm overflow-hidden flex flex-col" style={tabCard()}>
              <div className={`border-b px-5 py-3 flex items-center gap-2 ${isDark ? 'bg-amber-950/40 border-amber-900/40 text-amber-300' : 'bg-amber-50/80 border-amber-100 text-amber-700'}`}>
                <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="text-sm font-semibold uppercase tracking-wider">DSC EXPIRED ({expiredDSC.length})</p>
              </div>
              {loading && expiredDSC.length === 0
                ? <MiniLoader />
                : expiredDSC.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <AlertCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No expired DSC certificates</p>
                    </div>
                  : <DSCTable dscList={pagedExp} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} getDSCStatus={getDSCStatus} type="EXPIRED"
                      globalIndexStart={(spExp-1)*rowsPerPage} isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
                      onWhatsAppAlert={handleWhatsAppAlert} />
              }
              <PaginationBar currentPage={spExp} totalPages={tpExp} totalItems={expiredDSC.length} pageSize={rowsPerPage} onPageChange={setCurrentPageExpired} isDark={isDark} />
            </div>
          </TabsContent>

          {/* EXPIRING 7d tab */}
          <TabsContent value="expiring7" className="mt-4">
            <div className="rounded-xl border shadow-sm overflow-hidden flex flex-col" style={tabCard()}>
              <div className={`border-b px-5 py-3 flex items-center justify-between gap-2 ${isDark ? 'bg-orange-950/40 border-orange-900/40 text-orange-300' : 'bg-orange-50/80 border-orange-100 text-orange-700'}`}>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-orange-600 dark:text-orange-400 flex-shrink-0" />
                  <p className="text-sm font-semibold uppercase tracking-wider">DSC EXPIRING WITHIN 7 DAYS ({expiring7DSC.length})</p>
                </div>
                {expiring7DSC.length > 0 && (
                  <Button size="sm" onClick={() => {
                    expiring7DSC.forEach((dsc, i) => {
                      setTimeout(() => {
                        const msg = buildExpiryAlertText(dsc, getWASettings());
                        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
                      }, i * 700);
                    });
                    toast.success(`Opening WhatsApp for ${expiring7DSC.length} holder(s)…`);
                  }}
                    className="h-8 px-3 text-xs gap-1.5 rounded-lg font-semibold"
                    style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff', border: 'none' }}>
                    <MessageCircle className="h-3.5 w-3.5" />
                    Alert All ({expiring7DSC.length}) via WhatsApp
                  </Button>
                )}
              </div>
              {loading && expiring7DSC.length === 0
                ? <MiniLoader />
                : expiring7DSC.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No DSC certificates expiring within 7 days 🎉</p>
                    </div>
                  : <DSCTable dscList={pagedExpiring} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} getDSCStatus={getDSCStatus} type="IN"
                      globalIndexStart={(spExpiring-1)*rowsPerPage} isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
                      onWhatsAppAlert={handleWhatsAppAlert} />
              }
              <PaginationBar currentPage={spExpiring} totalPages={tpExpiring} totalItems={expiring7DSC.length} pageSize={rowsPerPage} onPageChange={setCurrentPageExpiring} isDark={isDark} />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Bulk Movement Dialog ── */}
      <Dialog open={bulkDialogOpen} onOpenChange={open => { setBulkDialogOpen(open); if (!open) { setBulkPersonName(''); setBulkNotes(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-outfit text-2xl">Bulk Mark as {bulkMovementType}</DialogTitle>
            <DialogDescription>{selectedIds.size} DSC certificate(s) selected will be marked as {bulkMovementType}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{bulkMovementType === 'IN' ? 'Delivered By *' : 'Taken By *'}</Label>
              <Input placeholder="Enter person name" value={bulkPersonName} onChange={e => setBulkPersonName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea placeholder="Additional notes" value={bulkNotes} onChange={e => setBulkNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Cancel</Button>
            <Button disabled={bulkLoading || !bulkPersonName.trim()} onClick={handleBulkMovement}
              className={bulkMovementType === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}>
              {bulkLoading ? 'Processing...' : `Mark ${selectedIds.size} as ${bulkMovementType}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Single Movement Dialog ── */}
      <Dialog open={movementDialogOpen} onOpenChange={setMovementDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-outfit text-2xl">Mark DSC as {movementData.movement_type}</DialogTitle>
            <DialogDescription>{movementData.movement_type === 'IN' ? 'Record when DSC is delivered/returned' : 'Record when DSC is taken out'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleMovement} className="space-y-4">
            <div className="space-y-2">
              <Label>DSC Certificate</Label>
              <p className="text-sm font-semibold">{selectedDSC?.holder_name}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="person_name">{movementData.movement_type === 'IN' ? 'Delivered By *' : 'Taken By *'}</Label>
              <Input id="person_name" placeholder="Enter person name" value={movementData.person_name}
                onChange={e => setMovementData({ ...movementData, person_name: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="movement_notes">Notes</Label>
              <Textarea id="movement_notes" placeholder="Additional notes" value={movementData.notes}
                onChange={e => setMovementData({ ...movementData, notes: e.target.value })} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMovementDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={loading}
                className={movementData.movement_type === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}>
                {loading ? 'Recording...' : `Mark as ${movementData.movement_type}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── DSC Details / Share Dialog ── */}
      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="max-w-xl p-0 border-none bg-transparent shadow-none overflow-visible">
          <DialogHeader className="sr-only">
            <DialogTitle>DSC Details — {selectedDSC?.holder_name}</DialogTitle>
            <DialogDescription>Full details of the selected DSC. Use the buttons to share via WhatsApp, email, or download the screenshot.</DialogDescription>
          </DialogHeader>

          <div ref={shareAreaRef} className={`rounded-xl overflow-hidden shadow-2xl ${isDark ? 'bg-slate-900 border border-slate-700 text-white' : 'bg-white border border-slate-200 text-slate-900'}`} style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            {/* ── Card body — captured by html2canvas (ref=cardCaptureRef) ── */}
            <div ref={cardCaptureRef}>
            {(() => {
              const daysLeft = selectedDSC ? Math.ceil((new Date(selectedDSC.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)) : 999;
              const isUrgent = daysLeft <= 7;
              const isExpiredDSC = daysLeft < 0;
              const headerGrad = isExpiredDSC
                ? 'linear-gradient(135deg,#7f1d1d,#dc2626)'
                : isUrgent
                  ? 'linear-gradient(135deg,#7c2d12,#ea580c)'
                  : 'linear-gradient(135deg,#0f1f4d,#1e3a8a)';
              return (
            <div className="relative px-6 py-5" style={{ background: headerGrad }}>
              {isUrgent && <div className="absolute inset-0 opacity-10" style={{ background: 'repeating-linear-gradient(45deg,#fff,#fff 2px,transparent 2px,transparent 12px)' }} />}
              <div className="flex items-center gap-3 relative">
                <div className="h-13 w-13 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur">
                  {isExpiredDSC ? <AlertCircle className="h-6 w-6 text-white" /> : isUrgent ? <Clock className="h-6 w-6 text-white" /> : <Key className="h-6 w-6 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold tracking-[0.18em] text-white/60 uppercase">
                    {isExpiredDSC ? 'DSC EXPIRED' : isUrgent ? 'DSC EXPIRING SOON' : 'DSC Details'}
                  </p>
                  <h2 className="text-xl font-bold text-white break-words leading-tight">{selectedDSC?.holder_name || '—'}</h2>
                  {isUrgent && (
                    <p className="text-white/80 text-xs mt-0.5 font-semibold">
                      {isExpiredDSC ? `Expired on ${format(new Date(selectedDSC.expiry_date), 'dd MMM yyyy')}` : `Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`}
                    </p>
                  )}
                </div>
              </div>
            </div>
              );
            })()}

            <div className="p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className={`text-[11px] font-semibold px-3 py-1 rounded-full ${getDocumentInOutStatus(selectedDSC) === 'IN' ? 'bg-emerald-50 text-emerald-600' : 'bg-orange-50 text-orange-600'}`}>
                  {getDocumentInOutStatus(selectedDSC) === 'IN' ? 'Available' : 'Out'}
                </span>
                {selectedDSC?.dsc_type && (
                  <span className="text-[11px] font-semibold px-3 py-1 rounded-full bg-rose-50 text-rose-600 capitalize">{selectedDSC.dsc_type}</span>
                )}
                {selectedDSC?.entity_type && (
                  <span className="text-[11px] font-semibold px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 capitalize">{selectedDSC.entity_type}</span>
                )}
                {selectedDSC?.expiry_date && (
                  <span className={`text-[11px] font-semibold px-3 py-1 rounded-full ${getDSCStatus(selectedDSC.expiry_date).textColor} ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    {getDSCStatus(selectedDSC.expiry_date).label || 'Expiry'}
                  </span>
                )}
              </div>

              <div>
                <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-1.5">Associated With</p>
                <div className={`rounded-lg px-3 py-2.5 text-sm font-semibold capitalize ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
                  {selectedDSC?.associated_with || 'N/A'}
                </div>
              </div>

              <div className="space-y-3 pt-1">
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <Shield className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Holder Name</p>
                    <p className="text-sm font-semibold capitalize">{selectedDSC?.holder_name || '—'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <Key className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Security Password</p>
                    <p className="text-sm font-mono">{selectedDSC?.dsc_password || '********'}</p>
                  </div>
                </div>
                {selectedDSC?.serial_number && (
                  <div className="flex items-start gap-3">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                      <Shield className="h-3.5 w-3.5 text-indigo-400" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Serial Number</p>
                      <p className="text-xs font-mono text-indigo-500 break-all">{selectedDSC.serial_number}</p>
                    </div>
                  </div>
                )}
                {(selectedDSC?.mobile || selectedDSC?.email) && (
                  <div className={`flex items-start gap-3 rounded-xl p-3 ${isDark ? 'bg-emerald-950/30 border border-emerald-800/30' : 'bg-emerald-50 border border-emerald-100'}`}>
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 flex-shrink-0 ${isDark ? 'bg-emerald-900/50' : 'bg-emerald-100'}`}>
                      <MessageCircle className="h-3.5 w-3.5 text-emerald-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-bold tracking-[0.15em] text-emerald-500 uppercase mb-1.5">Contact for Alerts</p>
                      {selectedDSC?.mobile && (
                        <div className="flex items-center gap-2 mb-1">
                          <Phone className="h-3 w-3 text-slate-400 flex-shrink-0" />
                          <button
                            onClick={() => { const msg = buildExpiryAlertText(selectedDSC, waMsgSettings); const ph = selectedDSC.mobile.replace(/\s|-|\+/g,''); window.open(`https://wa.me/${ph.startsWith('91')?ph:'91'+ph}?text=${encodeURIComponent(msg)}`, '_blank'); }}
                            className="text-sm font-semibold text-emerald-600 hover:underline"
                            title="Click to send WhatsApp alert">
                            {selectedDSC.mobile}
                          </button>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${isDark ? 'bg-emerald-900/60 text-emerald-400' : 'bg-emerald-100 text-emerald-600'}`}>WhatsApp →</span>
                        </div>
                      )}
                      {selectedDSC?.email && (
                        <div className="flex items-center gap-2">
                          <Mail className="h-3 w-3 text-slate-400 flex-shrink-0" />
                          <a href={`mailto:${selectedDSC.email}?subject=DSC Expiry Alert — ${selectedDSC.holder_name}&body=${encodeURIComponent(buildExpiryAlertText(selectedDSC, waMsgSettings))}`}
                            className="text-sm font-semibold text-blue-500 hover:underline truncate" title="Click to send email alert">
                            {selectedDSC.email}
                          </a>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0 ${isDark ? 'bg-blue-900/40 text-blue-400' : 'bg-blue-50 text-blue-600'}`}>Email →</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <Clock className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Issue Date</p>
                    <p className="text-sm font-semibold">{selectedDSC?.issue_date ? format(new Date(selectedDSC.issue_date), 'dd MMM, yyyy') : '—'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <AlertCircle className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Expiry Date</p>
                    <p className={`text-sm font-bold ${selectedDSC ? getDSCStatus(selectedDSC.expiry_date).textColor : ''}`}>
                      {selectedDSC?.expiry_date ? format(new Date(selectedDSC.expiry_date), 'dd MMM, yyyy') : '—'}
                    </p>
                  </div>
                </div>
                {selectedDSC?.movement_log?.length > 0 && (() => {
                  const lastMove = selectedDSC.movement_log[selectedDSC.movement_log.length - 1];
                  return (
                    <div className="flex items-start gap-3">
                      <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                        <History className="h-3.5 w-3.5 text-slate-500" />
                      </div>
                      <div className="flex-1">
                        <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Last Movement</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge className={`text-[10px] px-2 py-0.5 font-bold ${lastMove.movement_type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                            {lastMove.movement_type}
                          </Badge>
                          <p className="text-sm font-semibold capitalize">{lastMove.person_name}</p>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">{format(new Date(lastMove.timestamp), 'dd MMM yyyy, hh:mm a')}</p>
                        {lastMove.notes && <p className="text-xs text-slate-500 mt-0.5 italic capitalize">{lastMove.notes}</p>}
                      </div>
                    </div>
                  );
                })()}
                {selectedDSC?.notes && (
                  <div className="flex items-start gap-3">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                      <History className="h-3.5 w-3.5 text-slate-500" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Notes</p>
                      <p className="text-sm capitalize">{selectedDSC.notes}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            </div>{/* end cardCaptureRef */}

            {/* ── Action footer — NOT captured in screenshot ── */}
            <div className={`px-4 py-3 border-t print:hidden ${isDark ? 'border-slate-700 bg-slate-900/50' : 'border-slate-100 bg-slate-50/50'}`}>
              {/* Primary row: Send Message | Screenshot → WA */}
              <div className="flex gap-2 mb-2">
                <button
                  disabled={sharing}
                  onClick={() => handleSendTextAlert(selectedDSC)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff', boxShadow: '0 2px 8px rgba(37,211,102,0.30)' }}>
                  {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                  Send Message
                </button>
                <button
                  disabled={sharing}
                  onClick={() => shareScreenshotToWhatsApp(selectedDSC)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold border-2 transition-all active:scale-95 disabled:opacity-50"
                  style={{ borderColor: '#25d366', color: '#16a34a', background: isDark ? 'rgba(37,211,102,0.08)' : '#f0fdf4' }}>
                  {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Screenshot → WA
                </button>
              </div>
              {/* Secondary row: Download | Email | Copy */}
              <div className="flex gap-2">
                <button
                  disabled={sharing}
                  onClick={() => downloadScreenshot(selectedDSC)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border transition-all active:scale-95 disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
                  <Download className="h-3.5 w-3.5" />Download
                </button>
                <button
                  disabled={sharing}
                  onClick={() => handleShare('email')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border transition-all active:scale-95 disabled:opacity-50 ${isDark ? 'border-slate-600 text-blue-400 hover:bg-slate-800' : 'border-blue-200 text-blue-600 hover:bg-blue-50'}`}>
                  <Mail className="h-3.5 w-3.5" />Email
                </button>
                <button
                  disabled={sharing}
                  onClick={() => handleShare('copy')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border transition-all active:scale-95 disabled:opacity-50 ${isDark ? 'border-slate-600 text-indigo-400 hover:bg-slate-800' : 'border-indigo-200 text-indigo-600 hover:bg-indigo-50'}`}>
                  <Share2 className="h-3.5 w-3.5" />Copy
                </button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Unified Add DSC / USB Token Popup ──
          Renders for both manual "Add DSC" (device=null) and auto-detected USB tokens. */}
      {usbPromptOpen && (
        <UsbDscPopup
          device={usbDevice}
          isDark={isDark}
          clients={clients}
          onDismiss={() => {
            setUsbPromptOpen(false);
            setUsbDismissed(true);
          }}
          onSaved={() => {
            setUsbPromptOpen(false);
            fetchDSC();
            // Switch to IN tab to show the newly added DSC
            setActiveTab('in');
          }}
        />
      )}

      {/* ── WhatsApp Share Choice Dialog ── */}
      {shareChoiceDialog && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4" style={{ background: 'rgba(6,78,59,0.60)', backdropFilter: 'blur(6px)' }}>
          <div className={`rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: '#25d36620' }}>
                  <MessageCircle className="h-5 w-5" style={{ color: '#25d366' }} />
                </div>
                <div>
                  <h3 className={`font-bold text-base ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Send WhatsApp Alert</h3>
                  <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{shareChoiceDialog.holder_name}</p>
                </div>
              </div>
              <p className={`text-sm mb-4 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>How would you like to send the DSC expiry alert?</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleWhatsAppChoice('message', shareChoiceDialog)}
                  className="flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-95"
                  style={{ borderColor: '#25d366', background: '#25d36610' }}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#25d36625' }}>
                    <Send className="h-5 w-5" style={{ color: '#25d366' }} />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-bold" style={{ color: '#25d366' }}>Send Message</p>
                    <p className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Text alert with details</p>
                  </div>
                </button>
                <button
                  onClick={() => handleWhatsAppChoice('screenshot', shareChoiceDialog)}
                  className={`flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-95 ${isDark ? 'border-slate-600 hover:border-indigo-500' : 'border-slate-200 hover:border-indigo-400'}`}
                  style={{ background: isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.05)' }}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDark ? 'bg-indigo-900/40' : 'bg-indigo-50'}`}>
                    <Download className="h-5 w-5 text-indigo-500" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-bold text-indigo-500">Screenshot</p>
                    <p className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Visual card image</p>
                  </div>
                </button>
              </div>
            </div>
            <div className={`px-6 pb-5 border-t pt-4 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
              <button
                onClick={() => setShareChoiceDialog(null)}
                className={`w-full py-2 rounded-xl text-sm font-semibold border ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── WhatsApp Message Settings Dialog ── */}
      {waMsgSettingsOpen && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4" style={{ background: 'rgba(6,78,59,0.60)', backdropFilter: 'blur(6px)' }}>
          <div className={`rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className="px-6 pt-6 pb-4 flex items-center gap-3 border-b" style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-indigo-900/40' : 'bg-indigo-50'}`}>
                <Settings2 className="h-5 w-5 text-indigo-500" />
              </div>
              <div className="flex-1">
                <h3 className={`font-bold text-base ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>WhatsApp Message Template</h3>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Customise the expiry alert message sent via WhatsApp</p>
              </div>
              <button onClick={() => setWaMsgSettingsOpen(false)} className={`h-8 w-8 rounded-lg flex items-center justify-center ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>✕</button>
            </div>
            <div className="px-6 py-5 space-y-5">
              {[
                { key: 'senderName', label: 'Sender Name (Signature)', placeholder: 'e.g. Your Firm Name', hint: 'Appears at the bottom of every message as "— Sender Name"' },
                { key: 'greetingPrefix', label: 'Greeting Prefix', placeholder: 'e.g. Dear / Hello / Hi', hint: 'Appears before the holder\'s name' },
              ].map(({ key, label, placeholder, hint }) => (
                <div key={key}>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
                  <input
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'}`}
                    placeholder={placeholder}
                    value={waMsgSettings[key] || ''}
                    onChange={e => setWaMsgSettings(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                  {hint && <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{hint}</p>}
                </div>
              ))}
              {[
                { key: 'footerNote', label: 'Renewal Reminder (expiring)', placeholder: 'Message for DSC expiring soon...' },
                { key: 'expiredFooterNote', label: 'Renewal Reminder (expired)', placeholder: 'Message for already expired DSC...' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
                  <textarea
                    rows={3}
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'}`}
                    placeholder={placeholder}
                    value={waMsgSettings[key] || ''}
                    onChange={e => setWaMsgSettings(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="flex gap-4">
                {[
                  { key: 'showOrganisation', label: 'Show Organisation' },
                  { key: 'showSerialNumber', label: 'Show Serial Number' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <button
                      onClick={() => setWaMsgSettings(prev => ({ ...prev, [key]: !prev[key] }))}
                      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0"
                      style={{ background: waMsgSettings[key] ? '#6366f1' : (isDark ? '#334155' : '#d1d5db') }}>
                      <span className="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform"
                        style={{ transform: waMsgSettings[key] ? 'translateX(18px)' : 'translateX(2px)' }} />
                    </button>
                    <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{label}</span>
                  </label>
                ))}
              </div>
              {/* Live Preview */}
              <div className={`rounded-xl p-4 border ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-emerald-50 border-emerald-200'}`}>
                <p className={`text-[10px] font-bold tracking-widest uppercase mb-2 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Preview</p>
                <pre className={`text-xs whitespace-pre-wrap font-mono leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {buildExpiryAlertText({ holder_name: 'John Doe', expiry_date: new Date(Date.now() + 5 * 86400000).toISOString(), dsc_type: 'Class 3', associated_with: 'Sample Firm Pvt Ltd', serial_number: 'ABC12345' }, waMsgSettings)}
                </pre>
              </div>
            </div>
            <div className={`px-6 pb-6 flex gap-3 border-t pt-4 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
              <button onClick={() => { setWaMsgSettings(DEFAULT_WA_SETTINGS); }}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold border ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                Reset to Default
              </button>
              <button onClick={() => {
                  localStorage.setItem('dsc_wa_msg_settings', JSON.stringify(waMsgSettings));
                  setWaMsgSettingsOpen(false);
                  toast.success('WhatsApp message template saved');
                }}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#4f46e5,#6366f1)' }}>
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── WhatsApp Send Dialog for DSC Alerts (replaces old phone entry dialog) ── */}
      {waAlertDsc && (
        <WhatsAppSendDialog
          open={waAlertDialogOpen}
          onClose={() => { setWaAlertDialogOpen(false); setTimeout(() => setWaAlertDsc(null), 300); }}
          phone={waAlertDsc.mobile || ''}
          entityName={waAlertDsc.holder_name}
          message={buildExpiryAlertText(waAlertDsc, waMsgSettings)}
          title="Send DSC Expiry Alert"
          subtitle={waAlertDsc.associated_with ? `for ${waAlertDsc.associated_with}` : 'DSC expiry notification'}
          isDark={isDark}
          onPhoneSaved={(phone) => {
            // Save phone back to the DSC record
            api.put(`/dsc/${waAlertDsc.id}`, { mobile: phone }).catch(() => {});
          }}
        />
      )}

      {/* ── Legacy WhatsApp Phone Entry Dialog (kept for automation bulk flow) ── */}
      {waPhoneDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: 'rgba(6,78,59,0.55)', backdropFilter: 'blur(4px)' }}>
          <div className={`rounded-2xl shadow-2xl w-full max-w-sm p-6 ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#25d36620' }}>
                <MessageCircle className="h-5 w-5" style={{ color: '#25d366' }} />
              </div>
              <div>
                <h3 className={`font-bold text-base ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Send WhatsApp Alert</h3>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{waPhoneDialog.holder_name}</p>
              </div>
            </div>
            <p className={`text-sm mb-3 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              Enter the mobile number of <strong>{waPhoneDialog.holder_name}</strong> to send DSC expiry alert:
            </p>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-sm font-semibold px-3 py-2 rounded-lg border ${isDark ? 'bg-slate-800 border-slate-600 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>+91</span>
              <input
                className={`flex-1 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'}`}
                placeholder="10-digit mobile number"
                type="tel"
                maxLength={15}
                value={waPhoneNumber}
                onChange={e => setWaPhoneNumber(e.target.value.replace(/[^0-9+\s-]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter' && waPhoneNumber.length >= 8) handleWhatsAppSendWithPhone(); }}
                autoFocus
              />
            </div>
            <p className={`text-[11px] mb-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>💡 Tip: Save the mobile number in the DSC record (Mobile Number field) to skip this step next time and enable one-click WhatsApp alerts.</p>
            <div className="flex gap-2">
              <button onClick={() => setWaPhoneDialog(null)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                Cancel
              </button>
              <button onClick={handleWhatsAppSendWithPhone}
                disabled={waPhoneNumber.length < 8}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-opacity"
                style={{ background: waPhoneNumber.length < 8 ? '#9ca3af' : 'linear-gradient(135deg,#25d366,#128c7e)', cursor: waPhoneNumber.length < 8 ? 'not-allowed' : 'pointer' }}>
                <Send className="h-4 w-4" />Send Alert
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── WhatsApp Automation Dialog ── */}
      {whatsappAutoOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: 'rgba(6,78,59,0.55)', backdropFilter: 'blur(4px)' }}>
          <div className={`rounded-2xl shadow-2xl w-full max-w-md ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            {/* Header */}
            <div className="px-6 pt-6 pb-4 flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#25d36620,#128c7e20)' }}>
                <Zap className="h-5 w-5" style={{ color: '#25d366' }} />
              </div>
              <div className="flex-1">
                <h3 className={`font-bold text-lg ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>WhatsApp Alerts & Automation</h3>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Configure expiry notifications for DSC holders</p>
              </div>
              <button onClick={() => setWhatsappAutoOpen(false)} className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>✕</button>
            </div>
            {/* Message Template shortcut */}
            <div className={`mx-6 mt-2 mb-0 rounded-xl p-3 border flex items-center gap-3 cursor-pointer transition-all hover:opacity-80 ${isDark ? 'bg-indigo-900/20 border-indigo-800/40' : 'bg-indigo-50 border-indigo-100'}`}
              onClick={() => { setWhatsappAutoOpen(false); setWaMsgSettingsOpen(true); }}>
              <Settings2 className="h-4 w-4 text-indigo-500 flex-shrink-0" />
              <div className="flex-1">
                <p className={`text-xs font-semibold ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>Customise Message Template</p>
                <p className={`text-[11px] ${isDark ? 'text-indigo-400/70' : 'text-indigo-500/70'}`}>Edit sender name, greeting, footer text & more</p>
              </div>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${isDark ? 'bg-indigo-800/60 text-indigo-300' : 'bg-indigo-100 text-indigo-600'}`}>Settings →</span>
            </div>

            <div className="px-6 pb-6 space-y-5 mt-4">
              {/* Automation toggle */}
              <div className={`rounded-xl p-4 border ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    {autoEnabled ? <Bell className="h-4 w-4 text-emerald-500" /> : <BellOff className="h-4 w-4 text-slate-400" />}
                    <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Automated Alerts</span>
                  </div>
                  <button
                    onClick={() => saveAutoSettings(autoSettings, !autoEnabled)}
                    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0"
                    style={{ background: autoEnabled ? '#10b981' : (isDark ? '#334155' : '#d1d5db') }}>
                    <span className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                      style={{ transform: autoEnabled ? 'translateX(22px)' : 'translateX(2px)' }} />
                  </button>
                </div>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {autoEnabled ? '✅ Automation is ON — click "Run Now" to send alerts manually, or set a browser reminder.' : 'Enable to configure automatic WhatsApp alerts for expiring DSCs.'}
                </p>
                {autoLastRun && <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Last run: {autoLastRun}</p>}
              </div>

              {/* Alert criteria */}
              <div>
                <p className={`text-xs font-semibold uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Alert Criteria</p>
                <div className="space-y-2">
                  {[7, 14, 30].map(d => (
                    <label key={d} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${autoSettings.days.includes(d) ? (isDark ? 'border-emerald-600 bg-emerald-900/20' : 'border-emerald-300 bg-emerald-50') : (isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300')}`}>
                      <input type="checkbox" className="sr-only"
                        checked={autoSettings.days.includes(d)}
                        onChange={() => {
                          const days = autoSettings.days.includes(d) ? autoSettings.days.filter(x => x !== d) : [...autoSettings.days, d];
                          saveAutoSettings({ ...autoSettings, days }, autoEnabled);
                        }} />
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${autoSettings.days.includes(d) ? 'bg-emerald-500 border-emerald-500' : (isDark ? 'border-slate-600' : 'border-slate-300')}`}>
                        {autoSettings.days.includes(d) && <CheckCircle2 className="h-3 w-3 text-white" />}
                      </div>
                      <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Alert when expiring within <strong>{d} days</strong></span>
                      <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-semibold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>
                        {dscList.filter(x => { const dl = Math.ceil((new Date(x.expiry_date) - new Date()) / 86400000); return dl >= 0 && dl <= d; }).length} DSC
                      </span>
                    </label>
                  ))}
                  <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${autoSettings.sendExpired ? (isDark ? 'border-red-700 bg-red-900/20' : 'border-red-200 bg-red-50') : (isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300')}`}>
                    <input type="checkbox" className="sr-only"
                      checked={autoSettings.sendExpired}
                      onChange={() => saveAutoSettings({ ...autoSettings, sendExpired: !autoSettings.sendExpired }, autoEnabled)} />
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${autoSettings.sendExpired ? 'bg-red-500 border-red-500' : (isDark ? 'border-slate-600' : 'border-slate-300')}`}>
                      {autoSettings.sendExpired && <CheckCircle2 className="h-3 w-3 text-white" />}
                    </div>
                    <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Also alert for <strong>already expired</strong> DSCs</span>
                    <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-semibold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>
                      {expiredDSC.length} DSC
                    </span>
                  </label>
                </div>
              </div>

              {/* Quick send section */}
              <div className={`rounded-xl p-4 border ${isDark ? 'bg-slate-800/40 border-slate-700' : 'bg-emerald-50/50 border-emerald-100'}`}>
                <p className={`text-xs font-semibold uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Quick Actions</p>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => {
                    expiring7DSC.forEach((dsc, i) => {
                      setTimeout(() => { window.open(`https://wa.me/?text=${encodeURIComponent(buildExpiryAlertText(dsc, autoSettings._msgSettings))}`, '_blank'); }, i * 700);
                    });
                    toast.success(`Opening WhatsApp for ${expiring7DSC.length} expiring holder(s)…`);
                    setWhatsappAutoOpen(false);
                  }}
                    disabled={expiring7DSC.length === 0}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg,#f97316,#ea580c)', color: '#fff' }}>
                    <Clock className="h-4 w-4" />
                    Alert Expiring 7 Days
                    <span className="text-[10px] opacity-80">({expiring7DSC.length} DSC)</span>
                  </button>
                  <button onClick={() => {
                    expiredDSC.forEach((dsc, i) => {
                      setTimeout(() => { window.open(`https://wa.me/?text=${encodeURIComponent(buildExpiryAlertText(dsc, autoSettings._msgSettings))}`, '_blank'); }, i * 700);
                    });
                    toast.success(`Opening WhatsApp for ${expiredDSC.length} expired holder(s)…`);
                    setWhatsappAutoOpen(false);
                  }}
                    disabled={expiredDSC.length === 0}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)', color: '#fff' }}>
                    <AlertCircle className="h-4 w-4" />
                    Alert Expired
                    <span className="text-[10px] opacity-80">({expiredDSC.length} DSC)</span>
                  </button>
                </div>
              </div>

              {/* Run automation button */}
              <button
                onClick={() => { handleRunAutomation(); setWhatsappAutoOpen(false); }}
                disabled={autoSending || (autoSettings.days.length === 0 && !autoSettings.sendExpired)}
                className="w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff', boxShadow: '0 4px 15px rgba(37,211,102,0.3)' }}>
                {autoSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {autoSending ? 'Sending…' : 'Run Automation Now'}
              </button>
              <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                💡 WhatsApp will open for each DSC holder matching the criteria above. Phone numbers are read from DSC notes.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── AI Duplicate Detection Dialog ── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={dscList}
        entityLabel="DSC"
        accentColor="#4f46e5"
        isDark={isDark}
        canDelete={canDeleteDSC}
        canEdit={canEditDSC}
        getTitle={(d) => d.holder_name || 'Unknown Holder'}
        getSubtitle={(d) => [d.pan ? `PAN: ${d.pan}` : null, d.email].filter(Boolean).join(' · ') || null}
        getMeta={(d) => [
          d.dsc_type  ? d.dsc_type.toUpperCase()  : null,
          d.dsc_class ? `Class ${d.dsc_class}`    : null,
          d.status    ? d.status.toUpperCase()    : null,
          d.expiry_date ? `Exp: ${format(new Date(d.expiry_date), 'MMM yyyy')}` : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Holder',     a: a.holder_name,   b: b.holder_name },
          { label: 'PAN',        a: a.pan,           b: b.pan },
          { label: 'Email',      a: a.email,         b: b.email },
          { label: 'Serial No.', a: a.serial_number, b: b.serial_number },
          { label: 'Type',       a: a.dsc_type,      b: b.dsc_type },
          { label: 'Class',      a: a.dsc_class,     b: b.dsc_class },
          { label: 'Status',     a: a.status,        b: b.status },
          { label: 'Expiry',     a: a.expiry_date ? format(new Date(a.expiry_date), 'MMM dd, yyyy') : '—', b: b.expiry_date ? format(new Date(b.expiry_date), 'MMM dd, yyyy') : '—' },
          { label: 'Associated', a: a.associated_with, b: b.associated_with },
        ]}
        onEdit={(d) => { handleEdit(d); setShowDupDialog(false); }}
        onDelete={async (d) => {
          if (!window.confirm(`Delete DSC for "${d.holder_name}"?`)) return;
          try {
            await api.delete(`/dsc/${d.id}`);
            setDscList((prev) => prev.filter((x) => x.id !== d.id));
            toast.success('DSC deleted');
          } catch { toast.error('Failed to delete DSC'); }
        }}
        onView={(d) => { setSelectedDSC(d); setLogDialogOpen(true); setShowDupDialog(false); }}
      />
    </div>
  );
}
