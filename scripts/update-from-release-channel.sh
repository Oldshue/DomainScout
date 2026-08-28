#!/usr/bin/env bash
# Keep one installed DomainScout host on the exact production release.
# The production service publishes the desired immutable Git commit; this
# client verifies that the commit belongs to the configured production branch,
# runs the repository's full test gate, and delegates the actual mutation to
# the existing backup/rollback release boundary.
set -euo pipefail

RELEASE_CHANNEL_URL="${DOMAINSCOUT_RELEASE_CHANNEL_URL:-https://domainscout-production-ea0f.up.railway.app/api/release-channel}"
REPOSITORY_URL="${DOMAINSCOUT_RELEASE_REPOSITORY:-https://github.com/Oldshue/DomainScout.git}"
RELEASE_BRANCH="${DOMAINSCOUT_RELEASE_BRANCH:-master}"
TARGET="${DOMAINSCOUT_ROOT:-/Users/hamp/DomainScout}"
BACKUP_ROOT="${DOMAINSCOUT_BACKUP_ROOT:-/Users/hamp/DomainScout-backups}"
USER_HOME="${DOMAINSCOUT_USER_HOME:-/Users/hamp}"
APP_DIR="${DOMAINSCOUT_APP_DIR:-/Applications/DomainScout.app}"
PORT="${PORT:-51550}"
STATE_DIR="${DOMAINSCOUT_UPDATE_STATE_DIR:-${USER_HOME}/Library/Application Support/DomainScout/updater}"
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    *) printf '[domainscout-updater][ERROR] Unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf '[domainscout-updater] %s\n' "$*"; }
fail() { printf '[domainscout-updater][ERROR] %s\n' "$*" >&2; exit 1; }

