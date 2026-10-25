import { bandEnergy } from '../src/projector/visualizer';

const N = 1024; // fftSize 2048 at 48 kHz => 23.4 Hz per bin
const SR = 48000;

describe('bandEnergy', () => {
  it('is all zero for silence', () => {
    expect(bandEnergy(new Uint8Array(N), SR)).toEqual({ bass: 0, mid: 0, high: 0, level: 0 });
  });
  it('puts energy that sits only in the low bins into bass', () => {
    const f = new Uint8Array(N);
    for (let i = Math.ceil(20 / (SR / 2 / N)); i <= Math.floor(150 / (SR / 2 / N)); i++) f[i] = 255;
    const e = bandEnergy(f, SR);
    expect(e.bass).toBeGreaterThan(0.8);
    expect(e.mid).toBe(0);
    expect(e.high).toBe(0);
    expect(e.level).toBeGreaterThan(0);
  });
  it('puts energy that sits only in the highs into high', () => {
    const f = new Uint8Array(N);
    for (let i = Math.ceil(2000 / (SR / 2 / N)); i <= Math.floor(8000 / (SR / 2 / N)); i++) f[i] = 255;
    const e = bandEnergy(f, SR);
    expect(e.high).toBeGreaterThan(0.8);
    expect(e.bass).toBe(0);
  });
  it('keeps every value in 0..1 for any input', () => {
    const f = Uint8Array.from({ length: N }, (_, i) => (i * 37) % 256);
    for (const v of Object.values(bandEnergy(f, SR))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it('does not crash on an empty spectrum', () => {
    expect(bandEnergy(new Uint8Array(0), SR)).toEqual({ bass: 0, mid: 0, high: 0, level: 0 });
  });
});
