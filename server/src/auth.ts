import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

/** What a device may do. Stored as a bitmask on the device row. */
export const PERM = {
  READ_LIBRARY: 1,
  PLAY_TRACK: 2,
  DOWNLOAD_TRACK: 4,
  EDIT_PLAYLIST: 8,
  UPLOAD_TRACK: 16,
  DELETE_TRACK: 32,
  ADMIN: 64,
} as const;
export type PermName = keyof typeof PERM;
export const ALL_PERMS = Object.values(PERM).reduce((a, b) => a | b, 0);

export type DeviceKind = 'pc' | 'android' | 'ios' | 'other';
export const DEVICE_KINDS: DeviceKind[] = ['pc', 'android', 'ios', 'other'];

/** A computer may do everything; a phone everything but deleting songs and managing devices. */
export function defaultPerms(kind: DeviceKind, first: boolean): number {
  if (first || kind === 'pc') return ALL_PERMS;
  return ALL_PERMS & ~PERM.DELETE_TRACK & ~PERM.ADMIN;
}

export function permNames(mask: number): PermName[] {
  return (Object.keys(PERM) as PermName[]).filter((k) => (mask & PERM[k]) !== 0);
}
export function permMask(names: unknown): number | undefined {
  if (!Array.isArray(names)) return undefined;
  let m = 0;
  for (const n of names) {
    if (typeof n !== 'string' || !(n in PERM)) return undefined;
    m |= PERM[n as PermName];
  }
  return m;
}

// ---- passwords: scrypt with a random salt, never stored in clear ----
const N = 16384, R = 8, P = 1, KEYLEN = 32;
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = scryptSync(pw, Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- device tokens: 256 random bits, only the SHA-256 is kept ----
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export type Device = {
  id: string; user_id: number; name: string; kind: DeviceKind; perms: number;
  created_at: number; last_seen: number; last_sync_seq: number; revoked_at: number | null;
};

export function createDevice(db: Db, userId: number, name: string, kind: DeviceKind, perms: number, now: number): { device: Device; token: string } {
  const token = newToken();
  const id = randomUUID();
  db.prepare('INSERT INTO device (id, user_id, name, kind, token_hash, perms, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, name, kind, tokenHash(token), perms, now, now);
  return { device: getDevice(db, id)!, token };
}

export function getDevice(db: Db, id: string): Device | undefined {
  return db.prepare('SELECT id, user_id, name, kind, perms, created_at, last_seen, last_sync_seq, revoked_at FROM device WHERE id = ?').get(id) as Device | undefined;
}

/** The device a token belongs to, unless it was revoked. */
export function deviceForToken(db: Db, token: string): Device | undefined {
  const d = db.prepare('SELECT id, user_id, name, kind, perms, created_at, last_seen, last_sync_seq, revoked_at FROM device WHERE token_hash = ?').get(tokenHash(token)) as Device | undefined;
  return d && d.revoked_at == null ? d : undefined;
}

/**
 * Pairing codes: a device already signed in shows a 6-digit code, the new device types it.
 * Kept in memory only (a restart forgets them), valid 5 minutes, one use, 5 wrong guesses close it.
 */
export class PairingCodes {
  private codes = new Map<string, { userId: number; expires: number }>();
  private failures = 0;
  private now: () => number;
  constructor(now: () => number) { this.now = now; }
  create(userId: number): { code: string; expiresAt: number } {
    this.sweep();
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (this.codes.has(code));
    const expiresAt = this.now() + 5 * 60_000;
    this.codes.set(code, { userId, expires: expiresAt });
    this.failures = 0;
    return { code, expiresAt };
  }
  take(code: string): number | undefined {
    this.sweep();
    const c = this.codes.get(code);
    if (!c) {
      if (++this.failures >= 5) this.codes.clear();
      return undefined;
    }
    this.codes.delete(code);
    return c.userId;
  }
  private sweep() { const t = this.now(); for (const [k, v] of this.codes) if (v.expires < t) this.codes.delete(k); }
}

/** Slows down password guessing: after 5 failures from one address, 1 minute of "try later". */
export class LoginLimiter {
  private fails = new Map<string, { n: number; until: number }>();
  private now: () => number;
  constructor(now: () => number) { this.now = now; }
  blocked(addr: string): boolean { const f = this.fails.get(addr); return !!f && f.n >= 5 && f.until > this.now(); }
  fail(addr: string) {
    const f = this.fails.get(addr);
    const fresh = !f || f.until < this.now();
    this.fails.set(addr, { n: fresh ? 1 : f!.n + 1, until: this.now() + 60_000 });
  }
  ok(addr: string) { this.fails.delete(addr); }
}
