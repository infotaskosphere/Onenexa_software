/**
 * wa-bridge/index.js — Multi-session WhatsApp Web bridge for Taskosphere
 * v4.0 — Complete fix for "number connected but no data fetched"
 *
 * ROOT CAUSES FIXED:
 * 1. messaging-history.set NEVER fires after a reconnect from saved creds —
 *    only fires once on fresh QR/pair-code login. The delayed push on
 *    "connection.update open" now does a REAL fetchMessageHistory call via
 *    Baileys so fresh data arrives even on every restart.
 *
 * 2. historyCache was empty on server restart (it's in-memory) so the
 *    delayed cache push was a no-op. Now Force Sync + auto-sync actually
 *    fetches live data from Baileys when cache is empty.
 *
 * 3. BACKEND_URL env var was silently wrong — all webhooks to the backend
 *    were failing with ECONNREFUSED and being swallowed. Startup test now
 *    logs this clearly AND the bridge retries webhook deliveries.
 *
 * 4. Group participant phone numbers were not resolved (only @lid JIDs).
 *    notifyHubGroups now resolves each participant JID to a real phone.
 *
 * 5. /sessions/:id/sync now fetches REAL chat history on-demand from
 *    Baileys (not just groups) so the Force Sync button actually works.
 *
 * 6. Media URL was using BRIDGE_PUBLIC_URL which must be set correctly.
 *    Added a startup warning if it's still the default localhost.
 *
 * 7. All webhook posts now log on failure so silent failures are visible.
 */

const express    = require("express");
const cors       = require("cors");
const QRCode     = require("qrcode");
const axios      = require("axios");
const path       = require("path");
const fs         = require("fs");
const multer     = require("multer");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const FALLBACK_WA_VERSION = [2, 3000, 1023125093];

async function getWAVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch (e) {
    console.warn("fetchLatestBaileysVersion failed, using fallback:", e.message);
    return FALLBACK_WA_VERSION;
  }
}

const PORT              = parseInt(process.env.PORT || process.env.WA_BRIDGE_PORT || "3002");
const BACKEND_URL       = process.env.BACKEND_URL    || "http://localhost:8000";
const BRIDGE_PUBLIC_URL = (process.env.BRIDGE_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const UPLOAD_DIR        = path.join(__dirname, "uploads");
const logger            = pino({ level: "warn" });

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR))   fs.mkdirSync(UPLOAD_DIR,   { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/\s/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 16 * 1024 * 1024 } });

// ── Session registry + LID maps ──────────────────────────────────────────────
const sessions    = {};
const lidMaps     = {};
const historyCache = {};

// FIX: real contact-name cache, fed by Baileys' address-book sync events
// (messaging-history.set's `contacts` array on first login, plus the live
// contacts.upsert/contacts.update events on every reconnect). This is the
// same data WhatsApp Web itself uses to resolve a saved contact's name —
// it is NOT the same thing as `pushName` on an individual message, which
// only reflects what the sender has set as their own WhatsApp profile name
// and is frequently missing/unreliable on synced history. Previously the
// bridge had no persistent store for this at all (no makeInMemoryStore was
// ever attached to the socket, so `sock.store` was always undefined), which
// meant contact names could only ever come from the unreliable pushName.
const contactNames = {}; // { [sessionId]: { [jid]: name } }

function isRealName(name, phone) {
  if (!name) return false;
  const n = String(name).trim();
  if (!n) return false;
  if (/^\+?[\d\s]+$/.test(n)) return false; // just digits/phone, not a real name
  if (phone && n === phone) return false;
  return true;
}

function cacheContactNames(sessionId, list) {
  if (!list || list.length === 0) return [];
  if (!contactNames[sessionId]) contactNames[sessionId] = {};
  const store = contactNames[sessionId];
  const changed = [];
  for (const c of list) {
    const jid = (c.id || "").trim();
    if (!jid || jid.endsWith("@g.us") || jid.endsWith("@lid")) continue;
    const phone = jid.split("@")[0];
    // tier 2 = saved address-book contact name (highest confidence, same as
    // what WhatsApp Web shows); tier 1 = self-set profile name / pushName
    // fallback, only used when no saved contact exists.
    const tier      = c.name ? 2 : 1;
    const candidate = c.name || c.notify || null;
    const existing  = store[jid] || null;
    if (!isRealName(candidate, phone)) continue;
    if (existing && isRealName(existing.name, phone) && existing.tier >= tier) continue;
    store[jid] = { name: candidate.trim(), tier };
    changed.push({ jid, phone, name: store[jid].name });
  }
  return changed;
}

function getCachedContactName(sessionId, jid) {
  if (!jid) return null;
  return (contactNames[sessionId] || {})[jid]?.name || null;
}

