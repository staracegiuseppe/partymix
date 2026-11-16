import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

export class HttpError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

const DRAIN_MAX = 64 << 20;

/**
 * The whole body, at most `limit` bytes. A bigger one is read and dropped (up to a point) before the 413 goes out:
 * leaving the stream half-read would close the connection and the client would never see the answer.
 */
export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, ko) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (over) { if (size > DRAIN_MAX) req.destroy(); return; }
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? ko(new HttpError(413, 'TOO_LARGE', 'Richiesta troppo grande')) : ok(Buffer.concat(chunks))));
    req.on('error', ko);
  });
}

/** Reads a JSON body of at most `limit` bytes. */
export async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<Record<string, unknown>> {
  const buf = await readRaw(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw bad('JSON non valido');
  }
}

/** `Content-Range: bytes 0-4194303/10485760` → from, to, total. */
export function parseContentRange(h: string | undefined): { from: number; to: number; total: number } {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h?.trim() ?? '');
  if (!m) throw bad('Content-Range mancante o non valido (bytes a-b/totale)');
  const [from, to, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(total) || to < from || to >= total) throw bad('Content-Range non valido');
  return { from, to, total };
}

export function str(v: unknown, field: string, max = 200, required = true): string | undefined {
  if (v == null || v === '') {
    if (required) throw bad(`${field} mancante`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${field} deve essere testo`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} troppo lungo`);
  if (required && !s) throw bad(`${field} mancante`);
  return s || undefined;
}

export function num(v: unknown, field: string, required = false): number | undefined {
  if (v == null) {
    if (required) throw bad(`${field} mancante`);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${field} deve essere un numero`);
  return v;
}

/** Loopback, private LAN, link-local and the 100.64/10 range Tailscale uses. Anything else is "the internet". */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const v = isIP(a);
  if (v === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (v === 6) {
    const l = a.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') ||
      l.startsWith('fd7a:115c:a1e0'); // Tailscale IPv6
  }
  return false;
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL }) => Promise<void> | void;

/** A tiny router: "GET /api/playlists/:id" → handler(params = [id]). */
export class Router {
  private routes: { method: string; re: RegExp; fn: Handler }[] = [];
  on(method: string, pattern: string, fn: Handler): this {
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$');
    this.routes.push({ method, re, fn });
    return this;
  }
  match(method: string, path: string): { fn: Handler; params: string[] } | 'method' | undefined {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { fn: r.fn, params: m.slice(1).map(decodeURIComponent) };
    }
    return pathMatched ? 'method' : undefined;
  }
}
