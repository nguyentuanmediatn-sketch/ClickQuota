/* CQ.viewsLog — System Logs views: system console, API audit (floating toolbar,
   virtualized rows, spring expandable JSON detail, live tail), alerts. */
(function (CQ) {
  'use strict';
  const { SpringValue } = CQ.springs;
  const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

  /* ---------- /log/system — console ---------- */
  function renderSystem(root) {
    if (root.dataset.built) return;
    const lines = CQ.mock.SYS_LINES;
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">System log</div>
        <div class="cq-view-sub">stdout/stderr runtime — 260 dòng gần nhất</div></div>
        <div class="cq-view-actions">
          <div class="cq-toggle-row"><div class="cq-toggle is-on" id="cq-sys-tail" role="switch" aria-checked="true" tabindex="0"><div class="cq-knob"></div></div><span class="cq-toggle-state">Follow</span></div>
        </div>
      </div>
      <div class="cq-console" id="cq-console" role="log" aria-label="Nhật ký hệ thống"></div>`;
    const console_ = root.querySelector('#cq-console');
    console_.innerHTML = lines.map(fmtLine).join('');
    console_.scrollTop = console_.scrollHeight;
    root.dataset.built = '1';
  }

  function fmtLine(l) {
    const cls = l.tag === 'ERROR' ? 'cq-console-tag-error' : l.tag === 'WARN' ? 'cq-console-tag-warn' : 'cq-console-tag-info';
    const t = l.t.toLocaleTimeString('vi-VN', { hour12: false });
    return `<div class="cq-console-line"><span class="cq-console-t">${t}</span> <span class="${cls}">[${l.tag}]</span> ${l.msg}</div>`;
  }

  /* ---------- /log/api-audit — the flagship view ---------- */
  const auditState = { all: [], filtered: [], query: '', levels: new Set(LEVELS), range: '1h', live: false, vl: null, timer: null };

  function renderAudit(root) {
    if (root.dataset.built) {
      auditState.vl && auditState.vl.paint();
      return;
    }
    auditState.all = CQ.mock.makeAuditRows(20000);
    auditState.filtered = auditState.all;

    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">API audit</div>
        <div class="cq-view-sub">Access log toàn bộ request — cuộn 60fps trên 20 000 dòng (virtualized)</div></div>
        <div class="cq-view-actions"><span class="cq-toolbar-count" id="cq-audit-count"></span></div>
      </div>
      <div class="cq-log-toolbar" role="toolbar" aria-label="Bộ lọc log">
        <div class="cq-log-search"><i data-lucide="search" aria-hidden="true" style="width:14px;height:14px;flex:none"></i>
          <input id="cq-audit-q" placeholder="Tìm /regex/ hoặc full-text…" spellcheck="false" aria-label="Tìm kiếm log">
        </div>
        <select class="cq-select-compact" id="cq-audit-range" aria-label="Khoảng thời gian">
          <option value="15m">15 phút</option><option value="1h" selected>1 giờ</option>
          <option value="6h">6 giờ</option><option value="24h">24 giờ</option>
        </select>
        ${LEVELS.map((lv) => `<button class="cq-chip ${lv === 'DEBUG' || lv === 'INFO' ? 'is-on' : ''}" data-level="${lv}"><span class="cq-dot" style="background:${levelDot(lv)}"></span>${lv}</button>`).join('')}
        <button class="cq-chip" id="cq-audit-live" aria-pressed="false"><span class="cq-live-dot" id="cq-audit-livedot"></span>Live tail</button>
      </div>
      <div class="cq-log-list" id="cq-audit-list" role="listbox" aria-label="Danh sách request log"></div>
      <div class="cq-log-detail" id="cq-audit-detail" style="display:none"></div>`;

    const list = root.querySelector('#cq-audit-list');
    const detail = root.querySelector('#cq-audit-detail');
    auditState.vl = new CQ.VirtualList(list, 34, renderAuditRow);
    auditState.vl.setDetail(detail);
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.cq-log-row');
      if (!row) return;
      auditState.vl.toggleDetail(Number(row.dataset.idx), buildDetail);
    });

    const q = root.querySelector('#cq-audit-q');
    q.addEventListener('input', () => { auditState.query = q.value; applyFilters(); });

    root.querySelectorAll('[data-level]').forEach((chip) => {
      chip.addEventListener('pointerdown', () => {
        const lv = chip.dataset.level;
        const on = chip.classList.toggle('is-on');
        on ? auditState.levels.add(lv) : auditState.levels.delete(lv);
        applyFilters();
      });
    });

    root.querySelector('#cq-audit-range').addEventListener('change', (e) => {
      auditState.range = e.target.value;
      applyFilters();
    });

    root.querySelector('#cq-audit-live').addEventListener('pointerdown', () => toggleLive(root));
    auditState.vl.setRows(auditState.filtered);
    updateCount();
    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 14, height: 14 } });
  }

  function levelDot(lv) {
    return { DEBUG: '#9aa3b5', INFO: '#5a8df5', WARN: '#f5a524', ERROR: '#f87171', FATAL: '#e5484d' }[lv];
  }

  function renderAuditRow(el, r, idx) {
    el.dataset.idx = idx;
    const t = r.ts.toLocaleTimeString('vi-VN', { hour12: false });
    const sc = Math.floor(r.status / 100);
    el.innerHTML = `
      <span class="cq-log-time">${t}</span>
      <span><span class="cq-method cq-method-${r.method.toLowerCase()}" style="min-width:44px">${r.method}</span></span>
      <span class="cq-level cq-level-${r.level.toLowerCase()}">${r.level}</span>
      <span class="cq-log-path">${r.path}</span>
      <span class="cq-log-status cq-status-${sc}">${r.status}</span>
      <span class="cq-log-lat ${r.latency > 2000 ? 'is-slow' : ''}">${r.latency}ms</span>
      <span class="cq-log-ip">${r.ip}</span>`;
  }

  function buildDetail(detail, r) {
    const t = r.ts.toLocaleString('vi-VN', { hour12: false });
    detail.innerHTML = `
      <div class="cq-log-detail-inner">
        <div class="cq-log-detail-head">
          <span class="cq-method cq-method-${r.method.toLowerCase()}">${r.method}</span>
          <span class="cq-log-detail-title">${r.path}</span>
          <span class="cq-log-time">${t} · ${r.ip} · ${r.latency}ms</span>
          <span class="cq-toolbar-count" style="margin-left:auto">request_id ${String(r.i).padStart(6, '0')}</span>
        </div>
        <pre>${escapeHtml(JSON.stringify(r.payload, null, 2))}${r.status >= 500 ? '\n\n<span class="cq-stack">at ClickUpUpstream.executePooledUpstream (upstream.mjs:752)\nat pool.WorkspacePool.acquire (pool.mjs:288)\nat async server.handleMessages (server.mjs:731)</span>' : ''}</pre>
      </div>`;
  }

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function applyFilters() {
    const q = auditState.query.trim();
    let rx = null;
    if (q.startsWith('/') && q.endsWith('/') && q.length > 2) {
      try { rx = new RegExp(q.slice(1, -1), 'i'); } catch { rx = null; }
    }
    const ql = q.toLowerCase();
    const base = auditState.all;
    auditState.filtered = base.filter((r) => {
      if (!auditState.levels.has(r.level)) return false;
      if (auditState.range !== '24h') {
        const span = { '15m': 15, '1h': 60, '6h': 360 }[auditState.range] * 60000;
        if (Date.now() - r.ts.getTime() > span) return false;
      }
      if (!q) return true;
      if (rx) return rx.test(r.path) || rx.test(r.method) || String(r.status) === q.replace(/\//g, '');
      return r.path.toLowerCase().includes(ql) || String(r.status).includes(ql) || r.ip.includes(ql) || r.method.toLowerCase() === ql;
    });
    auditState.vl.setRows(auditState.filtered);
    updateCount();
  }

  function updateCount() {
    const el = document.getElementById('cq-audit-count');
    if (el) el.textContent = `${auditState.filtered.length.toLocaleString('vi-VN')} / ${auditState.all.length.toLocaleString('vi-VN')} dòng`;
  }

  function toggleLive(root) {
    const btn = root.querySelector('#cq-audit-live');
    const dot = root.querySelector('#cq-audit-livedot');
    auditState.live = !auditState.live;
    btn.classList.toggle('is-on', auditState.live);
    btn.setAttribute('aria-pressed', String(auditState.live));
    dot.classList.toggle('is-pulsing', auditState.live);
    if (auditState.live) {
      auditState.timer = setInterval(() => {
        const row = CQ.mock.liveAuditRow();
        row.level = row.status >= 500 ? 'ERROR' : row.status >= 400 ? 'WARN' : 'INFO';
        auditState.all.unshift(row);
        if (auditState.matchesFilters(row)) auditState.filtered.unshift(row);
        auditState.vl.setRows(auditState.filtered);
        if (auditState.live && auditState.vl.sc.scrollTop < 40) auditState.vl.sc.scrollTop = 0;
        updateCount();
      }, 900);
    } else {
      clearInterval(auditState.timer);
    }
  }

  auditState.matchesFilters = function (r) {
    if (!auditState.levels.has(r.level)) return false;
    const ql = auditState.query.trim().toLowerCase();
    if (!ql) return true;
    return r.path.toLowerCase().includes(ql) || String(r.status).includes(ql);
  };

  /* ---------- /log/alerts ---------- */
  function renderAlerts(root) {
    if (root.dataset.built) return;
    const meta = { error: '', warn: 'is-warn', info: 'is-info' };
    root.innerHTML = `
      <div class="cq-view-head">
        <div><div class="cq-view-title">Alerts</div>
        <div class="cq-view-sub">Cảnh báo real-time — Telegram bot nhận cùng sự kiện qua alert bus</div></div>
        <div class="cq-view-actions"><span class="cq-toolbar-count"><span class="cq-live-dot is-pulsing" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Đang lắng nghe</span></div>
      </div>
      <div id="cq-alert-list">
        ${CQ.mock.ALERTS.map((a, i) => `
          <div class="cq-alert ${a.resolved ? 'is-resolved' : meta[a.sev] || ''}">
            <i data-lucide="${a.icon}" class="cq-alert-icon" aria-hidden="true" style="width:17px;height:17px"></i>
            <div style="min-width:0">
              <div class="cq-alert-title">${a.title}</div>
              <div class="cq-alert-body">${a.body}</div>
              <div class="cq-alert-meta">${a.meta}</div>
            </div>
            ${a.resolved ? '<span class="cq-tag cq-tag-ok cq-alert-ack">Đã xử lý</span>' : `<button class="cq-btn cq-alert-ack" data-ack="${i}">Acknowledge</button>`}
          </div>`).join('')}
      </div>`;
    root.querySelectorAll('[data-ack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.cq-alert');
        const s = new SpringValue(1, 0.35, 1.0);
        s.subscribe((v) => { card.style.opacity = String(v); card.style.transform = `translateX(${(1 - v) * -8}px)`; });
        s.animateTo(0.75, { response: 0.35, damping: 1.0 });
        card.classList.add('is-resolved');
        btn.outerHTML = '<span class="cq-tag cq-tag-ok cq-alert-ack">Đã xử lý</span>';
        if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
      });
    });
    root.dataset.built = '1';
    if (window.lucide) lucide.createIcons({ attrs: { width: 15, height: 15 } });
  }

  CQ.viewsLog = { renderSystem, renderAudit, renderAlerts };
})(window.CQ = window.CQ || {});
