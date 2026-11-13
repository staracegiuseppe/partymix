import type { AutomixState } from '../automix';
import type { Profile } from '../crossfade';
import { isAndroidApp } from '../androidBridge';
import { fmtTime, h, paintWords } from './dom';
import { showAppPicker, showFeedback, showInfo, startTour, startWizard, TourStep } from './guide';
import { UNAVAILABLE_WITH_YOUTUBE } from './unavailable';

export type Actions = {
  loadPlaylist(text: string): void;
  /** Switches to playlist 1 or 2: puts its saved link in the box and loads it. */
  selectPlaylist(slot: 0 | 1): void;
  setProjectorMode(mode: 'karaoke' | 'video'): void;
  /** Gives the playlist in use a name of the user's choice. */
  renamePlaylist(name: string): void;
  start(): void;
  stop(): void;
  next(): void;
  togglePause(): void;
  mixNow(): void;
  playNow(videoId: string): void;
  setProfile(p: Profile): void;
  setMaster(v: number): void;
  seek(i: 0 | 1, seconds: number): void;
  setDeckVolume(i: 0 | 1, v: number): void;
  toggleDuck(i: 0 | 1): void;
  toggleLock(videoId: string): void;
  move(from: number, to: number): void;
  /** Takes a song out of the playlist in use (and out of the copy saved on the PC). */
  removeTrack(videoId: string): void;
  setShuffle(on: boolean): void;
  setRepeat(r: 'off' | 'all' | 'one'): void;
  shuffleNow(): void;
  addVideo(text: string): Promise<string>;
  replace(oldVideoId: string, text: string): Promise<{ ok: boolean; message: string }>;
  openProjector(): Promise<void>;
  closeProjector(): void;
  setDisplay(name: string): void;
  setMic(id: string): void;
  setMicSensitivity(v: number): void;
  refreshInputs(): Promise<{ id: string; label: string }[]>;
  refreshNow(): void;
  setAutoRefresh(minutes: number): void;
  shiftLyrics(deltaSeconds: number): void;
  setLyricsSpeed(speed: number): void;
  stepLyricsLine(n: number): void;
  anchorLyrics(lineIndex: number): void;
  resetLyricsAlign(): void;
  setShowLyrics(on: boolean): void;
  setLyricsHighlight(on: boolean): void;
  markWelcomed(): void;
  retryKaraoke(): void;
  setAdGuard(on: boolean): void;
  setAdThreshold(t: number): void;
  setSpotMode(m: 'off' | 'duck' | 'skip'): void;
  setKaraokeAuto(on: boolean): void;
};

export type DeckVM = { title: string; artist: string; thumb?: string; elapsed: number; duration: number; role: 'live' | 'out' | 'ready' | 'loading' | 'idle'; volume: number; duck: boolean; autoDuck?: boolean };
export type QueueRowVM = { id: string; title: string; artist: string; bad: boolean; locked: boolean; current: boolean; lyr?: 'synced' | 'plain' | 'none' };
export type KaraokeVM = { running: boolean; waiting: boolean; total: number; done: number; synced: number; plain: number; none: number; pending: number; auto: boolean };
export type LyricsVM = { status: string; prev: string; cur: string; next: string; progress: number; plain?: string; offset: number; speed: number; show: boolean; highlight?: boolean; canShift: boolean; lines: string[]; index: number };
export type AdsVM = { available: boolean; on: boolean; kind: 'music' | 'speech' | 'silence'; level: number; error?: string; silentFor: number; threshold: number; spotMode?: 'off' | 'duck' | 'skip'; spotNow?: boolean; ducking: boolean; playing: boolean; events?: { time: string; kind: 'music' | 'speech' | 'silence'; score: number; label: string; detail?: string }[] };
export type ViewModel = {
  lyrics: LyricsVM;
  ads: AdsVM;
  karaoke: KaraokeVM;
  state: AutomixState;
  active: 0 | 1;
  ready: boolean;
  decks: [DeckVM, DeckVM];
  mix: number;
  master: number;
  profile: Profile;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  queue: QueueRowVM[];
  history: string[];
  problems: string[];
};

const PROFILES: { id: Profile; label: string; hint: string }[] = [
  { id: 'morbida', label: 'Morbida', hint: 'Sfumatura lunga, circa 12 secondi' },
  { id: 'standard', label: 'Standard', hint: 'Circa 8 secondi' },
  { id: 'energica', label: 'Energica', hint: 'Passaggio rapido, circa 4 secondi' },
  { id: 'manuale', label: 'Manuale', hint: 'Il cambio avviene solo quando lo chiedi tu' },
];
/** Shown until a playlist is loaded: nothing is the source yet, so say what to do instead of naming one. */
export const EMPTY_SOURCE = '↓ Carica la tua playlist (Spotify / YouTube)';
const fmtSpeed = (v: number) => '×' + v.toFixed(2).replace('.', ',');
const ROLE_LABEL: Record<DeckVM['role'], string> = { live: 'IN ONDA', out: 'IN USCITA', ready: 'PRONTO', loading: 'PREPARAZIONE…', idle: 'FERMO' };

