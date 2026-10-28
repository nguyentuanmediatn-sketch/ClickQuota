import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectAndRecoverIdlePromise } from '../src/clickup-tools.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceURL = (name) => pathToFileURL(path.join(projectRoot, 'src', name)).href;
const command = 'printf safety-ok';
const recoveryTools = [
  {
    name: 'Bash',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
];

// 2026-10-27: detectAndRecoverIdlePromise đã thành no-op — gateway KHÔNG được tự bịa
// tool call (kể cả sinh lệnh shell) từ văn bản "lời hứa suông" của model.
// Mọi lời hứa/cảnh báo/từ chối phải đi nguyên văn về client; chống stall thuộc tầng client.
const unitCases = [
  ['SAFETY01 unit warning_with_stall', "Plan: Don't run git push, it's risky; run command only after approval."],
  ['SAFETY02 unit refusal_with_backticks', 'Plan: I cannot execute `npm test`.'],
  ['SAFETY03 unit advice_with_command', 'Plan: You should run command "npm test" only after approval.'],
  ['SAFETY04 unit promise_with_command', 'Plan: I will run command "npm test" now.'],
  ['SAFETY05 unit promise_with_windows_path', 'I will read C:\\repo\\package.json now.'],
  ['SAFETY06 unit promise_with_directory', 'Let me inspect the project structure now.'],
  ['SAFETY07 unit vietnamese_promise', 'Tôi sẽ đọc C:\\repo\\package.json ngay bây giờ.'],
  ['SAFETY08 unit quoted_command_is_not_protocol', 'Plan: Execute "git status" after the user approves.'],
];

for (const [name, text] of unitCases) {
  test(name, () => {
    assert.equal(detectAndRecoverIdlePromise(text, recoveryTools), null);
  });
}

// ── SAFETY10-13 (2026-10-28): khóa suy diễn tool call từ ví dụ JSON trong văn xuôi ──
import { extractTextToolCalls } from '../src/tools/text-fallback.mjs';
import { parseToolCallsFromText } from '../src/clickup-upstream.mjs';
import { createClickUpToolMapper } from '../src/clickup-tools.mjs';

const bashCatalog = [
  { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
];

test('SAFETY10 prose_embedded_bare_json_not_protocol — JSON example giữa văn xuôi không thành tool call', () => {
  const prose = 'To call the API you write {"name":"Bash","arguments":{"command":"echo hi"}} in your code.';
  assert.equal(extractTextToolCalls(prose), null, 'bare JSON chiếm <70% nội dung → phải bỏ qua');
  assert.equal(parseToolCallsFromText(prose, bashCatalog), null);
});

test('SAFETY11 zero_tools_no_parse — client khai báo 0 tool thì không extract call nào', () => {
  const reply = '{"name":"Bash","arguments":{"command":"echo hi"}}';
  assert.equal(parseToolCallsFromText(reply, []), null, '0 tool → parser phải trả null');
  assert.equal(parseToolCallsFromText(reply), null, 'mặc định không có catalog → null');
});

test('SAFETY12 unknown_tool_name_dropped — mapper chỉ nhận tên có trong catalog client', () => {
  const mapper = createClickUpToolMapper('unknown', bashCatalog);
  assert.equal(mapper.map({ name: 'definitelyNotATool', arguments: { command: 'echo hi' } }), null,
    'tên không tồn tại trong catalog phải bị drop');
  // Alias chuẩn: Bash → executeShellCommand trong catalog zcode vẫn được map (healing hợp lệ)
  const zcodeCatalog = [
    { name: 'executeShellCommand', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ];
  const zcodeMapper = createClickUpToolMapper('zcode', zcodeCatalog);
  const mapped = zcodeMapper.map({ name: 'Bash', arguments: { command: 'echo hi' } });
  assert.ok(mapped, 'Bash phải map được sang executeShellCommand qua alias registry');
  assert.equal(mapped.name, 'executeShellCommand');
});

test('SAFETY13 bare_json_whole_reply_still_extracts — bare JSON là TOÀN BỘ reply vẫn extract', () => {
  const reply = '{"name":"Bash","arguments":{"command":"echo hi"}}';
  const calls = extractTextToolCalls(reply);
  assert.ok(Array.isArray(calls) && calls.length === 1, 'reply thuần JSON tool call vẫn phải extract');
  assert.equal(calls[0].name, 'Bash');
});

const scenarios = [
  {
    id: 'warning_with_stall',
    reply: "Plan: Don't run git push, it's risky; run command only after approval.",
    expectedTool: null,
  },
  {
    id: 'refusal_with_backticks',
    reply: 'Plan: I cannot execute `npm test`.',
    expectedTool: null,
  },
  {
    id: 'advice_with_command',
    reply: 'Plan: You should run command "npm test" only after approval.',
    expectedTool: null,
  },
  {
    id: 'promise_with_command',
    reply: 'Plan: I will run command "npm test" now.',
    expectedTool: null,
  },
  {
    id: 'promise_with_path',
    reply: 'I will read C:\\repo\\package.json now.',
    expectedTool: null,
  },
  {
    id: 'explicit_json',
    reply: JSON.stringify({ tool_calls: [{ name: 'Bash', arguments: { command } }] }),
    expectedTool: 'Bash',
  },
  {
    id: 'explicit_bracket',
    reply: `[Tool Call: Bash(${JSON.stringify({ command })})]`,
    expectedTool: 'Bash',
  },
  {
    id: 'explicit_xml',
    reply: `<tool_call>${JSON.stringify({ name: 'Bash', arguments: { command } })}</tool_call>`,
    expectedTool: 'Bash',
  },
  {
    id: 'explicit_antml',
    reply: `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`,
    expectedTool: 'Bash',
  },
];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function readRequestBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function parseNonStream(route, body) {
  if (route.includes('/responses')) {
    const calls = (body.output || [])
      .filter((item) => item.type === 'function_call')
      .map((item) => ({ name: item.name, input: JSON.parse(item.arguments || '{}') }));
    return { calls, stopReason: calls.length ? 'tool_calls' : 'stop' };
  }
  if (route.includes('/chat/completions')) {
    const calls = body.choices?.[0]?.message?.tool_calls || [];
    return {
      calls: calls.map((call) => ({
        name: call.function?.name,
        input: JSON.parse(call.function?.arguments || '{}'),
      })),
      stopReason: body.choices?.[0]?.finish_reason,
    };
  }
  const calls = (body.content || [])
    .filter((item) => item.type === 'tool_use')
    .map((item) => ({ name: item.name, input: item.input || {} }));
  return { calls, stopReason: body.stop_reason };
}

function parseSse(route, text) {
  const events = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data));

  if (route.includes('/responses')) {
    const calls = events
      .filter((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call')
      .map((event) => ({ name: event.item.name, input: JSON.parse(event.item.arguments || '{}') }));
    return { calls, stopReason: calls.length ? 'tool_calls' : 'stop' };
  }

  if (route.includes('/chat/completions')) {
    const calls = [];
    let stopReason = null;
    for (const event of events) {
      const choice = event.choices?.[0];
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      for (const call of choice?.delta?.tool_calls || []) {
        calls.push({
          name: call.function?.name,
          input: JSON.parse(call.function?.arguments || '{}'),
        });
      }
    }
    return { calls, stopReason };
  }

  const callsByIndex = new Map();
  let stopReason = null;
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      callsByIndex.set(event.index, { name: event.content_block.name, json: '' });
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const call = callsByIndex.get(event.index);
      if (call) call.json += event.delta.partial_json || '';
    }
    if (event.type === 'message_delta') stopReason = event.delta?.stop_reason || null;
  }
  const calls = [...callsByIndex.values()].map((call) => ({
    name: call.name,
    input: JSON.parse(call.json || '{}'),
  }));
  return { calls, stopReason };
}

test('SAFETY09 HTTP explicit-only matrix', async (t) => {
  let activeScenario = scenarios[0];
  let upstreamBodies = [];
  let origin = '';
  const mock = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/access-token')) {
      res.end(JSON.stringify({ accessToken: 'phase1-gateway', origin, expiresIn: 300 }));
      return;
    }
    const body = await readRequestBody(req);
    if (String(body.query || '').includes('GetAIEntitlements')) {
      res.end(JSON.stringify({
        data: {
          daily: { limit: 100, usage: 0, usageLeft: 100 },
          weekly: { limit: 500, usage: 0, usageLeft: 500 },
          checkFairUseBlocked: { blocked: false },
        },
      }));
      return;
    }
    upstreamBodies.push(body);
    res.end(JSON.stringify({
      data: {
        aiRequest: {
          completionString: activeScenario.reply,
          errors: [],
        },
      },
    }));
  });

  origin = await listen(mock);
  t.after(async () => close(mock));

  const previousApiBase = process.env.CLICKUP_API_BASE;
  const previousIdBase = process.env.CLICKUP_ID_BASE;
  process.env.CLICKUP_API_BASE = origin;
  process.env.CLICKUP_ID_BASE = origin;
  t.after(() => {
    if (previousApiBase === undefined) delete process.env.CLICKUP_API_BASE;
    else process.env.CLICKUP_API_BASE = previousApiBase;
    if (previousIdBase === undefined) delete process.env.CLICKUP_ID_BASE;
    else process.env.CLICKUP_ID_BASE = previousIdBase;
  });

  const { clickupPool } = await import(sourceURL('clickup-pool.mjs'));
  const { createServer } = await import(sourceURL('server.mjs'));
  clickupPool.onPersist = null;

  const server = createServer({ apiKey: 'phase1-test-key' });
  const base = await listen(server);
  t.after(async () => close(server));

  const tools = [
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run one shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read one file',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
        },
      },
    },
  ];

  const request = (route, stream) => {
    const body = {
      model: 'gpt-6-luna-CL',
      messages: [{ role: 'user', content: 'Return the safe result for this regression scenario.' }],
      stream,
      tools,
    };
    if (route.includes('/responses')) {
      body.input = body.messages;
      delete body.messages;
    }
    return fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'phase1-test-key' },
      body: JSON.stringify(body),
    });
  };

  for (const route of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
    for (const stream of [false, true]) {
      for (const scenario of scenarios) {
        const transport = stream ? 'stream' : 'json';
        await t.test(`${route} ${transport} ${scenario.id}`, async () => {
          activeScenario = scenario;
          upstreamBodies = [];
          clickupPool.initFromConfig({
            workspaces: [{ workspaceId: 'phase1-workspace', token: 'phase1-session', limit: 2 }],
            accounts: [],
          });

          const response = await request(route, stream);
          assert.equal(response.status, 200);
          const parsed = stream
            ? parseSse(route, await response.text())
            : parseNonStream(route, await response.json());

          // Guard ở tầng HTTP: payload gửi lên upstream không được chứa marker cấm.
          const sentPayload = JSON.stringify(upstreamBodies);
          for (const banned of ['ANTI-STALL', 'MODE: AUTHORIZED', 'MANDATE', 'Rescue', 'SYSTEM INSTRUCTION: AUTONOMOUS']) {
            assert.ok(!sentPayload.includes(banned), `Prompt gửi lên upstream chứa marker cấm "${banned}"`);
          }

          if (scenario.expectedTool) {
            assert.equal(parsed.calls.length, 1);
            assert.equal(parsed.calls[0].name, scenario.expectedTool);
            assert.equal(parsed.calls[0].input.command, command);
            assert.equal(
              parsed.stopReason,
              route.includes('/messages') ? 'tool_use' : 'tool_calls',
            );
            assert.equal(upstreamBodies.length, 1);
            return;
          }

          assert.deepEqual(parsed.calls, []);
          assert.equal(
            parsed.stopReason,
            route.includes('/messages') ? 'end_turn' : 'stop',
          );

          // 2026-10-27: không còn Rescue Turn — đúng 1 lần gọi upstream cho mọi scenario
          // không phát tool call; phản hồi của model đi nguyên văn về client.
          assert.equal(upstreamBodies.length, 1);
        });
      }
    }
  }
});
