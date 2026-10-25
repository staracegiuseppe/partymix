# PartyMix AI — Design

Data: 2026-10-25. Stato: bozza in attesa di approvazione.

## Intenzione
Un DJ virtuale gratuito per feste: l'utente incolla una playlist YouTube, avvia l'automix e la musica prosegue da sola per ore con transizioni a dissolvenza tra due deck. Un secondo schermo (proiettore/TV) mostra forme animate che reagiscono alla musica. Chi gestisce la festa non ha competenze musicali o informatiche.

## Obiettivi
- App desktop installabile, leggera, per Windows 10/11 e macOS, stesso codice.
- Sorgente: solo YouTube in streaming. Nessun file scaricato, nessuna cache di audio/video su disco (poco spazio su FS).
- Due deck con due player YouTube ufficiali (IFrame API), crossfade tramite `setVolume` a gradini su entrambi.
- Automix: preparazione del brano successivo, avvio della transizione prima della fine, passaggio continuo. Profili di transizione: morbida, standard, energica, manuale.
- Controlli sempre disponibili: Prossimo brano, Pausa, Stop, Transizione immediata, volume generale e per deck, blocco di un brano (non saltato), shuffle/ripeti, coda, cronologia, scorciatoie da tastiera.
- Gestione errori: video non incorporabile/non disponibile → segnalato, saltato, sostituibile; errori di rete → ripresa automatica della riproduzione.
- Popup proiettore: finestra separata a schermo intero, senza controlli, con forme animate guidate dal microfono (energia/bassi). Ingresso audio selezionabile (es. scheda audio collegata all'impianto).
- Salvataggio automatico delle impostazioni; logging strutturato; test automatici sulla logica critica.

## Non-obiettivi
- Nessuna estrazione/download dei flussi YouTube, nessuno scraping, nessun aggiramento di protezioni o pubblicità.
- Nessun BPM, beatmatching, tonalità, EQ di transizione, limitatore, forma d'onda o loudness su YouTube: YouTube non dà accesso all'audio. L'interfaccia mostra queste funzioni come "non disponibili con YouTube" e non le simula.
- Nessun rilevamento automatico della pubblicità (l'API non espone uno stato affidabile). Solo un pulsante manuale per abbassare/silenziare un deck.
- File locali, mixer hardware, microfono-voce, effetti: fuori da questa versione (architettura predisposta, non implementati).
- Audio di sistema (loopback) per le forme: rimandato (su macOS richiede driver virtuale).

## Anti-obiettivi (sarebbe un fallimento anche se "funziona")
- Funzioni decorative o finte presentate come reali (es. animazione a tempo fisso spacciata per sincronizzata).
- Player YouTube nascosti o ridotti sotto i 200×200 px, o altre violazioni dei termini di YouTube.
- Segreti (chiavi API) incorporati nel client.

## Vincoli
- I player YouTube restano visibili nella finestra principale (sul portatile); sul proiettore vanno solo le forme.
- YouTube può rifiutare la riproduzione in webview desktop (errore 153) a seconda dell'origine della pagina: la pagina dell'app va servita da origine `http(s)` valida, con `Referer` corretto.
- Due player contemporanei: su ogni piattaforma vanno verificati autoplay, ordine di caricamento e comportamento del volume. Il browser/webview potrebbe mettere in pausa un player non in primo piano.
- Windows non è testabile dallo sviluppo su questo Mac: verifica Windows documentata come non eseguita finché non c'è una macchina Windows.
- Accesso al microfono richiede il permesso dell'OS (macOS: Info.plist `NSMicrophoneUsageDescription`).

## Decisioni dell'utente
- Playlist di prova: `PLfBfxMb0qlFw` ("Birra", pubblica, 65 video) — verificata raggiungibile.
- Niente download locali; tecnologia leggera multipiattaforma Windows+macOS.
- Popup proiettabile con forme a ritmo di musica; sorgente del ritmo: microfono (audio di sistema più avanti).

## Risposte dell'utente (2026-10-25)
- Rust e Tauri approvati; installazione di Rust sul Mac consentita. Se la prova dei due player fallisce, passaggio a Electron **senza richiedere conferma**.
- Windows: l'utente ha una macchina virtuale Windows su questo Mac. La verifica Windows si fa lì (build e prova dell'installer). Nota: se la VM è Windows ARM, va controllato il target di build.
- Installer **non firmati**; il README documenta come aprirli comunque (macOS: clic destro → Apri; Windows SmartScreen: Ulteriori informazioni → Esegui comunque).
- UI **solo italiano**.
- Brani non riproducibili: al caricamento della playlist l'app mostra un **avviso con l'elenco dei brani non riproducibili**. L'utente incolla a mano il link sostitutivo; l'app **verifica subito** che sia incorporabile e riproducibile (oEmbed + prova del player) e riferisce l'esito all'utente (va bene / non va bene e perché). Nessuna ricerca automatica su YouTube, nessuna chiave API nella v1.

## Decisioni mie (da confermare)
- **Tauri 2** (webview di sistema, ~10 MB) invece di Electron (~150 MB). Alternativa Electron se la prova dei due player in Tauri fallisce. Rust non è installato su questo Mac: va installato (con tuo ok).
- Interfaccia in TypeScript + Vite, senza framework pesanti; visualizzazione con Canvas/WebGL 2D.
- Metadati playlist da dati del player (`getPlaylist`) + oEmbed per titolo/copertina; Data API v3 solo opzionale con chiave inserita dall'utente, mai nel codice.
- Logica pura (scheduler automix, curve di crossfade, coda, macchina a stati dei deck) separata dall'interfaccia e dall'adattatore YouTube, testata con Vitest.
- Fase 0 obbligatoria: prova usa e getta con due player che si sfumano uno nell'altro, su macOS, prima di costruire il resto.

## Altre mie scelte (dal controllo del costruttore)
- **Origine YouTube**: l'app serve la propria interfaccia da un piccolo server `http://localhost` incluso nell'app (plugin localhost di Tauri), con `Referer` corretto. Nessuna pagina ospitata online.
- **Esito della Fase 0 (soglia)**: passa se, sul Mac, due player riproducono insieme in modo udibile per almeno 10 minuti, anche con la finestra non in primo piano, il fade di volume funziona e non compare l'errore 153. Se fallisce, si passa a Electron previa conferma dell'utente.
- **Tempi**: la transizione parte a un tempo fisso prima della fine (durata nota dal player). Morbida 12 s, standard 8 s, energica 4 s, manuale = solo su comando. Il brano entrante parte da 0:00. Se il successivo non è pronto in tempo: attende fino a 5 s, poi lo salta e passa al seguente.
- **Coda**: una playlist caricata alla volta, riordinabile, con aggiunta di singoli video da link incollato. Playlist e impostazioni ricordate al riavvio. Playlist private non supportate (solo pubbliche/non in elenco).
- **Stop** = ferma e torna all'inizio della coda; **Pausa** = congela entrambi i deck. Scorciatoie solo con l'app in primo piano (nessuna globale).
- **Proiettore**: si apre sullo schermo secondario se presente e ricorda la scelta. Senza permesso microfono o ingresso audio, mostra un messaggio chiaro, non un'animazione finta. Slider di sensibilità del microfono incluso.

## Lasciato al costruttore
Struttura delle cartelle, nomi, libreria di test, forme e palette del visualizzatore, curve di crossfade, scorciatoie, installer (Tauri bundler: `.dmg`/`.msi`), documentazione d'uso.
