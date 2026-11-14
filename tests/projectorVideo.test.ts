import { describe, expect, it } from 'vitest';
import { parseVideoMsg, targetTime, VideoFollower, VideoPlayerLike, VideoStage } from '../src/projector/video';
import { loadSettings } from '../src/settings';

function fakePlayer() {
  const p = {
    calls: [] as string[], time: 0, state: -1, vid: '',
    loadVideoById(a: { videoId: string; startSeconds?: number }) { p.calls.push(`load ${a.videoId} ${a.startSeconds?.toFixed(1)}`); p.vid = a.videoId; p.time = a.startSeconds ?? 0; p.state = 3; },
    playVideo() { p.calls.push('play'); p.state = 1; },
    pauseVideo() { p.calls.push('pause'); p.state = 2; },
    seekTo(s: number) { p.calls.push(`seek ${s.toFixed(1)}`); p.time = s; },
    getCurrentTime: () => p.time,
    getPlayerState: () => p.state,
    getVideoData: () => ({ video_id: p.vid }),
  };
  return p;
}

describe('projector video follower', () => {
  it('loads the video being heard at the music time, hidden until it plays', () => {
    let now = 10_000;
    const p = fakePlayer();
    const f = new VideoFollower(p as VideoPlayerLike, () => now);
    expect(f.tick({ id: 'abc', t: 30, at: 9_000, playing: true })).toBe(false);
    expect(p.calls).toEqual(['load abc 31.0']);
    p.state = 1;
    now = 10_250; p.time = 31.2;
    expect(f.tick({ id: 'abc', t: 30, at: 9_000, playing: true })).toBe(true);
  });

  it('hides the picture while another video (an ad) plays and seeks back when far from the music', () => {
    let now = 0;
    const p = fakePlayer();
    const f = new VideoFollower(p as VideoPlayerLike, () => now);
    f.tick({ id: 'abc', t: 0, at: 0, playing: true });
    p.state = 1; p.vid = 'ad123'; now = 3_000;
    expect(f.tick({ id: 'abc', t: 0, at: 0, playing: true })).toBe(false);
    p.vid = 'abc'; p.time = 0.5; now = 6_000;
    expect(f.tick({ id: 'abc', t: 0, at: 0, playing: true })).toBe(false);
    expect(p.calls.at(-1)).toBe('seek 6.1');
  });

  it('pauses when the music pauses or stops', () => {
    const p = fakePlayer();
    const f = new VideoFollower(p as VideoPlayerLike, () => 0);
    f.tick({ id: 'abc', t: 5, at: 0, playing: true });
    p.state = 1;
    f.tick({ id: 'abc', t: 5, at: 0, playing: false });
    expect(p.calls.at(-1)).toBe('pause');
    expect(f.tick({ id: '', t: 0, at: 0, playing: false })).toBe(false);
  });

  it('reads messages defensively and moves the target with the clock', () => {
    expect(parseVideoMsg('nope')).toBeUndefined();
    const m = parseVideoMsg(JSON.stringify({ id: 'x', t: 10, at: 1000, playing: true }))!;
    expect(targetTime(m, 3000)).toBe(12);
    expect(targetTime({ ...m, playing: false }, 3000)).toBe(10);
  });
});

describe('two playlists and projector mode settings', () => {
  const mem = (v: unknown) => ({ getItem: () => JSON.stringify(v), setItem: () => {} }) as unknown as Storage;
  it('turns the old single playlist into Playlist 1', () => {
    const s = loadSettings(mem({ playlistText: 'https://youtube.com/playlist?list=PL1' }));
    expect(s.playlists).toEqual(['https://youtube.com/playlist?list=PL1', '', '', '']);
    expect(s.playlistSlot).toBe(0);
    expect(s.projectorMode).toBe('karaoke');
  });
  it('keeps both links, the slot in use and the video mode', () => {
    const s = loadSettings(mem({ playlists: ['a', 'b'], playlistSlot: 1, projectorMode: 'video', playlistText: 'b' }));
    expect(s.playlists).toEqual(['a', 'b', '', '']);
    expect(s.playlistSlot).toBe(1);
    expect(s.projectorMode).toBe('video');
  });
  it('has four playlists: the fourth can be in use, a slot out of range falls back to the first', () => {
    const s = loadSettings(mem({ playlists: ['a', 'b', 'c', 'd', 'e'], playlistNames: ['', '', '', 'Matrimonio'], playlistSlot: 3 }));
    expect(s.playlists).toEqual(['a', 'b', 'c', 'd']);
    expect(s.playlistNames[3]).toBe('Matrimonio');
    expect(s.playlistSlot).toBe(3);
    expect(loadSettings(mem({ playlistSlot: 4 })).playlistSlot).toBe(0);
    expect(loadSettings(mem({ playlistSlot: 1.5 })).playlistSlot).toBe(0);
  });
  it('defaults do not share the playlists array', () => {
    const empty = { getItem: () => null, setItem: () => {} } as unknown as Storage;
    const a = loadSettings(empty), b = loadSettings(empty);
    a.playlists[0] = 'x';
    expect(b.playlists[0]).toBe('');
  });
});

describe('next video preloaded on the second player', () => {
  it('lets an ad play out hidden, then waits paused at the start of the real video', () => {
    const p = fakePlayer();
    const f = new VideoFollower(p as VideoPlayerLike, () => 0);
    f.preload('nxt');
    expect(p.calls).toEqual(['load nxt 0.1']);
    p.state = 1; p.vid = 'ad999'; p.time = 2;
    f.preload('nxt');
    expect(f.isReady('nxt')).toBe(false);
    p.vid = 'nxt'; p.time = 0.5;
    f.preload('nxt');
    expect(p.calls.slice(-2)).toEqual(['pause', 'seek 0.1']);
    expect(f.isReady('nxt')).toBe(true);
  });

  it('switches to the ready player when the song changes and keeps the old picture until the new one plays', () => {
    let now = 0;
    const a = fakePlayer(), b = fakePlayer();
    const stage = new VideoStage([new VideoFollower(a as VideoPlayerLike, () => now), new VideoFollower(b as VideoPlayerLike, () => now)], () => now);
    stage.tick({ id: 'one', t: 0, at: 0, playing: true, next: 'two' });
    a.state = 1; a.time = 0.25; now = 250;
    expect(stage.tick({ id: 'one', t: 0, at: 0, playing: true, next: 'two' })).toEqual([true, false]);
    expect(b.calls).toEqual(['load two 0.1']); // the next video is already loading
    b.state = 1; b.vid = 'two'; b.time = 0.5;
    stage.tick({ id: 'one', t: 0, at: 0, playing: true, next: 'two' });
    expect(b.calls.slice(-2)).toEqual(['pause', 'seek 0.1']);
    // the song changes: player B takes over, A stays on screen until B is in step
    now = 3000;
    expect(stage.tick({ id: 'two', t: 4, at: 3000, playing: true })).toEqual([true, false]);
    expect(b.calls.at(-1)).toBe('seek 4.1');
    b.state = 1; b.time = 4.1; now = 3250;
    expect(stage.tick({ id: 'two', t: 4, at: 3000, playing: true, next: 'three' })).toEqual([false, true]);
    expect(a.calls.at(-1)).toBe('load three 0.1'); // A now prepares the song after
  });
});
