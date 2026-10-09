/**
 * OneNexa Universal Transparent Axios Offline Interceptor
 *
 * Ensures 100% uninterrupted business operations across every PC:
 * 1. Fast-Path Instant Offline Handling:
 *    When the machine is offline (!navigator.onLine), requests resolve instantly (sub-2ms)
 *    from local IndexedDB / SQLite cache without waiting for socket timeouts.
 * 2. Transparent Response Error Interceptor:
 *    If a network drop, timeout, or 502/503/504 occurs mid-flight, requests are
 *    seamlessly recovered using local cache (for GET) or queued in durable outbox (for mutations).
 * 3. Automatic Silent Background Sync:
 *    As soon as connectivity resumes or the server recovers, all pending changes are
 *    flushed and merged automatically with ZERO manual steps and ZERO signs/popups.
 */

import {
  getCurrentCompanyId,
  normalizeCollectionFromUrl,
  cacheCollection,
  cacheEntity,
  deleteCachedEntity,
  getCachedCollection,
  getCachedEntity,
  enqueueOfflineMutation,
  flushPendingMutations,
} from "./offlineStore";

const SINGULAR_ENTITY_MAP = {
  clients: "client",
  client: "client",
  tasks: "task",
  task: "task",
  invoices: "invoice",
  invoice: "invoice",
  reminders: "reminder",
  reminder: "reminder",
  todos: "todo",
  todo: "todo",
  quotations: "quotation",
  quotation: "quotation",
  leads: "lead",
  lead: "lead",
  visits: "visit",
  visit: "visit",
  users: "user",
  user: "user",
  accounting_entries: "accounting_entry",
  accounting: "accounting_entry",
};

/**
 * Check if an error represents an offline, unreachable, or network fault
 */
export function isNetworkOrOfflineError(error) {
  if (!error) return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;

  if (!error.response && error.code !== "ERR_CANCELED") return true;

  if (error.code === "ERR_NETWORK" || error.message === "Network Error") return true;
  if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) return true;

  const status = error.response?.status;
  if (status === 502 || status === 503 || status === 504) return true;

  if (status === 500) {
    const detail = String(error.response?.data?.detail || error.response?.data?.error || "").toLowerCase();
    if (detail.includes("mongodb") || detail.includes("connection refused") || detail.includes("server unavailable")) {
      return true;
    }
  }

  return false;
}

/**
 * Mirror mutation to desktop local Python SQLite endpoint if running locally
 */
async function mirrorToDesktopSqlite(companyId, singularType, entityId, record, operation) {
  if (typeof window === "undefined") return;
  const desktopToken = sessionStorage.getItem("token") || localStorage.getItem("token") || "";

  try {
    const localUrl = `http://127.0.0.1:7432/api/desktop/local-first/records/${singularType}`;
    if (operation === "delete") {
      await fetch(`${localUrl}/${entityId}`, {
        method: "DELETE",
        headers: {
          Authorization: desktopToken ? `Bearer ${desktopToken}` : "",
          "Content-Type": "application/json",
        },
      });
    } else {
      await fetch(localUrl, {
        method: "POST",
        headers: {
          Authorization: desktopToken ? `Bearer ${desktopToken}` : "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: entityId,
          record: record,
        }),
      });
    }
  } catch {
    // Opportunistic mirror; IndexedDB outbox remains source of truth
  }
}

/**
 * Attach the Universal Offline Interceptor to an Axios instance
 */
