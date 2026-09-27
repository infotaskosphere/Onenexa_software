import axios from "axios";
import api, { getToken, BASE_URL } from "@/lib/api";
import { handleMockRoute } from "@/lib/mockBackend";

export const DEFAULT_PACKAGES = [
  { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", description: "Legacy Task Management + Invoicing", modules: ["TASKS", "INVOICING"], max_users: 10, max_installations: 1, validity_days: 365, price: 0, active: true },
  { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", description: "Legacy Task Management + Invoicing + HRMS", modules: ["TASKS", "INVOICING", "HRMS"], max_users: 25, max_installations: 2, validity_days: 365, price: 0, active: true },
  { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", description: "Legacy Task Management + Invoicing + Accounting + HRMS", modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"], max_users: 100, max_installations: 5, validity_days: 365, price: 0, active: true },
];

const licensingApi = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

licensingApi.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (!import.meta.env.VITE_API_URL) {
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
        return {
          data: mockRes.data,
          status: mockRes.status || 200,
          statusText: "OK",
          headers: {},
          config: cfg,
        };
      }
      return {
        data: method === "get" ? [] : { success: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config: cfg,
      };
    };
  }
  return config;
});

licensingApi.interceptors.response.use(
  (res) => res,
  (error) => {
    const isOffline =
      !error.response ||
      error.code === "ERR_NETWORK" ||
      error.message === "Network Error" ||
      (!import.meta.env.VITE_API_URL && [404, 502, 503, 504].includes(error.response?.status));

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
        console.warn("[MockBackend] Licensing fallback error:", err);
      }
    }
    return Promise.reject(error);
  }
);

export const getLicenseState = async () => (await licensingApi.get("/licensing/state")).data;
export const createLicense = async (input) => (await licensingApi.post("/licensing/licenses", input)).data;
export const generateCommercialLicense = async (input) => (await licensingApi.post("/commercial-onboarding/generate-license", input)).data;
export const updateLicenseStatus = async (id, status) => (await licensingApi.patch(`/licensing/licenses/${id}/status`, { status })).data;
export const deleteCommercialCompany = async (licenseId) => (await licensingApi.delete(`/commercial-onboarding/licenses/${encodeURIComponent(licenseId)}/company`)).data;
export const upgradeLicense = async (id, packageId) => (await licensingApi.patch(`/licensing/licenses/${id}/package`, { package_id: packageId })).data;
export const savePackage = async (pkg) => (await licensingApi.put(`/licensing/packages/${pkg.id}`, pkg)).data;
export const getCommercialModuleCatalog = async () => {
  const res = (await licensingApi.get("/commercial-onboarding/module-catalog")).data;
  return Array.isArray(res) ? res : (res?.modules || []);
};
export const updateCommercialModulePrice = async (moduleId, monthlyPrice, active = true, featurePrices = undefined) => {
  const payload = { monthly_price: monthlyPrice, active };
  if (featurePrices !== undefined) payload.feature_prices = featurePrices;
  return (await licensingApi.put(`/commercial-onboarding/module-catalog/${moduleId}`, payload)).data;
};
export const updateCommercialCustomer = async (customerId, payload) => (await licensingApi.put(`/commercial-master-data/customers/${encodeURIComponent(customerId)}`, payload)).data;
export const updateCommercialLicense = async (licenseId, payload) => (await licensingApi.put(`/commercial-master-data/licenses/${encodeURIComponent(licenseId)}`, payload)).data;

export const lookupLicensedCompany = async (companyName, licenseKey) => (await licensingApi.post("/commercial-onboarding/lookup", { company_name: companyName, license_key: licenseKey })).data;
export const createLicensedAdmin = async (payload) => (await licensingApi.post("/commercial-onboarding/create-admin", payload)).data;
export const verifyLicensedCompany = async (companyName) => (await licensingApi.post("/commercial-onboarding/verify-company", { company_name: companyName })).data;
export const createLicensedUser = async (payload) => (await licensingApi.post("/commercial-onboarding/create-user", payload)).data;
export const createLicensedStaff = async (payload) => (await licensingApi.post("/commercial-onboarding/create-staff", payload)).data;
export const getMyLicensedCompany = async () => (await licensingApi.get("/commercial-onboarding/my-company")).data;

export const activateLicense = async (licenseKey, installationId, installationName) => {
  const response = await api.post("/licensing/installation-activate", { license_key: licenseKey, installation_id: installationId, installation_name: installationName });
  return response.data;
};
export const validateLicense = async (licenseKey) => (await licensingApi.post("/licensing/validate", { license_key: licenseKey })).data;
export const getLocalLicenseStatus = async () => (await api.get("/licensing/status")).data;
export const heartbeatLicense = async (licenseKey, installationId) => (await licensingApi.post("/licensing/heartbeat", { license_key: licenseKey, installation_id: installationId })).data;
export const revokeInstallation = async (licenseId, installationId) => (await licensingApi.post(`/licensing/licenses/${licenseId}/installations/${encodeURIComponent(installationId)}/revoke`)).data;

export const subscribeLicenseState = (callback) => {
  let cancelled = false;
  const refresh = async () => { try { const state = await getLicenseState(); if (!cancelled) callback(state); } catch { /* keep last known state */ } };
  refresh();
  const timer = window.setInterval(refresh, 30000);
  return () => { cancelled = true; window.clearInterval(timer); };
};
