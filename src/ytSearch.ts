export type YtResult = { videoId: string; title: string; channel: string; seconds: number };
export type Wanted = { title: string; artist: string; durationSec: number };

export const ytSearchUrl = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q).replace(/%20/g, '+')}&sp=EgIQAQ%253D%253D`;

const seconds = (s: string): number => s.split(':').reduce((n, p) => n * 60 + (Number(p) || 0), 0);

/** Video results from a YouTube search page (the data the page itself is built from). */
export function parseYtResults(html: string): YtResult[] {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!m) return [];
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out: YtResult[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, any>;
    const v = r.videoRenderer;
    if (v && typeof v.videoId === 'string') {
      out.push({
        videoId: v.videoId,
        title: String(v.title?.runs?.[0]?.text ?? ''),
        channel: String(v.ownerText?.runs?.[0]?.text ?? ''),
        seconds: seconds(String(v.lengthText?.simpleText ?? '')),
      });
    }
    Object.values(r).forEach(walk);
  };
  walk(data);
  return out;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const BAD = /\b(karaoke|cover|live|remix|reaction|slowed|reverb|sped up|nightcore|8d|instrumental|tutorial|lesson|chords|piano|acoustic|mashup|parody|1 hour|loop|extended)\b/g;

/**
 * Ranks the results for a Spotify track. Studio audio ("- Topic" channels, official audio) is preferred over music videos:
 * videos open with intros and drift against the lyric timings. Returns the candidates best first, best score >= 15 only.
 */
export function rankResults(results: YtResult[], want: Wanted): YtResult[] {
  const wTitle = norm(want.title), wArtist = norm(want.artist.split(',')[0] ?? '');
  const wantBad = new Set(wTitle.match(BAD) ?? []);
  const score = (r: YtResult): number => {
    const t = norm(r.title), c = norm(r.channel);
    let s = 0;
    if (want.durationSec > 0 && r.seconds > 0) {
      const d = Math.abs(r.seconds - want.durationSec);
      s += d <= 3 ? 40 : d <= 8 ? 30 : d <= 20 ? 10 : d > 40 ? -40 : 0;
    }
    if (wTitle && ` ${t} `.includes(` ${wTitle} `)) s += 25;
    if (wArtist && (t.includes(wArtist) || c.includes(wArtist))) s += 12;
    if (/topic$/.test(c)) s += 20;
    if (/\bvevo$/.test(c)) s += 6;
    if (/official audio|audio ufficiale|\(audio\)/.test(t)) s += 8;
    if (/official (music )?video|video ufficiale/.test(t)) s -= 4;
    for (const b of t.match(BAD) ?? []) if (!wantBad.has(b)) s -= 100;
    return s;
  };
  return results.map((r, i) => ({ r, s: score(r) - i * 0.5 })).filter((x) => x.s >= 15).sort((a, b) => b.s - a.s).map((x) => x.r);
}

// --- «🔎 Cerca su YouTube»: official YouTube Data API v3 (needs the user's free API key); the page reading above stays as a fallback. ---

export type SearchHit = { videoId: string; title: string; channel: string; seconds: number; thumb: string; available: boolean; reason?: string };
export type SearchResult = { hits: SearchHit[]; via: 'api' | 'web'; next?: string };

/** A search problem, in words for the user (never a raw HTTP or JSON error). */
export class SearchError extends Error { constructor(message: string, readonly kind: 'network' | 'quota' | 'key' | 'api' | 'empty') { super(message); } }

const API = 'https://www.googleapis.com/youtube/v3';
const thumbOf = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const decodeEntities = (s: string) => s.replace(/&(amp|quot|#39|lt|gt);/g, (_, e) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' } as Record<string, string>)[e]);

/** ISO 8601 length («PT3M20S») in seconds. */
export function isoSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : 0;
}

async function apiGet(f: typeof fetch, path: string, params: Record<string, string>): Promise<any> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  let res: Response;
  try { res = await f(url); } catch { throw new SearchError('Rete assente: controlla la connessione e riprova.', 'network'); }
  let body: any = {};
  try { body = await res.json(); } catch { /* not JSON: handled by the status below */ }
  if (!res.ok) {
    const reason = String(body?.error?.errors?.[0]?.reason ?? '');
    if (/quota|rateLimit/i.test(reason)) throw new SearchError('La quota giornaliera della chiave YouTube è finita: riprova domani (o usa un’altra chiave).', 'quota');
    if (res.status === 400 || (res.status === 403 && /key|forbidden|accessNotConfigured/i.test(reason))) throw new SearchError('La chiave API YouTube non è valida o non è abilitata per «YouTube Data API v3».', 'key');
    throw new SearchError(`YouTube non ha risposto come previsto (errore ${res.status}): riprova tra poco.`, 'api');
  }
  return body;
}

/**
 * Searches songs on YouTube. With a key: the official API (search + video details: length, can it be embedded?).
 * Without: the results page read by the app (`getText`), the same reading already used to import Spotify playlists.
 */
export async function searchYouTube(q: string, o: { apiKey?: string; fetch?: typeof fetch; getText?: (url: string) => Promise<string>; max?: number; pageToken?: string } = {}): Promise<SearchResult> {
  const query = q.trim();
  if (!query) throw new SearchError('Scrivi il titolo, l’artista o entrambi.', 'empty');
  const f = o.fetch ?? fetch;
  if (o.apiKey) {
    const s = await apiGet(f, 'search', { part: 'snippet', type: 'video', maxResults: String(o.max ?? 25), q: query, key: o.apiKey, ...(o.pageToken ? { pageToken: o.pageToken } : {}) });
    const ids: string[] = (s.items ?? []).map((i: any) => i?.id?.videoId).filter((x: unknown): x is string => typeof x === 'string');
    if (!ids.length) return { hits: [], via: 'api' };
    const v = await apiGet(f, 'videos', { part: 'contentDetails,status,snippet', id: ids.join(','), key: o.apiKey });
    const details = new Map<string, any>((v.items ?? []).map((i: any) => [i.id, i]));
    const hits = ids.map((id): SearchHit => {
      const sn = (s.items as any[]).find((i) => i?.id?.videoId === id)?.snippet ?? {};
      const d = details.get(id);
      let reason: string | undefined;
      if (!d) reason = 'Video non più disponibile';
      else if (d.status?.embeddable === false) reason = 'Il proprietario non permette di riprodurlo fuori da YouTube';
      else if (d.status?.privacyStatus === 'private') reason = 'Video privato';
      else if (d.snippet?.liveBroadcastContent === 'live' || d.snippet?.liveBroadcastContent === 'upcoming') reason = 'È una diretta, non un brano';
      return {
        videoId: id, title: decodeEntities(String(sn.title ?? d?.snippet?.title ?? '')), channel: decodeEntities(String(sn.channelTitle ?? '')),
        seconds: isoSeconds(d?.contentDetails?.duration ?? ''), thumb: sn.thumbnails?.medium?.url ?? thumbOf(id), available: !reason, ...(reason ? { reason } : {}),
      };
    });
    return { hits, via: 'api', next: typeof s.nextPageToken === 'string' ? s.nextPageToken : undefined };
  }
  if (!o.getText) throw new SearchError('Per cercare su YouTube serve una chiave API (gratuita): inseriscila qui sotto.', 'key');
  let html: string;
  try { html = await o.getText(ytSearchUrl(query)); } catch { throw new SearchError('Rete assente o YouTube non raggiungibile: riprova.', 'network'); }
  return { hits: parseYtResults(html).map((r) => ({ ...r, thumb: thumbOf(r.videoId), available: true })), via: 'web' };
}

/** Every video of a YouTube playlist through the API (50 per page, no limit), for playlists bigger than the ~200 the player reads. */
export async function readPlaylistApi(listId: string, apiKey: string, f: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  let page: string | undefined;
  do {
    const r = await apiGet(f, 'playlistItems', { part: 'contentDetails', maxResults: '50', playlistId: listId, key: apiKey, ...(page ? { pageToken: page } : {}) });
    for (const i of r.items ?? []) if (typeof i?.contentDetails?.videoId === 'string') out.push(i.contentDetails.videoId);
    page = typeof r.nextPageToken === 'string' ? r.nextPageToken : undefined;
  } while (page);
  return out;
}
