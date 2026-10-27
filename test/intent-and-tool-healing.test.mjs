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

test('Tool Mapper: drops empty tool calls missing required commands or paths', () => {
  const mapper = createClickUpToolMapper('claude-code', [
    { name: 'Bash', parameters: { properties: { command: { type: 'string' } } } },
    { name: 'Read', parameters: { properties: { filePath: { type: 'string' } } } }
  ]);

  // Empty Bash call should return null, not { input: {} }
  const mappedBash = mapper.map({ name: 'Bash', arguments: {} });
  assert.equal(mappedBash, null);

  // Empty Read call should return null, not { input: {} }
  const mappedRead = mapper.map({ name: 'Read', arguments: {} });
  assert.equal(mappedRead, null);

  // Valid Bash call should be mapped correctly
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

test('Generic Parameter Guard: drops tool call when required schema parameters are missing', () => {
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

  // Empty WebFetch call (reproducing Turn 50 issue) must be dropped
  const mappedEmpty = mapper.map({ name: 'WebFetch', arguments: {} });
  assert.equal(mappedEmpty, null, 'Empty WebFetch call should be dropped, not emitted as input: {}');

  // WebFetch call with valid url and prompt should pass
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
});

