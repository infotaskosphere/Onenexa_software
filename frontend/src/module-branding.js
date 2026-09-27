/*
 * Shared module branding for the commercial shell.
 * Keeps module identity in one place without coupling dashboard pages to the
 * global header. Navigation remains the source of truth for active module.
 *
 * IMPORTANT: Product labels are intentionally kept here as a single runtime
 * compatibility layer. Internal route names, permission identifiers and API
 * names remain unchanged so existing integrations are not disturbed.
 */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard', lightLogo: '/logo-lite.png', darkLogo: '/logo-dark.png', collapsedLogo: '/icon-192.png', alt: 'Task-O-Sphere' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard', lightLogo: '/finix-logo.png', darkLogo: '/finix-logo.png', collapsedLogo: '/finix-icon.png', alt: 'Finix AI Accounting' },
  compliance: { label: 'CompliGenie', landingPath: '/compliance-dashboard', lightLogo: '/compligenie-logo.png', darkLogo: '/compligenie-logo.png', collapsedLogo: '/compligenie-icon.svg', alt: 'CompliGenie' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard', lightLogo: '/leadsense-logo.png', darkLogo: '/leadsense-logo.png', collapsedLogo: '/leadsense-logo.png', alt: 'LeadSense' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix', lightLogo: '/people-matrix-logo.png', darkLogo: '/people-matrix-logo.png', collapsedLogo: '/people-matrix-logo.png', alt: 'People Matrix' },
  aiweave: { label: 'AIWeave', landingPath: '/aiweave', lightLogo: '/aiweave-logo-lite.png', darkLogo: '/aiweave-logo-dark.png', collapsedLogo: '/aiweave-icon.png', alt: 'AIWeave' },
  records: { label: 'Records', landingPath: '/records-dashboard', lightLogo: '/logo-lite.png', darkLogo: '/logo-dark.png', collapsedLogo: '/icon-192.png', alt: 'Records Vault' },
};

// Last-resort logo that ships INSIDE the JS bundle. If a static file is missing
// from a deployment (Vercel rewrites unknown paths to index.html, so a missing
// image comes back as HTML and shows as a broken picture) the header still gets
// a real AIWeave logo instead of alt text.
const AIWEAVE_INLINE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="96" viewBox="0 0 420 96">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0D3B66"/><stop offset=".55" stop-color="#1F6FB2"/><stop offset="1" stop-color="#1FAF5A"/></linearGradient></defs>'
  + '<g transform="translate(8 8)"><circle cx="40" cy="40" r="34" fill="#fff" stroke="url(#g)" stroke-width="5"/>'
  + '<path d="M21 45c7-18 18-25 31-18 7 4 11 11 7 20-4 10-16 14-27 8" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round"/>'
  + '<path d="M25 29c6 9 15 12 28 8M27 56c7-7 15-11 28-10" fill="none" stroke="#1FAF5A" stroke-width="4" stroke-linecap="round"/>'
  + '<circle cx="20" cy="45" r="4" fill="#1F6FB2"/><circle cx="52" cy="27" r="4" fill="#1FAF5A"/><circle cx="58" cy="48" r="4" fill="#0D3B66"/></g>'
  + '<text x="96" y="61" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="42" font-weight="700" fill="#0D3B66">AI</text>'
  + '<text x="145" y="61" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="42" font-weight="700" fill="#1FAF5A">Weave</text></svg>';
const INLINE_FALLBACK_LOGOS = {
  aiweave: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(AIWEAVE_INLINE_SVG),
};
// Logo URLs that failed to load in this browser session.
const failedLogos = new Set();

const FALLBACK = MODULE_BRANDING.core;
let scheduled = false;
let lastModuleId = '';

