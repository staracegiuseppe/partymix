import { buildSongList, SongVM } from './songList';

/** One song of the queue as the computer shows it (same shape as every song list). */
export type QueueRowVM = SongVM;

export type QueueListActions = {
  playNow(id: string): void;
  move(from: number, to: number): void;
  toggleLock(id: string): void;
  removeTrack(id: string): void;
  toggleFavorite?(id: string): void;
  makeOffline?(id: string): void;
  /** ⋮ on a song (computer: the song's menu). */
  songMenu?(r: QueueRowVM, i: number, anchor: HTMLElement): void;
};

export const ROW_H = 56;
const SCROLL_KEY = 'partymix.scroll';

/**
 * The play queue of the computer: a finite list with its head and tail, drag & drop by the ⋮⋮ grip,
 * double click (or ▶) to play, ⋮ for the other actions. The scroll position is remembered for each playlist.
 */
export function buildQueueList(a: QueueListActions, store?: Storage, endNote?: () => string) {
  let key: string | undefined;
  const saved: Record<string, { index: number; offset: number }> = (() => { try { return JSON.parse(store?.getItem(SCROLL_KEY) ?? '{}') ?? {}; } catch { return {}; } })();
  const persist = () => { try { store?.setItem(SCROLL_KEY, JSON.stringify(saved)); } catch { /* not important */ } };
  const sl = buildSongList({
    label: 'Lista di riproduzione',
    reorder: (from, to) => a.move(from, to),
    onPlay: (r) => a.playNow(r.id),
    onMore: (r, i, anchor) => a.songMenu?.(r, i, anchor),
    endLabel: 'Fine della lista di riproduzione',
    endNote,
    dragToPlaylists: true,
  });

  /** New rows. A different `k` (another playlist) saves where the old one was and goes back to where the new one was left. */
  function setRows(next: QueueRowVM[], k?: string) {
    const other = k !== key;
    if (other && key !== undefined && sl.rows().length) { saved[key] = sl.list.topIndex(); persist(); }
    if (other) { key = k; sl.set(next, (k && saved[k]) || 'start'); } else sl.set(next, 'keep');
  }
  function remember() { if (key !== undefined && sl.rows().length) { saved[key] = sl.list.topIndex(); persist(); } }
  function showCurrent() { const i = sl.rows().findIndex((r) => r.current); if (i >= 0) sl.list.scrollToIndex(i, 'center'); }
  return { el: sl.el, list: sl.list, setRows, remember, showCurrent, rows: sl.rows, setHead: sl.setHead, refreshEnds: sl.refreshEnds };
}
