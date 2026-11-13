import { fetchOEmbed } from './oembed';
import { parsePlaylistInput, videoIdFromUrl } from './playlistUrl';
import type { Track } from './queue';

/** Builds tracks in the original order; a failing lookup marks that track unplayable. */
export async function buildTracks(
  ids: string[],
  meta: (id: string) => Promise<Partial<Track>>,
  concurrency = 5,
): Promise<Track[]> {
  const out: Track[] = ids.map((videoId) => ({ videoId, status: 'pending' }));
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        out[i] = { ...(await meta(ids[i])), videoId: ids[i], status: 'ok' };
      } catch {
        out[i] = { videoId: ids[i], status: 'unplayable' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return out;
}

export async function oembedMeta(videoId: string, f: typeof fetch = fetch): Promise<Partial<Track>> {
  const r = await fetchOEmbed(videoId, f);
  if (!r.ok) throw new Error(r.reason);
  return { title: r.title, artist: r.author, thumb: r.thumb };
}

export type Probe = (videoId: string) => Promise<{ ok: boolean; reason?: string }>;

export async function verifyReplacement(
  text: string,
  f: typeof fetch = fetch,
  probe?: Probe,
): Promise<{ ok: boolean; track?: Track; message: string }> {
  const videoId = videoIdFromUrl(text);
  if (!videoId) {
    const parsed = parsePlaylistInput(text);
    return parsed.kind === 'playlist'
      ? { ok: false, message: 'Questo è il link di una playlist: incolla il link di un singolo video.' }
      : { ok: false, message: 'Link non valido: incolla il link di un video YouTube.' };
  }
  const r = await fetchOEmbed(videoId, f);
  if (!r.ok) return { ok: false, message: `Non va bene: ${r.reason}.` };
  if (probe) {
    const p = await probe(videoId);
    if (!p.ok) return { ok: false, message: `Non va bene: ${p.reason ?? 'il video non parte'}.` };
  }
  return {
    ok: true,
    track: { videoId, title: r.title, artist: r.author, thumb: r.thumb, status: 'ok' },
    message: `Va bene: «${r.title}» si può riprodurre.`,
  };
}

/** Video ids listed on a YouTube playlist page, for playlists the embedded player cannot read (old or unusual ones). */
export function parsePlaylistPage(html: string): string[] {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!m) return [];
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const items: string[] = [];
  const lockups: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, any>;
    if (typeof r.playlistVideoRenderer?.videoId === 'string') items.push(r.playlistVideoRenderer.videoId);
    const l = r.lockupViewModel;
    if (l && typeof l.contentId === 'string' && /VIDEO$/.test(String(l.contentType ?? ''))) lockups.push(l.contentId);
    Object.values(r).forEach(walk);
  };
  walk(data);
  return [...new Set(items.length ? items : lockups)];
}
