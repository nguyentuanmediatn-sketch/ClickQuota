// ClickQuota Sharkpool-Style Key Store
// Chuẩn API Key OpenAI (sk-[48 ký tự alphanumeric]) & Quản trị hạn mức / thống kê request

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const KEYS_FILE = path.join(APP_ROOT, '.state', 'api_keys.json');
export const MASTER_ADMIN_PASSWORD = 'Tuan2005@!@#!@#';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Sinh API Key chuẩn OpenAI: sk- + 48 ký tự alphanumeric ngẫu nhiên
export function generateOpenAIKey() {
  const bytes = randomBytes(48);
  let str = 'sk-';
  for (let i = 0; i < 48; i++) {
    str += CHARS[bytes[i] % CHARS.length];
  }
  return str;
}

// Đọc toàn bộ danh sách keys từ đĩa. Nếu chưa có, tự khởi tạo 1 Master Key mặc định.
export function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) {
      const defaultKey = {
        id: 'key_' + randomBytes(8).toString('hex'),
        key: generateOpenAIKey(),
        label: 'Default Gateway Key (Sharkpool)',
        role: 'admin',
        active: true,
        requestLimit: null,
        tokenLimit: null,
        requestsCount: 0,
        tokensUsed: 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      };
      saveKeys([defaultKey]);
      return [defaultKey];
    }
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.error('Lỗi khi đọc file api_keys.json:', err.message);
    return [];
  }
}

// Lưu nguyên tử danh sách keys xuống đĩa (atomic write)
export function saveKeys(keys) {
  const dir = path.dirname(KEYS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = KEYS_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(keys, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, KEYS_FILE);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch {}
  }
}

// Trả về danh sách keys với key được ẩn nhẹ (nếu cần) hoặc đầy đủ
export function listKeys() {
  const keys = loadKeys();
  return keys.map(k => ({
    ...k,
    masked: k.key ? k.key.slice(0, 7) + '••••••••' + k.key.slice(-4) : ''
  }));
}

// Tạo key mới
export function createKey({ label, role = 'user', requestLimit = null, tokenLimit = null } = {}) {
  const keys = loadKeys();
  const id = 'key_' + randomBytes(8).toString('hex');
  const key = generateOpenAIKey();
  const newKey = {
    id,
    key,
    label: (label && typeof label === 'string' && label.trim()) ? label.trim() : ('Key #' + (keys.length + 1)),
    role: role === 'admin' ? 'admin' : 'user',
    active: true,
    requestLimit: (requestLimit && Number(requestLimit) > 0) ? Math.floor(Number(requestLimit)) : null,
    tokenLimit: (tokenLimit && Number(tokenLimit) > 0) ? Math.floor(Number(tokenLimit)) : null,
    requestsCount: 0,
    tokensUsed: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  keys.unshift(newKey);
  saveKeys(keys);
  return newKey;
}

// Bật / tắt key
export function toggleKey(id, active) {
  const keys = loadKeys();
  const target = keys.find(k => k.id === id);
  if (!target) return null;
  target.active = Boolean(active);
  saveKeys(keys);
  return target;
}

// Xóa key
export function deleteKey(id) {
  let keys = loadKeys();
  const initialLen = keys.length;
  keys = keys.filter(k => k.id !== id);
  if (keys.length !== initialLen) {
    saveKeys(keys);
    return true;
  }
  return false;
}

// Tìm key và kiểm tra hợp lệ
export function findKey(keyString) {
  if (!keyString || typeof keyString !== 'string') return null;
  const clean = keyString.trim();
  const keys = loadKeys();
  return keys.find(k => k.key === clean) || null;
}

// Ghi nhận lượt sử dụng và token
export function recordKeyUsage(keyString, tokens = 0) {
  if (!keyString || typeof keyString !== 'string') return;
  const clean = keyString.trim();
  const keys = loadKeys();
  const target = keys.find(k => k.key === clean);
  if (target) {
    target.requestsCount = (target.requestsCount || 0) + 1;
    target.tokensUsed = (target.tokensUsed || 0) + Math.max(0, Number(tokens) || 0);
    target.lastUsedAt = new Date().toISOString();
    saveKeys(keys);
  }
}

// Kiểm tra key có quyền truy cập API Client không
export function isKeyAuthorized(keyString, masterPassword = MASTER_ADMIN_PASSWORD) {
  if (!keyString || typeof keyString !== 'string') return false;
  const clean = keyString.trim();
  // 1. Master Admin Password luôn được phép
  if (clean === masterPassword || clean === MASTER_ADMIN_PASSWORD || clean === 'Tuan2005@!@#!@#') {
    return { ok: true, isMaster: true, role: 'admin' };
  }
  // 2. Tra cứu trong Sharkpool Key Store
  const found = findKey(clean);
  if (!found) return false;
  if (!found.active) return false;
  if (found.requestLimit && found.requestsCount >= found.requestLimit) return false;
  if (found.tokenLimit && found.tokensUsed >= found.tokenLimit) return false;
  return { ok: true, isMaster: false, ...found };
}
