import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TrackDoc, UploadMeta } from '../../shared/model.ts';
import { bump, tx, type Db } from './db.ts';
import { bad, HttpError } from './http.ts';

/**
 * The songs on the NAS: one file each in music/<Artista>/<Album>/<NN Titolo>.<ext>, identified by the SHA-256 of
 * its bytes (the file name is only for people). Files arrive in pieces (PUT /api/uploads/:id with Content-Range),
 * so an interrupted upload goes on from where it stopped; when the last piece is in, the hash is computed again
 * here: a file that does not match what the device promised is thrown away, never kept.
 */

export const MAX_CHUNK = 8 << 20;
/** A file bigger than this is refused up front (a 4 GB concert video is fine, a disk image is not). */
const MAX_FILE = 8 * 1024 * 1024 * 1024;
const MAX_COVER = 2 << 20;
/** Free space to keep on the volume: an upload that would go below it is refused. */
const KEEP_FREE = 200 << 20;
const PART_MAX_AGE = 7 * 86_400_000;

const EXT_OF_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm',
};
const MIME_OF_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', wav: 'audio/wav',
  webm: 'audio/webm', mp4: 'video/mp4',
};

export type ScanResult = { found: number; added: number; duplicates: number; failed: number };

/** Words for a song copied by hand, from where it is: «Artista/Album/03 Titolo.mp3», «Artista - Titolo.mp3», «Titolo.mp3». */
export function metaFromPath(rel: string): { title: string; artist?: string; album?: string; trackNo?: number } {
  const parts = rel.split('/');
  let stem = parts[parts.length - 1].replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  let trackNo: number | undefined;
  const num = /^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(stem);
  if (num) { trackNo = Number(num[1]); stem = num[2].trim(); }
  let artist = parts.length >= 3 ? parts[parts.length - 3] : parts.length === 2 ? parts[0] : undefined;
  const album = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(stem);
  if (dash && (!artist || parts.length === 2)) { artist = dash[1].trim(); stem = dash[2].trim(); }
  const out: { title: string; artist?: string; album?: string; trackNo?: number } = { title: stem || 'Brano' };
  if (artist && artist !== 'Artista sconosciuto') out.artist = artist;
  if (album && album !== 'Senza album') out.album = album;
  if (trackNo != null) out.trackNo = trackNo;
  return out;
}
const COVER_EXT: Record<string, string> ={ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const COVER_MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const SHA = /^[0-9a-f]{64}$/;

/** One folder or file name: no slashes, no reserved characters, no leading dots, at most 80 characters. */
export const safeName = (s: string | undefined, fallback: string) =>
  (s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || fallback;

/** SHA-256 of a file read in pieces (never the whole file in memory). */
export function sha256File(path: string): Promise<string> {
  return new Promise((ok, ko) => {
    const h = createHash('sha256');
    createReadStream(path, { highWaterMark: 1 << 20 }).on('data', (c) => h.update(c as Buffer)).on('end', () => ok(h.digest('hex'))).on('error', ko);
  });
}

type Row = {
  id: string; title: string; artist_id: number | null; album_id: number | null; genre: string | null; year: number | null; track_no: number | null;
  duration_sec: number | null; size: number; mime: string; path: string; cover_sha256: string | null; youtube_id: string | null; added_by: string | null;
  added_at: number; meta_version: number; deleted_at: number | null; seq: number; artist_name: string | null; album_title: string | null;
};
type UploadRow = { id: string; device_id: string; sha256: string; size: number; received: number; meta: string; created_at: number };
type UploadMetaStored = { mime: string; ext: string; meta: UploadMeta; youtubeId?: string };

const SELECT = `SELECT t.*, a.name AS artist_name, al.title AS album_title FROM track t
  LEFT JOIN artist a ON a.id = t.artist_id LEFT JOIN album al ON al.id = t.album_id`;

function docOf(r: Row): TrackDoc {
  const d: TrackDoc = { id: r.id, title: r.title, size: r.size, mime: r.mime, hasCover: !!r.cover_sha256, addedAt: r.added_at, metaVersion: r.meta_version };
  if (r.artist_name) d.artist = r.artist_name;
  if (r.album_title) d.album = r.album_title;
  if (r.genre) d.genre = r.genre;
  if (r.year != null) d.year = r.year;
  if (r.track_no != null) d.trackNo = r.track_no;
  if (r.duration_sec != null) d.durationSec = r.duration_sec;
  if (r.youtube_id) d.youtubeId = r.youtube_id;
  if (r.deleted_at != null) d.deleted = true;
  return d;
}

/** Checks the metadata a device sent with a file (or to change). `partial`: fields left out keep their value. */
export function cleanUploadMeta(v: unknown, partial = false): Partial<UploadMeta> {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Partial<UploadMeta> = {};
  const s = (k: keyof UploadMeta, max: number) => {
    const x = m[k];
    if (x === undefined) return undefined;
    if (x === null || x === '') return '';
    if (typeof x !== 'string') throw bad(`meta.${k} deve essere testo`);
    const t = x.trim().slice(0, max);
    return t;
  };
  const n = (k: keyof UploadMeta, min: number, max: number) => {
    const x = m[k];
    if (x === undefined || x === null) return x === null ? null : undefined;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw bad(`meta.${k} non valido`);
    return x;
  };
  const title = s('title', 300);
  if (title !== undefined) { if (!title) { if (!partial) throw bad('meta.title mancante'); } else out.title = title; }
  else if (!partial) throw bad('meta.title mancante');
  for (const k of ['artist', 'album', 'genre'] as const) { const x = s(k, 300); if (x !== undefined) out[k] = x; }
  const year = n('year', 0, 9999), trackNo = n('trackNo', 0, 9999), dur = n('durationSec', 0, 86_400 * 7);
  if (year !== undefined) out.year = year === null ? undefined : Math.round(year);
  if (trackNo !== undefined) out.trackNo = trackNo === null ? undefined : Math.round(trackNo);
  if (dur !== undefined) out.durationSec = dur === null ? undefined : dur;
  return out;
}

export class Tracks {
  private db: Db;
  private root: string;
  private now: () => number;
  /** Uploads with a piece being written right now: a second piece at the same time waits its turn (409). */
  private busy = new Set<string>();
  /** Called after each change (events to devices). */
  onChange: (doc: TrackDoc, seq: number) => void = () => {};

  constructor(db: Db, root: string, now: () => number) {
    this.db = db;
    this.root = root;
    this.now = now;
  }

  private partPath(id: string) { return join(this.root, 'cache', 'uploads', `${id}.part`); }

  // ---- reading ----
  get(id: string, includeDeleted = false): TrackDoc | undefined {
    const r = this.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    if (!r || (r.deleted_at != null && !includeDeleted)) return undefined;
    return docOf(r);
  }

  /** Which of these files the NAS has (ids are SHA-256). */
  check(shas: unknown): { missing: string[]; present: string[] } {
    if (!Array.isArray(shas) || shas.length > 1000) throw bad('sha256: elenco mancante o troppo lungo');
    const ids = [...new Set(shas.map((x) => { if (typeof x !== 'string' || !SHA.test(x)) throw bad('sha256 non valido'); return x; }))];
    const have = new Set<string>();
    const q = this.db.prepare('SELECT id FROM track WHERE id = ? AND deleted_at IS NULL');
    for (const id of ids) if (q.get(id)) have.add(id);
    return { present: ids.filter((x) => have.has(x)), missing: ids.filter((x) => !have.has(x)) };
  }

  /** A page of the library in title order (never the whole library at once); `q` filters by title, artist or album. */
  library(cursor: string | null, limit: number, q: string): { tracks: TrackDoc[]; next?: string } {
    const where = ['t.deleted_at IS NULL'];
    const args: (string | number)[] = [];
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      where.push(`(t.title LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR al.title LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    if (cursor) {
      let c: [string, string];
      try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (!Array.isArray(c) || c.length !== 2) throw new Error(); } catch { throw bad('cursor non valido'); }
      where.push('(t.title COLLATE NOCASE > ? OR (t.title COLLATE NOCASE = ? AND t.id > ?))');
      args.push(c[0], c[0], c[1]);
    }
    const rows = this.db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.title COLLATE NOCASE, t.id LIMIT ?`).all(...args, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const out: { tracks: TrackDoc[]; next?: string } = { tracks: page.map(docOf) };
    if (rows.length > limit) { const last = page[page.length - 1]; out.next = Buffer.from(JSON.stringify([last.title, last.id])).toString('base64url'); }
    return out;
  }

  /** Songs changed after `since` (tombstones too), at most `limit`, in seq order. */
  changedSince(since: number, limit: number): (TrackDoc & { seq: number })[] {
    const rows = this.db.prepare(`${SELECT} WHERE t.seq > ? ORDER BY t.seq LIMIT ?`).all(since, limit) as Row[];
    return rows.map((r) => ({ ...docOf(r), seq: r.seq }));
  }

  count(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM track WHERE deleted_at IS NULL').get() as { n: number }).n; }

  // ---- uploads ----
  /**
   * A device wants to send a file. Already here: the song, and nothing to send. Being sent by this device already:
   * the same upload, with how much arrived (the device goes on from there). Otherwise a new upload.
   */
  startUpload(deviceId: string, b: Record<string, unknown>): { track: TrackDoc } | { uploadId: string; received: number } {
    const sha = b.sha256;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw bad('sha256 non valido');
    const size = b.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_FILE) throw bad('size non valido');
    const mime = typeof b.mime === 'string' && /^(audio|video)\/[\w.+-]{1,40}$/.test(b.mime) ? b.mime : undefined;
    if (!mime) throw bad('mime non valido: serve audio/* o video/*');
    const ext = typeof b.ext === 'string' && /^[a-z0-9]{1,5}$/i.test(b.ext) ? b.ext.toLowerCase() : EXT_OF_MIME[mime];
    if (!ext) throw bad('estensione del file sconosciuta');
    const meta = cleanUploadMeta(b.meta) as UploadMeta;
    const youtubeId = b.youtubeId == null || b.youtubeId === '' ? undefined : typeof b.youtubeId === 'string' && /^[\w-]{6,20}$/.test(b.youtubeId) ? b.youtubeId : (() => { throw bad('youtubeId non valido'); })();
    const have = this.get(sha);
    if (have) return { track: have };
    const old = this.db.prepare('SELECT * FROM upload WHERE device_id = ? AND sha256 = ?').get(deviceId, sha) as UploadRow | undefined;
    if (old) {
      // what is really on disk decides (the container may have restarted in the middle of a piece)
      let received = 0;
      try { received = statSync(this.partPath(old.id)).size; } catch { received = 0; }
      if (received > old.size) received = 0;
      if (received !== old.received) this.db.prepare('UPDATE upload SET received = ? WHERE id = ?').run(received, old.id);
      if (received === 0) { try { unlinkSync(this.partPath(old.id)); } catch { /* none */ } }
      return { uploadId: old.id, received };
    }
    this.checkSpace(size);
    const id = randomUUID();
    const stored: UploadMetaStored = { mime, ext, meta, ...(youtubeId ? { youtubeId } : {}) };
    this.db.prepare('INSERT INTO upload (id, device_id, sha256, size, received, meta, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, deviceId, sha, size, JSON.stringify(stored), this.now());
    return { uploadId: id, received: 0 };
  }

  private checkSpace(size: number) {
    try {
      const st = statfsSync(this.root);
      const free = st.bavail * st.bsize;
      if (free - size < KEEP_FREE) throw new HttpError(507, 'NO_SPACE', `Spazio insufficiente sul NAS: liberi ${(free / (1 << 20)).toFixed(0)} MB`, { freeBytes: free });
    } catch (e) {
      if (e instanceof HttpError) throw e; // a file system that does not answer is not a reason to refuse
    }
  }

  /**
   * One piece of a file: bytes `from`…`to` (inclusive) of `total`. Pieces come in order; one that starts elsewhere than
   * where the previous ended is refused with how much is here, so the device resumes from there. The last piece
   * completes the file: the hash is checked and the song joins the library.
   */
  async chunk(deviceId: string, uploadId: string, from: number, to: number, total: number, data: Buffer): Promise<{ done: false; received: number } | { done: true; track: TrackDoc }> {
    const u = this.db.prepare('SELECT * FROM upload WHERE id = ?').get(uploadId) as UploadRow | undefined;
    if (!u || u.device_id !== deviceId) throw new HttpError(404, 'NOT_FOUND', 'Upload non trovato: ricomincia');
    if (total !== u.size) throw bad(`Content-Range: la lunghezza totale è ${u.size}`);
    if (to < from || to >= total) throw bad('Content-Range non valido');
    if (to - from + 1 > MAX_CHUNK) throw new HttpError(413, 'TOO_LARGE', `Pezzi di al massimo ${MAX_CHUNK} byte`);
    if (data.length !== to - from + 1) throw bad(`Il corpo ha ${data.length} byte, Content-Range ne annuncia ${to - from + 1}`);
    if (this.busy.has(uploadId)) throw new HttpError(409, 'BUSY', 'Un altro pezzo di questo upload è in scrittura', { received: u.received });
    if (from !== u.received) throw new HttpError(409, 'OUT_OF_ORDER', `Pezzo fuori ordine: ricevuti ${u.received} byte`, { received: u.received });
    this.busy.add(uploadId);
    try {
      const part = this.partPath(uploadId);
      mkdirSync(dirname(part), { recursive: true });
      appendFileSync(part, data);
      const received = to + 1;
      this.db.prepare('UPDATE upload SET received = ? WHERE id = ?').run(received, uploadId);
      if (received < total) return { done: false, received };
      return { done: true, track: await this.finish(u, deviceId) };
    } finally {
      this.busy.delete(uploadId);
    }
  }

  private async finish(u: UploadRow, deviceId: string): Promise<TrackDoc> {
    const part = this.partPath(u.id);
    const got = await sha256File(part);
    if (got !== u.sha256) {
      try { unlinkSync(part); } catch { /* gone */ }
      this.db.prepare('DELETE FROM upload WHERE id = ?').run(u.id);
      throw new HttpError(422, 'CORRUPT_FILE', 'Il file è arrivato danneggiato (l’impronta non corrisponde): è stato scartato, riprova');
    }
    const stored = JSON.parse(u.meta) as UploadMetaStored;
    const existing = this.get(u.sha256);
    if (existing) { // another device sent the same file meanwhile
      try { unlinkSync(part); } catch { /* gone */ }
      this.db.prepare('DELETE FROM upload WHERE id = ?').run(u.id);
      return existing;
    }
    const rel = this.placeFile(part, stored.meta, stored.ext);
    let seq = 0;
    const doc = tx(this.db, () => {
      const t = this.now();
      const artistId = this.artistId(stored.meta.artist);
      const albumId = this.albumId(artistId, stored.meta.album, stored.meta.year);
      seq = bump(this.db, 'track', u.sha256, t);
      const m = stored.meta;
      const tomb = this.db.prepare('SELECT 1 FROM track WHERE id = ?').get(u.sha256);
      if (tomb) { // deleted earlier, sent again: back, with the new file
        this.db.prepare(`UPDATE track SET title = ?, artist_id = ?, album_id = ?, genre = ?, year = ?, track_no = ?, duration_sec = ?, size = ?, mime = ?, path = ?,
          youtube_id = ?, added_by = ?, added_at = ?, meta_version = meta_version + 1, deleted_at = NULL, seq = ? WHERE id = ?`)
          .run(m.title, artistId, albumId, m.genre || null, m.year ?? null, m.trackNo ?? null, m.durationSec ?? null, u.size, stored.mime, rel, stored.youtubeId ?? null, deviceId, t, seq, u.sha256);
      } else {
        this.db.prepare(`INSERT INTO track (id, title, artist_id, album_id, genre, year, track_no, duration_sec, size, mime, path, youtube_id, added_by, added_at, seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(u.sha256, m.title, artistId, albumId, m.genre || null, m.year ?? null, m.trackNo ?? null, m.durationSec ?? null, u.size, stored.mime, rel, stored.youtubeId ?? null, deviceId, t, seq);
      }
      this.db.prepare('DELETE FROM upload WHERE id = ?').run(u.id);
      return this.get(u.sha256)!;
    });
    this.onChange(doc, seq);
    return doc;
  }

  /** Moves the finished file to music/<Artista>/<Album>/<NN Titolo>.<ext> (a name already taken gets « (2)»). Returns the path relative to music/. */
  private placeFile(part: string, m: UploadMeta, ext: string): string {
    const dir = join(safeName(m.artist, 'Artista sconosciuto'), safeName(m.album, 'Senza album'));
    const stem = `${m.trackNo ? String(m.trackNo).padStart(2, '0') + ' ' : ''}${safeName(m.title, 'Brano')}`;
    mkdirSync(join(this.root, 'music', dir), { recursive: true });
    let rel = `${dir}/${stem}.${ext}`;
    for (let n = 2; existsSync(join(this.root, 'music', rel)); n++) rel = `${dir}/${stem} (${n}).${ext}`;
    const dest = join(this.root, 'music', rel);
    try { renameSync(part, dest); } catch { copyFileSync(part, dest); unlinkSync(part); } // cache/ and music/ on different volumes
    return rel.replace(/\\/g, '/');
  }

  private artistId(name: string | undefined): number | null {
    const n = name?.trim();
    if (!n) return null;
    const r = this.db.prepare('SELECT id FROM artist WHERE name = ?').get(n) as { id: number } | undefined;
    if (r) return r.id;
    return Number(this.db.prepare('INSERT INTO artist (name) VALUES (?)').run(n).lastInsertRowid);
  }
  private albumId(artistId: number | null, title: string | undefined, year: number | undefined): number | null {
    const t = title?.trim();
    if (!t) return null;
    const r = this.db.prepare('SELECT id FROM album WHERE artist_id IS ? AND title = ?').get(artistId, t) as { id: number } | undefined;
    if (r) return r.id;
    return Number(this.db.prepare('INSERT INTO album (artist_id, title, year) VALUES (?, ?, ?)').run(artistId, t, year ?? null).lastInsertRowid);
  }

  // ---- changing and deleting ----
  /** Changes words only (title, artist…): the audio stays where it is. */
  patch(id: string, b: Record<string, unknown>): TrackDoc {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Brano non trovato');
    const m = cleanUploadMeta(b.meta ?? b, true);
    if (!Object.keys(m).length) return cur;
    let seq = 0;
    const doc = tx(this.db, () => {
      const t = this.now();
      seq = bump(this.db, 'track', id, t);
      const title = m.title ?? cur.title;
      const artist = m.artist !== undefined ? m.artist : cur.artist;
      const album = m.album !== undefined ? m.album : cur.album;
      const artistId = this.artistId(artist);
      const albumId = this.albumId(artistId, album, m.year ?? cur.year);
      this.db.prepare(`UPDATE track SET title = ?, artist_id = ?, album_id = ?, genre = ?, year = ?, track_no = ?, duration_sec = ?, meta_version = meta_version + 1, seq = ? WHERE id = ?`)
        .run(title, artistId, albumId, (m.genre !== undefined ? m.genre : cur.genre) || null, 'year' in m ? m.year ?? null : cur.year ?? null,
          'trackNo' in m ? m.trackNo ?? null : cur.trackNo ?? null, 'durationSec' in m ? m.durationSec ?? null : cur.durationSec ?? null, seq, id);
      return this.get(id)!;
    });
    this.onChange(doc, seq);
    return doc;
  }

  /** The song leaves the library (a tombstone tells the devices); the file goes to cache/trash, not lost at once. */
  remove(id: string): TrackDoc {
    const r = this.db.prepare(`${SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Brano non trovato');
    let seq = 0;
    const doc = tx(this.db, () => {
      const t = this.now();
      seq = bump(this.db, 'track', id, t);
      this.db.prepare('UPDATE track SET deleted_at = ?, seq = ? WHERE id = ?').run(t, seq, id);
      return this.get(id, true)!;
    });
    const src = join(this.root, 'music', r.path);
    const trash = join(this.root, 'cache', 'trash');
    try {
      mkdirSync(trash, { recursive: true });
      renameSync(src, join(trash, `${id}.${r.path.split('.').pop()}`));
      const dir = dirname(src); // artist and album folders left empty go too
      try { if (!readdirSync(dir).length) { unlinkDir(dir); if (!readdirSync(dirname(dir)).length) unlinkDir(dirname(dir)); } } catch { /* fine */ }
    } catch { /* already gone */ }
    this.onChange(doc, seq);
    return doc;
  }

  /** The absolute path of a song's file, for streaming. */
  filePath(id: string): { path: string; mime: string; size: number } | undefined {
    const r = this.db.prepare('SELECT path, mime, size FROM track WHERE id = ? AND deleted_at IS NULL').get(id) as { path: string; mime: string; size: number } | undefined;
    return r ? { path: join(this.root, 'music', r.path), mime: r.mime, size: r.size } : undefined;
  }

  // ---- files copied by hand into music/ ----
  private scanning?: Promise<ScanResult>;
  private lastScan?: ScanResult & { at: number };

  /** The last scan (or the running one): how many files were found and added. */
  scanStatus(): { running: boolean; last?: ScanResult & { at: number } } { return { running: !!this.scanning, last: this.lastScan }; }

  /**
   * Songs copied straight into music/ (File Station, SMB…) join the library: every audio file whose path the
   * library does not know is read once for its SHA-256 and added where it is (it is not moved). The name gives
   * the words: «Artista/Album/03 Titolo.mp3», or «Artista - Titolo.mp3». A file that is the copy of a song already
   * there is left alone. One scan at a time; a scan already running is returned.
   */
  scan(): Promise<ScanResult> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().then((r) => { this.lastScan = { ...r, at: this.now() }; return r; }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async doScan(): Promise<ScanResult> {
    const music = join(this.root, 'music');
    const known = new Set((this.db.prepare('SELECT path FROM track').all() as { path: string }[]).map((r) => r.path));
    const found: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (depth > 6) return;
      let names: string[] = [];
      try { names = readdirSync(join(music, rel)); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.') || n.startsWith('@') || n === '#recycle') continue; // hidden, Synology @eaDir, recycle bin
        const r = rel ? `${rel}/${n}` : n;
        let st;
        try { st = statSync(join(music, r)); } catch { continue; }
        if (st.isDirectory()) walk(r, depth + 1);
        else if (st.isFile() && st.size > 0 && MIME_OF_EXT[n.split('.').pop()!.toLowerCase()] && !known.has(r)) found.push(r);
      }
    };
    walk('', 0);
    let added = 0, duplicates = 0, failed = 0;
    for (const rel of found) {
      try {
        const file = join(music, rel);
        const sha = await sha256File(file);
        const size = statSync(file).size;
        const have = this.get(sha);
        if (have) { duplicates++; continue; }
        const ext = rel.split('.').pop()!.toLowerCase();
        const m = metaFromPath(rel);
        let seq = 0;
        const doc = tx(this.db, () => {
          const t = this.now();
          const artistId = this.artistId(m.artist);
          const albumId = this.albumId(artistId, m.album, undefined);
          seq = bump(this.db, 'track', sha, t);
          const tomb = this.db.prepare('SELECT 1 FROM track WHERE id = ?').get(sha);
          if (tomb) {
            this.db.prepare(`UPDATE track SET title = ?, artist_id = ?, album_id = ?, track_no = ?, size = ?, mime = ?, path = ?, added_by = NULL, added_at = ?,
              meta_version = meta_version + 1, deleted_at = NULL, seq = ? WHERE id = ?`).run(m.title, artistId, albumId, m.trackNo ?? null, size, MIME_OF_EXT[ext], rel, t, seq, sha);
          } else {
            this.db.prepare(`INSERT INTO track (id, title, artist_id, album_id, track_no, size, mime, path, added_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(sha, m.title, artistId, albumId, m.trackNo ?? null, size, MIME_OF_EXT[ext], rel, t, seq);
          }
          return this.get(sha)!;
        });
        this.onChange(doc, seq);
        added++;
      } catch (e) {
        failed++;
        console.error('scansione, file saltato:', rel, (e as Error).message);
      }
    }
    return { found: found.length, added, duplicates, failed };
  }

  // ---- covers ----
  /** A picture for the song, kept once per picture (covers/<sha256>.jpg): the album takes it too if it has none. */
  setCover(id: string, data: Buffer, mime: string): TrackDoc {
    const ext = COVER_EXT[mime];
    if (!ext) throw bad('Copertina: serve un\'immagine JPEG, PNG o WebP');
    if (!data.length || data.length > MAX_COVER) throw new HttpError(413, 'TOO_LARGE', 'Copertina troppo grande (massimo 2 MB)');
    const r = this.db.prepare('SELECT album_id, cover_sha256 FROM track WHERE id = ? AND deleted_at IS NULL').get(id) as { album_id: number | null; cover_sha256: string | null } | undefined;
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Brano non trovato');
    const sha = createHash('sha256').update(data).digest('hex');
    const file = join(this.root, 'covers', `${sha}.${ext}`);
    if (!existsSync(file)) writeFileSync(file, data);
    if (r.cover_sha256 === sha) return this.get(id)!;
    let seq = 0;
    const doc = tx(this.db, () => {
      seq = bump(this.db, 'track', id, this.now());
      this.db.prepare('UPDATE track SET cover_sha256 = ?, seq = ? WHERE id = ?').run(sha, seq, id);
      if (r.album_id != null) this.db.prepare('UPDATE album SET cover_sha256 = ? WHERE id = ? AND cover_sha256 IS NULL').run(sha, r.album_id);
      return this.get(id)!;
    });
    this.onChange(doc, seq);
    return doc;
  }

  cover(id: string): { path: string; mime: string; sha: string } | undefined {
    const r = this.db.prepare('SELECT cover_sha256 FROM track WHERE id = ?').get(id) as { cover_sha256: string | null } | undefined;
    if (!r?.cover_sha256) return undefined;
    for (const ext of Object.keys(COVER_MIME)) {
      const p = join(this.root, 'covers', `${r.cover_sha256}.${ext}`);
      if (existsSync(p)) return { path: p, mime: COVER_MIME[ext], sha: r.cover_sha256 };
    }
    return undefined;
  }

  // ---- housekeeping ----
  /** At start: pieces of uploads nobody resumed for a week are thrown away. */
  cleanup(): number {
    const dir = join(this.root, 'cache', 'uploads');
    const t = this.now();
    let n = 0;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const p = join(dir, name);
      try {
        if (t - statSync(p).mtimeMs < PART_MAX_AGE) continue;
        unlinkSync(p);
        this.db.prepare('DELETE FROM upload WHERE id = ?').run(name.slice(0, -5));
        n++;
      } catch { /* next */ }
    }
    this.db.prepare('DELETE FROM upload WHERE created_at < ? AND received = 0').run(t - PART_MAX_AGE);
    return n;
  }
}

function unlinkDir(dir: string) { try { rmdirSync(dir); } catch { /* not empty or gone */ } }
