import type { Deck } from './automix';
import { log } from './log';
import { loadYouTubeApi } from './ytApi';

export type YtPlayerLike = {
  cueVideoById(a: string | { videoId: string; startSeconds?: number }): void;
  loadVideoById(a: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  setVolume(v: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  cuePlaylist?(a: { listType: 'playlist'; list: string }): void;
  getPlaylist?(): string[];
};

export function mapYtError(code: number): { kind: 'unplayable' | 'retry'; reason: string } {
  switch (code) {
    case 100: return { kind: 'unplayable', reason: 'Video rimosso o privato' };
    case 101:
    case 150: return { kind: 'unplayable', reason: 'Il proprietario non consente la riproduzione incorporata' };
    case 153: return { kind: 'unplayable', reason: 'Riproduzione rifiutata: origine non valida per il player YouTube' };
    case 2: return { kind: 'retry', reason: 'Identificativo video non valido o richiesta errata' };
    case 5: return { kind: 'retry', reason: 'Errore del player HTML5' };
    default: return { kind: 'retry', reason: `Errore sconosciuto (${code})` };
  }
}

const RETRY_DELAYS_MS = [1000, 3000, 7000];
const LOAD_TIMEOUT_MS = 15000;

type Timers = { setTimer: (fn: () => void, ms: number) => number; clearTimer: (id: number) => void };
const realTimers: Timers = {
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

export class YouTubeDeck implements Deck {
  private videoId = '';
  private wantPlay = false;
  private retries = 0;
  private pending?: { resolve: () => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> };
  private endedCb: () => void = () => {};
  private errorCb: (code: number) => void = () => {};

  constructor(private player: YtPlayerLike, private timers: Timers = realTimers) {}

  load(videoId: string): Promise<void> {
    this.videoId = videoId;
    this.wantPlay = false;
    this.retries = 0;
    this.settle(new Error('Caricamento sostituito'));
    return this.cueWith(() => this.player.cueVideoById(videoId));
  }

  /** Cues a whole playlist on this player and returns its video ids (YouTube exposes up to ~200). */
  async readPlaylist(listId: string): Promise<string[]> {
    this.videoId = '';
    this.wantPlay = false;
    this.retries = 0;
    this.settle(new Error('Caricamento sostituito'));
    await this.cueWith(() => this.player.cuePlaylist?.({ listType: 'playlist', list: listId }));
    return this.player.getPlaylist?.() ?? [];
  }

  private cueWith(cue: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.settle(new Error('Timeout di caricamento')), LOAD_TIMEOUT_MS);
      this.pending = { resolve, reject, timeout };
      cue();
    });
  }

  private settle(err?: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timeout);
    if (err) { p.reject(err); } else { p.resolve(); }
  }

  currentVideoId(): string { return this.videoId; }
  play(): void { this.wantPlay = true; this.player.playVideo(); }
  pause(): void { this.wantPlay = false; this.player.pauseVideo(); }
  stop(): void { this.wantPlay = false; this.player.stopVideo(); }
  setVolume(v: number): void { this.player.setVolume(Math.round(Math.min(100, Math.max(0, v)))); }
  position(): number { return this.player.getCurrentTime() || 0; }
  duration(): number { return this.player.getDuration() || 0; }
  onEnded(cb: () => void): void { this.endedCb = cb; }
  onError(cb: (code: number) => void): void { this.errorCb = cb; }

  /** Called by the YT.Player onStateChange event. */
  handleState(state: number): void {
    if (state === 5) this.settle();
    else if (state === 1) this.retries = 0;
    else if (state === 0) this.endedCb();
  }

  /** Called by the YT.Player onError event. */
  handleError(code: number): void {
    const m = mapYtError(code);
    log('warn', 'youtube.error', { code, videoId: this.videoId, reason: m.reason });
    if (m.kind === 'retry' && this.retries < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[this.retries++];
      this.timers.setTimer(() => this.reload(), delay);
      return;
    }
    this.settle(new Error(m.reason));
    this.errorCb(code);
  }

  private reload(): void {
    const startSeconds = this.position();
    if (this.wantPlay) this.player.loadVideoById({ videoId: this.videoId, startSeconds });
    else this.player.cueVideoById({ videoId: this.videoId, startSeconds });
  }
}

export async function createYouTubeDeck(el: HTMLElement, opts: { sizePx?: number } = {}): Promise<YouTubeDeck> {
  await loadYouTubeApi();
  const size = Math.max(200, opts.sizePx ?? 240);
  const mount = document.createElement('div');
  el.appendChild(mount);
  return new Promise<YouTubeDeck>((resolve, reject) => {
    let deck: YouTubeDeck | undefined;
    const player = new window.YT.Player(mount, {
      width: size, height: size,
      playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, origin: location.origin },
      events: {
        onReady: () => { deck = new YouTubeDeck(player); resolve(deck); },
        onStateChange: (e: { data: number }) => deck?.handleState(e.data),
        onError: (e: { data: number }) => deck?.handleError(e.data),
      },
    });
    setTimeout(() => reject(new Error('Player YouTube non pronto')), 20000);
  });
}
