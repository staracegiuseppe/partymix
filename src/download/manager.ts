import type { MusicLibrary } from '../library/library';
import { idForUrl } from '../library/library';
import type { PlaylistStore } from '../library/playlists';
import { DlError, DlJob, DlRequest, DownloadClient, DlConfig } from './client';

/** The YouTube video id of a link (same rules as the app side), to spot a song already offline before asking. */
export function youtubeIdOf(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id: string | null | undefined;
    if (host === 'youtube.com') id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[2];
    else if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    return id && /^[\w-]{11}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

type Hooks = {
  /** A message for the user (status line). */
  status(text: string, error?: boolean): void;
  /** A playlist received a downloaded song (the queue follows if it is the one playing). */
  playlistChanged(id: string): void;
};

/**
 * Joins the app's download manager to the library and the playlists: every finished download becomes a song of
 * My Library (offline), and goes into the playlist named in the request, once.
 */
export class DownloadCoordinator {
  private jobs = new Map<string, DlJob>();
  private integrated = new Set<string>();
  version = 0;
  cfg?: DlConfig;

  constructor(private c: DownloadClient, private lib: MusicLibrary, private pls: PlaylistStore, private hooks: Hooks) {}

  /** Reads the saved jobs (finished while the app was closed too) and follows the new ones. */
  async start(): Promise<void> {
    this.c.onUpdate((j) => this.apply(j));
    try { this.cfg = await this.c.config(); } catch { /* not in the app: downloads unavailable */ }
    for (const j of await this.c.list().catch(() => [] as DlJob[])) this.apply(j, true);
  }

  available(): boolean { return !!this.cfg; }
  list(): DlJob[] { return [...this.jobs.values()].sort((a, b) => b.created_at - a.created_at); }
  get(id: string): DlJob | undefined { return this.jobs.get(id); }
  active(): number { let n = 0; for (const j of this.jobs.values()) if (j.status === 'QUEUED' || j.status === 'DOWNLOADING' || j.status === 'PROCESSING') n++; return n; }

  apply(j: DlJob, initial = false): void {
    const prev = this.jobs.get(j.id);
    this.jobs.set(j.id, j);
    this.version++;
    if (j.status === 'COMPLETED' && (initial || prev?.status !== 'COMPLETED')) void this.integrate(j, !initial);
    if (!initial && (j.status === 'FAILED') && prev?.status !== 'FAILED') this.hooks.status(`Download non riuscito${j.meta?.title || j.filename ? ` («${j.meta?.title ?? j.filename}»)` : ''}: ${j.message ?? 'errore'}`, true);
  }

  /** The library id of a finished download: the YouTube video id, or `local:` + hash of the link. */
  async libraryId(j: DlJob): Promise<string> {
    const m = j.meta;
    if (m?.content_id && /youtube/i.test(m.extractor ?? '') && /^[\w-]{11}$/.test(m.content_id)) return m.content_id;
    return youtubeIdOf(j.request.url) ?? idForUrl(m?.source_url || j.request.url);
  }

  private async integrate(j: DlJob, announce: boolean): Promise<void> {
    const m = j.meta;
    if (!m || this.integrated.has(j.id)) return;
    this.integrated.add(j.id);
    const id = await this.libraryId(j);
    const have = this.lib.get(id);
    const e = have && (have.file === m.local_filename || have.videoFile === m.local_filename) ? have : await this.lib.addDownloaded({
      id, title: m.title, artist: m.artist ?? undefined, album: m.album ?? undefined, durationSec: m.duration ?? undefined,
      file: m.local_filename, size: m.file_size, url: m.source_url, mime: m.mime_type, thumb: m.thumbnail ?? undefined,
      thumbFile: m.thumbnail_file ?? undefined, origin: `Scaricato da ${m.extractor ?? 'internet'}: ${m.original_filename ?? m.source_url}`,
    });
    const pid = j.request.playlist_id;
    let into = '';
    if (pid && this.pls.get(pid)) {
      const r = this.pls.addTracks(pid, [this.lib.toTrack(e)]);
      if (r.added) { this.hooks.playlistChanged(pid); into = ` e aggiunto a «${this.pls.get(pid)!.name}»`; }
    }
    this.version++;
    if (announce) this.hooks.status(`✓ Download completato: «${e.title}» è in My Library${into}, disponibile offline.`);
  }

  /**
   * ⬇ Download. A song already offline in the library is not asked again («✓ Già scaricato»); otherwise the job is
   * created in the app, which answers at once with its id and downloads in the background.
   */
  async download(req: DlRequest): Promise<DlJob | undefined> {
    const yt = youtubeIdOf(req.url);
    if (yt && this.lib.isOffline(yt) && !(req.type === 'video' && !/video/.test(this.lib.get(yt)?.mime ?? ''))) {
      const e = this.lib.get(yt)!;
      if (req.playlist_id && this.pls.get(req.playlist_id) && this.pls.addTracks(req.playlist_id, [this.lib.toTrack(e)]).added) this.hooks.playlistChanged(req.playlist_id);
      this.hooks.status(`✓ Già scaricato: «${e.title}» è già nella libreria, non lo scarico di nuovo.`);
      return undefined;
    }
    try {
      const j = await this.c.create(req);
      this.apply(j);
      if (j.already) {
        this.integrated.delete(j.id);
        await this.integrate({ ...j, request: { ...j.request, playlist_id: req.playlist_id ?? j.request.playlist_id } }, false);
        this.hooks.status(`✓ Già scaricato: «${j.meta?.title ?? 'brano'}» è già nella libreria.`);
      } else this.hooks.status(j.status === 'QUEUED' ? '⬇ Download in coda.' : '⬇ Download avviato.');
      return j;
    } catch (e) {
      this.hooks.status(e instanceof DlError ? e.message : 'Download non riuscito.', true);
      return undefined;
    }
  }

  /**
   * «Scarica tutta la playlist» / «Scarica i selezionati»: every song in one request to the app (saved once,
   * started 2 at a time). Songs already offline are not asked again; one message sums it all up.
   */
  async downloadMany(reqs: DlRequest[], what = 'brani'): Promise<{ queued: number; already: number; failed: number }> {
    const r = { queued: 0, already: 0, failed: 0 };
    const ask: DlRequest[] = [];
    for (const q of reqs) {
      const yt = youtubeIdOf(q.url);
      if (yt && this.lib.isOffline(yt) && !(q.type === 'video' && !/video/.test(this.lib.get(yt)?.mime ?? ''))) r.already++; else ask.push(q);
    }
    if (ask.length) {
      try {
        const res = await this.c.createMany(ask);
        res.jobs.forEach((j, i) => {
          if (!j) { r.failed++; return; }
          this.apply(j);
          if (j.already) { r.already++; this.integrated.delete(j.id); void this.integrate(j, false); } else r.queued++;
          void i;
        });
      } catch (e) {
        this.hooks.status(e instanceof DlError ? e.message : 'Download non riuscito.', true);
        return { ...r, failed: r.failed + ask.length };
      }
    }
    const parts = [r.queued ? `⬇ ${r.queued} ${r.queued === 1 ? 'brano' : 'brani'} in coda per il download` : '', r.already ? `✓ ${r.already} già ${r.already === 1 ? 'scaricato' : 'scaricati'}` : '', r.failed ? `⚠ ${r.failed} non ${r.failed === 1 ? 'scaricabile' : 'scaricabili'}` : ''].filter(Boolean);
    this.hooks.status(parts.length ? `${parts.join(' · ')} (${what}). Segui l’avanzamento in «Download».` : `Niente da scaricare (${what}).`, !r.queued && !r.already);
    return r;
  }

  async cancel(id: string): Promise<void> { try { this.apply(await this.c.cancel(id)); } catch (e) { this.hooks.status((e as Error).message, true); } }
  async remove(id: string): Promise<void> {
    try { await this.c.remove(id); this.jobs.delete(id); this.version++; } catch (e) { this.hooks.status((e as Error).message, true); }
  }
  /** Tries a failed or cancelled download again (a new job with the same request). */
  async retry(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) return;
    await this.remove(id);
    await this.download(j.request);
  }
  async setMax(n: number): Promise<void> { try { this.cfg = await this.c.config(n); this.version++; } catch { /* keep the old value */ } }
}
