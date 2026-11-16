import type { UploadMeta } from '../../shared/model';
import { mimeOf } from '../library/blobStore';
import type { LibEntry, MusicLibrary } from '../library/library';
import { SyncError, type SyncApi } from './client';

/**
 * Sends the songs of this computer's library to the NAS, two at a time. For each file: the SHA-256 (its identity on
 * the NAS), then «do you have it?»; what the NAS has is only linked, what is missing goes up in 4 MB pieces, resumed
 * from where it stopped if the connection drops. The NAS hashes the file again on arrival: a file that does not match
 * is refused as corrupt and shown as an error here. Done: `LibEntry.nasId`, and the playlist lines with that song
 * become NAS lines (see engine.ts entryOf).
 */

/** What the user sees next to a song: ☁ on the NAS, ⬆ going up (or waiting its turn), ⚠ not on the NAS, error. */
export type NasState = 'nas' | 'queued' | 'checking' | 'uploading' | 'error' | 'missing';

export type NasSummary = {
  /** Songs with a file on this computer. */
  total: number;
  onNas: number;
  /** Queued, being hashed or being sent. */
  uploading: number;
  failed: number;
};

export type UploaderDeps = {
  api: SyncApi;
  library: MusicLibrary;
  /** «Carica sul NAS i brani importati»: new songs go up by themselves. */
  auto: () => boolean;
  /** A song is on the NAS now (the playlists that have it are pushed again). */
  onDone?: (id: string, sha256: string) => void;
  log?: (msg: string) => void;
  concurrency?: number;
  chunkSize?: number;
  /** Biggest cover sent along (the NAS refuses bigger ones). */
  maxCover?: number;
};

type Job = { state: Exclude<NasState, 'nas' | 'missing'>; progress?: number; error?: string; /** Failed because the NAS was away: tried again when it is back. */ retry?: boolean };

export const CHUNK_SIZE = 4 << 20;

/** The words shown for an upload error (never a raw technical message). */
export function uploadErrorText(e: unknown): { text: string; retry: boolean } {
  if (e instanceof SyncError) {
    if (e.offline) return { text: 'NAS non raggiungibile: riprovo quando torna.', retry: true };
    if (e.code === 'CORRUPT_FILE') return { text: 'Il file è arrivato danneggiato sul NAS ed è stato scartato: riprova.', retry: false };
    if (e.code === 'NO_SPACE') return { text: 'Spazio insufficiente sul NAS.', retry: false };
    if (e.status === 403) return { text: 'Questo dispositivo non ha il permesso di caricare brani sul NAS.', retry: false };
    if (e.status === 401) return { text: 'Dispositivo non più autorizzato sul NAS.', retry: false };
    if (e.status >= 500) return { text: `Il NAS ha risposto con un errore (${e.message}).`, retry: true };
    return { text: e.message, retry: false };
  }
  const m = (e as Error)?.message;
  return { text: m && !/^[A-Z][a-zA-Z]+Error\b/.test(m) ? m : 'Errore imprevisto: riprova.', retry: false };
}

export class Uploader {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  private listeners = new Set<() => void>();
  private stopFns: (() => void)[] = [];
  private stopped = false;
  private d: UploaderDeps;
  version = 0;

  constructor(d: UploaderDeps) { this.d = d; }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { this.version++; for (const fn of this.listeners) fn(); }

  /** Looks at the library now and whenever it changes: a new file (import, download done) goes up when `auto` says so. */
  start(): void {
    this.stopped = false;
    this.stopFns.push(this.d.library.onChange(() => { if (this.d.auto()) this.scan(false); }));
    if (this.d.auto()) this.scan(false);
  }

  stop(): void {
    this.stopped = true;
    for (const f of this.stopFns) f();
    this.stopFns = [];
    this.queue = [];
    this.changed();
  }

  /** «Carica ora»: everything not on the NAS, failed ones included. */
  uploadNow(): void { this.scan(true); }

  /** The NAS is back: what failed for that reason is tried again. */
  resume(): void {
    for (const [id, j] of this.jobs) if (j.state === 'error' && j.retry) this.enqueue(id);
  }

  private scan(includeErrors: boolean) {
    if (this.stopped) return;
    for (const e of this.d.library.all()) {
      if (!e.file || e.nasId || e.state === 'downloading') continue;
      const j = this.jobs.get(e.id);
      if (j && j.state !== 'error') continue;
      if (j?.state === 'error' && !includeErrors) continue;
      this.enqueue(e.id);
    }
  }

