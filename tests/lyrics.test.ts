import { estimateLines, fetchLyrics, guessArtistTitle, lineIndexAt, parseLrc } from '../src/lyrics';

const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);
const route = (map: Record<string, () => Promise<Response>>) =>
  (async (url: string) => { const k = Object.keys(map).find((p) => String(url).includes(p)); return k ? map[k]() : json(404, {}); }) as unknown as typeof fetch;

describe('parseLrc', () => {
  it('reads timestamps with fractions and sorts by time', () => {
    expect(parseLrc('[00:24.60] Seconda\n[00:05.5] Prima')).toEqual([{ t: 5.5, text: 'Prima' }, { t: 24.6, text: 'Seconda' }]);
  });
  it('expands lines that carry several timestamps', () => {
    expect(parseLrc('[00:10.00][01:20.00] Ritornello')).toEqual([{ t: 10, text: 'Ritornello' }, { t: 80, text: 'Ritornello' }]);
  });
  it('ignores metadata tags and handles 3-digit fractions and empty lines', () => {
    const l = parseLrc('[ar:Lunapop]\n[ti:50 Special]\n[00:01.250] a\n[00:03.000] ');
    expect(l).toEqual([{ t: 1.25, text: 'a' }, { t: 3, text: '' }]);
  });
  it('returns nothing for empty or non-LRC text', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('solo testo senza tempi')).toEqual([]);
  });
});

describe('lineIndexAt', () => {
  const lines = [{ t: 10, text: 'a' }, { t: 20, text: 'b' }];
  it('finds the line being sung', () => {
    expect(lineIndexAt(lines, 9.9)).toBe(-1);
    expect(lineIndexAt(lines, 10)).toBe(0);
    expect(lineIndexAt(lines, 25)).toBe(1);
  });
  it('applies the manual offset', () => {
    expect(lineIndexAt(lines, 6, 5)).toBe(0);
    expect(lineIndexAt(lines, 22, -5)).toBe(0);
  });
  it('copes with no lines', () => {
    expect(lineIndexAt([], 50)).toBe(-1);
  });
});

describe('guessArtistTitle', () => {
  it('splits "Artist - Song" and drops decorations', () => {
    expect(guessArtistTitle('Lùnapop - 50 Special (Testo/Lyrics)', '7clouds Italy')).toEqual({ artist: 'Lùnapop', track: '50 Special' });
    expect(guessArtistTitle('Nada - Amore Disperato - 1983', 'Uti')).toEqual({ artist: 'Nada', track: 'Amore Disperato' });
    expect(guessArtistTitle('Vasco Rossi - Albachiara [Official Video HD]', 'x')).toEqual({ artist: 'Vasco Rossi', track: 'Albachiara' });
  });
  it('falls back to the channel name without a dash', () => {
    expect(guessArtistTitle('Albachiara', 'Vasco Rossi - Topic')).toEqual({ artist: 'Vasco Rossi', track: 'Albachiara' });
  });
});

describe('fetchLyrics', () => {
  const synced = { syncedLyrics: '[00:01.00] ciao\n[00:02.00] mondo', plainLyrics: 'ciao\nmondo', duration: 200, instrumental: false };
  it('returns synced lines from the exact match', async () => {
    const r = await fetchLyrics('Lùnapop - 50 Special', 'x', 200, route({ '/api/get': () => json(200, synced) }));
    expect(r?.synced).toEqual([{ t: 1, text: 'ciao' }, { t: 2, text: 'mondo' }]);
  });
  it('falls back to search and picks the closest duration within tolerance', async () => {
    const f = route({
      '/api/get': () => json(404, {}),
      '/api/search': () => json(200, [{ ...synced, duration: 260, syncedLyrics: '[00:09.00] lontano' }, { ...synced, duration: 203 }]),
    });
    const r = await fetchLyrics('A - B', 'x', 200, f);
    expect(r?.synced?.[0].text).toBe('ciao');
  });
  it('rejects results whose duration is far from the video (probably another version)', async () => {
    const f = route({ '/api/get': () => json(404, {}), '/api/search': () => json(200, [{ ...synced, duration: 330 }]) });
    expect(await fetchLyrics('A - B', 'x', 200, f)).toBeNull();
  });
  it('returns plain text when there is no sync, and nothing for instrumentals', async () => {
    const plain = route({ '/api/get': () => json(200, { plainLyrics: 'solo testo', syncedLyrics: null, duration: 200, instrumental: false }) });
    const r = await fetchLyrics('A - B', 'x', 200, plain);
    expect(r?.estimated).toBe(true);
    expect(r?.synced?.map((l) => l.text)).toEqual(['solo testo']);
    const inst = route({ '/api/get': () => json(200, { instrumental: true, duration: 200 }) });
    expect(await fetchLyrics('A - B', 'x', 200, inst)).toBeNull();
  });
  it('never throws on network failure', async () => {
    const f = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await fetchLyrics('A - B', 'x', 200, f)).toBeNull();
  });
});

