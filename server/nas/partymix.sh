#!/bin/sh
# PartyMix server on a Synology WITHOUT Docker (e.g. DS215j): started by DSM's Task Scheduler at boot.
# Control Panel → Task Scheduler → Create → Triggered task → User-defined script → Event: Boot-up → Run command:
#   sh /volume2/docker/partymix/server/nas/partymix.sh
# Needs the "Node.js v18" package (or newer) from Package Center. Logs in <ROOT>/server.log.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${PARTYMIX_ROOT:-/volume2/PartyMix}"
PORT="${PORT:-8788}"
NODE="$(ls /var/packages/Node.js_v*/target/usr/local/bin/node 2>/dev/null | sort -V | tail -1)"
[ -x "$NODE" ] || NODE="$(command -v node)"
if [ ! -x "$NODE" ]; then echo "Node.js non trovato: installa «Node.js v18» dal Centro pacchetti" >&2; exit 1; fi
mkdir -p "$ROOT"
cd "$DIR" || exit 1
# one copy only: stop the previous one (an update, or the task run again). The command line holds only the relative
# path, so match that (and the pid saved last time); then wait until the port is free.
PIDFILE="$ROOT/server.pid"
[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
pkill -f "dist/server/src/main.js" 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "dist/server/src/main.js" >/dev/null || break; sleep 1; done
pkill -9 -f "dist/server/src/main.js" 2>/dev/null
PARTYMIX_ROOT="$ROOT" PORT="$PORT" HOST=0.0.0.0 nohup "$NODE" --max-old-space-size=160 "$DIR/dist/server/src/main.js" >> "$ROOT/server.log" 2>&1 &
echo $! > "$PIDFILE"
echo "$(date '+%F %T') PartyMix avviato con $NODE ($("$NODE" -v)), pid $!, porta $PORT" >> "$ROOT/server.log"
