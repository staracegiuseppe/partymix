import type { AutomixState } from '../automix';
import type { Profile } from '../crossfade';
import { fmtTime, h } from './dom';
import { UNAVAILABLE_WITH_YOUTUBE } from './unavailable';

export type Actions = {
  loadPlaylist(text: string): void;
  start(): void;
  stop(): void;
  next(): void;
  togglePause(): void;
  mixNow(): void;
  setProfile(p: Profile): void;
  setMaster(v: number): void;
  seek(i: 0 | 1, seconds: number): void;
  setDeckVolume(i: 0 | 1, v: number): void;
  toggleDuck(i: 0 | 1): void;
  toggleLock(videoId: string): void;
  move(from: number, to: number): void;
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
  anchorLyrics(lineIndex: number): void;
  resetLyricsAlign(): void;
  setShowLyrics(on: boolean): void;
};

export type DeckVM = { title: string; artist: string; thumb?: string; elapsed: number; duration: number; role: 'live' | 'out' | 'ready' | 'loading' | 'idle'; volume: number; duck: boolean };
export type QueueRowVM = { id: string; title: string; artist: string; bad: boolean; locked: boolean; current: boolean };
export type LyricsVM = { status: string; prev: string; cur: string; next: string; plain?: string; offset: number; speed: number; show: boolean; canShift: boolean; lines: string[]; index: number };
export type ViewModel = {
  lyrics: LyricsVM;
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
const ROLE_LABEL: Record<DeckVM['role'], string> = { live: 'IN ONDA', out: 'IN USCITA', ready: 'PRONTO', loading: 'PREPARAZIONE…', idle: 'FERMO' };

export function buildConsole(root: HTMLElement, a: Actions) {
  const status = h('div', { class: 'status', role: 'status' });
  const link = h('input', { type: 'text', placeholder: 'Incolla il link della playlist YouTube', 'aria-label': 'Link della playlist YouTube' });
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
  const projPanel = h('section', { class: 'panel' }, h('h3', {}, 'Proiettore'),
    h('div', { class: 'artist', style: 'margin-bottom:8px' }, 'Le forme seguono il suono della stanza tramite il microfono. Non viene registrato nulla.'),
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
  const lyShow = h('input', { type: 'checkbox', 'aria-label': 'Mostra il testo sul proiettore', onChange: () => a.setShowLyrics(lyShow.checked) });
  const lyList = h('div', { class: 'lylist hidden' });
  const lyHint = h('div', { class: 'artist hidden' }, 'Il testo non combacia (versione karaoke, live…)? Tocca nell’elenco la riga che si sta cantando adesso. Con due tocchi, uno all’inizio e uno più avanti, si adatta anche la velocità.');
  const lyReset = h('button', { onClick: () => a.resetLyricsAlign() }, 'Azzera allineamento');
  const lyricsPanel = h('section', { class: 'panel' }, h('h3', {}, 'Testo'), lyStatus, lyPrev, lyCur, lyNext, lyPlain, lyHint, lyList,
    h('div', { class: 'row' }, lyEarly, lyLate, lyReset), h('div', { class: 'row' }, lyOffset),
    h('label', { class: 'row' }, lyShow, 'Mostra sul proiettore'));
  const side = h('div', { class: 'side' }, lyricsPanel, warnPanel, projPanel,
    h('section', { class: 'panel' }, h('h3', {}, 'Già suonati'), histList),
    h('section', { class: 'panel' }, h('h3', {}, 'Stato e problemi'), problems),
    h('section', { class: 'panel' }, unav));

  root.append(h('div', { class: 'wrap' },
    h('header', { class: 'top' }, h('div', { class: 'logo' }, 'Party', h('b', {}, 'Mix'), ' AI'),
      h('span', { class: 'pill yt' }, 'Sorgente: YouTube'), h('div', { class: 'status' }, 'Funzioni audio avanzate non disponibili con YouTube')),
    h('div', { class: 'load' }, link, loadBtn), status,
    h('div', { class: 'decks' }, dA.card, mixer, dB.card),
    h('div', { class: 'lower' }, queuePanel, side)));

  let dragFrom = -1;
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
    d.duck.textContent = v.duck ? 'Volume abbassato: ripristina' : 'Abbassa volume';
  };

  function update(vm: ViewModel) {
    const ly = vm.lyrics;
    lyStatus.textContent = ly.status;
    lyPrev.textContent = ly.prev; lyCur.textContent = ly.cur || (ly.canShift ? '♪' : ''); lyNext.textContent = ly.next;
    lyPlain.textContent = ly.plain ?? ''; lyPlain.classList.toggle('hidden', !ly.plain);
    lyEarly.disabled = lyLate.disabled = !ly.canShift;
    lyOffset.textContent = ly.canShift ? `Spostamento: ${ly.offset > 0 ? '+' : ''}${ly.offset.toFixed(1).replace('.', ',')} s` + (Math.abs(ly.speed - 1) > 0.005 ? ` · velocità ×${ly.speed.toFixed(2).replace('.', ',')}` : '') : '';
    lyReset.disabled = !ly.canShift;
    lyHint.classList.toggle('hidden', !ly.canShift);
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
        title: 'Trascina per cambiare ordine',
        onDragstart: (e: DragEvent) => { dragFrom = i; (e.currentTarget as HTMLElement).classList.add('dragging'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } },
        onDragover: (e: DragEvent) => { if (dragFrom < 0) return; e.preventDefault(); clearOver(); if (i !== dragFrom) (e.currentTarget as HTMLElement).classList.add('over'); },
        onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('over'),
        onDrop: (e: DragEvent) => { e.preventDefault(); const from = dragFrom; dragFrom = -1; clearOver(); if (from >= 0 && from !== i) a.move(from, i); },
        onDragend: (e: DragEvent) => { dragFrom = -1; clearOver(); (e.currentTarget as HTMLElement).classList.remove('dragging'); },
      },
        h('span', { class: 'artist' }, String(i + 1)),
        h('span', { class: 't' }, r.title + (r.artist ? ` — ${r.artist}` : ''), r.current ? h('span', { class: 'tag' }, 'in onda') : null, r.locked ? h('span', { class: 'tag' }, 'bloccato') : null, r.bad ? h('span', { class: 'tag' }, 'non riproducibile') : null),
        h('span', { class: 'acts' },
          h('button', { 'aria-label': 'Sposta su', disabled: i === 0, onClick: () => a.move(i, i - 1) }, 'Su'),
          h('button', { 'aria-label': 'Sposta giù', disabled: i === vm.queue.length - 1, onClick: () => a.move(i, i + 1) }, 'Giù'),
          h('button', { 'aria-pressed': String(r.locked), title: 'Un brano bloccato non viene saltato con «Prossimo brano»', onClick: () => a.toggleLock(r.id) }, r.locked ? 'Sblocca' : 'Blocca')))));
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

  function setStatus(msg: string, error = false) {
    status.textContent = msg;
    status.className = 'status' + (error ? ' error' : '');
  }

  return { mounts: [dA.mount, dB.mount] as [HTMLElement, HTMLElement], update, setStatus, setRefreshInfo, setAutoRefreshValue, setDisplays, setInputs, setSensitivity, linkInput: link, loadBtn };
}
