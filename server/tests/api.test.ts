import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { isPrivateAddress } from '../src/http.ts';

let root: string, app: App, server: Server, base: string;
let clock = 1_700_000_000_000;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'partymix-test-'));
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

let pc = '', phone = '';
let phoneId = '';
const pc_ = () => pc;

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

  test('il telefono può creare un codice (il nuovo dispositivo avrà al massimo i suoi permessi), ma non cambiare permessi', async () => {
    assert.equal((await call('POST', '/api/auth/pair-code', {}, phone)).status, 201);
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

  test('operazioni da due dispositivi partiti dalla stessa versione: unite', async () => {
    // version 2: A B C D. Phone (offline) removes B and adds X after A; PC meanwhile adds E at the end.
    const pc = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 2, ops: [{ op: 'add', entry: { youtubeId: 'eeeeeeeeeee', title: 'Song E' }, after: ['ddddddddddd'] }] }, pc_());
    assert.equal(pc.status, 200);
    assert.equal(pc.body.merged, false);
    assert.equal(pc.body.playlist.version, 3);
    const ph = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 2, ops: [
      { op: 'remove', entryId: 'bbbbbbbbbbb' },
      { op: 'add', entry: { entryId: 'xxxxxxxxxxx', youtubeId: 'xxxxxxxxxxx', title: 'Song X' }, after: ['aaaaaaaaaaa'] },
    ] }, phone);
    assert.equal(ph.status, 200);
    assert.equal(ph.body.merged, true);
    assert.deepEqual(ph.body.conflicts, []);
    assert.equal(ph.body.playlist.version, 4);
    assert.deepEqual(ph.body.playlist.entries.map((e: { title: string }) => e.title), ['Song A', 'Song X', 'Song C', 'Song D', 'Song E']);
  });

  test('stesso nome cambiato in due modi: conflitto riportato, nulla perso', async () => {
    const a = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 4, ops: [{ op: 'set', field: 'name', value: 'Festa', was: 'Palestra' }] }, pc_());
    assert.equal(a.body.playlist.name, 'Festa');
    const b = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 4, ops: [{ op: 'set', field: 'name', value: 'Gym', was: 'Palestra' }, { op: 'set', field: 'color', value: '#f00', was: undefined }] }, phone);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.conflicts, [{ field: 'name', mine: 'Gym', theirs: 'Festa' }]);
    assert.equal(b.body.playlist.name, 'Festa');
    assert.equal(b.body.playlist.color, '#f00');
    assert.equal(b.body.playlist.version, 6);
  });

  test('operazioni non valide o versione inesistente', async () => {
    assert.equal((await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 6, ops: [{ op: 'boom' }] }, phone)).status, 400);
    assert.equal((await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 99, ops: [] }, phone)).status, 400);
    assert.equal((await call('POST', `/api/playlists/${id}/ops`, { ops: [] }, phone)).status, 400);
  });

  test('riga con un file solo locale (non ancora sul NAS)', async () => {
    const r = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: 6, ops: [{ op: 'add', entry: { entryId: 'local:0123abcd', localId: 'local:0123abcd', title: 'Mio MP3' }, after: [] }] }, pc_());
    assert.equal(r.status, 200);
    assert.equal(r.body.playlist.entries[0].localId, 'local:0123abcd');
    assert.equal(r.body.playlist.entries[0].youtubeId, undefined);
  });

  test('riga non valida rifiutata', async () => {
    assert.equal((await call('POST', '/api/playlists', { name: 'X', entries: [{ title: 'senza brano' }] }, pc)).status, 400);
    assert.equal((await call('POST', '/api/playlists', { name: 'X', entries: [{ trackId: 'non-sha' }] }, pc)).status, 400);
    assert.equal((await call('POST', '/api/playlists', { name: '' }, pc)).status, 400);
  });

  test('versioni precedenti conservate', async () => {
    const r = await call('GET', `/api/playlists/${id}/revisions`, undefined, pc);
    const vs = r.body.map((x: { version: number }) => x.version);
    assert.equal(vs[0], (await call('GET', `/api/playlists/${id}`, undefined, pc)).body.version);
    assert.ok(vs.includes(1));
    assert.deepEqual(vs, [...vs].sort((a: number, b: number) => b - a));
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

  test('eliminazione: tombstone nei delta; modifiche su una playlist eliminata = conflitto', async () => {
    const before = (await call('GET', '/api/sync/status', undefined, pc)).body.seq;
    const v = (await call('GET', `/api/playlists/${id}`, undefined, pc)).body.version;
    assert.equal((await call('DELETE', `/api/playlists/${id}`, undefined, phone)).status, 200);
    assert.equal((await call('GET', `/api/playlists/${id}`, undefined, pc)).status, 404);
    const d = await call('GET', `/api/sync/changes?since=${before}`, undefined, pc);
    assert.equal(d.body.playlists[0].deleted, true);
    const o = await call('POST', `/api/playlists/${id}/ops`, { baseVersion: v, ops: [{ op: 'set', field: 'name', value: 'Z', was: 'Festa' }] }, pc);
    assert.equal(o.status, 409);
    assert.equal(o.body.error, 'DELETED');
    // the user chooses to keep it: a PUT on the deleted version brings it back
    const back = await call('PUT', `/api/playlists/${id}`, { baseVersion: o.body.current.version, name: 'Z' }, pc);
    assert.equal(back.status, 200);
    assert.equal(back.body.deleted, undefined);
    assert.equal((await call('GET', `/api/playlists/${id}`, undefined, phone)).body.name, 'Z');
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

describe('CORS per l’app su localhost', () => {
  test('preflight e intestazioni solo per origini dell’app', async () => {
    const pre = await fetch(`${base}/api/playlists`, { method: 'OPTIONS', headers: { origin: 'http://localhost:9527', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:9527');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
    const ok = await fetch(`${base}/api/health`, { headers: { origin: 'tauri://localhost' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'tauri://localhost');
    const no = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
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
