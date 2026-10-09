import Papa from 'papaparse/papaparse.js';
import { motion } from 'framer-motion';
import { useDark } from '@/hooks/useDark';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense } from 'react';import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import api from '@/lib/api';
import { lookupPincode } from '@/lib/pincode';
import {
  fetchPassvaultFillForClient,
  backfillPassvaultFromClient,
} from '@/lib/clientPassvaultSync';
import { toast } from 'sonner';
import { useLocation, useNavigate } from "react-router-dom";
import {
  Plus, Edit, Trash2, Mail, Cake, X,
  FileText, Calendar, Search, Users,
  Briefcase, BarChart3, Archive, MessageCircle, Trash,
  CheckCircle2, Building2, ChevronDown, ChevronUp,
  LayoutGrid, List, Phone, MapPin, User, FileCheck, Share2,
  Copy, ExternalLink, CheckSquare, Square, MinusSquare,
  Shield, Download, UserCheck, AlertCircle, Sparkles, Loader2,
  ArrowLeftRight, RefreshCw, FileSpreadsheet, ExternalLink as ExternalLinkIcon,
  IndianRupee, Save as SaveIcon, Globe, Settings, Clock, Send, Repeat, Link,
  Merge, Layers, Paperclip, Minimize2, CalendarClock,
} from 'lucide-react';
import { detectClientDuplicates, detectRelatedClients } from '@/lib/aiDuplicateEngine';
import StandaloneGovtFeeDialog from '@/components/StandaloneGovtFeeDialog';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';
import MergeClientsDialog from '@/components/ui/MergeClientsDialog';
import ClientGroupsPanel from '@/components/ClientGroupsPanel';
import ClientRenewalsTab from '@/components/ClientRenewalsTab';
import { useBulkWASender } from '@/components/BulkWASenderContext';
import ClientPortalManager from '@/components/ClientPortalManager';
import ITRClientDialog from '@/components/ITRClientDialog';
// Lazy-loaded: ITRBulkImportDialog statically imports the ~430KB `xlsx` library
// for parsing bulk-upload spreadsheets. It's only needed when the user opens
// the "Bulk Import" dialog, so loading it eagerly here would force every
// visitor to the Clients page to download xlsx up front.
const ITRBulkImportDialog = React.lazy(() => import('@/components/ITRBulkImportDialog'));
import ClientWAAutoSend from '@/components/ClientWAAutoSend';
import DSCLinkerSection from '@/components/DSCLinkerSection';
import { useFormMinimizer } from '@/contexts/MinimizedFormsContext';
import { format, startOfDay, differenceInDays } from 'date-fns';
import WhatsAppSendDialog from '@/components/ui/WhatsAppSendDialog';
import { buildClientMessage, getWASettings } from '@/hooks/useWhatsApp';
import { getXLSX, getJsPDF, getAutoTable } from '@/lib/lazyLibs';
import { saveAs } from 'file-saver';

const CLIENT_TASK_DEPARTMENTS = [
  { value: 'gst',          label: 'GST' },
  { value: 'income_tax',   label: 'INCOME TAX' },
  { value: 'accounts',     label: 'ACCOUNTS' },
  { value: 'tds',          label: 'TDS' },
  { value: 'roc',          label: 'ROC' },
  { value: 'trademark',    label: 'TRADEMARK' },
  { value: 'msme_smadhan', label: 'MSME SMADHAN' },
  { value: 'fema',         label: 'FEMA' },
  { value: 'dsc',          label: 'DSC' },
  { value: 'other',        label: 'OTHER' },
];
const CLIENT_TASK_RECURRENCE = [
  { value: 'daily',   label: 'Daily' },
  { value: 'weekly',  label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly',  label: 'Yearly' },
];

const FixedSizeList = ({ children, height, itemCount, itemSize, width, itemData }) =>
  React.createElement(
    "div",
    { style: { height, width, overflow: "auto" } },
    Array.from({ length: itemCount || 0 }, (_, i) => {
      if (!children) return null;

      const result = children({ index: i, style: { height: itemSize }, data: itemData });

      if (result === undefined || result === null) return null;

      return result;
    })
  );


// ─── Constants ────────────────────────────────────────────────────────────────
const CLIENT_TYPES = [
  { value: 'proprietor', label: 'Proprietor' },
  { value: 'pvt_ltd', label: 'Private Limited' },
  { value: 'llp', label: 'LLP' },
  { value: 'public_ltd', label: 'Public Limited' },
  { value: 'section_8', label: 'Section 8 Company' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'huf', label: 'HUF' },
  { value: 'trust', label: 'Trust' },
  { value: 'other', label: 'Other' },
];

// Normalize constitution values from legacy/imported records so filters and counts
// remain correct even when older data contains LLP / LLPIN-style variants.
const normalizeClientType = (value) => {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    llp: 'llp',
    limited_liability_partnership: 'llp',
    limited_liability_partnership_llp: 'llp',
    private_limited: 'pvt_ltd',
    private_limited_company: 'pvt_ltd',
    private_company: 'pvt_ltd',
    public_limited: 'public_ltd',
    public_limited_company: 'public_ltd',
    section8: 'section_8',
    section_8_company: 'section_8',
    one_person_company: 'other',
  };
  return aliases[raw] || raw || 'proprietor';
};

const SERVICES = [
  'GST', 'Trademark', 'Income Tax', 'ROC', 'Audit', 'Compliance',
  'Company Registration', 'Tax Planning', 'Accounting', 'Payroll', 'Other'
];

const TYPE_CONFIG = {
  pvt_ltd:     { label: 'Pvt Ltd',        bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE', dot: '#2563EB', strip: '#2563EB' },
  llp:         { label: 'LLP',             bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE', dot: '#7C3AED', strip: '#7C3AED' },
  public_ltd:  { label: 'Public Ltd',      bg: '#ECFDF5', text: '#065F46', border: '#A7F3D0', dot: '#059669', strip: '#059669' },
  section_8:   { label: 'Section 8',       bg: '#FFF7ED', text: '#9A3412', border: '#FED7AA', dot: '#EA580C', strip: '#EA580C' },
  partnership: { label: 'Partnership',     bg: '#FFFBEB', text: '#B45309', border: '#FDE68A', dot: '#D97706', strip: '#D97706' },
  huf:         { label: 'HUF',             bg: '#F0FDFA', text: '#0F766E', border: '#99F6E4', dot: '#0D9488', strip: '#0D9488' },
  trust:       { label: 'Trust',           bg: '#FFF1F2', text: '#BE123C', border: '#FECDD3', dot: '#E11D48', strip: '#E11D48' },
  proprietor:  { label: 'Proprietor',      bg: '#F8FAFC', text: '#475569', border: '#CBD5E1', dot: '#64748B', strip: '#64748B' },
  other:       { label: 'Other',           bg: '#F0F9FF', text: '#0369A1', border: '#BAE6FD', dot: '#0284C7', strip: '#0284C7' },
};

const AVATAR_GRADIENTS = [
  ['#0D3B66', '#1F6FB2'], ['#065f46', '#059669'], ['#7c2d12', '#ea580c'],
  ['#4c1d95', '#7c3aed'], ['#1e3a5f', '#2563eb'], ['#831843', '#db2777'],
  ['#134e4a', '#0d9488'], ['#1e1b4b', '#4f46e5'],
];
const springPhysics = {
  card: { type: 'spring', stiffness: 280, damping: 22, mass: 0.85 },
};
 
const cardVariants = {
  hidden:  { opacity: 0, y: 18, scale: 0.98 },
  visible: { opacity: 1, y: 0,  scale: 1, transition: { type: 'spring', stiffness: 380, damping: 28 } },
};
const SORT_OPTIONS = [
  { value: 'fifo', label: 'Oldest First', icon: '↑', hint: 'FIFO' },
  { value: 'lifo', label: 'Newest First', icon: '↓', hint: 'LIFO' },
  { value: 'az',   label: 'A → Z',        icon: 'A', hint: 'A–Z'  },
  { value: 'za',   label: 'Z → A',        icon: 'Z', hint: 'Z–A'  },
];

const EMPTY_ASSIGNMENT = { user_id: '', services: [] };
const BOARD_PAGE_SIZE = 24;
const LIST_PAGE_SIZE  = 50;
const LIST_ROW_HEIGHT = 56;
const MAX_VISIBLE_ROWS = 15;
const SEARCH_DEBOUNCE_MS = 250;
const UNDO_DELAY_MS = 4000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getAvatarGradient = (name = '') => {
  const idx = (name.charCodeAt(0) || 0) % AVATAR_GRADIENTS.length;
  return `linear-gradient(135deg, ${AVATAR_GRADIENTS[idx][0]}, ${AVATAR_GRADIENTS[idx][1]})`;
};

const safeDate = (dateStr) => {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  if (!trimmed || ['None','null','undefined'].includes(trimmed)) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() < 1900 || d.getFullYear() > 2100) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const trimmedEmail = (v) => { const t = v?.trim(); return t && t.length > 0 ? t : null; };

// MCA/company-master sources do not always use the same field names.
// Keep the frontend contract canonical so CIN, registered address, city,
// state and PIN always land in the correct Client form fields.
const normalizeMcaDetails = (raw = {}) => {
  const first = (...keys) => {
    for (const key of keys) {
      const value = raw?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '' && String(value).trim() !== '-' && String(value).trim().toLowerCase() !== 'nan') {
        return String(value).trim();
      }
    }
    return '';
  };

  const address = first('address', 'registered_address', 'registered_office_address', 'registered_office', 'registeredAddress');
  let pin = first('pin', 'pincode', 'postal_code', 'postalCode', 'zip', 'zip_code', 'registered_pin', 'registered_pincode', 'gst_pin');
  if (!pin && address) {
    const match = address.match(/\b(\d{6})\b/);
    if (match) pin = match[1];
  }

  return {
    company_name: first('company_name', 'name', 'legal_name', 'companyName'),
    cin: first('cin', 'cin_number', 'corporate_identity_number', 'corporate_identification_number'),
    llpin: first('llpin', 'llpin_number', 'llp_identification_number'),
    date_of_incorporation: first('date_of_incorporation', 'incorporation_date', 'date_of_registration'),
    address,
    city: first('city', 'registered_city', 'registeredCity'),
    state: first('state', 'registered_state', 'registeredState', 'registration_state'),
    pin,
    email: first('email', 'email_id', 'emailId'),
    pan: first('pan', 'pan_number', 'panNumber'),
    client_type: first('client_type', 'entity_type', 'constitution'),
    registration_number: first('registration_number', 'registration_no', 'registrationNumber'),
    roc_name: first('roc_name', 'roc', 'registrar_of_companies'),
    rd_name: first('rd_name', 'rd', 'rd_region'),
    company_category: first('company_category', 'category', 'company_class', 'class_of_company'),
    company_subcategory: first('company_subcategory', 'subcategory', 'company_sub_category'),
    active_compliance: first('active_compliance', 'active_compliance_status'),
    authorized_capital: first('authorized_capital', 'authorised_capital', 'authorized_share_capital'),
    paid_up_capital: first('paid_up_capital', 'paidup_capital', 'paid_up_share_capital'),
    last_agm_date: first('last_agm_date', 'date_of_last_agm', 'agm_date'),
    balance_sheet_date: first('balance_sheet_date', 'date_of_balance_sheet', 'last_balance_sheet_date'),
    books_address: first('books_address', 'books_of_account_address', 'address_at_which_books_of_account_are_maintained'),
    company_status: first('company_status', 'status', 'companyStatus'),
    charges: Array.isArray(raw?.charges) ? raw.charges : [],
    loan_details: Array.isArray(raw?.loan_details) ? raw.loan_details : [],
    directors: Array.isArray(raw?.directors) ? raw.directors : [],
    mca_fetch_date: first('mca_fetch_date') || new Date().toISOString().slice(0, 10),
  };
};



// ─── copyToClipboard helper ───────────────────────────────────────────────────
const copyToClipboard = async (text, label = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error('Could not copy — please copy manually');
  }
};

// ─── DSC days-remaining helper ────────────────────────────────────────────────
const getDscDaysLeft = (expiryDate) => {
  if (!expiryDate) return null;
  try {
    return differenceInDays(new Date(expiryDate), new Date());
  } catch { return null; }
};

const DscBadge = ({ daysLeft }) => {
  if (daysLeft === null) return null;
  const color = daysLeft < 0 ? { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA', label: 'Expired' }
    : daysLeft <= 30  ? { bg: '#FFF7ED', text: '#EA580C', border: '#FED7AA', label: `${daysLeft}d left` }
    : daysLeft <= 90  ? { bg: '#FEFCE8', text: '#CA8A04', border: '#FDE68A', label: `${daysLeft}d left` }
    : null;
  if (!color) return null;
  return (
    <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 20, background: color.bg, color: color.text, border: `1px solid ${color.border}`, whiteSpace: 'nowrap' }}>
      DSC {color.label}
    </span>
  );
};

// ─── Skeleton card ────────────────────────────────────────────────────────────
const SkeletonCard = ({ isDark }) => (
  <div style={{ borderRadius: 16, background: isDark ? '#1e293b' : '#ffffff', border: `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'}`, padding: '14px 14px 12px 18px', overflow: 'hidden', position: 'relative' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: '16px 0 0 16px', background: isDark ? '#334155' : '#e2e8f0' }} />
    <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: isDark ? '#334155' : '#e2e8f0' }} className="animate-pulse" />
      <div style={{ flex: 1 }}>
        <div style={{ height: 10, borderRadius: 6, background: isDark ? '#334155' : '#e2e8f0', width: '60%', marginBottom: 6 }} className="animate-pulse" />
        <div style={{ height: 12, borderRadius: 6, background: isDark ? '#334155' : '#e2e8f0', width: '80%' }} className="animate-pulse" />
      </div>
    </div>
    {[70, 90, 60, 75].map((w, i) => (
      <div key={i} style={{ height: 10, borderRadius: 6, background: isDark ? '#334155' : '#e2e8f0', width: `${w}%`, marginBottom: 8 }} className="animate-pulse" />
    ))}
  </div>
);

// ─── SectionHeading ───────────────────────────────────────────────────────────
const SectionHeading = ({ icon, title, subtitle, isDark }) => (
  <div className="flex items-center gap-3 mb-6">
    <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold shadow-sm" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
      {icon}
    </div>
    <div>
      <h3 className={`text-base font-semibold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{title}</h3>
      {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  </div>
);

// ─── TypePill ─────────────────────────────────────────────────────────────────
const TypePill = ({ type, customLabel }) => {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.proprietor;
  const label = type === 'other' && customLabel ? customLabel : cfg.label;
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full border tracking-wide whitespace-nowrap flex-shrink-0"
      style={{ background: cfg.bg, color: cfg.text, borderColor: cfg.border }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cfg.dot }} />
      {label}
    </span>
  );
};

// ─── ActiveFilterChips ────────────────────────────────────────────────────────
const ActiveFilterChips = ({ statusFilter, clientTypeFilter, serviceFilter, assignedToFilter, referredByFilter, auditorFilter, users, onClear, onClearAll }) => {
  const chips = [];
  if (statusFilter !== 'all') chips.push({ key: 'status', label: statusFilter === 'active' ? 'Active' : 'Archived', onRemove: () => onClear('status') });
  if (clientTypeFilter !== 'all') { const t = CLIENT_TYPES.find(x => x.value === clientTypeFilter); chips.push({ key: 'type', label: t?.label || clientTypeFilter, onRemove: () => onClear('clientType') }); }
  if (serviceFilter !== 'all') chips.push({ key: 'service', label: serviceFilter, onRemove: () => onClear('service') });
  if (assignedToFilter !== 'all') { const u = users.find(x => x.id === assignedToFilter); chips.push({ key: 'assigned', label: u?.full_name || u?.name || 'User', onRemove: () => onClear('assigned') }); }
  if (referredByFilter !== 'all') chips.push({ key: 'referredBy', label: `Referred: ${referredByFilter}`, onRemove: () => onClear('referredBy') });
  if (auditorFilter !== 'all') chips.push({ key: 'auditor', label: `Auditor: ${auditorFilter}`, onRemove: () => onClear('auditor') });
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Filters:</span>
      {chips.map(chip => (
        <span key={chip.key} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border"
          style={{ background: '#EFF6FF', color: '#1D4ED8', borderColor: '#BFDBFE' }}>
          {chip.label}
          <button onClick={chip.onRemove} className="ml-0.5 hover:opacity-70 transition-opacity">
            <X style={{ width: 10, height: 10 }} />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button onClick={onClearAll} className="text-[11px] font-semibold text-slate-400 hover:text-red-500 transition-colors px-1">
          Clear all
        </button>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// BULK MESSAGE MODAL — Enhanced with Direct Send, Personalization & Scheduling
// ═══════════════════════════════════════════════════════════════════════════
const SEND_MODES = { DIRECT: 'direct', WHATSAPP_WEB: 'web', EXPORT: 'export', SCHEDULE: 'schedule' };

const BulkMessageModal = React.memo(({ open, onClose, mode, filteredClients, isDark }) => {
  const [message, setMessage] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [clientSearch, setClientSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [clientScope, setClientScope] = useState('active'); // 'active' | 'all'
  const [waServiceFilter, setWaServiceFilter] = useState('all'); // service filter inside WA popup
  const [waClientTypeFilter, setWaClientTypeFilter] = useState('all'); // client-type filter inside WA/Email popup
  // Direct send & scheduling state
  const [sendMode, setSendMode] = useState(SEND_MODES.DIRECT); // direct | web | export | schedule
  const [waConnected, setWaConnected] = useState(null); // null=loading, true, false
  const [waSessions, setWaSessions] = useState([]); // connected WA sessions
  const [waSelectedSession, setWaSelectedSession] = useState(null); // chosen session ID
  const [sendingBulk, setSendingBulk] = useState(false);
  const [sendProgress, setSendProgress] = useState(null); // { done, total, results }
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduledJobs, setScheduledJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  // Pause/delay between bulk sends
  const [pauseEnabled, setPauseEnabled] = useState(false);
  const [pauseAfterCount, setPauseAfterCount] = useState(5);   // pause every N messages
  const [pauseDurationSec, setPauseDurationSec] = useState(60); // pause for N seconds
  const [pauseCountdown, setPauseCountdown] = useState(null);   // null | number (remaining secs)
  const pauseRef = React.useRef(false); // abort flag
  // Media attachment state
  const [mediaFile, setMediaFile] = useState(null);      // { file, name, mimeType, base64, previewUrl }
  const mediaInputRef = React.useRef(null);
  const [showVariables, setShowVariables] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  // Saved email templates (from Settings → Email Templates) — linked into bulk email
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [subjectLine, setSubjectLine] = useState('');
  // Sender selector state (email mode only)
  const [activeSender, setActiveSender]   = useState(null);   // { email, name } from DB
  const [senderList,   setSenderList]     = useState([]);      // all saved senders
  const [senderLoading, setSenderLoading] = useState(false);
  const [showSenderPicker, setShowSenderPicker] = useState(false);
  // WhatsApp history state
  const [showHistory, setShowHistory] = useState(false);
  const [historyLogs, setHistoryLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all'); // all | sent | failed
  const [batchName, setBatchName] = useState('');
  const { startBatch, state: bulkState } = useBulkWASender();
  const [selectedBatchId, setSelectedBatchId] = useState(null); // history batch drill-down

  const activeClients = useMemo(() => filteredClients.filter(c => (c?.status || 'active') !== 'inactive'), [filteredClients]);
  const archivedCount = filteredClients.length - activeClients.length;

  useEffect(() => {
    if (open) {
      setClientScope('active');
      setWaServiceFilter('all');
      setWaClientTypeFilter('all');
      setSelectedIds(new Set(activeClients.map(c => c.id)));
      setMessage(''); setClientSearch(''); setCopied(false); setExportDone(false); setSelectedTemplate(''); setBatchName(''); setSelectedBatchId(null);
      setSendProgress(null); setSendingBulk(false);
      setMediaFile(null); setSubjectLine('');
      // Fetch active sender info for email mode (use authenticated api instance)
      setSenderLoading(true);
      Promise.all([
        api.get('/email/senders/active').then(r => r.data).catch(() => null),
        api.get('/email/senders/list').then(r => r.data).catch(() => null),
      ]).then(([activeRes, listRes]) => {
        if (activeRes?.active_email) setActiveSender({ email: activeRes.active_email, name: activeRes.active_name || '' });
        if (listRes?.senders)        setSenderList(listRes.senders);
      }).finally(() => setSenderLoading(false));
      // Load saved email templates (shared with Settings → Email Templates) for email mode
      if (mode !== 'whatsapp') {
        api.get('/email/client-templates').then(r => setEmailTemplates(r.data || [])).catch(() => setEmailTemplates([]));
      }
      // Set default schedule to tomorrow 09:00
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      setScheduleDate(tomorrow.toISOString().split('T')[0]);
      setScheduleTime('09:00');
      if (mode === 'whatsapp') {
        // Check if WA bridge is connected and fetch sessions
        api.get('/whatsapp/sessions')
          .then(r => {
            const connected = (r.data?.sessions || []).filter(s => s.status === 'connected');
            setWaConnected(connected.length > 0);
            setWaSessions(connected);
            if (connected.length === 1) setWaSelectedSession(connected[0].sessionId);
          })
          .catch(() => { setWaConnected(false); setWaSessions([]); });
        // Load existing scheduled jobs
        loadScheduledJobs();
      }
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadScheduledJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const r = await api.get('/whatsapp/scheduled-bulk');
      setScheduledJobs(r.data?.jobs || []);
    } catch { setScheduledJobs([]); }
    finally { setLoadingJobs(false); }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await api.get('/whatsapp/history', { params: { limit: 200, message_type: 'bulk_client' } });
      setHistoryLogs(r.data?.messages || r.data || []);
    } catch {
      // fallback: try generic messages endpoint
      try {
        const r2 = await api.get('/whatsapp/messages', { params: { limit: 200 } });
        setHistoryLogs(r2.data?.messages || r2.data || []);
      } catch { setHistoryLogs([]); }
    } finally { setHistoryLoading(false); }
  }, []);

  const filteredHistory = useMemo(() => {
    let logs = historyLogs;
    if (selectedBatchId) logs = logs.filter(l => (l.batch_id || '') === selectedBatchId);
    if (historyFilter === 'sent') logs = logs.filter(l => l.status === 'sent' || l.status === 'delivered' || l.status === 'read');
    if (historyFilter === 'failed') logs = logs.filter(l => l.status === 'failed' || l.status === 'error');
    if (historySearch.trim()) {
      const q = historySearch.toLowerCase();
      logs = logs.filter(l =>
        (l.to || l.phone || '').includes(q) ||
        (l.client_name || l.name || '').toLowerCase().includes(q) ||
        (l.message || l.body || '').toLowerCase().includes(q) ||
        (l.batch_name || '').toLowerCase().includes(q)
      );
    }
    return logs;
  }, [historyLogs, historyFilter, historySearch, selectedBatchId]);

  // Group history messages into batches (only entries that carry batch_id)
  const historyBatches = useMemo(() => {
    const map = new Map();
    for (const l of historyLogs) {
      const bid = l.batch_id;
      if (!bid) continue;
      let b = map.get(bid);
      if (!b) {
        b = { batch_id: bid, batch_name: l.batch_name || bid, total: 0, sent: 0, failed: 0, first_at: l.sent_at || l.created_at, last_at: l.sent_at || l.created_at };
        map.set(bid, b);
      }
      b.total += 1;
      if (['sent','delivered','read'].includes(l.status)) b.sent += 1;
      if (['failed','error'].includes(l.status)) b.failed += 1;
      const t = l.sent_at || l.created_at;
      if (t && (!b.last_at || t > b.last_at)) b.last_at = t;
      if (t && (!b.first_at || t < b.first_at)) b.first_at = t;
      if (l.batch_name && !b.batch_name) b.batch_name = l.batch_name;
    }
    return Array.from(map.values()).sort((a, b) => (b.last_at || '').localeCompare(a.last_at || ''));
  }, [historyLogs]);

  // Always show ALL clients — archived ones appear dimmed/unchecked in Active mode
  const displayedClients = useMemo(() => {
    let base = filteredClients;
    // Apply service filter
    if (waServiceFilter !== 'all') {
      base = base.filter(c => (c?.services ?? []).some(s => (s || '').toLowerCase().includes(waServiceFilter.toLowerCase())));
    }
    // Apply client-type filter
    if (waClientTypeFilter !== 'all') {
      base = base.filter(c => (c?.client_type || 'proprietor') === waClientTypeFilter);
    }
    if (!clientSearch.trim()) return base;
    const q = clientSearch.toLowerCase();
    return base.filter(c =>
      (c?.company_name || '').toLowerCase().includes(q) ||
      (c?.phone || '').includes(q) ||
      (c?.email || '').toLowerCase().includes(q) ||
      (c?.gstin || '').toLowerCase().includes(q)
    );
  }, [filteredClients, clientSearch, waServiceFilter, waClientTypeFilter]);

  const selectedClients = useMemo(() => filteredClients.filter(c => selectedIds.has(c.id)), [filteredClients, selectedIds]);

  const toggleClient = useCallback((id, isArchived) => {
    // In Active Clients mode, archived clients cannot be selected
    if (clientScope === 'active' && isArchived) return;
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, [clientScope]);

  const handleScopeChange = useCallback((scope) => {
    setClientScope(scope);
    const base = scope === 'active' ? activeClients : filteredClients;
    setSelectedIds(new Set(base.map(c => c.id)));
  }, [activeClients, filteredClients]);

  const selectAllVisible = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      displayedClients.forEach(client => {
        const isLocked = clientScope === 'active' && client.status === 'inactive';
        if (!isLocked) next.add(client.id);
      });
      return next;
    });
  }, [displayedClients, clientScope]);

  const unselectAll = useCallback(() => setSelectedIds(new Set()), []);

  const someSelected = selectedIds.size > 0;
  const phoneCount = selectedClients.filter(c => c.phone).length;
  const emailCount = selectedClients.filter(c => c.email).length;
  const isWhatsApp = mode === 'whatsapp';
  const accentColor = isWhatsApp ? '#25D366' : '#1F6FB2';
  const accentGrad  = isWhatsApp ? 'linear-gradient(135deg, #128C7E, #25D366)' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)';
  const relevantCount = isWhatsApp ? phoneCount : emailCount;

  // Personalize message for a specific client
  const personalizeMessage = useCallback((rawMsg, client) => {
    return rawMsg
      .replace(/\{name\}/gi, client.company_name || 'Valued Client')
      .replace(/\{phone\}/gi, client.phone || '')
      .replace(/\{email\}/gi, client.email || '')
      .replace(/\{city\}/gi, client.city || '')
      .replace(/\{gstin\}/gi, client.gstin || '')
      .replace(/\{services\}/gi, (client.services || []).join(', ') || '');
  }, []);

  // Handle media file selection
  const handleMediaSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const maxSize = 16 * 1024 * 1024;
    if (file.size > maxSize) { toast.error('File too large — max 16 MB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result.split(',')[1];
      const previewUrl = file.type.startsWith('image/') ? ev.target.result : null;
      setMediaFile({ file, name: file.name, mimeType: file.type, base64, previewUrl, size: file.size });
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, []);

  // Direct send via WA bridge
  // Hands the job off to the global BulkWASenderProvider, so the batch keeps
  // sending in the background even if this modal is closed or the user
  // navigates to another page. A floating widget (bottom-right) shows progress.
  const handleDirectSend = useCallback(async () => {
    if (!message.trim() && !mediaFile) { toast.error('Please write a message or attach a file'); return; }
    if (bulkState?.active) { toast.error('Another WhatsApp batch is already running. Wait for it to finish or cancel it from the widget.'); return; }
    const toSend = selectedClients.filter(c => c.phone);
    if (toSend.length === 0) { toast.error('No selected clients have a phone number'); return; }
    if (!batchName.trim()) { toast.error('Please give this batch a name (e.g. "Income Tax Reminder") so you can find it later in History.'); return; }

    const recipients = toSend.map(client => ({
      id: client.id,
      name: client.company_name,
      phone: client.phone,
      message: personalizeMessage(message, client),
      media: mediaFile ? { base64: mediaFile.base64, mimeType: mediaFile.mimeType, name: mediaFile.name } : null,
    }));

    // Fire-and-forget: the provider runs the loop independently of this modal.
    startBatch({
      batchName: batchName.trim(),
      recipients,
      sessionId: waSelectedSession || null,
      pauseEnabled,
      pauseAfterCount,
      pauseDurationSec,
      messageType: 'bulk_client',
    });

    // Close the modal so the user can keep working — the widget takes over.
    onClose?.();
  }, [message, mediaFile, selectedClients, personalizeMessage, waSelectedSession, pauseEnabled, pauseAfterCount, pauseDurationSec, batchName, startBatch, bulkState, onClose]);

  // Schedule bulk send
  const handleScheduleSend = useCallback(async () => {
    if (!message.trim()) { toast.error('Please write a message first'); return; }
    if (!scheduleDate) { toast.error('Please select a date'); return; }
    const toSend = selectedClients.filter(c => c.phone);
    if (toSend.length === 0) { toast.error('No selected clients have a phone number'); return; }
    try {
      const scheduledAt = `${scheduleDate}T${scheduleTime}:00`;
      const recipients = toSend.map(c => ({
        phone: c.phone.replace(/\D/g, '').length === 10 ? `91${c.phone.replace(/\D/g, '')}` : c.phone.replace(/\D/g, ''),
        message: personalizeMessage(message, c),
        client_id: c.id,
        client_name: c.company_name,
      }));
      await api.post('/whatsapp/schedule-bulk', { recipients, scheduled_at: scheduledAt, message_template: message, message_type: 'bulk_scheduled' });
      toast.success(`Scheduled ${toSend.length} messages for ${scheduleDate} at ${scheduleTime}`);
      loadScheduledJobs();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to schedule messages');
    }
  }, [message, selectedClients, scheduleDate, scheduleTime, personalizeMessage, loadScheduledJobs]);

  const handleCancelJob = useCallback(async (jobId) => {
    try {
      await api.delete(`/whatsapp/scheduled-bulk/${jobId}`);
      toast.success('Scheduled job cancelled');
      loadScheduledJobs();
    } catch { toast.error('Failed to cancel job'); }
  }, [loadScheduledJobs]);

  const handleExportBroadcast = useCallback(() => {
    if (selectedClients.length === 0) { toast.error('Select at least one client first'); return; }
    const withPhone = selectedClients.filter(c => c.phone);
    if (withPhone.length === 0) { toast.error('No selected clients have a phone number'); return; }
    const rows = [
      ['Name', 'Phone', 'WhatsApp Number (91XXXXXXXXXX)', 'Message'],
      ...withPhone.map(c => {
        const phone = c.phone.replace(/\D/g, '');
        const wa = phone.length === 10 ? `91${phone}` : phone;
        const msg = message.trim() ? message.trim().replace(/\{name\}/gi, c.company_name) : '';
        return [c.company_name, c.phone, wa, msg];
      }),
    ];
    const csv = rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `whatsapp_broadcast_${format(new Date(), 'dd-MMM-yyyy')}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    const phoneList = withPhone.map(c => { const p = c.phone.replace(/\D/g, ''); return p.length === 10 ? `91${p}` : p; }).join('\n');
    navigator.clipboard.writeText(phoneList).catch(() => {});
    setExportDone(true);
    toast.success(`CSV downloaded + ${withPhone.length} numbers copied!`, { description: 'Open WhatsApp Business → New Broadcast → paste numbers' });
    setTimeout(() => setExportDone(false), 3000);
  }, [selectedClients, message]);

  const handleWhatsApp = useCallback(async () => {
    if (!message.trim()) { toast.error('Please write a message first'); return; }
    if (selectedClients.length === 0) { toast.error('Please select at least one client'); return; }
    try {
      await navigator.clipboard.writeText(message.trim());
      setCopied(true);
      toast.success('Message copied! Opening WhatsApp Web…');
      setTimeout(() => { window.open('https://web.whatsapp.com', '_blank'); setCopied(false); }, 800);
    } catch { toast.error('Could not copy to clipboard.'); }
  }, [message, selectedClients]);

  const handleEmail = useCallback(async () => {
    const emailClients = selectedClients.filter(c => c.email);
    if (emailClients.length === 0) { toast.error('No email addresses found for selected clients'); return; }
    if (!message.trim()) { toast.error('Please write a message first'); return; }
    const lines = message.trim().split('\n');
    const subj = (subjectLine.trim() || lines[0].substring(0, 120) || 'Message from TaskoSphere');
    setSendingBulk(true);
    setSendProgress({ done: 0, total: emailClients.length, results: [] });
    try {
      const recipients = emailClients.map(c => ({
        email: c.email, name: c.company_name || '',
        variables: { name: c.company_name || 'Valued Client', email: c.email || '', phone: c.phone || '', gstin: c.gstin || '', city: c.city || '', services: (c.services || []).join(', ') },
      }));
      const r = await api.post('/email/send-bulk-clients', {
        recipients, subject: subj, body_template: message.trim(), is_html: false, send_method: 'auto',
        override_sender_email: activeSender?.email || null, override_sender_name: activeSender?.name || null,
        attachment_name: mediaFile?.name || '', attachment_base64: mediaFile?.base64 || '',
      });
      setSendProgress({ done: r.data.sent, total: emailClients.length, results: r.data.failed_list || [] });
      toast.success(r.data.sent + ' email(s) sent' + (r.data.failed > 0 ? ', ' + r.data.failed + ' failed' : ''));
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Email send failed. Check Settings -> Email Accounts.');
      setSendProgress(null);
    } finally { setSendingBulk(false); }
  }, [message, subjectLine, mediaFile, selectedClients, emailCount, activeSender]);

  const WA_GREEN = '#25D366';
  const WA_DARK  = '#128C7E';
  const sendBtnEnabled = (message.trim() || mediaFile) && selectedClients.length > 0 && phoneCount > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0" style={{ background: isDark ? '#0f172a' : '#fff', borderColor: isDark ? '#1e3a5f' : '#e2e8f0' }}>
        <DialogTitle className="sr-only">{isWhatsApp ? 'Bulk WhatsApp' : 'Bulk Email'}</DialogTitle>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b" style={{ background: isWhatsApp ? 'linear-gradient(135deg, #064e3b, #065f46)' : 'linear-gradient(135deg, #1e3a5f, #1e40af)', borderColor: 'transparent' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }}>
              {isWhatsApp ? <MessageCircle className="h-5 w-5 text-white" /> : <Mail className="h-5 w-5 text-white" />}
            </div>
            <div className="flex-1">
              <h2 className="text-base font-bold text-white">{isWhatsApp ? 'Bulk WhatsApp — Direct Send' : 'Bulk Email'}</h2>
              <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>
                {isWhatsApp ? 'Send personalized messages directly · Schedule for later · Export for Broadcast' : 'Draft → opens in your mail client with all recipients in BCC'}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isWhatsApp && waConnected !== null && (
                <span className="text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5"
                  style={{ background: waConnected ? 'rgba(37,211,102,0.2)' : 'rgba(239,68,68,0.2)', color: waConnected ? '#4ade80' : '#f87171', border: `1px solid ${waConnected ? 'rgba(37,211,102,0.4)' : 'rgba(239,68,68,0.3)'}` }}>
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: waConnected ? '#4ade80' : '#f87171' }} />
                  {waConnected ? `WA Connected${waSessions.length > 1 ? ` (${waSessions.length})` : ''}` : 'WA Offline'}
                </span>
              )}
              {/* Multi-account selector — shown when >1 session connected */}
              {isWhatsApp && waSessions.length > 1 && (
                <select
                  value={waSelectedSession || ''}
                  onChange={e => setWaSelectedSession(e.target.value || null)}
                  style={{
                    fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.15)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', outline: 'none',
                  }}>
                  <option value="" style={{ background: '#0f172a' }}>Auto-pick account</option>
                  {waSessions.map(s => (
                    <option key={s.sessionId} value={s.sessionId} style={{ background: '#0f172a' }}>
                      {s.displayName || `+${s.phoneNumber}`}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                {relevantCount} {isWhatsApp ? 'with phone' : 'with email'}
              </span>
              {isWhatsApp && (
                <button
                  onClick={() => { setShowHistory(v => !v); if (!showHistory) loadHistory(); }}
                  className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full transition-all"
                  style={{
                    background: showHistory ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.12)',
                    color: showHistory ? '#fbbf24' : 'rgba(255,255,255,0.85)',
                    border: `1px solid ${showHistory ? 'rgba(251,191,36,0.5)' : 'rgba(255,255,255,0.2)'}`,
                  }}
                  title="View WhatsApp send history"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  History
                </button>
              )}
            </div>
          </div>
        </div>

        {/* WhatsApp History Panel */}
        {showHistory && isWhatsApp && (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ background: isDark ? '#0f172a' : '#fff' }}>
            {/* History header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b flex-shrink-0" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9', background: isDark ? '#0d1b2a' : '#f8fafc' }}>
              <div className="flex items-center gap-2 flex-1">
                <svg className="h-4 w-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span className="text-sm font-bold" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>WhatsApp Send History</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: isDark ? '#1e293b' : '#fef9c3', color: isDark ? '#fbbf24' : '#92400e' }}>{historyLogs.length} records</span>
              </div>
              {/* Filter tabs */}
              <div className="flex items-center gap-1">
                {[['all','All'],['sent','Delivered'],['failed','Failed']].map(([v,l]) => (
                  <button key={v} onClick={() => setHistoryFilter(v)}
                    className="text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all"
                    style={historyFilter === v
                      ? { background: v === 'failed' ? '#ef4444' : v === 'sent' ? '#22c55e' : '#3b82f6', color: '#fff' }
                      : { background: isDark ? '#1e293b' : '#f1f5f9', color: isDark ? '#94a3b8' : '#64748b' }}>
                    {l}
                  </button>
                ))}
              </div>
              {/* Search */}
              <div className="relative">
                <svg className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" /></svg>
                <input
                  value={historySearch} onChange={e => setHistorySearch(e.target.value)}
                  placeholder="Search name, phone…"
                  className="pl-7 pr-3 py-1.5 text-xs rounded-lg border outline-none w-44"
                  style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a' }}
                />
              </div>
              <button onClick={() => loadHistory()} title="Refresh" className="w-7 h-7 flex items-center justify-center rounded-lg transition-all hover:opacity-70" style={{ color: isDark ? '#94a3b8' : '#64748b' }}>
                <svg className={`h-4 w-4 ${historyLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </button>
            </div>

            {/* Batches strip — shown only when no batch is drilled into */}
            {!selectedBatchId && historyBatches.length > 0 && (
              <div className="px-5 py-2.5 border-b flex-shrink-0" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9', background: isDark ? '#0a1523' : '#fff' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? '#94a3b8' : '#64748b' }}>Batches</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: isDark ? '#1e293b' : '#e0f2fe', color: isDark ? '#7dd3fc' : '#0369a1' }}>{historyBatches.length}</span>
                  <span className="text-[10px]" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Click a batch to see the full data for that send.</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {historyBatches.slice(0, 20).map(b => (
                    <button
                      key={b.batch_id}
                      onClick={() => setSelectedBatchId(b.batch_id)}
                      className="text-left rounded-lg border px-3 py-2 hover:opacity-90 transition-all"
                      style={{ background: isDark ? '#0f172a' : '#f8fafc', borderColor: isDark ? '#1e3a5f' : '#e2e8f0', minWidth: 180 }}
                      title={b.batch_name}
                    >
                      <div className="text-[11px] font-bold truncate" style={{ color: isDark ? '#e2e8f0' : '#0f172a', maxWidth: 200 }}>🏷️ {b.batch_name}</div>
                      <div className="flex items-center gap-2 mt-1 text-[10px]">
                        <span style={{ color: isDark ? '#94a3b8' : '#64748b' }}>{b.total} msgs</span>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ {b.sent}</span>
                        {b.failed > 0 && <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ {b.failed}</span>}
                      </div>
                      <div className="text-[9px] mt-0.5" style={{ color: isDark ? '#475569' : '#94a3b8' }}>
                        {b.last_at ? new Date(b.last_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : ''}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Selected batch pill */}
            {selectedBatchId && (
              <div className="px-5 py-2 border-b flex-shrink-0 flex items-center gap-2" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9', background: isDark ? '#0a1523' : '#fff' }}>
                <span className="text-[11px] font-bold" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>
                  🏷️ Viewing batch: {(historyBatches.find(b => b.batch_id === selectedBatchId)?.batch_name) || selectedBatchId}
                </span>
                <button onClick={() => setSelectedBatchId(null)} className="ml-auto text-[10px] font-bold px-2 py-1 rounded-lg" style={{ background: isDark ? '#1e293b' : '#f1f5f9', color: isDark ? '#94a3b8' : '#64748b' }}>
                  ← All batches
                </button>
              </div>
            )}

            {/* History list */}
            <div className="flex-1 overflow-y-auto">
              {historyLoading ? (
                <div className="flex items-center justify-center py-16">
                  <svg className="h-6 w-6 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  <span className="ml-3 text-sm text-slate-400">Loading history…</span>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <svg className="h-10 w-10 text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  <p className="text-sm font-semibold text-slate-400">No history found</p>
                  <p className="text-xs text-slate-400 mt-1">WhatsApp messages sent from Taskosphere will appear here</p>
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr style={{ background: isDark ? '#0d1b2a' : '#f8fafc', borderBottom: `1px solid ${isDark ? '#1e3a5f' : '#f1f5f9'}` }}>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 w-48">Client / Phone</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Message Preview</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 w-32">Sent At</th>
                      <th className="text-center px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 w-28">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistory.map((log, i) => {
                      const status = log.status || 'unknown';
                      const isDelivered = ['sent','delivered','read'].includes(status);
                      const isFailed = ['failed','error'].includes(status);
                      const statusColor = isDelivered ? '#22c55e' : isFailed ? '#ef4444' : '#f59e0b';
                      const statusBg = isDelivered ? (isDark ? 'rgba(34,197,94,0.12)' : '#f0fdf4') : isFailed ? (isDark ? 'rgba(239,68,68,0.12)' : '#fef2f2') : (isDark ? 'rgba(245,158,11,0.12)' : '#fffbeb');
                      const statusLabel = status === 'read' ? '✓✓ Read' : status === 'delivered' ? '✓✓ Delivered' : status === 'sent' ? '✓ Sent' : status === 'failed' || status === 'error' ? '✗ Failed' : '⏳ Pending';
                      const sentAt = log.created_at || log.sent_at || log.timestamp;
                      const phone = log.to || log.phone || '';
                      const name = log.client_name || log.name || log.context_name || '';
                      const msgBody = log.message || log.body || log.text || '';
                      return (
                        <tr key={log.id || i} style={{ borderBottom: `1px solid ${isDark ? '#1e2d3d' : '#f8fafc'}`, background: i % 2 === 0 ? 'transparent' : (isDark ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.015)') }}>
                          <td className="px-4 py-3">
                            <p className="font-semibold truncate max-w-[160px]" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>{name || '—'}</p>
                            <p className="text-[10px] font-mono mt-0.5" style={{ color: isDark ? '#475569' : '#94a3b8' }}>{phone}</p>
                          </td>
                          <td className="px-4 py-3 max-w-xs">
                            <p className="truncate" style={{ color: isDark ? '#94a3b8' : '#475569' }}>{msgBody.slice(0, 100) || '—'}</p>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap" style={{ color: isDark ? '#475569' : '#94a3b8' }}>
                            {sentAt ? new Date(sentAt).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: statusBg, color: statusColor, border: `1px solid ${statusColor}40` }}>
                              {statusLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* History footer summary */}
            {filteredHistory.length > 0 && (
              <div className="flex-shrink-0 flex items-center gap-4 px-5 py-2.5 border-t text-[11px]" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9', background: isDark ? '#0d1b2a' : '#f8fafc' }}>
                <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ {filteredHistory.filter(l => ['sent','delivered','read'].includes(l.status)).length} delivered</span>
                <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ {filteredHistory.filter(l => ['failed','error'].includes(l.status)).length} failed</span>
                <span style={{ color: isDark ? '#64748b' : '#94a3b8' }}>⏳ {filteredHistory.filter(l => !['sent','delivered','read','failed','error'].includes(l.status)).length} pending</span>
                <span className="ml-auto" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Showing {filteredHistory.length} of {historyLogs.length} records</span>
              </div>
            )}
          </div>
        )}

        {/* Main compose body — hidden when history is open */}
        {!showHistory && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: client list */}
          <div className="w-64 flex-shrink-0 flex flex-col border-r" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9', background: isDark ? '#0f172a' : '#fafafa' }}>
            {/* Scope tabs */}
            <div className="flex items-center gap-1 px-3 py-2 border-b flex-shrink-0" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9' }}>
              <button onClick={() => handleScopeChange('active')} className="flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border transition-all"
                style={clientScope === 'active' ? { background: accentColor, color: '#fff', borderColor: 'transparent' } : { borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#94a3b8' : '#64748b' }}>
                Active ({activeClients.length})
              </button>
              <button onClick={() => handleScopeChange('all')} className="flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border transition-all"
                style={clientScope === 'all' ? { background: accentColor, color: '#fff', borderColor: 'transparent' } : { borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#94a3b8' : '#64748b' }}>
                All ({filteredClients.length})
              </button>
            </div>
            {/* Search */}
            <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9' }}>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input className="w-full pl-8 pr-3 h-8 text-xs rounded-lg border focus:outline-none"
                  style={{ borderColor: isDark ? '#334155' : '#e2e8f0', background: isDark ? '#1e293b' : '#fff', color: isDark ? '#f1f5f9' : '#0f172a' }}
                  placeholder="Search clients…" value={clientSearch} onChange={e => setClientSearch(e.target.value)} />
              </div>
            </div>
            {/* Service + Client Type filters */}
            <div className="px-3 py-2 border-b flex-shrink-0 space-y-1.5" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9' }}>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold uppercase tracking-widest flex-shrink-0 w-12" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Service</span>
                <select
                  value={waServiceFilter}
                  onChange={e => setWaServiceFilter(e.target.value)}
                  className="flex-1 h-7 text-[10px] font-semibold rounded-lg border px-2 focus:outline-none"
                  style={{ borderColor: waServiceFilter !== 'all' ? accentColor : (isDark ? '#334155' : '#e2e8f0'), background: waServiceFilter !== 'all' ? accentColor + '15' : (isDark ? '#1e293b' : '#fff'), color: waServiceFilter !== 'all' ? accentColor : (isDark ? '#94a3b8' : '#64748b') }}
                >
                  <option value="all">All Services</option>
                  {SERVICES.map(svc => (
                    <option key={svc} value={svc}>{svc}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold uppercase tracking-widest flex-shrink-0 w-12" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Type</span>
                <select
                  value={waClientTypeFilter}
                  onChange={e => setWaClientTypeFilter(e.target.value)}
                  className="flex-1 h-7 text-[10px] font-semibold rounded-lg border px-2 focus:outline-none"
                  style={{ borderColor: waClientTypeFilter !== 'all' ? accentColor : (isDark ? '#334155' : '#e2e8f0'), background: waClientTypeFilter !== 'all' ? accentColor + '15' : (isDark ? '#1e293b' : '#fff'), color: waClientTypeFilter !== 'all' ? accentColor : (isDark ? '#94a3b8' : '#64748b') }}
                >
                  <option value="all">All Types</option>
                  {CLIENT_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              {(waServiceFilter !== 'all' || waClientTypeFilter !== 'all') && (
                <div className="flex items-center justify-between pt-0.5">
                  <p className="text-[9px]" style={{ color: isDark ? '#475569' : '#94a3b8' }}>
                    {displayedClients.length} match{displayedClients.length !== 1 ? 'es' : ''}
                  </p>
                  <button
                    onClick={() => { setWaServiceFilter('all'); setWaClientTypeFilter('all'); }}
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94a3b8' : '#64748b' }}
                  >
                    Clear filters ✕
                  </button>
                </div>
              )}
            </div>
            {/* Select/clear */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b flex-shrink-0" style={{ borderColor: isDark ? '#1e3a5f' : '#f1f5f9' }}>
              <span className="text-[10px]" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>{selectedIds.size} of {displayedClients.filter(cl => !(clientScope === 'active' && cl.status === 'inactive')).length} selected</span>
              <div className="flex gap-2">
                <button onClick={selectAllVisible} className="text-[10px] font-semibold px-2 py-0.5 rounded border" style={{ borderColor: accentColor, color: accentColor, background: accentColor + '18' }}>Select All</button>
                <button onClick={unselectAll} className="text-[10px] font-semibold px-2 py-0.5 rounded border" style={{ borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#94a3b8' : '#64748b' }}>Clear</button>
              </div>
            </div>
            {/* Client list */}
            <div className="flex-1 overflow-y-auto">
              {displayedClients.map(client => {
                const isSelected = selectedIds.has(client.id);
                const hasContact = isWhatsApp ? !!client.phone : !!client.email;
                const isArchived = client.status === 'inactive';
                const isLocked = clientScope === 'active' && isArchived;
                return (
                  <div key={client.id} onClick={() => toggleClient(client.id, isArchived)}
                    className="flex items-center gap-2.5 px-3 py-2.5 border-b transition-all"
                    style={{ borderColor: isDark ? '#1e2d3d' : '#f1f5f9', opacity: isLocked || !hasContact ? 0.4 : 1, cursor: isLocked ? 'not-allowed' : 'pointer', background: isSelected && !isLocked ? (isDark ? 'rgba(37,211,102,0.06)' : 'rgba(37,211,102,0.05)') : 'transparent' }}>
                    <span style={{ color: isSelected && !isLocked ? accentColor : isDark ? '#475569' : '#cbd5e1' }}>
                      {isSelected && !isLocked ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                    </span>
                    <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0" style={{ background: getAvatarGradient(client.company_name) }}>
                      {client.company_name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-semibold truncate" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>{client.company_name}</p>
                      <p className="text-[10px] truncate" style={{ color: isDark ? '#475569' : '#94a3b8' }}>{isWhatsApp ? (client.phone || '— no phone') : (client.email || '— no email')}</p>
                    </div>
                  </div>
                );
              })}
              {displayedClients.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                  <Search className="h-6 w-6 mb-2 opacity-40" /><p className="text-xs">No clients match</p>
                </div>
              )}
            </div>
          </div>

          {/* Right: compose + send */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">

              {/* Template picker from WA Settings */}
              {isWhatsApp && (() => {
                const waS = getWASettings();
                const TMPL_OPTS = [
                  { label: 'Client Message', key: 'clientTemplate' },
                  { label: 'Invoice Reminder', key: 'invoiceTemplate' },
                  { label: 'DSC Expiry Alert', key: 'dscTemplate' },
                  { label: 'Password Share', key: 'passwordTemplate' },
                ];
                return (
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest mb-1.5 block" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Load Template from WhatsApp Settings</label>
                    <div className="flex flex-wrap gap-1.5">
                      {TMPL_OPTS.map(t => (
                        <button key={t.key}
                          onClick={() => { setMessage(waS[t.key] || ''); setSelectedTemplate(t.key); }}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all"
                          style={{ background: selectedTemplate === t.key ? accentColor + '22' : (isDark ? '#1e293b' : '#f8fafc'), borderColor: selectedTemplate === t.key ? accentColor : (isDark ? '#334155' : '#e2e8f0'), color: selectedTemplate === t.key ? accentColor : (isDark ? '#94a3b8' : '#64748b') }}>
                          {t.label}
                        </button>
                      ))}
                      <span className="text-[10px] self-center" style={{ color: isDark ? '#475569' : '#94a3b8' }}>or write your own</span>
                    </div>
                  </div>
                );
              })()}

              {/* Email template picker — loads saved templates from Settings → Email */}
              {!isWhatsApp && emailTemplates.length > 0 && (
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest mb-1.5 block" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Load Saved Email Template</label>
                  <div className="flex flex-wrap gap-1.5">
                    {emailTemplates.map(t => (
                      <button key={t.id}
                        onClick={() => {
                          setMessage(t.body || '');
                          setSubjectLine(t.subject || '');
                          setSelectedTemplate(t.id);
                          if (t.attachment_base64) {
                            setMediaFile({
                              name: t.attachment_name || 'attachment',
                              mimeType: 'application/octet-stream',
                              base64: t.attachment_base64,
                              previewUrl: null,
                              size: Math.round((t.attachment_base64.length * 3) / 4),
                            });
                          }
                        }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1"
                        style={{ background: selectedTemplate === t.id ? accentColor + '22' : (isDark ? '#1e293b' : '#f8fafc'), borderColor: selectedTemplate === t.id ? accentColor : (isDark ? '#334155' : '#e2e8f0'), color: selectedTemplate === t.id ? accentColor : (isDark ? '#94a3b8' : '#64748b') }}>
                        {t.attachment_name ? <Paperclip className="h-3 w-3" /> : null}
                        {t.name}
                      </button>
                    ))}
                    <span className="text-[10px] self-center" style={{ color: isDark ? '#475569' : '#94a3b8' }}>or write your own</span>
                  </div>
                </div>
              )}

              {/* Subject (email only) */}
              {!isWhatsApp && (
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest mb-1.5 block" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Subject</label>
                  <input
                    value={subjectLine}
                    onChange={e => setSubjectLine(e.target.value)}
                    placeholder="e.g. GST filing reminder for {name}"
                    className="w-full border rounded-xl text-sm px-3.5 py-2.5 outline-none transition-all"
                    style={{ background: isDark ? '#1e293b' : '#f8fafc', borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a' }} />
                </div>
              )}

              {/* Message composer */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Message</label>
                  <button onClick={() => setShowVariables(v => !v)} className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: isDark ? '#1e293b' : '#f1f5f9', color: isDark ? '#94a3b8' : '#64748b' }}>
                    {showVariables ? '▲ Hide variables' : '▼ Variables'}
                  </button>
                </div>
                {showVariables && (
                  <div className="flex flex-wrap gap-1.5 mb-2 p-2.5 rounded-lg border" style={{ background: isDark ? '#0f1e2d' : '#f8fafc', borderColor: isDark ? '#1e3a5f' : '#e2e8f0' }}>
                    {['{name}', '{phone}', '{email}', '{city}', '{gstin}', '{services}'].map(v => (
                      <button key={v} onClick={() => setMessage(m => m + v)} className="text-[10px] font-mono font-bold px-2 py-1 rounded-md border hover:opacity-80 transition"
                        style={{ background: isDark ? '#1e3a5f' : '#eff6ff', color: isDark ? '#93c5fd' : '#1d4ed8', borderColor: isDark ? '#2563eb40' : '#bfdbfe' }}>
                        {v}
                      </button>
                    ))}
                    <span className="text-[10px] self-center" style={{ color: isDark ? '#475569' : '#94a3b8' }}>→ auto-replaced per client when sent</span>
                  </div>
                )}
                <textarea
                  className="w-full min-h-[140px] border rounded-xl text-sm p-3.5 resize-none outline-none transition-all leading-relaxed"
                  style={{ background: isDark ? '#1e293b' : '#f8fafc', borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a' }}
                  placeholder={"Dear {name},\n\nGST filing reminder for this month\u2026\n\nRegards,\nManthan Desai & Associates"}
                  value={message} onChange={e => { setMessage(e.target.value); setSelectedTemplate(''); }} />
                <p className="text-[10px] mt-1" style={{ color: isDark ? '#475569' : '#94a3b8' }}>{message.length} chars · Use variables above for personalization per client</p>
              </div>

              {/* ── Media / File Attachment (WhatsApp + Email) ── */}
              {(
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest mb-1.5 block" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>
                    {isWhatsApp ? 'Attach Media' : 'Attach File'} <span style={{ color: isDark ? '#334155' : '#cbd5e1', fontWeight: 400 }}>{isWhatsApp ? '(image, PDF, Excel, Word — max 16 MB)' : '(PDF, Excel, Word, image — sent with every email)'}</span>
                  </label>

                  <input
                    type="file"
                    ref={mediaInputRef}
                    style={{ display: 'none' }}
                    accept="image/*,.pdf,.xlsx,.xls,.docx,.doc,.mp4,.mp3"
                    onChange={handleMediaSelect}
                  />
                  {!mediaFile ? (
                    <button
                      onClick={() => mediaInputRef.current?.click()}
                      className="flex items-center gap-2 w-full border-2 border-dashed rounded-xl px-4 py-3 text-sm font-semibold transition-all hover:opacity-80"
                      style={{ borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#64748b' : '#94a3b8', background: isDark ? '#1e293b' : '#f8fafc' }}>
                      <Paperclip className="h-4 w-4 flex-shrink-0" />
                      Click to attach file
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                      style={{ background: isDark ? '#0a1628' : '#f0fdf4', borderColor: isDark ? '#166534' : '#86efac' }}>
                      {mediaFile.previewUrl ? (
                        <img src={mediaFile.previewUrl} alt="preview" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                      ) : (
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-xs font-bold"
                          style={{ background: mediaFile.mimeType.includes('pdf') ? '#ef4444' : mediaFile.mimeType.includes('sheet') || mediaFile.mimeType.includes('excel') ? '#22c55e' : '#3b82f6' }}>
                          {mediaFile.mimeType.includes('pdf') ? 'PDF' : mediaFile.mimeType.includes('sheet') || mediaFile.mimeType.includes('excel') ? 'XLS' : 'DOC'}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold truncate" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>{mediaFile.name}</p>
                        <p className="text-[10px]" style={{ color: isDark ? '#4ade80' : '#166534' }}>{(mediaFile.size / 1024).toFixed(0)} KB · Will be sent to all selected clients</p>
                      </div>
                      <button onClick={() => setMediaFile(null)}
                        className="flex-shrink-0 rounded-lg p-1 hover:opacity-70 transition"
                        style={{ color: isDark ? '#94a3b8' : '#64748b' }}>
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {isWhatsApp && (
                <>
                  {/* Send mode tabs */}
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest mb-2 block" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Send Method</label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { key: SEND_MODES.DIRECT, label: '⚡ Direct Send', desc: 'Via WA bridge', color: WA_GREEN, req: waConnected },
                        { key: SEND_MODES.SCHEDULE, label: '🕐 Schedule', desc: 'Pick date & time', color: '#f59e0b', req: waConnected },
                        { key: SEND_MODES.WHATSAPP_WEB, label: '🌐 WA Web', desc: 'Copy & open', color: '#3b82f6', req: true },
                        { key: SEND_MODES.EXPORT, label: '📤 Export CSV', desc: 'Broadcast list', color: '#8b5cf6', req: true },
                      ].map(({ key, label, desc, color, req }) => (
                        <button key={key} onClick={() => setSendMode(key)}
                          className="flex flex-col items-center gap-0.5 p-2.5 rounded-xl border text-center transition-all"
                          style={{
                            background: sendMode === key ? color + '15' : (isDark ? '#1e293b' : '#f8fafc'),
                            borderColor: sendMode === key ? color : (isDark ? '#334155' : '#e2e8f0'),
                            opacity: req === false ? 0.45 : 1,
                          }}>
                          <span className="text-xs font-bold" style={{ color: sendMode === key ? color : (isDark ? '#94a3b8' : '#64748b') }}>{label}</span>
                          <span className="text-[9px]" style={{ color: isDark ? '#475569' : '#94a3b8' }}>{desc}</span>
                          {req === false && <span className="text-[9px] text-red-400">WA offline</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Direct send panel */}
                  {sendMode === SEND_MODES.DIRECT && (
                    <div className="rounded-xl border p-4 space-y-3" style={{ background: isDark ? '#0a1628' : '#f0fdf4', borderColor: isDark ? '#1a3a1a' : '#bbf7d0' }}>
                      <p className="text-xs font-bold" style={{ color: isDark ? '#4ade80' : '#166534' }}>⚡ Direct Send — {phoneCount} clients with phone</p>
                      <p className="text-xs" style={{ color: isDark ? '#6ee7b7' : '#15803d' }}>Messages are sent individually with personalized content. Each client receives their own message with their name and details.</p>

                      {/* Batch name — required, used to group messages in WhatsApp History */}
                      <div className="rounded-lg border p-3" style={{ background: isDark ? '#0f1f2e' : '#fff', borderColor: isDark ? '#1e3a5f' : '#bae6fd' }}>
                        <label className="text-[11px] font-bold block mb-1.5" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>
                          🏷️ Batch name <span style={{ color: '#ef4444' }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={batchName}
                          onChange={e => setBatchName(e.target.value)}
                          placeholder="e.g. Income Tax Reminder – July 2026"
                          className="w-full h-9 px-3 rounded-lg border text-sm font-medium"
                          style={{ background: isDark ? '#1e293b' : '#f0f9ff', borderColor: isDark ? '#334155' : '#bae6fd', color: isDark ? '#e2e8f0' : '#0f172a' }}
                        />
                        <p className="text-[10px] mt-1.5" style={{ color: isDark ? '#64748b' : '#64748b' }}>
                          All messages in this send will be tagged with this name. Open <b>History</b> and click a batch to see the full data for that send.
                        </p>
                      </div>

                      {/* ── Pause / Delay settings ───────────────────────── */}
                      <div className="rounded-lg border p-3 space-y-2.5" style={{ background: isDark ? '#0f1f2e' : '#fff', borderColor: isDark ? '#1e3a5f' : '#bae6fd' }}>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>⏸ Auto-Pause Between Messages</span>
                          <button
                            type="button"
                            onClick={() => setPauseEnabled(v => !v)}
                            className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                            style={{ background: pauseEnabled ? '#25D366' : (isDark ? '#334155' : '#e2e8f0') }}>
                            <span className="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform"
                              style={{ transform: pauseEnabled ? 'translateX(18px)' : 'translateX(2px)' }} />
                          </button>
                        </div>
                        {pauseEnabled && (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] font-semibold block mb-1" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>Pause after every</label>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number" min={1} max={500} value={pauseAfterCount}
                                  onChange={e => setPauseAfterCount(Math.max(1, parseInt(e.target.value) || 1))}
                                  className="w-full h-8 px-2 rounded-lg border text-sm text-center font-bold"
                                  style={{ background: isDark ? '#1e293b' : '#f0f9ff', borderColor: isDark ? '#334155' : '#bae6fd', color: isDark ? '#e2e8f0' : '#0f172a' }} />
                                <span className="text-[10px] font-semibold whitespace-nowrap" style={{ color: isDark ? '#64748b' : '#64748b' }}>msgs</span>
                              </div>
                            </div>
                            <div>
                              <label className="text-[10px] font-semibold block mb-1" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>Pause duration</label>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number" min={5} max={3600} value={pauseDurationSec}
                                  onChange={e => setPauseDurationSec(Math.max(5, parseInt(e.target.value) || 60))}
                                  className="w-full h-8 px-2 rounded-lg border text-sm text-center font-bold"
                                  style={{ background: isDark ? '#1e293b' : '#f0f9ff', borderColor: isDark ? '#334155' : '#bae6fd', color: isDark ? '#e2e8f0' : '#0f172a' }} />
                                <span className="text-[10px] font-semibold whitespace-nowrap" style={{ color: isDark ? '#64748b' : '#64748b' }}>sec</span>
                              </div>
                            </div>
                          </div>
                        )}
                        {pauseEnabled && (
                          <p className="text-[10px]" style={{ color: isDark ? '#60a5fa' : '#2563eb' }}>
                            Will pause for {pauseDurationSec}s after every {pauseAfterCount} message{pauseAfterCount !== 1 ? 's' : ''} to avoid WA rate limits.
                          </p>
                        )}
                      </div>

                      {sendProgress && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs font-semibold" style={{ color: isDark ? '#4ade80' : '#166534' }}>
                            <span>Sending {sendProgress.done} / {sendProgress.total}</span>
                            <span>{Math.round(sendProgress.done / sendProgress.total * 100)}%</span>
                          </div>
                          <div className="h-2 rounded-full overflow-hidden" style={{ background: isDark ? '#1e3a1e' : '#dcfce7' }}>
                            <div className="h-full rounded-full transition-all" style={{ width: `${sendProgress.done / sendProgress.total * 100}%`, background: WA_GREEN }} />
                          </div>
                          {/* Pause countdown overlay */}
                          {pauseCountdown !== null && (
                            <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: isDark ? '#1a2a3a' : '#eff6ff', border: `1px solid ${isDark ? '#1e3a5f' : '#bfdbfe'}` }}>
                              <Clock className="h-3.5 w-3.5 animate-pulse" style={{ color: isDark ? '#60a5fa' : '#2563eb' }} />
                              <span className="text-xs font-bold" style={{ color: isDark ? '#93c5fd' : '#1d4ed8' }}>
                                Pausing… resuming in {pauseCountdown}s
                              </span>
                              <button
                                type="button"
                                onClick={() => { pauseRef.current = true; setPauseCountdown(null); }}
                                className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-md"
                                style={{ background: '#ef444420', color: '#ef4444', border: '1px solid #ef444440' }}>
                                Stop
                              </button>
                            </div>
                          )}
                          {sendProgress.results.length > 0 && (
                            <div className="max-h-20 overflow-y-auto space-y-0.5">
                              {sendProgress.results.slice(-5).map((r, i) => (
                                <p key={i} className="text-[10px]" style={{ color: r.status === 'sent' ? (isDark ? '#4ade80' : '#166534') : '#ef4444' }}>
                                  {r.status === 'sent' ? '✓' : '✗'} {r.name}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {!sendProgress && (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedClients.filter(c => c.phone).slice(0, 6).map(c => (
                            <span key={c.id} className="text-[10px] font-semibold px-2 py-0.5 rounded-lg border" style={{ borderColor: isDark ? '#166534' : '#86efac', color: isDark ? '#4ade80' : '#166534', background: isDark ? '#0a2518' : '#fff' }}>{c.company_name}</span>
                          ))}
                          {phoneCount > 6 && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#64748b' : '#94a3b8', background: isDark ? '#1e293b' : '#fff' }}>+{phoneCount - 6} more</span>}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Schedule panel */}
                  {sendMode === SEND_MODES.SCHEDULE && (
                    <div className="rounded-xl border p-4 space-y-3" style={{ background: isDark ? '#1a1200' : '#fffbeb', borderColor: isDark ? '#3a2500' : '#fde68a' }}>
                      <p className="text-xs font-bold" style={{ color: isDark ? '#fbbf24' : '#92400e' }}>🕐 Schedule Bulk Send</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-semibold block mb-1" style={{ color: isDark ? '#fbbf24' : '#92400e' }}>Date</label>
                          <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)}
                            min={new Date().toISOString().split('T')[0]}
                            className="w-full h-9 px-3 rounded-lg border text-sm"
                            style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a' }} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold block mb-1" style={{ color: isDark ? '#fbbf24' : '#92400e' }}>Time (IST)</label>
                          <input type="time" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)}
                            className="w-full h-9 px-3 rounded-lg border text-sm"
                            style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a' }} />
                        </div>
                      </div>
                      <p className="text-[11px]" style={{ color: isDark ? '#d97706' : '#a16207' }}>
                        Will send {phoneCount} personalized messages on {scheduleDate} at {scheduleTime} IST
                      </p>
                      {/* Existing scheduled jobs */}
                      {scheduledJobs.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[10px] font-bold mb-1.5" style={{ color: isDark ? '#fbbf24' : '#92400e' }}>Scheduled Jobs</p>
                          <div className="space-y-1.5 max-h-32 overflow-y-auto">
                            {scheduledJobs.map(job => (
                              <div key={job.id} className="flex items-center justify-between text-[10px] px-2.5 py-1.5 rounded-lg border"
                                style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                                <div>
                                  <span className="font-semibold" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>{job.recipient_count} clients</span>
                                  <span className="ml-2" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>{job.scheduled_at?.replace('T', ' ').slice(0, 16)} IST</span>
                                </div>
                                <button onClick={() => handleCancelJob(job.id)} className="text-red-400 hover:text-red-500 font-semibold ml-2">Cancel</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* WA Web panel */}
                  {sendMode === SEND_MODES.WHATSAPP_WEB && (
                    <div className="rounded-xl border p-4" style={{ background: isDark ? '#0a1628' : '#eff6ff', borderColor: isDark ? '#1e3a5f' : '#bfdbfe' }}>
                      <p className="text-xs font-bold mb-1" style={{ color: isDark ? '#93c5fd' : '#1e40af' }}>🌐 Copy & Open WhatsApp Web</p>
                      <p className="text-xs" style={{ color: isDark ? '#60a5fa' : '#1d4ed8' }}>Copies your message to clipboard and opens WhatsApp Web. Paste and send manually to each client.</p>
                    </div>
                  )}

                  {/* Export CSV panel */}
                  {sendMode === SEND_MODES.EXPORT && (
                    <div className="rounded-2xl border-2 border-dashed p-4 space-y-2.5" style={{ borderColor: isDark ? '#2d4a2d' : '#86efac', background: isDark ? '#0a1a0a' : 'linear-gradient(135deg, #f0fdf4, #f7fffe)' }}>
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 text-white text-sm font-bold" style={{ background: 'linear-gradient(135deg, #128C7E, #25D366)' }}>📤</div>
                        <div>
                          <p className="text-sm font-bold" style={{ color: isDark ? '#4ade80' : '#166534' }}>Export for WhatsApp Broadcast</p>
                          <p className="text-xs mt-0.5" style={{ color: isDark ? '#6ee7b7' : '#15803d' }}>Downloads a CSV with all phone numbers + message. Also copies numbers to clipboard in WhatsApp format (91XXXXXXXXXX).</p>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Email sender selector */}
              {!isWhatsApp && (
                <div className="rounded-xl border p-3" style={{ background: isDark ? '#0a1628' : '#f0f9ff', borderColor: isDark ? '#1e3a5f' : '#bae6fd' }}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: isDark ? '#7dd3fc' : '#0369a1' }}>📤 Sending From</p>
                    <button
                      type="button"
                      onClick={() => setShowSenderPicker(v => !v)}
                      className="text-[10px] font-bold px-2 py-0.5 rounded-lg border transition-all"
                      style={{ borderColor: isDark ? '#1e3a5f' : '#bae6fd', color: isDark ? '#7dd3fc' : '#0369a1', background: isDark ? 'rgba(125,211,252,0.1)' : '#e0f2fe' }}>
                      {showSenderPicker ? '▲ Close' : '⇄ Switch'}
                    </button>
                  </div>
                  {senderLoading ? (
                    <p className="text-[11px]" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Loading sender…</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-black flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                        {(activeSender?.name || activeSender?.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate" style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>
                          {activeSender?.name || 'Not configured'}
                        </p>
                        <p className="text-[10px] truncate" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>
                          {activeSender?.email || 'Set SENDER_EMAIL in Render'}
                        </p>
                      </div>
                    </div>
                  )}
                  {/* Sender picker dropdown */}
                  {showSenderPicker && senderList.length > 0 && (
                    <div className="mt-2.5 pt-2.5 border-t space-y-1" style={{ borderColor: isDark ? '#1e3a5f' : '#bae6fd' }}>
                      <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: isDark ? '#475569' : '#94a3b8' }}>
                        Choose sender for this batch:
                      </p>
                      {senderList.map(s => {
                        const isActive = s.email === activeSender?.email;
                        return (
                          <button key={s.email} type="button"
                            onClick={() => { setActiveSender({ email: s.email, name: s.name || s.email }); setShowSenderPicker(false); }}
                            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all text-left"
                            style={{
                              borderColor: isActive ? '#0D3B66' : (isDark ? '#1e3a5f' : '#e2e8f0'),
                              background: isActive ? (isDark ? 'rgba(13,59,102,0.3)' : '#dbeafe') : (isDark ? 'rgba(255,255,255,0.03)' : '#fff'),
                            }}>
                            <div className="w-5 h-5 rounded-md flex items-center justify-center text-white text-[9px] font-black flex-shrink-0"
                              style={{ background: isActive ? '#0D3B66' : (isDark ? '#334155' : '#94a3b8') }}>
                              {(s.name || s.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-semibold truncate" style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{s.name || s.email}</p>
                              <p className="text-[9px] truncate" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>{s.email}</p>
                            </div>
                            {isActive && <span className="text-[9px] font-bold text-emerald-500 flex-shrink-0">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Email compose hint */}
              {!isWhatsApp && selectedClients.length > 0 && (
                <div className="rounded-xl border p-3.5" style={{ background: isDark ? '#0a1628' : '#eff6ff', borderColor: isDark ? '#1e3a5f' : '#bfdbfe' }}>
                  <p className="text-xs font-bold mb-1.5" style={{ color: isDark ? '#93c5fd' : '#1e40af' }}>📧 {emailCount} recipients</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedClients.slice(0, 6).map(c => (
                      <span key={c.id} className="text-[10px] font-semibold px-2 py-0.5 rounded-lg border" style={{ borderColor: isDark ? '#1e3a5f' : '#93c5fd', color: isDark ? '#93c5fd' : '#1e40af', background: isDark ? '#0a1628' : '#fff' }}>{c.company_name}</span>
                    ))}
                    {selectedClients.length > 6 && <span className="text-[10px] px-2 py-0.5" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>+{selectedClients.length - 6} more</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Footer action bar */}
            <div className="flex-shrink-0 border-t" style={{ borderColor: isDark ? '#1e2d3d' : '#f1f5f9', background: isDark ? '#0a1220' : '#fff' }}>
              {/* Actions heading */}
              <div className="px-5 pt-3 pb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? '#475569' : '#94a3b8' }}>Actions</p>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 pb-3.5">
              <Button type="button" variant="ghost" onClick={onClose} className="h-10 px-4 text-sm rounded-xl" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>Cancel</Button>
              {selectedClients.length === 0 && <span className="text-xs text-amber-500 font-medium">← Select at least one client</span>}
              <div className="flex items-center gap-2 ml-auto">
                {isWhatsApp ? (
                  <>
                    {sendMode === SEND_MODES.DIRECT && (
                      <button disabled={!sendBtnEnabled || sendingBulk || !waConnected} onClick={handleDirectSend}
                        className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                        style={{ background: sendBtnEnabled && waConnected ? `linear-gradient(135deg, ${WA_DARK}, ${WA_GREEN})` : '#94a3b8', boxShadow: sendBtnEnabled && waConnected ? `0 4px 14px ${WA_GREEN}40` : 'none' }}>
                        {sendingBulk
                          ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending {sendProgress?.done}/{sendProgress?.total}…</>
                          : <><Send className="h-4 w-4" /> Send to {phoneCount} clients</>}
                      </button>
                    )}
                    {sendMode === SEND_MODES.SCHEDULE && (
                      <button disabled={!sendBtnEnabled || !scheduleDate || !waConnected} onClick={handleScheduleSend}
                        className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                        style={{ background: sendBtnEnabled && scheduleDate && waConnected ? 'linear-gradient(135deg, #d97706, #f59e0b)' : '#94a3b8' }}>
                        <Clock className="h-4 w-4" /> Schedule {phoneCount} Messages
                      </button>
                    )}
                    {sendMode === SEND_MODES.WHATSAPP_WEB && (
                      <button disabled={!message.trim() || selectedClients.length === 0} onClick={handleWhatsApp}
                        className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                        style={{ background: message.trim() && selectedClients.length > 0 ? `linear-gradient(135deg, #1e40af, #3b82f6)` : '#94a3b8' }}>
                        {copied ? <><CheckCircle2 className="h-4 w-4" /> Copied!</> : <><Copy className="h-4 w-4" /> Copy & Open WA Web</>}
                      </button>
                    )}
                    {sendMode === SEND_MODES.EXPORT && (
                      <button onClick={handleExportBroadcast} disabled={phoneCount === 0}
                        className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                        style={{ background: exportDone ? 'linear-gradient(135deg, #059669, #10b981)' : `linear-gradient(135deg, ${WA_DARK}, ${WA_GREEN})` }}>
                        {exportDone ? <><CheckCircle2 className="h-4 w-4" /> Exported!</> : <><FileText className="h-4 w-4" /> Export CSV ({phoneCount} clients)</>}
                      </button>
                    )}
                  </>
                ) : (
                  <Button type="button"
                    disabled={!message.trim() || selectedClients.length === 0 || sendingBulk}
                    onClick={handleEmail}
                    className="h-10 px-6 text-sm rounded-xl text-white font-semibold gap-2 shadow-sm disabled:opacity-50"
                    style={{ background: (!message.trim() || selectedClients.length === 0) ? '#94a3b8' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                    {sendingBulk
                      ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full inline-block animate-spin" />Sending...</>
                      : <>Send {emailCount} Email{emailCount !== 1 ? 's' : ''}</>}
                  </Button>
                )}
              </div>
              </div>
            </div>
          </div>
        </div>
        )} {/* end !showHistory */}
      </DialogContent>
    </Dialog>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// BULK ASSIGN MODAL
// ═══════════════════════════════════════════════════════════════════════════
const BulkAssignModal = React.memo(({ open, onClose, filteredClients, users, isDark, onAssignComplete }) => {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [clientSearch, setClientSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedServices, setSelectedServices] = useState([]);
  const [mode, setMode] = useState('add'); // 'add' | 'replace'
  const [saving, setSaving] = useState(false);
  const [clientScope, setClientScope] = useState('active');

  const activeClients = useMemo(() => filteredClients.filter(c => (c?.status || 'active') !== 'inactive'), [filteredClients]);

  useEffect(() => {
    if (open) {
      setClientScope('active');
      setSelectedIds(new Set(activeClients.map(c => c.id)));
      setClientSearch('');
      setSelectedUserId('');
      setSelectedServices([]);
      setMode('add');
      setSaving(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayedClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    const base = filteredClients;
    if (!q) return base;
    return base.filter(c =>
      (c?.company_name || '').toLowerCase().includes(q) ||
      (c?.phone || '').includes(q) ||
      (c?.email || '').toLowerCase().includes(q)
    );
  }, [filteredClients, clientSearch]);

  const selectedClients = useMemo(() => filteredClients.filter(c => selectedIds.has(c.id)), [filteredClients, selectedIds]);

  const toggleClient = useCallback((id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const handleScopeChange = useCallback((scope) => {
    setClientScope(scope);
    const base = scope === 'active' ? activeClients : filteredClients;
    setSelectedIds(new Set(base.map(c => c.id)));
  }, [activeClients, filteredClients]);

  const allDisplayedSelected = displayedClients.length > 0 && displayedClients.every(c => selectedIds.has(c.id));
  const someDisplayedSelected = displayedClients.some(c => selectedIds.has(c.id));

  const toggleAll = useCallback(() => {
    if (allDisplayedSelected) {
      setSelectedIds(prev => { const n = new Set(prev); displayedClients.forEach(c => n.delete(c.id)); return n; });
    } else {
      setSelectedIds(prev => { const n = new Set(prev); displayedClients.forEach(c => n.add(c.id)); return n; });
    }
  }, [allDisplayedSelected, displayedClients]);

  const toggleService = useCallback((svc) => {
    setSelectedServices(prev => prev.includes(svc) ? prev.filter(s => s !== svc) : [...prev, svc]);
  }, []);

  const selectedUser = users.find(u => u.id === selectedUserId);

  const handleAssign = useCallback(async () => {
    if (!selectedUserId) { return; }
    if (selectedClients.length === 0) { return; }
    setSaving(true);
    let successCount = 0;
    let failCount = 0;
    for (const client of selectedClients) {
      try {
        let newAssignments;
        if (mode === 'replace') {
          newAssignments = [{ user_id: selectedUserId, services: selectedServices }];
        } else {
          // 'add' mode — merge, deduplicating by user_id
          const existing = client.assignments || [];
          const alreadyAssigned = existing.find(a => a.user_id === selectedUserId);
          if (alreadyAssigned) {
            // Merge services
            const merged = [...new Set([...(alreadyAssigned.services || []), ...selectedServices])];
            newAssignments = existing.map(a => a.user_id === selectedUserId ? { ...a, services: merged } : a);
          } else {
            newAssignments = [...existing, { user_id: selectedUserId, services: selectedServices }];
          }
        }
        await api.put(`/clients/${client.id}`, { assignments: newAssignments });
        successCount++;
      } catch {
        failCount++;
      }
    }
    setSaving(false);
    if (successCount > 0) {
      toast.success(`Assigned ${selectedUser?.full_name || selectedUser?.name || 'user'} to ${successCount} client${successCount !== 1 ? 's' : ''}${failCount > 0 ? ` (${failCount} failed)` : ''}`);
      onAssignComplete();
    } else {
      toast.error('Assignment failed. Please try again.');
    }
    onClose();
  }, [selectedUserId, selectedClients, mode, selectedServices, selectedUser, onAssignComplete, onClose]);

  const accentGrad = 'linear-gradient(135deg, #0D3B66, #1F6FB2)';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border border-slate-200 shadow-2xl p-0 bg-white">
        <DialogTitle className="sr-only">Bulk Assign Clients</DialogTitle>
        {/* Header */}
        <div className="flex-shrink-0 px-7 py-5 border-b border-slate-100" style={{ background: 'linear-gradient(135deg, #eff6ff, #dbeafe)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-sm flex-shrink-0" style={{ background: accentGrad }}>
              <UserCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Bulk Assign Clients</h2>
              <p className="text-xs text-slate-500 mt-0.5">Select clients and assign them to a team member in one shot</p>
            </div>
            <div className="ml-auto flex-shrink-0">
              <span className="text-xs font-bold px-3 py-1.5 rounded-full border" style={{ background: '#dbeafe', color: '#1e40af', borderColor: '#bfdbfe' }}>
                {selectedIds.size} selected
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* LEFT: Client list */}
          <div className={`w-72 flex-shrink-0 border-r flex flex-col ${isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-100 bg-slate-50/40'}`}>
            {/* Scope toggle */}
            <div className={`flex items-center gap-1 px-3 pt-3 pb-2 flex-shrink-0`}>
              {['active', 'all'].map(scope => (
                <button key={scope} onClick={() => handleScopeChange(scope)}
                  className="flex-1 h-7 rounded-lg text-[10px] font-bold transition-all capitalize"
                  style={clientScope === scope ? { background: accentGrad, color: '#fff' } : { background: isDark ? 'rgba(255,255,255,0.07)' : '#f1f5f9', color: isDark ? '#94a3b8' : '#64748b' }}>
                  {scope === 'active' ? `Active (${activeClients.length})` : `All (${filteredClients.length})`}
                </button>
              ))}
            </div>
            {/* Search */}
            <div className={`flex items-center gap-1.5 px-3 py-2.5 border-b flex-shrink-0 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
              <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
              <input
                className={`flex-1 text-xs bg-transparent outline-none placeholder:text-slate-400 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}
                placeholder="Search clients…"
                value={clientSearch}
                onChange={e => setClientSearch(e.target.value)}
              />
              {clientSearch && <button onClick={() => setClientSearch('')} className="text-slate-300 hover:text-slate-500"><X className="h-3 w-3" /></button>}
            </div>
            {/* Select-all row */}
            <div className={`flex items-center gap-2 px-3 py-2 border-b text-[10px] font-bold uppercase tracking-widest flex-shrink-0 ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-100 text-slate-400'}`}>
              <button onClick={toggleAll} className="flex items-center gap-1.5 hover:text-blue-600 transition-colors">
                {allDisplayedSelected
                  ? <CheckSquare className="h-3.5 w-3.5 text-blue-600" />
                  : someDisplayedSelected
                    ? <MinusSquare className="h-3.5 w-3.5 text-blue-400" />
                    : <Square className="h-3.5 w-3.5" />}
                {allDisplayedSelected ? 'Deselect All' : 'Select All'}
              </button>
              <span className="ml-auto">{displayedClients.length} shown</span>
            </div>
            {/* Client rows */}
            <div className="flex-1 overflow-y-auto">
              {displayedClients.map(c => {
                const isArchived = (c?.status || 'active') === 'inactive';
                const checked = selectedIds.has(c.id);
                return (
                  <div
                    key={c.id}
                    onClick={() => toggleClient(c.id)}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b last:border-0 ${isDark ? 'border-slate-700/60' : 'border-slate-50'} ${checked ? (isDark ? 'bg-blue-900/20' : 'bg-blue-50/60') : (isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50')}`}
                  >
                    {checked
                      ? <CheckSquare className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" />
                      : <Square className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" />}
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                      style={{ background: getAvatarGradient(c.company_name), opacity: isArchived ? 0.5 : 1 }}>
                      {c.company_name?.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-semibold truncate leading-tight ${isArchived ? 'text-slate-400' : (isDark ? 'text-slate-200' : 'text-slate-800')}`}>
                        {c.company_name}
                        {isArchived && <span className="ml-1 text-[9px] text-amber-500 font-bold">ARCHIVED</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 truncate">{c.phone || c.email || '—'}</p>
                    </div>
                  </div>
                );
              })}
              {displayedClients.length === 0 && (
                <div className="flex flex-col items-center justify-center h-24 text-slate-400">
                  <p className="text-xs">No clients found</p>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Assignment config */}
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="flex-1 p-6 space-y-5">
              {/* User picker */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">
                  Assign To <span className="text-red-400">*</span>
                </label>
                <div className="grid grid-cols-1 gap-2 max-h-52 overflow-y-auto pr-1">
                  {users.length === 0 && (
                    <p className="text-xs text-slate-400 italic">No team members found.</p>
                  )}
                  {users.map(u => {
                    const isSelected = selectedUserId === u.id;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => setSelectedUserId(u.id)}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${isSelected
                          ? 'border-blue-300 shadow-sm'
                          : (isDark ? 'border-slate-600 bg-slate-700/40 hover:border-slate-500' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50')
                        }`}
                        style={isSelected ? { background: 'linear-gradient(135deg, #eff6ff, #dbeafe)', borderColor: '#93c5fd' } : {}}
                      >
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                          style={{ background: getAvatarGradient(u.full_name || u.name || u.email) }}>
                          {(u.full_name || u.name || u.email)?.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                            {u.full_name || u.name || u.email}
                          </p>
                          {u.departments?.length > 0 && (
                            <p className="text-[10px] text-slate-400 truncate">{u.departments.join(', ')}</p>
                          )}
                        </div>
                        {isSelected && <CheckCircle2 className="h-4 w-4 text-blue-600 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Services (optional) */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">
                  Services <span className="text-slate-300 font-normal normal-case">(optional — leave blank for all)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {SERVICES.map(svc => {
                    const isSel = selectedServices.includes(svc);
                    return (
                      <button key={svc} type="button" onClick={() => toggleService(svc)}
                        className={`px-3 py-1 text-xs font-semibold rounded-xl border transition-all ${isSel ? 'text-white border-transparent' : (isDark ? 'bg-slate-700 text-slate-300 border-slate-600 hover:border-slate-500' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50')}`}
                        style={isSel ? { background: accentGrad } : {}}>
                        {svc}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Mode toggle */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Assignment Mode</label>
                <div className={`flex rounded-xl border overflow-hidden ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
                  {[
                    { value: 'add', label: 'Add to existing', desc: 'Keep current assignments + add this user' },
                    { value: 'replace', label: 'Replace all', desc: 'Remove existing assignments, set only this user' },
                  ].map((opt, i) => (
                    <button key={opt.value} type="button" onClick={() => setMode(opt.value)}
                      className={`flex-1 px-4 py-3 text-left transition-all border-r last:border-r-0 ${isDark ? 'border-slate-600' : 'border-slate-200'}`}
                      style={mode === opt.value ? { background: accentGrad } : { background: isDark ? 'rgba(255,255,255,0.04)' : '#f8fafc' }}>
                      <p className={`text-xs font-bold ${mode === opt.value ? 'text-white' : (isDark ? 'text-slate-200' : 'text-slate-700')}`}>{opt.label}</p>
                      <p className={`text-[10px] mt-0.5 ${mode === opt.value ? 'text-blue-100' : 'text-slate-400'}`}>{opt.desc}</p>
                    </button>
                  ))}
                </div>
                {mode === 'replace' && (
                  <div className="flex items-start gap-2 mt-2 px-3 py-2 rounded-xl border border-amber-200 bg-amber-50">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-[10px] text-amber-700 font-medium">This will replace ALL existing assignments for the selected clients with only this user.</p>
                  </div>
                )}
              </div>

              {/* Summary */}
              {selectedUserId && selectedClients.length > 0 && (
                <div className="rounded-xl border p-4" style={{ background: 'linear-gradient(135deg, #f0fdf4, #dcfce7)', borderColor: '#bbf7d0' }}>
                  <p className="text-xs font-semibold text-emerald-800">
                    ✓ Ready to {mode === 'replace' ? 'replace assignments and assign' : 'assign'}{' '}
                    <strong>{selectedUser?.full_name || selectedUser?.name}</strong>{' '}
                    to <strong>{selectedClients.length}</strong> client{selectedClients.length !== 1 ? 's' : ''}
                    {selectedServices.length > 0 && <> for <strong>{selectedServices.join(', ')}</strong></>}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`flex-shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
          <Button type="button" variant="ghost" onClick={onClose} className="h-10 px-4 text-sm rounded-xl text-slate-500">Cancel</Button>
          <div className="flex items-center gap-2">
            {!selectedUserId && <span className="text-xs text-amber-600 font-medium">← Select a team member first</span>}
            {selectedUserId && selectedClients.length === 0 && <span className="text-xs text-amber-600 font-medium">← Select at least one client</span>}
            <Button type="button"
              disabled={!selectedUserId || selectedClients.length === 0 || saving}
              onClick={handleAssign}
              className="h-10 px-6 text-sm rounded-xl text-white font-semibold gap-2 shadow-sm disabled:opacity-50"
              style={{ background: (!selectedUserId || selectedClients.length === 0 || saving) ? '#94a3b8' : accentGrad }}>
              {saving ? (
                <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Assigning…</>
              ) : (
                <><UserCheck className="h-4 w-4" /> Assign {selectedClients.length > 0 ? `(${selectedClients.length})` : ''}</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// EDITABLE DROPDOWN — select with per-item Edit & Delete buttons
// ═══════════════════════════════════════════════════════════════════════════
const EditableDropdown = React.memo(({
  value, onChange, options = [], staticOptions = [],
  onEdit, onDelete, onAddNew,
  placeholder = '— Select —', icon, isDark,
}) => {
  const [open,        setOpen]        = React.useState(false);
  const [editingItem, setEditingItem] = React.useState(null);
  const [editValue,   setEditValue]   = React.useState('');
  const [saving,      setSaving]      = React.useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const startEdit = (item, e) => {
    e.stopPropagation();
    setEditingItem(item);
    setEditValue(item);
  };

  const commitEdit = async (oldName) => {
    const nv = editValue.trim();
    if (!nv || nv === oldName) { setEditingItem(null); return; }
    setSaving(true);
    try { await onEdit(oldName, nv); } finally { setSaving(false); setEditingItem(null); }
  };

  const handleDelete = async (item, e) => {
    e.stopPropagation();
    if (!window.confirm(`Remove "${item}" from the list?`)) return;
    await onDelete(item);
    if (value === item) onChange('');
  };

  const choose = (v) => { onChange(v); setOpen(false); };

  const displayLabel = value || placeholder;
  const hasValue     = !!value;

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <div
        role="combobox"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && setOpen(o => !o)}
        onClick={() => setOpen(o => !o)}
        className={`h-11 flex items-center gap-2 px-3 rounded-xl border cursor-pointer select-none text-sm transition-colors
          ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 hover:border-slate-500' : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'}`}
      >
        {icon && <span className="text-slate-400 flex-shrink-0">{icon}</span>}
        <span className={`flex-1 truncate ${!hasValue ? (isDark ? 'text-slate-400' : 'text-slate-400') : ''}`}>{displayLabel}</span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </div>

      {/* Panel */}
      {open && (
        <div className={`absolute z-[200] left-0 right-0 mt-1 rounded-xl border shadow-2xl overflow-auto max-h-64
          ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>

          {/* Blank / deselect */}
          <div
            onClick={() => choose('')}
            className={`px-4 py-2.5 text-sm cursor-pointer ${isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-400 hover:bg-slate-50'}`}
          >
            {placeholder}
          </div>

          {/* Static options (e.g. "Our Client") — no edit/delete */}
          {staticOptions.map(opt => (
            <div
              key={opt}
              onClick={() => choose(opt)}
              className={`px-4 py-2.5 text-sm cursor-pointer font-medium flex items-center
                ${value === opt
                  ? (isDark ? 'bg-violet-900/30 text-violet-300' : 'bg-violet-50 text-violet-700')
                  : (isDark ? 'text-slate-200 hover:bg-slate-700' : 'text-slate-700 hover:bg-slate-50')
                }`}
            >
              {opt}
            </div>
          ))}

          {/* Editable options */}
          {options.map(opt => (
            <div
              key={opt}
              className={`flex items-center gap-1 px-3 py-1.5 group
                ${value === opt
                  ? (isDark ? 'bg-violet-900/20' : 'bg-violet-50')
                  : (isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50')
                }`}
            >
              {editingItem === opt ? (
                /* ── Inline edit row ── */
                <div className="flex items-center gap-1 flex-1 py-0.5" onClick={e => e.stopPropagation()}>
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitEdit(opt);
                      if (e.key === 'Escape') setEditingItem(null);
                    }}
                    className={`flex-1 h-7 px-2 rounded-lg text-xs border outline-none
                      ${isDark ? 'bg-slate-600 border-slate-500 text-white' : 'bg-white border-slate-300 text-slate-800'}`}
                  />
                  <button
                    disabled={saving}
                    onClick={() => commitEdit(opt)}
                    className="h-7 px-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {saving ? '…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingItem(null)}
                    className={`h-7 px-2 rounded-lg text-xs font-semibold ${isDark ? 'bg-slate-600 text-slate-300' : 'bg-slate-100 text-slate-500'}`}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <>
                  {/* Option name — click to select */}
                  <span
                    onClick={() => choose(opt)}
                    className={`flex-1 text-sm cursor-pointer truncate py-1
                      ${value === opt
                        ? (isDark ? 'text-violet-300 font-semibold' : 'text-violet-700 font-semibold')
                        : (isDark ? 'text-slate-200' : 'text-slate-700')
                      }`}
                  >
                    {opt}
                  </span>
                  {/* Edit button */}
                  <button
                    onClick={e => startEdit(opt, e)}
                    title="Edit name"
                    className={`h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity
                      ${isDark ? 'text-slate-400 hover:text-blue-300 hover:bg-slate-600' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}
                  >
                    <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current">
                      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25 9.75 4.81 3.569 10.99c-.04.04-.067.084-.078.108l-1.85.528.53-1.851c.024-.082.068-.16.108-.2L11.189 6.25Z"/>
                    </svg>
                  </button>
                  {/* Delete button */}
                  <button
                    onClick={e => handleDelete(opt, e)}
                    title="Delete"
                    className={`h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity
                      ${isDark ? 'text-slate-400 hover:text-red-300 hover:bg-slate-600' : 'text-slate-400 hover:text-red-600 hover:bg-red-50'}`}
                  >
                    <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current">
                      <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
                    </svg>
                  </button>
                </>
              )}
            </div>
          ))}

          {/* "+ Add new" item */}
          <div
            onClick={() => { setOpen(false); onAddNew?.(); }}
            className={`px-4 py-2.5 text-sm cursor-pointer font-semibold border-t
              ${isDark ? 'border-slate-700 text-violet-400 hover:bg-slate-700' : 'border-slate-100 text-violet-600 hover:bg-violet-50'}`}
          >
            + Add new
          </div>
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// BULK AUDITOR DIALOG
// ═══════════════════════════════════════════════════════════════════════════
const BulkAuditorDialog = React.memo(({ open, onClose, filteredClients, savedAuditors, saveAuditor, onBulkSave, isDark }) => {
  const [selectedIds,    setSelectedIds]    = React.useState(new Set());
  const [auditorValue,   setAuditorValue]   = React.useState('');
  const [auditorInput,   setAuditorInput]   = React.useState('');
  const [clientSearch,   setClientSearch]   = React.useState('');
  const [saving,         setSaving]         = React.useState(false);
  const accentGrad = 'linear-gradient(135deg, #4c1d95, #7c3aed)';

  React.useEffect(() => {
    if (open) { setSelectedIds(new Set()); setAuditorValue(''); setAuditorInput(''); setClientSearch(''); }
  }, [open]);

  const displayedClients = React.useMemo(() => {
    const q = clientSearch.toLowerCase();
    return q ? filteredClients.filter(c => (c.company_name || '').toLowerCase().includes(q)) : filteredClients;
  }, [filteredClients, clientSearch]);

  const toggleClient = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => {
    if (displayedClients.every(c => selectedIds.has(c.id))) setSelectedIds(new Set());
    else setSelectedIds(new Set(displayedClients.map(c => c.id)));
  };

  const finalAuditor = auditorValue === '__other__' ? auditorInput.trim() : auditorValue;

  const handleSave = async () => {
    if (!finalAuditor || selectedIds.size === 0) return;
    setSaving(true);
    try {
      if (!savedAuditors.includes(finalAuditor)) await saveAuditor(finalAuditor);
      await onBulkSave([...selectedIds], finalAuditor);
      onClose();
    } finally { setSaving(false); }
  };

  const selectedCount = selectedIds.size;
  const allSelected = displayedClients.length > 0 && displayedClients.every(c => selectedIds.has(c.id));

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col rounded-2xl border border-slate-200 shadow-2xl p-0 bg-white">
        <DialogTitle className="sr-only">Bulk Set Auditor</DialogTitle>
        <div className="flex-shrink-0 px-7 py-5 border-b border-slate-100" style={{ background: 'linear-gradient(135deg, #f5f3ff, #ede9fe)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-sm flex-shrink-0" style={{ background: accentGrad }}>
              <FileCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Bulk Set Auditor</h2>
              <p className="text-xs text-slate-500 mt-0.5">Select clients and assign or update their auditor in one shot</p>
            </div>
            <div className="ml-auto flex-shrink-0">
              <span className="text-xs font-bold px-3 py-1.5 rounded-full border" style={{ background: '#ede9fe', color: '#6d28d9', borderColor: '#ddd6fe' }}>
                {selectedCount} selected
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* LEFT: Client list */}
          <div className={`w-64 flex-shrink-0 border-r flex flex-col ${isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-100 bg-slate-50/40'}`}>
            <div className={`flex items-center gap-1.5 px-3 py-2.5 border-b flex-shrink-0 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
              <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
              <input className={`flex-1 text-xs bg-transparent outline-none placeholder:text-slate-400 ${isDark ? 'text-slate-200' : 'text-slate-700'}`} placeholder="Search clients…" value={clientSearch} onChange={e => setClientSearch(e.target.value)} />
              {clientSearch && <button onClick={() => setClientSearch('')} className="text-slate-300 hover:text-slate-500"><X className="h-3 w-3" /></button>}
            </div>
            <div className={`flex items-center gap-2 px-3 py-2 border-b text-[10px] font-bold uppercase tracking-widest flex-shrink-0 ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-100 text-slate-400'}`}>
              <button onClick={toggleAll} className="flex items-center gap-1.5 hover:text-purple-600 transition-colors">
                {allSelected ? <CheckSquare className="h-3.5 w-3.5 text-purple-600" /> : <Square className="h-3.5 w-3.5" />}
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
              <span className="ml-auto">{displayedClients.length} shown</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {displayedClients.map(c => {
                const checked = selectedIds.has(c.id);
                return (
                  <div key={c.id} onClick={() => toggleClient(c.id)}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b last:border-0 ${isDark ? 'border-slate-700/60' : 'border-slate-50'} ${checked ? (isDark ? 'bg-purple-900/20' : 'bg-purple-50/60') : (isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50')}`}>
                    {checked ? <CheckSquare className="h-3.5 w-3.5 text-purple-600 flex-shrink-0" /> : <Square className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-semibold truncate leading-tight ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{c.company_name}</p>
                      {c.auditor && <p className="text-[9px] text-purple-500 truncate">Current: {c.auditor}</p>}
                    </div>
                  </div>
                );
              })}
              {displayedClients.length === 0 && <div className="flex items-center justify-center h-20 text-xs text-slate-400">No clients found</div>}
            </div>
          </div>

          {/* RIGHT: Auditor picker */}
          <div className="flex-1 flex flex-col overflow-y-auto p-6 space-y-5">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Select Auditor <span className="text-red-400">*</span></label>
              <div className="relative">
                <FileCheck className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none z-10" />
                <select className={`h-11 border focus:border-purple-400 rounded-xl text-sm pl-10 pr-4 w-full appearance-none outline-none transition-colors cursor-pointer ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} value={auditorValue} onChange={e => { setAuditorValue(e.target.value); if (e.target.value !== '__other__') setAuditorInput(''); }}>
                  <option value="">— Choose auditor —</option>
                  {savedAuditors.map(a => <option key={a} value={a}>{a}</option>)}
                  <option value="__other__">+ Add New Auditor</option>
                </select>
              </div>
              {auditorValue === '__other__' && (
                <div className="flex gap-2 mt-2">
                  <input className={`flex-1 h-10 px-3 border focus:border-purple-400 rounded-xl text-sm outline-none transition-colors ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} placeholder="Type new auditor name…" value={auditorInput} onChange={e => setAuditorInput(e.target.value)} autoFocus />
                </div>
              )}
            </div>
            {finalAuditor && selectedCount > 0 && (
              <div className="rounded-xl border p-4" style={{ background: 'linear-gradient(135deg, #f5f3ff, #ede9fe)', borderColor: '#ddd6fe' }}>
                <p className="text-xs font-semibold text-purple-800">
                  ✓ Ready to set <strong>{finalAuditor}</strong> as auditor for <strong>{selectedCount}</strong> client{selectedCount !== 1 ? 's' : ''}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className={`flex-shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
          <button type="button" onClick={onClose} className="h-10 px-4 text-sm rounded-xl text-slate-500 hover:bg-slate-100 transition-colors">Cancel</button>
          <div className="flex items-center gap-2">
            {!finalAuditor && <span className="text-xs text-amber-600 font-medium">← Choose an auditor first</span>}
            {finalAuditor && selectedCount === 0 && <span className="text-xs text-amber-600 font-medium">← Select at least one client</span>}
            <button type="button" disabled={!finalAuditor || selectedCount === 0 || saving} onClick={handleSave}
              className="h-10 px-6 text-sm rounded-xl text-white font-semibold gap-2 shadow-sm disabled:opacity-50 flex items-center"
              style={{ background: (!finalAuditor || selectedCount === 0 || saving) ? '#94a3b8' : accentGrad }}>
              {saving ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-1" /> Saving…</> : <><FileCheck className="h-4 w-4 mr-1" /> Set Auditor {selectedCount > 0 ? `(${selectedCount})` : ''}</>}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
const ModernClientCard = React.memo(({
  onSendBirthdayWish, client, index, isDark, users,
  getClientAssignments, openWhatsApp, handleEdit,
  canDeleteData, canEditClients, onDelete, setSelectedClient, setDetailDialogOpen, getClientNumber,
  isSelected, onToggleSelect,
}) => {
  const cfg            = TYPE_CONFIG[client.client_type] || TYPE_CONFIG.proprietor;
  const avatarGrad     = getAvatarGradient(client.company_name);
  const isArchived     = client.status === 'inactive';
  const primaryContact = client.contact_persons?.find(cp => cp.name?.trim());
  const clientAssignments = getClientAssignments(client);
  const serviceCount   = client.services?.length || 0;
  const today          = new Date();
  const stripeColor    = cfg.strip;
 
  const worstDsc = useMemo(() => {
    if (!client.dsc_details?.length) return null;
    return client.dsc_details.reduce((worst, d) => {
      const days = getDscDaysLeft(d.expiry_date);
      if (days === null) return worst;
      return (worst === null || days < worst) ? days : worst;
    }, null);
  }, [client.dsc_details]);
 
  const hasBirthdayToday = useMemo(() =>
    client.contact_persons?.some(cp => {
      if (!cp?.birthday) return false;
      const bday = new Date(cp.birthday);
      return bday.getMonth() === today.getMonth() && bday.getDate() === today.getDate();
    }) ?? false,
  [client.contact_persons]);
 
  const firstAssignee = useMemo(() => {
    const a = clientAssignments[0];
    if (!a) return null;
    return users.find(x => x.id === a.user_id) || null;
  }, [clientAssignments, users]);
 
  const extraAssignees = clientAssignments.length > 1 ? clientAssignments.length - 1 : 0;
  const svcSlots  = [0, 1, 2].map(i => client.services?.[i]?.replace('Other: ', '') || null);
  const extraSvcs = serviceCount > 3 ? serviceCount - 3 : 0;
  const iconBg    = isDark ? 'rgba(255,255,255,0.07)' : cfg.bg;
 
  const actionBtns = [
    {
      onClick: e => { e.stopPropagation(); openWhatsApp(client.phone, client.company_name); },
      icon: <MessageCircle style={{ width: 12, height: 12 }} />,
      label: 'Chat',
      color: '#16a34a',
      hoverBg: isDark ? 'rgba(34,197,94,0.1)' : '#f0fdf4',
    },
    // Edit button — only shown when user has can_edit_clients permission
    ...(canEditClients ? [{
      onClick: e => { e.stopPropagation(); handleEdit(client); },
      icon: <Edit style={{ width: 12, height: 12 }} />,
      label: 'Edit',
      color: '#2563eb',
      hoverBg: isDark ? 'rgba(59,130,246,0.1)' : '#eff6ff',
    }] : []),
    {
      onClick: e => { e.stopPropagation(); onSendBirthdayWish(client.id, client.company_name); },
      icon: <span style={{ fontSize: 11 }}>🎂</span>,
      label: 'Wish',
      color: '#d97706',
      hoverBg: isDark ? 'rgba(217,119,6,0.1)' : '#fffbeb',
    },
    ...(canDeleteData ? [{
      onClick: e => { e.stopPropagation(); onDelete(client); },
      icon: <Trash2 style={{ width: 12, height: 12 }} />,
      label: 'Del',
      color: '#ef4444',
      hoverBg: isDark ? 'rgba(239,68,68,0.1)' : '#fef2f2',
    }] : []),
  ];
 
  return (
    <motion.div
      variants={cardVariants}
      whileHover={{ y: -3, transition: springPhysics.card }}
      whileTap={{ scale: 0.985 }}
      layout
      className={`relative flex flex-col overflow-hidden cursor-pointer select-none group ${isArchived ? 'opacity-55' : ''}`}
      style={{
        borderRadius: 16,
        background: isDark ? '#1e293b' : '#ffffff',
        border: isSelected
          ? '2px solid #ef4444'
          : `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'}`,
        boxShadow: isSelected
          ? '0 0 0 3px rgba(239,68,68,0.15)'
          : isDark ? '0 2px 8px rgba(0,0,0,0.35)' : '0 1px 4px rgba(0,0,0,0.06)',
      }}
      onClick={() => { if (!isSelected && !onToggleSelect) { setSelectedClient(client); setDetailDialogOpen(true); } else if (!onToggleSelect) { setSelectedClient(client); setDetailDialogOpen(true); } else { setSelectedClient(client); setDetailDialogOpen(true); } }}
    >
      {/* ── VERTICAL LEFT STRIP ── */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, borderRadius: '16px 0 0 16px', background: isSelected ? '#ef4444' : stripeColor }} />
 
      {/* ── BULK SELECT CHECKBOX ── */}
      {canDeleteData && (
        <div
          onClick={e => { e.stopPropagation(); onToggleSelect && onToggleSelect(client.id, e); }}
          className={`absolute top-2 right-2 z-10 w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-all
            ${isSelected ? 'bg-red-500 border-red-500 opacity-100' : 'opacity-0 group-hover:opacity-100 border-slate-300 hover:border-red-400 bg-white/80'}`}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={{
        padding: '12px 14px 10px 18px',
        background: isDark
          ? `linear-gradient(135deg, ${stripeColor}18 0%, transparent 60%)`
          : `linear-gradient(135deg, ${stripeColor}0f 0%, transparent 60%)`,
        borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: avatarGrad,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 16, fontWeight: 900,
              boxShadow: `0 4px 12px ${stripeColor}55`,
            }}>
              {client.company_name?.charAt(0).toUpperCase() || '?'}
            </div>
            {hasBirthdayToday && (
              <div style={{
                position: 'absolute', top: -4, right: -4, width: 16, height: 16,
                background: '#ec4899', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, border: '2px solid #fff',
              }}>🎂</div>
            )}
            {isArchived && (
              <div style={{
                position: 'absolute', bottom: -4, right: -4, width: 14, height: 14,
                background: '#f59e0b', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Archive style={{ width: 8, height: 8, color: '#fff' }} />
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', fontWeight: 700, color: isDark ? '#475569' : '#cbd5e1', flexShrink: 0 }}>
                #{getClientNumber(index)}
              </span>
              <TypePill type={client.client_type} customLabel={client.client_type_label} />
              <DscBadge daysLeft={worstDsc} />
            </div>
            <h3 style={{
              fontSize: 12, fontWeight: 700, lineHeight: 1.35,
              color: isDark ? '#f1f5f9' : '#0f172a',
              overflow: 'hidden', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              wordBreak: 'break-word', minHeight: '2.7em', margin: 0,
            }}>
              {client.company_name}
            </h3>
          </div>
        </div>
      </div>
 
      {/* ── BODY ── */}
      <div style={{ padding: '10px 14px 10px 18px', display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
 
        {/* Contact person */}
        <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <User style={{ width: 11, height: 11, color: stripeColor }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#e2e8f0' : '#1e293b', margin: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', lineHeight: 1.3 }}>
              {primaryContact?.name || <span style={{ color: isDark ? '#475569' : '#cbd5e1', fontStyle: 'italic' }}>No contact</span>}
            </p>
            <p style={{ fontSize: 10, color: isDark ? '#64748b' : '#94a3b8', margin: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', lineHeight: 1.2 }}>
              {primaryContact?.designation || '\u00a0'}
            </p>
          </div>
        </div>
 
        {/* Phone + email */}
        <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 18, height: 18, borderRadius: 5, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Phone style={{ width: 10, height: 10, color: stripeColor }} />
            </div>
            <span
              title={client.phone ? 'Click to copy' : ''}
              onClick={client.phone ? e => { e.stopPropagation(); copyToClipboard(client.phone, 'Phone'); } : undefined}
              style={{ fontSize: 10, fontWeight: 500, color: client.phone ? (isDark ? '#cbd5e1' : '#334155') : (isDark ? '#334155' : '#e2e8f0'), overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: client.phone ? 'copy' : 'default' }}>
              {client.phone || '—'}
            </span>
          </div>
          <div style={{ width: 1, height: 12, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 18, height: 18, borderRadius: 5, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Mail style={{ width: 10, height: 10, color: stripeColor }} />
            </div>
            <span
              title={client.email ? 'Click to copy' : ''}
              onClick={client.email ? e => { e.stopPropagation(); copyToClipboard(client.email, 'Email'); } : undefined}
              style={{ fontSize: 10, color: client.email ? (isDark ? '#94a3b8' : '#475569') : (isDark ? '#334155' : '#e2e8f0'), overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: client.email ? 'copy' : 'default' }}>
              {client.email || '—'}
            </span>
          </div>
        </div>
 
        {/* Services */}
        <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 18, height: 18, borderRadius: 5, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <BarChart3 style={{ width: 10, height: 10, color: stripeColor }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {svcSlots.map((svc, i) => (
              <span key={i} style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 20, flexShrink: 0,
                background: svc ? (isDark ? `${stripeColor}28` : cfg.bg) : 'transparent',
                color: svc ? cfg.text : 'transparent',
                border: `1px solid ${svc ? (isDark ? stripeColor + '45' : cfg.border) : 'transparent'}`,
                whiteSpace: 'nowrap', maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {svc || '·'}
              </span>
            ))}
            {extraSvcs > 0 && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 20, background: isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9', color: '#64748b', flexShrink: 0 }}>
                +{extraSvcs}
              </span>
            )}
            {serviceCount === 0 && (
              <span style={{ fontSize: 10, color: isDark ? '#334155' : '#e2e8f0', fontStyle: 'italic' }}>No services</span>
            )}
          </div>
        </div>
 
        {/* Assignee + referred by */}
        <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 18, height: 18, borderRadius: 5, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Briefcase style={{ width: 10, height: 10, color: stripeColor }} />
            </div>
            <span style={{ fontSize: 10, color: firstAssignee ? (isDark ? '#94a3b8' : '#475569') : (isDark ? '#334155' : '#e2e8f0'), overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              {firstAssignee
                ? <>{firstAssignee.full_name || firstAssignee.name}{extraAssignees > 0 && <span style={{ color: isDark ? '#475569' : '#94a3b8' }}> +{extraAssignees}</span>}</>
                : '—'}
            </span>
          </div>
          {client.referred_by && (
            <>
              <div style={{ width: 1, height: 12, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Share2 style={{ width: 10, height: 10, color: stripeColor }} />
                </div>
                <span style={{ fontSize: 10, color: isDark ? '#64748b' : '#64748b', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {client.referred_by}
                </span>
              </div>
            </>
          )}
          {client.auditor && (
            <>
              <div style={{ width: 1, height: 12, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: isDark ? 'rgba(124,58,237,0.18)' : '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <FileCheck style={{ width: 10, height: 10, color: '#7c3aed' }} />
                </div>
                <span style={{ fontSize: 10, color: isDark ? '#a78bfa' : '#6d28d9', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {client.auditor}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
 
      {/* ── ACTION ROW ── */}
      <div style={{
        borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}`,
        display: 'grid',
        gridTemplateColumns: `repeat(${actionBtns.length}, 1fr)`,
      }}>
        {actionBtns.map((btn, i) => (
          <button
            key={btn.label}
            onClick={btn.onClick}
            style={{
              height: 36,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: btn.color, fontSize: 10, fontWeight: 700,
              borderRight: i < actionBtns.length - 1
                ? `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}`
                : 'none',
              transition: 'background 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = btn.hoverBg; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            {btn.icon}
            {btn.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
})

// ═══════════════════════════════════════════════════════════════════════════
// GST RECONCILIATION EXPORT HELPERS (same format as GSTReconciliation page)
// ═══════════════════════════════════════════════════════════════════════════
const _fmt = n => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const _sumVal = (arr, src) => arr.reduce((s, r) => s + (r[src]?.invoiceValue || 0), 0);
const _sumTax = (arr, src) => arr.reduce((s, r) => { const i = r[src]; return s + (i ? i.igst + i.cgst + i.sgst : 0); }, 0);

async function gstExportPDF(results, company, period) {
  const jsPDF = await getJsPDF();
  const autoTable = await getAutoTable();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const BRAND  = [13, 59, 102];
  const BRAND2 = [31, 111, 178];
  const GREEN  = [16, 185, 129];
  const AMBER  = [245, 158, 11];
  const BLUE   = [59, 130, 246];
  const ROSE   = [239, 68, 68];
  const LGRAY  = [248, 250, 252];
  const GRAY   = [100, 116, 139];
  const DGRAY  = [30, 41, 59];
  const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  function addPageHeader(title, pageColor) {
    doc.setFillColor(...(pageColor || BRAND));
    doc.rect(0, 0, W, 18, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10); doc.setFont('helvetica', 'bold');
    doc.text('GST RECONCILIATION REPORT', 14, 7);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text(company.name || '', 14, 13);
    doc.text(`${period || ''} | Generated: ${dateStr}`, W - 14, 7, { align: 'right' });
    doc.text(`GSTIN: ${company.gstin || ''}`, W - 14, 13, { align: 'right' });
    doc.setTextColor(...DGRAY);
  }

  function sectionHeading(y, text, color, count, value) {
    doc.setFillColor(...(color || BRAND));
    doc.roundedRect(14, y, W - 28, 9, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    doc.text(text, 18, y + 6);
    if (count !== undefined) {
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      doc.text(`${count} invoices  |  ₹${_fmt(value)}`, W - 18, y + 6, { align: 'right' });
    }
    doc.setTextColor(...DGRAY);
    return y + 12;
  }

  // PAGE 1 — COVER + SUMMARY
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, W, 55, 'F');
  doc.setFillColor(...BRAND2);
  doc.triangle(W - 80, 0, W, 0, W, 55, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22); doc.setFont('helvetica', 'bold');
  doc.text('GST Reconciliation Report', 14, 22);
  doc.setFontSize(11); doc.setFont('helvetica', 'normal');
  doc.text(company.name || 'Company Name', 14, 32);
  doc.setFontSize(9);
  const subtitle = [company.gstin ? `GSTIN: ${company.gstin}` : null, period ? `Period: ${period}` : null].filter(Boolean).join('   •   ');
  doc.text(subtitle, 14, 40);
  doc.text(`Generated on ${dateStr}`, 14, 48);

  const cards = [
    { label: 'Total Portal Invoices', val: results.matched.length + results.mismatch.length + results.portalOnly.length, color: BRAND },
    { label: 'Total Books Invoices',  val: results.matched.length + results.mismatch.length + results.booksOnly.length,  color: BRAND2 },
    { label: 'Matched',               val: results.matched.length,    sub: `₹${_fmt(_sumVal(results.matched,'portal'))}`,    color: GREEN },
    { label: 'Amount Mismatch',       val: results.mismatch.length,   sub: `₹${_fmt(_sumVal(results.mismatch,'portal'))}`,   color: AMBER },
    { label: 'In Portal Only',        val: results.portalOnly.length, sub: `₹${_fmt(_sumVal(results.portalOnly,'portal'))}`, color: BLUE  },
    { label: 'In Books Only',         val: results.booksOnly.length,  sub: `₹${_fmt(_sumVal(results.booksOnly,'books'))}`,   color: ROSE  },
  ];
  const cardW = (W - 28 - 10) / 6;
  cards.forEach((card, i) => {
    const x = 14 + i * (cardW + 2); const y = 62;
    doc.setFillColor(...card.color);
    doc.roundedRect(x, y, cardW, 22, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text(String(card.val), x + cardW / 2, y + 10, { align: 'center' });
    doc.setFontSize(6); doc.setFont('helvetica', 'normal');
    doc.text(card.label, x + cardW / 2, y + 15, { align: 'center' });
    if (card.sub) doc.text(card.sub, x + cardW / 2, y + 19.5, { align: 'center' });
  });

  doc.setTextColor(...DGRAY);
  doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('Tax Summary', 14, 96);
  autoTable(doc, {
    startY: 99,
    head: [['Category', 'Invoices', 'Invoice Value (₹)', 'Taxable Value (₹)', 'IGST (₹)', 'CGST (₹)', 'SGST (₹)', 'Total Tax (₹)']],
    body: [
      ['Matched', results.matched.length, _fmt(_sumVal(results.matched,'portal')), _fmt(results.matched.reduce((s,r)=>s+r.portal.taxableValue,0)), _fmt(results.matched.reduce((s,r)=>s+r.portal.igst,0)), _fmt(results.matched.reduce((s,r)=>s+r.portal.cgst,0)), _fmt(results.matched.reduce((s,r)=>s+r.portal.sgst,0)), _fmt(_sumTax(results.matched,'portal'))],
      ['Amount Mismatch', results.mismatch.length, _fmt(_sumVal(results.mismatch,'portal')), _fmt(results.mismatch.reduce((s,r)=>s+r.portal.taxableValue,0)), _fmt(results.mismatch.reduce((s,r)=>s+r.portal.igst,0)), _fmt(results.mismatch.reduce((s,r)=>s+r.portal.cgst,0)), _fmt(results.mismatch.reduce((s,r)=>s+r.portal.sgst,0)), _fmt(_sumTax(results.mismatch,'portal'))],
      ['In Portal Only (Not in Books)', results.portalOnly.length, _fmt(_sumVal(results.portalOnly,'portal')), _fmt(results.portalOnly.reduce((s,r)=>s+r.portal.taxableValue,0)), _fmt(results.portalOnly.reduce((s,r)=>s+r.portal.igst,0)), _fmt(results.portalOnly.reduce((s,r)=>s+r.portal.cgst,0)), _fmt(results.portalOnly.reduce((s,r)=>s+r.portal.sgst,0)), _fmt(_sumTax(results.portalOnly,'portal'))],
      ['In Books Only (ITC Risk)', results.booksOnly.length, _fmt(_sumVal(results.booksOnly,'books')), _fmt(results.booksOnly.reduce((s,r)=>s+r.books.taxableValue,0)), _fmt(results.booksOnly.reduce((s,r)=>s+r.books.igst,0)), _fmt(results.booksOnly.reduce((s,r)=>s+r.books.cgst,0)), _fmt(results.booksOnly.reduce((s,r)=>s+r.books.sgst,0)), _fmt(_sumTax(results.booksOnly,'books'))],
    ],
    headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: LGRAY },
    columnStyles: { 0: { fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
  });

  if (results.matched.length > 0) {
    doc.addPage(); addPageHeader('Matched Invoices', GREEN);
    let y = sectionHeading(22, '✓  Matched Invoices — Present in both GST Portal and Books with matching amounts', GREEN, results.matched.length, _sumVal(results.matched,'portal'));
    autoTable(doc, { startY: y, head: [['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable Value (₹)','IGST (₹)','CGST (₹)','SGST (₹)','Cess (₹)']],
      body: results.matched.map((r,i) => [i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.portal.taxableValue),_fmt(r.portal.igst),_fmt(r.portal.cgst),_fmt(r.portal.sgst),_fmt(r.portal.cess)]),
      headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold', fontSize: 7.5 }, bodyStyles: { fontSize: 7 }, alternateRowStyles: { fillColor: [240,253,244] },
      columnStyles: { 0:{cellWidth:8}, 1:{cellWidth:32}, 2:{cellWidth:36}, 3:{cellWidth:20} }, margin: { left:14, right:14 } });
  }

  if (results.mismatch.length > 0) {
    doc.addPage(); addPageHeader('Amount Mismatch', AMBER);
    let y = sectionHeading(22, '⚠  Amount Mismatch — Invoice found in both but amounts differ', AMBER, results.mismatch.length, _sumVal(results.mismatch,'portal'));
    autoTable(doc, { startY: y, head: [['#','GSTIN','Party Name','Inv No','Date','Portal Value','Books Value','Diff (₹)','Portal Tax','Books Tax','Tax Diff (₹)']],
      body: results.mismatch.map((r,i) => [i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.books.invoiceValue),{content:(r.valueDiff>0?'+':'')+_fmt(r.valueDiff),styles:{textColor:r.valueDiff>0?[37,99,235]:[220,38,38],fontStyle:'bold'}},_fmt(r.portal.igst+r.portal.cgst+r.portal.sgst),_fmt(r.books.igst+r.books.cgst+r.books.sgst),{content:(r.taxDiff>0?'+':'')+_fmt(r.taxDiff),styles:{textColor:r.taxDiff>0?[37,99,235]:[220,38,38],fontStyle:'bold'}}]),
      headStyles: { fillColor: AMBER, textColor: 255, fontStyle: 'bold', fontSize: 7.5 }, bodyStyles: { fontSize: 7 }, alternateRowStyles: { fillColor: [255,251,235] },
      columnStyles: { 0:{cellWidth:8}, 1:{cellWidth:30}, 2:{cellWidth:30} }, margin: { left:14, right:14 } });
  }

  if (results.portalOnly.length > 0) {
    doc.addPage(); addPageHeader('In Portal Only', BLUE);
    let y = sectionHeading(22, '🌐  In GST Portal Only — Vendor uploaded but NOT recorded in Books.', BLUE, results.portalOnly.length, _sumVal(results.portalOnly,'portal'));
    autoTable(doc, { startY: y, head: [['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Place','ITC']],
      body: results.portalOnly.map((r,i) => [i+1,r.portal.gstin,r.portal.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.portal.taxableValue),_fmt(r.portal.igst),_fmt(r.portal.cgst),_fmt(r.portal.sgst),r.portal.placeOfSupply||'—',{content:r.portal.itcAvailability||'—',styles:{textColor:r.portal.itcAvailability?.toLowerCase()==='yes'?[5,150,105]:[100,116,139],fontStyle:'bold'}}]),
      headStyles: { fillColor: BLUE, textColor: 255, fontStyle: 'bold', fontSize: 7.5 }, bodyStyles: { fontSize: 7 }, alternateRowStyles: { fillColor: [239,246,255] },
      columnStyles: { 0:{cellWidth:8}, 1:{cellWidth:30}, 2:{cellWidth:30} }, margin: { left:14, right:14 } });
  }

  if (results.booksOnly.length > 0) {
    doc.addPage(); addPageHeader('In Books Only', ROSE);
    let y = sectionHeading(22, '📒  In Books Only — Recorded in Books but vendor has NOT uploaded to GST Portal. ITC at risk!', ROSE, results.booksOnly.length, _sumVal(results.booksOnly,'books'));
    doc.setFillColor(255,241,242); doc.setDrawColor(...ROSE);
    doc.roundedRect(14, y, W-28, 10, 2, 2, 'FD');
    doc.setTextColor(...ROSE); doc.setFontSize(8); doc.setFont('helvetica','bold');
    doc.text('⚠ ITC RISK: These invoices are in your books but the vendor has not filed them on the GST portal.', 18, y+6.5, { maxWidth: W-36 });
    doc.setTextColor(...DGRAY); y += 14;
    autoTable(doc, { startY: y, head: [['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Place']],
      body: results.booksOnly.map((r,i) => [i+1,r.books.gstin,r.books.tradeOrLegalName||'—',r.books.invoiceNoRaw,r.books.invoiceDate,_fmt(r.books.invoiceValue),_fmt(r.books.taxableValue),_fmt(r.books.igst),_fmt(r.books.cgst),_fmt(r.books.sgst),r.books.placeOfSupply||'—']),
      headStyles: { fillColor: ROSE, textColor: 255, fontStyle: 'bold', fontSize: 7.5 }, bodyStyles: { fontSize: 7 }, alternateRowStyles: { fillColor: [255,241,242] },
      columnStyles: { 0:{cellWidth:8}, 1:{cellWidth:30}, 2:{cellWidth:28} }, margin: { left:14, right:14 } });
  }

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p); doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...GRAY);
    doc.text(`Page ${p} of ${totalPages}`, W/2, doc.internal.pageSize.getHeight()-5, { align:'center' });
    doc.text('Confidential — GST Reconciliation Report', 14, doc.internal.pageSize.getHeight()-5);
    doc.text(company.name||'', W-14, doc.internal.pageSize.getHeight()-5, { align:'right' });
  }
  const fname = `GST_Recon_${(company.name||'Report').replace(/\s+/g,'_')}_${period?period.replace(/\s+/g,'_'):'Export'}.pdf`;
  doc.save(fname);
  toast.success('PDF report downloaded successfully!');
}

function gstExportWord(results, company, period) {
  const dateStr = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' });
  const rowsHtml = (headers, rows, headBg='#0D3B66') => `
    <table style="border-collapse:collapse;width:100%;font-size:9pt;margin-bottom:14pt;">
      <thead><tr>${headers.map(h=>`<th style="background:${headBg};color:#fff;padding:5pt 7pt;border:1px solid #cbd5e1;text-align:left;font-weight:bold;white-space:nowrap;">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row,ri)=>`<tr style="background:${ri%2===0?'#f8fafc':'#fff'};"><br>${row.map(cell=>{const val=typeof cell==='object'?cell.v:cell;const style=typeof cell==='object'?`color:${cell.c};font-weight:bold;`:'';return`<td style="padding:4pt 7pt;border:1px solid #e2e8f0;${style}">${val??''}</td>`}).join('')}</tr>`).join('')}</tbody>
    </table>`;
  const section=(title,badgeBg,rows,total,description,tableHtml)=>`
    <div style="page-break-before:always;">
      <div style="background:${badgeBg};color:#fff;padding:10pt 14pt;border-radius:4pt;margin-bottom:10pt;">
        <span style="font-size:13pt;font-weight:bold;">${title}</span>
        <span style="float:right;font-size:10pt;">${rows.length} invoices &nbsp;|&nbsp; ₹${_fmt(total)}</span>
      </div>
      ${description?`<p style="background:#f1f5f9;border-left:4pt solid ${badgeBg};padding:8pt 12pt;font-size:9pt;color:#475569;margin-bottom:10pt;">${description}</p>`:''}
      ${tableHtml}
    </div>`;

  const matchedSec = results.matched.length===0?'':section('✓  Matched Invoices','#10b981',results.matched,_sumVal(results.matched,'portal'),'Present in both GST Portal and Books with matching amounts.',rowsHtml(['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Cess'],results.matched.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.portal.taxableValue),_fmt(r.portal.igst),_fmt(r.portal.cgst),_fmt(r.portal.sgst),_fmt(r.portal.cess)]),'#10b981'));
  const mismatchSec = results.mismatch.length===0?'':section('⚠  Amount Mismatch','#f59e0b',results.mismatch,_sumVal(results.mismatch,'portal'),'Invoice numbers match but amounts differ. Please verify and correct.',rowsHtml(['#','GSTIN','Party Name','Invoice No','Date','Portal Value','Books Value','Diff (₹)','Portal Tax','Books Tax','Tax Diff (₹)'],results.mismatch.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.books.invoiceValue),{v:(r.valueDiff>0?'+':'')+_fmt(r.valueDiff),c:r.valueDiff>0?'#1d4ed8':'#dc2626'},_fmt(r.portal.igst+r.portal.cgst+r.portal.sgst),_fmt(r.books.igst+r.books.cgst+r.books.sgst),{v:(r.taxDiff>0?'+':'')+_fmt(r.taxDiff),c:r.taxDiff>0?'#1d4ed8':'#dc2626'}]),'#f59e0b'));
  const portalSec = results.portalOnly.length===0?'':section('🌐  In GST Portal Only','#3b82f6',results.portalOnly,_sumVal(results.portalOnly,'portal'),'Vendor filed on portal but NOT in Books. Book these to avail ITC.',rowsHtml(['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Place','ITC'],results.portalOnly.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||'—',r.portal.invoiceNoRaw,r.portal.invoiceDate,_fmt(r.portal.invoiceValue),_fmt(r.portal.taxableValue),_fmt(r.portal.igst),_fmt(r.portal.cgst),_fmt(r.portal.sgst),r.portal.placeOfSupply||'—',{v:r.portal.itcAvailability||'—',c:r.portal.itcAvailability?.toLowerCase()==='yes'?'#059669':'#64748b'}]),'#3b82f6'));
  const booksSec = results.booksOnly.length===0?'':section('📒  In Books Only (ITC Risk)','#ef4444',results.booksOnly,_sumVal(results.booksOnly,'books'),'⚠ ITC RISK: In Books but vendor has NOT uploaded to GST Portal. Follow up immediately.',rowsHtml(['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Place'],results.booksOnly.map((r,i)=>[i+1,r.books.gstin,r.books.tradeOrLegalName||'—',r.books.invoiceNoRaw,r.books.invoiceDate,_fmt(r.books.invoiceValue),_fmt(r.books.taxableValue),_fmt(r.books.igst),_fmt(r.books.cgst),_fmt(r.books.sgst),r.books.placeOfSupply||'—']),'#ef4444'));

  const totalPortal = results.matched.length+results.mismatch.length+results.portalOnly.length;
  const totalBooks  = results.matched.length+results.mismatch.length+results.booksOnly.length;
  const html = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><title>GST Reconciliation Report</title><style>@page{size:A4 landscape;margin:2cm 1.5cm;}body{font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#1e293b;margin:0;}h1{font-size:22pt;color:#0D3B66;margin-bottom:4pt;}h2{font-size:14pt;color:#0D3B66;margin:16pt 0 8pt;}table{border-collapse:collapse;width:100%;font-size:9pt;margin-bottom:14pt;}th{background:#0D3B66;color:#fff;padding:5pt 7pt;border:1px solid #cbd5e1;text-align:left;font-weight:bold;}td{padding:4pt 7pt;border:1px solid #e2e8f0;}</style></head><body>
  <div style="background:#0D3B66;color:#fff;padding:20pt 24pt;margin-bottom:20pt;"><h1 style="color:#fff;margin:0 0 6pt;">GST Reconciliation Report</h1><p style="margin:0;font-size:12pt;">${company.name||''}</p><p style="margin:4pt 0 0;font-size:9pt;opacity:0.85;">${company.gstin?`GSTIN: ${company.gstin}  |  `:''} ${period?`Period: ${period}  |  `:''} Generated: ${dateStr}</p></div>
  <h2>Summary</h2>
  <table><thead><tr><th>Category</th><th>Invoices</th><th>Invoice Value (₹)</th><th>Taxable Value (₹)</th><th>IGST (₹)</th><th>CGST (₹)</th><th>SGST (₹)</th><th>Total Tax (₹)</th></tr></thead>
  <tbody>
  <tr style="background:#f0fdf4;"><td style="font-weight:bold;color:#059669;">✓ Matched</td><td style="text-align:center;">${results.matched.length}</td><td>₹${_fmt(_sumVal(results.matched,'portal'))}</td><td>₹${_fmt(results.matched.reduce((s,r)=>s+r.portal.taxableValue,0))}</td><td>₹${_fmt(results.matched.reduce((s,r)=>s+r.portal.igst,0))}</td><td>₹${_fmt(results.matched.reduce((s,r)=>s+r.portal.cgst,0))}</td><td>₹${_fmt(results.matched.reduce((s,r)=>s+r.portal.sgst,0))}</td><td style="font-weight:bold;">₹${_fmt(_sumTax(results.matched,'portal'))}</td></tr>
  <tr style="background:#fffbeb;"><td style="font-weight:bold;color:#d97706;">⚠ Amount Mismatch</td><td style="text-align:center;">${results.mismatch.length}</td><td>₹${_fmt(_sumVal(results.mismatch,'portal'))}</td><td>₹${_fmt(results.mismatch.reduce((s,r)=>s+r.portal.taxableValue,0))}</td><td>₹${_fmt(results.mismatch.reduce((s,r)=>s+r.portal.igst,0))}</td><td>₹${_fmt(results.mismatch.reduce((s,r)=>s+r.portal.cgst,0))}</td><td>₹${_fmt(results.mismatch.reduce((s,r)=>s+r.portal.sgst,0))}</td><td style="font-weight:bold;">₹${_fmt(_sumTax(results.mismatch,'portal'))}</td></tr>
  <tr style="background:#eff6ff;"><td style="font-weight:bold;color:#2563eb;">🌐 In Portal Only</td><td style="text-align:center;">${results.portalOnly.length}</td><td>₹${_fmt(_sumVal(results.portalOnly,'portal'))}</td><td>₹${_fmt(results.portalOnly.reduce((s,r)=>s+r.portal.taxableValue,0))}</td><td>₹${_fmt(results.portalOnly.reduce((s,r)=>s+r.portal.igst,0))}</td><td>₹${_fmt(results.portalOnly.reduce((s,r)=>s+r.portal.cgst,0))}</td><td>₹${_fmt(results.portalOnly.reduce((s,r)=>s+r.portal.sgst,0))}</td><td style="font-weight:bold;">₹${_fmt(_sumTax(results.portalOnly,'portal'))}</td></tr>
  <tr style="background:#fff1f2;"><td style="font-weight:bold;color:#dc2626;">📒 In Books Only</td><td style="text-align:center;">${results.booksOnly.length}</td><td>₹${_fmt(_sumVal(results.booksOnly,'books'))}</td><td>₹${_fmt(results.booksOnly.reduce((s,r)=>s+r.books.taxableValue,0))}</td><td>₹${_fmt(results.booksOnly.reduce((s,r)=>s+r.books.igst,0))}</td><td>₹${_fmt(results.booksOnly.reduce((s,r)=>s+r.books.cgst,0))}</td><td>₹${_fmt(results.booksOnly.reduce((s,r)=>s+r.books.sgst,0))}</td><td style="font-weight:bold;">₹${_fmt(_sumTax(results.booksOnly,'books'))}</td></tr>
  </tbody></table>
  <p style="font-size:8pt;color:#64748b;">Total Portal: <strong>${totalPortal}</strong> &nbsp;|&nbsp; Total Books: <strong>${totalBooks}</strong></p>
  ${matchedSec}${mismatchSec}${portalSec}${booksSec}
  <div style="margin-top:20pt;border-top:1px solid #e2e8f0;padding-top:8pt;font-size:8pt;color:#64748b;"><p>Report generated by TaskOsphere | ${dateStr} | ${company.name||''} | GSTIN: ${company.gstin||''}</p></div>
  </body></html>`;
  const blob = new Blob(['\ufeff', html], { type:'application/msword;charset=utf-8' });
  const fname = `GST_Recon_${(company.name||'Report').replace(/\s+/g,'_')}_${period?period.replace(/\s+/g,'_'):'Export'}.doc`;
  saveAs(blob, fname);
  toast.success('Word document downloaded successfully!');
}

async function gstExportExcel(results, company, period) {
  const XLSX = await getXLSX();
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    ['GST Reconciliation Report','','',company.name||''],
    ['GSTIN',company.gstin||'','PAN',company.pan||''],
    ['Period',period||'','FY',company.fy||''],
    ['Generated On',new Date().toLocaleDateString('en-IN')],
    [],
    ['Category','Count','Invoice Value (₹)','Total Tax (₹)'],
    ['Matched',          results.matched.length,    _sumVal(results.matched,'portal').toFixed(2),    _sumTax(results.matched,'portal').toFixed(2)],
    ['Amount Mismatch',  results.mismatch.length,   _sumVal(results.mismatch,'portal').toFixed(2),   _sumTax(results.mismatch,'portal').toFixed(2)],
    ['In Portal Only',   results.portalOnly.length, _sumVal(results.portalOnly,'portal').toFixed(2), _sumTax(results.portalOnly,'portal').toFixed(2)],
    ['In Books Only',    results.booksOnly.length,  _sumVal(results.booksOnly,'books').toFixed(2),   _sumTax(results.booksOnly,'books').toFixed(2)],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#','GSTIN','Party Name','Invoice No','Date','Invoice Value (₹)','Taxable (₹)','IGST','CGST','SGST','Cess'],...results.matched.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'',r.portal.invoiceNoRaw,r.portal.invoiceDate,r.portal.invoiceValue,r.portal.taxableValue,r.portal.igst,r.portal.cgst,r.portal.sgst,r.portal.cess])]), 'Matched');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#','GSTIN','Party Name','Invoice No','Date','Portal Value','Books Value','Value Diff','Portal Tax','Books Tax','Tax Diff'],...results.mismatch.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||r.books?.tradeOrLegalName||'',r.portal.invoiceNoRaw,r.portal.invoiceDate,r.portal.invoiceValue,r.books.invoiceValue,r.valueDiff.toFixed(2),(r.portal.igst+r.portal.cgst+r.portal.sgst).toFixed(2),(r.books.igst+r.books.cgst+r.books.sgst).toFixed(2),r.taxDiff.toFixed(2)])]), 'Mismatch');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#','GSTIN','Party Name','Invoice No','Date','Invoice Value','Taxable','IGST','CGST','SGST','Place','ITC'],...results.portalOnly.map((r,i)=>[i+1,r.portal.gstin,r.portal.tradeOrLegalName||'',r.portal.invoiceNoRaw,r.portal.invoiceDate,r.portal.invoiceValue,r.portal.taxableValue,r.portal.igst,r.portal.cgst,r.portal.sgst,r.portal.placeOfSupply,r.portal.itcAvailability])]), 'In Portal Only');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#','GSTIN','Party Name','Invoice No','Date','Invoice Value','Taxable','IGST','CGST','SGST','Cess','Place'],...results.booksOnly.map((r,i)=>[i+1,r.books.gstin,r.books.tradeOrLegalName||'',r.books.invoiceNoRaw,r.books.invoiceDate,r.books.invoiceValue,r.books.taxableValue,r.books.igst,r.books.cgst,r.books.sgst,r.books.cess,r.books.placeOfSupply])]), 'In Books Only');
  XLSX.writeFile(wb, `GST_Recon_${(company.name||'Report').replace(/\s+/g,'_')}_${period?period.replace(/\s+/g,'_'):'Export'}.xlsx`);
  toast.success('Excel report downloaded successfully!');
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT DETAIL POPUP — lifted outside so it never re-creates on render
// ═══════════════════════════════════════════════════════════════════════════
const GST_TREATMENT_LABELS = { regular: 'Regular Taxpayer', composition: 'Composition Scheme', unregistered: 'Unregistered', consumer: 'Consumer (B2C)', overseas: 'Overseas / SEZ' };
const INV_STATUS_COLORS = { paid: { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0' }, sent: { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' }, draft: { bg: '#f8fafc', text: '#475569', border: '#e2e8f0' }, overdue: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' }, partially_paid: { bg: '#fefce8', text: '#92400e', border: '#fde68a' }, cancelled: { bg: '#fafafa', text: '#9ca3af', border: '#e5e7eb' } };

const ClientDetailPopup = React.memo(({ selectedClient, detailDialogOpen, setDetailDialogOpen, isDark, users, getClientAssignments, openWhatsApp, handleEdit, canEditClients, navigate, allClients = [], onMergeClients }) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [activeTab, setActiveTab] = React.useState('details');

  // ── Merge tab state ────────────────────────────────────────────────────────
  const [mergeSearch,      setMergeSearch]      = React.useState('');
  const [mergeTargetId,    setMergeTargetId]    = React.useState(null);
  const [mergeFieldChoice, setMergeFieldChoice] = React.useState({}); // { field: 'primary' | 'secondary' }
  const [mergeLoading,     setMergeLoading]     = React.useState(false);

  const MERGE_FIELDS_DEF = [
    { key: 'email',       label: 'Email' },
    { key: 'phone',       label: 'Phone' },
    { key: 'address',     label: 'Address' },
    { key: 'city',        label: 'City' },
    { key: 'state',       label: 'State' },
    { key: 'gstin',       label: 'GSTIN' },
    { key: 'pan',         label: 'PAN' },
    { key: 'website',     label: 'Website' },
    { key: 'referred_by', label: 'Referred By' },
    { key: 'cin',         label: 'CIN' },
    { key: 'notes',       label: 'Notes' },
  ];

  // Merge search: hit the server so the full 1000-client list never blocks the UI
  const [mergeCandidates, setMergeCandidates] = React.useState([]);
  const [mergeSearching, setMergeSearching] = React.useState(false);
  const mergeSearchTimerRef = React.useRef(null);

  React.useEffect(() => {
    if (!mergeSearch.trim()) { setMergeCandidates([]); return; }
    clearTimeout(mergeSearchTimerRef.current);
    mergeSearchTimerRef.current = setTimeout(async () => {
      setMergeSearching(true);
      try {
        const r = await api.get('/clients/search', { params: { q: mergeSearch.trim(), limit: 30 } });
        setMergeCandidates((r.data || []).filter(c => c.id !== selectedClient?.id));
      } catch { /* silently ignore */ }
      finally { setMergeSearching(false); }
    }, 250); // 250 ms debounce
    return () => clearTimeout(mergeSearchTimerRef.current);
  }, [mergeSearch, selectedClient]);

  // mergeTarget comes from local state once user picks (fetched above)
  const [mergeTargetFull, setMergeTargetFull] = React.useState(null);
  React.useEffect(() => {
    if (!mergeTargetId) { setMergeTargetFull(null); return; }
    // Try local cache first (already fetched clients list)
    const cached = allClients.find(c => c.id === mergeTargetId);
    if (cached) { setMergeTargetFull(cached); return; }
    // Fallback: fetch individually
    api.get(`/clients/${mergeTargetId}`).then(r => setMergeTargetFull(r.data)).catch(() => {});
  }, [mergeTargetId, allClients]);

  const mergeTarget = mergeTargetFull;

  // Fields that differ between primary and target
  const mergeConflicts = React.useMemo(() => {
    if (!selectedClient || !mergeTarget) return [];
    return MERGE_FIELDS_DEF.filter(f => {
      const pv = (selectedClient[f.key] || '').toString().trim();
      const tv = (mergeTarget[f.key] || '').toString().trim();
      return tv && tv !== pv;
    });
  }, [selectedClient, mergeTarget]);

  // Build field overrides from choices
  const buildOverrides = React.useCallback(() => {
    const overrides = {};
    mergeConflicts.forEach(f => {
      if (mergeFieldChoice[f.key] === 'secondary' && mergeTarget) {
        overrides[f.key] = mergeTarget[f.key];
      }
    });
    return overrides;
  }, [mergeConflicts, mergeFieldChoice, mergeTarget]);

  // Reset merge state when dialog closes or client changes
  React.useEffect(() => {
    setMergeSearch('');
    setMergeTargetId(null);
    setMergeFieldChoice({});
  }, [selectedClient?.id]);
  const [clientInvoices, setClientInvoices] = React.useState([]);
  const [invoicesLoading, setInvoicesLoading] = React.useState(false);
  const [clientPurchaseInvoices, setClientPurchaseInvoices] = React.useState([]);
  const [purchaseLoading, setPurchaseLoading] = React.useState(false);

  // ── Assign Task tab state ──
  const TASK_EMPTY = { title: '', description: '', assigned_to: 'unassigned', sub_assignees: [], due_date: '', priority: 'medium', status: 'pending', category: 'other', is_recurring: false, recurrence_pattern: 'monthly', recurrence_interval: 1 };
  const [taskForm, setTaskForm] = React.useState({ ...TASK_EMPTY });
  const [taskSaving, setTaskSaving] = React.useState(false);
  const [clientTasks, setClientTasks] = React.useState([]);
  const [clientTasksLoading, setClientTasksLoading] = React.useState(false);

  const fetchClientTasks = React.useCallback(async () => {
    if (!selectedClient?.id) return;
    setClientTasksLoading(true);
    try {
      const r = await api.get('/tasks', { params: { client_id: selectedClient.id, page_size: 50 } });
      setClientTasks(r.data?.tasks || r.data || []);
    } catch { setClientTasks([]); }
    finally { setClientTasksLoading(false); }
  }, [selectedClient?.id]);

  React.useEffect(() => {
    if (activeTab !== 'tasks' || !selectedClient?.id) return;
    fetchClientTasks();
  }, [activeTab, selectedClient, fetchClientTasks]);

  const handleTaskSubmit = async () => {
    if (!taskForm.title.trim()) { toast.error('Task title is required'); return; }
    setTaskSaving(true);
    try {
      const payload = {
        ...taskForm,
        assigned_to: taskForm.assigned_to === 'unassigned' ? null : taskForm.assigned_to,
        client_id: selectedClient.id,
        due_date: taskForm.due_date || null,
      };
      await api.post('/tasks', payload);
      toast.success('Task assigned successfully!');
      setTaskForm({ ...TASK_EMPTY });
      fetchClientTasks();
    } catch { toast.error('Failed to assign task'); }
    finally { setTaskSaving(false); }
  };

  // Portal access state
  const [portalUsers, setPortalUsers] = React.useState([]);
  const [portalLoading, setPortalLoading] = React.useState(false);
  const [showPortalManager, setShowPortalManager] = React.useState(false);

  // GST Reconciliation sessions for this client
  const [gstSessions,    setGstSessions]    = React.useState([]);
  const [gstLoading,     setGstLoading]     = React.useState(false);
  const [gstDeleting,    setGstDeleting]    = React.useState(null);
  const [gstDownloading, setGstDownloading] = React.useState(null); // sessionId + format

  // Govt Fees tab — compliance items flagged as govt_fees, joined per client
  const [govtFees,         setGovtFees]         = React.useState([]);
  const [govtFeesLoading,  setGovtFeesLoading]  = React.useState(false);
  const [govtFeesSavingId, setGovtFeesSavingId] = React.useState(null);
  const [govtFeesDraft,    setGovtFeesDraft]    = React.useState({}); // { assignment_id: { amount, notes } }

  // Standalone (ad-hoc) govt fees for this client
  const [adhocFees,        setAdhocFees]        = React.useState([]);
  const [adhocFeesLoading, setAdhocFeesLoading] = React.useState(false);
  const [showAdhocDialog,  setShowAdhocDialog]  = React.useState(false);
  const [editingAdhoc,     setEditingAdhoc]     = React.useState(null);

  const fetchAdhocFees = React.useCallback(async () => {
    if (!selectedClient?.id) return;
    setAdhocFeesLoading(true);
    try {
      const r = await api.get('/compliance/standalone-govt-fees', {
        params: { client_id: selectedClient.id },
      });
      setAdhocFees(r.data?.items || []);
    } catch {
      setAdhocFees([]);
    } finally {
      setAdhocFeesLoading(false);
    }
  }, [selectedClient?.id]);

  React.useEffect(() => {
    setActiveTab('details');
    setClientInvoices([]);
    setClientPurchaseInvoices([]);
    setGstSessions([]);
    setGovtFees([]);
    setGovtFeesDraft({});
    setAdhocFees([]);
    setEditingAdhoc(null);
    setShowAdhocDialog(false);
    setPortalUsers([]);
    setShowPortalManager(false);
    setTaskForm({ title: '', description: '', assigned_to: 'unassigned', sub_assignees: [], due_date: '', priority: 'medium', status: 'pending', category: 'other', is_recurring: false, recurrence_pattern: 'monthly', recurrence_interval: 1 });
    setClientTasks([]);
  }, [selectedClient?.id]);

  React.useEffect(() => {
    if (activeTab !== 'invoices' || !selectedClient) return;
    setInvoicesLoading(true);
    api.get('/invoices', { params: { search: selectedClient.company_name, page_size: 100 } })
      .then(r => {
        const all = r.data?.invoices || [];
        setClientInvoices(all.filter(inv =>
          inv.client_id === selectedClient.id ||
          inv.client_name?.toLowerCase() === selectedClient.company_name?.toLowerCase()
        ));
      })
      .catch(() => {})
      .finally(() => setInvoicesLoading(false));
  }, [activeTab, selectedClient]);

  React.useEffect(() => {
    if (activeTab !== 'purchases' || !selectedClient?.id) return;
    setPurchaseLoading(true);
    api.get('/purchase-invoices', { params: { client_id: selectedClient.id, page_size: 100 } })
      .then(r => setClientPurchaseInvoices(r.data?.purchase_invoices || []))
      .catch(() => setClientPurchaseInvoices([]))
      .finally(() => setPurchaseLoading(false));
  }, [activeTab, selectedClient]);

  // Fetch GST reconciliation sessions for this client
  React.useEffect(() => {
    if (activeTab !== 'reconciliation' || !selectedClient) return;
    setGstLoading(true);
    const params = selectedClient.id
      ? { client_id: selectedClient.id, limit: 50 }
      : { client_name: selectedClient.company_name, limit: 50 };
    api.get('/gst-reconciliation/history', { params })
      .then(r => setGstSessions(r.data?.sessions || []))
      .catch(() => setGstSessions([]))
      .finally(() => setGstLoading(false));
  }, [activeTab, selectedClient]);

  // Fetch Govt-Fees compliance assignments for this client
  const loadGovtFees = React.useCallback(() => {
    if (!selectedClient?.id) return;
    setGovtFeesLoading(true);
    api.get(`/compliance/by-client/${selectedClient.id}`, { params: { govt_fees: true } })
      .then(r => {
        const items = r.data?.items || [];
        setGovtFees(items);
        const d = {};
        items.forEach(it => {
          d[it.assignment_id] = {
            amount: it.govt_fees_amount ?? 0,
            notes:  it.govt_fees_notes  ?? '',
            srn:    it.govt_fees_srn    ?? '',
            bill_in_next_cycle: !!it.bill_in_next_cycle,
          };
        });
        setGovtFeesDraft(d);
      })
      .catch(() => setGovtFees([]))
      .finally(() => setGovtFeesLoading(false));
  }, [selectedClient]);

  React.useEffect(() => {
    if (activeTab !== 'govtfees' || !selectedClient?.id) return;
    loadGovtFees();
    fetchAdhocFees();
  }, [activeTab, selectedClient, fetchAdhocFees, loadGovtFees]);

  // Live-update: re-fetch when the Compliance page (or any other surface) saves a govt-fee row.
  React.useEffect(() => {
    if (activeTab !== 'govtfees' || !selectedClient?.id) return;
    const handler = () => { loadGovtFees(); fetchAdhocFees(); };
    window.addEventListener('compliance:govt-fee-updated', handler);
    return () => window.removeEventListener('compliance:govt-fee-updated', handler);
  }, [activeTab, selectedClient, loadGovtFees, fetchAdhocFees]);


  // Fetch portal users for this client
  React.useEffect(() => {
    if (activeTab !== 'portal' || !selectedClient?.id) return;
    setPortalLoading(true);
    api.get('/client-portal/users', { params: { client_id: selectedClient.id } })
      .then(r => setPortalUsers(r.data || []))
      .catch(() => setPortalUsers([]))
      .finally(() => setPortalLoading(false));
  }, [activeTab, selectedClient]);

  const saveGovtFee = async (item) => {
    const draft = govtFeesDraft[item.assignment_id] || {};
    setGovtFeesSavingId(item.assignment_id);
    try {
      await api.patch(
        `/compliance/${item.compliance_id}/assignments/${item.assignment_id}/govt-fee`,
        {
          govt_fees_amount: parseFloat(draft.amount) || 0,
          govt_fees_notes: draft.notes || '',
          govt_fees_srn: draft.srn || '',
          bill_in_next_cycle: !!draft.bill_in_next_cycle,
        }
      );
      setGovtFees(prev => prev.map(x =>
        x.assignment_id === item.assignment_id
          ? {
              ...x,
              govt_fees_amount: parseFloat(draft.amount) || 0,
              govt_fees_notes: draft.notes || '',
              govt_fees_srn: draft.srn || '',
              bill_in_next_cycle: !!draft.bill_in_next_cycle,
            }
          : x
      ));
      toast.success('Government fee saved');
    } catch {
      toast.error('Failed to save fee');
    } finally {
      setGovtFeesSavingId(null);
    }
  };

  const handleDeleteGstSession = async (sessionId) => {
    if (!window.confirm('Delete this reconciliation record?')) return;
    setGstDeleting(sessionId);
    try {
      await api.delete(`/gst-reconciliation/history/${sessionId}`);
      setGstSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch { /* silent */ }
    setGstDeleting(null);
  };

  const downloadGstFull = async (session, format) => {
    const key = `${session.id}_${format}`;
    setGstDownloading(key);
    try {
      // Fetch full session data (includes matched/mismatch/portalOnly/booksOnly arrays)
      const r = await api.get(`/gst-reconciliation/history/${session.id}`);
      const full = r.data;
      const results = {
        matched:    full.matched    || full.full_result?.matched    || [],
        mismatch:   full.mismatch   || full.full_result?.mismatch   || [],
        portalOnly: full.portal_only|| full.full_result?.portal_only|| [],
        booksOnly:  full.books_only || full.full_result?.books_only || [],
      };
      const company = {
        name:  full.client_name  || session.client_name  || '',
        gstin: full.client_gstin || session.client_gstin || '',
      };
      const period = full.period || session.period || '';
      if (format === 'pdf')   await gstExportPDF(results, company, period);
      if (format === 'word')  gstExportWord(results, company, period);
      if (format === 'excel') await gstExportExcel(results, company, period);
    } catch (err) {
      toast.error('Failed to fetch full report data. Please try again.');
    } finally {
      setGstDownloading(null);
    }
  };

  if (!selectedClient) return null;
  const cfg = TYPE_CONFIG[selectedClient.client_type] || TYPE_CONFIG.proprietor;
  const avatarGrad = getAvatarGradient(selectedClient.company_name);
  const clientAssignments = getClientAssignments(selectedClient);
  const hasTaxInfo = selectedClient.gstin || selectedClient.pan || selectedClient.gst_treatment || selectedClient.website || selectedClient.msme_number || selectedClient.credit_limit || selectedClient.opening_balance || selectedClient.tally_ledger_name;
  const totalInvValue = clientInvoices.reduce((s, i) => s + (i.grand_total || 0), 0);
  const totalOutstanding = clientInvoices.reduce((s, i) => s + (i.amount_due || 0), 0);
  const totalPurchaseValue = clientPurchaseInvoices.reduce((s, i) => s + (i.grand_total || 0), 0);
  const totalPurchaseGst = clientPurchaseInvoices.reduce((s, i) => s + (i.total_gst || 0), 0);

  return (
    <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
      <DialogContent className={`max-w-4xl max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
        <DialogTitle className="sr-only">Client Details</DialogTitle>
        <DialogDescription className="sr-only">View complete client information</DialogDescription>

        {/* ── Header ── */}
        <div className="sticky top-0 z-10 pt-6 px-8 pb-6 border-b border-slate-100" style={{ background: `linear-gradient(135deg, ${cfg.bg}, white)` }}>
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-2xl font-bold flex-shrink-0 shadow-md" style={{ background: avatarGrad }}>{selectedClient.company_name?.charAt(0).toUpperCase() || '?'}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <h2 className={`text-2xl font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.company_name}</h2>
                <TypePill type={selectedClient.client_type} customLabel={selectedClient.client_type_label} />
                {selectedClient.status === 'inactive' && <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">Archived</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {selectedClient.birthday && <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 bg-white/70 border border-slate-200 px-2.5 py-1 rounded-full"><Calendar className="h-3 w-3" />Incorporated: {format(new Date(selectedClient.birthday), 'MMM d, yyyy')}</span>}
                {selectedClient.created_at && <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 bg-white/70 border border-slate-200 px-2.5 py-1 rounded-full"><Calendar className="h-3 w-3" />Added: {format(new Date(selectedClient.created_at), 'MMM d, yyyy')}</span>}
                {selectedClient.referred_by && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-full">
                    <Share2 className="h-3 w-3" />Referred by: {selectedClient.referred_by}
                  </span>
                )}
                {selectedClient.city && <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 bg-white/70 border border-slate-200 px-2.5 py-1 rounded-full"><MapPin className="h-3 w-3" />{[selectedClient.city, selectedClient.state].filter(Boolean).join(', ')}</span>}
                {selectedClient.gstin && <span className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-600 bg-white/70 border border-slate-200 px-2.5 py-1 rounded-full">GSTIN: {selectedClient.gstin}</span>}
                <ClientWAAutoSend client={selectedClient} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Tab Bar ── */}
        <div className={`flex items-center gap-1 px-8 py-2.5 border-b flex-shrink-0 overflow-x-auto scrollbar-none ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
          {[
            { key: 'details',        label: 'Details',     icon: <User className="h-3.5 w-3.5" /> },
            { key: 'invoices',       label: 'Invoices',    icon: <FileText className="h-3.5 w-3.5" /> },
            { key: 'purchases',      label: 'Purchases',   icon: <IndianRupee className="h-3.5 w-3.5" /> },
            { key: 'reconciliation', label: 'GST Recon',   icon: <ArrowLeftRight className="h-3.5 w-3.5" /> },
            { key: 'govtfees',       label: 'Govt Fees',   icon: <IndianRupee className="h-3.5 w-3.5" /> },
            { key: 'portal',         label: 'Portal',      icon: <Globe className="h-3.5 w-3.5" /> },
            { key: 'renewals',       label: 'Renewals',    icon: <CalendarClock className="h-3.5 w-3.5" /> },
            { key: 'tasks',          label: 'Assign Task', icon: <CheckSquare className="h-3.5 w-3.5" /> },
            ...(canEditClients ? [{ key: 'merge', label: 'Merge', icon: <Merge className="h-3.5 w-3.5" />, accent: '#7C3AED' }] : []),
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 h-8 px-4 rounded-none text-xs font-semibold transition-all flex-shrink-0 ${
                activeTab === tab.key
                  ? 'text-white shadow-sm'
                  : isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-500 hover:bg-slate-100'
              }`}
              style={activeTab === tab.key ? { background: tab.accent || 'linear-gradient(135deg, #0D3B66, #1F6FB2)' } : {}}>
              {tab.icon}
              <span className="ml-1">{tab.label}</span>
              {tab.key === 'invoices' && clientInvoices.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'invoices' ? 'rgba(255,255,255,0.25)' : '#e2e8f0', color: activeTab === 'invoices' ? '#fff' : '#64748b' }}>
                  {clientInvoices.length}
                </span>
              )}
              {tab.key === 'purchases' && clientPurchaseInvoices.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'purchases' ? 'rgba(255,255,255,0.25)' : '#dcfce7', color: activeTab === 'purchases' ? '#fff' : '#166534' }}>
                  {clientPurchaseInvoices.length}
                </span>
              )}
              {tab.key === 'reconciliation' && gstSessions.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'reconciliation' ? 'rgba(255,255,255,0.25)' : '#e2e8f0', color: activeTab === 'reconciliation' ? '#fff' : '#64748b' }}>
                  {gstSessions.length}
                </span>
              )}
              {tab.key === 'govtfees' && govtFees.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'govtfees' ? 'rgba(255,255,255,0.25)' : '#e2e8f0', color: activeTab === 'govtfees' ? '#fff' : '#64748b' }}>
                  {govtFees.length}
                </span>
              )}
              {tab.key === 'portal' && portalUsers.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'portal' ? 'rgba(255,255,255,0.25)' : '#dcfce7', color: activeTab === 'portal' ? '#fff' : '#166534' }}>
                  {portalUsers.length}
                </span>
              )}
              {tab.key === 'tasks' && clientTasks.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: activeTab === 'tasks' ? 'rgba(255,255,255,0.25)' : '#fef3c7', color: activeTab === 'tasks' ? '#fff' : '#92400e' }}>
                  {clientTasks.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Scrollable Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ════════════════ PORTAL TAB ════════════════ */}
          {activeTab === 'portal' && (
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Client Portal Access
                </h3>
                {isAdmin && (
                  <button
                    onClick={() => setShowPortalManager(true)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl text-white font-semibold transition"
                    style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
                  >
                    <Settings className="h-3.5 w-3.5" /> Manage Portal
                  </button>
                )}
              </div>

              {portalLoading ? (
                <MiniLoader height={80} />
              ) : portalUsers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Globe className="h-10 w-10 mb-3 opacity-20 text-slate-400" />
                  <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No portal account yet</p>
                  <p className={`text-xs mt-1 max-w-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Click "Manage Portal" to create login credentials and link a Google Drive folder for this client.
                  </p>
                  {isAdmin && (
                    <button
                      onClick={() => setShowPortalManager(true)}
                      className="mt-4 text-xs px-4 py-2 rounded-xl text-white font-semibold"
                      style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
                    >
                      + Set Up Portal Access
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {portalUsers.map(pu => (
                    <div key={pu.id} className={`border rounded-2xl p-4 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                            {(pu.display_name || pu.portal_username || '?')[0].toUpperCase()}
                          </div>
                          <div>
                            <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{pu.display_name || pu.portal_username}</p>
                            <p className="text-xs text-slate-400">@{pu.portal_username}{pu.email ? ` · ${pu.email}` : ''}</p>
                          </div>
                        </div>
                        <span className={`text-[11px] px-2.5 py-1 rounded-full font-semibold flex-shrink-0 ${pu.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                          {pu.is_active ? '● Active' : '● Inactive'}
                        </span>
                      </div>

                      {/* Permissions chips */}
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {[
                          { key: 'can_view_tasks',      label: 'Tasks' },
                          { key: 'can_view_documents',  label: 'Docs' },
                          { key: 'can_view_invoices',   label: 'Invoices' },
                          { key: 'can_view_compliance', label: 'Compliance' },
                        ].map(({ key, label }) => (
                          <span key={key} className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg border ${pu[key] ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-60'}`}>
                            {pu[key] ? '✓' : '✗'} {label}
                          </span>
                        ))}
                      </div>

                      {/* Drive folder */}
                      {pu.google_drive_folder_id ? (
                        <div className="flex items-center gap-2 text-xs text-blue-700 bg-blue-50 rounded-xl px-3 py-2 mb-3 border border-blue-100">
                          <span>📁</span>
                          <span>Drive folder: <strong>{pu.google_drive_folder_name || 'My Documents'}</strong></span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2 mb-3 border border-amber-100">
                          <span>⚠️</span>
                          <span>No Google Drive folder linked yet</span>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => window.open('/client-portal', '_blank')}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition"
                        >
                          <ExternalLinkIcon className="h-3 w-3" /> Open Portal
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => setShowPortalManager(true)}
                            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 transition"
                          >
                            ⚙️ Manage
                          </button>
                        )}
                        <button
                          onClick={() => { setDetailDialogOpen(false); navigate('/client-portal-manager'); }}
                          className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 transition"
                        >
                          Portal Manager ↗
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Inline portal manager modal */}
              {showPortalManager && (
                <ClientPortalManager
                  clientId={selectedClient.id}
                  clientName={selectedClient.company_name}
                  onClose={() => {
                    setShowPortalManager(false);
                    // Refresh portal users after managing
                    setPortalLoading(true);
                    api.get('/client-portal/users', { params: { client_id: selectedClient.id } })
                      .then(r => setPortalUsers(r.data || []))
                      .catch(() => {})
                      .finally(() => setPortalLoading(false));
                  }}
                />
              )}
            </div>
          )}

          {/* ════════════════ RENEWALS TAB ════════════════ */}
          {activeTab === 'renewals' && (
            <div className="p-6">
              <ClientRenewalsTab
                clientId={selectedClient.id}
                isDark={isDark}
                currentUserRole={user?.role}
              />
            </div>
          )}

          {/* ════════════════ INVOICES TAB ════════════════ */}
          {activeTab === 'invoices' && (
            <div className="p-6 space-y-4">
              {invoicesLoading ? (
                <MiniLoader height={120} />
              ) : clientInvoices.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <FileText className="h-10 w-10 mb-3 opacity-25" />
                  <p className="text-sm font-medium">No invoices found</p>
                  <p className="text-xs mt-1 text-slate-300">Create an invoice for this client to see it here</p>
                </div>
              ) : (
                <>
                  {/* Summary strip */}
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Total Invoices', value: clientInvoices.length, color: '#1F6FB2' },
                      { label: 'Total Billed', value: `₹${totalInvValue.toLocaleString('en-IN')}`, color: '#059669' },
                      { label: 'Outstanding', value: `₹${totalOutstanding.toLocaleString('en-IN')}`, color: totalOutstanding > 0 ? '#dc2626' : '#059669' },
                    ].map((s, i) => (
                      <div key={i} className={`rounded-xl p-3 border text-center ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{s.label}</p>
                        <p className="text-sm font-bold" style={{ color: s.color }}>{s.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Invoice rows */}
                  <div className="space-y-2">
                    {clientInvoices.slice(0, 15).map(inv => {
                      const sc = INV_STATUS_COLORS[inv.status] || INV_STATUS_COLORS.draft;
                      return (
                        <div key={inv.id} className={`border rounded-xl p-3.5 transition-colors ${isDark ? 'bg-slate-700 border-slate-600 hover:bg-slate-600/60' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{inv.invoice_no}</p>
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border" style={{ background: sc.bg, color: sc.text, borderColor: sc.border }}>
                                  {(inv.status || 'draft').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())}
                                </span>
                              </div>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {inv.invoice_date}
                                {inv.invoice_type && <span className="ml-1 opacity-60">· {inv.invoice_type.replace(/_/g, ' ')}</span>}
                                {inv.due_date && <span className="ml-1 opacity-60">· Due {inv.due_date}</span>}
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                                ₹{(inv.grand_total || 0).toLocaleString('en-IN')}
                              </p>
                              {(inv.amount_due || 0) > 0 && (
                                <p className="text-xs text-red-500 font-semibold">
                                  Due ₹{(inv.amount_due || 0).toLocaleString('en-IN')}
                                </p>
                              )}
                              {inv.status === 'paid' && (
                                <p className="text-xs text-emerald-600 font-semibold">Paid ✓</p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {clientInvoices.length > 15 && (
                      <p className="text-xs text-slate-400 text-center py-2">
                        +{clientInvoices.length - 15} more invoices
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════════════════ PURCHASES TAB ════════════════ */}
          {activeTab === 'purchases' && (
            <div className="p-6 space-y-4">
              {purchaseLoading ? (
                <MiniLoader height={120} />
              ) : clientPurchaseInvoices.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <IndianRupee className="h-10 w-10 mb-3 opacity-25" />
                  <p className="text-sm font-medium">No purchase invoices found</p>
                  <p className="text-xs mt-1 text-slate-300">Upload purchase invoices from Accounts → Purchase to see them here</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Purchase Invoices', value: clientPurchaseInvoices.length, color: '#1F6FB2' },
                      { label: 'Total Purchase', value: `₹${totalPurchaseValue.toLocaleString('en-IN')}`, color: '#059669' },
                      { label: 'Input GST', value: `₹${totalPurchaseGst.toLocaleString('en-IN')}`, color: '#7C3AED' },
                    ].map((s, i) => (
                      <div key={i} className={`rounded-xl p-3 border text-center ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{s.label}</p>
                        <p className="text-sm font-bold" style={{ color: s.color }}>{s.value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {clientPurchaseInvoices.slice(0, 15).map(inv => (
                      <div key={inv.id} className={`border rounded-xl p-3.5 transition-colors ${isDark ? 'bg-slate-700 border-slate-600 hover:bg-slate-600/60' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{inv.invoice_no || 'No invoice no.'}</p>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                                Purchase
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {inv.supplier_name || 'Unknown supplier'}
                              {inv.supplier_gstin && <span className="ml-1 opacity-60">· {inv.supplier_gstin}</span>}
                              {inv.invoice_date && <span className="ml-1 opacity-60">· {inv.invoice_date}</span>}
                            </p>
                            <p className="text-[10px] text-slate-400 mt-1 truncate">{inv.file_name}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                              ₹{(inv.grand_total || 0).toLocaleString('en-IN')}
                            </p>
                            <p className="text-xs text-violet-500 font-semibold">
                              GST ₹{(inv.total_gst || 0).toLocaleString('en-IN')}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                    {clientPurchaseInvoices.length > 15 && (
                      <p className="text-xs text-slate-400 text-center py-2">
                        +{clientPurchaseInvoices.length - 15} more purchase invoices
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════════════════ GST RECONCILIATION TAB ════════════════ */}
          {activeTab === 'reconciliation' && (
            <div className="p-6 space-y-4">
              {/* Header row */}
              <div className="flex items-center justify-between">
                <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Reconciliation History
                </p>
                <button
                  onClick={() => {
                    setGstLoading(true);
                    const params = selectedClient.id
                      ? { client_id: selectedClient.id, limit: 50 }
                      : { client_name: selectedClient.company_name, limit: 50 };
                    api.get('/gst-reconciliation/history', { params })
                      .then(r => setGstSessions(r.data?.sessions || []))
                      .catch(() => {})
                      .finally(() => setGstLoading(false));
                  }}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 transition-colors"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${gstLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {gstLoading ? (
                <MiniLoader height={120} />
              ) : gstSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <ArrowLeftRight className="h-10 w-10 mb-3 opacity-25" />
                  <p className="text-sm font-medium">No reconciliation records</p>
                  <p className="text-xs mt-1 text-slate-300">
                    Run a GST reconciliation and link it to this client to see it here
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {gstSessions.map(session => {
                    const sm = session.summary || {};
                    const dateStr = session.created_at
                      ? new Date(session.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—';
                    return (
                      <div
                        key={session.id}
                        className={`rounded-xl border p-4 ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-white border-slate-200'}`}
                      >
                        {/* Row 1: period + date + actions */}
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            {session.period && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
                                {session.period}
                              </span>
                            )}
                            <span className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              {dateStr}
                            </span>
                            {session.created_by_name && (
                              <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                by {session.created_by_name}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => downloadGstFull(session, 'pdf')}
                              disabled={!!gstDownloading}
                              title="Download PDF report"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/20 dark:hover:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 transition-colors disabled:opacity-50"
                            >
                              {gstDownloading === `${session.id}_pdf` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} PDF
                            </button>
                            <button
                              onClick={() => downloadGstFull(session, 'word')}
                              disabled={!!gstDownloading}
                              title="Download Word report"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 transition-colors disabled:opacity-50"
                            >
                              {gstDownloading === `${session.id}_word` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Word
                            </button>
                            <button
                              onClick={() => downloadGstFull(session, 'excel')}
                              disabled={!!gstDownloading}
                              title="Download Excel report"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 transition-colors disabled:opacity-50"
                            >
                              {gstDownloading === `${session.id}_excel` ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSpreadsheet className="h-3 w-3" />} Excel
                            </button>
                            {isAdmin && (
                              <button
                                onClick={() => handleDeleteGstSession(session.id)}
                                disabled={gstDeleting === session.id}
                                title="Delete this record (admin only)"
                                className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-slate-300 hover:text-rose-500 transition-colors"
                              >
                                {gstDeleting === session.id
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Trash2 className="h-3.5 w-3.5" />}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Row 2: stat pills */}
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { label: '✓ Matched',     val: sm.matched_count ?? 0,     bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
                            { label: '⚠ Mismatch',    val: sm.mismatch_count ?? 0,    bg: 'bg-amber-100 dark:bg-amber-900/30',    text: 'text-amber-700 dark:text-amber-300'   },
                            { label: '🌐 Portal Only', val: sm.portal_only_count ?? 0, bg: 'bg-blue-100 dark:bg-blue-900/30',      text: 'text-blue-700 dark:text-blue-300'     },
                            { label: '📒 Books Only',  val: sm.books_only_count ?? 0,  bg: 'bg-rose-100 dark:bg-rose-900/30',      text: 'text-rose-700 dark:text-rose-300'     },
                          ].map(p => (
                            <span key={p.label} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${p.bg} ${p.text}`}>
                              {p.label}: {p.val}
                            </span>
                          ))}
                        </div>

                        {/* Row 3: filenames */}
                        {(session.portal_filename || session.books_filename) && (
                          <div className={`mt-2 flex flex-wrap gap-3 text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            {session.portal_filename && <span>🌐 {session.portal_filename}</span>}
                            {session.books_filename  && <span>📒 {session.books_filename}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ════════════════ GOVT FEES TAB ════════════════ */}
          {activeTab === 'govtfees' && (() => {
            const isSavedLinkedFee = (item) => {
              const amount = Number(item.govt_fees_amount || 0);
              return amount > 0 || !!item.govt_fees_srn || !!item.govt_fees_notes;
            };
            const pendingLinked = (govtFees || []).filter(item => !isSavedLinkedFee(item));
            const savedLinked = (govtFees || []).filter(isSavedLinkedFee);
            const paymentRows = [
              ...savedLinked.map(item => ({
                id: `linked-${item.assignment_id}`,
                type: 'linked',
                source: 'Compliance Tracker',
                title: item.name || 'Compliance fee',
                category: item.category || '—',
                fy_year: item.fy_year || '—',
                due_date: item.due_date || '',
                amount: Number(item.govt_fees_amount || 0),
                srn: item.govt_fees_srn || '',
                notes: item.govt_fees_notes || '',
                status: Number(item.govt_fees_amount || 0) > 0 ? 'paid' : 'unpaid',
                payment_date: item.payment_date || item.paid_on || item.paid_at || '',
                reimbursed: !!item.reimbursed,
                reimbursed_amount: item.reimbursed_amount ?? Number(item.govt_fees_amount || 0),
                bill_in_next_cycle: !!item.bill_in_next_cycle,
                govt_fee_invoice_id: item.govt_fee_invoice_id,
                govt_fee_invoice_no: item.govt_fee_invoice_no,
                assignment_id: item.assignment_id,
                compliance_id: item.compliance_id,
              })),
              ...(adhocFees || []).map(fee => ({
                id: `adhoc-${fee.id}`,
                type: 'adhoc',
                source: 'Ad-hoc',
                raw: fee,
                title: fee.title || 'Government fee',
                category: fee.category || 'OTHER',
                fy_year: fee.fy_year || '—',
                due_date: fee.due_date || '',
                amount: Number(fee.amount || 0),
                srn: fee.srn || '',
                notes: fee.notes || '',
                status: fee.status || (fee.payment_date || fee.paid_on || fee.paid_at ? 'paid' : 'unpaid'),
                payment_date: fee.payment_date || fee.paid_on || fee.paid_at || '',
                reimbursed: !!fee.reimbursed,
                reimbursed_amount: fee.reimbursed_amount ?? Number(fee.amount || 0),
                bill_in_next_cycle: !!fee.bill_in_next_cycle,
                govt_fee_invoice_id: fee.govt_fee_invoice_id,
                govt_fee_invoice_no: fee.govt_fee_invoice_no,
              })),
            ];
            const money = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const dateText = (d) => d ? format(new Date(String(d).slice(0, 10)), 'MMM d, yyyy') : '—';
            const statusLabel = (s) => (String(s || '').toLowerCase() === 'paid' ? 'Paid' : 'Unpaid');
            const exportGovtFees = async (kind) => {
              if (!paymentRows.length) { toast.error('No government fee payments to export'); return; }
              const fileName = `govt_fees_${(selectedClient?.company_name || 'client').replace(/[^a-z0-9]+/gi, '_')}_${format(new Date(), 'dd-MMM-yyyy')}`;
              const rows = paymentRows.map((row, i) => [
                i + 1,
                selectedClient?.company_name || '',
                row.source,
                row.title,
                row.category,
                row.fy_year,
                dateText(row.due_date),
                statusLabel(row.status),
                dateText(row.payment_date),
                row.amount,
                row.srn || '',
                row.notes || '',
              ]);
              const headers = ['#', 'Client', 'Source', 'Title', 'Category', 'FY Year', 'Due Date', 'Status', 'Payment Date', 'Amount (₹)', 'SRN', 'Details'];
              if (kind === 'excel') {
                const XLSX = await getXLSX();
                const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
                ws['!cols'] = [{wch:5},{wch:32},{wch:20},{wch:28},{wch:14},{wch:12},{wch:14},{wch:12},{wch:14},{wch:14},{wch:18},{wch:32}];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Govt Fees');
                XLSX.writeFile(wb, `${fileName}.xlsx`);
                toast.success('Government fees Excel exported');
                return;
              }
              const jsPDF = await getJsPDF();
              const autoTable = await getAutoTable();
              const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
              doc.setFontSize(15);
              doc.text('Government Fees Payment List', 14, 14);
              doc.setFontSize(9);
              doc.text(`${selectedClient?.company_name || ''} • ${format(new Date(), 'dd MMM yyyy')}`, 14, 20);
              autoTable(doc, {
                startY: 26,
                head: [headers],
                body: rows,
                styles: { fontSize: 7, cellPadding: 2 },
                headStyles: { fillColor: [13, 59, 102] },
                columnStyles: { 0: { cellWidth: 8 }, 9: { halign: 'right' } },
              });
              doc.save(`${fileName}.pdf`);
              toast.success('Government fees PDF exported');
            };
            return (
            <div className="p-6 space-y-6">

              {/* Heading, details and export controls */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                    Government Fees
                  </p>
                  <p className="text-xs text-slate-500 max-w-xl">
                    Saved compliance fees and added government fees are shown together in this full payment list, including paid entries.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Export</span>
                  <button
                    type="button"
                    onClick={() => exportGovtFees('excel')}
                    disabled={!paymentRows.length}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-bold disabled:opacity-40"
                    style={{ borderColor: isDark ? '#334155' : '#cbd5e1', color: isDark ? '#cbd5e1' : '#0f172a', backgroundColor: isDark ? '#1e293b' : '#fff' }}>
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                  </button>
                  <button
                    type="button"
                    onClick={() => exportGovtFees('pdf')}
                    disabled={!paymentRows.length}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-bold disabled:opacity-40"
                    style={{ borderColor: isDark ? '#334155' : '#cbd5e1', color: isDark ? '#cbd5e1' : '#0f172a', backgroundColor: isDark ? '#1e293b' : '#fff' }}>
                    <Download className="h-3.5 w-3.5" /> PDF
                  </button>
                </div>
              </div>

              {/* Pending compliance-linked govt fees */}
              {govtFeesLoading ? (
                <div className="py-10 text-center text-sm text-slate-500">Loading…</div>
              ) : pendingLinked.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Pending From Compliance Tracker
                  </p>
                  <div className={`grid gap-2 px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                    style={{ gridTemplateColumns: '2fr 80px 100px 120px 1fr 80px' }}>
                    <div>Compliance</div>
                    <div>FY Year</div>
                    <div>Due Date</div>
                    <div>Govt Fee (₹)</div>
                    <div>SRN</div>
                    <div className="text-right">Action</div>
                  </div>
                  {pendingLinked.map(item => {
                    const draft = govtFeesDraft[item.assignment_id] || { amount: 0, notes: '', srn: '' };
                    const dirty = (parseFloat(draft.amount) || 0) !== (item.govt_fees_amount || 0)
                               || (draft.notes || '') !== (item.govt_fees_notes || '')
                               || (draft.srn   || '') !== (item.govt_fees_srn   || '')
                               || !!draft.bill_in_next_cycle !== !!item.bill_in_next_cycle;
                    return (
                      <div key={item.assignment_id}
                        className={`grid gap-2 items-center px-3 py-2.5 rounded-xl border ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-white border-slate-200'}`}
                        style={{ gridTemplateColumns: '2fr 80px 100px 120px 1fr 80px' }}>
                        <div>
                          <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{item.name}</p>
                          <p className="text-[11px] text-slate-500">{item.category} · {item.frequency}{item.period_label ? ` · ${item.period_label}` : ''}</p>
                          <button
                            type="button"
                            onClick={() => setGovtFeesDraft(prev => ({
                              ...prev,
                              [item.assignment_id]: {
                                ...prev[item.assignment_id],
                                bill_in_next_cycle: !prev[item.assignment_id]?.bill_in_next_cycle,
                              },
                            }))}
                            className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              draft.bill_in_next_cycle
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-blue-50 text-blue-700 border-blue-200'
                            }`}>
                            <Calendar className="h-3 w-3" />
                            {draft.bill_in_next_cycle ? 'Take in next billing cycle' : 'Take in next invoice'}
                          </button>
                        </div>
                        <div className="text-xs text-slate-600">{item.fy_year || '—'}</div>
                        <div className="text-xs text-slate-600">
                          {item.due_date ? format(new Date(item.due_date), 'MMM d, yyyy') : '—'}
                        </div>
                        <div>
                          <input
                            type="number" min="0" step="0.01"
                            value={draft.amount}
                            onChange={e => setGovtFeesDraft(prev => ({
                              ...prev,
                              [item.assignment_id]: { ...prev[item.assignment_id], amount: e.target.value },
                            }))}
                            className={`w-full px-2.5 py-1.5 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300'}`}
                            placeholder="0.00"
                          />
                        </div>
                        <div>
                          <input
                            type="text"
                            value={draft.srn}
                            onChange={e => setGovtFeesDraft(prev => ({
                              ...prev,
                              [item.assignment_id]: { ...prev[item.assignment_id], srn: e.target.value },
                            }))}
                            className={`w-full px-2.5 py-1.5 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300'}`}
                            placeholder="SRN…"
                          />
                        </div>
                        <div className="flex justify-end">
                          <button
                            onClick={() => saveGovtFee(item)}
                            disabled={!dirty || govtFeesSavingId === item.assignment_id}
                            className="inline-flex items-center gap-1 h-8 px-3 rounded-lg text-xs font-bold text-white disabled:opacity-40"
                            style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                            <SaveIcon className="h-3.5 w-3.5" />
                            {govtFeesSavingId === item.assignment_id ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Single full payment list */}
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Full Payment List
                </p>
                {(adhocFeesLoading || govtFeesLoading) ? (
                  <div className="py-6 text-center text-xs text-slate-500">Loading…</div>
                ) : paymentRows.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500 rounded-xl border border-dashed border-slate-200">
                    No government fee payments yet. Save a tracker fee or add a government fee below.
                  </div>
                ) : (
                  <>
                    <div className={`grid gap-2 px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                      style={{ gridTemplateColumns: '100px 1fr 65px 100px 75px 120px 155px 75px' }}>
                      <div>Source</div>
                      <div>Title</div>
                      <div>FY</div>
                      <div>Due Date</div>
                      <div>Status</div>
                      <div>Amt / SRN</div>
                      <div>Reimbursed</div>
                      <div className="text-right">Actions</div>
                    </div>
                    {paymentRows.map(row => (
                      <div key={row.id}
                        className={`grid gap-2 items-center px-3 py-2.5 rounded-xl border ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-white border-slate-200'}`}
                        style={{ gridTemplateColumns: '100px 1fr 65px 100px 75px 120px 155px 75px' }}>
                        <div className="text-[11px] font-bold text-slate-500">{row.source}</div>
                        <div>
                          <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{row.title}</p>
                          <p className="text-[11px] text-slate-500">{row.category}{row.notes ? ` · ${row.notes}` : ''}</p>
                          {row.govt_fee_invoice_id ? (
                            <p className="mt-1 text-[10px] font-bold text-emerald-600">
                              Invoiced{row.govt_fee_invoice_no ? ` · ${row.govt_fee_invoice_no}` : ''}
                            </p>
                          ) : (
                            <button
                              type="button"
                              onClick={async () => {
                                const patch = { bill_in_next_cycle: !row.bill_in_next_cycle };
                                try {
                                  if (row.type === 'linked') {
                                    await api.patch(`/compliance/${row.compliance_id}/assignments/${row.assignment_id}/govt-fee`, patch);
                                    setGovtFees(prev => prev.map(x => x.assignment_id === row.assignment_id ? { ...x, ...patch } : x));
                                  } else {
                                    await api.patch(`/compliance/standalone-govt-fees/${row.raw.id}`, patch);
                                    setAdhocFees(prev => prev.map(x => x.id === row.raw.id ? { ...x, ...patch } : x));
                                  }
                                  toast.success(patch.bill_in_next_cycle ? 'Fee deferred to next billing cycle' : 'Fee will be included in the next invoice');
                                } catch {
                                  toast.error('Could not update billing cycle');
                                }
                              }}
                              className={`mt-1 inline-flex items-center gap-1 text-[10px] font-bold ${
                                row.bill_in_next_cycle ? 'text-amber-600' : 'text-blue-600'
                              }`}>
                              <Calendar className="h-3 w-3" />
                              {row.bill_in_next_cycle ? 'Take in next billing cycle' : 'Take in next invoice'}
                            </button>
                          )}
                        </div>
                        <div className="text-xs text-slate-600">{row.fy_year || '—'}</div>
                        <div className="text-xs text-slate-600">{dateText(row.due_date)}</div>
                        <div>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${String(row.status).toLowerCase() === 'paid' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                            {statusLabel(row.status)}
                          </span>
                          {row.payment_date && <p className="text-[10px] text-slate-500 mt-1">{dateText(row.payment_date)}</p>}
                        </div>
                        <div>
                          <p className="text-sm font-bold">₹ {money(row.amount)}</p>
                          <p className="text-[11px] font-mono text-slate-500">{row.srn || '—'}</p>
                        </div>
                        {/* Reimbursed column */}
                        <div className="flex flex-col gap-1">
                          <div className="flex rounded-lg overflow-hidden border text-[10px] font-bold w-fit"
                            style={{ borderColor: isDark ? '#334155' : '#d1d5db' }}>
                            {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map(opt => {
                              const isActive = !!row.reimbursed === opt.v;
                              return (
                                <button key={String(opt.v)}
                                  onClick={async () => {
                                    const newVal = opt.v;
                                    const patch = newVal
                                      ? { reimbursed: true, reimbursed_amount: row.reimbursed_amount ?? row.amount }
                                      : { reimbursed: false };
                                    if (row.type === 'linked') {
                                      setGovtFees(prev => prev.map(x => x.assignment_id === row.assignment_id ? { ...x, ...patch } : x));
                                      try {
                                        await api.patch(`/compliance/${row.compliance_id}/assignments/${row.assignment_id}/govt-fee`, patch);
                                        toast.success(newVal ? 'Marked as reimbursed' : 'Marked as not reimbursed');
                                        window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { assignment_id: row.assignment_id } }));
                                      } catch { toast.error('Update failed'); }
                                    } else {
                                      setAdhocFees(prev => prev.map(x => x.id === row.raw.id ? { ...x, ...patch } : x));
                                      try {
                                        await api.patch(`/compliance/standalone-govt-fees/${row.raw.id}`, patch);
                                        toast.success(newVal ? 'Marked as reimbursed' : 'Marked as not reimbursed');
                                        window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { adhoc_id: row.raw.id } }));
                                      } catch { toast.error('Update failed'); }
                                    }
                                  }}
                                  className="px-2 py-1 transition-colors"
                                  style={{
                                    backgroundColor: isActive ? (opt.v ? '#10b981' : '#64748b') : 'transparent',
                                    color: isActive ? '#fff' : isDark ? '#94a3b8' : '#64748b',
                                  }}>
                                  {opt.l}
                                </button>
                              );
                            })}
                          </div>
                          {row.reimbursed && (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-slate-500">₹</span>
                              <input
                                type="number" min="0" step="0.01"
                                defaultValue={row.reimbursed_amount ?? row.amount}
                                onBlur={async (e) => {
                                  const newAmt = e.target.value === '' ? null : parseFloat(e.target.value) || 0;
                                  const patch = { reimbursed: true, reimbursed_amount: newAmt };
                                  if (row.type === 'linked') {
                                    setGovtFees(prev => prev.map(x => x.assignment_id === row.assignment_id ? { ...x, ...patch } : x));
                                    try {
                                      await api.patch(`/compliance/${row.compliance_id}/assignments/${row.assignment_id}/govt-fee`, patch);
                                      window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { assignment_id: row.assignment_id } }));
                                    } catch { toast.error('Save failed'); }
                                  } else {
                                    setAdhocFees(prev => prev.map(x => x.id === row.raw.id ? { ...x, ...patch } : x));
                                    try {
                                      await api.patch(`/compliance/standalone-govt-fees/${row.raw.id}`, patch);
                                      window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { adhoc_id: row.raw.id } }));
                                    } catch { toast.error('Save failed'); }
                                  }
                                }}
                                onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur(); }}
                                className={`w-24 px-1.5 py-0.5 text-xs rounded-lg border tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300'}`}
                              />
                            </div>
                          )}

                        </div>
                        <div className="flex justify-end gap-1">
                          {row.type === 'adhoc' ? (
                            <>
                              <button
                                onClick={() => { setEditingAdhoc(row.raw); setShowAdhocDialog(true); }}
                                className="p-1.5 rounded-lg hover:bg-slate-100" title="Edit">
                                <Edit className="h-3.5 w-3.5 text-slate-600" />
                              </button>
                              <button
                                onClick={async () => {
                                  if (!window.confirm(`Delete "${row.title}"?`)) return;
                                  try {
                                    await api.delete(`/compliance/standalone-govt-fees/${row.raw.id}`);
                                    toast.success('Government fee deleted');
                                    setAdhocFees(prev => prev.filter(f => f.id !== row.raw.id));
                                  } catch (e) {
                                    toast.error(e?.response?.data?.detail || 'Delete failed');
                                  }
                                }}
                                className="p-1.5 rounded-lg hover:bg-red-50" title="Delete">
                                <Trash2 className="h-3.5 w-3.5 text-red-500" />
                              </button>
                            </>
                          ) : (
                            <span className="text-[10px] font-bold text-slate-400">Saved</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* Totals (full list) */}
              {paymentRows.length > 0 && (() => {
                const totalAmt = paymentRows.reduce((s, row) => s + (row.amount || 0), 0);
                const totalReimbursed = paymentRows.filter(r => r.reimbursed).reduce((s, row) => s + ((row.reimbursed_amount ?? row.amount) || 0), 0);
                const netAmount = totalAmt - totalReimbursed;
                return (
                  <div className={`flex justify-end gap-6 px-3 py-3 rounded-xl border ${isDark ? 'bg-slate-700/30 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-sm">
                      <span className="text-slate-500 mr-2">Total listed:</span>
                      <span className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>₹ {money(totalAmt)}</span>
                    </p>
                    {totalReimbursed > 0 && (
                      <>
                        <p className="text-sm">
                          <span className="text-slate-500 mr-2">Reimbursed:</span>
                          <span className="font-bold text-emerald-600">− ₹ {money(totalReimbursed)}</span>
                        </p>
                        <p className="text-sm">
                          <span className="text-slate-500 mr-2">Net:</span>
                          <span className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>₹ {money(netAmount)}</span>
                        </p>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Single Add button — placed BELOW the fees/details */}
              <div className="flex justify-center pt-2">
                <Button
                  size="sm"
                  onClick={() => { setEditingAdhoc(null); setShowAdhocDialog(true); }}
                  className="h-9 px-4 rounded-xl text-white text-xs font-semibold gap-1.5"
                  style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                  <Plus className="h-4 w-4" /> Add Government Fee
                </Button>
              </div>

              {/* Ad-hoc govt fee dialog */}
              <StandaloneGovtFeeDialog
                open={showAdhocDialog}
                onOpenChange={setShowAdhocDialog}
                editing={editingAdhoc}
                clientId={selectedClient?.id}
                lockClient={true}
                onSaved={() => { fetchAdhocFees(); setEditingAdhoc(null); }}
              />
            </div>
            );
          })()}


          {/* ════════════════ DETAILS TAB ════════════════ */}
          {activeTab === 'details' && (
            <div className="p-8 space-y-6">

              {/* ── Quick Info Summary Row ── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {selectedClient.referred_by && (
                  <div className={`col-span-2 sm:col-span-2 rounded-2xl p-4 border flex items-center gap-3 ${isDark ? 'bg-violet-900/20 border-violet-700/40' : 'bg-violet-50 border-violet-200'}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-violet-800/60' : 'bg-violet-100'}`}>
                      <Share2 className="h-4 w-4 text-violet-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-violet-500 mb-0.5">Referred By</p>
                      <p className={`text-sm font-semibold truncate ${isDark ? 'text-violet-200' : 'text-violet-800'}`}>{selectedClient.referred_by}</p>
                    </div>
                  </div>
                )}
                {selectedClient.auditor && (
                  <div className={`col-span-2 sm:col-span-2 rounded-2xl p-4 border flex items-center gap-3 ${isDark ? 'bg-purple-900/20 border-purple-700/40' : 'bg-purple-50 border-purple-200'}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-purple-800/60' : 'bg-purple-100'}`}>
                      <FileCheck className="h-4 w-4 text-purple-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-purple-500 mb-0.5">Auditor</p>
                      <p className={`text-sm font-semibold truncate ${isDark ? 'text-purple-200' : 'text-purple-800'}`}>{selectedClient.auditor}</p>
                    </div>
                  </div>
                )}
                {selectedClient.cin && (
                  <div className={`rounded-2xl p-4 border ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">CIN</p>
                    <div className="flex items-center gap-1.5">
                      <p className={`text-xs font-mono font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{selectedClient.cin}</p>
                      <button onClick={() => copyToClipboard(selectedClient.cin, 'CIN')} className="text-slate-300 hover:text-slate-600 flex-shrink-0"><Copy className="h-3 w-3" /></button>
                    </div>
                  </div>
                )}
                {selectedClient.llpin && (
                  <div className={`rounded-2xl p-4 border ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">LLPIN</p>
                    <div className="flex items-center gap-1.5">
                      <p className={`text-xs font-mono font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{selectedClient.llpin}</p>
                      <button onClick={() => copyToClipboard(selectedClient.llpin, 'LLPIN')} className="text-slate-300 hover:text-slate-600 flex-shrink-0"><Copy className="h-3 w-3" /></button>
                    </div>
                  </div>
                )}
                {selectedClient.proprietor_name && (
                  <div className={`rounded-2xl p-4 border ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Proprietor Name</p>
                    <div className="flex items-center gap-1.5">
                      <p className={`text-xs font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{selectedClient.proprietor_name}</p>
                      <button onClick={() => copyToClipboard(selectedClient.proprietor_name, 'Proprietor Name')} className="text-slate-300 hover:text-slate-600 flex-shrink-0"><Copy className="h-3 w-3" /></button>
                    </div>
                  </div>
                )}
              </div>

              {/* Contact info */}
              <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                <h3 className={`text-sm font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-4 flex items-center gap-2`}><Mail className="h-4 w-4" /> Contact Information</h3>
                <div className="space-y-3">
                  {selectedClient.email && (
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-blue-500 flex-shrink-0" />
                      <a href={`mailto:${selectedClient.email}`} className="text-blue-600 hover:underline text-sm flex-1">{selectedClient.email}</a>
                      <button onClick={() => copyToClipboard(selectedClient.email, 'Email')} className="text-slate-300 hover:text-slate-600 transition-colors"><Copy className="h-3.5 w-3.5" /></button>
                    </div>
                  )}
                  {selectedClient.phone && (
                    <div className="flex items-center gap-3">
                      <Phone className="h-4 w-4 text-green-500 flex-shrink-0" />
                      <a href={`tel:${selectedClient.phone}`} className="text-slate-700 font-medium text-sm flex-1">{selectedClient.phone}</a>
                      <button onClick={() => copyToClipboard(selectedClient.phone, 'Phone')} className="text-slate-300 hover:text-slate-600 transition-colors"><Copy className="h-3.5 w-3.5" /></button>
                    </div>
                  )}
                  {selectedClient.address && (
                    <div className="flex items-start gap-3">
                      <MapPin className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                      <div className="text-slate-700 text-sm">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Primary Address</p>
                        <p>{selectedClient.address}</p>
                        {(selectedClient.city || selectedClient.state) && <p className="text-slate-500 text-xs mt-0.5">{[selectedClient.city, selectedClient.state].filter(Boolean).join(', ')}</p>}
                      </div>
                    </div>
                  )}
                  {selectedClient.gst_address && (
                    <div className="flex items-start gap-3">
                      <MapPin className="h-4 w-4 text-orange-400 flex-shrink-0 mt-0.5" />
                      <div className="text-slate-700 text-sm">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">GST Registered Address</p>
                        <p>{selectedClient.gst_address}</p>
                        {(selectedClient.gst_city || selectedClient.gst_state) && <p className="text-slate-500 text-xs mt-0.5">{[selectedClient.gst_city, selectedClient.gst_state, selectedClient.gst_pin].filter(Boolean).join(', ')}</p>}
                      </div>
                    </div>
                  )}
                  {selectedClient.website && (
                    <div className="flex items-center gap-3">
                      <ExternalLink className="h-4 w-4 text-purple-500 flex-shrink-0" />
                      <a href={selectedClient.website} target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline text-sm flex-1 truncate">
                        {selectedClient.website.replace(/^https?:\/\//, '')}
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Tax & Billing */}
              {hasTaxInfo && (
                <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                  <h3 className={`text-sm font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-4 flex items-center gap-2`}>
                    <FileCheck className="h-4 w-4" /> Tax & Billing
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {selectedClient.gstin && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">GSTIN</p>
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-mono font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.gstin}</p>
                          <button onClick={() => copyToClipboard(selectedClient.gstin, 'GSTIN')} className="text-slate-300 hover:text-slate-600 transition-colors flex-shrink-0"><Copy className="h-3 w-3" /></button>
                        </div>
                      </div>
                    )}
                    {selectedClient.pan && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">PAN</p>
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-mono font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.pan}</p>
                          <button onClick={() => copyToClipboard(selectedClient.pan, 'PAN')} className="text-slate-300 hover:text-slate-600 transition-colors flex-shrink-0"><Copy className="h-3 w-3" /></button>
                        </div>
                      </div>
                    )}
                    {selectedClient.gst_treatment && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">GST Treatment</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          {GST_TREATMENT_LABELS[selectedClient.gst_treatment] || selectedClient.gst_treatment}
                        </p>
                      </div>
                    )}
                    {selectedClient.default_payment_terms && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Payment Terms</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.default_payment_terms}</p>
                      </div>
                    )}
                    {selectedClient.credit_limit && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Credit Limit</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          ₹{Number(selectedClient.credit_limit).toLocaleString('en-IN')}
                        </p>
                      </div>
                    )}
                    {selectedClient.opening_balance && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Opening Balance</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          ₹{Number(selectedClient.opening_balance).toLocaleString('en-IN')}
                          <span className="ml-1 text-xs text-slate-400">{selectedClient.opening_balance_type || 'Dr'}</span>
                        </p>
                      </div>
                    )}
                    {selectedClient.msme_number && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">MSME / Udyam</p>
                        <p className={`text-xs font-mono font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.msme_number}</p>
                      </div>
                    )}
                    {selectedClient.place_of_supply && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Place of Supply</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.place_of_supply}</p>
                      </div>
                    )}
                    {selectedClient.cin && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">CIN</p>
                        <div className="flex items-center gap-2">
                          <p className={`text-xs font-mono font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.cin}</p>
                          <button onClick={() => copyToClipboard(selectedClient.cin, 'CIN')} className="text-slate-300 hover:text-slate-600 flex-shrink-0"><Copy className="h-3 w-3" /></button>
                        </div>
                      </div>
                    )}
                    {selectedClient.llpin && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">LLPIN</p>
                        <div className="flex items-center gap-2">
                          <p className={`text-xs font-mono font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{selectedClient.llpin}</p>
                          <button onClick={() => copyToClipboard(selectedClient.llpin, 'LLPIN')} className="text-slate-300 hover:text-slate-600 flex-shrink-0"><Copy className="h-3 w-3" /></button>
                        </div>
                      </div>
                    )}
                    {selectedClient.mca_fetch_date && (
                      <div className={`rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">MCA Last Fetched</p>
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{format(new Date(selectedClient.mca_fetch_date), 'MMM d, yyyy')}</p>
                      </div>
                    )}
                  </div>
                  {/* Tally sub-card */}
                  {(selectedClient.tally_ledger_name || selectedClient.tally_group) && (
                    <div className={`mt-3 rounded-xl p-3 border ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                        <Building2 className="h-3 w-3" /> Tally Sync
                      </p>
                      <div className="flex flex-wrap gap-5 text-sm">
                        {selectedClient.tally_ledger_name && (
                          <span>
                            <span className="text-xs text-slate-400">Ledger: </span>
                            <span className={`font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{selectedClient.tally_ledger_name}</span>
                          </span>
                        )}
                        {selectedClient.tally_group && (
                          <span>
                            <span className="text-xs text-slate-400">Group: </span>
                            <span className={`font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{selectedClient.tally_group}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Services */}
              {selectedClient.services?.length > 0 && (
                <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                  <h3 className={`text-sm font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-4 flex items-center gap-2`}><BarChart3 className="h-4 w-4" /> Services</h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedClient.services.map((svc, i) => (
                      <span key={i} className="text-xs font-semibold px-3 py-2 rounded-xl border" style={{ background: cfg.bg, color: cfg.text, borderColor: cfg.border }}>
                        {svc.replace('Other: ', '')}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Contact persons */}
              {selectedClient.contact_persons?.length > 0 && (
                <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                  <h3 className={`text-sm font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-4 flex items-center gap-2`}>
                    <Users className="h-4 w-4" /> Contact Persons ({selectedClient.contact_persons.length})
                  </h3>
                  <div className="space-y-3">
                    {selectedClient.contact_persons.map((cp, i) => cp.name && (
                      <div key={i} className={`border rounded-xl p-4 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <p className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{cp.name}</p>
                        {cp.designation && <p className="text-xs text-slate-500 mt-1">{cp.designation}</p>}
                        <div className="flex flex-col gap-1.5 mt-2 text-xs">
                          {cp.email && (
                            <div className="flex items-center gap-2">
                              <a href={`mailto:${cp.email}`} className="text-blue-600 hover:underline flex-1">{cp.email}</a>
                              <button onClick={() => copyToClipboard(cp.email, 'Email')} className="text-slate-300 hover:text-slate-500"><Copy className="h-3 w-3" /></button>
                            </div>
                          )}
                          {cp.phone && (
                            <div className="flex items-center gap-2">
                              <a href={`tel:${cp.phone}`} className="text-slate-700 flex-1">{cp.phone}</a>
                              <button onClick={() => copyToClipboard(cp.phone, 'Phone')} className="text-slate-300 hover:text-slate-500"><Copy className="h-3 w-3" /></button>
                            </div>
                          )}
                          {cp.birthday && <p className="text-slate-500">Birthday: {format(new Date(cp.birthday), 'MMM d, yyyy')}</p>}
                          {cp.din && <p className="text-slate-500">DIN: {cp.din}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* DSC details */}
              {selectedClient.dsc_details?.length > 0 && (
                <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                  <h3 className={`text-sm font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-4 flex items-center gap-2`}>
                    <Shield className="h-4 w-4" /> DSC Details ({selectedClient.dsc_details.length})
                  </h3>
                  <div className="space-y-3">
                    {selectedClient.dsc_details.map((dsc, i) => dsc.certificate_number && (
                      <div key={i} className={`border rounded-xl p-4 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <p className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{dsc.certificate_number}</p>
                          <DscBadge daysLeft={getDscDaysLeft(dsc.expiry_date)} />
                        </div>
                        <p className="text-xs text-slate-500 mt-1">Holder: {dsc.holder_name}</p>
                        <div className="flex gap-4 mt-2 text-xs text-slate-600">
                          {dsc.issue_date && <p>Issued: {format(new Date(dsc.issue_date), 'MMM d, yyyy')}</p>}
                          {dsc.expiry_date && <p>Expires: {format(new Date(dsc.expiry_date), 'MMM d, yyyy')}</p>}
                        </div>
                        {dsc.notes && <p className="text-xs text-slate-500 mt-2 italic">{dsc.notes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Assignments & notes */}
              {(clientAssignments.length > 0 || selectedClient.notes) && (
                <div className="grid grid-cols-2 gap-4">
                  {clientAssignments.length > 0 && (
                    <div className={`border rounded-2xl p-5 col-span-2 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                      <h3 className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-3 flex items-center gap-2`}>
                        <Briefcase className="h-3.5 w-3.5" /> User Assignments
                      </h3>
                      <div className="flex flex-col gap-2">
                        {clientAssignments.map((a, i) => {
                          const u = users.find(x => x.id === a.user_id);
                          if (!u) return null;
                          return (
                            <div key={i} className={`flex items-start gap-3 border rounded-xl px-4 py-2.5 ${isDark ? 'bg-slate-700/60 border-slate-600' : 'bg-white border-slate-100'}`}>
                              <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ background: getAvatarGradient(u.full_name || u.name || '') }}>
                                {(u.full_name || u.name || '?').charAt(0).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{u.full_name || u.name}</p>
                                {a.services?.length > 0 ? (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {a.services.map((svc, si) => (
                                      <span key={si} className="text-[10px] font-semibold px-2 py-0.5 rounded-full border" style={{ background: cfg.bg, color: cfg.text, borderColor: cfg.border }}>{svc}</span>
                                    ))}
                                  </div>
                                ) : <p className="text-xs text-slate-400 mt-0.5">All services</p>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {selectedClient.notes && (
                    <div className={`border rounded-2xl p-5 col-span-2 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                      <h3 className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-3`}>Notes</h3>
                      <p className="text-sm text-slate-700 leading-relaxed">{selectedClient.notes}</p>
                    </div>
                  )}
                </div>
              )}

            </div>
          )}
          {/* ════════════════ END DETAILS TAB ════════════════ */}

          {/* ════════════════ ASSIGN TASK TAB ════════════════ */}
          {activeTab === 'tasks' && (
            <div className="p-6 space-y-6">

              {/* ── Quick Navigation Tabs ── */}
              <div className={`flex items-center gap-1 flex-wrap rounded-xl p-1.5 ${isDark ? 'bg-slate-700/60' : 'bg-slate-100/80'}`}>
                {[
                  { key: 'details',        label: 'Details',     icon: <User className="h-3 w-3" /> },
                  { key: 'invoices',       label: 'Invoices',    icon: <FileText className="h-3 w-3" /> },
                  { key: 'purchases',      label: 'Purchases',   icon: <IndianRupee className="h-3 w-3" /> },
                  { key: 'reconciliation', label: 'GST Recon',   icon: <ArrowLeftRight className="h-3 w-3" /> },
                  { key: 'govtfees',       label: 'Govt Fees',   icon: <IndianRupee className="h-3 w-3" /> },
                  { key: 'portal',         label: 'Portal',      icon: <Globe className="h-3 w-3" /> },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex items-center gap-1 h-7 px-3 rounded-lg text-[11px] font-semibold transition-all ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-600' : 'text-slate-500 hover:text-slate-700 hover:bg-white hover:shadow-sm'}`}
                  >
                    {tab.icon}{tab.label}
                  </button>
                ))}
              </div>

              {/* ── New Task Form ── */}
              <div className={`rounded-2xl border p-5 space-y-4 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-amber-50/60 border-amber-200'}`}>
                <h3 className={`text-sm font-bold uppercase tracking-widest flex items-center gap-2 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  <CheckSquare className="h-4 w-4" /> Assign New Task for {selectedClient?.company_name}
                </h3>

                {/* Title */}
                <div className="space-y-1.5">
                  <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Task Title <span className="text-red-500">*</span></Label>
                  <Input
                    value={taskForm.title}
                    onChange={e => setTaskForm(p => ({ ...p, title: e.target.value }))}
                    placeholder="Enter task title"
                    className={`h-10 text-sm ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300'}`}
                  />
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Description</Label>
                  <Textarea
                    value={taskForm.description}
                    onChange={e => setTaskForm(p => ({ ...p, description: e.target.value }))}
                    placeholder="Describe the task (use - for checklist items)..."
                    rows={3}
                    className={`text-sm resize-none ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300'}`}
                  />
                </div>

                {/* Row: Assignee + Due Date */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Assignee</Label>
                    <Select value={taskForm.assigned_to} onValueChange={v => setTaskForm(p => ({ ...p, assigned_to: v }))}>
                      <SelectTrigger className={`h-10 text-sm ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-300'}`}><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-52 overflow-y-auto">
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {(users || []).map(u => <SelectItem key={u.id} value={u.id}>{u.full_name || u.name || u.email}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Co-assignees</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className={`w-full h-10 text-sm justify-between ${isDark ? 'bg-slate-800 border-slate-600 text-white hover:bg-slate-700' : 'border-slate-300'}`}>
                          {taskForm.sub_assignees.length > 0 ? `${taskForm.sub_assignees.length} selected` : 'Select…'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 max-h-52 overflow-y-auto">
                        <div className="space-y-2">
                          {(users || []).filter(u => u.id !== taskForm.assigned_to).map(u => (
                            <label key={u.id} className="flex items-center gap-2 cursor-pointer">
                              <Checkbox
                                checked={taskForm.sub_assignees.includes(u.id)}
                                onCheckedChange={() => setTaskForm(p => ({
                                  ...p,
                                  sub_assignees: p.sub_assignees.includes(u.id)
                                    ? p.sub_assignees.filter(id => id !== u.id)
                                    : [...p.sub_assignees, u.id]
                                }))}
                              />
                              <span className="text-sm text-slate-700">{u.full_name || u.name || u.email}</span>
                            </label>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                {/* Due Date + Status */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Due Date</Label>
                    <Input
                      type="date"
                      value={taskForm.due_date}
                      onChange={e => setTaskForm(p => ({ ...p, due_date: e.target.value }))}
                      className={`h-10 text-sm ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-300'}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Status</Label>
                    <Select value={taskForm.status} onValueChange={v => setTaskForm(p => ({ ...p, status: v }))}>
                      <SelectTrigger className={`h-10 text-sm ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-300'}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">📋 To Do</SelectItem>
                        <SelectItem value="in_progress">⚡ In Progress</SelectItem>
                        <SelectItem value="completed">✅ Completed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Department (Category) */}
                <div className="space-y-1.5">
                  <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Department</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {CLIENT_TASK_DEPARTMENTS.map(dept => (
                      <button key={dept.value} type="button"
                        onClick={() => setTaskForm(p => ({ ...p, category: dept.value }))}
                        className={`h-7 px-3 rounded-lg text-xs font-semibold transition-all ${taskForm.category === dept.value ? 'text-white shadow-sm' : (isDark ? 'bg-slate-600 text-slate-300 hover:bg-slate-500' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}`}
                        style={taskForm.category === dept.value ? { background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' } : {}}>
                        {dept.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Priority */}
                <div className="space-y-1.5">
                  <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Priority</Label>
                  <Select value={taskForm.priority} onValueChange={v => setTaskForm(p => ({ ...p, priority: v }))}>
                    <SelectTrigger className={`h-10 text-sm ${isDark ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-300'}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">🟢 Low</SelectItem>
                      <SelectItem value="medium">🟡 Medium</SelectItem>
                      <SelectItem value="high">🔴 High</SelectItem>
                      <SelectItem value="critical">🚨 Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Recurring Task */}
                <div className={`border rounded-xl p-4 space-y-3 ${isDark ? 'border-slate-600 bg-slate-700/40' : 'border-slate-200 bg-slate-50'}`}
                  style={{ borderColor: taskForm.is_recurring ? '#1F6FB240' : undefined }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Repeat className="h-4 w-4 text-slate-500" />
                      <Label className="font-semibold text-sm">Recurring Task</Label>
                    </div>
                    <Switch checked={taskForm.is_recurring} onCheckedChange={c => setTaskForm(p => ({ ...p, is_recurring: c }))} />
                  </div>
                  {taskForm.is_recurring && (
                    <div className={`grid grid-cols-2 gap-3 pt-3 border-t ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
                      <div className="space-y-1.5">
                        <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Repeat</Label>
                        <Select value={taskForm.recurrence_pattern} onValueChange={v => setTaskForm(p => ({ ...p, recurrence_pattern: v }))}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>{CLIENT_TASK_RECURRENCE.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Every (interval)</Label>
                        <div className="flex items-center gap-2">
                          <Input type="number" min="1" max="365"
                            value={taskForm.recurrence_interval}
                            onChange={e => setTaskForm(p => ({ ...p, recurrence_interval: parseInt(e.target.value) || 1 }))}
                            className="w-20 h-9 text-sm"
                          />
                          <span className="text-xs text-slate-500">
                            {taskForm.recurrence_pattern === 'daily' && 'day(s)'}
                            {taskForm.recurrence_pattern === 'weekly' && 'week(s)'}
                            {taskForm.recurrence_pattern === 'monthly' && 'month(s)'}
                            {taskForm.recurrence_pattern === 'yearly' && 'year(s)'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <Button
                  onClick={handleTaskSubmit}
                  disabled={taskSaving || !taskForm.title.trim()}
                  className="w-full h-10 text-sm font-semibold rounded-xl text-white gap-2"
                  style={{ background: taskSaving || !taskForm.title.trim() ? '#94a3b8' : 'linear-gradient(135deg, #d97706, #f59e0b)' }}
                >
                  {taskSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Assigning...</> : <><CheckSquare className="h-4 w-4" /> Assign Task</>}
                </Button>
              </div>



            </div>
          )}
          {/* ════════════════ END ASSIGN TASK TAB ════════════════ */}

          {/* ════════════════ MERGE TAB ════════════════ */}
          {activeTab === 'merge' && canEditClients && (
            <div className="p-6 space-y-5">

              {/* Intro banner */}
              <div className={`flex items-start gap-3 p-4 rounded-2xl border ${isDark ? 'bg-violet-900/20 border-violet-700/50' : 'bg-violet-50 border-violet-200'}`}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #4F46E5, #7C3AED)' }}>
                  <Merge className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className={`text-sm font-bold ${isDark ? 'text-violet-200' : 'text-violet-800'}`}>Manual Client Merge</p>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-violet-300/70' : 'text-violet-600'}`}>
                    <strong>{selectedClient.company_name}</strong> will be kept as the primary. Search for a duplicate client below, review conflicting fields, then confirm the merge.
                  </p>
                </div>
              </div>

              {/* Step 1 — search for target */}
              <div>
                <p className={`text-xs font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Step 1 — Find the duplicate client</p>
                <div className="relative mb-2">
                  <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400" />
                  <input
                    value={mergeSearch}
                    onChange={e => { setMergeSearch(e.target.value); setMergeTargetId(null); setMergeFieldChoice({}); }}
                    placeholder="Search by name, phone or email…"
                    className={`w-full pl-9 pr-4 py-2 text-sm rounded-xl border outline-none transition-colors ${
                      isDark ? 'bg-slate-700 border-slate-600 text-slate-100 placeholder-slate-400 focus:border-violet-400' : 'bg-white border-slate-200 text-slate-700 placeholder-slate-400 focus:border-violet-400'
                    }`}
                  />
                </div>

                {/* Candidate list */}
                {mergeSearch.trim().length > 0 && (
                  <div className={`rounded-xl border overflow-hidden divide-y max-h-52 overflow-y-auto ${isDark ? 'border-slate-600 divide-slate-700' : 'border-slate-200 divide-slate-100'}`}>
                    {mergeSearching && (
                      <p className="text-xs text-slate-400 text-center py-4 animate-pulse">Searching…</p>
                    )}
                    {!mergeSearching && mergeCandidates.length === 0 && (
                      <p className="text-xs text-slate-400 text-center py-4">No clients found</p>
                    )}
                    {mergeCandidates.map(c => {
                      const isSelected = c.id === mergeTargetId;
                      const cfg2 = TYPE_CONFIG[c.client_type] || TYPE_CONFIG.proprietor;
                      return (
                        <button
                          key={c.id}
                          onClick={() => { setMergeTargetId(c.id); setMergeFieldChoice({}); }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all ${
                            isSelected
                              ? isDark ? 'bg-violet-900/40' : 'bg-violet-50'
                              : isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                            style={{ background: getAvatarGradient(c.company_name) }}>
                            {c.company_name?.charAt(0).toUpperCase() || '?'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{c.company_name}</p>
                            <p className="text-[10px] text-slate-400 truncate">{[c.phone, c.email, c.city].filter(Boolean).join(' · ')}</p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                              style={{ background: cfg2.bg, color: cfg2.text, border: `1px solid ${cfg2.border}` }}>
                              {cfg2.label}
                            </span>
                            {isSelected && (
                              <span className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: '#7C3AED' }}>
                                <Check className="w-3 h-3 text-white" />
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Step 2 — side-by-side comparison */}
              {mergeTarget && (
                <>
                  <div>
                    <p className={`text-xs font-bold uppercase tracking-widest mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Step 2 — Review &amp; choose values</p>

                    {/* Primary vs Secondary header */}
                    <div className={`grid grid-cols-2 gap-3 mb-3`}>
                      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-blue-400 ${isDark ? 'bg-blue-900/20' : 'bg-blue-50'}`}>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: getAvatarGradient(selectedClient.company_name) }}>
                          {selectedClient.company_name?.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className={`text-xs font-bold truncate ${isDark ? 'text-blue-200' : 'text-blue-800'}`}>{selectedClient.company_name}</p>
                          <p className="text-[9px] font-bold text-blue-500 uppercase tracking-wide">✓ PRIMARY — will be kept</p>
                        </div>
                      </div>
                      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-rose-300 ${isDark ? 'bg-rose-900/20' : 'bg-rose-50'}`}>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: getAvatarGradient(mergeTarget.company_name) }}>
                          {mergeTarget.company_name?.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className={`text-xs font-bold truncate ${isDark ? 'text-rose-200' : 'text-rose-800'}`}>{mergeTarget.company_name}</p>
                          <p className="text-[9px] font-bold text-rose-400 uppercase tracking-wide">✗ DUPLICATE — will be deleted</p>
                        </div>
                      </div>
                    </div>

                    {/* No conflicts */}
                    {mergeConflicts.length === 0 && (
                      <div className={`flex items-center gap-2 p-3 rounded-xl ${isDark ? 'bg-emerald-900/20 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}>
                        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        <p className="text-xs font-semibold">No conflicting fields — all data from the duplicate will be merged into the primary automatically.</p>
                      </div>
                    )}

                    {/* Conflict table */}
                    {mergeConflicts.length > 0 && (
                      <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                        <div className={`grid grid-cols-[100px_1fr_1fr] text-[10px] font-bold uppercase tracking-widest px-3 py-2 ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                          <span>Field</span>
                          <span className="text-blue-500">Primary (keep)</span>
                          <span className="text-rose-400">Duplicate</span>
                        </div>
                        {mergeConflicts.map((f, fi) => {
                          const pv = (selectedClient[f.key] || '').toString().trim() || '—';
                          const tv = (mergeTarget[f.key] || '').toString().trim() || '—';
                          const choice = mergeFieldChoice[f.key] || 'primary';
                          return (
                            <div key={f.key} className={`grid grid-cols-[100px_1fr_1fr] gap-2 px-3 py-2.5 items-start ${fi !== 0 ? `border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}` : ''}`}>
                              <span className={`text-[10px] font-bold pt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{f.label}</span>
                              <button
                                onClick={() => setMergeFieldChoice(prev => ({ ...prev, [f.key]: 'primary' }))}
                                className={`text-left px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
                                  choice === 'primary'
                                    ? isDark ? 'border-blue-400 bg-blue-900/40 text-blue-200 font-semibold' : 'border-blue-400 bg-blue-50 text-blue-700 font-semibold'
                                    : isDark ? 'border-slate-600 text-slate-400 hover:border-blue-500' : 'border-slate-200 text-slate-500 hover:border-blue-300'
                                }`}
                              >
                                {choice === 'primary' && <Check className="w-3 h-3 inline mr-1 flex-shrink-0" />}{pv}
                              </button>
                              <button
                                onClick={() => setMergeFieldChoice(prev => ({ ...prev, [f.key]: 'secondary' }))}
                                className={`text-left px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
                                  choice === 'secondary'
                                    ? isDark ? 'border-rose-400 bg-rose-900/40 text-rose-200 font-semibold' : 'border-rose-400 bg-rose-50 text-rose-700 font-semibold'
                                    : isDark ? 'border-slate-600 text-slate-400 hover:border-rose-400' : 'border-slate-200 text-slate-500 hover:border-rose-300'
                                }`}
                              >
                                {choice === 'secondary' && <Check className="w-3 h-3 inline mr-1 flex-shrink-0" />}{tv}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* What will be merged automatically */}
                  <div className={`p-3 rounded-xl text-xs border ${isDark ? 'bg-slate-700/40 border-slate-600 text-slate-300' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                    <p className="font-bold mb-1">Auto-merged (no conflict):</p>
                    <p className="opacity-80">Services • DSC details • Contact persons • Assignments • Tasks • Notes (appended)</p>
                  </div>

                  {/* Step 3 — confirm */}
                  <div>
                    <p className={`text-xs font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Step 3 — Confirm merge</p>
                    <button
                      disabled={mergeLoading}
                      onClick={async () => {
                        if (!window.confirm(`Merge "${mergeTarget.company_name}" INTO "${selectedClient.company_name}"?\n\nThe duplicate will be permanently deleted.`)) return;
                        setMergeLoading(true);
                        try {
                          await onMergeClients(selectedClient.id, [mergeTarget.id], buildOverrides());
                          setDetailDialogOpen(false);
                        } catch (e) {
                          toast.error(e?.response?.data?.detail || 'Merge failed');
                        } finally {
                          setMergeLoading(false);
                        }
                      }}
                      className="w-full flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-50"
                      style={{ background: mergeLoading ? '#9CA3AF' : 'linear-gradient(135deg, #4F46E5, #7C3AED)' }}
                    >
                      {mergeLoading
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Merging…</>
                        : <><Merge className="w-4 h-4" /> Merge "{mergeTarget.company_name}" into "{selectedClient.company_name}"</>
                      }
                    </button>
                    <p className={`text-[10px] text-center mt-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      This action cannot be undone · "{mergeTarget.company_name}" will be permanently deleted
                    </p>
                  </div>
                </>
              )}

              {/* Empty state — no search yet */}
              {!mergeSearch.trim() && !mergeTarget && (
                <div className={`flex flex-col items-center justify-center py-12 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Search className="w-10 h-10 mb-3 opacity-30" />
                  <p className="text-sm font-semibold">Search for a duplicate client above</p>
                  <p className="text-xs mt-1 opacity-70">Type a name, phone, or email to find the duplicate</p>
                </div>
              )}
            </div>
          )}
          {/* ════════════════ END MERGE TAB ════════════════ */}

        </div>

        {/* ── Footer ── */}
        <div className={`sticky bottom-0 flex items-center justify-between gap-2 p-6 border-t flex-shrink-0 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
          <Button type="button" variant="ghost" onClick={() => setDetailDialogOpen(false)} className="h-10 px-5 text-sm rounded-xl text-slate-500">Close</Button>
          <div className="flex gap-2">
            <Button
              onClick={() => setActiveTab('tasks')}
              className="h-10 px-4 text-sm rounded-xl text-white gap-2"
              style={{ background: 'linear-gradient(135deg, #d97706, #f59e0b)' }}
            >
              <CheckSquare className="h-4 w-4" /> Assign Task
            </Button>
            <Button
              onClick={() => setActiveTab('portal')}
              className="h-10 px-4 text-sm rounded-xl text-white gap-2"
              style={{ background: 'linear-gradient(135deg, #059669, #10b981)' }}
            >
              <Globe className="h-4 w-4" /> Portal
            </Button>
            <Button
              onClick={() => { setDetailDialogOpen(false); navigate('/gst-reconciliation'); }}
              className="h-10 px-4 text-sm rounded-xl text-white gap-2"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
            >
              <ArrowLeftRight className="h-4 w-4" /> GST Recon
            </Button>
            <Button onClick={() => { setDetailDialogOpen(false); openWhatsApp(selectedClient.phone, selectedClient.company_name); }} className="h-10 px-4 text-sm rounded-xl text-white gap-2" style={{ background: '#25D366' }}>
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </Button>
            {canEditClients && (
              <Button onClick={() => { setDetailDialogOpen(false); handleEdit(selectedClient); }} className="h-10 px-4 text-sm rounded-xl text-white gap-2" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                <Edit className="h-4 w-4" /> Edit
              </Button>
            )}
          </div>
        </div>

      </DialogContent>
    </Dialog>
  );
});
// ═══════════════════════════════════════════════════════════════════════════
// PAGINATION BAR — reusable
// ═══════════════════════════════════════════════════════════════════════════
const PaginationBar = React.memo(({ safePg, totalPgs, pageStart, pageSize, totalCount, onPageChange, isDark }) => {
  if (totalPgs <= 1) return null;
  const pageWindow = (() => {
    if (totalPgs <= 7) return Array.from({ length: totalPgs }, (_, i) => i + 1);
    if (safePg <= 4) return [1, 2, 3, 4, 5, '…', totalPgs];
    if (safePg >= totalPgs - 3) return [1, '…', totalPgs - 4, totalPgs - 3, totalPgs - 2, totalPgs - 1, totalPgs];
    return [1, '…', safePg - 1, safePg, safePg + 1, '…', totalPgs];
  })();
  return (
    <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{ borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}`, background: isDark ? '#1e293b' : '#F8FAFC' }}>
      <p style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', margin: 0 }}>
        <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{pageStart + 1}–{Math.min(pageStart + pageSize, totalCount)}</span> of <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{totalCount}</span> clients
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button onClick={() => onPageChange(p => Math.max(1, p - 1))} disabled={safePg === 1} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: safePg === 1 ? 'not-allowed' : 'pointer', background: isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9', color: safePg === 1 ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, opacity: safePg === 1 ? 0.4 : 1 }}>‹</button>
        {pageWindow.map((p, i) => p === '…'
          ? <span key={`e-${i}`} style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: isDark ? '#475569' : '#94a3b8' }}>…</span>
          : <button key={p} onClick={() => onPageChange(p)} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', background: p === safePg ? 'linear-gradient(135deg, #0D3B66, #1F6FB2)' : (isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9'), color: p === safePg ? '#ffffff' : (isDark ? '#94a3b8' : '#64748b'), fontSize: 11, fontWeight: p === safePg ? 700 : 500, boxShadow: p === safePg ? '0 2px 8px rgba(13,59,102,0.35)' : 'none' }}>{p}</button>
        )}
        <button onClick={() => onPageChange(p => Math.min(totalPgs, p + 1))} disabled={safePg === totalPgs} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: safePg === totalPgs ? 'not-allowed' : 'pointer', background: isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9', color: safePg === totalPgs ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, opacity: safePg === totalPgs ? 0.4 : 1 }}>›</button>
      </div>
      <p style={{ fontSize: 11, color: isDark ? '#475569' : '#cbd5e1', margin: 0 }}>Page {safePg} / {totalPgs}</p>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function Clients() {
  const { user, hasPermission } = useAuth();
  const isDark = useDark();
  const isAdmin           = user?.role === 'admin';
  const canViewAllClients = hasPermission("can_view_all_clients");
  const canDeleteData     = hasPermission("can_delete_data");
  const canAssignClients  = hasPermission("can_assign_clients");
  // can_edit_clients: true by default for Manager & User — gates Create/Edit actions
  // Admin always can edit; others need the flag OR to own the specific client (backend enforces)
  const canEditClients    = isAdmin || hasPermission("can_edit_clients");
  const navigate = useNavigate();
  const location = useLocation();
  const handleSendBirthdayWish = async (clientId, clientName) => {
  try {
    const res = await api.post(`/clients/${clientId}/send-birthday-wish`);
    const { sent_to, failed, no_email } = res.data;

    if (sent_to.length > 0) {
      toast.success(`Birthday wish sent to ${sent_to.join(', ')}`);
    }
    if (failed.length > 0) {
      toast.error(`Failed to send to: ${failed.join(', ')}`);
    }
    if (no_email.length > 0) {
      toast.warning(`No email found for: ${no_email.join(', ')}`);
    }
  } catch (err) {
    toast.error('Failed to send birthday wish');
  }
};

  // ── Data state ──────────────────────────────────────────────────────────
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [users, setUsers]     = useState([]);
  const [savedReferrers, setSavedReferrers] = useState([]);
  const [savedAuditors,  setSavedAuditors]  = useState([]);

  // ── UI state ────────────────────────────────────────────────────────────
  const [loading, setLoading]           = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  // ── AI Duplicate detection state ─────────────────────────────────────────
  const [showDupDialog,    setShowDupDialog]    = useState(false);
  const [dupGroups,        setDupGroups]        = useState([]);
  const [detectingDups,    setDetectingDups]    = useState(false);
  // ── Merge Clients state ──────────────────────────────────────────────────
  const [showMergeDialog,  setShowMergeDialog]  = useState(false);
  const [mergeDupGroups,   setMergeDupGroups]   = useState([]);
  const [mergeStartIdx,    setMergeStartIdx]    = useState(0);
  // ── Client Groups state ──────────────────────────────────────────────────
  const [showGroupsPanel,  setShowGroupsPanel]  = useState(false);
  const [activeGroupId,    setActiveGroupId]    = useState(null);
  const [clientGroupsData, setClientGroupsData] = useState([]);
  // ── Bulk select / delete state ────────────────────────────────────────────
  const [bulkSelectedIds,     setBulkSelectedIds]     = useState(new Set());
  const [bulkDeleteConfirm,   setBulkDeleteConfirm]   = useState(false);
  const [bulkDeleting,        setBulkDeleting]        = useState(false);
  // ── ITR Client state ─────────────────────────────────────────────────────
  const [itrDialogOpen,    setItrDialogOpen]    = useState(false);
  const [editingItrClient, setEditingItrClient] = useState(null);
  const [itrBulkImportOpen, setItrBulkImportOpen] = useState(false);
  const [dialogOpen, setDialogOpen]     = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [otherService, setOtherService] = useState('');
  const [selectedClient, setSelectedClient]   = useState(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [bulkMsgOpen, setBulkMsgOpen]   = useState(false);
  const [bulkMsgMode, setBulkMsgMode]   = useState('whatsapp');
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [referrerInput, setReferrerInput]       = useState('');
  const [referrerSelectValue, setReferrerSelectValue] = useState('');
  const [auditorInput, setAuditorInput]         = useState('');
  const [auditorSelectValue, setAuditorSelectValue] = useState('');
  const [bulkAuditorOpen, setBulkAuditorOpen]   = useState(false);
  const [mdsPreviewOpen, setMdsPreviewOpen]     = useState(false);
  const [mdsPreviewLoading, setMdsPreviewLoading] = useState(false);
  const [mdsData, setMdsData]       = useState(null);
  const [mdsForm, setMdsForm]       = useState(null);
  const [mdsRawInfoOpen, setMdsRawInfoOpen] = useState(false);
  const [gstImportOpen,    setGstImportOpen]    = useState(false);
  const [gstImportLoading, setGstImportLoading] = useState(false);
  const [gstImportError,   setGstImportError]   = useState('');
  // Unified smart import state
  const [smartImportOpen,    setSmartImportOpen]    = useState(false);
  const [smartImportLoading, setSmartImportLoading] = useState(false);
  const [smartImportError,   setSmartImportError]   = useState('');
  const [smartImportFiles,   setSmartImportFiles]   = useState({ gst: null, udyam: null, mca: null });
  const [addressTab,       setAddressTab]       = useState('primary'); // 'primary' | 'gst'
  const [previewData, setPreviewData]     = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewOpen, setPreviewOpen]     = useState(false);
  const [waClient, setWaClient]           = useState(null);
  const [waDialogOpen, setWaDialogOpen]   = useState(false);

  // ── Persisted preferences (inlined localStorage — avoids custom hook bundler issues) ──
  const [viewMode, setViewModeRaw] = useState(() => {
    try { return localStorage.getItem('clients_viewMode') || 'list'; } catch { return 'list'; }
  });
  const setViewMode = useCallback((v) => {
    setViewModeRaw(v);
    try { localStorage.setItem('clients_viewMode', v); } catch {}
  }, []);

  const [sortOrder, setSortOrderRaw] = useState(() => {
    try { return localStorage.getItem('clients_sortOrder') || 'lifo'; } catch { return 'lifo'; }
  });
  const setSortOrder = useCallback((v) => {
    setSortOrderRaw(v);
    try { localStorage.setItem('clients_sortOrder', v); } catch {}
  }, []);

  // ── Filter state ────────────────────────────────────────────────────────
  const [searchInput, setSearchInput]         = useState('');
  const [serviceFilter, setServiceFilter]     = useState('all');
  const [statusFilter, setStatusFilter]       = useState('all');
  const [assignedToFilter, setAssignedToFilter] = useState('all');
  const [clientTypeFilter, setClientTypeFilter] = useState('all');
  const [referredByFilter, setReferredByFilter] = useState('all');
  const [auditorFilter, setAuditorFilter]       = useState('all');
  const [itrTabActive, setItrTabActive] = useState(false);

  // Debounced search — inlined to avoid custom hook bundler issues
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const handler = setTimeout(() => setSearchTerm(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handler);
  }, [searchInput]);

  // ── Pagination ──────────────────────────────────────────────────────────
  const [boardPage, setBoardPage] = useState(1);
  const [listPage, setListPage]   = useState(1);

  // ── Form state ──────────────────────────────────────────────────────────
  const [formData, setFormData] = useState({
    company_name: '', client_type: 'proprietor', client_type_other: '',
    contact_persons: [{ name: '', email: '', phone: '', designation: '', birthday: '', din: '' }],
    email: '', phone: '', birthday: '', address: '', city: '', state: '', pincode: '', services: [],
    dsc_details: [], assignments: [{ ...EMPTY_ASSIGNMENT }], notes: '', status: 'active', referred_by: '', auditor: '',
    // Tax & Billing
    gstin: '', pan: '', gst_treatment: 'regular', place_of_supply: '',
    default_payment_terms: 'Due on receipt', credit_limit: '', opening_balance: '',
    opening_balance_type: 'Dr', tally_ledger_name: '', tally_group: 'Sundry Debtors',
    website: '', msme_number: '',
    gst_address: '',  // GST registered address (if different from MCA/primary address)
    gst_city: '',
    gst_state: '',
    gst_pin: '',       // PIN from GST certificate
    // MCA / ROC fields
    cin: '',
    llpin: '',
    date_of_incorporation: '',
    mca_fetch_date: '',
    mca_registration_number: '',
    mca_roc_name: '',
    mca_rd_name: '',
    mca_company_category: '',
    mca_company_subcategory: '',
    mca_listed: null,
    mca_active_compliance: '',
    mca_authorized_capital: '',
    mca_paid_up_capital: '',
    mca_last_agm_date: '',
    mca_balance_sheet_date: '',
    mca_books_address: '',
    mca_charges: [],
    mca_loan_details: [],
  });
  const [formErrors, setFormErrors]     = useState({});
  const [contactErrors, setContactErrors] = useState([]);
  const [mcaFetching, setMcaFetching]   = useState(false);
  const [mcaQuery, setMcaQuery]         = useState('');

  // Automatically load the company master record for corporate clients.
  // Existing records with mca_fetch_date are not repeatedly scraped.
  useEffect(() => {
    const corporateTypes = ['pvt_ltd', 'public_ltd', 'section_8'];
    if (!corporateTypes.includes(formData.client_type) || editingClient || formData.mca_fetch_date) return;
    const name = (formData.company_name || '').trim();
    if (name.length < 5) return;
    const timer = setTimeout(async () => {
      setMcaQuery(name);
      setMcaFetching(true);
      try {
        const d = normalizeMcaDetails((await api.get('/clients/fetch-mca-details', { params: { query: name } })).data || {});
        if (!d) return;
        setFormData(p => ({
          ...p,
          company_name: d.company_name || p.company_name,
          client_type: d.client_type || p.client_type,
          date_of_incorporation: d.date_of_incorporation || p.date_of_incorporation || '',
          cin: d.cin || p.cin || '',
          llpin: d.llpin || p.llpin || '',
          address: d.address || p.address || '',
          city: d.city || p.city || '',
          state: d.state || p.state || '',
          pincode: d.pin || p.pincode || '',
          email: d.email || p.email || '',
          pan: d.pan || p.pan || '',
          mca_fetch_date: d.mca_fetch_date || new Date().toISOString().slice(0, 10),
          mca_registration_number: d.registration_number || p.mca_registration_number || '',
          mca_roc_name: d.roc_name || p.mca_roc_name || '',
          mca_rd_name: d.rd_name || p.mca_rd_name || '',
          mca_company_category: d.company_category || p.mca_company_category || '',
          mca_company_subcategory: d.company_subcategory || p.mca_company_subcategory || '',
          mca_listed: typeof d.listed === 'boolean' ? d.listed : p.mca_listed,
          mca_active_compliance: d.active_compliance || p.mca_active_compliance || '',
          mca_authorized_capital: d.authorized_capital || p.mca_authorized_capital || '',
          mca_paid_up_capital: d.paid_up_capital || p.mca_paid_up_capital || '',
          mca_last_agm_date: d.last_agm_date || p.mca_last_agm_date || '',
          mca_balance_sheet_date: d.balance_sheet_date || p.mca_balance_sheet_date || '',
          mca_books_address: d.books_address || p.mca_books_address || '',
          mca_charges: d.charges.length ? d.charges : (p.mca_charges || []),
          mca_loan_details: d.loan_details.length ? d.loan_details : (p.mca_loan_details || []),
          contact_persons: d.directors.length
            ? d.directors.map(dir => ({ name: dir.name || '', designation: dir.designation || 'Director', din: dir.din || '', email: '', phone: '', birthday: '' }))
            : p.contact_persons,
        }));
        toast.success('Company master data auto-filled');
      } catch (_) {
        // External company lookup failure must not block manual client creation.
      } finally {
        setMcaFetching(false);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [formData.client_type, formData.company_name, editingClient, formData.mca_fetch_date]);

  // ── Minimize/restore: shrink the Add/Edit Client form to the global dock so
  // it can be resumed later (e.g. after checking something on another page).
  const clientFormKey = editingClient ? `create-client-${editingClient.id}` : 'create-client-new';
  const { minimize: minimizeClientForm } = useFormMinimizer({
    formKey: clientFormKey,
    title: formData.company_name ? `Client: ${formData.company_name}` : (editingClient ? 'Edit Client' : 'New Client'),
    subtitle: editingClient ? 'Editing' : 'Creating',
    path: '/clients',
    icon: 'Building2',
    data: { formData, editingClientId: editingClient?.id || null },
    onRestore: (data) => {
      if (data.formData) setFormData(data.formData);
      if (data.editingClientId) {
        const found = clients.find((c) => c.id === data.editingClientId);
        if (found) setEditingClient(found);
      } else {
        setEditingClient(null);
      }
      setDialogOpen(true);
    },
  });

  // ── Refs ────────────────────────────────────────────────────────────────
  const fileInputRef  = useRef(null);
  const excelInputRef = useRef(null);
  const gstInputRef   = useRef(null)
  const udyamInputRef = useRef(null);
  const mcaSmartRef   = useRef(null);
  const searchRef     = useRef(null);
  // pending delete undo ref
  const pendingDeleteRef = useRef(null);

  // ── Style helpers ────────────────────────────────────────────────────────
  const fieldCls = (hasError) => `h-11 rounded-xl text-sm transition-colors ${hasError ? 'border-red-400 focus:border-red-400 focus:ring-red-100' : 'border-slate-200 focus:border-blue-400 focus:ring-blue-50'}`;
  const labelCls = "text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block";
  const mdsFieldCls = "h-10 rounded-xl text-sm border-slate-200 focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-colors w-full px-3 border";

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Ctrl/Cmd + K → focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      // N → open new client (only when no dialog/input is focused)
      if (e.key === 'n' && !dialogOpen && !detailDialogOpen && !bulkMsgOpen && document.activeElement.tagName === 'BODY') {
        openAddDialog();
      }
      // Escape → clear search if focused
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearchInput('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dialogOpen, detailDialogOpen, bulkMsgOpen]);

  // ── Data fetching ────────────────────────────────────────────────────────
  // ── Paginated client loader ─────────────────────────────────────────────
  // Page 1 (100 clients) loads immediately so the list is interactive fast.
  // Pages 2+ are fetched silently in the background.
  const [allClientsFetched, setAllClientsFetched] = useState(false);
  const PAGE_SIZE = 100;

  const fetchClients = useCallback(async () => {
    setClientsLoading(true);
    setAllClientsFetched(false);
    try {
      // First page — render immediately
      const r1 = await api.get('/clients', { params: { page: 1, page_size: PAGE_SIZE } });
      const firstPage = r1.data || [];
      setClients(firstPage);
      setClientsLoading(false);

      if (firstPage.length < PAGE_SIZE) {
        setAllClientsFetched(true);
        return;
      }

      // Background: fetch remaining pages
      let page = 2;
      while (true) {
        const r = await api.get('/clients', { params: { page, page_size: PAGE_SIZE } });
        const batch = r.data || [];
        if (batch.length > 0) {
          setClients(prev => {
            const existingIds = new Set(prev.map(c => c.id));
            const fresh = batch.filter(c => !existingIds.has(c.id));
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        }
        if (batch.length < PAGE_SIZE) {
          setAllClientsFetched(true);
          break;
        }
        page++;
      }
    } catch {
      toast.error('Failed to fetch clients');
      setClientsLoading(false);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try { const r = await api.get('/users'); setUsers(r.data); }
    catch (e) { console.error('Failed to fetch users:', e); }
  }, []);

  const fetchReferrers = useCallback(async () => {
    try {
      const r = await api.get('/referrers');
      setSavedReferrers((r.data || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean));
    } catch {
      try { setSavedReferrers(JSON.parse(localStorage.getItem('taskosphere_referrers') || '[]').map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean)); }
      catch { setSavedReferrers([]); }
    }
  }, []);

  const fetchAuditors = useCallback(async () => {
    try {
      const r = await api.get('/auditors');
      setSavedAuditors((r.data || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean));
    } catch {
      try { setSavedAuditors(JSON.parse(localStorage.getItem('taskosphere_auditors') || '[]').map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean)); }
      catch { setSavedAuditors([]); }
    }
  }, []);

  useEffect(() => {
    fetchClients(); fetchUsers(); fetchReferrers(); fetchAuditors();
    const params = new URLSearchParams(location.search);
    if (params.get("openAddClient") === "true") setDialogOpen(true);
  }, [location]);

  // Open the client referenced by a notification deep-link. The client list
  // loads in pages, so this effect also runs as background pages arrive.
  useEffect(() => {
    const clientId = new URLSearchParams(location.search).get("clientId");
    if (!clientId || clients.length === 0) return;

    const client = clients.find((item) => String(item.id) === String(clientId));
    if (!client) return;

    setSelectedClient(client);
    setDetailDialogOpen(true);
    // Consume the one-shot deep-link so closing the detail popup does not
    // reopen it and the URL stays clean for refresh/bookmarking.
    navigate(location.pathname, { replace: true });
  }, [location, clients, navigate]);

  // ── Referrer sync ────────────────────────────────────────────────────────
  useEffect(() => {
    const val = formData.referred_by;
    if (!val) { setReferrerSelectValue(''); setReferrerInput(''); }
    else if (val === 'Our Client') { setReferrerSelectValue('Our Client'); setReferrerInput(''); }
    else if (savedReferrers.includes(val)) { setReferrerSelectValue(val); setReferrerInput(''); }
    else { setReferrerSelectValue('__other__'); setReferrerInput(val); }
  }, [formData.referred_by, savedReferrers]);

  // ── Auditor sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    const val = formData.auditor;
    if (!val) { setAuditorSelectValue(''); setAuditorInput(''); }
    else if (savedAuditors.includes(val)) { setAuditorSelectValue(val); setAuditorInput(''); }
    else { setAuditorSelectValue('__other__'); setAuditorInput(val); }
  }, [formData.auditor, savedAuditors]);

  const saveReferrer = useCallback(async (name) => {
    const t = name?.trim();
    if (!t) return t;
    const existing = savedReferrers.find(r => r.toLowerCase() === t.toLowerCase());
    if (existing) return existing;
    const updated = [...savedReferrers, t];
    setSavedReferrers(updated);
    try { await api.post('/referrers', { name: t }); }
    catch { localStorage.setItem('taskosphere_referrers', JSON.stringify(updated)); }
    return t;
  }, [savedReferrers]);

  const saveAuditor = useCallback(async (name) => {
    const t = name?.trim();
    if (!t) return t;
    const existing = savedAuditors.find(a => a.toLowerCase() === t.toLowerCase());
    if (existing) return existing;
    const updated = [...savedAuditors, t];
    setSavedAuditors(updated);
    try { await api.post('/auditors', { name: t }); }
    catch { localStorage.setItem('taskosphere_auditors', JSON.stringify(updated)); }
    return t;
  }, [savedAuditors]);

  // ── Filter & sort ────────────────────────────────────────────────────────
  const filteredClients = useMemo(() => clients.filter(c => {
    // ITR tab: show only ITR clients
    if (itrTabActive && !c?.is_itr_client) return false;

    // Group filter
    if (activeGroupId) {
      const grp = clientGroupsData.find(g => g.id === activeGroupId);
      if (!grp || !(grp.client_ids || []).includes(c.id)) return false;
    }

    const q = searchTerm.toLowerCase();
    if (q) {
      const nameMatch = (c?.company_name || '').toLowerCase().includes(q);
      const emailMatch = (c?.email || '').toLowerCase().includes(q);
      const phoneMatch = (c?.phone || '').includes(searchTerm);
      // Also match linked company names stored in itr_data.company_links
      const linkedMatch = (c?.itr_data?.company_links || []).some(l =>
        (l.company_name || '').toLowerCase().includes(q)
      );
      if (!nameMatch && !emailMatch && !phoneMatch && !linkedMatch) return false;
    }
    if (serviceFilter !== 'all' && !(c?.services ?? []).some(s => (s || '').toLowerCase().includes(serviceFilter.toLowerCase()))) return false;
    if (statusFilter !== 'all' && (c?.status || 'active') !== statusFilter) return false;
    if (!itrTabActive && clientTypeFilter !== 'all' && normalizeClientType(c?.client_type) !== normalizeClientType(clientTypeFilter)) return false;
    if (referredByFilter !== 'all' && (c?.referred_by || '') !== referredByFilter) return false;
    if (auditorFilter !== 'all' && (c?.auditor || '') !== auditorFilter) return false;
    if (assignedToFilter !== 'all') {
      const assignments = c?.assignments || [];
      const legacy = c?.assigned_to;
      const matched = assignments.length > 0 ? assignments.some(a => a.user_id === assignedToFilter) : legacy === assignedToFilter;
      if (!matched) return false;
    }
    return true;
  }), [clients, searchTerm, serviceFilter, statusFilter, assignedToFilter, clientTypeFilter, referredByFilter, auditorFilter, itrTabActive, activeGroupId, clientGroupsData]);

  const sortedClients = useMemo(() => {
    const arr = [...filteredClients];
    if (sortOrder === 'az') return arr.sort((a, b) => (a.company_name || '').toLowerCase().localeCompare((b.company_name || '').toLowerCase()));
    if (sortOrder === 'za') return arr.sort((a, b) => (b.company_name || '').toLowerCase().localeCompare((a.company_name || '').toLowerCase()));
    return arr.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return sortOrder === 'fifo' ? ta - tb : tb - ta;
    });
  }, [filteredClients, sortOrder]);

  useEffect(() => { setBoardPage(1); setListPage(1); }, [searchTerm, serviceFilter, statusFilter, assignedToFilter, clientTypeFilter, referredByFilter, auditorFilter, sortOrder, clients, itrTabActive, activeGroupId]);

  // ── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const totalClients  = filteredClients.length;
    const activeClients = filteredClients.filter(c => (c?.status || 'active') === 'active').length;
    const serviceCounts = {};
    const typeCounts = {};
    filteredClients.forEach(c => {
      const type = normalizeClientType(c?.client_type);
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      (c?.services || []).forEach(s => {
        const n = s?.startsWith('Other:') ? 'Other' : s;
        serviceCounts[n] = (serviceCounts[n] || 0) + 1;
      });
    });
    return { totalClients, activeClients, serviceCounts, typeCounts };
  }, [filteredClients]);

  // ── DSC alert — clients with DSC expiring within 30 days ─────────────────
  const dscAlerts = useMemo(() => {
    const alerts = [];
    clients.forEach(c => {
      (c.dsc_details || []).forEach(d => {
        const days = getDscDaysLeft(d.expiry_date);
        if (days !== null && days >= 0 && days <= 30) {
          alerts.push({ client: c, dsc: d, days });
        }
      });
    });
    return alerts.sort((a, b) => a.days - b.days);
  }, [clients]);

  // ── Birthday reminders ────────────────────────────────────────────────────
  const todayReminders = useMemo(() => {
    const today = startOfDay(new Date());
    return clients.filter(c => c?.contact_persons?.some(cp => {
      if (!cp?.birthday) return false;
      const bday = new Date(cp.birthday);
      return bday.getMonth() === today.getMonth() && bday.getDate() === today.getDate();
    }) ?? false);
  }, [clients]);

  // ── Helpers ─────────────────────────────────────────────────────────────
  const getClientNumber = useCallback((index) => String(index + 1).padStart(3, '0'), []);

  const getClientAssignments = useCallback((client) => {
    if (client?.assignments?.length > 0) return client.assignments;
    if (client?.assigned_to) return [{ user_id: client.assigned_to, services: [] }];
    return [];
  }, []);

  const openWhatsApp = useCallback((phone, name = "") => {
    const cleanPhone = phone?.replace(/\D/g, '') || '';
    window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hello ${name}, this is Manthan Desai's office regarding your services.`)}`, '_blank');
  }, []);

  const handleWhatsAppClient = useCallback((client) => {
    setWaClient(client);
    setWaDialogOpen(true);
  }, []);

  // ── AI Duplicate Detection ────────────────────────────────────────────────
  const handleDetectClientDuplicates = useCallback(() => {
    if (detectingDups) return;
    setDetectingDups(true);
    // Run async so spinner renders first
    setTimeout(() => {
      try {
        const dupeGroups = detectClientDuplicates(clients);
        const relatedGroups = detectRelatedClients(clients);
        const groups = [...dupeGroups, ...relatedGroups];
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) {
          toast.success(`Scanned ${clients.length} clients — no duplicates or related clients found ✓`);
        } else {
          const dCount = dupeGroups.filter((g) => g.confidence === 'duplicate').length;
          const pCount = dupeGroups.filter((g) => g.confidence === 'possible').length;
          const rCount = relatedGroups.length;
          const parts = [];
          if (dCount) parts.push(`${dCount} duplicate`);
          if (pCount) parts.push(`${pCount} possible`);
          if (rCount) parts.push(`${rCount} related`);
          toast.info(`Found ${parts.join(', ')} client group${groups.length !== 1 ? 's' : ''}`);
        }
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('Client duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  }, [clients, detectingDups]);

  // ── Merge Duplicates ──────────────────────────────────────────────────────
  const handleOpenMerge = useCallback(() => {
    if (detectingDups) return;
    setDetectingDups(true);
    setTimeout(() => {
      try {
        const groups = detectClientDuplicates(clients);
        if (!groups.length) {
          toast.success(`Scanned ${clients.length} clients — no duplicates found ✓`);
        } else {
          setMergeDupGroups(groups);
          setShowMergeDialog(true);
        }
      } catch (e) {
        toast.error('Duplicate scan failed.');
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  }, [clients, detectingDups]);

  const handleMergeClients = useCallback(async (primaryId, secondaryIds, fieldOverrides) => {
    await api.post('/clients/merge', { primary_id: primaryId, secondary_ids: secondaryIds, field_overrides: fieldOverrides });
    await fetchClients();
  }, [fetchClients]);

  // ── Client Groups ─────────────────────────────────────────────────────────
  const fetchClientGroups = useCallback(async () => {
    try {
      const r = await api.get('/client-groups');
      setClientGroupsData(r.data || []);
    } catch (e) {
      // silent — groups are optional
    }
  }, []);

  useEffect(() => { fetchClientGroups(); }, [fetchClientGroups]);

  // ── Export filtered list ──────────────────────────────────────────────────
  const handleExportList = useCallback(async () => {
    if (sortedClients.length === 0) { toast.error('No clients to export'); return; }
    const rows = [
      ['#', 'Company', 'Type', 'Email', 'Phone', 'City', 'State', 'Services', 'Status', 'Referred By', 'Added'],
      ...sortedClients.map((c, i) => [
        i + 1, c.company_name, c.client_type, c.email || '', c.phone || '',
        c.city || '', c.state || '',
        (c.services || []).join(', '),
        c.status || 'active', c.referred_by || '',
        c.created_at ? format(new Date(c.created_at), 'dd-MMM-yyyy') : '',
      ]),
    ];
    const XLSX = await getXLSX();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Clients');
    XLSX.writeFile(wb, `clients_export_${format(new Date(), 'dd-MMM-yyyy')}.xlsx`);
    toast.success(`Exported ${sortedClients.length} clients to Excel`);
  }, [sortedClients]);
  const handleExportCSV = useCallback(() => {
    if (sortedClients.length === 0) { toast.error('No clients to export'); return; }
    const headers = ['#', 'Company', 'Type', 'Email', 'Phone', 'City', 'State', 'Services', 'Status', 'Referred By', 'Added'];
    const rows = sortedClients.map((c, i) => [
      i + 1, c.company_name, c.client_type, c.email || '', c.phone || '',
      c.city || '', c.state || '', (c.services || []).join(', '),
      c.status || 'active', c.referred_by || '',
      c.created_at ? format(new Date(c.created_at), 'dd-MMM-yyyy') : '',
    ]);
    const csv = Papa.unparse([headers, ...rows], { newline: '\r\n' });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clients_export_${format(new Date(), 'dd-MMM-yyyy')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${sortedClients.length} clients to CSV`);
  }, [sortedClients]);

  // ── Delete with undo ────────────────────────────────────────────────────
  const handleDelete = useCallback((client) => {
    // Optimistic remove
    setClients(prev => prev.filter(c => c.id !== client.id));
    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled) return;
      try { await api.delete(`/clients/${client.id}`); }
      catch { toast.error('Delete failed — restoring client'); setClients(prev => [client, ...prev]); }
    }, UNDO_DELAY_MS);

    pendingDeleteRef.current = { cancel: () => { cancelled = true; clearTimeout(timer); setClients(prev => { if (prev.find(c => c.id === client.id)) return prev; return [client, ...prev]; }); } };

    toast(`"${client.company_name}" deleted`, {
      duration: UNDO_DELAY_MS,
      action: { label: 'Undo', onClick: () => { pendingDeleteRef.current?.cancel(); toast.success('Delete cancelled'); } },
    });
  }, []);

  // ── Bulk select helpers ──────────────────────────────────────────────────
  const toggleBulkSelect = useCallback((clientId, e) => {
    e.stopPropagation();
    setBulkSelectedIds(prev => {
      const next = new Set(prev);
      next.has(clientId) ? next.delete(clientId) : next.add(clientId);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback((pageClients) => {
    const allSelected = pageClients.every(c => bulkSelectedIds.has(c.id));
    if (allSelected) {
      setBulkSelectedIds(prev => {
        const next = new Set(prev);
        pageClients.forEach(c => next.delete(c.id));
        return next;
      });
    } else {
      setBulkSelectedIds(prev => {
        const next = new Set(prev);
        pageClients.forEach(c => next.add(c.id));
        return next;
      });
    }
  }, [bulkSelectedIds]);

  const clearBulkSelection = useCallback(() => setBulkSelectedIds(new Set()), []);

  // ── Bulk delete handler ──────────────────────────────────────────────────
  const handleBulkDelete = useCallback(async () => {
    if (bulkSelectedIds.size === 0) return;
    setBulkDeleting(true);
    const ids = [...bulkSelectedIds];
    // Optimistically remove from UI
    setClients(prev => prev.filter(c => !ids.includes(c.id)));
    setBulkSelectedIds(new Set());
    setBulkDeleteConfirm(false);
    let failed = 0;
    for (const id of ids) {
      try { await api.delete(`/clients/${id}`); }
      catch { failed++; }
    }
    setBulkDeleting(false);
    if (failed > 0) {
      toast.error(`${failed} client(s) could not be deleted — refresh to check`);
      fetchClients();
    } else {
      toast.success(`${ids.length} client${ids.length !== 1 ? 's' : ''} deleted`);
    }
  }, [bulkSelectedIds, fetchClients]);

  // ── Validate form ────────────────────────────────────────────────────────
  const validateForm = useCallback(() => {
    const errors = {};
    const cErrors = [];
    if (!formData.company_name?.trim() || formData.company_name.trim().length < 3) errors.company_name = 'Company name must be at least 3 characters';
    const em = formData.email?.trim();
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) errors.email = 'Please enter a valid email address';
    const cleanPhone = formData.phone ? formData.phone.replace(/\D/g, '') : '';
    if (cleanPhone && cleanPhone.length !== 10) errors.phone = 'Phone number must be exactly 10 digits (or leave blank)';
    formData.contact_persons.forEach((cp, idx) => {
      const contactErr = {};
      const n = cp.name?.trim();
      if (!n && (cp.email?.trim() || cp.phone?.trim() || cp.designation?.trim() || cp.birthday || cp.din?.trim())) contactErr.name = 'Contact name is required';
      if (cp.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cp.email.trim())) contactErr.email = 'Invalid email format';
      const cPhone = cp.phone ? cp.phone.replace(/\D/g, '') : '';
      if (cPhone && cPhone.length !== 10) contactErr.phone = 'Phone must be 10 digits';
      if (Object.keys(contactErr).length > 0) cErrors[idx] = contactErr;
    });
    // Duplicate email check
    const allEmails = new Set();
    if (em) allEmails.add(em.toLowerCase());
    formData.contact_persons.forEach(cp => { if (cp.email?.trim()) allEmails.add(cp.email.trim().toLowerCase()); });
    if (allEmails.size !== (em ? 1 : 0) + formData.contact_persons.filter(cp => cp.email?.trim()).length) errors.email = (errors.email || '') + ' (duplicate email detected)';
    setFormErrors(errors); setContactErrors(cErrors);
    return { valid: Object.keys(errors).length === 0 && cErrors.length === 0, errors, cErrors };
  }, [formData]);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    const { valid } = validateForm();
    if (!valid) {
      toast.error('Please fix the highlighted errors before saving');
      // Scroll to first error
      setTimeout(() => { document.querySelector('[data-field-error]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50);
      return;
    }
    setLoading(true);
    try {
      let finalServices = formData.services.filter(s => !s.startsWith('Other:'));
      if (otherService.trim() && formData.services.includes('Other')) finalServices.push(`Other: ${otherService.trim()}`);
      const cleanPhone = formData.phone ? formData.phone.replace(/\D/g, '') : '';
      const cleanedContacts = formData.contact_persons.filter(cp => cp.name?.trim()).map(cp => ({
        name: cp.name.trim(), designation: cp.designation?.trim() || null,
        email: cp.email?.trim() || null, phone: cp.phone ? (cp.phone.replace(/\D/g, '') || null) : null,
        birthday: safeDate(cp.birthday) || null, din: cp.din?.trim() || null,
      }));
      const cleanedDSC = formData.dsc_details.map(dsc => ({
        certificate_number: dsc.certificate_number?.trim() || '', holder_name: dsc.holder_name?.trim() || '',
        issue_date: safeDate(dsc.issue_date), expiry_date: safeDate(dsc.expiry_date), notes: dsc.notes?.trim() || null,
      }));
      const cleanedAssignments = (formData.assignments || []).filter(a => a.user_id && a.user_id !== 'unassigned').map(a => ({ user_id: a.user_id, services: a.services || [] }));
      const finalReferredBy = formData.referred_by?.trim() || null;
      if (finalReferredBy && finalReferredBy !== 'Our Client' && !savedReferrers.includes(finalReferredBy)) await saveReferrer(finalReferredBy);
      const finalAuditor = formData.auditor?.trim() || null;
      if (finalAuditor && !savedAuditors.includes(finalAuditor)) await saveAuditor(finalAuditor);
      
      const payload = {
        company_name: formData.company_name.trim(), client_type: formData.client_type,
        ...(formData.client_type === 'other' ? { client_type_label: formData.client_type_other?.trim() || 'Other' } : { client_type_label: null }),
        email: trimmedEmail(formData.email), phone: cleanPhone || null,
        birthday: safeDate(formData.birthday) || null, address: formData.address?.trim() || null,
        city: formData.city?.trim() || null, state: formData.state?.trim() || null,
        pincode: formData.pincode?.trim() || null,
        services: finalServices, notes: formData.notes?.trim() || null,
        assigned_to: cleanedAssignments[0]?.user_id || null, assignments: cleanedAssignments,
        status: formData.status, contact_persons: cleanedContacts, dsc_details: cleanedDSC,
        referred_by: finalReferredBy || null,
        auditor: finalAuditor || null,
        // Tax & Billing
        gstin: formData.gstin?.trim().toUpperCase() || null,
        pan: formData.pan?.trim().toUpperCase() || null,
        gst_treatment: formData.gst_treatment || 'regular',
        place_of_supply: formData.place_of_supply?.trim() || null,
        default_payment_terms: formData.default_payment_terms || 'Due on receipt',
        credit_limit: formData.credit_limit ? Number(formData.credit_limit) : null,
        opening_balance: formData.opening_balance ? Number(formData.opening_balance) : null,
        opening_balance_type: formData.opening_balance_type || 'Dr',
        tally_ledger_name: formData.tally_ledger_name?.trim() || null,
        tally_group: formData.tally_group || 'Sundry Debtors',
        website: formData.website?.trim() || null,
        msme_number: formData.msme_number?.trim() || null,
        gst_address: formData.gst_address?.trim() || null,
        gst_city:    formData.gst_city?.trim()    || null,
        gst_state:   formData.gst_state?.trim()   || null,
        gst_pin:     formData.gst_pin?.trim()      || null,
        // MCA / ROC
        cin:             formData.cin?.trim().toUpperCase()   || null,
        llpin:           formData.llpin?.trim().toUpperCase() || null,
        proprietor_name: formData.proprietor_name?.trim()     || null,
        mca_fetch_date: formData.mca_fetch_date || null,
        date_of_incorporation: formData.date_of_incorporation || null,
        mca_registration_number: formData.mca_registration_number || null,
        mca_roc_name: formData.mca_roc_name || null,
        mca_rd_name: formData.mca_rd_name || null,
        mca_company_category: formData.mca_company_category || null,
        mca_company_subcategory: formData.mca_company_subcategory || null,
        mca_listed: typeof formData.mca_listed === 'boolean' ? formData.mca_listed : null,
        mca_active_compliance: formData.mca_active_compliance || null,
        mca_authorized_capital: formData.mca_authorized_capital || null,
        mca_paid_up_capital: formData.mca_paid_up_capital || null,
        mca_last_agm_date: formData.mca_last_agm_date || null,
        mca_balance_sheet_date: formData.mca_balance_sheet_date || null,
        mca_books_address: formData.mca_books_address || null,
        mca_charges: Array.isArray(formData.mca_charges) ? formData.mca_charges : [],
        mca_loan_details: Array.isArray(formData.mca_loan_details) ? formData.mca_loan_details : [],
      };
      if (!editingClient) {
        // Duplicate check: flag only when GSTIN matches (same tax entity),
        // OR when both name AND client_type are identical (same business type).
        // A "MAHALAXMI MEDICAL" proprietorship and a "MAHALAXMI MEDICAL" partnership
        // are legally different entities and must be allowed to coexist.
        const newGstin = payload.gstin?.trim().toUpperCase();
        const newName  = payload.company_name?.toLowerCase().trim();
        const newType  = payload.client_type?.toLowerCase().trim();

        const dup = clients.find(c => {
          const existingGstin = c.gstin?.trim().toUpperCase();
          const existingName  = c.company_name?.toLowerCase().trim();
          const existingType  = c.client_type?.toLowerCase().trim();

          // 1. Same GSTIN → definite duplicate (same tax registration)
          if (newGstin && existingGstin && newGstin === existingGstin) return true;

          // 2. Same name AND same constitution → likely duplicate
          if (newName && existingName === newName && newType && existingType === newType) return true;

          return false;
        });

        if (dup) {
          const reason = dup.gstin?.trim().toUpperCase() === newGstin
            ? `GSTIN ${newGstin} is already registered`
            : `"${payload.company_name}" (${payload.client_type}) already exists`;
          toast.error(reason);
          setLoading(false);
          return;
        }
      }
      if (editingClient) await api.put(`/clients/${editingClient.id}`, payload);
      else await api.post('/clients', payload);
      if (!editingClient) { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
      setDialogOpen(false); resetForm(); fetchClients();
      toast.success(editingClient ? 'Client updated!' : 'Client created!');
      // Sync updated client details to all linked invoices (non-fatal)
      if (editingClient) {
        try {
          await api.patch(`/invoices/sync-client/${editingClient.id}`, {
            client_name:    payload.company_name,
            client_gstin:   payload.gstin   || '',
            client_phone:   cleanPhone      || '',
            client_email:   payload.email   || '',
            client_address: payload.address || '',
            client_state:   payload.state   || '',
          });
        } catch { /* non-fatal */ }
      }

      // ── Backfill any blank fields on linked PassVault entries ─────────
      if (editingClient) {
        backfillPassvaultFromClient({ ...editingClient, ...payload });
      }
    } catch (error) {
      const detail = error.response?.data?.detail;
      if (Array.isArray(detail)) toast.error(detail.map(e => `${e.loc?.slice(-1)[0]}: ${e.msg}`).join(' | '));
      else toast.error(detail || 'Error saving client');
    }
    finally { setLoading(false); }
  }, [formData, otherService, editingClient, clients, savedReferrers, validateForm, saveReferrer, fetchClients]);

  // ── Edit ──────────────────────────────────────────────────────────────────
  const handleEdit = useCallback((client) => {
    setEditingClient(client);
    let assignments = client?.assignments || [];
    if (assignments.length === 0 && client?.assigned_to) assignments = [{ user_id: client.assigned_to, services: [] }];
    if (assignments.length === 0) assignments = [{ ...EMPTY_ASSIGNMENT }];
    setFormData({
      ...client,
      client_type_other: client?.client_type === 'other' ? (client?.client_type_label || '') : '',
      contact_persons: client?.contact_persons?.length > 0
        ? client.contact_persons.map(cp => ({ ...cp, birthday: cp?.birthday ? format(new Date(cp.birthday), 'yyyy-MM-dd') : '', din: cp?.din || '' }))
        : [{ name: '', email: '', phone: '', designation: '', birthday: '', din: '' }],
      birthday: client?.birthday ? format(new Date(client.birthday), 'yyyy-MM-dd') : '',
      dsc_details: (client?.dsc_details || []).map(d => ({ ...d, issue_date: d?.issue_date ? format(new Date(d.issue_date), 'yyyy-MM-dd') : '', expiry_date: d?.expiry_date ? format(new Date(d.expiry_date), 'yyyy-MM-dd') : '' })),
      status: client?.status || 'active', assignments, referred_by: client?.referred_by || '', auditor: client?.auditor || '',
    });
    const other = client?.services?.find(s => s.startsWith('Other: '));
    setOtherService(other ? other.replace('Other: ', '') : '');
    setDialogOpen(true); setFormErrors({}); setContactErrors([]);

    // ── Autofill any BLANK client fields from linked PassVault entries ──
    fetchPassvaultFillForClient(client).then(patch => {
      if (!patch || Object.keys(patch).length === 0) return;
      setFormData(prev => {
        const merged = { ...prev };
        let filled = 0;
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'contact_persons') {
            // merge only blank fields of contact_persons[0]
            const cps = Array.isArray(prev.contact_persons) ? [...prev.contact_persons] : [];
            const cur = cps[0] || { name: '', email: '', phone: '', designation: '', birthday: '', din: '' };
            const incoming = v[0] || {};
            const next = { ...cur };
            for (const ck of Object.keys(incoming)) {
              if (!cur[ck] && incoming[ck]) { next[ck] = incoming[ck]; filled++; }
            }
            cps[0] = next;
            merged.contact_persons = cps;
          } else if (!merged[k]) {
            merged[k] = v; filled++;
          }
        }
        if (filled) toast.message(`Auto-filled ${filled} field(s) from PassVault`);
        return merged;
      });
    });
  }, []);

  const resetForm = useCallback(() => {
    setAddressTab('primary');
    setFormData({ company_name: '', client_type: 'proprietor', client_type_other: '', contact_persons: [{ name: '', email: '', phone: '', designation: '', birthday: '', din: '' }], email: '', phone: '', birthday: '', address: '', city: '', state: '', pincode: '', services: [], dsc_details: [], assignments: [{ ...EMPTY_ASSIGNMENT }], notes: '', status: 'active', referred_by: '', auditor: '', gstin: '', pan: '', gst_treatment: 'regular', place_of_supply: '', default_payment_terms: 'Due on receipt', credit_limit: '', opening_balance: '', opening_balance_type: 'Dr', tally_ledger_name: '', tally_group: 'Sundry Debtors', website: '', msme_number: '', gst_address: '', gst_city: '', gst_state: '', gst_pin: '', cin: '', llpin: '', proprietor_name: '', date_of_incorporation: '', mca_fetch_date: '', mca_registration_number: '', mca_roc_name: '', mca_rd_name: '', mca_company_category: '', mca_company_subcategory: '', mca_listed: null, mca_active_compliance: '', mca_authorized_capital: '', mca_paid_up_capital: '', mca_last_agm_date: '', mca_balance_sheet_date: '', mca_books_address: '', mca_charges: [], mca_loan_details: [] });
    setOtherService(''); setEditingClient(null); setFormErrors({}); setContactErrors([]); setReferrerInput(''); setReferrerSelectValue(''); setAuditorInput(''); setAuditorSelectValue('');
    setSmartImportFiles({ gst: null, udyam: null, mca: null });
    setSmartImportError('');
  }, []);

  useEffect(() => { if (!dialogOpen) { setFormErrors({}); setContactErrors([]); } }, [dialogOpen]);

  // ── Draft persistence: save add-form to localStorage whenever it changes ──
  const DRAFT_KEY = 'taskosphere_clients_add_draft';
  useEffect(() => {
    if (dialogOpen && !editingClient) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ formData, otherService })); } catch {}
    }
  }, [formData, otherService, dialogOpen, editingClient]);

  // Restore draft when opening add dialog
  const openAddDialog = useCallback(() => {
    resetForm(); // ← ADD THIS FIRST
    try {
      const saved = localStorage.getItem(DRAFT_KEY);;
      if (saved) {
        const { formData: savedForm, otherService: savedOther } = JSON.parse(saved);
        if (savedForm?.company_name?.trim()) {
          setFormData(prev => ({ ...prev, ...savedForm }));
          setOtherService(savedOther || '');
        }
      }
    } catch {}
    setEditingClient(null);
    setDialogOpen(true);
    setFormErrors({});
    setContactErrors([]);
  }, []);

  // ── Contact/DSC/Assignment helpers ────────────────────────────────────────
  const updateContact = useCallback((idx, field, val) => {
    setFormData(p => ({ ...p, contact_persons: p.contact_persons.map((c, i) => i === idx ? { ...c, [field]: val } : c) }));
    setContactErrors(prev => { const n = [...prev]; if (n[idx]) { delete n[idx][field]; if (!Object.keys(n[idx]).length) n[idx] = undefined; } return n; });
  }, []);
  const addContact    = useCallback(() => setFormData(p => ({ ...p, contact_persons: [...p.contact_persons, { name: '', email: '', phone: '', designation: '', birthday: '', din: '' }] })), []);
  const removeContact = useCallback((idx) => setFormData(p => ({ ...p, contact_persons: p.contact_persons.filter((_, i) => i !== idx) })), []);
  const updateDSC     = useCallback((idx, field, val) => setFormData(p => ({ ...p, dsc_details: p.dsc_details.map((d, i) => i === idx ? { ...d, [field]: val } : d) })), []);
  const addDSC        = useCallback(() => setFormData(p => ({ ...p, dsc_details: [...p.dsc_details, { certificate_number: '', holder_name: '', issue_date: '', expiry_date: '', notes: '' }] })), []);
  const removeDSC     = useCallback((idx) => setFormData(p => ({ ...p, dsc_details: p.dsc_details.filter((_, i) => i !== idx) })), []);
  const addAssignment    = useCallback(() => setFormData(p => ({ ...p, assignments: [...(p.assignments || []), { ...EMPTY_ASSIGNMENT }] })), []);
  const removeAssignment = useCallback((idx) => setFormData(p => ({ ...p, assignments: (p.assignments || []).filter((_, i) => i !== idx) })), []);
  const updateAssignmentUser = useCallback((idx, userId) => setFormData(p => ({ ...p, assignments: (p.assignments || []).map((a, i) => i === idx ? { ...a, user_id: userId } : a) })), []);
  const toggleAssignmentService = useCallback((idx, svc) => setFormData(p => ({ ...p, assignments: (p.assignments || []).map((a, i) => { if (i !== idx) return a; const services = a.services.includes(svc) ? a.services.filter(s => s !== svc) : [...a.services, svc]; return { ...a, services }; }) })), []);
  const toggleService = useCallback((s) => { setFormData(p => ({ ...p, services: p.services.includes(s) ? p.services.filter(x => x !== s) : [...p.services, s] })); setFormErrors(prev => ({ ...prev, services: undefined })); }, []);
  const addOtherService = useCallback(() => {
    const t = otherService.trim(); if (!t) return;
    const existing = formData.services.filter(s => s.startsWith('Other:')).map(s => s.replace('Other: ', '').toLowerCase());
    const builtin = SERVICES.find(s => s.toLowerCase() === t.toLowerCase() && s !== 'Other');
    if (builtin) { toast.info(`"${builtin}" is already a standard service`); return; }
    if (existing.includes(t.toLowerCase())) { toast.info(`"${t}" already added`); setOtherService(''); return; }
    setFormData(prev => ({ ...prev, services: [...prev.services.filter(s => !s.startsWith('Other:')), `Other: ${t}`] }));
    setOtherService('');
  }, [otherService, formData.services]);

  // ── Referrer handlers ─────────────────────────────────────────────────────
  const handleReferrerSelectChange = useCallback((val) => {
    setReferrerSelectValue(val);
    if (val === '__other__') { setReferrerInput(''); setFormData(prev => ({ ...prev, referred_by: '' })); }
    else { setReferrerInput(''); setFormData(prev => ({ ...prev, referred_by: val === '' ? '' : val })); }
  }, []);
  const handleReferrerInputChange = useCallback((val) => { setReferrerInput(val); setFormData(prev => ({ ...prev, referred_by: val })); }, []);
  const handleSaveReferrer = useCallback(async () => {
    const name = referrerInput.trim();
    if (!name) { toast.error('Please enter a referrer name'); return; }
    const dup = savedReferrers.find(r => r.toLowerCase() === name.toLowerCase());
    if (dup) { toast.info(`"${dup}" already exists — selected!`); setReferrerSelectValue(dup); setReferrerInput(''); setFormData(prev => ({ ...prev, referred_by: dup })); return; }
    const saved = await saveReferrer(name);
    setReferrerSelectValue(saved); setReferrerInput(''); setFormData(prev => ({ ...prev, referred_by: saved }));
    toast.success(`"${saved}" added to referrer list`);
  }, [referrerInput, savedReferrers, saveReferrer]);

  // ── Auditor handlers ──────────────────────────────────────────────────────
  const handleAuditorSelectChange = useCallback((val) => {
    setAuditorSelectValue(val);
    if (val === '__other__') { setAuditorInput(''); setFormData(prev => ({ ...prev, auditor: '' })); }
    else { setAuditorInput(''); setFormData(prev => ({ ...prev, auditor: val === '' ? '' : val })); }
  }, []);
  const handleAuditorInputChange = useCallback((val) => { setAuditorInput(val); setFormData(prev => ({ ...prev, auditor: val })); }, []);
  const handleSaveAuditor = useCallback(async () => {
    const name = auditorInput.trim();
    if (!name) { toast.error('Please enter an auditor name'); return; }
    const dup = savedAuditors.find(a => a.toLowerCase() === name.toLowerCase());
    if (dup) { toast.info(`"${dup}" already exists — selected!`); setAuditorSelectValue(dup); setAuditorInput(''); setFormData(prev => ({ ...prev, auditor: dup })); return; }
    const saved = await saveAuditor(name);
    setAuditorSelectValue(saved); setAuditorInput(''); setFormData(prev => ({ ...prev, auditor: saved }));
    toast.success(`"${saved}" added to auditor list`);
  }, [auditorInput, savedAuditors, saveAuditor]);

  // ── Referrer edit / delete ────────────────────────────────────────────────
  const updateReferrer = useCallback(async (oldName, newName) => {
    try {
      await api.put('/referrers', { old_name: oldName, new_name: newName });
      setSavedReferrers(prev => prev.map(r => r === oldName ? newName : r));
      setClients(prev => prev.map(c => c.referred_by === oldName ? { ...c, referred_by: newName } : c));
      if (referrerSelectValue === oldName) {
        setReferrerSelectValue(newName);
        setFormData(p => ({ ...p, referred_by: newName }));
      }
      toast.success(`Renamed to "${newName}"`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not rename referrer');
    }
  }, [referrerSelectValue]);

  const deleteReferrer = useCallback(async (name) => {
    try {
      await api.delete('/referrers', { params: { name } });
      setSavedReferrers(prev => prev.filter(r => r !== name));
      toast.success(`"${name}" removed`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete referrer');
    }
  }, []);

  // ── Auditor edit / delete ─────────────────────────────────────────────────
  const updateAuditor = useCallback(async (oldName, newName) => {
    try {
      await api.put('/auditors', { old_name: oldName, new_name: newName });
      setSavedAuditors(prev => prev.map(a => a === oldName ? newName : a));
      setClients(prev => prev.map(c => c.auditor === oldName ? { ...c, auditor: newName } : c));
      if (auditorSelectValue === oldName) {
        setAuditorSelectValue(newName);
        setFormData(p => ({ ...p, auditor: newName }));
      }
      toast.success(`Renamed to "${newName}"`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not rename auditor');
    }
  }, [auditorSelectValue]);

  const deleteAuditor = useCallback(async (name) => {
    try {
      await api.delete('/auditors', { params: { name } });
      setSavedAuditors(prev => prev.filter(a => a !== name));
      toast.success(`"${name}" removed`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete auditor');
    }
  }, []);

  // ── CSV / Excel imports ───────────────────────────────────────────────────
  const downloadTemplate = useCallback(() => {
    const headers = ['company_name','client_type','client_type_label','email','phone','birthday','address','city','state','referred_by','services','notes','status','contact_name_1','contact_designation_1','contact_email_1','contact_phone_1','contact_birthday_1','contact_din_1'];
    const sample  = ['ABC Pvt Ltd','pvt_ltd','','abc@example.com','9876543210','2015-04-01','123 MG Road','Surat','Gujarat','John Smith','GST, ROC','Sample notes','active','Rahul Mehta','Director','rahul@example.com','9876500001','1985-06-15','DIN00001234'];
    const csv = Papa.unparse([headers, sample], { newline: '\r\n' }) + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'client_import_template.csv';
    document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
  }, []);

  const handleImportCSV = useCallback(async (event) => {
    const file = event.target.files[0]; if (!file) return;
    setImportLoading(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api.post('/clients/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(r.data.message || `${r.data.clients_created || 0} clients imported!`);
      fetchClients();
    } catch (e) { toast.error(e.response?.data?.detail || 'Import failed'); }
    finally { setImportLoading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }, [fetchClients]);
  const handleImportClientFile = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      toast.error('Please select a CSV or Excel file (.csv, .xlsx, .xls)');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImportLoading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/clients/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const created = Number(r.data?.clients_created || 0);
      const skipped = Number(r.data?.clients_skipped || 0);
      const errors = Array.isArray(r.data?.errors) ? r.data.errors.length : 0;
      toast.success(r.data?.message || `${created} clients imported`, {
        description: `Created: ${created} · Skipped: ${skipped}${errors ? ` · Errors: ${errors}` : ''}`,
      });
      await fetchClients();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Import failed');
    } finally {
      setImportLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [fetchClients]);

  const handleImportExcel = useCallback(async (event) => {
    const file = event.target.files[0]; if (!file) return;
    if (excelInputRef.current) excelInputRef.current.value = '';
    setMdsPreviewLoading(true); setMdsPreviewOpen(true); setMdsData(null); setMdsForm(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api.post('/clients/parse-mds-excel', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const data = r.data;
      let address = (data.address || data.registered_address || '').trim();
      let city = (data.city || '').trim(), state = (data.state || '').trim();
      if (address && (!city || !state)) {
        const parts = address.split(',').map(p => p.trim()).filter(p => p);
        if (!state && parts.length >= 2) state = parts[parts.length - 2] || '';
        if (!city  && parts.length >= 3) city  = parts[parts.length - 3] || '';
      }
      setMdsData(data);
      const contacts = (data.contact_persons || []).map(cp => ({ name: cp.name || '', designation: cp.designation || '', email: cp.email || '', phone: cp.phone || '', birthday: cp.birthday || '', din: cp.din || '' }));
      if (contacts.length === 0) contacts.push({ name: '', designation: '', email: '', phone: '', birthday: '', din: '' });
      setMdsForm({ company_name: (data.company_name || '').trim(), client_type: data.client_type || 'proprietor', email: (data.email || '').trim(), phone: (data.phone || '').trim(), birthday: data.birthday || '', address, city, state, services: data.services || [], notes: '', status: data.status_value || 'active', contact_persons: contacts, referred_by: (data.referred_by || '').trim() });
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to parse Excel file'); setMdsPreviewOpen(false); }
    finally { setMdsPreviewLoading(false); }
  }, []);

  const handleImportGST = useCallback(async (event) => {
    const file = event.target.files[0];
    if (gstInputRef.current) gstInputRef.current.value = '';
    if (!file) return;
   
    if (file.type !== 'application/pdf') {
      toast.error('Please upload a PDF file (GST REG-06 certificate)');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('PDF too large — please upload a file under 10 MB');
      return;
    }
   
    setGstImportLoading(true);
    setGstImportError('');
   
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('/clients/parse-gst-pdf', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const parsed = res.data;

      // Backend already maps constitution → slug (pvt_ltd, llp, etc.)
      // Frontend map is a safety net for raw values and for existing client flows.
      const constitutionMap = {
        proprietorship: 'proprietor', proprietor: 'proprietor', 'sole proprietorship': 'proprietor',
        'private limited': 'pvt_ltd', 'private limited company': 'pvt_ltd',
        pvt_ltd: 'pvt_ltd', 'pvt ltd': 'pvt_ltd',
        llp: 'llp', 'limited liability partnership': 'llp',
        partnership: 'partnership', 'partnership firm': 'partnership',
        huf: 'huf', 'hindu undivided family': 'huf',
        trust: 'trust',
        'public limited': 'pvt_ltd', 'public limited company': 'pvt_ltd',
      };
      // Use backend-mapped value directly; fall back to mapping constitution_raw
      const mappedConstitution = parsed.constitution && parsed.constitution !== 'other'
        ? parsed.constitution
        : constitutionMap[(parsed.constitution_raw || '').toLowerCase().trim()] || 'other';
      const rawConstitution = (parsed.constitution_raw || parsed.constitution || '').toLowerCase().trim();
      const clientType = mappedConstitution;

      const contacts = (parsed.partners || [])
        .filter(p => p.name?.trim())
        .map(p => ({
          name: p.name.trim(),
          designation: p.designation?.trim() || 'Partner',
          email: '', phone: '', birthday: '', din: '',
        }));
      if (contacts.length === 0) {
        contacts.push({ name: '', designation: '', email: '', phone: '', birthday: '', din: '' });
      }

      const extractedGstin   = (parsed.gstin   || '').trim().toUpperCase();
      const extractedAddress = (parsed.address  || '').trim();
      const extractedCity    = (parsed.city     || '').trim();
      const extractedState   = (parsed.state    || '').trim();
      const extractedName    = (parsed.legal_name?.trim() || parsed.trade_name?.trim() || '');

      // ── Helper: open an existing client in edit mode with GST data merged ──
      const openExistingWithGST = (existing) => {
        setEditingClient(existing);
        const existingAddress = (existing.address || '').trim();

        // Determine whether GST address differs from the stored primary address.
        // If they differ → store the GST one in gst_address so both are visible.
        const addressesMatch = extractedAddress &&
          existingAddress.toLowerCase() === extractedAddress.toLowerCase();

        const mergedGstAddress = (!addressesMatch && extractedAddress)
          ? extractedAddress
          : (existing.gst_address || '');

        // If client has no address yet, use the GST address as the primary one
        const mergedPrimaryAddress = existingAddress || extractedAddress;
        const mergedCity  = existing.city  || extractedCity;
        const mergedState = existing.state || extractedState;

        // Merge contacts: keep existing, add new partners not already present
        const existingContacts = existing.contact_persons?.length > 0
          ? existing.contact_persons.map(cp => ({ ...cp, birthday: cp.birthday ? cp.birthday.slice(0, 10) : '', din: cp.din || '' }))
          : [];
        const existingNames = new Set(existingContacts.map(c => c.name?.toLowerCase().trim()).filter(Boolean));
        const newContacts = contacts.filter(c => !existingNames.has(c.name.toLowerCase().trim()));
        const mergedContacts = [...existingContacts, ...newContacts];
        if (mergedContacts.length === 0) mergedContacts.push({ name: '', designation: '', email: '', phone: '', birthday: '', din: '' });

        let assignments = existing.assignments || [];
        if (assignments.length === 0 && existing.assigned_to) assignments = [{ user_id: existing.assigned_to, services: [] }];
        if (assignments.length === 0) assignments = [{ ...EMPTY_ASSIGNMENT }];

        const extractedPin = (parsed.pin || '').trim();
        // Determine GST city/state for tab display (different from primary or not)
        const gstCityForTab  = (!addressesMatch && extractedCity)  ? extractedCity  : '';
        const gstStateForTab = (!addressesMatch && extractedState) ? extractedState : '';

        setFormData({
          ...existing,
          client_type_other: existing.client_type === 'other' ? (existing.client_type_label || '') : '',
          contact_persons:   mergedContacts,
          birthday:          existing.birthday ? existing.birthday.slice(0, 10) : '',
          dsc_details:       existing.dsc_details || [],
          assignments,
          // GST fields — always take from the certificate
          gstin:             extractedGstin || existing.gstin || '',
          gst_treatment:     existing.gst_treatment || 'regular',
          // Address merge
          address:           mergedPrimaryAddress,
          city:              mergedCity,
          state:             mergedState,
          gst_address:       mergedGstAddress,
          gst_city:          gstCityForTab,
          gst_state:         gstStateForTab,
          gst_pin:           extractedPin,
        });
        // Auto-switch to GST tab when addresses differ so user sees the difference
        setAddressTab(mergedGstAddress ? 'gst' : 'primary');
        setFormErrors({});
        setContactErrors([]);
        setGstImportOpen(false);
        setDialogOpen(true);

        const msgs = [];
        if (extractedGstin) msgs.push(`GSTIN ${extractedGstin} added`);
        if (mergedGstAddress) msgs.push('GST address saved in Certificate tab');
        if (newContacts.length > 0) msgs.push(`${newContacts.length} new director(s) merged`);
        toast.success(
          `"${existing.company_name}" updated from GST certificate. ${msgs.join(' · ')}. Review and save.`,
          { duration: 7000 }
        );
      };

      // ── 1. Check by GSTIN first (exact tax entity match) ─────────────────
      if (extractedGstin) {
        try {
          const checkRes = await api.get(`/clients/check-gstin?gstin=${encodeURIComponent(extractedGstin)}`);
          if (checkRes.data?.exists) {
            const existingId = checkRes.data.client_id;
            const existing   = clients.find(c => (c.id || c._id) === existingId);
            if (existing) {
              openExistingWithGST(existing);
              return;
            }
          }
        } catch (_) { /* non-blocking */ }
      }

      // ── 2. Check by name + client_type (same business entity type) ────────
      if (extractedName) {
        const nameMatch = clients.find(c =>
          c.company_name?.toLowerCase().trim() === extractedName.toLowerCase() &&
          (c.client_type || '').toLowerCase() === rawConstitution
        );
        if (nameMatch) {
          openExistingWithGST(nameMatch);
          return;
        }
      }

      // ── 3. No match — pre-fill form for a brand NEW client ────────────────
      const extractedPin = (parsed.pin || '').trim();
      setFormData(prev => ({
        ...prev,
        company_name:      extractedName,
        client_type:       clientType,
        client_type_other: clientType === 'other' ? rawConstitution : '',
        gstin:             extractedGstin,
        address:           extractedAddress,
        city:              extractedCity,
        state:             extractedState,
        gst_address:       '',     // same address — no separate GST tab needed
        gst_city:          '',
        gst_state:         '',
        gst_pin:           extractedPin,
        contact_persons:   contacts,
        gst_treatment:     'regular',
      }));
      setAddressTab('primary');
      setEditingClient(null);
      setFormErrors({});
      setContactErrors([]);
      setGstImportOpen(false);
      setDialogOpen(true);
      toast.success(
        `GST data extracted! ${[
          extractedName && `"${extractedName}"`,
          clientType !== 'other' && `Type: ${clientType.toUpperCase()}`,
          extractedCity && `City: ${extractedCity}`,
          contacts.length > 1 && `${contacts.length} directors found`,
        ].filter(Boolean).join(' · ')}. Review and save.`,
        { duration: 6000 }
      );

    } catch (err) {
      console.error('GST import error:', err);
      const msg = err?.response?.data?.detail || err.message || 'Failed to parse GST certificate';
      setGstImportError(msg);
      toast.error(msg);
    } finally {
      setGstImportLoading(false);
    }
  }, [clients]);

  
  const handleMdsConfirm = useCallback(async (saveDirectly = false) => {
    if (!mdsForm) return;
    if (saveDirectly) {
      setImportLoading(true);
      try {
        const contacts = mdsForm.contact_persons.filter(cp => cp.name?.trim()).map(cp => ({ name: cp.name.trim(), designation: cp.designation?.trim() || null, email: cp.email?.trim() || null, phone: cp.phone?.replace(/\D/g, '') || null, birthday: safeDate(cp.birthday), din: cp.din?.trim() || null }));
        await api.post('/clients', { company_name: mdsForm.company_name?.trim() || '', client_type: mdsForm.client_type || 'proprietor', email: mdsForm.email?.trim() || null, phone: mdsForm.phone?.replace(/\D/g, '') || null, birthday: safeDate(mdsForm.birthday) || null, address: mdsForm.address?.trim() || null, city: mdsForm.city?.trim() || null, state: mdsForm.state?.trim() || null, services: mdsForm.services || [], notes: mdsForm.notes?.trim() || null, status: mdsForm.status || 'active', contact_persons: contacts, dsc_details: [], assignments: [], assigned_to: null, referred_by: mdsForm.referred_by?.trim() || null });
        toast.success(`Client "${mdsForm.company_name}" saved!`);
        fetchClients(); setMdsPreviewOpen(false); setMdsData(null); setMdsForm(null);
      } catch (err) { toast.error(err.response?.data?.detail || 'Failed to save client'); }
      finally { setImportLoading(false); }
    } else {
      setFormData({ company_name: mdsForm.company_name || '', client_type: mdsForm.client_type || 'proprietor', email: mdsForm.email || '', phone: mdsForm.phone || '', birthday: mdsForm.birthday || '', address: mdsForm.address || '', city: mdsForm.city || '', state: mdsForm.state || '', services: mdsForm.services || [], notes: mdsForm.notes || '', status: mdsForm.status || 'active', contact_persons: mdsForm.contact_persons.length > 0 ? mdsForm.contact_persons : [{ name: '', designation: '', email: '', phone: '', birthday: '', din: '' }], dsc_details: [], assignments: [{ ...EMPTY_ASSIGNMENT }], referred_by: mdsForm.referred_by || '' });
      setEditingClient(null); setFormErrors({}); setContactErrors([]);
      setMdsPreviewOpen(false); setDialogOpen(true);
      toast.info('Form pre-filled from Excel — review and save when ready.');
    }
  }, [mdsForm, fetchClients]);

  // ── Filter clear helpers ────────────────────────────────────────────────
  const clearFilter = useCallback((which) => {
    if (which === 'status')     setStatusFilter('all');
    if (which === 'clientType') setClientTypeFilter('all');
    if (which === 'service')    setServiceFilter('all');
    if (which === 'assigned')   setAssignedToFilter('all');
    if (which === 'referredBy') setReferredByFilter('all');
    if (which === 'auditor')    setAuditorFilter('all');
  }, []);
  const clearAllFilters = useCallback(() => { setStatusFilter('all'); setClientTypeFilter('all'); setServiceFilter('all'); setAssignedToFilter('all'); setReferredByFilter('all'); setAuditorFilter('all'); setSearchInput(''); }, []);

  // ── List row — using itemData pattern so it doesn't recreate per-render ──
  // ── Shared grid column definition ─────────────────────────────────────────
  // Col:  chk  | avt  | company | type  | phone/linked | email | ref  | aud  | svc  | asgn | actions
  // Px:   20px | 32px | 180px   | 76px  | 120px        | 148px | 88px | 88px | 116px| 112px| 96px
  const LIST_GRID_NORMAL = '20px 32px 180px 76px 120px 148px 88px 88px 116px 112px 96px';
  const LIST_GRID_ITR    = '20px 32px 180px 76px 140px 148px 88px 88px 116px 112px 96px';

  const ListRow = useCallback(({ index, style, data }) => {
    const { pageClients: pc, pageStart: ps, itrTabActive, bulkSelectedIds: bsi, toggleBulkSelect: tbs, canDeleteData: cdd } = data;
    const client = pc[index];
    if (!client) return null;
    const globalIndex = ps + index;
    const cfg = TYPE_CONFIG[client.client_type] || TYPE_CONFIG.proprietor;
    const isArchived = client.status === 'inactive';
    const serviceCount = client.services?.length || 0;
    const clientAssignments = getClientAssignments(client);
    const companyLinks = client.itr_data?.company_links || [];
    const isSelected = bsi.has(client.id);
    const gridTemplate = itrTabActive ? LIST_GRID_ITR : LIST_GRID_NORMAL;

    return (
      <div style={{ ...style, paddingTop: 2, paddingBottom: 2, paddingLeft: 4, paddingRight: 4 }}>
        <div
          className={`relative rounded-xl border transition-all duration-200 overflow-hidden group cursor-pointer h-full
            ${isArchived ? 'opacity-60' : ''}
            ${isSelected ? (isDark ? 'border-red-500 bg-red-900/10' : 'border-red-300 bg-red-50/60') : isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'}`}
          style={{ display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center', columnGap: 8, paddingLeft: 12, paddingRight: 8 }}
          onClick={() => { if (bsi.size === 0) { setSelectedClient(client); setDetailDialogOpen(true); } }}>
          {/* Colour strip */}
          <div className="absolute left-0 top-0 h-full w-1" style={{ background: isSelected ? '#ef4444' : (itrTabActive ? 'linear-gradient(180deg, #0f3460, #0d7377)' : cfg.strip) }} />

          {/* 1 · Checkbox — always rendered, invisible when not needed */}
          <div className="flex items-center justify-center">
            {cdd ? (
              <div
                onClick={e => { e.stopPropagation(); tbs(client.id, e); }}
                className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-all
                  ${isSelected ? 'bg-red-500 border-red-500' : isDark ? 'border-slate-500 hover:border-red-400' : 'border-slate-300 hover:border-red-400 opacity-0 group-hover:opacity-100'}`}
              >
                {isSelected && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
              </div>
            ) : <span />}
          </div>

          {/* 2 · Avatar */}
          <div className="flex items-center justify-center">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ background: getAvatarGradient(client.company_name) }}>
              {client.company_name?.charAt(0).toUpperCase() || '?'}
            </div>
          </div>

          {/* 3 · Company */}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-mono text-slate-300">#{getClientNumber(globalIndex)}</span>
              {isArchived && <span className="text-[9px] font-semibold text-amber-600 bg-amber-50 px-1 py-0.5 rounded">Arc</span>}
              {client.is_itr_client && !itrTabActive && <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ background: '#ccfbf1', color: '#0f766e' }}>ITR</span>}
            </div>
            <p className={`text-xs font-semibold truncate leading-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{client.company_name}</p>
          </div>

          {/* 4 · Type */}
          <div className="min-w-0 overflow-hidden">
            <TypePill type={client.client_type} customLabel={client.client_type_label} />
          </div>

          {/* 5 · Phone OR Linked Company */}
          {itrTabActive ? (
            <div className="min-w-0">
              {companyLinks.length === 0 ? (
                <span className="text-[10px] text-slate-300 italic">No linked company</span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {companyLinks.slice(0, 2).map((link, i) => {
                    const roleColors = { director: '#1e40af', partner: '#166534', proprietor: '#9a3412', shareholder: '#6b21a8', trustee: '#713f12', karta: '#9f1239', member: '#075985' };
                    return (
                      <div key={i} className="flex items-center gap-1 min-w-0">
                        <span className={`text-[10px] font-semibold truncate ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>{link.company_name}</span>
                        <span className="text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 capitalize" style={{ background: (roleColors[link.role] || '#475569') + '18', color: roleColors[link.role] || '#475569' }}>{link.role}</span>
                      </div>
                    );
                  })}
                  {companyLinks.length > 2 && <span className="text-[9px] text-slate-400">+{companyLinks.length - 2} more</span>}
                </div>
              )}
            </div>
          ) : (
            <div className="min-w-0">
              <p
                className={`text-xs font-medium whitespace-nowrap truncate cursor-copy ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                onClick={client.phone ? e => { e.stopPropagation(); copyToClipboard(client.phone, 'Phone'); } : undefined}
                title={client.phone || ''}>
                {client.phone || '—'}
              </p>
            </div>
          )}

          {/* 6 · Email */}
          <div className="min-w-0">
            <p
              className={`text-xs truncate whitespace-nowrap cursor-copy ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
              onClick={client.email ? e => { e.stopPropagation(); copyToClipboard(client.email, 'Email'); } : undefined}
              title={client.email || ''}>
              {client.email || '—'}
            </p>
          </div>

          {/* 7 · Referred By */}
          <div className="min-w-0">
            {client.referred_by
              ? <span className="text-[10px] font-medium text-violet-600 truncate block">{client.referred_by}</span>
              : <span className="text-[10px] text-slate-300">—</span>}
          </div>

          {/* 8 · Auditor */}
          <div className="min-w-0">
            {client.auditor
              ? <span className="text-[10px] font-medium truncate block" style={{ color: '#7c3aed' }}>{client.auditor}</span>
              : <span className="text-[10px] text-slate-300">—</span>}
          </div>

          {/* 9 · Services — can wrap to 2 lines */}
          <div className="flex flex-wrap gap-1 content-center min-w-0">
            {client.services?.slice(0, 2).map((svc, i) => (
              <span key={i} className="text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-tight whitespace-nowrap" style={{ background: cfg.bg, color: cfg.text, borderColor: cfg.border }}>
                {svc.replace('Other: ', '').substring(0, 7)}
              </span>
            ))}
            {serviceCount > 2 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 leading-tight">+{serviceCount - 2}</span>}
          </div>

          {/* 10 · Assigned — can wrap to 2 lines */}
          <div className="flex flex-col gap-0.5 min-w-0">
            {clientAssignments.slice(0, 2).map((a, i) => {
              const u = users.find(x => x.id === a.user_id);
              return u ? (
                <span key={i} className="text-[10px] text-slate-500 truncate">
                  {u.full_name || u.name}
                  {a.services?.length > 0 && <span className="text-slate-400"> · {a.services[0]}{a.services.length > 1 ? `+${a.services.length - 1}` : ''}</span>}
                </span>
              ) : null;
            })}
            {clientAssignments.length > 2 && <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>+{clientAssignments.length - 2} more</span>}
          </div>

          {/* 11 · Actions — always reserved 96px, 4 buttons × 24px */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={e => { e.stopPropagation(); openWhatsApp(client.phone, client.company_name); }}
              className={`w-6 h-6 flex items-center justify-center rounded-md transition-all flex-shrink-0 ${isDark ? 'text-emerald-400 hover:bg-emerald-900/40' : 'text-emerald-500 opacity-30 group-hover:opacity-100 hover:bg-emerald-50'}`}
              title="WhatsApp"
            ><MessageCircle className="h-3 w-3" /></button>
            {itrTabActive && canEditClients ? (
              <button
                onClick={e => { e.stopPropagation(); setEditingItrClient(client); setItrDialogOpen(true); }}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-all flex-shrink-0 ${isDark ? 'opacity-50 hover:opacity-100' : 'opacity-30 group-hover:opacity-100'}`}
                title="Link Company" style={{ color: '#0d7377' }}
              ><Link className="h-3 w-3" /></button>
            ) : <span className="w-6 flex-shrink-0" />}
            {canEditClients && (
              <button
                onClick={e => { e.stopPropagation(); handleEdit(client); }}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-all flex-shrink-0 ${isDark ? 'text-blue-400 hover:bg-blue-900/40' : 'text-blue-500 opacity-30 group-hover:opacity-100 hover:bg-blue-50'}`}
                title="Edit"
              ><Edit className="h-3 w-3" /></button>
            )}
            {canDeleteData && (
              <button
                onClick={e => { e.stopPropagation(); handleDelete(client); }}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-all flex-shrink-0 ${isDark ? 'text-red-400 hover:bg-red-900/40' : 'text-red-400 opacity-30 group-hover:opacity-100 hover:bg-red-50'}`}
                title="Delete"
              ><Trash2 className="h-3 w-3" /></button>
            )}
          </div>
        </div>
      </div>
    );
  }, [isDark, users, getClientAssignments, getClientNumber, openWhatsApp, handleEdit, canEditClients, canDeleteData, handleDelete, LIST_GRID_NORMAL, LIST_GRID_ITR]);

  // ── Pagination derived values ──────────────────────────────────────────────
  const boardTotalPages = Math.ceil(sortedClients.length / BOARD_PAGE_SIZE);
  const boardSafePage   = Math.min(boardPage, Math.max(1, boardTotalPages));
  const boardPageStart  = (boardSafePage - 1) * BOARD_PAGE_SIZE;
  const boardPageClients = sortedClients.slice(boardPageStart, boardPageStart + BOARD_PAGE_SIZE);

  const listTotalPages  = Math.ceil(sortedClients.length / LIST_PAGE_SIZE);
  const listSafePage    = Math.min(listPage, Math.max(1, listTotalPages));
  const listPageStart   = (listSafePage - 1) * LIST_PAGE_SIZE;
  const listPageClients = sortedClients.slice(listPageStart, listPageStart + LIST_PAGE_SIZE);
  const listHeight      = Math.min(listPageClients.length, MAX_VISIBLE_ROWS) * LIST_ROW_HEIGHT;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-full space-y-5" style={{ background: isDark ? '#0f172a' : '#F4F6FA' }}>

      {/* PAGE HEADER */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 shadow-sm" style={{ background: 'linear-gradient(135deg, #0D3B66 0%, #1F6FB2 60%, #2a85cc 100%)' }}>
        <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full opacity-10" style={{ background: 'radial-gradient(circle, #fff 0%, transparent 70%)' }} />
        <div className="relative flex flex-col sm:flex-row justify-between items-start sm:items-center gap-5 px-7 py-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-white/15 backdrop-blur-sm border border-white/20 flex-shrink-0"><Users className="h-6 w-6 text-white" /></div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Clients</h1>
              <p className="text-sm text-blue-200 mt-0.5">Central hub for all client relationships · <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-white/20 font-mono">Ctrl+K</kbd> search · <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-white/20 font-mono">N</kbd> new</p>
            </div>
          </div>
          <div className="flex flex-nowrap items-center gap-2">
            {typeof window !== "undefined" && window.oneNexaDesktop?.isDesktop && <Button variant="outline" onClick={() => navigate("/clients-local")} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 !rounded-none gap-2 backdrop-blur-sm whitespace-nowrap" style={{ borderRadius: 0 }}>Offline Pilot</Button>}
            <Button variant="outline" onClick={downloadTemplate} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 !rounded-none gap-2 backdrop-blur-sm whitespace-nowrap" style={{ borderRadius: 0 }}><FileText className="h-4 w-4" /> CSV Template</Button>
            {canEditClients && <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importLoading} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 !rounded-none backdrop-blur-sm whitespace-nowrap" style={{ borderRadius: 0 }}>{importLoading ? 'Importing…' : 'Import Excel / CSV'}</Button>}

            {/* ── AI Duplicate Detector ── */}
            <Button
              variant="outline"
              onClick={handleDetectClientDuplicates}
              disabled={detectingDups || clients.length === 0}
              className="h-9 px-4 text-sm !rounded-none gap-2 backdrop-blur-sm font-semibold transition-all disabled:opacity-40"
              style={{ borderRadius: 0, backgroundColor: 'rgba(139,92,246,0.25)', borderColor: 'rgba(167,139,250,0.6)', color: '#ede9fe' }}
            >
              {detectingDups
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning…</>
                : <><Sparkles className="h-3.5 w-3.5" /> AI Duplicates</>}
            </Button>
            {/* ── ITR Client Button ── */}
            {canEditClients && (
              <Button
                variant="outline"
                onClick={() => { setEditingItrClient(null); setItrDialogOpen(true); }}
                className="h-9 px-4 text-sm !rounded-none gap-2 backdrop-blur-sm font-semibold transition-all"
                style={{ borderRadius: 0, backgroundColor: 'rgba(13,115,119,0.25)', borderColor: 'rgba(20,184,166,0.6)', color: '#ccfbf1' }}
              >
                <FileText className="h-3.5 w-3.5" /> + ITR Client
              </Button>
            )}
            <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
              {canEditClients && (
              <DialogTrigger asChild>
                <Button onClick={openAddDialog} className="h-9 px-5 text-sm !rounded-none bg-white text-slate-800 hover:bg-blue-50 shadow-sm gap-2 font-semibold border-0" style={{ borderRadius: 0 }}><Plus className="h-4 w-4" /> New Client</Button>
              </DialogTrigger>
              )}
              <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto bg-white rounded-2xl border border-slate-200 shadow-2xl p-0">
                <div className={`sticky top-0 z-10 border-b px-8 py-5 flex items-center justify-between ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
                  <div>
                    <DialogTitle className={`text-xl font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{editingClient ? 'Edit Client Profile' : 'New Client Profile'}</DialogTitle>
                    <DialogDescription className="text-sm text-slate-400 mt-0.5">Complete client information and preferences</DialogDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-3 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</span>
                      <Switch checked={formData.status === 'active'} onCheckedChange={c => setFormData(p => ({ ...p, status: c ? 'active' : 'inactive' }))} />
                      <span className={`text-xs font-semibold ${formData.status === 'active' ? 'text-emerald-600' : 'text-amber-600'}`}>{formData.status === 'active' ? 'Active' : 'Archived'}</span>
                    </div>
                    {/* Minimize — shrink this form to the dock, go do something else, resume later */}
                    <button
                      type="button"
                      onClick={() => { minimizeClientForm(); setDialogOpen(false); toast.message('Client form minimized', { description: 'Resume it anytime from the dock in the bottom-left corner.' }); }}
                      className="w-9 h-9 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 flex items-center justify-center text-slate-500 transition-colors"
                      title="Minimize (resume later without losing your progress)"
                    >
                      <Minimize2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <form onSubmit={handleSubmit} className="p-8 space-y-7">
                  {/* ── Smart Document Import ───────────────────────────────────────────── */}
                  {!editingClient && (
                    <div className={`border-2 rounded-2xl p-5 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-gradient-to-br from-blue-50/80 to-indigo-50/50 border-blue-100'}`}>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0 shadow-sm" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z"/></svg>
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800">Auto-fill from Documents</p>
                          <p className="text-xs text-slate-500 mt-0.5">Upload GST Certificate, Udyam Certificate, or MCA Master Data — form fills automatically</p>
                        </div>
                      </div>
                      {/* Drop zones */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                        {/* GST */}
                        <div
                          className={`relative border-2 border-dashed rounded-xl p-3 flex flex-col items-center gap-1.5 cursor-pointer transition-all hover:border-blue-400 hover:bg-blue-50/60 ${smartImportFiles.gst ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200 bg-white/60'}`}
                          onClick={() => document.getElementById('_si_gst')?.click()}
                        >
                          {smartImportFiles.gst ? (
                            <>
                              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-emerald-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                              <p className="text-[10px] font-bold text-emerald-700 text-center leading-tight">{smartImportFiles.gst.name.length > 18 ? smartImportFiles.gst.name.slice(0, 16) + '…' : smartImportFiles.gst.name}</p>
                              <button type="button" onClick={e => { e.stopPropagation(); setSmartImportFiles(p => ({ ...p, gst: null })); }} className="text-[9px] text-red-400 hover:text-red-600 font-medium">Remove</button>
                            </>
                          ) : (
                            <>
                              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-blue-600"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5z"/></svg></div>
                              <p className="text-[10px] font-bold text-slate-600">GST Certificate</p>
                              <p className="text-[9px] text-slate-400">Form GST REG-06 PDF</p>
                            </>
                          )}
                          <input id="_si_gst" type="file" accept=".pdf" className="hidden" onChange={e => { if (e.target.files[0]) setSmartImportFiles(p => ({ ...p, gst: e.target.files[0] })); e.target.value = ''; }} />
                        </div>
                        {/* Udyam */}
                        <div
                          className={`relative border-2 border-dashed rounded-xl p-3 flex flex-col items-center gap-1.5 cursor-pointer transition-all hover:border-orange-400 hover:bg-orange-50/60 ${smartImportFiles.udyam ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200 bg-white/60'}`}
                          onClick={() => document.getElementById('_si_udyam')?.click()}
                        >
                          {smartImportFiles.udyam ? (
                            <>
                              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-emerald-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                              <p className="text-[10px] font-bold text-emerald-700 text-center leading-tight">{smartImportFiles.udyam.name.length > 18 ? smartImportFiles.udyam.name.slice(0, 16) + '…' : smartImportFiles.udyam.name}</p>
                              <button type="button" onClick={e => { e.stopPropagation(); setSmartImportFiles(p => ({ ...p, udyam: null })); }} className="text-[9px] text-red-400 hover:text-red-600 font-medium">Remove</button>
                            </>
                          ) : (
                            <>
                              <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-orange-600"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
                              <p className="text-[10px] font-bold text-slate-600">Udyam Certificate</p>
                              <p className="text-[9px] text-slate-400">Udyam Registration PDF</p>
                            </>
                          )}
                          <input id="_si_udyam" type="file" accept=".pdf" className="hidden" onChange={e => { if (e.target.files[0]) setSmartImportFiles(p => ({ ...p, udyam: e.target.files[0] })); e.target.value = ''; }} />
                        </div>
                        {/* MCA Excel */}
                        <div
                          className={`relative border-2 border-dashed rounded-xl p-3 flex flex-col items-center gap-1.5 cursor-pointer transition-all hover:border-violet-400 hover:bg-violet-50/60 ${smartImportFiles.mca ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200 bg-white/60'}`}
                          onClick={() => document.getElementById('_si_mca')?.click()}
                        >
                          {smartImportFiles.mca ? (
                            <>
                              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-emerald-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                              <p className="text-[10px] font-bold text-emerald-700 text-center leading-tight">{smartImportFiles.mca.name.length > 18 ? smartImportFiles.mca.name.slice(0, 16) + '…' : smartImportFiles.mca.name}</p>
                              <button type="button" onClick={e => { e.stopPropagation(); setSmartImportFiles(p => ({ ...p, mca: null })); }} className="text-[9px] text-red-400 hover:text-red-600 font-medium">Remove</button>
                            </>
                          ) : (
                            <>
                              <div className="w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-violet-600"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg></div>
                              <p className="text-[10px] font-bold text-slate-600">MCA Master Data</p>
                              <p className="text-[9px] text-slate-400">Excel (.xlsx) or MCA PDF</p>
                            </>
                          )}
                          <input id="_si_mca" type="file" accept=".xlsx,.xls,.pdf" className="hidden" onChange={e => { if (e.target.files[0]) setSmartImportFiles(p => ({ ...p, mca: e.target.files[0] })); e.target.value = ''; }} />
                        </div>
                      </div>
                      {/* Extract button + status */}
                      {(smartImportFiles.gst || smartImportFiles.udyam || smartImportFiles.mca) && (
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            disabled={smartImportLoading}
                            onClick={async () => {
                              const anyFile = smartImportFiles.gst || smartImportFiles.udyam || smartImportFiles.mca;
                              if (!anyFile) return;
                              setSmartImportLoading(true);
                              setSmartImportError('');
                              try {
                                const fd = new FormData();
                                if (smartImportFiles.gst)   fd.append('files', smartImportFiles.gst);
                                if (smartImportFiles.udyam) fd.append('files', smartImportFiles.udyam);
                                if (smartImportFiles.mca)   fd.append('files', smartImportFiles.mca);
                                const res = await api.post('/clients/parse-multi-documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                                const parsed = res.data;
                                const constitutionMap = {
                                  proprietorship: 'proprietor', proprietor: 'proprietor', 'sole proprietorship': 'proprietor',
                                  'private limited': 'pvt_ltd', 'private limited company': 'pvt_ltd', pvt_ltd: 'pvt_ltd', 'pvt ltd': 'pvt_ltd',
                                  llp: 'llp', 'limited liability partnership': 'llp',
                                  partnership: 'partnership', 'partnership firm': 'partnership',
                                  huf: 'huf', 'hindu undivided family': 'huf',
                                  trust: 'trust', 'public limited': 'public_ltd', 'public limited company': 'public_ltd',
                                };
                                // Prefer the backend's computed client_type (derived from GST constitution
                                // and/or MCA Company Category / Class of Company), falling back to the
                                // legacy GST-only mapping if the backend couldn't determine it.
                                const mappedConstitution = (parsed.client_type && parsed.client_type !== 'other')
                                  ? parsed.client_type
                                  : (parsed.constitution && parsed.constitution !== 'other'
                                      ? parsed.constitution
                                      : constitutionMap[(parsed.constitution_raw || '').toLowerCase().trim()] || 'other');
                                const contacts = (parsed.contact_persons || [])
                                  .filter(p => p.name?.trim())
                                  .map(p => ({ name: p.name.trim(), designation: p.designation?.trim() || 'Director', email: p.email || '', phone: p.phone || '', birthday: '', din: p.din || '' }));
                                if (contacts.length === 0) contacts.push({ name: '', designation: '', email: '', phone: '', birthday: '', din: '' });
                                // Check for existing client by GSTIN
                                let mergedIntoExisting = false;
                                if (parsed.gstin) {
                                  try {
                                    const chk = await api.get(`/clients/check-gstin?gstin=${encodeURIComponent(parsed.gstin)}`);
                                    if (chk.data?.exists) {
                                      const existing = clients.find(c => (c.id || c._id) === chk.data.client_id);
                                      if (existing) {
                                        setEditingClient(existing);
                                        const existingContacts = existing.contact_persons?.length > 0
                                          ? existing.contact_persons.map(cp => ({ ...cp, birthday: cp.birthday?.slice(0, 10) || '', din: cp.din || '' }))
                                          : [];
                                        const existingNames = new Set(existingContacts.map(c => c.name?.toLowerCase().trim()).filter(Boolean));
                                        const mergedContacts = [...existingContacts, ...contacts.filter(c => !existingNames.has(c.name.toLowerCase().trim()))];
                                        if (mergedContacts.length === 0) mergedContacts.push({ name: '', designation: '', email: '', phone: '', birthday: '', din: '' });
                                        setFormData({
                                          ...existing,
                                          contact_persons: mergedContacts,
                                          gstin: parsed.gstin || existing.gstin,
                                          pan: parsed.pan || existing.pan,
                                          cin: parsed.cin || parsed.cin_number || parsed.corporate_identity_number || existing.cin || '',
                                          llpin: parsed.llpin || parsed.llpin_number || existing.llpin || '',
                                          date_of_incorporation: parsed.date_of_incorporation || existing.date_of_incorporation || '',
                                          address: existing.address || parsed.address || '',
                                          city: existing.city || parsed.city || '',
                                          state: existing.state || parsed.state || '',
                                          pincode: parsed.pin || parsed.pincode || existing.pincode || '',
                                          gst_address: parsed.gst_address || existing.gst_address || '',
                                          gst_city: parsed.city || existing.gst_city || '',
                                          gst_state: parsed.state || existing.gst_state || '',
                                          gst_pin: parsed.pin || existing.gst_pin || '',
                                          msme_number: parsed.udyam_number || existing.msme_number || '',
                                          notes: parsed.notes ? (existing.notes ? existing.notes + '\n' + parsed.notes : parsed.notes) : existing.notes || '',
                                          email: existing.email || parsed.email || '',
                                          phone: existing.phone || parsed.phone || '',
                                        });
                                        setSmartImportFiles({ gst: null, udyam: null, mca: null });
                                        toast.success(`"${existing.company_name}" updated from ${parsed.doc_types_found?.join(' + ')}. Review and save.`, { duration: 6000 });
                                        mergedIntoExisting = true;
                                      }
                                    }
                                  } catch (_) {}
                                }
                                if (!mergedIntoExisting) {
                                  setFormData(prev => ({
                                    ...prev,
                                    company_name:      parsed.company_name || '',
                                    client_type:       mappedConstitution,
                                    client_type_other: mappedConstitution === 'other' ? (parsed.constitution_raw || parsed.company_category || '') : '',
                                    cin:               parsed.cin || parsed.cin_number || parsed.corporate_identity_number || '',
                                    llpin:              parsed.llpin || parsed.llpin_number || '',
                                    date_of_incorporation: parsed.date_of_incorporation || '',
                                    gstin:             parsed.gstin || '',
                                    pan:               parsed.pan || '',
                                    email:             parsed.email || '',
                                    phone:             parsed.phone || '',
                                    address:           parsed.address || '',
                                    city:              parsed.city || '',
                                    state:             parsed.state || '',
                                    pincode:           parsed.pin || parsed.pincode || '',
                                    gst_address:       parsed.gst_address || '',
                                    gst_city:          parsed.city || '',
                                    gst_state:         parsed.state || '',
                                    gst_pin:           parsed.pin || '',
                                    msme_number:       parsed.udyam_number || '',
                                    notes:             parsed.notes || '',
                                    contact_persons:   contacts,
                                    gst_treatment:     'regular',
                                    date_of_incorporation: parsed.date_of_incorporation || '',
                                    mca_registration_number: parsed.registration_number || '',
                                    mca_roc_name: parsed.roc || '',
                                    mca_rd_name: parsed.rd_name || '',
                                    mca_company_category: parsed.company_category || '',
                                    mca_company_subcategory: parsed.company_subcategory || '',
                                    mca_listed: typeof parsed.listed === 'boolean' ? parsed.listed : null,
                                    mca_active_compliance: parsed.active_compliance || '',
                                    mca_authorized_capital: parsed.authorized_capital || '',
                                    mca_paid_up_capital: parsed.paid_up_capital || '',
                                    mca_last_agm_date: parsed.last_agm_date || '',
                                    mca_balance_sheet_date: parsed.balance_sheet_date || '',
                                    mca_books_address: parsed.books_address || '',
                                    mca_charges: parsed.charges || [],
                                  }));
                                  setSmartImportFiles({ gst: null, udyam: null, mca: null });
                                  toast.success(`Data extracted from ${parsed.doc_types_found?.join(' + ')}! Review form and save.`, { duration: 5000 });
                                }
                              } catch (err) {
                                const msg = err?.response?.data?.detail || err.message || 'Failed to parse documents';
                                setSmartImportError(msg);
                                toast.error(msg);
                              } finally {
                                setSmartImportLoading(false);
                              }
                            }}
                            className="h-9 px-5 text-sm rounded-xl text-white font-semibold shadow-sm disabled:opacity-50 flex items-center gap-2 transition-all"
                            style={{ background: smartImportLoading ? '#94a3b8' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
                          >
                            {smartImportLoading ? (
                              <><div className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Extracting…</>
                            ) : (
                              <><svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-white"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg> Extract &amp; Fill Form</>
                            )}
                          </button>
                          <p className="text-[10px] text-slate-400">
                            {[smartImportFiles.gst && 'GST', smartImportFiles.udyam && 'Udyam', smartImportFiles.mca && 'MCA'].filter(Boolean).join(' + ')} ready
                          </p>
                        </div>
                      )}
                      {smartImportError && (
                        <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-red-500 flex-shrink-0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                          <p className="text-xs text-red-700 font-medium">{smartImportError}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {/* ── MCA Live Lookup ──────────────────────────────────────────────────── */}
                  {['pvt_ltd', 'llp', 'public_ltd', 'section_8'].includes(formData.client_type) && (
                    <div className={`border-2 rounded-2xl p-5 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-gradient-to-br from-violet-50/80 to-purple-50/50 border-violet-100'}`}>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0 shadow-sm" style={{ background: 'linear-gradient(135deg, #4F46E5, #7C3AED)' }}>
                          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
                        </div>
                        <div>
                          <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Auto-fill from MCA Portal</p>
                          <p className="text-xs text-slate-500 mt-0.5">Enter company name or CIN / LLPIN to auto-fill details</p>
                        </div>
                        {formData.mca_fetch_date && (
                          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                            ✓ Fetched {formData.mca_fetch_date}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 items-start">
                        <div className="flex-1">
                          <input
                            type="text"
                            placeholder="Enter company name or CIN / LLPIN (e.g. IKYRAA JEWELS LLP or AAA-1234)"
                            value={mcaQuery}
                            onChange={e => setMcaQuery(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && mcaQuery.trim().length >= 3 && !mcaFetching) {
                                e.preventDefault();
                                e.currentTarget.closest('div').querySelector('button').click();
                              }
                            }}
                            className={`w-full h-11 px-3 rounded-xl border text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 placeholder-slate-400' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'} focus:outline-none focus:border-violet-400`}
                          />
                          {formData.mca_fetch_date && (
                            <p className="text-[10px] text-slate-400 mt-1">Company data loaded. You can still edit fields below.</p>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={mcaFetching || mcaQuery.trim().length < 3}
                          onClick={async () => {
                            const q = (mcaQuery.trim() || formData.company_name.trim());
                            if (!q) return;
                            setMcaFetching(true);
                            try {
                              const d = normalizeMcaDetails((await api.get('/clients/fetch-mca-details', { params: { query: q } })).data || {});
                              const isLLP = (d.client_type === 'llp') || /llp/i.test(d.company_name || '');
                              const masterDate = d.mca_fetch_date || new Date().toISOString().slice(0, 10);
                              setFormData(p => ({
                                ...p,
                                company_name: d.company_name || p.company_name,
                                client_type: d.client_type || p.client_type,
                                date_of_incorporation: d.date_of_incorporation || p.date_of_incorporation || '',
                                address: d.address || p.address,
                                city: d.city || p.city,
                                state: d.state || p.state,
                                pincode: d.pin || p.pincode || '',
                                email: d.email || p.email,
                                pan: d.pan || p.pan,
                                gst_pin: d.gst_pin || d.pin || p.gst_pin,
                                cin: isLLP ? '' : (d.cin || p.cin || ''),
                                llpin: isLLP ? (d.llpin || p.llpin || '') : '',
                                mca_fetch_date: masterDate,
                                mca_registration_number: d.registration_number || p.mca_registration_number || '',
                                mca_roc_name: d.roc_name || d.roc || p.mca_roc_name || '',
                                mca_rd_name: d.rd_name || p.mca_rd_name || '',
                                mca_company_category: d.company_category || p.mca_company_category || '',
                                mca_company_subcategory: d.company_subcategory || p.mca_company_subcategory || '',
                                mca_listed: typeof d.listed === 'boolean' ? d.listed : p.mca_listed,
                                mca_active_compliance: d.active_compliance || p.mca_active_compliance || '',
                                mca_authorized_capital: d.authorized_capital || p.mca_authorized_capital || '',
                                mca_paid_up_capital: d.paid_up_capital || p.mca_paid_up_capital || '',
                                mca_last_agm_date: d.last_agm_date || p.mca_last_agm_date || '',
                                mca_balance_sheet_date: d.balance_sheet_date || p.mca_balance_sheet_date || '',
                                mca_books_address: d.books_address || p.mca_books_address || '',
                                mca_charges: Array.isArray(d.charges) ? d.charges : (p.mca_charges || []),
                                mca_loan_details: Array.isArray(d.loan_details) ? d.loan_details : (p.mca_loan_details || []),
                                contact_persons: d.directors?.length
                                  ? d.directors.map(dir => ({
                                      name: dir.name || '',
                                      designation: dir.designation || 'Director',
                                      din: dir.din || '',
                                      email: '',
                                      phone: '',
                                      birthday: '',
                                    }))
                                  : p.contact_persons,
                              }));
                              setMcaQuery(q);
                              toast.success('Company master data loaded' + (d.source ? ' · ' + d.source : ''));
                            } catch (err) {
                              const msg = err?.response?.data?.detail || err?.message || 'Could not fetch company master data. Try the exact company name or CIN.';
                              toast.error(msg);
                            } finally {
                              setMcaFetching(false);
                            }
                          }}
                          className="h-11 px-5 rounded-none text-sm font-medium text-white flex items-center gap-2 flex-shrink-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          style={{ background: mcaFetching ? '#94a3b8' : 'linear-gradient(135deg, #4F46E5, #7C3AED)' }}
                        >
                          {mcaFetching ? (
                            <><div className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Fetching…</>
                          ) : (
                            <><svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-white"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> Fetch from MCA</>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Basic Details */}
                  <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                    <SectionHeading icon={<Briefcase className="h-4 w-4" />} title="Basic Details" subtitle="Company identity and primary contact" isDark={isDark} />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className={labelCls}>Company Name <span className="text-red-400">*</span></label>
                        <Input data-field-error={formErrors.company_name ? true : undefined} className={fieldCls(formErrors.company_name)} value={formData.company_name} onChange={e => { setFormData(p => ({ ...p, company_name: e.target.value })); if (formErrors.company_name) setFormErrors(prev => ({ ...prev, company_name: undefined })); }} required />
                        {formErrors.company_name && <p className="text-red-500 text-xs mt-1">{formErrors.company_name}</p>}
                      </div>
                      <div>
                        <label className={labelCls}>Client Type <span className="text-red-400">*</span></label>
                        <Select value={formData.client_type} onValueChange={v => setFormData(p => ({ ...p, client_type: v, client_type_other: '' }))}>
                          <SelectTrigger className={`h-11 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{CLIENT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                        </Select>
                        {formData.client_type === 'other' && <Input className={`mt-2 h-11 focus:border-blue-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} placeholder="Specify client type…" value={formData.client_type_other} onChange={e => setFormData(p => ({ ...p, client_type_other: e.target.value }))} autoFocus />}
                      </div>
                      {/* ── Client-type-specific identity field ─────────────────────────
                          Pvt Ltd / Public Ltd / Section 8 → CIN, LLP → LLPIN, Proprietor → Proprietor Name */}
                      {['pvt_ltd', 'public_ltd', 'section_8'].includes(formData.client_type) && (
                        <div>
                          <label className={labelCls}>CIN <span className="text-slate-400 font-normal">(Corporate Identity Number)</span></label>
                          <Input className={fieldCls(false)} placeholder="21-character CIN" value={formData.cin || ''} onChange={e => setFormData(p => ({ ...p, cin: e.target.value.toUpperCase() }))} />
                        </div>
                      )}
                      {formData.client_type === 'llp' && (
                        <div>
                          <label className={labelCls}>LLPIN <span className="text-slate-400 font-normal">(LLP Identification Number)</span></label>
                          <Input className={fieldCls(false)} placeholder="e.g. AAA-1234" value={formData.llpin || ''} onChange={e => setFormData(p => ({ ...p, llpin: e.target.value.toUpperCase() }))} />
                        </div>
                      )}
                      {formData.client_type === 'proprietor' && (
                        <div>
                          <label className={labelCls}>Proprietor Name</label>
                          <Input className={fieldCls(false)} placeholder="Full name of the proprietor" value={formData.proprietor_name || ''} onChange={e => setFormData(p => ({ ...p, proprietor_name: e.target.value }))} />
                        </div>
                      )}
                      <div>
                        <label className={labelCls}>Email Address</label>
                        <Input data-field-error={formErrors.email ? true : undefined} className={fieldCls(formErrors.email)} type="email" value={formData.email} onChange={e => { setFormData(p => ({ ...p, email: e.target.value })); if (formErrors.email) setFormErrors(prev => ({ ...prev, email: undefined })); }} />
                        {formErrors.email && <p className="text-red-500 text-xs mt-1">{formErrors.email}</p>}
                      </div>
                      <div>
                        <label className={labelCls}>Phone Number <span className="text-slate-400 font-normal">(optional)</span></label>
                        <Input data-field-error={formErrors.phone ? true : undefined} className={fieldCls(formErrors.phone)} value={formData.phone} onChange={e => { setFormData(p => ({ ...p, phone: e.target.value })); if (formErrors.phone) setFormErrors(prev => ({ ...prev, phone: undefined })); }} />
                        {formErrors.phone && <p className="text-red-500 text-xs mt-1">{formErrors.phone}</p>}
                      </div>
                      {['pvt_ltd', 'public_ltd', 'section_8'].includes(formData.client_type) && (
                        <div>
                          <label className={labelCls}>Date of Incorporation</label>
                          <Input className={`h-11 focus:border-blue-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} type="date" value={formData.date_of_incorporation || ''} onChange={e => setFormData(p => ({ ...p, date_of_incorporation: e.target.value }))} />
                        </div>
                      )}
                      {formData.client_type === 'proprietor' && (
                        <div>
                          <label className={labelCls}>Date of Birth</label>
                          <Input className={`h-11 focus:border-blue-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} type="date" value={formData.birthday || ''} onChange={e => setFormData(p => ({ ...p, birthday: e.target.value }))} />
                        </div>
                      )}
                      <div>
                        <label className={labelCls}>Referred By</label>
                        <EditableDropdown
                          value={referrerSelectValue === '__other__' ? '' : referrerSelectValue}
                          onChange={v => handleReferrerSelectChange(v || '')}
                          options={savedReferrers.filter(r => r !== 'Our Client')}
                          staticOptions={['Our Client']}
                          onEdit={updateReferrer}
                          onDelete={deleteReferrer}
                          onAddNew={() => handleReferrerSelectChange('__other__')}
                          placeholder="— Select referral source —"
                          icon={<Share2 className="h-4 w-4" />}
                          isDark={isDark}
                        />
                        {referrerSelectValue === '__other__' && (
                          <div className="flex gap-2 mt-2">
                            <Input className={`flex-1 h-11 focus:border-blue-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} placeholder="Type referrer's name…" value={referrerInput} onChange={e => handleReferrerInputChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSaveReferrer(); } }} autoFocus />
                            <Button type="button" onClick={handleSaveReferrer} className="h-11 px-4 rounded-xl text-white text-sm font-semibold gap-1.5" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}><Plus className="h-4 w-4" /> Save</Button>
                          </div>
                        )}
                        {referrerSelectValue === '__other__' && (() => {
                          const isDup = referrerInput.trim() && savedReferrers.some(r => r.toLowerCase() === referrerInput.trim().toLowerCase());
                          return isDup
                            ? <p className="text-[10px] text-amber-600 mt-1.5">⚠ "{referrerInput.trim()}" already exists — click Save to select it</p>
                            : <p className="text-[10px] text-slate-400 mt-1.5">Press Enter or click Save — name will appear in dropdown next time</p>;
                        })()}
                      </div>
                      <div>
                        <label className={labelCls}>Auditor <span className="text-slate-400 font-normal">(optional)</span></label>
                        <EditableDropdown
                          value={auditorSelectValue === '__other__' ? '' : auditorSelectValue}
                          onChange={v => handleAuditorSelectChange(v || '')}
                          options={savedAuditors}
                          staticOptions={[]}
                          onEdit={updateAuditor}
                          onDelete={deleteAuditor}
                          onAddNew={() => handleAuditorSelectChange('__other__')}
                          placeholder="— Select auditor —"
                          icon={<FileCheck className="h-4 w-4" />}
                          isDark={isDark}
                        />
                        {auditorSelectValue === '__other__' && (
                          <div className="flex gap-2 mt-2">
                            <Input className={`flex-1 h-11 focus:border-purple-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} placeholder="Type auditor's name…" value={auditorInput} onChange={e => handleAuditorInputChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSaveAuditor(); } }} autoFocus />
                            <Button type="button" onClick={handleSaveAuditor} className="h-11 px-4 rounded-xl text-white text-sm font-semibold gap-1.5" style={{ background: 'linear-gradient(135deg, #4c1d95, #7c3aed)' }}><Plus className="h-4 w-4" /> Save</Button>
                          </div>
                        )}
                        {auditorSelectValue === '__other__' && (() => {
                          const isDup = auditorInput.trim() && savedAuditors.some(a => a.toLowerCase() === auditorInput.trim().toLowerCase());
                          return isDup
                            ? <p className="text-[10px] text-amber-600 mt-1.5">⚠ "{auditorInput.trim()}" already exists — click Save to select it</p>
                            : <p className="text-[10px] text-slate-400 mt-1.5">Press Enter or click Save — auditor will appear in dropdown next time</p>;
                        })()}
                      </div>
                      {/* ── Address Section: tabs when GST address differs from primary ─ */}
                      {(() => {
                        const hasGstAddr = !!(formData.gst_address && formData.gst_address.trim());
                        const addrsDiffer = hasGstAddr && formData.address &&
                          formData.gst_address.toLowerCase().trim() !== formData.address.toLowerCase().trim();
                        const inpCls = `h-11 focus:border-blue-400 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`;

                        return (
                          <div className="md:col-span-2 space-y-3">
                            {/* Tab switcher — only when two distinct addresses exist */}
                            {hasGstAddr && (
                              <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? 'bg-slate-700/60' : 'bg-slate-100'}`}>
                                <button
                                  type="button"
                                  onClick={() => setAddressTab('primary')}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                    addressTab === 'primary'
                                      ? 'bg-white shadow text-slate-800 dark:bg-slate-600 dark:text-white'
                                      : 'text-slate-500 hover:text-slate-700'
                                  }`}
                                >
                                  🏢 Primary Address
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAddressTab('gst')}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                    addressTab === 'gst'
                                      ? 'bg-white shadow text-slate-800 dark:bg-slate-600 dark:text-white'
                                      : 'text-slate-500 hover:text-slate-700'
                                  }`}
                                >
                                  📋 GST Certificate
                                  {addrsDiffer && (
                                    <span className="text-[9px] font-bold text-amber-600 bg-amber-100 rounded-full px-1.5 py-0.5">
                                      Different
                                    </span>
                                  )}
                                </button>
                              </div>
                            )}

                            {/* Primary address panel */}
                            {(!hasGstAddr || addressTab === 'primary') && (
                              <div className="space-y-3">
                                <div>
                                  <label className={labelCls}>
                                    {hasGstAddr ? 'Primary Address (used for invoices)' : 'Address'}
                                  </label>
                                  <Input
                                    className={inpCls}
                                    placeholder="Street address (optional)"
                                    value={formData.address}
                                    onChange={e => setFormData(p => ({ ...p, address: e.target.value }))}
                                  />
                                </div>
                                <div className="grid grid-cols-3 gap-3">
                                  <div>
                                    <label className={labelCls}>City</label>
                                    <Input className={inpCls} value={formData.city} onChange={e => setFormData(p => ({ ...p, city: e.target.value }))} />
                                  </div>
                                  <div>
                                    <label className={labelCls}>State</label>
                                    <Input className={inpCls} value={formData.state} onChange={e => setFormData(p => ({ ...p, state: e.target.value }))} />
                                  </div>
                                  <div>
                                    <label className={labelCls}>PIN Code <span className="text-slate-400 font-normal normal-case">(auto-fills State)</span></label>
                                    <Input
                                      className={`${inpCls} font-mono`}
                                      placeholder="6-digit PIN"
                                      maxLength={6}
                                      value={formData.pincode || ''}
                                      onChange={async e => {
                                        const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                                        setFormData(p => ({ ...p, pincode: digits }));
                                        if (digits.length === 6) {
                                          const r = await lookupPincode(digits);
                                          if (r?.valid) {
                                            setFormData(p => ({ ...p, state: r.state }));
                                            toast.success(`State auto-set to ${r.state}`);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* GST Certificate address panel */}
                            {hasGstAddr && addressTab === 'gst' && (
                              <div className={`rounded-xl border p-4 space-y-3 ${isDark ? 'bg-green-900/10 border-green-800/40' : 'bg-green-50/60 border-green-200'}`}>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-xs font-semibold text-green-700 dark:text-green-400">
                                    📋 GST REG-06 Certificate Address
                                  </span>
                                  <span className="text-[10px] text-slate-400">Auto-filled from certificate · editable</span>
                                </div>
                                <div>
                                  <label className={labelCls}>GST Registered Address</label>
                                  <Input
                                    className={inpCls}
                                    placeholder="GST registered address from certificate"
                                    value={formData.gst_address || ''}
                                    onChange={e => setFormData(p => ({ ...p, gst_address: e.target.value }))}
                                  />
                                </div>
                                <div className="grid grid-cols-3 gap-3">
                                  <div>
                                    <label className={labelCls}>City</label>
                                    <Input
                                      className={inpCls}
                                      placeholder="City"
                                      value={formData.gst_city || ''}
                                      onChange={e => setFormData(p => ({ ...p, gst_city: e.target.value }))}
                                    />
                                  </div>
                                  <div>
                                    <label className={labelCls}>State</label>
                                    <Input
                                      className={inpCls}
                                      placeholder="State"
                                      value={formData.gst_state || ''}
                                      onChange={e => setFormData(p => ({ ...p, gst_state: e.target.value }))}
                                    />
                                  </div>
                                  <div>
                                    <label className={labelCls}>PIN Code</label>
                                    <Input
                                      className={inpCls}
                                      placeholder="6-digit PIN"
                                      maxLength={6}
                                      value={formData.gst_pin || ''}
                                      onChange={e => setFormData(p => ({ ...p, gst_pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                                    />
                                  </div>
                                </div>
                                <p className="text-[10px] text-slate-400">
                                  Both addresses are saved. Primary is used for invoices; GST address is shown on GST reports.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {/* NOTE: City & State fields are rendered once, inside the primary/GST
                          address panels above. A duplicate unconditional City/State block used
                          to live here and rendered a second copy of the same two fields whenever
                          formData.gst_address was empty — removed to fix the double row. */}
                    </div>
                  </div>
                  {/* MCA / ROC Company Master Data */}
                  {['pvt_ltd', 'public_ltd', 'section_8', 'llp'].includes(formData.client_type) && (
                    <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                      <div className="flex items-start justify-between gap-3 mb-5">
                        <SectionHeading icon={<Building2 className="h-4 w-4" />} title="MCA / ROC Company Master Data" subtitle="Structured company master data used by ROC Sphere and annual compliance workflows" isDark={isDark} />
                        {formData.mca_fetch_date && <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-semibold">Master data loaded · {formData.mca_fetch_date}</span>}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {[
                          ['CIN', formData.cin], ['Registration Number', formData.mca_registration_number],
                          ['ROC', formData.mca_roc_name], ['RD / Region', formData.mca_rd_name],
                          ['Company Category', formData.mca_company_category], ['Subcategory', formData.mca_company_subcategory],
                          ['Authorised Capital', formData.mca_authorized_capital], ['Paid-up Capital', formData.mca_paid_up_capital],
                          ['Last AGM', formData.mca_last_agm_date], ['Balance Sheet Date', formData.mca_balance_sheet_date],
                          ['Listed', formData.mca_listed === null ? '' : (formData.mca_listed ? 'Yes' : 'No')],
                          ['ACTIVE Compliance', formData.mca_active_compliance],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <label className={labelCls}>{label}</label>
                            <Input className={fieldCls(false)} value={value ?? ''} onChange={e => {
                              const map = {'CIN':'cin','Registration Number':'mca_registration_number','ROC':'mca_roc_name','RD / Region':'mca_rd_name','Company Category':'mca_company_category','Subcategory':'mca_company_subcategory','Authorised Capital':'mca_authorized_capital','Paid-up Capital':'mca_paid_up_capital','Last AGM':'mca_last_agm_date','Balance Sheet Date':'mca_balance_sheet_date','ACTIVE Compliance':'mca_active_compliance'};
                              if (label === 'Listed') setFormData(p => ({ ...p, mca_listed: e.target.value.toLowerCase() === 'yes' }));
                              else setFormData(p => ({ ...p, [map[label]]: e.target.value }));
                            }} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-4">
                        <label className={labelCls}>Address at which books of account are maintained</label>
                        <Input className={fieldCls(false)} value={formData.mca_books_address || ''} onChange={e => setFormData(p => ({ ...p, mca_books_address: e.target.value }))} />
                      </div>
                      <div className="mt-4 grid md:grid-cols-2 gap-4">
                        <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-white'}`}>
                          <div className="flex items-center justify-between mb-2"><p className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Charges Created</p><span className="text-[10px] text-slate-400">{formData.mca_charges?.length || 0} record(s)</span></div>
                          {formData.mca_charges?.length ? <div className="space-y-2">{formData.mca_charges.map((charge, i) => <div key={i} className="rounded-lg border p-2 text-[10px] text-slate-500">{charge.raw || Object.entries(charge).filter(([k]) => k !== 'raw').map(([k,v]) => k + ': ' + v).join(' · ')}</div>)}</div> : <p className="text-[11px] text-slate-400">No charge records found in the loaded master data.</p>}
                        </div>
                        <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-white'}`}>
                          <div className="flex items-center justify-between mb-2"><p className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Loans / Borrowings</p><span className="text-[10px] text-slate-400">{formData.mca_loan_details?.length || 0} record(s)</span></div>
                          {formData.mca_loan_details?.length ? <div className="space-y-2">{formData.mca_loan_details.map((loan, i) => <div key={i} className="rounded-lg border p-2 text-[10px] text-slate-500">{loan.raw || Object.entries(loan).map(([k,v]) => k + ': ' + v).join(' · ')}</div>)}</div> : <p className="text-[11px] text-slate-400">No loan details are present in the loaded master-data source.</p>}
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Contact Persons */}
                  <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                    <div className="flex items-center justify-between mb-5">
                      <SectionHeading icon={<Users className="h-4 w-4" />} title="Contact Persons" subtitle="Key people you work with (birthdays tracked here)" isDark={isDark} />
                      <Button type="button" size="sm" onClick={addContact} variant="outline" className="h-8 px-3 text-xs rounded-xl border-slate-200 -mt-2"><Plus className="h-3 w-3 mr-1" /> Add Person</Button>
                    </div>
                    {formErrors.contacts && <p className="text-red-500 text-xs mb-4 flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-red-400 rounded-full inline-block" />{formErrors.contacts}</p>}
                    <div className="space-y-4">{formData.contact_persons.map((cp, idx) => (
                      <div key={idx} className={`border rounded-xl p-5 relative ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2"><div className="w-6 h-6 rounded-lg bg-slate-100 text-slate-500 text-[10px] font-bold flex items-center justify-center">{idx + 1}</div><span className="text-sm font-semibold text-slate-700">Contact Person</span></div>
                          {formData.contact_persons.length > 1 && <button type="button" onClick={() => removeContact(idx)} className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><Trash className="h-3.5 w-3.5" /></button>}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div><label className={labelCls}>Full Name</label><Input data-field-error={contactErrors[idx]?.name ? true : undefined} value={cp.name} onChange={e => updateContact(idx, 'name', e.target.value)} className={fieldCls(contactErrors[idx]?.name)} />{contactErrors[idx]?.name && <p className="text-red-500 text-xs mt-1">{contactErrors[idx].name}</p>}</div>
                          <div><label className={labelCls}>Designation</label><Input value={cp.designation} onChange={e => updateContact(idx, 'designation', e.target.value)} className={fieldCls(false)} /></div>
                          <div><label className={labelCls}>Email</label><Input type="email" value={cp.email} onChange={e => updateContact(idx, 'email', e.target.value)} className={fieldCls(contactErrors[idx]?.email)} />{contactErrors[idx]?.email && <p className="text-red-500 text-xs mt-1">{contactErrors[idx].email}</p>}</div>
                          <div><label className={labelCls}>Phone</label><Input value={cp.phone} onChange={e => updateContact(idx, 'phone', e.target.value)} className={fieldCls(contactErrors[idx]?.phone)} />{contactErrors[idx]?.phone && <p className="text-red-500 text-xs mt-1">{contactErrors[idx].phone}</p>}</div>
                          <div><label className={labelCls}>Date of Birth</label><Input type="date" value={cp.birthday || ''} onChange={e => updateContact(idx, 'birthday', e.target.value)} className={fieldCls(false)} /></div>
                          <div><label className={labelCls}>DIN (Director ID)</label><Input value={cp.din || ''} onChange={e => updateContact(idx, 'din', e.target.value)} className={fieldCls(false)} /></div>
                        </div>
                      </div>
                    ))}</div>
                  </div>
                  {/* DSC Details */}
                  <DSCLinkerSection
                    formData={formData}
                    setFormData={setFormData}
                    updateDSC={updateDSC}
                    addDSC={addDSC}
                    removeDSC={removeDSC}
                    companyName={formData.company_name}
                    isDark={isDark}
                    labelCls={labelCls}
                    fieldCls={fieldCls}
                  />
                  {/* Services */}
                  <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                    <SectionHeading icon={<BarChart3 className="h-4 w-4" />} title="Services" subtitle="Select all applicable services" isDark={isDark} />
                    <div className="flex flex-wrap gap-2">{SERVICES.map(s => { const isSel = formData.services.includes(s) || (s === 'Other' && formData.services.some(x => x.startsWith('Other:'))); return <button key={s} type="button" onClick={() => toggleService(s)} className={`px-4 py-1.5 text-xs font-semibold rounded-xl border transition-all ${isSel ? 'text-white border-transparent shadow-sm' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600 hover:border-slate-500' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`} style={isSel ? { background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)', borderColor: 'transparent' } : {}}>{s}</button>; })}</div>
                    {formData.services.includes('Other') && (
                      <div className="flex gap-3 items-end max-w-sm mt-4">
                        <div className="flex-1"><label className={labelCls}>Specify Other Service</label><Input placeholder="e.g. IEC Registration" value={otherService} onChange={e => setOtherService(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOtherService(); } }} className="h-10 rounded-xl text-sm border-slate-200" /></div>
                        <Button type="button" size="sm" onClick={addOtherService} className="h-10 px-5 rounded-xl text-sm" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>Add</Button>
                      </div>
                    )}
                  </div>
                  {/* Tax & Billing */}
                  <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                    <SectionHeading icon={<FileCheck className="h-4 w-4" />} title="Tax & Billing" subtitle="GST, PAN, payment terms and Tally sync" isDark={isDark} />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className={labelCls}>GSTIN</label>
                        <Input className={fieldCls(false)} placeholder="15-digit GSTIN" value={formData.gstin || ''} onChange={e => setFormData(p => ({ ...p, gstin: e.target.value.toUpperCase() }))} />
                      </div>
                      <div>
                        <label className={labelCls}>PAN</label>
                        <Input className={fieldCls(false)} placeholder="10-digit PAN" value={formData.pan || ''} onChange={e => setFormData(p => ({ ...p, pan: e.target.value.toUpperCase() }))} />
                      </div>
                      <div>
                        <label className={labelCls}>GST Treatment</label>
                        <Select value={formData.gst_treatment || 'regular'} onValueChange={v => setFormData(p => ({ ...p, gst_treatment: v }))}>
                          <SelectTrigger className={`h-11 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="regular">Regular Taxpayer</SelectItem>
                            <SelectItem value="composition">Composition Scheme</SelectItem>
                            <SelectItem value="unregistered">Unregistered</SelectItem>
                            <SelectItem value="consumer">Consumer (B2C)</SelectItem>
                            <SelectItem value="overseas">Overseas / SEZ</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className={labelCls}>Place of Supply</label>
                        <Input className={fieldCls(false)} placeholder="State / UT" value={formData.place_of_supply || ''} onChange={e => setFormData(p => ({ ...p, place_of_supply: e.target.value }))} />
                      </div>
                      <div>
                        <label className={labelCls}>Default Payment Terms</label>
                        <Select value={formData.default_payment_terms || 'Due on receipt'} onValueChange={v => setFormData(p => ({ ...p, default_payment_terms: v }))}>
                          <SelectTrigger className={`h-11 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {['Due on receipt','Due in 7 days','Due in 15 days','Due in 30 days','Due in 45 days','Due in 60 days','Due in 90 days','Advance payment'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className={labelCls}>Credit Limit (₹)</label>
                        <Input type="number" className={fieldCls(false)} placeholder="0" value={formData.credit_limit || ''} onChange={e => setFormData(p => ({ ...p, credit_limit: e.target.value }))} />
                      </div>
                      <div>
                        <label className={labelCls}>Opening Balance (₹)</label>
                        <div className="flex gap-2">
                          <Input type="number" className={`${fieldCls(false)} flex-1`} placeholder="0" value={formData.opening_balance || ''} onChange={e => setFormData(p => ({ ...p, opening_balance: e.target.value }))} />
                          <Select value={formData.opening_balance_type || 'Dr'} onValueChange={v => setFormData(p => ({ ...p, opening_balance_type: v }))}>
                            <SelectTrigger className="h-11 w-20 rounded-xl text-sm border-slate-200"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="Dr">Dr</SelectItem><SelectItem value="Cr">Cr</SelectItem></SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Website</label>
                        <Input type="url" className={fieldCls(false)} placeholder="https://..." value={formData.website || ''} onChange={e => setFormData(p => ({ ...p, website: e.target.value }))} />
                      </div>
                      <div>
                        <label className={labelCls}>MSME / Udyam Number</label>
                        <Input className={fieldCls(false)} value={formData.msme_number || ''} onChange={e => setFormData(p => ({ ...p, msme_number: e.target.value }))} />
                      </div>
                      <div>
                        <label className={labelCls}>Tally Ledger Name</label>
                        <Input className={fieldCls(false)} value={formData.tally_ledger_name || ''} onChange={e => setFormData(p => ({ ...p, tally_ledger_name: e.target.value }))} />
                      </div>
                      <div>
                        <label className={labelCls}>Tally Group</label>
                        <Select value={formData.tally_group || 'Sundry Debtors'} onValueChange={v => setFormData(p => ({ ...p, tally_group: v }))}>
                          <SelectTrigger className={`h-11 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {['Sundry Debtors','Sundry Creditors','Current Assets','Current Liabilities','Other'].map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>



                  
                  {/* Notes */}
                  <div><label className={labelCls}>Internal Notes</label><Textarea className={`min-h-[110px] rounded-xl text-sm resize-y focus:border-blue-400 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} placeholder="Internal remarks…" value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} /></div>
                  {/* User Assignments */}
                  {canAssignClients && (
                    <div className={`border rounded-2xl p-6 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`}>
                      <div className="flex items-center justify-between mb-5">
                        <SectionHeading icon={<Briefcase className="h-4 w-4" />} title="User Assignments" subtitle="Assign users with specific services" isDark={isDark} />
                        <Button type="button" size="sm" onClick={addAssignment} variant="outline" className="h-8 px-3 text-xs rounded-xl border-slate-200 -mt-2"><Plus className="h-3 w-3 mr-1" /> Add User</Button>
                      </div>
                      <div className="space-y-4">{(formData.assignments || []).map((assignment, idx) => (
                        <div key={idx} className={`border rounded-xl p-5 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2"><div className="w-6 h-6 rounded-lg bg-slate-100 text-slate-500 text-[10px] font-bold flex items-center justify-center">{idx + 1}</div><span className="text-sm font-semibold text-slate-700">Assignment</span></div>
                            {(formData.assignments || []).length > 1 && <button type="button" onClick={() => removeAssignment(idx)} className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><Trash className="h-3.5 w-3.5" /></button>}
                          </div>
                          <div className="mb-4">
                            <label className={labelCls}>User</label>
                            <Select value={assignment.user_id || 'unassigned'} onValueChange={v => updateAssignmentUser(idx, v === 'unassigned' ? '' : v)}>
                              <SelectTrigger className={`h-11 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}><SelectValue placeholder="Select team member" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unassigned">— Unassigned —</SelectItem>
                                {users.filter(u => {
                                  const otherIds = (formData.assignments || []).filter((_, i) => i !== idx).map(a => a.user_id).filter(Boolean);
                                  if (otherIds.includes(u.id)) return false;
                                  const S2D = { GST: 'GST', 'Income Tax': 'IT', Accounting: 'ACC', TDS: 'TDS', ROC: 'ROC', Trademark: 'TM', Audit: 'ACC', Compliance: 'ROC', 'Company Registration': 'ROC', 'Tax Planning': 'IT', Payroll: 'ACC' };
                                  const depts = [...new Set((formData.services || []).map(s => S2D[s]).filter(Boolean))];
                                  if (depts.length === 0) return true;
                                  return (u.departments || []).some(d => depts.includes(d));
                                }).map(u => (
                                  <SelectItem key={u.id} value={u.id}>
                                    {u.full_name || u.name || u.email}
                                    {u.departments?.length > 0 && <span className="text-xs text-slate-400 ml-1">· {u.departments.join(', ')}</span>}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className={labelCls}>Services for this user <span className="text-slate-300 font-normal">(optional — leave blank for all)</span></label>
                            <div className="flex flex-wrap gap-2 mt-1">
                              {formData.services.map(svc => { const d = svc.startsWith('Other:') ? svc.replace('Other: ', '') : svc; const isSel = assignment.services.includes(svc); return <button key={svc} type="button" onClick={() => toggleAssignmentService(idx, svc)} className={`px-3 py-1 text-xs font-semibold rounded-xl border transition-all ${isSel ? 'text-white border-transparent shadow-sm' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`} style={isSel ? { background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' } : {}}>{d}</button>; })}
                              {formData.services.length === 0 && <p className="text-xs text-slate-400 italic">Select services above first</p>}
                            </div>
                          </div>
                        </div>
                      ))}</div>
                    </div>
                  )}
                  {/* Footer */}
                  <div className={`flex flex-col sm:flex-row items-center justify-between gap-3 pt-5 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)} className="h-9 px-4 text-sm rounded-xl text-slate-500">Cancel</Button>
                      <Button type="button" variant="outline" onClick={downloadTemplate} className="h-9 px-4 text-sm rounded-xl border-slate-200 text-slate-600">CSV Template</Button>
                    </div>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" className="h-9 px-4 text-sm rounded-xl border-slate-200" onClick={() => fileInputRef.current?.click()}>Import Excel / CSV</Button>
                      <Button type="submit" disabled={loading} className="h-9 px-6 text-sm rounded-xl text-white font-semibold shadow-sm" style={{ background: loading ? '#94a3b8' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>{loading ? 'Saving…' : editingClient ? 'Update Client' : 'Create Client'}</Button>
                    </div>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* DSC EXPIRY ALERT BANNER */}
      {dscAlerts.length > 0 && (
        <div className="flex items-start gap-5 border border-orange-200 rounded-2xl p-5 shadow-sm" style={{ background: 'linear-gradient(135deg, #fff7ed, #fffbeb)' }}>
          <div className="w-11 h-11 rounded-xl shadow-sm text-orange-500 flex items-center justify-center flex-shrink-0 bg-white"><Shield className="h-5 w-5" /></div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-orange-900 mb-1">⚠ DSC Expiring Soon ({dscAlerts.length} certificate{dscAlerts.length !== 1 ? 's' : ''})</p>
            <div className="flex flex-wrap gap-2">
              {dscAlerts.slice(0, 8).map((alert, i) => (
                <span key={i} className="text-xs font-medium px-3 py-1 border border-orange-200 rounded-full shadow-sm bg-white text-orange-700">
                  {alert.client.company_name} · {alert.dsc.holder_name} · <strong>{alert.days}d</strong>
                </span>
              ))}
              {dscAlerts.length > 8 && <span className="text-xs font-medium px-3 py-1 border border-orange-200 rounded-full bg-white text-orange-500">+{dscAlerts.length - 8} more</span>}
            </div>
          </div>
        </div>
      )}

      {/* BIRTHDAY REMINDERS — shown for all roles; only clients visible to the user appear */}
      {todayReminders.length > 0 && (
        <div className="flex items-center gap-5 border border-pink-200 rounded-2xl p-5 shadow-sm" style={{ background: 'linear-gradient(135deg, #fff0f6, #fff5f0)' }}>
          <div className={`w-11 h-11 rounded-xl shadow-sm text-pink-500 flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-white'}`}><Cake className="h-5 w-5" /></div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-pink-900 mb-1">🎂 Birthday Reminders Today</p>
            <div className="flex flex-wrap gap-2">
              {todayReminders.map(c => {
                const contacts = c.contact_persons?.filter(cp => { if (!cp?.birthday) return false; const b = new Date(cp.birthday); const t = new Date(); return b.getMonth() === t.getMonth() && b.getDate() === t.getDate(); }) || [];
                return contacts.map((cp, i) => (
                  <span key={`${c.id}-${i}`} className={`text-xs font-medium px-3 py-1 border border-pink-200 rounded-full shadow-sm ${isDark ? 'bg-slate-700 text-pink-400' : 'bg-white text-pink-700'}`}>
                    {cp.name} <span className="text-pink-400 font-normal">· {c.company_name}</span>
                  </span>
                ));
              })}
            </div>
          </div>
        </div>
      )}

      {/* STATS */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Clients',  value: stats.totalClients,  icon: <Users className="h-5 w-5" />, grad: 'linear-gradient(135deg, #0D3B66, #1F6FB2)', light: '#eff6ff', iconC: '#1d4ed8' },
          { label: 'Active',         value: stats.activeClients, icon: <Briefcase className="h-5 w-5" />, grad: 'linear-gradient(135deg, #059669, #10b981)', light: '#f0fdf4', iconC: '#059669' },
          { label: 'Archived',       value: stats.totalClients - stats.activeClients, icon: <Archive className="h-5 w-5" />, grad: 'linear-gradient(135deg, #d97706, #f59e0b)', light: '#fffbeb', iconC: '#d97706' },
          { label: 'Top Service',    value: Object.entries(stats.serviceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A', icon: <BarChart3 className="h-5 w-5" />, grad: 'linear-gradient(135deg, #7c3aed, #a855f7)', light: '#fdf4ff', iconC: '#7c3aed', isText: true },
        ].map((s, i) => (
          <div key={i} className={`rounded-2xl border overflow-hidden transition-all hover:shadow-lg hover:-translate-y-0.5 ${isDark ? 'bg-slate-800 border-slate-700/60' : 'bg-white border-slate-100'}`}>
            <div className="h-1 w-full" style={{ background: s.grad }} />
            <div className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: isDark ? 'rgba(255,255,255,0.07)' : s.light, color: s.iconC }}>{s.icon}</div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{s.label}</p>
              </div>
              <p className={`font-bold leading-none ${s.isText ? 'text-lg truncate' : 'text-3xl tracking-tight'} ${isDark ? 'text-white' : 'text-slate-900'}`}>{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* FILTERS + SORT + VIEW TOGGLE */}
      <div className={`rounded-2xl border shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
        {/* Row 1: search */}
        <div className={`flex items-center gap-3 px-3.5 pt-3.5 pb-2.5 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <Input
              ref={searchRef}
              placeholder="Search by company, email or phone… (Ctrl+K)"
              className={`pl-10 h-9 border-none focus-visible:ring-1 focus-visible:ring-blue-300 rounded-xl text-sm ${isDark ? 'bg-slate-700 text-slate-100 placeholder:text-slate-400' : 'bg-slate-50'}`}
              value={searchInput} onChange={e => setSearchInput(e.target.value)}
            />
            {searchInput && (
              <button onClick={() => setSearchInput('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className={`h-9 px-3 flex items-center rounded-xl text-xs font-bold border whitespace-nowrap flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
            {sortedClients.length} <span className="ml-1 font-normal text-slate-400">{sortedClients.length !== 1 ? 'clients' : 'client'}</span>
          </div>
          {/* Export buttons */}
          <button onClick={handleExportList} title="Export filtered clients to Excel (.xlsx)"
            className={`h-9 px-3 flex items-center justify-center gap-1.5 rounded-xl border transition-colors flex-shrink-0 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-300 hover:text-white hover:bg-slate-600' : 'bg-slate-50 border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}>
            <FileSpreadsheet className="h-4 w-4" /><span className="hidden xl:inline text-[11px] font-semibold">Excel</span>
          </button>
          <button onClick={handleExportCSV} title="Export filtered clients to CSV (.csv)"
            className={`h-9 px-3 flex items-center justify-center gap-1.5 rounded-xl border transition-colors flex-shrink-0 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-300 hover:text-white hover:bg-slate-600' : 'bg-slate-50 border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}>
            <FileText className="h-4 w-4" /><span className="hidden xl:inline text-[11px] font-semibold">CSV</span>
          </button>
          <div className={`flex items-center border rounded-xl p-0.5 gap-0.5 flex-shrink-0 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
            <button onClick={() => setViewMode('board')} className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${viewMode === 'board' ? (isDark ? 'bg-slate-500 shadow-sm text-white' : 'bg-white shadow-sm text-slate-700') : 'text-slate-400 hover:text-slate-600'}`} title="Board view"><LayoutGrid className="h-4 w-4" /></button>
            <button onClick={() => setViewMode('list')}  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${viewMode === 'list'  ? (isDark ? 'bg-slate-500 shadow-sm text-white' : 'bg-white shadow-sm text-slate-700') : 'text-slate-400 hover:text-slate-600'}`} title="List view"><List className="h-4 w-4" /></button>
          </div>
        </div>
        {/* Row 2: action tabs — equal-width, wrap-safe, no horizontal scroll */}
        <div className={`px-3.5 py-2.5 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(110px, 1fr))` }}>
            {/* WhatsApp */}
            <div className={`flex items-center gap-0.5 border rounded-xl p-0.5 ${isDark ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-slate-50'}`}>
              <button onClick={() => { setBulkMsgMode('whatsapp'); setBulkMsgOpen(true); }} className={`flex-1 flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-emerald-700 transition-all text-xs font-semibold min-w-0 ${isDark ? 'hover:bg-slate-600' : 'hover:bg-emerald-50'}`}>
                <MessageCircle className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">WhatsApp</span>
                <span className="bg-emerald-100 text-emerald-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0">{filteredClients.length}</span>
              </button>
            </div>
            {/* Email */}
            <div className={`flex items-center border rounded-xl p-0.5 ${isDark ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-slate-50'}`}>
              <button onClick={() => { setBulkMsgMode('email'); setBulkMsgOpen(true); }} className={`flex-1 flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-blue-700 transition-all text-xs font-semibold min-w-0 ${isDark ? 'hover:bg-slate-600' : 'hover:bg-blue-50'}`}>
                <Mail className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Email</span>
                <span className="bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0">{filteredClients.length}</span>
              </button>
            </div>
            {/* Bulk Assign */}
            {canAssignClients && (
              <button
                onClick={() => setBulkAssignOpen(true)}
                className={`flex items-center justify-center gap-1.5 h-9 px-2 rounded-xl border text-xs font-semibold transition-all min-w-0 ${isDark ? 'border-slate-600 bg-slate-700 text-slate-200 hover:bg-slate-600 hover:border-slate-500' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700'}`}
              >
                <UserCheck className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Bulk Assign</span>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isDark ? 'bg-slate-600 text-slate-300' : 'bg-blue-100 text-blue-700'}`}>{filteredClients.length}</span>
              </button>
            )}
            {/* ITR Clients */}
            <button
              onClick={() => { setItrTabActive(v => !v); clearBulkSelection(); }}
              className={`flex items-center justify-center gap-1.5 h-9 px-2 rounded-xl border text-xs font-semibold transition-all min-w-0 ${
                itrTabActive
                  ? 'text-white border-transparent shadow-sm'
                  : isDark ? 'border-slate-600 bg-slate-700 text-slate-300 hover:bg-slate-600' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-teal-50 hover:border-teal-300 hover:text-teal-700'
              }`}
              style={itrTabActive ? { background: 'linear-gradient(135deg, #0f3460, #0d7377)' } : {}}
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">ITR Clients</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                itrTabActive ? 'bg-white/20 text-white' : isDark ? 'bg-slate-600 text-slate-300' : 'bg-teal-100 text-teal-700'
              }`}>
                {clients.filter(c => c.is_itr_client).length}
              </span>
            </button>
            {/* Groups */}
            <button
              onClick={() => { setShowGroupsPanel(v => !v); fetchClientGroups(); }}
              className={`flex items-center justify-center gap-1.5 h-9 px-2 rounded-xl border text-xs font-semibold transition-all min-w-0 ${
                showGroupsPanel
                  ? 'text-white border-transparent shadow-sm'
                  : isDark ? 'border-slate-600 bg-slate-700 text-slate-300 hover:bg-slate-600' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700'
              }`}
              style={showGroupsPanel ? { background: 'linear-gradient(135deg, #4338CA, #7C3AED)' } : {}}
            >
              <Layers className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">Groups</span>
              {clientGroupsData.length > 0 && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                  showGroupsPanel ? 'bg-white/20 text-white' : isDark ? 'bg-slate-600 text-slate-300' : 'bg-indigo-100 text-indigo-700'
                }`}>
                  {clientGroupsData.length}
                </span>
              )}
            </button>
            {/* Merge Dupes */}
            {canEditClients && (
              <button
                onClick={handleOpenMerge}
                disabled={detectingDups}
                className={`flex items-center justify-center gap-1.5 h-9 px-2 rounded-xl border text-xs font-semibold transition-all min-w-0 ${
                  isDark ? 'border-slate-600 bg-slate-700 text-slate-300 hover:bg-slate-600' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700'
                }`}
                title="Detect & merge duplicate clients"
              >
                {detectingDups ? <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" /> : <Merge className="h-3.5 w-3.5 flex-shrink-0" />}
                <span className="truncate">Merge Dupes</span>
              </button>
            )}
          </div>
        </div>
        {/* Row 3: sort + filters — wrap-safe, no horizontal scroll */}
        <div className={`px-3.5 py-2.5 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="flex flex-wrap items-center gap-2">
            {/* Sort buttons */}
            <div className={`flex items-center border rounded-xl overflow-hidden flex-shrink-0 ${isDark ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-slate-50'}`}>
              {SORT_OPTIONS.map((opt, i) => {
                const isActive = sortOrder === opt.value;
                return (
                  <button key={opt.value} onClick={() => setSortOrder(opt.value)} title={opt.label}
                    className="h-9 px-2.5 flex items-center gap-1 text-xs font-semibold transition-all whitespace-nowrap"
                    style={{ background: isActive ? 'linear-gradient(135deg, #0D3B66, #1F6FB2)' : 'transparent', color: isActive ? '#ffffff' : isDark ? '#94a3b8' : '#64748b', borderRight: i < SORT_OPTIONS.length - 1 ? `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'}` : 'none' }}>
                    <span style={{ fontSize: 11, fontWeight: 900 }}>{opt.icon}</span>
                    <span style={{ fontSize: 10 }}>{opt.hint}</span>
                  </button>
                );
              })}
            </div>
            {/* Filters */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className={`h-9 w-[110px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Archived</SelectItem><SelectItem value="all">All Status</SelectItem></SelectContent>
            </Select>
            <Select value={clientTypeFilter} onValueChange={setClientTypeFilter}>
              <SelectTrigger className={`h-9 w-[110px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue placeholder="All Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types ({stats.totalClients})</SelectItem>
                {CLIENT_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label} ({stats.typeCounts[t.value] || 0})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={serviceFilter} onValueChange={setServiceFilter}>
              <SelectTrigger className={`h-9 w-[120px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All Services</SelectItem>{SERVICES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
            {canAssignClients && users.length > 0 && (
              <Select value={assignedToFilter} onValueChange={setAssignedToFilter}>
                <SelectTrigger className={`h-9 w-[130px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue placeholder="All Users" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All Users</SelectItem>{users.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name || u.name || u.email}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {savedReferrers.length > 0 && (
              <Select value={referredByFilter} onValueChange={setReferredByFilter}>
                <SelectTrigger className={`h-9 w-[140px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue placeholder="All Referrers" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All Referrers</SelectItem>{savedReferrers.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select>
            )}
              <Select value={auditorFilter} onValueChange={setAuditorFilter}>
                <SelectTrigger className={`h-9 w-[140px] border-none rounded-xl text-xs flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue placeholder="All Auditors" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All Auditors</SelectItem>{savedAuditors.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
        {/* Quick constitution filters — counts are calculated from the same normalized dataset
            used by the filter, so legacy LLP/LLP variants cannot appear as zero. */}
        <div className={`flex items-center gap-1.5 overflow-x-auto px-3.5 py-2 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">Constitution</span>
          <button
            onClick={() => setClientTypeFilter('all')}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap transition ${clientTypeFilter === 'all' ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : (isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600')}`}>
            All {stats.totalClients}
          </button>
          {CLIENT_TYPES.filter(t => (stats.typeCounts[t.value] || 0) > 0).map(t => (
            <button key={t.value} onClick={() => setClientTypeFilter(t.value)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap transition ${clientTypeFilter === t.value ? 'bg-blue-600 text-white' : (isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}`}>
              {t.label} {stats.typeCounts[t.value] || 0}
            </button>
          ))}
        </div>

        {/* Row 4: active filter chips */}
        <ActiveFilterChips
          statusFilter={statusFilter} clientTypeFilter={clientTypeFilter}
          serviceFilter={serviceFilter} assignedToFilter={assignedToFilter} referredByFilter={referredByFilter}
          auditorFilter={auditorFilter}
          users={users} onClear={clearFilter} onClearAll={clearAllFilters}
        />
      </div>

      {/* ── Client Groups Panel — standalone view (replaces board/list when active) ── */}
      {showGroupsPanel && (
        <>
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border"
            style={{ background: 'linear-gradient(135deg, rgba(67,56,202,0.08), rgba(124,58,237,0.08))', borderColor: '#c4b5fd' }}>
            <Layers className="h-4 w-4 flex-shrink-0" style={{ color: '#4338CA' }} />
            <p className="text-xs font-semibold" style={{ color: '#4338CA' }}>
              Groups view — {clientGroupsData.length} group{clientGroupsData.length !== 1 ? 's' : ''} · <span className="font-normal">Click a group to see members · Use Filter to show group members in client list</span>
            </p>
            <button onClick={() => setShowGroupsPanel(false)} className="ml-auto text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline flex-shrink-0">✕ Close</button>
          </div>
          <ClientGroupsPanel
            open={showGroupsPanel}
            onClose={() => setShowGroupsPanel(false)}
            clients={clients}
            onGroupFilter={(groupId) => {
              setActiveGroupId(groupId);
              setShowGroupsPanel(false);
              if (groupId) {
                const grp = clientGroupsData.find(g => g.id === groupId);
                if (grp) toast.info(`Filtering by group: ${grp.name}`);
              }
              fetchClientGroups();
            }}
            onWhatsAppGroup={(groupId) => {
              setActiveGroupId(groupId);
              const grp = clientGroupsData.find(g => g.id === groupId);
              if (grp) toast.info(`WhatsApp: ${grp.name} (${(grp.client_ids || []).length} members)`);
              setBulkMsgMode('whatsapp');
              setShowGroupsPanel(false);
              setTimeout(() => setBulkMsgOpen(true), 50);
            }}
            activeGroupId={activeGroupId}
            isDark={isDark}
          />
        </>
      )}

      {/* BOARD / LIST — hidden when Groups view is active */}
      {!showGroupsPanel && (<>

      {/* ITR mode banner */}
      {itrTabActive && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border"
          style={{ background: 'linear-gradient(135deg, rgba(15,52,96,0.08), rgba(13,115,119,0.08))', borderColor: '#99f6e4' }}>
          <FileText className="h-4 w-4 flex-shrink-0" style={{ color: '#0d7377' }} />
          <p className="text-xs font-semibold" style={{ color: '#0f766e' }}>
            ITR Clients view — showing {sortedClients.length} ITR client{sortedClients.length !== 1 ? 's' : ''} · <span className="font-normal">Linked Company column visible · <span className="opacity-75">🔗 Link icon in action column</span></span>
          </p>
          <button onClick={() => setItrTabActive(false)} className="ml-auto text-xs font-semibold text-teal-600 hover:text-teal-800 hover:underline flex-shrink-0">✕ Clear</button>
        </div>
      )}
      {/* Active group filter banner */}
      {activeGroupId && (() => {
        const grp = clientGroupsData.find(g => g.id === activeGroupId);
        if (!grp) return null;
        return (
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border"
            style={{ background: `${grp.color}12`, borderColor: `${grp.color}40` }}>
            <Layers className="h-4 w-4 flex-shrink-0" style={{ color: grp.color }} />
            <p className="text-xs font-semibold" style={{ color: grp.color }}>
              Group filter: <strong>{grp.name}</strong> — showing {sortedClients.length} client{sortedClients.length !== 1 ? 's' : ''}
            </p>
            <button onClick={() => setActiveGroupId(null)} className="ml-auto text-xs font-semibold hover:underline flex-shrink-0" style={{ color: grp.color }}>✕ Clear</button>
          </div>
        );
      })()}

      {/* Bulk selection action bar */}
      {canDeleteData && bulkSelectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border shadow-sm"
          style={{ background: isDark ? 'rgba(239,68,68,0.12)' : '#fef2f2', borderColor: '#fca5a5' }}>
          <Trash2 className="h-4 w-4 flex-shrink-0 text-red-500" />
          <p className="text-xs font-semibold text-red-700 flex-1">
            <strong>{bulkSelectedIds.size}</strong> client{bulkSelectedIds.size !== 1 ? 's' : ''} selected
          </p>
          <button
            onClick={() => setBulkDeleteConfirm(true)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-bold text-white transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg, #dc2626, #ef4444)' }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {bulkSelectedIds.size} selected
          </button>
          <button
            onClick={clearBulkSelection}
            className="h-8 px-3 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-100 transition-all"
          >
            Clear
          </button>
        </div>
      )}

      {/* Bulk delete confirmation dialog */}
      <Dialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <DialogContent className="max-w-sm rounded-2xl border border-red-200 shadow-2xl">
          <DialogTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
              <Trash2 className="h-5 w-5 text-red-600" />
            </div>
            Delete {bulkSelectedIds.size} client{bulkSelectedIds.size !== 1 ? 's' : ''}?
          </DialogTitle>
          <DialogDescription className="text-sm text-slate-500 mt-1">
            This will permanently delete <strong>{bulkSelectedIds.size}</strong> selected client{bulkSelectedIds.size !== 1 ? 's' : ''} and all their associated data. This action <strong>cannot be undone</strong>.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="flex-1 h-10 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #dc2626, #ef4444)' }}
            >
              {bulkDeleting ? <><Loader2 className="h-4 w-4 animate-spin" /> Deleting…</> : <><Trash2 className="h-4 w-4" /> Yes, delete all</>}
            </button>
            <button
              onClick={() => setBulkDeleteConfirm(false)}
              className={`flex-1 h-10 rounded-xl text-sm font-semibold border transition-all ${isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
            >
              Cancel
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {clientsLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))', gap: 10 }}>
          {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} isDark={isDark} />)}
        </div>
      ) : sortedClients.length === 0 ? (
        <div className="rounded-2xl border flex flex-col items-center justify-center shadow-sm" style={{ minHeight: 320, background: isDark ? '#1e293b' : '#F8FAFC', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
          <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center mb-4 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-100'}`}><Users className="h-7 w-7 opacity-30" /></div>
          <p className="text-base font-semibold text-slate-500">{itrTabActive ? 'No ITR clients found' : 'No clients match your filters'}</p>
          <p className="mt-1 text-sm text-slate-400">{itrTabActive ? 'Create ITR clients using the "+ ITR Client" button' : 'Try changing your search or filters'}</p>
          {(searchInput || statusFilter !== 'all' || clientTypeFilter !== 'all' || serviceFilter !== 'all' || assignedToFilter !== 'all' || referredByFilter !== 'all' || itrTabActive) && (
            <button onClick={() => { clearAllFilters(); setItrTabActive(false); }} className="mt-3 text-sm font-semibold text-blue-600 hover:underline">Clear all filters</button>
          )}
        </div>
      ) : viewMode === 'board' ? (
        <div
          className="rounded-2xl border shadow-sm flex flex-col"
          style={{
            background: isDark ? '#1e293b' : '#F8FAFC',
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
            overflow: 'hidden',
          }}
        >
          <motion.div
            style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1 }}
            variants={{
              hidden:   { opacity: 0 },
              visible:  { opacity: 1, transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
            }}
            initial="hidden"
            animate="visible"
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))',
              gap: 10,
              padding: '10px 10px 4px 10px',
            }}>
              {boardPageClients.map((client, localIndex) => (
                <ModernClientCard
                  onSendBirthdayWish={handleSendBirthdayWish}
                  key={client.id}
                  client={client}
                  index={boardPageStart + localIndex}
                  isDark={isDark}
                  users={users}
                  getClientAssignments={getClientAssignments}
                  openWhatsApp={openWhatsApp}
                  handleEdit={handleEdit}
                  canDeleteData={canDeleteData}
                  canEditClients={canEditClients}
                  onDelete={handleDelete}
                  setSelectedClient={setSelectedClient}
                  setDetailDialogOpen={setDetailDialogOpen}
                  getClientNumber={getClientNumber}
                  isSelected={bulkSelectedIds.has(client.id)}
                  onToggleSelect={toggleBulkSelect}
                />
              ))}
            </div>
          </motion.div>
          <PaginationBar
            safePg={boardSafePage}
            totalPgs={boardTotalPages}
            pageStart={boardPageStart}
            pageSize={BOARD_PAGE_SIZE}
            totalCount={sortedClients.length}
            onPageChange={setBoardPage}
            isDark={isDark}
          />
        </div>
      ) : (
        <div className="rounded-2xl border shadow-sm overflow-hidden flex flex-col" style={{ background: isDark ? '#1e293b' : '#ffffff', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
          <div className="overflow-x-auto">
          <div style={{minWidth:920}}>
          <div
            className={`border-b flex-shrink-0 ${isDark ? 'bg-slate-700/60 border-slate-600' : 'bg-slate-50 border-slate-100'}`}
            style={{ display: 'grid', gridTemplateColumns: itrTabActive ? LIST_GRID_ITR : LIST_GRID_NORMAL, alignItems: 'center', columnGap: 8, paddingLeft: 16, paddingRight: 12, paddingTop: 9, paddingBottom: 9 }}
          >
            {/* 1 · Checkbox */}
            {canDeleteData ? (
              <div className="flex items-center justify-center">
                <div
                  onClick={() => selectAllVisible(listPageClients)}
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-all
                    ${listPageClients.length > 0 && listPageClients.every(c => bulkSelectedIds.has(c.id))
                      ? 'bg-red-500 border-red-500'
                      : isDark ? 'border-slate-500 hover:border-red-400' : 'border-slate-300 hover:border-red-400'}`}
                >
                  {listPageClients.length > 0 && listPageClients.every(c => bulkSelectedIds.has(c.id)) && (
                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  )}
                </div>
              </div>
            ) : <div />}
            {/* 2 · Avatar spacer */}
            <div />
            {/* 3 · Company */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Company</div>
            {/* 4 · Type */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Type</div>
            {/* 5 · Phone / Linked Company */}
            {itrTabActive
              ? <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#0d7377' }}>Linked Company</div>
              : <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Phone</div>}
            {/* 6 · Email */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Email</div>
            {/* 7 · Referred By */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-violet-400">Referred By</div>
            {/* 8 · Auditor */}
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#7c3aed' }}>Auditor</div>
            {/* 9 · Services */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Services</div>
            {/* 10 · Assigned */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Assigned</div>
            {/* 11 · Actions */}
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Actions</div>
          </div>
          <div style={{ height: Math.max(listHeight, LIST_ROW_HEIGHT) }}>
            <FixedSizeList height={Math.max(listHeight, LIST_ROW_HEIGHT)} width="100%" itemCount={listPageClients.length} itemSize={LIST_ROW_HEIGHT} itemData={{ pageClients: listPageClients, pageStart: listPageStart, itrTabActive, bulkSelectedIds, toggleBulkSelect, canDeleteData }}>
              {ListRow}
            </FixedSizeList>
          </div>
          </div>
          </div>
          <PaginationBar safePg={listSafePage} totalPgs={listTotalPages} pageStart={listPageStart} pageSize={LIST_PAGE_SIZE} totalCount={sortedClients.length} onPageChange={setListPage} isDark={isDark} />
        </div>
      )}

      </>)}  {/* end !showGroupsPanel */}

      {/* DETAIL POPUP */}
      <ClientDetailPopup
        selectedClient={selectedClient} detailDialogOpen={detailDialogOpen}
        setDetailDialogOpen={setDetailDialogOpen} isDark={isDark} users={users}
        getClientAssignments={getClientAssignments} openWhatsApp={openWhatsApp}
        handleEdit={handleEdit} canEditClients={canEditClients} navigate={navigate}
      />

      {/* BULK MSG */}
      <BulkMessageModal open={bulkMsgOpen} onClose={() => setBulkMsgOpen(false)} mode={bulkMsgMode} filteredClients={sortedClients} isDark={isDark} />

      {/* BULK ASSIGN */}
      <BulkAssignModal
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        filteredClients={sortedClients}
        users={users}
        isDark={isDark}
        onAssignComplete={fetchClients}
      />

      {/* GST IMPORT DIALOG */}
      {/* HIDDEN FILE INPUTS */}
      <input type="file" ref={fileInputRef} accept=".csv,.xlsx,.xls" onChange={handleImportClientFile} className="hidden" />
      <input type="file" ref={excelInputRef} accept=".xlsx,.xls" onChange={handleImportExcel} className="hidden" />

      {/* CSV PREVIEW DIALOG */}
<Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
  <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-slate-200 shadow-2xl">
    <DialogTitle className={`text-lg font-bold px-6 pt-5 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
      Review Excel Import
    </DialogTitle>
    <DialogDescription className="text-sm text-slate-400 px-6">
      Preview and confirm data before bulk import
    </DialogDescription>

    <div className="flex-1 overflow-auto mx-6 mt-4 rounded-xl border border-slate-100">
      <table className="min-w-full text-xs">
        <thead className={`sticky top-0 border-b ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-100'}`}>
          <tr>
            {previewHeaders.map(h => (
              <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-50">
          {previewData.map((row, ri) => (
            <tr key={ri} className={isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50'}>
              {previewHeaders.map(h => (
                <td key={h} className="p-2">
                  <Input
                    value={row[h] || ''}
                    onChange={e => {
                      const u = [...previewData];
                      u[ri][h] = e.target.value;
                      setPreviewData(u);
                    }}
                    className="h-8 text-xs rounded-lg border-slate-200"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100">
      <span className="text-xs text-slate-400">
        {previewData.length} rows ready
      </span>

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => setPreviewOpen(false)}
          className="h-9 px-4 text-sm rounded-xl border-slate-200"
        >
          Cancel
        </Button>

        <Button
          className="h-9 px-5 text-sm rounded-xl text-white font-semibold"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
          onClick={async () => {
            try {
              setImportLoading(true);

              let success = 0;
              let updated = 0;

              for (const row of previewData) {
                const existing = clients.find(
                  c => c.company_name?.toLowerCase().trim() === row.company_name?.toLowerCase().trim()
                );

                if (existing) {
                  const updatePayload = {};

                  if (!existing.email && row.email?.trim()) updatePayload.email = row.email.trim();
                  if (!existing.phone && row.phone?.trim()) updatePayload.phone = row.phone.replace(/\D/g, '');
                  if (!existing.address && row.address?.trim()) updatePayload.address = row.address.trim();
                  if (!existing.city && row.city?.trim()) updatePayload.city = row.city.trim();
                  if (!existing.state && row.state?.trim()) updatePayload.state = row.state.trim();
                  if (!existing.referred_by && row.referred_by?.trim()) updatePayload.referred_by = row.referred_by.trim();
                  if ((!existing.services || existing.services.length === 0) && row.services) {
                    updatePayload.services = row.services.split(',').map(s => s.trim()).filter(Boolean);
                  }
                  if (!existing.notes && row.notes?.trim()) updatePayload.notes = row.notes.trim();

                  if (Object.keys(updatePayload).length > 0) {
                    try {
                      await api.put(`/clients/${existing.id}`, updatePayload);
                      updated++;
                    } catch (err) {
                      console.error(err);
                    }
                  }
                  continue;
                }

                try {
                  await api.post('/clients', {
                    company_name: row.company_name?.trim(),
                    client_type: ['proprietor','pvt_ltd','llp','partnership','huf','trust','other'].includes(row.client_type)
                      ? row.client_type
                      : 'proprietor',
                    email: row.email?.trim() || null,
                    phone: row.phone?.replace(/\D/g, '') || null,
                    birthday: row.birthday || null,
                    address: row.address?.trim() || null,
                    city: row.city?.trim() || null,
                    state: row.state?.trim() || null,
                    services: row.services
                      ? row.services.split(',').map(s => s.trim()).filter(Boolean)
                      : [],
                    notes: row.notes?.trim() || null,
                    status: row.status || 'active',
                    referred_by: row.referred_by?.trim() || null,
                    assigned_to: null,
                    assignments: [],
                    contact_persons: [1,2,3].reduce((acc, n) => {
                      const name = row[`contact_name_${n}`]?.trim();
                      if (name) {
                        acc.push({
                          name,
                          designation: row[`contact_designation_${n}`]?.trim() || null,
                          email: row[`contact_email_${n}`]?.trim() || null,
                          phone: row[`contact_phone_${n}`]?.replace(/\D/g,'') || null,
                          birthday: row[`contact_birthday_${n}`] || null,
                          din: row[`contact_din_${n}`]?.trim() || null
                        });
                      }
                      return acc;
                    }, []),
                    dsc_details: [],
                  });

                  success++;
                } catch (err) {
                  console.error(err);
                }
              }

              toast.success(`${success} clients imported, ${updated} updated`);
              fetchClients();
              setPreviewOpen(false);
              setImportLoading(false);

            } catch (err) {
              console.error(err);
              toast.error("Import failed");
              setImportLoading(false);
            }
          }}
        >
          Confirm &amp; Import All
        </Button>
      </div>
    </div>
  </DialogContent>
</Dialog>

      {/* WHATSAPP CLIENT DIALOG */}
      {waClient && (
        <WhatsAppSendDialog
          open={waDialogOpen}
          onClose={() => { setWaDialogOpen(false); setWaClient(null); }}
          phone={waClient.phone || ''}
          entityName={waClient.company_name || ''}
          message={buildClientMessage(waClient, 'We would like to connect with you regarding your compliance requirements.', getWASettings())}
          title="Send WhatsApp to Client"
          subtitle={waClient.company_name}
          isDark={isDark}
          canSendScreenshot={false}
        />
      )}

      {/* MDS PREVIEW DIALOG */}
      <Dialog open={mdsPreviewOpen} onOpenChange={(open) => { if (!open) { setMdsPreviewOpen(false); setMdsData(null); setMdsForm(null); } }}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-slate-200 shadow-2xl p-0 bg-white">
          <div className={`sticky top-0 z-10 border-b px-7 py-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}><Building2 className="h-5 w-5" /></div>
              <div>
                <DialogTitle className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>MCA / MDS Data Preview</DialogTitle>
                <DialogDescription className="text-xs text-slate-400 mt-0.5">Review and edit the parsed data before saving{mdsData?.sheets_parsed && <span className="ml-2 text-blue-500 font-medium">· {mdsData.sheets_parsed.length} sheet{mdsData.sheets_parsed.length !== 1 ? 's' : ''} parsed</span>}</DialogDescription>
              </div>
            </div>
          </div>
          {mdsPreviewLoading && <MiniLoader height={80} />}
          {!mdsPreviewLoading && mdsForm && (
            <div className="p-7 space-y-6">
              <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                <div className="flex items-center gap-2 mb-5"><div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}><Briefcase className="h-3.5 w-3.5" /></div><h4 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Company Details</h4></div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2"><label className={labelCls}>Company Name</label><input className={mdsFieldCls} value={mdsForm.company_name} onChange={e => setMdsForm(f => ({ ...f, company_name: e.target.value }))} /></div>
                  <div><label className={labelCls}>Client Type</label><select className={`${mdsFieldCls} appearance-none`} value={mdsForm.client_type} onChange={e => setMdsForm(f => ({ ...f, client_type: e.target.value }))}>{CLIENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                  <div><label className={labelCls}>Date of Incorporation</label><input type="date" className={mdsFieldCls} value={mdsForm.birthday} onChange={e => setMdsForm(f => ({ ...f, birthday: e.target.value }))} /></div>
                  <div><label className={labelCls}>Email</label><input type="email" className={mdsFieldCls} value={mdsForm.email} onChange={e => setMdsForm(f => ({ ...f, email: e.target.value }))} /></div>
                  <div><label className={labelCls}>Phone</label><input className={mdsFieldCls} value={mdsForm.phone} onChange={e => setMdsForm(f => ({ ...f, phone: e.target.value }))} /></div>
                  <div className="md:col-span-2"><label className={labelCls}>Address</label><input className={mdsFieldCls} value={mdsForm.address || ''} onChange={e => setMdsForm(f => ({ ...f, address: e.target.value }))} /></div>
                  <div><label className={labelCls}>City</label><input className={mdsFieldCls} value={mdsForm.city || ''} onChange={e => setMdsForm(f => ({ ...f, city: e.target.value }))} /></div>
                  <div><label className={labelCls}>State</label><input className={mdsFieldCls} value={mdsForm.state || ''} onChange={e => setMdsForm(f => ({ ...f, state: e.target.value }))} /></div>
                </div>
                <div className="mt-4"><label className={labelCls}>Services</label><div className="flex flex-wrap gap-2 mt-1">{SERVICES.map(s => { const sel = mdsForm.services?.includes(s); return <button key={s} type="button" onClick={() => setMdsForm(f => ({ ...f, services: sel ? f.services.filter(x => x !== s) : [...(f.services || []), s] }))} className={`px-3 py-1 text-xs font-semibold rounded-xl border transition-all ${sel ? 'text-white border-transparent' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`} style={sel ? { background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' } : {}}>{s}</button>; })}</div></div>
              </div>
              <div className={`border rounded-2xl p-5 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50/60 border-slate-100'}`}>
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2"><div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}><Users className="h-3.5 w-3.5" /></div><h4 className="text-sm font-semibold text-slate-800">Directors / Contact Persons <span className="text-[10px] font-normal text-slate-400">({mdsForm.contact_persons.filter(c => c.name?.trim()).length} parsed)</span></h4></div>
                  <button type="button" onClick={() => setMdsForm(f => ({ ...f, contact_persons: [...f.contact_persons, { name: '', designation: '', email: '', phone: '', birthday: '', din: '' }] }))} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors"><Plus className="h-3 w-3" /> Add</button>
                </div>
                <button
                 onClick={() => toast.info('Save the client first to send a birthday wish')}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all"
                  style={{
                    background: 'rgba(251,191,36,0.15)',
                    borderColor: 'rgba(251,191,36,0.5)',
                    color: '#92400e',
                  }}
                >
                  🎂 Send Wish
                </button>
                <div className="space-y-3">{mdsForm.contact_persons.map((cp, idx) => (
                  <div key={idx} className={`border rounded-xl p-4 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-white border-slate-200'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2"><div className="w-5 h-5 rounded-md bg-slate-100 text-slate-400 text-[10px] font-bold flex items-center justify-center">{idx + 1}</div><span className="text-xs font-semibold text-slate-600">{cp.name || `Contact ${idx + 1}`}</span></div>
                      <button type="button" onClick={() => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.filter((_, i) => i !== idx) }))} className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><Trash className="h-3 w-3" /></button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      <div><label className={labelCls}>Name</label><input className={mdsFieldCls} value={cp.name} onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, name: e.target.value } : c) }))} /></div>
                      <div><label className={labelCls}>Designation</label><input className={mdsFieldCls} value={cp.designation} onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, designation: e.target.value } : c) }))} /></div>
                      <div><label className={labelCls}>DIN / PAN</label><input className={mdsFieldCls} value={cp.din || ''} onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, din: e.target.value } : c) }))} /></div>
                      <div><label className={labelCls}>Email</label><input type="email" className={mdsFieldCls} value={cp.email || ''} placeholder="Optional" onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, email: e.target.value } : c) }))} /></div>
                      <div><label className={labelCls}>Phone</label><input className={mdsFieldCls} value={cp.phone || ''} placeholder="Optional" onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, phone: e.target.value } : c) }))} /></div>
                      <div><label className={labelCls}>Birthday</label><input type="date" className={mdsFieldCls} value={cp.birthday || ''} onChange={e => setMdsForm(f => ({ ...f, contact_persons: f.contact_persons.map((c, i) => i === idx ? { ...c, birthday: e.target.value } : c) }))} /></div>
                    </div>
                  </div>
                ))}</div>
              </div>
              <div><label className={labelCls}>Notes</label><textarea className={`w-full min-h-[90px] border focus:border-blue-400 focus:ring-1 focus:ring-blue-100 rounded-xl text-sm p-3 resize-y outline-none transition-colors ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} value={mdsForm.notes} onChange={e => setMdsForm(f => ({ ...f, notes: e.target.value }))} /></div>
              {mdsData?.raw_company_info && Object.keys(mdsData.raw_company_info).length > 0 && (
                <div className="border border-slate-100 rounded-2xl overflow-hidden">
                  <button type="button" onClick={() => setMdsRawInfoOpen(o => !o)} className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors text-left ${isDark ? 'bg-slate-700 hover:bg-slate-600' : 'bg-slate-50 hover:bg-slate-100'}`}>
                    <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" /><span className="text-xs font-semibold text-slate-600">Raw Excel Data</span><span className="text-[10px] text-slate-400">({Object.keys(mdsData.raw_company_info).length} fields)</span></div>
                    {mdsRawInfoOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                  </button>
                  {mdsRawInfoOpen && (
                    <div className={`p-4 grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                      {Object.entries(mdsData.raw_company_info).map(([key, val]) => (
                        <div key={key} className={`flex items-start gap-2 text-xs py-1.5 px-2 rounded-lg ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-50'}`}>
                          <span className="text-slate-400 font-medium min-w-[120px] flex-shrink-0">{key}</span>
                          <span className="text-slate-700 font-medium break-all">{String(val)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <Button type="button" variant="ghost" onClick={() => { setMdsPreviewOpen(false); setMdsData(null); setMdsForm(null); }} className="h-10 px-4 text-sm rounded-xl text-slate-500">Cancel</Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => handleMdsConfirm(false)} className="h-10 px-5 text-sm rounded-xl border-slate-200 text-slate-700 font-semibold hover:bg-slate-50 gap-2"><Edit className="h-4 w-4" /> Open in Full Form</Button>
                  <Button type="button" disabled={importLoading} onClick={() => handleMdsConfirm(true)} className="h-10 px-6 text-sm rounded-xl text-white font-semibold gap-2" style={{ background: importLoading ? '#94a3b8' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}><CheckCircle2 className="h-4 w-4" />{importLoading ? 'Saving…' : 'Save Client'}</Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── AI Duplicate Detection Dialog ─────────────────────────────── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={clients}
        entityLabel="Client"
        accentColor="#1F6FB2"
        isDark={isDark}
        canDelete={isAdmin || canDeleteData}
        canEdit={canEditClients}
        getTitle={(c) => c.company_name || 'Unnamed Client'}
        getSubtitle={(c) => [c.email, c.phone].filter(Boolean).join(' · ') || null}
        getMeta={(c) => [
          c.client_type ? c.client_type.toUpperCase() : null,
          c.gstin ? `GSTIN: ${c.gstin}` : null,
          c.pan  ? `PAN: ${c.pan}` : null,
          c.city ? c.city : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Company',  a: a.company_name,  b: b.company_name },
          { label: 'Type',     a: a.client_type,   b: b.client_type },
          { label: 'GSTIN',    a: a.gstin,         b: b.gstin },
          { label: 'PAN',      a: a.pan,           b: b.pan },
          { label: 'Email',    a: a.email,         b: b.email },
          { label: 'Phone',    a: a.phone,         b: b.phone },
          { label: 'City',     a: a.city,          b: b.city },
          { label: 'State',    a: a.state,         b: b.state },
          { label: 'Services', a: (a.services || []).join(', '), b: (b.services || []).join(', ') },
        ]}
        onEdit={(c) => { handleEdit(c); setShowDupDialog(false); }}
        onDelete={async (c) => {
          if (!window.confirm(`Delete "${c.company_name}"?`)) return;
          try {
            await api.delete(`/clients/${c.id}`);
            setClients((prev) => prev.filter((x) => x.id !== c.id));
            toast.success('Client deleted');
          } catch { toast.error('Failed to delete client'); }
        }}
        onView={(c) => { setSelectedClient(c); setClientDetailOpen(true); setShowDupDialog(false); }}
        canMerge={canEditClients}
        onMerge={(group) => {
          setShowDupDialog(false);
          const idx = dupGroups.findIndex((g) => g === group || (g.item_ids || []).join(',') === (group.item_ids || []).join(','));
          setMergeDupGroups(dupGroups);
          setMergeStartIdx(idx >= 0 ? idx : 0);
          setShowMergeDialog(true);
        }}
      />

      {/* ── Merge Clients Dialog ───────────────────────────────────────── */}
      <MergeClientsDialog
        open={showMergeDialog}
        onClose={() => setShowMergeDialog(false)}
        clients={clients}
        groups={mergeDupGroups}
        startIndex={mergeStartIdx}
        onMerge={handleMergeClients}
        isDark={isDark}
      />





      {/* ── ITR Client Dialog ──────────────────────────────────────────── */}
      <ITRClientDialog
        open={itrDialogOpen}
        onClose={() => { setItrDialogOpen(false); setEditingItrClient(null); }}
        onSaved={() => { fetchClients(); setItrDialogOpen(false); setEditingItrClient(null); }}
        editingClient={editingItrClient}
        isDark={isDark}
        onBulkImport={() => { setItrDialogOpen(false); setEditingItrClient(null); setItrBulkImportOpen(true); }}
      />

      {/* ── ITR Bulk Import Dialog ─────────────────────────────────────── */}
      <Suspense fallback={null}>
        <ITRBulkImportDialog
          open={itrBulkImportOpen}
          onClose={() => setItrBulkImportOpen(false)}
          onImported={() => { fetchClients(); }}
          isDark={isDark}
        />
      </Suspense>
    </div>
  );
}