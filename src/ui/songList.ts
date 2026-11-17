import { fmtTime, h } from './dom';
import { VirtualList } from './virtualList';
import type { OfflineState } from '../library/library';

/** One song as every list of the app shows it (queue, playlist, library, search). */
/** The row tapped once (phone): its title, when longer than the row, slides left and back so it can be read whole. */
function marquee(box: HTMLElement, inner: HTMLElement, on: boolean) {
  box.classList.remove('mq');
  if (!on) return;
  requestAnimationFrame(() => {
    if (!inner.isConnected) return;
    const over = box.scrollWidth - box.clientWidth; // the title box clips (overflow hidden): what does not fit
    if (over <= 4) return;
    inner.style.setProperty('--mq', `-${over + 12}px`);
    inner.style.setProperty('--mqd', `${Math.min(20, 5 + over / 25).toFixed(1)}s`); // about 25 px a second, pauses at both ends
    box.classList.add('mq');
  });
}

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
  /** The file on the NAS: ☁ there, ⬆ going up, ⚠ not there (or failed, with `nasTip` saying why). */
  nas?: 'nas' | 'uploading' | 'missing' | 'error';
  nasTip?: string;
  /** What the local copy is: 🎵 only sound, 🎬 video, or both. */
  fmt?: 'audio' | 'video' | 'both';
  fav?: boolean;
  dur?: number;
  /** Start/End scelti dall'utente: «✂ 00:42.317 → 03:48.650»; `cueTip` le durate. */
  cue?: string;
  cueTip?: string;
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
  /** «Seleziona»: in selection mode a click ticks a song (Shift+click a range) instead of opening it. */
  onSelectionChange?: (ids: string[]) => void;
};

