/* CQ.VirtualList — fixed-row virtualization (the @tanstack/react-virtual pattern,
   distilled to ~70 lines of vanilla JS for the log table: 60fps on tens of
   thousands of rows by rendering only the viewport window + buffer). */
(function (CQ) {
  'use strict';

  class VirtualList {
    /**
     * @param {HTMLElement} scroller  scrollable container (position: relative)
     * @param {number} rowHeight      fixed row height in px
     * @param {(el: HTMLElement, row: any, index: number) => void} renderRow
     */
    constructor(scroller, rowHeight, renderRow, { overscan = 6 } = {}) {
      this.sc = scroller;
      this.rowH = rowHeight;
      this.renderRow = renderRow;
      this.overscan = overscan;
      this.rows = [];
      this.expandedIndex = -1;

      this.spacer = document.createElement('div');
      this.spacer.className = 'cq-log-spacer';
      this.sc.appendChild(this.spacer);

      this.pool = document.createElement('div');
      this.pool.style.cssText = 'position:absolute;inset:0;';
      this.sc.appendChild(this.pool);

      this._onScroll = () => this.paint();
      this.sc.addEventListener('scroll', () => requestAnimationFrame(() => this._onScroll()), { passive: true });
      this._ro = new ResizeObserver(() => this.paint());
      this._ro.observe(scroller);
    }

    setRows(rows) {
      this.rows = rows;
      this.expandedIndex = -1;
      this.spacer.style.height = rows.length * this.rowH + 'px';
      this.sc.scrollTop = 0;
      this.paint();
    }

    /* Detail overlay for an expanded row lives outside the fixed-height pool. */
    setDetail(el) { this.detail = el; }

    paint() {
      const h = this.sc.clientHeight || 1;
      const start = Math.max(0, Math.floor(this.sc.scrollTop / this.rowH) - this.overscan);
      const end = Math.min(this.rows.length, start + Math.ceil(h / this.rowH) + this.overscan * 2);

      const wanted = [];
      for (let i = start; i < end; i++) wanted.push(i);

      /* Reuse pooled row elements in DOM order. */
      while (this.pool.children.length > wanted.length) this.pool.lastChild.remove();
      while (this.pool.children.length < wanted.length) {
        const el = document.createElement('div');
        el.className = 'cq-log-row';
        this.pool.appendChild(el);
      }
      wanted.forEach((idx, slot) => {
        const el = this.pool.children[slot];
        el.style.top = idx * this.rowH + 'px';
        el.classList.toggle('is-selected', idx === this.expandedIndex);
        this.renderRow(el, this.rows[idx], idx);
      });
      this._placeDetail();
    }

    toggleDetail(index, buildDetail) {
      if (!this.detail) return;
      if (this.expandedIndex === index) { this.collapseDetail(); return; }
      this.expandedIndex = index;
      this.detail.innerHTML = '';
      buildDetail(this.detail, this.rows[index], index);
      const top = index * this.rowH + this.rowH + 4;
      const maxTop = this.sc.scrollHeight - 216;
      this.detail.style.top = Math.min(top, Math.max(4, maxTop)) + 'px';
      this.detail.style.display = 'block';
      this._detailSpring = (this._detailSpring || new CQ.springs.SpringValue(0, 0.38, 1.0));
      const target = Math.min(240, this.detail.scrollHeight || 200);
      /* Spring phải có subscriber ghi height vào DOM mỗi frame — không chỉ set một lần. */
      if (!this._detailSub) {
        this._detailSub = this._detailSpring.subscribe((v) => { this.detail.style.height = v + 'px'; });
      }
      this._detailSpring._settleSubs.length = 0;
      this._detailSpring.animateTo(target, { response: 0.38, damping: 1.0 });
      this.paint();
    }

    collapseDetail() {
      this.expandedIndex = -1;
      if (this.detail && this._detailSpring) {
        const s = this._detailSpring;
        s.animateTo(0, { response: 0.3, damping: 1.0 });
        s.onSettle(() => { if (s.v === 0 && this.expandedIndex === -1) this.detail.style.display = 'none'; });
      }
      this.paint();
    }

    _placeDetail() {
      if (this.detail && this.expandedIndex >= 0) {
        const top = this.expandedIndex * this.rowH + this.rowH + 4;
        const maxTop = this.sc.scrollHeight - 216;
        this.detail.style.top = Math.min(top, Math.max(4, maxTop)) + 'px';
      }
    }
  }

  CQ.VirtualList = VirtualList;
})(window.CQ = window.CQ || {});
