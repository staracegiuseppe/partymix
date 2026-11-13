export type Track = {
  videoId: string;
  title?: string;
  artist?: string;
  thumb?: string;
  durationSec?: number;
  /** Title and artist come separate and reliable (Spotify), so lyrics are searched with them as they are. */
  structured?: boolean;
  locked?: boolean;
  /** Added or substituted by the user, so a playlist refresh must never drop it. */
  manual?: boolean;
  status: 'ok' | 'unplayable' | 'pending';
};

type Opts = { shuffle?: boolean; repeat?: 'off' | 'all' | 'one'; rng?: () => number };

const playable = (t: Track) => t.status !== 'unplayable';

export class Queue {
  private order: Track[];
  private pos = -1;
  private hist: Track[] = [];
  private repeat: 'off' | 'all' | 'one';
  /** A track the user asked to play right after the current one, whatever the repeat mode says. */
  private forced?: string;

  constructor(tracks: Track[], opts: Opts = {}) {
    this.order = [...tracks];
    this.repeat = opts.repeat ?? 'off';
    if (opts.shuffle) {
      const rng = opts.rng ?? Math.random;
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
    this.reset();
  }

  private findFrom(start: number): number {
    for (let i = start; i < this.order.length; i++) if (playable(this.order[i])) return i;
    return -1;
  }

  private nextIndex(): number {
    if (this.forced) {
      const f = this.order.findIndex((t) => t.videoId === this.forced && playable(t));
      if (f >= 0 && f !== this.pos) return f;
      this.forced = undefined;
    }
    if (this.repeat === 'one' && this.pos >= 0 && playable(this.order[this.pos])) return this.pos;
    const i = this.findFrom(this.pos + 1);
    if (i >= 0) return i;
    return this.repeat === 'all' ? this.findFrom(0) : -1;
  }

  current(): Track | undefined { return this.pos >= 0 ? this.order[this.pos] : undefined; }
  peekNext(): Track | undefined { const i = this.nextIndex(); return i >= 0 ? this.order[i] : undefined; }

  advance(): Track | undefined {
    const i = this.nextIndex();
    if (i < 0) return undefined;
    this.pos = i;
    this.hist.push(this.order[i]);
    if (this.order[i].videoId === this.forced) this.forced = undefined;
    return this.order[i];
  }

  /** Makes the given track current (it was mixed in even if the queue was reordered meanwhile); falls back to advance(). */
  advanceTo(videoId: string): Track | undefined {
    // The same video can be in the playlist twice: take the occurrence that really comes next, not always the first one.
    const n = this.nextIndex();
    let i = n >= 0 && this.order[n].videoId === videoId ? n : this.order.findIndex((t, k) => k > this.pos && t.videoId === videoId && playable(t));
    if (i < 0) i = this.order.findIndex((t) => t.videoId === videoId && playable(t));
    if (i < 0) return this.advance();
    this.pos = i;
    this.hist.push(this.order[i]);
    if (videoId === this.forced) this.forced = undefined;
    return this.order[i];
  }

  /** Puts a track right after the current one and makes it the next to play. False when it cannot be played or is the current one. */
  cueNext(videoId: string): boolean {
    const i = this.order.findIndex((t) => t.videoId === videoId && playable(t));
    if (i < 0 || i === this.pos) return false;
    const cur = this.current();
    const [t] = this.order.splice(i, 1);
    const p = cur ? this.order.indexOf(cur) : -1;
    this.order.splice(p + 1, 0, t);
    this.pos = p;
    this.forced = videoId;
    return true;
  }

  /** Makes a track the current one (used to start the party from the track the user picked). */
  setCurrent(videoId: string): boolean {
    const i = this.order.findIndex((t) => t.videoId === videoId && playable(t));
    if (i < 0) return false;
    this.pos = i;
    this.hist = [this.order[i]];
    this.forced = undefined;
    return true;
  }

  skipNext(): Track | undefined {
    const cur = this.current();
    return cur?.locked ? cur : this.advance();
  }

  markUnplayable(videoId: string): void {
    for (const t of this.order) if (t.videoId === videoId) t.status = 'unplayable';
  }

  setLocked(videoId: string, v: boolean): void {
    for (const t of this.order) if (t.videoId === videoId) t.locked = v;
  }

  move(from: number, to: number): void {
    if (from < 0 || from >= this.order.length || to < 0 || to >= this.order.length) return;
    const cur = this.current();
    const [t] = this.order.splice(from, 1);
    this.order.splice(to, 0, t);
    if (cur) this.pos = this.order.indexOf(cur);
  }

  add(t: Track): void {
    this.order.push(t);
    if (this.pos < 0) {
      this.pos = this.findFrom(0);
      if (this.pos >= 0) this.hist.push(this.order[this.pos]);
    }
  }

  replace(oldVideoId: string, t: Track): void {
    const i = this.order.findIndex((x) => x.videoId === oldVideoId);
    if (i < 0) return;
    this.order[i] = t;
    if (this.pos < 0) this.reset();
  }

  /** Removes a track from the queue. The track that is playing cannot be removed. */
  remove(videoId: string): boolean {
    const i = this.order.findIndex((t) => t.videoId === videoId);
    if (i < 0 || i === this.pos) return false;
    this.order.splice(i, 1);
    if (i < this.pos) this.pos--;
    return true;
  }

  setRepeat(r: 'off' | 'all' | 'one'): void { this.repeat = r; }

  /** Shuffles the tracks after the current one; played tracks and the current one stay put. */
  shuffleUpcoming(rng: () => number = Math.random): void {
    const start = this.pos + 1;
    for (let i = this.order.length - 1; i > start; i--) {
      const j = start + Math.floor(rng() * (i - start + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
  }

  currentIndex(): number { return this.pos; }

  history(): Track[] { return [...this.hist]; }
  all(): Track[] { return [...this.order]; }

  reset(): void {
    this.forced = undefined;
    this.pos = this.findFrom(0);
    this.hist = this.pos >= 0 ? [this.order[this.pos]] : [];
  }
}
