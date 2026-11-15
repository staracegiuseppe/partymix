/**
 * Commands in Italian, understood by the app itself (no AI, no paid service): a sentence becomes a search on
 * YouTube (or in the library) with clear criteria, and an action on the results.
 *
 *   «cercami i video di Just Dance che piacciono di più ai giovani e sono ballabili e aggiungili alla mia playlist»
 *   → search «just dance» · most viewed · recent · danceable · 15 songs · add to the current playlist
 *
 * The words it knows are listed in WORDS (shown in the Search page), so the user learns what to write.
 */
export type Sort = 'relevance' | 'views' | 'likes' | 'recent';
export type Action = 'search' | 'add' | 'queue' | 'next' | 'play' | 'create';

export type Command = {
  action: Action;
  /** What to search (the words left once the command words are taken away). */
  query: string;
  /** Playlist named in the sentence («a Festa», «nella playlist Karaoke»); `current` = «la mia playlist». */
  target?: string | 'current';
  /** How many songs (default: 15 to add, 10 to queue, 20 for a new playlist). */
  count: number;
  sort: Sort;
  /** Only videos from the last N years. */
  recentYears?: number;
  dance: boolean;
  karaoke: boolean;
  lyrics: boolean;
  official: boolean;
  /** Search in the library and playlists instead of YouTube. */
  library: boolean;
  /** What was understood, in words, to show back to the user. */
  understood: string[];
};

const NUMBERS: Record<string, number> = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, quindici: 15, venti: 20, trenta: 30, quaranta: 40, cinquanta: 50 };

