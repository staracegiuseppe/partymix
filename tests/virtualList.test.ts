import { VirtualList, visibleRange } from '../src/ui/virtualList';
import { buildQueueList, QueueRowVM } from '../src/ui/queueList';

const H = 40, VP = 400, HEAD = 44, FOOT = 76;
function list(n: number) {
  let top = 0;
  const head = document.createElement('div'); head.textContent = 'INIZIO';
  const foot = document.createElement('div'); foot.textContent = 'FINE';
  const vl = new VirtualList<number>({
    rowHeight: H, overscan: 4, fallbackHeight: VP, dragScroll: true,
    header: { el: head, height: HEAD }, footer: { el: foot, height: FOOT },
    create: () => document.createElement('div'),
    paint: (el, item) => { el.textContent = String(item); },
  });
  vl.scrollTopOverride = { get: () => top, set: (v) => { top = v; } };
  document.body.replaceChildren(vl.el);
  vl.setItems(Array.from({ length: n }, (_, i) => i));
  const rows = () => [...vl.el.querySelectorAll<HTMLElement>('div > div')].filter((e) => e.style.display !== 'none' && /translateY/.test(e.style.transform))
    .map((e) => ({ y: Number(/translateY\(([-\d.]+)px\)/.exec(e.style.transform)![1]), v: Number(e.textContent) }));
  const visible = () => rows().filter((r) => r.y + H > top && r.y < top + VP).sort((a, b) => a.y - b.y).map((r) => r.v);
  const scroll = (to: number) => { vl.top = to; vl.render(); };
  return { vl, visible, scroll, top: () => top, head, foot };
}

describe('finite list: a real head and a real tail', () => {
  it('draws only the visible rows plus a margin, below the header', () => {
    expect(visibleRange(4000, 400, 40, 10_000, 5)).toEqual([95, 115]);
    expect(visibleRange(0, 400, 40, 3, 5, 44)).toEqual([0, 3]);
  });
  it('starts at the head: the header, then song 1', () => {
    const { vl, visible, head } = list(100);
    expect(vl.top).toBe(0);
    expect(head.style.top).toBe('0px');
    expect(visible()[0]).toBe(0);
  });
  it('ends at the tail: the last song, then «Fine» — never song 1 again', () => {
    const { vl, visible, scroll, foot } = list(100);
    scroll(1e9);
    expect(vl.top).toBe(HEAD + 100 * H + FOOT - VP); // clamped: the list does not go on
    expect(visible().at(-1)).toBe(99);
    expect(visible()).not.toContain(0);
    expect(foot.style.top).toBe(`${HEAD + 100 * H}px`);
    expect(vl.atEnd()).toBe(true);
  });
  it('first → last and last → first by scrolling, in order, with no wrap', () => {
    const { vl, visible, scroll } = list(1000);
    const seen: number[] = [];
    for (let y = 0; y <= vl.totalHeight(); y += H) { scroll(y); seen.push(visible()[0]); }
    expect(seen[0]).toBe(0);
    expect(Math.max(...seen)).toBeLessThan(1000);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    for (let y = vl.totalHeight(); y > 0; y -= 3 * H) scroll(y);
    scroll(0);
    expect(vl.atStart()).toBe(true);
    expect(visible()[0]).toBe(0);
  });
  it('«↑ Torna all’inizio» goes back to the head', () => {
    const { vl, scroll } = list(500);
    scroll(1e9);
    vl.scrollToStart(false);
    expect(vl.top).toBe(0);
  });
  it('fast flicks never leave gaps and keep few nodes in the page', () => {
    const { vl, visible, scroll } = list(10_000);
    for (let y = 0; y < vl.totalHeight(); y += 3333) {
      scroll(y);
      const v = visible();
      for (let k = 1; k < v.length; k++) expect(v[k]).toBe(v[k - 1] + 1);
    }
    expect(vl.renderedCount()).toBeLessThan(VP / H + 12);
  });
  for (const n of [1, 10, 1000, 10_000]) {
    it(`${n} ${n === 1 ? 'song' : 'songs'}: height = head + rows + tail, last song is ${n}`, () => {
      const { vl, visible, scroll } = list(n);
      expect(vl.totalHeight()).toBe(HEAD + n * H + FOOT);
      scroll(1e9);
      expect(visible().at(-1)).toBe(n - 1);
      expect(vl.el.querySelectorAll('div > div').length).toBeLessThan(40);
    });
  }
  it('slow mouse drag scrolls with the pointer and stops at the head; the release is not a click', () => {
    const { vl } = list(100);
    const ev = (type: string, y: number, t: number) => { const e = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }); Object.defineProperty(e, 'pointerType', { value: 'mouse' }); Object.defineProperty(e, 'timeStamp', { value: t }); vl.el.dispatchEvent(e); };
    ev('pointerdown', 300, 0);
    for (let k = 1; k <= 10; k++) ev('pointermove', 300 - k * 12, k * 50);
    expect(vl.top).toBe(120);
    ev('pointerup', 180, 1000);
    const clicked = vi.fn();
    vl.el.addEventListener('click', clicked);
    vl.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked).not.toHaveBeenCalled();
    ev('pointerdown', 100, 2000); ev('pointermove', 900, 2050); ev('pointerup', 900, 3000);
    expect(vl.top).toBe(0); // dragging down past the head stays at the head
  });
  it('touch is left to the browser (native finger scrolling)', () => {
    const { vl } = list(100);
    const e = new MouseEvent('pointerdown', { bubbles: true, clientY: 300 }); Object.defineProperty(e, 'pointerType', { value: 'touch' });
    vl.el.dispatchEvent(e);
    const m = new MouseEvent('pointermove', { bubbles: true, clientY: 100 }); Object.defineProperty(m, 'pointerType', { value: 'touch' });
    vl.el.dispatchEvent(m);
    expect(vl.top).toBe(0);
    expect(vl.el.style.cssText).toContain('overflow-y: auto');
  });
  it('keeps the song at the top when a song is added', () => {
    const { vl, visible } = list(200);
    vl.scrollToIndex(120, 'top');
    vl.setItems(Array.from({ length: 201 }, (_, i) => i));
    expect(visible()[0]).toBe(120);
  });
});

