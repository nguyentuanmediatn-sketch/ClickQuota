/**
 * STRESS BENCHMARK HARNESS — The Long-Horizon Streaming Agentic Benchmark
 * (2026-10-29, Master Directive: Real-time Streaming Engine + Anti-Lazy + Native Tool-Calling)
 *
 * Mỗi model trong CLICKUP_MODELS × 2 giao thức (OpenAI /v1/chat/completions, Anthropic
 * /v1/messages) × 2 chế độ (stream/non-stream) chạy đủ 5 bước:
 *   B1 Streaming Discovery & Parallel Tool Calls  — SSE chunks chuẩn, zero tag leak
 *   B2 Long-Context Injection                     — tool_result lớn, needle đầu/giữa/cuối
 *   B3 Anti-Lazy Promise Trap                     — Seamless Continuation, cap 1 follow-up
 *   B4 Error Recovery Loop                        — tool result is_error → call sửa lỗi
 *   B5 Final Context Verification                 — tổng hợp đủ 3 needle
 *
 * Toàn bộ chạy trên mock upstream loopback (zero-trust, không đụng ClickUp thật).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceURL = (name) => pathToFileURL(path.join(projectRoot, 'src', name)).href;

const TASK = 'Work through the long-horizon agentic benchmark using the available tools.';

function makeTools() {
  return [
    { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'Read', description: 'Read file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } },
    { type: 'function', function: { name: 'Write', description: 'Write file', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } } },
  ];
}

const NEEDLE_ALPHA = 'NEEDLE-ALPHA-7719';
const NEEDLE_BETA = 'NEEDLE-BETA-4430';
const NEEDLE_GAMMA = 'NEEDLE-GAMMA-9913';

/* Mock upstream: quyết định completionString theo nội dung prompt gateway gửi lên. */
function mockReplyFor(rawBodyText, state) {
  const text = String(rawBodyText || '');
  if (text.includes('[CONTINUATION]')) {
    state.continuations += 1;
    return `<tool_call>{"name": "Bash", "arguments": {"command": "echo continuation-ok"}}</tool_call>`;
  }
  if (text.includes('STAGE-FINAL') && text.includes(NEEDLE_ALPHA) && text.includes(NEEDLE_BETA) && text.includes(NEEDLE_GAMMA)) {
    return `FINAL-CONTEXT-OK: ${NEEDLE_ALPHA} + ${NEEDLE_BETA} + ${NEEDLE_GAMMA}`;
  }
  if (text.includes('STAGE-FINAL')) return 'FINAL-MISSING-NEEDLES';
  if (text.includes('STAGE-ERROR') && text.includes('ERROR-SENTINEL-42')) {
    return `<tool_call>{"name": "Bash", "arguments": {"command": "echo recovery-ok"}}</tool_call>`;
  }
  if (text.includes('STAGE-LAZY') && !text.includes('[CONTINUATION]')) {
    return 'Tôi sẽ kiểm tra ngay bây giờ.';
  }
  if (text.includes('STAGE-DISCOVERY')) {
    return '{"tool_calls": [{"name": "Read", "arguments": {"filePath": "alpha.js"}}, {"name": "Read", "arguments": {"filePath": "beta.js"}}]}';
  }
  return 'ok';
}

