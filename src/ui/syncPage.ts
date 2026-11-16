import type { DeviceDoc } from '../../shared/model';
import { isPrivateHost, normalizeUrl, SyncError, type Health, type StorageDoc, type SyncApi } from '../sync/client';
import type { NasConfig } from '../sync/config';
import type { SyncConflict, SyncEngine } from '../sync/engine';
import type { Uploader } from '../sync/uploader';
import type { NasMusic } from '../sync/nasMusic';
import type { Playlist } from '../library/playlists';
import type { Track } from '../queue';
import type { TrackDoc } from '../../shared/model';
import { h } from './dom';

/** What the ☁ Sync and 📱 Dispositivi pages need from the app. */
export type SyncUIDeps = {
  config(): NasConfig | undefined;
  engine(): SyncEngine | undefined;
  api(): SyncApi | undefined;
  /** Tries the address (no account yet). */
  probe(url: string): Promise<Health>;
  connect(url: string, how: { kind: 'setup' | 'login'; name: string; password: string } | { kind: 'pair'; code: string }): Promise<void>;
  disconnect(): Promise<void>;
  status(text: string, error?: boolean): void;
  now?: () => number;
  /** How this device is called in the texts: «questo computer» (default) or «questo telefono». */
  here?: string;
  /** Where the NAS connection is, in words for the hints («Impostazioni → NAS» on the computer, «NAS» on the phone). */
  where?: string;
  /** Phone only (it has no Cerca page): a search box over the NAS music, with these actions on each song. */
  play?(t: Track): void;
  enqueue?(t: Track, next: boolean): void;
  /** Songs being copied from the NAS to this device, for the list with a bar per file. */
  copies?(): { id: string; title: string; artist: string; state: 'downloading' | 'error'; progress?: number; error?: string }[];
  /** The upload queue to the NAS (when linked). */
  uploader(): Uploader | undefined;
  /** The NAS songs on this device: streaming, copies to listen without the NAS. */
  nasMusic?(): NasMusic | undefined;
  /** This device's playlists (to save the ☁ songs they use). */
  playlists?(): Playlist[];
  /** How many NAS songs are known here, and how many have a copy here. */
  nasCounts?(): { total: number; saved: number; savedBytes: number };
  uploadAuto(): boolean;
  setUploadAuto(on: boolean): void;
};

