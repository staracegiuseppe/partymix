import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { isPrivateAddress } from '../src/http.ts';

let root: string, app: App, server: Server, base: string;
let clock = 1_700_000_000_000;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'partymix-test-'));
  app = createApp({ root, dbFile: ':memory:', now: () => clock });
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

let pc = '', phone = '';
let phoneId = '';

describe('autenticazione e dispositivi', () => {
  test('health prima della configurazione', async () => {
    const r = await call('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.setup, false);
  });

  test('setup crea utente e PC con tutti i permessi', async () => {
    const r = await call('POST', '/api/auth/setup', { name: 'Giuseppe', password: 'segreta123', deviceName: 'Mac', deviceKind: 'pc' });
    assert.equal(r.status, 201);
    assert.ok(r.body.token.length >= 40);
    assert.ok(r.body.device.perms.includes('ADMIN'));
    pc = r.body.token;
  });

  test('il secondo setup è rifiutato', async () => {
    const r = await call('POST', '/api/auth/setup', { name: 'Altro', password: 'segreta123', deviceName: 'X' });
    assert.equal(r.status, 409);
  });

  test('password non salvata in chiaro', () => {
    const row = app.db.prepare('SELECT pass_hash FROM user').get() as { pass_hash: string };
    assert.ok(row.pass_hash.startsWith('scrypt$'));
    assert.ok(!row.pass_hash.includes('segreta123'));
    const dev = app.db.prepare('SELECT token_hash FROM device').get() as { token_hash: string };
    assert.notEqual(dev.token_hash, pc);
  });

  test('senza token: 401', async () => {
    assert.equal((await call('GET', '/api/playlists')).status, 401);
    assert.equal((await call('GET', '/api/playlists', undefined, 'falso')).status, 401);
  });

  test('login sbagliato e blocco dopo 5 tentativi', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { name: 'Giuseppe', password: 'no', deviceName: 'X' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { name: 'Giuseppe', password: 'segreta123', deviceName: 'X' })).status, 429);
    clock += 61_000;
  });

  test('abbinamento del telefono con codice a 6 cifre', async () => {
    const c = await call('POST', '/api/auth/pair-code', {}, pc);
    assert.equal(c.status, 201);
    assert.match(c.body.code, /^\d{6}$/);
    const r = await call('POST', '/api/auth/pair', { code: c.body.code, deviceName: 'Realme', deviceKind: 'android' });
    assert.equal(r.status, 201);
    assert.ok(!r.body.device.perms.includes('ADMIN'));
    assert.ok(!r.body.device.perms.includes('DELETE_TRACK'));
    assert.ok(r.body.device.perms.includes('EDIT_PLAYLIST'));
    phone = r.body.token;
    phoneId = r.body.device.id;
    // one use only
    assert.equal((await call('POST', '/api/auth/pair', { code: c.body.code, deviceName: 'Altro' })).status, 401);
  });

  test('il codice scade dopo 5 minuti', async () => {
    const c = await call('POST', '/api/auth/pair-code', {}, pc);
    clock += 5 * 60_000 + 1;
    assert.equal((await call('POST', '/api/auth/pair', { code: c.body.code, deviceName: 'Tardi' })).status, 401);
  });

  test('il telefono non può creare codici né cambiare permessi', async () => {
    assert.equal((await call('POST', '/api/auth/pair-code', {}, phone)).status, 403);
    assert.equal((await call('PATCH', `/api/devices/${phoneId}`, { perms: ['ADMIN'] }, phone)).status, 403);
  });

  test('elenco, rinomina e permessi dispositivi', async () => {
    const l = await call('GET', '/api/devices', undefined, pc);
    assert.equal(l.body.length, 2);
    assert.equal(l.body.filter((d: { current: boolean }) => d.current).length, 1);
    const r = await call('PATCH', `/api/devices/${phoneId}`, { name: 'Telefono di Giuseppe' }, phone);
    assert.equal(r.body.name, 'Telefono di Giuseppe');
    const p = await call('PATCH', `/api/devices/${phoneId}`, { perms: ['READ_LIBRARY', 'PLAY_TRACK'] }, pc);
    assert.deepEqual(p.body.perms, ['READ_LIBRARY', 'PLAY_TRACK']);
    assert.equal((await call('POST', '/api/playlists', { name: 'X' }, phone)).status, 403);
    await call('PATCH', `/api/devices/${phoneId}`, { perms: ['READ_LIBRARY', 'PLAY_TRACK', 'DOWNLOAD_TRACK', 'EDIT_PLAYLIST', 'UPLOAD_TRACK'] }, pc);
  });
});

