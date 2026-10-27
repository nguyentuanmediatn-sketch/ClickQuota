import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guard = pathToFileURL(path.join(root, 'scripts', 'net-guard.mjs')).href;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickquota-smoke-'));
let child;

try {
  // Bản sao sạch: không có .env, không có .state thật.
  fs.cpSync(path.join(root, 'src'), path.join(sandbox, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(sandbox, f));
  fs.mkdirSync(path.join(sandbox, '.state'));
  fs.writeFileSync(path.join(sandbox, '.state', 'clickup_config.json'), JSON.stringify({ workspaces: [], accounts: [] }));

  // Tự kiểm tra guard: kết nối ra ngoài phải bị chặn.
  const probe = spawnSync(process.execPath, ['--import', guard, '-e', "fetch('http://example.com').then(()=>process.exit(1),e=>process.exit(e.code==='ENETGUARD'?0:2))"], { encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, 'net guard must block non-loopback fetch');

  const env = Object.assign({}, process.env, { CLICKQUOTA_PORT: '0', CLICKQUOTA_HOST: '127.0.0.1', CLICKQUOTA_API_KEY: 'smoke-key' });
  child = spawn(process.execPath, ['--import', guard, path.join(sandbox, 'src', 'index.mjs')], {
    cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill(), 30000);
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Child exited before startup: ' + stderr)));
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    });
  });

  // Chờ qua mốc quota audit khởi động (3s) để bao phủ cron nền.
  await new Promise((r) => setTimeout(r, 4500));
  const auth = { 'x-api-key': 'smoke-key' };

  const health = await fetch(url + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'clickquota');

  const models = await fetch(url + '/v1/models', { headers: auth });
  assert.equal(models.status, 200);
  assert.ok((await models.json()).data.length > 0);

  assert.equal((await fetch(url + '/v1/models')).status, 401, 'API key must be enforced');
  assert.equal((await fetch(url + '/admin')).status, 200);
  const status = await (await fetch(url + '/admin/api/clickup/status')).json();
  assert.equal(status.ok, true);
  assert.equal(status.workspaces.length, 0);

  assert.ok(!stderr.includes('NETGUARD BLOCKED'), 'startup must not attempt outbound network:\n' + stderr);
  console.log('PASS: isolated temp copy (no real .env/.state, outbound network blocked); startup cron window, health, models, auth and admin OK');
  clearTimeout(timer);
  child.kill();
  await exited;
} finally {
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
