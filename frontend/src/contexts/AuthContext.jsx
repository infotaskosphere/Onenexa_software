import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import api from "../lib/api";
import { autoAuthenticateAgent, resetAgentAuth } from "../lib/agentAutoAuth";
import { isPlatformOwner as matrixIsPlatformOwner, hasEffectivePermission } from "../lib/commercialPermissionMatrix";
import { toast } from "sonner";

const AuthContext = createContext(null);
export const useAuth = () => { const context = useContext(AuthContext); if (!context) throw new Error("useAuth must be used within an AuthProvider"); return context; };
const isKeepSignedIn = () => localStorage.getItem('taskosphere_keep_signed_in') === 'true';
const PLATFORM_OWNER_EMAIL = "info.taskosphere@gmail.com";
const COMMERCIAL_MODULE_FLAGS = new Set(["can_access_taskosphere", "can_access_finix", "can_access_compliance", "can_access_records", "can_access_proposals", "can_access_people_matrix"]);
const MODULE_FLAG_TO_KEYS = {
  can_access_taskosphere: ["taskosphere", "tasks"],
  can_access_finix: ["finix", "invoicing", "accounting"],
  can_access_compliance: ["compliance"],
  can_access_records: ["records"],
  can_access_proposals: ["proposals", "client_proposals", "client-proposals"],
  can_access_people_matrix: ["people_matrix", "people-matrix", "hrms", "peoplematrix"],
};

