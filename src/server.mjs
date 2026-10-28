import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { saveAdminApiKey } from './config.mjs';
import { auditLogs } from './audit-logs.mjs';
import { createTelegramNotifier } from './alert/telegram-notifier.mjs';
import { clickupPool } from './providers/clickup/pool.mjs';
import { providerRegistry } from './providers/index.mjs';
import { CLICKUP_MODELS } from './providers/clickup/upstream.mjs';
import { normalizeResponsesRequest } from './protocols/openai-responses.mjs';
import { listKeys, createKey, toggleKey, deleteKey, isKeyAuthorized, recordKeyUsage, generateOpenAIKey, isMasterSecret } from './key-store.mjs';

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function timingSafeCompare(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa || !sb) return false;
  const ba = Buffer.from(sa);
  const bb = Buffer.from(sb);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const SECRET_FIELDS = new Set(['token', 'refreshToken', 'refreshCookie', 'cookie', 'cuRefresh', 'initialToken', 'gatewayCache', 'queue', 'mintedToken', 'sessionToken', 'apiKey', 'key']);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELDS.has(k)) continue;
    out[k] = redact(v);
  }
  return out;
}

export function extractSuppliedToken(req) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
  return req.headers["x-api-key"] || req.headers["x-admin-key"] || bearer?.[1] || "";
}

export function authorized(req, key) {
  const supplied = extractSuppliedToken(req);
  if (supplied) {
    if (isMasterSecret(supplied)) return true;
    if (key && timingSafeCompare(supplied, key)) return true;
    const storeAuth = isKeyAuthorized(supplied);
    if (storeAuth && storeAuth.ok) return true;
    return false;
  }
  if (!key) return isLocalAdmin(req);
  return false;
}

export function adminAuthorized(req, key) {
  if (isLocalAdmin(req)) return true;
  const supplied = extractSuppliedToken(req);
  // Master password chỉ tồn tại nếu được cấu hình qua CLICKQUOTA_MASTER_PASSWORD.
  if (isMasterSecret(supplied)) return true;
  // Gateway key (env/admin-settings) là credential của operator.
  if (key && timingSafeCompare(supplied, key)) return true;
  // Store key chỉ có quyền admin khi role === 'admin' — user key KHÔNG được leo thang.
  const storeAuth = isKeyAuthorized(supplied);
  return Boolean(storeAuth && storeAuth.ok && storeAuth.role === 'admin');
}

