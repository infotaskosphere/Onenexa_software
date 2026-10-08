/**
 * mockBackend.js
 * In-memory mock response provider for Taskosphere Commercial
 * Allows full offline / preview functionality without requiring an external MongoDB/Python instance.
 */

import { isPlatformOwner } from "./commercialPermissionMatrix";

export function derivePermissionsFromModules(modules) {
  const norm = (modules || []).map((m) => String(m).toLowerCase().replace(/-/g, "_"));
  return {
    can_access_taskosphere: norm.some((m) => m === "taskosphere" || m === "tasks"),
    can_access_finix: norm.some((m) => m === "finix" || m === "invoicing" || m === "accounting"),
    can_access_compliance: norm.some((m) => m === "compliance"),
    can_access_records: norm.some((m) => m === "records"),
    can_access_proposals: norm.some((m) => m === "proposals" || m === "client_proposals"),
    can_access_people_matrix: norm.some((m) => m === "people_matrix" || m === "hrms" || m === "peoplematrix"),
    can_access_aiweave: norm.some((m) => m === "aiweave" || m === "ai-weave"),
  };
}

export const DEFAULT_MOCK_CATALOG = [
  {
    id: "taskosphere",
    name: "Taskosphere",
    label: "Taskosphere",
    description: "Tasks, Attendance, Reminders, Client Portal, Action Center",
    monthly_price: 2499,
    active: true,
    features: [
      { id: "can_view_dashboard", name: "Dashboard", monthly_price: 299 },
      { id: "can_view_tasks", name: "Tasks Management", monthly_price: 399 },
      { id: "can_view_todo_dashboard", name: "To-Do Dashboard", monthly_price: 199 },
      { id: "can_view_attendance", name: "Attendance & Time Tracking", monthly_price: 299 },
      { id: "can_view_reminders", name: "Reminders & Alerts", monthly_price: 199 },
      { id: "can_view_action_center", name: "Action Center", monthly_price: 299 },
      { id: "can_view_client_visits", name: "Client Visits", monthly_price: 249 },
      { id: "can_view_client_portal", name: "Client Portal Manager", monthly_price: 499 },
      { id: "can_reset_client_passwords", name: "Client Password Resets", monthly_price: 149 },
    ],
  },
  {
    id: "finix",
    name: "Finix",
    label: "Finix",
    description: "Invoicing, Accounting, Banking, Chart of Accounts & Journals",
    monthly_price: 3499,
    active: true,
    features: [
      { id: "can_view_accounting_reports", name: "Accounting Reports", monthly_price: 499 },
      { id: "can_view_sale", name: "Sales & Invoicing", monthly_price: 499 },
      { id: "can_view_purchase", name: "Purchase Management", monthly_price: 399 },
      { id: "can_view_bank", name: "Bank Accounts", monthly_price: 399 },
      { id: "can_view_chart_of_accounts", name: "Chart of Accounts", monthly_price: 399 },
      { id: "can_manage_chart_of_accounts", name: "Manage Chart of Accounts", monthly_price: 499 },
      { id: "can_view_journal_entries", name: "Journal Entries", monthly_price: 399 },
      { id: "can_post_journal_entries", name: "Post Journal Entries", monthly_price: 499 },
      { id: "can_match_bank", name: "Bank Reconciliation", monthly_price: 499 },
    ],
  },
  {
    id: "compliance",
    name: "CompliGenie",
    label: "CompliGenie",
    description: "GST, ROC, Trademark Sphere, Salary Slips & MIS Reports",
    monthly_price: 2999,
    active: true,
    features: [
      { id: "can_view_compliance", name: "Compliance Dashboard", monthly_price: 399 },
      { id: "can_manage_compliance", name: "Manage Compliance", monthly_price: 499 },
      { id: "can_view_gst_reconciliation", name: "GST Reconciliation", monthly_price: 499 },
      { id: "can_view_trademark_sphere", name: "Trademark Sphere", monthly_price: 399 },
      { id: "can_view_mis_report", name: "MIS Reports", monthly_price: 399 },
      { id: "can_manage_mis_report", name: "Manage MIS Reports", monthly_price: 499 },
      { id: "can_view_salary_slips", name: "Salary Slips", monthly_price: 299 },
      { id: "can_manage_salary_slips", name: "Manage Salary Slips", monthly_price: 399 },
      { id: "can_view_roc_sphere", name: "ROC Sphere", monthly_price: 399 },
      { id: "can_manage_roc_sphere", name: "Manage ROC Sphere", monthly_price: 499 },
    ],
  },
  {
    id: "records",
    name: "Records",
    label: "Records",
    description: "Document Vault, DSC Register, Password Manager, Client Database",
    monthly_price: 2499,
    active: true,
    features: [
      { id: "can_view_documents", name: "Document Vault", monthly_price: 399 },
      { id: "can_view_all_dsc", name: "DSC Register", monthly_price: 399 },
      { id: "can_view_passwords", name: "Password Vault", monthly_price: 299 },
      { id: "can_edit_passwords", name: "Manage Passwords", monthly_price: 349 },
      { id: "can_view_all_clients", name: "Client Master", monthly_price: 399 },
      { id: "can_edit_clients", name: "Manage Clients", monthly_price: 399 },
      { id: "can_approve_clients", name: "Approve Clients", monthly_price: 299 },
      { id: "can_approve_whatsapp_wishes", name: "Automated WhatsApp Greetings", monthly_price: 249 },
      { id: "can_approve_email_wishes", name: "Automated Email Greetings", monthly_price: 249 },
    ],
  },
  {
    id: "proposals",
    name: "LeadSense",
    label: "LeadSense",
    description: "Leads Pipeline, Quotations & Proposals, Client Discussions",
    monthly_price: 1999,
    active: true,
    features: [
      { id: "can_view_all_leads", name: "Leads Pipeline", monthly_price: 499 },
      { id: "can_create_quotations", name: "Quotations & Proposals", monthly_price: 499 },
      { id: "can_view_client_discussion", name: "Client Discussions", monthly_price: 299 },
      { id: "can_manage_client_discussion", name: "Manage Client Discussions", monthly_price: 399 },
    ],
  },
  {
    id: "people_matrix",
    name: "People Matrix",
    label: "People Matrix",
    description: "HR Management, Attendance, Payroll, Recruitment & Performance",
    monthly_price: 2999,
    active: true,
    features: [
      { id: "can_view_user_page", name: "Staff Directory", monthly_price: 299 },
      { id: "can_view_leave", name: "Leave Tracking", monthly_price: 299 },
      { id: "can_manage_leave", name: "Approve Leaves", monthly_price: 349 },
      { id: "can_view_payroll", name: "Payroll Directory", monthly_price: 499 },
      { id: "can_manage_payroll", name: "Process Payroll", monthly_price: 599 },
      { id: "can_view_hr", name: "HR Core", monthly_price: 399 },
      { id: "can_manage_hr", name: "Manage HR Policies", monthly_price: 449 },
      { id: "can_view_recruitment", name: "Recruitment Tracker", monthly_price: 349 },
      { id: "can_manage_recruitment", name: "Manage Candidates", monthly_price: 399 },
      { id: "can_view_performance", name: "Appraisals & KPIs", monthly_price: 399 },
      { id: "can_manage_performance", name: "Manage Appraisals", monthly_price: 499 },
    ],
  },
  {
    id: "aiweave",
    name: "AIWeave",
    label: "AIWeave",
    description: "Document Intelligence, OCR Data Extraction & Smart Search",
    monthly_price: 3999,
    active: true,
    features: [
      { id: "can_view_aiweave", name: "AI Document Intelligence", monthly_price: 999 },
    ],
  },
];

export function getStoredMockCatalog() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_module_catalog");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockCatalog) {
    globalThis.__mockCatalog = JSON.parse(JSON.stringify(DEFAULT_MOCK_CATALOG));
  }
  return globalThis.__mockCatalog;
}

export function saveStoredMockCatalog(catalog) {
  globalThis.__mockCatalog = catalog;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_module_catalog", JSON.stringify(catalog));
    } catch {}
  }
}

export const DEFAULT_MOCK_LICENSES = [
  {
    id: "lic-01",
    customer_id: "cust-ent-01",
    license_key: "TSO-COMM-2026-DEMO-0001",
    company_name: "Enterprise Solutions & Associates",
    package_name: "Commercial Enterprise Suite",
    status: "active",
    valid_until: "2028-12-31T23:59:59Z",
    max_users: 100,
    max_installations: 5,
    modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
    licensed_modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
    selected_features: {
      taskosphere: ["can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard", "can_view_attendance", "can_view_reminders", "can_view_action_center", "can_view_client_visits", "can_view_client_portal", "can_reset_client_passwords"],
      finix: ["can_view_accounting_reports", "can_view_sale", "can_view_purchase", "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts", "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"],
      compliance: ["can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation", "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report", "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere", "can_manage_roc_sphere"],
      records: ["can_view_documents", "can_view_all_dsc", "can_view_passwords", "can_edit_passwords", "can_view_all_clients", "can_edit_clients", "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"],
      proposals: ["can_view_all_leads", "can_create_quotations", "can_view_client_discussion", "can_manage_client_discussion"],
      people_matrix: ["can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll", "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment", "can_manage_recruitment", "can_view_performance", "can_manage_performance"],
      aiweave: ["can_view_aiweave"],
    },
  },
];

