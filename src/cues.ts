/**
 * Where a song really starts and ends, from the loudness of its file (dB, one value every `step` s, ~0 = silence,
 * ~90 = full scale). The mix skips the silence at the head and a near-silent intro (at most 20 s: a soft intro that goes
 * on longer is the song), and fades out before the silence or the long fade at the tail.
 */
export type Cues = { start: number; end: number };

const MAX_QUIET_INTRO_S = 20;
const MAX_FADE_TAIL_S = 20;

export function cuePoints(levels: number[], step: number): Cues | undefined {
  const n = levels.length;
  if (n * step < 30) return undefined; // too short to judge
  const sorted = [...levels].sort((a, b) => a - b);
  const typical = sorted[Math.floor(n * 0.6)];
  const silent = Math.min(35, typical - 30); // nothing to hear
  const quiet = typical - 18; // so soft that in a party it sounds like nothing is playing
  let s = 0;
  while (s < n && levels[s] < silent) s++;
  if (s >= n) return undefined;
  let q = s;
  const qMax = Math.min(n, s + Math.ceil(MAX_QUIET_INTRO_S / step));
  while (q < qMax && levels[q] < quiet) q++;
  if (q < qMax) s = q;
  let e = n;
  while (e > s + 1 && levels[e - 1] < silent) e--;
  let f = e;
  const fMin = Math.max(s + 1, e - Math.ceil(MAX_FADE_TAIL_S / step));
  while (f > fMin && levels[f - 1] < quiet) f--;
  if (f > fMin) e = f;
  const start = Math.max(0, s * step - 0.5); // half a second before: never cut the first note
  const end = Math.min(n * step, e * step + 0.5);
  return end - start >= 20 ? { start: Math.round(start * 4) / 4, end: Math.round(end * 4) / 4 } : undefined;
}
