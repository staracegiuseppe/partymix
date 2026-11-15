import type { KV } from './kv';
import { blobBytes } from './library';

/** Where the audio files of the library are kept. `ref` is what the library remembers to find the file again. */
export interface BlobStore {
  /** Saves the file; `hint` gives the folder and file name («Artista/Titolo.mp3») where that makes sense. */
  put(id: string, data: Blob, hint: { artist: string; title: string; ext: string }): Promise<string>;
  /** A link the audio player can open, or undefined when the file is gone. */
  url(ref: string): Promise<string | undefined>;
  delete(ref: string): Promise<void>;
  /** Forgets the link made by url() (frees memory); the file stays. */
  release(ref: string): void;
  /** The whole file (small files only: covers). */
  read(ref: string): Promise<Blob | undefined>;
  /** Where the files are, as the user sees it (shown in the library). */
  readonly where: string;
}

/** Browser (and fallback): the files live in IndexedDB. */
export class KvBlobStore implements BlobStore {
  readonly where = 'nel database dell’app';
  private urls = new Map<string, string>();
  constructor(private kv: KV) {}
  async put(id: string, data: Blob): Promise<string> {
    await this.kv.put('blobs', id, data);
    return id;
  }
  async url(ref: string): Promise<string | undefined> {
    const known = this.urls.get(ref);
    if (known) return known;
    const b = await this.kv.get<Blob>('blobs', ref);
    if (!b) return undefined;
    const u = URL.createObjectURL(b);
    this.urls.set(ref, u);
    return u;
  }
  release(ref: string): void {
    const u = this.urls.get(ref);
    if (u) { URL.revokeObjectURL(u); this.urls.delete(ref); }
  }
  async read(ref: string): Promise<Blob | undefined> { return this.kv.get<Blob>('blobs', ref); }
  async delete(ref: string): Promise<void> {
    this.release(ref);
    await this.kv.delete('blobs', ref);
  }
}

const MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const mimeOf = (path: string) => MIME[(/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase()] ?? '';

type Invoke = (cmd: string, args?: unknown, opts?: { headers: Record<string, string> }) => Promise<unknown>;
/** No slashes, dots or reserved characters: a name is one folder or file inside «PartyMix Library», nothing else. */
export const safeName = (s: string, fallback: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;

/**
 * Computer app: real files in the Music folder, «PartyMix Library/Artista/Titolo.mp3», so the music is the user's,
 * visible in Finder/Esplora risorse, and never limited by the space the web view grants to a site.
 */
export class NativeBlobStore implements BlobStore {
  readonly where = 'nella cartella Musica › PartyMix Library';
  private urls = new Map<string, string>();
  constructor(private invoke: Invoke, private toAsset?: (absolutePath: string) => string) {}
  async put(_id: string, data: Blob, hint: { artist: string; title: string; ext: string }): Promise<string> {
    const rel = `${safeName(hint.artist, 'Artista sconosciuto')}/${safeName(hint.title, 'Brano')}.${hint.ext || 'mp3'}`;
    const body = new Uint8Array(await blobBytes(data));
    try {
      return String(await this.invoke('lib_write', body, { headers: { 'x-path': encodeURIComponent(rel) } }));
    } catch (e) {
      if (/no space|spazio|quota|ENOSPC|os error 28/i.test(String(e))) throw Object.assign(new Error('Spazio insufficiente sul disco per salvare la musica.'), { kind: 'quota' });
      throw e;
    }
  }
  /**
   * A link the player streams from the disk (Tauri asset protocol): the file is read while it plays, so a 400 MB video
   * starts at once and does not fill the memory. Older app versions without it: the whole file through IPC.
   */
  async url(ref: string): Promise<string | undefined> {
    const known = this.urls.get(ref);
    if (known) return known;
    const root = await this.rootDir();
    if (root && this.toAsset) {
      const u = this.toAsset(`${root.replace(/\/+$/, '')}/${ref}`);
      this.urls.set(ref, u);
      return u;
    }
    const b = await this.read(ref);
    if (!b) return undefined;
    const u = URL.createObjectURL(b);
    this.urls.set(ref, u);
    return u;
  }
  async read(ref: string): Promise<Blob | undefined> {
    try {
      const bytes = await this.invoke('lib_read', { path: ref });
      const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes as number[]).buffer;
      return new Blob([buf], { type: mimeOf(ref) }); // WebKit needs the type to play MP4/WebM
    } catch {
      return undefined; // moved or deleted outside the app
    }
  }
  private root?: Promise<string | undefined>;
  private rootDir() { return (this.root ??= this.invoke('lib_root').then((r) => String(r), () => undefined)); }
  /** Frees the memory of a file that is not playing any more (files can be big, thousands of them would fill the RAM). */
  release(ref: string): void {
    const u = this.urls.get(ref);
    if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
    this.urls.delete(ref);
  }
  async delete(ref: string): Promise<void> {
    this.release(ref);
    await this.invoke('lib_delete', { path: ref });
  }
}
