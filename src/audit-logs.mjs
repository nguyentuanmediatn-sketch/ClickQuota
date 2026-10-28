import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.mjs';

export const LOG_DIR = process.env.CLICKQUOTA_LOG_DIR ? path.resolve(process.env.CLICKQUOTA_LOG_DIR) : path.join(APP_ROOT, '.state', 'logs');
export const REQUEST_LOG = path.join(LOG_DIR, 'request-log.jsonl');
export const DEBUG_LOG = path.join(LOG_DIR, 'debug-log.jsonl');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY = 500;
const SAFE_FIELDS = new Set(['timestamp', 'requestId', 'method', 'path', 'protocol', 'requestedModel', 'resolvedModel', 'workspaceId', 'stream', 'status', 'durationMs', 'ttftMs', 'inputTokens', 'outputTokens', 'outcome', 'errorCode', 'code', 'level']);
const SAFE_PATHS = new Set(['/v1/messages', '/v1/chat/completions', '/v1/responses', '/v1/models', '/health', '/api/status', '/api/quota/refresh']);
// 2026-10-28 (P3): bổ sung code crash-handler của index.mjs — trước đây bị coerce
// thành 'server_error' khiến không phân biệt được uncaught_exception trong log.
const SAFE_CODES = new Set(['server_start', 'config_loaded', 'key_changed', 'config_error', 'request_error', 'request_aborted', 'upstream_error', 'stream_error', 'server_error', 'uncaught_exception', 'unhandled_rejection']);
const memory = { request: [], debug: [] };

function cleanRecord(kind, data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (key === 'path') {
      if (SAFE_PATHS.has(value)) out.path = value;
      continue;
    }
    if (key === 'requestId') {
      if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) out.requestId = value;
      continue;
    }
    if (key === 'requestedModel' || key === 'resolvedModel') {
      if (typeof value === 'string' && /^[a-zA-Z0-9._/-]{1,100}$/.test(value)) out[key] = value;
      continue;
    }
    if (key === 'workspaceId') {
      if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) out.workspaceId = value;
      continue;
    }
    if (key === 'protocol') {
      if (value === 'openai' || value === 'anthropic') out.protocol = value;
      continue;
    }
    if (key === 'method') { if (value === 'GET' || value === 'POST') out.method = value; continue; }
    if (key === 'outcome') { if (['success', 'error', 'aborted'].includes(value)) out.outcome = value; continue; }
    if (key === 'level') { if (['info', 'warn', 'error'].includes(value)) out.level = value; continue; }
    if (key === 'code') { if (SAFE_CODES.has(value)) out.code = value; continue; }
    if (key === 'errorCode') { if (typeof value === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(value)) out.errorCode = value; continue; }
    if (key === 'stream') { if (typeof value === 'boolean') out.stream = value; continue; }
    if (['status', 'durationMs', 'ttftMs', 'inputTokens', 'outputTokens'].includes(key) && Number.isFinite(Number(value))) out[key] = Math.max(0, Math.min(Number(value), 2_147_483_647));
    if (key === 'timestamp' && typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) out.timestamp = value;
  }
  if (!out.timestamp) out.timestamp = new Date().toISOString();
  if (kind === 'debug' && !out.code) out.code = 'server_error';
  return out;
}

function fileFor(kind) { return kind === 'request' ? REQUEST_LOG : DEBUG_LOG; }
function append(kind, data) {
  const row = cleanRecord(kind, data);
  const arr = memory[kind];
  arr.push(row);
  if (arr.length > MAX_MEMORY) arr.splice(0, arr.length - MAX_MEMORY);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const file = fileFor(kind);
    const line = JSON.stringify(row) + '\n';
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
      const rotated = `${file}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch {}
      try { fs.renameSync(file, rotated); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch { /* diagnostics must never break inference */ }
  return row;
}

function loadFile(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, Math.max(0, stat.size - length));
      return buf.toString('utf8').split('\n').filter(Boolean).flatMap(line => {
        try { const parsed = JSON.parse(line); return [parsed]; } catch { return []; }
      });
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}
function get(kind, options = {}) {
  const file = fileFor(kind);
  let result = memory[kind].slice();
  const id = typeof options.requestId === 'string' ? options.requestId.slice(0, 80) : '';
  if (id) result = result.filter(row => row.requestId === id);
  if (kind === 'debug' && options.code) result = result.filter(row => row.code === options.code);
  if (kind === 'request' && options.outcome) result = result.filter(row => row.outcome === options.outcome);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  return result.slice(-limit);
}

// Reload bounded history after restart (each file is read at most MAX_FILE_BYTES, memory keeps MAX_MEMORY rows).
for (const kind of ['request', 'debug']) {
  const file = fileFor(kind);
  memory[kind] = loadFile(file + '.1').concat(loadFile(file)).map(row => cleanRecord(kind, row)).slice(-MAX_MEMORY);
}

export const auditLogs = {
  request: data => append('request', data),
  debug: data => append('debug', data),
  getRequests: options => get('request', options),
  getDebug: options => get('debug', options),
  limits: { maxFileBytes: MAX_FILE_BYTES, maxMemory: MAX_MEMORY, maxRead: 200 },
};
