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

/** Reads a JSON body of at most `limit` bytes. */
export async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'TOO_LARGE', 'Richiesta troppo grande');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw bad('JSON non valido');
  }
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
