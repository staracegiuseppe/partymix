import { crossfadeGains, profileSeconds } from '../src/crossfade';

describe('crossfadeGains', () => {
  it('goes from all-out to all-in', () => {
    expect(crossfadeGains(0)).toEqual({ out: 1, in: 0 });
    const end = crossfadeGains(1);
    expect(end.out).toBeCloseTo(0, 10);
    expect(end.in).toBeCloseTo(1, 10);
  });
  it('is equal-power at the middle', () => {
    const m = crossfadeGains(0.5);
    expect(m.out).toBeCloseTo(0.7071, 3);
    expect(m.in).toBeCloseTo(0.7071, 3);
  });
  it('clamps progress outside 0..1', () => {
    expect(crossfadeGains(-3)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(7)).toEqual(crossfadeGains(1));
  });
  it('keeps constant power across the fade', () => {
    for (let i = 0; i <= 10; i++) {
      const g = crossfadeGains(i / 10);
      expect(g.out ** 2 + g.in ** 2).toBeCloseTo(1, 6);
    }
  });
});

describe('profileSeconds', () => {
  it('maps profiles to the specified durations', () => {
    expect(profileSeconds('morbida')).toBe(12);
    expect(profileSeconds('standard')).toBe(8);
    expect(profileSeconds('energica')).toBe(4);
    expect(profileSeconds('manuale')).toBeNull();
  });
});
