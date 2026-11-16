# Installazione e aggiornamento

Gli installer **non sono firmati** (la firma richiede un account sviluppatore a pagamento): al primo avvio il sistema mostra un avviso. È normale; ecco come procedere.

## macOS
1. Apri il file `PartyMix_x.y.z_*.dmg` e trascina **PartyMix** in *Applicazioni*.
2. Primo avvio: **clic destro sull'app → Apri → Apri**. Se macOS dice che l'app è "danneggiata", apri il Terminale ed esegui:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/PartyMix.app"
   ```
3. Alla prima apertura del proiettore macOS chiede il permesso per il **microfono**: consentilo (serve solo a far muovere le forme).

## Windows 10/11
1. Estrai lo zip `PartyMix_x.y.z_windows-x64.zip` dove vuoi (ad esempio sul Desktop) e fai doppio clic su `PartyMix.exe`: è una versione portabile, non serve installare nulla.
2. Se compare **SmartScreen** ("Windows ha protetto il PC"): **Ulteriori informazioni → Esegui comunque**.
3. Windows può chiedere il permesso per il microfono: consentilo.
4. Serve *Microsoft Edge WebView2* (già presente su Windows 11 e sui Windows 10 aggiornati; l'installer lo scarica se manca).

> Lo stato di verifica su Windows è nel [registro delle verifiche](VERIFICHE.md).

## Linux

Per computer x86_64 (64 bit Intel/AMD) con Ubuntu 22.04 o successivo, Debian 12, Fedora, Mint e simili.

- **AppImage** (`PartyMix_x.y.z_linux-x86_64.AppImage`), non si installa nulla:
  1. Scaricalo e rendilo eseguibile: tasto destro → *Proprietà → Permessi → Consenti l'esecuzione*, oppure `chmod +x PartyMix_*.AppImage`.
  2. Aprilo con un doppio clic (o `./PartyMix_*.AppImage` dal terminale).
  3. Se non parte e dice che manca **FUSE**: Fedora `sudo dnf install fuse-libs`; Ubuntu `sudo apt install libfuse2` (su Ubuntu 24.04 `libfuse2t64`).
- **.rpm** (`PartyMix_x.y.z_linux-x86_64.rpm`), per **Fedora** (e RHEL, Rocky, openSUSE): `sudo dnf install ./PartyMix_*.rpm`. Usa WebKitGTK di Fedora e installa da solo i plugin di GStreamer per i video. Si toglie con `sudo dnf remove party-mix`.
- **.deb** (`PartyMix_x.y.z_linux-amd64.deb`), per Ubuntu e Debian: `sudo apt install ./PartyMix_*.deb`. PartyMix compare tra le applicazioni, nella categoria Audio/Musica. Si toglie con `sudo apt remove party-mix`.

I video di YouTube passano da GStreamer. L'AppImage lo porta con sé; il .rpm e il .deb installano i plugin che servono (Fedora: `gstreamer1-plugins-good`, `gstreamer1-plugins-bad-free`; Ubuntu/Debian: `gstreamer1.0-plugins-good`, `-bad`, `gstreamer1.0-libav`). Se i brani restano fermi, su Fedora aggiungi anche `gstreamer1-plugin-openh264` (oppure `gstreamer1-libav` da RPM Fusion).

Se la finestra resta **bianca o vuota** (succede con alcune schede video, soprattutto NVIDIA, su Wayland), avvia PartyMix così: `WEBKIT_DISABLE_DMABUF_RENDERER=1 partymix-ai` (con l'AppImage: `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./PartyMix_*.AppImage`).

Il proiettore è fatto per andare a tutto schermo sul monitor scelto anche con Wayland (GNOME, KDE). Il microfono del proiettore usa quello predefinito di sistema, che puoi cambiare dalle impostazioni audio.

> Linux non è ancora stato provato su un computer vero: se qualcosa non va, scrivimi da 💬 Commenti.

## Android
1. Scarica `PartyMix_x.y.z_android.apk` sul telefono (Android 7 o successivo) e aprilo.
2. Se Android lo chiede, consenti a quell'app (browser o file) di **installare app sconosciute**, poi **Installa**.
3. Play Protect può dire che l'app non è conosciuta: **Installa comunque**.
4. Per il proiettore: **Apri proiettore** apre le impostazioni *Trasmetti / Schermo wireless* del telefono; scegli la TV o il proiettore e il proiettore di PartyMix compare lì. Serve un televisore o proiettore che riceva lo *schermo wireless* (Miracast; su molti Android TV con app come AirScreen). Un Chromecast che copia soltanto lo schermo del telefono mostra la console, non il proiettore.

## Il server per il NAS

Facoltativo: serve solo se vuoi la stessa musica e le stesse playlist su tutti i dispositivi (vedi [GUIDA › Il NAS di casa](GUIDA.md#11-il-nas-di-casa)). Il server è il file `partymix-server-nas.zip` nella pagina Release. Non ha bisogno di internet e non va aperta nessuna porta sul router.

### Synology senza Docker (per esempio i modelli «j»)

1. **Centro pacchetti** → installa **Node.js v18** (o più recente).
2. **File Station** → crea la cartella condivisa **PartyMix** (la musica e il database vanno lì) e una cartella `docker/partymix` (o un'altra a tua scelta) per il programma.
3. Copia `partymix-server-nas.zip` in `docker/partymix`, clic destro → **Estrai qui**. Deve comparire la cartella `server`.
4. **Pannello di controllo → Utilità di pianificazione → Crea → Attività attivata → Script definito dall'utente**:
   - Utente: il tuo utente (quello che può scrivere in PartyMix), Evento: **Avvio**.
   - Esegui comando: `sh /volume1/docker/partymix/server/nas/partymix.sh` (con il tuo volume: `volume1`, `volume2`…). Se la cartella PartyMix non è su `/volume1`, aggiungi davanti `PARTYMIX_ROOT=/volume2/PartyMix `.
5. Seleziona l'attività e premi **Esegui** (poi partirà da sola a ogni accensione).
6. Da un browser di casa apri `http://IP-DEL-NAS:8788/api/health`: deve rispondere `{"app":"partymix",…}`. Il registro è in `PartyMix/server.log`.

**Aggiornare il server:** estrai il nuovo zip sopra il vecchio (sovrascrivi) e premi di nuovo **Esegui**: lo script ferma la copia vecchia e avvia la nuova. Database e musica restano.

### NAS con Docker (Synology Container Manager, QNAP, Unraid…)

Nel repository c'è `server/docker-compose.yml`: crea un progetto con quel file, il volume `/volume1/PartyMix` viene montato su `/PartyMix`. Dettagli in [server/README.md](../server/README.md).

### Fuori casa

Il server risponde solo alla rete di casa e alle VPN private. Per usarlo fuori casa installa **Tailscale** (pacchetto ufficiale Synology) sul NAS e sul telefono.

## Aggiornamento
Scarica il nuovo installer e installalo sopra quello vecchio: impostazioni e playlist restano. Non c'è aggiornamento automatico.

## Se qualcosa non va
- *"Non riesco ad avviare i player YouTube"*: controlla la connessione e riavvia l'app.
- *Un brano è sbarrato nella coda*: YouTube non ne consente la riproduzione incorporata; usa l'avviso a destra per sostituirlo.
- *Il proiettore dice "Microfono non disponibile"*: concedi il permesso nelle impostazioni di privacy del sistema oppure scegli un altro microfono dalla console: Proiettore → **🎤 Microfono** → **🔄 Cerca microfoni**.
