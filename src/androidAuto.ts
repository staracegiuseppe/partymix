import type { AutomixState } from './automix';
import type { Playlist } from './library/playlists';
import type { Track } from './queue';

/**
 * Android Auto («versione light»): the car browses the playlists and controls the music through the app's
 * MediaSession (AutoService.kt / PartyMedia.kt). The music itself is still played here, by the decks in the web view:
 * the native side sends the car's commands as `partymix-auto` events and shows what this side tells it.
 */

export type AutoPlaylist = { id: string; name: string; count: number; art: string };
export type AutoTrack = { id: string; title: string; artist: string; art: string };
export type AutoNow = { state: 'playing' | 'paused' | 'idle'; id: string; title: string; artist: string; album: string; art: string; pos: number; dur: number };

export type AutoCommand =
  | { cmd: 'play' | 'pause' | 'stop' | 'next' | 'prev' | 'hello' }
  | { cmd: 'playlist'; id: string }
  | { cmd: 'track'; playlist: string; id: string }
  | { cmd: 'tracks'; req: number; playlist: string };

export type AutoControls = {
  state(): AutomixState;
  hasQueue(): boolean;
  currentPlaylist(): string | undefined;
  start(): void;
  resume(): void;
  pause(): void;
  next(): void;
  prev(): void;
  playPlaylist(id: string, startAt?: string): void;
};

export type AutoDeps = AutoControls & {
  playlists(): Playlist[];
  playlist(id: string): Playlist | undefined;
  onPlaylistsChange(fn: () => void): () => void;
  now(): AutoNow;
};

type Bridge = { autoPlaylists?(json: string): void; autoTracks?(req: number, json: string): void; autoNow?(json: string): void };
const bridge = (): Bridge | undefined => (window as unknown as { PartyMixAndroid?: Bridge }).PartyMixAndroid;

/** How many songs of one playlist the car gets: Android Auto shows only a part of a long list anyway. */
export const CAR_TRACK_LIMIT = 500;
/** How long a song started from the car may stay at 0:00 before it is started again. */
const KICK_AFTER_MS = 6000;
const cut = (s: string | undefined, n = 200) => (s ?? '').slice(0, n);
/** Local (`local:`) and NAS (`nas:`) songs carry a prefix; anything else is a YouTube video id. */
const isVideoId = (id: string) => /^[\w-]+$/.test(id);

/** The cover the car can load: an https link of the song's own, or the YouTube thumbnail. Local and NAS songs have none. */
export function artOf(t: Track): string {
  if (t.thumb && t.thumb.startsWith('https://')) return t.thumb;
  return isVideoId(t.videoId) ? `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg` : '';
}

export function playlistsOf(list: Playlist[]): AutoPlaylist[] {
  return list.map((p) => {
    const first = p.tracks.find((t) => t.status !== 'unplayable');
    const art = p.cover?.startsWith('https://') ? p.cover : first ? artOf(first) : '';
    return { id: p.id, name: cut(p.name, 80), count: p.tracks.length, art };
  });
}

export function tracksOf(p: Playlist, limit = CAR_TRACK_LIMIT): AutoTrack[] {
  const out: AutoTrack[] = [];
  for (const t of p.tracks) {
    if (out.length >= limit) break;
    if (t.status === 'unplayable') continue;
    out.push({ id: t.videoId, title: cut(t.title) || `Video ${t.videoId}`, artist: cut(t.artist), art: artOf(t) });
  }
  return out;
}

/** What the car shows: the song on air, where its playhead is (ms) and whether the music runs. */
export function nowOf(state: AutomixState, t: Track | undefined, posSec: number, durSec: number, from: string): AutoNow {
  const st = state === 'idle' ? 'idle' : state === 'paused' ? 'paused' : 'playing';
  const ms = (s: number) => (Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0);
  return {
    state: st, id: t?.videoId ?? '', title: t ? cut(t.title) || `Video ${t.videoId}` : '', artist: cut(t?.artist),
    album: cut(from, 80), art: t ? artOf(t) : '', pos: ms(posSec), dur: ms(durSec),
  };
}

