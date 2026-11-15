import type { Track } from '../queue';
import type { BlobStore } from './blobStore';
import { extOf, kindOfName, metaFromName, readId3, sniffAudio } from './id3';
import type { KV } from './kv';

/** What the user sees next to a song: ☁ only on the internet, ✓ on this computer, ⬇ being saved, ⚠ something went wrong. */
export type OfflineState = 'online' | 'offline' | 'downloading' | 'error';

export type LibEntry = {
  /** `local:<hash>` for a file, or the YouTube video id for a YouTube song. */
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec?: number;
  /** Bytes of the local copy. */
  size?: number;
  favorite?: boolean;
  /** file = imported from the computer, url = downloaded from a link to an audio file, youtube = a YouTube video,
   *  download = fetched by the download manager (yt-dlp). */
  source: 'file' | 'url' | 'youtube' | 'download';
  /** download: «audio/mpeg», «video/mp4»… */
  mime?: string;
  /** The link it was downloaded from (url) or nothing. */
  url?: string;
  /** Where the local copy is (see BlobStore); none = no local copy. */
  file?: string;
  /** Where the file came from on the computer when it was imported («Cartella/brano.mp3»), shown for information only. */
  origin?: string;
  /** Picture from the file's tags, or the YouTube thumbnail link. */
  cover?: Blob;
  thumb?: string;
  addedAt: number;
  /** Not saved for long: a download in progress or the last error, in words for the user. */
  state?: 'downloading' | 'error';
  progress?: number;
  error?: string;
};

export type ImportReport = { added: LibEntry[]; duplicates: string[]; invalid: { name: string; reason: string }[]; stopped?: string };

type Deps = {
  kv: KV;
  blobs: BlobStore;
  /** Length in seconds by opening the file in an audio player; rejects when the player cannot read it (corrupt file). */
  probe?: (data: Blob) => Promise<number | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
};

const HEAD = 256 * 1024;
/** How many decoded files are kept ready in memory (the two decks, plus a little margin). */
const KEEP_URLS = 4;

