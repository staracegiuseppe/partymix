import { DlJob, DlRequest, fmtBytes, STATUS_LABEL } from '../download/client';
import type { DownloadCoordinator } from '../download/manager';
import type { Playlist } from '../library/playlists';
import { h } from './dom';

export type DlPrefs = { type: 'audio' | 'video'; format: string; quality: string };
const PREFS_KEY = 'partymix.dlprefs';
const AUDIO_FORMATS: [string, string][] = [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['best', 'Originale (nessuna conversione)']];
const VIDEO_FORMATS: [string, string][] = [['mp4', 'MP4'], ['webm', 'WebM']];
const QUALITIES: [string, string][] = [['best', 'Best'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];

/** Remembers the last choice (MP3 or MP4…), proposed first next time. */
export function storePrefs(store: Storage | undefined, p: DlPrefs): void { try { store?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not important */ } }

export function loadPrefs(store?: Storage): DlPrefs {
  try {
    const j = JSON.parse(store?.getItem(PREFS_KEY) ?? '{}');
    const type = j.type === 'video' ? 'video' : 'audio';
    const formats = type === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS;
    return { type, format: formats.some(([k]) => k === j.format) ? j.format : formats[0][0], quality: QUALITIES.some(([k]) => k === j.quality) ? j.quality : 'best' };
  } catch { return { type: 'audio', format: 'mp3', quality: 'best' }; }
}

type Deps = {
  coord: DownloadCoordinator;
  playlists: () => Playlist[];
  /** Plays the song of a finished download. */
  play(j: DlJob): void;
  /** «＋ Playlist» on a finished download (opens the playlist menu next to the button). */
  addToPlaylist(j: DlJob, anchor: HTMLElement): void;
  openLibrary(): void;
  store?: Storage;
};

const eta = (s?: number | null) => (s === null || s === undefined ? '' : s >= 3600 ? `ETA ${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `ETA ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `ETA ${s}s`);

/** «⬇ Download»: paste a link, choose audio/video, format, quality and playlist; the queue shows every download with its bar. */
export function buildDownloadsUI(d: Deps) {
  let prefs = loadPrefs(d.store);
  const savePrefs = () => { try { d.store?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not important */ } };

  const url = h('input', { type: 'url', placeholder: 'Incolla URL (YouTube o altra sorgente supportata)', 'aria-label': 'Indirizzo da scaricare' });
  const type = h('select', { 'aria-label': 'Tipo di download' }, h('option', { value: 'audio' }, '🎵 Audio'), h('option', { value: 'video' }, '🎬 Video'));
  const format = h('select', { 'aria-label': 'Formato' });
  const quality = h('select', { 'aria-label': 'Qualità video' }, ...QUALITIES.map(([k, l]) => h('option', { value: k }, l)));
  const playlist = h('select', { 'aria-label': 'Aggiungi alla playlist' });
  const max = h('select', { 'aria-label': 'Download contemporanei', title: 'Quanti download alla volta' }, ...[1, 2, 3, 4].map((n) => h('option', { value: String(n) }, `${n} alla volta`)));
  const go = h('button', { class: 'primary' }, '⬇ Download');
  const tools = h('div', { class: 'status small' });
  /** In corso · In coda · Completati · Errori: each with its title and count, shown only when it has something. */
  const SECTIONS = [['active', 'In corso'], ['queued', 'In coda'], ['done', 'Completati'], ['failed', 'Errori e annullati']] as const;
  type Sec = typeof SECTIONS[number][0];
  const secOf = (j: DlJob): Sec => (j.status === 'DOWNLOADING' || j.status === 'PROCESSING' ? 'active' : j.status === 'QUEUED' ? 'queued' : j.status === 'COMPLETED' ? 'done' : 'failed');
  const secs = Object.fromEntries(SECTIONS.map(([k, label]) => {
    const count = h('span', { class: 'dlsec-n' });
    const list = h('div', { class: 'dllist', role: 'list', 'aria-label': label });
    const el = h('section', { class: 'dlsec hidden', 'data-sec': k }, h('h2', { class: 'dlsec-t' }, label, ' ', count), list);
    return [k, { el, list, count }];
  })) as unknown as Record<Sec, { el: HTMLElement; list: HTMLElement; count: HTMLElement }>;
  const empty = h('div', { class: 'empty-state' }, h('div', { class: 'es-ic', 'aria-hidden': 'true' }, '⬇'), h('div', { class: 'es-t' }, 'Nessun download'), h('p', { class: 'es-p' }, 'Incolla un indirizzo qui sopra, oppure premi ⬇ su un risultato della ricerca o su un brano.'));

  const fillFormats = () => {
    const f = type.value === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS;
    format.replaceChildren(...f.map(([k, l]) => h('option', { value: k }, l)));
    format.value = f.some(([k]) => k === prefs.format) ? prefs.format : f[0][0];
    quality.disabled = type.value === 'audio';
    quality.title = type.value === 'audio' ? 'Per l’audio si prende sempre la qualità migliore' : 'Se la qualità scelta non esiste si prende la più vicina';
  };
  type.value = prefs.type; fillFormats(); quality.value = prefs.quality;
  const remember = () => { prefs = { type: type.value as DlPrefs['type'], format: format.value, quality: quality.value }; savePrefs(); };
  type.addEventListener('change', () => { remember(); fillFormats(); remember(); });
  format.addEventListener('change', remember);
  quality.addEventListener('change', remember);
  max.addEventListener('change', () => void d.coord.setMax(+max.value));

  /** The request from the form (or from ⬇ on a song: same choices, that URL). */
  const request = (u: string, pl?: string): DlRequest => ({ url: u.trim(), type: prefs.type, format: prefs.format, quality: prefs.type === 'video' ? prefs.quality : 'best', ...(pl ? { playlist_id: pl } : {}) });
  async function submit() {
    if (!url.value.trim()) { url.focus(); return; }
    go.disabled = true;
    try { const j = await d.coord.download(request(url.value, playlist.value || undefined)); if (j) url.value = ''; } finally { go.disabled = false; }
  }
  go.addEventListener('click', () => void submit());
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });

  const rows = new Map<string, { el: HTMLElement; sig: string }>();
  function row(j: DlJob): HTMLElement {
    const title = j.meta?.title || j.filename || j.request.url;
    const pct = Math.max(0, Math.min(100, j.progress || 0));
    const busy = j.status === 'QUEUED' || j.status === 'DOWNLOADING' || j.status === 'PROCESSING';
    const btn = (label: string, t: string, fn: (b: HTMLButtonElement) => void, cls = '') => { const b = h('button', { title: t, 'aria-label': t, class: cls }, label); b.addEventListener('click', () => fn(b)); return b; };
    const info = j.status === 'DOWNLOADING'
      ? [`${pct.toFixed(0)}%`, j.speed ?? '', eta(j.eta), j.total_bytes ? `${fmtBytes(j.downloaded_bytes)} / ${fmtBytes(j.total_bytes)}` : ''].filter(Boolean).join(' · ')
      : j.status === 'PROCESSING' ? 'Conversione e salvataggio…'
        : j.status === 'QUEUED' ? 'In attesa del proprio turno'
          : j.status === 'COMPLETED' ? `${fmtBytes(j.meta?.file_size)} · ${j.meta?.local_filename ?? ''}`
            : j.message ?? '';
    const kind = `${j.request.type === 'video' ? '🎬' : '🎵'} ${(j.request.format ?? '').toUpperCase()}${j.request.type === 'video' && j.request.quality !== 'best' ? ` ${j.request.quality}p` : ''}`;
    return h('div', { class: `dlrow ${j.status.toLowerCase()}`, role: 'listitem', 'data-id': j.id },
      h('div', { class: 'dlhead' }, h('span', { class: 't', title: j.request.url }, title), h('span', { class: 'artist small' }, kind), h('span', { class: 'dlstate' }, STATUS_LABEL[j.status])),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, h('i', { style: `width:${j.status === 'COMPLETED' ? 100 : pct}%` })),
      h('div', { class: 'dlinfo artist small' + (j.status === 'FAILED' ? ' err' : '') }, info),
      h('div', { class: 'dlacts' },
        ...(busy ? [btn('Annulla', 'Annulla il download', () => void d.coord.cancel(j.id))] : []),
        ...(j.status === 'COMPLETED' ? [btn('▶ Play', 'Suona adesso', () => d.play(j)), btn('＋ Playlist', 'Aggiungi a una playlist', (b) => d.addToPlaylist(j, b)), btn('📚 Apri libreria', 'Mostra i brani scaricati', () => d.openLibrary())] : []),
        ...(j.status === 'FAILED' || j.status === 'CANCELLED' ? [btn('↻ Riprova', 'Riprova il download', () => void d.coord.retry(j.id))] : []),
        ...(!busy ? [btn('✕', 'Togli dall’elenco (il file scaricato resta nella libreria)', () => void d.coord.remove(j.id), 'ghost')] : [])));
  }

  let lastVersion = -1, lastPl = '';
  function update() {
    const cfg = d.coord.cfg;
    tools.textContent = !cfg ? 'Il Download Manager funziona nell’app installata sul computer (non nel browser).'
      : !cfg.ytdlp ? '⚠ yt-dlp non installato: installalo con «brew install yt-dlp» (Mac), «winget install yt-dlp» (Windows) o dal gestore pacchetti (Linux).'
        : !cfg.ffmpeg ? '⚠ FFmpeg non installato: senza FFmpeg puoi scaricare solo l’audio «Originale» e i video già in un unico file. Installalo con «brew install ffmpeg» o «winget install ffmpeg».'
          : (cfg.ytdlp_age_days ?? 0) > 60 ? `⚠ yt-dlp ${cfg.ytdlp_version} è vecchio (${cfg.ytdlp_age_days} giorni): YouTube cambia spesso e i download falliscono con «HTTP 403». Aggiornalo con «${cfg.update_hint ?? 'yt-dlp -U'}» nel Terminale.`
            : `File salvati in ${cfg.root} · yt-dlp ${cfg.ytdlp_version ?? ''}`;
    tools.classList.toggle('error', !!cfg && (!cfg.ytdlp || !cfg.ffmpeg || (cfg.ytdlp_age_days ?? 0) > 60));
    go.disabled = !cfg?.ytdlp;
    if (cfg && document.activeElement !== max) max.value = String(cfg.max);
    const pls = d.playlists();
    const plSig = pls.map((p) => p.id + p.name).join('|');
    if (plSig !== lastPl) {
      lastPl = plSig;
      const keep = playlist.value;
      playlist.replaceChildren(h('option', { value: '' }, 'Nessuna playlist'), ...pls.map((p) => h('option', { value: p.id }, `＋ ${p.name}`)));
      playlist.value = pls.some((p) => p.id === keep) ? keep : '';
    }
    if (d.coord.version === lastVersion) return;
    lastVersion = d.coord.version;
    const jobs = d.coord.list();
    const seen = new Set<string>();
    const index: Record<Sec, number> = { active: 0, queued: 0, done: 0, failed: 0 };
    // waiting downloads in the order they will start (oldest first), the others newest first
    const ordered = [...jobs.filter((j) => j.status === 'QUEUED').reverse(), ...jobs.filter((j) => j.status !== 'QUEUED')];
    ordered.forEach((j) => {
      const sec = secOf(j);
      const i = index[sec]++;
      const list = secs[sec].list;
      seen.add(j.id);
      const sig = `${j.status}|${Math.round(j.progress * 10)}|${j.speed}|${j.eta}|${j.message}|${j.meta?.title}`;
      let r = rows.get(j.id);
      if (!r || r.sig !== sig) {
        const el = row(j);
        if (r) r.el.replaceWith(el);
        r = { el, sig };
        rows.set(j.id, r);
      }
      if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null);
    });
    for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
    for (const [k] of SECTIONS) { secs[k].count.textContent = String(index[k]); secs[k].el.classList.toggle('hidden', index[k] === 0); }
    empty.classList.toggle('hidden', jobs.length > 0);
  }

  const el = h('section', { class: 'panel dlview hidden' },
    h('div', { class: 'dlform' }, url, go),
    h('div', { class: 'row dlopts' }, type, format, quality, playlist, max),
    tools, empty, ...SECTIONS.map(([k]) => secs[k].el));
  return {
    el, update, request,
    /** A choice made elsewhere (the format dialog) becomes the form's default too. */
    setPrefs(p: DlPrefs) { prefs = p; savePrefs(); type.value = p.type; fillFormats(); format.value = p.format; quality.value = p.quality; },
    /** Puts a link in the box (pasted in the search bar) and focuses it. */
    prefill(u: string) { url.value = u; setTimeout(() => url.focus()); },
  };
}
