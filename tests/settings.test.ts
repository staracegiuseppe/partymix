import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings';

const mem = (init?: string): Storage => {
  let v = init;
  return { getItem: () => v ?? null, setItem: (_k: string, x: string) => { v = x; } } as unknown as Storage;
};

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings(mem())).toEqual(DEFAULT_SETTINGS);
  });
  it('returns defaults for corrupted JSON without throwing', () => {
    expect(loadSettings(mem('{not json'))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(mem('null'))).toEqual(DEFAULT_SETTINGS);
  });
  it('round-trips', () => {
    const s = { ...DEFAULT_SETTINGS, profile: 'energica' as const, master: 33, locked: ['a'], playlistText: 'https://youtu.be/b2GlV6Ap-3g' };
    const store = mem();
    saveSettings(store, s);
    expect(loadSettings(store)).toEqual(s);
  });
  it('ignores unknown fields and clamps/validates values', () => {
    const raw = JSON.stringify({ master: 500, profile: 'boh', repeat: 'x', shuffle: 'yes', micSensitivity: -4, junk: 1, locked: [1, 'ok'] });
    const s = loadSettings(mem(raw));
    expect(s.master).toBe(100);
    expect(s.profile).toBe(DEFAULT_SETTINGS.profile);
    expect(s.repeat).toBe('off');
    expect(s.shuffle).toBe(false);
    expect(s.micSensitivity).toBeGreaterThan(0);
    expect(s.locked).toEqual(['ok']);
    expect('junk' in s).toBe(false);
  });
  it('survives a storage that throws', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(bad, DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe('playlist refresh setting', () => {
  it('defaults to every 5 minutes, accepts 0 (manual) and rejects odd values', () => {
    expect(DEFAULT_SETTINGS.playlistRefreshMin).toBe(5);
    expect(loadSettings(mem(JSON.stringify({ playlistRefreshMin: 0 }))).playlistRefreshMin).toBe(0);
    expect(loadSettings(mem(JSON.stringify({ playlistRefreshMin: 10 }))).playlistRefreshMin).toBe(10);
    expect(loadSettings(mem(JSON.stringify({ playlistRefreshMin: 7 }))).playlistRefreshMin).toBe(5);
    expect(loadSettings(mem(JSON.stringify({ playlistRefreshMin: 'x' }))).playlistRefreshMin).toBe(5);
  });
});

describe('lyrics alignment setting', () => {
  it('round-trips and validates entries', () => {
    const store = mem();
    saveSettings(store, { ...DEFAULT_SETTINGS, lyricsAlign: { abc: { a: 0.8, b: -12 } } });
    expect(loadSettings(store).lyricsAlign).toEqual({ abc: { a: 0.8, b: -12 } });
    const raw = JSON.stringify({ lyricsAlign: { ok: { a: 1.1, b: 3 }, bad1: { a: 'x', b: 1 }, bad2: 5, wild: { a: 9, b: 99999 } } });
    const s = loadSettings(mem(raw));
    expect(Object.keys(s.lyricsAlign).sort()).toEqual(['ok', 'wild']);
    expect(s.lyricsAlign.wild.a).toBe(2);
    expect(s.lyricsAlign.wild.b).toBe(600);
  });
  it('defaults to nothing aligned', () => {
    expect(DEFAULT_SETTINGS.lyricsAlign).toEqual({});
  });
});
