import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const poolURL = (name) =>
  pathToFileURL(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'providers', 'clickup', name)).href;

test('Session affinity: cùng sessionKey ghim về cùng workspace khi pool rảnh', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: '101', token: 't1', limit: 3 },
      { workspaceId: '102', token: 't2', limit: 3 },
      { workspaceId: '103', token: 't3', limit: 3 },
    ],
  });

  const picks = [];
  for (let i = 0; i < 4; i++) {
    const lease = await pool.acquire({ sessionKey: 'conv-A' });
    picks.push(lease.workspace.workspaceId);
    lease.release();
  }
  assert.equal(
    new Set(picks).size,
    1,
    `Cùng hội thoại phải quay lại cùng workspace (thực tế: ${picks.join(' -> ')})`,
  );

  // Session khác vẫn acquire bình thường (không xung đột với pin của conv-A)
  const leaseB = await pool.acquire({ sessionKey: 'conv-B' });
  assert.ok(leaseB.workspace.workspaceId);
  leaseB.release();
});

test('Session affinity: workspace ghim đang bận thì session rơi sang workspace khác (ưu tiên tốc độ)', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: '101', token: 't1', limit: 1 },
      { workspaceId: '102', token: 't2', limit: 3 },
    ],
  });

  const first = await pool.acquire({ sessionKey: 'conv-C' });
  const pinned = first.workspace.workspaceId;
  assert.equal(first.workspace.activeRequests, 1, '_bindWorkspace phải tăng in-flight');

  // Workspace đang ghim có 1 in-flight (đầy với limit=1) → request tiếp theo của
  // CÙNG hội thoại phải sang workspace khác thay vì đợi
  const second = await pool.acquire({ sessionKey: 'conv-C' });
  assert.notEqual(second.workspace.workspaceId, pinned, 'Không được đợi workspace đang bận');
  // Session được ghim lại theo nơi thực sự phục vụ
  assert.equal(pool.sessionPins.get('conv-C').workspaceId, second.workspace.workspaceId);

  first.release();
  second.release();
});

test('Preferred workspace (header x-workspace-id) ưu tiên hơn session pin', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [
      { workspaceId: '101', token: 't1', limit: 3 },
      { workspaceId: '102', token: 't2', limit: 3 },
    ],
  });

  // Ghim conv về 101
  const first = await pool.acquire({ sessionKey: 'conv-D' });
  const pinnedId = first.workspace.workspaceId;
  first.release();

  // Request có preferredWorkspaceId khác pin → preferred thắng (lệnh tường minh của operator)
  const forced = await pool.acquire({ sessionKey: 'conv-D', preferredWorkspaceId: pinnedId === '101' ? '102' : '101' });
  const expected = pinnedId === '101' ? '102' : '101';
  assert.equal(forced.workspace.workspaceId, expected);
  forced.release();
});

test('Defaults self-heal: defaults.workspaceId trỏ workspace không tồn tại bị bỏ qua', async () => {
  const { WorkspacePool } = await import(poolURL('pool.mjs'));
  const pool = new WorkspacePool();
  pool.initFromConfig({
    workspaces: [{ workspaceId: '101', token: 't1' }],
    defaults: { workspaceId: '1100380000020899' },
  });
  assert.equal(pool.defaults.workspaceId, '');
  assert.ok(pool.sessionPins instanceof Map);
});
