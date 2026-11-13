import { describe, expect, it, vi } from 'vitest';
import { AdGuard } from '../src/adGuard';
import { FrameExtractor, Frame, SAMPLE_RATE } from '../src/audioAnalysis';
import { SpeechDetector, speechScore, evidence, isSpotLength } from '../src/adDetector';

const SR = SAMPLE_RATE;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };

/** A voice-like sound: a 130 Hz buzz shaped by vowel resonances, spoken in short phrases with pauses between them. */
function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR, syl = t % 0.27, phrase = t % 1.7;
    const talking = phrase < 1.25 ? 1 : 0.02; // 450 ms pauses
    const env = talking * Math.max(0, Math.sin((Math.PI * syl) / 0.2)) ** 1.5;
    let v = 0;
    for (let h = 1; h <= 14; h++) {
      const f = 130 * h, form = Math.exp(-((f - 350) ** 2) / 40000) + 0.3 * Math.exp(-((f - 1200) ** 2) / 200000);
      v += (form / h) * Math.sin(2 * Math.PI * f * t);
    }
    out[i] = 0.35 * env * v;
  }
  return out;
}

/** A song-like sound: kick drum, bass, steady chords and hi-hats, no pauses. */
function music(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR, beat = t % 0.5, hat = t % 0.25;
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beat * 40)) * beat) * Math.exp(-beat * 9);
    const bass = 0.35 * Math.sin(2 * Math.PI * 55 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t));
    const chord = 0.18 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 554 * t) + Math.sin(2 * Math.PI * 659 * t));
    const hats = 0.5 * rnd() * Math.exp(-hat * 60);
    out[i] = 0.45 * (kick + bass + chord) + hats;
  }
  return out;
}

const frames = (x: Float32Array): Frame[] => { const f: Frame[] = []; new FrameExtractor((q) => f.push(q)).push(x); return f; };

describe('speech or music', () => {
  it('scores speech high and music low', () => {
    const sp = frames(speech(8)), mu = frames(music(8));
    expect(speechScore(evidence(sp.slice(0, 40)))).toBeGreaterThanOrEqual(3);
    expect(speechScore(evidence(mu.slice(0, 40)))).toBeLessThanOrEqual(1);
  });
  it('switches to speech after a few seconds of talking and back to music, in both directions', () => {
    const log: string[] = [];
    const det = new SpeechDetector((k) => log.push(k));
    const seq = [...frames(music(10)), ...frames(speech(15)), ...frames(music(12))];
    seq.forEach((f) => det.push(f));
    expect(log).toEqual(['music', 'speech', 'music']);
  });
  it('is not fooled by a short spoken shout inside a song', () => {
    const log: string[] = [];
    const det = new SpeechDetector((k) => log.push(k));
    [...frames(music(10)), ...frames(speech(1)), ...frames(music(10))].forEach((f) => det.push(f));
    expect(log).toEqual(['music']);
  });
  it('calls silence silence', () => {
    const det = new SpeechDetector();
    frames(new Float32Array(SR * 6)).forEach((f) => det.push(f));
    expect(det.kind).toBe('silence');
  });
  it('a cautious threshold needs more evidence than a sensitive one', () => {
    const e = evidence(frames(speech(8)).slice(0, 40));
    expect(speechScore(e)).toBeGreaterThanOrEqual(4);
    const log: string[] = [];
    const careful = new SpeechDetector((k) => log.push(k), { threshold: 7 });
    frames(speech(15)).forEach((f) => careful.push(f));
    expect(log).not.toContain('speech');
  });
});

describe('AdGuard', () => {
  const feed = (cb: (s: Float32Array) => void, x: Float32Array) => { for (let i = 0; i < x.length; i += 1600) cb(x.subarray(i, i + 1600)); };
  it('listens while enabled, reports speech, and stops when disabled', async () => {
    let cb: (s: Float32Array) => void = () => {};
    const stop = vi.fn(), changes = vi.fn();
    const g = new AdGuard({ start: async (c) => { cb = c; }, stop }, changes);
    expect(g.state().on).toBe(false);
    await g.enable();
    expect(g.state().on).toBe(true);
    feed(cb, music(8)); expect(g.state().kind).toBe('music');
    feed(cb, speech(12)); expect(g.state().kind).toBe('speech');
    expect(g.state().level).toBeGreaterThan(0);
    await g.disable();
    expect(stop).toHaveBeenCalled();
    expect(g.state()).toMatchObject({ on: false, kind: 'silence' });
  });
  it('keeps a short history of what it took for speech, with what was on air', async () => {
    let cb: (s: Float32Array) => void = () => {};
    const g = new AdGuard({ start: async (c) => { cb = c; }, stop: vi.fn(), label: () => 'Gianna' });
    await g.enable();
    feed(cb, music(8)); feed(cb, speech(12));
    const ev = g.state().events;
    expect(ev.map((e) => e.kind)).toEqual(['music', 'speech']);
    expect(ev[1]).toMatchObject({ label: 'Gianna' });
    expect(ev[1].score).toBeGreaterThanOrEqual(4);
  });
  it('reports a capture error and stays off', async () => {
    const g = new AdGuard({ start: async () => { throw new Error('permesso negato'); }, stop: vi.fn() });
    await g.enable();
    expect(g.state()).toMatchObject({ on: false, error: 'permesso negato' });
  });
  it('measures how long it has heard nothing', async () => {
    let t = 0, cb: (s: Float32Array) => void = () => {};
    const g = new AdGuard({ start: async (c) => { cb = c; }, stop: vi.fn() }, () => {}, 4, () => t);
    await g.enable();
    t = 20_000; feed(cb, new Float32Array(SR));
    expect(g.state().silentFor).toBeGreaterThanOrEqual(19);
    feed(cb, music(1));
    expect(g.state().silentFor).toBe(0);
  });
});

describe('spots by length', () => {
  it('counts a clip under 75 seconds as a spot, a song or an unknown length as not', () => {
    expect(isSpotLength(28)).toBe(true);
    expect(isSpotLength(74.9)).toBe(true);
    expect(isSpotLength(75)).toBe(false);
    expect(isSpotLength(210)).toBe(false);
    expect(isSpotLength(0)).toBe(false);
    expect(isSpotLength(NaN)).toBe(false);
  });
});
