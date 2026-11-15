import type { Profile } from './crossfade';
import type { Align } from './lyrics';

export type Settings = {
  profile: Profile;
  master: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  micDeviceId?: string;
  micSensitivity: number;
  projectorDisplay?: string;
  /** The readable name of that screen, to find it again if its id changes (cable unplugged and back). */
  projectorDisplayLabel?: string;
  playlistText?: string;
  /** The saved playlist links, one per slot (empty string = slot not set yet). */
  playlists: string[];
  /** The names the user gave the playlists (empty = «Playlist N»). */
  playlistNames: string[];
  /** Which playlist is in use (0 … PLAYLIST_SLOTS-1). Before 1.7 only: read once to migrate. */
  playlistSlot: number;
  /** The playlist in use (id in the playlist store), from 1.7 on: no limit to how many there are. */
  currentPlaylistId?: string;
  /** How the side bar orders the playlists. */
  playlistSort: 'custom' | 'name' | 'recent' | 'size';
  /** The user's YouTube Data API v3 key, for «Cerca su YouTube» and for reading playlists longer than ~200 songs. */
  ytApiKey?: string;
  /** What the projector shows: shapes and lyrics (karaoke) or the YouTube video itself, big (e.g. Just Dance). */
  projectorMode: 'karaoke' | 'video';
  /** The guided setup was shown (finished or skipped), so it does not open by itself again. */
  welcomed: boolean;
  /** Look up the lyrics of every song in the background after a playlist is loaded. */
  karaokeAuto: boolean;
  /** Listen to the sound that plays and lower the volume when it is a spoken ad. */
  adGuard: boolean;
  /** Score needed to count as speech: 3 sensitive, 4 normal, 5 cautious. */
  adThreshold: number;
  /** What to do with short tracks (spots) in the playlist: nothing, lower the volume, or move on to the next track. */
  spotMode: 'off' | 'duck' | 'skip';
  locked: string[];
  showLyrics: boolean;
  /** The words of the line being sung light up one by one (karaoke style); off = the whole line stays plain. */
  lyricsHighlight: boolean;
  /** Minutes between automatic playlist refreshes; 0 = manual only. */
  playlistRefreshMin: number;
  /** Per-video lyrics alignment chosen by the user (karaoke and other versions). */
  lyricsAlign: Record<string, Align>;
};

export const DEFAULT_SETTINGS: Settings = {
  profile: 'standard',
  master: 80,
  shuffle: false,
  repeat: 'off',
  micSensitivity: 1,
  welcomed: false,
  karaokeAuto: true,
  adGuard: false,
  adThreshold: 4,
  spotMode: 'off',
  locked: [],
  showLyrics: true,
  lyricsHighlight: true,
  playlistRefreshMin: 5,
  lyricsAlign: {},
  playlists: ['', '', '', ''],
  playlistNames: ['', '', '', ''],
  playlistSlot: 0,
  playlistSort: 'custom',
  projectorMode: 'karaoke',
};

/** How many playlists the app had before 1.7 (fixed slots). Only used to read the old settings once: now there is no limit. */
export const PLAYLIST_SLOTS = 4;
const SLOTS = Array.from({ length: PLAYLIST_SLOTS }, (_, i) => i);
const fresh = (): Settings => ({ ...DEFAULT_SETTINGS, playlists: SLOTS.map(() => ''), playlistNames: SLOTS.map(() => '') });

const KEY = 'partymix.settings';
const PROFILES: Profile[] = ['morbida', 'standard', 'energica', 'manuale'];
export const REFRESH_CHOICES = [0, 2, 5, 10, 30];
const REPEATS = ['off', 'all', 'one'] as const;

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function cleanAlign(v: unknown): Record<string, Align> {
  const out: Record<string, Align> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, e] of Object.entries(v as Record<string, unknown>).slice(-200)) {
    const o = e as { a?: unknown; b?: unknown } | null;
    if (!o || typeof o.a !== 'number' || typeof o.b !== 'number' || !Number.isFinite(o.a) || !Number.isFinite(o.b)) continue;
    out[id] = { a: Math.min(2, Math.max(0.5, o.a)), b: Math.min(600, Math.max(-600, o.b)) };
  }
  return out;
}

export function loadSettings(store: Storage): Settings {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return fresh();
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return fresh();
    const out: Settings = {
      profile: PROFILES.includes(j.profile) ? j.profile : DEFAULT_SETTINGS.profile,
      master: num(j.master, 0, 100, DEFAULT_SETTINGS.master),
      shuffle: j.shuffle === true,
      repeat: REPEATS.includes(j.repeat) ? j.repeat : 'off',
      micSensitivity: num(j.micSensitivity, 0.1, 5, DEFAULT_SETTINGS.micSensitivity),
      welcomed: j.welcomed === true,
      karaokeAuto: j.karaokeAuto !== false,
      adGuard: j.adGuard === true,
      adThreshold: [3, 4, 5].includes(j.adThreshold) ? j.adThreshold : DEFAULT_SETTINGS.adThreshold,
      spotMode: j.spotMode === 'duck' || j.spotMode === 'skip' ? j.spotMode : 'off',
      showLyrics: j.showLyrics !== false,
      lyricsHighlight: j.lyricsHighlight !== false,
      playlistRefreshMin: REFRESH_CHOICES.includes(j.playlistRefreshMin) ? j.playlistRefreshMin : DEFAULT_SETTINGS.playlistRefreshMin,
      lyricsAlign: cleanAlign(j.lyricsAlign),
      playlists: SLOTS.map((i) => (Array.isArray(j.playlists) && typeof j.playlists[i] === 'string' ? j.playlists[i] : '')),
      playlistNames: SLOTS.map((i) => (Array.isArray(j.playlistNames) && typeof j.playlistNames[i] === 'string' ? j.playlistNames[i].slice(0, 60) : '')),
      playlistSlot: Number.isInteger(j.playlistSlot) && j.playlistSlot >= 0 && j.playlistSlot < PLAYLIST_SLOTS ? j.playlistSlot : 0,
      projectorMode: j.projectorMode === 'video' ? 'video' : 'karaoke',
      playlistSort: ['custom', 'name', 'recent', 'size'].includes(j.playlistSort) ? j.playlistSort : 'custom',
      locked: Array.isArray(j.locked) ? j.locked.filter((x: unknown): x is string => typeof x === 'string') : [],
    };
    const mic = str(j.micDeviceId), disp = str(j.projectorDisplay), pl = str(j.playlistText), cur = str(j.currentPlaylistId), key = str(j.ytApiKey);
    if (cur) out.currentPlaylistId = cur;
    if (key) out.ytApiKey = key.trim().slice(0, 100);
    if (mic) out.micDeviceId = mic;
    if (disp) out.projectorDisplay = disp;
    const dl = str(j.projectorDisplayLabel);
    if (dl) out.projectorDisplayLabel = dl;
    if (pl) out.playlistText = pl;
    if (pl && !Array.isArray(j.playlists)) out.playlists[0] = pl; // before two playlists existed: the old one becomes Playlist 1
    return out;
  } catch {
    return fresh();
  }
}

export function saveSettings(store: Storage, s: Settings): void {
  try { store.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: keep running */ }
}
