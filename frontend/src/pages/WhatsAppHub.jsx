/**
 * WhatsAppHub.jsx — Full WhatsApp Web replica with multi-number support
 *
 * Design: pixel-perfect WhatsApp Web clone
 * Features:
 *   ★ Left sidebar: avatar, new-chat, filter, menu icons; chat list with
 *     WhatsApp-style unread badges; filter chips (All / Unread / Groups)
 *   ★ Right panel: chat background pattern, bubbles with tails, date
 *     separators, message status ticks, reply context, context menu
 *   ★ Input bar: emoji picker, paperclip → Photos/Videos/Document/Camera,
 *     send/mic toggle
 *   ★ Manage Numbers: QR & phone pairing; multi-account colour dots
 *   ★ LID JID resolution (bridge resolves @lid → real phone before send)
 */

import React, {
  useState, useEffect, useCallback, useRef, useMemo, useReducer,
} from 'react';
import {
  Search, X, Check, CheckCheck, Loader2, RefreshCw, MoreVertical,
  Phone, Video, Smile, Paperclip, Mic, Send, Image, FileText,
  Camera, Users, MessageCircle, Plus, ArrowLeft, Trash2,
  Settings, QrCode, Hash, Copy, ChevronDown, ChevronRight,
  AlertCircle, Wifi, WifiOff, Smartphone, Filter, Star, Reply,
  Volume2, File, Archive, ArchiveRestore, Info, UserPlus, Crown,
  StarOff, SearchX, ArrowRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { FixedSizeList as VList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import api, { BASE_URL, getToken } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext.jsx';

// ── Socket.IO lazy import for real-time updates ───────────────────────────────
let _io = null;
async function getSocketIO() {
  if (_io) return _io;
  try {
    _io = (await import('socket.io-client')).default;
    return _io;
  } catch {
    console.warn('socket.io-client not installed — real-time updates disabled. Install with: npm install socket.io-client');
    return null;
  }
}

// ── WhatsApp exact colour palette ─────────────────────────────────────────────
const WA = {
  green:         '#00a884',
  greenDark:     '#008069',
  greenLight:    '#25D366',
  teal:          '#128C7E',
  // Light mode
  sideBg:        '#ffffff',
  sideHeader:    '#f0f2f5',
  sideActive:    '#f0f2f5',
  chatBg:        '#efeae2',
  bubbleOut:     '#d9fdd3',
  bubbleIn:      '#ffffff',
  inputBg:       '#ffffff',
  // Dark mode
  dSideBg:       '#111b21',
  dSideHeader:   '#202c33',
  dSideActive:   '#2a3942',
  dChatBg:       '#0b141a',
  dBubbleOut:    '#005c4b',
  dBubbleIn:     '#202c33',
  dInputBg:      '#2a3942',
};

const SESSION_COLORS = [
  '#00a884','#3b82f6','#8b5cf6','#f59e0b',
  '#ef4444','#06b6d4','#ec4899','#84cc16',
];
const sc = i => SESSION_COLORS[i % SESSION_COLORS.length];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtChatTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? ts.endsWith('Z') ? ts : ts + 'Z' : ts), n = new Date();
  if (isNaN(d)) return '';
  const diff = Math.floor((n - d) / 86400000);
  if (diff === 0) return d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return d.toLocaleDateString('en-IN', { weekday:'long' });
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? ts.endsWith('Z') ? ts : ts + 'Z' : ts);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
}
function fmtDateSep(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? ts.endsWith('Z') ? ts : ts + 'Z' : ts), n = new Date();
  if (isNaN(d)) return 'Unknown date';
  const diff = Math.floor((n - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
}

function isSameDay(a, b) {
  const da = new Date(typeof a==='string' ? (a.endsWith('Z')?a:a+'Z') : a);
  const db = new Date(typeof b==='string' ? (b.endsWith('Z')?b:b+'Z') : b);
  if (isNaN(da)||isNaN(db)) return false;
  return da.getFullYear()===db.getFullYear() && da.getMonth()===db.getMonth() && da.getDate()===db.getDate();
}

function isGroup(jid) { return (jid||'').endsWith('@g.us'); }

function formatPhone(num) {
  // num is digits only e.g. "919898622841"
  if (!num) return '';
  // Indian numbers: 91 + 10 digits
  const m = num.match(/^(91)(\d{5})(\d{5})$/);
  if (m) return `+${m[1]} ${m[2]} ${m[3]}`;
  // Generic: just add + prefix, space every 5 digits for readability
  return `+${num.replace(/(\d{5})(?=\d)/g, '$1 ')}`;
}

function displayJid(jid) {
  if (!jid) return '';
  if (jid.endsWith('@lid'))            return '';          // LID = internal privacy ID, not a real number
  if (jid.endsWith('@s.whatsapp.net')) return formatPhone(jid.split('@')[0]);
  if (jid.endsWith('@g.us'))           return jid.split('@')[0];
  return jid;
}

function getDisplayName(contact) {
  if (!contact) return '';
  // Priority order — mirrors how WhatsApp Web resolves names:
  // 1. name       — contact name saved in the phone's address book (synced by Baileys contacts.update)
  // 2. display_name — stored name in backend (usually same as name or notify)
  // 3. notify     — the name the contact set for themselves (pushName)
  // 4. push_name  — alternate field name used by some bridge versions
  // 5. label      — user-set label in the hub
  // 6. phone      — formatted phone number fallback
  // 7. JID        — raw JID fallback
  const pick = [contact.name, contact.display_name, contact.notify, contact.push_name, contact.label]
    .find(v => v && typeof v === 'string' && v.trim() && !v.includes('@'));
  if (pick) return pick.trim();
  if (contact.phone) return formatPhone(String(contact.phone));
  const fromJid = displayJid(contact.jid);
  if (fromJid) return fromJid;
  if ((contact.jid||'').endsWith('@lid')) return 'WhatsApp User';
  return contact.jid || '';
}

function participantsLabel(count) {
  if (!count) return '';
  return `${count} participant${count !== 1 ? 's' : ''}`;
}

function initials(name) {
  if (!name) return '?';
  if (/^\+?\d{5,}/.test(name.trim())) return name.trim().slice(-2);
  return name.split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
}

const AVATAR_COLORS = [
  '#1877f2','#e94235','#0f9d58','#f4b400',
  '#7b1fa2','#00838f','#c62828','#2e7d32',
];
function avatarColor(jid) {
  let h = 0;
  for (const c of (jid||'')) h = (h*31+c.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

const picCache = {};

// ── Avatar — shows colored initials only (no profile-pic API calls) ────────────
// Profile-pic fetching is disabled to prevent flooding the backend with hundreds
// of concurrent requests on page load, which caused 503 errors for all other
// endpoints including the inbox. Re-enable once the bridge is stable.
function Avatar({ jid, name, size=49, isGrp=false, url=null, style:extra={} }) {
  const bg = avatarColor(jid);
  const r  = isGrp ? '38%' : '50%';

  return (
    <div style={{ width:size, height:size, borderRadius:r, overflow:'hidden',
      flexShrink:0, background:bg,
      display:'flex', alignItems:'center', justifyContent:'center',
      color:'#fff', fontWeight:700, fontSize:Math.round(size*0.36),
      cursor:'pointer', userSelect:'none', ...extra }}>
      {isGrp
        ? <Users size={Math.round(size*0.44)} color='#fff'/>
        : initials(name)
      }
    </div>
  );
}

// ── Status Ticks ──────────────────────────────────────────────────────────────
function Ticks({ direction, read }) {
  if (direction !== 'out') return null;
  return read
    ? <CheckCheck size={14} color='#53bdeb' style={{ flexShrink:0 }}/>
    : <Check size={14} color='rgba(255,255,255,0.7)' style={{ flexShrink:0 }}/>;
}

// ── Emoji picker (basic) ──────────────────────────────────────────────────────
const EMOJI_ROWS = [
  ['😀','😂','🤣','😊','😍','🥰','😘','😎','😭','😢','😩','🥺','😤','😡','🤔','🫠'],
  ['👍','👎','❤️','🔥','🎉','🎊','✅','❌','⚡','💯','🙏','👏','🤝','💪','✌️','🖐️'],
  ['😅','🤦','🙄','😏','🫡','🤗','😴','🤤','🥳','🥴','😮','😱','🫢','🤯','🤡','👻'],
  ['🌹','🌺','🌸','🌼','🌻','🍀','🌈','⭐','🌙','☀️','❄️','🌊','🔑','🎵','🎶','🏆'],
];
function EmojiPicker({ onPick, isDark }) {
  const bg = isDark ? '#233138' : '#fff';
  const brd = isDark ? '#3b4a54' : '#e9edef';
  return (
    <motion.div initial={{opacity:0,y:8,scale:0.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:8,scale:0.96}}
      transition={{duration:0.15}}
      style={{ position:'absolute', bottom:'calc(100% + 8px)', left:0, background:bg, border:`1px solid ${brd}`,
        borderRadius:12, padding:12, zIndex:200, boxShadow:'0 4px 24px rgba(0,0,0,0.18)', width:272 }}>
      {EMOJI_ROWS.map((row,ri) => (
        <div key={ri} style={{ display:'flex', flexWrap:'wrap', gap:2, marginBottom:ri<EMOJI_ROWS.length-1?4:0 }}>
          {row.map(em => (
            <button key={em} onClick={()=>onPick(em)}
              style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, padding:'3px', borderRadius:6,
                lineHeight:1, transition:'background 0.1s' }}
              onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              {em}
            </button>
          ))}
        </div>
      ))}
    </motion.div>
  );
}

// ── Attachment menu ───────────────────────────────────────────────────────────
function AttachMenu({ onPickFile, onClose, isDark }) {
  const bg  = isDark ? '#233138' : '#ffffff';
  const brd = isDark ? '#3b4a54' : '#e9edef';
  const items = [
    { label:'Photos & Videos', icon:Image,    color:'#bf59cf', accept:'image/*,video/*' },
    { label:'Documents',       icon:FileText, color:'#0063cb', accept:'.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip' },
    { label:'Camera',          icon:Camera,   color:'#04a784', accept:'image/*',         capture:true },
  ];
  return (
    <motion.div initial={{opacity:0,y:10,scale:0.95}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:10,scale:0.95}}
      transition={{duration:0.15}}
      style={{ position:'absolute', bottom:'calc(100% + 12px)', left:-8, background:bg, border:`1px solid ${brd}`,
        borderRadius:16, padding:8, zIndex:200, boxShadow:'0 8px 32px rgba(0,0,0,0.22)', minWidth:220 }}>
      {items.map(it => (
        <label key={it.label}
          style={{ display:'flex', alignItems:'center', gap:14, padding:'10px 14px',
            cursor:'pointer', borderRadius:10, transition:'background 0.12s' }}
          onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.04)'}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
          <div style={{ width:46, height:46, borderRadius:'50%', background:it.color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <it.icon size={22} color='#fff'/>
          </div>
          <span style={{ fontSize:14, fontWeight:500, color:isDark?'#e9edef':'#111b21' }}>{it.label}</span>
          <input type='file' accept={it.accept} capture={it.capture?'environment':undefined} style={{ display:'none' }}
            onChange={e=>{ if(e.target.files[0]){ onPickFile(e.target.files[0]); onClose(); } e.target.value=''; }}/>
        </label>
      ))}
    </motion.div>
  );
}

// ── Attachment preview (before send) ─────────────────────────────────────────
function AttachPreview({ att, caption, onCaptionChange, onRemove, isDark }) {
  const bg  = isDark ? '#0b141a' : '#f0f2f5';
  const brd = isDark ? '#3b4a54' : '#e9edef';
  const txt = isDark ? '#e9edef' : '#111b21';
  const isImg = att.mimeType.startsWith('image/');
  const isVid = att.mimeType.startsWith('video/');
  return (
    <div style={{ background:bg, borderRadius:12, overflow:'hidden', margin:'0 0 8px', border:`1px solid ${brd}`, position:'relative' }}>
      <button onClick={onRemove} style={{ position:'absolute', top:8, right:8, width:26, height:26, borderRadius:'50%',
        background:'rgba(0,0,0,0.5)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', zIndex:1 }}>
        <X size={13}/>
      </button>
      <div style={{ display:'flex', gap:12, padding:12, alignItems:'flex-start' }}>
        {/* Thumb */}
        <div style={{ width:68, height:68, borderRadius:8, background:isDark?'#233138':'#e9edef', flexShrink:0, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
          {isImg && att.preview
            ? <img src={att.preview} alt='' style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
            : isVid ? <Camera size={28} color={isDark?'#8696a0':'#667781'}/> : <FileText size={28} color={isDark?'#8696a0':'#667781'}/>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:'0 0 2px', fontSize:13, fontWeight:600, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{att.filename}</p>
          <p style={{ margin:'0 0 10px', fontSize:11, color:isDark?'#8696a0':'#667781' }}>{att.mimeType.split('/')[1]?.toUpperCase()} · {fmtFileSize(att.size)}</p>
          <input value={caption} onChange={e=>onCaptionChange(e.target.value)}
            placeholder='Add a caption…'
            style={{ width:'100%', padding:'7px 10px', border:`1px solid ${brd}`, borderRadius:8, fontSize:13, outline:'none',
              background:isDark?'#233138':'#fff', color:txt, boxSizing:'border-box' }}/>
        </div>
      </div>
    </div>
  );
}

// ── Date separator ────────────────────────────────────────────────────────────
function DateSep({ ts, isDark }) {
  return (
    <div style={{ display:'flex', justifyContent:'center', margin:'12px 0 6px' }}>
      <span style={{ background:isDark?'#182229':'rgba(11,20,26,0.6)', color:isDark?'#e9edef':'#54656f',
        fontSize:12, fontWeight:500, padding:'4px 10px', borderRadius:8,
        boxShadow:'0 1px 2px rgba(11,20,26,0.08)', backdropFilter:'blur(4px)' }}>
        {fmtDateSep(ts)}
      </span>
    </div>
  );
}

// ── Media Lightbox (full-screen image/video viewer) ───────────────────────────
function MediaLightbox({ url, type, filename, onClose }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
      style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(6,78,59,0.92)',
        display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column' }}
      onClick={onClose}>
      <button onClick={onClose} style={{ position:'absolute', top:16, right:20, background:'none', border:'none',
        color:'#fff', cursor:'pointer', zIndex:10000, opacity:0.8, fontSize:28, lineHeight:1 }}>✕</button>
      {filename && (
        <div style={{ position:'absolute', top:16, left:20, color:'rgba(255,255,255,0.7)', fontSize:13 }}>{filename}</div>
      )}
      <div onClick={e=>e.stopPropagation()} style={{ maxWidth:'90vw', maxHeight:'90vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
        {type === 'image' ? (
          <img src={url} alt={filename||'media'} style={{ maxWidth:'90vw', maxHeight:'88vh', objectFit:'contain', borderRadius:4, boxShadow:'0 8px 40px rgba(0,0,0,0.5)' }}/>
        ) : type === 'video' ? (
          <video src={url} controls autoPlay style={{ maxWidth:'90vw', maxHeight:'88vh', borderRadius:4, boxShadow:'0 8px 40px rgba(0,0,0,0.5)' }}/>
        ) : null}
      </div>
      <a href={url} download={filename||'file'} target='_blank' rel='noreferrer'
        onClick={e=>e.stopPropagation()}
        style={{ marginTop:16, color:'rgba(255,255,255,0.6)', fontSize:12, textDecoration:'none',
          display:'flex', alignItems:'center', gap:6, padding:'6px 14px', border:'1px solid rgba(255,255,255,0.2)',
          borderRadius:20, cursor:'pointer' }}>
        ⬇ Download
      </a>
    </motion.div>
  );
}

// ── Media Renderer (inside bubble) ───────────────────────────────────────────
function MediaRenderer({ msg, isDark }) {
  const [lightbox, setLightbox] = useState(false);
  const [imgError, setImgError] = useState(false);
  const url      = msg.media_url;
  const type     = msg.media_type;
  const filename = msg.filename;
  const txt      = isDark ? '#e9edef' : '#111b21';
  const sub      = isDark ? '#8696a0' : '#667781';
  const docBg    = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';

  if (type === 'image') {
    if (imgError) {
      return (
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6, padding:'8px 12px', background:docBg, borderRadius:8 }}>
          <Image size={18} color={sub}/><span style={{ fontSize:12, color:sub, fontStyle:'italic' }}>Photo (could not load)</span>
          <a href={url} target='_blank' rel='noreferrer' style={{ marginLeft:'auto', color:WA.green, fontSize:12, textDecoration:'none' }}>Open ↗</a>
        </div>
      );
    }
    return (
      <>
        <div style={{ marginBottom:4, cursor:'pointer', borderRadius:8, overflow:'hidden', maxWidth:300 }} onClick={()=>setLightbox(true)}>
          <img src={url} alt={filename||'photo'} onError={()=>setImgError(true)}
            style={{ width:'100%', maxWidth:300, maxHeight:220, objectFit:'cover', display:'block', borderRadius:8 }}/>
        </div>
        <AnimatePresence>
          {lightbox && <MediaLightbox url={url} type='image' filename={filename} onClose={()=>setLightbox(false)}/>}
        </AnimatePresence>
      </>
    );
  }

  if (type === 'video') {
    return (
      <>
        <div style={{ marginBottom:4, position:'relative', borderRadius:8, overflow:'hidden', maxWidth:300, cursor:'pointer' }}
          onClick={()=>setLightbox(true)}>
          <video src={url} style={{ width:'100%', maxWidth:300, maxHeight:200, objectFit:'cover', display:'block', borderRadius:8, pointerEvents:'none' }}/>
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(0,0,0,0.3)', borderRadius:8 }}>
            <div style={{ width:48, height:48, borderRadius:'50%', background:'rgba(255,255,255,0.85)',
              display:'flex', alignItems:'center', justifyContent:'center' }}>
              <span style={{ fontSize:20, marginLeft:3 }}>▶</span>
            </div>
          </div>
        </div>
        {filename && <div style={{ fontSize:11, color:sub, marginBottom:4 }}>{filename}</div>}
        <AnimatePresence>
          {lightbox && <MediaLightbox url={url} type='video' filename={filename} onClose={()=>setLightbox(false)}/>}
        </AnimatePresence>
      </>
    );
  }

  if (type === 'audio' || type === 'ptt') {
    return (
      <div style={{ marginBottom:4, display:'flex', alignItems:'center', gap:10,
        background:docBg, borderRadius:24, padding:'8px 14px', maxWidth:280 }}>
        <Volume2 size={18} color={WA.green} style={{ flexShrink:0 }}/>
        <audio src={url} controls style={{ flex:1, height:32, minWidth:0, maxWidth:'100%', outline:'none' }}/>
      </div>
    );
  }

  if (type === 'sticker') {
    return (
      <div style={{ marginBottom:4 }}>
        {url
          ? <img src={url} alt='Sticker' style={{ width:120, height:120, objectFit:'contain', display:'block' }}/>
          : <div style={{ width:120, height:120, background:docBg, borderRadius:8, display:'flex', alignItems:'center',
              justifyContent:'center', fontSize:32 }}>🏷️</div>
        }
      </div>
    );
  }

  if (type === 'location') {
    const lat = msg.latitude || msg.location?.lat;
    const lng = msg.longitude || msg.location?.lng;
    const label = msg.location_name || msg.location?.name || 'Location';
    const mapsUrl = lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : null;
    return (
      <a href={mapsUrl || '#'} target='_blank' rel='noreferrer'
        style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4, padding:'10px 14px',
          background:docBg, borderRadius:10, textDecoration:'none', maxWidth:280,
          border:`1px solid ${isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.08)'}` }}>
        <div style={{ width:40, height:40, background:'#ef4444', borderRadius:10, display:'flex',
          alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:20 }}>📍</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</div>
          {lat && lng && <div style={{ fontSize:11, color:sub, marginTop:2 }}>{Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}</div>}
          <div style={{ fontSize:11, color:WA.green, marginTop:2 }}>Open in Maps ↗</div>
        </div>
      </a>
    );
  }

  if (type === 'vcard' || type === 'contact') {
    const vcard = msg.body || '';
    const nameMatch = vcard.match(/FN[;:]([^\r\n]+)/i);
    const phoneMatch = vcard.match(/TEL[;A-Za-z=:]*:([^\r\n]+)/i);
    const cName = nameMatch ? nameMatch[1].trim() : 'Contact';
    const cPhone = phoneMatch ? phoneMatch[1].trim() : '';
    return (
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4, padding:'10px 14px',
        background:docBg, borderRadius:10, maxWidth:280,
        border:`1px solid ${isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.08)'}` }}>
        <div style={{ width:44, height:44, borderRadius:'50%', background:avatarColor(cName),
          display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
          color:'#fff', fontWeight:700, fontSize:16 }}>
          {initials(cName)}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:txt }}>{cName}</div>
          {cPhone && <div style={{ fontSize:11, color:sub, marginTop:2 }}>{cPhone}</div>}
        </div>
        <UserPlus size={16} color={WA.green} style={{ flexShrink:0 }}/>
      </div>
    );
  }

  if (type === 'document') {
    const ext = filename ? filename.split('.').pop()?.toUpperCase() : 'FILE';
    return (
      <a href={url} download={filename||'document'} target='_blank' rel='noreferrer'
        style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4, padding:'10px 14px',
          background:docBg, borderRadius:10, textDecoration:'none', maxWidth:280,
          border:`1px solid ${isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.08)'}` }}>
        <div style={{ width:36, height:44, background:'#ef4444', borderRadius:5, display:'flex', alignItems:'center',
          justifyContent:'center', flexShrink:0, fontSize:9, fontWeight:800, color:'#fff', letterSpacing:'0.03em' }}>
          {ext?.slice(0,4)}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{filename||'Document'}</div>
          <div style={{ fontSize:11, color:sub, marginTop:2 }}>{fmtFileSize(msg.file_size)} · {ext}</div>
        </div>
        <FileText size={16} color={sub} style={{ flexShrink:0 }}/>
      </a>
    );
  }

  // Fallback for unknown media types with a URL
  return (
    <a href={url} target='_blank' rel='noreferrer'
      style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, padding:'8px 12px',
        background:docBg, borderRadius:8, textDecoration:'none', color:WA.green, fontSize:13 }}>
      <File size={16}/>{filename || 'Open media ↗'}
    </a>
  );
}

