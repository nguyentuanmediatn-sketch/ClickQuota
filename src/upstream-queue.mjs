/**
 * UpstreamQueue - Concurrency limiter with signal abortion support and queue metrics.
 */
export class UpstreamQueue {
  constructor(limit = 3) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  get queueLength() {
    return this.waiters.length;
  }

  async acquire(signal) {
    signal?.throwIfAborted?.();
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          cleanup: () => signal?.removeEventListener?.('abort', abort),
        };
        const abort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          waiter.cleanup();
          reject(signal?.reason || new Error('Request aborted in UpstreamQueue'));
        };
        signal?.addEventListener?.('abort', abort, { once: true });
        this.waiters.push(waiter);
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) {
        next.cleanup();
        this.active++;
        next.resolve();
      }
    };
  }
}
