import { isIOSApp, isTablet } from './platform';
import { canCast, castMessage, castState, ensureLocalNetwork, isAndroidApp, onSharedLink, openAppSettings } from './androidBridge';
import './ui/style.css';
import './ui/material.css';
import './ui/desktop.css';
import { Automix } from './automix';
import { log, setSinks } from './log';
import { buildTracks, oembedMeta, parsePlaylistPage, verifyReplacement } from './playlistLoader';
import { diffPlaylist } from './playlistSync';
import { parsePlaylistInput } from './playlistUrl';
import { Queue, Track } from './queue';
import { Align, alignFromAnchors, findLyrics, lyricsFrom, TransientError, IDENTITY, indexFor, Lyrics, shiftAlign, snapshotAt, toLyricTime, karaokeAlign, lineProgress, introEnd } from './lyrics';
import { loadSettings, saveSettings } from './settings';
import { buildConsole, DeckVM, ViewModel } from './ui/console';
import { bindShortcuts } from './ui/shortcuts';
import { AdGuard } from './adGuard';
import { isSpotLength } from './adDetector';
import { adDebug, debugPlaylist, debugSpotMode, hasSystemAudio, startSystemAudio, stopSystemAudio } from './systemAudio';
import { KaraokeJob, JobTrack } from './karaokeJob';
import { LyricsStore } from './lyricsStore';
import { throttled } from './throttle';
import { parseSpotifyInput } from './spotify';
import { loadSpotifyList } from './spotifyLoader';
import { closeProjector, hasNativeDisplays, listDisplays, nativeGet, openProjector } from './projector/launcher';
import { openKV, KV } from './library/kv';
import { migrateLegacy, PlaylistStore, Playlist } from './library/playlists';
import { MusicLibrary, probeWithAudio } from './library/library';
import { KvBlobStore, NativeBlobStore } from './library/blobStore';
import { AudioDeck, HybridDeck, sourceText } from './audioDeck';
import { Cues, cuePoints } from './cues';
import { buildDesktopPages } from './ui/desktopPages';
import type { DesktopParts } from './ui/console';
import { materialUI } from './ui/material';
import { readPlaylistApi, searchYouTube } from './ytSearch';
import { tauriDownloadClient } from './download/client';
import { DownloadCoordinator } from './download/manager';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { followSystemTheme } from './ui/systemTheme';
import { listInputs } from './projector/mic';
import { createYouTubeDeck } from './youtubeDeck';
import { HttpSyncClient, isPrivateHost, type SyncApi } from './sync/client';
import { loadNasConfig, saveNasConfig, type NasConfig } from './sync/config';
import { SyncEngine } from './sync/engine';
import { Uploader } from './sync/uploader';
import { NasMusic } from './sync/nasMusic';

const store: Storage | undefined = (() => { try { return window.localStorage; } catch { return undefined; } })();
const settings = store ? loadSettings(store) : loadSettings({ getItem: () => null, setItem: () => {} } as unknown as Storage);
const save = () => store && saveSettings(store, settings);
/** Where the saved playlists live, as the user calls it. */
const DEVICE = isIOSApp() ? (isTablet() ? 'iPad' : 'iPhone') : isAndroidApp() ? 'telefono' : 'PC';

// Problems the user should see, in plain Italian.
const problems: string[] = [];
const PROBLEM_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  'deck.load_failed': () => 'Un brano non si carica: è stato saltato.',
  'deck.prepare_failed': () => 'Il brano successivo non si carica: è stato saltato.',
  'deck.prepare_timeout': () => 'Il brano successivo non era pronto in tempo: è stato saltato.',
  'deck.error': (d) => `Errore del player YouTube (codice ${d.code}).`,
  'youtube.error': (d) => String(d.reason ?? 'Errore del player YouTube'),
  'audio.levels_failed': () => 'Non riesco ad analizzare il file del brano: testo e mix restano senza correzioni per l’intro.',
};
setSinks([
  (l) => console.log(l),
  (l) => {
    const o = JSON.parse(l);
    const f = PROBLEM_TEXT[o.event];
    if (!f) return;
    const t = new Date().toTimeString().slice(0, 5);
    problems.unshift(`${t} ${f(o)}`);
    problems.length = Math.min(problems.length, 6);
  },
]);

// --- Storage: playlists and music library in IndexedDB (no 5 MB limit), audio files in Music/PartyMix Library on the computer. ---
const kvReady = openKV();
const kv: KV = {
  get: async (st, k) => (await kvReady).get(st, k),
  getAll: async (st) => (await kvReady).getAll(st),
  put: async (st, k, v) => (await kvReady).put(st, k, v),
  delete: async (st, k) => (await kvReady).delete(st, k),
};
const tauriInvoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke(c: string, a?: unknown, o?: unknown): Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
/** The computer console (not the phone or tablet layout): the only one with the library, the side bar and the YouTube search. */
/** The app on a computer (Tauri on macOS/Windows/Linux): its own files on disk, Download Manager, system colours. */
const computerApp = !materialUI() && !isIOSApp() && !isAndroidApp();
/** The phone (Android app, or ?android in the browser): same pages as the computer, laid out for a phone. */
const phoneUI = !isIOSApp() && materialUI();
/** The pages of the computer (Playlist, Cerca, Libreria, Impostazioni): computer and Android alike. */
const desktopUI = !isIOSApp();
const plStore = new PlaylistStore(kv);
const library = new MusicLibrary({
  kv,
  blobs: computerApp && tauriInvoke ? new NativeBlobStore((c, a, o) => tauriInvoke(c, a, o), convertFileSrc) : new KvBlobStore(kv),
  probe: (b) => probeWithAudio(b),
});
window.addEventListener('pagehide', () => void plStore.flush().catch(() => {}));

/** YouTube's players are ready (they need the internet). Without them the library still plays. */
let ytReady = false;
/** Network usable: navigator.onLine says the computer has a network, ytReady that YouTube answered. */
const netOk = () => navigator.onLine && ytReady;
const mkAudio = () => {
  const a = document.createElement('audio');
  a.preload = 'auto';
  a.style.display = 'none';
  document.body.append(a);
  return new AudioDeck(a);
};
// a song of the NAS without a copy here plays in streaming from the NAS (a short signed link)
const hybridDeps = { localUrl: async (id: string) => (await library.urlFor(id)) ?? (id.startsWith('nas:') ? await nasMusic?.streamUrl(id) : undefined), canStream: netOk, preferYouTube: () => settings.projectorMode === 'video' };
const decks: [HybridDeck, HybridDeck] = [new HybridDeck(mkAudio(), hybridDeps), new HybridDeck(mkAudio(), hybridDeps)];
let queue = new Queue([]);
let listId: string | undefined;
const replaced = new Set<string>();
let refreshing = false;
let lastAttempt = Date.now();
let am: Automix | undefined;
const sliders: [number, number] = [100, 100];
const ducked: [boolean, boolean] = [false, false];
/** Lowered by the app itself because a spoken ad was heard (the user's own button is `ducked`). */
const autoDucked: [boolean, boolean] = [false, false];

function makeAutomix(): Automix {
  return new Automix({
    decks: decks!, queue,
    profile: () => settings.profile,
    masterVolume: () => settings.master,
    deckVolume: (i) => (sliders[i] / 100) * (ducked[i] || autoDucked[i] ? 0.2 : 1),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    log,
    online: netOk,
    cues: cuesFor,
  });
}

function setQueue(tracks: Track[]) {
  am?.stop();
  for (const t of tracks) if (settings.locked.includes(t.videoId)) t.locked = true;
  queue = new Queue(tracks, { shuffle: settings.shuffle, repeat: settings.repeat, available: (t) => netOk() || library.isOffline(t.videoId) });
  transient.clear();
  am = makeAutomix();
}

/** Songs played from the library or the search while a playlist is on: in the queue, not saved into the playlist. */
const transient = new Set<string>();
const trackOf = (id: string) => queue.all().find((t) => t.videoId === id);
const titleOf = (t?: Track) => (t ? t.title || `Video ${t.videoId}` : '');

async function probe(videoId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!ytReady || (am && am.state() !== 'idle')) return { ok: true }; // never disturb a running party
  try { await decks[1].load(videoId); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; }
}

