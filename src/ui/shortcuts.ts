export type ShortcutHandlers = {
  next(): void;
  pause(): void;
  stop(): void;
  mixNow(): void;
  volumeUp(): void;
  volumeDown(): void;
};

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
};

export function bindShortcuts(root: Window, h: ShortcutHandlers): () => void {
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.metaKey || k.altKey || isTyping(k.target)) return;
    const map: Record<string, () => void> = {
      ArrowRight: h.next, ' ': h.pause, s: h.stop, S: h.stop, m: h.mixNow, M: h.mixNow,
      ArrowUp: h.volumeUp, ArrowDown: h.volumeDown,
    };
    const fn = map[k.key];
    if (!fn) return;
    k.preventDefault();
    fn();
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}
