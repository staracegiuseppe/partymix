/**
 * A finite list that shows thousands of rows with only the visible ones (plus a few) in the page, recycled while scrolling.
 * It has a real head and a real tail: an optional header above the first row («Inizio · 124 brani») and a footer after
 * the last one («Fine playlist»). Going from the last song back to the first is a player function (Ripeti), never a
 * trick of the list: the list ends where the playlist ends.
 */
export type VirtualListOpts<T> = {
  rowHeight: number;
  /** Rows drawn above and below the visible ones, so a fast flick never shows an empty gap. */
  overscan?: number;
  className?: string;
  /** Builds one empty row (called a few dozen times at most: rows are reused). */
  create(): HTMLElement;
  /** Fills a row with the item at `index`. */
  paint(el: HTMLElement, item: T, index: number): void;
  /** Height used when the page is not laid out yet (tests, hidden page). */
  fallbackHeight?: number;
  /** Grab and drag the list with the mouse, like a finger on a touch screen (with momentum). */
  dragScroll?: boolean;
  /** Where a mouse press must stay a click or a drag & drop (buttons, the grip of a row…). */
  noDragSelector?: string;
  /** The head of the list (above row 1) and its tail (after the last row), with their fixed heights. */
  header?: { el: HTMLElement; height: number };
  footer?: { el: HTMLElement; height: number };
};

/** The rows to draw: [start, end). `offset` is the height of the header above the first row. */
export function visibleRange(scrollTop: number, viewport: number, rowH: number, total: number, overscan: number, offset = 0): [number, number] {
  const top = scrollTop - offset;
  const start = Math.max(0, Math.floor(top / rowH) - overscan);
  const end = Math.min(total, Math.ceil((top + viewport) / rowH) + overscan);
  return [start, Math.max(start, end)];
}

const raf: (fn: () => void) => void = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