export const STATE: Record<NonNullable<SongVM['off']>, [string, string, string]> = {
  offline: ['✓', 'Offline', 'Disponibile offline: suona anche senza rete'],
  online: ['☁', 'Online', 'Solo online: serve la rete'],
  downloading: ['⬇', 'Download', 'Download in corso'],
  queued: ['⏳', 'In coda', 'In attesa di essere scaricato'],
  error: ['⚠', 'Errore', 'Problema con il file'],
};
/** The NAS state as a small tag after the title: icon, and the words of the tooltip. */
export const FMT_TAG: Record<NonNullable<SongVM['fmt']>, [string, string]> = {
  audio: ['🎵 Audio', 'Solo audio (MP3, M4A…): sul proiettore niente video'],
  video: ['🎬 Video', 'Video (MP4, WebM): sul proiettore si vede il video'],
  both: ['🎵+🎬', 'Salvato sia come audio sia come video'],
};
export const NAS_TAG: Record<NonNullable<SongVM['nas']>, [string, string]> = {
  nas: ['☁', 'Sul NAS'],
  uploading: ['⬆', 'In caricamento sul NAS'],
  missing: ['⚠', 'Non ancora sul NAS'],
  error: ['⚠', 'Caricamento sul NAS non riuscito'],
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
  let selecting = false;
  /** Phone: the row tapped once (a second tap on it opens its menu). */
  let tappedId: string | undefined;
  const sel = new Set<string>();
  let anchor = -1;
  const changed = () => { list.refresh(); o.onSelectionChange?.([...sel]); };
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
      el.className = 'item song' + (r.current ? ' cur' : '') + (r.bad ? ' bad' : '') + (r.skip ? ' skip' : '') + (tappedId === r.id ? ' tapped' : '');
      el.setAttribute('aria-label', `${i + 1}. ${r.title}${r.artist ? `, ${r.artist}` : ''}${r.current ? (r.paused ? ', in pausa' : ', in riproduzione') : ''}`);
      el.title = r.skip ? (r.reason ?? 'Non si può riprodurre adesso (sei offline e il brano è solo online).') : '';
      const lead = q('.lead');
      const ticked = selecting && sel.has(r.id);
      el.classList.toggle('sel', ticked);
      el.setAttribute('aria-selected', selecting ? String(ticked) : 'false');
      lead.textContent = selecting ? (ticked ? '☑' : '☐') : r.current ? (r.paused ? '⏸' : '▶') : String(i + 1);
      lead.classList.toggle('now', !!r.current);
      lead.title = r.current ? (r.paused ? 'In pausa' : 'In riproduzione') : `Brano ${i + 1}`;
      const img = el.querySelector('img');
      if (img) { const src = r.thumb ?? ''; if (img.getAttribute('src') !== src) { if (src) img.src = src; else img.removeAttribute('src'); } }
      const tags = [r.current ? ['tag on', r.paused ? 'in pausa' : 'in onda'] : null, r.locked ? ['tag', 'bloccato'] : null,
        r.lyr === 'none' ? ['tag', 'senza testo'] : r.lyr === 'plain' ? ['tag soft', 'testo stimato'] : r.lyr === 'synced' ? ['tag ok', 'testo a tempo'] : null,
        r.fmt ? [`tag fmt ${r.fmt}`, FMT_TAG[r.fmt][0], FMT_TAG[r.fmt][1]] : null,
        r.bad ? ['tag', 'non riproducibile'] : null, r.fav ? ['tag fav', '♥'] : null,
        r.nas ? [`tag nas ${r.nas}`, NAS_TAG[r.nas][0], r.nasTip ?? NAS_TAG[r.nas][1]] : null].filter((x): x is string[] => !!x);
      const tEl = q('.t'), tin = h('span', { class: 'tin' }, r.title, ...tags.map(([c, s, tip]) => h('span', { class: c, ...(tip ? { title: tip } : {}) }, s)));
      tEl.replaceChildren(tin);
      marquee(tEl, tin, tappedId === r.id);
      const sub = r.sub ?? r.artist;
      // Start/End chosen by the user on the second line (the title is cut first in narrow lists)
      if (r.cue) q('.s').replaceChildren(h('span', { class: 'cue-tag', title: r.cueTip ?? 'Start/End scelti da te: il file resta intero' }, r.cue), sub ? ` · ${sub}` : '');
      else q('.s').textContent = sub;
      q('.dur').textContent = r.dur ? fmtTime(r.dur) : '';
      const st = q('.st');
      if (r.off) {
        const [ic, word, tip] = STATE[r.off];
        // icon and word in two spans: narrow lists (the play queue) show the icon only, the word stays in the tooltip
        st.replaceChildren(h('span', { class: 'st-ic' }, ic), h('span', { class: 'st-w' }, r.off === 'downloading' && r.pct !== undefined ? ` ${Math.round(r.pct * 100)}%` : ` ${word}`));
        st.title = r.reason ?? tip;
        st.className = `st ${r.off}`;
      } else { st.replaceChildren(); st.className = 'st'; }
      (q('.play') as HTMLButtonElement).disabled = !!r.bad || !!r.current || !!r.skip || !o.onPlay;
      (q('.play') as HTMLButtonElement).hidden = !o.onPlay || selecting;
      if (el.querySelector('.cover')) (q('.cover') as HTMLElement).dataset.id = r.id;
    },
  });

  const el = list.el;
  el.setAttribute('role', 'list');
  el.setAttribute('aria-label', o.label);
  const rowOf = (t: EventTarget | null) => { const r = (t as Element | null)?.closest?.('.item') as HTMLElement | null; const i = r ? Number(r.dataset.i) : -1; return { el: r, i, row: rows[i] }; };
  const canPlay = (r?: SongVM) => !!r && !r.bad && !r.current && !r.skip;
  el.addEventListener('dblclick', (e) => { if (selecting) return; const { row, i } = rowOf(e.target); if (canPlay(row) && !(e.target as Element).closest('button')) o.onPlay?.(row, i); });
  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    const { row, i, el: r } = rowOf(t);
    if (!row) return;
    if (selecting && !t.closest('button.more')) {
      e.preventDefault();
      if (e.shiftKey && anchor >= 0) { const [a, b] = anchor < i ? [anchor, i] : [i, anchor]; for (let k = a; k <= b; k++) sel.add(rows[k].id); }
      else if (sel.has(row.id)) sel.delete(row.id); else sel.add(row.id);
      anchor = i;
      changed();
      return;
    }
    const b = t.closest('button');
    if (b?.classList.contains('play')) { if (canPlay(row)) o.onPlay?.(row, i); return; }
    if (b?.classList.contains('more')) { o.onMore(row, i, b as HTMLElement); return; }
    // phone: the first tap picks the row (its title scrolls to show the whole name), a second tap on it opens the menu
    if (!b && touch() && r) {
      if (tappedId === row.id) { o.onMore(row, i, r); return; }
      tappedId = row.id;
      list.refresh(); // the old row stops, the new one is marked and scrolls
    }
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
  fitToWindow(el, wrap);
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
    /** Selection mode on/off (off clears the selection). */
    setSelecting(on: boolean) { selecting = on; if (!on) sel.clear(); anchor = -1; el.classList.toggle('selecting', on); changed(); },
    isSelecting: () => selecting,
    selected: () => rows.filter((r) => sel.has(r.id)).map((r) => r.id),
    selectAll() { for (const r of rows) sel.add(r.id); changed(); },
    selectNone() { sel.clear(); changed(); },
    refreshEnds: paintEnds,
  };
}

/**
 * Computer: the list ends at the bottom of the window, so its last song and «Fine» are reached by scrolling the list
 * only — never the list *and* the page. Height = what is left under the list's top (minus what follows it).
 */
function fitToWindow(el: HTMLElement, wrap: HTMLElement) {
  if (typeof window === 'undefined' || typeof ResizeObserver !== 'function') return;
  let raf = 0;
  const fit = () => {
    raf = 0;
    if (!document.body.classList.contains('desk') || !el.isConnected || !el.offsetParent) return;
    let after = 0; // what sits under the list in the same page (e.g. «Altri risultati»)
    for (let n = wrap.nextElementSibling as HTMLElement | null; n; n = n.nextElementSibling as HTMLElement | null) if (n.offsetHeight) after += n.offsetHeight + 16;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const main = el.closest<HTMLElement>('.m-main');
    const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 24 : 24; // the page's own bottom margin
    const hgt = Math.max(280, Math.floor(window.innerHeight - top - after - pad - 1));
    el.style.minHeight = '0'; // the stylesheet's minimum would push the end under the window again
    if (Math.abs(el.offsetHeight - hgt) > 1) el.style.height = `${hgt}px`;
  };
  const later = () => { if (!raf) raf = window.setTimeout(fit, 16); }; // not rAF: it does not run while the window is in the background
  const ro = new ResizeObserver(later);
  ro.observe(document.body); // anything above grows or shrinks
  ro.observe(wrap); // the page with the list is shown
  window.addEventListener('resize', later);
  window.setInterval(later, 700); // what moves the list's top without resizing anything (a page shown, a bar above)
  later();
}