/** Reads a playlist's video ids without interrupting the music: while the party runs it uses the spare deck. */
async function readIds(id: string): Promise<string[]> {
  if (settings.ytApiKey) {
    // the official API reads the whole playlist, also beyond the ~200 videos the player exposes
    try { const all = await readPlaylistApi(id, settings.ytApiKey); if (all.length) return all; } catch (e) { log('warn', 'playlist.api_failed', { error: String(e) }); }
  }
  if (am && am.state() !== 'idle') {
    const r = await am.withSpareDeck((d) => (d as HybridDeck).readPlaylist(id));
    if (!r.ok) throw new Error(`${r.reason}: aspetta qualche secondo o ferma l'automix`);
    return r.value;
  }
  return decks![0].readPlaylist(id);
}

/** Which playlist the queue came from: its songs are saved again when they change. */
let loadedId: string | undefined;
let loadedSource: 'YouTube' | 'Spotify' = 'YouTube';
/** False when the list was opened from the PC: then it changes only when the user asks (Carica playlist / Aggiorna ora). */
let autoRefreshable = true;
const nameOf = (p?: Playlist) => p?.name ?? 'Playlist';

function showSlots() {
  ui.setPlaylists(plStore.list(settings.playlistSort).map((p) => ({ id: p.id, name: p.name, count: p.tracks.length, link: p.link ?? '' })), settings.currentPlaylistId);
}

/** The playlist in use; one is created when there is none yet. */
function ensureCurrent(): Playlist {
  const have = plStore.get(settings.currentPlaylistId);
  if (have) return have;
  const p = plStore.list()[0] ?? plStore.create();
  settings.currentPlaylistId = p.id; save();
  return p;
}

/** Keeps the songs of the playlist in use (name, link and list), so it opens at once next time, also offline. */
function persistQueue() {
  if (loadedId === undefined || !plStore.get(loadedId)) return;
  const tracks = queue.all().filter((t) => !transient.has(t.videoId));
  if (!tracks.length) return;
  plStore.setTracks(loadedId, tracks, [...replaced]);
  showSlots();
}

/** The loaded link becomes the one saved in the playlist in use, together with its songs. */
function rememberLink(text: string, source: 'YouTube' | 'Spotify', ownName?: string) {
  const p = ensureCurrent();
  settings.playlistText = text;
  save();
  plStore.update(p.id, { link: text.trim(), source });
  if (ownName && /^Playlist \d+$/.test(p.name)) plStore.rename(p.id, ownName);
  loadedId = p.id;
  loadedSource = source;
  autoRefreshable = true;
  persistQueue();
}

/** Opens the copy saved on this computer: no waiting for YouTube or Spotify, and it works offline too. */
function openSaved(id: string | undefined): boolean {
  const p = plStore.get(id);
  if (!p || !p.tracks.length) return false;
  // «non riproducibile» is decided again at every opening (a mark saved by mistake must not hide a song forever)
  setQueue(p.tracks.map((t) => ({ ...t, status: 'ok' as const })));
  startKaraoke();
  const src = p.source === 'Spotify' ? 'Spotify' : 'YouTube';
  ui.setSource(p.source === 'Locale' ? 'Libreria' : src);
  loadedId = p.id;
  loadedSource = src;
  const parsed = p.source !== 'Spotify' && p.link ? parsePlaylistInput(p.link) : undefined;
  listId = parsed?.kind === 'playlist' ? parsed.listId : undefined;
  replaced.clear();
  for (const id2 of p.removed ?? []) replaced.add(id2); // songs taken out stay out, also when the playlist is updated
  autoRefreshable = false;
  ui.setRefreshInfo(listId ? `Aperta dal ${DEVICE}: la lista non cambia da sola. «Aggiorna ora» aggiunge i brani nuovi di YouTube, «Carica playlist» la rilegge da capo.` : '');
  const off = navigator.onLine ? '' : ` Sei offline: suonano i ${p.tracks.filter((t) => library.isOffline(t.videoId)).length} brani disponibili offline.`;
  ui.setStatus(`«${nameOf(p)}» aperta dal ${DEVICE}: ${p.tracks.length} ${p.tracks.length === 1 ? 'brano' : 'brani'}.${p.link ? ` Premi «Carica playlist» per rileggerla da ${src}.` : ''}${off}`);
  return true;
}

/**
 * «🔄 Aggiorna da YouTube» on a saved playlist: reads it again from YouTube, adds the new songs at the end, drops the ones
 * removed there (never the one on air or the next one), keeps the user's order and replacements. Saved at once.
 */
async function syncFromYouTube(id: string): Promise<string> {
  const p = plStore.get(id);
  const parsed = p?.link ? parsePlaylistInput(p.link) : undefined;
  if (!p || parsed?.kind !== 'playlist') return 'Questa playlist non ha un indirizzo di playlist YouTube da cui aggiornarsi.';
  if (!netOk()) throw new Error('sei offline');
  const ids = await readIds(parsed.listId);
  if (!ids.length) throw new Error('YouTube non ha restituito brani (playlist privata o vuota?)');
  const d = diffPlaylist(p.tracks, ids, new Set(p.removed ?? []));
  const onAir = new Set(decks ? decks.map((x) => x.currentVideoId()) : []);
  const removed = d.removed.filter((v) => !onAir.has(v));
  const fresh = d.added.length ? await buildTracks(d.added, oembedMeta, 5) : [];
  const cur = plStore.get(id);
  if (!cur) return '';
  if (fresh.length || removed.length) {
    const gone = new Set(removed);
    plStore.setTracks(id, [...cur.tracks.filter((t) => !gone.has(t.videoId)), ...fresh], cur.removed);
    syncQueueWith(id);
  }
  const hhmm = new Date().toTimeString().slice(0, 5);
  log('info', 'playlist.synced', { added: fresh.length, removed: removed.length });
  return fresh.length || removed.length
    ? `🔄 «${cur.name}» aggiornata alle ${hhmm}: ${fresh.length} ${fresh.length === 1 ? 'brano nuovo' : 'brani nuovi'}, ${removed.length} ${removed.length === 1 ? 'tolto' : 'tolti'}.`
    : `🔄 «${cur.name}»: nessuna novità su YouTube (${hhmm}).`;
}

/** The playlist in the queue was changed from the side bar (songs added or removed): the queue follows, the music goes on. */
function syncQueueWith(id: string) {
  if (id !== loadedId) { showSlots(); return; }
  const p = plStore.get(id);
  if (!p) return;
  if (!am || queue.length() === 0) { openSaved(id); return; }
  const want = new Set(p.tracks.map((t) => t.videoId));
  for (const t of p.tracks) if (!queue.has(t.videoId)) queue.add({ ...t });
  for (const t of queue.all()) if (!want.has(t.videoId) && !transient.has(t.videoId)) queue.remove(t.videoId);
  startKaraoke();
  showSlots();
}

/** Plays a song now from the library or the search: added to the queue (not to the playlist) if it is not there. */
function playTrack(t: Track) {
  if (!netOk() && !library.isOffline(t.videoId)) { ui.setStatus('Sei offline: questo brano è solo online. Suonano i brani ✓ della libreria.', true); return; }
  if (!queue.has(t.videoId)) {
    if (!am || queue.length() === 0) { setQueue([{ ...t }]); loadedId = undefined; }
    else { queue.add({ ...t }); transient.add(t.videoId); }
  }
  if (!am) return;
  if (am.state() === 'idle') { queue.setCurrent(t.videoId); am.start(); } else am.playNow(t.videoId);
  ui.setStatus(`▶ «${titleOf(t)}»`);
}

/**
 * «Metti in coda»: the song goes at the end of the play queue, or right after the song on air (`next`).
 * Like «Riproduci», it joins the queue only: the playlist itself does not change.
 */
function enqueue(t: Track, next: boolean) {
  if (!netOk() && !library.isOffline(t.videoId)) { ui.setStatus('Sei offline: questo brano è solo online, lo metterò in coda ma verrà saltato finché non torna la rete.', true); }
  const name = titleOf(t);
  if (!am || queue.length() === 0) {
    setQueue([{ ...t }]); loadedId = undefined;
    ui.setStatus(`In coda: «${name}». Premi «Avvia automix» per farlo partire.`);
    return;
  }
  if (!queue.has(t.videoId)) { queue.add({ ...t }); transient.add(t.videoId); }
  else if (!next) {
    const i = queue.all().findIndex((x) => x.videoId === t.videoId);
    if (i === queue.currentIndex()) { ui.setStatus(`«${name}» sta già suonando.`); return; }
    queue.move(i, queue.length() - 1);
  }
  if (next) {
    if (!queue.cueNext(t.videoId)) { ui.setStatus(`«${name}» sta già suonando.`); return; }
    ui.setStatus(`⏭ «${name}» suonerà subito dopo il brano in onda.`);
  } else ui.setStatus(`⤵ In coda: «${name}» (posizione ${queue.length()}).`);
}

