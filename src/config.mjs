import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// CLICKQUOTA_STATE_DIR: tách .state của instance test/secondary khỏi bản production
// (mặc định vẫn là <APP_ROOT>/.state).
export const STATE_DIR = process.env.CLICKQUOTA_STATE_DIR || path.join(APP_ROOT, '.state');
export const STATE_FILE = path.join(STATE_DIR, 'clickup_config.json');
export const ADMIN_SETTINGS_FILE = path.join(STATE_DIR, 'admin_settings.json');

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

// Reads the locally managed settings file. Missing file => {}. Never logs content.
export function readAdminSettings(file = ADMIN_SETTINGS_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Unable to read ClickQuota admin settings');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('ClickQuota admin settings file is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { apiKey: typeof value.apiKey === 'string' ? value.apiKey : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null };
}

// Atomic write (temp file + rename), mode 0600 where the platform honors it.
export function saveAdminApiKey(apiKey, file = ADMIN_SETTINGS_FILE) {
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 256 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) {
    throw Object.assign(new Error('API key must be 16-256 characters without whitespace or control characters'), { status: 400 });
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ apiKey, updatedAt: new Date().toISOString() }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

// Key precedence: environment (CLICKQUOTA_API_KEY / API_KEY) always wins; otherwise the
// persisted admin-settings key; otherwise none. The .env file is never modified.
export function loadConfig(env = process.env, options = {}) {
  const host = env.CLICKQUOTA_HOST || env.HOST || '127.0.0.1';
  const port = Number(env.CLICKQUOTA_PORT || env.PORT || 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid CLICKQUOTA_PORT');
  const envApiKey = env.CLICKQUOTA_API_KEY || env.API_KEY || '';
  const settingsFile = options.settingsFile !== undefined ? options.settingsFile : (env === process.env ? ADMIN_SETTINGS_FILE : null);
  let storedApiKey = '';
  if (!envApiKey && settingsFile) storedApiKey = readAdminSettings(settingsFile).apiKey || '';
  
  const apiKey = envApiKey || storedApiKey;
  if (!LOOPBACK_HOSTS.includes(host) && !apiKey) {
    throw new Error('Non-loopback host requires CLICKQUOTA_API_KEY');
  }
  const keySource = envApiKey ? 'environment' : (storedApiKey ? 'admin-settings' : 'none');
  const museBaseUrl = env.MUSE_BASE_URL || 'http://127.0.0.1:18610';
  const museApiKey = env.MUSE_API_KEY || 'm2a_test_local_123456';
  return { host, port, apiKey, keySource, envKeyControlled: Boolean(envApiKey), settingsFile, thinkingEnabled: false, museBaseUrl, museApiKey };
}

export function readPoolConfig() {
  if (!fs.existsSync(STATE_FILE)) return { workspaces: [], accounts: [] };
  const config = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!Array.isArray(config.workspaces) || !Array.isArray(config.accounts)) throw new Error('workspaces and accounts must be arrays');
  for (const ws of config.workspaces) {
    const limit = Number(ws.limit ?? config.maxConcurrentPerWorkspace ?? 3);
    if (!ws.workspaceId || !ws.token || !Number.isInteger(limit) || limit < 1) throw new Error('Workspace requires workspaceId, token and positive integer limit');
  }
  return config;
}

export function persistPoolConfig(updates) {
  const current = readPoolConfig();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Tên temp duy nhất theo tiến trình: hai process ghi đồng thời không giẫm temp của nhau,
  // ghi lỗi cũng không để lại .tmp cố định vĩnh viễn.
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(Object.assign({}, current, updates, { lastUpdated: new Date().toISOString() }), null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, STATE_FILE);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* cleanup best-effort */ }
  }
}
