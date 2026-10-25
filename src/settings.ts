import type { Profile } from './crossfade';

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
};

export const DEFAULT_SETTINGS: Settings = {
  profile: 'standard',
  master: 80,
  shuffle: false,
  repeat: 'off',
  micSensitivity: 1,
  locked: [],
  showLyrics: true,
};

const KEY = 'partymix.settings';
const PROFILES: Profile[] = ['morbida', 'standard', 'energica', 'manuale'];
const REPEATS = ['off', 'all', 'one'] as const;

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

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
