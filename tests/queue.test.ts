import { Queue, Track } from '../src/queue';

const t = (id: string, extra: Partial<Track> = {}): Track => ({ videoId: id, status: 'ok', ...extra });
const ids = (xs: (Track | undefined)[]) => xs.map((x) => x?.videoId);

describe('Queue', () => {
  it('starts on the first playable track and records history', () => {
    const q = new Queue([t('a', { status: 'unplayable' }), t('b'), t('c')]);
    expect(q.current()?.videoId).toBe('b');
    expect(ids(q.history())).toEqual(['b']);
  });
  it('advance skips unplayable tracks', () => {
    const q = new Queue([t('a'), t('b', { status: 'unplayable' }), t('c')]);
    expect(q.peekNext()?.videoId).toBe('c');
    expect(q.advance()?.videoId).toBe('c');
    expect(ids(q.history())).toEqual(['a', 'c']);
  });
  it('ends with undefined when repeat is off', () => {
    const q = new Queue([t('a')]);
    expect(q.advance()).toBeUndefined();
  });
  it('repeat all wraps around', () => {
    const q = new Queue([t('a'), t('b')], { repeat: 'all' });
    q.advance();
    expect(q.advance()?.videoId).toBe('a');
  });
  it('repeat one keeps the same track', () => {
    const q = new Queue([t('a'), t('b')], { repeat: 'one' });
    expect(q.advance()?.videoId).toBe('a');
  });
  it('does not loop forever when every track is unplayable', () => {
    const q = new Queue([t('a', { status: 'unplayable' }), t('b', { status: 'unplayable' })], { repeat: 'all' });
    expect(q.current()).toBeUndefined();
    expect(q.advance()).toBeUndefined();
    expect(q.peekNext()).toBeUndefined();
  });
  it('a single-track playlist with repeat all keeps playing it', () => {
    const q = new Queue([t('a')], { repeat: 'all' });
    expect(q.advance()?.videoId).toBe('a');
  });
  it('markUnplayable makes a later track be skipped', () => {
    const q = new Queue([t('a'), t('b'), t('c')]);
    q.markUnplayable('b');
    expect(q.advance()?.videoId).toBe('c');
  });
  it('skipNext does not skip a locked track but advance does', () => {
    const q = new Queue([t('a'), t('b')]);
    q.setLocked('a', true);
    expect(q.skipNext()?.videoId).toBe('a');
    expect(q.advance()?.videoId).toBe('b');
  });
  it('shuffle is deterministic with a fixed rng and keeps all tracks', () => {
    const mk = () => new Queue([t('a'), t('b'), t('c'), t('d')], { shuffle: true, rng: () => 0 });
    expect(ids(mk().all())).toEqual(ids(mk().all()));
    expect(ids(mk().all()).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('move reorders and keeps the current track', () => {
    const q = new Queue([t('a'), t('b'), t('c')]);
    q.move(2, 0);
    expect(ids(q.all())).toEqual(['c', 'a', 'b']);
    expect(q.current()?.videoId).toBe('a');
  });
  it('add to an empty queue makes the new track current', () => {
    const q = new Queue([]);
    q.add(t('z'));
    expect(q.current()?.videoId).toBe('z');
  });
  it('reset returns to the first playable track and clears history', () => {
    const q = new Queue([t('a'), t('b')]);
    q.advance();
    q.reset();
    expect(q.current()?.videoId).toBe('a');
    expect(ids(q.history())).toEqual(['a']);
  });
});

describe('Queue extras', () => {
  it('replace swaps a track in place and keeps the position', () => {
    const q = new Queue([t('a'), t('b', { status: 'unplayable' }), t('c')]);
    q.replace('b', t('z'));
    expect(ids(q.all())).toEqual(['a', 'z', 'c']);
    expect(q.advance()?.videoId).toBe('z');
  });
  it('setRepeat changes behaviour at the end', () => {
    const q = new Queue([t('a')]);
    q.setRepeat('all');
    expect(q.advance()?.videoId).toBe('a');
  });
  it('shuffleUpcoming leaves played and current tracks where they are', () => {
    const q = new Queue([t('a'), t('b'), t('c'), t('d')]);
    q.advance();
    q.shuffleUpcoming(() => 0);
    expect(ids(q.all()).slice(0, 2)).toEqual(['a', 'b']);
    expect(ids(q.all()).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('currentIndex points at the playing track', () => {
    const q = new Queue([t('a'), t('b')]);
    q.advance();
    expect(q.currentIndex()).toBe(1);
  });
});

describe('Queue.advanceTo', () => {
  it('jumps to the named track even if it is not next', () => {
    const q = new Queue([t('a'), t('b'), t('c')]);
    expect(q.advanceTo('c')?.videoId).toBe('c');
    expect(q.current()?.videoId).toBe('c');
    expect(ids(q.history())).toEqual(['a', 'c']);
  });
  it('falls back to advance when the track is gone', () => {
    const q = new Queue([t('a'), t('b')]);
    expect(q.advanceTo('zzz')?.videoId).toBe('b');
  });
});

describe('Queue.remove', () => {
  it('removes an upcoming track and keeps the current one', () => {
    const q = new Queue([t('a'), t('b'), t('c')]);
    expect(q.remove('b')).toBe(true);
    expect(ids(q.all())).toEqual(['a', 'c']);
    expect(q.advance()?.videoId).toBe('c');
  });
  it('removing a played track keeps the current position', () => {
    const q = new Queue([t('a'), t('b'), t('c')]);
    q.advance(); q.advance();
    q.remove('a');
    expect(q.current()?.videoId).toBe('c');
    expect(q.currentIndex()).toBe(1);
  });
  it('refuses to remove the track that is playing', () => {
    const q = new Queue([t('a'), t('b')]);
    expect(q.remove('a')).toBe(false);
    expect(ids(q.all())).toEqual(['a', 'b']);
  });
  it('returns false for unknown ids', () => {
    expect(new Queue([t('a')]).remove('zzz')).toBe(false);
  });
});

describe('cueNext and setCurrent', () => {
  const mk = (ids: string[]) => new Queue(ids.map((videoId) => ({ videoId, status: 'ok' as const })));
  it('cueNext moves a track right after the current one and makes it next', () => {
    const q = mk(['A', 'B', 'C', 'D']);
    expect(q.cueNext('D')).toBe(true);
    expect(q.all().map((t) => t.videoId)).toEqual(['A', 'D', 'B', 'C']);
    expect(q.peekNext()?.videoId).toBe('D');
    expect(q.current()?.videoId).toBe('A');
  });
  it('cueNext beats repeat-one once, then the normal order resumes', () => {
    const q = mk(['A', 'B', 'C']);
    q.setRepeat('one');
    q.cueNext('C');
    expect(q.advance()?.videoId).toBe('C');
    expect(q.peekNext()?.videoId).toBe('C'); // repeat-one again
  });
  it('cueNext refuses the current or an unplayable track', () => {
    const q = mk(['A', 'B', 'C']);
    q.markUnplayable('C');
    expect(q.cueNext('A')).toBe(false);
    expect(q.cueNext('C')).toBe(false);
    expect(q.cueNext('zzz')).toBe(false);
  });
  it('cueNext works for a track that is before the current one', () => {
    const q = mk(['A', 'B', 'C']);
    q.advance(); q.advance();
    expect(q.cueNext('A')).toBe(true);
    expect(q.current()?.videoId).toBe('C');
    expect(q.peekNext()?.videoId).toBe('A');
  });
  it('setCurrent starts from the picked track', () => {
    const q = mk(['A', 'B', 'C']);
    expect(q.setCurrent('C')).toBe(true);
    expect(q.current()?.videoId).toBe('C');
    expect(q.setCurrent('zzz')).toBe(false);
  });
});

describe('the same video twice in a playlist', () => {
  const mk = (ids: string[]) => new Queue(ids.map((videoId) => ({ videoId, status: 'ok' as const })));
  it('moves on to the next occurrence instead of going back to the first one', () => {
    const q = mk(['A', 'X', 'X', 'B']);
    q.advance();                     // X (first)
    expect(q.currentIndex()).toBe(1);
    q.advanceTo('X');                // X (second)
    expect(q.currentIndex()).toBe(2);
    q.advanceTo('B');
    expect(q.currentIndex()).toBe(3);
  });
  it('does not loop between the two copies', () => {
    const q = mk(['X', 'X', 'B']);
    const seen: number[] = [q.currentIndex()];
    for (const id of ['X', 'B']) { q.advanceTo(id); seen.push(q.currentIndex()); }
    expect(seen).toEqual([0, 1, 2]);
  });
  it('still finds a track that was moved before the current one', () => {
    const q = mk(['A', 'B', 'C']);
    q.advance(); q.advance();
    expect(q.advanceTo('A')?.videoId).toBe('A');
  });
});
