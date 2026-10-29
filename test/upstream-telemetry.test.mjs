import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordUpstreamAttempt,
  getUpstreamTelemetry,
  resetUpstreamTelemetry,
  WALL_THRESHOLD_MS,
} from '../src/providers/clickup/telemetry.mjs';

// 2026-10-29 (§6.5 / P2#8) — telemetry upstreamWaitMs + empty-completion theo model.
// Module giữ trạng thái in-memory toàn cục nên MỖI case phải tự reset: đây đúng là
// kiểu rò rỉ trạng thái đã làm standalone.test.mjs #15 flaky khi chạy lẻ.

test('gom số liệu theo từng model, không trộn lẫn', () => {
  resetUpstreamTelemetry();
  recordUpstreamAttempt('opus-5-5-CL', 1000, 'success');
  recordUpstreamAttempt('opus-5-5-CL', 3000, 'success');
  recordUpstreamAttempt('gpt-6-astra-CL', 500, 'error');

  const { models } = getUpstreamTelemetry();
  const opus = models.find((m) => m.model === 'opus-5-5-CL');
  const astra = models.find((m) => m.model === 'gpt-6-astra-CL');

  assert.equal(opus.attempts, 2);
  assert.equal(opus.success, 2);
  assert.equal(opus.successRate, 100);
  assert.equal(astra.attempts, 1);
  assert.equal(astra.errors, 1);
  assert.equal(astra.successRate, 0);
});

test('empty sau ngưỡng tường được tách khỏi empty thường', () => {
  resetUpstreamTelemetry();
  recordUpstreamAttempt('opus-5-5-CL', 1200, 'empty');
  recordUpstreamAttempt('opus-5-5-CL', WALL_THRESHOLD_MS + 1500, 'empty');

  const m = getUpstreamTelemetry().models[0];
  assert.equal(m.empty, 2, 'cả hai đều là empty');
  assert.equal(m.emptyAfterWall, 1, 'chỉ lần chạm tường mới tính emptyAfterWall');
});

test('retry maxTokens=1024 cứu được thì ghi nhận retryRecovered', () => {
  resetUpstreamTelemetry();
  recordUpstreamAttempt('opus-5-5-CL', WALL_THRESHOLD_MS + 2000, 'success', true);

  const m = getUpstreamTelemetry().models[0];
  assert.equal(m.success, 1);
  assert.equal(m.retryRecovered, 1);
});

test('percentile upstreamWaitMs phản ánh đuôi chậm', () => {
  resetUpstreamTelemetry();
  for (const ms of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 28000]) {
    recordUpstreamAttempt('opus-5-5-CL', ms, 'success');
  }

  const w = getUpstreamTelemetry().models[0].upstreamWaitMs;
  assert.equal(w.max, 28000, 'max giữ nguyên đuôi chậm nhất');
  assert.ok(w.p50 >= 5000 && w.p50 <= 6000, `p50 bất thường: ${w.p50}`);
  assert.ok(w.p90 >= w.p50, 'p90 phải >= p50');
});

test('không ghi nhận khi model rỗng hoặc waitMs không hợp lệ', () => {
  resetUpstreamTelemetry();
  recordUpstreamAttempt('', 1000, 'success');
  recordUpstreamAttempt(null, 1000, 'success');
  recordUpstreamAttempt('opus-5-5-CL', Number.NaN, 'success');

  assert.equal(getUpstreamTelemetry().models.length, 0);
});

test('reset xoá sạch trạng thái giữa các lần đo', () => {
  resetUpstreamTelemetry();
  recordUpstreamAttempt('opus-5-5-CL', 1000, 'success');
  assert.equal(getUpstreamTelemetry().models.length, 1);
  resetUpstreamTelemetry();
  assert.deepEqual(getUpstreamTelemetry().models, []);
});
