import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

// Endpoint /diagnostics/models lộ model id, tỉ lệ lỗi và hành vi upstream.
// Nó nằm TRƯỚC lớp authorized() chung trong handler, nên phải tự kiểm tra auth.
// Các test dưới khoá đúng hành vi đó: nếu ai đó di chuyển route hoặc bỏ guard,
// test phải đỏ chứ không im lặng mở công khai số liệu vận hành.

const API_KEY = 'secret123';

async function withServer(fn) {
  const server = createServer({ apiKey: API_KEY });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/diagnostics/models`;
  try {
    return await fn(url);
  } finally {
    await new Promise(r => server.close(r));
  }
}

// Header x-forwarded-* tắt tin cậy loopback trong isLocalAdmin, nên đây là cách
// mô phỏng một caller đi qua proxy / đến từ ngoài máy.
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };

test('caller ngoài loopback không có key bị từ chối', async () => {
  await withServer(async url => {
    const res = await fetch(url, { headers: { ...REMOTE } });
    assert.equal(res.status, 401);
  });
});

test('caller ngoài loopback với key sai bị từ chối', async () => {
  await withServer(async url => {
    const res = await fetch(url, { headers: { ...REMOTE, authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
  });
});

test('key đúng được phép và trả về khung telemetry', async () => {
  await withServer(async url => {
    const res = await fetch(url, {
      headers: { ...REMOTE, authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.models), 'models phải là mảng');
    assert.equal(typeof body.wallThresholdMs, 'number');
    assert.equal(typeof body.maxSamplesPerModel, 'number');
  });
});

test('x-api-key cũng được chấp nhận như bearer', async () => {
  await withServer(async url => {
    const res = await fetch(url, { headers: { ...REMOTE, 'x-api-key': API_KEY } });
    assert.equal(res.status, 200);
  });
});

test('endpoint không trả về token hay secret', async () => {
  await withServer(async url => {
    const res = await fetch(url, {
      headers: { ...REMOTE, authorization: `Bearer ${API_KEY}` },
    });
    const raw = JSON.stringify(await res.json());
    assert.ok(!raw.includes(API_KEY), 'không được phản chiếu api key');
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(raw), 'không được rò JWT workspace');
  });
});
