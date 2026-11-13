import { describe, expect, it } from 'vitest';
import { parseSpotifyEmbed, parseSpotifyInput } from '../src/spotify';
import { loadSpotifyList } from '../src/spotifyLoader';
import { parseYtResults, rankResults } from '../src/ytSearch';

const ID = '37i9dQZF1DXcBWIGoYBM5M';
const embed = (tracks: unknown[]) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { name: 'Mix', trackList: tracks } } } } } })}</script></html>`;
const yt = (items: { id: string; title: string; ch: string; len: string }[]) =>
  `<script>var ytInitialData = ${JSON.stringify({ c: items.map((i) => ({ videoRenderer: { videoId: i.id, title: { runs: [{ text: i.title }] }, ownerText: { runs: [{ text: i.ch }] }, lengthText: { simpleText: i.len } } })) })};</script>`;

describe('spotify links', () => {
  it('accepts playlist and album links, localized links and URIs', () => {
    expect(parseSpotifyInput(`https://open.spotify.com/playlist/${ID}?si=abc`)).toEqual({ kind: 'playlist', id: ID });
    expect(parseSpotifyInput(`https://open.spotify.com/intl-it/playlist/${ID}`)).toEqual({ kind: 'playlist', id: ID });
    expect(parseSpotifyInput(`https://open.spotify.com/album/${ID}`)).toEqual({ kind: 'album', id: ID });
    expect(parseSpotifyInput(`spotify:playlist:${ID}`)).toEqual({ kind: 'playlist', id: ID });
  });
  it('rejects everything else', () => {
    expect(parseSpotifyInput('https://www.youtube.com/playlist?list=PLabcdefghijk')).toBeUndefined();
    expect(parseSpotifyInput(`https://open.spotify.com/track/${ID}`)).toBeUndefined();
    expect(parseSpotifyInput('https://evil.example/open.spotify.com/playlist/' + ID)).toBeUndefined();
  });
});

describe('spotify embed page', () => {
  it('reads title, artist and length of each track', () => {
    const r = parseSpotifyEmbed(embed([{ title: 'Housewife', subtitle: 'Tate McRae', duration: 208810 }, { title: '' }]));
    expect(r).toEqual({ name: 'Mix', tracks: [{ title: 'Housewife', artist: 'Tate McRae', durationSec: 209 }] });
  });
  it('gives undefined for a page without a list', () => {
    expect(parseSpotifyEmbed('<html></html>')).toBeUndefined();
  });
});

describe('youtube search ranking', () => {
  const want = { title: 'Housewife', artist: 'Tate McRae', durationSec: 209 };
  const results = parseYtResults(yt([
    { id: 'karaoke0001', title: 'Tate McRae - Housewife (Karaoke Version)', ch: 'Sing King', len: '3:29' },
    { id: 'official001', title: 'Tate McRae - Housewife (Official Video)', ch: 'Tate McRae', len: '3:30' },
    { id: 'topicaudio1', title: 'Housewife', ch: 'Tate McRae - Topic', len: '3:29' },
    { id: 'wronglength', title: 'Tate McRae - Housewife', ch: 'Fan', len: '9:59' },
  ]));
  it('parses ids, titles, channels and lengths', () => {
    expect(results[2]).toEqual({ videoId: 'topicaudio1', title: 'Housewife', channel: 'Tate McRae - Topic', seconds: 209 });
    expect(parseYtResults('<html></html>')).toEqual([]);
  });
  it('prefers the studio audio and drops karaoke and wrong lengths', () => {
    const ranked = rankResults(results, want).map((r) => r.videoId);
    expect(ranked[0]).toBe('topicaudio1');
    expect(ranked).not.toContain('karaoke0001');
    expect(ranked).not.toContain('wronglength');
  });
});

describe('loading a spotify list', () => {
  const tracks = [
    { title: 'Housewife', subtitle: 'Tate McRae', duration: 209000 },
    { title: 'Housewife', subtitle: 'Tate McRae', duration: 209000 },
    { title: 'Nessuna', subtitle: 'Nessuno', duration: 100000 },
  ];
  const get = async (url: string) => (url.includes('/embed/')
    ? embed(tracks)
    : url.includes('Nessuno') ? yt([]) : yt([{ id: 'topicaudio1', title: 'Housewife', ch: 'Tate McRae - Topic', len: '3:29' }]));
  const check = async () => ({ ok: true as const, title: '', author: '', thumb: 'thumb.jpg' });
  it('keeps one entry per song, reports the ones not found, and counts progress', async () => {
    const seen: number[] = [];
    const r = await loadSpotifyList({ kind: 'playlist', id: ID }, get, (d) => seen.push(d), check);
    expect(r.tracks.map((t) => t.videoId)).toEqual(['topicaudio1']);
    expect(r.tracks[0]).toMatchObject({ title: 'Housewife', artist: 'Tate McRae', status: 'ok' });
    expect(r.missing.map((m) => m.title)).toEqual(['Nessuna']);
    expect(r.total).toBe(3);
    expect(seen.at(-1)).toBe(3);
  });
  it('tries the next candidate when the first cannot be embedded', async () => {
    const two = async (url: string) => (url.includes('/embed/') ? embed([tracks[0]]) : yt([
      { id: 'blocked0001', title: 'Housewife', ch: 'Tate McRae - Topic', len: '3:29' },
      { id: 'goodvideo01', title: 'Tate McRae - Housewife (Official Audio)', ch: 'Tate McRae', len: '3:29' },
    ]));
    const chk = async (id: string) => (id === 'blocked0001' ? { ok: false as const, reason: 'no' } : { ok: true as const, title: '', author: '', thumb: '' });
    const r = await loadSpotifyList({ kind: 'playlist', id: ID }, two, () => {}, chk);
    expect(r.tracks.map((t) => t.videoId)).toEqual(['goodvideo01']);
  });
});
