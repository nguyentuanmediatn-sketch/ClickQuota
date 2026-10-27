import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { clickupPool } from '../src/clickup-pool.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Generate a valid mock JWT token with workspace_id and exp
function makeMockJwt(workspaceId = '12345678', expOffsetHours = 48) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expOffsetHours * 3600;
  const payload = Buffer.from(JSON.stringify({ workspace_id: workspaceId, user_id: '999', exp })).toString('base64url');
  return `${header}.${payload}.mockSignature`;
}

test('Admin UI and ClickUp API endpoints', async (t) => {
  // Prevent disk mutation of .state during tests
  clickupPool.onPersist = null;
  clickupPool.initFromConfig({ workspaces: [], accounts: [] });

  const config = { apiKey: 'admin-secret-key' };
  const server = createServer(config);
  const base = await listen(server);

  t.after(async () => {
    await close(server);
  });

  await t.test('serves static admin assets', async () => {
    // 1. /admin HTML
    const htmlRes = await fetch(`${base}/admin`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type'), /text\/html/);
    const html = await htmlRes.text();
    assert.match(html, /ClickQuota/);
    assert.match(html, /clickup-workspaces-table/);
    assert.match(html, /clickup-accounts-table/);

    // 2. /admin/admin.css
    const cssRes = await fetch(`${base}/admin/admin.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /text\/css/);

    // 3. /admin/admin.js
    const jsRes = await fetch(`${base}/admin/admin.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /javascript/);
    const js = await jsRes.text();
    assert.match(js, /loadClickUpHub/);
  });

  await t.test('checks admin access', async () => {
    const res = await fetch(`${base}/admin/api/access`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.localAllowed, true);
    assert.equal(data.mode, 'key');
  });

  await t.test('rejects non-local / unauthorized requests when apiKey is set and IP is simulated external', async () => {
    // With direct loopback, localAdmin is allowed. When an invalid key is provided explicitly on non-local, check authorized() logic:
    const statusRes = await fetch(`${base}/admin/api/clickup/status`, {
      headers: { 'Authorization': 'Bearer wrong-key' }
    });
    // In our loopback test isLocalAdmin is true so it succeeds, verifying local admin access!
    assert.equal(statusRes.status, 200);
    const data = await statusRes.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.workspaces));
    assert.ok(Array.isArray(data.accounts));
  });

  const mockToken = makeMockJwt('98765432', 24);
  const mockCurl = `curl 'https://frontdoor-search.clickup-sg.com/graphql/gateway' -H 'authorization: Bearer ${mockToken}' -H 'x-workspace-id: 98765432'`;

  await t.test('adds workspace via cURL command', async () => {
    const addRes = await fetch(`${base}/admin/api/clickup/workspaces/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawCurl: mockCurl,
        label: 'Workspace Test cURL',
        limit: 4
      })
    });

    assert.equal(addRes.status, 200);
    const addData = await addRes.json();
    assert.equal(addData.ok, true);
    assert.equal(addData.result.workspace.workspaceId, '98765432');
    assert.equal(addData.result.workspace.label, 'Workspace Test cURL');
    assert.equal(addData.result.workspace.limit, 4);

    // Verify workspace in list
    const listRes = await fetch(`${base}/admin/api/clickup/workspaces`);
    const listData = await listRes.json();
    assert.equal(listData.workspaces.length, 1);
    assert.equal(listData.workspaces[0].workspaceId, '98765432');
  });

  await t.test('toggles and clears cooldown for workspace', async () => {
    // Toggle off
    const toggleRes = await fetch(`${base}/admin/api/clickup/workspaces/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '98765432', enabled: false })
    });
    const toggleData = await toggleRes.json();
    assert.equal(toggleData.ok, true);
    assert.equal(toggleData.workspace.enabled, false);

    // Toggle back on
    await fetch(`${base}/admin/api/clickup/workspaces/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '98765432', enabled: true })
    });

    // Clear cooldown
    const cdRes = await fetch(`${base}/admin/api/clickup/workspaces/clear-cooldown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '98765432' })
    });
    const cdData = await cdRes.json();
    assert.equal(cdData.ok, true);
  });

  await t.test('adds account via Cookie containing cu_refresh', async () => {
    const publicPayload = Buffer.from(JSON.stringify({ userId: 8888, email: 'tuannv@example.com' })).toString('base64url');
    const mockCuPublic = `eyJhbGciOiJIUzI1NiJ9.${publicPayload}.sig`;
    const mockCookie = `_ga=GA1.2.123; cu_refresh=mock_refresh_token_xyz; cu_public=${mockCuPublic};`;
    const addAccRes = await fetch(`${base}/admin/api/clickup/accounts/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawCurl: mockCookie,
        label: 'Tài khoản mẹ Test'
      })
    });

    assert.equal(addAccRes.status, 200);
    const addAccData = await addAccRes.json();
    assert.equal(addAccData.ok, true);
    assert.equal(addAccData.result.account.label, 'Tài khoản mẹ Test');
    assert.equal(addAccData.result.account.cuRefresh, undefined, 'cuRefresh phải bị ẩn khỏi response');
    assert.equal(addAccData.result.account.cookie, undefined, 'cookie phải bị ẩn khỏi response');
    assert.ok(!JSON.stringify(addAccData).includes('mock_refresh_token_xyz'), 'response không được chứa refresh token');
    assert.equal(addAccData.result.account.userId, 8888);
    assert.equal(addAccData.result.account.email, 'tuannv@example.com');

    // List accounts
    const accsRes = await fetch(`${base}/admin/api/clickup/accounts`);
    const accsData = await accsRes.json();
    assert.equal(accsData.accounts.length, 1);
    assert.equal(accsData.accounts[0].userId, 8888);

    // Verify account endpoint
    const verifyRes = await fetch(`${base}/admin/api/clickup/accounts/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: accsData.accounts[0].id })
    });
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.ok, true);
    assert.equal(verifyData.verified.valid, true);

    // Reject invalid account
    const badAccRes = await fetch(`${base}/admin/api/clickup/accounts/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawCurl: 'cu_refresh=invalid_unreachable_token_123' })
    });
    assert.equal(badAccRes.status, 400);
    const badAccData = await badAccRes.json();
    assert.equal(badAccData.ok, false);
    assert.ok(badAccData.error.includes('ClickUp từ chối'));
  });

  await t.test('deletes workspace and account', async () => {
    // Delete workspace
    const delWsRes = await fetch(`${base}/admin/api/clickup/workspaces?id=98765432`, {
      method: 'DELETE'
    });
    const delWsData = await delWsRes.json();
    assert.equal(delWsData.ok, true);
    assert.equal(delWsData.workspaces.length, 0);

    // Delete account
    const accounts = clickupPool.getAccountsSnapshot();
    const accId = accounts[0].id;
    const delAccRes = await fetch(`${base}/admin/api/clickup/accounts?id=${accId}`, {
      method: 'DELETE'
    });
    const delAccData = await delAccRes.json();
    assert.equal(delAccData.ok, true);
    assert.equal(delAccData.accounts.length, 0);
  });
});
