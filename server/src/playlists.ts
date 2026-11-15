import { randomUUID } from 'node:crypto';
import type { Entry, PlaylistDoc, PlaylistMeta, PlaylistSummary } from '../../shared/model.ts';
import { bump, type Db } from './db.ts';
import { bad, HttpError } from './http.ts';

const KEEP_REVS = 30;
const MAX_ENTRIES = 20_000;

type Row = {
  id: string; name: string; description: string | null; color: string | null; cover: string | null; link: string | null;
  source: string | null; sort_order: number; version: number; created_at: number; updated_at: number; updated_by: string | null;
  deleted_at: number | null; seq: number; by_name?: string | null; count?: number;
};
type EntryRow = {
  entry_id: string; track_id: string | null; youtube_id: string | null; title: string | null; artist: string | null;
  album: string | null; thumb: string | null; duration_sec: number | null;
};

const SELECT = `SELECT p.*, d.name AS by_name,
  (SELECT COUNT(*) FROM playlist_entry e WHERE e.playlist_id = p.id) AS count
  FROM playlist p LEFT JOIN device d ON d.id = p.updated_by`;

function summary(r: Row): PlaylistSummary {
  const out: PlaylistSummary = {
    id: r.id, name: r.name, sortOrder: r.sort_order, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
    updatedBy: r.updated_by, count: r.count ?? 0,
  };
  if (r.by_name) out.updatedByName = r.by_name;
  if (r.deleted_at != null) out.deleted = true;
  for (const [k, col] of [['description', 'description'], ['color', 'color'], ['cover', 'cover'], ['link', 'link'], ['source', 'source']] as const) {
    const v = r[col];
    if (v) out[k] = v;
  }
  return out;
}

function entryOf(r: EntryRow): Entry {
  const e: Entry = { entryId: r.entry_id };
  if (r.track_id) e.trackId = r.track_id;
  if (r.youtube_id) e.youtubeId = r.youtube_id;
  if (r.title) e.title = r.title;
  if (r.artist) e.artist = r.artist;
  if (r.album) e.album = r.album;
  if (r.thumb) e.thumb = r.thumb;
  if (r.duration_sec != null) e.durationSec = r.duration_sec;
  return e;
}

/** Checks what a client sent as a playlist line. */
export function cleanEntry(v: unknown): Entry {
  const e = v as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') throw bad('riga non valida');
  const s = (k: string, max: number) => {
    const x = e[k];
    if (x == null || x === '') return undefined;
    if (typeof x !== 'string' || x.length > max) throw bad(`riga: ${k} non valido`);
    return x;
  };
  const out: Entry = { entryId: s('entryId', 64) ?? randomUUID() };
  const trackId = s('trackId', 64);
  const youtubeId = s('youtubeId', 32);
  if (trackId && !/^[0-9a-f]{64}$/.test(trackId)) throw bad('riga: trackId deve essere uno SHA-256');
  if (!trackId && !youtubeId) throw bad('riga senza brano');
  if (trackId) out.trackId = trackId;
  if (youtubeId) out.youtubeId = youtubeId;
  for (const k of ['title', 'artist', 'album'] as const) { const x = s(k, 300); if (x) out[k] = x; }
  const thumb = s('thumb', 1000);
  if (thumb) out.thumb = thumb;
  if (typeof e.durationSec === 'number' && Number.isFinite(e.durationSec) && e.durationSec >= 0) out.durationSec = e.durationSec;
  return out;
}

export function cleanMeta(v: Record<string, unknown>, base?: PlaylistMeta): PlaylistMeta {
  const s = (k: string, max: number) => {
    const x = v[k];
    if (x === undefined) return base?.[k as keyof PlaylistMeta] as string | undefined;
    if (x === null || x === '') return undefined;
    if (typeof x !== 'string' || x.length > max) throw bad(`${k} non valido`);
    return x;
  };
  const name = (s('name', 80) ?? '').trim();
  if (!name) throw bad('nome della playlist mancante');
  const out: PlaylistMeta = { name, sortOrder: typeof v.sortOrder === 'number' && Number.isFinite(v.sortOrder) ? v.sortOrder : base?.sortOrder ?? 0 };
  for (const [k, max] of [['description', 500], ['color', 20], ['cover', 1000], ['link', 1000], ['source', 20]] as const) {
    const x = s(k, max);
    if (x) out[k] = x;
  }
  return out;
}

export class Playlists {
  private db: Db;
  private now: () => number;
  /** Called after each change with the new document (JSON copy on the NAS, events to devices). */
  onChange: (doc: PlaylistDoc, seq: number) => void = () => {};
  constructor(db: Db, now: () => number) { this.db = db; this.now = now; }

  list(includeDeleted = false): PlaylistSummary[] {
    const rows = this.db.prepare(`${SELECT} ${includeDeleted ? '' : 'WHERE p.deleted_at IS NULL'} ORDER BY p.sort_order, p.name`).all() as Row[];
    return rows.map(summary);
  }

