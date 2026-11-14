import { loadYouTubeApi } from '../ytApi';

/** What the console publishes in localStorage «partymix.video»: the video being heard and its playhead at time `at`. */
export type VideoMsg = { id: string; t: number; at: number; playing: boolean; next?: string };

/** The player state the projector needs (the real one is YT.Player). */
export type VideoPlayerLike = {
  loadVideoById(a: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getVideoData?(): { video_id?: string };
};

const DRIFT_S = 0.6; // further than this from the music → seek
const SHOW_S = 1.5; // within this the picture is close enough to be shown
const SEEK_GAP_MS = 2500; // a seek takes a moment to settle: do not chase it
const STUCK_MS = 8000; // music playing but the player not running for this long: load the video again

export function parseVideoMsg(raw: string | null | undefined): VideoMsg | undefined {
  try {
    const m = JSON.parse(raw ?? '');
    if (m && typeof m.id === 'string' && typeof m.t === 'number' && typeof m.at === 'number') return { id: m.id, t: m.t, at: m.at, playing: m.playing === true, ...(typeof m.next === 'string' && m.next ? { next: m.next } : {}) };
  } catch { /* no message yet */ }
  return undefined;
}

/** Where the music is now, given the last message. */
export const targetTime = (m: VideoMsg, now: number) => m.t + (m.playing ? Math.max(0, now - m.at) / 1000 : 0);

/**
 * Keeps a muted player on the same video and second as the deck being heard. The picture is shown only while it is
 * really playing that video near the music: during YouTube ads, buffering or a seek the shapes stay on screen instead.
 */
export class VideoFollower {
  private loaded = '';
  private lastSeek = 0;
  private preloading = false;
  private stuckSince = 0;

  constructor(private p: VideoPlayerLike, private now: () => number = Date.now) {}

  loadedId(): string { return this.loaded; }
  /** The next video is buffered and waiting at its start. */
  isReady(id: string): boolean { return this.loaded === id && !this.preloading; }

  /**
   * Gets the next video ready while another one is on screen: it starts muted and hidden (so a YouTube ad in front
   * of it plays out now, unseen), and as soon as the real video is running it is paused at its start.
   */
  preload(id: string): void {
    if (this.loaded !== id) {
      this.loaded = id;
      this.preloading = true;
      this.lastSeek = 0;
      this.p.loadVideoById({ videoId: id, startSeconds: 0.05 });
      return;
    }
    if (!this.preloading) return;
    const vid = this.p.getVideoData?.()?.video_id;
    if (this.p.getPlayerState() === 1 && (!vid || vid === id) && this.p.getCurrentTime() > 0.3) {
      this.p.pauseVideo();
      this.p.seekTo(0.05, true);
      this.preloading = false;
    }
  }

  /** Called a few times a second; returns whether the video should be visible. */
  tick(m: VideoMsg | undefined): boolean {
    if (!m || !m.id) { if (this.loaded && this.p.getPlayerState() === 1) this.p.pauseVideo(); return false; }
    const want = targetTime(m, this.now());
    this.preloading = false;
    if (m.id !== this.loaded) {
      this.loaded = m.id;
      this.lastSeek = this.now();
      this.stuckSince = this.now();
      this.p.loadVideoById({ videoId: m.id, startSeconds: Math.max(0.05, want) });
      if (!m.playing) this.p.pauseVideo();
      return false;
    }
    const state = this.p.getPlayerState();
    if (!m.playing) {
      this.stuckSince = 0;
      if (state === 1) this.p.pauseVideo();
      return Math.abs(this.p.getCurrentTime() - want) < SHOW_S;
    }
    // On the Mac the player sometimes stalls (buffering or paused) and ignores playVideo until the song changes:
    // after a few seconds load the same video again at the music time.
    if (state === 1) this.stuckSince = 0;
    else if (!this.stuckSince) this.stuckSince = this.now();
    else if (this.now() - this.stuckSince > STUCK_MS) {
      this.stuckSince = this.now();
      this.lastSeek = this.now();
      this.p.loadVideoById({ videoId: m.id, startSeconds: Math.max(0.05, want) });
      return false;
    }
    if (state !== 1 && state !== 3) this.p.playVideo();
    const vid = this.p.getVideoData?.()?.video_id;
    if (vid && vid !== m.id) return false; // an ad (or the previous video) is playing
    const drift = this.p.getCurrentTime() - want;
    if (Math.abs(drift) > DRIFT_S && this.now() - this.lastSeek > SEEK_GAP_MS) {
      this.lastSeek = this.now();
      this.p.seekTo(want + 0.1, true); // a hair ahead: the player needs a moment to start again
    }
    return state === 1 && Math.abs(drift) < SHOW_S;
  }
}

const HOLD_MS = 5000; // how long the previous picture may stay up while the new one gets in step

/**
 * Two players taking turns, like the two decks: one is on screen, the other already holds the next video. When the
 * song changes the ready one takes over, and the old picture stays up until the new one is really playing: no black.
 */
export class VideoStage {
  private live = 0;
  private shown = [false, false];
  private holdUntil = 0;

  constructor(private f: [VideoFollower, VideoFollower], private now: () => number = Date.now) {}

  /** Returns which of the two players should be visible. */
  tick(m: VideoMsg | undefined): [boolean, boolean] {
    const spare = () => 1 - this.live;
    if (!m || !m.id) {
      this.f[0].tick(undefined); this.f[1].tick(undefined);
      this.shown = [false, false];
      return [false, false];
    }
    const cur = this.f[this.live].loadedId();
    if (cur && cur !== m.id) {
      // the song changed: the other player takes over (it usually has this video ready), this one stays up meanwhile
      this.holdUntil = this.shown[this.live] ? this.now() + HOLD_MS : 0;
      this.live = spare();
    }
    const showLive = this.f[this.live].tick(m);
    const keepOld = !showLive && this.now() < this.holdUntil && this.shown[spare()];
    if (!keepOld) {
      if (m.next && m.next !== m.id) this.f[spare()].preload(m.next);
      else this.f[spare()].tick(undefined); // nothing comes next: the old video stops playing unseen
    }
    const out: [boolean, boolean] = [false, false];
    out[this.live] = showLive;
    out[spare()] = keepOld;
    this.shown = [...out];
    return out;
  }
}

/** Builds the full-screen muted player behind which the shapes are drawn. */
export async function createVideoLayer(host: HTMLElement): Promise<VideoPlayerLike> {
  await loadYouTubeApi();
  const mount = document.createElement('div');
  host.appendChild(mount);
  return new Promise((resolve, reject) => {
    const player = new window.YT.Player(mount, {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => { player.mute(); resolve(player as VideoPlayerLike); },
        // YouTube turns on automatic subtitles in the system language: on a dance floor they only cover the dancers.
        onStateChange: (e: { data: number }) => { if (e.data === 1) { try { player.unloadModule('captions'); } catch { /* no subtitles */ } } },
      },
    });
    setTimeout(() => reject(new Error('Player YouTube del proiettore non pronto')), 20000);
  });
}
