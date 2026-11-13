/** Spaces out the requests to the given hosts (the free lyric databases ask for roughly one request a second); other requests pass untouched. */
export function throttled(f: typeof fetch, gapMs: number, hosts: string[], now: () => number = () => Date.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  let next = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (hosts.some((h) => url.includes(h))) {
      const t = now(), at = Math.max(t, next);
      next = at + gapMs;
      if (at > t) await sleep(at - t);
    }
    return f(input, init);
  }) as typeof fetch;
}