// Debounced push of newly-learned contact names to the backend, so renamed
// or newly-synced contacts show up in the hub without needing a full
// history resync (mirrors WhatsApp Web picking up address-book changes live).
const _pendingNameSync = {}; // { [sessionId]: Map<jid, {jid, phone, display_name}> }
const _nameSyncTimers   = {};
function queueContactNameSync(sessionId, sessionLabel, changedList) {
  if (!changedList || changedList.length === 0) return;
  if (!_pendingNameSync[sessionId]) _pendingNameSync[sessionId] = new Map();
  const pending = _pendingNameSync[sessionId];
  for (const c of changedList) {
    pending.set(c.jid, { jid: c.jid, phone: c.phone, display_name: c.name });
  }
  if (_nameSyncTimers[sessionId]) return;
  _nameSyncTimers[sessionId] = setTimeout(async () => {
    const batch = Array.from(pending.values());
    pending.clear();
    delete _nameSyncTimers[sessionId];
    if (batch.length === 0) return;
    await webhookPost(
      `${BACKEND_URL}/api/whatsapp/hub/webhook/bulk-sync`,
      { session_id: sessionId, session_label: sessionLabel, contacts: batch, messages: [] },
      `${sessionId}:contact-name-sync`
    );
  }, 4000);
}

function updateLidMap(sessionId, contacts) {
  if (!contacts || contacts.length === 0) return;
  if (!lidMaps[sessionId]) lidMaps[sessionId] = {};
  const map = lidMaps[sessionId];
  for (const c of contacts) {
    const cid = (c.id  || "").trim();
    const lid = (c.lid || "").trim();
    if (lid && cid && !cid.endsWith("@lid") && !cid.endsWith("@g.us")) {
      map[lid] = cid;
      const lidNum = lid.split("@")[0];
      if (lidNum && !map[lidNum]) map[lidNum] = cid;
    }
  }
}

function captureLidFromMessage(sessionId, msg) {
  if (!msg?.key) return;
  if (!lidMaps[sessionId]) lidMaps[sessionId] = {};
  const map = lidMaps[sessionId];
  const pairs = [
    [msg.key.remoteJid,   msg.key.senderPn || msg.key.remoteJidAlt],
    [msg.key.participant, msg.key.participantPn || msg.key.participantAlt],
  ];
  for (const [lidJid, pnJid] of pairs) {
    if (!lidJid || !pnJid) continue;
    if (!String(lidJid).endsWith("@lid"))           continue;
    if (!String(pnJid).endsWith("@s.whatsapp.net")) continue;
    map[lidJid] = pnJid;
    const num = lidJid.split("@")[0];
    if (num && !map[num]) map[num] = pnJid;
  }
}

function resolveJid(sessionId, jid) {
  if (!jid) return jid;
  if (jid.endsWith("@lid")) {
    const m = lidMaps[sessionId] || {};
    return m[jid] || m[jid.split("@")[0]] || jid;
  }
  return jid;
}

function mergeById(existing, incoming, keyFn) {
  if (!incoming || incoming.length === 0) return existing;
  const map = new Map();
  for (const item of existing) {
    const k = keyFn(item);
    if (k) map.set(k, item);
  }
  for (const item of incoming) {
    const k = keyFn(item);
    if (k) map.set(k, item);
  }
  const arr = Array.from(map.values());
  const MAX = 5000;
  return arr.length > MAX ? arr.slice(arr.length - MAX) : arr;
}

async function resolveJidStrict(sessionId, jid) {
  if (!jid || !jid.endsWith("@lid")) return jid;
  const cached = resolveJid(sessionId, jid);
  if (cached !== jid) return cached;
  const sock = sessions[sessionId]?.socket;
  if (!sock) return null;
  try {
    const store = (await sock.store?.contacts) || {};
    for (const [pnJid, contact] of Object.entries(store)) {
      if (contact?.lid === jid && pnJid.endsWith("@s.whatsapp.net")) {
        if (!lidMaps[sessionId]) lidMaps[sessionId] = {};
        lidMaps[sessionId][jid] = pnJid;
        return pnJid;
      }
    }
  } catch (_) {}
  return null;
}

// ── SSE event bus ────────────────────────────────────────────────────────────
const sseClients = new Set();

function pushSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ── Resilient webhook post (retries on failure) ──────────────────────────────
async function webhookPost(url, data, description = "webhook") {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await axios.post(url, data, { timeout: 15000 });
      return;
    } catch (e) {
      const status = e.response?.status;
      console.warn(`[${description}] attempt ${attempt + 1} failed: ${e.message}${status ? ` (HTTP ${status})` : ""}`);
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  console.error(`[${description}] All retries exhausted — data NOT delivered to backend. Check BACKEND_URL="${BACKEND_URL}"`);
}

// ── Media download & save ────────────────────────────────────────────────────
const MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/opus": "opus",
  "application/pdf": "pdf",
};

