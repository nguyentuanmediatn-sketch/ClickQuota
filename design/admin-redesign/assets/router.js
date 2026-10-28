/* CQ.router — hash router với spatial consistency:
   - Active pill trượt bằng spring (damping 1.0, response 0.35) giữa các nav item.
   - View transition: view rời đi cross-fade nhanh, view vào slide+fade bằng spring
     bắt đầu từ giá trị hiển thị hiện tại (interruptible khi đổi tab liên tục). */
(function (CQ) {
  'use strict';

  const ROUTES = [
    { hash: '#/api/dashboard', section: 'API Management', title: 'Tổng quan', view: 'dashboard' },
    { hash: '#/api/endpoints', section: 'API Management', title: 'Endpoints', view: 'endpoints' },
    { hash: '#/api/credentials', section: 'API Management', title: 'Credentials', view: 'credentials' },
    { hash: '#/api/sandbox', section: 'API Management', title: 'Sandbox', view: 'sandbox' },
    { hash: '#/log/system', section: 'System Logs', title: 'System log', view: 'system' },
    { hash: '#/log/api-audit', section: 'System Logs', title: 'API audit', view: 'audit' },
    { hash: '#/log/alerts', section: 'System Logs', title: 'Alerts', view: 'alerts' },
  ];

  const state = { current: null, pillSpring: null, viewSprings: new Map() };

  function el(id) { return document.getElementById(id); }

  function init(handlers) {
    state.handlers = handlers;
    const nav = el('cq-nav');
    const items = nav.querySelectorAll('.cq-nav-item');

    /* Measure item centers for the sliding pill. */
    const centers = new Map();
    items.forEach((item) => {
      const hash = item.getAttribute('data-route');
      centers.set(hash, { item, top: item.offsetTop, h: item.offsetHeight });
      item.addEventListener('click', () => { location.hash = hash; });
    });
    state.centers = centers;

    const pill = el('cq-nav-pill');
    state.pillSpring = CQ.springs.bind(pill, 'transform', 0, (y) => `translateY(${y}px)`, { response: 0.35, damping: 1.0 });

    views().forEach((v) => {
      const s = {
        opacity: CQ.springs.bind(v, 'opacity', 0, (x) => String(x)),
        ty: CQ.springs.bind(v, 'transform', 10, (y) => `translateY(${y}px)`),
      };
      state.viewSprings.set(v.id, s);
    });

    addEventListener('hashchange', () => apply());
    apply(true);
  }

  function views() {
    return ROUTES.map((r) => el('cq-view-' + r.view)).filter(Boolean);
  }

  function apply(first) {
    const hash = location.hash || '#/api/dashboard';
    const route = ROUTES.find((r) => r.hash === hash) || ROUTES[0];

    /* Sidebar: move pill from its CURRENT on-screen position (interruptible). */
    const target = state.centers.get(route.hash);
    if (target) {
      state.centers.forEach(({ item }) => item.classList.toggle('is-active', item.getAttribute('data-route') === route.hash));
      state.pillSpring.animateTo(target.top, { response: 0.35, damping: 1.0 });
    }

    /* Views: cross-fade out, spring the winner in from wherever it currently is. */
    views().forEach((v) => {
      const isTarget = v.id === 'cq-view-' + route.view;
      const s = state.viewSprings.get(v.id);
      if (!s) return;
      if (isTarget) {
        v.classList.add('is-active');
        s.opacity.animateTo(1, { response: 0.28, damping: 1.0 });
        s.ty.animateTo(0, { response: 0.35, damping: 1.0 });
      } else {
        v.classList.remove('is-active');
        s.opacity.animateTo(0, { response: 0.2, damping: 1.0 });
        s.ty.jump(s.ty.v); /* keep resting offset for the next entrance */
        s.ty.animateTo(10, { response: 0.25, damping: 1.0 });
      }
    });

    /* Topbar breadcrumb. */
    el('cq-crumb-section').textContent = route.section;
    el('cq-crumb-title').textContent = route.title;

    state.current = route;
    if (state.handlers && state.handlers.onRoute) state.handlers.onRoute(route, first === true);
  }

  CQ.router = { init, ROUTES, get current() { return state.current; } };
})(window.CQ = window.CQ || {});
