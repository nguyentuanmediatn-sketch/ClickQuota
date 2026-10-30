import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveUserIntent,
  pruneToolsForContext,
  formatToolsPrompt
} from '../src/clickup-upstream.mjs';
import {
  healToolParameters,
  createClickUpToolMapper,
  buildClickUpToolPromptCard
} from '../src/clickup-tools.mjs';

test('Intent Recognition: preserves context on short confirmations ("đúng rồi")', () => {
  const history = [
    { role: 'user', content: 'A cần phát triển ClickQuota thành 1 trung tâm điều phối proxy hoàn chỉnh, e có gợi ý gì k' },
    { role: 'assistant', content: 'Bạn muốn tôi thực hiện việc gì trong dự án C:\\Users\\hacke\\Desktop\\ClickQuota ?' },
    { role: 'user', content: 'đúng rồi' }
  ];

  const intent = resolveActiveUserIntent(history);
  assert.equal(intent.isConfirmation, true);
  assert.ok(intent.content.includes('ClickQuota thành 1 trung tâm điều phối proxy'));
  assert.ok(intent.content.includes('đúng rồi'));
});

test('Intent Recognition: detects consultation / brainstorming intent', () => {
  const history = [
    { role: 'user', content: 'A cần phát triển ClickQuota thành 1 trung tâm điều phối proxy hoàn chỉnh, e có gợi ý gì k' }
  ];

  const intent = resolveActiveUserIntent(history);
  assert.equal(intent.isConsultation, true);
  assert.equal(intent.isConfirmation, false);
});

test('Intent Recognition: detects multi-turn tool continuation and does not revert to turn-1 prompt', () => {
  const openaiHistory = [
    { role: 'user', content: 'Hãy kiểm tra toàn bộ code dự án' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'glob', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file1.js, file2.js' }
  ];
  const intent1 = resolveActiveUserIntent(openaiHistory);
  assert.equal(intent1.isToolContinuation, true);
  assert.ok(intent1.content.includes('Continue executing the task'));
  assert.ok(!intent1.content.includes('Hãy kiểm tra toàn bộ code dự án'));

  const anthropicHistory = [
    { role: 'user', content: 'Hãy kiểm tra toàn bộ code dự án' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'function main() {}' }] }
  ];
  const intent2 = resolveActiveUserIntent(anthropicHistory);
  assert.equal(intent2.isToolContinuation, true);
  assert.ok(intent2.content.includes('Continue executing the task'));
});

test('Tool Pruning: reduces heavy tool catalogs by removing non-coding MCP viewers', () => {
  const heavyTools = [
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Edit' },
    { name: 'mcp__plugin_pdf_pdf__open_document' },
    { name: 'mcp__plugin_pdf_pdf__read_document' },
    { name: 'mcp__plugin_documents_documents__open_document' },
    { name: 'CronCreate' },
    { name: 'CronList' },
    { name: 'OffPeakCreate' },
    { name: 'CreateWorkflow' },
    { name: 'ListSavedWorkflows' },
    { name: 'Skill' },
    { name: 'AskUserQuestion' },
    { name: 'TodoWrite' },
    { name: 'TodoRead' },
    { name: 'WebFetch' }
  ];

  const pruned = pruneToolsForContext(heavyTools);
  assert.ok(pruned.length < heavyTools.length);
  assert.ok(pruned.every(t => !t.name.includes('pdf')));
  assert.ok(pruned.every(t => !t.name.includes('Cron')));
  assert.ok(pruned.some(t => t.name === 'Bash'));
  assert.ok(pruned.some(t => t.name === 'Read'));
});

test('Parameter Healing: extracts raw command into command property for shell tools', () => {
  const healed = healToolParameters('Bash', { raw: 'dir /s /b' }, [{ name: 'Bash', parameters: { properties: { command: { type: 'string' } } } }]);
  assert.equal(healed.command, 'dir /s /b');
});

test('Tool Mapper: passes empty-args calls through for client-side validation', () => {
  // 2026-10-28 (fix "lệnh trước không trả kết quả"): mapper KHÔNG còn drop-im-lặng
  // call thiếu tham số. Call resolve được tên → pass-through; IDE client validate
  // schema và trả VALIDATION ERROR thật cho model → model tự sửa tham số.
  const mapper = createClickUpToolMapper('claude-code', [
    { name: 'Bash', parameters: { properties: { command: { type: 'string' } } } },
    { name: 'Read', parameters: { properties: { filePath: { type: 'string' } } } }
  ]);

  const mappedBash = mapper.map({ name: 'Bash', arguments: {} });
  assert.notEqual(mappedBash, null, 'Bash rỗng phải pass-through để client trả validation error');
  assert.equal(mappedBash.name, 'Bash');
  assert.deepEqual(mappedBash.input, {});

  const mappedRead = mapper.map({ name: 'Read', arguments: {} });
  assert.notEqual(mappedRead, null);
  assert.deepEqual(mappedRead.input, {});

  const validBash = mapper.map({ name: 'Bash', arguments: { command: 'npm test' } });
  assert.notEqual(validBash, null);
  assert.equal(validBash.input.command, 'npm test');
});