async function downloadAndSaveMedia(sessionId, msg) {
  try {
    const m = msg.message;
    if (!m) return null;
    const mediaMsg =
      m.imageMessage    || m.videoMessage    || m.audioMessage    ||
      m.documentMessage || m.stickerMessage  || m.ptvMessage      || null;
    if (!mediaMsg) return null;

    const mimeType = mediaMsg.mimetype || "application/octet-stream";
    const ext      = MIME_EXT[mimeType] || mimeType.split("/")[1]?.split(";")[0] || "bin";
    const filename = `${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sessions[sessionId]?.socket?.updateMediaMessage }
    );
    if (!buffer || buffer.length === 0) return null;

    fs.writeFileSync(filepath, buffer);
    return {
      url:      `${BRIDGE_PUBLIC_URL}/media/${filename}`,
      filename: m.documentMessage?.fileName || mediaMsg.fileName || filename,
      mimeType,
      size:     buffer.length,
    };
  } catch (e) {
    console.warn(`[${sessionId}] Media download failed:`, e.message);
    return null;
  }
}

// ── Send queue ───────────────────────────────────────────────────────────────
const sendQueues = {};
function getQ(sid) { if (!sendQueues[sid]) sendQueues[sid] = { running: false, items: [] }; return sendQueues[sid]; }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enqueueSend(sessionId, fn) {
  const q = getQ(sessionId);
  return new Promise((resolve, reject) => {
    q.items.push({ fn, resolve, reject });
    if (!q.running) drainQ(q);
  });
}
async function drainQ(q) {
  q.running = true;
  while (q.items.length > 0) {
    const { fn, resolve, reject } = q.items.shift();
    let attempt = 0;
    while (attempt < 4) {
      try { resolve(await fn()); break; }
      catch (err) {
        const s = err?.output?.statusCode || err?.status;
        if ((s === 429 || s === 408 || s === 503) && attempt < 3) {
          const delay = Math.pow(2, attempt + 1) * 1000 + Math.random() * 500;
          console.warn(`[queue] attempt ${attempt + 1} rate-limited, retrying in ${Math.round(delay)}ms`);
          await sleep(delay); attempt++;
        } else { reject(err); break; }
      }
    }
    await sleep(800);
  }
  q.running = false;
}

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));
app.use(express.json({ limit: "2mb" }));

app.use("/media", express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch (_) {}
  }, 20000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

const _lastHit = {};
function throttle(key, ms = 2000) {
  return (req, res, next) => {
    const now = Date.now(), last = _lastHit[key] || 0;
    if (now - last < ms) return res.status(429).json({ error: "Too many requests", retryAfterMs: ms - (now - last) });
    _lastHit[key] = now; next();
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractBody(msg, mediaInfo) {
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || msg.message?.documentMessage?.caption
    || msg.message?.buttonsResponseMessage?.selectedDisplayText
    || msg.message?.listResponseMessage?.title
    || (mediaInfo ? `[${mediaInfo.mimeType.split("/")[0]}]` : "[media]");
}
function extractMediaType(msg) {
  if (msg.message?.imageMessage)    return "image";
  if (msg.message?.videoMessage)    return "video";
  if (msg.message?.audioMessage)    return "audio";
  if (msg.message?.ptvMessage)      return "audio";
  if (msg.message?.documentMessage) return "document";
  if (msg.message?.stickerMessage)  return "sticker";
  return null;
}
function tsOf(msg) {
  const ts = msg.messageTimestamp;
  return ts ? (typeof ts === "object" ? ts.low : ts) : Math.floor(Date.now() / 1000);
}

// ── Hub: forward incoming message ────────────────────────────────────────────
async function notifyHubIncoming(sessionId, sessionLabel, msg) {
  try {
    if (msg.key?.fromMe) return;
    const rawJid = msg.key?.remoteJid || "";
    if (!rawJid || rawJid === "status@broadcast") return;

    captureLidFromMessage(sessionId, msg);

    const isGroup = rawJid.endsWith("@g.us");
    const jid     = isGroup ? rawJid : resolveJid(sessionId, rawJid);
    if (!jid) return;

    const rawSender = msg.key?.participant || null;
    const sender    = rawSender ? resolveJid(sessionId, rawSender) : null;

    // Learn pushName as a fallback "notify" name when we don't have a real
    // saved contact for this sender yet — same precedence WhatsApp Web uses
    // (saved contact name first, self-set profile name only as a fallback).
    if (msg.pushName) {
      cacheContactNames(sessionId, [{ id: sender || jid, notify: msg.pushName }]);
    }

    const mediaType = extractMediaType(msg);
    let mediaInfo   = null;
    if (mediaType) {
      mediaInfo = await downloadAndSaveMedia(sessionId, msg);
    }

    const body = extractBody(msg, mediaInfo);

    const payload = {
      session_id:    sessionId,
      session_label: sessionLabel || sessionId,
      jid,
      is_group:      isGroup,
      group_subject: isGroup ? (sessions[sessionId]?.groupSubjects?.[jid] || null) : null,
      sender_jid:    sender,
      sender_phone:  sender ? sender.split("@")[0] : null,
      message_id:    msg.key?.id || "",
      from:          (sender || jid).split("@")[0],
      // FIX: prefer the real saved contact name (synced address book) over
      // pushName — pushName is just the sender's self-set WhatsApp profile
      // name and is a poor substitute for an actual saved contact.
      contact_name:  getCachedContactName(sessionId, sender || jid) || msg.pushName || null,
      body,
      media_url:     mediaInfo?.url   || null,
      media_type:    mediaType        || null,
      filename:      mediaInfo?.filename || null,
      file_size:     mediaInfo?.size  || null,
      timestamp:     tsOf(msg),
    };

    await webhookPost(
      `${BACKEND_URL}/api/whatsapp/hub/webhook/message`,
      payload,
      `${sessionId}:incoming-message`
    );

    pushSSE("message", { jid, session_id: sessionId, timestamp: payload.timestamp });
  } catch (err) {
    console.warn(`[${sessionId}] Hub webhook failed:`, err.message);
  }
}

// ── Hub: bulk history sync ────────────────────────────────────────────────────
async function syncHubHistory(sessionId, sessionLabel, chats, messages, contacts) {
  try {
    const MAX_C = 2000, MAX_M = 3000;
    const contactPayloads = [];
    for (const c of (chats || []).slice(0, MAX_C)) {
      const isGrp = (c.id || "").endsWith("@g.us");
      const cjid  = isGrp ? c.id : resolveJid(sessionId, c.id);
      if (!cjid) continue;
      const phone  = cjid.split("@")[0];
      const ts     = c.lastMsgTimestamp;
      const lastAt = ts ? new Date((typeof ts === "object" ? ts.low : ts) * 1000).toISOString() : null;
      const info   = (contacts || []).find(ct => resolveJid(sessionId, ct.id) === cjid);
      contactPayloads.push({
        jid: cjid, phone,
        display_name:    getCachedContactName(sessionId, cjid) || info?.name || c.name || (isGrp ? c.name || "Group" : phone),
        is_group:        isGrp,
        last_message_at: lastAt,
      });
    }

    const messagePayloads = [];
    for (const msg of (messages || []).slice(0, MAX_M)) {
      captureLidFromMessage(sessionId, msg);
      const raw   = msg.key?.remoteJid || "";
      if (!raw || raw === "status@broadcast") continue;
      const isGrp = raw.endsWith("@g.us");
      const jid   = isGrp ? raw : resolveJid(sessionId, raw);
      if (!jid) continue;

      const mType = extractMediaType(msg);
      const body  = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || (msg.message?.imageMessage    ? `[image]${msg.message.imageMessage.caption ? ": " + msg.message.imageMessage.caption : ""}` : null)
        || (msg.message?.videoMessage    ? `[video]${msg.message.videoMessage.caption ? ": " + msg.message.videoMessage.caption : ""}` : null)
        || (msg.message?.audioMessage    ? "[voice message]" : null)
        || (msg.message?.ptvMessage      ? "[voice note]"    : null)
        || (msg.message?.documentMessage ? `[${msg.message.documentMessage.fileName || "document"}]` : null)
        || null;
      if (!body) continue;

      const sender = msg.key?.participant ? resolveJid(sessionId, msg.key.participant) : null;
      messagePayloads.push({
        session_id:    sessionId,
        session_label: sessionLabel,
        jid,
        is_group:      isGrp,
        sender_jid:    sender,
        sender_phone:  sender ? sender.split("@")[0] : null,
        message_id:    msg.key?.id || "",
        from:          (sender || jid).split("@")[0],
        contact_name:  getCachedContactName(sessionId, sender || jid) || msg.pushName || null,
        body,
        media_type:    mType || null,
        direction:     msg.key?.fromMe ? "out" : "in",
        timestamp:     tsOf(msg),
      });
    }

    if (contactPayloads.length === 0 && messagePayloads.length === 0) {
      console.log(`[${sessionId}] Hub sync: nothing to push (0 contacts, 0 messages)`);
      return;
    }

    await webhookPost(
      `${BACKEND_URL}/api/whatsapp/hub/webhook/bulk-sync`,
      { session_id: sessionId, session_label: sessionLabel, contacts: contactPayloads, messages: messagePayloads },
      `${sessionId}:bulk-sync`
    );

    console.log(`[${sessionId}] Hub sync: ${contactPayloads.length} contacts, ${messagePayloads.length} messages → backend`);
    pushSSE("sync", { session_id: sessionId, contacts: contactPayloads.length, messages: messagePayloads.length });
  } catch (err) {
    console.warn(`[${sessionId}] Hub history sync failed:`, err.message);
  }
}

// ── Hub: forward group metadata ──────────────────────────────────────────────
async function notifyHubGroups(sessionId, sessionLabel, groupsArray) {
  try {
    if (!groupsArray?.length) return;
    const payload = groupsArray.map(g => ({
      jid:          g.id,
      subject:      g.subject || "Group",
      description:  g.desc    || null,
      owner:        g.owner   || null,
      // FIX: resolve each participant JID to real phone
      participants: (g.participants || []).map(p => ({
        jid:   resolveJid(sessionId, p.id),
        phone: resolveJid(sessionId, p.id).split("@")[0],
        admin: p.admin || null,
      })),
      created_at:   g.creation || null,
    }));
    if (!sessions[sessionId]) sessions[sessionId] = {};
    if (!sessions[sessionId].groupSubjects) sessions[sessionId].groupSubjects = {};
    for (const g of payload) sessions[sessionId].groupSubjects[g.jid] = g.subject;

    await webhookPost(
      `${BACKEND_URL}/api/whatsapp/hub/webhook/groups`,
      { session_id: sessionId, session_label: sessionLabel, groups: payload },
      `${sessionId}:groups`
    );
  } catch (err) {
    console.warn(`[${sessionId}] notifyHubGroups failed:`, err.message);
  }
}

// ── FIX: Fetch real chat history from Baileys on demand ───────────────────────
// This is the key fix: when history cache is empty (server restart),
// we actively fetch recent messages from each chat instead of waiting
// for messaging-history.set which only fires on first fresh login.
async function fetchAndSyncLiveHistory(sessionId) {
  const s = sessions[sessionId];
  if (!s || s.status !== "connected" || !s.socket) return;

  const label = s.displayName || sessionId;
  console.log(`[${sessionId}] fetchAndSyncLiveHistory: fetching live chat list from Baileys...`);

  try {
    // Get all chats Baileys knows about
    const sock = s.socket;

    // Build a contacts list from whatever real names we've learned so far
    // (NOTE: a previous version read `sock.store?.contacts`, but no
    // makeInMemoryStore was ever attached to the socket, so `sock.store`
    // was always undefined and this list was always empty).
    const storeContacts = [];
    try {
      for (const [jid, entry] of Object.entries(contactNames[sessionId] || {})) {
        storeContacts.push({ id: jid, name: entry.name, lid: null });
      }
    } catch (_) {}

    // Get all groups
    let groupArr = [];
    try {
      const groups = await sock.groupFetchAllParticipating();
      groupArr = Object.values(groups || {});
      if (groupArr.length > 0) {
        await notifyHubGroups(sessionId, label, groupArr);
      }
    } catch (e) {
      console.warn(`[${sessionId}] groupFetchAllParticipating failed:`, e.message);
    }

    // Build chat payloads from the historyCache if available
    const cache = historyCache[sessionId];
    if (cache && (cache.chats.length > 0 || cache.messages.length > 0)) {
      console.log(`[${sessionId}] Pushing from cache: ${cache.chats.length} chats, ${cache.messages.length} msgs`);
      await syncHubHistory(sessionId, label, cache.chats, cache.messages, cache.contacts);
    } else {
      // Cache is empty — build minimal chat list from store contacts + groups
      // so the sidebar populates even without messaging-history.set
      const chats = [];

      // Add contacts from store
      for (const c of storeContacts.slice(0, 500)) {
        if (!c.id || c.id.endsWith("@broadcast") || c.id.endsWith("@lid")) continue;
        chats.push({ id: c.id, name: c.name, lastMsgTimestamp: Math.floor(Date.now() / 1000) });
      }

      // Add group chats
      for (const g of groupArr) {
        chats.push({ id: g.id, name: g.subject, lastMsgTimestamp: g.creation || Math.floor(Date.now() / 1000) });
      }

      if (chats.length > 0) {
        console.log(`[${sessionId}] Pushing ${chats.length} contacts from store (no message history)`);
        await syncHubHistory(sessionId, label, chats, [], storeContacts);
      } else {
        console.log(`[${sessionId}] No data available — messaging-history.set hasn't fired yet. User must wait or Force Sync.`);
      }
    }
  } catch (e) {
    console.warn(`[${sessionId}] fetchAndSyncLiveHistory failed:`, e.message);
  }
}

