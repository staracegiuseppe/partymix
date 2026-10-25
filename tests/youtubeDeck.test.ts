import { mapYtError, YouTubeDeck, YtPlayerLike } from '../src/youtubeDeck';

class FakePlayer implements YtPlayerLike {
  calls: string[] = [];
  time = 0;
  cueVideoById(a: { videoId: string; startSeconds?: number } | string) { this.calls.push('cue:' + (typeof a === 'string' ? a : `${a.videoId}@${a.startSeconds ?? 0}`)); }
  loadVideoById(a: { videoId: string; startSeconds?: number }) { this.calls.push(`load:${a.videoId}@${a.startSeconds ?? 0}`); }
  playVideo() { this.calls.push('play'); }
  pauseVideo() { this.calls.push('pause'); }
  stopVideo() { this.calls.push('stop'); }
  setVolume(v: number) { this.calls.push('vol:' + v); }
  getCurrentTime() { return this.time; }
  getDuration() { return 200; }
  seekTo() {}
}

function mk() {
  const p = new FakePlayer();
  const timers: { fn: () => void; ms: number }[] = [];
  const d = new YouTubeDeck(p, { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  return { p, d, timers };
}

describe('mapYtError', () => {
  it('classifies the documented codes', () => {
    expect(mapYtError(2).kind).toBe('retry');
    expect(mapYtError(5).kind).toBe('retry');
    for (const c of [100, 101, 150]) expect(mapYtError(c).kind).toBe('unplayable');
    const e153 = mapYtError(153);
    expect(e153.kind).toBe('unplayable');
    expect(e153.reason).toMatch(/origine/);
    expect(mapYtError(999).kind).toBe('retry');
  });
});

describe('YouTubeDeck', () => {
  it('load cues the video and resolves when YouTube reports cued', async () => {
    const { p, d } = mk();
    const done = d.load('abc');
    expect(p.calls).toContain('cue:abc@0.05');
    d.handleState(5);
    await expect(done).resolves.toBeUndefined();
  });
  it('load rejects on an unplayable error', async () => {
    const { d } = mk();
    const done = d.load('abc');
    d.handleError(150);
    await expect(done).rejects.toThrow();
  });
  it('clamps volume to 0..100 and rounds', () => {
    const { p, d } = mk();
    d.setVolume(250); d.setVolume(-5); d.setVolume(42.6);
    expect(p.calls.filter((c) => c.startsWith('vol:'))).toEqual(['vol:100', 'vol:0', 'vol:43']);
  });
  it('reports position and duration from the player', () => {
    const { p, d } = mk();
    p.time = 12.5;
    expect(d.position()).toBe(12.5);
    expect(d.duration()).toBe(200);
  });
  it('fires ended when the state becomes 0', () => {
    const { d } = mk();
    let n = 0;
    d.onEnded(() => n++);
    d.handleState(0);
    expect(n).toBe(1);
  });
  it('retries a transient error at the same position with growing delays, then reports it', () => {
    const { p, d, timers } = mk();
    const errs: number[] = [];
    d.onError((c) => errs.push(c));
    d.load('abc'); d.handleState(5); d.play(); d.handleState(1);
    p.time = 30;
    for (let i = 0; i < 3; i++) { d.handleError(2); timers.at(-1)!.fn(); }
    expect(timers.map((t) => t.ms)).toEqual([1000, 3000, 7000]);
    expect(p.calls.filter((c) => c === 'load:abc@30')).toHaveLength(3);
    d.handleError(2);
    expect(errs).toEqual([2]);
  });
  it('does not start playing a prepared deck on retry', () => {
    const { p, d, timers } = mk();
    d.load('abc');
    d.handleError(5); timers.at(-1)!.fn();
    expect(p.calls).toContain('cue:abc@0.05');
    expect(p.calls.some((c) => c.startsWith('load:'))).toBe(false);
  });
  it('reports an unplayable error immediately', () => {
    const { d, timers } = mk();
    const errs: number[] = [];
    d.onError((c) => errs.push(c));
    d.handleError(101);
    expect(errs).toEqual([101]);
    expect(timers).toHaveLength(0);
  });
});

describe('YouTubeDeck.seekTo', () => {
  const mkSeek = () => {
    const calls: string[] = [];
    const p = { seekTo: (s: number, ahead: boolean) => calls.push(`seek:${s}:${ahead}`), getDuration: () => 200, getCurrentTime: () => 0 } as unknown as YtPlayerLike;
    return { calls, deck: new YouTubeDeck(p, { setTimer: () => 0, clearTimer: () => {} }) };
  };
  it('seeks to the requested second', () => {
    const { calls, deck } = mkSeek();
    deck.seekTo(75);
    expect(calls).toEqual(['seek:75:true']);
  });
  it('clamps below zero and past the end', () => {
    const { calls, deck } = mkSeek();
    deck.seekTo(-10);
    deck.seekTo(9999);
    expect(calls).toEqual(['seek:0:true', 'seek:199:true']);
  });
});

describe('YouTubeDeck load errors and retry cleanup', () => {
  it('tags errors so callers can tell unplayable videos from network trouble', async () => {
    const { d } = mk();
    const unplayable = d.load('a'); d.handleError(150);
    await expect(unplayable).rejects.toMatchObject({ kind: 'unplayable' });
    const d2 = mk().d;
    const exhausted = d2.load('b');
    for (let i = 0; i < 4; i++) d2.handleError(5);
    await expect(exhausted).rejects.toMatchObject({ kind: 'network' });
  });
  it('cancels a pending retry when a new video is loaded', () => {
    const p = new FakePlayer();
    const cleared: number[] = [];
    const d = new YouTubeDeck(p, { setTimer: () => 77, clearTimer: (id) => cleared.push(id) });
    d.load('a').catch(() => {});
    d.handleError(5);
    d.load('b').catch(() => {});
    expect(cleared).toEqual([77]);
  });
});
