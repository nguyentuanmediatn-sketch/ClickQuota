// src/alert/events.mjs
// Bus sự kiện tối giản, độc lập, dùng cho quan sát (observability).
//
// Nguyên tắc:
// - Không phụ thuộc module khác trong dự án: pool/server import được mà không tạo vòng lặp.
// - Observer lỗi được cô lập: một observer ném lỗi không làm hỏng observer khác, cũng không
//   làm hỏng luồng request đã phát sự kiện.
// - `emit` không bao giờ ném lỗi ra ngoài.
// - Số observer có giới hạn để tránh rò rỉ bộ nhớ khi subscribe/unsubscribe sai.

const MAX_OBSERVERS = 64;

export const ALERT_EVENTS = Object.freeze({
  UPSTREAM_HTTP_ERROR: 'upstream_http_error',
  CIRCUIT_OPEN: 'circuit_open',
  CIRCUIT_CLOSE: 'circuit_close',
});

export class AlertEventBus {
  constructor({ maxObservers = MAX_OBSERVERS, onObserverError = null } = {}) {
    this._observers = new Set();
    this._maxObservers = maxObservers;
    this._onObserverError = typeof onObserverError === 'function' ? onObserverError : null;
  }

  get observerCount() {
    return this._observers.size;
  }

  // Trả về hàm huỷ đăng ký (idempotent). Trả về no-op nếu đầu vào không hợp lệ hoặc đã chạm
  // trần observer — không ném lỗi để không ảnh hưởng caller.
  subscribe(observer) {
    if (typeof observer !== 'function') return () => {};
    if (this._observers.size >= this._maxObservers) return () => {};
    this._observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._observers.delete(observer);
    };
  }

  clear() {
    this._observers.clear();
  }

  // Phát sự kiện đồng bộ. Lỗi của observer bị nuốt (và báo qua onObserverError nếu có).
  // Bên phát chịu trách nhiệm chỉ đưa dữ liệu an toàn vào payload.
  emit(type, payload = {}) {
    if (!type || !this._observers.size) return;
    const event = { ...payload, type, at: Date.now() };
    for (const observer of Array.from(this._observers)) {
      try {
        const result = observer(event);
        if (result && typeof result.then === 'function') {
          result.then(undefined, (err) => this._reportObserverError(err));
        }
      } catch (err) {
        this._reportObserverError(err);
      }
    }
  }

  _reportObserverError(err) {
    if (!this._onObserverError) return;
    try { this._onObserverError(err); } catch { /* không được làm hỏng luồng chính */ }
  }
}

export const alertEvents = new AlertEventBus();
