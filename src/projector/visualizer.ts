export type Bands = { bass: number; mid: number; high: number; level: number };

const BANDS: [keyof Omit<Bands, 'level'>, number, number][] = [['bass', 20, 150], ['mid', 150, 2000], ['high', 2000, 8000]];

/** Average energy per band (0..1) from an AnalyserNode byte spectrum. */
export function bandEnergy(freq: Uint8Array, sampleRate: number): Bands {
  const n = freq.length;
  const out: Bands = { bass: 0, mid: 0, high: 0, level: 0 };
  if (n === 0) return out;
  const hzPerBin = sampleRate / 2 / n;
  let all = 0, allN = 0;
  for (const [name, lo, hi] of BANDS) {
    const a = Math.max(0, Math.ceil(lo / hzPerBin)), b = Math.min(n - 1, Math.floor(hi / hzPerBin));
    let sum = 0, c = 0;
    for (let i = a; i <= b; i++) { sum += freq[i]; c++; }
    out[name] = c ? sum / c / 255 : 0;
    all += sum; allN += c;
  }
  out.level = allN ? all / allN / 255 : 0;
  return out;
}

export type VisualizerSource = { spectrum(): { data: Uint8Array; sampleRate: number } | undefined };

/** Fullscreen canvas animation. If there is no audio source it says so; it never fakes a beat. */
export function startVisualizer(canvas: HTMLCanvasElement, source: () => VisualizerSource | undefined, message: () => string, sensitivity: () => number): () => void {
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  const smooth = { bass: 0, mid: 0, high: 0 };
  const resize = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; };
  resize();
  addEventListener('resize', resize);
  const frame = (t: number) => {
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, W, H);
    const s = source()?.spectrum();
    if (!s) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(R / 14)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(message(), cx, cy);
      raf = requestAnimationFrame(frame);
      return;
    }
    const k = sensitivity();
    const e = bandEnergy(s.data, s.sampleRate);
    for (const b of ['bass', 'mid', 'high'] as const) {
      const v = Math.min(1, e[b] * k * 1.6);
      smooth[b] = v > smooth[b] ? v : smooth[b] * 0.9 + v * 0.1;
    }
    const hue = (t / 40) % 360;
    // bass: pulsing core
    ctx.beginPath();
    ctx.arc(cx, cy, R * (0.12 + smooth.bass * 0.38), 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},90%,60%,0.85)`;
    ctx.fill();
    // mid: ring of bars from the spectrum
    const bars = 72, step = Math.floor(s.data.length / 2 / bars) || 1;
    ctx.lineWidth = Math.max(2, R / 90);
    for (let i = 0; i < bars; i++) {
      const v = Math.min(1, (s.data[i * step] / 255) * k);
      const a = (i / bars) * Math.PI * 2 + t / 4000;
      const r0 = R * 0.62, r1 = r0 + R * (0.04 + v * 0.3 * (0.4 + smooth.mid));
      ctx.strokeStyle = `hsla(${(hue + i * 3) % 360},90%,60%,0.9)`;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    // highs: orbiting sparks
    const sparks = Math.round(smooth.high * 40);
    for (let i = 0; i < sparks; i++) {
      const a = (i / Math.max(1, sparks)) * Math.PI * 2 - t / 700;
      const r = R * (0.5 + 0.45 * Math.abs(Math.sin(t / 900 + i)));
      ctx.fillStyle = `hsla(${(hue + 180) % 360},100%,75%,0.9)`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.max(2, R / 140), 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
}
