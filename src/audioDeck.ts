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

/** A song that is not a YouTube video: a file of this device (`local:`) or a song of the NAS (`nas:<sha256>`). */
export const isLocalId = (id: string) => id.startsWith('local:') || id.startsWith('nas:');
export const isNasId = (id: string) => id.startsWith('nas:');

type HybridDeps = {
  /** A playable link for a song with a local copy (local file or downloaded YouTube song), else undefined. */
  localUrl: (id: string) => Promise<string | undefined>;
  /** False offline: a song without a local copy is not even tried (no endless attempts to reach the network). */
  canStream: () => boolean;
  /** Projector on «Video YouTube»: sound and video both from YouTube (in sync), even when there is a local copy. */
  preferYouTube?: () => boolean;
  /**
   * «Volume uguale tra i brani»: the volume factor of a song as it plays here (YouTube or a file). `now` at once,
   * `later` when its loudness is still being read; it is taken only if the song is not heard yet (no jump mid-song).
   */
  levelGain?: (id: string, source: 'youtube' | 'file') => { now: number; later?: Promise<number> };
};

/**
 * One deck of the mixer: plays from the local library when the song has a local copy, from YouTube otherwise.
 * The automix sees a single deck, so crossfades work the same between a file and a video.
 * YouTube is optional: offline (or before its player is ready) the deck plays the library only.
 */
export type DeckSource = 'none' | 'file' | 'sound-file' | 'video-file' | 'nas' | 'youtube' | 'youtube-video-mode' | 'youtube-fallback';

/** The line under the song: where its sound comes from and, with the projector on «Video YouTube», where the video does. */
export function sourceText(s: DeckSource, projectorVideo: boolean): string {
  // a local copy while the projector wants «Video YouTube» only happens offline (or before YouTube is ready)
  const yt = projectorVideo ? ' · ⚠ niente internet: il video di YouTube non si vede' : '';
  switch (s) {
    case 'file': return '💾 Dal tuo file sul computer';
    case 'sound-file': return `💾 Audio dal tuo file MP3 sul computer${yt}`;
    case 'video-file': return `💾 Dal tuo video scaricato sul computer${yt}`;
    case 'nas': return '🗄 Dal NAS di casa (in streaming)';
    case 'youtube': return '☁ Audio e video da YouTube (internet)';
    case 'youtube-video-mode': return '☁ Audio e video da YouTube (proiettore su «Video YouTube»; con «Karaoke» suona il tuo file, se c’è)';
    case 'youtube-fallback': return '⚠ Il file sul computer non si apre: suona da YouTube (internet)';
    default: return '';
  }
}

export class HybridDeck implements Deck {
  private id = '';
  private mode: 'audio' | 'yt' = 'audio';
  private audioOnly = false; // the local copy is a sound file (MP3…), without its video
  private fellBack = false; // the local copy did not open: the song plays from YouTube
  private chosenYt = false; // played from YouTube because the projector is on «Video YouTube»
  private fromNas = false; // streamed from the NAS (no copy on this device)
  private playing = false;
  private vol = 100;
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

  private gain = 1;
  private gainTok = 0;
  /** The song is loaded (and its source known): its own volume factor. */
  private regain(id: string): void {
    const tok = ++this.gainTok;
    const g = this.deps.levelGain?.(id, this.mode === 'yt' ? 'youtube' : 'file');
    this.gain = g?.now ?? 1;
    this.on.setVolume(this.vol * this.gain);
    void g?.later?.then((v) => {
      if (tok !== this.gainTok || (this.playing && this.vol > 0)) return; // already heard: it keeps its volume
      this.gain = v;
      this.on.setVolume(this.vol * this.gain);
    });
  }

  async load(id: string): Promise<void> {
    const mine = this.token + 1; // loadSource takes this token at once
    await this.loadSource(id);
    if (this.token === mine) this.regain(id); // a newer load (or a stop) came meanwhile: its song, its volume
  }

