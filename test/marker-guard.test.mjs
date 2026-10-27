import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MARKER GUARD (2026-10-27, Bước 1 kế hoạch chống hoàn nguyên):
// fail nếu cơ chế ép hành vi / tự bịa tool call quay lại trong src/.
// Buổi 2 phát hiện src/ đã từng bị đè ngược bằng bản cũ qua
// scratch/restore_stable.mjs và scratch/sync_to_cq.mjs — test này chặn hồi quy.
const BANNED = [
  'ANTI-STALL',
  'MODE: AUTHORIZED',
  'MANDATE',
  'Rescue',
  'detectToolCallingLoop',
  'SYSTEM INSTRUCTION: AUTONOMOUS',
];

const srcRoot = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'src',
);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('MARKER GUARD: src/ sạch các marker cơ chế đã gỡ', () => {
  const violations = [];
  for (const file of walk(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of BANNED) {
      if (text.includes(marker)) {
        violations.push(`${path.relative(srcRoot, file)}: "${marker}"`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Phát hiện marker cấm quay lại trong src/:\n${violations.join('\n')}`,
  );
});
