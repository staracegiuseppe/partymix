import './ui/style.css';
import { Automix } from './automix';
import { log, setSinks } from './log';
import { buildTracks, oembedMeta, verifyReplacement } from './playlistLoader';
import { diffPlaylist } from './playlistSync';
import { parsePlaylistInput } from './playlistUrl';
import { Queue, Track } from './queue';
import { Align, alignFromAnchors, fetchLyrics, IDENTITY, indexFor, Lyrics, shiftAlign, snapshotAt } from './lyrics';
import { loadSettings, saveSettings } from './settings';
import { buildConsole, DeckVM, ViewModel } from './ui/console';
import { bindShortcuts } from './ui/shortcuts';
import { closeProjector, hasNativeDisplays, listDisplays, openProjector } from './projector/launcher';
import { listInputs } from './projector/mic';
import { createYouTubeDeck, YouTubeDeck } from './youtubeDeck';

const store: Storage | undefined = (() => { try { return window.localStorage; } catch { return undefined; } })();
const settings = store ? loadSettings(store) : loadSettings({ getItem: () => null, setItem: () => {} } as unknown as Storage);
const save = () => store && saveSettings(store, settings);

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

function makeAutomix(): Automix {
  return new Automix({
    decks: decks!, queue,
    profile: () => settings.profile,
    masterVolume: () => settings.master,
    deckVolume: (i) => (sliders[i] / 100) * (ducked[i] ? 0.2 : 1),
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

const ui = buildConsole(document.getElementById('app')!, {
  async loadPlaylist(text) {
    const parsed = parsePlaylistInput(text);
    if (parsed.kind === 'invalid') { ui.setStatus('Link non valido: incolla il link di una playlist o di un video YouTube.', true); return; }
    if (!decks) { ui.setStatus('I player YouTube non sono ancora pronti.', true); return; }
    ui.loadBtn.disabled = true;
    try {
      ui.setStatus('Leggo la playlist…');
      const ids = parsed.kind === 'playlist' ? await readIds(parsed.listId) : [parsed.videoId];
      if (ids.length === 0) { ui.setStatus('La playlist è vuota o non è pubblica.', true); return; }
      ui.setStatus(`Carico i dettagli di ${ids.length} brani…`);
      const tracks = await buildTracks(ids, oembedMeta, 5);
      setQueue(tracks);
      listId = parsed.kind === 'playlist' ? parsed.listId : undefined;
      replaced.clear();
      lastAttempt = Date.now();
      ui.setRefreshInfo(listId ? 'Playlist appena caricata.' : '');
      settings.playlistText = text; save();
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
  setProfile: (p) => { settings.profile = p; save(); },
  setMaster: (v) => { settings.master = v; save(); },
  seek: (i, sec) => decks?.[i].seekTo(sec),
  setDeckVolume: (i, v) => { sliders[i] = v; },
  toggleDuck: (i) => { ducked[i] = !ducked[i]; },
  toggleLock(id) {
    const t = trackOf(id);
    if (!t) return;
    queue.setLocked(id, !t.locked);
    settings.locked = queue.all().filter((x) => x.locked).map((x) => x.videoId);
    save();
  },
  move: (from, to) => queue.move(from, to),
  setShuffle(on) { settings.shuffle = on; save(); if (on) queue.shuffleUpcoming(); },
  setRepeat(r) { settings.repeat = r; queue.setRepeat(r); save(); },
  shuffleNow: () => queue.shuffleUpcoming(),
  async addVideo(text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (!r.ok || !r.track) return r.message;
    r.track.manual = true;
    if (!am) { setQueue([r.track]); } else { queue.add(r.track); }
    return `Aggiunto: ${titleOf(r.track)}`;
  },
  async replace(oldId, text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (r.ok && r.track) { r.track.manual = true; replaced.add(oldId); queue.replace(oldId, r.track); }
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
  shiftLyrics(d) { if (lyricsDeck) saveAlign(lyricsDeck, shiftAlign(aligns.get(lyricsDeck) ?? IDENTITY, d)); },
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
});
ui.setSensitivity(settings.micSensitivity);
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
  if (m > 0 && Date.now() - lastAttempt >= m * 60_000) void refreshPlaylist(false);
}, 15_000);

// --- Lyrics: fetched from LRCLIB for the deck that is currently audible, followed to the playhead. ---
const lyricsCache = new Map<string, Lyrics | null | 'loading'>();
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
let lastPublished = '';

function lyricsVM(): ViewModel['lyrics'] {
  const empty = { prev: '', cur: '', next: '', offset: 0, speed: 1, show: settings.showLyrics, canShift: false, lines: [] as string[], index: -1 };
  const st = am?.state() ?? 'idle';
  if (!decks || !am || st === 'idle') { lyricsDeck = undefined; return { ...empty, status: 'Il testo comparirà quando parte un brano.' }; }
  const idx = st === 'crossfading' ? (am.mixProgress() > 0.5 ? 1 - am.activeDeck() : am.activeDeck()) : am.activeDeck();
  const d = decks[idx as 0 | 1];
  const id = d.currentVideoId();
  const track = trackOf(id);
  lyricsDeck = id || undefined;
  if (!track || d.duration() <= 0) return { ...empty, status: 'Cerco il testo…' };
  if (!lyricsCache.has(id)) {
    lyricsCache.set(id, 'loading');
    void fetchLyrics(track.title ?? '', track.artist ?? '', d.duration()).then((l) => lyricsCache.set(id, l));
  }
  const l = lyricsCache.get(id);
  if (l === 'loading' || l === undefined) return { ...empty, status: 'Cerco il testo…' };
  if (!l) return { ...empty, status: 'Testo non trovato per questo brano.' };
  const al = aligns.get(id) ?? IDENTITY;
  lyricsPosition = d.position();
  const lines = l.synced!;
  const status = l.estimated ? `Testo da ${l.source}: tempi stimati dalla durata (non esatti).`
    : l.approx ? `Testo da ${l.source}: versione con durata diversa dal video.`
    : `Testo da ${l.source}, sincronizzato con il brano in onda.`;
  return { ...empty, ...snapshotAt(lines, lyricsPosition, al), offset: al.b, speed: al.a, canShift: true, lines: lines.map((x) => x.text), index: indexFor(lines, lyricsPosition, al), status: aligns.has(id) ? 'Testo allineato da te a questo video.' : status };
}

function publishLyrics(ly: ViewModel['lyrics']) {
  const msg = JSON.stringify({ on: settings.showLyrics && ly.canShift, prev: ly.prev, cur: ly.cur, next: ly.next });
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
    role, volume: sliders[i], duck: ducked[i],
  };
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
    queue: queue.all().map((t, i) => ({ id: t.videoId, title: titleOf(t), artist: t.artist ?? '', bad: t.status === 'unplayable', locked: !!t.locked, current: i === cur && (am?.state() ?? 'idle') !== 'idle' })),
    history: queue.history().map((t) => titleOf(t)),
    problems,
  };
}

window.setInterval(() => ui.update(viewModel()), 250);
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
  ui.setStatus('Incolla il link di una playlist YouTube per cominciare.');
  if (settings.playlistText) {
    ui.linkInput.value = settings.playlistText;
    ui.loadBtn.click();
  }
  log('info', 'app.ready');
})();