  private async loadSource(id: string): Promise<void> {
    const tok = ++this.token;
    this.id = id;
    // «Video YouTube» on the projector and the internet is there: the song plays from YouTube, sound and picture together
    if (!isLocalId(id) && this.yt && this.deps.canStream() && this.deps.preferYouTube?.()) {
      this.fellBack = false; this.audioOnly = false; this.chosenYt = true;
      if (this.mode === 'audio') this.audio.stop();
      this.mode = 'yt';
      return this.yt.load(id);
    }
    this.chosenYt = false;
    const url = await this.deps.localUrl(id);
    if (tok !== this.token) throw err('Caricamento sostituito', 'superseded');
    this.fromNas = !!url && isNasId(id) && /^https?:/i.test(url);
    this.audioOnly = !!url && (this.fromNas || isSoundFile(url));
    this.fellBack = false;
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
        this.fellBack = true;
        return this.yt.load(id);
      }
    }
    if (isNasId(id)) throw err('Il NAS non risponde e questo brano non è salvato su questo dispositivo.', 'offline');
    if (isLocalId(id)) throw err('Il file di questo brano non è più nella libreria.', 'unplayable');
    if (!this.yt || !this.deps.canStream()) throw err('Sei offline: questo brano è solo online.', 'offline');
    if (this.mode === 'audio') this.audio.stop();
    this.mode = 'yt';
    return this.yt.load(id);
  }

  private get on(): Deck { return this.mode === 'yt' && this.yt ? this.yt : this.audio; }
  play(): void { this.playing = true; this.on.play(); }
  pause(): void { this.playing = false; this.on.pause(); }
  stop(): void { this.playing = false; this.token++; this.audio.stop(); this.yt?.stop(); }
  setVolume(v: number): void { this.vol = v; this.on.setVolume(v * this.gain); }

  /**
   * The projector mode changed (the user's rule):
   * - to «Video YouTube»: sound and picture both from YouTube, which leads; the song goes on from the same point;
   * - to «Karaoke»: the song starts again from the beginning, from the file on the computer when there is one.
   * Same volume, still playing if it was. Returns what was done, or false when there was nothing to do.
   */
  async reselect(): Promise<'youtube' | 'file-from-start' | 'from-start' | false> {
    const id = this.id;
    if (!id || isLocalId(id)) return false;
    const playing = this.playing, vol = this.vol;
    if (this.deps.preferYouTube?.()) {
      if (!this.yt || !this.deps.canStream() || (this.mode === 'yt' && !this.fellBack)) return false;
      const pos = this.position();
      await this.load(id); // goes to YouTube: preferYouTube is on
      this.setVolume(vol);
      if (pos > 1) this.seekTo(pos);
      if (playing) this.play();
      return 'youtube';
    }
    const hasFile = !!(await this.deps.localUrl(id));
    if (hasFile && this.mode !== 'audio') await this.load(id); // to the file on the computer
    this.setVolume(vol);
    this.seekTo(0); // Karaoke: from the beginning, so words and music start together
    if (playing) this.play();
    return hasFile ? 'file-from-start' : 'from-start';
  }
  position(): number { return this.on.position(); }
  duration(): number { return this.on.duration(); }
  seekTo(s: number): void { if (this.mode === 'yt') this.yt?.seekTo(s); else this.audio.seekTo(s); }
  currentVideoId(): string { return this.id; }
  /** The YouTube video id shown by the projector («Video YouTube»): none for a local file. */
  videoIdForProjector(): string { return isLocalId(this.id) ? '' : this.id; }
  /** Where the sound comes from, so the user always knows (a file on the computer, or YouTube over the internet). */
  source(): DeckSource {
    if (!this.id) return 'none';
    if (this.mode === 'yt') return this.fellBack ? 'youtube-fallback' : this.chosenYt ? 'youtube-video-mode' : 'youtube';
    if (this.fromNas) return 'nas';
    if (isLocalId(this.id)) return 'file';
    return this.audioOnly ? 'sound-file' : 'video-file';
  }
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

/** A sound-only file (MP3, M4A…): the song was saved without its video, so the projector shows no YouTube video. */
export function isSoundFile(url: string): boolean {
  let u = url;
  try { u = decodeURIComponent(url); } catch { /* keep it as it is */ }
  return /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?|#|$)/i.test(u);
}