describe('playlist', () => {
  let id = '';
  const A = { youtubeId: 'aaaaaaaaaaa', title: 'Song A' };
  const B = { youtubeId: 'bbbbbbbbbbb', title: 'Song B' };
  const C = { trackId: 'c'.repeat(64), title: 'Song C', artist: 'Artist C' };

  test('creata sul PC, vista dal telefono', async () => {
    const r = await call('POST', '/api/playlists', { name: 'Palestra', entries: [A, B, C] }, pc);
    assert.equal(r.status, 201);
    assert.equal(r.body.version, 1);
    assert.equal(r.body.entries.length, 3);
    id = r.body.id;
    const l = await call('GET', '/api/playlists', undefined, phone);
    assert.equal(l.body[0].name, 'Palestra');
    assert.equal(l.body[0].count, 3);
    assert.equal(l.body[0].updatedByName, 'Mac');
    const g = await call('GET', `/api/playlists/${id}`, undefined, phone);
    assert.deepEqual(g.body.entries.map((e: { title: string }) => e.title), ['Song A', 'Song B', 'Song C']);
  });

  test('copia JSON leggibile sul NAS', () => {
    const doc = JSON.parse(readFileSync(join(root, 'playlists', `${id}.json`), 'utf8'));
    assert.equal(doc.name, 'Palestra');
  });

  test('il telefono aggiunge un brano: versione 2, updatedBy telefono', async () => {
    const cur = (await call('GET', `/api/playlists/${id}`, undefined, phone)).body;
    const r = await call('PUT', `/api/playlists/${id}`, { baseVersion: 1, entries: [...cur.entries, { youtubeId: 'ddddddddddd', title: 'Song D' }] }, phone);
    assert.equal(r.status, 200);
    assert.equal(r.body.version, 2);
    assert.equal(r.body.updatedBy, phoneId);
    assert.equal(r.body.entries.length, 4);
    assert.equal(r.body.name, 'Palestra');
  });

  test('scrittura da versione vecchia: 409 con la versione attuale, nulla sovrascritto', async () => {
    const r = await call('PUT', `/api/playlists/${id}`, { baseVersion: 1, entries: [A] }, pc);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'VERSION_CONFLICT');
    assert.equal(r.body.current.version, 2);
    assert.equal((await call('GET', `/api/playlists/${id}`, undefined, pc)).body.entries.length, 4);
  });

  test('riga non valida rifiutata', async () => {
    assert.equal((await call('POST', '/api/playlists', { name: 'X', entries: [{ title: 'senza brano' }] }, pc)).status, 400);
    assert.equal((await call('POST', '/api/playlists', { name: 'X', entries: [{ trackId: 'non-sha' }] }, pc)).status, 400);
    assert.equal((await call('POST', '/api/playlists', { name: '' }, pc)).status, 400);
  });

  test('versioni precedenti conservate', async () => {
    const r = await call('GET', `/api/playlists/${id}/revisions`, undefined, pc);
    assert.deepEqual(r.body.map((x: { version: number }) => x.version), [2, 1]);
  });

  test('modifiche incrementali da un seq', async () => {
    const all = await call('GET', '/api/sync/changes?since=0', undefined, phone);
    assert.equal(all.body.playlists.length, 1);
    const seq = all.body.seq;
    const none = await call('GET', `/api/sync/changes?since=${seq}`, undefined, phone);
    assert.equal(none.body.playlists.length, 0);
    await call('POST', '/api/playlists', { name: 'Party' }, pc);
    const one = await call('GET', `/api/sync/changes?since=${seq}`, undefined, phone);
    assert.deepEqual(one.body.playlists.map((p: { name: string }) => p.name), ['Party']);
  });

  test('paginazione delle modifiche', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/playlists', { name: `P${i}` }, pc);
    let since = 0, pages = 0, seen = 0, more = true;
    while (more) {
      const r = await call('GET', `/api/sync/changes?since=${since}&limit=2`, undefined, phone);
      seen += r.body.playlists.length;
      since = r.body.seq;
      more = r.body.more;
      pages++;
    }
    assert.equal(seen, 7);
    assert.equal(pages, 4);
  });

  test('eliminazione: tombstone nei delta', async () => {
    const before = (await call('GET', '/api/sync/status', undefined, pc)).body.seq;
    assert.equal((await call('DELETE', `/api/playlists/${id}`, undefined, phone)).status, 200);
    assert.equal((await call('GET', `/api/playlists/${id}`, undefined, pc)).status, 404);
    const d = await call('GET', `/api/sync/changes?since=${before}`, undefined, pc);
    assert.equal(d.body.playlists[0].deleted, true);
  });

  test('evento SSE quando una playlist cambia', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events?token=${phone}`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    const read = async (until: string) => {
      while (!text.includes(until)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await read('event: hello');
    await call('POST', '/api/playlists', { name: 'Notifica' }, pc);
    await read('Notifica');
    assert.match(text, /event: change/);
    ctrl.abort();
  });
});

describe('revoca e stato', () => {
  test('spazio di archiviazione', async () => {
    const r = await call('GET', '/api/storage', undefined, pc);
    assert.equal(r.body.musicBytes, 0);
    assert.ok(r.body.freeBytes > 0);
  });

  test('dispositivo revocato non entra più', async () => {
    assert.equal((await call('DELETE', `/api/devices/${phoneId}`, undefined, pc)).status, 200);
    assert.equal((await call('GET', '/api/playlists', undefined, phone)).status, 401);
    const l = await call('GET', '/api/devices', undefined, pc);
    assert.equal(l.body.find((d: { id: string }) => d.id === phoneId).revoked, true);
  });

  test('logout revoca il token', async () => {
    const r = await call('POST', '/api/auth/login', { name: 'giuseppe', password: 'segreta123', deviceName: 'iPad', deviceKind: 'ios' });
    assert.equal(r.status, 201);
    const t = r.body.token;
    assert.equal((await call('POST', '/api/auth/logout', {}, t)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, t)).status, 401);
  });
});

describe('solo rete privata', () => {
  test('indirizzi privati e VPN accettati, pubblici no', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.102.103', 'fd7a:115c:a1e0::1'])
      assert.equal(isPrivateAddress(a), true, a);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::1', '', undefined])
      assert.equal(isPrivateAddress(a), false, String(a));
  });
});
