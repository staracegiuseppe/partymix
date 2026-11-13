import { syllables } from '../lyrics';

type Child = Node | string | null | undefined | false;

/** Tiny DOM helper. Text always goes through textContent, so titles from the network can never inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Writes `text` as one span per word; words already sung (fraction `p` of the syllables) get `sungColor`, the one being sung is wiped across. */
export function paintWords(el: HTMLElement, text: string, p: number, sungColor: string, restColor: string): void {
  const words = text.split(/\s+/).filter(Boolean);
  const weight = words.map(syllables), total = weight.reduce((n, x) => n + x, 0) || 1;
  let before = 0;
  el.replaceChildren(...words.map((w, i) => {
    const from = before / total, to = (before + weight[i]) / total;
    before += weight[i];
    const f = Math.min(1, Math.max(0, (p - from) / (to - from)));
    const span = document.createElement('span');
    span.textContent = w;
    if (f >= 1) span.style.color = sungColor;
    else if (f <= 0) span.style.color = restColor;
    else {
      // the sung part is a clipped copy laid over the unsung word, so no transparent text (which would show only its shadow)
      span.style.cssText = `position:relative;display:inline-block;color:${restColor}`;
      const over = document.createElement('span');
      over.textContent = w;
      over.style.cssText = `position:absolute;left:0;top:0;overflow:hidden;white-space:nowrap;width:${(f * 100).toFixed(0)}%;color:${sungColor}`;
      span.append(over);
    }
    return i ? [document.createTextNode(' '), span] : [span];
  }).flat());
}
