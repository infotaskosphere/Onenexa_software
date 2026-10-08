import React, { useEffect, useState } from "react";
import { ArrowRight, BarChart3, Bot, CalendarDays, CheckCircle2, CheckSquare2, Eye, EyeOff, FileText, FolderOpen, Globe2, KeyRound, LockKeyhole, Receipt, ShieldCheck, Sparkles, Building2, UserPlus, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";
import { lookupLicensedCompany, createLicensedAdmin } from "@/lib/licenseApi";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const spring = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };

const MODULES = [
  { title: "Task Management", subtitle: "Plan. Track. Deliver.", icon: CheckSquare2, tone: "blue" },
  { title: "Clients & CRM", subtitle: "Build stronger relationships.", icon: UsersRound, tone: "green" },
  { title: "Invoicing", subtitle: "Create. Share. Get paid.", icon: Receipt, tone: "orange" },
  { title: "Accounting", subtitle: "Simple. Accurate. Compliant.", icon: BarChart3, tone: "purple" },
  { title: "HRMS", subtitle: "Your team. Your strength.", icon: UsersRound, tone: "cyan" },
  { title: "Compliance", subtitle: "Never miss a due date.", icon: CalendarDays, tone: "pink" },
  { title: "Documents", subtitle: "Store. Organise. Access.", icon: FolderOpen, tone: "indigo" },
  { title: "Reports & Insights", subtitle: "Make smarter decisions.", icon: FileText, tone: "sky" },
  { title: "Intelligence", subtitle: "Work smarter with automation.", icon: Bot, tone: "violet" },
];

const TONES = {
  blue: "bg-blue-50 text-blue-600 border-blue-100",
  green: "bg-emerald-50 text-emerald-600 border-emerald-100",
  orange: "bg-orange-50 text-orange-600 border-orange-100",
  purple: "bg-violet-50 text-violet-600 border-violet-100",
  cyan: "bg-cyan-50 text-cyan-600 border-cyan-100",
  pink: "bg-pink-50 text-pink-600 border-pink-100",
  indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
  sky: "bg-sky-50 text-sky-600 border-sky-100",
  violet: "bg-fuchsia-50 text-fuchsia-600 border-fuchsia-100",
};

