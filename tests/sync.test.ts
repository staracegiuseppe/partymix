import { apply, diff, type Op } from '../shared/merge';
import type { Changes, DeviceDoc, Entry, PlaylistDoc, PlaylistMeta, PlaylistSummary, ServerEvent } from '../shared/model';
import { MemoryKV } from '../src/library/kv';
import { PlaylistStore } from '../src/library/playlists';
import type { Track } from '../src/queue';
import { HttpSyncClient, isPrivateHost, normalizeUrl, SyncError, type DeviceInfo, type OpsResult, type SyncApi } from '../src/sync/client';
import { entryOf, SyncEngine, trackOf } from '../src/sync/engine';

let clock = 1_700_000_000_000;
const tr = (id: string, title = `Song ${id}`): Track => ({ videoId: id, title, status: 'ok' });
const A = tr('aaaaaaaaaaa', 'Song A'), B = tr('bbbbbbbbbbb', 'Song B'), C = tr('ccccccccccc', 'Song C'), D = tr('ddddddddddd', 'Song D'), E = tr('eeeeeeeeeee', 'Song E');
const titles = (p: { tracks: Track[] } | undefined) => p?.tracks.map((t) => t.title);

/** The NAS in memory, with the server's rules (versions, revisions, tombstones, sequence numbers, merge). */
class FakeNas implements SyncApi {
  docs = new Map<string, PlaylistDoc>();
  revs = new Map<string, PlaylistDoc[]>();
  seq = 0;
  down = false;
  calls: string[] = [];
  listeners = new Set<(ev: ServerEvent) => void>();
  keepRevs = 30;
  private guard(what: string) { this.calls.push(what); if (this.down) throw new SyncError(0, 'OFFLINE', 'NAS non raggiungibile'); }
  private view(d: PlaylistDoc) { const meta: PlaylistMeta = { name: d.name, sortOrder: d.sortOrder }; for (const k of ['description', 'color', 'cover', 'link', 'source'] as const) if (d[k]) meta[k] = d[k]; return { meta, entries: d.entries }; }
  private write(id: string, meta: PlaylistMeta, entries: Entry[], by: string, created?: number): PlaylistDoc {
    const old = this.docs.get(id);
    const doc: PlaylistDoc = { id, ...meta, version: (old?.version ?? 0) + 1, createdAt: created ?? old?.createdAt ?? clock, updatedAt: clock, updatedBy: by, updatedByName: by, entries: entries.map((e) => ({ ...e })) };
    this.docs.set(id, doc);
    (this as unknown as { seqs: Map<string, number> }).seqs ??= new Map();
    (this as unknown as { seqs: Map<string, number> }).seqs.set(id, ++this.seq);
    const r = this.revs.get(id) ?? [];
    r.push(structuredClone(doc));
    this.revs.set(id, r.slice(-this.keepRevs));
    for (const l of this.listeners) l({ seq: this.seq, kind: 'playlist', id });
    return structuredClone(doc);
  }
  private summary(d: PlaylistDoc): PlaylistSummary { const { entries, ...rest } = d; return { ...rest, count: entries.length }; }
  by = 'nas';
  async health() { this.guard('health'); return { app: 'partymix', version: 'test', setup: true }; }
  async setup(name: string, _p: string, dev: DeviceInfo) { this.guard('setup'); return { token: 't', device: { id: 'd1', name: dev.deviceName, kind: dev.deviceKind, perms: [], createdAt: 0, lastSeen: 0, current: true, revoked: false } as DeviceDoc, user: { name } }; }
  login = this.setup;
  async pair(_c: string, dev: DeviceInfo) { return this.setup('u', '', dev); }
  async logout() { this.guard('logout'); }
  async status() { this.guard('status'); return { seq: this.seq, tracks: 0, playlists: this.docs.size, device: { lastSyncSeq: 0 }, serverVersion: 'test', at: clock }; }
  async storage() { this.guard('storage'); return { musicBytes: 0, tracks: 0, freeBytes: 1, totalBytes: 2 }; }
  async changes(since: number, limit = 500): Promise<Changes> {
    this.guard(`changes:${since}`);
    const seqs = (this as unknown as { seqs?: Map<string, number> }).seqs ?? new Map<string, number>();
    const rows = [...this.docs.values()].map((d) => ({ d, s: seqs.get(d.id) ?? 0 })).filter((x) => x.s > since).sort((a, b) => a.s - b.s);
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    return { seq: more ? page[page.length - 1].s : this.seq, more, tracks: [], playlists: page.map((x) => this.summary(x.d)) };
  }
  async playlist(id: string) { this.guard(`get:${id}`); const d = this.docs.get(id); if (!d || d.deleted) throw new SyncError(404, 'NOT_FOUND', 'Playlist non trovata'); return structuredClone(d); }
  async createPlaylist(id: string, meta: PlaylistMeta, entries: Entry[]) { this.guard(`create:${id}`); if (this.docs.has(id)) throw new SyncError(409, 'EXISTS', 'esiste'); return this.write(id, meta, entries, this.by); }
  async ops(id: string, baseVersion: number, ops: Op[]): Promise<OpsResult> {
    this.guard(`ops:${id}@${baseVersion}`);
    const cur = this.docs.get(id);
    if (!cur) throw new SyncError(404, 'NOT_FOUND', 'Playlist non trovata');
    if (cur.deleted) throw new SyncError(409, 'DELETED', 'eliminata', structuredClone(cur));
    let theirs: Op[] = [];
    if (cur.version !== baseVersion) {
      const old = this.revs.get(id)?.find((r) => r.version === baseVersion);
      if (!old) throw new SyncError(409, 'TOO_OLD', 'troppo vecchia', structuredClone(cur));
      theirs = diff(this.view(old), this.view(cur));
    }
    const m = apply(this.view(cur), ops, theirs);
    return { playlist: this.write(id, m.meta, m.entries, this.by), merged: theirs.length > 0, conflicts: m.conflicts };
  }
  async putPlaylist(id: string, baseVersion: number, meta: PlaylistMeta, entries: Entry[]) {
    this.guard(`put:${id}`);
    const cur = this.docs.get(id);
    if (!cur) throw new SyncError(404, 'NOT_FOUND', 'Playlist non trovata');
    if (cur.version !== baseVersion) throw new SyncError(409, 'VERSION_CONFLICT', 'cambiata', structuredClone(cur));
    delete cur.deleted;
    return this.write(id, meta, entries, this.by);
  }
  async deletePlaylist(id: string, baseVersion?: number) {
    this.guard(`delete:${id}`);
    const cur = this.docs.get(id);
    if (!cur || cur.deleted) throw new SyncError(404, 'NOT_FOUND', 'Playlist non trovata');
    if (baseVersion != null && cur.version !== baseVersion) throw new SyncError(409, 'VERSION_CONFLICT', 'cambiata', structuredClone(cur));
    const doc = this.write(id, this.view(cur).meta, cur.entries, this.by);
    this.docs.get(id)!.deleted = true;
    void doc;
  }
  async devices() { this.guard('devices'); return []; }
  async renameDevice() { this.guard('rename'); return {} as DeviceDoc; }
  async revokeDevice() { this.guard('revoke'); return {} as DeviceDoc; }
  async pairCode() { this.guard('pairCode'); return { code: '123456', expiresAt: clock + 1 }; }
  // the files (phase 5) are not part of these tests: see uploader.test.ts
  async checkTracks(sha256: string[]) { return { missing: sha256, present: [] as string[] }; }
  async startUpload(): Promise<never> { throw new Error('non in questo test'); }
  async uploadChunk(): Promise<never> { throw new Error('non in questo test'); }
  async uploadCover(): Promise<never> { throw new Error('non in questo test'); }
  async track(): Promise<never> { throw new SyncError(404, 'NOT_FOUND', 'Brano non trovato'); }
  async library() { return { tracks: [] }; }
  events(on: (ev: ServerEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  /** Changes made straight on the NAS by "another device" that has no engine in the test. */
  direct(id: string, fn: (v: { meta: PlaylistMeta; entries: Entry[] }) => void, by = 'altro') { const cur = this.docs.get(id)!; const v = this.view(structuredClone(cur)); fn(v); const b = this.by; this.by = by; this.write(id, v.meta, v.entries, by); this.by = b; }
}

/** One device: its own playlists, its own memory of the NAS, its engine. */
function device(nas: FakeNas, name: string, opts: { events?: boolean } = {}) {
  const kv = new MemoryKV();
  let n = 0;
  const store = new PlaylistStore(kv, { now: () => ++clock, newId: () => `${name}-p${++n}`, saveDelayMs: 0 });
  // every call made by this device is signed with its name on the NAS; a device without events only learns when it asks
  const signed = new Proxy(nas as SyncApi, { get: (t, k) => {
    if (k === 'events' && opts.events === false) return () => () => {};
    const v = (t as unknown as Record<string, unknown>)[k as string];
    return typeof v === 'function' ? (...a: unknown[]) => { nas.by = name; return (v as (...x: unknown[]) => unknown).apply(nas, a); } : v;
  } });
  const engine = new SyncEngine(store, kv, signed, { now: () => clock, pushDelayMs: 0, pollMs: 0 });
  return { kv, store, engine, name };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('sync engine: playlist tra PC, NAS e telefono', () => {
  it('PC → NAS → telefono: una playlist creata sul PC compare sul telefono', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Palestra', { tracks: [A, B, C] });
    await tick(); await pc.engine.syncNow();
    await phone.engine.syncNow();
    expect(titles(phone.store.get(p.id))).toEqual(['Song A', 'Song B', 'Song C']);
    expect(phone.store.get(p.id)?.name).toBe('Palestra');
    expect(pc.engine.status().pending).toBe(0);
    expect(phone.engine.status().lastNews).toContain('Palestra');
  });

  it('telefono → NAS → PC: un brano aggiunto sul telefono arriva al PC, versione 2', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A, B, C] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    phone.store.addTracks(p.id, [D]);
    await phone.engine.syncNow();
    expect(nas.docs.get(p.id)!.version).toBe(2);
    expect(nas.docs.get(p.id)!.updatedBy).toBe('Telefono');
    await pc.engine.syncNow();
    expect(titles(pc.store.get(p.id))).toEqual(['Song A', 'Song B', 'Song C', 'Song D']);
    expect(pc.engine.status().lastNews).toContain('Telefono');
  });

  it('riordino sul telefono, rinomina sul PC: entrambe le modifiche restano', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A, B, C] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    phone.store.moveTrack(p.id, 2, 0);
    pc.store.rename(p.id, 'Festa');
    await phone.engine.syncNow(); await pc.engine.syncNow(); await phone.engine.syncNow();
    for (const d of [pc, phone]) {
      expect(d.store.get(p.id)?.name).toBe('Festa');
      expect(titles(d.store.get(p.id))).toEqual(['Song C', 'Song A', 'Song B']);
    }
    expect(pc.engine.status().conflicts).toEqual([]);
  });

  it('eventi dal NAS: il PC si aggiorna da solo quando il telefono cambia qualcosa', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await tick(); await pc.engine.syncNow(); await phone.engine.syncNow();
    phone.store.addTracks(p.id, [B]);
    await tick(); await phone.engine.syncNow();
    await tick(); await tick();
    expect(titles(pc.store.get(p.id))).toEqual(['Song A', 'Song B']);
  });
});

