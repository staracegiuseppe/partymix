import { buildConsole, Actions, ViewModel } from '../src/ui/console';

const dt = () => ({ effectAllowed: '', setData: () => {} });
const fire = (el: Element, type: string) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt() });
  el.dispatchEvent(e);
  return e;
};
const deck = { title: '', artist: '', elapsed: 0, duration: 0, role: 'idle' as const, volume: 100, duck: false };
const vm = (n: number): ViewModel => ({
  lyrics: { status: '', prev: '', cur: '', next: '', offset: 0, show: true, canShift: false },
  state: 'idle', active: 0, ready: true, decks: [deck, deck], mix: 0, master: 80, profile: 'standard', shuffle: false, repeat: 'off',
  queue: Array.from({ length: n }, (_, i) => ({ id: 'v' + i, title: 'T' + i, artist: '', bad: false, locked: false, current: false })),
  history: [], problems: [],
});

function setup() {
  document.body.innerHTML = '<div id="root"></div>';
  const move = vi.fn();
  const actions = new Proxy({ move }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
  const ui = buildConsole(document.getElementById('root')!, actions);
  ui.update(vm(4));
  return { move, rows: () => [...document.querySelectorAll('.item')] };
}

describe('queue drag and drop', () => {
  it('rows are draggable', () => {
    const { rows } = setup();
    expect(rows()).toHaveLength(4);
    expect(rows().every((r) => r.getAttribute('draggable') === 'true')).toBe(true);
  });
  it('dropping row 0 on row 2 moves 0 -> 2', () => {
    const { move, rows } = setup();
    fire(rows()[0], 'dragstart');
    fire(rows()[2], 'dragover');
    expect(rows()[2].classList.contains('over')).toBe(true);
    fire(rows()[2], 'drop');
    expect(move).toHaveBeenCalledWith(0, 2);
    expect(rows()[2].classList.contains('over')).toBe(false);
  });
  it('dropping a row on itself does nothing', () => {
    const { move, rows } = setup();
    fire(rows()[1], 'dragstart');
    fire(rows()[1], 'drop');
    expect(move).not.toHaveBeenCalled();
  });
  it('a drop without a drag started here (e.g. a dragged file) does nothing', () => {
    const { move, rows } = setup();
    fire(rows()[3], 'drop');
    expect(move).not.toHaveBeenCalled();
  });
});

describe('seek bar', () => {
  const liveVm = (): ViewModel => {
    const v = vm(2);
    v.state = 'playing';
    v.decks = [{ ...deck, role: 'live', elapsed: 20, duration: 200 }, { ...deck, role: 'ready' }];
    return v;
  };
  const build = () => {
    document.body.innerHTML = '<div id="root"></div>';
    const seek = vi.fn();
    const actions = new Proxy({ seek }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    const ui = buildConsole(document.getElementById('root')!, actions);
    ui.update(liveVm());
    return { seek, bars: () => [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Posizione deck"]')] };
  };
  it('reflects the playback position and is enabled only on the live deck', () => {
    const { bars } = build();
    expect(bars()[0].value).toBe('20');
    expect(bars()[0].max).toBe('200');
    expect(bars()[0].disabled).toBe(false);
    expect(bars()[1].disabled).toBe(true);
  });
  it('seeks once when the user releases the slider, not on every drag step', () => {
    const { seek, bars } = build();
    const bar = bars()[0];
    bar.value = '90';
    bar.dispatchEvent(new Event('input', { bubbles: true }));
    expect(seek).not.toHaveBeenCalled();
    bar.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seek).toHaveBeenCalledWith(0, 90);
  });
});
