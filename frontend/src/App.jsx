import React, { Suspense, memo, useEffect } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "@/components/ui/sonner";
import AppRoutes from "./AppRoutes.jsx";
import { useLoading } from "./lib/api";
import GifLoader from "@/components/ui/GifLoader.jsx";
import ReminderPopupManager from "@/components/layout/ReminderPopupManager.jsx";
import { BulkWASenderProvider } from "@/contexts/BulkWASenderContext";
import BulkWASenderWidget from "@/contexts/BulkWASenderWidget";
import { MinimizedFormsProvider } from "@/contexts/MinimizedFormsContext";
import MinimizedFormsDock from "@/components/layout/MinimizedFormsDock";
import { DocumentUploadProvider } from "@/contexts/DocumentUploadContext.jsx";
import { ROCDumpUploadProvider } from "@/contexts/ROCDumpUploadContext.jsx";
import ROCDumpUploadDock from "@/components/layout/ROCDumpUploadDock.jsx";
import "./commercial-business-ui.css";
import "./email-google-oauth.css";
import "./module-branding.css";
import "./module-branding.js";
import "./header-tabs-canonical.css";
import "./ui-layout-fixes.css";
import "./module-switcher-commercial.css";

const BottomLoadingBar = memo(function BottomLoadingBar() {
  const loading = useLoading();
  if (!loading) return null;
  return <div className="taskosphere-loading-bar" style={{ position: "fixed", bottom: 0, left: 0, width: "30%", height: 3, background: "linear-gradient(90deg, #7F77DD, #1F6FB2)", zIndex: 9999, pointerEvents: "none" }} />;
});

const ROUTE_PREFETCHERS = {
  "/dashboard": () => import("./pages/Dashboard.jsx"),
  "/tasks": () => import("./pages/Tasks.jsx"),
  "/todos": () => import("./pages/TodoDashboard.jsx"),
  "/attendance": () => import("./pages/Attendance.jsx"),
  "/reminders": () => import("./pages/Reminders.jsx"),
  "/action-center": () => import("./pages/ActionCenter.jsx"),
  "/compliance-dashboard": () => import("./pages/ComplianceDashboard.jsx"),
  "/compliance": () => import("./pages/CompliancePage.jsx"),
  "/gst-reconciliation": () => import("./pages/GSTReconciliation.jsx"),
  "/trademark-sphere": () => import("./pages/TrademarkSphere.jsx"),
  "/roc-sphere": () => import("./pages/ROCSpherePage.jsx"),
  "/records-dashboard": () => import("./pages/RecordsDashboard.jsx"),
  "/clients": () => import("./pages/Clients.jsx"),
  "/clients-local": () => import("./pages/LocalFirstClients.jsx"),
  "/client-proposals-dashboard": () => import("./pages/ClientProposalsDashboard.jsx"),
  "/leads": () => import("./pages/Leads.jsx"),
  "/quotations": () => import("./pages/Quotations.jsx"),
  "/finix-dashboard": () => import("./pages/FinixDashboard.jsx"),
  "/invoicing": () => import("./pages/Invoicing.jsx"),
  "/bank-accounts": () => import("./pages/BankAccounts.jsx"),
  "/accounting-reports": () => import("./pages/AccountingReports.jsx"),
  "/people-matrix": () => import("./pages/PeopleMatrixDashboard.jsx"),
  "/reports": () => import("./pages/Reports.jsx"),
  "/users": () => import("./pages/Users.jsx"),
  "/master-console": () => import("./pages/MasterConsole.jsx"),
  "/automation/approvals": () => import("@/components/PendingApprovalsPanel.jsx"),
  "/activate-license": () => import("./pages/LicenseActivation.jsx"),
};

const prefetchedRoutes = new Set();
function prefetchRoute(path) {
  if (prefetchedRoutes.has(path)) return;
  const loader = ROUTE_PREFETCHERS[path];
  if (!loader) return;
  prefetchedRoutes.add(path);
  try {
    const promise = loader();
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => { prefetchedRoutes.delete(path); });
    }
  } catch (err) {
    prefetchedRoutes.delete(path);
  }
}

function RoutePrefetcher() {
  useEffect(() => {
    const warm = (event) => {
      const target = event.target?.closest?.("a[href]");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || !href.startsWith("/")) return;
      prefetchRoute(href.split("?")[0].split("#")[0]);
    };
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("focusin", warm);
    return () => {
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("focusin", warm);
    };
  }, []);
  return null;
}

