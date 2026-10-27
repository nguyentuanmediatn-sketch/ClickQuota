import http from 'node:http';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

export const MUSE_DEFAULT_URL = process.env.MUSE_BASE_URL || 'http://127.0.0.1:18610';
export const MUSE_DEFAULT_KEY = process.env.MUSE_API_KEY || 'm2a_test_local_123456';

export const MUSE_MODELS = [
  'spark',
  'muse-spark',
  'mu/muse-spark',
  'mu/spark',
  'image',
  'muse-image',
  'mu/muse-image',
  'mu/image',
  'video',
  'muse-video',
  'mu/muse-video',
  'mu/video',
];

export function isMuseModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase().trim().replace(/[-_]thinking$/i, '');
  if (m.startsWith('mu/') || m.startsWith('muse/')) return true;
  if (['spark', 'muse-spark', 'image', 'muse-image', 'video', 'muse-video'].includes(m)) return true;
  return m.includes('muse-spark') || m.includes('muse2api');
}

export function normalizeMuseModel(model) {
  if (!model || typeof model !== 'string') return 'spark';
  let m = model.toLowerCase().trim().replace(/[-_]thinking$/i, '');
  if (m.startsWith('mu/') || m.startsWith('muse/')) {
    m = m.slice(m.indexOf('/') + 1);
  }
  if (m === 'muse-spark') return 'spark';
  if (m === 'muse-image') return 'image';
  if (m === 'muse-video') return 'video';
  return m;
}

export async function checkMuseHealth(baseUrl = MUSE_DEFAULT_URL) {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/healthz`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    const ok = res.status === 200;
    return {
      online: ok,
      status: res.status,
      latencyMs: Date.now() - start,
      baseUrl,
      models: ['spark', 'image', 'video'],
    };
  } catch (err) {
    return {
      online: false,
      error: err.message,
      latencyMs: Date.now() - start,
      baseUrl,
      models: [],
    };
  }
}

export async function handleMuseRequest({ req, res, rawBody, route, config, signal, diagnostics, requestedModel, requestId }) {
  const targetModel = normalizeMuseModel(requestedModel || rawBody?.model);
  const baseUrl = config?.museBaseUrl || MUSE_DEFAULT_URL;
  const apiKey = config?.museApiKey || MUSE_DEFAULT_KEY;

  const wantsStream = Boolean(rawBody?.stream);
  const targetUrl = `${baseUrl}${route}`;

  const payload = {
    ...rawBody,
    model: targetModel,
  };

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': wantsStream ? 'text/event-stream' : 'application/json',
  };

  if (diagnostics) {
    diagnostics.upstreamProvider = 'muse';
    diagnostics.model = targetModel;
  }

  const upstreamRes = await fetch(targetUrl, {
    method: req.method || 'POST',
    headers,
    body: req.method === 'GET' ? undefined : JSON.stringify(payload),
    signal,
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    let parsedErr;
    try { parsedErr = JSON.parse(errText); } catch { parsedErr = { error: { message: errText } }; }
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(parsedErr));
    return;
  }

  if (wantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'x-proxy-upstream-provider': 'muse',
      'x-proxy-upstream-model': targetModel,
    });

    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch (streamErr) {
      if (!signal?.aborted) {
        console.error(`[MuseProvider] Stream error:`, streamErr.message);
      }
    } finally {
      res.end();
    }
  } else {
    const data = await upstreamRes.json();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'x-proxy-upstream-provider': 'muse',
      'x-proxy-upstream-model': targetModel,
    });
    res.end(JSON.stringify(data));
  }
}
