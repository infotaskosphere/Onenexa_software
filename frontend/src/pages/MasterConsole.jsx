import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Building2, CheckCircle2, Copy, KeyRound, Plus, Search, ShieldCheck,
  Users, X, XCircle, Save, Trash2, ReceiptText, ChevronDown, ChevronRight,
  Loader2, Settings2, Pencil, Globe, RefreshCw, Bell, Sliders, ExternalLink,
  Mail
} from "lucide-react";
import { toast } from "sonner";
import {
  generateCommercialLicense,
  getLicenseState,
  updateLicenseStatus,
  deleteCommercialCompany,
  getCommercialModuleCatalog,
  updateCommercialModulePrice,
} from "@/lib/licenseApi";
import { fetchCompanyList } from "@/lib/companies";
import {
  getCommercialSystemHealth,
  getCommercialAnalytics,
  getCommercialActivity,
  getCommercialOmniSettings,
  getCommercialDomains,
  getCommercialPlans
} from "@/lib/commercialConsoleApi";

import CommercialSidebar from "@/components/commercial/CommercialSidebar.jsx";
import GlobalSearch from "@/components/commercial/GlobalSearch.jsx";
import OverviewTab from "@/components/commercial/OverviewTab.jsx";
import AIWeaveManagementTab from "@/components/commercial/AIWeaveManagementTab.jsx";
import WebsiteManagementTab from "@/components/commercial/WebsiteManagementTab.jsx";
import SystemHealthTab from "@/components/commercial/SystemHealthTab.jsx";
import PlansManagementTab from "@/components/commercial/PlansManagementTab.jsx";
import ActivityAuditTab from "@/components/commercial/ActivityAuditTab.jsx";
import AnalyticsUsageTab from "@/components/commercial/AnalyticsUsageTab.jsx";
import CommercialCustomerEditor from "@/components/CommercialCustomerEditor.jsx";

import EmailConfigTab from "@/components/commercial/EmailConfigTab.jsx";
import EmailTemplatesTab from "@/components/commercial/EmailTemplatesTab.jsx";
import EmailDeliveryLogsTab from "@/components/commercial/EmailDeliveryLogsTab.jsx";
import AccountRecoveryTab from "@/components/commercial/AccountRecoveryTab.jsx";
import LicenseeEmailModal from "@/components/commercial/LicenseeEmailModal.jsx";

const MODULE_LABELS = Object.freeze({
  taskosphere: "Taskosphere",
  finix: "Finix",
  aiweave: "AIWeave",
  compliance: "CompliGenie",
  records: "Records",
  proposals: "LeadSense",
  people_matrix: "People Matrix"
});

const emptyForm = {
  company_name: "",
  admin_name: "",
  contact_name: "",
  email: "",
  phone: "",
  gstin: "",
  address: "",
  gst_address: "",
  city: "",
  state: "",
  pincode: "",
  validity_months: 12,
  amount_charged: "",
  currency: "INR",
  max_users: 10,
  max_installations: 1,
  notes: "",
  invoice_company_id: ""
};