const BUSINESS_PAGE_TITLES = {
  "/compliance-dashboard": "CompliGenie Dashboard", "/tasks": "Tasks", "/todos": "To Do", "/attendance": "Attendance", "/reminders": "Reminders", "/action-center": "Action Center", "/visits": "Client Visits", "/aiweave": "AIWeave",
  "/compliance": "Compliance Tracker", "/gst-reconciliation": "GST Sphere", "/gst-sphere": "GST Sphere", "/trademark-sphere": "Trademark Sphere", "/roc-sphere": "ROC Sphere", "/mis-report": "MIS Report", "/salary-slips": "Salary Slip Generator",
  "/records-dashboard": "Records Dashboard", "/client-approvals": "Client Approvals", "/dsc": "DSC Register", "/documents": "Document Register", "/clients": "Clients", "/passwords": "Password Vault",
  "/client-proposals-dashboard": "LeadSense Dashboard", "/leads": "Lead Management", "/quotations": "Quotations", "/finix-dashboard": "Finix", "/invoicing": "Sales & Invoicing", "/purchase": "Purchase", "/bank-accounts": "Bank Accounts", "/chart-of-accounts": "Chart of Accounts", "/journal-entries": "Journal Entries", "/accounting-reports": "Accounting Reports",
  "/people-matrix": "People Matrix", "/users": "Users", "/leave": "Leave", "/payroll": "Payroll", "/hr": "Human Resources", "/recruitment": "Recruitment", "/reports": "Reports", "/settings/general": "General Settings", "/settings/email": "Email Accounts", "/settings/whatsapp": "Message Automation", "/settings/backup": "Backup & Restore", "/admin-dashboard": "Admin Dashboard", "/permission-matrix": "Permission Matrix", "/master-data": "Master Data", "/roles": "Roles & Access", "/contact-details": "Contact Details", "/master-console": "Commercial Console", "/master-console/website": "Website Studio", "/automation/approvals": "Automation Approvals",
};

const BUSINESS_LANDING_PATHS = new Set(["/dashboard", "/finix-dashboard", "/compliance-dashboard", "/records-dashboard", "/client-proposals-dashboard", "/people-matrix", "/admin-dashboard", "/master-console"]);

function BusinessPageDesignScope() {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    const title = BUSINESS_PAGE_TITLES[path] || Object.entries(BUSINESS_PAGE_TITLES).sort((a, b) => b[0].length - a[0].length).find(([prefix]) => path.startsWith(`${prefix}/`))?.[1] || path.split("/").filter(Boolean).pop()?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Business Workspace";
    document.documentElement.style.setProperty("--business-page-title", JSON.stringify(title));
    document.body.dataset.businessRoute = path;
    document.body.classList.toggle("biz-dashboard-home", BUSINESS_LANDING_PATHS.has(path));
    document.body.classList.toggle("biz-section-landing", /^(\/finix-dashboard|\/compliance-dashboard|\/records-dashboard|\/client-proposals-dashboard|\/people-matrix)$/.test(path));
    document.body.classList.toggle("biz-master-console", path === "/master-console");
    return () => {
      document.body.classList.remove("biz-dashboard-home", "biz-section-landing", "biz-master-console");
      delete document.body.dataset.businessRoute;
    };
  }, [location.pathname]);
  return null;
}

function WebsiteSurfaceScope() {
  const location = useLocation();
  useEffect(() => {
    const isWebsite = location.pathname === "/" || location.pathname === "/website";
    const isBuilder = location.pathname.startsWith("/master-console/website");
    document.body.classList.toggle("website-surface", isWebsite || isBuilder);
    document.body.classList.toggle("website-builder-surface", isBuilder);
    return () => document.body.classList.remove("website-surface", "website-builder-surface");
  }, [location.pathname]);
  return null;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000, retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: false } } });

export default function App() {
  return <QueryClientProvider client={queryClient}><AuthProvider><BrowserRouter><WebsiteSurfaceScope /><BusinessPageDesignScope /><MinimizedFormsProvider><BulkWASenderProvider><ROCDumpUploadProvider><DocumentUploadProvider><BottomLoadingBar /><RoutePrefetcher /><ReminderPopupManager /><BulkWASenderWidget /><MinimizedFormsDock /><ROCDumpUploadDock /><Suspense fallback={<GifLoader />}><AppRoutes /></Suspense><Toaster position="top-right" richColors /></DocumentUploadProvider></ROCDumpUploadProvider></BulkWASenderProvider></MinimizedFormsProvider></BrowserRouter></AuthProvider></QueryClientProvider>;
}
