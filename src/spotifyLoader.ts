import { fetchOEmbed } from './oembed';
import type { Track } from './queue';
import { parseSpotifyEmbed, spotifyEmbedUrl, SpotifyRef, SpotifyTrack } from './spotify';
import { parseYtResults, rankResults, ytSearchUrl } from './ytSearch';

export type Getter = (url: string) => Promise<string>;
export type SpotifyLoad = { name: string; tracks: Track[]; missing: SpotifyTrack[]; total: number };

/** Finds each Spotify track on YouTube (Spotify itself cannot be played here) and checks the video can be embedded. */
export async function loadSpotifyList(
  ref: SpotifyRef,
  get: Getter,
  onProgress: (done: number, total: number) => void = () => {},
  check: (videoId: string) => ReturnType<typeof fetchOEmbed> = (id) => fetchOEmbed(id),
  concurrency = 4,
): Promise<SpotifyLoad> {
  const list = parseSpotifyEmbed(await get(spotifyEmbedUrl(ref)));
  if (!list || list.tracks.length === 0) throw new Error('Playlist Spotify vuota, privata o non leggibile');
  const found: (Track | undefined)[] = new Array(list.tracks.length).fill(undefined);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.tracks.length) {
      const i = next++, t = list.tracks[i];
      try {
        const html = await get(ytSearchUrl(`${t.artist.split(',')[0]} ${t.title}`));
        for (const cand of rankResults(parseYtResults(html), t).slice(0, 3)) {
          const ok = await check(cand.videoId);
          if (ok.ok) {
            found[i] = { videoId: cand.videoId, title: t.title, artist: t.artist, thumb: ok.thumb, durationSec: t.durationSec || cand.seconds, structured: true, status: 'ok' };
            break;
          }
        }
      } catch { /* this track simply stays missing */ }
      onProgress(++done, list.tracks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.tracks.length) }, worker));
  const tracks = found.filter((x): x is Track => !!x);
  // The same song twice in the list would play twice: keep one entry per video.
  const seen = new Set<string>();
  const unique = tracks.filter((t) => (seen.has(t.videoId) ? false : (seen.add(t.videoId), true)));
  return { name: list.name, tracks: unique, missing: list.tracks.filter((_, i) => !found[i]), total: list.tracks.length };
}