/** The words the app understands, grouped as the Search page shows them. */
export const WORDS: { title: string; words: string[] }[] = [
  { title: 'Cosa fare', words: ['aggiungi a «nome playlist»', 'aggiungili alla mia playlist', 'metti in coda', 'subito dopo', 'suona / riproduci', 'crea la playlist «nome»', 'cerca nella mia musica'] },
  { title: 'Quanti', words: ['10 canzoni', 'venti brani', 'i 15 video'] },
  { title: 'Quali', words: ['più visti / più famosi / che piacciono di più', 'più votati', 'recenti / nuovi / di quest’anno', 'ai giovani (recenti e più visti)', 'ballabili / da ballare', 'karaoke / da cantare', 'con testo / lyrics', 'ufficiali'] },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'");

/** Phrases that only carry the command, taken out of the search words. */
const FILLERS = [
  /\b(vai|andiamo|apri) (su|in) (youtube|you tube)\b/g, /\bsu (youtube|you tube)\b/g, /\bda (youtube|you tube)\b/g,
  /\b(cercami|cerca(mi)?|trovami|trova(mi)?|mostrami|fammi (vedere|sentire)|voglio|vorrei|per favore|grazie)\b/g,
  /\b(e |ed |poi )?(aggiungil[ie]|aggiungi|inseriscil[ie]|inserisci|mettil[ie]|metti)\b/g,
  /\b(che )?(piacciono|piace) (di piu|tanto|molto)( ai giovani| ai ragazzi)?\b/g, /\b(ai giovani|ai ragazzi|dei giovani|per giovani)\b/g,
  /\b(che |e )?(sono|siano) (ballabili|da ballare)\b/g, /\b(ballabili|da ballare|per ballare|ballabile)\b/g,
  /\b(i |le |gli )?(piu (visti|viste|visualizzati|visualizzate|famosi|famose|popolari|ascoltati|ascoltate|amati|amate|belli|belle)|piu votati|con piu like|top|di successo|successi|hit)\b/g,
  /\b(recenti|nuov[ie]|ultim[ie]|di quest'anno|degli ultimi (anni|\d+ anni)|del momento)\b/g,
  /\b(da cantare|con (il )?testo|ufficiali|ufficiale)\b/g,
  /\b(in coda|subito dopo|dopo questa|come prossim[ao]|alla coda)\b/g,
  /\b(nella mia musica|nella libreria|tra i miei brani|nella mia libreria)\b/g,
  /\b(suona|riproduci|fai partire|metti su)\b/g,
];
const STOP = new Set(['i', 'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'di', 'dei', 'delle', 'degli', 'del', 'della', 'e', 'che', 'mi', 'me', 'per', 'con', 'su', 'a', 'al', 'alla', 'video', 'canzoni', 'canzone', 'brani', 'brano', 'pezzi', 'pezzo', 'musica', 'tutti', 'tutte', 'qualche', 'alcuni', 'alcune', 'sono', 'mia', 'mio', 'miei', 'mie', 'anche', 'po', "un'", 'dammi', 'ci', 'ne', 'li', 'le', 'piu', 'molto']);

/** Reads a sentence. Returns undefined for an empty one; plain words (no command) give action «search». */
export function parseCommand(text: string): Command | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  let s = ' ' + norm(raw).replace(/[«»"“”]/g, '"') + ' ';
  const understood: string[] = [];

  // the playlist: «crea la playlist Nome (con …)», «la mia playlist», «a/nella playlist "Nome"», «aggiungi … a Nome»
  let target: string | 'current' | undefined;
  let action: Action = 'search';
  const create = /\bcrea(mi)?( una| la)?( nuova)? playlist( chiamata| di nome| dal nome)? "?([^"]+?)"?(?= con | di | $)/.exec(s);
  if (create) {
    action = 'create';
    target = cleanName(raw, create[5]);
    s = s.replace(create[0], ' ');
  } else {
    const mine = /\b(alla|nella|in|a) (mia|questa) playlist\b/.exec(s);
    const quoted = /\b(a|alla|nella|in|dentro)( playlist)? "([^"]+)"/.exec(s);
    const inPl = /\b(alla|nella|dentro|in) playlist ([^"]+?)\s*$/.exec(s);
    // «aggiungi … a Nome»: the LAST « a »/« in » after the verb (greedy), not «in coda»
    const verb = /\b(aggiungil[ie]|aggiungi|mettil[ie]|metti|inseriscil[ie]|inserisci)\b(.*) (a|in|alla|nella) (?!coda\b|testa\b)([^ ][^"]*?)\s*$/.exec(s);
    if (mine) { target = 'current'; s = s.replace(mine[0], ' '); }
    else if (quoted) { target = cleanName(raw, quoted[3]); s = s.replace(quoted[0], ' '); }
    else if (inPl) { target = cleanName(raw, inPl[2]); s = s.replace(inPl[0], ' '); }
    else if (verb && !/\banni$/.test(verb[2].trim())) { target = cleanName(raw, verb[4]); s = s.slice(0, verb.index) + ' ' + verb[1] + verb[2] + ' '; }
  }

  // the action
  const has = (re: RegExp) => re.test(s);
  if (action !== 'create') {
    if (has(/\b(subito dopo|dopo questa|come prossim[ao])\b/)) action = 'next';
    else if (has(/\b(in coda|alla coda|accoda)\b/)) action = 'queue';
    else if (target || has(/\b(aggiungil[ie]|aggiungi|inseriscil[ie]|inserisci)\b/)) action = 'add';
    else if (has(/\b(suona|riproduci|fai partire|metti su)\b/)) action = 'play';
  }
  if (action === 'add' && !target) target = 'current';

  // which ones
  let sort: Sort = 'relevance';
  let recentYears: number | undefined;
  if (has(/\b(piu (visti|viste|visualizzati|visualizzate|famosi|famose|popolari|ascoltati|ascoltate|amati|amate)|piacciono di piu|piace di piu|di successo|successi|top|hit)\b/)) sort = 'views';
  if (has(/\b(piu votati|con piu like|piu like)\b/)) sort = 'likes';
  const years = /\bultimi (\d+) anni\b/.exec(s);
  if (years) recentYears = Number(years[1]);
  else if (has(/\b(di quest'anno|del momento)\b/)) recentYears = 1;
  else if (has(/\b(recenti|nuov[ie]|ultim[ie]|degli ultimi anni)\b/)) recentYears = 3;
  if (has(/\b(ai giovani|ai ragazzi|dei giovani|per giovani)\b/)) { recentYears ??= 3; if (sort === 'relevance') sort = 'views'; }
  if (recentYears && sort === 'relevance') sort = 'recent';
  const dance = has(/\b(ballabili|ballabile|da ballare|per ballare)\b/) || /\bjust ?dance\b/.test(s);
  const karaoke = has(/\b(karaoke|da cantare)\b/);
  const lyrics = has(/\b(con (il )?testo|lyrics|testo)\b/);
  const official = has(/\b(ufficiali|ufficiale|official)\b/);
  const library = has(/\b(nella mia musica|nella libreria|tra i miei brani|nella mia libreria)\b/);

  // how many
  let count = action === 'create' ? 20 : action === 'queue' ? 10 : action === 'play' || action === 'next' ? 1 : 15;
  const n = /\b(\d{1,3}|un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|quindici|venti|trenta|quaranta|cinquanta) (video|canzoni|canzone|brani|brano|pezzi|risultati|successi|hit)\b/.exec(s);
  if (n) { count = Math.min(200, Math.max(1, Number(n[1]) || NUMBERS[n[1]] || count)); s = s.replace(n[0], ' '); }
  else { const m = /\bi (\d{1,3}) /.exec(s); if (m) { count = Math.min(200, Number(m[1])); s = s.replace(m[0], ' '); } }

  // the search words: what is left
  for (const re of FILLERS) s = s.replace(re, ' ');
  // an English «I» (I Will Survive) is not the Italian article «i»
  const englishI = /(^|\s)I(\s|$)/.test(raw);
  let words = s.replace(/[,.;:!?]/g, ' ').split(/\s+/).filter((w) => w && (!STOP.has(w) || (w === 'i' && englishI)));
  words = words.map((w) => (w === 'justdance' ? 'just dance' : w));
  let query = words.join(' ').trim();
  if (karaoke && !/\bkaraoke\b/.test(query)) query = `${query} karaoke`.trim();
  if (lyrics && !/\b(testo|lyrics)\b/.test(query)) query = `${query} testo`.trim();
  const decade = /\banni (\d0)\b/.exec(norm(raw));
  if (decade && !query.includes('anni')) query = `${query} anni ${decade[1]}`.trim();
  // the original spelling and capitals for the words kept
  query = restoreCase(raw, query);

  understood.push(library ? `cerca «${query}» nella tua musica` : `cerca «${query || '…'}» su YouTube`);
  if (sort === 'views') understood.push('i più visti');
  if (sort === 'likes') understood.push('i più votati');
  if (recentYears) understood.push(recentYears === 1 ? 'di quest’anno' : `degli ultimi ${recentYears} anni`);
  if (dance) understood.push('ballabili');
  if (karaoke) understood.push('karaoke');
  if (lyrics) understood.push('con testo');
  if (official) understood.push('ufficiali');
  if (action !== 'search') understood.push(`${count} ${count === 1 ? 'brano' : 'brani'}`);
  const where = target === 'current' ? 'la playlist in uso' : target ? `«${target}»` : '';
  understood.push(({ search: 'mostra i risultati', add: target === 'current' ? 'aggiungi alla playlist in uso' : `aggiungi a ${where}`, queue: 'metti in coda', next: 'suona subito dopo quello in onda', play: 'suona subito', create: `crea la playlist «${target}»` } as Record<Action, string>)[action]);
  return { action, query, target, count, sort, recentYears, dance, karaoke, lyrics, official, library, understood };
}

/** A name as the user wrote it (capitals kept), found again in the original sentence. */
function cleanName(raw: string, normalized: string): string {
  const n = normalized.trim().replace(/["“”«»]/g, '');
  const i = norm(raw).indexOf(n);
  return (i >= 0 ? raw.slice(i, i + n.length) : n).trim().replace(/[.!?,;]+$/, '');
}
function restoreCase(raw: string, q: string): string {
  const src = raw.split(/\s+/);
  return q.split(' ').map((w) => src.find((x) => norm(x).replace(/[^\w']/g, '') === w)?.replace(/[^\p{L}\p{N}'’&-]/gu, '') || w).join(' ');
}

/** True when the sentence asks for more than a plain search (an action, a number or criteria). */
export const isCommand = (c: Command | undefined): c is Command => !!c && (c.action !== 'search' || c.sort !== 'relevance' || !!c.recentYears || c.dance || c.library);

/** Examples shown in the Search page: a tap writes them in the field. */
export const EXAMPLES = [
  'i video di Just Dance più visti degli ultimi anni, ballabili, aggiungili alla mia playlist',
  'metti in coda 10 canzoni anni 80 da cantare',
  'crea la playlist Matrimonio con 20 canzoni d’amore italiane più famose',
  'aggiungi 15 successi di Max Pezzali con testo a Karaoke',
  'suona Vasco Rossi Albachiara',
  'subito dopo Gloria Gaynor I Will Survive',
  'cerca nella mia musica Jovanotti',
];
