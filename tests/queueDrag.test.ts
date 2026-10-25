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
