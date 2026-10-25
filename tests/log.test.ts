import { log, setSinks } from '../src/log';

describe('log', () => {
  it('emits one JSON line with time, level, event and data', () => {
    const lines: string[] = [];
    setSinks([(l) => lines.push(l)]);
    log('info', 'deck.load', { videoId: 'abc' });
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: 'info', event: 'deck.load', videoId: 'abc' });
    expect(typeof o.t).toBe('string');
  });
  it('does not throw when a sink throws', () => {
    setSinks([() => { throw new Error('boom'); }]);
    expect(() => log('error', 'x')).not.toThrow();
  });
});
