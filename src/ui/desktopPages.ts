import type { LibEntry, MusicLibrary } from '../library/library';
import type { Playlist, PlaylistSort, PlaylistStore } from '../library/playlists';
import { SORT_LABEL } from '../library/playlists';
import { AUDIO_ACCEPT } from '../library/id3';
import type { Track } from '../queue';
import type { SearchHit, SearchResult } from '../ytSearch';
import type { DownloadCoordinator } from '../download/manager';
import { youtubeUrl } from '../download/client';
import { fmtTime, h } from './dom';
import { buildSongList, SongVM } from './songList';
import { buildDownloadsUI, DlPrefs, loadPrefs, storePrefs } from './downloadsUI';
import type { SheetItem } from './material';

/** What the computer's pages need from the app. */
export type PagesDeps = {
  playlists: PlaylistStore;
  library: MusicLibrary;
  /** The playlist in the play queue (its songs are what the Player plays). */
  playingId(): string | undefined;
  sort(): PlaylistSort;
  setSort(s: PlaylistSort): void;
  apiKey(): string;
  setApiKey(k: string): void;
  online(): boolean;
  /** Puts a playlist in the play queue (from `startAt` if given) and opens the Player. */
  playPlaylist(id: string, startAt?: string): void;
  /** Loads a YouTube/Spotify link into a playlist (it becomes its source). */
  loadLink(id: string, link: string): void;
  /** A playlist was changed here: if it is the one playing, the queue follows. */
  edited(id: string): void;
  deleted(id: string): void;
  playTrack(t: Track): void;
  enqueue(t: Track, next: boolean): void;
  trackById(id: string): Track | undefined;
  search(q: string, pageToken?: string): Promise<SearchResult>;
  status(text: string, error?: boolean): void;
  /** The song menu (Material: bottom sheet / dialog) and the page navigation of the shell. */
  menu(title: string, subtitle: string, items: SheetItem[]): void;
  go(page: string): void;
  downloads?: DownloadCoordinator;
  store?: Storage;
};

/** Where a song is, for information only: the playlists that have it and the file on the computer. */
export function whereText(e: LibEntry | undefined, lists: string[], folder: string): { short: string; full: string } {
  const pl = lists.length ? `📂 ${lists.slice(0, 2).join(', ')}${lists.length > 2 ? ` +${lists.length - 2}` : ''}` : '';
  const file = e?.file ? (folder.includes('PartyMix Library') ? `Musica › PartyMix Library › ${e.file.split('/').join(' › ')}` : `copia ${folder}`) : '';
  const short = [pl, e?.file ? `💾 ${e.file.includes('/') ? e.file : 'sul PC'}` : ''].filter(Boolean).join(' · ') || (e ? 'solo nella libreria' : '');
  const full = [
    lists.length ? `Nelle playlist: ${lists.join(', ')}` : 'Non è in nessuna playlist',
    file ? `File sul computer: ${file}` : e?.source === 'youtube' || !e ? 'Online: suona da YouTube' : '',
    e?.origin ? `Importato da: ${e.origin}` : '',
    e?.source === 'url' && e.url ? `Scaricato da: ${e.url}` : '',
  ].filter(Boolean).join('\n');
  return { short, full };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('it-IT')} ${n === 1 ? one : many}`;
const fmtSize = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`);
const fmtLong = (s: number) => { const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh ? `${hh} h ${mm} min` : `${mm} min`; };

/** PageHeader: title, a line of information and the page's actions on the right. */
function pageHeader(title: string, ...actions: (Node | null)[]) {
  const sub = h('div', { class: 'pg-sub' });
  const t = h('h1', { class: 'pg-title' }, title);
  const el = h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, t, sub), h('div', { class: 'pg-actions' }, ...actions));
  return { el, sub, title: t };
}
/** EmptyState: what is missing, what to do, and the buttons to do it. */
function emptyState(icon: string, title: string, text: string, ...buttons: HTMLElement[]) {
  return h('div', { class: 'empty-state hidden' }, h('div', { class: 'es-ic', 'aria-hidden': 'true' }, icon), h('div', { class: 'es-t' }, title), h('p', { class: 'es-p' }, text), h('div', { class: 'es-b' }, ...buttons));
}
const btn = (label: string, cls: string, fn: (b: HTMLButtonElement) => void, extra: Record<string, unknown> = {}) => { const b = h('button', { type: 'button', class: cls, ...extra }, label); b.addEventListener('click', () => fn(b)); return b; };
const cols = (kind: '' | 'g2' | 'g3', ...names: string[]) => h('div', { class: `sl-cols ${kind}`, 'aria-hidden': 'true' }, ...names.map((n) => h('span', {}, n)));

/** Small pictures for library songs (embedded covers): made on demand, a few hundred at most kept. */
class Covers {
  private urls = new Map<string, string>();
  get(e: LibEntry | undefined, t?: Track): string | undefined {
    if (e?.cover) {
      let u = this.urls.get(e.id);
      if (!u) {
        u = URL.createObjectURL(e.cover);
        this.urls.set(e.id, u);
        if (this.urls.size > 300) { const [k, old] = this.urls.entries().next().value!; URL.revokeObjectURL(old); this.urls.delete(k); }
      }
      return u;
    }
    return e?.thumb ?? t?.thumb;
  }
}

/**
 * The pages of the computer app: Playlist, Cerca, Download, Libreria (and a card for Impostazioni).
 * Each page has its own header, list and empty state; searches show their results right under their field.
 */
