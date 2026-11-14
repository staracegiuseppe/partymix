import { buildConsole, Actions, ViewModel } from '../src/ui/console';
import { applyPhoneTheme } from '../src/ui/material';

const deck = { title: '', artist: '', elapsed: 0, duration: 0, role: 'idle' as const, volume: 100, duck: false };
const vm = (): ViewModel => ({
  ads: { available: false, on: false, kind: 'silence', level: 0, silentFor: 0, threshold: 4, ducking: false, playing: false },
  karaoke: { running: false, waiting: false, total: 0, done: 0, synced: 0, plain: 0, none: 0, pending: 0, auto: true },
  lyrics: { status: '', prev: '', cur: '', next: '', progress: 0, offset: 0, speed: 1, show: true, canShift: false, lines: [], index: -1 },
  state: 'playing', active: 0, ready: true, decks: [{ ...deck, role: 'live', title: 'Uno' }, { ...deck, role: 'ready', title: 'Due' }], mix: 0, master: 80, profile: 'standard', shuffle: false, repeat: 'off',
  queue: ['Uno', 'Due', 'Tre'].map((t, i) => ({ id: 'v' + i, title: t, artist: 'A', bad: false, locked: false, current: i === 0 })),
  history: [], problems: [],
});

function setup() {
  history.replaceState(null, '', '/?android');
  document.body.className = '';
  document.body.innerHTML = '<div id="root"></div>';
  const fns = { removeTrack: vi.fn(), move: vi.fn(), selectPlaylist: vi.fn(), playNow: vi.fn() };
  const actions = new Proxy(fns, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) }) as unknown as Actions;
  const ui = buildConsole(document.getElementById('root')!, actions);
  ui.update(vm());
  return { ui, fns };
}
const sheetItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.m-sheet.on .m-sheet-item, .m-sheet:last-child .m-sheet-item')].find((b) => b.textContent?.includes(label))!;

describe('phone layout (Material Design)', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('has four destinations, «In onda» first, and switches between them', () => {
    setup();
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.m-nav-item')];
    expect(nav.map((b) => b.textContent)).toEqual(['In onda', 'Playlist', 'Proiettore', 'Altro']);
    expect(document.querySelector('.m-screen.on')?.getAttribute('data-screen')).toBe('now');
    nav[1].click();
    expect(document.querySelector('.m-screen.on')?.getAttribute('data-screen')).toBe('list');
    expect(document.querySelector('[data-screen=now]')?.hasAttribute('inert')).toBe(true);
  });

  it('lists the four playlists in a menu by name, with how many songs each keeps', () => {
    const { ui, fns } = setup();
    ui.setPlaylistSlots(2, ['l1', '', 'l3', ''], ['Festa', 'Karaoke', '', ''], [12, 0, 1, 0]);
    const sel = document.querySelector<HTMLSelectElement>('.slotsel')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['1 · Festa — 12 brani', '2 · Karaoke — vuota', '3 · Playlist 3 — 1 brano', '4 · Playlist 4 — vuota']);
    expect(sel.value).toBe('2');
    sel.value = '3';
    sel.dispatchEvent(new Event('change'));
    expect(fns.selectPlaylist).toHaveBeenCalledWith(3);
  });

  it('a song opens a sheet: the one on air cannot be removed, another one can', () => {
    const { fns } = setup();
    const rows = document.querySelectorAll<HTMLElement>('.m-item');
    rows[0].click();
    expect(sheetItem('In onda').disabled).toBe(true);
    document.querySelector('.m-sheet')?.remove();
    rows[2].click();
    expect(document.querySelectorAll('.m-sheet')).toHaveLength(1);
    sheetItem('Togli').click();
    expect(fns.removeTrack).toHaveBeenCalledWith('v2');
  });

  it('«Suona dopo quello in onda» puts the song right after the current one', () => {
    const { fns } = setup();
    document.querySelectorAll<HTMLElement>('.m-item')[2].click();
    sheetItem('Suona dopo').click();
    expect(fns.move).toHaveBeenCalledWith(2, 1);
  });

  it('the deck being heard is the big card', () => {
    setup();
    expect(document.querySelector('.deck.a')?.classList.contains('is-live')).toBe(true);
    expect(document.querySelector('.deck.b')?.classList.contains('is-live')).toBe(false);
  });
});

describe('colours like the phone', () => {
  afterEach(() => { delete (window as unknown as { PartyMixAndroid?: unknown }).PartyMixAndroid; document.body.removeAttribute('style'); });
  it('takes light/dark and the Material You palette from the app, and follows a change', () => {
    let reply = { dark: false, colors: { primary: '#0b57d0', surface: '#fdfbff', bogus: 'red', 'on-surface': 'url(x)' } as Record<string, string> };
    (window as unknown as { PartyMixAndroid: unknown }).PartyMixAndroid = { theme: () => JSON.stringify(reply) };
    applyPhoneTheme();
    expect(document.body.classList.contains('light')).toBe(true);
    expect(document.body.style.getPropertyValue('--md-primary')).toBe('#0b57d0');
    expect(document.body.style.getPropertyValue('--md-on-surface')).toBe('');
    reply = { dark: true, colors: {} };
    window.dispatchEvent(new Event('partymix-theme'));
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.style.getPropertyValue('--md-primary')).toBe('');
  });
});
