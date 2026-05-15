#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DOMAINSCOUT_MINI_HOST:-hamps-mac-mini}"
REMOTE_ROOT="${DOMAINSCOUT_MINI_ROOT:-/Users/hamp/DomainScout}"
PORT="${PORT:-3737}"
COPY_DATA=1

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --remote-root=*) REMOTE_ROOT="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --no-data) COPY_DATA=0 ;;
    --data) COPY_DATA=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "Deploying DomainScout to ${HOST}:${REMOTE_ROOT}"

ssh "$HOST" "mkdir -p '$REMOTE_ROOT' '$REMOTE_ROOT/data'"

echo "Stopping remote service if present..."
ssh "$HOST" 'launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hamp.domainscout.plist" >/dev/null 2>&1 || true'

if [ "$COPY_DATA" = "1" ]; then
  echo "Checkpointing local SQLite databases before transfer..."
  sqlite3 "$ROOT/data/domains.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  sqlite3 "$ROOT/data/zone_index.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
fi

echo "Syncing app code..."
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'build/macos-icon/DomainScout.iconset/' \
  "$ROOT/" "$HOST:$REMOTE_ROOT/"

if [ "$COPY_DATA" = "1" ]; then
  echo "Syncing local databases..."
  rsync -az --partial --stats \
    "$ROOT/data/domains.db" \
    "$ROOT/data/zone_index.db" \
    "$ROOT/data/logical-tlds.json" \
    "$HOST:$REMOTE_ROOT/data/"
fi

echo "Installing production dependencies on the mini..."
ssh "$HOST" "cd '$REMOTE_ROOT' && npm ci --omit=dev"

echo "Installing and starting headless service..."
ssh "$HOST" "cd '$REMOTE_ROOT' && chmod +x scripts/install-headless-service.sh && PORT='$PORT' bash scripts/install-headless-service.sh"

echo "Checking health..."
ssh "$HOST" "PORT='$PORT' bash -s" <<'REMOTE_HEALTH'
for i in $(seq 1 60); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/api/stats" || true)
  if [ "$code" = 200 ]; then
    echo 'DomainScout is up on the mini'
    exit 0
  fi
  sleep 0.5
done
echo 'DomainScout did not become healthy yet' >&2
tail -80 "$HOME/Library/Logs/DomainScout/server.log" >&2 || true
tail -80 "$HOME/Library/Logs/DomainScout/server.err.log" >&2 || true
exit 1
REMOTE_HEALTH

echo "Done."
if [[ "$HOST" == *.* ]]; then
  DISPLAY_HOST="$HOST"
else
  DISPLAY_HOST="${HOST}.local"
fi
echo "  Local mini URL: http://${DISPLAY_HOST}:${PORT}/"
echo "  Remote root: ${REMOTE_ROOT}"
