import type { Profile } from '../crossfade';
import { APP_VERSION, AUTHOR, PAYPAL_QR } from '../info';
import { isAndroidApp, openMusicApp } from '../androidBridge';
import { h } from './dom';
import { FEEDBACK_TO, FeedbackKind, FeedbackVia, KIND_LABEL, sendFeedback } from '../feedback';

export type TourStep = { target: () => HTMLElement | null; title: string; text: string };

const remove = (...els: (Element | null | undefined)[]) => els.forEach((e) => e?.remove());

/** Highlights one part of the app at a time with a short explanation and Back / Next buttons. Resolves when the tour ends. */
export function startTour(allSteps: TourStep[]): Promise<void> {
  const steps = allSteps.filter((s) => s.target());
  if (steps.length === 0) return Promise.resolve();
  return new Promise((done) => {
    let i = 0;
    const blocker = h('div', { class: 'tour-block' });
    const hole = h('div', { class: 'tour-hole' });
    const count = h('div', { class: 'tour-count' });
    const title = h('h3', { class: 'tour-title' });
    const text = h('p', { class: 'tour-text' });
    const back = h('button', { onClick: () => go(i - 1) }, 'Indietro');
    const next = h('button', { class: 'primary', onClick: () => (i === steps.length - 1 ? close() : go(i + 1)) });
    const skip = h('button', { class: 'link', onClick: () => close() }, 'Esci dal tutorial');
    const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite' }, count, title, text, h('div', { class: 'tour-actions' }, skip, back, next));
    document.body.append(blocker, hole, card);

    const place = () => {
      const el = steps[i].target();
      if (!el) return;
      const r = el.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, pad = 6;
      Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      const cw = card.offsetWidth, ch = card.offsetHeight, m = 12;
      const fits = (x: number, y: number) => x >= 8 && y >= 8 && x + cw <= vw - 8 && y + ch <= vh - 8;
      const cand: [number, number][] = [
        [r.right + pad + m, r.top], [r.left - pad - m - cw, r.top],
        [r.left, r.bottom + pad + m], [r.left, r.top - pad - m - ch],
        [r.right - cw, r.bottom + pad + m], [r.right - cw, r.top - pad - m - ch],
      ];
      const free = cand.find(([cx, cy]) => fits(cx, cy));
      // No free spot: use the side (above/below) with more room, so the card hides as little as possible of the highlighted part.
      const roomAbove = r.top, roomBelow = vh - r.bottom;
      const [x, y] = free ?? [r.left, roomBelow >= roomAbove ? r.bottom + pad + m : r.top - pad - m - ch];
      card.style.left = `${Math.min(Math.max(8, x), vw - cw - 8)}px`;
      card.style.top = `${Math.min(Math.max(8, y), vh - ch - 8)}px`;
    };
    function go(n: number) {
      i = Math.min(steps.length - 1, Math.max(0, n));
      const el = steps[i].target();
      count.textContent = `${i + 1} di ${steps.length}`;
      title.textContent = steps[i].title;
      text.textContent = steps[i].text;
      back.disabled = i === 0;
      next.textContent = i === steps.length - 1 ? 'Fine' : 'Avanti';
      el?.scrollIntoView({ block: 'center', inline: 'nearest' });
      requestAnimationFrame(() => { place(); next.focus({ preventScroll: true }); });
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next.click(); }
      else if (e.key === 'ArrowLeft') back.click();
    };
    function close() {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
      removeEventListener('keydown', key, true);
      remove(blocker, hole, card);
      done();
    }
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    addEventListener('keydown', key, true);
    go(0);
  });
}

export type WizardCtx = {
  loadPlaylist(text: string): void;
  /** Called with the app's status line whenever it changes; returns the unsubscribe. */
  onStatus(fn: (text: string, error: boolean) => void): () => void;
  currentLink(): string;
  openProjector(): Promise<void>;
  closeProjector(): void;
  refreshInputs(): Promise<{ id: string; label: string }[]>;
  setMic(id: string): void;
  currentProfile(): Profile;
  setProfile(p: Profile): void;
  canStart(): boolean;
  start(): void;
  openTutorial(): void;
  finished(): void;
};

const STYLES: { id: Profile; label: string; hint: string }[] = [
  { id: 'morbida', label: 'Morbida', hint: 'Una lunga sfumatura (circa 12 secondi) da un brano all’altro: ideale per sottofondo e cene.' },
  { id: 'standard', label: 'Standard', hint: 'Circa 8 secondi: la scelta giusta quasi sempre.' },
  { id: 'energica', label: 'Energica', hint: 'Passaggio rapido (circa 4 secondi): per ballare.' },
  { id: 'manuale', label: 'Manuale', hint: 'Il cambio avviene solo quando lo chiedi tu con «Prossimo brano».' },
];

