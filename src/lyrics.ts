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
  /** Length of the studio track the timings belong to, when the source says. */
  trackDuration?: number;
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
  const weights = lines.map((l) => Math.max(2, l.split(/\s+/).reduce((n, w) => n + syllables(w), 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  const start = durationSec * 0.07, span = durationSec * 0.86;
  let acc = 0;
  return lines.map((text, i) => { const t = start + (acc / total) * span; acc += weights[i]; return { t, text }; });
}

type ApiHit = { trackName?: string; artistName?: string; syncedLyrics?: string | null; plainLyrics?: string | null; duration?: number; instrumental?: boolean };
const LRCLIB = 'https://lrclib.net/api';
const OVH = 'https://api.lyrics.ovh/v1';
const GENIUS = 'https://genius.com';
export const CLOSE_S = 8;
const APPROX_S = 90; // only applied to hits whose title and artist already match

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Same song? The title must appear whole in the hit's title, and the artists must overlap (when both are known). */
function sameSong(h: ApiHit, artist: string, track: string): boolean {
  if (h.trackName && !` ${norm(h.trackName)} `.includes(` ${norm(track)} `)) return false;
  if (h.artistName && artist) {
    const a = norm(artist), b = norm(h.artistName);
    if (a && b && !a.includes(b) && !b.includes(a)) return false;
  }
  return true;
}

const asSynced = (h: ApiHit): LrcLine[] => (h.syncedLyrics ? parseLrc(h.syncedLyrics) : []);

/** The source could not answer right now (rate limit, no network): it says nothing about whether the song exists. */
export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}

/**
 * Reads JSON. A rate limit or a missing network throws TransientError. A server error (LRCLIB answers 503 when it is busy)
 * counts as "nothing here" for this one call and is reported through `onServerError`, so findLyrics can tell "busy" from "not found".
 */
async function getJson(f: typeof fetch, url: string, onServerError?: () => void): Promise<unknown | undefined> {
  let r: Response;
  try { r = await f(url); } catch { throw new TransientError('rete non raggiungibile'); }
  if (r.status === 429) throw new TransientError('risposta 429', (Number(r.headers?.get?.('retry-after')) || 0) * 1000);
  if (r.status >= 500) { onServerError?.(); return undefined; }
  if (!r.ok) return undefined;
  try { return await r.json(); } catch { return undefined; }
}

/** A song title as the studio version is listed: no "(feat. …)", "[with …]", "- Remastered", "- Original Soundtrack"… */
export function cleanTrackTitle(title: string): string {
  const t = title
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+[-–]\s+(?:remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|live\b.*|original soundtrack|.*\b(?:version|edit|mix|remix)\b.*|from\b.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || title.trim();
}

/** Artists as Spotify lists them ("A, B & C"): the first one for searching, all of them for matching. */
export function splitArtists(artists: string): string[] {
  return artists.split(/\s*(?:,|&|\be\b|\bx\b|\bfeat\.?|\bft\.?)\s*/i).map((a) => a.trim()).filter(Boolean);
}

export type FetchOpts = {
  /** Title and artist already come separate and reliable (Spotify): do not try to read "Artist - Title" out of the title. */
  structured?: boolean;
  /** Reads a web page that a web view may not read directly (Genius). Without it that source is skipped. */
  getText?: (url: string) => Promise<string>;
};

export type FoundLyrics = {
  synced?: LrcLine[];
  /** Plain text, when no source had the timings. */
  plain?: string;
  source: string;
  /** Length of the studio track the timings belong to. */
  trackDuration?: number;
  /** Synced version whose length differs from the requested one: timing may be off. */
  approx?: boolean;
};

/** Genius page → lyrics text. The page has no clean API, so this reads the lyric blocks and drops the page furniture. */
export function parseGeniusLyrics(html: string): string | undefined {
  const parts: string[] = [];
  const start = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(html))) {
    let depth = 1, i = m.index + m[0].length;
    const tag = /<(\/?)div\b[^>]*>/g;
    tag.lastIndex = i;
    for (let t = tag.exec(html); t; t = tag.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { parts.push(html.slice(i, t.index)); break; }
    }
  }
  if (parts.length === 0) return undefined;
  const text = parts.join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:#x27|#39|apos);/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  const lines = text.split('\n').map((l) => l.replace(/\[\?\]/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => !/^\d*\s*Contributors?\b/i.test(l) && !/\bLyrics\s*\[/i.test(l) && !/^(?:See .* Live|Get tickets|You might also like)/i.test(l) && !/^\d*Embed$/i.test(l));
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > 40 ? out : undefined;
}

