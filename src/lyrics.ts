export type LrcLine = { t: number; text: string };
export type Lyrics = {
  synced?: LrcLine[];
  /** Original plain text, when that is all the source had. */
  plain?: string;
  /** Lines were spread over the song length, not timed by the source. */
  estimated?: boolean;
  /** Synced version whose length differs from the video: timing may be off. */
  approx?: boolean;
  source?: string;
};

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

/** Spreads plain lyrics over the song, weighting each line by its length. A rough guide, not real timing. */
export function estimateLines(plain: string, durationSec: number): LrcLine[] {
  if (!(durationSec > 0)) return [];
  const lines = plain.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\[[^\]]*\]$/.test(l));
  if (lines.length === 0) return [];
  const weights = lines.map((l) => Math.max(12, l.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const start = durationSec * 0.07, span = durationSec * 0.86;
  let acc = 0;
  return lines.map((text, i) => { const t = start + (acc / total) * span; acc += weights[i]; return { t, text }; });
}

type ApiHit = { syncedLyrics?: string | null; plainLyrics?: string | null; duration?: number; instrumental?: boolean };
const LRCLIB = 'https://lrclib.net/api';
const OVH = 'https://api.lyrics.ovh/v1';
const CLOSE_S = 8;
const APPROX_S = 30;

const asSynced = (h: ApiHit): LrcLine[] => (h.syncedLyrics ? parseLrc(h.syncedLyrics) : []);

async function getJson(f: typeof fetch, url: string): Promise<unknown | undefined> {
  try { const r = await f(url); return r.ok ? await r.json() : undefined; } catch { return undefined; }
}

/**
 * Looks the song up in several public databases, best first:
 * LRCLIB (synced) with the artist+title and the title alone, then LRCLIB plain text, then lyrics.ovh (plain).
 * Plain text gets estimated timing, labelled as such. Never throws.
 */
export async function fetchLyrics(videoTitle: string, channel: string, durationSec: number, f: typeof fetch = fetch): Promise<Lyrics | null> {
  const { artist, track } = guessArtistTitle(videoTitle, channel);
  if (!track) return null;
  const known = durationSec > 0;
  const diff = (h: ApiHit) => (known ? Math.abs((h.duration ?? 0) - durationSec) : 0);

  const hits: ApiHit[] = [];
  if (known) {
    const exact = await getJson(f, `${LRCLIB}/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`);
    if (exact && typeof exact === 'object') hits.push(exact as ApiHit);
  }
  for (const q of [...new Set([`${artist} ${track}`.trim(), track])]) {
    const list = await getJson(f, `${LRCLIB}/search?q=${encodeURIComponent(q)}`);
    if (Array.isArray(list)) hits.push(...(list as ApiHit[]));
  }
  const usable = hits.filter((h) => !h.instrumental && (!known || (typeof h.duration === 'number' && diff(h) <= APPROX_S)));
  const synced = usable.filter((h) => asSynced(h).length).sort((a, b) => diff(a) - diff(b));
  if (synced[0]) return { synced: asSynced(synced[0]), source: 'LRCLIB', approx: known && diff(synced[0]) > CLOSE_S };

  const plainHit = usable.filter((h) => h.plainLyrics).sort((a, b) => diff(a) - diff(b))[0];
  let plain = plainHit?.plainLyrics ?? undefined;
  let source = 'LRCLIB';
  if (!plain && artist) {
    const o = await getJson(f, `${OVH}/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`);
    const text = (o as { lyrics?: unknown } | undefined)?.lyrics;
    if (typeof text === 'string' && text.trim()) { plain = text; source = 'lyrics.ovh'; }
  }
  if (!plain) return null;
  const lines = estimateLines(plain, durationSec);
  return lines.length ? { synced: lines, plain, estimated: true, source } : null;
}

export type LyricsSnapshot = { prev: string; cur: string; next: string };

/** The three lines to display at `position`. A blank current line means an instrumental gap. */
export function snapshotAt(lines: LrcLine[], position: number, offset = 0): LyricsSnapshot {
  const i = lineIndexAt(lines, position, offset);
  const prevLine = [...lines.slice(0, Math.max(0, i))].reverse().find((l) => l.text)?.text ?? '';
  const nextLine = lines.slice(i + 1).find((l) => l.text)?.text ?? '';
  return { prev: prevLine, cur: i >= 0 ? lines[i].text : '', next: nextLine };
}
