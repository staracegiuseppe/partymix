import { AudioKind, Evidence, features, FEATURE_NAMES, SpeechDetector } from './adDetector';
import { FrameExtractor } from './audioAnalysis';

export type GuardDeps = {
  start(onSamples: (s: Float32Array) => void): Promise<void>;
  stop(): Promise<void> | void;
  /** What is on air right now (shown next to each detection). */
  label?(): string;
};

export type GuardEvent = { at: number; kind: AudioKind; score: number; label: string; detail: string };

export type GuardState = {
  on: boolean;
  kind: AudioKind;
  /** Recent loudness, 0..1. */
  level: number;
  error?: string;
  /** The last changes (newest last): when the sound was taken for speech or went back to music. */
  events: GuardEvent[];
  /** Seconds since the last sound was heard (0 while there is sound). */
  silentFor: number;
};

const describe = (e?: Evidence) => (e ? `pause ${e.pauses.toFixed(2)} · bassa ${e.low.toFixed(2)} · tonale ${e.flatness.toFixed(3)} · ${Math.round(e.centroid)} Hz` : '');

/**
 * Listens to the sound that is playing, tells music from speech (an ad), and says so through `onChange`.
 * Nothing is kept: only the verdict.
 */
export class AdGuard {
  private det: SpeechDetector;
  private ext: FrameExtractor;
  private on = false;
  private level = 0;
  private error?: string;
  private silentSince?: number;
  private events: GuardEvent[] = [];

  constructor(private deps: GuardDeps, private onChange: () => void = () => {}, threshold = 4, private now: () => number = () => Date.now()) {
    this.det = new SpeechDetector((kind) => {
      if (kind !== 'silence') this.events = [...this.events, { at: this.now(), kind, score: this.det.lastScore, label: this.deps.label?.() ?? '', detail: describe(this.det.last) }].slice(-12);
      this.onChange();
    }, { threshold });
    this.ext = new FrameExtractor((f) => {
      this.level = this.level * 0.7 + Math.min(1, f.rms * 4) * 0.3;
      if (f.rms >= 0.004) this.silentSince = undefined; else this.silentSince ??= this.now();
      this.det.push(f);
    });
  }

  setThreshold(t: number): void { this.det.setThreshold(t); }

  /** Hands every evaluated window (one a second) to `fn` as a row of named numbers; null stops it. Never audio. */
  setRecorder(fn: ((row: Record<string, number | string>) => void) | null): void {
    this.det.onWindow = fn ? (frames, _ev, score, kind) => {
      const f = features(frames), row: Record<string, number | string> = { t: this.now(), label: this.deps.label?.() ?? '', score, kind };
      FEATURE_NAMES.forEach((n, i) => { row[n] = Math.round(f[i] * 10000) / 10000; });
      fn(row);
    } : undefined;
  }

  async enable(): Promise<void> {
    if (this.on) return;
    this.error = undefined;
    this.on = true;
    this.silentSince = this.now();
    try {
      await this.deps.start((s) => this.ext.push(s));
    } catch (e) {
      this.on = false;
      this.error = String((e as Error)?.message ?? e);
    }
    this.onChange();
  }

  async disable(): Promise<void> {
    if (!this.on) return;
    this.on = false;
    this.level = 0;
    try { await this.deps.stop(); } catch { /* already stopped */ }
    this.onChange();
  }

  state(): GuardState {
    return {
      on: this.on,
      kind: this.on ? this.det.kind : 'silence',
      level: this.level,
      error: this.error,
      events: this.events,
      silentFor: this.on && this.silentSince !== undefined ? (this.now() - this.silentSince) / 1000 : 0,
    };
  }
}
