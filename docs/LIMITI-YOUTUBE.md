# Cosa si può fare con YouTube (e cosa no)

PartyMix AI usa solo il **player ufficiale incorporato (IFrame API)**. Non scarica, non estrae e non registra l'audio dei video, e non aggira nessuna protezione. Questo dà dei limiti precisi.

## Supportato
- Due player YouTube **contemporanei**, con crossfade reale regolando il volume (curva a potenza costante). Verificato sul Mac con la playlist di prova: i due player suonano insieme, anche con la finestra non in primo piano, e il passaggio avviene senza errori.
- Preparazione automatica del brano successivo, passaggio prima della fine, profili morbida/standard/energica/manuale.
- Coda, riordino (trascinamento), blocco di un brano, casuale, ripeti, cronologia.
- Salto dei brani non riproducibili e **recupero dagli errori di rete** (3 tentativi a 1, 3 e 7 secondi, poi il brano viene saltato).
- Testo sincronizzato (da LRCLIB) e forme sul proiettore guidate dal microfono.

## Limitato
- **Playlist**: solo pubbliche o non in elenco; YouTube espone al massimo circa 200 video per playlist.
- **Brani non incorporabili**: alcuni proprietari non permettono la riproduzione fuori da YouTube (errori 101/150). L'app li segnala e consente di sostituirli a mano.
- **Testi**: dipendono dal database LRCLIB; un'esecuzione dal vivo o un remix può avere tempi diversi dall'originale (correggi con Anticipa/Ritarda).
- **Forme sul proiettore**: seguono il suono della stanza tramite il microfono, quindi reagiscono anche a voci e rumore. L'audio di sistema (loopback) non è supportato.
- **Windows**: vedi [VERIFICHE.md](VERIFICHE.md).

## Non disponibile con YouTube (e quindi non simulato)
| Funzione | Perché |
|---|---|
| BPM, beatmatching, tonalità | Servono i dati audio, che YouTube non fornisce |
| EQ di transizione sui bassi | L'audio dei player non è elaborabile |
| Limitatore dei picchi, gain automatico, loudness | Nessun accesso al segnale; il volume va solo da 0 a 100 |
| Forma d'onda e griglia dei battiti | Come sopra |
| **Rilevamento della pubblicità** | L'API non espone uno stato pubblicitario affidabile: l'app non dichiara di rilevarla. C'è il pulsante manuale **Abbassa volume** per deck |

## Mixaggio simultaneo: cosa è stato verificato
Prova su macOS (WKWebView, origine `http://localhost`): autoplay consentito, due player attivi insieme, volume regolabile con `setVolume`, nessun errore 153. Non verificato: sessioni continue di oltre ~10 minuti con entrambi i player attivi, e Windows (vedi VERIFICHE.md).

## Idee future (non implementate)
File audio locali con BPM e beatmatching, microfono vocale, effetti, mixer hardware.
