import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';

/**
 * Signing in with the NAS's own users (Synology DSM): everyone who has an account on the NAS can use PartyMix with
 * the same name and password. PartyMix never keeps those passwords: it asks DSM on the NAS itself (SYNO.API.Auth on
 * 127.0.0.1) whether they are right, then closes that DSM session at once. Members of DSM's «administrators» group
 * become PartyMix administrators (delete songs, manage every device); the others can listen, upload and edit the
 * shared playlists.
 */

/** How PartyMix shows itself to DSM: first as itself, then as the NAS apps a normal user is usually allowed to use. */
const SESSIONS = ['PartyMix', 'FileStation', 'AudioStation', 'VideoStation', 'DownloadStation'];

export type DsmCheck = { ok: true; admin: boolean } | { ok: false; reason: 'wrong' | 'otp' | 'disabled' | 'unreachable'; message: string };

export type DsmOptions = {
  /** DSM's web API on the NAS itself, e.g. http://127.0.0.1:5000/webapi/entry.cgi. Undefined = not a Synology. */
  url?: string;
  /** Where the system groups are (to know who is in «administrators»). */
  groupFile?: string;
  fetch?: typeof fetch;
};

/** On a Synology the DSM API answers on port 5000 of the NAS itself; elsewhere (Docker on another box, tests) only if set. */
export function dsmFromEnv(env: NodeJS.ProcessEnv = process.env): DsmOptions {
  if (env.PARTYMIX_DSM === '0') return {};
  const url = env.PARTYMIX_DSM_URL || (existsSync('/etc/synoinfo.conf') ? 'http://127.0.0.1:5000/webapi/entry.cgi' : undefined);
  return { url, groupFile: env.PARTYMIX_GROUP_FILE || '/etc/group' };
}

/** The members of the «administrators» group, from /etc/group («administrators:x:101:admin,anna»). */
export function dsmAdmins(groupFile: string): Set<string> {
  try {
    const line = readFileSync(groupFile, 'utf8').split('\n').find((l) => l.startsWith('administrators:'));
    return new Set((line?.split(':')[3] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** DSM error codes for a login: 400 wrong password, 401 account disabled, 402 no permission, 403/404/406 two-step verification. */
export async function dsmLogin(o: DsmOptions, name: string, password: string): Promise<DsmCheck> {
  if (!o.url) return { ok: false, reason: 'unreachable', message: 'Accesso con gli utenti del NAS non disponibile' };
  // DSM lets an unknown «session» in only for users allowed on the DSM desktop (often only administrators): a user
  // without it (402) is checked again as one of the NAS apps they may use. Right password + any of them = welcome.
  let j: { success?: boolean; data?: { sid?: string }; error?: { code?: number } } = {};
  let session = '';
  for (const s of SESSIONS) {
    const q = new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'login', account: name, passwd: password, session: s, format: 'sid' });
    try {
      // a small NAS can take several seconds to check a password (and DSM slows down wrong ones on purpose)
      j = await post(o, q, 25_000) as typeof j;
    } catch (e) {
      return { ok: false, reason: 'unreachable', message: `DSM non risponde (${(e as Error).message})` };
    }
    session = s;
    if (j.success || j.error?.code !== 402) break;
  }
  if (!j.success) {
    const c = j.error?.code ?? 0;
    if (c === 403 || c === 404 || c === 406) return { ok: false, reason: 'otp', message: 'Questo utente del NAS usa la verifica in due passaggi: collega il dispositivo con il codice a 6 cifre da un dispositivo già collegato' };
    if (c === 401) return { ok: false, reason: 'disabled', message: 'Questo utente del NAS è disattivato' };
    if (c === 402) return { ok: false, reason: 'disabled', message: 'La password è giusta, ma questo utente non può usare nessuna app del NAS. In DSM → Pannello di controllo → Privilegi applicazione, consenti a questo utente File Station (oppure Audio Station o Video Station), poi riprova' };
    return { ok: false, reason: 'wrong', message: 'Nome o password sbagliati' };
  }
  // the DSM session was only to check the password: closed at once
  if (j.data?.sid) {
    const out = new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'logout', session, _sid: j.data.sid });
    void post(o, out, 10_000).catch(() => {});
  }
  return { ok: true, admin: dsmAdmins(o.groupFile ?? '/etc/group').has(name.toLowerCase()) };
}

/** One call to the DSM web API (plain node:http: no keep-alive surprises on DSM's web server). */
function post(o: DsmOptions, q: URLSearchParams, timeoutMs: number): Promise<unknown> {
  if (o.fetch) return o.fetch(o.url!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q.toString() }).then((r) => r.json());
  const body = q.toString();
  return new Promise((ok, ko) => {
    const req = request(o.url!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), connection: 'close' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { ok(JSON.parse(data)); } catch { ko(new Error(`risposta non valida (HTTP ${res.statusCode})`)); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`nessuna risposta in ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', ko);
    req.end(body);
  });
}

/** At start: does DSM answer? (SYNO.API.Info needs no account: no login attempt, nothing for DSM to block.) Written in the log. */
export async function dsmProbe(o: DsmOptions): Promise<string> {
  if (!o.url) return 'non è un Synology: si entra solo con gli account di PartyMix';
  const t = Date.now();
  try {
    const j = await post(o, new URLSearchParams({ api: 'SYNO.API.Info', version: '1', method: 'query', query: 'SYNO.API.Auth' }), 15_000) as { success?: boolean; data?: Record<string, { path?: string; maxVersion?: number }> };
    const a = j.data?.['SYNO.API.Auth'];
    return j.success && a ? `DSM risponde su ${o.url} in ${Date.now() - t} ms (SYNO.API.Auth ${a.path} fino alla versione ${a.maxVersion})` : `DSM risponde ma senza SYNO.API.Auth: ${JSON.stringify(j).slice(0, 200)}`;
  } catch (e) {
    return `DSM NON risponde su ${o.url}: ${(e as Error).message}`;
  }
}
