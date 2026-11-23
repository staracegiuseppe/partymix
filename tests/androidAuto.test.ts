import { afterEach, describe, expect, it, vi } from 'vitest';
import { artOf, autoCommand, nowOf, playlistsOf, startAndroidAuto, tracksOf, type AutoControls } from '../src/androidAuto';
import type { Playlist } from '../src/library/playlists';
import type { Track } from '../src/queue';

const w = window as unknown as { PartyMixAndroid?: unknown };
afterEach(() => { delete w.PartyMixAndroid; vi.useRealTimers(); });

const tr = (id: string, extra: Partial<Track> = {}): Track => ({ videoId: id, title: `Song ${id}`, artist: 'Band', status: 'ok', ...extra });
const pl = (id: string, tracks: Track[], extra: Partial<Playlist> = {}): Playlist => ({ id, name: `List ${id}`, tracks, createdAt: 0, updatedAt: 0, sortOrder: 0, ...extra });

function controls(over: Partial<AutoControls> = {}): AutoControls {
  return {
    state: () => 'playing', hasQueue: () => true, currentPlaylist: () => 'p1',
    start: vi.fn(), resume: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), playPlaylist: vi.fn(),
    ...over,
  };
}

describe('artOf', () => {
  it('uses the YouTube thumbnail of a video id', () => {
    expect(artOf(tr('dQw4w9WgXcQ'))).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });
  it('keeps an https cover of its own', () => {
    expect(artOf(tr('x', { thumb: 'https://i.scdn.co/image/abc' }))).toBe('https://i.scdn.co/image/abc');
  });
  it('gives no cover for local or NAS songs, nor for plain http links', () => {
    expect(artOf(tr('local:abc'))).toBe('');
    expect(artOf(tr('nas:12'))).toBe('');
    expect(artOf(tr('local:abc', { thumb: 'http://10.0.0.2/c.jpg' }))).toBe('');
  });
});

describe('playlistsOf / tracksOf', () => {
  it('lists the playlists with count and cover (own cover first, else the first song)', () => {
    const out = playlistsOf([pl('a', [tr('v1')]), pl('b', [], { cover: 'https://x.test/c.jpg' })]);
    expect(out).toEqual([
      { id: 'a', name: 'List a', count: 1, art: 'https://i.ytimg.com/vi/v1/hqdefault.jpg' },
      { id: 'b', name: 'List b', count: 0, art: 'https://x.test/c.jpg' },
    ]);
  });
  it('skips unplayable songs and stops at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => tr(`v${i}`));
    many[1].status = 'unplayable';
    const out = tracksOf(pl('a', many), 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ id: 'v0', title: 'Song v0', artist: 'Band', art: 'https://i.ytimg.com/vi/v0/hqdefault.jpg' });
    expect(out.map((t) => t.id)).not.toContain('v1');
  });
  it('gives a title to songs without one', () => {
    expect(tracksOf(pl('a', [{ videoId: 'zz', status: 'ok' }]))[0].title).toBe('Video zz');
  });
});

describe('nowOf', () => {
  it('maps the automix state to what the car shows', () => {
    expect(nowOf('crossfading', tr('v1'), 12.4, 200, 'Festa')).toMatchObject({ state: 'playing', id: 'v1', title: 'Song v1', artist: 'Band', album: 'Festa', pos: 12400, dur: 200000 });
    expect(nowOf('preparing', tr('v1'), 0, 0, '').state).toBe('playing');
    expect(nowOf('paused', tr('v1'), 3, 10, '').state).toBe('paused');
    expect(nowOf('idle', undefined, 0, 0, '')).toMatchObject({ state: 'idle', id: '', title: '' });
  });
});

describe('autoCommand', () => {
  it('pause, next and previous go to the automix', () => {
    const c = controls();
    autoCommand({ cmd: 'pause' }, c);
    autoCommand({ cmd: 'next' }, c);
    autoCommand({ cmd: 'prev' }, c);
    expect(c.pause).toHaveBeenCalledOnce();
    expect(c.next).toHaveBeenCalledOnce();
    expect(c.prev).toHaveBeenCalledOnce();
  });
  it('stop from the car only pauses: the party is not thrown away', () => {
    const c = controls();
    autoCommand({ cmd: 'stop' }, c);
    expect(c.pause).toHaveBeenCalledOnce();
  });
  it('play resumes a paused mix', () => {
    const c = controls({ state: () => 'paused' });
    autoCommand({ cmd: 'play' }, c);
    expect(c.resume).toHaveBeenCalledOnce();
    expect(c.start).not.toHaveBeenCalled();
  });
  it('play starts the queue when idle', () => {
    const c = controls({ state: () => 'idle' });
    autoCommand({ cmd: 'play' }, c);
    expect(c.start).toHaveBeenCalledOnce();
  });
  it('play with an empty queue opens the playlist in use', () => {
    const c = controls({ state: () => 'idle', hasQueue: () => false });
    autoCommand({ cmd: 'play' }, c);
    expect(c.playPlaylist).toHaveBeenCalledWith('p1');
  });
  it('play while already playing does nothing', () => {
    const c = controls();
    autoCommand({ cmd: 'play' }, c);
    expect(c.resume).not.toHaveBeenCalled();
    expect(c.start).not.toHaveBeenCalled();
  });
  it('plays a playlist, or a song of a playlist, chosen in the car', () => {
    const c = controls();
    autoCommand({ cmd: 'playlist', id: 'p2' }, c);
    autoCommand({ cmd: 'track', playlist: 'p2', id: 'v9' }, c);
    expect(c.playPlaylist).toHaveBeenNthCalledWith(1, 'p2');
    expect(c.playPlaylist).toHaveBeenNthCalledWith(2, 'p2', 'v9');
  });
  it('ignores anything else', () => {
    const c = controls();
    autoCommand({ cmd: 'rm -rf' } as never, c);
    autoCommand({ cmd: 'playlist' } as never, c);
    autoCommand(null as never, c);
    expect(c.playPlaylist).not.toHaveBeenCalled();
  });
});