const money = (value) => Number(value || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-IN") : "Lifetime";
const featureLabel = (flag) => String(flag || "").replace(/^can_(view|manage)_/, "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());

const DASHBOARD_FLAG_BY_MODULE = Object.freeze({
  taskosphere: "can_view_dashboard",
  finix: "can_view_accounting_reports",
  compliance: "can_view_compliance",
  records: "can_view_documents",
  proposals: "can_view_all_leads",
  people_matrix: "can_view_user_page",
});

const FEATURE_FALLBACKS = Object.freeze({
  taskosphere: [["can_view_dashboard","Dashboard"],["can_view_tasks","Tasks"],["can_view_todo_dashboard","To-Do"],["can_view_attendance","Attendance"],["can_view_reminders","Reminders"],["can_view_action_center","Action Center"],["can_view_client_visits","Client Visits"],["can_view_client_portal","Client Portal Manager"],["can_reset_client_passwords","Password Reset"]],
  finix: [["can_view_accounting_reports","Finix Dashboard & Accounting Reports"],["can_view_sale","Sales / Invoicing"],["can_view_purchase","Purchase"],["can_view_bank","Bank Accounts"],["can_view_chart_of_accounts","Chart of Accounts (view)"],["can_manage_chart_of_accounts","Chart of Accounts (manage)"],["can_view_journal_entries","Journal Entries (view)"],["can_post_journal_entries","Journal Entries & Zero Touch Entry (post)"],["can_match_bank","Bank Reconciliation (match/unmatch)"]],
  aiweave: [["can_view_aiweave","AIWeave Workspace"]],
  compliance: [["can_view_compliance","Compliance Tracker (view)"],["can_manage_compliance","Compliance Tracker (manage)"],["can_view_gst_reconciliation","GST Reconciliation"],["can_view_trademark_sphere","Trademark Sphere"],["can_view_mis_report","MIS Report (view)"],["can_manage_mis_report","MIS Report (manage)"],["can_view_salary_slips","Salary Slip Generator (view)"],["can_manage_salary_slips","Salary Slip Generator (manage)"],["can_view_roc_sphere","ROC Sphere (view)"],["can_manage_roc_sphere","ROC Sphere (manage)"]],
  records: [["can_view_all_dsc","DSC Register"],["can_view_documents","Document Register"],["can_view_passwords","Password Vault (view)"],["can_edit_passwords","Password Vault (manage)"],["can_view_all_clients","Clients — visibility of other users' clients"],["can_edit_clients","Clients — edit / update any client"],["can_approve_clients","Clients — approve newly added clients"],["can_approve_whatsapp_wishes","Automation — approve WhatsApp birthday/festival wishes"],["can_approve_email_wishes","Automation — approve Email birthday/festival wishes"]],
  proposals: [["can_view_all_leads","Lead Management"],["can_create_quotations","Quotations"],["can_view_client_discussion","Client Discussion (view)"],["can_manage_client_discussion","Client Discussion (manage)"]],
  people_matrix: [["can_view_leave","Leave (view)"],["can_manage_leave","Leave (manage)"],["can_view_payroll","Payroll (view)"],["can_manage_payroll","Payroll (manage)"],["can_view_hr","HR (view)"],["can_manage_hr","HR (manage)"],["can_view_recruitment","Recruitment (view)"],["can_manage_recruitment","Recruitment (manage)"],["can_view_performance","Performance (view)"],["can_manage_performance","Performance (manage)"]],
});

const dashboardReady = (module, selected) => {
  const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module?.id];
  if (!dashboardFlag) return false;
  const required = (module?.features || []).map((feature) => feature.id).filter((id) => id !== dashboardFlag);
  return required.length > 0 && required.every((id) => (selected || []).includes(id));
};

const normalizeDashboardSelection = (catalog, selections) => {
  const next = { ...(selections || {}) };
  (catalog || []).forEach((module) => {
    const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module.id];
    if (!dashboardFlag) return;
    const current = Array.from(new Set(next[module.id] || []));
    next[module.id] = dashboardReady(module, current)
      ? Array.from(new Set([...current, dashboardFlag]))
      : current.filter((id) => id !== dashboardFlag);
  });
  return next;
};

const isFeatureChecked = (module, feature, selected) => {
  const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module?.id];
  return feature.id === dashboardFlag ? dashboardReady(module, selected) : (selected || []).includes(feature.id);
};