export const DEFAULT_MOCK_CUSTOMERS = [
  {
    id: "cust-ent-01",
    company_name: "Enterprise Solutions & Associates",
    contact_name: "Operations Director",
    email: "admin@enterprisesolutions.com",
    phone: "+91 98765 00000",
    gstin: "27AAAAA0000A1Z5",
    address: "Suite 401, Business Center, Mumbai",
    status: "active",
    licensed_modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
    selected_features: {
      taskosphere: ["can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard", "can_view_attendance", "can_view_reminders", "can_view_action_center", "can_view_client_visits", "can_view_client_portal", "can_reset_client_passwords"],
      finix: ["can_view_accounting_reports", "can_view_sale", "can_view_purchase", "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts", "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"],
      compliance: ["can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation", "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report", "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere", "can_manage_roc_sphere"],
      records: ["can_view_documents", "can_view_all_dsc", "can_view_passwords", "can_edit_passwords", "can_view_all_clients", "can_edit_clients", "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"],
      proposals: ["can_view_all_leads", "can_create_quotations", "can_view_client_discussion", "can_manage_client_discussion"],
      people_matrix: ["can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll", "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment", "can_manage_recruitment", "can_view_performance", "can_manage_performance"],
      aiweave: ["can_view_aiweave"],
    },
  },
];

export function getStoredMockLicenses() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_licenses");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockLicenses) {
    globalThis.__mockLicenses = JSON.parse(JSON.stringify(DEFAULT_MOCK_LICENSES));
  }
  return globalThis.__mockLicenses;
}

export function saveStoredMockLicenses(licenses) {
  globalThis.__mockLicenses = licenses;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_licenses", JSON.stringify(licenses));
    } catch {}
  }
}

export function getStoredMockCustomers() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_customers");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockCustomers) {
    globalThis.__mockCustomers = JSON.parse(JSON.stringify(DEFAULT_MOCK_CUSTOMERS));
  }
  return globalThis.__mockCustomers;
}

export function saveStoredMockCustomers(customers) {
  globalThis.__mockCustomers = customers;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_customers", JSON.stringify(customers));
    } catch {}
  }
}

export const DEFAULT_MOCK_COMPANIES = [
  {
    id: "comp-tasko-01",
    name: "Taskosphere Commercial Services",
    contact_name: "Operations Director",
    email: "admin@taskosphere.com",
    phone: "+91 98765 00000",
    gstin: "27AAAAA0000A1Z5",
    address: "Suite 401, Business Center, Mumbai",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400001",
    status: "active",
    has_gst: true,
    licensed_modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
    created_at: new Date().toISOString(),
  },
  {
    id: "cust-ent-01",
    name: "Enterprise Solutions & Associates",
    contact_name: "Operations Director",
    email: "admin@enterprisesolutions.com",
    phone: "+91 98765 00000",
    gstin: "27AAAAA0000A1Z5",
    address: "Suite 401, Business Center, Mumbai",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400001",
    status: "active",
    has_gst: true,
    commercial_customer_id: "cust-ent-01",
    license_id: "lic-01",
    license_key: "TSO-COMM-2026-DEMO-0001",
    source: "commercial-license",
    licensed_modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
    created_at: new Date().toISOString(),
  },
];

export function getStoredMockCompanies() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_companies");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockCompanies) {
    globalThis.__mockCompanies = JSON.parse(JSON.stringify(DEFAULT_MOCK_COMPANIES));
  }
  return globalThis.__mockCompanies;
}

export function saveStoredMockCompanies(companies) {
  globalThis.__mockCompanies = companies;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_companies", JSON.stringify(companies));
    } catch {}
  }
}

export const MOCK_USER = {
  id: "lic-usr-01",
  email: "admin@enterprisesolutions.com",
  full_name: "Admin Director",
  role: "admin",
  company_id: "cust-ent-01",
  commercial_customer_id: "cust-ent-01",
  license_id: "lic-01",
  company: {
    id: "cust-ent-01",
    name: "Enterprise Solutions & Associates",
    plan: "Commercial Enterprise Suite",
  },
  subscription: {
    status: "active",
    package_id: "enterprise",
    valid_until: "2030-12-31T23:59:59Z",
  },
  licensed_modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"],
  selected_features: {
    taskosphere: ["can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard", "can_view_attendance", "can_view_reminders", "can_view_action_center", "can_view_client_visits", "can_view_client_portal", "can_reset_client_passwords"],
    finix: ["can_view_accounting_reports", "can_view_sale", "can_view_purchase", "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts", "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"],
    compliance: ["can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation", "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report", "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere", "can_manage_roc_sphere"],
    records: ["can_view_documents", "can_view_all_dsc", "can_view_passwords", "can_edit_passwords", "can_view_all_clients", "can_edit_clients", "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"],
    proposals: ["can_view_all_leads", "can_create_quotations", "can_view_client_discussion", "can_manage_client_discussion"],
    people_matrix: ["can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll", "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment", "can_manage_recruitment", "can_view_performance", "can_manage_performance"],
    aiweave: ["can_view_aiweave"],
  },
  permissions: {
    can_access_taskosphere: true,
    can_access_finix: true,
    can_access_compliance: true,
    can_access_records: true,
    can_access_proposals: true,
    can_access_people_matrix: true,
    can_access_aiweave: true,
    can_view_dashboard: true,
    can_view_tasks: true,
    can_view_accounting_reports: true,
    can_view_compliance: true,
    can_view_documents: true,
    can_view_all_leads: true,
    can_view_user_page: true,
    can_view_aiweave: true,
  },
};

export const MOCK_TASKS = [
  {
    id: "task-101",
    _id: "task-101",
    title: "GST-3B Monthly Filing - May 2026",
    description: "Reconcile sales and purchase registers and file GSTR-3B before the 20th.",
    status: "in_progress",
    priority: "high",
    client_name: "Apex Global Logistics Pvt Ltd",
    client_id: "cli-01",
    due_date: "2026-05-20",
    assigned_to: "Admin User",
    category: "GST Compliance",
    created_at: "2026-05-01T09:00:00Z",
  },
  {
    id: "task-102",
    _id: "task-102",
    title: "ROC Form AOC-4 & MGT-7 Filing",
    description: "Annual financial statement and annual return filing with MCA portal.",
    status: "pending",
    priority: "urgent",
    client_name: "Zenith Infotech Solutions Ltd",
    client_id: "cli-02",
    due_date: "2026-05-30",
    assigned_to: "Rohan Verma",
    category: "ROC Compliance",
    created_at: "2026-05-02T11:30:00Z",
  },
  {
    id: "task-103",
    _id: "task-103",
    title: "Statutory Tax Audit FY 2025-26",
    description: "Complete 3CD checklist verification and vouching of capital expenditures.",
    status: "in_progress",
    priority: "medium",
    client_name: "Starlight Pharma Healthcare",
    client_id: "cli-03",
    due_date: "2026-06-15",
    assigned_to: "Priya Sharma",
    category: "Income Tax",
    created_at: "2026-05-05T14:15:00Z",
  },
  {
    id: "task-104",
    _id: "task-104",
    title: "TDS Return 26Q Q4 Verification",
    description: "Reconcile Challan payment details with Form 16A generation queue.",
    status: "completed",
    priority: "low",
    client_name: "Blue Horizon Exports",
    client_id: "cli-04",
    due_date: "2026-05-10",
    assigned_to: "Admin User",
    category: "Direct Tax",
    created_at: "2026-04-28T10:00:00Z",
  },
];

export const MOCK_CLIENTS = [
  {
    id: "cli-01",
    _id: "cli-01",
    name: "Apex Global Logistics Pvt Ltd",
    company_name: "Apex Global Logistics Pvt Ltd",
    pan: "AABCA1234F",
    gstin: "27AABCA1234F1Z5",
    cin: "U74999MH2018PTC312345",
    email: "accounts@apexlogistics.in",
    phone: "+91 98200 12345",
    city: "Mumbai",
    state: "Maharashtra",
    status: "active",
    contact_person: "Rajesh Kulkarni",
  },
  {
    id: "cli-02",
    _id: "cli-02",
    name: "Zenith Infotech Solutions Ltd",
    company_name: "Zenith Infotech Solutions Ltd",
    pan: "AAACZ5678K",
    gstin: "29AAACZ5678K1Z2",
    cin: "L72200KA2012PLC065432",
    email: "finance@zenithinfo.com",
    phone: "+91 98450 67890",
    city: "Bengaluru",
    state: "Karnataka",
    status: "active",
    contact_person: "Suresh Menon",
  },
  {
    id: "cli-03",
    _id: "cli-03",
    name: "Starlight Pharma Healthcare",
    company_name: "Starlight Pharma Healthcare",
    pan: "AALCS9876P",
    gstin: "24AALCS9876P1ZX",
    cin: "U24230GJ2020PTC115566",
    email: "compliance@starlightpharma.com",
    phone: "+91 99789 54321",
    city: "Ahmedabad",
    state: "Gujarat",
    status: "active",
    contact_person: "Dr. Ananya Patel",
  },
  {
    id: "cli-04",
    _id: "cli-04",
    name: "Blue Horizon Exports",
    company_name: "Blue Horizon Exports",
    pan: "AAGCB4321M",
    gstin: "07AAGCB4321M1ZN",
    cin: "U51909DL2019PTC345678",
    email: "billing@bluehorizon.net",
    phone: "+91 98111 88888",
    city: "New Delhi",
    state: "Delhi",
    status: "active",
    contact_person: "Vikram Malhotra",
  },
];

export const MOCK_INVOICES = [
  {
    id: "inv-2026-001",
    _id: "inv-2026-001",
    invoice_number: "TSO/26-27/001",
    client_name: "Apex Global Logistics Pvt Ltd",
    client_id: "cli-01",
    amount: 45000,
    gst_amount: 8100,
    total: 53100,
    date: "2026-05-01",
    due_date: "2026-05-15",
    status: "paid",
  },
  {
    id: "inv-2026-002",
    _id: "inv-2026-002",
    invoice_number: "TSO/26-27/002",
    client_name: "Zenith Infotech Solutions Ltd",
    client_id: "cli-02",
    amount: 120000,
    gst_amount: 21600,
    total: 141600,
    date: "2026-05-04",
    due_date: "2026-05-18",
    status: "pending",
  },
  {
    id: "inv-2026-003",
    _id: "inv-2026-003",
    invoice_number: "TSO/26-27/003",
    client_name: "Starlight Pharma Healthcare",
    client_id: "cli-03",
    amount: 75000,
    gst_amount: 13500,
    total: 88500,
    date: "2026-05-06",
    due_date: "2026-05-20",
    status: "draft",
  },
];