export class VirtualList<T> {
  readonly el: HTMLDivElement;
  private spacer: HTMLDivElement;
  private items: T[] = [];
  private live = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];
  private queued = false;
  private drag?: { y: number; top: number; moved: boolean; samples: { t: number; y: number }[]; id: number };
  private momentum = 0;
  private suppressClick = false;
  /** Set by tests to stand in for the browser's scroll position. */
  scrollTopOverride?: { get(): number; set(v: number): void };

  constructor(private o: VirtualListOpts<T>) {
    this.el = document.createElement('div');
    this.el.className = `vlist ${o.className ?? ''}`.trim();
    this.el.tabIndex = 0;
    this.el.style.cssText = 'position:relative;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch';
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = 'position:relative;width:100%';
    this.el.append(this.spacer);
    if (o.header) { o.header.el.classList.add('vl-head'); o.header.el.style.cssText += `;position:absolute;left:0;right:0;top:0;height:${o.header.height}px`; this.spacer.append(o.header.el); }
    if (o.footer) { o.footer.el.classList.add('vl-foot'); o.footer.el.style.cssText += `;position:absolute;left:0;right:0;height:${o.footer.height}px`; this.spacer.append(o.footer.el); }
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.addEventListener('wheel', () => { this.momentum = 0; }, { passive: true });
    if (o.dragScroll) this.bindDrag();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  get length(): number { return this.items.length; }
  private get rowH() { return this.o.rowHeight; }
  private get headH() { return this.o.header?.height ?? 0; }
  private get footH() { return this.o.footer?.height ?? 0; }
  private viewport(): number { return this.el.clientHeight || this.o.fallbackHeight || 480; }
  get top(): number { return this.scrollTopOverride ? this.scrollTopOverride.get() : this.el.scrollTop; }
  set top(v: number) {
    const max = Math.max(0, this.totalHeight() - this.viewport());
    const c = Math.min(max, Math.max(0, v));
    if (this.scrollTopOverride) this.scrollTopOverride.set(c); else this.el.scrollTop = c;
  }
  totalHeight(): number { return this.headH + this.items.length * this.rowH + this.footH; }

  /** Rows currently in the page (for the tests and for the «few nodes» promise). */
  renderedCount(): number { return this.live.size; }
  /** The song at the top of the view and how many pixels of it are scrolled away: saved per playlist and restored later. */
  topIndex(): { index: number; offset: number } {
    if (!this.items.length) return { index: 0, offset: 0 };
    const y = Math.max(0, this.top - this.headH);
    const v = Math.min(this.items.length - 1, Math.floor(y / this.rowH));
    return { index: v, offset: y - v * this.rowH };
  }
  /** Which song is the last one fully or partly visible (for «3 / 124»-style hints). */
  atEnd(): boolean { return this.top + this.viewport() >= this.totalHeight() - 2; }
  atStart(): boolean { return this.top <= 2; }

  /** New content. `keep` (default) holds the song at the top where it is, so a reload of the list never jumps. */
  setItems(items: T[], keep: { index: number; offset: number } | 'keep' | 'start' = 'keep'): void {
    const was = keep === 'keep' ? (this.items.length ? this.topIndex() : { index: 0, offset: 0 }) : keep === 'start' ? { index: 0, offset: 0 } : keep;
    const fromHead = keep === 'start' || (keep === 'keep' && this.atStart());
    this.items = items;
    this.spacer.style.height = `${this.totalHeight()}px`;
    if (this.o.footer) this.o.footer.el.style.top = `${this.headH + items.length * this.rowH}px`;
    for (const [, el] of this.live) this.recycle(el);
    this.live.clear();
    const idx = Math.min(was.index, Math.max(0, items.length - 1));
    this.top = fromHead ? 0 : this.headH + idx * this.rowH + (idx === was.index ? was.offset : 0);
    this.render();
  }

  /** New data for the same songs (states, song on air…): same length → repainted in place, else like setItems('keep'). */
  update(items: T[]): void {
    if (items.length !== this.items.length) { this.setItems(items, 'keep'); return; }
    this.items = items;
    this.refresh();
  }

  /** Repaints the visible rows (the data of the songs changed, not their number). */
  refresh(): void { for (const [v, el] of this.live) this.o.paint(el, this.items[v], v); }

  /** Brings a song into view unless it is already fully visible (`nearest`), or puts it at the top or in the middle. */
  scrollToIndex(i: number, where: 'center' | 'top' | 'nearest' = 'nearest'): void {
    if (!this.items.length || i < 0 || i >= this.items.length) return;
    const vp = this.viewport(), h = this.rowH;
    const y = this.headH + i * h;
    if (where === 'nearest' && y >= this.top && y + h <= this.top + vp) return;
    this.top = where === 'top' ? y : y - vp / 2 + h / 2;
    this.render();
  }
  /** «↑ Torna all'inizio» / to the end: the head or the tail of the list. */
  scrollToStart(smooth = true): void { this.momentum++; if (smooth && this.el.scrollTo && !this.scrollTopOverride) this.el.scrollTo({ top: 0, behavior: 'smooth' }); else this.top = 0; this.render(); }
  scrollToEnd(smooth = true): void { this.momentum++; const t = this.totalHeight(); if (smooth && this.el.scrollTo && !this.scrollTopOverride) this.el.scrollTo({ top: t, behavior: 'smooth' }); else this.top = t; this.render(); }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    raf(() => { this.queued = false; this.render(); });
  }

  private recycle(el: HTMLElement) { el.style.display = 'none'; this.pool.push(el); }

  /** Draws what is visible now. Called on scroll (once per frame) or directly. */
  render(): void {
    const n = this.items.length;
    this.el.classList.toggle('vl-empty', n === 0);
    if (!n) { for (const [, el] of this.live) this.recycle(el); this.live.clear(); return; }
    const [start, end] = visibleRange(this.top, this.viewport(), this.rowH, n, this.o.overscan ?? 6, this.headH);
    for (const [v, el] of this.live) if (v < start || v >= end) { this.recycle(el); this.live.delete(v); }
    for (let v = start; v < end; v++) {
      if (this.live.has(v)) continue;
      const el = this.pool.pop() ?? this.make();
      el.style.display = '';
      el.style.transform = `translateY(${this.headH + v * this.rowH}px)`;
      el.dataset.i = String(v);
      this.o.paint(el, this.items[v], v);
      this.live.set(v, el);
    }
  }

  private make(): HTMLElement {
    const el = this.o.create();
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.top = '0';
    el.style.height = `${this.rowH}px`;
    el.style.willChange = 'transform';
    this.spacer.append(el);
    return el;
  }

  /** Mouse: press and drag the list up or down, let go and it keeps gliding and slows down (like on a phone). */
  private bindDrag(): void {
    const el = this.el;
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      this.momentum++;
      if ((e.pointerType ?? 'mouse') !== 'mouse' || e.button !== 0) return; // touch and pen scroll natively
      if (this.o.noDragSelector && (e.target as Element | null)?.closest?.(this.o.noDragSelector)) return;
      this.drag = { y: e.clientY, top: this.top, moved: false, samples: [{ t: e.timeStamp || Date.now(), y: e.clientY }], id: e.pointerId };
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dy) < 5) return;
      if (!d.moved) { d.moved = true; el.classList.add('grabbing'); try { el.setPointerCapture?.(d.id); } catch { /* not supported */ } }
      this.top = d.top - dy;
      d.samples.push({ t: e.timeStamp || Date.now(), y: e.clientY });
      if (d.samples.length > 6) d.samples.shift();
      this.render();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = undefined;
      if (!d?.moved) return;
      el.classList.remove('grabbing');
      this.suppressClick = true; // the release of a drag is not a click on a song
      setTimeout(() => { this.suppressClick = false; }, 0);
      const a = d.samples[0], b = d.samples[d.samples.length - 1];
      const dt = Math.max(1, (b.t || 0) - (a.t || 0));
      const v = (b.y - a.y) / dt; // px per ms
      if (Math.abs(v) > 0.1 && (e.timeStamp || Date.now()) - (b.t || 0) < 100) this.glide(-v);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => { if (this.suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  /** Momentum after a mouse drag: slows down, and stops at the head or the tail (the list does not wrap). */
  private glide(v: number): void {
    const id = ++this.momentum;
    let last = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = (t: number) => {
      if (id !== this.momentum) return;
      const dt = last ? Math.min(48, t - last) : 16;
      last = t;
      const before = this.top;
      this.top = before + v * dt;
      this.render();
      if (this.top === before) return; // reached the head or the tail
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) > 0.02) raf(() => step(now()));
    };
    raf(() => step(now()));
  }
}
