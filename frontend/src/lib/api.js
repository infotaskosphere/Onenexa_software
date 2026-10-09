import axios from "axios";
import { useState, useEffect } from "react";
import { handleMockRoute } from "./mockBackend";
import { isPlatformOwner } from "./commercialPermissionMatrix";
import { attachOfflineInterceptor } from "./offlineInterceptor";
import * as offlineStore from "./offlineStore";

// ─────────────────────────────────────────────────────────────
// API BASE URL
// ─────────────────────────────────────────────────────────────

// Commercial deployments can use VITE_API_URL so the frontend
// can be connected to any self-hosted or cloud backend.
const CONFIGURED_API_URL = (import.meta.env.VITE_API_URL || "").trim();

// Local development backend fallback.
const LOCAL_API_URL = "http://localhost:7432";

// Detect browser hostname.
const _hostname =
  typeof window !== "undefined"
    ? window.location.hostname
    : "";

const _isLocalHost =
  _hostname === "localhost" ||
  _hostname === "127.0.0.1";

// Default backend URL when deployed without an explicit VITE_API_URL
const PRODUCTION_FALLBACK =
  typeof window !== "undefined" && window.location?.origin
    ? `${window.location.origin}/api`
    : "http://localhost:7432";

let BASE_URL;

const IS_ONENEXA_DESKTOP =
  typeof window !== "undefined" && window.oneNexaDesktop?.isDesktop === true;

if (IS_ONENEXA_DESKTOP) {
  // The Electron shell must always use its own local backend, even if the
  // frontend bundle was built with a hosted VITE_API_URL.
  BASE_URL = "http://127.0.0.1:7432";
} else if (CONFIGURED_API_URL) {
  BASE_URL = CONFIGURED_API_URL;
} else if (_isLocalHost) {
  BASE_URL = LOCAL_API_URL;
} else {
  BASE_URL = PRODUCTION_FALLBACK;
}

// ─────────────────────────────────────────────────────────────
// NORMALIZE API URL
// ─────────────────────────────────────────────────────────────

BASE_URL = BASE_URL.replace(/\/+$/, "");

if (!BASE_URL.endsWith("/api")) {
  BASE_URL += "/api";
}

const BACKEND_BASE_URL = BASE_URL.replace(/\/api$/, "");

export { BASE_URL, BACKEND_BASE_URL };

// ─────────────────────────────────────────────────────────────
// TOKEN HELPERS
// ─────────────────────────────────────────────────────────────

const TOKEN_KEY = "token";

/**
 * IMPORTANT:
 * Token may be stored in either localStorage or sessionStorage.
 *
 * localStorage:
 *   Keep me signed in
 *
 * sessionStorage:
 *   Normal browser session
 *
 * Always check both so hard refresh does not accidentally
 * make the application think the user is logged out.
 */
export const getToken = () => {
  // The current tab owns the active credential in sessionStorage. localStorage
  // is only a durable fallback for a browser restart.
  return (
    sessionStorage.getItem(TOKEN_KEY) ||
    localStorage.getItem(TOKEN_KEY) ||
    null
  );
};

/**
 * Store token according to rememberMe preference.
 *
 * rememberMe = true:
 *   localStorage
 *
 * rememberMe = false:
 *   sessionStorage
 */
export const setToken = (tok, rememberMe = true) => {
  if (!tok) return;

  sessionStorage.setItem(TOKEN_KEY, tok);

  // Keep a durable copy only when explicitly requested. An open tab will
  // continue using its own sessionStorage token.
  if (rememberMe) {
    localStorage.setItem(TOKEN_KEY, tok);
  } else if (localStorage.getItem(TOKEN_KEY) === tok) {
    localStorage.removeItem(TOKEN_KEY);
  }
};

/**
 * Remove authentication token from BOTH storages.
 */
export const clearToken = (ownedToken = null) => {
  sessionStorage.removeItem(TOKEN_KEY);

  // localStorage is shared between tabs; never remove another account's
  // durable token.
  if (ownedToken && localStorage.getItem(TOKEN_KEY) === ownedToken) {
    localStorage.removeItem(TOKEN_KEY);
  }
};

export const SESSION_REPLACED_DETAIL = "SESSION_REPLACED";
export const SESSION_REPLACED_MESSAGE =
  "You were logged out because this account was signed in on another device or browser. Only one active login is allowed.";

