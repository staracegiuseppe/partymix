export type ShortcutHandlers = {
  next(): void;
  pause(): void;
  stop(): void;
  mixNow(): void;
  /** S: the song starts here (current position of the player). */
  setStart?(): void;
  /** E: the song ends here. */
  setEnd?(): void;
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
    // S = SET START and E = SET END (DJ cue points); Stop moved to Shift+S so S never stops the party by mistake
    const sKey = k.key === 's' || k.key === 'S';
    const fn = sKey ? (k.shiftKey ? h.stop : h.setStart ?? h.stop)
      : k.key === 'e' || k.key === 'E' ? h.setEnd
      : ({ ArrowRight: h.next, ' ': h.pause, m: h.mixNow, M: h.mixNow, ArrowUp: h.volumeUp, ArrowDown: h.volumeDown } as Record<string, (() => void) | undefined>)[k.key];
    if (!fn) return;
    k.preventDefault();
    fn();
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}
