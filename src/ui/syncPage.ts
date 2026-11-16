import type { DeviceDoc } from '../../shared/model';
import { isPrivateHost, normalizeUrl, SyncError, type Health, type StorageDoc, type SyncApi } from '../sync/client';
import type { NasConfig } from '../sync/config';
import type { SyncConflict, SyncEngine } from '../sync/engine';
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

  const syncHead = h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, h('h1', { class: 'pg-title' }, 'Sync'), h('div', { class: 'pg-sub' }, 'Le playlist uguali su tutti i tuoi dispositivi, con il NAS al centro')));
  const syncPage = h('div', { class: 'pg pg-sync' }, syncHead, connectPanel, statePanel, conflictPanel, storagePanel);

  let lastPaint = '';
  function paintSync() {
    const cfg = d.config(), eng = d.engine();
    connectPanel.classList.toggle('hidden', !!cfg);
    statePanel.classList.toggle('hidden', !cfg);
    storagePanel.classList.toggle('hidden', !cfg);
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
      pairBox.replaceChildren(h('h3', {}, 'Codice per il nuovo dispositivo'), h('div', { class: 'pair-code' }, code), h('p', { class: 'pg-hint' }, 'Sull’altro dispositivo: ☁ Sync → scrivi l’indirizzo del NAS → «Codice da un altro dispositivo». Vale 5 minuti, una volta sola. ', left));
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
    if (!api) { devMsg.textContent = 'Collega prima il NAS dalla pagina ☁ Sync.'; devList.replaceChildren(); addBtn.disabled = true; return; }
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

  function paintAll() { lastPaint = ''; paintSync(); void refreshDevices(true); }
  paintSync();

  return {
    syncPage,
    devicesPage,
    /** Called by the app's tick: repaints only what changed; the NAS is asked only on the open page, and not too often. */
    update(page: string) {
      if (page === 'sync') { paintSync(); void refreshStorage(); }
      else if (page === 'devices') void refreshDevices();
    },
    /** How many playlists this computer has (shown next to the NAS state). */
    setCounter(fn: () => number) { countPlaylists = fn; },
    repaint: paintAll,
  };
}
