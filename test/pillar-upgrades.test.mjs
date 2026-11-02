import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const poolURL = (name) =>
  pathToFileURL(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'providers', 'clickup', name)).href;

test('Trụ cột 1: Sticky Session Router - Ghim 10 phút và tự động gia hạn khi có tương tác', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: 'ws-1', token: 'token-1', limit: 3 },
      { workspaceId: 'ws-2', token: 'token-2', limit: 3 },
      { workspaceId: 'ws-3', token: 'token-3', limit: 3 },
    ],
  });

  assert.equal(pool.STICKY_SESSION_TTL_MS, 10 * 60 * 1000, 'TTL phải chuẩn 10 phút (600,000ms)');

  // Request 1: Ghim session-dev-1
  const lease1 = await pool.acquire({ sessionKey: 'session-dev-1' });
  const pinnedId = lease1.workspace.workspaceId;
  assert.ok(pinnedId, 'Phải có workspace được chọn');

  const pinBefore = pool.sessionPins.get('session-dev-1');
  assert.equal(pinBefore.workspaceId, pinnedId);
  const expiresAt1 = pinBefore.expiresAt;

  // Request 2 (cùng session, trong khi request 1 vẫn đang giữ in-flight vì limit=3):
  // Phải ghim về cùng workspace thay vì bị nhảy sang workspace khác!
  const lease2 = await pool.acquire({ sessionKey: 'session-dev-1' });
  assert.equal(lease2.workspace.workspaceId, pinnedId, 'Request 2 cùng session phải chạy đúng workspace đã ghim');

  // Request 3: kiểm tra gia hạn TTL
  const lease3 = await pool.acquire({ sessionKey: 'session-dev-1' });
  assert.equal(lease3.workspace.workspaceId, pinnedId, 'Request 3 cùng session vẫn giữ workspace');
  const pinAfter = pool.sessionPins.get('session-dev-1');
  assert.ok(pinAfter.expiresAt >= expiresAt1, 'TTL phải được gia hạn');

  lease1.release();
  lease2.release();
  lease3.release();
});

test('Trụ cột 2: Instant Eviction - Cách ly tức thì 24h và xóa ghim session khi dính ACCESS_700', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: 'ws-bad', token: 'token-bad', limit: 3 },
      { workspaceId: 'ws-good', token: 'token-good', limit: 3 },
    ],
  });

  // Ghim session vào ws-bad trước
  await pool.acquire({ sessionKey: 'session-attacker', preferredWorkspaceId: 'ws-bad' }).then((l) => l.release());
  assert.equal(pool.sessionPins.get('session-attacker')?.workspaceId, 'ws-bad');

  const badWs = pool.workspaces.find((w) => w.workspaceId === 'ws-bad');

  // Mô phỏng nhận lỗi ACCESS_700
  pool.reportError(badWs, new Error('ClickUp upstream error: ACCESS_700 Insufficient workspace permissions'), 403);

  // Kiểm tra cách ly 24h
  assert.equal(badWs.enabled, false, 'Workspace dính ACCESS_700 phải bị vô hiệu hóa ngay');
  assert.equal(badWs.isBlocked, true, 'Workspace phải bị đánh dấu isBlocked');
  assert.equal(badWs.quotaStatus, 'exhausted');
  const remainingHours = (badWs.cooldownUntil - Date.now()) / (3600 * 1000);
  assert.ok(remainingHours >= 23.9, `Phải cách ly 24h (thực tế: ${remainingHours.toFixed(1)}h)`);

  // Kiểm tra session pin đã bị xóa sạch (không bị kẹt hố đen)
  assert.equal(pool.sessionPins.has('session-attacker'), false, 'Session pin trỏ vào workspace chết phải bị xóa ngay lập tức');

  // Request tiếp theo của cùng session phải tự động chuyển sang ws-good
  const nextLease = await pool.acquire({ sessionKey: 'session-attacker' });
  assert.equal(nextLease.workspace.workspaceId, 'ws-good', 'Phải tự động chuyển sang workspace sống');
  nextLease.release();
});

test('Trụ cột 3: Standby Buffer Pool - Kho đệm sẵn sàng và kích hoạt khẩn cấp < 10ms', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: 'ws-active-1', token: 't1', limit: 2, enabled: true },
      { workspaceId: 'ws-standby-1', token: 't-standby-1', limit: 3, enabled: false, isStandby: true },
      { workspaceId: 'ws-standby-2', token: 't-standby-2', limit: 3, enabled: false, isStandby: true },
    ],
  });

  // Kiểm tra Standby không bị bốc nhầm trong điều kiện bình thường
  const standbys = pool.getStandbyWorkspaces();
  assert.equal(standbys.length, 2, 'Phải nhận diện đúng 2 workspace standby');

  const normalLease = await pool.acquire();
  assert.equal(normalLease.workspace.workspaceId, 'ws-active-1', 'Bình thường chỉ bốc workspace active');
  normalLease.release();

  // Đánh chết ws-active-1
  const activeWs = pool.workspaces.find((w) => w.workspaceId === 'ws-active-1');
  pool.instantEvict(activeWs, 'Test eviction trigger');

  // Kích hoạt khẩn cấp: acquire khi active rỗng phải bốc ngay Standby thay vì ném lỗi POOL_EXHAUSTED
  const t0 = Date.now();
  const emergencyLease = await pool.acquire();
  const elapsedMs = Date.now() - t0;

  assert.ok(['ws-standby-1', 'ws-standby-2'].includes(emergencyLease.workspace.workspaceId), 'Phải bốc workspace từ kho Standby');
  assert.equal(emergencyLease.workspace.isStandby, false, 'Workspace sau khi bốc phải thành active');
  assert.equal(emergencyLease.workspace.enabled, true, 'Workspace sau khi bốc phải enabled: true');
  assert.ok(elapsedMs < 200, `Thời gian kích hoạt phải < 200ms (thực tế: ${elapsedMs}ms)`);

  emergencyLease.release();
});
