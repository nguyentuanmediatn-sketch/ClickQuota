import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPreToolText } from '../src/clickup-tools.mjs';
import { extractTextToolCalls } from '../src/tools/text-fallback.mjs';
import { parseToolCallsFromText } from '../src/clickup-upstream.mjs';
import { createClickUpToolMapper } from '../src/clickup-tools.mjs';

test('ClickUp tool call leak fix: extractPreToolText cleanly strips bracket [Tool Call:]', () => {
  const sample = `Em đã có đủ thông tin về livekit.yaml và docker-compose.yml. Em đọc .env.example rồi sửa cả ba file cùng lúc.

[Tool Call: Read({"file_path":"C:\\Users\\hacke\\Documents\\Codex\\2026-10-13\\nghi\\outputs\\skyedu-classroom\\.env.example"})]`;

  const preamble = extractPreToolText(sample);
  assert.equal(preamble, 'Em đã có đủ thông tin về livekit.yaml và docker-compose.yml. Em đọc .env.example rồi sửa cả ba file cùng lúc.');
  assert.ok(!preamble.includes('[Tool Call:'));
});

test('ClickUp tool call leak fix: preserves Windows paths with \\nghi without creating newlines', () => {
  const sample = `[Tool Call: Read({"file_path":"C:\\Users\\hacke\\Documents\\Codex\\2026-10-13\\nghi\\outputs\\skyedu-classroom\\.env.example"})]`;

  const calls = extractTextToolCalls(sample);
  assert.ok(calls && calls.length === 1);
  assert.equal(calls[0].name, 'Read');
  assert.ok(!calls[0].arguments.file_path.includes('\n'), 'Path must not contain newline character');
  assert.ok(calls[0].arguments.file_path.includes('/nghi/') || calls[0].arguments.file_path.includes('\\nghi\\'));
});

test('ClickUp tool call leak fix: parses multiple tool calls in single turn', () => {
  const sample = `Em tạo cấu hình Egress và cập nhật docker-compose.yml thêm Redis và Egress.

[Tool Call: Write({"file_path":"C:\\Users\\hacke\\Documents\\Codex\\2026-10-13\\nghi\\outputs\\skyedu-classroom\\egress.yaml","content":"# LiveKit Egress\\nredis:\\n  address: redis:6379\\n"})]

[Tool Call: Write({"file_path":"C:\\Users\\hacke\\Documents\\Codex\\2026-10-13\\nghi\\outputs\\skyedu-classroom\\docker-compose.yml","content":"# Docker Compose\\nservices:\\n  redis:\\n    image: redis:7-alpine\\n"})]`;

  const parsed = parseToolCallsFromText(sample);
  assert.ok(parsed);
  assert.equal(parsed.text, 'Em tạo cấu hình Egress và cập nhật docker-compose.yml thêm Redis và Egress.');
  assert.ok(Array.isArray(parsed.calls));
  assert.equal(parsed.calls.length, 2);
  assert.equal(parsed.calls[0].name, 'Write');
  assert.equal(parsed.calls[1].name, 'Write');

  const tools = [
    { name: 'Write', description: 'Write file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } }
  ];
  const mapper = createClickUpToolMapper('claude-code', tools);
  const mapped = parsed.calls.map(c => mapper.map(c));
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].name, 'Write');
  assert.equal(mapped[1].name, 'Write');
  assert.ok(mapped[0].input.file_path.includes('egress.yaml'));
  assert.ok(mapped[1].input.file_path.includes('docker-compose.yml'));
});

test('ClickUp tool call leak fix: cleanly strips markdown code fences wrapping [Tool Call:]', () => {
  const sample1 = `Tôi đọc file cấu hình:\n\`\`\`json\n[Tool Call: Read({"file_path":"C:\\Users\\hacke\\config.json"})]\n\`\`\``;
  const pre1 = extractPreToolText(sample1);
  assert.equal(pre1, 'Tôi đọc file cấu hình:');
  assert.ok(!pre1.includes('```'), 'Must not contain any code fence');

  const sample2 = `\`\`\`\n[Tool Call: Bash({"command":"dir"})]\n\`\`\``;
  const pre2 = extractPreToolText(sample2);
  assert.equal(pre2, '', 'Must be empty when prompt begins with code fence');

  const parsed = parseToolCallsFromText(sample1);
  assert.ok(parsed && parsed.calls.length === 1);
  assert.equal(parsed.name, 'Read');
  assert.equal(parsed.text, 'Tôi đọc file cấu hình:');
});

test('ClickUp tool call: parses AntML <invoke> with <parameter name="..."> and cleanly strips preText', () => {
  const sample = `Hiện tại tôi mới chỉ thấy danh sách file, chưa đọc nội dung.
Tôi sẽ đọc các file chính để xác nhận kiến trúc và luồng xử lý.

<invoke name="Read">
<parameter name="file_path">C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\index.mjs</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\providers\\clickup\\index.mjs</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\providers\\clickup\\pool.mjs</parameter>
</invoke>`;

  const pre = extractPreToolText(sample);
  assert.ok(!pre.includes('<invoke'), 'Pre-tool text must not leak any <invoke> tags');
  assert.ok(pre.includes('Tôi sẽ đọc các file chính'));

  const parsed = parseToolCallsFromText(sample);
  assert.ok(parsed && parsed.calls.length === 3);
  assert.equal(parsed.calls[0].name, 'Read');
  assert.equal(parsed.calls[0].arguments.file_path, 'C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\index.mjs');
  assert.equal(parsed.calls[1].arguments.file_path, 'C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\providers\\clickup\\index.mjs');
  assert.equal(parsed.calls[2].arguments.file_path, 'C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\providers\\clickup\\pool.mjs');

  const mapper = createClickUpToolMapper('claude-code', [
    { name: 'Read', parameters: { properties: { filePath: { type: 'string' } } } }
  ]);
  const mapped = parsed.calls.map(c => mapper.map(c));
  assert.equal(mapped.length, 3);
  assert.ok(mapped.every(m => m !== null));
  assert.equal(mapped[0].input.filePath, 'C:\\Users\\hacke\\Desktop\\ClickQuota\\src\\index.mjs');
});

