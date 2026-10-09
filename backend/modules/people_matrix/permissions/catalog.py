"""Canonical permission module hierarchy shared by governance and licensing.

The pages array intentionally mirrors operational pages visible in the module
sidebars. Feature/action compatibility flags remain separate mappings and are
not presented as extra purchasable pages.
"""

MODULE_HIERARCHY = {
    "taskosphere": {
        "flag": "can_access_taskosphere",
        "label": "Taskosphere",
        "description": "Tasks, To-Do, Attendance, Reminders, Action Center, Client Visits and Client Portal.",
        "pages": [
            {"flag": "can_view_dashboard", "label": "Dashboard", "actions": ["view"]},
            {"flag": "can_view_tasks", "label": "Tasks", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_todo_dashboard", "label": "To Do", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_attendance", "label": "Attendance", "actions": ["view", "edit"]},
            {"flag": "can_view_reminders", "label": "Reminders", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_action_center", "label": "Action Center", "actions": ["view"]},
            {"flag": "can_view_client_visits", "label": "Client Visits", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_client_portal", "label": "Client Portal", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
        ],
    },
    "finix": {
        "flag": "can_access_finix",
        "label": "Finix",
        "description": "Finix Dashboard, Sales, Purchase, Bank Accounts, Journal Entries, Zero Touch Entries, Accounting Reports, Extended Accounts Reports, Live GST Portal Sync, Accounting Integrity and Charts of Accounts.",
        "pages": [
            {"flag": "can_view_finix_dashboard", "label": "Finix Dashboard", "actions": ["view"]},
            {"flag": "can_view_sale", "label": "Sales", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
            {"flag": "can_view_purchase", "label": "Purchase", "actions": ["view", "create", "edit", "delete", "export", "print"]},
            {"flag": "can_view_bank", "label": "Bank Accounts", "actions": ["view", "create", "edit", "export"]},
            {"flag": "can_view_journal_entries", "label": "Journal Entries", "actions": ["view", "create", "edit", "export", "print"]},
            {"flag": "can_view_zero_touch_entries", "label": "Zero Touch Entries", "actions": ["view", "create", "edit"]},
            {"flag": "can_view_accounting_reports", "label": "Accounting Reports", "actions": ["view", "export", "print"]},
            {"flag": "can_view_extended_accounts_reports", "label": "Extended Accounts Reports", "actions": ["view", "export", "print"]},
            {"flag": "can_view_gst_portal_sync", "label": "Live GST Portal Sync", "actions": ["view", "export"]},
            {"flag": "can_view_accounting_integrity", "label": "Accounting Integrity", "actions": ["view", "edit", "approve"]},
            {"flag": "can_view_chart_of_accounts", "label": "Charts of Accounts", "actions": ["view", "create", "edit", "delete", "export"]},
        ],
    },
    "aiweave": {
        "flag": "can_access_aiweave",
        "label": "AIWeave",
        "description": "AI document intelligence and analysis workspace.",
        "pages": [{"flag": "can_view_aiweave", "label": "AIWeave", "actions": ["view", "create"]}],
    },
    "compliance": {
        "flag": "can_access_compliance",
        "label": "CompliGenie",
        "description": "Compliance Dashboard, Compliance Tracker, GST Sphere, Trademark Sphere, ROC Sphere, MIS Report and Salary Slip Generator.",
        "pages": [
            {"flag": "can_view_compliance_dashboard", "label": "Compliance Dashboard", "actions": ["view"]},
            {"flag": "can_view_compliance", "label": "Compliance Tracker", "actions": ["view", "create", "edit", "delete", "approve", "export", "print"]},
            {"flag": "can_view_gst_reconciliation", "label": "GST Sphere", "actions": ["view", "export"]},
            {"flag": "can_view_trademark_sphere", "label": "Trademark Sphere", "actions": ["view", "create", "edit", "export", "print"]},
            {"flag": "can_view_roc_sphere", "label": "ROC Sphere", "actions": ["view", "create", "edit", "delete", "export", "print"]},
            {"flag": "can_view_mis_report", "label": "MIS Report", "actions": ["view", "create", "edit", "delete", "export", "print"]},
            {"flag": "can_view_salary_slips", "label": "Salary Slip Generator", "actions": ["view", "create", "edit", "delete", "export", "print"]},
        ],
    },
    "records": {
        "flag": "can_access_records",
        "label": "Records",
        "description": "Records Dashboard, DSC Register, Document Register, Clients, Password Vault and Client Approvals.",
        "pages": [
            {"flag": "can_view_records_dashboard", "label": "Records Dashboard", "actions": ["view"]},
            {"flag": "can_view_all_dsc", "label": "DSC Register", "actions": ["view", "export"]},
            {"flag": "can_view_documents", "label": "Document Register", "actions": ["view", "export"]},
            {"flag": "can_view_clients_page", "label": "Clients", "actions": ["view", "create", "edit", "delete", "export"]},
            {"flag": "can_view_passwords", "label": "Password Vault", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_client_approvals", "label": "Client Approvals", "actions": ["view", "approve", "reject"]},
        ],
    },
    "proposals": {
        "flag": "can_access_proposals",
        "label": "LeadSense",
        "description": "Client Proposals Dashboard, Lead Management, Quotations and Client Discussion.",
        "pages": [
            {"flag": "can_view_proposals_dashboard", "label": "Client Proposals Dashboard", "actions": ["view"]},
            {"flag": "can_view_all_leads", "label": "Lead Management", "actions": ["view", "create", "edit", "delete", "export"]},
            {"flag": "can_view_quotations", "label": "Quotations", "actions": ["view", "create", "edit", "delete", "export", "print", "share", "approve"]},
            {"flag": "can_view_client_discussion", "label": "Client Discussion", "actions": ["view", "create", "edit", "delete"]},
        ],
    },
    "people_matrix": {
        "flag": "can_access_people_matrix",
        "label": "People Matrix",
        "description": "People Matrix Dashboard, Leave, Payroll, HR and Recruitment. Users remains a tenant-administration control-plane page.",
        "pages": [
            {"flag": "can_view_people_matrix_dashboard", "label": "People Matrix Dashboard", "actions": ["view"]},
            {"flag": "can_view_leave", "label": "Leave", "actions": ["view", "create", "edit", "delete", "approve"]},
            {"flag": "can_view_payroll", "label": "Payroll", "actions": ["view", "create", "edit", "export"]},
            {"flag": "can_view_hr", "label": "HR", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_recruitment", "label": "Recruitment", "actions": ["view", "create", "edit", "delete", "export"]},
        ],
    },
    "admin": {
        "flag": "can_access_admin",
        "label": "Admin",
        "description": "Tenant administration — Users, Permission Matrix, Settings, Master Data and Roles.",
        "pages": [
            {"flag": "can_view_user_page", "label": "Users", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_manage_permissions", "label": "Permission Matrix", "actions": ["view", "edit", "approve"]},
            {"flag": "can_manage_settings", "label": "Settings", "actions": ["view", "edit"]},
            {"flag": "can_view_master_data", "label": "Master Data (view)", "actions": ["view"]},
            {"flag": "can_manage_master_data", "label": "Master Data (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_roles", "label": "Roles (view)", "actions": ["view"]},
            {"flag": "can_manage_roles", "label": "Roles (manage)", "actions": ["create", "edit", "delete"]},
        ],
    },
}

# Existing licenses store some old combined dashboard/page flags and
# non-sidebar feature flags. Convert selections forward without revoking access.
LEGACY_PAGE_SELECTION_ALIASES = {
    "taskosphere": {
        "can_reset_client_passwords": ["can_view_client_portal"],
    },
    "finix": {
        "can_view_accounting_reports": ["can_view_finix_dashboard"],
        "can_view_depreciation": ["can_view_extended_accounts_reports"],
        "can_view_tds_tcs": ["can_view_extended_accounts_reports"],
        "can_view_financial_ratios": ["can_view_extended_accounts_reports"],
        "can_view_comparative_report": ["can_view_extended_accounts_reports"],
        "can_view_yearly_report": ["can_view_extended_accounts_reports"],
        "can_view_opening_balances": ["can_view_extended_accounts_reports"],
        "can_view_accounting_audit_trail": ["can_view_extended_accounts_reports"],
        "can_view_bulk_import": ["can_view_extended_accounts_reports"],
        "can_view_due_dates": ["can_view_extended_accounts_reports"],
        "can_view_import_invoices": ["can_view_sale"],
        "can_manage_chart_of_accounts": ["can_view_chart_of_accounts"],
        "can_post_journal_entries": ["can_view_journal_entries"],
        "can_match_bank": ["can_view_bank"],
        "can_view_finix_ai": ["can_view_finix_dashboard"],
    },
    "compliance": {
        "can_view_compliance": ["can_view_compliance_dashboard"],
        "can_manage_compliance": ["can_view_compliance"],
        "can_manage_mis_report": ["can_view_mis_report"],
        "can_manage_salary_slips": ["can_view_salary_slips"],
        "can_manage_roc_sphere": ["can_view_roc_sphere"],
    },
    "records": {
        "can_view_documents": ["can_view_records_dashboard"],
        "can_view_all_clients": ["can_view_clients_page"],
        "can_view_clients": ["can_view_clients_page"],
        "can_approve_clients": ["can_view_client_approvals"],
        "can_edit_clients": ["can_view_all_clients"],
        "can_edit_passwords": ["can_view_passwords"],
        "can_access_whatsapp_hub": ["can_view_records_dashboard"],
        "can_view_automation_approvals": ["can_view_records_dashboard"],
        "can_approve_whatsapp_wishes": ["can_view_records_dashboard"],
        "can_approve_email_wishes": ["can_view_records_dashboard"],
    },
    "proposals": {
        "can_view_all_leads": ["can_view_proposals_dashboard"],
        "can_create_quotations": ["can_view_quotations"],
        "can_manage_client_discussion": ["can_view_client_discussion"],
    },
    "people_matrix": {
        "can_view_people_matrix": ["can_view_people_matrix_dashboard"],
        "can_view_user_page": ["can_view_people_matrix_dashboard"],
        "can_manage_leave": ["can_view_leave"],
        "can_manage_payroll": ["can_view_payroll"],
        "can_manage_hr": ["can_view_hr"],
        "can_manage_recruitment": ["can_view_recruitment"],
        "can_view_performance": ["can_view_people_matrix_dashboard"],
        "can_manage_performance": ["can_view_people_matrix_dashboard"],
    },
}

# Legacy flags still checked by older endpoints, but no longer independent
# Commercial Console selections. Existing selected_features may retain them.
LEGACY_HIDDEN_LICENSE_FLAGS = {
    "taskosphere": {"can_reset_client_passwords", "can_view_staff_activity", "can_view_reports", "can_download_reports", "can_view_audit_logs"},
    "finix": {"can_manage_chart_of_accounts", "can_post_journal_entries", "can_match_bank", "can_view_depreciation", "can_view_tds_tcs", "can_view_financial_ratios", "can_view_comparative_report", "can_view_yearly_report", "can_view_opening_balances", "can_view_accounting_audit_trail", "can_view_bulk_import", "can_view_due_dates", "can_view_import_invoices", "can_view_finix_ai"},
    "compliance": {"can_manage_compliance", "can_manage_mis_report", "can_manage_salary_slips", "can_manage_roc_sphere"},
    "records": {"can_view_clients", "can_edit_clients", "can_approve_clients", "can_edit_passwords", "can_access_whatsapp_hub", "can_view_automation_approvals", "can_approve_whatsapp_wishes", "can_approve_email_wishes"},
    "proposals": {"can_create_quotations", "can_manage_client_discussion"},
    "people_matrix": {"can_view_people_matrix", "can_view_user_page", "can_manage_leave", "can_manage_payroll", "can_manage_hr", "can_manage_recruitment", "can_view_performance", "can_manage_performance"},
}