export default function Login() {
  const { login, refreshUser } = useAuth();
  const [config, setConfig] = useState(null);
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverWaking, setServerWaking] = useState(false);
  const [wakingDots, setWakingDots] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [licensedCustomer, setLicensedCustomer] = useState(null);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  useEffect(() => { getPublicWebsiteConfig().then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => {
    if (!serverWaking) return;
    const timer = setInterval(() => setWakingDots((value) => value.length >= 3 ? "" : `${value}.`), 450);
    return () => clearInterval(timer);
  }, [serverWaking]);

  const siteName = config?.branding?.site_name || config?.site_name || import.meta.env.VITE_APP_NAME || "Taskosphere";
  const logo = config?.branding?.logo || config?.logo || "/logo-transparent.png";

  const loginWithRetry = async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await api.post("/auth/login", {
          email,
          password,
          ...(organizationId.trim() ? { organization_id: organizationId.trim().toUpperCase() } : {}),
        });
      }
      catch (error) { lastError = error; if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200)); }
    }
    throw lastError;
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (!email || !password) { toast.error("Please enter your email and password."); return; }
    setLoading(true);
    const wakingTimer = setTimeout(() => setServerWaking(true), 2500);
    try {
      const response = await loginWithRetry();
      clearTimeout(wakingTimer);
      setServerWaking(false);
      if (keepSignedIn) localStorage.setItem("taskosphere_keep_signed_in", "true"); else localStorage.removeItem("taskosphere_keep_signed_in");
      const authenticated = login(response.data, keepSignedIn);
      if (!authenticated) throw new Error("Invalid login response");
      const authoritativeUser = await refreshUser();
      if (!authoritativeUser) throw new Error("Unable to load licensed access");
      try { window.postMessage({ type: "SET_TOKEN", token: response.data.access_token }, window.location.origin); } catch {}
      toast.success("Welcome back!");
    } catch (error) {
      clearTimeout(wakingTimer); setServerWaking(false);
      toast.error(error?.response?.data?.detail || "Unable to sign in. Please check your credentials.");
    } finally { setLoading(false); }
  };

  const handleLookup = async (event) => {
    event?.preventDefault();
    if (!companyName.trim() || !licenseKey.trim()) { toast.error("Enter your company name and license number."); return; }
    setLookupBusy(true);
    try {
      const result = await lookupLicensedCompany(companyName.trim(), licenseKey.trim().toUpperCase());
      setLicensedCustomer(result);
      setCompanyName(result.customer?.company_name || companyName.trim());
      setAdminEmail(result.customer?.email || "");
      toast.success("License verified. Company details loaded.");
    } catch (error) {
      setLicensedCustomer(null);
      toast.error(error?.response?.data?.detail || "We could not verify this company and license.");
    } finally { setLookupBusy(false); }
  };

  const handleCreateAdmin = async (event) => {
    event.preventDefault();
    if (!licensedCustomer) { toast.error("Verify your license first."); return; }
    setLookupBusy(true);
    try {
      const result = await createLicensedAdmin({ company_name: licensedCustomer.customer.company_name, license_key: licenseKey.trim().toUpperCase(), full_name: adminName, email: adminEmail, password: adminPassword });
      login(result, true);
      try { window.postMessage({ type: "SET_TOKEN", token: result.access_token }, window.location.origin); } catch {}
      toast.success("Admin account created. Your workspace is ready.");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to create the admin account.");
    } finally { setLookupBusy(false); }
  };

  const productSuite = [
    { name: "Taskosphere", category: "Work & tasks", logo: "/logo-transparent.png" },
    { name: "Finix", category: "Finance & accounting", logo: "/finix-logo.png" },
    { name: "People Matrix", category: "People & HR", logo: "/people-matrix-logo.png" },
    { name: "CompliGenie", category: "Compliance", logo: "/compligenie-logo.png" },
    { name: "LeadSense", category: "Growth & leads", logo: "/leadsense-logo.png" },
  ];

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f6f9fc] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col">
        <header className="flex h-[82px] shrink-0 items-center justify-between border-b border-slate-200/80 bg-white px-6 sm:px-10 xl:px-14">
          <Link to="/" className="inline-flex items-center"><img src="/onenexa-logo.png" alt="ONENEXA" className="h-12 w-auto max-w-[230px] object-contain" /></Link>
          <nav className="flex items-center gap-5">
            <Link to="/" className="hidden items-center gap-2 text-sm font-semibold text-slate-500 hover:text-[#102f62] sm:inline-flex"><Globe2 size={15} /> Explore ONENEXA</Link>
            <Link to="/" className="border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-[#102f62] transition hover:border-slate-300 hover:bg-slate-50">Request a demo</Link>
          </nav>
        </header>
        <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_410px]">
          <main className="relative flex min-w-0 overflow-hidden px-6 py-10 sm:px-10 lg:px-14 xl:px-20">
            <div className="pointer-events-none absolute -left-32 top-20 h-96 w-96 rounded-full bg-emerald-200/25 blur-3xl" />
            <div className="pointer-events-none absolute right-0 top-0 h-[34rem] w-[34rem] rounded-full bg-blue-100/45 blur-3xl" />
            <div className="relative mx-auto flex w-full max-w-[1080px] flex-col justify-center">
              <div className="max-w-[940px]">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.24em] text-[#1769ff]"><span className="h-px w-8 bg-[#1769ff]" />{config?.hero_badge || "The modern business operating system"}</div>
                <h1 className="mt-6 max-w-[920px] text-5xl font-black leading-[.96] tracking-[-.06em] text-[#102f62] sm:text-6xl xl:text-[5.25rem]">{config?.hero_title || <>Everything your business needs.<br /><span className="text-[#1769ff]">Nothing scattered.</span></>}</h1>
                <p className="mt-7 max-w-[760px] text-base leading-7 text-slate-600 sm:text-lg">{config?.hero_subtitle || "A connected operating layer for work, finance, people, compliance and growth — designed to keep the business moving from one place."}</p>
              </div>
              <section className="mt-12 border-y border-slate-200/80 py-7">
                <p className="text-[10px] font-bold uppercase tracking-[.2em] text-slate-400">OneNexa product ecosystem</p>
                <p className="mt-1 text-sm font-semibold text-[#173c70]">Purpose-built products. One connected platform.</p>
                <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  {productSuite.map((product) => <div key={product.name} className="group min-w-0 border border-slate-200 bg-white/90 px-4 py-4 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_14px_32px_rgba(15,23,42,.07)]">
                    <div className="flex h-12 items-center"><img src={product.logo} alt={product.name} className="max-h-10 max-w-[132px] object-contain" loading="lazy" /></div>
                    <div className="mt-3 border-t border-slate-100 pt-3"><p className="text-xs font-extrabold text-[#173c70]">{product.name}</p><p className="mt-1 text-[10px] text-slate-400">{product.category}</p></div>
                  </div>)}
                </div>
              </section>
              <div className="mt-8 grid gap-6 border-b border-slate-200/80 pb-8 sm:grid-cols-3">
                <div><p className="text-xs font-extrabold text-[#173c70]">Connected by design</p><p className="mt-1 text-[11px] leading-5 text-slate-500">Operations, customers and teams share one operating layer.</p></div>
                <div><p className="text-xs font-extrabold text-[#173c70]">Built for control</p><p className="mt-1 text-[11px] leading-5 text-slate-500">Permissions, records and compliance stay organised.</p></div>
                <div><p className="text-xs font-extrabold text-[#173c70]">Ready to scale</p><p className="mt-1 text-[11px] leading-5 text-slate-500">Modular products grow with the way your business works.</p></div>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-2 text-[10px] text-slate-400"><span><strong className="text-sm text-[#163b6e]">500+</strong> businesses</span><span><strong className="text-sm text-[#163b6e]">99.9%</strong> reliability</span><span><strong className="text-sm text-[#163b6e]">24/7</strong> support</span><span className="sm:ml-auto">© 2026 ONENEXA</span></div>
            </div>
          </main>
          <aside className="relative flex min-w-0 flex-col border-t border-slate-200 bg-white px-6 py-9 sm:px-10 lg:border-l lg:border-t-0 lg:px-10 xl:px-12">
            <div className="my-auto w-full max-w-[350px] mx-auto">
              <div className="mb-8"><div className="mb-5 flex h-10 w-10 items-center justify-center border border-blue-100 bg-blue-50 text-[#1769ff]"><LockKeyhole size={19} /></div><h2 className="text-3xl font-black tracking-[-.045em] text-[#102f62]">{mode === "signin" ? "Welcome back." : "Activate your workspace."}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{mode === "signin" ? "Sign in to continue to your ONENEXA workspace." : "Verify your license and create the first administrator account."}</p></div>
              <div className="mb-8 flex border-b border-slate-200">
                <button type="button" onClick={() => setMode("signin")} className={`relative flex-1 pb-3 text-sm font-bold ${mode === "signin" ? "text-[#102f62]" : "text-slate-400"}`}>Sign in{mode === "signin" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#1769ff]" />}</button>
                <button type="button" onClick={() => setMode("license")} className={`relative flex-1 pb-3 text-sm font-bold ${mode === "license" ? "text-[#102f62]" : "text-slate-400"}`}>I have a license{mode === "license" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#1769ff]" />}</button>
              </div>
              {mode === "signin" ? <>
                <form onSubmit={handleSubmit} className="space-y-5">
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-[.08em] text-slate-500">Organization ID <span className="font-normal normal-case tracking-normal text-slate-400">(optional)</span></span><Input value={organizationId} onChange={(e) => setOrganizationId(e.target.value.toUpperCase())} placeholder="L-000001 or PO-000001" className="h-12 rounded-none border-slate-200 bg-slate-50 px-4 text-sm font-mono uppercase" /></label>
                  <p className="-mt-2 text-[11px] leading-4 text-slate-400">Required when the same email is used in more than one workspace.</p>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-[.08em] text-slate-500">Email address</span><Input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-12 rounded-none border-slate-200 bg-slate-50 px-4 text-sm" /></label>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-[.08em] text-slate-500">Password</span><div className="relative"><Input autoComplete="current-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 rounded-none border-slate-200 bg-slate-50 px-4 pr-11 text-sm" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-500">
                      <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                      Remember me
                    </label>
                    <div className="flex items-center gap-2">
                      <Link to="/forgot-email" className="text-xs font-semibold text-slate-500 hover:text-[#102f62] transition">
                        Forgot Email?
                      </Link>
                      <span className="text-slate-300 text-xs">·</span>
                      <Link to="/forgot-password" className="text-xs font-bold text-[#1769ff]">
                        Forgot password?
                      </Link>
                    </div>
                  </div>
                  <motion.button type="submit" disabled={loading} whileTap={{ scale: .985 }} className="flex h-12 w-full items-center justify-center gap-2 bg-[#102f62] text-sm font-bold text-white transition hover:bg-[#0b2855] disabled:opacity-60">{loading ? "Signing in…" : <>Sign in <ArrowRight size={17} /></>}</motion.button>
                </form>
                <AnimatePresence>{serverWaking && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden"><div className="border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">Server is waking up{wakingDots}. This may take a few seconds.</div></motion.div>}</AnimatePresence>
                <div className="mt-8 border-t border-slate-200 pt-5"><div className="flex items-start gap-3"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-600" /><div><p className="text-xs font-bold text-slate-800">Secure workspace access</p><p className="mt-1 text-xs leading-5 text-slate-500">{config?.login_card_note || "Access is protected by the permissions assigned to your account."}</p></div></div></div>
                <p className="mt-6 text-center text-xs text-slate-500">New to ONENEXA? <Link to="/" className="font-bold text-[#1769ff]">Request a demo</Link></p>
              </> : <>
                {!licensedCustomer ? <form onSubmit={handleLookup} className="space-y-5">
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Company name</span><div className="relative"><Building2 size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Registered company name" className="h-12 rounded-none pl-10" /></div></label>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">License number</span><div className="relative"><KeyRound size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())} placeholder="TSO-XXXX-XXXX-XXXX-XXXX" className="h-12 rounded-none pl-10 font-mono uppercase tracking-wider" /></div></label>
                  <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 bg-[#102f62] text-sm font-bold text-white disabled:opacity-60">{lookupBusy ? "Verifying license…" : <>Verify & Load Company <ArrowRight size={17} /></>}</button>
                </form> : <form onSubmit={handleCreateAdmin} className="space-y-4">
                  <div className="border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 size={19} className="mt-0.5 text-emerald-600" /><div><p className="font-bold text-slate-900">License verified</p><p className="mt-1 text-xs text-slate-600">{licensedCustomer.customer.company_name} · {licensedCustomer.license?.package_name} · {licensedCustomer.license?.validity_months || "—"} months</p></div></div></div>
                  <div className="border border-slate-200 bg-slate-50 p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Company details</p><div className="grid gap-3 text-sm sm:grid-cols-2"><div><span className="text-xs text-slate-400">Company</span><p className="font-semibold">{licensedCustomer.customer.company_name}</p></div><div><span className="text-xs text-slate-400">GSTIN</span><p className="font-semibold">{licensedCustomer.customer.gstin || "—"}</p></div><div><span className="text-xs text-slate-400">Email</span><p className="font-semibold">{licensedCustomer.customer.email || "—"}</p></div><div><span className="text-xs text-slate-400">Phone</span><p className="font-semibold">{licensedCustomer.customer.phone || "—"}</p></div><div className="sm:col-span-2"><span className="text-xs text-slate-400">Address</span><p className="font-semibold">{licensedCustomer.customer.gst_address || licensedCustomer.customer.address || "—"}</p></div></div></div>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Admin full name</span><Input required value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Owner / administrator name" className="h-12 rounded-none" /></label>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Admin login email</span><Input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="h-12 rounded-none" /></label>
                  <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Create password</span><div className="relative"><Input required minLength={8} type={showAdminPassword ? "text" : "password"} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Minimum 8 characters" className="h-12 rounded-none pr-11" /><button type="button" onClick={() => setShowAdminPassword((v) => !v)} className="absolute right-3 top-3 text-slate-400">{showAdminPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>
                  <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 bg-[#102f62] text-sm font-bold text-white disabled:opacity-60">{lookupBusy ? "Creating admin workspace…" : <>Create Admin Login <UserPlus size={17} /></>}</button>
                  <button type="button" onClick={() => setLicensedCustomer(null)} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-900">Use a different license</button>
                </form>}
              </>}
            </div>
            <div className="mt-auto pt-8 text-center text-[10px] text-slate-400"><ShieldCheck size={13} className="mx-auto mb-2" />Secure access · Privacy · Terms · Support</div>
          </aside>
        </div>
      </div>
    </div>
  );
}