/** Any song the app knows: in the queue, in the library, in the search results or in a playlist. */
function trackById(id: string): Track | undefined {
  const q = trackOf(id);
  if (q) return { ...q, locked: undefined, status: 'ok' };
  const e = library.get(id);
  if (e) return library.toTrack(e);
  const k = libUI?.known(id);
  if (k) return k;
  for (const p of plStore.list()) { const t = p.tracks.find((x) => x.videoId === id); if (t) return { ...t }; }
  return undefined;
}

/** Download Manager (computer app): yt-dlp runs in the app, finished files join My Library and the chosen playlist. */
const downloads = computerApp && tauriInvoke ? new DownloadCoordinator(
  tauriDownloadClient((c, a) => tauriInvoke(c, a), (ev, fn) => listen(ev, fn)),
  library, plStore,
  { status: (t, e) => ui.setStatus(t, e), playlistChanged: (id) => syncQueueWith(id) },
) : undefined;

// --- The NAS: playlists kept the same on every device (src/sync). Linked from ☁ Sync; the token stays on this computer. ---
let nasConfig = loadNasConfig(store);
let syncApi: SyncApi | undefined;
let syncEngine: SyncEngine | undefined;
let uploader: Uploader | undefined;
let nasMusic: NasMusic | undefined;
/** Room for copies of NAS songs: the disk (computer app) or what the browser/phone storage still allows. */
async function freeSpace(): Promise<number | undefined> {
  if (computerApp && tauriInvoke) { try { const n = await tauriInvoke('disk_free', {}); return typeof n === 'number' ? n : undefined; } catch { /* unknown */ } }
  try { const e = await navigator.storage?.estimate?.(); return e?.quota != null ? e.quota - (e.usage ?? 0) : undefined; } catch { return undefined; }
}
const thisDeviceName = () => { const ua = navigator.userAgent; return isAndroidApp() ? 'Telefono Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC Windows' : /Linux/.test(ua) ? 'PC Linux' : 'Computer'; };
function startSync(cfg: NasConfig) {
  nasConfig = cfg;
  syncApi = new HttpSyncClient(cfg.url, cfg.token);
  const api = syncApi;
  nasMusic = new NasMusic({ library, api: () => syncApi, freeSpace, log: (m) => log('info', 'sync.nas_music', { m }) });
  syncEngine = new SyncEngine(plStore, kv, syncApi, {
    onLine: () => navigator.onLine, log: (m) => log('info', 'sync', { m }),
    // a NAS song saved here (nas:<sha>) is the same line on every device: it keeps its nas: id
    nasIdOf: (id) => library.nasIdOf(id),
    localIdOf: (sha) => { const id = library.idForNas(sha); return id && !id.startsWith('nas:') ? id : undefined; },
    onTracks: (t) => nasMusic?.applyTracks(t),
  });
  // first link of this device (or after an update): the whole NAS library once, then only the changes
  void (async () => {
    try {
      const done = await kv.get<{ key: string; value: number }>('sync', 'nasLibrary');
      if (done?.value) return;
      const n = await nasMusic!.refreshAll();
      if (syncApi === api) await kv.put('sync', 'nasLibrary', { key: 'nasLibrary', value: Date.now() });
      log('info', 'sync.nas_library', { tracks: n });
    } catch (e) { log('warn', 'sync.nas_library_failed', { error: String(e) }); }
  })();
  // the files: what is on this computer goes to the NAS; a song that arrived there is pushed again in its playlists
  if (desktopUI) uploader = new Uploader({ api: syncApi, library, auto: () => settings.nasUploadAuto, log: (m) => log('info', 'sync.upload', { m }), onDone: () => void syncEngine?.syncNow() });
  let lastNews = '';
  let wasConnected = false;
  syncEngine.onChange(() => {
    const s = syncEngine?.status();
    if (s?.connected && !wasConnected) uploader?.resume();
    wasConnected = !!s?.connected;
    if (s?.lastNews && s.lastNews !== lastNews) { lastNews = s.lastNews; ui.setStatus(`☁ ${s.lastNews}`); }
    if (s?.conflicts.length && !document.body.classList.contains('sync-asked')) { document.body.classList.add('sync-asked'); ui.setStatus(`☁ Due dispositivi hanno cambiato la stessa playlist in modi diversi: decidi in Impostazioni → NAS.`, true); }
  });
  void syncEngine.start();
  uploader?.start();
}
window.addEventListener('online', () => void syncEngine?.syncNow());
/** Android 17+: without the «local network» permission the NAS at home cannot be reached at all. */
async function needLocalNetwork() {
  if ((await ensureLocalNetwork()) === 'granted') return;
  openAppSettings();
  throw new Error('Android non permette a PartyMix di usare la rete di casa. Nelle impostazioni dell’app che si sono aperte: Autorizzazioni → «Dispositivi nelle vicinanze» (rete locale) → Consenti, poi riprova.');
}
// a playlist changed by another device (or by this one): the phone's playlist menu shows it at once
let slotsSoon = 0;
plStore.onChange(() => { if (!desktopUI && !slotsSoon) slotsSoon = window.setTimeout(() => { slotsSoon = 0; showSlots(); }, 300); });
const syncDeps = !isIOSApp() ? {
  config: () => nasConfig,
  engine: () => syncEngine,
  api: () => syncApi,
  async probe(url: string) {
    await needLocalNetwork();
    return new HttpSyncClient(url).health();
  },
  async connect(url: string, how: { kind: 'setup' | 'login'; name: string; password: string } | { kind: 'pair'; code: string }) {
    const u = new URL(url);
    if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new Error('Senza HTTPS PartyMix parla solo con indirizzi della rete di casa o della VPN.');
    await needLocalNetwork();
    const c = new HttpSyncClient(url);
    const dev = { deviceName: thisDeviceName(), deviceKind: isAndroidApp() ? 'android' as const : 'pc' as const };
    const s = how.kind === 'pair' ? await c.pair(how.code, dev) : how.kind === 'setup' ? await c.setup(how.name, how.password, dev) : await c.login(how.name, how.password, dev);
    const cfg: NasConfig = { url, token: s.token, deviceId: s.device.id, deviceName: s.device.name, userName: s.user.name };
    saveNasConfig(store, cfg);
    log('info', 'sync.linked', { url });
    startSync(cfg);
  },
  async disconnect() {
    try { await syncApi?.logout(); } catch { /* the NAS may be away: the token is forgotten here anyway */ }
    await syncEngine?.reset();
    uploader?.stop();
    nasMusic?.stop();
    await kv.delete('sync', 'nasLibrary').catch(() => {});
    syncEngine = undefined; syncApi = undefined; nasConfig = undefined; uploader = undefined; nasMusic = undefined;
    saveNasConfig(store, undefined);
    log('info', 'sync.unlinked', {});
  },
  status: (t: string, e?: boolean) => ui.setStatus(t, e),
  here: phoneUI ? 'questo telefono' : 'questo computer',
  where: 'Impostazioni → NAS',
  copies: () => library.all().filter((e) => e.source === 'nas' && (e.state === 'downloading' || e.state === 'error')).map((e) => ({ id: e.id, title: e.title, artist: e.artist, state: e.state!, progress: e.progress, error: e.error })),
  uploader: () => uploader,
  uploadAuto: () => settings.nasUploadAuto,
  setUploadAuto: (on: boolean) => { settings.nasUploadAuto = on; save(); },
  nasMusic: () => nasMusic,
  playlists: () => plStore.list(),
  nasCounts: () => { let total = 0, saved = 0, savedBytes = 0; for (const e of library.all()) if (e.nasId) { total++; if (e.file) { saved++; savedBytes += e.size ?? 0; } } return { total, saved, savedBytes }; },
} : undefined;

