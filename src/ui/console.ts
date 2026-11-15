import type { AutomixState } from '../automix';
import type { Profile } from '../crossfade';
import { isAndroidApp } from '../androidBridge';
import { isIOSApp } from '../platform';
import { fmtTime, h, paintWords } from './dom';
import { showAppPicker, showFeedback, showInfo, startTour, startWizard, TourStep } from './guide';
import { UNAVAILABLE_WITH_YOUTUBE } from './unavailable';
import { APP_VERSION, AUTHOR, PAYPAL_QR } from '../info';
import { buildQueueList, QueueRowVM } from './queueList';
import type { SheetItem as MenuItem } from './material';
import { applyPhoneTheme, applySystemInsets, buildShell, icon, materialUI, setLabel, SheetItem, withIcon } from './material';

export type Actions = {
  loadPlaylist(text: string): void;
  /** Switches to another playlist (by its id): opens its saved copy, or puts its link in the box and loads it. */
  selectPlaylist(id: string): void;
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
  setDisplay(key: string, label?: string): void;
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
  /** Computer only: ♥ on a song of the queue. */
  toggleFavorite?(videoId: string): void;
  /** Computer only: ⬇ on a song of the queue (Download Manager, or the user's own audio file). */
  makeOffline?(videoId: string): void;
  /** Computer only: ⏮ the song before the one on air. */
  prev?(): void;
  /** Computer only: «Aggiungi a playlist» on a song of the queue. */
  addToPlaylist?(videoId: string): void;
};

/** The computer's pages (built by the app with the shell's menu and navigation). */
export type DesktopPages = {
  pages: { playlists: HTMLElement; search: HTMLElement; library: HTMLElement; downloads?: HTMLElement };
  settingsCard: HTMLElement;
  update(page: string): void;
  activeDownloads(): number;
};
export type DesktopParts = { menu(title: string, subtitle: string, items: MenuItem[]): void; go(page: string): void };

export type DeckVM = { title: string; artist: string; source?: string; thumb?: string; elapsed: number; duration: number; role: 'live' | 'out' | 'ready' | 'loading' | 'idle'; volume: number; duck: boolean; autoDuck?: boolean };
export type { QueueRowVM };
/** A playlist in the phone's menu. */
export type PlaylistItemVM = { id: string; name: string; count: number; link: string };
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
  /** Cheap signature of the queue: when it is the same, the 10 000 rows are not compared one by one. */
  queueSig?: string;
  /** Which playlist the queue is (each keeps its own scroll position). */
  queueKey?: string;
  /** «In riproduzione da: Party · 3 / 124». */
  playing?: { from: string; pos: number; total: number };
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

