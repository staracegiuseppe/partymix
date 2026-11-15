import { Automix, Deck } from '../src/automix';
import { Queue, Track } from '../src/queue';
import { Profile } from '../src/crossfade';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

class Clock {
  now = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  setTimer = (fn: () => void, ms: number) => { const id = this.nextId++; this.timers.push({ id, at: this.now + ms, fn }); return id; };
  clearTimer = (id: number) => { this.timers = this.timers.filter((t) => t.id !== id); };
  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

class FakeDeck implements Deck {
  vols: number[] = [];
  loads: string[] = [];
  stops = 0;
  playCalls = 0;
  playing = false;
  id = '';
  private pos = 0;
  private startedAt = 0;
  private endTimer?: number;
  endCb: () => void = () => {};
  errCb: (c: number) => void = () => {};
  failLoad = new Map<string, 'unplayable' | 'timeout'>();
  constructor(private clock: Clock, private neverLoad = new Set<string>(), private dur = 60) {}
  load(id: string) {
    this.loads.push(id); this.id = id; this.pos = 0; this.halt();
    if (this.neverLoad.has(id)) return new Promise<void>(() => {});
    const fail = this.failLoad.get(id);
    if (fail) return Promise.reject(Object.assign(new Error('boom'), { kind: fail }));
    return new Promise<void>((r) => this.clock.setTimer(() => r(), 0));
  }
  private halt() { if (this.playing) this.pos = this.position(); this.playing = false; if (this.endTimer) this.clock.clearTimer(this.endTimer); this.endTimer = undefined; }
  play() {
    this.playCalls++;
    if (this.playing) return;
    this.playing = true; this.startedAt = this.clock.now;
    this.endTimer = this.clock.setTimer(() => { this.playing = false; this.pos = this.dur; this.endCb(); }, (this.dur - this.pos) * 1000);
  }
  pause() { this.halt(); }
  stop() { this.stops++; this.halt(); this.pos = 0; }
  setVolume(v: number) { this.vols.push(v); }
  seeks: number[] = [];
  seekTo(sec: number) { this.seeks.push(sec); this.pos = sec; }
  position() { return this.playing ? this.pos + (this.clock.now - this.startedAt) / 1000 : this.pos; }
  duration() { return this.dur; }
  onEnded(cb: () => void) { this.endCb = cb; }
  onError(cb: (c: number) => void) { this.errCb = cb; }
  get vol() { return this.vols[this.vols.length - 1]; }
}

const tr = (id: string): Track => ({ videoId: id, status: 'ok' });

function setup(opts: { ids?: string[]; profile?: Profile; master?: number; never?: string[]; dur?: number; cues?: Record<string, { start: number; end: number }> } = {}) {
  const clock = new Clock();
  const never = new Set(opts.never ?? []);
  const decks: [FakeDeck, FakeDeck] = [new FakeDeck(clock, never, opts.dur), new FakeDeck(clock, never, opts.dur)];
  const queue = new Queue((opts.ids ?? ['A', 'B', 'C']).map(tr));
  let profile: Profile = opts.profile ?? 'standard';
  let master = opts.master ?? 100;
  let online = true;
  const am = new Automix({
    decks, queue, profile: () => profile, masterVolume: () => master,
    now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {}, online: () => online,
    cues: opts.cues ? (id) => opts.cues![id] : undefined,
  });
  return { clock, decks, queue, am, setOnline: (v: boolean) => (online = v), setProfile: (p: Profile) => (profile = p), setMaster: (m: number) => (master = m) };
}

describe('Automix: silence and near-silent intros', () => {
  it('fades out before the silent tail and brings the next song in where its music starts', async () => {
    const s = setup({ cues: { A: { start: 0, end: 40 }, B: { start: 5, end: 60 } } }); // A: 20 s of silence at the end; B: 5 s before the music
    s.am.start(); await s.clock.advance(100);
    await s.clock.advance(30_000);
    expect(s.am.state()).toBe('playing');
    await s.clock.advance(8_000); // 38 s: inside the mix window before A's real end (40 s), not 52 s
    expect(s.am.state()).toBe('crossfading');
    expect(s.decks[1].seeks).toEqual([5]);
    await s.clock.advance(10_000);
    expect(s.queue.current()?.videoId).toBe('B');
  });
});

describe('Automix', () => {
  it('(a) crossfades before the end and hands over to the next deck', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(100);
    expect(s.am.state()).toBe('playing');
    await s.clock.advance(50_000);
    expect(s.am.state()).toBe('playing');
    await s.clock.advance(4_000);
    expect(s.am.state()).toBe('crossfading');
    expect(s.decks[0].vol).toBeLessThan(100);
    expect(s.decks[1].vol).toBeGreaterThan(0);
    await s.clock.advance(8_000);
    expect(s.am.state()).toBe('playing');
    expect(s.am.activeDeck()).toBe(1);
    expect(s.decks[0].stops).toBeGreaterThan(0);
    expect(s.decks[1].vol).toBe(100);
    expect(s.queue.current()?.videoId).toBe('B');
  });

  it('(b) never exceeds the master volume', async () => {
    const s = setup({ master: 50 });
    s.am.start(); await s.clock.advance(70_000);
    expect(Math.max(...s.decks[0].vols, ...s.decks[1].vols)).toBeLessThanOrEqual(50);
    expect(s.decks[1].vol).toBe(50);
  });

  it('(c) skips a next track that does not load within 5 s', async () => {
    const s = setup({ never: ['B'] });
    s.am.start(); await s.clock.advance(65_000);
    expect(s.queue.all()[1].status).toBe('unplayable');
    expect(s.decks[1].loads).toContain('C');
    expect(s.am.activeDeck()).toBe(1);
    expect(s.am.state()).toBe('playing');
  });

  it('(d) mixNow during a crossfade does not start a second one', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(1_000);
    s.am.mixNow(); s.am.mixNow();
    expect(s.am.state()).toBe('crossfading');
    await s.clock.advance(9_000);
    expect(s.am.state()).toBe('playing');
    expect(s.decks[1].loads).toEqual(['B']);
    expect(s.decks[1].playCalls).toBe(1);
  });