  /** Playlists changed after `since`, at most `limit`, in seq order. */
  changedSince(since: number, limit: number): (PlaylistSummary & { seq: number })[] {
    const rows = this.db.prepare(`${SELECT} WHERE p.seq > ? ORDER BY p.seq LIMIT ?`).all(since, limit) as Row[];
    return rows.map((r) => ({ ...summary(r), seq: r.seq }));
  }

  get(id: string, includeDeleted = false): PlaylistDoc | undefined {
    const r = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    if (!r || (r.deleted_at != null && !includeDeleted)) return undefined;
    const entries = (this.db.prepare('SELECT * FROM playlist_entry WHERE playlist_id = ? ORDER BY pos').all(id) as EntryRow[]).map(entryOf);
    const { count: _c, ...rest } = summary(r);
    return { ...rest, entries };
  }

  /** A playlist at an older version (the last 30 are kept): base for merging and "restore". */
  revision(id: string, version: number): PlaylistDoc | undefined {
    const r = this.db.prepare('SELECT snapshot FROM playlist_rev WHERE playlist_id = ? AND version = ?').get(id, version) as { snapshot: string } | undefined;
    return r ? (JSON.parse(r.snapshot) as PlaylistDoc) : undefined;
  }

  revisions(id: string): { version: number; at: number; deviceId: string | null; count: number }[] {
    const rows = this.db.prepare('SELECT version, at, device_id, snapshot FROM playlist_rev WHERE playlist_id = ? ORDER BY version DESC').all(id) as { version: number; at: number; device_id: string | null; snapshot: string }[];
    return rows.map((r) => ({ version: r.version, at: r.at, deviceId: r.device_id, count: (JSON.parse(r.snapshot) as PlaylistDoc).entries.length }));
  }

  create(meta: PlaylistMeta, entries: Entry[], deviceId: string, id?: string): PlaylistDoc {
    if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw bad('id non valido');
    const pid = id ?? randomUUID();
    if (this.db.prepare('SELECT 1 FROM playlist WHERE id = ?').get(pid)) throw new HttpError(409, 'EXISTS', 'Esiste già una playlist con questo id');
    const t = this.now();
    this.db.prepare(`INSERT INTO playlist (id, name, sort_order, version, created_at, updated_at, updated_by, seq) VALUES (?, ?, ?, 0, ?, ?, ?, 0)`)
      .run(pid, meta.name, meta.sortOrder, t, t, deviceId);
    return this.write(pid, meta, entries, deviceId);
  }

  /**
   * Replaces the whole playlist and adds 1 to its version. Every caller has already checked the version it
   * started from: a stale write never lands here (see the PUT and ops routes).
   */
  write(id: string, meta: PlaylistMeta, entries: Entry[], deviceId: string): PlaylistDoc {
    if (entries.length > MAX_ENTRIES) throw bad(`al massimo ${MAX_ENTRIES} brani per playlist`);
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.entryId)) throw bad('due righe con lo stesso entryId');
      seen.add(e.entryId);
    }
    const t = this.now();
    const seq = bump(this.db, 'playlist', id, t);
    this.db.prepare(`UPDATE playlist SET name = ?, description = ?, color = ?, cover = ?, link = ?, source = ?, sort_order = ?,
      version = version + 1, updated_at = ?, updated_by = ?, deleted_at = NULL, seq = ? WHERE id = ?`)
      .run(meta.name, meta.description ?? null, meta.color ?? null, meta.cover ?? null, meta.link ?? null, meta.source ?? null,
        meta.sortOrder, t, deviceId, seq, id);
    this.db.prepare('DELETE FROM playlist_entry WHERE playlist_id = ?').run(id);
    const ins = this.db.prepare(`INSERT INTO playlist_entry (playlist_id, entry_id, pos, track_id, youtube_id, title, artist, album, thumb, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    entries.forEach((e, i) => ins.run(id, e.entryId, i, e.trackId ?? null, e.youtubeId ?? null, e.title ?? null, e.artist ?? null,
      e.album ?? null, e.thumb ?? null, e.durationSec ?? null));
    const doc = this.get(id)!;
    this.snapshot(doc, deviceId, t);
    this.onChange(doc, seq);
    return doc;
  }

  /** Deleting keeps a tombstone (devices learn about it) and the old versions (it can be restored). */
  remove(id: string, deviceId: string): number {
    const t = this.now();
    const seq = bump(this.db, 'playlist', id, t);
    this.db.prepare('UPDATE playlist SET deleted_at = ?, updated_at = ?, updated_by = ?, version = version + 1, seq = ? WHERE id = ?').run(t, t, deviceId, seq, id);
    const doc = this.get(id, true)!;
    this.onChange(doc, seq);
    return doc.version;
  }

  private snapshot(doc: PlaylistDoc, deviceId: string, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO playlist_rev (playlist_id, version, snapshot, device_id, at) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, doc.version, JSON.stringify(doc), deviceId, at);
    this.db.prepare('DELETE FROM playlist_rev WHERE playlist_id = ? AND version <= ?').run(doc.id, doc.version - KEEP_REVS);
  }
}