describe('play queue (computer)', () => {
  const rows = (n: number, cur = -1): QueueRowVM[] => Array.from({ length: n }, (_, i) => ({ id: 'v' + i, title: 'T' + i, artist: '', bad: false, locked: false, current: i === cur, off: i % 2 ? 'offline' : 'online' }));
  const setup = () => {
    localStorage.clear();
    const a = { playNow: vi.fn(), move: vi.fn(), toggleLock: vi.fn(), removeTrack: vi.fn(), songMenu: vi.fn() };
    const q = buildQueueList(a, localStorage, () => 'Ripeti: no');
    let top = 0;
    q.list.scrollTopOverride = { get: () => top, set: (v) => { top = v; } };
    document.body.replaceChildren(q.el);
    return { q, a };
  };
  it('remembers the position of each playlist, and goes back to it', () => {
    const { q } = setup();
    q.setRows(rows(500), 'A');
    q.list.scrollToIndex(300, 'top');
    q.setRows(rows(80), 'B');
    expect(q.list.topIndex().index).toBe(0);
    q.setRows(rows(500), 'A');
    expect(q.list.topIndex().index).toBe(300);
  });
  it('does not move when the song on air changes', () => {
    const { q } = setup();
    q.setRows(rows(500, 3), 'A');
    q.list.scrollToIndex(250, 'top');
    q.setRows(rows(500, 4), 'A');
    expect(q.list.topIndex().index).toBe(250);
  });
  it('states with icon and words: ▶ playing, ⏸ paused, ✓ Offline, ☁ Online', () => {
    const { q } = setup();
    const r = rows(3, 1); r[1].paused = true;
    q.setRows(r, 'A');
    const items = [...document.querySelectorAll('.item')];
    expect(items[1].querySelector('.lead')!.textContent).toBe('⏸');
    expect(items[0].querySelector('.st')!.textContent).toBe('☁ Online');
    expect(items[1].querySelector('.st')!.textContent).toBe('✓ Offline');
  });
  it('the tail says how many songs and what Ripeti does', () => {
    const { q } = setup();
    q.setRows(rows(124), 'A');
    q.setHead('IN RIPRODUZIONE: Party', '124 brani');
    expect(document.querySelector('.sl-head')!.textContent).toContain('IN RIPRODUZIONE: Party');
    expect(document.querySelector('.sl-foot')!.textContent).toContain('■ Fine della lista di riproduzione · 124 brani');
    expect(document.querySelector('.sl-foot')!.textContent).toContain('Ripeti: no');
  });
  it('⋮ opens the song menu, ▶ plays', () => {
    const { q, a } = setup();
    q.setRows(rows(5, 0), 'A');
    const second = [...document.querySelectorAll<HTMLElement>('.item')][1];
    second.querySelector<HTMLButtonElement>('.more')!.click();
    expect(a.songMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }), 1, expect.anything());
    second.querySelector<HTMLButtonElement>('.play')!.click();
    expect(a.playNow).toHaveBeenCalledWith('v1');
  });
  it('a change of state with the same number of songs is shown (stale rows regression)', () => {
    const { q } = setup();
    const r = rows(300); r.forEach((x) => { x.skip = true; });
    q.setRows(r, 'A');
    q.setRows(rows(300, 0), 'A');
    const shown = [...document.querySelectorAll<HTMLElement>('.item')].filter((e) => e.style.display !== 'none');
    expect(shown.filter((e) => e.classList.contains('skip'))).toHaveLength(0);
    expect(shown.find((e) => e.dataset.i === '0')!.classList.contains('cur')).toBe(true);
  });
});