  it('(e) next during a crossfade completes it at once', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(1_000);
    s.am.mixNow(); await s.clock.advance(2_000);
    s.am.next();
    expect(s.am.state()).toBe('playing');
    expect(s.am.activeDeck()).toBe(1);
    expect(s.decks[1].vol).toBe(100);
    expect(s.decks[0].stops).toBeGreaterThan(0);
  });

  it('(f) pause freezes a crossfade and resume continues from the same progress', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(1_000);
    s.am.mixNow(); await s.clock.advance(4_000);
    const frozen = s.decks[1].vol;
    s.am.pause();
    await s.clock.advance(30_000);
    expect(s.am.state()).toBe('paused');
    expect(s.decks[1].vol).toBe(frozen);
    s.am.resume();
    await s.clock.advance(2_000);
    expect(s.am.state()).toBe('crossfading');
    await s.clock.advance(3_000);
    expect(s.am.state()).toBe('playing');
  });

  it('(g) manual profile never mixes by itself before the end', async () => {
    const s = setup({ profile: 'manuale' });
    s.am.start(); await s.clock.advance(58_000);
    expect(s.am.state()).toBe('playing');
    expect(s.am.activeDeck()).toBe(0);
  });

  it('(h) goes idle when the queue is over', async () => {
    const s = setup({ ids: ['A'], dur: 30 });
    s.am.start(); await s.clock.advance(31_000);
    expect(s.am.state()).toBe('idle');
  });

  it('(i) a fatal error on the active deck moves on without stopping the party', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(10_000);
    s.decks[0].errCb(150); await s.clock.advance(100);
    expect(s.queue.all()[0].status).toBe('unplayable');
    expect(s.am.activeDeck()).toBe(1);
    expect(s.am.state()).toBe('playing');
  });

  it('stop resets the queue and silences both decks', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(20_000);
    s.am.next(); await s.clock.advance(100);
    s.am.stop();
    expect(s.am.state()).toBe('idle');
    expect(s.queue.current()?.videoId).toBe('A');
    expect(s.decks[0].playing || s.decks[1].playing).toBe(false);
  });

  it('a single-track playlist never crashes and ends cleanly', async () => {
    const s = setup({ ids: ['A'], dur: 20 });
    s.am.start(); await s.clock.advance(5_000);
    s.am.next(); s.am.mixNow();
    await s.clock.advance(20_000);
    expect(s.am.state()).toBe('idle');
  });
});

