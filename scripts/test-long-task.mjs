// Mini agent-loop client đo stall khi chạy task dài qua ClickQuota gateway sau khi
// gỡ cơ chế ép hành vi (2026-10-27). Chống stall + chống loop giờ NẰM Ở TẦNG CLIENT:
//  - client-nudge: model trả lời "lời hứa suông" mà không gọi tool -> client gửi một
//    tin nhắn NHÌN THẤY ĐƯỢC trong hội thoại nhắc model gọi tool (tối đa maxNudges).
//  - client-guard: cùng một tool thất bại >= 3 lần liên tiếp -> client nhắc đổi cách.
// Không có cơ chế nào ở đây tự bịa tool call hay lệnh shell thay model.
// Usage: node scripts/test-long-task.mjs [port] [task#]
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 4311);
const ONLY = Number(process.argv[3] || 0);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvApiKey() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = raw.match(/^CLICKQUOTA_API_KEY=(.*)$/m);
    if (m) return m[1].trim();
  } catch {}
  return process.env.CLICKQUOTA_API_KEY || '';
}
const API_KEY = readEnvApiKey();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Đọc nội dung một file text trong thư mục project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Đường dẫn tương đối tới file' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liệt kê file và thư mục con của một thư mục trong project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Đường dẫn thư mục tương đối' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Chạy một lệnh shell nằm trong whitelist an toàn (node -v, npm -v, dir).',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

const COMMAND_WHITELIST = new Set(['node -v', 'npm -v', 'dir']);

function executeTool(name, input) {
  try {
    if (name === 'execute_command') {
      const cmd = String(input?.command || '').trim();
      if (!COMMAND_WHITELIST.has(cmd)) {
        return { error: `Lệnh "${cmd.slice(0, 80)}" không nằm trong whitelist của client test (chỉ chấp nhận: ${[...COMMAND_WHITELIST].join(', ')})` };
      }
      const out = cp.execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      return { content: String(out).slice(0, 3000) };
    }
    const rel = String(input?.path || '.');
    const resolved = path.resolve(ROOT, rel);
    if (!resolved.startsWith(ROOT)) return { error: 'Đường dẫn nằm ngoài thư mục project' };
    if (name === 'read_file') {
      const text = fs.readFileSync(resolved, 'utf8');
      return { content: text.slice(0, 4000) };
    }
    if (name === 'list_files') {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      return { content: entries.join('\n').slice(0, 3000) };
    }
    return { error: `Tool không rõ: ${name}` };
  } catch (err) {
    return { error: err.message };
  }
}

