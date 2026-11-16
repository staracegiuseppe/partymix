import { createReadStream, mkdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { apply, cleanOps, diff, type Conflict, type Op } from '../../shared/merge.ts';
import type { DeviceDoc, PlaylistDoc, PlaylistMeta, ServerEvent, SessionDoc, TrackDoc } from '../../shared/model.ts';
import {
  ALL_PERMS, createDevice, defaultPerms, DEVICE_KINDS, deviceForToken, getDevice, hashPassword, LoginLimiter, PairingCodes,
  PERM, permMask, permNames, verifyPassword, type Device, type DeviceKind, type PermName,
} from './auth.ts';
import { currentSeq, openDbSync, tx, type Db } from './db.ts';
import { bad, HttpError, isPrivateAddress, num, parseContentRange, readJson, readRaw, Router, sendJson, str } from './http.ts';
import { MAX_CHUNK, Tracks } from './tracks.ts';
import { cleanEntry, cleanMeta, Playlists } from './playlists.ts';

export const SERVER_VERSION = '0.1.0';

export type AppOptions = {
  /** The PartyMix folder on the NAS (music/, playlists/, database/…). */
  root: string;
  /** An open database (see openDb); without it the server opens <root>/database/partymix.sqlite with node:sqlite. */
  db?: Db;
  /** ':memory:' in tests (node:sqlite only). */
  dbFile?: string;
  now?: () => number;
  /** Accept requests from public internet addresses (default no: LAN and VPN only). */
  allowPublic?: boolean;
};

export type App = {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  db: Db;
  close: () => void;
};

/** Where the PartyMix app's page comes from: Tauri serves it on localhost, and Vite in development. */
const APP_ORIGIN = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d+)?|tauri:\/\/localhost)$/;

const FOLDERS = ['music', 'playlists', 'covers', 'metadata', 'database', 'cache', 'cache/uploads', 'cache/trash'];

