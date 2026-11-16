import type { Conflict, Op } from '../../shared/merge';
import type { Changes, ChunkResult, DeviceDoc, Entry, LibraryPage, PlaylistDoc, PlaylistMeta, ServerEvent, SessionDoc, TrackDoc, UploadStart, UploadStarted } from '../../shared/model';

/** The NAS answered with an error (`status` 0 = could not be reached at all). */
export class SyncError extends Error {
  status: number;
  code: string;
  /** On a version conflict: the playlist as the NAS has it now. */
  current?: PlaylistDoc;
  /** On a piece sent out of order: how many bytes the NAS has, to resume from there. */
  received?: number;
  constructor(status: number, code: string, message: string, current?: PlaylistDoc) {
    super(message);
    this.status = status;
    this.code = code;
    this.current = current;
  }
  get offline() { return this.status === 0; }
  get unauthorized() { return this.status === 401; }
}

export type OpsResult = { playlist: PlaylistDoc; merged: boolean; conflicts: Conflict[] };
export type SyncStatusDoc = { seq: number; tracks: number; playlists: number; device: { lastSyncSeq: number }; serverVersion: string; at: number };
export type StorageDoc = { musicBytes: number; tracks: number; freeBytes: number | null; totalBytes: number | null };
export type Health = { app: string; version: string; setup: boolean };
export type DeviceInfo = { deviceName: string; deviceKind: 'pc' | 'android' | 'ios' | 'other' };

/** Everything the app asks the NAS. One implementation talks HTTP; the tests use a fake. */
export interface SyncApi {
  health(): Promise<Health>;
  setup(name: string, password: string, dev: DeviceInfo): Promise<SessionDoc>;
  login(name: string, password: string, dev: DeviceInfo): Promise<SessionDoc>;
  pair(code: string, dev: DeviceInfo): Promise<SessionDoc>;
  logout(): Promise<void>;
  status(): Promise<SyncStatusDoc>;
  storage(): Promise<StorageDoc>;
  changes(since: number, limit?: number): Promise<Changes>;
  playlist(id: string): Promise<PlaylistDoc>;
  createPlaylist(id: string, meta: PlaylistMeta, entries: Entry[]): Promise<PlaylistDoc>;
  ops(id: string, baseVersion: number, ops: Op[]): Promise<OpsResult>;
  putPlaylist(id: string, baseVersion: number, meta: PlaylistMeta, entries: Entry[]): Promise<PlaylistDoc>;
  deletePlaylist(id: string, baseVersion?: number): Promise<void>;
  devices(): Promise<DeviceDoc[]>;
  renameDevice(id: string, name: string): Promise<DeviceDoc>;
  revokeDevice(id: string): Promise<DeviceDoc>;
  pairCode(): Promise<{ code: string; expiresAt: number }>;
  // ---- the files (phase 5: upload from the computer) ----
  /** Which of these files (SHA-256) the NAS already has. */
  checkTracks(sha256: string[]): Promise<{ missing: string[]; present: string[] }>;
  /** Opens an upload: the song if it is there already, else where to send the bytes and from which byte. */
  startUpload(req: UploadStart): Promise<UploadStarted>;
  /** Bytes `from`…`to` (inclusive) of `total`: how many are there now, or the song when it was the last piece. */
  uploadChunk(uploadId: string, from: number, to: number, total: number, bytes: Uint8Array): Promise<ChunkResult>;
  uploadCover(trackId: string, data: Blob): Promise<TrackDoc>;
  track(id: string): Promise<TrackDoc>;
  library(cursor?: string, limit?: number, q?: string): Promise<LibraryPage>;
  /** Live changes (Server-Sent Events). Returns the function that stops listening. */
  events(onEvent: (ev: ServerEvent) => void, onState?: (open: boolean) => void): () => void;
  // ---- phase 6–8: listening from the NAS, copies on the device, songs copied by hand ----
  /** A short signed link to play the song in an <audio> element (15 minutes, this device only). */
  streamLink?(id: string): Promise<string>;
  /** The whole file, for a copy on this device (needs DOWNLOAD_TRACK). `onProgress` gets bytes received / total. */
  download?(id: string, onProgress?: (got: number, total: number) => void, signal?: AbortSignal): Promise<Blob>;
  /** Looks in the NAS music/ folder for songs copied by hand (File Station, SMB…). */
  scan?(): Promise<ScanStatus>;
  scanStatus?(): Promise<ScanStatus>;
}

