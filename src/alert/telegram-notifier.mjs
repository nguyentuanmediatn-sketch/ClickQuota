import { createHash } from 'node:crypto';
import { ALERT_EVENTS, alertEvents } from './events.mjs';

const DEDUP_MS = 5 * 60 * 1000;
const MAX_DEDUP_KEYS = 2048;
const MAX_QUEUE = 100;
const MAX_CONCURRENCY = 2;
const SEND_TIMEOUT_MS = 5000;
const TELEGRAM_TEXT_LIMIT = 3500;
const SAFE_EVENT_TYPES = new Set([
  ALERT_EVENTS.UPSTREAM_HTTP_ERROR,
  ALERT_EVENTS.CIRCUIT_OPEN,
  ALERT_EVENTS.CIRCUIT_CLOSE,
]);

function validDigestHours(value) {
  const n = Number(value);
  return n === 12 || n === 24 ? n : 24;
}

function runtimeConfig(env) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === 'string' ? env.TELEGRAM_BOT_TOKEN.trim() : '';
  const chatId = typeof env.TELEGRAM_CHAT_ID === 'string' ? env.TELEGRAM_CHAT_ID.trim() : '';
  return token && chatId ? { token, chatId } : null;
}

export function createTelegramNotifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  eventBus = alertEvents,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  timeoutMs = SEND_TIMEOUT_MS,
  maxQueue = MAX_QUEUE,
  concurrency = MAX_CONCURRENCY,
  dedupMs = DEDUP_MS,
  startedAt = now(),
} = {}) {
  const config = runtimeConfig(env);
  const digestHours = validDigestHours(env.CLICKQUOTA_TELEGRAM_DIGEST_HOURS);
  const metrics = { requests: 0, errors: 0, aborted: 0, latencyTotalMs: 0 };
  const dedup = new Map();
  const queue = [];
  const controllers = new Set();
  let active = 0;
  let running = false;
  let unsubscribe = null;
  let digestTimer = null;

  const enabled = Boolean(config && typeof fetchImpl === 'function');

  function enqueue(text, key = null) {
    if (!enabled || !running || queue.length >= Math.min(MAX_QUEUE, Math.max(1, maxQueue))) return false;
    if (key) {
      const t = now();
      for (const [k, expiry] of dedup) if (expiry <= t) dedup.delete(k);
      if ((dedup.get(key) || 0) > t) return false;
      // Reserve before enqueue: simultaneous identical events are coalesced.
      if (dedup.size >= MAX_DEDUP_KEYS) return false;
      dedup.set(key, t + dedupMs);
    }
    queue.push(text.slice(0, TELEGRAM_TEXT_LIMIT));
    pump();
    return true;
  }

  async function send(text) {
    const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
    const controller = new AbortController();
    controllers.add(controller);
    let cancel;
    const cancelled = new Promise(resolve => { cancel = () => resolve(null); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await Promise.race([cancelled, Promise.resolve().then(() => fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
        signal: controller.signal,
      }))]);
      // Do not download or log Telegram response bodies (may contain sensitive data).
      const ok = Boolean(response?.ok);
      try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
      return ok;
    } catch {
      // Không log exception: fetch errors đôi khi chứa URL và bot token.
      return false;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      controllers.delete(controller);
    }
  }

  function pump() {
    while (running && active < Math.min(MAX_CONCURRENCY, Math.max(1, concurrency)) && queue.length) {
      const text = queue.shift();
      active++;
      send(text).catch(() => false).finally(() => {
        active--;
        pump();
      });
    }
  }

  function formatEvent(event) {
    // Workspace ID/label đều do cấu hình cung cấp: chỉ gửi fingerprint không đảo ngược.
    // Không gửi token, payload hay thông điệp lỗi upstream nguyên văn.
    const workspace = createHash('sha256').update(String(event.workspaceId || 'unknown')).digest('hex').slice(0, 12);
    const status = Number.isFinite(Number(event.status)) ? String(Number(event.status)) : 'không rõ';
    if (event.type === ALERT_EVENTS.UPSTREAM_HTTP_ERROR) {
      return `ClickQuota: upstream HTTP ${status}\nWorkspace: ${workspace}\nSự cố upstream được ghi nhận (kể cả khi failover thành công).`;
    }
    if (event.type === ALERT_EVENTS.CIRCUIT_OPEN) {
      return `ClickQuota: circuit breaker đã kích hoạt\nWorkspace: ${workspace}\nTạm ngưng đến khi cooldown được gỡ hoặc hết hạn.`;
    }
    if (event.type === ALERT_EVENTS.CIRCUIT_CLOSE) {
      return `ClickQuota: workspace đã thoát cooldown\nWorkspace: ${workspace}\nPool đã ghi nhận trạng thái phục hồi.`;
    }
    return null;
  }

  function onEvent(event) {
    if (!running || !event || !SAFE_EVENT_TYPES.has(event.type)) return;
    const workspace = createHash('sha256').update(String(event.workspaceId || 'unknown')).digest('hex');
    if (event.type === ALERT_EVENTS.UPSTREAM_HTTP_ERROR && !(event.status === 429 || (Number.isInteger(event.status) && event.status >= 500 && event.status <= 599))) return;
    const status = event.type === ALERT_EVENTS.UPSTREAM_HTTP_ERROR ? String(Number(event.status) || 'unknown') : '';
    const key = `${workspace}|${event.type}|${status}`;
    const text = formatEvent(event);
    if (text) enqueue(text, key);
  }

  function recordRequest({ outcome, durationMs } = {}) {
    metrics.requests++;
    if (outcome === 'aborted') metrics.aborted++;
    else if (outcome === 'error') metrics.errors++;
    const duration = Number(durationMs);
    if (Number.isFinite(duration) && duration >= 0) metrics.latencyTotalMs += duration;
  }

  function snapshotMetrics() {
    const total = metrics.requests;
    return {
      requests: metrics.requests,
      errors: metrics.errors,
      aborted: metrics.aborted,
      uptimeMs: Math.max(0, now() - startedAt),
      avgLatencyMs: total ? Math.round(metrics.latencyTotalMs / total) : 0,
    };
  }

  function digestText(snapshot = snapshotMetrics()) {
    const uptimeHours = (snapshot.uptimeMs / 3600000).toFixed(1);
    return [
      `ClickQuota health digest (${digestHours}h)`,
      `Requests: ${snapshot.requests}`,
      `Errors: ${snapshot.errors}`,
      `Aborted: ${snapshot.aborted}`,
      `Uptime: ${uptimeHours}h`,
      `Average latency: ${snapshot.avgLatencyMs}ms`,
    ].join('\n');
  }

  function sendDigest() {
    if (!running) return false;
    const snapshot = snapshotMetrics();
    const accepted = enqueue(digestText(snapshot));
    if (!accepted) return false;
    metrics.requests = 0;
    metrics.errors = 0;
    metrics.aborted = 0;
    metrics.latencyTotalMs = 0;
    return true;
  }

  function start() {
    if (!enabled || running) return false;
    running = true;
    unsubscribe = eventBus.subscribe(onEvent);
    digestTimer = setIntervalImpl(sendDigest, digestHours * 60 * 60 * 1000);
    digestTimer?.unref?.();
    return true;
  }

  function close() {
    if (!running) return;
    running = false;
    unsubscribe?.();
    unsubscribe = null;
    if (digestTimer) clearIntervalImpl(digestTimer);
    digestTimer = null;
    queue.length = 0;
    dedup.clear();
    for (const controller of controllers) controller.abort();
  }

  // Test utility: a user-invoked explicit probe. No automatic probe at startup.
  async function sendTestMessage() {
    if (!enabled) return { ok: false, reason: 'disabled' };
    const ok = await send('ClickQuota: Telegram test message.');
    return { ok };
  }

  return {
    enabled,
    digestHours,
    start,
    close,
    recordRequest,
    snapshotMetrics,
    digestText,
    sendDigest,
    sendTestMessage,
    // Read-only bounded-state counters for health checks and tests.
    get pendingCount() { return queue.length; },
    get activeCount() { return active; },
    get dedupKeyCount() { return dedup.size; },
  };
}