const emitSessionReplacement = (failedToken = null) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("taskosphere:session-replaced", {
      detail: {
        message: SESSION_REPLACED_MESSAGE,
        failedToken: failedToken || null,
      },
    })
  );
};

// ─────────────────────────────────────────────────────────────
// GLOBAL LOADING STATE
// ─────────────────────────────────────────────────────────────

let _activeRequests = 0;
const _subscribers = new Set();

function _setLoading(delta) {
  _activeRequests = Math.max(0, _activeRequests + delta);

  const isLoading = _activeRequests > 0;

  _subscribers.forEach((fn) => {
    try {
      fn(isLoading);
    } catch {
      // Ignore subscriber errors.
    }
  });
}

export function useLoading() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    _subscribers.add(setLoading);

    return () => {
      _subscribers.delete(setLoading);
    };
  }, []);

  return loading;
}

// ─────────────────────────────────────────────────────────────
// BACKEND REACHABILITY STATE
// ─────────────────────────────────────────────────────────────

let _consecutiveNetworkFailures = 0;
let _backendUnreachable = false;

const _NETWORK_FAILURE_THRESHOLD = 2;

const _reachabilitySubscribers = new Set();

function _reportNetworkResult(ok) {
  if (ok) {
    _consecutiveNetworkFailures = 0;

    if (_backendUnreachable) {
      _backendUnreachable = false;

      _reachabilitySubscribers.forEach((fn) => {
        try {
          fn(false);
        } catch {
          // Ignore subscriber errors.
        }
      });
    }

    return;
  }

  _consecutiveNetworkFailures += 1;

  if (
    !_backendUnreachable &&
    _consecutiveNetworkFailures >= _NETWORK_FAILURE_THRESHOLD
  ) {
    _backendUnreachable = true;

    _reachabilitySubscribers.forEach((fn) => {
      try {
        fn(true);
      } catch {
        // Ignore subscriber errors.
      }
    });
  }
}

export function useBackendUnreachable() {
  const [unreachable, setUnreachable] =
    useState(_backendUnreachable);

  useEffect(() => {
    _reachabilitySubscribers.add(setUnreachable);

    return () => {
      _reachabilitySubscribers.delete(setUnreachable);
    };
  }, []);

  return unreachable;
}

// ─────────────────────────────────────────────────────────────
// REQUEST DEDUPLICATION
// ─────────────────────────────────────────────────────────────

const _inflight = new Map();

const DEDUP_WINDOW_MS = 300;

// ─────────────────────────────────────────────────────────────
// BACKEND READINESS GATE
// ─────────────────────────────────────────────────────────────

let _readyPromise = null;
let _isReady = false;

const _sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function markBackendNotReady() {
  _isReady = false;
  _readyPromise = null;
}

export function ensureBackendReady() {
  // Production API requests do not require a separate /health probe.
  // This avoids any stale localhost health URL in previously bundled clients
  // and prevents a health-check failure from blocking real application calls.
  _isReady = true;
  _readyPromise = null;
  return Promise.resolve(true);
}


// ─────────────────────────────────────────────────────────────
// COLLECTION ROUTES
// ─────────────────────────────────────────────────────────────

/**
 * These collection endpoints may exist with or without a
 * trailing slash depending on the deployed backend version.
 *
 * IMPORTANT:
 * /recruitment is included here because the Recruitment page
 * uses GET /api/recruitment.
 */
const SLASH_COMPATIBLE_COLLECTIONS = new Set([
  "/notifications",
  "/visits",
  "/leads",
  "/quotations",
  "/quotations/list",
  "/companies",
  "/compliance",
  "/passwords",
  "/client-discussion",
  "/recruitment",
]);

// ─────────────────────────────────────────────────────────────
// AXIOS INSTANCE
// ─────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Restore the bearer header immediately when the bundle starts. This covers
// the first protected request during session restoration as well as requests
// made by components before AuthContext has finished mounting.
try {
  const initialToken = getToken();
  if (initialToken) {
    api.defaults.headers.common.Authorization = `Bearer ${initialToken}`;
  }
} catch {}


// ─────────────────────────────────────────────────────────────
// REQUEST INTERCEPTOR
// ─────────────────────────────────────────────────────────────

