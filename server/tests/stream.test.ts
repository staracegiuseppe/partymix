import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { parseRange } from '../src/stream.ts';
import { metaFromPath } from '../src/tracks.ts';

let root: string, app: App, server: Server, base: string;
let clock = 1_700_000_000_000;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'partymix-stream-'));
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
const bytes = (seed: number, size: number) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 255; return b; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const waitScan = async (token: string) => { for (let i = 0; i < 100; i++) { const s = await call('GET', '/api/scan', undefined, token); if (!s.body.running) return s.body; await new Promise((r) => setTimeout(r, 20)); } throw new Error('scan never ended'); };

let pc = '', phone = '', phoneId = '';
const fileA = bytes(1, 50_000), fileB = bytes(2, 30_000);
const idA = sha(fileA), idB = sha(fileB);

describe('nomi dei file copiati a mano', () => {
  test('Artista/Album/NN Titolo, Artista - Titolo, Titolo', () => {
    assert.deepEqual(metaFromPath('Dua Lipa/Future Nostalgia/02 Physical.mp3'), { title: 'Physical', artist: 'Dua Lipa', album: 'Future Nostalgia', trackNo: 2 });
    assert.deepEqual(metaFromPath('Pino Daniele - Napule è.mp3'), { title: 'Napule è', artist: 'Pino Daniele' });
    assert.deepEqual(metaFromPath('Liscio/03 - Romagna mia.flac'), { title: 'Romagna mia', artist: 'Liscio', trackNo: 3 });
    assert.deepEqual(metaFromPath('canzone.mp3'), { title: 'canzone' });
  });
  test('Range: inizio, fine, ultimi byte, fuori file', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
    assert.equal(parseRange('bytes=1000-', 1000), null);
    assert.equal(parseRange(undefined, 1000), undefined);
  });
});

describe('scansione e ascolto dal NAS', () => {
  test('account, telefono abbinato', async () => {
    pc = (await call('POST', '/api/auth/setup', { name: 'G', password: 'segreta123', deviceName: 'Mac', deviceKind: 'pc' })).body.token;
    const c = await call('POST', '/api/auth/pair-code', {}, pc);
    const r = await call('POST', '/api/auth/pair', { code: c.body.code, deviceName: 'Realme', deviceKind: 'android' });
    phone = r.body.token; phoneId = r.body.device.id;
  });

  test('file copiati in music/ entrano nella libreria; un doppione no; i file nascosti no', async () => {
    mkdirSync(join(root, 'music', 'Dua Lipa', 'Future Nostalgia'), { recursive: true });
    writeFileSync(join(root, 'music', 'Dua Lipa', 'Future Nostalgia', '02 Physical.mp3'), fileA);
    writeFileSync(join(root, 'music', 'Pino Daniele - Napule è.mp3'), fileB);
    writeFileSync(join(root, 'music', 'copia di Physical.mp3'), fileA);
    writeFileSync(join(root, 'music', 'note.txt'), 'non musica');
    mkdirSync(join(root, 'music', '@eaDir'), { recursive: true });
    writeFileSync(join(root, 'music', '@eaDir', 'thumb.mp3'), bytes(9, 100));
    assert.equal((await call('POST', '/api/scan', undefined, phone)).status, 202);
    const s = await waitScan(phone);
    assert.equal(s.last.found, 3);
    assert.equal(s.last.added, 2);
    assert.equal(s.last.duplicates, 1);
    const lib = await call('GET', '/api/library', undefined, phone);
    assert.deepEqual(lib.body.tracks.map((t: { title: string; artist?: string }) => `${t.title}|${t.artist}`), ['Napule è|Pino Daniele', 'Physical|Dua Lipa']);
    await call('POST', '/api/scan', undefined, pc);
    const s2 = await waitScan(pc);
    assert.equal(s2.last.added, 0);
  });

  test('link firmato: intero file, pezzo con 206, seek in fondo', async () => {
    const l = await call('GET', `/api/tracks/${idA}/link`, undefined, phone);
    assert.equal(l.status, 200);
    assert.match(l.body.path, new RegExp(`^/api/tracks/${idA}/stream\\?d=`));
    const all = await fetch(base + l.body.path);
    assert.equal(all.status, 200);
    assert.equal(all.headers.get('accept-ranges'), 'bytes');
    assert.equal(all.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await all.arrayBuffer()), fileA);
    const part = await fetch(base + l.body.path, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${fileA.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), fileA.subarray(100, 200));
    const end = await fetch(base + l.body.path, { headers: { range: `bytes=${fileA.length - 10}-` } });
    assert.equal(end.status, 206);
    assert.equal((await end.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(base + l.body.path, { headers: { range: `bytes=${fileA.length}-` } })).status, 416);
  });

  test('link: firma sbagliata, altro brano, scaduto → 401', async () => {
    const l = (await call('GET', `/api/tracks/${idA}/link`, undefined, phone)).body.path as string;
    assert.equal((await fetch(base + l.replace(/s=[^&]+/, 's=AAAA'))).status, 401);
    assert.equal((await fetch(base + l.replace(idA, idB))).status, 401);
    assert.equal((await fetch(`${base}/api/tracks/${idA}/stream`)).status, 401);
    clock += 16 * 60_000;
    assert.equal((await fetch(base + l)).status, 401);
  });

  test('con il token: ascolto e copia offline (dl=1 vuole DOWNLOAD_TRACK)', async () => {
    const r = await fetch(`${base}/api/tracks/${idB}/stream?dl=1`, { headers: { authorization: `Bearer ${phone}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), fileB);
    await call('PATCH', `/api/devices/${phoneId}`, { perms: ['READ_LIBRARY', 'PLAY_TRACK'] }, pc);
    assert.equal((await fetch(`${base}/api/tracks/${idB}/stream?dl=1`, { headers: { authorization: `Bearer ${phone}` } })).status, 403);
    assert.equal((await fetch(`${base}/api/tracks/${idB}/stream`, { headers: { authorization: `Bearer ${phone}` } })).status, 200);
  });

  test('dispositivo revocato: il suo link smette di funzionare subito', async () => {
    const l = (await call('GET', `/api/tracks/${idB}/link`, undefined, phone)).body.path as string;
    assert.equal((await fetch(base + l)).status, 200);
    assert.equal((await call('DELETE', `/api/devices/${phoneId}`, undefined, pc)).status, 200);
    assert.equal((await fetch(base + l)).status, 401);
  });

  test('brano che non c’è: 404', async () => {
    assert.equal((await call('GET', `/api/tracks/${'0'.repeat(64)}/link`, undefined, pc)).status, 404);
  });
});
