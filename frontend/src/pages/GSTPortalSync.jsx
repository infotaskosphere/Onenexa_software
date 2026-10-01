import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Landmark, RefreshCw, AlertTriangle, CheckCircle2, ShieldCheck,
  Search, Copy, Check, ExternalLink, Settings, Building2,
  FileSpreadsheet, Upload, Download, Sparkles, Database, Layers,
  MapPin, Hash, UserCheck, ArrowRight, Play
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import {
  lookupGSTIN,
  bulkVerifyGSTINs,
  decodeGSTIN,
  SAMPLE_GSTINS,
} from '@/lib/gstApi';

const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber: '#F59E0B',
  coral: '#FF6B6B',
};

const fmtC = (n) => (n === null || n === undefined) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function MetricCard({ label, value, icon: Icon, color, isDark, sub }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm transition-all ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: `${color}20` }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
      </div>
      <p className={`text-2xl font-bold font-mono ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{sub}</p>}
    </div>
  );
}

function GSTPortalSyncInner() {
  const isDark = useDark();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState('lookup');

  // Live metrics and snapshots
  const [metrics, setMetrics] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [riskRows, setRiskRows] = useState([]);

  // Search state
  const [searchGstin, setSearchGstin] = useState('');
  const [taxpayerResult, setTaxpayerResult] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  // Bulk state
  const [bulkInput, setBulkInput] = useState('');
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  // Config modal
  const [configOpen, setConfigOpen] = useState(false);
  const [configData, setConfigData] = useState({
    provider: 'builtin_free',
    api_key: '',
    endpoint_url: '',
  });
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [m, s, r, c] = await Promise.allSettled([
        api.get('/gst-portal/dashboard-metrics'),
        api.get('/gst-portal/snapshot'),
        api.get('/gst-portal/audit-risk'),
        api.get('/gst/config'),
      ]);
      setMetrics(m.status === 'fulfilled' ? m.value.data : null);
      setSnapshots(s.status === 'fulfilled' ? s.value.data : []);
      setRiskRows(r.status === 'fulfilled' ? r.value.data : []);
      if (c.status === 'fulfilled' && c.value.data?.config) {
        setConfigData(c.value.data.config);
      }
    } catch {
      toast.error('Failed to load GST portal data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // Pre-populate with first sample for fast preview
    handleLookup('29AABCU9603R1ZJ');
  }, []);

  const handleLookup = async (gstinToSearch) => {
    const target = (gstinToSearch || searchGstin).trim().toUpperCase();
    if (!target) {
      toast.error('Please enter a GSTIN');
      return;
    }
    setSearching(true);
    setSearchGstin(target);
    try {
      const res = await lookupGSTIN(target);
      setTaxpayerResult(res);
      if (res.valid) {
        toast.success(`Verified: ${res.legal_name || 'Taxpayer'}`);
      } else {
        toast.warning('GSTIN checksum validation failed');
      }
    } catch (err) {
      toast.error(err.message || 'Lookup failed');
    } finally {
      setSearching(false);
    }
  };

  const handleSyncNow = async (targetGstin) => {
    const g = (targetGstin || searchGstin || taxpayerResult?.gstin || '29AABCU9603R1ZJ').trim().toUpperCase();
    setSyncing(true);
    try {
      await api.post('/gst-portal/register', { company_id: '', gstin: g, active: true });
      const res = await api.post(`/gst-portal/sync-now?company_id=&gstin=${encodeURIComponent(g)}`);
      toast.success(res.data?.message || 'Synced live liability & credit ledger via Free GST API.');
      await fetchAll();
      setActiveTab('ledgers');
    } catch (err) {
      const detail = err.response?.data?.detail || 'Sync failed';
      toast.error(detail);
    } finally {
      setSyncing(false);
    }
  };

  const handleBulkVerify = async () => {
    const lines = bulkInput
      .split(/[\n,;]+/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 14);

    if (lines.length === 0) {
      toast.error('Please enter at least one GSTIN');
      return;
    }

    setBulkLoading(true);
    try {
      const res = await bulkVerifyGSTINs(lines);
      setBulkResults(res);
      toast.success(`Verified ${res.total} GSTINs (${res.valid_count} Valid)`);
    } catch {
      toast.error('Bulk verification failed');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleCopy = (text, key) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleExportBulkCSV = () => {
    if (!bulkResults?.results?.length) return;
    const headers = ['GSTIN', 'Valid', 'Status', 'Legal Name', 'Trade Name', 'State', 'PAN', 'Entity Type', 'Source'];
    const rows = bulkResults.results.map((r) => [
      r.gstin,
      r.valid ? 'YES' : 'NO',
      r.status,
      `"${(r.legal_name || '').replace(/"/g, '""')}"`,
      `"${(r.trade_name || '').replace(/"/g, '""')}"`,
      r.state_name || r.state_code || '',
      r.pan || '',
      `"${(r.entity_type || '').replace(/"/g, '""')}"`,
      r.source || 'Free GST API',
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `gstin_verification_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      await api.post('/gst/config', configData);
      toast.success('GST API settings updated successfully');
      setConfigOpen(false);
      fetchAll();
    } catch {
      toast.error('Failed to save configuration');
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) return <ContentLoader />;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="p-4 md:p-6 space-y-6 max-w-[1240px] mx-auto">

        {/* ── Banner Header ── */}
        <div
          className="rounded-2xl overflow-hidden shadow-xl"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
        >
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-xl bg-white/15 border-0 flex items-center justify-center shadow-md shrink-0">
                <Landmark className="h-7 w-7 text-white" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">
                    Finix &amp; CompliGenie · Free GST API
                  </p>
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-400/30">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Free API Mode Active
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-white/10 text-white border-0">
                    <ShieldCheck className="h-3 w-3 text-emerald-300" />
                    Luhn Mod-36 Verified
                  </span>
                </div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">
                  Live Revenue Liabilities &amp; Free GST API Hub
                </h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">
                  Instant GSTIN validation, taxpayer profile lookup, Luhn mod-36 mathematical verification, bulk audits, and live PMT-01/PMT-02 ledger reconciliation without expensive third-party fees.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start lg:self-center shrink-0">
              <Button
                onClick={() => setConfigOpen(true)}
                variant="outline"
                className="bg-white/10 border-0 text-white hover:bg-white/20 whitespace-nowrap"
              >
                <Settings className="h-4 w-4 mr-2" />
                API Settings
              </Button>
              <Button
                onClick={fetchAll}
                variant="outline"
                className="bg-white/15 border-0 text-white hover:bg-white/25 whitespace-nowrap"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {/* ── Main Navigation Tabs ── */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
          <TabsList className={`p-1 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <TabsTrigger value="lookup" className="gap-2 text-xs md:text-sm font-semibold">
              <Search className="h-4 w-4" />
              Live GSTIN Search &amp; Verify
            </TabsTrigger>
            <TabsTrigger value="bulk" className="gap-2 text-xs md:text-sm font-semibold">
              <Layers className="h-4 w-4" />
              Bulk GSTIN Audit
            </TabsTrigger>
            <TabsTrigger value="ledgers" className="gap-2 text-xs md:text-sm font-semibold">
              <Database className="h-4 w-4" />
              PMT-01 / PMT-02 &amp; Audit Risk
            </TabsTrigger>
          </TabsList>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 1: LIVE GSTIN SEARCH & VERIFICATION
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="lookup" className="space-y-5">
            {/* Search Input Box */}
            <div className={`rounded-xl border p-5 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <label className="block text-xs font-bold uppercase tracking-wider mb-2 text-slate-500">
                Enter 15-Character GSTIN to Search &amp; Verify
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Input
                    placeholder="e.g. 29AABCU9603R1ZJ"
                    value={searchGstin}
                    onChange={(e) => setSearchGstin(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                    maxLength={15}
                    className="font-mono uppercase text-base h-11 pr-10"
                  />
                  {searchGstin && (
                    <button
                      type="button"
                      onClick={() => setSearchGstin('')}
                      className="absolute right-3 top-3 text-xs text-slate-400 hover:text-slate-600"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <Button
                  onClick={() => handleLookup()}
                  disabled={searching}
                  className="h-11 px-6 bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {searching ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4 mr-2" />
                  )}
                  {searching ? 'Querying Free API…' : 'Search & Verify via Free API'}
                </Button>
              </div>

              {/* Sample GSTIN Pills for 1-Click Verification */}
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700/80 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Quick Test Sample GSTINs:</span>
                {SAMPLE_GSTINS.map((s) => (
                  <button
                    key={s.gstin}
                    type="button"
                    onClick={() => handleLookup(s.gstin)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                      searchGstin === s.gstin
                        ? 'bg-blue-600 text-white border-blue-600'
                        : isDark
                        ? 'bg-slate-700 text-slate-200 border-slate-600 hover:bg-slate-600'
                        : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                    }`}
                  >
                    {s.name.split(' ')[0]} ({s.state})
                  </button>
                ))}
              </div>
            </div>

            {/* Taxpayer Verification Card */}
            {taxpayerResult && (
              <div className={`rounded-xl border shadow-md overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                {/* Header */}
                <div className={`p-5 border-b flex flex-col md:flex-row md:items-center justify-between gap-4 ${isDark ? 'border-slate-700 bg-slate-800/80' : 'border-slate-100 bg-slate-50/80'}`}>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono font-bold text-lg text-blue-600 dark:text-blue-400">
                        {taxpayerResult.gstin}
                      </span>
                      {taxpayerResult.valid ? (
                        <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Valid &amp; Active
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Checksum Mismatch
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {taxpayerResult.taxpayer_type || 'Regular'}
                      </Badge>
                      <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/40 text-blue-600 border-blue-200">
                        {taxpayerResult.state_name} ({taxpayerResult.state_code})
                      </Badge>
                    </div>
                    <h2 className="text-xl font-bold">{taxpayerResult.legal_name}</h2>
                    {taxpayerResult.trade_name && taxpayerResult.trade_name !== taxpayerResult.legal_name && (
                      <p className="text-xs text-slate-500 font-medium">Trade Name: {taxpayerResult.trade_name}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopy(JSON.stringify(taxpayerResult, null, 2), 'json')}
                      className="text-xs gap-1"
                    >
                      {copiedKey === 'json' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      Copy JSON
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleSyncNow(taxpayerResult.gstin)}
                      disabled={syncing}
                      className="text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                      Sync Portals &amp; Books
                    </Button>
                  </div>
                </div>

                {/* Details Grid */}
                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Permanent Account Number (PAN)</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="font-mono font-bold text-base">{taxpayerResult.pan}</span>
                      <button
                        type="button"
                        onClick={() => handleCopy(taxpayerResult.pan, 'pan')}
                        className="p-1 text-slate-400 hover:text-slate-600"
                      >
                        {copiedKey === 'pan' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <span className="text-[10px] text-slate-400">Extracted from characters 3–12</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Entity Constitution</p>
                    <p className="font-semibold text-sm mt-1">{taxpayerResult.entity_type}</p>
                    <span className="text-[10px] text-slate-400">Decoded from PAN 4th character</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Luhn Mod-36 Check Digit</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono font-bold text-base">
                        Char: {taxpayerResult.actual_check_digit || taxpayerResult.gstin?.slice(-1)}
                      </span>
                      {taxpayerResult.checksum_valid ? (
                        <span className="text-xs font-semibold text-emerald-600 flex items-center gap-0.5">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Passing
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-rose-500 flex items-center gap-0.5">
                          <AlertTriangle className="h-3.5 w-3.5" /> Expected {taxpayerResult.expected_check_digit}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400">Official Indian GSTN Mod-36 formula</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Filing Periodicity</p>
                    <p className="font-semibold text-sm mt-1">{taxpayerResult.filing_frequency || 'Monthly'}</p>
                    <span className="text-[10px] text-slate-400">GSTR-1 (11th) / GSTR-3B (20th)</span>
                  </div>
                </div>

                {/* Address & Source Footer */}
                <div className={`px-5 py-3 border-t text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${isDark ? 'border-slate-700 bg-slate-900/40 text-slate-400' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>
                  <div className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                    <span>Principal Place: {taxpayerResult.principal_place_of_business?.address || `${taxpayerResult.state_name}, India`}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span>Source: <strong className="text-slate-800 dark:text-slate-200">{taxpayerResult.source || 'Free GST API'}</strong></span>
                    <span>•</span>
                    <span>Verified: {new Date(taxpayerResult.verified_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 2: BULK GSTIN AUDIT & VERIFICATION
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="bulk" className="space-y-5">
            <div className={`rounded-xl border p-5 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="font-bold text-base">Bulk GSTIN Verification &amp; Taxpayer Audit</h3>
                  <p className="text-xs text-slate-500">Paste up to 100 GSTIN numbers (one per line, comma or semicolon separated) to batch-verify.</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkInput(SAMPLE_GSTINS.map((s) => s.gstin).join('\n'))}
                  className="text-xs"
                >
                  Load Sample List
                </Button>
              </div>

              <textarea
                rows={5}
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value.toUpperCase())}
                placeholder="29AABCU9603R1ZJ&#10;27AAACT2882H1Z7&#10;27AAACR0442P1Z8&#10;29AAACW1682B1ZG"
                className={`w-full rounded-lg border p-3 font-mono text-sm leading-relaxed ${
                  isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              />

              <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs text-slate-400">
                  {bulkInput.split(/[\n,;]+/).filter((l) => l.trim().length >= 14).length} GSTINs detected
                </span>
                <Button
                  onClick={handleBulkVerify}
                  disabled={bulkLoading}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {bulkLoading ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {bulkLoading ? 'Verifying Batch…' : 'Run Bulk Verification'}
                </Button>
              </div>
            </div>

            {bulkResults && (
              <div className="space-y-4">
                {/* Summary Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard label="Total Processed" value={bulkResults.total} icon={Layers} color={COLORS.mediumBlue} isDark={isDark} />
                  <MetricCard label="Passing Checksum" value={bulkResults.valid_count} icon={CheckCircle2} color={COLORS.emeraldGreen} isDark={isDark} />
                  <MetricCard label="Errors / Flagged" value={bulkResults.invalid_count} icon={AlertTriangle} color={COLORS.coral} isDark={isDark} />
                  <div className={`rounded-xl border p-4 shadow-sm flex flex-col justify-center items-start ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Export Verified Data</p>
                    <Button
                      size="sm"
                      onClick={handleExportBulkCSV}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download CSV Report
                    </Button>
                  </div>
                </div>

                {/* Results Table */}
                <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>GSTIN</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Legal Entity Name</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>PAN</TableHead>
                        <TableHead>Entity Type</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bulkResults.results.map((r, i) => (
                        <TableRow key={r.gstin || i}>
                          <TableCell className="font-mono font-bold text-xs">{r.gstin}</TableCell>
                          <TableCell>
                            {r.valid ? (
                              <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[11px]">Valid</Badge>
                            ) : (
                              <Badge variant="destructive" className="text-[11px]">Invalid</Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-medium text-xs max-w-[200px] truncate">{r.legal_name}</TableCell>
                          <TableCell className="text-xs">{r.state_name || r.state_code}</TableCell>
                          <TableCell className="font-mono text-xs">{r.pan}</TableCell>
                          <TableCell className="text-xs text-slate-500">{r.entity_type}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setSearchGstin(r.gstin);
                                handleLookup(r.gstin);
                                setActiveTab('lookup');
                              }}
                              className="text-xs text-blue-600 dark:text-blue-400"
                            >
                              Inspect &rarr;
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 3: PMT-01 / PMT-02 & AUDIT RISK
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="ledgers" className="space-y-5">
            {/* Metric Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Total Liability (PMT-01)" value={fmtC(metrics?.total_liability)} icon={Landmark} color={COLORS.coral} isDark={isDark} />
              <MetricCard label="Available ITC (PMT-02)" value={fmtC(metrics?.net_available_credits)} icon={CheckCircle2} color={COLORS.emeraldGreen} isDark={isDark} />
              <MetricCard label="Bank Cash Reserves" value={fmtC(metrics?.cash_reserves)} icon={Wifi} color={COLORS.mediumBlue} isDark={isDark} />
              <MetricCard
                label="Audit Discrepancy"
                value={metrics?.discrepancy_pct === null || metrics?.discrepancy_pct === undefined ? '0.0%' : `${metrics.discrepancy_pct}%`}
                icon={AlertTriangle}
                color={metrics?.is_audit_risk ? COLORS.coral : COLORS.emeraldGreen}
                isDark={isDark}
                sub={metrics?.is_audit_risk ? 'Variance exceeds 5% tolerance' : 'Ledger balanced with books'}
              />
            </div>

            {/* Snapshots Table */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  Electronic Ledger Snapshots (PMT-01 &amp; PMT-02)
                </h3>
                <span className="text-xs text-slate-500">Synced via Free GST API &amp; Internal Accounting</span>
              </div>
              {snapshots.length === 0 ? (
                <div className="p-8 text-center">
                  <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No portal snapshots stored yet.</p>
                  <Button
                    size="sm"
                    onClick={() => handleSyncNow()}
                    className="mt-3 bg-blue-600 hover:bg-blue-700 text-white text-xs"
                  >
                    Sync First Snapshot Now
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>GSTIN</TableHead>
                      <TableHead>Return Period</TableHead>
                      <TableHead className="text-right">Cash Liability</TableHead>
                      <TableHead className="text-right">Total Liability</TableHead>
                      <TableHead className="text-right">Available Credit (ITC)</TableHead>
                      <TableHead>Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshots.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs font-bold">{s.gstin}</TableCell>
                        <TableCell className="text-xs">{s.period}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(s.outward_cash_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmtC(s.outward_total_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-emerald-600">{fmtC(s.available_itc)}</TableCell>
                        <TableCell className="text-xs text-slate-500">{new Date(s.fetched_at).toLocaleString('en-IN')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Audit Risk Table */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  Audit Risk Engine — Portal Liability vs Books Comparison
                </h3>
                <span className="text-xs text-slate-500">Automated 5% Variance Tolerance Gate</span>
              </div>
              {riskRows.length === 0 ? (
                <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  No audit risk comparisons calculated yet. Click &quot;Sync Now&quot; above to run your first check.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Portal Liability</TableHead>
                      <TableHead className="text-right">Internal Ledger (Books)</TableHead>
                      <TableHead className="text-right">Variance (₹)</TableHead>
                      <TableHead className="text-right">Variance (%)</TableHead>
                      <TableHead>Audit Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {riskRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs font-medium">{r.period}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.portal_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.internal_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.variance)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{r.variance_pct}%</TableCell>
                        <TableCell>
                          {r.is_risk ? (
                            <Badge variant="destructive" className="text-xs">Audit Risk</Badge>
                          ) : (
                            <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">Clean / Reconciled</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* ── API Settings Dialog ── */}
        <Dialog open={configOpen} onOpenChange={setConfigOpen}>
          <DialogContent className={`max-w-md ${isDark ? 'bg-slate-900 text-slate-100 border-slate-700' : 'bg-white text-slate-900'}`}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-blue-500" />
                Free GST API Configuration
              </DialogTitle>
              <DialogDescription className="text-xs">
                Configure your preferred GST verification provider and free tier keys.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3 text-sm">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-500">
                  GST API Provider
                </label>
                <select
                  value={configData.provider}
                  onChange={(e) => setConfigData({ ...configData, provider: e.target.value })}
                  className={`w-full rounded-lg border p-2.5 text-xs font-medium ${
                    isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
                  }`}
                >
                  <option value="builtin_free">Free Built-in Engine &amp; Public Registry (0-Cost, Unlimited)</option>
                  <option value="sheetgst">SheetGST / GSTINCheck Free Tier</option>
                  <option value="rapidapi">RapidAPI GSTIN Tool (Free Plan)</option>
                  <option value="custom_gsp">Licensed Enterprise GSP / Custom Gateway</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-500">
                  Optional Free API Key
                </label>
                <Input
                  type="password"
                  placeholder="Leave empty for free built-in public search"
                  value={configData.api_key || ''}
                  onChange={(e) => setConfigData({ ...configData, api_key: e.target.value })}
                  className="text-xs"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Built-in Free Engine works instantly without requiring any API keys.
                </p>
              </div>

              <div className="rounded-lg p-3 text-xs space-y-1 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900">
                <p className="font-bold text-blue-900 dark:text-blue-300">Free Tier Features Included:</p>
                <p className="text-blue-800 dark:text-blue-400">• Official Indian GSTN Luhn Mod-36 Check Digit Algorithm</p>
                <p className="text-blue-800 dark:text-blue-400">• Real-time State &amp; PAN entity decoding (38 Indian states &amp; UTs)</p>
                <p className="text-blue-800 dark:text-blue-400">• Local database caching for instant 0ms repeated checks</p>
                <p className="text-blue-800 dark:text-blue-400">• Multi-format bulk verification export</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button variant="ghost" onClick={() => setConfigOpen(false)} className="text-xs">
                Cancel
              </Button>
              <Button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs"
              >
                {savingConfig ? 'Saving…' : 'Save Settings'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function GSTPortalSync() {
  return (
    <RequestAccessGate module="accounting_reports" moduleLabel="Live GST Portal Sync" permissionFlag="can_view_accounting_reports">
      <GSTPortalSyncInner />
    </RequestAccessGate>
  );
}

export default GSTPortalSync;