export function createApp(opts: AppOptions): App {
  const now = opts.now ?? Date.now;
  for (const f of FOLDERS) mkdirSync(join(opts.root, f), { recursive: true });
  const db = opts.db ?? openDbSync(opts.dbFile ?? join(opts.root, 'database', 'partymix.sqlite'));
  const playlists = new Playlists(db, now);
  const tracks = new Tracks(db, opts.root, now);
  const dropped = tracks.cleanup();
  if (dropped) console.log(`upload abbandonati rimossi: ${dropped}`);
  const pairing = new PairingCodes(now);
  const limiter = new LoginLimiter(now);
  const listeners = new Set<ServerResponse>();

  const publish = (ev: ServerEvent) => {
    const line = `id: ${ev.seq}\nevent: change\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const r of listeners) r.write(line);
  };

  // A readable copy of every playlist next to the database: easy to back up and to look at.
  playlists.onChange = (doc: PlaylistDoc, seq: number) => {
    const file = join(opts.root, 'playlists', `${doc.id}.json`);
    try {
      writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2));
      renameSync(file + '.tmp', file);
    } catch (e) {
      console.error('copia playlist non scritta:', (e as Error).message);
    }
    publish({ seq, kind: 'playlist', id: doc.id, by: doc.updatedBy ?? undefined, summary: doc.deleted ? 'eliminata' : doc.name });
  };

  tracks.onChange = (doc: TrackDoc, seq: number) => publish({ seq, kind: 'track', id: doc.id, summary: doc.deleted ? 'eliminato' : doc.title });

  /** The part of a playlist the merge works on. */
  const mergeView = (p: PlaylistDoc) => {
    const meta: PlaylistMeta = { name: p.name, sortOrder: p.sortOrder };
    for (const k of ['description', 'color', 'cover', 'link', 'source'] as const) if (p[k]) meta[k] = p[k];
    return { meta, entries: p.entries };
  };

  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;

  const deviceDoc = (d: Device, me?: Device): DeviceDoc => ({
    id: d.id, name: d.name, kind: d.kind, perms: permNames(d.perms) as DeviceDoc['perms'], createdAt: d.created_at, lastSeen: d.last_seen,
    current: d.id === me?.id, revoked: d.revoked_at != null,
  });

  const session = (d: Device, token: string): SessionDoc => {
    const u = db.prepare('SELECT name FROM user WHERE id = ?').get(d.user_id) as { name: string };
    return { token, device: deviceDoc(d, d), user: { name: u.name } };
  };

  const deviceInput = (b: Record<string, unknown>) => {
    const name = str(b.deviceName, 'deviceName', 60)!;
    const kind = (b.deviceKind ?? 'other') as DeviceKind;
    if (!DEVICE_KINDS.includes(kind)) throw bad('deviceKind non valido');
    return { name, kind };
  };

  const auth = (req: IncomingMessage, url: URL, need?: PermName): Device => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    // EventSource cannot send headers: the events stream alone accepts the token in the query.
    const qtoken = url.pathname === '/api/events' ? url.searchParams.get('token') ?? undefined : undefined;
    const d = token || qtoken ? deviceForToken(db, (token ?? qtoken)!) : undefined;
    if (!d) throw new HttpError(401, 'UNAUTHORIZED', 'Dispositivo non autorizzato');
    if (need && (d.perms & PERM[need]) === 0) throw new HttpError(403, 'FORBIDDEN', `Permesso mancante: ${need}`);
    const t = now();
    if (t - d.last_seen > 30_000) db.prepare('UPDATE device SET last_seen = ? WHERE id = ?').run(t, d.id);
    return d;
  };

  const r = new Router();

  r.on('GET', '/api/health', ({ res }) => {
    sendJson(res, 200, { app: 'partymix', version: SERVER_VERSION, setup: userCount() > 0, engine: db.engine, node: process.version });
  });

  // ---- authentication ----
  r.on('POST', '/api/auth/setup', async ({ req, res }) => {
    const b = await readJson(req);
    const name = str(b.name, 'name', 60)!;
    const password = str(b.password, 'password', 200)!;
    if (password.length < 8) throw bad('La password deve avere almeno 8 caratteri');
    const dev = deviceInput(b);
    const out = tx(db, () => {
      if (userCount() > 0) throw new HttpError(409, 'ALREADY_SETUP', 'PartyMix sul NAS è già configurato: accedi');
      const id = Number(db.prepare('INSERT INTO user (name, pass_hash, created_at) VALUES (?, ?, ?)').run(name, hashPassword(password), now()).lastInsertRowid);
      return createDevice(db, id, dev.name, dev.kind, ALL_PERMS, now());
    });
    sendJson(res, 201, session(out.device, out.token));
  });

  r.on('POST', '/api/auth/login', async ({ req, res }) => {
    const addr = req.socket.remoteAddress ?? '';
    if (limiter.blocked(addr)) throw new HttpError(429, 'TOO_MANY', 'Troppi tentativi: riprova tra un minuto');
    const b = await readJson(req);
    const name = str(b.name, 'name', 60)!;
    const password = str(b.password, 'password', 200)!;
    const dev = deviceInput(b);
    const u = db.prepare('SELECT id, pass_hash FROM user WHERE name = ?').get(name) as { id: number; pass_hash: string } | undefined;
    if (!u || !verifyPassword(password, u.pass_hash)) {
      limiter.fail(addr);
      throw new HttpError(401, 'BAD_LOGIN', 'Nome o password sbagliati');
    }
    limiter.ok(addr);
    const out = createDevice(db, u.id, dev.name, dev.kind, defaultPerms(dev.kind, false), now());
    sendJson(res, 201, session(out.device, out.token));
  });

  /** A signed-in device asks for a code to show; the new device sends it to /api/auth/pair. */
  r.on('POST', '/api/auth/pair-code', ({ req, res, url }) => {
    const d = auth(req, url, 'ADMIN');
    sendJson(res, 201, pairing.create(d.user_id));
  });

  r.on('POST', '/api/auth/pair', async ({ req, res }) => {
    const addr = req.socket.remoteAddress ?? '';
    if (limiter.blocked(addr)) throw new HttpError(429, 'TOO_MANY', 'Troppi tentativi: riprova tra un minuto');
    const b = await readJson(req);
    const code = str(b.code, 'code', 6)!;
    const dev = deviceInput(b);
    const userId = /^\d{6}$/.test(code) ? pairing.take(code) : undefined;
    if (userId == null) {
      limiter.fail(addr);
      throw new HttpError(401, 'BAD_CODE', 'Codice sbagliato o scaduto');
    }
    const out = createDevice(db, userId, dev.name, dev.kind, defaultPerms(dev.kind, false), now());
    sendJson(res, 201, session(out.device, out.token));
  });

  r.on('POST', '/api/auth/logout', ({ req, res, url }) => {
    const d = auth(req, url);
    db.prepare('UPDATE device SET revoked_at = ? WHERE id = ?').run(now(), d.id);
    sendJson(res, 200, { ok: true });
  });

  r.on('GET', '/api/auth/me', ({ req, res, url }) => {
    const d = auth(req, url);
    const u = db.prepare('SELECT name FROM user WHERE id = ?').get(d.user_id) as { name: string };
    sendJson(res, 200, { device: deviceDoc(d, d), user: { name: u.name } });
  });

  // ---- devices ----
  r.on('GET', '/api/devices', ({ req, res, url }) => {
    const me = auth(req, url);
    const rows = db.prepare('SELECT id FROM device WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, last_seen DESC').all(me.user_id) as { id: string }[];
    sendJson(res, 200, rows.map((x) => deviceDoc(getDevice(db, x.id)!, me)));
  });

  r.on('PATCH', '/api/devices/:id', async ({ req, res, url, params }) => {
    const me = auth(req, url);
    const target = getDevice(db, params[0]);
    if (!target || target.user_id !== me.user_id) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo non trovato');
    const isAdmin = (me.perms & PERM.ADMIN) !== 0;
    if (target.id !== me.id && !isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Permesso mancante: ADMIN');
    const b = await readJson(req);
    const name = str(b.name, 'name', 60, false);
    let perms: number | undefined;
    if (b.perms !== undefined) {
      if (!isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Permesso mancante: ADMIN');
      perms = permMask(b.perms);
      if (perms === undefined) throw bad('perms non valido');
      if (target.id === me.id && (perms & PERM.ADMIN) === 0) throw bad('Non puoi togliere ADMIN al dispositivo che stai usando');
    }
    if (name) db.prepare('UPDATE device SET name = ? WHERE id = ?').run(name, target.id);
    if (perms !== undefined) db.prepare('UPDATE device SET perms = ? WHERE id = ?').run(perms, target.id);
    sendJson(res, 200, deviceDoc(getDevice(db, target.id)!, me));
  });

  r.on('DELETE', '/api/devices/:id', ({ req, res, url, params }) => {
    const me = auth(req, url);
    const target = getDevice(db, params[0]);
    if (!target || target.user_id !== me.user_id) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo non trovato');
    if (target.id !== me.id && (me.perms & PERM.ADMIN) === 0) throw new HttpError(403, 'FORBIDDEN', 'Permesso mancante: ADMIN');
    db.prepare('UPDATE device SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now(), target.id);
    sendJson(res, 200, deviceDoc(getDevice(db, target.id)!, me));
  });

  // ---- playlists ----
  r.on('GET', '/api/playlists', ({ req, res, url }) => {
    auth(req, url, 'READ_LIBRARY');
    sendJson(res, 200, playlists.list());
  });

  r.on('GET', '/api/playlists/:id', ({ req, res, url, params }) => {
    auth(req, url, 'READ_LIBRARY');
    const p = playlists.get(params[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Playlist non trovata');
    sendJson(res, 200, p);
  });

  r.on('GET', '/api/playlists/:id/revisions', ({ req, res, url, params }) => {
    auth(req, url, 'READ_LIBRARY');
    sendJson(res, 200, playlists.revisions(params[0]));
  });

  r.on('POST', '/api/playlists', async ({ req, res, url }) => {
    const d = auth(req, url, 'EDIT_PLAYLIST');
    const b = await readJson(req, 16 << 20);
    const meta = cleanMeta(b);
    const entries = Array.isArray(b.entries) ? b.entries.map(cleanEntry) : [];
    const id = str(b.id, 'id', 64, false);
    sendJson(res, 201, tx(db, () => playlists.create(meta, entries, d.id, id)));
  });

  /** Replace everything, only if the playlist is still at `baseVersion` (otherwise 409 with the current one). */
  r.on('PUT', '/api/playlists/:id', async ({ req, res, url, params }) => {
    const d = auth(req, url, 'EDIT_PLAYLIST');
    const b = await readJson(req, 16 << 20);
    const base = num(b.baseVersion, 'baseVersion', true)!;
    const doc = tx(db, () => {
      const cur = playlists.get(params[0], true);
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Playlist non trovata');
      if (cur.version !== base) throw new HttpError(409, 'VERSION_CONFLICT', 'La playlist è cambiata su un altro dispositivo', { current: cur });
      const meta = cleanMeta(b, cur);
      const entries = Array.isArray(b.entries) ? b.entries.map(cleanEntry) : cur.entries;
      return playlists.write(cur.id, meta, entries, d.id);
    });
    sendJson(res, 200, doc);
  });

  /**
   * What a device did since `baseVersion`, as operations. Applied as they are if nothing changed meanwhile; otherwise
   * merged with the other device's changes (see shared/merge.ts). Answers with the playlist as it is now, and the
   * fields that could not be merged (the current value stays; the device asks the user).
   */
  r.on('POST', '/api/playlists/:id/ops', async ({ req, res, url, params }) => {
    const d = auth(req, url, 'EDIT_PLAYLIST');
    const b = await readJson(req, 16 << 20);
    const base = num(b.baseVersion, 'baseVersion', true)!;
    let ops: Op[];
    try { ops = cleanOps(b.ops, cleanEntry); } catch (e) { throw e instanceof HttpError ? e : bad((e as Error).message); }
    const out = tx(db, () => {
      const cur = playlists.get(params[0], true);
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Playlist non trovata');
      if (cur.deleted) throw new HttpError(409, 'DELETED', 'La playlist è stata eliminata da un altro dispositivo', { current: cur });
      if (base > cur.version) throw bad('baseVersion non esiste');
      if (!ops.length) return { playlist: cur, merged: false, conflicts: [] as Conflict[] };
      let theirs: Op[] = [];
      if (cur.version !== base) {
        const old = playlists.revision(cur.id, base);
        if (!old) throw new HttpError(409, 'TOO_OLD', 'Versione troppo vecchia per unire le modifiche', { current: cur });
        theirs = diff(mergeView(old), mergeView(cur));
      }
      const m = apply(mergeView(cur), ops, theirs);
      const doc = playlists.write(cur.id, cleanMeta(m.meta as unknown as Record<string, unknown>, cur), m.entries, d.id);
      return { playlist: doc, merged: theirs.length > 0, conflicts: m.conflicts };
    });
    sendJson(res, 200, out);
  });

  r.on('DELETE', '/api/playlists/:id', ({ req, res, url, params }) => {
    const d = auth(req, url, 'EDIT_PLAYLIST');
    const version = tx(db, () => {
      const cur = playlists.get(params[0]);
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Playlist non trovata');
      const base = url.searchParams.get('baseVersion');
      if (base != null && Number(base) !== cur.version) throw new HttpError(409, 'VERSION_CONFLICT', 'La playlist è cambiata su un altro dispositivo', { current: cur });
      return playlists.remove(cur.id, d.id);
    });
    sendJson(res, 200, { ok: true, version });
  });

  // ---- tracks (files on the NAS) ----
  r.on('POST', '/api/tracks/check', async ({ req, res, url }) => {
    auth(req, url, 'READ_LIBRARY');
    const b = await readJson(req);
    sendJson(res, 200, tracks.check(b.sha256));
  });

  r.on('POST', '/api/tracks/upload', async ({ req, res, url }) => {
    const d = auth(req, url, 'UPLOAD_TRACK');
    const b = await readJson(req);
    const out = tracks.startUpload(d.id, b);
    sendJson(res, 'track' in out ? 200 : 201, out);
  });

  /** One piece of a file: Content-Range says which bytes; the last piece answers with the song. */
  r.on('PUT', '/api/uploads/:id', async ({ req, res, url, params }) => {
    const d = auth(req, url, 'UPLOAD_TRACK');
    const range = parseContentRange(req.headers['content-range']);
    if (range.to - range.from + 1 > MAX_CHUNK) throw new HttpError(413, 'TOO_LARGE', `Pezzi di al massimo ${MAX_CHUNK} byte`);
    const data = await readRaw(req, MAX_CHUNK);
    const out = await tracks.chunk(d.id, params[0], range.from, range.to, range.total, data);
    if (out.done) sendJson(res, 201, { track: out.track }); else sendJson(res, 200, { received: out.received });
  });

  r.on('GET', '/api/library', ({ req, res, url }) => {
    auth(req, url, 'READ_LIBRARY');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
    sendJson(res, 200, tracks.library(url.searchParams.get('cursor'), limit, (url.searchParams.get('q') ?? '').trim().slice(0, 100)));
  });

  r.on('GET', '/api/tracks/:id', ({ req, res, url, params }) => {
    auth(req, url, 'READ_LIBRARY');
    const t = tracks.get(params[0]);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Brano non trovato');
    sendJson(res, 200, t);
  });

  r.on('PATCH', '/api/tracks/:id', async ({ req, res, url, params }) => {
    auth(req, url, 'UPLOAD_TRACK');
    const b = await readJson(req);
    sendJson(res, 200, tracks.patch(params[0], b));
  });

  r.on('DELETE', '/api/tracks/:id', ({ req, res, url, params }) => {
    auth(req, url, 'DELETE_TRACK');
    sendJson(res, 200, tracks.remove(params[0]));
  });

  r.on('POST', '/api/tracks/:id/cover', async ({ req, res, url, params }) => {
    auth(req, url, 'UPLOAD_TRACK');
    const mime = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const data = await readRaw(req, 2 << 20);
    sendJson(res, 200, tracks.setCover(params[0], data, mime));
  });

  r.on('GET', '/api/tracks/:id/cover', ({ req, res, url, params }) => {
    auth(req, url, 'READ_LIBRARY');
    const c = tracks.cover(params[0]);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Nessuna copertina');
    if (req.headers['if-none-match'] === `"${c.sha}"`) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'content-type': c.mime, 'content-length': statSync(c.path).size, etag: `"${c.sha}"`, 'cache-control': 'private, max-age=86400' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(c.path).pipe(res);
  });

  // ---- sync ----
  r.on('GET', '/api/sync/status', ({ req, res, url }) => {
    const d = auth(req, url, 'READ_LIBRARY');
    sendJson(res, 200, {
      seq: currentSeq(db), tracks: tracks.count(), playlists: playlists.list().length,
      device: { lastSyncSeq: d.last_sync_seq }, serverVersion: SERVER_VERSION, at: now(),
    });
  });

  /** Everything changed after `since` (tombstones included), one page at a time. */
  r.on('GET', '/api/sync/changes', ({ req, res, url }) => {
    const d = auth(req, url, 'READ_LIBRARY');
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));
    const pls = playlists.changedSince(since, limit + 1).map((p) => ({ seq: p.seq, p }));
    const trs = tracks.changedSince(since, limit + 1).map((t) => ({ seq: t.seq, t }));
    const all = [...pls, ...trs].sort((a, b) => a.seq - b.seq);
    const more = all.length > limit;
    const page = all.slice(0, limit);
    const seq = page.length ? page[page.length - 1].seq : Math.max(since, currentSeq(db));
    const seqOut = more ? seq : Math.max(seq, currentSeq(db));
    db.prepare('UPDATE device SET last_sync_seq = ? WHERE id = ?').run(seqOut, d.id);
    const strip = <T extends { seq: number }>(x: T) => { const { seq: _s, ...rest } = x; return rest; };
    sendJson(res, 200, { seq: seqOut, more, tracks: page.filter((x) => 't' in x).map((x) => strip(x.t!)), playlists: page.filter((x) => 'p' in x).map((x) => strip(x.p!)) });
  });

  /** Server-Sent Events: a line for each change, so devices pull at once instead of polling. */
  r.on('GET', '/api/events', ({ req, res, url }) => {
    auth(req, url, 'READ_LIBRARY');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: currentSeq(db) })}\n\n`);
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); });
  });

  // ---- storage ----
  r.on('GET', '/api/storage', ({ req, res, url }) => {
    auth(req, url, 'READ_LIBRARY');
    const music = (db.prepare('SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM track WHERE deleted_at IS NULL').get() as { s: number; n: number });
    let free: number | null = null, total: number | null = null;
    try {
      const st = statfsSync(opts.root);
      free = st.bavail * st.bsize;
      total = st.blocks * st.bsize;
    } catch { /* not every file system answers */ }
    sendJson(res, 200, { musicBytes: music.s, tracks: music.n, freeBytes: free, totalBytes: total });
  });

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://partymix');
    void (async () => {
      try {
        // The app's page lives on localhost (Tauri) and calls the NAS from there: the browser asks the server first.
        const origin = req.headers.origin;
        if (origin && APP_ORIGIN.test(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('access-control-allow-headers', 'authorization, content-type, content-range');
          res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          res.setHeader('access-control-max-age', '600');
          res.setHeader('vary', 'origin');
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        }
        if (!opts.allowPublic && !isPrivateAddress(req.socket.remoteAddress)) {
          throw new HttpError(403, 'PUBLIC_DENIED', 'PartyMix sul NAS risponde solo alla rete di casa o alla VPN');
        }
        const m = r.match(req.method ?? 'GET', url.pathname);
        if (!m) throw new HttpError(404, 'NOT_FOUND', 'Indirizzo sconosciuto');
        if (m === 'method') throw new HttpError(405, 'METHOD', 'Metodo non permesso');
        await m.fn({ req, res, params: m.params, url });
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra });
        else {
          console.error(e);
          sendJson(res, 500, { error: 'INTERNAL', message: 'Errore interno del server' });
        }
      }
    })();
  };

  return {
    handle,
    db,
    close: () => {
      for (const l of listeners) l.end();
      listeners.clear();
      db.close();
    },
  };
}