api.interceptors.request.use(
  async (config) => {
    // If no remote API backend URL is provided:
    if (!CONFIGURED_API_URL && !IS_ONENEXA_DESKTOP) {
      if (import.meta.env.PROD) {
        // Production must never fake success when backend configuration is missing
        config.adapter = async (cfg) => {
          const err = new Error("Backend API URL (VITE_API_URL) is not configured in production.");
          err.response = {
            data: { error: "Backend API URL is not configured.", detail: "VITE_API_URL environment variable is required in production." },
            status: 503,
            statusText: "Service Unavailable",
            headers: {},
            config: cfg,
          };
          return Promise.reject(err);
        };
        return config;
      }

      config.adapter = async (cfg) => {
        const method = (cfg.method || "get").toLowerCase();
        const rawUrl = cfg.url || "";
        let bodyData = cfg.data;
        if (typeof bodyData === "string") {
          try {
            bodyData = JSON.parse(bodyData);
          } catch {}
        }
        const mockRes = handleMockRoute(method, rawUrl, bodyData);
        if (mockRes) {
          const validate = cfg.validateStatus || ((s) => s >= 200 && s < 300);
          if (!validate(mockRes.status || 200)) {
            const err = new Error(`Request failed with status code ${mockRes.status}`);
            err.response = {
              data: mockRes.data,
              status: mockRes.status,
              statusText: "Error",
              headers: {},
              config: cfg,
            };
            return Promise.reject(err);
          }
          return {
            data: mockRes.data,
            status: mockRes.status || 200,
            statusText: "OK",
            headers: {},
            config: cfg,
          };
        }
        const err = new Error(`Mock endpoint not implemented: ${method.toUpperCase()} ${rawUrl}`);
        err.response = {
          data: { error: `Endpoint not implemented in mock: ${rawUrl}` },
          status: 404,
          statusText: "Not Found",
          headers: {},
          config: cfg,
        };
        return Promise.reject(err);
      };
      return config;
    }

    // Normalize known collection GET endpoints.
    const [requestPath, requestQuery = ""] =
      (config.url || "").split("?");

    const normalizedRequestPath =
      requestPath.replace(/\/+$/, "");

    if (
      config.method?.toLowerCase() === "get" &&
      SLASH_COMPATIBLE_COLLECTIONS.has(
        normalizedRequestPath
      )
    ) {
      config.url =
        `${normalizedRequestPath}/` +
        `${requestQuery ? `?${requestQuery}` : ""}`;
    }

    // ─────────────────────────────────────────────────────────
    // AUTH TOKEN
    // ─────────────────────────────────────────────────────────

    const token = getToken();

    if (token && !config.headers?.Authorization && !config.headers?.authorization) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Global loading indicator.
    if (!config._silent) {
      _setLoading(1);
    }

    return config;
  },
  (error) => {
    _setLoading(-1);

    return Promise.reject(error);
  }
);

// ─────────────────────────────────────────────────────────────
// RESPONSE INTERCEPTOR
// ─────────────────────────────────────────────────────────────

