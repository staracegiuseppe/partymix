# PartyMix AI

Un DJ virtuale gratuito per le feste: incolli il link di una playlist YouTube, premi **Avvia automix** e la musica prosegue da sola, con due deck e passaggi a dissolvenza tra un brano e l'altro. Sul proiettore compaiono forme che si muovono a ritmo e il testo della canzone.

Funziona su **macOS** e **Windows** (app Tauri 2: leggera, circa 10 MB). Niente viene scaricato sul disco: la musica arriva in streaming dai player ufficiali di YouTube.

## Come si usa
1. Avvia PartyMix AI (vedi [installazione](docs/INSTALLAZIONE.md)).
2. Incolla il link di una playlist YouTube **pubblica o non in elenco** e premi **Carica playlist**.
3. Se alcuni brani non sono riproducibili, compare un avviso: incolla il link di un brano sostitutivo e l'app ti dice subito se va bene.
4. Premi **▶ Avvia automix**. Il brano successivo viene preparato sul deck libero e il passaggio parte da solo prima della fine.
5. Per il proiettore: **Apri proiettore** (si apre a schermo intero sul secondo schermo, se c'è). `Esc` lo chiude.

### Controlli
| Controllo | Cosa fa |
|---|---|
| Avvia / Ferma automix | Avvia; da avviato ferma tutto e riporta la coda all'inizio |
| Prossimo brano | Passa subito al successivo (non salta un brano **bloccato**) |
| Pausa / Riprendi | Congela entrambi i deck |
| Transizione immediata | Avvia subito il crossfade con la durata del profilo scelto |
| Morbida / Standard / Energica / Manuale | Crossfade di 12 s / 8 s / 4 s / solo quando lo chiedi tu |
| Volume generale, volume dei deck | 0–100 |
| Abbassa volume (per deck) | Porta il deck al 20%: da usare a mano durante una pubblicità |
| Barra sotto il titolo | Trascinala per spostarti avanti e indietro nel brano in onda |
| Coda | Trascina le righe per cambiare ordine (anche **Su/Giù**), **Blocca** impedisce di saltare un brano, **Casuale**, **Ripeti** |
| Aggiorna ora / Aggiornamento automatico | Rilegge la playlist su YouTube: i brani nuovi finiscono in coda, quelli tolti spariscono (mai quello in onda né i brani aggiunti a mano). Automatico ogni 2/5/10/30 minuti o solo manuale |
| Testo | Mostra il testo sincronizzato; **Anticipa/Ritarda 0,5 s** corregge versioni diverse dall'originale |

Scorciatoie (con l'app in primo piano): `→` prossimo · `Spazio` pausa/riprendi · `S` ferma · `M` transizione immediata · `↑`/`↓` volume.

Le impostazioni (profilo, volume, playlist, brani bloccati, ingresso audio) si salvano da sole.

## Cosa è supportato, limitato, non disponibile
Vedi [docs/LIMITI-YOUTUBE.md](docs/LIMITI-YOUTUBE.md). In sintesi: crossfade di volume, coda, automix, testi e proiettore **funzionano**; BPM, beatmatching, EQ, limitatore, forma d'onda e rilevamento automatico delle pubblicità **non sono possibili con YouTube** e l'app lo dichiara invece di simularli.

## Privacy
- Il microfono serve solo a far muovere le forme: l'audio viene analizzato in tempo reale, **non registrato né salvato**.
- Per i testi l'app invia titolo e artista a [LRCLIB](https://lrclib.net); per titoli e copertine interroga l'oEmbed di YouTube. Nessun account, nessuna chiave API.

## Note legali
I testi appartengono ai rispettivi autori: mostrarli su un proiettore in pubblico può richiedere licenze. Lo stesso vale per la musica nelle feste pubbliche. Verifica cosa serve per il tuo evento.

## Sviluppo
```bash
npm install
npm test                    # 108 test (logica, automix, YouTube, testi, UI)
npx tauri dev               # avvia l'app
npx tauri build --bundles dmg   # su macOS; su Windows: npx tauri build
```
Struttura: `src/automix.ts` (motore), `src/queue.ts`, `src/crossfade.ts` (logica pura, senza DOM), `src/youtubeDeck.ts` (adattatore del player), `src/lyrics.ts`, `src/projector/` (finestra proiettore), `src/ui/` (console), `src-tauri/` (Rust: finestre e schermi).

Nota per chi sviluppa: se la cartella del progetto è in iCloud (Scrivania e Documenti), tieni `node_modules` e la cartella `target` di Cargo fuori da iCloud (`CARGO_TARGET_DIR`), altrimenti i file vengono "svuotati" e gli strumenti si bloccano.