// Company-scoped UI caches (Finix dashboard company list / metrics, last selected
// company) are NOT keyed by user. If they survive a logout, the next person who
// signs in on the same tab/browser inherits the previous user's company ids, sends
// them to the API, and gets 403 "Cross-company access is not permitted" on every
// report. Purge them whenever the session identity changes.
const purgeCompanyScopedCaches = () => {
  try {
    Object.keys(sessionStorage).forEach((key) => {
      if (key.startsWith("finix:")) sessionStorage.removeItem(key);
    });
    localStorage.removeItem("accountingReports:lastCompanyId");
  } catch {}
  try { window.dispatchEvent(new CustomEvent("company-scoped-caches-purged")); } catch {}
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const authGenerationRef = useRef(0);
  const normalizePermissions = (permissions) => permissions && typeof permissions === "object" && !Array.isArray(permissions) ? permissions : {};
  const normalizeTenantContext = (userData) => {
    if (!userData || typeof userData !== "object") return userData;
    const licensedModules = [
      userData.licensed_modules,
      userData.modules,
      userData.company?.licensed_modules,
      userData.company?.modules,
      userData.subscription?.modules,
      userData.license?.modules,
    ].find((value) => Array.isArray(value) && value.length > 0) || null;
    return {
      ...userData,
      permissions: normalizePermissions(userData.permissions),
      licensed_modules: licensedModules,
      company_id: userData.company_id ? String(userData.company_id) : null,
      company: userData.company || null,
      subscription: userData.subscription || null,
    };
  };
  const getStoredAuth = () => ({
    token: sessionStorage.getItem("token") || localStorage.getItem("token"),
    storedUser: sessionStorage.getItem("user") || localStorage.getItem("user"),
    sessionToken: sessionStorage.getItem("session_token") || localStorage.getItem("session_token"),
  });
  const persistAuth = (token, userData, rememberMe = false, sessionToken = null) => {
    const normalizedUser = normalizeTenantContext(userData);
    const serializedUser = JSON.stringify(normalizedUser);

    // Every browser tab owns its live auth state in sessionStorage. localStorage
    // is only a durable fallback for browser restart.
    sessionStorage.setItem("token", token);
    sessionStorage.setItem("user", serializedUser);
    if (sessionToken) sessionStorage.setItem("session_token", sessionToken);

    if (rememberMe) {
      localStorage.setItem("token", token);
      localStorage.setItem("user", serializedUser);
      if (sessionToken) localStorage.setItem("session_token", sessionToken);
    }

    // Scope single-session signalling to the concrete user identity so a
    // different account logging in/out in another tab cannot affect this tab.
    if (sessionToken && !matrixIsPlatformOwner(normalizedUser)) {
      const userId = String(normalizedUser?.id || "").trim();
      if (userId) {
        localStorage.setItem("taskosphere_active_session_token:" + userId, sessionToken);
      }
    }

    api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  };
  const clearStorage = (ownedToken = null, ownedUserId = null) => {
    ["token", "user", "session_token"].forEach((key) => sessionStorage.removeItem(key));

    // localStorage is shared across tabs. Remove its auth copy only if it is
    // the exact token owned by this tab/user.
    try {
      const localToken = localStorage.getItem("token");
      if (ownedToken && localToken === ownedToken) {
        ["token", "user", "session_token"].forEach((key) => localStorage.removeItem(key));
      }
    } catch {}

    if (ownedUserId) {
      try {
        localStorage.removeItem(
          "taskosphere_active_session_token:" + String(ownedUserId).trim()
        );
      } catch {}
    }

    try {
      if (
        ownedToken &&
        localStorage.getItem("taskosphere_active_session_token") === ownedToken
      ) {
        localStorage.removeItem("taskosphere_active_session_token");
        localStorage.removeItem("taskosphere_active_session_email");
      }
    } catch {}

    localStorage.removeItem("taskosphere_tab_closed");
    purgeCompanyScopedCaches();
    delete api.defaults.headers.common["Authorization"];
  };
  const INACTIVITY_LIMIT_MS = 6 * 60 * 60 * 1000;
  const LAST_ACTIVE_KEY = 'taskosphere_last_active';

  const isPlatformOwnerAccount = useCallback((targetUser = user) => {
    if (matrixIsPlatformOwner(targetUser)) return true;
    let fallbackUser = targetUser;
    if (!fallbackUser && typeof window !== "undefined") {
      try {
        const storedStr = localStorage.getItem("user") || sessionStorage.getItem("user");
        if (storedStr) {
          fallbackUser = JSON.parse(storedStr);
        }
      } catch {}
    }
    return matrixIsPlatformOwner(fallbackUser);
  }, [user]);

  const forceLogoutForReplacement = useCallback(() => {
    if (isPlatformOwnerAccount(user)) return;
    if (window.__TASKO_SESSION_REPLACEMENT_LOGGED_OUT__) return;
    window.__TASKO_SESSION_REPLACEMENT_LOGGED_OUT__ = true;
    authGenerationRef.current += 1;
    const ownedToken = sessionStorage.getItem("token") || localStorage.getItem("token");
    const ownedUserId = String(user?.id || "").trim();
    clearStorage(ownedToken, ownedUserId);
    resetAgentAuth();
    window.__STOP_ACTIVITY__ = true;
    setUser(null);

    // Use the application's toast system instead of window.alert. The native
    // alert can be suppressed during rapid navigation/auth cleanup, while the
    // Sonner notification remains visible in the application shell.
    try {
      toast.error("You have been logged out", {
        description:
          "This account was signed in on another device or browser. Only one active login is allowed.",
        duration: 7000,
      });
    } catch {}

    if (window.location.pathname !== "/login") {
      setTimeout(() => window.location.replace("/login"), 250);
    }
  }, [user, isPlatformOwnerAccount]);

  useEffect(() => {
    const handleSessionReplacement = (event) => {
      if (isPlatformOwnerAccount(user)) return;
      if (window.__TASKO_LOGOUT_IN_PROGRESS__) return;

      // Only the session whose bearer token actually received SESSION_REPLACED
      // may be logged out. A stale request belonging to a previous account in
      // this tab must never terminate the newly authenticated account.
      const eventToken = event?.detail?.failedToken || null;
      const currentToken =
        sessionStorage.getItem("token") ||
        localStorage.getItem("token") ||
        null;
      if (eventToken && currentToken && eventToken !== currentToken) return;

      forceLogoutForReplacement();
    };
    window.addEventListener("taskosphere:session-replaced", handleSessionReplacement);
    return () => window.removeEventListener("taskosphere:session-replaced", handleSessionReplacement);
  }, [forceLogoutForReplacement, user, isPlatformOwnerAccount]);

  useEffect(() => {
    if (!user) return undefined;
    if (isPlatformOwnerAccount(user)) return undefined;
    let cancelled = false;
    let sessionCheckInFlight = false;
    const checkCurrentSession = async () => {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token");
      if (!token || cancelled || window.__TASKO_LOGOUT_IN_PROGRESS__ || sessionCheckInFlight) return;
      sessionCheckInFlight = true;
      try {
        const response = await api.get("/auth/me", { _silent: true, _skipReadyGate: true });
        if (cancelled || window.__TASKO_LOGOUT_IN_PROGRESS__) return;
        const freshUser = normalizeTenantContext(response?.data);
        if (!freshUser || String(freshUser?.id || "") !== String(user?.id || "")) return;

        const permissionsChanged =
          JSON.stringify(freshUser?.permissions || {}) !== JSON.stringify(user?.permissions || {});
        const licenseContextChanged =
          JSON.stringify(freshUser?.licensed_modules || []) !== JSON.stringify(user?.licensed_modules || []) ||
          JSON.stringify(freshUser?.selected_features || {}) !== JSON.stringify(user?.selected_features || {}) ||
          String(freshUser?.license_id || "") !== String(user?.license_id || "");

        if (!permissionsChanged && !licenseContextChanged) return;

        const storage = sessionStorage.getItem("token") ? sessionStorage : localStorage;
        storage.setItem("user", JSON.stringify(freshUser));
        setUser(freshUser);

        // Let route/layout consumers react immediately to a permission change
        // without requiring logout/login or a full page reload.
        try {
          window.dispatchEvent(new CustomEvent("taskosphere:permissions-refreshed", {
            detail: { user: freshUser }
          }));
        } catch {}
      } catch (error) {
        if (cancelled) return;
      } finally {
        sessionCheckInFlight = false;
      }
    };
    // Permission changes are security-sensitive; keep the active session
    // synchronized without hammering the backend every few seconds. A
    // visibility-change check still runs immediately when the user returns.
    const interval = setInterval(checkCurrentSession, 60 * 1000);
    const handleVisibility = () => { if (document.visibilityState === "visible") checkCurrentSession(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", handleVisibility); };
  }, [user, forceLogoutForReplacement, isPlatformOwnerAccount]);

  useEffect(() => {
    const handleStorageChange = (e) => {
      if (isPlatformOwnerAccount(user)) return;
      const myUserId = String(user?.id || "").trim();
      const scopedKey = myUserId
        ? "taskosphere_active_session_token:" + myUserId
        : "";
      if (scopedKey && e.key === scopedKey) {
        const newSession = e.newValue;
        const currentSession =
          sessionStorage.getItem("session_token") ||
          localStorage.getItem("session_token");
        if (newSession && currentSession && newSession !== currentSession) {
          forceLogoutForReplacement();
        }
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [user, forceLogoutForReplacement, isPlatformOwnerAccount]);

  useEffect(() => { const handleBeforeUnload = () => { if (!isKeepSignedIn() && localStorage.getItem('token')) localStorage.setItem('taskosphere_tab_closed', Date.now().toString()); }; window.addEventListener('beforeunload', handleBeforeUnload); return () => window.removeEventListener('beforeunload', handleBeforeUnload); }, []);
  useEffect(() => { if (!user || isKeepSignedIn()) return; const updateActivity = () => localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString()); const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']; events.forEach(e => window.addEventListener(e, updateActivity, { passive: true })); updateActivity(); const interval = setInterval(() => { const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10); if (Date.now() - lastActive > INACTIVITY_LIMIT_MS) logout(); }, 60 * 1000); return () => { events.forEach(e => window.removeEventListener(e, updateActivity)); clearInterval(interval); }; }, [user]);

  const isPlatformOwner = isPlatformOwnerAccount(user);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const isLicensedCustomer = !!user?.company_id && !isPlatformOwner;
    document.body.classList.toggle("licensed-customer-session", isLicensedCustomer);
    const isCommercialPath = () => window.location.pathname === "/master-console" || window.location.pathname.startsWith("/master-console/");
    const redirectIfBlocked = () => { if (!isLicensedCustomer || !isCommercialPath()) return; window.history.replaceState({}, "", "/dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); };
    const handleClick = (event) => { if (!isLicensedCustomer) return; const target = event.target?.closest?.("a[href]"); const href = target?.getAttribute("href") || ""; if (!href.startsWith("/master-console")) return; event.preventDefault(); event.stopPropagation(); window.history.replaceState({}, "", "/dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); };
    redirectIfBlocked(); document.addEventListener("click", handleClick, true); window.addEventListener("popstate", redirectIfBlocked);
    return () => { document.body.classList.remove("licensed-customer-session"); document.removeEventListener("click", handleClick, true); window.removeEventListener("popstate", redirectIfBlocked); };
  }, [user, isPlatformOwner]);

  useEffect(() => {
    let cancelled = false;
    const restoreSession = async () => {
      const { token, storedUser } = getStoredAuth();
      const generation = authGenerationRef.current;
      if (!token || !storedUser) { setLoading(false); return; }
      const navType = window.performance?.getEntriesByType?.('navigation')?.[0]?.type ?? (window.performance?.navigation?.type === 1 ? 'reload' : 'navigate');
      const isReload = navType === 'reload'; const tabClosedAt = localStorage.getItem('taskosphere_tab_closed');
      if (tabClosedAt && localStorage.getItem('token')) { localStorage.removeItem('taskosphere_tab_closed'); if (!isKeepSignedIn() && !isReload) { clearStorage(); setLoading(false); return; } }
      try {
        api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
        const meRes = await api.get("/auth/me");
        if (cancelled || generation !== authGenerationRef.current || window.__TASKO_LOGOUT_IN_PROGRESS__) return;
        const currentToken = sessionStorage.getItem("token") || localStorage.getItem("token");
        if (currentToken !== token) return;
        const freshUser = normalizeTenantContext(meRes.data);
        const storage = sessionStorage.getItem("token") ? sessionStorage : localStorage;
        storage.setItem("user", JSON.stringify(freshUser));
        setUser(freshUser);
        autoAuthenticateAgent(token, freshUser.id).catch(() => {});
      }
      catch (error) {
        if (cancelled || generation !== authGenerationRef.current || window.__TASKO_LOGOUT_IN_PROGRESS__) return;
        if (error.message === "Network Error") setUser(normalizeTenantContext(JSON.parse(storedUser)));
        else if (error.response && [401, 403].includes(error.response.status)) {
          const ownedUserId = JSON.parse(storedUser || "{}")?.id || "";
          clearStorage(token, ownedUserId);
          setUser(null);
        }
        else console.error("Session restore error:", error);
      }
      finally { if (!cancelled) setLoading(false); }
    };
    restoreSession();
    return () => { cancelled = true; };
  }, []);

  const login = (responseData, rememberMe = false) => { const token = responseData?.access_token || responseData?.token; const userData = responseData?.user || responseData?.data?.user; const sessionToken = responseData?.session_token || responseData?.data?.session_token || null; if (!token || !userData) { console.error("Invalid login response:", responseData); return false; } const normalizedUser = normalizeTenantContext(userData); purgeCompanyScopedCaches(); authGenerationRef.current += 1; window.__TASKO_SESSION_REPLACEMENT_LOGGED_OUT__ = false; window.__TASKO_LOGOUT_IN_PROGRESS__ = false; persistAuth(token, normalizedUser, rememberMe, sessionToken); setUser(normalizedUser); window.__STOP_ACTIVITY__ = false; autoAuthenticateAgent(token, normalizedUser.id).catch(() => {}); return true; };
  const logout = async () => {
    const token = sessionStorage.getItem("token") || localStorage.getItem("token");
    const sessionToken = sessionStorage.getItem("session_token") || localStorage.getItem("session_token");
    const ownedUserId = String(user?.id || "").trim();
    authGenerationRef.current += 1;
    window.__TASKO_LOGOUT_IN_PROGRESS__ = true;
    window.__STOP_ACTIVITY__ = true;
    resetAgentAuth();

    // Invalidate the client session before the server revoke so protected
    // components unmount immediately and stale auth responses cannot restore it.
    clearStorage(token, ownedUserId);
    setUser(null);

    try {
      if (sessionToken) {
        await api.post(
          "/auth/logout",
          { session_token: sessionToken },
          {
            _silent: true,
            _skipReadyGate: true,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          }
        );
      }
    } catch (error) {
      console.warn("Session revoke on logout failed (non-fatal).", error);
    }
  };
  const refreshUser = useCallback(async (overrideUser = null) => {
    const generation = authGenerationRef.current;
    try {
      if (overrideUser && typeof overrideUser === "object" && (overrideUser.id || overrideUser.email)) {
        const optimisticUser = normalizeTenantContext(overrideUser);
        const storage = localStorage.getItem("token") ? localStorage : sessionStorage;
        storage.setItem("user", JSON.stringify(optimisticUser));
        setUser(optimisticUser);
      }
      const response = await api.get("/auth/me");
      if (generation !== authGenerationRef.current || window.__TASKO_LOGOUT_IN_PROGRESS__) return null;
      const currentToken = localStorage.getItem("token") || sessionStorage.getItem("token");
      if (!currentToken) return null;
      const updatedUser = normalizeTenantContext(response.data);
      const storage = localStorage.getItem("token") ? localStorage : sessionStorage;
      storage.setItem("user", JSON.stringify(updatedUser));
      setUser(updatedUser);
      return updatedUser;
    } catch (error) { console.error("Failed to refresh user:", error); }
  }, []);

  const getLicensedModules = useCallback((candidate = user) => {
    const raw = [
      candidate?.licensed_modules,
      candidate?.modules,
      candidate?.company?.licensed_modules,
      candidate?.company?.modules,
      candidate?.subscription?.modules,
      candidate?.license?.modules,
    ].find((value) => Array.isArray(value) && value.length > 0);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((m) => String(m).trim().toLowerCase().replace(/-/g, "_"));
    }
    return null;
  }, [user]);

  useEffect(() => {
    const handleLicenseUpdated = (event) => {
      const updatedLicense = event?.detail?.license;
      if (updatedLicense) {
        setUser((prev) => {
          if (!prev) return prev;
          const modules = updatedLicense.modules || updatedLicense.licensed_modules || [];
          const normModules = modules.map((m) => String(m).toLowerCase().replace(/-/g, "_"));
          const nextUser = {
            ...prev,
            licensed_modules: modules,
            selected_features: updatedLicense.selected_features || prev.selected_features || {},
            // Do not synthesize Manager/Staff permissions from the license
            // event. The server remains the source of truth for the Permission
            // Matrix; refreshUser() below fetches the effective grants.
            permissions: prev.permissions || {},
          };
          const storage = localStorage.getItem("token") ? localStorage : sessionStorage;
          storage.setItem("user", JSON.stringify(nextUser));
          return nextUser;
        });
      }
      refreshUser();
    };
    window.addEventListener("license-updated", handleLicenseUpdated);
    window.addEventListener("commercial-license-updated", handleLicenseUpdated);
    return () => {
      window.removeEventListener("license-updated", handleLicenseUpdated);
      window.removeEventListener("commercial-license-updated", handleLicenseUpdated);
    };
  }, [refreshUser]);

  const isCommercialAdmin = (candidate = user) => String(candidate?.role || "").toLowerCase() === "admin" && !!candidate?.company_id && String(candidate?.email || "").trim().toLowerCase() !== PLATFORM_OWNER_EMAIL;
  const hasPermission = (permission) => {
    if (!user) return false;
    return hasEffectivePermission(user, permission);
  };
  const hasAnyPermission = (...permissionList) => permissionList.some((permission) => hasPermission(permission));
  const canAccessUser = (permissionKey, targetUserId) => {
    if (!user) return false;
    if (isPlatformOwner || isCommercialAdmin(user)) return true;
    if (user.role?.toLowerCase() === "admin") return true;
    const allowedIds = (user.permissions || {})[permissionKey];
    return Array.isArray(allowedIds) && allowedIds.includes(targetUserId);
  };
  const isOwner = (ownerId) => !!user && ownerId === user.id;
  return <AuthContext.Provider value={{ user, loading, company: user?.company || null, companyId: user?.company_id || null, subscription: user?.subscription || null, login, logout, refreshUser, hasPermission, hasAnyPermission, canAccessUser, isOwner, isPlatformOwner }}>{children}</AuthContext.Provider>;
};