  private enqueue(id: string) {
    if (this.queue.includes(id)) return;
    const j = this.jobs.get(id);
    if (j && j.state !== 'error') return;
    this.jobs.set(id, { state: 'queued' });
    this.queue.push(id);
    this.changed();
    this.pump();
  }

  private pump() {
    const max = this.d.concurrency ?? 2;
    while (this.running < max && this.queue.length && !this.stopped) {
      const id = this.queue.shift()!;
      this.running++;
      void this.run(id).finally(() => { this.running--; this.pump(); });
    }
  }

  stateOf(id: string): NasState | undefined {
    const e = this.d.library.get(id);
    if (e?.nasId) return 'nas';
    const j = this.jobs.get(id);
    if (j) return j.state;
    return e?.file ? 'missing' : undefined;
  }
  progressOf(id: string): number | undefined { return this.jobs.get(id)?.progress; }
  errorOf(id: string): string | undefined { return this.jobs.get(id)?.error; }

  summary(): NasSummary {
    const s: NasSummary = { total: 0, onNas: 0, uploading: 0, failed: 0 };
    for (const e of this.d.library.all()) {
      if (!e.file) continue;
      s.total++;
      if (e.nasId) { s.onNas++; continue; }
      const j = this.jobs.get(e.id);
      if (!j) continue;
      if (j.state === 'error') s.failed++; else s.uploading++;
    }
    return s;
  }

  private set(id: string, j: Job) { this.jobs.set(id, j); this.changed(); }

  private async run(id: string): Promise<void> {
    const lib = this.d.library;
    const e = lib.get(id);
    if (!e?.file || e.nasId) { this.jobs.delete(id); this.changed(); return; }
    try {
      this.set(id, { state: 'checking' });
      const sha = await lib.fileSha256(id);
      const chk = await this.d.api.checkTracks([sha]);
      if (chk.present.includes(sha)) { await this.finish(id, sha); return; }
      if (!e.size) throw new Error('Dimensione del file sconosciuta: importalo di nuovo.');
      this.set(id, { state: 'uploading', progress: 0 });
      const st = await this.d.api.startUpload({ sha256: sha, size: e.size, mime: e.mime || mimeOf(e.file) || 'audio/mpeg', ext: extOf(e.file), meta: metaOf(e), ...(e.id.startsWith('local:') ? {} : { youtubeId: e.id }) });
      if (!st.track) {
        const chunk = this.d.chunkSize ?? CHUNK_SIZE;
        let from = st.received;
        while (from < e.size) {
          if (this.stopped) throw new SyncError(0, 'OFFLINE', 'interrotto');
          const to = Math.min(e.size, from + chunk) - 1;
          const bytes = await lib.fileBytes(id, from, to - from + 1);
          let r;
          try {
            r = await this.d.api.uploadChunk(st.uploadId, from, to, e.size, bytes);
          } catch (err) {
            // the NAS has more or less than we think (an answer got lost): go on from what it says
            if (err instanceof SyncError && err.status === 409 && err.received != null && err.received !== from) { from = err.received; continue; }
            throw err;
          }
          if (r.track) break;
          from = r.received;
          this.set(id, { state: 'uploading', progress: from / e.size });
        }
      }
      if (e.cover && e.cover.size <= (this.d.maxCover ?? 2 << 20)) {
        try { await this.d.api.uploadCover(sha, e.cover); } catch (err) { this.d.log?.(`copertina non inviata: ${(err as Error).message}`); }
      }
      await this.finish(id, sha);
    } catch (err) {
      const { text, retry } = uploadErrorText(err);
      this.d.log?.(`upload «${e.title}»: ${text}`);
      this.set(id, { state: 'error', error: text, retry });
    }
  }

  private async finish(id: string, sha: string) {
    await this.d.library.setNasId(id, sha);
    this.jobs.delete(id);
    this.changed();
    this.d.onDone?.(id, sha);
  }
}

const extOf = (file: string) => (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? '').toLowerCase() || undefined;

function metaOf(e: LibEntry): UploadMeta {
  const m: UploadMeta = { title: e.title || 'Brano' };
  if (e.artist) m.artist = e.artist;
  if (e.album) m.album = e.album;
  if (e.durationSec) m.durationSec = e.durationSec;
  return m;
}
