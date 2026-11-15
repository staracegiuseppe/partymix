import { describe, expect, it } from 'vitest';
import type { ChunkResult, TrackDoc, UploadStart, UploadStarted } from '../shared/model';
import { KvBlobStore } from '../src/library/blobStore';
import { MemoryKV } from '../src/library/kv';
import { MusicLibrary } from '../src/library/library';
import { Sha256, sha256Blob, sha256Bytes } from '../src/library/sha256';
import { SyncError, type SyncApi } from '../src/sync/client';
import { entryOf, trackOf } from '../src/sync/engine';
import { Uploader, uploadErrorText } from '../src/sync/uploader';

// --- a tiny but real MP3 (an ID3 tag and MPEG frames), big enough to need several pieces ---
const enc = (s: string) => new TextEncoder().encode(s);
function mp3(title: string, frames = 40, salt = 0): Uint8Array {
  const body = new Uint8Array([...enc('TIT2'), 0, 0, 0, title.length + 1, 0, 0, 3, ...enc(title)]);
  const tag = new Uint8Array(10 + body.length);
  tag.set(enc('ID3')); tag[3] = 3;
  tag.set([0, 0, (body.length >> 7) & 0x7f, body.length & 0x7f], 6);
  tag.set(body, 10);
  const f = new Uint8Array(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x64; f[4] = salt;
  const out = new Uint8Array(tag.length + f.length * frames);
  out.set(tag); for (let i = 0; i < frames; i++) { out.set(f, tag.length + i * f.length); out[tag.length + i * f.length + 5] = i & 255; }
  return out;
}
const file = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name, { type: 'audio/mpeg' });

/** The NAS's upload side in memory: dedup by hash, pieces in order, hash checked at the end, resume after a cut. */
class FakeNas implements Pick<SyncApi, 'checkTracks' | 'startUpload' | 'uploadChunk' | 'uploadCover' | 'track' | 'library'> {
  tracks = new Map<string, TrackDoc>();
  uploads = new Map<string, { sha: string; size: number; received: number; parts: Uint8Array[]; meta: UploadStart }>();
  covers = new Map<string, Blob>();
  calls: string[] = [];
  /** Drop the connection after this many pieces (then let everything through). */
  cutAfter = Infinity;
  /** Pretend the file arrived damaged. */
  corrupt = false;
  /** How many uploads are being written at the same moment (to check the queue of 2). */
  inFlight = 0;
  maxInFlight = 0;
  down = false;
  private guard(what: string) { this.calls.push(what); if (this.down) throw new SyncError(0, 'OFFLINE', 'NAS non raggiungibile'); }
  async checkTracks(sha256: string[]) { this.guard('check'); return { present: sha256.filter((s) => this.tracks.has(s)), missing: sha256.filter((s) => !this.tracks.has(s)) }; }
  async startUpload(req: UploadStart): Promise<UploadStarted> {
    this.guard('start');
    const have = this.tracks.get(req.sha256);
    if (have) return { track: have };
    for (const [id, u] of this.uploads) if (u.sha === req.sha256) return { uploadId: id, received: u.received };
    const id = `u${this.uploads.size + 1}`;
    this.uploads.set(id, { sha: req.sha256, size: req.size, received: 0, parts: [], meta: req });
    return { uploadId: id, received: 0 };
  }
  async uploadChunk(uploadId: string, from: number, to: number, total: number, bytes: Uint8Array): Promise<ChunkResult> {
    this.guard(`chunk:${from}-${to}`);
    const u = this.uploads.get(uploadId)!;
    if (total !== u.size || bytes.length !== to - from + 1) throw new SyncError(400, 'BAD_REQUEST', 'range');
    if (from !== u.received) { const e = new SyncError(409, 'OUT_OF_ORDER', 'fuori ordine'); e.received = u.received; throw e; }
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    this.inFlight--;
    u.parts.push(bytes); u.received = to + 1;
    if (this.calls.filter((c) => c.startsWith('chunk')).length === this.cutAfter) { this.cutAfter = Infinity; throw new SyncError(0, 'OFFLINE', 'connessione persa'); }
    if (u.received < u.size) return { received: u.received };
    const all = new Uint8Array(u.size); let o = 0; for (const p of u.parts) { all.set(p, o); o += p.length; }
    const got = this.corrupt ? 'x'.repeat(64) : await sha256Bytes(all);
    this.uploads.delete(uploadId);
    if (got !== u.sha) throw new SyncError(422, 'CORRUPT_FILE', 'Il file è arrivato danneggiato');
    const t: TrackDoc = { id: u.sha, title: u.meta.meta.title, artist: u.meta.meta.artist, size: u.size, mime: u.meta.mime, hasCover: false, addedAt: 1, metaVersion: 1, youtubeId: u.meta.youtubeId };
    this.tracks.set(u.sha, t);
    return { track: t };
  }
  async uploadCover(id: string, data: Blob) { this.guard('cover'); this.covers.set(id, data); const t = this.tracks.get(id)!; t.hasCover = true; return t; }
  async track(id: string) { const t = this.tracks.get(id); if (!t) throw new SyncError(404, 'NOT_FOUND', 'no'); return t; }
  async library() { return { tracks: [...this.tracks.values()] }; }
}

