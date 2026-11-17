import { buildSongList, type SongVM } from '../src/ui/songList';

const rows: SongVM[] = [
  { id: 'aaaaaaaaaaa', title: 'Just Dance 2026 Edition: Born To Be Alive (Reborn Version) by Patrick Hernandez', artist: 'Ubisoft' },
  { id: 'bbbbbbbbbbb', title: 'Macarena', artist: 'Los del Rio' },
];

function setup(touch: boolean) {
  window.matchMedia = ((q: string) => ({ matches: touch && q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const onMore = vi.fn();
  const sl = buildSongList({ label: 'Coda', onMore, onPlay: vi.fn() });
  sl.list.scrollTopOverride = { get: () => 0, set: () => {} };
  document.body.replaceChildren(sl.el);
  sl.set(rows, 'start');
  const row = (i: number) => [...sl.el.querySelectorAll<HTMLElement>('.item.song')].find((e) => Number(e.dataset.i) === i)!;
  const tap = (i: number) => row(i).querySelector<HTMLElement>('.txt')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { onMore, row, tap };
}

describe('lista sul telefono: primo tocco seleziona e fa scorrere, secondo tocco apre il menu', () => {
  it('telefono', () => {
    const s = setup(true);
    s.tap(0);
    expect(s.onMore).not.toHaveBeenCalled();
    expect(s.row(0).classList.contains('tapped')).toBe(true);
    s.tap(0);
    expect(s.onMore).toHaveBeenCalledTimes(1);
    expect(s.onMore.mock.calls[0][0].id).toBe('aaaaaaaaaaa');
    s.tap(1); // another row: picked, no menu
    expect(s.onMore).toHaveBeenCalledTimes(1);
    expect(s.row(1).classList.contains('tapped')).toBe(true);
    expect(s.row(0).classList.contains('tapped')).toBe(false);
  });
  it('computer (mouse): un clic sulla riga non apre il menu e non la marca', () => {
    const s = setup(false);
    s.tap(0); s.tap(0);
    expect(s.onMore).not.toHaveBeenCalled();
    expect(s.row(0).classList.contains('tapped')).toBe(false);
  });
});
