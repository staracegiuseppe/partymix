import type { TrackDoc } from '../../shared/model';
import type { MusicLibrary } from '../library/library';
import { friendly } from '../library/library';
import type { Playlist } from '../library/playlists';
import type { SyncApi } from './client';

/**
 * The songs of the NAS on this device (phases 6–8):
 * - the NAS library appears in this device's library as ☁ songs (they come with the sync's changes);
 * - a ☁ song plays in streaming from the NAS (a short signed link, see the server's /link);
 * - «Salva su questo dispositivo» copies songs here, two at a time, after checking there is room: then they play
 *   without the NAS (away from home, in airplane mode). Removing the copy leaves the song ☁.
 */

export type SaveJob = { total: number; done: number; failed: number; bytes: number; totalBytes: number; running: boolean; current?: string; error?: string };

type Deps = {
  library: MusicLibrary;
  api: () => SyncApi | undefined;
  /** Bytes free for copies on this device (undefined = unknown: then the copy is just tried). */
  freeSpace?: () => Promise<number | undefined>;
  log?: (m: string) => void;
};

const PARALLEL = 2;
/** Room to leave free on the device after the copies. */
const KEEP_FREE = 300 << 20;

export class NasMusic {
  private job: SaveJob = { total: 0, done: 0, failed: 0, bytes: 0, totalBytes: 0, running: false };
  private queue: string[] = [];
  private stopFlag = false;
  private aborts = new Map<string, AbortController>();
  private listeners = new Set<() => void>();

  constructor(private d: Deps) {}

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { for (const f of this.listeners) f(); }
  status(): SaveJob { return { ...this.job }; }

  /** Songs that came with the sync: new and changed ones join the library, deleted ones leave it. */
  async applyTracks(docs: TrackDoc[]): Promise<void> {
    for (const t of docs) {
      if (t.deleted) await this.d.library.dropNas(t.id);
      else this.d.library.upsertNas(t);
    }
  }

  /** The whole NAS library, page by page (first link of this device, or «Aggiorna elenco»). */
  async refreshAll(): Promise<number> {
    const api = this.d.api();
    if (!api) return 0;
    let cursor: string | undefined;
    let n = 0;
    do {
      const page = await api.library(cursor, 500);
      await this.applyTracks(page.tracks);
      n += page.tracks.length;
      cursor = page.next;
    } while (cursor);
    return n;
  }

  /** A link the player can open for a ☁ song (`nas:<sha256>`), or undefined when the NAS is not linked. */
  async streamUrl(id: string): Promise<string | undefined> {
    const api = this.d.api();
    if (!api?.streamLink || !id.startsWith('nas:')) return undefined;
    try { return await api.streamLink(id.slice(4)); } catch (e) { this.d.log?.(`streaming non disponibile: ${(e as Error).message}`); return undefined; }
  }

  /** The ☁ songs of these playlists (or of the whole NAS library) that have no copy here yet. */
  missing(playlists?: Playlist[]): string[] {
    const lib = this.d.library;
    if (!playlists) return lib.nasOnly().map((e) => e.id);
    const ids = new Set<string>();
    for (const p of playlists) for (const t of p.tracks) if (t.videoId.startsWith('nas:') && !lib.isOffline(t.videoId)) ids.add(t.videoId);
    return [...ids];
  }

  /** Bytes the copies of these songs would take. */
  sizeOf(ids: string[]): number { return ids.reduce((n, id) => n + (this.d.library.get(id)?.nasSize ?? 0), 0); }

  /**
   * Copies the songs on this device, two at a time. Before starting: is there room? (refused with how much is
   * missing, nothing is half-done). Songs already copied are skipped. Returns at once; follow it with status().
   */
  async save(ids: string[]): Promise<void> {
    const todo = ids.filter((id) => id.startsWith('nas:') && !this.d.library.isOffline(id) && !this.queue.includes(id) && !this.aborts.has(id));
    if (!todo.length) return;
    const need = this.sizeOf(todo);
    const free = await this.d.freeSpace?.().catch(() => undefined);
    if (free != null && free - need < KEEP_FREE) {
      const mb = (b: number) => `${Math.max(0, Math.round(b / (1 << 20)))} MB`;
      throw new Error(`Spazio insufficiente: servono ${mb(need)}, liberi ${mb(free - KEEP_FREE)}. Libera spazio o scegli meno brani.`);
    }
    if (!this.job.running) this.job = { total: 0, done: 0, failed: 0, bytes: 0, totalBytes: 0, running: true };
    this.job.total += todo.length;
    this.job.totalBytes += need;
    this.queue.push(...todo);
    this.stopFlag = false;
    this.changed();
    const workers = Math.max(0, PARALLEL - this.aborts.size);
    for (let i = 0; i < workers; i++) void this.work();
  }

  /** Stops the copies (the ones finished stay). */
  stop(): void {
    this.stopFlag = true;
    this.queue = [];
    for (const [id, c] of this.aborts) { c.abort(); this.d.library.setTransfer(id, undefined); }
  }

  private async work(): Promise<void> {
    for (;;) {
      const id = this.queue.shift();
      if (!id || this.stopFlag) break;
      await this.saveOne(id);
    }
    if (!this.aborts.size && !this.queue.length) { this.job.running = false; delete this.job.current; this.changed(); }
  }

  private async saveOne(id: string): Promise<void> {
    const lib = this.d.library;
    const api = this.d.api();
    const e = lib.get(id);
    if (!api?.download || !e) { this.job.failed++; this.job.error = 'NAS non collegato'; return; }
    const ctl = new AbortController();
    this.aborts.set(id, ctl);
    this.job.current = e.title;
    lib.setTransfer(id, { progress: 0 });
    let last = 0;
    try {
      const blob = await api.download(id.slice(4), (got, total) => {
        if (total) lib.setTransfer(id, { progress: Math.min(0.99, got / total) });
        this.job.bytes += got - last; last = got;
        this.changed();
      }, ctl.signal);
      await lib.saveNasCopy(id, blob);
      this.job.done++;
    } catch (err) {
      if (ctl.signal.aborted) { lib.setTransfer(id, undefined); return; }
      this.job.failed++;
      this.job.error = friendly(err);
      lib.setTransfer(id, { error: this.job.error });
      this.d.log?.(`copia dal NAS non riuscita: ${e.title}: ${this.job.error}`);
    } finally {
      this.aborts.delete(id);
      this.changed();
    }
  }
}