api.interceptors.response.use(
  (response) => {
    if (!response.config?._silent) {
      _setLoading(-1);
    }

    _reportNetworkResult(true);

    return response;
  },

  (error) => {
    if (!error.config?._silent) {
      _setLoading(-1);
    }

    // No HTTP response = network-level problem.
    _reportNetworkResult(Boolean(error.response));

    // A second login replaces the first session. Let AuthContext show the
    // reason and perform the single coordinated logout instead of allowing
    // the generic 401 branch below to redirect silently.
    if (
      error.response?.status === 401 &&
      error.response?.data?.detail === SESSION_REPLACED_DETAIL
    ) {
      // During an intentional logout, this can only be an already-in-flight
      // request from the session that is being closed. Never convert that stale
      // response into a "signed in elsewhere" event.
      if (
        typeof window !== "undefined" &&
        window.__TASKO_LOGOUT_IN_PROGRESS__
      ) {
        return Promise.reject(error);
      }

      const failedAuthHeader =
        error.config?.headers?.Authorization ||
        error.config?.headers?.authorization ||
        "";
      const failedToken =
        String(failedAuthHeader).replace(/^Bearer\s+/i, "").trim() || null;

      try {
        const stored = typeof window !== "undefined"
          ? (sessionStorage.getItem("user") || localStorage.getItem("user"))
          : null;
        if (stored) {
          const u = JSON.parse(stored);
          if (isPlatformOwner(u)) {
            return Promise.reject(error);
          }
        }
      } catch {}

      emitSessionReplacement(failedToken);
      return Promise.reject(error);
    }

    // Offline / Mock fallback when backend server is not running or unreachable (development only)
    const isOffline =
      !import.meta.env.PROD &&
      (!error.response ||
        error.code === "ERR_NETWORK" ||
        error.message === "Network Error" ||
        (!CONFIGURED_API_URL && [404, 502, 503, 504].includes(error.response?.status)));

    if (isOffline) {
      try {
        const method = (error.config?.method || "get").toLowerCase();
        const rawUrl = error.config?.url || "";
        let bodyData = error.config?.data;
        if (typeof bodyData === "string") {
          try {
            bodyData = JSON.parse(bodyData);
          } catch {}
        }
        const mockRes = handleMockRoute(method, rawUrl, bodyData);
        if (mockRes) {
          return Promise.resolve({
            data: mockRes.data,
            status: mockRes.status || 200,
            statusText: "OK",
            headers: {},
            config: error.config,
          });
        }
      } catch (err) {
        console.warn("[MockBackend] Fallback error:", err);
      }
    }

    // ─────────────────────────────────────────────────────────
    // COLLECTION RETRY HANDLING
    // ─────────────────────────────────────────────────────────

    const requestUrl = error.config?.url || "";

    const [requestPath, requestQuery = ""] =
      requestUrl.split("?");

    const normalisedPath =
      requestPath.replace(/\/+$/, "");

    const isCollectionGet =
      error.config?.method?.toLowerCase() === "get" &&
      SLASH_COMPATIBLE_COLLECTIONS.has(
        normalisedPath
      );

    const transientStatus =
      error.response?.status === 404 ||
      error.response?.status === 502 ||
      error.response?.status === 503 ||
      error.response?.status === 504;

    // FIX: a plain 404 means "this resource/route doesn't exist" — it is NOT
    // evidence the backend is cold-starting. Only 502/503/504 (or no response
    // at all, handled elsewhere via _reportNetworkResult) are real signs the
    // server itself isn't up yet. Previously ANY 404 anywhere in the app —
    // even a harmless "task not found" — reset the single shared readiness
    // flag, which forced every other in-flight and future request across the
    // ENTIRE app (every page, not just the one that got the 404) to sit and
    // wait through the ~75s backoff sequence in ensureBackendReady() before
    // proceeding. That produced exactly the symptom of "one page loads fine,
    // then every other page goes blank for a long time with no console error."
    const isColdStartStatus =
      error.response?.status === 502 ||
      error.response?.status === 503 ||
      error.response?.status === 504;

    // Mark backend as not ready once.
    if (
      isColdStartStatus &&
      !error.config?._coldStartAttempt
    ) {
      markBackendNotReady();
    }

    // ─────────────────────────────────────────────────────────
    // RETRY COLLECTION GET
    // ─────────────────────────────────────────────────────────

    if (
      isCollectionGet &&
      transientStatus
    ) {
      const attempt =
        error.config._coldStartAttempt || 0;

      const backoffs = [
        1000,
        2000,
        3000,
        5000,
        6000,
        7000,
        8000,
        8000,
        8000,
      ];

      if (attempt < backoffs.length) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            api
              .request({
                ...error.config,

                _coldStartAttempt:
                  attempt + 1,

                // The backend already answered this request,
                // therefore don't run /health again.
                _skipReadyGate: true,
              })
              .then(resolve)
              .catch(reject);
          }, backoffs[attempt]);
        });
      }

      // ───────────────────────────────────────────────────────
      // LEGACY TRAILING-SLASH RETRY
      // ───────────────────────────────────────────────────────

      if (
        error.response?.status === 404 &&
        !error.config?._slashRetry
      ) {
        return api
          .request({
            ...error.config,

            url:
              `${normalisedPath}/` +
              `${requestQuery ? `?${requestQuery}` : ""}`,

            _slashRetry: true,

            _coldStartAttempt:
              backoffs.length,

            _skipReadyGate: true,
          })
          .catch(() =>
            Promise.resolve({
              data: [],
              status: 200,
              statusText:
                "OK (empty — collection endpoint unavailable)",
              headers:
                error.response?.headers || {},
              config: error.config,
              _degraded: true,
            })
          );
      }

      // ───────────────────────────────────────────────────────
      // DEGRADED EMPTY COLLECTION
      // ───────────────────────────────────────────────────────

      return Promise.resolve({
        data: [],
        status: 200,
        statusText:
          "OK (empty — collection endpoint unavailable)",
        headers:
          error.response?.headers || {},
        config: error.config,
        _degraded: true,
      });
    }

    // ─────────────────────────────────────────────────────────
    // 401 — AUTHENTICATION
    // ─────────────────────────────────────────────────────────

    // Ignore stale 401/403 responses from requests that were already in
    // flight when the user intentionally logged out.
    if (
      typeof window !== "undefined" &&
      window.__TASKO_LOGOUT_IN_PROGRESS__ &&
      [401, 403].includes(error.response?.status)
    ) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401) {
      const authHeader =
        error.config?.headers?.Authorization ||
        error.config?.headers?.authorization ||
        "";
      const failedToken = String(authHeader).replace(/^Bearer\\s+/i, "").trim() || null;

      // An expired device-local token must not invalidate the separate cloud login.
      if (failedToken?.startsWith("onenexa-local.")) return Promise.reject(error);

      clearToken(failedToken);
      sessionStorage.removeItem("user");

      try {
        if (failedToken && localStorage.getItem(TOKEN_KEY) === failedToken) {
          localStorage.removeItem("user");
          localStorage.removeItem("session_token");
        }
      } catch {}

      if (
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
        window.location.href = "/login";
      }
    }

    // ─────────────────────────────────────────────────────────
    // 403 — PERMISSION DENIED
    // ─────────────────────────────────────────────────────────

    if (error.response?.status === 403) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("permission-denied")
        );
      }
    }

    // ─────────────────────────────────────────────────────────
    // 422 — VALIDATION ERROR
    // ─────────────────────────────────────────────────────────

    if (error.response?.status === 422) {
      const detail =
        error.response.data?.detail;

      if (Array.isArray(detail)) {
        const msg = detail
          .map((e) => {
            const field =
              e.loc?.slice(-1)[0] || "field";

            return `${field}: ${e.msg}`;
          })
          .join(" · ");

        error.response.data._normalised = msg;
      }
    }

    return Promise.reject(error);
  }
);

