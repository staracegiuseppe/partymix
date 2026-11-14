import type { Track } from '../queue';
import { cleanTrack, loadSaved } from '../savedPlaylists';
import type { Settings } from '../settings';
import type { KV } from './kv';

/** A playlist: as many as the user wants, each with as many songs as they want. */
export type Playlist = {
  id: string;
  name: string;
  tracks: Track[];
  /** Cover image (a thumbnail link); empty = the first song's thumbnail. */
  cover?: string;
  createdAt: number;
  updatedAt: number;
  description?: string;
  color?: string;
  /** Position in the user's own order (drag & drop in the side bar). */
  sortOrder: number;
  /** The YouTube or Spotify link it was loaded from, if any. */
  link?: string;
  source?: 'YouTube' | 'Spotify' | 'Locale';
  /** Songs the user took out: a refresh from YouTube must not bring them back. */
  removed?: string[];
};

export type PlaylistSort = 'custom' | 'name' | 'recent' | 'size';
export const SORT_LABEL: Record<PlaylistSort, string> = { custom: 'Ordine mio', name: 'Nome A→Z', recent: 'Modificate di recente', size: 'Più brani' };

type Deps = { now?: () => number; newId?: () => string; saveDelayMs?: number };
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function cleanPlaylist(v: unknown): Playlist | undefined {
  const p = v as Partial<Playlist> | null;
  if (!p || typeof p.id !== 'string' || !p.id) return undefined;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const out: Playlist = {
    id: p.id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 80) : 'Playlist',
    tracks: Array.isArray(p.tracks) ? p.tracks.map(cleanTrack).filter((t): t is Track => !!t) : [],
    createdAt: num(p.createdAt, 0),
    updatedAt: num(p.updatedAt, 0),
    sortOrder: num(p.sortOrder, 0),
    removed: Array.isArray(p.removed) ? p.removed.filter((x): x is string => typeof x === 'string') : [],
  };
  for (const k of ['cover', 'description', 'color', 'link'] as const) if (typeof p[k] === 'string' && p[k]) out[k] = p[k];
  if (p.source === 'YouTube' || p.source === 'Spotify' || p.source === 'Locale') out.source = p.source;
  return out;
}

/**
 * All the playlists, kept in memory and saved in IndexedDB (each one on its own key, so changing one song
 * of a 10 000-song playlist rewrites that playlist only, and a little later: several quick changes are one write).
 */
export class PlaylistStore {
  private byId = new Map<string, Playlist>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private now: () => number;
  private newId: () => string;
  private delay: number;
  /** Grows at every change: the side bar redraws only when it moved. */
  version = 0;