export function attachOfflineInterceptor(apiInstance) {
  if (!apiInstance) return;

  // ─────────────────────────────────────────────────────────────
  // 1. FAST-PATH REQUEST INTERCEPTOR (Instant response if !navigator.onLine)
  // ─────────────────────────────────────────────────────────────
  apiInstance.interceptors.request.use(async (config) => {
    // Never bypass internal offline replayer
    if (config._isOfflineReplay) {
      return config;
    }

    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
    if (isOffline) {
      const norm = normalizeCollectionFromUrl(config.url);
      if (norm && norm.collection) {
        config.adapter = async (cfg) => {
          const method = (cfg.method || "get").toLowerCase();
          const companyId = getCurrentCompanyId();
          const singularType = SINGULAR_ENTITY_MAP[norm.collection] || norm.collection;

          if (method === "get") {
            if (norm.entityId) {
              const cached = await getCachedEntity(companyId, norm.collection, norm.entityId);
              if (cached) {
                return {
                  data: cached,
                  status: 200,
                  statusText: "OK (Offline Fast-Path)",
                  headers: { "x-onenexa-offline": "fast-path" },
                  config: cfg,
                  _offline: true,
                };
              }
            } else {
              const list = await getCachedCollection(companyId, norm.collection, cfg.params || {});
              return {
                data: list || [],
                status: 200,
                statusText: "OK (Offline Fast-Path)",
                headers: { "x-onenexa-offline": "fast-path" },
                config: cfg,
                _offline: true,
              };
            }
          }

          if (["post", "put", "patch", "delete"].includes(method)) {
            let bodyData = cfg.data;
            if (typeof bodyData === "string") {
              try {
                bodyData = JSON.parse(bodyData);
              } catch {}
            }
            bodyData = bodyData && typeof bodyData === "object" ? { ...bodyData } : {};

            let targetId = norm.entityId || bodyData.id || bodyData._id;
            if (!targetId && method === "post") {
              targetId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
              bodyData.id = targetId;
            }

            if (method === "delete") {
              if (targetId) {
                await deleteCachedEntity(companyId, norm.collection, targetId);
                mirrorToDesktopSqlite(companyId, singularType, targetId, {}, "delete");
              }
            } else {
              const entityData = {
                ...bodyData,
                id: targetId,
                company_id: companyId,
                updated_at: new Date().toISOString(),
                _offline_local: true,
              };
              if (targetId) {
                await cacheEntity(companyId, norm.collection, targetId, entityData);
                mirrorToDesktopSqlite(companyId, singularType, targetId, entityData, "save");
              }
            }

            await enqueueOfflineMutation({
              companyId,
              collection: norm.collection,
              method,
              url: cfg.url,
              data: bodyData,
              params: cfg.params,
              entityId: targetId,
            });

            return {
              data: method === "delete" ? { success: true, id: targetId } : { ...bodyData, id: targetId },
              status: 200,
              statusText: "OK (Offline Instant Save)",
              headers: { "x-onenexa-offline-mutation": "true" },
              config: cfg,
              _offline: true,
            };
          }

          const err = new Error("Device is offline");
          err.code = "ERR_NETWORK";
          err.config = cfg;
          return Promise.reject(err);
        };
      }
    }

    return config;
  });

  // ─────────────────────────────────────────────────────────────
  // 2. RESPONSE INTERCEPTOR (Cache successful GETs & Auto-flush Outbox)
  // ─────────────────────────────────────────────────────────────
  apiInstance.interceptors.response.use(
    (response) => {
      try {
        const method = (response.config?.method || "get").toLowerCase();
        const url = response.config?.url || "";

        if (method === "get" && !response.config?._isOfflineReplay) {
          const norm = normalizeCollectionFromUrl(url);
          if (norm && norm.collection) {
            const companyId = getCurrentCompanyId();
            const data = response.data;

            if (Array.isArray(data)) {
              cacheCollection(companyId, norm.collection, data);
            } else if (data && Array.isArray(data.items)) {
              cacheCollection(companyId, norm.collection, data.items);
            } else if (norm.entityId && data && typeof data === "object") {
              cacheEntity(companyId, norm.collection, norm.entityId, data);
            }
          }
        }

        // Opportunistic silent outbox flush when request succeeds
        if (!response.config?._isOfflineReplay) {
          setTimeout(() => {
            flushPendingMutations(apiInstance).catch(() => {});
          }, 200);
        }
      } catch {}

      return response;
    },

    // ─────────────────────────────────────────────────────────────
    // 3. ERROR INTERCEPTOR (Transparently rescue network/server faults)
    // ─────────────────────────────────────────────────────────────
    async (error) => {
      const config = error.config || {};

      if (config._isOfflineReplay) {
        return Promise.reject(error);
      }

      if (!isNetworkOrOfflineError(error)) {
        return Promise.reject(error);
      }

      const method = (config.method || "get").toLowerCase();
      const rawUrl = config.url || "";
      const norm = normalizeCollectionFromUrl(rawUrl);

      if (!norm || !norm.collection) {
        return Promise.reject(error);
      }

      const companyId = getCurrentCompanyId();
      const singularType = SINGULAR_ENTITY_MAP[norm.collection] || norm.collection;

      // GET FALLBACK
      if (method === "get") {
        try {
          if (norm.entityId) {
            const cachedEntity = await getCachedEntity(companyId, norm.collection, norm.entityId);
            if (cachedEntity) {
              return {
                data: cachedEntity,
                status: 200,
                statusText: "OK (Offline Cached)",
                headers: { "x-onenexa-offline": "true" },
                config,
                _offline: true,
              };
            }
          } else {
            const cachedList = await getCachedCollection(companyId, norm.collection, config.params || {});
            if (cachedList && cachedList.length > 0) {
              return {
                data: cachedList,
                status: 200,
                statusText: "OK (Offline Cached)",
                headers: { "x-onenexa-offline": "true" },
                config,
                _offline: true,
              };
            }

            // Desktop local node probe
            if (typeof window !== "undefined") {
              try {
                const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
                const localRes = await fetch(`http://127.0.0.1:7432/api/desktop/local-first/records/${singularType}`, {
                  headers: { Authorization: token ? `Bearer ${token}` : "" },
                });
                if (localRes.ok) {
                  const localJson = await localRes.json();
                  const localItems = (localJson.items || []).map((i) => i.record || i);
                  if (localItems.length > 0) {
                    cacheCollection(companyId, norm.collection, localItems);
                    return {
                      data: localItems,
                      status: 200,
                      statusText: "OK (Local Node SQLite)",
                      headers: { "x-onenexa-offline": "true" },
                      config,
                      _offline: true,
                    };
                  }
                }
              } catch {}
            }

            // Safe empty fallback
            return {
              data: [],
              status: 200,
              statusText: "OK (Empty Offline Cache)",
              headers: { "x-onenexa-offline": "true" },
              config,
              _offline: true,
            };
          }
        } catch {}
      }

      // MUTATION FALLBACK (POST, PUT, PATCH, DELETE)
      if (["post", "put", "patch", "delete"].includes(method)) {
        try {
          let bodyData = config.data;
          if (typeof bodyData === "string") {
            try {
              bodyData = JSON.parse(bodyData);
            } catch {}
          }
          bodyData = bodyData && typeof bodyData === "object" ? { ...bodyData } : {};

          let targetId = norm.entityId || bodyData.id || bodyData._id;
          if (!targetId && method === "post") {
            targetId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            bodyData.id = targetId;
          }

          if (method === "delete") {
            if (targetId) {
              await deleteCachedEntity(companyId, norm.collection, targetId);
              mirrorToDesktopSqlite(companyId, singularType, targetId, {}, "delete");
            }
          } else {
            const entityData = {
              ...bodyData,
              id: targetId,
              company_id: companyId,
              updated_at: new Date().toISOString(),
              _offline_local: true,
            };
            if (targetId) {
              await cacheEntity(companyId, norm.collection, targetId, entityData);
              mirrorToDesktopSqlite(companyId, singularType, targetId, entityData, "save");
            }
          }

          await enqueueOfflineMutation({
            companyId,
            collection: norm.collection,
            method,
            url: rawUrl,
            data: bodyData,
            params: config.params,
            entityId: targetId,
          });

          return {
            data: method === "delete" ? { success: true, id: targetId } : { ...bodyData, id: targetId },
            status: 200,
            statusText: "OK (Saved Offline)",
            headers: { "x-onenexa-offline-mutation": "true" },
            config,
            _offline: true,
          };
        } catch (innerErr) {
          console.warn("[OfflineInterceptor] Mutation recovery error:", innerErr);
        }
      }

      return Promise.reject(error);
    }
  );

  // ─────────────────────────────────────────────────────────────
  // 4. BACKGROUND EVENT LISTENERS (Silent outbox flush)
  // ─────────────────────────────────────────────────────────────
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      flushPendingMutations(apiInstance).catch(() => {});
    });

    setInterval(() => {
      if (typeof navigator !== "undefined" && navigator.onLine) {
        flushPendingMutations(apiInstance).catch(() => {});
      }
    }, 20000);
  }
}
