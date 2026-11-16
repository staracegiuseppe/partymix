<p align="center"><img src="img/icon.png" alt="" width="80"></p>

<h1 align="center">PartyMix sul NAS di casa</h1>

<p align="center">Guida passo passo per installare il server di PartyMix su un NAS (Synology, QNAP, Unraid, TrueNAS…) o su un qualsiasi computer Linux sempre acceso in casa.</p>

Con il server sul NAS, **tutti i tuoi dispositivi** (computer e telefoni) hanno la stessa musica e le stesse playlist, aggiornate in tempo reale. Cosa si fa poi nell'app è spiegato in [GUIDA › Il NAS di casa](GUIDA.md#11-il-nas-di-casa).

- [Cosa serve](#cosa-serve)
- [Passo 1 · Scarica il server](#passo-1--scarica-il-server)
- [Passo 2 · Crea la cartella per la musica](#passo-2--crea-la-cartella-per-la-musica)
- [Passo 3 · Installa e avvia il server](#passo-3--installa-e-avvia-il-server)
  - [A. Synology senza Docker (Node.js dal Centro pacchetti)](#a-synology-senza-docker)
  - [B. Qualsiasi NAS con Docker](#b-qualsiasi-nas-con-docker)
  - [C. Linux con Node.js (Raspberry Pi, mini PC, QNAP con Node…)](#c-linux-con-nodejs)
- [Passo 4 · Controlla che risponda](#passo-4--controlla-che-risponda)
- [Passo 5 · Collega l'app](#passo-5--collega-lapp)
- [Chi può entrare](#chi-può-entrare)
- [Aggiornare, fare il backup, fuori casa](#aggiornare-fare-il-backup-fuori-casa)
- [Se qualcosa non va](#se-qualcosa-non-va)
- [Impostazioni del server](#impostazioni-del-server)

## Cosa serve

- Un NAS o un computer Linux **sempre acceso**, nella stessa rete di casa dei dispositivi.
- **Node.js 18 o più recente**, *oppure* **Docker**. Il server non ha altre dipendenze e usa poca memoria (gira anche su un Synology DS215j).
- Una **cartella** dove tenere musica, playlist e database. Lo spazio dipende da quanta musica carichi.
- **Nessuna porta da aprire sul router.** Il server risponde solo alla rete di casa e alle VPN private.

## Passo 1 · Scarica il server

Dalla pagina [Release](https://github.com/staracegiuseppe/partymix/releases/latest) scarica **`partymix-server-nas.zip`**. Dentro c'è la cartella `server` con:

| File | A cosa serve |
|---|---|
| `server/dist/…` | Il programma, pronto per Node.js 18+ |
| `server/nas/partymix.sh` | Lo script di avvio per NAS senza Docker (vedi sotto) |
| `server/docker-compose.yml`, `server/Dockerfile` | Per chi usa Docker |

## Passo 2 · Crea la cartella per la musica

Crea una cartella chiamata **PartyMix**. Sul Synology: **File Station → Crea → Crea nuova cartella condivisa → PartyMix**. Il server ci mette dentro da solo:

```
PartyMix/
├── music/        i brani (Artista/Album/NN Titolo.mp3)
├── playlists/    una copia leggibile di ogni playlist
├── covers/       le copertine
├── database/     il database
├── cache/        caricamenti in corso (si pulisce da solo)
└── server.log    il registro del server
```

L'utente che fa girare il server deve poter **scrivere** in questa cartella.

## Passo 3 · Installa e avvia il server

Scegli **una** delle tre strade.

### A. Synology senza Docker

È la strada per i Synology che non hanno Container Manager (per esempio i modelli «j» e «play»).

1. **Centro pacchetti** → cerca **Node.js** → installa **Node.js v18** (o una versione più recente).
2. **File Station** → crea una cartella per il programma, per esempio `docker/partymix` (dentro una cartella condivisa qualsiasi).
3. Copia lì `partymix-server-nas.zip`, poi clic destro → **Estrai → Estrai qui**. Deve comparire la cartella `server`.
4. **Pannello di controllo → Utilità di pianificazione → Crea → Attività attivata → Script definito dall'utente**:
   - **Generale:** nome `PartyMix server`, utente: il tuo utente (deve poter scrivere nella cartella PartyMix), evento: **Avvio**.
   - **Impostazioni attività → Esegui comando:**

     ```sh
     sh /volume1/docker/partymix/server/nas/partymix.sh
     ```

     Usa il percorso vero: il volume (`volume1`, `volume2`…) e la cartella del punto 2. In File Station lo trovi con clic destro sulla cartella → **Proprietà → Posizione**.
5. Seleziona l'attività e premi **Esegui**. Da ora parte da sola a ogni accensione del NAS.

Lo script, già dentro lo zip, fa questo:

```sh
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# la cartella della musica: la prima /volume*/PartyMix che trova (oppure quella in PARTYMIX_ROOT)
if [ -z "$PARTYMIX_ROOT" ]; then
  for d in /volume*/PartyMix; do [ -d "$d" ] && PARTYMIX_ROOT="$d" && break; done
fi
ROOT="${PARTYMIX_ROOT:-/volume1/PartyMix}"
PORT="${PORT:-8788}"
# Node.js: quello del Centro pacchetti Synology, altrimenti quello installato nel sistema
[ -n "$NODE" ] || NODE="$(ls /var/packages/Node.js_v*/target/usr/local/bin/node 2>/dev/null | sort -V | tail -1)"
[ -x "$NODE" ] || NODE="$(command -v node)"
# una copia sola: ferma quella vecchia (aggiornamento, o attività eseguita di nuovo) e aspetta che la porta si liberi
PIDFILE="$ROOT/server.pid"
[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
pkill -f "dist/server/src/main.js"
# … poi avvia il server in background, con il registro in PartyMix/server.log
PARTYMIX_ROOT="$ROOT" PORT="$PORT" HOST=0.0.0.0 nohup "$NODE" --max-old-space-size=160 "$DIR/dist/server/src/main.js" >> "$ROOT/server.log" 2>&1 &
echo $! > "$PIDFILE"
```

Per cambiare cartella o porta, mettili prima del comando nell'attività:

```sh
PARTYMIX_ROOT=/volume2/Musica/PartyMix PORT=8790 sh /volume1/docker/partymix/server/nas/partymix.sh
```

### B. Qualsiasi NAS con Docker

Synology (Container Manager), QNAP (Container Station), Unraid, TrueNAS SCALE, Portainer o un Linux con Docker.

1. Copia nel NAS anche la cartella `shared` del repository, accanto a `server` (servono entrambe per costruire l'immagine). In alternativa scarica tutto il repository da GitHub: **Code → Download ZIP**.
2. Apri `server/docker-compose.yml` e cambia le righe segnate con **←**:
   - `user:` l'utente del NAS proprietario della cartella PartyMix, come `uid:gid`. Via SSH: `id nomeutente`.
   - il volume: la cartella PartyMix del passo 2 (Synology `/volume1/PartyMix`, QNAP `/share/PartyMix`, Unraid `/mnt/user/PartyMix`).
   - **Solo Synology:** lascia `PARTYMIX_DSM_URL`, `PARTYMIX_GROUP_FILE` e il volume `/etc/group`, così gli utenti del NAS entrano con la loro password. Sugli altri NAS togli quelle righe.
3. Crea il progetto:
   - **Synology:** Container Manager → **Progetto → Crea** → percorso della cartella `server` → «usa il docker-compose.yml esistente».
   - **Altri:** dalla cartella `server`: `docker compose up -d --build`.

### C. Linux con Node.js

Per un Raspberry Pi, un mini PC, un QNAP con Node.js o qualsiasi Linux.

1. Installa Node.js 18 o più recente (`node -v` per controllare).
2. Estrai `partymix-server-nas.zip`, per esempio in `/opt/partymix`.
3. Avvialo a ogni accensione. Con **systemd** crea `/etc/systemd/system/partymix.service`:

   ```ini
   [Unit]
   Description=PartyMix server
   After=network-online.target

   [Service]
   User=musica
   Environment=PARTYMIX_ROOT=/srv/PartyMix
   Environment=PORT=8788
   WorkingDirectory=/opt/partymix/server
   ExecStart=/usr/bin/node --max-old-space-size=160 dist/server/src/main.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   poi `sudo systemctl enable --now partymix`. Senza systemd va bene anche lo script `server/nas/partymix.sh` da `cron` con `@reboot`.

## Passo 4 · Controlla che risponda

Da un browser di casa apri **`http://IP-DEL-NAS:8788/api/health`** (l'IP del NAS lo trovi nelle impostazioni di rete del NAS o del router). Deve rispondere:

```json
{"app":"partymix","version":"1.1.0","setup":false,"nasUsers":true}
```

- `setup: false` = nessun account ancora: lo crei dall'app al passo 5.
- `nasUsers: true` = Synology: gli utenti del NAS possono entrare con la loro password (vedi [Chi può entrare](#chi-può-entrare)).

Se la pagina non si apre, guarda il registro **`PartyMix/server.log`** e la sezione [Se qualcosa non va](#se-qualcosa-non-va).

## Passo 5 · Collega l'app

In PartyMix, sul computer o sul telefono: **⚙ Impostazioni → NAS e sincronizzazione** (sul telefono: **⋮ Altro › Impostazioni**).

1. Scrivi l'indirizzo del NAS, per esempio `192.168.1.10` (la porta 8788 si aggiunge da sola), e premi **Controlla**.
2. Accedi:
   - **Synology:** con il tuo nome utente e la tua password del NAS.
   - **Altri NAS, la prima volta:** crea l'account di PartyMix (nome e password). Gli altri dispositivi entrano con lo stesso nome e la stessa password.
   - **Oppure, da qualunque dispositivo:** con il **codice a 6 cifre** che trovi su un dispositivo già collegato, in **Impostazioni → Dispositivi → + Aggiungi dispositivo** (vale 5 minuti).
3. **Android 17:** il telefono chiede il permesso **«Dispositivi nelle vicinanze / rete locale»**: rispondi **Consenti**. Senza, l'app non vede il NAS.

## Chi può entrare

**Synology:** **tutti gli utenti del NAS** entrano con il loro nome e la loro password di DSM. PartyMix chiede a DSM, sul NAS stesso, se la password è giusta, e non la salva. Musica e playlist sono **in comune** per tutta la casa.

| Utente | Cosa può fare |
|---|---|
| Nel gruppo **administrators** di DSM | Tutto: anche togliere brani dal NAS e gestire o revocare i dispositivi di tutti |
| Gli altri utenti | Ascoltare, caricare brani, creare e modificare le playlist, collegare i propri dispositivi |

Un utente che non può usare il desktop di DSM entra lo stesso, se può usare almeno una di queste app: **File Station, Audio Station, Video Station o Download Station**. Se non ne ha nessuna, PartyMix lo dice: in **DSM → Pannello di controllo → Privilegi applicazione** concedigli File Station.

Un utente con la **verifica in due passaggi** di DSM entra con il codice a 6 cifre da un dispositivo già collegato.

**Altri NAS:** c'è un account PartyMix, creato la prima volta, che vale per tutta la casa. Ogni dispositivo ha però una chiave sua.

**Sempre:** in **Impostazioni → Dispositivi** vedi chi è collegato e puoi **revocare** un dispositivo. Da quel momento non legge più niente, nemmeno i link di ascolto già dati.

## Aggiornare, fare il backup, fuori casa

- **Aggiornare (Synology senza Docker):** estrai il nuovo `partymix-server-nas.zip` sopra il vecchio (sovrascrivi), poi **Utilità di pianificazione → PartyMix server → Esegui**. Musica, playlist e account restano.
- **Aggiornare (Docker):** sostituisci i file e ricrea il progetto (`docker compose up -d --build`).
- **Backup:** basta copiare la cartella **PartyMix** (Synology: Hyper Backup). Per una copia sicura del database, ferma prima il server.
- **Fuori casa:** il server non risponde da internet, per scelta. Installa **Tailscale** (sul Synology c'è il pacchetto ufficiale) sul NAS e sul telefono: PartyMix lo riconosce come rete di casa.
- **File copiati a mano:** puoi mettere MP3 direttamente in `PartyMix/music` (File Station, cartella condivisa). Poi nell'app: **Libreria → ☁ Musica sul NAS → 🔄 Aggiorna dalla cartella music del NAS**. Il server li cerca anche a ogni avvio.

## Se qualcosa non va

| Cosa succede | Perché, e cosa fare |
|---|---|
| `…:8788/api/health` non si apre | Il server non è partito: leggi `PartyMix/server.log`. Su Synology controlla che l'attività sia stata **eseguita** e che Node.js sia installato. |
| Nel registro c'è `EADDRINUSE` | La porta 8788 è usata da un altro programma: scegline un'altra, per esempio `PORT=8790 sh …/partymix.sh`, e scrivi `IP:8790` nell'app. |
| Synology: «Nome o password sbagliati» con la password giusta | Controlla il nome utente (non l'indirizzo email). Il primo accesso può richiedere una decina di secondi su un NAS piccolo. |
| Synology: «…non può usare nessuna app del NAS» | DSM → Pannello di controllo → **Privilegi applicazione** → concedi **File Station** a quell'utente. |
| Nel registro: «DSM NON risponde» | Il server non raggiunge DSM sul NAS stesso. Senza Docker deve girare sul NAS; con Docker serve `network_mode: host` e `PARTYMIX_DSM_URL`. |
| Il telefono non si collega, il browser sì | Android 17: consenti **«Dispositivi nelle vicinanze / rete locale»** a PartyMix (Impostazioni del telefono → App → PartyMix → Autorizzazioni). |
| Un brano resta «⚠ Non riuscito» in Libreria | Il messaggio sotto il brano dice il motivo; **Riprova** lo rimanda. |
| «Spazio insufficiente» | Libera spazio sul NAS (o sul telefono, per le copie offline). |

## Impostazioni del server

Si passano come variabili d'ambiente (davanti al comando, nel `docker-compose.yml` o nel servizio systemd).

| Variabile | Predefinito | Cosa fa |
|---|---|---|
| `PARTYMIX_ROOT` | `/PartyMix` (lo script: la prima `/volume*/PartyMix`) | La cartella di musica, playlist e database |
| `PORT` | `8788` | La porta del server |
| `HOST` | `0.0.0.0` | L'indirizzo su cui ascolta |
| `PARTYMIX_ALLOW_PUBLIC` | `0` | `1` accetta anche indirizzi internet: **solo dietro una VPN o un proxy con HTTPS** |
| `PARTYMIX_DSM_URL` | su Synology `http://127.0.0.1:5000/webapi/entry.cgi` | Dove chiedere a DSM le password degli utenti del NAS |
| `PARTYMIX_DSM` | – | `0` spegne l'accesso con gli utenti del NAS |
| `PARTYMIX_GROUP_FILE` | `/etc/group` | Da dove leggere chi è nel gruppo administrators |
| `PARTYMIX_DB` | `auto` | `node:sqlite` (Node 22+) oppure `sql.js` (Node 18) |
