import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getXLSX, getJsPDF, getAutoTable } from '@/lib/lazyLibs';
import { saveAs } from 'file-saver';
// XLSX / jsPDF / autoTable are loaded on demand (see readWorkbook, exportPDF, exportExcel)
// instead of statically imported, so opening this page doesn't force-download ~1MB of
// export/parsing libraries that most visits never use.
let XLSX, jsPDF, autoTable;
import { motion, AnimatePresence } from 'framer-motion';
import api from '@/lib/api';
import {
  Upload, CheckCircle2, AlertTriangle, Download, Search, ArrowLeft, RefreshCw, ArrowLeftRight, Info, X, Globe, BookOpen, FileText, FileSpreadsheet, Building2, Hash, MapPin, Phone, Mail, Calendar, ChevronRight, ScanSearch, Filter, Tag, ArrowUpDown, ChevronsUpDown, History, Clock, Trash2, ChevronDown, User, Loader2, FolderOpen, Edit3, MessageSquare, Sparkles, Layers, Plus, BarChart3, TrendingUp, ShieldCheck, Save, CalendarClock
} from 'lucide-react';
import { toast } from 'sonner';
import AIFileInsights from '@/components/ui/AIFileInsights.jsx';
import { lookupGSTIN, decodeGSTIN } from '@/lib/gstApi';

/* ═══════════════════════════════════════════════════════════════════════════
   PARSING UTILITIES
═══════════════════════════════════════════════════════════════════════════ */
/**
 * normaliseInvoice — extract the canonical invoice serial for matching.
 *
 * Strategy: the actual invoice number is always the LAST purely-numeric
 * segment after any / or - separator. If no separator exists, strip any
 * leading alpha series prefix.
 *
 *   "4930"       → "4930"
 *   "DB-T/4930"  → "4930"   ← complex multi-part prefix
 *   "DB-T/4812"  → "4812"
 *   "SW-60134"   → "60134"
 *   "INV/1234"   → "1234"
 *   "12/0033902" → "33902"
 *   "T1326"      → "1326"   ← alpha directly attached
 *   "INV1234"    → "1234"
 */
/**
 * normaliseInvoice v2 — Smart multi-segment serial extraction.
 *
 * Handles real-world Indian GST invoice formats:
 *   "4930"              → "4930"    (pure numeric)
 *   "DB-T/4930"         → "4930"    (alpha prefix + numeric)
 *   "T/0004930/26"      → "4930"    (FY suffix /26 discarded)
 *   "GST/24-25/4930"    → "4930"    (FY range /24-25/ discarded)
 *   "INV-2024-001234"   → "1234"    (year /2024/ discarded, serial wins)
 *   "12/0033902"        → "33902"   (month prefix /12/ discarded)
 *   "001/2026"          → "1"       (year /2026/ discarded)
 *   "T1326"             → "1326"    (alpha directly attached)
 *   "INV/1234"          → "1234"    (simple prefix/serial)
 *   "GST-24-25-0047"    → "47"      (serial > month/FY)
 *
 * Strategy:
 *   1. Split by / and - into parts.
 *   2. Keep only purely-numeric parts.
 *   3. Remove "noise" parts: 2-digit FY codes (19–35) and 4-digit years (2000–2035).
 *   4. Among remaining candidates, pick the LONGEST (most digits = most specific serial).
 *   5. Ties → last wins (rightmost in Indian invoice numbering).
 *   6. If all parts are noise, fall back to the longest of all parts.
 */
function normaliseInvoice(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';

  // Handle common prefixes like "INV-", "PO-", "BILL-", "TAX-" etc.
  const cleanedS = s.replace(/^(INV|INVOICE|BILL|PO|TAX|GST|B2B|PURCHASE|PUR|RCV|RCPT|RECEIPT|VCH|VOUCHER|DR|CR|DN|CN)[/\-#]*/i, '');
  if (/^\d+$/.test(cleanedS)) return cleanedS.replace(/^0+/, '') || '0';

  const parts = s.split(/[\/\-\.#]/).filter(Boolean);
  const numericParts = parts
    .filter(p => /^\d+$/.test(p))
    .map(p => ({ raw: p, stripped: p.replace(/^0+/, '') || '0', len: p.length }));

  if (numericParts.length === 0) {
    // Try to extract trailing digits from alphanumeric strings like "INV1234", "T1326"
    const m = s.match(/([A-Z][A-Z0-9]*[-/#]?)*(\d{3,})$/);
    if (m && m[2]) return m[2].replace(/^0+/, '') || '0';
    const m2 = s.match(/^[A-Z]+(\d+)/);
    return m2 ? m2[1].replace(/^0+/, '') || '0' : s;
  }
  if (numericParts.length === 1) return numericParts[0].stripped;

  const isNoise = ({ stripped, len }) => {
    const v = parseInt(stripped, 10);
    if (len <= 2 && v >= 1 && v <= 12) return true;   // month (01-12)
    if (len <= 2 && v >= 13 && v <= 35) return true;  // 2-digit FY (FY13-FY35)
    if (len === 4 && v >= 2000 && v <= 2035) return true; // 4-digit calendar year
    return false;
  };

  const serials = numericParts.filter(p => !isNoise(p));
  const pool    = serials.length > 0 ? serials : numericParts;

  // Among candidates, prefer: (1) longest, (2) rightmost when tied
  return pool.reduce((best, cur) =>
    cur.stripped.length > best.stripped.length ? cur : best
  ).stripped;
}
function normaliseGSTIN(val) {
  return val ? String(val).trim().toUpperCase() : '';
}
function toNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  // Handle Indian number formatting: remove ₹ and commas, treat (x) as negative
  let s = String(val).trim();
  const isNeg = s.startsWith('(') && s.endsWith(')');
  if (isNeg) s = s.slice(1, -1);
  const n = parseFloat(s.replace(/[₹,\s]/g, '').replace(/[^0-9.-]/g, ''));
  if (isNaN(n)) return 0;
  return isNeg ? -n : n;
}
const MONTH_ABBR = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
function fmtDate(val) {
  if (!val) return '';
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      if (d) return `${String(d.d).padStart(2,'0')}/${String(d.m).padStart(2,'0')}/${d.y}`;
    } catch (_) {}
  }
  const s = String(val).trim();
  // Day-MonthWord-Year in any separator: "7-Apr-26" "07/Apr/2026" "7 Apr 26" "10.Apr.2026"
  const ma = s.match(/^(\d{1,2})[-\/\s.]([A-Za-z]{3,9})[-\/\s.](\d{2,4})$/);
  if (ma) {
    const mo = MONTH_ABBR[ma[2].slice(0,3).toLowerCase()];
    if (mo) {
      const y = ma[3].length <= 2 ? `20${ma[3]}` : ma[3];
      return `${ma[1].padStart(2,'0')}/${mo}/${y}`;
    }
  }
  // MonthWord-Day-Year: "Apr-10-26" "April 10 2026"
  const mb = s.match(/^([A-Za-z]{3,9})[-\/\s.](\d{1,2})[-\/\s.](\d{2,4})$/);
  if (mb) {
    const mo = MONTH_ABBR[mb[1].slice(0,3).toLowerCase()];
    if (mo) {
      const y = mb[3].length <= 2 ? `20${mb[3]}` : mb[3];
      return `${mb[2].padStart(2,'0')}/${mo}/${y}`;
    }
  }
  // Normalise YYYY-MM-DD → DD/MM/YYYY
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m1) return `${m1[3].padStart(2,'0')}/${m1[2].padStart(2,'0')}/${m1[1]}`;
  // Normalise DD-MM-YYYY → DD/MM/YYYY
  const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m2) return `${m2[1].padStart(2,'0')}/${m2[2].padStart(2,'0')}/${m2[3]}`;
  // Normalise DD-MM-YY → DD/MM/20YY
  const m3 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/);
  if (m3) return `${m3[1].padStart(2,'0')}/${m3[2].padStart(2,'0')}/20${m3[3]}`;
  return s;
}
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    if (!row) continue;
    for (let c = 0; c < Math.min(5, row.length); c++) {
      const cell = String(row[c] || '').toLowerCase();
      if (cell.includes('gstin') && (cell.includes('supplier') || cell.startsWith('gstin'))) return i;
    }
  }
  return -1;
}
function buildColMap(headerRow) {
  const map = {};
  if (!headerRow) return map;
  headerRow.forEach((cell, idx) => { if (cell) map[String(cell).trim().toLowerCase()] = idx; });
  return map;
}
function findCol(colMap, ...keys) {
  for (const k of keys)
    for (const [col, idx] of Object.entries(colMap))
      if (col.includes(k.toLowerCase())) return idx;
  return -1;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOKS FILE — MULTI-FORMAT PARSERS
   Supports:
   1. Standard Purchase Register (B2B sheet — Tally / any accounting software)
   2. GSTR-2 As per Books / B2BInvoices CSV (GST portal export format)
   3. Tally DayBook Export (Date, Particulars, Voucher Type, Debit, Credit)
   4. Marg / Busy / Vyapar billing software exports (flexible column mapping)
═══════════════════════════════════════════════════════════════════════════ */

/** Parses GSTR-2 As per Books / B2BInvoices CSV layout.
 *  Expects rows array + index of the header row.
 *  Handles both date formats: DD-MM-YYYY and DD/MM/YYYY.
 *  Correctly maps IGST vs CGST+SGST based on supply type. */
function _parseBooksGSTFormat(rows, hi) {
  const cm = buildColMap(rows[hi]);
  const g  = (...k) => { const c = findCol(cm, ...k); return c >= 0 ? c : -1; };
  const gstinC = g('supplier gstin', 'gstin of supplier', 'gstin');
  const nameC  = g('party name', 'trade/legal', 'supplier name', 'legal name');
  const invNoC = g('inv. no.', 'invoice number', 'invoice no.');
  const dateC  = g('inv. date', 'invoice date', 'date');
  const valC   = g('inv. value', 'invoice value', 'total invoice value');
  const taxC   = g('total taxable value', 'taxable value');
  const igstC  = g('integrated tax', 'igst');
  const cgstC  = g('central tax', 'cgst');
  const sgstC  = g('state / ut tax', 'state/ut tax', 'sgst', 'state tax');
  const cessC  = g('cess');
  const posC   = g('place of supply');
  const rcC    = g('reverse charge');
  const typeC  = g('invoice type');
  const rateC  = g('rate');
  const itcC   = g('itc eligibility', 'itc avail', 'itc availability');
  const stypeC = g('supply type');

  const _parseDDMMYYYY = s => {
    if (!s) return '';
    const str = String(s).trim();
    const m1 = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m1) return `${m1[1].padStart(2,'0')}/${m1[2].padStart(2,'0')}/${m1[3]}`;
    const m2 = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
    if (m2) return `${m2[1].padStart(2,'0')}/${m2[2].padStart(2,'0')}/20${m2[3]}`;
    return fmtDate(s);
  };

  const data = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const get = idx => idx >= 0 && idx < r.length ? String(r[idx] ?? '').trim() : '';
    const gstin = normaliseGSTIN(get(gstinC));
    const invNo = normaliseInvoice(get(invNoC));
    if (!gstin || gstin.length < 10 || !invNo) continue;
    // Skip totals / summary rows
    const gstinRaw = get(gstinC).toUpperCase();
    if (!gstinRaw || gstinRaw === 'TOTAL' || gstinRaw.includes('TOTAL')) continue;

    const supplyType = get(stypeC).toLowerCase();
    const isInter    = supplyType.includes('inter') && !supplyType.includes('intra');
    const igst = toNum(get(igstC));
    const cgst = toNum(get(cgstC));
    const sgst = toNum(get(sgstC));
    const rateRaw = String(r[rateC] ?? '').replace(/[^0-9.]/g, '');

    data.push({
      gstin, invoiceNo: invNo, invoiceNoRaw: get(invNoC),
      invoiceDate:  _parseDDMMYYYY(r[dateC]),
      invoiceValue: toNum(get(valC)),
      taxableValue: toNum(get(taxC)),
      igst:  isInter ? igst  : 0,
      cgst:  isInter ? 0     : cgst,
      sgst:  isInter ? 0     : sgst,
      cess: toNum(get(cessC)),
      placeOfSupply: get(posC), reverseCharge: get(rcC),
      invoiceType:   get(typeC) || 'Regular',
      rate: toNum(rateRaw),
      tradeOrLegalName: get(nameC),
      itcAvailability:  get(itcC) || 'Inputs',
      filingDate: '', source: 'books',
    });
  }
  return data;
}

/** Parses standard Tally / any accounting software Purchase Register.
 *  Sheet: b2b (or first sheet). Headers: GSTIN of Supplier, Invoice Number, … */
function _parseBooksStandardFormat(rows, hi) {
  const cm = buildColMap(rows[hi]);
  const g  = (a, ...k) => { const c = findCol(a, ...k); return c >= 0 ? c : -1; };
  const gstinC = g(cm, 'gstin of supplier', 'gstin');
  const invNoC = g(cm, 'invoice number', 'invoice no');
  const dateC  = g(cm, 'invoice date', 'date');
  const valC   = g(cm, 'invoice value');
  const taxC   = g(cm, 'taxable value');
  const igstC  = g(cm, 'integrated tax paid', 'integrated tax');
  const cgstC  = g(cm, 'central tax paid', 'central tax');
  const sgstC  = g(cm, 'state/ut tax paid', 'state/ut tax', 'state tax');
  const cessC  = g(cm, 'cess paid', 'cess');
  const posC   = g(cm, 'place of supply', 'place');
  const rcC    = g(cm, 'reverse charge');
  const typeC  = g(cm, 'invoice type', 'type');
  const rateC  = g(cm, 'rate');
  const itcC   = g(cm, 'itc availability', 'itc avail');
  const nameC  = g(cm, 'trade/legal', 'trade name', 'supplier name');

  const data = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const gstin = normaliseGSTIN(r[gstinC]);
    const invNo = normaliseInvoice(r[invNoC]);
    if (!gstin || !invNo || gstin.length < 10) continue;
    data.push({
      gstin, invoiceNo: invNo, invoiceNoRaw: String(r[invNoC] || '').trim(),
      invoiceDate: fmtDate(r[dateC]), invoiceValue: toNum(r[valC]),
      taxableValue: toNum(r[taxC]), igst: toNum(r[igstC]), cgst: toNum(r[cgstC]),
      sgst: toNum(r[sgstC]), cess: toNum(r[cessC]),
      placeOfSupply: String(r[posC] || '').trim(), reverseCharge: String(r[rcC] || '').trim(),
      invoiceType: String(r[typeC] || '').trim(), rate: toNum(r[rateC]),
      tradeOrLegalName: String(r[nameC >= 0 ? nameC : -1] || '').trim(),
      itcAvailability: String(r[itcC >= 0 ? itcC : -1] || '').trim(),
      filingDate: '', source: 'books',
    });
  }
  return data;
}

/** Parses Tally DayBook export.
 *  Columns: Date | Particulars | Voucher No. | Book | Voucher Type | Debit | Credit.
 *  Only Purchase vouchers are extracted; GSTIN is extracted from Particulars. */
function _parseBooksDayBookFormat(rows) {
  const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}\b/;

  // Find header row (contains Particulars + Debit/Credit)
  let hi = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const rStr = (rows[i] || []).map(c => String(c || '').toLowerCase()).join('|');
    if ((rStr.includes('particulars') || rStr.includes('narration')) &&
        (rStr.includes('debit') || rStr.includes('credit'))) {
      hi = i; break;
    }
  }
  if (hi < 0) return [];

  const headers  = (rows[hi] || []).map(h => String(h || '').trim().toLowerCase());
  const dateIdx  = headers.findIndex(h => h === 'date');
  const partIdx  = headers.findIndex(h => h.includes('particulars') || h.includes('narration'));
  const vnoIdx   = headers.findIndex(h => h.includes('voucher no') || h === 'vno' || h === 'no.' || h === 'vch no');
  const vtypeIdx = headers.findIndex(h => h.includes('voucher type') || h === 'vch type' || (h.includes('type') && !h.includes('invoice')));
  const debitIdx = headers.findIndex(h => h === 'debit' || h === 'dr' || h === 'debit amount');
  const creditIdx= headers.findIndex(h => h === 'credit' || h === 'cr' || h === 'credit amount');

  const data = [];
  let lastDate = '';

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const get = idx => idx >= 0 && idx < r.length ? String(r[idx] ?? '').trim() : '';

    const dateVal = get(dateIdx);
    if (dateVal && /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/.test(dateVal)) lastDate = dateVal;

    const vtype = get(vtypeIdx).toLowerCase();
    // Only process Purchase vouchers
    if (!vtype || (!vtype.includes('purchase') && !vtype.includes('journal'))) continue;

    const particulars = get(partIdx);
    const vno         = get(vnoIdx);
    const debit       = toNum(get(debitIdx));
    const credit      = toNum(get(creditIdx));
    const amount      = debit > 0 ? debit : credit;

    if (!particulars || amount <= 0 || !vno) continue;

    // Extract GSTIN embedded in the particulars description
    const gstinMatch = particulars.match(GSTIN_RE);
    if (!gstinMatch) continue;

    const gstin  = gstinMatch[0];
    const invNo  = vno;
    // For DayBook we can't know the GST rate exactly; use 5% as common pharma/medical default
    const taxable = Math.round(amount / 1.05 * 1000) / 1000;
    const gst     = Math.round((amount - taxable) * 1000) / 1000;

    data.push({
      gstin: normaliseGSTIN(gstin),
      invoiceNo:    normaliseInvoice(invNo),
      invoiceNoRaw: invNo,
      invoiceDate:  fmtDate(lastDate),
      invoiceValue: amount,
      taxableValue: Math.round(taxable * 100) / 100,
      igst: 0,
      cgst: Math.round(gst / 2 * 100) / 100,
      sgst: Math.round(gst / 2 * 100) / 100,
      cess: 0,
      placeOfSupply: '', reverseCharge: 'N',
      invoiceType: 'Regular', rate: 5,
      tradeOrLegalName: particulars.split(/[-,(]/)[0].trim(),
      itcAvailability: 'Inputs', filingDate: '', source: 'books',
    });
  }
  return data;
}

/** Parses any general invoices/sales Excel report (Marg, Busy, Vyapar export etc.)
 *  Falls back on flexible column name matching. */
function _parseBooksFallback(rows, hi) {
  const cm = buildColMap(rows[hi]);
  const g  = (...k) => { const c = findCol(cm, ...k); return c >= 0 ? c : -1; };
  const gstinC = g('gstin', 'gst no', 'gst number', 'tax id');
  const invNoC = g('invoice no', 'invoice number', 'bill no', 'bill number', 'inv no', 'ref no');
  const dateC  = g('invoice date', 'bill date', 'date');
  const valC   = g('invoice value', 'bill amount', 'total amount', 'net amount', 'total');
  const taxC   = g('taxable value', 'taxable amount', 'basic amount');
  const igstC  = g('igst', 'integrated tax');
  const cgstC  = g('cgst', 'central tax');
  const sgstC  = g('sgst', 'state tax', 'state/ut tax');
  const nameC  = g('party name', 'supplier name', 'vendor name', 'customer name');

  const data = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const get = idx => idx >= 0 && idx < r.length ? String(r[idx] ?? '').trim() : '';
    const gstin = normaliseGSTIN(get(gstinC));
    const invNo = normaliseInvoice(get(invNoC));
    if (!gstin || gstin.length < 10 || !invNo) continue;
    const val  = toNum(get(valC));
    const tax  = toNum(get(taxC)) || Math.round(val / 1.05 * 100) / 100;
    const igst = toNum(get(igstC));
    const cgst = toNum(get(cgstC));
    const sgst = toNum(get(sgstC));
    data.push({
      gstin, invoiceNo: invNo, invoiceNoRaw: get(invNoC),
      invoiceDate: fmtDate(r[dateC]), invoiceValue: val, taxableValue: tax,
      igst, cgst, sgst, cess: 0, placeOfSupply: '', reverseCharge: 'N',
      invoiceType: 'Regular', rate: 0,
      tradeOrLegalName: get(nameC), itcAvailability: 'Inputs',
      filingDate: '', source: 'books',
    });
  }
  return data;
}

/** ── Master Books Parser ──────────────────────────────────────────────────
 *  Auto-detects format from sheet names, header content, and filename.
 *  Priority: DayBook → GST Books / B2BInvoices → Standard Purchase Register → Fallback */
function parseBooksFile(workbook, filename) {
  const fn = (filename || '').toLowerCase();

  // Choose best sheet: prefer b2b / gstr / purchase sheets
  const sheetName = workbook.SheetNames.find(n => {
    const nl = n.trim().toLowerCase();
    return nl === 'b2b' || nl === 'b2b(2a)' || nl === 'gstr-2' ||
           nl === 'purchase register' || nl === 'purchase' || nl === 'b2b invoices';
  }) || workbook.SheetNames[0];

  const ws   = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  // ── 1. Detect DayBook (Tally) ───────────────────────────────────────────
  const isDayBook = rows.slice(0, 10).some(r => {
    const s = (r || []).map(c => String(c || '').toLowerCase()).join('|');
    return (s.includes('particulars') || s.includes('narration')) &&
           (s.includes('debit') || s.includes('credit')) &&
           (s.includes('voucher') || s.includes('vch'));
  });
  if (isDayBook) return _parseBooksDayBookFormat(rows);

  // ── 2. Find header row by scanning for GSTIN/Invoice keywords ──────────
  let hi = -1;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const rStr = (rows[i] || []).map(c => String(c || '').toLowerCase()).join('|');
    if (rStr.includes('gstin') && (rStr.includes('supplier') || rStr.includes('party') ||
        rStr.includes('inv') || rStr.includes('invoice'))) {
      hi = i; break;
    }
  }
  if (hi < 0) hi = findHeaderRow(rows);
  if (hi < 0) hi = 2;

  const headerRow = (rows[hi] || []).map(c => String(c || '').toLowerCase());
  const hStr      = headerRow.join('|');

  // ── 3. Detect GST Books / B2BInvoices format ───────────────────────────
  const isGSTBooks = hStr.includes('inv. no.') || hStr.includes('inv. date') ||
                     hStr.includes('party name') || hStr.includes('supply type') ||
                     hStr.includes('total taxable value') ||
                     fn.includes('b2binvoices') || fn.includes('as_per_books') ||
                     fn.includes('gstr') || fn.includes('b2b');
  if (isGSTBooks) return _parseBooksGSTFormat(rows, hi);

  // ── 4. Standard Purchase Register ─────────────────────────────────────
  const isStandard = hStr.includes('gstin of supplier') || hStr.includes('invoice number') ||
                     hStr.includes('invoice value') || hStr.includes('integrated tax paid');
  if (isStandard) return _parseBooksStandardFormat(rows, hi);

  // ── 5. Fallback flexible parser ────────────────────────────────────────
  return _parseBooksFallback(rows, hi);
}

function parseGSTPortalFile(workbook) {
  const sheetName = workbook.SheetNames.find(n => n.trim().toUpperCase() === 'B2B') || workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  let upperIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const c = String(rows[i]?.[0] || '').toLowerCase();
    if (c.includes('gstin') && c.includes('supplier')) { upperIdx = i; break; }
  }
  if (upperIdx === -1) upperIdx = 4;
  const subIdx = upperIdx + 1;
  const upper = rows[upperIdx] || [];
  const sub   = rows[subIdx]   || [];
  const combined = [];
  for (let i = 0; i < Math.max(upper.length, sub.length); i++)
    combined.push(sub[i] || upper[i] || null);
  const cm = buildColMap(combined);
  const uc = buildColMap(upper);
  Object.assign(cm, { ...uc, ...cm });
  const g = (def, ...k) => { const c = findCol(cm, ...k); return c >= 0 ? c : def; };
  const gstinC   = g(0,  'gstin of supplier', 'gstin');
  const nameC    = g(1,  'trade/legal', 'trade name', 'legal name');
  const invNoC   = g(2,  'invoice number', 'invoice no');
  const typeC    = g(3,  'invoice type');
  const dateC    = g(4,  'invoice date');
  const valC     = g(5,  'invoice value');
  const posC     = g(6,  'place of supply');
  const rcC      = g(7,  'reverse charge', 'supply attract');
  const taxC     = g(8,  'taxable value');
  const igstC    = g(9,  'integrated tax');
  const cgstC    = g(10, 'central tax');
  const sgstC    = g(11, 'state/ut tax', 'state tax');
  const cessC    = g(12, 'cess');
  const itcC     = findCol(cm, 'itc availability', 'itc avail');
  const filingC  = findCol(cm, 'filing date', 'gstr-1');
  const data = [];
  for (let i = subIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const get = (idx) => { if (idx < 0 || idx >= r.length || r[idx] == null) return ''; return String(r[idx]).trim(); };
    const gstin = normaliseGSTIN(get(gstinC));
    const invNo = normaliseInvoice(get(invNoC));
    if (!gstin || !invNo || gstin.length < 10 || gstin.includes('GSTIN')) continue;
    data.push({
      gstin, invoiceNo: invNo, invoiceNoRaw: get(invNoC),
      invoiceDate: fmtDate(r[dateC]), invoiceValue: toNum(get(valC)),
      taxableValue: toNum(get(taxC)), igst: toNum(get(igstC)), cgst: toNum(get(cgstC)),
      sgst: toNum(get(sgstC)), cess: toNum(get(cessC)),
      placeOfSupply: get(posC), reverseCharge: get(rcC), invoiceType: get(typeC),
      tradeOrLegalName: get(nameC), itcAvailability: get(itcC >= 0 ? itcC : -1),
      filingDate: fmtDate(r[filingC >= 0 ? filingC : -1]), rate: 0, source: 'portal',
    });
  }
  return data;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLIENT-SIDE GSTIN LOOKUP ENGINE
   ─────────────────────────────────────────────────────────────────────────
   Runs entirely in the browser — no backend round-trip required.
   Avoids the Render-backend CORS failures caused by the backend's own
   outbound HTTP calls to GST portal being blocked on Render's free tier.

   Strategy (tried in order, first success wins):
     1. GST Portal public JSON API  (services.gst.gov.in/services/api/public/gstin)
     2. GST taxpayer-details API    (services.gst.gov.in/services/api/search/taxpayerDetails)
     3. CORS proxy → knowyourgst.com  (allorigins.win free proxy, HTML scrape)
     4. Backend API fallback        (kept for completeness when proxy is down)
   Each source has a hard 6-second abort signal so a dead host can't stall UI.
   Results are cached in module-scope Map so repeated lookups are instant.
═══════════════════════════════════════════════════════════════════════════ */

const GST_STATE_CODES = {
  '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh',
  '05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh',
  '10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur',
  '15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','25':'Daman & Diu','26':'Dadra & Nagar Haveli','27':'Maharashtra',
  '28':'Andhra Pradesh','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala',
  '33':'Tamil Nadu','34':'Puducherry','35':'Andaman & Nicobar','36':'Telangana',
  '37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory',
};

/** Decode static info from the GSTIN structure itself — no network call needed */
function decodeGstin(gstin) {
  const g = (gstin || '').toUpperCase().trim();
  const stateCode = g.slice(0, 2);
  const pan       = g.slice(2, 12);
  const entityCode = g[12] || '';
  // Entity-type letter is the 6th char of the embedded PAN (pos 7 in GSTIN = index 6)
  // P=Individual, C=Company, H=HUF, F=Firm, A=AOP, B=BOI, G=Govt, L=LLP, J=AJP, T=Trust
  const entityTypes = { P:'Individual',C:'Company',H:'HUF',F:'Firm',A:'AOP/BOI',
                        B:'BOI',G:'Government',L:'LLP',J:'AJP',T:'Trust' };
  const entityLetter = pan[4] || '';
  return {
    stateCode,
    state:  GST_STATE_CODES[stateCode] || '',
    pan,
    entityType: entityTypes[entityLetter] || 'Regular',
    regNumber: entityCode,
  };
}

/** Module-scope cache: gstin → { tradeName, legalName, state, source } */
const _gstinCache = new Map();
/** In-flight promise cache to avoid parallel duplicate fetches */
const _gstinInFlight = new Map();

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Main entry point. Returns { tradeName, legalName, state, stateCode, entityType, source }.
 * Always resolves (never rejects). Falls through all sources silently.
 */
async function clientGstinLookup(gstin) {
  const g = (gstin || '').toUpperCase().trim();
  if (!GSTIN_PATTERN.test(g)) return { tradeName:'', legalName:'', state:'', source:'invalid' };

  // Return cached result immediately
  if (_gstinCache.has(g)) return _gstinCache.get(g);

  // Deduplicate concurrent calls for the same GSTIN
  if (_gstinInFlight.has(g)) return _gstinInFlight.get(g);

  const staticInfo = decodeGstin(g);

  const promise = (async () => {
    // ── Primary Source: Free GST API backend proxy (CORS-safe server-side) ──
    try {
      const res = await lookupGSTIN(g);
      if (res) {
        const tn = (res.trade_name || res.tradeName || '').trim();
        const ln = (res.legal_name || res.legalName || '').trim();
        const name = tn || ln;
        if (name && !name.includes('(') && !name.includes('Unverified')) {
          const out = {
            tradeName: tn || ln,
            legalName: ln || tn,
            state: res.state_name || res.state || staticInfo.state,
            stateCode: res.state_code || staticInfo.stateCode,
            entityType: res.entity_type || staticInfo.entityType,
            pan: res.pan || staticInfo.pan,
            address: res.principal_place_of_business?.address || '',
            source: res.source || 'free_gst_api',
            valid: true,
          };
          _gstinCache.set(g, out);
          _gstinInFlight.delete(g);
          return out;
        }
      }
    } catch (_) { /* continue to next source */ }

    // ── Secondary Source: Backend GSTIN lookup route ──────────────────────
    try {
      const r = await api.get(`/gst-reconciliation/gstin-lookup/${g}`, { _silent: true });
      if (r.data) {
        const d = r.data;
        const tn = (d.trade_name || '').trim();
        const ln = (d.legal_name || '').trim();
        if (tn || ln) {
          const out = {
            tradeName: tn || ln,
            legalName: ln || tn,
            state: d.state || staticInfo.state,
            stateCode: staticInfo.stateCode,
            entityType: staticInfo.entityType,
            pan: staticInfo.pan,
            address: '',
            source: 'backend_api',
            valid: true,
          };
          _gstinCache.set(g, out);
          _gstinInFlight.delete(g);
          return out;
        }
      }
    } catch (_) { /* backend unreachable */ }

    // All sources failed — return static info decoded from GSTIN structure
    const out = {
      tradeName: '',
      legalName: '',
      ...staticInfo,
      source: 'static_decode_only',
      valid: GSTIN_PATTERN.test(g),
    };
    _gstinCache.set(g, out);
    _gstinInFlight.delete(g);
    return out;
  })();

  _gstinInFlight.set(g, promise);
  return promise;
}

/**
 * extractPortalMetadata — reads the GSTR-2B Excel header rows (0-9) to pull:
 *   • period     e.g. "Oct-24"  (from "Return Period : 102024" or "October 2024")
 *   • gstin      e.g. "24XXXXX…" (the taxpayer's own GSTIN in the header)
 *   • tradeName  e.g. "MED 7 PHARMACY"
 *
 * GSTR-2B files from GST portal always embed these in rows before the data
 * table header.  Layout varies slightly across FY/portal versions, so we scan
 * every cell in rows 0-12 rather than hard-coding row indices.
 */
function _parsePeriodString(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // "102024" or "012025"
  const m1 = s.match(/^(0[1-9]|1[0-2])(\d{4})$/);
  if (m1) return _fmtPeriod(m1[1], m1[2]);
  // "October 2024" / "Oct-2024"
  const MONTHS = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const m2 = s.match(/([a-z]{3,})[^a-z]*(\d{4})/i);
  if (m2) {
    const idx = MONTHS.findIndex(mo => mo.startsWith(m2[1].toLowerCase().slice(0,3)));
    if (idx >= 0) return _fmtPeriod(String(idx + 1).padStart(2,'0'), m2[2]);
  }
  return s; // Return as-is when unrecognised
}
function _fmtPeriod(mm, yyyy) {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(mm,10)-1]}-${yyyy.slice(2)}`;
}

function extractPortalMetadata(workbook) {
  // Use B2B sheet if present, else first sheet
  const sheetName =
    workbook.SheetNames.find(n => n.trim().toUpperCase() === 'B2B') ||
    workbook.SheetNames[0];
  const ws   = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let period = '', gstin = '', tradeName = '';

  for (let i = 0; i < Math.min(rows.length, 13); i++) {
    const row = rows[i];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim();
      if (!cell) continue;
      const lo = cell.toLowerCase();

      // ── GSTIN of taxpayer ──────────────────────────────────────────────
      if (!gstin) {
        // Pattern: "GSTIN : 24XXXXX" in one cell
        const gm = cell.match(/gstin\s*[:\-]\s*([A-Z0-9]{15})/i);
        if (gm && GSTIN_PATTERN.test(gm[1].toUpperCase())) {
          gstin = gm[1].toUpperCase();
        }
        // Previous/current cell is "GSTIN" and this cell is the value
        if (!gstin && GSTIN_PATTERN.test(cell.toUpperCase().replace(/\s/g,''))) {
          const prev = String(row[c-1] ?? '').toLowerCase();
          if (prev.includes('gstin') || i < 6) {
            gstin = cell.toUpperCase().replace(/\s/g,'');
          }
        }
      }

      // ── Return period ───────────────────────────────────────────────────
      if (!period) {
        if (lo.includes('return period') || lo.includes('tax period') || lo.includes('filing period')) {
          // "Return Period : 102024" — value may be in next cell or same cell
          const inCell = cell.match(/period\s*[:\-]\s*(.+)/i);
          if (inCell) { period = _parsePeriodString(inCell[1].trim()); }
          else {
            const next = String(row[c+1] ?? '').trim();
            if (next) period = _parsePeriodString(next);
          }
        }
        // "Period : 102024" standalone label in col 0
        if (!period && lo.startsWith('period')) {
          const vm = cell.match(/period\s*[:\-]\s*(.+)/i);
          if (vm) period = _parsePeriodString(vm[1].trim());
          else {
            const next = String(row[c+1] ?? '').trim();
            if (next) period = _parsePeriodString(next);
          }
        }
        // Raw 6-digit numeric period e.g. "102024" sitting alone in a cell
        if (!period && /^(0[1-9]|1[0-2])\d{4}$/.test(cell)) {
          period = _parsePeriodString(cell);
        }
      }

      // ── Trade / Legal name ──────────────────────────────────────────────
      if (!tradeName) {
        if (lo.includes('trade name') || lo.includes('legal name') || lo.includes('trade/legal')) {
          const nm = cell.match(/(?:trade|legal)\s*(?:name)?\s*[:\-]\s*(.+)/i);
          if (nm && nm[1].trim().length > 1) { tradeName = nm[1].trim(); }
          else {
            const next = String(row[c+1] ?? '').trim();
            if (next && next.length > 1 && !GSTIN_PATTERN.test(next.toUpperCase()))
              tradeName = next;
          }
        }
      }

      if (period && gstin && tradeName) break;
    }
    if (period && gstin && tradeName) break;
  }

  return { period, gstin, tradeName };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RECONCILIATION ENGINE  v3 — Accuracy improvements
   ─────────────────────────────────────────────────────────────────────────
   Pass 1 : Exact key match      (gstin + normalised invoice no)
   Pass 2 : Prefix-only match    (same numeric core, only prefix differs)
   Pass 3 : Value+GSTIN match    (same gstin + value within tolerance, no inv-no match)
   Pass 4 : Near-GSTIN match     (1-char GSTIN typo + same invoice no + same value)
   ─────────────────────────────────────────────────────────────────────────
   Improvements over v2:
   • Date normalisation  — parses DD/MM/YYYY, DD-MM-YYYY, MM/DD/YYYY, ISO, Excel serial
   • Smart tolerance     — max(₹1.01, 0.1% of invoice value) avoids false mismatches on
                           large invoices from legitimate rounding
   • Taxable-value guard — if books row has 0 taxable value, skip that field in diff
   • Mismatch reason     — each mismatch gets a human-readable reason + suggested action
   • Credit note aware   — negative-value invoices flagged separately, not counted as errors
   • Dedup within pass   — each portal/books record consumed at most once across all passes
═══════════════════════════════════════════════════════════════════════════ */
const TOLERANCE = 1.01;   // absolute floor ₹

/** Universal date normaliser — converts ANY date format → ISO "YYYY-MM-DD" for comparison.
 *  Handles: DD/MM/YYYY, DD-MM-YYYY, DD-Mon-YY, DD-Mon-YYYY, DD/Mon/YYYY, DD Mon YY,
 *           Mon-DD-YY, Mon DD YYYY, YYYY-MM-DD, YYYY-Mon-DD, Excel serial, MM/DD/YYYY, etc.
 */
function normaliseDateStr(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s || s === '0' || s === 'undefined') return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const MMAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const SEP = '[-\\/\\s.]'; // any separator: - / space .

  // DD-Mon-YY / DD-Mon-YYYY / DD/Mon/YY / DD.Mon.2026 / "7 Apr 26" etc. (day first, word month)
  const re1 = new RegExp(`^(\\d{1,2})${SEP}([A-Za-z]{3,9})${SEP}(\\d{2,4})$`);
  const m1 = s.match(re1);
  if (m1) {
    const mo = MMAP[m1[2].slice(0,3).toLowerCase()];
    if (mo) {
      const y = m1[3].length <= 2 ? `20${m1[3]}` : m1[3];
      return `${y}-${String(mo).padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
    }
  }

  // Mon-DD-YY / Mon DD YYYY / Apr-10-26 / April 10 2026 (month word first)
  const re2 = new RegExp(`^([A-Za-z]{3,9})${SEP}(\\d{1,2})${SEP}(\\d{2,4})$`);
  const m2 = s.match(re2);
  if (m2) {
    const mo = MMAP[m2[1].slice(0,3).toLowerCase()];
    if (mo) {
      const y = m2[3].length <= 2 ? `20${m2[3]}` : m2[3];
      return `${y}-${String(mo).padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
    }
  }

  // YYYY-Mon-DD / 2026-Apr-10 (ISO with word month)
  const re3 = new RegExp(`^(\\d{4})${SEP}([A-Za-z]{3,9})${SEP}(\\d{1,2})$`);
  const m3 = s.match(re3);
  if (m3) {
    const mo = MMAP[m3[2].slice(0,3).toLowerCase()];
    if (mo) return `${m3[1]}-${String(mo).padStart(2,'0')}-${m3[3].padStart(2,'0')}`;
  }

  // YYYY-MM-DD (any separator)
  const ymd = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;

  // DD/MM/YYYY or DD-MM-YYYY (Indian, 4-digit year)
  const dmy4 = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmy4) {
    const [, d, m, y] = dmy4;
    if (parseInt(d,10) > 12) return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    if (parseInt(m,10) > 12) return `${y}-${d.padStart(2,'0')}-${m.padStart(2,'0')}`;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;   // default DD/MM
  }

  // DD/MM/YY or DD-MM-YY (2-digit year)
  const dmy2 = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
  if (dmy2) {
    const [, d, m, yy] = dmy2;
    const y = `20${yy}`;
    if (parseInt(d,10) > 12) return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    if (parseInt(m,10) > 12) return `${y}-${d.padStart(2,'0')}-${m.padStart(2,'0')}`;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Excel serial (40000–60000 covers ~2009–2064)
  const n = parseInt(s, 10);
  if (/^\d+$/.test(s) && n >= 40000 && n <= 60000) {
    try {
      const d = XLSX.SSF.parse_date_code(n);
      if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch (_) {}
  }
  return s;
}


/** Returns all plausible ISO-date interpretations of a raw value.
 *  Used by dateMatches() to compare dates across files that may use different
 *  formats (e.g. Portal DD/MM/YYYY vs Books MM/DD/YY vs YYYY-MM-DD vs "10 Apr 2026").
 */
function dateCandidates(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  const out = new Set();
  const base = normaliseDateStr(s);
  if (base && /^\d{4}-\d{2}-\d{2}$/.test(base)) out.add(base);

  // Numeric DD?-MM?-YY(YY) — add both DMY and MDY interpretations when both are valid
  const m = s.match(/^(\d{1,2})[-\/.\s](\d{1,2})[-\/.\s](\d{2,4})$/);
  if (m) {
    const [, a, b, y] = m;
    const yyyy = y.length <= 2 ? `20${y}` : y;
    const ai = parseInt(a, 10), bi = parseInt(b, 10);
    if (ai >= 1 && ai <= 12 && bi >= 1 && bi <= 31)
      out.add(`${yyyy}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`); // MDY
    if (bi >= 1 && bi <= 12 && ai >= 1 && ai <= 31)
      out.add(`${yyyy}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`); // DMY
  }
  // YYYY-?-? (could be YYYY-MM-DD or YYYY-DD-MM)
  const y4 = s.match(/^(\d{4})[-\/.\s](\d{1,2})[-\/.\s](\d{1,2})$/);
  if (y4) {
    const [, y, a, b] = y4;
    const ai = parseInt(a, 10), bi = parseInt(b, 10);
    if (ai >= 1 && ai <= 12 && bi >= 1 && bi <= 31)
      out.add(`${y}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`);
    if (bi >= 1 && bi <= 12 && ai >= 1 && ai <= 31)
      out.add(`${y}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`);
  }
  return [...out];
}

/** True if two raw date strings can plausibly represent the same calendar date
 *  under any common Indian / ISO / US / word-month format. */
function dateMatches(a, b) {
  if (!a || !b) return true; // missing data — don't penalise
  const A = dateCandidates(a), B = dateCandidates(b);
  if (!A.length || !B.length) return String(a).trim() === String(b).trim();
  return A.some(x => B.includes(x));
}

/** Detect which textual format a raw date string is in.
 *  Returns { iso, format } where `format` is a human-friendly label
 *  (e.g. "DD/MM/YYYY", "MM/DD/YY", "DD-Mon-YYYY", "YYYY-MM-DD",
 *  "Excel serial", "Unrecognised"). Used by the Date Format Log
 *  panel to show users exactly how each input value was normalised. */
function detectDateFormat(raw) {
  if (raw === null || raw === undefined || raw === '') return { iso:'', format:'(empty)' };
  const s = String(raw).trim();
  if (!s) return { iso:'', format:'(empty)' };
  const iso = normaliseDateStr(s);
  const MMAP_KEYS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december';
  const SEP = '[-\\/\\s.]';

  if (/^\d{4}-\d{2}-\d{2}$/.test(s))                    return { iso, format:'YYYY-MM-DD (ISO)' };
  if (new RegExp(`^\\d{1,2}${SEP}(${MMAP_KEYS})${SEP}\\d{4}$`,'i').test(s))
                                                            return { iso, format:'DD-Mon-YYYY (word month)' };
  if (new RegExp(`^\\d{1,2}${SEP}(${MMAP_KEYS})${SEP}\\d{2}$`,'i').test(s))
                                                            return { iso, format:'DD-Mon-YY (word month)' };
  if (new RegExp(`^(${MMAP_KEYS})${SEP}\\d{1,2}${SEP}\\d{2,4}$`,'i').test(s))
                                                            return { iso, format:'Mon-DD-YYYY (word month)' };
  if (new RegExp(`^\\d{4}${SEP}(${MMAP_KEYS})${SEP}\\d{1,2}$`,'i').test(s))
                                                            return { iso, format:'YYYY-Mon-DD (word month)' };

  const ymd = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (ymd) {
    const a = parseInt(ymd[2],10), b = parseInt(ymd[3],10);
    if (a > 12) return { iso, format:'YYYY/DD/MM' };
    if (b > 12) return { iso, format:'YYYY/MM/DD' };
    return { iso, format:'YYYY/MM/DD (ambiguous, assumed)' };
  }
  const dmy = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (dmy) {
    const a = parseInt(dmy[1],10), b = parseInt(dmy[2],10);
    const ySize = dmy[3].length === 2 ? 'YY' : 'YYYY';
    if (a > 12) return { iso, format:`DD/MM/${ySize}` };
    if (b > 12) return { iso, format:`MM/DD/${ySize}` };
    return { iso, format:`DD/MM/${ySize} (ambiguous, assumed)` };
  }
  if (/^\d+$/.test(s)) {
    const n = parseInt(s,10);
    if (n >= 40000 && n <= 60000) return { iso, format:'Excel serial number' };
  }
  return { iso: iso || s, format:'Unrecognised (passed through)' };
}

/** Module-level Date Format Log — populated during reconcile().
 *  Map<key, { raw, iso, format, source, count }> */
const __dateFormatLog = new Map();
function clearDateFormatLog() { __dateFormatLog.clear(); }
function recordDateFormat(raw, source) {
  if (raw === null || raw === undefined || raw === '') return;
  const key = `${source}::${String(raw).trim()}`;
  const existing = __dateFormatLog.get(key);
  if (existing) { existing.count += 1; return; }
  const { iso, format } = detectDateFormat(raw);
  __dateFormatLog.set(key, { raw: String(raw), iso, format, source, count: 1 });
}
function getDateFormatLog() {
  return [...__dateFormatLog.values()].sort((a,b)=>
    a.source.localeCompare(b.source) || a.format.localeCompare(b.format) || a.raw.localeCompare(b.raw)
  );
}

/**
 * Smart tolerance v2 — ₹1.01 floor, 0.1% of value, but CAPPED at ₹50.
 * The cap prevents false matches on large invoices (e.g., ₹10L invoice:
 * old = ₹1000 tolerance which is too loose; new = ₹50 max).
 * For small invoices (< ₹500): floor kicks in at ₹1.01.
 */
function smartTolerance(v1, v2 = 0) {
  const larger = Math.max(Math.abs(v1), Math.abs(v2), 1);
  return Math.max(TOLERANCE, Math.min(50, larger * 0.001));
}

/**
 * Levenshtein distance — used for near-GSTIN matching (1-char typo detection).
 * Limited to short strings so it's fast.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = a[i] === b[j] ? dp[j] : Math.min(dp[j], dp[j+1], prev) + 1;
      dp[j] = prev; prev = cur;
    }
    dp[b.length] = prev;
  }
  return dp[b.length];
}

/* ═══════════════════════════════════════════════════════════════════════════
   MISMATCH INTELLIGENCE ENGINE
   Classifies every mismatch into one of 15+ root-cause categories with a
   specific, actionable suggestion — like a senior CA would diagnose.
═══════════════════════════════════════════════════════════════════════════ */

/** Standard GST slabs for rate-validation. */
const VALID_GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 9, 12, 14, 18, 28];

function _impliedRate(inv) {
  const tax = (inv.igst||0) + (inv.cgst||0) + (inv.sgst||0);
  const base = inv.taxableValue > 0 ? inv.taxableValue : inv.invoiceValue;
  return base > 0 ? (tax / base) * 100 : 0;
}

/**
 * detectMismatchReason v2 — 15+ root-cause categories.
 * Returns { reason, suggestion, severity, tag }
 */
function detectMismatchReason(p, b) {
  const tol      = smartTolerance(p.invoiceValue, b.invoiceValue);
  const valDiff  = p.invoiceValue - b.invoiceValue;
  const pTax     = (p.igst||0) + (p.cgst||0) + (p.sgst||0);
  const bTax     = (b.igst||0) + (b.cgst||0) + (b.sgst||0);
  const taxDiff  = pTax - bTax;
  const valOk    = Math.abs(valDiff) <= tol;
  const taxOk    = Math.abs(taxDiff) <= tol;

  const pDate    = normaliseDateStr(p.invoiceDate);
  const bDate    = normaliseDateStr(b.invoiceDate);
  const dateDiff = pDate && bDate && !dateMatches(p.invoiceDate, b.invoiceDate);

  const pRate    = _impliedRate(p);
  const bRate    = _impliedRate(b);
  const rateDiff = Math.abs(pRate - bRate);

  // ── 1. Only rounding / negligible ─────────────────────────────────────────
  if (valOk && taxOk) {
    if (dateDiff) {
      const pMo = pDate.slice(0, 7), bMo = bDate.slice(0, 7);
      if (pMo !== bMo)
        return { reason: `Cross-month date: Portal ${pDate} vs Books ${bDate}`,
                 suggestion: 'Ensure the invoice is booked in the correct GSTR-3B return period. Cross-month dates affect ITC period.',
                 severity: 'medium', tag: 'DATE' };
      return { reason: `Date differs: Portal ${pDate} vs Books ${bDate}`,
               suggestion: 'Verify invoice date against original. Same-month variance is low-risk but correct for audit trail.',
               severity: 'low', tag: 'DATE' };
    }
    return { reason: 'Minor rounding (within ₹1)', suggestion: 'Safe to accept — ERP rounding artifact.', severity: 'low', tag: 'ROUND' };
  }

  // ── 2. Credit note / debit note (negative value) ─────────────────────────
  if (p.invoiceValue < 0 || b.invoiceValue < 0) {
    const bigDiff = Math.abs(valDiff) > 1000;
    return { reason: 'Credit/Debit note — values signed differently',
             suggestion: 'Link credit note to original invoice. Verify sign convention (portal uses positive for CN amount). ITC reversal required.',
             severity: bigDiff ? 'high' : 'medium', tag: 'CN' };
  }

  // ── 3. Reverse Charge mismatch ───────────────────────────────────────────
  if (p.reverseCharge && b.reverseCharge) {
    const pRC = p.reverseCharge.trim().toUpperCase().charAt(0);
    const bRC = b.reverseCharge.trim().toUpperCase().charAt(0);
    if (pRC !== bRC && (pRC === 'Y' || bRC === 'Y'))
      return { reason: `RCM flag mismatch: Portal="${p.reverseCharge}" Books="${b.reverseCharge}"`,
               suggestion: 'Reverse charge applicability determines whether buyer or seller pays GST. Incorrect flag causes wrong liability + wrong ITC claim.',
               severity: 'high', tag: 'RCM' };
  }

  // ── 4. Inter vs Intra state conflict (IGST vs CGST+SGST) ─────────────────
  const pIsInter = (p.igst||0) > 0.5 && (p.cgst||0) < 0.5;
  const bIsInter = (b.igst||0) > 0.5 && (b.cgst||0) < 0.5;
  if (!valOk || !taxOk) {
    if (pIsInter !== bIsInter)
      return { reason: `Supply type conflict: Portal is ${pIsInter?'Inter':'Intra'}-state, Books is ${bIsInter?'Inter':'Intra'}-state`,
               suggestion: 'Wrong Place of Supply in one record. IGST vs CGST+SGST classification is critical for ITC. Correct books to match portal.',
               severity: 'high', tag: 'SUPPLY_TYPE' };
  }

  // ── 5. Non-standard / invalid GST rate ───────────────────────────────────
  if (pRate > 0 || bRate > 0) {
    const pRateValid = pRate === 0 || VALID_GST_RATES.some(r => Math.abs(pRate - r) < 0.6);
    const bRateValid = bRate === 0 || VALID_GST_RATES.some(r => Math.abs(bRate - r) < 0.6);
    if (!pRateValid || !bRateValid) {
      const badSide = !pRateValid ? `Portal rate ~${pRate.toFixed(1)}%` : `Books rate ~${bRate.toFixed(1)}%`;
      return { reason: `Non-standard GST rate: ${badSide} is not a valid GST slab`,
               suggestion: 'Invalid rate indicates wrong HSN/SAC mapping. Verify HSN code, applicable rate notification, and re-book.',
               severity: 'high', tag: 'RATE_INVALID' };
    }
    if (rateDiff > 1.5)
      return { reason: `GST rate slab differs: Portal ~${pRate.toFixed(0)}% vs Books ~${bRate.toFixed(0)}%`,
               suggestion: "Different tax slabs applied. Confirm correct rate with supplier's GSTIN/HSN. ITC claim must match portal tax.",
               severity: 'high', tag: 'RATE' };
  }

  // ── 6. GST-inclusive vs GST-exclusive entry ───────────────────────────────
  if (!valOk && taxOk && pRate > 0) {
    const excl = b.invoiceValue * (1 + pRate / 100);
    const incl = p.invoiceValue / (1 + pRate / 100);
    if (Math.abs(excl - p.invoiceValue) < tol * 5 || Math.abs(incl - b.invoiceValue) < tol * 5) {
      return { reason: `GST-inclusive vs GST-exclusive: value diff ₹${Math.abs(valDiff).toFixed(2)}`,
               suggestion: 'One entry has GST included in invoice value, the other excludes it. GSTR-2B value is always GST-inclusive. Update books to match.',
               severity: 'medium', tag: 'GST_INCLUSIVE' };
    }
  }

  // ── 7. Value differs, tax matches ─────────────────────────────────────────
  if (!valOk && taxOk) {
    const absDiff = Math.abs(valDiff);
    return { reason: `Invoice value differs by ₹${absDiff.toFixed(2)} — tax amount matches`,
             suggestion: 'Possible freight/discount/round-off included in one but not other. Verify original invoice. Low ITC risk if tax matches.',
             severity: absDiff > 5000 ? 'high' : 'medium', tag: 'VAL_ONLY' };
  }

  // ── 8. Tax differs, value matches ─────────────────────────────────────────
  if (valOk && !taxOk) {
    const absTaxDiff = Math.abs(taxDiff);
    return { reason: `Tax differs by ₹${absTaxDiff.toFixed(2)} — invoice value matches`,
             suggestion: 'Tax computation error in books. Re-check tax rate applied on taxable base. May be wrong HSN or manual override.',
             severity: absTaxDiff > 500 ? 'high' : 'medium', tag: 'TAX_ONLY' };
  }

  // ── 9. Portal significantly higher (GSTR-1 amendment by supplier) ─────────
  if (valDiff > tol) {
    const absDiff = Math.abs(valDiff);
    const pct     = p.invoiceValue > 0 ? absDiff / p.invoiceValue * 100 : 0;
    if (pct > 15)
      return { reason: `Portal value ₹${absDiff.toFixed(2)} (${pct.toFixed(1)}%) higher — likely GSTR-1 amendment`,
               suggestion: 'Supplier has probably amended the invoice in GSTR-1. Request revised invoice. Raise debit note in books for the difference.',
               severity: 'high', tag: 'PORTAL_HIGHER_AMEND' };
    return { reason: `Portal value ₹${absDiff.toFixed(2)} higher than books`,
             suggestion: 'Short-booked in accounts. Verify with vendor\'s original invoice and book the difference to avail full ITC.',
             severity: 'medium', tag: 'PORTAL_HIGHER' };
  }

  // ── 10. Books significantly higher (possible over-booking) ────────────────
  if (valDiff < -tol) {
    const absDiff = Math.abs(valDiff);
    const pct     = b.invoiceValue > 0 ? absDiff / b.invoiceValue * 100 : 0;
    if (pct > 15)
      return { reason: `Books value ₹${absDiff.toFixed(2)} (${pct.toFixed(1)}%) higher than portal — possible duplicate/over-booking`,
               suggestion: 'Check for duplicate entry in books. If unique, vendor understated in GSTR-1 — request GSTR-1 amendment or credit note.',
               severity: 'high', tag: 'BOOKS_HIGHER_DUPE' };
    return { reason: `Books show ₹${absDiff.toFixed(2)} more than portal`,
             suggestion: 'Vendor may have understated invoice in GSTR-1. Request credit note or amendment. Excess ITC claim is a risk.',
             severity: 'medium', tag: 'BOOKS_HIGHER' };
  }

  return { reason: 'Multiple field mismatches — needs manual review',
           suggestion: 'Compare original invoice documents. Raise with vendor if discrepancy persists.',
           severity: 'medium', tag: 'MULTI' };
}

/**
 * checkSection16_4 — CGST Act Section 16(4) ITC deadline guard.
 * ITC for invoices of FY N can be claimed up to due date of GSTR-3B
 * for November of FY N+1 (typically 30 Nov of the following year).
 * Returns { timedOut: bool, warning: string }
 */
function checkSection16_4(invoiceDate) {
  if (!invoiceDate) return { timedOut: false, warning: '' };
  const iso = normaliseDateStr(String(invoiceDate));
  if (!iso || iso.length < 7) return { timedOut: false, warning: '' };
  const y   = parseInt(iso.slice(0, 4), 10);
  const mo  = parseInt(iso.slice(5, 7), 10);
  const invFY   = mo >= 4 ? y : y - 1;       // FY starts April
  const deadline = `${invFY + 1}-11-30`;
  const today    = new Date().toISOString().slice(0, 10);
  if (today > deadline)
    return { timedOut: true, warning: `Sec 16(4): ITC claim deadline passed (was ${deadline} for FY ${invFY}-${String(invFY+1).slice(2)})` };
  const daysLeft = Math.ceil((new Date(deadline) - new Date(today)) / 86400000);
  if (daysLeft <= 45)
    return { timedOut: false, warning: `Sec 16(4): ${daysLeft}d left to claim ITC (deadline ${deadline})` };
  return { timedOut: false, warning: '' };
}

/**
 * detectDuplicates — find invoice keys that appear more than once in a dataset.
 * A duplicate inside portal data inflates ITC claims; in books it doubles expenses.
 * Returns Map of "gstin__invoiceNo" → count (only entries with count > 1).
 */
function detectDuplicates(data) {
  const cnt = new Map();
  for (const inv of data) {
    const k = `${inv.gstin}__${inv.invoiceNo}`;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const dupes = new Map();
  for (const [k, c] of cnt) if (c > 1) dupes.set(k, c);
  return dupes;
}

/**
 * computeMatchStats — derives KPIs from reconciliation results.
 * Returns counts, amount-weighted match rate, ITC breakdown, vendor heat map.
 */
function computeMatchStats(results, manualTradeNames = {}) {
  const { matched, mismatch, portalOnly, booksOnly } = results;
  const totalPortal = matched.length + mismatch.length + portalOnly.length;
  const totalBooks  = matched.length + mismatch.length + booksOnly.length;
  const matchPct    = totalPortal > 0 ? (matched.length / totalPortal * 100).toFixed(1) : '0.0';

  const sum = (arr, fn) => arr.reduce((s, r) => s + (fn(r) || 0), 0);
  const pVal = r => r.portal?.invoiceValue || 0;
  const bVal = r => r.books?.invoiceValue  || 0;
  const pTax = r => (r.portal?.igst||0) + (r.portal?.cgst||0) + (r.portal?.sgst||0);
  const bTax = r => (r.books?.igst||0)  + (r.books?.cgst||0)  + (r.books?.sgst||0);

  const portalTotalAmt  = sum(matched, pVal) + sum(mismatch, pVal) + sum(portalOnly, pVal);
  const matchedAmt      = sum(matched, pVal);
  const amtMatchPct     = portalTotalAmt > 0 ? (matchedAmt / portalTotalAmt * 100).toFixed(1) : '0.0';

  const itcClaimable = sum(matched,    pTax);
  const itcPending   = sum(portalOnly, pTax);
  const itcAtRisk    = sum(booksOnly,  bTax);
  const itcMismatch  = sum(mismatch, r => Math.abs(pTax(r) - bTax(r)));
  const highSeverity = mismatch.filter(r => r.severity === 'high').length;

  // Vendor heat map: group all problem records by GSTIN
  const vmap = new Map();
  const addToMap = (r, category) => {
    const inv = r.portal || r.books;
    const g   = inv?.gstin || ''; if (!g) return;
    const nm  = inv?.tradeOrLegalName || manualTradeNames?.[g] || '';
    const existing = vmap.get(g) || { gstin: g, name: nm, count: 0, amt: 0, tax: 0 };
    existing.count++;
    existing.amt += inv?.invoiceValue || 0;
    existing.tax += (category === 'mismatch') ? Math.abs(pTax(r) - bTax(r)) : (pTax(r) || bTax(r));
    vmap.set(g, existing);
  };
  mismatch.forEach(r => addToMap(r, 'mismatch'));
  portalOnly.forEach(r => addToMap(r, 'portal'));
  booksOnly.forEach(r => addToMap(r, 'books'));

  const topVendors = [...vmap.values()].sort((a, b) => b.amt - a.amt).slice(0, 6);

  return { totalPortal, totalBooks, matchPct, amtMatchPct,
           itcClaimable, itcPending, itcAtRisk, itcMismatch,
           highSeverity, topVendors };
}

/**
 * extractNumericSuffix — delegates to normaliseInvoice (same logic).
 * Used by the secondary prefix-match pass.
 */
function extractNumericSuffix(invNo) {
  return normaliseInvoice(invNo);
}

/**
 * Check whether two invoices differ ONLY in invoice prefix
 * (all financial + identity fields match, numeric part of invoice is same)
 */
function isPrefixOnlyMismatch(p, b) {
  const pNum = extractNumericSuffix(p.invoiceNoRaw || p.invoiceNo);
  const bNum = extractNumericSuffix(b.invoiceNoRaw || b.invoiceNo);
  if (pNum !== bNum || !pNum) return false;
  if (p.gstin !== b.gstin) return false;
  const tol = smartTolerance(p.invoiceValue, b.invoiceValue);
  const vd = Math.abs(p.invoiceValue - b.invoiceValue);
  const taxD  = Math.abs((p.igst+p.cgst+p.sgst) - (b.igst+b.cgst+b.sgst));
  if (vd > tol || taxD > tol) return false;
  // Taxable value: skip if books has 0 (common when not exported)
  const hasTax = b.taxableValue > 0 && p.taxableValue > 0;
  if (hasTax && Math.abs(p.taxableValue - b.taxableValue) > tol) return false;
  // Date: normalise before comparing
  const pd = normaliseDateStr(p.invoiceDate), bd = normaliseDateStr(b.invoiceDate);
  if (pd && bd && !dateMatches(p.invoiceDate, b.invoiceDate)) return false;
  const ps1 = (p.placeOfSupply||'').trim().toUpperCase().replace(/^\d{1,2}-/, '');
  const ps2 = (b.placeOfSupply||'').trim().toUpperCase().replace(/^\d{1,2}-/, '');
  if (ps1 && ps2 && ps1 !== ps2) return false;
  return true;
}

/**
 * Count how many fields differ between a portal and books invoice pair.
 * Returns { count, fields[], rcMismatch }
 */
function countMismatchFields(p, b) {
  const tol = smartTolerance(p.invoiceValue, b.invoiceValue);
  const fields = [];
  if (Math.abs(p.invoiceValue - b.invoiceValue) > tol)  fields.push('Invoice Value');
  const ptax = p.igst + p.cgst + p.sgst;
  const btax = b.igst + b.cgst + b.sgst;
  if (Math.abs(ptax - btax) > tol)                       fields.push('Total Tax');
  if (Math.abs(p.igst - b.igst) > tol)                  fields.push('IGST');
  if (Math.abs(p.cgst - b.cgst) > tol)                  fields.push('CGST');
  if (Math.abs(p.sgst - b.sgst) > tol)                  fields.push('SGST');
  // Taxable value: only compare when both sides have it (books often omit)
  if (p.taxableValue > 0 && b.taxableValue > 0 &&
      Math.abs(p.taxableValue - b.taxableValue) > tol)  fields.push('Taxable Value');
  // Dates: normalise before comparing
  const pd = normaliseDateStr(p.invoiceDate), bd = normaliseDateStr(b.invoiceDate);
  if (pd && bd && !dateMatches(p.invoiceDate, b.invoiceDate)) fields.push('Invoice Date');
  const ps = (p.placeOfSupply||'').trim().toUpperCase().replace(/^\d+-/,'');
  const bs = (b.placeOfSupply||'').trim().toUpperCase().replace(/^\d+-/,'');
  if (ps && bs && ps !== bs)                             fields.push('Place of Supply');
  const rcMismatch = !!(
    p.reverseCharge && b.reverseCharge &&
    p.reverseCharge.toUpperCase() !== b.reverseCharge.toUpperCase()
  );
  return { count: fields.length, fields, rcMismatch };
}

function reconcile(portalData, booksData) {
  // Reset & record raw date formats encountered (powers Date Format Log panel)
  clearDateFormatLog();
  portalData.forEach(r => recordDateFormat(r.invoiceDate, 'Portal'));
  booksData .forEach(r => recordDateFormat(r.invoiceDate, 'Books'));
  // Detect duplicates BEFORE deduplication so we can surface them in the UI
  const portalDupes = detectDuplicates(portalData);
  const booksDupes  = detectDuplicates(booksData);

  const pm = new Map(), bm = new Map();
  portalData.forEach(inv => { const k = `${inv.gstin}__${inv.invoiceNo}`; if (!pm.has(k)) pm.set(k, inv); });
  booksData.forEach(inv  => { const k = `${inv.gstin}__${inv.invoiceNo}`; if (!bm.has(k)) bm.set(k, inv); });

  const matched = [], mismatch = [], checkOne = [];
  const bUsed = new Set();

  // ── PASS 1: Exact key match (gstin + normalised invoice no) ──────────────
  pm.forEach((p, key) => {
    if (bm.has(key)) {
      bUsed.add(key);
      const b = bm.get(key);
      const { count, fields, rcMismatch } = countMismatchFields(p, b);
      const normalizedMatch = p.invoiceNoRaw !== b.invoiceNoRaw;
      if (count === 0) {
        matched.push({ portal: p, books: b, key, rcMismatch, normalizedMatch,
                       isCreditNote: p.invoiceValue < 0 });
      } else {
        const { reason, suggestion, severity } = detectMismatchReason(p, b);
        mismatch.push({
          portal: p, books: b, key,
          mismatchFields: fields, mismatchCount: count,
          rcMismatch, normalizedMatch,
          valueDiff: p.invoiceValue - b.invoiceValue,
          taxDiff: (p.igst+p.cgst+p.sgst)-(b.igst+b.cgst+b.sgst),
          mismatchReason: reason, suggestedAction: suggestion, severity,
          isCreditNote: p.invoiceValue < 0,
        });
      }
    }
  });

  // ── PASS 2: Prefix-only match ─────────────────────────────────────────────
  const portalUnmatched1 = [], booksOnlyRaw = [];
  pm.forEach((p, key) => { if (!bm.has(key)) portalUnmatched1.push({ portal: p, key }); });
  bm.forEach((b, key)  => { if (!pm.has(key)) booksOnlyRaw.push({ books: b, key }); });

  const booksOnlyUsed = new Set();
  const portalAfterPass2 = [];

  portalUnmatched1.forEach(po => {
    let found = null;
    for (const bo of booksOnlyRaw) {
      if (booksOnlyUsed.has(bo.key)) continue;
      if (isPrefixOnlyMismatch(po.portal, bo.books)) { found = bo; break; }
    }
    if (found) {
      booksOnlyUsed.add(found.key);
      const p = po.portal, b = found.books;
      const { count, fields, rcMismatch } = countMismatchFields(p, b);
      const allMatch = count === 0;
      const { reason, suggestion, severity } = detectMismatchReason(p, b);
      checkOne.push({
        portal: p, books: b, key: po.key,
        prefixMismatch: true,
        portalInvRaw: p.invoiceNoRaw, booksInvRaw: b.invoiceNoRaw,
        allOtherMatch: allMatch, rcMismatch,
        mismatchFields: allMatch ? ['Invoice No (prefix only)'] : ['Invoice No (prefix)', ...fields],
        mismatchCount:  allMatch ? 1 : count + 1,
        valueDiff: p.invoiceValue - b.invoiceValue,
        taxDiff: (p.igst+p.cgst+p.sgst)-(b.igst+b.cgst+b.sgst),
        mismatchReason: allMatch ? 'Invoice number prefix differs (numeric part identical)' : reason,
        suggestedAction: allMatch ? 'Verify this is the same invoice — prefix difference may be ERP formatting' : suggestion,
        severity: allMatch ? 'low' : severity,
        isCreditNote: p.invoiceValue < 0,
      });
    } else {
      portalAfterPass2.push(po);
    }
  });

  const booksAfterPass2 = booksOnlyRaw.filter(bo => !booksOnlyUsed.has(bo.key));

  // ── PASS 3: Value + GSTIN match ────────────────────────────────────────────
  // For remaining unmatched: same GSTIN, invoice value within smart tolerance,
  // at least one of dates or tax matches. Handles ERP prefix schemes where
  // normaliseInvoice can't recover the serial (e.g. "A-2024-0635" vs "635").
  const booksAfterPass3Used = new Set();
  const portalAfterPass3 = [];

  // Build a per-GSTIN index of unmatched books invoices for fast lookup
  const booksGstinIndex = new Map();
  booksAfterPass2.forEach(bo => {
    const g = bo.books.gstin;
    if (!booksGstinIndex.has(g)) booksGstinIndex.set(g, []);
    booksGstinIndex.get(g).push(bo);
  });

  portalAfterPass2.forEach(po => {
    const candidates = booksGstinIndex.get(po.portal.gstin) || [];
    let best = null, bestScore = Infinity;
    for (const bo of candidates) {
      if (booksAfterPass3Used.has(bo.key)) continue;
      const tol = smartTolerance(po.portal.invoiceValue, bo.books.invoiceValue);
      const vd  = Math.abs(po.portal.invoiceValue - bo.books.invoiceValue);
      if (vd > tol) continue;
      // At least tax OR date must also agree to avoid false positives
      const taxD = Math.abs((po.portal.igst+po.portal.cgst+po.portal.sgst) -
                             (bo.books.igst+bo.books.cgst+bo.books.sgst));
      const pd = normaliseDateStr(po.portal.invoiceDate), bd = normaliseDateStr(bo.books.invoiceDate);
      const dateMatch = pd && bd && dateMatches(po.portal.invoiceDate, bo.books.invoiceDate);
      const taxMatch  = taxD <= tol;
      if (!dateMatch && !taxMatch) continue;
      // Pick the closest value match
      if (vd < bestScore) { best = bo; bestScore = vd; }
    }
    if (best) {
      booksAfterPass3Used.add(best.key);
      const p = po.portal, b = best.books;
      const { count, fields, rcMismatch } = countMismatchFields(p, b);
      const { reason, suggestion, severity } = detectMismatchReason(p, b);
      // Route to mismatch (not matched) because invoice numbers differ
      mismatch.push({
        portal: p, books: b, key: po.key,
        prefixMismatch: false, valueGstinMatch: true,
        mismatchFields: ['Invoice No', ...fields],
        mismatchCount: 1 + count, rcMismatch,
        normalizedMatch: false,
        valueDiff: p.invoiceValue - b.invoiceValue,
        taxDiff: (p.igst+p.cgst+p.sgst)-(b.igst+b.cgst+b.sgst),
        mismatchReason: 'Invoice numbers differ — matched by GSTIN + value',
        suggestedAction: 'Confirm this is the same invoice. Invoice number format differs between portal and books.',
        severity: count === 0 ? 'low' : severity,
        isCreditNote: p.invoiceValue < 0,
      });
    } else {
      portalAfterPass3.push(po);
    }
  });

  const booksOnlyFinal = booksAfterPass2.filter(bo => !booksAfterPass3Used.has(bo.key));

  // ── PASS 4: Near-GSTIN typo detection ─────────────────────────────────────
  // Flag portal-only invoices where a books-only invoice has a 1-char GSTIN
  // difference AND same invoice number AND same value. Surfaces data-entry errors.
  const portalOnlyFinal = [];
  portalAfterPass3.forEach(po => {
    const pInvNo = po.portal.invoiceNo;
    const pVal   = po.portal.invoiceValue;
    let typoMatch = null;
    for (const bo of booksOnlyFinal) {
      if (bo.books.invoiceNo !== pInvNo) continue;
      if (Math.abs(bo.books.invoiceValue - pVal) > smartTolerance(pVal, bo.books.invoiceValue)) continue;
      if (levenshtein(po.portal.gstin, bo.books.gstin) === 1) { typoMatch = bo; break; }
    }
    if (typoMatch) {
      portalOnlyFinal.push({
        ...po,
        possibleGstinTypo: true,
        typoCandidate: typoMatch.books.gstin,
        typoNote: `Possible GSTIN typo in books: portal ${po.portal.gstin} vs books ${typoMatch.books.gstin}`,
      });
    } else {
      portalOnlyFinal.push(po);
    }
  });

  // ── PASS 5: Cross-GSTIN Detection ─────────────────────────────────────────
  // Finds invoices where normalised invoice number + value match between portal
  // and books, but GSTINs are COMPLETELY different.
  //
  // Strategy:
  //   1. Build an invoice-number → books[] index for O(1) lookup.
  //   2. For each remaining portal-only item, find the best-scoring books-only
  //      partner (same invoice number + value within tolerance; prefer tax match).
  //   3. Mark both partners with crossGstinCandidate so the Compare tab can pair
  //      them, and collect them into a dedicated crossGstin[] array.
  //   4. Items REMAIN in portalOnly / booksOnly (not removed) because the GSTIN
  //      mismatch is still an actionable discrepancy that needs resolution.
  //   5. Additionally add them to the mismatch array with crossGstinMismatch flag
  //      so they surface in the main reconciliation view with a high-severity badge.
  // ─────────────────────────────────────────────────────────────────────────────
  const cgPortalUsed = new Set();
  const cgBooksUsed  = new Set();
  const crossGstinPairs = [];

  // Build per-invoice-number index of all booksOnly items for fast lookup
  const booksInvNumIdx = new Map();
  booksOnlyFinal.forEach(bo => {
    // Index both normalised and raw to catch prefix variations
    const num = bo.books.invoiceNo;
    if (!num) return;
    if (!booksInvNumIdx.has(num)) booksInvNumIdx.set(num, []);
    booksInvNumIdx.get(num).push(bo);
  });

  // Also build a value-keyed index for secondary matching
  const booksValIdx = new Map();
  booksOnlyFinal.forEach(bo => {
    // Round to avoid float key issues — use integer paise
    const key = Math.round((bo.books.invoiceValue || 0) * 100);
    if (!booksValIdx.has(key)) booksValIdx.set(key, []);
    booksValIdx.get(key).push(bo);
  });

  portalOnlyFinal.forEach(po => {
    if (cgPortalUsed.has(po.key)) return;
    const pNum = po.portal.invoiceNo;
    const pVal = po.portal.invoiceValue || 0;
    const pTax = (po.portal.igst||0) + (po.portal.cgst||0) + (po.portal.sgst||0);

    let bestMatch = null;
    let bestScore = Infinity;

    // Primary: same normalised invoice number, any GSTIN
    const numCandidates = booksInvNumIdx.get(pNum) || [];
    for (const bo of numCandidates) {
      if (cgBooksUsed.has(bo.key)) continue;
      if (bo.books.gstin === po.portal.gstin) continue; // exact-GSTIN handled earlier
      const bVal = bo.books.invoiceValue || 0;
      const tol  = smartTolerance(pVal, bVal);
      const vd   = Math.abs(pVal - bVal);
      if (vd > tol) continue;                           // value must match
      const bTax = (bo.books.igst||0) + (bo.books.cgst||0) + (bo.books.sgst||0);
      const taxD = Math.abs(pTax - bTax);
      const score = vd * 10 + taxD;                     // weight value diff more
      if (score < bestScore) { bestMatch = bo; bestScore = score; }
    }

    // Secondary: same value (within 0.5%), different invoice number allowed
    // Only if primary found nothing — this catches ERP invoice format differences
    if (!bestMatch) {
      const pKey = Math.round(pVal * 100);
      // Check a ±1 paise window to handle rounding
      for (const delta of [0, 1, -1, 2, -2]) {
        const candidates = booksValIdx.get(pKey + delta) || [];
        for (const bo of candidates) {
          if (cgBooksUsed.has(bo.key)) continue;
          if (bo.books.gstin === po.portal.gstin) continue;
          const bVal = bo.books.invoiceValue || 0;
          const tol  = smartTolerance(pVal, bVal);
          if (Math.abs(pVal - bVal) > tol) continue;
          const bTax = (bo.books.igst||0) + (bo.books.cgst||0) + (bo.books.sgst||0);
          const taxD = Math.abs(pTax - bTax);
          if (taxD > tol) continue;                     // secondary: tax MUST also match
          // Date must also match as a tie-breaker for safety
          const pd = normaliseDateStr(po.portal.invoiceDate);
          const bd = normaliseDateStr(bo.books.invoiceDate);
          if (pd && bd && !dateMatches(po.portal.invoiceDate, bo.books.invoiceDate)) continue;
          const score = taxD * 10 + 1000;               // penalty for no invoice-no match
          if (score < bestScore) { bestMatch = bo; bestScore = score; }
        }
        if (bestMatch) break;
      }
    }

    if (!bestMatch) return;

    cgPortalUsed.add(po.key);
    cgBooksUsed.add(bestMatch.key);

    // Annotate both wrapper objects so ResultTable can show warning badges
    po.crossGstinCandidate       = true;
    po.crossGstinPartnerGstin    = bestMatch.books.gstin;
    po.crossGstinPartnerInv      = bestMatch.books.invoiceNoRaw || bestMatch.books.invoiceNo;
    bestMatch.crossGstinCandidate    = true;
    bestMatch.crossGstinPartnerGstin = po.portal.gstin;
    bestMatch.crossGstinPartnerInv   = po.portal.invoiceNoRaw || po.portal.invoiceNo;

    const vd  = Math.abs(pVal - (bestMatch.books.invoiceValue || 0));
    const pTaxF = (po.portal.igst||0) + (po.portal.cgst||0) + (po.portal.sgst||0);
    const bTaxF = (bestMatch.books.igst||0) + (bestMatch.books.cgst||0) + (bestMatch.books.sgst||0);
    const taxDf = Math.abs(pTaxF - bTaxF);
    const valuesIdentical = vd < 0.01 && taxDf < 0.01;

    crossGstinPairs.push({
      portal:            po,        // full wrapper { portal:{...}, key:'...' }
      books:             bestMatch, // full wrapper { books:{...}, key:'...' }
      key:               po.key,
      crossGstinMismatch: true,
      portalGstin:       po.portal.gstin,
      booksGstin:        bestMatch.books.gstin,
      valueDiff:         vd,
      taxDiff:           taxDf,
      valuesIdentical,
      status:            'gstin_mismatch',
      mismatchReason:    `GSTIN mismatch: Portal GSTIN ${po.portal.gstin} ≠ Books GSTIN ${bestMatch.books.gstin}. Invoice number and value ${valuesIdentical ? 'are identical' : 'match within tolerance'} — very likely the same bill.`,
      suggestedAction:   'Check with vendor which GSTIN is correct. Update books if portal GSTIN is right. This directly affects ITC eligibility.',
      severity:          'high',
    });
  });

  // ── Merge pass 2 results ────────────────────────────────────────────────────
  const matchedFinal = [
    ...matched,
    ...checkOne.filter(c => c.allOtherMatch).map(c => ({ ...c, prefixMismatch: true })),
  ];
  const mismatchFinal = [
    ...mismatch,
    ...checkOne.filter(c => !c.allOtherMatch),
  ];

  return {
    matched:    matchedFinal,
    mismatch:   mismatchFinal,
    portalOnly: portalOnlyFinal,
    booksOnly:  booksOnlyFinal,
    crossGstin: crossGstinPairs,
    portalDupes,   // Map of key → count for duplicate invoices in portal data
    booksDupes,    // Map of key → count for duplicate invoices in books data
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   FORMAT HELPERS
═══════════════════════════════════════════════════════════════════════════ */
const fmt = n => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const sumVal = (arr, src) => arr.reduce((s, r) => s + (r[src]?.invoiceValue || 0), 0);
const sumTax = (arr, src) => arr.reduce((s, r) => { const i = r[src]; return s + (i ? i.igst+i.cgst+i.sgst : 0); }, 0);

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT FUNCTIONS — Fixed PDF, Word, Excel
   Drop-in replacements for the three export functions in GSTReconciliation.jsx
   ─────────────────────────────────────────────────────────────────────────
   HOW TO USE:
   1. Open GSTReconciliation.jsx
   2. Find the existing exportPDF function (search: "function exportPDF")
   3. Replace everything from "function exportPDF" through the end of
      "function exportExcel" (including all three functions) with this file.
   4. Save. All three exports now produce clean, professional output.
═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   PDF EXPORT v3 — Professional landscape layout
   ─────────────────────────────────────────────────────────────────────────
   Fixes vs the original:
   • tableWidth always = TW (277 mm) — no column bleeds past page edge
   • columnStyles widths calculated to sum EXACTLY to TW for every table
   • overflow:'linebreak' on every cell — text wraps; no clipping
   • Mismatch page includes root-cause reason column (wraps freely)
   • didParseCell colours diff cells red/blue without breaking layout
   • Consistent header + footer on every page via didDrawPage callback
   • Cover redesigned: gradient band, 6 stat cards, clean summary table
═══════════════════════════════════════════════════════════════════════════ */
async function exportPDF(results, company, period, manualTradeNames = {}, invoiceComments = {}) {
  jsPDF = await getJsPDF();
  autoTable = await getAutoTable();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  // ── Page geometry ──────────────────────────────────────────────────────
  const W  = doc.internal.pageSize.getWidth();   // 297 mm
  const H  = doc.internal.pageSize.getHeight();  // 210 mm
  const ML = 13, MR = 13;
  const TW = W - ML - MR;                        // 271 mm usable

  // ── Brand palette ──────────────────────────────────────────────────────
  const BRAND  = [13,  59, 102];
  const BRAND2 = [31, 111, 178];
  const GREEN  = [16, 150,  90];
  const AMBER  = [180, 110,   0];
  const BLUE   = [37,  99, 200];
  const ROSE   = [185,  28,  28];
  const LGRAY  = [248, 250, 252];
  const GRAY   = [100, 116, 139];
  const DGRAY  = [22,  30,  46];
  const WHITE  = [255, 255, 255];

  const dateStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  // ── Footer (called on every page) ─────────────────────────────────────
  function addFooter() {
    const totalPages = doc.internal.getNumberOfPages();
    const curPage    = doc.internal.getCurrentPageInfo().pageNumber;
    doc.setFillColor(240, 244, 248);
    doc.rect(0, H - 8, W, 8, 'F');
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Confidential — GST Reconciliation Report', ML, H - 3);
    doc.text(`Page ${curPage} of ${totalPages}`, W / 2, H - 3, { align: 'center' });
    doc.text(company.name || '', W - MR, H - 3, { align: 'right' });
  }

  // ── Slim page header (pages 2+) ────────────────────────────────────────
  function addPageHeader(color, sectionTitle) {
    const hH = 16;
    doc.setFillColor(...(color || BRAND));
    doc.rect(0, 0, W, hH, 'F');
    doc.setTextColor(...WHITE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('GST RECONCILIATION REPORT', ML, 7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(company.name || '', ML, 12.5);
    doc.setFontSize(8.5);
    doc.text(sectionTitle || '', W / 2, 9.5, { align: 'center' });
    doc.setFontSize(8);
    doc.text(period || '', W - MR, 7, { align: 'right' });
    doc.text(`GSTIN: ${company.gstin || 'N/A'}`, W - MR, 12.5, { align: 'right' });
    doc.setTextColor(...DGRAY);
    return hH + 3; // return Y after header
  }

  // ── Coloured section heading bar ──────────────────────────────────────
  function sectionHeading(y, text, color, count, value) {
    const hH = 7;
    doc.setFillColor(...(color || BRAND));
    doc.roundedRect(ML, y, TW, hH, 1.2, 1.2, 'F');
    doc.setTextColor(...WHITE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(text, ML + 2.5, y + 4.8);
    if (count !== undefined) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(
        `${count} invoice${count !== 1 ? 's' : ''}  |  Rs.${fmt(value)}`,
        W - MR - 2, y + 4.8, { align: 'right' }
      );
    }
    doc.setTextColor(...DGRAY);
    return y + hH + 2;
  }

  // ── Blocked ITC (Section 17(5) CGST Act) — HSN/SAC detection ─────────
  const BLOCKED_HSN4 = new Set([
    '8703','8711',                          // Motor cars, motorcycles
    '6802','6907','7324','6910',            // Marble/granite, tiles, sanitary ware
    '2523',                                 // Cement
    '8415','8428',                          // AC, elevators (capitalized)
  ]);
  const BLOCKED_CHAPTERS = new Set([
    '87','88','89',                         // Vehicles, aircraft, ships
    '72','73',                              // Iron/steel (TMT bars, iron items)
    '70','32','94',                         // Glass, paints, furniture
  ]);
  const BLOCKED_SAC = [
    '998714','998713','997133',             // Vehicle service/repair/insurance
    '996331','996333',                      // Restaurant, catering
    '999721','999722','999723',             // Beauty, cosmetic, salon, gym
    '9993','999312',                        // Health services, health check-up
    '999599',                              // Club membership
    '9985','998552',                        // Travel/vacation, LTC
    '9963','9972',                          // Celebration, guest house
    '996411','9964','998551',              // Rent-a-cab, passenger transport, air travel
    '9954','995411','995412',              // Works contract, construction
  ];

  function isBlockedHSN(hsn) {
    if (!hsn) return false;
    const h = String(hsn).trim().replace(/[\s\-\.]/g, '');
    if (!h || h.length < 2) return false;
    if (BLOCKED_CHAPTERS.has(h.substring(0, 2))) return true;
    if (h.length >= 4 && BLOCKED_HSN4.has(h.substring(0, 4))) return true;
    return BLOCKED_SAC.some(s => h.startsWith(s) || s.startsWith(h.substring(0, 6)));
  }

  function itcFlag(r) {
    return (r?.portal?.itcAvailability || r?.books?.itcAvailability || '').trim().toUpperCase();
  }

  function isIneligible(r) {
    const flag = itcFlag(r);
    if (flag === 'N' || flag === 'INELIGIBLE' || flag === 'BLOCKED') return true;
    const hsn = r?.books?.hsn || r?.portal?.hsn || '';
    return isBlockedHSN(hsn);
  }

  function ineligibleReason(r) {
    const flag = itcFlag(r);
    if (flag === 'N' || flag === 'INELIGIBLE' || flag === 'BLOCKED')
      return 'ITC marked Ineligible (N) by GST Portal — Section 17(5) applies.';
    const hsn = r?.books?.hsn || r?.portal?.hsn || '';
    if (hsn) return `HSN/SAC ${hsn} — Blocked under Section 17(5) of CGST Act.`;
    return 'Ineligible Credit — Section 17(5) of CGST Act.';
  }

  const INELIGIBLE_FILL = [255, 235, 235];   // light red for ineligible rows
  const INELIGIBLE_RED  = [185,  28,  28];   // dark red text

  function willDrawCellHighlight(data, rows) {
    if (data.section !== 'body') return;
    const r = rows[data.row.index];
    if (r && isIneligible(r)) {
      data.cell.styles.fillColor  = INELIGIBLE_FILL;
      data.cell.styles.textColor  = INELIGIBLE_RED;
      data.cell.styles.fontStyle  = 'bold';
    }
  }

  // ── Shared autoTable base config ──────────────────────────────────────
  // CRITICAL: tableWidth:TW forces the table to exactly fill usable width.
  // columnStyles widths must sum to TW for each table.
  const BASE = {
    styles: {
      font: 'helvetica',
      fontSize: 7,
      overflow: 'linebreak',   // cells grow vertically; text never clips
      cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 },
      lineColor: [210, 220, 232],
      lineWidth: 0.22,
      valign: 'middle',
      textColor: DGRAY,
    },
    headStyles: {
      font: 'helvetica',
      fontStyle: 'bold',
      fontSize: 7.8,
      textColor: WHITE,
      halign: 'center',
      valign: 'middle',
      minCellHeight: 9,
      cellPadding: { top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 },
      lineWidth: 0.25,
    },
    alternateRowStyles: { fillColor: LGRAY },
    margin: { left: ML, right: MR, top: 22, bottom: 12 },
    tableWidth: TW,            // ← always fills exactly 277 mm
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    theme: 'grid',
    didDrawPage: () => addFooter(),
  };

  /* ─────────────────────────────────────────────────────────────────────
     PAGE 1 — COVER
  ───────────────────────────────────────────────────────────────────── */
  // Gradient band
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, W, 38, 'F');
  doc.setFillColor(...BRAND2);
  doc.triangle(W - 90, 0, W, 0, W, 38, 'F');

  doc.setTextColor(...WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('GST Reconciliation Report', ML + 2, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text(company.name || 'Company Name', ML + 2, 25);
  doc.setFontSize(8);
  const metaLine = [
    company.gstin ? `GSTIN: ${company.gstin}` : null,
    period        ? `Period: ${period}`         : null,
    company.fy    ? `FY: ${company.fy}`         : null,
    `Generated: ${dateStr}`,
  ].filter(Boolean).join('  |  ');
  doc.text(metaLine, ML + 2, 33);
  doc.setTextColor(...DGRAY);

  // Stat cards — 6 cards, equal width, sum = TW
  const totalPortal = results.matched.length + results.mismatch.length + results.portalOnly.length;
  const totalBooks  = results.matched.length + results.mismatch.length + results.booksOnly.length;
  const cards = [
    { label: 'Total Portal',  val: totalPortal,               color: BRAND  },
    { label: 'Total Books',   val: totalBooks,                color: BRAND2 },
    { label: 'Matched',       val: results.matched.length,    color: GREEN  },
    { label: 'Mismatch',      val: results.mismatch.length,   color: AMBER  },
    { label: 'Portal Only',   val: results.portalOnly.length, color: BLUE   },
    { label: 'Books Only',    val: results.booksOnly.length,  color: ROSE   },
  ];
  const cardGap = 2;
  const cardW   = (TW - cardGap * 5) / 6; // exactly fills TW
  const cY      = 42;
  cards.forEach((card, i) => {
    const cx = ML + i * (cardW + cardGap);
    doc.setFillColor(...card.color);
    doc.roundedRect(cx, cY, cardW, 18, 1.5, 1.5, 'F');
    doc.setTextColor(...WHITE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.text(String(card.val), cx + cardW / 2, cY + 9.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.text(card.label, cx + cardW / 2, cY + 15.5, { align: 'center' });
  });
  doc.setTextColor(...DGRAY);

  // Tax summary table on cover
  // Col widths: 44+14+40+40+28+28+28+55 = 277 ✓
  let tableY = cY + 22;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Tax Summary', ML, tableY);
  tableY += 3;

  autoTable(doc, {
    ...BASE,
    startY: tableY,
    head: [['Category', 'Count', 'Invoice Value (Rs)', 'Taxable Value (Rs)', 'IGST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Total Tax (Rs)']],
    body: [
      ['Matched',
        results.matched.length,
        fmt(sumVal(results.matched, 'portal')),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.matched, 'portal'))],
      ['Amount Mismatch',
        results.mismatch.length,
        fmt(sumVal(results.mismatch, 'portal')),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.mismatch, 'portal'))],
      ['In Portal Only',
        results.portalOnly.length,
        fmt(sumVal(results.portalOnly, 'portal')),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.portalOnly, 'portal'))],
      ['In Books Only',
        results.booksOnly.length,
        fmt(sumVal(results.booksOnly, 'books')),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.taxableValue || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.igst || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.cgst || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.sgst || 0), 0)),
        fmt(sumTax(results.booksOnly, 'books'))],
    ],
    headStyles: { ...BASE.headStyles, fillColor: BRAND },
    columnStyles: {
      0: { cellWidth: 44, halign: 'left'   },
      1: { cellWidth: 14, halign: 'center' },
      2: { cellWidth: 40, halign: 'right'  },
      3: { cellWidth: 40, halign: 'right'  },
      4: { cellWidth: 28, halign: 'right'  },
      5: { cellWidth: 28, halign: 'right'  },
      6: { cellWidth: 28, halign: 'right'  },
      7: { cellWidth: 49, halign: 'right'  },
    },
  });

  addFooter(); // cover page footer (autoTable overwrites it via didDrawPage)

  /* ─────────────────────────────────────────────────────────────────────
     PAGE 2 — IN PORTAL ONLY
     Col widths: 8+36+38+26+20+26+22+18+18+18+24+23 = 277 ✓
  ───────────────────────────────────────────────────────────────────── */
  if (results.portalOnly.length > 0) {
    doc.addPage('landscape');
    let y = addPageHeader(BLUE, 'In GST Portal Only');
    y = sectionHeading(
      y,
      'In GST Portal Only — Not in Books.  Book these invoices to avail ITC.',
      BLUE, results.portalOnly.length, sumVal(results.portalOnly, 'portal')
    );

    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'GSTIN', 'Party Name', 'Invoice No', 'Date', 'Value (Rs)', 'Taxable (Rs)', 'IGST', 'CGST', 'SGST', 'Place of Supply', 'ITC']],
      body: results.portalOnly.map((r, i) => {
        const inv = r.portal;
        return [
          i + 1,
          inv?.gstin || '—',
          inv?.tradeOrLegalName || manualTradeNames?.[inv?.gstin] || '—',
          inv?.invoiceNoRaw || '—',
          inv?.invoiceDate  || '—',
          fmt(inv?.invoiceValue  || 0),
          fmt(inv?.taxableValue  || 0),
          fmt(inv?.igst          || 0),
          fmt(inv?.cgst          || 0),
          fmt(inv?.sgst          || 0),
          inv?.placeOfSupply     || '—',
          inv?.itcAvailability   || '—',
        ];
      }),
      headStyles: { ...BASE.headStyles, fillColor: BLUE },
      columnStyles: {
        0:  { cellWidth:  8, halign: 'center' },
        1:  { cellWidth: 36, halign: 'left'   },
        2:  { cellWidth: 35, halign: 'left'   },
        3:  { cellWidth: 26, halign: 'left'   },
        4:  { cellWidth: 20, halign: 'center' },
        5:  { cellWidth: 26, halign: 'right'  },
        6:  { cellWidth: 22, halign: 'right'  },
        7:  { cellWidth: 18, halign: 'right'  },
        8:  { cellWidth: 18, halign: 'right'  },
        9:  { cellWidth: 18, halign: 'right'  },
        10: { cellWidth: 24, halign: 'left'   },
        11: { cellWidth: 20, halign: 'center' },
      },
      willDrawCell(data) { willDrawCellHighlight(data, results.portalOnly); },
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     PAGE 3 — IN BOOKS ONLY
     Col widths: 8+36+42+28+20+28+24+20+20+20+31 = 277 ✓
  ───────────────────────────────────────────────────────────────────── */
  if (results.booksOnly.length > 0) {
    doc.addPage('landscape');
    let y = addPageHeader(ROSE, 'In Books Only — ITC at Risk');
    y = sectionHeading(
      y,
      'In Books Only — Vendor has NOT filed on Portal.  ITC at Risk — follow up with vendor immediately!',
      ROSE, results.booksOnly.length, sumVal(results.booksOnly, 'books')
    );

    // Risk banner
    doc.setFillColor(255, 235, 235);
    doc.setDrawColor(...ROSE);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, TW, 7.5, 1, 1, 'FD');
    doc.setLineWidth(0.15);
    doc.setTextColor(...ROSE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(
      '[!] ITC RISK: These invoices are in your books but vendor has NOT filed on GST Portal. ' +
      'You cannot claim ITC until the vendor files GSTR-1. Follow up immediately.',
      ML + 3, y + 5
    );
    doc.setTextColor(...DGRAY);
    y += 10;

    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'GSTIN', 'Party Name', 'Invoice No', 'Date', 'Value (Rs)', 'Taxable (Rs)', 'IGST', 'CGST', 'SGST', 'Place of Supply']],
      body: results.booksOnly.map((r, i) => {
        const inv    = r.books;
        const bgstin = (inv?.gstin || '').toUpperCase();
        return [
          i + 1,
          bgstin,
          inv?.tradeOrLegalName || manualTradeNames?.[bgstin] || manualTradeNames?.[inv?.gstin] || '—',
          inv?.invoiceNoRaw || '—',
          inv?.invoiceDate  || '—',
          fmt(inv?.invoiceValue  || 0),
          fmt(inv?.taxableValue  || 0),
          fmt(inv?.igst          || 0),
          fmt(inv?.cgst          || 0),
          fmt(inv?.sgst          || 0),
          inv?.placeOfSupply     || '—',
        ];
      }),
      headStyles: { ...BASE.headStyles, fillColor: ROSE },
      columnStyles: {
        0:  { cellWidth:  8, halign: 'center' },
        1:  { cellWidth: 36, halign: 'left'   },
        2:  { cellWidth: 38, halign: 'left'   },
        3:  { cellWidth: 28, halign: 'left'   },
        4:  { cellWidth: 20, halign: 'center' },
        5:  { cellWidth: 28, halign: 'right'  },
        6:  { cellWidth: 24, halign: 'right'  },
        7:  { cellWidth: 20, halign: 'right'  },
        8:  { cellWidth: 20, halign: 'right'  },
        9:  { cellWidth: 20, halign: 'right'  },
        10: { cellWidth: 29, halign: 'left'   },
      },
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     PAGE 4 — AMOUNT MISMATCH
     10 cols — widths: 6+26+30+22+16+22+22+18+18+91 = 271 ✓
     P.Tax / B.Tax merged into Tax Diff to free space for Reason column.
  ───────────────────────────────────────────────────────────────────── */
  if (results.mismatch.length > 0) {
    doc.addPage('landscape');
    let y = addPageHeader(AMBER, 'Amount Mismatch');
    y = sectionHeading(
      y,
      'Amount Mismatch — Invoice numbers match but values or tax differ between Portal and Books',
      AMBER, results.mismatch.length, sumVal(results.mismatch, 'portal')
    );

    const mismatchRows = results.mismatch;
    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'GSTIN', 'Party Name', 'Invoice No', 'Date', 'Portal Rs', 'Books Rs', 'Diff Rs', 'Tax Diff', 'Reason & Suggested Action']],
      body: mismatchRows.map((r, i) => {
        const pTax  = (r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0);
        const bTax  = (r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0);
        const tDiff = pTax - bTax;
        const vDiff = (r.valueDiff || 0);
        const inelig = isIneligible(r) ? ' [INELIGIBLE ITC - Sec 17(5)]' : '';
        const reason = [
          r.mismatchReason,
          r.suggestedAction ? `>> ${r.suggestedAction}` : '',
          inelig,
        ].filter(Boolean).join(' ');
        return [
          i + 1,
          r.portal?.gstin || '—',
          r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || '—',
          r.portal?.invoiceNoRaw || '—',
          r.portal?.invoiceDate  || '—',
          fmt(r.portal?.invoiceValue || 0),
          fmt(r.books?.invoiceValue  || 0),
          (vDiff >= 0 ? '+' : '') + fmt(vDiff),
          (tDiff >= 0 ? '+' : '') + fmt(tDiff),
          reason || '—',
        ];
      }),
      headStyles: { ...BASE.headStyles, fillColor: AMBER },
      columnStyles: {
        0: { cellWidth:  6, halign: 'center' },
        1: { cellWidth: 26, halign: 'left',  fontSize: 6.5 },
        2: { cellWidth: 30, halign: 'left'   },
        3: { cellWidth: 22, halign: 'left'   },
        4: { cellWidth: 16, halign: 'center' },
        5: { cellWidth: 22, halign: 'right'  },
        6: { cellWidth: 22, halign: 'right'  },
        7: { cellWidth: 18, halign: 'right'  },
        8: { cellWidth: 18, halign: 'right'  },
        9: { cellWidth: 91, halign: 'left',  fontSize: 6.5, overflow: 'linebreak' },
      },
      willDrawCell(data) { willDrawCellHighlight(data, mismatchRows); },
      didParseCell(data) {
        if (data.section !== 'body') return;
        if (data.column.index === 7 || data.column.index === 8) {
          const raw = Array.isArray(data.cell.text) ? data.cell.text.join('') : String(data.cell.text || '');
          if (!isIneligible(mismatchRows[data.row.index])) {
            data.cell.styles.textColor = raw.trim().startsWith('-') ? ROSE : BLUE;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });
  }


  /* ─────────────────────────────────────────────────────────────────────
     PAGE 5 — GSTIN CONFLICT
     Cols 0-8: 8+30+30+26+22+18+22+22+18 = 196; col 9 auto fills 75mm
  ───────────────────────────────────────────────────────────────────── */
  const ORANGE = [194, 65, 12];
  if ((results.crossGstin || []).length > 0) {
    doc.addPage('landscape');
    let y = addPageHeader(ORANGE, 'GSTIN Conflict');
    y = sectionHeading(
      y,
      'GSTIN Conflict — Same invoice & value found in BOTH Portal and Books under DIFFERENT GSTINs. Verify GSTIN with vendor.',
      ORANGE, results.crossGstin.length,
      results.crossGstin.reduce((s, r) => s + (r.portal?.portal?.invoiceValue || 0), 0)
    );

    // Critical warning banner
    doc.setFillColor(255, 237, 213);
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, TW, 8, 1, 1, 'FD');
    doc.setLineWidth(0.15);
    doc.setTextColor(...ORANGE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(
      '[!] CRITICAL: ITC claim may be INVALID if the wrong GSTIN is in books. ' +
      'Verify each pair with vendor and correct books before filing GSTR-3B.',
      ML + 3, y + 5.2
    );
    doc.setTextColor(...DGRAY);
    y += 11;

    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'Portal GSTIN', 'Books GSTIN', 'Party Name', 'Invoice No', 'Date', 'Portal Rs', 'Books Rs', 'Val Diff', 'Notes & Action']],
      body: results.crossGstin.map((r, i) => {
        const p = r.portal?.portal || r.portal || {};
        const b = r.books?.books   || r.books  || {};
        const pTax = (p.igst || 0) + (p.cgst || 0) + (p.sgst || 0);
        const bTax = (b.igst || 0) + (b.cgst || 0) + (b.sgst || 0);
        const vDiff = (r.valueDiff || 0);
        const note  = r.valuesIdentical
          ? 'Values identical - likely same bill under wrong GSTIN. >> Verify GSTIN with vendor.'
          : `Values differ by Rs.${fmt(vDiff)}. Tax: Portal Rs.${fmt(pTax)} vs Books Rs.${fmt(bTax)}. >> Confirm correct GSTIN and update books.`;
        return [
          i + 1,
          r.portalGstin || p.gstin || '—',
          r.booksGstin  || b.gstin || '—',
          p.tradeOrLegalName || manualTradeNames?.[r.portalGstin] || manualTradeNames?.[r.booksGstin] || '—',
          p.invoiceNoRaw || '—',
          p.invoiceDate  || '—',
          fmt(p.invoiceValue || 0),
          fmt(b.invoiceValue || 0),
          (vDiff === 0 ? '0.00' : fmt(vDiff)),
          note,
        ];
      }),
      headStyles: { ...BASE.headStyles, fillColor: ORANGE },
      columnStyles: {
        0: { cellWidth:  8, halign: 'center' },
        1: { cellWidth: 30, halign: 'left',   fontSize: 6.5 },
        2: { cellWidth: 30, halign: 'left',   fontSize: 6.5 },
        3: { cellWidth: 26, halign: 'left'   },
        4: { cellWidth: 22, halign: 'left'   },
        5: { cellWidth: 18, halign: 'center' },
        6: { cellWidth: 22, halign: 'right'  },
        7: { cellWidth: 22, halign: 'right'  },
        8: { cellWidth: 18, halign: 'right'  },
        9: { minCellWidth: 55, halign: 'left', fontSize: 6.5, overflow: 'linebreak' },
      },
      didParseCell(data) {
        if (data.section !== 'body') return;
        // Highlight GSTIN cells to make the difference obvious
        if (data.column.index === 1) {
          data.cell.styles.textColor  = BLUE;
          data.cell.styles.fontStyle  = 'bold';
        }
        if (data.column.index === 2) {
          data.cell.styles.textColor  = ORANGE;
          data.cell.styles.fontStyle  = 'bold';
        }
      },
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     PAGE 6 — MATCHED INVOICES
     Col widths: 8+36+42+28+20+28+24+20+20+20+31 = 277 ✓
  ───────────────────────────────────────────────────────────────────── */
  if (results.matched.length > 0) {
    doc.addPage('landscape');
    let y = addPageHeader(GREEN, 'Matched Invoices');
    y = sectionHeading(
      y,
      'Matched Invoices — Present in both Portal and Books with matching values.  No action required.',
      GREEN, results.matched.length, sumVal(results.matched, 'portal')
    );

    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'GSTIN', 'Party Name', 'Invoice No', 'Date', 'Value (Rs)', 'Taxable (Rs)', 'IGST', 'CGST', 'SGST', 'Cess']],
      body: results.matched.map((r, i) => [
        i + 1,
        r.portal?.gstin || '—',
        r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || '—',
        r.portal?.invoiceNoRaw || '—',
        r.portal?.invoiceDate  || '—',
        fmt(r.portal?.invoiceValue  || 0),
        fmt(r.portal?.taxableValue  || 0),
        fmt(r.portal?.igst          || 0),
        fmt(r.portal?.cgst          || 0),
        fmt(r.portal?.sgst          || 0),
        fmt(r.portal?.cess          || 0),
      ]),
      headStyles: { ...BASE.headStyles, fillColor: GREEN },
      columnStyles: {
        0:  { cellWidth:  8, halign: 'center' },
        1:  { cellWidth: 36, halign: 'left'   },
        2:  { cellWidth: 38, halign: 'left'   },
        3:  { cellWidth: 28, halign: 'left'   },
        4:  { cellWidth: 20, halign: 'center' },
        5:  { cellWidth: 28, halign: 'right'  },
        6:  { cellWidth: 24, halign: 'right'  },
        7:  { cellWidth: 20, halign: 'right'  },
        8:  { cellWidth: 20, halign: 'right'  },
        9:  { cellWidth: 20, halign: 'right'  },
        10: { cellWidth: 29, halign: 'right'  },
      },
      willDrawCell(data) { willDrawCellHighlight(data, results.matched); },
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     INELIGIBLE ITC PAGE — Section 17(5) Blocked Credits
     Collects invoices from ALL categories where ITC is blocked by HSN/SAC
     or itcAvailability = 'N'. Rows highlighted in red.
     Cols: 6+26+30+22+16+22+20+20+20+89 = 271 ✓
  ───────────────────────────────────────────────────────────────────── */
  const allIneligible = [
    ...results.matched.filter(isIneligible).map(r => ({ ...r, _src: 'Matched' })),
    ...(results.portalOnly || []).filter(isIneligible).map(r => ({ ...r, _src: 'Portal Only' })),
    ...(results.booksOnly  || []).filter(isIneligible).map(r => ({ ...r, _src: 'Books Only'  })),
    ...(results.mismatch   || []).filter(isIneligible).map(r => ({ ...r, _src: 'Mismatch'    })),
  ];

  if (allIneligible.length > 0) {
    const BRICK = [153, 27, 27];
    doc.addPage('landscape');
    let y = addPageHeader(BRICK, 'Ineligible ITC — Section 17(5)');
    y = sectionHeading(
      y,
      'Ineligible ITC (Sec 17(5)) — These credits CANNOT be claimed. Reverse immediately to avoid GST demand + interest.',
      BRICK, allIneligible.length,
      allIneligible.reduce((s, r) => s + (r.portal?.invoiceValue || r.books?.invoiceValue || 0), 0)
    );

    // Warning banner
    doc.setFillColor(255, 235, 235);
    doc.setDrawColor(...BRICK);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, TW, 9, 1, 1, 'FD');
    doc.setLineWidth(0.15);
    doc.setTextColor(...BRICK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(
      '[!] CRITICAL: Claiming ITC on these invoices violates Section 17(5) of CGST Act 2017. ' +
      'Reverse via GSTR-3B Table 4(B)(2) to avoid interest & penalty.',
      ML + 3, y + 6
    );
    doc.setTextColor(...DGRAY);
    y += 12;

    autoTable(doc, {
      ...BASE,
      startY: y,
      head: [['#', 'GSTIN', 'Party Name', 'Invoice No', 'Date', 'Value (Rs)', 'IGST', 'CGST', 'SGST', 'Why Ineligible (Sec 17(5))', 'Source']],
      body: allIneligible.map((r, i) => {
        const inv = r.portal || r.books || {};
        const hsn = r.books?.hsn || r.portal?.hsn || '';
        const why = ineligibleReason(r);
        return [
          i + 1,
          inv.gstin || '—',
          inv.tradeOrLegalName || manualTradeNames?.[inv.gstin] || '—',
          inv.invoiceNoRaw || '—',
          inv.invoiceDate  || '—',
          fmt(inv.invoiceValue || 0),
          fmt(inv.igst || 0),
          fmt(inv.cgst || 0),
          fmt(inv.sgst || 0),
          hsn ? `HSN: ${hsn} — ${why}` : why,
          r._src || '—',
        ];
      }),
      headStyles: { ...BASE.headStyles, fillColor: BRICK },
      styles: { ...BASE.styles, fontSize: 6.5 },
      columnStyles: {
        0:  { cellWidth:  6, halign: 'center' },
        1:  { cellWidth: 26, halign: 'left',  fontSize: 6   },
        2:  { cellWidth: 28, halign: 'left'   },
        3:  { cellWidth: 20, halign: 'left'   },
        4:  { cellWidth: 15, halign: 'center' },
        5:  { cellWidth: 20, halign: 'right'  },
        6:  { cellWidth: 18, halign: 'right'  },
        7:  { cellWidth: 18, halign: 'right'  },
        8:  { cellWidth: 18, halign: 'right'  },
        9:  { cellWidth: 92, halign: 'left',  overflow: 'linebreak', fontStyle: 'bold' },
        10: { cellWidth: 10, halign: 'center', fontSize: 6  },
      },
      didParseCell(data) {
        if (data.section !== 'body') return;
        data.cell.styles.fillColor = INELIGIBLE_FILL;
        data.cell.styles.textColor = INELIGIBLE_RED;
      },
    });
  }

  // Ensure cover footer is drawn last (autoTable can overwrite it)
  doc.setPage(1);
  addFooter();

  const fname = `GST_Recon_${(company.name || 'Report').replace(/\s+/g, '_')}_${(period || 'Export').replace(/\s+/g, '_')}.pdf`;
  doc.save(fname);
  toast.success('PDF report generated successfully!');
}

/* ═══════════════════════════════════════════════════════════════════════════
   WORD (.doc) EXPORT v2 — Clean HTML-to-Word via Blob + file-saver
   ─────────────────────────────────────────────────────────────────────────
   Fixes vs original:
   • All table cells use explicit width percentages — no column overflow
   • Numeric columns are right-aligned
   • Long-text columns (Party Name, Reason) have generous width so they wrap
   • Consistent colour coding: green=matched, amber=mismatch, blue=portal,
     red=books-only
   • Mismatch table includes Severity + Root Cause + Suggested Action columns
   • Every section has a clear heading band + invoice count + total value
   • Professional cover page with company details grid
   • All ₹ amounts formatted with Indian number formatting
   • Page breaks between sections via CSS page-break-before
═══════════════════════════════════════════════════════════════════════════ */
function exportWord(results, company, period, manualTradeNames = {}, invoiceComments = {}) {
  const dateStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  // ── Helper: build a full-width HTML table ─────────────────────────────
  // headers: array of { label, width (%), align }
  // rows:    array of arrays matching headers
  // headColor: CSS hex
  const buildTable = (headers, rows, headColor = '#0D3B66') => {
    const thead = headers.map(h =>
      `<th style="
        background:${headColor};color:#fff;padding:5pt 6pt;
        border:1px solid #c8d4e0;text-align:${h.align || 'left'};
        font-weight:bold;font-size:8.5pt;white-space:nowrap;
        width:${h.width || 'auto'};">${h.label}</th>`
    ).join('');

    const tbody = rows.map((row, ri) =>
      `<tr style="background:${ri % 2 === 0 ? '#f8fafc' : '#fff'};">
        ${row.map((cell, ci) => {
          const align = headers[ci]?.align || 'left';
          const v  = typeof cell === 'object' && cell !== null ? cell.v : cell;
          const st = typeof cell === 'object' && cell !== null
            ? `color:${cell.c};font-weight:bold;`
            : '';
          return `<td style="padding:4pt 6pt;border:1px solid #e2e8f0;
            font-size:8pt;text-align:${align};${st}
            width:${headers[ci]?.width || 'auto'};">${v ?? ''}</td>`;
        }).join('')}
      </tr>`
    ).join('');

    return `
      <table style="border-collapse:collapse;width:100%;table-layout:fixed;margin-bottom:14pt;">
        <colgroup>${headers.map(h => `<col style="width:${h.width || 'auto'};">`).join('')}</colgroup>
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>`;
  };

  // ── Helper: section page with heading band ────────────────────────────
  const section = (title, badgeBg, count, totalVal, description, tableHtml, extraHtml = '') => `
    <div style="page-break-before:always;">
      <div style="background:${badgeBg};color:#fff;padding:10pt 14pt;border-radius:4pt;margin-bottom:10pt;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:13pt;font-weight:bold;">${title}</span>
        <span style="font-size:9pt;opacity:0.9;">${count} invoice${count !== 1 ? 's' : ''} &nbsp;|&nbsp; ₹${fmt(totalVal)}</span>
      </div>
      ${description ? `<p style="background:#f1f5f9;border-left:4pt solid ${badgeBg};padding:8pt 12pt;font-size:8.5pt;color:#475569;margin-bottom:10pt;border-radius:2pt;">${description}</p>` : ''}
      ${extraHtml}
      ${tableHtml}
    </div>`;

  // ── PORTAL ONLY section ───────────────────────────────────────────────
  const portalOnlyHtml = results.portalOnly.length === 0 ? '' : section(
    '🌐  In GST Portal Only', '#2563eb',
    results.portalOnly.length, sumVal(results.portalOnly, 'portal'),
    'Vendor has filed these invoices on the GST Portal but they are NOT recorded in your Books of Account. Book these invoices to avail Input Tax Credit (ITC).',
    buildTable(
      [
        { label: '#',               width: '3%',  align: 'center' },
        { label: 'GSTIN',           width: '13%', align: 'left'   },
        { label: 'Party Name',      width: '17%', align: 'left'   },
        { label: 'Invoice No',      width: '10%', align: 'left'   },
        { label: 'Date',            width: '8%',  align: 'center' },
        { label: 'Invoice Value ₹', width: '10%', align: 'right'  },
        { label: 'Taxable ₹',       width: '9%',  align: 'right'  },
        { label: 'IGST ₹',          width: '7%',  align: 'right'  },
        { label: 'CGST ₹',          width: '7%',  align: 'right'  },
        { label: 'SGST ₹',          width: '7%',  align: 'right'  },
        { label: 'Place',           width: '9%',  align: 'left'   },
      ],
      results.portalOnly.map((r, i) => {
        const inv = r.portal;
        const rk  = r.key || `${inv?.gstin}__${inv?.invoiceNo}`;
        return [
          i + 1,
          inv?.gstin || '—',
          inv?.tradeOrLegalName || manualTradeNames?.[inv?.gstin] || '—',
          inv?.invoiceNoRaw || '—',
          inv?.invoiceDate  || '—',
          fmt(inv?.invoiceValue  || 0),
          fmt(inv?.taxableValue  || 0),
          fmt(inv?.igst          || 0),
          fmt(inv?.cgst          || 0),
          fmt(inv?.sgst          || 0),
          inv?.placeOfSupply     || '—',
        ];
      }),
      '#2563eb'
    )
  );

  // ── BOOKS ONLY section ────────────────────────────────────────────────
  const booksOnlyHtml = results.booksOnly.length === 0 ? '' : section(
    '📒  In Books Only — ITC at Risk', '#dc2626',
    results.booksOnly.length, sumVal(results.booksOnly, 'books'),
    '⚠ ITC RISK: These invoices are recorded in your Books but the vendor has NOT uploaded them to the GST Portal. You CANNOT claim ITC on these until the vendor files GSTR-1. Follow up with the vendor immediately.',
    buildTable(
      [
        { label: '#',               width: '3%',  align: 'center' },
        { label: 'GSTIN',           width: '14%', align: 'left'   },
        { label: 'Party Name',      width: '18%', align: 'left'   },
        { label: 'Invoice No',      width: '10%', align: 'left'   },
        { label: 'Date',            width: '8%',  align: 'center' },
        { label: 'Invoice Value ₹', width: '10%', align: 'right'  },
        { label: 'Taxable ₹',       width: '9%',  align: 'right'  },
        { label: 'IGST ₹',          width: '7%',  align: 'right'  },
        { label: 'CGST ₹',          width: '7%',  align: 'right'  },
        { label: 'SGST ₹',          width: '7%',  align: 'right'  },
        { label: 'Place',           width: '13%', align: 'left'   },
      ],
      results.booksOnly.map((r, i) => {
        const inv    = r.books;
        const bgstin = (inv?.gstin || '').toUpperCase();
        return [
          i + 1,
          bgstin,
          inv?.tradeOrLegalName || manualTradeNames?.[bgstin] || manualTradeNames?.[inv?.gstin] || '—',
          inv?.invoiceNoRaw || '—',
          inv?.invoiceDate  || '—',
          fmt(inv?.invoiceValue  || 0),
          fmt(inv?.taxableValue  || 0),
          fmt(inv?.igst          || 0),
          fmt(inv?.cgst          || 0),
          fmt(inv?.sgst          || 0),
          inv?.placeOfSupply     || '—',
        ];
      }),
      '#dc2626'
    )
  );

  // ── MISMATCH section ─────────────────────────────────────────────────
  const mismatchHtml = results.mismatch.length === 0 ? '' : section(
    '⚠  Amount Mismatch', '#b45309',
    results.mismatch.length, sumVal(results.mismatch, 'portal'),
    'Invoice numbers match between Portal and Books but invoice value or tax amount differs. Review each entry and correct discrepancies before filing GSTR-3B.',
    buildTable(
      [
        { label: '#',            width: '2%',  align: 'center' },
        { label: 'GSTIN',        width: '12%', align: 'left'   },
        { label: 'Party Name',   width: '13%', align: 'left'   },
        { label: 'Invoice No',   width: '9%',  align: 'left'   },
        { label: 'Date',         width: '7%',  align: 'center' },
        { label: 'Portal ₹',     width: '8%',  align: 'right'  },
        { label: 'Books ₹',      width: '8%',  align: 'right'  },
        { label: 'Diff ₹',       width: '7%',  align: 'right'  },
        { label: 'P.Tax ₹',      width: '7%',  align: 'right'  },
        { label: 'B.Tax ₹',      width: '7%',  align: 'right'  },
        { label: 'Tax Δ ₹',      width: '6%',  align: 'right'  },
        { label: 'Severity',     width: '5%',  align: 'center' },
        { label: 'Root Cause & Suggested Action', width: '19%', align: 'left' },
      ],
      results.mismatch.map((r, i) => {
        const pTax  = (r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0);
        const bTax  = (r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0);
        const vDiff = r.valueDiff || 0;
        const tDiff = r.taxDiff   || 0;
        const sevColor = r.severity === 'high' ? '#b91c1c' : r.severity === 'medium' ? '#b45309' : '#64748b';
        const reason = [r.mismatchReason, r.suggestedAction ? `→ ${r.suggestedAction}` : ''].filter(Boolean).join(' ');
        return [
          i + 1,
          r.portal?.gstin || '—',
          r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || '—',
          r.portal?.invoiceNoRaw || '—',
          r.portal?.invoiceDate  || '—',
          fmt(r.portal?.invoiceValue || 0),
          fmt(r.books?.invoiceValue  || 0),
          { v: (vDiff >= 0 ? '+' : '') + fmt(vDiff), c: vDiff >= 0 ? '#1d4ed8' : '#dc2626' },
          fmt(pTax),
          fmt(bTax),
          { v: (tDiff >= 0 ? '+' : '') + fmt(tDiff), c: tDiff >= 0 ? '#1d4ed8' : '#dc2626' },
          { v: (r.severity || '—').toUpperCase(), c: sevColor },
          reason || '—',
        ];
      }),
      '#b45309'
    )
  );

  // ── MATCHED section ───────────────────────────────────────────────────
  const matchedHtml = results.matched.length === 0 ? '' : section(
    '✓  Matched Invoices', '#059669',
    results.matched.length, sumVal(results.matched, 'portal'),
    'These invoices are present in both the GST Portal (GSTR-2B) and your Books of Account with matching amounts. No action required.',
    buildTable(
      [
        { label: '#',               width: '3%',  align: 'center' },
        { label: 'GSTIN',           width: '13%', align: 'left'   },
        { label: 'Party Name',      width: '18%', align: 'left'   },
        { label: 'Invoice No',      width: '11%', align: 'left'   },
        { label: 'Date',            width: '8%',  align: 'center' },
        { label: 'Invoice Value ₹', width: '10%', align: 'right'  },
        { label: 'Taxable ₹',       width: '9%',  align: 'right'  },
        { label: 'IGST ₹',          width: '7%',  align: 'right'  },
        { label: 'CGST ₹',          width: '7%',  align: 'right'  },
        { label: 'SGST ₹',          width: '7%',  align: 'right'  },
        { label: 'Cess ₹',          width: '7%',  align: 'right'  },
      ],
      results.matched.map((r, i) => {
        const rk = r.key || `${r.portal?.gstin}__${r.portal?.invoiceNo}`;
        return [
          i + 1,
          r.portal?.gstin || '—',
          r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || r.books?.tradeOrLegalName || '—',
          r.portal?.invoiceNoRaw || '—',
          r.portal?.invoiceDate  || '—',
          fmt(r.portal?.invoiceValue  || 0),
          fmt(r.portal?.taxableValue  || 0),
          fmt(r.portal?.igst          || 0),
          fmt(r.portal?.cgst          || 0),
          fmt(r.portal?.sgst          || 0),
          fmt(r.portal?.cess          || 0),
        ];
      }),
      '#059669'
    )
  );

  // ── Summary table on cover ────────────────────────────────────────────
  const summaryTableHtml = buildTable(
    [
      { label: 'Category',           width: '22%', align: 'left'   },
      { label: 'Count',              width: '7%',  align: 'center' },
      { label: 'Invoice Value ₹',    width: '14%', align: 'right'  },
      { label: 'Taxable Value ₹',    width: '14%', align: 'right'  },
      { label: 'IGST ₹',             width: '10%', align: 'right'  },
      { label: 'CGST ₹',             width: '10%', align: 'right'  },
      { label: 'SGST ₹',             width: '10%', align: 'right'  },
      { label: 'Total Tax ₹',        width: '13%', align: 'right'  },
    ],
    [
      [
        { v: '✓ Matched',           c: '#059669' },
        results.matched.length,
        fmt(sumVal(results.matched, 'portal')),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.matched.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.matched, 'portal')),
      ],
      [
        { v: '⚠ Amount Mismatch',   c: '#b45309' },
        results.mismatch.length,
        fmt(sumVal(results.mismatch, 'portal')),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.mismatch.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.mismatch, 'portal')),
      ],
      [
        { v: '🌐 In Portal Only',   c: '#1d4ed8' },
        results.portalOnly.length,
        fmt(sumVal(results.portalOnly, 'portal')),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.igst || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.cgst || 0), 0)),
        fmt(results.portalOnly.reduce((s, r) => s + (r.portal?.sgst || 0), 0)),
        fmt(sumTax(results.portalOnly, 'portal')),
      ],
      [
        { v: '📒 In Books Only',    c: '#dc2626' },
        results.booksOnly.length,
        fmt(sumVal(results.booksOnly, 'books')),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.taxableValue || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.igst || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.cgst || 0), 0)),
        fmt(results.booksOnly.reduce((s, r) => s + (r.books?.sgst || 0), 0)),
        fmt(sumTax(results.booksOnly, 'books')),
      ],
    ],
    '#0D3B66'
  );

  const totalPortal = results.matched.length + results.mismatch.length + results.portalOnly.length;
  const totalBooks  = results.matched.length + results.mismatch.length + results.booksOnly.length;

  // ── Full HTML document ────────────────────────────────────────────────
  const html = `
<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <title>GST Reconciliation Report</title>
  <!--[if gte mso 9]><xml>
    <w:WordDocument>
      <w:View>Print</w:View><w:Zoom>90</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml><![endif]-->
  <style>
    @page { size: A4 landscape; margin: 1.8cm 1.5cm 1.8cm 1.5cm; }
    body  { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 10pt; color: #1e293b; margin: 0; }
    h1    { font-size: 22pt; color: #0D3B66; margin: 0 0 6pt; }
    h2    { font-size: 13pt; color: #0D3B66; margin: 14pt 0 6pt; }
    p     { margin: 4pt 0; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    .footer { border-top: 1px solid #e2e8f0; margin-top: 20pt; padding-top: 8pt; font-size: 7.5pt; color: #94a3b8; }
  </style>
</head>
<body>

<!-- ══ COVER ══════════════════════════════════════════════════════════ -->
<div style="background:#0D3B66;color:#fff;padding:18pt 16pt 14pt;margin-bottom:16pt;border-radius:4pt;">
  <h1 style="color:#fff;font-size:22pt;margin:0 0 5pt;">GST Reconciliation Report</h1>
  <p style="font-size:15pt;font-weight:bold;color:#93c5fd;margin:0 0 10pt;">${company.name || ''}</p>
  <table style="border:none;width:100%;table-layout:auto;margin:0;">
    <tr>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;width:90pt;font-weight:bold;font-size:9pt;">GSTIN</td>
      <td style="border:none;color:#fff;padding:2pt 16pt 2pt 0;font-size:9pt;">${company.gstin || '—'}</td>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;width:90pt;font-weight:bold;font-size:9pt;">PAN</td>
      <td style="border:none;color:#fff;padding:2pt 0;font-size:9pt;">${company.pan || '—'}</td>
    </tr>
    <tr>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;font-weight:bold;font-size:9pt;">Tax Period</td>
      <td style="border:none;color:#fff;padding:2pt 16pt 2pt 0;font-size:9pt;">${period || '—'}</td>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;font-weight:bold;font-size:9pt;">Financial Year</td>
      <td style="border:none;color:#fff;padding:2pt 0;font-size:9pt;">${company.fy || '—'}</td>
    </tr>
    <tr>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;font-weight:bold;font-size:9pt;">Address</td>
      <td style="border:none;color:#fff;padding:2pt 16pt 2pt 0;font-size:9pt;" colspan="3">${company.address || '—'}</td>
    </tr>
    <tr>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;font-weight:bold;font-size:9pt;">Phone</td>
      <td style="border:none;color:#fff;padding:2pt 16pt 2pt 0;font-size:9pt;">${company.phone || '—'}</td>
      <td style="border:none;color:#cbd5e1;padding:2pt 0;font-weight:bold;font-size:9pt;">Email</td>
      <td style="border:none;color:#fff;padding:2pt 0;font-size:9pt;">${company.email || '—'}</td>
    </tr>
    <tr>
      <td style="border:none;color:#cbd5e1;padding:6pt 0 2pt;font-weight:bold;font-size:9pt;">Generated On</td>
      <td style="border:none;color:#fff;padding:6pt 0 2pt;font-size:9pt;" colspan="3">${dateStr}</td>
    </tr>
  </table>
</div>

<!-- Stat cards (Word-compatible grid) -->
<table style="border-collapse:separate;border-spacing:6pt;width:100%;margin-bottom:14pt;table-layout:fixed;">
  <tr>
    ${[
      { label: 'Total Portal',  val: totalPortal,               bg: '#0D3B66' },
      { label: 'Total Books',   val: totalBooks,                bg: '#1F6FB2' },
      { label: 'Matched',       val: results.matched.length,    bg: '#059669' },
      { label: 'Mismatch',      val: results.mismatch.length,   bg: '#b45309' },
      { label: 'Portal Only',   val: results.portalOnly.length, bg: '#1d4ed8' },
      { label: 'Books Only',    val: results.booksOnly.length,  bg: '#dc2626' },
    ].map(c => `
      <td style="background:${c.bg};color:#fff;text-align:center;padding:10pt 6pt;
        border-radius:4pt;width:16.6%;">
        <div style="font-size:20pt;font-weight:bold;line-height:1.2;">${c.val}</div>
        <div style="font-size:8pt;opacity:0.9;margin-top:2pt;">${c.label}</div>
      </td>`).join('')}
  </tr>
</table>

<h2>Reconciliation Summary</h2>
${summaryTableHtml}

<p style="font-size:8pt;color:#64748b;margin-top:4pt;">
  Total invoices in Portal: <strong>${totalPortal}</strong> &nbsp;|&nbsp;
  Total invoices in Books: <strong>${totalBooks}</strong>
</p>

<!-- ══ DETAIL SECTIONS ════════════════════════════════════════════════ -->
${portalOnlyHtml}
${booksOnlyHtml}
${mismatchHtml}
${matchedHtml}

<div class="footer">
  <p><strong>Note:</strong> This report is generated automatically based on data uploaded by the user.
     Figures are for reconciliation purposes only. Verify all discrepancies with source documents before filing.</p>
  <p>Report generated by TaskOsphere &nbsp;|&nbsp; ${dateStr} &nbsp;|&nbsp; ${company.name || ''} &nbsp;|&nbsp; GSTIN: ${company.gstin || ''}</p>
</div>

</body>
</html>`;

  const blob  = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
  const fname = `GST_Recon_${(company.name || 'Report').replace(/\s+/g, '_')}_${(period || 'Export').replace(/\s+/g, '_')}.doc`;
  saveAs(blob, fname);
  toast.success('Word document downloaded successfully!');
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXCEL EXPORT v2 — Multi-sheet with styled headers, column widths, totals
   ─────────────────────────────────────────────────────────────────────────
   Fixes vs original:
   • Every sheet has wscols (column widths) set so content never overflows
   • Numeric cells stored as numbers (not strings) — Excel can sort & sum them
   • A "Totals" footer row added to each data sheet
   • Mismatch Detail sheet includes Severity + Root Cause + Suggested Action
   • Vendor Action List sheet preserved and enhanced
   • Summary sheet has professional formatting with wscols
   • All sheets include freeze pane on header row
═══════════════════════════════════════════════════════════════════════════ */
async function exportExcel(results, company, period, manualTradeNames = {}, invoiceComments = {}) {
  XLSX = await getXLSX();
  const wb = XLSX.utils.book_new();

  // ── Helper: append a sheet with column widths + freeze header ─────────
  const addSheet = (name, aoa, colWidths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (colWidths) ws['!cols'] = colWidths.map(w => ({ wch: w }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 }; // freeze first row
    XLSX.utils.book_append_sheet(wb, ws, name);
    return ws;
  };

  // ── SUMMARY sheet ─────────────────────────────────────────────────────
  addSheet('Summary', [
    [`GST Reconciliation Report — ${company.name || ''}`, '', '', '', '', '', '', ''],
    ['GSTIN', company.gstin || '', 'PAN', company.pan || '', 'Period', period || '', 'FY', company.fy || ''],
    ['Address', company.address || '', 'Phone', company.phone || '', 'Email', company.email || '', '', ''],
    ['Generated', new Date().toLocaleDateString('en-IN'), '', '', '', '', '', ''],
    [],
    ['Category', 'Count', 'Invoice Value (Rs)', 'Taxable Value (Rs)', 'IGST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Total Tax (₹)'],
    [
      'Matched',
      results.matched.length,
      sumVal(results.matched, 'portal'),
      results.matched.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0),
      results.matched.reduce((s, r) => s + (r.portal?.igst || 0), 0),
      results.matched.reduce((s, r) => s + (r.portal?.cgst || 0), 0),
      results.matched.reduce((s, r) => s + (r.portal?.sgst || 0), 0),
      sumTax(results.matched, 'portal'),
    ],
    [
      'Amount Mismatch',
      results.mismatch.length,
      sumVal(results.mismatch, 'portal'),
      results.mismatch.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0),
      results.mismatch.reduce((s, r) => s + (r.portal?.igst || 0), 0),
      results.mismatch.reduce((s, r) => s + (r.portal?.cgst || 0), 0),
      results.mismatch.reduce((s, r) => s + (r.portal?.sgst || 0), 0),
      sumTax(results.mismatch, 'portal'),
    ],
    [
      'In Portal Only',
      results.portalOnly.length,
      sumVal(results.portalOnly, 'portal'),
      results.portalOnly.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0),
      results.portalOnly.reduce((s, r) => s + (r.portal?.igst || 0), 0),
      results.portalOnly.reduce((s, r) => s + (r.portal?.cgst || 0), 0),
      results.portalOnly.reduce((s, r) => s + (r.portal?.sgst || 0), 0),
      sumTax(results.portalOnly, 'portal'),
    ],
    [
      'In Books Only',
      results.booksOnly.length,
      sumVal(results.booksOnly, 'books'),
      results.booksOnly.reduce((s, r) => s + (r.books?.taxableValue || 0), 0),
      results.booksOnly.reduce((s, r) => s + (r.books?.igst || 0), 0),
      results.booksOnly.reduce((s, r) => s + (r.books?.cgst || 0), 0),
      results.booksOnly.reduce((s, r) => s + (r.books?.sgst || 0), 0),
      sumTax(results.booksOnly, 'books'),
    ],
  ], [22, 8, 20, 18, 12, 12, 12, 16]);

  // ── MATCHED sheet ─────────────────────────────────────────────────────
  const matchedRows = results.matched.map((r, i) => {
    const rk = r.key || `${r.portal?.gstin}__${r.portal?.invoiceNo}`;
    const nm = r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || r.books?.tradeOrLegalName || '';
    return [
      i + 1,
      r.portal?.gstin || '',
      nm,
      r.portal?.invoiceNoRaw || '',
      r.portal?.invoiceDate  || '',
      r.portal?.invoiceValue || 0,
      r.portal?.taxableValue || 0,
      r.portal?.igst         || 0,
      r.portal?.cgst         || 0,
      r.portal?.sgst         || 0,
      r.portal?.cess         || 0,
      invoiceComments?.[rk]  || '',
    ];
  });
  const matchedTotal = [
    'TOTAL', results.matched.length, '',
    sumVal(results.matched, 'portal'),
    results.matched.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0),
    results.matched.reduce((s, r) => s + (r.portal?.igst || 0), 0),
    results.matched.reduce((s, r) => s + (r.portal?.cgst || 0), 0),
    results.matched.reduce((s, r) => s + (r.portal?.sgst || 0), 0),
    results.matched.reduce((s, r) => s + (r.portal?.cess || 0), 0),
    '', '',
  ];
  addSheet('Matched', [
    ['#', 'GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Invoice Value (Rs)', 'Taxable Value (Rs)', 'IGST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Cess (Rs)', 'Notes'],
    ...matchedRows,
    [],
    matchedTotal,
  ], [4, 18, 26, 16, 12, 18, 18, 12, 12, 12, 10, 30]);

  // ── IN PORTAL ONLY sheet ─────────────────────────────────────────────
  const portalRows = results.portalOnly.map((r, i) => {
    const inv = r.portal;
    const rk  = r.key || `${inv?.gstin}__${inv?.invoiceNo}`;
    return [
      i + 1,
      inv?.gstin              || '',
      inv?.tradeOrLegalName   || manualTradeNames?.[inv?.gstin] || '',
      inv?.invoiceNoRaw       || '',
      inv?.invoiceDate        || '',
      inv?.invoiceValue       || 0,
      inv?.taxableValue       || 0,
      inv?.igst               || 0,
      inv?.cgst               || 0,
      inv?.sgst               || 0,
      inv?.placeOfSupply      || '',
      inv?.itcAvailability    || '',
      invoiceComments?.[rk]   || '',
    ];
  });
  const portalTotal = [
    'TOTAL', results.portalOnly.length, '', '', '',
    sumVal(results.portalOnly, 'portal'),
    results.portalOnly.reduce((s, r) => s + (r.portal?.taxableValue || 0), 0),
    results.portalOnly.reduce((s, r) => s + (r.portal?.igst || 0), 0),
    results.portalOnly.reduce((s, r) => s + (r.portal?.cgst || 0), 0),
    results.portalOnly.reduce((s, r) => s + (r.portal?.sgst || 0), 0),
    '', '', '',
  ];
  addSheet('In Portal Only', [
    ['#', 'GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Invoice Value (Rs)', 'Taxable Value (Rs)', 'IGST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Place of Supply', 'ITC Availability', 'Notes'],
    ...portalRows,
    [],
    portalTotal,
  ], [4, 18, 26, 16, 12, 18, 18, 12, 12, 12, 18, 16, 30]);

  // ── IN BOOKS ONLY sheet ───────────────────────────────────────────────
  const booksRows = results.booksOnly.map((r, i) => {
    const inv    = r.books;
    const bgstin = (inv?.gstin || '').toUpperCase();
    const rk     = r.key || `${bgstin}__${inv?.invoiceNo}`;
    return [
      i + 1,
      bgstin,
      inv?.tradeOrLegalName  || manualTradeNames?.[bgstin] || manualTradeNames?.[inv?.gstin] || '',
      inv?.invoiceNoRaw      || '',
      inv?.invoiceDate       || '',
      inv?.invoiceValue      || 0,
      inv?.taxableValue      || 0,
      inv?.igst              || 0,
      inv?.cgst              || 0,
      inv?.sgst              || 0,
      inv?.cess              || 0,
      inv?.placeOfSupply     || '',
      inv?.invoiceType       || '',
      inv?.rate              || 0,
      invoiceComments?.[rk]  || '',
    ];
  });
  const booksTotal = [
    'TOTAL', results.booksOnly.length, '', '', '',
    sumVal(results.booksOnly, 'books'),
    results.booksOnly.reduce((s, r) => s + (r.books?.taxableValue || 0), 0),
    results.booksOnly.reduce((s, r) => s + (r.books?.igst || 0), 0),
    results.booksOnly.reduce((s, r) => s + (r.books?.cgst || 0), 0),
    results.booksOnly.reduce((s, r) => s + (r.books?.sgst || 0), 0),
    results.booksOnly.reduce((s, r) => s + (r.books?.cess || 0), 0),
    '', '', '', '',
  ];
  addSheet('In Books Only', [
    ['#', 'GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Invoice Value (Rs)', 'Taxable Value (Rs)', 'IGST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Cess (Rs)', 'Place of Supply', 'Invoice Type', 'GST Rate (%)', 'Notes'],
    ...booksRows,
    [],
    booksTotal,
  ], [4, 18, 26, 16, 12, 18, 18, 12, 12, 12, 10, 18, 14, 12, 30]);

  // ── MISMATCH sheet (summary) ──────────────────────────────────────────
  const mismatchRows = results.mismatch.map((r, i) => {
    const pTax = (r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0);
    const bTax = (r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0);
    const rk   = r.key || `${r.portal?.gstin}__${r.portal?.invoiceNo}`;
    const nm   = r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || r.books?.tradeOrLegalName || '';
    return [
      i + 1,
      r.portal?.gstin        || '',
      nm,
      r.portal?.invoiceNoRaw || '',
      r.portal?.invoiceDate  || '',
      r.portal?.invoiceValue || 0,
      r.books?.invoiceValue  || 0,
      r.valueDiff            || 0,
      pTax,
      bTax,
      r.taxDiff              || 0,
      invoiceComments?.[rk]  || '',
    ];
  });
  const mismatchTotal = [
    'TOTAL', results.mismatch.length, '', '', '',
    sumVal(results.mismatch, 'portal'),
    sumVal(results.mismatch, 'books'),
    results.mismatch.reduce((s, r) => s + (r.valueDiff || 0), 0),
    results.mismatch.reduce((s, r) => s + ((r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0)), 0),
    results.mismatch.reduce((s, r) => s + ((r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0)), 0),
    results.mismatch.reduce((s, r) => s + (r.taxDiff || 0), 0),
    '',
  ];
  addSheet('Mismatch', [
    ['#', 'GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Portal Value (Rs)', 'Books Value (Rs)', 'Value Diff (Rs)', 'Portal Tax (Rs)', 'Books Tax (Rs)', 'Tax Diff (Rs)', 'Notes'],
    ...mismatchRows,
    [],
    mismatchTotal,
  ], [4, 18, 26, 16, 12, 18, 18, 14, 14, 14, 14, 30]);

  // ── MISMATCH DETAIL sheet (with root-cause) ────────────────────────────
  const mismatchDetailRows = results.mismatch.map((r, i) => {
    const pTax = (r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0);
    const bTax = (r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0);
    const nm   = r.portal?.tradeOrLegalName || manualTradeNames?.[r.portal?.gstin] || r.books?.tradeOrLegalName || '';
    return [
      i + 1,
      r.portal?.gstin        || r.books?.gstin || '',
      nm,
      r.portal?.invoiceNoRaw || r.books?.invoiceNoRaw || '',
      r.portal?.invoiceDate  || r.books?.invoiceDate  || '',
      r.portal?.invoiceValue || 0,
      r.books?.invoiceValue  || 0,
      (r.portal?.invoiceValue || 0) - (r.books?.invoiceValue || 0),
      pTax,
      bTax,
      pTax - bTax,
      (r.severity || '').toUpperCase(),
      r.mismatchReason       || '',
      r.suggestedAction      || '',
    ];
  });
  addSheet('Mismatch Detail', [
    ['#', 'GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Portal Value (Rs)', 'Books Value (Rs)', 'Value Diff (Rs)', 'Portal Tax (Rs)', 'Books Tax (Rs)', 'Tax Diff (Rs)', 'Severity', 'Root Cause', 'Recommended Action'],
    ...mismatchDetailRows,
  ], [4, 18, 26, 16, 12, 18, 18, 14, 14, 14, 14, 10, 40, 40]);

  // ── VENDOR ACTION LIST sheet ──────────────────────────────────────────
  const vendorMap = new Map();
  const addVendorIssue = (r, category) => {
    const inv  = r.portal || r.books;
    const g    = inv?.gstin || '';
    if (!g) return;
    const nm   = inv?.tradeOrLegalName || manualTradeNames?.[g] || '';
    const e    = vendorMap.get(g) || { gstin: g, name: nm, issues: [], totalAmt: 0 };
    const pTx  = (r.portal?.igst || 0) + (r.portal?.cgst || 0) + (r.portal?.sgst || 0);
    const bTx  = (r.books?.igst  || 0) + (r.books?.cgst  || 0) + (r.books?.sgst  || 0);
    e.issues.push({
      invNo:    r.portal?.invoiceNoRaw  || r.books?.invoiceNoRaw || '',
      invDate:  r.portal?.invoiceDate   || r.books?.invoiceDate  || '',
      invVal:   inv?.invoiceValue       || 0,
      taxImpact: category === 'mismatch' ? Math.abs(pTx - bTx) : (pTx || bTx),
      category,
      severity: (r.severity || 'medium').toUpperCase(),
      reason:   r.mismatchReason || (
        category === 'mismatch' ? 'Amount mismatch' :
        category === 'portal'   ? 'Not in books'    : 'Not in portal'
      ),
      action:   r.suggestedAction || (
        category === 'portal' ? 'Book this invoice to avail ITC' :
        category === 'books'  ? 'Confirm if vendor omitted from GSTR-1 — follow up' :
                                'Review and correct discrepancy'
      ),
    });
    e.totalAmt += inv?.invoiceValue || 0;
    vendorMap.set(g, e);
  };
  results.mismatch.forEach(r    => addVendorIssue(r, 'mismatch'));
  results.portalOnly.forEach(r  => addVendorIssue(r, 'portal'));
  results.booksOnly.forEach(r   => addVendorIssue(r, 'books'));

  const vendorsSorted  = [...vendorMap.values()].sort((a, b) => b.totalAmt - a.totalAmt);
  const actionRows     = vendorsSorted.flatMap(v =>
    v.issues.map(iss => [
      v.gstin,
      v.name || manualTradeNames?.[v.gstin] || '',
      iss.invNo,
      iss.invDate,
      iss.invVal,
      iss.taxImpact,
      iss.category === 'mismatch' ? 'Amount Mismatch' :
      iss.category === 'portal'   ? 'Portal Only (Not in Books)' : 'Books Only (Not in Portal)',
      iss.severity,
      iss.reason,
      iss.action,
      'Pending',
    ])
  );
  const vendorSummaryRows = vendorsSorted.map(v => [
    v.gstin, v.name || '', v.issues.length, v.totalAmt,
  ]);

  addSheet('Vendor Action List', [
    [`VENDOR ACTION REQUIRED LIST — ${company.name || ''} | Period: ${period || ''}`],
    [`Generated: ${new Date().toLocaleDateString('en-IN')}`],
    [],
    ['GSTIN', 'Vendor Name', 'Invoice No', 'Invoice Date', 'Invoice Value (Rs)', 'ITC Impact (₹)', 'Issue Category', 'Severity', 'Root Cause', 'Recommended Action', 'Follow-Up Status'],
    ...actionRows,
    [],
    ['VENDOR SUMMARY'],
    ['GSTIN', 'Vendor Name', 'Total Issues', 'Total Invoice Value (₹)'],
    ...vendorSummaryRows,
  ], [18, 28, 16, 12, 18, 16, 24, 10, 40, 40, 14]);

  // ── Write & download ──────────────────────────────────────────────────
  const safeName   = (company.name  || 'Report').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').slice(0, 30);
  const safePeriod = (period        || 'Export' ).replace(/\s+/g, '_');
  const fname      = `GST_Recon_${safeName}_${safePeriod}.xlsx`;

  XLSX.writeFile(wb, fname);
  toast.success('Excel report downloaded — includes Matched, Mismatch, Portal Only, Books Only, Mismatch Detail, and Vendor Action List sheets!');
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI CONSTANTS
═══════════════════════════════════════════════════════════════════════════ */
// ACTION_TABS — the 4 actionable categories shown as cards + used in ResultTable
const ACTION_TABS = [
  { id:'mismatch',   label:'Amount Mismatch',  icon:AlertTriangle, urgency:'high',   color:{ activeBg:'bg-amber-50 dark:bg-amber-900/20',   activeBorder:'border-amber-400',   activeText:'text-amber-700 dark:text-amber-300',   badge:'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'   }, desc:'Invoice number matches but amounts or tax differ between Portal and Books.', action:'Review & resolve each mismatch before filing GSTR-3B.' },
  { id:'portalOnly', label:'In Portal Only',    icon:Globe,         urgency:'medium', color:{ activeBg:'bg-blue-50 dark:bg-blue-900/20',     activeBorder:'border-blue-400',     activeText:'text-blue-700 dark:text-blue-300',     badge:'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'     }, desc:'Vendor uploaded to GST Portal but NOT recorded in Books.', action:'Book these invoices to avail ITC.' },
  { id:'booksOnly',  label:'In Books Only',     icon:BookOpen,      urgency:'medium', color:{ activeBg:'bg-rose-50 dark:bg-rose-900/20',     activeBorder:'border-rose-400',     activeText:'text-rose-700 dark:text-rose-300',     badge:'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'     }, desc:'In Books but vendor has NOT filed on the GST portal.', action:'Follow up with vendor — ITC at risk.' },
  { id:'crossGstin', label:'GSTIN Conflict',    icon:AlertTriangle, urgency:'critical',color:{ activeBg:'bg-orange-50 dark:bg-orange-900/20', activeBorder:'border-orange-500',   activeText:'text-orange-700 dark:text-orange-300', badge:'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' }, desc:'Same invoice & value in both but under DIFFERENT GSTINs.', action:'Verify GSTIN with vendor — critical for ITC.' },
];
// Keep TABS alias for code that references TABS (search, crossGstin lookup etc.)
const TABS = [
  { id:'matched',    label:'Matched',       icon:CheckCircle2, color:{ activeBg:'bg-emerald-50 dark:bg-emerald-900/20', activeBorder:'border-emerald-400', activeText:'text-emerald-700 dark:text-emerald-300', badge:'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }, desc:'Invoices present in both GSTR-2B and Books with matching amounts. No action required.' },
  { id:'mismatch',   label:'Mismatch',      icon:AlertTriangle, color:{ activeBg:'bg-amber-50 dark:bg-amber-900/20',   activeBorder:'border-amber-400',   activeText:'text-amber-700 dark:text-amber-300',   badge:'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'   }, desc:'Invoice number matches but invoice value or tax differs between Portal and Books.' },
  { id:'portalOnly', label:'Portal Only',   icon:Globe,         color:{ activeBg:'bg-blue-50 dark:bg-blue-900/20',     activeBorder:'border-blue-400',     activeText:'text-blue-700 dark:text-blue-300',     badge:'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'     }, desc:'Vendor uploaded to GST Portal but NOT in Books. Book these to avail ITC.' },
  { id:'booksOnly',  label:'Books Only',    icon:BookOpen,      color:{ activeBg:'bg-rose-50 dark:bg-rose-900/20',     activeBorder:'border-rose-400',     activeText:'text-rose-700 dark:text-rose-300',     badge:'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'     }, desc:'In Books but vendor NOT filed on portal. ITC at risk — follow up with vendor.' },
  { id:'crossGstin', label:'GSTIN Conflict',icon:AlertTriangle, color:{ activeBg:'bg-orange-50 dark:bg-orange-900/20', activeBorder:'border-orange-500',   activeText:'text-orange-700 dark:text-orange-300', badge:'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' }, desc:'Same invoice & value found in BOTH Portal and Books — but under DIFFERENT GSTINs. Verify correct GSTIN with vendor. Critical for ITC.' },
  { id:'search',     label:'Search',        icon:ScanSearch,    color:{ activeBg:'bg-purple-50 dark:bg-purple-900/20', activeBorder:'border-purple-400',   activeText:'text-purple-700 dark:text-purple-300', badge:'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' }, desc:'Search across all invoices in one place.' },
];
const PAGE_SIZE = 50;

/* ═══════════════════════════════════════════════════════════════════════════
   DROPZONE COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
const DropZone = ({ label, icon:Icon, colors, file, onFile, onClear, hint }) => {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const handleDrop = useCallback(e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }, [onFile]);
  return (
    <div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={handleDrop}
      onClick={()=>!file&&inputRef.current?.click()}
      className={`relative rounded-xl border-2 border-dashed transition-all duration-200 p-5 flex flex-col items-center justify-center gap-3 min-h-[140px] ${
        file ? `${colors.done} cursor-default` : dragging ? `${colors.drag} cursor-copy` : 'border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50 hover:border-slate-400 cursor-pointer'
      }`}>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e=>{const f=e.target.files[0];if(f)onFile(f);e.target.value='';}} />
      <div className={`p-2.5 rounded-full ${file?colors.iconBg:'bg-slate-200 dark:bg-slate-700'}`}>
        {file ? <CheckCircle2 className={`h-5 w-5 ${colors.iconColor}`}/> : <Icon className="h-5 w-5 text-slate-400"/>}
      </div>
      <div className="text-center">
        <p className="font-semibold text-sm text-slate-700 dark:text-slate-200">{label}</p>
        {file ? (
          <div className="flex items-center gap-2 mt-1 justify-center">
            <span className={`text-xs font-medium ${colors.iconColor} truncate max-w-[180px]`}>{file.name}</span>
            <button onClick={e=>{e.stopPropagation();onClear();}} className="p-0.5 rounded hover:bg-white/50"><X className={`h-3.5 w-3.5 ${colors.iconColor}`}/></button>
          </div>
        ) : <p className="text-xs text-slate-400 mt-1">{hint}</p>}
      </div>
      {!file && <button onClick={e=>{e.stopPropagation();inputRef.current?.click();}} className={`text-xs px-3 py-1.5 rounded-lg font-medium ${colors.btn}`}>Browse File</button>}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   RESULT TABLE COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   TRADE NAME INLINE EDITOR
   ─────────────────────────────────────────────────────────────────────────
   Shown in the Party Name column for Books-Only rows.
   • If a name already exists (manual or auto), shows it with a ✎ edit icon.
   • If no name: shows a "+ Add" button.
   • On open: auto-triggers clientGstinLookup in the background.
   • Saving a name propagates to ALL rows with the same GSTIN.
═══════════════════════════════════════════════════════════════════════════ */
const TradeNameCell = React.memo(({ gstin, manualTradeNames, onSave }) => {
  const current  = manualTradeNames?.[gstin] || '';
  const [open,   setOpen]   = useState(false);
  const [draft,  setDraft]  = useState(current);
  const [busy,   setBusy]   = useState(false);
  const inputRef = useRef(null);

  // When popover opens: pre-fill draft and auto-fetch from GST portal.
  // stopPropagation prevents the row-level onClick (invoice detail modal) from firing.
  const handleOpen = async (e) => {
    e?.stopPropagation();
    setDraft(current);
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
    if (!current) {
      setBusy(true);
      try {
        const res = await clientGstinLookup(gstin);
        const fetched = res.tradeName || res.legalName || '';
        if (fetched) setDraft(fetched);
      } catch (_) {}
      setBusy(false);
    }
  };

  const handleSave = (e) => {
    e?.stopPropagation();
    const trimmed = draft.trim();
    if (trimmed) onSave(gstin, trimmed);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    e.stopPropagation(); // prevent row clicks while typing
    if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
    if (e.key === 'Escape') setOpen(false);
  };

  if (!open) {
    return current ? (
      <span className="flex items-center gap-1 group min-w-0" onClick={e => e.stopPropagation()}>
        <span className="truncate text-slate-700 dark:text-slate-200 text-sm max-w-[140px]" title={current}>{current}</span>
        <button
          onClick={handleOpen}
          title="Edit party name"
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-indigo-600 flex-shrink-0"
        >
          <Edit3 className="h-3 w-3"/>
        </button>
      </span>
    ) : (
      <button
        onClick={handleOpen}
        className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200 hover:underline underline-offset-2 font-medium transition-colors"
        title="Add party name — applies to all invoices with this GSTIN"
      >
        <Edit3 className="h-3 w-3 flex-shrink-0"/>
        Add name
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-[180px]" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            placeholder={busy ? 'Fetching…' : 'Enter party name…'}
            disabled={busy}
            className="w-full px-2 py-1 text-xs rounded border border-indigo-400 dark:border-indigo-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 pr-6"
          />
          {busy && <Loader2 className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-indigo-400"/>}
        </div>
        <button
          onClick={handleSave}
          disabled={!draft.trim()}
          title="Save (Enter)"
          className="flex-shrink-0 p-1 rounded bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 dark:disabled:bg-slate-600 text-white transition-colors"
        >
          <CheckCircle2 className="h-3.5 w-3.5"/>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setOpen(false); }}
          title="Cancel (Esc)"
          className="flex-shrink-0 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="h-3.5 w-3.5"/>
        </button>
      </div>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight">
        {GSTIN_PATTERN.test(gstin) ? `Applies to all ${gstin} invoices` : ''}
      </p>
    </div>
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   COMMENT CELL — add/edit inline comment on any invoice row
   ─────────────────────────────────────────────────────────────────────────
   Shown as a small 💬 icon in every row. Clicking opens an inline textarea.
   Saved comments persist in localStorage and appear in exported reports.
═══════════════════════════════════════════════════════════════════════════ */

// Predefined quick-tags for common GST issues
const PREDEFINED_NOTE_TAGS = [
  'GST Mismatch',
  'GST Number Incorrect',
  'Vendor Not Filed',
  'Amount Differs',
  'Follow Up',
  'ITC Risk',
  'Duplicate Entry',
  'Rate Mismatch',
];

const CommentCell = React.memo(({ rowKey, comments, onSave }) => {
  const current  = comments?.[rowKey] || '';
  const [open,   setOpen]  = useState(false);
  const [draft,  setDraft] = useState(current);
  const inputRef = useRef(null);

  const handleOpen  = (e) => { e?.stopPropagation(); setDraft(current); setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); };
  const handleSave  = (e) => { e?.stopPropagation(); onSave(rowKey, draft); setOpen(false); };
  const handleClear = (e) => { e?.stopPropagation(); onSave(rowKey, ''); setOpen(false); };
  const handleKey   = e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); }
    if (e.key === 'Escape') setOpen(false);
  };
  const handleTagClick = (tag) => {
    setDraft(prev => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}; ${tag}` : tag;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (!open) {
    return current ? (
      <span className="flex items-center gap-1 group min-w-0 max-w-[120px]" onClick={e => e.stopPropagation()}>
        <MessageSquare className="h-3 w-3 text-amber-500 flex-shrink-0"/>
        <span className="truncate text-amber-700 dark:text-amber-300 text-[10px] italic" title={current}>{current}</span>
        <button onClick={handleOpen} title="Edit comment"
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-amber-400 hover:text-amber-600 flex-shrink-0">
          <Edit3 className="h-2.5 w-2.5"/>
        </button>
      </span>
    ) : (
      <button onClick={handleOpen} title="Add comment"
        className="p-0.5 rounded text-slate-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors">
        <MessageSquare className="h-3 w-3"/>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-[200px] z-10 relative" onClick={e => e.stopPropagation()}>
      {/* Quick tag buttons */}
      <div className="flex flex-wrap gap-1 mb-0.5">
        {PREDEFINED_NOTE_TAGS.map(tag => (
          <button
            key={tag}
            onClick={() => handleTagClick(tag)}
            className="px-1.5 py-0.5 rounded text-[8px] font-medium bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors whitespace-nowrap"
          >
            {tag}
          </button>
        ))}
      </div>
      <textarea
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Add comment… (Enter to save, Shift+Enter for newline)"
        rows={2}
        className="w-full px-2 py-1 text-[10px] rounded border border-amber-400 dark:border-amber-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
      />
      <div className="flex items-center gap-1">
        <button onClick={handleSave}
          className="flex-1 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white text-[9px] font-bold transition-colors">Save</button>
        <button onClick={handleClear}
          className="py-0.5 px-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-[9px] text-slate-400 transition-colors">Clear</button>
        <button onClick={e => { e.stopPropagation(); setOpen(false); }}
          className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 transition-colors">
          <X className="h-3 w-3"/>
        </button>
      </div>
    </div>
  );
});

const GSTIN_CELL_CLASS = 'max-w-[120px] whitespace-nowrap overflow-hidden text-ellipsis font-mono text-[10px]';

const ResultTable = ({ tabId, records, onDelete, onMarkMatched, manualTradeNames, onSaveTradeName, comments, onSaveComment, onRowClick }) => {
  const [search, setSearch] = useState('');
  const [page, setPage]     = useState(1);
  const filtered = records.filter(r => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const inv = tabId === 'booksOnly' ? r.books : r.portal;
    const manualName = (manualTradeNames?.[inv?.gstin] || '').toLowerCase();
    return (inv?.gstin||'').toLowerCase().includes(q)
      || (inv?.invoiceNoRaw||'').toLowerCase().includes(q)
      || (inv?.tradeOrLegalName||'').toLowerCase().includes(q)
      || manualName.includes(q);
  });
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  const totalValue = records.reduce((s,r)=>s+(tabId==='booksOnly'?r.books:r.portal)?.invoiceValue||0, 0);
  const totalTax   = records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.igst||0)+(inv?.cgst||0)+(inv?.sgst||0);}, 0);

  if (records.length === 0) return (
    <div className="flex flex-col items-center py-16 text-slate-400">
      <CheckCircle2 className="h-12 w-12 mb-3 text-slate-300"/>
      <p className="font-medium text-slate-500">No records in this category</p>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-sm">
        <span className="text-slate-500 whitespace-nowrap">Records: <strong className="text-slate-700 dark:text-slate-200">{records.length}</strong></span>
        <span className="text-slate-500 whitespace-nowrap">Total Value: <strong className="text-slate-700 dark:text-slate-200">₹{fmt(totalValue)}</strong></span>
        <span className="text-slate-500 whitespace-nowrap">Total Tax: <strong className="text-slate-700 dark:text-slate-200">₹{fmt(totalTax)}</strong></span>
        {tabId === 'matched' && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs whitespace-nowrap">
            <span className="w-3 h-3 rounded-sm bg-yellow-200 dark:bg-yellow-700 inline-block border border-yellow-400 flex-shrink-0"/>
            Yellow = prefix differs, values match
          </span>
        )}
        {tabId === 'matched' && records.some(r => r.normalizedMatch) && (
          <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 text-xs whitespace-nowrap">
            <span className="w-3 h-3 rounded-full bg-indigo-200 dark:bg-indigo-700 inline-block border border-indigo-400 flex-shrink-0"/>
            <strong>auto-matched ✓</strong> = portal &amp; books numbers differ in format (e.g. T1326 ↔ 1326)
          </span>
        )}
        {tabId === 'matched' && records.some(r => r.manualMatch) && (
          <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 text-xs whitespace-nowrap">
            <span className="w-3 h-3 rounded-full bg-indigo-200 dark:bg-indigo-700 inline-block border border-indigo-400 flex-shrink-0"/>
            <strong>✓ Manual</strong> = manually confirmed matched
          </span>
        )}
        {tabId === 'matched' && records.some(r => r.rcMismatch) && (
          <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400 text-xs whitespace-nowrap">
            <span className="w-3 h-3 rounded-full bg-violet-200 dark:bg-violet-700 inline-block border border-violet-400 flex-shrink-0"/>
            <strong>RCM</strong> = Reverse Charge flag differs (financially matched)
          </span>
        )}
      </div>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"/>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Search GSTIN, Invoice No, Party Name…" className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      </div>
      <div className={`rounded-xl border border-slate-200 dark:border-slate-700 ${tabId==='mismatch'?'overflow-x-hidden':'overflow-x-auto'}`}>
        <table className={`w-full ${tabId==='mismatch'?'text-[10px]':'text-xs min-w-[860px]'}`} style={tabId==='mismatch'?{tableLayout:'fixed'}:{}}>
          {tabId === 'mismatch' && (
            <colgroup>
              <col style={{width:'3%'}}/>
              <col style={{width:'9%'}}/>
              <col style={{width:'10%'}}/>
              <col style={{width:'8%'}}/>
              <col style={{width:'6%'}}/>
              <col style={{width:'7%'}}/>
              <col style={{width:'7%'}}/>
              <col style={{width:'5%'}}/>
              <col style={{width:'5%'}}/>
              <col style={{width:'5%'}}/>
              <col style={{width:'5%'}}/>
              <col style={{width:'17%'}}/>
              <col style={{width:'8%'}}/>
            </colgroup>
          )}
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap w-8">#</th>
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">GSTIN</th>
              {tabId !== 'booksOnly'
                ? <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Party Name</th>
                : <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Party Name
                    <span className="ml-1 text-[9px] font-normal text-indigo-500 dark:text-indigo-400">(click to add)</span>
                  </th>
              }
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Invoice No</th>
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Date</th>
              {tabId === 'mismatch' ? <>
                <th className="px-2 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">Portal ₹</th>
                <th className="px-2 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">Books ₹</th>
                <th className="px-2 py-2 text-right font-semibold text-amber-600">Diff ₹</th>
                <th className="px-2 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">P.Tax</th>
                <th className="px-2 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">B.Tax</th>
                <th className="px-2 py-2 text-right font-semibold text-amber-600">Tax Δ</th>
                <th className="px-2 py-2 text-left font-semibold text-amber-600">Fields</th>
              </> : <>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Value</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Taxable</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">IGST</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">CGST</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">SGST</th>
                {tabId === 'portalOnly' && <th className="px-3 py-2.5 text-center font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap min-w-[64px]">ITC</th>}
              </>}
              {(tabId === 'mismatch' || tabId === 'portalOnly' || tabId === 'booksOnly') && (
                <th className={`${tabId==='mismatch'?'px-2 py-2':'px-3 py-2.5'} text-center font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap`}>Status</th>
              )}
              {onDelete && <th className="px-3 py-2.5 text-center font-semibold text-slate-400 whitespace-nowrap">Del</th>}
              {onSaveComment && <th className="px-3 py-2.5 text-center font-semibold text-amber-500 whitespace-nowrap w-8" title="Add comment to this invoice"><MessageSquare className="h-3 w-3 inline"/></th>}
            </tr>
          </thead>
          <tbody>
            {paged.map((r, idx) => {
              const inv = tabId === 'booksOnly' ? r.books : r.portal;
              const n = (page-1)*PAGE_SIZE + idx + 1;
              const isPrefixRow = r.prefixMismatch === true;
              return (
                <tr key={r.key||idx}
                  onClick={() => onRowClick && onRowClick(r)}
                  className={`border-b border-slate-100 dark:border-slate-700/50 ${onRowClick ? 'cursor-pointer' : ''} ${isPrefixRow ? 'bg-yellow-50 dark:bg-yellow-900/20 hover:bg-yellow-100 dark:hover:bg-yellow-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}`}>
                  <td className={`${tabId==='mismatch'?'px-2 py-1.5':'px-3 py-2'} text-slate-400`}>{n}</td>
                  <td className={`${tabId==='mismatch'?'px-2 py-1.5':'px-3 py-2'} ${GSTIN_CELL_CLASS} text-slate-600 dark:text-slate-300`}>{inv?.gstin}</td>
                  {tabId === 'booksOnly'
                    ? <td className="px-3 py-2 min-w-[160px]">
                        <TradeNameCell
                          gstin={inv?.gstin || ''}
                          manualTradeNames={manualTradeNames}
                          onSave={onSaveTradeName}
                        />
                      </td>
                    : <td className={`${tabId==='mismatch'?'px-2 py-1.5 max-w-[90px]':"px-3 py-2 max-w-[140px]"} text-slate-700 dark:text-slate-200 truncate`} title={inv?.tradeOrLegalName || manualTradeNames?.[inv?.gstin] || ''}>
                        {inv?.tradeOrLegalName || manualTradeNames?.[inv?.gstin] || '—'}
                      </td>
                  }
                  <td className={`${tabId==='mismatch'?'px-2 py-1.5':'px-3 py-2'} font-medium text-slate-700 dark:text-slate-200`}>
                    {tabId === 'mismatch' ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-blue-600 dark:text-blue-400 text-[10px] font-mono leading-tight">{r.portal?.invoiceNoRaw || '—'}</span>
                        <span className="text-violet-600 dark:text-violet-400 text-[10px] font-mono leading-tight">{r.books?.invoiceNoRaw || '—'}</span>
                        {isPrefixRow && <span className="text-[8px] text-yellow-600 dark:text-yellow-400 font-semibold">prefix differs</span>}
                        {r.normalizedMatch && !isPrefixRow && <span className="text-[8px] text-indigo-500 dark:text-indigo-400 font-semibold">auto-matched ✓</span>}
                        {r.manualMatch && <span className="text-[8px] text-indigo-500 dark:text-indigo-400 font-semibold">✓ Manual</span>}
                      </span>
                    ) : isPrefixRow ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-blue-600 dark:text-blue-400 text-[10px] font-mono">{r.portal?.invoiceNoRaw}</span>
                        <span className="text-violet-600 dark:text-violet-400 text-[10px] font-mono">{r.books?.invoiceNoRaw}</span>
                        <span className="text-[9px] text-yellow-600 dark:text-yellow-400 font-semibold">prefix differs</span>
                      </span>
                    ) : r.normalizedMatch ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-blue-600 dark:text-blue-400 text-[10px] font-mono">{r.portal?.invoiceNoRaw}</span>
                        <span className="text-violet-600 dark:text-violet-400 text-[10px] font-mono">{r.books?.invoiceNoRaw}</span>
                        <span className="text-[9px] text-indigo-500 dark:text-indigo-400 font-semibold">auto-matched ✓</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span>{inv?.invoiceNoRaw}</span>
                        {r.rcMismatch && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 border border-violet-200 dark:border-violet-800">RCM</span>
                        )}
                        {r.manualMatch && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">✓ Manual</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className={`${tabId==='mismatch'?'px-2 py-1.5':'px-3 py-2'} text-slate-500 whitespace-nowrap`}>{inv?.invoiceDate}</td>
                  {tabId === 'mismatch' ? <>
                    <td className="px-2 py-1.5 text-right text-slate-700 dark:text-slate-200 whitespace-nowrap">
                      ₹{fmt(r.portal.invoiceValue)}
                      {r.isCreditNote && <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-slate-100 text-slate-500 dark:bg-slate-700">CN</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-700 dark:text-slate-200 whitespace-nowrap">₹{fmt(r.books.invoiceValue)}</td>
                    <td className={`px-2 py-1.5 text-right font-bold whitespace-nowrap ${r.valueDiff>0?'text-blue-600':'text-rose-600'}`}>{r.valueDiff>0?'+':''}{fmt(r.valueDiff)}</td>
                    <td className="px-2 py-1.5 text-right text-slate-500 whitespace-nowrap">₹{fmt(r.portal.igst+r.portal.cgst+r.portal.sgst)}</td>
                    <td className="px-2 py-1.5 text-right text-slate-500 whitespace-nowrap">₹{fmt(r.books.igst+r.books.cgst+r.books.sgst)}</td>
                    <td className={`px-2 py-1.5 text-right font-bold whitespace-nowrap ${r.taxDiff>0?'text-blue-600':'text-rose-600'}`}>{r.taxDiff>0?'+':''}{fmt(r.taxDiff)}</td>
                    <td className="px-2 py-1.5 min-w-0">
                      {/* All badges on ONE line */}
                      <div className="flex flex-wrap items-center gap-0.5">
                        {r.severity && (
                          <span className={`px-1 py-px rounded text-[8px] font-bold whitespace-nowrap
                            ${r.severity==='high'   ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                            : r.severity==='medium' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                            :                         'bg-slate-100 text-slate-500 dark:bg-slate-700'}`}>
                            {r.severity==='high' ? '⚠ HIGH' : r.severity==='medium' ? '~ MED' : '↓ LOW'}
                          </span>
                        )}
                        {(r.mismatchFields||[]).map(f => (
                          <span key={f} className="px-1 py-px rounded text-[8px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">{f}</span>
                        ))}
                        {r.rcMismatch && (
                          <span className="px-1 py-px rounded text-[8px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 whitespace-nowrap">RCM flag</span>
                        )}
                        {r.valueGstinMatch && (
                          <span className="px-1 py-px rounded text-[8px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 whitespace-nowrap">Val-match</span>
                        )}
                      </div>
                      {/* Reason + action below badges */}
                      {r.mismatchReason && (
                        <p className="text-[9px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug break-words">{r.mismatchReason}</p>
                      )}
                      {r.suggestedAction && (
                        <p className="text-[9px] text-indigo-600 dark:text-indigo-400 mt-0.5 leading-snug italic break-words">→ {r.suggestedAction}</p>
                      )}
                    </td>
                  </> : <>
                    <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-200">
                      ₹{fmt(inv?.invoiceValue)}
                      {inv?.invoiceValue < 0 && <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-slate-100 text-slate-500 dark:bg-slate-700">CN</span>}
                      {tabId === 'portalOnly' && r.possibleGstinTypo && (
                        <span title={r.typoNote} className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 cursor-help">⚠ GSTIN?</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500">₹{fmt(inv?.taxableValue)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{fmt(inv?.igst)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{fmt(inv?.cgst)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{fmt(inv?.sgst)}</td>
                    {tabId === 'portalOnly' && <td className="px-3 py-2 text-center min-w-[64px]">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${inv?.itcAvailability?.toLowerCase()==='yes'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}`}>{inv?.itcAvailability||'—'}</span>
                    </td>}
                  </>}
                  {/* Per-row Matching / Not Matching status toggle */}
                  {(tabId === 'mismatch' || tabId === 'portalOnly' || tabId === 'booksOnly') && (
                    <td className="px-1 py-1.5 text-center" onClick={e => e.stopPropagation()}>
                      <div className="flex flex-col items-center gap-0.5">
                        {onMarkMatched ? (
                          <button
                            onClick={() => onMarkMatched(r)}
                            title="Mark as matched"
                            className="flex items-center justify-center gap-0.5 w-full px-1 py-0.5 rounded text-[9px] font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-200 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 dark:text-emerald-400 dark:border-emerald-800 transition-colors whitespace-nowrap"
                          >
                            <CheckCircle2 className="h-2 w-2 flex-shrink-0"/> Match
                          </button>
                        ) : null}
                        <span className="flex items-center justify-center gap-0.5 w-full px-1 py-0.5 rounded text-[9px] font-bold bg-rose-50 text-rose-500 border border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800 whitespace-nowrap">
                          <X className="h-2 w-2 flex-shrink-0"/> No
                        </span>
                      </div>
                    </td>
                  )}
                  {onDelete && (
                    <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => onDelete(r)}
                        title="Remove this entry from reconciliation"
                        className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-slate-300 hover:text-rose-500 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                  {onSaveComment && (
                    <td className="px-2 py-2 text-center min-w-[36px]" onClick={e => e.stopPropagation()}>
                      <CommentCell
                        rowKey={r.key || `${inv?.gstin}__${inv?.invoiceNo || inv?.invoiceNoRaw}`}
                        comments={comments}
                        onSave={onSaveComment}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {/* ── Totals footer ─────────────────────────────────────────────── */}
          <tfoot>
            <tr className="bg-slate-100 dark:bg-slate-800/80 border-t-2 border-slate-300 dark:border-slate-600 font-bold text-slate-700 dark:text-slate-200 text-xs">
              <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 whitespace-nowrap">TOTAL</td>
              <td className="px-3 py-2.5 text-[10px] text-slate-400">{filtered.length} rows</td>
              <td className="px-3 py-2.5"/>
              <td className="px-3 py-2.5"/>
              <td className="px-3 py-2.5"/>
              {tabId === 'mismatch' ? <>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  ₹{fmt(records.reduce((s,r)=>s+(r.portal?.invoiceValue||0),0))}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  ₹{fmt(records.reduce((s,r)=>s+(r.books?.invoiceValue||0),0))}
                </td>
                <td className={`px-3 py-2.5 text-right whitespace-nowrap ${records.reduce((s,r)=>s+(r.valueDiff||0),0)>=0?'text-blue-700 dark:text-blue-400':'text-rose-700 dark:text-rose-400'}`}>
                  ₹{fmt(records.reduce((s,r)=>s+(r.valueDiff||0),0))}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  ₹{fmt(records.reduce((s,r)=>s+((r.portal?.igst||0)+(r.portal?.cgst||0)+(r.portal?.sgst||0)),0))}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  ₹{fmt(records.reduce((s,r)=>s+((r.books?.igst||0)+(r.books?.cgst||0)+(r.books?.sgst||0)),0))}
                </td>
                <td className={`px-3 py-2.5 text-right whitespace-nowrap ${records.reduce((s,r)=>s+(r.taxDiff||0),0)>=0?'text-blue-700 dark:text-blue-400':'text-rose-700 dark:text-rose-400'}`}>
                  ₹{fmt(records.reduce((s,r)=>s+(r.taxDiff||0),0))}
                </td>
                <td className="px-3 py-2.5"/>
              </> : <>
                <td className="px-3 py-2.5 text-right">
                  ₹{fmt(records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.invoiceValue||0);},0))}
                </td>
                <td className="px-3 py-2.5 text-right">
                  ₹{fmt(records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.taxableValue||0);},0))}
                </td>
                <td className="px-3 py-2.5 text-right">
                  ₹{fmt(records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.igst||0);},0))}
                </td>
                <td className="px-3 py-2.5 text-right">
                  ₹{fmt(records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.cgst||0);},0))}
                </td>
                <td className="px-3 py-2.5 text-right">
                  ₹{fmt(records.reduce((s,r)=>{const inv=tabId==='booksOnly'?r.books:r.portal;return s+(inv?.sgst||0);},0))}
                </td>
                {tabId==='portalOnly' && <td className="px-3 py-2.5"/>}
              </>}
              {(tabId==='mismatch'||tabId==='portalOnly'||tabId==='booksOnly') && <td className="px-3 py-2.5"/>}
              {onDelete && <td className="px-3 py-2.5"/>}
              {onSaveComment && <td className="px-3 py-2.5"/>}
            </tr>
          </tfoot>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs">
          <span className="text-slate-500">Showing {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE, filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Prev</button>
            <span className="py-1.5 text-slate-500">Page {page}/{totalPages}</span>
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Next</button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   CHECK ONE TAB — Side-by-side prefix-mismatch invoice comparison
═══════════════════════════════════════════════════════════════════════════ */
const CheckOneTab = ({ records }) => {
  const [subTab, setSubTab]   = useState('matching');   // 'matching' | 'notMatching'
  const [search, setSearch]   = useState('');
  const [page, setPage]       = useState(1);

  const matching    = records.filter(r => r.allOtherMatch);
  const notMatching = records.filter(r => !r.allOtherMatch);
  const list        = subTab === 'matching' ? matching : notMatching;

  const filtered = list.filter(r => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (r.portal?.gstin||'').toLowerCase().includes(q) ||
      (r.portal?.invoiceNoRaw||'').toLowerCase().includes(q) ||
      (r.books?.invoiceNoRaw||'').toLowerCase().includes(q) ||
      (r.portal?.tradeOrLegalName||'').toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged      = filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);

  const COLS = ['GSTIN','Party Name','Portal Invoice No','Books Invoice No','Date','Invoice Value','Taxable','IGST','CGST','SGST','Place','Status'];

  const fieldRow = (label, pVal, bVal, match) => (
    <div key={label} className={`flex items-center gap-2 py-1 px-2 rounded text-xs ${match ? '' : 'bg-rose-50 dark:bg-rose-900/20'}`}>
      <span className="w-28 text-slate-500 shrink-0 font-medium">{label}</span>
      <span className="flex-1 font-mono text-blue-700 dark:text-blue-300 truncate">{pVal ?? '—'}</span>
      <span className={`w-4 text-center ${match ? 'text-emerald-500' : 'text-rose-500'}`}>{match ? '✓' : '✗'}</span>
      <span className="flex-1 font-mono text-violet-700 dark:text-violet-300 truncate text-right">{bVal ?? '—'}</span>
    </div>
  );

  if (records.length === 0) return (
    <div className="flex flex-col items-center py-16 text-slate-400">
      <CheckCircle2 className="h-12 w-12 mb-3 text-slate-300"/>
      <p className="font-medium text-slate-500">No prefix-only mismatches found</p>
      <p className="text-xs mt-1">All invoices either matched exactly or have differing values.</p>
    </div>
  );

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500 inline-block"/>Portal Invoice No</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-violet-500 inline-block"/>Books Invoice No</span>
        <span className="text-slate-400 ml-auto">Total prefix-mismatches: <strong className="text-slate-700 dark:text-slate-200">{records.length}</strong></span>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-700/60 rounded-xl mb-4 w-fit">
        {[
          { id:'matching',    label:`Matching (${matching.length})`,    color:'text-emerald-600' },
          { id:'notMatching', label:`Not Matching (${notMatching.length})`, color:'text-rose-600' },
        ].map(st => (
          <button key={st.id} onClick={()=>{setSubTab(st.id);setPage(1);}}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${subTab===st.id ? 'bg-white dark:bg-slate-800 shadow-sm '+st.color : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
            {st.label}
          </button>
        ))}
      </div>

      {/* Info banner */}
      {subTab === 'matching' && matching.length > 0 && (
        <div className="flex items-start gap-2 p-3 mb-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0"/>
          <span>These invoices have <strong>only a prefix difference</strong> in invoice number — all financial values, date, GSTIN, and place of supply match. They are counted as <strong>Matched</strong> and highlighted yellow there.</span>
        </div>
      )}
      {subTab === 'notMatching' && notMatching.length > 0 && (
        <div className="flex items-start gap-2 p-3 mb-4 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0"/>
          <span>These invoices have a prefix difference AND value/date mismatches. The portal record stays in <strong>Portal Only</strong> and the books record stays in <strong>Books Only</strong>.</span>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"/>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}
          placeholder="Search GSTIN, Invoice No, Party Name…"
          className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"/>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <table className="w-full text-xs min-w-[1000px]">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">#</th>
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">GSTIN</th>
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Party Name</th>
              <th className="px-3 py-2.5 text-left font-semibold text-blue-600 dark:text-blue-400 whitespace-nowrap">Portal Invoice No</th>
              <th className="px-3 py-2.5 text-left font-semibold text-violet-600 dark:text-violet-400 whitespace-nowrap">Books Invoice No</th>
              <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Date</th>
              <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">Invoice Value</th>
              <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">Taxable</th>
              <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">IGST</th>
              <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">CGST</th>
              <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">SGST</th>
              <th className="px-3 py-2.5 text-center font-semibold text-slate-600 dark:text-slate-300">Status</th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr><td colSpan={12} className="py-12 text-center text-slate-400 text-sm">No records found</td></tr>
            )}
            {paged.map((r, idx) => {
              const p = r.portal, b = r.books;
              const n = (page-1)*PAGE_SIZE + idx + 1;
              const valMatch  = Math.abs((p?.invoiceValue||0) - (b?.invoiceValue||0)) <= TOLERANCE;
              const taxMatch  = Math.abs(((p?.igst||0)+(p?.cgst||0)+(p?.sgst||0)) - ((b?.igst||0)+(b?.cgst||0)+(b?.sgst||0))) <= TOLERANCE;
              const dateMatch = !p?.invoiceDate || !b?.invoiceDate || dateMatches(p.invoiceDate, b.invoiceDate);
              const rowBg     = r.allOtherMatch
                ? 'bg-emerald-50/60 dark:bg-emerald-900/10'
                : 'bg-rose-50/60 dark:bg-rose-900/10';
              return (
                <tr key={r.key||idx} className={`border-b border-slate-100 dark:border-slate-700/50 ${rowBg}`}>
                  <td className="px-3 py-2 text-slate-400">{n}</td>
                  <td className={`px-3 py-2 ${GSTIN_CELL_CLASS} text-slate-600 dark:text-slate-300`}>{p?.gstin}</td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-200 max-w-[120px] truncate" title={p?.tradeOrLegalName}>{p?.tradeOrLegalName||'—'}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-blue-600 dark:text-blue-400">{p?.invoiceNoRaw}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-violet-600 dark:text-violet-400">{b?.invoiceNoRaw}</td>
                  <td className={`px-3 py-2 whitespace-nowrap ${dateMatch ? 'text-slate-500' : 'text-rose-600 font-semibold'}`}>
                    {dateMatch ? p?.invoiceDate : <><span className="block text-blue-600">{p?.invoiceDate}</span><span className="block text-violet-600">{b?.invoiceDate}</span></>}
                  </td>
                  <td className={`px-3 py-2 text-right ${valMatch ? 'text-slate-700 dark:text-slate-200' : 'text-rose-600 font-semibold'}`}>
                    {valMatch ? `₹${fmt(p?.invoiceValue)}` : <><span className="block text-blue-600">₹{fmt(p?.invoiceValue)}</span><span className="block text-violet-600">₹{fmt(b?.invoiceValue)}</span></>}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">₹{fmt(p?.taxableValue)}</td>
                  <td className={`px-3 py-2 text-right ${Math.abs((p?.igst||0)-(b?.igst||0))<=TOLERANCE?'text-slate-500':'text-rose-600 font-semibold'}`}>{fmt(p?.igst)}</td>
                  <td className={`px-3 py-2 text-right ${Math.abs((p?.cgst||0)-(b?.cgst||0))<=TOLERANCE?'text-slate-500':'text-rose-600 font-semibold'}`}>{fmt(p?.cgst)}</td>
                  <td className={`px-3 py-2 text-right ${Math.abs((p?.sgst||0)-(b?.sgst||0))<=TOLERANCE?'text-slate-500':'text-rose-600 font-semibold'}`}>{fmt(p?.sgst)}</td>
                  <td className="px-3 py-2 text-center">
                    {r.allOtherMatch
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3"/>Matched</span>
                      : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"><AlertTriangle className="h-3 w-3"/>Mismatch</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs">
          <span className="text-slate-500">Showing {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Prev</button>
            <span className="py-1.5 text-slate-500">Page {page}/{totalPages}</span>
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Next</button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   INVOICE DETAIL MODAL — click any row to see full invoice details
   Shows all fields for both portal and books side by side (for pairs)
═══════════════════════════════════════════════════════════════════════════ */
const InvoiceDetailModal = ({ record, tabId, manualTradeNames, comments, onClose }) => {
  if (!record) return null;

  // Normalise: extract portal/books invoice objects regardless of tab
  const p = record.portal?.portal || record.portal || null;
  const b = record.books?.books   || record.books  || null;
  const inv = tabId === 'booksOnly' ? b : (p || b);
  const isPair = !!(p && b);

  const Field = ({ label, pVal, bVal, highlight: hl }) => {
    const differs = isPair && pVal != null && bVal != null && String(pVal) !== String(bVal);
    return (
      <div className={`flex flex-col gap-0.5 p-2 rounded-lg ${differs ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800' : 'bg-slate-50 dark:bg-slate-800/50'}`}>
        <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
        {isPair ? (
          <div className="flex gap-2">
            <span className={`flex-1 text-xs font-medium truncate ${differs ? 'text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-200'}`} title={pVal}>
              {pVal ?? '—'}
            </span>
            <span className="text-slate-300 text-xs">|</span>
            <span className={`flex-1 text-xs font-medium truncate ${differs ? 'text-violet-700 dark:text-violet-300' : 'text-slate-700 dark:text-slate-200'}`} title={bVal}>
              {bVal ?? '—'}
            </span>
          </div>
        ) : (
          <span className={`text-xs font-medium truncate ${hl ? 'text-indigo-700 dark:text-indigo-300 font-bold' : 'text-slate-700 dark:text-slate-200'}`}>{pVal ?? bVal ?? '—'}</span>
        )}
        {differs && <span className="text-[9px] text-red-500 font-semibold">⚠ Differs</span>}
      </div>
    );
  };

  const MoneyField = ({ label, pVal, bVal }) => {
    const pN = parseFloat(pVal)||0, bN = parseFloat(bVal)||0;
    const differs = isPair && Math.abs(pN - bN) > 0.5;
    return (
      <div className={`flex flex-col gap-0.5 p-2 rounded-lg ${differs ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800' : 'bg-slate-50 dark:bg-slate-800/50'}`}>
        <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
        {isPair ? (
          <div className="flex gap-2">
            <span className={`flex-1 text-xs font-semibold ${differs ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300'}`}>₹{fmt(pN)}</span>
            <span className="text-slate-300 text-xs">|</span>
            <span className={`flex-1 text-xs font-semibold ${differs ? 'text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-300'}`}>₹{fmt(bN)}</span>
          </div>
        ) : (
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">₹{fmt(pN || bN)}</span>
        )}
        {differs && <span className="text-[9px] text-red-500 font-semibold">Diff: ₹{fmt(Math.abs(pN-bN))}</span>}
      </div>
    );
  };

  const pName = p?.tradeOrLegalName || manualTradeNames?.[p?.gstin] || '';
  const bName = b?.tradeOrLegalName || manualTradeNames?.[b?.gstin] || '';
  const rowKey = record.key || `${(p||b)?.gstin}__${(p||b)?.invoiceNo}`;
  const comment = comments?.[rowKey] || '';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-emerald-900/60 backdrop-blur-sm" onClick={onClose}/>
      <motion.div
        initial={{opacity:0,scale:0.96,y:12}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:0.96,y:12}}
        className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto"
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-3 ${isPair ? 'bg-gradient-to-r from-blue-600 via-violet-600 to-indigo-600' : 'bg-gradient-to-r from-indigo-600 to-blue-600'}`}>
          <div>
            <h2 className="text-sm font-bold text-white">Invoice Details</h2>
            <p className="text-[11px] text-white/75 mt-0.5">
              {isPair ? `Portal: ${p?.gstin} ↔ Books: ${b?.gstin}` : `${inv?.gstin} — ${inv?.invoiceNoRaw || inv?.invoiceNo}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white"><X className="h-4 w-4"/></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Pair label row */}
          {isPair && (
            <div className="flex gap-3 text-xs font-bold">
              <div className="flex-1 flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-blue-700 dark:text-blue-300 border border-blue-200">
                <Globe className="h-3 w-3"/> Portal (GSTR-2B)
              </div>
              <div className="flex-1 flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 dark:bg-violet-900/30 rounded-lg text-violet-700 dark:text-violet-300 border border-violet-200">
                <BookOpen className="h-3 w-3"/> Books (Purchase Register)
              </div>
            </div>
          )}

          {/* Core identity */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Identity</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="GSTIN" pVal={p?.gstin} bVal={b?.gstin}/>
              <Field label="Party Name" pVal={pName||p?.tradeOrLegalName||'—'} bVal={bName||b?.tradeOrLegalName||'—'}/>
              <Field label="Invoice No" pVal={p?.invoiceNoRaw||p?.invoiceNo} bVal={b?.invoiceNoRaw||b?.invoiceNo}/>
              <Field label="Invoice Date" pVal={p?.invoiceDate} bVal={b?.invoiceDate}/>
              <Field label="Invoice Type" pVal={p?.invoiceType||'B2B'} bVal={b?.invoiceType||'B2B'}/>
              <Field label="Place of Supply" pVal={p?.placeOfSupply} bVal={b?.placeOfSupply}/>
            </div>
          </div>

          {/* Financial */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Financial Values</p>
            <div className="grid grid-cols-3 gap-2">
              <MoneyField label="Invoice Value"  pVal={p?.invoiceValue}  bVal={b?.invoiceValue}/>
              <MoneyField label="Taxable Value"  pVal={p?.taxableValue}  bVal={b?.taxableValue}/>
              <MoneyField label="IGST"           pVal={p?.igst}          bVal={b?.igst}/>
              <MoneyField label="CGST"           pVal={p?.cgst}          bVal={b?.cgst}/>
              <MoneyField label="SGST"           pVal={p?.sgst}          bVal={b?.sgst}/>
              <MoneyField label="Cess"           pVal={p?.cess}          bVal={b?.cess}/>
            </div>
          </div>

          {/* Additional */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Additional Info</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Reverse Charge"   pVal={p?.reverseCharge||'N'} bVal={b?.reverseCharge||'N'}/>
              <Field label="ITC Availability" pVal={p?.itcAvailability||'—'} bVal={b?.itcAvailability||'—'}/>
              <Field label="Filing Date"      pVal={p?.filingDate||'—'}   bVal={b?.filingDate||'—'}/>
              <Field label="GST Rate"         pVal={p?.rate ? `${p.rate}%` : '—'} bVal={b?.rate ? `${b.rate}%` : '—'}/>
            </div>
          </div>

          {/* Mismatch reason (if any) */}
          {record.mismatchReason && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-700">
              <p className="text-[10px] font-bold uppercase tracking-wide text-amber-600 mb-1">AI Analysis</p>
              <p className="text-xs text-amber-800 dark:text-amber-300">{record.mismatchReason}</p>
              {record.suggestedAction && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 italic">→ {record.suggestedAction}</p>}
            </div>
          )}

          {/* Comment */}
          {comment && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200">
              <p className="text-[10px] font-bold uppercase tracking-wide text-amber-600 mb-1">💬 Comment</p>
              <p className="text-xs text-amber-800 dark:text-amber-300 whitespace-pre-wrap">{comment}</p>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   CROSS-GSTIN TABLE — dedicated view for GSTIN-conflict invoice pairs
   Shows portal vs books side by side with full diff highlighting
═══════════════════════════════════════════════════════════════════════════ */
const CrossGstinTable = ({ records, manualTradeNames, onSaveTradeName, comments, onSaveComment, onConfirmMatch, onRowClick }) => {
  const [search, setSearch] = useState('');
  const [page,   setPage]   = useState(1);

  const filtered = records.filter(r => {
    if (!search.trim()) return true;
    const q  = search.toLowerCase();
    const p  = r.portal?.portal || r.portal;
    const b  = r.books?.books   || r.books;
    const pN = (p?.tradeOrLegalName || manualTradeNames?.[p?.gstin] || '').toLowerCase();
    const bN = (b?.tradeOrLegalName || manualTradeNames?.[b?.gstin] || '').toLowerCase();
    return (p?.gstin||'').toLowerCase().includes(q) ||
           (b?.gstin||'').toLowerCase().includes(q) ||
           (p?.invoiceNoRaw||p?.invoiceNo||'').toLowerCase().includes(q) ||
           (b?.invoiceNoRaw||b?.invoiceNo||'').toLowerCase().includes(q) ||
           pN.includes(q) || bN.includes(q);
  });

  const totalPages   = Math.ceil(filtered.length / PAGE_SIZE);
  const paged        = filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  const totalPortal  = records.reduce((s,r) => s+((r.portal?.portal||r.portal)?.invoiceValue||0), 0);
  const totalBooks   = records.reduce((s,r) => s+((r.books?.books||r.books)?.invoiceValue||0), 0);

  if (records.length === 0) return (
    <div className="flex flex-col items-center py-16 text-slate-400">
      <CheckCircle2 className="h-12 w-12 mb-3 text-emerald-300"/>
      <p className="font-semibold text-slate-500 text-base">No GSTIN Conflicts Found!</p>
      <p className="text-sm mt-1">All invoices matched with consistent GSTINs across Portal and Books.</p>
    </div>
  );

  return (
    <div>
      {/* Critical warning */}
      <div className="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-300 dark:border-red-700 mb-4 text-xs text-red-800 dark:text-red-300">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-600"/>
        <div>
          <strong className="text-red-700 dark:text-red-300">⚡ CRITICAL — GSTIN Conflict Detected:</strong>
          {' '}{records.length} invoice pair(s) have matching invoice numbers &amp; values in Portal and Books, but under <strong>DIFFERENT GSTINs</strong>.
          ITC claim may be <strong>invalid</strong> if the wrong GSTIN is in books. Verify each pair with the vendor and correct books before filing GSTR-3B.
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-sm">
        <span className="text-slate-500">Conflicts: <strong className="text-red-600 dark:text-red-400">{records.length}</strong></span>
        <span className="text-slate-500">Portal Value: <strong className="text-blue-700 dark:text-blue-300">₹{fmt(totalPortal)}</strong></span>
        <span className="text-slate-500">Books Value: <strong className="text-violet-700 dark:text-violet-300">₹{fmt(totalBooks)}</strong></span>
        <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-200 font-bold">HIGH SEVERITY — Review Before Filing</span>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"/>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Search GSTIN, Invoice No, Party Name…"
          className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500"/>
      </div>

      <div className="overflow-x-auto rounded-xl border border-orange-200 dark:border-orange-800">
        <table className="w-full text-xs min-w-[1100px]">
          <thead>
            {/* Section headers */}
            <tr>
              <th className="px-2 py-1.5 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 w-8"/>
              <th colSpan={5} className="px-3 py-1.5 text-center font-bold text-blue-700 bg-blue-50 dark:bg-blue-900/30 border-b border-slate-200 dark:border-slate-700">
                🌐 GST Portal (GSTR-2B)
              </th>
              <th className="px-2 py-1.5 text-center font-bold text-orange-600 bg-orange-50 dark:bg-orange-900/20 border-b border-slate-200 dark:border-slate-700 w-14">Status</th>
              <th colSpan={5} className="px-3 py-1.5 text-center font-bold text-violet-700 bg-violet-50 dark:bg-violet-900/30 border-b border-slate-200 dark:border-slate-700">
                📒 Books (Purchase Register)
              </th>
              <th className="px-2 py-1.5 text-center font-bold text-slate-500 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700" colSpan={2}>Actions</th>
            </tr>
            {/* Column headers */}
            <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
              <th className="px-2 py-2 text-slate-400 font-semibold text-center">#</th>
              <th className="px-3 py-2 text-blue-600 font-semibold whitespace-nowrap">GSTIN</th>
              <th className="px-3 py-2 text-blue-600 font-semibold whitespace-nowrap">Party</th>
              <th className="px-3 py-2 text-blue-600 font-semibold whitespace-nowrap">Invoice No</th>
              <th className="px-3 py-2 text-blue-600 font-semibold whitespace-nowrap">Date</th>
              <th className="px-3 py-2 text-right text-blue-600 font-semibold whitespace-nowrap">Value ₹</th>
              <th className="px-2 py-2 text-center text-orange-500 font-semibold bg-orange-50/50 dark:bg-orange-900/10">⚡</th>
              <th className="px-3 py-2 text-violet-600 font-semibold whitespace-nowrap">GSTIN</th>
              <th className="px-3 py-2 text-violet-600 font-semibold whitespace-nowrap">Party</th>
              <th className="px-3 py-2 text-violet-600 font-semibold whitespace-nowrap">Invoice No</th>
              <th className="px-3 py-2 text-violet-600 font-semibold whitespace-nowrap">Date</th>
              <th className="px-3 py-2 text-right text-violet-600 font-semibold whitespace-nowrap">Value ₹</th>
              <th className="px-2 py-2 text-center text-slate-500 font-semibold whitespace-nowrap">💬</th>
              <th className="px-2 py-2 text-center text-slate-500 font-semibold whitespace-nowrap">Resolve</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((r, idx) => {
              const p     = r.portal?.portal || r.portal;
              const b     = r.books?.books   || r.books;
              const pName = p?.tradeOrLegalName || manualTradeNames?.[p?.gstin] || '—';
              const bName = b?.tradeOrLegalName || manualTradeNames?.[b?.gstin] || '—';
              const rowKey = r.key || `cg_${idx}`;
              const valDiff  = Math.abs((p?.invoiceValue||0) - (b?.invoiceValue||0));
              const dateDiff = p?.invoiceDate && b?.invoiceDate && !dateMatches(p.invoiceDate, b.invoiceDate);
              return (
                <tr key={idx}
                  className="border-b border-orange-100 dark:border-orange-900/30 hover:bg-orange-50/40 dark:hover:bg-orange-900/10 cursor-pointer transition-colors"
                  onClick={() => onRowClick && onRowClick(r)}
                >
                  <td className="px-2 py-2 text-center text-slate-400">{(page-1)*PAGE_SIZE+idx+1}</td>
                  {/* Portal side */}
                  <td className="px-3 py-2">
                    <span className="font-mono text-[10px] text-blue-700 dark:text-blue-400 font-bold">{p?.gstin||'—'}</span>
                  </td>
                  <td className="px-3 py-2 max-w-[120px] truncate text-slate-700 dark:text-slate-200" title={pName}>{pName}</td>
                  <td className="px-3 py-2 font-mono font-bold text-blue-700 dark:text-blue-300 whitespace-nowrap">{p?.invoiceNoRaw||p?.invoiceNo||'—'}</td>
                  <td className={`px-3 py-2 whitespace-nowrap text-[11px] ${dateDiff?'text-red-500 font-semibold':'text-slate-500'}`}>{p?.invoiceDate||'—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-blue-700 dark:text-blue-300 whitespace-nowrap">₹{fmt(p?.invoiceValue||0)}</td>
                  {/* Status */}
                  <td className="px-2 py-2 text-center bg-orange-50/40 dark:bg-orange-900/10 border-l border-r border-orange-200 dark:border-orange-800">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[8px] font-bold text-red-600 bg-red-100 px-1 py-0.5 rounded border border-red-200">GSTIN≠</span>
                      {r.valuesIdentical && <span className="text-[8px] text-emerald-600 font-bold">val ✓</span>}
                      {valDiff > 0.01 && <span className="text-[8px] text-amber-600">Δ{fmt(valDiff)}</span>}
                      {dateDiff && <span className="text-[8px] text-orange-600 font-bold">date≠</span>}
                    </div>
                  </td>
                  {/* Books side */}
                  <td className="px-3 py-2">
                    <span className="font-mono text-[10px] text-violet-700 dark:text-violet-400 font-bold">{b?.gstin||'—'}</span>
                  </td>
                  <td className="px-3 py-2 min-w-[120px]" onClick={e=>e.stopPropagation()}>
                    <TradeNameCell gstin={b?.gstin||''} manualTradeNames={manualTradeNames} onSave={onSaveTradeName}/>
                  </td>
                  <td className="px-3 py-2 font-mono font-bold text-violet-700 dark:text-violet-300 whitespace-nowrap">{b?.invoiceNoRaw||b?.invoiceNo||'—'}</td>
                  <td className={`px-3 py-2 whitespace-nowrap text-[11px] ${dateDiff?'text-red-500 font-semibold':'text-slate-500'}`}>{b?.invoiceDate||'—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-violet-700 dark:text-violet-300 whitespace-nowrap">₹{fmt(b?.invoiceValue||0)}</td>
                  {/* Comment */}
                  <td className="px-2 py-2 text-center" onClick={e=>e.stopPropagation()}>
                    {onSaveComment && <CommentCell rowKey={rowKey} comments={comments} onSave={onSaveComment}/>}
                  </td>
                  {/* Resolve action */}
                  <td className="px-2 py-2 text-center" onClick={e=>e.stopPropagation()}>
                    <button
                      onClick={() => onConfirmMatch && onConfirmMatch(r)}
                      title="Confirm these are the same invoice — moves to Matched"
                      className="px-2 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors whitespace-nowrap"
                    >
                      Resolve ✓
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/* Totals footer */}
          <tfoot>
            <tr className="bg-slate-100 dark:bg-slate-800 border-t-2 border-orange-200 dark:border-orange-800 font-bold text-xs">
              <td className="px-3 py-2.5 text-slate-500">TOTAL</td>
              <td className="px-3 py-2.5 text-[10px] text-slate-400" colSpan={4}>{filtered.length} conflicts</td>
              <td className="px-3 py-2.5 text-right text-blue-700 dark:text-blue-300">₹{fmt(totalPortal)}</td>
              <td className="px-3 py-2.5"/>
              <td className="px-3 py-2.5" colSpan={4}/>
              <td className="px-3 py-2.5 text-right text-violet-700 dark:text-violet-300">₹{fmt(totalBooks)}</td>
              <td colSpan={2}/>
            </tr>
          </tfoot>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs">
          <span className="text-slate-500">Showing {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Prev</button>
            <span className="py-1.5 text-slate-500">Page {page}/{totalPages}</span>
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Next</button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   GLOBAL SEARCH TAB  — search across ALL categories simultaneously
═══════════════════════════════════════════════════════════════════════════ */

// Category metadata used in the search tab
const CAT_META = {
  matched:     { label: 'Matched',         short: 'Matched',     bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  mismatch:    { label: 'Amount Mismatch', short: 'Mismatch',    bg: 'bg-amber-100 dark:bg-amber-900/40',    text: 'text-amber-700 dark:text-amber-300',    dot: 'bg-amber-500'   },
  portalOnly:  { label: 'In Portal Only',  short: 'Portal Only', bg: 'bg-blue-100 dark:bg-blue-900/40',      text: 'text-blue-700 dark:text-blue-300',      dot: 'bg-blue-500'    },
  booksOnly:   { label: 'In Books Only',   short: 'Books Only',  bg: 'bg-rose-100 dark:bg-rose-900/40',      text: 'text-rose-700 dark:text-rose-300',      dot: 'bg-rose-500'    },
  crossGstin:  { label: 'GSTIN Conflict',  short: 'GSTIN≠',     bg: 'bg-orange-100 dark:bg-orange-900/40',  text: 'text-orange-700 dark:text-orange-300',   dot: 'bg-orange-500'  },
};

const SORT_COLS = [
  { id: 'invoiceNo',    label: 'Invoice No'    },
  { id: 'invoiceDate',  label: 'Date'          },
  { id: 'invoiceValue', label: 'Invoice Value' },
  { id: 'totalTax',     label: 'Total Tax'     },
  { id: 'gstin',        label: 'GSTIN'         },
  { id: 'partyName',    label: 'Party Name'    },
];

function highlight(text, query) {
  if (!query || !text) return text || '—';
  const str = String(text);
  const idx = str.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return str;
  return (
    <>
      {str.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-800 text-yellow-900 dark:text-yellow-100 rounded px-0.5 not-italic">
        {str.slice(idx, idx + query.length)}
      </mark>
      {str.slice(idx + query.length)}
    </>
  );
}

const GlobalSearchTab = ({ results }) => {
  const [query,       setQuery]       = useState('');
  const [catFilter,   setCatFilter]   = useState(['matched','mismatch','portalOnly','booksOnly','crossGstin']);
  const [minVal,      setMinVal]      = useState('');
  const [maxVal,      setMaxVal]      = useState('');
  const [dateFrom,    setDateFrom]    = useState('');
  const [dateTo,      setDateTo]      = useState('');
  const [sortCol,     setSortCol]     = useState('invoiceValue');
  const [sortDir,     setSortDir]     = useState('desc');
  const [page,        setPage]        = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const searchRef = useRef(null);

  // Focus search on mount
  React.useEffect(() => { searchRef.current?.focus(); }, []);

  // Flatten all records into a unified list
  const allRecords = React.useMemo(() => {
    const flat = [];
    const push = (arr, catId, invFn, extra = {}) =>
      arr.forEach(r => {
        const inv = invFn(r);
        flat.push({
          catId,
          gstin:        inv.gstin        || '',
          partyName:    inv.tradeOrLegalName || '',
          invoiceNo:    inv.invoiceNo    || '',
          invoiceNoRaw: inv.invoiceNoRaw || '',
          invoiceDate:  inv.invoiceDate  || '',
          invoiceValue: inv.invoiceValue || 0,
          taxableValue: inv.taxableValue || 0,
          igst:         inv.igst         || 0,
          cgst:         inv.cgst         || 0,
          sgst:         inv.sgst         || 0,
          cess:         inv.cess         || 0,
          totalTax:    (inv.igst||0) + (inv.cgst||0) + (inv.sgst||0),
          placeOfSupply: inv.placeOfSupply || '',
          itcAvailability: inv.itcAvailability || '',
          ...extra,
          _raw: r,
        });
      });

    push(results.matched,    'matched',    r => r.portal);
    push(results.mismatch,   'mismatch',   r => r.portal, { valueDiff: null, taxDiff: null,
      _valueDiff: r => r.valueDiff, _taxDiff: r => r.taxDiff });
    push(results.portalOnly, 'portalOnly', r => r.portal);
    push(results.booksOnly,  'booksOnly',  r => r.books);
    // Cross-GSTIN pairs — index by portal invoice
    (results.crossGstin||[]).forEach(r => {
      const p = r.portal?.portal || r.portal;
      const b = r.books?.books   || r.books;
      if (!p) return;
      flat.push({
        catId: 'crossGstin',
        gstin:        p.gstin         || '',
        partyName:    p.tradeOrLegalName || '',
        invoiceNo:    p.invoiceNo     || '',
        invoiceNoRaw: p.invoiceNoRaw  || '',
        invoiceDate:  p.invoiceDate   || '',
        invoiceValue: p.invoiceValue  || 0,
        taxableValue: p.taxableValue  || 0,
        igst:         p.igst          || 0,
        cgst:         p.cgst          || 0,
        sgst:         p.sgst          || 0,
        cess:         p.cess          || 0,
        totalTax:    (p.igst||0) + (p.cgst||0) + (p.sgst||0),
        placeOfSupply: p.placeOfSupply || '',
        // Extra for search display
        booksGstin:  b?.gstin         || '',
        _raw: r,
      });
    });

    // Re-attach mismatch diffs
    flat.forEach(item => {
      if (item.catId === 'mismatch') {
        item.valueDiff = item._raw.valueDiff;
        item.taxDiff   = item._raw.taxDiff;
      }
    });

    return flat;
  }, [results]);

  // Filter
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const minV = minVal !== '' ? parseFloat(minVal) : null;
    const maxV = maxVal !== '' ? parseFloat(maxVal) : null;

    return allRecords.filter(r => {
      if (!catFilter.includes(r.catId)) return false;

      if (q) {
        const hit =
          r.gstin.toLowerCase().includes(q) ||
          r.partyName.toLowerCase().includes(q) ||
          r.invoiceNoRaw.toLowerCase().includes(q) ||
          r.invoiceDate.toLowerCase().includes(q) ||
          r.placeOfSupply.toLowerCase().includes(q) ||
          CAT_META[r.catId].label.toLowerCase().includes(q);
        if (!hit) return false;
      }

      if (minV !== null && r.invoiceValue < minV) return false;
      if (maxV !== null && r.invoiceValue > maxV) return false;

      // Date filter — simple string prefix match (works for DD/MM/YYYY and YYYY-MM-DD)
      if (dateFrom && r.invoiceDate && r.invoiceDate < dateFrom.split('-').reverse().join('/')) return false;
      if (dateTo   && r.invoiceDate && r.invoiceDate > dateTo.split('-').reverse().join('/'))   return false;

      return true;
    });
  }, [allRecords, query, catFilter, minVal, maxVal, dateFrom, dateTo]);

  // Sort
  const sorted = React.useMemo(() => {
    return [...filtered].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, sortCol, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleCat = id => {
    setCatFilter(prev =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter(c => c !== id) : prev) : [...prev, id]
    );
    setPage(1);
  };

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
    setPage(1);
  };

  const SortIcon = ({ col }) => (
    sortCol === col
      ? <ArrowUpDown className={`h-3 w-3 ml-1 inline ${sortDir === 'asc' ? 'rotate-0' : 'rotate-180'} transition-transform`}/>
      : <ChevronsUpDown className="h-3 w-3 ml-1 inline opacity-30"/>
  );

  const totalValue = filtered.reduce((s, r) => s + r.invoiceValue, 0);
  const totalTax   = filtered.reduce((s, r) => s + r.totalTax, 0);

  const catCounts = React.useMemo(() => {
    const c = { matched: 0, mismatch: 0, portalOnly: 0, booksOnly: 0 };
    filtered.forEach(r => { c[r.catId] = (c[r.catId] || 0) + 1; });
    return c;
  }, [filtered]);

  return (
    <div>
      {/* ── Big Search Bar ── */}
      <div className="relative mb-4">
        <ScanSearch className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-purple-400"/>
        <input
          ref={searchRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setPage(1); }}
          placeholder="Search by GSTIN, Invoice No, Party Name, Place of Supply or Category…"
          className="w-full pl-12 pr-12 py-3.5 text-sm rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 shadow-sm"
        />
        {query && (
          <button onClick={() => { setQuery(''); setPage(1); }} className="absolute right-4 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
            <X className="h-4 w-4 text-slate-400"/>
          </button>
        )}
      </div>

      {/* ── Category Filter Chips ── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1"><Tag className="h-3 w-3"/>Category:</span>
        {Object.entries(CAT_META).map(([id, meta]) => (
          <button
            key={id}
            onClick={() => toggleCat(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
              catFilter.includes(id)
                ? `${meta.bg} ${meta.text} border-transparent shadow-sm`
                : 'bg-white dark:bg-slate-800 text-slate-400 border-slate-200 dark:border-slate-700 opacity-60'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${catFilter.includes(id) ? meta.dot : 'bg-slate-300'}`}/>
            {meta.short}
            <span className="ml-0.5 opacity-70">({catCounts[id] || 0})</span>
          </button>
        ))}

        <button
          onClick={() => setShowFilters(v => !v)}
          className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
            showFilters || minVal || maxVal || dateFrom || dateTo
              ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700'
              : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700'
          }`}
        >
          <Filter className="h-3 w-3"/>
          Advanced Filters
          {(minVal || maxVal || dateFrom || dateTo) && (
            <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-purple-500"/>
          )}
        </button>
      </div>

      {/* ── Advanced Filters Panel ── */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 mb-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-800">
              <div>
                <label className="block text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide mb-1">Min Invoice Value (₹)</label>
                <input
                  type="number" value={minVal} onChange={e => { setMinVal(e.target.value); setPage(1); }}
                  placeholder="e.g. 1000"
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-purple-200 dark:border-purple-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-400"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide mb-1">Max Invoice Value (₹)</label>
                <input
                  type="number" value={maxVal} onChange={e => { setMaxVal(e.target.value); setPage(1); }}
                  placeholder="e.g. 100000"
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-purple-200 dark:border-purple-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-400"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide mb-1">Invoice Date From</label>
                <input
                  type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-purple-200 dark:border-purple-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-400"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide mb-1">Invoice Date To</label>
                <input
                  type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-purple-200 dark:border-purple-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-400"
                />
              </div>
              <div className="col-span-2 md:col-span-4 flex items-center gap-2">
                <label className="text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide">Sort by:</label>
                <div className="flex flex-wrap gap-1.5">
                  {SORT_COLS.map(sc => (
                    <button
                      key={sc.id}
                      onClick={() => handleSort(sc.id)}
                      className={`px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                        sortCol === sc.id
                          ? 'bg-purple-600 text-white border-transparent'
                          : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700 hover:border-purple-300'
                      }`}
                    >
                      {sc.label} {sortCol === sc.id ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </button>
                  ))}
                </div>
                {(minVal || maxVal || dateFrom || dateTo) && (
                  <button
                    onClick={() => { setMinVal(''); setMaxVal(''); setDateFrom(''); setDateTo(''); setPage(1); }}
                    className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 border border-rose-200 dark:border-rose-800 transition-colors"
                  >
                    <X className="h-3 w-3"/> Clear Filters
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Results Summary Bar ── */}
      <div className="flex flex-wrap gap-4 mb-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-sm">
        <span className="text-slate-500">Results: <strong className="text-slate-700 dark:text-slate-200">{filtered.length}</strong></span>
        <span className="text-slate-500">Total Value: <strong className="text-slate-700 dark:text-slate-200">₹{fmt(totalValue)}</strong></span>
        <span className="text-slate-500">Total Tax: <strong className="text-slate-700 dark:text-slate-200">₹{fmt(totalTax)}</strong></span>
        {query && <span className="text-purple-600 dark:text-purple-400 font-medium">Showing results for: "<em>{query}</em>"</span>}
      </div>

      {/* ── No Results ── */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center py-16 text-slate-400">
          <ScanSearch className="h-14 w-14 mb-3 text-slate-300"/>
          <p className="font-medium text-slate-500 text-base">No invoices found</p>
          <p className="text-sm mt-1 text-slate-400">
            {query ? `No match for "${query}"` : 'Try adjusting your filters'}
          </p>
          {(query || minVal || maxVal) && (
            <button onClick={() => { setQuery(''); setMinVal(''); setMaxVal(''); setDateFrom(''); setDateTo(''); }}
              className="mt-4 px-4 py-2 text-sm font-medium text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-800 transition-colors">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Results Table ── */}
      {filtered.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full text-xs min-w-[1000px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 w-8">#</th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">Status</th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('gstin')}>
                  GSTIN <SortIcon col="gstin"/>
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('partyName')}>
                  Party Name <SortIcon col="partyName"/>
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('invoiceNo')}>
                  Invoice No <SortIcon col="invoiceNo"/>
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('invoiceDate')}>
                  Date <SortIcon col="invoiceDate"/>
                </th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('invoiceValue')}>
                  Invoice Value <SortIcon col="invoiceValue"/>
                </th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">Taxable</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300 cursor-pointer hover:text-purple-600" onClick={() => handleSort('totalTax')}>
                  Total Tax <SortIcon col="totalTax"/>
                </th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">IGST</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">CGST</th>
                <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">SGST</th>
                <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Place</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r, idx) => {
                const meta = CAT_META[r.catId];
                const n    = (page - 1) * PAGE_SIZE + idx + 1;
                const isMismatch = r.catId === 'mismatch';
                return (
                  <tr
                    key={`${r.catId}-${r.invoiceNo}-${idx}`}
                    className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-purple-50/30 dark:hover:bg-purple-900/10 transition-colors"
                  >
                    <td className="px-3 py-2.5 text-slate-400">{n}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${meta.bg} ${meta.text}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`}/>
                        {meta.short}
                      </span>
                      {isMismatch && r.valueDiff !== undefined && (
                        <span className={`ml-1 text-[9px] font-bold ${r.valueDiff > 0 ? 'text-blue-600' : 'text-rose-600'}`}>
                          {r.valueDiff > 0 ? '▲' : '▼'}₹{Math.abs(r.valueDiff).toFixed(0)}
                        </span>
                      )}
                      {r.catId === 'crossGstin' && (
                        <span className="ml-1 text-[9px] font-bold text-red-600">⚡GSTIN≠</span>
                      )}
                    </td>
                    <td className={`px-3 py-2.5 ${GSTIN_CELL_CLASS} text-slate-600 dark:text-slate-300`}>
                      {highlight(r.gstin, query)}
                      {r.booksGstin && r.booksGstin !== r.gstin && (
                        <div className="text-[9px] text-violet-500 font-semibold">Books: {r.booksGstin}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 dark:text-slate-200 max-w-[130px] truncate" title={r.partyName}>
                      {highlight(r.partyName || '—', query)}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">
                      {highlight(r.invoiceNoRaw, query)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{r.invoiceDate}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-slate-700 dark:text-slate-200">₹{fmt(r.invoiceValue)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-500">₹{fmt(r.taxableValue)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-700 dark:text-slate-200">₹{fmt(r.totalTax)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-400">{fmt(r.igst)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-400">{fmt(r.cgst)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-400">{fmt(r.sgst)}</td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap max-w-[80px] truncate" title={r.placeOfSupply}>
                      {highlight(r.placeOfSupply || '—', query)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs">
          <span className="text-slate-500">
            Showing {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(1)} disabled={page === 1} className="px-2 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">«</button>
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Prev</button>
            <span className="px-2 py-1.5 text-slate-500">Page {page} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">Next</button>
            <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-2 py-1.5 rounded-lg border text-xs disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">»</button>
          </div>
        </div>
      )}
    </div>
  );
};



/* ═══════════════════════════════════════════════════════════════════════════
   CLIENT SELECTOR — searchable dropdown linked to the clients DB
═══════════════════════════════════════════════════════════════════════════ */
const ClientSelector = ({ clients, selectedId, onSelect }) => {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selected = clients.find(c => c.id === selectedId);
  const filtered = clients.filter(c =>
    !search.trim() ||
    c.company_name.toLowerCase().includes(search.toLowerCase()) ||
    (c.gstin || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 pl-3 pr-3 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-left hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
      >
        <User className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
        <span className={`flex-1 truncate ${selected ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400'}`}>
          {selected ? `${selected.company_name}${selected.gstin ? ` — ${selected.gstin}` : ''}` : 'Select a client (optional)'}
        </span>
        {selected && (
          <span onClick={e => { e.stopPropagation(); onSelect(null); setSearch(''); }}
            className="p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700">
            <X className="h-3.5 w-3.5 text-slate-400" />
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden"
          >
            <div className="p-2 border-b border-slate-100 dark:border-slate-700">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by name or GSTIN…"
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">No clients found</p>
              ) : filtered.map(c => (
                <button
                  key={c.id} type="button"
                  onClick={() => { onSelect(c); setOpen(false); setSearch(''); }}
                  className={`w-full text-left px-3 py-2.5 text-xs hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors flex items-center gap-2 ${c.id === selectedId ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}
                >
                  <div className="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400">{c.company_name[0]}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{c.company_name}</p>
                    {c.gstin && <p className="text-[10px] font-mono text-slate-400">{c.gstin}</p>}
                  </div>
                  {c.id === selectedId && <CheckCircle2 className="h-3.5 w-3.5 text-indigo-500 ml-auto flex-shrink-0" />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   EDIT SESSION MODAL — edit metadata of a saved reconciliation
   Fields: Client link, Company Details (name, GSTIN, PAN, address, phone,
           email, FY), Tax Period, file names.
═══════════════════════════════════════════════════════════════════════════ */
const EMPTY_CO = { name:'', gstin:'', pan:'', address:'', phone:'', email:'', fy:'' };

const EditSessionModal = ({ session, clients, onSave, onClose }) => {
  const [saving,  setSaving]  = useState(false);
  const [period,  setPeriod]  = useState(session.period || '');
  const [portalFn, setPortalFn] = useState(session.portal_filename || '');
  const [booksFn,  setBooksFn]  = useState(session.books_filename  || '');
  const [co, setCo] = useState({
    ...EMPTY_CO,
    ...(session.company || {}),
    name:  (session.company?.name  || session.client_name  || ''),
    gstin: (session.company?.gstin || session.client_gstin || ''),
  });
  const [selectedClient, setSelectedClient] = useState(() =>
    clients.find(c => c.id === session.client_id) || null
  );

  const setCoField = (k, v) => setCo(p => ({ ...p, [k]: v }));

  const handleClientSelect = (client) => {
    setSelectedClient(client);
    if (!client) return;
    const address = [client.address, client.city, client.state].filter(Boolean).join(', ');
    setCo(p => ({
      ...p,
      name:    client.company_name || p.name,
      gstin:   client.gstin        || p.gstin,
      pan:     client.pan          || p.pan,
      address: address             || p.address,
      phone:   client.phone || client.contact_persons?.[0]?.phone || p.phone,
      email:   client.email || client.contact_persons?.[0]?.email || p.email,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await api.patch(`/gst-reconciliation/history/${session.id}`, {
        period,
        client_id:       selectedClient?.id    || null,
        client_name:     co.name               || null,
        client_gstin:    co.gstin              || null,
        company:         co,
        portal_filename: portalFn              || null,
        books_filename:  booksFn               || null,
      });
      onSave?.({
        ...session,
        period,
        client_id:       selectedClient?.id || session.client_id,
        client_name:     r.data?.client_name  || co.name,
        client_gstin:    r.data?.client_gstin || co.gstin,
        company:         co,
        portal_filename: portalFn,
        books_filename:  booksFn,
      });
      toast.success('Session details updated');
      onClose();
    } catch (e) {
      toast.error(`Failed to save: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const FIELDS = [
    { k:'name',    label:'Company / Trade Name', icon:Building2, ph:'e.g. MED 7 PHARMACY' },
    { k:'gstin',   label:'GSTIN',                icon:Hash,      ph:'e.g. 24ARQPP3237M1Z9' },
    { k:'pan',     label:'PAN',                  icon:Hash,      ph:'e.g. ARQPP3237M' },
    { k:'address', label:'Address',              icon:MapPin,    ph:'Street, Area, City' },
    { k:'phone',   label:'Phone',                icon:Phone,     ph:'e.g. +91 98765 43210' },
    { k:'email',   label:'Email',                icon:Mail,      ph:'e.g. accounts@company.com' },
    { k:'fy',      label:'Financial Year',       icon:Calendar,  ph:'e.g. 2025-26' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-emerald-900/50 backdrop-blur-sm" onClick={onClose}/>
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/40">
            <Edit3 className="h-4 w-4 text-indigo-600 dark:text-indigo-400"/>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Edit Reconciliation Details</h3>
            <p className="text-[11px] text-slate-400 truncate">{session.client_name || 'Unknown'}{session.period ? ` · ${session.period}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 transition-colors">
            <X className="h-4 w-4"/>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">

          {/* ── Link to Client ── */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <User className="h-3.5 w-3.5"/> Link to Client
            </label>
            <ClientSelector
              clients={clients}
              selectedId={selectedClient?.id}
              onSelect={handleClientSelect}
            />
          </div>

          {/* ── Company Details ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400"/>
              <span className="font-semibold text-sm text-slate-700 dark:text-slate-200">Company Details</span>
              <span className="text-xs text-slate-400">(for report header)</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
              {FIELDS.map(f => (
                <div key={f.k} className={f.k === 'address' ? 'sm:col-span-2' : ''}>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{f.label}</label>
                  <div className="relative">
                    <f.icon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"/>
                    <input
                      value={co[f.k] || ''}
                      onChange={e => setCoField(f.k, e.target.value)}
                      placeholder={f.ph}
                      className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Tax Period ── */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5"/> Tax Period
            </label>
            <input
              value={period}
              onChange={e => setPeriod(e.target.value)}
              placeholder="e.g. March 2026"
              className="w-full sm:w-56 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* ── File Names ── */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5"/> File References
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Portal File Name</label>
                <div className="relative">
                  <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-blue-400"/>
                  <input value={portalFn} onChange={e => setPortalFn(e.target.value)}
                    placeholder="e.g. GSTR2B_Apr2026.xlsx"
                    className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Books File Name</label>
                <div className="relative">
                  <BookOpen className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-violet-400"/>
                  <input value={booksFn} onChange={e => setBooksFn(e.target.value)}
                    placeholder="e.g. PurchaseRegister.xlsx"
                    className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 flex-shrink-0">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white transition-colors shadow-sm">
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/> Saving…</>
              : <><CheckCircle2 className="h-3.5 w-3.5"/> Save Changes</>}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY VIEW — past reconciliation sessions
═══════════════════════════════════════════════════════════════════════════ */
const HistoryView = ({ onOpenSession, clients = [] }) => {
  const [sessions,  setSessions]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [deleting,  setDeleting]  = useState(null);
  const [opening,   setOpening]   = useState(null);
  const [expanded,  setExpanded]  = useState(null);
  const [editing,   setEditing]   = useState(null);  // { session } | null

  const handleOpen = async (id) => {
    setOpening(id);
    try {
      const r = await api.get(`/gst-reconciliation/history/${id}`);
      const sess = r.data || {};
      const full = sess.full_result || sess.fullResult;
      if (!full || (!full.matched && !full.mismatch && !full.portalOnly && !full.booksOnly)) {
        toast.error('This older session was saved without full data — re-run the reconciliation to view & edit.');
        setOpening(null);
        return;
      }
      onOpenSession?.({
        result: full,
        company: sess.company || {},
        period: sess.period || '',
        portalFilename: sess.portal_filename || '',
        booksFilename: sess.books_filename || '',
        sessionId: sess.id,
        clientName: sess.client_name || '',
        clientGstin: sess.client_gstin || '',
      });
    } catch (e) {
      console.error(e);
      toast.error('Failed to open session');
    } finally {
      setOpening(null);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/gst-reconciliation/history?limit=100');
      setSessions(r.data.sessions || []);
    } catch { toast.error('Failed to load history'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this reconciliation history entry?')) return;
    setDeleting(id);
    try {
      await api.delete(`/gst-reconciliation/history/${id}`);
      setSessions(prev => prev.filter(s => s.id !== id));
      toast.success('Deleted');
    } catch { toast.error('Could not delete session'); }
    finally { setDeleting(null); }
  };

  const fmtDate = (d) => {
    if (!d) return '—';
    try {
      return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return d; }
  };

  const StatPill = ({ label, val, bg, text }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${bg} ${text}`}>
      {label}: {val}
    </span>
  );

  if (loading) return (
    <div className="flex flex-col items-center py-20 text-slate-400">
      <Loader2 className="h-8 w-8 animate-spin mb-3 text-indigo-400" />
      <p className="text-sm">Loading history…</p>
    </div>
  );

  if (sessions.length === 0) return (
    <div className="flex flex-col items-center py-20 text-slate-400">
      <History className="h-14 w-14 mb-3 text-slate-200 dark:text-slate-700" />
      <p className="font-medium text-slate-500 text-base">No reconciliation history yet</p>
      <p className="text-sm mt-1 text-slate-400">Run a reconciliation and it will appear here.</p>
    </div>
  );

  return (<>
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">{sessions.length} reconciliation{sessions.length !== 1 ? 's' : ''} saved</p>
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 transition-colors">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
      <div className="space-y-3">
        {sessions.map(s => {
          const sm = s.summary || {};
          const isExp = expanded === s.id;
          return (
            <motion.div key={s.id} layout className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              {/* Header row */}
              <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={() => setExpanded(isExp ? null : s.id)}>
                <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 flex-shrink-0">
                  <ArrowLeftRight className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
                      {s.client_name || 'Unknown Client'}
                    </p>
                    {s.client_gstin && (
                      <span className="font-mono text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-500 px-1.5 py-0.5 rounded">
                        {s.client_gstin}
                      </span>
                    )}
                    {s.period && (
                      <span className="text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-full font-medium">
                        {s.period}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    <StatPill label="✓" val={sm.matched_count ?? 0}     bg="bg-emerald-100 dark:bg-emerald-900/30" text="text-emerald-700 dark:text-emerald-300" />
                    <StatPill label="⚠" val={sm.mismatch_count ?? 0}    bg="bg-amber-100 dark:bg-amber-900/30"    text="text-amber-700 dark:text-amber-300" />
                    <StatPill label="🌐" val={sm.portal_only_count ?? 0} bg="bg-blue-100 dark:bg-blue-900/30"      text="text-blue-700 dark:text-blue-300" />
                    <StatPill label="📒" val={sm.books_only_count ?? 0}  bg="bg-rose-100 dark:bg-rose-900/30"      text="text-rose-700 dark:text-rose-300" />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="text-right hidden sm:block mr-1">
                    <p className="text-[11px] text-slate-400 flex items-center gap-1 justify-end">
                      <Clock className="h-3 w-3" /> {fmtDate(s.created_at)}
                    </p>
                    {s.created_by_name && (
                      <p className="text-[10px] text-slate-400 mt-0.5">by {s.created_by_name}</p>
                    )}
                  </div>
                  {/* Open */}
                  <button
                    onClick={e => { e.stopPropagation(); handleOpen(s.id); }}
                    disabled={opening === s.id}
                    title="Open full reconciliation"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300 text-xs font-semibold border border-indigo-200 dark:border-indigo-800 transition-colors"
                  >
                    {opening === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">Open</span>
                  </button>
                  {/* New Session */}
                  <button
                    onClick={e => { e.stopPropagation(); handleNewSession(); }}
                    title="Save this session and start a new reconciliation"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-600 dark:text-emerald-300 text-xs font-semibold border border-emerald-200 dark:border-emerald-800 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">New Session</span>
                  </button>
                  {/* Edit */}
                  <button
                    onClick={e => { e.stopPropagation(); setEditing({ session: s }); }}
                    title="Edit company details, period, client link"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-600 dark:text-amber-300 text-xs font-semibold border border-amber-200 dark:border-amber-800 transition-colors"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Edit</span>
                  </button>
                  {/* Delete */}
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(s.id); }}
                    disabled={deleting === s.id}
                    title="Delete this session"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/30 dark:hover:bg-rose-900/50 text-rose-500 dark:text-rose-400 text-xs font-semibold border border-rose-200 dark:border-rose-800 transition-colors"
                  >
                    {deleting === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                  <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform flex-shrink-0 ${isExp ? 'rotate-180' : ''}`} />
                </div>
              </div>

              {/* Expanded details */}
              <AnimatePresence>
                {isExp && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }} 
                    animate={{ height: 'auto', opacity: 1 }} 
                    exit={{ height: 0, opacity: 0 }} 
                    className="overflow-hidden"
                  >
                    <div className="border-t border-slate-100 dark:border-slate-700 p-4 bg-slate-50/50 dark:bg-slate-900/30">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                        {[
                          { label: 'Portal Invoices',  val: sm.total_portal ?? '—',          color: 'text-slate-700 dark:text-slate-200' },
                          { label: 'Books Invoices',   val: sm.total_books  ?? '—',           color: 'text-slate-700 dark:text-slate-200' },
                          { label: 'Matched Value',    val: sm.matched_value != null ? `₹${fmt(sm.matched_value)}` : '—',     color: 'text-emerald-700 dark:text-emerald-300' },
                          { label: 'Books Only Value', val: sm.books_only_value != null ? `₹${fmt(sm.books_only_value)}` : '—', color: 'text-rose-700 dark:text-rose-300' },
                        ].map(item => (
                          <div key={item.label} className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                            <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-1">{item.label}</p>
                            <p className={`text-sm font-bold ${item.color}`}>{item.val}</p>
                          </div>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                        {s.portal_filename && <span>🌐 Portal file: <strong>{s.portal_filename}</strong></span>}
                        {s.books_filename  && <span>📒 Books file: <strong>{s.books_filename}</strong></span>}
                        <span className="sm:hidden flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDate(s.created_at)}</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>

    </div>

    {/* ── Edit Session Modal ── */}
    <AnimatePresence>
      {editing && (
        <EditSessionModal
          session={editing.session}
          clients={clients}
          onSave={(updated) => {
            setSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </AnimatePresence>
  </>);
};
/* ═══════════════════════════════════════════════════════════════════════════
   ITC DETAIL MODAL — full invoice list for ITC Claimable / ITC to Book / ITC at Risk
═══════════════════════════════════════════════════════════════════════════ */
const ITC_MODAL_META = {
  claimable: {
    title: 'ITC Claimable',
    desc: 'Tax from invoices present in both portal and books (matched). These can be claimed in GSTR-3B.',
    color: 'emerald',
    headerBg: 'bg-emerald-600',
  },
  toBook: {
    title: 'ITC to Book',
    desc: 'Tax from portal-only invoices not yet entered in books. Book these entries to avail ITC.',
    color: 'blue',
    headerBg: 'bg-blue-600',
  },
  atRisk: {
    title: 'ITC at Risk',
    desc: 'Tax from books-only invoices where vendor has NOT filed on portal. Follow up with vendor or reverse ITC.',
    color: 'rose',
    headerBg: 'bg-rose-600',
  },
};

const ITCDetailModal = ({ type, results, onClose }) => {
  const [search, setSearch] = useState('');
  const meta = ITC_MODAL_META[type];
  if (!meta) return null;

  let invoices = [];
  if (type === 'claimable') {
    invoices = (results.matched || []).map(r => ({
      gstin: r.portal?.gstin,
      partyName: r.portal?.tradeOrLegalName || '—',
      invoiceNo: r.portal?.invoiceNoRaw,
      date: r.portal?.invoiceDate,
      value: r.portal?.invoiceValue,
      igst: r.portal?.igst, cgst: r.portal?.cgst, sgst: r.portal?.sgst,
      tax: (r.portal?.igst||0)+(r.portal?.cgst||0)+(r.portal?.sgst||0),
      rcm: r.rcMismatch,
    }));
  } else if (type === 'toBook') {
    invoices = (results.portalOnly || []).map(r => ({
      gstin: r.portal?.gstin,
      partyName: r.portal?.tradeOrLegalName || '—',
      invoiceNo: r.portal?.invoiceNoRaw,
      date: r.portal?.invoiceDate,
      value: r.portal?.invoiceValue,
      igst: r.portal?.igst, cgst: r.portal?.cgst, sgst: r.portal?.sgst,
      tax: (r.portal?.igst||0)+(r.portal?.cgst||0)+(r.portal?.sgst||0),
      itc: r.portal?.itcAvailability,
    }));
  } else {
    invoices = (results.booksOnly || []).map(r => ({
      gstin: r.books?.gstin,
      partyName: '—',
      invoiceNo: r.books?.invoiceNoRaw,
      date: r.books?.invoiceDate,
      value: r.books?.invoiceValue,
      igst: r.books?.igst, cgst: r.books?.cgst, sgst: r.books?.sgst,
      tax: (r.books?.igst||0)+(r.books?.cgst||0)+(r.books?.sgst||0),
    }));
  }

  const filtered = search.trim()
    ? invoices.filter(inv => {
        const q = search.toLowerCase();
        return (inv.gstin||'').toLowerCase().includes(q) ||
               (inv.invoiceNo||'').toLowerCase().includes(q) ||
               (inv.partyName||'').toLowerCase().includes(q);
      })
    : invoices;

  const totalTaxAmt = filtered.reduce((s, inv) => s + (inv.tax || 0), 0);
  const totalVal = filtered.reduce((s, inv) => s + (inv.value || 0), 0);

  const colorMap = {
    emerald: { badge:'bg-emerald-100 text-emerald-700', row:'hover:bg-emerald-50 dark:hover:bg-emerald-900/10', ring:'focus:ring-emerald-400 border-emerald-200' },
    blue:    { badge:'bg-blue-100 text-blue-700',       row:'hover:bg-blue-50 dark:hover:bg-blue-900/10',       ring:'focus:ring-blue-400 border-blue-200' },
    rose:    { badge:'bg-rose-100 text-rose-700',       row:'hover:bg-rose-50 dark:hover:bg-rose-900/10',       ring:'focus:ring-rose-400 border-rose-200' },
  };
  const c = colorMap[meta.color];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-emerald-900/50 backdrop-blur-sm" onClick={onClose}/>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className={`${meta.headerBg} px-6 py-4 flex items-center justify-between flex-shrink-0`}>
          <div>
            <h2 className="text-lg font-bold text-white">{meta.title}</h2>
            <p className="text-xs text-white/80 mt-0.5">{meta.desc}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-white/20 hover:bg-white/30 text-white transition-colors">
            <X className="h-5 w-5"/>
          </button>
        </div>

        {/* Summary bar */}
        <div className="flex flex-wrap gap-4 px-6 py-3 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 flex-shrink-0 text-sm">
          <span className="text-slate-500">Invoices: <strong className="text-slate-800 dark:text-slate-100">{filtered.length}</strong></span>
          <span className="text-slate-500">Total Value: <strong className="text-slate-800 dark:text-slate-100">₹{fmt(totalVal)}</strong></span>
          <span className="text-slate-500">Total Tax: <strong className="text-slate-800 dark:text-slate-100">₹{fmt(totalTaxAmt)}</strong></span>
        </div>

        {/* Search */}
        <div className="px-6 py-3 flex-shrink-0 border-b border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"/>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search GSTIN, Invoice No, Party Name…"
              className={`w-full pl-9 pr-4 py-2 text-sm rounded-xl border bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 ${c.ring} dark:border-slate-700`}
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs min-w-[700px]">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold text-slate-500">#</th>
                <th className="px-4 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">GSTIN</th>
                {type !== 'atRisk' && <th className="px-4 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Party Name</th>}
                <th className="px-4 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Invoice No</th>
                <th className="px-4 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">Date</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">Invoice Value</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">IGST</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">CGST</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">SGST</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">Total Tax</th>
                {type === 'claimable' && <th className="px-4 py-2.5 text-center font-semibold text-slate-500">Flag</th>}
                {type === 'toBook'    && <th className="px-4 py-2.5 text-center font-semibold text-slate-500">ITC Avail</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-16 text-center text-slate-400">No invoices found</td></tr>
              ) : filtered.map((inv, i) => (
                <tr key={i} className={`border-b border-slate-100 dark:border-slate-700/50 ${c.row} transition-colors`}>
                  <td className="px-4 py-2 text-slate-400">{i + 1}</td>
                  <td className={`px-4 py-2 ${GSTIN_CELL_CLASS} text-slate-600 dark:text-slate-300`}>{inv.gstin}</td>
                  {type !== 'atRisk' && <td className="px-4 py-2 text-slate-700 dark:text-slate-200 max-w-[140px] truncate" title={inv.partyName}>{inv.partyName}</td>}
                  <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{inv.invoiceNo}</td>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{inv.date}</td>
                  <td className="px-4 py-2 text-right text-slate-700 dark:text-slate-200">₹{fmt(inv.value)}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{fmt(inv.igst)}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{fmt(inv.cgst)}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{fmt(inv.sgst)}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${c.badge.split(' ')[1]}`}>₹{fmt(inv.tax)}</td>
                  {type === 'claimable' && (
                    <td className="px-4 py-2 text-center">
                      {inv.rcm && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">RCM</span>}
                    </td>
                  )}
                  {type === 'toBook' && (
                    <td className="px-4 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${inv.itc?.toLowerCase()==='yes'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}`}>{inv.itc||'—'}</span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {filtered.length > 0 && (
              <tfoot className="bg-slate-50 dark:bg-slate-800/80 border-t-2 border-slate-200 dark:border-slate-700 sticky bottom-0">
                <tr>
                  <td colSpan={type === 'atRisk' ? 5 : 6} className="px-4 py-2.5 font-bold text-slate-700 dark:text-slate-200 text-xs">TOTAL ({filtered.length} invoices)</td>
                  <td className="px-4 py-2.5 text-right font-bold text-slate-700 dark:text-slate-200">₹{fmt(totalVal)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-slate-500">{fmt(filtered.reduce((s,r)=>s+(r.igst||0),0))}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-slate-500">{fmt(filtered.reduce((s,r)=>s+(r.cgst||0),0))}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-slate-500">{fmt(filtered.reduce((s,r)=>s+(r.sgst||0),0))}</td>
                  <td className={`px-4 py-2.5 text-right font-bold text-lg ${meta.color==='emerald'?'text-emerald-700 dark:text-emerald-300':meta.color==='blue'?'text-blue-700 dark:text-blue-300':'text-rose-700 dark:text-rose-300'}`}>₹{fmt(totalTaxAmt)}</td>
                  {(type === 'claimable' || type === 'toBook') && <td/>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </motion.div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   SIDE-BY-SIDE COMPARE — Portal Only vs Books Only with smart pairing
═══════════════════════════════════════════════════════════════════════════ */
const CONF_COLOR = { high:'bg-emerald-100 text-emerald-700 border-emerald-200', medium:'bg-amber-100 text-amber-700 border-amber-200', low:'bg-orange-100 text-orange-700 border-orange-200', gstin_diff:'bg-red-100 text-red-700 border-red-200', none:'bg-slate-100 text-slate-400 border-slate-200' };
const CONF_LABEL = { high:'✓ Match', medium:'≈ Near', low:'~ Possible', gstin_diff:'⚡ GSTIN≠', none:'—' };

const SideBySideCompare = ({ portalOnly, booksOnly, onConfirmMatch, onClose }) => {
  const [search, setSearch]             = useState('');
  const [gstinFilter, setGstinFilter]   = useState('');
  const [gstinNames, setGstinNames]     = useState({});
  const [lookingUp, setLookingUp]       = useState({});
  const [confirmed, setConfirmed]       = useState(new Set());

  /* Portal name map — free lookup from already-loaded data */
  const portalNameMap = React.useMemo(() => {
    const m = {};
    portalOnly.forEach(r => { if (r.portal?.gstin && r.portal?.tradeOrLegalName) m[r.portal.gstin] = r.portal.tradeOrLegalName; });
    return m;
  }, [portalOnly]);

  /* Smart pairing */
  const pairs = React.useMemo(() => {
    const portalUsed = new Set(), booksUsed = new Set(), result = [];

    // Pass 1: exact normalised invoice + same GSTIN
    booksOnly.forEach(bo => {
      const bNum = normaliseInvoice(bo.books?.invoiceNoRaw || '');
      booksOnly; // lint
      for (const po of portalOnly) {
        if (portalUsed.has(po.key)) continue;
        const pNum = normaliseInvoice(po.portal?.invoiceNoRaw || '');
        if (pNum === bNum && bNum && po.portal?.gstin === bo.books?.gstin) {
          const vd = Math.abs((po.portal?.invoiceValue||0) - (bo.books?.invoiceValue||0));
          const td = Math.abs(((po.portal?.igst||0)+(po.portal?.cgst||0)+(po.portal?.sgst||0)) - ((bo.books?.igst||0)+(bo.books?.cgst||0)+(bo.books?.sgst||0)));
          result.push({ portal:po, books:bo, confidence: vd<=1.01&&td<=1.01?'high':'medium', valueDiff:vd, taxDiff:td });
          portalUsed.add(po.key); booksUsed.add(bo.key); break;
        }
      }
    });
    // Pass 2: same GSTIN, value within 2%
    booksOnly.forEach(bo => {
      if (booksUsed.has(bo.key)) return;
      const bVal = bo.books?.invoiceValue||0;
      let best=null, bestDiff=Infinity;
      for (const po of portalOnly) {
        if (portalUsed.has(po.key) || po.portal?.gstin !== bo.books?.gstin) continue;
        const d = Math.abs((po.portal?.invoiceValue||0)-bVal);
        if (d<bestDiff && d/(bVal||1)<0.02) { best=po; bestDiff=d; }
      }
      if (best) { result.push({ portal:best, books:bo, confidence:'low', valueDiff:bestDiff, taxDiff:0 }); portalUsed.add(best.key); booksUsed.add(bo.key); }
    });
    // Pass 3: Different GSTIN but same invoice number (normalised) + value within tolerance
    // — catches GSTIN typos or supplier registered under a different GST number in books
    booksOnly.forEach(bo => {
      if (booksUsed.has(bo.key)) return;
      const bNum = normaliseInvoice(bo.books?.invoiceNoRaw || bo.books?.invoiceNo || '');
      const bVal = bo.books?.invoiceValue || 0;
      if (!bNum) return;
      for (const po of portalOnly) {
        if (portalUsed.has(po.key)) continue;
        if (po.portal?.gstin === bo.books?.gstin) continue; // same GSTIN already handled above
        const pNum = normaliseInvoice(po.portal?.invoiceNoRaw || po.portal?.invoiceNo || '');
        const pVal = po.portal?.invoiceValue || 0;
        const tol = smartTolerance(pVal, bVal);
        if (pNum === bNum && Math.abs(pVal - bVal) <= tol) {
          const vd = Math.abs(pVal - bVal);
          const td = Math.abs(((po.portal?.igst||0)+(po.portal?.cgst||0)+(po.portal?.sgst||0)) - ((bo.books?.igst||0)+(bo.books?.cgst||0)+(bo.books?.sgst||0)));
          result.push({ portal:po, books:bo, confidence:'gstin_diff', valueDiff:vd, taxDiff:td, gstinMismatch:true });
          portalUsed.add(po.key); booksUsed.add(bo.key); break;
        }
      }
    });
    // Unpaired
    portalOnly.forEach(po => { if (!portalUsed.has(po.key)) result.push({ portal:po, books:null, confidence:'none' }); });
    booksOnly.forEach(bo  => { if (!booksUsed.has(bo.key))  result.push({ portal:null, books:bo,  confidence:'none' }); });
    return result;
  }, [portalOnly, booksOnly]);

  const allGstins = React.useMemo(() => {
    const s=new Set();
    pairs.forEach(p=>{ if(p.portal?.portal?.gstin) s.add(p.portal.portal.gstin); if(p.books?.books?.gstin) s.add(p.books.books.gstin); });
    return [...s].sort();
  }, [pairs]);

  const lookupName = async (gstin) => {
    if (!gstin || lookingUp[gstin]) return;
    // Skip if we already have a name from portal data or a previous lookup
    if (gstinNames[gstin] || portalNameMap[gstin]) return;
    setLookingUp(p => ({ ...p, [gstin]: true }));
    try {
      const result = await clientGstinLookup(gstin);
      const name = result.tradeName || result.legalName || '';
      // Even if no name found, cache static state info so we show state tooltip
      setGstinNames(p => ({
        ...p,
        [gstin]: name || (result.state ? `[${result.state}]` : ''),
      }));
    } catch (_) { /* clientGstinLookup never rejects, but guard anyway */ }
    setLookingUp(p => ({ ...p, [gstin]: false }));
  };

  // Auto-fetch names for all unique GSTINs without a name (batched)
  React.useEffect(() => {
    const need = new Set();
    pairs.forEach(p => {
      const pg = p.portal?.portal?.gstin;
      const bg = p.books?.books?.gstin;
      if (pg && !p.portal?.portal?.tradeOrLegalName && !portalNameMap[pg]) need.add(pg);
      if (bg && !portalNameMap[bg]) need.add(bg);
    });
    const todo = [...need].filter(g => !gstinNames[g] && !lookingUp[g]).slice(0, 8);
    todo.forEach(g => lookupName(g));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs]);

  const filtered = pairs.filter(p => {
    const g = p.portal?.portal?.gstin || p.books?.books?.gstin || '';
    if (gstinFilter && g !== gstinFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const pInv=(p.portal?.portal?.invoiceNoRaw||'').toLowerCase();
    const bInv=(p.books?.books?.invoiceNoRaw||'').toLowerCase();
    const name=(p.portal?.portal?.tradeOrLegalName||portalNameMap[g]||gstinNames[g]||'').toLowerCase();
    return g.toLowerCase().includes(q)||pInv.includes(q)||bInv.includes(q)||name.includes(q);
  });

  const stats = { high:0, medium:0, low:0, gstin_diff:0, confirmed:confirmed.size };
  filtered.forEach(p => { if(p.portal&&p.books) stats[p.confidence]=(stats[p.confidence]||0)+1; });

  const handleConfirm = (pair, idx) => {
    onConfirmMatch(pair);
    setConfirmed(s => new Set([...s, `${pair.portal?.key}__${pair.books?.key}`]));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-emerald-900/60 backdrop-blur-sm" onClick={onClose}/>
      <motion.div
        initial={{opacity:0,scale:0.96,y:12}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:0.96,y:12}}
        className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-[97vw] max-h-[92vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 flex-shrink-0">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2"><ArrowLeftRight className="h-4 w-4"/>Portal Only vs Books Only — Smart Compare</h2>
            <p className="text-[11px] text-white/75 mt-0.5">Auto-paired by invoice number &amp; value — including cross-GSTIN matches. Click Confirm to move matched pairs into Matched.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white"><X className="h-4 w-4"/></button>
        </div>

        {/* Filters bar */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 flex-shrink-0">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search invoice, GSTIN…"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-400"/>
          </div>
          <select value={gstinFilter} onChange={e=>setGstinFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400 max-w-[200px]">
            <option value="">All GSTINs ({allGstins.length})</option>
            {allGstins.map(g=><option key={g} value={g}>{g}</option>)}
          </select>
          <div className="flex items-center gap-2 ml-auto text-[11px] flex-wrap">
            <span className={`px-1.5 py-0.5 rounded border font-bold ${CONF_COLOR.high}`}>✓ {stats.high} exact</span>
            <span className={`px-1.5 py-0.5 rounded border font-bold ${CONF_COLOR.medium}`}>≈ {stats.medium} near</span>
            <span className={`px-1.5 py-0.5 rounded border font-bold ${CONF_COLOR.low}`}>~ {stats.low} possible</span>
            {stats.gstin_diff > 0 && <span className={`px-1.5 py-0.5 rounded border font-bold ${CONF_COLOR.gstin_diff}`}>⚡ {stats.gstin_diff} GSTIN≠</span>}
            <span className="text-slate-400">|</span>
            <span className="text-slate-500">P:<strong className="text-blue-600">{portalOnly.length}</strong> B:<strong className="text-violet-600">{booksOnly.length}</strong></span>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="px-2 py-2 text-center font-semibold text-slate-400 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 w-8">#</th>
                {/* Portal */}
                <th className="px-2 py-2 text-left font-semibold text-blue-600 bg-blue-50/80 dark:bg-blue-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Portal Invoice</th>
                <th className="px-2 py-2 text-left font-semibold text-blue-500 bg-blue-50/80 dark:bg-blue-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">GSTIN / Party</th>
                <th className="px-2 py-2 text-left font-semibold text-blue-500 bg-blue-50/80 dark:bg-blue-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Date</th>
                <th className="px-2 py-2 text-right font-semibold text-blue-500 bg-blue-50/80 dark:bg-blue-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Value</th>
                <th className="px-2 py-2 text-right font-semibold text-blue-500 bg-blue-50/80 dark:bg-blue-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Tax</th>
                {/* Status */}
                <th className="px-2 py-2 text-center font-semibold text-slate-500 bg-slate-100 dark:bg-slate-700/50 border-b border-l-2 border-r-2 border-slate-300 dark:border-slate-600 w-20">Match</th>
                {/* Books */}
                <th className="px-2 py-2 text-left font-semibold text-violet-600 bg-violet-50/80 dark:bg-violet-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Books Invoice</th>
                <th className="px-2 py-2 text-left font-semibold text-violet-500 bg-violet-50/80 dark:bg-violet-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">GSTIN / Party</th>
                <th className="px-2 py-2 text-left font-semibold text-violet-500 bg-violet-50/80 dark:bg-violet-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Date</th>
                <th className="px-2 py-2 text-right font-semibold text-violet-500 bg-violet-50/80 dark:bg-violet-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Value</th>
                <th className="px-2 py-2 text-right font-semibold text-violet-500 bg-violet-50/80 dark:bg-violet-900/20 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">Tax</th>
                <th className="px-2 py-2 text-center font-semibold text-slate-400 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 w-16">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="px-4 py-12 text-center text-slate-400 text-sm">No records match your filters</td></tr>
              )}
              {filtered.map((pair, i) => {
                const po  = pair.portal?.portal;
                const bo  = pair.books?.books;
                const g   = po?.gstin || bo?.gstin || '';
                const pName = po?.tradeOrLegalName || portalNameMap[g] || gstinNames[g] || '';
                const bName = portalNameMap[bo?.gstin] || gstinNames[bo?.gstin] || pName;
                const pTax  = po ? (po.igst||0)+(po.cgst||0)+(po.sgst||0) : null;
                const bTax  = bo ? (bo.igst||0)+(bo.cgst||0)+(bo.sgst||0) : null;
                const pairKey = `${pair.portal?.key}__${pair.books?.key}`;
                const isConfirmed = confirmed.has(pairKey);
                const rowBg = isConfirmed ? 'opacity-40' :
                              pair.confidence==='high'       ? 'bg-emerald-50/20 dark:bg-emerald-900/5'  :
                              pair.confidence==='medium'     ? 'bg-amber-50/20 dark:bg-amber-900/5'      :
                              pair.confidence==='low'        ? 'bg-orange-50/20 dark:bg-orange-900/5'    :
                              pair.confidence==='gstin_diff' ? 'bg-red-50/30 dark:bg-red-900/10'         : '';
                const gstinsDiffer = pair.gstinMismatch && po?.gstin && bo?.gstin && po.gstin !== bo.gstin;
                return (
                  <tr key={i} className={`border-b border-slate-100 dark:border-slate-700/50 transition-colors hover:bg-slate-50/50 dark:hover:bg-slate-700/20 ${rowBg}`}>
                    <td className="px-2 py-1.5 text-center text-slate-300 text-[11px]">{i+1}</td>
                    {/* Portal side */}
                    <td className="px-2 py-1.5 font-mono font-semibold text-blue-700 dark:text-blue-300 whitespace-nowrap">{po?.invoiceNoRaw||<span className="text-slate-200">—</span>}</td>
                    <td className="px-3 py-2 min-w-[220px] max-w-[260px]">
                      <div className={`font-mono text-[10px] ${gstinsDiffer ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-500 dark:text-slate-400'}`}>
                        {po?.gstin||'—'}
                        {gstinsDiffer && <span className="ml-1 text-[8px] bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-1 py-0.5 rounded border border-red-200">Portal GSTIN</span>}
                      </div>
                      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-tight mt-0.5" title={pName}>{pName||(!isConfirmed&&po?.gstin?(
                        <button onClick={()=>lookupName(po.gstin)} disabled={lookingUp[po.gstin]} className="text-indigo-500 hover:text-indigo-700 inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                          {lookingUp[po.gstin]?<Loader2 className="h-2.5 w-2.5 animate-spin"/>:<Search className="h-2.5 w-2.5"/>}lookup name
                        </button>
                      ):'—')}</div>
                    </td>
                    <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap text-[11px]">{po?.invoiceDate||'—'}</td>
                    <td className="px-2 py-1.5 text-right font-medium text-blue-700 dark:text-blue-300 whitespace-nowrap">₹{po?fmt(po.invoiceValue):'—'}</td>
                    <td className="px-2 py-1.5 text-right text-blue-500 whitespace-nowrap">₹{pTax!=null?fmt(pTax):'—'}</td>
                    {/* Confidence */}
                    <td className="px-2 py-2 text-center bg-slate-50/40 dark:bg-slate-700/20 border-l-2 border-r-2 border-slate-200 dark:border-slate-600">
                      <span className={`px-1 py-0.5 rounded border text-[9px] font-bold ${CONF_COLOR[pair.confidence] || CONF_COLOR.none}`}>{CONF_LABEL[pair.confidence] || '—'}</span>
                      {pair.gstinMismatch && <div className="text-[8px] text-red-500 mt-0.5 font-semibold">GSTINs differ!</div>}
                      {pair.valueDiff>0&&pair.confidence!=='none'&&!pair.gstinMismatch&&<div className="text-[9px] text-slate-300 mt-0.5">Δ{pair.valueDiff.toFixed(1)}</div>}
                    </td>
                    {/* Books side */}
                    <td className="px-2 py-1.5 font-mono font-semibold text-violet-700 dark:text-violet-300 whitespace-nowrap">{bo?.invoiceNoRaw||<span className="text-slate-200">—</span>}</td>
                    <td className="px-3 py-2 min-w-[220px] max-w-[260px]">
                      <div className={`font-mono text-[10px] ${gstinsDiffer ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-500 dark:text-slate-400'}`}>
                        {bo?.gstin||'—'}
                        {gstinsDiffer && <span className="ml-1 text-[8px] bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-1 py-0.5 rounded border border-red-200">Books GSTIN</span>}
                      </div>
                      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-tight mt-0.5" title={bName}>{bName||(!isConfirmed&&bo?.gstin?(
                        <button onClick={()=>lookupName(bo.gstin)} disabled={lookingUp[bo.gstin]} className="text-indigo-500 hover:text-indigo-700 inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                          {lookingUp[bo.gstin]?<Loader2 className="h-2.5 w-2.5 animate-spin"/>:<Search className="h-2.5 w-2.5"/>}lookup name
                        </button>
                      ):'—')}</div>
                    </td>
                    <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap text-[11px]">{bo?.invoiceDate||'—'}</td>
                    <td className="px-2 py-1.5 text-right font-medium text-violet-700 dark:text-violet-300 whitespace-nowrap">₹{bo?fmt(bo.invoiceValue):'—'}</td>
                    <td className="px-2 py-1.5 text-right text-violet-500 whitespace-nowrap">₹{bTax!=null?fmt(bTax):'—'}</td>
                    {/* Action */}
                    <td className="px-2 py-1.5 text-center">
                      {isConfirmed ? (
                        <span className="text-[10px] text-emerald-500 font-bold">✓ Done</span>
                      ) : pair.portal && pair.books ? (
                        <button onClick={()=>handleConfirm(pair,i)}
                          className="px-2 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors whitespace-nowrap">
                          Confirm
                        </button>
                      ) : (
                        <span className="text-slate-200 text-[10px]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/30 flex-shrink-0 text-[11px] text-slate-500">
          <span>{filtered.length} rows shown</span>
          <span className="text-emerald-600 font-medium">{stats.confirmed} confirmed this session</span>
          <span className="ml-auto">Portal: <strong className="text-blue-600">{portalOnly.length}</strong> unmatched | Books: <strong className="text-violet-600">{booksOnly.length}</strong> unmatched</span>
        </div>
      </motion.div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   CLIENT DETAIL VIEW — month-wise session history for one client
═══════════════════════════════════════════════════════════════════════════ */
const ClientDetailView = ({ clientKey, clientName, clientGstin, onOpenSession, onNewSession, onBack, clients }) => {
  const [sessions,  setSessions]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [opening,   setOpening]   = useState(null);
  const [deleting,  setDeleting]  = useState(null);
  const [editing,   setEditing]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const key = encodeURIComponent(clientKey);
      const r   = await api.get(`/gst-reconciliation/client-sessions/${key}`);
      setSessions(r.data.sessions || []);
    } catch { toast.error('Failed to load client sessions'); }
    finally { setLoading(false); }
  }, [clientKey]);

  useEffect(() => { load(); }, [load]);

  const handleOpen = async (id) => {
    setOpening(id);
    try {
      const r    = await api.get(`/gst-reconciliation/history/${id}`);
      const sess = r.data || {};
      const full = sess.full_result || sess.fullResult;
      if (!full || (!full.matched && !full.mismatch && !full.portalOnly && !full.booksOnly)) {
        toast.error('This older session was saved without full data — re-run the reconciliation.');
        return;
      }
      onOpenSession?.({ result: full, company: sess.company || {}, period: sess.period || '',
        portalFilename: sess.portal_filename || '', booksFilename: sess.books_filename || '',
        sessionId: sess.id, clientName: sess.client_name || '', clientGstin: sess.client_gstin || '' });
    } catch { toast.error('Failed to open session'); }
    finally { setOpening(null); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this reconciliation session?')) return;
    setDeleting(id);
    try {
      await api.delete(`/gst-reconciliation/history/${id}`);
      setSessions(prev => prev.filter(s => s.id !== id));
      toast.success('Deleted');
    } catch { toast.error('Could not delete session'); }
    finally { setDeleting(null); }
  };

  const fmtD = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch { return d; }
  };

  const sm_val = (sm, key) => sm?.[key] ?? 0;

  return (
    <div>
      {/* Back header */}
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 transition-colors">
          <ChevronRight className="h-4 w-4 rotate-180"/>
          All Clients
        </button>
        <span className="text-slate-300 dark:text-slate-600">/</span>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
              {(clientName||'?')[0].toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate">{clientName}</p>
            {clientGstin && <p className="font-mono text-[10px] text-slate-400">{clientGstin}</p>}
          </div>
        </div>
        <button onClick={load} className="ml-auto flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 transition-colors">
          <RefreshCw className="h-3.5 w-3.5"/> Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col items-center py-16 text-slate-400">
          <Loader2 className="h-7 w-7 animate-spin mb-2 text-indigo-400"/>
          <p className="text-sm">Loading sessions…</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-slate-400">
          <History className="h-12 w-12 mb-3 text-slate-200 dark:text-slate-700"/>
          <p className="text-sm font-medium text-slate-500">No sessions found for this client.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-xs text-slate-400 mb-3">{sessions.length} reconciliation{sessions.length !== 1 ? 's' : ''} · newest first</p>
          {sessions.map(s => {
            const sm = s.summary || {};
            return (
              <motion.div key={s.id} layout
                className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 flex flex-col sm:flex-row sm:items-center gap-3 shadow-sm hover:shadow-md transition-shadow">
                {/* Month/Period badge */}
                <div className="flex-shrink-0">
                  <div className="px-3 py-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-center min-w-[72px]">
                    <p className="text-[10px] font-semibold text-indigo-500 dark:text-indigo-400 uppercase tracking-wide">Period</p>
                    <p className="text-sm font-bold text-indigo-700 dark:text-indigo-300 leading-tight mt-0.5">{s.period || '—'}</p>
                  </div>
                </div>
                {/* Stats */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap gap-2 mb-1.5">
                    {[
                      { label:'✓ Matched',     val: sm_val(sm,'matched_count'),     bg:'bg-emerald-100 dark:bg-emerald-900/30', text:'text-emerald-700 dark:text-emerald-300' },
                      { label:'⚠ Mismatch',    val: sm_val(sm,'mismatch_count'),    bg:'bg-amber-100 dark:bg-amber-900/30',    text:'text-amber-700 dark:text-amber-300' },
                      { label:'🌐 Portal Only', val: sm_val(sm,'portal_only_count'), bg:'bg-blue-100 dark:bg-blue-900/30',      text:'text-blue-700 dark:text-blue-300' },
                      { label:'📒 Books Only',  val: sm_val(sm,'books_only_count'),  bg:'bg-rose-100 dark:bg-rose-900/30',      text:'text-rose-700 dark:text-rose-300' },
                    ].map(p => (
                      <span key={p.label} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${p.bg} ${p.text}`}>
                        {p.label}: {p.val}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                    {sm.matched_value != null && <span>Matched: <strong className="text-slate-600 dark:text-slate-300">₹{fmt(sm.matched_value)}</strong></span>}
                    {sm.books_only_value != null && sm.books_only_value > 0 && <span>ITC Risk: <strong className="text-rose-600">₹{fmt(sm.books_only_value)}</strong></span>}
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3"/> {fmtD(s.created_at)}</span>
                    {s.created_by_name && <span>by {s.created_by_name}</span>}
                  </div>
                  {(s.portal_filename || s.books_filename) && (
                    <div className="flex flex-wrap gap-3 mt-1 text-[10px] text-slate-400">
                      {s.portal_filename && <span>🌐 {s.portal_filename}</span>}
                      {s.books_filename  && <span>📒 {s.books_filename}</span>}
                    </div>
                  )}
                </div>
                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* New Session — green, same shape as Open */}
                  <button
                    onClick={() => onNewSession?.({ clientName, clientGstin, clientId: clientKey })}
                    title="Start a new reconciliation for this company"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-600 dark:text-emerald-300 text-xs font-semibold border border-emerald-200 dark:border-emerald-800 transition-colors">
                    <Plus className="h-3.5 w-3.5"/>
                    New Session
                  </button>
                  {/* Open — indigo */}
                  <button
                    onClick={() => handleOpen(s.id)} disabled={opening === s.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300 text-xs font-semibold border border-indigo-200 dark:border-indigo-800 transition-colors">
                    {opening === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <FolderOpen className="h-3.5 w-3.5"/>}
                    Open
                  </button>
                  {/* Edit — amber icon only */}
                  <button
                    onClick={() => setEditing({ session: s })}
                    title="Edit details"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-600 dark:text-amber-300 text-xs font-semibold border border-amber-200 dark:border-amber-800 transition-colors">
                    <Edit3 className="h-3.5 w-3.5"/>
                  </button>
                  {/* Delete — rose icon only */}
                  <button
                    onClick={() => handleDelete(s.id)} disabled={deleting === s.id}
                    title="Delete this session"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/30 dark:hover:bg-rose-900/50 text-rose-500 dark:text-rose-400 text-xs font-semibold border border-rose-200 dark:border-rose-800 transition-colors">
                    {deleting === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Trash2 className="h-3.5 w-3.5"/>}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Edit modal */}
      <AnimatePresence>
        {editing && (
          <EditSessionModal
            session={editing.session}
            clients={clients}
            onSave={(updated) => {
              setSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   CLIENTS VIEW — all clients with GST reconciliation sessions
   Toggle between Card and List layouts; click a client to drill in.
═══════════════════════════════════════════════════════════════════════════ */
const ClientsView = ({ onOpenSession, clients = [], onDrillIn }) => {
  const [clientSummaries, setClientSummaries] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [viewMode, setViewMode] = useState('card');  // 'card' | 'list'
  const [search,   setSearch]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/gst-reconciliation/clients-summary');
      setClientSummaries(r.data.clients || []);
    } catch { toast.error('Failed to load client summaries'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = clientSummaries.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (c.client_name||'').toLowerCase().includes(q) ||
           (c.client_gstin||'').toLowerCase().includes(q);
  });

  const fmtD = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
    catch { return d; }
  };

  // The "drill-in key" is client_id if available, otherwise normalised name
  const drillKey = (c) => c.client_id || (c.client_name||'unknown').toLowerCase();

  if (loading) return (
    <div className="flex flex-col items-center py-20 text-slate-400">
      <Loader2 className="h-8 w-8 animate-spin mb-3 text-indigo-400"/>
      <p className="text-sm">Loading clients…</p>
    </div>
  );

  if (clientSummaries.length === 0) return (
    <div className="flex flex-col items-center py-20 text-slate-400">
      <Building2 className="h-14 w-14 mb-3 text-slate-200 dark:text-slate-700"/>
      <p className="font-medium text-slate-500 text-base">No clients yet</p>
      <p className="text-sm mt-1">Run a reconciliation and link it to a client — they'll appear here.</p>
    </div>
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"/>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
          <button onClick={() => setViewMode('card')}
            title="Card view"
            className={`p-1.5 rounded-md transition-colors ${viewMode === 'card' ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>
            <Layers className="h-3.5 w-3.5"/>
          </button>
          <button onClick={() => setViewMode('list')}
            title="List view"
            className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>
            <Filter className="h-3.5 w-3.5"/>
          </button>
        </div>
        <button onClick={load} className="flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 transition-colors">
          <RefreshCw className="h-3.5 w-3.5"/> Refresh
        </button>
        <p className="text-xs text-slate-400">{filtered.length} client{filtered.length !== 1 ? 's' : ''}</p>
      </div>

      {/* ── CARD VIEW ── */}
      {viewMode === 'card' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(c => (
            <motion.button
              key={drillKey(c)}
              layout
              whileHover={{ y: -2 }}
              onClick={() => onDrillIn(c)}
              className="text-left bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-700 transition-all group"
            >
              {/* Avatar + name */}
              <div className="flex items-start gap-3 mb-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-indigo-600 dark:text-indigo-400">
                    {(c.client_name||'?')[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                    {c.client_name || 'Unknown Client'}
                  </p>
                  {c.client_gstin && (
                    <p className="font-mono text-[10px] text-slate-400 truncate">{c.client_gstin}</p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-400 transition-colors flex-shrink-0 mt-0.5"/>
              </div>

              {/* Session count + last period */}
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                  <History className="h-3 w-3"/> {c.session_count} session{c.session_count !== 1 ? 's' : ''}
                </span>
                {c.last_period && (
                  <span className="text-[10px] text-slate-400">Last: <strong className="text-slate-600 dark:text-slate-300">{c.last_period}</strong></span>
                )}
              </div>

              {/* Mini stat row */}
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label:'Matched',    val: c.total_matched,    color:'text-emerald-600 dark:text-emerald-400', bg:'bg-emerald-50 dark:bg-emerald-900/20' },
                  { label:'Mismatch',   val: c.total_mismatch,   color:'text-amber-600 dark:text-amber-400',    bg:'bg-amber-50 dark:bg-amber-900/20' },
                  { label:'Portal Only',val: c.total_portal_only,color:'text-blue-600 dark:text-blue-400',      bg:'bg-blue-50 dark:bg-blue-900/20' },
                  { label:'Books Only', val: c.total_books_only, color:'text-rose-600 dark:text-rose-400',      bg:'bg-rose-50 dark:bg-rose-900/20' },
                ].map(s => (
                  <div key={s.label} className={`${s.bg} rounded-lg px-2 py-1`}>
                    <p className="text-[9px] font-medium text-slate-400 uppercase tracking-wide">{s.label}</p>
                    <p className={`text-sm font-bold ${s.color}`}>{s.val}</p>
                  </div>
                ))}
              </div>

              <p className="text-[10px] text-slate-300 dark:text-slate-600 mt-2.5">
                Last updated: {fmtD(c.last_date)}
              </p>
            </motion.button>
          ))}
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {viewMode === 'list' && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
          {/* List header */}
          <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
            <div className="col-span-4">Client</div>
            <div className="col-span-2 text-center">Sessions</div>
            <div className="col-span-2 text-center">Matched</div>
            <div className="col-span-2 text-center">Books Only</div>
            <div className="col-span-2 text-right">Last Period</div>
          </div>
          {filtered.map((c, i) => (
            <button
              key={drillKey(c)}
              onClick={() => onDrillIn(c)}
              className={`w-full grid grid-cols-12 gap-2 px-4 py-3 text-left hover:bg-indigo-50 dark:hover:bg-indigo-900/10 transition-colors group ${i < filtered.length - 1 ? 'border-b border-slate-100 dark:border-slate-700/50' : ''}`}
            >
              <div className="col-span-4 flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{(c.client_name||'?')[0].toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate group-hover:text-indigo-600 transition-colors">{c.client_name || 'Unknown'}</p>
                  {c.client_gstin && <p className="font-mono text-[10px] text-slate-400 truncate">{c.client_gstin}</p>}
                </div>
              </div>
              <div className="col-span-2 flex items-center justify-center">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{c.session_count}</span>
              </div>
              <div className="col-span-2 flex items-center justify-center">
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{c.total_matched}</span>
              </div>
              <div className="col-span-2 flex items-center justify-center">
                <span className={`text-sm font-semibold ${c.total_books_only > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>{c.total_books_only}</span>
              </div>
              <div className="col-span-2 flex items-center justify-end gap-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">{c.last_period || '—'}</span>
                <ChevronRight className="h-3.5 w-3.5 text-slate-300 group-hover:text-indigo-400 transition-colors"/>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const EMPTY_COMPANY = {
  name: '', gstin: '', pan: '', address: '', phone: '', email: '', fy: '',
};

export default function GSTReconciliation() {
  const [pageView,        setPageView]        = useState('new');   // 'new' | 'history' | 'clients' | 'session'
  const [clientDetail,    setClientDetail]    = useState(null);   // null | {client_id,client_name,client_gstin,...}
  const [sessions,        setSessions]        = useState([]);     // list of saved sessions for "New Session" tab
  const [portalFile,      setPortalFile]       = useState(null);
  const [booksFile,       setBooksFile]        = useState(null);
  const [lastParsedData,  setLastParsedData]   = useState(null); // cached portal+books arrays for Reco Again
  const [period,          setPeriod]           = useState('');
  const [company,         setCompany]          = useState(EMPTY_COMPANY);
  const [loading,         setLoading]          = useState(false);
  const [results,         setResults]          = useState(null);
  const [activeTab,       setActiveTab]        = useState('matched');
  const [showCo,          setShowCo]           = useState(true);
  const [itcModal,        setItcModal]         = useState(null); // null | 'claimable' | 'toBook' | 'atRisk'
  const [showCompare,     setShowCompare]      = useState(false);
  const [loadedSessionId, setLoadedSessionId]  = useState(null);  // when user opens a saved session
  const [baselineSnapshot, setBaselineSnapshot] = useState(null); // immutable copy of opened session
  const [snapshotSaved,    setSnapshotSaved]    = useState(false); // becomes true after baseline auto-save
  const [snapshotSaving,   setSnapshotSaving]   = useState(false);
  const [snapshotPrompt,   setSnapshotPrompt]   = useState(null); // {pendingEdit: () => void} | null
  const [invoiceDetail,    setInvoiceDetail]    = useState(null); // { record, tabId } | null
  const [showDateLog,      setShowDateLog]      = useState(false);
  const [dateLog,          setDateLog]          = useState([]);

  // Client integration
  const [clients,         setClients]          = useState([]);
  const [selectedClient,  setSelectedClient]   = useState(null);
  const [clientsLoading,  setClientsLoading]   = useState(false);

  // Manual trade names: gstin → name, persisted in localStorage across sessions
  const [manualTradeNames, setManualTradeNames] = useState(() => {
    try {
      const stored = localStorage.getItem('gst_manual_trade_names');
      return stored ? JSON.parse(stored) : {};
    } catch (_) { return {}; }
  });

  // Invoice comments: rowKey → comment string, persisted in localStorage
  const [invoiceComments, setInvoiceComments] = useState(() => {
    try {
      const stored = localStorage.getItem('gst_invoice_comments');
      return stored ? JSON.parse(stored) : {};
    } catch (_) { return {}; }
  });

  // AI Insights state
  const [aiInsights,     setAiInsights]     = useState('');
  const [aiInsightState, setAiInsightState] = useState('idle'); // idle | loading | done | error

  // GST Verification state
  const [gstStatusMap,   setGstStatusMap]   = useState({}); // GSTIN → { status, tradeName, legalName, state, ... }
  const [verifyingGST,   setVerifyingGST]   = useState(false);
  const [gstVerifyDone,  setGstVerifyDone]  = useState(false);

  const handleAiInsights = useCallback(async () => {
    if (!results) return;
    setAiInsightState('loading');
    setAiInsights('');
    try {
      const token = localStorage.getItem('token') || '';
      const matched    = results.matched    || [];
      const mismatch   = results.mismatch   || [];
      const portalOnly = results.portalOnly || [];
      const booksOnly  = results.booksOnly  || [];

      const body = {
        summary: {
          total_portal:      matched.length + mismatch.length + portalOnly.length,
          total_books:       matched.length + mismatch.length + booksOnly.length,
          matched_count:     matched.length,
          matched_value:     sumVal(matched,    'portal'),
          mismatch_value:    sumVal(mismatch,   'portal'),
          portal_only_value: sumVal(portalOnly, 'portal'),
          books_only_value:  sumVal(booksOnly,  'books'),
          fuzzy_matched_count: 0,
          duplicate_portal: 0,
          duplicate_books:  0,
        },
        mismatch_count:     mismatch.length,
        portal_only_count:  portalOnly.length,
        books_only_count:   booksOnly.length,
        high_risk_vendors:  0,
        itc_eligible_total: sumVal(matched,    'portal'),
        itc_at_risk_total:  sumVal(booksOnly,  'books'),
        period,
        top_mismatches: mismatch.slice(0, 5).map(r => ({
          portal: {
            gstin:            r.portal?.gstin,
            invoice_no_raw:   r.portal?.invoiceNoRaw,
            invoice_value:    r.portal?.invoiceValue || 0,
          },
          books: {
            invoice_value:    r.books?.invoiceValue || 0,
          },
          mismatch_reason:  r.mismatchReason || '',
          value_diff:       r.valueDiff || 0,
          tax_diff:         r.taxDiff   || 0,
        })),
      };

      const res = await fetch('/api/gst-reconciliation/ai-insights', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error: ${res.status}`);
      }
      const data = await res.json();
      setAiInsights(data.insights || 'No insights generated.');
      setAiInsightState('done');
    } catch (e) {
      setAiInsights(`Failed to generate insights: ${e.message}`);
      setAiInsightState('error');
    }
  }, [results, company, period]);

  // ── GST Verification ──────────────────────────────────────────────────────
  const verifyAllGSTINs = useCallback(async () => {
    if (!results) return;
    const allRecs = [
      ...(results.matched    || []),
      ...(results.mismatch   || []),
      ...(results.portalOnly || []),
      ...(results.booksOnly  || []),
      ...(results.crossGstin || []),
    ];
    const gstins = [...new Set(
      allRecs
        .map(r => r.portal?.gstin || r.books?.gstin || r.gstin)
        .filter(Boolean)
        .map(g => String(g).trim().toUpperCase())
        .filter(g => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g))
    )];
    if (!gstins.length) {
      toast.error('No valid GSTINs found in current results.');
      return;
    }
    setVerifyingGST(true);
    setGstVerifyDone(false);
    try {
      const res = await fetch('/api/gst-reconciliation/verify-gstins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gstins }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      const map = {};
      (data.results || []).forEach(r => { map[r.gstin] = r; });
      setGstStatusMap(map);
      setGstVerifyDone(true);
      const active    = (data.results || []).filter(r => (r.status || '').toLowerCase() === 'active').length;
      const inactive  = (data.results || []).filter(r => (r.status || '').toLowerCase() !== 'active' && r.status !== 'Lookup failed' && r.status !== 'Invalid GSTIN').length;
      toast.success(`GST status verified: ${active} active, ${inactive} inactive/cancelled out of ${gstins.length} GSTINs.`);
    } catch (e) {
      toast.error(`GST verification failed: ${e.message}`);
    } finally {
      setVerifyingGST(false);
    }
  }, [results]);

  const onSaveComment = useCallback((key, comment) => {
    setInvoiceComments(prev => {
      const updated = { ...prev };
      if (comment && comment.trim()) {
        updated[key] = comment.trim();
      } else {
        delete updated[key];
      }
      try { localStorage.setItem('gst_invoice_comments', JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
  }, []);

  const onSaveTradeName = useCallback((gstin, name) => {
    const upperGstin = gstin.toUpperCase();
    setManualTradeNames(prev => {
      const updated = { ...prev, [upperGstin]: name };
      try { localStorage.setItem('gst_manual_trade_names', JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
    // Save to backend so ALL users immediately see this party name (shared across users)
    api.post('/gst-reconciliation/trade-names', { gstin: upperGstin, name })
      .catch(() => {}); // silent — localStorage copy is the fallback
    toast.success(`Party name saved — visible to all users`, { duration: 2500 });
  }, []);

  // Auto-fetch trade names for all Books Only GSTINs after reconciliation
  // Uses the same clientGstinLookup engine (no backend needed) with gentle rate-limiting
  useEffect(() => {
    if (!results?.booksOnly?.length) return;
    const unique = [...new Set(
      results.booksOnly.map(r => r.books?.gstin).filter(g => g && GSTIN_PATTERN.test(g))
    )];
    // Skip GSTINs already known (from this session or localStorage)
    const toFetch = unique.filter(g => !manualTradeNames[g.toUpperCase()]);
    if (!toFetch.length) return;

    let cancelled = false;
    (async () => {
      for (const g of toFetch.slice(0, 30)) {
        if (cancelled) break;
        try {
          const res = await clientGstinLookup(g);
          const name = res.tradeName || res.legalName || '';
          if (name && !cancelled) {
            setManualTradeNames(prev => {
              if (prev[g.toUpperCase()]) return prev;
              const updated = { ...prev, [g.toUpperCase()]: name };
              try { localStorage.setItem('gst_manual_trade_names', JSON.stringify(updated)); } catch (_) {}
              return updated;
            });
          }
        } catch (_) { /* silent */ }
        await new Promise(r => setTimeout(r, 200));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results?.booksOnly]);

  const [gstinLookupLoading, setGstinLookupLoading] = useState(false);
  const [autofetchingSuppliers, setAutofetchingSuppliers] = useState(false);
  const [supplierFetchProgress, setSupplierFetchProgress] = useState(null);
  const gstinLookupTimer = useRef(null);

  // Auto-register and add client to software client list (both in React state and MongoDB)
  const handleAutoRegisterClient = useCallback(async (gstinVal, nameVal, details = {}) => {
    if (!gstinVal || !nameVal) return;
    try {
      const res = await api.post('/gst-reconciliation/auto-register-client', {
        gstin: gstinVal,
        company_name: nameVal,
        name: nameVal,
        pan: details.pan || gstinVal.slice(2, 12),
        address: details.address || '',
        state: details.state || '',
      });
      if (res.data?.client) {
        const cl = res.data.client;
        setClients(prev => {
          const idx = prev.findIndex(c => c.gstin === gstinVal || c.id === cl.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...cl };
            return next;
          }
          return [cl, ...prev];
        });
        setSelectedClient(cl);
      }
    } catch (_) {
      // Local state fallback
      setClients(prev => {
        if (prev.some(c => c.gstin === gstinVal)) return prev;
        const newC = {
          id: `auto_${gstinVal}`,
          company_name: nameVal,
          gstin: gstinVal,
          pan: details.pan || gstinVal.slice(2, 12),
          address: details.address || '',
        };
        setSelectedClient(newC);
        return [newC, ...prev];
      });
    }
  }, []);

  const triggerCompanyAutofetch = useCallback(async (gstinToFetch) => {
    const g = (gstinToFetch || company.gstin || '').trim().toUpperCase();
    if (!GSTIN_PATTERN.test(g)) {
      toast.error('Please enter a valid 15-character GSTIN');
      return;
    }
    setGstinLookupLoading(true);
    try {
      const result = await clientGstinLookup(g);
      const name = result.tradeName || result.legalName || '';
      const pan = result.pan || g.slice(2, 12);
      const address = result.address || (result.state ? `Registered Office, ${result.state}` : '');
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const fy = currentMonth >= 4 ? `${currentYear}-${String(currentYear + 1).slice(2)}` : `${currentYear - 1}-${String(currentYear).slice(2)}`;

      setCompany(prev => ({
        ...prev,
        gstin: g,
        name: name || prev.name,
        pan: pan || prev.pan,
        address: prev.address || address,
        fy: prev.fy || fy,
      }));

      if (name) {
        toast.success(`✨ Company "${name}" autofetched & added to client list!`, { duration: 4000 });
        await handleAutoRegisterClient(g, name, { pan, address, state: result.state });
      } else if (result.state) {
        toast.info(`GSTIN Valid (${result.state}) — PAN: ${pan}`, { duration: 3000 });
      }
    } catch (err) {
      toast.error('Could not autofetch details for GSTIN');
    } finally {
      setGstinLookupLoading(false);
    }
  }, [company.gstin, handleAutoRegisterClient]);

  const setCo = (k, v) => {
    setCompany(p => ({ ...p, [k]: v }));
    // Auto-fetch company name & add to list when a valid GSTIN is typed
    if (k === 'gstin') {
      const g = v.trim().toUpperCase();
      clearTimeout(gstinLookupTimer.current);
      if (GSTIN_PATTERN.test(g)) {
        gstinLookupTimer.current = setTimeout(() => {
          triggerCompanyAutofetch(g);
        }, 500);
      }
    }
  };

  // Comprehensive Batch Autofetch for all supplier names in the current reconciliation
  const autofetchMissingSupplierNames = useCallback(async () => {
    if (!results) return;
    const allPairs = [
      ...(results.matched || []),
      ...(results.mismatch || []),
      ...(results.portalOnly || []),
      ...(results.booksOnly || []),
    ];

    const uniqueGstins = new Set();
    const portalNames = {};

    allPairs.forEach(p => {
      const pInv = p.portal?.portal || p.portal;
      const bInv = p.books?.books || p.books;
      const pg = pInv?.gstin;
      const bg = bInv?.gstin;
      if (pg && GSTIN_PATTERN.test(pg)) {
        const uG = pg.toUpperCase();
        uniqueGstins.add(uG);
        if (pInv?.tradeOrLegalName) portalNames[uG] = pInv.tradeOrLegalName;
      }
      if (bg && GSTIN_PATTERN.test(bg)) {
        uniqueGstins.add(bg.toUpperCase());
      }
    });

    const missing = [...uniqueGstins].filter(g => !manualTradeNames[g] && !portalNames[g]);
    if (!missing.length) {
      toast.success('All supplier company names are already resolved in the report!');
      return;
    }

    setAutofetchingSuppliers(true);
    setSupplierFetchProgress({ current: 0, total: missing.length });

    try {
      const chunkSize = 30;
      const newlyResolved = {};

      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize);
        try {
          const res = await api.post('/gst-reconciliation/gstin-lookup-batch', { gstins: chunk });
          const batchResults = res.data?.results || {};
          Object.entries(batchResults).forEach(([g, info]) => {
            const name = info?.trade_name || info?.legal_name;
            if (name) newlyResolved[g.toUpperCase()] = name;
          });
        } catch (_) {
          for (const g of chunk) {
            try {
              const info = await clientGstinLookup(g);
              const name = info?.tradeName || info?.legalName;
              if (name) newlyResolved[g.toUpperCase()] = name;
            } catch (_) {}
          }
        }
        setSupplierFetchProgress({ current: Math.min(i + chunkSize, missing.length), total: missing.length });
      }

      if (Object.keys(newlyResolved).length > 0) {
        setManualTradeNames(prev => {
          const updated = { ...prev, ...newlyResolved };
          try { localStorage.setItem('gst_manual_trade_names', JSON.stringify(updated)); } catch (_) {}
          return updated;
        });

        try {
          await api.post('/gst-reconciliation/trade-names/batch', { names: newlyResolved });
        } catch (_) {}

        toast.success(`✨ Autofetched ${Object.keys(newlyResolved).length} supplier company names into list!`);
      } else {
        toast.info('Supplier verification completed. Status and states mapped.');
      }
    } catch (err) {
      toast.error('Error during supplier autofetch');
    } finally {
      setAutofetchingSuppliers(false);
      setSupplierFetchProgress(null);
    }
  }, [results, manualTradeNames]);

  // Auto-save the original (pre-edit) baseline of an opened history session.
  // Returns a Promise that resolves when the snapshot is safely persisted.
  const saveBaselineSnapshot = useCallback(async () => {
    if (!baselineSnapshot || snapshotSaved) return true;
    setSnapshotSaving(true);
    try {
      const snap = baselineSnapshot;
      const sm = {
        total_portal:       (snap.result?.matched?.length || 0) + (snap.result?.mismatch?.length || 0) + (snap.result?.portalOnly?.length || 0),
        total_books:        (snap.result?.matched?.length || 0) + (snap.result?.mismatch?.length || 0) + (snap.result?.booksOnly?.length || 0),
        matched_count:      snap.result?.matched?.length     || 0,
        mismatch_count:     snap.result?.mismatch?.length    || 0,
        portal_only_count:  snap.result?.portalOnly?.length  || 0,
        books_only_count:   snap.result?.booksOnly?.length   || 0,
        matched_value:      sumVal(snap.result?.matched || [], 'portal'),
        mismatch_value:     sumVal(snap.result?.mismatch || [], 'portal'),
        portal_only_value:  sumVal(snap.result?.portalOnly || [], 'portal'),
        books_only_value:   sumVal(snap.result?.booksOnly || [], 'books'),
        is_baseline_snapshot: true,
        original_session_id:  snap.sessionId || null,
      };
      const r = await api.post('/gst-reconciliation/save-session', {
        period:          snap.period || period,
        client_id:       selectedClient?.id || null,
        client_name:     (snap.company?.name) || company.name || `[Snapshot] ${snap.clientName || 'Reconciliation'}`,
        client_gstin:    (snap.company?.gstin) || company.gstin || snap.clientGstin || null,
        portal_filename: `[snapshot] ${snap.portalFilename || ''}`,
        books_filename:  `[snapshot] ${snap.booksFilename || ''}`,
        summary:         sm,
        full_result:     snap.result,
        company:         snap.company || {},
      });
      setSnapshotSaved(true);
      toast.success('Baseline snapshot saved to history — your original is safe.', {
        description: r?.data?.session_id ? `Snapshot ID: ${r.data.session_id.slice(0,8)}…` : undefined,
      });
      return true;
    } catch (e) {
      console.error(e);
      toast.error('Could not save snapshot. Edit cancelled — please try again.');
      return false;
    } finally {
      setSnapshotSaving(false);
    }
  }, [baselineSnapshot, snapshotSaved, period, selectedClient, company]);

  // Wrap any edit action: if we are inside an opened history session and have not
  // yet saved a baseline snapshot, prompt the user to confirm. Once confirmed and
  // the snapshot is persisted, run the edit. If no baseline (fresh run), run immediately.
  const guardEdit = useCallback((editFn) => {
    if (!baselineSnapshot || snapshotSaved) {
      editFn();
      return;
    }
    setSnapshotPrompt({ pendingEdit: editFn });
  }, [baselineSnapshot, snapshotSaved]);

  // Mark an invoice from mismatch/portalOnly/booksOnly as manually matched
  const handleMarkMatched = useCallback((record, tabId) => {
    guardEdit(() => setResults(prev => {
      if (!prev) return prev;
      const updated = { ...prev };
      // Remove from source tab
      if (tabId === 'mismatch')    updated.mismatch    = prev.mismatch.filter(r => r.key !== record.key);
      if (tabId === 'portalOnly')  updated.portalOnly  = prev.portalOnly.filter(r => r.key !== record.key);
      if (tabId === 'booksOnly')   updated.booksOnly   = prev.booksOnly.filter(r => r.key !== record.key);
      // Add to matched as manually confirmed
      const portal = record.portal || record.books;
      const books  = record.books  || record.portal;
      updated.matched = [...prev.matched, { ...record, portal, books, manualMatch: true }];
      return updated;
    }));
    toast.success('Invoice marked as Matched');
  }, [guardEdit]);

  // Confirm a pair from Side-by-Side Compare as manually matched
  const handleConfirmMatch = useCallback((pair) => {
    guardEdit(() => setResults(prev => {
      if (!prev) return prev;
      const updated = { ...prev };
      // Remove from portalOnly/booksOnly and crossGstin
      updated.portalOnly  = prev.portalOnly.filter(r => r.key !== pair.portal?.key);
      updated.booksOnly   = prev.booksOnly.filter(r  => r.key !== pair.books?.key);
      updated.crossGstin  = (prev.crossGstin||[]).filter(r => r.key !== pair.key && r.key !== pair.portal?.key);
      const pInv = pair.portal?.portal || pair.portal;
      const bInv = pair.books?.books   || pair.books;
      updated.matched = [...prev.matched, {
        portal: pInv,
        books:  bInv,
        key:    pair.portal?.key || pair.books?.key || pair.key,
        manualMatch: true,
        gstinMismatchResolved: true,
        normalizedMatch: (pInv?.invoiceNoRaw || '') !== (bInv?.invoiceNoRaw || ''),
      }];
      return updated;
    }));
    const pInv = pair.portal?.portal || pair.portal;
    const bInv = pair.books?.books   || pair.books;
    toast.success(`GSTIN Conflict Resolved: ${pInv?.invoiceNoRaw} ↔ ${bInv?.invoiceNoRaw}`);
  }, [guardEdit]);

  // Load shared trade names from backend on mount — merges with localStorage cache.
  // Backend is the single source of truth: names saved by ANY user (or session) are
  // always used. localStorage is only kept as an offline fallback for names the
  // current user added that haven't synced yet.
  useEffect(() => {
    api.get('/gst-reconciliation/trade-names')
      .then(r => {
        const backendNames = r.data?.names || {};
        if (!Object.keys(backendNames).length) return;
        setManualTradeNames(prev => {
          // Backend wins over localStorage — prevents stale local data hiding shared names.
          // Local-only keys (not yet synced) are preserved by spreading prev first.
          const merged = { ...prev, ...backendNames };
          try { localStorage.setItem('gst_manual_trade_names', JSON.stringify(merged)); } catch (_) {}
          return merged;
        });
      })
      .catch(() => {}); // silent — works offline with localStorage
  }, []);

  // Fetch clients on mount
  useEffect(() => {
    setClientsLoading(true);
    api.get('/gst-reconciliation/clients')
      .then(r => setClients(r.data.clients || []))
      .catch(() => {})
      .finally(() => setClientsLoading(false));
  }, []);

  // When client is selected, auto-fill company form
  const handleClientSelect = (client) => {
    setSelectedClient(client);
    if (!client) return;
    const address = [client.address, client.city, client.state].filter(Boolean).join(', ');
    const email   = client.email || client.contact_persons?.[0]?.email || '';
    const phone   = client.phone || client.contact_persons?.[0]?.phone || '';
    setCompany(prev => ({
      ...prev,
      name:    client.company_name || prev.name,
      gstin:   client.gstin        || prev.gstin,
      pan:     client.pan          || prev.pan,
      address: address             || prev.address,
      phone:   phone               || prev.phone,
      email:   email               || prev.email,
    }));
  };

  const handlePortalFile = async (file) => {
    setPortalFile(file);
    if (!file) return;
    try {
      const wb = await readWorkbook(file);
      const meta = extractPortalMetadata(wb);
      // Auto-fill period only if user hasn't typed one yet
      if (meta.period) setPeriod(prev => prev || meta.period);

      const targetG = meta.gstin || company.gstin || '';
      let targetName = meta.tradeName || '';

      if (targetG && GSTIN_PATTERN.test(targetG)) {
        setGstinLookupLoading(true);
        try {
          const result = await clientGstinLookup(targetG);
          targetName = targetName || result.tradeName || result.legalName || '';
          const pan = result.pan || targetG.slice(2, 12);
          const address = result.address || (result.state ? `Registered Office, ${result.state}` : '');

          setCompany(prev => ({
            ...prev,
            gstin: targetG,
            name: targetName || prev.name,
            pan: pan || prev.pan,
            address: prev.address || address,
          }));

          if (targetName) {
            await handleAutoRegisterClient(targetG, targetName, { pan, address, state: result.state });
            toast.success(`✨ Company "${targetName}" auto-detected from GSTR-2B and added to client list!`, { duration: 4000 });
          }
        } catch (_) {}
        finally { setGstinLookupLoading(false); }
      } else if (meta.period || meta.tradeName) {
        setCompany(prev => ({
          ...prev,
          name: meta.tradeName || prev.name,
        }));
        toast.success(`Period & details auto-detected from GSTR-2B: ${meta.tradeName || meta.period}`, { duration: 3000 });
      }
    } catch (_) { /* If metadata extraction fails, silently continue */ }
  };

  const readWorkbook = async file => {
    XLSX = await getXLSX();
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = e => { try { res(XLSX.read(e.target.result, { type:'array', raw:false })); } catch(err) { rej(err); } };
      reader.onerror = rej;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleReconcile = async () => {
    if (!portalFile || !booksFile) { toast.error('Please upload both files.'); return; }
    setLoading(true); setResults(null);
    try {
      const [portalWB, booksWB] = await Promise.all([readWorkbook(portalFile), readWorkbook(booksFile)]);
      const portalData = parseGSTPortalFile(portalWB);
      const booksData  = parseBooksFile(booksWB, booksFile?.name || '');
      setLastParsedData({ portalData, booksData }); // cache for Reco Again
      if (!portalData.length && !booksData.length) { toast.error('Could not parse data from the files. Please check the file formats.'); return; }
      const res = reconcile(portalData, booksData);
      setResults(res);
      setDateLog(getDateFormatLog());
      // Default to first actionable category with records, else matched
      const defaultTab = res.mismatch?.length ? 'mismatch' : res.portalOnly?.length ? 'portalOnly' : res.booksOnly?.length ? 'booksOnly' : 'matched';
      setActiveTab(defaultTab);
      toast.success(`Reconciliation complete — ${portalData.length} portal + ${booksData.length} books invoices.`);

      // Automatically autofetch missing supplier company names in background
      setTimeout(() => {
        autofetchMissingSupplierNames();
      }, 300);

      // Auto-save session to history
      const summary = {
        total_portal:       portalData.length,
        total_books:        booksData.length,
        matched_count:      res.matched.length,
        mismatch_count:     res.mismatch.length,
        portal_only_count:  res.portalOnly.length,
        books_only_count:   res.booksOnly.length,
        matched_value:      sumVal(res.matched, 'portal'),
        mismatch_value:     sumVal(res.mismatch, 'portal'),
        portal_only_value:  sumVal(res.portalOnly, 'portal'),
        books_only_value:   sumVal(res.booksOnly, 'books'),
        matched_tax:        sumTax(res.matched, 'portal'),
        mismatch_tax:       sumTax(res.mismatch, 'portal'),
        portal_only_tax:    sumTax(res.portalOnly, 'portal'),
        books_only_tax:     sumTax(res.booksOnly, 'books'),
      };
      api.post('/gst-reconciliation/save-session', {
        period,
        client_id:       selectedClient?.id       || null,
        client_name:     company.name              || selectedClient?.company_name || null,
        client_gstin:    company.gstin             || selectedClient?.gstin || null,
        portal_filename: portalFile.name,
        books_filename:  booksFile.name,
        summary,
        full_result: res,                  // full reconciliation payload — enables re-open + edit
        company,                            // company details for header restoration
      }).then(r => {
        if (r?.data?.session_id) setLoadedSessionId(r.data.session_id);
      }).catch(() => {}); // fire-and-forget

    } catch (err) {
      console.error(err); toast.error(`Failed: ${err.message}`);
    } finally { setLoading(false); }
  };

  const handleReset = () => { setPortalFile(null); setBooksFile(null); setResults(null); setPeriod(''); setLoadedSessionId(null); setBaselineSnapshot(null); setSnapshotSaved(false); setSnapshotPrompt(null); setLastParsedData(null); };

  // Re-run reconciliation on the last parsed data (or re-parse files if still available)
  const handleReReconcile = async () => {
    if (!lastParsedData && !portalFile && !booksFile) {
      toast.info('No recent data in memory. Please upload files again.');
      setResults(null); setPageView('new');
      return;
    }
    setLoading(true); setResults(null);
    try {
      let portalData, booksData;
      if (lastParsedData) {
        portalData = lastParsedData.portalData;
        booksData  = lastParsedData.booksData;
      } else {
        const [portalWB, booksWB] = await Promise.all([readWorkbook(portalFile), readWorkbook(booksFile)]);
        portalData = parseGSTPortalFile(portalWB);
        booksData  = parseBooksFile(booksWB, booksFile?.name || '');
        setLastParsedData({ portalData, booksData });
      }
      if (!portalData.length && !booksData.length) { toast.error('No data found.'); return; }
      const res = reconcile(portalData, booksData);
      setResults(res);
      setDateLog(getDateFormatLog());
      const defaultTab = res.mismatch?.length ? 'mismatch' : res.portalOnly?.length ? 'portalOnly' : res.booksOnly?.length ? 'booksOnly' : 'matched';
      setActiveTab(defaultTab);
      toast.success('Re-reconciliation complete.');
    } catch (err) {
      console.error(err); toast.error(`Failed: ${err.message}`);
    } finally { setLoading(false); }
  };

  // Update Session: when an opened-from-history session has been edited,
  // overwrite the original saved snapshot with the current results so the
  // latest edit becomes the canonical version (no separate baseline copy).
  const [updatingSession, setUpdatingSession] = useState(false);
  const handleUpdateSession = useCallback(async () => {
    if (!loadedSessionId || !results) {
      toast.info('No opened session to update.');
      return;
    }
    setUpdatingSession(true);
    try {
      const summary = {
        total_portal:      (results.matched?.length||0)+(results.mismatch?.length||0)+(results.portalOnly?.length||0),
        total_books:       (results.matched?.length||0)+(results.mismatch?.length||0)+(results.booksOnly?.length||0),
        matched_count:     results.matched?.length     || 0,
        mismatch_count:    results.mismatch?.length    || 0,
        portal_only_count: results.portalOnly?.length  || 0,
        books_only_count:  results.booksOnly?.length   || 0,
        matched_value:     sumVal(results.matched    || [], 'portal'),
        mismatch_value:    sumVal(results.mismatch   || [], 'portal'),
        portal_only_value: sumVal(results.portalOnly || [], 'portal'),
        books_only_value:  sumVal(results.booksOnly  || [], 'books'),
        updated_at_client: new Date().toISOString(),
      };
      await api.patch(`/gst-reconciliation/history/${loadedSessionId}`, {
        period:       period || undefined,
        client_id:    selectedClient?.id || undefined,
        client_name:  company.name || undefined,
        client_gstin: company.gstin || undefined,
        company,
        summary,
        full_result: results,
      });
      // Latest edit is now the canonical snapshot — no baseline auto-save needed.
      setBaselineSnapshot(null);
      setSnapshotSaved(true);
      setSnapshotPrompt(null);
      toast.success('Session updated — latest edits saved as the final snapshot.');
    } catch (e) {
      console.error(e);
      toast.error('Failed to update session. Please try again.');
    } finally {
      setUpdatingSession(false);
    }
  }, [loadedSessionId, results, period, selectedClient, company]);

  // New Session: save current session (if any) then reset for a fresh start.
  // We intentionally preserve selectedClient so the next session auto-links
  // to the same client (preventing duplicate client cards in the Clients view).
  const handleNewSession = useCallback(() => {
    if (results) {
      const snapshot = {
        id: Date.now(),
        period,
        companyName: company.name || 'Untitled',
        matched: results.matched?.length || 0,
        mismatch: results.mismatch?.length || 0,
        portalOnly: results.portalOnly?.length || 0,
        booksOnly: results.booksOnly?.length || 0,
        savedAt: new Date().toLocaleString(),
      };
      setSessions(prev => [snapshot, ...prev]);
      toast.success('Current session saved. Starting a new session.');
    }
    handleReset();
    setPageView('new');
    setCompany(EMPTY_COMPANY);
    setClientDetail(null);
    // NOTE: selectedClient is intentionally NOT cleared here.
    // This ensures the new session will still be associated with the same client.
  }, [results, period, company]);

  const activeRecords = results && activeTab !== 'search'
    ? { matched:results.matched, mismatch:results.mismatch, portalOnly:results.portalOnly, booksOnly:results.booksOnly, crossGstin: results.crossGstin||[] }[activeTab] || []
    : [];
  // On fresh reconciliation, default to mismatch if there are any, else portalOnly, else matched
  const activeTabMeta = TABS.find(t => t.id === activeTab);

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-900">
      <div className="w-full">

        {/* ── Dashboard-Style Banner ── */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl mb-5 overflow-hidden shadow-md"
          style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1F6FB2 60%, #2563eb 100%)' }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-5">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-white/15 backdrop-blur-sm flex-shrink-0">
                <ArrowLeftRight className="h-6 w-6 text-white"/>
              </div>
              <div>
                <p className="text-white/70 text-xs font-medium uppercase tracking-wider mb-0.5">CompliGenie · GST Sphere</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="text-xl font-bold text-white leading-tight">GST Sphere</h1>
                  <Link
                    to="/gst-portal-sync"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-white text-[11px] font-semibold transition-all border border-white/25"
                  >
                    <Globe className="h-3 w-3" />
                    Live Portal Sync &amp; Free API Hub →
                  </Link>
                </div>
                <p className="text-white/65 text-xs mt-0.5">Reconcile GSTR-2B (GST Portal) with Purchase Register (Books) &amp; Electronic Ledgers</p>
              </div>
            </div>
            {/* Metric tiles — shown once results are loaded */}
            {results ? (
              <div className="flex flex-wrap gap-3 sm:gap-4">
                {[
                  { label: 'Matched', value: results.matched?.length || 0, icon: CheckCircle2, color: 'text-emerald-300', bg: 'bg-emerald-500/20' },
                  { label: 'Mismatch', value: results.mismatch?.length || 0, icon: AlertTriangle, color: 'text-amber-300', bg: 'bg-amber-500/20' },
                  { label: 'Portal Only', value: results.portalOnly?.length || 0, icon: Globe, color: 'text-sky-300', bg: 'bg-sky-500/20' },
                  { label: 'Books Only', value: results.booksOnly?.length || 0, icon: BookOpen, color: 'text-violet-300', bg: 'bg-violet-500/20' },
                ].map(m => (
                  <div key={m.label} className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl ${m.bg} border border-white/10`}>
                    <m.icon className={`h-4 w-4 ${m.color} flex-shrink-0`} />
                    <div>
                      <p className="text-white font-bold text-lg leading-none">{m.value}</p>
                      <p className={`text-[10px] font-medium mt-0.5 ${m.color}`}>{m.label}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {/* Export buttons strip when results exist */}
          {results && (
            <div className="flex flex-wrap items-center gap-2 px-5 py-3 bg-black/20 border-t border-white/10">
              {/* Back navigation */}
              <button onClick={() => { setResults(null); setPageView('clients'); setClientDetail(null); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-medium rounded-lg border border-white/20 transition-colors">
                <ArrowLeft className="h-3.5 w-3.5"/> Clients
              </button>
              <button onClick={() => { setResults(null); setPageView('history'); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-medium rounded-lg border border-white/20 transition-colors">
                <ArrowLeft className="h-3.5 w-3.5"/> History
              </button>
              <span className="w-px h-5 bg-white/20"/>
              <button onClick={()=>exportPDF(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium rounded-lg shadow-sm transition-colors">
                <FileText className="h-3.5 w-3.5"/> PDF
              </button>
              <button onClick={()=>exportWord(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg shadow-sm transition-colors">
                <FileText className="h-3.5 w-3.5"/> Word
              </button>
              <button onClick={()=>exportExcel(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg shadow-sm transition-colors">
                <FileSpreadsheet className="h-3.5 w-3.5"/> Excel
              </button>
              {loadedSessionId && (
                <button
                  onClick={handleUpdateSession}
                  disabled={updatingSession}
                  title="Overwrite the original saved snapshot with the current (edited) results"
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm border border-emerald-400/40 transition-colors"
                >
                  {updatingSession
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/> Updating…</>
                    : <><Save className="h-3.5 w-3.5"/> Update</>}
                </button>
              )}
              {dateLog.length > 0 && (
                <button
                  onClick={() => setShowDateLog(true)}
                  title="See which input date formats were detected and how they were normalised"
                  className={`${loadedSessionId ? '' : 'ml-auto '}flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg border border-amber-400/40 shadow-sm transition-colors`}
                >
                  <CalendarClock className="h-3.5 w-3.5"/> Date Log ({dateLog.length})
                </button>
              )}
              <button onClick={handleNewSession} className={`${(loadedSessionId || dateLog.length > 0) ? '' : 'ml-auto '}flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-medium rounded-lg border border-white/20 transition-colors`}>
                <Plus className="h-3.5 w-3.5"/> New Session
              </button>
              <button onClick={handleReset} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-medium rounded-lg border border-white/10 transition-colors">
                <RefreshCw className="h-3.5 w-3.5"/> Reset
              </button>
            </div>
          )}
        </motion.div>

        {/* ── Page View Switcher ── */}
        {!results && (
          <div className="flex flex-wrap gap-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl mb-5 w-fit p-1 shadow-sm">
            {[
              { id: 'new',     label: 'New Reconciliation', icon: ArrowLeftRight },
              { id: 'clients', label: 'Clients',            icon: Building2 },
              { id: 'history', label: 'History',            icon: History },
            ].map(v => (
              <button
                key={v.id}
                onClick={() => { setPageView(v.id); setClientDetail(null); }}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  pageView === v.id
                    ? 'bg-indigo-50 dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-sm border border-indigo-100 dark:border-slate-600'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <v.icon className="h-3.5 w-3.5" />
                {v.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Clients View ── */}
        {pageView === 'clients' && !results && !clientDetail && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-5">
              <Building2 className="h-5 w-5 text-indigo-500" />
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">Clients</h2>
              <span className="ml-auto text-[11px] text-slate-400">Click any client to view their month-wise reconciliation history.</span>
            </div>
            <ClientsView
              onOpenSession={null}
              clients={clients}
              onDrillIn={(c) => setClientDetail(c)}
            />
          </div>
        )}

        {/* ── Client Detail View (drill-in) ── */}
        {pageView === 'clients' && !results && clientDetail && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <ClientDetailView
              clientKey={clientDetail.client_id || (clientDetail.client_name||'unknown').toLowerCase()}
              clientName={clientDetail.client_name}
              clientGstin={clientDetail.client_gstin}
              clients={clients}
              onBack={() => setClientDetail(null)}
              onOpenSession={(payload) => {
                setResults(payload.result);
                setActiveTab('matched');
                setPeriod(payload.period || '');
                if (payload.company && Object.keys(payload.company).length) {
                  setCompany(prev => ({ ...prev, ...payload.company }));
                } else if (payload.clientName || payload.clientGstin) {
                  setCompany(prev => ({ ...prev, name: payload.clientName || prev.name, gstin: payload.clientGstin || prev.gstin }));
                }
                setLoadedSessionId(payload.sessionId || null);
                setBaselineSnapshot({
                  result:         JSON.parse(JSON.stringify(payload.result)),
                  company:        payload.company || {},
                  period:         payload.period || '',
                  portalFilename: payload.portalFilename || '',
                  booksFilename:  payload.booksFilename  || '',
                  sessionId:      payload.sessionId || null,
                  clientName:     payload.clientName || '',
                  clientGstin:    payload.clientGstin || '',
                  openedAt:       new Date().toISOString(),
                });
                setSnapshotSaved(false);
                setClientDetail(null);
                setPageView('new');
                api.get('/gst-reconciliation/trade-names')
                  .then(r => {
                    const backendNames = r.data?.names || {};
                    if (!Object.keys(backendNames).length) return;
                    setManualTradeNames(prev => ({ ...prev, ...backendNames }));
                  })
                  .catch(() => {});
                toast.success('Reconciliation loaded — fully editable.');
              }}
              onNewSession={({ clientName: cn, clientGstin: cg, clientId: cid } = {}) => {
                handleReset();
                setCompany(prev => ({ ...EMPTY_COMPANY, name: cn || '', gstin: cg || '' }));
                // Restore selectedClient so the auto-saved session links to the right client
                // (prevents a duplicate client card being created in the Clients view)
                if (cid) {
                  const matchedClient = clients?.find(c => c.id === cid);
                  if (matchedClient) setSelectedClient(matchedClient);
                }
                setClientDetail(null);
                setPageView('new');
                // Load persisted trade names from backend so party names carry over to the new session
                api.get('/gst-reconciliation/trade-names')
                  .then(r => {
                    const backendNames = r.data?.names || {};
                    if (Object.keys(backendNames).length) {
                      setManualTradeNames(prev => ({ ...prev, ...backendNames }));
                    }
                  })
                  .catch(() => {});
                toast.success(`Starting new session for ${cn || 'this client'}.`);
              }}
            />
          </div>
        )}

        {/* ── History View ── */}
        {pageView === 'history' && !results && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-5">
              <History className="h-5 w-5 text-indigo-500" />
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">Reconciliation History</h2>
              <span className="ml-auto text-[11px] text-slate-400">Click <strong className="text-indigo-500">Open</strong> on any entry to reload the full reconciliation, edit it, and re-generate reports.</span>
            </div>
            <HistoryView clients={clients} onOpenSession={(payload) => {
              // Restore full reconciliation into the active workspace
              setResults(payload.result);
              setActiveTab('matched');
              setPeriod(payload.period || '');
              if (payload.company && Object.keys(payload.company).length) {
                setCompany(prev => ({ ...prev, ...payload.company }));
              } else if (payload.clientName || payload.clientGstin) {
                setCompany(prev => ({ ...prev, name: payload.clientName || prev.name, gstin: payload.clientGstin || prev.gstin }));
              }
              setLoadedSessionId(payload.sessionId || null);
              // Capture an immutable baseline snapshot — used to confirm-save before the first edit
              setBaselineSnapshot({
                result:         JSON.parse(JSON.stringify(payload.result)),
                company:        payload.company || {},
                period:         payload.period || '',
                portalFilename: payload.portalFilename || '',
                booksFilename:  payload.booksFilename  || '',
                sessionId:      payload.sessionId || null,
                clientName:     payload.clientName || '',
                clientGstin:    payload.clientGstin || '',
                openedAt:       new Date().toISOString(),
              });
              setSnapshotSaved(false);
              setPageView('new');
              // Re-fetch latest shared trade names from backend so history view always shows
              // the most current party names (even if another user updated them since this session was saved)
              api.get('/gst-reconciliation/trade-names')
                .then(r => {
                  const backendNames = r.data?.names || {};
                  if (!Object.keys(backendNames).length) return;
                  setManualTradeNames(prev => ({ ...prev, ...backendNames }));
                })
                .catch(() => {});
              toast.success('Reconciliation loaded — fully editable. Your first edit will be confirmed before changes apply.');
            }} />
          </div>
        )}

        {/* ── Upload + Company Details Section ── */}
        {pageView === 'new' && !results && (
          <motion.div initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 mb-5 shadow-sm">

            {/* Client Selector */}
            <div className="mb-5">
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Link to Client
                {clientsLoading && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
              </label>
              <ClientSelector
                clients={clients}
                selectedId={selectedClient?.id}
                onSelect={handleClientSelect}
              />
              {selectedClient && (
                <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-1.5 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Company details auto-filled from client record
                </p>
              )}
            </div>

            {/* Company Details */}
            <div className="mb-6">
              <button onClick={()=>setShowCo(v=>!v)} className="flex items-center gap-2 w-full text-left mb-3">
                <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400"/>
                <span className="font-semibold text-slate-700 dark:text-slate-200">Company Details</span>
                <span className="text-xs text-slate-400 ml-1">(for report header)</span>
                <ChevronRight className={`h-4 w-4 text-slate-400 ml-auto transition-transform ${showCo?'rotate-90':''}`}/>
              </button>
              <AnimatePresence>
                {showCo && (
                  <motion.div initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} className="overflow-hidden">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
                      {[
                        { k:'name',    label:'Company / Trade Name*', icon:Building2,  ph:'e.g. MED 7 PHARMACY' },
                        { k:'gstin',   label:'GSTIN*',                icon:Hash,       ph:'e.g. 24ARQPP3237M1Z9' },
                        { k:'pan',     label:'PAN',                   icon:Hash,       ph:'e.g. ARQPP3237M' },
                        { k:'address', label:'Address',               icon:MapPin,     ph:'Street, Area, City' },
                        { k:'phone',   label:'Phone',                 icon:Phone,      ph:'e.g. +91 98765 43210' },
                        { k:'email',   label:'Email',                 icon:Mail,       ph:'e.g. accounts@company.com' },
                        { k:'fy',      label:'Financial Year',        icon:Calendar,   ph:'e.g. 2025-26' },
                      ].map(f => (
                        <div key={f.k}>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1">
                              {f.label}
                              {f.k === 'gstin' && gstinLookupLoading && (
                                <Loader2 className="h-3 w-3 animate-spin text-indigo-500 ml-1" />
                              )}
                              {f.k === 'gstin' && !gstinLookupLoading && GSTIN_PATTERN.test((company.gstin||'').trim().toUpperCase()) && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 ml-1">
                                  <CheckCircle2 className="h-2.5 w-2.5" /> Listed
                                </span>
                              )}
                            </label>
                            {f.k === 'gstin' && GSTIN_PATTERN.test((company.gstin||'').trim().toUpperCase()) && (
                              <button
                                type="button"
                                onClick={() => triggerCompanyAutofetch()}
                                disabled={gstinLookupLoading}
                                className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 flex items-center gap-0.5 cursor-pointer"
                              >
                                <Sparkles className="h-2.5 w-2.5" />
                                {gstinLookupLoading ? 'Fetching…' : 'Autofetch'}
                              </button>
                            )}
                          </div>
                          <div className="relative">
                            <f.icon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"/>
                            <input
                              value={company[f.k]}
                              onChange={e=>setCo(f.k, e.target.value)}
                              placeholder={f.ph}
                              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Period */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5"/> Tax Period
                {portalFile && period && (
                  <span className="ml-1 text-emerald-600 dark:text-emerald-400 font-medium normal-case text-[10px] lowercase tracking-normal">
                    ✓ auto-detected
                  </span>
                )}
              </label>
              <div className="relative w-full sm:w-56">
                <input value={period} onChange={e=>setPeriod(e.target.value)} placeholder="e.g. March 2026"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
            </div>

            {/* File Upload */}
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Upload className="h-3.5 w-3.5"/> Upload Files
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
              <DropZone label="GSTR-2B (GST Portal)" icon={Globe}   hint="Download GSTR-2B Excel from GST portal (.xlsx/.xls)"        file={portalFile} onFile={handlePortalFile} onClear={()=>{ setPortalFile(null); }} colors={{ done:'bg-blue-50 dark:bg-blue-900/20 border-blue-400', drag:'bg-blue-50 dark:bg-blue-900/10 border-blue-400', iconBg:'bg-blue-100 dark:bg-blue-900/40', iconColor:'text-blue-600 dark:text-blue-300', btn:'bg-blue-600 hover:bg-blue-700 text-white' }}/>
              <div className="flex flex-col gap-1.5">
                <DropZone label="Purchase Register (Books)" icon={BookOpen} hint="GSTR-2 As per Books • B2BInvoices CSV • DayBook • Standard Register (.xlsx/.xls/.csv)" file={booksFile}  onFile={setBooksFile}  onClear={()=>setBooksFile(null)}  colors={{ done:'bg-violet-50 dark:bg-violet-900/20 border-violet-400', drag:'bg-violet-50 dark:bg-violet-900/10 border-violet-400', iconBg:'bg-violet-100 dark:bg-violet-900/40', iconColor:'text-violet-600 dark:text-violet-300', btn:'bg-violet-600 hover:bg-violet-700 text-white' }}/>
                <button
                  onClick={() => generateGSTBooksTemplate(company.name, company.gstin, period)}
                  className="self-end flex items-center gap-1.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 hover:underline transition-colors"
                  title="Download a pre-formatted Excel template to fill GST purchase data and import into Tally"
                >
                  <Download className="h-3.5 w-3.5"/> Download Books Template (Tally-compatible .xlsx)
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
              <AIFileInsights file={portalFile} label="GST Portal Data Insights" />
              <AIFileInsights file={booksFile}  label="Books Data Insights" />
            </div>

            <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800 mb-5 text-xs text-amber-700 dark:text-amber-300">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0"/>
              <span>
                <strong>Portal (GSTR-2B): </strong>GSTR-2B Excel from GST portal (.xlsx/.xls with B2B sheet) — auto-detects period and company.
                <br/>
                <strong className="mt-1 inline-block">Books — supported formats: </strong>
                GSTR-2 As per Books (.xlsx/.xls) • B2BInvoices CSV from GST portal • Tally DayBook export (.xlsx) • Standard Purchase Register with B2B sheet • Marg / Busy / Vyapar exports (.xlsx/.csv).
                <strong className="ml-1">Download the template above</strong> to get a pre-filled Tally-compatible format you can reuse every month.
                Each reconciliation is auto-saved to history.
              </span>
            </div>

            <button onClick={handleReconcile} disabled={!portalFile||!booksFile||loading}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-slate-200 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white disabled:text-slate-400 text-sm font-semibold rounded-xl shadow-sm transition-all">
              {loading ? <><div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/>Processing…</> : <><ArrowLeftRight className="h-4 w-4"/>Reconcile Now</>}
            </button>
          </motion.div>
        )}

        {/* ── Results ── */}
        <AnimatePresence>
          {results && (
            <motion.div initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0}}>

              {/* Company info bar */}
              {company.name && (
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 mb-4 text-xs shadow-sm">
                  <Building2 className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0"/>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{company.name}</span>
                  {company.gstin && <span className="font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">{company.gstin}</span>}
                  {period        && <span className="text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded-full">{period}</span>}
                  {company.fy    && <span className="text-slate-500">FY {company.fy}</span>}
                  <span className="ml-auto flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                    <CheckCircle2 className="h-3 w-3" /> Saved to history
                  </span>
                </div>
              )}

              {/* ── Match Intelligence Dashboard ─────────────────────────────── */}
              {results && (() => {
                const stats = computeMatchStats(results, manualTradeNames);
                const hasDupes = (results.portalDupes?.size || 0) + (results.booksDupes?.size || 0) > 0;
                const matchRateNum = parseFloat(stats.matchPct);
                const matchBarColor = matchRateNum >= 90 ? 'bg-emerald-500' : matchRateNum >= 70 ? 'bg-amber-500' : 'bg-rose-500';
                const matchTextColor = matchRateNum >= 90 ? 'text-emerald-600 dark:text-emerald-400' : matchRateNum >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';

                return (
                  <>
                    {/* Duplicate Warning Banner */}
                    {hasDupes && (
                      <div className="flex items-start gap-3 p-3 mb-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-xl text-sm">
                        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"/>
                        <div>
                          <span className="font-semibold text-amber-700 dark:text-amber-300">Duplicate Invoices Detected!</span>
                          <span className="text-amber-600 dark:text-amber-400 ml-1">
                            {results.portalDupes?.size > 0 && `${results.portalDupes.size} duplicate invoice(s) in Portal data`}
                            {results.portalDupes?.size > 0 && results.booksDupes?.size > 0 && ' · '}
                            {results.booksDupes?.size > 0 && `${results.booksDupes.size} duplicate invoice(s) in Books data`}
                            {' — Duplicates inflate ITC claims and can trigger GST scrutiny. Remove them before filing.'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* High-Severity Alert */}
                    {stats.highSeverity > 0 && (
                      <div className="flex items-center gap-3 p-3 mb-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 rounded-xl text-sm">
                        <AlertTriangle className="h-4 w-4 text-rose-600 flex-shrink-0"/>
                        <span className="text-rose-700 dark:text-rose-300">
                          <span className="font-semibold">{stats.highSeverity} high-severity mismatch{stats.highSeverity > 1 ? 'es' : ''}</span>
                          {' require urgent attention — these directly affect ITC eligibility.'}
                        </span>
                        <button onClick={() => setActiveTab('mismatch')} className="ml-auto text-xs font-semibold text-rose-600 hover:text-rose-800 dark:text-rose-400 underline whitespace-nowrap">View Mismatches →</button>
                      </div>
                    )}

                    {/* Match Rate Row */}
                    <div className="flex items-center gap-4 p-3 mb-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">Invoice Match Rate</span>
                          <span className={`text-sm font-bold ${matchTextColor}`}>{stats.matchPct}%</span>
                        </div>
                        <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div className={`h-full ${matchBarColor} rounded-full transition-all`} style={{ width: `${stats.matchPct}%` }}/>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">{stats.matched?.length || results.matched.length} of {stats.totalPortal} portal invoices matched</p>
                      </div>
                      <div className="border-l border-slate-200 dark:border-slate-700 pl-4 flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">Amount Match Rate</span>
                          <span className={`text-sm font-bold ${parseFloat(stats.amtMatchPct) >= 90 ? 'text-emerald-600 dark:text-emerald-400' : parseFloat(stats.amtMatchPct) >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}`}>{stats.amtMatchPct}%</span>
                        </div>
                        <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div className={`h-full ${parseFloat(stats.amtMatchPct) >= 90 ? 'bg-emerald-500' : parseFloat(stats.amtMatchPct) >= 70 ? 'bg-amber-500' : 'bg-rose-500'} rounded-full transition-all`} style={{ width: `${stats.amtMatchPct}%` }}/>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">By invoice value (weighted)</p>
                      </div>
                    </div>

                    {/* ITC Summary — 4 cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                      <button onClick={() => setItcModal('claimable')}
                        className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-200 dark:border-emerald-800 p-3 text-left hover:shadow-md hover:border-emerald-400 dark:hover:border-emerald-600 transition-all group cursor-pointer">
                        <p className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide flex items-center gap-1">ITC Claimable <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity"/></p>
                        <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300 mt-0.5">₹{fmt(stats.itcClaimable)}</p>
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400">From {results.matched.length} matched invoices</p>
                      </button>
                      <button onClick={() => setItcModal('toBook')}
                        className="bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 p-3 text-left hover:shadow-md hover:border-blue-400 dark:hover:border-blue-600 transition-all group cursor-pointer">
                        <p className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide flex items-center gap-1">ITC to Book <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity"/></p>
                        <p className="text-lg font-bold text-blue-700 dark:text-blue-300 mt-0.5">₹{fmt(stats.itcPending)}</p>
                        <p className="text-[10px] text-blue-600 dark:text-blue-400">From {results.portalOnly.length} portal-only invoices</p>
                      </button>
                      <button onClick={() => setItcModal('atRisk')}
                        className="bg-rose-50 dark:bg-rose-900/20 rounded-xl border border-rose-200 dark:border-rose-800 p-3 text-left hover:shadow-md hover:border-rose-400 dark:hover:border-rose-600 transition-all group cursor-pointer">
                        <p className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 uppercase tracking-wide flex items-center gap-1">ITC at Risk <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity"/></p>
                        <p className="text-lg font-bold text-rose-700 dark:text-rose-300 mt-0.5">₹{fmt(stats.itcAtRisk)}</p>
                        <p className="text-[10px] text-rose-600 dark:text-rose-400">From {results.booksOnly.length} books-only invoices</p>
                      </button>
                      <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800 p-3">
                        <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">ITC in Dispute</p>
                        <p className="text-lg font-bold text-amber-700 dark:text-amber-300 mt-0.5">₹{fmt(stats.itcMismatch)}</p>
                        <p className="text-[10px] text-amber-600 dark:text-amber-400">Tax diff on {results.mismatch.length} mismatch invoices</p>
                      </div>
                    </div>

                    {/* Top Vendors with Issues */}
                    {stats.topVendors.length > 0 && (
                      <div className="mb-3 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
                        <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500"/>
                          Top Vendors Requiring Attention
                        </p>
                        <div className="space-y-1.5">
                          {stats.topVendors.map((v, i) => {
                            const barPct = stats.topVendors[0]?.amt > 0 ? Math.round(v.amt / stats.topVendors[0].amt * 100) : 0;
                            return (
                              <div key={v.gstin} className="flex items-center gap-2 text-xs">
                                <span className="text-slate-400 w-3 text-right">{i+1}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between">
                                    <span className="font-medium text-slate-700 dark:text-slate-300 truncate">{v.name || v.gstin}</span>
                                    <span className="text-slate-500 dark:text-slate-400 ml-2 whitespace-nowrap">{v.count} issue{v.count > 1 ? 's' : ''} · ₹{fmt(v.amt)}</span>
                                  </div>
                                  <div className="h-1 bg-slate-100 dark:bg-slate-700 rounded-full mt-0.5">
                                    <div className="h-full bg-amber-400 rounded-full" style={{ width: `${barPct}%` }}/>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* AI Insights Panel */}
              <div className="mb-5">
                {aiInsightState === 'idle' && (
                  <button
                    onClick={handleAiInsights}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-xl shadow-sm transition-colors"
                  >
                    <Sparkles className="h-4 w-4" />
                    Generate AI Insights for this Reconciliation
                  </button>
                )}
                {aiInsightState === 'loading' && (
                  <div className="flex items-center gap-3 p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800 text-sm text-indigo-600 dark:text-indigo-300">
                    <div className="h-4 w-4 border-2 border-indigo-400 border-t-indigo-600 rounded-full animate-spin" />
                    Grok AI is analysing your reconciliation data…
                  </div>
                )}
                {(aiInsightState === 'done' || aiInsightState === 'error') && (
                  <div className={`rounded-xl border p-4 text-sm ${aiInsightState === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="flex items-center gap-2 font-semibold text-indigo-700 dark:text-indigo-300">
                        <Sparkles className="h-4 w-4" /> AI Reconciliation Insights
                      </span>
                      <button
                        onClick={() => { setAiInsightState('idle'); setAiInsights(''); }}
                        className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline"
                      >
                        Clear
                      </button>
                    </div>
                    <pre className={`whitespace-pre-wrap leading-relaxed font-sans text-xs ${aiInsightState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-300'}`}>
                      {aiInsights}
                    </pre>
                  </div>
                )}
              </div>

              {/* ── Business-Centric Action Centre ── */}
              <div className="mb-4">
                {/* Party & Supplier Autofetch Bar */}
                <div className="flex items-center justify-between flex-wrap gap-2 mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                      Company &amp; Supplier Auto-Enrichment:
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                      <CheckCircle2 className="h-2.5 w-2.5" /> Auto-Fetched From GSTIN
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => autofetchMissingSupplierNames()}
                    disabled={autofetchingSuppliers}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-slate-700 hover:bg-indigo-100 dark:hover:bg-slate-600 text-indigo-700 dark:text-indigo-300 text-xs font-semibold border border-indigo-200 dark:border-slate-600 transition-all cursor-pointer shadow-xs disabled:opacity-50"
                  >
                    {autofetchingSuppliers ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />
                        <span>Autofetching Names {supplierFetchProgress ? `(${supplierFetchProgress.current}/${supplierFetchProgress.total})` : '…'}</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                        <span>Autofetch Missing Supplier Names</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Matched summary row — compact, not clickable */}
                <div className="flex items-center gap-3 px-4 py-2.5 mb-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-xl">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0"/>
                  <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    {results.matched?.length || 0} Matched Invoices
                  </span>
                  <span className="text-sm text-emerald-600 dark:text-emerald-400">
                    — ₹{fmt(sumVal(results.matched,'portal'))} · ITC claimable: ₹{fmt(sumTax(results.matched,'portal'))}
                  </span>
                  <button
                    onClick={() => setActiveTab('matched')}
                    className="ml-auto text-xs font-medium text-emerald-600 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-200 underline underline-offset-2"
                  >
                    View matched →
                  </button>
                </div>

                {/* Action cards — only the 4 categories needing attention */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                  {ACTION_TABS.map(tab => {
                    const count = results[tab.id]?.length || 0;
                    const val = tab.id === 'crossGstin'
                      ? (results[tab.id]||[]).reduce((s,r) => s+(r.portal?.portal?.invoiceValue||0), 0)
                      : (results[tab.id]||[]).reduce((s,r) => s+((tab.id==='booksOnly'?r.books:r.portal)?.invoiceValue||0), 0);
                    const isActive = activeTab === tab.id;
                    const urgencyBorder = tab.urgency==='critical' ? 'border-l-4 border-l-orange-500' : tab.urgency==='high' ? 'border-l-4 border-l-amber-500' : 'border-l-4 border-l-blue-400';
                    return (
                      <motion.button key={tab.id} whileHover={{y:-2}} onClick={()=>setActiveTab(tab.id)}
                        className={`text-left rounded-xl border p-4 transition-all duration-200 w-full ${urgencyBorder} ${isActive ? `${tab.color.activeBg} ${tab.color.activeBorder} shadow-md ring-1 ring-inset ${tab.color.activeBorder}` : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:shadow-md'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <tab.icon className={`h-4 w-4 flex-shrink-0 ${isActive ? tab.color.activeText : 'text-slate-400'}`}/>
                              <p className={`text-xs font-semibold truncate ${isActive ? tab.color.activeText : 'text-slate-600 dark:text-slate-300'}`}>{tab.label}</p>
                              {tab.urgency === 'critical' && count > 0 && <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 flex-shrink-0">CRITICAL</span>}
                              {tab.urgency === 'high'     && count > 0 && <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 flex-shrink-0">ACTION</span>}
                            </div>
                            <p className={`text-2xl font-bold leading-none mb-1 ${count === 0 ? 'text-slate-300 dark:text-slate-600' : isActive ? tab.color.activeText : 'text-slate-800 dark:text-slate-100'}`}>{count}</p>
                            <p className={`text-xs ${count === 0 ? 'text-slate-300 dark:text-slate-600' : isActive ? tab.color.activeText : 'text-slate-400'}`}>₹{fmt(val)}</p>
                          </div>
                        </div>
                        <p className={`text-[10px] mt-2 leading-snug ${count === 0 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-500 dark:text-slate-400'}`}>{count === 0 ? '✓ All clear' : tab.action}</p>
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              {/* ── GST Verification Panel ── */}
              {gstVerifyDone && Object.keys(gstStatusMap).length > 0 && (() => {
                const entries = Object.values(gstStatusMap);
                const active    = entries.filter(e => (e.status || '').toLowerCase() === 'active');
                const cancelled = entries.filter(e => /cancel|suspend|surrender|inactive/i.test(e.status || ''));
                const unknown   = entries.filter(e => e.status === 'Lookup failed');
                const invalid   = entries.filter(e => e.status === 'Invalid GSTIN');
                const riskCount = cancelled.length + invalid.length;

                return (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden"
                  >
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-teal-50 to-emerald-50 dark:from-teal-900/20 dark:to-emerald-900/20">
                      <ShieldCheck className="h-4 w-4 text-teal-600 dark:text-teal-400 flex-shrink-0"/>
                      <span className="text-sm font-semibold text-teal-700 dark:text-teal-300">GST Registration Status</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">— {entries.length} unique GSTINs verified from government portal</span>
                      {riskCount > 0 && (
                        <span className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                          <AlertTriangle className="h-3 w-3"/>{riskCount} AT RISK
                        </span>
                      )}
                    </div>

                    {/* Summary pills */}
                    <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2">
                      {active.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5"/>{active.length} Active
                        </span>
                      )}
                      {cancelled.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                          <AlertTriangle className="h-3.5 w-3.5"/>{cancelled.length} Cancelled / Suspended
                        </span>
                      )}
                      {unknown.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                          <Info className="h-3.5 w-3.5"/>{unknown.length} Lookup failed
                        </span>
                      )}
                      {invalid.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                          <X className="h-3.5 w-3.5"/>{invalid.length} Invalid GSTIN
                        </span>
                      )}
                    </div>

                    {/* Table */}
                    <div className="overflow-x-auto px-4 pb-4">
                      <table className="w-full text-xs border-separate border-spacing-0">
                        <thead>
                          <tr className="text-left">
                            <th className="py-2 pr-3 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">GSTIN</th>
                            <th className="py-2 pr-3 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">Business Name</th>
                            <th className="py-2 pr-3 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">Status</th>
                            <th className="py-2 pr-3 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">State</th>
                            <th className="py-2 pr-3 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">Type</th>
                            <th className="py-2 font-semibold text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">Reg. Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((e, idx) => {
                            const isActive    = (e.status || '').toLowerCase() === 'active';
                            const isRisk      = /cancel|suspend|surrender|inactive/i.test(e.status || '');
                            const isLookupFail = e.status === 'Lookup failed';
                            const displayName = e.tradeName || e.legalName || manualTradeNames[e.gstin] || '—';
                            const rowBg = isRisk
                              ? 'bg-red-50/50 dark:bg-red-900/10'
                              : idx % 2 === 0 ? '' : 'bg-slate-50/50 dark:bg-slate-800/30';
                            return (
                              <tr key={e.gstin} className={rowBg}>
                                <td className="py-2 pr-3 font-mono text-slate-700 dark:text-slate-200 whitespace-nowrap">{e.gstin}</td>
                                <td className="py-2 pr-3 text-slate-700 dark:text-slate-200 max-w-[180px] truncate" title={displayName}>{displayName}</td>
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  {isActive ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0"/>Active
                                    </span>
                                  ) : isRisk ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0"/>{e.status}
                                    </span>
                                  ) : isLookupFail ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0"/>Lookup failed
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                                      {e.status || '—'}
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 pr-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{e.state || '—'}</td>
                                <td className="py-2 pr-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{e.registrationType || e.entityType || '—'}</td>
                                <td className="py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">{e.registrationDate || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                );
              })()}

              {/* ── Detail Panel ── */}
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                {/* Slim header: active tab name + Search + Compare */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                  {/* Active tab label */}
                  {activeTab && (() => {
                    const all = [...ACTION_TABS, { id:'matched', label:'Matched Invoices', icon:CheckCircle2, color:{ activeBg:'', activeBorder:'', activeText:'text-emerald-600 dark:text-emerald-400', badge:'' }, desc:'Invoices present in both GSTR-2B and Books with matching amounts. No action required.' }, { id:'search', label:'Search', icon:ScanSearch, color:{ activeBg:'', activeBorder:'', activeText:'text-purple-600 dark:text-purple-400', badge:'' }, desc:'Search across all invoices.' }];
                    const t = all.find(x => x.id === activeTab);
                    return t ? (
                      <span className={`flex items-center gap-1.5 text-sm font-semibold ${t.color.activeText}`}>
                        <t.icon className="h-4 w-4"/>
                        {t.label}
                        <span className="text-slate-400 font-normal text-xs ml-1">— {t.desc}</span>
                      </span>
                    ) : null;
                  })()}
                  <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                    <button onClick={()=>setActiveTab('search')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${activeTab==='search' ? 'bg-purple-600 text-white border-purple-600' : 'text-slate-500 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}`}>
                      <ScanSearch className="h-3.5 w-3.5"/> Search All
                    </button>
                    <button
                      onClick={verifyAllGSTINs}
                      disabled={verifyingGST}
                      title="Check GST registration status for all vendors from the government portal"
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-sm ${gstVerifyDone ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-teal-600 hover:bg-teal-700'} text-white disabled:opacity-60`}
                    >
                      {verifyingGST
                        ? <><div className="h-3 w-3 border-2 border-white/40 border-t-white rounded-full animate-spin flex-shrink-0"/>Verifying…</>
                        : gstVerifyDone
                        ? <><ShieldCheck className="h-3.5 w-3.5 flex-shrink-0"/>GST Verified</>
                        : <><ShieldCheck className="h-3.5 w-3.5 flex-shrink-0"/>Verify GST Status</>
                      }
                    </button>
                    <button onClick={() => setShowCompare(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors shadow-sm">
                      <ArrowLeftRight className="h-3.5 w-3.5"/> Compare P vs B
                    </button>
                    <button
                      onClick={handleReReconcile}
                      disabled={loading}
                      title={portalFile && booksFile ? 'Re-run reconciliation on the same uploaded files' : 'Re-upload files to use this'}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white transition-colors shadow-sm"
                    >
                      {loading
                        ? <><div className="h-3 w-3 border-2 border-white/40 border-t-white rounded-full animate-spin flex-shrink-0"/>Re-checking…</>
                        : <><RefreshCw className="h-3.5 w-3.5 flex-shrink-0"/>Reco Again</>
                      }
                    </button>
                  </div>
                </div>
                <div className="p-4">
                  {activeTab === 'search'
                    ? <GlobalSearchTab key="search" results={results}/>
                    : activeTab === 'crossGstin'
                    ? <CrossGstinTable
                        key="crossGstin"
                        records={activeRecords}
                        manualTradeNames={manualTradeNames}
                        onSaveTradeName={onSaveTradeName}
                        comments={invoiceComments}
                        onSaveComment={onSaveComment}
                        onConfirmMatch={handleConfirmMatch}
                        onRowClick={record => setInvoiceDetail({ record, tabId: 'crossGstin' })}
                      />
                    : <ResultTable
                        key={activeTab}
                        tabId={activeTab}
                        records={activeRecords}
                        onMarkMatched={['mismatch','portalOnly','booksOnly'].includes(activeTab) ? (r) => handleMarkMatched(r, activeTab) : undefined}
                        manualTradeNames={manualTradeNames}
                        onSaveTradeName={onSaveTradeName}
                        comments={invoiceComments}
                        onSaveComment={onSaveComment}
                        onRowClick={record => setInvoiceDetail({ record, tabId: activeTab })}
                      />
                  }
                </div>
              </div>

              {/* Export reminder */}
              <div className="mt-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300">Download Report:</span>
                <button onClick={()=>exportPDF(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium rounded-lg transition-colors">
                  <FileText className="h-3.5 w-3.5"/> PDF
                </button>
                <button onClick={()=>exportWord(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
                  <FileText className="h-3.5 w-3.5"/> Word (.doc)
                </button>
                <button onClick={()=>exportExcel(results, company, period, manualTradeNames, invoiceComments)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-colors">
                  <FileSpreadsheet className="h-3.5 w-3.5"/> Excel
                </button>
                <button onClick={() => { handleReset(); setPageView('history'); }} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-xs transition-colors border border-indigo-200 dark:border-indigo-800 rounded-lg font-medium">
                  <History className="h-3.5 w-3.5" /> View History
                </button>
                {baselineSnapshot && (
                  <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${snapshotSaved
                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                    : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'}`}
                    title={snapshotSaved ? 'Original baseline already saved as a separate session.' : 'Your first edit will prompt to save a baseline snapshot before applying changes.'}>
                    {snapshotSaved
                      ? <><CheckCircle2 className="h-3.5 w-3.5" /> Baseline snapshot saved</>
                      : <><AlertTriangle className="h-3.5 w-3.5" /> Editing opened session — snapshot pending</>}
                  </span>
                )}
                <button onClick={handleReset} className="flex items-center gap-1.5 px-3 py-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-xs transition-colors">
                  <RefreshCw className="h-3.5 w-3.5"/> New Reconciliation
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* ── Side-by-Side Compare Modal ── */}
      <AnimatePresence>
        {showCompare && results && (
          <SideBySideCompare
            portalOnly={results.portalOnly || []}
            booksOnly={results.booksOnly   || []}
            onConfirmMatch={handleConfirmMatch}
            onClose={() => setShowCompare(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Invoice Detail Modal ── */}
      <AnimatePresence>
        {invoiceDetail && (
          <InvoiceDetailModal
            record={invoiceDetail.record}
            tabId={invoiceDetail.tabId}
            manualTradeNames={manualTradeNames}
            comments={invoiceComments}
            onClose={() => setInvoiceDetail(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Date Format Log Modal ── */}
      <AnimatePresence>
        {showDateLog && (
          <motion.div
            initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            className="fixed inset-0 z-[100] bg-emerald-900/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowDateLog(false)}
          >
            <motion.div
              initial={{ scale:0.95, y:20 }} animate={{ scale:1, y:0 }} exit={{ scale:0.95, y:20 }}
              className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-700"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-amber-500 to-orange-500 text-white">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-5 w-5"/>
                  <div>
                    <h3 className="text-base font-semibold">Date Format Verification Log</h3>
                    <p className="text-xs opacity-90">Shows every distinct invoice-date value in the uploaded files, the format detected, and the normalised ISO date used for matching.</p>
                  </div>
                </div>
                <button onClick={() => setShowDateLog(false)} className="p-1 rounded-lg hover:bg-white/20 transition-colors"><X className="h-5 w-5"/></button>
              </div>
              <div className="px-5 py-3 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/40 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap gap-4">
                <span><b>{dateLog.length}</b> distinct date values</span>
                <span><b>{dateLog.filter(d=>d.source==='Portal').length}</b> from Portal</span>
                <span><b>{dateLog.filter(d=>d.source==='Books').length}</b> from Books</span>
                <span><b>{new Set(dateLog.map(d=>d.format)).size}</b> formats detected</span>
                <span className="text-amber-700 dark:text-amber-300">Two dates match if any plausible interpretation yields the same ISO date.</span>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Source</th>
                      <th className="px-3 py-2 text-left font-semibold">Raw value</th>
                      <th className="px-3 py-2 text-left font-semibold">Detected format</th>
                      <th className="px-3 py-2 text-left font-semibold">Normalised (ISO)</th>
                      <th className="px-3 py-2 text-right font-semibold">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dateLog.length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">No date values recorded. Run a reconciliation first.</td></tr>
                    )}
                    {dateLog.map((d, i) => {
                      const isISO = /^\d{4}-\d{2}-\d{2}$/.test(d.iso);
                      const isAmbiguous = /ambiguous/i.test(d.format);
                      const isUnknown   = /Unrecognised|empty/i.test(d.format);
                      return (
                        <tr key={i} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                          <td className="px-3 py-1.5">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${d.source==='Portal' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>{d.source}</span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-slate-800 dark:text-slate-100">{d.raw}</td>
                          <td className={`px-3 py-1.5 ${isUnknown ? 'text-rose-600 dark:text-rose-400' : isAmbiguous ? 'text-amber-700 dark:text-amber-300' : 'text-slate-700 dark:text-slate-300'}`}>{d.format}</td>
                          <td className={`px-3 py-1.5 font-mono ${isISO ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500'}`}>{d.iso || '—'}</td>
                          <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">{d.count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-between items-center">
                <span className="text-[11px] text-slate-500">Tip: rows in red were not recognised — check the source file and add a custom format if needed.</span>
                <button
                  onClick={() => {
                    const csv = ['Source,Raw,Detected Format,Normalised ISO,Rows', ...dateLog.map(d => `"${d.source}","${d.raw.replace(/"/g,'""')}","${d.format}","${d.iso}",${d.count}`)].join('\n');
                    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
                    saveAs(blob, 'date-format-log.csv');
                  }}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-800 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
                >
                  <Download className="h-3.5 w-3.5"/> Export CSV
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── ITC Detail Modal ── */}
      <AnimatePresence>
        {itcModal && results && (
          <ITCDetailModal
            type={itcModal}
            results={results}
            onClose={() => setItcModal(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Baseline Snapshot Confirmation Modal ── */}
      <AnimatePresence>
        {snapshotPrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          >
            <div className="absolute inset-0 bg-emerald-900/60 backdrop-blur-sm" onClick={() => !snapshotSaving && setSnapshotPrompt(null)}/>
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="flex items-start gap-3 px-5 py-4 bg-gradient-to-r from-amber-500 to-orange-500">
                <div className="p-2 rounded-lg bg-white/20 flex-shrink-0">
                  <AlertTriangle className="h-5 w-5 text-white"/>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Save baseline snapshot before editing?</h3>
                  <p className="text-[11px] text-white/85 mt-0.5">We'll save the original (unedited) reconciliation as a separate history entry first, so your edits never overwrite it.</p>
                </div>
              </div>
              <div className="px-5 py-4 text-sm text-slate-600 dark:text-slate-300 space-y-2">
                <p>This is a one-time prompt for this opened session. After confirming, all subsequent edits apply immediately.</p>
                <ul className="text-[12px] text-slate-500 dark:text-slate-400 list-disc pl-5 space-y-0.5">
                  <li>Original session: <strong>{baselineSnapshot?.clientName || baselineSnapshot?.portalFilename || 'Opened reconciliation'}</strong></li>
                  <li>Snapshot will be tagged <code className="px-1 bg-slate-100 dark:bg-slate-700 rounded text-[11px]">[snapshot]</code> in history.</li>
                </ul>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 py-3 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-200 dark:border-slate-700">
                <button
                  disabled={snapshotSaving}
                  onClick={() => setSnapshotPrompt(null)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={snapshotSaving}
                  onClick={async () => {
                    const ok = await saveBaselineSnapshot();
                    if (ok) {
                      const fn = snapshotPrompt?.pendingEdit;
                      setSnapshotPrompt(null);
                      if (typeof fn === 'function') fn();
                    }
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-60"
                >
                  {snapshotSaving
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/> Saving...</>
                    : <><CheckCircle2 className="h-3.5 w-3.5"/> Save & continue</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