test('Parameter Healing: heals URL and auto-fills default prompt for web tools', () => {
  const tools = [
    {
      name: 'WebFetch',
      parameters: {
        properties: {
          url: { type: 'string' },
          prompt: { type: 'string' }
        },
        required: ['url', 'prompt']
      }
    }
  ];

  // 1. Heals from link property and fills prompt
  const healed1 = healToolParameters('WebFetch', { link: 'https://example.com' }, tools);
  assert.equal(healed1.url, 'https://example.com');
  assert.ok(healed1.prompt && healed1.prompt.length > 5);

  // 2. Extracts URL embedded in raw string
  const healed2 = healToolParameters('WebFetch', { raw: 'check https://drive.google.com/test' }, tools);
  assert.equal(healed2.url, 'https://drive.google.com/test');
  assert.ok(healed2.prompt);
});

test('Generic Parameter Guard: passes empty WebFetch call through (client validates)', () => {
  const mapper = createClickUpToolMapper('claude-code', [
    {
      name: 'WebFetch',
      parameters: {
        properties: {
          url: { type: 'string' },
          prompt: { type: 'string' }
        },
        required: ['url', 'prompt']
      }
    }
  ]);

  // 2026-10-28: empty WebFetch pass-through — và vì 'prompt' là required trong
  // schema, healToolParameters tự điền prompt trung tính → client thực thi được
  // ngay không cần vòng lặp lỗi.
  const mappedEmpty = mapper.map({ name: 'WebFetch', arguments: {} });
  assert.notEqual(mappedEmpty, null, 'Empty WebFetch call được pass-through để client validate');
  assert.ok(mappedEmpty.input && typeof mappedEmpty.input.prompt === 'string' && mappedEmpty.input.prompt.length > 5,
    'prompt required phải được heal tự điền: ' + JSON.stringify(mappedEmpty.input));

  const mappedValid = mapper.map({
    name: 'WebFetch',
    arguments: { url: 'https://example.com', prompt: 'Summarize content' }
  });
  assert.notEqual(mappedValid, null);
  assert.equal(mappedValid.input.url, 'https://example.com');
  assert.equal(mappedValid.input.prompt, 'Summarize content');
});

// Anti-Loop Circuit Breaker đã bị gỡ khỏi gateway (2026-10-27): gateway không còn
// inject chỉ thị phá loop vào prompt. Việc phát hiện vòng lặp tool thất bại liên tiếp
// chuyển về tầng client (xem scripts/test-long-task.mjs — client-guard).

test('Prompt Card: chỉ còn syntax chức năng, không còn rule ép hành vi', () => {
  const card = buildClickUpToolPromptCard([{ name: 'Bash' }, { name: 'Read' }]);
  assert.ok(!card.includes('PRAGMATIC SCRIPTING OVER REPEATED TOOL RETRIES'));
  assert.ok(!card.includes('WEB, CLOUD STORAGE & GOOGLE DRIVE PROTOCOL'));
  assert.ok(!card.includes('WINDOWS & UTF-8 / VIETNAMESE FILE HANDLING'));
  assert.ok(!card.includes('CRITICAL REALITY & EXECUTION MANDATE'));
  assert.ok(card.includes('TOOL CALL SYNTAX'));
  assert.ok(card.includes('Format A (Standard JSON)'));
  assert.ok(card.includes('[Available tools]'));
  assert.ok(card.includes('[/Available tools]'));
  assert.ok(!card.includes('SYSTEM INSTRUCTION'));
  // 2026-10-28: khung cơ chế thực thi — nói cho model biết call được client thực thi
  // thật và kết quả quay lại lượt kế tiếp; bắt buộc PHÁT call thay vì hứa suông;
  // cấm tự bịa kết quả. Đây là ngữ cảnh giao thức trung lập, không phải coercion.
  assert.ok(card.includes('EXECUTION MODEL:'));
  assert.ok(card.includes('EMIT a tool call'));
  assert.ok(card.includes('NEVER invent or simulate a tool result'));
});

