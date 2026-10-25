import { crossfadeGains, Profile, profileSeconds } from './crossfade';
import type { log as Log } from './log';
import type { Queue } from './queue';

export interface Deck {
  load(videoId: string): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  setVolume(v0to100: number): void;
  position(): number;
  duration(): number;
  onEnded(cb: () => void): void;
  onError(cb: (code: number) => void): void;
}

export type AutomixState = 'idle' | 'playing' | 'preparing' | 'crossfading' | 'paused';
type NextState = 'none' | 'loading' | 'ready';
type DeckIdx = 0 | 1;

export type AutomixDeps = {
  decks: [Deck, Deck];
  queue: Queue;
  profile: () => Profile;
  masterVolume: () => number;
  deckVolume?: (i: DeckIdx) => number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  log: typeof Log;
};

const TICK_MS = 250;
const LOAD_TIMEOUT_MS = 5000;
const MANUAL_MIX_S = 8;

export class Automix {
  private st: AutomixState = 'idle';
  private pausedFrom: AutomixState = 'idle';
  private active: DeckIdx = 0;
  private mixIn: DeckIdx = 1;
  private nextState: NextState = 'none';
  private token = 0;
  private preparedId?: string;
  private timer?: number;
  private lastNow = 0;
  private mixElapsed = 0;
  private mixDur = 0;
  private dueSince?: number;
  private pending?: { ms: number };
  private applied: [number, number] = [-1, -1];

  constructor(private d: AutomixDeps) {
    d.decks.forEach((deck, i) => {
      deck.onEnded(() => this.handleEnded(i as DeckIdx));
      deck.onError((code) => this.handleError(i as DeckIdx, code));
    });
  }

  state(): AutomixState { return this.st; }
  activeDeck(): DeckIdx { return this.active; }

  nextStatus(): NextState { return this.nextState; }

  /** 0 when no crossfade is running, otherwise 0..1. */
  mixProgress(): number {
    if (this.st !== 'crossfading' && !(this.st === 'paused' && this.pausedFrom === 'crossfading')) return 0;
    return this.mixDur > 0 ? Math.min(1, this.mixElapsed / this.mixDur) : 1;
  }

  start(): void {
    if (this.st !== 'idle') return;
    const tok = ++this.token;
    this.active = 0;
    this.mixIn = 1;
    this.resetNext();
    void this.startCurrent(tok);
  }

  private async startCurrent(tok: number): Promise<void> {
    this.st = 'preparing';
    for (;;) {
      const cur = this.d.queue.current();
      if (!cur) { this.goIdle('queue.empty'); return; }
      try {
        await this.d.decks[this.active].load(cur.videoId);
      } catch (e) {
        if (tok !== this.token) return;
        this.d.log('warn', 'deck.load_failed', { videoId: cur.videoId, error: String(e) });
        this.d.queue.markUnplayable(cur.videoId);
        if (!this.d.queue.advance()) { this.goIdle('queue.exhausted'); return; }
        continue;
      }
      if (tok !== this.token) return;
      this.applied = [-1, -1];
      this.d.decks[this.active].play();
      this.st = 'playing';
      this.lastNow = this.d.now();
      this.applyVolumes();
      this.schedule();
      this.prepare();
      this.d.log('info', 'automix.started', { videoId: cur.videoId });
      return;
    }
  }

  pause(): void {
    if (this.st === 'idle' || this.st === 'paused') return;
    this.pausedFrom = this.st;
    this.st = 'paused';
    this.clearTick();
    this.d.decks[this.active].pause();
    if (this.pausedFrom === 'crossfading') this.d.decks[this.mixIn].pause();
  }

  resume(): void {
    if (this.st !== 'paused') return;
    this.st = this.pausedFrom;
    this.lastNow = this.d.now();
    this.d.decks[this.active].play();
    if (this.st === 'crossfading') this.d.decks[this.mixIn].play();
    this.schedule();
  }

  stop(): void {
    this.token++;
    this.clearTick();
    this.d.decks.forEach((k) => k.stop());
    this.d.queue.reset();
    this.resetNext();
    this.st = 'idle';
    this.active = 0;
    this.mixIn = 1;
    this.d.log('info', 'automix.stopped');
  }

  next(): void {
    if (this.st === 'crossfading') { this.finishMix(); return; }
    if (this.st !== 'playing' && this.st !== 'preparing') return;
    if (this.d.queue.current()?.locked) { this.d.log('info', 'automix.next_blocked_locked'); return; }
    this.switchWhenReady(0);
  }

  mixNow(): void {
    if (this.st !== 'playing' && this.st !== 'preparing') return;
    const sec = profileSeconds(this.d.profile()) ?? MANUAL_MIX_S;
    this.switchWhenReady(sec * 1000);
  }

  private switchWhenReady(ms: number): void {
    if (this.nextState === 'ready') this.beginMix(ms);
    else if (this.nextState === 'loading') this.pending = { ms };
    else this.goIdle('queue.end');
  }

  private resetNext(): void {
    this.nextState = 'none';
    this.preparedId = undefined;
    this.pending = undefined;
    this.dueSince = undefined;
  }