/** The computer's pages (Playlist, Cerca, Download, Libreria), built with the shell's menu and navigation. */
let libUI: ReturnType<typeof buildDesktopPages> | undefined;
const desktopPages = desktopUI ? (parts: DesktopParts) => (libUI = buildDesktopPages({
  downloads,
  playlists: plStore,
  library,
  playingId: () => loadedId,
  sort: () => settings.playlistSort,
  setSort: (s2) => { settings.playlistSort = s2; save(); showSlots(); },
  apiKey: () => settings.ytApiKey ?? '',
  setApiKey: (k) => { settings.ytApiKey = k || undefined; save(); },
  online: netOk,
  playPlaylist,
  loadLink(id, link) {
    settings.currentPlaylistId = id; save();
    ui.linkInput.value = link;
    if (!ui.loadBtn.disabled) ui.loadBtn.click();
  },
  edited: (id) => syncQueueWith(id),
  syncFromYouTube: (id) => syncFromYouTube(id),
  deleted: (id) => {
    if (loadedId === id) loadedId = undefined; // the music goes on, but is not saved into a playlist that no longer exists
    if (settings.currentPlaylistId === id) { settings.currentPlaylistId = plStore.list(settings.playlistSort)[0]?.id; save(); }
    showSlots();
  },
  playTrack,
  enqueue,
  trackById,
  search: (q, page, max) => searchYouTube(q, { apiKey: settings.ytApiKey, getText: hasNativeDisplays() ? nativeGet : undefined, pageToken: page, max }),
  status: (t, e) => ui.setStatus(t, e),
  menu: parts.menu,
  go: parts.go,
  nasState: (id) => { const st = uploader?.stateOf(id); return st ? { state: st, error: uploader?.errorOf(id) } : undefined; },
  store,
  sync: desktopUI ? syncDeps : undefined,
})) : undefined;

/**
 * ▶ on a playlist: it becomes the play queue (from `startAt` if given) and the Player opens.
 * The playlist already playing is not restarted: ▶ just opens the Player (or jumps to the song asked).
 */
function playPlaylist(id: string, startAt?: string) {
  const p = plStore.get(id);
  if (!p) return;
  ui.go('now');
  const running = !!am && am.state() !== 'idle';
  if (loadedId !== id || !running) {
    settings.currentPlaylistId = id; save();
    ui.linkInput.value = p.link ?? '';
    showSlots();
    if (loadedId !== id && !openSaved(id)) {
      if (p.link && !ui.loadBtn.disabled) ui.loadBtn.click(); else ui.setStatus(`«${p.name}» è vuota: aggiungi brani dalla Ricerca o dalla Libreria.`, true);
      return;
    }
  }
  if (!am) return;
  if (startAt) { if (am.state() === 'idle') { queue.setCurrent(startAt); am.start(); } else am.playNow(startAt); }
  else if (am.state() === 'idle') am.start();
}

function selectPlaylist(id: string) {
  const p = plStore.get(id);
  if (!p) return;
  settings.currentPlaylistId = id; save();
  ui.linkInput.value = p.link ?? '';
  showSlots();
  if (loadedId === id && am && am.state() !== 'idle') { ui.setStatus(`«${nameOf(p)}» sta già suonando.`); return; }
  if (openSaved(id)) return;
  if (!p.link) { ui.setStatus(`«${nameOf(p)}» è vuota: incolla il link di una playlist YouTube o Spotify e premi «Carica playlist»${desktopUI ? ', oppure aggiungi brani dalla libreria o dalla ricerca' : ''}.`); ui.linkInput.focus(); return; }
  if (!ui.loadBtn.disabled) ui.loadBtn.click();
}