/** `hasMusic`: a playlist is saved for the slot in use, so the phone opens on «In onda» instead of «Playlist». */
export function buildConsole(root: HTMLElement, a: Actions, opts: { hasMusic?: boolean; desktop?: (parts: DesktopParts) => DesktopPages } = {}) {
  /** Phone layout (Material Design 3) on Android; the classic console on a computer. */
  const md = materialUI();
  const label = (el: HTMLElement, t: string) => (md ? setLabel(el, t) : el.textContent !== t && (el.textContent = t));
  let shell: ReturnType<typeof buildShell> | undefined;
  const pill = h('span', { class: 'pill empty', title: 'Incolla qui sotto il link di una playlist Spotify o YouTube' }, md ? 'Nessuna playlist' : EMPTY_SOURCE);
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
    const source = h('div', { class: 'deck-src' });
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
      h('div', { class: 'meta' }, cover, h('div', { style: 'min-width:0' }, title, artist, source)),
      h('div', { class: 'times' }, el, rem),
      seek,
      h('div', { class: 'row' }, h('label', {}, 'Volume deck'), vol),
      h('div', { class: 'row' }, duck),
    );
    return { mount, card, role, cover, title, artist, source, el, rem, seek, isSeeking, vol, duck };
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
  const store: Storage | undefined = (() => { try { return window.localStorage; } catch { return undefined; } })();
  /** Computer: a circular virtual list (fluid with thousands of songs). Phone: the plain list, as before. */
  const repeatNote = () => ({ off: 'Ripeti: no — dopo l’ultimo brano la musica si ferma.', all: 'Ripeti tutta la playlist: dopo l’ultimo brano riparte il primo.', one: 'Ripeti questo brano.' }[lastVm?.repeat ?? 'off']);
  const ql = md ? undefined : buildQueueList({ ...a, songMenu: (r, i) => queueMenu(r, i) }, store, repeatNote);
  const queueList = ql ? ql.el : h('div', { class: 'list' });
  const toCurrent = ql ? h('button', { class: 'tocur', title: 'Porta in vista il brano in onda', onClick: () => ql.showCurrent() }, '◎ Brano in onda') : null;
  window.addEventListener('pagehide', () => ql?.remember());
  const addLink = h('input', { type: 'text', placeholder: 'Aggiungi un video (link)', 'aria-label': 'Aggiungi un video alla coda' });
  const addMsg = h('div', { class: 'status' });
  const addBtn = h('button', { onClick: async () => { addMsg.textContent = await a.addVideo(addLink.value); } }, 'Aggiungi');
  const queuePanel = md
    ? h('section', { class: 'panel' },
      h('h3', {}, 'Coda'),
      h('div', { class: 'opts' }, shuffleBtn, shuffleNow, repeatBtn, toCurrent),
      h('div', { class: 'row' }, refreshBtn, refreshSel), refreshInfo,
      queueList,
      h('div', { class: 'row' }, addLink, addBtn), addMsg)
    // computer: the play queue only; refreshing and adding songs live in the Playlist and Cerca pages
    : h('section', { class: 'panel queue-panel' },
      h('div', { class: 'qp-head' }, h('h2', { class: 'qp-title' }, 'Lista di riproduzione'), h('div', { class: 'opts' }, shuffleBtn, shuffleNow, repeatBtn, toCurrent)),
      queueList);

  const warnList = h('div');
  const warnPanel = h('section', { class: 'panel warn hidden' }, h('h3', {}, 'Brani non riproducibili'),
    h('div', { class: 'artist', style: 'margin-bottom:8px' }, 'Incolla il link di un brano sostitutivo: ti dico subito se va bene.'), warnList);
  const histList = h('div', { class: 'list' });
  const problems = h('ul', { class: 'problems' });
  const unav = h('details', {}, h('summary', {}, 'Non disponibile con YouTube'),
    h('ul', {}, ...UNAVAILABLE_WITH_YOUTUBE.map((u) => h('li', {}, u.name, h('span', {}, u.why)))));
  const dispSel = h('select', { 'aria-label': 'Schermo del proiettore', onChange: () => a.setDisplay(dispSel.value, dispSel.selectedOptions[0]?.textContent ?? undefined) });
  const dispRow = h('div', { class: 'row hidden' }, h('label', {}, 'Schermo'), dispSel);
  const micSel = h('select', { 'aria-label': 'Microfono per le forme del proiettore', onChange: () => a.setMic(micSel.value) }, h('option', { value: '' }, 'Microfono del computer (predefinito)'));
  const micBtn = h('button', { onClick: async () => { setInputs(await a.refreshInputs(), micSel.value); } }, '🔄 Cerca microfoni');
  const sens = h('input', { type: 'range', min: '0.2', max: '4', step: '0.1', 'aria-label': 'Sensibilità del microfono', onInput: () => a.setMicSensitivity(+sens.value) });
  const projMsg = h('div', { class: 'status' });
  const projModeBtns = ([['karaoke', 'Karaoke'], ['video', 'Video YouTube']] as const).map(([m, label]) =>
    h('button', { 'aria-pressed': 'false', 'data-mode': m, onClick: () => a.setProjectorMode(m) }, label));
  const projModeHint = h('div', { class: 'artist wrap' });
  function setProjectorMode(m: 'karaoke' | 'video') {
    projModeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    projModeHint.textContent = m === 'video'
      ? 'Il proiettore mostra a tutto schermo il video del brano in onda (es. Just Dance). Audio e video arrivano entrambi da YouTube (serve internet), anche per i brani che hai scaricato: passando a Video YouTube il brano continua dallo stesso punto. Quando YouTube mostra una pubblicità o il video non è ancora allineato, al suo posto restano le forme.'
      : 'Le forme seguono il suono della stanza tramite il 🎤 microfono, con il testo del brano. I brani che hai sul computer suonano dal tuo file, gli altri da YouTube. Passando a Karaoke il brano in onda riparte dall’inizio, così parole e musica partono insieme. Non viene registrato nulla.';
  }
  const openProj = async () => { projMsg.textContent = ''; try { await a.openProjector(); } catch (e) { projMsg.textContent = `Non riesco ad aprire il proiettore: ${(e as Error)?.message ?? String(e)}`; } };
  const projOpen = h('button', { class: md ? 'm-filled' : '', onClick: openProj }, isIOSApp() ? 'Mostra il proiettore' : md ? 'Trasmetti alla TV' : 'Apri proiettore');
  const projClose = h('button', { class: md ? 'm-outlined' : '', onClick: () => a.closeProjector() }, md ? 'Interrompi' : 'Chiudi proiettore');
  const projPanel = h('section', { class: 'panel' }, h('h3', {}, 'Proiettore'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Cosa mostrare sul proiettore' }, ...projModeBtns), projModeHint,
    h('div', { class: 'btns' }, projOpen, projClose),
    dispRow,
    h('div', { class: 'np-label' }, '🎤 Microfono'),
    h('div', { class: 'artist wrap' }, 'Serve solo con «Karaoke»: le forme colorate si muovono con il suono della stanza. Scegli il microfono del computer o uno collegato (USB, cuffie, scheda audio). Ascolta soltanto: non registra nulla.'),
    h('div', { class: 'row' }, h('label', {}, 'Microfono'), micSel), h('div', { class: 'row' }, micBtn),
    h('div', { class: 'row' }, h('label', {}, 'Sensibilità del microfono'), sens), projMsg);
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
    h('div', { class: 'artist wrap' }, 'In sottofondo cerco i testi di tutti i brani, così sono pronti quando partono. «a tempo» = tempi esatti; «stimato» = testo trovato ma tempi calcolati: regolali con i due tasti ① ② ' + (md ? 'in «Proiettore › Testo da cantare».' : 'della barra in basso.')),
    kBar, kText, h('div', { class: 'row' }, kRetry), h('label', { class: 'row' }, kAuto, 'Cerca i testi in automatico'));
  const adOn = h('input', { type: 'checkbox', 'aria-label': 'Abbassa il volume durante le pubblicità', onChange: () => a.setAdGuard(adOn.checked) });
  const adMeter = h('div', { class: 'kbar' }, h('i'));
  const adText = h('div', { class: 'status' });
  const adSens = h('select', { 'aria-label': 'Sensibilità del rilevamento', onChange: () => a.setAdThreshold(+adSens.value) },
    h('option', { value: '3' }, 'Alta (scatta prima)'), h('option', { value: '4' }, 'Normale'), h('option', { value: '5' }, 'Prudente (scatta meno)'));
  const adSpot = h('select', { 'aria-label': 'Brani brevi (spot)', onChange: () => a.setSpotMode(adSpot.value as 'off' | 'duck' | 'skip') },
    h('option', { value: 'off' }, 'Non fare niente'), h('option', { value: 'duck' }, 'Abbassa il volume'), h('option', { value: 'skip' }, 'Salta al brano dopo'));
  const adLog = h('div', { class: 'adlog' });
  // the listening part needs the computer's sound: on the phone only the short-track rule is shown
  const adListen = h('div', { class: 'adlisten' },
    h('div', { class: 'artist wrap' }, 'Ascolto l’audio che sta suonando sul computer (non il microfono) e, se sembra una voce che parla come in uno spot e non una canzone, abbasso il volume da solo; quando torna la musica lo rialzo. L’audio non viene registrato né salvato.'),
    h('label', { class: 'row' }, adOn, 'Abbassa il volume durante le pubblicità'), adMeter, adText, adLog,
    h('div', { class: 'row' }, h('label', {}, 'Sensibilità'), adSens));
  const adPanel = h('section', { class: 'panel' }, h('h3', {}, 'Pubblicità'), adListen,
    h('div', { class: 'artist wrap' }, 'Gli spot nelle playlist sono clip brevi, le canzoni durano minuti: un brano sotto i 75 secondi lo considero uno spot. Funziona anche senza ascoltare l’audio e anche quando sotto la voce c’è solo musica.'),
    h('div', { class: 'row' }, h('label', {}, 'Brani brevi (spot)'), adSpot));
  const side = h('div', { class: 'side' }, warnPanel, projPanel, adPanel, karaokePanel, lyricsPanel,
    histPanel, probPanel,
    h('section', { class: 'panel' }, unav));

  // Phone: no copy and paste. Pick the playlist in the YouTube or Spotify app, «Condividi → PartyMix», it loads by itself.
  const appsBtn = isAndroidApp() ? h('button', { class: 'primary apps-btn', onClick: () => showAppPicker((m) => setStatus(m, true)) }, '📱 Scegli dalle app') : null;
  const slotSel = h('select', { class: 'slotsel', 'aria-label': 'Playlist in uso', title: 'Scegli la playlist da suonare', onChange: () => a.selectPlaylist(slotSel.value) });
  const nameInput = h('input', { type: 'text', class: 'plname', maxlength: '60', placeholder: 'Nome della playlist', 'aria-label': 'Nome della playlist in uso',
    onChange: () => a.renamePlaylist(nameInput.value) });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
  const savedInfo = h('span', { class: 'artist saved' });
  // Phone, step 2: once a playlist is ready, the way to the music is the most visible button on the page.
  const goNow = h('button', { class: 'm-filled m-gonow hidden', onClick: () => { shell?.go('now'); if (lastVm?.ready && lastVm.state === 'idle') a.start(); } }, 'Vai a In onda e avvia la musica');
  // Phone, step 1: «In onda» with nothing to play says where to start.
  const emptyNow = h('section', { class: 'panel m-empty hidden' },
    h('div', { class: 'm-steps' }, h('span', { class: 'm-step on' }, '1'), h('span', { class: 'm-step-line' }), h('span', { class: 'm-step' }, '2')),
    h('h3', {}, 'Prima scegli la musica'),
    h('p', { class: 'artist' }, 'Vai su «Playlist», scegli una delle tue playlist o incolla un link di YouTube o Spotify. Poi torna qui e premi «Avvia automix».'),
    h('button', { class: 'm-filled', onClick: () => shell?.go('list') }, 'Scegli la playlist'));
  const loadRow = md
    ? h('div', { class: 'load m-card' },
      h('label', { class: 'm-field' }, h('span', { class: 'm-field-label' }, 'Playlist in uso'), slotSel),
      h('label', { class: 'm-field' }, h('span', { class: 'm-field-label' }, 'Nome'), nameInput),
      savedInfo,
      h('label', { class: 'm-field' }, h('span', { class: 'm-field-label' }, 'Link YouTube o Spotify'), link),
      h('div', { class: 'm-btnrow' }, loadBtn, appsBtn),
      goNow)
    : h('div', { class: 'load' }, opts.desktop ? null : slotSel, nameInput, savedInfo, link, loadBtn, appsBtn);
  /** A line about the projector that the app keeps up to date (Android: the cast screen). */
  function setProjectorInfo(text: string) { if (projMsg.textContent !== text) projMsg.textContent = text; }
  const where = isIOSApp() ? `sull’${/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone'}` : md ? 'sul telefono' : 'sul PC';
  /** Fills the playlist menu (phone) and the line under the name: each playlist by name with how many songs it has. */
  function setPlaylists(list: PlaylistItemVM[], currentId: string | undefined) {
    const opts = list.map((p, i) => h('option', { value: p.id, selected: p.id === currentId }, `${i + 1} · ${p.name} — ${p.count ? `${p.count} ${p.count === 1 ? 'brano' : 'brani'}` : p.link ? 'da caricare' : 'vuota'}`));
    const sig = opts.map((o) => o.textContent).join('|') + '#' + currentId;
    if (slotSel.dataset.sig !== sig) { slotSel.replaceChildren(...opts); slotSel.dataset.sig = sig; }
    if (currentId) slotSel.value = currentId;
    const cur = list.find((p) => p.id === currentId);
    slotSel.title = cur?.link ? `${cur.name}: ${cur.link}` : 'Questa playlist è vuota: incolla un link e premi «Carica playlist».';
    if (document.activeElement !== nameInput) nameInput.value = cur?.name ?? '';
    nameInput.placeholder = 'Nome della playlist';
    savedInfo.textContent = cur?.count ? `💾 ${cur.count} ${cur.count === 1 ? 'brano salvato' : 'brani salvati'} ${where}` : '';
  }
  /** Computer: the tour of the pages (each step opens its page). Set when the computer layout is built. */
  let deskTour: (() => TourStep[]) | undefined;
  /** Computer: «Proiettore e testo» in a side sheet over the Player (set when the computer layout is built). */
  let projSheet: { open(): void; close(): void; toggle(): void } | undefined;
  const openTutorial = () => void (md ? startTour(mdTourSteps(), (el) => shell?.reveal(el)) : deskTour ? startTour(deskTour(), (el) => { if (el.closest('.side-sheet')) projSheet?.open(); else { projSheet?.close(); shell?.reveal(el); } }) : startTour(tourSteps()));
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
    { target: () => topTools, title: 'Aiuto e informazioni', text: `Da qui puoi rifare la configurazione guidata, rivedere questo tutorial e aprire le informazioni${isIOSApp() ? '' : ', dove trovi anche la donazione facoltativa per chi ha creato l’app'}. Con «💬 Commenti» mi scrivi cosa ne pensi e cosa aggiungere. Buona festa!` },
  ];
  const topTools = h('div', { class: 'top-tools' },
    h('button', { onClick: openWizard }, 'Configurazione guidata'),
    h('button', { onClick: openTutorial }, 'Tutorial'),
    h('button', { onClick: openInfo }, 'Info'),
    h('button', { title: 'Scrivimi cosa ne pensi e cosa vorresti trovare in PartyMix', onClick: () => showFeedback() }, '💬 Commenti'));
  const castTop = h('button', { class: 'm-icon-btn', 'aria-label': isIOSApp() ? 'Mostra il proiettore' : 'Trasmetti il proiettore alla TV', title: isIOSApp() ? 'Mostra il proiettore' : 'Trasmetti il proiettore alla TV', onClick: () => { if (projSheet) projSheet.open(); else { shell?.go('proj'); void openProj(); } } });
  const helpItem = (ic: Parameters<typeof withIcon>[1], text: string, sub: string, run: () => void) =>
    h('button', { class: 'm-list-item', type: 'button', onClick: run }, withIcon(h('span', { class: 'm-lead' }), ic, true), h('span', { class: 'm-text' }, h('span', { class: 't' }, text), h('span', { class: 'm-sub' }, sub)));
  const helpPanel = h('section', { class: 'panel' }, h('h3', {}, 'Aiuto'),
    helpItem('school', 'Configurazione guidata', 'Playlist, proiettore e primo avvio, passo per passo', openWizard),
    helpItem('help', 'Tutorial', 'Cosa fa ogni parte dell’app', openTutorial),
    helpItem('feedback', 'Commenti e suggerimenti', 'Scrivimi cosa ne pensi e cosa aggiungere', () => showFeedback()),
    helpItem('info', 'Informazioni', isIOSApp() ? 'Versione e autore' : 'Versione, autore e donazione facoltativa', openInfo));
  /** Phone: the parts of the console grouped in four destinations, each one a screen. */
  const mdTourSteps = (): TourStep[] => [
    { target: () => root.querySelector('.m-nav'), title: 'Prima la playlist, poi In onda', text: 'In basso le sezioni sono in ordine: 1) «Playlist» per scegliere la musica, 2) «In onda» per farla partire, poi «Proiettore» per la TV e il testo e «Altro» per le impostazioni e l’aiuto. Un pallino colorato ti dice dove andare. Il tasto Indietro torna a «In onda».' },
    { target: () => loadRow, title: 'Le tue playlist', text: 'Puoi tenere quattro playlist: scegline una dal menu, dalle un nome e incolla il link di YouTube o Spotify. Ancora più comodo: «Scegli dalle app», apri la playlist in YouTube o Spotify e tocca Condividi › PartyMix. La lista resta salvata sul telefono.' },
    { target: () => queuePanel, title: 'La coda', text: 'Tocca un brano per suonarlo subito, farlo partire dopo quello in onda, spostarlo, bloccarlo o toglierlo dalla playlist.' },
    { target: () => (dA.card.classList.contains('is-live') ? dA.card : dB.card), title: 'In onda', text: 'Il brano che si sente, con il video e il tempo che manca. Trascina la barra per spostarti nel brano.' },
    { target: () => bigBtn, title: 'Avvia automix', text: 'Il tasto principale: parte il primo brano e da lì l’app mixa da sola, un brano dopo l’altro, con una sfumatura.' },
    { target: () => nextBtn.parentElement as HTMLElement, title: 'Pausa, mix, prossimo', text: '«Pausa» ferma tutto, «Mix ora» sfuma subito nel brano pronto, «Prossimo» salta al successivo.' },
    { target: () => seg.parentElement as HTMLElement, title: 'Stile delle transizioni', text: 'Morbida (circa 12 secondi), Standard (8), Energica (4) oppure Manuale, dove il cambio avviene solo quando lo decidi tu.' },
    { target: () => projPanel, title: 'Il proiettore sulla TV', text: isIOSApp()
      ? 'Dal Centro di Controllo scegli «Duplica schermo» e la tua Apple TV o TV AirPlay, poi tocca «Mostra il proiettore»: le forme col testo (Karaoke) o il video del brano (Video YouTube) riempiono lo schermo e arrivano alla TV. «Torna alla console» in alto lo chiude.'
      : '«Trasmetti alla TV» apre le impostazioni di Android «Trasmetti» o «Schermo wireless»: scegli la TV o il proiettore e lì compare il proiettore di PartyMix, mentre il telefono resta la console. Puoi mostrare le forme col testo (Karaoke) o il video del brano (Video YouTube).' },
    { target: () => syncBar, title: 'Testo a tempo', text: 'La riga che si sta cantando. Se il testo non è a tempo con il video usa ① e ② quando il cantante inizia la prima e l’ultima riga, oppure Anticipa e Ritarda.' },
    { target: () => helpPanel, title: 'Aiuto e commenti', text: 'Da qui rifai la configurazione guidata, rivedi questo tutorial e mi scrivi cosa ne pensi. Buona festa!' },
  ];
  let desk: DesktopPages | undefined;
  /** Computer: one ⏯ that starts the automix, then pauses and resumes it; «Ferma» stops it. */
  const playMain = h('button', { type: 'button', onClick: () => (lastVm?.state === 'idle' ? a.start() : a.togglePause()) });
  const stopBtn = h('button', { type: 'button', title: 'Ferma l’automix e riporta la lista all’inizio', onClick: () => a.stop() }, 'Ferma');
  let emptyNowRef: HTMLElement | undefined;
  const prevBtn = h('button', { class: 'icon-btn', onClick: () => a.prev?.() }, '⏮');
  /** «In riproduzione da: 🎵 Party · 3 / 124». */
  const nowFrom = h('div', { class: 'pg-sub now-from', 'aria-live': 'polite' });
  if (md) {
    applySystemInsets();
    applyPhoneTheme();
    withIcon(castTop, 'cast', true);
    withIcon(loadBtn, 'refresh'); loadBtn.classList.add('m-tonal');
    if (appsBtn) { appsBtn.textContent = 'Scegli dalle app'; withIcon(appsBtn, 'apps'); appsBtn.classList.add('m-filled'); }
    withIcon(nextBtn, 'next'); label(nextBtn, 'Prossimo');
    withIcon(mixBtn, 'mix'); label(mixBtn, 'Mix ora'); mixBtn.classList.remove('wide');
    withIcon(pauseBtn, 'pause');
    withIcon(shuffleBtn, 'shuffle'); withIcon(shuffleNow, 'shuffle'); withIcon(repeatBtn, 'repeat');
    withIcon(refreshBtn, 'refresh'); withIcon(addBtn, 'add');
    withIcon(projOpen, 'cast'); withIcon(projClose, 'stop');
    withIcon(goNow, 'play'); withIcon(emptyNow.querySelector('button')!, 'queue');
    withIcon(dA.duck, 'volumeDown'); withIcon(dB.duck, 'volumeDown');
    master.parentElement?.prepend(withIcon(h('span', { class: 'm-vol-ic' }), 'volume', true));
    nextBtn.parentElement?.append(nextBtn); // Pausa · Mix ora · Prossimo, like a player
    status.classList.add('hidden');
    projModeHint.after(lyShow.parentElement!, lyHl.parentElement!); // projector settings, also before any lyrics are found
    syncBar.prepend(h('h3', {}, 'Testo da cantare'));
    shell = buildShell(root, {
      title: h('div', { class: 'logo' }, 'Party', h('b', {}, 'Mix')),
      actions: [pill, castTop],
      home: 'now',
      start: opts.hasMusic ? 'now' : 'list',
      screens: [
        // the order of the steps: first the playlist, then the music
        { id: 'list', label: 'Playlist', icon: 'queue', body: [loadRow, warnPanel, queuePanel] },
        { id: 'now', label: 'In onda', icon: 'nowPlaying', body: [emptyNow, h('div', { class: 'm-now' }, dA.card, mixer, dB.card)] },
        { id: 'proj', label: 'Proiettore', icon: 'cast', body: [projPanel, syncBar, lyricsPanel] },
        { id: 'more', label: 'Altro', icon: 'tune', body: [karaokePanel, adPanel, helpPanel, histPanel, probPanel, h('section', { class: 'panel' }, unav)] },
      ],
    });
  } else {
    // ---------- computer: Material 3 with a navigation drawer, one page per job ----------
    document.body.classList.add('desk');
    // colours: the computer's accent colour and light/dark (followSystemTheme, started by the app)
    const parts: DesktopParts = { menu: (t, sub, items) => shell?.sheet(t, sub, items), go: (id) => shell?.go(id) };
    desk = opts.desktop?.(parts);
    const ph = (title: string, sub?: HTMLElement) => h('header', { class: 'pg-head' }, h('div', { class: 'pg-tt' }, h('h1', { class: 'pg-title' }, title), sub ?? null));
    withIcon(castTop, 'cast', true);
    // Player controls (Material 3): ⏮ and ⏭ tonal icon buttons, ⏯ big and filled in the middle (it also starts the automix),
    // then «Mix ora» and «Ferma»; volume across the whole width; the transition style under it.
    prevBtn.className = 'tp tp-side'; prevBtn.setAttribute('aria-label', 'Brano precedente'); prevBtn.title = 'Brano precedente'; withIcon(prevBtn, 'prev', true);
    nextBtn.className = 'tp tp-side'; nextBtn.setAttribute('aria-label', 'Brano successivo'); nextBtn.title = 'Brano successivo (con sfumatura)'; withIcon(nextBtn, 'next', true);
    playMain.className = 'tp tp-main'; withIcon(playMain, 'play', true);
    mixBtn.className = 'm-tonal np-btn'; mixBtn.title = 'Sfuma subito nel brano già pronto'; mixBtn.textContent = 'Mix ora'; withIcon(mixBtn, 'mix');
    stopBtn.className = 'm-outlined np-btn'; withIcon(stopBtn, 'stop');
    const xlabels = mixer.querySelector('.xlabels'), xfade = mixer.querySelector('.xfade');
    mixer.replaceChildren(
      h('div', { class: 'np-status' }, mixText),
      h('div', { class: 'np-xf' }, xlabels, xfade),
      h('div', { class: 'transport' }, prevBtn, playMain, nextBtn),
      h('div', { class: 'np-actions' }, mixBtn, stopBtn),
      h('label', { class: 'np-vol' }, withIcon(h('span', { class: 'np-vol-ic' }), 'volume', true), master),
      h('div', { class: 'np-trans' }, h('span', { class: 'np-label' }, 'Transizione'), seg));
    mixer.classList.add('np');
    const emptyNowDesk = h('section', { class: 'panel empty-state m-empty hidden' }, h('div', { class: 'es-ic', 'aria-hidden': 'true' }, '🎵'), h('div', { class: 'es-t' }, 'Nessuna musica in riproduzione'),
      h('p', { class: 'es-p' }, 'Scegli una playlist e premi ▶, oppure cerca un brano.'),
      h('div', { class: 'es-b' }, h('button', { class: 'm-filled', onClick: () => shell?.go('playlists') }, '📋 Scegli una playlist'), h('button', { class: 'm-tonal', onClick: () => shell?.go('search') }, '🔎 Cerca musica')));
    // credits and the optional PayPal donation, always in sight (a page of its own and a ♥ in the top bar)
    const aboutPage = h('div', { class: 'about-grid' },
      h('section', { class: 'panel about-card' },
        h('div', { class: 'about-logo' }, h('span', {}, 'Party'), h('b', {}, 'Mix')),
        APP_VERSION ? h('div', { class: 'pg-sub' }, `Versione ${APP_VERSION}`) : null,
        h('p', {}, 'Un DJ virtuale gratuito per feste e serate: playlist, mix automatico, testi da cantare e proiettore.'),
        h('div', { class: 'credit' }, h('div', { class: 'pg-sub' }, 'Creato da'), h('div', { class: 'credit-name' }, AUTHOR)),
        h('div', { class: 'about-btns' },
          h('button', { class: 'm-tonal', onClick: openTutorial }, 'Tutorial'),
          h('button', { class: 'm-tonal', onClick: openWizard }, 'Configurazione guidata'),
          h('button', { class: 'm-tonal', onClick: () => showFeedback() }, '💬 Commenti e suggerimenti')),
        h('p', { class: 'pg-hint' }, 'I brani sono riprodotti da YouTube; con Spotify l’app usa solo l’elenco dei brani. Spotify e YouTube sono marchi dei rispettivi proprietari, estranei a questo progetto.')),
      h('section', { class: 'panel donate-card' },
        h('h3', {}, '💜 Sostieni PartyMix'),
        h('p', {}, 'Se PartyMix ti è utile e ti va di ringraziare chi lo ha creato, puoi fare una piccola donazione con PayPal: è facoltativa e tutto funziona uguale anche senza.'),
        h('img', { class: 'paypal-qr', src: PAYPAL_QR, alt: `Codice QR PayPal di ${AUTHOR}`, width: '260', height: '260' }),
        h('div', { class: 'credit-name paypal-name' }, AUTHOR.toLowerCase()),
        h('p', { class: 'pg-hint' }, 'Per donare: apri l’app PayPal sul telefono, scegli «Scansiona» e inquadra questo codice.')));
    const heartTop = withIcon(h('button', { class: 'm-icon-btn heart-btn', title: 'Info e dona', 'aria-label': 'Info e dona', onClick: () => shell?.go('about') }), 'heart', true);
    // Aiuto first, in sight: four buttons in a row (the phone keeps its list)
    const helpBtn = (ic: Parameters<typeof withIcon>[1], text: string, run: () => void, cls = 'm-tonal') => withIcon(h('button', { class: cls, type: 'button', onClick: run }, text), ic);
    const helpDesk = h('section', { class: 'panel help-card' },
      h('div', { class: 'help-text' }, h('h3', {}, 'Aiuto'), h('p', { class: 'pg-hint' }, 'Hai un dubbio? Il tutorial mostra a cosa serve ogni parte; la configurazione guidata rifà i primi passi.')),
      h('div', { class: 'help-btns' },
        helpBtn('help', 'Tutorial', openTutorial, 'm-filled'),
        helpBtn('school', 'Configurazione guidata', openWizard),
        helpBtn('feedback', 'Commenti e suggerimenti', () => showFeedback()),
        helpBtn('heart', 'Info e dona', () => shell?.go('about'))));
    const refreshCard = h('section', { class: 'panel' }, h('h3', {}, 'Aggiornamento delle playlist YouTube'),
      h('p', { class: 'pg-hint' }, 'Ogni quanto PartyMix controlla se una playlist YouTube è cambiata (brani aggiunti o tolti).'),
      h('div', { class: 'row' }, refreshSel, refreshBtn), refreshInfo);
    deskTour = () => [
      { target: () => root.querySelector('.m-nav') as HTMLElement, title: 'Il menu', text: 'Da qui vai alle pagine: ▶ Player (quello che suona), 📋 Playlist, 🔎 Cerca, ⬇ Download, 🎧 Libreria. In fondo 📺 Proiettore, ⚙ Impostazioni e 💜 Info e dona.' },
      { target: () => playMain, title: 'Avvia, pausa, riprendi', text: 'Il tasto grande avvia l’automix: parte il primo brano e la musica va avanti da sola, con le sfumature. Poi mette in pausa e riprende. ⏮ e ⏭ passano al brano prima o dopo.' },
      { target: () => mixBtn.parentElement as HTMLElement, title: 'Mix ora e Ferma', text: '«Mix ora» sfuma subito nel brano già pronto; «Ferma» ferma tutto e riporta la lista all’inizio.' },
      { target: () => seg.parentElement as HTMLElement, title: 'Stile delle transizioni', text: 'Morbida (circa 12 secondi), Standard (8), Energica (4) o Manuale (il cambio solo quando lo chiedi tu).' },
      { target: () => queuePanel, title: 'La lista di riproduzione', text: 'I brani in ordine, con un inizio e una fine ben visibili. ▶ o doppio clic suona un brano; ⋮ (o clic destro) apre le altre azioni; trascina ⋮⋮ per cambiare ordine. «Ripeti» decide cosa succede dopo l’ultimo brano.' },
      ...(desk ? [
        { target: () => desk!.pages.playlists, title: 'Le tue playlist', text: 'Tutte le playlist che vuoi. Aprine una per vederne i brani, caricarla da YouTube o Spotify, scaricarla tutta (⬇) o scegliere i brani con ☑ Seleziona.' },
        { target: () => desk!.pages.search, title: 'Cerca', text: 'Cerca su YouTube o nella tua musica: i risultati compaiono subito sotto il campo, con ▶ e ⋮ per metterli in coda o in una playlist.' },
        ...(desk.pages.downloads ? [{ target: () => desk!.pages.downloads!, title: 'Download', text: 'Incolla un indirizzo e scegli MP3 o MP4: i download vanno in coda, ne partono due alla volta, e alla fine il brano è nella Libreria.' }] : []),
        { target: () => desk!.pages.library, title: 'La tua libreria', text: 'La musica sul computer: importa i tuoi MP3 (anche cartelle intere) e ritrova quello che hai scaricato. Suona anche senza internet.' },
      ] : []),
      { target: () => projPanel, title: 'Il proiettore', text: 'Apre una seconda finestra sullo schermo che scegli (TV, proiettore): forme a tempo con il testo da cantare, oppure il video del brano.' },
      { target: () => helpDesk, title: 'Aiuto', text: 'Qui ritrovi questo tutorial, la configurazione guidata e i commenti. Buona festa!' },
    ];
    const settingsGrid = h('div', { class: 'settings-page' }, helpDesk,
      h('div', { class: 'settings-grid' }, refreshCard, desk?.settingsCard ?? null, karaokePanel, adPanel, histPanel, probPanel, h('section', { class: 'panel' }, h('h3', {}, 'Limiti di YouTube'), unav)));
    shell = buildShell(root, {
      title: h('div', { class: 'logo' }, 'Party', h('b', {}, 'Mix')),
      actions: [pill, heartTop, castTop],
      home: 'now',
      start: 'now',
      screens: [
        { id: 'now', label: 'Player', icon: 'nowPlaying', body: [ph('Player', nowFrom), emptyNowDesk, h('div', { class: 'player-grid' }, h('div', { class: 'player-col' }, dA.card, mixer, dB.card), queuePanel)] },
        { id: 'playlists', label: 'Playlist', icon: 'queue', body: [desk?.pages.playlists ?? null, warnPanel] },
        { id: 'search', label: 'Cerca', icon: 'search', body: [desk?.pages.search ?? null] },
        ...(desk?.pages.downloads ? [{ id: 'downloads', label: 'Download', icon: 'download' as const, body: [desk.pages.downloads] }] : []),
        { id: 'library', label: 'Libreria', icon: 'library', body: [desk?.pages.library ?? null] },
        { id: 'settings', label: 'Impostazioni', icon: 'settings', secondary: true, body: [ph('Impostazioni'), settingsGrid] },
        { id: 'about', label: 'Info e dona', icon: 'heart', secondary: true, body: [ph('Info e dona'), aboutPage] },
      ],
    });
    emptyNowRef = emptyNowDesk;

    // «Proiettore e testo»: a Material side sheet from the right, over the Player (the music stays in sight and in hand).
    // Wide screens: the page makes room for it; narrower ones: it lies over the right part. ✕ or Esc closes it.
    const ssClose = withIcon(h('button', { class: 'm-icon-btn', 'aria-label': 'Chiudi', title: 'Chiudi (Esc)' }), 'close', true);
    const sheetEl = h('aside', { class: 'side-sheet', role: 'complementary', 'aria-label': 'Proiettore e testo', inert: true },
      h('div', { class: 'ss-head' }, h('h2', {}, 'Proiettore e testo'), ssClose),
      h('div', { class: 'ss-body' }, projPanel, syncBar, lyricsPanel));
    document.body.append(sheetEl);
    projOpen.className = 'm-filled'; withIcon(projOpen, 'cast'); projClose.className = 'm-outlined'; withIcon(projClose, 'stop');
    const projNav = h('button', { class: 'm-nav-item sec', type: 'button', title: 'Proiettore e testo', 'aria-expanded': 'false' },
      h('span', { class: 'm-ind' }, icon('cast')), h('span', { class: 'm-nav-label' }, 'Proiettore'));
    const navEl = root.querySelector('.m-nav')!;
    navEl.insertBefore(projNav, navEl.querySelector('.m-nav-item.sec'));
    const setOpen = (on: boolean) => {
      sheetEl.classList.toggle('open', on);
      sheetEl.toggleAttribute('inert', !on);
      document.body.classList.toggle('ss-open', on);
      projNav.classList.toggle('on', on);
      projNav.setAttribute('aria-expanded', String(on));
      if (on && shell?.current() !== 'now') shell?.go('now');
    };
    projSheet = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!sheetEl.classList.contains('open')) };
    projNav.addEventListener('click', () => projSheet!.toggle());
    ssClose.addEventListener('click', () => projSheet!.close());
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetEl.classList.contains('open') && !document.querySelector('.m-sheet.on, .modal, .tour-card')) projSheet!.close(); });
    // the Player's own nav item does not look «current» while the sheet is the thing in front
    shell.onScreen((id) => { if (id !== 'now') setOpen(false); });
  }

  /** ⋮ on a song of the play queue (computer): the actions that make sense for it, in its state. */
  function queueMenu(r: QueueRowVM, i: number) {
    const rows = lastVm?.queue ?? [];
    const cur = rows.findIndex((x) => x.current);
    const after = cur < 0 ? 0 : i > cur ? cur + 1 : cur;
    const items: MenuItem[] = [
      { label: 'Suona adesso', icon: 'play', disabled: !!r.bad || !!r.current || !!r.skip, run: () => a.playNow(r.id) },
      { label: 'Suona dopo quello in onda', icon: 'playNext', disabled: !!r.current || i === after, run: () => a.move(i, after) },
      { label: 'Sposta su', icon: 'up', disabled: i === 0, run: () => a.move(i, i - 1) },
      { label: 'Sposta giù', icon: 'down', disabled: i === rows.length - 1, run: () => a.move(i, i + 1) },
      { label: 'Aggiungi a playlist…', icon: 'add', run: () => a.addToPlaylist?.(r.id) },
      { label: r.off === 'offline' ? 'Già disponibile offline' : 'Scarica / rendi offline', icon: 'download', disabled: r.off === 'offline' || r.off === 'downloading', run: () => a.makeOffline?.(r.id) },
      { label: r.fav ? 'Togli dai preferiti' : 'Aggiungi ai preferiti', icon: 'lock', run: () => a.toggleFavorite?.(r.id) },
      { label: r.locked ? 'Sblocca (si può saltare)' : 'Blocca (non si salta)', icon: 'lock', run: () => a.toggleLock(r.id) },
      { label: r.current ? 'In onda: non si può togliere' : 'Togli dalla lista e dalla playlist', icon: 'del', danger: true, disabled: r.current, run: () => a.removeTrack(r.id) },
    ];
    shell?.sheet(r.title, [r.artist, r.current ? (r.paused ? 'in pausa' : 'in riproduzione') : `${i + 1} di ${rows.length}`].filter(Boolean).join(' · '), items);
  }

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
  /** Phone: a song is one two-line row; tapping it opens a sheet with what can be done with it. */
  const tagsOf = (r: QueueRowVM) => [r.locked ? 'bloccato' : '', r.bad ? 'non riproducibile' : '', r.lyr === 'synced' ? 'testo a tempo' : r.lyr === 'plain' ? 'testo stimato' : r.lyr === 'none' ? 'senza testo' : ''].filter(Boolean);
  function songSheet(r: QueueRowVM, i: number, rows: QueueRowVM[]) {
    const cur = rows.findIndex((x) => x.current);
    const after = cur < 0 ? 0 : i > cur ? cur + 1 : cur;
    const items: SheetItem[] = [
      { label: 'Suona adesso', icon: 'play', disabled: r.bad || r.current, run: () => a.playNow(r.id) },
      { label: 'Suona dopo quello in onda', icon: 'playNext', disabled: r.current || i === after, run: () => a.move(i, after) },
      { label: 'Sposta su', icon: 'up', disabled: i === 0, run: () => a.move(i, i - 1) },
      { label: 'Sposta giù', icon: 'down', disabled: i === rows.length - 1, run: () => a.move(i, i + 1) },
      { label: r.locked ? 'Sblocca (si può saltare)' : 'Blocca (non si salta)', icon: 'lock', run: () => a.toggleLock(r.id) },
      { label: r.current ? 'In onda: non si può togliere' : 'Togli dalla playlist', icon: 'del', danger: true, disabled: r.current, run: () => a.removeTrack(r.id) },
    ];
    shell?.sheet(r.title, [r.artist, ...tagsOf(r)].filter(Boolean).join(' · '), items);
  }
  const mdRow = (r: QueueRowVM, i: number, rows: QueueRowVM[]) => h('div', {
    class: 'item m-item' + (r.current ? ' cur' : '') + (r.bad ? ' bad' : ''), role: 'button', tabindex: '0',
    'aria-label': `${i + 1}. ${r.title}${r.artist ? `, ${r.artist}` : ''}${r.current ? ', in onda' : ''}. Tocca per le azioni`,
    onClick: () => songSheet(r, i, rows),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); songSheet(r, i, rows); } },
  },
    h('span', { class: 'm-lead' }, r.current ? withIcon(h('span'), 'nowPlaying', true) : String(i + 1)),
    h('span', { class: 'm-text' }, h('span', { class: 't' }, r.title), h('span', { class: 'm-sub' }, [r.current ? 'In onda' : '', r.artist, ...tagsOf(r)].filter(Boolean).join(' · '))),
    withIcon(h('span', { class: 'm-trail', 'aria-hidden': 'true' }), 'more', true));
  const clearOver = () => queueList.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
  const memo = new Map<string, string>();
  const replMsg = new Map<string, { ok: boolean; text: string }>();
  const once = (key: string, sig: string, fn: () => void) => { if (memo.get(key) !== sig) { memo.set(key, sig); fn(); } };

  const paintDeck = (d: ReturnType<typeof mkDeck>, v: DeckVM) => {
    d.role.textContent = ROLE_LABEL[v.role];
    d.role.className = 'role' + (v.role === 'live' || v.role === 'out' ? ' live' : '');
    // phone: the deck being heard is the big card on top, the other one a small «Poi» card below the controls
    const big = v.role === 'live' || (v.role === 'idle' && d === (lastVm?.active === 1 ? dB : dA));
    d.card.classList.toggle('is-live', big);
    d.title.textContent = v.title || (md ? (v.role === 'idle' ? 'Nessun brano in onda' : '…') : '—');
    d.artist.textContent = v.artist || '';
    d.source.textContent = v.role === 'idle' || !document.body.classList.contains('desk') ? '' : v.source ?? ''; // computer only: the phone stays as it is
    d.source.title = d.source.textContent;
    d.cover.style.backgroundImage = v.thumb ? `url("${v.thumb.replace(/"/g, '')}")` : '';
    d.cover.classList.toggle('none', !v.thumb);
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
    label(d.duck, v.duck ? 'Volume abbassato: ripristina' : v.autoDuck ? 'Pubblicità: volume abbassato (auto)' : 'Abbassa volume');
  };

  function update(vm: ViewModel) {
    lastVm = vm;
    if (!md) {
      const p = vm.playing;
      nowFrom.textContent = p && p.total ? `In riproduzione da: 🎵 ${p.from} · ${p.pos > 0 ? p.pos : '–'} / ${p.total}` : 'Nessuna playlist in riproduzione';
      ql?.setHead(p?.from ? `IN RIPRODUZIONE: ${p.from}` : 'LISTA DI RIPRODUZIONE', `${p?.total ?? vm.queue.length} brani`);
      ql?.refreshEnds();
      emptyNowRef?.classList.toggle('hidden', vm.queue.length > 0);
      prevBtn.disabled = vm.state === 'idle' || (p?.pos ?? 0) <= 1;
      const idle = vm.state === 'idle', paused = vm.state === 'paused';
      withIcon(playMain, idle || paused ? 'play' : 'pause', true);
      const pl = idle ? 'Avvia l’automix' : paused ? 'Riprendi' : 'Pausa';
      playMain.setAttribute('aria-label', pl); playMain.title = pl;
      playMain.disabled = idle && !vm.ready;
      playMain.classList.toggle('playing', !idle && !paused);
      stopBtn.disabled = idle;
      if (shell && desk) desk.update(shell.current());
    }
    const ly = vm.lyrics;
    lyStatus.textContent = ly.status;
    lyPrev.textContent = ly.prev; lyNext.textContent = ly.next;
    if (ly.cur && ly.highlight !== false) paintWords(lyCur, ly.cur, ly.progress, md ? 'var(--md-primary)' : '#ffd23f', md ? 'var(--md-on-surface)' : '#eef1fb'); else lyCur.textContent = ly.cur || (ly.canShift ? '♪' : '');
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
    adListen.classList.toggle('hidden', md && !ad.available);
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
    if (md) { withIcon(bigBtn, idle ? 'play' : 'stop'); setLabel(bigBtn, idle ? 'Avvia automix' : 'Ferma automix'); } else bigBtn.textContent = idle ? '▶ AVVIA AUTOMIX' : '■ FERMA AUTOMIX';
    bigBtn.className = 'big' + (idle ? '' : ' on');
    bigBtn.onclick = () => (idle ? a.start() : a.stop());
    bigBtn.disabled = !vm.ready;
    nextBtn.disabled = mixBtn.disabled = pauseBtn.disabled = idle;
    if (md) withIcon(pauseBtn, vm.state === 'paused' ? 'play' : 'pause');
    label(pauseBtn, vm.state === 'paused' ? 'Riprendi' : 'Pausa');
    if (document.activeElement !== master) master.value = String(vm.master);
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PROFILES[i].id === vm.profile)));
    shuffleBtn.setAttribute('aria-pressed', String(vm.shuffle));
    const nextRepeat = { off: 'all', all: 'one', one: 'off' }[vm.repeat] as 'off' | 'all' | 'one';
    repeatBtn.dataset.next = nextRepeat;
    label(repeatBtn, { off: 'Ripeti: no', all: 'Ripeti: tutta la playlist', one: 'Ripeti: questo brano' }[vm.repeat]);
    repeatBtn.setAttribute('aria-pressed', String(vm.repeat !== 'off'));

    if (md) {
      const has = vm.queue.length > 0;
      emptyNow.classList.toggle('hidden', has);
      goNow.classList.toggle('hidden', !has || !idle);
      shell?.hint('list', !has);
      shell?.hint('now', has && idle && shell.current() !== 'now');
    }
    once('queue', (vm.queueSig ?? JSON.stringify(vm.queue)) + '#' + (vm.queueKey ?? ''), () => {
      if (ql) { ql.setRows(vm.queue, vm.queueKey); return; }
      queueList.replaceChildren(...vm.queue.map((r, i) => md ? mdRow(r, i, vm.queue) : h('div', {
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

  /** The screens with their readable names; the one chosen is found by its id, or by its name if the id changed. */
  function setDisplays(list: { key: string; label: string }[], selected?: string, selectedLabel?: string) {
    dispRow.classList.toggle('hidden', list.length === 0);
    const nameOf = (l?: string) => (l ?? '').split(' · ')[0].replace(' (principale)', '');
    const pick = list.find((d) => d.key === selected) ?? list.find((d) => selectedLabel && nameOf(d.label) === nameOf(selectedLabel));
    dispSel.replaceChildren(...list.map((d) => h('option', { value: d.key, selected: d === pick }, d.label)));
    if (list.length && (!pick || pick.key !== selected)) a.setDisplay(dispSel.value, dispSel.selectedOptions[0]?.textContent ?? undefined);
  }
  function setInputs(list: { id: string; label: string }[], selected?: string) {
    micSel.replaceChildren(h('option', { value: '' }, 'Predefinito'), ...list.map((d) => h('option', { value: d.id, selected: d.id === selected }, d.label)));
  }
  function setRefreshInfo(text: string) { refreshInfo.textContent = text; }
  function setAutoRefreshValue(min: number) { refreshSel.value = String(min); }
  function setSensitivity(v: number) { sens.value = String(v); }

  function setSource(name: string) { pill.textContent = md ? name : `Sorgente: ${name}`; pill.className = 'pill ' + (name.startsWith('Spotify') ? 'sp' : 'yt'); }

  function setStatus(msg: string, error = false) {
    if (md && msg && msg !== status.textContent) shell?.toast(msg, error);
    status.textContent = msg;
    status.className = 'status' + (error ? ' error' : '');
    statusListeners.forEach((fn) => fn(msg, error));
  }

  return { openWizard, openTutorial, setSource, mounts: [dA.mount, dB.mount] as [HTMLElement, HTMLElement], update, setStatus, setRefreshInfo, setAutoRefreshValue, setDisplays, setInputs, setSensitivity, setPlaylists, setProjectorMode, queuePanel, queueView: ql, setProjectorInfo, linkInput: link, loadBtn, go: (id: string) => shell?.go(id) };
}
