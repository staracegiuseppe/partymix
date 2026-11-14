import { isAndroidApp } from '../androidBridge';
import { h } from './dom';

/**
 * The phone layout (Material Design 3): a top app bar, four destinations in a bottom navigation bar,
 * messages in a snackbar and per-song actions in a bottom sheet. Used by the Android app; on a computer
 * it can be tried with `?android` in the address.
 */
export const materialUI = (): boolean => {
  if (isAndroidApp()) return true;
  try { return new URLSearchParams(location.search).has('android'); } catch { return false; }
};

/** Material Symbols paths (Apache License 2.0), 24×24. */
const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  stop: 'M6 6h12v12H6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  mix: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
  nowPlaying: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  queue: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
  cast: 'M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  del: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  playNext: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volumeDown: 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
  shuffle: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  apps: 'M17 1.01 7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z',
  help: 'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
  school: 'M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3 1 9l11 6 9-4.91V17h2V9L12 3z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  feedback: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  lyrics: 'M2.5 4v3h5v12h3V7h5V4h-13zm19 5h-9v3h3v7h3v-7h3V9z',
} as const;
export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('m-icon');
  svg.setAttribute('data-icon', name);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name]);
  svg.append(p);
  return svg;
}

/** Puts an icon in front of a button's label (or makes it an icon-only button with its label for screen readers). */
export function withIcon<T extends HTMLElement>(el: T, name: IconName, iconOnly = false): T {
  const old = el.querySelector(':scope > .m-icon');
  if (old?.getAttribute('data-icon') === name) return el;
  old?.remove();
  if (iconOnly && !el.getAttribute('aria-label')) el.setAttribute('aria-label', el.textContent ?? '');
  if (iconOnly) { el.replaceChildren(icon(name)); return el; }
  const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  el.prepend(icon(name));
  if (text) setLabel(el, text);
  return el;
}

/** Sets a button's text without losing its icon. */
export function setLabel(el: HTMLElement, text: string): void {
  const ic = el.querySelector(':scope > .m-icon');
  if (!ic) { if (el.textContent !== text) el.textContent = text; return; }
  const span = el.querySelector(':scope > .m-label') ?? el.appendChild(h('span', { class: 'm-label' }));
  if (span.textContent !== text) span.textContent = text;
  [...el.childNodes].forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
}

export type Screen = { id: string; label: string; icon: IconName; body: (Node | null)[] };
export type SheetItem = { label: string; icon: IconName; danger?: boolean; disabled?: boolean; run: () => void };

/**
 * Builds the app frame and returns its controls. Back (Android's back gesture) closes an open sheet, then returns
 * to the first destination, then leaves the app: every step is a history entry, so the WebView's back does the work.
 */
export function buildShell(root: HTMLElement, o: { title: Node; actions: Node[]; screens: Screen[] }) {
  document.body.classList.add('md');
  const home = o.screens[0].id;
  let current = home;
  const scroll = new Map<string, number>();
  const sections = new Map<string, HTMLElement>();
  const navBtns = new Map<string, HTMLButtonElement>();

  const appbar = h('header', { class: 'm-appbar' }, o.title, h('span', { class: 'm-spacer' }), ...o.actions);
  const main = h('main', { class: 'm-main' });
  for (const s of o.screens) {
    const sec = h('section', { class: 'm-screen', 'data-screen': s.id, 'aria-label': s.label }, ...s.body);
    sections.set(s.id, sec);
    main.append(sec);
  }
  const nav = h('nav', { class: 'm-nav', 'aria-label': 'Sezioni' }, ...o.screens.map((s) => {
    const b = h('button', { class: 'm-nav-item', type: 'button', onClick: () => go(s.id) },
      h('span', { class: 'm-ind' }, icon(s.icon)), h('span', { class: 'm-nav-label' }, s.label));
    navBtns.set(s.id, b);
    return b;
  }));
  const snack = h('div', { class: 'm-snack', role: 'status', 'aria-live': 'polite' });
  root.append(appbar, main, nav, snack);

  /** Hidden destinations stay laid out off screen (not display:none), so the YouTube players inside keep playing. */
  function show(id: string) {
    if (!sections.has(id)) id = home;
    scroll.set(current, scrollY);
    current = id;
    for (const [k, sec] of sections) {
      const on = k === id;
      sec.classList.toggle('on', on);
      sec.toggleAttribute('inert', !on);
      navBtns.get(k)?.classList.toggle('on', on);
      if (on) navBtns.get(k)?.setAttribute('aria-current', 'page'); else navBtns.get(k)?.removeAttribute('aria-current');
    }
    scrollTo(0, scroll.get(id) ?? 0);
  }
  function go(id: string) {
    if (id === current) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (id === home) { if (history.state?.screen && history.state.screen !== home) history.back(); else show(home); return; }
    const st = { screen: id };
    if (current === home) history.pushState(st, ''); else history.replaceState(st, '');
    show(id);
  }
  history.replaceState({ screen: home }, '');
  addEventListener('popstate', (e) => {
    if (sheetOpen) { closeSheet(false); return; }
    show((e.state as { screen?: string } | null)?.screen ?? home);
  });
  show(home);

  let snackTimer = 0;
  function toast(text: string, error = false) {
    if (!text) return;
    snack.replaceChildren(h('span', {}, text));
    snack.classList.toggle('error', error);
    snack.classList.add('on');
    clearTimeout(snackTimer);
    snackTimer = window.setTimeout(() => snack.classList.remove('on'), error ? 7000 : Math.min(8000, 2500 + text.length * 40));
  }
  snack.addEventListener('click', () => snack.classList.remove('on'));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

  let sheetOpen: HTMLElement | undefined;
  function closeSheet(viaHistory = true) {
    const s = sheetOpen;
    if (!s) return;
    sheetOpen = undefined;
    s.classList.remove('on');
    setTimeout(() => s.remove(), 220);
    if (viaHistory && history.state?.sheet) history.back();
  }
  /** A modal bottom sheet listing the actions for one item. */
  function sheet(title: string, subtitle: string, items: SheetItem[]) {
    closeSheet();
    const panel = h('div', { class: 'm-sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'm-handle' }),
      h('div', { class: 'm-sheet-head' }, h('div', { class: 'm-sheet-title' }, title), subtitle ? h('div', { class: 'm-sheet-sub' }, subtitle) : null),
      ...items.map((it) => h('button', { class: 'm-sheet-item' + (it.danger ? ' danger' : ''), type: 'button', disabled: it.disabled,
        onClick: () => { closeSheet(); it.run(); } }, icon(it.icon), h('span', {}, it.label))));
    const s = h('div', { class: 'm-sheet', onClick: (e: Event) => { if (e.target === s) closeSheet(); } }, panel);
    document.body.append(s);
    sheetOpen = s;
    history.pushState({ ...history.state, sheet: true }, '');
    requestAnimationFrame(() => s.classList.add('on'));
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true }); // focus moves into the sheet without ringing the first action
  }

  /** Brings the destination that contains `el` to the front (used by the tutorial). */
  function reveal(el: Element | null): void {
    const sec = el?.closest('.m-screen') as HTMLElement | null;
    const id = sec?.dataset.screen;
    if (id && id !== current) go(id);
  }

  return { go, toast, sheet, reveal, current: () => current };
}

