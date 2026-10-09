/**
 * OneNexa Universal Offline Store
 *
 * Provides resilient, zero-sign client-side persistence using IndexedDB
 * with seamless in-memory/localStorage fallback.
 *
 * Caches collections & entities transparently and maintains an idempotent
 * outbound mutation outbox that flushes automatically when connectivity resumes.
 */

const DB_NAME = "OneNexa_OfflineStore_v2";
const DB_VERSION = 1;

let _dbPromise = null;

// In-memory fallback if IndexedDB is disabled or in restricted context
const _memoryCache = {
  entities: new Map(),
  collections: new Map(),
  mutations: new Map(),
};

/**
 * Open or initialize IndexedDB instance
 */
function getDB() {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve(null);
  }

  if (!_dbPromise) {
    _dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("entities")) {
            const entStore = db.createObjectStore("entities", { keyPath: "key" });
            entStore.createIndex("by_company_collection", ["companyId", "collection"], { unique: false });
          }
          if (!db.objectStoreNames.contains("collections")) {
            db.createObjectStore("collections", { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains("mutation_queue")) {
            const mutStore = db.createObjectStore("mutation_queue", { keyPath: "id" });
            mutStore.createIndex("by_timestamp", "timestamp", { unique: false });
          }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  return _dbPromise;
}

/**
 * Helper to determine current authenticated company ID
 */
export function getCurrentCompanyId() {
  if (typeof window === "undefined") return "default_company";
  try {
    const raw = sessionStorage.getItem("user") || localStorage.getItem("user");
    if (raw) {
      const u = JSON.parse(raw);
      return String(u.company_id || u.customer_id || "default_company").trim();
    }
  } catch {}
  return "default_company";
}

/**
 * Normalize collection name from URL path
 */
export function normalizeCollectionFromUrl(url) {
  if (!url) return null;
  const clean = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/?/, "/").split("?")[0] || "";
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length) return null;

  const first = parts[0].toLowerCase();
  const mapping = {
    clients: "clients",
    client: "clients",
    tasks: "tasks",
    task: "tasks",
    invoices: "invoices",
    invoice: "invoices",
    reminders: "reminders",
    reminder: "reminders",
    todos: "todos",
    todo: "todos",
    quotations: "quotations",
    quotation: "quotations",
    leads: "leads",
    lead: "leads",
    visits: "visits",
    visit: "visits",
    users: "users",
    user: "users",
    compliance: "compliance",
    passwords: "passwords",
    "journal-entries": "accounting_entries",
    "accounting": "accounting_entries",
  };

  const collection = mapping[first] || null;
  const entityId = parts.length > 1 && parts[1] !== "list" && parts[1] !== "search" ? parts[1] : null;

  return { collection, entityId, path: clean };
}

/**
 * Cache an entire collection of items
 */
export async function cacheCollection(companyId, collection, items) {
  if (!companyId || !collection || !Array.isArray(items)) return;
  const key = `${companyId}::${collection}`;

  // Memory fallback
  _memoryCache.collections.set(key, items);

  const db = await getDB();
  if (!db) {
    try {
      localStorage.setItem(`onenexa_cache_${key}`, JSON.stringify(items.slice(0, 1000)));
    } catch {}
    return;
  }

  try {
    const tx = db.transaction(["collections", "entities"], "readwrite");
    const colStore = tx.objectStore("collections");
    colStore.put({
      key,
      companyId,
      collection,
      items,
      updatedAt: Date.now(),
    });

    const entStore = tx.objectStore("entities");
    for (const item of items) {
      const id = String(item.id || item._id || item.uuid || "");
      if (id) {
        entStore.put({
          key: `${companyId}::${collection}::${id}`,
          companyId,
          collection,
          id,
          data: item,
          updatedAt: Date.now(),
        });
      }
    }
  } catch {}
}

/**
 * Cache or update a single entity record
 */
