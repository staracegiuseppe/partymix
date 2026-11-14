import { canCast, castMessage, castState, isAndroidApp, onSharedLink } from './androidBridge';
import './ui/style.css';
import './ui/material.css';
import { Automix } from './automix';
import { log, setSinks } from './log';
import { buildTracks, oembedMeta, parsePlaylistPage, verifyReplacement } from './playlistLoader';
import { diffPlaylist } from './playlistSync';
import { parsePlaylistInput } from './playlistUrl';
import { Queue, Track } from './queue';
import { Align, alignFromAnchors, findLyrics, lyricsFrom, TransientError, IDENTITY, indexFor, Lyrics, shiftAlign, snapshotAt, toLyricTime, karaokeAlign, lineProgress } from './lyrics';
import { loadSettings, PLAYLIST_SLOTS, saveSettings } from './settings';
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
import { loadSaved, saveSaved, slotLabel } from './savedPlaylists';
import { listInputs } from './projector/mic';
import { createYouTubeDeck, YouTubeDeck } from './youtubeDeck';

const store: Storage | undefined = (() => { try { return window.localStorage; } catch { return undefined; } })();
const settings = store ? loadSettings(store) : loadSettings({ getItem: () => null, setItem: () => {} } as unknown as Storage);
const save = () => store && saveSettings(store, settings);
/** Where the saved playlists live, as the user calls it. */
const DEVICE = isAndroidApp() ? 'telefono' : 'PC';

// Problems the user should see, in plain Italian.
const problems: string[] = [];
const PROBLEM_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  'deck.load_failed': () => 'Un brano non si carica: è stato saltato.',
  'deck.prepare_failed': () => 'Il brano successivo non si carica: è stato saltato.',
  'deck.prepare_timeout': () => 'Il brano successivo non era pronto in tempo: è stato saltato.',
  'deck.error': (d) => `Errore del player YouTube (codice ${d.code}).`,
  'youtube.error': (d) => String(d.reason ?? 'Errore del player YouTube'),
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

let decks: [YouTubeDeck, YouTubeDeck] | undefined;
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
    online: () => navigator.onLine,
  });
}

function setQueue(tracks: Track[]) {
  am?.stop();
  for (const t of tracks) if (settings.locked.includes(t.videoId)) t.locked = true;
  queue = new Queue(tracks, { shuffle: settings.shuffle, repeat: settings.repeat });
  am = makeAutomix();
}

const trackOf = (id: string) => queue.all().find((t) => t.videoId === id);
const titleOf = (t?: Track) => (t ? t.title || `Video ${t.videoId}` : '');

async function probe(videoId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!decks || (am && am.state() !== 'idle')) return { ok: true }; // never disturb a running party
  try { await decks[1].load(videoId); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; }
}

/** Reads a playlist's video ids without interrupting the music: while the party runs it uses the spare deck. */
async function readIds(id: string): Promise<string[]> {
  if (am && am.state() !== 'idle') {
    const r = await am.withSpareDeck((d) => (d as YouTubeDeck).readPlaylist(id));
    if (!r.ok) throw new Error(`${r.reason}: aspetta qualche secondo o ferma l'automix`);
    return r.value;
  }
  return decks![0].readPlaylist(id);
}

/** Which playlist slot the queue came from: its songs are saved again when they change. */
let loadedSlot: number | undefined;
let loadedSource: 'YouTube' | 'Spotify' = 'YouTube';
/** False when the list was opened from the PC: then it changes only when the user asks (Carica playlist / Aggiorna ora). */
let autoRefreshable = true;

function showSlots() {
  const n = Array.from({ length: PLAYLIST_SLOTS }, (_, i) => loadSaved(store, i)?.tracks.length ?? 0);
  ui.setPlaylistSlots(settings.playlistSlot, settings.playlists, settings.playlistNames, n);
}

/** Keeps the songs of the playlist in use on this computer (name, link and list), so it opens at once next time. */
function persistQueue() {
  if (loadedSlot === undefined) return;
  const tracks = queue.all();
  if (!tracks.length) return;
  saveSaved(store, loadedSlot, { name: settings.playlistNames[loadedSlot], link: settings.playlists[loadedSlot], source: loadedSource, tracks, removed: [...replaced] });
  showSlots();
}

/** The loaded link becomes the one saved in the playlist slot in use, together with its songs. */
function rememberLink(text: string, source: 'YouTube' | 'Spotify', ownName?: string) {
  const slot = settings.playlistSlot;
  settings.playlistText = text;
  settings.playlists[slot] = text.trim();
  if (!settings.playlistNames[slot] && ownName) settings.playlistNames[slot] = ownName.slice(0, 60);
  save();
  loadedSlot = slot;
  loadedSource = source;
  autoRefreshable = true;
  persistQueue();
}

