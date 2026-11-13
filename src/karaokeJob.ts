import { FoundLyrics, TransientError } from './lyrics';
import type { LyricsStore } from './lyricsStore';

export type JobTrack = { id: string; title: string; artist: string; durationSec: number; structured: boolean };

export type JobState = {
  running: boolean;
  /** Songs this run has to look up / has looked up. */
  total: number;
  done: number;
  /** Waiting because a source asked to slow down. */
  waiting: boolean;
};

export type JobDeps = {
  store: LyricsStore;
  find(t: JobTrack): Promise<FoundLyrics | null>;
  onChange(): void;
  sleep?(ms: number): Promise<void>;
  concurrency?: number;
  /** Pause between two lookups of the same worker: the free lyric databases ask not to be hammered. */
  gapMs?: number;
  backoffMs?: number;
};

const MAX_TRIES = 3;

/**
 * Looks up the lyrics of every song of the playlist in the background, one after the other and politely,
 * and keeps them in the store, so each song is ready when it starts playing.
 * A source that is busy (rate limit, no network) is waited for; it never turns into a false "not found".
 */
export class KaraokeJob {
  private run = 0;
  private s: JobState = { running: false, total: 0, done: 0, waiting: false };
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: JobDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  state(): JobState { return { ...this.s }; }

  stop(): void { this.run++; if (this.s.running) { this.s = { ...this.s, running: false, waiting: false }; this.d.onChange(); } }

  /** Starts (or restarts) the search over `tracks`, in the given order. `retryMissing` also retries songs already marked "not found". */
  start(tracks: JobTrack[], retryMissing = false): void {
    const mine = ++this.run;
    const seen = new Set<string>();
    const todo = tracks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      const st = this.d.store.status(t.id);
      return st === undefined || (retryMissing && st === 'none');
    });
    this.s = { running: todo.length > 0, total: todo.length, done: 0, waiting: false };
    this.d.onChange();
    if (todo.length === 0) return;
    const queue = todo.map((t) => ({ t, tries: 0 }));
    const workers = Array.from({ length: Math.max(1, Math.min(this.d.concurrency ?? 2, todo.length)) }, () => this.worker(mine, queue));
    void Promise.all(workers).then(() => {
      if (mine !== this.run) return;
      this.d.store.flush();
      this.s = { ...this.s, running: false, waiting: false };
      this.d.onChange();
    });
  }

  private async worker(mine: number, queue: { t: JobTrack; tries: number }[]): Promise<void> {
    while (mine === this.run) {
      const item = queue.shift();
      if (!item) return;
      try {
        const found = await this.d.find(item.t);
        if (mine !== this.run) return;
        if (found) this.d.store.setFound(item.t.id, found); else this.d.store.setNone(item.t.id);
        this.s.done++;
      } catch (e) {
        if (mine !== this.run) return;
        if (e instanceof TransientError && ++item.tries < MAX_TRIES) {
          queue.push(item); // try again later, after the source has had a rest
          this.s = { ...this.s, waiting: true };
          this.d.onChange();
          await this.sleep(Math.max((this.d.backoffMs ?? 45_000) * item.tries, e.retryAfterMs));
          if (mine !== this.run) return;
          this.s = { ...this.s, waiting: false };
        } else {
          this.s.done++; // gave up for now: not stored as "not found", it is retried next time
        }
      }
      this.d.onChange();
      await this.sleep(this.d.gapMs ?? 700);
    }
  }
}