describe('Automix status for the UI', () => {
  it('reports next-track status and crossfade progress', async () => {
    const s = setup();
    expect(s.am.mixProgress()).toBe(0);
    s.am.start(); await s.clock.advance(500);
    expect(s.am.nextStatus()).toBe('ready');
    s.am.mixNow(); await s.clock.advance(4_000);
    const p = s.am.mixProgress();
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.8);
    await s.clock.advance(10_000);
    expect(s.am.mixProgress()).toBe(0);
  });
  it('applies per-deck volume on top of the master volume', async () => {
    const clock = new Clock();
    const decks: [FakeDeck, FakeDeck] = [new FakeDeck(clock), new FakeDeck(clock)];
    const am = new Automix({
      decks, queue: new Queue([tr('A'), tr('B')]), profile: () => 'standard', masterVolume: () => 80,
      deckVolume: (i) => (i === 0 ? 0.5 : 1), now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
    });
    am.start(); await clock.advance(500);
    expect(decks[0].vol).toBe(40);
  });
});

describe('Automix follows queue reordering', () => {
  it('reloads the next deck when the next track is changed', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(500);
    expect(s.decks[1].loads).toEqual(['B']);
    s.queue.move(2, 1);
    await s.clock.advance(500);
    expect(s.decks[1].loads).toEqual(['B', 'C']);
    expect(s.am.nextStatus()).toBe('ready');
    s.am.mixNow(); await s.clock.advance(9_000);
    expect(s.queue.current()?.videoId).toBe('C');
    expect(s.decks[1].id).toBe('C');
  });
  it('a reorder during a crossfade does not change the track being mixed in', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(500);
    s.am.mixNow(); await s.clock.advance(2_000);
    s.queue.move(2, 1);
    await s.clock.advance(9_000);
    expect(s.queue.current()?.videoId).toBe('B');
    expect(s.decks[1].id).toBe('B');
    expect(s.am.state()).toBe('playing');
  });
  it('does not keep reloading when nothing changed', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(5_000);
    expect(s.decks[1].loads).toEqual(['B']);
  });
});

describe('Automix.withSpareDeck', () => {
  it('lends the off-air deck, then prepares the next track again', async () => {
    const s = setup({ dur: 200 });
    s.am.start(); await s.clock.advance(1_000);
    expect(s.decks[1].loads).toEqual(['B']);
    let lent: unknown;
    const r = await s.am.withSpareDeck(async (d) => { lent = d; return 42; });
    expect(r).toEqual({ ok: true, value: 42 });
    expect(lent).toBe(s.decks[1]);
    await s.clock.advance(500);
    expect(s.decks[1].loads).toEqual(['B', 'B']);
    expect(s.am.nextStatus()).toBe('ready');
    expect(s.am.state()).toBe('playing');
  });
  it('refuses during a crossfade and when the track is about to end', async () => {
    const s = setup();
    s.am.start(); await s.clock.advance(500);
    s.am.mixNow(); await s.clock.advance(1_000);
    expect((await s.am.withSpareDeck(async () => 1)).ok).toBe(false);
    await s.clock.advance(10_000);
    await s.clock.advance(35_000); // 60 s track: less than 30 s left
    expect((await s.am.withSpareDeck(async () => 1)).ok).toBe(false);
  });
  it('reports a failing job and releases the deck', async () => {
    const s = setup({ dur: 200 });
    s.am.start(); await s.clock.advance(500);
    const r = await s.am.withSpareDeck(async () => { throw new Error('rete'); });
    expect(r.ok).toBe(false);
    await s.clock.advance(500);
    expect(s.am.nextStatus()).toBe('ready');
  });
});