import { snapshotAt } from '../src/lyrics';

describe('snapshotAt', () => {
  const lines = [{ t: 5, text: 'uno' }, { t: 10, text: 'due' }, { t: 15, text: 'tre' }];
  it('returns the previous, current and next line', () => {
    expect(snapshotAt(lines, 11)).toEqual({ prev: 'uno', cur: 'due', next: 'tre' });
  });
  it('shows only the first line ahead of the song start and nothing at the end beyond the last', () => {
    expect(snapshotAt(lines, 1)).toEqual({ prev: '', cur: '', next: 'uno' });
    expect(snapshotAt(lines, 99)).toEqual({ prev: 'due', cur: 'tre', next: '' });
  });
  it('skips empty instrumental gaps when choosing the next line to show', () => {
    const gap = [{ t: 5, text: 'uno' }, { t: 8, text: '' }, { t: 20, text: 'due' }];
    expect(snapshotAt(gap, 9)).toEqual({ prev: 'uno', cur: '', next: 'due' });
  });
});

describe('fetchLyrics: more sources and tolerance', () => {
  const hit = (duration: number, extra = {}) => ({ syncedLyrics: '[00:01.00] ciao', plainLyrics: 'ciao', duration, instrumental: false, ...extra });
  it('accepts a synced version with a different length but marks it approximate', async () => {
    const f = route({ '/api/get': () => json(404, {}), '/api/search': () => json(200, [hit(222)]) });
    const r = await fetchLyrics('El Alfa - 4K (Letra/Lyrics)', 'x', 205, f);
    expect(r?.synced?.[0].text).toBe('ciao');
    expect(r?.approx).toBe(true);
    expect(r?.source).toBe('LRCLIB');
  });
  it('does not mark a close version as approximate', async () => {
    const f = route({ '/api/get': () => json(404, {}), '/api/search': () => json(200, [hit(203)]) });
    expect((await fetchLyrics('A - B', 'x', 200, f))?.approx).toBeFalsy();
  });
  it('rejects versions that are far too different', async () => {
    const f = route({ '/api/get': () => json(404, {}), '/api/search': () => json(200, [hit(330)]), 'lyrics.ovh': () => json(404, {}) });
    expect(await fetchLyrics('A - B', 'x', 200, f)).toBeNull();
  });
  it('falls back to lyrics.ovh and spreads the plain text over the song as estimated lines', async () => {
    const f = route({
      '/api/get': () => json(404, {}), '/api/search': () => json(200, []),
      'lyrics.ovh': () => json(200, { lyrics: '[El Alfa]\nPrr, yao\n\nSegunda línea\n[Coro]\nTercera' }),
    });
    const r = await fetchLyrics('El Alfa - 4K', 'x', 200, f);
    expect(r?.source).toBe('lyrics.ovh');
    expect(r?.estimated).toBe(true);
    expect(r?.synced?.map((l) => l.text)).toEqual(['Prr, yao', 'Segunda línea', 'Tercera']);
  });
  it('tries the track alone when the artist guess finds nothing', async () => {
    const f = ((async (url: string) => {
      const u = decodeURIComponent(String(url));
      if (u.includes('/api/search') && u.includes('q=4K') && !u.includes('Alfa')) return json(200, [hit(200)]);
      return json(404, {});
    }) as unknown) as typeof fetch;
    const r = await fetchLyrics('Canale Strano - 4K', 'x', 200, f);
    expect(r?.synced?.[0].text).toBe('ciao');
  });
  it('survives non-array search answers', async () => {
    const f = route({ '/api/get': () => json(404, {}), '/api/search': () => json(200, {}), 'lyrics.ovh': () => json(404, {}) });
    expect(await fetchLyrics('A - B', 'x', 200, f)).toBeNull();
  });
});

