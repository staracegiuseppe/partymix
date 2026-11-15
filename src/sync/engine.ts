import { apply, diff, type Conflict, type Op } from '../../shared/merge';
import type { Entry, PlaylistDoc, PlaylistMeta, PlaylistSummary, ServerEvent } from '../../shared/model';
import type { KV } from '../library/kv';
import type { Playlist, PlaylistStore } from '../library/playlists';
import type { Track } from '../queue';
import { SyncError, type SyncApi } from './client';

/**
 * Keeps the playlists on this device and on the NAS the same.
 *
 * For every playlist the device remembers the last version it agreed on with the NAS (the "base"). What the user changed
 * since then is sent as operations and merged on the NAS with what other devices did; what other devices changed comes
 * back as a list of playlists changed after the last sequence number seen. Offline, changes wait; they go when the NAS
 * is back. Nothing is ever thrown away without asking: see `conflicts`.
 */

type Base = { version: number; meta: PlaylistMeta; entries: Entry[] };

export type SyncConflict =
  /** The same field changed in two ways: the NAS kept `theirs`, this device wanted `mine`. */
  | { kind: 'field'; playlistId: string; name: string; field: Conflict['field']; mine: Conflict['mine']; theirs: Conflict['theirs']; version: number }
  /** Deleted on another device, changed here: keep it (put it back on the NAS) or delete it here too. */
  | { kind: 'deleted'; playlistId: string; name: string; version: number };

export type SyncStatus = {
  configured: boolean;
  /** The NAS answered the last call. */
  connected: boolean;
  live: boolean;
  syncing: boolean;
  lastSync?: number;
  /** Playlists with changes not yet on the NAS (also the ones deleted here). */
  pending: number;
  conflicts: SyncConflict[];
  error?: string;
  /** Last pull: what came in, for the status line («Playlist aggiornata: Party, +3 brani»). */
  lastNews?: string;
};

export type EngineDeps = {
  now?: () => number;
  /** Milliseconds between a change and its push (several quick changes go together). */
  pushDelayMs?: number;
  /** Fallback when events do not arrive: how often to ask (0 = never). */
  pollMs?: number;
  /** Online/offline of the computer, to retry at once when the network is back. */
  onLine?: () => boolean;
  log?: (msg: string) => void;
  /** The NAS id (SHA-256) of a local song, once its file is on the NAS: its playlist lines become NAS lines. */
  nasIdOf?: (videoId: string) => string | undefined;
  /** The local song that is on the NAS with that id: its lines keep playing from the local file. */
  localIdOf?: (sha256: string) => string | undefined;
};

const YT_ID = /^[\w-]{6,20}$/;

/**
 * A line on the NAS from a song of the queue. A local file that is on the NAS already becomes a NAS line (its id
 * there is the line's id too, so every device sees the same line); one not sent yet stays a `local:` line.
 */
export function entryOf(t: Track, nasIdOf?: (videoId: string) => string | undefined): Entry {
  const nas = t.videoId.startsWith('local:') ? nasIdOf?.(t.videoId) : undefined;
  const e: Entry = { entryId: nas ?? t.videoId };
  if (nas) e.trackId = nas;
  else if (t.videoId.startsWith('local:')) e.localId = t.videoId;
  else if (t.videoId.startsWith('nas:')) e.trackId = t.videoId.slice(4);
  else if (YT_ID.test(t.videoId)) e.youtubeId = t.videoId;
  if (t.title) e.title = t.title;
  if (t.artist) e.artist = t.artist;
  if (t.album) e.album = t.album;
  if (t.thumb) e.thumb = t.thumb;
  if (t.durationSec != null) e.durationSec = t.durationSec;
  return e;
}

/**
 * A song of the queue from a line on the NAS (`nas:<sha256>` plays from the NAS, see audioDeck). A NAS line whose
 * file is in this computer's library keeps its `local:` id: nothing changes for the player here.
 */
export function trackOf(e: Entry, localIdOf?: (sha256: string) => string | undefined): Track | undefined {
  const videoId = e.youtubeId ?? e.localId ?? (e.trackId ? localIdOf?.(e.trackId) ?? `nas:${e.trackId}` : undefined);
  if (!videoId) return undefined;
  const t: Track = { videoId, status: 'ok' };
  if (e.title) t.title = e.title;
  if (e.artist) t.artist = e.artist;
  if (e.album) t.album = e.album;
  if (e.thumb) t.thumb = e.thumb;
  if (e.durationSec != null) t.durationSec = e.durationSec;
  return t;
}

