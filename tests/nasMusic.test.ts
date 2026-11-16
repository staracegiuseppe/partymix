import { describe, expect, it, vi } from 'vitest';
import type { TrackDoc } from '../shared/model';
import { AudioDeck, AudioLike, HybridDeck, sourceText } from '../src/audioDeck';
import { KvBlobStore } from '../src/library/blobStore';
import { MemoryKV } from '../src/library/kv';
import { MusicLibrary } from '../src/library/library';
import type { SyncApi } from '../src/sync/client';
import { NasMusic } from '../src/sync/nasMusic';
import type { YouTubeDeck } from '../src/youtubeDeck';

const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const doc = (id: string, title: string, extra: Partial<TrackDoc> = {}): TrackDoc => ({ id, title, artist: 'Pino Daniele', size: 1000, mime: 'audio/mpeg', hasCover: false, addedAt: 1, metaVersion: 1, ...extra });

function fakeApi(files: Record<string, Uint8Array>, pages: TrackDoc[][] = []) {
  return {
    streamLink: vi.fn(async (id: string) => `http://192.168.1.10:8788/api/tracks/${id}/stream?d=x&e=1&s=y`),
    download: vi.fn(async (id: string, onProgress?: (g: number, t: number) => void) => {
      const f = files[id];
      if (!f) throw new Error('Brano non trovato');
      onProgress?.(f.length / 2, f.length);
      onProgress?.(f.length, f.length);
      return new Blob([f as BlobPart], { type: 'audio/mpeg' });
    }),
    library: vi.fn(async (cursor?: string) => {
      const i = cursor ? Number(cursor) : 0;
      return { tracks: pages[i] ?? [], ...(i + 1 < pages.length ? { next: String(i + 1) } : {}) };
    }),
  } as unknown as SyncApi;
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 2)); };

describe('brani del NAS nella libreria', () => {
  it('arrivano come ☁, cambiano titolo, se ne vanno quando il NAS li elimina; i brani caricati da qui restano quelli locali', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const m = new NasMusic({ library: lib, api: () => undefined });
    await m.applyTracks([doc(SHA_A, 'Napule è'), doc(SHA_B, 'Je so pazzo')]);
    expect(lib.get(`nas:${SHA_A}`)).toMatchObject({ source: 'nas', title: 'Napule è', nasId: SHA_A, nasSize: 1000 });
    expect(lib.stateOf(`nas:${SHA_A}`)).toBe('online');
    expect(lib.idForNas(SHA_A)).toBe(`nas:${SHA_A}`);
    await m.applyTracks([doc(SHA_A, 'Napule è (live)')]);
    expect(lib.get(`nas:${SHA_A}`)?.title).toBe('Napule è (live)');
    await m.applyTracks([{ ...doc(SHA_B, ''), deleted: true }]);
    expect(lib.get(`nas:${SHA_B}`)).toBeUndefined();
    // a file of this computer already on the NAS: no ☁ double
    lib.addOnline({ videoId: 'local:mine', title: 'Mio', status: 'ok' });
    await lib.setNasId('local:mine', 'c'.repeat(64));
    await m.applyTracks([doc('c'.repeat(64), 'Mio')]);
    expect(lib.get(`nas:${'c'.repeat(64)}`)).toBeUndefined();
  });

  it('tutta la libreria del NAS, pagina per pagina', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const api = fakeApi({}, [[doc(SHA_A, 'Uno')], [doc(SHA_B, 'Due')]]);
    const m = new NasMusic({ library: lib, api: () => api });
    expect(await m.refreshAll()).toBe(2);
    expect(lib.nasOnly().map((e) => e.title)).toEqual(['Uno', 'Due']);
  });

  it('«Salva su questo dispositivo»: copia con avanzamento, poi suona dal file; togliere la copia lo rimette ☁', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const bytes = new Uint8Array(1000).fill(7);
    const api = fakeApi({ [SHA_A]: bytes });
    const m = new NasMusic({ library: lib, api: () => api, freeSpace: async () => 10 * 2 ** 30 });
    await m.applyTracks([doc(SHA_A, 'Napule è')]);
    const id = `nas:${SHA_A}`;
    await m.save([id]);
    await until(() => !m.status().running);
    expect(m.status()).toMatchObject({ total: 1, done: 1, failed: 0, bytes: 1000 });
    expect(lib.isOffline(id)).toBe(true);
    expect(lib.stateOf(id)).toBe('offline');
    const cou = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:copia';
    try { expect(await lib.urlFor(id)).toBe('blob:copia'); } finally { URL.createObjectURL = cou; }
    expect(m.missing()).toEqual([]);
    await lib.deleteDownload(id);
    expect(lib.stateOf(id)).toBe('online');
    expect(m.missing()).toEqual([id]);
  });

  it('spazio insufficiente: non parte niente e dice quanto serve', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const api = fakeApi({ [SHA_A]: new Uint8Array(10) });
    const m = new NasMusic({ library: lib, api: () => api, freeSpace: async () => 100 << 20 });
    await m.applyTracks([doc(SHA_A, 'Grande', { size: 50 << 20 })]);
    await expect(m.save([`nas:${SHA_A}`])).rejects.toThrow(/Spazio insufficiente: servono 50 MB/);
    expect(api.download).not.toHaveBeenCalled();
    expect(m.status().running).toBe(false);
  });

  it('salva solo i brani del NAS delle playlist che mancano qui; un errore è segnato sul brano', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    const api = fakeApi({ [SHA_A]: new Uint8Array(5) });
    const m = new NasMusic({ library: lib, api: () => api });
    await m.applyTracks([doc(SHA_A, 'Uno'), doc(SHA_B, 'Due')]);
    const pl = [{ tracks: [{ videoId: `nas:${SHA_A}` }, { videoId: `nas:${SHA_B}` }, { videoId: 'dQw4w9WgXcQ' }] }] as never;
    expect(m.missing(pl)).toEqual([`nas:${SHA_A}`, `nas:${SHA_B}`]);
    await m.save(m.missing(pl));
    await until(() => !m.status().running);
    expect(m.status()).toMatchObject({ done: 1, failed: 1 });
    expect(lib.stateOf(`nas:${SHA_B}`)).toBe('error');
  });
});

