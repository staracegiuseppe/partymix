import { existsSync, readFileSync } from 'node:fs';

/**
 * Signing in with the NAS's own users (Synology DSM): everyone who has an account on the NAS can use PartyMix with
 * the same name and password. PartyMix never keeps those passwords: it asks DSM on the NAS itself (SYNO.API.Auth on
 * 127.0.0.1) whether they are right, then closes that DSM session at once. Members of DSM's «administrators» group
 * become PartyMix administrators (delete songs, manage every device); the others can listen, upload and edit the
 * shared playlists.
 */

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

/** The members of the «administrators» group, from /etc/group («administrators:x:101:admin,stareis»). */
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
  const f = o.fetch ?? fetch;
  const q = new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'login', account: name, passwd: password, session: 'PartyMix', format: 'sid' });
  let j: { success?: boolean; data?: { sid?: string }; error?: { code?: number } };
  try {
    const r = await f(o.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q.toString(), signal: AbortSignal.timeout(8000) });
    j = await r.json() as typeof j;
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `DSM non risponde (${(e as Error).message})` };
  }
  if (!j.success) {
    const c = j.error?.code ?? 0;
    if (c === 403 || c === 404 || c === 406) return { ok: false, reason: 'otp', message: 'Questo utente del NAS usa la verifica in due passaggi: collega il dispositivo con il codice a 6 cifre da un dispositivo già collegato' };
    if (c === 401) return { ok: false, reason: 'disabled', message: 'Questo utente del NAS è disattivato' };
    if (c === 402) return { ok: false, reason: 'disabled', message: 'Questo utente del NAS non ha il permesso di accedere' };
    return { ok: false, reason: 'wrong', message: 'Nome o password sbagliati' };
  }
  // the DSM session was only to check the password: closed at once
  if (j.data?.sid) {
    const out = new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'logout', session: 'PartyMix', _sid: j.data.sid });
    void f(o.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: out.toString() }).catch(() => {});
  }
  return { ok: true, admin: dsmAdmins(o.groupFile ?? '/etc/group').has(name.toLowerCase()) };
}