const FIELD_LABEL: Record<string, string> = { name: 'Nome', description: 'Descrizione', color: 'Colore', cover: 'Copertina', link: 'Link', source: 'Origine', sortOrder: 'Posizione' };
const KIND_ICON: Record<DeviceDoc['kind'], string> = { pc: '💻', android: '📱', ios: '📱', other: '🎵' };
const fmtSize = (b: number | null | undefined) => (b == null ? '—' : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${(b / (1 << 20)).toFixed(0)} MB`);
const btn = (label: string, cls: string, fn: (b: HTMLButtonElement) => void, extra: Record<string, unknown> = {}) => { const b = h('button', { type: 'button', class: cls, ...extra }, label); b.addEventListener('click', () => fn(b)); return b; };

/** «adesso», «3 min fa», «2 h fa», or the date. */
export function ago(t: number | undefined, now = Date.now()): string {
  if (!t) return 'mai';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'adesso';
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function buildSyncUI(d: SyncUIDeps) {
  const now = d.now ?? Date.now;
  const here = d.here ?? 'questo computer';
  const where = d.where ?? 'Impostazioni → NAS';
  const Here = here[0].toUpperCase() + here.slice(1);
  const errText = (e: unknown) => (e instanceof SyncError ? e.message : (e as Error)?.message ?? String(e));

  // =====================================================================================
  // ☁ SYNC — not linked yet: the address, then the account (new, existing, or a code from another device)
  // =====================================================================================
  const urlInput = h('input', { type: 'url', class: 'pg-input', placeholder: 'Indirizzo del NAS, es. 192.168.1.10 o nas.local', 'aria-label': 'Indirizzo del NAS', autocomplete: 'off' });
  const probeMsg = h('p', { class: 'pg-hint' }, 'Il server PartyMix deve essere installato sul NAS (cartella server/ del progetto, Docker). Risponde solo in casa o via VPN.');
  const nameIn = h('input', { type: 'text', class: 'pg-input', placeholder: 'Nome', 'aria-label': 'Nome', autocomplete: 'username' });
  const passIn = h('input', { type: 'password', class: 'pg-input', placeholder: 'Password (almeno 8 caratteri)', 'aria-label': 'Password', autocomplete: 'current-password' });
  const codeIn = h('input', { type: 'text', class: 'pg-input', placeholder: 'Codice a 6 cifre', 'aria-label': 'Codice di abbinamento', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' });
  let health: Health | undefined;
  let mode: 'login' | 'pair' = 'login';
  let busy = false;

  const run = async (b: HTMLButtonElement, fn: () => Promise<void>) => {
    if (busy) return;
    busy = true; b.disabled = true;
    try { await fn(); } catch (e) { d.status(errText(e), true); probeMsg.textContent = errText(e); probeMsg.classList.add('err'); }
    finally { busy = false; b.disabled = false; paintConnect(); }
  };
  const probeBtn = btn('Controlla', 'm-filled', (b) => void run(b, async () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) throw new Error('Scrivi l’indirizzo del NAS.');
    const u = new URL(url);
    if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new Error('Senza HTTPS PartyMix parla solo con indirizzi della rete di casa o della VPN.');
    health = await d.probe(url);
    probeMsg.classList.remove('err');
    probeMsg.textContent = health.setup ? `PartyMix ${health.version} trovato. Accedi con nome e password, o con un codice da un dispositivo già collegato.` : `PartyMix ${health.version} trovato: è nuovo. Crea l’account che userai su tutti i dispositivi.`;
  }));
  const goBtn = btn('Collega', 'm-filled', (b) => void run(b, async () => {
    const url = normalizeUrl(urlInput.value)!;
    if (!health?.setup) await d.connect(url, { kind: 'setup', name: nameIn.value.trim(), password: passIn.value });
    else if (mode === 'login') await d.connect(url, { kind: 'login', name: nameIn.value.trim(), password: passIn.value });
    else await d.connect(url, { kind: 'pair', code: codeIn.value.trim() });
    passIn.value = ''; codeIn.value = '';
    d.status('NAS collegato: le playlist si sincronizzano da sole.');
  }));
  const modeBtns = (['login', 'pair'] as const).map((m) => btn(m === 'login' ? 'Nome e password' : 'Codice da un altro dispositivo', 'seg-btn', () => { mode = m; paintConnect(); }, { role: 'tab' }));
  const accountBox = h('div', { class: 'sync-account hidden' });
  const connectPanel = h('section', { class: 'panel sync-connect' },
    h('h3', {}, 'Collega il NAS'),
    h('div', { class: 'row' }, urlInput, probeBtn),
    probeMsg,
    accountBox);
  function paintConnect() {
    accountBox.classList.toggle('hidden', !health);
    if (!health) return;
    const setup = !health.setup;
    accountBox.replaceChildren(
      setup ? h('p', { class: 'pg-hint' }, `Primo avvio: scegli nome e password dell’account PartyMix. ${Here} sarà il primo dispositivo autorizzato.`) : h('div', { class: 'seg', role: 'tablist' }, ...modeBtns),
      ...(setup || mode === 'login' ? [h('div', { class: 'row' }, nameIn, passIn)] : [h('p', { class: 'pg-hint' }, 'Su un dispositivo già collegato: 📱 Dispositivi → «+ Aggiungi dispositivo», poi scrivi qui il codice.'), h('div', { class: 'row' }, codeIn)]),
      h('div', { class: 'row' }, goBtn));
    modeBtns.forEach((b, i) => { const on = (i === 0 ? 'login' : 'pair') === mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    goBtn.textContent = setup ? 'Crea account e collega' : 'Collega';
  }

  // =====================================================================================
  // ☁ SYNC — linked: state of the NAS, pending changes, conflicts, storage
  // =====================================================================================
  const dot = h('span', { class: 'sync-dot' });
  const stateText = h('b', {});
  const urlText = h('div', { class: 'artist' });
  const whoText = h('div', { class: 'artist' });
  const lastText = h('div', {});
  const countText = h('div', {});
  const pendingText = h('div', {});
  const newsText = h('div', { class: 'pg-hint' });
  const errBox = h('p', { class: 'pg-hint err hidden' });
  const syncBtn = btn('Sincronizza ora', 'm-filled', () => void d.engine()?.syncNow());
  const unlinkBtn = btn('Scollega', 'm-outlined', (b) => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sicuro? Scollega'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Scollega'; }, 3000); return; }
    void d.disconnect().then(() => { b.dataset.sure = ''; b.textContent = 'Scollega'; health = undefined; d.status(`NAS scollegato: le playlist restano su ${here}.`); paintAll(); });
  });
  const statePanel = h('section', { class: 'panel sync-state' },
    h('h3', {}, 'NAS'),
    h('div', { class: 'sync-line' }, dot, stateText),
    urlText, whoText,
    h('div', { class: 'sync-grid' }, lastText, countText, pendingText),
    newsText, errBox,
    h('div', { class: 'row' }, syncBtn, unlinkBtn));

  const conflictList = h('div', { class: 'sync-conflicts' });
  const conflictPanel = h('section', { class: 'panel hidden' }, h('h3', {}, 'Da decidere'), h('p', { class: 'pg-hint' }, 'Due dispositivi hanno cambiato la stessa cosa in modi diversi. Niente è stato perso: scegli quale versione tenere.'), conflictList);
  function conflictRow(c: SyncConflict) {
    const eng = d.engine()!;
    if (c.kind === 'field') {
      return h('div', { class: 'conflict' },
        h('div', { class: 'conflict-t' }, `«${c.name}» · ${FIELD_LABEL[c.field] ?? c.field}`),
        h('div', { class: 'conflict-v' }, h('span', {}, 'Qui: ', h('b', {}, String(c.mine ?? '—'))), h('span', {}, 'Sul NAS: ', h('b', {}, String(c.theirs ?? '—')))),
        h('div', { class: 'row' }, btn(`Usa ${here}`, 'm-tonal', () => void eng.resolve(c, 'mine')), btn('Usa il NAS', 'm-outlined', () => void eng.resolve(c, 'theirs'))));
    }
    return h('div', { class: 'conflict' },
      h('div', { class: 'conflict-t' }, `«${c.name}» è stata eliminata su un altro dispositivo, ma qui l’hai modificata.`),
      h('div', { class: 'row' }, btn('Tienila (rimettila sul NAS)', 'm-tonal', () => void eng.resolve(c, 'mine')), btn('Elimina anche qui', 'm-outlined', () => void eng.resolve(c, 'theirs'))));
  }

  // ---- the files: how many are on the NAS, what is going up, what failed ----
  const upText = h('div', {});
  const upBtn = btn('Carica ora', 'm-tonal', () => { d.uploader()?.uploadNow(); d.status('Controllo quali brani mancano sul NAS e carico quelli che non ci sono.'); });
  const autoBox = h('input', { type: 'checkbox', id: 'nas-upload-auto' }) as HTMLInputElement;
  autoBox.addEventListener('change', () => { d.setUploadAuto(autoBox.checked); if (autoBox.checked) d.uploader()?.uploadNow(); d.status(autoBox.checked ? 'I brani importati vanno sul NAS da soli.' : 'I brani restano solo su questo computer finché non premi «Carica ora».'); });
  const uploadPanel = h('section', { class: 'panel sync-files' }, h('h3', {}, 'Brani sul NAS'),
    h('div', { class: 'sync-upload' }, upText, upBtn),
    h('div', { class: 'sync-upload' }, h('label', { for: 'nas-upload-auto' }, autoBox, 'Carica sul NAS i brani importati')),
    h('p', { class: 'pg-hint' }, 'Ogni file va sul NAS una volta sola: se c’è già, viene solo collegato. Un file arrivato danneggiato viene scartato e segnato come errore.'));

  // one line per file: what is going up, what waits, what failed (and why), what just arrived
  const STATE_TEXT: Record<string, string> = { uploading: '⬆ Caricamento', checking: '🔎 Controllo', queued: '⏳ In attesa', error: '⚠ Non riuscito', done: '✓ Sul NAS', downloading: '⬇ Salvataggio' };
  const listFilter = { v: 'all' as 'all' | 'active' | 'error' };
  const filterBtns = (['all', 'active', 'error'] as const).map((f) => btn(f === 'all' ? 'Tutti' : f === 'active' ? 'In corso' : 'Non riusciti', 'chip', () => { listFilter.v = f; lastList = ''; paintList(); }));
  const listHead = h('div', { class: 'chips' }, ...filterBtns);
  const listBox = h('div', { class: 'up-list', role: 'list', 'aria-label': 'Avanzamento dei file' });
  const listPanel = h('section', { class: 'panel up-panel' }, h('h3', {}, 'Avanzamento dei file'), listHead, listBox);
  let lastList = '';
  function fileRow(r: { id: string; title: string; artist: string; state: string; progress?: number; error?: string }, retry?: () => void) {
    const pct = r.state === 'done' ? 100 : Math.round((r.progress ?? 0) * 100);
    return h('div', { class: `up-row ${r.state}`, role: 'listitem' },
      h('div', { class: 'up-t' }, h('span', { class: 'up-title' }, r.title), r.artist ? h('span', { class: 'up-artist' }, ` · ${r.artist}`) : null),
      h('div', { class: 'up-s' }, (STATE_TEXT[r.state] ?? r.state) + (r.state === 'uploading' || r.state === 'downloading' ? ` ${pct}%` : '')),
      h('div', { class: `up-bar ${r.state}` }, h('span', { style: `width:${r.state === 'queued' || r.state === 'checking' ? 0 : pct}%` })),
      r.error ? h('div', { class: 'up-err' }, r.error) : null,
      retry && r.state === 'error' ? btn('Riprova', 'm-text-btn up-retry', retry) : null);
  }
  function paintList() {
    const up = d.uploader();
    const rows = [...(up?.list() ?? []).map((r) => ({ r: r as Parameters<typeof fileRow>[0], retry: (() => up?.retry(r.id)) as (() => void) | undefined })), ...(d.copies?.() ?? []).map((r) => ({ r: r as Parameters<typeof fileRow>[0], retry: undefined }))];
    listPanel.classList.toggle('hidden', !rows.length);
    if (!rows.length) return;
    const f = listFilter.v;
    const shown = rows.filter(({ r }) => f === 'all' || (f === 'error' ? r.state === 'error' : r.state !== 'error' && r.state !== 'done')).slice(0, 200);
    const key = JSON.stringify([f, rows.length, shown.map(({ r }) => [r.id, r.state, Math.round((r.progress ?? 0) * 100), r.error])]);
    if (key === lastList) return;
    lastList = key;
    const n = { all: rows.length, active: rows.filter(({ r }) => r.state !== 'error' && r.state !== 'done').length, error: rows.filter(({ r }) => r.state === 'error').length };
    filterBtns.forEach((b, i) => { const k = (['all', 'active', 'error'] as const)[i]; b.classList.toggle('on', k === f); b.textContent = `${k === 'all' ? 'Tutti' : k === 'active' ? 'In corso' : 'Non riusciti'} (${n[k]})`; });
    listBox.replaceChildren(...(shown.length ? shown.map(({ r, retry }) => fileRow(r, retry)) : [h('p', { class: 'pg-hint' }, 'Niente qui.')]));
  }
  let lastUp = '';

  function paintUpload() {
    const up = d.uploader();
    uploadPanel.classList.toggle('hidden', !up);
    if (!up) return;
    const sm = up.summary();
    const key = JSON.stringify([sm, d.uploadAuto()]);
    if (key === lastUp) return;
    lastUp = key;
    upText.replaceChildren('Brani sul NAS: ', h('b', {}, `${sm.onNas} su ${sm.total}`), ' · ⬆ in corso: ', h('b', {}, String(sm.uploading)), ' · ⚠ falliti: ', h('b', {}, String(sm.failed)));
    upBtn.disabled = sm.total === sm.onNas && !sm.failed;
    if (autoBox.checked !== d.uploadAuto()) autoBox.checked = d.uploadAuto();
  }

  // ---- the NAS songs on this device: listen in streaming, or keep a copy to listen without the NAS ----
  const mText = h('div', {});
  const mJob = h('div', { class: 'pg-hint' });
  const runSave = async (which: 'playlists' | 'all') => {
    const m = d.nasMusic?.();
    if (!m) return;
    const ids = which === 'all' ? m.missing() : m.missing(d.playlists?.() ?? []);
    if (!ids.length) { d.status(which === 'all' ? `Tutta la musica del NAS è già su ${here}.` : `I brani del NAS delle tue playlist sono già su ${here}.`); return; }
    try { await m.save(ids); d.status(`⬇ Salvo ${ids.length} brani su ${here} (${fmtSize(m.sizeOf(ids))}).`); } catch (e) { d.status(errText(e), true); }
  };
  const savePlBtn = btn('⬇ Salva i brani delle playlist', 'm-tonal', () => void runSave('playlists'));
  const saveAllBtn = btn('⬇ Salva tutta la musica del NAS', 'm-outlined', () => void runSave('all'));
  const stopBtn = btn('Ferma', 'm-outlined', () => d.nasMusic?.()?.stop());
  const scanMsg = h('div', { class: 'pg-hint' });
  const scanBtn = btn('🔄 Aggiorna dalla cartella music del NAS', 'm-outlined', async (b) => {
    const api = d.api();
    if (!api?.scan) return;
    b.disabled = true;
    scanMsg.textContent = 'Controllo la cartella PartyMix/music del NAS…';
    try {
      await api.scan();
      for (let i = 0; i < 600; i++) { // up to 10 minutes: hashing a big folder on a small NAS takes a while
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.scanStatus!();
        if (!s.running) {
          const l = s.last;
          const msg = !l ? 'Controllo finito.'
            : !l.found ? 'Nella cartella music non ci sono file nuovi: tutto quello che c’è è già nell’elenco del NAS.'
            : `Trovati ${l.found} file nuovi: ${l.added} aggiunti${l.duplicates ? `, ${l.duplicates} già presenti (doppioni)` : ''}${l.failed ? `, ${l.failed} non leggibili` : ''}.`;
          scanMsg.textContent = `${msg} (${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })})`;
          d.status(`🔄 ${msg}`);
          void d.engine()?.syncNow();
          break;
        }
      }
    } catch (e) { scanMsg.textContent = `Controllo non riuscito: ${errText(e)}`; d.status(scanMsg.textContent, true); }
    b.disabled = false;
  });
  const musicPanel = h('section', { class: 'panel sync-music' }, h('h3', {}, `Musica del NAS su ${here}`),
    mText,
    h('div', { class: 'sync-upload' }, savePlBtn, saveAllBtn, stopBtn),
    mJob,
    h('div', { class: 'sync-upload' }, scanBtn), scanMsg,
    h('p', { class: 'pg-hint' }, `☁ = suona dal NAS quando sei a casa (o in VPN). ✓ = salvato su ${here}: suona anche senza NAS. I file copiati a mano (File Station, cartella condivisa) nella cartella PartyMix/music del NAS entrano nell’elenco con «Aggiorna dalla cartella music». Per trovare un brano usa la ricerca${d.play ? ' qui sopra' : ' (Cerca → ☁ NAS)'}.`));

  // ---- phone: search the NAS music (the computer has it in Cerca → ☁ NAS) ----
  const nsInput = h('input', { type: 'search', class: 'pg-input', placeholder: 'Cerca sul NAS: titolo, artista, album', 'aria-label': 'Cerca sul NAS' }) as HTMLInputElement;
  const nsInfo = h('div', { class: 'pg-hint' });
  const nsList = h('div', { class: 'up-list ns-list', role: 'list' });
  const searchPanel = h('section', { class: 'panel ns-panel' }, h('h3', {}, '🔎 Cerca sul NAS'), nsInput, nsInfo, nsList);
  let nsTimer: ReturnType<typeof setTimeout> | undefined, nsSeq = 0;
  const toTrack = (t: TrackDoc): Track => ({ videoId: `nas:${t.id}`, title: t.title, artist: t.artist ?? '', ...(t.album ? { album: t.album } : {}), ...(t.durationSec ? { durationSec: t.durationSec } : {}), status: 'ok', manual: true });
  async function nasSearch() {
    const api = d.api(), q = nsInput.value.trim(), my = ++nsSeq;
    if (!api) return;
    nsInfo.textContent = 'Cerco…';
    try {
      const page = await api.library(undefined, 60, q);
      if (my !== nsSeq) return;
      nsInfo.textContent = page.tracks.length ? `${page.tracks.length}${page.next ? '+' : ''} brani${q ? ` per «${q}»` : ''}` : 'Nessun brano trovato.';
      nsList.replaceChildren(...page.tracks.map((t) => {
        const tr = toTrack(t);
        return h('div', { class: 'up-row ns-row', role: 'listitem' },
          h('div', { class: 'up-t' }, h('span', { class: 'up-title' }, t.title), t.artist ? h('span', { class: 'up-artist' }, ` · ${t.artist}`) : null),
          h('div', { class: 'ns-a' },
            btn('▶', 'm-tonal', () => d.play?.(tr), { title: 'Suona adesso', 'aria-label': `Suona ${t.title}` }),
            btn('⤵', 'm-outlined', () => d.enqueue?.(tr, false), { title: 'Metti in coda', 'aria-label': `Metti in coda ${t.title}` }),
            btn('⬇', 'm-outlined', () => { d.nasMusic?.()?.save([tr.videoId]).then(() => d.status(`⬇ Salvo «${t.title}» su ${here}.`), (e) => d.status(errText(e), true)); }, { title: `Salva su ${here}`, 'aria-label': `Salva ${t.title}` })));
      }));
    } catch (e) { if (my === nsSeq) nsInfo.textContent = `Ricerca non riuscita: ${errText(e)}`; }
  }
  nsInput.addEventListener('input', () => { clearTimeout(nsTimer); nsTimer = setTimeout(() => void nasSearch(), 350); });
  let lastMusic = '';
  function paintMusic() {
    const m = d.nasMusic?.();
    musicPanel.classList.toggle('hidden', !m);
    if (!m) return;
    const c = d.nasCounts?.() ?? { total: 0, saved: 0, savedBytes: 0 };
    const j = m.status();
    const key = JSON.stringify([c, j]);
    if (key === lastMusic) return;
    lastMusic = key;
    mText.replaceChildren('Brani sul NAS: ', h('b', {}, c.total.toLocaleString('it-IT')), ` · ✓ salvati su ${here}: `, h('b', {}, `${c.saved.toLocaleString('it-IT')} (${fmtSize(c.savedBytes)})`));
    mJob.textContent = j.running ? `⬇ ${j.done + j.failed}/${j.total} · ${fmtSize(j.bytes)} / ${fmtSize(j.totalBytes)}${j.current ? ` · ${j.current}` : ''}` : j.total ? `Ultimo salvataggio: ${j.done} salvati${j.failed ? `, ${j.failed} non riusciti (${j.error ?? ''})` : ''}.` : '';
    stopBtn.classList.toggle('hidden', !j.running);
    savePlBtn.disabled = saveAllBtn.disabled = j.running;
  }

  const storText = h('div', { class: 'sync-grid' });
  const storagePanel = h('section', { class: 'panel' }, h('h3', {}, 'Spazio sul NAS'), storText);
  let storage: StorageDoc | undefined, storageAt = 0;
  async function refreshStorage() {
    const api = d.api();
    if (!api || now() - storageAt < 30_000) return;
    storageAt = now();
    try { storage = await api.storage(); } catch { storage = undefined; }
    storText.replaceChildren(h('div', {}, 'Musica: ', h('b', {}, storage ? `${fmtSize(storage.musicBytes)} · ${storage.tracks.toLocaleString('it-IT')} brani` : '—')), h('div', {}, 'Libero: ', h('b', {}, fmtSize(storage?.freeBytes))), h('div', {}, 'Totale: ', h('b', {}, fmtSize(storage?.totalBytes))));
  }

  const syncHead = h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, h('h2', { class: 'pg-title' }, '☁ NAS e sincronizzazione'), h('div', { class: 'pg-sub' }, 'Le playlist uguali su tutti i tuoi dispositivi, con il NAS al centro')));
  const syncPage = h('div', { class: 'pg pg-sync' }, syncHead, connectPanel, statePanel, conflictPanel);
  const filesHead = h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, h('h2', { class: 'pg-title' }, '☁ Musica sul NAS'), h('div', { class: 'pg-sub' }, `Caricamenti, brani del NAS su ${here}, spazio`)));
  const filesNotLinked = h('p', { class: 'pg-hint' }, `Il NAS non è collegato: collegalo da ${where}.`);
  const filesPage = h('div', { class: 'pg pg-nasfiles' }, filesHead, filesNotLinked, ...(d.play ? [searchPanel] : []), uploadPanel, listPanel, musicPanel, storagePanel);

  let lastPaint = '';
  function paintSync() {
    const cfg = d.config(), eng = d.engine();
    connectPanel.classList.toggle('hidden', !!cfg);
    statePanel.classList.toggle('hidden', !cfg);
    if (!cfg || !eng) { conflictPanel.classList.add('hidden'); return; }
    const s = eng.status();
    const key = JSON.stringify([s.connected, s.live, s.syncing, s.lastSync, s.pending, s.error, s.lastNews, s.conflicts.length, Math.floor(now() / 30_000)]);
    if (key === lastPaint) return;
    lastPaint = key;
    dot.className = `sync-dot ${s.syncing ? 'busy' : s.connected ? 'on' : 'off'}`;
    stateText.textContent = s.syncing ? 'Sincronizzazione in corso…' : s.connected ? (s.live ? 'Connesso, aggiornamenti in tempo reale' : 'Connesso') : 'Non raggiungibile';
    urlText.textContent = cfg.url;
    whoText.textContent = `${cfg.userName} · ${here} è «${cfg.deviceName}»`;
    lastText.replaceChildren('Ultima sincronizzazione: ', h('b', {}, ago(s.lastSync, now())));
    countText.replaceChildren('Playlist: ', h('b', {}, String(eng ? countPlaylists() : 0)));
    pendingText.replaceChildren('In attesa: ', h('b', {}, s.pending ? `${s.pending} modifiche` : 'niente'));
    newsText.textContent = s.lastNews ? `Ultime novità: ${s.lastNews}` : '';
    errBox.textContent = s.error ?? '';
    errBox.classList.toggle('hidden', !s.error);
    syncBtn.disabled = s.syncing;
    conflictPanel.classList.toggle('hidden', !s.conflicts.length);
    conflictList.replaceChildren(...s.conflicts.map(conflictRow));
  }
  let countPlaylists = () => 0;

  // =====================================================================================
  // 📱 DISPOSITIVI
  // =====================================================================================
  const devList = h('div', { class: 'dev-list' });
  const devMsg = h('p', { class: 'pg-hint' });
  const pairBox = h('section', { class: 'panel hidden' });
  const addBtn = btn('+ Aggiungi dispositivo', 'm-filled', (b) => void (async () => {
    const api = d.api();
    if (!api) return;
    b.disabled = true;
    try {
      const { code, expiresAt } = await api.pairCode();
      pairBox.classList.remove('hidden');
      const left = h('span', {});
      pairBox.replaceChildren(h('h3', {}, 'Codice per il nuovo dispositivo'), h('div', { class: 'pair-code' }, code), h('p', { class: 'pg-hint' }, `Sull’altro dispositivo: ${where} → scrivi l’indirizzo del NAS → «Codice da un altro dispositivo». Vale 5 minuti, una volta sola. `, left));
      const tick = () => { const s = Math.max(0, Math.round((expiresAt - now()) / 1000)); left.textContent = s ? `Scade tra ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'Scaduto.'; if (!s) { clearInterval(iv); } };
      const iv = setInterval(tick, 1000); tick();
    } catch (e) { d.status(errText(e), true); }
    finally { b.disabled = false; }
  })());
  const devHead = h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, h('h1', { class: 'pg-title' }, 'Dispositivi'), h('div', { class: 'pg-sub' }, 'Chi può usare la tua libreria sul NAS')), h('div', { class: 'pg-actions' }, addBtn));
  const devicesPage = h('div', { class: 'pg pg-devices' }, devHead, devMsg, pairBox, h('section', { class: 'panel' }, devList));
  let devices: DeviceDoc[] = [], devicesAt = 0;
  async function refreshDevices(force = false) {
    const api = d.api();
    if (!api) { devMsg.textContent = `Collega prima il NAS da ${where}.`; devList.replaceChildren(); addBtn.disabled = true; return; }
    addBtn.disabled = false;
    if (!force && now() - devicesAt < 15_000) return;
    devicesAt = now();
    try { devices = await api.devices(); devMsg.textContent = ''; } catch (e) { devMsg.textContent = errText(e); return; }
    devList.replaceChildren(...devices.map(devRow));
  }
  function devRow(dev: DeviceDoc) {
    const api = d.api()!;
    const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); d.status(done); await refreshDevices(true); } catch (e) { d.status(errText(e), true); } };
    const name = h('b', {}, dev.name);
    const rename = btn('Rinomina', 'm-text-btn', () => {
      const inp = h('input', { type: 'text', class: 'pg-rename', value: dev.name, 'aria-label': 'Nuovo nome' });
      name.replaceWith(inp); inp.focus(); inp.select();
      const finish = (ok: boolean) => { inp.replaceWith(name); if (ok && inp.value.trim() && inp.value.trim() !== dev.name) void act(() => api.renameDevice(dev.id, inp.value.trim()), 'Dispositivo rinominato.'); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
    });
    const revoke = btn(dev.current ? 'Esci' : 'Revoca', 'm-text-btn danger', (b) => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sicuro?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = dev.current ? 'Esci' : 'Revoca'; }, 3000); return; }
      if (dev.current) void d.disconnect().then(() => { d.status('NAS scollegato.'); paintAll(); });
      else void act(() => api.revokeDevice(dev.id), `«${dev.name}» non può più usare il NAS.`);
    });
    return h('div', { class: `dev-row${dev.revoked ? ' revoked' : ''}` },
      h('span', { class: 'dev-ic', 'aria-hidden': 'true' }, KIND_ICON[dev.kind] ?? '🎵'),
      h('div', { class: 'dev-t' }, name, dev.current ? h('span', { class: 'dev-me' }, ` · ${here}`) : null,
        h('div', { class: 'artist' }, dev.revoked ? 'Accesso revocato' : `Visto ${ago(dev.lastSeen, now())} · ${dev.perms.includes('ADMIN') ? 'amministratore' : dev.perms.includes('EDIT_PLAYLIST') ? 'può modificare le playlist' : 'solo ascolto'}`)),
      h('div', { class: 'dev-a' }, ...(dev.revoked ? [] : [rename, revoke])));
  }

  /** The NAS files part (Libreria on the computer): uploads with a bar per file, NAS songs here, space. */
  function paintFiles() {
    const linked = !!d.config() && !!d.engine();
    filesNotLinked.classList.toggle('hidden', linked);
    storagePanel.classList.toggle('hidden', !linked);
    searchPanel.classList.toggle('hidden', !linked);
    if (!linked) { uploadPanel.classList.add('hidden'); musicPanel.classList.add('hidden'); listPanel.classList.add('hidden'); return; }
    if (d.play && !nsSeq) void nasSearch(); // first look: the latest songs, before typing
    paintUpload();
    paintMusic();
    paintList();
  }
  function paintAll() { lastPaint = ''; paintSync(); paintFiles(); void refreshDevices(true); }
  paintSync();
  paintFiles();

  return {
    syncPage,
    filesPage,
    devicesPage,
    /** Called by the app's tick: repaints only what changed; the NAS is asked only on the open page, and not too often. */
    update(page: string) {
      if (page === 'sync') paintSync();
      else if (page === 'files') { paintFiles(); void refreshStorage(); }
      else if (page === 'devices') void refreshDevices();
    },
    /** How many playlists this computer has (shown next to the NAS state). */
    setCounter(fn: () => number) { countPlaylists = fn; },
    repaint: paintAll,
  };
}