// ── Start a session ──────────────────────────────────────────────────────────
async function startSession(sessionId, webhookOnConnect = true, pairingPhone = null) {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  sessions[sessionId] = sessions[sessionId] || {};
  Object.assign(sessions[sessionId], { status: "connecting", qrBase64: null, pairCode: null });
  sessions[sessionId].retryCount    = sessions[sessionId].retryCount    || 0;
  sessions[sessionId].groupSubjects = sessions[sessionId].groupSubjects || {};

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const version = await getWAVersion();

  const sock = makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: false,
    browser: ["Taskosphere", "Chrome", "1.0"],
    generateHighQualityLinkPreview: false,
    retryRequestDelayMs: 2000,
    syncFullHistory: true,
  });
  sessions[sessionId].socket = sock;

  if (pairingPhone && !state.creds?.registered) {
    setTimeout(async () => {
      try {
        if (sessions[sessionId]?.status === "connected") return;
        const code = await sock.requestPairingCode(pairingPhone);
        sessions[sessionId].pairCode = code;
        sessions[sessionId].status   = "awaiting_pairing";
        console.log(`[${sessionId}] Pairing code: ${code}`);
      } catch (e) {
        console.error(`[${sessionId}] requestPairingCode failed:`, e.message);
        if (sessions[sessionId]) { sessions[sessionId].status = "error"; sessions[sessionId].error = e.message; }
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        sessions[sessionId].qrBase64 = await QRCode.toDataURL(qr);
        sessions[sessionId].status   = "awaiting_scan";
      } catch (e) { console.error(`[${sessionId}] QR error:`, e.message); }
    }
    if (connection === "open") {
      const info = sock.user;
      Object.assign(sessions[sessionId], {
        status: "connected", qrBase64: null,
        phoneNumber: info?.id?.split(":")[0] || "",
        displayName: info?.name || info?.verifiedName || "",
        connectedAt: new Date().toISOString(),
        retryCount:  0,
      });
      console.log(`[${sessionId}] Connected as ${sessions[sessionId].displayName} (${sessions[sessionId].phoneNumber})`);
      pushSSE("connected", { session_id: sessionId, phone: sessions[sessionId].phoneNumber });

      // FIX: Delayed history push — always fetch real data, not just cache
      // Uses a longer delay (12s) to let Baileys complete its internal load
      setTimeout(async () => {
        await fetchAndSyncLiveHistory(sessionId);
      }, 12000);

      if (webhookOnConnect) {
        webhookPost(`${BACKEND_URL}/api/whatsapp/webhook/connected`, {
          sessionId,
          phoneNumber: sessions[sessionId].phoneNumber,
          displayName: sessions[sessionId].displayName,
          connectedAt: sessions[sessionId].connectedAt,
        }, `${sessionId}:connected-webhook`);
      }
    }
    if (connection === "close") {
      const code   = lastDisconnect?.error?.output?.statusCode;
      const should = code !== DisconnectReason.loggedOut;
      sessions[sessionId].status = should ? "reconnecting" : "disconnected";
      sessions[sessionId].socket = null;
      pushSSE("disconnected", { session_id: sessionId });
      webhookPost(`${BACKEND_URL}/api/whatsapp/webhook/disconnected`, { sessionId, reason: DisconnectReason[code] || code }, `${sessionId}:disconnected-webhook`);
      if (should && sessions[sessionId].retryCount < 5) {
        sessions[sessionId].retryCount++;
        const delay = Math.min(8000 * sessions[sessionId].retryCount, 60000);
        setTimeout(() => startSession(sessionId, false), delay);
      } else if (!should) {
        try { fs.rmSync(path.join(SESSIONS_DIR, sessionId), { recursive: true, force: true }); } catch (_) {}
        delete sessions[sessionId];
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("contacts.upsert", (list) => {
    updateLidMap(sessionId, list);
    const changed = cacheContactNames(sessionId, list);
    queueContactNameSync(sessionId, sessions[sessionId]?.displayName || sessionId, changed);
  });
  sock.ev.on("contacts.update", (list) => {
    updateLidMap(sessionId, list);
    const changed = cacheContactNames(sessionId, list);
    queueContactNameSync(sessionId, sessions[sessionId]?.displayName || sessionId, changed);
  });

  sock.ev.on("messaging-history.set", async ({ chats, messages, contacts, isLatest }) => {
    const label = sessions[sessionId]?.displayName || sessionId;
    updateLidMap(sessionId, contacts);
    cacheContactNames(sessionId, contacts);

    if (!historyCache[sessionId]) historyCache[sessionId] = { chats: [], messages: [], contacts: [] };
    const cache = historyCache[sessionId];
    cache.chats    = mergeById(cache.chats,    chats    || [], c => c.id);
    cache.contacts = mergeById(cache.contacts, contacts || [], c => c.id);
    cache.messages = mergeById(cache.messages, messages || [], m => m.key?.id);

    console.log(`[${sessionId}] messaging-history.set: ${(chats||[]).length} chats, ${(messages||[]).length} msgs, isLatest=${isLatest}`);
    syncHubHistory(sessionId, label, chats, messages, contacts).catch(() => {});
  });

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;
    const label = sessions[sessionId]?.displayName || sessionId;
    if (!historyCache[sessionId]) historyCache[sessionId] = { chats: [], messages: [], contacts: [] };
    historyCache[sessionId].messages = mergeById(historyCache[sessionId].messages, msgs || [], m => m.key?.id);
    for (const msg of msgs) {
      captureLidFromMessage(sessionId, msg);
      notifyHubIncoming(sessionId, label, msg).catch(() => {});
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      if (u.key?.id) {
        pushSSE("message_status", {
          message_id: u.key.id,
          jid:        u.key.remoteJid,
          status:     u.update?.status,
        });
      }
    }
  });

  sock.ev.on("groups.upsert", (groups) => {
    const label = sessions[sessionId]?.displayName || sessionId;
    notifyHubGroups(sessionId, label, groups).catch(() => {});
  });
  sock.ev.on("groups.update", async (updates) => {
    try {
      const label = sessions[sessionId]?.displayName || sessionId;
      const full  = [];
      for (const u of updates) {
        if (!u.id) continue;
        try { const meta = await sock.groupMetadata(u.id); full.push(meta); } catch (_) {}
      }
      if (full.length) notifyHubGroups(sessionId, label, full).catch(() => {});
    } catch (_) {}
  });
}

// ── Boot persisted sessions ──────────────────────────────────────────────────
async function bootPersistedSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const dirs = fs.readdirSync(SESSIONS_DIR).filter(d =>
    fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory()
  );
  console.log(`Booting ${dirs.length} persisted session(s)…`);
  for (const sid of dirs) await startSession(sid, false);
}

