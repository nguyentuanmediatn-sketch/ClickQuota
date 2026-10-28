/* CQ.app — boot: router + lazy view builders + drawer wiring.
   Fragment có thể được inject SAU khi trang host load xong (Gen UI), nên
   DOMContentLoaded có thể đã fired — luôn check readyState trước khi đợi. */
(function (CQ) {
  'use strict';

  const builders = {
    dashboard: CQ.viewsApi.renderDashboard,
    endpoints: CQ.viewsApi.renderEndpoints,
    credentials: CQ.viewsApi.renderCredentials,
    sandbox: CQ.viewsApi.renderSandbox,
    system: CQ.viewsLog.renderSystem,
    audit: CQ.viewsLog.renderAudit,
    alerts: CQ.viewsLog.renderAlerts,
  };

  function boot() {
    CQ.router.init({
      onRoute(route) {
        const build = builders[route.view];
        if (build) build(document.getElementById('cq-view-' + route.view));
      },
    });
    CQ.viewsApi.wireDrawer();

    /* ⌘K / Ctrl+K focuses the topbar search — small Apple-flavored touch. */
    addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const q = document.getElementById('cq-topbar-q');
        if (q) q.focus();
      }
    });

    if (window.lucide) lucide.createIcons({ attrs: { width: 16, height: 16 } });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.CQ = window.CQ || {});
