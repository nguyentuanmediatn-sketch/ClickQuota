import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

const sourceURL = (name) =>
  pathToFileURL(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', name)).href;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function createMockJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mock-signature`;
}

test('Multi-Account Ingestion, x2 Quota Auto-Recreate, and Load Balancing', async (t) => {
  const { WorkspacePool } = await import(sourceURL('clickup-pool.mjs'));

  await t.test('1. Account Parsing: ho tro nhap chi Cookie hoac cURL va trich xuat toan dien', () => {
    const pool = new WorkspacePool();

    // Case A: Chỉ chuỗi Cookie thuần túy
    const cookieRaw =
      'cu_public=' +
      createMockJwt({ email: 'user1@example.com', userId: 1111, default_team: 9001 }) +
      '; cu_refresh=' +
      createMockJwt({ user: 1111, workspace_id: 9001 });

    const parsedA = pool.parseAccountFromCurlOrCookie(cookieRaw);
    assert.ok(parsedA, 'Phải parse được chuỗi cookie');
    assert.equal(parsedA.email, 'user1@example.com');
    assert.equal(parsedA.userId, 1111);
    assert.equal(parsedA.workspaceId, '9001');
    assert.ok(parsedA.cuRefresh.length > 10);

    // Case B: Chuỗi cURL từ trình duyệt
    const curlRaw = `curl 'https://frontdoor-prod-ap-southeast-1-1.clickup.com/user/v1/user' \\
      -H 'authority: frontdoor-prod-ap-southeast-1-1.clickup.com' \\
      -H 'authorization: Bearer ${createMockJwt({ user: 2222, workspace_id: 9002 })}' \\
      -H 'x-workspace-id: 9002' \\
      -H 'cookie: cu_public=${createMockJwt({ email: 'user2@corp.io', userId: 2222 })}; cu_refresh=rt-token-2222' \\
      --compressed`;

    const parsedB = pool.parseAccountFromCurlOrCookie(curlRaw);
    assert.ok(parsedB, 'Phải parse được chuỗi cURL');
    assert.equal(parsedB.email, 'user2@corp.io');
    assert.equal(parsedB.userId, 2222);
    assert.equal(parsedB.workspaceId, '9002');
    assert.ok(parsedB.initialToken);
    assert.equal(parsedB.cuRefresh, 'rt-token-2222');
  });

  await t.test('2. Multi-tier Load Balancer: Phan bo deu, xoay vong Round-Robin va can bang tai da tai khoan', async () => {
    const pool = new WorkspacePool();

    // Giả lập 4 Workspaces thuộc 2 Tài khoản Mẹ khác nhau
    // Acc 1: WS 101, WS 102
    // Acc 2: WS 201, WS 202
    pool.accounts = [
      { id: 'acc-1', email: 'acc1@test.com', enabled: true },
      { id: 'acc-2', email: 'acc2@test.com', enabled: true },
    ];

    pool.initFromConfig({
      workspaces: [
        { workspaceId: '101', accountId: 'acc-1', token: 'tok-101', limit: 2, label: 'WS-101' },
        { workspaceId: '102', accountId: 'acc-1', token: 'tok-102', limit: 2, label: 'WS-102' },
        { workspaceId: '201', accountId: 'acc-2', token: 'tok-201', limit: 2, label: 'WS-201' },
        { workspaceId: '202', accountId: 'acc-2', token: 'tok-202', limit: 2, label: 'WS-202' },
      ],
    });

    assert.equal(pool.workspaces.length, 4);

    // Kịch bản A: Các request tuần tự (sequential requests)
    // Phải xoay vòng qua các workspace khác nhau và luân phiên giữa 2 tài khoản mẹ, không dồn vào 1 WS
    const acquiredIds = [];
    for (let i = 0; i < 4; i++) {
      const lease = await pool.acquire();
      acquiredIds.push(lease.workspace.workspaceId);
      lease.release();
    }

    // Xác nhận cả 4 workspace đều được sử dụng, không workspace nào bị bỏ rơi
    const uniqueAcquired = new Set(acquiredIds);
    assert.equal(uniqueAcquired.size, 4, `Cả 4 workspace phải được xoay vòng đều (Thực tế: ${acquiredIds.join(' -> ')})`);

    // Kịch bản B: Khả năng điều hướng khi 1 Workspace đang bận (In-Flight Concurrency)
    // Giữ kết nối trên WS 101
    const lease101 = await pool.acquire({ preferredWorkspaceId: '101' });
    assert.equal(lease101.workspace.workspaceId, '101');
    assert.equal(lease101.workspace.activeRequests, 1);

    // Yêu cầu tiếp theo phải tự động chọn workspace rảnh (khác 101)
    const nextLease = await pool.acquire();
    assert.notEqual(nextLease.workspace.workspaceId, '101', 'Không được dồn tải vào workspace đang có in-flight request');
    assert.equal(nextLease.workspace.activeRequests, 1);

    lease101.release();
    nextLease.release();
    assert.equal(pool.workspaces.find((w) => w.workspaceId === '101').activeRequests, 0);
  });

  await t.test('3. Auto-Recreate với 2 Cookie Tài khoản Mẹ: Tu dong x2 so luong workspace va kich MAX 23', async () => {
    let teamCounter = 1000;
    const createdTeams = [];
    const trialActivatedTeams = [];

    // Tạo server mock ClickUp Upstream
    const mockClickUp = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');

      let body = '';
      for await (const chunk of req) body += chunk;

      // Mock User Inventory
      if (req.url.includes('/user/v1/user') || req.url.includes('/v1/user')) {
        return res.end(
          JSON.stringify({
            user: { id: 7777, email: 'master@clickup.local' },
            teams: [
              { id: 'primary-base-team', name: 'My Primary Workspace', owner: { id: 7777 } },
            ],
          })
        );
      }

      // Mock Token Minting từ id.app.clickup.com
      if (req.url.includes('/authentication/access_tokens')) {
        const teamMatch = req.url.match(/workspaces\/([^/]+)/);
        const wsId = teamMatch ? teamMatch[1] : 'ws-mock';
        return res.end(
          JSON.stringify({
            token: createMockJwt({ user: 7777, workspace_id: wsId }),
            expiration: Math.floor(Date.now() / 1000) + 86400,
          })
        );
      }

      // Mock Create Workspace
      if (req.url.includes('/team/v1/team') && req.method === 'POST') {
        teamCounter++;
        const newTeamId = `team-${teamCounter}`;
        createdTeams.push(newTeamId);
        return res.end(JSON.stringify({ id: newTeamId, name: `Workspace ${teamCounter}` }));
      }

      // Mock Trial Availability
      if (req.url.includes('/trialAvailability')) {
        return res.end(JSON.stringify({ availability: { Max: true } }));
      }

      // Mock Trial Activation (Plan 23)
      if (req.url.includes('/plan/v2/team/') && req.url.includes('/trial')) {
        const teamMatch = req.url.match(/\/team\/([^/]+)\/trial/);
        const wsId = teamMatch ? teamMatch[1] : 'ws';
        trialActivatedTeams.push(wsId);
        return res.end(JSON.stringify({ plan_id: 23, status: 'active' }));
      }

      // Mock Quota Gateway / Entitlements
      if (req.url.includes('/access-token')) {
        return res.end(JSON.stringify({ accessToken: 'mock-gw', origin: mockOrigin, expiresIn: 300 }));
      }
      if (req.url.includes('/gateway')) {
        return res.end(
          JSON.stringify({
            data: {
              daily: { limit: 100, usage: 0, usageLeft: 100 },
              weekly: { limit: 2400, usage: 0, usageLeft: 2400 },
              checkFairUseBlocked: { blocked: false },
            },
          })
        );
      }

      res.statusCode = 404;
      res.end('{}');
    });

    const mockOrigin = await listen(mockClickUp);
    t.after(async () => await close(mockClickUp));

    process.env.CLICKUP_API_BASE = mockOrigin;
    process.env.CLICKUP_ID_BASE = mockOrigin;

    // Giả lập hệ thống ban đầu CHƯA CÓ BẤT KỲ WORKSPACE NÀO
    const pool = new WorkspacePool();
    pool.workspaces = [];
    pool.accounts = [];

    // Người dùng thêm 2 cookie tài khoản mẹ
    await pool.addAccount({
      email: 'acc1@corp.vn',
      cookie: 'cu_refresh=' + createMockJwt({ user: 1001, workspace_id: 8881 }) + '; cu_public=' + createMockJwt({ email: 'acc1@corp.vn', userId: 1001, default_team: 8881 }),
    });

    await pool.addAccount({
      email: 'acc2@corp.vn',
      cookie: 'cu_refresh=' + createMockJwt({ user: 1002, workspace_id: 8882 }) + '; cu_public=' + createMockJwt({ email: 'acc2@corp.vn', userId: 1002, default_team: 8882 }),
    });

    assert.equal(pool.accounts.length, 2, 'Phải có 2 tài khoản mẹ');
    assert.equal(pool.workspaces.length, 0, 'Ban đầu chưa có workspace nào');

    // Kích hoạt auto recreate pool (mỗi tài khoản tạo 3 workspaces -> tổng 6 workspaces = x2)
    const result = await pool.autoRecreateWorkspaces({ countPerAccount: 3, reason: 'test-x2' });

    assert.equal(result.createdCount, 6, '2 tài khoản x 3 workspace = 6 workspaces mới');
    assert.equal(pool.workspaces.length, 6, 'Pool phải có đầy đủ 6 workspaces');

    // Xác nhận tất cả workspace tạo mới đều được kích hoạt Trial MAX Plan 23
    assert.equal(trialActivatedTeams.length, 6, 'Tất cả 6 workspace đều phải được gửi request kích hoạt Trial MAX 23');

    // Xác nhận phân bổ thuộc về 2 tài khoản
    const acc1Ws = pool.workspaces.filter((w) => w.accountId === pool.accounts[0].id);
    const acc2Ws = pool.workspaces.filter((w) => w.accountId === pool.accounts[1].id);
    assert.equal(acc1Ws.length, 3, 'Tài khoản 1 có 3 workspaces');
    assert.equal(acc2Ws.length, 3, 'Tài khoản 2 có 3 workspaces');
  });
});