  private prepare(): void {
    const tok = ++this.token;
    const track = this.d.queue.peekNext();
    if (!track) { this.nextState = 'none'; this.preparedId = undefined; return; }
    this.nextState = 'loading';
    this.preparedId = track.videoId;
    const inIdx = (1 - this.active) as DeckIdx;
    this.d.decks[inIdx].load(track.videoId).then(
      () => {
        if (tok !== this.token) return;
        this.nextState = 'ready';
        this.dueSince = undefined;
        if (this.pending && (this.st === 'playing' || this.st === 'preparing')) {
          const { ms } = this.pending;
          this.pending = undefined;
          this.beginMix(ms);
        }
      },
      (e) => {
        if (tok !== this.token) return;
        this.d.log('warn', 'deck.prepare_failed', { videoId: track.videoId, error: String(e) });
        this.d.queue.markUnplayable(track.videoId);
        this.prepare();
      },
    );
  }

  private beginMix(ms: number): void {
    if (this.st === 'crossfading') return;
    const sec = this.d.decks[this.active].duration() - this.d.decks[this.active].position();
    const dur = ms > 0 ? Math.min(ms, Math.max(sec * 1000, 1000)) : 0;
    this.mixIn = (1 - this.active) as DeckIdx;
    this.st = 'crossfading';
    this.mixElapsed = 0;
    this.mixDur = dur;
    this.lastNow = this.d.now();
    this.dueSince = undefined;
    this.d.decks[this.mixIn].play();
    this.applyVolumes();
    this.d.log('info', 'automix.crossfade_start', { ms: dur });
    if (dur <= 0) this.finishMix();
  }

  private finishMix(): void {
    const out = this.active;
    this.d.decks[out].stop();
    this.d.decks[out].setVolume(0);
    this.applied[out] = 0;
    if (this.preparedId) this.d.queue.advanceTo(this.preparedId); else this.d.queue.advance();
    this.active = this.mixIn;
    this.mixIn = out;
    this.st = 'playing';
    this.resetNext();
    this.applyVolumes();
    this.d.log('info', 'automix.crossfade_done', { videoId: this.d.queue.current()?.videoId });
    this.prepare();
  }

  private base(i: DeckIdx): number {
    return this.d.masterVolume() * (this.d.deckVolume?.(i) ?? 1);
  }

  private setVol(i: DeckIdx, v: number): void {
    const r = Math.max(0, Math.min(100, Math.round(v)));
    if (this.applied[i] === r) return;
    this.applied[i] = r;
    this.d.decks[i].setVolume(r);
  }

  private applyVolumes(): void {
    if (this.st === 'crossfading') {
      const p = this.mixDur > 0 ? this.mixElapsed / this.mixDur : 1;
      const g = crossfadeGains(p);
      this.setVol(this.active, this.base(this.active) * g.out);
      this.setVol(this.mixIn, this.base(this.mixIn) * g.in);
    } else if (this.st === 'playing' || this.st === 'preparing') {
      this.setVol(this.active, this.base(this.active));
    }
  }

  private schedule(): void {
    this.clearTick();
    this.timer = this.d.setTimer(() => {
      this.timer = undefined;
      this.tick();
      if (this.st !== 'idle' && this.st !== 'paused') this.schedule();
    }, TICK_MS);
  }

  private clearTick(): void {
    if (this.timer !== undefined) this.d.clearTimer(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const n = this.d.now();
    const dt = n - this.lastNow;
    this.lastNow = n;
    if (this.st === 'crossfading') {
      this.mixElapsed += dt;
      this.applyVolumes();
      if (this.mixElapsed >= this.mixDur) this.finishMix();
      return;
    }
    if (this.st !== 'playing' && this.st !== 'preparing') return;
    this.applyVolumes();
    // The user may have reordered the queue: keep the prepared deck in sync with what is really next.
    if (this.d.queue.peekNext()?.videoId !== this.preparedId) {
      this.dueSince = undefined;
      this.d.log('info', 'automix.next_changed', { videoId: this.d.queue.peekNext()?.videoId });
      this.prepare();
    }
    const deck = this.d.decks[this.active];
    const dur = deck.duration();
    const mixSec = profileSeconds(this.d.profile());
    if (mixSec === null || dur <= 0 || this.nextState === 'none') return;
    const remaining = dur - deck.position();
    if (remaining > mixSec) return;
    if (this.nextState === 'ready') { this.beginMix(mixSec * 1000); return; }
    this.st = 'preparing';
    this.dueSince ??= n;
    if (n - this.dueSince >= LOAD_TIMEOUT_MS) {
      if (this.preparedId) {
        this.d.log('warn', 'deck.prepare_timeout', { videoId: this.preparedId });
        this.d.queue.markUnplayable(this.preparedId);
      }
      this.dueSince = undefined;
      this.prepare();
    }
  }

  private goIdle(reason: string): void {
    this.token++;
    this.clearTick();
    this.resetNext();
    this.st = 'idle';
    this.d.log('info', 'automix.idle', { reason });
  }

  private handleEnded(i: DeckIdx): void {
    if (i !== this.active) return;
    if (this.st === 'crossfading') { this.finishMix(); return; }
    if (this.st !== 'playing' && this.st !== 'preparing') return;
    this.switchWhenReady(0);
  }

  private handleError(i: DeckIdx, code: number): void {
    this.d.log('error', 'deck.error', { deck: i, code });
    if (this.st === 'idle' || this.st === 'paused') return;
    if (i === this.active) {
      const cur = this.d.queue.current();
      if (cur) this.d.queue.markUnplayable(cur.videoId);
      if (this.st === 'crossfading') this.finishMix();
      else this.switchWhenReady(0);
      return;
    }
    if (this.preparedId) this.d.queue.markUnplayable(this.preparedId);
    if (this.st === 'crossfading') {
      this.d.decks[this.mixIn].stop();
      this.st = 'playing';
      this.applied[this.active] = -1;
      this.applyVolumes();
    }
    this.resetNext();
    this.prepare();
  }
}
