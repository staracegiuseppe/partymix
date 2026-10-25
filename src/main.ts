import './ui/style.css';
import { Automix } from './automix';
import { log, setSinks } from './log';
import { buildTracks, oembedMeta, verifyReplacement } from './playlistLoader';
import { parsePlaylistInput } from './playlistUrl';
import { Queue, Track } from './queue';
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

const ui = buildConsole(document.getElementById('app')!, {
  async loadPlaylist(text) {
    const parsed = parsePlaylistInput(text);
    if (parsed.kind === 'invalid') { ui.setStatus('Link non valido: incolla il link di una playlist o di un video YouTube.', true); return; }
    if (!decks) { ui.setStatus('I player YouTube non sono ancora pronti.', true); return; }
    ui.loadBtn.disabled = true;
    try {
      ui.setStatus('Leggo la playlist…');
      const ids = parsed.kind === 'playlist' ? await decks[0].readPlaylist(parsed.listId) : [parsed.videoId];
      if (ids.length === 0) { ui.setStatus('La playlist è vuota o non è pubblica.', true); return; }
      ui.setStatus(`Carico i dettagli di ${ids.length} brani…`);
      const tracks = await buildTracks(ids, oembedMeta, 5);
      setQueue(tracks);
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
    if (!am) { setQueue([r.track]); } else { queue.add(r.track); }
    return `Aggiunto: ${titleOf(r.track)}`;
  },
  async replace(oldId, text) {
    const r = await verifyReplacement(text, fetch, probe);
    if (r.ok && r.track) queue.replace(oldId, r.track);
    return { ok: r.ok, message: r.message };
  },
  openProjector: () => openProjector(settings.projectorDisplay),
  closeProjector: () => void closeProjector(),
  setDisplay: (n) => { settings.projectorDisplay = n; save(); },
  setMic: (id) => { settings.micDeviceId = id || undefined; save(); },
  setMicSensitivity: (v) => { settings.micSensitivity = v; save(); },
  refreshInputs: () => listInputs(),
});
ui.setSensitivity(settings.micSensitivity);
if (hasNativeDisplays()) void listDisplays().then((n) => ui.setDisplays(n, settings.projectorDisplay)).catch(() => {});

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
  return {
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

if (import.meta.env.VITE_BEACON) void import('./selftest').then((m) => m.run());
