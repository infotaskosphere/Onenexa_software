// permissionGuidance.js — one shared dictionary of plain-English guidance
// notes for every permission module, page flag and action verb.
//
// Both the Admin → Permission Matrix page AND the Users → Access Governance
// dialog import from here, so the two screens always explain a permission
// the same way. Add a note here once and it shows up in both places.

/** Module-level guidance (keyed by module key from /permission-governance/module-tree). */
export const MODULE_GUIDANCE = {
  taskosphere: 'Master switch for day-to-day work. Turning this OFF hides Tasks, To-Do, Attendance, Reminders, Action Center, Visits and the Client Portal manager for this user — even if the individual pages below are ticked.',
  finix: 'Accounting module. Grant only to finance staff: it exposes sales, purchase, bank balances and the general ledger. Journal posting and bank matching are separate, stronger rights inside it.',
  compliance: 'Statutory work — Compliance Tracker, GST Sphere, Trademark Sphere, ROC Sphere, MIS and salary slips. "View" rights are safe for reviewers; "manage" rights let the user change filed/compliance status.',
  records: 'The records vault — DSC register, documents, client master and the password vault. Treat the Password Vault pages as the most sensitive rights in the entire app.',
  proposals: 'Pre-sales — leads, quotations and client discussions. Quotation rights include share/print, so the user can send documents on the firm\u2019s letterhead.',
  people_matrix: 'HR side of the app — directory, leave, payroll, recruitment and performance. Payroll and HR "manage" rights expose salary and personal data of colleagues.',
  admin: 'Admin is granted by ROLE, not by these switches. A user with role = admin always has everything; a non-admin can never be given the Admin module here.',
};

/** Page-level guidance (keyed by permission flag). */
export const PAGE_GUIDANCE = {
  // ── Taskosphere ──
  can_view_dashboard: 'The landing dashboard with KPIs and widgets. Almost everyone should have this.',
  can_view_tasks: 'See the task board. What they actually see is still limited by Cross-User visibility below.',
  can_view_todo_dashboard: 'Personal + team to-do overview. Safe for all staff.',
  can_view_attendance: 'Punch in/out records. Editing lets them change past attendance — keep edit rights with HR only.',
  can_view_reminders: 'Reminder centre. Create/edit lets them schedule reminders for other users.',
  can_view_action_center: 'Aggregated "needs your attention" queue. Read-only.',
  can_view_client_visits: 'Field visit log. Pair with "View All Visits" if they must see colleagues\u2019 visits.',
  can_view_ai_document_reader: 'Uploads documents to the AI extractor. Uses AI credits on every parse.',
  can_view_client_portal: 'Manage client portal logins and what clients can see. Sensitive — client-facing.',
  can_reset_client_passwords: 'Lets the user reset a client portal password. Give to support staff only.',

  // ── Finix ──
  can_view_accounting_reports: 'Finix dashboard, P&L and other accounting reports. Reveals firm-wide financials.',
  can_view_sale: 'Sales & invoicing. Share/print rights mean they can send invoices to clients.',
  can_view_purchase: 'Purchase bills and vendor spend.',
  can_view_bank: 'Bank accounts and balances. Read-heavy but highly sensitive.',
  can_view_chart_of_accounts: 'Read the ledger structure.',
  can_manage_chart_of_accounts: 'Create/rename/delete ledgers — changes how every report groups. Senior accountants only.',
  can_view_journal_entries: 'Read journal entries.',
  can_post_journal_entries: 'Post and approve journal entries, including Zero Touch Entry. This writes to the books.',
  can_match_bank: 'Match/unmatch bank lines during reconciliation.',

  // ── Compliance ──
  can_view_compliance: 'Read the compliance tracker and due dates.',
  can_manage_compliance: 'Change compliance status, add/delete due dates and approve filings.',
  can_view_gst_reconciliation: 'GSTR-2A/2B vs books reconciliation. Give to the GST desk.',
  can_view_trademark_sphere: 'Trademark portfolio, deadlines and portal sync.',
  can_view_mis_report: 'Read MIS reports prepared for clients/management.',
  can_manage_mis_report: 'Create, edit, delete and upload MIS report data.',
  can_view_salary_slips: 'View generated salary slips — exposes colleague pay.',
  can_manage_salary_slips: 'Generate and delete salary slips.',

  // ── Records ──
  can_view_all_dsc: 'Digital Signature Certificate register — holder, expiry and custody.',
  can_view_documents: 'Physical/scanned document register.',
  can_view_passwords: 'Read entries in the Password Vault. Highest-risk view right in the app — grant sparingly and review often.',
  can_edit_passwords: 'Add, change and delete vault credentials. Restrict to the vault owner(s).',
  can_view_all_clients: 'See clients belonging to other users, not just their own assignments.',
  can_edit_clients: 'Edit any client master record (name, GSTIN, contacts).',
  can_approve_clients: 'Approve newly added clients so they go live across the app.',
  can_approve_whatsapp_wishes: 'Approve outbound WhatsApp birthday/festival messages before they send.',
  can_approve_email_wishes: 'Approve outbound email greetings before they send.',

  // ── Client Proposals ──
  can_view_all_leads: 'Whole lead pipeline, including other users\u2019 leads.',
  can_create_quotations: 'Build, share, print and approve quotations on firm letterhead.',
  can_view_client_discussion: 'Read discussion threads logged against a client.',
  can_manage_client_discussion: 'Post, edit and delete discussion entries.',

  // ── People Matrix ──
  can_view_user_page: 'Team directory — names, roles, contact details.',
  can_view_leave: 'See leave applications and balances.',
  can_manage_leave: 'Apply on behalf of others, edit and approve/reject leave.',
  can_view_payroll: 'View payroll runs — exposes salary data.',
  can_manage_payroll: 'Run and approve payroll. Finance/HR heads only.',
  can_view_hr: 'HR records for employees.',
  can_manage_hr: 'Create/edit/delete HR records and employee documents.',
  can_view_recruitment: 'Candidate pipeline and interview schedule.',
  can_manage_recruitment: 'Move candidates, record interviews and convert a hire into a user account.',
  can_view_performance: 'Performance reviews and scores.',
  can_manage_performance: 'Create and edit performance reviews.',

  // ── Admin ──
  can_manage_permissions: 'Edit other people\u2019s permissions — effectively the keys to the building.',
  can_view_audit_logs: 'Read the tamper-evident audit trail of who changed what.',
  can_manage_settings: 'Change organization-wide configuration (branding, integrations, numbering).',
  can_view_master_data: 'Read company profiles and shared reference lists.',
  can_manage_master_data: 'Add/edit/delete company profiles, bank details, SMTP and reference lists used across quotations, invoicing and trademark documents.',
  can_view_roles: 'Read custom role definitions.',
  can_manage_roles: 'Create and change roles — indirectly changes many users at once.',
  can_view_staff_activity: 'Live activity feed of what staff are doing.',

  // ── Cross-cutting / legacy flags also shown in Users dialog ──
  can_view_all_tasks: 'Removes the "only my tasks" restriction across the app.',
  can_assign_tasks: 'Delegate tasks to other users.',
  can_assign_clients: 'Reassign client ownership between users.',
  can_manage_users: 'Create, edit and deactivate team members.',
  can_edit_attendance: 'Rewrite past attendance (mark absent/half-day/leave). HR only.',
  can_send_reminders: 'Trigger email/notification reminders to others.',
  can_receive_popup_reminders: 'Receive on-screen popup reminders. Also needs Cross-Visibility on.',
  can_download_reports: 'Export CSV/PDF copies of data — the main data-exfiltration route, review periodically.',
  can_delete_data: 'Permanently delete records. Irreversible.',
  can_delete_tasks: 'Delete any task, regardless of owner.',
  can_connect_email: 'Link a personal mailbox over IMAP.',
  can_manage_whatsapp: 'Configure the WhatsApp integration for the whole firm.',
  can_access_whatsapp_hub: 'Open the shared WhatsApp inbox and reply as the firm.',
  can_view_own_data: 'Baseline self-service access to their own attendance, tasks and reports.',
};