/** Android draws the app under the status and navigation bars: the app asks how tall they are and leaves room. */
export function applySystemInsets(): void {
  const b = (window as unknown as { PartyMixAndroid?: { insets?(): string } }).PartyMixAndroid;
  const apply = () => {
    try {
      const j = JSON.parse(b?.insets?.() ?? '{}');
      const st = document.documentElement.style;
      if (typeof j.top === 'number') st.setProperty('--sys-top', `${j.top}px`);
      if (typeof j.bottom === 'number') st.setProperty('--sys-bottom', `${j.bottom}px`);
      // keyboard open: the bottom bar steps aside and the field being typed in scrolls into view above the keys
      const kb = typeof j.ime === 'number' && j.ime > 0;
      st.setProperty('--ime', `${kb ? j.ime : 0}px`);
      document.body.classList.toggle('kb', kb);
      if (kb) requestAnimationFrame(() => document.activeElement?.scrollIntoView({ block: 'center' }));
    } catch { /* keep the CSS defaults */ }
  };
  apply();
  addEventListener('partymix-insets', apply);
}

const THEME_TOKENS = ['primary', 'on-primary', 'primary-container', 'on-primary-container', 'secondary-container', 'on-secondary-container',
  'tertiary', 'tertiary-container', 'on-tertiary-container', 'error', 'on-error', 'error-container', 'on-error-container',
  'surface', 'surface-low', 'surface-c', 'surface-high', 'surface-highest', 'on-surface', 'on-surface-variant',
  'outline', 'outline-variant', 'inverse-surface', 'inverse-on-surface'];

/**
 * Colours like the phone: light or dark as the phone is set and, with Material You (Android 12+), the palette of the
 * wallpaper. Without the app (browser) it follows the system light/dark setting with the PartyMix pink.
 */
export function applyPhoneTheme(): void {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  const apply = () => {
    let dark = mq ? mq.matches : true;
    let colors: Record<string, unknown> = {};
    const b = (window as unknown as { PartyMixAndroid?: { theme?(): string } }).PartyMixAndroid;
    try {
      const j = JSON.parse(b?.theme?.() ?? 'null');
      if (j && typeof j === 'object') { dark = j.dark !== false; colors = j.colors && typeof j.colors === 'object' ? j.colors : {}; }
    } catch { /* keep the system setting */ }
    const body = document.body;
    body.classList.toggle('dark', dark);
    body.classList.toggle('light', !dark);
    for (const t of THEME_TOKENS) {
      const c = colors[t];
      if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) body.style.setProperty(`--md-${t}`, c);
      else body.style.removeProperty(`--md-${t}`);
    }
  };
  apply();
  addEventListener('partymix-theme', apply);
  mq?.addEventListener?.('change', apply);
}
