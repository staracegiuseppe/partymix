import { fmtTime, h } from './dom';
import { VirtualList } from './virtualList';
import type { OfflineState } from '../library/library';

/** One song as every list of the app shows it (queue, playlist, library, search). */
export type SongVM = {
  id: string; title: string; artist: string;
  /** Second line instead of the artist (e.g. «Artista · Album · 📂 Festa»). */
  sub?: string;
  bad?: boolean; locked?: boolean; current?: boolean;
  lyr?: 'synced' | 'plain' | 'none';
  /** ☁ online only, ✓ on this computer, ⬇ being saved, ⚠ problem, ⏳ waiting to download. */
  off?: OfflineState | 'queued';
  /** 0…1 while being saved. */
  pct?: number;
  fav?: boolean;
  dur?: number;
  /** The song on air is paused. */
  paused?: boolean;
  /** Offline and no local copy (or not playable): skipped. */
  skip?: boolean;
  /** Small picture (search results, library). */
  thumb?: string;
  /** Why it cannot be played (search results). */
  reason?: string;
};

export type SongListOpts = {
  /** Name of the list for screen readers. */
  label: string;
  rowHeight?: number;
  cover?: boolean;
  /** Drag & drop by the ⋮⋮ grip (playlists and queue). */
  reorder?: (from: number, to: number) => void;
  /** ▶ on the row, double click (and Enter). Not called for songs that cannot be played now. */
  onPlay?: (r: SongVM, i: number) => void;
  /** ⋮ on the row (and a tap on touch screens): the song's menu. */
  onMore: (r: SongVM, i: number, anchor: HTMLElement) => void;
  /** The head of the list: shown above the first song. */
  head?: boolean;
  /** Words of the tail: «Fine playlist», «Fine dei risultati»… */
  endLabel?: string;
  /** Extra words under the tail (e.g. what Ripeti will do). */
  endNote?: () => string;
  empty?: HTMLElement;
  /** A drag of a song can be dropped on a playlist (sets the song id on the drag). */
  dragToPlaylists?: boolean;
};

export const STATE: Record<NonNullable<SongVM['off']>, [string, string, string]> = {
  offline: ['✓', 'Offline', 'Disponibile offline: suona anche senza rete'],
  online: ['☁', 'Online', 'Solo online: serve la rete'],
  downloading: ['⬇', 'Download', 'Download in corso'],
  queued: ['⏳', 'In coda', 'In attesa di essere scaricato'],
  error: ['⚠', 'Errore', 'Problema con il file'],
};
const touch = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
const plural = (n: number, a: string, b: string) => `${n.toLocaleString('it-IT')} ${n === 1 ? a : b}`;

/**
 * SongRow + SongList: a finite list of songs with its head («12 brani») and its tail («■ Fine playlist», «↑ Torna all'inizio»),
 * virtual (a few dozen rows in the page whatever the length), with state icons that also have words (not only colours).
 */
