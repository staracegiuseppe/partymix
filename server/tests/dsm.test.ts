import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { dsmAdmins } from '../src/dsm.ts';

// a fake DSM: anna (administrator) and marco (normal user), lucia with two-step verification
const USERS: Record<string, string> = { anna: 'pw-anna', marco: 'pw-marco', lucia: 'pw-lucia', mario: 'pw-mario' };
let dsm: Server, dsmUrl = '', logouts = 0;
let root: string, app: App, server: Server, base: string;

before(async () => {
  dsm = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      if (q.get('method') === 'logout') { logouts++; res.end('{"success":true}'); return; }
      const name = q.get('account') ?? '';
      // like DSM: a normal user may not use the DSM desktop (unknown session), only File Station; «mario» may use nothing
      if (USERS[name] === q.get('passwd') && (name === 'marco' || name === 'mario') && (name === 'mario' || q.get('session') !== 'FileStation')) { res.end('{"success":false,"error":{"code":402}}'); return; }
      if (name === 'lucia' && q.get('passwd') === USERS.lucia) { res.end('{"success":false,"error":{"code":403}}'); return; }
      res.end(USERS[name] && USERS[name] === q.get('passwd') ? `{"success":true,"data":{"sid":"sid-${name}"}}` : '{"success":false,"error":{"code":400}}');
    });
  });
  await new Promise<void>((ok) => dsm.listen(0, '127.0.0.1', ok));
  dsmUrl = `http://127.0.0.1:${(dsm.address() as AddressInfo).port}/webapi/entry.cgi`;
  root = mkdtempSync(join(tmpdir(), 'partymix-dsm-'));
  const groups = join(root, 'group');
  writeFileSync(groups, 'users:x:100:\nadministrators:x:101:admin,anna\n');
  app = createApp({ root, db: await openDb(':memory:'), dsm: { url: dsmUrl, groupFile: groups } });
  server = createServer(app.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections(); server.close(); dsm.closeAllConnections(); dsm.close(); app.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const login = (name: string, password: string, kind = 'android') => call('POST', '/api/auth/login', { name, password, deviceName: `${name} ${kind}`, deviceKind: kind });

describe('accesso con gli utenti del NAS (DSM)', () => {
  test('il gruppo administrators da /etc/group', () => {
    const f = join(root, 'g2');
    writeFileSync(f, 'administrators:x:101:admin, Anna\n');
    assert.deepEqual([...dsmAdmins(f)], ['admin', 'anna']);
    assert.equal(dsmAdmins(join(root, 'nope')).size, 0);
  });

  test('health dice che si entra con gli utenti del NAS', async () => {
    assert.equal((await call('GET', '/api/health')).body.nasUsers, true);
  });

  test('anna (amministratore DSM): entra con la password del NAS e può tutto; la sessione DSM viene chiusa', async () => {
    const r = await login('anna', 'pw-anna', 'pc');
    assert.equal(r.status, 201);
    assert.equal(r.body.user.name, 'anna');
    assert.ok(r.body.device.perms.includes('ADMIN'));
    assert.ok(r.body.device.perms.includes('DELETE_TRACK'));
    await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(logouts >= 1);
  });

  test('marco (utente normale): entra, ascolta, carica e modifica le playlist, ma non cancella brani né gestisce dispositivi', async () => {
    const r = await login('marco', 'pw-marco', 'pc');
    assert.equal(r.status, 201);
    const p = r.body.device.perms as string[];
    for (const x of ['READ_LIBRARY', 'PLAY_TRACK', 'DOWNLOAD_TRACK', 'EDIT_PLAYLIST', 'UPLOAD_TRACK']) assert.ok(p.includes(x), x);
    assert.ok(!p.includes('ADMIN') && !p.includes('DELETE_TRACK'));
    // the playlists are the same for everyone
    const tok = r.body.token;
    const c = await call('POST', '/api/playlists', { id: 'p1', name: 'Festa', entries: [] }, tok);
    assert.equal(c.status, 201);
    const s = await login('anna', 'pw-anna', 'pc');
    assert.ok((await call('GET', '/api/playlists', undefined, s.body.token)).body.some((x: { id: string }) => x.id === 'p1'));
  });

  test('marco può collegare il suo telefono con un codice, che non riceve più permessi dei suoi', async () => {
    const r = await login('marco', 'pw-marco', 'pc');
    const code = (await call('POST', '/api/auth/pair-code', {}, r.body.token)).body.code;
    const ph = await call('POST', '/api/auth/pair', { code, deviceName: 'Telefono di Marco', deviceKind: 'android' });
    assert.equal(ph.status, 201);
    assert.ok(!ph.body.device.perms.includes('ADMIN'));
  });

  test('password sbagliata o utente sconosciuto: 401 con un messaggio che ricorda di usare l’utente del NAS', async () => {
    const r = await login('marco', 'sbagliata');
    assert.equal(r.status, 401);
    assert.match(r.body.message, /utente del NAS/);
    assert.equal((await login('nessuno', 'x')).status, 401);
  });

  test('un utente senza nessuna app del NAS: dice quale privilegio concedere in DSM', async () => {
    const r = await login('mario', 'pw-mario');
    assert.equal(r.status, 401);
    assert.match(r.body.message, /Privilegi applicazione/);
  });

  test('verifica in due passaggi: spiega di usare il codice a 6 cifre', async () => {
    const r = await login('lucia', 'pw-lucia');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'NEEDS_CODE');
    assert.match(r.body.message, /codice a 6 cifre/);
  });
});