/** Runs one command from the car. Anything malformed is ignored. */
export function autoCommand(c: AutoCommand, d: AutoControls): void {
  if (!c || typeof c !== 'object') return;
  switch (c.cmd) {
    case 'play': {
      const st = d.state();
      if (st === 'paused') d.resume();
      else if (st === 'idle') {
        if (d.hasQueue()) d.start();
        else { const id = d.currentPlaylist(); if (id) d.playPlaylist(id); }
      }
      return;
    }
    case 'pause': case 'stop': if (d.state() !== 'idle' && d.state() !== 'paused') d.pause(); return;
    case 'next': d.next(); return;
    case 'prev': d.prev(); return;
    case 'playlist': if (typeof c.id === 'string' && c.id) d.playPlaylist(c.id); return;
    case 'track': if (typeof c.playlist === 'string' && typeof c.id === 'string' && c.playlist && c.id) d.playPlaylist(c.playlist, c.id); return;
  }
}

/**
 * Connects the app to its Android Auto session. Outside the Android app it does nothing.
 * Returns a function that disconnects it (tests).
 */
export function startAndroidAuto(d: AutoDeps): () => void {
  const b = bridge();
  if (!b?.autoNow || !b.autoPlaylists || !b.autoTracks) return () => {};
  const pushLists = () => { try { b.autoPlaylists!(JSON.stringify(playlistsOf(d.playlists()))); } catch { /* the car keeps the last list */ } };
  let last = '', lastAt = 0;
  const pushNow = (force = false) => {
    const n = d.now();
    const key = `${n.state}|${n.id}|${n.title}|${n.artist}|${n.art}|${n.album}|${n.dur}`;
    const t = Date.now();
    // a change at once; the same song every 5 s, so the car's playhead does not drift
    if (!force && key === last && t - lastAt < 5000) return;
    last = key; lastAt = t;
    try { b.autoNow!(JSON.stringify(n)); } catch { /* next tick */ }
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const off = d.onPlaylistsChange(() => { if (!pending) pending = setTimeout(() => { pending = undefined; pushLists(); }, 500); });
  const onCmd = (e: Event) => {
    const c = (e as CustomEvent<AutoCommand>).detail;
    if (!c || typeof c !== 'object') return;
    if (c.cmd === 'hello') { pushLists(); pushNow(true); return; }
    if (c.cmd === 'tracks') {
      const p = typeof c.playlist === 'string' ? d.playlist(c.playlist) : undefined;
      try { b.autoTracks!(Number(c.req) || 0, p ? JSON.stringify(tracksOf(p)) : '[]'); } catch { /* the car shows an empty list */ }
      return;
    }
    autoCommand(c, d); // the new state reaches the car with the next tick, once the decks have moved
    if (c.cmd === 'play' || c.cmd === 'playlist' || c.cmd === 'track') watchStart();
  };
  // A song started from the car right after another one stopped can stay cued at 0:00 in the YouTube player
  // (seen with Android Auto on: no error, the player just never starts). Pause + play starts it: done once.
  let kick: ReturnType<typeof setTimeout> | undefined;
  const watchStart = () => {
    if (kick) clearTimeout(kick);
    kick = setTimeout(() => {
      kick = undefined;
      const n = d.now();
      if (n.state !== 'playing' || n.pos >= 1000) return;
      d.pause();
      kick = setTimeout(() => { kick = undefined; if (d.state() === 'paused') d.resume(); }, 500);
    }, KICK_AFTER_MS);
  };
  window.addEventListener('partymix-auto', onCmd);
  const tick = setInterval(() => pushNow(), 1000);
  pushLists();
  pushNow(true);
  return () => {
    window.removeEventListener('partymix-auto', onCmd);
    clearInterval(tick);
    if (pending) clearTimeout(pending);
    if (kick) clearTimeout(kick);
    off();
  };
}