export type ScanStatus = { running: boolean; last?: { found: number; added: number; duplicates: number; failed: number; at: number } };

/** `http://192.168.1.10:8787` from whatever the user typed (an address, with or without http:// and port). */
export function normalizeUrl(input: string): string | undefined {
  let s = input.trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return undefined;
    if (!u.port && u.protocol === 'http:') u.port = '8787';
    u.pathname = u.pathname.replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Addresses of the home network or a private VPN: the only ones the app talks to without HTTPS. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.ts.net') || !h.includes('.') && !h.includes(':')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

type Fetch = typeof fetch;
/** How long a call to the NAS may take (pieces of files: longer). */
export const CALL_TIMEOUT_MS = 15_000;
type EventSourceCtor = new (url: string) => EventSource;

export class HttpSyncClient implements SyncApi {
  token = '';
  private base: string;
  private fetchFn: Fetch;
  private ES?: EventSourceCtor;
  constructor(baseUrl: string, token = '', deps: { fetch?: Fetch; EventSource?: EventSourceCtor } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.ES = deps.EventSource ?? (typeof EventSource !== 'undefined' ? EventSource : undefined);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send(method, path, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'content-type': 'application/json' } : {});
  }

  /** Bytes as they are (a piece of a file, a picture), with their own headers. */
  private raw<T>(method: string, path: string, data: Uint8Array | Blob, headers: Record<string, string>): Promise<T> {
    return this.send(method, path, data as unknown as BodyInit, headers);
  }

  private async send<T>(method: string, path: string, body: BodyInit | undefined, headers: Record<string, string>): Promise<T> {
    let res: Response;
    // a NAS that does not answer must not leave the app waiting forever (a blocked request never ends by itself)
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), body instanceof Uint8Array || body instanceof Blob ? 120_000 : CALL_TIMEOUT_MS);
    try {
      res = await this.fetchFn(this.base + path, { method, headers: { ...headers, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body, signal: ctl.signal });
    } catch (e) {
      throw new SyncError(0, 'OFFLINE', ctl.signal.aborted ? `Il NAS non risponde (${CALL_TIMEOUT_MS / 1000} s): controlla indirizzo e Wi-Fi.` : `NAS non raggiungibile (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { throw new SyncError(res.status, 'BAD_ANSWER', 'Risposta non valida dal NAS: è l’indirizzo giusto?'); }
    if (!res.ok) {
      const err = new SyncError(res.status, String(json.error ?? 'HTTP'), String(json.message ?? `Errore ${res.status}`), json.current as PlaylistDoc | undefined);
      if (typeof json.received === 'number') err.received = json.received;
      throw err;
    }
    return json as T;
  }

  health() { return this.call<Health>('GET', '/api/health'); }
  async setup(name: string, password: string, dev: DeviceInfo) { const s = await this.call<SessionDoc>('POST', '/api/auth/setup', { name, password, ...dev }); this.token = s.token; return s; }
  async login(name: string, password: string, dev: DeviceInfo) { const s = await this.call<SessionDoc>('POST', '/api/auth/login', { name, password, ...dev }); this.token = s.token; return s; }
  async pair(code: string, dev: DeviceInfo) { const s = await this.call<SessionDoc>('POST', '/api/auth/pair', { code, ...dev }); this.token = s.token; return s; }
  async logout() { await this.call('POST', '/api/auth/logout', {}); this.token = ''; }
  status() { return this.call<SyncStatusDoc>('GET', '/api/sync/status'); }
  storage() { return this.call<StorageDoc>('GET', '/api/storage'); }
  changes(since: number, limit = 500) { return this.call<Changes>('GET', `/api/sync/changes?since=${since}&limit=${limit}`); }
  playlist(id: string) { return this.call<PlaylistDoc>('GET', `/api/playlists/${encodeURIComponent(id)}`); }
  createPlaylist(id: string, meta: PlaylistMeta, entries: Entry[]) { return this.call<PlaylistDoc>('POST', '/api/playlists', { id, ...meta, entries }); }
  ops(id: string, baseVersion: number, ops: Op[]) { return this.call<OpsResult>('POST', `/api/playlists/${encodeURIComponent(id)}/ops`, { baseVersion, ops }); }
  putPlaylist(id: string, baseVersion: number, meta: PlaylistMeta, entries: Entry[]) { return this.call<PlaylistDoc>('PUT', `/api/playlists/${encodeURIComponent(id)}`, { baseVersion, ...meta, entries }); }
  async deletePlaylist(id: string, baseVersion?: number) { await this.call('DELETE', `/api/playlists/${encodeURIComponent(id)}${baseVersion != null ? `?baseVersion=${baseVersion}` : ''}`); }
  devices() { return this.call<DeviceDoc[]>('GET', '/api/devices'); }
  renameDevice(id: string, name: string) { return this.call<DeviceDoc>('PATCH', `/api/devices/${encodeURIComponent(id)}`, { name }); }
  revokeDevice(id: string) { return this.call<DeviceDoc>('DELETE', `/api/devices/${encodeURIComponent(id)}`); }
  pairCode() { return this.call<{ code: string; expiresAt: number }>('POST', '/api/auth/pair-code', {}); }
  checkTracks(sha256: string[]) { return this.call<{ missing: string[]; present: string[] }>('POST', '/api/tracks/check', { sha256 }); }
  startUpload(req: UploadStart) { return this.call<UploadStarted>('POST', '/api/tracks/upload', req); }
  uploadChunk(uploadId: string, from: number, to: number, total: number, bytes: Uint8Array) {
    return this.raw<ChunkResult>('PUT', `/api/uploads/${encodeURIComponent(uploadId)}`, bytes, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${from}-${to}/${total}` });
  }
  uploadCover(trackId: string, data: Blob) { return this.raw<TrackDoc>('POST', `/api/tracks/${encodeURIComponent(trackId)}/cover`, data, { 'content-type': data.type || 'image/jpeg' }); }
  track(id: string) { return this.call<TrackDoc>('GET', `/api/tracks/${encodeURIComponent(id)}`); }
  library(cursor?: string, limit = 200, q = '') { return this.call<LibraryPage>('GET', `/api/library?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`); }

  async streamLink(id: string) {
    const l = await this.call<{ path: string; expiresAt: number }>('GET', `/api/tracks/${encodeURIComponent(id)}/link`);
    return this.base + l.path;
  }

  async download(id: string, onProgress?: (got: number, total: number) => void, signal?: AbortSignal): Promise<Blob> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/api/tracks/${encodeURIComponent(id)}/stream?dl=1`, { headers: { authorization: `Bearer ${this.token}` }, signal });
    } catch (e) {
      if (signal?.aborted) throw new SyncError(0, 'ABORTED', 'Annullato');
      throw new SyncError(0, 'OFFLINE', `NAS non raggiungibile (${(e as Error).message})`);
    }
    if (!res.ok) {
      let j: Record<string, unknown> = {};
      try { j = await res.json(); } catch { /* not JSON */ }
      throw new SyncError(res.status, String(j.error ?? 'HTTP'), String(j.message ?? `Errore ${res.status}`));
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    if (!res.body || !onProgress) return new Blob([await res.arrayBuffer()], { type });
    const parts: Uint8Array[] = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(got, total);
    }
    if (total && got !== total) throw new SyncError(0, 'INCOMPLETE', 'Download interrotto');
    return new Blob(parts as BlobPart[], { type });
  }

  scan() { return this.call<ScanStatus>('POST', '/api/scan', {}); }
  scanStatus() { return this.call<ScanStatus>('GET', '/api/scan'); }

  events(onEvent: (ev: ServerEvent) => void, onState?: (open: boolean) => void): () => void {
    if (!this.ES || !this.token) return () => {};
    const es = new this.ES(`${this.base}/api/events?token=${encodeURIComponent(this.token)}`);
    es.addEventListener('change', (e) => { try { onEvent(JSON.parse((e as MessageEvent).data)); } catch { /* not ours */ } });
    es.onopen = () => onState?.(true);
    es.onerror = () => onState?.(false);
    return () => es.close();
  }
}