describe('Automix review fixes', () => {
  it('Next pressed while the spare deck is lent is not lost: the mix happens once the next track is ready again', async () => {
    const s = setup({ dur: 200 });
    s.am.start(); await s.clock.advance(500);
    let release!: () => void;
    const job = s.am.withSpareDeck(() => new Promise<void>((r) => { release = r; }));
    s.am.next();
    expect(s.am.state()).not.toBe('idle');
    release(); await job; await s.clock.advance(1_000);
    expect(s.am.activeDeck()).toBe(1);
    expect(s.am.state()).toBe('playing');
  });
  it('Next on the last track stops the music instead of leaving an orphan deck playing', async () => {
    const s = setup({ ids: ['A'], dur: 200 });
    s.am.start(); await s.clock.advance(1_000);
    s.am.next();
    expect(s.am.state()).toBe('idle');
    expect(s.decks[0].playing || s.decks[1].playing).toBe(false);
  });
  it('refuses to lend the incoming deck when paused in the middle of a crossfade', async () => {
    const s = setup({ dur: 200 });
    s.am.start(); await s.clock.advance(500);
    s.am.mixNow(); await s.clock.advance(2_000);
    s.am.pause();
    expect((await s.am.withSpareDeck(async () => 1)).ok).toBe(false);
  });
  it('a real "unplayable" error marks the track at once', async () => {
    const s = setup();
    s.decks[1].failLoad.set('B', 'unplayable');
    s.am.start(); await s.clock.advance(500);
    expect(s.queue.all()[1].status).toBe('unplayable');
  });
  it('a load failure while offline never marks the track and is retried when the network is back', async () => {
    const s = setup();
    s.setOnline(false);
    s.decks[1].failLoad.set('B', 'timeout');
    s.am.start(); await s.clock.advance(20_000);
    expect(s.queue.all()[1].status).toBe('ok');
    const attempts = s.decks[1].loads.filter((x) => x === 'B').length;
    expect(attempts).toBeGreaterThan(1);
    s.decks[1].failLoad.clear(); s.setOnline(true);
    await s.clock.advance(10_000);
    expect(s.am.nextStatus()).toBe('ready');
    expect(s.queue.all()[1].status).toBe('ok');
  });
  it('a next track that is slow to load while offline is not skipped when the mix is due', async () => {
    const s = setup({ never: ['B'] });
    s.setOnline(false);
    s.am.start(); await s.clock.advance(58_000);
    expect(s.queue.all()[1].status).toBe('ok');
  });
});

describe('playNow (double click on a queue track)', () => {
  it('while playing: loads the picked track on the spare deck and fades it in over the current one', async () => {
    const s = setup({ ids: ['A', 'B', 'C', 'D'] });
    s.am.start(); await s.clock.advance(1_000);
    s.am.playNow('D'); await s.clock.advance(100);
    expect(s.decks[1].loads).toContain('D');
    expect(s.am.state()).toBe('crossfading');
    await s.clock.advance(6_000);
    expect(s.am.state()).toBe('playing');
    expect(s.queue.current()?.videoId).toBe('D');
    expect(s.am.activeDeck()).toBe(1);
    expect(s.queue.peekNext()?.videoId).toBe('B'); // the tracks it jumped over are still to come
  });
  it('picks the track even with repeat-one and a locked current track', async () => {
    const s = setup({ ids: ['A', 'B', 'C'] });
    s.queue.setRepeat('one'); s.queue.setLocked('A', true);
    s.am.start(); await s.clock.advance(1_000);
    s.am.playNow('C'); await s.clock.advance(6_000);
    expect(s.queue.current()?.videoId).toBe('C');
  });
  it('when stopped: starts the party from the picked track', async () => {
    const s = setup({ ids: ['A', 'B', 'C'] });
    s.am.playNow('C'); await s.clock.advance(100);
    expect(s.am.state()).toBe('playing');
    expect(s.decks[0].loads).toEqual(['C']);
    expect(s.queue.current()?.videoId).toBe('C');
  });
  it('ignores the track that is already playing and tracks that cannot be played', async () => {
    const s = setup({ ids: ['A', 'B'] });
    s.queue.markUnplayable('B');
    s.am.start(); await s.clock.advance(1_000);
    s.am.playNow('A'); s.am.playNow('B'); await s.clock.advance(500);
    expect(s.am.state()).toBe('playing');
    expect(s.queue.current()?.videoId).toBe('A');
  });
  it('during a crossfade: finishes it first, then fades to the picked track', async () => {
    const s = setup({ ids: ['A', 'B', 'C', 'D'] });
    s.am.start(); await s.clock.advance(1_000);
    s.am.mixNow(); await s.clock.advance(2_000);
    expect(s.am.state()).toBe('crossfading');
    s.am.playNow('D'); await s.clock.advance(6_000);
    expect(s.queue.current()?.videoId).toBe('D');
  });
});
