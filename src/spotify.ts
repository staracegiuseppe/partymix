export type SpotifyRef = { kind: 'playlist' | 'album'; id: string };
export type SpotifyTrack = { title: string; artist: string; durationSec: number };
export type SpotifyList = { name: string; tracks: SpotifyTrack[] };

const ID = /^[A-Za-z0-9]{22}$/;

/** Accepts open.spotify.com links (also the localized /intl-xx/ ones) and spotify: URIs for playlists and albums. */
export function parseSpotifyInput(text: string): SpotifyRef | undefined {
  const t = text.trim();
  const uri = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(t);
  if (uri) return { kind: uri[1] as SpotifyRef['kind'], id: uri[2] };
  let url: URL;
  try { url = new URL(t); } catch { return undefined; }
  if (url.hostname !== 'open.spotify.com') return undefined;
  const m = /^\/(?:intl-[a-z-]+\/)?(playlist|album)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  return m && ID.test(m[2]) ? { kind: m[1] as SpotifyRef['kind'], id: m[2] } : undefined;
}

export const spotifyEmbedUrl = (r: SpotifyRef) => `https://open.spotify.com/embed/${r.kind}/${r.id}`;

/** Reads the track list Spotify embeds in its public embed page (no account or key needed). */
export function parseSpotifyEmbed(html: string): SpotifyList | undefined {
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(html);
  if (!m) return undefined;
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { return undefined; }
  const entity = (data as { props?: { pageProps?: { state?: { data?: { entity?: { name?: unknown; title?: unknown; trackList?: unknown } } } } } })
    .props?.pageProps?.state?.data?.entity;
  if (!entity || !Array.isArray(entity.trackList)) return undefined;
  const tracks: SpotifyTrack[] = [];
  for (const t of entity.trackList as { title?: unknown; subtitle?: unknown; duration?: unknown }[]) {
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!title) continue;
    tracks.push({
      title,
      artist: typeof t.subtitle === 'string' ? t.subtitle.replace(/ /g, ' ').trim() : '',
      durationSec: typeof t.duration === 'number' ? Math.round(t.duration / 1000) : 0,
    });
  }
  return { name: String(entity.name ?? entity.title ?? 'Playlist Spotify'), tracks };
}
