import { UpstreamQueue } from '../../upstream-queue.mjs';
// src/clickup-pool.mjs
// ClickUp Workspace & Account Pool Management for SharkPool
// Supports dynamic multi-workspace load balancing, adaptive micro-pacing,
// automatic gateway token exchange, and session auto-renewal via account cookies.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

// 2026-10-28 (P2, REL-09): dùng store chung của config.mjs — APP_ROOT-anchored
// (tôn trọng CLICKQUOTA_STATE_DIR), đọc lỗi THROW (không còn default-rỗng khiến
// persist ghi đè mất state thật), temp file duy nhất theo pid + cleanup trong finally.
import { readPoolConfig, persistPoolConfig, STATE_FILE } from '../../config.mjs';
import { alertEvents, ALERT_EVENTS } from '../../alert/events.mjs';

function getClickUpApiBase() {
  return (process.env.CLICKUP_API_BASE || 'https://api.clickup.com').replace(/\/+$/, '');
}
function getClickUpIdBase() {
  return (process.env.CLICKUP_ID_BASE || 'https://id.app.clickup.com').replace(/\/+$/, '');
}



// UpstreamQueue is imported from ./upstream-queue.mjs

export const DEFAULT_SPACES = [
  {
    name: 'Space',
    customStatus: false,
    multiple_assignees: true,
    statuses: [
      { status: 'to do', orderindex: 0, color: '#d3d3d3', type: 'open' },
      { status: 'in progress', orderindex: 1, color: '#6647f0', type: 'custom' },
      { status: 'complete', orderindex: 2, color: '#6bc950', type: 'closed' },
    ],
    features: {
      priorities: { enabled: true },
      tags: { enabled: true },
      custom_fields: { enabled: true },
      time_tracking: { enabled: true, rollup: false },
      milestones: { enabled: true },
      sprints: {
        enabled: true,
        settings: {
          name_format: 'Sprint {INDEX} ({START_DATE} - {END_DATE})',
          start_day: 1,
          estimation: 'time_estimate',
          close_past_sprints: false,
          duration_number: 1,
          duration_timeframe: 'weeks',
          date_format: 'D/M',
          capacity: 0,
          start_time_offset: 0,
          non_working_days: [0, 6],
          auto_lock_forecast_at_start: false,
          auto_create_dashboard_as_view_each_sprint: false,
        },
      },
      due_dates: { enabled: true, remap_due_dates: false },
      emails: { enabled: false },
      check_unresolved: { enabled: false },
      dependency_warning: { enabled: false },
      remap_dependencies: { enabled: false },
    },
  },
];

export function planNames(teams, email, count) {
  let prefix = 'zcode_';
  if (email && typeof email === 'string') {
    const pos = email.lastIndexOf('@');
    if (pos >= 1) {
      prefix = email.slice(0, pos).normalize('NFC').replace(/[^a-zA-Z0-9_-]/g, '_') + '_';
    }
  }
  let max = 0;
  let width = 2;
  for (const t of teams || []) {
    if (typeof t.name !== 'string' || !t.name.startsWith(prefix)) continue;
    const n = t.name.slice(prefix.length);
    if (!/^\d+$/.test(n)) continue;
    const num = Number(n);
    if (!Number.isSafeInteger(num)) continue;
    max = Math.max(max, num);
    width = Math.max(width, n.length);
  }
  if (width > 12 || !Number.isSafeInteger(max + count)) {
    throw new Error('Workspace numbering exceeds safe limits.');
  }
  return Array.from({ length: count }, (_, i) => prefix + String(max + i + 1).padStart(width, '0'));
}

export function isManagedWorkspaceName(name, prefix = null) {
  if (typeof name !== 'string') return false;
  if (prefix && name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))) {
    return true;
  }
  if (/^ZCode Workspace \d+$/i.test(name) || /^zcode_\d+$/i.test(name)) {
    return true;
  }
  return false;
}

export function getNextDailyResetTime() {
  // 2026-10-28 (P3): reset thật là 07:00 sáng giờ VN = 00:00 UTC. Bản cũ ghim
  // 07:00 UTC (= 14:00 VN) — over-cool tối đa 7 tiếng so với reset thật.
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
}

/**
 * WorkspacePool - Quản lý danh sách Workspace, Token, Gateway Exchange & Auto-Renewal
 */
export class WorkspacePool {
  constructor(config = {}, onPersist = null) {
    this.workspaces = [];
    this.accounts = [];
    // Session affinity: hội thoại -> workspace (in-memory, TTL 12h, tối đa 2000 pin).
    // Pin là tối ưu hiệu năng — mất khi restart không ảnh hưởng đúng/sai của request.
    this.sessionPins = new Map();
    this.defaults = {
      workspaceId: '',
      model: 'gpt-6-luna',
    };
    this.maxConcurrentPerWorkspace = 3;
    this.onPersist = onPersist;
    this._lastConfigMtime = 0;
    this._lastDiskCheck = 0;
    this.initFromConfig(config);
    if (typeof this.onPersist === 'function') {
      this._initConfigFileWatcher();
    }
  }

