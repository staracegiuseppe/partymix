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
  constructor(private clock: Clock, private neverLoad = new Set<string>(), private dur = 60) {}
  load(id: string) {
    this.loads.push(id); this.id = id; this.pos = 0; this.halt();
    if (this.neverLoad.has(id)) return new Promise<void>(() => {});
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
  position() { return this.playing ? this.pos + (this.clock.now - this.startedAt) / 1000 : this.pos; }
  duration() { return this.dur; }
  onEnded(cb: () => void) { this.endCb = cb; }
  onError(cb: (c: number) => void) { this.errCb = cb; }
  get vol() { return this.vols[this.vols.length - 1]; }
}

const tr = (id: string): Track => ({ videoId: id, status: 'ok' });

function setup(opts: { ids?: string[]; profile?: Profile; master?: number; never?: string[]; dur?: number } = {}) {
  const clock = new Clock();
  const never = new Set(opts.never ?? []);
  const decks: [FakeDeck, FakeDeck] = [new FakeDeck(clock, never, opts.dur), new FakeDeck(clock, never, opts.dur)];
  const queue = new Queue((opts.ids ?? ['A', 'B', 'C']).map(tr));
  let profile: Profile = opts.profile ?? 'standard';
  let master = opts.master ?? 100;
  const am = new Automix({
    decks, queue, profile: () => profile, masterVolume: () => master,
    now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
  });
  return { clock, decks, queue, am, setProfile: (p: Profile) => (profile = p), setMaster: (m: number) => (master = m) };
}

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
