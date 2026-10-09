from enum import Enum
from typing import Optional, List, Dict, Any
from datetime import date
import re
from pydantic import BaseModel, Field, ConfigDict, EmailStr, field_validator

"""Canonical People Matrix user and permission models.

Extracted verbatim from the legacy model module while preserving the public
model names used by existing authentication and governance code.
"""
# ROLE ENUM
# ────────────────────────────────────────────────
class UserRole(str, Enum):
    admin = "admin"
    manager = "manager"
    staff = "staff"

# ────────────────────────────────────────────────
# DEFAULT ROLE PERMISSION TEMPLATES
# ────────────────────────────────────────────────
DEFAULT_ROLE_PERMISSIONS: Dict[str, Dict[str, Any]] = {
      "admin": {
          # Admin has GLOBAL scope with ALL permissions (VIEW CREATE EDIT DELETE UPDATE)
          "can_view_tasks": True,            # GATE: access /tasks endpoint
          "can_view_clients": True,           # GATE: access /clients endpoint
          "can_view_all_tasks": True,
          "can_view_all_clients": True,
          "can_view_all_dsc": True,
          "can_view_documents": True,
          "can_view_all_duedates": True,
          "can_view_reports": True,
          "can_view_attendance": True,
          "can_view_all_leads": True,
          "can_edit_tasks": True,
          "can_edit_clients": True,
          "can_approve_clients": True,
          "can_edit_dsc": True,
          "can_edit_documents": True,
          "can_edit_due_dates": True,
          "can_edit_users": True,
          "can_download_reports": True,
          "can_manage_users": True,
          "can_manage_settings": True,
          "can_assign_tasks": True,
          "can_assign_clients": True,
          "can_view_staff_activity": True,
          "can_send_reminders": True,
          "can_receive_popup_reminders": True,   # Admin always gets popup reminders
          "can_view_user_page": True,
          "can_view_audit_logs": True,
          "can_view_selected_users_reports": True,
          "can_view_todo_dashboard": True,
          "can_view_dashboard": True,
          "can_view_reminders": True,
          "can_view_action_center": True,
          "can_view_client_visits": True,
          "can_view_aiweave": False,
          "can_use_chat": True,
          "can_view_staff_rankings": True,
          "can_delete_data": True,
          "can_delete_tasks": True,
          "can_connect_email": True,
          "can_view_own_data": True,
          "can_create_quotations": True,
          "can_manage_invoices": True,
          "can_view_passwords": True,
          "can_edit_passwords": True,
          "view_password_departments": [],   # empty = all (admin sees everything)
          "can_view_compliance": True,       # Compliance Tracker — view all categories
          "can_manage_compliance": True,     # Create / edit / delete compliance masters
          "can_view_gst_reconciliation": True,  # GST Reconciliation — admin always has access
          "can_view_trademark_sphere": True,    # Trademark Sphere — admin always has access
          "can_view_mis_report": True,        # MIS Report — admin always has access
          "can_manage_mis_report": True,      # MIS Report — upload / create / delete data
          "can_view_salary_slips": True,        # Salary Slip Generator — admin always has access
          "can_manage_salary_slips": True,
          "can_view_roc_sphere": True,           # ROC Sphere — admin always has access
          "can_manage_roc_sphere": True,         # ROC Sphere — create/edit/delete company masters & generate documents
          "can_access_whatsapp_hub": True,    # WhatsApp Hub
          "can_view_all_visits": True,
          "can_edit_attendance": True,
          "can_edit_visits": True,
          "can_delete_visits": True,
          "can_delete_own_visits": True,
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
          "can_access_whatsapp_hub": True,     # ADMIN_GRANTED_ONLY
          "can_view_recruitment": True,          # Admin always has recruitment access
          "can_manage_recruitment": True,        # Admin always has recruitment access
          "assigned_clients": [],
          # ── Accounts module governance (Bank / Chart of Accounts / Journal) ──
          # Admin has full access by default. Manager/staff must be granted
          # these explicitly by an admin via the Permission Governance portal
          # (Users → Permission Governance → approve an access request).
          "can_view_purchase": True,
          "can_view_sale": True,
          "can_view_bank": True,
          "can_view_chart_of_accounts": True,
          "can_manage_chart_of_accounts": True,
          "can_view_journal_entries": True,
          "can_post_journal_entries": True,
          "can_view_accounting_reports": True,
          "can_match_bank": True,          # Match / Edit Match / Unmatch bank reconciliations
          # ── Main permission module hierarchy — admin has every module on ──
          "can_access_taskosphere": True,
          "can_access_finix": True,
          "can_view_finix_dashboard": True,
          "can_view_compliance_dashboard": True,
          "can_view_records_dashboard": True,
          "can_view_proposals_dashboard": True,
          "can_view_people_matrix_dashboard": True,
          "can_view_client_approvals": True,
          "can_view_quotations": True,
          "can_access_compliance": True,
          "can_access_records": True,
          "can_view_clients_page": True,
          "can_access_proposals": True,
          "can_access_people_matrix": True,
          "can_view_client_portal": True,
          "can_reset_client_passwords": True,
      },
      "manager": {
          # Manager: SCOPE = OWN + SAME_DEPARTMENT (Own + Team)
          # CROSS_VISIBILITY = SAME_DEPARTMENT_USERS
          # DEFAULT: Only modules explicitly listed in the Manager permission spec are ON.
          # Everything else is ADMIN_GRANTED_ONLY.
          # DATA_ACCESS_RULE: resource.department == user.department
          #   AND (resource.user_id == user.id OR resource.user_id IN SAME_DEPARTMENT_USERS)
          "can_view_tasks": True,            # GATE: access /tasks endpoint (scope handled server-side)
          "can_view_clients": True,          # GATE: access /clients endpoint (scope handled server-side)
          "can_view_all_tasks": False,       # SCOPE handled server-side by department query
          "can_view_all_clients": True,      # Manager can view clients
          "can_view_all_dsc": True,          # Manager can view DSCs
          "can_view_documents": True,        # Records → VIEW (Own + Team)
          "can_view_all_duedates": True,     # Compliance Calendar → VIEW (Own + Team)
          "can_view_reports": True,          # Reports → VIEW (Own + Team)
          "can_view_attendance": True,       # Attendance → VIEW (Own + Team)
          "can_view_all_leads": True,        # Proposals / Leads → VIEW
          "can_edit_tasks": True,            # Tasks → EDIT/UPDATE (Own + Team)
          "can_edit_clients": False,         # ADMIN_GRANTED_ONLY
          "can_approve_clients": False,      # ADMIN_GRANTED_ONLY
          "can_edit_dsc": False,             # ADMIN_GRANTED_ONLY
          "can_edit_documents": False,       # ADMIN_GRANTED_ONLY
          "can_edit_due_dates": True,        # Compliance Calendar → EDIT/UPDATE (Own + Team)
          "can_edit_users": False,           # ADMIN_GRANTED_ONLY
          "can_download_reports": True,      # Reports → VIEW includes export (Own + Team)
          "can_manage_users": False,         # ADMIN_GRANTED_ONLY
          "can_manage_settings": True,       # General Settings → VIEW, UPDATE (Own + Team)
          "can_assign_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_assign_clients": False,       # ADMIN_GRANTED_ONLY
          "can_view_staff_activity": False,  # Admin-only — not grantable to manager/staff
          "can_send_reminders": False,       # ADMIN_GRANTED_ONLY
          "can_receive_popup_reminders": False,  # ADMIN_GRANTED_ONLY — also requires cross visibility to be on
          "can_view_user_page": True,        # People Matrix → VIEW
          "can_view_leave": True,            # People Matrix → Leave VIEW
          "can_view_payroll": True,          # People Matrix → Payroll VIEW
          "can_view_hr": True,               # People Matrix → HR VIEW
          "can_view_recruitment": True,      # People Matrix → Recruitment VIEW
          "can_manage_recruitment": False,   # ADMIN_GRANTED_ONLY
          "can_view_audit_logs": False,      # ADMIN_GRANTED_ONLY
          "can_view_selected_users_reports": True,  # Reports → VIEW (Team scope)
          "can_view_todo_dashboard": True,   # To Do → VIEW (Own + Team)
          "can_view_dashboard": True,        # Dashboard → VIEW
          "can_view_reminders": True,        # Reminders → VIEW (Own + Team)
          "can_view_action_center": True,    # Action Center → VIEW (Own + Team)
          "can_view_client_visits": True,    # Client Visits → VIEW (Own + Team)
          "can_view_aiweave": False,  # AIWeave → VIEW (Own + Team)
          "can_use_chat": False,             # ADMIN_GRANTED_ONLY
          "can_view_staff_rankings": False,  # ADMIN_GRANTED_ONLY
          "can_delete_data": False,          # ADMIN_GRANTED_ONLY
          "can_delete_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_connect_email": True,         # Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own + Team)
          "can_view_own_data": True,         # Dashboard → VIEW
          "can_create_quotations": True,     # Proposals → Create Quotations
          "can_view_client_discussion": True, # Proposals → Client Discussion
          "can_manage_invoices": False,      # ADMIN_GRANTED_ONLY
          "can_view_passwords": True,        # Records → Password Vault VIEW
          "can_edit_passwords": False,       # ADMIN_GRANTED_ONLY
          "view_password_departments": [],   # defaults to own departments
          "can_view_compliance": True,       # Compliance Tracker → VIEW (Own + Team)
          "can_manage_compliance": True,     # Compliance Tracker → CREATE, EDIT, UPDATE (Own + Team)
          "can_view_mis_report": True,       # MIS Report → VIEW
          "can_manage_mis_report": False,    # MIS Report — ADMIN_GRANTED_ONLY
          "can_view_salary_slips": True,     # Compliance → Salary Slips
          "can_manage_salary_slips": False,  # ADMIN_GRANTED_ONLY
          "can_view_gst_reconciliation": True, # Compliance → GST Reconciliation
          "can_view_trademark_sphere": True, # Compliance → Trademark Sphere
          "can_view_roc_sphere": True,       # Compliance → ROC Sphere
          "can_edit_attendance": True,       # Attendance → EDIT/UPDATE (Own + Team)
          "can_view_all_visits": False,      # SCOPE handled server-side by department query
          "can_edit_visits": True,           # Client Visits → EDIT/UPDATE (Own + Team)
          "can_delete_visits": False,        # ADMIN_GRANTED_ONLY
          "can_delete_own_visits": True,     # Always allowed
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
          "can_access_whatsapp_hub": False,     # ADMIN_GRANTED_ONLY
          "assigned_clients": [],
          # Accounts module governance — ADMIN_GRANTED_ONLY, request via Permission Governance
          "can_view_purchase": True,
          "can_view_sale": True,
          "can_view_bank": True,
          "can_view_chart_of_accounts": True,
          "can_manage_chart_of_accounts": False,
          "can_view_journal_entries": True,
          "can_post_journal_entries": False,
          "can_view_accounting_reports": True,
          "can_match_bank": True,          # Manager: Match / Edit Match / Unmatch by default (still gated by can_view_bank to reach the page)
          # ── Main permission module hierarchy — In commercial accounts, capped to license
          "can_access_taskosphere": True,
          "can_access_finix": True,
          "can_view_finix_dashboard": True,
          "can_view_compliance_dashboard": True,
          "can_view_records_dashboard": True,
          "can_view_proposals_dashboard": True,
          "can_view_people_matrix_dashboard": True,
          "can_view_client_approvals": False,
          "can_view_quotations": True,
          "can_access_compliance": True,
          "can_access_records": True,
          "can_view_clients_page": True,
          "can_access_proposals": True,
          "can_access_people_matrix": True,
          "can_view_client_portal": False,   # ADMIN_GRANTED_ONLY
          "can_reset_client_passwords": False,   # ADMIN_GRANTED_ONLY
      },
      "staff": {
          # Staff: SCOPE = OWN only
          # DEFAULT: Only modules explicitly listed in the Staff permission spec are ON.
          # Everything else is ADMIN_GRANTED_ONLY.
          # DATA_ACCESS_RULE: resource.department == user.department AND resource.user_id == user.id
          "can_view_tasks": True,            # GATE: access /tasks endpoint (own scope enforced server-side)
          "can_view_clients": True,          # GATE: access /clients endpoint (assigned scope enforced server-side)
          "can_view_all_tasks": False,       # SCOPE: own only
          "can_view_all_clients": False,     # ADMIN_GRANTED_ONLY
          "can_view_all_dsc": False,         # ADMIN_GRANTED_ONLY
          "can_view_documents": False,       # ADMIN_GRANTED_ONLY
          "can_view_all_duedates": True,     # Compliance Calendar → VIEW (Own)
          "can_view_reports": True,          # Reports → VIEW (Own)
          "can_view_attendance": True,       # Attendance → VIEW (Own)
          "can_view_all_leads": False,       # ADMIN_GRANTED_ONLY (Leads Pipeline not in default spec)
          "can_edit_tasks": True,            # Tasks → EDIT/UPDATE (Own)
          "can_edit_clients": False,         # ADMIN_GRANTED_ONLY
          "can_approve_clients": False,      # ADMIN_GRANTED_ONLY
          "can_edit_dsc": False,             # ADMIN_GRANTED_ONLY
          "can_edit_documents": False,       # ADMIN_GRANTED_ONLY
          "can_edit_due_dates": True,        # Compliance Calendar → EDIT/UPDATE (Own)
          "can_edit_users": False,           # ADMIN_GRANTED_ONLY
          "can_download_reports": True,      # Reports → VIEW includes export (Own)
          "can_manage_users": False,         # ADMIN_GRANTED_ONLY
          "can_manage_settings": True,       # General Settings → VIEW, UPDATE (Own)
          "can_assign_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_assign_clients": False,       # ADMIN_GRANTED_ONLY
          "can_view_staff_activity": False,  # Admin-only — not grantable to manager/staff
          "can_send_reminders": False,       # ADMIN_GRANTED_ONLY
          "can_receive_popup_reminders": False,  # ADMIN_GRANTED_ONLY — also requires cross visibility to be on
          "can_view_user_page": False,       # ADMIN_GRANTED_ONLY
          "can_view_audit_logs": False,      # ADMIN_GRANTED_ONLY
          "can_view_selected_users_reports": False, # ADMIN_GRANTED_ONLY (staff sees own reports only)
          "can_view_todo_dashboard": True,   # To Do → VIEW (Own)
          "can_view_dashboard": True,        # Dashboard → VIEW
          "can_view_reminders": True,        # Reminders → VIEW (Own)
          "can_view_action_center": True,    # Action Center → VIEW (Own)
          "can_view_client_visits": True,    # Client Visits → VIEW (Own)
          "can_view_aiweave": False,  # AIWeave → VIEW (Own)
          "can_use_chat": False,             # ADMIN_GRANTED_ONLY
          "can_view_staff_rankings": False,  # ADMIN_GRANTED_ONLY
          "can_delete_data": False,          # ADMIN_GRANTED_ONLY
          "can_delete_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_connect_email": True,         # Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own)
          "can_view_own_data": True,         # Dashboard → VIEW (Own)
          "can_create_quotations": False,    # ADMIN_GRANTED_ONLY (Quotations not in default spec)
          "can_manage_invoices": False,      # ADMIN_GRANTED_ONLY
          "can_view_passwords": False,       # ADMIN_GRANTED_ONLY
          "can_edit_passwords": False,       # ADMIN_GRANTED_ONLY
          "view_password_departments": [],
          "can_view_compliance": True,       # Compliance Tracker → VIEW (Own)
          "can_manage_compliance": True,     # Compliance Tracker → CREATE, EDIT, UPDATE (Own)
          "can_view_mis_report": False,      # MIS Report — ADMIN_GRANTED_ONLY
          "can_manage_mis_report": False,    # MIS Report — ADMIN_GRANTED_ONLY
          "can_edit_attendance": False,      # Attendance correction is Admin-only
          "can_view_all_visits": False,      # SCOPE: own visits only (server-side scoped)
          "can_edit_visits": True,           # Client Visits → EDIT/UPDATE (Own)
          "can_delete_visits": False,        # ADMIN_GRANTED_ONLY
          "can_delete_own_visits": True,     # Always allowed
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
                    "can_access_whatsapp_hub": False,     # ADMIN_GRANTED_ONLY
          "can_view_recruitment": False,         # ADMIN_GRANTED_ONLY
          "can_manage_recruitment": False,       # ADMIN_GRANTED_ONLY
          "assigned_clients": [],
          # Accounts module governance — ADMIN_GRANTED_ONLY, request via Permission Governance
          "can_view_purchase": False,
          "can_view_sale": False,
          "can_view_bank": False,
          "can_view_chart_of_accounts": False,
          "can_manage_chart_of_accounts": False,
          "can_view_journal_entries": False,
          "can_post_journal_entries": False,
          "can_view_accounting_reports": False,
          "can_match_bank": False,          # Staff: view-only by default; admin can grant Match/Edit Match/Unmatch via Permission Governance
          # ── Main permission module hierarchy — Taskosphere always on, the
          # other five are ADMIN_GRANTED_ONLY via the Permission Governance portal.
          "can_access_taskosphere": True,
          "can_access_finix": False,
          "can_view_finix_dashboard": False,
          "can_view_compliance_dashboard": True,
          "can_view_records_dashboard": False,
          "can_view_proposals_dashboard": False,
          "can_view_people_matrix_dashboard": False,
          "can_view_client_approvals": False,
          "can_view_quotations": False,
          "can_access_compliance": False,
          "can_access_records": False,
          "can_view_clients_page": False,
          "can_access_proposals": False,
          "can_access_people_matrix": False,
          "can_view_client_portal": False,   # ADMIN_GRANTED_ONLY
          "can_reset_client_passwords": False,   # ADMIN_GRANTED_ONLY
      },
  }

