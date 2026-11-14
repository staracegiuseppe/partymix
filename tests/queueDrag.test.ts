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
  ads: { available: true, on: false, kind: 'silence', level: 0, silentFor: 0, threshold: 4, ducking: false, playing: false },
  karaoke: { running: false, waiting: false, total: 0, done: 0, synced: 0, plain: 0, none: 0, pending: 0, auto: true },
  lyrics: { status: '', prev: '', cur: '', next: '', progress: 0, offset: 0, speed: 1, show: true, canShift: false, lines: [], index: -1 },
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
  it('rows are dragged by their ⋮⋮ grip (the rest of the row scrolls the list)', () => {
    const { rows } = setup();
    expect(rows()).toHaveLength(4);
    expect(rows().every((r) => r.querySelector('.grip')?.getAttribute('draggable') === 'true')).toBe(true);
  });
  it('a drag started on the title, not on the grip, does not move anything', () => {
    const { move, rows } = setup();
    fire(rows()[0].querySelector('.t')!, 'dragstart');
    fire(rows()[2], 'drop');
    expect(move).not.toHaveBeenCalled();
  });
  it('dropping row 0 on row 2 moves 0 -> 2', () => {
    const { move, rows } = setup();
    fire(rows()[0].querySelector('.grip')!, 'dragstart');
    fire(rows()[2], 'dragover');
    expect(rows()[2].classList.contains('over')).toBe(true);
    fire(rows()[2], 'drop');
    expect(move).toHaveBeenCalledWith(0, 2);
    expect(rows()[2].classList.contains('over')).toBe(false);
  });
  it('dropping a row on itself does nothing', () => {
    const { move, rows } = setup();
    fire(rows()[1].querySelector('.grip')!, 'dragstart');
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


describe('lyrics lines as sync points', () => {
  it('clicking a line tells the controller which line is being sung now', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const anchorLyrics = vi.fn();
    const actions = new Proxy({ anchorLyrics }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    const ui = buildConsole(document.getElementById('root')!, actions);
    const v = vm(1);
    v.lyrics = { ...v.lyrics, canShift: true, lines: ['uno', 'due', 'tre'], index: 1, status: 'Testo da LRCLIB' };
    ui.update(v);
    const rows = [...document.querySelectorAll('.lylist button')];
    expect(rows.map((r) => r.textContent)).toEqual(['uno', 'due', 'tre']);
    expect(rows[1].classList.contains('now')).toBe(true);
    (rows[2] as HTMLButtonElement).click();
    expect(anchorLyrics).toHaveBeenCalledWith(2);
  });
});


describe('karaoke panel and queue tags', () => {
  it('shows how many lyrics are ready and tags each song', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const retry = vi.fn();
    const actions = new Proxy({ retryKaraoke: retry }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    const ui = buildConsole(document.getElementById('root')!, actions);
    const v = vm(3);
    v.queue[0].lyr = 'synced'; v.queue[1].lyr = 'plain'; v.queue[2].lyr = 'none';
    v.karaoke = { running: false, waiting: false, total: 3, done: 3, synced: 1, plain: 1, none: 1, pending: 0, auto: true };
    ui.update(v);
    expect(document.body.textContent).toContain('Pronti 3 di 3: 1 a tempo, 1 con tempi stimati, 1 non trovati.');
    const tags = [...document.querySelectorAll('.item .tag')].map((t) => t.textContent);
    expect(tags).toEqual(['testo a tempo', 'testo stimato', 'senza testo']);
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cerca i testi mancanti') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(retry).toHaveBeenCalled();
  });
  it('double click on a song asks to play it now, but not on the one on air or an unplayable one', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const playNow = vi.fn();
    const actions = new Proxy({ playNow }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    const ui = buildConsole(document.getElementById('root')!, actions);
    const v = vm(3);
    v.queue[1].current = true; v.queue[2].bad = true;
    ui.update(v);
    const rows = [...document.querySelectorAll('.item')];
    rows.forEach((r) => r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(playNow).toHaveBeenCalledTimes(1);
    expect(playNow).toHaveBeenCalledWith('v0');
  });
});

describe('source label', () => {
  it('asks for a playlist until one is loaded, then names the source', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const ui = buildConsole(document.getElementById('root')!, new Proxy({}, { get: () => vi.fn() }) as unknown as Actions);
    const pill = document.querySelector('.pill') as HTMLElement;
    expect(pill.textContent).toBe('↓ Carica la tua playlist (Spotify / YouTube)');
    expect(pill.className).toContain('empty');
    ui.setSource('Spotify');
    expect(pill.textContent).toBe('Sorgente: Spotify');
    expect(pill.className).toBe('pill sp');
    ui.setSource('YouTube');
    expect(pill.textContent).toBe('Sorgente: YouTube');
    expect(pill.className).toBe('pill yt');
  });
});


describe('ads panel', () => {
  const mount = () => {
    document.body.innerHTML = '<div id="root"></div>';
    const setAdGuard = vi.fn();
    const actions = new Proxy({ setAdGuard }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    return { ui: buildConsole(document.getElementById('root')!, actions), setAdGuard };
  };
  const text = () => ([...document.querySelectorAll('.panel')].find((p) => p.querySelector('h3')?.textContent === 'Pubblicità') as HTMLElement).textContent!;
  it('says what it hears, and when it lowered the volume', () => {
    const { ui } = mount();
    const v = vm(1);
    ui.update(v);
    expect(text()).toContain('Spento.');
    ui.update({ ...v, ads: { ...v.ads, on: true, kind: 'music' } });
    expect(text()).toContain('Sento musica');
    ui.update({ ...v, ads: { ...v.ads, on: true, kind: 'speech', ducking: true } });
    expect(text()).toContain('volume abbassato');
  });
  it('explains missing permission when nothing is heard while music should play, and the browser case', () => {
    const { ui } = mount();
    const v = vm(1);
    ui.update({ ...v, ads: { ...v.ads, on: true, kind: 'silence', playing: true, silentFor: 20 } });
    expect(text()).toContain('Impostazioni di Sistema');
    ui.update({ ...v, ads: { ...v.ads, available: false } });
    expect(text()).toContain('solo nell’app installata');
    expect((document.querySelector('input[aria-label="Abbassa il volume durante le pubblicità"]') as HTMLInputElement).disabled).toBe(true);
  });
  it('turns the feature on from the checkbox and shows capture errors', () => {
    const { ui, setAdGuard } = mount();
    const v = vm(1);
    ui.update(v);
    const box = document.querySelector('input[aria-label="Abbassa il volume durante le pubblicità"]') as HTMLInputElement;
    box.checked = true; box.dispatchEvent(new Event('change'));
    expect(setAdGuard).toHaveBeenCalledWith(true);
    ui.update({ ...v, ads: { ...v.ads, error: 'permesso negato' } });
    expect(text()).toContain('permesso negato');
  });
  it('chooses what to do with short tracks, and says when it treats one as a spot', () => {
    const setSpotMode = vi.fn();
    document.body.innerHTML = '<div id="root"></div>';
    const actions = new Proxy({ setSpotMode }, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
    const ui = buildConsole(document.getElementById('root')!, actions);
    const v = vm(1);
    ui.update({ ...v, ads: { ...v.ads, on: true, kind: 'music', spotMode: 'skip' } });
    const sel = document.querySelector('select[aria-label="Brani brevi (spot)"]') as HTMLSelectElement;
    expect(sel.value).toBe('skip');
    sel.value = 'duck'; sel.dispatchEvent(new Event('change'));
    expect(setSpotMode).toHaveBeenCalledWith('duck');
    ui.update({ ...v, ads: { ...v.ads, on: true, kind: 'music', spotMode: 'duck', spotNow: true } });
    expect(text()).toContain('Brano breve (spot)');
  });
  it('shows an automatic duck on the deck button', () => {
    const { ui } = mount();
    const v = vm(1);
    v.decks = [{ ...v.decks[0], autoDuck: true }, v.decks[1]];
    ui.update(v);
    expect(document.body.textContent).toContain('Pubblicità: volume abbassato (auto)');
  });
});
