import { describe, expect, it, vi } from 'vitest';
import { KaraokeJob, JobTrack } from '../src/karaokeJob';
import { TransientError } from '../src/lyrics';
import { LyricsStore, NONE_RETRY_MS } from '../src/lyricsStore';

const mem = (): Storage => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage; };
const tr = (id: string): JobTrack => ({ id, title: id, artist: 'x', durationSec: 100, structured: true });
const lrc = { source: 'LRCLIB', synced: [{ t: 1, text: 'a' }, { t: 5, text: 'b' }], trackDuration: 100 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const make = (find: (t: JobTrack) => Promise<any>, store = new LyricsStore(mem())) => {
  const onChange = vi.fn();
  const job = new KaraokeJob({ store, find, onChange, sleep: async () => {}, concurrency: 2 });
  return { job, store, onChange };
};

describe('LyricsStore', () => {
  it('keeps found lyrics between runs, with and without timings', () => {
    const storage = mem();
    const a = new LyricsStore(storage);
    a.setFound('s', lrc); a.setFound('p', { source: 'Genius', plain: 'riga uno\nriga due' });
    a.flush();
    const b = new LyricsStore(storage);
    expect(b.status('s')).toBe('synced');
    expect(b.get('s')?.synced?.[1]).toEqual({ t: 5, text: 'b' });
    expect(b.status('p')).toBe('plain');
    expect(b.get('p')?.plain).toContain('riga due');
    expect(b.status('zzz')).toBeUndefined();
  });
  it('forgets "not found" after a few days so the song is searched again', () => {
    let now = 0;
    const s = new LyricsStore(mem(), () => now);
    s.setNone('x');
    expect(s.status('x')).toBe('none');
    now = NONE_RETRY_MS + 1;
    expect(s.status('x')).toBeUndefined();
  });
  it('survives a broken archive', () => {
    const storage = mem(); storage.setItem('partymix.lyrics.v1', '{broken');
    expect(new LyricsStore(storage).status('a')).toBeUndefined();
  });
});

describe('KaraokeJob', () => {
  it('looks up every song once, in order, and stores what it finds', async () => {
    const seen: string[] = [];
    const { job, store } = make(async (t) => { seen.push(t.id); return t.id === 'b' ? null : lrc; });
    job.start([tr('a'), tr('b'), tr('c')]);
    await flush();
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect([store.status('a'), store.status('b'), store.status('c')]).toEqual(['synced', 'none', 'synced']);
    expect(job.state()).toMatchObject({ running: false, total: 3, done: 3 });
  });
  it('skips songs that are already known, and retries "not found" only when asked', async () => {
    const find = vi.fn(async (_t: JobTrack) => lrc);
    const { job, store } = make(find);
    store.setFound('a', lrc); store.setNone('b');
    job.start([tr('a'), tr('b'), tr('c')]);
    await flush();
    expect(find.mock.calls.map((c) => (c[0] as JobTrack).id)).toEqual(['c']);
    job.start([tr('a'), tr('b'), tr('c')], true);
    await flush();
    expect(find.mock.calls.map((c) => (c[0] as JobTrack).id)).toEqual(['c', 'b']);
    expect(store.status('b')).toBe('synced');
  });
  it('waits and retries when a source is busy, without recording a false "not found"', async () => {
    let n = 0;
    const { job, store } = make(async () => { if (n++ < 2) throw new TransientError('429'); return lrc; });
    job.start([tr('a')]);
    await flush();
    expect(store.status('a')).toBe('synced');
    expect(n).toBe(3);
  });
  it('gives up after a few busy answers but leaves the song to be retried next time', async () => {
    const { job, store } = make(async () => { throw new TransientError('429'); });
    job.start([tr('a')]);
    await flush();
    expect(store.status('a')).toBeUndefined();
    expect(job.state().running).toBe(false);
  });
  it('can be stopped and replaced by a new run', async () => {
    const find = vi.fn(async (t: JobTrack) => { await Promise.resolve(); return lrc; });
    const { job } = make(find);
    job.start([tr('a'), tr('b'), tr('c'), tr('d')]);
    job.stop();
    await flush();
    expect(job.state().running).toBe(false);
    expect(find.mock.calls.length).toBeLessThan(4);
  });
});
