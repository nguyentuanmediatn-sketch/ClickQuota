/* CQ.mock — realistic fixtures grounded in the ClickQuota product:
   real endpoints/paths, real traffic shape (84% 2xx, some 429/5xx), 20k audit rows. */
(function (CQ) {
  'use strict';

  /* Deterministic PRNG so every render shows the same world. */
  let seed = 20261028;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function rint(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

  const ENDPOINTS = [
    { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI dialect — JSON hoặc SSE', enabled: true, rpm: 120, p95: 1840, uptime: 99.94 },
    { method: 'POST', path: '/v1/messages', desc: 'Anthropic Messages dialect', enabled: true, rpm: 120, p95: 1720, uptime: 99.96 },
    { method: 'POST', path: '/v1/responses', desc: 'OpenAI Responses — previous_response_id', enabled: true, rpm: 90, p95: 1610, uptime: 99.91 },
    { method: 'POST', path: '/v1/messages/count_tokens', desc: 'Đếm token ước lượng', enabled: true, rpm: 240, p95: 24, uptime: 100 },
    { method: 'GET', path: '/v1/models', desc: 'Danh sách model alias', enabled: true, rpm: 60, p95: 18, uptime: 100 },
    { method: 'GET', path: '/health', desc: 'Health probe (không cần key)', enabled: true, rpm: 300, p95: 6, uptime: 100 },
    { method: 'GET', path: '/api/status', desc: 'Trạng thái pool tổng hợp', enabled: true, rpm: 30, p95: 42, uptime: 99.99 },
    { method: 'POST', path: '/api/quota/refresh', desc: 'Audit quota toàn pool', enabled: false, rpm: 6, p95: 3900, uptime: 99.7 },
    { method: 'POST', path: '/v1/images', desc: 'Muse provider — image proxy', enabled: true, rpm: 20, p95: 5200, uptime: 98.8 },
    { method: 'DELETE', path: '/admin/api/keys', desc: 'Xóa API key (role admin)', enabled: true, rpm: 5, p95: 31, uptime: 100 },
  ];

  const KEYS = [
    { name: 'Default Gateway Key', masked: 'sk-Xq2••••••••9fZa', role: 'admin', used: 'phút trước', reqs: '1 284 / ∞' },
    { name: 'ZCode IDE', masked: 'sk-Pm7••••••••kQ2d', role: 'user', used: '12 giây trước', reqs: '8 902 / 20 000' },
    { name: 'CI Pipeline', masked: 'sk-Lw4••••••••8hTn', role: 'user', used: '3 giờ trước', reqs: '612 / 5 000' },
    { name: 'Sandbox Testing', masked: 'sk-Aa9••••••••3cFe', role: 'user', used: '2 ngày trước', reqs: '27 / 1 000' },
  ];

  const WHITELIST = ['127.0.0.1/32', '::1/128', '192.168.1.0/24'];

  const ALERTS = [
    { sev: 'error', icon: 'octagon-alert', title: 'Circuit Breaker mở — workspace "Workspace (0421)"', body: '3 lỗi 502 liên tiếp từ upstream gateway. Cách ly 180 giây, Telegram đã gửi CIRCUIT_OPEN.', meta: 'ws_hash: 9f21c4a8b6d0 · 14:07:32', resolved: false },
    { sev: 'warn', icon: 'gauge', title: '429 Fair-Use spike — 42% pool trong 5 phút', body: 'USAGE_QUOTA_EXCEEDED trên 9/21 workspace. Cooldown theo dailyResetsAt thật (07:00 VN).', meta: 'audit #4471 · 13:55:10', resolved: false },
    { sev: 'warn', icon: 'key-round', title: 'cu_refresh rotation chạm throttle 60s', body: 'Mint mutex đã serialize 3 mint song song cho cùng tài khoản — không còn 401 cascade.', meta: 'acc-8829 · 13:41:52', resolved: true },
    { sev: 'info', icon: 'refresh-cw', title: 'Quota audit hoàn tất — 21/21 workspace', body: 'Độ trễ audit p95 412ms. Không workspace nào ở trạng thái stale (>30 phút).', meta: 'cron 15m · 13:30:00', resolved: true },
  ];

  const AUDIT_PATHS = [
    ['POST', '/v1/messages', 58], ['POST', '/v1/chat/completions', 24],
    ['POST', '/v1/responses', 9], ['GET', '/v1/models', 3],
    ['POST', '/v1/images', 2], ['GET', '/health', 4],
  ];

  const PAYLOAD_KEYS = ['model', 'stream', 'max_tokens', 'input_tokens', 'ttft_ms', 'workspace_hash'];

  function makeAuditRows(n) {
    const rows = new Array(n);
    const base = Date.now() - n * 900;
    for (let i = 0; i < n; i++) {
      const roll = rnd();
      let path = AUDIT_PATHS[0];
      let acc = 0;
      for (const p of AUDIT_PATHS) { acc += p[2] / 100; if (roll <= acc) { path = p; break; } }
      let status = 200;
      const sr = rnd();
      if (sr > 0.98) status = 429; else if (sr > 0.965) status = 502; else if (sr > 0.95) status = 400; else if (sr > 0.94) status = 503;
      const latency = status === 200 ? rint(120, 2600) : rint(8, 180);
      const t = new Date(base + i * 900);
      rows[i] = {
        i,
        ts: t,
        level: status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : pick(['INFO', 'INFO', 'INFO', 'DEBUG']),
        method: path[0],
        path: path[1],
        status,
        latency,
        ip: status >= 400 ? pick(['203.113.7.42', '118.70.12.9']) : pick(['127.0.0.1', '127.0.0.1', '127.0.0.1', '192.168.1.24']),
        payload: buildPayload(status, latency),
      };
    }
    return rows;
  }

  function buildPayload(status, latency) {
    const p = {
      model: pick(['claude-opus-5-5', 'gpt-6.1-sol-CL', 'claude-sonnet-5-5']),
      stream: rnd() > 0.4,
      workspace_hash: '9f21c4a8b6d0',
      input_tokens: rint(320, 14800),
      output_tokens: rint(24, 2100),
      ttft_ms: latency,
      result: status === 200 ? 'success' : status === 429 ? 'quota_exhausted' : 'upstream_error',
    };
    if (status >= 400) {
      p.error = status === 429
        ? { code: 'usage_quota_exceeded', message: 'Fair use daily limit exceeded — cooldown đến 07:00' }
        : { code: 'clickup_error', message: 'HTTP ' + status + ' from upstream gateway' };
    }
    return p;
  }

  function liveAuditRow() {
    const row = makeAuditRows(1)[0];
    row.ts = new Date();
    return row;
  }

  const SYS_LINES = (() => {
    const out = [];
    const tags = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
    const msgs = [
      'pool: workspace "Workspace (0312)" rời cooldown — quay lại vòng xoay',
      'upstream: gateway token exchange ok (TTL 300s, dedupe in-flight)',
      'alert/telegram: digest 24h — 1 284 req, 96 lỗi, uptime 99.2%',
      'recreate: pending_recreate step=complete — 10 workspace mới, trial MAX 23',
      'audit: quota fresh 21/21 — dailyResetsAt đồng bộ 07:00 VN',
      'server: POST /v1/messages 200 — 1 842ms, ttft 1 204ms',
      'pool: circuit breaker đóng — consecutiveErrors reset về 0',
      'muse: healthz 200 — latency 3ms (loopback)',
      'upstream: HTTP 429 usage_quota_exceeded — workspace cách ly',
      'config: admin settings loaded (atomic write, mode 0600)',
    ];
    let t = Date.now() - 400 * 900;
    for (let i = 0; i < 260; i++) {
      const tag = pick(tags);
      t += rint(200, 2400);
      out.push({ t: new Date(t), tag, msg: pick(msgs) });
    }
    return out.reverse();
  })();

  const METRICS = {
    requests: '12 847',
    p95: '1 842ms',
    p99: '3 106ms',
    err4xx: '0.9%',
    err5xx: '2.1%',
    spark: (() => {
      const pts = [];
      let v = 42;
      for (let i = 0; i < 48; i++) { v = Math.max(12, Math.min(92, v + (rnd() - 0.48) * 16)); pts.push(v); }
      return pts;
    })(),
    statuses: [
      { label: '2xx', pct: 84.1, cls: 'cq-method-get' },
      { label: '4xx', pct: 0.9, cls: 'cq-method-put' },
      { label: '429', pct: 1.3, cls: 'cq-method-put' },
      { label: '5xx', pct: 2.1, cls: 'cq-method-delete' },
    ],
  };

  CQ.mock = { ENDPOINTS, KEYS, WHITELIST, ALERTS, makeAuditRows, liveAuditRow, SYS_LINES, METRICS, PAYLOAD_KEYS };
})(window.CQ = window.CQ || {});
