# Registro delle verifiche

Ultimo aggiornamento: 2026-10-25. Solo ciò che è stato davvero eseguito.

## Eseguito
| Verifica | Esito |
|---|---|
| Test automatici (`npm test`): coda, curve, automix con orologio finto, adattatore YouTube, caricamento playlist, impostazioni, scorciatoie, trascinamento, seek, testi, sincronizzazione playlist, proiettore | 147 test superati |
| macOS (Apple Silicon), app Tauri reale: playlist `PLfBfxMb0qlFw` (65 brani) caricata, automix avviato, crossfade riuscito, brano successivo preparato, nessun errore 153 | OK |
| macOS: finestra proiettore su secondo schermo (2 monitor rilevati), microfono attivo, forme e testo sincronizzato mostrati | OK |
| macOS: build di rilascio, `PartyMix AI_0.1.0_aarch64.dmg` (3,7 MB) | Generato con `hdiutil` (lo script grafico di Tauri si blocca in attesa di Finder) e verificato come valido; installazione da DMG non ancora provata a mano |
| Revisione finale indipendente del codice: 5 problemi importanti trovati e corretti con test (rete assente, comandi premuti mentre il deck libero è prestato, Stop sull'ultimo brano, pausa in crossfade, comando proiettore su Windows) | Corretti |
| Allineamento manuale dei testi (tocco su una riga, azzeramento) per versioni karaoke | OK nel browser; non provato con un karaoke reale sul proiettore |
| Aggiornamento playlist con automix in corso (deck libero prestato e brano successivo ripreparato) | OK nel browser; i casi "nuovi/rimossi" sono coperti da test, non da una playlist reale modificata |
| 1.7 test automatici: playlist dinamiche (4/10/100/250 playlist, 10.000 brani, migrazione delle 4 vecchie), lista finita con inizio e fine (prima→ultima, ultima→prima senza giro, scorrimento veloce, drag lento, touch, 1/10/1.000/10.000 brani), libreria (import singolo/multiplo, MP3 non valido o danneggiato, duplicato, tag ID3, download con progresso/interrotto/annullato, disco pieno, riavvio), offline (deck ibrido, coda che salta i brani solo online), ricerca YouTube (risultati, non disponibili, rete assente, quota/chiave/errore API), ricerca nella libreria e «in coda» | 337 test superati |
| 1.7 nel browser integrato (vite, 1440×900): playlist da 2.000 brani → 28 righe nel DOM, rotella verso l'alto dal brano 1 mostra …1999, 2000, 1, 2; 120 playlist nella barra laterale; «Cerca nella libreria» trova «Brano 1999» e indica la playlist; «⤵» lo mette in coda (posizione 2000) | OK. Trovati e corretti due difetti (righe non aggiornate a parità di lunghezza; coda senza brano corrente se YouTube diventava pronto dopo) |
| 1.7 Download Manager: 23 test Rust (validazione URL con file://, localhost, reti private, IPv6 locali; argomenti yt-dlp audio/video; avanzamento; errori; coda con limite 2 e modificabile, annullamento, deduplica, riavvio) + 11 test JS (comandi, libreria, playlist, vista) | Superati |
| 1.7 download reali con yt-dlp + ffmpeg sul Mac (`cargo test --test download_live -- --ignored`, un breve video pubblico di prova): MP3 192k in music/ con titolo, durata, miniatura in thumbnails/, nessun file temporaneo, seconda richiesta «già scaricato»; MP4 360p in video/; indirizzo inesistente → UNAVAILABLE | OK |
| 1.7 errore «HTTP 403» segnalato dall'utente | Causa: yt-dlp di 8 mesi prima. Aggiornato con Homebrew (2026.10.26) il download riesce; ora l'app avvisa se yt-dlp ha più di 60 giorni, con il comando per aggiornarlo, e passa a yt-dlp il PATH di Homebrew (serve `deno`) |
| 1.7 nuova interfaccia computer nel browser integrato (1440 e 1024 px): drawer/rail, Player con «In riproduzione da», lista da 2.000 brani con «▲ Inizio» e «■ Fine… · 2000 brani» (20 nodi nel DOM), pagina Playlist (120 schede) e dettaglio, menu ⋮ come finestra, Cerca con risultati sotto il campo, Libreria con chip e stato vuoto | OK; app per smartphone invariata (test material superati) |
| 1.7 comandi Rust `lib_write/lib_read/lib_delete` (cartella Musica › PartyMix Library) | `cargo check` OK; **non provati nell'app installata**: import reale di MP3 dal Finder, riproduzione da file e modalità aereo da verificare a mano |

## Non eseguito
- **Windows 11** (macchina virtuale Parallels presente ma spenta): non ho compilato né provato l'installer. Compilare in Windows richiede gli *strumenti di compilazione C++ di Visual Studio* (diversi GB), Rust e Node dentro la VM, oppure una compilazione automatica su GitHub Actions. Fino ad allora **Windows è non verificato**.
- Sessioni continue di oltre ~10 minuti con entrambi i player attivi (provati circa 3 minuti).
- Installer non firmati: l'avviso di sicurezza è documentato in [INSTALLAZIONE.md](INSTALLAZIONE.md), non testato su un Mac "pulito".
