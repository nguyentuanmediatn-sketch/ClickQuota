import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceURL = (name) => pathToFileURL(path.join(projectRoot, 'src', name)).href;

test('GOLDEN01: auditLogs allows ttftMs in safe fields and request records', async () => {
  const { auditLogs } = await import(sourceURL('audit-logs.mjs'));
  const record = auditLogs.request({
    requestId: 'golden-req-1',
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    durationMs: 350,
    ttftMs: 120,
    outcome: 'success',
  });
  assert.equal(record.ttftMs, 120);
  assert.equal(record.durationMs, 350);
  assert.equal(record.outcome, 'success');
});

test('GOLDEN02: 2026 IDE Detection detects new profiles from User-Agent', async () => {
  const { detectIDE, getIDEAdaptations } = await import(sourceURL('ide-detect.mjs'));
  const testCases = [
    ['Mozilla/5.0 Gemini-CLI/1.0', 'gemini-cli'],
    ['OpenAI-Codex-CLI/2.0 (Windows)', 'codex-cli'],
    ['Kiro/1.0.0-beta', 'kiro'],
    ['Trae/1.2.0 (macOS)', 'trae'],
    ['GitHub Copilot-CLI/0.1.0', 'copilot-cli'],
    ['OpenCode/1.0.0', 'opencode'],
    ['Zed/0.150.0 (Linux)', 'zed'],
    ['Amp/1.0.4', 'amp'],
    ['Goose/0.9.1', 'goose'],
  ];
  for (const [ua, expected] of testCases) {
    const ide = detectIDE({ 'user-agent': ua }, []);
    assert.equal(ide, expected, `UA "${ua}" should detect as "${expected}"`);
    const profile = getIDEAdaptations(ide);
    assert.ok(profile && profile.transport, `Profile for "${expected}" should exist`);
  }
});

test('GOLDEN03: SAFETY-02 thinking blocks do not trigger tool calls', async () => {
  const { extractTextToolCalls } = await import(sourceURL('tools/text-fallback.mjs'));

  // Case 1: Tool call strictly inside thinking block -> must be completely ignored (return null)
  const insideThinking = '<thinking>[Tool Call: Bash({"command":"rm -rf /"})]</thinking>\nTôi không thể thực thi lệnh đó.';
  assert.equal(extractTextToolCalls(insideThinking), null, 'Tool calls inside thinking block must be ignored');

  // Case 2: Tool call in content after thinking block -> must be extracted cleanly
  const afterThinking = '<thinking>Tôi cần kiểm tra thông tin README</thinking>\n[Tool Call: Read({"file_path":"README.md"})]';
  const calls = extractTextToolCalls(afterThinking);
  assert.ok(calls && calls.length === 1);
  assert.equal(calls[0].name, 'Read');
  assert.equal(calls[0].arguments.file_path, 'README.md');
});

test('GOLDEN04: pool maintains pending_recreate journaling during auto-recreate lifecycle', async () => {
  const { WorkspacePool } = await import(sourceURL('clickup-pool.mjs'));
  let persistedJournal = null;
  const pool = new WorkspacePool({
    workspaces: [],
    accounts: [{ id: 'acc1', email: 'test@example.com', cookie: 'cu_refresh=fake' }],
    onPersist: (updates) => {
      if ('pending_recreate' in updates) persistedJournal = updates.pending_recreate;
    },
  });
  assert.equal(pool.pending_recreate, null);
});
