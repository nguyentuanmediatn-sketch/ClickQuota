import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 2026-10-28: phủ gate SAFETY P1-6 — Auto-Recreate KHÔNG được kích hoạt từ dữ liệu
// quota stale (audit lỗi / chưa audit). Đây là logic xóa workspace THẬT nên phải có
// test khóa hành vi: chỉ dữ liệu MỚI (<30 phút) mới đủ căn cứ trigger.

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceURL = (name) => pathToFileURL(path.join(projectRoot, 'src', name)).href;

// Trỏ API bases về loopback:9 TRƯỚC khi import pool để mọi probe mạng fail nhanh
// trong sandbox và không bao giờ chạm ClickUp thật.
process.env.CLICKUP_API_BASE = 'http://127.0.0.1:9';
process.env.CLICKUP_ID_BASE = 'http://127.0.0.1:9';

function makePool(WorkspacePool, workspaces) {
  const pool = new WorkspacePool({ workspaces, accounts: [] }, null);
  let recreateCalls = 0;
  pool.autoRecreateWorkspaces = async () => {
    recreateCalls += 1;
    return { ok: true };
  };
  return { pool, getRecreateCalls: () => recreateCalls };
}

test('auto-recreate gate: stale quota (>30 phút) không đủ căn cứ trigger', () => {
  return import(sourceURL('providers/clickup/pool.mjs')).then(({ WorkspacePool }) => {
    const stale = Date.now() - 60 * 60 * 1000; // 1 giờ trước
    const { pool, getRecreateCalls } = makePool(WorkspacePool, [
      { workspaceId: '111', token: 't1', enabled: true, quotaStatus: 'exhausted', quota: { isBlocked: true, lastCheckedAt: stale } },
    ]);
    pool._checkAndTriggerAutoRecreate({ reason: 'test' });
    assert.equal(getRecreateCalls(), 0, 'dữ liệu stale phải bị từ chối trigger');
  });
});

test('auto-recreate gate: quota fresh + exhausted → trigger đúng 1 lần', () => {
  return import(sourceURL('providers/clickup/pool.mjs')).then(({ WorkspacePool }) => {
    const fresh = Date.now() - 60 * 1000; // 1 phút trước
    const { pool, getRecreateCalls } = makePool(WorkspacePool, [
      { workspaceId: '222', token: 't2', enabled: true, quotaStatus: 'exhausted', quota: { isBlocked: true, lastCheckedAt: fresh } },
      { workspaceId: '333', token: 't3', enabled: true, quotaStatus: 'exhausted', quota: { isBlocked: true, lastCheckedAt: fresh } },
    ]);
    pool._checkAndTriggerAutoRecreate({ reason: 'test' });
    assert.equal(getRecreateCalls(), 1);
    // Throttle 10 phút: gọi lại ngay phải bị chặn
    pool._checkAndTriggerAutoRecreate({ reason: 'test-again' });
    assert.equal(getRecreateCalls(), 1, 'throttle 10 phút phải chặn trigger lặp');
  });
});

test('auto-recreate gate: pool rỗng hoặc ws healthy không trigger', () => {
  return import(sourceURL('providers/clickup/pool.mjs')).then(({ WorkspacePool }) => {
    const fresh = Date.now() - 60 * 1000;
    const empty = makePool(WorkspacePool, []);
    empty.pool._checkAndTriggerAutoRecreate({ reason: 'test' });
    assert.equal(empty.getRecreateCalls(), 0, 'pool rỗng không được trigger');

    const healthy = makePool(WorkspacePool, [
      { workspaceId: '444', token: 't4', enabled: true, quotaStatus: 'available', quota: { isBlocked: false, lastCheckedAt: fresh } },
    ]);
    healthy.pool._checkAndTriggerAutoRecreate({ reason: 'test' });
    assert.equal(healthy.getRecreateCalls(), 0, 'ws healthy không được trigger');
  });
});
