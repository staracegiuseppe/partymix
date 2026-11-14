import { DlError, DlJob, DlRequest, DownloadClient, tauriDownloadClient } from '../src/download/client';
import { DownloadCoordinator, youtubeIdOf } from '../src/download/manager';
import { MemoryKV } from '../src/library/kv';
import { KvBlobStore } from '../src/library/blobStore';
import { MusicLibrary } from '../src/library/library';
import { PlaylistStore } from '../src/library/playlists';
import { buildDownloadsUI } from '../src/ui/downloadsUI';

/** A download manager like the app's: answers at once with a QUEUED job, the test drives the updates. */
function fakeClient() {
  let n = 0;
  const jobs = new Map<string, DlJob>();
  let push: (j: DlJob) => void = () => {};
  const c: DownloadClient & { finish(id: string, meta?: Partial<DlJob['meta']>): void; progress(id: string, p: number): void; fail(id: string, code: DlJob['error_code'], msg: string): void } = {
    create: vi.fn(async (request: DlRequest) => {
      if (!/^https:\/\//.test(request.url)) throw new DlError('INVALID_URL', 'Indirizzo non valido: deve cominciare con https://');
      const j: DlJob = { id: `j${++n}`, request, status: 'QUEUED', progress: 0, downloaded_bytes: 0, created_at: n, updated_at: n };
      jobs.set(j.id, j);
      return j;
    }),
    list: async () => [...jobs.values()],
    get: async (id) => jobs.get(id)!,
    cancel: vi.fn(async (id: string) => { const j = { ...jobs.get(id)!, status: 'CANCELLED' as const }; jobs.set(id, j); return j; }),
    remove: vi.fn(async (id: string) => { jobs.delete(id); }),
    config: async (max?: number) => ({ max: max ?? 2, ytdlp: true, ffmpeg: true, root: '/Users/x/Music/PartyMix Library' }),
    onUpdate: (fn) => { push = fn; },
    progress(id, p) { const j = { ...jobs.get(id)!, status: 'DOWNLOADING' as const, progress: p, speed: '3.8 MB/s', eta: 4, downloaded_bytes: 8.4 * 2 ** 20, total_bytes: 10.2 * 2 ** 20 }; jobs.set(id, j); push(j); },
    finish(id, meta = {}) {
      const j0 = jobs.get(id)!;
      const vid = youtubeIdOf(j0.request.url);
      const j: DlJob = { ...j0, status: 'COMPLETED', progress: 100, meta: { title: 'Me at the zoo', artist: 'jawed', duration: 19, source_url: j0.request.url, content_id: vid ?? 'x1', extractor: vid ? 'Youtube' : 'Generic', local_filename: `music/Me at the zoo [${vid}].mp3`, mime_type: 'audio/mpeg', file_size: 457389, created_at: 1, ...meta } };
      jobs.set(id, j); push(j);
    },
    fail(id, code, msg) { const j = { ...jobs.get(id)!, status: 'FAILED' as const, error_code: code, message: msg }; jobs.set(id, j); push(j); },
  };
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
async function setup() {
  const kv = new MemoryKV();
  const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
  const pls = new PlaylistStore(kv, { saveDelayMs: 0 });
  const c = fakeClient();
  const status = vi.fn();
  const changed = vi.fn();
  const coord = new DownloadCoordinator(c, lib, pls, { status, playlistChanged: changed });
  await coord.start();
  return { lib, pls, c, coord, status, changed };
}
const req = (url: string, extra: Partial<DlRequest> = {}): DlRequest => ({ url, type: 'audio', format: 'mp3', quality: 'best', ...extra });
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

describe('download manager in the app', () => {
  it('maps the REST routes to the app commands', async () => {
    const invoke = vi.fn(async () => ({}));
    const c = tauriDownloadClient(invoke, vi.fn(async () => () => {}));
    await c.create(req(ZOO)); await c.list(); await c.get('a'); await c.cancel('a'); await c.remove('a'); await c.config(3);
    expect(invoke.mock.calls).toEqual([['dl_create', { request: req(ZOO) }], ['dl_list'], ['dl_get', { id: 'a' }], ['dl_cancel', { id: 'a' }], ['dl_remove', { id: 'a' }], ['dl_config', { max: 3 }]]);
  });
  it('turns app errors into readable messages with their code', async () => {
    const c = tauriDownloadClient(async () => { throw { error_code: 'DISK_FULL', message: 'Spazio insufficiente nella libreria locale.' }; }, vi.fn());
    await expect(c.create(req(ZOO))).rejects.toMatchObject({ code: 'DISK_FULL', message: 'Spazio insufficiente nella libreria locale.' });
  });
  it('reads YouTube ids from every kind of link', () => {
    expect(youtubeIdOf('https://youtu.be/jNQXAC9IVRw?si=x')).toBe('jNQXAC9IVRw');
    expect(youtubeIdOf('https://music.youtube.com/watch?v=jNQXAC9IVRw&list=x')).toBe('jNQXAC9IVRw');
    expect(youtubeIdOf('https://www.youtube.com/shorts/jNQXAC9IVRw')).toBe('jNQXAC9IVRw');
    expect(youtubeIdOf('https://example.com/a.mp3')).toBeUndefined();
  });
});

describe('download → library → playlist → offline', () => {
  it('a finished YouTube download is in My Library at once, offline, with its metadata', async () => {
    const { lib, c, coord, status } = await setup();
    const j = (await coord.download(req(ZOO)))!;
    expect(j.status).toBe('QUEUED');
    c.progress(j.id, 63.4);
    expect(coord.get(j.id)!.progress).toBe(63.4);
    c.finish(j.id);
    await flush(); await flush();
    const e = lib.get('jNQXAC9IVRw')!;
    expect(e).toMatchObject({ title: 'Me at the zoo', artist: 'jawed', durationSec: 19, file: 'music/Me at the zoo [jNQXAC9IVRw].mp3', size: 457389, source: 'download', mime: 'audio/mpeg' });
    expect(lib.isOffline('jNQXAC9IVRw')).toBe(true);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('✓ Download completato'));
  });
  it('goes into the playlist of the request, once', async () => {
    const { pls, c, coord, changed } = await setup();
    const p = pls.create('Party 1');
    const j = (await coord.download(req(ZOO, { playlist_id: p.id })))!;
    c.finish(j.id);
    await flush(); await flush();
    expect(pls.get(p.id)!.tracks.map((t) => t.videoId)).toEqual(['jNQXAC9IVRw']);
    expect(changed).toHaveBeenCalledWith(p.id);
    await coord.download(req('https://youtu.be/jNQXAC9IVRw', { playlist_id: p.id })); // already offline: not asked again
    expect(pls.get(p.id)!.tracks).toHaveLength(1);
  });
  it('a YouTube song already offline is not downloaded again («✓ Già scaricato»)', async () => {
    const { c, coord, status } = await setup();
    const j = (await coord.download(req(ZOO)))!;
    c.finish(j.id);
    await flush(); await flush();
    expect(await coord.download(req('https://youtu.be/jNQXAC9IVRw'))).toBeUndefined();
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('✓ Già scaricato'));
  });
  it('a download from another site gets its own local id', async () => {
    const { lib, c, coord } = await setup();
    const j = (await coord.download(req('https://archive.org/download/x/song.mp3')))!;
    c.finish(j.id, { title: 'Song', local_filename: 'music/Song [x1].mp3' });
    await flush(); await flush();
    const e = lib.all().find((x) => x.title === 'Song')!;
    expect(e.id).toMatch(/^local:/);
    expect(lib.isOffline(e.id)).toBe(true);
  });
  it('downloads finished while the app was closed join the library at start', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const c = fakeClient();
    const j = await c.create(req(ZOO));
    c.finish(j.id);
    const coord = new DownloadCoordinator(c, lib, new PlaylistStore(kv), { status: vi.fn(), playlistChanged: vi.fn() });
    await coord.start();
    await flush(); await flush();
    expect(lib.isOffline('jNQXAC9IVRw')).toBe(true);
  });
  it('errors, cancel, retry and removal', async () => {
    const { c, coord, status } = await setup();
    expect(await coord.download(req('file:///etc/passwd'))).toBeUndefined();
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Indirizzo non valido'), true);
    const j = (await coord.download(req(ZOO)))!;
    c.fail(j.id, 'NETWORK', 'Connessione interrotta o assente: riprova quando la rete funziona.');
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Connessione interrotta'), true);
    await coord.retry(j.id);
    expect(c.remove).toHaveBeenCalledWith(j.id);
    expect(c.create).toHaveBeenCalledTimes(3); // the refused file:// one, the first try, the retry
    const k = coord.list()[0];
    await coord.cancel(k.id);
    expect(coord.get(k.id)!.status).toBe('CANCELLED');
    await coord.remove(k.id);
    expect(coord.get(k.id)).toBeUndefined();
  });
});