async function geniusLyrics(getText: (u: string) => Promise<string>, artists: string[], track: string): Promise<string | undefined> {
  const wantTrack = norm(track), wantArtists = artists.map(norm).filter(Boolean);
  try {
    const raw = await getText(`${GENIUS}/api/search/multi?per_page=5&q=${encodeURIComponent(`${artists[0] ?? ''} ${track}`.trim())}`);
    const data = JSON.parse(raw) as { response?: { sections?: { hits?: { type?: string; result?: { _type?: string; title?: string; url?: string; primary_artist?: { name?: string } } }[] }[] } };
    for (const sec of data.response?.sections ?? []) {
      for (const hit of sec.hits ?? []) {
        const r = hit.result;
        if (!r || r._type !== 'song' || !r.url || !r.url.startsWith(`${GENIUS}/`)) continue;
        const t = norm(r.title ?? ''), a = norm(r.primary_artist?.name ?? '');
        const titleOk = !!wantTrack && (` ${t} `.includes(` ${wantTrack} `) || ` ${wantTrack} `.includes(` ${t} `));
        const artistOk = wantArtists.length === 0 || !a || wantArtists.some((w) => w.includes(a) || a.includes(w));
        if (!titleOk || !artistOk) continue;
        const text = parseGeniusLyrics(await getText(r.url));
        if (text) return text;
      }
    }
  } catch (e) {
    if (/\b(429|5\d\d)\b|rete|network|timeout/i.test(String(e))) throw new TransientError(String(e));
    /* anything else: this source simply has nothing */
  }
  return undefined;
}

/**
 * Looks the song up in several sources, best first:
 * LRCLIB with timings (several spellings of artist and title), then plain text from LRCLIB, lyrics.ovh and Genius.
 * Returns null when nothing is found; throws TransientError when a source could not answer (so the caller can retry later instead of giving up).
 */