export function metaOf(p: Playlist | PlaylistDoc): PlaylistMeta {
  const m: PlaylistMeta = { name: p.name, sortOrder: p.sortOrder };
  for (const k of ['description', 'color', 'cover', 'link', 'source'] as const) if (p[k]) m[k] = p[k];
  return m;
}
const viewOfDoc = (d: PlaylistDoc) => ({ meta: metaOf(d), entries: d.entries });
const baseOf = (d: PlaylistDoc): Base => ({ version: d.version, ...viewOfDoc(d) });

export class SyncEngine {
  private store: PlaylistStore;
  private kv: KV;
  private api: SyncApi;
  private now: () => number;
  private pushDelay: number;
  private pollMs: number;
  private onLine: () => boolean;
  private log: (m: string) => void;
  private bases = new Map<string, Base>();
  private lastSeq = 0;
  private conflicts: SyncConflict[] = [];
  private listeners = new Set<() => void>();
  private st: SyncStatus = { configured: true, connected: false, live: false, syncing: false, pending: 0, conflicts: [] };
  private applying = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private again = false;
  private stopFns: (() => void)[] = [];
  private loaded = false;
  private nasIdOf: (videoId: string) => string | undefined;
  private localIdOf: (sha256: string) => string | undefined;
  private viewOfLocal = (p: Playlist) => ({ meta: metaOf(p), entries: p.tracks.map((t) => entryOf(t, this.nasIdOf)) });

  constructor(store: PlaylistStore, kv: KV, api: SyncApi, deps: EngineDeps = {}) {
    this.store = store;
    this.kv = kv;
    this.api = api;
    this.now = deps.now ?? Date.now;
    this.pushDelay = deps.pushDelayMs ?? 1500;
    this.pollMs = deps.pollMs ?? 60_000;
    this.onLine = deps.onLine ?? (() => true);
    this.log = deps.log ?? (() => {});
    this.nasIdOf = deps.nasIdOf ?? (() => undefined);
    this.localIdOf = deps.localIdOf ?? (() => undefined);
  }

  status(): SyncStatus { return { ...this.st, conflicts: [...this.conflicts], pending: this.pendingCount() }; }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { for (const fn of this.listeners) fn(); }

  /** Reads what was agreed with the NAS so far, then listens: local changes, NAS events, the clock. */
  async start(): Promise<void> {
    await this.load();
    this.stopFns.push(this.store.onChange(() => { if (!this.applying) this.schedulePush(); }));
    this.stopFns.push(this.api.events((ev) => this.onEvent(ev), (open) => { if (this.st.live !== open) { this.st.live = open; this.changed(); } }));
    if (this.pollMs > 0) { this.poll = setInterval(() => void this.syncNow(), this.pollMs); this.stopFns.push(() => clearInterval(this.poll)); }
    void this.syncNow();
  }

  stop(): void {
    for (const f of this.stopFns) f();
    this.stopFns = [];
    if (this.timer) clearTimeout(this.timer);
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const all = await this.kv.getAll<{ key: string; value: unknown }>('sync');
    for (const row of all) {
      if (row?.key === 'seq') this.lastSeq = Number(row.value) || 0;
      else if (row?.key === 'conflicts') this.conflicts = Array.isArray(row.value) ? (row.value as SyncConflict[]) : [];
      else if (row?.key?.startsWith('base:')) this.bases.set(row.key.slice(5), row.value as Base);
    }
  }
  private saveBase(id: string, b: Base | undefined) {
    if (b) { this.bases.set(id, b); return this.kv.put('sync', `base:${id}`, { key: `base:${id}`, value: b }); }
    this.bases.delete(id);
    return this.kv.delete('sync', `base:${id}`);
  }
  private saveSeq(seq: number) { this.lastSeq = seq; return this.kv.put('sync', 'seq', { key: 'seq', value: seq }); }
  private saveConflicts() { return this.kv.put('sync', 'conflicts', { key: 'conflicts', value: this.conflicts }); }

  private pendingCount(): number {
    let n = 0;
    for (const p of this.store.list()) {
      const b = this.bases.get(p.id);
      if (!b || diff(b, this.viewOfLocal(p)).length) n++;
    }
    for (const id of this.bases.keys()) if (!this.store.get(id)) n++;
    return n;
  }