describe('sync engine: offline e riconnessione', () => {
  it('modifiche fatte senza NAS restano in attesa e partono quando torna', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono', { events: false });
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A, B, C] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    nas.down = true;
    phone.store.removeTrack(p.id, B.videoId);
    phone.store.addTracks(p.id, [D]);
    const made = phone.store.create('Nuova offline', { tracks: [E] });
    await phone.engine.syncNow();
    const s = phone.engine.status();
    expect(s.connected).toBe(false);
    expect(s.pending).toBe(2);
    expect(s.error).toContain('NAS non raggiungibile');
    // meanwhile the PC adds E to Party
    nas.down = false;
    pc.store.addTracks(p.id, [E]);
    await pc.engine.syncNow();
    nas.down = true;
    await phone.engine.syncNow();
    expect(titles(phone.store.get(p.id))).toEqual(['Song A', 'Song C', 'Song D']); // still its own offline view
    nas.down = false;
    await phone.engine.syncNow();
    expect(phone.engine.status().pending).toBe(0);
    expect(phone.engine.status().connected).toBe(true);
    expect(titles(phone.store.get(p.id))).toEqual(['Song A', 'Song C', 'Song D', 'Song E']); // B out, D in (where the phone put it), E from the PC
    await pc.engine.syncNow();
    expect(titles(pc.store.get(p.id))).toEqual(['Song A', 'Song C', 'Song D', 'Song E']);
    expect(pc.store.get(made.id)?.name).toBe('Nuova offline');
  });

  it('il computer senza rete non prova nemmeno', async () => {
    const nas = new FakeNas();
    const kv = new MemoryKV();
    const store = new PlaylistStore(kv, { saveDelayMs: 0 });
    const engine = new SyncEngine(store, kv, nas, { pollMs: 0, onLine: () => false });
    await engine.syncNow();
    expect(nas.calls).toEqual([]);
    expect(engine.status().error).toContain('senza rete');
  });

  it('la memoria del NAS sopravvive a un riavvio dell’app (stesso KV)', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC');
    await pc.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow();
    await pc.store.flush();
    pc.engine.stop();
    const store2 = new PlaylistStore(pc.kv, { saveDelayMs: 0 });
    await store2.load();
    const engine2 = new SyncEngine(store2, pc.kv, nas, { pollMs: 0 });
    await engine2.syncNow();
    expect(engine2.status().pending).toBe(0);
    expect(nas.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1);
    expect(store2.get(p.id)?.name).toBe('Party');
  });
});