export async function cacheEntity(companyId, collection, id, data) {
  if (!companyId || !collection || !id || !data) return;
  const key = `${companyId}::${collection}::${id}`;
  const colKey = `${companyId}::${collection}`;

  _memoryCache.entities.set(key, data);

  // Update in collection cache as well
  let existingList = _memoryCache.collections.get(colKey) || [];
  const idx = existingList.findIndex((item) => String(item.id || item._id) === String(id));
  if (idx >= 0) {
    existingList[idx] = { ...existingList[idx], ...data };
  } else {
    existingList = [data, ...existingList];
  }
  _memoryCache.collections.set(colKey, existingList);

  const db = await getDB();
  if (!db) {
    try {
      localStorage.setItem(`onenexa_cache_${colKey}`, JSON.stringify(existingList.slice(0, 1000)));
    } catch {}
    return;
  }

  try {
    const tx = db.transaction(["entities", "collections"], "readwrite");
    const entStore = tx.objectStore("entities");
    entStore.put({
      key,
      companyId,
      collection,
      id: String(id),
      data,
      updatedAt: Date.now(),
    });

    const colStore = tx.objectStore("collections");
    const getReq = colStore.get(colKey);
    getReq.onsuccess = () => {
      let items = getReq.result?.items || [];
      const itemIdx = items.findIndex((it) => String(it.id || it._id) === String(id));
      if (itemIdx >= 0) {
        items[itemIdx] = { ...items[itemIdx], ...data };
      } else {
        items = [data, ...items];
      }
      colStore.put({
        key: colKey,
        companyId,
        collection,
        items,
        updatedAt: Date.now(),
      });
    };
  } catch {}
}

/**
 * Remove an entity from cache
 */
export async function deleteCachedEntity(companyId, collection, id) {
  if (!companyId || !collection || !id) return;
  const key = `${companyId}::${collection}::${id}`;
  const colKey = `${companyId}::${collection}`;

  _memoryCache.entities.delete(key);
  let existingList = _memoryCache.collections.get(colKey) || [];
  existingList = existingList.filter((item) => String(item.id || item._id) !== String(id));
  _memoryCache.collections.set(colKey, existingList);

  const db = await getDB();
  if (!db) {
    try {
      localStorage.setItem(`onenexa_cache_${colKey}`, JSON.stringify(existingList.slice(0, 1000)));
    } catch {}
    return;
  }

  try {
    const tx = db.transaction(["entities", "collections"], "readwrite");
    tx.objectStore("entities").delete(key);
    const colStore = tx.objectStore("collections");
    const getReq = colStore.get(colKey);
    getReq.onsuccess = () => {
      let items = getReq.result?.items || [];
      items = items.filter((it) => String(it.id || it._id) !== String(id));
      colStore.put({
        key: colKey,
        companyId,
        collection,
        items,
        updatedAt: Date.now(),
      });
    };
  } catch {}
}

/**
 * Retrieve cached collection with client-side query / filter / pagination support
 */
