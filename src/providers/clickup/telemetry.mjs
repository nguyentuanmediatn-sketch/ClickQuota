// 2026-10-29 (§6.5 / P2#8) TELEMETRY THEO MODEL
//
// Mục tiêu: theo dõi "bức tường ~29s" (§TRỤ CỘT 4) theo thời gian, tách bạch
// thời gian CHỜ UPSTREAM THẬT (`upstreamWaitMs`) khỏi độ trễ do typewriter/SSE
// của gateway. Báo cáo forensic đo TTFT p50 6.7s · p90 25.1s · max 28.1s trên
// opus-5-5 bằng cách bới log thủ công (n=27); module này biến phép đo đó thành
// số liệu thường trực.
//
// NGUYÊN TẮC RIÊNG TƯ: chỉ lưu con số và model id. Không prompt, không reply,
// không workspaceId, không requestId — cùng chuẩn allowlist của audit-logs.mjs.
//
// CỐ Ý KHÔNG GHI ĐĨA: dữ liệu sống trong RAM và mất khi restart. Mỗi upstream
// attempt sẽ sinh một lần ghi; nếu persist sẽ làm nặng thêm đúng cái state-file
// churn đang gây flaky test, trong khi giá trị chẩn đoán của nó là xu hướng
// ngắn hạn (phát hiện tường 29s dịch chuyển), không phải lịch sử vĩnh viễn.

// Ngưỡng coi một lần chờ là "chạm tường": báo cáo đo max TTFT 28.1s và mô tả
// bức tường ở ~29s, nên 25s là mốc cảnh báo sớm — trùng ngưỡng retry
// maxTokens=1024 trong executeClickUpWithFallback để hai cơ chế đọc cùng một
// định nghĩa về "chờ lâu".
export const WALL_THRESHOLD_MS = 25000;

// Giữ tối đa N mẫu gần nhất mỗi model để tính percentile. 200 đủ để p90 ổn
// định mà vẫn chặn trần bộ nhớ (≤ 200 số/model).
const MAX_SAMPLES = 200;

const models = new Map();

function bucket(model) {
  let b = models.get(model);
  if (!b) {
    b = {
      attempts: 0,
      success: 0,
      empty: 0,
      emptyAfterWall: 0,
      errors: 0,
      retryRecovered: 0,
      waits: [],
    };
    models.set(model, b);
  }
  return b;
}

/**
 * Ghi nhận một lần gọi upstream đã kết thúc.
 *
 * @param {string}  model          Model id thật đã gửi lên upstream.
 * @param {number}  waitMs         Thời gian chờ upstream thuần (không gồm typewriter).
 * @param {'success'|'empty'|'error'} outcome
 * @param {boolean} [retryRecovered] True nếu kết quả có được nhờ retry maxTokens=1024.
 */
export function recordUpstreamAttempt(model, waitMs, outcome, retryRecovered = false) {
  // Validate TRƯỚC khi đụng vào bucket: nếu tăng attempts rồi mới loại waitMs hỏng,
  // ta tạo ra bucket có attempts nhưng không mẫu thời gian, làm lệch successRate và
  // đẻ ra model "ma" trong endpoint chẩn đoán. Timing hỏng là lỗi lập trình ở call
  // site, không phải dữ liệu — bỏ hẳn còn hơn báo cáo số sai.
  const ms = Number(waitMs);
  if (!model || typeof model !== 'string') return;
  if (!Number.isFinite(ms) || ms < 0) return;

  const b = bucket(model);
  b.attempts++;
  b.waits.push(Math.round(ms));
  if (b.waits.length > MAX_SAMPLES) b.waits.shift();

  if (outcome === 'success') b.success++;
  else if (outcome === 'error') b.errors++;
  else if (outcome === 'empty') {
    b.empty++;
    // Rỗng SAU khi chờ lâu = dấu hiệu upstream tự cắt (tường 29s). Rỗng NHANH
    // là chuyện khác hẳn (model từ chối / payload sai) nên phải đếm tách ra,
    // nếu không thì trộn hai nguyên nhân vào một con số là vô dụng.
    if (ms >= WALL_THRESHOLD_MS) b.emptyAfterWall++;
  }

  if (retryRecovered) b.retryRecovered++;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Ảnh chụp số liệu để phục vụ endpoint chẩn đoán. */
export function getUpstreamTelemetry() {
  const out = [];
  for (const [model, b] of models) {
    const sorted = [...b.waits].sort((x, y) => x - y);
    out.push({
      model,
      attempts: b.attempts,
      success: b.success,
      empty: b.empty,
      emptyAfterWall: b.emptyAfterWall,
      errors: b.errors,
      retryRecovered: b.retryRecovered,
      successRate: b.attempts > 0 ? Number(((b.success / b.attempts) * 100).toFixed(1)) : null,
      samples: sorted.length,
      upstreamWaitMs: {
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        max: sorted.length ? sorted[sorted.length - 1] : null,
      },
    });
  }
  out.sort((a, b) => b.attempts - a.attempts);
  return { wallThresholdMs: WALL_THRESHOLD_MS, maxSamplesPerModel: MAX_SAMPLES, models: out };
}

/** Dùng cho test để cô lập trạng thái giữa các case. */
export function resetUpstreamTelemetry() {
  models.clear();
}
