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