/** Opens the copy saved on this computer: no waiting for YouTube or Spotify. A YouTube playlist is then checked for news in the background. */
function openSaved(slot: number): boolean {
  const p = loadSaved(store, slot);
  if (!p || p.link !== settings.playlists[slot]) return false;
  setQueue(p.tracks.map((t) => ({ ...t })));
  startKaraoke();
  ui.setSource(p.source);
  loadedSlot = slot;
  loadedSource = p.source;
  const parsed = p.source === 'YouTube' ? parsePlaylistInput(p.link) : undefined;
  listId = parsed?.kind === 'playlist' ? parsed.listId : undefined;
  replaced.clear();
  for (const id of p.removed ?? []) replaced.add(id); // songs taken out stay out, also when the playlist is updated
  autoRefreshable = false;
  ui.setRefreshInfo(listId ? `Aperta dal ${DEVICE}: la lista non cambia da sola. «Aggiorna ora» aggiunge i brani nuovi di YouTube, «Carica playlist» la rilegge da capo.` : '');
  ui.setStatus(`«${slotLabel(slot, settings.playlistNames[slot])}» aperta dal ${DEVICE}: ${p.tracks.length} ${p.tracks.length === 1 ? 'brano' : 'brani'}. Premi «Carica playlist» per rileggerla da ${p.source}.`);
  return true;
}

const ui = buildConsole(document.getElementById('app')!, {
  selectPlaylist(slot) {
    settings.playlistSlot = slot; save();
    const text = settings.playlists[slot];
    ui.linkInput.value = text;
    showSlots();
    if (loadedSlot === slot && am && am.state() !== 'idle') { ui.setStatus(`«${slotLabel(slot, settings.playlistNames[slot])}» sta già suonando.`); return; }
    if (text && openSaved(slot)) return;
    if (!text) { ui.setStatus(`«${slotLabel(slot, settings.playlistNames[slot])}» è vuota: incolla il link di una playlist YouTube o Spotify e premi «Carica playlist».`); ui.linkInput.focus(); return; }
    if (!ui.loadBtn.disabled) ui.loadBtn.click();
  },
  setProjectorMode(m) { settings.projectorMode = m; save(); ui.setProjectorMode(m); },
  renamePlaylist(name) {
    const slot = settings.playlistSlot;
    settings.playlistNames[slot] = name.trim().slice(0, 60); save();
    const p = loadSaved(store, slot);
    if (p) saveSaved(store, slot, { ...p, name: settings.playlistNames[slot] });
    showSlots();
    ui.setStatus(name.trim() ? `Nome salvato: «${name.trim()}».` : `Nome tolto: torna «Playlist ${slot + 1}».`);
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
    if (!decks) { ui.setStatus('I player YouTube non sono ancora pronti.', true); return; }
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
    ui.setStatus(`Tolto dalla playlist: «${titleOf(t)}»${loadedSlot !== undefined ? ` (salvato sul ${DEVICE})` : ''}.`);
  },
  setShuffle(on) { settings.shuffle = on; save(); if (on) queue.shuffleUpcoming(); },
  setRepeat(r) { settings.repeat = r; queue.setRepeat(r); save(); },
  shuffleNow: () => queue.shuffleUpcoming(),
  async addVideo(text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (!r.ok || !r.track) return r.message;
    r.track.manual = true;
    if (!am) { setQueue([r.track]); loadedSlot = undefined; } else { queue.add(r.track); persistQueue(); }
    startKaraoke();
    return `Aggiunto: ${titleOf(r.track)}`;
  },
  async replace(oldId, text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (r.ok && r.track) { r.track.manual = true; replaced.add(oldId); queue.replace(oldId, r.track); startKaraoke(); persistQueue(); }
    return { ok: r.ok, message: r.message };
  },
  openProjector: () => openProjector(settings.projectorDisplay),
  closeProjector: () => void closeProjector(),
  setDisplay: (n) => { settings.projectorDisplay = n; save(); },
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
});
ui.setSensitivity(settings.micSensitivity);
showSlots();
ui.setProjectorMode(settings.projectorMode);
if (canCast()) window.setInterval(() => ui.setProjectorInfo(castMessage(castState())), 1000);
ui.setAutoRefreshValue(settings.playlistRefreshMin);
if (hasNativeDisplays()) void listDisplays().then((n) => ui.setDisplays(n, settings.projectorDisplay)).catch(() => {});