describe('startAndroidAuto', () => {
  it('does nothing without the Android bridge', () => {
    const stop = startAndroidAuto({ ...controls(), playlists: () => [], playlist: () => undefined, onPlaylistsChange: () => () => {}, now: () => nowOf('idle', undefined, 0, 0, '') });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('pushes the playlists, the song on air, answers track requests and runs commands', () => {
    vi.useFakeTimers();
    const autoPlaylists = vi.fn(), autoNow = vi.fn(), autoTracks = vi.fn();
    w.PartyMixAndroid = { autoPlaylists, autoNow, autoTracks };
    let changed = () => {};
    const lists = [pl('a', [tr('v1'), tr('v2')])];
    let on = tr('v1');
    const c = controls();
    const stop = startAndroidAuto({
      ...c, playlists: () => lists, playlist: (id) => lists.find((p) => p.id === id),
      onPlaylistsChange: (fn) => { changed = fn; return () => {}; },
      now: () => nowOf('playing', on, 1, 100, 'List a'),
    });
    expect(JSON.parse(autoPlaylists.mock.calls[0][0])).toEqual([{ id: 'a', name: 'List a', count: 2, art: 'https://i.ytimg.com/vi/v1/hqdefault.jpg' }]);
    expect(JSON.parse(autoNow.mock.calls[0][0])).toMatchObject({ state: 'playing', id: 'v1' });

    // same song: nothing new for a while, then a periodic resync of the playhead
    vi.advanceTimersByTime(1000);
    expect(autoNow).toHaveBeenCalledTimes(1);
    on = tr('v2');
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(autoNow.mock.calls[1][0]).id).toBe('v2');

    // playlists changed: pushed again, a little later
    changed();
    vi.advanceTimersByTime(1000);
    expect(autoPlaylists).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'tracks', req: 7, playlist: 'a' } }));
    expect(autoTracks).toHaveBeenCalledWith(7, expect.any(String));
    expect(JSON.parse(autoTracks.mock.calls[0][1]).map((t: { id: string }) => t.id)).toEqual(['v1', 'v2']);
    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'tracks', req: 8, playlist: 'nope' } }));
    expect(autoTracks).toHaveBeenLastCalledWith(8, '[]');

    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'next' } }));
    expect(c.next).toHaveBeenCalledOnce();

    // «hello»: the car connected, everything is sent again at once
    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'hello' } }));
    expect(autoPlaylists).toHaveBeenCalledTimes(3);
    expect(autoNow).toHaveBeenCalledTimes(3);

    stop();
    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'next' } }));
    expect(c.next).toHaveBeenCalledOnce();
  });

  it('kicks a song chosen in the car that stays at 0:00 (pause + resume, once)', () => {
    vi.useFakeTimers();
    w.PartyMixAndroid = { autoPlaylists: vi.fn(), autoNow: vi.fn(), autoTracks: vi.fn() };
    const lists = [pl('a', [tr('v1')])];
    let st: 'playing' | 'paused' = 'playing';
    const c = controls({ state: () => st, pause: vi.fn(() => { st = 'paused'; }), resume: vi.fn(() => { st = 'playing'; }) });
    const stop = startAndroidAuto({ ...c, playlists: () => lists, playlist: () => lists[0], onPlaylistsChange: () => () => {}, now: () => nowOf('playing', tr('v1'), 0.05, 200, 'a') });
    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'track', playlist: 'a', id: 'v1' } }));
    vi.advanceTimersByTime(3000);
    expect(c.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(c.pause).toHaveBeenCalledOnce();
    expect(c.resume).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20000);
    expect(c.pause).toHaveBeenCalledOnce();
    stop();
  });

  it('leaves alone a song that is moving', () => {
    vi.useFakeTimers();
    w.PartyMixAndroid = { autoPlaylists: vi.fn(), autoNow: vi.fn(), autoTracks: vi.fn() };
    const lists = [pl('a', [tr('v1')])];
    const c = controls();
    let pos = 0;
    const stop = startAndroidAuto({ ...c, playlists: () => lists, playlist: () => lists[0], onPlaylistsChange: () => () => {}, now: () => nowOf('playing', tr('v1'), (pos += 0.25), 200, 'a') });
    window.dispatchEvent(new CustomEvent('partymix-auto', { detail: { cmd: 'playlist', id: 'a' } }));
    vi.advanceTimersByTime(20000);
    expect(c.pause).not.toHaveBeenCalled();
    stop();
  });
});