function createHarness() {
  const state = { upstreamCalls: 0, continuations: 0, origin: 'http://127.0.0.1', lastPromptLens: [] };
  const mock = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/access-token')) {
      /* origin PHẢI mang port của mock — gateway build GraphQL URL từ origin này. */
      res.end(JSON.stringify({ accessToken: 'bench-gateway', origin: state.origin, expiresIn: 300 }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBodyText = Buffer.concat(chunks).toString('utf8');
    if (rawBodyText.includes('GetAIEntitlements')) {
      res.end(JSON.stringify({ data: { daily: { limit: 100, usage: 0, usageLeft: 100 }, weekly: { limit: 500, usage: 0, usageLeft: 500 }, checkFairUseBlocked: { blocked: false } } }));
      return;
    }
    state.upstreamCalls += 1;
    state.lastPromptLens.push(rawBodyText.length);
    res.end(JSON.stringify({ data: { aiRequest: { completionString: mockReplyFor(rawBodyText, state), reasoning: null, errors: null } } }));
  });
  return { mock, state };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/* ---- SSE client parsers (chuẩn client OpenAI/Anthropic) ---- */
function parseOpenAiSse(text) {
  const events = text.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.ok(events[events.length - 1] === '[DONE]', 'OpenAI stream phải kết thúc bằng [DONE]');
  const parsed = events.slice(0, -1).map((d) => JSON.parse(d));
  const callsByIndex = new Map();
  let content = '';
  let finishReason = null;
  for (const ev of parsed) {
    const choice = ev.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (choice?.delta?.content) content += choice.delta.content;
    for (const tc of choice?.delta?.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!callsByIndex.has(idx)) callsByIndex.set(idx, { id: tc.id || null, name: tc.function?.name || null, args: '' });
      if (tc.function?.name) callsByIndex.get(idx).name = tc.function.name;
      if (tc.function?.arguments) callsByIndex.get(idx).args += tc.function.arguments;
    }
  }
  const calls = [...callsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([idx, c]) => ({
    index: idx, id: c.id, name: c.name, input: JSON.parse(c.args || '{}'),
  }));
  return { calls, content, finishReason };
}

function parseAnthropicSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let eventName = null;
    let data = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      if (line.startsWith('data: ')) data = JSON.parse(line.slice(6));
    }
    if (data) events.push({ eventName, ...data });
  }
  const names = events.map((e) => e.eventName || e.type);
  assert.ok(names[0] === 'message_start', 'Anthropic stream phải mở đầu bằng message_start');
  assert.ok(names[names.length - 1] === 'message_stop', 'Anthropic stream phải kết thúc bằng message_stop');
  assert.ok(names.includes('message_delta'), 'thiếu message_delta');
  const callsByIndex = new Map();
  let textContent = '';
  let stopReason = null;
  for (const ev of events) {
    if (ev.eventName === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      callsByIndex.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
    }
    if (ev.eventName === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
      const call = callsByIndex.get(ev.index);
      if (call) call.json += ev.delta.partial_json || '';
    }
    if (ev.eventName === 'content_block_delta' && ev.delta?.type === 'text_delta') textContent += ev.delta.text || '';
    if (ev.eventName === 'message_delta') stopReason = ev.delta?.stop_reason || stopReason;
  }
  const calls = [...callsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => ({
    index, id: c.id, name: c.name, input: JSON.parse(c.json || '{}'),
  }));
  /* partial_json ghép lại phải là JSON hợp lệ — tuyệt đối không lỗi cú pháp */
  for (const call of calls) {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(call.input)), 'input_json_delta ghép lại phải là JSON hợp lệ');
  }
  if (process.env.BENCH_DEBUG && stopReason === undefined) {
    console.error('[BENCH DEBUG] eventNames=' + JSON.stringify(names));
  }
  return { calls, content: textContent, stopReason, eventNames: names };
}

/* ---- Gateway request helpers ---- */
function buildBody(protocol, model, stream, messages, extra = {}) {
  if (protocol === 'openai') {
    return { model, stream, messages, ...extra };
  }
  return { model, stream, messages, max_tokens: 2048, ...extra };
}

async function callGateway(base, protocol, model, stream, messages, extra = {}) {
  const route = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages';
  const res = await fetch(base + route + '?flush=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'bench-key' },
    body: JSON.stringify(buildBody(protocol, model, stream, messages, extra)),
  });
  assert.equal(res.status, 200, `gateway phải trả 200 (nhận ${res.status})`);
  if (!stream) {
    const json = await res.json();
    if (protocol === 'openai') {
      const msg = json.choices?.[0]?.message || {};
      const calls = (msg.tool_calls || []).map((tc) => ({ name: tc.function?.name, input: JSON.parse(tc.function?.arguments || '{}') }));
      return { calls, content: typeof msg.content === 'string' ? msg.content : '', finishReason: json.choices?.[0]?.finish_reason };
    }
    const calls = (json.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input || {} }));
    const content = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { calls, content, finishReason: json.stop_reason };
  }
  const raw = await res.text();
  const parsed = protocol === 'openai' ? parseOpenAiSse(raw) : parseAnthropicSse(raw);
  /* Chuẩn hóa key: parseAnthropicSse trả stopReason — map về finishReason cho assert chung. */
  const result = { ...parsed, finishReason: parsed.finishReason ?? parsed.stopReason };
  if (process.env.BENCH_DEBUG && protocol !== 'openai' && !result.finishReason) {
    console.error('[BENCH RAW] finishReason=' + JSON.stringify(result.finishReason) + ' raw=' + raw.slice(0, 900).replace(/\n/g, '\\n'));
  }
  return result;
}