describe('mixer: un brano del NAS', () => {
  function fakeAudio(): AudioLike & { srcs: string[] } {
    const ls = new Map<string, Set<() => void>>();
    const fire = (t: string) => { for (const fn of [...(ls.get(t) ?? [])]) fn(); };
    const a = {
      src: '', currentTime: 0, duration: 200, volume: 1, preload: '', srcs: [] as string[],
      play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(() => { a.src = ''; }),
      load: vi.fn(() => { if (a.src) { a.srcs.push(a.src); queueMicrotask(() => fire('loadedmetadata')); } }),
      addEventListener: (t: string, fn: () => void) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t)!.add(fn); },
      removeEventListener: (t: string, fn: () => void) => { ls.get(t)?.delete(fn); },
    };
    return a;
  }
  const yt = () => ({ load: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), setVolume: vi.fn(), position: () => 0, duration: () => 0, onEnded: vi.fn(), onError: vi.fn(), seekTo: vi.fn() }) as unknown as YouTubeDeck;
  const ID = `nas:${SHA_A}`;

  it('suona in streaming dal NAS, mai da YouTube, e lo dice', async () => {
    const a = fakeAudio(), y = yt();
    const d = new HybridDeck(new AudioDeck(a), { localUrl: async () => 'http://192.168.1.10:8788/api/tracks/x/stream?d=1&e=2&s=3', canStream: () => true, preferYouTube: () => true }, y);
    await d.load(ID);
    expect(a.srcs[0]).toMatch(/\/stream\?/);
    expect(y.load).not.toHaveBeenCalled();
    expect(d.source()).toBe('nas');
    expect(sourceText(d.source(), false)).toMatch(/NAS/);
    expect(d.videoIdForProjector()).toBe('');
  });
  it('salvato qui: suona dal file; NAS spento e nessuna copia: «offline», non «rotto»', async () => {
    const a = fakeAudio();
    const d = new HybridDeck(new AudioDeck(a), { localUrl: async () => 'blob:copia', canStream: () => false }, yt());
    await d.load(ID);
    expect(d.source()).toBe('file');
    const d2 = new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async () => undefined, canStream: () => true }, yt());
    await expect(d2.load(ID)).rejects.toMatchObject({ kind: 'offline' });
  });
});
