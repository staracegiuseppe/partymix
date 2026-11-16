import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { safeName } from '../src/tracks.ts';

let root: string, app: App, server: Server, base: string;
let clock = 1_700_000_000_000;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'partymix-tracks-'));
  app = createApp({ root, db: await openDb(':memory:'), now: () => clock });
  server = createServer(app.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function put(id: string, bytes: Uint8Array, from: number, to: number, total: number, token: string) {
  const res = await fetch(`${base}/api/uploads/${id}`, {
    method: 'PUT', body: bytes.subarray(from, to + 1) as unknown as BodyInit,
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${from}-${to}/${total}`, authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fakeMp3(seed: number, size = 10_000): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 255; }
  return out;
}
const meta = (title: string, extra: Record<string, unknown> = {}) => ({ title, artist: 'Dua Lipa', album: 'Future Nostalgia', trackNo: 2, durationSec: 203, ...extra });

let pc = '', phone = '';
const fileA = fakeMp3(1, 10_000);
const shaA = sha(fileA);

describe('upload dei brani', () => {
  test('setup e telefono senza UPLOAD_TRACK', async () => {
    pc = (await call('POST', '/api/auth/setup', { name: 'G', password: 'segreta123', deviceName: 'Mac', deviceKind: 'pc' })).body.token;
    const c = await call('POST', '/api/auth/pair-code', {}, pc);
    const r = await call('POST', '/api/auth/pair', { code: c.body.code, deviceName: 'Realme', deviceKind: 'android' });
    phone = r.body.token;
    const dev = r.body.device.id;
    await call('PATCH', `/api/devices/${dev}`, { perms: ['READ_LIBRARY', 'PLAY_TRACK'] }, pc);
  });

  test('check: tutto mancante all’inizio; sha non valido rifiutato', async () => {
    const r = await call('POST', '/api/tracks/check', { sha256: [shaA] }, pc);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { present: [], missing: [shaA] });
    assert.equal((await call('POST', '/api/tracks/check', { sha256: ['xyz'] }, pc)).status, 400);
  });

  test('senza permesso UPLOAD_TRACK: 403', async () => {
    const r = await call('POST', '/api/tracks/upload', { sha256: shaA, size: fileA.length, mime: 'audio/mpeg', meta: meta('Physical') }, phone);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'FORBIDDEN');
  });

  test('upload a pezzi in ordine, poi il brano è nella libreria con il file giusto', async () => {
    const start = await call('POST', '/api/tracks/upload', { sha256: shaA, size: fileA.length, mime: 'audio/mpeg', meta: meta('Physical') }, pc);
    assert.equal(start.status, 201);
    assert.equal(start.body.received, 0);
    const id = start.body.uploadId;
    const p1 = await put(id, fileA, 0, 3999, fileA.length, pc);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.received, 4000);
    const p2 = await put(id, fileA, 4000, 9999, fileA.length, pc);
    assert.equal(p2.status, 201);
    assert.equal(p2.body.track.id, shaA);
    assert.equal(p2.body.track.artist, 'Dua Lipa');
    assert.equal(p2.body.track.album, 'Future Nostalgia');
    assert.equal(p2.body.track.size, fileA.length);
    const file = join(root, 'music', 'Dua Lipa', 'Future Nostalgia', '02 Physical.mp3');
    assert.ok(existsSync(file));
    assert.equal(readdirSync(join(root, 'cache', 'uploads')).length, 0);
    const got = await call('GET', `/api/tracks/${shaA}`, undefined, phone);
    assert.equal(got.status, 200);
    assert.equal(got.body.title, 'Physical');
    assert.equal(got.body.hasCover, false);
  });

  test('dedup: lo stesso file non si carica due volte', async () => {
    const chk = await call('POST', '/api/tracks/check', { sha256: [shaA, sha(fakeMp3(9))] }, pc);
    assert.deepEqual(chk.body.present, [shaA]);
    const r = await call('POST', '/api/tracks/upload', { sha256: shaA, size: fileA.length, mime: 'audio/mpeg', meta: meta('Physical') }, pc);
    assert.equal(r.status, 200);
    assert.equal(r.body.track.id, shaA);
    assert.equal(r.body.uploadId, undefined);
  });

  test('hash sbagliato: file scartato (422 CORRUPT_FILE)', async () => {
    const bad = fakeMp3(2, 5000);
    const claimed = sha(fakeMp3(3, 5000));
    const start = await call('POST', '/api/tracks/upload', { sha256: claimed, size: bad.length, mime: 'audio/mpeg', meta: meta('Rotto') }, pc);
    const r = await put(start.body.uploadId, bad, 0, 4999, bad.length, pc);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'CORRUPT_FILE');
    assert.equal(readdirSync(join(root, 'cache', 'uploads')).length, 0);
    assert.equal((await call('GET', `/api/tracks/${claimed}`, undefined, pc)).status, 404);
    // the upload row is gone too: a new attempt starts from zero
    const again = await call('POST', '/api/tracks/upload', { sha256: claimed, size: bad.length, mime: 'audio/mpeg', meta: meta('Rotto') }, pc);
    assert.equal(again.status, 201);
    assert.equal(again.body.received, 0);
  });

  test('pezzo fuori ordine rifiutato con received; ripresa dopo interruzione', async () => {
    const f = fakeMp3(4, 12_000);
    const s = sha(f);
    const start = await call('POST', '/api/tracks/upload', { sha256: s, size: f.length, mime: 'audio/mp4', ext: 'm4a', meta: meta('Levitating', { trackNo: 5 }) }, pc);
    const id = start.body.uploadId;
    assert.equal((await put(id, f, 0, 4999, f.length, pc)).status, 200);
    // "the connection dropped": the device asks again and learns where to resume from
    const resume = await call('POST', '/api/tracks/upload', { sha256: s, size: f.length, mime: 'audio/mp4', ext: 'm4a', meta: meta('Levitating') }, pc);
    assert.equal(resume.status, 201);
    assert.equal(resume.body.uploadId, id);
    assert.equal(resume.body.received, 5000);
    // wrong piece: 409 and nothing written
    const wrong = await put(id, f, 8000, 11_999, f.length, pc);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'OUT_OF_ORDER');
    assert.equal(wrong.body.received, 5000);
    // a piece repeated after a lost answer: also 409 with received, the device skips ahead
    assert.equal((await put(id, f, 0, 4999, f.length, pc)).status, 409);
    const last = await put(id, f, 5000, 11_999, f.length, pc);
    assert.equal(last.status, 201);
    assert.equal(last.body.track.id, s);
    assert.ok(existsSync(join(root, 'music', 'Dua Lipa', 'Future Nostalgia', '05 Levitating.m4a')));
  });

  test('Content-Range mancante, totale sbagliato, pezzo troppo grande', async () => {
    const f = fakeMp3(5, 3000);
    const start = await call('POST', '/api/tracks/upload', { sha256: sha(f), size: f.length, mime: 'audio/mpeg', meta: meta('X') }, pc);
    const id = start.body.uploadId;
    const noRange = await fetch(`${base}/api/uploads/${id}`, { method: 'PUT', body: f as unknown as BodyInit, headers: { authorization: `Bearer ${pc}` } });
    assert.equal(noRange.status, 400);
    assert.equal((await put(id, f, 0, 2999, 4000, pc)).status, 400);
    const big = await fetch(`${base}/api/uploads/${id}`, { method: 'PUT', body: new Uint8Array(10) as unknown as BodyInit, headers: { authorization: `Bearer ${pc}`, 'content-range': `bytes 0-${(9 << 20) - 1}/${20 << 20}` } });
    assert.equal(big.status, 413);
    // the other device cannot write into this upload
    assert.equal((await put(id, f, 0, 2999, f.length, phone)).status, 403);
  });

  test('nomi sicuri e collisione di nome', async () => {
    assert.equal(safeName('AC/DC: Back in Black?', 'x'), 'AC DC Back in Black');
    assert.equal(safeName('...', 'Brano'), 'Brano');
    const f = fakeMp3(6, 2000);
    const start = await call('POST', '/api/tracks/upload', { sha256: sha(f), size: f.length, mime: 'audio/mpeg', meta: meta('Physical') }, pc);
    const r = await put(start.body.uploadId, f, 0, 1999, f.length, pc);
    assert.equal(r.status, 201);
    assert.ok(existsSync(join(root, 'music', 'Dua Lipa', 'Future Nostalgia', '02 Physical (2).mp3')));
  });

  test('copertina: salvata una volta per impronta, servita con etag', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const r = await fetch(`${base}/api/tracks/${shaA}/cover`, { method: 'POST', body: png as unknown as BodyInit, headers: { authorization: `Bearer ${pc}`, 'content-type': 'image/png' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).hasCover, true);
    assert.ok(existsSync(join(root, 'covers', `${sha(png)}.png`)));
    const g = await fetch(`${base}/api/tracks/${shaA}/cover`, { headers: { authorization: `Bearer ${phone}` } });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await g.arrayBuffer()), png);
    const again = await fetch(`${base}/api/tracks/${shaA}/cover`, { headers: { authorization: `Bearer ${phone}`, 'if-none-match': g.headers.get('etag')! } });
    assert.equal(again.status, 304);
    const tooBig = await fetch(`${base}/api/tracks/${shaA}/cover`, { method: 'POST', body: new Uint8Array(3 << 20) as unknown as BodyInit, headers: { authorization: `Bearer ${pc}`, 'content-type': 'image/jpeg' } });
    assert.equal(tooBig.status, 413);
  });

  test('metadata modificabili, meta_version cresce', async () => {
    const r = await call('PATCH', `/api/tracks/${shaA}`, { meta: { title: 'Physical (Remix)', genre: 'Pop', year: 2020 } }, pc);
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'Physical (Remix)');
    assert.equal(r.body.genre, 'Pop');
    assert.equal(r.body.year, 2020);
    assert.equal(r.body.metaVersion, 2);
    assert.equal(r.body.artist, 'Dua Lipa');
    assert.equal((await call('PATCH', `/api/tracks/${shaA}`, { meta: { year: 'ieri' } }, pc)).status, 400);
    assert.equal((await call('PATCH', `/api/tracks/${shaA}`, { meta: { title: 'x' } }, phone)).status, 403);
  });

  test('libreria paginata e cercabile', async () => {
    const p1 = await call('GET', '/api/library?limit=2', undefined, phone);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.tracks.length, 2);
    assert.ok(p1.body.next);
    const p2 = await call('GET', `/api/library?limit=2&cursor=${encodeURIComponent(p1.body.next)}`, undefined, phone);
    assert.equal(p2.body.tracks.length, 1); // Physical, Levitating, Physical (2): the corrupt and the unfinished ones are not songs
    assert.equal(p2.body.next, undefined);
    const ids = [...p1.body.tracks, ...p2.body.tracks].map((t: { id: string }) => t.id);
    assert.equal(new Set(ids).size, 3);
    const titles = [...p1.body.tracks, ...p2.body.tracks].map((t: { title: string }) => t.title);
    assert.deepEqual(titles, [...titles].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    const q = await call('GET', '/api/library?q=levit', undefined, phone);
    assert.equal(q.body.tracks.length, 1);
    assert.equal(q.body.tracks[0].title, 'Levitating');
    assert.equal((await call('GET', '/api/library?cursor=%%%', undefined, phone)).status, 400);
  });

  test('delta: i brani cambiati arrivano con le playlist, in ordine di seq', async () => {
    const before = (await call('GET', '/api/sync/status', undefined, pc)).body.seq;
    await call('POST', '/api/playlists', { name: 'Festa', entries: [{ trackId: shaA, title: 'Physical' }] }, pc);
    await call('PATCH', `/api/tracks/${shaA}`, { meta: { genre: 'Dance' } }, pc);
    const d = await call('GET', `/api/sync/changes?since=${before}`, undefined, phone);
    assert.equal(d.status, 200);
    assert.equal(d.body.playlists.length, 1);
    assert.equal(d.body.tracks.length, 1);
    assert.equal(d.body.tracks[0].genre, 'Dance');
    assert.equal(d.body.more, false);
    // page by page across both kinds
    const all = await call('GET', '/api/sync/changes?since=0&limit=2', undefined, phone);
    assert.equal(all.body.more, true);
    assert.equal(all.body.tracks.length + all.body.playlists.length, 2);
    const rest = await call('GET', `/api/sync/changes?since=${all.body.seq}&limit=100`, undefined, phone);
    assert.equal(rest.body.more, false);
    const seen = [...all.body.tracks, ...all.body.playlists, ...rest.body.tracks, ...rest.body.playlists].map((x: { id: string }) => x.id);
    assert.equal(seen.length, 4); // 3 songs + 1 playlist, each once
    assert.equal(new Set(seen).size, 4);
  });

  test('eliminazione: solo con DELETE_TRACK, tombstone nei delta, file nel cestino', async () => {
    assert.equal((await call('DELETE', `/api/tracks/${shaA}`, undefined, phone)).status, 403);
    const before = (await call('GET', '/api/sync/status', undefined, pc)).body.seq;
    const r = await call('DELETE', `/api/tracks/${shaA}`, undefined, pc);
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(existsSync(join(root, 'cache', 'trash', `${shaA}.mp3`)));
    assert.ok(!existsSync(join(root, 'music', 'Dua Lipa', 'Future Nostalgia', '02 Physical.mp3')));
    assert.equal((await call('GET', `/api/tracks/${shaA}`, undefined, pc)).status, 404);
    const d = await call('GET', `/api/sync/changes?since=${before}`, undefined, pc);
    assert.equal(d.body.tracks[0].deleted, true);
    assert.deepEqual((await call('POST', '/api/tracks/check', { sha256: [shaA] }, pc)).body.missing, [shaA]);
    // sent again later: it comes back
    const start = await call('POST', '/api/tracks/upload', { sha256: shaA, size: fileA.length, mime: 'audio/mpeg', meta: meta('Physical') }, pc);
    assert.equal(start.status, 201);
    const back = await put(start.body.uploadId, fileA, 0, 9999, fileA.length, pc);
    assert.equal(back.status, 201);
    assert.equal(back.body.track.deleted, undefined);
  });

  test('pulizia all’avvio: .part più vecchi di 7 giorni', () => {
    const dir = join(root, 'cache', 'uploads');
    writeFileSync(join(dir, 'old.part'), 'x');
    const old = new Date(clock - 8 * 86_400_000);
    utimesSync(join(dir, 'old.part'), old, old);
    writeFileSync(join(dir, 'new.part'), 'x');
    const app2 = createApp({ root, dbFile: ':memory:', now: () => clock });
    app2.close();
    assert.ok(!existsSync(join(dir, 'old.part')));
    assert.ok(existsSync(join(dir, 'new.part')));
  });
});
