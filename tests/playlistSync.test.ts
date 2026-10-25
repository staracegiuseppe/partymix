import { diffPlaylist } from '../src/playlistSync';
import { Track } from '../src/queue';

const t = (id: string, extra: Partial<Track> = {}): Track => ({ videoId: id, status: 'ok', ...extra });

describe('diffPlaylist', () => {
  it('finds new and removed playlist tracks, keeping the remote order for the new ones', () => {
    const d = diffPlaylist([t('a'), t('b'), t('c')], ['a', 'x', 'c', 'y'], new Set());
    expect(d.added).toEqual(['x', 'y']);
    expect(d.removed).toEqual(['b']);
  });
  it('never removes tracks the user added or replaced by hand', () => {
    const d = diffPlaylist([t('a'), t('m', { manual: true })], ['a'], new Set());
    expect(d.removed).toEqual([]);
  });
  it('does not re-add a track that was replaced on purpose', () => {
    const d = diffPlaylist([t('a'), t('new', { manual: true })], ['a', 'old'], new Set(['old']));
    expect(d.added).toEqual([]);
  });
  it('is a no-op when nothing changed and survives an empty remote answer safely', () => {
    expect(diffPlaylist([t('a')], ['a'], new Set())).toEqual({ added: [], removed: [] });
    // an empty answer (outage, private playlist) must not wipe the queue
    expect(diffPlaylist([t('a'), t('b')], [], new Set())).toEqual({ added: [], removed: [] });
  });
  it('ignores duplicate ids in the remote list', () => {
    expect(diffPlaylist([t('a')], ['a', 'x', 'x'], new Set()).added).toEqual(['x']);
  });
});
