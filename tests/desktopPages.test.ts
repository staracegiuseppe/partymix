import { MemoryKV } from '../src/library/kv';
import { KvBlobStore } from '../src/library/blobStore';
import { MusicLibrary, LibEntry } from '../src/library/library';
import { PlaylistStore } from '../src/library/playlists';
import { buildDesktopPages, PagesDeps, whereText } from '../src/ui/desktopPages';
import type { Track } from '../src/queue';

const tr = (id: string, title: string, artist = ''): Track => ({ videoId: id, title, artist, status: 'ok' });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(extra: Partial<PagesDeps> = {}) {
  document.body.innerHTML = '';
  const kv = new MemoryKV();
  const library = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
  const playlists = new PlaylistStore(kv, { saveDelayMs: 0 });
  const party = playlists.create('Festa di Marco', { tracks: [tr('aaaaaaaaaaa', 'Blinding Lights', 'The Weeknd'), tr('bbbbbbbbbbb', 'Volare', 'Modugno')] });
  playlists.create('Karaoke', { tracks: [tr('aaaaaaaaaaa', 'Blinding Lights', 'The Weeknd'), ...Array.from({ length: 3000 }, (_, i) => tr(`k${String(i).padStart(10, '0')}`, `Canzone ${i}`, 'Vari'))] });
  library.addOnline(tr('ccccccccccc', 'Solo in libreria', 'X'));
  const fns = { playTrack: vi.fn(), playOnly: vi.fn(), enqueue: vi.fn(), playPlaylist: vi.fn(), menu: vi.fn(), go: vi.fn(), status: vi.fn(), edited: vi.fn(), deleted: vi.fn(), loadLink: vi.fn(), search: vi.fn(async () => ({ hits: [{ videoId: 'ddddddddddd', title: 'Blinding Lights (Live)', channel: 'TheWeekndVEVO', seconds: 260, thumb: 't.jpg', available: true }, { videoId: 'eeeeeeeeeee', title: 'Bloccato', channel: 'X', seconds: 100, thumb: 'u.jpg', available: false, reason: 'Video privato' }], via: 'api' as const })) };
  const deps: PagesDeps = {
    playlists, library, playingId: () => party.id, sort: () => 'custom', setSort: vi.fn(), apiKey: () => '', setApiKey: vi.fn(), online: () => true,
    trackById: () => undefined, ...fns, ...extra,
  };
  const ui = buildDesktopPages(deps);
  document.body.append(ui.pages.playlists, ui.pages.search, ui.pages.library);
  return { ui, fns, playlists, library, party };
}
const shown = (root: Element) => [...root.querySelectorAll<HTMLElement>('.song')].filter((r) => r.style.display !== 'none').sort((a, b) => +a.dataset.i! - +b.dataset.i!);

describe('where a song is (information only)', () => {
  it('names the playlists and the file on the computer', () => {
    const e = { id: 'local:00112233', title: 'Uno', artist: 'A', album: '', source: 'file', file: 'Artista A/Uno.mp3', origin: 'Download/vecchi/Uno.mp3', addedAt: 1 } as LibEntry;
    const w = whereText(e, ['Festa', 'Karaoke', 'Estate', 'Matrimonio'], 'nella cartella Musica › PartyMix Library');
    expect(w.short).toBe('📂 Festa, Karaoke +2 · 💾 Artista A/Uno.mp3');
    expect(w.full).toContain('File sul computer: Musica › PartyMix Library › Artista A › Uno.mp3');
    expect(w.full).toContain('Importato da: Download/vecchi/Uno.mp3');
  });
});