const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };

async function setup(opts: { auto?: boolean; chunk?: number; concurrency?: number } = {}) {
  const kv = new MemoryKV();
  const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv), probe: async () => 120 });
  const nas = new FakeNas();
  const done: string[] = [];
  const auto = { on: opts.auto ?? true };
  const up = new Uploader({ api: nas as unknown as SyncApi, library: lib, auto: () => auto.on, onDone: (id, sha) => done.push(`${id}=${sha}`), chunkSize: opts.chunk ?? 4096, concurrency: opts.concurrency });
  return { kv, lib, nas, up, done, auto };
}

describe('SHA-256', () => {
  it('the streaming hash matches WebCrypto, whatever the piece size', async () => {
    const data = mp3('Hash me', 70);
    const want = await sha256Bytes(data);
    for (const piece of [1, 7, 63, 64, 65, 1000, data.length]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += piece) h.update(data.subarray(i, Math.min(data.length, i + piece)));
      expect(h.hex()).toBe(want);
    }
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(enc('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Blob(new Blob([data as BlobPart]))).toBe(want);
  });
});

describe('Uploader', () => {
  it('an imported file goes up in pieces, with resume after the connection drops, and gets its nasId', async () => {
    const { lib, nas, up, done } = await setup({ chunk: 4096 });
    up.start();
    nas.cutAfter = 2; // the NAS dies after the second piece
    const data = mp3('Physical', 40);
    const r = await lib.importFiles([file(data, 'Dua Lipa - Physical.mp3')]);
    const id = r.added[0].id;
    await settle();
    expect(up.stateOf(id)).toBe('error');
    expect(up.errorOf(id)).toMatch(/NAS non raggiungibile/);
    expect(up.summary()).toEqual({ total: 1, onNas: 0, uploading: 0, failed: 1 });
    // the NAS is back: resumed from the third piece, not from zero
    const before = nas.calls.length;
    up.resume();
    await settle();
    const later = nas.calls.slice(before);
    expect(later.filter((c) => c.startsWith('chunk'))[0]).toBe('chunk:8192-12287');
    expect(up.stateOf(id)).toBe('nas');
    const sha = await sha256Bytes(data);
    expect(lib.get(id)?.nasId).toBe(sha);
    expect(lib.idForNas(sha)).toBe(id);
    expect(nas.tracks.get(sha)?.title).toBe('Physical');
    expect(nas.tracks.get(sha)?.artist).toBe('Dua Lipa');
    expect(done).toEqual([`${id}=${sha}`]);
    expect(up.summary()).toEqual({ total: 1, onNas: 1, uploading: 0, failed: 0 });
    // the nasId survives a reload of the library
    const lib2 = new MusicLibrary({ kv: (lib as unknown as { d: { kv: MemoryKV } }).d.kv, blobs: new KvBlobStore(new MemoryKV()) });
    await lib2.load();
    expect(lib2.nasIdOf(id)).toBe(sha);
  });

  it('dedup: a file the NAS has already is only linked, nothing is sent', async () => {
    const { lib, nas, up } = await setup();
    const data = mp3('Levitating', 20, 1);
    const sha = await sha256Bytes(data);
    nas.tracks.set(sha, { id: sha, title: 'Levitating', size: data.length, mime: 'audio/mpeg', hasCover: false, addedAt: 1, metaVersion: 1 });
    up.start();
    const r = await lib.importFiles([file(data, 'Levitating.mp3')]);
    await settle();
    expect(lib.get(r.added[0].id)?.nasId).toBe(sha);
    expect(nas.calls).toEqual(['check']);
  });

  it('a file that arrives corrupt is shown as an error, not retried by itself', async () => {
    const { lib, nas, up } = await setup();
    nas.corrupt = true;
    up.start();
    const r = await lib.importFiles([file(mp3('Rotto', 10, 2), 'Rotto.mp3')]);
    await settle();
    const id = r.added[0].id;
    expect(up.stateOf(id)).toBe('error');
    expect(up.errorOf(id)).toMatch(/danneggiato/);
    expect(lib.get(id)?.nasId).toBeUndefined();
    nas.corrupt = false;
    up.resume(); // only "the NAS was away" errors are retried on their own
    await settle();
    expect(up.stateOf(id)).toBe('error');
    up.uploadNow(); // «Carica ora» retries everything
    await settle();
    expect(up.stateOf(id)).toBe('nas');
  });

  it('two at a time, the rest wait their turn', async () => {
    const { lib, nas, up } = await setup({ chunk: 2000 });
    up.start();
    await lib.importFiles([1, 2, 3, 4, 5].map((i) => file(mp3(`Song ${i}`, 20, 10 + i), `Song ${i}.mp3`)));
    await settle(60);
    expect(nas.maxInFlight).toBeLessThanOrEqual(2);
    expect(nas.maxInFlight).toBeGreaterThanOrEqual(1);
    expect(nas.tracks.size).toBe(5);
    expect(up.summary()).toEqual({ total: 5, onNas: 5, uploading: 0, failed: 0 });
  });

  it('with the automatic upload off, new songs wait for «Carica ora»', async () => {
    const { lib, nas, up, auto } = await setup({ auto: false });
    up.start();
    const r = await lib.importFiles([file(mp3('Later', 10, 3), 'Later.mp3')]);
    await settle();
    expect(nas.calls).toEqual([]);
    expect(up.stateOf(r.added[0].id)).toBe('missing');
    expect(up.summary()).toEqual({ total: 1, onNas: 0, uploading: 0, failed: 0 });
    auto.on = true;
    up.uploadNow();
    await settle();
    expect(up.stateOf(r.added[0].id)).toBe('nas');
  });

  it('the cover goes along; a song without a file has no NAS state', async () => {
    const { lib, nas, up } = await setup();
    up.start();
    const r = await lib.importFiles([file(mp3('Art', 10, 4), 'Art.mp3')]);
    const e = r.added[0];
    e.cover = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    up.uploadNow();
    await settle();
    expect(nas.covers.get(e.nasId!)?.type).toBe('image/png');
    lib.addOnline({ videoId: 'yyyyyyyyyyy', title: 'Only online', status: 'ok' });
    expect(up.stateOf('yyyyyyyyyyy')).toBeUndefined();
  });

  it('error words for the user', () => {
    expect(uploadErrorText(new SyncError(0, 'OFFLINE', 'x'))).toEqual({ text: 'NAS non raggiungibile: riprovo quando torna.', retry: true });
    expect(uploadErrorText(new SyncError(422, 'CORRUPT_FILE', 'x')).retry).toBe(false);
    expect(uploadErrorText(new SyncError(403, 'FORBIDDEN', 'x')).text).toMatch(/permesso/);
    expect(uploadErrorText(new SyncError(507, 'NO_SPACE', 'x')).text).toMatch(/Spazio/);
    expect(uploadErrorText(new TypeError('boom')).text).toBe('boom');
    expect(uploadErrorText(new TypeError('NetworkError when attempting')).text).toBe('Errore imprevisto: riprova.');
  });
});

describe('entryOf / trackOf with a file on the NAS', () => {
  const sha = 'a'.repeat(64);
  const nasIdOf = (id: string) => (id === 'local:0123456789ab' ? sha : undefined);
  const localIdOf = (s: string) => (s === sha ? 'local:0123456789ab' : undefined);

  it('a local song on the NAS becomes a trackId line with the NAS id as line id', () => {
    const e = entryOf({ videoId: 'local:0123456789ab', title: 'Physical', artist: 'Dua Lipa', status: 'ok' }, nasIdOf);
    expect(e).toEqual({ entryId: sha, trackId: sha, title: 'Physical', artist: 'Dua Lipa' });
    expect(entryOf({ videoId: 'local:ffffffffffff', title: 'Not yet', status: 'ok' }, nasIdOf)).toEqual({ entryId: 'local:ffffffffffff', localId: 'local:ffffffffffff', title: 'Not yet' });
    expect(entryOf({ videoId: 'local:0123456789ab', status: 'ok' })).toEqual({ entryId: 'local:0123456789ab', localId: 'local:0123456789ab' });
  });

  it('a NAS line whose file is here keeps the local id; elsewhere it plays from the NAS', () => {
    expect(trackOf({ entryId: sha, trackId: sha, title: 'Physical' }, localIdOf)?.videoId).toBe('local:0123456789ab');
    expect(trackOf({ entryId: sha, trackId: sha, title: 'Physical' })?.videoId).toBe(`nas:${sha}`);
    expect(trackOf({ entryId: 'x', trackId: 'b'.repeat(64) }, localIdOf)?.videoId).toBe(`nas:${'b'.repeat(64)}`);
    expect(trackOf({ entryId: 'local:0123456789ab', localId: 'local:0123456789ab' }, localIdOf)?.videoId).toBe('local:0123456789ab');
  });
});
