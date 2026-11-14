import { MemoryKV } from '../src/library/kv';
import { KvBlobStore } from '../src/library/blobStore';
import { MusicLibrary } from '../src/library/library';
import { metaFromName, readId3, sniffAudio } from '../src/library/id3';
import { PlaylistStore } from '../src/library/playlists';

// --- a tiny but real MP3: an ID3v2.3 tag followed by MPEG-1 Layer III frames ---
const enc = (s: string) => new TextEncoder().encode(s);
function frame(id: string, body: Uint8Array) {
  const h = new Uint8Array(10 + body.length);
  h.set(enc(id));
  const n = body.length;
  h.set([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], 4);
  h.set(body, 10);
  return h;
}
const textFrame = (id: string, s: string) => frame(id, new Uint8Array([3, ...enc(s)]));
function mp3(tags: { title?: string; artist?: string; album?: string; cover?: boolean } = {}, frames = 40, salt = 0): Uint8Array {
  const parts: Uint8Array[] = [];
  if (tags.title) parts.push(textFrame('TIT2', tags.title));
  if (tags.artist) parts.push(textFrame('TPE1', tags.artist));
  if (tags.album) parts.push(textFrame('TALB', tags.album));
  if (tags.cover) parts.push(frame('APIC', new Uint8Array([0, ...enc('image/png'), 0, 3, 0, 0x89, 0x50, 0x4e, 0x47, 1, 2, 3])));
  const body = parts.reduce((n, p) => n + p.length, 0);
  const tag = new Uint8Array(10 + body);
  tag.set(enc('ID3')); tag[3] = 3; tag[4] = 0; tag[5] = 0;
  tag.set([(body >> 21) & 0x7f, (body >> 14) & 0x7f, (body >> 7) & 0x7f, body & 0x7f], 6);
  let o = 10; for (const p of parts) { tag.set(p, o); o += p.length; }
  const f = new Uint8Array(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x64; f[4] = salt;
  const out = new Uint8Array(tag.length + f.length * frames);
  out.set(tag); for (let i = 0; i < frames; i++) out.set(f, tag.length + i * f.length);
  return out;
}
const file = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name, { type: 'audio/mpeg' });

