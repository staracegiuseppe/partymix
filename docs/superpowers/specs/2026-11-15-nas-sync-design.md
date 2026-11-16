# PartyMix — Libreria personale sincronizzata sul NAS (design, fase 1)

Data: 2026-11-15 · Stato: **bozza da approvare** prima di scrivere codice.

## 1. Architettura attuale

```
PartyMix (una sola app Tauri 2: Rust + Vite/TypeScript, nessun server)
├── src-tauri/ (Rust)
│   ├── lib.rs        comandi: http_get, lib_write/read/delete/root, proiettore, feedback…
│   ├── download/     Download Manager (yt-dlp): coda, jobs.json, validazione URL
│   └── capture.rs    cattura audio (solo desktop)
└── src/ (TypeScript, la UI gira in WebView su http://localhost:9527)
    ├── library/playlists.ts   PlaylistStore: playlist illimitate in IndexedDB (una chiave per playlist)
    ├── library/library.ts     MusicLibrary: LibEntry, import file, id `local:<hash parziale>`
    ├── library/blobStore.ts   file su disco (Musica/PartyMix Library) o IndexedDB nel browser
    ├── audioDeck.ts           HybridDeck: file locale oppure YouTube
    ├── download/              client del Download Manager
    └── ui/                    desktop (desktopPages.ts, desktop.css) e telefono (material.ts)
```

Fatti rilevanti:
- **Tutto è locale al dispositivo.** Playlist in IndexedDB, file in `~/Music/PartyMix Library`. Nessun concetto di utente, dispositivo, versione o server.
- `Playlist` ha `id`, `updatedAt`, `tracks: Track[]` ma **niente `version`/`updatedBy`** e le righe non hanno un id proprio (lo stesso brano due volte non si distingue).
- `Track.videoId` è un id YouTube oppure `local:<hash>`; l'hash è **parziale** (primo MB + ultimi 64 kB + dimensione, troncato a 96 bit): veloce, ma non è uno SHA‑256 del file intero.
- Il telefono (Android, UI Material) è lo **stesso codice** con un'altra shell. Regola dell'utente: *non toccare l'app telefono*. → vedi domande aperte.
- Android: `network_security_config` permette HTTP in chiaro solo verso localhost; per parlare col NAS in LAN va esteso.
- Lo stack è TypeScript + Rust. **Niente Python** nel progetto: FastAPI/SQLAlchemy non vanno introdotti.

## 2. Architettura proposta

```
                 ┌──────────────── NAS (Docker) ────────────────┐
                 │  partymix-server  (Node 22 + TypeScript)      │
                 │   • API REST /api/…   • SSE /api/events       │
                 │   • SQLite (database/partymix.sqlite)         │
                 │   • file in /PartyMix/music/…                 │
                 └───────────────▲───────────────▲───────────────┘
                     LAN / VPN   │               │   LAN / VPN
             ┌───────────────────┴──┐       ┌────┴──────────────────┐
             │ PartyMix desktop     │       │ PartyMix telefono      │
             │ SyncClient (TS)      │       │ SyncClient (stesso TS) │
             │ coda modifiche       │       │ coda modifiche         │
             │ cache locale (IDB)   │       │ cache + file offline   │
             └──────────────────────┘       └────────────────────────┘
```

Scelte motivate:
- **Server in TypeScript (Node 22)**, non Rust né Python: la logica di merge delle playlist, i tipi `Playlist`/`Track` e i test (vitest) sono **condivisi** tra server e client in una cartella `shared/`. Un merge scritto due volte in due linguaggi divergerebbe. Node 22 ha `node:sqlite` integrato → zero dipendenze native nell'immagine Docker.
- **SSE invece di WebSocket**: le notifiche vanno solo server → client; SSE è HTTP normale, si riconnette da solo, nessuna libreria.
- **Il NAS è la verità**; i client tengono una cache e una coda di modifiche (offline-first). Nessun peer‑to‑peer.
- **Solo LAN per default.** Il container ascolta sulla LAN; nessun UPnP, nessuna porta aperta sul router. Fuori casa: Tailscale/WireGuard (documentato, non automatico).

## 3. Componenti da riutilizzare

| Componente | Uso |
|---|---|
| `PlaylistStore` (IndexedDB) | diventa la **cache locale** delle playlist del NAS |
| `MusicLibrary` + `id3.ts` | lettura metadata/copertine prima dell'upload |
| `NativeBlobStore` + `lib_write/lib_read` | file offline sul telefono e libreria PC |
| `HybridDeck` / protocollo asset | riproduzione: file locale → stream NAS → YouTube |
| Download Manager | invariato; un brano scaricato finisce in libreria e quindi può salire sul NAS |
| `validate.rs` | stesso controllo "solo reti private" per l'indirizzo del NAS |

