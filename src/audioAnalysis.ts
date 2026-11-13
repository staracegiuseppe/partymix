/** Audio is analysed at 16 kHz mono, in blocks of 100 ms. */
export const SAMPLE_RATE = 16000;
export const BLOCK = 1600;
const N = 512;
const HZ = SAMPLE_RATE / N; // 31.25 Hz per bin

export type Frame = {
  /** Loudness of the block (0..1). */
  rms: number;
  /** Zero crossings per sample. */
  zcr: number;
  /** Share of the energy below 100 Hz (kick drums and bass: what music has and a voice does not). */
  sub: number;
  /** 100-500 Hz, where the voice's fundamental lives. */
  low: number;
  /** 500-3000 Hz, vowels and consonants. */
  mid: number;
  /** 3000-8000 Hz. */
  high: number;
  /** Centre of mass of the spectrum, in Hz. */
  centroid: number;
  /** 0 = tonal (notes), 1 = noise-like. */
  flatness: number;
  /** How much the spectrum changed since the last block. */
  flux: number;
  /** Loudness of each 20 ms slice of the block: the speech rhythm (syllables, pauses) shows up here. */
  env: number[];
};

const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Describes one 100 ms block of mono audio (1600 samples at 16 kHz). */
export function analyseBlock(block: ArrayLike<number>, prev?: Float64Array): { frame: Frame; spectrum: Float64Array } {
  let sum = 0, cross = 0;
  for (let i = 0; i < block.length; i++) {
    sum += block[i] * block[i];
    if (i > 0 && (block[i] >= 0) !== (block[i - 1] >= 0)) cross++;
  }
  const rms = Math.sqrt(sum / block.length);
  const slice = Math.floor(block.length / 5), env: number[] = [];
  for (let q = 0; q < 5; q++) { let e = 0; for (let i = q * slice; i < (q + 1) * slice; i++) e += block[i] * block[i]; env.push(Math.sqrt(e / slice)); }
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  const starts = [0, 544, 1088];
  for (const s of starts) {
    for (let i = 0; i < N; i++) { re[i] = (block[s + i] ?? 0) * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) / starts.length;
  }
  const band = (lo: number, hi: number) => { let e = 0; for (let k = Math.round(lo / HZ); k < Math.min(N / 2, Math.round(hi / HZ)); k++) e += power[k]; return e; };
  const total = band(20, 8000) + 1e-12;
  let wsum = 0, psum = 0, logsum = 0, cnt = 0, flux = 0, mag = 0;
  for (let k = 3; k < N / 2; k++) {
    wsum += k * HZ * power[k]; psum += power[k]; logsum += Math.log(power[k] + 1e-12); cnt++;
    const m = Math.sqrt(power[k]);
    mag += m;
    if (prev) flux += Math.abs(m - prev[k]);
  }
  const spectrum = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) spectrum[k] = Math.sqrt(power[k]);
  return {
    spectrum,
    frame: {
      rms, zcr: cross / block.length,
      sub: band(20, 100) / total, low: band(100, 500) / total, mid: band(500, 3000) / total, high: band(3000, 8000) / total,
      centroid: psum > 0 ? wsum / psum : 0,
      flatness: Math.exp(logsum / cnt) / (psum / cnt + 1e-12),
      flux: mag > 0 ? flux / mag : 0,
      env,
    },
  };
}

/** Cuts a stream of samples into 100 ms blocks and describes each one. */
export class FrameExtractor {
  private buf = new Float32Array(BLOCK);
  private n = 0;
  private prev?: Float64Array;
  constructor(private onFrame: (f: Frame) => void) {}

  /** Samples in -1..1, 16 kHz mono. */
  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.n++] = samples[i];
      if (this.n === BLOCK) {
        const { frame, spectrum } = analyseBlock(this.buf, this.prev);
        this.prev = spectrum;
        this.n = 0;
        this.onFrame(frame);
      }
    }
  }
}
