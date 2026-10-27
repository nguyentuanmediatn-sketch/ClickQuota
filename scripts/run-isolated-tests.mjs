// Chạy toàn bộ unit suite trong bản sao cách ly (không .state/.env thật, chặn mạng ngoài).
// Quy trình theo README: sao chép src, test, scripts, node_modules, package.json,
// tạo .state/clickup_config.json rỗng, preload scripts/net-guard.mjs rồi node --test.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guard = pathToFileURL(path.join(root, 'scripts', 'net-guard.mjs')).href;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickquota-tests-'));

try {
  for (const dir of ['src', 'test', 'scripts']) {
    fs.cpSync(path.join(root, dir), path.join(sandbox, dir), { recursive: true });
  }
  if (fs.existsSync(path.join(root, 'test-telegram.mjs'))) {
    fs.copyFileSync(path.join(root, 'test-telegram.mjs'), path.join(sandbox, 'test-telegram.mjs'));
  }
  fs.cpSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(sandbox, f));
  fs.mkdirSync(path.join(sandbox, '.state'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.state', 'clickup_config.json'), JSON.stringify({ workspaces: [], accounts: [] }));

  const env = Object.assign({}, process.env, { NODE_OPTIONS: `--import ${guard}` });
  const result = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], {
    cwd: sandbox, env, encoding: 'utf8', timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (result.stdout || '') + (result.stderr || '');
  process.stdout.write(out.slice(-20000));
  // node --test exit code: 0 = pass, 1 = fail.
  const failed = /# fail\s+\d+/.exec(out);
  const passed = /# pass\s+\d+/.exec(out);
  console.log(`\n[isolated-tests] pass=${passed ? passed[0] : '?'} ${failed ? failed[0] : '# fail 0'} exit=${result.status}`);
  process.exit(result.status === 0 ? 0 : 1);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