  _initConfigFileWatcher() {
    if (process.env.NODE_ENV === 'test' || process.argv.some((a) => a.includes('test'))) return;
    try {
      if (typeof this.onPersist !== 'function') return;
      if (this._fileWatcher) {
        try { this._fileWatcher.close(); } catch {}
        this._fileWatcher = null;
      }
      if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
      let debounceTimer = null;
      this._fileWatcher = fs.watch(STATE_FILE, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this._syncFromDiskIfModified();
        }, 300);
      });
      this._fileWatcher.on?.('error', () => {
        try { this._fileWatcher?.close(); } catch {}
        this._fileWatcher = null;
      });
      if (this._fileWatcher.unref) this._fileWatcher.unref();
    } catch {}
  }

  _syncFromDiskIfModified() {
    try {
      if (typeof this.onPersist !== 'function') return;
      if (this._isPersisting || this._isRecreating) return;
      if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
      const stat = fs.statSync(STATE_FILE);
      if (this._lastConfigMtime && stat.mtimeMs <= this._lastConfigMtime) return;
      this._lastConfigMtime = stat.mtimeMs;
      const conf = readPoolConfig();
      if (Array.isArray(conf.workspaces) && conf.workspaces.length > 0) {
        console.log(`[ClickUpPool] 🔄 Đồng bộ cấu hình từ file (${conf.workspaces.length} workspaces, ${conf.accounts?.length || 0} accounts)...`);
        this.initFromConfig(conf);
      }
    } catch {}
  }

  initFromConfig(config = {}) {
    const rawWorkspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
    this.maxConcurrentPerWorkspace = Number(config.maxConcurrentPerWorkspace ?? 3);
    this.pending_recreate = config.pending_recreate || null;
    this.defaults = {
      workspaceId: config.defaults?.workspaceId || config.workspaceId || '',
      model: config.defaults?.model || 'gpt-6-luna',
    };
    // Tự vệ: defaults.workspaceId trỏ vào workspace không còn tồn tại (dữ liệu cũ
    // ví dụ '1100380000020899') sẽ vô hiệu hóa preferred routing — bỏ để balancer chạy bình thường.
    if (this.defaults.workspaceId && !rawWorkspaces.some((w) => String(w.workspaceId || '') === this.defaults.workspaceId)) {
      console.warn(`[ClickUpPool] defaults.workspaceId "${this.defaults.workspaceId}" không tồn tại trong pool — bỏ qua.`);
      this.defaults.workspaceId = '';
    }

    this.workspaces = rawWorkspaces.map((w, idx) => {
      const qLimit = Number(w.limit ?? this.maxConcurrentPerWorkspace);
      return {
        id: w.id || `ws-${w.workspaceId || idx}`,
        label: w.label || `Workspace ${idx + 1}`,
        workspaceId: String(w.workspaceId || ''),
        accountId: w.accountId || null,
        token: String(w.token || ''),
        refreshToken: w.refreshToken || '',
        refreshCookie: w.refreshCookie || '',
        enabled: w.enabled !== false,
        limit: qLimit,
        queue: new UpstreamQueue(qLimit),
        activeRequests: 0,
        totalRequests: Number(w.totalRequests || 0),
        successRequests: Number(w.successRequests || 0),
        errorRequests: Number(w.errorRequests || 0),
        cooldownUntil: Number(w.cooldownUntil || 0),
        cooldownReason: w.cooldownReason || null,
        _circuitOpen: Boolean(w.cooldownUntil && w.cooldownReason?.startsWith('Circuit Breaker:')),
        quotaStatus: w.quotaStatus || 'available',
        quota: w.quota || null,
        // 2026-10-29 (§6.1) Canary quarantine cho "hạn mức ẩn": workspace báo
        // USAGE_QUOTA_EXCEEDED dù entitlement vẫn 'available'. Giữ mốc các lần
        // dính để phát hiện tái phát trong cửa sổ 30 phút.
        hiddenQuotaHits: Array.isArray(w.hiddenQuotaHits) ? w.hiddenQuotaHits.map(Number).filter(Number.isFinite) : [],
        stickyBlockedUntil: Number(w.stickyBlockedUntil || 0),
        lastAiRequestErrorAt: Number(w.lastAiRequestErrorAt || 0),
        lastCanaryAt: Number(w.lastCanaryAt || 0),
        gatewayCache: null,
        lastRenewAttempt: 0,
        lastDispatchedAt: 0,
      };
    });

    const rawAccounts = Array.isArray(config.accounts) ? config.accounts : [];
    this.accounts = rawAccounts.map((a, idx) => ({
      id: a.id || `acc-${a.userId || idx}`,
      label: a.label || a.email || `Tài khoản ${idx + 1}`,
      email: a.email || '',
      userId: a.userId ? Number(a.userId) : null,
      workspaceId: a.workspaceId || null,
      initialToken: a.initialToken || null,
      cookie: a.cookie || '',
      cuRefresh: a.cuRefresh || '',
      lastRenewed: a.lastRenewed || null,
      enabled: a.enabled !== false,
    }));

    for (const ws of this.workspaces) {
      if (!ws.accountId && this.accounts.length > 0) {
        const payload = this.decodeJwt(ws.token);
        if (payload?.user) {
          const matched = this.accounts.find(a => a.userId && a.userId === payload.user);
          if (matched) ws.accountId = matched.id;
        }
        if (!ws.accountId && this.accounts.length === 1) {
          ws.accountId = this.accounts[0].id;
        }
      }
    }
  }

  async _applyAdaptiveMicroPacing(ws, poolSaturation = 0, signal = null) {
    const now = Date.now();
    const sinceLastDispatch = now - (ws.lastDispatchedAt || 0);

    let delayMs = 0;
    if (sinceLastDispatch < 45) {
      delayMs = 45 - sinceLastDispatch;
    }

    if (poolSaturation >= 0.60) {
      const extraPacing = Math.min(
        120,
        Math.round(((poolSaturation - 0.60) / 0.40) * 75)
      );
      delayMs = Math.max(delayMs, extraPacing);
    }

    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(signal?.reason || new Error('Aborted during micro-pacing'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs);
      });
    }

    ws.lastDispatchedAt = Date.now();
  }

  async acquire({ preferredWorkspaceId = null, sessionKey = null, signal = null, excludeWorkspaceIds = [] } = {}) {
    signal?.throwIfAborted?.();
    const now = Date.now();
    if (!this._lastDiskCheck || now - this._lastDiskCheck > 5000) {
      this._lastDiskCheck = now;
      this._syncFromDiskIfModified();
    }
    const excludeList = Array.isArray(excludeWorkspaceIds) ? excludeWorkspaceIds : [];

    for (const ws of this.workspaces) {
      // 2026-10-29 (§6.1): workspace bị khóa vì HẠN MỨC ẨN không được mở lại chỉ
      // vì cooldown hết hạn — phải qua canary (_tryCanaryRelease) xác nhận endpoint
      // /ai thực sự phục vụ lại. Nếu không, mỗi lần cooldown rụng nó lại quay lại
      // pool và đốt một vòng failover.
      if (ws.stickyBlockedUntil && ws.stickyBlockedUntil > now) {
        this._tryCanaryRelease(ws, now);
        continue;
      }
      if (ws.stickyBlockedUntil && ws.stickyBlockedUntil <= now) {
        ws.stickyBlockedUntil = 0;
        ws.hiddenQuotaHits = [];
      }
      if (ws.cooldownUntil && ws.cooldownUntil <= now) {
        ws.cooldownUntil = 0;
        ws.cooldownReason = null;
        // Hết cooldown phải reset cả bộ đếm: nếu không, 1 lỗi mới sau cách ly
        // tái kích hoạt breaker ngay với count phình ("4 lỗi liên tiếp").
        ws.consecutiveErrors = 0;
        ws.rateLimitStreak = 0;
        if (ws.quotaStatus === 'exhausted') {
          ws.quotaStatus = 'available';
        }
        this._emitCircuitClose(ws);
      }
    }

    const available = this.workspaces.filter(
      (w) =>
        w.enabled &&
        w.token &&
        (!w.cooldownUntil || w.cooldownUntil <= now) &&
        !(w.stickyBlockedUntil && w.stickyBlockedUntil > now) &&
        w.quotaStatus !== 'exhausted' &&
        !excludeList.includes(w.workspaceId) &&
        !excludeList.includes(w.id)
    );

    if (!available.length) {
      // Không xóa cooldown cưỡng bức: circuit breaker và rate-limit phải được tôn trọng.
      // Báo rõ thời điểm sớm nhất có workspace hồi phục để client biết khi nào thử lại.
      const cooled = this.workspaces.filter((w) => w.enabled && w.token && w.cooldownUntil && w.cooldownUntil > now);
      const soonest = cooled.length ? cooled.reduce((a, b) => (b.cooldownUntil < a.cooldownUntil ? b : a), cooled[0]).cooldownUntil : 0;
      const retryAfterSeconds = soonest ? Math.max(1, Math.ceil((soonest - now) / 1000)) : null;
      const hint = retryAfterSeconds ? ` Workspace sớm nhất hồi phục sau ${retryAfterSeconds}s.` : '';
      // Phân biệt gốc rễ để client retry đúng cách: cạn QUOTA (429/insufficient_quota)
      // khác với circuit breaker/rate-limit do server lỗi (502/upstream_error).
      const err = new Error('Tất cả Workspace ClickUp trong Pool đều đã cạn Quota ngày hoặc đang cooldown.' + hint);
      err.code = 'POOL_EXHAUSTED';
      err.retryAfterSeconds = retryAfterSeconds;
      err.quotaExhausted = cooled.length > 0 && cooled.every((w) => w.quotaStatus === 'exhausted');
      throw err;
    }

    let totalCap = 0;
    let totalInFlight = 0;
    for (const w of available) {
      totalCap += w.limit;
      totalInFlight += w.activeRequests;
    }
    const poolSaturation = totalCap > 0 ? (totalInFlight / totalCap) : 0;

    if (preferredWorkspaceId) {
      const preferred = available.find(
        (w) => w.workspaceId === preferredWorkspaceId || w.id === preferredWorkspaceId
      );
      if (preferred) {
        return await this._bindWorkspace(preferred, signal, poolSaturation);
      }
    }

    // ── Session Affinity (đa user) ──
    // Hội thoại đã ghim workspace và workspace đó RẢNH (0 in-flight) → trả đúng nơi đó
    // (giữ cache ấm, hành vi ổn định cho một hội thoại). Workspace ghim đang bận →
    // nhường balancer chọn nơi khác để giữ tốc độ; bối cảnh hội thoại KHÔNG mất vì
    // client gửi đủ lịch sử trong payload — session được ghim lại theo nơi phục vụ.
    if (sessionKey) {
      const pinnedId = this.sessionPins.get(sessionKey)?.workspaceId;
      const pinnedWs = pinnedId ? available.find((w) => w.workspaceId === pinnedId) : null;
      if (pinnedWs && pinnedWs.activeRequests === 0) {
        return await this._bindWorkspace(pinnedWs, signal, poolSaturation);
      }
    }

    // ── Thuật toán Cân bằng Tải Đa tầng (Multi-tier Adaptive Load Balancer) ──
    // 1. Phân bổ đồng đều giữa các Workspace (Round-Robin LRU)
    // 2. Chống dồn tải vào 1 Workspace đơn lẻ (Anti-burst Pacing Penalty)
    // 3. Cân đối giữa các Tài khoản Mẹ khác nhau (Cross-Account Balancing)
    // 4. Ưu tiên Workspace có ít kết nối in-flight và còn nhiều Quota nhất
    const lastDispatchedAccId = this._lastDispatchedAccountId || null;

    const scored = available.map((w) => {
      // (a) Trọng số kết nối in-flight: 1 kết nối đang chạy = 10,000 điểm phạt
      const inFlightScore = (w.activeRequests / Math.max(1, w.limit || 3)) * 10000;

      // (b) Trọng số hàng đợi: mỗi request đang đợi trong queue = 25,000 điểm phạt
      const queueScore = (w.queue?.queueLength || 0) * 25000;

      // (c) Chống dồn tải (Anti-burst penalty): nếu vừa dispatch workspace này trong <2.5s,
      // áp dụng điểm phạt lũy tiến để request tiếp theo tự động điều hướng sang workspace khác
      const msSinceLastDispatch = now - (w.lastDispatchedAt || 0);
      let burstPenalty = 0;
      if (msSinceLastDispatch < 2500) {
        burstPenalty = (2500 - msSinceLastDispatch) * 4; // Tối đa 10,000 điểm phạt
      }

      // (d) Cân bằng tài khoản mẹ (Cross-Account Affinity):
      // Nếu có nhiều tài khoản mẹ (x2, x3 quota), ưu tiên xoay vòng sang tài khoản khác tài khoản vừa chạy
      let sameAccountPenalty = 0;
      if (lastDispatchedAccId && w.accountId && w.accountId === lastDispatchedAccId && this.accounts.length > 1) {
        sameAccountPenalty = 3000;
      }

      // (e) Trọng số Quota đã dùng: workspace còn nhiều lượt hơn sẽ có điểm phạt thấp hơn
      let quotaUsagePenalty = 0;
      if (w.quota?.daily?.usage != null && w.quota?.daily?.limit != null && w.quota.daily.limit > 0) {
        const usageRatio = w.quota.daily.usage / w.quota.daily.limit;
        quotaUsagePenalty = usageRatio * 2000;
      }

      // (f) LRU Round-Robin Bonus: workspace có thời điểm dùng càng lâu về trước thì điểm càng thấp (ưu tiên cao)
      // Giới hạn tối đa 5,000 điểm thưởng
      const lruBonus = Math.min(5000, Math.floor(msSinceLastDispatch / 10));

      const totalScore = inFlightScore + queueScore + burstPenalty + sameAccountPenalty + quotaUsagePenalty - lruBonus;

      return {
        ws: w,
        score: totalScore,
        lastDispatchedAt: w.lastDispatchedAt || 0,
        activeRequests: w.activeRequests,
      };
    });

    // Sắp xếp ưu tiên:
    // 1. Workspace có totalScore thấp nhất
    // 2. Nếu điểm xấp xỉ nhau (chênh < 20 điểm), ưu tiên workspace có lastDispatchedAt xa nhất (LRU Round-Robin chuẩn)
    scored.sort((a, b) => {
      if (Math.abs(a.score - b.score) >= 20) {
        return a.score - b.score;
      }
      return a.lastDispatchedAt - b.lastDispatchedAt;
    });

    const chosen = scored[0].ws;
    if (sessionKey) this._pinSession(sessionKey, chosen.workspaceId);
    this._lastDispatchedAccountId = chosen.accountId || null;
    chosen.lastDispatchedAt = now;

    return await this._bindWorkspace(chosen, signal, poolSaturation);
  }

  async _bindWorkspace(ws, signal, poolSaturation = 0) {
    const releaseQueue = await ws.queue.acquire(signal);

    // 2026-10-28 (P3): request có thể chờ queue lâu sau khi acquire() đã lọc cooldown.
    // Nếu workspace vừa dính cooldown/quota-cạn trong lúc request chờ slot, fail fast
    // thay vì vẫn dispatch → 403/429 rồi đốt một vòng failover.
    const now = Date.now();
    if ((ws.cooldownUntil && ws.cooldownUntil > now) || ws.quotaStatus === 'exhausted') {
      releaseQueue();
      const err = new Error(`Workspace "${ws.label}" vừa rơi vào cooldown trong lúc chờ hàng đợi`);
      err.code = 'POOL_EXHAUSTED';
      err.quotaExhausted = ws.quotaStatus === 'exhausted';
      throw err;
    }

    try {
      await this._applyAdaptiveMicroPacing(ws, poolSaturation, signal);
    } catch (err) {
      releaseQueue();
      throw err;
    }

    ws.activeRequests++;
    ws.totalRequests++;
    ws.lastDispatchedAt = Date.now();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ws.activeRequests = Math.max(0, ws.activeRequests - 1);
      releaseQueue();
    };

    return {
      workspace: ws,
      token: ws.token,
      workspaceId: ws.workspaceId,
      release,
    };
  }

  _pinSession(sessionKey, workspaceId) {
    if (!sessionKey || !workspaceId) return;
    const now = Date.now();
    // Giới hạn kích thước + TTL: pin là tối ưu hiệu năng, không phải trạng thái bắt buộc
    if (this.sessionPins.size >= 2000) {
      for (const [key, pin] of this.sessionPins) {
        if (pin.expiresAt <= now) this.sessionPins.delete(key);
      }
      while (this.sessionPins.size >= 2000) {
        this.sessionPins.delete(this.sessionPins.keys().next().value);
      }
    }
    this.sessionPins.set(sessionKey, { workspaceId, expiresAt: now + 12 * 3600 * 1000 });
  }

  reportSuccess(ws, tokens = 0) {
    if (!ws) return;
    ws.successRequests++;
    ws.consecutiveErrors = 0;
    ws.rateLimitStreak = 0;
    if (tokens > 0 && ws.quota) {
      ws.quota.dailyUsage = (ws.quota.dailyUsage || 0) + tokens;
      ws.quota.weeklyUsage = (ws.quota.weeklyUsage || 0) + tokens;
      if (ws.quota.dailyLimit) {
        ws.quota.dailyLeft = Math.max(0, ws.quota.dailyLimit - ws.quota.dailyUsage);
      }
      if (ws.quota.weeklyLimit) {
        ws.quota.weeklyLeft = Math.max(0, ws.quota.weeklyLimit - ws.quota.weeklyUsage);
      }
    }
    if (ws.cooldownUntil && ws.quotaStatus !== 'exhausted') {
      ws.cooldownUntil = 0;
      ws.cooldownReason = null;
      this._emitCircuitClose(ws);
    }
    // Persist debounce 2s trên hot path: writeFileSync từng request chặn event loop.
    // Path lỗi/cooldown vẫn persist tức thì ở reportError.
    this._schedulePersist();
  }

  _schedulePersist(delayMs = 2000) {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        this.persist();
      } catch (err) {
        console.warn('[ClickUpPool] Deferred persist thất bại:', err.message);
      }
    }, delayMs);
    this._persistTimer.unref?.();
  }

  reportError(ws, error, statusCode = null) {
    if (!ws) return;
    ws.errorRequests++;
    ws.consecutiveErrors = (ws.consecutiveErrors || 0) + 1;
    // 2026-10-29 (§6.1): mốc lỗi AI-request gần nhất. Audit quota (GraphQL) KHÔNG
    // được dùng để mở lại workspace nếu request thật vừa thất bại — entitlement
    // 'available' không chứng minh được endpoint /ai còn phục vụ.
    const now = Date.now();
    ws.lastAiRequestErrorAt = now;
    const errMsg = (typeof error === 'string' ? error : error?.message || '').toLowerCase();

    // Chỉ classifier quota khi tín hiệu rõ ràng: HTTP 429, mã USAGE_QUOTA_EXCEEDED,
    // hoặc FairUseBlocked. Không khớp mù mọi error message chứa chữ "quota" —
    // lỗi đó từng kéo workspace vào cách ly tới hết ngày chỉ vì body lỗi nhắc chữ quota.
    const isQuotaExceeded =
      statusCode === 429 ||
      errMsg.includes('usage_quota_exceeded') ||
      errMsg.includes('fairuseblocked');

    if (isQuotaExceeded) {
      // Ưu tiên mốc reset thật từ upstream (quota.dailyResetsAt); heuristic 07:00 UTC chỉ là fallback.
      // Trước đây ghim cứng "14:00" làm over-cool tới 7 tiếng so với reset thật (07:00 VN).
      const quotedReset = Date.parse(ws.quota?.dailyResetsAt || '');
      const resetMs = Number.isFinite(quotedReset) && quotedReset > Date.now() ? quotedReset : getNextDailyResetTime();
      ws.cooldownUntil = resetMs + 60000;
      ws.cooldownReason = `Hết hạn mức AI ngày (Chờ reset lúc ${new Date(resetMs).toLocaleTimeString('vi-VN')})`;
      ws.quotaStatus = 'exhausted';
      if (ws.quota) {
        ws.quota.dailyLeft = 0;
        ws.quota.status = 'exhausted';
        ws.quota.lastCheckedAt = Date.now();
      }
      console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) chạm quota ngày (USAGE_QUOTA_EXCEEDED) — cách ly đến ${new Date(ws.cooldownUntil).toLocaleTimeString('vi-VN')}.`);

      // ── Canary quarantine: "hạn mức ẩn" (§6.1) ──────────────────────────────
      // Triệu chứng: request AI bị chặn vì quota NHƯNG entitlement/audit vẫn báo
      // 'available'. Audit kế tiếp sẽ xóa cooldown và ném workspace chết trở lại
      // vòng xoay → thất bại lặp vô hạn. Đếm số lần tái phát trong 30 phút; từ
      // lần thứ 2 trở đi khóa cứng 24h, chỉ mở bằng canary.
      const entitlementSaysOk = !ws.quota?.isBlocked && (ws.quota?.dailyLeft ?? 0) > 0;
      if (entitlementSaysOk) {
        const windowStart = now - 30 * 60 * 1000;
        ws.hiddenQuotaHits = (Array.isArray(ws.hiddenQuotaHits) ? ws.hiddenQuotaHits : []).filter((t) => t > windowStart);
        ws.hiddenQuotaHits.push(now);
        if (ws.hiddenQuotaHits.length >= 2) {
          ws.stickyBlockedUntil = now + 24 * 3600 * 1000;
          ws.cooldownReason = 'hidden-quota';
          console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) dính HẠN MỨC ẨN ${ws.hiddenQuotaHits.length} lần/30 phút trong khi entitlement vẫn 'available' — khóa cứng 24h, chỉ mở lại qua canary.`);
        }
      }

      this.persist();
      this.replaceExhaustedWorkspace(ws, 'Workspace cạn quota ngày (USAGE_QUOTA_EXCEEDED)').catch(() => {});
      this._checkAndTriggerAutoRecreate({ accountId: ws.accountId, reason: `Workspace cạn quota ngày (USAGE_QUOTA_EXCEEDED)` });
      return;
    }

    const isModelDisabledOrExpired = /ai_model_disabled|premium_models_not_entitled|ai model disabled|not entitled to premium|entitlement expired|plan_not_found/i.test(errMsg);
    if (isModelDisabledOrExpired) {
      ws.cooldownUntil = Date.now() + 24 * 3600 * 1000;
      ws.cooldownReason = `Model bị khóa hoặc hết hạn gói Trial (${errMsg.slice(0, 80)})`;
      ws.quotaStatus = 'exhausted';
      if (ws.quota) {
        ws.quota.isBlocked = true;
        ws.quota.status = 'exhausted';
        ws.quota.lastCheckedAt = Date.now();
      }
      console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) gặp lỗi AI model disabled / not entitled: ${errMsg}`);
      this.persist();

      this.replaceExhaustedWorkspace(ws, `Model bị khóa hoặc hết hạn gói Trial (${errMsg.slice(0, 60)})`).catch(() => {});
      this._checkAndTriggerAutoRecreate({ accountId: ws.accountId, reason: `Phát hiện lỗi Upstream: ${errMsg.slice(0, 60)}` });
      return;
    }

    const isRateLimit = statusCode === 429 || errMsg.includes('rate limit');
    if (isRateLimit) {
      ws.rateLimitStreak = (ws.rateLimitStreak || 0) + 1;
      const cooldownSec = ws.rateLimitStreak >= 3 ? 300 : (ws.rateLimitStreak === 2 ? 120 : 30);
      ws.cooldownUntil = Date.now() + cooldownSec * 1000;
      ws.cooldownReason = `Rate Limit 429 (Streak: ${ws.rateLimitStreak}, Cooldown: ${cooldownSec}s)`;
      console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) bị Rate Limit 429 (streak ${ws.rateLimitStreak}) — cách ly ${cooldownSec}s.`);
      // 2026-10-28 (P3): persist cooldown — trước đây restart mất cách ly.
      this._schedulePersist();
      return;
    }

    const isAuthError = statusCode === 401 || statusCode === 403 || errMsg.includes('unauthorized');
    if (isAuthError) {
      ws.gatewayCache = null;
    }

    // Active Circuit Breaker: Cách ly 3 phút nếu lỗi mạng/server liên tiếp >= 3 lần
    if (ws.consecutiveErrors >= 3 && (!ws.cooldownUntil || ws.cooldownUntil <= Date.now())) {
      ws.cooldownUntil = Date.now() + 180 * 1000;
      ws.cooldownReason = `Circuit Breaker: ${ws.consecutiveErrors} lỗi liên tiếp (${errMsg.slice(0, 60)})`;
      console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) kích hoạt Circuit Breaker (${ws.consecutiveErrors} lỗi liên tiếp) — cách ly 3 phút.`);
      this._emitCircuitOpen(ws);
      // 2026-10-28 (P3): persist cooldown breaker qua restart.
      this._schedulePersist();
    }
  }

  // ── Quan sát circuit breaker (chỉ phát sự kiện, không đổi chính sách pool) ──
  _emitCircuitOpen(ws) {
    if (!ws || ws._circuitOpen) return;
    ws._circuitOpen = true;
    alertEvents.emit(ALERT_EVENTS.CIRCUIT_OPEN, { workspaceId: ws.workspaceId, workspace: ws.label });
  }

  // ── Canary release cho workspace dính "hạn mức ẩn" (§6.1) ──────────────────
  // Mỗi 60 phút thả đúng MỘT request thăm dò (upstream tiêm qua setCanaryProbe).
  // Thành công → gỡ khóa; thất bại → gia hạn 24h. Chạy nền, không chặn acquire()
  // của request đang phục vụ người dùng.
  setCanaryProbe(fn) {
    this._canaryProbe = typeof fn === 'function' ? fn : null;
  }

  _tryCanaryRelease(ws, now = Date.now()) {
    if (!this._canaryProbe || !ws?.enabled) return;
    if (ws._canaryInFlight) return;
    if (ws.lastCanaryAt && now - ws.lastCanaryAt < 60 * 60 * 1000) return;

    ws._canaryInFlight = true;
    ws.lastCanaryAt = now;
    Promise.resolve()
      .then(() => this._canaryProbe(ws))
      .then((ok) => {
        if (ok) {
          ws.stickyBlockedUntil = 0;
          ws.hiddenQuotaHits = [];
          ws.cooldownUntil = 0;
          ws.cooldownReason = null;
          ws.consecutiveErrors = 0;
          ws.quotaStatus = 'available';
          if (ws.quota) ws.quota.status = 'available';
          this._emitCircuitClose(ws);
          console.warn(`[ClickUpPool] Canary THÀNH CÔNG cho "${ws.label}" (${ws.workspaceId}) — gỡ khóa hạn mức ẩn, đưa lại vào pool.`);
        } else {
          ws.stickyBlockedUntil = Date.now() + 24 * 3600 * 1000;
          console.warn(`[ClickUpPool] Canary THẤT BẠI cho "${ws.label}" (${ws.workspaceId}) — giữ khóa thêm 24h.`);
        }
        this.persist();
      })
      .catch((err) => {
        ws.stickyBlockedUntil = Date.now() + 24 * 3600 * 1000;
        console.warn(`[ClickUpPool] Canary lỗi cho "${ws.label}": ${err.message} — giữ khóa thêm 24h.`);
        this.persist();
      })
      .finally(() => {
        ws._canaryInFlight = false;
      });
  }

  // Chỉ phát khi workspace thực sự rời trạng thái cách ly (có mở trước đó).
  _emitCircuitClose(ws) {
    if (!ws || !ws._circuitOpen) return;
    ws._circuitOpen = false;
    alertEvents.emit(ALERT_EVENTS.CIRCUIT_CLOSE, { workspaceId: ws.workspaceId, workspace: ws.label });
  }

  clearCooldown(id) {
    const ws = this.workspaces.find((w) => w.id === id || w.workspaceId === id);
    if (ws) {
      ws.cooldownUntil = 0;
      ws.cooldownReason = null;
      ws.consecutiveErrors = 0;
      ws.rateLimitStreak = 0;
      ws.quotaStatus = 'available';
      if (ws.quota) {
        ws.quota.status = 'available';
      }
      this._emitCircuitClose(ws);
      this.persist();
      return true;
    }
    return false;
  }

  decodeJwt(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      const parts = token.split('.');
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4;
      const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  getTokenExpMs(ws) {
    if (!ws?.token) return null;
    const p = this.decodeJwt(ws.token);
    return p?.exp ? p.exp * 1000 : null;
  }

  async getGatewayToken(ws) {
    if (!ws) throw new Error('Workspace không tồn tại');
    const expMs = this.getTokenExpMs(ws);
    const now = Date.now();

    if (expMs && expMs - now < 5 * 60 * 1000) {
      try {
        console.log(`[ClickUpPool] Session token của "${ws.label}" sắp hết hạn (<5m) — tự động gia hạn...`);
        await this.renewSessionToken(ws);
      } catch (err) {
        console.warn(`[ClickUpPool] Gia hạn tự động thất bại cho "${ws.label}": ${err.message}`);
      }
    }

    return await this._exchangeGatewayToken(ws);
  }

  async _exchangeGatewayToken(ws) {
    const now = Date.now();
    if (ws.gatewayCache && ws.gatewayCache.expiresAt > now + 30000) {
      return ws.gatewayCache;
    }
    // Dedupe in-flight: N request đồng thời khi cache hết hạn chỉ tạo đúng 1 lần GET exchange.
    if (ws._pendingGateway) return ws._pendingGateway;
    ws._pendingGateway = this._doExchangeGatewayToken(ws).finally(() => { ws._pendingGateway = null; });
    return ws._pendingGateway;
  }

  async _doExchangeGatewayToken(ws, isRetry = false) {
    const now = Date.now();
    const teamId = ws.workspaceId || this.defaults.workspaceId || '';
    const url = `${getClickUpApiBase()}/v2/sd/team/${teamId}/access-token`;

    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;

      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ws.token}`,
            Origin: 'https://app.clickup.com',
            Referer: 'https://app.clickup.com/',
            'clickup-surface': 'client',
            'clickup-client-version': '3.83.0',
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', async () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              if (res.statusCode === 401 || res.statusCode === 403) {
                if (body.includes('ACCESS_700') || body.includes('INSUFFICIENT_WORKSPACE_ACCESS') || body.includes('Must join workspace')) {
                  console.warn(`[ClickUpPool] Workspace "${ws.label}" (${ws.workspaceId}) không còn quyền truy cập (ACCESS_700). Tự động vô hiệu hóa.`);
                  ws.enabled = false;
                  ws.cooldownReason = 'ACCESS_700: Workspace không còn quyền truy cập';
                  this.persist();
                  reject(new Error(`Workspace "${ws.label}" không có quyền truy cập (ACCESS_700)`));
                  return;
                }
                if (isRetry) {
                  reject(new Error(`Gateway exchange thất bại sau khi gia hạn session token: HTTP ${res.statusCode} ${body.slice(0, 150)}`));
                  return;
                }
                console.warn(`[ClickUpPool] Gateway exchange trả ${res.statusCode} cho "${ws.label}". Thử renew session token...`);
                try {
                  await this.renewSessionToken(ws);
                  const retried = await this._doExchangeGatewayToken(ws, true);
                  resolve(retried);
                  return;
                } catch (renewErr) {
                  reject(new Error(`Session token hết hạn và renew thất bại: ${renewErr.message}`));
                  return;
                }
              }
              reject(new Error(`Failed to exchange ClickUp gateway token: HTTP ${res.statusCode} ${body.slice(0, 150)}`));
              return;
            }

            try {
              const data = JSON.parse(body);
              const origin = (data.origin || 'https://frontdoor-search.clickup-sg.com').replace(/\/+$/, '');
              const gatewayInfo = {
                token: data.accessToken,
                origin,
                url: `${origin}/graphql/gateway`,
                expiresAt: now + (data.expiresIn || 300) * 1000,
              };
              ws.gatewayCache = gatewayInfo;
              resolve(gatewayInfo);
            } catch (parseErr) {
              reject(new Error(`Invalid JSON from ClickUp gateway exchange: ${parseErr.message}`));
            }
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('Gateway token exchange timeout 15s')));
      req.on('error', reject);
      req.end();
    });
  }

  async _callRefreshEndpoint({ bearerRt = null, cookieHeader = null }) {
    const url = `${getClickUpIdBase()}/auth/v1/refresh`;
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;

      const headers = {
        'content-type': 'application/json',
        'content-length': 0,
        Origin: 'https://app.clickup.com',
        Referer: 'https://app.clickup.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      };
      if (bearerRt) headers.Authorization = `Bearer ${bearerRt}`;
      if (cookieHeader) headers.Cookie = cookieHeader;

      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              reject(new Error(`ClickUp refresh endpoint trả về HTTP ${res.statusCode}: ${body.slice(0, 150)}`));
              return;
            }
            try {
              const data = JSON.parse(body);
              resolve({ data, setCookie: res.headers['set-cookie'] || [] });
            } catch (err) {
              reject(new Error(`Invalid JSON from refresh: ${err.message}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Refresh timeout 15s')));
      req.on('error', reject);
      req.end();
    });
  }

  _applyRefreshedToken(ws, result) {
    if (!result?.token) throw new Error('Phản hồi refresh không chứa token mới');
    ws.token = String(result.token);
    if (result.refresh_token) ws.refreshToken = String(result.refresh_token);
    ws.gatewayCache = null;
    ws.lastRenewAttempt = 0;
    ws.cooldownUntil = 0;
    ws.cooldownReason = null;
    this._emitCircuitClose(ws);
    this.persist();

    const payload = this.decodeJwt(result.token);
    return payload?.exp ? payload.exp * 1000 : null;
  }

  getAccountForWorkspace(ws) {
    if (ws.accountId) {
      const byId = this.accounts.find((a) => a.id === ws.accountId && a.enabled);
      if (byId) return byId;
    }
    const payload = this.decodeJwt(ws.token);
    if (payload?.user) {
      const acc = this.accounts.find((a) => a.userId === payload.user && a.enabled);
      if (acc) {
        ws.accountId = acc.id;
        return acc;
      }
    }
    const active = this.accounts.filter((a) => a.enabled);
    if (active.length === 1) {
      ws.accountId = active[0].id;
      return active[0];
    }
    return null;
  }

  // 2026-10-28 (P2): serialize mint token theo TÀI KHOẢN. Mọi workspace cùng account
  // chia sẻ cookie/cu_refresh; audit 15 phút bắn N mint song song dùng cùng cookie
  // pre-rotation, last-writer-wins làm mất cookie đã rotate → 401 cascade cả account.
  // Mutex chuỗi promise đảm bảo mint sau dùng cookie SAU khi mint trước merge xong.
  _enqueueAccountMint(accountId, task) {
    if (!this._accountMintLocks) this._accountMintLocks = new Map();
    const prev = this._accountMintLocks.get(accountId) || Promise.resolve();
    const run = prev.then(task, task);
    this._accountMintLocks.set(accountId, run.catch(() => {}));
    return run;
  }

  mintWorkspaceTokenFromAccount(workspaceId, account) {
    if (!account) return Promise.reject(new Error('Account không tồn tại'));
    return this._enqueueAccountMint(account.id || 'default', () =>
      this._doMintWorkspaceTokenFromAccount(workspaceId, account)
    );
  }

  async _doMintWorkspaceTokenFromAccount(workspaceId, account) {
    if (!account) throw new Error('Account không tồn tại');
    const cookieHeader = account.cookie || (account.cuRefresh ? `cu_refresh=${account.cuRefresh}` : null);
    if (!cookieHeader) throw new Error(`Account "${account.label || account.id}" chưa có cookie hoặc cu_refresh`);

    const url = `${getClickUpIdBase()}/data/v3/workspaces/${workspaceId}/authentication/access_tokens`;

    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;

      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': 0,
            Origin: 'https://app.clickup.com',
            Referer: 'https://app.clickup.com/',
            Cookie: cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
            ...(account.cuRefresh ? { Authorization: `Bearer ${account.cuRefresh}` } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              reject(new Error(`id.app.clickup.com từ chối: HTTP ${res.statusCode} ${body.slice(0, 120)}`));
              return;
            }
            try {
              const data = JSON.parse(body);
              const setCookie = res.headers['set-cookie'] || [];
              if (setCookie.length) {
                this._mergeAccountCookies(account, setCookie);
              }
              account.lastRenewed = new Date().toISOString();
              resolve({
                token: data.token,
                expiration: data.expiration,
                attachmentToken: data.attachment_token,
              });
            } catch (e) {
              reject(new Error(`Invalid JSON từ id.app.clickup.com: ${e.message}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Timeout 15s kết nối id.app.clickup.com')));
      req.end();
    });
  }

  _mergeAccountCookies(account, setCookieHeaders) {
    if (!account || !Array.isArray(setCookieHeaders) || !setCookieHeaders.length) return;
    const cookieMap = {};
    if (account.cookie) {
      for (const pair of account.cookie.split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
    for (const sc of setCookieHeaders) {
      const first = sc.split(';')[0];
      const idx = first.indexOf('=');
      if (idx > 0) {
        const name = first.slice(0, idx).trim();
        const val = first.slice(idx + 1).trim();
        cookieMap[name] = val;
        if (name === 'cu_refresh') {
          account.cuRefresh = val;
        }
      }
    }
    account.cookie = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async renewSessionToken(ws) {
    if (!ws) throw new Error('Workspace không tồn tại');

    if (ws.lastRenewAttempt && Date.now() - ws.lastRenewAttempt < 60000) {
      throw new Error('Vừa thử gia hạn gần đây (<60s), thử lại sau');
    }
    ws.lastRenewAttempt = Date.now();

    const account = this.getAccountForWorkspace(ws);
    let lastErr = null;
    if (account && (account.cookie || account.cuRefresh)) {
      try {
        console.log(`[ClickUpPool] 🔄 Đang gia hạn session token cho "${ws.label}" (${ws.workspaceId}) qua Account "${account.label || account.id}"...`);
        const result = await this.mintWorkspaceTokenFromAccount(ws.workspaceId, account);
        if (!result.token) throw new Error('id.app.clickup.com không trả về token');
        const payload = this.decodeJwt(result.token);
        const newExpMs = payload?.exp ? payload.exp * 1000 : (result.expiration ? result.expiration * 1000 : null);
        ws.token = String(result.token);
        ws.gatewayCache = null;
        ws.lastRenewAttempt = 0;
        ws.cooldownUntil = 0;
        ws.cooldownReason = null;
        // 2026-10-28 (P3): renewal thành công phải mở khóa quotaStatus — nếu để
        // 'exhausted' với cooldownUntil=0 thì sweep trong acquire không bao giờ
        // chạy và workspace bị loại tới tận lần audit kế tiếp (≤15 phút).
        if (ws.quotaStatus === 'exhausted') ws.quotaStatus = 'available';
        this._emitCircuitClose(ws);
        this.persist();

        return {
          label: ws.label,
          workspaceId: ws.workspaceId,
          expiresAt: newExpMs,
          account: account.label || account.id,
          method: 'id.app.clickup.com',
        };
      } catch (err) {
        lastErr = err;
        console.warn(`[ClickUpPool] ⚠️ Gia hạn qua Account thất bại cho "${ws.label}": ${err.message}. Thử phương thức fallback...`);
      }
    }

    if (!ws.refreshToken && !ws.refreshCookie) {
      if (lastErr) throw lastErr;
      throw new Error('Workspace này chưa có Tài khoản liên kết hoặc Refresh Token');
    }

    let result = null;
    if (ws.refreshToken) {
      try {
        result = (await this._callRefreshEndpoint({ bearerRt: ws.refreshToken })).data;
      } catch (err) {
        lastErr = err;
        if (!/HTTP\s+401\b/.test(err.message || '') || !ws.refreshCookie) throw err;
        console.warn(`[ClickUpPool] 🔄 Header-mode refresh bị 401 cho "${ws.label}" — thử cookie mode...`);
      }
    }
    if (!result && ws.refreshCookie) {
      const { data, setCookie } = await this._callRefreshEndpoint({ cookieHeader: ws.refreshCookie });
      result = data;
      if (setCookie && setCookie.length) {
        const map = {};
        for (const pair of ws.refreshCookie.split(';')) {
          const idx = pair.indexOf('=');
          if (idx > 0) map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        }
        for (const sc of setCookie) {
          const first = sc.split(';')[0];
          const idx = first.indexOf('=');
          if (idx > 0) map[first.slice(0, idx).trim()] = first.slice(idx + 1).trim();
        }
        ws.refreshCookie = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
        this.persist();
      }
    }

    const newExpMs = this._applyRefreshedToken(ws, result);
    return {
      label: ws.label,
      workspaceId: ws.workspaceId,
      expiresAt: newExpMs,
      rotatedRefreshToken: Boolean(result.refresh_token),
    };
  }

  async renewAccount(accId) {
    const acc = this.accounts.find((a) => a.id === accId);
    if (!acc) throw new Error('Account không tồn tại');
    const linkedWorkspaces = this.workspaces.filter((ws) => {
      const wsAcc = this.getAccountForWorkspace(ws);
      return wsAcc && wsAcc.id === acc.id;
    });

    const results = [];
    for (const ws of linkedWorkspaces) {
      try {
        const r = await this.renewSessionToken(ws);
        results.push({ workspaceId: ws.workspaceId, ok: true, expiresAt: r.expiresAt });
      } catch (err) {
        results.push({ workspaceId: ws.workspaceId, ok: false, error: err.message });
      }
    }
    this.persist();
    return { account: acc.label || acc.email, results };
  }

  async renewAllIfNeeded({ minHoursLeft = 6 } = {}) {
    const now = Date.now();
    const thresholdMs = minHoursLeft * 3600 * 1000;
    const results = [];

    for (const ws of this.workspaces) {
      if (!ws.enabled || !ws.token) continue;
      const expMs = this.getTokenExpMs(ws);
      if (!expMs) continue;
      const timeLeft = expMs - now;
      if (timeLeft > 0 && timeLeft < thresholdMs) {
        console.log(`[ClickUpPool] Session token của "${ws.label}" còn ${Math.round(timeLeft / 3600000)}h (<${minHoursLeft}h) — tự động làm mới...`);
        try {
          const r = await this.renewSessionToken(ws);
          results.push({ label: ws.label, status: 'renewed', expiresAt: r.expiresAt });
        } catch (err) {
          results.push({ label: ws.label, status: 'error', error: err.message });
        }
      }
    }
    return results;
  }

  parseCurlOrToken(raw) {
    if (!raw || typeof raw !== 'string') return null;
    raw = raw.trim();
    let token = null;
    let refreshToken = null;
    let cookies = null;
    let workspaceId = null;

    const cookieRegexes = [
      /(?:-H|--header)\s+['"][Cc]ookie:\s*([^'"]+)['"]/i,
      /(?:-b|--cookie)\s+['"]([^'"]+)['"]/i,
      /[Cc]ookie:\s*([^\r\n"']+)/i,
    ];
    for (const re of cookieRegexes) {
      const m = raw.match(re);
      if (m && m[1]) {
        cookies = m[1].replace(/['"]\s*(--compressed|\\|\$|--.*)?$/i, '').replace(/['"]+$/, '').trim();
        break;
      }
    }
    if (!cookies && (raw.includes('cu_refresh=') || raw.includes('cu_public='))) {
      cookies = raw.replace(/^.*?((?:cu_refresh|cu_public)=.+?)(?:['"]\s*--.*)?$/s, '$1').trim();
    }

    if (cookies) {
      const rfMatch = cookies.match(/(?:cu_refresh|refresh_token)=([^;\s"']+)/);
      if (rfMatch) refreshToken = rfMatch[1].trim();
    }

    if (!refreshToken) {
      const bodyRfMatch =
        raw.match(/(?:"refreshToken"|"refresh_token"|"cu_refresh")\s*:\s*"([^"]+)"/i) ||
        raw.match(/(?:refreshToken|refresh_token|cu_refresh)=([^&'"\s\r\n]+)/i);
      if (bodyRfMatch) refreshToken = bodyRfMatch[1].trim();
    }
    if (!refreshToken) {
      const hRfMatch = raw.match(/(?:x-refresh-token|refresh-token):\s*([^\r\n"']+)/i);
      if (hRfMatch) refreshToken = hRfMatch[1].trim();
    }
    if (!refreshToken) {
      const rtMatch = raw.match(/\b(rt-[A-Za-z0-9_.-]+)\b/);
      if (rtMatch) refreshToken = rtMatch[1].trim();
    }

    const allJwts = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    for (const jwt of allJwts) {
      const p = this.decodeJwt(jwt);
      if (!p) continue;
      if (p.refresh && !refreshToken) {
        refreshToken = jwt;
      } else if ((p.workspace_id || p.session_token || !token) && !p.refresh) {
        if (!token) token = jwt;
        if (p.workspace_id && !workspaceId) workspaceId = String(p.workspace_id);
      }
    }

    if (!token) {
      const bearerMatch = raw.match(/Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
      if (bearerMatch) {
        token = bearerMatch[1];
        const p = this.decodeJwt(token);
        if (p?.workspace_id && !workspaceId) workspaceId = String(p.workspace_id);
      }
    }

    if (!token && !cookies && !refreshToken) return null;

    if (!workspaceId) {
      const wsMatch =
        raw.match(/(?:workspaceId|workspace_id|team_id|teamId|team)[=:\s/]+["']?(\d{10,25})/i) ||
        raw.match(/\/team\/(\d{10,25})/i);
      if (wsMatch) workspaceId = wsMatch[1];
    }

    return { token, refreshToken, cookies, workspaceId };
  }

  async addWorkspace(data) {
    let { workspaceId, token, refreshToken, refreshCookie, label, limit, rawCurl } = data || {};
    let cookies = refreshCookie || null;

    if (rawCurl) {
      const parsed = this.parseCurlOrToken(rawCurl);
      if (parsed) {
        if (parsed.token) token = parsed.token;
        if (parsed.refreshToken) refreshToken = parsed.refreshToken;
        if (parsed.cookies) cookies = parsed.cookies;
        if (parsed.workspaceId && !workspaceId) workspaceId = parsed.workspaceId;
      }
    }

    if (!token && cookies) {
      throw new Error('Chưa tìm thấy Session Token trong nội dung paste');
    }

    if (!workspaceId) {
      const payload = this.decodeJwt(token);
      if (payload?.workspace_id) workspaceId = String(payload.workspace_id);
    }
    if (!workspaceId) {
      throw new Error('Không thể xác định Workspace ID từ Token. Vui lòng nhập Workspace ID.');
    }

    workspaceId = String(workspaceId).trim();
    const existing = this.workspaces.find((w) => w.workspaceId === workspaceId);
    const qLimit = Number(limit ?? this.maxConcurrentPerWorkspace ?? 3);

    if (existing) {
      existing.token = String(token);
      if (refreshToken) existing.refreshToken = String(refreshToken);
      if (cookies) existing.refreshCookie = String(cookies);
      if (label) existing.label = String(label);
      existing.limit = qLimit;
      existing.queue = new UpstreamQueue(qLimit);
      existing.enabled = true;
      existing.cooldownUntil = 0;
      existing.cooldownReason = null;
      existing.gatewayCache = null;
      this._emitCircuitClose(existing);
      this.persist();
      return { workspace: existing, action: 'updated' };
    }

    const newWs = {
      id: `ws-${workspaceId}`,
      label: label || `Workspace (${workspaceId.slice(-4)})`,
      workspaceId,
      accountId: null,
      token: String(token),
      refreshToken: refreshToken ? String(refreshToken) : '',
      refreshCookie: cookies ? String(cookies) : '',
      enabled: true,
      limit: qLimit,
      queue: new UpstreamQueue(qLimit),
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      cooldownUntil: 0,
      cooldownReason: null,
      quotaStatus: 'available',
      quota: null,
      gatewayCache: null,
      lastRenewAttempt: 0,
      lastDispatchedAt: 0,
    };

    this.getAccountForWorkspace(newWs);
    this.workspaces.push(newWs);
    this.persist();
    return { workspace: newWs, action: 'created' };
  }

  removeWorkspace(id) {
    const idx = this.workspaces.findIndex((w) => w.id === id || w.workspaceId === id);
    if (idx !== -1) {
      const removed = this.workspaces.splice(idx, 1)[0];
      this.persist();
      return removed;
    }
    return null;
  }

  toggleWorkspace(id, enabled) {
    const ws = this.workspaces.find((w) => w.id === id || w.workspaceId === id);
    if (ws) {
      ws.enabled = typeof enabled === 'boolean' ? enabled : !ws.enabled;
      this.persist();
      return ws;
    }
    return null;
  }

  parseAccountFromCurlOrCookie(raw) {
    if (!raw || typeof raw !== 'string') return null;
    raw = raw.trim();
    let cookie = null;
    let cuRefresh = null;
    let email = null;
    let userId = null;
    let workspaceId = null;
    let initialToken = null;

    const cookieRegexes = [
      /(?:-H|--header)\s+['"][Cc]ookie:\s*([^'"]+)['"]/i,
      /(?:-b|--cookie)\s+['"]([^'"]+)['"]/i,
      /[Cc]ookie:\s*([^\r\n"']+)/i,
    ];
    for (const re of cookieRegexes) {
      const m = raw.match(re);
      if (m && m[1]) {
        cookie = m[1].replace(/['"]\s*(--compressed|\\|\$|--.*)?$/i, '').replace(/['"]+$/, '').trim();
        break;
      }
    }
    if (!cookie && (raw.includes('cu_refresh=') || raw.includes('cu_public='))) {
      cookie = raw.replace(/^.*?((?:cu_refresh|cu_public)=.+?)(?:['"]\s*--.*)?$/s, '$1').trim();
    }

    if (cookie) {
      const m = cookie.match(/cu_refresh=([^;\s"']+)/);
      if (m) cuRefresh = m[1].trim();
    }

    if (!cuRefresh) {
      const bodyMatch = raw.match(/(?:"cu_refresh"|"cuRefresh"|"refreshToken")\s*:\s*"([^"]+)"/i);
      if (bodyMatch) cuRefresh = bodyMatch[1].trim();
    }

    if (!cuRefresh && raw.startsWith('eyJ') && !raw.includes(' ') && raw.length > 30) {
      cuRefresh = raw.trim();
    }

    // Trích xuất Authorization Bearer token nếu có trong chuỗi cURL
    const authMatch = raw.match(/(?:-H|--header)\s+['"]Authorization:\s*Bearer\s+([^'"]+)['"]/i)
      || raw.match(/Authorization:\s*Bearer\s+([^\r\n"']+)/i);
    if (authMatch && authMatch[1]) {
      initialToken = authMatch[1].trim();
    }

    // Trích xuất workspaceId từ header x-workspace-id hoặc URL nếu có
    const wsHeaderMatch = raw.match(/(?:x-workspace-id|x-team-id):\s*([0-9]+)/i)
      || raw.match(/['"](?:x-workspace-id|x-team-id)['"]:\s*['"]?([0-9]+)['"]?/i)
      || raw.match(/(?:\/team\/|\/workspaces\/)([0-9]+)/i);
    if (wsHeaderMatch && wsHeaderMatch[1]) {
      workspaceId = wsHeaderMatch[1].trim();
    }

    if (cookie) {
      const publicMatch = cookie.match(/cu_public=([^;\s"']+)/);
      if (publicMatch) {
        const payload = this.decodeJwt(publicMatch[1]);
        if (payload?.email) email = payload.email;
        if (payload?.userId) userId = Number(payload.userId);
        if (!workspaceId) {
          if (payload?.default_team) workspaceId = String(payload.default_team);
          else if (Array.isArray(payload?.teams) && payload.teams[0]) workspaceId = String(payload.teams[0]);
          else if (payload?.workspace_id) workspaceId = String(payload.workspace_id);
        }
      }
    }

    if (cuRefresh) {
      const rPayload = this.decodeJwt(cuRefresh);
      if (rPayload?.user && !userId) userId = Number(rPayload.user);
      if (!workspaceId && rPayload?.workspace_id) workspaceId = String(rPayload.workspace_id);
    }

    // Quét thêm JWT token nếu chưa có initialToken
    if (!initialToken) {
      const allJwts = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
      for (const jwt of allJwts) {
        const p = this.decodeJwt(jwt);
        if (p && !p.refresh && (p.workspace_id || p.session_token || p.user)) {
          initialToken = jwt;
          if (!workspaceId && p.workspace_id) workspaceId = String(p.workspace_id);
          break;
        }
      }
    }

    return { cookie, cuRefresh, email, userId, workspaceId, initialToken };
  }

  /**
   * Kiểm tra tính hợp lệ của Cookie / cu_refresh trực tiếp với máy chủ ClickUp.
   * Thử nghiệm mint token và lấy profile người dùng từ ClickUp API.
   */
  async verifyAccount(accountOrData) {
    if (!accountOrData) throw new Error('Dữ liệu tài khoản không hợp lệ');
    let target = { ...accountOrData };
    if (target.rawCurl) {
      const parsed = this.parseAccountFromCurlOrCookie(target.rawCurl);
      if (parsed) Object.assign(target, parsed);
    } else if (target.cookie && !target.cuRefresh) {
      const parsed = this.parseAccountFromCurlOrCookie(target.cookie);
      if (parsed) Object.assign(target, parsed);
    }

    const cuRefresh = target.cuRefresh || (target.cookie ? (target.cookie.match(/cu_refresh=([^;\s"']+)/)?.[1]) : null);
    if (!cuRefresh && !target.cookie) {
      throw new Error('Chưa cung cấp Cookie hoặc cu_refresh để kiểm tra.');
    }

    // Bỏ qua gọi mạng nếu là mock token trong môi trường test
    if (cuRefresh && cuRefresh.startsWith('mock_')) {
      return {
        valid: true,
        email: target.email || 'mock@example.com',
        userId: target.userId || 9999,
        teamsCount: 1,
        baseTeamId: '1000',
        baseTeamName: 'Mock Base Team',
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 86400,
        note: 'Mock token test verified'
      };
    }

    const testWsId = target.workspaceId || this.defaults.workspaceId || '0';
    let minted = null;
    try {
      minted = await this.mintWorkspaceTokenFromAccount(testWsId, target);
    } catch (mintErr) {
      const msg = mintErr.message || '';
      throw new Error(`ClickUp từ chối Cookie / cu_refresh: ${msg}`);
    }

    if (!minted?.token) {
      throw new Error('ClickUp không trả về Session Token hợp lệ khi kiểm tra Cookie.');
    }

    const base = process.env.CLICKUP_API_BASE || 'https://frontdoor-prod-ap-southeast-1-1.clickup.com';
    let uRes = null;
    try {
      uRes = await fetch(`${base}/user/v1/user?include_teams=true`, {
        headers: {
          Authorization: `Bearer ${minted.token}`,
          'clickup-surface': 'client',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
        },
      });
    } catch (netErr) {
      throw new Error(`Không thể kết nối đến ClickUp API để kiểm tra: ${netErr.message}`);
    }

    if (!uRes.ok) {
      const errBody = await uRes.text().catch(() => '');
      throw new Error(`ClickUp trả về lỗi HTTP ${uRes.status} khi kiểm tra người dùng: ${errBody.slice(0, 120)}`);
    }

    const uData = await uRes.json();
    const verifiedUser = uData.user || {};
    const teams = Array.isArray(uData.teams) ? uData.teams : [];
    const baseTeam = teams[0] || null;

    return {
      valid: true,
      email: verifiedUser.email || target.email || '',
      userId: verifiedUser.id ? Number(verifiedUser.id) : target.userId,
      teamsCount: teams.length,
      baseTeamId: baseTeam ? String(baseTeam.id) : null,
      baseTeamName: baseTeam ? baseTeam.name : null,
      tokenExpiresAt: minted.expiration || null,
      mintedToken: minted.token,
    };
  }

  async addAccount(data) {
    let { email, userId, cookie, cuRefresh, label, rawCurl, workspaceId, initialToken, verify, skipVerify } = data || {};

    if (rawCurl) {
      const parsed = this.parseAccountFromCurlOrCookie(rawCurl);
      if (parsed) {
        if (parsed.cookie) cookie = parsed.cookie;
        if (parsed.cuRefresh) cuRefresh = parsed.cuRefresh;
        if (parsed.email && !email) email = parsed.email;
        if (parsed.userId && !userId) userId = parsed.userId;
        if (parsed.workspaceId && !workspaceId) workspaceId = parsed.workspaceId;
        if (parsed.initialToken && !initialToken) initialToken = parsed.initialToken;
      }
    }

    if (!rawCurl && cookie) {
      const fromCookie = this.parseAccountFromCurlOrCookie(cookie);
      if (fromCookie) {
        if (!cuRefresh && fromCookie.cuRefresh) cuRefresh = fromCookie.cuRefresh;
        if (!email && fromCookie.email) email = fromCookie.email;
        if (!userId && fromCookie.userId) userId = fromCookie.userId;
        if (!workspaceId && fromCookie.workspaceId) workspaceId = fromCookie.workspaceId;
      }
    }

    if (!cookie && !cuRefresh) {
      throw new Error('Cần cung cấp Cookie (chứa cu_refresh) hoặc chuỗi cURL của tài khoản');
    }

    // CHẠY KIỂM TRA TRỰC TIẾP VỚI CLICKUP TRƯỚC KHI LƯU
    let verified = null;
    const shouldVerify = verify === true && !skipVerify;
    if (shouldVerify) {
      verified = await this.verifyAccount({ cookie, cuRefresh, email, userId, workspaceId });
      if (verified) {
        if (!email && verified.email) email = verified.email;
        if (!userId && verified.userId) userId = verified.userId;
        if (!workspaceId && verified.baseTeamId) workspaceId = verified.baseTeamId;
        if (verified.mintedToken && !initialToken) initialToken = verified.mintedToken;
      }
    }

    const id = userId ? `acc-${userId}` : `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.accounts.find(
      (a) => (userId && a.userId === userId) || (email && a.email === email) || (cuRefresh && a.cuRefresh === cuRefresh) || a.id === id
    );

    if (existing) {
      if (cookie) existing.cookie = cookie;
      if (cuRefresh) existing.cuRefresh = cuRefresh;
      if (email) existing.email = email;
      if (label) existing.label = label;
      if (workspaceId) existing.workspaceId = workspaceId;
      if (initialToken) existing.initialToken = initialToken;
      existing.enabled = true;
      existing.lastRenewed = new Date().toISOString();
      this.persist();
      return { account: existing, action: 'updated', verified };
    }

    const newAcc = {
      id,
      label: label || (email ? `Tài khoản (${email})` : `Tài khoản ClickUp #${userId || this.accounts.length + 1}`),
      email: email || '',
      userId: userId ? Number(userId) : null,
      workspaceId: workspaceId || null,
      initialToken: initialToken || null,
      cookie: cookie || '',
      cuRefresh: cuRefresh || '',
      lastRenewed: new Date().toISOString(),
      enabled: true,
    };

    this.accounts.push(newAcc);

    for (const ws of this.workspaces) {
      if (!ws.accountId) {
        const payload = this.decodeJwt(ws.token);
        if (payload?.user && userId && payload.user === userId) {
          ws.accountId = newAcc.id;
        }
      }
    }

    this.persist();
    return { account: newAcc, action: 'created', verified };
  }

  removeAccount(id) {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx !== -1) {
      const removed = this.accounts.splice(idx, 1)[0];
      for (const ws of this.workspaces) {
        if (ws.accountId === id) ws.accountId = null;
      }
      this.persist();
      return removed;
    }
    return null;
  }

  toggleAccount(id, enabled) {
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) {
      acc.enabled = typeof enabled === 'boolean' ? enabled : !acc.enabled;
      this.persist();
      return acc;
    }
    return null;
  }

  persist() {
    this._isPersisting = true;
    if (typeof this.onPersist === 'function') {
      try {
        this.onPersist({
          workspaces: this.workspaces.map((w) => ({
            id: w.id,
            label: w.label,
            workspaceId: w.workspaceId,
            accountId: w.accountId,
            token: w.token,
            refreshToken: w.refreshToken,
            refreshCookie: w.refreshCookie,
            enabled: w.enabled,
            limit: w.limit,
            quotaStatus: w.quotaStatus,
            quota: w.quota,
            cooldownUntil: w.cooldownUntil,
            cooldownReason: w.cooldownReason,
            hiddenQuotaHits: Array.isArray(w.hiddenQuotaHits) ? w.hiddenQuotaHits : [],
            stickyBlockedUntil: Number(w.stickyBlockedUntil || 0),
            lastAiRequestErrorAt: Number(w.lastAiRequestErrorAt || 0),
            lastCanaryAt: Number(w.lastCanaryAt || 0),
            totalRequests: Number(w.totalRequests || 0),
            successRequests: Number(w.successRequests || 0),
            errorRequests: Number(w.errorRequests || 0),
          })),
          accounts: this.accounts.map((a) => ({
            id: a.id,
            label: a.label,
            email: a.email,
            userId: a.userId,
            workspaceId: a.workspaceId || null,
            initialToken: a.initialToken || null,
            cookie: a.cookie,
            cuRefresh: a.cuRefresh,
            lastRenewed: a.lastRenewed,
            enabled: a.enabled,
          })),
        });
        if (STATE_FILE && fs.existsSync(STATE_FILE)) {
          try { this._lastConfigMtime = fs.statSync(STATE_FILE).mtimeMs; } catch {}
        }
      } catch (err) {
        console.error('[ClickUpPool] Lỗi lưu trạng thái:', err.message);
      } finally {
        setTimeout(() => { this._isPersisting = false; }, 1200).unref?.();
      }
    } else {
      this._isPersisting = false;
    }
  }

  async fetchWorkspaceQuota(ws) {
    if (!ws || !ws.enabled || !ws.token) return null;
    try {
      const exchanged = await this.getGatewayToken(ws);
      const targetUrl = exchanged.url || 'https://frontdoor-search.clickup-sg.com/graphql/gateway';

      const query = `
        query GetAIEntitlements {
          workspace {
            id
            name
          }
          checkFairUseBlocked(feature: "ai_request") {
            blocked
            message
            resetsAt
          }
          daily: aiEntitlement(name: "ai_fair_use_daily_limit") {
            type
            entitled
            limit
            usage
            usageLeft
            resetsAt
          }
          weekly: aiEntitlement(name: "ai_fair_use_weekly_limit") {
            type
            entitled
            limit
            usage
            usageLeft
            resetsAt
          }
        }
      `;

      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + exchanged.token,
          'Origin': 'https://app.clickup.com',
          'Referer': 'https://app.clickup.com/',
          'clickup-surface': 'client',
          'clickup-client-version': '3.83.0',
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await resp.json();
      const d = data?.data;
      if (d) {
        const isBlocked = Boolean(d.checkFairUseBlocked?.blocked);
        const dailyLimit = Number(d.daily?.limit || 450000);
        const dailyUsage = Number(d.daily?.usage || 0);
        const dailyLeft = Number(d.daily?.usageLeft ?? Math.max(0, dailyLimit - dailyUsage));
        const weeklyLimit = Number(d.weekly?.limit || 1125000);
        const weeklyUsage = Number(d.weekly?.usage || 0);
        const weeklyLeft = Number(d.weekly?.usageLeft ?? Math.max(0, weeklyLimit - weeklyUsage));

        if (d.workspace?.name && (!ws.label || ws.label.startsWith('Workspace ('))) {
          ws.label = `${d.workspace.name} (${ws.workspaceId.slice(-4)})`;
        }

        const isExhausted = isBlocked || (dailyLeft <= 0 && dailyUsage > 0);
        const quotaObj = {
          dailyLimit,
          dailyUsage,
          dailyLeft: isExhausted ? 0 : dailyLeft,
          dailyResetsAt: d.daily?.resetsAt || null,
          weeklyLimit,
          weeklyUsage,
          weeklyLeft: isExhausted && weeklyLeft === 0 ? 0 : weeklyLeft,
          weeklyResetsAt: d.weekly?.resetsAt || null,
          isBlocked,
          lastCheckedAt: Date.now(),
          status: isExhausted ? 'exhausted' : 'available',
        };

        ws.quota = quotaObj;
        if (isExhausted) {
          ws.quotaStatus = 'exhausted';
          if (!ws.cooldownUntil || ws.cooldownUntil <= Date.now()) {
            const quotedReset = Date.parse(quotaObj.dailyResetsAt || '');
            ws.cooldownUntil = Number.isFinite(quotedReset) && quotedReset > Date.now() ? quotedReset + 60000 : getNextDailyResetTime();
            ws.cooldownReason = 'Fair use daily limit exceeded';
          }
        } else {
          ws.quotaStatus = 'available';
          // 2026-10-28 (P2): audit quota thành công chỉ được xóa cooldown VÌ QUOTA.
          // Cooldown phi-quota (Model bị khóa 24h, Rate Limit, Circuit Breaker) do
          // reportError đặt — audit không có thông tin mới về chúng, xóa sẽ trả
          // workspace hỏng về vòng xoay mỗi 15 phút để lại 403 / đốt failover.
          const isQuotaCooldown = !ws.cooldownReason || /quota|hết hạn mức|fair use/i.test(ws.cooldownReason);
          // 2026-10-29 (§6.1) HẠN MỨC ẨN: entitlement 'available' KHÔNG chứng minh
          // endpoint /ai còn phục vụ. Hai chốt chặn bổ sung:
          //  1. stickyBlockedUntil còn hiệu lực → chỉ canary mới được gỡ.
          //  2. request AI thật vừa lỗi trong 5 phút qua → audit lạc hậu hơn thực tế.
          const stickyActive = ws.stickyBlockedUntil && ws.stickyBlockedUntil > Date.now();
          const recentAiFailure = ws.lastAiRequestErrorAt && (Date.now() - ws.lastAiRequestErrorAt) < 5 * 60 * 1000;
          if (stickyActive || recentAiFailure) {
            ws.quotaStatus = stickyActive ? 'exhausted' : ws.quotaStatus;
          } else if (isQuotaCooldown) {
            ws.cooldownUntil = 0;
            ws.cooldownReason = null;
            this._emitCircuitClose(ws);
          }
        }
        return quotaObj;
      }
    } catch (err) {
      console.warn(`[ClickUpPool] Lỗi kiểm tra quota "${ws.label}":`, err.message);
    }
    return ws.quota || null;
  }

  _createWorkspaceEntry(data) {
    const qLimit = Number(data.limit ?? this.maxConcurrentPerWorkspace ?? 3);
    return {
      id: data.id || `ws-${data.workspaceId}`,
      label: data.label || `Workspace (${String(data.workspaceId).slice(-4)})`,
      workspaceId: String(data.workspaceId || ''),
      accountId: data.accountId || null,
      token: String(data.token || ''),
      refreshToken: data.refreshToken || '',
      refreshCookie: data.refreshCookie || '',
      enabled: data.enabled !== false,
      limit: qLimit,
      queue: new UpstreamQueue(qLimit),
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      cooldownUntil: Number(data.cooldownUntil || 0),
      cooldownReason: data.cooldownReason || null,
      quotaStatus: data.quotaStatus || 'available',
      quota: data.quota || null,
      gatewayCache: null,
      lastRenewAttempt: 0,
      lastDispatchedAt: 0,
      // 2026-10-29 (§6.1): trạng thái cách ly "hạn mức ẩn" phải tồn tại ngay từ
      // lúc tạo entry, nếu không workspace thêm lúc runtime sẽ undefined và mọi
      // chốt chặn stickyBlockedUntil bị bỏ qua im lặng.
      hiddenQuotaHits: Array.isArray(data.hiddenQuotaHits) ? data.hiddenQuotaHits.map(Number).filter(Number.isFinite) : [],
      stickyBlockedUntil: Number(data.stickyBlockedUntil || 0),
      lastAiRequestErrorAt: Number(data.lastAiRequestErrorAt || 0),
      lastCanaryAt: Number(data.lastCanaryAt || 0),
    };
  }

  _checkAndTriggerAutoRecreate({ accountId = null, reason = 'auto-trigger' } = {}) {
    if (this._isRecreating) return;
    const now = Date.now();
    if (this._lastAutoRecreateAt && (now - this._lastAutoRecreateAt < 10 * 60 * 1000)) {
      return;
    }

    const targetWs = this.workspaces.filter((w) => w.enabled && (!accountId || w.accountId === accountId));
    const FRESH_MS = 30 * 60 * 1000;
    const allExhausted = targetWs.length > 0 && targetWs.every((w) => {
      const q = w.quota || {};
      // SAFETY 2026-10-28 (P1-6): dữ liệu quota phải MỚI (<30 phút). Dữ liệu stale
      // (audit lỗi / chưa audit) không đủ căn cứ để xóa workspace thật.
      const fresh = (q.lastCheckedAt || 0) > Date.now() - FRESH_MS;
      return fresh && (q.isBlocked || w.quotaStatus === 'exhausted' || (w.cooldownUntil && w.cooldownUntil > now));
    });

    if (allExhausted) {
      this._lastAutoRecreateAt = now;
      console.warn(`[ClickUpPool] 🚨 TOÀN BỘ WORKSPACE BỊ KHÓA / HẾT HẠN TRIAL (${reason}). Tự động kích hoạt quy trình xóa và tạo lại 10 Workspaces mới...`);
      this.autoRecreateWorkspaces({ accountId, countPerAccount: 10, reason }).catch((err) => {
        console.error(`[ClickUpPool] Lỗi tự động tạo lại Workspaces: ${err.message}`);
      });
    }
  }

  async replaceExhaustedWorkspace(ws, reason = 'quota_exhausted') {
    if (!ws || !ws.workspaceId) return;
    if (!this._replacingWsSet) this._replacingWsSet = new Set();
    const wsKey = String(ws.workspaceId);
    if (this._replacingWsSet.has(wsKey)) return;
    this._replacingWsSet.add(wsKey);

    try {
      const account = this.getAccountForWorkspace(ws);
      if (!account || account.enabled === false) {
        console.warn(`[ClickUp Auto-Replace] Không tìm thấy account cho workspace "${ws.label}" (${wsKey})`);
        return;
      }

      console.warn(`[ClickUp Auto-Replace] 🔄 Bắt đầu dọn dẹp và thay mới Workspace cạn quota: "${ws.label}" (${wsKey}) - Lý do: ${reason}`);

      // 1. Khóa và cách ly workspace ngay lập tức trong pool
      ws.isBlocked = true;
      ws.quotaStatus = 'exhausted';
      if (!ws.quota) ws.quota = {};
      ws.quota.isBlocked = true;
      ws.quota.lastCheckedAt = Date.now();
      ws.cooldownUntil = Date.now() + 24 * 3600 * 1000;
      this.persist();

      // 2. Lấy initialToken của account
      let initialToken = account.initialToken || null;
      if (!initialToken) {
        const otherWs = this.workspaces.find((w) => w.accountId === account.id && w.token && String(w.workspaceId) !== wsKey);
        if (otherWs) initialToken = otherWs.token;
      }
      const knownWsId = account.workspaceId || account.defaultWorkspaceId;
      if (!initialToken && knownWsId) {
        try {
          const m = await this.mintWorkspaceTokenFromAccount(knownWsId, account);
          if (m?.token) initialToken = m.token;
        } catch {}
      }

      const base = process.env.CLICKUP_API_BASE || 'https://frontdoor-prod-ap-southeast-1-1.clickup.com';

      // 3. Xóa workspace cũ trên ClickUp TRƯỚC để giải phóng slot (ClickUp giới hạn 10 team / account)
      try {
        const delRes = await fetch(`${base}/team/v1/team/${wsKey}`, {
          method: 'DELETE',
          headers: {
            Authorization: 'Bearer ' + (initialToken || ws.token),
            'clickup-surface': 'client',
            'x-csrf': '1',
            'x-workspace-id': wsKey,
          },
        });
        if (delRes.ok || delRes.status === 404 || delRes.status === 410) {
          console.log(`[ClickUp Auto-Replace] 🗑️ Đã xóa thành công workspace cũ ${wsKey} trên ClickUp (${delRes.status}).`);
        } else {
          console.warn(`[ClickUp Auto-Replace] ⚠️ Xóa workspace ${wsKey} phản hồi status ${delRes.status}`);
        }
      } catch (delErr) {
        console.warn(`[ClickUp Auto-Replace] Lỗi khi xóa workspace ${wsKey}: ${delErr.message}`);
      }

      // Xóa khỏi danh sách pool và persist
      this.workspaces = this.workspaces.filter((w) => String(w.workspaceId) !== wsKey && String(w.id) !== String(ws.id));
      this.persist();

      // 4. Tạo workspace mới với format tên chuẩn
      const userEmail = (account.email || '').trim().normalize('NFC');
      const atIdx = userEmail.lastIndexOf('@');
      const emailPrefix = atIdx >= 1 ? userEmail.slice(0, atIdx).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' : 'zcode_';
      const randSuffix = Date.now().toString(36).slice(-4);
      const wsName = `${emailPrefix}${randSuffix}`;

      const body = new FormData();
      const fields = {
        name: wsName,
        avatar: '',
        color: '#7b68ee',
        segmentTrackingAttributes: '{}',
        layoutSetting: '4.0.0',
        chat_enabled: 'true',
        chat_context: '{ "source": "auto-enablement" }',
        threaded_comments: 'true',
        extra_comment_reactions: '1',
      };
      for (const [k, v] of Object.entries(fields)) {
        body.append(k, v);
      }

      const crRes = await fetch(`${base}/team/v1/team?verbose_response=true&make_post_creation_updates=true`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + (initialToken || ws.token),
          'clickup-surface': 'client',
          'x-csrf': '1',
        },
        body,
      });

      if (!crRes.ok) {
        const errText = await crRes.text();
        throw new Error(`ClickUp API không tạo được workspace (${crRes.status}): ${errText.slice(0, 100)}`);
      }

      const crData = await crRes.json();
      const newWsId = String(crData?.id || '');
      if (!newWsId) throw new Error(`ClickUp API không trả về id workspace mới: ${JSON.stringify(crData)}`);

      // 5. Mint token cho workspace mới
      const minted = await this.mintWorkspaceTokenFromAccount(newWsId, account);

      // 6. Kích hoạt gói Trial MAX Plan 23
      let trialActivated = false;
      try {
        const trialRes = await fetch(`${base}/plan/v2/team/${newWsId}/trial`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + minted.token,
            'Content-Type': 'application/json',
            'clickup-surface': 'client',
            'clickup-client-version': '4.26.2',
            'x-csrf': '1',
            'x-workspace-id': newWsId,
          },
          body: JSON.stringify({ plan_id: '23' }),
        });
        const trialData = await trialRes.json();
        if (String(trialData?.plan_id) === '23') {
          trialActivated = true;
        }
      } catch (trErr) {
        console.warn(`[ClickUp Auto-Replace] Kích hoạt Trial MAX 23 cho ${wsName} cảnh báo: ${trErr.message}`);
      }

      const newWsObj = this._createWorkspaceEntry({
        id: `ws-${newWsId}`,
        label: `${wsName} (${newWsId.slice(-4)})`,
        workspaceId: newWsId,
        accountId: account.id,
        token: minted.token,
        enabled: true,
        limit: 3,
      });

      // Lấy quota của workspace mới
      try {
        const quota = await this.fetchWorkspaceQuota(newWsObj);
        if (quota) newWsObj.quota = quota;
      } catch {}

      this.workspaces.push(newWsObj);
      this.persist();
      console.log(`[ClickUp Auto-Replace] ✨ Thay mới hoàn tất! Workspace mới "${newWsObj.label}" (${newWsId}) đã tham gia pool (Trial MAX 23: ${trialActivated ? 'OK' : 'Chờ'}).`);
      return newWsObj;
    } catch (err) {
      console.error(`[ClickUp Auto-Replace] ❌ Lỗi thay mới workspace: ${err.message}`);
    } finally {
      this._replacingWsSet.delete(wsKey);
    }
  }

  


  // Preview auto-recreate (CHỈ ĐỌC, không xóa/tạo/persist): quét inventory ClickUp của
  // từng tài khoản, áp đúng luật lọc của autoRecreate (giữ primary, chỉ xóa workspace
  // tự sinh khớp prefix + thuộc owner), rồi quy hoạch tên mới bằng planNames.
  async previewAutoRecreate({ accountId = null, countPerAccount = 10 } = {}) {
    let targetAccounts = [];
    if (Array.isArray(accountId)) {
      targetAccounts = this.accounts.filter((a) => accountId.includes(a.id));
    } else if (accountId && accountId !== 'all') {
      const ids = String(accountId).split(',').map(v => v.trim()).filter(Boolean);
      targetAccounts = this.accounts.filter((a) => ids.includes(a.id));
    } else {
      targetAccounts = this.accounts.filter((a) => a.enabled !== false && (a.cookie || a.cuRefresh));
    }
    if (targetAccounts.length === 0) throw new Error('Không tìm thấy tài khoản ClickUp hợp lệ có cookie để xem trước.');
    const base = process.env.CLICKUP_API_BASE || 'https://frontdoor-prod-ap-southeast-1-1.clickup.com';
    const accounts = [];
    for (const account of targetAccounts) {
      let initialToken = account.initialToken || null;
      if (!initialToken) {
        const existingAccWs = this.workspaces.find((w) => w.accountId === account.id && w.token);
        if (existingAccWs) initialToken = existingAccWs.token;
      }
      const knownWsId = account.workspaceId || account.defaultWorkspaceId;
      if (!initialToken && knownWsId) {
        try { const m = await this.mintWorkspaceTokenFromAccount(knownWsId, account); if (m?.token) initialToken = m.token; } catch {}
      }
      if (!initialToken) { accounts.push({ accountId: account.id, email: account.email || '', error: 'Không mint được token để quét inventory.' }); continue; }
      let invRes = null;
      try {
        invRes = await fetch(`${base}/user/v1/user?include_teams=true&include_invited_by=true`, {
          headers: { Authorization: 'Bearer ' + initialToken, 'clickup-surface': 'client' },
        });
        if (!invRes.ok) invRes = null;
      } catch {}
      if (!invRes) {
        const cookieHeader = account.cookie || (account.cuRefresh ? `cu_refresh=${account.cuRefresh}` : '');
        if (cookieHeader) {
          try {
            invRes = await fetch(`${base}/user/v1/user?include_teams=true&include_invited_by=true`, {
              headers: { ...(account.cuRefresh ? { Authorization: 'Bearer ' + account.cuRefresh } : {}), Cookie: cookieHeader, 'clickup-surface': 'client', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', Origin: 'https://app.clickup.com', Referer: 'https://app.clickup.com/' },
            });
            if (!invRes.ok) invRes = null;
          } catch {}
        }
      }
      if (!invRes) { accounts.push({ accountId: account.id, email: account.email || '', error: 'Không quét được inventory ClickUp.' }); continue; }
      const invData = await invRes.json();
      const userId = String(invData.user?.id || '');
      const userEmail = (invData.user?.email || account.email || '').trim().normalize('NFC');
      const allTeams = Array.isArray(invData.teams) ? invData.teams : [];
      if (allTeams.length === 0) { accounts.push({ accountId: account.id, email: userEmail, error: 'Không tìm thấy team nào.' }); continue; }
      const primaryTeam = allTeams[0];
      const atIdx = userEmail.lastIndexOf('@');
      const emailPrefix = atIdx >= 1 ? userEmail.slice(0, atIdx).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' : 'zcode_';
      const toDelete = allTeams.slice(1).filter((t) => String(t.owner?.id || '') === userId && String(t.id) !== String(primaryTeam.id) && isManagedWorkspaceName(t.name, emailPrefix));
      const remaining = allTeams.filter((t) => !toDelete.some((d) => String(d.id) === String(t.id)));
      const planned = planNames(remaining, userEmail, countPerAccount);
      const existingNames = new Set(remaining.map((t) => t.name));
      accounts.push({
        accountId: account.id, email: userEmail, prefix: emailPrefix,
        keep: [{ id: String(primaryTeam.id), name: primaryTeam.name, role: 'primary' }],
        keepOther: remaining.slice(1).map((t) => ({ id: String(t.id), name: t.name, role: 'custom-kept' })),
        delete: toDelete.map((t) => ({ id: String(t.id), name: t.name })),
        create: planned.filter((n) => !existingNames.has(n)),
        skippedExisting: planned.filter((n) => existingNames.has(n)),
        warning: null,
      });
    }
    return { accounts, totalDelete: accounts.reduce((n, a) => n + (a.delete?.length || 0), 0), totalCreate: accounts.reduce((n, a) => n + (a.create?.length || 0), 0) };
  }

  async autoRecreateWorkspaces({ accountId = null, countPerAccount = 10, reason = 'manual' } = {}) {
    if (this._isRecreating) {
      throw new Error('Đang có tiến trình tự động làm mới Workspaces đang chạy, vui lòng chờ.');
    }
    this._isRecreating = true;
    this.pending_recreate = { accountId, step: 'start', startedAt: new Date().toISOString() };
    this.persist({ pending_recreate: this.pending_recreate });
    const logs = [];
    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
      console.log(`[ClickUp Auto-Recreate] ${msg}`);
      logs.push(line);
    };

    log(`Bắt đầu quy trình tự động làm mới Workspaces theo kỷ luật AIOBOX (Lý do: ${reason})...`);

    try {
      let targetAccounts = [];
      if (Array.isArray(accountId)) {
        targetAccounts = this.accounts.filter((a) => accountId.includes(a.id));
      } else if (accountId && accountId !== 'all') {
        const ids = String(accountId).split(',').map(s => s.trim()).filter(Boolean);
        targetAccounts = this.accounts.filter((a) => ids.includes(a.id));
      } else {
        targetAccounts = this.accounts.filter((a) => a.enabled !== false && (a.cookie || a.cuRefresh));
      }

      if (targetAccounts.length === 0) {
        throw new Error('Không tìm thấy tài khoản ClickUp hợp lệ có cookie để làm mới.');
      }

      const base = process.env.CLICKUP_API_BASE || 'https://frontdoor-prod-ap-southeast-1-1.clickup.com';
      const createdTotal = [];

      for (const account of targetAccounts) {
        const accLabel = account.label || account.email || account.id;
        log(`--- Bắt đầu xử lý tài khoản: ${accLabel} ---`);

        // 1. Tìm hoặc mint một token ban đầu để gọi user inventory
        let initialToken = account.initialToken || null;
        if (!initialToken) {
          const existingAccWs = this.workspaces.find((w) => w.accountId === account.id && w.token);
          if (existingAccWs) {
            initialToken = existingAccWs.token;
          }
        }

        // Thử mint từ known workspaceId của account nếu có
        const knownWsId = account.workspaceId || account.defaultWorkspaceId;
        if (!initialToken && knownWsId) {
          try {
            const m = await this.mintWorkspaceTokenFromAccount(knownWsId, account);
            if (m?.token) initialToken = m.token;
          } catch (mErr) {
            log(`  Thử mint token từ workspaceId ${knownWsId}: ${mErr.message}`);
          }
        }

        // Thử mint từ bất kỳ workspace nào trong pool
        if (!initialToken) {
          for (const w of this.workspaces) {
            try {
              const m = await this.mintWorkspaceTokenFromAccount(w.workspaceId, account);
              if (m?.token) {
                initialToken = m.token;
                break;
              }
            } catch {}
          }
        }

        // 2. Lấy danh sách inventory của tài khoản và xác minh identity
        log(`Quét danh sách Workspace hiện tại của ${accLabel}...`);

        let invRes = null;
        const cookieHeader = account.cookie || (account.cuRefresh ? `cu_refresh=${account.cuRefresh}` : '');

        // Cách A: Thử gọi qua initialToken nếu có
        if (initialToken) {
          try {
            invRes = await fetch(`${base}/user/v1/user?include_teams=true&include_invited_by=true`, {
              headers: {
                Authorization: 'Bearer ' + initialToken,
                'clickup-surface': 'client',
              },
            });
            if (!invRes.ok) invRes = null;
          } catch {
            invRes = null;
          }
        }

        // Cách B: Nếu chưa có initialToken hoặc token hết hạn, gọi bằng Cookie & cu_refresh
        if (!invRes && cookieHeader) {
          try {
            invRes = await fetch(`${base}/user/v1/user?include_teams=true&include_invited_by=true`, {
              headers: {
                ...(account.cuRefresh ? { Authorization: 'Bearer ' + account.cuRefresh } : {}),
                Cookie: cookieHeader,
                'clickup-surface': 'client',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
                Origin: 'https://app.clickup.com',
                Referer: 'https://app.clickup.com/',
              },
            });
            if (!invRes.ok) {
              invRes = await fetch(`${base}/v1/user?include_teams=true`, {
                headers: {
                  Cookie: cookieHeader,
                  'clickup-surface': 'client',
                },
              });
            }
          } catch (cookieErr) {
            log(`  ⚠️ Thử quét bằng Cookie gặp lỗi: ${cookieErr.message}`);
          }
        }

        if (!invRes || !invRes.ok) {
          log(`❌ Lỗi truy vấn danh sách Workspace (${invRes?.status || 'không phản hồi'}). Bỏ qua tài khoản này.`);
          continue;
        }

        const invData = await invRes.json();
        const userId = String(invData.user?.id || '');
        const userEmail = (invData.user?.email || account.email || '').trim().normalize('NFC');
        const allTeams = Array.isArray(invData.teams) ? invData.teams : [];
        log(`Xác thực người dùng: ${userEmail} (ID: ${userId}) - Tìm thấy ${allTeams.length} teams.`);

        if (allTeams.length === 0) {
          log(`❌ Không tìm thấy team nào trong tài khoản ${accLabel}.`);
          continue;
        }

        // Team đầu tiên là base workspace — LUÔN GIỮ LẠI ĐỂ BẢO VỆ TÀI KHOẢN
        const primaryTeam = allTeams[0];
        log(`Giữ nguyên Base Workspace gốc: "${primaryTeam.name}" (${primaryTeam.id}).`);

        // Đảm bảo có token JWT hợp lệ từ primaryTeam
        if (!initialToken) {
          try {
            const m = await this.mintWorkspaceTokenFromAccount(primaryTeam.id, account);
            initialToken = m.token;
            account.initialToken = m.token;
            account.workspaceId = String(primaryTeam.id);
            this.persist();
            log(`  🔑 Đã cấp mới JWT token từ Base Workspace (${primaryTeam.id}).`);
          } catch (mErr) {
            log(`  ⚠️ Lỗi cấp token từ Base Workspace: ${mErr.message}`);
          }
        }

        if (!initialToken) {
          log(`❌ Không thể xác thực JWT Token cho tài khoản ${accLabel}. Bỏ qua.`);
          continue;
        }

        // Tính prefix quản lý theo kỷ luật AIOBOX (email_prefix_)
        const atIdx = userEmail.lastIndexOf('@');
        const emailPrefix = atIdx >= 1
          ? userEmail.slice(0, atIdx).replace(/[^a-zA-Z0-9_-]/g, '_') + '_'
          : 'zcode_';

        // Lọc an toàn: Chỉ xóa các workspace do hệ thống tự sinh (khớp email prefix hoặc zcode), KHÔNG BAO GIỜ xóa workspace tùy chỉnh của user
        const teamsToDelete = allTeams.slice(1).filter((t) => {
          const ownerId = String(t.owner?.id || '');
          const isOwner = ownerId === userId;
          const isNotPrimary = String(t.id) !== String(primaryTeam.id);
          const isManaged = isManagedWorkspaceName(t.name, emailPrefix);
          return isOwner && isNotPrimary && isManaged;
        });

        // Chỉ ghi nhận workspace xóa THÀNH CÔNG phía server — tránh reuse tên khi DELETE lỗi.
        const deletedIds = new Set();
        if (teamsToDelete.length > 0) {
          log(`Tiến hành dọn dẹp an toàn ${teamsToDelete.length} workspace tự sinh cũ (chỉ xóa workspace khớp prefix "${emailPrefix}")...`);
          for (const t of teamsToDelete) {
            try {
              const delRes = await fetch(`${base}/team/v1/team/${t.id}`, {
                method: 'DELETE',
                headers: {
                  Authorization: 'Bearer ' + initialToken,
                  'clickup-surface': 'client',
                  'x-csrf': '1',
                  'x-workspace-id': String(t.id),
                },
              });
              if (delRes.ok) {
                log(`  🗑️ Đã xóa thành công workspace cũ: ${t.name} (${t.id})`);
                deletedIds.add(String(t.id));
              } else if (delRes.status === 404 || delRes.status === 410) {
                // 2026-10-28 (P3): team đã bị xóa server-side từ trước → coi như đã xóa.
                // Trước đây entry pool với token chết được giữ bất tử và tên bị reuse.
                log(`  🧟 Workspace ${t.id} không còn tồn tại server (${delRes.status}) — đánh dấu đã xóa.`);
                deletedIds.add(String(t.id));
              } else {
                log(`  ⚠️ Xóa workspace ${t.id} phản hồi status ${delRes.status}`);
              }
              await new Promise((r) => setTimeout(r, 350));
            } catch (delErr) {
              log(`  ⚠️ Lỗi xóa workspace ${t.id}: ${delErr.message}`);
            }
          }
        } else {
          log(`Không có workspace tự sinh cũ nào cần xóa.`);
        }

        // Lọc bỏ khỏi pool nội bộ CHỈ những workspace đã xóa thành công phía server
        // (workspace xóa thất bại vẫn còn sống — giữ entry và tên của nó để tránh collision).
        this.workspaces = this.workspaces.filter((w) => {
          if (w.accountId === account.id) {
            return !deletedIds.has(String(w.workspaceId));
          }
          return true;
        });
        this.persist();

        // 3. Quy hoạch tên Workspace theo kỷ luật AIOBOX (planNames)
        const remainingTeams = allTeams.filter((t) => !deletedIds.has(String(t.id)));
        const plannedWorkspaceNames = planNames(remainingTeams, userEmail, countPerAccount);
        log(`Quy hoạch ${plannedWorkspaceNames.length} tên workspace mới: [${plannedWorkspaceNames.join(', ')}]`);

        // 4. Tạo workspaces theo payload onboarding chuẩn của AIOBOX và kích hoạt MAX 23
        for (let i = 0; i < plannedWorkspaceNames.length; i++) {
          const wsName = plannedWorkspaceNames[i];
          const idxDisplay = i + 1;

          // Kiểm tra tiền điều kiện: Tên chưa tồn tại
          if (remainingTeams.some((t) => t.name === wsName)) {
            log(`  ⚠️ Workspace "${wsName}" đã tồn tại. Bỏ qua tạo trùng lặp.`);
            continue;
          }

          try {
            log(`  [${idxDisplay}/${countPerAccount}] Đang tạo workspace: "${wsName}" với onboarding AI đầy đủ...`);

            // Chuẩn bị FormData theo cấu trúc AIOBOX onboarding v2
            const body = new FormData();
            const fields = {
              'use-case': 'work',
              Solutions: 'startup',
              add: '[]',
              tools: 'null',
              Features: 'ai',
              name: wsName,
              Finish: wsName,
              color: '#40BC86',
              spaces: JSON.stringify(DEFAULT_SPACES),
              v2: 'true',
              onboarding_v2: 'true',
              v2_beta: 'true',
              ga4_attributes: '{}',
              segmentTrackingAttributes: '{}',
              layoutSetting: '4.0.0',
              chat_enabled: 'true',
              chat_context: '{ "source": "auto-enablement" }',
              threaded_comments: 'true',
              extra_comment_reactions: '1',
            };
            for (const [k, v] of Object.entries(fields)) {
              body.append(k, v);
            }

            const crRes = await fetch(`${base}/team/v1/team?verbose_response=true&make_post_creation_updates=true`, {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + initialToken,
                'clickup-surface': 'client',
                'x-csrf': '1',
                'x-workspace-id': String(primaryTeam.id),
              },
              body,
            });

            const crData = await crRes.json();
            const newWsId = String(crData?.id || '');
            if (!newWsId) {
              log(`  ❌ Không tạo được workspace "${wsName}": ${JSON.stringify(crData)}`);
              continue;
            }

            // Mint token cho workspace mới
            const minted = await this.mintWorkspaceTokenFromAccount(newWsId, account);

            // Kiểm tra tính hợp lệ của trial (AIOBOX trialAvailability check)
            let isEligible = false;
            try {
              const availRes = await fetch(`${base}/plan/v1/team/${newWsId}/trialAvailability`, {
                headers: {
                  Authorization: 'Bearer ' + minted.token,
                  'clickup-surface': 'client',
                  'x-csrf': '1',
                  'x-workspace-id': newWsId,
                },
              });
              if (availRes.ok) {
                const availData = await availRes.json();
                isEligible = availData?.availability?.Max === true;
              }
            } catch (availErr) {
              log(`  ⚠️ Kiểm tra trialAvailability cho ${wsName} gặp lỗi: ${availErr.message}`);
            }

            // Kích hoạt Trial MAX Plan 23
            let trialActivated = false;
            try {
              const trialRes = await fetch(`${base}/plan/v2/team/${newWsId}/trial`, {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + minted.token,
                  'Content-Type': 'application/json',
                  'clickup-surface': 'client',
                  'clickup-client-version': '4.26.2',
                  'x-csrf': '1',
                  'x-workspace-id': newWsId,
                },
                body: JSON.stringify({ plan_id: '23' }),
              });
              const trialData = await trialRes.json();
              if (String(trialData?.plan_id) === '23') {
                trialActivated = true;
              } else {
                log(`  ⚠️ Phản hồi trial không phải Plan 23: ${JSON.stringify(trialData)}`);
              }
            } catch (trErr) {
              log(`  ⚠️ Lỗi gửi yêu cầu kích hoạt Trial MAX cho ${wsName}: ${trErr.message}`);
            }

            const newWsObj = this._createWorkspaceEntry({
              id: `ws-${newWsId}`,
              label: `${wsName} (${newWsId.slice(-4)})`,
              workspaceId: newWsId,
              accountId: account.id,
              token: minted.token,
              enabled: true,
              limit: 3,
            });

            // Lấy quota của workspace mới để đối chiếu ngay
            const quota = await this.fetchWorkspaceQuota(newWsObj);
            if (quota) newWsObj.quota = quota;

            this.workspaces.push(newWsObj);
            createdTotal.push(newWsObj);
            remainingTeams.push({ id: newWsId, name: wsName });
            // Persist ngay sau mỗi workspace tạo xong: crash giữa chừng không mất progress
            // và không để mồ côi workspace phía server ngoài tầm quản lý.
            this.persist();

            log(`  ✨ [${idxDisplay}/${countPerAccount}] Thành công: "${wsName}" (${newWsId}) - Trial MAX 23: ${trialActivated ? 'Đã kích hoạt' : (isEligible ? 'Chờ kích hoạt' : 'Không khả dụng')}`);
            await new Promise((r) => setTimeout(r, 450));
          } catch (crErr) {
            log(`  ❌ Lỗi xử lý workspace "${wsName}": ${crErr.message}`);
          }
        }
      }

      this.persist();
      log(`Hoàn tất! Tổng cộng đã tạo ${createdTotal.length} Workspace mới. Pool hiện có ${this.workspaces.length} Workspaces.`);
      return {
        ok: true,
        createdCount: createdTotal.length,
        logs,
        totalWorkspaces: this.workspaces.length,
      };
    } finally {
      this._isRecreating = false;
      this.pending_recreate = null;
      this.persist({ pending_recreate: null });
    }
  }

  async auditAllWorkspacesQuota() {
    // 2026-10-28 SAFETY (P1-6): đếm audit THẤT BẠI. fetchWorkspaceQuota nuốt error
    // và trả về quota stale — nếu dùng dữ liệu stale để kết luận "toàn pool cạn"
    // thì Auto-Recreate sẽ xóa workspace SỐNG dựa trên dữ liệu cũ.
    let auditFailures = 0;
    const now = Date.now();
    const promises = this.workspaces.filter((w) => w.enabled).map(async (w) => {
      const before = w.quota?.lastCheckedAt || 0;
      await this.fetchWorkspaceQuota(w);
      if ((w.quota?.lastCheckedAt || 0) <= before) auditFailures += 1;
    });
    await Promise.allSettled(promises);
    this.persist();

    // Tự động kiểm tra nếu toàn bộ Workspace đều cạn quota hoặc bị block thì trigger recreate
    const enabledWs = this.workspaces.filter((w) => w.enabled);
    const FRESH_MS = 30 * 60 * 1000;
    const allExhausted = enabledWs.length > 0 && enabledWs.every((w) => {
      const q = w.quota || {};
      const fresh = (q.lastCheckedAt || 0) > now - FRESH_MS;
      return fresh && (q.isBlocked || w.quotaStatus === 'exhausted' || (q.weeklyLeft === 0 && q.dailyLeft === 0));
    });
    // Chỉ recreate khi MỌI workspace vừa được audit thành công trong vòng 30 phút
    // và không có lần fetch nào thất bại trong đợt audit này.
    if (allExhausted && auditFailures === 0) {
      this._checkAndTriggerAutoRecreate({ reason: 'Audit phát hiện tất cả Workspace đều bị chặn hoặc cạn Quota' });
    } else if (allExhausted && auditFailures > 0) {
      console.warn(`[ClickUpPool] Auto-Recreate bị hoãn: ${auditFailures} workspace audit THẤT BẠI trong đợt vừa rồi — không xóa workspace dựa trên dữ liệu stale.`);
    } else {
      // Thay mới từng workspace bị cạn quota hoặc bị block riêng lẻ
      for (const w of enabledWs) {
        const q = w.quota || {};
        const fresh = (q.lastCheckedAt || 0) > now - FRESH_MS;
        if (fresh && (q.isBlocked || w.quotaStatus === 'exhausted' || (q.weeklyLeft === 0 && q.dailyLeft === 0))) {
          this.replaceExhaustedWorkspace(w, 'Audit phát hiện workspace cạn quota').catch(() => {});
        }
      }
    }
  }

  getSnapshot() {
    const now = Date.now();
    return this.workspaces.map((w) => {
      const expMs = this.getTokenExpMs(w);
      const isCooldown = Boolean(w.cooldownUntil && w.cooldownUntil > now);
      const rawQuota = w.quota || {};
      const isExhausted = w.quotaStatus === 'exhausted' || rawQuota.status === 'exhausted';
      const quota = {
        dailyLimit: rawQuota.dailyLimit || 450000,
        dailyUsage: rawQuota.dailyUsage || 0,
        dailyLeft: isExhausted ? 0 : (rawQuota.dailyLeft ?? 450000),
        dailyResetsAt: rawQuota.dailyResetsAt || null,
        weeklyLimit: rawQuota.weeklyLimit || 1125000,
        weeklyUsage: rawQuota.weeklyUsage || 0,
        weeklyLeft: isExhausted && (rawQuota.weeklyLeft === 0) ? 0 : (rawQuota.weeklyLeft ?? 1125000),
        weeklyResetsAt: rawQuota.weeklyResetsAt || null,
        isBlocked: Boolean(rawQuota.isBlocked || isExhausted),
        lastCheckedAt: rawQuota.lastCheckedAt || null,
        status: isExhausted ? 'exhausted' : (isCooldown ? 'cooldown' : (rawQuota.status || 'available')),
        // 2026-10-28 (P3): hiển thị mốc reset thật thay vì chuỗi ghim cứng sai giờ.
        resetsAt: rawQuota.dailyResetsAt
          ? `Reset ${new Date(Date.parse(rawQuota.dailyResetsAt) || getNextDailyResetTime()).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
          : 'Reset 07:00 sáng (giờ VN)',
      };

      return {
        id: w.id,
        label: w.label,
        workspaceId: w.workspaceId,
        accountId: w.accountId,
        enabled: w.enabled,
        limit: w.limit,
        activeRequests: w.activeRequests,
        inFlight: w.activeRequests,
        queueLength: w.queue.queueLength,
        totalRequests: w.totalRequests,
        requestsCount: w.totalRequests,
        successRequests: w.successRequests,
        errorRequests: w.errorRequests,
        isCooldown,
        cooldownUntil: w.cooldownUntil || 0,
        cooldownRemainingSeconds: isCooldown ? Math.round((w.cooldownUntil - now) / 1000) : 0,
        cooldownReason: isCooldown ? w.cooldownReason : null,
        tokenExp: expMs ? new Date(expMs).toISOString() : null,
        tokenExpHoursLeft: expMs ? Number(((expMs - now) / 3600000).toFixed(1)) : null,
        hasAccountLinked: Boolean(this.getAccountForWorkspace(w)),
        quotaStatus: w.quotaStatus || (isCooldown ? 'cooldown' : 'available'),
        quota,
      };
    });
  }

  getAccountsSnapshot() {
    return this.accounts.map((a) => {
      const linked = this.workspaces.filter((w) => {
        const acc = this.getAccountForWorkspace(w);
        return acc && acc.id === a.id;
      });
      return {
        id: a.id,
        label: a.label,
        email: a.email,
        userId: a.userId,
        enabled: a.enabled,
        lastRenewed: a.lastRenewed,
        hasCuRefresh: Boolean(a.cuRefresh || (a.cookie && a.cookie.includes('cu_refresh'))),
        linkedWorkspacesCount: linked.length,
        linkedWorkspaces: linked.map((w) => ({ id: w.id, label: w.label, workspaceId: w.workspaceId })),
      };
    });
  }

  getPoolSummary() {
    const ws = this.workspaces;
    const now = Date.now();
    const active = ws.filter((w) => w.enabled && (!w.cooldownUntil || w.cooldownUntil <= now) && w.quotaStatus !== 'exhausted');
    const inCooldown = ws.filter((w) => w.enabled && w.cooldownUntil && w.cooldownUntil > now);
    const exhausted = ws.filter((w) => w.enabled && w.quotaStatus === 'exhausted');
    const totalRequests = ws.reduce((acc, w) => acc + w.totalRequests, 0);
    const successRequests = ws.reduce((acc, w) => acc + w.successRequests, 0);
    const inFlight = ws.reduce((acc, w) => acc + w.activeRequests, 0);

    const totalDailyLimit = ws.reduce((sum, w) => sum + (w.enabled ? (w.quota?.dailyLimit || 450000) : 0), 0);
    const totalDailyUsed = ws.reduce((sum, w) => sum + (w.enabled ? (w.quota?.dailyUsage || 0) : 0), 0);
    const totalDailyLeft = ws.reduce((sum, w) => sum + (w.enabled && w.quotaStatus !== 'exhausted' ? (w.quota?.dailyLeft || 450000) : 0), 0);
    const totalWeeklyLimit = ws.reduce((sum, w) => sum + (w.enabled ? (w.quota?.weeklyLimit || 1125000) : 0), 0);
    const totalWeeklyUsed = ws.reduce((sum, w) => sum + (w.enabled ? (w.quota?.weeklyUsage || 0) : 0), 0);
    const totalWeeklyLeft = ws.reduce((sum, w) => sum + (w.enabled && w.quotaStatus !== 'exhausted' ? (w.quota?.weeklyLeft || 1125000) : 0), 0);

    const quotaBlockedWorkspaces = ws.filter((w) => w.enabled && (w.quotaStatus === 'exhausted' || (w.cooldownUntil && w.cooldownUntil > now))).map((w) => ({
      label: w.label, workspaceId: w.workspaceId, quotaStatus: w.quotaStatus || null,
      cooldownReason: w.cooldownUntil && w.cooldownUntil > now ? (w.cooldownReason || null) : null,
      cooldownUntil: w.cooldownUntil && w.cooldownUntil > now ? new Date(w.cooldownUntil).toISOString() : null,
      // Quota hiển thị theo entitlement có thể khác quota thật upstream (ví dụ: entitlement
      // còn 450k nhưng upstream vẫn USAGE_QUOTA_EXCEEDED) — lý do cách ly mới là sự thật vận hành.
      entitlementDailyLeft: w.quota?.dailyLeft ?? null,
    }));
    return {
      quotaBlockedWorkspaces,
      totalWorkspaces: ws.length,
      activeWorkspaces: active.length,
      inCooldown: inCooldown.length,
      exhaustedWorkspaces: exhausted.length,
      disabled: ws.filter((w) => !w.enabled).length,
      totalAccounts: this.accounts.length,
      inFlightRequests: inFlight,
      totalRequests,
      successRequests,
      successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 100,
      totalDailyLimit,
      totalDailyUsed,
      totalDailyLeft,
      totalWeeklyLimit,
      totalWeeklyUsed,
      totalWeeklyLeft,
      healthyWorkspaces: ws.filter((w) => w.enabled && w.quotaStatus !== 'exhausted').length,
    };
  }
}

// ---------------------------------------------------------------------------
// Load Initial Config & Initialize Singleton ClickUp Pool
// ---------------------------------------------------------------------------

function loadConfigFromFile() {
  try {
    return readPoolConfig();
  } catch (err) {
    // 2026-10-28 (P2): state đọc lỗi KHÔNG còn âm thầm chạy rỗng. Persist sẽ không
    // bao giờ ghi đè file hỏng (readPoolConfig throw bên trong persistPoolConfig),
    // nhưng operator cần biết pool đang khởi động TRỐNG.
    console.error(`[ClickUpPool] ⚠️ KHÔNG ĐỌC ĐƯỢC state file (pool khởi động rỗng, không ghi đè file): ${err.message}`);
    return { workspaces: [], accounts: [] };
  }
}

function saveConfigToFile(updates) {
  try {
    persistPoolConfig(updates);
  } catch (err) {
    console.error(`[ClickUpPool] Lỗi lưu trạng thái: ${err.message}`);
  }
}

export const clickupPool = new WorkspacePool(loadConfigFromFile(), saveConfigToFile);

// Auto-renewal cron: Chạy mỗi 30 phút kiểm tra và gia hạn token sắp hết hạn
setInterval(() => {
  clickupPool.renewAllIfNeeded({ minHoursLeft: 6 }).catch((err) => {
    console.warn('[ClickUpPool] Auto-renewal check error:', err.message);
  });
}, 30 * 60 * 1000).unref();

// Auto-quota audit cron: Tự động kiểm tra hạn mức Quota của toàn bộ Workspace khi khởi động và mỗi 15 phút
setTimeout(() => {
  clickupPool.auditAllWorkspacesQuota().catch((err) => {
    console.warn('[ClickUpPool] Startup quota audit error:', err.message);
  });
}, 3000).unref();

setInterval(() => {
  clickupPool.auditAllWorkspacesQuota().catch((err) => {
    console.warn('[ClickUpPool] Periodic quota audit error:', err.message);
  });
}, 15 * 60 * 1000).unref();