describe('⬇ Download view', () => {
  it('shows each download with bar, %, speed, ETA and sizes, then Play / Add to Playlist / Open Library', async () => {
    const { pls, c, coord } = await setup();
    pls.create('Party 1');
    const play = vi.fn(), open = vi.fn();
    localStorage.clear();
    const ui = buildDownloadsUI({ coord, playlists: () => pls.list(), play, addToPlaylist: vi.fn(), openLibrary: open, store: localStorage });
    document.body.replaceChildren(ui.el);
    ui.update();
    const url = ui.el.querySelector<HTMLInputElement>('input[type=url]')!;
    url.value = ZOO;
    ui.el.querySelector<HTMLButtonElement>('.dlform button')!.click();
    await flush();
    expect(c.create).toHaveBeenCalledWith({ url: ZOO, type: 'audio', format: 'mp3', quality: 'best' });
    const id = coord.list()[0].id;
    c.progress(id, 82);
    ui.update();
    const row = () => ui.el.querySelector<HTMLElement>('.dlrow')!;
    expect(row().querySelector('.dlinfo')!.textContent).toBe('82% · 3.8 MB/s · ETA 4s · 8.4 MB / 10.2 MB');
    expect(row().querySelector('.bar i')!.getAttribute('style')).toMatch(/width:\s*82%/);
    expect([...row().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Annulla']);
    c.finish(id);
    await flush(); await flush();
    ui.update();
    expect(row().querySelector('.dlstate')!.textContent).toBe('✓ Completato');
    const labels = [...row().querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['▶ Play', '＋ Playlist', '📚 Apri libreria', '✕']);
    [...row().querySelectorAll('button')][2].click();
    expect(open).toHaveBeenCalled();
  });
  it('warns when yt-dlp is old (the cause of «HTTP 403»), with the command to update it', async () => {
    const { pls, coord } = await setup();
    coord.cfg = { max: 2, ytdlp: true, ffmpeg: true, root: '/x', ytdlp_version: '2026.03.17', ytdlp_age_days: 243, update_hint: 'brew upgrade yt-dlp' };
    const ui = buildDownloadsUI({ coord, playlists: () => pls.list(), play: vi.fn(), addToPlaylist: vi.fn(), openLibrary: vi.fn() });
    ui.update();
    const t = ui.el.querySelector('.status')!;
    expect(t.textContent).toContain('yt-dlp 2026.03.17 è vecchio (243 giorni)');
    expect(t.textContent).toContain('«brew upgrade yt-dlp»');
    expect(t.classList.contains('error')).toBe(true);
  });
  it('video: format and quality are chosen and remembered', async () => {
    const { pls, c, coord } = await setup();
    localStorage.clear();
    const mk = () => buildDownloadsUI({ coord, playlists: () => pls.list(), play: vi.fn(), addToPlaylist: vi.fn(), openLibrary: vi.fn(), store: localStorage });
    const ui = mk();
    document.body.replaceChildren(ui.el);
    const [type, format, quality] = [...ui.el.querySelectorAll<HTMLSelectElement>('.dlopts select')];
    type.value = 'video'; type.dispatchEvent(new Event('change'));
    expect([...format.options].map((o) => o.value)).toEqual(['mp4', 'webm']);
    quality.value = '720'; quality.dispatchEvent(new Event('change'));
    expect(ui.request(ZOO)).toEqual({ url: ZOO, type: 'video', format: 'mp4', quality: '720' });
    expect(mk().request(ZOO)).toEqual({ url: ZOO, type: 'video', format: 'mp4', quality: '720' });
    expect(c.create).not.toHaveBeenCalled();
  });
});