export const MOCK_COMPLIANCE = [
  {
    id: "comp-01",
    act: "GST",
    form: "GSTR-3B",
    period: "May 2026",
    due_date: "2026-05-20",
    applicable_clients: 4,
    filed_count: 2,
    pending_count: 2,
    status: "active",
  },
  {
    id: "comp-02",
    act: "Income Tax",
    form: "TDS Payment (Challan 281)",
    period: "April 2026",
    due_date: "2026-05-07",
    applicable_clients: 4,
    filed_count: 4,
    pending_count: 0,
    status: "completed",
  },
  {
    id: "comp-03",
    act: "MCA / Companies Act",
    form: "DIR-3 KYC",
    period: "FY 2025-26",
    due_date: "2026-09-30",
    applicable_clients: 8,
    filed_count: 5,
    pending_count: 3,
    status: "active",
  },
];

export function handleMockRoute(method, url, data) {
  const cleanPath = (url || "").replace(/^https?:\/\/[^/]+/, "");
  const normUrl = (cleanPath.startsWith("/api") ? cleanPath.slice(4) : cleanPath).split("?")[0] || "/";

  // AIWeave is server-authoritative. Do not simulate provider connections,
  // credentials, executions, quota, or routing when the backend is unavailable.
  if (normUrl.startsWith("/aiweave/")) {
    return {
      status: 503,
      data: {
        detail: "AIWeave backend is unavailable. Configure the commercial backend and retry.",
      },
    };
  }

  const getActiveMockUser = () => {
    if (typeof window !== "undefined") {
      try {
        const storedStr = window.sessionStorage.getItem("tasko_active_mock_user") ||
                          window.localStorage.getItem("tasko_active_mock_user") ||
                          window.sessionStorage.getItem("user") ||
                          window.localStorage.getItem("user");
        if (storedStr) {
          const parsed = JSON.parse(storedStr);
          if (parsed && (parsed.is_platform_owner || isPlatformOwner(parsed))) {
            return {
              ...parsed,
              is_platform_owner: true,
              role: "admin",
              permissions: {
                ...derivePermissionsFromModules(["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"]),
                can_access_admin: true,
                can_view_master_data: true,
                can_manage_master_data: true,
                can_view_roles: true,
                can_manage_roles: true,
                can_view_audit_logs: true,
                can_view_staff_activity: true,
              },
            };
          }
          if (parsed && parsed.email) {
            const userModules = parsed.licensed_modules || parsed.modules || ["taskosphere"];
            return {
              ...parsed,
              licensed_modules: userModules,
              permissions: {
                ...derivePermissionsFromModules(userModules),
                ...(parsed.permissions || {}),
              },
            };
          }
        }
      } catch {}
    }
    const licenses = getStoredMockLicenses();
    const activeLic = licenses.find((l) => l.id === MOCK_USER.license_id || l.customer_id === MOCK_USER.company_id) || licenses[0];
    const userModules = activeLic ? (activeLic.modules || activeLic.licensed_modules || ["taskosphere"]) : ["taskosphere"];
    const perms = derivePermissionsFromModules(userModules);
    return {
      ...MOCK_USER,
      licensed_modules: userModules,
      selected_features: activeLic?.selected_features || MOCK_USER.selected_features || {},
      permissions: {
        ...(MOCK_USER.permissions || {}),
        ...perms,
      },
    };
  };

  if (normUrl === "/auth/login" || normUrl === "/auth/signin") {
    const email = String(data?.email || "").trim().toLowerCase();
    const isOwner = email === "csmanthandesai@gmail.com" || isPlatformOwner({ email, role: data?.role });
    const newSessionToken = "sess_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);

    if (typeof window !== "undefined" && window.localStorage && !isOwner && email) {
      window.localStorage.setItem("tasko_active_session_" + email, newSessionToken);
    }

    const activeUser = getActiveMockUser();
    if (email) activeUser.email = email;
    if (isOwner) {
      activeUser.is_platform_owner = true;
      activeUser.role = "admin";
      activeUser.commercial_customer_id = "platform-owner";
      activeUser.license_id = "platform-owner-license";
      activeUser.company_id = "platform-owner-48fe785fdd75127f";
      activeUser.company = { id: "platform-owner-48fe785fdd75127f", name: "Taskosphere Platform Operational" };
      delete activeUser.subscription;
      activeUser.permissions = {
        ...derivePermissionsFromModules(["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"]),
        can_access_admin: true,
        can_view_master_data: true,
        can_manage_master_data: true,
        can_view_roles: true,
        can_manage_roles: true,
        can_view_audit_logs: true,
        can_view_staff_activity: true,
      };
    }
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("tasko_active_mock_user", JSON.stringify(activeUser));
        window.localStorage.setItem("tasko_active_mock_user", JSON.stringify(activeUser));
      } catch {}
    }
    return {
      status: 200,
      data: {
        access_token: `mock-jwt-token-${email || "user"}-${newSessionToken}`,
        token: `mock-jwt-token-${email || "user"}-${newSessionToken}`,
        session_token: newSessionToken,
        user: activeUser,
      },
    };
  }

  if (normUrl === "/auth/me") {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem("user") || window.sessionStorage.getItem("user");
      const currentSessToken = window.localStorage.getItem("session_token") || window.sessionStorage.getItem("session_token");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          const email = String(parsed?.email || "").trim().toLowerCase();
          const isOwner = isPlatformOwner(parsed);
          if (!isOwner && email && currentSessToken) {
            const activeToken = window.localStorage.getItem("tasko_active_session_" + email);
            if (activeToken && activeToken !== currentSessToken) {
              return {
                status: 401,
                data: { detail: "SESSION_REPLACED" },
              };
            }
          }
        } catch {}
      }
    }
    return { status: 200, data: getActiveMockUser() };
  }

  if (normUrl === "/auth/logout") {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem("tasko_active_mock_user");
        window.localStorage.removeItem("tasko_active_mock_user");
      } catch {}
    }
    return { status: 200, data: { success: true } };
  }

  // Website Builder & Public Website Config routes
  const DEFAULT_MOCK_WEBSITE_CONFIG = {
    site_name: "Taskosphere",
    site_tagline: "One platform for tasks, finance, compliance and people.",
    logo_url: "/logo.png",
    favicon_url: "/favicon.png",
    primary_color: "#0D3B66",
    accent_color: "#1FAF5A",
    surface_color: "#F7FAFC",
    hero_badge: "THE MODERN BUSINESS OPERATING SYSTEM",
    hero_title: "Everything your business needs. Nothing scattered.",
    hero_subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
    hero_cta_text: "Explore Taskosphere",
    hero_cta_href: "#features",
    hero_secondary_text: "Sign in",
    hero_secondary_href: "/login",
    hero_image_url: "/logo-transparent.png",
    features_title: "Everything your team needs. Nothing scattered.",
    features_subtitle: "Build the exact software package your customer needs and activate it through your commercial license.",
    features: [
      { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility.", icon: "check" },
      { title: "Invoicing", description: "Quotations, invoices, purchases and customer billing.", icon: "receipt" },
      { title: "Accounting", description: "Ledgers, banking, reports and financial controls.", icon: "landmark" },
      { title: "HRMS", description: "People, attendance, leave, payroll and recruitment.", icon: "users" },
      { title: "Compliance", description: "GST, ROC, trademark and compliance workflows.", icon: "shield" },
      { title: "Records", description: "Client records, documents, approvals and business information.", icon: "check" },
      { title: "AI & Automation", description: "Intelligent document processing and operational assistance.", icon: "sparkles" }
    ],
    solutions_title: "Tailored Solutions for Practice & Enterprise",
    solutions_subtitle: "Scalable tools designed to streamline high-volume statutory filing, taxation, and team management.",
    solutions: [
      {
        title: "Tax & Statutory Compliance",
        description: "Automated GST reconciliation, ROC tracking, and trademark monitoring with deadline reminders.",
        points: ["Auto-sync GST & MCA portals", "Bulk filing status tracker", "Intelligent compliance audit trails"],
      },
      {
        title: "Financials & Ledgers",
        description: "Integrated invoicing, accounting reports, and bank statement processing without switching apps.",
        points: ["Multi-branch invoicing", "Instant P&L and Balance Sheet", "Zero-touch reconciliation"],
      },
      {
        title: "Team & Practice Governance",
        description: "Granular role-based controls, client vaults, and task delegation with SLA tracking.",
        points: ["Role & permission matrix", "Client document vault", "Automated staff time & attendance"],
      },
    ],
    pricing_title: "Simple, transparent licensing",
    pricing_subtitle: "Choose the package that fits your organization.",
    pricing: [
      {
        name: "Professional",
        price: "₹4,999",
        period: "per month",
        description: "Essential tools for growing tax and accounting practices.",
        featured: false,
        cta: "Get Started",
      },
      {
        name: "Enterprise",
        price: "₹14,999",
        period: "per month",
        description: "Comprehensive suite with AI features, multi-company support, and custom modules.",
        featured: true,
        cta: "Contact Sales",
      },
      {
        name: "Platform Owner",
        price: "Custom",
        period: "annual",
        description: "Full white-label deployment with commercial console and unlimited tenant licensing.",
        featured: false,
        cta: "Inquire Now",
      },
    ],
    footer_company: "Taskosphere Technologies Pvt Ltd",
    footer_text: "A configurable commercial business operating system.",
    footer_copyright: "© 2026 Taskosphere. All rights reserved.",
    footer_email: "info.taskosphere@gmail.com",
    footer_phone: "+91 98765 43210",
    footer_address: "Mumbai, India",
    login_background_image: null,
    builder: {
      version: 5,
      activePageId: "home",
      pages: [{
        id: "home", name: "Home", slug: "/", visible: true,
        sections: [
          { id: "hero", type: "hero", title: "Hero", visible: true, layout: "split", data: {
            badge: "THE MODERN BUSINESS OPERATING SYSTEM",
            title: "Everything your business needs. Nothing scattered.",
            subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
            primaryText: "Explore Taskosphere", primaryHref: "#features",
            secondaryText: "Sign in", secondaryHref: "/login", image: "/logo-transparent.png",
            theme: "dark"
          } },
          { id: "features", type: "features", title: "Platform Modules", visible: true, layout: "cards", data: {
            heading: "One platform. Every business function.",
            subtitle: "Choose the exact software package your customer needs and activate it through your commercial license.",
            items: [
              { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility." },
              { title: "Invoicing", description: "Quotations, invoices, purchases and customer billing." },
              { title: "Accounting", description: "Ledgers, banking, reports and financial controls." },
              { title: "HRMS", description: "People, attendance, leave, payroll and recruitment." },
              { title: "Compliance", description: "GST, ROC, trademark and compliance workflows." },
              { title: "Records", description: "Client records, documents, approvals and business information." },
              { title: "AI & Automation", description: "Intelligent document processing and operational assistance." }
            ]
          } },
          { id: "why", type: "text", title: "Why Taskosphere", visible: true, data: {
            heading: "Run work from one connected workspace",
            body: "Assign and track work, communicate with your team, manage documents, monitor productivity and keep financial and compliance operations connected — without scattering information across different systems."
          } },
          { id: "cta", type: "cta", title: "Call to Action", visible: true, layout: "center", data: {
            heading: "Ready to build your Taskosphere workspace?", text: "Configure the modules your business needs and get started.", button: "Get started", href: "/login"
          } }
        ]
      }],
      global: {
        header: { sticky: true, showLogin: true, logo: true },
        footer: { show: true, text: "", social: true },
        design: { primary: "#0D3B66", accent: "#1FAF5A", background: "#FFFFFF", text: "#0F172A", font: "Inter", radius: "medium", width: "wide" }
      }
    }
  };

  const getStoredWebsiteConfig = () => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem("taskosphere_saved_website_config");
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return DEFAULT_MOCK_WEBSITE_CONFIG;
  };

  const syncBuilderToRoot = (cfg) => {
    const updated = { ...cfg };
    if (updated.builder && typeof updated.builder === "object") {
      const idt = updated.builder.global?.identity;
      if (idt) {
        if (idt.siteName) updated.site_name = idt.siteName;
        if (idt.tagline) updated.site_tagline = idt.tagline;
        if (idt.logoUrl) updated.logo_url = idt.logoUrl;
        if (idt.faviconUrl) updated.favicon_url = idt.faviconUrl;
      }
      const dsg = updated.builder.global?.design;
      if (dsg) {
        if (dsg.primary) updated.primary_color = dsg.primary;
        if (dsg.accent) updated.accent_color = dsg.accent;
      }
      const ft = updated.builder.global?.footer;
      if (ft) {
        if (ft.company) updated.footer_company = ft.company;
        if (ft.text) updated.footer_text = ft.text;
        if (ft.copyright) updated.footer_copyright = ft.copyright;
      }
      const firstPage = updated.builder.pages?.[0];
      const hero = firstPage?.sections?.find((s) => s.type === "hero");
      if (hero && hero.data) {
        if (hero.data.title) updated.hero_title = hero.data.title;
        if (hero.data.subtitle) updated.hero_subtitle = hero.data.subtitle;
        if (hero.data.badge) updated.hero_badge = hero.data.badge;
        if (hero.data.primaryText) updated.hero_cta_text = hero.data.primaryText;
        if (hero.data.primaryHref) updated.hero_cta_href = hero.data.primaryHref;
        if (hero.data.secondaryText) updated.hero_secondary_text = hero.data.secondaryText;
        if (hero.data.secondaryHref) updated.hero_secondary_href = hero.data.secondaryHref;
        if (hero.data.image) updated.hero_image_url = hero.data.image;
      }
    }
    return updated;
  };

  if (normUrl === "/website-config/public") {
    const data = getStoredWebsiteConfig();
    return { status: 200, data };
  }

  if (normUrl === "/website-config/admin") {
    const data = getStoredWebsiteConfig();
    return { status: 200, data };
  }

  if (normUrl === "/website-config" && method === "put") {
    const current = getStoredWebsiteConfig();
    const merged = syncBuilderToRoot({ ...current, ...requestData, updated_at: new Date().toISOString() });
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("taskosphere_saved_website_config", JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: merged }));
      }
    } catch {}
    return { status: 200, data: merged };
  }

  if (normUrl === "/website-config/reset" && method === "post") {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("taskosphere_saved_website_config");
        window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: DEFAULT_MOCK_WEBSITE_CONFIG }));
      }
    } catch {}
    return { status: 200, data: DEFAULT_MOCK_WEBSITE_CONFIG };
  }

  if (normUrl.startsWith("/licensing")) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const activeLic = licenses[0] || DEFAULT_MOCK_LICENSES[0];
    return {
      status: 200,
      data: {
        valid: true,
        status: "active",
        packages: [
          { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", modules: ["taskosphere", "finix"], max_users: 10, max_installations: 1, validity_days: 365, price: 4999, active: true },
          { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", modules: ["taskosphere", "finix", "people_matrix"], max_users: 25, max_installations: 2, validity_days: 365, price: 9999, active: true },
          { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix"], max_users: 100, max_installations: 5, validity_days: 365, price: 19999, active: true },
        ],
        licenses: licenses,
        customers: customers,
        license: {
          id: activeLic.id,
          plan: activeLic.package_name || "Custom",
          modules: activeLic.modules || ["taskosphere"],
          licensed_modules: activeLic.modules || ["taskosphere"],
          selected_features: activeLic.selected_features || {},
          max_users: activeLic.max_users || 100,
        },
      },
    };
  }

  if (normUrl.startsWith("/commercial-master-data/licenses")) {
    const parts = normUrl.split("/").filter(Boolean);
    const licenseId = parts[2] || "lic-01";
    const licenses = getStoredMockLicenses();
    if (method === "put") {
      const idx = licenses.findIndex((l) => l.id === licenseId);
      const incomingModules = data?.modules || (idx >= 0 ? licenses[idx].modules : ["taskosphere"]);
      const updated = {
        ...(idx >= 0 ? licenses[idx] : {}),
        id: licenseId,
        ...(data || {}),
        modules: incomingModules,
        licensed_modules: incomingModules,
        selected_features: data?.selected_features || (idx >= 0 ? licenses[idx].selected_features : {}),
        max_users: data?.max_users !== undefined ? Number(data.max_users) : (idx >= 0 ? licenses[idx].max_users : 100),
        max_installations: data?.max_installations !== undefined ? Number(data.max_installations) : (idx >= 0 ? licenses[idx].max_installations : 5),
        updated_at: new Date().toISOString(),
      };
      if (idx >= 0) licenses[idx] = updated;
      else licenses.push(updated);
      saveStoredMockLicenses(licenses);

      // Update customers
      const customers = getStoredMockCustomers();
      customers.forEach((c) => {
        if (c.id === updated.customer_id) {
          c.licensed_modules = updated.modules;
          c.selected_features = updated.selected_features;
        }
      });
      saveStoredMockCustomers(customers);

      // Synchronize MOCK_USER
      const perms = derivePermissionsFromModules(updated.modules);
      MOCK_USER.licensed_modules = updated.modules;
      MOCK_USER.selected_features = updated.selected_features;
      MOCK_USER.permissions = { ...MOCK_USER.permissions, ...perms };

      // Update current user in storage if matching
      if (typeof window !== "undefined" && window.localStorage) {
        try {
          const stored = window.localStorage.getItem("user") || window.sessionStorage.getItem("user");
          if (stored) {
            const parsed = JSON.parse(stored);
            parsed.licensed_modules = updated.modules;
            parsed.selected_features = updated.selected_features;
            parsed.permissions = { ...(parsed.permissions || {}), ...perms };
            window.localStorage.setItem("user", JSON.stringify(parsed));
          }
        } catch {}
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("license-updated", { detail: { license: updated } }));
        window.dispatchEvent(new CustomEvent("commercial-license-updated", { detail: { license: updated } }));
      }

      return { status: 200, data: updated };
    }
    const found = licenses.find((l) => l.id === licenseId) || licenses[0];
    return { status: 200, data: found || {} };
  }

  if (normUrl.startsWith("/commercial-master-data/customers")) {
    const parts = normUrl.split("/").filter(Boolean);
    const customerId = parts[2] || "cust-mda-01";
    const customers = getStoredMockCustomers();
    if (method === "put") {
      const idx = customers.findIndex((c) => c.id === customerId);
      const updated = {
        ...(idx >= 0 ? customers[idx] : {}),
        id: customerId,
        ...(data || {}),
        updated_at: new Date().toISOString(),
      };
      if (idx >= 0) customers[idx] = updated;
      else customers.push(updated);
      saveStoredMockCustomers(customers);
      return { status: 200, data: updated };
    }
    const found = customers.find((c) => c.id === customerId) || customers[0];
    return { status: 200, data: found || {} };
  }

  if (normUrl.startsWith("/commercial-onboarding/lookup")) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const reqKey = String(data?.license_key || "").trim().toUpperCase();
    const reqCompany = String(data?.company_name || "").trim().toLowerCase();

    let lic = licenses.find((l) =>
      (reqKey && String(l.license_key || "").toUpperCase() === reqKey) ||
      (reqCompany && String(l.company_name || "").toLowerCase().includes(reqCompany))
    );
    let cust = lic ? customers.find((c) => c.id === lic.customer_id) : null;
    if (!cust && reqCompany) {
      cust = customers.find((c) => String(c.company_name || "").toLowerCase().includes(reqCompany));
      if (cust) {
        lic = licenses.find((l) => l.customer_id === cust.id);
      }
    }
    if (!lic) lic = licenses[0] || DEFAULT_MOCK_LICENSES[0];
    if (!cust) cust = customers.find((c) => c.id === lic?.customer_id) || customers[0] || DEFAULT_MOCK_CUSTOMERS[0];

    return {
      status: 200,
      data: {
        success: true,
        customer: cust,
        license: lic,
      },
    };
  }

  if (
    normUrl.startsWith("/commercial-onboarding/create-admin") ||
    normUrl.startsWith("/commercial-onboarding/create-user") ||
    normUrl.startsWith("/commercial-onboarding/create-staff")
  ) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const reqKey = String(data?.license_key || "").trim().toUpperCase();
    const lic = licenses.find((l) => String(l.license_key || "").toUpperCase() === reqKey) || licenses[0];
    const cust = lic ? customers.find((c) => c.id === lic.customer_id) : customers[0];

    const newUser = {
      id: `lic-usr-${Date.now()}`,
      email: data?.email || cust?.email || MOCK_USER.email,
      full_name: data?.full_name || cust?.contact_name || MOCK_USER.full_name,
      role: "admin",
      status: "active",
      is_active: true,
      company_id: cust?.id || lic?.customer_id || "cust-ent-01",
      commercial_customer_id: cust?.id || lic?.customer_id || "cust-ent-01",
      license_id: lic?.id || "lic-01",
      licensed_modules: lic?.modules || lic?.licensed_modules || ["taskosphere"],
      selected_features: lic?.selected_features || {},
      company: {
        id: cust?.id || "cust-ent-01",
        name: data?.company_name || cust?.company_name || "Enterprise Solutions",
      },
      permissions: derivePermissionsFromModules(lic?.modules || lic?.licensed_modules || ["taskosphere"]),
    };

    if (!globalThis.__mockPlatformUsers) {
      globalThis.__mockPlatformUsers = [];
    }
    globalThis.__mockPlatformUsers.unshift(newUser);

    const companies = getStoredMockCompanies();
    if (!companies.some((c) => c.id === newUser.company_id)) {
      companies.unshift({
        id: newUser.company_id,
        name: newUser.company.name,
        email: newUser.email,
        status: "active",
        commercial_customer_id: newUser.commercial_customer_id,
        license_id: newUser.license_id,
        license_key: lic?.license_key,
        created_at: new Date().toISOString(),
      });
      saveStoredMockCompanies(companies);
    }

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("tasko_active_mock_user", JSON.stringify(newUser));
        window.localStorage.setItem("tasko_active_mock_user", JSON.stringify(newUser));
      } catch {}
    }

    const newSess = "sess_" + Date.now();
    return {
      status: 200,
      data: {
        success: true,
        access_token: `mock-jwt-token-${newUser.email}-${newSess}`,
        token: `mock-jwt-token-${newUser.email}-${newSess}`,
        session_token: newSess,
        user: newUser,
      },
    };
  }

  if (normUrl.startsWith("/commercial-onboarding/generate-license")) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const newCustId = `cust-${Date.now()}`;
    const newLicId = `lic-${Date.now()}`;
    const licenseKey = `TSO-COMM-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newCustomer = {
      id: newCustId,
      company_name: data?.company_name || "New Enterprise",
      contact_name: data?.admin_name || data?.contact_name || "Admin",
      email: data?.email || "",
      phone: data?.phone || "",
      gstin: data?.gstin || "",
      address: data?.address || data?.gst_address || "",
      city: data?.city || "",
      state: data?.state || "",
      pincode: data?.pincode || "",
      status: "active",
      licensed_modules: data?.selected_modules || ["taskosphere"],
      selected_features: data?.selected_features || {},
      created_at: new Date().toISOString(),
    };

    const validityMonths = Number(data?.validity_months || 12);
    const validUntilDate = new Date();
    validUntilDate.setMonth(validUntilDate.getMonth() + validityMonths);

    const newLicense = {
      id: newLicId,
      customer_id: newCustId,
      license_key: licenseKey,
      company_name: data?.company_name || "New Enterprise",
      package_name: data?.package_name || "Commercial Custom",
      status: "active",
      valid_until: validUntilDate.toISOString(),
      validity_months: validityMonths,
      max_users: Number(data?.max_users || 10),
      max_installations: Number(data?.max_installations || 1),
      modules: data?.selected_modules || ["taskosphere"],
      licensed_modules: data?.selected_modules || ["taskosphere"],
      selected_features: data?.selected_features || {},
      amount_charged: Number(data?.amount_charged || 0),
      currency: data?.currency || "INR",
      notes: data?.notes || "",
      created_at: new Date().toISOString(),
    };

    customers.unshift(newCustomer);
    licenses.unshift(newLicense);
    saveStoredMockCustomers(customers);
    saveStoredMockLicenses(licenses);

    const newCompany = {
      id: newCustId,
      name: newCustomer.company_name,
      contact_name: newCustomer.contact_name,
      email: newCustomer.email,
      phone: newCustomer.phone,
      gstin: newCustomer.gstin,
      address: newCustomer.address,
      city: newCustomer.city,
      state: newCustomer.state,
      pincode: newCustomer.pincode,
      status: "active",
      has_gst: Boolean(newCustomer.gstin),
      commercial_customer_id: newCustId,
      license_id: newLicId,
      license_key: licenseKey,
      source: "commercial-license",
      licensed_modules: newLicense.modules,
      created_at: new Date().toISOString(),
    };
    const currentCompanies = getStoredMockCompanies();
    currentCompanies.unshift(newCompany);
    saveStoredMockCompanies(currentCompanies);

    if (!globalThis.__mockPlatformUsers) {
      globalThis.__mockPlatformUsers = [];
    }
    const newAdminUser = {
      id: `lic-usr-${Date.now()}`,
      email: newCustomer.email || `admin@${newCustomer.company_name.toLowerCase().replace(/[^a-z0-9]/g, "") || "company"}.com`,
      full_name: newCustomer.contact_name || `${newCustomer.company_name} Admin`,
      role: "admin",
      status: "active",
      is_active: true,
      phone: newCustomer.phone || "",
      company_id: newCustId,
      commercial_customer_id: newCustId,
      license_id: newLicId,
      licensed_modules: newLicense.modules,
      selected_features: newLicense.selected_features,
      created_at: new Date().toISOString(),
    };
    globalThis.__mockPlatformUsers.unshift(newAdminUser);

    return {
      status: 200,
      data: {
        success: true,
        customer: newCustomer,
        license: newLicense,
        invoice: {
          invoice_no: `INV-${Date.now().toString().slice(-6)}`,
          amount: newLicense.amount_charged,
          date: new Date().toISOString(),
        },
      },
    };
  }

  if (normUrl.startsWith("/commercial-onboarding/module-catalog")) {
    const catalog = getStoredMockCatalog();
    if (method === "put") {
      const parts = normUrl.split("/").filter(Boolean);
      const modId = parts[2];
      const mod = catalog.find((m) => m.id === modId);
      if (mod) {
        if (data?.monthly_price !== undefined) mod.monthly_price = Number(data.monthly_price);
        if (data?.active !== undefined) mod.active = Boolean(data.active);
        if (data?.feature_prices && Array.isArray(mod.features)) {
          mod.features.forEach((f) => {
            if (data.feature_prices[f.id] !== undefined) {
              f.monthly_price = Number(data.feature_prices[f.id]);
            }
          });
        }
        saveStoredMockCatalog(catalog);
      }
      return { status: 200, data: { success: true, module: mod } };
    }
    return {
      status: 200,
      data: {
        modules: catalog,
      },
    };
  }

  if (normUrl.startsWith("/licensing/licenses/") && normUrl.endsWith("/status")) {
    const parts = normUrl.split("/").filter(Boolean);
    const licId = parts[2];
    const newStatus = data?.status || "active";
    const licenses = getStoredMockLicenses();
    const lic = licenses.find((l) => l.id === licId);
    if (lic) {
      lic.status = newStatus;
      lic.updated_at = new Date().toISOString();
      saveStoredMockLicenses(licenses);
    }
    return { status: 200, data: { success: true, license: lic } };
  }

  if (normUrl.startsWith("/commercial-onboarding/licenses/") && normUrl.endsWith("/company") && method === "delete") {
    const parts = normUrl.split("/").filter(Boolean);
    const licId = decodeURIComponent(parts[2]);
    let licenses = getStoredMockLicenses();
    const lic = licenses.find((l) => l.id === licId);
    const custId = lic?.customer_id;
    licenses = licenses.filter((l) => l.id !== licId);
    saveStoredMockLicenses(licenses);

    if (custId) {
      let customers = getStoredMockCustomers();
      customers = customers.filter((c) => c.id !== custId);
      saveStoredMockCustomers(customers);
    }
    return { status: 200, data: { success: true, message: "Company and license deleted successfully" } };
  }

  if (normUrl.startsWith("/commercial-onboarding/my-company")) {
    return {
      status: 200,
      data: {
        company: {
          id: "comp-tasko-01",
          name: "Taskosphere Commercial Services",
          gstin: "27AAACD1234F1Z5",
          email: "admin@taskosphere.in",
          phone: "+91 98765 43210",
        },
        license: {
          id: "lic-01",
          package_name: "Taskosphere Enterprise",
          valid: true,
          status: "active",
        },
      },
    };
  }

  if (normUrl === "/tasks" || normUrl === "/tasks/") {
    if (method === "post") {
      const newTask = { ...data, id: `task-${Date.now()}`, _id: `task-${Date.now()}`, created_at: new Date().toISOString() };
      MOCK_TASKS.unshift(newTask);
      return { status: 201, data: newTask };
    }
    return { status: 200, data: MOCK_TASKS };
  }

  if (normUrl.startsWith("/clients") || normUrl.startsWith("/client-portal/all-clients")) {
    if (method === "post") {
      const newClient = { ...data, id: `cli-${Date.now()}`, _id: `cli-${Date.now()}` };
      MOCK_CLIENTS.unshift(newClient);
      return { status: 201, data: newClient };
    }
    return { status: 200, data: MOCK_CLIENTS };
  }

  if (normUrl.startsWith("/companies")) {
    const companies = getStoredMockCompanies();
    const parts = normUrl.split("/").filter(Boolean);
    const companyId = parts[1];

    if (method === "delete" && companyId) {
      const filtered = companies.filter((c) => c.id !== companyId);
      saveStoredMockCompanies(filtered);
      return { status: 200, data: { success: true, message: "Company deleted" } };
    }

    if (method === "put" && companyId) {
      const idx = companies.findIndex((c) => c.id === companyId);
      if (idx !== -1) {
        companies[idx] = { ...companies[idx], ...data };
        saveStoredMockCompanies(companies);
        return { status: 200, data: companies[idx] };
      }
      return { status: 404, data: { detail: "Company not found" } };
    }

    if (method === "post") {
      const newComp = {
        id: `comp-${Date.now()}`,
        status: "active",
        ...data,
        created_at: new Date().toISOString(),
      };
      companies.unshift(newComp);
      saveStoredMockCompanies(companies);
      return { status: 201, data: newComp };
    }

    return {
      status: 200,
      data: companies,
    };
  }

  if (normUrl.startsWith("/commercial-licensee-stats")) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const licId = (url.split("license_id=")[1] || "").split("&")[0] || "lic-01";
    const lic = licenses.find((l) => l.id === licId || l.license_key === licId) || licenses[0];
    const cust = customers.find((c) => c.id === lic?.customer_id) || customers[0];
    const users = globalThis.__mockPlatformUsers || [];
    return {
      status: 200,
      data: {
        generated_at: new Date().toISOString(),
        customer: {
          id: cust?.id || "cust-01",
          company_name: cust?.company_name || lic?.company_name || "Commercial Customer",
          email: cust?.email || "admin@customer.com",
        },
        license: {
          id: lic?.id || "lic-01",
          key: lic?.license_key || "TSO-COMM-0001",
          status: lic?.status || "active",
          max_users: lic?.max_users || 10,
          days_remaining: 365,
          modules: lic?.modules || lic?.licensed_modules || ["taskosphere"],
        },
        users: {
          total: users.length || 2,
          active: users.filter((u) => u.status === "active" || u.is_active).length || 2,
          online: 1,
          managers: users.filter((u) => u.role === "manager").length,
          staff: users.filter((u) => u.role === "staff").length,
          admins: users.filter((u) => u.role === "admin").length || 1,
          seat_utilization_percent: Math.round(((users.length || 2) * 100) / (lic?.max_users || 10)),
        },
        tasks: { total: MOCK_TASKS.length || 6, open: 3, completed: 3, overdue: 0 },
        clients: { total: MOCK_CLIENTS.length || 4 },
        invoices: { total: 2, paid_amount: 15000, outstanding_amount: 5000 },
        documents: { total: 4 },
        compliance: { total: MOCK_COMPLIANCE.length || 3 },
        attendance: { records_today: 2 },
        activity: { reports_today: 5 },
      },
    };
  }

  if (normUrl.startsWith("/invoices") || normUrl.startsWith("/sales-invoices")) {
    return { status: 200, data: MOCK_INVOICES };
  }

  if (normUrl.startsWith("/compliance")) {
    return { status: 200, data: MOCK_COMPLIANCE };
  }

  if (normUrl.startsWith("/commercial-master-data/platform-users")) {
    if (!globalThis.__mockPlatformUsers) {
      globalThis.__mockPlatformUsers = [
        {
          id: "lic-usr-01",
          email: "director@desaiassociates.com",
          full_name: "Manthan P Desai",
          role: "admin",
          status: "active",
          is_active: true,
          phone: "+91 98765 43210",
          designation: "Managing Partner",
          employee_code: "MDA-001",
          department_id: "ROC",
          departments: ["ROC", "IT", "GST"],
          company_id: "cust-mda-01",
          commercial_customer_id: "cust-mda-01",
          created_at: new Date().toISOString(),
        },
        {
          id: "lic-usr-02",
          email: "compliance@desaiassociates.com",
          full_name: "Sneha Patel",
          role: "staff",
          status: "active",
          is_active: true,
          phone: "+91 98765 43211",
          designation: "Compliance Executive",
          employee_code: "MDA-002",
          department_id: "GST",
          departments: ["GST", "TDS"],
          company_id: "cust-mda-01",
          commercial_customer_id: "cust-mda-01",
          created_at: new Date().toISOString(),
        },
      ];
    }
    const users = globalThis.__mockPlatformUsers;
    const parts = normUrl.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];

    if (lastPart === "deleted" && method === "get") {
      if (!globalThis.__mockDeletedPlatformUsers) globalThis.__mockDeletedPlatformUsers = [];
      return {
        status: 200,
        data: { users: globalThis.__mockDeletedPlatformUsers },
      };
    }

    if (method === "delete" || (method === "post" && lastPart === "delete")) {
      const targetId = lastPart === "delete" ? secondLast : lastPart;
      const idx = users.findIndex((u) => u.id === targetId);
      if (idx !== -1) {
        const removed = users.splice(idx, 1)[0];
        if (!globalThis.__mockDeletedPlatformUsers) globalThis.__mockDeletedPlatformUsers = [];
        globalThis.__mockDeletedPlatformUsers.unshift({ ...removed, deleted_at: new Date().toISOString() });
      }
      return { status: 200, data: { success: true, message: "User deleted" } };
    }

    if (method === "post" && lastPart === "restore") {
      const targetId = secondLast;
      if (!globalThis.__mockDeletedPlatformUsers) globalThis.__mockDeletedPlatformUsers = [];
      const idx = globalThis.__mockDeletedPlatformUsers.findIndex((u) => u.id === targetId);
      if (idx !== -1) {
        const restored = globalThis.__mockDeletedPlatformUsers.splice(idx, 1)[0];
        delete restored.deleted_at;
        users.unshift(restored);
        return { status: 200, data: { success: true, user: restored } };
      }
      return { status: 200, data: { success: true } };
    }

    if (method === "post" && (lastPart === "activate" || lastPart === "deactivate")) {
      const u = users.find(x => x.id === secondLast);
      if (u) {
        u.status = lastPart === "activate" ? "active" : "inactive";
        u.is_active = lastPart === "activate";
      }
      return { status: 200, data: { success: true, user: u } };
    }

    if (method === "put") {
      const targetId = lastPart;
      const u = users.find(x => x.id === targetId);
      if (u) {
        Object.assign(u, data);
        return { status: 200, data: u };
      }
      return { status: 404, data: { detail: "User not found" } };
    }

    if (method === "post") {
      const newUser = {
        id: `lic-usr-${Date.now()}`,
        status: "active",
        is_active: true,
        departments: [],
        ...data,
        created_at: new Date().toISOString(),
      };
      users.unshift(newUser);
      return { status: 201, data: newUser };
    }

    const activeLic = getStoredMockLicenses().find((l) => l.id === "lic-01" || l.customer_id === "cust-mda-01") || getStoredMockLicenses()[0];
    const userPerms = derivePermissionsFromModules(activeLic.modules);
    const hydratedUsers = users.map((u) => ({
      ...u,
      licensed_modules: activeLic.modules,
      selected_features: activeLic.selected_features,
      permissions: {
        ...(u.permissions || {}),
        ...userPerms,
      },
    }));
    return {
      status: 200,
      data: {
        users: hydratedUsers,
        company: { id: "cust-mda-01", name: "Manthan Desai And Associates" },
        license: activeLic,
        platform_owner: true,
      },
    };
  }

  if (normUrl.startsWith("/commercial-master-data/users")) {
    return {
      status: 200,
      data: {
        users: [
          MOCK_USER,
          {
            id: "usr-02",
            email: "rohan@taskosphere.in",
            full_name: "Rohan Verma",
            role: "Associate",
            status: "active",
            is_active: true,
          },
          {
            id: "usr-03",
            email: "priya@taskosphere.in",
            full_name: "Priya Sharma",
            role: "Manager",
            status: "active",
            is_active: true,
          },
        ],
        company: { id: "comp-tasko-01", name: "Taskosphere Platform Operational" },
        license: { id: "lic-owner", max_users: 999, modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE"] },
        platform_owner: true,
      },
    };
  }

  if (normUrl.startsWith("/users")) {
    let requestingUser = null;
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        const stored = window.localStorage.getItem("user") || window.sessionStorage.getItem("user");
        if (stored) requestingUser = JSON.parse(stored);
      } catch {}
    }
    const isOwnerReq = isPlatformOwner(requestingUser);
    if (isOwnerReq) {
      return {
        status: 200,
        data: [
          {
            id: "usr-admin-01",
            email: requestingUser?.email || "info.taskosphere@gmail.com",
            full_name: requestingUser?.full_name || "Platform Owner",
            role: "admin",
            status: "active",
            is_active: true,
            company_id: "platform-owner-48fe785fdd75127f",
            commercial_customer_id: "platform-owner",
            license_id: "platform-owner-license",
          },
          {
            id: "usr-02",
            email: "rohan@taskosphere.in",
            full_name: "Rohan Verma",
            role: "Associate",
            status: "active",
            is_active: true,
            company_id: "platform-owner-48fe785fdd75127f",
            commercial_customer_id: "platform-owner",
          },
          {
            id: "usr-03",
            email: "priya@taskosphere.in",
            full_name: "Priya Sharma",
            role: "Manager",
            status: "active",
            is_active: true,
            company_id: "platform-owner-48fe785fdd75127f",
            commercial_customer_id: "platform-owner",
          },
        ],
      };
    }

    return {
      status: 200,
      data: [
        MOCK_USER,
      ],
    };
  }

  // ── Free GST API & GST Portal Sync Mock Endpoints ──────────────────────
  if (normUrl.startsWith("/gst/lookup") || normUrl.startsWith("/gst-portal/lookup")) {
    const rawGstin = normUrl.split("/").pop().replace(/^[?].*$/, "") || (requestData && requestData.gstin) || "29AABCU9603R1ZJ";
    const clean = decodeURIComponent(rawGstin).trim().toUpperCase();
    const stateCode = clean.slice(0, 2);
    const STATE_NAMES = {
      '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
      '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar',
      '19':'West Bengal','24':'Gujarat','27':'Maharashtra','29':'Karnataka','33':'Tamil Nadu','36':'Telangana',
    };
    const stateName = STATE_NAMES[stateCode] || 'Maharashtra';
    const pan = clean.slice(2, 12) || 'AABCU9603R';
    const KNOWN = {
      '29AABCU9603R1ZJ': { legal: 'Infosys Limited', trade: 'Infosys', type: 'Public Limited Company', pan: 'AABCU9603R' },
      '27AAACT2882H1Z7': { legal: 'Tata Consultancy Services Ltd', trade: 'TCS', type: 'Public Limited Company', pan: 'AAACT2882H' },
      '27AAACR0442P1Z8': { legal: 'Reliance Industries Limited', trade: 'Reliance', type: 'Public Limited Company', pan: 'AAACR0442P' },
      '29AAACW1682B1ZG': { legal: 'Wipro Limited', trade: 'Wipro', type: 'Public Limited Company', pan: 'AAACW1682B' },
      '07AAAAA0000A1Z4': { legal: 'Indian Oil Corporation Ltd', trade: 'IndianOil', type: 'Government / PSU', pan: 'AAAAA0000A' },
      '24AAAAA0000A1Z8': { legal: 'Gujarat State Petroleum Corp', trade: 'GSPC', type: 'State Government', pan: 'AAAAA0000A' },
    };
    const info = KNOWN[clean] || {
      legal: `Enterprise Taxpayer (${stateName})`,
      trade: `Commercial Taxpayer ${clean.slice(-4)}`,
      type: 'Company (Private / Public Limited)',
      pan: pan,
    };
    return {
      status: 200,
      data: {
        id: `gst-${clean}`,
        gstin: clean,
        valid: clean.length === 15,
        legal_name: info.legal,
        trade_name: info.trade,
        status: clean.length === 15 ? 'Active' : 'Invalid',
        taxpayer_type: 'Regular',
        pan: info.pan,
        state_code: stateCode,
        state_name: stateName,
        entity_type: info.type,
        checksum_valid: clean.length === 15,
        registration_date: '2017-07-01',
        principal_place_of_business: {
          address: `Plot 42, Central Business District, ${stateName}`,
          state: stateName,
          state_code: stateCode,
        },
        filing_frequency: 'Monthly (GSTR-1, GSTR-3B)',
        source: 'Free Live GST API Engine',
        verified_at: new Date().toISOString(),
      },
    };
  }

  if (normUrl === "/gst/verify" || normUrl === "/gst-portal/verify") {
    const clean = (requestData?.gstin || "").trim().toUpperCase();
    return {
      status: 200,
      data: {
        gstin: clean,
        valid: clean.length === 15,
        status: clean.length === 15 ? "Active" : "Invalid",
        taxpayer_type: "Regular",
        legal_name: `Verified Taxpayer (${clean.slice(0, 2)})`,
        source: "Free GST Verification Engine",
        verified_at: new Date().toISOString(),
      },
    };
  }

  if (normUrl === "/gst/bulk-verify") {
    const list = Array.isArray(requestData?.gstins) ? requestData.gstins : [];
    const results = list.map((g) => {
      const clean = (g || "").trim().toUpperCase();
      return {
        gstin: clean,
        valid: clean.length === 15,
        status: clean.length === 15 ? "Active" : "Invalid",
        legal_name: `Verified Entity ${clean.slice(2, 6)}`,
        trade_name: clean.length === 15 ? `Trade ${clean.slice(0, 5)}` : "—",
        state_code: clean.slice(0, 2),
        pan: clean.slice(2, 12),
        taxpayer_type: "Regular",
        source: "Free GST API Bulk Engine",
      };
    });
    return {
      status: 200,
      data: {
        total: results.length,
        valid_count: results.filter((r) => r.valid).length,
        invalid_count: results.filter((r) => !r.valid).length,
        results,
      },
    };
  }

  if (normUrl === "/gst/config") {
    if (method === "post") {
      return { status: 200, data: { success: true, message: "Configuration saved." } };
    }
    return {
      status: 200,
      data: {
        config: {
          id: "global_config",
          provider: "builtin_free",
          provider_name: "Free Built-in Engine & Public Registry",
          api_key: "",
          active: true,
          tier: "Free / Unlimited",
        },
        cache_records_count: 12,
        supported_providers: [
          { id: "builtin_free", name: "Free Built-in Engine (No API key needed, unlimited)", is_free: true },
          { id: "sheetgst", name: "SheetGST / GSTINCheck Free Tier (20 free requests/key)", is_free: true },
          { id: "rapidapi", name: "RapidAPI GSTIN Tool (Free Plan)", is_free: true },
          { id: "custom_gsp", name: "Custom GSP / Government Gateway", is_free: false },
        ],
      },
    };
  }

  if (normUrl.startsWith("/gst-portal/dashboard-metrics")) {
    return {
      status: 200,
      data: {
        portal_configured: true,
        mode: "Free GST API Mode",
        free_api_active: true,
        total_liability: 34250,
        net_available_credits: 48900,
        cash_reserves: 185000,
        discrepancy_pct: 0.0,
        is_audit_risk: false,
        last_synced_at: new Date().toISOString(),
      },
    };
  }

  if (normUrl.startsWith("/gst-portal/snapshot")) {
    return {
      status: 200,
      data: [
        {
          id: "snap-01",
          gstin: "29AABCU9603R1ZJ",
          period: "09-2026",
          outward_cash_liability: 12500,
          outward_total_liability: 34250,
          available_itc: 48900,
          fetched_at: new Date().toISOString(),
        },
        {
          id: "snap-02",
          gstin: "27AAACT2882H1Z7",
          period: "08-2026",
          outward_cash_liability: 9800,
          outward_total_liability: 28400,
          available_itc: 39500,
          fetched_at: new Date(Date.now() - 86400000 * 5).toISOString(),
        },
      ],
    };
  }

  if (normUrl.startsWith("/gst-portal/audit-risk")) {
    return {
      status: 200,
      data: [
        {
          id: "risk-01",
          period: "09-2026",
          gstin: "29AABCU9603R1ZJ",
          portal_liability: 34250,
          internal_liability: 34250,
          variance: 0,
          variance_pct: 0.0,
          is_risk: false,
          computed_at: new Date().toISOString(),
        },
      ],
    };
  }

  if (normUrl.startsWith("/gst-portal/sync-now")) {
    const rawGstin = (data?.gstin || "").trim().toUpperCase() || "29AABCU9603R1ZJ";
    return {
      status: 200,
      data: {
        success: true,
        message: "Synced live liability & credit ledger via Free GST API Engine.",
        snapshot: {
          id: `snap-${Date.now()}`,
          gstin: rawGstin,
          period: "09-2026",
          outward_cash_liability: 14200,
          outward_total_liability: 32000,
          available_itc: 45000,
          fetched_at: new Date().toISOString(),
        },
        audit_risk: {
          period: "09-2026",
          portal_liability: 32000,
          internal_liability: 32000,
          variance: 0,
          variance_pct: 0.0,
          is_risk: false,
        },
      },
    };
  }

  if (normUrl.startsWith("/gst-portal/register") || normUrl.startsWith("/gst-portal/registrations")) {
    return {
      status: 200,
      data: [
        { id: "reg-1", gstin: "29AABCU9603R1ZJ", active: true, created_at: new Date().toISOString() },
        { id: "reg-2", gstin: "27AAACT2882H1Z7", active: true, created_at: new Date().toISOString() },
      ],
    };
  }

  // ── Commercial Console Endpoints (Platform Owner Administration) ─────────────
  if (normUrl === "/commercial-console/system-health") {
    return {
      status: 200,
      data: {
        status: "Healthy",
        last_checked: new Date().toISOString(),
        services: [
          { name: "MongoDB Primary", category: "database", status: "Healthy", latency_ms: 1.5, message: "Operational, responsive", last_checked: new Date().toISOString() },
          { name: "FastAPI Core Application", category: "backend", status: "Healthy", latency_ms: 1.2, message: "Uvicorn async worker running on Python 3.11", last_checked: new Date().toISOString() },
          { name: "AIWeave Omni Engine", category: "ai", status: "Healthy", latency_ms: 4.5, message: "Omni Route active with 3 provisioned accounts", last_checked: new Date().toISOString() },
          { name: "Website Studio & Public Renderer", category: "website", status: "Healthy", latency_ms: 2.1, message: "Visual builder active with SSR/CSR hydration", last_checked: new Date().toISOString() },
          { name: "Commercial Entitlement Engine", category: "licensing", status: "Healthy", latency_ms: 0.8, message: "Enforcing company/license boundaries across all tenants", last_checked: new Date().toISOString() },
          { name: "Transactional Email Service", category: "integrations", status: "Healthy", latency_ms: 10.0, message: "Configured and encrypted", last_checked: new Date().toISOString() },
        ],
        environment: { node_env: "development", region: "global", server_time: new Date().toISOString() },
      },
    };
  }

  if (normUrl === "/commercial-console/analytics") {
    const licenses = getStoredMockLicenses();
    const count = licenses.length || 4;
    return {
      status: 200,
      data: {
        customers: { total: count, active: count, new_this_month: 1, suspended: 0 },
        licenses: { total: count, active: count, expiring_soon: 0, expired: 0 },
        subscriptions: { active: count, trial: 0, past_due: 0, cancelled: 0 },
        usage: { total_users: count * 5, ai_requests: 3420, ai_tokens_estimate: 2804400, storage_gb: 4.2, website_traffic: 1420 },
        mrr_inr: count * 4500,
        arr_inr: count * 54000,
      },
    };
  }

  if (normUrl === "/commercial-console/activity") {
    return {
      status: 200,
      data: {
        logs: [
          { id: "act-1", action: "CONSOLE_INITIALIZED", actor: "admin@taskosphere.com", actor_name: "Platform Owner", target: "Commercial Console Operating System", customer: "System", timestamp: new Date().toISOString(), status: "SUCCESS", details: "Control center session active" },
          { id: "act-2", action: "OMNI_ROUTE_MOUNTED", actor: "System", actor_name: "AIWeave Architecture", target: "POST /api/aiweave/omni", customer: "Global", timestamp: new Date(Date.now() - 1800000).toISOString(), status: "SUCCESS", details: "Universal model routing engine active with automatic fallback" },
          { id: "act-3", action: "LICENSE_ACTIVE", actor: "System", actor_name: "Commercial Entitlement", target: "Apex Global Logistics", customer: "Apex Global", timestamp: new Date(Date.now() - 3600000).toISOString(), status: "SUCCESS", details: "Enterprise suite active" },
        ],
      },
    };
  }

  if (normUrl === "/commercial-console/omni-settings") {
    if (method === "put") {
      return { status: 200, data: { status: "success", settings: data } };
    }
    return {
      status: 200,
      data: {
        key: "aiweave_omni_config",
        routing_mode: "AUTO",
        fallback_enabled: true,
        max_attempts: 3,
        timeout_seconds: 30,
        circuit_breaker_enabled: true,
        cooldown_seconds: 60,
        preferred_provider: "auto",
        updated_at: new Date().toISOString(),
      },
    };
  }

  if (normUrl === "/commercial-console/domains") {
    if (method === "post") {
      return {
        status: 200,
        data: {
          status: "success",
          domain: {
            id: `dom-${Date.now()}`,
            domain: data?.domain || "custom.example.com",
            website_id: data?.website_id || "default",
            status: "dns_pending",
            ssl: "pending",
            dns_status: "cname_required",
            is_primary: Boolean(data?.is_primary),
            target_cname: "sites.taskosphere.com",
            created_at: new Date().toISOString(),
          },
        },
      };
    }
    return {
      status: 200,
      data: {
        domains: [
          { id: "dom-1", domain: "taskosphere.com", website_id: "default", status: "connected", ssl: "active", dns_status: "verified", is_primary: true, created_at: new Date().toISOString() },
        ],
      },
    };
  }

  if (normUrl.startsWith("/commercial-console/domains/")) {
    return { status: 200, data: { status: "success", deleted: normUrl.split("/").pop() } };
  }

  if (normUrl === "/commercial-console/plans") {
    if (method === "post") {
      return { status: 200, data: { status: "success", plan: { ...data, id: data?.id || `plan-${Date.now()}` } } };
    }
    return {
      status: 200,
      data: {
        plans: [
          { id: "starter", name: "Starter", code: "PLAN-STARTER", description: "Essential task management and invoicing for small firms", modules: ["taskosphere", "finix"], max_users: 5, max_storage_gb: 5, max_ai_requests: 25000, monthly_price: 2499.0, support_level: "Standard", active: true },
          { id: "professional", name: "Professional", code: "PLAN-PRO", description: "Full accounting, compliance, AI documents, and task management", modules: ["taskosphere", "finix", "aiweave", "compliance"], max_users: 20, max_storage_gb: 25, max_ai_requests: 100000, monthly_price: 5999.0, support_level: "Priority", active: true },
          { id: "enterprise", name: "Enterprise Complete", code: "PLAN-ENTERPRISE", description: "Unlimited full suite with LeadSense, Records, People Matrix & Website Studio", modules: ["taskosphere", "finix", "aiweave", "compliance", "records", "proposals", "people_matrix"], max_users: 100, max_storage_gb: 100, max_ai_requests: 500000, monthly_price: 14999.0, support_level: "Dedicated 24/7", active: true },
        ],
      },
    };
  }

  if (normUrl === "/commercial-console/email/config") {
    if (method === "put") {
      return { status: 200, data: { status: "success", config: data } };
    }
    return {
      status: 200,
      data: {
        provider_type: "smtp",
        smtp_host: "smtp.sendgrid.net",
        smtp_port: 587,
        smtp_username: "apikey",
        smtp_password_masked: "••••••••",
        sender_name: "TaskoSphere Commercial",
        sender_email: "notifications@taskosphere.com",
        reply_to: "support@taskosphere.com",
        is_active: true,
      },
    };
  }

  if (normUrl === "/commercial-console/email/test") {
    return { status: 200, data: { status: "success", message: `Test email dispatched to ${data?.recipient_email}` } };
  }

  if (normUrl === "/commercial-console/email/stats") {
    return {
      status: 200,
      data: { total_sent: 1240, delivered: 1215, failed: 25, pending: 0, bounce_rate: 1.2 },
    };
  }

  if (normUrl === "/commercial-console/email/templates") {
    return {
      status: 200,
      data: {
        templates: [
          { code: "AUTH_WELCOME", name: "Welcome Email", category: "auth", subject: "Welcome to {{company_name}}", is_active: true, variables: ["user_name", "company_name", "login_url"] },
          { code: "PASSWORD_RESET", name: "Password Reset Request", category: "security", subject: "Reset your password", is_active: true, variables: ["user_name", "otp", "reset_link", "expiry_minutes"] },
          { code: "EMAIL_VERIFICATION", name: "Verify Your Email Address", category: "auth", subject: "Verify your email", is_active: true, variables: ["user_name", "verification_link"] },
          { code: "LICENSE_ACTIVATED", name: "Commercial License Activated", category: "licensing", subject: "Your Taskosphere license is active", is_active: true, variables: ["licensee_name", "license_key", "package_name", "max_users"] },
          { code: "LICENSE_EXPIRING", name: "License Expiring Soon Alert", category: "licensing", subject: "Your license expires soon", is_active: true, variables: ["licensee_name", "expiry_date", "days_remaining"] },
        ],
      },
    };
  }

  if (normUrl.startsWith("/commercial-console/email/templates/") && normUrl.endsWith("/preview")) {
    return {
      status: 200,
      data: {
        status: "success",
        rendered: {
          subject: "Preview: Welcome to TaskoSphere",
          html_body: "<div style='font-family:sans-serif;'><h2>Hello Manthan,</h2><p>Welcome to <strong>TaskoSphere</strong>. Your account is ready.</p></div>",
          text_body: "Hello Manthan,\nWelcome to TaskoSphere. Your account is ready.",
        },
      },
    };
  }

  if (normUrl.startsWith("/commercial-console/email/templates/") && normUrl.endsWith("/test-send")) {
    return { status: 200, data: { status: "success", message: `Test email sent to ${data?.recipient_email}` } };
  }

  if (normUrl.startsWith("/commercial-console/email/templates/") && normUrl.endsWith("/reset")) {
    return { status: 200, data: { status: "success", message: "Template reset to default." } };
  }

  if (normUrl === "/commercial-console/email/logs") {
    return {
      status: 200,
      data: {
        logs: [
          { id: "log-1", template_code: "AUTH_WELCOME", recipient: "manthan@taskosphere.com", status: "delivered", attempts: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { id: "log-2", template_code: "LICENSE_ACTIVATED", recipient: "admin@apexlogistics.com", status: "delivered", attempts: 1, created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: new Date(Date.now() - 3600000).toISOString() },
        ],
        total: 2,
      },
    };
  }

  if (normUrl.startsWith("/commercial-console/email/logs/") && normUrl.endsWith("/retry")) {
    return { status: 200, data: { status: "success", message: "Dispatched retry." } };
  }

  if (normUrl === "/commercial-console/recovery-settings") {
    if (method === "put") {
      return { status: 200, data: { status: "success", settings: data } };
    }
    return {
      status: 200,
      data: {
        settings: {
          otp_expiry_minutes: 15,
          password_reset_token_expiry_minutes: 15,
          max_login_attempts: 5,
          lockout_duration_minutes: 30,
          require_email_verification: true,
          allow_password_reset: true,
        },
      },
    };
  }

  if (normUrl.includes("/commercial-console/licensees/") && normUrl.endsWith("/email-settings")) {
    if (method === "put") {
      return { status: 200, data: { status: "success", message: "Saved licensee email settings." } };
    }
    return {
      status: 200,
      data: {
        customer_id: "cust-1",
        company_name: "Apex Global Logistics Pvt Ltd",
        primary_email: "billing@apexlogistics.com",
        secondary_email: "admin@apexlogistics.com",
        billing_email: "accounts@apexlogistics.com",
        notification_email: "alerts@apexlogistics.com",
        recovery_email: "",
        email_enabled: true,
        email_verified: true,
        notification_preferences: {
          security: true,
          billing: true,
          license: true,
          system: true,
          product_updates: true,
          user_invitations: true,
        },
        last_email_sent: new Date().toISOString(),
      },
    };
  }

  if (normUrl.includes("/commercial-console/users/")) {
    return { status: 200, data: { status: "success", message: "User administrative email action executed successfully." } };
  }

  // Generic fallback for any other GET/POST
  if (method === "get") {
    return { status: 200, data: [] };
  }
  return { status: 200, data: { success: true, message: "OK" } };
}