function Field({ label, children }) {
  return (
    <label className="text-sm font-medium text-slate-700">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function Input(props) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50 ${props.className || ""}`}
    />
  );
}

export default function MasterConsole() {
  const [tab, setTab] = useState("overview");
  const [state, setState] = useState({ licenses: [], customers: [] });
  const [modules, setModules] = useState([]);
  const [invoiceCompanies, setInvoiceCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editingLicense, setEditingLicense] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [selectedModules, setSelectedModules] = useState(["taskosphere", "finix", "compliance"]);
  const [selectedFeatures, setSelectedFeatures] = useState({});
  const [expandedModules, setExpandedModules] = useState({});
  const [generating, setGenerating] = useState(false);
  const [created, setCreated] = useState(null);

  // New SaaS Commercial Control Extensions State
  const [systemHealth, setSystemHealth] = useState({ status: "Healthy", services: [] });
  const [analytics, setAnalytics] = useState(null);
  const [activityLogs, setActivityLogs] = useState([]);
  const [omniSettings, setOmniSettings] = useState({});
  const [domains, setDomains] = useState([]);
  const [plans, setPlans] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [licenseeEmailCustomer, setLicenseeEmailCustomer] = useState(null);

  const activeModules = useMemo(() => (Array.isArray(modules) ? modules : []).filter((m) => m.id !== "admin" && m.active !== false).map((m) => ({ ...m, features: Array.isArray(m.features) && m.features.length ? m.features : (FEATURE_FALLBACKS[m.id] || []).map(([id, label]) => ({ id, label, actions: ["view"] })) })), [modules]);
  const defaultSelectedFeatures = useMemo(() => {
    return Object.fromEntries(
      activeModules.map((module) => [
        module.id,
        (module.features || []).map((feature) => feature.id),
      ])
    );
  }, [activeModules]);

  const refreshCore = async () => {
    try {
      const [licensePayload, catalog, companies] = await Promise.all([
        getLicenseState(),
        getCommercialModuleCatalog(),
        fetchCompanyList(),
      ]);
      setState({
        licenses: Array.isArray(licensePayload?.licenses) ? licensePayload.licenses : [],
        customers: Array.isArray(licensePayload?.customers) ? licensePayload.customers : [],
      });
      const resolvedCatalog = Array.isArray(catalog) ? catalog : (catalog?.modules || []);
      setModules(resolvedCatalog);
      setInvoiceCompanies(Array.isArray(companies) ? companies : []);
    } catch (err) {
      toast.error("Unable to load commercial licensing records.");
    }
  };

  const refreshExtensions = async () => {
    try {
      const [hlth, anlyt, act, omni, doms, plns] = await Promise.all([
        getCommercialSystemHealth().catch(() => ({ status: "Healthy", services: [] })),
        getCommercialAnalytics().catch(() => null),
        getCommercialActivity().catch(() => ({ logs: [] })),
        getCommercialOmniSettings().catch(() => ({})),
        getCommercialDomains().catch(() => ({ domains: [] })),
        getCommercialPlans().catch(() => ({ plans: [] })),
      ]);
      setSystemHealth(hlth);
      setAnalytics(anlyt);
      setActivityLogs(act?.logs || []);
      setOmniSettings(omni);
      setDomains(doms?.domains || []);
      setPlans(plns?.plans || []);
    } catch (err) {
      // Non-fatal
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([refreshCore(), refreshExtensions()]);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    refreshAll();
  }, []);

  const customerById = useMemo(() => {
    return Object.fromEntries((state.customers || []).map((c) => [String(c.id), c]));
  }, [state.customers]);

  const filteredLicenses = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.licenses || [];
    return (state.licenses || []).filter((item) => {
      const customer = item.customer || customerById[String(item.customer_id)] || {};
      return [
        item.license_key,
        item.customer_name,
        item.company_name,
        item.admin_name,
        customer.company_name,
        customer.admin_name,
        customer.email,
        customer.gstin,
        item.invoice_no,
      ].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }, [state.licenses, customerById, query]);

  const stats = useMemo(() => {
    const total = state.licenses?.length || 0;
    const active = (state.licenses || []).filter((l) => l.status === "active").length;
    const expired = (state.licenses || []).filter((l) => l.status === "expired" || l.status === "revoked").length;
    const customers = state.customers?.length || total;
    return { total, active, expired, customers };
  }, [state.licenses, state.customers]);

  const openCreate = () => {
    const defaultFeatures = { ...defaultSelectedFeatures };
    const initialModules = activeModules.map((m) => m.id);
    setSelectedModules(initialModules);
    setSelectedFeatures(normalizeDashboardSelection(activeModules, defaultFeatures));
    setExpandedModules({});
    setForm({ ...emptyForm, invoice_company_id: invoiceCompanies[0]?.id || "" });
    setShowCreate(true);
  };

  const selectModule = (moduleId, checked) => {
    const nextModules = checked
      ? Array.from(new Set([...selectedModules, moduleId]))
      : selectedModules.filter((id) => id !== moduleId);
    const nextFeatures = { ...selectedFeatures };
    if (checked) {
      const target = activeModules.find((m) => m.id === moduleId);
      nextFeatures[moduleId] = (target?.features || []).map((f) => f.id);
    } else {
      delete nextFeatures[moduleId];
    }
    setSelectedModules(nextModules);
    setSelectedFeatures(normalizeDashboardSelection(activeModules, nextFeatures));
  };

  const toggleFeature = (moduleId, featureId) => {
    const current = selectedFeatures[moduleId] || [];
    const next = current.includes(featureId) ? current.filter((id) => id !== featureId) : [...current, featureId];
    const nextFeatures = { ...selectedFeatures, [moduleId]: next };
    setSelectedFeatures(normalizeDashboardSelection(activeModules, nextFeatures));
  };

  const calculatedAmount = useMemo(() => {
    let monthly = 0;
    activeModules.forEach((m) => {
      if (!selectedModules.includes(m.id)) return;
      const fSelected = selectedFeatures[m.id] || [];
      const isAll = (m.features || []).length > 0 && (m.features || []).every((f) => fSelected.includes(f.id));
      if (isAll && Number(m.monthly_price || 0) > 0) {
        monthly += Number(m.monthly_price || 0);
      } else {
        (m.features || []).forEach((f) => {
          if (fSelected.includes(f.id)) monthly += Number(f.monthly_price || 0);
        });
      }
    });
    return monthly * Number(form.validity_months || 0);
  }, [activeModules, selectedModules, selectedFeatures, form.validity_months]);

  const submit = async (event) => {
    event.preventDefault();
    if (generating) return;
    if (!selectedModules.length) return toast.error("Select at least one module.");
    if (!form.invoice_company_id) return toast.error("Select the Company Master company that should issue the invoice.");
    if (selectedModules.some((id) => !(selectedFeatures[id] || []).length)) {
      return toast.error("Every selected module must have at least one feature.");
    }
    setGenerating(true);
    try {
      const response = await generateCommercialLicense({
        ...form,
        selected_modules: selectedModules,
        selected_features: normalizeDashboardSelection(activeModules, selectedFeatures),
        validity_months: Number(form.validity_months || 0),
        amount_charged: form.amount_charged === "" ? calculatedAmount : Number(form.amount_charged),
        max_users: Number(form.max_users),
        max_installations: Number(form.max_installations)
      });
      setCreated(response.license || response);
      setShowCreate(false);
      await refreshAll();
      toast.success(`License generated${response.invoice?.invoice_no ? ` with invoice ${response.invoice.invoice_no}` : ""}.`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to generate license.");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("License number copied.");
    } catch {
      toast.error("Unable to copy license number.");
    }
  };

  const changeStatus = async (license, status) => {
    try {
      await updateLicenseStatus(license.id, status);
      await refreshAll();
      toast.success(`License ${status}.`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to update license.");
    }
  };

  const removeCompany = async (license) => {
    if (!window.confirm(`Delete ${license.customer_name || "this company"} from the License Registry? Historical invoices will be preserved.`)) return;
    try {
      await deleteCommercialCompany(license.id);
      await refreshAll();
      toast.success("License customer removed.");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to delete company.");
    }
  };

  const savePricing = async (module) => {
    try {
      const featurePrices = Object.fromEntries((module.features || []).map((f) => [f.id, Number(f.monthly_price || 0)]));
      const saved = await updateCommercialModulePrice(module.id, Number(module.monthly_price || 0), module.active !== false, featurePrices);
      setModules((items) => items.map((item) => (item.id === module.id ? saved : item)));
      toast.success(`${module.name} pricing updated.`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to update module pricing.");
    }
  };

  const customerFor = (license) => license.customer || customerById[String(license.customer_id)] || {};
  const editorCustomer = editingLicense ? customerFor(editingLicense) : null;
  const selectedFeatureCount = (license) => Object.values(license.selected_features || {}).reduce((sum, list) => sum + (list?.length || 0), 0);

  const handleGlobalSelect = (selection) => {
    if (selection.type === "license") {
      setEditingLicense(selection.item);
    } else if (selection.type === "module") {
      setTab("modules");
      setCatalogOpen(true);
    }
  };

  return (
    <div className="master-console-shell min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Sidebar Control Center Navigation */}
      <CommercialSidebar currentTab={tab} setTab={setTab} stats={stats} />

      {/* Main Administrative Control Workspace */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Top Operational Command Bar */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1 max-w-xl">
            <GlobalSearch
              licenses={state.licenses}
              modules={modules}
              onSelect={handleGlobalSelect}
            />
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={refreshAll}
              disabled={refreshing}
              title="Refresh Platform State"
              className="p-2 rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            </button>

            <Link
              to="/master-console/website"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition"
            >
              <Globe size={14} className="text-blue-600" />
              <span>Website Studio</span>
            </Link>

            <button
              onClick={openCreate}
              disabled={generating}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-800 disabled:opacity-60 transition"
            >
              <Plus size={14} />
              <span>Issue License</span>
            </button>
          </div>
        </header>

        {/* Dynamic Section View */}
        <main className="p-6 md:p-8 flex-1">
          {tab === "overview" && (
            <OverviewTab
              stats={stats}
              analytics={analytics}
              health={systemHealth}
              onNavigate={(section) => setTab(section)}
              onOpenCreateLicense={openCreate}
            />
          )}

          {(tab === "customers" || tab === "licenses") && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    {tab === "customers" ? "Customer Organizations" : "Commercial License Registry"}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {tab === "customers"
                      ? "Manage customer accounts, tenant boundaries, and primary points of contact."
                      : "Multi-tenant key distribution, module allowances, expiration and invoices."}
                  </p>
                </div>
                <div className="relative w-72 max-w-full">
                  <Search size={15} className="absolute left-3.5 top-2.5 text-slate-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search company, GSTIN, license..."
                    className="w-full rounded-xl border border-slate-200 pl-9 pr-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                  />
                </div>
              </div>

              {/* License / Customer Registry Table */}
              <div className="rounded-3xl border border-slate-200 bg-white overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs min-w-[1100px]">
                    <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-400">
                      <tr>
                        <th className="p-3.5">Admin & Primary Contact</th>
                        <th className="p-3.5">Organization / Company</th>
                        <th className="p-3.5">Identity IDs</th>
                        <th className="p-3.5">License Key</th>
                        <th className="p-3.5">Licensed Modules</th>
                        <th className="p-3.5">Monthly</th>
                        <th className="p-3.5">Charged</th>
                        <th className="p-3.5">Invoice</th>
                        <th className="p-3.5">Validity</th>
                        <th className="p-3.5">Status</th>
                        <th className="p-3.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredLicenses.map((license) => {
                        const customer = customerFor(license);
                        return (
                          <tr key={license.id} className="hover:bg-slate-50 transition">
                            <td className="p-3.5">
                              <button
                                type="button"
                                onClick={() => setEditingLicense(license)}
                                className="group text-left"
                              >
                                <div className="flex items-center gap-1.5 font-bold text-slate-900 group-hover:text-[#1F6FB2]">
                                  <span>{license.admin_name || customer.admin_name || license.customer_name || "Unnamed admin"}</span>
                                  <Pencil size={11} className="text-slate-300 group-hover:text-[#1F6FB2]" />
                                </div>
                                <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                  {customer.email || "No email"}
                                </div>
                              </button>
                            </td>
                            <td className="p-3.5">
                              <button
                                type="button"
                                onClick={() => setEditingLicense(license)}
                                className="group text-left"
                              >
                                <div className="font-semibold text-slate-900 group-hover:text-[#1F6FB2]">
                                  {license.company_name || customer.company_name || "Unnamed company"}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                  GST: {customer.gstin || "Not provided"}
                                </div>
                              </button>
                            </td>
                            <td className="p-3.5">
                              <div className="space-y-1 font-mono text-[10px]">
                                <div className="font-semibold text-[#0D3B66]">{license.licensee_uid || customer.licensee_uid || "—"}</div>
                                <div className="text-slate-400">{license.license_uid || "—"}</div>
                              </div>
                            </td>
                            <td className="p-3.5">
                              <button
                                onClick={() => copy(license.license_key)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition"
                              >
                                <span>{license.license_key}</span>
                                <Copy size={11} className="shrink-0 text-slate-400" />
                              </button>
                            </td>
                            <td className="p-3.5">
                              <div className="flex flex-wrap gap-1 max-w-[200px]">
                                {(license.modules || []).map((mod) => (
                                  <span key={mod} className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold text-slate-700">
                                    {MODULE_LABELS[mod] || mod}
                                  </span>
                                ))}
                                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-semibold text-blue-700">
                                  {selectedFeatureCount(license)} features
                                </span>
                              </div>
                            </td>
                            <td className="p-3.5 font-semibold text-slate-800 whitespace-nowrap">
                              {money(license.monthly_module_price)}
                            </td>
                            <td className="p-3.5 font-semibold text-slate-800 whitespace-nowrap">
                              {money(license.amount_charged)}
                            </td>
                            <td className="p-3.5 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1 text-slate-600 font-mono text-[11px]">
                                <ReceiptText size={12} className="text-slate-400" />
                                {license.invoice_no || "—"}
                              </span>
                            </td>
                            <td className="p-3.5 text-slate-500 whitespace-nowrap">
                              {formatDate(license.expires_at)}
                            </td>
                            <td className="p-3.5">
                              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                                license.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                              }`}>
                                {license.status}
                              </span>
                            </td>
                            <td className="p-3.5 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingLicense(license)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition"
                                >
                                  <Pencil size={11} /> Details
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setLicenseeEmailCustomer({ id: license.company_id || customer.id, name: license.company_name || customer.company_name })}
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-blue-50 hover:text-[#0D3B66] transition"
                                  title="Configure Licensee Email & Notifications"
                                >
                                  <Mail size={11} /> Email
                                </button>
                                <select
                                  aria-label="Change status"
                                  value=""
                                  onChange={(e) => e.target.value && changeStatus(license, e.target.value)}
                                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] outline-none"
                                >
                                  <option value="">Status</option>
                                  <option value="active">Activate</option>
                                  <option value="suspended">Suspend</option>
                                  <option value="revoked">Revoke</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => removeCompany(license)}
                                  title="Remove customer"
                                  className="rounded-lg border border-red-200 p-1 text-red-600 hover:bg-red-50 transition"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!filteredLicenses.length && (
                        <tr>
                          <td colSpan="10" className="p-10 text-center text-slate-400">
                            {loading ? "Loading commercial platform records…" : "No licenses found matching query."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {tab === "plans" && (
            <PlansManagementTab plans={plans} onRefresh={refreshExtensions} />
          )}

          {tab === "modules" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Module Catalog & Pricing Matrix</h2>
                  <p className="text-xs text-slate-500">Configure base module prices and individual feature charges.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {(Array.isArray(modules) ? modules : []).map((module) => (
                  <div key={module.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{module.code}</span>
                        <h3 className="text-base font-bold text-slate-900 mt-0.5">{MODULE_LABELS[module.id] || module.name}</h3>
                        <p className="text-xs text-slate-500 mt-1 min-h-[32px]">{module.description}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={module.active !== false}
                        onChange={(e) =>
                          setModules((items) =>
                            items.map((m) => (m.id === module.id ? { ...m, active: e.target.checked } : m))
                          )
                        }
                        className="rounded border-slate-300 text-[#1F6FB2] mt-1"
                      />
                    </div>

                    <div className="pt-2 border-t border-slate-100">
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Base Module Monthly (INR)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={module.monthly_price ?? 0}
                        onChange={(e) =>
                          setModules((items) =>
                            items.map((m) => (m.id === module.id ? { ...m, monthly_price: e.target.value } : m))
                          )
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                      />
                    </div>

                    <div className="space-y-2 rounded-2xl bg-slate-50 p-3 max-h-48 overflow-y-auto">
                      <div className="text-[10px] font-bold uppercase text-slate-400">Feature Rates</div>
                      {(module.features || []).map((feat) => (
                        <div key={feat.id} className="flex items-center justify-between text-xs gap-2">
                          <span className="text-slate-700 truncate">{feat.label || feat.id}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={feat.monthly_price ?? 0}
                            onChange={(e) =>
                              setModules((items) =>
                                items.map((m) =>
                                  m.id === module.id
                                    ? {
                                        ...m,
                                        features: (m.features || []).map((f) =>
                                          f.id === feat.id ? { ...f, monthly_price: e.target.value } : f
                                        ),
                                      }
                                    : m
                                )
                              )
                            }
                            className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-right"
                          />
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => savePricing(module)}
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2.5 text-xs font-bold text-slate-800 shadow-xs hover:bg-slate-50 transition"
                    >
                      <Save size={13} />
                      <span>Save Pricing</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "website" && (
            <WebsiteManagementTab domains={domains} onRefresh={refreshExtensions} />
          )}

          {tab === "aiweave" && (
            <AIWeaveManagementTab omniSettings={omniSettings} onRefresh={refreshExtensions} />
          )}

          {tab === "analytics" && (
            <AnalyticsUsageTab analytics={analytics} />
          )}

          {tab === "audit" && (
            <ActivityAuditTab logs={activityLogs} />
          )}

          {tab === "health" && (
            <SystemHealthTab health={systemHealth} onRefresh={refreshExtensions} loading={refreshing} />
          )}

          {tab === "email-config" && (
            <EmailConfigTab />
          )}

          {tab === "email-templates" && (
            <EmailTemplatesTab />
          )}

          {tab === "email-logs" && (
            <EmailDeliveryLogsTab />
          )}

          {tab === "auth-recovery" && (
            <AccountRecoveryTab />
          )}
        </main>
      </div>

      {/* License Generated Toast Banner */}
      {created && (
        <div className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-3xl rounded-3xl border border-emerald-200 bg-white p-6 shadow-2xl">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-600">License Generated Successfully</p>
              <h3 className="mt-1 text-lg font-bold text-slate-900">{created.admin_name || created.customer_name}</h3>
              <p className="mt-1 text-xs text-slate-500">
                {(created.modules || []).map((m) => MODULE_LABELS[m] || m).join(", ")} · {created.validity_months} months · {money(created.amount_charged)}
              </p>
            </div>
            <button onClick={() => setCreated(null)} className="text-slate-400 hover:text-slate-600">
              <X size={18} />
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl bg-slate-950 p-3.5 flex items-center justify-between text-white">
              <div>
                <div className="text-[10px] uppercase text-white/50 font-semibold">License Key</div>
                <code className="text-xs font-mono font-bold tracking-wider">{created.license_key}</code>
              </div>
              <button onClick={() => copy(created.license_key)} className="p-2 rounded-xl bg-white/10 hover:bg-white/20">
                <Copy size={15} />
              </button>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3.5 flex items-center gap-2 text-slate-800">
              <ReceiptText size={18} className="text-blue-600" />
              <div>
                <div className="text-[10px] uppercase text-slate-400 font-semibold">Tax Invoice</div>
                <div className="text-xs font-bold">{created.invoice_no || created.invoice?.invoice_no || "Issued"}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Issue License Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={submit} className="relative my-4 max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl space-y-6">
            <div className="flex items-start justify-between border-b pb-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Issue Commercial Customer License</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Provision new multi-tenant license with automated commercial invoice generation.
                </p>
              </div>
              <button type="button" disabled={generating} onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
                <div className="flex items-center gap-2 font-bold text-xs text-slate-900 uppercase tracking-wider">
                  <Building2 size={16} className="text-[#1F6FB2]" />
                  <span>Customer & GST Details</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["Company Name *", "company_name"],
                    ["Admin Name *", "admin_name"],
                    ["Contact Person", "contact_name"],
                    ["Email *", "email"],
                    ["Phone", "phone"],
                    ["GSTIN", "gstin"],
                    ["Pincode", "pincode"],
                    ["City", "city"],
                    ["State", "state"],
                  ].map(([label, key]) => (
                    <Field key={key} label={label}>
                      <Input
                        required={["company_name", "admin_name", "email"].includes(key)}
                        disabled={generating}
                        type={key === "email" ? "email" : "text"}
                        value={form[key]}
                        onChange={(e) =>
                          setForm({ ...form, [key]: key === "gstin" ? e.target.value.toUpperCase() : e.target.value })
                        }
                      />
                    </Field>
                  ))}
                  <Field label="Registered Address">
                    <Input disabled={generating} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                  </Field>
                  <Field label="GST Address">
                    <Input disabled={generating} value={form.gst_address} onChange={(e) => setForm({ ...form, gst_address: e.target.value })} />
                  </Field>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
                <div className="flex items-center gap-2 font-bold text-xs text-slate-900 uppercase tracking-wider">
                  <ReceiptText size={16} className="text-[#1F6FB2]" />
                  <span>Invoicing Entity</span>
                </div>
                <p className="text-xs text-slate-500">
                  Select your Platform Owner Company Master entity to issue the official GST tax invoice.
                </p>
                <Field label="Invoice Issuer Company *">
                  <select
                    required
                    disabled={generating}
                    value={form.invoice_company_id}
                    onChange={(e) => setForm({ ...form, invoice_company_id: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-[#1F6FB2]"
                  >
                    <option value="">Select issuer company</option>
                    {invoiceCompanies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.company_name}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="mt-4 pt-3 border-t border-slate-200 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Duration:</span>
                    <span className="font-semibold">{form.validity_months} months</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Calculated Charge:</span>
                    <span className="font-bold text-slate-900">{money(calculatedAmount)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Modules and Features matrix */}
            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center justify-between border-b pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Authorized Modules & Entitlements</h3>
                  <p className="text-xs text-slate-500">Select granular feature access granted to the tenant.</p>
                </div>
                <span className="text-xs font-bold text-[#1F6FB2] bg-blue-50 px-2.5 py-1 rounded-full">
                  {selectedModules.length} Modules Selected
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {activeModules.map((module) => (
                  <div
                    key={module.id}
                    className={`rounded-2xl border p-3.5 transition ${
                      selectedModules.includes(module.id) ? "border-[#0D3B66] bg-slate-50/70" : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        disabled={generating}
                        checked={selectedModules.includes(module.id)}
                        onChange={(e) => selectModule(module.id, e.target.checked)}
                        className="rounded border-slate-300 text-[#0D3B66]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-slate-900">{MODULE_LABELS[module.id] || module.name}</div>
                        <div className="text-[11px] text-slate-400">{money(module.monthly_price)} / month</div>
                      </div>
                      <button
                        type="button"
                        disabled={generating}
                        onClick={() => setExpandedModules((v) => ({ ...v, [module.id]: !v[module.id] }))}
                        className="p-1 text-slate-400 hover:text-slate-600"
                      >
                        {expandedModules[module.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                    </div>

                    {expandedModules[module.id] && (
                      <div className="mt-3 pt-3 border-t border-slate-200 space-y-1.5">
                        {(module.features || []).map((feature) => (
                          <label key={feature.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              disabled={generating || feature.id === DASHBOARD_FLAG_BY_MODULE[module.id]}
                              checked={isFeatureChecked(module, feature, selectedFeatures[module.id] || [])}
                              onChange={() => toggleFeature(module.id, feature.id)}
                              className="rounded border-slate-300 text-[#0D3B66]"
                            />
                            <span className="flex-1 truncate">{feature.label || featureLabel(feature.id)}</span>
                            <span className="text-[10px] text-slate-400">{money(feature.monthly_price)}/mo</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Terms and Pricing */}
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="Duration (months)">
                <Input
                  type="number"
                  min="1"
                  disabled={generating}
                  value={form.validity_months}
                  onChange={(e) => setForm({ ...form, validity_months: e.target.value })}
                />
              </Field>
              <Field label="Max Users">
                <Input
                  type="number"
                  min="1"
                  disabled={generating}
                  value={form.max_users}
                  onChange={(e) => setForm({ ...form, max_users: e.target.value })}
                />
              </Field>
              <Field label="Max Installations">
                <Input
                  type="number"
                  min="1"
                  disabled={generating}
                  value={form.max_installations}
                  onChange={(e) => setForm({ ...form, max_installations: e.target.value })}
                />
              </Field>
              <Field label="Amount Charged (INR)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={generating}
                  value={form.amount_charged === "" ? calculatedAmount : form.amount_charged}
                  onChange={(e) => setForm({ ...form, amount_charged: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <button
                type="button"
                disabled={generating}
                onClick={() => setShowCreate(false)}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={generating}
                className="inline-flex min-w-[200px] items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
              >
                {generating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Provisioning License…</span>
                  </>
                ) : (
                  <span>Generate License & Invoice</span>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Existing CommercialCustomerEditor Modal preserved intact */}
      {editingLicense && (
        <CommercialCustomerEditor
          license={editingLicense}
          customer={editorCustomer}
          modules={modules}
          onClose={() => setEditingLicense(null)}
          onSaved={async ({ license }) => {
            await refreshAll();
            setEditingLicense(null);
            setState((current) => ({
              ...current,
              licenses: current.licenses.map((item) => (item.id === license.id ? license : item)),
            }));
          }}
        />
      )}

      {/* Licensee Email & Notification Settings Modal */}
      {licenseeEmailCustomer && (
        <LicenseeEmailModal
          customerId={licenseeEmailCustomer.id}
          customerName={licenseeEmailCustomer.name}
          onClose={() => setLicenseeEmailCustomer(null)}
          onUpdated={refreshCore}
        />
      )}
    </div>
  );
}
