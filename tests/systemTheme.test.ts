import { hexToHsl, palette, rgbToHex, followSystemTheme } from '../src/ui/systemTheme';

describe('colours from the computer', () => {
  it('reads accent colours', () => {
    expect(Math.round(hexToHsl('#007AFF')!.h)).toBe(211);
    expect(hexToHsl('#8C8C8C')!.s).toBe(0);
    expect(hexToHsl('nope')).toBeUndefined();
    expect(rgbToHex('rgb(0, 122, 255)')).toBe('#007AFF');
  });
  it('builds a dark and a light Material palette with the accent hue (no more pink)', () => {
    const d = palette('#007AFF', true), l = palette('#007AFF', false);
    expect(d['--md-primary']).toMatch(/^hsl\(211 /);
    expect(l['--md-primary']).toMatch(/^hsl\(211 /);
    expect(d['--md-surface']).toMatch(/ 7\.5%\)$/);
    expect(l['--md-surface']).toMatch(/ 98\.5%\)$/);
    expect(d['color-scheme']).toBe('dark');
    expect(palette('#62BA46', true)['--md-primary']).toMatch(/^hsl\(106 /); // green Mac accent
  });
  it('graphite gives a neutral (grey) theme', () => {
    expect(palette('#8C8C8C', true)['--md-primary']).toMatch(/^hsl\(0 0% /);
  });
  it('applies the system accent from the app and follows light/dark', async () => {
    const body = document.createElement('div');
    const read = followSystemTheme(async (cmd) => (cmd === 'system_accent' ? '#F7821B' : undefined), body);
    expect(await read()).toBe('#F7821B');
    expect(body.style.getPropertyValue('--md-primary')).toMatch(/^hsl\(28 /);
    expect(body.dataset.accent).toBe('#F7821B');
  });
});