## 4. Componenti da modificare

| File | Modifica |
|---|---|
| `library/playlists.ts` | campi `version`, `updatedBy`, `serverId`; righe con `entryId`; ogni modifica genera anche un'**operazione** nella coda di sync |
| `library/library.ts` | `sha256` completo (calcolato in Rust per i file grandi), stato NAS per brano (☁ ✓ ⬇ ⚠) |
| `audioDeck.ts` | nuova sorgente `nas` (URL di stream firmato) |
| `src-tauri/src/lib.rs` | comando `file_sha256`, `disk_free`; upload a pezzi letto da disco senza passare il file in JS |
| `ui/desktopPages.ts` | pagine **☁ Sync** e **📱 Dispositivi**, badge stato brano |
| Android `network_security_config.xml` | HTTP in chiaro consentito verso reti private (192.168/16, 10/8, 172.16/12, 100.64/10 Tailscale) |
| `ui/material.ts` (telefono) | **solo se approvato**: voci NAS / Offline (vedi domande) |

## 5. Componenti nuovi

```
server/                         partymix-server (Docker)
  src/http.ts                   router node:http, auth middleware, Range
  src/db.ts  migrations/        SQLite
  src/routes/{auth,library,tracks,playlists,sync,devices,storage}.ts
  src/events.ts                 SSE
  Dockerfile  docker-compose.yml
shared/                         codice comune client/server
  model.ts                      tipi Playlist, Entry, Track, Op
  merge.ts                      applicazione operazioni + merge a 3 vie
src/sync/
  client.ts                     REST + SSE, token, riconnessione
  outbox.ts                     coda modifiche persistente (IndexedDB)
  engine.ts                     pull incrementale, push, upload, offline
src/ui/syncPage.ts devicesPage.ts conflictDialog.ts
```

## 6. Schema database (SQLite)

```sql
user        (id PK, name, pass_hash /*scrypt*/, created_at)
device      (id PK, user_id FK, name, kind /*pc|android|ios*/, token_hash, perms /*bitmask*/,
             created_at, last_seen, revoked_at)
artist      (id PK, name UNIQUE COLLATE NOCASE)
album       (id PK, artist_id FK, title, year, cover_sha256)
track       (id PK /*= sha256 del file*/, title, artist_id FK, album_id FK, genre, year, track_no,
             duration_sec, size, mime, path /*relativo a music/*/, cover_sha256,
             youtube_id NULL, added_by FK device, added_at, meta_version, deleted_at NULL, seq)
playlist    (id PK /*uuid*/, name, description, color, cover, sort_order, version INT,
             updated_at, updated_by FK device, deleted_at NULL, seq)
playlist_entry (playlist_id FK, entry_id /*uuid*/, pos REAL /*ordinamento frazionario*/,
             track_id NULL, youtube_id NULL, title, artist, thumb, duration_sec, PRIMARY KEY(playlist_id, entry_id))
playlist_rev (playlist_id, version, snapshot_json, device_id, at)   -- ultime 30 versioni: base del merge + "annulla"
download    (device_id, track_id, state, at, PRIMARY KEY(device_id, track_id))  -- brani offline per dispositivo
sync_job    (id PK, device_id, kind /*upload|offline*/, state, done, total, bytes, error, updated_at)
upload      (id PK, device_id, sha256, size, received, tmp_path, created_at)    -- upload ripresi
change_log  (seq PK AUTOINCREMENT, kind /*track|playlist|device*/, ref_id, at)
```
Indici: `track(seq)`, `playlist(seq)`, `track(artist_id)`, `track(title COLLATE NOCASE)`, `playlist_entry(playlist_id,pos)`.
Una playlist referenzia i brani, **mai** copia il file: un MP3 esiste una volta sola in `music/`.
Le righe possono essere brani YouTube (`youtube_id`, nessun file): così le playlist attuali si sincronizzano tutte, e lo streaming dal NAS vale per i brani con file.

## 7. API