function setup(probe?: (b: Blob) => Promise<number | undefined>) {
  const kv = new MemoryKV();
  const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), probe: probe ?? (async () => 201) });
  return { kv, lib };
}
beforeAll(() => {
  // jsdom has no blob: links
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL ??= () => `blob:test/${Math.random()}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL ??= () => {};
});

describe('MP3 checks and tags', () => {
  it('recognises real audio and refuses a renamed file', () => {
    expect(sniffAudio(mp3())).toBe('mp3');
    expect(sniffAudio(enc('<html><body>not found</body></html>'))).toBeUndefined();
    expect(sniffAudio(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });
  it('an MP3 with a tag but no sound after it is broken', () => {
    const t = mp3({ title: 'x' }, 0);
    const padded = new Uint8Array(t.length + 2000); padded.set(t);
    expect(sniffAudio(padded)).toBeUndefined();
  });
  it('reads title, artist, album and cover', () => {
    const m = readId3(mp3({ title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', cover: true }));
    expect(m).toMatchObject({ title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' });
    expect(m.cover?.mime).toBe('image/png');
    expect([...m.cover!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it('falls back on the file name', () => {
    expect(metaFromName('03 - Daft Punk - One More Time.mp3')).toEqual({ artist: 'Daft Punk', title: 'One More Time' });
    expect(metaFromName('Song_1.mp3', 'Artist A')).toEqual({ title: 'Song 1', artist: 'Artist A' });
  });
});

describe('importing local music', () => {
  it('imports a single MP3 with its tags, size and length, available offline', async () => {
    const { lib } = setup();
    const r = await lib.importFiles([file(mp3({ title: 'Uno', artist: 'Artista A', album: 'Disco' }), 'uno.mp3')]);
    expect(r.added).toHaveLength(1);
    const e = r.added[0];
    expect(e).toMatchObject({ title: 'Uno', artist: 'Artista A', album: 'Disco', durationSec: 201, source: 'file' });
    expect(e.id).toMatch(/^local:[0-9a-f]+$/);
    expect(e.size).toBeGreaterThan(1000);
    expect(lib.isOffline(e.id)).toBe(true);
    expect(lib.stateOf(e.id)).toBe('offline');
  });
  it('imports many files at once (a folder of 300), with progress, no limit', async () => {
    const { lib } = setup();
    const files = Array.from({ length: 300 }, (_, i) => file(mp3({ title: `Brano ${i}`, artist: `Artista ${i % 7}` }, 3, i % 256), `b${i}.mp3`));
    const progress = vi.fn();
    const r = await lib.importFiles(files, progress);
    expect(r.added).toHaveLength(300);
    expect(lib.size()).toBe(300);
    expect(progress).toHaveBeenCalledWith(299, 300, 'b299.mp3');
    expect(lib.artists()).toHaveLength(7);
  });
  it('the same song twice is not duplicated (same bytes, other name)', async () => {
    const { lib } = setup();
    const bytes = mp3({ title: 'Uno' });
    const r = await lib.importFiles([file(bytes, 'uno.mp3'), file(bytes, 'uno (copia).mp3')]);
    expect(r.added).toHaveLength(1);
    expect(r.duplicates).toEqual(['uno (copia).mp3']);
    const again = await lib.importFiles([file(bytes, 'ancora.mp3')]);
    expect(again.duplicates).toEqual(['ancora.mp3']);
  });
  it('refuses invalid, empty, corrupt and non-audio files with readable reasons', async () => {
    const { lib } = setup(async (b) => { if (b.size < 2000) throw new Error('decode'); return 100; });
    const r = await lib.importFiles([
      new File([enc('ciao')], 'nota.txt'),
      new File([], 'vuoto.mp3'),
      new File([enc('<html>error 404</html>, not an mp3 at all.....')], 'finto.mp3'),
      file(mp3({ title: 'corto' }, 2), 'rotto.mp3'), // passes the header check, but the player cannot decode it
      file(mp3({ title: 'buono' }), 'buono.mp3'),
    ]);
    expect(r.added.map((e) => e.title)).toEqual(['buono']);
    const why = Object.fromEntries(r.invalid.map((x) => [x.name, x.reason]));
    expect(why['nota.txt']).toMatch(/non è un file audio/);
    expect(why['vuoto.mp3']).toMatch(/vuoto/);
    expect(why['finto.mp3']).toMatch(/non è valido/);
    expect(why['rotto.mp3']).toMatch(/danneggiato/);
    for (const x of r.invalid) expect(x.reason).not.toMatch(/Error|undefined|\[object/);
  });
  it('stops on a full disk and says so in plain words', async () => {
    const { lib, kv } = setup();
    kv.failNextPut = Object.assign(new Error('x'), { name: 'QuotaExceededError' });
    const r = await lib.importFiles([file(mp3({ title: 'a' }), 'a.mp3'), file(mp3({ title: 'b' }, 40, 9), 'b.mp3')]);
    expect(r.stopped).toMatch(/Spazio insufficiente/);
    expect(r.added).toHaveLength(0);
  });
});

describe('offline library: persistence, download, delete', () => {
  it('survives a restart (new library object over the same storage)', async () => {
    const { kv, lib } = setup();
    const r = await lib.importFiles([file(mp3({ title: 'Resto' }), 'r.mp3')]);
    lib.toggleFavorite(r.added[0].id);
    const again = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    await again.load();
    expect(again.get(r.added[0].id)).toMatchObject({ title: 'Resto', favorite: true });
    expect(again.isOffline(r.added[0].id)).toBe(true);
    expect(await again.urlFor(r.added[0].id)).toMatch(/^blob:/);
  });
  it('downloads a song from a link with progress: online → downloading → offline', async () => {
    const { lib } = setup();
    const bytes = mp3({ title: 'Dal NAS', artist: 'Io' });
    const states: string[] = [];
    let id = '';
    lib.onChange(() => { if (id) states.push(lib.stateOf(id)); });
    const half = bytes.length >> 1;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, half)); c.enqueue(bytes.subarray(half)); c.close(); } }), { headers: { 'content-length': String(bytes.length) } }));
    const lib2 = new MusicLibrary({ kv: new MemoryKV(), blobs: new KvBlobStore(new MemoryKV()), fetch: fetchMock as unknown as typeof fetch });
    const p = lib2.downloadUrl('http://192.168.1.10/musica/Io%20-%20Dal%20NAS.mp3');
    lib2.onChange(() => { const e = lib2.all()[0]; if (e) { id = e.id; states.push(lib2.stateOf(e.id)); } });
    const e = await p;
    expect(e.title).toBe('Dal NAS');
    expect(lib2.stateOf(e.id)).toBe('offline');
    expect(states).toContain('downloading');
    expect(lib.size()).toBe(0);
  });
  it('an interrupted download is an error the user understands, and can be tried again', async () => {
    const bytes = mp3();
    const kv = new MemoryKV();
    const cut = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 100)); c.close(); } }), { headers: { 'content-length': String(bytes.length) } }));
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), fetch: cut as unknown as typeof fetch });
    await expect(lib.downloadUrl('https://example.org/a.mp3')).rejects.toThrow(/interrotto/);
    const e = lib.all()[0];
    expect(lib.stateOf(e.id)).toBe('error');
    const ok = vi.fn(async () => new Response(bytes as BlobPart));
    const lib2 = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), fetch: ok as unknown as typeof fetch });
    await lib2.load();
    expect((await lib2.downloadUrl('https://example.org/a.mp3')).id).toBe(e.id);
    expect(lib2.stateOf(e.id)).toBe('offline');
  });
  it('the user can cancel a download; no network gives a readable message', async () => {
    const kv = new MemoryKV();
    const hang = vi.fn((_u: string, o: { signal: AbortSignal }) => new Promise<Response>((_, ko) => o.signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), fetch: hang as unknown as typeof fetch });
    const p = lib.downloadUrl('https://example.org/lungo.mp3');
    await new Promise((r) => setTimeout(r, 0));
    lib.cancel(lib.all()[0].id);
    await expect(p).rejects.toThrow('Download interrotto.');
    const off = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch });
    await expect(off.downloadUrl('https://example.org/x.mp3')).rejects.toThrow(/Rete assente/);
  });
  it('a download left half-way when the app closed is shown as interrupted after the restart', async () => {
    const kv = new MemoryKV();
    await kv.put('library', 'local:abcdef0123', { id: 'local:abcdef0123', title: 'x', artist: '', album: '', source: 'url', url: 'https://e.org/x.mp3', addedAt: 1, state: 'downloading', progress: 0.4 });
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    await lib.load();
    expect(lib.stateOf('local:abcdef0123')).toBe('error');
    expect(lib.errorOf('local:abcdef0123')).toMatch(/interrotto/);
  });
  it('«Elimina download» keeps the song in its playlists (YouTube song: online again)', async () => {
    const { lib, kv } = setup();
    const t = { videoId: 'dQw4w9WgXcQ', title: 'Never', status: 'ok' as const };
    await lib.linkFile(t.videoId, file(mp3({ title: 'mio file' }), 'mio.mp3'), t);
    expect(lib.stateOf(t.videoId)).toBe('offline');
    const pls = new PlaylistStore(kv);
    const p = pls.create('Festa', { tracks: [t] });
    await lib.deleteDownload(t.videoId);
    expect(lib.stateOf(t.videoId)).toBe('online');
    expect(pls.get(p.id)!.tracks.map((x) => x.videoId)).toEqual(['dQw4w9WgXcQ']);
    expect(await lib.urlFor(t.videoId)).toBeUndefined();
  });
  it('an imported file whose download is deleted is marked, not silently broken', async () => {
    const { lib } = setup();
    const e = (await lib.importFiles([file(mp3({ title: 'via' }), 'via.mp3')])).added[0];
    await lib.deleteDownload(e.id);
    expect(lib.stateOf(e.id)).toBe('error');
    expect(lib.errorOf(e.id)).toMatch(/importalo di nuovo/);
  });
});
