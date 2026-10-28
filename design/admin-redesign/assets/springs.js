/* CQ.springs — Apple-style spring engine (Designing Fluid Interfaces, translated for web).
   - Animate from the CURRENT presentation value, never the target (interruptible).
   - Retarget carries current velocity through (no "brick wall" on reversal).
   - Parameters: response (seconds to reach target) + damping ratio (1.0 = critically damped).
   - Honors prefers-reduced-motion: jumps to target (cross-fades handled in CSS). */
(function (CQ) {
  'use strict';

  const REDUCE = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function params(response, damping) {
    const w0 = (2 * Math.PI) / Math.max(0.05, response);
    return { k: w0 * w0, c: 2 * damping * w0 };
  }

  class SpringValue {
    constructor(value, response = 0.35, damping = 1.0) {
      this.v = value;
      this.vel = 0;
      this.target = value;
      this.cfg = params(response, damping);
      this._raf = null;
      this._subs = [];
      this._settleSubs = [];
    }
    subscribe(fn) { this._subs.push(fn); fn(this.v); return () => { this._subs = this._subs.filter((s) => s !== fn); }; }
    onSettle(fn) { this._settleSubs.push(fn); }
    _emit() { for (const fn of this._subs) fn(this.v, this.vel); }
    jump(value) {
      this.v = value; this.vel = 0; this.target = value;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this._emit();
    }
    /* Retarget mid-flight: keeps live value + velocity unless overridden. */
    animateTo(target, opts = {}) {
      if (opts.response != null || opts.damping != null) {
        this.cfg = params(opts.response != null ? opts.response : 0.35, opts.damping != null ? opts.damping : 1.0);
      }
      this.target = target;
      if (opts.velocity != null) this.vel = opts.velocity;
      if (REDUCE) { this.v = target; this.vel = 0; this._emit(); this._fireSettle(); return; }
      this._start();
    }
    _start() {
      if (this._raf) return;
      let last = performance.now();
      const tick = (now) => {
        let dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        const a = this.cfg.k * (this.target - this.v) - this.cfg.c * this.vel;
        this.vel += a * dt;
        this.v += this.vel * dt;
        const settled = Math.abs(this.target - this.v) < 0.04 && Math.abs(this.vel) < 0.04;
        if (settled) {
          this.v = this.target; this.vel = 0;
          this._raf = null; this._emit(); this._fireSettle();
          return;
        }
        this._emit();
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    _fireSettle() { for (const fn of this._settleSubs) fn(this.v); }
  }

  /* Bind a spring to a style property with a formatter. Returns the SpringValue. */
  function bind(el, styleProp, initial, format, opts = {}) {
    const s = new SpringValue(initial, opts.response, opts.damping);
    s.subscribe((v) => { el.style[styleProp] = format(v); });
    return s;
  }

  /* Apple rubber-band: progressive resistance past a boundary. */
  function rubberband(offset, dimension, constant = 0.55) {
    return (offset * dimension * constant) / (dimension + constant * Math.abs(offset));
  }

  /* Pointer velocity tracker — keep a short history, velocity at release (px/s). */
  function velocityTracker() {
    const hist = [];
    return {
      push(x, t) {
        hist.push({ x, t });
        while (hist.length > 6) hist.shift();
      },
      release() {
        if (hist.length < 2) return 0;
        const first = hist[0];
        const last = hist[hist.length - 1];
        const dt = (last.t - first.t) / 1000;
        return dt > 0 ? (last.x - first.x) / dt : 0;
      },
    };
  }

  CQ.springs = { SpringValue, bind, rubberband, velocityTracker, params, REDUCE };
})(window.CQ = window.CQ || {});
