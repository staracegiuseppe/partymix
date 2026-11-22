/**
 * «Volume uguale tra i brani»: every song comes out at the same perceived loudness, so the party never jumps up or
 * down between two songs.
 *
 * How loud a song is (LUFS, the perceived loudness):
 * - a YouTube video: YouTube publishes it in the watch page (`perceptualLoudnessDb`);
 * - a file (downloaded, imported, on the NAS): measured on the file.
 *
 * How loud it is HEARD differs: the embedded YouTube player already lowers the loud songs by itself (measured in the
 * player's «Stats for nerds»: content at -14 LUFS or more is brought to -19 LUFS), but it never raises a quiet one,
 * and a song between -19 and -14 is left as it is — that is the jump the user heard. A file plays as it is.
 * The app brings what is heard to TARGET: down when louder, up (at most HEADROOM) when quieter. To be able to raise
 * a quiet song, every song plays HEADROOM dB below the slider; a song of unknown loudness gets just that.
 */

export const TARGET_LUFS = -19;
export const HEADROOM_DB = 3;
const MAX_CUT_DB = 12;
/** YouTube's own normalisation (embedded player): from this loudness up, a song is played at YT_TARGET. */
const YT_REFERENCE = -14;
const YT_TARGET = -19;

export type Source = 'youtube' | 'file';

const dbToFactor = (db: number) => Math.pow(10, db / 20);

/** The loudness heard, given the song's own loudness and where it plays from. */
export function heardLufs(lufs: number, source: Source): number {
  return source === 'youtube' && lufs >= YT_REFERENCE ? YT_TARGET : lufs;
}

/** Volume factor (0..1) for a song: unknown loudness = the plain headroom. */
export function gainFactor(lufs: number | undefined, source: Source): number {
  if (lufs == null || !Number.isFinite(lufs)) return dbToFactor(-HEADROOM_DB);
  const g = Math.max(-MAX_CUT_DB, Math.min(HEADROOM_DB, TARGET_LUFS - heardLufs(lufs, source)));
  return dbToFactor(g - HEADROOM_DB);
}

/** The loudness YouTube publishes for a video, read from its watch page. */
export function parseYouTubeLoudness(html: string): number | undefined {
  const p = /"perceptualLoudnessDb":(-?\d+(?:\.\d+)?)/.exec(html);
  if (p) return Number(p[1]);
  // older pages: only the offset from YouTube's reference
  const l = /"loudnessDb":(-?\d+(?:\.\d+)?)/.exec(html);
  return l ? Number(l[1]) + YT_REFERENCE : undefined;
}

/**
 * Loudness of a file from its levels (one value every 0.25 s, `20·log10(rms·32768 + 1)` as main.ts measures them):
 * the mean energy of the music, without silence (absolute gate) and without the quiet parts (relative gate, -10 dB),
 * like the LUFS measure does.
 */
export function fileLufs(levels: number[]): number | undefined {
  const dbfs = levels.map((l) => l - 90.31).filter((d) => d > -70);
  if (dbfs.length < 8) return undefined;
  const meanDb = (xs: number[]) => 10 * Math.log10(xs.reduce((s, d) => s + Math.pow(10, d / 10), 0) / xs.length);
  const gate = meanDb(dbfs) - 10;
  const loud = dbfs.filter((d) => d > gate);
  return loud.length ? Math.round(meanDb(loud) * 10) / 10 : undefined;
}

/** Remembers the loudness of every song met (it never changes), on this device. */
export class LoudnessStore {
  private map: Record<string, number> = {};
  private pending = new Map<string, Promise<number | undefined>>();
  /** Songs whose loudness could not be read, and until when not to try again (no page downloaded at every load). */
  private misses = new Map<string, number>();
  private now: () => number;
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, private key = 'partymix.loudness.v1', now: () => number = Date.now) {
    this.now = now;
    try { this.map = JSON.parse(storage?.getItem(key) ?? '{}') ?? {}; } catch { this.map = {}; }
  }
  get(k: string): number | undefined { return this.map[k]; }
  /**
   * Known now, or measured once with `measure` (several asks for the same song share the same measure). A measure
   * that gives nothing is not tried again for `missMs`.
   */
  ensure(k: string, measure: () => Promise<number | undefined>, missMs = 6 * 3_600_000): Promise<number | undefined> {
    if (k in this.map) return Promise.resolve(this.map[k]);
    if ((this.misses.get(k) ?? 0) > this.now()) return Promise.resolve(undefined);
    let p = this.pending.get(k);
    if (!p) {
      p = measure().catch(() => undefined).then((v) => {
        this.pending.delete(k);
        if (v != null && Number.isFinite(v)) { this.set(k, v); this.misses.delete(k); } else this.misses.set(k, this.now() + missMs);
        return v;
      });
      this.pending.set(k, p);
    }
    return p;
  }
  private set(k: string, v: number) {
    this.map[k] = v;
    const keys = Object.keys(this.map);
    if (keys.length > 5000) for (const old of keys.slice(0, keys.length - 5000)) delete this.map[old];
    try { this.storage?.setItem(this.key, JSON.stringify(this.map)); } catch { /* full: kept for this session only */ }
  }
}

/** Runs jobs one at a time, in order (one page of YouTube at a time, never a burst at the start of a playlist). */
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const p = last.then(job, job);
    last = p.catch(() => undefined);
    return p;
  };
}