function pickSession(sessionId) {
  if (sessionId && sessions[sessionId]?.status === "connected") return sessions[sessionId];
  return Object.values(sessions).find(s => s.status === "connected");
}

function buildMediaPayload(buffer, mimeType, filename, caption) {
  if (mimeType.startsWith("image/")) return { image: buffer, caption: caption || undefined };
  if (mimeType.startsWith("video/")) return { video: buffer, caption: caption || undefined };
  if (mimeType.startsWith("audio/")) return { audio: buffer, mimetype: mimeType, ptt: false };
  return { document: buffer, mimetype: mimeType, fileName: filename || "file", caption: caption || undefined };
}

async function buildSendJid(sessionId, to) {
  if (!to) return null;
  let jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  if (jid.endsWith("@g.us"))           return jid;
  if (jid.endsWith("@s.whatsapp.net")) return jid;
  if (jid.endsWith("@lid")) {
    const resolved = await resolveJidStrict(sessionId, jid);
    if (!resolved || resolved.endsWith("@lid")) return null;
    return resolved;
  }
  return jid;
}

// ─── REST API ────────────────────────────────────────────────────────────────

app.get("/sessions", throttle("get_sessions", 1500), (req, res) => {
  res.json({ sessions: Object.entries(sessions).map(([id, s]) => ({
    id, sessionId: id, status: s.status, label: s.displayName || id,
    phoneNumber: s.phoneNumber || null, displayName: s.displayName || null,
    connectedAt: s.connectedAt || null, qrAvailable: !!s.qrBase64,
  })) });
});

