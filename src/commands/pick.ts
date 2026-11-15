import type { SearchHit } from '../ytSearch';
import type { Command } from './parse';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Never what someone asking for songs wants (unless the sentence asks for it). */
const NOT_SONGS = /\b(tutorial|reaction|react|lezione|lesson|behind the scenes|making of|trailer|teaser|intervista|interview|podcast|review|recensione|unboxing|vlog|shorts?|live stream|diretta|1 hour|1 ora|10 hours|compilation|full album|songlist|song list|all songs|tutte le canzoni)\b/;
const DANCE = /\b(just ?dance|dance|danc|remix|party|ballo|balla|coreografia|choreograph|edm|reggaeton|disco|club|hit|summer|estate)\b/;
const SLOW = /\b(acoustic|acustic[ao]|piano|slowed|reverb|lullaby|ninna|sleep|relax|lofi|lo-fi|ballad|lento|unplugged)\b/;
const KARAOKE = /\b(karaoke|base musicale|instrumental|strumentale|sing ?along)\b/;
const LYRICS = /\b(lyrics?|testo|con testo)\b/;
const OFFICIAL = /\b(official|ufficiale)\b/;

/**
 * From the search results to what the command asked: only playable songs, the filters (danceable, karaoke, lyrics,
 * official, recent), the order (most viewed, most liked, newest) and the number. Same song twice → once.
 */
export function pickResults(hits: SearchHit[], c: Command): SearchHit[] {
  const ask = norm(c.query);
  const seen = new Set<string>();
  const scored = hits
    .filter((h) => h.available)
    .filter((h) => {
      const t = norm(`${h.title} ${h.channel}`);
      if (NOT_SONGS.test(t) && !NOT_SONGS.test(ask)) return false;
      if (c.dance && SLOW.test(t)) return false;
      if (c.karaoke && !KARAOKE.test(t)) return false;
      if (c.recentYears && h.ageDays !== undefined && h.ageDays > c.recentYears * 365 + 30) return false;
      if (h.seconds && (h.seconds < 60 || h.seconds > 15 * 60)) return false; // not a song: a spot, or a long mix
      const key = norm(h.title).replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((h, i) => {
      const t = norm(`${h.title} ${h.channel}`);
      let bonus = 0;
      if (c.dance && DANCE.test(t)) bonus += 1;
      if (c.lyrics && LYRICS.test(t)) bonus += 1;
      if (c.official && (OFFICIAL.test(t) || /vevo$|- topic$/.test(norm(h.channel)))) bonus += 1;
      return { h, i, bonus };
    });
  const by: Record<Command['sort'], (a: typeof scored[0], b: typeof scored[0]) => number> = {
    relevance: (a, b) => b.bonus - a.bonus || a.i - b.i,
    views: (a, b) => b.bonus - a.bonus || (b.h.views ?? -1) - (a.h.views ?? -1) || a.i - b.i,
    likes: (a, b) => b.bonus - a.bonus || (b.h.likes ?? b.h.views ?? -1) - (a.h.likes ?? a.h.views ?? -1) || a.i - b.i,
    recent: (a, b) => b.bonus - a.bonus || (a.h.ageDays ?? 1e9) - (b.h.ageDays ?? 1e9) || a.i - b.i,
  };
  return scored.sort(by[c.sort]).slice(0, c.count).map((x) => x.h);
}

/** «1,2 Mln» for the results line. */
export const fmtViews = (n?: number) => (n === undefined ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} Mld` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} Mln` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
