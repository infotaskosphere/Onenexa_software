import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import { NotebookPen, Plus, RefreshCw, Trash2, X, CheckSquare, Square, XCircle, Building2, ChevronLeft, ChevronRight, Pencil, AlertTriangle, ShieldCheck, FileDown, FileSpreadsheet, FileText } from 'lucide-react';
import { getXLSX, getJsPDF, getAutoTable } from '@/lib/lazyLibs';
import ExistingRecordsPanel from '@/components/ExistingRecordsPanel.jsx';
import GifLoader, { MiniLoader, ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import api from '@/lib/api';
import { createJournalEntry } from '@/lib/journalEntriesApi';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';
import { runVerifyAndFix } from '@/lib/verifyAndFixLedger';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', emeraldGreen: '#1FAF5A', amber: '#F59E0B', coral: '#FF6B6B' };
const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtDate = (value) => { if (!value) return '—'; try { return format(parseISO(value), 'dd MMM yyyy'); } catch { return value; } };
const SOURCE_LABEL = { manual: 'Manual', purchase: 'Purchase', sale: 'Sale', bank: 'Bank', payment: 'Receipt', purchase_payment: 'Payment' };

function emptyLine(defaultType = 'Dr') { return { account_id: '', account_name: '', type: defaultType, debit: '', credit: '', memo: '' }; }

function JournalEntriesInner() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const explicitPermissions = user?.permissions && typeof user.permissions === 'object'
    ? user.permissions
    : {};
  const isCommercialUser = Boolean(
    user?.company_id || user?.license_id || user?.commercial_customer_id
  );
  const canViewChartOfAccounts = isCommercialUser
    ? (
      explicitPermissions.can_view_chart_of_accounts === true ||
      explicitPermissions.can_manage_chart_of_accounts === true
    )
    : (
      hasPermission('can_view_chart_of_accounts') ||
      hasPermission('can_manage_chart_of_accounts')
    );
  const canPostJournalEntries = isCommercialUser
    ? explicitPermissions.can_post_journal_entries === true
    : hasPermission('can_post_journal_entries');
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState([emptyLine('Dr'), emptyLine('Cr')]);
  const [saving, setSaving] = useState(false);

  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [showExistingRecords, setShowExistingRecords] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);

  // Edit state — only manual entries can be edited; auto-posted entries
  // must be corrected at the source document (invoice/bill/payment).
  const [editingEntry, setEditingEntry] = useState(null);
  const [editDate, setEditDate] = useState('');
  const [editNarration, setEditNarration] = useState('');
  const [editLines, setEditLines] = useState([]);
  const [editSaving, setEditSaving] = useState(false);

  // Which entries are the ones breaking a books-of-accounts check right
  // now — powers the "Needs Attention" tab and the amber highlight below.
  // Sourced from the same engine as Accounting Reports → Fix Errors
  // (backend/accounting_ai/reconciliation_validator.py), so a duplicate or
  // stray manual posting shows up here with the exact same reasoning.
  const [validationReport, setValidationReport] = useState(null);
  const [viewTab, setViewTab] = useState('all');

  const fetchCompanies = async () => {
    try {
      const res = await api.get('/companies/list');
      setCompanies(normalizeCompanies(res));
    } catch { /* non-fatal */ }
  };

  const fetchAll = async (opts = {}) => {
    const cid = opts.companyId !== undefined ? opts.companyId : companyId;
    const pg = opts.page !== undefined ? opts.page : page;
    const size = opts.pageSize !== undefined ? opts.pageSize : pageSize;
    setLoading(true);
    try {
      // Journal Entries and Chart of Accounts are separate permissions.
      // Never load Chart of Accounts just because Journal Entries is visible.
      const [entriesR] = await Promise.allSettled([
        api.get('/journal-entries', { params: { company_id: cid, page: pg, page_size: size } }),
      ]);
      if (entriesR.status === 'fulfilled') {
        const d = entriesR.value.data || {};
        setEntries(d.entries || []);
        setTotal(d.total || 0);
        setTotalPages(d.total_pages || 1);
      } else {
        setEntries([]); setTotal(0); setTotalPages(1);
      }
      // Accounts are loaded lazily only when the Journal Entry
      // composer is opened and the user has explicit Chart of Accounts access.
      setAccounts([]);
    } catch {
      toast.error('Failed to load journal entries');
    } finally {
      setLoading(false);
    }
  };
  // Best-effort: which entries are currently causing a mismatch. This
  // never blocks or errors the page — if it fails, entries just render
  // without highlighting instead of the page breaking.
  const fetchFlagged = async (cid = companyId, force = false) => {
    try {
      const summary = await runVerifyAndFix(cid, { force });
      setValidationReport(summary);
    } catch { /* non-fatal — highlighting is a bonus */ }
  };

  useEffect(() => {
    fetchCompanies();
    // Sequenced, not parallel: the entries/accounts fetch is what the user
    // is waiting on to see the page. fetchFlagged('') re-syncs and
    // validates every company's book on the backend, which is heavy — firing
    // it at the same moment as the main fetch made both compete for the
    // same backend/DB capacity and slowed the whole page down. Running it
    // after the main fetch resolves keeps the page responsive; the
    // "Needs Attention" badge just fills in a beat later. It's also now
    // cached for a minute (see verifyAndFixLedger.js), so re-visiting this
    // page shortly after doesn't re-trigger the full engine again.
    (async () => {
      await fetchAll({ companyId: '', page: 1, pageSize });
      fetchFlagged('');
    })();
  }, [canViewChartOfAccounts]);

  const onCompanyChange = (cid) => {
    const val = cid === '__all__' ? '' : cid;
    setCompanyId(val);
    setPage(1);
    fetchAll({ companyId: val, page: 1 });
    fetchFlagged(val);
  };

  const onPageSizeChange = (size) => {
    const n = Number(size);
    setPageSize(n);
    setPage(1);
    fetchAll({ pageSize: n, page: 1 });
  };

  const goToPage = (p) => {
    const clamped = Math.max(1, Math.min(totalPages, p));
    setPage(clamped);
    fetchAll({ page: clamped });
  };

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 && debit > 0 };
  }, [lines]);

  // Flatten { books: [...] } (all-companies) or a single report into
  // entry_id -> { rules, note }. Only mismatch culprits with an entry_id
  // are journal entries (invoice culprits use `id`/`invoice_number` and
  // belong to Sales, not here) — see reconciliation_validator.py.
  const flaggedMap = useMemo(() => {
    const books = validationReport
      ? (Array.isArray(validationReport.books) ? validationReport.books : [validationReport])
      : [];
    const map = {};
    for (const book of books) {
      for (const m of (book?.mismatches || [])) {
        for (const c of (m.culprits || [])) {
          if (!c.entry_id) continue;
          if (!map[c.entry_id]) map[c.entry_id] = { rules: [], note: m.note || '' };
          if (!map[c.entry_id].rules.includes(m.rule)) map[c.entry_id].rules.push(m.rule);
        }
      }
    }
    return map;
  }, [validationReport]);
  const flaggedCount = Object.keys(flaggedMap).length;
  const visibleEntries = viewTab === 'flagged' ? entries.filter(e => flaggedMap[e.id]) : entries;

  const updateLine = (idx, patch) => {
    setLines(ls => ls.map((l, i) => i === idx ? { ...l, ...patch } : l));
  };

  const handleTypeChange = (idx, newType) => {
    setLines(ls => ls.map((l, i) => {
      if (i !== idx) return l;
      const val = l.debit || l.credit || '';
      if (newType === 'Dr') {
        return { ...l, type: 'Dr', debit: val, credit: '' };
      } else {
        return { ...l, type: 'Cr', debit: '', credit: val };
      }
    }));
  };

  const handleEditTypeChange = (idx, newType) => {
    setEditLines(ls => ls.map((l, i) => {
      if (i !== idx) return l;
      const val = l.debit || l.credit || '';
      if (newType === 'Dr') {
        return { ...l, type: 'Dr', debit: val, credit: '' };
      } else {
        return { ...l, type: 'Cr', debit: '', credit: val };
      }
    }));
  };

  const handleRefresh = async () => {
    toast.promise(
      (async () => {
        const { data } = await api.post('/journal-entries/resync', { company_id: companyId || undefined });
        await fetchAll();
        fetchFlagged(companyId, true);
        return data;
      })(),
      {
        loading: 'Running automatic system re-sync to restore missing entries...',
        success: (data) => {
          if (data?.recreated_bank_matches > 0) {
            return `System re-sync complete. Automatically restored ${data.recreated_bank_matches} bank matching entries!`;
          }
          return 'System re-sync complete. All automated ledger entries are perfectly synchronized!';
        },
        error: 'System re-sync encountered an issue, but ledger entries were refreshed.'
      }
    );
  };

  const submit = async () => {
    const validLines = lines
      .filter(l => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
      .map(l => ({ account_id: l.account_id, account_name: l.account_name, debit: Number(l.debit || 0), credit: Number(l.credit || 0), memo: l.memo }));
    if (validLines.length < 2) { toast.error('Add at least two lines'); return; }
    if (!totals.balanced) { toast.error('Debit total must equal credit total'); return; }
    setSaving(true);
    try {
      await createJournalEntry({
        company_id: companyId,
        entry_date: entryDate,
        narration,
        lines: validLines,
      });
      toast.success('Journal entry posted');
      setShowNew(false);
      setNarration('');
      setLines([emptyLine('Dr'), emptyLine('Cr')]);
      await fetchAll();
      fetchFlagged();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to post journal entry');
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id) => {
    if (!window.confirm('Delete this journal entry? This cannot be undone.')) return;
    try {
      await api.delete(`/journal-entries/${id}`);
      toast.success('Journal entry deleted');
      await fetchAll();
      fetchFlagged();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const openEdit = (entry) => {
    if (entry.source && entry.source !== 'manual') {
      toast.error('Auto-posted entries must be corrected at the source document (invoice, bill, or payment).');
      return;
    }
    setEditingEntry(entry);
    setEditDate(entry.entry_date || new Date().toISOString().slice(0, 10));
    setEditNarration(entry.narration || '');
    setEditLines((entry.lines || []).map(l => ({
      account_id: l.account_id || '',
      account_name: l.account_name || '',
      type: l.debit ? 'Dr' : 'Cr',
      debit: l.debit ? String(l.debit) : '',
      credit: l.credit ? String(l.credit) : '',
      memo: l.memo || '',
    })));
  };

  const closeEdit = () => {
    setEditingEntry(null);
    setEditLines([]);
    setEditNarration('');
  };

  const updateEditLine = (idx, patch) => {
    setEditLines(ls => ls.map((l, i) => i === idx ? { ...l, ...patch } : l));
  };

  const editTotals = useMemo(() => {
    const debit = editLines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const credit = editLines.reduce((s, l) => s + Number(l.credit || 0), 0);
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 && debit > 0 };
  }, [editLines]);

  const saveEdit = async () => {
    if (!editingEntry) return;
    const validLines = editLines
      .filter(l => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
      .map(l => ({ account_id: l.account_id, account_name: l.account_name, debit: Number(l.debit || 0), credit: Number(l.credit || 0), memo: l.memo }));
    if (validLines.length < 2) { toast.error('Add at least two lines'); return; }
    if (!editTotals.balanced) { toast.error('Debit total must equal credit total'); return; }
    setEditSaving(true);
    try {
      await api.put(`/journal-entries/${editingEntry.id}`, {
        company_id: editingEntry.company_id || '',
        entry_date: editDate,
        narration: editNarration,
        lines: validLines,
      });
      toast.success('Journal entry updated');
      closeEdit();
      await fetchAll();
      fetchFlagged();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update journal entry');
    } finally {
      setEditSaving(false);
    }
  };


  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(prev => (prev.size === entries.length ? new Set() : new Set(entries.map(e => e.id))));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { toast.error('Select at least one entry first'); return; }
    if (!window.confirm(`Delete ${ids.length} journal ${ids.length === 1 ? 'entry' : 'entries'}? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const { data } = await api.post('/journal-entries/bulk-delete', { entry_ids: ids });
      if (data.deleted_count > 0) toast.success(`Deleted ${data.deleted_count} ${data.deleted_count === 1 ? 'entry' : 'entries'}`);
      if (data.failed?.length) {
        toast.error(`${data.failed.length} entr${data.failed.length === 1 ? 'y' : 'ies'} couldn't be deleted — ${data.failed[0].reason}`);
      }
      exitSelectMode();
      await fetchAll();
      fetchFlagged();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Bulk delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleDeleteAll = async () => {
    const activeCompany = companies.find(c => c.id === companyId);
    const scopeName = activeCompany ? `for "${activeCompany.name}"` : "for all companies";
    
    if (!window.confirm(`CRITICAL WARNING: Are you sure you want to delete ALL journal entries ${scopeName}? This action is irreversible.`)) {
      return;
    }
    
    const confirmText = prompt(`Type "delete all" to confirm deleting all journal entries ${scopeName}:`);
    if (confirmText?.toLowerCase() !== 'delete all') {
      toast.error('Deletion cancelled — confirmation text did not match');
      return;
    }
    
    setLoading(true);
    try {
      const { data } = await api.post('/journal-entries/delete-all', { company_id: companyId || undefined });
      const deleted = data.deleted_count || 0;
      const failed = data.failed_count || 0;
      
      if (deleted > 0) {
        toast.success(`Successfully deleted ${deleted} journal entries`);
      } else if (failed === 0) {
        toast.info('No journal entries found to delete');
      }
      
      if (failed > 0) {
        toast.error(`Could not delete ${failed} entry/entries (e.g., auto-posted or locked)`);
      }
      
      setPage(1);
      await fetchAll({ page: 1 });
      fetchFlagged();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete all journal entries');
    } finally {
      setLoading(false);
    }
  };

  // ── Full report export (Excel / PDF) ────────────────────────────────────
  // Pulls every journal entry matching the current company filter (not just
  // the current page) by walking the paginated /journal-entries endpoint at
  // its max page_size, then flattens each entry's Dr/Cr lines into rows.
  const fetchAllEntriesForExport = async () => {
    const size = 500;
    let pg = 1;
    let totalPagesLocal = 1;
    const all = [];
    do {
      const { data } = await api.get('/journal-entries', { params: { company_id: companyId, page: pg, page_size: size } });
      all.push(...(data?.entries || []));
      totalPagesLocal = data?.total_pages || 1;
      pg += 1;
    } while (pg <= totalPagesLocal);
    return all;
  };

  const buildReportRows = (allEntries) => {
    const rows = [];
    for (const e of allEntries) {
      const party = e.customer_name || e.vendor_name || '';
      const base = {
        date: fmtDate(e.entry_date),
        voucher: e.voucher_no || '',
        invoice: e.invoice_no || '',
        narration: e.narration || 'No narration',
        source: SOURCE_LABEL[e.source] || e.source || '',
        party,
      };
      const lines = e.lines && e.lines.length ? e.lines : [{ account_name: '', debit: e.total_debit, credit: '' }];
      lines.forEach((l) => {
        rows.push({
          ...base,
          account: l.account_name || '',
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
        });
      });
    }
    return rows;
  };

  const handleExportReport = async (format = 'excel') => {
    setExportingReport(true);
    try {
      const allEntries = await fetchAllEntriesForExport();
      if (!allEntries.length) {
        toast.error('No journal entries to export for the current filter');
        return;
      }
      const rows = buildReportRows(allEntries);
      const activeCompany = companies.find((c) => c.id === companyId);
      const scopeLabel = activeCompany ? activeCompany.name : 'All Companies';
      const dateStr = format === 'pdf' ? null : new Date().toISOString().slice(0, 10);
      const fileBase = `Journal_Entries_Report_${(activeCompany?.name || 'AllCompanies').replace(/[^a-z0-9]+/gi, '_')}`;

      if (format === 'excel') {
        const XLSX = await getXLSX();
        const header = ['Date', 'Voucher No', 'Invoice/Bill No', 'Narration', 'Source', 'Party', 'Ledger Account', 'Debit (₹)', 'Credit (₹)'];
        const aoa = [header, ...rows.map(r => [r.date, r.voucher, r.invoice, r.narration, r.source, r.party, r.account, r.debit || '', r.credit || ''])];
        const totalDebit = rows.reduce((s, r) => s + (r.debit || 0), 0);
        const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
        aoa.push([]);
        aoa.push(['', '', '', '', '', '', 'TOTAL', totalDebit, totalCredit]);
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 10 }, { wch: 22 }, { wch: 26 }, { wch: 14 }, { wch: 14 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Journal Entries');
        XLSX.writeFile(wb, `${fileBase}_${dateStr}.xlsx`);
        toast.success('Journal entries exported to Excel');
      } else {
        const jsPDF = await getJsPDF();
        const autoTable = await getAutoTable();
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const W = doc.internal.pageSize.getWidth();
        const H = doc.internal.pageSize.getHeight();
        const genDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

        doc.setFillColor(13, 59, 102);
        doc.rect(0, 0, W, 22, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('JOURNAL ENTRIES REPORT', 12, 10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text(`${scopeLabel}  ·  Generated ${genDate}  ·  ${allEntries.length} entries`, 12, 17);

        autoTable(doc, {
          startY: 26,
          head: [['Date', 'Voucher', 'Narration', 'Source', 'Party', 'Ledger Account', 'Debit (₹)', 'Credit (₹)']],
          body: rows.map(r => [r.date, r.voucher || r.invoice || '—', r.narration, r.source, r.party || '—', r.account, r.debit ? r.debit.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '', r.credit ? r.credit.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '']),
          styles: { fontSize: 7.5, cellPadding: 1.6, overflow: 'linebreak' },
          headStyles: { fillColor: [31, 111, 178], textColor: [255, 255, 255], fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          columnStyles: {
            0: { cellWidth: 22 }, 1: { cellWidth: 28 }, 2: { cellWidth: 70 }, 3: { cellWidth: 20 },
            4: { cellWidth: 40 }, 5: { cellWidth: 48 }, 6: { cellWidth: 25, halign: 'right' }, 7: { cellWidth: 25, halign: 'right' },
          },
          margin: { left: 12, right: 12 },
          didDrawPage: () => {
            const pageCount = doc.internal.getNumberOfPages();
            const curPage = doc.internal.getCurrentPageInfo().pageNumber;
            doc.setFontSize(7);
            doc.setTextColor(100, 116, 139);
            doc.text('Confidential — Journal Entries Report', 12, H - 4);
            doc.text(`Page ${curPage} of ${pageCount}`, W - 12, H - 4, { align: 'right' });
          },
        });

        const totalDebit = rows.reduce((s, r) => s + (r.debit || 0), 0);
        const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
        const finalY = doc.lastAutoTable.finalY || 30;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(13, 59, 102);
        doc.text(`Total Debit: ₹${totalDebit.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`, W - 90, finalY + 8);
        doc.text(`Total Credit: ₹${totalCredit.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`, W - 90, finalY + 14);

        doc.save(`${fileBase}.pdf`);
        toast.success('Journal entries exported to PDF');
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to export journal entries report');
    } finally {
      setExportingReport(false);
    }
  };

  if (loading) return <ContentLoader />;

  // NOTE: DashboardLayout already applies page padding + max-width + background,
  // so this page must NOT add its own min-h-screen / max-w / p-* wrapper —
  // doing so shifts the header out of alignment with the Dashboard.
  return (
    <div className="space-y-5 w-full min-w-0">
      <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
        <div className="p-5 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
          <div className="flex items-start gap-4 min-w-0">
            <div className="h-14 w-14 shrink-0 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg">
              <NotebookPen className="h-7 w-7" />
            </div>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">Accounts</p>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1 truncate">Journal Entries</h1>
              <p className="text-sm text-blue-100 mt-1 max-w-2xl">Every Purchase, Sale, and matched Bank transaction posts here automatically. Post manual entries for anything else.</p>
            </div>
          </div>
          {/* Action grid — 4 columns × 2 rows so every control shares the exact
              same width/height; each is tinted a different shade so the row
              stays scannable at a glance (mirrors the Invoicing page style). */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full lg:w-[600px] xl:w-[660px] shrink-0">
            <Select value={companyId || '__all__'} onValueChange={onCompanyChange}>
              <SelectTrigger className="h-11 w-full bg-white/10 border-white/20 text-white rounded-xl text-xs sm:text-sm font-semibold hover:bg-white/20 transition-all backdrop-blur-sm gap-1.5 justify-center">
                <Building2 className="h-4 w-4 shrink-0" />
                <SelectValue placeholder="All Companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Companies</SelectItem>
                {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
              <SelectTrigger className="h-11 w-full bg-sky-400/20 border-sky-300/30 text-white rounded-xl text-xs sm:text-sm font-semibold hover:bg-sky-400/30 transition-all backdrop-blur-sm justify-center">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 / page</SelectItem>
                <SelectItem value="50">50 / page</SelectItem>
                <SelectItem value="100">100 / page</SelectItem>
              </SelectContent>
            </Select>

            <Button onClick={() => setShowExistingRecords(true)} variant="outline" className="h-11 w-full bg-indigo-400/20 border-indigo-300/30 text-white hover:bg-indigo-400/30 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5">
              <ShieldCheck className="h-4 w-4" /> Existing records
            </Button>

            <Button
              onClick={async () => {
                if (!canPostJournalEntries) {
                  toast.error('Journal Entry posting access has not been granted by your admin.');
                  return;
                }
                if (!canViewChartOfAccounts) {
                  toast.error('Chart of Accounts access is required to create a manual journal entry.');
                  return;
                }
                setAccountsLoading(true);
                setShowNew(true);
                try {
                  const { data } = await api.get('/chart-of-accounts', {
                    params: companyId ? { company_id: companyId } : {},
                  });
                  setAccounts(Array.isArray(data) ? data : []);
                } catch (err) {
                  setAccounts([]);
                  setShowNew(false);
                  toast.error(err?.response?.data?.detail || 'Chart of Accounts access is required.');
                } finally {
                  setAccountsLoading(false);
                }
              }}
              disabled={!canPostJournalEntries || !canViewChartOfAccounts}
              title={
                !canPostJournalEntries
                  ? 'Journal Entry posting access is required.'
                  : !canViewChartOfAccounts
                    ? 'Chart of Accounts access is required to create a manual journal entry.'
                    : 'Create a manual journal entry'
              }
              variant="outline"
              className="h-11 w-full bg-emerald-400/25 border-emerald-300/40 text-white hover:bg-emerald-400/35 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" /> New entry
            </Button>

            <Button onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))} variant="outline" className="h-11 w-full bg-amber-400/20 border-amber-300/30 text-white hover:bg-amber-400/30 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5">
              {selectMode ? <><XCircle className="h-4 w-4" /> Cancel select</> : <><CheckSquare className="h-4 w-4" /> Select</>}
            </Button>

            <Button onClick={handleRefresh} variant="outline" className="h-11 w-full bg-cyan-400/20 border-cyan-300/30 text-white hover:bg-cyan-400/30 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5">
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>

            <Button
              onClick={handleDeleteAll}
              variant="outline"
              className="h-11 w-full bg-rose-500/20 border-rose-300/30 text-white hover:bg-rose-500/35 hover:border-rose-400/40 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5"
            >
              <Trash2 className="h-4 w-4" /> Delete All
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  disabled={exportingReport}
                  className="h-11 w-full bg-violet-400/20 border-violet-300/30 text-white hover:bg-violet-400/35 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-sm transition-all gap-1.5 disabled:opacity-60"
                >
                  <FileDown className="h-4 w-4" /> {exportingReport ? 'Exporting…' : 'Export Report'}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleExportReport('excel')} className="gap-2 cursor-pointer">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export as Excel
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExportReport('pdf')} className="gap-2 cursor-pointer">
                  <FileText className="h-4 w-4 text-rose-600" /> Export as PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <GuidanceNote pageKey="journal-entries" isDark={isDark} />

      <Tabs value={viewTab} onValueChange={setViewTab} className="w-full">
        <TabsList className="grid grid-cols-2 w-full max-w-md h-auto min-h-11 bg-slate-100 dark:bg-slate-800 rounded-xl p-1 gap-1 border border-slate-200/50 dark:border-slate-700/50">
          <TabsTrigger value="all" className="h-auto min-h-9 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-slate-900 dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:text-white">
            All Entries
          </TabsTrigger>
          <TabsTrigger value="flagged" className="h-auto min-h-9 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-slate-900 dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:text-white">
            Needs Attention
            {flaggedCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold leading-none">
                {flaggedCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {viewTab === 'flagged' && (
        <p className={`text-xs -mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Entries on this page that are breaking a books-of-accounts check (see Accounting Reports → Fix Errors). Switch pages or the company filter above if you're looking for one that isn't here.
        </p>
      )}

      {selectMode && (
        <div className={`sticky top-2 z-10 rounded-2xl border shadow-sm px-4 py-3 flex items-center justify-between gap-3 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <button onClick={toggleSelectAll} className={`flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            {selectedIds.size === entries.length && entries.length > 0
              ? <CheckSquare className="h-4 w-4" style={{ color: COLORS.mediumBlue }} />
              : <Square className="h-4 w-4 text-slate-400" />}
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exitSelectMode} className="rounded-lg">Cancel</Button>
            <Button
              size="sm"
              onClick={bulkDelete}
              disabled={bulkDeleting || selectedIds.size === 0}
              className="rounded-lg text-white"
              style={{ background: COLORS.coral }}
            >
              {bulkDeleting ? <MiniLoader height={16} /> : <><Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete selected</>}
            </Button>
          </div>
        </div>
      )}

      <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
        <div className="divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
          {visibleEntries.length === 0 ? (
            <div className="py-20 text-center">
              <NotebookPen className="h-12 w-12 mx-auto text-slate-300 mb-3" />
              <p className="text-sm font-semibold text-slate-400">
                {viewTab === 'flagged' ? 'No flagged entries on this page — nice!' : 'No journal entries yet'}
              </p>
            </div>
          ) : visibleEntries.map(e => {
            const flag = flaggedMap[e.id];
            const isManual = e.source === 'manual' || !e.source;
            return (
            <div
              key={e.id}
              className={`p-4 flex gap-3 ${selectMode && selectedIds.has(e.id) ? (isDark ? 'bg-blue-950/30' : 'bg-blue-50/60') : ''} ${flag ? (isDark ? 'bg-amber-950/20 border-l-4 border-amber-500' : 'bg-amber-50/70 border-l-4 border-amber-400') : ''}`}
            >
              {selectMode && (
                <button onClick={() => toggleSelected(e.id)} className="mt-0.5 flex-shrink-0">
                  {selectedIds.has(e.id)
                    ? <CheckSquare className="h-5 w-5" style={{ color: COLORS.mediumBlue }} />
                    : <Square className="h-5 w-5 text-slate-300" />}
                </button>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'} break-words`}>{e.narration || 'No narration'}</p>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">{SOURCE_LABEL[e.source] || e.source}</span>
                      {(e.customer_name || e.vendor_name) && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                          {e.customer_name || e.vendor_name}
                        </span>
                      )}
                      {flag && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                          <AlertTriangle className="h-3 w-3" /> Causing a mismatch
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3">
                      <span>{fmtDate(e.entry_date)}</span>
                      {e.voucher_no && <span>Voucher: {e.voucher_no}</span>}
                      {e.invoice_no && <span>Inv/Bill: {e.invoice_no}</span>}
                      {e.reference_no && <span>Ref: {e.reference_no}</span>}
                      {e.payment_mode && <span>{e.payment_mode}{e.bank_account ? ` · ${e.bank_account}` : ''}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <p className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{fmtC(e.total_debit)}</p>
                    {!selectMode && (
                      <button
                        onClick={() => openEdit(e)}
                        title={isManual ? 'Edit entry' : 'Auto-posted — must be corrected at the source document'}
                        className={isManual ? 'text-slate-300 hover:text-blue-500' : 'text-slate-300 hover:text-slate-400'}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {!selectMode && (
                      <button onClick={() => deleteEntry(e.id)} title="Delete entry" className="text-slate-300 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                </div>
                <div className="mt-2 pl-1 space-y-1">
                  {(e.lines || []).map(l => (
                    <div key={l.id} className="flex items-center justify-between text-xs text-slate-500 gap-3">
                      <span className="min-w-0 truncate">{l.account_name}</span>
                      <span className="font-mono shrink-0">{l.debit ? `Dr ${fmtC(l.debit)}` : `Cr ${fmtC(l.credit)}`}</span>
                    </div>
                  ))}
                </div>
                {flag && (
                  <div className={`mt-2.5 p-2.5 rounded-lg border flex items-start gap-2 ${isDark ? 'bg-amber-950/30 border-amber-800/40' : 'bg-amber-50 border-amber-200'}`}>
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className={`text-[11px] font-bold ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                        Breaking: {flag.rules.join('; ')}
                      </p>
                      <p className={`text-[11px] mt-0.5 ${isDark ? 'text-amber-200/80' : 'text-amber-700'}`}>
                        This is why that check fails in Accounting Reports → Fix Errors.{' '}
                        {isManual
                          ? 'Delete this entry if it\u2019s a mistake or duplicate, or edit the amount so it matches the correct figure.'
                          : 'It\u2019s auto-posted, so correct the underlying invoice/bill/payment instead of editing here — or delete this entry only if it\u2019s a duplicate.'}
                      </p>
                      <div className="flex gap-2 mt-1.5">
                        {isManual && (
                          <button onClick={() => openEdit(e)} className="text-[11px] font-bold px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                            Edit amount
                          </button>
                        )}
                        <button onClick={() => deleteEntry(e.id)} className="text-[11px] font-bold px-2.5 py-1 rounded-md bg-rose-600 text-white hover:bg-rose-700 transition-colors">
                          Delete entry
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {total > 0 && (
        <div className={`flex flex-wrap items-center justify-between gap-3 px-1 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
          <span>
            Showing {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, total)} of {total} {total === 1 ? 'entry' : 'entries'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)} className="rounded-lg">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-semibold px-2">Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => goToPage(page + 1)} className="rounded-lg">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
              <NotebookPen className="h-5 w-5 text-blue-500" />
              <span>New Journal Entry (Tally-Style Voucher)</span>
            </DialogTitle>
          </DialogHeader>
          <button
            type="button"
            onClick={() => setShowExistingRecords(true)}
            className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 rounded-xl px-3 py-2 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-all -mt-1"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            Booking a payment or receipt? Check existing sale/purchase records first, so you don't post it twice.
          </button>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-500/5 p-3 rounded-xl border border-slate-200/40 dark:border-slate-800/40">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Voucher Date</label>
                <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} className="h-9 text-xs" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Narration / Remarks</label>
                <Input placeholder="Enter general voucher narration..." value={narration} onChange={e => setNarration(e.target.value)} className="h-9 text-xs" />
              </div>
            </div>

            <div className={`border rounded-xl overflow-hidden ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50/50'} shadow-inner`}>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`text-xs uppercase tracking-wider ${isDark ? 'bg-slate-800 text-slate-400 border-b border-slate-700' : 'bg-slate-100 text-slate-500 border-b border-slate-200'}`}>
                    <th className="p-2.5 w-[75px] text-center font-bold">Dr/Cr</th>
                    <th className="p-2.5">Particulars (Ledger Account Head)</th>
                    <th className="p-2.5 w-[140px] text-right">Debit (₹)</th>
                    <th className="p-2.5 w-[140px] text-right">Credit (₹)</th>
                    <th className="p-2.5 w-[45px] text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dashed" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                  {lines.map((l, idx) => (
                    <tr key={idx} className="hover:bg-slate-500/5 transition-colors">
                      <td className="p-2">
                        <Select value={l.type || 'Dr'} onValueChange={(v) => handleTypeChange(idx, v)}>
                          <SelectTrigger className="h-9 text-xs font-bold w-[65px] bg-white/5 border-slate-200 dark:border-slate-700 rounded-lg text-center justify-center">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Dr"><span className="text-emerald-600 font-extrabold text-xs">Dr</span></SelectItem>
                            <SelectItem value="Cr"><span className="text-amber-600 font-extrabold text-xs">Cr</span></SelectItem>
                          </SelectContent>
                        </Select>
                      </td>

                      <td className="p-2">
                        <div className="space-y-1">
                          <Select value={l.account_id} onValueChange={(v) => {
                            const acct = accounts.find(a => a.id === v);
                            updateLine(idx, { account_id: v, account_name: acct ? `${acct.code} ${acct.name}` : '' });
                          }}>
                            <SelectTrigger className="h-9 text-xs bg-white/5 border-slate-200 dark:border-slate-700 rounded-lg">
                              <SelectValue placeholder="Select Ledger Head..." />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.map(a => (
                                <SelectItem key={a.id} value={a.id}>
                                  <span className="font-semibold text-xs text-blue-500 mr-2">{a.code}</span>
                                  <span className="text-xs">{a.name}</span>
                                  <span className="text-[10px] ml-2 opacity-60 italic">({a.type})</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {l.account_id && (
                            <Input 
                              placeholder="Line reference/memo..." 
                              className="h-7 text-[11px] px-2 py-0.5 border-slate-200 dark:border-slate-700 rounded-md italic bg-transparent"
                              value={l.memo || ''} 
                              onChange={e => updateLine(idx, { memo: e.target.value })} 
                            />
                          )}
                        </div>
                      </td>

                      <td className="p-2">
                        <Input 
                          type="number" 
                          placeholder="0.00" 
                          className="h-9 text-right font-mono text-xs border-slate-200 dark:border-slate-700 rounded-lg bg-white/5"
                          disabled={l.type === 'Cr'}
                          value={l.type === 'Cr' ? '' : l.debit} 
                          onChange={e => updateLine(idx, { debit: e.target.value, credit: '' })} 
                        />
                      </td>

                      <td className="p-2">
                        <Input 
                          type="number" 
                          placeholder="0.00" 
                          className="h-9 text-right font-mono text-xs border-slate-200 dark:border-slate-700 rounded-lg bg-white/5"
                          disabled={l.type === 'Dr'}
                          value={l.type === 'Dr' ? '' : l.credit} 
                          onChange={e => updateLine(idx, { credit: e.target.value, debit: '' })} 
                        />
                      </td>

                      <td className="p-2 text-center">
                        <button 
                          onClick={() => setLines(ls => ls.filter((_, i) => i !== idx))} 
                          className="text-slate-400 hover:text-rose-500 p-1.5 rounded-md hover:bg-rose-500/10 transition"
                          title="Remove ledger line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center">
              <Button variant="outline" size="sm" onClick={() => setLines(ls => [...ls, emptyLine('Dr')])} className="h-8 text-xs rounded-lg">
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Voucher Line
              </Button>
            </div>

            <div className={`flex flex-col md:flex-row md:items-center justify-between p-3.5 rounded-xl border text-sm gap-3 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex flex-wrap gap-x-5 gap-y-1 font-semibold text-xs uppercase tracking-wider text-slate-500">
                <span>Total Debit: <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{fmtC(totals.debit)}</span></span>
                <span>Total Credit: <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{fmtC(totals.credit)}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${totals.balanced ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                  {totals.balanced ? 'Balanced' : 'Not Balanced'}
                </span>
              </div>
            </div>

            <Button onClick={submit} disabled={saving || !totals.balanced} className="w-full h-10 font-bold rounded-xl shadow-lg transition-all" style={{ background: COLORS.mediumBlue }}>
              {saving ? <MiniLoader height={18} /> : 'Post Voucher Entry'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingEntry} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
              <NotebookPen className="h-5 w-5 text-blue-500" />
              <span>Edit Journal Entry (Tally-Style Voucher)</span>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-500/5 p-3 rounded-xl border border-slate-200/40 dark:border-slate-800/40">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Voucher Date</label>
                <Input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className="h-9 text-xs" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Narration / Remarks</label>
                <Input placeholder="Enter general voucher narration..." value={editNarration} onChange={e => setEditNarration(e.target.value)} className="h-9 text-xs" />
              </div>
            </div>

            <div className={`border rounded-xl overflow-hidden ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50/50'} shadow-inner`}>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`text-xs uppercase tracking-wider ${isDark ? 'bg-slate-800 text-slate-400 border-b border-slate-700' : 'bg-slate-100 text-slate-500 border-b border-slate-200'}`}>
                    <th className="p-2.5 w-[75px] text-center font-bold">Dr/Cr</th>
                    <th className="p-2.5">Particulars (Ledger Account Head)</th>
                    <th className="p-2.5 w-[140px] text-right">Debit (₹)</th>
                    <th className="p-2.5 w-[140px] text-right">Credit (₹)</th>
                    <th className="p-2.5 w-[45px] text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dashed" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                  {editLines.map((l, idx) => (
                    <tr key={idx} className="hover:bg-slate-500/5 transition-colors">
                      <td className="p-2">
                        <Select value={l.type || 'Dr'} onValueChange={(v) => handleEditTypeChange(idx, v)}>
                          <SelectTrigger className="h-9 text-xs font-bold w-[65px] bg-white/5 border-slate-200 dark:border-slate-700 rounded-lg text-center justify-center">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Dr"><span className="text-emerald-600 font-extrabold text-xs">Dr</span></SelectItem>
                            <SelectItem value="Cr"><span className="text-amber-600 font-extrabold text-xs">Cr</span></SelectItem>
                          </SelectContent>
                        </Select>
                      </td>

                      <td className="p-2">
                        <div className="space-y-1">
                          <Select value={l.account_id} onValueChange={(v) => {
                            const acct = accounts.find(a => a.id === v);
                            updateEditLine(idx, { account_id: v, account_name: acct ? `${acct.code} ${acct.name}` : l.account_name });
                          }}>
                            <SelectTrigger className="h-9 text-xs bg-white/5 border-slate-200 dark:border-slate-700 rounded-lg">
                              <SelectValue placeholder={l.account_name || "Select Ledger Head..."} />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.map(a => (
                                <SelectItem key={a.id} value={a.id}>
                                  <span className="font-semibold text-xs text-blue-500 mr-2">{a.code}</span>
                                  <span className="text-xs">{a.name}</span>
                                  <span className="text-[10px] ml-2 opacity-60 italic">({a.type})</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {l.account_id && (
                            <Input 
                              placeholder="Line reference/memo..." 
                              className="h-7 text-[11px] px-2 py-0.5 border-slate-200 dark:border-slate-700 rounded-md italic bg-transparent"
                              value={l.memo || ''} 
                              onChange={e => updateEditLine(idx, { memo: e.target.value })} 
                            />
                          )}
                        </div>
                      </td>

                      <td className="p-2">
                        <Input 
                          type="number" 
                          placeholder="0.00" 
                          className="h-9 text-right font-mono text-xs border-slate-200 dark:border-slate-700 rounded-lg bg-white/5"
                          disabled={l.type === 'Cr'}
                          value={l.type === 'Cr' ? '' : l.debit} 
                          onChange={e => updateEditLine(idx, { debit: e.target.value, credit: '' })} 
                        />
                      </td>

                      <td className="p-2">
                        <Input 
                          type="number" 
                          placeholder="0.00" 
                          className="h-9 text-right font-mono text-xs border-slate-200 dark:border-slate-700 rounded-lg bg-white/5"
                          disabled={l.type === 'Dr'}
                          value={l.type === 'Dr' ? '' : l.credit} 
                          onChange={e => updateEditLine(idx, { credit: e.target.value, debit: '' })} 
                        />
                      </td>

                      <td className="p-2 text-center">
                        <button 
                          onClick={() => setEditLines(ls => ls.filter((_, i) => i !== idx))} 
                          className="text-slate-400 hover:text-rose-500 p-1.5 rounded-md hover:bg-rose-500/10 transition"
                          title="Remove ledger line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center">
              <Button variant="outline" size="sm" onClick={() => setEditLines(ls => [...ls, emptyLine('Dr')])} className="h-8 text-xs rounded-lg">
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Voucher Line
              </Button>
            </div>

            <div className={`flex flex-col md:flex-row md:items-center justify-between p-3.5 rounded-xl border text-sm gap-3 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex flex-wrap gap-x-5 gap-y-1 font-semibold text-xs uppercase tracking-wider text-slate-500">
                <span>Total Debit: <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{fmtC(editTotals.debit)}</span></span>
                <span>Total Credit: <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{fmtC(editTotals.credit)}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${editTotals.balanced ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                  {editTotals.balanced ? 'Balanced' : 'Not Balanced'}
                </span>
              </div>
            </div>

            <Button onClick={saveEdit} disabled={editSaving || !editTotals.balanced} className="w-full h-10 font-bold rounded-xl shadow-lg transition-all" style={{ background: COLORS.mediumBlue }}>
              {editSaving ? <MiniLoader height={18} /> : 'Save Voucher Changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ExistingRecordsPanel
        open={showExistingRecords}
        onOpenChange={setShowExistingRecords}
        companyId={companyId}
        isDark={isDark}
        title="Existing sale & purchase records"
        description="Everything already booked in Invoicing and Purchases. Check here before posting a manual entry for a payment or receipt — if it's already recorded, matching it on the Bank page keeps the books duplicate-free instead."
      />
    </div>
  );
}

function JournalEntries() {
  return (
    <RequestAccessGate module="journal_entries" moduleLabel="Journal Entries" permissionFlag="can_view_journal_entries">
      <JournalEntriesInner />
    </RequestAccessGate>
  );
}

export default JournalEntries;