// ─────────────────────────────────────────────────────────────
// SILENT GET
// ─────────────────────────────────────────────────────────────

export const silentGet = (
  url,
  config = {}
) =>
  api.get(url, {
    ...config,
    _silent: true,
  });

// ─────────────────────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────────────────────

export const upload = (
  url,
  formData,
  config = {}
) =>
  api.post(url, formData, {
    ...config,
    headers: {
      "Content-Type": "multipart/form-data",
      ...config.headers,
    },
  });

// ─────────────────────────────────────────────────────────────
// DEDUPLICATED GET
// ─────────────────────────────────────────────────────────────

export const deduplicatedGet = (
  url,
  config = {}
) => {
  const key =
    url +
    (
      config.params
        ? JSON.stringify(config.params)
        : ""
    );

  if (_inflight.has(key)) {
    return _inflight.get(key);
  }

  const promise = api
    .get(url, config)
    .finally(() => {
      setTimeout(() => {
        _inflight.delete(key);
      }, DEDUP_WINDOW_MS);
    });

  _inflight.set(key, promise);

  return promise;
};

// ─────────────────────────────────────────────────────────────
// PARALLEL GET
// ─────────────────────────────────────────────────────────────

export const parallelGet = async (
  urlMap,
  config = {}
) => {
  const keys = Object.keys(urlMap);

  const results =
    await Promise.allSettled(
      keys.map((key) =>
        deduplicatedGet(
          urlMap[key],
          config
        )
      )
    );

  return Object.fromEntries(
    keys.map((key, index) => [
      key,
      results[index].status === "fulfilled"
        ? results[index].value
        : null,
    ])
  );
};

// ─────────────────────────────────────────────────────────────
// ERROR FORMATTER
// ─────────────────────────────────────────────────────────────

export function getErrorMessage(error) {
  if (!error) {
    return "An unknown error occurred";
  }

  const data = error.response?.data;

  if (!data) {
    return error.message || "Network error";
  }

  if (data._normalised) {
    return data._normalised;
  }

  if (typeof data.detail === "string") {
    return data.detail;
  }

  if (Array.isArray(data.detail)) {
    return data.detail
      .map((e) => e.msg)
      .join(", ");
  }

  if (typeof data.message === "string") {
    return data.message;
  }

  return "Request failed";
}

// ─────────────────────────────────────────────────────────────
// UNIVERSAL TRANSPARENT OFFLINE INTERCEPTOR
// ─────────────────────────────────────────────────────────────

attachOfflineInterceptor(api);

export { offlineStore };

// ─────────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────────

export default api;

