import type { Frame } from './audioAnalysis';

export type AudioKind = 'music' | 'speech' | 'silence';

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

export type Evidence = {
  /** Share of 20 ms slices that are pauses (well below the usual loudness): people breathe and stop, records rarely do. */
  pauses: number;
  /** Energy between 100 and 500 Hz: a voice sits there, a full mix does not. */
  low: number;
  /** 0 = tonal. A clean voice is very tonal. */
  flatness: number;
  /** Centre of the spectrum in Hz. */
  centroid: number;
  loudness: number;
};

export function evidence(frames: Frame[]): Evidence {
  const env = frames.flatMap((f) => f.env), m = median(env);
  return {
    pauses: env.length ? env.filter((v) => v < 0.25 * m).length / env.length : 0,
    low: median(frames.map((f) => f.low)),
    flatness: median(frames.map((f) => f.flatness)),
    centroid: median(frames.map((f) => f.centroid)),
    loudness: frames.reduce((s, f) => s + f.rms, 0) / (frames.length || 1),
  };
}

/** A richer description of a window of sound, used to train and check the detector offline (names in FEATURE_NAMES). */
export const FEATURE_NAMES = ['pauses', 'deepPauses', 'low', 'sub', 'mid', 'high', 'flatness', 'centroid', 'centroidSpread', 'flux', 'zcr', 'loudness', 'variation', 'dynamics', 'mod4'] as const;

export function features(frames: Frame[]): number[] {
  const env = frames.flatMap((f) => f.env), m = median(env) || 1e-9;
  const sorted = [...env].sort((a, b) => a - b), q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const meanE = env.reduce((s, v) => s + v, 0) / (env.length || 1);
  const sd = Math.sqrt(env.reduce((s, v) => s + (v - meanE) ** 2, 0) / (env.length || 1));
  const cents = frames.map((f) => f.centroid), cm = cents.reduce((s, v) => s + v, 0) / (cents.length || 1);
  // share of the loudness variation that moves at syllable speed (3-8 Hz of the 50 Hz envelope)
  let band = 0, total = 0;
  const n = Math.min(env.length, 200), w = env.slice(0, n), mw = w.reduce((s, v) => s + v, 0) / (n || 1);
  for (let k = 1; k < n / 2; k++) {
    const f = (k * 50) / n; let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const v = (w[i] - mw) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); re += v * Math.cos((2 * Math.PI * k * i) / n); im -= v * Math.sin((2 * Math.PI * k * i) / n); }
    const p = re * re + im * im;
    if (f >= 0.5 && f <= 25) total += p;
    if (f >= 3 && f <= 8) band += p;
  }
  return [
    env.filter((v) => v < 0.25 * m).length / (env.length || 1),
    env.filter((v) => v < 0.08 * m).length / (env.length || 1),
    median(frames.map((f) => f.low)), median(frames.map((f) => f.sub)), median(frames.map((f) => f.mid)), median(frames.map((f) => f.high)),
    median(frames.map((f) => f.flatness)), median(cents),
    Math.sqrt(cents.reduce((s, v) => s + (v - cm) ** 2, 0) / (cents.length || 1)),
    median(frames.map((f) => f.flux)), median(frames.map((f) => f.zcr)),
    frames.reduce((s, f) => s + f.rms, 0) / (frames.length || 1),
    sd / (meanE || 1e-9),
    Math.log10((q(0.9) + 1e-6) / (q(0.1) + 1e-6)),
    total > 0 ? band / total : 0,
  ];
}

/**
 * 0..6: how much the sound looks like someone talking (an ad, the news) rather than a song.
 * Two things have to be true before anything counts: a voice dominates the sound (most of the energy under 500 Hz: a few
 * words over a loud song do not count) and it pauses like someone talking (a singer holding a sparse intro rarely does).
 */
export function speechScore(e: Evidence, minLow = 0.5, minPauses = 0.1): number {
  if (e.low < minLow || e.pauses < minPauses) return 0;
  let s = 0;
  if (e.pauses >= 0.12) s += 2; else if (e.pauses >= 0.07) s += 1;
  if (e.low >= 0.75) s += 2; else if (e.low >= 0.65) s += 1;
  if (e.flatness <= 0.01) s += 1;
  if (e.centroid <= 450) s += 1;
  return s;
}

export type DetectorOpts = {
  /** Frames (100 ms each) looked at. */
  windowFrames?: number;
  /** Evaluate every this many frames. */
  every?: number;
  /** Score needed to start counting as speech (3 = sensitive, 4 = normal, 5 = cautious). Once in speech, one point less keeps it there. */
  threshold?: number;
  /** Consecutive evaluations needed to switch to speech / back to music. */
  toSpeech?: number;
  toMusic?: number;
  silenceLevel?: number;
};

/**
 * Listens to the frames of the sound that is playing and says whether it is music or speech.
 * It decides on a few seconds of sound and needs the same answer twice in a row, so a spoken verse of a rap or a
 * short break in a song does not count as an ad.
 */
export class SpeechDetector {
  private frames: Frame[] = [];
  private since = 0;
  private speechRun = 0;
  private musicRun = 0;
  kind: AudioKind = 'silence';
  last: Evidence | undefined;
  /** Called with every window that is evaluated (a second apart): used to record numbers for offline training. */
  onWindow?: (frames: Frame[], evidence: Evidence, score: number, kind: AudioKind) => void;
  lastScore = 0;
  private o: Required<DetectorOpts>;

  constructor(private onChange: (k: AudioKind) => void = () => {}, opts: DetectorOpts = {}) {
    this.o = { windowFrames: 40, every: 10, threshold: 4, toSpeech: 4, toMusic: 2, silenceLevel: 0.004, ...opts };
  }

  setThreshold(t: number): void { this.o.threshold = t; }

  push(f: Frame): void {
    this.frames.push(f);
    if (this.frames.length > this.o.windowFrames) this.frames.shift();
    if (++this.since < this.o.every || this.frames.length < this.o.windowFrames / 2) return;
    this.since = 0;
    const ev = evidence(this.frames);
    this.last = ev;
    if (ev.loudness < this.o.silenceLevel) { this.lastScore = 0; this.speechRun = this.musicRun = 0; this.set('silence'); return; }
    // [how dominant the voice must be, how much it must pause]
    const sens = this.o.threshold <= 3 ? [0.5, 0.07] : this.o.threshold >= 5 ? [0.7, 0.14] : [0.65, 0.1];
    this.lastScore = speechScore(ev, sens[0], sens[1]);
    this.onWindow?.(this.frames, ev, this.lastScore, this.kind);
    // Schmitt trigger: it takes a clear voice to start, a little less to stay, so a short spoken passage in a song never starts it.
    const need = this.kind === 'speech' ? this.o.threshold - 1 : this.o.threshold;
    if (this.lastScore >= need) { this.speechRun++; this.musicRun = 0; } else { this.musicRun++; this.speechRun = 0; }
    if (this.kind !== 'speech' && this.speechRun >= this.o.toSpeech) this.set('speech');
    else if (this.kind !== 'music' && this.musicRun >= this.o.toMusic) this.set('music');
  }

  private set(k: AudioKind): void {
    if (this.kind === k) return;
    this.kind = k;
    this.onChange(k);
  }
}

/** Ads in a playlist are clips of a few seconds to a minute; songs last minutes. Below this many seconds a track counts as a spot. */
export const SPOT_MAX_SEC = 75;
export const isSpotLength = (sec: number): boolean => sec > 0 && sec < SPOT_MAX_SEC;