/** What each action verb means, shown once per page card. */
export const ACTION_GUIDANCE = {
  view: 'Open and read the page.',
  create: 'Add new records.',
  edit: 'Change existing records.',
  update: 'Change existing records.',
  delete: 'Permanently remove records — irreversible.',
  export: 'Download data as CSV/Excel/PDF.',
  approve: 'Sign off on a record so it becomes final.',
  print: 'Print or generate a PDF.',
  share: 'Send the document outside the firm.',
  upload: 'Attach files to the record.',
};

/** Flags that deserve an extra "handle with care" warning in the UI. */
export const HIGH_RISK_FLAGS = new Set([
  'can_view_passwords', 'can_edit_passwords', 'can_manage_permissions',
  'can_manage_users', 'can_delete_data', 'can_delete_tasks',
  'can_post_journal_entries', 'can_manage_payroll', 'can_view_payroll',
  'can_view_salary_slips', 'can_manage_salary_slips', 'can_view_bank',
  'can_manage_settings', 'can_manage_roles', 'can_reset_client_passwords',
  'can_manage_chart_of_accounts',
]);

/** Guidance note for a page flag, with a readable fallback. */
export function pageNote(flag, label = '') {
  return (
    PAGE_GUIDANCE[flag] ||
    (label ? `Controls access to ${label}. Grant only if this user works on it.` : 'Controls access to this page.')
  );
}

/** Guidance note for a module key, with a readable fallback. */
export function moduleNote(moduleKey, description = '') {
  return MODULE_GUIDANCE[moduleKey] || description || 'Master switch for this module — every page inside it depends on it.';
}

export function isHighRisk(flag) {
  return HIGH_RISK_FLAGS.has(flag);
}

export function actionNote(action) {
  return ACTION_GUIDANCE[action] || action;
}
