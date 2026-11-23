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
  seekTo?(s: number): void;
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
  /** Network state; when offline, load failures are retried instead of marking tracks unplayable. */
  online?: () => boolean;
  /**
   * Where a song's music really starts and ends (silence and near-silent intro skipped), when known; `manualStart`/
   * `manualEnd` when the user chose them (SET START / SET END): those are obeyed to the millisecond, also without a fade.
   */
  cues?: (videoId: string) => { start: number; end: number; manualStart?: boolean; manualEnd?: boolean } | undefined;
};

const TICK_MS = 250;
const LOAD_TIMEOUT_MS = 5000;
const MANUAL_MIX_S = 8;
/** A track picked by hand fades in quickly, whatever the transition style. */
const QUICK_MIX_S = 4;
const SPARE_MIN_REMAINING_S = 30;
const RETRY_MS = 5000;
const isUnplayable = (e: unknown) => (e as { kind?: string } | undefined)?.kind === 'unplayable';
/** Offline and the song is only online: skip it now (not broken: it plays again when the network is back), never retry it in a loop. */
const isOfflineSkip = (e: unknown) => (e as { kind?: string } | undefined)?.kind === 'offline';
const SPARE_TIMEOUT_MS = 12000;

export class Automix {
  private st: AutomixState = 'idle';
  private pausedFrom: AutomixState = 'idle';
  /** The first song is still loading (startCurrent): nothing is heard yet. */
  private starting = false;
  private active: DeckIdx = 0;
  private mixIn: DeckIdx = 1;
  private nextState: NextState = 'none';
  private token = 0;
  private preparedId?: string;
  private borrowed = false;
  private timer?: number;
  private lastNow = 0;
  private mixElapsed = 0;
  private mixDur = 0;
  private dueSince?: number;
  private pending?: { ms: number };
  private applied: [number, number] = [-1, -1];
  /** The user moved the song on this deck past its End (or the measured silent tail): it plays to its real end. */
  private endOff?: { deck: DeckIdx; id: string };

  constructor(private d: AutomixDeps) {
    d.decks.forEach((deck, i) => {
      deck.onEnded(() => this.handleEnded(i as DeckIdx));
      deck.onError((code) => this.handleError(i as DeckIdx, code));
    });
  }

  state(): AutomixState { return this.st; }

  /**
   * The user dragged the position bar of deck `i` to `sec`. Moving back and forth inside a song must never end it:
   * when the new position is past the song's End (chosen or measured) that End is ignored for this play, and the
   * song goes on to its real end; moving back before it again brings the End back.
   */
  userSeek(i: DeckIdx, sec: number): void {
    const id = i === this.active ? this.d.queue.current()?.videoId : this.preparedId;
    if (!id) return;
    const cue = this.d.cues?.(id);
    const end = cue && cue.end > 0 ? cue.end : 0;
    const mix = profileSeconds(this.d.profile()) ?? 0;
    if (end && sec >= end - mix - 0.5) this.endOff = { deck: i, id };
    else if (this.endOff?.deck === i) this.endOff = undefined;
    this.dueSince = undefined;
  }
  private endIgnored(i: DeckIdx, id?: string): boolean { return !!id && this.endOff?.deck === i && this.endOff.id === id; }
  activeDeck(): DeckIdx { return this.active; }

