# PartyMix AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App desktop (Windows/macOS) che prende una playlist YouTube e la manda in automix con due deck, crossfade di volume, console in italiano e un popup proiettore con forme che reagiscono al microfono.

**Architecture:** Logica pura in TypeScript (coda, curve, scheduler automix) senza dipendenze da DOM/YouTube, testata con Vitest e orologio finto. Un adattatore sottile avvolge i due player IFrame di YouTube dietro un'interfaccia `Deck`. UI in Vite+TS vanilla. Tauri 2 serve l'interfaccia da `http://localhost` (necessario per evitare l'errore 153 di YouTube). Il popup proiettore è una seconda finestra Tauri con canvas e analisi del microfono (Web Audio `AnalyserNode`).

**Tech Stack:** Tauri 2 (Rust), `tauri-plugin-localhost`, Vite, TypeScript, Vitest, YouTube IFrame API, oEmbed, Web Audio API. Fallback: Electron (task 0).

**Spec:** `docs/superpowers/specs/2026-10-25-partymix-ai-design.md`

## Global Constraints

- Solo YouTube in streaming: nessun file audio/video scritto su disco, nessuna estrazione di flussi.
- Player YouTube sempre visibili, almeno 200×200 px, nella finestra principale; sul proiettore solo forme.
- UI solo in italiano. Funzioni non possibili con YouTube (BPM, beatmatching, EQ, limitatore, forma d'onda, loudness, rilevamento pubblicità) mostrate come "Non disponibile con YouTube", mai simulate.
- Nessuna chiave API nel codice. Nessuna ricerca automatica su YouTube.
- Durate transizione: morbida 12 s, standard 8 s, energica 4 s, manuale = solo su comando. Brano entrante da 0:00.
- Brano successivo non pronto: attesa max 5 s, poi saltato e si passa al seguente.
- Stop = ferma e torna all'inizio coda; Pausa = congela entrambi i deck. Scorciatoie solo con app in primo piano.
- Playlist pubbliche/non in elenco soltanto. Installer non firmati.
- Rust installato con `rustup` (approvato); se la Fase 0 fallisce, passare a Electron senza chiedere conferma.

## Review Focus

- Playlist con video eliminati/privati/non incorporabili (errori 100, 101, 150): avviso con elenco, la festa parte lo stesso con gli altri.
- Playlist di un solo brano, o in cui tutti i brani sono non riproducibili: nessun crash né loop infinito, messaggio chiaro.
- Rete che cade a metà brano o durante il crossfade: ripresa automatica, senza deck sdoppiati o volume bloccato a metà.
- "Prossimo brano" o "Transizione immediata" premuti durante un crossfade in corso: nessuno stato incoerente, volumi che si sommano mai oltre il massimo.
- Link incollato non valido, di playlist privata o di un video non incorporabile: esito comprensibile, coda invariata.

---

### Task 0: Prova dei due player (usa e getta)

**Files:**
- Create: `spike/` (cartella separata, da cancellare a fine task; non entra nel prodotto)

**Interfaces:** Produces: esito scritto in `spike/RESULT.md` (passa/fallisce + motivi).

- [ ] **Step 1:** Installare Rust con `rustup` e `cargo install tauri-cli --version "^2"`. Verifica: `rustc --version` e `cargo tauri --version` stampano una versione.
- [ ] **Step 2:** Creare un'app Tauri 2 minima in `spike/` con `tauri-plugin-localhost` che serve una pagina con due player IFrame (video `b2GlV6Ap-3g` e un secondo della playlist `PLfBfxMb0qlFw`) e un pulsante che sfuma il volume dell'uno nell'altro in 8 s con `setVolume`.
- [ ] **Step 3:** Eseguire `cargo tauri dev` e verificare a orecchio e dalla console: entrambi suonano insieme, il fade è graduale, nessun errore 153, per 10 minuti anche con la finestra non in primo piano.
- [ ] **Step 4:** Se fallisce (153, uno dei due si mette in pausa, volume ignorato): ripetere con Electron (`http://localhost` servito da Node); se passa, tutto il resto del piano usa Electron al posto di Tauri (mappare: plugin localhost → server Node; finestra secondaria → `BrowserWindow`). Scrivere la decisione in `spike/RESULT.md`.
- [ ] **Step 5:** Registrare il risultato nel messaggio all'utente. Non committare `spike/`.

### Task 1: Scheletro del progetto e orchestrazione di base

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/log.ts`, `src-tauri/` (da `cargo tauri init`), `.gitignore`, `tests/log.test.ts`
- Run: `git init` in `partymix-ai/`

**Interfaces:** Produces: `log(level: 'debug'|'info'|'warn'|'error', event: string, data?: Record<string, unknown>): void` che scrive una riga JSON `{t, level, event, ...data}` su console e su `LogSink[]` sostituibile con `setSinks(sinks: LogSink[])`.

- [ ] **Step 1:** Test `log emits one JSON line with time, level, event and data` e `log with a throwing sink does not throw`.
- [ ] **Step 2:** Eseguire `npx vitest run tests/log.test.ts`; atteso: FAIL (modulo mancante).
- [ ] **Step 3:** Implementare `log.ts` come da Interfaces.
- [ ] **Step 4:** Eseguire il test; atteso: PASS. Eseguire anche `cargo tauri dev` e verificare che la finestra mostri "PartyMix AI".
- [ ] **Step 5:** Commit `feat: project skeleton and structured logging`.

### Task 2: Coda e playlist (logica pura)

**Files:**
- Create: `src/queue.ts`, `src/playlistUrl.ts`, `tests/queue.test.ts`, `tests/playlistUrl.test.ts`

**Interfaces:**
- Produces: `parsePlaylistInput(text: string): {kind:'playlist', listId:string} | {kind:'video', videoId:string, listId?:string} | {kind:'invalid'}`
- Produces: `type Track = {videoId:string; title?:string; artist?:string; thumb?:string; durationSec?:number; locked?:boolean; status:'ok'|'unplayable'|'pending'}`
- Produces: `class Queue { constructor(tracks:Track[], opts?:{shuffle?:boolean; repeat?:'off'|'all'|'one'; rng?:()=>number}); current():Track|undefined; peekNext():Track|undefined; advance():Track|undefined; markUnplayable(videoId:string):void; move(from:number,to:number):void; add(t:Track):void; setLocked(videoId:string, v:boolean):void; skipNext():Track|undefined; history():Track[]; reset():void; all():Track[] }`

- [ ] **Step 1:** Test per `parsePlaylistInput`: URL con `?list=PLfBfxMb0qlFw`, URL `watch?v=b2GlV6Ap-3g&list=PLfBfxMb0qlFw` (→ playlist), `youtu.be/b2GlV6Ap-3g` (→ video), testo qualunque (→ invalid).
- [ ] **Step 2:** Test `Queue`: `advance` salta i `unplayable`; `repeat:'all'` riparte dall'inizio; playlist con tutti i brani non riproducibili → `advance()` restituisce `undefined` senza loop; `skipNext()` su un brano `locked` non lo salta e restituisce il corrente, mentre `advance()` (fine naturale del brano) procede sempre; `shuffle` con `rng` fisso è deterministico; `history()` elenca i brani riprodotti in ordine.
- [ ] **Step 3:** Eseguire `npx vitest run tests/queue.test.ts tests/playlistUrl.test.ts`; atteso: FAIL.
- [ ] **Step 4:** Implementare i due moduli come da Interfaces.
- [ ] **Step 5:** Eseguire i test; atteso: PASS. Commit `feat: queue and playlist url parsing`.

### Task 3: Curve di crossfade e profili

**Files:**
- Create: `src/crossfade.ts`, `tests/crossfade.test.ts`

**Interfaces:**
- Produces: `type Profile = 'morbida'|'standard'|'energica'|'manuale'`; `profileSeconds(p: Profile): number | null` (12, 8, 4, null)
- Produces: `crossfadeGains(progress: number): {out:number; in:number}` con `progress` in [0,1] clampato, curva a potenza costante (`out=cos(p·π/2)`, `in=sin(p·π/2)`), poi ciascun valore scalato a 0–100 dal chiamante.

- [ ] **Step 1:** Test: `progress=0 → {out:1,in:0}`; `progress=1 → {out:0,in:1}`; `progress=0.5 → out≈in≈0.7071`; valori fuori da [0,1] sono clampati; `out²+in²≈1` per 11 punti; `profileSeconds('standard')===8`, `profileSeconds('manuale')===null`.
- [ ] **Step 2:** Eseguire `npx vitest run tests/crossfade.test.ts`; atteso: FAIL.
- [ ] **Step 3:** Implementare `crossfade.ts`.
- [ ] **Step 4:** Test; atteso: PASS. Commit `feat: crossfade curves and profiles`.

### Task 4: Motore automix (macchina a stati con orologio finto)

**Files:**
- Create: `src/automix.ts`, `tests/automix.test.ts`

**Interfaces:**
- Consumes: `Queue`, `crossfadeGains`, `profileSeconds`, `Profile`.
- Produces: `interface Deck { load(videoId:string):Promise<void>; play():void; pause():void; stop():void; setVolume(v0to100:number):void; position():number; duration():number; onEnded(cb:()=>void):void; onError(cb:(code:number)=>void):void }`
- Produces: `class Automix { constructor(deps:{decks:[Deck,Deck]; queue:Queue; profile:()=>Profile; masterVolume:()=>number; now:()=>number; setTimer:(fn:()=>void, ms:number)=>number; clearTimer:(id:number)=>void; log:typeof log}); start():void; pause():void; resume():void; stop():void; next():void; mixNow():void; state():'idle'|'playing'|'preparing'|'crossfading'|'paused'; activeDeck():0|1 }`

- [ ] **Step 1:** Test con decks finti: (a) con profilo `standard`, quando mancano 8 s alla fine del deck attivo parte il crossfade e a fine crossfade `out`=0 e `in`=volume master, il deck uscente è fermato; (b) `masterVolume` 50 → il volume massimo applicato è 50; (c) prossimo brano che non carica entro 5 s → marcato `unplayable`, si prova il seguente; (d) `mixNow()` durante un crossfade già in corso non avvia un secondo crossfade; (e) `next()` in crossfade completa subito il mix corrente e passa oltre; (f) `pause()` ferma i timer e `resume()` riprende dallo stesso progresso; (g) profilo `manuale` non parte da solo; (h) coda finita senza repeat → stato `idle`; (i) `onError` su deck attivo → salta al successivo senza fermare la festa.
- [ ] **Step 2:** `npx vitest run tests/automix.test.ts`; atteso: FAIL.
- [ ] **Step 3:** Implementare `Automix`; il crossfade avanza a passi di ~100 ms tramite `setTimer`, calcolando il progresso da `now()`, mai da contatori di passi.
- [ ] **Step 4:** Test; atteso: PASS. Commit `feat: automix engine`.

### Task 5: Adattatore YouTube dei deck

**Files:**
- Create: `src/youtubeDeck.ts`, `src/ytApi.ts`, `tests/youtubeDeck.test.ts`

**Interfaces:**
- Consumes: `Deck`.
- Produces: `loadYouTubeApi(): Promise<void>`; `createYouTubeDeck(el: HTMLElement, opts?:{sizePx?:number}): Promise<Deck>` (player ≥ 200×200).
- Produces: `mapYtError(code:number): {kind:'unplayable'|'retry'; reason:string}` — 2/5 → retry; 100/101/150 → unplayable; 153 → unplayable con motivo "origine non valida".

- [ ] **Step 1:** Test su `mapYtError` per 2, 5, 100, 101, 150, 153 e un codice sconosciuto (→ retry) e su un `Deck` costruito su un finto oggetto player: `setVolume` clampa a 0–100; `position()` restituisce `getCurrentTime()`.
- [ ] **Step 2:** `npx vitest run tests/youtubeDeck.test.ts`; atteso: FAIL.
- [ ] **Step 3:** Implementare. Riprova di rete: su `retry` ricarica il video alla stessa posizione fino a 3 volte con attesa crescente (1 s, 3 s, 7 s), poi `onError`. Log di ogni evento.
- [ ] **Step 4:** Test; atteso: PASS. Provare a mano nell'app che un video riproduca. Commit `feat: YouTube deck adapter`.

### Task 6: Caricamento playlist, avviso e sostituzione brani

**Files:**
- Create: `src/playlistLoader.ts`, `src/oembed.ts`, `tests/playlistLoader.test.ts`

**Interfaces:**
- Consumes: `parsePlaylistInput`, `Track`, `mapYtError`.
- Produces: `fetchOEmbed(videoId:string, f?:typeof fetch): Promise<{ok:true; title:string; author:string; thumb:string} | {ok:false; reason:string}>`
- Produces: `checkProbe(videoId:string): Promise<{ok:boolean; reason?:string}>` (prova di riproduzione in un player visibile ≥ 200×200 dentro il dialogo "Verifica brano": mai nascosto).
- Produces: `buildTracks(ids:string[], meta:(id:string)=>Promise<Partial<Track>>, concurrency=5): Promise<Track[]>`; `verifyReplacement(text:string): Promise<{ok:boolean; track?:Track; message:string}>`

- [ ] **Step 1:** Test: `fetchOEmbed` con fetch finto 200 e 401/404 → `ok:false` con motivo italiano; `buildTracks` con un `meta` che fallisce per un id → quel brano è `status:'unplayable'`, gli altri restano `ok`, ordine mantenuto; `verifyReplacement('abc')` → `ok:false` "Link non valido"; `verifyReplacement` con un link di playlist privata → `ok:false` con motivo.
- [ ] **Step 2:** `npx vitest run tests/playlistLoader.test.ts`; atteso: FAIL.
- [ ] **Step 3:** Implementare. Gli ID si ottengono da `player.getPlaylist()` di un player temporaneo; l'avviso dopo il caricamento elenca i brani `unplayable` (titolo se noto, altrimenti ID) con un campo per incollare il link sostitutivo e l'esito di `verifyReplacement` in chiaro.
- [ ] **Step 4:** Test; atteso: PASS. Prova a mano con `PLfBfxMb0qlFw` (65 brani attesi). Commit `feat: playlist loading and replacement check`.

### Task 7: Console principale

**Files:**
- Create: `src/ui/console.ts`, `src/ui/shortcuts.ts`, `src/ui/unavailable.ts`, `src/ui/style.css`, `tests/shortcuts.test.ts`
- Modify: `index.html`, `src/main.ts`

**Interfaces:**
- Consumes: `Automix`, `Queue`, `Deck`, `playlistLoader`.
- Produces: `bindShortcuts(root:Window, h:{next():void; pause():void; stop():void; mixNow():void; volumeUp():void; volumeDown():void}): () => void` con tasti `→` prossimo, `Spazio` pausa/riprendi, `S` stop, `M` transizione immediata, `↑`/`↓` volume; ignora i tasti quando il focus è in un campo di testo.

- [ ] **Step 1:** Test: ogni tasto chiama il suo handler una sola volta; il focus in `<input>` non lo attiva; la funzione restituita rimuove il listener.
- [ ] **Step 2:** `npx vitest run tests/shortcuts.test.ts`; atteso: FAIL.
- [ ] **Step 3:** Implementare `shortcuts.ts`, poi la console: Deck A/B con copertina, titolo, tempo trascorso/residuo, volume per deck; crossfader centrale che riflette lo stato dell'automix; selettore profilo (Morbida/Standard/Energica/Manuale); pulsante grande Avvia/Ferma automix; Prossimo, Pausa, Stop, Transizione immediata; volume generale; coda con riordino, blocco brano, shuffle/ripeti; cronologia; banner sorgente "YouTube" con stato/errori; pulsante manuale "Abbassa volume (pubblicità)" per deck; sezione "Non disponibile con YouTube" elencando BPM, beatmatching, EQ, limitatore, forma d'onda, loudness, rilevamento pubblicità. Ogni controllo visibile deve avere una funzione reale; nessun pulsante decorativo. Layout fluido da 1024 px di larghezza a schermi grandi, tema scuro.
- [ ] **Step 4:** Test; atteso: PASS. Verifica a mano con la playlist di prova: avvio, Prossimo, Pausa, Stop, Transizione immediata, riordino coda.
- [ ] **Step 5:** Commit `feat: main console`.

### Task 8: Impostazioni e ripresa dopo il riavvio

**Files:**
- Create: `src/settings.ts`, `tests/settings.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `type Settings = {profile:Profile; master:number; shuffle:boolean; repeat:'off'|'all'|'one'; micDeviceId?:string; micSensitivity:number; projectorDisplay?:string; playlistText?:string; locked:string[]}`; `loadSettings(store:Storage):Settings` (valori di default se mancanti o corrotti); `saveSettings(store:Storage, s:Settings):void`.

- [ ] **Step 1:** Test: JSON corrotto → default senza eccezioni; round-trip identico; campi sconosciuti ignorati; `master` fuori range clampato a 0–100.
- [ ] **Step 2:** Eseguire, atteso FAIL. **Step 3:** Implementare e collegare il salvataggio automatico a ogni cambio. **Step 4:** Test PASS; riavviare l'app e verificare che profilo, volume, playlist e brani bloccati tornino. Commit `feat: persisted settings`.

### Task 9: Popup proiettore con forme a ritmo del microfono

**Files:**
- Create: `src/projector/projector.html`, `src/projector/visualizer.ts`, `src/projector/mic.ts`, `tests/visualizer.test.ts`
- Modify: `src-tauri/tauri.conf.json` (seconda finestra, permesso microfono), `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`), `src/ui/console.ts` (pulsante "Apri proiettore")

**Interfaces:**
- Produces: `bandEnergy(freq:Uint8Array, sampleRate:number): {bass:number; mid:number; high:number; level:number}` (valori 0–1; bass 20–150 Hz, mid 150–2000 Hz, high 2000–8000 Hz).
- Produces: `startMic(deviceId?:string): Promise<{ok:true; analyser:AnalyserNode; stop():void} | {ok:false; reason:'denied'|'nodevice'|'error'}>`; `listInputs(): Promise<{id:string; label:string}[]>`.

- [ ] **Step 1:** Test `bandEnergy`: silenzio → tutti 0; un picco solo nelle frequenze basse → `bass` alto e `high` ≈ 0; valori sempre in [0,1].
- [ ] **Step 2:** Eseguire, atteso FAIL. **Step 3:** Implementare `bandEnergy`, `mic.ts` (`getUserMedia` con eco/AGC disattivati per non appiattire la dinamica, slider di sensibilità), `visualizer.ts` (canvas a schermo intero: cerchi e forme che reagiscono a bass/mid/high). Se il microfono è negato o assente, il popup mostra un messaggio chiaro ("Microfono non disponibile: concedi il permesso o scegli un ingresso") e **nessuna animazione finta**. Il popup si apre sul secondo schermo se presente e ne ricorda la scelta; il selettore ingresso e lo slider sensibilità sono nella console.
- [ ] **Step 4:** Test PASS; prova a mano con musica in stanza: le forme seguono i bassi; negare il permesso mostra il messaggio. Commit `feat: projector window with mic-driven visuals`.

### Task 10: Rilascio, documentazione e prova su Windows

**Files:**
- Create: `README.md`, `docs/INSTALLAZIONE.md`, `docs/LIMITI-YOUTUBE.md`
- Modify: `src-tauri/tauri.conf.json` (bundle `dmg`, `msi`/`nsis`)

- [ ] **Step 1:** `npx vitest run` e `cargo test` in `src-tauri`; atteso: tutto PASS.
- [ ] **Step 2:** `cargo tauri build` su macOS; installare il `.dmg` e verificare che si avvii e riproduca la playlist di prova.
- [ ] **Step 3:** Nella VM Windows dell'utente: installare Rust/Node, costruire con `cargo tauri build` (verificare l'architettura x64 o ARM64 della VM), installare il `.msi`/`.exe`, aprire con l'avviso SmartScreen e ripetere la verifica di riproduzione, due player, fade, popup proiettore e microfono. Riportare l'esito reale, anche se parziale.
- [ ] **Step 4:** Scrivere i tre documenti in italiano: installazione, come aprire gli installer non firmati (macOS: clic destro → Apri; Windows: Ulteriori informazioni → Esegui comunque), uso passo-passo, scorciatoie, e `LIMITI-YOUTUBE.md` con cosa è supportato, limitato e non disponibile con YouTube.
- [ ] **Step 5:** Commit `docs: release documentation and installers`.
