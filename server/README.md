# PartyMix server (NAS)

Il cuore della libreria personale PartyMix: playlist, brani, dispositivi autorizzati. Gira sul NAS, solo in rete di casa
(o via VPN). Design completo: `docs/superpowers/specs/2026-11-15-nas-sync-design.md`.

Stato: **fasi 2–3** (database, autenticazione, dispositivi, permessi, playlist con versione, modifiche incrementali,
eventi in tempo reale, spazio disco). Upload/streaming dei brani e merge delle modifiche arrivano nelle fasi successive.

## Installazione su Synology (Container Manager)

1. **File Station** → crea la cartella condivisa `PartyMix` (diventa `/volume1/PartyMix`).
2. Copia sul NAS le cartelle `server/` e `shared/` di questo repository dentro una cartella, per esempio
   `/volume1/docker/partymix/` (devono stare una accanto all'altra).
3. In `server/docker-compose.yml` imposta `user:` con l'utente del NAS che possiede `/volume1/PartyMix`
   (via SSH: `id nomeutente` → `uid:gid`).
4. **Container Manager → Progetto → Crea**, percorso `/volume1/docker/partymix/server`, usa il `docker-compose.yml` esistente.
5. Controlla: `http://IP-DEL-NAS:8788/api/health` (porta scelta in `docker-compose.yml`, `PORT`) deve rispondere `{"app":"partymix",…}`.
6. Dall'app PartyMix sul PC: **☁ Sync → Collega il NAS** (arriva nella fase 4) crea l'account e autorizza il PC.
   Gli altri dispositivi si aggiungono con il codice a 6 cifre mostrato in **📱 Dispositivi**.

## Sicurezza

- Nessuna porta va aperta sul router. Il server rifiuta da solo gli indirizzi internet (`PARTYMIX_ALLOW_PUBLIC=0`).
- Fuori casa: Tailscale (pacchetto ufficiale Synology) o WireGuard. Gli indirizzi Tailscale (100.64.0.0/10) sono accettati.
- Password salvata con scrypt; ogni dispositivo ha un token suo (sul NAS solo l'hash), revocabile.
- I file musicali non sono serviti come cartella: solo tramite API autenticate.

## Backup

Basta fare il backup di `/volume1/PartyMix` (Hyper Backup): `database/`, `playlists/` (copie JSON leggibili),
`metadata/`, `covers/`, `music/`. Per una copia coerente del database fermare il container o usare lo snapshot del volume.

## Sviluppo

```bash
cd server
PARTYMIX_ROOT=/tmp/partymix PORT=8787 npm start
npm test
```

Serve Node ≥ 22.18 (esegue TypeScript direttamente, `node:sqlite` integrato). Nessuna dipendenza npm.
