// Shared permission templates — canonical frontend source for Users → Permissions
// and Admin → Permission Matrix. Keep these defaults synchronized with the
// backend DEFAULT_ROLE_PERMISSIONS model.

export const DEFAULT_ROLE_PERMISSIONS = {
    admin: {
      can_view_tasks: true, can_view_clients: true,
      can_view_all_tasks: true, can_view_all_clients: true, can_approve_clients: true, can_view_all_dsc: true,
      can_approve_whatsapp_wishes: true, can_approve_email_wishes: true,
      can_view_documents: true, can_view_all_duedates: true, can_view_reports: true,
      can_manage_users: true, can_assign_tasks: true, can_view_staff_activity: true,
      can_view_attendance: true, can_send_reminders: true, can_view_user_page: true,
      can_receive_popup_reminders: true,
      can_view_audit_logs: true, can_edit_tasks: true, can_edit_dsc: true,
      can_edit_documents: true, can_edit_due_dates: true, can_edit_users: true,
      can_download_reports: true, can_view_selected_users_reports: true,
      can_view_todo_dashboard: true, can_edit_clients: true, can_use_chat: true,
      can_view_dashboard: true, can_view_reminders: true, can_view_action_center: true,
      can_view_client_visits: true, can_view_aiweave: false,
      can_view_all_leads: true, can_manage_settings: true, can_assign_clients: true,
      can_view_staff_rankings: true, can_delete_data: true, can_delete_tasks: true,
      can_connect_email: true, can_view_own_data: true, can_create_quotations: true,
      can_manage_invoices: true, can_view_passwords: true, can_edit_passwords: true,
      can_edit_attendance: true, can_view_compliance: true, can_manage_compliance: true,
      can_view_gst_reconciliation: true,
      can_view_mis_report: true, can_manage_mis_report: true,
      can_view_salary_slips: true, can_manage_salary_slips: true,
      can_view_all_visits: true, can_edit_visits: true, can_delete_visits: true, can_delete_own_visits: true,
      can_view_client_portal: true,
      can_reset_client_passwords: true,
      can_manage_whatsapp: true,
      can_access_whatsapp_hub: true,
      // ── Main permission modules ──
      can_access_taskosphere: true, can_access_finix: true, can_access_compliance: true,
      can_access_records: true, can_access_proposals: true, can_access_people_matrix: true,
      view_password_departments: [], assigned_clients: [], view_other_tasks: [],
      view_other_attendance: [], view_other_reports: [], view_other_todos: [],
      view_other_activity: [], view_other_visits: [],
    },
    // SCOPE: OWN + SAME_DEPARTMENT (Own + Team)
    // DEFAULT: Only the modules explicitly listed in the Manager permission spec are ON.
    // Everything else is admin-granted only.
    manager: {
      can_view_tasks: true,           // GATE: access /tasks endpoint (scope handled server-side)
      can_view_clients: true,         // GATE: access /clients endpoint (scope handled server-side)
      can_view_all_tasks: false,      // scope handled server-side by department query
      can_view_all_clients: false,    // admin-granted only
      can_approve_clients: false,     // admin-granted only
      can_approve_whatsapp_wishes: false, // admin-granted only
      can_approve_email_wishes: false,    // admin-granted only
      can_view_all_dsc: false,        // admin-granted only
      can_view_documents: false,      // admin-granted only
      can_view_all_duedates: true,    // Compliance Tracker (Calendar panel) → VIEW (Own + Team)
      can_view_reports: true,         // Reports → VIEW (Own + Team)
      can_view_attendance: true,      // Attendance → VIEW (Own + Team)
      can_view_all_leads: false,      // admin-granted only (Leads Pipeline not in default spec)
      can_edit_tasks: true,           // Tasks → EDIT/UPDATE (Own + Team)
      can_edit_clients: false,        // admin-granted only
      can_edit_dsc: false,            // admin-granted only
      can_edit_documents: false,      // admin-granted only
      can_edit_due_dates: true,       // Compliance Tracker (Calendar panel) → EDIT/UPDATE (Own + Team)
      can_edit_users: false,          // admin-granted only
      can_download_reports: true,     // Reports → VIEW includes export (Own + Team)
      can_manage_users: false,        // admin-granted only
      can_manage_settings: true,      // General Settings → VIEW, UPDATE (Own + Team)
      can_assign_tasks: false,        // admin-granted only
      can_assign_clients: false,      // admin-granted only
      can_view_staff_activity: false, // Staff Activity module removed
      can_send_reminders: false,      // admin-granted only
      can_receive_popup_reminders: false, // admin-granted only, also requires cross visibility on
      can_view_user_page: false,      // admin-granted only
      can_view_audit_logs: false,     // admin-granted only
      can_view_recruitment: false,    // admin-granted only
      can_manage_recruitment: false,  // admin-granted only
      can_view_selected_users_reports: true,  // Reports → VIEW (Team scope)
      can_view_todo_dashboard: true,  // To Do → VIEW (Own + Team)
      can_view_dashboard: true,       // Dashboard → VIEW
      can_view_reminders: true,       // Reminders → VIEW (Own + Team)
      can_view_action_center: true,   // Action Center → VIEW (Own + Team)
      can_view_client_visits: true,   // Client Visits → VIEW (Own + Team)
      can_view_aiweave: false, // AIWeave → VIEW (Own + Team)
      can_use_chat: false,            // admin-granted only
      can_view_staff_rankings: false, // admin-granted only
      can_delete_data: false,         // admin-granted only
      can_delete_tasks: false,        // admin-granted only
      can_connect_email: true,        // Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own + Team)
      can_view_own_data: true,        // Dashboard → VIEW
      can_create_quotations: false,   // admin-granted only (Quotations not in default spec)
      can_manage_invoices: false,     // admin-granted only
      can_view_passwords: false,      // admin-granted only
      can_edit_passwords: false,      // admin-granted only
      can_view_compliance: true,      // Compliance Tracker → VIEW (Own + Team)
      can_manage_compliance: true,    // Compliance Tracker → CREATE, EDIT, UPDATE (Own + Team)
      can_edit_attendance: true,      // Attendance → EDIT/UPDATE (Own + Team)
      can_view_gst_reconciliation: false, // admin-granted only (GST dept users)
      can_view_mis_report: false,     // admin-granted only
      can_manage_mis_report: false,   // admin-granted only
      can_view_all_visits: false,     // own + team visits scoped server-side via department query
      can_edit_visits: true,          // Client Visits → EDIT/UPDATE (Own + Team)
      can_delete_visits: false,       // admin-granted only
      can_delete_own_visits: true,    // always allowed for own records
      can_manage_whatsapp: false,     // admin-granted only
      can_access_whatsapp_hub: false,  // ADMIN_GRANTED_ONLY
      can_view_client_portal: false,   // admin-granted only
      can_reset_client_passwords: false,   // admin-granted only
      can_access_taskosphere: true, can_access_finix: false, can_access_compliance: true,
      can_access_records: true, can_access_proposals: true, can_access_people_matrix: true,
      view_password_departments: [], assigned_clients: [], view_other_tasks: [],
      view_other_attendance: [], view_other_reports: [], view_other_todos: [],
      view_other_activity: [], view_other_visits: [],
    },
    // SCOPE: OWN only
    // DEFAULT: Only the modules explicitly listed in the User permission spec are ON.
    // Everything else is admin-granted only.
    staff: {
      can_view_tasks: true,           // GATE: access /tasks endpoint (own scope enforced server-side)
      can_view_clients: true,         // GATE: access /clients endpoint (assigned scope enforced server-side)
      can_view_all_tasks: false,      // scope: own only
      can_view_all_clients: false,    // admin-granted only
      can_approve_clients: false,     // admin-granted only
      can_approve_whatsapp_wishes: false, // admin-granted only
      can_approve_email_wishes: false,    // admin-granted only
      can_view_all_dsc: false,        // admin-granted only
      can_view_documents: false,      // admin-granted only
      can_view_all_duedates: true,    // Compliance Tracker (Calendar panel) → VIEW (Own)
      can_view_reports: true,         // Reports → VIEW (Own)
      can_view_attendance: true,      // Attendance → VIEW (Own)
      can_view_all_leads: false,      // admin-granted only (Leads Pipeline not in default spec)
      can_edit_tasks: true,           // Tasks → EDIT/UPDATE (Own)
      can_edit_clients: false,        // admin-granted only
      can_edit_dsc: false,            // admin-granted only
      can_edit_documents: false,      // admin-granted only
      can_edit_due_dates: true,       // Compliance Tracker (Calendar panel) → EDIT/UPDATE (Own)
      can_edit_users: false,          // admin-granted only
      can_download_reports: true,     // Reports → VIEW includes export (Own)
      can_manage_users: false,        // admin-granted only
      can_manage_settings: true,      // General Settings → VIEW, UPDATE (Own)
      can_assign_tasks: false,        // admin-granted only
      can_assign_clients: false,      // admin-granted only
      can_view_staff_activity: false, // Staff Activity module removed
      can_send_reminders: false,      // admin-granted only
      can_receive_popup_reminders: false, // admin-granted only, also requires cross visibility on
      can_view_user_page: false,      // admin-granted only
      can_view_audit_logs: false,     // admin-granted only
      can_view_recruitment: false,    // admin-granted only
      can_manage_recruitment: false,  // admin-granted only
      can_view_selected_users_reports: false, // admin-granted only (staff sees own reports only)
      can_view_todo_dashboard: true,  // To Do → VIEW (Own)
      can_view_dashboard: true,       // Dashboard → VIEW (Own)
      can_view_reminders: true,       // Reminders → VIEW (Own)
      can_view_action_center: true,   // Action Center → VIEW (Own)
      can_view_client_visits: true,   // Client Visits → VIEW (Own)
      can_view_aiweave: false, // AIWeave → VIEW (Own)
      can_use_chat: false,            // admin-granted only
      can_view_staff_rankings: false, // admin-granted only
      can_delete_data: false,         // admin-granted only
      can_delete_tasks: false,        // admin-granted only
      can_connect_email: true,        // Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own)
      can_view_own_data: true,        // Dashboard → VIEW (Own)
      can_create_quotations: false,   // admin-granted only (Quotations not in default spec)
      can_manage_invoices: false,     // admin-granted only
      can_view_passwords: false,      // admin-granted only
      can_edit_passwords: false,      // admin-granted only
      can_view_compliance: true,      // Compliance Tracker → VIEW (Own)
      can_manage_compliance: true,    // Compliance Tracker → CREATE, EDIT, UPDATE (Own)
      can_edit_attendance: true,      // Attendance → EDIT/UPDATE (Own)
      can_view_gst_reconciliation: false, // admin-granted only (GST dept users)
      can_view_mis_report: false,     // admin-granted only
      can_manage_mis_report: false,   // admin-granted only
      can_view_all_visits: false,     // scope: own visits only (server-side scoped)
      can_edit_visits: true,          // Client Visits → EDIT/UPDATE (Own)
      can_delete_visits: false,       // admin-granted only
      can_delete_own_visits: true,    // always allowed for own records
      can_manage_whatsapp: false,     // admin-granted only
      can_access_whatsapp_hub: false,  // ADMIN_GRANTED_ONLY
      can_view_client_portal: false,   // admin-granted only
      can_reset_client_passwords: false,   // admin-granted only
      can_access_taskosphere: true, can_access_finix: false, can_access_compliance: true,
      can_access_records: true, can_access_proposals: true, can_access_people_matrix: true,
      view_password_departments: [], assigned_clients: [], view_other_tasks: [],
      view_other_attendance: [], view_other_reports: [], view_other_todos: [],
      view_other_activity: [], view_other_visits: [],
    },
  }

