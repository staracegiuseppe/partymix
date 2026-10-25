import { fetchOEmbed } from '../src/oembed';
import { buildTracks, verifyReplacement } from '../src/playlistLoader';
import { videoIdFromUrl } from '../src/playlistUrl';
import { YouTubeDeck, YtPlayerLike } from '../src/youtubeDeck';

const res = (status: number, body: unknown = {}) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
const okFetch = (async () => res(200, { title: 'Canzone', author_name: 'Artista', thumbnail_url: 't.jpg' })) as unknown as typeof fetch;

describe('fetchOEmbed', () => {
  it('returns title, author and thumbnail', async () => {
    await expect(fetchOEmbed('b2GlV6Ap-3g', okFetch)).resolves.toEqual({ ok: true, title: 'Canzone', author: 'Artista', thumb: 't.jpg' });
  });
  it('explains embedding refusals and missing videos in Italian', async () => {
    const r401 = await fetchOEmbed('x', (async () => res(401)) as unknown as typeof fetch);
    expect(r401).toMatchObject({ ok: false });
    expect((r401 as { reason: string }).reason).toMatch(/incorpor/i);
    const r404 = await fetchOEmbed('x', (async () => res(404)) as unknown as typeof fetch);
    expect((r404 as { reason: string }).reason).toMatch(/non trovato|rimosso|privato/i);
  });
  it('reports a network failure instead of throwing', async () => {
    const r = await fetchOEmbed('x', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/rete/i);
  });
});

describe('buildTracks', () => {
  it('keeps order and marks failures unplayable without dropping other tracks', async () => {
    const meta = async (id: string) => {
      if (id === 'b') throw new Error('nope');
      return { title: id.toUpperCase() };
    };
    const tracks = await buildTracks(['a', 'b', 'c'], meta, 2);
    expect(tracks.map((t) => [t.videoId, t.status, t.title])).toEqual([
      ['a', 'ok', 'A'], ['b', 'unplayable', undefined], ['c', 'ok', 'C'],
    ]);
  });
  it('never runs more lookups at once than the concurrency limit', async () => {
    let now = 0, peak = 0;
    const meta = async () => { now++; peak = Math.max(peak, now); await Promise.resolve(); await Promise.resolve(); now--; return {}; };
    await buildTracks(Array.from({ length: 12 }, (_, i) => 'v' + i), meta, 3);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('handles an empty playlist', async () => {
    await expect(buildTracks([], async () => ({}))).resolves.toEqual([]);
  });
});

describe('videoIdFromUrl', () => {
  it('finds the video even when the url also carries a list', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=b2GlV6Ap-3g&list=PLfBfxMb0qlFw')).toBe('b2GlV6Ap-3g');
    expect(videoIdFromUrl('https://youtube.com/playlist?list=PLfBfxMb0qlFw')).toBeUndefined();
  });
});

describe('verifyReplacement', () => {
  it('rejects text that is not a link', async () => {
    const r = await verifyReplacement('abc', okFetch);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Link non valido/);
  });
  it('rejects a bare playlist link', async () => {
    const r = await verifyReplacement('https://youtube.com/playlist?list=PLfBfxMb0qlFw', okFetch);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/playlist/i);
  });
  it('accepts an embeddable video and returns a track', async () => {
    const r = await verifyReplacement('https://www.youtube.com/watch?v=b2GlV6Ap-3g', okFetch);
    expect(r.ok).toBe(true);
    expect(r.track).toMatchObject({ videoId: 'b2GlV6Ap-3g', title: 'Canzone', status: 'ok' });
    expect(r.message).toMatch(/Va bene/);
  });
  it('reports why a video cannot be used', async () => {
    const r = await verifyReplacement('https://youtu.be/b2GlV6Ap-3g', (async () => res(401)) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Non va bene/);
    expect(r.track).toBeUndefined();
  });
  it('fails when the live probe fails even if oEmbed passes', async () => {
    const r = await verifyReplacement('https://youtu.be/b2GlV6Ap-3g', okFetch, async () => ({ ok: false, reason: 'Errore 150' }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Errore 150/);
  });
});

describe('YouTubeDeck.readPlaylist', () => {
  const mk = () => {
    const calls: string[] = [];
    const p = {
      cuePlaylist: (a: { list: string }) => calls.push('cuePlaylist:' + a.list),
      getPlaylist: () => ['a', 'b'],
    } as unknown as YtPlayerLike;
    return { calls, deck: new YouTubeDeck(p, { setTimer: () => 0, clearTimer: () => {} }) };
  };
  it('cues the playlist and returns its video ids', async () => {
    const { calls, deck } = mk();
    const ids = deck.readPlaylist('PLx');
    expect(calls).toEqual(['cuePlaylist:PLx']);
    deck.handleState(5);
    await expect(ids).resolves.toEqual(['a', 'b']);
  });
  it('rejects when the playlist is not available', async () => {
    const { deck } = mk();
    const ids = deck.readPlaylist('PLx');
    deck.handleError(100);
    await expect(ids).rejects.toThrow();
  });
});
