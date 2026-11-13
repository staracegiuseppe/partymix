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