export const EMPTY_PERMISSIONS = {
  can_view_tasks: false, can_view_clients: false,
  can_view_all_tasks: false, can_view_all_clients: false, can_approve_clients: false, can_view_all_dsc: false,
  can_approve_whatsapp_wishes: false, can_approve_email_wishes: false,
  can_view_documents: false, can_view_all_duedates: false, can_view_reports: false,
  can_manage_users: false, can_assign_tasks: false, can_view_staff_activity: false,
  can_view_attendance: false, can_send_reminders: false, can_view_user_page: false,
  can_receive_popup_reminders: false,
  can_view_audit_logs: false, can_edit_tasks: false, can_edit_dsc: false,
  can_edit_documents: false, can_edit_due_dates: false, can_edit_users: false,
  can_download_reports: false, can_view_selected_users_reports: false,
  can_view_todo_dashboard: false, can_edit_clients: false, can_use_chat: false,
  can_view_dashboard: false, can_view_reminders: false, can_view_action_center: false,
  can_view_client_visits: false, can_view_aiweave: false,
  can_view_all_leads: false, can_manage_settings: false, can_assign_clients: false,
  can_view_staff_rankings: false, can_delete_data: false, can_delete_tasks: false,
  can_connect_email: false, can_view_own_data: false, can_create_quotations: false,
  can_manage_invoices: false, can_view_passwords: false, can_edit_passwords: false,
  can_edit_attendance: false, can_view_compliance: false, can_manage_compliance: false, can_view_trademark_sphere: false,
  can_view_gst_reconciliation: false,
  can_view_mis_report: false, can_manage_mis_report: false,
  can_view_salary_slips: false, can_manage_salary_slips: false,
  can_view_all_visits: false, can_edit_visits: false,
  can_delete_visits: false, can_delete_own_visits: true,
  can_view_client_portal: false,
  can_reset_client_passwords: false,
  can_manage_whatsapp: false,
  can_access_whatsapp_hub: false,  // ADMIN_GRANTED_ONLY
  // ── Main permission modules ── all start off for a brand-new/blank form;
  // Quick Reset templates above set sensible role defaults. Taskosphere is
  // no longer a locked always-on module — it starts off like every other
  // module here too, and its 9 pages above (Dashboard through Client Portal
  // Manager) start off with it, exactly matching ModuleGovernanceCard's
  // cascade-on-off behavior.
  can_access_taskosphere: false, can_access_finix: false, can_access_compliance: false,
  can_access_records: false, can_access_proposals: false, can_access_people_matrix: false,
  view_password_departments: [], assigned_clients: [], view_other_tasks: [],
  view_other_attendance: [], view_other_reports: [], view_other_todos: [],
  view_other_activity: [], view_other_visits: [],
};



export const PERMISSION_TEMPLATE_ROLES = ['staff', 'manager', 'admin'];