absolute_non_root() {
  local label="$1" value="$2"
  case "$value" in
    /*) : ;;
    *) fail "$label must be an absolute path" ;;
  esac
  [ "$value" != "/" ] || fail "$label must not be the root filesystem slash"
}

case "$RELEASE_CHANNEL_URL" in
  https://*) : ;;
  *) fail 'release channel URL must use HTTPS' ;;
esac
case "$REPOSITORY_URL" in
  https://*) : ;;
  *) fail 'release repository URL must use HTTPS' ;;
esac
case "$RELEASE_BRANCH" in
  ''|*[!A-Za-z0-9._/-]*) fail 'release branch contains unsupported characters' ;;
esac
absolute_non_root target "$TARGET"
absolute_non_root backup-root "$BACKUP_ROOT"
absolute_non_root user-home "$USER_HOME"
absolute_non_root app-dir "$APP_DIR"
absolute_non_root state-dir "$STATE_DIR"
case "$PORT" in
  ''|*[!0-9]*) fail 'port must be an integer' ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail 'port must be between 1 and 65535'

if [ "$CHECK_ONLY" = "1" ]; then
  log "Release channel: $RELEASE_CHANNEL_URL"
  log "Repository: $REPOSITORY_URL"
  log "Branch: $RELEASE_BRANCH"
  log "Target: $TARGET"
  log "App: $APP_DIR"
  log "Check-only mode: validation complete, no mutation performed."
  exit 0
fi

mkdir -p "$STATE_DIR"
LOCK_DIR="${STATE_DIR}/update.lock"
LOCK_ACQUIRED=0
for ((attempt = 0; attempt < 120; attempt += 1)); do
  if mkdir "$LOCK_DIR" 2>/dev/null; then LOCK_ACQUIRED=1; break; fi
  if [ "$attempt" -eq 0 ]; then log 'Another update check is active; waiting for its verified result.'; fi
  sleep 0.25
done
[ "$LOCK_ACQUIRED" = "1" ] || fail 'timed out waiting for the active production update'

STAGE_ROOT=""
cleanup() {
  if [ -n "$STAGE_ROOT" ] && [ -d "$STAGE_ROOT" ]; then rm -rf "$STAGE_ROOT"; fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v git >/dev/null 2>&1 || fail 'git is required'
command -v node >/dev/null 2>&1 || fail 'node is required'

INSTALLED_COMMIT=""
if [ -f "$TARGET/.source-commit" ]; then
  INSTALLED_COMMIT="$(tr -d '\r\n' < "$TARGET/.source-commit")"
fi

parse_channel_commit() {
  printf '%s' "$1" | node -e '
let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",d=>body+=d);
process.stdin.on("end",()=>{ try { const value=JSON.parse(body); const commit=String(value.sourceCommit||"").toLowerCase(); if(value.schema!=="domainscout.release-channel/v1"||!/^[a-f0-9]{40}$/.test(commit)) process.exit(2); process.stdout.write(commit); } catch { process.exit(2); } });
'
}

cached_receipt_commit() {
  node -e '
const fs=require("fs"); const [receiptPath,channel,target,app]=process.argv.slice(1);
try {
  const value=JSON.parse(fs.readFileSync(receiptPath,"utf8"));
  const commit=String(value.sourceCommit||"").toLowerCase();
  if(value.schema!=="domainscout.device-release-receipt/v1"||value.releaseChannel!==channel||value.target!==target||value.applicationPath!==app||!/^[a-f0-9]{40}$/.test(commit)) process.exit(1);
  process.stdout.write(commit);
} catch { process.exit(1); }
' "${STATE_DIR}/last-success.json" "$RELEASE_CHANNEL_URL" "$TARGET" "$APP_DIR"
}

installed_source_verified() {
  local commit="$1"
  [ -x "$TARGET/scripts/source-manifest.js" ] || return 1
  node "$TARGET/scripts/source-manifest.js" verify --target="$TARGET" --commit="$commit" >/dev/null 2>&1
}

installed_app_verified() {
  local commit="$1" config="${APP_DIR}/Contents/Resources/DomainScoutConfig.plist" executable="${APP_DIR}/Contents/MacOS/DomainScout" observed
  [ -f "$config" ] && [ -x "$executable" ] || return 1
  observed="$(/usr/libexec/PlistBuddy -c 'Print :BuildCommit' "$config" 2>/dev/null || true)"
  [ "$observed" = "$commit" ] || return 1
  /usr/bin/codesign --verify --deep --strict "$APP_DIR" >/dev/null 2>&1
}

receipt_matches() {
  node -e '
const fs=require("fs"); const [path,commit]=process.argv.slice(1);
try { const value=JSON.parse(fs.readFileSync(path,"utf8")); process.exit(value.schema==="domainscout.device-release-receipt/v1"&&value.sourceCommit===commit?0:1); } catch { process.exit(1); }
' "${STATE_DIR}/last-success.json" "$DESIRED_COMMIT"
}

write_receipt() {
  local status="$1" receipt_tmp="${STATE_DIR}/last-success.json.tmp.$$"
  node -e '
const fs=require("fs"); const [path,status,commit,target,app,channel]=process.argv.slice(1);
fs.writeFileSync(path, JSON.stringify({schema:"domainscout.device-release-receipt/v1",status,sourceCommit:commit,target,applicationPath:app,releaseChannel:channel,completedAt:new Date().toISOString()},null,2)+"\n", {mode:0o600});
' "$receipt_tmp" "$status" "$DESIRED_COMMIT" "$TARGET" "$APP_DIR" "$RELEASE_CHANNEL_URL"
  mv -f "$receipt_tmp" "${STATE_DIR}/last-success.json"
}

CHANNEL_JSON=""
DESIRED_COMMIT=""
if CHANNEL_JSON="$(curl -fsS --connect-timeout 5 --max-time 20 \
  -H 'Accept: application/json' -H 'Cache-Control: no-cache' "$RELEASE_CHANNEL_URL" 2>/dev/null)"; then
  DESIRED_COMMIT="$(parse_channel_commit "$CHANNEL_JSON" || true)"
fi

if ! printf '%s\n' "$DESIRED_COMMIT" | grep -Eq '^[a-f0-9]{40}$'; then
  CACHED_COMMIT="$(cached_receipt_commit || true)"
  if printf '%s\n' "$CACHED_COMMIT" | grep -Eq '^[a-f0-9]{40}$' \
    && [ "$INSTALLED_COMMIT" = "$CACHED_COMMIT" ] \
    && installed_source_verified "$CACHED_COMMIT" \
    && installed_app_verified "$CACHED_COMMIT"; then
    log "Release channel unavailable; starting content-verified cached production $CACHED_COMMIT"
    exit 0
  fi
  fail 'release channel unavailable and no content-verified cached production install is admissible'
fi

if [ "$INSTALLED_COMMIT" = "$DESIRED_COMMIT" ] && installed_source_verified "$DESIRED_COMMIT" && installed_app_verified "$DESIRED_COMMIT"; then
  if ! receipt_matches; then write_receipt current; fi
  log "Already current and content-verified at $DESIRED_COMMIT"
  exit 0
fi

if [ "$INSTALLED_COMMIT" = "$DESIRED_COMMIT" ]; then
  log "Installed marker matches $DESIRED_COMMIT but tracked content did not verify; repairing the release."
fi

mkdir -p "${USER_HOME}/Library/Caches/DomainScout"
STAGE_ROOT="$(mktemp -d "${USER_HOME}/Library/Caches/DomainScout/update.XXXXXX")"
SOURCE_DIR="$STAGE_ROOT/source"
log "Staging production commit $DESIRED_COMMIT"
git -c advice.detachedHead=false clone --quiet --no-checkout --single-branch \
  --branch "$RELEASE_BRANCH" "$REPOSITORY_URL" "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --quiet --detach "$DESIRED_COMMIT"
ACTUAL_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[ "$ACTUAL_COMMIT" = "$DESIRED_COMMIT" ] || fail 'checked-out commit does not match the release channel'
git -C "$SOURCE_DIR" merge-base --is-ancestor "$DESIRED_COMMIT" "origin/$RELEASE_BRANCH" \
  || fail 'release commit is not reachable from the configured production branch'

log 'Installing exact dependencies and running the full production test gate'
(cd "$SOURCE_DIR" && npm ci --silent && npm test --silent)

APP_WAS_RUNNING=0
if pgrep -f "${APP_DIR}/Contents/MacOS/DomainScout" >/dev/null 2>&1; then APP_WAS_RUNNING=1; fi
RELEASE_ARGS=(
  "--source=$SOURCE_DIR"
  "--target=$TARGET"
  "--backup-root=$BACKUP_ROOT"
  "--app-dir=$APP_DIR"
  "--port=$PORT"
  "--user-home=$USER_HOME"
  "--prevalidated-commit=$DESIRED_COMMIT"
)
if [ "$APP_WAS_RUNNING" = "0" ]; then RELEASE_ARGS+=(--no-open); fi

DOMAINSCOUT_ALLOW_CUSTOM_TARGET=1 DOMAINSCOUT_UPDATER_ACTIVE=1 \
  "$SOURCE_DIR/scripts/release-local-macos.sh" "${RELEASE_ARGS[@]}"

OBSERVED_COMMIT="$(tr -d '\r\n' < "$TARGET/.source-commit")"
[ "$OBSERVED_COMMIT" = "$DESIRED_COMMIT" ] || fail 'installed source marker does not match the desired release'
installed_source_verified "$DESIRED_COMMIT" || fail 'installed tracked content does not match the desired release'
installed_app_verified "$DESIRED_COMMIT" || fail 'installed app does not match the desired release'

write_receipt updated
log "Update complete at $DESIRED_COMMIT"