export async function findLyrics(videoTitle: string, channel: string, durationSec: number, f: typeof fetch = fetch, opts: FetchOpts = {}): Promise<FoundLyrics | null> {
  const names = opts.structured
    ? { artist: splitArtists(channel)[0] ?? channel.trim(), track: cleanTrackTitle(videoTitle) }
    : guessArtistTitle(videoTitle, channel);
  const { artist, track } = names;
  if (!track) return null;
  const allArtists = opts.structured ? splitArtists(channel) : [artist].filter(Boolean);
  const matchArtist = opts.structured ? channel : artist;
  const known = durationSec > 0;
  const diff = (h: ApiHit) => (known ? Math.abs((h.duration ?? 0) - durationSec) : 0);

  const hits: ApiHit[] = [];
  const enc = encodeURIComponent;
  let serverErrors = 0, answers = 0;
  const json = async (url: string) => { const r = await getJson(f, url, () => { serverErrors++; }); answers++; return r; };
  if (known) {
    const exact = await json(`${LRCLIB}/get?artist_name=${enc(artist)}&track_name=${enc(track)}&duration=${Math.round(durationSec)}`);
    if (exact && typeof exact === 'object') hits.push(exact as ApiHit);
  }
  const searches = [
    ...(artist ? [`track_name=${enc(track)}&artist_name=${enc(artist)}`] : []),
    ...[...new Set([`${artist} ${track}`.trim(), track])].map((q) => `q=${enc(q)}`),
  ];
  const usableHits = () => hits.filter((h) => !h.instrumental && sameSong(h, matchArtist, track) && (!known || (typeof h.duration === 'number' && diff(h) <= APPROX_S)));
  for (const qs of searches) {
    if (usableHits().some((h) => asSynced(h).length && diff(h) <= CLOSE_S)) break; // a good timed version is already in hand: spare the free service
    const list = await json(`${LRCLIB}/search?${qs}`);
    if (Array.isArray(list)) hits.push(...(list as ApiHit[]));
  }
  const usable = usableHits();
  const synced = usable.filter((h) => asSynced(h).length).sort((a, b) => diff(a) - diff(b));
  if (synced[0]) return { synced: asSynced(synced[0]), source: 'LRCLIB', approx: known && diff(synced[0]) > CLOSE_S, trackDuration: synced[0].duration };

  const plainHit = usable.filter((h) => h.plainLyrics).sort((a, b) => diff(a) - diff(b))[0];
  if (plainHit?.plainLyrics) return { plain: plainHit.plainLyrics, source: 'LRCLIB', trackDuration: plainHit.duration };
  for (const who of (allArtists.length ? allArtists : [artist]).slice(0, 2)) {
    if (!who) continue;
    const o = await json(`${OVH}/${enc(who)}/${enc(track)}`);
    const text = (o as { lyrics?: unknown } | undefined)?.lyrics;
    if (typeof text === 'string' && text.trim()) return { plain: text, source: 'lyrics.ovh' };
  }
  if (opts.getText) {
    const text = await geniusLyrics(opts.getText, allArtists.length ? allArtists : [artist], track);
    if (text) return { plain: text, source: 'Genius' };
  }
  // A source was busy and nothing else had the song: do not call it "not found", ask to try again later.
  if (serverErrors > 0) throw new TransientError('servizio dei testi occupato');
  return null;
}

/** Lyrics ready to follow the playhead: timed when the source had timings, otherwise spread over the song (estimated). */
export function lyricsFrom(found: FoundLyrics, durationSec: number): Lyrics | null {
  if (found.synced?.length) {
    const approx = !!found.approx || (!!found.trackDuration && durationSec > 0 && Math.abs(found.trackDuration - durationSec) > CLOSE_S);
    return { synced: found.synced, source: found.source, approx, trackDuration: found.trackDuration };
  }
  if (!found.plain) return null;
  const lines = estimateLines(found.plain, durationSec);
  return lines.length ? { synced: lines, plain: found.plain, estimated: true, source: found.source, trackDuration: found.trackDuration } : null;
}

/** Same as findLyrics, but already shaped for playback at the given length. */
export async function fetchLyrics(videoTitle: string, channel: string, durationSec: number, f: typeof fetch = fetch, opts: FetchOpts = {}): Promise<Lyrics | null> {
  try {
    const found = await findLyrics(videoTitle, channel, durationSec, f, opts);
    return found ? lyricsFrom(found, durationSec) : null;
  } catch { return null; }
}

/** Maps video time to song time: songTime = a * position + b. */
export type Align = { a: number; b: number };
export const IDENTITY: Align = { a: 1, b: 0 };

export const toLyricTime = (al: Align, position: number): number => al.a * position + al.b;
export const shiftAlign = (al: Align, delta: number): Align => ({ a: al.a, b: al.b + delta });

/**
 * Builds an alignment from the moments the user marked ("this line (song time t) is being sung now (video time p)").
 * One mark moves the lyrics; two marks at least 5 s apart also fix the speed (karaoke versions are often slower or longer).
 */
export function alignFromAnchors(anchors: { t: number; p: number }[]): Align {
  if (anchors.length === 0) return IDENTITY;
  const sorted = [...anchors].sort((x, y) => x.p - y.p);
  const first = sorted[0], last = sorted[sorted.length - 1];
  if (sorted.length >= 2 && last.p - first.p >= 5) {
    const a = (last.t - first.t) / (last.p - first.p);
    if (a >= 0.5 && a <= 2) return { a, b: first.t - a * first.p };
  }
  return { a: 1, b: last.t - last.p };
}

