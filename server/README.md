# PartyMix server (NAS)

Il cuore della libreria personale PartyMix: playlist, brani, dispositivi autorizzati. Gira sul NAS, solo in rete di casa
(o via VPN). Design completo: `docs/superpowers/specs/2026-11-15-nas-sync-design.md`.

Contiene: account e utenti del NAS (Synology DSM), dispositivi con permessi, playlist con versioni e merge, sincronizzazione
incrementale con eventi in tempo reale, caricamento dei brani a pezzi con verifica SHA-256, ascolto in streaming con link firmati,
scansione della cartella music/, spazio disco.

## Installazione

Guida passo passo per tutti i NAS (Synology anche senza Docker, QNAP, Unraid, TrueNAS, Linux): **[docs/NAS.md](../docs/NAS.md)**.

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
PARTYMIX_ROOT=/tmp/partymix PORT=8788 npm start
npm test
```

Serve Node ≥ 22.18 (esegue TypeScript direttamente, `node:sqlite` integrato). Nessuna dipendenza npm.