export async function getCachedCollection(companyId, collection, params = {}) {
  const colKey = `${companyId}::${collection}`;
  let items = _memoryCache.collections.get(colKey) || null;

  if (!items) {
    const db = await getDB();
    if (db) {
      items = await new Promise((resolve) => {
        try {
          const tx = db.transaction("collections", "readonly");
          const req = tx.objectStore("collections").get(colKey);
          req.onsuccess = () => resolve(req.result?.items || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
  }

  if (!items) {
    try {
      const raw = localStorage.getItem(`onenexa_cache_${colKey}`);
      if (raw) items = JSON.parse(raw);
    } catch {}
  }

  if (!items || !Array.isArray(items)) {
    return [];
  }

  let result = [...items];

  // Search filter
  const q = String(params.q || params.search || "").trim().toLowerCase();
  if (q) {
    result = result.filter((item) => {
      const searchTarget = JSON.stringify(Object.values(item)).toLowerCase();
      return searchTarget.includes(q);
    });
  }

  // Common relational filters
  if (params.client_id) {
    result = result.filter((item) => String(item.client_id || "") === String(params.client_id));
  }
  if (params.status) {
    result = result.filter((item) => String(item.status || "").toLowerCase() === String(params.status).toLowerCase());
  }
  if (params.user_id || params.assigned_to) {
    const targetUid = String(params.user_id || params.assigned_to);
    result = result.filter((item) => String(item.assigned_to || item.user_id || "") === targetUid);
  }

  // Pagination if requested
  const page = parseInt(params.page, 10);
  const pageSize = parseInt(params.page_size || params.limit, 10);
  if (!isNaN(page) && !isNaN(pageSize) && page > 0 && pageSize > 0) {
    const start = (page - 1) * pageSize;
    return result.slice(start, start + pageSize);
  }

  return result;
}

/**
 * Retrieve a single cached entity by ID
 */
export async function getCachedEntity(companyId, collection, id) {
  const key = `${companyId}::${collection}::${id}`;
  if (_memoryCache.entities.has(key)) {
    return _memoryCache.entities.get(key);
  }

  const db = await getDB();
  if (db) {
    const found = await new Promise((resolve) => {
      try {
        const tx = db.transaction("entities", "readonly");
        const req = tx.objectStore("entities").get(key);
        req.onsuccess = () => resolve(req.result?.data || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (found) return found;
  }

  // Fallback: search in collection list
  const list = await getCachedCollection(companyId, collection);
  const match = list.find((it) => String(it.id || it._id) === String(id));
  return match || null;
}

/**
 * Queue an offline mutation for automatic background replay
 */
export async function enqueueOfflineMutation({
  companyId,
  collection,
  method,
  url,
  data,
  params,
  entityId,
}) {
  const id = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const mutation = {
    id,
    companyId: companyId || getCurrentCompanyId(),
    collection: collection || "general",
    entityId: entityId || String(data?.id || data?._id || ""),
    method: String(method || "POST").toUpperCase(),
    url: String(url || ""),
    data: data || null,
    params: params || null,
    timestamp: Date.now(),
    attempts: 0,
  };

  _memoryCache.mutations.set(id, mutation);

  const db = await getDB();
  if (db) {
    try {
      const tx = db.transaction("mutation_queue", "readwrite");
      tx.objectStore("mutation_queue").put(mutation);
    } catch {}
  } else {
    try {
      const list = JSON.parse(localStorage.getItem("onenexa_offline_mutations") || "[]");
      list.push(mutation);
      localStorage.setItem("onenexa_offline_mutations", JSON.stringify(list));
    } catch {}
  }

  return mutation;
}

/**
 * Fetch all pending mutations ordered by timestamp
 */
export async function getPendingMutations() {
  const db = await getDB();
  if (db) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("mutation_queue", "readonly");
        const req = tx.objectStore("mutation_queue").getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          items.sort((a, b) => a.timestamp - b.timestamp);
          resolve(items);
        };
        req.onerror = () => resolve(Array.from(_memoryCache.mutations.values()));
      } catch {
        resolve(Array.from(_memoryCache.mutations.values()));
      }
    });
  }

  try {
    const raw = localStorage.getItem("onenexa_offline_mutations");
    if (raw) return JSON.parse(raw);
  } catch {}

  return Array.from(_memoryCache.mutations.values());
}

/**
 * Remove a mutation after successful replay
 */
export async function removePendingMutation(id) {
  _memoryCache.mutations.delete(id);

  const db = await getDB();
  if (db) {
    try {
      const tx = db.transaction("mutation_queue", "readwrite");
      tx.objectStore("mutation_queue").delete(id);
    } catch {}
  }

  try {
    const list = JSON.parse(localStorage.getItem("onenexa_offline_mutations") || "[]");
    const filtered = list.filter((m) => m.id !== id);
    localStorage.setItem("onenexa_offline_mutations", JSON.stringify(filtered));
  } catch {}
}

/**
 * Number of pending offline mutations
 */
export async function getPendingCount() {
  const list = await getPendingMutations();
  return list.length;
}

let _isFlushing = false;

/**
 * Silent automatic flush of pending mutations
 */
export async function flushPendingMutations(apiClient) {
  if (_isFlushing || !apiClient) return 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;

  _isFlushing = true;
  let syncedCount = 0;

  try {
    const pending = await getPendingMutations();
    if (!pending.length) return 0;

    for (const mutation of pending) {
      try {
        await apiClient.request({
          method: mutation.method,
          url: mutation.url,
          data: mutation.data,
          params: mutation.params,
          _silent: true,
          _isOfflineReplay: true,
          headers: {
            "x-onenexa-replay": "true",
            "x-operation-id": mutation.id,
          },
        });
        await removePendingMutation(mutation.id);
        syncedCount++;
      } catch (err) {
        // Stop flushing if network drops again
        if (
          !err.response ||
          err.code === "ERR_NETWORK" ||
          err.message === "Network Error" ||
          [502, 503, 504].includes(err.response?.status)
        ) {
          break;
        }

        // Permanent rejection (e.g. 400/409 duplicate) — purge to avoid blocking the queue
        if (err.response?.status >= 400 && err.response?.status < 500) {
          await removePendingMutation(mutation.id);
        }
      }
    }
  } finally {
    _isFlushing = false;
  }

  return syncedCount;
}
