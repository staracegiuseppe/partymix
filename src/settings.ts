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
  playlistText?: string;
  locked: string[];
  showLyrics: boolean;
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
  locked: [],
  showLyrics: true,
  playlistRefreshMin: 5,
  lyricsAlign: {},
};

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
    if (!raw) return { ...DEFAULT_SETTINGS };
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { ...DEFAULT_SETTINGS };
    const out: Settings = {
      profile: PROFILES.includes(j.profile) ? j.profile : DEFAULT_SETTINGS.profile,
      master: num(j.master, 0, 100, DEFAULT_SETTINGS.master),
      shuffle: j.shuffle === true,
      repeat: REPEATS.includes(j.repeat) ? j.repeat : 'off',
      micSensitivity: num(j.micSensitivity, 0.1, 5, DEFAULT_SETTINGS.micSensitivity),
      showLyrics: j.showLyrics !== false,
      playlistRefreshMin: REFRESH_CHOICES.includes(j.playlistRefreshMin) ? j.playlistRefreshMin : DEFAULT_SETTINGS.playlistRefreshMin,
      lyricsAlign: cleanAlign(j.lyricsAlign),
      locked: Array.isArray(j.locked) ? j.locked.filter((x: unknown): x is string => typeof x === 'string') : [],
    };
    const mic = str(j.micDeviceId), disp = str(j.projectorDisplay), pl = str(j.playlistText);
    if (mic) out.micDeviceId = mic;
    if (disp) out.projectorDisplay = disp;
    if (pl) out.playlistText = pl;
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: Storage, s: Settings): void {
  try { store.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: keep running */ }
}