  constructor(private kv: KV, deps: Deps = {}) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomId;
    this.delay = deps.saveDelayMs ?? 400;
  }

  async load(): Promise<void> {
    const all = await this.kv.getAll<unknown>('playlists');
    this.byId.clear();
    for (const v of all) { const p = cleanPlaylist(v); if (p) this.byId.set(p.id, p); }
    this.changed();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(id?: string) {
    this.version++;
    if (id) { this.dirty.add(id); this.schedule(); }
    for (const fn of this.listeners) fn();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.delay);
  }

  /** Writes the pending changes now (also called when the window closes). Errors are reported, the data stays in memory. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const p = this.byId.get(id);
      try {
        if (p) await this.kv.put('playlists', id, p); else await this.kv.delete('playlists', id);
      } catch (e) {
        this.dirty.add(id); // try again with the next change
        throw e;
      }
    }
  }

  count(): number { return this.byId.size; }
  get(id: string | undefined): Playlist | undefined { return id ? this.byId.get(id) : undefined; }

  /** In the order chosen; `query` keeps the playlists whose name (or description) contains it, accents ignored. */
  list(sort: PlaylistSort = 'custom', query = ''): Playlist[] {
    const q = norm(query.trim());
    const all = [...this.byId.values()].filter((p) => !q || norm(p.name).includes(q) || norm(p.description ?? '').includes(q));
    const cmp: Record<PlaylistSort, (a: Playlist, b: Playlist) => number> = {
      custom: (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
      name: (a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base', numeric: true }),
      recent: (a, b) => b.updatedAt - a.updatedAt,
      size: (a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name, 'it'),
    };
    return all.sort(cmp[sort]);
  }

  /** A name nobody uses yet: «Playlist N», N one more than the playlists there are (or the first free after it). */
  freeName(base = 'Playlist'): string {
    const used = new Set([...this.byId.values()].map((p) => norm(p.name)));
    for (let n = this.byId.size + 1; ; n++) if (!used.has(norm(`${base} ${n}`))) return `${base} ${n}`;
  }

  create(name?: string, init: Partial<Omit<Playlist, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'>> = {}): Playlist {
    const t = this.now();
    const max = Math.max(-1, ...[...this.byId.values()].map((p) => p.sortOrder));
    const p: Playlist = { ...init, id: this.newId(), name: name?.trim().slice(0, 80) || this.freeName(), tracks: [...(init.tracks ?? [])], removed: [...(init.removed ?? [])], createdAt: t, updatedAt: t, sortOrder: max + 1 };
    this.byId.set(p.id, p);
    this.changed(p.id);
    return p;
  }

  private edit(id: string, fn: (p: Playlist) => void): Playlist | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    fn(p);
    p.updatedAt = this.now();
    this.changed(id);
    return p;
  }

  rename(id: string, name: string): boolean {
    const n = name.trim().slice(0, 80);
    if (!n) return false;
    return !!this.edit(id, (p) => { p.name = n; });
  }

  update(id: string, patch: Partial<Pick<Playlist, 'description' | 'color' | 'cover' | 'link' | 'source' | 'removed'>>): boolean {
    return !!this.edit(id, (p) => Object.assign(p, patch));
  }

  remove(id: string): boolean {
    if (!this.byId.delete(id)) return false;
    this.changed(id);
    return true;
  }

  /** A copy with the same songs, right after the original, called «… (copia)». */
  duplicate(id: string): Playlist | undefined {
    const src = this.byId.get(id);
    if (!src) return undefined;
    const copy = this.create(`${src.name} (copia)`, { tracks: src.tracks.map((t) => ({ ...t })), description: src.description, color: src.color, cover: src.cover, source: src.source, removed: src.removed });
    this.reorder(this.list('custom').map((p) => p.id).filter((x) => x !== copy.id).flatMap((x) => (x === id ? [x, copy.id] : [x])));
    return copy;
  }

  /** The user's own order of the playlists (drag & drop in the side bar). */
  reorder(ids: string[]): void {
    ids.forEach((id, i) => { const p = this.byId.get(id); if (p && p.sortOrder !== i) { p.sortOrder = i; this.dirty.add(id); } });
    this.changed();
    this.schedule();
  }

  /** Replaces the songs (in their play order). Play state (lock, «non riproducibile») is not kept. */
  setTracks(id: string, tracks: Track[], removed?: string[]): boolean {
    return !!this.edit(id, (p) => {
      p.tracks = tracks.map((t) => cleanTrack({ ...t, status: t.status === 'unplayable' ? 'unplayable' : 'ok' })).filter((t): t is Track => !!t);
      if (removed) p.removed = [...removed];
    });
  }

  /** Adds songs at the end; a song already in the playlist is not added twice. */
  addTracks(id: string, tracks: Track[]): { added: number; duplicates: number } {
    const p = this.byId.get(id);
    if (!p) return { added: 0, duplicates: 0 };
    const have = new Set(p.tracks.map((t) => t.videoId));
    const fresh: Track[] = [];
    for (const t of tracks) {
      const c = cleanTrack(t);
      if (!c || have.has(c.videoId)) continue;
      have.add(c.videoId);
      fresh.push(c);
    }
    if (fresh.length) this.edit(id, (x) => { x.tracks.push(...fresh); x.removed = (x.removed ?? []).filter((r) => !have.has(r)); });
    return { added: fresh.length, duplicates: tracks.length - fresh.length };
  }

  removeTrack(id: string, videoId: string): boolean {
    let done = false;
    this.edit(id, (p) => { const n = p.tracks.length; p.tracks = p.tracks.filter((t) => t.videoId !== videoId); done = p.tracks.length < n; });
    return done;
  }

  moveTrack(id: string, from: number, to: number): boolean {
    const p = this.byId.get(id);
    if (!p || from < 0 || to < 0 || from >= p.tracks.length || to >= p.tracks.length || from === to) return false;
    this.edit(id, (x) => { const [t] = x.tracks.splice(from, 1); x.tracks.splice(to, 0, t); });
    return true;
  }

  /** Every playlist that has this song (used to show where a library song is, and by «Elimina download»). */
  containing(videoId: string): Playlist[] { return [...this.byId.values()].filter((p) => p.tracks.some((t) => t.videoId === videoId)); }
}

/**
 * Up to 1.6 the app had four fixed playlists (links in the settings, songs in `partymix.playlist.<slot>`).
 * The first time the new store is empty they become ordinary playlists, in the same order; the one in use stays in use.
 */
export function migrateLegacy(store: PlaylistStore, settings: Settings, ls: Storage | undefined): string | undefined {
  if (store.count() > 0) return undefined;
  let current: string | undefined;
  settings.playlists.forEach((link, slot) => {
    const saved = loadSaved(ls, slot);
    if (!link && !saved) return;
    const name = settings.playlistNames[slot]?.trim() || saved?.name || `Playlist ${slot + 1}`;
    const p = store.create(name, { link: link || saved?.link, source: saved?.source, tracks: saved && (!link || saved.link === link) ? saved.tracks : [], removed: saved?.removed });
    if (slot === settings.playlistSlot) current = p.id;
  });
  return current ?? store.list()[0]?.id;
}