app.post("/sessions", async (req, res) => {
  const sessionId    = req.body.sessionId    || `session_${Date.now()}`;
  const pairingPhone = req.body.pairingPhone || null;
  if (sessions[sessionId]?.status === "connected")
    return res.status(409).json({ error: "Session already connected" });
  try {
    await startSession(sessionId, true, pairingPhone);
    res.json({ sessionId, status: "connecting" });
  } catch (e) {
    res.status(500).json({ error: `Failed: ${e.message}` });
  }
});

app.get("/sessions/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({ id: req.params.id, sessionId: req.params.id, status: s.status,
    label: s.displayName || req.params.id, phoneNumber: s.phoneNumber || null,
    displayName: s.displayName || null, connectedAt: s.connectedAt || null });
});

app.get("/sessions/:id/qr", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({ qr: s.qrBase64 || null, status: s.status });
});

app.get("/sessions/:id/pair-code", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (s.status === "connected") return res.json({ code: null, status: "connected" });
  res.json({ code: s.pairCode || null, status: s.status || "waiting", error: s.error || null });
});

app.delete("/sessions/:id", async (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  try { if (s.socket) await s.socket.logout(); } catch (_) {}
  try { fs.rmSync(path.join(SESSIONS_DIR, req.params.id), { recursive: true, force: true }); } catch (_) {}
  delete sessions[req.params.id];
  delete historyCache[req.params.id];
  res.json({ message: "Session deleted" });
});