/** `local:<hash>` for a link (a download from a site that is not YouTube). */
export async function idForUrl(url: string): Promise<string> { return `local:${await digest(new TextEncoder().encode(url))}`; }

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const h = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
    return [...h.subarray(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let a = 0x811c9dc5, b = 0x01000193; // FNV-1a, twice with different seeds: only where WebCrypto is missing
  for (const x of bytes) { a = Math.imul(a ^ x, 0x01000193) >>> 0; b = Math.imul(b ^ x, 0x811c9dc5) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The bytes of a file (FileReader where Blob.arrayBuffer is missing: older web views). */
export function blobBytes(b: Blob): Promise<ArrayBuffer> {
  if (typeof b.arrayBuffer === 'function') return b.arrayBuffer();
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = () => ko(r.error); r.readAsArrayBuffer(b); });
}
const bytesOf = async (b: Blob, from = 0, to = b.size) => new Uint8Array(await blobBytes(b.slice(from, to)));

/** Same file = same id: the first MB, the last 64 kB and the size, so a 10 MB file is not read twice just to compare it. */
export async function fileId(b: Blob): Promise<string> {
  const head = await bytesOf(b, 0, Math.min(b.size, 1 << 20));
  const tail = b.size > 1 << 20 ? await bytesOf(b, Math.max(1 << 20, b.size - 65536)) : new Uint8Array();
  const size = new TextEncoder().encode(String(b.size));
  const all = new Uint8Array(head.length + tail.length + size.length);
  all.set(head); all.set(tail, head.length); all.set(size, head.length + tail.length);
  return `local:${await digest(all)}`;
}

/** Words for the user, never a raw technical error. */
export function friendly(e: unknown): string {
  const k = (e as { kind?: string; name?: string } | null);
  if (k?.kind === 'quota' || k?.name === 'QuotaExceededError') return 'Spazio insufficiente sul disco: libera spazio e riprova.';
  if (k?.name === 'AbortError') return 'Download interrotto.';
  if (e instanceof TypeError && /fetch|network|load failed|connection/i.test(e.message)) return 'Rete assente o indirizzo non raggiungibile.';
  const m = (e as Error)?.message;
  return m && !/^[A-Z][a-zA-Z]+Error\b/.test(m) ? m : 'Errore imprevisto: riprova.';
}

/** The local music library: songs imported from the computer or downloaded, plus YouTube songs the user kept. */
export class MusicLibrary {
  private byId = new Map<string, LibEntry>();
  private aborts = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private recentUrls: string[] = [];
  private now: () => number;
  version = 0;

  constructor(private d: Deps) { this.now = d.now ?? Date.now; }

  get where(): string { return this.d.blobs.where; }

  async load(): Promise<void> {
    this.byId.clear();
    for (const v of await this.d.kv.getAll<LibEntry>('library')) {
      if (!v || typeof v.id !== 'string') continue;
      if (v.state === 'downloading') { v.state = 'error'; v.error = 'Download interrotto (l’app è stata chiusa): riprova.'; }
      delete v.progress;
      this.byId.set(v.id, v);
    }
    this.changed();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { this.version++; for (const fn of this.listeners) fn(); }
  private async save(e: LibEntry) {
    const { progress: _p, ...keep } = e;
    await this.d.kv.put('library', e.id, keep);
  }

  all(): LibEntry[] { return [...this.byId.values()].sort((a, b) => a.addedAt - b.addedAt); }
  get(id: string): LibEntry | undefined { return this.byId.get(id); }
  size(): number { return this.byId.size; }
  bytes(): number { let n = 0; for (const e of this.byId.values()) if (e.file) n += e.size ?? 0; return n; }

  /** A local copy exists: the song plays without any network. */
  isOffline(id: string): boolean { return !!this.byId.get(id)?.file; }
  stateOf(id: string): OfflineState {
    const e = this.byId.get(id);
    if (!e) return id.startsWith('local:') ? 'error' : 'online';
    if (e.state === 'downloading') return 'downloading';
    if (e.file) return 'offline';
    if (e.state === 'error' || e.source === 'file' || id.startsWith('local:')) return 'error';
    return 'online';
  }
  errorOf(id: string): string | undefined {
    const e = this.byId.get(id);
    if (!e) return id.startsWith('local:') ? 'Il file non è più nella libreria.' : undefined;
    if (e.source === 'file' && !e.file) return 'Il file è stato eliminato: importalo di nuovo.';
    if (e.source === 'download' && !e.file && id.startsWith('local:')) return 'Il file è stato eliminato: scaricalo di nuovo.';
    return e.state === 'error' ? e.error : undefined;
  }
  progressOf(id: string): number | undefined { return this.byId.get(id)?.progress; }

  toTrack(e: LibEntry): Track {
    const t: Track = { videoId: e.id, title: e.title, artist: e.artist, status: 'ok', manual: true };
    if (e.album) t.album = e.album;
    if (e.durationSec) t.durationSec = e.durationSec;
    if (e.thumb) t.thumb = e.thumb;
    return t;
  }

  artists(): { name: string; count: number }[] { return this.groups((e) => e.artist || 'Artista sconosciuto'); }
  albums(): { name: string; count: number }[] { return this.groups((e) => e.album || ''); }
  private groups(key: (e: LibEntry) => string) {
    const m = new Map<string, number>();
    for (const e of this.byId.values()) { const k = key(e); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  }

  /**
   * Imports audio files (one, many, or a whole folder): each is checked (really audio? already there?), its tags are read,
   * and it is copied into the library. No limit on how many; one at a time, so thousands of files do not fill the memory.
   */
  async importFiles(files: ArrayLike<File>, onProgress?: (done: number, total: number, name: string) => void): Promise<ImportReport> {
    const r: ImportReport = { added: [], duplicates: [], invalid: [] };
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      onProgress?.(i, list.length, f.name);
      if (!kindOfName(f.name)) { if (!/^\./.test(f.name)) r.invalid.push({ name: f.name, reason: 'non è un file audio (MP3, M4A, OGG, FLAC, WAV)' }); continue; }
      try {
        const e = await this.importOne(f);
        if (e === 'duplicate') r.duplicates.push(f.name); else r.added.push(e);
      } catch (err) {
        const reason = friendly(err);
        if ((err as { kind?: string }).kind === 'quota') { r.stopped = reason; break; } // the next files would not fit either
        r.invalid.push({ name: f.name, reason });
      }
    }
    onProgress?.(list.length, list.length, '');
    return r;
  }

  private async importOne(f: File): Promise<LibEntry | 'duplicate'> {
    if (f.size === 0) throw new Error('il file è vuoto');
    let head = await bytesOf(f, 0, Math.min(f.size, HEAD));
    const kind = sniffAudio(head);
    if (!kind) throw new Error('il file non è valido o è danneggiato');
    const id = await fileId(f);
    if (this.byId.get(id)?.file) return 'duplicate';
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // ID3 bigger than what was read (big cover): read the whole tag
      const tagEnd = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
      if (tagEnd > head.length && tagEnd < 16 << 20) head = await bytesOf(f, 0, Math.min(f.size, tagEnd));
    }
    const tags = kind === 'mp3' ? readId3(head) : {};
    const folder = (f as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/').slice(-2, -1)[0];
    const byName = metaFromName(f.name, folder);
    let durationSec = tags.durationSec;
    if (this.d.probe) {
      try { durationSec = (await this.d.probe(f)) ?? durationSec; } catch { throw new Error('il file è danneggiato: non si riesce a riprodurre'); }
    }
    const e: LibEntry = {
      id, source: 'file', addedAt: this.now(), size: f.size, origin: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      title: tags.title || byName.title || f.name, artist: tags.artist || byName.artist || '', album: tags.album || '',
      ...(durationSec ? { durationSec } : {}),
      ...(tags.cover ? { cover: new Blob([tags.cover.data as BlobPart], { type: tags.cover.mime }) } : {}),
    };
    const old = this.byId.get(id);
    if (old) e.favorite = old.favorite;
    e.file = await this.d.blobs.put(id, f, { artist: e.artist || 'Artista sconosciuto', title: e.title, ext: extOf(f.name) || kind });
    this.byId.set(id, e);
    await this.save(e);
    this.changed();
    return e;
  }

  /** Keeps a YouTube song in the library (online: it needs the internet to play). */
  addOnline(t: Track): LibEntry {
    const have = this.byId.get(t.videoId);
    if (have) return have;
    const e: LibEntry = { id: t.videoId, title: t.title || `Video ${t.videoId}`, artist: t.artist ?? '', album: t.album ?? '', source: 'youtube', addedAt: this.now() };
    if (t.durationSec) e.durationSec = t.durationSec;
    if (t.thumb) e.thumb = t.thumb;
    this.byId.set(e.id, e);
    void this.save(e).catch(() => {});
    this.changed();
    return e;
  }

  /**
   * Makes a song available offline with the user's own audio file of it (YouTube does not allow downloading its videos).
   * From then on the song plays from the file, also without network.
   */
  async linkFile(id: string, f: File, base?: Track): Promise<LibEntry> {
    if (!base && !this.byId.has(id)) throw new Error('Brano non trovato.');
    const e = this.byId.get(id) ?? this.addOnline(base!);
    const head = await bytesOf(f, 0, Math.min(f.size, HEAD));
    const kind = sniffAudio(head);
    if (!f.size || !kind) throw new Error('Il file scelto non è un audio valido.');
    if (this.d.probe) { try { await this.d.probe(f); } catch { throw new Error('Il file scelto è danneggiato.'); } }
    if (e.file) await this.d.blobs.delete(e.file).catch(() => {});
    e.file = await this.d.blobs.put(id, f, { artist: e.artist || 'Artista sconosciuto', title: e.title, ext: extOf(f.name) || kind });
    e.size = f.size;
    delete e.state; delete e.error;
    await this.save(e);
    this.changed();
    return e;
  }

  /** Downloads an audio file from a link (e.g. from the user's own NAS or a free-music site), with progress and cancel. */
  async downloadUrl(url: string, meta: { title?: string; artist?: string; album?: string } = {}): Promise<LibEntry> {
    let u: URL;
    try { u = new URL(url.trim()); } catch { throw new Error('Link non valido.'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Link non valido.');
    const id = `local:${await digest(new TextEncoder().encode(u.href))}`;
    const have = this.byId.get(id);
    if (have?.file) throw Object.assign(new Error('Questo brano è già nella libreria.'), { kind: 'duplicate' });
    if (have?.state === 'downloading') return have;
    const name = decodeURIComponent(u.pathname.split('/').pop() || 'brano');
    const byName = metaFromName(name);
    const e: LibEntry = have ?? { id, source: 'url', url: u.href, addedAt: this.now(), title: meta.title || byName.title || name, artist: meta.artist || byName.artist || '', album: meta.album || '' };
    e.state = 'downloading'; e.progress = 0; delete e.error;
    this.byId.set(id, e);
    await this.save(e).catch(() => {});
    this.changed();
    const ctl = new AbortController();
    this.aborts.set(id, ctl);
    try {
      const res = await (this.d.fetch ?? fetch)(u.href, { signal: ctl.signal });
      if (!res.ok) throw new Error(res.status === 404 ? 'File non trovato a quel link.' : `Il server ha rifiutato il download (${res.status}).`);
      const total = Number(res.headers.get('content-length')) || 0;
      const parts: Uint8Array[] = [];
      let got = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.length;
          if (total) { e.progress = Math.min(0.99, got / total); this.changed(); }
        }
      } else parts.push(new Uint8Array(await blobBytes(await res.blob())));
      if (total && got && got < total) throw new Error('Download interrotto: il file è arrivato a metà.');
      const blob = new Blob(parts as BlobPart[]);
      const head = await bytesOf(blob, 0, Math.min(blob.size, HEAD));
      const kind = sniffAudio(head);
      if (!kind) throw new Error('Il link non porta a un file audio valido.');
      const tags = kind === 'mp3' ? readId3(head) : {};
      if (!meta.title && tags.title) e.title = tags.title;
      if (!meta.artist && tags.artist) e.artist = tags.artist;
      if (!meta.album && tags.album) e.album = tags.album;
      if (tags.cover) e.cover = new Blob([tags.cover.data as BlobPart], { type: tags.cover.mime });
      if (this.d.probe) { try { e.durationSec = (await this.d.probe(blob)) ?? tags.durationSec; } catch { throw new Error('Il file scaricato è danneggiato.'); } }
      e.file = await this.d.blobs.put(id, blob, { artist: e.artist || 'Artista sconosciuto', title: e.title, ext: extOf(name) || kind });
      e.size = blob.size;
      delete e.state; delete e.progress;
    } catch (err) {
      e.state = 'error'; delete e.progress;
      e.error = friendly(err);
    } finally {
      this.aborts.delete(id);
    }
    await this.save(e).catch(() => {});
    this.changed();
    if (e.state === 'error') throw new Error(e.error);
    return e;
  }

  cancel(id: string): void { this.aborts.get(id)?.abort(); }

  /**
   * A file finished by the download manager joins the library (offline at once). A YouTube video keeps its video id,
   * so the same song in the playlists becomes ✓ offline too. The thumbnail saved next to it becomes the cover.
   */
  async addDownloaded(d: { id: string; title: string; artist?: string; album?: string; durationSec?: number; file: string; size: number; url: string; mime?: string; thumb?: string; thumbFile?: string; origin?: string }): Promise<LibEntry> {
    const old = this.byId.get(d.id);
    const e: LibEntry = {
      ...(old ?? { addedAt: this.now() }),
      id: d.id, source: 'download', url: d.url, file: d.file, size: d.size,
      title: d.title || old?.title || 'Brano', artist: d.artist || old?.artist || '', album: d.album || old?.album || '',
    } as LibEntry;
    if (d.durationSec) e.durationSec = d.durationSec;
    if (d.mime) e.mime = d.mime;
    if (d.thumb) e.thumb = d.thumb;
    if (d.origin) e.origin = d.origin;
    delete e.state; delete e.error; delete e.progress;
    if (d.thumbFile && !e.cover) {
      try {
        const b = await this.d.blobs.read(d.thumbFile);
        if (b) e.cover = b;
      } catch { /* the picture is a nice-to-have */ }
    }
    this.byId.set(e.id, e);
    await this.save(e);
    this.changed();
    return e;
  }

  toggleFavorite(id: string, base?: Track): boolean {
    const e = this.byId.get(id) ?? (base ? this.addOnline(base) : undefined);
    if (!e) return false;
    e.favorite = !e.favorite;
    void this.save(e).catch(() => {});
    this.changed();
    return e.favorite;
  }

  /** Removes the local copy only: the song stays in the library and in every playlist (online again, if it has a source). */
  async deleteDownload(id: string): Promise<void> {
    const e = this.byId.get(id);
    if (!e?.file) return;
    await this.d.blobs.delete(e.file).catch(() => {});
    delete e.file; delete e.size; delete e.state; delete e.error;
    await this.save(e);
    this.changed();
  }

  /** Takes a song out of the library (and deletes its local copy). Playlists that have it keep it. */
  async remove(id: string): Promise<void> {
    const e = this.byId.get(id);
    if (!e) return;
    this.cancel(id);
    if (e.file) await this.d.blobs.delete(e.file).catch(() => {});
    this.byId.delete(id);
    await this.d.kv.delete('library', id);
    this.changed();
  }

  /** A link the audio deck can play, for a song with a local copy. Only the last few stay in memory. */
  async urlFor(id: string): Promise<string | undefined> {
    const e = this.byId.get(id);
    if (!e?.file) return undefined;
    const u = await this.d.blobs.url(e.file);
    if (!u) return undefined;
    this.recentUrls = [e.file, ...this.recentUrls.filter((r) => r !== e.file)];
    for (const old of this.recentUrls.splice(KEEP_URLS)) this.d.blobs.release(old);
    return u;
  }
}

/** Opens the file in a hidden audio player to learn its length; a file the player cannot open is damaged. */
export function probeWithAudio(data: Blob, timeoutMs = 10000): Promise<number | undefined> {
  return new Promise((ok, ko) => {
    const a = new Audio();
    const u = URL.createObjectURL(data);
    const done = (fn: () => void) => { clearTimeout(t); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(u); fn(); };
    const t = setTimeout(() => done(() => ok(undefined)), timeoutMs); // slow to answer: keep the file, the length comes later
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(() => ok(Number.isFinite(a.duration) ? a.duration : undefined));
    a.onerror = () => done(() => ko(new Error('audio non leggibile')));
    a.src = u;
  });
}
