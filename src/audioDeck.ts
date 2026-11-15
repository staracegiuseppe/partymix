import type { Deck } from './automix';
import { log } from './log';
import type { YouTubeDeck } from './youtubeDeck';

/** The parts of an <audio> element the deck uses (so the tests can give a fake one). */
export type AudioLike = {
  src: string; currentTime: number; duration: number; volume: number; preload: string;
  play(): Promise<void> | void; pause(): void; load(): void; removeAttribute(n: string): void;
  addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void;
};

const err = (message: string, kind: 'unplayable' | 'network' | 'offline' | 'superseded' | 'timeout') => Object.assign(new Error(message), { kind });
const LOAD_TIMEOUT_MS = 15000;

/** A deck that plays a local audio file (MP3 of the library) with the same controls as a YouTube deck. */
export class AudioDeck implements Deck {
  private endedCb: () => void = () => {};
  private errorCb: (code: number) => void = () => {};
  private token = 0;
  private loaded = false;

  constructor(private a: AudioLike) {
    a.preload = 'auto';
    a.addEventListener('ended', () => this.endedCb());
    a.addEventListener('error', () => { if (this.loaded) this.errorCb(5); });
  }

  /** `src` is a link to the file (blob:…). Resolves when the player knows the length and can start. */
  load(src: string): Promise<void> {
    const tok = ++this.token;
    this.loaded = false;
    this.a.pause();
    return new Promise<void>((ok, ko) => {
      const clean = () => { clearTimeout(t); this.a.removeEventListener('canplay', ready); this.a.removeEventListener('loadedmetadata', ready); this.a.removeEventListener('error', bad); };
      const ready = () => { clean(); if (tok !== this.token) return ko(err('Caricamento sostituito', 'superseded')); this.loaded = true; ok(); };
      const bad = () => { clean(); ko(err('Il file audio è danneggiato o non si può leggere.', 'unplayable')); };
      const t = setTimeout(() => { clean(); ko(err('Il file audio non risponde.', 'timeout')); }, LOAD_TIMEOUT_MS);
      this.a.addEventListener('canplay', ready);
      this.a.addEventListener('loadedmetadata', ready);
      this.a.addEventListener('error', bad);
      this.a.src = src;
      this.a.currentTime = 0;
      this.a.load();
    });
  }
  play(): void { void Promise.resolve(this.a.play()).catch((e) => log('warn', 'audio.play_refused', { error: String(e) })); }
  pause(): void { this.a.pause(); }
  stop(): void { this.token++; this.loaded = false; this.a.pause(); this.a.removeAttribute('src'); this.a.load(); }
  setVolume(v: number): void { this.a.volume = Math.min(1, Math.max(0, v / 100)); }
  position(): number { return this.loaded ? this.a.currentTime || 0 : 0; }
  duration(): number { return this.loaded && Number.isFinite(this.a.duration) ? this.a.duration : 0; }
  seekTo(s: number): void { const d = this.duration(); this.a.currentTime = Math.max(0, d > 0 ? Math.min(d - 1, s) : s); }
  onEnded(cb: () => void): void { this.endedCb = cb; }
  onError(cb: (code: number) => void): void { this.errorCb = cb; }
}

export const isLocalId = (id: string) => id.startsWith('local:');

type HybridDeps = {
  /** A playable link for a song with a local copy (local file or downloaded YouTube song), else undefined. */
  localUrl: (id: string) => Promise<string | undefined>;
  /** False offline: a song without a local copy is not even tried (no endless attempts to reach the network). */
  canStream: () => boolean;
};

/**
 * One deck of the mixer: plays from the local library when the song has a local copy, from YouTube otherwise.
 * The automix sees a single deck, so crossfades work the same between a file and a video.
 * YouTube is optional: offline (or before its player is ready) the deck plays the library only.
 */
export class HybridDeck implements Deck {
  private id = '';
  private mode: 'audio' | 'yt' = 'audio';
  private token = 0;
  private endedCb: () => void = () => {};
  private errorCb: (code: number) => void = () => {};
  private yt?: YouTubeDeck;

  constructor(private audio: AudioDeck, private deps: HybridDeps, yt?: YouTubeDeck) {
    audio.onEnded(() => { if (this.mode === 'audio') this.endedCb(); });
    audio.onError((c) => { if (this.mode === 'audio') this.errorCb(c); });
    if (yt) this.setYouTube(yt);
  }

  /** The YouTube player became ready (at start, or when the network came back). */
  setYouTube(yt: YouTubeDeck): void {
    this.yt = yt;
    yt.onEnded(() => { if (this.mode === 'yt') this.endedCb(); });
    yt.onError((c) => { if (this.mode === 'yt') this.errorCb(c); });
  }
  hasYouTube(): boolean { return !!this.yt; }
  youtube(): YouTubeDeck | undefined { return this.yt; }
  playingLocal(): boolean { return this.mode === 'audio' && !!this.id; }

  async load(id: string): Promise<void> {
    const tok = ++this.token;
    this.id = id;
    const url = await this.deps.localUrl(id);
    if (tok !== this.token) throw err('Caricamento sostituito', 'superseded');
    if (url) {
      if (this.mode === 'yt') this.yt?.stop();
      this.mode = 'audio';
      try {
        return await this.audio.load(url);
      } catch (e) {
        if (tok !== this.token) throw e;
        // the local copy does not play (moved, damaged, too slow): a YouTube song plays from the internet instead,
        // it is never marked «non riproducibile» because of its file
        if (isLocalId(id) || !this.yt || !this.deps.canStream()) throw e;
        log('warn', 'deck.local_failed_fallback_youtube', { videoId: id, error: String(e) });
        this.audio.stop();
        this.mode = 'yt';
        return this.yt.load(id);
      }
    }
    if (isLocalId(id)) throw err('Il file di questo brano non è più nella libreria.', 'unplayable');
    if (!this.yt || !this.deps.canStream()) throw err('Sei offline: questo brano è solo online.', 'offline');
    if (this.mode === 'audio') this.audio.stop();
    this.mode = 'yt';
    return this.yt.load(id);
  }

  private get on(): Deck { return this.mode === 'yt' && this.yt ? this.yt : this.audio; }
  play(): void { this.on.play(); }
  pause(): void { this.on.pause(); }
  stop(): void { this.token++; this.audio.stop(); this.yt?.stop(); }
  setVolume(v: number): void { this.on.setVolume(v); }
  position(): number { return this.on.position(); }
  duration(): number { return this.on.duration(); }
  seekTo(s: number): void { if (this.mode === 'yt') this.yt?.seekTo(s); else this.audio.seekTo(s); }
  currentVideoId(): string { return this.id; }
  /** The YouTube video id shown by the projector («Video YouTube»): none for a local file. */
  videoIdForProjector(): string { return isLocalId(this.id) ? '' : this.id; }
  onEnded(cb: () => void): void { this.endedCb = cb; }
  onError(cb: (code: number) => void): void { this.errorCb = cb; }

  /** Reads a YouTube playlist with this deck's YouTube player (the deck must not be on air). */
  readPlaylist(listId: string): Promise<string[]> {
    if (!this.yt) return Promise.reject(err('YouTube non è raggiungibile in questo momento.', 'network'));
    this.token++;
    this.audio.stop();
    this.mode = 'yt';
    this.id = '';
    return this.yt.readPlaylist(listId);
  }
}