/** First-run setup: playlist, projector and microphone, mix style, then start. */
export function startWizard(ctx: WizardCtx): void {
  let step = 0;
  const TOTAL = 5;
  let unsub: (() => void) | undefined;
  const box = h('div', { class: 'modal-box wizard', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Configurazione guidata' });
  const overlay = h('div', { class: 'modal' }, box);
  document.body.append(overlay);

  const close = () => { unsub?.(); remove(overlay); ctx.finished(); };
  const dots = () => h('div', { class: 'dots', 'aria-hidden': 'true' }, ...Array.from({ length: TOTAL }, (_, n) => h('i', { class: n === step ? 'on' : n < step ? 'past' : '' })));
  const nav = (opts: { next?: string; nextAction?: () => void; hideBack?: boolean } = {}) => {
    const row = h('div', { class: 'tour-actions' }, h('button', { class: 'link', onClick: close }, step === TOTAL - 1 ? 'Chiudi' : 'Salta la configurazione'));
    if (step > 0 && !opts.hideBack) row.append(h('button', { onClick: () => show(step - 1) }, 'Indietro'));
    if (step < TOTAL - 1) row.append(h('button', { class: 'primary', onClick: opts.nextAction ?? (() => show(step + 1)) }, opts.next ?? 'Avanti'));
    return row;
  };

  function show(n: number) {
    unsub?.(); unsub = undefined;
    step = n;
    box.replaceChildren(dots());
    if (n === 0) {
      box.append(
        h('h2', {}, 'Benvenuto in PartyMix'),
        h('p', {}, 'Un DJ virtuale per le tue feste: scegli una playlist, premi un tasto e la musica va avanti da sola, con sfumature tra un brano e l’altro, testi da cantare e immagini sul proiettore.'),
        h('p', {}, 'Ti guido in quattro passi, ci vogliono due minuti. Puoi saltare tutto e rifarlo quando vuoi dal pulsante «Configurazione guidata» in alto.'),
        nav({ next: 'Iniziamo' }));
    } else if (n === 1) {
      const input = h('input', { type: 'text', placeholder: 'Incolla il link di una playlist YouTube o Spotify', 'aria-label': 'Link della playlist' });
      input.value = ctx.currentLink();
      const msg = h('div', { class: 'status wizard-status' });
      const go = h('button', { class: 'primary', onClick: () => ctx.loadPlaylist(input.value) }, 'Carica playlist');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ctx.loadPlaylist(input.value); });
      unsub = ctx.onStatus((t, err) => { msg.textContent = t; msg.className = 'status wizard-status' + (err ? ' error' : ''); });
      box.append(
        h('h2', {}, '1. La musica'),
        h('p', {}, isAndroidApp() ? 'Tocca «Scegli dalle app»: apri la tua playlist su YouTube o Spotify, «Condividi → PartyMix» e si carica da sola. Oppure incolla il link qui sotto.' : 'Apri YouTube o Spotify, scegli una playlist pubblica, copia il link e incollalo qui sotto. Finché non carichi una playlist, in alto leggi «Carica la tua playlist (Spotify / YouTube)».'),
        h('ul', { class: 'tips' },
          h('li', {}, 'YouTube: il link della playlist (contiene «list=»).'),
          h('li', {}, 'Spotify: il link della playlist o dell’album. L’elenco viene da Spotify, la musica è cercata e suonata da YouTube.')),
        h('div', { class: 'row' }, input, go),
        ...(isAndroidApp() ? [h('div', { class: 'row' }, h('button', { class: 'primary', onClick: () => showAppPicker((m) => { msg.textContent = m; msg.className = 'status wizard-status error'; }) }, '📱 Scegli dalle app'))] : []),
        msg,
        nav());
    } else if (n === 2) {
      const sel = h('select', { 'aria-label': 'Ingresso audio', onChange: () => ctx.setMic(sel.value) }, h('option', { value: '' }, 'Predefinito'));
      const msg = h('div', { class: 'status wizard-status' });
      const fill = async () => {
        try {
          const list = await ctx.refreshInputs();
          sel.replaceChildren(h('option', { value: '' }, 'Predefinito'), ...list.map((d) => h('option', { value: d.id }, d.label)));
          msg.textContent = list.length ? '' : 'Nessun ingresso audio trovato: collega un microfono o usa quello del computer.';
        } catch { msg.textContent = 'Non riesco a leggere gli ingressi audio: concedi il permesso al microfono se il sistema lo chiede.'; }
      };
      box.append(
        h('h2', {}, '2. Proiettore e microfono'),
        h('p', {}, 'Il proiettore è una seconda finestra a schermo intero da mostrare su TV o videoproiettore: ci sono le forme colorate che reagiscono alla musica e il testo da cantare, con le parole che si colorano.'),
        h('p', {}, 'Le forme ascoltano il suono della stanza con un microfono: non viene registrato nulla. Se il sistema chiede il permesso del microfono, concedilo.'),
        h('div', { class: 'row' },
          h('button', { onClick: () => { msg.textContent = ''; ctx.openProjector().catch((e: Error) => { msg.textContent = `Non riesco ad aprire il proiettore: ${e?.message ?? e}`; }); } }, 'Prova il proiettore'),
          h('button', { onClick: () => ctx.closeProjector() }, 'Chiudi proiettore')),
        h('div', { class: 'row' }, h('label', {}, 'Ingresso audio'), sel, h('button', { onClick: () => void fill() }, 'Cerca ingressi')),
        msg,
        h('p', { class: 'artist' }, 'Se hai più schermi, la finestra va sullo schermo diverso da quello principale; puoi cambiarlo dal pannello «Proiettore». Non è obbligatorio: puoi anche farlo dopo.'),
        nav());
      void fill();
    } else if (n === 3) {
      const hint = h('p', { class: 'artist wizard-hint' });
      const btns = STYLES.map((s) => h('button', { 'aria-pressed': 'false', onClick: () => { ctx.setProfile(s.id); paint(s.id); } }, s.label));
      const paint = (cur: Profile) => { btns.forEach((b, k) => b.setAttribute('aria-pressed', String(STYLES[k].id === cur))); hint.textContent = STYLES.find((s) => s.id === cur)?.hint ?? ''; };
      paint(ctx.currentProfile());
      box.append(
        h('h2', {}, '3. Come passare da un brano all’altro'),
        h('p', {}, 'Scegli lo stile delle transizioni. Potrai cambiarlo in qualsiasi momento durante la festa.'),
        h('div', { class: 'seg' }, ...btns), hint,
        nav());
    } else {
      const ok = ctx.canStart();
      box.append(
        h('h2', {}, 'Tutto pronto!'),
        h('p', {}, ok ? 'La playlist è caricata. Premi il pulsante e la festa comincia.' : 'Non hai ancora caricato una playlist: chiudi questa finestra, incolla un link in alto e premi «Carica playlist».'),
        h('div', { class: 'row wizard-final' },
          h('button', { class: 'primary big-btn', disabled: !ok, onClick: () => { close(); ctx.start(); } }, '▶ Avvia l’automix'),
          h('button', { onClick: () => { close(); ctx.openTutorial(); } }, 'Fai il tutorial dei comandi')),
        h('p', { class: 'artist' }, 'Consiglio: fai il tutorial una volta per scoprire cosa fa ogni parte dell’app.'),
        nav({ hideBack: false }));
    }
    (box.querySelector('input,button.primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  show(0);
}

/**
 * Comments and ideas for the author. The message is written here and then opens, ready to send, in the user's own
 * mail (app, Gmail or Outlook): it leaves from their account, so the author can answer them.
 */
export function showFeedback(): void {
  const close = () => remove(overlay);
  let kind: FeedbackKind = 'idea';
  const kinds = (Object.keys(KIND_LABEL) as FeedbackKind[]).map((k) => h('button', { 'aria-pressed': String(k === kind), onClick: () => { kind = k; kinds.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(KIND_LABEL)[i] === k))); } }, KIND_LABEL[k]));
  const text = h('textarea', { rows: '6', maxlength: '1500', 'aria-label': 'Il tuo messaggio', placeholder: 'Cosa ti piace, cosa aggiungeresti, cosa non funziona… Scrivi pure liberamente.' }) as HTMLTextAreaElement;
  const msg = h('div', { class: 'status' });
  const go = (via: FeedbackVia) => async () => {
    msg.textContent = '';
    try {
      await sendFeedback(via, kind, text.value);
      msg.textContent = 'Si è aperto il messaggio già pronto: controlla e premi «Invia» nella tua posta. Grazie!';
    } catch (e) {
      msg.textContent = `Non si apre (${(e as Error)?.message ?? e}): prova con Gmail o Outlook, oppure scrivi a ${FEEDBACK_TO}.`;
      msg.classList.add('error');
    }
  };
  const copy = h('button', { class: 'link', onClick: async () => { try { await navigator.clipboard.writeText(FEEDBACK_TO); copy.textContent = 'Indirizzo copiato'; } catch { copy.textContent = FEEDBACK_TO; } } }, 'Copia l’indirizzo');
  const box = h('div', { class: 'modal-box feedback', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Commenti e suggerimenti' },
    h('h2', {}, 'Commenti e suggerimenti'),
    h('p', {}, 'Dimmi cosa ne pensi e cosa vorresti trovare in PartyMix. Il messaggio parte dalla tua posta, così posso risponderti.'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Tipo di messaggio' }, ...kinds),
    text,
    h('div', { class: 'artist' }, `Arriva a ${FEEDBACK_TO}. Insieme al messaggio vanno solo la versione dell’app e il sistema (Windows, macOS, Android).`),
    msg,
    h('div', { class: 'tour-actions' },
      copy,
      h('button', { onClick: go('gmail') }, 'Con Gmail'),
      h('button', { onClick: go('outlook') }, 'Con Outlook'),
      h('button', { class: 'primary', onClick: go('mail') }, 'Con la mia posta'),
      h('button', { onClick: close }, 'Chiudi')));
  const overlay = h('div', { class: 'modal', onClick: (e: Event) => { if (e.target === overlay) close(); } }, box);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
  text.focus({ preventScroll: true });
}

export type InfoCtx = {
  openTutorial(): void;
  openWizard(): void;
};

/** About window: version, credits and the PayPal donation link. */
export function showInfo(ctx: InfoCtx): void {
  const close = () => remove(overlay);
  const box = h('div', { class: 'modal-box info', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Informazioni' },
    h('h2', {}, h('span', {}, 'Party'), h('b', {}, 'Mix')),
    APP_VERSION ? h('div', { class: 'artist' }, `Versione ${APP_VERSION}`) : null,
    h('p', {}, 'Un DJ virtuale gratuito per feste e serate: playlist YouTube o Spotify, mix automatico, testi da cantare e proiettore.'),
    h('div', { class: 'credit' }, h('div', { class: 'artist' }, 'Creato da'), h('div', { class: 'credit-name' }, AUTHOR)),
    h('p', {}, 'Se PartyMix ti è utile e ti va di ringraziare chi lo ha creato, puoi fare una piccola donazione con PayPal: è facoltativa e tutto funziona uguale anche senza.'),
    h('img', { class: 'paypal-qr', src: PAYPAL_QR, alt: `Codice QR PayPal di ${AUTHOR}`, width: '280', height: '280' }),
    h('div', { class: 'credit-name paypal-name' }, AUTHOR.toLowerCase()),
    h('p', { class: 'artist' }, 'Per donare: apri l’app PayPal sul telefono, scegli «Scansiona» e inquadra questo codice.'),
    h('p', { class: 'artist fine' }, 'I brani sono riprodotti da YouTube; con Spotify l’app usa solo l’elenco dei brani. Spotify e YouTube sono marchi dei rispettivi proprietari, estranei a questo progetto.'),
    h('div', { class: 'tour-actions' },
      h('button', { onClick: () => { close(); ctx.openTutorial(); } }, 'Tutorial'),
      h('button', { onClick: () => { close(); ctx.openWizard(); } }, 'Configurazione guidata'),
      h('button', { onClick: () => { close(); showFeedback(); } }, 'Commenti e suggerimenti'),
      h('button', { class: 'primary', onClick: close }, 'Chiudi')));
  const overlay = h('div', { class: 'modal', onClick: (e: Event) => { if (e.target === overlay) close(); } }, box);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
  (box.querySelector('button.primary') as HTMLElement | null)?.focus({ preventScroll: true });
}

/**
 * Phone: pick a playlist straight from the YouTube or Spotify app, no copy and paste.
 * The app opens on your playlists; «Condividi → PartyMix» brings the link back and it loads by itself.
 */
export function showAppPicker(onError: (msg: string) => void): void {
  const close = () => remove(overlay);
  const pick = (which: 'youtube' | 'spotify', name: string) => {
    close();
    if (!openMusicApp(which)) onError(`Non riesco ad aprire ${name}: è installata?`);
  };
  const box = h('div', { class: 'modal-box app-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scegli la playlist dalle app' },
    h('h2', {}, 'Scegli dalle app'),
    h('div', { class: 'app-picker-btns' },
      h('button', { class: 'app-yt', onClick: () => pick('youtube', 'YouTube') }, h('b', {}, '▶'), ' YouTube'),
      h('button', { class: 'app-sp', onClick: () => pick('spotify', 'Spotify') }, h('b', {}, '♫'), ' Spotify')),
    h('ol', { class: 'tips' },
      h('li', {}, 'Si apre l’app sulle tue playlist.'),
      h('li', {}, 'Apri la playlist (o l’album) che vuoi suonare.'),
      h('li', {}, 'Tocca «Condividi» e scegli PartyMix.'),
      h('li', {}, 'Torni qui e la playlist si carica da sola.')),
    h('p', { class: 'artist' }, 'Le playlist private non si possono leggere: rendile pubbliche o «non in elenco».'),
    h('div', { class: 'tour-actions' }, h('button', { onClick: close }, 'Chiudi')));
  const overlay = h('div', { class: 'modal', onClick: (e: Event) => { if (e.target === overlay) close(); } }, box);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
  (box.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
}
