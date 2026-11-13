import { throttled } from '../src/throttle';

describe('throttled fetch', () => {
  it('spaces the requests to the listed hosts and leaves the others alone', async () => {
    let t = 0;
    const waits: number[] = [];
    const f = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const g = throttled(f, 1000, ['lrclib.net'], () => t, async (ms) => { waits.push(ms); t += ms; });
    await g('https://lrclib.net/api/a'); await g('https://lrclib.net/api/b'); await g('https://lrclib.net/api/c');
    await g('https://other.example/x');
    expect(waits).toEqual([1000, 1000]);
    expect(f).toHaveBeenCalledTimes(4);
  });
});