// --- Playlist refresh: picks up videos added to or removed from the YouTube playlist. ---
async function refreshPlaylist(manual: boolean): Promise<void> {
  if (refreshing) return;
  if (!listId || !decks) { if (manual) ui.setRefreshInfo('Niente da aggiornare: hai caricato un singolo video.'); return; }
  refreshing = true;
  if (manual) ui.setRefreshInfo('Aggiorno la playlist…');
  try {
    const running = !!am && am.state() !== 'idle';
    let ids: string[];
    if (running) {
      const r = await am!.withSpareDeck((d) => (d as YouTubeDeck).readPlaylist(listId!));
      if (!r.ok) { if (manual) ui.setRefreshInfo(`Non in questo momento (${r.reason.toLowerCase()}): riprova tra qualche secondo.`); return; }
      ids = r.value;
    } else {
      ids = await decks[0].readPlaylist(listId);
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
function alignOf(id: string): Align {
  const user = aligns.get(id);
  if (user) return user;
  const l = lyricsCache.get(id), t = trackOf(id);
  if (!l || l === 'loading' || !t) return IDENTITY;
  const dur = decks?.find((d) => d.currentVideoId() === id)?.duration() ?? 0;
  return karaokeAlign(`${t.title ?? ''} ${t.artist ?? ''}`, dur, l.trackDuration) ?? IDENTITY;
}
let lastPublished = '';

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
    if (known) lyricsCache.set(id, lyricsFrom(known, d.duration()));
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
  return { ...empty, ...snapshotAt(lines, lyricsPosition, al), progress: lineProgress(lines, lyricsPosition, al, li), offset: al.b, speed: al.a, canShift: true, lines: lines.map((x) => x.text), index: li, status: aligns.has(id) ? 'Testo allineato da te a questo video.' : al !== IDENTITY ? 'Video karaoke: ho ritardato il testo di ' + (-al.b).toFixed(1).replace('.', ',') + ' s per l’intro. Regola con i tasti se serve.' : status };
}

function publishLyrics(ly: ViewModel['lyrics']) {
  const msg = JSON.stringify({ on: settings.showLyrics && ly.canShift, prev: ly.prev, cur: ly.cur, next: ly.next, p: Math.round(ly.progress * 50) / 50 });
  if (msg === lastPublished) return;
  lastPublished = msg;
  try { store?.setItem('partymix.lyrics', msg); } catch { /* the projector simply keeps the last line */ }
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

function viewModel(): ViewModel {
  const cur = queue.currentIndex();
  const lyrics = lyricsVM();
  publishLyrics(lyrics);
  return {
    lyrics,
    state: am?.state() ?? 'idle',
    active: am?.activeDeck() ?? 0,
    ready: !!decks && !!am && !!queue.current(),
    decks: [deckVM(0), deckVM(1)],
    mix: am?.mixProgress() ?? 0,
    master: settings.master, profile: settings.profile, shuffle: settings.shuffle, repeat: settings.repeat,
    karaoke: karaokeVM(),
    ads: adsVM(),
    queue: queue.all().map((t, i) => ({ id: t.videoId, title: titleOf(t), artist: t.artist ?? '', bad: t.status === 'unplayable', locked: !!t.locked, current: i === cur && (am?.state() ?? 'idle') !== 'idle', lyr: lyricsStore.status(t.videoId) })),
    history: queue.history().map((t) => titleOf(t)),
    problems,
  };
}

window.setInterval(() => { skipSpot(); syncAutoDuck(); ui.update(viewModel()); }, 250);
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
    id = d.currentVideoId(); t = d.position(); playing = st !== 'paused' && d.duration() > 0;
    // during a crossfade the next video is the incoming deck's, until it becomes the one heard
    const n = st === 'crossfading' ? (am.mixProgress() > 0.5 ? undefined : decks[(1 - idx) as 0 | 1].currentVideoId()) : (am.upcomingId() ?? queue.peekNext()?.videoId);
    next = n && n !== id ? n : '';
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

(async () => {
  ui.setStatus('Avvio i player YouTube…');
  try {
    decks = await Promise.all([createYouTubeDeck(ui.mounts[0]), createYouTubeDeck(ui.mounts[1])]);
  } catch (e) {
    log('error', 'youtube.boot_failed', { error: String(e) });
    ui.setStatus(`Non riesco ad avviare i player YouTube (${(e as Error).message}). Controlla la connessione e riavvia l'app.`, true);
    return;
  }
  ui.setStatus('Incolla il link di una playlist YouTube o Spotify per cominciare.');
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
  const startLink = (hasSystemAudio() ? await debugPlaylist().catch(() => undefined) : undefined) ?? (settings.playlists[settings.playlistSlot] || undefined);
  if (!shared && startLink && startLink === settings.playlists[settings.playlistSlot] && openSaved(settings.playlistSlot)) ui.linkInput.value = startLink;
  else if (startLink && !shared) {
    ui.linkInput.value = startLink;
    ui.loadBtn.click();
  }
  if (hasSystemAudio()) void adDebug().then((on) => { if (on) guard.setRecorder((row) => void adDebug(JSON.stringify(row))); }).catch(() => {});
  if (settings.adGuard && hasSystemAudio()) void guard.enable();
  if (!settings.welcomed) ui.openWizard(); // first run: walk the user through the setup
  log('info', 'app.ready');
})();