export function buildDesktopPages(d: PagesDeps) {
  const covers = new Covers();
  /** Search results are not in the library: kept so the menus and a drag onto a playlist find them. */
  const known = new Map<string, Track>();

  // ---------- shared: every song known, with the playlists that have it ----------
  type Known = { t: Track; e?: LibEntry; lists: string[]; key: string };
  let allCache: { sig: string; rows: Known[]; byId: Map<string, Known> } = { sig: '', rows: [], byId: new Map() };
  function allTracks() {
    const sig = `${d.library.version}|${d.playlists.version}`;
    if (allCache.sig === sig) return allCache;
    const seen = new Map<string, Known>();
    for (const e of d.library.all()) seen.set(e.id, { t: d.library.toTrack(e), e, lists: [], key: '' });
    for (const p of d.playlists.list()) for (const t of p.tracks) {
      let k = seen.get(t.videoId);
      if (!k) { k = { t, lists: [], key: '' }; seen.set(t.videoId, k); }
      if (!k.lists.includes(p.name)) k.lists.push(p.name);
    }
    for (const k of seen.values()) k.key = norm([k.t.title, k.t.artist, k.t.album, ...k.lists, k.e?.file, k.e?.origin].filter(Boolean).join(' '));
    allCache = { sig, rows: [...seen.values()], byId: seen };
    return allCache;
  }
  const trackOf = (id: string) => d.trackById(id) ?? known.get(id) ?? allTracks().byId.get(id)?.t;
  const songVM = (t: Track, e = d.library.get(t.videoId), lists?: string[]): SongVM => {
    const off = d.library.stateOf(t.videoId);
    const w = lists ? whereText(e, lists, d.library.where) : undefined;
    return {
      id: t.videoId, title: t.title || `Video ${t.videoId}`, artist: t.artist ?? '',
      sub: [t.artist, t.album, w?.short].filter(Boolean).join(' · '),
      dur: t.durationSec || e?.durationSec, thumb: covers.get(e, t), off, pct: d.library.progressOf(t.videoId),
      fav: !!e?.favorite, skip: !d.online() && off !== 'offline', reason: w?.full,
    };
  };

  // ---------- the playlist dialog («Aggiungi a playlist») and the song menu ----------
  function addTo(pid: string, ids: string[]) {
    const tracks = ids.map(trackOf).filter((t): t is Track => !!t);
    const p = d.playlists.get(pid);
    if (!p || !tracks.length) return;
    const r = d.playlists.addTracks(pid, tracks);
    d.edited(pid);
    d.status(r.added ? `Aggiunt${r.added === 1 ? 'o' : 'i'} ${plural(r.added, 'brano', 'brani')} a «${p.name}»${r.duplicates ? ` (${r.duplicates} già c’${r.duplicates === 1 ? 'era' : 'erano'})` : ''}.` : `Già in «${p.name}»: non l’ho aggiunto due volte.`);
  }
  /** «Aggiungi a playlist»: a dialog with the playlists and «+ Nuova playlist»; the page does not change. */
  function pickPlaylist(ids: string[]) {
    const items: SheetItem[] = d.playlists.list(d.sort()).slice(0, 300).map((p) => ({ label: `${p.name} · ${plural(p.tracks.length, 'brano', 'brani')}`, icon: 'queue', run: () => addTo(p.id, ids) }));
    items.unshift({ label: 'Nuova playlist…', icon: 'add', run: () => { const p = d.playlists.create(); addTo(p.id, ids); openDetail(p.id); renameDialog(p.id); } });
    d.menu(ids.length > 1 ? `Aggiungi ${ids.length} brani a una playlist` : 'Aggiungi a playlist', 'Scegli la playlist', items);
  }
  const canDownload = (id: string) => !id.startsWith('local:') && !!d.downloads?.available();
  /** ⬇ on a song: the Download Manager for a YouTube song, else the user's own audio file. */
  function offline(id: string) {
    if (canDownload(id)) {
      const t = trackOf(id);
      chooseFormat(t?.title ? `«${t.title}»` : 'il brano', 1, (c) => void d.downloads!.download({ url: youtubeUrl(id), type: c.type, format: c.format, quality: c.quality }));
      return;
    }
    pickOneFor = id; pickOne.click();
  }

  /** MP3 or MP4? Asked before every download; the last choice comes first. Video keeps the pictures (lyrics and karaoke versions). */
  const CHOICES: (DlPrefs & { label: string })[] = [
    { type: 'audio', format: 'mp3', quality: 'best', label: '🎵 Audio MP3 — solo la musica, file piccoli' },
    { type: 'video', format: 'mp4', quality: 'best', label: '🎬 Video MP4 — con le immagini: per versioni lyrics e karaoke' },
    { type: 'video', format: 'mp4', quality: '720', label: '🎬 Video MP4 720p — con le immagini, file più leggeri' },
  ];
  function chooseFormat(what: string, n: number, go: (c: DlPrefs) => void) {
    const last = loadPrefs(d.store);
    const same = (c: DlPrefs) => c.type === last.type && c.format === last.format && c.quality === last.quality;
    const sorted = [...CHOICES.filter(same), ...CHOICES.filter((c) => !same(c))];
    d.menu(`Scarica ${what}`, `${n === 1 ? '1 brano' : `${n.toLocaleString('it-IT')} brani`} · scegli il formato`, sorted.map((c) => ({
      label: c.label + (same(c) ? ' · ultima scelta' : ''), icon: c.type === 'audio' ? 'nowPlaying' : 'cast',
      run: () => { const p = { type: c.type, format: c.format, quality: c.quality }; storePrefs(d.store, p); dl?.setPrefs(p); go(p); },
    })));
  }
  /** Downloads many songs (a playlist, a selection) with one choice of format and one request to the app. */
  function downloadTracks(ids: string[], what: string) {
    if (!d.downloads?.available()) { d.status('Il download funziona nell’app installata sul computer, con yt-dlp.', true); return; }
    const todo = ids.filter((id) => !id.startsWith('local:'));
    const local = ids.length - todo.length;
    if (!todo.length) { d.status(local ? 'Questi brani sono già file sul computer.' : 'Niente da scaricare.'); return; }
    chooseFormat(what, todo.length, (c) => void d.downloads!.downloadMany(todo.map((id) => ({ url: youtubeUrl(id), type: c.type, format: c.format, quality: c.quality })), what));
  }

  /** «☑ Seleziona»: a bar with the count and what can be done with the songs ticked. */
  function selectionBar(sl: ReturnType<typeof buildSongList>, what: () => string) {
    const count = h('span', { class: 'sel-count' });
    const dlSel = btn('⬇ Scarica selezionati', 'm-filled', () => downloadTracks(sl.selected(), `${sl.selected().length} brani selezionati di ${what()}`));
    const addSel = btn('＋ Aggiungi a playlist', 'm-tonal', () => { const ids = sl.selected(); if (ids.length) pickPlaylist(ids); });
    const bar = h('div', { class: 'selbar hidden', role: 'toolbar', 'aria-label': 'Brani selezionati' }, count,
      btn('Seleziona tutti', 'm-text-btn', () => sl.selectAll()), btn('Nessuno', 'm-text-btn', () => sl.selectNone()),
      h('span', { class: 'm-spacer' }), d.downloads ? dlSel : null, addSel, btn('✕ Fine', 'm-text-btn', () => toggle(false)));
    const toggleBtn = btn('☑ Seleziona', 'm-tonal', () => toggle(!sl.isSelecting()), { title: 'Scegli più brani da scaricare o aggiungere a una playlist' });
    function toggle(on: boolean) { sl.setSelecting(on); bar.classList.toggle('hidden', !on); toggleBtn.classList.toggle('on', on); paint([]); }
    function paint(ids: string[]) { count.textContent = `${ids.length} ${ids.length === 1 ? 'selezionato' : 'selezionati'}`; dlSel.disabled = addSel.disabled = !ids.length; }
    return { bar, toggleBtn, paint, toggle };
  }
  /** ⋮ on a song: the actions that make sense for it, in its state (Material menu). */
  function songMenu(t: Track, extra: { inPlaylist?: string } = {}) {
    const id = t.videoId, e = d.library.get(id), st = d.library.stateOf(id);
    const playable = d.online() || st === 'offline';
    const items: SheetItem[] = [
      { label: 'Riproduci adesso', icon: 'play', disabled: !playable, run: () => d.playTrack(t) },
      { label: 'Suona dopo quello in onda', icon: 'playNext', disabled: !playable, run: () => d.enqueue(t, true) },
      { label: 'Metti in coda (in fondo)', icon: 'queue', disabled: !playable, run: () => d.enqueue(t, false) },
      { label: 'Aggiungi a playlist…', icon: 'add', run: () => pickPlaylist([id]) },
      st === 'offline'
        ? { label: 'Elimina download (resta nelle playlist)', icon: 'del', run: () => void d.library.deleteDownload(id).then(() => d.status(`Download eliminato: «${t.title}» resta nelle playlist.`)) }
        : st === 'downloading' ? { label: 'Interrompi il download', icon: 'stop', run: () => d.library.cancel(id) }
          : { label: canDownload(id) ? 'Scarica' : 'Rendi offline con un tuo file…', icon: 'down', run: () => offline(id) },
      { label: e?.favorite ? 'Togli dai preferiti' : 'Aggiungi ai preferiti', icon: 'lock', run: () => d.library.toggleFavorite(id, t) },
    ];
    if (extra.inPlaylist) items.push({ label: 'Togli da questa playlist', icon: 'del', danger: true, run: () => { const p = d.playlists.get(extra.inPlaylist!); if (d.playlists.removeTrack(extra.inPlaylist!, id)) { d.edited(extra.inPlaylist!); d.status(`Tolto da «${p?.name}».`); } } });
    if (e) items.push({ label: 'Elimina dalla libreria', icon: 'del', danger: true, run: () => void d.library.remove(id).then(() => d.status(`«${t.title}» tolto dalla libreria (le playlist lo tengono).`)) });
    const lists = allTracks().byId.get(id)?.lists ?? [];
    const info = whereText(e, lists, d.library.where).full.split('\n')[0];
    d.menu(t.title || id, [t.artist, t.durationSec ? fmtTime(t.durationSec) : '', info].filter(Boolean).join(' · '), items);
  }

  // ---------- hidden file pickers ----------
  const pickFiles = h('input', { type: 'file', multiple: true, accept: AUDIO_ACCEPT, class: 'hidden', onChange: () => { void importFiles(pickFiles.files); pickFiles.value = ''; } });
  const pickFolder = h('input', { type: 'file', multiple: true, class: 'hidden', onChange: () => { void importFiles(pickFolder.files); pickFolder.value = ''; } });
  pickFolder.setAttribute('webkitdirectory', '');
  const pickOne = h('input', { type: 'file', accept: AUDIO_ACCEPT, class: 'hidden' });
  let pickOneFor: string | undefined;
  pickOne.addEventListener('change', () => {
    const f = pickOne.files?.[0], id = pickOneFor;
    pickOne.value = '';
    if (!f || !id) return;
    const base = trackOf(id);
    d.library.linkFile(id, f, base).then(() => d.status(`✓ «${base?.title ?? f.name}» ora è disponibile offline.`), (e) => d.status((e as Error).message, true));
  });
  const importMsg = h('div', { class: 'pg-progress' });
  async function importFiles(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const r = await d.library.importFiles(list, (i, n, name) => { importMsg.textContent = i < n ? `Importo ${i + 1} di ${n}: ${name}` : ''; });
    importMsg.textContent = '';
    const parts = [r.added.length ? `✓ Importati ${plural(r.added.length, 'brano', 'brani')}` : '', r.duplicates.length ? `${plural(r.duplicates.length, 'era già', 'erano già')} nella libreria` : '', r.invalid.length ? `${plural(r.invalid.length, 'file scartato', 'file scartati')} (${r.invalid.slice(0, 2).map((x) => `${x.name}: ${x.reason}`).join('; ')}${r.invalid.length > 2 ? '…' : ''})` : ''].filter(Boolean);
    d.status((r.stopped ? `${r.stopped} ` : '') + (parts.length ? parts.join(' · ') + '.' : 'Nessun file audio trovato.'), !!r.stopped || (!r.added.length && !r.duplicates.length));
    if (r.added.length) { libFilter = 'imported'; libGroup = undefined; paintLibrary(true); }
  }
  const linkIn = h('input', { type: 'url', placeholder: 'https://…/brano.mp3', 'aria-label': 'Link diretto di un file audio' });
  function importMenu() {
    d.menu('Importa musica', 'MP3, M4A, OGG, FLAC, WAV · puoi anche trascinare i file nella pagina', [
      { label: 'Scegli file (anche più di uno)…', icon: 'add', run: () => pickFiles.click() },
      { label: 'Scegli una cartella…', icon: 'queue', run: () => pickFolder.click() },
      ...(d.downloads?.available() ? [{ label: 'Scarica da un indirizzo (Download)…', icon: 'down' as const, run: () => d.go('downloads') }] : []),
    ]);
  }

  // =====================================================================================
  // 📋 PLAYLIST
  // =====================================================================================
  let plQuery = '';
  let detailId: string | undefined;
  const plSearch = h('input', { type: 'search', class: 'pg-search', placeholder: '🔎 Cerca playlist', 'aria-label': 'Cerca tra le playlist', onInput: () => { plQuery = plSearch.value; paintPlaylists(true); } });
  const plSort = h('select', { class: 'pg-select', 'aria-label': 'Ordina le playlist', onChange: () => { d.setSort(plSort.value as PlaylistSort); paintPlaylists(true); } },
    ...(Object.keys(SORT_LABEL) as PlaylistSort[]).map((k) => h('option', { value: k }, SORT_LABEL[k])));
  const newPl = () => { const p = d.playlists.create(); openDetail(p.id); renameDialog(p.id); };
  const plHead = pageHeader('Playlist', btn('+ Nuova playlist', 'm-filled', newPl));
  const plList = h('div', { class: 'pl-grid', role: 'list', 'aria-label': 'Playlist' });
  const plEmpty = emptyState('📋', 'Nessuna playlist', 'Crea la tua prima playlist, oppure incollane una da YouTube o Spotify.', btn('+ Nuova playlist', 'm-filled', newPl));
  let plDrag: string | undefined;
  function playlistCard(p: Playlist) {
    const playing = p.id === d.playingId();
    const dur = p.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
    const thumb = p.cover ?? p.tracks.find((t) => t.thumb)?.thumb;
    const card = h('div', {
      class: 'pl-card' + (playing ? ' playing' : ''), role: 'listitem', tabindex: '0', draggable: d.sort() === 'custom' ? 'true' : undefined,
      'aria-label': `${p.name}, ${plural(p.tracks.length, 'brano', 'brani')}${playing ? ', in riproduzione' : ''}`,
      onClick: (e: MouseEvent) => { if (!(e.target as Element).closest('button')) openDetail(p.id); },
      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === card) openDetail(p.id); },
      onDragstart: () => { plDrag = p.id; },
      onDragend: () => { plDrag = undefined; plList.querySelectorAll('.over').forEach((n) => n.classList.remove('over')); },
      onDragover: (e: DragEvent) => { const types = Array.from(e.dataTransfer?.types ?? []); if (!plDrag && !types.includes('application/x-partymix-track')) return; e.preventDefault(); card.classList.add('over'); },
      onDragleave: () => card.classList.remove('over'),
      onDrop: (e: DragEvent) => {
        e.preventDefault(); card.classList.remove('over');
        const track = e.dataTransfer?.getData('application/x-partymix-track');
        if (track) { addTo(p.id, [track]); return; }
        if (plDrag && plDrag !== p.id) { const ids = d.playlists.list('custom').map((x) => x.id).filter((x) => x !== plDrag); ids.splice(ids.indexOf(p.id), 0, plDrag); d.playlists.reorder(ids); }
        plDrag = undefined;
      },
    },
      h('div', { class: 'pl-art' + (thumb ? '' : ' none'), style: p.color ? `--pl:${p.color}` : '' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : h('span', { 'aria-hidden': 'true' }, '🎵')),
      h('div', { class: 'pl-meta' },
        h('div', { class: 'pl-name' }, p.name),
        h('div', { class: 'pl-info' }, [plural(p.tracks.length, 'brano', 'brani'), dur ? fmtLong(dur) : '', p.source ? `da ${p.source}` : ''].filter(Boolean).join(' · ')),
        playing ? h('div', { class: 'pl-badge' }, '▶ In riproduzione') : null),
      h('div', { class: 'pl-acts' },
        btn('▶', 'icon-btn m-filled-ic', () => d.playPlaylist(p.id), { title: `Suona «${p.name}»`, 'aria-label': `Suona ${p.name}`, disabled: !p.tracks.length }),
        btn('⋮', 'icon-btn', () => playlistMenu(p.id), { title: 'Altre azioni', 'aria-label': `Altre azioni per ${p.name}` })));
    return card;
  }
  let lastPlSig = '';
  function paintPlaylists(force = false) {
    const sig = `${d.playlists.version}|${d.playingId()}|${d.sort()}|${plQuery}`;
    if (!force && sig === lastPlSig) return;
    lastPlSig = sig;
    if (plSort.value !== d.sort()) plSort.value = d.sort();
    const all = d.playlists.list(d.sort(), plQuery);
    const total = d.playlists.count();
    plHead.sub.textContent = plQuery ? `${plural(all.length, 'playlist trovata', 'playlist trovate')} su ${total}` : plural(total, 'playlist', 'playlist');
    plList.replaceChildren(...all.slice(0, 2000).map(playlistCard));
    plEmpty.classList.toggle('hidden', total > 0);
    if (total > 0 && !all.length) plList.append(h('div', { class: 'pg-none' }, `Nessuna playlist con «${plQuery}».`));
  }
  function renameDialog(id: string) {
    const p = d.playlists.get(id);
    if (!p) return;
    // inline: the title of the detail page becomes a text field
    openDetail(id);
    const inp = h('input', { type: 'text', class: 'pg-rename', value: p.name, maxlength: '80', 'aria-label': 'Nome della playlist' });
    const done = (ok: boolean) => { if (ok && inp.value.trim()) { d.playlists.rename(id, inp.value); d.edited(id); } inp.replaceWith(dtHead.title); paintDetail(true); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => { if (inp.isConnected) done(true); });
    dtHead.title.replaceWith(inp);
    setTimeout(() => { inp.focus(); inp.select(); });
  }
  let armedDelete: string | undefined;
  function playlistMenu(id: string) {
    const p = d.playlists.get(id);
    if (!p) return;
    d.menu(p.name, plural(p.tracks.length, 'brano', 'brani'), [
      { label: 'Suona questa playlist', icon: 'play', disabled: !p.tracks.length, run: () => d.playPlaylist(id) },
      { label: 'Apri', icon: 'queue', run: () => openDetail(id) },
      { label: 'Rinomina', icon: 'tune', run: () => renameDialog(id) },
      { label: 'Duplica', icon: 'add', run: () => { const c = d.playlists.duplicate(id); if (c) d.status(`Creata «${c.name}».`); } },
      { label: armedDelete === id ? 'Conferma: elimina definitivamente' : 'Elimina playlist…', icon: 'del', danger: true, run: () => {
        if (armedDelete !== id) { armedDelete = id; playlistMenu(id); return; } // a second, explicit choice
        armedDelete = undefined;
        d.playlists.remove(id); d.deleted(id);
        if (detailId === id) closeDetail();
        d.status(`Playlist «${p.name}» eliminata. I brani della libreria restano.`);
      } },
    ]);
    if (armedDelete === id) setTimeout(() => { armedDelete = undefined; }, 8000);
  }

  // detail
  const dtBack = btn('← Tutte le playlist', 'm-text-btn', () => closeDetail());
  const dtPlay = btn('▶ Suona', 'm-filled', () => detailId && d.playPlaylist(detailId));
  const dtMore = btn('⋮', 'icon-btn', () => detailId && playlistMenu(detailId), { title: 'Altre azioni', 'aria-label': 'Altre azioni sulla playlist' });
  const dtAll = btn('⬇ Scarica tutta la playlist', 'm-tonal', () => { const p = d.playlists.get(detailId); if (p) downloadTracks(p.tracks.map((t) => t.videoId), `la playlist «${p.name}»`); },
    { title: 'Scarica tutti i brani della playlist (scegli MP3 o MP4): diventano la tua discografia offline' });
  let dtSel: ReturnType<typeof selectionBar> | undefined;
  const dtHead = pageHeader('', dtPlay, d.downloads ? dtAll : null, h('span', { class: 'sel-slot' }), dtMore);
  const dtLink = h('input', { type: 'url', class: 'pg-input', placeholder: 'Link di una playlist YouTube o Spotify', 'aria-label': 'Link della playlist YouTube o Spotify' });
  const dtLoad = btn('Carica', 'm-tonal', () => { if (detailId && dtLink.value.trim()) d.loadLink(detailId, dtLink.value.trim()); }, { title: 'Legge (o rilegge da capo) la playlist da YouTube o Spotify' });
  dtLink.addEventListener('keydown', (e) => { if (e.key === 'Enter') dtLoad.click(); });
  const dtSource = h('details', { class: 'pg-card src' }, h('summary', {}, 'Sorgente YouTube / Spotify'), h('div', { class: 'pg-row' }, dtLink, dtLoad),
    h('p', { class: 'pg-hint' }, 'Incolla il link di una playlist YouTube o di una playlist/album Spotify pubblici: i brani entrano in questa playlist. «Carica» la rilegge da capo.'));
  const dtEmpty = emptyState('🎵', 'Questa playlist è vuota', 'Aggiungi brani dalla Ricerca o dalla Libreria (⋮ → Aggiungi a playlist), trascinali qui, oppure carica una playlist di YouTube o Spotify.',
    btn('🔎 Cerca musica', 'm-tonal', () => d.go('search')), btn('🎧 Apri la libreria', 'm-tonal', () => d.go('library')));
  const dtList = buildSongList({
    label: 'Brani della playlist',
    cover: true,
    reorder: (from, to) => { if (detailId && d.playlists.moveTrack(detailId, from, to)) d.edited(detailId); },
    onPlay: (r) => detailId && d.playPlaylist(detailId, r.id),
    onMore: (r) => { const t = trackOf(r.id); if (t) songMenu(t, { inPlaylist: detailId }); },
    onSelectionChange: (ids) => dtSel?.paint(ids),
    endLabel: 'Fine playlist',
    endNote: () => 'Per ricominciare dal primo brano a fine playlist attiva «Ripeti: tutta la playlist» nel Player.',
    empty: dtEmpty,
    dragToPlaylists: true,
  });
  dtSel = selectionBar(dtList, () => `«${d.playlists.get(detailId)?.name ?? 'playlist'}»`);
  dtHead.el.querySelector('.sel-slot')!.replaceWith(dtSel.toggleBtn);
  const detail = h('div', { class: 'pl-detail hidden' }, dtBack, dtHead.el, dtSource, dtSel.bar, cols('g3', '#', 'Titolo · Artista', 'Durata', 'Stato'), dtList.el);
  const listView = h('div', { class: 'pl-listview' }, plHead.el, h('div', { class: 'pg-toolbar' }, plSearch, plSort), plList, plEmpty);
  let lastDetailSig = '';
  function openDetail(id: string) { if (detailId !== id) dtSel?.toggle(false); detailId = id; lastDetailSig = ''; listView.classList.add('hidden'); detail.classList.remove('hidden'); paintDetail(true, true); d.go('playlists'); }
  function closeDetail() { detailId = undefined; detail.classList.add('hidden'); listView.classList.remove('hidden'); paintPlaylists(true); }
  function paintDetail(force = false, start = false) {
    const p = d.playlists.get(detailId);
    if (!p) { if (detailId) closeDetail(); return; }
    const sig = `${d.playlists.version}|${d.library.version}|${d.online()}|${d.playingId()}`;
    if (!force && sig === lastDetailSig) return;
    lastDetailSig = sig;
    dtHead.title.textContent = p.name;
    const dur = p.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
    const offline = p.tracks.filter((t) => d.library.isOffline(t.videoId)).length;
    dtHead.sub.textContent = [plural(p.tracks.length, 'brano', 'brani'), dur ? fmtLong(dur) : '', `${offline} offline`, p.id === d.playingId() ? '▶ in riproduzione' : ''].filter(Boolean).join(' · ');
    dtPlay.disabled = !p.tracks.length;
    if (document.activeElement !== dtLink) dtLink.value = p.link ?? '';
    dtSource.open = !p.tracks.length;
    dtList.setHead(`PLAYLIST: ${p.name}`, plural(p.tracks.length, 'brano', 'brani'));
    dtList.set(p.tracks.map((t) => songVM(t)), start ? 'start' : 'keep');
  }
  const playlistsPage = h('div', { class: 'pg pg-playlists' }, listView, detail);

  // =====================================================================================
  // 🔎 CERCA — the results right under the field
  // =====================================================================================
  let src: 'library' | 'youtube' = 'youtube';
  let searchQ = '';
  let searchRes: SearchResult | undefined;
  let searching = false;
  let lastErr = '';
  const sInput = h('input', { type: 'search', class: 'pg-input big', placeholder: 'Cerca una canzone, un artista o un album', 'aria-label': 'Cosa cercare' });
  const sGo = btn('🔎 Cerca', 'm-filled', () => runSearch(sInput.value));
  sInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(sInput.value); });
  sInput.addEventListener('input', () => { if (src === 'library') { searchQ = sInput.value; paintSearch(); } });
  const tabs = (['youtube', 'library'] as const).map((k) => btn(k === 'youtube' ? '▶ YouTube' : '🎧 La mia musica', 'seg-btn', () => { src = k; paintTabs(); if (k === 'library') { searchQ = sInput.value; paintSearch(); } else if (sInput.value.trim() && sInput.value.trim() !== searchQ) runSearch(sInput.value); else paintSearch(); }, { role: 'tab' }));
  const paintTabs = () => {
    tabs.forEach((b, i) => { const on = (i === 0 ? 'youtube' : 'library') === src; b.setAttribute('aria-selected', String(on)); b.classList.toggle('on', on); });
    if (typeof sCols !== 'undefined') sCols.children[1].textContent = src === 'youtube' ? 'Titolo · Canale' : 'Titolo · Artista · Dove si trova';
  };
  const sInfo = h('div', { class: 'pg-results-head' });
  const sMore = btn('Altri risultati', 'm-tonal hidden', () => runSearch(searchQ, searchRes?.next));
  const sEmpty = emptyState('🔎', 'Cerca musica', 'Scrivi titolo, artista o tutti e due (es. «The Weeknd Blinding Lights») e premi Invio. «La mia musica» cerca tra libreria e playlist, anche senza rete.');
  const hitTrack = (x: SearchHit): Track => ({ videoId: x.videoId, title: x.title, artist: x.channel.replace(/ - Topic$/, ''), durationSec: x.seconds || undefined, thumb: x.thumb, status: 'ok', manual: true });
  const sList = buildSongList({
    label: 'Risultati della ricerca', cover: true, head: false, endLabel: 'Fine dei risultati', empty: sEmpty, dragToPlaylists: true,
    onSelectionChange: (ids) => sSel?.paint(ids),
    onPlay: (r) => { const t = trackOf(r.id); if (t) d.playTrack(t); },
    onMore: (r) => { const t = trackOf(r.id); if (!t) return; songMenu(t); },
  });
  const searchCache = new Map<string, { at: number; res: SearchResult }>();
  async function runSearch(q: string, page?: string) {
    q = q.trim();
    if (src === 'library') { searchQ = q; paintSearch(); return; }
    if (!q) { sInput.focus(); return; }
    searchQ = q;
    const key = `${q}|${page ?? ''}|${d.apiKey() ? 'api' : 'web'}`;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) { searchRes = page && searchRes ? { ...hit.res, hits: [...searchRes.hits, ...hit.res.hits] } : hit.res; paintSearch(); return; }
    if (!d.online()) { lastErr = 'Sei offline: la ricerca su YouTube tornerà quando c’è rete. Intanto cerca in «La mia musica».'; searchRes = undefined; paintSearch(); return; }
    searching = true; lastErr = '';
    paintSearch();
    try {
      const res = await d.search(q, page);
      searchCache.set(key, { at: Date.now(), res });
      searchRes = page && searchRes ? { ...res, hits: [...searchRes.hits, ...res.hits.filter((x) => !searchRes!.hits.some((y) => y.videoId === x.videoId))] } : res;
    } catch (e) {
      lastErr = (e as Error).message;
      if (!page) searchRes = undefined;
    } finally { searching = false; paintSearch(); }
  }
  let lastSearchSig = '';
  function paintSearch(force = true) {
    const sig = `${src}|${searchQ}|${searchRes?.hits.length}|${searching}|${lastErr}|${d.library.version}|${d.playlists.version}|${d.online()}`;
    if (!force && sig === lastSearchSig) return;
    const sameQuery = lastSearchSig.split('|').slice(0, 2).join('|') === sig.split('|').slice(0, 2).join('|');
    lastSearchSig = sig;
    let rows: SongVM[] = [];
    if (src === 'library') {
      const words = norm(searchQ.trim()).split(/\s+/).filter(Boolean);
      rows = words.length ? allTracks().rows.filter((x) => words.every((w) => x.key.includes(w))).slice(0, 5000).map((x) => songVM(x.t, x.e, x.lists)) : [];
      sInfo.textContent = !words.length ? '' : `${plural(rows.length, 'risultato', 'risultati')} in libreria e playlist`;
    } else {
      for (const x of searchRes?.hits ?? []) known.set(x.videoId, hitTrack(x));
      rows = (searchRes?.hits ?? []).map((x) => ({ ...songVM(hitTrack(x)), sub: `${x.channel}${x.available ? '' : ` · ⚠ ${x.reason ?? 'non disponibile'}`}`, skip: !x.available || undefined, bad: !x.available || undefined, reason: x.reason }));
      sInfo.textContent = searching ? 'Cerco su YouTube…' : lastErr ? '' : searchRes ? `${plural(rows.length, 'risultato', 'risultati')} per «${searchQ}» su YouTube${searchRes.via === 'web' ? ' (senza chiave API)' : ''}` : '';
    }
    sInfo.classList.toggle('error', !!lastErr);
    if (lastErr) sInfo.textContent = `⚠ ${lastErr}`;
    sEmpty.querySelector('.es-t')!.textContent = searchQ && !searching && !lastErr ? 'Nessun risultato' : 'Cerca musica';
    sList.set(rows, sameQuery ? 'keep' : 'start');
    sMore.classList.toggle('hidden', src !== 'youtube' || !searchRes?.next || searching);
  }
  // eslint-disable-next-line prefer-const
  let sSel: ReturnType<typeof selectionBar> | undefined;
  sSel = selectionBar(sList, () => `«${searchQ}»`);
  const searchHead = pageHeader('Cerca', sSel.toggleBtn);
  const sCols = cols('g2', '#', 'Titolo · Canale', 'Durata', 'Stato');
  paintTabs();
  const searchPage = h('div', { class: 'pg pg-search' }, searchHead.el,
    h('div', { class: 'pg-card search-card' }, h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Dove cercare' }, ...tabs), h('div', { class: 'pg-row' }, sInput, sGo)),
    sInfo, sSel.bar, sCols, sList.el, sMore);

  // =====================================================================================
  // 🎧 LIBRERIA
  // =====================================================================================
  type LibFilter = 'all' | 'offline' | 'imported' | 'downloaded' | 'fav' | 'artists' | 'albums';
  let libFilter: LibFilter = 'all';
  let libGroup: { kind: 'artist' | 'album'; name: string } | undefined;
  let libQuery = '';
  const libSearch = h('input', { type: 'search', class: 'pg-search libsearch', placeholder: '🔎 Cerca nella libreria', 'aria-label': 'Cerca nella libreria', onInput: () => { libQuery = libSearch.value; paintLibrary(true); } });
  const chipDefs: [LibFilter, string][] = [['all', 'Tutta la musica'], ['offline', 'Offline'], ['downloaded', 'Scaricati'], ['imported', 'Importati'], ['fav', 'Preferiti'], ['artists', 'Artisti'], ['albums', 'Album']];
  const chips = chipDefs.map(([k, l]) => btn(l, 'chip', () => { libFilter = k; libGroup = undefined; paintLibrary(true); }, { 'aria-pressed': 'false' }));
  const libBack = btn('', 'm-text-btn hidden', () => { libGroup = undefined; paintLibrary(true); });
  const libHead = pageHeader('Libreria', btn('+ Importa musica', 'm-filled', () => importMenu()));
  const libEmpty = emptyState('🎧', 'La tua libreria è vuota', 'Importa i tuoi MP3 oppure scarica un brano: la musica della libreria suona anche senza rete.',
    btn('+ Importa musica', 'm-filled', () => importMenu()), btn('🔎 Cerca musica', 'm-tonal', () => d.go('search')));
  const libList = buildSongList({
    label: 'Brani della libreria', cover: true, endLabel: 'Fine della libreria', empty: libEmpty, dragToPlaylists: true,
    onPlay: (r) => {
      if (r.id.startsWith('group:')) { const [, kind, ...name] = r.id.split(':'); libGroup = { kind: kind as 'artist' | 'album', name: name.join(':') }; paintLibrary(true); return; }
      const t = trackOf(r.id); if (t) d.playTrack(t);
    },
    onMore: (r) => {
      if (r.id.startsWith('group:')) { const [, kind, ...name] = r.id.split(':'); libGroup = { kind: kind as 'artist' | 'album', name: name.join(':') }; paintLibrary(true); return; }
      const t = trackOf(r.id); if (t) songMenu(t);
    },
  });
  let lastLibSig = '';
  function paintLibrary(force = false) {
    const sig = `${libFilter}|${libGroup?.name}|${libQuery}|${d.library.version}|${d.playlists.version}|${d.online()}`;
    if (!force && sig === lastLibSig) return;
    const sameView = lastLibSig.split('|').slice(0, 3).join('|') === sig.split('|').slice(0, 3).join('|');
    lastLibSig = sig;
    chips.forEach((c, i) => { const on = chipDefs[i][0] === libFilter; c.setAttribute('aria-pressed', String(on)); c.classList.toggle('on', on); });
    const words = norm(libQuery.trim()).split(/\s+/).filter(Boolean);
    const all = allTracks().rows.filter((x) => words.every((w) => x.key.includes(w)));
    const entries = d.library.all();
    libHead.sub.textContent = `${plural(entries.length, 'brano', 'brani')} in libreria · ${entries.filter((e) => e.file).length} offline · ${fmtSize(d.library.bytes())} ${d.library.where}`;
    libBack.classList.toggle('hidden', !libGroup);
    libBack.textContent = libGroup ? `← ${libGroup.kind === 'artist' ? 'Tutti gli artisti' : 'Tutti gli album'}` : '';
    let rows: SongVM[];
    if ((libFilter === 'artists' || libFilter === 'albums') && !libGroup) {
      const key = libFilter === 'artists' ? (t: Track) => t.artist || 'Artista sconosciuto' : (t: Track) => t.album || '';
      const m = new Map<string, number>();
      for (const x of all) { const k = key(x.t); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
      rows = [...m].sort((a, b) => a[0].localeCompare(b[0], 'it', { sensitivity: 'base' }))
        .map(([name, n]) => ({ id: `group:${libFilter === 'artists' ? 'artist' : 'album'}:${name}`, title: name, artist: plural(n, 'brano', 'brani') }));
      libList.setHead(libFilter === 'artists' ? 'ARTISTI' : 'ALBUM', `${rows.length}`);
    } else {
      const pred: Record<LibFilter, (x: Known) => boolean> = {
        all: (x) => !!x.e, offline: (x) => !!x.e?.file, imported: (x) => x.e?.source === 'file', downloaded: (x) => x.e?.source === 'download' || x.e?.source === 'url',
        fav: (x) => !!x.e?.favorite, artists: (x) => (x.t.artist || 'Artista sconosciuto') === libGroup?.name, albums: (x) => x.t.album === libGroup?.name,
      };
      rows = all.filter(pred[libFilter]).map((x) => songVM(x.t, x.e, x.lists));
      libList.setHead(libGroup ? libGroup.name.toUpperCase() : chipDefs.find(([k]) => k === libFilter)![1].toUpperCase(), plural(rows.length, 'brano', 'brani'));
    }
    libEmpty.querySelector('.es-t')!.textContent = entries.length ? 'Nessun brano qui' : 'La tua libreria è vuota';
    libList.set(rows, sameView ? 'keep' : 'start');
  }
  const libraryPage = h('div', { class: 'pg pg-library' }, libHead.el,
    h('div', { class: 'pg-toolbar' }, libSearch), h('div', { class: 'chips', role: 'group', 'aria-label': 'Mostra' }, ...chips), importMsg, libBack,
    cols('g2', '#', 'Titolo · Artista · Dove si trova', 'Durata', 'Stato'), libList.el, pickFiles, pickFolder, pickOne);
  libraryPage.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); libraryPage.classList.add('dropfiles'); } });
  libraryPage.addEventListener('dragleave', (e) => { if (e.target === libraryPage) libraryPage.classList.remove('dropfiles'); });
  libraryPage.addEventListener('drop', (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); libraryPage.classList.remove('dropfiles'); void importFiles(e.dataTransfer.files); } });

  // =====================================================================================
  // ⬇ DOWNLOAD
  // =====================================================================================
  const libTrackOf = async (j: import('../download/client').DlJob) => { const id = await d.downloads!.libraryId(j); const e = d.library.get(id); return e ? { id, t: d.library.toTrack(e) } : undefined; };
  const dl = d.downloads ? buildDownloadsUI({
    coord: d.downloads,
    playlists: () => d.playlists.list(d.sort()),
    play: (j) => void libTrackOf(j).then((x) => { if (x) d.playTrack(x.t); else d.status('Il file non è ancora nella libreria: riprova tra un attimo.', true); }),
    addToPlaylist: (j) => void libTrackOf(j).then((x) => { if (x) pickPlaylist([x.id]); }),
    openLibrary: () => { libFilter = 'downloaded'; libGroup = undefined; paintLibrary(true); d.go('library'); },
    store: d.store,
  }) : undefined;
  const dlHead = pageHeader('Download');
  const downloadsPage = h('div', { class: 'pg pg-downloads' }, dlHead.el, dl?.el ?? h('p', { class: 'pg-hint' }, 'Il Download Manager funziona nell’app installata sul computer.'));
  dl?.el.classList.remove('hidden', 'panel');

  // =====================================================================================
  // ⚙ IMPOSTAZIONI (the part about search and downloads)
  // =====================================================================================
  const apiKey = h('input', { type: 'password', class: 'pg-input', placeholder: 'Chiave API YouTube (facoltativa)', 'aria-label': 'Chiave API YouTube', autocomplete: 'off',
    onChange: () => { d.setApiKey(apiKey.value.trim()); d.status(apiKey.value.trim() ? 'Chiave salvata: la ricerca usa l’API ufficiale di YouTube.' : 'Chiave tolta.'); } });
  const settingsCard = h('section', { class: 'panel' }, h('h3', {}, 'Ricerca YouTube'),
    h('p', { class: 'artist wrap' }, 'Con una chiave gratuita di «YouTube Data API v3» (console.cloud.google.com → API e servizi → Credenziali) la ricerca usa le API ufficiali, mostra la durata e se il video si può riprodurre, e le playlist si leggono intere anche oltre 200 brani. La chiave resta su questo computer.'),
    apiKey);

  /** Called by the app's tick (4 times a second): repaints only what changed. */
  function update(page: string) {
    if (apiKey.value !== d.apiKey() && document.activeElement !== apiKey) apiKey.value = d.apiKey();
    if (page === 'playlists') { if (detailId) paintDetail(); else paintPlaylists(); }
    else if (page === 'search') paintSearch(false);
    else if (page === 'library') paintLibrary();
    else if (page === 'downloads') { dl?.update(); dlHead.sub.textContent = d.downloads ? `${d.downloads.active()} in corso · ${d.downloads.list().length} in tutto` : ''; }
  }
  paintPlaylists(true);
  paintSearch();
  paintLibrary(true);

  return {
    pages: { playlists: playlistsPage, search: searchPage, library: libraryPage, downloads: d.downloads ? downloadsPage : undefined },
    settingsCard,
    update,
    known: (id: string) => known.get(id),
    songMenu: (id: string) => { const t = trackOf(id); if (t) songMenu(t); },
    pickPlaylist,
    offline,
    importFiles,
    openPlaylist: (id: string) => openDetail(id),
    /** 🔎 in the top bar: a link goes to Download, words to Search. */
    searchFor(q: string) {
      if (/^https?:\/\//i.test(q.trim()) && dl) { d.go('downloads'); dl.prefill(q.trim()); return; }
      sInput.value = q; src = 'youtube'; paintTabs(); d.go('search'); void runSearch(q);
    },
    activeDownloads: () => d.downloads?.active() ?? 0,
  };
}
