import { isoSeconds, readPlaylistApi, searchYouTube } from '../src/ytSearch';
import { MemoryKV } from '../src/library/kv';
import { PlaylistStore } from '../src/library/playlists';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const searchBody = {
  nextPageToken: 'NEXT',
  items: [
    { id: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'The Weeknd - Blinding Lights (Official Audio)', channelTitle: 'TheWeekndVEVO', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg' } } } },
    { id: { videoId: 'bbbbbbbbbbb' }, snippet: { title: 'Blinding Lights &amp; more', channelTitle: 'Someone' } },
    { id: { videoId: 'ccccccccccc' }, snippet: { title: 'Gone', channelTitle: 'X' } },
  ],
};
const videosBody = { items: [
  { id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT3M22S' }, status: { embeddable: true, privacyStatus: 'public' }, snippet: { liveBroadcastContent: 'none' } },
  { id: 'bbbbbbbbbbb', contentDetails: { duration: 'PT1H2M3S' }, status: { embeddable: false }, snippet: {} },
] };
function api(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname.split('/').pop()!;
    const r = routes[path];
    if (!r) throw new Error('unexpected ' + url);
    return r();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('🔎 Cerca su YouTube (official API)', () => {
  it('searches «titolo + artista» and shows thumbnail, title, channel and length', async () => {
    const f = api({ search: () => json(searchBody), videos: () => json(videosBody) });
    const r = await searchYouTube('The Weeknd Blinding Lights', { apiKey: 'K', fetch: f });
    expect(r.via).toBe('api');
    expect(r.next).toBe('NEXT');
    expect(r.hits[0]).toEqual({ videoId: 'aaaaaaaaaaa', title: 'The Weeknd - Blinding Lights (Official Audio)', channel: 'TheWeekndVEVO', seconds: 202, thumb: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg', available: true });
    const q = new URL((f.mock.calls[0] as [string])[0]).searchParams;
    expect(q.get('q')).toBe('The Weeknd Blinding Lights');
    expect(q.get('type')).toBe('video');
    expect(q.get('key')).toBe('K');
  });
  it('marks results that cannot be played (not embeddable, removed) instead of hiding them', async () => {
    const r = await searchYouTube('x', { apiKey: 'K', fetch: api({ search: () => json(searchBody), videos: () => json(videosBody) }) });
    expect(r.hits[1]).toMatchObject({ title: 'Blinding Lights & more', available: false, seconds: 3723 });
    expect(r.hits[1].reason).toMatch(/non permette/);
    expect(r.hits[2]).toMatchObject({ available: false, reason: 'Video non più disponibile' });
  });
  it('network down → a readable message', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(searchYouTube('x', { apiKey: 'K', fetch: f })).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/Rete assente/) });
  });
  it('API errors: quota, bad key, server error — never raw', async () => {
    const quota = api({ search: () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403) });
    await expect(searchYouTube('x', { apiKey: 'K', fetch: quota })).rejects.toMatchObject({ kind: 'quota' });
    const key = api({ search: () => json({ error: { errors: [{ reason: 'keyInvalid' }] } }, 400) });
    await expect(searchYouTube('x', { apiKey: 'K', fetch: key })).rejects.toMatchObject({ kind: 'key' });
    const boom = api({ search: () => new Response('<html>oops</html>', { status: 500 }) });
    await expect(searchYouTube('x', { apiKey: 'K', fetch: boom })).rejects.toMatchObject({ kind: 'api', message: expect.stringMatching(/riprova/) });
  });
  it('empty search and no results', async () => {
    await expect(searchYouTube('   ', { apiKey: 'K' })).rejects.toMatchObject({ kind: 'empty' });
    const r = await searchYouTube('zzzz', { apiKey: 'K', fetch: api({ search: () => json({ items: [] }) }) });
    expect(r.hits).toEqual([]);
  });
  it('without a key: needs the app (page reading) or asks for a key', async () => {
    await expect(searchYouTube('x', {})).rejects.toMatchObject({ kind: 'key' });
    const html = `<script>var ytInitialData = ${JSON.stringify({ a: { videoRenderer: { videoId: 'ddddddddddd', title: { runs: [{ text: 'Song' }] }, ownerText: { runs: [{ text: 'Chan' }] }, lengthText: { simpleText: '3:05' } } } })};</script>`;
    const r = await searchYouTube('x', { getText: async () => html });
    expect(r).toMatchObject({ via: 'web', hits: [{ videoId: 'ddddddddddd', title: 'Song', channel: 'Chan', seconds: 185, available: true }] });
  });
  it('a result goes into a playlist (once)', async () => {
    const r = await searchYouTube('x', { apiKey: 'K', fetch: api({ search: () => json(searchBody), videos: () => json(videosBody) }) });
    const s = new PlaylistStore(new MemoryKV());
    const p = s.create('Festa');
    const h = r.hits[0];
    const t = { videoId: h.videoId, title: h.title, artist: h.channel, durationSec: h.seconds, thumb: h.thumb, status: 'ok' as const };
    expect(s.addTracks(p.id, [t])).toEqual({ added: 1, duplicates: 0 });
    expect(s.addTracks(p.id, [t])).toEqual({ added: 0, duplicates: 1 });
  });
  it('reads a whole playlist page by page (beyond the ~200 the player gives)', async () => {
    let page = 0;
    const f = api({ playlistItems: () => { page++; return json({ items: Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: `v${page}_${i}` } })), nextPageToken: page < 6 ? `p${page}` : undefined }); } });
    const ids = await readPlaylistApi('PLx', 'K', f);
    expect(ids).toHaveLength(300);
  });
  it('ISO 8601 lengths', () => {
    expect(isoSeconds('PT3M20S')).toBe(200);
    expect(isoSeconds('PT45S')).toBe(45);
    expect(isoSeconds('P1DT1S')).toBe(86401);
    expect(isoSeconds('')).toBe(0);
  });
});