export function isLocalAdmin(req) {
  const peer = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return false;
  if (Object.keys(req.headers).some(k => k === 'forwarded' || k.startsWith('x-forwarded-') || k === 'x-real-ip')) return false;
  try {
    const authority = req.headers.host;
    if (typeof authority !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(authority)) return false;
    const scheme = req.socket?.encrypted ? 'https:' : 'http:';
    const host = new URL(scheme + '//' + authority);
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
    return true;
  } catch { return false; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('Body exceeds 2 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

const STATIC_ADMIN_ASSETS = new Map([
  ['/admin', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/admin/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/admin/admin.css', { file: 'admin.css', type: 'text/css; charset=utf-8' }],
  ['/admin/admin.js', { file: 'admin.js', type: 'text/javascript; charset=utf-8' }],
  ['/admin/connection.js', { file: 'connection.js', type: 'text/javascript; charset=utf-8' }],
]);

export function createServer(config, { notifier = createTelegramNotifier() } = {}) {
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const diagnostics = {};
    const requestId = randomUUID();
    const started = performance.now();
    const routePath = String(req.url || '').split('?')[0];
    const tracked = req.method === 'POST' && ['/v1/messages', '/v1/chat/completions', '/v1/responses'].includes(routePath);
    let recorded = false;
    const record = (aborted = false) => {
      if (!tracked || recorded) return;
      recorded = true;
      const outcome = aborted || controller.signal.aborted ? 'aborted' : diagnostics.outcome === 'error' || res.statusCode >= 400 ? 'error' : 'success';
      const durationMs = Math.round(performance.now() - started);
      notifier.recordRequest({ outcome, durationMs });
      auditLogs.request({ timestamp: new Date().toISOString(), requestId, method: req.method, path: routePath,
        protocol: routePath === '/v1/messages' ? 'anthropic' : 'openai', requestedModel: diagnostics.requestedModel,
        resolvedModel: diagnostics.model, workspaceId: diagnostics.workspaceId, stream: diagnostics.stream || false, status: res.statusCode,
        durationMs, ttftMs: diagnostics.ttftMs, inputTokens: diagnostics.inputTokens, outputTokens: diagnostics.outputTokens, outcome });
      if (outcome !== 'success') auditLogs.debug({ requestId, code: outcome === 'aborted' ? 'request_aborted' : 'request_error', level: 'error' });
    };
    res.on('finish', () => record());
    res.on('close', () => { if (!res.writableFinished) { controller.abort(); record(true); } });
    res.setHeader('x-request-id', requestId);
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;

      // ── Health & Diagnostics ──
      if (req.method === 'GET' && route === '/health') {
        return json(res, 200, { status: 'ok', service: 'clickquota' });
      }

      // ── Admin Redesign preview (/admin-next) — tách khỏi admin production ──
      // Serve prototype từ design/admin-redesign để xem trước giao diện mới mà
      // không đụng /admin đang chạy. Path traversal bị chặn (.. và backslash).
      if (req.method === 'GET' && (route === '/admin-next' || route.startsWith('/admin-next/'))) {
        const rel = route === '/admin-next' ? 'index.html' : decodeURIComponent(route.slice('/admin-next/'.length));
        if (rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
          return json(res, 403, { error: { message: 'Forbidden' } });
        }
        try {
          const designRoot = new URL('../design/admin-redesign/', import.meta.url);
          const filePath = new URL(rel, designRoot);
          if (!filePath.href.startsWith(designRoot.href)) throw new Error('traversal');
          const content = readFileSync(filePath);
          const ext = filePath.pathname.split('.').pop();
          const type = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'content-type': type,
            'cache-control': 'no-store',
            'content-security-policy': "frame-ancestors 'none'; base-uri 'self'",
            'x-frame-options': 'DENY',
            'x-content-type-options': 'nosniff',
          });
          res.end(content);
          return;
        } catch {
          return json(res, 404, { error: { message: `Design asset not found: ${rel}` } });
        }
      }

      // ── Static Admin Assets ──
      if (req.method === 'GET' && STATIC_ADMIN_ASSETS.has(route)) {
        const asset = STATIC_ADMIN_ASSETS.get(route);
        try {
          const filePath = new URL('./admin/' + asset.file, import.meta.url);
          const content = readFileSync(filePath);
          res.writeHead(200, {
            'content-type': asset.type,
            'cache-control': 'no-store, must-revalidate',
            // Không CSP script-src đầy đủ vì index.html còn inline onclick; frame-ancestors
            // chặn clickjacking các nút phá hủy (Auto-Recreate/Purge).
            'content-security-policy': "frame-ancestors 'none'; base-uri 'self'",
            'x-frame-options': 'DENY',
            'x-content-type-options': 'nosniff',
          });
          res.end(content);
          return;
        } catch (e) {
          return json(res, 404, { error: { message: `Asset not found: ${asset.file}` } });
        }
      }

      // ── Admin Access Verification Endpoint ──
      if (req.method === 'GET' && route === '/admin/api/access') {
        const isLocal = isLocalAdmin(req);
        return json(res, 200, {
          mode: config.apiKey ? 'key' : 'local',
          localAllowed: isLocal,
          authorized: adminAuthorized(req, config.apiKey),
        });
      }

      if (route === '/admin/api/connection' || route === '/admin/api/key' || route === '/admin/api/logs') {
        res.setHeader('cache-control', 'no-store');
        const local = isLocalAdmin(req);
        if (!adminAuthorized(req, config.apiKey)) return json(res, 401, { error: 'Unauthorized' });
        if (route === '/admin/api/connection' && req.method === 'GET') {
          return json(res, 200, { keyConfigured: Boolean(config.apiKey), keySource: config.keySource || (config.apiKey ? 'environment' : 'none'), rotationAllowed: !config.envKeyControlled && (!config.apiKey || config.keySource === 'admin-settings'), models: CLICKUP_MODELS, masterAuthEnabled: Boolean(process.env.CLICKQUOTA_MASTER_PASSWORD) });
        }
        if (route === '/admin/api/key' && req.method === 'GET') {
          if (!local) return json(res, 403, { error: 'Local administrative access required to view key' });
          // Không trả plaintext key qua GET (README: "GET không trả khóa hiện hữu").
          return json(res, 200, {
            ok: true,
            keyConfigured: Boolean(config.apiKey),
            masked: config.apiKey ? (config.apiKey.length > 12 ? config.apiKey.slice(0, 7) + '••••••••' + config.apiKey.slice(-4) : '••••••••') : '',
            keySource: config.keySource || (config.apiKey ? 'environment' : 'none'),
            rotationAllowed: !config.envKeyControlled && (!config.apiKey || config.keySource === 'admin-settings'),
          });
        }
        if (route === '/admin/api/logs' && req.method === 'GET') {
          const options = { limit: url.searchParams.get('limit'), requestId: url.searchParams.get('requestId'), code: url.searchParams.get('code'), outcome: url.searchParams.get('outcome') };
          return json(res, 200, { entries: url.searchParams.get('kind') === 'debug' ? auditLogs.getDebug(options) : auditLogs.getRequests(options), limits: auditLogs.limits });
        }
        if (route === '/admin/api/key' && req.method === 'POST') {
          if (!local || !authorized(req, config.apiKey)) return json(res, 403, { error: 'Local authenticated request required' });
          if (config.envKeyControlled || config.keySource === 'environment' || (config.apiKey && !config.keySource)) return json(res, 409, { error: 'Environment-controlled key: change environment and restart; .env is never edited' });
          const body = await readBody(req);
          if (!body || body.confirm !== true || !['generate', 'rotate', 'set'].includes(body.action)) return json(res, 400, { error: 'Explicit confirmation and valid action required' });
          const key = body.action === 'set' ? body.key : generateOpenAIKey();
          saveAdminApiKey(key, config.settingsFile);
          config.apiKey = key;
          config.keySource = 'admin-settings';
          auditLogs.debug({ code: 'key_changed', level: 'info', requestId });
          return json(res, 200, body.action === 'set' ? { ok: true } : { ok: true, key });
        }
        return json(res, 405, { error: 'Method not allowed' });
      }

      // ── Sharkpool API Key Management (/admin/api/keys/*) ──
      if (route.startsWith("/admin/api/keys")) {
        res.setHeader("cache-control", "no-store");
        if (!adminAuthorized(req, config.apiKey)) {
          return json(res, 401, { ok: false, error: "Unauthorized: Admin authentication required" });
        }

        if (route === "/admin/api/keys" && req.method === "GET") {
          return json(res, 200, { ok: true, keys: listKeys(), masterAuthEnabled: Boolean(process.env.CLICKQUOTA_MASTER_PASSWORD) });
        }

        if (route === "/admin/api/keys/create" && req.method === "POST") {
          const body = await readBody(req);
          const created = createKey({
            label: body.label,
            role: body.role || "user",
            requestLimit: body.requestLimit,
            tokenLimit: body.tokenLimit,
          });
          return json(res, 200, { ok: true, key: created, keys: listKeys() });
        }

        if (route === "/admin/api/keys/toggle" && req.method === "POST") {
          const body = await readBody(req);
          const toggled = toggleKey(body.id, body.active);
          if (!toggled) return json(res, 404, { ok: false, error: "Key not found" });
          // 2026-10-28: trả masked view — không bơm plaintext key qua response phụ.
          const { key: _omit, ...pub } = toggled;
          return json(res, 200, { ok: true, key: pub, keys: listKeys() });
        }

        if (route === "/admin/api/keys" && req.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json(res, 400, { ok: false, error: "Missing key id" });
          const removed = deleteKey(id);
          return json(res, 200, { ok: true, removed, keys: listKeys() });
        }

        return json(res, 405, { ok: false, error: "Method not allowed" });
      }

      // ── Admin APIs (/admin/api/clickup/*) ──
      if (route.startsWith('/admin/api/clickup/')) {
        const adminAllowed = adminAuthorized(req, config.apiKey);
        if (!adminAllowed) {
          return json(res, 401, { ok: false, error: 'Unauthorized: Invalid API Key' });
        }

        // Quota refresh & audit health check for entire pool
        if ((route === '/admin/api/clickup/quota/refresh' || route === '/admin/api/clickup/refresh') && req.method === 'POST') {
          try { await clickupPool.auditAllWorkspacesQuota(); } catch (err) { console.warn('[ClickQuota] Quota audit warning:', err.message); }
          return json(res, 200, {
            ok: true,
            message: 'Đã kiểm tra sức khỏe và quota toàn pool thành công',
            workspaces: clickupPool.getSnapshot(),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Status & Summary
        if (route === '/admin/api/clickup/status' && req.method === 'GET') {
          if (url.searchParams.get('refresh') === '1' || url.searchParams.get('audit') === '1') {
            await clickupPool.auditAllWorkspacesQuota();
          }
          return json(res, 200, {
            ok: true,
            workspaces: clickupPool.getSnapshot(),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Workspaces list
        if (route === '/admin/api/clickup/workspaces' && req.method === 'GET') {
          return json(res, 200, { ok: true, workspaces: clickupPool.getSnapshot() });
        }

        // Workspace add
        if (route === '/admin/api/clickup/workspaces/add' && req.method === 'POST') {
          const body = await readBody(req);
          const result = await clickupPool.addWorkspace(body);
          return json(res, 200, {
            ok: true,
            result: redact(result),
            workspaces: clickupPool.getSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Workspace toggle
        if (route === '/admin/api/clickup/workspaces/toggle' && req.method === 'POST') {
          const body = await readBody(req);
          const ws = clickupPool.toggleWorkspace(body.id, body.enabled);
          return json(res, 200, {
            ok: true,
            workspace: redact(ws),
            workspaces: clickupPool.getSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Workspace delete
        if (route === '/admin/api/clickup/workspaces' && req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const removed = clickupPool.removeWorkspace(id);
          return json(res, 200, {
            ok: true,
            removed: redact(removed),
            workspaces: clickupPool.getSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Workspace renew
        if (route === '/admin/api/clickup/workspaces/renew' && req.method === 'POST') {
          const body = await readBody(req);
          const ws = clickupPool.workspaces.find(w => w.id === body.id || w.workspaceId === body.id);
          if (!ws) throw Object.assign(new Error('Workspace không tồn tại'), { status: 404 });
          const renewal = await clickupPool.renewSessionToken(ws);
          return json(res, 200, {
            ok: true,
            renewal,
            workspaces: clickupPool.getSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Workspace clear cooldown
        if (route === '/admin/api/clickup/workspaces/clear-cooldown' && req.method === 'POST') {
          const body = await readBody(req);
          clickupPool.clearCooldown(body.id);
          return json(res, 200, {
            ok: true,
            workspaces: clickupPool.getSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Accounts list
        if (route === '/admin/api/clickup/accounts' && req.method === 'GET') {
          return json(res, 200, { ok: true, accounts: clickupPool.getAccountsSnapshot() });
        }

        // Account add (with automatic ClickUp active verification)
        if (route === '/admin/api/clickup/accounts/add' && req.method === 'POST') {
          const body = await readBody(req);
          try {
            const result = await clickupPool.addAccount({ ...body, verify: body?.verify ?? true });
            return json(res, 200, {
              ok: true,
              result: redact(result),
              verified: result.verified,
              accounts: clickupPool.getAccountsSnapshot(),
              summary: clickupPool.getPoolSummary(),
            });
          } catch (err) {
            return json(res, 400, {
              ok: false,
              error: err.message || 'Xác thực tài khoản với ClickUp thất bại',
            });
          }
        }

        // Account verify (active live check with ClickUp)
        if (route === '/admin/api/clickup/accounts/verify' && req.method === 'POST') {
          const body = await readBody(req);
          let target = null;
          if (body.id) {
            target = clickupPool.accounts.find(a => a.id === body.id);
            if (!target) throw Object.assign(new Error('Tài khoản không tồn tại trong hệ thống'), { status: 404 });
          } else {
            target = body;
          }

          try {
            const verified = await clickupPool.verifyAccount(target);
            return json(res, 200, {
              ok: true,
              verified: redact(verified),
              accounts: clickupPool.getAccountsSnapshot(),
              summary: clickupPool.getPoolSummary(),
            });
          } catch (err) {
            return json(res, 400, {
              ok: false,
              error: err.message || 'Xác thực tài khoản thất bại',
            });
          }
        }

        // Account toggle
        if (route === '/admin/api/clickup/accounts/toggle' && req.method === 'POST') {
          const body = await readBody(req);
          const acc = clickupPool.toggleAccount(body.id, body.enabled);
          return json(res, 200, {
            ok: true,
            account: redact(acc),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Account delete
        if (route === '/admin/api/clickup/accounts' && req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const removed = clickupPool.removeAccount(id);
          return json(res, 200, {
            ok: true,
            removed: redact(removed),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Account renew
        if (route === '/admin/api/clickup/accounts/renew' && req.method === 'POST') {
          const body = await readBody(req);
          const resRenew = await clickupPool.renewAccount(body.id);
          return json(res, 200, {
            ok: true,
            renewal: resRenew,
            workspaces: clickupPool.getSnapshot(),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

        // Auto recreate workspaces & activate Trial MAX 23
        if (route === '/admin/api/clickup/auto-recreate' && req.method === 'POST') {
          const body = await readBody(req);
          const result = await clickupPool.autoRecreateWorkspaces({
            accountId: body.accountIds || body.accountId || null,
            countPerAccount: Number(body.count || 10),
            reason: 'Thao tác thủ công từ Admin UI',
          });
          return json(res, 200, {
            ok: true,
            result: redact(result),
            workspaces: clickupPool.getSnapshot(),
            accounts: clickupPool.getAccountsSnapshot(),
            summary: clickupPool.getPoolSummary(),
          });
        }

                // Test ClickUp model upstream (Enhanced with latency & reasoning)
        if (route === '/admin/api/clickup/test' && req.method === 'POST') {
          const body = await readBody(req);
          const { executePooledUpstream, extractReplyText, resolveClickUpModel, splitThinkingAndContent } = await import('./clickup-upstream.mjs');
          const reqModel = body.model || 'gpt-6.1-sol-CL';
          const prompt = body.prompt || 'Kiểm tra kết nối ClickUp AI Gateway Pool ClickQuota';
          const resolved = resolveClickUpModel(reqModel);

          const payload = {
            operationName: 'AIRequest',
            variables: {
              type: 'CHAT_COMPLETION',
              input: {
                model: resolved,
                selectedModel: resolved,
                prompt,
                text: prompt,
                messages: [{ role: 'user', content: prompt }],
              },
            },
            query: `query AIRequest($type: AIRequestType!, $input: JSONObject!) {
  aiRequest(type: $type, input: $input) {
    completionString
    reasoning
    errors
  }
}`,
          };

          const start = Date.now();
          const upstreamResult = await executePooledUpstream({ payload, workspaceId: body.workspaceId || null });
          const latencyMs = Date.now() - start;
          const fullReply = extractReplyText(upstreamResult.parsed);
          const { thinking, content } = splitThinkingAndContent(fullReply);

          return json(res, 200, {
            ok: true,
            model: reqModel,
            resolvedModel: resolved,
            latencyMs,
            reply: content || fullReply,
            thinking: thinking || '',
            workspace: upstreamResult.workspace?.label,
            workspaceId: upstreamResult.workspace?.workspaceId,
          });
        }

        // Test ClickUp AI Agent & Tool Calling Simulation
        if (route === '/admin/api/clickup/agent/test' && req.method === 'POST') {
          const body = await readBody(req);
          const {
            executePooledUpstream,
            extractReplyText,
            resolveClickUpModel,
            formatToolsPrompt,
            parseToolCallsFromText,
            splitThinkingAndContent,
            sanitizeMessagesForUpstream,
          } = await import('./clickup-upstream.mjs');

          const reqModel = body.model || 'super-agent-CL';
          const prompt = body.prompt || 'Bạn là AI Agent. Hãy đọc file README.md trong thư mục hiện tại và tóm tắt.';
          const resolved = resolveClickUpModel(reqModel);
          const mode = body.mode || 'agent'; // 'agent' | 'chat' | 'tools_completion'

          let tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;
          if (mode === 'agent' && !tools) {
            tools = [
              {
                name: 'execute_command',
                description: 'Execute a bash command in the terminal',
                parameters: {
                  type: 'object',
                  properties: {
                    CommandLine: { type: 'string', description: 'The bash command to run' },
                  },
                  required: ['CommandLine'],
                },
              },
              {
                name: 'read_file',
                description: 'Read the contents of a file from filesystem',
                parameters: {
                  type: 'object',
                  properties: {
                    AbsolutePath: { type: 'string', description: 'The path to file to read' },
                  },
                  required: ['AbsolutePath'],
                },
              },
              {
                name: 'write_to_file',
                description: 'Create or overwrite a file with contents',
                parameters: {
                  type: 'object',
                  properties: {
                    TargetFile: { type: 'string', description: 'Path to file' },
                    CodeContent: { type: 'string', description: 'Content to write' },
                  },
                  required: ['TargetFile', 'CodeContent'],
                },
              },
            ];
          }

          let toolsPrompt = '';
          if (tools && tools.length > 0) {
            toolsPrompt = formatToolsPrompt(tools, 'roo-cline');
          }

          const fullPrompt = toolsPrompt ? `${toolsPrompt}\n\n${prompt}` : prompt;
          const messages = sanitizeMessagesForUpstream([{ role: 'user', content: prompt }], fullPrompt, toolsPrompt);

          const payload = {
            operationName: 'AIRequest',
            variables: {
              type: mode === 'tools_completion' ? 'TOOLS_COMPLETION' : 'CHAT_COMPLETION',
              input: {
                model: resolved,
                selectedModel: resolved,
                prompt: fullPrompt,
                text: fullPrompt,
                messages,
              },
            },
            query: `query AIRequest($type: AIRequestType!, $input: JSONObject!) {
  aiRequest(type: $type, input: $input) {
    completionString
    reasoning
    errors
  }
}`,
          };

          const start = Date.now();
          const upstreamResult = await executePooledUpstream({
            payload,
            workspaceId: body.workspaceId || null,
          });
          const latencyMs = Date.now() - start;

          const rawReply = extractReplyText(upstreamResult.parsed);
          const { thinking, content } = splitThinkingAndContent(rawReply);
          const parsedTool = parseToolCallsFromText(content || rawReply, tools || [], 'roo-cline');

          return json(res, 200, {
            ok: true,
            model: reqModel,
            resolvedModel: resolved,
            mode,
            latencyMs,
            workspace: upstreamResult.workspace?.label,
            workspaceId: upstreamResult.workspace?.workspaceId,
            thinking: thinking || '',
            reply: content || rawReply,
            toolCalls: parsedTool?.calls || (parsedTool ? [parsedTool] : []),
            rawCall: parsedTool?.rawCall || null,
            toolsProvided: tools ? tools.map((t) => t.name) : [],
            rawGraphQL: upstreamResult.parsed,
          });
        }

        return json(res, 404, { ok: false, error: 'Admin API route not found' });
      }

      // ── API Authentication Check for Client Invocations ──
      if (!authorized(req, config.apiKey)) {
        return json(res, 401, { error: { message: 'Unauthorized' } });
      }

      // ── Model listing & Unified Status APIs ──
      if (req.method === 'GET' && route === '/v1/models') {
        const models = await providerRegistry.getAllModels();
        return json(res, 200, {
          object: 'list',
          data: models,
        });
      }
      if (req.method === 'GET' && route === '/api/status') {
        const statuses = await providerRegistry.getAllStatuses();
        return json(res, 200, {
          summary: clickupPool.getPoolSummary(),
          workspaces: clickupPool.getSnapshot(),
          providers: statuses,
          muse: statuses.muse,
        });
      }
      if (req.method === 'POST' && route === '/api/quota/refresh') {
        if (!adminAuthorized(req, config.apiKey) && !authorized(req, config.apiKey)) {
          return json(res, 401, { error: { message: 'Unauthorized' } });
        }
        await clickupPool.auditAllWorkspacesQuota();
        return json(res, 200, { workspaces: clickupPool.getSnapshot() });
      }

      // ── Media Endpoints (Images & Videos via Muse Provider) ──
      const isMuseMediaEndpoint = route.startsWith('/v1/images') || route.startsWith('/v1/videos') || route.startsWith('/v1/media');
      if (isMuseMediaEndpoint) {
        const rawBody = req.method === 'POST' ? await readBody(req) : null;
        const muse = providerRegistry.get('muse');
        if (muse) {
          await muse.handleRequest({
            req,
            res,
            rawBody,
            route,
            config,
            signal: controller.signal,
            diagnostics,
            requestedModel: rawBody?.model || 'image',
            requestId,
          });
          return;
        }
      }

      // ── Token Counting Endpoint (/v1/messages/count_tokens) ──
      if (req.method === 'POST' && (route === '/v1/messages/count_tokens' || route.endsWith('/count_tokens'))) {
        const rawBody = await readBody(req);
        const { estimateTokens } = await import('./tokens.mjs');
        const count = estimateTokens(rawBody?.messages || rawBody?.prompt || rawBody);
        return json(res, 200, { input_tokens: Math.max(1, count) });
      }

      // ── AI Inference Dispatch ──
      const isMessagesEndpoint = route === '/v1/messages' || route.endsWith('/messages');
      const isChatEndpoint = route === '/v1/chat/completions' || route.endsWith('/chat/completions');
      const isResponsesEndpoint = route === '/v1/responses' || route.endsWith('/responses');

      if (req.method !== 'POST' || (!isMessagesEndpoint && !isChatEndpoint && !isResponsesEndpoint)) {
        return json(res, 404, { error: { message: 'Not found' } });
      }

      let rawBody = await readBody(req);
      if (isResponsesEndpoint) {
        try {
          rawBody = normalizeResponsesRequest(rawBody);
        } catch (err) {
          // 2026-10-28 (P3): RangeError (payload lồng quá sâu) không lộ message nội bộ.
          const isRange = err instanceof RangeError || /Maximum call stack/i.test(err?.message || '');
          return json(res, 400, {
            error: {
              message: isRange ? 'Input payload is too deeply nested or malformed.' : err.message,
              type: err.type || 'invalid_request_error',
              param: err.param ?? 'input',
              code: err.code || 'invalid_value',
            },
          });
        }
      }
      diagnostics.stream = Boolean(rawBody?.stream);

      const requestedModel = rawBody?.model || '';
      // Sanitize model NGAY TỪ ĐẦU: mọi nhánh trả sớm (400/503/404) vẫn ghi log đúng,
      // và log không bao giờ nhận model name thô do client tự đặt.
      const rawModelStr = String(requestedModel || '');
      diagnostics.requestedModel = rawModelStr && (CLICKUP_MODELS.includes(rawModelStr) || /-cl$/i.test(rawModelStr)) ? rawModelStr : 'other';
      let provider = providerRegistry.findForModel(requestedModel);

      // Validate messages payload
      if (!rawBody || !Array.isArray(rawBody.messages) || !rawBody.messages.length || rawBody.messages.some(m => !m || typeof m !== 'object')) {
        return json(res, 400, { error: { message: 'messages must be a non-empty array of message objects' } });
      }

      // Failover tự động: Nếu ClickUp pool không còn workspace khả dụng, tự động chuyển sang Muse khi được kích hoạt
      if (provider?.name === 'clickup' && !clickupPool.workspaces.some(w => w.enabled && w.token)) {
        if (config?.enableFailoverToMuse) {
          const muse = providerRegistry.get('muse');
          if (muse) {
            const museStatus = await muse.getStatus();
            if (museStatus.online) {
              console.log('[ClickQuota] ClickUp pool cạn kiệt, tự động chuyển hướng failover sang Muse...');
              provider = muse;
            }
          }
        }
        if (provider?.name === 'clickup') {
          return json(res, 503, { error: { message: 'Dịch vụ tạm thời chưa sẵn sàng. Vui lòng thử lại sau.', type: 'upstream_unavailable', code: 'upstream_unavailable' } });
        }
      }

      const clientKey = extractSuppliedToken(req);
      try {
        if (provider) {
          diagnostics.upstreamProvider = provider.name;
          await provider.handleRequest({
            req,
            res,
            rawBody,
            route,
            config,
            signal: controller.signal,
            diagnostics,
            requestedModel,
            requestId,
          });
          return;
        }
      } finally {
        // Ghi usage SAU khi handler chạy xong để diagnostics.outputTokens đã có giá trị
        // thật — nếu không, tokensUsed luôn 0 và tokenLimit không bao giờ khớp.
        if (clientKey && !isMasterSecret(clientKey)) {
          try { recordKeyUsage(clientKey, diagnostics.outputTokens || 0); } catch { /* accounting must not break serving */ }
        }
      }

      return json(res, 404, { error: { message: `No provider found for model "${requestedModel}"` } });
    } catch (err) {
      diagnostics.outcome = controller.signal.aborted ? 'aborted' : 'error';
      auditLogs.debug({ code: 'server_error', requestId, level: 'error' });
      if (!res.headersSent) {
        json(res, err.status || 500, { error: { message: err.message || 'Internal server error' } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  server.on('listening', () => notifier.start());
  server.on('close', () => notifier.close());
  server.requestTimeout = 180000;
  server.headersTimeout = 15000;
  return server;
}