const getRouteModuleId = () => {
  const path = window.location.pathname || '';
  if (
    path === '/compliance-dashboard' || path === '/compliance' || path.startsWith('/compliance/') ||
    path === '/gst-reconciliation' || path.startsWith('/gst-reconciliation/') ||
    path === '/trademark-sphere' || path.startsWith('/trademark-sphere/') ||
    path === '/roc-sphere' || path.startsWith('/roc-sphere/') ||
    path === '/mis-report' || path.startsWith('/mis-report/') ||
    path === '/salary-slips' || path.startsWith('/salary-slips/')
  ) return 'compliance';
  if (path === '/client-proposals-dashboard' || path.startsWith('/leads/') || path === '/leads' || path.startsWith('/quotations/') || path === '/quotations' || path.startsWith('/client-discussion/') || path === '/client-discussion') return 'proposals';
  if (path === '/finix-dashboard' || path.startsWith('/invoicing') || path.startsWith('/purchase') || path.startsWith('/bank-accounts') || path.startsWith('/journal-entries') || path === '/chart-of-accounts' || path === '/zero-touch-entry' || path === '/accounting-reports' || path === '/day-book') return 'accounts';
  if (path === '/people-matrix' || path.startsWith('/users') || path.startsWith('/leave') || path.startsWith('/payroll') || path.startsWith('/hr') || path.startsWith('/recruitment')) return 'people-matrix';
  if (path === '/aiweave' || path.startsWith('/aiweave/')) return 'aiweave';
  if (path === '/records-dashboard' || path === '/dsc' || path === '/documents' || path === '/clients' || path === '/passwords' || path === '/client-approvals') return 'records';
  return null;
};

const getActiveModuleId = () => {
  // Route identity is authoritative. This prevents a stale tab class from
  // leaving the previous module logo visible during client-side navigation.
  const routeModuleId = getRouteModuleId();
  if (routeModuleId) return routeModuleId;
  const activeTab = document.querySelector('#top-module-switcher-bar [id^="nav-tab-"][data-active="true"], #top-module-switcher-bar [id^="nav-tab-"][aria-current="page"], #top-module-switcher-bar [id^="nav-tab-"].font-semibold');
  const moduleId = (activeTab?.id || '').replace(/^nav-tab-/, '');
  return MODULE_BRANDING[moduleId] ? moduleId : 'core';
};

const setTabLabel = (id, label) => {
  const tab = document.querySelector(id);
  if (!tab) return;
  const labelNode = tab.querySelector('span');
  if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
  tab.setAttribute('aria-label', label);
  tab.setAttribute('title', label);
};

const renameNavigation = () => {
  setTabLabel('#nav-tab-core', 'Taskosphere');
  setTabLabel('#nav-tab-accounts', 'Finix');
  setTabLabel('#nav-tab-aiweave', 'AIWeave');
  setTabLabel('#nav-tab-compliance', 'CompliGenie');
  setTabLabel('#nav-tab-records', 'Records');
  setTabLabel('#nav-tab-proposals', 'LeadSense');
  setTabLabel('#nav-tab-people-matrix', 'People Matrix');
};

const renameSidebarText = (from, to) => {
  document.querySelectorAll('aside a, aside button').forEach((node) => {
    const text = node.querySelector('span:last-child') || node;
    if (String(text.textContent || '').trim() === from) text.textContent = to;
  });
};

const renameSidebarDivider = (from, to) => {
  Array.from(document.querySelectorAll('aside')).flatMap((aside) => Array.from(aside.querySelectorAll('*'))).forEach((node) => {
    if (String(node.textContent || '').trim() === from && node.children.length === 0) node.textContent = to;
  });
};

const isDarkMode = () => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');

