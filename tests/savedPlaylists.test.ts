import { describe, expect, it } from 'vitest';
import { loadSaved, saveSaved, slotLabel } from '../src/savedPlaylists';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as unknown as Storage; };

describe('playlists saved on the computer', () => {
  it('keeps name, link and songs per slot, without play state', () => {
    const s = mem();
    saveSaved(s, 1, { name: 'Just Dance', link: 'https://youtube.com/playlist?list=PL1', source: 'YouTube', tracks: [
      { videoId: 'dQw4w9WgXcQ', title: 'Never', artist: 'Rick', status: 'ok', locked: true },
      { videoId: '9bZkp7q19f0', status: 'unplayable' },
    ] }, 42);
    const p = loadSaved(s, 1)!;
    expect(p.name).toBe('Just Dance');
    expect(p.savedAt).toBe(42);
    expect(p.tracks).toEqual([{ videoId: 'dQw4w9WgXcQ', title: 'Never', artist: 'Rick', status: 'ok' }, { videoId: '9bZkp7q19f0', status: 'unplayable' }]);
    expect(loadSaved(s, 0)).toBeUndefined();
  });
  it('remembers the songs taken out, so an update does not bring them back', () => {
    const s = mem();
    saveSaved(s, 0, { name: '', link: 'x', source: 'YouTube', tracks: [{ videoId: 'dQw4w9WgXcQ', status: 'ok' }], removed: ['9bZkp7q19f0'] });
    expect(loadSaved(s, 0)!.removed).toEqual(['9bZkp7q19f0']);
  });
  it('ignores broken or empty data', () => {
    const s = mem();
    s.setItem('partymix.playlist.0', '{oops');
    expect(loadSaved(s, 0)).toBeUndefined();
    s.setItem('partymix.playlist.0', JSON.stringify({ tracks: [{ videoId: '<script>' }] }));
    expect(loadSaved(s, 0)).toBeUndefined();
  });
  it('labels a slot by its name or its number', () => {
    expect(slotLabel(0, '  ')).toBe('Playlist 1');
    expect(slotLabel(1, 'Karaoke')).toBe('Karaoke');
  });
});

import { loadSettings } from '../src/settings';
describe('karaoke word highlight option', () => {
  const st = (v: unknown) => ({ getItem: () => JSON.stringify(v), setItem: () => {} }) as unknown as Storage;
  it('is on unless the user turned it off', () => {
    expect(loadSettings(st({})).lyricsHighlight).toBe(true);
    expect(loadSettings(st({ lyricsHighlight: false })).lyricsHighlight).toBe(false);
  });
});