export function buildSongList(o: SongListOpts) {
  let rows: SongVM[] = [];
  let dragFrom = -1;
  const headTitle = h('span', { class: 'sl-title' });
  const headSub = h('span', { class: 'sl-sub' });
  const headEl = h('div', { class: 'sl-head', role: 'presentation' }, h('span', { class: 'sl-cap' }, '▲ Inizio'), headTitle, headSub);
  const endText = h('div', { class: 'sl-end-t' });
  const endNote = h('div', { class: 'sl-end-n' });
  const toTop = h('button', { class: 'm-text-btn', type: 'button', onClick: () => list.scrollToStart() }, '↑ Torna all’inizio');
  const footEl = h('div', { class: 'sl-foot', role: 'presentation' }, h('div', {}, endText, endNote), toTop);
  const rowH = o.rowHeight ?? 56;

  const list: VirtualList<SongVM> = new VirtualList<SongVM>({
    rowHeight: rowH,
    overscan: 8,
    className: 'songlist' + (o.cover ? ' with-cover' : '') + (o.reorder ? ' reorder' : ''),
    dragScroll: true,
    noDragSelector: 'button, .grip, .cover, input',
    header: o.head === false ? undefined : { el: headEl, height: 44 },
    footer: { el: footEl, height: 76 },
    create() {
      const btn = (cls: string, label: string, title: string) => h('button', { class: cls, type: 'button', title, 'aria-label': title }, label);
      return h('div', { class: 'item song', role: 'listitem', tabindex: '-1' },
        o.reorder ? h('span', { class: 'grip', draggable: 'true', title: 'Trascina per cambiare ordine', 'aria-hidden': 'true' }, '⋮⋮') : null,
        h('span', { class: 'lead' }),
        o.cover ? h('span', { class: 'cover', draggable: o.dragToPlaylists ? 'true' : 'false' }, h('img', { alt: '', loading: 'lazy', decoding: 'async' })) : null,
        h('span', { class: 'txt' }, h('span', { class: 't' }), h('span', { class: 's' })),
        h('span', { class: 'dur' }),
        h('span', { class: 'st' }),
        btn('play icon-btn', '▶', 'Suona adesso'),
        btn('more icon-btn', '⋮', 'Altre azioni'));
    },
    paint(el, r, i) {
      const q = (s: string) => el.querySelector(s) as HTMLElement;
      el.className = 'item song' + (r.current ? ' cur' : '') + (r.bad ? ' bad' : '') + (r.skip ? ' skip' : '');
      el.setAttribute('aria-label', `${i + 1}. ${r.title}${r.artist ? `, ${r.artist}` : ''}${r.current ? (r.paused ? ', in pausa' : ', in riproduzione') : ''}`);
      el.title = r.skip ? (r.reason ?? 'Non si può riprodurre adesso (sei offline e il brano è solo online).') : '';
      const lead = q('.lead');
      lead.textContent = r.current ? (r.paused ? '⏸' : '▶') : String(i + 1);
      lead.classList.toggle('now', !!r.current);
      lead.title = r.current ? (r.paused ? 'In pausa' : 'In riproduzione') : `Brano ${i + 1}`;
      const img = el.querySelector('img');
      if (img) { const src = r.thumb ?? ''; if (img.getAttribute('src') !== src) { if (src) img.src = src; else img.removeAttribute('src'); } }
      const tags = [r.current ? ['tag on', r.paused ? 'in pausa' : 'in onda'] : null, r.locked ? ['tag', 'bloccato'] : null,
        r.lyr === 'none' ? ['tag', 'senza testo'] : r.lyr === 'plain' ? ['tag soft', 'testo stimato'] : r.lyr === 'synced' ? ['tag ok', 'testo a tempo'] : null,
        r.bad ? ['tag', 'non riproducibile'] : null, r.fav ? ['tag fav', '♥'] : null].filter((x): x is string[] => !!x);
      q('.t').replaceChildren(r.title, ...tags.map(([c, s]) => h('span', { class: c }, s)));
      q('.s').textContent = r.sub ?? r.artist;
      q('.dur').textContent = r.dur ? fmtTime(r.dur) : '';
      const st = q('.st');
      if (r.off) {
        const [ic, word, tip] = STATE[r.off];
        st.textContent = r.off === 'downloading' && r.pct !== undefined ? `${ic} ${Math.round(r.pct * 100)}%` : `${ic} ${word}`;
        st.title = r.reason ?? tip;
        st.className = `st ${r.off}`;
      } else { st.textContent = ''; st.className = 'st'; }
      (q('.play') as HTMLButtonElement).disabled = !!r.bad || !!r.current || !!r.skip || !o.onPlay;
      (q('.play') as HTMLButtonElement).hidden = !o.onPlay;
      if (el.querySelector('.cover')) (q('.cover') as HTMLElement).dataset.id = r.id;
    },
  });

  const el = list.el;
  el.setAttribute('role', 'list');
  el.setAttribute('aria-label', o.label);
  const rowOf = (t: EventTarget | null) => { const r = (t as Element | null)?.closest?.('.item') as HTMLElement | null; const i = r ? Number(r.dataset.i) : -1; return { el: r, i, row: rows[i] }; };
  const canPlay = (r?: SongVM) => !!r && !r.bad && !r.current && !r.skip;
  el.addEventListener('dblclick', (e) => { const { row, i } = rowOf(e.target); if (canPlay(row) && !(e.target as Element).closest('button')) o.onPlay?.(row, i); });
  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    const { row, i, el: r } = rowOf(t);
    if (!row) return;
    const b = t.closest('button');
    if (b?.classList.contains('play')) { if (canPlay(row)) o.onPlay?.(row, i); return; }
    if (b?.classList.contains('more')) { o.onMore(row, i, b as HTMLElement); return; }
    if (!b && touch() && r) o.onMore(row, i, r); // phone: a tap opens the song's menu
  });
  el.addEventListener('keydown', (e) => {
    const { row, i, el: r } = rowOf(document.activeElement);
    if (!row || !r) return;
    if (e.key === 'Enter' && canPlay(row)) { e.preventDefault(); o.onPlay?.(row, i); }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); o.onMore(row, i, r); }
  });
  el.addEventListener('contextmenu', (e) => { const { row, i, el: r } = rowOf(e.target); if (row && r) { e.preventDefault(); o.onMore(row, i, r); } });

  if (o.reorder || o.dragToPlaylists) {
    const clearOver = () => el.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
    el.addEventListener('dragstart', (e: DragEvent) => {
      const t = e.target as Element;
      const { el: r, i, row } = rowOf(t);
      if (!r || !row) return;
      if (t.closest('.grip') && o.reorder) { dragFrom = i; r.classList.add('dragging'); }
      else if (!t.closest('.cover')) return;
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.setData('application/x-partymix-track', row.id); }
    });
    el.addEventListener('dragover', (e: DragEvent) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (box.height) { if (e.clientY < box.top + 48) list.top = list.top - 18; else if (e.clientY > box.bottom - 48) list.top = list.top + 18; }
      const { el: r, i } = rowOf(e.target);
      clearOver();
      if (r && i !== dragFrom) r.classList.add('over');
    });
    el.addEventListener('drop', (e: DragEvent) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const from = dragFrom, { i } = rowOf(e.target);
      dragFrom = -1; clearOver();
      if (i >= 0 && from !== i) o.reorder?.(from, i);
    });
    el.addEventListener('dragend', () => { dragFrom = -1; clearOver(); el.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging')); });
  }

  const wrap = h('div', { class: 'songlist-wrap' }, el, o.empty ?? null);
  function paintEnds() {
    endText.textContent = `■ ${o.endLabel ?? 'Fine'} · ${plural(rows.length, 'brano', 'brani')}`;
    endNote.textContent = o.endNote?.() ?? '';
    toTop.hidden = rows.length < 8;
    o.empty?.classList.toggle('hidden', rows.length > 0);
    el.classList.toggle('hidden', rows.length === 0 && !!o.empty);
  }
  return {
    el: wrap, list,
    rows: () => rows,
    /** New rows; `keep` holds the position (the default), `start` goes to the head. */
    set(next: SongVM[], keep: 'keep' | 'start' | { index: number; offset: number } = 'keep') {
      const same = keep === 'keep' && next.length === rows.length;
      rows = next;
      if (same) list.update(rows); else list.setItems(rows, keep);
      paintEnds();
    },
    setHead(title: string, sub = '') { headTitle.textContent = title; headSub.textContent = sub; },
    refreshEnds: paintEnds,
  };
}