export function buildConsole(root: HTMLElement, a: Actions) {
  const pill = h('span', { class: 'pill empty', title: 'Incolla qui sotto il link di una playlist Spotify o YouTube' }, EMPTY_SOURCE);
  const status = h('div', { class: 'status', role: 'status' });
  const statusListeners = new Set<(text: string, error: boolean) => void>();
  let lastVm: ViewModel | undefined;
  const link = h('input', { type: 'text', placeholder: 'Incolla il link di una playlist YouTube o Spotify', 'aria-label': 'Link della playlist YouTube o Spotify' });
  const loadBtn = h('button', { onClick: () => a.loadPlaylist(link.value) }, 'Carica playlist');
  link.addEventListener('keydown', (e) => { if (e.key === 'Enter') a.loadPlaylist(link.value); });

  const mkDeck = (i: 0 | 1) => {
    const mount = h('div', { class: 'player' });
    const role = h('span', { class: 'role' });
    const cover = h('div', { class: 'cover' });
    const title = h('div', { class: 'title' });
    const artist = h('div', { class: 'artist' });
    const el = h('span'), rem = h('span');
    let seeking = false;
    const seek = h('input', { type: 'range', class: 'seek', min: '0', max: '0', step: '1', value: '0', disabled: true, 'aria-label': `Posizione deck ${i ? 'B' : 'A'}`,
      onPointerdown: () => { seeking = true; }, onKeydown: () => { seeking = true; },
      onInput: () => { el.textContent = fmtTime(+seek.value); rem.textContent = '-' + fmtTime(+seek.max - +seek.value); },
      onChange: () => { seeking = false; a.seek(i, +seek.value); },
      onPointerup: () => { seeking = false; }, onBlur: () => { seeking = false; } });
    const isSeeking = () => seeking;
    const vol = h('input', { type: 'range', min: '0', max: '100', 'aria-label': `Volume deck ${i ? 'B' : 'A'}`, onInput: () => a.setDeckVolume(i, +vol.value) });
    const duck = h('button', { 'aria-pressed': 'false', title: 'Abbassa il volume di questo deck (ad esempio durante una pubblicità)', onClick: () => a.toggleDuck(i) }, 'Abbassa volume');
    const card = h('section', { class: `panel deck ${i ? 'b' : 'a'}` },
      h('h2', {}, h('span', {}, `DECK ${i ? 'B' : 'A'}`), role),
      mount,
      h('div', { class: 'meta' }, cover, h('div', { style: 'min-width:0' }, title, artist)),
      h('div', { class: 'times' }, el, rem),
      seek,
      h('div', { class: 'row' }, h('label', {}, 'Volume deck'), vol),
      h('div', { class: 'row' }, duck),
    );
    return { mount, card, role, cover, title, artist, el, rem, seek, isSeeking, vol, duck };
  };
  const dA = mkDeck(0), dB = mkDeck(1);

  const knob = h('i');
  const mixText = h('div', { class: 'artist', style: 'text-align:center' });
  const bigBtn = h('button', { class: 'big' });
  const nextBtn = h('button', { onClick: () => a.next() }, 'Prossimo brano');
  const pauseBtn = h('button', { onClick: () => a.togglePause() }, 'Pausa');
  const mixBtn = h('button', { class: 'wide', onClick: () => a.mixNow() }, 'Transizione immediata');
  const master = h('input', { type: 'range', min: '0', max: '100', 'aria-label': 'Volume generale', onInput: () => a.setMaster(+master.value) });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Modalità di transizione' });
  const segBtns = PROFILES.map((p) => h('button', { title: p.hint, 'aria-pressed': 'false', onClick: () => a.setProfile(p.id) }, p.label));
  seg.append(...segBtns);
  const mixer = h('section', { class: 'panel mixer' },
    h('div', { class: 'xlabels' }, h('span', {}, 'A'), h('span', {}, 'CROSSFADE'), h('span', {}, 'B')),
    h('div', { class: 'xfade' }, knob), mixText,
    bigBtn,
    h('div', { class: 'btns' }, nextBtn, pauseBtn, mixBtn),
    h('div', {}, h('div', { class: 'artist' }, 'Volume generale'), master),
    h('div', {}, h('div', { class: 'artist' }, 'Transizione'), seg),
  );

  const shuffleBtn = h('button', { 'aria-pressed': 'false', onClick: () => a.setShuffle(shuffleBtn.getAttribute('aria-pressed') !== 'true') }, 'Casuale');
  const shuffleNow = h('button', { title: 'Rimescola i brani che devono ancora suonare', onClick: () => a.shuffleNow() }, 'Rimescola ora');
  const repeatBtn = h('button', { onClick: () => a.setRepeat(repeatBtn.dataset.next as 'off' | 'all' | 'one') });
  const refreshInfo = h('div', { class: 'status' });
  const refreshSel = h('select', { 'aria-label': 'Aggiornamento automatico della playlist', onChange: () => a.setAutoRefresh(+refreshSel.value) },
    ...[[0, 'Solo manuale'], [2, 'Ogni 2 minuti'], [5, 'Ogni 5 minuti'], [10, 'Ogni 10 minuti'], [30, 'Ogni 30 minuti']].map(([v, l]) => h('option', { value: String(v) }, String(l))));
  const refreshBtn = h('button', { title: 'Controlla su YouTube se la playlist è cambiata', onClick: () => a.refreshNow() }, 'Aggiorna ora');
  const queueList = h('div', { class: 'list' });
  const addLink = h('input', { type: 'text', placeholder: 'Aggiungi un video (link)', 'aria-label': 'Aggiungi un video alla coda' });
  const addMsg = h('div', { class: 'status' });
  const addBtn = h('button', { onClick: async () => { addMsg.textContent = await a.addVideo(addLink.value); } }, 'Aggiungi');
  const queuePanel = h('section', { class: 'panel' },
    h('h3', {}, 'Coda'),
    h('div', { class: 'opts' }, shuffleBtn, shuffleNow, repeatBtn),
    h('div', { class: 'row' }, refreshBtn, refreshSel), refreshInfo,
    queueList,
    h('div', { class: 'row' }, addLink, addBtn), addMsg,
  );

  const warnList = h('div');
  const warnPanel = h('section', { class: 'panel warn hidden' }, h('h3', {}, 'Brani non riproducibili'),
    h('div', { class: 'artist', style: 'margin-bottom:8px' }, 'Incolla il link di un brano sostitutivo: ti dico subito se va bene.'), warnList);
  const histList = h('div', { class: 'list' });
  const problems = h('ul', { class: 'problems' });
  const unav = h('details', {}, h('summary', {}, 'Non disponibile con YouTube'),
    h('ul', {}, ...UNAVAILABLE_WITH_YOUTUBE.map((u) => h('li', {}, u.name, h('span', {}, u.why)))));
  const dispSel = h('select', { 'aria-label': 'Schermo del proiettore', onChange: () => a.setDisplay(dispSel.value) });
  const dispRow = h('div', { class: 'row hidden' }, h('label', {}, 'Schermo'), dispSel);
  const micSel = h('select', { 'aria-label': 'Ingresso audio', onChange: () => a.setMic(micSel.value) }, h('option', { value: '' }, 'Predefinito'));
  const micBtn = h('button', { onClick: async () => { setInputs(await a.refreshInputs(), micSel.value); } }, 'Cerca ingressi');
  const sens = h('input', { type: 'range', min: '0.2', max: '4', step: '0.1', 'aria-label': 'Sensibilità del microfono', onInput: () => a.setMicSensitivity(+sens.value) });
  const projMsg = h('div', { class: 'status' });
  const projModeBtns = ([['karaoke', 'Karaoke'], ['video', 'Video YouTube']] as const).map(([m, label]) =>
    h('button', { 'aria-pressed': 'false', 'data-mode': m, onClick: () => a.setProjectorMode(m) }, label));
  const projModeHint = h('div', { class: 'artist wrap' });
  function setProjectorMode(m: 'karaoke' | 'video') {
    projModeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    projModeHint.textContent = m === 'video'
      ? 'Il proiettore mostra a tutto schermo il video del brano in onda (es. Just Dance), muto e allineato alla musica. Quando YouTube mostra una pubblicità o il video non è ancora allineato, al suo posto restano le forme.'
      : 'Le forme seguono il suono della stanza tramite il microfono, con il testo del brano. Non viene registrato nulla.';
  }
  const projPanel = h('section', { class: 'panel' }, h('h3', {}, 'Proiettore'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Cosa mostrare sul proiettore' }, ...projModeBtns), projModeHint,
    h('div', { class: 'btns' },
      h('button', { onClick: async () => { projMsg.textContent = ''; try { await a.openProjector(); } catch (e) { projMsg.textContent = `Non riesco ad aprire il proiettore: ${(e as Error)?.message ?? String(e)}`; } } }, 'Apri proiettore'),
      h('button', { onClick: () => a.closeProjector() }, 'Chiudi proiettore')),
    dispRow,
    h('div', { class: 'row' }, h('label', {}, 'Ingresso'), micSel), h('div', { class: 'row' }, micBtn),
    h('div', { class: 'row' }, h('label', {}, 'Sensibilità'), sens), projMsg);
  const lyStatus = h('div', { class: 'artist' });
  const lyPrev = h('div', { class: 'ly prev' }), lyCur = h('div', { class: 'ly cur' }), lyNext = h('div', { class: 'ly next' });
  const lyPlain = h('pre', { class: 'plain hidden' });
  const lyOffset = h('span', { class: 'artist' });
  const lyEarly = h('button', { onClick: () => a.shiftLyrics(0.5) }, 'Anticipa 0,5 s');
  const lyLate = h('button', { onClick: () => a.shiftLyrics(-0.5) }, 'Ritarda 0,5 s');
  const lyBack = h('button', { class: 'linestep', title: 'Il testo è avanti rispetto al video: torna indietro di una riga', onClick: () => a.stepLyricsLine(-1) }, '↑ Riga indietro');
  const lyForward = h('button', { class: 'linestep', title: 'Il testo è indietro rispetto al video: salta una riga avanti', onClick: () => a.stepLyricsLine(1) }, '↓ Riga avanti');
  let lyLastIndex = -1;
  const lyFirst = h('button', { class: 'quicksync', title: 'Premi nel momento esatto in cui il cantante inizia la PRIMA riga del testo', onClick: () => a.anchorLyrics(0) }, '① Qui inizia la prima riga');
  const lyLast = h('button', { class: 'quicksync', title: 'Premi nel momento in cui il cantante inizia l’ULTIMA riga del testo', onClick: () => { if (lyLastIndex >= 0) a.anchorLyrics(lyLastIndex); } }, '② Qui inizia l’ultima riga');
  const lyEarlyFine = h('button', { title: 'Anticipa di un decimo di secondo', onClick: () => a.shiftLyrics(0.1) }, 'Anticipa 0,1');
  const lyLateFine = h('button', { title: 'Ritarda di un decimo di secondo', onClick: () => a.shiftLyrics(-0.1) }, 'Ritarda 0,1');
  const lyShow = h('input', { type: 'checkbox', 'aria-label': 'Mostra il testo sul proiettore', onChange: () => a.setShowLyrics(lyShow.checked) });
  const lyHl = h('input', { type: 'checkbox', 'aria-label': 'Parole che si illuminano mentre vengono cantate', onChange: () => a.setLyricsHighlight(lyHl.checked) });
  const lyList = h('div', { class: 'lylist hidden' });
  const lyHint = h('div', { class: 'artist hidden' }, 'Il testo non combacia (versione karaoke, live…)? Tocca nell’elenco la riga che si sta cantando adesso. Con due tocchi, uno all’inizio e uno più avanti, si adatta anche la velocità.');
  const lyReset = h('button', { onClick: () => a.resetLyricsAlign() }, 'Azzera allineamento');
  const lySpeed = h('input', { type: 'range', min: '0.5', max: '2', step: '0.01', value: '1', 'aria-label': 'Velocità delle parole sul proiettore', onInput: () => { lySpeedVal.textContent = fmtSpeed(+lySpeed.value); a.setLyricsSpeed(+lySpeed.value); } });
  const lySpeedVal = h('span', { class: 'speedval' }, '×1,00');
  const lySlower = h('button', { 'aria-label': 'Parole più lente', onClick: () => a.setLyricsSpeed(+lySpeed.value - 0.01) }, '−');
  const lyFaster = h('button', { 'aria-label': 'Parole più veloci', onClick: () => a.setLyricsSpeed(+lySpeed.value + 0.01) }, '+');
  const lyricsPanel = h('section', { class: 'panel' }, h('h3', {}, 'Testo'), lyStatus, lyPlain, lyHint, lyList);
  const syncBar = h('section', { class: 'panel syncbar', 'aria-label': 'Sincronia del testo sul proiettore' },
    h('div', { class: 'synctext' }, lyCur, lyNext),
    h('div', { class: 'synctools' },
      h('div', { class: 'row' }, lyFirst, lyLast, lyBack, lyForward),
      h('div', { class: 'row speed' }, h('label', {}, 'Velocità parole'), lySlower, lySpeed, lyFaster, lySpeedVal),
      h('div', { class: 'row' }, lyEarly, lyEarlyFine, lyLateFine, lyLate, lyReset, lyOffset, h('label', { class: 'show' }, lyShow, 'Mostra sul proiettore'),
        h('label', { class: 'show', title: 'Spento: la riga cantata resta tutta bianca, senza le parole gialle che avanzano (utile quando non sono a tempo)' }, lyHl, 'Parole che si illuminano'))));
  const histPanel = h('section', { class: 'panel' }, h('h3', {}, 'Già suonati'), histList);
  const probPanel = h('section', { class: 'panel' }, h('h3', {}, 'Stato e problemi'), problems);
  const kBar = h('div', { class: 'kbar' }, h('i'));
  const kText = h('div', { class: 'status' });
  const kAuto = h('input', { type: 'checkbox', 'aria-label': 'Cerca i testi in automatico', onChange: () => a.setKaraokeAuto(kAuto.checked) });
  const kRetry = h('button', { title: 'Cerca di nuovo i testi che non ho trovato', onClick: () => a.retryKaraoke() }, 'Cerca i testi mancanti');
  const karaokePanel = h('section', { class: 'panel' }, h('h3', {}, 'Karaoke automatico'),
    h('div', { class: 'artist wrap' }, 'In sottofondo cerco i testi di tutti i brani, così sono pronti quando partono. «a tempo» = tempi esatti; «stimato» = testo trovato ma tempi calcolati: regolali con i due tasti ① ② della barra in basso.'),
    kBar, kText, h('div', { class: 'row' }, kRetry), h('label', { class: 'row' }, kAuto, 'Cerca i testi in automatico'));
  const adOn = h('input', { type: 'checkbox', 'aria-label': 'Abbassa il volume durante le pubblicità', onChange: () => a.setAdGuard(adOn.checked) });
  const adMeter = h('div', { class: 'kbar' }, h('i'));
  const adText = h('div', { class: 'status' });
  const adSens = h('select', { 'aria-label': 'Sensibilità del rilevamento', onChange: () => a.setAdThreshold(+adSens.value) },
    h('option', { value: '3' }, 'Alta (scatta prima)'), h('option', { value: '4' }, 'Normale'), h('option', { value: '5' }, 'Prudente (scatta meno)'));
  const adSpot = h('select', { 'aria-label': 'Brani brevi (spot)', onChange: () => a.setSpotMode(adSpot.value as 'off' | 'duck' | 'skip') },
    h('option', { value: 'off' }, 'Non fare niente'), h('option', { value: 'duck' }, 'Abbassa il volume'), h('option', { value: 'skip' }, 'Salta al brano dopo'));
  const adLog = h('div', { class: 'adlog' });
  const adPanel = h('section', { class: 'panel' }, h('h3', {}, 'Pubblicità'),
    h('div', { class: 'artist wrap' }, 'Ascolto l’audio che sta suonando sul computer (non il microfono) e, se sembra una voce che parla come in uno spot e non una canzone, abbasso il volume da solo; quando torna la musica lo rialzo. L’audio non viene registrato né salvato.'),
    h('label', { class: 'row' }, adOn, 'Abbassa il volume durante le pubblicità'), adMeter, adText, adLog,
    h('div', { class: 'row' }, h('label', {}, 'Sensibilità'), adSens),
    h('div', { class: 'artist wrap' }, 'Gli spot nelle playlist sono clip brevi, le canzoni durano minuti: un brano sotto i 75 secondi lo considero uno spot. Funziona anche senza ascoltare l’audio e anche quando sotto la voce c’è solo musica.'),
    h('div', { class: 'row' }, h('label', {}, 'Brani brevi (spot)'), adSpot));
  const side = h('div', { class: 'side' }, warnPanel, projPanel, adPanel, karaokePanel, lyricsPanel,
    histPanel, probPanel,
    h('section', { class: 'panel' }, unav));

  // Phone: no copy and paste. Pick the playlist in the YouTube or Spotify app, «Condividi → PartyMix», it loads by itself.
  const appsBtn = isAndroidApp() ? h('button', { class: 'primary apps-btn', onClick: () => showAppPicker((m) => setStatus(m, true)) }, '📱 Scegli dalle app') : null;
  const slotBtns = ([0, 1] as const).map((i) => h('button', { 'aria-pressed': 'false', onClick: () => a.selectPlaylist(i) }, `Playlist ${i + 1}`));
  const slotSeg = h('div', { class: 'seg slots', role: 'group', 'aria-label': 'Playlist in uso' }, ...slotBtns);
  const nameInput = h('input', { type: 'text', class: 'plname', maxlength: '60', placeholder: 'Nome della playlist', 'aria-label': 'Nome della playlist in uso',
    onChange: () => a.renamePlaylist(nameInput.value) });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
  const savedInfo = h('span', { class: 'artist saved' });
  const loadRow = h('div', { class: 'load' }, slotSeg, nameInput, savedInfo, link, loadBtn, appsBtn);
  /** Shows the two playlists by name, which one is in use, and how many songs of it are saved on this computer. */
  /** A line about the projector that the app keeps up to date (Android: the cast screen). */
  function setProjectorInfo(text: string) { if (projMsg.textContent !== text) projMsg.textContent = text; }
  function setPlaylistSlots(slot: 0 | 1, links: [string, string], names: [string, string] = ['', ''], saved: [number, number] = [0, 0]) {
    slotBtns.forEach((b, i) => {
      const label = names[i]?.trim() || `Playlist ${i + 1}`;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(i === slot));
      b.title = links[i] ? `${label}: ${links[i]}${saved[i] ? ` (${saved[i]} ${saved[i] === 1 ? 'brano salvato' : 'brani salvati'} sul PC)` : ''}` : `${label}: vuota. Sceglila, incolla un link e premi «Carica playlist».`;
      b.classList.toggle('empty', !links[i]);
    });
    if (document.activeElement !== nameInput) nameInput.value = names[slot] ?? '';
    nameInput.placeholder = `Nome per «Playlist ${slot + 1}»`;
    savedInfo.textContent = saved[slot] ? `💾 ${saved[slot]} ${saved[slot] === 1 ? 'brano salvato' : 'brani salvati'} sul PC` : '';
  }
  const openTutorial = () => void startTour(tourSteps());
  const openWizard = () => startWizard({
    loadPlaylist: (t) => a.loadPlaylist(t),
    onStatus: (fn) => { statusListeners.add(fn); fn(status.textContent ?? '', status.classList.contains('error')); return () => statusListeners.delete(fn); },
    currentLink: () => link.value,
    openProjector: () => a.openProjector(),
    closeProjector: () => a.closeProjector(),
    refreshInputs: async () => { const l = await a.refreshInputs(); setInputs(l, micSel.value); return l; },
    setMic: (id) => { a.setMic(id); micSel.value = id; },
    currentProfile: () => lastVm?.profile ?? 'standard',
    setProfile: (p) => a.setProfile(p),
    canStart: () => !!lastVm?.ready,
    start: () => a.start(),
    openTutorial,
    finished: () => a.markWelcomed(),
  });
  const openInfo = () => showInfo({ openTutorial, openWizard });
  const tourSteps = (): TourStep[] => [
    { target: () => pill, title: 'La sorgente', text: 'All’inizio qui c’è scritto «Carica la tua playlist»: significa che non c’è ancora nessuna musica. Appena carichi una playlist, qui compare da dove arriva: Spotify o YouTube.' },
    { target: () => loadRow, title: 'La playlist', text: 'Qui incolli il link di una playlist YouTube oppure di una playlist o album Spotify (pubblici) e premi «Carica playlist». Con Spotify l’app prende l’elenco dei brani e li suona da YouTube.' },
    { target: () => status, title: 'Messaggi dell’app', text: 'Questa riga ti dice cosa sta facendo l’app: quanti brani ha caricato, eventuali brani non trovati o errori di rete.' },
    { target: () => dA.card, title: 'Deck A', text: 'Un deck è un giradischi virtuale: mostra il video, il titolo, quanto manca alla fine e un cursore per spostarti nel brano. Sotto c’è il volume solo di questo deck e il tasto per abbassarlo al volo (ad esempio durante una pubblicità).' },
    { target: () => dB.card, title: 'Deck B', text: 'Il secondo giradischi. L’app suona un brano su un deck e prepara il successivo sull’altro: così tra un brano e l’altro non c’è mai silenzio. «IN ONDA» è il deck che stai ascoltando, «PRONTO» quello che aspetta.' },
    { target: () => mixer.querySelector('.xfade') as HTMLElement, title: 'Il crossfade', text: 'La barra colorata mostra il passaggio da un deck all’altro: la manopola bianca si sposta da A verso B mentre un brano sfuma nel successivo.' },
    { target: () => bigBtn, title: 'Avvia automix', text: 'È il tasto principale. Premilo e parte il primo brano; da lì in poi l’app mixa da sola, un brano dopo l’altro, finché non premi «Ferma automix».' },
    { target: () => nextBtn.parentElement as HTMLElement, title: 'Prossimo, pausa, transizione', text: '«Prossimo brano» salta al successivo con una sfumatura. «Pausa» ferma tutto. «Transizione immediata» avvia subito il passaggio al brano pronto, senza aspettare la fine.' },
    { target: () => master.parentElement as HTMLElement, title: 'Volume generale', text: 'Alza o abbassa il volume di tutta la festa. Si può regolare anche con la tastiera.' },
    { target: () => seg.parentElement as HTMLElement, title: 'Stile delle transizioni', text: 'Morbida (circa 12 secondi), Standard (8), Energica (4) oppure Manuale, dove il cambio avviene solo quando lo decidi tu.' },
    { target: () => syncBar, title: 'Testo da cantare', text: 'Qui vedi la riga che si sta cantando: le parole diventano gialle mentre vengono cantate, come sul proiettore. Se il testo non è a tempo con il video usa «Velocità parole», «Riga indietro/avanti» o «Anticipa/Ritarda». Con i karaoke l’app compensa da sola l’intro.' },
    { target: () => queuePanel, title: 'La coda', text: 'L’elenco dei brani: con un doppio clic su un brano lo suoni subito (sfuma sopra quello in corso); trascinali (o usa Su e Giù) per cambiare ordine. «Blocca» impedisce di saltare un brano, «Casuale» mischia l’ordine, «Ripeti» fa ricominciare la playlist. In fondo puoi aggiungere un video col suo link.' },
    { target: () => karaokePanel, title: 'Karaoke automatico', text: 'Appena carichi una playlist, in sottofondo cerco i testi di tutti i brani. «A tempo» vuol dire tempi esatti; «stimato» vuol dire testo trovato ma tempi calcolati (tipico dei brani in dialetto o poco noti): premi i due tasti ① e ② della barra in basso quando il cantante inizia la prima e l’ultima riga, e il testo si allinea per sempre.' },
    { target: () => adPanel, title: 'Pubblicità', text: 'Se attivi questa funzione, PartyMix ascolta l’audio che sta suonando (non il microfono). Quando sente una voce che parla come in uno spot e non una canzone, abbassa il volume da solo e lo rialza quando torna la musica. La prima volta il Mac chiede il permesso di registrare l’audio di sistema. Uno spot con solo musica non si riconosce dal suono: per quelli c’è «Brani brevi (spot)», che tratta come pubblicità i brani sotto i 75 secondi (abbassa il volume o salta al brano dopo).' },
    { target: () => projPanel, title: 'Il proiettore', text: '«Apri proiettore» apre una seconda finestra a schermo intero da mandare su TV o videoproiettore: forme colorate che seguono la musica e il testo da cantare. Qui scegli lo schermo, il microfono e la sensibilità.' },
    { target: () => lyricsPanel, title: 'Il pannello Testo', text: 'Mostra da dove viene il testo e l’elenco di tutte le righe. Se il testo non combacia con il video, tocca la riga che si sta cantando in quel momento: l’app si allinea da sola.' },
    { target: () => histPanel, title: 'Già suonati', text: 'L’elenco dei brani già passati nella serata.' },
    { target: () => probPanel, title: 'Stato e problemi', text: 'Qui compaiono, in italiano semplice, i problemi che l’app ha incontrato, come un brano che non si carica: quel brano viene saltato e la festa continua.' },
    { target: () => topTools, title: 'Aiuto e informazioni', text: 'Da qui puoi rifare la configurazione guidata, rivedere questo tutorial e aprire le informazioni, dove trovi anche la donazione facoltativa per chi ha creato l’app. Con «💬 Commenti» mi scrivi cosa ne pensi e cosa aggiungere. Buona festa!' },
  ];
  const topTools = h('div', { class: 'top-tools' },
    h('button', { onClick: openWizard }, 'Configurazione guidata'),
    h('button', { onClick: openTutorial }, 'Tutorial'),
    h('button', { onClick: openInfo }, 'Info'),
    h('button', { title: 'Scrivimi cosa ne pensi e cosa vorresti trovare in PartyMix', onClick: () => showFeedback() }, '💬 Commenti'));
  root.append(h('div', { class: 'wrap' },
    h('header', { class: 'top' }, h('div', { class: 'logo' }, 'Party', h('b', {}, 'Mix')),
      pill, topTools),
    loadRow, status,
    h('div', { class: 'decks' }, dA.card, mixer, dB.card), syncBar,
    h('div', { class: 'lower' }, queuePanel, side)));

  let dragFrom = -1;
  /** «Togli» asks once more («Sicuro?») before taking a song out, so a slip of the mouse does not delete it. */
  let armed: { id: string; until: number } | undefined;
  const removeBtn = (r: QueueRowVM) => {
    const sure = armed?.id === r.id && Date.now() < armed.until;
    const b = h('button', {
      class: 'del' + (sure ? ' sure' : ''),
      disabled: r.current,
      title: r.current ? 'Il brano in onda non si può togliere' : 'Togli questo brano dalla playlist',
      'aria-label': `Togli ${r.title} dalla playlist`,
      onClick: () => {
        if (armed?.id === r.id && Date.now() < armed.until) { armed = undefined; a.removeTrack(r.id); return; }
        armed = { id: r.id, until: Date.now() + 3000 };
        b.textContent = 'Sicuro?'; b.classList.add('sure');
        setTimeout(() => { if (armed?.id === r.id) { armed = undefined; b.textContent = '✕ Togli'; b.classList.remove('sure'); } }, 3000);
      },
    }, sure ? 'Sicuro?' : '✕ Togli');
    return b;
  };
  const clearOver = () => queueList.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
  const memo = new Map<string, string>();
  const replMsg = new Map<string, { ok: boolean; text: string }>();
  const once = (key: string, sig: string, fn: () => void) => { if (memo.get(key) !== sig) { memo.set(key, sig); fn(); } };

  const paintDeck = (d: ReturnType<typeof mkDeck>, v: DeckVM) => {
    d.role.textContent = ROLE_LABEL[v.role];
    d.role.className = 'role' + (v.role === 'live' || v.role === 'out' ? ' live' : '');
    d.title.textContent = v.title || '—';
    d.artist.textContent = v.artist || '';
    d.cover.style.backgroundImage = v.thumb ? `url("${v.thumb.replace(/"/g, '')}")` : '';
    const canSeek = (v.role === 'live' || v.role === 'out') && v.duration > 0;
    d.seek.disabled = !canSeek;
    if (!d.isSeeking()) {
      d.el.textContent = fmtTime(v.elapsed);
      d.rem.textContent = v.duration > 0 ? '-' + fmtTime(v.duration - v.elapsed) : '';
      d.seek.max = String(Math.max(0, Math.floor(v.duration)));
      d.seek.value = String(Math.floor(v.elapsed));
    }
    if (document.activeElement !== d.vol) d.vol.value = String(v.volume);
    d.duck.setAttribute('aria-pressed', String(v.duck));
    d.duck.textContent = v.duck ? 'Volume abbassato: ripristina' : v.autoDuck ? 'Pubblicità: volume abbassato (auto)' : 'Abbassa volume';
  };

  function update(vm: ViewModel) {
    lastVm = vm;
    const ly = vm.lyrics;
    lyStatus.textContent = ly.status;
    lyPrev.textContent = ly.prev; lyNext.textContent = ly.next;
    if (ly.cur && ly.highlight !== false) paintWords(lyCur, ly.cur, ly.progress, '#ffd23f', '#eef1fb'); else lyCur.textContent = ly.cur || (ly.canShift ? '♪' : '');
    lyPlain.textContent = ly.plain ?? ''; lyPlain.classList.toggle('hidden', !ly.plain);
    lyBack.disabled = lyForward.disabled = lyFirst.disabled = lyLast.disabled = lyEarly.disabled = lyLate.disabled = lyEarlyFine.disabled = lyLateFine.disabled = !ly.canShift;
    lyOffset.textContent = ly.canShift ? `Spostamento: ${ly.offset > 0 ? '+' : ''}${ly.offset.toFixed(1).replace('.', ',')} s` + (Math.abs(ly.speed - 1) > 0.005 ? ` · velocità ×${ly.speed.toFixed(2).replace('.', ',')}` : '') : '';
    lyReset.disabled = lySpeed.disabled = lySlower.disabled = lyFaster.disabled = !ly.canShift;
    if (document.activeElement !== lySpeed) { lySpeed.value = String(ly.speed); lySpeedVal.textContent = fmtSpeed(ly.speed); }
    lyHint.classList.toggle('hidden', !ly.canShift);
    lyLastIndex = ly.lines.length - 1;
    once('lylines', ly.lines.join('\u0001'), () => {
      lyList.classList.toggle('hidden', ly.lines.length === 0);
      lyList.replaceChildren(...ly.lines.map((t, i) => h('button', { class: 'lyline', title: 'Si sta cantando questa riga adesso', onClick: () => a.anchorLyrics(i) }, t || '♪')));
    });
    once('lyindex', ly.index + '|' + ly.lines.length, () => {
      const rows = [...lyList.children] as HTMLElement[];
      rows.forEach((r, i) => r.classList.toggle('now', i === ly.index));
      const cur = rows[ly.index];
      if (cur) lyList.scrollTop = Math.max(0, cur.offsetTop - lyList.clientHeight / 2);
    });
    if (document.activeElement !== lyShow) lyShow.checked = ly.show;
    if (document.activeElement !== lyHl) lyHl.checked = ly.highlight !== false;
    const k = vm.karaoke, known = k.synced + k.plain + k.none, all = known + k.pending;
    (kBar.firstChild as HTMLElement).style.width = `${all ? Math.round((known / all) * 100) : 0}%`;
    kText.textContent = all === 0 ? 'Carica una playlist per cominciare.'
      : `${k.running ? (k.waiting ? 'Aspetto un attimo (il servizio dei testi è occupato)… ' : 'Cerco i testi… ') : ''}Pronti ${known} di ${all}: ${k.synced} a tempo, ${k.plain} con tempi stimati, ${k.none} non trovati.`;
    kRetry.disabled = k.running || k.none + k.pending === 0;
    if (document.activeElement !== kAuto) kAuto.checked = k.auto;
    const ad = vm.ads;
    if (document.activeElement !== adOn) adOn.checked = ad.on;
    adOn.disabled = !ad.available;
    if (document.activeElement !== adSens) adSens.value = String(ad.threshold);
    adSens.disabled = !ad.available;
    if (document.activeElement !== adSpot) adSpot.value = ad.spotMode ?? 'off';
    (adMeter.firstChild as HTMLElement).style.width = `${Math.round(ad.level * 100)}%`;
    adText.textContent = !ad.available ? 'Disponibile solo nell’app installata (non nel browser).'
      : ad.error ? `Non riesco ad ascoltare l’audio: ${ad.error}`
      : !ad.on ? 'Spento.'
      : ad.spotNow ? 'Brano breve (spot): lo tratto come pubblicità.'
      : ad.ducking ? 'Ho sentito parlato (pubblicità): volume abbassato. Lo rialzo quando torna la musica.'
      : ad.kind === 'speech' ? 'Sento parlato.'
      : ad.kind === 'music' ? 'Sento musica: tutto a posto.'
      : ad.playing && ad.silentFor > 12 ? 'Non sento nessun suono. Se la musica suona, controlla in Impostazioni di Sistema › Privacy e sicurezza che PartyMix possa registrare l’audio di sistema.'
      : 'In ascolto: aspetto che parta la musica.';
    adLog.replaceChildren(...(ad.events ?? []).slice().reverse().map((e) => h('div', { class: 'artist wrap' }, `${e.time} ${e.kind === 'speech' ? 'parlato' : 'musica'} (punteggio ${e.score}${e.detail ? `: ${e.detail}` : ''})${e.label ? ` — ${e.label}` : ''}`)));
    paintDeck(dA, vm.decks[0]);
    paintDeck(dB, vm.decks[1]);
    const idle = vm.state === 'idle';
    const pos = vm.mix > 0 ? (vm.active === 0 ? vm.mix : 1 - vm.mix) : vm.active;
    knob.style.left = `calc(${pos * 100}% - 7px)`;
    mixText.textContent = vm.mix > 0 ? `Transizione in corso ${Math.round(vm.mix * 100)}%` : idle ? 'Automix fermo' : vm.state === 'paused' ? 'In pausa' : vm.state === 'preparing' ? 'Preparo il brano successivo…' : 'In riproduzione';
    bigBtn.textContent = idle ? '▶ AVVIA AUTOMIX' : '■ FERMA AUTOMIX';
    bigBtn.className = 'big' + (idle ? '' : ' on');
    bigBtn.onclick = () => (idle ? a.start() : a.stop());
    bigBtn.disabled = !vm.ready;
    nextBtn.disabled = mixBtn.disabled = pauseBtn.disabled = idle;
    pauseBtn.textContent = vm.state === 'paused' ? 'Riprendi' : 'Pausa';
    if (document.activeElement !== master) master.value = String(vm.master);
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PROFILES[i].id === vm.profile)));
    shuffleBtn.setAttribute('aria-pressed', String(vm.shuffle));
    const nextRepeat = { off: 'all', all: 'one', one: 'off' }[vm.repeat] as 'off' | 'all' | 'one';
    repeatBtn.dataset.next = nextRepeat;
    repeatBtn.textContent = { off: 'Ripeti: no', all: 'Ripeti: tutta la playlist', one: 'Ripeti: questo brano' }[vm.repeat];

    once('queue', JSON.stringify(vm.queue), () => {
      queueList.replaceChildren(...vm.queue.map((r, i) => h('div', {
        class: 'item' + (r.current ? ' cur' : '') + (r.bad ? ' bad' : ''),
        draggable: 'true',
        title: 'Doppio clic: suona subito questo brano. Trascina per cambiare ordine.',
        onDblclick: () => { if (!r.bad && !r.current) a.playNow(r.id); },
        onDragstart: (e: DragEvent) => { dragFrom = i; (e.currentTarget as HTMLElement).classList.add('dragging'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } },
        onDragover: (e: DragEvent) => { if (dragFrom < 0) return; e.preventDefault(); clearOver(); if (i !== dragFrom) (e.currentTarget as HTMLElement).classList.add('over'); },
        onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('over'),
        onDrop: (e: DragEvent) => { e.preventDefault(); const from = dragFrom; dragFrom = -1; clearOver(); if (from >= 0 && from !== i) a.move(from, i); },
        onDragend: (e: DragEvent) => { dragFrom = -1; clearOver(); (e.currentTarget as HTMLElement).classList.remove('dragging'); },
      },
        h('span', { class: 'artist' }, String(i + 1)),
        h('span', { class: 't' }, r.title + (r.artist ? ` — ${r.artist}` : ''), r.current ? h('span', { class: 'tag' }, 'in onda') : null, r.locked ? h('span', { class: 'tag' }, 'bloccato') : null, r.lyr === 'none' ? h('span', { class: 'tag' }, 'senza testo') : r.lyr === 'plain' ? h('span', { class: 'tag soft' }, 'testo stimato') : r.lyr === 'synced' ? h('span', { class: 'tag ok' }, 'testo a tempo') : null, r.bad ? h('span', { class: 'tag' }, 'non riproducibile') : null),
        h('span', { class: 'acts' },
          h('button', { 'aria-label': 'Sposta su', disabled: i === 0, onClick: () => a.move(i, i - 1) }, 'Su'),
          h('button', { 'aria-label': 'Sposta giù', disabled: i === vm.queue.length - 1, onClick: () => a.move(i, i + 1) }, 'Giù'),
          h('button', { 'aria-pressed': String(r.locked), title: 'Un brano bloccato non viene saltato con «Prossimo brano»', onClick: () => a.toggleLock(r.id) }, r.locked ? 'Sblocca' : 'Blocca'),
          removeBtn(r)))));
    });
    once('hist', vm.history.join('|'), () => histList.replaceChildren(...vm.history.slice().reverse().slice(0, 50).map((t) => h('div', { class: 't artist' }, t))));
    once('prob', vm.problems.join('|'), () => problems.replaceChildren(...(vm.problems.length ? vm.problems : ['Nessun problema segnalato']).map((p) => h('li', {}, p))));
    const bad = vm.queue.filter((r) => r.bad);
    once('warn', bad.map((b) => b.id).join('|'), () => {
      warnPanel.classList.toggle('hidden', bad.length === 0);
      warnList.replaceChildren(...bad.map((b) => {
        const input = h('input', { type: 'text', placeholder: 'Link del brano sostitutivo', 'aria-label': `Sostituto per ${b.title}` });
        const msg = h('div', { class: 'msg' });
        const m = replMsg.get(b.id);
        if (m) { msg.textContent = m.text; msg.className = 'msg ' + (m.ok ? 'ok' : 'no'); }
        const go = h('button', { onClick: async () => {
          msg.textContent = 'Controllo…'; msg.className = 'msg';
          const r = await a.replace(b.id, input.value);
          replMsg.set(b.id, { ok: r.ok, text: r.message });
          msg.textContent = r.message; msg.className = 'msg ' + (r.ok ? 'ok' : 'no');
        } }, 'Verifica e sostituisci');
        return h('div', { class: 'fix' }, h('div', {}, b.title), h('div', { class: 'line' }, input, go), msg);
      }));
    });
  }

  function setDisplays(names: string[], selected?: string) {
    dispRow.classList.toggle('hidden', names.length === 0);
    dispSel.replaceChildren(...names.map((n) => h('option', { value: n, selected: n === selected }, n)));
    if (names.length && !selected) a.setDisplay(dispSel.value);
  }
  function setInputs(list: { id: string; label: string }[], selected?: string) {
    micSel.replaceChildren(h('option', { value: '' }, 'Predefinito'), ...list.map((d) => h('option', { value: d.id, selected: d.id === selected }, d.label)));
  }
  function setRefreshInfo(text: string) { refreshInfo.textContent = text; }
  function setAutoRefreshValue(min: number) { refreshSel.value = String(min); }
  function setSensitivity(v: number) { sens.value = String(v); }

  function setSource(name: string) { pill.textContent = `Sorgente: ${name}`; pill.className = 'pill ' + (name.startsWith('Spotify') ? 'sp' : 'yt'); }

  function setStatus(msg: string, error = false) {
    status.textContent = msg;
    status.className = 'status' + (error ? ' error' : '');
    statusListeners.forEach((fn) => fn(msg, error));
  }

  return { openWizard, openTutorial, setSource, mounts: [dA.mount, dB.mount] as [HTMLElement, HTMLElement], update, setStatus, setRefreshInfo, setAutoRefreshValue, setDisplays, setInputs, setSensitivity, setPlaylistSlots, setProjectorMode, setProjectorInfo, linkInput: link, loadBtn };
}
