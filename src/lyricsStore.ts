import type { FoundLyrics, LrcLine } from './lyrics';

type Stored = { at: number; source: string; synced?: [number, string][]; plain?: string; trackDuration?: number };
type Disk = { v: 1; found: Record<string, Stored>; none: Record<string, number> };

export type LyricsStatus = 'synced' | 'plain' | 'none';

const KEY = 'partymix.lyrics.v1';
const MAX_FOUND = 400;
const MAX_NONE = 1000;
/** A song with no lyrics is looked up again after this long (databases grow). */
export const NONE_RETRY_MS = 3 * 24 * 3600 * 1000;

/** Lyrics found by the background search, kept between runs so a song is looked up only once. */
export class LyricsStore {
  private d: Disk = { v: 1, found: {}, none: {} };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private storage?: Storage, private now: () => number = () => Date.now()) {
    try {
      const raw = storage?.getItem(KEY);
      const j = raw ? JSON.parse(raw) : undefined;
      if (j && j.v === 1 && typeof j.found === 'object' && typeof j.none === 'object') this.d = { v: 1, found: j.found ?? {}, none: j.none ?? {} };
    } catch { /* start empty */ }
  }

  get(id: string): FoundLyrics | undefined {
    const e = this.d.found[id];
    if (!e) return undefined;
    const synced: LrcLine[] | undefined = e.synced?.map(([t, text]) => ({ t, text }));
    return { source: e.source, synced: synced?.length ? synced : undefined, plain: e.plain, trackDuration: e.trackDuration };
  }

  /** What is known about a song: its kind of lyrics, 'none' while a "not found" is still fresh, undefined when it should be looked up. */
  status(id: string): LyricsStatus | undefined {
    const e = this.d.found[id];
    if (e) return e.synced?.length ? 'synced' : 'plain';
    const n = this.d.none[id];
    return n !== undefined && this.now() - n < NONE_RETRY_MS ? 'none' : undefined;
  }

  setFound(id: string, f: FoundLyrics): void {
    delete this.d.none[id];
    this.d.found[id] = {
      at: this.now(), source: f.source,
      ...(f.synced?.length ? { synced: f.synced.map((l): [number, string] => [Math.round(l.t * 100) / 100, l.text]) } : {}),
      ...(f.plain && !f.synced?.length ? { plain: f.plain } : {}),
      ...(f.trackDuration ? { trackDuration: f.trackDuration } : {}),
    };
    this.trim();
    this.save();
  }

  setNone(id: string): void {
    if (this.d.found[id]) return;
    this.d.none[id] = this.now();
    this.trim();
    this.save();
  }

  forget(id: string): void { delete this.d.found[id]; delete this.d.none[id]; this.save(); }

  private trim(): void {
    const f = Object.entries(this.d.found);
    if (f.length > MAX_FOUND) for (const [k] of f.sort((a, b) => a[1].at - b[1].at).slice(0, f.length - MAX_FOUND)) delete this.d.found[k];
    const n = Object.entries(this.d.none);
    if (n.length > MAX_NONE) for (const [k] of n.sort((a, b) => a[1] - b[1]).slice(0, n.length - MAX_NONE)) delete this.d.none[k];
  }

  /** Writes soon, not on every song: a long playlist would otherwise rewrite the whole archive hundreds of times. */
  private save(): void {
    if (!this.storage || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 1500);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { this.storage?.setItem(KEY, JSON.stringify(this.d)); } catch { /* storage full or unavailable: keep working in memory */ }
  }
}
