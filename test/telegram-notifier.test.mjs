import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AlertEventBus, ALERT_EVENTS } from '../src/alert/events.mjs';
import { createTelegramNotifier } from '../src/alert/telegram-notifier.mjs';
import { main } from '../test-telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' };
function setup(options = {}) {
  const sent = [];
  const bus = new AlertEventBus();
  let tick;
  let cleared = 0;
  const notifier = createTelegramNotifier({
    env, eventBus: bus,
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; },
    setIntervalImpl: fn => { tick = fn; return { unref() {} }; },
    clearIntervalImpl: () => { cleared++; },
    ...options,
  });
  return { notifier, bus, sent, tick: () => tick(), cleared: () => cleared };
}
const flush = () => delay(10);

test('missing credentials silently disables sends and subscriptions', async () => {
  let calls = 0;
  const { notifier, bus } = setup({ env: {}, fetchImpl: () => { calls++; } });
  assert.equal(notifier.enabled, false);
  assert.equal(notifier.start(), false);
  assert.equal(bus.observerCount, 0);
  assert.deepEqual(await notifier.sendTestMessage(), { ok: false, reason: 'disabled' });
  notifier.close();
  assert.equal(calls, 0);
});

test('concurrent dedup expires exactly at five minutes and separates nodes and event types', async t => {
  let now = 1000;
  const { notifier, bus, sent } = setup({ now: () => now });
  t.after(() => notifier.close());
  notifier.start();
  const event = { workspaceId: 'one', status: 429, error: 'PRIVATE ERROR', token: 'PRIVATE TOKEN' };
  for (let i = 0; i < 100; i++) bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, event);
  await flush();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /PRIVATE|test-token|test-chat/);
  now += 299999;
  bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, event);
  await flush();
  assert.equal(sent.length, 1);
  now++;
  bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, event);
  await flush();
  assert.equal(sent.length, 2);
  bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, { ...event, workspaceId: 'two' });
  bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, { ...event, status: 503 });
  bus.emit(ALERT_EVENTS.CIRCUIT_OPEN, event);
  bus.emit(ALERT_EVENTS.CIRCUIT_CLOSE, event);
  bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, { ...event, status: 404 });
  await flush();
  assert.equal(sent.length, 6);
});

test('digest records errors and aborts separately, resets period and cleans up', async () => {
  let now = 0;
  const { notifier, bus, sent, tick, cleared } = setup({ now: () => now, env: { ...env, CLICKQUOTA_TELEGRAM_DIGEST_HOURS: '12' } });
  notifier.start();
  notifier.start();
  assert.equal(bus.observerCount, 1);
  assert.equal(notifier.digestHours, 12);
  assert.equal(notifier.snapshotMetrics().avgLatencyMs, 0);
  notifier.recordRequest({ outcome: 'success', durationMs: 10 });
  notifier.recordRequest({ outcome: 'error', durationMs: 20 });
  notifier.recordRequest({ outcome: 'aborted', durationMs: 30 });
  now = 3600000;
  assert.deepEqual(notifier.snapshotMetrics(), { requests: 3, errors: 1, aborted: 1, uptimeMs: 3600000, avgLatencyMs: 20 });
  tick();
  await flush();
  assert.match(sent[0].text, /Requests: 3/);
  assert.match(sent[0].text, /Errors: 1/);
  assert.match(sent[0].text, /Average latency: 20ms/);
  assert.equal(notifier.snapshotMetrics().requests, 0);
  notifier.close();
  notifier.close();
  assert.equal(cleared(), 1);
  assert.equal(bus.observerCount, 0);
  assert.equal(notifier.pendingCount, 0);
});

test('transport exceptions, rejection responses and stalled sends are contained', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetchImpl of [() => { throw new Error('SECRET'); }, async () => ({ ok: false }), () => new Promise(() => {})]) {
      const { notifier } = setup({ fetchImpl, timeoutMs: 15 });
      assert.equal((await notifier.sendTestMessage()).ok, false);
    }
  } finally { clearInterval(keepAlive); }
});

test('queue and concurrency are bounded and close aborts active sends', async () => {
  const { notifier, bus } = setup({ maxQueue: 3, fetchImpl: () => new Promise(() => {}) });
  notifier.start();
  for (let i = 0; i < 100; i++) bus.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, { workspaceId: String(i), status: 503 });
  assert.equal(notifier.activeCount, 2);
  assert.equal(notifier.pendingCount, 3);
  notifier.close();
  await flush();
  assert.equal(notifier.activeCount, 0);
});

test('observer failures do not affect other observers', async () => {
  const bus = new AlertEventBus();
  let received = 0;
  bus.subscribe(() => { throw new Error('observer'); });
  bus.subscribe(async () => { throw new Error('async observer'); });
  bus.subscribe(() => { received++; });
  assert.doesNotThrow(() => bus.emit(ALERT_EVENTS.CIRCUIT_OPEN));
  await flush();
  assert.equal(received, 1);
});

test('pool emits circuit open once per incident and close on release; rate limit is not a breaker', async t => {
  const { WorkspacePool } = await import('../src/clickup-pool.mjs');
  const { alertEvents } = await import('../src/alert/events.mjs');
  const events = [];
  const unsubscribe = alertEvents.subscribe(e => events.push(e.type));
  t.after(unsubscribe);
  const pool = new WorkspacePool({ workspaces: [{ id: 'w1', workspaceId: 'one', token: 't', limit: 1 }], accounts: [] }, () => {});
  const ws = pool.workspaces[0];
  pool.reportError(ws, 'HTTP 429 Rate Limit', 429);
  assert.deepEqual(events, []);
  ws.cooldownUntil = 0;
  for (let i = 0; i < 4; i++) pool.reportError(ws, 'HTTP 503 from ClickUp gateway', 503);
  assert.deepEqual(events, [ALERT_EVENTS.CIRCUIT_OPEN]);
  pool.clearCooldown('w1');
  pool.clearCooldown('w1');
  assert.deepEqual(events, [ALERT_EVENTS.CIRCUIT_OPEN, ALERT_EVENTS.CIRCUIT_CLOSE]);
  for (let i = 0; i < 3; i++) pool.reportError(ws, 'HTTP 502 from ClickUp gateway', 502);
  ws.cooldownUntil = Date.now() - 1;
  await pool.acquire().then(a => a.release(), () => {});
  assert.deepEqual(events, [ALERT_EVENTS.CIRCUIT_OPEN, ALERT_EVENTS.CIRCUIT_CLOSE, ALERT_EVENTS.CIRCUIT_OPEN, ALERT_EVENTS.CIRCUIT_CLOSE]);
});

test('standalone probe reports missing config and sanitized send failures', async () => {
  const lines = [];
  assert.equal(await main({ env: {}, log: line => lines.push(line) }), 0);
  assert.equal(await main({ env, fetchImpl: async () => { throw new Error('SECRET'); }, log: line => lines.push(line) }), 1);
  assert.doesNotMatch(lines.join('\n'), /SECRET|test-token|test-chat/);
});
