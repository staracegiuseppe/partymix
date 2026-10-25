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

## Non eseguito
- **Windows 11** (macchina virtuale Parallels presente ma spenta): non ho compilato né provato l'installer. Compilare in Windows richiede gli *strumenti di compilazione C++ di Visual Studio* (diversi GB), Rust e Node dentro la VM, oppure una compilazione automatica su GitHub Actions. Fino ad allora **Windows è non verificato**.
- Sessioni continue di oltre ~10 minuti con entrambi i player attivi (provati circa 3 minuti).
- Installer non firmati: l'avviso di sicurezza è documentato in [INSTALLAZIONE.md](INSTALLAZIONE.md), non testato su un Mac "pulito".
