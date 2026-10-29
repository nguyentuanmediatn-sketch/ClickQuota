import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sourceURL = name => pathToFileURL(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', name)).href;
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('Standalone with loopback mock upstream', async t => {
  let mode = 'text';
  let calls = [];
  let origin;
  const mock = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/access-token')) return res.end(JSON.stringify({ accessToken: 'mock-gateway', origin, expiresIn: 300 }));
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push(body);
    if (body.query.includes('GetAIEntitlements')) return res.end(JSON.stringify({ data: { daily: { limit: 100, usage: 25, usageLeft: 75 }, weekly: { limit: 500, usage: 25, usageLeft: 475 }, checkFairUseBlocked: { blocked: false } } }));
    if (mode === 'http-error') { res.statusCode = 503; return res.end('{}'); }
    if (mode === 'quota' && body.variables.input.workspaceId === 'one') return res.end(JSON.stringify({ data: { aiRequest: { errors: [{ code: 'USAGE_QUOTA_EXCEEDED' }] } } }));
    const completionString = mode === 'tool' ? JSON.stringify({ tool_calls: [{ name: 'Read', arguments: { file_path: 'README.md' } }] }) : mode === 'empty' ? '' : 'Hello from mock';
    res.end(JSON.stringify({ data: { aiRequest: { completionString, errors: [] } } }));
  });
  origin = await listen(mock);
  t.after(async function () { await close(mock); });
  process.env.CLICKUP_API_BASE = origin;
  process.env.CLICKUP_ID_BASE = origin;
  // Gateway production chạy trên cùng máy (src/index.mjs) tự làm mới token workspace
  // và ghi vào <APP_ROOT>/.state/clickup_config.json. Nếu test canh đúng file đó thì
  // assertion "state không bị ghi" sẽ fail ngẫu nhiên theo lịch refresh token, chứ
  // không phản ánh lỗi của code đang test. Cô lập sang state dir riêng của test.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'clickquota-state-'));
  process.env.CLICKQUOTA_STATE_DIR = stateDir;
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const { clickupPool, WorkspacePool } = await import(sourceURL('clickup-pool.mjs'));
  const { createServer } = await import(sourceURL('server.mjs'));
  const { executePooledUpstream } = await import(sourceURL('clickup-upstream.mjs'));
  const { STATE_FILE, STATE_DIR, loadConfig } = await import(sourceURL('config.mjs'));
  // Fixture cố định: test chỉ cần khẳng định không có ghi ngoài ý muốn, nội dung là gì không quan trọng.
  writeFileSync(STATE_FILE, JSON.stringify({ workspaces: [], accounts: [] }, null, 2));
  const originalState = readFileSync(STATE_FILE, 'utf8');
  clickupPool.onPersist = null;
  const server = createServer({ apiKey: 'test-key' });
  const base = await listen(server);
  t.after(async () => { await close(server); });
  const reset = (ids = ['one']) => {
    clickupPool.initFromConfig({ workspaces: ids.map(workspaceId => ({ workspaceId, token: 'mock-session', limit: 2 })) });
    calls = []; mode = 'text';
  };
  const message = { model: 'gpt-6-luna-CL', messages: [{ role: 'user', content: 'Hello' }] };
  const request = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' }, body: JSON.stringify(body) });
  await t.test('health, auth, models and unsupported routes', async () => {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer test-key' } });
    assert.ok((await r.json()).data.every(m => m.owned_by === 'clickup'));
    assert.equal((await request('/v1/not-supported', message)).status, 404);
  });
  await t.test('validation and missing configuration', async () => {
    clickupPool.initFromConfig({});
    assert.equal((await request('/v1/messages', message)).status, 503);
    assert.equal((await request('/v1/messages', {})).status, 400);
    assert.equal((await request('/v1/responses', { model: 'gpt-6-luna-CL', input: 'Hello' })).status, 503);
    assert.equal((await request('/v1/responses', {})).status, 400);
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: '{' });
    assert.equal(r.status, 400);
  });
  for (const route of ['/v1/messages', '/v1/chat/completions']) {
    await t.test(route + ' JSON response', async () => {
      reset();
      const r = await request(route, message);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(route.includes('messages') ? body.content[0].text : body.choices[0].message.content, 'Hello from mock');
      // Alias table cố ý ép mọi model Claude/GPT về 'claude-opus-5-5' (Universal Tier 1
      // Tool-Calling Engine — xem resolveClickUpModel trong clickup-upstream.mjs).
      assert.equal(calls[0].variables.input.model, 'claude-opus-5-5');
    });
    await t.test(route + ' SSE tools', async () => {
      reset(); mode = 'tool';
      const body = Object.assign({}, message, { stream: true, tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }] });
      const r = await request(route, body);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      const text = await r.text();
      assert.match(text, route.includes('messages') ? /input_json_delta/ : /tool_calls/);
      assert.match(text, route.includes('messages') ? /message_stop/ : /\[DONE\]/);
    });
  }
  await t.test('/v1/responses JSON response', async () => {
    reset();
    const r = await request('/v1/responses', {
      model: 'gpt-6-luna-CL',
      instructions: [{ type: 'input_text', text: 'Be concise.' }],
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      max_output_tokens: 128,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.output[0].content[0].text, 'Hello from mock');
    assert.equal(calls[0].variables.input.maxTokens, 128);
    assert.match(calls[0].variables.input.messages.at(-1).content, /Hello/);
  });
  await t.test('/v1/responses SSE tools', async () => {
    reset(); mode = 'tool';
    const r = await request('/v1/responses', {
      model: 'gpt-6-luna-CL',
      stream: true,
      input: 'Read the README.',
      tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.function_call_arguments\.delta/);
    assert.match(text, /event: response\.output_item\.done/);
    assert.match(text, /event: response\.completed/);
    assert.doesNotMatch(text, /chat\.completion\.chunk/);
  });
  await t.test('Anthropic system content blocks are normalized', async () => {
    reset();
    const r = await request('/v1/messages', {
      model: 'gpt-6-luna-CL',
      max_tokens: 128,
      system: [{ type: 'text', text: 'Answer concisely.' }],
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(r.status, 200);
    assert.match(calls[0].variables.input.messages[0].content, /Answer concisely/);
  });
  await t.test('quota failover to configured workspace', async () => {
    reset(['one', 'two']); mode = 'quota';
    assert.equal((await request('/v1/chat/completions', message)).status, 200);
    assert.equal(clickupPool.workspaces[0].quotaStatus, 'exhausted');
    assert.equal(calls.at(-1).variables.input.workspaceId, 'two');
    assert.ok(clickupPool.workspaces.every(w => w.activeRequests === 0));
  });
  await t.test('HTTP errors and empty completions are failures', async () => {
    reset(); mode = 'http-error';
    assert.equal((await request('/v1/chat/completions', message)).status, 502);
    reset(); mode = 'empty';
    assert.equal((await request('/v1/chat/completions', message)).status, 502);
  });
  await t.test('quota and status omit credentials', async () => {
    reset();
    const r = await request('/api/quota/refresh', {});
    assert.equal((await r.json()).workspaces[0].quota.dailyLeft, 75);
    const status = await fetch(base + '/api/status', { headers: { 'x-api-key': 'test-key' } });
    assert.doesNotMatch(await status.text(), /mock-session|mock-gateway/);
  });
  await t.test('abort before dispatch', async () => {
    reset();
    await assert.rejects(executePooledUpstream({ payload: {}, signal: AbortSignal.abort() }));
    assert.equal(calls.length, 0);
  });
  await t.test('respect cooldown and auto-recreation capabilities', async () => {
    const pool = new WorkspacePool({ workspaces: [{ workspaceId: 'x', token: 'fake', quotaStatus: 'exhausted', cooldownUntil: Date.now() + 60000 }] });
    await assert.rejects(pool.acquire(), /cạn Quota ngày hoặc đang cooldown/);
    assert.ok(pool.workspaces[0].cooldownUntil > Date.now(), 'cooldown không được bị xóa cưỡng bức khi acquire thất bại');
    assert.equal(typeof pool.autoRecreateWorkspaces, 'function');
    assert.equal(typeof pool._checkAndTriggerAutoRecreate, 'function');
  });
  await t.test('isolated state and config validation', () => {
    // CLICKQUOTA_STATE_DIR phải thực sự chuyển hướng state ra khỏi APP_ROOT,
    // nếu không test sẽ lại giẫm lên file của gateway production.
    assert.equal(STATE_DIR, stateDir);
    assert.equal(STATE_FILE, path.join(stateDir, 'clickup_config.json'));
    assert.equal(readFileSync(STATE_FILE, 'utf8'), originalState);
    assert.throws(() => loadConfig({ CLICKQUOTA_HOST: '0.0.0.0' }), /API_KEY/);
    assert.throws(() => loadConfig({ CLICKQUOTA_PORT: 'oops' }), /PORT/);
  });
});
