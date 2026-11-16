import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';

/**
 * Listening to a song on the NAS. An <audio> element cannot send the device's token, so the app first asks for a
 * short signed link (`?d=<device>&e=<expiry>&s=<signature>`): it works for 15 minutes, for that song and that device
 * only, and stops working at once if the device is revoked. Never a permanent public address.
 */

export const LINK_TTL_MS = 15 * 60_000;

/** The server's own secret for the links (database/stream.key, made at first start). */
export function loadStreamKey(file: string): Buffer {
  try {
    const k = readFileSync(file);
    if (k.length >= 32) return k;
  } catch { /* first start */ }
  const k = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, k, { mode: 0o600 });
  return readFileSync(file);
}

const mac = (key: Buffer, trackId: string, deviceId: string, exp: number) =>
  createHmac('sha256', key).update(`${trackId}.${deviceId}.${exp}`).digest('base64url');

export function signLink(key: Buffer, trackId: string, deviceId: string, now: number): { path: string; expiresAt: number } {
  const exp = now + LINK_TTL_MS;
  const q = new URLSearchParams({ d: deviceId, e: String(exp), s: mac(key, trackId, deviceId, exp) });
  return { path: `/api/tracks/${trackId}/stream?${q}`, expiresAt: exp };
}

/** The device a signed link was made for, if the signature is right and not expired. */
export function checkLink(key: Buffer, trackId: string, url: URL, now: number): string | undefined {
  const d = url.searchParams.get('d'), e = Number(url.searchParams.get('e')), s = url.searchParams.get('s');
  if (!d || !s || !Number.isFinite(e) || e < now) return undefined;
  const want = Buffer.from(mac(key, trackId, d, e));
  const got = Buffer.from(s);
  return got.length === want.length && timingSafeEqual(got, want) ? d : undefined;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` → inclusive range, or null when unsatisfiable; undefined = whole file. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined; // several ranges or nonsense: the whole file
  let start: number, end: number;
  if (m[1] === '') { const n = Number(m[2]); if (n <= 0) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return null;
  return { start, end };
}

/** Sends the file with Range support (206 for a piece): play at once, seek anywhere. */
export function sendFile(req: IncomingMessage, res: ServerResponse, file: { path: string; mime: string; size: number }, extra: Record<string, string> = {}) {
  const base = { 'accept-ranges': 'bytes', 'content-type': file.mime, 'cache-control': 'private, max-age=3600', ...extra };
  const r = parseRange(req.headers.range, file.size);
  if (r === null) { res.writeHead(416, { ...base, 'content-range': `bytes */${file.size}` }); res.end(); return; }
  const { start, end } = r ?? { start: 0, end: file.size - 1 };
  const headers = { ...base, 'content-length': String(end - start + 1), ...(r ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}) };
  res.writeHead(r ? 206 : 200, headers);
  if (req.method === 'HEAD' || file.size === 0) { res.end(); return; }
  const s = createReadStream(file.path, { start, end, highWaterMark: 256 << 10 });
  s.on('error', () => res.destroy());
  req.on('close', () => s.destroy());
  s.pipe(res);
}