/* ---- 5 bước benchmark cho 1 (model, protocol, mode) ---- */
async function runBenchmark(base, model, protocol, stream) {
  const tools = makeTools();
  const label = `${model} ${protocol} ${stream ? 'stream' : 'non-stream'}`;

  /* B1 — Streaming Discovery & Parallel Tool Calls */
  const b1 = await callGateway(base, protocol, model, stream, [{ role: 'user', content: 'STAGE-DISCOVERY: find and read alpha.js and beta.js' }], { tools });
  assert.equal(b1.calls.length, 2, `${label} B1: phải có 2 parallel tool calls (nhận ${b1.calls.length})`);
  b1.calls.forEach((call, idx) => {
    if (stream) assert.equal(call.index, idx, `${label} B1: stream index phải tăng dần`);
    assert.ok(call.name === 'Read', `${label} B1: tên tool sai`);
    assert.ok(call.input && typeof call.input === 'object' && Object.keys(call.input).length > 0, `${label} B1: arguments phải là JSON hoàn chỉnh`);
  });
  assert.equal(b1.finishReason, protocol === 'openai' ? 'tool_calls' : 'tool_use', `${label} B1: finish/stop reason`);
  if (protocol === 'openai' && stream) {
    assert.ok(!/["<]?\s*(tool_call|invoke)\b/i.test(b1.content), `${label} B1: tag markup không được rò rỉ vào content`);
  }
  if (protocol === 'anthropic' && stream) {
    assert.ok(!b1.content.includes('<tool_call') && !b1.content.includes('"tool_calls"'), `${label} B1: zero tag leak (anthropic)`);
  }

  /* B2 — Long-Context Injection (needle đầu / giữa / cuối) */
  const bigToolResult = `${NEEDLE_BETA}\n${'filler-line\n'.repeat(400)}${NEEDLE_GAMMA}`;
  const longMessages = [
    { role: 'user', content: `STAGE-FINAL context check. First needle: ${NEEDLE_ALPHA}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b2', name: 'Bash', input: { command: 'cat big.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b2', content: bigToolResult }] },
    { role: 'user', content: 'STAGE-FINAL: verify all three needles' },
  ];
  const b2 = await callGateway(base, protocol, model, stream, longMessages, { tools });
  assert.ok(b2.content.includes('FINAL-CONTEXT-OK'), `${label} B2: mock phải nhận đủ needle (nhận: ${b2.content.slice(0, 80)})`);

  /* B3 — Anti-Lazy Promise Trap (Seamless Continuation, cap 1) */
  stateRef.upstreamCalls = 0;
  stateRef.continuations = 0;
  const b3 = await callGateway(base, protocol, model, stream, [{ role: 'user', content: 'STAGE-LAZY: do the complex multi-step task now' }], { tools });
  assert.equal(b3.calls.length, 1, `${label} B3: continuation phải sinh tool call thật từ lượt ngầm`);
  assert.equal(b3.calls[0].name, 'Bash', `${label} B3: tool name`);
  assert.ok((b3.calls[0].input?.command || '').includes('continuation-ok'), `${label} B3: arguments`);
  assert.equal(b3.finishReason, protocol === 'openai' ? 'tool_calls' : 'tool_use', `${label} B3: finish reason sau continuation`);
  assert.equal(stateRef.continuations, 1, `${label} B3: đúng 1 hidden follow-up (cap 1)`);
  assert.equal(stateRef.upstreamCalls, 2, `${label} B3: 1 call chính + 1 continuation, không lặp vô hạn`);

  /* B4 — Error Recovery Loop (tool result is_error) */
  const errMessages = [
    { role: 'user', content: 'STAGE-ERROR: run the failing step then recover' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b4', name: 'Bash', input: { command: 'run-failing-step' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b4', is_error: true, content: 'ERROR-SENTINEL-42: step failed' }] },
    { role: 'user', content: 'Recover from the error above.' },
  ];
  const b4 = await callGateway(base, protocol, model, stream, errMessages, { tools });
  assert.equal(b4.calls.length, 1, `${label} B4: model phải stream tool call sửa lỗi`);
  assert.ok((b4.calls[0].input?.command || '').includes('recovery-ok'), `${label} B4: lệnh sửa lỗi`);

  /* B5 — Final Context Verification */
  const b5 = await callGateway(base, protocol, model, stream, [
    { role: 'user', content: `STAGE-FINAL summary. Needles: ${NEEDLE_ALPHA}, ${NEEDLE_BETA}, ${NEEDLE_GAMMA}` },
  ], { tools });
  assert.ok(b5.content.includes('FINAL-CONTEXT-OK'), `${label} B5: tổng hợp đủ 3 needle`);
  assert.ok(b5.content.includes(NEEDLE_ALPHA) && b5.content.includes(NEEDLE_BETA) && b5.content.includes(NEEDLE_GAMMA), `${label} B5: needle nguyên vẹn`);
}

let stateRef = null;

/* ── Suite chính: mỗi model × protocol × mode = 1 test 5 bước ── */
test('STRESS BENCHMARK: all ClickUp models × protocols × stream modes', async (t) => {
  const { CLICKUP_MODELS } = await import(sourceURL('providers/clickup/upstream.mjs'));
  assert.ok(Array.isArray(CLICKUP_MODELS) && CLICKUP_MODELS.length >= 20, 'danh sách model ClickUp phải đầy đủ');

  const { mock, state } = createHarness();
  stateRef = state;
  const base = await listen(mock);
  state.origin = base;
  /* Mock phải là upstream thật của gateway: trỏ API base về mock TRƯỚC khi import pool. */
  process.env.CLICKUP_API_BASE = base;
  process.env.CLICKUP_ID_BASE = base;
  t.after(async () => {
    delete process.env.CLICKUP_API_BASE;
    delete process.env.CLICKUP_ID_BASE;
    await close(mock);
  });

  const { clickupPool } = await import(sourceURL('clickup-pool.mjs'));
  const { createServer } = await import(sourceURL('server.mjs'));
  clickupPool.onPersist = null;
  clickupPool.initFromConfig({
    workspaces: [{ workspaceId: 'bench-workspace', token: 'bench-session', limit: 4 }],
    accounts: [],
  });
  const gateway = createServer({ apiKey: 'bench-key' });
  const gwBase = await listen(gateway);
  t.after(async () => close(gateway));

  const matrix = [];
  const modelFilter = process.env.BENCH_MODEL || null;
  for (const model of CLICKUP_MODELS) {
    if (modelFilter && model !== modelFilter) continue;
    for (const protocol of ['openai', 'anthropic']) {
      for (const stream of [true, false]) {
        await t.test(`${model} | ${protocol} | ${stream ? 'stream' : 'non-stream'}`, async () => {
          state.upstreamCalls = 0;
          state.continuations = 0;
          try {
            await runBenchmark(gwBase, model, protocol, stream);
            matrix.push({ model, protocol, stream, status: 'PASS' });
          } catch (err) {
            matrix.push({ model, protocol, stream, status: 'FAIL', error: err.message });
            throw err;
          }
        });
      }
    }
  }
  t.after(() => {
    const failed = matrix.filter((m) => m.status !== 'PASS');
    if (failed.length) console.error('[STRESS BENCH] FAILURES:\n' + failed.map((f) => `  ${f.model} ${f.protocol} ${f.stream ? 'stream' : 'non-stream'}: ${f.error}`).join('\n'));
    else console.log(`[STRESS BENCH] ALL PASS: ${matrix.length}/${matrix.length} combinations`);
  });
});