Autenticazione: `Authorization: Bearer <token dispositivo>` (token casuale 256 bit, sul server solo l'hash).

```
POST   /api/auth/setup                 primo avvio: crea l'utente (solo se non esiste)
POST   /api/auth/login                 nome+password → token per questo dispositivo (con nome/tipo)
POST   /api/auth/pair                  codice a 6 cifre generato da un dispositivo già autorizzato (scade in 5 min)
POST   /api/auth/logout

GET    /api/library?cursor=&limit=200&q=      paginata, mai l'intera libreria
GET    /api/tracks/{id}
POST   /api/tracks/check               {sha256[]} → quali mancano (evita duplicati prima dell'upload)
POST   /api/tracks/upload              apre un upload {sha256,size,meta} → uploadId
PUT    /api/uploads/{id}               pezzi con Content-Range (ripresa dopo interruzione); alla fine verifica sha256
GET    /api/tracks/{id}/stream         Range/206; accetta header o ?sig= firmato breve (vedi §9)
GET    /api/tracks/{id}/cover
PATCH  /api/tracks/{id}                solo metadata (non ritrasferisce l'audio)
DELETE /api/tracks/{id}                permesso DELETE_TRACK

GET    /api/playlists                   elenco leggero (id, nome, version, conteggio)
GET    /api/playlists/{id}
POST   /api/playlists
POST   /api/playlists/{id}/ops         {baseVersion, ops[]} → {version, merged, conflicts[]}
PUT    /api/playlists/{id}             sostituzione intera (risoluzione conflitto "usa questa")
DELETE /api/playlists/{id}             tombstone (recuperabile da playlist_rev)
POST   /api/playlists/{id}/tracks      scorciatoia = op add
DELETE /api/playlists/{id}/tracks/{entryId}

GET    /api/sync/changes?since=seq&limit=500   delta incrementale + tombstone
GET    /api/sync/status                 seq attuale, brani, playlist, ultima sync del dispositivo
GET    /api/events                      SSE: {seq, kind, id, summary:"+3 brani"}
POST   /api/tracks/{id}/offline         segna offline per questo dispositivo (smart download)
DELETE /api/tracks/{id}/offline

GET    /api/devices    PATCH /api/devices/{id} (rinomina, permessi)    DELETE /api/devices/{id} (revoca)
GET    /api/storage                     spazio musica / libero sul volume
```
Permessi (bitmask per dispositivo): `READ_LIBRARY, PLAY_TRACK, DOWNLOAD_TRACK, EDIT_PLAYLIST, UPLOAD_TRACK, DELETE_TRACK, ADMIN`. Default: PC = tutti, telefono = tutti tranne `DELETE_TRACK`/`ADMIN`.

## 8. Struttura directory NAS

```
/PartyMix/                       (volume montato nel container)
├── music/Artist/Album/NN Title.ext      nome leggibile; l'identità è lo sha256 nel DB, non il nome
├── covers/<sha256>.jpg                  una copertina per album/brano, deduplicata
├── playlists/<id>.json                  copia leggibile scritta a ogni versione (backup / ispezione)
├── metadata/                            export JSON periodico della libreria
├── database/partymix.sqlite (+ -wal)
└── cache/uploads/                       upload in corso (ripulita all'avvio)
```
Il backup del NAS copre tutto; nessun dato vive solo nel container.

## 9. Strategia di sincronizzazione

**Playlist — operazioni, non copie del file.** Ogni modifica locale produce operazioni:
`add(entryId, track, afterEntryId)`, `remove(entryId)`, `move(entryId, afterEntryId)`, `set(field, value)`.
Il client le spedisce con la `baseVersion` su cui le ha fatte.
- Se `baseVersion == version` sul server → applica, `version+1`, `updatedBy`, `updatedAt`.
- Se il server è più avanti → **merge**: rigioca le operazioni del client sulla versione corrente. Aggiunte e rimozioni di righe diverse si sommano sempre; uno spostamento di una riga già spostata dall'altro dispositivo vince l'ultimo; un'aggiunta "dopo X" con X rimosso finisce dopo il predecessore di X.
- **Conflitto vero** (chiesto all'utente, finestra «Usa PC / Usa Smartphone»): stesso campo (`name`, `description`) cambiato in modo diverso; playlist eliminata da uno e modificata dall'altro; rimozione di una riga che l'altro ha appena aggiunto/modificato.
- Nulla si perde in silenzio: ogni versione finisce in `playlist_rev` (ultime 30) → "Ripristina versione precedente".
- Esempio §31 (PC: A B C; telefono offline: A D C = rimuovi B + aggiungi D dopo A): se intanto il PC ha aggiunto E, il risultato è A D C E — entrambe le modifiche preservate.

**Libreria — delta.** Ogni scrittura su `track`/`playlist` incrementa `change_log.seq`. Il client salva l'ultimo `seq` visto e chiede `/sync/changes?since=` (pagine da 500): con 10 000 brani di cui 20 nuovi passano 20 righe. SSE avvisa "c'è un seq nuovo"; senza SSE, polling ogni 60 s solo quando l'app è in primo piano.

**File — upload dal PC.** Import di un MP3 → Rust calcola lo SHA‑256 leggendo il file a blocchi → `POST /tracks/check` → se esiste: si collega e basta (niente duplicato) → altrimenti upload a pezzi da 4 MB con ripresa → il server ricalcola l'hash; se non combacia il file è **corrotto** e viene scartato → scrive in `music/…`, salva metadata/copertina, `seq++` → gli altri dispositivi lo vedono. Stati mostrati: ✓ Disponibile sul NAS · ⬆ In sincronizzazione · ⚠ Mancante.
I brani YouTube restano righe YouTube; i brani del Download Manager sono file e salgono come gli altri.

**Streaming.** `GET /tracks/{id}/stream` con Range (206) → play immediato, seek, pausa. `<audio>` non può mandare header, quindi il client chiede un **URL firmato breve** (`?sig=` HMAC su dispositivo+brano, scade in 15 min, rifiutato se il dispositivo è revocato). Non è un URL pubblico permanente; nessuna cartella `music/` servita direttamente, nessun directory listing.

**Sicurezza di trasporto.** In LAN: HTTP con token (rete privata). Fuori casa: solo via VPN (Tailscale/WireGuard); con Tailscale si può avere HTTPS con certificato valido (`tailscale serve`). Il client rifiuta indirizzi pubblici del NAS senza HTTPS.

## 10. Strategia offline

- Il telefono tiene in IndexedDB: playlist, metadata della libreria vista, coda operazioni (`outbox`), `lastSeq`.
- Senza NAS: tutto resta navigabile; si suonano i brani **✓ Offline**; i brani ☁ appaiono grigi (⚠ non disponibile ora).
- Modifiche offline → `outbox` ("Modifiche in attesa: N"); al ritorno del NAS: prima push delle operazioni (merge sul server), poi pull dei delta.
- **Scarica playlist offline**: calcola i byte mancanti, controlla lo spazio libero (comando Rust `disk_free`) **prima** di iniziare, scarica 2 brani alla volta con ripresa, mostra `47/124 · 128 MB / 420 MB`. File in `PartyMix Library/offline/<sha256>.<ext>` via `NativeBlobStore`.
- **Download automatico** (opzionale, per playlist): quando arriva un delta che aggiunge brani a una playlist marcata, si accodano i download (solo su Wi‑Fi).
- Stato per brano: ☁ NAS · ✓ Offline · ⬇ 72% · ⚠ Non disponibile.
- Rimuovere dall'offline cancella solo la copia sul telefono.

## Piano a fasi (dopo l'approvazione)

| Fase | Contenuto | Verifica |
|---|---|---|
| 2–3 | `server/` + `shared/`, SQLite, auth, dispositivi, Docker Compose | test API (vitest + server in memoria), container su Mac |
| 4 | playlist: ops, version, SSE; client desktop + outbox | test PC→NAS→PC2 |
| 5 | upload/dedup/hash, `file_sha256` in Rust | test duplicato, corrotto, ripresa |
| 6 | streaming Range + URL firmato, sorgente `nas` in HybridDeck | test play/seek/206 |
| 7–8 | telefono: NAS + offline (secondo la risposta sotto) | APK sul Realme |
| 9–10 | merge a 3 vie + finestra conflitti | test conflitti §31 |
| 11 | permessi, revoca, abbinamento con codice | test 401/403 |
| 12–13 | pagine Sync/Dispositivi, test completi, guida | browser + app |

## Decisioni dell'utente (2026-11-15)

1. NAS **Synology con Docker** (Container Manager) → distribuzione con `docker-compose.yml`, volume `/volume1/PartyMix` montato su `/PartyMix`.
2. Telefono: **aggiungere sezioni** NAS/Offline e stato dei brani; le schermate esistenti restano come sono.
3. Le modifiche non committate vanno committate su `main`, poi si lavora sul ramo `nas-sync`.

## Domande aperte (chiuse, vedi sopra)

1. **Che NAS è** (marca/modello o sistema: Synology DSM, QNAP, Unraid, TrueNAS, un PC Linux…) e ha **Docker / Container Manager**? Se no, il server gira come binario Node o come servizio sul Mac.
2. **App telefono**: la regola attuale è "non toccarla". Questa funzione richiede di aggiungerle almeno NAS + Offline. Va bene aggiungere sezioni nuove lasciando invariate quelle esistenti?
3. **Repository**: in `partymix-ai` ci sono 17 file modificati non committati (lavoro precedente). Si committano prima, o lavoro su un ramo nuovo lasciandoli lì?