const syncModuleBranding = () => {
  scheduled = false;
  renameNavigation();
  const moduleId = getActiveModuleId();
  const branding = MODULE_BRANDING[moduleId] || FALLBACK;
  const header = document.querySelector('header.fixed');
  if (!header) return;

  const logoLink = header.querySelector('a[href="/dashboard"]') || header.querySelector('a.relative.flex.items-center');
  const logoImages = logoLink?.querySelectorAll('img') || [];
  const visibleLogo = Array.from(logoImages).find((img) => getComputedStyle(img).display !== 'none') || logoImages[logoImages.length - 1];
  if (!logoLink || !visibleLogo) return;

  const brandColumn = header.firstElementChild;
  const collapsed = Boolean(brandColumn && brandColumn.getBoundingClientRect().width <= 100);
  let logoSrc = collapsed ? branding.collapsedLogo : (isDarkMode() ? branding.darkLogo : branding.lightLogo);
  if (failedLogos.has(logoSrc) && INLINE_FALLBACK_LOGOS[moduleId]) logoSrc = INLINE_FALLBACK_LOGOS[moduleId];

  if (logoLink.getAttribute('href') !== branding.landingPath) logoLink.setAttribute('href', branding.landingPath);
  if (visibleLogo.getAttribute('src') !== logoSrc) visibleLogo.setAttribute('src', logoSrc);
  if (visibleLogo.getAttribute('alt') !== branding.alt) visibleLogo.setAttribute('alt', branding.alt);
  // The previous handler compared the failing src to the very same path it then
  // "fell back" to, so it never did anything. Record the failure instead and let
  // the next sync pick the inline fallback (also covers a load that already
  // failed before this listener was attached).
  if (!visibleLogo.dataset.brandingFallbackBound) {
    visibleLogo.dataset.brandingFallbackBound = 'true';
    visibleLogo.addEventListener('error', () => {
      const failed = visibleLogo.getAttribute('src');
      if (!failed || failed.startsWith('data:') || failedLogos.has(failed)) return;
      failedLogos.add(failed);
      scheduleSync();
    });
  }
  if (visibleLogo.complete && visibleLogo.naturalWidth === 0 && !logoSrc.startsWith('data:') && !failedLogos.has(logoSrc)) {
    failedLogos.add(logoSrc);
    scheduleSync();
  }
  visibleLogo.setAttribute('aria-label', branding.alt);
  visibleLogo.style.display = 'block';
  visibleLogo.style.objectFit = 'contain';
  visibleLogo.style.objectPosition = 'center center';
  visibleLogo.style.flexShrink = '0';
  visibleLogo.style.maxWidth = '100%';
  visibleLogo.style.margin = '0 auto';
  visibleLogo.style.transform = 'translateY(0)';

  if (moduleId === 'proposals' || moduleId === 'people-matrix' || moduleId === 'compliance') {
    visibleLogo.style.background = '#ffffff';
    visibleLogo.style.borderRadius = '8px';
    visibleLogo.style.padding = '0';
  } else {
    visibleLogo.style.background = '';
    visibleLogo.style.borderRadius = '';
    visibleLogo.style.padding = '';
  }

  // AIWeave gets the same header slot and footprint as the CompliGenie logo
  // (top-left brand block), showing the real AIWeave PNG at that size.
  if (moduleId === 'aiweave') {
    visibleLogo.style.width = collapsed ? '58px' : '205px';
    visibleLogo.style.height = collapsed ? '58px' : '60px';
  }

  if (moduleId === 'compliance') {
    visibleLogo.style.width = collapsed ? '58px' : '205px';
    visibleLogo.style.height = collapsed ? '58px' : '55px';
  }

  if (moduleId === 'proposals') {
    const title = header.querySelector('h1');
    if (title) title.textContent = 'LeadSense';
    renameSidebarText('Client Proposals Dashboard', 'LeadSense Dashboard');
    renameSidebarDivider('Client Proposals', 'LeadSense');
    document.title = 'LeadSense Dashboard · Task-O-Sphere';
  }

  if (moduleId === 'compliance') {
    const title = header.querySelector('h1');
    if (title) title.textContent = 'CompliGenie';
    renameSidebarText('Compliance Dashboard', 'CompliGenie Dashboard');
    renameSidebarDivider('Compliance', 'CompliGenie');
    document.title = 'CompliGenie Dashboard · Task-O-Sphere';
  }

  lastModuleId = moduleId;
};

const scheduleSync = () => {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(syncModuleBranding, 0);
};

const observer = new MutationObserver(scheduleSync);
const start = () => {
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'href'] });
  scheduleSync();
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.addEventListener('popstate', scheduleSync);
document.addEventListener('click', (event) => {
  if (event.target?.closest?.('#top-module-switcher-bar button, header a[href], aside a, aside button')) scheduleSync();
}, true);
window.setInterval(() => {
  if (lastModuleId !== getActiveModuleId()) scheduleSync();
}, 500);