  /**
   * Lends the deck that is not on air for a short job (e.g. reading the playlist again).
   * Refused during a crossfade or when the current track is about to end; afterwards the next track is prepared again.
   */
  async withSpareDeck<T>(job: (deck: Deck) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    if (this.borrowed) return { ok: false, reason: 'Il deck libero è occupato' };
    if (this.st === 'crossfading') return { ok: false, reason: 'Transizione in corso' };
    if (this.st === 'playing' || this.st === 'preparing') {
      const on = this.d.decks[this.active];
      if (!(on.duration() > 0) || on.duration() - on.position() < SPARE_MIN_REMAINING_S) return { ok: false, reason: 'Il brano sta per finire' };
    } else if (this.st === 'paused') {
      if (this.pausedFrom === 'crossfading') return { ok: false, reason: 'Transizione in pausa' };
    } else {
      return { ok: false, reason: 'Automix non attivo' };
    }
    const pending = this.pending;
    this.borrowed = true;
    this.resetNext();
    this.token++;
    let timer: number | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => { timer = this.d.setTimer(() => rej(new Error('Tempo scaduto')), SPARE_TIMEOUT_MS); });
      const value = await Promise.race([job(this.d.decks[(1 - this.active) as DeckIdx]), timeout]);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    } finally {
      if (timer !== undefined) this.d.clearTimer(timer);
      this.borrowed = false;
      if (this.st === 'playing' || this.st === 'preparing' || this.st === 'paused') { this.pending ??= pending; this.prepare(); }
    }
  }

  /** Video id of the track prepared on the spare deck (undefined when none). */
  upcomingId(): string | undefined { return this.preparedId; }

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
    this.starting = true;
    try { await this.startLoop(tok); } finally { if (tok === this.token) this.starting = false; }
  }

  private async startLoop(tok: number): Promise<void> {
    for (;;) {
      const cur = this.d.queue.current();
      if (!cur) { this.goIdle('queue.empty'); return; }
      try {
        await this.d.decks[this.active].load(cur.videoId);
      } catch (e) {
        if (tok !== this.token) return;
        this.d.log('warn', 'deck.load_failed', { videoId: cur.videoId, error: String(e) });
        if (isOfflineSkip(e)) {
          if (!this.d.queue.advance()) { this.goIdle('queue.exhausted'); return; }
          continue;
        }
        if (!isUnplayable(e) && !(this.d.online?.() ?? true)) {
          await new Promise<void>((r) => this.d.setTimer(r, RETRY_MS));
          if (tok !== this.token) return;
          continue;
        }
        this.d.queue.markUnplayable(cur.videoId);
        if (!this.d.queue.advance()) { this.goIdle('queue.exhausted'); return; }
        continue;
      }
      if (tok !== this.token) return;
      this.applied = [-1, -1];
      this.endOff = undefined;
      this.seekStart(this.active, cur.videoId, true);
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

  /** Plays the given queue track right away: idle starts the party from it, otherwise it fades in quickly over the current one. */
  playNow(videoId: string): void {
    const q = this.d.queue;
    if (this.st === 'idle') { if (q.setCurrent(videoId)) this.start(); return; }
    // paused, or the first song still loading: nothing is heard, so the picked song simply starts (no fade over
    // a silent deck, and the paused song does not come back)
    if (this.st === 'paused' || (this.st === 'preparing' && this.starting)) {
      if (!q.setCurrent(videoId)) return;
      const tok = ++this.token;
      this.clearTick();
      this.d.decks.forEach((k) => { k.stop(); k.setVolume(0); });
      this.applied = [-1, -1];
      this.resetNext();
      this.mixIn = (1 - this.active) as DeckIdx;
      this.d.log('info', 'automix.play_now_from_pause', { videoId });
      void this.startCurrent(tok);
      return;
    }
    if (this.st === 'crossfading') this.finishMix();
    if (q.current()?.videoId === videoId || !q.cueNext(videoId)) return;
    this.resetNext();
    this.prepare();
    this.switchWhenReady(Math.min(profileSeconds(this.d.profile()) ?? MANUAL_MIX_S, QUICK_MIX_S) * 1000);
  }

  mixNow(): void {
    if (this.st !== 'playing' && this.st !== 'preparing') return;
    const sec = profileSeconds(this.d.profile()) ?? MANUAL_MIX_S;
    this.switchWhenReady(sec * 1000);
  }

  private switchWhenReady(ms: number): void {
    if (this.nextState === 'ready') this.beginMix(ms);
    else if (this.nextState === 'loading') this.pending = { ms };
    else if (this.d.queue.peekNext()) this.pending = { ms }; // next track is not prepared yet (spare deck lent, still starting): do it as soon as it is
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
        if (isOfflineSkip(e)) {
          this.d.setTimer(() => { if (tok === this.token) this.prepare(); }, 1000);
          return;
        }
        if (!isUnplayable(e) && !(this.d.online?.() ?? true)) {
          this.d.setTimer(() => { if (tok === this.token) this.prepare(); }, RETRY_MS);
          return;
        }
        this.d.queue.markUnplayable(track.videoId);
        this.prepare();
      },
    );
  }

  private beginMix(ms: number): void {
    if (this.st === 'crossfading') return;
    const sec = this.endOf(this.active) - this.d.decks[this.active].position();
    const dur = ms > 0 ? Math.min(ms, Math.max(sec * 1000, 1000)) : 0;
    this.mixIn = (1 - this.active) as DeckIdx;
    this.st = 'crossfading';
    this.mixElapsed = 0;
    this.mixDur = dur;
    this.lastNow = this.d.now();
    this.dueSince = undefined;
    if (this.endOff?.deck === this.mixIn) this.endOff = undefined;
    const cue = this.seekStart(this.mixIn, this.preparedId, false);
    this.d.decks[this.mixIn].play();
    this.applyVolumes();
    this.d.log('info', 'automix.crossfade_start', { ms: dur, skipIntro: cue?.start ?? 0 });
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

  /**
   * Puts deck `i` where the song should start: the user's Start (any value), or the measured end of a silent intro
   * (at least 1 s, and only when mixing in: the first song of the party plays from where the user asked).
   */
  private seekStart(i: DeckIdx, id: string | undefined, first: boolean) {
    const cue = id ? this.d.cues?.(id) : undefined;
    if (cue && (cue.manualStart ? cue.start > 0 : !first && cue.start >= 1)) this.d.decks[i].seekTo?.(cue.start); // straight to where the music starts
    return cue;
  }

  /** Where the song on deck `i` really ends: its duration, or earlier when its tail is silence or a long fade. */
  private endOf(i: DeckIdx): number {
    const dur = this.d.decks[i].duration();
    const id = i === this.active ? this.d.queue.current()?.videoId : this.preparedId;
    const end = id && !this.endIgnored(i, id) ? this.d.cues?.(id)?.end : undefined;
    return end && end > 0 && end < dur ? end : dur;
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
    if (this.borrowed) return;
    // A mix asked for by hand that never started (the track became ready without picking up the request): start it now.
    if (this.pending && this.nextState === 'ready') { const { ms } = this.pending; this.pending = undefined; this.beginMix(ms); return; }
    // The user may have reordered the queue: keep the prepared deck in sync with what is really next.
    if (this.d.queue.peekNext()?.videoId !== this.preparedId) {
      this.dueSince = undefined;
      this.d.log('info', 'automix.next_changed', { videoId: this.d.queue.peekNext()?.videoId });
      this.prepare();
    }
    const deck = this.d.decks[this.active];
    const dur = deck.duration();
    const curId = this.d.queue.current()?.videoId;
    const cue = curId ? this.d.cues?.(curId) : undefined;
    // the user's End: the song is over there, whatever the transition style (the fade, if any, already started before it)
    if (cue?.manualEnd && cue.end > 0 && !this.endIgnored(this.active, curId) && deck.position() >= cue.end - 0.05) {
      if (!this.pending) { this.d.log('info', 'automix.user_end', { videoId: curId, end: cue.end }); this.switchWhenReady(0); }
      return;
    }
    const mixSec = profileSeconds(this.d.profile());
    if (mixSec === null || dur <= 0 || this.nextState === 'none') return;
    const remaining = this.endOf(this.active) - deck.position(); // before the silence at the tail
    if (remaining > mixSec) return;
    if (this.nextState === 'ready') { this.beginMix(mixSec * 1000); return; }
    this.st = 'preparing';
    this.dueSince ??= n;
    if (n - this.dueSince >= LOAD_TIMEOUT_MS && (this.d.online?.() ?? true)) {
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
    this.d.decks.forEach((k) => k.stop());
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
