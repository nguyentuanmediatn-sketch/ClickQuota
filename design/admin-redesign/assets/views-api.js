/* CQ.viewsApi — API Management views: dashboard, endpoints (+spring drawer,
   column resize, spring toggles), credentials, sandbox. */
(function (CQ) {
  'use strict';
  const { SpringValue, rubberband, velocityTracker } = CQ.springs;

  /* ---------- Dashboard ---------- */
  function renderDashboard(root) {
    if (root.dataset.built) return;
    const m = CQ.mock.METRICS;
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">Tổng quan vận hành</div>
        <div class="cq-view-sub">Cửa sổ 24 giờ qua — 21 workspace, 2 tài khoản ClickUp</div></div>
        <div class="cq-view-actions"><button class="cq-btn" data-act="refresh"><i data-lucide="refresh-cw"></i>Làm mới</button></div>
      </div>
      <div class="cq-stat-grid">
        <div class="cq-stat"><div class="cq-stat-label">Requests</div><div class="cq-stat-value">${m.requests}</div><div class="cq-stat-delta"><strong style="color:#56e0bd">+12,4%</strong> so với hôm qua</div></div>
        <div class="cq-stat"><div class="cq-stat-label">Latency p95</div><div class="cq-stat-value">${m.p95}</div><div class="cq-stat-delta">TTFT trung vị 1 204ms</div></div>
        <div class="cq-stat"><div class="cq-stat-label">Latency p99</div><div class="cq-stat-value">${m.p99}</div><div class="cq-stat-delta">bao gồm audit quota 3,9s</div></div>
        <div class="cq-stat"><div class="cq-stat-label">4xx / 429 / 5xx</div><div class="cq-stat-value">${m.err4xx}<span style="color:var(--cq-text-faint)"> / </span>1,3%<span style="color:var(--cq-text-faint)"> / </span>${m.err5xx}</div><div class="cq-stat-delta">429 cách ly theo dailyResetsAt thật</div></div>
      </div>
      <div class="cq-panel">
        <div class="cq-panel-title">Requests / 5 phút</div>
        <div class="cq-spark-wrap" id="cq-spark"></div>
      </div>
    `;
    drawSpark(root.querySelector('#cq-spark'), m.spark);
    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
  }

  function drawSpark(host, points) {
    const W = 720, H = 130, P = 8;
    const max = Math.max(...points), min = Math.min(...points);
    const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
    const y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
    const d = points.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    host.innerHTML = `
      <svg class="cq-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Biểu đồ request theo 5 phút">
        <defs><linearGradient id="cqsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5a8df5" stop-opacity="0.35"/><stop offset="1" stop-color="#5a8df5" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${d} L ${x(points.length - 1)} ${H - P} L ${x(0)} ${H - P} Z" fill="url(#cqsg)"/>
        <path d="${d}" fill="none" stroke="#5a8df5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        <circle cx="${x(points.length - 1)}" cy="${y(points[points.length - 1])}" r="3.5" fill="#56e0bd"/>
      </svg>`;
  }

  /* ---------- Endpoints ---------- */
  const drawerState = { open: false, ep: null };

  function renderEndpoints(root) {
    if (root.dataset.built) return;
    const eps = CQ.mock.ENDPOINTS;
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">Endpoints</div>
        <div class="cq-view-sub">${eps.length} endpoint · kéo viền cột để chỉnh · bấm bánh răng để cấu hình</div></div>
        <div class="cq-view-actions">
          <div class="cq-toggle-row"><div class="cq-toggle is-on" id="cq-only-on" role="switch" aria-checked="true" tabindex="0"><div class="cq-knob"></div></div><span class="cq-toggle-state">Đang bật</span></div>
          <button class="cq-btn is-primary"><i data-lucide="plus"></i>New endpoint</button>
        </div>
      </div>
      <div class="cq-table-wrap">
        <table class="cq-table" id="cq-ep-table">
          <colgroup><col style="width:92px"><col style="width:34%"><col style="width:120px"><col style="width:96px"><col style="width:92px"><col style="width:110px"><col style="width:64px"></colgroup>
          <thead><tr>
            <th>Method<span class="cq-th-resizer" data-col="0"></span></th>
            <th>Path &amp; mô tả<span class="cq-th-resizer" data-col="1"></span></th>
            <th>Rate limit<span class="cq-th-resizer" data-col="2"></span></th>
            <th>p95<span class="cq-th-resizer" data-col="3"></span></th>
            <th>Uptime<span class="cq-th-resizer" data-col="4"></span></th>
            <th>Trạng thái</th><th></th>
          </tr></thead>
          <tbody id="cq-ep-body"></tbody>
        </table>
      </div>
    `;
    const body = root.querySelector('#cq-ep-body');
    eps.forEach((ep, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="cq-method cq-method-${ep.method.toLowerCase()}">${ep.method}</span></td>
        <td><div class="cq-endpoint-path">${ep.path}</div><div class="cq-endpoint-desc">${ep.desc}</div></td>
        <td class="cq-col-num">${ep.rpm} rpm</td>
        <td class="cq-col-num">${ep.p95 >= 1000 ? (ep.p95 / 1000).toFixed(2) + 's' : ep.p95 + 'ms'}</td>
        <td class="cq-col-num" style="color:${ep.uptime >= 99.9 ? '#56e0bd' : '#ffc35e'}">${ep.uptime.toFixed(2)}%</td>
        <td><div class="cq-toggle-row"><div class="cq-toggle ${ep.enabled ? 'is-on' : ''}" role="switch" aria-checked="${ep.enabled}" tabindex="0"><div class="cq-knob"></div></div><span class="cq-toggle-state">${ep.enabled ? 'Bật' : 'Tắt'}</span></div></td>
        <td style="text-align:right"><button class="cq-btn" data-ep="${idx}" aria-label="Cấu hình ${ep.path}" style="height:28px;padding:0 8px"><i data-lucide="settings-2"></i></button></td>`;
      body.appendChild(tr);
      wireToggle(tr.querySelector('.cq-toggle'));
    });

    wireColumnResize(root);
    wireOnlyOnFilter(root);

    root.querySelectorAll('[data-ep]').forEach((btn) => {
      btn.addEventListener('click', () => openDrawer(root, CQ.mock.ENDPOINTS[Number(btn.dataset.ep)]));
    });

    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
  }

  /* Toggle switch — knob rides a spring (damping 0.8: it has momentum on release). */
  function wireToggle(toggle) {
    const knob = toggle.querySelector('.cq-knob');
    const label = toggle.parentElement.querySelector('.cq-toggle-state');
    const isOn = () => toggle.classList.contains('is-on');
    const s = new SpringValue(isOn() ? 18 : 0, 0.3, 0.8);
    s.subscribe((x) => { knob.style.transform = `translateX(${x}px)`; });
    const flip = () => {
      const next = !isOn();
      toggle.classList.toggle('is-on', next);
      toggle.setAttribute('aria-checked', String(next));
      if (label) label.textContent = next ? 'Bật' : 'Tắt';
      s.animateTo(next ? 18 : 0, { response: 0.3, damping: 0.8 });
    };
    toggle.addEventListener('pointerdown', flip); /* feedback on press, not release */
  }

  function wireOnlyOnFilter(root) {
    const toggle = root.querySelector('#cq-only-on');
    if (!toggle) return;
    const s = new SpringValue(18, 0.3, 0.8);
    const knob = toggle.querySelector('.cq-knob');
    s.subscribe((x) => { knob.style.transform = `translateX(${x}px)`; });
    const body = root.querySelector('#cq-ep-body');
    toggle.addEventListener('pointerdown', () => {
      const next = !toggle.classList.contains('is-on');
      toggle.classList.toggle('is-on', next);
      s.animateTo(next ? 18 : 0, { response: 0.3, damping: 0.8 });
      const rows = Array.from(body.children);
      rows.forEach((tr, i) => {
        const ep = CQ.mock.ENDPOINTS[i];
        tr.style.display = next && !ep.enabled ? 'none' : '';
      });
    });
  }

  /* Column resize — 1:1 with the pointer, respecting the grab offset on the handle. */
  function wireColumnResize(root) {
    root.querySelectorAll('.cq-th-resizer').forEach((rz) => {
      const table = root.querySelector('#cq-ep-table');
      const colIdx = Number(rz.dataset.col);
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        rz.setPointerCapture(e.pointerId);
        const col = table.querySelectorAll('col')[colIdx];
        const tableW = table.clientWidth;
        /* Convert the % width to px once; from here the column lives in px. */
        const startW = (parseFloat(col.style.width) / 100) * tableW;
        const startX = e.clientX;
        const move = (ev) => {
          col.style.width = Math.max(56, startW + (ev.clientX - startX)) + 'px';
        };
        const up = () => {
          rz.removeEventListener('pointermove', move);
          rz.removeEventListener('pointerup', up);
        };
        rz.addEventListener('pointermove', move);
        rz.addEventListener('pointerup', up);
      });
    });
  }

  /* ---------- Drawer: spring sheet, anchored, drag-to-dismiss ---------- */
  function openDrawer(root, ep) {
    const scrim = document.getElementById('cq-drawer-scrim');
    const drawer = document.getElementById('cq-drawer');
    drawerState.ep = ep;
    drawerState.open = true;

    drawer.querySelector('#cq-drawer-title').textContent = ep.method + ' ' + ep.path;
    drawer.querySelector('#cq-drawer-desc').value = ep.desc;
    drawer.querySelector('#cq-drawer-rpm').value = ep.rpm;
    drawer.querySelector('#cq-drawer-burst').value = Math.max(5, Math.round(ep.rpm / 10));
    drawer.querySelector('#cq-drawer-timeout').value = '120s';

    /* Anchor: spatial consistency — the sheet originates from the triggering row. */
    drawer.style.transformOrigin = 'right center';
    scrim.classList.add('is-open');
    if (!drawerState.x) {
      drawerState.x = new SpringValue(400, 0.35, 1.0);
      drawerState.x.subscribe((x) => { drawer.style.transform = `translateX(${x}px)`; });
    }
    drawerState.x.jump(400);
    drawerState.x.animateTo(0, { response: 0.35, damping: 1.0 });
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
    void root;
  }

  function closeDrawer(velocity) {
    const scrim = document.getElementById('cq-drawer-scrim');
    const drawer = document.getElementById('cq-drawer');
    drawerState.open = false;
    scrim.classList.remove('is-open');
    drawerState.x.animateTo(420, { response: 0.3, damping: 1.0, velocity: velocity || 0 });
  }

  function wireDrawer() {
    const scrim = document.getElementById('cq-drawer-scrim');
    const drawer = document.getElementById('cq-drawer');
    const grab = drawer.querySelector('.cq-drawer-grab');
    scrim.addEventListener('click', () => closeDrawer(0));
    drawer.querySelector('#cq-drawer-cancel').addEventListener('click', () => closeDrawer(0));
    drawer.querySelector('#cq-drawer-save').addEventListener('click', () => closeDrawer(0));
    drawer.querySelector('#cq-drawer-close-x').addEventListener('click', () => closeDrawer(0));

    /* Drag-to-dismiss: 1:1 tracking, rubber-band past the left edge,
       commit decided by VELOCITY sign at release (not just position). */
    grab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grab.setPointerCapture(e.pointerId);
      const startCX = e.clientX;
      const startX = drawerState.x.v;
      const track = velocityTracker();
      track.push(e.clientX, performance.now());
      let current = startX;
      const move = (ev) => {
        const dx = ev.clientX - startCX;
        const raw = startX + dx;
        current = raw < 0 ? -rubberband(-raw, 420) : raw;
        drawerState.x.jump(current);
        track.push(ev.clientX, performance.now());
      };
      const up = () => {
        grab.removeEventListener('pointermove', move);
        grab.removeEventListener('pointerup', up);
        grab.removeEventListener('pointercancel', up);
        const vel = track.release();
        if (vel > 450 || current > 168) closeDrawer(vel);
        else drawerState.x.animateTo(0, { response: 0.32, damping: 0.85, velocity: vel });
      };
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', up);
      grab.addEventListener('pointercancel', up);
    });
  }

  /* ---------- Credentials ---------- */
  function renderCredentials(root) {
    if (root.dataset.built) return;
    const rows = CQ.mock.KEYS.map((k) => `
      <div class="cq-keyrow">
        <i data-lucide="key-round" aria-hidden="true" style="width:15px;height:15px;color:var(--cq-text-faint)"></i>
        <div style="min-width:0"><div class="cq-key-name">${k.name}</div><div class="cq-key-masked">${k.masked}</div></div>
        <span class="cq-tag ${k.role === 'admin' ? 'cq-tag-admin' : 'cq-tag-user'}">${k.role}</span>
        <span class="cq-tag cq-tag-ok">Hoạt động</span>
        <span style="margin-left:auto;font-size:11.5px;color:var(--cq-text-dim)">${k.reqs} req</span>
        <span style="font-size:11px;color:var(--cq-text-faint)">${k.used}</span>
      </div>`).join('');
    const wl = CQ.mock.WHITELIST.map((ip) => `<span class="cq-chip is-on"><span class="cq-dot" style="background:#56e0bd"></span>${ip}</span>`).join('');
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">Credentials</div>
        <div class="cq-view-sub">Plaintext key chỉ hiển thị một lần khi tạo — danh sách luôn ở dạng masked</div></div>
        <div class="cq-view-actions"><button class="cq-btn is-primary"><i data-lucide="plus"></i>Tạo key</button></div>
      </div>
      <div class="cq-table-wrap" style="margin-bottom:14px">${rows}</div>
      <div class="cq-panel">
        <div class="cq-panel-title">IP whitelist</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${wl}
          <button class="cq-btn" style="height:28px"><i data-lucide="plus"></i>Thêm CIDR</button>
        </div>
        <div class="cq-hint">Webhook: POST https://hooks.example.com/cq-alerts — sự kiện circuit_open, usage_quota_exceeded</div>
      </div>`;
    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
  }

  /* ---------- Sandbox ---------- */
  function renderSandbox(root) {
    if (root.dataset.built) return;
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">Sandbox</div>
        <div class="cq-view-sub">Kiểm thử payload trực tiếp — phản hồi mô phỏng theo schema thật</div></div>
      </div>
      <div class="cq-sandbox-grid">
        <div>
          <div class="cq-sandbox-row">
            <select class="cq-select" id="cq-sb-method"><option>POST</option><option>GET</option></select>
            <input class="cq-input" id="cq-sb-path" value="/v1/messages" spellcheck="false">
          </div>
          <label class="cq-field-label" for="cq-sb-body">Request body</label>
          <textarea class="cq-textarea" id="cq-sb-body" spellcheck="false">{
  "model": "claude-opus-5-5",
  "max_tokens": 256,
  "stream": true,
  "messages": [
    { "role": "user", "content": "Kiểm tra kết nối ClickQuota" }
  ]
}</textarea>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="cq-btn is-primary" id="cq-sb-send"><i data-lucide="send"></i>Send</button>
            <button class="cq-btn" id="cq-sb-reset"><i data-lucide="rotate-ccw"></i>Reset</button>
          </div>
        </div>
        <div>
          <span class="cq-field-label">Response</span>
          <pre class="cq-response" id="cq-sb-res">— Chưa gửi request nào —</pre>
        </div>
      </div>`;
    root.querySelector('#cq-sb-send').addEventListener('click', () => {
      const out = root.querySelector('#cq-sb-res');
      out.textContent = '⟳ Đang gọi upstream…';
      const s = new SpringValue(0, 0.3, 1.0);
      setTimeout(() => {
        const body = root.querySelector('#cq-sb-body').value;
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { parsed = { raw: 'invalid json' }; }
        const resp = {
          id: 'msg_01H' + Math.random().toString(36).slice(2, 10).toUpperCase(),
          type: 'message',
          role: 'assistant',
          model: parsed.model || 'claude-opus-5-5',
          content: [{ type: 'text', text: 'Pong — sandbox ClickQuota nhận được yêu cầu của bạn.' }],
          usage: { input_tokens: 21, output_tokens: 18 },
        };
        out.innerHTML = JSON.stringify(resp, null, 2)
          .replace(/"([^"]+)":/g, '<span class="cq-response-key">"$1"</span>:')
          .replace(/: "([^"]*)"/g, ': <span class="cq-response-str">"$1"</span>');
        out.style.opacity = '0.4';
        s.subscribe((v) => { out.style.opacity = String(0.4 + 0.6 * v); });
        s.animateTo(1, { response: 0.32, damping: 1.0 });
      }, 620);
    });
    root.querySelector('#cq-sb-reset').addEventListener('click', () => {
      root.querySelector('#cq-sb-res').textContent = '— Chưa gửi request nào —';
    });
    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
  }

  CQ.viewsApi = { renderDashboard, renderEndpoints, renderCredentials, renderSandbox, wireDrawer };
})(window.CQ = window.CQ || {});