  private schedulePush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.syncNow(); }, this.pushDelay);
    this.changed();
  }

  private onEvent(ev: ServerEvent) {
    if (ev.seq > this.lastSeq) void this.syncNow();
  }

  /** Push what changed here, then pull what changed elsewhere. One run at a time; a request during a run starts another after it. */
  syncNow(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run();
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    await this.load();
    if (!this.onLine()) { this.st.connected = false; this.st.error = 'Il computer è senza rete: le modifiche aspettano.'; this.changed(); return; }
    this.st.syncing = true;
    this.st.error = undefined;
    this.changed();
    try {
      await this.push();
      await this.pull();
      this.st.connected = true;
      this.st.lastSync = this.now();
    } catch (e) {
      const err = e as SyncError;
      this.st.connected = !(err instanceof SyncError && err.offline);
      this.st.error = err instanceof SyncError && err.unauthorized ? 'Questo dispositivo non è più autorizzato sul NAS: collegalo di nuovo.' : err.message;
      this.log(`sync: ${err.message}`);
    } finally {
      this.st.syncing = false;
      this.changed();
    }
  }

  // ---- this device → NAS ----
  private async push() {
    for (const p of this.store.list()) {
      const base = this.bases.get(p.id);
      if (!base) await this.create(p);
      else await this.pushOps(p, base);
    }
    for (const id of [...this.bases.keys()]) if (!this.store.get(id)) await this.pushDelete(id);
  }

  private async create(p: Playlist) {
    const v = this.viewOfLocal(p);
    try {
      const doc = await this.api.createPlaylist(p.id, v.meta, v.entries);
      await this.saveBase(p.id, baseOf(doc));
      await this.applyDoc(doc, v);
    } catch (e) {
      if (!(e instanceof SyncError && e.code === 'EXISTS')) throw e;
      // created on the NAS with this id already (an earlier push that did not answer): merge on top of it
      const doc = await this.api.playlist(p.id);
      const base = baseOf({ ...doc, entries: [] });
      base.meta = { name: doc.name, sortOrder: doc.sortOrder };
      await this.saveBase(p.id, base);
      await this.pushOps(p, base);
    }
  }

  private async pushOps(p: Playlist, base: Base) {
    const sent = this.viewOfLocal(p);
    const ops = diff(base, sent);
    if (!ops.length) return;
    try {
      const r = await this.api.ops(p.id, base.version, ops);
      await this.saveBase(p.id, baseOf(r.playlist));
      await this.applyDoc(r.playlist, sent);
      if (r.conflicts.length) {
        this.conflicts = this.conflicts.filter((c) => c.playlistId !== p.id || c.kind !== 'field');
        for (const c of r.conflicts) this.conflicts.push({ kind: 'field', playlistId: p.id, name: r.playlist.name, field: c.field, mine: c.mine, theirs: c.theirs, version: r.playlist.version });
        await this.saveConflicts();
      }
    } catch (e) {
      if (!(e instanceof SyncError) || !e.current) throw e;
      if (e.code === 'DELETED') {
        if (!this.conflicts.some((c) => c.kind === 'deleted' && c.playlistId === p.id)) {
          this.conflicts.push({ kind: 'deleted', playlistId: p.id, name: p.name, version: e.current.version });
          await this.saveConflicts();
        }
        return;
      }
      if (e.code === 'TOO_OLD') {
        // the NAS no longer has the version this device started from: keep this device's list as a copy, take the NAS's
        const copy = this.store.create(`${p.name} (copia da ${this.deviceLabel()})`, { tracks: p.tracks.map((t) => ({ ...t })), description: p.description, color: p.color });
        this.log(`playlist «${p.name}»: versione troppo vecchia, copia locale «${copy.name}»`);
        await this.saveBase(p.id, baseOf(e.current));
        await this.applyDoc(e.current);
        return;
      }
      throw e;
    }
  }
  private deviceLabel() { return 'questo dispositivo'; }

  private async pushDelete(id: string) {
    const base = this.bases.get(id)!;
    try {
      await this.api.deletePlaylist(id, base.version);
      await this.saveBase(id, undefined);
    } catch (e) {
      if (e instanceof SyncError && e.status === 404) { await this.saveBase(id, undefined); return; }
      if (!(e instanceof SyncError) || !e.current) throw e;
      // changed elsewhere after this device deleted it: it comes back here, with the other device's changes
      this.log(`playlist «${e.current.name}» modificata altrove: ripristinata`);
      await this.saveBase(id, baseOf(e.current));
      await this.applyDoc(e.current);
      this.st.lastNews = `«${e.current.name}» era stata eliminata qui ma modificata altrove: è tornata.`;
    }
  }

  // ---- NAS → this device ----
  private async pull() {
    let more = true;
    const news: string[] = [];
    while (more) {
      const ch = await this.api.changes(this.lastSeq);
      for (const s of ch.playlists) await this.take(s, news);
      await this.saveSeq(ch.seq);
      more = ch.more;
    }
    if (news.length) { this.st.lastNews = news.slice(0, 3).join(' · ') + (news.length > 3 ? ` (+${news.length - 3})` : ''); }
  }

  private async take(s: PlaylistSummary, news: string[]) {
    const base = this.bases.get(s.id);
    const local = this.store.get(s.id);
    if (s.deleted) {
      if (!base) return; // never had it here
      const changedHere = local && diff(base, this.viewOfLocal(local)).length > 0;
      if (local && changedHere) {
        if (!this.conflicts.some((c) => c.kind === 'deleted' && c.playlistId === s.id)) { this.conflicts.push({ kind: 'deleted', playlistId: s.id, name: local.name, version: s.version }); await this.saveConflicts(); }
        return;
      }
      if (local) { this.applying++; try { this.store.remove(s.id); } finally { this.applying--; } news.push(`«${s.name}» eliminata da ${s.updatedByName ?? 'un altro dispositivo'}`); }
      await this.saveBase(s.id, undefined);
      return;
    }
    if (base && base.version === s.version) return;
    const doc = await this.api.playlist(s.id);
    if (local && base && diff(base, this.viewOfLocal(local)).length) {
      // changed on both sides: the ops route merges them
      await this.pushOps(local, base);
      return;
    }
    const before = local?.tracks.length ?? 0;
    await this.saveBase(s.id, baseOf(doc));
    await this.applyDoc(doc);
    const delta = doc.entries.length - before;
    news.push(local ? `«${doc.name}» aggiornata da ${doc.updatedByName ?? 'un altro dispositivo'}${delta > 0 ? ` (+${delta} brani)` : delta < 0 ? ` (${delta} brani)` : ''}` : `nuova playlist «${doc.name}» da ${doc.updatedByName ?? 'un altro dispositivo'}`);
  }

  /**
   * Writes a playlist as the NAS has it into the local store. `sent` is what this device had when it talked to the NAS:
   * whatever the user changed meanwhile is put back on top, so it is not lost (it goes with the next push).
   */
  private async applyDoc(doc: PlaylistDoc, sent?: { meta: PlaylistMeta; entries: Entry[] }) {
    const local = this.store.get(doc.id);
    let view = viewOfDoc(doc);
    if (local && sent) {
      const meanwhile = diff(sent, this.viewOfLocal(local));
      if (meanwhile.length) view = apply(view, meanwhile);
    }
    const tracks = view.entries.map((e) => trackOf(e, this.localIdOf)).filter((t): t is Track => !!t);
    // keep what only this device knows about its songs (lock, «non riproducibile», manual)
    const known = new Map((local?.tracks ?? []).map((t) => [t.videoId, t]));
    for (const t of tracks) { const k = known.get(t.videoId); if (k) { if (k.status === 'unplayable') t.status = 'unplayable'; if (k.manual) t.manual = true; if (k.structured) t.structured = true; } }
    const p: Playlist = {
      id: doc.id, name: view.meta.name, tracks, createdAt: local?.createdAt ?? doc.createdAt, updatedAt: doc.updatedAt, sortOrder: view.meta.sortOrder,
      removed: local?.removed ?? [],
    };
    for (const k of ['description', 'color', 'cover', 'link'] as const) if (view.meta[k]) p[k] = view.meta[k];
    if (view.meta.source === 'YouTube' || view.meta.source === 'Spotify' || view.meta.source === 'Locale') p.source = view.meta.source;
    this.applying++;
    try { this.store.upsert(p); } finally { this.applying--; }
  }

  // ---- conflicts: the user decides ----
  /** `mine`: this device's value goes on the NAS; `theirs`: the NAS's value stays (it is already here). */
  async resolve(c: SyncConflict, choice: 'mine' | 'theirs'): Promise<void> {
    this.conflicts = this.conflicts.filter((x) => x !== c);
    await this.saveConflicts();
    this.changed();
    if (c.kind === 'field') {
      if (choice === 'mine') {
        const local = this.store.get(c.playlistId);
        if (local) {
          this.applying++;
          try {
            if (c.field === 'name') this.store.rename(local.id, String(c.mine ?? ''));
            else if (c.field === 'sortOrder') { /* order is per device */ }
            else this.store.update(local.id, { [c.field]: c.mine as string | undefined });
          } finally { this.applying--; }
        }
        await this.syncNow();
      }
      return;
    }
    // deleted elsewhere, changed here
    const local = this.store.get(c.playlistId);
    if (choice === 'mine' && local) {
      const v = this.viewOfLocal(local);
      const doc = await this.api.putPlaylist(local.id, c.version, v.meta, v.entries);
      await this.saveBase(local.id, baseOf(doc));
      await this.applyDoc(doc, v);
    } else {
      this.applying++;
      try { this.store.remove(c.playlistId); } finally { this.applying--; }
      await this.saveBase(c.playlistId, undefined);
    }
    this.changed();
  }

  /** Forgets everything agreed with the NAS (when the device is unlinked): the playlists stay on the device. */
  async reset(): Promise<void> {
    this.stop();
    for (const id of [...this.bases.keys()]) await this.saveBase(id, undefined);
    await this.saveSeq(0);
    this.conflicts = [];
    await this.saveConflicts();
    this.st = { configured: false, connected: false, live: false, syncing: false, pending: 0, conflicts: [] };
    this.changed();
  }
}