describe('sync engine: conflitti', () => {
  it('stesso nome cambiato in due modi: conflitto da risolvere, nulla perso', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    pc.store.rename(p.id, 'Festa');
    phone.store.rename(p.id, 'Gym');
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    const c = phone.engine.status().conflicts;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'field', field: 'name', mine: 'Gym', theirs: 'Festa' });
    expect(phone.store.get(p.id)?.name).toBe('Festa'); // what the NAS has, until the user decides
    expect(phone.engine.status().pending).toBe(0);
    await phone.engine.resolve(c[0], 'mine');
    expect(phone.engine.status().conflicts).toEqual([]);
    expect(nas.docs.get(p.id)!.name).toBe('Gym');
    await pc.engine.syncNow();
    expect(pc.store.get(p.id)?.name).toBe('Gym');
  });

  it('«usa NAS» lascia le cose come sono', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    pc.store.rename(p.id, 'Festa');
    phone.store.rename(p.id, 'Gym');
    await pc.engine.syncNow(); await phone.engine.syncNow();
    await phone.engine.resolve(phone.engine.status().conflicts[0], 'theirs');
    expect(phone.store.get(p.id)?.name).toBe('Festa');
    expect(nas.docs.get(p.id)!.name).toBe('Festa');
  });

  it('eliminata sul PC, modificata sul telefono: il telefono chiede; «tienila» la riporta sul NAS', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono', { events: false });
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    pc.store.remove(p.id);
    await pc.engine.syncNow();
    expect(nas.docs.get(p.id)!.deleted).toBe(true);
    phone.store.addTracks(p.id, [B]);
    await phone.engine.syncNow();
    const c = phone.engine.status().conflicts;
    expect(c[0]).toMatchObject({ kind: 'deleted', playlistId: p.id });
    expect(phone.store.get(p.id)).toBeTruthy();
    await phone.engine.resolve(c[0], 'mine');
    expect(nas.docs.get(p.id)!.deleted).toBeUndefined();
    await pc.engine.syncNow();
    expect(titles(pc.store.get(p.id))).toEqual(['Song A', 'Song B']);
  });

  it('eliminata sul PC, intatta sul telefono: sparisce anche lì', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono');
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    pc.store.remove(p.id);
    await pc.engine.syncNow(); await phone.engine.syncNow();
    expect(phone.store.get(p.id)).toBeUndefined();
    expect(phone.engine.status().conflicts).toEqual([]);
    expect(phone.engine.status().lastNews).toContain('eliminata');
  });

  it('eliminata sul telefono ma cambiata sul PC nel frattempo: torna sul telefono', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono', { events: false });
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    pc.store.addTracks(p.id, [B]);
    await pc.engine.syncNow();
    phone.store.remove(p.id);
    await phone.engine.syncNow();
    expect(titles(phone.store.get(p.id))).toEqual(['Song A', 'Song B']);
    expect(nas.docs.get(p.id)!.deleted).toBeUndefined();
    expect(phone.engine.status().lastNews).toContain('tornata');
  });

  it('versione troppo vecchia sul NAS: la lista di questo dispositivo resta come copia', async () => {
    const nas = new FakeNas();
    nas.keepRevs = 2;
    const pc = device(nas, 'PC'), phone = device(nas, 'Telefono', { events: false });
    await pc.engine.start(); await phone.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    await pc.engine.syncNow(); await phone.engine.syncNow();
    for (const t of [B, C, D]) { pc.store.addTracks(p.id, [t]); await pc.engine.syncNow(); }
    phone.store.addTracks(p.id, [E]);
    await phone.engine.syncNow();
    expect(titles(phone.store.get(p.id))).toEqual(['Song A', 'Song B', 'Song C', 'Song D']);
    const copy = phone.store.list().find((x) => x.name.startsWith('Party (copia'));
    expect(titles(copy)).toEqual(['Song A', 'Song E']);
    await tick(); await phone.engine.syncNow(); // the copy is a new playlist: it goes up with the next push
    expect(nas.docs.has(copy!.id)).toBe(true);
  });

  it('modifiche fatte mentre la sincronizzazione era in corso non vanno perse', async () => {
    const nas = new FakeNas();
    const pc = device(nas, 'PC');
    await pc.engine.start();
    const p = pc.store.create('Party', { tracks: [A] });
    const orig = nas.createPlaylist.bind(nas);
    nas.createPlaylist = async (...a) => { const r = await orig(...a); pc.store.addTracks(p.id, [B]); return r; };
    await pc.engine.syncNow();
    expect(titles(pc.store.get(p.id))).toEqual(['Song A', 'Song B']);
    await pc.engine.syncNow();
    expect(nas.docs.get(p.id)!.entries.map((e) => e.title)).toEqual(['Song A', 'Song B']);
  });
});