// Heuristic phát hiện "lời hứa suông" (phản hồi text-only trông như stall)
const STALL_RE = /(?:\b(?:em|tôi|mình)\s+(?:sẽ|sắp|đang)|let me|i will|i'll|i am going to|để em|để tôi|đang kiểm tra|kế hoạch|plan\s*:|next step)/i;
function looksLikeStall(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.trim().length < 500 && STALL_RE.test(text);
}

async function chat(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);
  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${API_KEY}`,
        'x-api-key': API_KEY,
        'x-ide-client': 'cline',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-opus-5-5-CL',
        messages,
        tools: TOOLS,
        stream: false,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) return { httpError: `${resp.status} ${text.slice(0, 300)}` };
    const data = JSON.parse(text);
    return { message: data.choices?.[0]?.message || {} };
  } catch (err) {
    return { httpError: `fetch failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function runTask(label, task, { maxTurns = 8, maxNudges = 2 } = {}) {
  const messages = [{ role: 'user', content: task }];
  let turns = 0, toolCallCount = 0, stalls = 0, nudges = 0, errorCalls = 0;
  let lastFailTool = '';
  let consecutiveFails = 0;
  while (turns < maxTurns) {
    turns += 1;
    const t0 = Date.now();
    const result = await chat(messages);
    const ms = Date.now() - t0;
    if (result.httpError) {
      console.log(`  [turn ${turns}] HTTP LỖI (${ms}ms): ${result.httpError}`);
      return { label, turns, toolCallCount, stalls, nudges, errorCalls, outcome: 'http_error' };
    }
    const msg = result.message;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (calls.length > 0) {
      toolCallCount += calls.length;
      console.log(`  [turn ${turns}] ${calls.length} tool call (${ms}ms): ${calls.map((c) => c.function?.name).join(', ')}`);
      messages.push({ role: 'assistant', content: text || '', tool_calls: calls });
      for (const call of calls) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const res = executeTool(call.function?.name, input);
        if (res.error) {
          errorCalls += 1;
          if (call.function?.name === lastFailTool) consecutiveFails += 1;
          else { lastFailTool = call.function?.name; consecutiveFails = 1; }
          console.log(`    -> LỖI: ${String(res.error).slice(0, 120)}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR: ${res.error}`, isError: true });
        } else {
          consecutiveFails = 0; lastFailTool = '';
          console.log(`    -> OK (${String(res.content || '').length} chars)`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: res.content });
        }
      }
      // client-guard: cùng 1 tool fail >= 3 lần liên tiếp -> nhắc đổi cách (nudge thấy được)
      if (consecutiveFails >= 3) {
        nudges += 1;
        consecutiveFails = 0;
        messages.push({ role: 'user', content: '[client-guard]: Tool vừa gọi đã thất bại 3 lần liên tiếp. Đừng lặp lại y nguyên — hãy đổi cách tiếp cận khác (tool khác, tham số khác, hoặc báo user).' });
      }
      continue;
    }
    if (looksLikeStall(text) && nudges < maxNudges) {
      stalls += 1;
      nudges += 1;
      console.log(`  [turn ${turns}] STALL -> client-nudge (${ms}ms): ${text.slice(0, 140).replace(/\s+/g, ' ')}`);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: '[client-nudge]: Bạn vừa trả lời bằng lời hứa thay vì hành động. Hãy thực hiện bước tiếp theo NGAY BÂY GIỜ bằng một tool call (Format A/B/C/D).' });
      continue;
    }
    console.log(`  [turn ${turns}] KẾT THÚC (${ms}ms): ${String(text).slice(0, 300).replace(/\s+/g, ' ')}`);
    return { label, turns, toolCallCount, stalls, nudges, errorCalls, outcome: stalls > 0 ? 'done_with_stalls' : 'done_clean', finalText: text.slice(0, 400) };
  }
  return { label, turns, toolCallCount, stalls, nudges, errorCalls, outcome: 'hit_max_turns' };
}

const TASKS = [
  {
    label: 'T1: chuỗi đọc nhiều bước',
    task: 'Hãy đọc file package.json, sau đó liệt kê thư mục src, rồi đọc file src/index.mjs, cuối cùng tóm tắt dự án này trong 5 gạch đầu dòng.',
  },
  {
    label: 'T2: lệnh trong whitelist + đọc file',
    task: 'Chạy lệnh "node -v", rồi liệt kê các file trong thư mục src/providers/clickup, sau đó đọc file src/config.mjs và cho biết gateway mặc định chạy ở cổng nào.',
  },
  {
    label: 'T3: lệnh ngoài whitelist (đo client-guard chống loop)',
    task: 'Hãy chạy lệnh "npm test" để xem kết quả test, rồi chạy lệnh "git status", sau đó cho tôi biết kết quả tổng hợp.',
  },
];

const list = ONLY ? [TASKS[ONLY - 1]].filter(Boolean) : TASKS;
const results = [];
for (const t of list) {
  console.log(`\n=== ${t.label} ===`);
  const r = await runTask(t.label, t.task);
  results.push(r);
  console.log(`  => ${JSON.stringify(r)}`);
}
console.log(`\nTỔNG KẾT: ${results.length} task | tổng turn ${results.reduce((s, r) => s + r.turns, 0)} | tổng tool call ${results.reduce((s, r) => s + r.toolCallCount, 0)} | tổng stall ${results.reduce((s, r) => s + r.stalls, 0)} | tổng nudge ${results.reduce((s, r) => s + r.nudges, 0)}`);