// ── Quick emoji reactions ─────────────────────────────────────────────────────
const QUICK_EMOJIS = ['❤️','👍','😂','😮','😢','🙏'];

// ── Forward Modal ─────────────────────────────────────────────────────────────
function ForwardModal({ msg, contacts, connectedSessions, isDark, onClose }) {
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedJid, setSelectedJid] = useState(null);
  const brd  = isDark ? '#3b4a54' : '#e9edef';
  const bg   = isDark ? '#111b21' : '#fff';
  const txt  = isDark ? '#e9edef' : '#111b21';
  const muted= isDark ? '#8696a0' : '#667781';

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return contacts.filter(c => {
      const name = getDisplayName(c).toLowerCase();
      return name.includes(q) || (c.phone||'').includes(q);
    }).slice(0, 50);
  }, [contacts, search]);

  async function doForward() {
    if (!selectedJid) return;
    setSending(true);
    try {
      const sess = connectedSessions[0]?.sessionId;
      const body = msg.body || (msg.media_type ? `[${msg.media_type}]` : '');
      await api.post('/whatsapp/hub/send', { jid: selectedJid, message: body, session_id: sess });
      toast.success('Message forwarded!');
      onClose();
    } catch { toast.error('Failed to forward message'); }
    finally { setSending(false); }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(6,78,59,0.5)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:bg, borderRadius:12, width:360, maxHeight:'80vh', display:'flex',
        flexDirection:'column', overflow:'hidden', boxShadow:'0 8px 32px rgba(0,0,0,0.3)' }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ padding:'16px 16px 12px', borderBottom:`1px solid ${brd}`, display:'flex', alignItems:'center', gap:10 }}>
          <ArrowRight size={18} color={WA.green}/>
          <span style={{ fontWeight:700, fontSize:15, color:txt }}>Forward message</span>
          <button onClick={onClose} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:muted }}><X size={18}/></button>
        </div>
        <div style={{ padding:'8px 12px', borderBottom:`1px solid ${brd}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, background:isDark?'#202c33':'#f0f2f5',
            borderRadius:8, padding:'6px 12px' }}>
            <Search size={15} color={muted}/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder='Search contacts…'
              style={{ flex:1, background:'none', border:'none', outline:'none', fontSize:14, color:txt }}/>
          </div>
        </div>
        <div style={{ flex:1, overflowY:'auto' }}>
          {filtered.map(c => (
            <div key={c.jid} onClick={()=>setSelectedJid(c.jid===selectedJid?null:c.jid)}
              style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', cursor:'pointer',
                background:selectedJid===c.jid?(isDark?'rgba(0,168,132,0.15)':'rgba(0,168,132,0.08)'):'transparent' }}>
              <div style={{ width:40, height:40, borderRadius:'50%', background:avatarColor(c.jid),
                display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:700, fontSize:14, flexShrink:0 }}>
                {initials(getDisplayName(c))}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:500, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{getDisplayName(c)}</div>
              </div>
              {selectedJid===c.jid && <div style={{ width:18, height:18, borderRadius:'50%', background:WA.green,
                display:'flex', alignItems:'center', justifyContent:'center' }}><Check size={11} color='#fff'/></div>}
            </div>
          ))}
          {filtered.length===0 && <p style={{ textAlign:'center', color:muted, fontSize:13, padding:20 }}>No contacts found</p>}
        </div>
        <div style={{ padding:'12px 16px', borderTop:`1px solid ${brd}` }}>
          <button onClick={doForward} disabled={!selectedJid||sending}
            style={{ width:'100%', background:selectedJid?WA.green:'#ccc', color:'#fff', border:'none',
              borderRadius:10, padding:'11px', fontSize:14, fontWeight:700, cursor:selectedJid?'pointer':'default',
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            {sending ? <><Loader2 size={14} style={{animation:'waSpinKf 1s linear infinite'}}/> Forwarding…</> : <><ArrowRight size={14}/> Forward</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────
function Bubble({ msg, prev, next, isDark, sessionColorMap, isGrp, multiSession, contactNameByPhone, onReply, onStar, onDelete, onReact, onForward }) {
  const [menu, setMenu] = useState(false);
  const [showReactBar, setShowReactBar] = useState(false);
  const menuRef = useRef(null);
  const isOut   = msg.direction === 'out';
  const isMedia = msg.media_type && msg.media_type !== 'text';
  const numCol  = sessionColorMap[msg.session_id] || WA.green;
  const bg      = isOut ? (isDark ? WA.dBubbleOut : WA.bubbleOut) : (isDark ? WA.dBubbleIn : WA.bubbleIn);
  const txtCol  = isDark ? '#e9edef' : '#111b21';
  const senderCol = avatarColor(msg.sender_phone || msg.session_id || '');

  // Tail shape (SVG)
  const tailColor = bg;
  const tailOut = (
    <svg width='8' height='13' viewBox='0 0 8 13' style={{ position:'absolute', bottom:0, right:-7 }}>
      <path d='M0 13L8 13L8 0C8 0 0 8 0 13Z' fill={tailColor}/>
    </svg>
  );
  const tailIn = (
    <svg width='8' height='13' viewBox='0 0 8 13' style={{ position:'absolute', bottom:0, left:-7 }}>
      <path d='M8 13L0 13L0 0C0 0 8 8 8 13Z' fill={tailColor}/>
    </svg>
  );

  const showTail = !next || next.direction !== msg.direction;

  useEffect(() => {
    if (!menu) return;
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:isOut?'flex-end':'flex-start',
      marginBottom: showTail ? 6 : 2, paddingLeft:isOut?'20%':'0', paddingRight:isOut?'0':'20%' }}>
      <div style={{ position:'relative', maxWidth:'100%' }}>
        {/* Bubble */}
        <div
          onMouseEnter={()=>{ setMenu(true); setShowReactBar(true); }}
          onMouseLeave={()=>{ setMenu(false); setShowReactBar(false); }}
          style={{ position:'relative', background:bg, padding:'6px 9px 8px 9px', borderRadius:8,
            boxShadow:'0 1px 2px rgba(11,20,26,0.12)', cursor:'default' }}>
          {/* Tail */}
          {showTail && (isOut ? tailOut : tailIn)}

          {/* Quick emoji reaction bar (floats above bubble on hover) */}
          <AnimatePresence>
            {showReactBar && (
              <motion.div initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} exit={{opacity:0,y:4}}
                transition={{duration:0.12}}
                style={{ position:'absolute', top:-38, [isOut?'right':'left']:0, zIndex:60,
                  background:isDark?'#233138':'#fff', borderRadius:20, boxShadow:'0 2px 12px rgba(0,0,0,0.22)',
                  border:`1px solid ${isDark?'#3b4a54':'#e9edef'}`,
                  display:'flex', alignItems:'center', padding:'4px 6px', gap:2 }}>
                {QUICK_EMOJIS.map(em => (
                  <button key={em} onClick={()=>{ onReact && onReact(msg, em); setShowReactBar(false); }}
                    style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', padding:'2px 4px',
                      borderRadius:10, lineHeight:1 }}
                    onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.07)'}
                    onMouseLeave={e=>e.currentTarget.style.background='none'}
                    title={em}>
                    {em}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Sender label — GROUP chats only: resolves to the participant's
              saved contact name when known (same as WhatsApp Web), falling
              back to their phone number when the contact isn't saved.
              NOTE: this must never render for 1:1 chats — WhatsApp Web never
              shows a name above messages in a DM, since there's only one
              possible sender. Previously this branch was unreachable because
              `isGrp` was never passed down from the caller, so EVERY incoming
              DM fell through to the block below and showed the *connected
              account's own* session label instead of the contact's name. */}
          {!isOut && isGrp && msg.sender_phone && (
            <p style={{ margin:'0 0 2px', fontSize:12.5, fontWeight:700, color:senderCol }}>
              {contactNameByPhone?.[msg.sender_phone] || `+${msg.sender_phone}`}
            </p>
          )}
          {/* Multi-account disambiguation — only meaningful (and only shown)
              when more than one WhatsApp number is connected to the hub, and
              styled as a small dot rather than bold text so it can never be
              mistaken for the contact's name. */}
          {!isOut && !isGrp && multiSession && msg.session_label && (
            <p style={{ margin:'0 0 3px', display:'flex', alignItems:'center', gap:4, fontSize:10,
              fontWeight:500, color:numCol, opacity:0.8 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:numCol, flexShrink:0 }}/>
              Received on {msg.session_label}
            </p>
          )}

          {/* ── Full media rendering ── */}
          {isMedia && msg.media_url && (
            <MediaRenderer msg={msg} isDark={isDark} />
          )}
          {/* Fallback icon row when no media_url yet (downloading/pending) */}
          {isMedia && !msg.media_url && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, color:isDark?'#8696a0':'#667781',
              background:isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.05)', borderRadius:8, padding:'8px 12px' }}>
              {msg.media_type==='image'    && <Image size={18}/>}
              {msg.media_type==='video'    && <Camera size={18}/>}
              {msg.media_type==='audio'    && <Volume2 size={18}/>}
              {msg.media_type==='document' && <FileText size={18}/>}
              <span style={{ fontSize:12, color:isDark?'#8696a0':'#667781', fontStyle:'italic' }}>
                {msg.filename || (msg.media_type==='image'?'Photo':msg.media_type==='video'?'Video':msg.media_type==='audio'?'Voice message':'Document')}
              </span>
              <Loader2 size={13} style={{ animation:'waSpinKf 1s linear infinite', marginLeft:'auto' }}/>
            </div>
          )}

          {/* Text */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:6, flexWrap:'wrap', wordBreak:'break-word' }}>
            <p style={{ margin:0, fontSize:14, lineHeight:1.55, color:txtCol, whiteSpace:'pre-wrap', flex:1 }}>{msg.body}</p>
            {/* Time + ticks */}
            <span style={{ display:'flex', alignItems:'center', gap:3, fontSize:11,
              color:isOut?(isDark?'rgba(233,237,239,0.6)':'rgba(0,92,75,0.65)'):(isDark?'#8696a0':'#667781'),
              flexShrink:0, alignSelf:'flex-end', whiteSpace:'nowrap' }}>
              {msg.starred && <Star size={12} fill={isOut?'rgba(0,92,75,0.65)':WA.green} color={isOut?'rgba(0,92,75,0.65)':WA.green} style={{ marginRight:1 }}/>}
              {fmtMsgTime(msg.timestamp)}
              {isOut && (msg.read
                ? <CheckCheck size={14} color='#53bdeb'/>
                : <Check size={14} color={isDark?'rgba(233,237,239,0.6)':'rgba(0,92,75,0.65)'}/>)}
            </span>
          </div>

          {/* Reactions display */}
          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:4 }}>
              {Object.entries(msg.reactions).map(([em, count]) => (
                <button key={em} onClick={()=>onReact && onReact(msg, em)}
                  style={{ display:'flex', alignItems:'center', gap:3, background:isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.07)',
                    border:`1px solid ${isDark?'rgba(255,255,255,0.15)':'rgba(0,0,0,0.12)'}`,
                    borderRadius:12, padding:'2px 7px', cursor:'pointer', fontSize:12 }}>
                  <span style={{ fontSize:14 }}>{em}</span>
                  {count > 1 && <span style={{ color:isDark?'#e9edef':'#111b21', fontWeight:600 }}>{count}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Context menu on hover */}
          <AnimatePresence>
            {menu && (
              <motion.div ref={menuRef} initial={{opacity:0,scale:0.92}} animate={{opacity:1,scale:1}} exit={{opacity:0,scale:0.92}}
                transition={{duration:0.1}}
                style={{ position:'absolute', top:0, right:isOut?0:'auto', left:isOut?'auto':0, zIndex:50,
                  background:isDark?'#233138':'#fff', borderRadius:8, boxShadow:'0 4px 16px rgba(0,0,0,0.24)',
                  border:`1px solid ${isDark?'#3b4a54':'#e9edef'}`, overflow:'hidden', minWidth:150 }}>
                {[
                  { label:'Reply',   icon:Reply,   fn:()=>{ onReply(msg);   setMenu(false); } },
                  { label:'Copy',    icon:Copy,     fn:()=>{ navigator.clipboard.writeText(msg.body||''); toast.success('Copied!'); setMenu(false); } },
                  { label:'Forward', icon:ArrowRight, fn:()=>{ onForward && onForward(msg); setMenu(false); } },
                  { label: msg.starred ? 'Unstar' : 'Star', icon: msg.starred ? StarOff : Star, fn:()=>{ onStar(msg); setMenu(false); } },
                  { label:'Delete',  icon:Trash2,  fn:()=>{ onDelete(msg);  setMenu(false); }, danger:true },
                ].map(item => (
                  <button key={item.label} onClick={item.fn}
                    style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 14px',
                      background:'none', border:'none', cursor:'pointer', fontSize:13, fontWeight:500,
                      color:item.danger?'#ef4444':(isDark?'#e9edef':'#111b21'), textAlign:'left' }}
                    onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.04)'}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <item.icon size={14}/>{item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ── Chat list item ────────────────────────────────────────────────────────────
function ChatItem({ contact, active, onClick, onArchiveToggle, sessionColorMap, contactNameByPhone, sessions, isDark }) {
  const [hover, setHover] = useState(false);
  const name    = getDisplayName(contact);
  const preview = contact.latest_message?.body || '';
  const isOut   = contact.latest_message?.direction === 'out';
  const isGrp   = isGroup(contact.jid) || contact.is_group;
  const numCol  = sessionColorMap[contact.session_id] || WA.green;
  const bg      = active ? (isDark ? WA.dSideActive : WA.sideActive) : 'transparent';
  const txt     = isDark ? '#e9edef' : '#111b21';
  const muted   = isDark ? '#8696a0' : '#667781';
  return (
    <div
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      style={{ position:'relative', width:'100%', display:'flex', alignItems:'center', background:bg,
        borderBottom:`1px solid ${isDark?'rgba(233,237,239,0.1)':'rgba(0,0,0,0.05)'}`, transition:'background 0.1s' }}
      onMouseOver={e=>{ if(!active) e.currentTarget.style.background=isDark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.03)'; }}
      onMouseOut={e=>{ if(!active) e.currentTarget.style.background=bg; }}>
      <button onClick={onClick} style={{ flex:1, display:'flex', alignItems:'center', gap:0, padding:'0', textAlign:'left', background:'none', border:'none', cursor:'pointer', minWidth:0 }}>
        {/* Active indicator */}
        <div style={{ width:3, alignSelf:'stretch', background:active?WA.green:'transparent', flexShrink:0, borderRadius:'0 2px 2px 0' }}/>
        <div style={{ flex:1, minWidth:0, display:'flex', alignItems:'center', gap:12, padding:'12px 14px 12px 12px' }}>
          <div style={{ position:'relative', flexShrink:0 }}>
            <Avatar jid={contact.jid} name={name} size={49} isGrp={isGrp} url={contact.profile_pic_url}/>
            {/* Session colour ring */}
            <div style={{ position:'absolute', bottom:1, right:1, width:13, height:13, borderRadius:'50%',
              background:numCol, border:`2px solid ${isDark?WA.dSideBg:WA.sideBg}` }}/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:4 }}>
              <span style={{ fontWeight:500, fontSize:16, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                {isGrp && <span style={{ fontSize:10, background:'rgba(0,168,132,0.18)', color:WA.green, borderRadius:3, padding:'1px 5px', marginRight:6, fontWeight:700 }}>GROUP</span>}
                {name}
              </span>
              <span style={{ fontSize:12, color:contact.unread_count>0?WA.green:muted, flexShrink:0, fontWeight:contact.unread_count>0?600:400 }}>
                {fmtChatTime(contact.last_message_at)}
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:4, marginTop:3 }}>
              <p style={{ fontSize:14, color:muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', margin:0, flex:1, display:'flex', alignItems:'center', gap:4 }}>
                {isOut && <CheckCheck size={14} color={muted} style={{ flexShrink:0 }}/>}
                {isGrp && contact.latest_message?.sender_phone && !isOut && (
                  <span style={{ flexShrink:0 }}>{contactNameByPhone?.[contact.latest_message.sender_phone] || `+${contact.latest_message.sender_phone}`}:</span>
                )}
                {preview || <span style={{ fontStyle:'italic' }}>No messages yet</span>}
              </p>
              {contact.unread_count > 0 && (
                <span style={{ background:WA.green, color:'#fff', fontSize:12, fontWeight:700, minWidth:20, height:20, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', padding:'0 5px', flexShrink:0 }}>
                  {contact.unread_count>99?'99+':contact.unread_count}
                </span>
              )}
            </div>
            {/* ── Contact number + Source number (Unified Inbox) ──────────────── */}
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
              {contact.phone && (
                <span style={{ fontSize:10, color:muted, opacity:0.8 }}>
                  {displayJid(contact.jid)}
                </span>
              )}
              {contact.session_id && sessions?.length > 0 && (
                <span style={{ fontSize:10, color:muted, opacity:0.6, display:'flex', alignItems:'center', gap:3 }}>
                  <span style={{ width:5, height:5, borderRadius:'50%', background:numCol, flexShrink:0 }}/>
                  via {sessions.find(s => s.sessionId === contact.session_id)?.label || formatPhone(contact.session_id)}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
      {/* Hover-revealed archive toggle */}
      {hover && onArchiveToggle && (
        <button
          onClick={(e)=>{ e.stopPropagation(); onArchiveToggle(contact); }}
          title={contact.archived ? 'Unarchive' : 'Archive'}
          style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)',
            width:32, height:32, borderRadius:'50%', border:'none', cursor:'pointer',
            background:isDark?'#2a3942':'#fff', color:muted, display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 1px 4px rgba(0,0,0,0.18)' }}>
          {contact.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}
        </button>
      )}
    </div>
  );
}

// ── QR Modal ──────────────────────────────────────────────────────────────────
function QRModal({ sessionId, label, onClose, isDark }) {
  const [qr,     setQr]     = useState(null);
  const [status, setStatus] = useState('loading');
  const timer = useRef(null);
  const card = isDark?'#233138':'#fff', muted = isDark?'#8696a0':'#667781';

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get(`/whatsapp/sessions/${sessionId}/qr`);
      if (data.status==='connected') { setStatus('connected'); clearTimeout(timer.current); setTimeout(onClose,1200); return; }
      if (data.qr)  { setQr(data.qr); setStatus('ready'); }
      else          { setStatus(data.status||'waiting'); }
      timer.current = setTimeout(poll, 7000);
    } catch { setStatus('error'); }
  }, [sessionId, onClose]);

  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, [poll]);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(6,78,59,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(4px)' }} onClick={onClose}>
      <motion.div initial={{scale:0.9,opacity:0}} animate={{scale:1,opacity:1}} onClick={e=>e.stopPropagation()}
        style={{ background:card, borderRadius:20, padding:28, maxWidth:350, width:'90%', boxShadow:'0 24px 80px rgba(0,0,0,0.35)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:18 }}>
          <div>
            <div style={{ fontWeight:700, fontSize:16, color:isDark?'#e9edef':'#111b21' }}>Scan QR Code</div>
            <div style={{ fontSize:12, color:muted, marginTop:2 }}>{label}</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:muted }}><X size={18}/></button>
        </div>
        <div style={{ background:isDark?'#111b21':'#f0f2f5', borderRadius:14, padding:20, minHeight:240, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10 }}>
          {status==='connected' && <motion.div initial={{scale:0}} animate={{scale:1}} style={{textAlign:'center'}}><CheckCheck size={52} color='#22c55e'/><p style={{color:'#22c55e',fontWeight:700,marginTop:8}}>Connected!</p></motion.div>}
          {status==='ready' && qr && <motion.img key={qr} initial={{opacity:0}} animate={{opacity:1}} src={qr} alt='QR' style={{width:210,height:210,borderRadius:8}}/>}
          {['loading','waiting','connecting'].includes(status) && <div style={{textAlign:'center'}}><motion.div animate={{rotate:360}} transition={{repeat:Infinity,duration:1,ease:'linear'}}><RefreshCw size={34} color={WA.green}/></motion.div><p style={{color:muted,fontSize:13,marginTop:10}}>Waiting for QR…</p></div>}
          {status==='error' && <div style={{textAlign:'center'}}><AlertCircle size={34} color='#ef4444'/><p style={{color:'#ef4444',fontSize:13,marginTop:8}}>Failed to load QR</p><button onClick={poll} style={{marginTop:6,background:WA.green,color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',cursor:'pointer',fontSize:12}}>Retry</button></div>}
        </div>
        <p style={{textAlign:'center',fontSize:12,color:muted,marginTop:12,lineHeight:1.7}}>Open WhatsApp → Linked Devices → Link a Device → Scan this code</p>
      </motion.div>
    </div>
  );
}

// ── Pair-Code Modal ───────────────────────────────────────────────────────────
function PairModal({ sessionId, label, onClose, isDark }) {
  const [code,   setCode]   = useState(null);
  const [status, setStatus] = useState('loading');
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const card = isDark?'#233138':'#fff', muted = isDark?'#8696a0':'#667781';

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get(`/whatsapp/sessions/${sessionId}/pair-code`);
      if (data.status==='connected') { setStatus('connected'); clearTimeout(timer.current); setTimeout(onClose,1200); return; }
      if (data.code) { setCode(data.code); setStatus('ready'); }
      else           { setStatus(data.status||'waiting'); }
      timer.current = setTimeout(poll, 7000);
    } catch { setStatus('error'); }
  }, [sessionId, onClose]);

  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, [poll]);

  const fmt = code ? `${code.slice(0,4)}-${code.slice(4)}` : null;
  const copy = () => { if(code){ navigator.clipboard.writeText(code); setCopied(true); setTimeout(()=>setCopied(false),2000); } };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(6,78,59,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(4px)' }} onClick={onClose}>
      <motion.div initial={{scale:0.9,opacity:0}} animate={{scale:1,opacity:1}} onClick={e=>e.stopPropagation()}
        style={{ background:card, borderRadius:20, padding:28, maxWidth:380, width:'90%', boxShadow:'0 24px 80px rgba(0,0,0,0.35)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:18 }}>
          <div><div style={{ fontWeight:700, fontSize:16, color:isDark?'#e9edef':'#111b21' }}>Phone Pairing Code</div><div style={{ fontSize:12, color:muted, marginTop:2 }}>{label}</div></div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:muted }}><X size={18}/></button>
        </div>
        <div style={{ background:isDark?'#111b21':'#f0f2f5', borderRadius:14, padding:24, minHeight:180, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12 }}>
          {status==='connected' && <motion.div initial={{scale:0}} animate={{scale:1}} style={{textAlign:'center'}}><CheckCheck size={52} color='#22c55e'/><p style={{color:'#22c55e',fontWeight:700,marginTop:8}}>Connected!</p></motion.div>}
          {status==='ready' && fmt && (
            <motion.div initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={{textAlign:'center',width:'100%'}}>
              <div style={{ fontSize:40, fontWeight:900, letterSpacing:'0.14em', color:isDark?'#e9edef':'#111b21', fontFamily:'monospace', marginBottom:16 }}>{fmt}</div>
              <button onClick={copy} style={{ display:'inline-flex', alignItems:'center', gap:8, background:copied?'#22c55e22':WA.green, color:copied?'#22c55e':'#fff', border:copied?'1.5px solid #22c55e':'none', borderRadius:10, padding:'9px 20px', cursor:'pointer', fontSize:13, fontWeight:700 }}>
                {copied ? <><Check size={13}/> Copied!</> : <><Copy size={13}/> Copy Code</>}
              </button>
            </motion.div>
          )}
          {['loading','waiting','awaiting_pairing'].includes(status) && <div style={{textAlign:'center'}}><motion.div animate={{rotate:360}} transition={{repeat:Infinity,duration:1,ease:'linear'}}><RefreshCw size={34} color={WA.green}/></motion.div><p style={{color:muted,fontSize:13,marginTop:10}}>Generating code…</p></div>}
          {status==='error' && <div style={{textAlign:'center'}}><AlertCircle size={34} color='#ef4444'/><button onClick={poll} style={{marginTop:8,background:WA.green,color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',cursor:'pointer',fontSize:12}}>Retry</button></div>}
        </div>
        {status==='ready' && <div style={{marginTop:14,fontSize:12,color:muted,lineHeight:1.8}}>
          <strong style={{color:isDark?'#e9edef':'#111b21'}}>Steps: </strong>Open WhatsApp → Linked Devices → Link a Device → "Link with phone number" → enter your number → enter this code
        </div>}
      </motion.div>
    </div>
  );
}

// ── Manage Numbers Modal ──────────────────────────────────────────────────────
function ManageModal({ isDark, sessions, onClose, onRefresh }) {
  const [mode,    setMode]    = useState('list');   // 'list' | 'add'
  const [authTab, setAuthTab] = useState('qr');
  const [label,   setLabel]   = useState('');
  const [phone,   setPhone]   = useState('');
  const [adding,  setAdding]  = useState(false);
  const [delId,   setDelId]   = useState(null);
  const [qrSess,  setQrSess]  = useState(null);
  const [pairSess,setPairSess]= useState(null);

  const bg   = isDark ? '#111b21' : '#fff';
  const card = isDark ? '#233138' : '#f0f2f5';
  const brd  = isDark ? '#3b4a54' : '#e9edef';
  const txt  = isDark ? '#e9edef' : '#111b21';
  const muted= isDark ? '#8696a0' : '#667781';
  const inp  = { width:'100%', border:`1px solid ${brd}`, borderRadius:10, padding:'10px 12px', fontSize:14, outline:'none', background:isDark?'#182229':'#fff', color:txt, boxSizing:'border-box' };

  const handleAdd = async () => {
    if (!label.trim()) { toast.error('Enter a label'); return; }
    if (authTab==='phone' && !phone.trim()) { toast.error('Enter phone with country code'); return; }
    setAdding(true);
    try {
      const payload = { label: label.trim() };
      if (authTab==='phone') payload.pairing_phone = phone.replace(/\D/g,'');
      const { data } = await api.post('/whatsapp/sessions', payload);
      toast.success('Session started!');
      setLabel(''); setPhone('');
      if (authTab==='phone') setPairSess({ sessionId:data.sessionId, label:label.trim() });
      else                   setQrSess({ sessionId:data.sessionId, label:label.trim() });
    } catch(e) {
      const s = e?.response?.status;
      if(s===429) toast.error('Rate-limited — wait 30s and try again');
      else toast.error(e?.response?.data?.detail || 'Failed to start session');
    } finally { setAdding(false); }
  };

  const handleDel = async (sid) => {
    if (!window.confirm('Disconnect and remove this number?')) return;
    setDelId(sid);
    try { await api.delete(`/whatsapp/sessions/${sid}`); onRefresh(); toast.success('Removed'); }
    catch { toast.error('Failed to remove'); } finally { setDelId(null); }
  };

  return (
    <>
      {qrSess   && <QRModal   sessionId={qrSess.sessionId}   label={qrSess.label}   isDark={isDark} onClose={()=>{ setQrSess(null);   onRefresh(); }}/>}
      {pairSess && <PairModal sessionId={pairSess.sessionId} label={pairSess.label} isDark={isDark} onClose={()=>{ setPairSess(null); onRefresh(); }}/>}
      <div style={{ position:'fixed', inset:0, background:'rgba(6,78,59,0.55)', zIndex:1500, display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(3px)' }} onClick={onClose}>
        <motion.div initial={{scale:0.93,opacity:0}} animate={{scale:1,opacity:1}} onClick={e=>e.stopPropagation()}
          style={{ background:bg, borderRadius:20, width:480, maxWidth:'95vw', maxHeight:'90vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.4)' }}>
          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'18px 20px', borderBottom:`1px solid ${brd}`, flexShrink:0, background:`linear-gradient(135deg,${WA.teal},${WA.green})` }}>
            <div style={{ width:40, height:40, borderRadius:10, background:'rgba(255,255,255,0.2)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Smartphone size={20} color='#fff'/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:16, color:'#fff' }}>Connected Numbers</div>
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', marginTop:1 }}>{sessions.filter(s=>s.status==='connected').length} of {sessions.length} active</div>
            </div>
            <button onClick={onClose} style={{ background:'rgba(255,255,255,0.2)', border:'none', cursor:'pointer', borderRadius:8, width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff' }}><X size={16}/></button>
          </div>

          <div style={{ overflowY:'auto', flex:1, padding:20 }}>
            {/* Sessions list */}
            {sessions.length > 0 && (
              <div style={{ background:card, borderRadius:14, overflow:'hidden', marginBottom:16 }}>
                {sessions.map((s,i) => (
                  <div key={s.sessionId} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:i<sessions.length-1?`1px solid ${brd}`:'none' }}>
                    <div style={{ width:42, height:42, borderRadius:'50%', background:s.status==='connected'?'#dcfce7':(isDark?'#182229':'#f0f2f5'), display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {s.status==='connected' ? <Wifi size={18} color='#22c55e'/> : <WifiOff size={18} color={muted}/>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:14, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.label||s.sessionId}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                        <span style={{ fontSize:11, fontWeight:700, padding:'2px 8px', borderRadius:20,
                          background:s.status==='connected'?'#dcfce7':(isDark?'#182229':'#f3f4f6'),
                          color:s.status==='connected'?'#16a34a':muted }}>{s.status}</span>
                        {s.phoneNumber && <span style={{ fontSize:11, color:muted }}>+{s.phoneNumber}</span>}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6 }}>
                      {s.status!=='connected' && (
                        <>
                          <button onClick={()=>setQrSess({sessionId:s.sessionId,label:s.label||s.sessionId})}
                            style={{ padding:'4px 10px', background:WA.green, color:'#fff', border:'none', borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                            <QrCode size={11}/> QR
                          </button>
                          <button onClick={()=>setPairSess({sessionId:s.sessionId,label:s.label||s.sessionId})}
                            style={{ padding:'4px 10px', background:'transparent', color:muted, border:`1px solid ${brd}`, borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                            <Hash size={11}/> Code
                          </button>
                        </>
                      )}
                      <button onClick={()=>handleDel(s.sessionId)} disabled={delId===s.sessionId}
                        style={{ width:30, height:30, borderRadius:8, background:'none', border:'none', cursor:'pointer', color:'#ef4444', display:'flex', alignItems:'center', justifyContent:'center', opacity:delId===s.sessionId?0.4:1 }}>
                        {delId===s.sessionId ? <Loader2 size={14} style={{animation:'waSpinKf 1s linear infinite'}}/> : <Trash2 size={14}/>}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add new number */}
            <div style={{ background:card, borderRadius:14, padding:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
                <Plus size={15} color={WA.green}/>
                <span style={{ fontSize:14, fontWeight:700, color:txt }}>Add a WhatsApp Number</span>
              </div>
              {/* Auth mode tabs */}
              <div style={{ display:'flex', gap:4, background:isDark?'#182229':'#e9edef', padding:4, borderRadius:10, marginBottom:14, width:'fit-content' }}>
                {[{id:'qr',label:'QR Code',icon:QrCode},{id:'phone',label:'Phone Pairing',icon:Phone}].map(t => (
                  <button key={t.id} onClick={()=>setAuthTab(t.id)}
                    style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                      background:authTab===t.id?WA.green:'transparent', color:authTab===t.id?'#fff':muted }}>
                    <t.icon size={12}/>{t.label}
                  </button>
                ))}
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <input style={inp} placeholder='Label — e.g. "Business", "Personal", "GST Office"' value={label} onChange={e=>setLabel(e.target.value)}/>
                {authTab==='phone' && (
                  <div>
                    <input style={inp} type='tel' placeholder='Phone with country code e.g. 919876543210' value={phone} onChange={e=>setPhone(e.target.value)}/>
                    <p style={{ fontSize:11, color:muted, marginTop:4 }}>No + or spaces. Example: 91 (India) + 10-digit number</p>
                  </div>
                )}
                <button onClick={handleAdd} disabled={adding}
                  style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, background:adding?muted:WA.green, color:'#fff', border:'none', borderRadius:10, padding:'11px 20px', fontSize:14, fontWeight:700, cursor:adding?'not-allowed':'pointer' }}>
                  {adding ? <><Loader2 size={14} style={{animation:'waSpinKf 1s linear infinite'}}/> Starting…</>
                    : authTab==='phone' ? <><Hash size={14}/> Get Pairing Code</> : <><QrCode size={14}/> Get QR Code</>}
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </>
  );
}

// ── Contact / Group Info side panel ──────────────────────────────────────────
function InfoPanel({ jid, contact, sessionLabel, isAdmin, onClose, onArchiveToggle, isDark }) {
  const isGrp = isGroup(jid);
  const [groupMeta, setGroupMeta] = useState(null);
  const [loadingMeta, setLoadingMeta] = useState(false);

  useEffect(() => {
    if (!isGrp) return;
    setLoadingMeta(true);
    api.get(`/whatsapp/hub/groups/${encodeURIComponent(jid)}/participants`)
      .then(({data}) => setGroupMeta(data))
      .catch(() => setGroupMeta(null))
      .finally(() => setLoadingMeta(false));
  }, [jid, isGrp]);

  const bg    = isDark ? WA.dSideBg : WA.sideBg;
  const hdr   = isDark ? WA.dSideHeader : WA.sideHeader;
  const txt   = isDark ? '#e9edef' : '#111b21';
  const muted = isDark ? '#8696a0' : '#667781';
  const brd   = isDark ? 'rgba(233,237,239,0.12)' : 'rgba(0,0,0,0.08)';
  const card  = isDark ? '#202c33' : '#f7f8fa';

  const name = getDisplayName(contact) || displayJid(jid);

  return (
    <motion.div initial={{x:40,opacity:0}} animate={{x:0,opacity:1}} exit={{x:40,opacity:0}} transition={{duration:0.18}}
      style={{ width:380, minWidth:320, display:'flex', flexDirection:'column', background:bg, borderLeft:`1px solid ${brd}`, flexShrink:0 }}>
      {/* Header */}
      <div style={{ background:hdr, padding:'18px 16px', display:'flex', alignItems:'center', gap:16, flexShrink:0 }}>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:txt, display:'flex' }}><X size={20}/></button>
        <span style={{ fontSize:16, fontWeight:600, color:txt }}>{isGrp ? 'Group info' : 'Contact info'}</span>
      </div>

      <div style={{ flex:1, overflowY:'auto' }}>
        {/* Avatar + name */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'28px 20px', background:bg }}>
          <Avatar jid={jid} name={name} size={140} isGrp={isGrp} url={contact?.profile_pic_url}/>
          <h3 style={{ margin:'18px 0 4px', fontSize:20, fontWeight:500, color:txt, textAlign:'center' }}>{name}</h3>
          {!isGrp && <p style={{ margin:0, fontSize:14, color:muted }}>{displayJid(jid)}</p>}
          {isGrp && (
            <p style={{ margin:0, fontSize:13, color:muted }}>
              {participantsLabel(groupMeta?.participants_count || contact?.participants_count) || 'Group'}
            </p>
          )}
          {sessionLabel && (
            <div style={{ marginTop:10, display:'flex', alignItems:'center', gap:6, fontSize:12, color:muted, background:card, padding:'4px 12px', borderRadius:20 }}>
              <Smartphone size={12}/> via {sessionLabel}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ padding:'8px 0', borderTop:`8px solid ${isDark?'#0b141a':'#f0f2f5'}`, borderBottom:`8px solid ${isDark?'#0b141a':'#f0f2f5'}` }}>
          <button onClick={()=>onArchiveToggle(contact)}
            style={{ width:'100%', display:'flex', alignItems:'center', gap:16, padding:'14px 20px', background:'none', border:'none', cursor:'pointer', color:txt, fontSize:15 }}
            onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.03)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            {contact?.archived ? <ArchiveRestore size={19} color={muted}/> : <Archive size={19} color={muted}/>}
            {contact?.archived ? 'Unarchive chat' : 'Archive chat'}
          </button>
        </div>

        {/* Group participants */}
        {isGrp && (
          <div style={{ padding:'12px 0' }}>
            <div style={{ padding:'4px 20px 10px', fontSize:14, fontWeight:600, color:WA.green, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span>{participantsLabel(groupMeta?.participants_count) || 'Participants'}</span>
            </div>
            {loadingMeta ? (
              <div style={{ padding:20, textAlign:'center' }}><Loader2 size={18} color={WA.green} style={{ animation:'waSpinKf 1s linear infinite' }}/></div>
            ) : groupMeta?.participants?.length ? (
              groupMeta.participants.map(p => (
                <div key={p.jid} style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 20px' }}>
                  <Avatar jid={p.jid} name={`+${p.phone}`} size={40}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>+{p.phone}</div>
                  </div>
                  {p.admin && (
                    <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:WA.green, fontWeight:600 }}>
                      <Crown size={12}/> {p.admin === 'superadmin' ? 'Creator' : 'Admin'}
                    </span>
                  )}
                </div>
              ))
            ) : (
              <p style={{ padding:'0 20px', fontSize:13, color:muted }}>Participant list unavailable.</p>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Starred messages modal ────────────────────────────────────────────────────
function StarredModal({ onClose, onOpenChat, isDark }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const bg = isDark?'#111b21':'#fff', card = isDark?'#233138':'#f7f8fa';
  const txt = isDark?'#e9edef':'#111b21', muted = isDark?'#8696a0':'#667781';

  useEffect(() => {
    api.get('/whatsapp/hub/starred').then(({data})=>setItems(data.messages||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(6,78,59,0.55)', zIndex:1500, display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(3px)' }} onClick={onClose}>
      <motion.div initial={{scale:0.93,opacity:0}} animate={{scale:1,opacity:1}} onClick={e=>e.stopPropagation()}
        style={{ background:bg, borderRadius:20, width:460, maxWidth:'95vw', maxHeight:'80vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'18px 20px', borderBottom:`1px solid ${isDark?'#3b4a54':'#e9edef'}` }}>
          <Star size={18} color={WA.green} fill={WA.green}/>
          <span style={{ flex:1, fontWeight:700, fontSize:16, color:txt }}>Starred messages</span>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:muted }}><X size={18}/></button>
        </div>
        <div style={{ overflowY:'auto', flex:1 }}>
          {loading ? (
            <div style={{ padding:30, textAlign:'center' }}><Loader2 size={20} color={WA.green} style={{animation:'waSpinKf 1s linear infinite'}}/></div>
          ) : items.length===0 ? (
            <div style={{ padding:30, textAlign:'center', color:muted }}>
              <Star size={32} style={{ opacity:0.2, marginBottom:8 }}/>
              <p style={{ fontSize:13 }}>No starred messages yet</p>
            </div>
          ) : items.map(m => (
            <button key={m.id} onClick={()=>{ onOpenChat(m.jid); onClose(); }}
              style={{ width:'100%', textAlign:'left', display:'flex', flexDirection:'column', gap:4, padding:'12px 20px', background:card, border:'none', borderBottom:`1px solid ${isDark?'#182229':'#fff'}`, cursor:'pointer' }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
                <span style={{ fontSize:13, fontWeight:700, color:txt }}>{m.display_name}</span>
                <span style={{ fontSize:11, color:muted, flexShrink:0 }}>{fmtChatTime(m.timestamp)}</span>
              </div>
              <p style={{ margin:0, fontSize:13, color:muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.body}</p>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// ── In-chat search overlay (top bar replaces header when active) ─────────────
function ChatSearchBar({ jid, onClose, onJumpTo, isDark }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.get(`/whatsapp/hub/conversations/${encodeURIComponent(jid)}/search`, { params:{ q: q.trim() } })
        .then(({data}) => setResults(data.messages||[]))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, jid]);

  const bg = isDark ? WA.dSideHeader : WA.sideHeader;
  const txt = isDark ? '#e9edef' : '#111b21';
  const muted = isDark ? '#8696a0' : '#667781';

  return (
    <div style={{ position:'absolute', inset:0, zIndex:60, display:'flex', flexDirection:'column', background:isDark?WA.dChatBg:WA.chatBg }}>
      <div style={{ background:bg, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, flexShrink:0, boxShadow:'0 1px 3px rgba(0,0,0,0.1)' }}>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:txt, display:'flex' }}><ArrowLeft size={20}/></button>
        <div style={{ flex:1, display:'flex', alignItems:'center', gap:8, background:isDark?'#2a3942':'#fff', borderRadius:8, padding:'7px 12px' }}>
          <Search size={15} color={muted}/>
          <input ref={inputRef} value={q} onChange={e=>setQ(e.target.value)} placeholder='Search in conversation'
            style={{ flex:1, background:'none', border:'none', outline:'none', fontSize:14, color:txt }}/>
          {searching && <Loader2 size={14} color={muted} style={{animation:'waSpinKf 1s linear infinite'}}/>}
        </div>
      </div>
      <div style={{ flex:1, overflowY:'auto', background:isDark?WA.dSideBg:WA.sideBg }}>
        {q.trim() && !searching && results.length===0 && (
          <div style={{ padding:30, textAlign:'center', color:muted }}>
            <SearchX size={28} style={{ opacity:0.3, marginBottom:8 }}/>
            <p style={{ fontSize:13 }}>No messages found</p>
          </div>
        )}
        {results.map(m => (
          <button key={m.id} onClick={()=>onJumpTo(m)}
            style={{ width:'100%', textAlign:'left', display:'flex', flexDirection:'column', gap:3, padding:'10px 16px',
              background:'none', border:'none', borderBottom:`1px solid ${isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.05)'}`, cursor:'pointer' }}
            onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.03)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{ fontSize:11, color:muted }}>{fmtChatTime(m.timestamp)} · {m.direction==='out'?'You':'Them'}</span>
            <span style={{ fontSize:14, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function WhatsAppHub() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // ── Theme ──────────────────────────────────────────────────────────────────
  const [isDark, setIsDark] = useState(() =>
    typeof window !== 'undefined' && (localStorage.getItem('theme')==='dark' || document.documentElement.classList.contains('dark'))
  );
  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes:true, attributeFilter:['class'] });
    return () => obs.disconnect();
  }, []);

  // ── Inject global keyframe once ────────────────────────────────────────────
  useEffect(() => {
    if (document.getElementById('wa-kf')) return;
    const s = document.createElement('style');
    s.id = 'wa-kf';
    s.textContent = `@keyframes waSpinKf{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;
    document.head.appendChild(s);
  }, []);

  // ── Sessions ───────────────────────────────────────────────────────────────
  const [sessions,    setSessions]    = useState([]);
  const [sessLoading, setSessLoading] = useState(true);
  const [showManage,  setShowManage]  = useState(false);

  const loadSessions = useCallback(async () => {
    setSessLoading(true);
    try { const { data } = await api.get('/whatsapp/sessions'); setSessions(data?.sessions||[]); }
    catch { /* bridge may be offline */ } finally { setSessLoading(false); }
  }, []);

  useEffect(() => {
    loadSessions();
    const t = setInterval(loadSessions, 60000);
    return () => clearInterval(t);
  }, [loadSessions]);

  const sessionColorMap = useMemo(() => {
    const m = {};
    sessions.forEach((s,i) => { m[s.sessionId]=sc(i); });
    return m;
  }, [sessions]);

  // ── WhatsApp Numbers Filter (Unified Inbox) ────────────────────────────────
  const [numbers, setNumbers] = useState([]);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);

  const loadNumbers = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/numbers');
      const list = data?.numbers || data || [];
      setNumbers(Array.isArray(list) ? list : []);
    } catch {
      setNumbers([]);
    }
  }, []);

  useEffect(() => { loadNumbers(); }, [loadNumbers]);

  // ── Socket.IO Connection (Unified Inbox real-time updates) ─────────────────
  const socketRef = useRef(null);
  useEffect(() => {
    let socket = null;
    const connectSocket = async () => {
      const io = await getSocketIO();
      if (!io) return;
      const token = getToken();
      if (!token) return;
      const socketUrl = BASE_URL.replace(/\/api\/?$/, '');
      socket = io(socketUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10,
      });
      socket.on('connect', () => {
        setSocketConnected(true);
        socket.emit('inbox:join');
      });
      socket.on('disconnect', () => setSocketConnected(false));
      // Real-time: new incoming message
      socket.on('whatsapp:inbox:message', () => { loadContacts(); });
      socket.on('whatsapp:inbox:unread', () => { loadContacts(); });
      socketRef.current = socket;
    };
    connectSocket();
    return () => {
      if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Contacts / chat list ───────────────────────────────────────────────────
  const [contacts,   setContacts]   = useState([]);
  const [groups,     setGroups]     = useState([]);
  const [archived,   setArchived]   = useState([]);
  const [loadingC,   setLoadingC]   = useState(false);
  const [filterMode, setFilterMode] = useState('all');   // all | unread | groups | archived

  // FIX: phone → saved name lookup, used to resolve group-participant senders
  // to their real contact name (mirrors how WhatsApp Web shows the saved
  // contact name instead of a raw phone number above group messages).
  const contactNameByPhone = useMemo(() => {
    const map = {};
    for (const c of contacts) {
      if (c.phone && c.display_name && c.display_name !== c.phone) map[c.phone] = c.display_name;
    }
    return map;
  }, [contacts]);

  const splitContactsAndGroups = (all) => {
    const isGrpRow = c => c.is_group || isGroup(c.jid);
    const plain = all.filter(c => !isGrpRow(c));
    const grps  = all.filter(c => isGrpRow(c));
    const byName = {};
    for (const g of grps) {
      const key = (g.display_name||g.jid).toLowerCase().trim();
      if (!byName[key] || new Date(g.last_message_at)>new Date(byName[key].last_message_at)) byName[key] = g;
    }
    const dedupedGroups = Object.values(byName).sort((a,b)=>new Date(b.last_message_at||0)-new Date(a.last_message_at||0));
    return { plain, dedupedGroups };
  };

  const [inboxError, setInboxError] = useState(null);

  const loadContacts = useCallback(async () => {
    setLoadingC(true);
    try {
      // FIX: selectedNumber (the per-number filter row) was only ever used
      // to highlight a button — it was never passed to the inbox fetch, so
      // clicking a number never actually filtered anything. Now forwarded
      // as session_id, matching how /whatsapp/hub/inbox already supports
      // filtering by session_id server-side.
      const params = selectedNumber ? `&session_id=${encodeURIComponent(selectedNumber)}` : '';
      const { data } = await api.get(`/whatsapp/hub/inbox?limit=500${params}`);
      const { plain, dedupedGroups } = splitContactsAndGroups(data.contacts || []);
      setContacts(plain);
      setGroups(dedupedGroups);
      setInboxError(null);
    } catch (err) {
      // Surface the failure instead of swallowing it — previously this caught
      // every error silently, so a dead/unreachable backend or bridge left
      // the sidebar stuck on "Loading chats…" forever with no indication of
      // what actually went wrong.
      setInboxError(err?.response?.data?.detail || err.message || 'Failed to load chats');
    } finally { setLoadingC(false); }
  }, [selectedNumber]);

  const loadArchived = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/hub/inbox?limit=500&archived=true');
      setArchived(data.contacts || []);
    } catch { /* silently */ }
  }, []);

  useEffect(() => { loadContacts(); const t=setInterval(loadContacts,5000); return ()=>clearInterval(t); }, [loadContacts]);
  useEffect(() => { if (filterMode==='archived') loadArchived(); }, [filterMode, loadArchived]);


    // ── SSE: real-time updates ────────────────────────────────────────────────
    const eventSourceRef = useRef(null);
    const reconnectTimerRef = useRef(null);

    const connectSSE = useCallback(async () => {
      try {
        if (eventSourceRef.current) { try { eventSourceRef.current.close(); } catch(_){} }
        // EventSource cannot set Authorization headers. Mint a short-lived,
        // single-use stream credential through the normal authenticated API.
        const tokenResponse = await api.post('/whatsapp/hub/events-token', null, {
          _silent: true,
          _skipReadyGate: true,
        });
        const streamToken = tokenResponse?.data?.stream_token;
        if (!streamToken) throw new Error('Missing SSE stream credential');
        const sseBase = `${BASE_URL}/whatsapp/hub/events`;
        const url = `${sseBase}?token=${encodeURIComponent(streamToken)}`;
        const es = new EventSource(url, { withCredentials: true });
        es.addEventListener('message', () => { loadContacts(); });
        es.addEventListener('sync',    () => { loadContacts(); });
        es.addEventListener('connected', () => { clearTimeout(reconnectTimerRef.current); });
        es.onerror = () => {
          try { es.close(); } catch(_){}
          eventSourceRef.current = null;
          reconnectTimerRef.current = setTimeout(() => { connectSSE(); }, 8000);
        };
        eventSourceRef.current = es;
      } catch(_) {
        reconnectTimerRef.current = setTimeout(() => { connectSSE(); }, 8000);
      }
    }, [loadContacts]);
    // Connect SSE on mount; auto-reload active thread on new message
    useEffect(() => {
      connectSSE();
      return () => {
        clearTimeout(reconnectTimerRef.current);
        try { eventSourceRef.current?.close(); } catch(_){}
      };
    }, [connectSSE]);

  // ── Active conversation ────────────────────────────────────────────────────
  // (Moved above the SSE effect below because that effect's dependency array
  // references activeJid/loadThread — they must be declared first or React
  // throws "Cannot access before initialization" during render.)
  const [activeJid,  setActiveJid]  = useState(null);
  const [thread,     setThread]     = useState([]);
  const [contact,    setContact]    = useState(null);
  const [loadingT,   setLoadingT]   = useState(false);
  const [replyTo,    setReplyTo]    = useState(null);
  const [forwardMsg, setForwardMsg] = useState(null);
  const [hasMore,    setHasMore]    = useState(false);
  const [loadingMore,setLoadingMore] = useState(false);
  const threadEndRef = useRef(null);

  const loadThread = useCallback(async (jid) => {
    if (!jid) return;
    setLoadingT(true);
    try {
      const { data } = await api.get(`/whatsapp/hub/conversations/${encodeURIComponent(jid)}?limit=200`);
      setThread(data.messages || []);
      setHasMore((data.messages || []).length >= 200);
      // Only override contact if we got one back (avoids wiping display on reload)
      if (data.contact) setContact(data.contact);
    } catch (err) {
      console.error('[WA Hub] loadThread failed for jid:', jid, err?.response?.data || err.message);
      toast.error('Could not load messages: ' + (err?.response?.data?.detail || err.message));
    } finally {
      setLoadingT(false);
    }
  }, []);

  useEffect(() => {
    if (!activeJid) return;
    loadThread(activeJid);
    api.patch(`/whatsapp/hub/conversations/${encodeURIComponent(activeJid)}/read`).catch(()=>{});
    const t = setInterval(()=>loadThread(activeJid), 5000);
    return () => clearInterval(t);
  }, [activeJid, loadThread]);

  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior:'smooth' }); }, [thread]);

  const activeJidRef  = useRef(null);
  const closeChatRef  = useRef(null);

  const openChat = (c) => { setActiveJid(c.jid); activeJidRef.current = c.jid; setContact(c); setThread([]); setReplyTo(null); clearAttachment(); clearCompose(); };
  const closeChat = () => { setActiveJid(null); activeJidRef.current = null; setThread([]); setContact(null); setReplyTo(null); };

  // keep closeChatRef in sync so toggleArchive can call it
  useEffect(() => { closeChatRef.current = closeChat; });

    // Reload active thread faster on SSE message event
    const activeJidForSSE = activeJid;
    useEffect(() => {
      const es = eventSourceRef.current;
      if (!es || !activeJidForSSE) return;
      const handler = (e) => {
        try {
          const d = JSON.parse(e.data || '{}');
          if (d.jid === activeJidForSSE) loadThread(activeJidForSSE);
        } catch(_) {}
      };
      es.addEventListener('message', handler);
      return () => { try { es.removeEventListener('message', handler); } catch(_){} };
    }, [activeJidForSSE, loadThread]);

  
    const [syncing, setSyncing] = useState(false);

    const handleForceSync = useCallback(async () => {
      const connected = sessions.filter(s=>s.status==='connected');
      if (!connected.length) { toast.error('No connected WhatsApp session'); return; }
      setSyncing(true);
      let anyOk = false, lastErr = null;
      for (const sess of connected) {
        try {
          await api.post(`/whatsapp/bridge/sessions/${sess.sessionId}/sync`);
          anyOk = true;
        } catch (err) {
          lastErr = err?.response?.data?.detail || err.message;
        }
      }
      await loadContacts();
      setSyncing(false);
      if (anyOk) {
        toast.success('Sync triggered — new chats will appear shortly');
      } else {
        toast.error(`Sync failed: ${lastErr || 'unknown error'}`);
      }
    }, [sessions, loadContacts]);

    // ★ Auto-recover from the "connected but never loaded" state: if at least
    // one session is connected, contacts have finished their first load, and
    // the inbox is still empty, automatically trigger one force-sync. This
    // covers sessions that were already connected before the bridge last
    // restarted (so messaging-history.set never re-fired) without requiring
    // the admin to know to click "Force Sync" — silently, no toast spam.
    const autoSyncTriedRef = useRef(false);
    useEffect(() => {
      if (autoSyncTriedRef.current) return;
      if (sessLoading || loadingC) return;
      const connected = sessions.filter(s=>s.status==='connected');
      if (!connected.length) return;
      if (contacts.length > 0 || groups.length > 0) { autoSyncTriedRef.current = true; return; }
      autoSyncTriedRef.current = true;
      (async () => {
        for (const sess of connected) {
          await api.post(`/whatsapp/bridge/sessions/${sess.sessionId}/sync`).catch(()=>{});
        }
        await loadContacts();
      })();
    }, [sessions, sessLoading, loadingC, contacts.length, groups.length, loadContacts]);

    const toggleArchive = useCallback(async (c) => {
    if (!c) return;
    const next = !c.archived;
    try {
      await api.patch(`/whatsapp/hub/conversations/${encodeURIComponent(c.jid)}/archive`, { archived: next });
      toast.success(next ? 'Chat archived' : 'Chat unarchived');
      await loadContacts();
      await loadArchived();
      if (next && activeJidRef.current === c.jid) closeChatRef.current?.();
    } catch { toast.error('Failed to update archive status'); }
  }, [loadContacts, loadArchived]);

  // ── Search ─────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');

  const filteredList = useMemo(() => {
    let list = filterMode==='groups' ? groups : filterMode==='archived' ? archived : contacts;
    if (filterMode==='unread') list = list.filter(c=>c.unread_count>0);
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(c =>
      (getDisplayName(c)||'').toLowerCase().includes(q) ||
      (c.phone||'').includes(q)
    );
  }, [contacts, groups, archived, filterMode, search]);

  const loadMoreMessages = useCallback(async () => {
      if (!activeJid || loadingMore || !hasMore) return;
      setLoadingMore(true);
      try {
        const oldest = thread[0];
        const before = oldest?.id || '';
        const { data } = await api.get(`/whatsapp/hub/conversations/${encodeURIComponent(activeJid)}?limit=200&before=${before}`);
        const more = data.messages || [];
        setThread(prev => [...more, ...prev]);
        setHasMore(more.length >= 200);
      } catch (err) {
        toast.error('Could not load more messages');
      } finally {
        setLoadingMore(false);
      }
    }, [activeJid, loadingMore, hasMore, thread]);

  // ── Compose ────────────────────────────────────────────────────────────────
  const [reply,      setReply]      = useState('');
  const [fromSess,   setFromSess]   = useState('');
  const [sending,    setSending]    = useState(false);
  const [showEmoji,  setShowEmoji]  = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [attCaption, setAttCaption] = useState('');
  const emojiRef  = useRef(null);
  const attachRef = useRef(null);
  const textRef   = useRef(null);

  const clearAttachment = () => { setAttachment(null); setAttCaption(''); setShowAttach(false); };
  const clearCompose    = () => { setReply(''); setShowEmoji(false); setShowAttach(false); };

  // Close emoji/attach menus on outside click
  useEffect(() => {
    if (!showEmoji && !showAttach) return;
    const h = (e) => {
      if (emojiRef.current  && !emojiRef.current.contains(e.target))  setShowEmoji(false);
      if (attachRef.current && !attachRef.current.contains(e.target)) setShowAttach(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showEmoji, showAttach]);

  const handlePickFile = (file) => {
    if (!file) return;
    if (file.size > 15*1024*1024) { toast.error('File too large (max 15 MB)'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const base64  = dataUrl.split(',')[1];
      setAttachment({ base64, mimeType:file.type, filename:file.name, size:file.size,
        preview:file.type.startsWith('image/')?dataUrl:null });
      setAttCaption('');
    };
    reader.readAsDataURL(file);
  };

  const connectedSessions = sessions.filter(s=>s.status==='connected');
  const canSend = !sending && (reply.trim().length>0 || attachment!==null);

  const handleSend = async () => {
    if (!canSend || !activeJid) return;
    setSending(true);
    try {
      if (attachment) {
        await api.post('/whatsapp/hub/reply-media', {
          jid:activeJid, session_id:fromSess||null,
          base64:attachment.base64, mime_type:attachment.mimeType,
          filename:attachment.filename, caption:attCaption.trim()||null,
        });
        clearAttachment();
      } else {
        await api.post('/whatsapp/hub/reply', { jid:activeJid, message:reply.trim(), session_id:fromSess||null });
        setReply('');
      }
      setReplyTo(null);
      await loadThread(activeJid);
      await loadContacts();
    } catch(e) {
      toast.error(e?.response?.data?.detail || 'Failed to send');
    } finally { setSending(false); }
  };

  const handleKeyDown = (e) => {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── Delete message ─────────────────────────────────────────────────────────
  const deleteMsg = async (msg) => {
    if (!isAdmin) { toast.error('Only admins can delete messages'); return; }
    if (!window.confirm('Delete this message from the Hub view?')) return;
    try {
      // No dedicated API for single message delete — just remove from local view
      setThread(t => t.filter(m=>m.id!==msg.id));
      toast.success('Message removed from view');
    } catch { toast.error('Failed to delete'); }
  };

  // ── Theme variables ────────────────────────────────────────────────────────
  const sideBg    = isDark ? WA.dSideBg    : WA.sideBg;
  const sideHdr   = isDark ? WA.dSideHeader: WA.sideHeader;
  const chatBg    = isDark ? WA.dChatBg    : WA.chatBg;
  const inputBg   = isDark ? WA.dInputBg   : WA.inputBg;
  const txt       = isDark ? '#e9edef'     : '#111b21';
  const muted     = isDark ? '#8696a0'     : '#667781';
  const brd       = isDark ? 'rgba(233,237,239,0.12)' : 'rgba(0,0,0,0.08)';
  const iconBtn   = { background:'none', border:'none', cursor:'pointer', color:muted, padding:8, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', transition:'background 0.15s' };

  const connected = sessions.filter(s=>s.status==='connected').length;

  // ── WhatsApp background pattern ────────────────────────────────────────────
  const bgPattern = isDark
    ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Ccircle cx='20' cy='20' r='1' fill='rgba(255,255,255,0.04)'/%3E%3C/svg%3E")`
    : `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='304' height='304'%3E%3Cpath fill='none' stroke='%23b2bec3' stroke-width='1' opacity='0.2' d='M4 4c0-2 2-4 4-4h4c2 0 4 2 4 4v4c0 2-2 4-4 4H8C6 12 4 10 4 8V4z'/%3E%3C/svg%3E")`;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 80px)', minHeight:0, margin:'-16px', overflow:'hidden', fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' }}>

      {/* ── Connection Status Bar (Unified Inbox) ──────────────────────────── */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'6px 16px', flexShrink:0,
        background: isDark ? '#1e293b' : '#ffffff',
        borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <MessageCircle size={14} color={isDark ? '#e2e8f0' : '#0D3B66'} />
          <span style={{ fontSize:12, fontWeight:700, color:isDark ? '#e2e8f0' : '#0D3B66', letterSpacing:'-0.01em' }}>
            Unified Inbox
          </span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div style={{
            width:7, height:7, borderRadius:'50%',
            background: socketConnected ? '#1FAF5A' : '#f59e0b',
            boxShadow: socketConnected ? '0 0 4px rgba(31,175,90,0.4)' : 'none',
          }} />
          <span style={{ fontSize:11, color:muted, fontWeight:500 }}>
            {socketConnected ? 'Live' : (socketConnected===false ? 'Polling' : 'Connecting...')}
          </span>
        </div>
      </div>

      {/* ── Manage Numbers Modal ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {showManage && (
          <ManageModal isDark={isDark} sessions={sessions} onClose={()=>setShowManage(false)} onRefresh={()=>{ loadSessions(); loadContacts(); }}/>
        )}
      </AnimatePresence>

      {/* ── Forward Message Modal ─────────────────────────────────────────────── */}
      {forwardMsg && (
        <ForwardModal
          msg={forwardMsg}
          contacts={[...contacts, ...groups]}
          connectedSessions={connectedSessions}
          isDark={isDark}
          onClose={()=>setForwardMsg(null)}
        />
      )}

      <div style={{ display:'flex', flex:1, minHeight:0, overflow:'hidden' }}>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* LEFT SIDEBAR                                                           */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{ width:360, minWidth:320, display:'flex', flexDirection:'column', background:sideBg, borderRight:`1px solid ${brd}`, flexShrink:0 }}>

        {/* Sidebar header */}
        <div style={{ background:sideHdr, padding:'10px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <Avatar jid={user?.email||'me'} name={user?.name||'Me'} size={40}/>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:txt, lineHeight:1.2 }}>{user?.name||'WhatsApp Hub'}</div>
              <div style={{ fontSize:11, color:muted }}>{connected} number{connected!==1?'s':''} connected</div>
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button onClick={handleForceSync} disabled={syncing} style={iconBtn} title='Refresh (re-syncs chat history from WhatsApp)'
              onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <RefreshCw size={18} style={{animation:(loadingC||syncing)?'waSpinKf 1s linear infinite':'none'}}/>
            </button>
            {isAdmin && (
              <button onClick={()=>setShowManage(true)} style={iconBtn} title='Manage Numbers'
                onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <Settings size={18}/>
              </button>
            )}
          </div>
        </div>

        {/* ── Numbers Filter (Unified Inbox) ────────────────────────────────── */}
        {numbers.length > 0 && (
          <div style={{ padding:'6px 12px', background:sideBg, borderBottom:`1px solid ${brd}`, flexShrink:0 }}>
            <div style={{ display:'flex', gap:4, overflowX:'auto', scrollbarWidth:'none', paddingBottom:2 }}>
              <button
                onClick={() => setSelectedNumber(null)}
                style={{
                  flexShrink:0, padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer',
                  fontSize:11, fontWeight:600, transition:'all 0.15s',
                  background: selectedNumber === null ? '#0D3B66' : (isDark ? '#202c33' : '#e9edef'),
                  color: selectedNumber === null ? '#fff' : muted,
                }}
              >
                All Numbers
              </button>
              {numbers.map((num, i) => {
                const isActive = selectedNumber === (num.id || num.number);
                const color = sc(i);
                return (
                  <button
                    key={num.id || num.number}
                    onClick={() => setSelectedNumber(num.id || num.number)}
                    style={{
                      flexShrink:0, padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer',
                      fontSize:11, fontWeight:600, transition:'all 0.15s', display:'flex', alignItems:'center', gap:5,
                      background: isActive ? color : (isDark ? '#202c33' : '#e9edef'),
                      color: isActive ? '#fff' : muted,
                    }}
                  >
                    <span style={{ width:6, height:6, borderRadius:'50%', background:color, flexShrink:0 }}/>
                    {num.label || formatPhone(num.number)}
                    {num.conversation_count > 0 && (
                      <span style={{ fontSize:10, opacity:0.7 }}>({num.conversation_count})</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {inboxError && (
          <div style={{ background:isDark?'#3a1f1f':'#fdecea', borderBottom:`1px solid ${isDark?'#5c2b2b':'#f5c6c2'}`, color:isDark?'#ffb4ab':'#a13a32', fontSize:12, padding:'8px 16px', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
            <AlertCircle size={14}/>
            <span style={{ flex:1 }}>Couldn't load chats: {inboxError}</span>
            <button onClick={loadContacts} style={{ background:'none', border:'none', color:'inherit', textDecoration:'underline', cursor:'pointer', fontSize:12, fontWeight:600 }}>Retry</button>
          </div>
        )}

        {/* Search */}
        <div style={{ padding:'8px 12px', background:sideBg, flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, background:isDark?'#202c33':'#f0f2f5', borderRadius:8, padding:'6px 12px' }}>
            <Search size={15} color={muted}/>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder='Search or start new chat'
              style={{ flex:1, background:'none', border:'none', outline:'none', fontSize:14, color:txt }}/>
            {search && <button onClick={()=>setSearch('')} style={{ background:'none', border:'none', cursor:'pointer', color:muted, padding:0, display:'flex' }}><X size={14}/></button>}
          </div>
        </div>

        {/* Filter chips */}
        <div style={{ display:'flex', gap:6, padding:'4px 12px 8px', overflowX:'auto', flexShrink:0, scrollbarWidth:'none' }}>
          {[
            { id:'all',    label:'All' },
            { id:'unread', label:'Unread' },
            { id:'groups', label:'Groups' },
          ].map(f => (
            <button key={f.id} onClick={()=>setFilterMode(f.id)}
              style={{ flexShrink:0, padding:'4px 14px', borderRadius:20, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                background:filterMode===f.id?WA.green:(isDark?'#202c33':'#e9edef'),
                color:filterMode===f.id?'#fff':muted, transition:'all 0.15s' }}>
              {f.label}
            </button>
          ))}
          {sessions.length > 1 && sessions.filter(s=>s.status==='connected').map((s,i) => (
            <button key={s.sessionId} onClick={()=>setFilterMode(s.sessionId)}
              style={{ flexShrink:0, padding:'4px 14px', borderRadius:20, border:'none', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5,
                background:filterMode===s.sessionId?sc(sessions.findIndex(x=>x.sessionId===s.sessionId)):(isDark?'#202c33':'#e9edef'),
                color:filterMode===s.sessionId?'#fff':muted, transition:'all 0.15s' }}>
              {s.label||`Acct ${i+1}`}
            </button>
          ))}
        </div>

        {/* Chat list */}
        <div style={{ flex:1, overflowY:'auto', scrollbarWidth:'thin', scrollbarColor:`${muted} transparent` }}>
          {/* No sessions banner */}
          {sessions.length===0 && !sessLoading && (
            <div style={{ padding:'24px 16px', textAlign:'center' }}>
              <div style={{ width:72, height:72, borderRadius:'50%', background:isDark?'#202c33':'#f0f2f5', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
                <Smartphone size={32} color={muted}/>
              </div>
              <p style={{ fontSize:14, fontWeight:600, color:txt, margin:'0 0 6px' }}>No numbers connected</p>
              <p style={{ fontSize:13, color:muted, margin:'0 0 14px', lineHeight:1.5 }}>{isAdmin?'Connect a WhatsApp number to start the Hub.':'Ask your admin to connect a number.'}</p>
              {isAdmin && (
                <button onClick={()=>setShowManage(true)} style={{ background:WA.green, color:'#fff', border:'none', borderRadius:10, padding:'10px 20px', fontSize:14, fontWeight:700, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8 }}>
                  <Plus size={15}/> Connect a Number
                </button>
              )}
            </div>
          )}

          {/* Chat items — only show when at least one session exists */}
          {sessions.length > 0 && filteredList.map(c => (
            <ChatItem key={c.jid} contact={c} active={activeJid===c.jid} sessionColorMap={sessionColorMap} contactNameByPhone={contactNameByPhone} sessions={sessions} isDark={isDark} onClick={()=>openChat(c)}/>
          ))}

          {/* Empty state for list */}
          {sessions.length>0 && filteredList.length===0 && !loadingC && (
            <div style={{ padding:24, textAlign:'center', color:muted }}>
              <MessageCircle size={36} style={{ margin:'0 auto 8px', display:'block', opacity:0.2 }}/>
              <p style={{ fontSize:13 }}>{search?'No matches found':'No conversations yet'}</p>
              {!search && connected>0 && <p style={{ fontSize:12, marginTop:4 }}>Chat history syncs when a session connects.</p>}
            </div>
          )}
          {loadingC && contacts.length===0 && (
            <div style={{ padding:24, textAlign:'center', color:muted }}>
              <Loader2 size={22} style={{ display:'block', margin:'0 auto', animation:'waSpinKf 1s linear infinite' }}/>
              <p style={{ fontSize:13, marginTop:8 }}>Loading chats…</p>
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* RIGHT PANEL                                                            */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0, background:chatBg, backgroundImage:bgPattern }}>
        {!activeJid ? (
          /* Empty state */
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16 }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ width:200, height:200, borderRadius:'50%', background:isDark?'rgba(255,255,255,0.04)':'rgba(0,168,132,0.08)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 24px' }}>
                <MessageCircle size={80} color={WA.green} style={{ opacity:0.6 }}/>
              </div>
              <h2 style={{ fontSize:28, fontWeight:300, color:isDark?'#e9edef':'#41525d', margin:'0 0 12px', letterSpacing:'-0.3px' }}>WhatsApp Hub</h2>
              <p style={{ fontSize:14, color:muted, margin:'0 0 6px', maxWidth:400, lineHeight:1.6 }}>
                {sessions.length===0
                  ? isAdmin ? 'Click the settings icon to connect your first WhatsApp number.' : 'No WhatsApp numbers connected yet.'
                  : `Select a conversation from the left to view messages. ${contacts.length} chat${contacts.length!==1?'s':''} · ${groups.length} group${groups.length!==1?'s':''}.`}
              </p>
              <p style={{ fontSize:12, color:muted, opacity:0.6, marginTop:4 }}>Messages are end-to-end encrypted</p>
              {sessions.length===0 && isAdmin && (
                <button onClick={()=>setShowManage(true)} style={{ marginTop:16, background:WA.green, color:'#fff', border:'none', borderRadius:10, padding:'10px 24px', fontSize:14, fontWeight:700, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8 }}>
                  <Plus size={15}/> Connect a Number
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div style={{ background:isDark?WA.dSideHeader:WA.sideHeader, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, flexShrink:0, boxShadow:'0 1px 3px rgba(0,0,0,0.1)' }}>
              <button onClick={closeChat} style={{ ...iconBtn, display:'flex' }}
                onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <ArrowLeft size={20}/>
              </button>
              <Avatar jid={activeJid} name={getDisplayName(contact)} size={40} isGrp={isGroup(activeJid)} url={contact?.profile_pic_url}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:600, color:txt, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {isGroup(activeJid) && <span style={{ fontSize:10, background:'rgba(0,168,132,0.18)', color:WA.green, borderRadius:3, padding:'1px 5px', marginRight:6, fontWeight:700 }}>GROUP</span>}
                  {getDisplayName(contact) || displayJid(activeJid)}
                </div>
                {contact?.session_id && (
                  <div style={{ fontSize:12, color:muted, display:'flex', alignItems:'center', gap:5, marginTop:1 }}>
                    <div style={{ width:7, height:7, borderRadius:'50%', background:sessionColorMap[contact.session_id]||WA.green }}/>
                    <span>{sessions.find(s=>s.sessionId===contact.session_id)?.label || contact.session_id}</span>
                    {contact.phone && <span style={{ opacity:0.7 }}>· {displayJid(activeJid)}</span>}
                  </div>
                )}
                {!contact?.session_id && contact?.phone && (
                  <div style={{ fontSize:12, color:muted, marginTop:1 }}>
                    {displayJid(activeJid)}
                  </div>
                )}
              </div>
              <div style={{ display:'flex', gap:4 }}>
                {isAdmin && activeJid && (
                  <button title='Delete conversation' onClick={()=>{
                    if(window.confirm('Delete this entire conversation from the Hub?')) {
                      api.delete(`/whatsapp/hub/conversations/${encodeURIComponent(activeJid)}`)
                        .then(()=>{ closeChat(); loadContacts(); toast.success('Conversation deleted'); })
                        .catch(()=>toast.error('Failed to delete'));
                    }
                  }} style={{ ...iconBtn }}
                    onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <Trash2 size={19}/>
                  </button>
                )}
              </div>
            </div>

            {/* Messages area */}
            <div style={{ flex:1, overflowY:'auto', padding:'12px 60px', scrollbarWidth:'thin', scrollbarColor:`${muted} transparent` }}>
              {loadingT && thread.length===0
                ? <div style={{ display:'flex', justifyContent:'center', paddingTop:40 }}><Loader2 size={24} color={WA.green} style={{ animation:'waSpinKf 1s linear infinite' }}/></div>
                : thread.length===0
                  ? <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:10, color:muted }}>
                      <MessageCircle size={40} style={{ opacity:0.2 }}/>
                      <p style={{ fontSize:14 }}>No messages yet — send the first one!</p>
                    </div>
                  : thread.map((msg, idx) => {
                      const prev = thread[idx-1];
                      const next = thread[idx+1];
                      const showDateSep = !prev || !isSameDay(prev.timestamp, msg.timestamp);
                      return (
                        <React.Fragment key={msg.id}>
                          {showDateSep && <DateSep ts={msg.timestamp} isDark={isDark}/>}
                          <Bubble msg={msg} prev={prev} next={next} isDark={isDark} sessionColorMap={sessionColorMap}
                            isGrp={isGroup(activeJid)}
                            multiSession={connectedSessions.length > 1}
                            contactNameByPhone={contactNameByPhone}
                            onReply={m=>setReplyTo(m)}
                            onStar={async (msg) => {
                              const next = !msg.starred;
                              try {
                                await api.patch(`/whatsapp/hub/messages/${msg.id}/star`, { starred: next });
                                setThread(t => t.map(m => m.id === msg.id ? {...m, starred: next} : m));
                              } catch { toast.error('Failed to star message'); }
                            }}
                            onReact={async (msg, emoji) => {
                              try {
                                await api.post(`/whatsapp/hub/messages/${msg.id}/react`, { emoji });
                                setThread(t => t.map(m => {
                                  if (m.id !== msg.id) return m;
                                  const reactions = { ...(m.reactions||{}) };
                                  reactions[emoji] = (reactions[emoji]||0) + 1;
                                  return { ...m, reactions };
                                }));
                              } catch { toast.error('Failed to send reaction'); }
                            }}
                            onForward={m=>setForwardMsg(m)}
                            onDelete={deleteMsg}/>
                        </React.Fragment>
                      );
                    })
              }
              {/* ★ Load More button */}
                {hasMore && !loadingT && (
                  <div style={{ display:'flex', justifyContent:'center', padding:'12px 0 4px' }}>
                    <button
                      onClick={loadMoreMessages}
                      disabled={loadingMore}
                      style={{ background:'transparent', border:`1px solid ${isDark?'rgba(255,255,255,0.2)':'rgba(0,0,0,0.15)'}`,
                        color: isDark?'#e9edef':'#111b21', borderRadius:16, padding:'6px 20px', fontSize:12,
                        cursor:loadingMore?'default':'pointer', display:'flex', alignItems:'center', gap:6 }}>
                      {loadingMore
                        ? <><Loader2 size={13} style={{animation:'waSpinKf 1s linear infinite'}}/> Loading…</>
                        : '↑ Load older messages'}
                    </button>
                  </div>
                )}
                <div ref={threadEndRef}/>
            </div>

            {/* Input area */}
            <div style={{ background:isDark?WA.dSideHeader:WA.sideHeader, padding:'8px 16px 8px', flexShrink:0 }}>

              {/* Session selector (multi-account) */}
              {connectedSessions.length > 1 && (
                <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'center', flexWrap:'wrap' }}>
                  <span style={{ fontSize:11, color:muted }}>Send via:</span>
                  {[{sessionId:'',label:'Auto (recommended)'}, ...connectedSessions].map((s,i) => {
                    const col = s.sessionId ? (sessionColorMap[s.sessionId]||WA.green) : muted;
                    const active = fromSess===s.sessionId;
                    return (
                      <button key={s.sessionId||'auto'} onClick={()=>setFromSess(s.sessionId)}
                        style={{ padding:'3px 12px', borderRadius:20, border:`1.5px solid ${active?col:brd}`, cursor:'pointer', fontSize:11, fontWeight:600, background:active?col+'22':'transparent', color:active?col:muted }}>
                        {s.label||`Acct ${i}`}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Reply context */}
              {replyTo && (
                <div style={{ background:isDark?'#202c33':'#f0f2f5', borderRadius:8, padding:'6px 12px', marginBottom:8, borderLeft:`3px solid ${WA.green}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:'0 0 2px', fontSize:11, fontWeight:700, color:WA.green }}>Replying to {replyTo.direction==='out'?'yourself':getDisplayName(contact)}</p>
                    <p style={{ margin:0, fontSize:12, color:muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{replyTo.body}</p>
                  </div>
                  <button onClick={()=>setReplyTo(null)} style={{ background:'none', border:'none', cursor:'pointer', color:muted, padding:4, flexShrink:0 }}><X size={14}/></button>
                </div>
              )}

              {/* Attachment preview */}
              {attachment && (
                <AttachPreview att={attachment} caption={attCaption} onCaptionChange={setAttCaption} onRemove={clearAttachment} isDark={isDark}/>
              )}

              {/* Input row */}
              <div style={{ display:'flex', alignItems:'flex-end', gap:8 }}>

                {/* Emoji */}
                <div ref={emojiRef} style={{ position:'relative', flexShrink:0 }}>
                  <button onClick={()=>{ setShowEmoji(v=>!v); setShowAttach(false); }} style={{ ...iconBtn, color:showEmoji?WA.green:muted }}
                    onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <Smile size={22}/>
                  </button>
                  <AnimatePresence>
                    {showEmoji && <EmojiPicker isDark={isDark} onPick={em=>{ setReply(r=>r+em); textRef.current?.focus(); }}/>}
                  </AnimatePresence>
                </div>

                {/* Attach */}
                <div ref={attachRef} style={{ position:'relative', flexShrink:0 }}>
                  <button onClick={()=>{ setShowAttach(v=>!v); setShowEmoji(false); }} style={{ ...iconBtn, color:showAttach?WA.green:muted }}
                    onMouseEnter={e=>e.currentTarget.style.background=isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.06)'}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <Paperclip size={22}/>
                  </button>
                  <AnimatePresence>
                    {showAttach && <AttachMenu isDark={isDark} onPickFile={handlePickFile} onClose={()=>setShowAttach(false)}/>}
                  </AnimatePresence>
                </div>

                {/* Text */}
                {!attachment && (
                  <textarea ref={textRef} rows={1} value={reply}
                    onChange={e=>{ setReply(e.target.value); e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,120)+'px'; }}
                    onKeyDown={handleKeyDown}
                    placeholder='Type a message'
                    style={{ flex:1, background:isDark?'#202c33':'#fff', border:'none', borderRadius:8, padding:'11px 14px', fontSize:14, resize:'none', outline:'none', color:txt, lineHeight:1.5, maxHeight:120, overflowY:'auto', boxShadow:'0 1px 2px rgba(0,0,0,0.08)' }}/>
                )}

                {/* Send / Mic */}
                <button onClick={handleSend} disabled={!canSend}
                  style={{ width:44, height:44, borderRadius:'50%', border:'none', cursor:canSend?'pointer':'not-allowed',
                    background:canSend?WA.green:(isDark?'#202c33':'#e9edef'),
                    color:canSend?'#fff':muted, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.15s' }}>
                  {sending
                    ? <Loader2 size={18} style={{animation:'waSpinKf 1s linear infinite'}}/>
                    : canSend ? <Send size={18}/> : <Mic size={18}/>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      </div> {/* close inner wrapper */}
    </div>
  );
}