describe('sync engine: righe e id', () => {
  it('brani YouTube, file locali e file del NAS vanno e tornano', () => {
    expect(entryOf(tr('dQw4w9WgXcQ'))).toMatchObject({ entryId: 'dQw4w9WgXcQ', youtubeId: 'dQw4w9WgXcQ' });
    expect(entryOf(tr('local:0123abcd'))).toMatchObject({ localId: 'local:0123abcd' });
    const sha = 'f'.repeat(64);
    expect(entryOf(tr(`nas:${sha}`))).toMatchObject({ trackId: sha });
    expect(trackOf({ entryId: 'x', trackId: sha })?.videoId).toBe(`nas:${sha}`);
    expect(trackOf({ entryId: 'x' })).toBeUndefined();
  });

  it('indirizzo del NAS: porta 8788 di default, solo reti private', () => {
    expect(normalizeUrl('192.168.1.10')).toBe('http://192.168.1.10:8788');
    expect(normalizeUrl('http://nas.local:9000/')).toBe('http://nas.local:9000');
    expect(normalizeUrl('https://nas.tail1234.ts.net')).toBe('https://nas.tail1234.ts.net');
    expect(normalizeUrl('')).toBeUndefined();
    expect(isPrivateHost('192.168.1.10')).toBe(true);
    expect(isPrivateHost('100.100.1.1')).toBe(true);
    expect(isPrivateHost('nas')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  it('HttpSyncClient: token, errori e offline', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/playlists/x/ops')) return new Response(JSON.stringify({ error: 'DELETED', message: 'eliminata', current: { id: 'x', version: 3 } }), { status: 409 });
      if (url.endsWith('/api/health')) return new Response('<html>', { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new HttpSyncClient('http://nas:8787/', 'tok', { fetch: fake });
    await c.status();
    expect(seen[0].url).toBe('http://nas:8787/api/sync/status');
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await expect(c.ops('x', 1, [])).rejects.toMatchObject({ status: 409, code: 'DELETED', current: { version: 3 } });
    await expect(c.health()).rejects.toMatchObject({ code: 'BAD_ANSWER' });
    const down = new HttpSyncClient('http://nas:8787', 'tok', { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch });
    await expect(down.status()).rejects.toMatchObject({ status: 0, code: 'OFFLINE' });
  });
});