describe('Start/End dei brani: personali per ogni utente del NAS', () => {
  test('anna e marco hanno ciascuno i propri: l’uno non vede né cambia quelli dell’altro', async () => {
    const anna = (await login('anna', 'pw-anna', 'pc')).body.token;
    const marco = (await login('marco', 'pw-marco', 'pc')).body.token;
    const annaTel = (await login('anna', 'pw-anna', 'android')).body.token;
    const put = await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: 42.3171, endTime: 228.65, title: '50 Special' }, anna);
    assert.equal(put.status, 200);
    assert.equal(put.body.cue.startTime, 42.317);
    // marco: niente, poi i suoi sullo stesso brano
    assert.deepEqual((await call('GET', '/api/cues', undefined, marco)).body.cues, []);
    await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: 5 }, marco);
    // il telefono di anna vede quelli di anna, non quelli di marco
    const tel = (await call('GET', '/api/cues', undefined, annaTel)).body.cues;
    assert.equal(tel.length, 1);
    assert.equal(tel[0].startTime, 42.317);
    assert.equal(tel[0].endTime, 228.65);
    // un file per brano nella cartella di ciascun utente
    const users = readdirSync(join(root, 'users'));
    const annaDir = users.find((u) => u.endsWith('-anna'))!, marcoDir = users.find((u) => u.endsWith('-marco'))!;
    const f = JSON.parse(readFileSync(join(root, 'users', annaDir, 'cues', 'b2GlV6Ap-3g.json'), 'utf8'));
    assert.equal(f.startTime, 42.317);
    assert.equal(f.user, 'anna');
    assert.equal(JSON.parse(readFileSync(join(root, 'users', marcoDir, 'cues', 'b2GlV6Ap-3g.json'), 'utf8')).startTime, 5);
    // seconda SET START: sostituisce
    await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: 51.8, endTime: 228.65 }, annaTel);
    assert.equal((await call('GET', '/api/cues', undefined, anna)).body.cues[0].startTime, 51.8);
    // Reset: tolto dal database e il file sparisce
    await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: null, endTime: null }, anna);
    assert.deepEqual((await call('GET', '/api/cues', undefined, anna)).body.cues, []);
    assert.equal(existsSync(join(root, 'users', annaDir, 'cues', 'b2GlV6Ap-3g.json')), false);
    assert.equal((await call('GET', '/api/cues', undefined, marco)).body.cues[0].startTime, 5);
  });

  test('valori non validi rifiutati; senza accesso: 401', async () => {
    const t = (await login('anna', 'pw-anna', 'pc')).body.token;
    assert.equal((await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: 180, endTime: 120 }, t)).status, 400);
    assert.equal((await call('PUT', '/api/cues/..%2Fpasswd', { startTime: 1 }, t)).status, 400);
    assert.equal((await call('PUT', '/api/cues/b2GlV6Ap-3g', { startTime: -1 }, t)).status, 400);
    assert.equal((await call('GET', '/api/cues')).status, 401);
  });
});