/** Index of the line being sung at video time `position` under the given alignment (or plain offset). */
export function indexFor(lines: LrcLine[], position: number, align: number | Align = 0): number {
  return typeof align === 'number' ? lineIndexAt(lines, position, align) : lineIndexAt(lines, toLyricTime(align, position));
}

export type LyricsSnapshot = { prev: string; cur: string; next: string };

/** The three lines to display at `position`. A blank current line means an instrumental gap. */
export function snapshotAt(lines: LrcLine[], position: number, align: number | Align = 0): LyricsSnapshot {
  const i = indexFor(lines, position, align);
  const prevLine = [...lines.slice(0, Math.max(0, i))].reverse().find((l) => l.text)?.text ?? '';
  const nextLine = lines.slice(i + 1).find((l) => l.text)?.text ?? '';
  return { prev: prevLine, cur: i >= 0 ? lines[i].text : '', next: nextLine };
}

const KARAOKE = /karaoke|base musicale|instrumental|backing track|\bbasi?\b/i;

/**
 * Karaoke videos open with a title card and a count-in the studio recording does not have, so every lyric would come early.
 * The extra length of the video over the studio track is mostly intro (measured: 22 s extra, ~10 s of it before the first line),
 * so about 45 % of it, within 5-20 s, is used as a starting point. Returns undefined for anything that is not a karaoke.
 */
/**
 * A music video often opens with a scene before the song (Vasco Rossi «Vita spericolata»: 29 s of film, a breath of
 * silence, then the record). Timed lyrics follow the record, so they run ahead. Given the loudness of the file
 * (dB, one value every `step` s), finds the deepest near-silent gap within the first `maxSec` seconds: the song starts
 * where the sound comes back. Undefined when there is no clear gap (then nothing is moved).
 */
export function introEnd(levels: number[], step: number, maxSec: number): number | undefined {
  const last = Math.min(levels.length - 2, Math.floor(maxSec / step));
  const first = Math.ceil(2 / step); // a fade-in at 0 s is not an intro
  if (last <= first) return undefined;
  const sorted = [...levels.slice(0, Math.min(levels.length, last + Math.ceil(20 / step)))].sort((x, y) => x - y);
  const typical = sorted[Math.floor(sorted.length / 2)];
  let best = -1;
  for (let i = first; i <= last; i++) if (best < 0 || levels[i] < levels[best]) best = i;
  if (best < 0 || typical - levels[best] < 12) return undefined; // no real silence: maybe the extra time is at the end
  let j = best;
  while (j < levels.length - 1 && levels[j] < levels[best] + 10) j++; // the song is back
  return Math.round(j * step * 2) / 2;
}

export function karaokeAlign(title: string, videoDuration: number, trackDuration?: number): Align | undefined {
  if (!KARAOKE.test(title)) return undefined;
  const extra = trackDuration && videoDuration > 0 ? videoDuration - trackDuration : 0;
  const intro = Math.min(20, Math.max(5, Math.max(extra, 12) * 0.45));
  return { a: 1, b: -Math.round(intro * 2) / 2 };
}

/** Rough syllable count (vowel groups): sung rhythm follows syllables far better than letters. */
export const syllables = (word: string): number => Math.max(1, (word.match(/[aeiouàèéìíòóùúäöüy]+/gi) ?? []).length);

/**
 * How much of line `i` has been sung at video time `position` (0..1), so the words can be coloured as they go.
 * LRC files only time the start of each line. A sung line fills most of the gap up to the next one, so the gap is used,
 * but never slower than ~2.5 syllables a second: a long gap is an instrumental, not a long note.
 */
export function lineProgress(lines: LrcLine[], position: number, align: Align, i: number): number {
  if (i < 0 || !lines[i]?.text) return 0;
  const t = lines[i].t, gap = (lines[i + 1]?.t ?? t + 8) - t;
  const syl = lines[i].text.split(/\s+/).filter(Boolean).reduce((n, w) => n + syllables(w), 0);
  const span = Math.max(1, Math.min(gap * 0.92, syl / 2.5));
  return Math.min(1, Math.max(0, (toLyricTime(align, position) - t) / span));
}
