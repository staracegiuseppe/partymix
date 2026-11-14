import { MemoryKV } from '../src/library/kv';
import { migrateLegacy, PlaylistStore } from '../src/library/playlists';
import { saveSaved } from '../src/savedPlaylists';
import { DEFAULT_SETTINGS, Settings } from '../src/settings';
import type { Track } from '../src/queue';

const tr = (id: string, title = id): Track => ({ videoId: id, title, status: 'ok' });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `vid${String(i).padStart(5, '0')}`);
let clock = 1000;
const make = (kv = new MemoryKV()) => { let n = 0; return { kv, s: new PlaylistStore(kv, { now: () => ++clock, newId: () => `p${++n}`, saveDelayMs: 0 }) }; };
const memStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage; };

describe('playlists: no fixed slots, no limit', () => {
  it('creates a playlist with id, name, tracks, dates and order', () => {
    const { s } = make();
    const p = s.create('Festa');
    expect(p).toMatchObject({ name: 'Festa', tracks: [], sortOrder: 0 });
    expect(p.id).toBeTruthy();
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.updatedAt).toBe(p.createdAt);
  });
  it('gives free «Playlist N» names when none is given', () => {
    const { s } = make();
    expect([s.create().name, s.create().name, s.create().name]).toEqual(['Playlist 1', 'Playlist 2', 'Playlist 3']);
  });
  for (const n of [4, 5, 10, 100, 250]) {
    it(`keeps ${n} playlists (the old limit was 4)`, async () => {
      const { s, kv } = make();
      for (let i = 0; i < n; i++) s.create(`Lista ${i + 1}`, { tracks: [tr(`video${String(i).padStart(4, '0')}`)] });
      await s.flush();
      const again = new PlaylistStore(kv);
      await again.load();
      expect(again.count()).toBe(n);
      expect(again.list().map((p) => p.name)).toEqual(Array.from({ length: n }, (_, i) => `Lista ${i + 1}`));
    });
  }
  it('saves and loads a playlist of 10 000 songs in order (no 1000-song cap)', async () => {
    const { s, kv } = make();
    const p = s.create('Enorme', { tracks: ids(10_000).map((id) => tr(id)) });
    await s.flush();
    const again = new PlaylistStore(kv);
    await again.load();
    const q = again.get(p.id)!;
    expect(q.tracks).toHaveLength(10_000);
    expect(q.tracks[0].videoId).toBe('vid00000');
    expect(q.tracks[9999].videoId).toBe('vid09999');
  });
  it('renames (empty names refused) and updates the date', () => {
    const { s } = make();
    const p = s.create('Vecchio');
    const before = p.updatedAt;
    expect(s.rename(p.id, '  Nuovo nome  ')).toBe(true);
    expect(s.get(p.id)!.name).toBe('Nuovo nome');
    expect(s.get(p.id)!.updatedAt).toBeGreaterThan(before);
    expect(s.rename(p.id, '   ')).toBe(false);
    expect(s.get(p.id)!.name).toBe('Nuovo nome');
  });
  it('deletes a playlist, also from the disk', async () => {
    const { s, kv } = make();
    const a = s.create('A'), b = s.create('B');
    await s.flush();
    expect(s.remove(a.id)).toBe(true);
    await s.flush();
    const again = new PlaylistStore(kv);
    await again.load();
    expect(again.list().map((p) => p.id)).toEqual([b.id]);
    expect(s.remove('missing')).toBe(false);
  });
  it('duplicates a playlist right after the original, songs copied (not shared)', () => {
    const { s } = make();
    const a = s.create('A', { tracks: [tr('aaaaaaaaaaa')] }); s.create('B');
    const c = s.duplicate(a.id)!;
    expect(c.name).toBe('A (copia)');
    expect(s.list().map((p) => p.name)).toEqual(['A', 'A (copia)', 'B']);
    c.tracks[0].title = 'cambiato';
    expect(s.get(a.id)!.tracks[0].title).toBe('aaaaaaaaaaa');
  });
  it('adds songs once only and reports duplicates', () => {
    const { s } = make();
    const p = s.create('A', { tracks: [tr('aaaaaaaaaaa')] });
    expect(s.addTracks(p.id, [tr('aaaaaaaaaaa'), tr('bbbbbbbbbbb'), tr('bbbbbbbbbbb')])).toEqual({ added: 1, duplicates: 2 });
    expect(s.get(p.id)!.tracks.map((t) => t.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });
  it('removes and moves songs (drag & drop order is kept)', () => {
    const { s } = make();
    const p = s.create('A', { tracks: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((x) => tr(x)) });
    expect(s.moveTrack(p.id, 0, 2)).toBe(true);
    expect(s.get(p.id)!.tracks.map((t) => t.videoId[0])).toEqual(['b', 'c', 'a']);
    expect(s.removeTrack(p.id, 'ccccccccccc')).toBe(true);
    expect(s.get(p.id)!.tracks.map((t) => t.videoId[0])).toEqual(['b', 'a']);
  });
  it('local library songs can be in a playlist', () => {
    const { s } = make();
    const p = s.create('Mix', { tracks: [tr('local:0123456789abcdef'), tr('dQw4w9WgXcQ')] });
    expect(s.get(p.id)!.tracks).toHaveLength(2);
  });
  it('searches (accents ignored) and sorts by name, size, recent and the user order', () => {
    const { s } = make();
    const a = s.create('Zumba', { tracks: [tr('aaaaaaaaaaa')] });
    const b = s.create('Àperitivo', { tracks: [tr('aaaaaaaaaaa'), tr('bbbbbbbbbbb')] });
    const c = s.create('Matrimonio');
    expect(s.list('custom', 'aper').map((p) => p.id)).toEqual([b.id]);
    expect(s.list('name').map((p) => p.id)).toEqual([b.id, c.id, a.id]);
    expect(s.list('size').map((p) => p.id)).toEqual([b.id, a.id, c.id]);
    s.rename(a.id, 'Zumba!');
    expect(s.list('recent')[0].id).toBe(a.id);
    s.reorder([c.id, a.id, b.id]);
    expect(s.list('custom').map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });
  it('writes several quick changes once, later (debounced)', async () => {
    const kv = new MemoryKV();
    const put = vi.spyOn(kv, 'put');
    const s = new PlaylistStore(kv, { saveDelayMs: 50 });
    const p = s.create('A');
    for (let i = 0; i < 20; i++) s.addTracks(p.id, [tr(`video${String(i).padStart(4, '0')}`)]);
    expect(put).not.toHaveBeenCalled();
    await s.flush();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('moving the four old playlists into the new store', () => {
  it('keeps names, links, songs and the one in use', () => {
    const ls = memStorage();
    saveSaved(ls, 0, { name: 'Festa', link: 'L1', source: 'YouTube', tracks: [tr('aaaaaaaaaaa')], removed: ['zzzzzzzzzzz'] });
    saveSaved(ls, 2, { name: '', link: 'L3', source: 'Spotify', tracks: [tr('bbbbbbbbbbb'), tr('ccccccccccc')] });
    const settings: Settings = { ...DEFAULT_SETTINGS, playlists: ['L1', '', 'L3', 'L4'], playlistNames: ['', '', 'Karaoke', ''], playlistSlot: 2 };
    const { s } = make();
    const cur = migrateLegacy(s, settings, ls)!;
    expect(s.list().map((p) => [p.name, p.link, p.tracks.length])).toEqual([['Festa', 'L1', 1], ['Karaoke', 'L3', 2], ['Playlist 4', 'L4', 0]]);
    expect(s.get(cur)!.name).toBe('Karaoke');
    expect(s.list()[0].removed).toEqual(['zzzzzzzzzzz']);
    expect(migrateLegacy(s, settings, ls)).toBeUndefined(); // only once
  });
});