describe('📋 Playlist page', () => {
  it('lists every playlist as a card with its songs, the one playing marked', () => {
    const { ui } = setup();
    const cards = [...ui.pages.playlists.querySelectorAll('.pl-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.pl-name')!.textContent).toBe('Festa di Marco');
    expect(cards[0].querySelector('.pl-badge')!.textContent).toBe('▶ In riproduzione');
    expect(cards[1].querySelector('.pl-info')!.textContent).toMatch(/3\.?001 brani/);
  });
  it('100 playlists, searchable', () => {
    const { ui, playlists } = setup();
    for (let i = 0; i < 100; i++) playlists.create(`Lista ${i}`);
    ui.update('playlists');
    expect(ui.pages.playlists.querySelectorAll('.pl-card')).toHaveLength(102);
    const s = ui.pages.playlists.querySelector<HTMLInputElement>('.pg-search')!;
    s.value = 'lista 9'; s.dispatchEvent(new Event('input'));
    expect(ui.pages.playlists.querySelectorAll('.pl-card')).toHaveLength(11); // 9, 90…99
  });
  it('a playlist opens on its own page: head, numbered songs, and «Fine playlist»', () => {
    const { ui, fns } = setup();
    (ui.pages.playlists.querySelectorAll<HTMLElement>('.pl-card')[1]).click();
    const detail = ui.pages.playlists.querySelector('.pl-detail')!;
    expect(detail.classList.contains('hidden')).toBe(false);
    expect(detail.querySelector('.pg-title')!.textContent).toBe('Karaoke');
    expect(detail.querySelector('.sl-head')!.textContent).toContain('PLAYLIST: Karaoke');
    expect(detail.querySelector('.sl-foot')!.textContent).toMatch(/■ Fine playlist · 3\.?001 brani/);
    expect(shown(detail)[0].querySelector('.lead')!.textContent).toBe('1');
    expect(fns.go).toHaveBeenCalledWith('playlists');
    detail.querySelector<HTMLButtonElement>('.pg-actions .m-filled')!.click();
    expect(fns.playPlaylist).toHaveBeenCalled();
  });
});

describe('🔎 Cerca page: results right under the field', () => {
  it('YouTube results under the search card, with an unavailable one marked', async () => {
    const { ui, fns } = setup();
    const input = ui.pages.search.querySelector<HTMLInputElement>('.pg-input')!;
    input.value = 'The Weeknd Blinding Lights';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush(); await flush();
    expect(fns.search).toHaveBeenCalledWith('The Weeknd Blinding Lights', undefined);
    const card = ui.pages.search.querySelector('.search-card')!;
    const head = ui.pages.search.querySelector('.pg-results-head')!;
    expect(card.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(head.textContent).toBe('2 risultati per «The Weeknd Blinding Lights» su YouTube');
    const rows = shown(ui.pages.search);
    expect(rows[0].querySelector('.t')!.textContent).toContain('Blinding Lights (Live)');
    expect(rows[1].classList.contains('skip')).toBe(true);
    expect(rows[1].querySelector('.s')!.textContent).toContain('Video privato');
    rows[0].querySelector<HTMLButtonElement>('.play')!.click();
    expect(fns.playTrack).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'ddddddddddd' }));
    rows[0].querySelector<HTMLButtonElement>('.more')!.click();
    const items = (fns.menu.mock.calls.at(-1) as [string, string, { label: string; run(): void }[]])[2];
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['Riproduci adesso', 'Suona dopo quello in onda', 'Metti in coda (in fondo)', 'Aggiungi a playlist…']));
    items.find((i) => i.label.startsWith('Solo questo brano'))!.run();
    expect(fns.playOnly).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'ddddddddddd' }));
    items.find((i) => i.label === 'Metti in coda (in fondo)')!.run();
    expect(fns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'ddddddddddd' }), false);
  });
  it('«La mia musica» searches the library and every playlist, and says where each song is', () => {
    const { ui } = setup();
    [...ui.pages.search.querySelectorAll<HTMLButtonElement>('.seg-btn')][1].click();
    const input = ui.pages.search.querySelector<HTMLInputElement>('.pg-input')!;
    input.value = 'blinding'; input.dispatchEvent(new Event('input'));
    const rows = shown(ui.pages.search);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.s')!.textContent).toContain('📂 Festa di Marco, Karaoke');
    input.value = 'MARCO'; input.dispatchEvent(new Event('input'));
    expect(shown(ui.pages.search).map((r) => r.querySelector('.t')!.firstChild!.textContent).sort()).toEqual(['Blinding Lights', 'Volare']);
  });
  it('«Aggiungi a playlist» opens a dialog with the playlists and «Nuova playlist», without changing page', async () => {
    const { ui, fns, playlists, party } = setup();
    ui.pickPlaylist(['ccccccccccc']);
    const [title, , items] = fns.menu.mock.calls.at(-1) as [string, string, { label: string; run(): void }[]];
    expect(title).toBe('Aggiungi a playlist');
    expect(items[0].label).toBe('Nuova playlist…');
    items.find((i) => i.label.startsWith('Festa di Marco'))!.run();
    expect(playlists.get(party.id)!.tracks.map((t) => t.videoId)).toContain('ccccccccccc');
    expect(fns.go).not.toHaveBeenCalled();
  });
});