const ui: ReturnType<typeof buildConsole> & { selectById(id: string): void } = Object.assign(buildConsole(document.getElementById('app')!, {
  selectPlaylist,
  setProjectorMode(m) { const changed = settings.projectorMode !== m; settings.projectorMode = m; save(); ui.setProjectorMode(m); if (changed) void resetForMode(); },
  renamePlaylist(name) {
    const p = ensureCurrent();
    if (!name.trim()) { showSlots(); ui.setStatus('Il nome non può restare vuoto.', true); return; }
    plStore.rename(p.id, name);
    showSlots();
    ui.setStatus(`Nome salvato: «${name.trim()}».`);
  },
  async loadPlaylist(text) {
    const spotify = parseSpotifyInput(text);
    if (spotify) {
      ui.loadBtn.disabled = true;
      try {
        ui.setStatus('Leggo la playlist Spotify…');
        const r = await loadSpotifyList(spotify, nativeGet, (d, n) => ui.setStatus(`Cerco i brani su YouTube: ${d} di ${n}…`));
        if (r.tracks.length === 0) { ui.setStatus('Non ho trovato nessun brano di questa playlist su YouTube.', true); return; }
        setQueue(r.tracks);
        startKaraoke();
        ui.setSource('Spotify');
        listId = undefined; // a Spotify list is read once; there is nothing to refresh
        replaced.clear();
        lastAttempt = Date.now();
        ui.setRefreshInfo('');
        rememberLink(text, 'Spotify', r.name);
        const miss = r.missing.length;
        ui.setStatus(`«${r.name}» pronta: ${r.tracks.length} brani su ${r.total}${miss ? `. Non ho trovato su YouTube: ${r.missing.slice(0, 3).map((m) => m.title).join(', ')}${miss > 3 ? `… (+${miss - 3})` : ''}` : ''}.`);
      } catch (e) {
        log('error', 'spotify.load_failed', { error: String(e) });
        ui.setStatus(`Non riesco a leggere la playlist Spotify: ${(e as Error).message}. Controlla che sia pubblica e che la rete funzioni.`, true);
      } finally {
        ui.loadBtn.disabled = false;
      }
      return;
    }
    const parsed = parsePlaylistInput(text);
    if (parsed.kind === 'invalid') { ui.setStatus('Link non valido: incolla il link di una playlist YouTube o Spotify, o di un video YouTube.', true); return; }
    if (!ytReady) { ui.setStatus(navigator.onLine ? 'I player YouTube non sono ancora pronti: riprova tra qualche secondo.' : 'Sei offline: per leggere una playlist da YouTube serve la rete. Intanto suona la tua libreria.', true); return; }
    ui.loadBtn.disabled = true;
    try {
      ui.setStatus('Leggo la playlist…');
      let ids = parsed.kind === 'playlist' ? await readIds(parsed.listId) : [parsed.videoId];
      if (ids.length === 0 && parsed.kind === 'playlist' && hasNativeDisplays()) {
        // The embedded player cannot read some playlists; the playlist page lists the same videos.
        try { ids = parsePlaylistPage(await nativeGet(`https://www.youtube.com/playlist?list=${parsed.listId}`)); } catch { /* keep the empty result */ }
      }
      if (ids.length === 0) { ui.setStatus('La playlist è vuota o non è pubblica.', true); return; }
      ui.setStatus(`Carico i dettagli di ${ids.length} brani…`);
      const tracks = await buildTracks(ids, oembedMeta, 5);
      setQueue(tracks);
      startKaraoke();
      ui.setSource('YouTube');
      listId = parsed.kind === 'playlist' ? parsed.listId : undefined;
      replaced.clear();
      lastAttempt = Date.now();
      ui.setRefreshInfo(listId ? 'Playlist appena caricata.' : '');
      rememberLink(text, 'YouTube');
      const bad = tracks.filter((t) => t.status === 'unplayable').length;
      ui.setStatus(`Playlist pronta: ${tracks.length} brani${bad ? `, ${bad} non riproducibili (vedi l'avviso a destra)` : ''}.`);
    } catch (e) {
      log('error', 'playlist.load_failed', { error: String(e) });
      ui.setStatus(`Non riesco a leggere la playlist: ${(e as Error).message}. Controlla che sia pubblica e che la rete funzioni.`, true);
    } finally {
      ui.loadBtn.disabled = false;
    }
  },
  start: () => am?.start(),
  stop: () => am?.stop(),
  next: () => am?.next(),
  togglePause: () => (am?.state() === 'paused' ? am.resume() : am?.pause()),
  mixNow: () => am?.mixNow(),
  playNow: (id) => am?.playNow(id),
  setProfile: (p) => { settings.profile = p; save(); },
  setMaster: (v) => { settings.master = v; save(); },
  seek: (i, sec) => decks?.[i].seekTo(sec),
  setDeckVolume: (i, v) => { sliders[i] = v; },
  toggleDuck: (i) => { ducked[i] = !ducked[i]; },
  setSpotMode(m) { settings.spotMode = m; save(); syncAutoDuck(); },
  setAdGuard(on) { settings.adGuard = on; save(); void (on ? guard.enable() : guard.disable()).then(syncAutoDuck); },
  setAdThreshold(t) { settings.adThreshold = t; save(); guard.setThreshold(t); },
  toggleLock(id) {
    const t = trackOf(id);
    if (!t) return;
    queue.setLocked(id, !t.locked);
    settings.locked = queue.all().filter((x) => x.locked).map((x) => x.videoId);
    save();
  },
  move: (from, to) => { queue.move(from, to); persistQueue(); },
  removeTrack(id) {
    const t = trackOf(id);
    if (!t) return;
    if (!queue.remove(id)) { ui.setStatus('Il brano in onda non si può togliere: passa al successivo e poi toglilo.', true); return; }
    replaced.add(id); // a playlist update must not bring it back
    persistQueue();
    transient.delete(id);
    ui.setStatus(`Tolto dalla playlist: «${titleOf(t)}»${loadedId !== undefined ? ` (salvato sul ${DEVICE})` : ''}.`);
  },
  setShuffle(on) { settings.shuffle = on; save(); if (on) queue.shuffleUpcoming(); },
  setRepeat(r) { settings.repeat = r; queue.setRepeat(r); save(); },
  shuffleNow: () => queue.shuffleUpcoming(),
  async addVideo(text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (!r.ok || !r.track) return r.message;
    r.track.manual = true;
    if (!am) { setQueue([r.track]); loadedId = undefined; } else { queue.add(r.track); persistQueue(); }
    startKaraoke();
    return `Aggiunto: ${titleOf(r.track)}`;
  },
  async replace(oldId, text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (r.ok && r.track) { r.track.manual = true; replaced.add(oldId); queue.replace(oldId, r.track); startKaraoke(); persistQueue(); }
    return { ok: r.ok, message: r.message };
  },
  openProjector: () => openProjector(settings.projectorDisplay, settings.projectorDisplayLabel),
  closeProjector: () => void closeProjector(),
  setDisplay: (key, label) => { settings.projectorDisplay = key; settings.projectorDisplayLabel = label; save(); },
  setMic: (id) => { settings.micDeviceId = id || undefined; save(); },
  setMicSensitivity: (v) => { settings.micSensitivity = v; save(); },
  refreshInputs: () => listInputs(),
  refreshNow: () => void refreshPlaylist(true),
  setAutoRefresh: (m) => { settings.playlistRefreshMin = m; save(); },
  shiftLyrics(d) { if (lyricsDeck) saveAlign(lyricsDeck, shiftAlign(alignOf(lyricsDeck), d)); },
  stepLyricsLine(n) {
    const id = lyricsDeck, l = id ? lyricsCache.get(id) : undefined;
    if (!id || !l || l === 'loading' || !l.synced?.length) return;
    const lines = l.synced, al = alignOf(id);
    const i = Math.max(0, indexFor(lines, lyricsPosition, al)), j = Math.min(lines.length - 1, Math.max(0, i + n));
    anchors.delete(id);
    saveAlign(id, shiftAlign(al, lines[i].t - lines[j].t)); // moves the whole text by the distance between the two lines
  },
  setLyricsSpeed(v) {
    if (!lyricsDeck) return;
    const al = alignOf(lyricsDeck), a = Math.min(2, Math.max(0.5, v));
    anchors.delete(lyricsDeck);
    saveAlign(lyricsDeck, { a, b: toLyricTime(al, lyricsPosition) - a * lyricsPosition }); // keeps the current line in place while the pace changes
  },
  anchorLyrics(i) {
    const id = lyricsDeck, l = id ? lyricsCache.get(id) : undefined;
    if (!id || !l || l === 'loading' || !l.synced?.[i]) return;
    const list = anchors.get(id) ?? [];
    const mark = { t: l.synced[i].t, p: lyricsPosition };
    const last = list[list.length - 1];
    if (last && Math.abs(last.p - mark.p) < 3) list[list.length - 1] = mark; else list.push(mark); // a quick second tap corrects the first
    anchors.set(id, list);
    saveAlign(id, alignFromAnchors(list));
  },
  resetLyricsAlign() { if (lyricsDeck) { anchors.delete(lyricsDeck); saveAlign(lyricsDeck, undefined); } },
  setShowLyrics(on) { settings.showLyrics = on; save(); },
  setLyricsHighlight(on) { settings.lyricsHighlight = on; save(); },
  markWelcomed() { settings.welcomed = true; save(); },
  retryKaraoke: () => startKaraoke(true),
  setKaraokeAuto(on) { settings.karaokeAuto = on; save(); if (on) startKaraoke(); else karaoke.stop(); },
  toggleFavorite(id) { const t = trackOf(id); const on = library.toggleFavorite(id, t); ui.setStatus(on ? `♥ «${titleOf(t)}» nei preferiti.` : `«${titleOf(t)}» tolto dai preferiti.`); },
  makeOffline(id) { libUI?.offline(id); },
  addToPlaylist(id) { libUI?.pickPlaylist([id]); },
  prev() {
    const i = queue.currentIndex();
    const t = i > 0 ? queue.all()[i - 1] : undefined;
    if (t && am && t.status !== 'unplayable') am.playNow(t.videoId);
  },
}, { hasMusic: !!settings.currentPlaylistId, desktop: desktopPages, phone: phoneUI }), { selectById: selectPlaylist });
if (computerApp) followSystemTheme(tauriInvoke ? (c, args) => tauriInvoke(c, args) : undefined);
ui.setSensitivity(settings.micSensitivity);
ui.setProjectorMode(settings.projectorMode);
if (canCast()) window.setInterval(() => ui.setProjectorInfo(castMessage(castState())), 1000);
else if (isIOSApp()) ui.setProjectorInfo('📺 Per la TV: Centro di Controllo → «Duplica schermo» → Apple TV o TV AirPlay, poi «Mostra il proiettore».');
ui.setAutoRefreshValue(settings.playlistRefreshMin);
// the screens, again whenever the app comes back to the front (a TV may have been plugged in meanwhile)
const refreshDisplays = () => void listDisplays().then((n) => ui.setDisplays(n, settings.projectorDisplay, settings.projectorDisplayLabel)).catch(() => {});
if (hasNativeDisplays()) { refreshDisplays(); addEventListener('focus', refreshDisplays); }

// --- Playlist refresh: picks up videos added to or removed from the YouTube playlist. ---
async function refreshPlaylist(manual: boolean): Promise<void> {
  if (refreshing) return;
  if (!listId || !ytReady) { if (manual) ui.setRefreshInfo('Niente da aggiornare: hai caricato un singolo video.'); return; }
  refreshing = true;
  if (manual) ui.setRefreshInfo('Aggiorno la playlist…');
  try {
    const running = !!am && am.state() !== 'idle';
    let ids: string[];
    if (running) {
      const r = await am!.withSpareDeck((d) => (d as HybridDeck).readPlaylist(listId!));
      if (!r.ok) { if (manual) ui.setRefreshInfo(`Non in questo momento (${r.reason.toLowerCase()}): riprova tra qualche secondo.`); return; }
      ids = r.value;
    } else {
      ids = settings.ytApiKey ? await readIds(listId) : await decks[0].readPlaylist(listId);
    }
    lastAttempt = Date.now();
    const q = queue;
    const d = diffPlaylist(q.all(), ids, replaced);
    const fresh = d.added.length ? await buildTracks(d.added, oembedMeta, 5) : [];
    if (queue !== q) return; // another playlist was loaded meanwhile
    for (const t of fresh) q.add(t);
    // never pull tracks out from under a running crossfade or the one already prepared
    const busy = am?.state() === 'crossfading';
    const removed = busy ? 0 : d.removed.filter((id) => id !== am?.upcomingId() && q.remove(id)).length;
    const hhmm = new Date().toTimeString().slice(0, 5);
    ui.setRefreshInfo(d.added.length || removed ? `Aggiornata alle ${hhmm}: ${d.added.length} nuovi, ${removed} rimossi.` : `Aggiornata alle ${hhmm}: nessuna novità.`);
    log('info', 'playlist.refreshed', { added: d.added.length, removed });
    if (d.added.length || removed) persistQueue();
  } catch (e) {
    lastAttempt = Date.now();
    log('warn', 'playlist.refresh_failed', { error: String(e) });
    ui.setRefreshInfo(`Aggiornamento non riuscito: ${(e as Error)?.message ?? e}. Riprovo più tardi.`);
  } finally {
    refreshing = false;
  }
}
window.setInterval(() => {
  const m = settings.playlistRefreshMin;
  if (m > 0 && autoRefreshable && Date.now() - lastAttempt >= m * 60_000) void refreshPlaylist(false);
}, 15_000);

// --- Lyrics: fetched from LRCLIB for the deck that is currently audible, followed to the playhead. ---
const lyricsCache = new Map<string, Lyrics | null | 'loading'>();
const lyricsStore = new LyricsStore(store);
window.addEventListener('pagehide', () => lyricsStore.flush());
const jobTrackOf = (t: Track, dur = 0): JobTrack => ({ id: t.videoId, title: t.title ?? '', artist: t.artist ?? '', durationSec: dur || t.durationSec || 0, structured: !!t.structured });
const lyricsFetch = throttled(fetch, 1300, ['lrclib.net', 'api.lyrics.ovh']);
const findFor = (t: JobTrack) => findLyrics(t.title, t.artist, t.durationSec, lyricsFetch, { structured: t.structured, getText: hasNativeDisplays() ? nativeGet : undefined });
const karaoke = new KaraokeJob({
  store: lyricsStore,
  find: findFor,
  onChange: () => {
    // a song that was "not found" a moment ago may have been found by the background search since
    for (const [id, v] of lyricsCache) if (v === null && (lyricsStore.status(id) === 'synced' || lyricsStore.status(id) === 'plain')) lyricsCache.delete(id);
  },
});
/** Searches the lyrics of the whole queue in the background, the song on air first. */
function startKaraoke(retryMissing = false) {
  if (!settings.karaokeAuto && !retryMissing) return;
  const cur = queue.current()?.videoId;
  const all = queue.all().filter((t) => t.status !== 'unplayable');
  const ordered = [...all.filter((t) => t.videoId === cur), ...all.filter((t) => t.videoId !== cur)];
  karaoke.start(ordered.map((t) => jobTrackOf(t)), retryMissing);
}
const aligns = new Map<string, Align>(Object.entries(settings.lyricsAlign));
const anchors = new Map<string, { t: number; p: number }[]>();
let lyricsPosition = 0;

function saveAlign(id: string, al: Align | undefined) {
  if (al) { aligns.set(id, al); settings.lyricsAlign[id] = al; } else { aligns.delete(id); delete settings.lyricsAlign[id]; }
  const keys = Object.keys(settings.lyricsAlign);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete settings.lyricsAlign[k];
  save();
}
let lyricsDeck: string | undefined;
/** The user's own alignment for this video, else the automatic karaoke intro compensation, else none. */
/**
 * The projector mode changed: start again clean. The song on air moves to the source the new mode wants (from the same
 * point), so does the next one already prepared, and the lyrics are lined up again from scratch.
 */
async function resetForMode() {
  if (!decks || !am) return;
  const st = am.state();
  if (st === 'idle' || st === 'crossfading') return; // during a mix: the new mode applies from the next song
  const live = decks[am.activeDeck() as 0 | 1], spare = decks[(1 - am.activeDeck()) as 0 | 1];
  for (const d of [live, spare]) { const id = d.currentVideoId(); if (id) { lyricsCache.delete(id); intros.delete(id); } }
  lastPublished = '';
  try {
    const done = await live.reselect();
    if (done) ui.setStatus(({
      youtube: '🎬 Video YouTube: audio e video ora arrivano da YouTube (internet), dallo stesso punto.',
      'file-from-start': '🎤 Karaoke: il brano riparte dall’inizio, dal tuo file sul computer.',
      'from-start': '🎤 Karaoke: il brano riparte dall’inizio (da YouTube: non è sul computer).',
    } as const)[done]);
    if (am.nextStatus() === 'ready') await spare.reselect(); // the next song too: already on the right source
  } catch (e) { log('warn', 'deck.reselect_failed', { error: String(e) }); }
}

/** Seconds of video before the song starts, measured on the file on the computer (null: no clear intro / no file). */
const intros = new Map<string, number | null | 'pending'>();
/** Loudness of a song's file on the computer, one value every 0.25 s (null: no file, or it cannot be read). Once per song. */
const levelCache = new Map<string, Promise<number[] | null>>();
function levelsOf(id: string): Promise<number[] | null> {
  let p = levelCache.get(id);
  if (!p) {
    p = (async () => {
      const url = await library.urlFor(id);
      if (!url) return null;
      const data = await (await fetch(url)).arrayBuffer();
      const pcm = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(data);
      const ch = pcm.getChannelData(0), per = Math.floor(pcm.sampleRate * 0.25);
      const levels: number[] = [];
      for (let i = 0; i + per <= ch.length; i += per) {
        let e = 0;
        for (let k = i; k < i + per; k += 4) e += ch[k] * ch[k];
        levels.push(20 * Math.log10(Math.sqrt(e / (per / 4)) * 32768 + 1));
      }
      return levels;
    })().catch((e) => { log('warn', 'audio.levels_failed', { videoId: id, error: String(e) }); return null; });
    levelCache.set(id, p);
    if (levelCache.size > 40) levelCache.delete(levelCache.keys().next().value!);
  }
  return p;
}
/** Mix cue points (music start/end) of a song with a file on the computer; measured in the background the first time. */
const cueCache = new Map<string, Cues | null>();
function cuesFor(id: string): Cues | undefined {
  if (!cueCache.has(id)) {
    cueCache.set(id, null);
    void levelsOf(id).then((l) => {
      const c = l ? cuePoints(l, 0.25) ?? null : null;
      cueCache.set(id, c);
      if (c) log('info', 'mix.cues', { videoId: id, start: c.start, end: c.end });
    });
  }
  return cueCache.get(id) ?? undefined;
}
async function measureIntro(id: string, extra: number) {
  intros.set(id, 'pending');
  const levels = await levelsOf(id);
  const at = levels ? introEnd(levels, 0.25, extra + 6) : undefined;
  intros.set(id, at && at >= 3 ? at : null);
  log('info', 'lyrics.intro', { videoId: id, extra: Math.round(extra), introEnd: at ?? null });
}

function alignOf(id: string): Align {
  const user = aligns.get(id);
  if (user) return user;
  const l = lyricsCache.get(id), t = trackOf(id);
  if (!l || l === 'loading' || !t) return IDENTITY;
  const dur = decks?.find((d) => d.currentVideoId() === id)?.duration() ?? 0;
  // a music video longer than the record the lyrics follow: find where the song starts after the video's intro
  const intro = intros.get(id);
  if (typeof intro === 'number') return { a: 1, b: -intro };
  if (intro === undefined && l.trackDuration && dur - l.trackDuration >= 4) void measureIntro(id, dur - l.trackDuration);
  return karaokeAlign(`${t.title ?? ''} ${t.artist ?? ''}`, dur, l.trackDuration) ?? IDENTITY;
}
let lastPublished = '';

const refetched = new Set<string>();
function lyricsVM(): ViewModel['lyrics'] {
  const empty = { prev: '', cur: '', next: '', progress: 0, offset: 0, speed: 1, show: settings.showLyrics, highlight: settings.lyricsHighlight, canShift: false, lines: [] as string[], index: -1 };
  const st = am?.state() ?? 'idle';
  if (!decks || !am || st === 'idle') { lyricsDeck = undefined; return { ...empty, status: 'Il testo comparirà quando parte un brano.' }; }
  const idx = st === 'crossfading' ? (am.mixProgress() > 0.5 ? 1 - am.activeDeck() : am.activeDeck()) : am.activeDeck();
  const d = decks[idx as 0 | 1];
  const id = d.currentVideoId();
  const track = trackOf(id);
  lyricsDeck = id || undefined;
  if (!track || d.duration() <= 0) return { ...empty, status: 'Cerco il testo…' };
  if (!lyricsCache.has(id)) {
    const known = lyricsStore.get(id);
    if (known) {
      lyricsCache.set(id, lyricsFrom(known, d.duration()));
      // saved by an older version without the record's length: without it a video's intro cannot be measured
      if (!known.trackDuration && !refetched.has(id)) {
        refetched.add(id);
        void findFor(jobTrackOf(track, d.duration())).then((f) => {
          if (!f?.trackDuration) return;
          lyricsStore.setFound(id, f);
          lyricsCache.delete(id); intros.delete(id);
          log('info', 'lyrics.duration_refreshed', { videoId: id, trackDuration: f.trackDuration });
        }, () => {});
      }
    }
    else if (lyricsStore.status(id) === 'none') lyricsCache.set(id, null);
    else {
      lyricsCache.set(id, 'loading');
      const dur = d.duration();
      void findFor(jobTrackOf(track, dur)).then(
        (f) => { if (f) lyricsStore.setFound(id, f); else lyricsStore.setNone(id); lyricsCache.set(id, f ? lyricsFrom(f, dur) : null); },
        (e) => { if (e instanceof TransientError) window.setTimeout(() => lyricsCache.delete(id), 45_000); else lyricsCache.set(id, null); },
      );
    }
  }
  const l = lyricsCache.get(id);
  if (l === 'loading' || l === undefined) return { ...empty, status: 'Cerco il testo…' };
  if (!l) return { ...empty, status: 'Testo non trovato per questo brano.' };
  const al = alignOf(id);
  lyricsPosition = d.position();
  const lines = l.synced!;
  const status = l.estimated ? `Testo da ${l.source}: tempi stimati dalla durata (non esatti).`
    : l.approx ? `Testo da ${l.source}: versione con durata diversa dal video.`
    : `Testo da ${l.source}, sincronizzato con il brano in onda.`;
  const li = indexFor(lines, lyricsPosition, al);
  return { ...empty, ...snapshotAt(lines, lyricsPosition, al), progress: lineProgress(lines, lyricsPosition, al, li), offset: al.b, speed: al.a, canShift: true, lines: lines.map((x) => x.text), index: li, status: aligns.has(id) ? 'Testo allineato da te a questo video.' : typeof intros.get(id) === 'number' ? `Il video ha ${Math.round(intros.get(id) as number)} s di introduzione prima della canzone: ho spostato il testo. Regola con i tasti se serve.` : al !== IDENTITY ? 'Video karaoke: ho ritardato il testo di ' + (-al.b).toFixed(1).replace('.', ',') + ' s per l’intro. Regola con i tasti se serve.' : status };
}

function publishLyrics(ly: ViewModel['lyrics']) {
  const msg = JSON.stringify({ on: settings.showLyrics && ly.canShift, prev: ly.prev, cur: ly.cur, next: ly.next, p: Math.round(ly.progress * 50) / 50 });
  if (msg === lastPublished) return;
  lastPublished = msg;
  try { store?.setItem('partymix.lyrics', msg); } catch { /* the projector simply keeps the last line */ }
}

/** Said on the deck: the mix will skip this song's silent/quiet intro or fade out before its silent tail. */
function mixNote(id: string): string {
  const c = id ? cueCache.get(id) : undefined;
  if (!c) return '';
  const parts = [c.start >= 1 ? `entra a ${Math.round(c.start)} s (salta il silenzio iniziale)` : '', c.end > 0 && (decks?.find((x) => x.currentVideoId() === id)?.duration() ?? 0) - c.end >= 2 ? 'sfuma prima del silenzio finale' : ''].filter(Boolean);
  return parts.length ? ` · ⏩ Mix: ${parts.join(', ')}` : '';
}

function deckVM(i: 0 | 1): DeckVM {
  const d = decks?.[i];
  const t = d ? trackOf(d.currentVideoId()) : undefined;
  const state = am?.state() ?? 'idle';
  let role: DeckVM['role'] = 'idle';
  if (am && state !== 'idle') {
    const active = am.activeDeck();
    if (i === active) role = state === 'crossfading' ? 'out' : 'live';
    else role = state === 'crossfading' ? 'live' : ({ ready: 'ready', loading: 'loading', none: 'idle' } as const)[am.nextStatus()];
  }
  return {
    title: titleOf(t), artist: t?.artist ?? '', thumb: t?.thumb,
    source: d ? sourceText(d.source(), settings.projectorMode === 'video') + mixNote(d.currentVideoId()) : '',
    elapsed: d && role !== 'idle' ? d.position() : 0, duration: d && role !== 'idle' ? d.duration() : 0,
    role, volume: sliders[i], duck: ducked[i], autoDuck: autoDucked[i],
  };
}

/** Lowers the deck(s) being heard while the sound that plays looks like a spoken ad, and puts them back afterwards. */
function syncAutoDuck() {
  const st = am?.state() ?? 'idle';
  const speech = guard.state().kind === 'speech' && (st === 'playing' || st === 'crossfading' || st === 'preparing');
  const playing = st === 'playing' || st === 'crossfading' || st === 'preparing';
  const heard: number[] = !playing ? [] : st === 'crossfading' ? [0, 1] : [am!.activeDeck()];
  const spot = (i: number) => settings.spotMode === 'duck' && heard.includes(i) && isSpotLength(decks?.[i]?.duration() ?? 0);
  for (const i of [0, 1] as const) autoDucked[i] = (speech && heard.includes(i)) || spot(i);
}

const skippedSpots = new Set<string>();
/** With «Salta al brano dopo» a short track is left as soon as its length is known, once, and only when another track is waiting. */
function skipSpot() {
  if (settings.spotMode !== 'skip' || !am || am.state() !== 'playing') return;
  const d = decks?.[am.activeDeck()], id = d?.currentVideoId();
  if (!d || !id || skippedSpots.has(id) || !isSpotLength(d.duration()) || d.position() < 0.5 || !queue.peekNext()) return;
  skippedSpots.add(id);
  log('info', 'ads.spot_skipped', { videoId: id, seconds: Math.round(d.duration()) });
  am.next();
}
const guard: AdGuard = new AdGuard({ start: startSystemAudio, stop: stopSystemAudio, label: () => titleOf(trackOf(lyricsDeck ?? '')) }, () => syncAutoDuck(), settings.adThreshold);

function adsVM(): ViewModel['ads'] {
  const g = guard.state();
  return { available: hasSystemAudio(), on: g.on, kind: g.kind, level: g.level, error: g.error, silentFor: g.silentFor, threshold: settings.adThreshold, spotMode: settings.spotMode, spotNow: settings.spotMode !== 'off' && !!decks && (am?.state() ?? 'idle') !== 'idle' && isSpotLength(decks[am!.activeDeck()]?.duration() ?? 0), ducking: autoDucked[0] || autoDucked[1], events: g.events.slice(-6).map((e) => ({ time: new Date(e.at).toTimeString().slice(0, 8), kind: e.kind, score: e.score, label: e.label, detail: e.detail })), playing: (am?.state() ?? 'idle') !== 'idle' };
}

function karaokeVM(): ViewModel['karaoke'] {
  const st = karaoke.state();
  let synced = 0, plain = 0, none = 0, pending = 0;
  for (const t of queue.all()) {
    if (t.status === 'unplayable') continue;
    const s = lyricsStore.status(t.videoId);
    if (s === 'synced') synced++; else if (s === 'plain') plain++; else if (s === 'none') none++; else pending++;
  }
  return { running: st.running, waiting: st.waiting, total: st.total, done: st.done, synced, plain, none, pending, auto: settings.karaokeAuto };
}

/** The queue rows are rebuilt only when something they show changed (with 10 000 songs, not 4 times a second). */
let rowsCache: { sig: string; rows: ViewModel['queue'] } = { sig: '', rows: [] };
function queueRows(cur: number): { sig: string; rows: ViewModel['queue'] } {
  const st = am?.state() ?? 'idle';
  const net = netOk();
  const sig = `${queue.version}|${cur}|${st === 'idle' ? 'i' : st === 'paused' ? 'p' : 'r'}|${karaoke.state().done}|${library.version}|${net}`;
  if (sig === rowsCache.sig) return rowsCache;
  const rows = queue.all().map((t, i) => {
    const off = library.stateOf(t.videoId);
    return {
      id: t.videoId, title: titleOf(t), artist: t.artist ?? '', bad: t.status === 'unplayable', locked: !!t.locked,
      current: i === cur && st !== 'idle', paused: st === 'paused', lyr: lyricsStore.status(t.videoId),
      off, pct: off === 'downloading' ? library.progressOf(t.videoId) : undefined, fav: !!library.get(t.videoId)?.favorite,
      dur: t.durationSec || library.get(t.videoId)?.durationSec, skip: !net && off !== 'offline',
    };
  });
  rowsCache = { sig, rows };
  return rowsCache;
}

function viewModel(): ViewModel {
  const cur = queue.currentIndex();
  const lyrics = lyricsVM();
  publishLyrics(lyrics);
  const q = queueRows(cur);
  return {
    lyrics,
    state: am?.state() ?? 'idle',
    active: am?.activeDeck() ?? 0,
    ready: !!am && !!queue.current(),
    decks: [deckVM(0), deckVM(1)],
    mix: am?.mixProgress() ?? 0,
    master: settings.master, profile: settings.profile, shuffle: settings.shuffle, repeat: settings.repeat,
    karaoke: karaokeVM(),
    ads: adsVM(),
    queue: q.rows, queueSig: q.sig, queueKey: loadedId ?? 'coda',
    playing: { from: plStore.get(loadedId)?.name ?? (queue.length() ? 'Coda' : ''), pos: (am?.state() ?? 'idle') !== 'idle' ? cur + 1 : 0, total: queue.length() },
    history: queue.history().map((t) => titleOf(t)),
    problems,
  };
}

// iPhone/iPad: iOS pauses YouTube when the screen locks, so the screen stays on while the automix plays
let awake = false;
const keepAwake = (on: boolean) => {
  if (on === awake || !isIOSApp()) return;
  awake = on;
  void (window as unknown as { __TAURI_INTERNALS__?: { invoke(c: string, a: unknown): Promise<unknown> } }).__TAURI_INTERNALS__?.invoke('keep_awake', { on }).catch(() => {});
};
window.setInterval(() => { skipSpot(); syncAutoDuck(); const vm = viewModel(); ui.update(vm); keepAwake(vm.state !== 'idle'); }, 250);
// The projector line follows the playhead on its own faster beat, so it is never up to 250 ms behind the console tick.
window.setInterval(() => { publishLyrics(lyricsVM()); publishVideo(); }, 80);

// --- Projector «Video YouTube»: tells the projector which video is being heard and where its playhead is. ---
let lastVideo = { key: '', at: 0 };
function publishVideo() {
  const st = am?.state() ?? 'idle';
  let id = '', t = 0, playing = false, next = '';
  if (decks && am && st !== 'idle') {
    const idx = st === 'crossfading' ? (am.mixProgress() > 0.5 ? 1 - am.activeDeck() : am.activeDeck()) : am.activeDeck();
    const d = decks[idx as 0 | 1];
    id = d.videoIdForProjector(); t = d.position(); playing = st !== 'paused' && d.duration() > 0;
    // during a crossfade the next video is the incoming deck's, until it becomes the one heard
    const n = st === 'crossfading' ? (am.mixProgress() > 0.5 ? undefined : decks[(1 - idx) as 0 | 1].currentVideoId()) : (am.upcomingId() ?? queue.peekNext()?.videoId);
    next = n && n !== id && !n.includes(':') ? n : '';
  }
  const key = `${id}|${playing}|${next}`, now = Date.now();
  if (key === lastVideo.key && now - lastVideo.at < 1000) return; // the playhead is re-sent once a second, a change at once
  lastVideo = { key, at: now };
  try { store?.setItem('partymix.video', JSON.stringify({ id, t, at: now, playing, next })); } catch { /* the projector keeps the last video */ }
}
ui.update(viewModel());

bindShortcuts(window, {
  next: () => am?.next(),
  pause: () => (am?.state() === 'paused' ? am.resume() : am?.pause()),
  stop: () => am?.stop(),
  mixNow: () => am?.mixNow(),
  volumeUp: () => { settings.master = Math.min(100, settings.master + 5); save(); },
  volumeDown: () => { settings.master = Math.max(0, settings.master - 5); save(); },
});

/** Starts (or starts again, when the network comes back) the two YouTube players; the library plays without them. */
let ytBooting = false;
async function bootYouTube(): Promise<boolean> {
  if (ytReady || ytBooting) return ytReady;
  ytBooting = true;
  try {
    const yts = await Promise.all([createYouTubeDeck(ui.mounts[0]), createYouTubeDeck(ui.mounts[1])]);
    decks[0].setYouTube(yts[0]); decks[1].setYouTube(yts[1]);
    ytReady = true;
    queue.touch();
    return true;
  } catch (e) {
    log('error', 'youtube.boot_failed', { error: String(e) });
    return false;
  } finally {
    ytBooting = false;
  }
}
const onNetChange = () => {
  queue.touch();
  if (navigator.onLine && !ytReady) void bootYouTube().then((ok) => { if (ok) ui.setStatus('Rete tornata: anche i brani online ☁ suonano di nuovo.'); });
  else if (!navigator.onLine) ui.setStatus('📴 Rete assente: continuo con i brani disponibili offline ✓.', true);
};
window.addEventListener('online', onNetChange);
window.addEventListener('offline', onNetChange);
window.setInterval(() => { if (navigator.onLine && !ytReady) void bootYouTube(); }, 60_000);

(async () => {
  // 1. the library and the playlists (from the disk: no network needed)
  try {
    await Promise.all([plStore.load(), library.load()]);
    void downloads?.start().catch((e) => log('warn', 'downloads.start_failed', { error: String(e) }));
    const migrated = migrateLegacy(plStore, settings, store);
    if (migrated) { settings.currentPlaylistId = migrated; save(); log('info', 'playlists.migrated', { count: plStore.count() }); }
    if (!plStore.get(settings.currentPlaylistId) && plStore.count()) { settings.currentPlaylistId = plStore.list(settings.playlistSort)[0].id; save(); }
    if (nasConfig && syncDeps) { if (isAndroidApp()) await ensureLocalNetwork(); startSync(nasConfig); }
  } catch (e) {
    log('error', 'library.load_failed', { error: String(e) });
    ui.setStatus('Non riesco a leggere le playlist salvate: riavvia l’app. Se succede ancora, scrivimi da «💬 Commenti».', true);
  }
  showSlots();
  const current = plStore.get(settings.currentPlaylistId);
  if (current) ui.linkInput.value = current.link ?? '';
  const openedSaved = openSaved(settings.currentPlaylistId);
  // 2. YouTube (needs the internet)
  if (!openedSaved) ui.setStatus('Avvio i player YouTube…');
  const ok = await bootYouTube();
  if (!ok) {
    const offline = library.all().filter((e) => e.file).length;
    ui.setStatus(offline
      ? `📴 YouTube non è raggiungibile: suona la tua libreria offline (${offline} ${offline === 1 ? 'brano' : 'brani'}). Riprovo da solo quando torna la rete.`
      : 'YouTube non è raggiungibile e la libreria offline è vuota: controlla la connessione. Riprovo da solo quando torna la rete.', !offline);
    if (!settings.welcomed) ui.openWizard();
    return;
  }
  if (!openedSaved) ui.setStatus(desktopUI ? 'Incolla il link di una playlist YouTube o Spotify, cerca una canzone in alto o aggiungi la tua musica locale.' : 'Incolla il link di una playlist YouTube o Spotify per cominciare.');
  const spotDebug = hasSystemAudio() ? await debugSpotMode().catch(() => undefined) : undefined;
  if (spotDebug === 'duck' || spotDebug === 'skip' || spotDebug === 'off') settings.spotMode = spotDebug;
  // Android: a playlist shared from YouTube or Spotify («Condividi → PartyMix») loads by itself, and wins over the last one.
  let shared = false;
  onSharedLink((link) => {
    shared = true;
    ui.linkInput.value = link;
    const go = () => { if (ui.loadBtn.disabled) setTimeout(go, 500); else ui.loadBtn.click(); };
    go();
  });
  const startLink = (hasSystemAudio() ? await debugPlaylist().catch(() => undefined) : undefined) ?? (current?.link || undefined);
  if (!shared && startLink && !openedSaved) {
    ui.linkInput.value = startLink;
    ui.loadBtn.click();
  }
  if (hasSystemAudio()) void adDebug().then((on) => { if (on) guard.setRecorder((row) => void adDebug(JSON.stringify(row))); }).catch(() => {});
  if (settings.adGuard && hasSystemAudio()) void guard.enable();
  if (!settings.welcomed) ui.openWizard(); // first run: walk the user through the setup
  log('info', 'app.ready');
})();