describe('estimateLines', () => {
  it('spreads lines inside the song, in order, weighted by length', () => {
    const l = estimateLines('corta\nuna riga molto più lunga della prima\nfine', 200);
    expect(l).toHaveLength(3);
    expect(l[0].t).toBeGreaterThan(0);
    expect(l[2].t).toBeLessThan(200);
    expect(l[0].t).toBeLessThan(l[1].t);
    expect(l[1].t).toBeLessThan(l[2].t);
  });
  it('drops [section] tags and blank lines, and handles empty text', () => {
    expect(estimateLines('[Verso 1]\n\nciao\n[Coro]', 100).map((x) => x.text)).toEqual(['ciao']);
    expect(estimateLines('', 100)).toEqual([]);
    expect(estimateLines('ciao', 0)).toEqual([]);
  });
});

import { alignFromAnchors, IDENTITY, shiftAlign, toLyricTime } from '../src/lyrics';

describe('alignment of lyrics to a different version', () => {
  it('is the identity with no anchors', () => {
    expect(alignFromAnchors([])).toEqual(IDENTITY);
    expect(toLyricTime(IDENTITY, 12)).toBe(12);
  });
  it('one anchor moves the lyrics: line at 20 s is sung at 35 s of the video', () => {
    const al = alignFromAnchors([{ t: 20, p: 35 }]);
    expect(al).toEqual({ a: 1, b: -15 });
    expect(toLyricTime(al, 35)).toBe(20);
    expect(toLyricTime(al, 45)).toBe(30);
  });
  it('two anchors also fix the speed: both lines land exactly where they were marked', () => {
    // original: line at 10 s and at 100 s; in the karaoke they are heard at 30 s and 150 s
    const al = alignFromAnchors([{ t: 10, p: 30 }, { t: 100, p: 150 }]);
    expect(toLyricTime(al, 30)).toBeCloseTo(10, 6);
    expect(toLyricTime(al, 150)).toBeCloseTo(100, 6);
    expect(al.a).toBeCloseTo(0.75, 6);
  });
  it('uses the earliest and the latest anchor even if they were given out of order', () => {
    const al = alignFromAnchors([{ t: 100, p: 150 }, { t: 10, p: 30 }, { t: 50, p: 90 }]);
    expect(toLyricTime(al, 30)).toBeCloseTo(10, 6);
    expect(toLyricTime(al, 150)).toBeCloseTo(100, 6);
  });
  it('falls back to a plain shift when two anchors are almost at the same moment or imply an absurd speed', () => {
    expect(alignFromAnchors([{ t: 10, p: 30 }, { t: 90, p: 31 }])).toEqual({ a: 1, b: 90 - 31 });
    expect(alignFromAnchors([{ t: 10, p: 30 }, { t: 12, p: 130 }]).a).toBe(1);
  });
  it('shiftAlign nudges the offset without touching the speed', () => {
    expect(shiftAlign({ a: 0.75, b: 3 }, 0.5)).toEqual({ a: 0.75, b: 3.5 });
  });
  it('snapshotAt follows an alignment', () => {
    const lines = [{ t: 10, text: 'uno' }, { t: 20, text: 'due' }];
    const al = alignFromAnchors([{ t: 10, p: 40 }]);
    expect(snapshotAt(lines, 41, al).cur).toBe('uno');
    expect(snapshotAt(lines, 51, al).cur).toBe('due');
  });
});
