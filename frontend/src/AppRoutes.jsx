import React, { Suspense } from 'react';
import { lazyWithRetry as lazy } from '@/lib/lazyWithRetry.js';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { firstAccessiblePath, isCommercialTenant } from '@/lib/commercialPermissionMatrix';
import DashboardLayout from '@/components/layout/DashboardLayout.jsx';
import ModuleGate from '@/components/ModuleGate.jsx';
import NoModuleAccess from '@/components/NoModuleAccess.jsx';
import { PageGuard } from '@/components/governance/GovernanceGuards.jsx';
import GifLoader from '@/components/ui/GifLoader.jsx';
import RouteErrorBoundary from '@/components/layout/RouteErrorBoundary.jsx';
import { AnimatedOutlet as RouteAnimatedOutlet, PageTransition } from '@/components/layout/PageTransition.jsx';

const Login = lazy(() => import('./pages/Login.jsx'));
const WebsiteHome = lazy(() => import('./pages/WebsiteHome.jsx'));
const Register = lazy(() => import('./pages/Register.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ForgotEmail = lazy(() => import('./pages/ForgotEmail.jsx'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail.jsx'));
const LicenseActivation = lazy(() => import('./pages/LicenseActivation.jsx'));
const ClientPortalLogin = lazy(() => import('./pages/ClientPortalLogin.jsx'));
const ClientPortalDashboard = lazy(() => import('./pages/ClientPortalDashboard.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Tasks = lazy(() => import('./pages/Tasks.jsx'));
const TodoDashboard = lazy(() => import('./pages/TodoDashboard.jsx'));
const Attendance = lazy(() => import('./pages/Attendance.jsx'));
const Reminders = lazy(() => import('./pages/Reminders.jsx'));
const ActionCenter = lazy(() => import('./pages/ActionCenter.jsx'));
const VisitsPage = lazy(() => import('./pages/VisitsPage.jsx'));
const AIWeave = lazy(() => import('./pages/AIDocumentReader.jsx'));
const ComplianceDashboard = lazy(() => import('./pages/ComplianceDashboard.jsx'));
const CompliancePage = lazy(() => import('./pages/CompliancePage.jsx'));
const GSTReconciliation = lazy(() => import('./pages/GSTReconciliation.jsx'));
const TrademarkSphere = lazy(() => import('./pages/TrademarkSphere.jsx'));
const MISReport = lazy(() => import('./pages/MISReport.jsx'));
const SalarySlips = lazy(() => import('./pages/SalarySlips.jsx'));
const ROCSpherePage = lazy(() => import('./pages/ROCSpherePage.jsx'));
const ClientApprovals = lazy(() => import('./pages/ClientApprovals.jsx'));
const RecordsDashboard = lazy(() => import('./pages/RecordsDashboard.jsx'));
const PeopleMatrixDashboard = lazy(() => import('./pages/PeopleMatrixDashboard.jsx'));
const DSCRegister = lazy(() => import('./pages/DSCRegister.jsx'));
const DocumentRegister = lazy(() => import('./pages/DocumentsRegister.jsx'));
const Clients = lazy(() => import('./pages/Clients.jsx'));
const PasswordRepository = lazy(() => import('./pages/Passvault.jsx'));
const ClientProposalsDashboard = lazy(() => import('./pages/ClientProposalsDashboard.jsx'));
const LeadsPage = lazy(() => import('./pages/Leads.jsx'));
const Quotations = lazy(() => import('./pages/Quotations.jsx'));
const FinixDashboard = lazy(() => import('./pages/FinixDashboard.jsx'));
const Invoicing = lazy(() => import('./pages/Invoicing.jsx'));
const Purchase = lazy(() => import('./pages/Purchase.jsx'));
const BankAccounts = lazy(() => import('./pages/BankAccounts.jsx'));
const ChartOfAccounts = lazy(() => import('./pages/ChartOfAccounts.jsx'));
const JournalEntries = lazy(() => import('./pages/JournalEntries.jsx'));
const AccountingReports = lazy(() => import('./pages/AccountingReports.jsx'));
const ZeroTouchEntry = lazy(() => import('./pages/ZeroTouchEntry.jsx'));
const GSTPortalSync = lazy(() => import('./pages/GSTPortalSync.jsx'));
const AccountingIntegrity = lazy(() => import('./pages/AccountingIntegrity.jsx'));
const ExtendedReports = lazy(() => import('./pages/ExtendedReports.jsx'));
const DueDates = lazy(() => import('./pages/DueDates.jsx'));
const ImportInvoices = lazy(() => import('./pages/ImportInvoices.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const TaskAudit = lazy(() => import('./pages/TaskAudit.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const StaffActivity = lazy(() => import('./pages/StaffActivity.jsx'));
const ClientPortalManagerPage = lazy(() => import('./pages/ClientPortalManagerPage.jsx'));
const WhatsAppHub = lazy(() => import('./pages/WhatsAppHub.jsx'));
const Leave = lazy(() => import('./pages/governed/Leave.jsx'));
const Payroll = lazy(() => import('./pages/governed/Payroll.jsx'));
const HR = lazy(() => import('./pages/governed/HR.jsx'));
const Recruitment = lazy(() => import('./pages/governed/Recruitment.jsx'));
const ClientDiscussion = lazy(() => import('./pages/governed/ClientDiscussion.jsx'));
const MasterData = lazy(() => import('./pages/governed/MasterData.jsx'));
const Roles = lazy(() => import('./pages/governed/Roles.jsx'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const PermissionMatrix = lazy(() => import('./pages/PermissionMatrix.jsx'));
const ContactDetails = lazy(() => import('./pages/ContactDetails.jsx'));
const GeneralSettings = lazy(() => import('./pages/GeneralSettings.jsx'));
const BackupRestore = lazy(() => import('./pages/BackupRestore.jsx'));
const WhatsAppSettings = lazy(() => import('./pages/WhatsAppSettings.jsx'));
const EmailSettings = lazy(() => import('@/components/EmailSettings.jsx'));
const PendingApprovals = lazy(() => import('@/components/PendingApprovalsPanel.jsx'));
const MasterConsole = lazy(() => import('./pages/MasterConsole.jsx'));
const WebsiteBuilder = lazy(() => import('./pages/WebsiteBuilder.jsx'));
const SecuritySessions = lazy(() => import('./pages/SecuritySessions.jsx'));

function AuthLoading() { return <GifLoader />; }
function LicensedDashboardHome() { const { user, loading, isPlatformOwner, hasPermission } = useAuth(); if (loading) return <AuthLoading />; const isInternalAdmin=user?.role?.toLowerCase()==='admin'&&!user?.company_id; const canAccessTaskosphere = Boolean(isPlatformOwner) || Boolean(hasPermission?.('can_access_taskosphere')) || user?.permissions?.can_access_taskosphere===true; if(isInternalAdmin||canAccessTaskosphere)return <Dashboard/>; const destination=isCommercialTenant(user)?firstAccessiblePath(user):(['/finix-dashboard','/compliance-dashboard','/records-dashboard','/client-proposals-dashboard','/people-matrix'].find((path)=>{ const flag={ '/finix-dashboard':'can_access_finix','/compliance-dashboard':'can_access_compliance','/records-dashboard':'can_access_records','/client-proposals-dashboard':'can_access_proposals','/people-matrix':'can_access_people_matrix' }[path]; return user?.permissions?.[flag]===true; })||null); if(!destination||destination==='/login')return <NoModuleAccess/>; return <Navigate to={destination} replace/>; }
function ProtectedLayout(){const {user,loading}=useAuth();const location=useLocation();if(loading)return <AuthLoading/>;if(!user)return <Navigate to="/login" replace/>;return <DashboardLayout><RouteErrorBoundary resetKey={location.pathname}><Suspense fallback={<div className="w-full min-h-[42vh]"><GifLoader /></div>}><RouteAnimatedOutlet/></Suspense></RouteErrorBoundary></DashboardLayout>}
function PublicOnly({children}){const {user,loading}=useAuth();if(loading)return <AuthLoading/>;if(user){const destination=isCommercialTenant(user)?firstAccessiblePath(user):'/dashboard';if(destination==='/login')return <NoModuleAccess/>;return <Navigate to={destination} replace/>;}return children}
function AdminOnly({children}){const {user}=useAuth();if(user?.role?.toLowerCase()!=='admin')return <Navigate to="/dashboard" replace/>;return children}
function BackupPermission({children}){const {user}=useAuth();const isAdmin=user?.role?.toLowerCase()==='admin';if(isAdmin||user?.permissions?.can_view_backup_restore===true)return children;return <Navigate to="/dashboard" replace/>}
function PlatformOwnerOnly({children}){const {loading,isPlatformOwner}=useAuth();if(loading)return <AuthLoading/>;if(!isPlatformOwner)return <Navigate to="/dashboard" replace/>;return children}

export default function AppRoutes(){return <Suspense fallback={<AuthLoading/>}><Routes>
<Route path="/" element={<WebsiteHome/>}/><Route path="/website" element={<WebsiteHome/>}/><Route path="/login" element={<PublicOnly><Login/></PublicOnly>}/><Route path="/register" element={<PublicOnly><Register/></PublicOnly>}/><Route path="/forgot-password" element={<PublicOnly><ForgotPassword/></PublicOnly>}/><Route path="/forgot-email" element={<PublicOnly><ForgotEmail/></PublicOnly>}/><Route path="/verify-email" element={<PageTransition><VerifyEmail/></PageTransition>}/><Route path="/activate-license" element={<PageTransition><LicenseActivation/></PageTransition>}/><Route path="/client-portal" element={<Navigate to="/client-portal/login" replace/>}/><Route path="/client-portal/login" element={<PageTransition><ClientPortalLogin/></PageTransition>}/><Route path="/client-portal/dashboard" element={<PageTransition><ClientPortalDashboard/></PageTransition>}/>
<Route element={<ProtectedLayout/>}>
<Route path="/dashboard" element={<LicensedDashboardHome/>}/><Route path="/tasks" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_tasks"><Tasks/></PageGuard></ModuleGate>}/><Route path="/todos" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_todo_dashboard"><TodoDashboard/></PageGuard></ModuleGate>}/><Route path="/todo" element={<Navigate to="/todos" replace/>}/><Route path="/attendance" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_attendance"><Attendance/></PageGuard></ModuleGate>}/><Route path="/reminders" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_reminders"><Reminders/></PageGuard></ModuleGate>}/><Route path="/action-center" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_action_center"><ActionCenter/></PageGuard></ModuleGate>}/><Route path="/visits" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_client_visits"><VisitsPage/></PageGuard></ModuleGate>}/><Route path="/aiweave" element={<ModuleGate module="aiweave"><PageGuard module="aiweave" page="can_view_aiweave"><AIWeave/></PageGuard></ModuleGate>}/><Route path="/ai-reader" element={<Navigate to="/aiweave" replace/>}/><Route path="/client-portal-manager/*" element={<ModuleGate module="taskosphere"><PageGuard module="taskosphere" page="can_view_client_portal"><ClientPortalManagerPage/></PageGuard></ModuleGate>}/>
<Route path="/compliance-dashboard" element={<ModuleGate module="compliance"><ComplianceDashboard/></ModuleGate>}/><Route path="/compliance" element={<ModuleGate module="compliance"><CompliancePage/></ModuleGate>}/><Route path="/gst-reconciliation" element={<ModuleGate module="compliance"><GSTReconciliation/></ModuleGate>}/><Route path="/gst-sphere" element={<ModuleGate module="compliance"><GSTReconciliation/></ModuleGate>}/><Route path="/trademark-sphere" element={<ModuleGate module="compliance"><TrademarkSphere/></ModuleGate>}/><Route path="/mis-report" element={<ModuleGate module="compliance"><PageGuard module="compliance" page="can_view_mis_report"><MISReport/></PageGuard></ModuleGate>}/><Route path="/salary-slips" element={<ModuleGate module="compliance"><PageGuard module="compliance" page="can_view_salary_slips"><SalarySlips/></PageGuard></ModuleGate>}/><Route path="/roc-sphere" element={<ModuleGate module="compliance"><ROCSpherePage/></ModuleGate>}/>
<Route path="/records-dashboard" element={<ModuleGate module="records"><RecordsDashboard/></ModuleGate>}/><Route path="/client-approvals" element={<ModuleGate module="records"><ClientApprovals/></ModuleGate>}/><Route path="/dsc" element={<ModuleGate module="records"><DSCRegister/></ModuleGate>}/><Route path="/documents" element={<ModuleGate module="records"><DocumentRegister/></ModuleGate>}/><Route path="/clients" element={<ModuleGate module="records"><Clients/></ModuleGate>}/><Route path="/passwords" element={<ModuleGate module="records"><PasswordRepository/></ModuleGate>}/>
<Route path="/client-proposals-dashboard" element={<ModuleGate module="proposals"><ClientProposalsDashboard/></ModuleGate>}/><Route path="/leads" element={<ModuleGate module="proposals"><LeadsPage/></ModuleGate>}/><Route path="/quotations" element={<ModuleGate module="proposals"><Quotations/></ModuleGate>}/>
<Route path="/finix-dashboard" element={<ModuleGate module="finix"><FinixDashboard/></ModuleGate>}/><Route path="/finix-ai-workspace" element={<Navigate to="/finix-dashboard" replace />}/><Route path="/invoicing" element={<ModuleGate module="finix"><Invoicing/></ModuleGate>}/><Route path="/purchase" element={<ModuleGate module="finix"><Purchase/></ModuleGate>}/><Route path="/bank-accounts" element={<ModuleGate module="finix"><BankAccounts/></ModuleGate>}/><Route path="/chart-of-accounts" element={<ModuleGate module="finix"><ChartOfAccounts/></ModuleGate>}/><Route path="/journal-entries" element={<ModuleGate module="finix"><JournalEntries/></ModuleGate>}/><Route path="/accounting-reports" element={<ModuleGate module="finix"><AccountingReports/></ModuleGate>}/><Route path="/zero-touch-entry" element={<ModuleGate module="finix"><ZeroTouchEntry/></ModuleGate>}/><Route path="/gst-portal-sync" element={<ModuleGate module="finix"><GSTPortalSync/></ModuleGate>}/><Route path="/accounting-integrity" element={<ModuleGate module="finix"><AccountingIntegrity/></ModuleGate>}/><Route path="/day-book" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/cash-bank-book" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/cash-flow" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/outstanding-report" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/bank-reconciliation" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/depreciation" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/tds-tcs" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/financial-ratios" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/comparative-report" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/yearly-report" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/opening-balances" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/accounting-audit-trail" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/bulk-import" element={<ModuleGate module="finix"><ExtendedReports/></ModuleGate>}/><Route path="/due-dates" element={<ModuleGate module="finix"><DueDates/></ModuleGate>}/><Route path="/import-invoices" element={<ModuleGate module="finix"><ImportInvoices/></ModuleGate>}/>
<Route path="/people-matrix" element={<ModuleGate module="peopleMatrix"><PeopleMatrixDashboard/></ModuleGate>}/><Route path="/reports" element={<ModuleGate module="taskosphere"><Reports/></ModuleGate>}/><Route path="/task-audit" element={<AdminOnly><TaskAudit/></AdminOnly>}/><Route path="/users" element={<AdminOnly><Users/></AdminOnly>}/><Route path="/staff-activity" element={<AdminOnly><StaffActivity/></AdminOnly>}/><Route path="/whatsapp-hub" element={<AdminOnly><WhatsAppHub/></AdminOnly>}/><Route path="/leave" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_leave"><Leave/></PageGuard></ModuleGate>}/><Route path="/payroll" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_payroll"><Payroll/></PageGuard></ModuleGate>}/><Route path="/hr" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_hr"><HR/></PageGuard></ModuleGate>}/><Route path="/recruitment" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_recruitment"><Recruitment/></PageGuard></ModuleGate>}/><Route path="/client-discussion" element={<ModuleGate module="proposals"><PageGuard module="proposals" page="can_view_client_discussion"><ClientDiscussion/></PageGuard></ModuleGate>}/>
<Route path="/admin-dashboard" element={<AdminOnly><AdminDashboard/></AdminOnly>}/><Route path="/permission-matrix" element={<AdminOnly><PermissionMatrix/></AdminOnly>}/><Route path="/master-data" element={<AdminOnly><PageGuard module="admin" page="can_view_master_data"><MasterData/></PageGuard></AdminOnly>}/><Route path="/roles" element={<AdminOnly><PageGuard module="admin" page="can_view_roles"><Roles/></PageGuard></AdminOnly>}/><Route path="/contact-details" element={<AdminOnly><ContactDetails/></AdminOnly>}/><Route path="/master-console" element={<PlatformOwnerOnly><MasterConsole/></PlatformOwnerOnly>}/><Route path="/master-console/website" element={<PlatformOwnerOnly><WebsiteBuilder/></PlatformOwnerOnly>}/><Route path="/website-studio" element={<PlatformOwnerOnly><WebsiteBuilder/></PlatformOwnerOnly>}/><Route path="/website-builder" element={<PlatformOwnerOnly><WebsiteBuilder/></PlatformOwnerOnly>}/><Route path="/security/sessions" element={<SecuritySessions/>}/><Route path="/settings" element={<Navigate to="/settings/general" replace/>}/><Route path="/settings/general" element={<GeneralSettings/>}/><Route path="/settings/backup" element={<BackupPermission><BackupRestore/></BackupPermission>}/><Route path="/settings/email" element={<AdminOnly><EmailSettings/></AdminOnly>}/><Route path="/settings/whatsapp" element={<AdminOnly><WhatsAppSettings/></AdminOnly>}/><Route path="/settings/automation" element={<Navigate to="/settings/whatsapp" replace/>}/><Route path="/automation/approvals" element={<AdminOnly><PendingApprovals/></AdminOnly>}/>
</Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Suspense>}