# ────────────────────────────────────────────────
# MAIN PERMISSION MODULE HIERARCHY
# ────────────────────────────────────────────────
# Single source of truth for the "Permission Governance" hierarchy shown on
# the Users → Permissions → Modules tab. Six main permission modules
# (Taskosphere, Finix, Compliance, Records, Client Proposals, People Matrix)
# each own a master "module access" flag plus a set of individual page-level
# flags that already existed in this system. A page flag can only ever be
# effectively True while its parent module's master flag is also True —
# enforced in backend/permission_governance.py::_enforce_module_hierarchy
# every time permissions are saved, and mirrored in the frontend so a page
# toggle is greyed out until its module is switched on.
#
# NOTE: every page inside Taskosphere — Dashboard, Tasks, To-Do, Attendance,
# Reminders, Action Center, Client Visits, AI Document Reader and Client
# Portal Manager — now carries its own individually-governed page flag, same
# as every other module. All default True for every role (see
# DEFAULT_ROLE_PERMISSIONS above) so nobody loses access on upgrade; an admin
# can revoke any one of them per user from Users → Permission Governance.
# Dashboard is still never enforced with a hard redirect in the frontend
# route guard (see frontend/src/AppRoutes.jsx) — its flag only controls
# whether the Dashboard link shows in the sidebar, so turning it off can
# never create a redirect loop (denied-access redirects always land on
# /dashboard).
MODULE_HIERARCHY: Dict[str, Dict[str, Any]] = {
    "taskosphere": {
        "flag": "can_access_taskosphere",
        "label": "Taskosphere",
        "description": "Core workspace — Tasks, To-Do, Attendance, Reminders, Action Center, Client Visits and Client Portal Manager.",
        "pages": [
            {"flag": "can_view_dashboard",          "label": "Dashboard",           "actions": ["view"]},
            {"flag": "can_view_tasks",               "label": "Tasks",                "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_todo_dashboard",      "label": "To-Do",                "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_attendance",          "label": "Attendance",           "actions": ["view", "edit"]},
            {"flag": "can_view_reminders",           "label": "Reminders",            "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_action_center",       "label": "Action Center",        "actions": ["view"]},
            {"flag": "can_view_client_visits",       "label": "Client Visits",        "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_client_portal",       "label": "Client Portal Manager", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
            {"flag": "can_reset_client_passwords",   "label": "Password Reset", "actions": ["view", "edit", "export"]},
        ],
    },
    "finix": {
        "flag": "can_access_finix",
        "label": "Finix",
        "description": "Accounting & finance — Sales, Purchase, Bank Accounts, Chart of Accounts, Journal Entries and Accounting Reports.",
        "pages": [
            {"flag": "can_view_accounting_reports", "label": "Finix Dashboard & Accounting Reports", "actions": ["view", "export", "print"]},
            {"flag": "can_view_sale",                "label": "Sales / Invoicing", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
            {"flag": "can_view_purchase",             "label": "Purchase", "actions": ["view", "create", "edit", "delete", "export", "print"]},
            {"flag": "can_view_bank",                 "label": "Bank Accounts", "actions": ["view", "create", "export"]},
            {"flag": "can_view_chart_of_accounts",    "label": "Chart of Accounts (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_chart_of_accounts",  "label": "Chart of Accounts (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_journal_entries",      "label": "Journal Entries (view)", "actions": ["view", "export"]},
            {"flag": "can_post_journal_entries",       "label": "Journal Entries & Zero Touch Entry (post)", "actions": ["create", "edit", "approve"]},
            {"flag": "can_match_bank",                "label": "Bank Reconciliation (match/unmatch)", "actions": ["edit"]},
        ],
    },
    "aiweave": {
        "flag": "can_access_aiweave",
        "label": "AIWeave",
        "description": "Unified AI workspace — document intelligence, AI analysis and shared AI workflows.",
        "pages": [
            {"flag": "can_view_aiweave", "label": "AIWeave Workspace", "actions": ["view", "create"]},
        ],
    },
    "compliance": {
        "flag": "can_access_compliance",
        "label": "CompliGenie",
        "description": "Compliance Tracker, GST Reconciliation, Trademark Sphere, MIS Report, Salary Slip Generator and ROC Sphere.",
        "pages": [
            {"flag": "can_view_compliance",          "label": "Compliance Tracker (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_compliance",        "label": "Compliance Tracker (manage)", "actions": ["create", "edit", "delete", "approve"]},
            {"flag": "can_view_gst_reconciliation",  "label": "GST Reconciliation", "actions": ["view", "export"]},
            {"flag": "can_view_trademark_sphere",    "label": "Trademark Sphere", "actions": ["view", "create", "edit", "export", "print"]},
            {"flag": "can_view_mis_report",          "label": "MIS Report (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_mis_report",        "label": "MIS Report (manage)", "actions": ["create", "edit", "delete", "upload"]},
            {"flag": "can_view_salary_slips",        "label": "Salary Slip Generator (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_salary_slips",      "label": "Salary Slip Generator (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_roc_sphere",          "label": "ROC Sphere (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_roc_sphere",        "label": "ROC Sphere (manage)", "actions": ["create", "edit", "delete", "upload"]},
        ],
    },
    "records": {
        "flag": "can_access_records",
        "label": "Client Records",
        "description": "DSC Register, Document Register, Clients (with approval workflow) and Password Vault.",
        "pages": [
            {"flag": "can_view_all_dsc",   "label": "DSC Register", "actions": ["view", "export"]},
            {"flag": "can_view_documents", "label": "Document Register", "actions": ["view", "export"]},
            {"flag": "can_view_passwords", "label": "Password Vault (view)", "actions": ["view"]},
            {"flag": "can_edit_passwords", "label": "Password Vault (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_all_clients", "label": "Clients — visibility of other users' clients", "actions": ["view"]},
            {"flag": "can_edit_clients",     "label": "Clients — edit / update any client", "actions": ["edit", "update"]},
            {"flag": "can_approve_clients",  "label": "Clients — approve newly added clients", "actions": ["approve"]},
            {"flag": "can_approve_whatsapp_wishes", "label": "Automation — approve WhatsApp birthday/festival wishes", "actions": ["approve"]},
            {"flag": "can_approve_email_wishes",    "label": "Automation — approve Email birthday/festival wishes", "actions": ["approve"]},
        ],
    },
    "proposals": {
        "flag": "can_access_proposals",
        "label": "LeadSense",
        "description": "Lead management, quotations and client discussion threads.",
        "pages": [
            {"flag": "can_view_all_leads",    "label": "Lead Management", "actions": ["view", "create", "edit", "delete", "export"]},
            {"flag": "can_create_quotations", "label": "Quotations", "actions": ["view", "create", "edit", "delete", "export", "print", "share", "approve"]},
            {"flag": "can_view_client_discussion",   "label": "Client Discussion (view)", "actions": ["view"]},
            {"flag": "can_manage_client_discussion", "label": "Client Discussion (manage)", "actions": ["create", "edit", "delete"]},
        ],
    },
    "people_matrix": {
        "flag": "can_access_people_matrix",
        "label": "People Matrix",
        "description": "User directory, Attendance, Leave, Payroll, HR, Recruitment (candidate pipeline & interviews) and Performance (HRMS).",
        "pages": [
            {"flag": "can_view_user_page",  "label": "User Directory", "actions": ["view", "export"]},

            {"flag": "can_view_leave",        "label": "Leave (view)", "actions": ["view"]},
            {"flag": "can_manage_leave",      "label": "Leave (manage)", "actions": ["create", "edit", "delete", "approve"]},
            {"flag": "can_view_payroll",      "label": "Payroll (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_payroll",    "label": "Payroll (manage)", "actions": ["create", "edit", "approve"]},
            {"flag": "can_view_hr",           "label": "HR (view)", "actions": ["view"]},
            {"flag": "can_manage_hr",         "label": "HR (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_recruitment",  "label": "Recruitment (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_recruitment","label": "Recruitment (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_performance",  "label": "Performance (view)", "actions": ["view"]},
            {"flag": "can_manage_performance","label": "Performance (manage)", "actions": ["create", "edit"]},
        ],
    },
    # Admin is intentionally NOT gated by a stored per-user flag the way the
    # other six modules are — role == "admin" is itself the gate (see
    # section 1 of the governance spec: "Admin should NEVER require any
    # permission"). It is included here only so the module tree / dynamic
    # sidebar can render it uniformly; `has_module_access()` in
    # backend/governance_core.py special-cases "admin" to `user.role == "admin"`
    # rather than looking up a flag.
    "admin": {
        "flag": "can_access_admin",
        "label": "Admin",
        "description": "Users, Permission Matrix, Audit Logs, Settings, Master Data, Roles and Activity Logs.",
        "pages": [
            {"flag": "can_view_user_page",     "label": "Users", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_manage_permissions", "label": "Permission Matrix", "actions": ["view", "edit", "approve"]},
            {"flag": "can_view_audit_logs",    "label": "Audit Logs", "actions": ["view", "export"]},
            {"flag": "can_manage_settings",    "label": "Settings", "actions": ["view", "edit"]},
            {"flag": "can_view_master_data",   "label": "Master Data (view)", "actions": ["view"]},
            {"flag": "can_manage_master_data", "label": "Master Data (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_roles",         "label": "Roles (view)", "actions": ["view"]},
            {"flag": "can_manage_roles",       "label": "Roles (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_staff_activity","label": "Activity Logs", "actions": ["view", "export"]},
        ],
    },
}

# ======================
# CORE USER & PERMISSIONS
# ======================
class UserPermissions(BaseModel):
    can_view_tasks: bool = True       # GATE flag — all roles True by default
    can_view_clients: bool = True      # GATE flag — all roles True by default
    can_view_all_tasks: bool = False
    can_view_all_clients: bool = False
    can_view_all_dsc: bool = False
    can_view_documents: bool = False
    can_view_all_duedates: bool = False
    can_view_reports: bool = False
    can_view_attendance: bool = False
    # Attendance correction is strictly Admin-only. Backend also enforces role == admin.
    can_edit_attendance: bool = False
    can_view_all_leads: bool = False
    can_edit_tasks: bool = False
    can_edit_clients: bool = False
    # Approve / reject client records created by other users (admin workflow)
    can_approve_clients: bool = False
    # Delegated rights to approve queued automated client messages —
    # separate from can_manage_automation_settings, which controls
    # templates/toggles/festivals (structural config, admin by default).
    can_approve_whatsapp_wishes: bool = False
    can_approve_email_wishes: bool = False
    can_edit_dsc: bool = False
    can_edit_documents: bool = False
    can_edit_due_dates: bool = False
    can_edit_users: bool = False
    can_download_reports: bool = False
    can_manage_users: bool = False
    can_manage_settings: bool = False
    can_assign_tasks: bool = False
    can_assign_clients: bool = False
    can_view_staff_activity: bool = False
    can_send_reminders: bool = False
    can_receive_popup_reminders: bool = False
    can_view_user_page: bool = False
    can_view_audit_logs: bool = False
    can_view_selected_users_reports: bool = False
    can_view_todo_dashboard: bool = False
    # ── Individually-governed Taskosphere pages (see MODULE_HIERARCHY["taskosphere"]
    # in this file). These used to be wide open to every signed-in user with no
    # flag of their own; they now default True for every role so nobody loses
    # access on upgrade, but an admin can revoke any one of them per user from
    # Users → Permission Governance, same as Client Portal Manager already worked.
    can_view_dashboard: bool = True
    can_view_reminders: bool = True
    can_view_action_center: bool = True
    can_view_client_visits: bool = True
    can_view_aiweave: bool = False
    can_use_chat: bool = False
    can_view_staff_rankings: bool = False
    can_delete_data: bool = False
    can_delete_tasks: bool = False
    can_connect_email: bool = True
    can_view_own_data: bool = True
    can_create_quotations: bool = False
    # ── Invoicing & Billing ──────────────────────────────────────────────────
    # Grants access to: create/edit/delete invoices, record payments,
    # download PDFs, manage product catalog.
    # Admin always has this regardless of the flag.
    can_manage_invoices: bool = False
    # ── Password Repository ──────────────────────────────────────────────────
    can_view_passwords: bool = False
    can_edit_passwords: bool = False
    view_password_departments: List[str] = Field(default_factory=list)
    # ── Compliance Tracker ───────────────────────────────────────────────────
    # can_view_compliance  → access the Compliance Tracker page
    #   admin:   all categories; manager/staff: own department categories only
    # can_manage_compliance → create / edit / delete compliance masters
    #   admin/manager: True by default; staff: False (update assignments only)
    can_view_compliance: bool = False
    can_manage_compliance: bool = False
    # ── GST Reconciliation ───────────────────────────────────────────────────
    # can_view_gst_reconciliation → access the GST Reconciliation page
    #   Grant this to GST department users only.
    #   Admin always has access regardless of this flag.
    can_view_gst_reconciliation: bool = False
    # ── Trademark Sphere ─────────────────────────────────────────────────────
    # can_view_trademark_sphere → access the Trademark Sphere page
    #   Admin always has access regardless of this flag.
    can_view_trademark_sphere: bool = False
    # ── MIS Report ───────────────────────────────────────────────────────────
    # can_view_mis_report → access the MIS Report page (Financial Dashboard,
    #   Receivables/Payables/Revenue/Expense/Profitability MIS) for clients
    #   they're allowed to see (scoped by can_view_all_clients/assigned_clients).
    #   Admin always has access regardless of this flag.
    # can_manage_mis_report → upload source documents (sales/purchase/bank/
    #   balance sheet/GST reports), create MIS reports/periods, add new
    #   clients from the MIS screen, and edit manual-entry figures.
    can_view_mis_report: bool = False
    can_manage_mis_report: bool = False
    # ── Salary Slip Generator (Compliance) ───────────────────────────────────
    # Generates payslips for CLIENT COMPANIES' employees (distinct from the
    # People Matrix → Payroll module, which runs payroll for the firm's own
    # staff). Payroll data is sensitive, so — like GST Reconciliation and
    # Trademark Sphere — this is admin-granted only by default.
    can_view_salary_slips: bool = False
    can_manage_salary_slips: bool = False
    # ── ROC Sphere ────────────────────────────────────────────────────────────
    # Companies Act / ROC compliance module — company master, document
    # generation (Board Resolution, Notices, Minutes, Shareholder Register)
    # and the compliance checklist. Like GST Reconciliation, Trademark
    # Sphere and Salary Slips, this is admin-granted only by default.
    # can_view_roc_sphere → open the page, view company masters, checklist,
    #   generate/download documents.
    # can_manage_roc_sphere → create/edit/delete company masters and upload
    #   AOC-4/MGT-7 to prefill them.
    can_view_roc_sphere: bool = False
    can_manage_roc_sphere: bool = False
    # ── Visit-specific permissions ───────────────────────────────────────────
    can_view_all_visits: bool = False
    can_edit_visits: bool = False
    can_delete_visits: bool = False
    can_delete_own_visits: bool = True
    view_other_visits: List[str] = Field(default_factory=list)
    # ── List permissions ─────────────────────────────────────────────────────
    view_other_tasks: List[str] = Field(default_factory=list)
    view_other_attendance: List[str] = Field(default_factory=list)
    view_other_reports: List[str] = Field(default_factory=list)
    view_other_todos: List[str] = Field(default_factory=list)
    view_other_activity: List[str] = Field(default_factory=list)
    assigned_clients: List[str] = Field(default_factory=list)
    can_access_whatsapp_hub: bool = False
    governed_users: List[str] = Field(default_factory=list)   # users this person can manage (when can_manage_users=True)
    # ── Accounts module governance ───────────────────────────────────────────
    # Purchase / Sale / Bank / Chart of Accounts / Journal Entries / Reports.
    # Admin has all of these True by default (see DEFAULT_ROLE_PERMISSIONS).
    # Manager/staff default to False and must be granted access by an admin
    # via the Permission Governance portal (Users → Permission Governance),
    # normally after the user submits an access request from the gated page.
    can_view_purchase: bool = False
    can_view_sale: bool = False
    can_view_bank: bool = False
    can_view_chart_of_accounts: bool = False
    can_manage_chart_of_accounts: bool = False
    can_view_journal_entries: bool = False
    can_post_journal_entries: bool = False
    can_view_accounting_reports: bool = False
    # can_match_bank → Bank Accounts page: Match / Edit Match / Unmatch actions.
    # Distinct from can_view_bank (which only gates read access to the page).
    # Admin: always True. Manager: True by default. Staff: False by default —
    # grant via Permission Governance for permission-based access.
    can_match_bank: bool = False
    # ── Main permission module hierarchy (see MODULE_HIERARCHY above) ────────
    # Master "module access" flags for the seven main areas of the app, shown on
    # Users → Permissions → Modules. A page-level flag above can only ever be
    # effectively True while its parent module flag here is also True.
    # Taskosphere defaults True for every role (matching its historically-open
    # pages), but — unlike before — is now a real, editable master switch: an
    # admin can turn it off for a user, which cascades and clears every page
    # flag nested beneath it (Dashboard, Tasks, To-Do, Attendance, Reminders,
    # Action Center, Client Visits, Client Portal Manager),
    # exactly like Finix/Compliance/Records/Proposals/People Matrix already do.
    can_access_taskosphere: bool = True
    can_view_finix_dashboard: bool = False
    can_view_compliance_dashboard: bool = False
    can_view_records_dashboard: bool = False
    can_view_proposals_dashboard: bool = False
    can_view_people_matrix_dashboard: bool = False
    can_view_clients_page: bool = False
    can_view_client_approvals: bool = False
    can_view_quotations: bool = False
    can_access_finix: bool = False
    can_access_compliance: bool = False
    can_access_records: bool = False
    can_access_proposals: bool = False
    can_access_people_matrix: bool = False
    # AIWeave is deliberately NOT role-granted. Even admins must receive an explicit
    # user-level grant through Permission Matrix / Access Governance.
    can_access_aiweave: bool = False
    # Admin is role-gated, not flag-gated (see MODULE_HIERARCHY["admin"] note
    # above) — this flag exists only for uniform module-tree rendering and is
    # never consulted by has_module_access() for real access decisions.
    can_access_admin: bool = False

    # ── New pages added under the centralized Governance & Permission Matrix
    # (records, proposals, people_matrix, admin) — all default False / staff
    # scope, granted the same way as every other page flag above, through
    # Permission Governance. Nothing here changes any existing flag's
    # behaviour or default.
    can_view_client_discussion: bool = False
    can_manage_client_discussion: bool = False
    can_view_leave: bool = False
    can_manage_leave: bool = False
    can_view_payroll: bool = False
    can_manage_payroll: bool = False
    can_view_hr: bool = False
    can_manage_hr: bool = False
    can_view_recruitment: bool = False
    can_manage_recruitment: bool = False
    can_view_performance: bool = False
    can_manage_performance: bool = False
    can_view_master_data: bool = False
    can_manage_master_data: bool = False
    can_view_roles: bool = False
    can_manage_roles: bool = False
    can_manage_permissions: bool = False   # Admin → Permission Matrix (grant/revoke others' access)
    # ── Client Portal Manager ────────────────────────────────────────────────
    # Lives under the Taskosphere module (see MODULE_HIERARCHY["taskosphere"]
    # above) — grant/revoke per user from Users → Permission Governance /
    # Permission Matrix. Admin always has access regardless of this flag.
    can_view_client_portal: bool = False
    # ── Password Reset (Client Portal Manager → Password Reset) ──────────────
    # Allows resetting client-portal login passwords, including the bulk
    # reset shortcut, and downloading the resulting credentials sheet.
    # Admin always has this; manager/staff must be granted it via Access
    # Governance / Permission Matrix.
    can_reset_client_passwords: bool = False

    # ── Centralized action-level + visibility governance (additive layer) ───
    # `governance_matrix`: { "<module>.<page_flag>": ["view","create","edit",
    #   "delete","export","approve", ...] } — fine-grained action grants on
    # top of the page flags above. A page flag above still gates whether the
    # page is reachable at all (VISIBILITY of the page); this matrix governs
    # which ACTIONS are available once on it. Empty/absent = no per-action
    # restriction beyond the legacy flags (see has_action_access() in
    # backend/governance_core.py for the exact fallback rules — this keeps
    # every page that predates this system working exactly as before).
    governance_matrix: Dict[str, List[str]] = Field(default_factory=dict)
    # `visibility_matrix`: { "<resource_type>": {"scope": "own"|"selected_users"
    #   |"selected_departments"|"selected_roles"|"organization", "selected": [...]}}
    # Generalizes the existing view_other_tasks / assigned_clients / etc.
    # list-fields into one place for NEW resource types going forward.
    # Existing resource types keep using their original list-fields — see
    # has_visibility_access() for the mapping.
    visibility_matrix: Dict[str, Dict[str, Any]] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    email: str
    # Stable hierarchical identity fields. Existing id/_id references remain unchanged.
    user_uid: Optional[str] = None
    identity_type: Optional[str] = None
    identity_org_uid: Optional[str] = None
    platform_owner_uid: Optional[str] = None
    licensee_uid: Optional[str] = None
    email_normalized: Optional[str] = None
    is_platform_owner: Optional[bool] = None
    full_name: Optional[str] = None
    role: UserRole = UserRole.staff
    # Optional custom-role key (see backend/roles_admin.py). `role` always
    # stays one of admin/manager/staff so every existing role check works.
    role_key: Optional[str] = None
    password: Optional[str] = None
    consent_given: bool = False
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    profile_picture: Optional[str] = None
    punch_in_time: Optional[str] = "10:30"
    grace_time: Optional[str] = "00:10"
    punch_out_time: Optional[str] = "19:00"
    telegram_id: Optional[int] = None
    permissions: UserPermissions = Field(default_factory=UserPermissions)

    @field_validator("permissions", mode="before")
    @classmethod
    def normalize_permissions_input(cls, value):
        # Permission records come from MongoDB as plain dictionaries. Validate
        # them explicitly before User-level role/default normalization so an
        # explicitly granted AIWeave flag cannot be silently replaced by the
        # role template.
        if isinstance(value, UserPermissions):
            return value
        if isinstance(value, dict):
            return UserPermissions.model_validate(value)
        return value

    created_at: Optional[Any] = None
    is_active: bool = True
    status: str = "pending_approval"
    approved_by: Optional[str] = None
    approved_at: Optional[Any] = None
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    commercial_customer_id: Optional[str] = None
    license_id: Optional[str] = None
    license_key: Optional[str] = None
    licensed_modules: List[str] = Field(default_factory=list)
    selected_features: Dict[str, Any] = Field(default_factory=dict)
    # ── Email & Recovery fields ──────────────────────────────────────────────
    email_verified: bool = False
    email_verified_at: Optional[Any] = None
    recovery_email: Optional[str] = None
    notification_email: Optional[str] = None
    password_version: int = 1
    password_changed_at: Optional[Any] = None
    last_password_reset_at: Optional[Any] = None
    email_status: Optional[str] = "active"
    email_notifications_enabled: bool = True
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None          # Date the employee joined
    training_period_end: Optional[Any] = None   # End date of the training / probation period
    payroll_date: Optional[Any] = None          # Monthly payroll processing date (day of month or full date)
    monthly_salary: Optional[float] = None      # Gross monthly salary (admin-set); used for salary-due calculation

    @field_validator("monthly_salary", mode="before")
    @classmethod
    def empty_salary_to_none(cls, v):
        if v == "" or v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    @field_validator("birthday", mode="before")
    @classmethod
    def empty_string_to_none(cls, v):
        if v == "" or v is None:
            return None
        return v


class UserCreate(BaseModel):
    full_name: str
    email: str
    password: str
    role: UserRole = UserRole.staff
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    telegram_id: Optional[int] = None
    punch_in_time: Optional[str] = "10:30"
    grace_time: Optional[str] = "00:10"
    punch_out_time: Optional[str] = "19:00"
    profile_picture: Optional[str] = None
    is_active: bool = True
    permissions: Optional[Dict[str, Any]] = None
    status: Optional[str] = "pending_approval"
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    recovery_email: Optional[str] = None
    notification_email: Optional[str] = None
    email_verified: bool = False
    email_notifications_enabled: bool = True
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, v):
        if not isinstance(v, str) or len(v) < 12:
            raise ValueError("Password must be at least 12 characters.")
        return v


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    departments: Optional[List[str]] = None
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    punch_in_time: Optional[str] = None
    grace_time: Optional[str] = None
    punch_out_time: Optional[str] = None
    is_active: Optional[bool] = None
    profile_picture: Optional[str] = None
    telegram_id: Optional[int] = None
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    recovery_email: Optional[str] = None
    notification_email: Optional[str] = None
    email_verified: Optional[bool] = None
    email_status: Optional[str] = None
    email_notifications_enabled: Optional[bool] = None
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None

    @field_validator("password")
    @classmethod
    def validate_optional_password_length(cls, v):
        if v is not None and len(v) < 12:
            raise ValueError("Password must be at least 12 characters.")
        return v

    model_config = ConfigDict(from_attributes=True, extra="ignore")


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str
    user: User
    consent_given: Optional[bool] = None  # Fixed: was 'Noner'
    session_token: Optional[str] = None  # for POST /auth/logout
