import { bindShortcuts } from '../src/ui/shortcuts';

const handlers = () => ({ next: vi.fn(), pause: vi.fn(), stop: vi.fn(), mixNow: vi.fn(), volumeUp: vi.fn(), volumeDown: vi.fn() });
const press = (key: string, target: EventTarget = window) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('bindShortcuts', () => {
  it('maps each key to its handler once', () => {
    const h = handlers();
    const off = bindShortcuts(window, h);
    press('ArrowRight'); press(' '); press('s'); press('m'); press('ArrowUp'); press('ArrowDown');
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.pause).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.mixNow).toHaveBeenCalledTimes(1);
    expect(h.volumeUp).toHaveBeenCalledTimes(1);
    expect(h.volumeDown).toHaveBeenCalledTimes(1);
    off();
  });
  it('ignores keys typed into text fields', () => {
    const h = handlers();
    const off = bindShortcuts(window, h);
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('s', input); press(' ', input);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.pause).not.toHaveBeenCalled();
    off(); input.remove();
  });
  it('stops listening after the returned function is called', () => {
    const h = handlers();
    bindShortcuts(window, h)();
    press('s');
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('ignores combos with ctrl/meta/alt so browser shortcuts still work', () => {
    const h = handlers();
    const off = bindShortcuts(window, h);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
    expect(h.stop).not.toHaveBeenCalled();
    off();
  });
});
