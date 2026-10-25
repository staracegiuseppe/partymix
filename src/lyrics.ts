export type LrcLine = { t: number; text: string };
export type Lyrics = { synced?: LrcLine[]; plain?: string };

const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parses LRC text ("[mm:ss.xx] words") into time-sorted lines. */
export function parseLrc(text: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)];
    if (stamps.length === 0) continue;
    const words = raw.replace(STAMP, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      out.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text: words });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at `position` seconds; offset shifts the lyrics (positive = lyrics appear earlier). */
export function lineIndexAt(lines: LrcLine[], position: number, offset = 0): number {
  const p = position + offset;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const strip = (s: string) => s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

export function guessArtistTitle(videoTitle: string, channel: string): { artist: string; track: string } {
  const title = strip(videoTitle).replace(/\s[-–]\s*\d{4}\s*$/, '').trim();
  const parts = title.split(/\s[-–]\s/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], track: parts[1] };
  return { artist: channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim(), track: title };
}

type ApiHit = { syncedLyrics?: string | null; plainLyrics?: string | null; duration?: number; instrumental?: boolean };
const API = 'https://lrclib.net/api';
const TOLERANCE_S = 8;

const toLyrics = (h: ApiHit): Lyrics | null => {
  if (h.instrumental) return null;
  const synced = h.syncedLyrics ? parseLrc(h.syncedLyrics) : [];
  if (synced.length) return { synced };
  return h.plainLyrics ? { plain: h.plainLyrics } : null;
};

/** Looks the song up on LRCLIB (public lyrics database with timestamps). Never throws. */
export async function fetchLyrics(videoTitle: string, channel: string, durationSec: number, f: typeof fetch = fetch): Promise<Lyrics | null> {
  const { artist, track } = guessArtistTitle(videoTitle, channel);
  if (!track) return null;
  try {
    if (durationSec > 0) {
      const r = await f(`${API}/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`);
      if (r.ok) { const l = toLyrics(await r.json()); if (l) return l; }
    }
    const r = await f(`${API}/search?q=${encodeURIComponent(`${artist} ${track}`.trim())}`);
    if (!r.ok) return null;
    const hits = ((await r.json()) as ApiHit[]).filter((h) => !h.instrumental && (h.syncedLyrics || h.plainLyrics));
    const close = durationSec > 0 ? hits.filter((h) => typeof h.duration === 'number' && Math.abs(h.duration - durationSec) <= TOLERANCE_S) : hits;
    close.sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || Math.abs((a.duration ?? 0) - durationSec) - Math.abs((b.duration ?? 0) - durationSec));
    return close[0] ? toLyrics(close[0]) : null;
  } catch {
    return null;
  }
}

export type LyricsSnapshot = { prev: string; cur: string; next: string };

/** The three lines to display at `position`. A blank current line means an instrumental gap. */
export function snapshotAt(lines: LrcLine[], position: number, offset = 0): LyricsSnapshot {
  const i = lineIndexAt(lines, position, offset);
  const prevLine = [...lines.slice(0, Math.max(0, i))].reverse().find((l) => l.text)?.text ?? '';
  const nextLine = lines.slice(i + 1).find((l) => l.text)?.text ?? '';
  return { prev: prevLine, cur: i >= 0 ? lines[i].text : '', next: nextLine };
}
