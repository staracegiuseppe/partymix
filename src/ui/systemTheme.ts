/**
 * The computer app takes the colours of the computer it runs on: the system accent colour (Mac «Colore di
 * evidenziazione», Windows «Colore principale», GNOME accent) becomes the Material 3 palette, light or dark
 * like the system. Only on the computer (body.desk): the phone app keeps its own colours.
 */
type Hsl = { h: number; s: number; l: number };

export function hexToHsl(hex: string): Hsl | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** «rgb(0, 122, 255)» → «#007AFF». */
export function rgbToHex(rgb: string): string | undefined {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  return m ? '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined;
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(Math.max(0, Math.min(1, s)) * 100)}% ${Math.round(l * 10) / 10}%)`;

/** The Material 3 colour roles from one seed colour (tonal steps in HSL: same hue, chosen tones). */
export function palette(accent: string, dark: boolean): Record<string, string> {
  const c = hexToHsl(accent) ?? { h: 211, s: 1, l: 0.5 };
  const grey = c.s < 0.12; // graphite / slate: a neutral theme
  const h = c.h, s = grey ? 0 : Math.min(c.s, 0.9), t = h + 60, ns = grey ? 0 : 0.08; // tertiary hue, tint of the neutrals
  return dark ? {
    '--md-primary': hsl(h, s, grey ? 80 : 74), '--md-on-primary': hsl(h, s * 0.7, 16), '--md-primary-container': hsl(h, s * 0.55, 28), '--md-on-primary-container': hsl(h, s, 90),
    '--md-secondary-container': hsl(h, s * 0.22, 25), '--md-on-secondary-container': hsl(h, s * 0.45, 88),
    '--md-tertiary': hsl(t, grey ? 0 : 0.5, 74), '--md-tertiary-container': hsl(t, grey ? 0 : 0.4, 26), '--md-on-tertiary-container': hsl(t, grey ? 0 : 0.7, 88),
    '--md-error': '#ffb4ab', '--md-on-error': '#690005', '--md-error-container': '#93000a', '--md-on-error-container': '#ffdad6',
    '--md-surface': hsl(h, ns, 7.5), '--md-surface-low': hsl(h, ns, 10), '--md-surface-c': hsl(h, ns, 12), '--md-surface-high': hsl(h, ns, 15.5), '--md-surface-highest': hsl(h, ns, 19),
    '--md-on-surface': hsl(h, ns, 90), '--md-on-surface-variant': hsl(h, ns, 76), '--md-outline': hsl(h, ns * 0.8, 56), '--md-outline-variant': hsl(h, ns, 28),
    '--md-inverse-surface': hsl(h, ns, 90), '--md-inverse-on-surface': hsl(h, ns, 18), 'color-scheme': 'dark',
  } : {
    '--md-primary': hsl(h, s * 0.9, grey ? 30 : 40), '--md-on-primary': '#ffffff', '--md-primary-container': hsl(h, s * 0.85, 90), '--md-on-primary-container': hsl(h, s * 0.8, 14),
    '--md-secondary-container': hsl(h, s * 0.35, 90), '--md-on-secondary-container': hsl(h, s * 0.35, 15),
    '--md-tertiary': hsl(t, grey ? 0 : 0.5, 34), '--md-tertiary-container': hsl(t, grey ? 0 : 0.6, 90), '--md-on-tertiary-container': hsl(t, grey ? 0 : 0.6, 12),
    '--md-error': '#ba1a1a', '--md-on-error': '#ffffff', '--md-error-container': '#ffdad6', '--md-on-error-container': '#410002',
    '--md-surface': hsl(h, ns * 2, 98.5), '--md-surface-low': hsl(h, ns * 2, 96), '--md-surface-c': hsl(h, ns * 2, 94), '--md-surface-high': hsl(h, ns * 2, 92), '--md-surface-highest': hsl(h, ns * 2, 90),
    '--md-on-surface': hsl(h, ns, 11), '--md-on-surface-variant': hsl(h, ns, 30), '--md-outline': hsl(h, ns * 0.8, 50), '--md-outline-variant': hsl(h, ns, 80),
    '--md-inverse-surface': hsl(h, ns, 20), '--md-inverse-on-surface': hsl(h, ns, 95), 'color-scheme': 'light',
  };
}

/** The accent colour the browser exposes (CSS «AccentColor»), for the version that runs in a browser. */
function cssAccent(): string | undefined {
  try {
    const p = document.createElement('i');
    p.style.color = 'AccentColor';
    if (!p.style.color) return undefined;
    document.body.append(p);
    const c = rgbToHex(getComputedStyle(p).color);
    p.remove();
    return c;
  } catch { return undefined; }
}

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

/**
 * Applies the computer's theme now and keeps following it: light/dark at once, the accent when the window
 * comes back to the front (after the user changed it in the system settings).
 */
export function followSystemTheme(invoke?: Invoke, body: HTMLElement = document.body): () => Promise<string> {
  let accent = '#007AFF';
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  const paint = () => {
    const dark = mq ? mq.matches : true;
    body.classList.toggle('light', !dark);
    for (const [k, v] of Object.entries(palette(accent, dark))) body.style.setProperty(k, v);
    body.dataset.accent = accent;
  };
  const read = async () => {
    let a: string | undefined;
    try { a = (await invoke?.('system_accent')) as string | undefined; } catch { /* old app or browser */ }
    accent = (a && hexToHsl(a) ? a : cssAccent()) ?? accent;
    paint();
    return accent;
  };
  paint();
  mq?.addEventListener?.('change', paint);
  addEventListener('focus', () => void read());
  void read();
  return read;
}