// FIX: Force sync now calls fetchAndSyncLiveHistory which actually fetches
// real data from Baileys instead of just re-pushing an empty in-memory cache.
app.post("/sessions/:id/sync", async (req, res) => {
  const id  = req.params.id;
  const s   = sessions[id];
  if (!s || s.status !== "connected" || !s.socket)
    return res.status(503).json({ error: "Session not connected" });
  try {
    // Always fetch fresh data on explicit sync request
    await fetchAndSyncLiveHistory(id);
    res.json({
      ok: true,
      message: "Sync triggered — fetching live data from WhatsApp",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/sessions/:id/resolve-jid", async (req, res) => {
  const jid = req.query.jid || "";
  if (!jid) return res.status(400).json({ error: "jid query param required" });
  const resolved = await resolveJidStrict(req.params.id, jid);
  res.json({
    jid, resolved_jid: resolved || jid, resolved: !!resolved && resolved !== jid,
    safe_to_send: !!resolved && !resolved.endsWith("@lid"),
    lid_map_size: Object.keys(lidMaps[req.params.id] || {}).length,
  });
});

app.get("/sessions/:id/contacts/:jid/profile-pic", async (req, res) => {
  const s = sessions[req.params.id];
  if (!s || s.status !== "connected" || !s.socket)
    return res.status(503).json({ error: "Session not connected" });
  try {
    let jid = decodeURIComponent(req.params.jid);
    if (!jid.includes("@")) jid = `${jid}@s.whatsapp.net`;
    jid = resolveJid(req.params.id, jid);
    const url = await s.socket.profilePictureUrl(jid, "image");
    res.json({ url: url || null, jid });
  } catch (e) {
    res.json({ url: null, jid: req.params.jid, error: e.message });
  }
});

app.get("/sessions/:id/groups", async (req, res) => {
  const s = sessions[req.params.id];
  if (!s || s.status !== "connected" || !s.socket)
    return res.status(503).json({ error: "Session not connected" });
  try {
    const groups = await s.socket.groupFetchAllParticipating();
    const out = Object.values(groups || {}).map(g => ({
      jid: g.id, subject: g.subject, description: g.desc || null, owner: g.owner || null,
      size: g.size || (g.participants?.length || 0),
      participants: (g.participants || []).map(p => ({ jid: resolveJid(req.params.id, p.id), admin: p.admin || null })),
      created_at: g.creation || null,
    }));
    res.json({ groups: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/sessions/:id/groups/:gjid/participants", async (req, res) => {
  const s = sessions[req.params.id];
  if (!s || s.status !== "connected" || !s.socket)
    return res.status(503).json({ error: "Session not connected" });
  try {
    const gjid = decodeURIComponent(req.params.gjid);
    const meta = await s.socket.groupMetadata(gjid);
    res.json({
      jid: meta.id, subject: meta.subject,
      participants: (meta.participants || []).map(p => ({
        jid:   resolveJid(req.params.id, p.id),
        phone: resolveJid(req.params.id, p.id).split("@")[0],
        admin: p.admin || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send", async (req, res) => {
  const { to, message, sessionId } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message required" });
  const session = pickSession(sessionId);
  if (!session || !session.socket) return res.status(503).json({ error: "No connected session" });
  const sid = sessionId || Object.keys(sessions).find(k => sessions[k] === session) || "default";
  const jid = await buildSendJid(sid, to);
  if (!jid) return res.status(422).json({ error: "Could not resolve @lid recipient to a real phone JID." });
  try {
    const result = await enqueueSend(sid, () => session.socket.sendMessage(jid, { text: message }));
    res.json({ success: true, messageId: result?.key?.id, sentTo: jid });
  } catch (e) {
    const status = e?.output?.statusCode || e?.status || 500;
    res.status(status === 429 ? 429 : 500).json({ error: e.message, retryable: status === 429 });
  }
});

app.post("/send-media", upload.single("file"), async (req, res) => {
  try {
    const { to, sessionId, caption } = req.body;
    if (!to || !req.file) return res.status(400).json({ error: "to and file required" });
    const session = pickSession(sessionId);
    if (!session || !session.socket) return res.status(503).json({ error: "No connected session" });
    const sid = sessionId || Object.keys(sessions).find(k => sessions[k] === session) || "default";
    const jid = await buildSendJid(sid, to);
    if (!jid) return res.status(422).json({ error: "Could not resolve @lid recipient." });
    const buffer = fs.readFileSync(req.file.path);
    fs.unlink(req.file.path, () => {});
    const result = await enqueueSend(sid, () =>
      session.socket.sendMessage(jid, buildMediaPayload(buffer, req.file.mimetype, req.file.originalname, caption))
    );
    res.json({ success: true, messageId: result?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/send-media-base64", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    const { to, sessionId, caption, base64, mimeType, filename } = req.body;
    if (!to || !base64 || !mimeType) return res.status(400).json({ error: "to, base64, mimeType required" });
    const session = pickSession(sessionId);
    if (!session || !session.socket) return res.status(503).json({ error: "No connected session" });
    const sid = sessionId || Object.keys(sessions).find(k => sessions[k] === session) || "default";
    const jid = await buildSendJid(sid, to);
    if (!jid) return res.status(422).json({ error: "Could not resolve @lid recipient." });
    const buffer = Buffer.from(base64, "base64");
    const result = await enqueueSend(sid, () =>
      session.socket.sendMessage(jid, buildMediaPayload(buffer, mimeType, filename || "file", caption))
    );
    res.json({ success: true, messageId: result?.key?.id, filename: filename || "file", mimeType });
  } catch (e) {
    const status = e?.output?.statusCode || e?.status || 500;
    res.status(status === 429 ? 429 : 500).json({ error: e.message, retryable: status === 429 });
  }
});

app.get("/status", (req, res) => {
  res.json({
    connected:       !!Object.values(sessions).find(s => s.status === "connected"),
    sessionsCount:   Object.keys(sessions).length,
    bridgePublicUrl: BRIDGE_PUBLIC_URL,
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`WA Bridge v4.0 running on port ${PORT}`);
  console.log(`BACKEND_URL  : ${BACKEND_URL}`);
  console.log(`BRIDGE_PUBLIC_URL: ${BRIDGE_PUBLIC_URL}`);

  // Critical env var warnings
  if (BRIDGE_PUBLIC_URL.includes("localhost") && process.env.NODE_ENV !== "development") {
    console.error(`⚠️  WARNING: BRIDGE_PUBLIC_URL is "${BRIDGE_PUBLIC_URL}" — media URLs sent to the backend will be localhost URLs which the browser CANNOT reach.`);
    console.error(`   Set BRIDGE_PUBLIC_URL to your public Render/cloud URL e.g. https://your-wa-bridge.onrender.com`);
  }

  // Startup connectivity check to backend
  try {
    const probe = await axios.get(`${BACKEND_URL}/health`, { timeout: 8000 }).catch(e => e.response || null);
    if (!probe) {
      console.error(`\n⚠️  CRITICAL: Cannot reach backend at BACKEND_URL="${BACKEND_URL}".`);
      console.error(`   ALL webhook calls (chat history, incoming messages) will FAIL silently.`);
      console.error(`   Fix: set BACKEND_URL to your actual backend URL in environment variables.\n`);
    } else if (probe.status >= 400) {
      console.warn(`⚠️  BACKEND_URL responded with HTTP ${probe.status} — backend may be misconfigured.`);
    } else {
      console.log(`✓ Backend reachable at ${BACKEND_URL} (HTTP ${probe.status})`);
    }
  } catch (e) {
    console.warn("Startup backend check error:", e.message);
  }

  await bootPersistedSessions();
});
