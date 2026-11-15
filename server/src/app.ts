import { mkdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DeviceDoc, PlaylistDoc, ServerEvent, SessionDoc } from '../../shared/model.ts';
import {
  ALL_PERMS, createDevice, defaultPerms, DEVICE_KINDS, deviceForToken, getDevice, hashPassword, LoginLimiter, PairingCodes,
  PERM, permMask, permNames, verifyPassword, type Device, type DeviceKind, type PermName,
} from './auth.ts';
import { currentSeq, openDb, tx, type Db } from './db.ts';
import { bad, HttpError, isPrivateAddress, num, readJson, Router, sendJson, str } from './http.ts';
import { cleanEntry, cleanMeta, Playlists } from './playlists.ts';

export const SERVER_VERSION = '0.1.0';

export type AppOptions = {
  /** The PartyMix folder on the NAS (music/, playlists/, database/…). */
  root: string;
  /** ':memory:' in tests. Default: <root>/database/partymix.sqlite */
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

const FOLDERS = ['music', 'playlists', 'covers', 'metadata', 'database', 'cache', 'cache/uploads'];

export function createApp(opts: AppOptions): App {
  const now = opts.now ?? Date.now;
  for (const f of FOLDERS) mkdirSync(join(opts.root, f), { recursive: true });
  const db = openDb(opts.dbFile ?? join(opts.root, 'database', 'partymix.sqlite'));
  const playlists = new Playlists(db, now);
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
    sendJson(res, 200, { app: 'partymix', version: SERVER_VERSION, setup: userCount() > 0 });
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

  // ---- sync ----
  r.on('GET', '/api/sync/status', ({ req, res, url }) => {
    const d = auth(req, url, 'READ_LIBRARY');
    const tracks = (db.prepare('SELECT COUNT(*) AS n FROM track WHERE deleted_at IS NULL').get() as { n: number }).n;
    sendJson(res, 200, {
      seq: currentSeq(db), tracks, playlists: playlists.list().length,
      device: { lastSyncSeq: d.last_sync_seq }, serverVersion: SERVER_VERSION, at: now(),
    });
  });

  /** Everything changed after `since` (tombstones included), one page at a time. */
  r.on('GET', '/api/sync/changes', ({ req, res, url }) => {
    const d = auth(req, url, 'READ_LIBRARY');
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));
    const pls = playlists.changedSince(since, limit + 1);
    const more = pls.length > limit;
    const page = pls.slice(0, limit);
    const seq = page.length ? page[page.length - 1].seq : Math.max(since, currentSeq(db));
    const seqOut = more ? seq : Math.max(seq, currentSeq(db));
    db.prepare('UPDATE device SET last_sync_seq = ? WHERE id = ?').run(seqOut, d.id);
    sendJson(res, 200, { seq: seqOut, more, tracks: [], playlists: page.map(({ seq: _s, ...p }) => p) });
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