describe('🎧 Libreria page', () => {
  it('shows an empty state with Importa musica / Cerca musica when empty', () => {
    document.body.innerHTML = '';
    const kv = new MemoryKV();
    const ui = buildDesktopPages({ playlists: new PlaylistStore(kv), library: new MusicLibrary({ kv, blobs: new KvBlobStore(kv) }), playingId: () => undefined, sort: () => 'custom', setSort: vi.fn(), apiKey: () => '', setApiKey: vi.fn(), online: () => true, playPlaylist: vi.fn(), loadLink: vi.fn(), edited: vi.fn(), deleted: vi.fn(), playTrack: vi.fn(), playOnly: vi.fn(), enqueue: vi.fn(), trackById: () => undefined, search: vi.fn(), status: vi.fn(), menu: vi.fn(), go: vi.fn() });
    const es = ui.pages.library.querySelector('.empty-state')!;
    expect(es.classList.contains('hidden')).toBe(false);
    expect(es.textContent).toContain('La tua libreria è vuota');
    expect([...es.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['+ Importa musica', '🔎 Cerca musica']);
  });
  it('filters with chips (Preferiti) and the search field', () => {
    const { ui, library } = setup();
    library.toggleFavorite('ccccccccccc');
    const chip = [...ui.pages.library.querySelectorAll<HTMLButtonElement>('.chip')].find((c) => c.textContent === 'Preferiti')!;
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(shown(ui.pages.library).map((r) => r.querySelector('.t .tin')!.firstChild!.textContent)).toEqual(['Solo in libreria']);
  });
});

describe('⬇ Scarica tutta la playlist, ☑ Seleziona, MP3 o MP4', () => {
  const fakeDownloads = () => ({ available: () => true, downloadMany: vi.fn(async () => ({ queued: 1, already: 0, failed: 0 })), download: vi.fn(async () => undefined), list: () => [], active: () => 0, version: 0, cfg: { max: 2, ytdlp: true, ffmpeg: true, root: '/x' }, libraryId: async () => '', cancel: vi.fn(), remove: vi.fn(), retry: vi.fn(), setMax: vi.fn(), get: () => undefined, start: vi.fn(), apply: vi.fn() });
  const choose = (fns: { menu: ReturnType<typeof vi.fn> }, startsWith: string) => {
    const [title, sub, items] = fns.menu.mock.calls.at(-1) as [string, string, { label: string; run(): void }[]];
    const it = items.find((i) => i.label.startsWith(startsWith))!;
    it.run();
    return { title, sub, labels: items.map((i) => i.label) };
  };
  it('the whole playlist: asks MP3 or MP4 first, then downloads every song in one go (local files skipped)', () => {
    localStorage.clear();
    const dl = fakeDownloads();
    const { ui, fns, playlists } = setup({ downloads: dl as never, store: localStorage });
    const p = playlists.list()[0];
    playlists.addTracks(p.id, [tr('local:0011223344556677', 'Mio file')]);
    ui.openPlaylist(p.id);
    const all = [...ui.pages.playlists.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '⬇ Scarica tutta la playlist')!;
    all.click();
    const { title, sub, labels } = choose(fns, '🎬 Video MP4 —');
    expect(title).toBe('Scarica la playlist «Festa di Marco»');
    expect(sub).toBe('2 brani · scegli il formato');
    expect(labels[0]).toMatch(/^🎵 Audio MP3/);
    expect(dl.downloadMany).toHaveBeenCalledWith([
      { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', type: 'video', format: 'mp4', quality: 'best' },
      { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', type: 'video', format: 'mp4', quality: 'best' },
    ], 'la playlist «Festa di Marco»');
    all.click(); // the last choice comes first next time
    expect((fns.menu.mock.calls.at(-1) as [string, string, { label: string }[]])[2][0].label).toMatch(/^🎬 Video MP4 — .*ultima scelta$/);
  });
  it('select songs (click, Shift+click, all, none) and download only those', () => {
    localStorage.clear();
    const dl = fakeDownloads();
    const { ui, fns, playlists } = setup({ downloads: dl as never, store: localStorage });
    const k = playlists.list()[1];
    ui.openPlaylist(k.id);
    const page = ui.pages.playlists;
    [...page.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '☑ Seleziona')!.click();
    const bar = page.querySelector('.selbar')!;
    expect(bar.classList.contains('hidden')).toBe(false);
    const rows = () => shown(page);
    expect(rows()[0].querySelector('.lead')!.textContent).toBe('☐');
    rows()[1].click();
    rows()[4].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(bar.querySelector('.sel-count')!.textContent).toBe('4 selezionati');
    expect(rows()[2].querySelector('.lead')!.textContent).toBe('☑');
    [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '⬇ Scarica selezionati')!.click();
    choose(fns, '🎵 Audio MP3');
    expect((dl.downloadMany.mock.calls[0] as unknown as [{ type: string }[]])[0]).toHaveLength(4);
    expect((dl.downloadMany.mock.calls[0] as unknown as [{ type: string; format: string }[]])[0][0]).toMatchObject({ type: 'audio', format: 'mp3' });
    [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Seleziona tutti')!.click();
    expect(bar.querySelector('.sel-count')!.textContent).toMatch(/^3\.?001 selezionati$/);
    [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '✕ Fine')!.click();
    expect(bar.classList.contains('hidden')).toBe(true);
    expect(rows()[0].querySelector('.lead')!.textContent).toBe('1');
  });
  it('one song: ⬇ also asks MP3 or MP4', () => {
    localStorage.clear();
    const dl = fakeDownloads();
    const { ui, fns } = setup({ downloads: dl as never, store: localStorage, trackById: (id) => (id === 'aaaaaaaaaaa' ? tr(id, 'Blinding Lights') : undefined) });
    ui.offline('aaaaaaaaaaa');
    choose(fns, '🎬 Video MP4 720p');
    expect(dl.download).toHaveBeenCalledWith({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', type: 'video', format: 'mp4', quality: '720' });
  });
});

describe('✨ commands in Italian (no AI): proposal first, nothing changes before ✓', () => {
  const hit = (id: string, title: string, views: number, ageDays = 200, seconds = 200) => ({ videoId: id.padEnd(11, 'x'), title, channel: 'Ubisoft', seconds, thumb: '', available: true, views, ageDays });
  const hits = [hit('a', 'Just Dance 2024 - Flowers', 5e6), hit('b', 'Just Dance - Calm Down', 9e6), hit('c', 'Just Dance tutorial', 2e7), hit('d', 'Just Dance 2016 - Old', 3e7, 3000), hit('e', 'Just Dance - Acoustic piano', 1e7), hit('f', 'Just Dance - Levitating', 1e6)];
  const run = async (ui: ReturnType<typeof setup>['ui'], text: string) => {
    const input = ui.pages.search.querySelector<HTMLInputElement>('.pg-input')!;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    for (let k = 0; k < 5; k++) await flush();
  };
  it('the user’s sentence: understood, filtered, most viewed first, all ticked; ✓ adds to the playlist in use', async () => {
    const search = vi.fn(async () => ({ hits, via: 'api' as const }));
    const { ui, playlists, party } = setup({ search });
    await run(ui, 'vai su youtube, cercami i video di justdance che piacciono di più ai giovani e sono ballabili ed aggiungili alla mia playlist');
    expect(search).toHaveBeenCalledWith('just dance', undefined, 50);
    const bar = ui.pages.search.querySelector('.cmd-bar')!;
    expect(bar.classList.contains('hidden')).toBe(false);
    expect(bar.textContent).toContain('i più visti');
    const titles = shown(ui.pages.search).map((r) => r.querySelector('.t')!.textContent);
    expect(titles).toHaveLength(3); // no tutorial, nothing 8 years old, nothing acoustic
    expect(titles[0]).toContain('Calm Down');
    expect(playlists.get(party.id)!.tracks).toHaveLength(2); // nothing added yet
    const go = bar.querySelector<HTMLButtonElement>('.m-filled')!;
    expect(go.textContent).toBe('✓ Aggiungi 3 brani a «Festa di Marco»');
    go.click();
    expect(playlists.get(party.id)!.tracks).toHaveLength(5);
    expect(bar.classList.contains('hidden')).toBe(true);
  });
  it('«crea la playlist X con N…» creates it on ✓', async () => {
    const { ui, playlists } = setup({ search: vi.fn(async () => ({ hits, via: 'api' as const })) });
    await run(ui, 'crea la playlist Ballo con 2 canzoni just dance più famose');
    const go = ui.pages.search.querySelector<HTMLButtonElement>('.cmd-bar .m-filled')!;
    expect(go.textContent).toBe('✓ Crea «Ballo» con 2 brani');
    go.click();
    expect(playlists.list().find((p) => p.name === 'Ballo')!.tracks).toHaveLength(2);
  });
  it('«suona …» plays the first result at once', async () => {
    const { ui, fns } = setup({ search: vi.fn(async () => ({ hits, via: 'api' as const })) });
    await run(ui, 'suona just dance flowers');
    expect(fns.playTrack).toHaveBeenCalledTimes(1);
  });
  it('a plain search stays a plain search (no command bar)', async () => {
    const { ui, fns } = setup();
    await run(ui, 'The Weeknd Blinding Lights');
    expect(fns.search).toHaveBeenCalledWith('The Weeknd Blinding Lights', undefined);
    expect(ui.pages.search.querySelector('.cmd-bar')!.classList.contains('hidden')).toBe(true);
  });
});


describe('🔄 Aggiorna da YouTube on a playlist page', () => {
  it('shown only for a YouTube playlist link; it syncs and says what changed', async () => {
    const syncFromYouTube = vi.fn(async () => '🔄 «Festa di Marco» aggiornata: 2 brani nuovi, 0 tolti.');
    const { ui, fns, playlists, party } = setup({ syncFromYouTube });
    playlists.update(party.id, { link: 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop', source: 'YouTube' });
    ui.openPlaylist(party.id);
    const b = [...ui.pages.playlists.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.includes('Aggiorna da YouTube'))!;
    expect(b.classList.contains('hidden')).toBe(false);
    b.click();
    await flush(); await flush();
    expect(syncFromYouTube).toHaveBeenCalledWith(party.id);
    expect(fns.status).toHaveBeenCalledWith(expect.stringContaining('2 brani nuovi'));
  });
});
