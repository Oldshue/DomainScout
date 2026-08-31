#!/usr/bin/env bash
# release-local-macos.sh
# Bounded, recoverable local macOS release entry point for DomainScout.
# Generic host-release boundary: validate -> stage -> backup -> sync -> install -> verify -> rollback-on-failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_TARGET="/Users/hamp/DomainScout"
DEFAULT_BACKUP_ROOT="/Users/hamp/DomainScout-backups"
DEFAULT_PORT="51550"

SOURCE="${DEFAULT_SOURCE}"
TARGET="${DEFAULT_TARGET}"
BACKUP_ROOT="${DEFAULT_BACKUP_ROOT}"
PORT="${DEFAULT_PORT}"
USER_HOME="/Users/hamp"
APP_DIR=""
CHECK_ONLY="0"
NO_OPEN="0"
REUSE_APP_BUNDLE="0"
REUSE_CREDENTIAL_HELPER="0"
PREVALIDATED_COMMIT=""
DEFER_SERVICE_RESTART="0"

log() { printf '[release-local-macos] %s\n' "$*"; }
err() { printf '[release-local-macos][ERROR] %s\n' "$*" >&2; }

for arg in "$@"; do
  case "$arg" in
    --source=*) SOURCE="${arg#--source=}" ;;
    --target=*) TARGET="${arg#--target=}" ;;
    --backup-root=*) BACKUP_ROOT="${arg#--backup-root=}" ;;
    --app-dir=*) APP_DIR="${arg#--app-dir=}" ;;
    --port=*) PORT="${arg#--port=}" ;;
    --user-home=*) USER_HOME="${arg#--user-home=}" ;;
    --check) CHECK_ONLY="1" ;;
    --no-open) NO_OPEN="1" ;;
    --reuse-app-bundle) REUSE_APP_BUNDLE="1" ;;
    --defer-service-restart) DEFER_SERVICE_RESTART="1" ;;
    --prevalidated-commit=*) PREVALIDATED_COMMIT="${arg#--prevalidated-commit=}" ;;
    *) err "Unknown argument: $arg"; exit 2 ;;
  esac
done

reject_unsafe_path() {
  local label="$1" path="$2"
  if [ -z "$path" ]; then
    err "$label must not be empty"; exit 2
  fi
  case "$path" in
    /*) : ;;
    *) err "$label must be an absolute path: $path"; exit 2 ;;
  esac
  if [ "$path" = "/" ]; then
    err "$label must not be the root filesystem slash"; exit 2
  fi
  if [ "$path" = "${HOME:-}" ]; then
    err "$label must not equal HOME"; exit 2
  fi
  if [ "$path" = "$SOURCE" ]; then
    err "$label must not equal the source repository itself"; exit 2
  fi
}

reject_unsafe_path "target" "$TARGET"
reject_unsafe_path "backup-root" "$BACKUP_ROOT"
case "$USER_HOME" in
  /*) : ;;
  *) err "user-home must be an absolute path: $USER_HOME"; exit 2 ;;
esac
if [ "$USER_HOME" = "/" ]; then
  err "user-home must not be the root filesystem slash"
  exit 2
fi
if [ -n "$APP_DIR" ]; then
  reject_unsafe_path "app-dir" "$APP_DIR"
fi

if [ "$TARGET" != "$DEFAULT_TARGET" ] && [ "${DOMAINSCOUT_ALLOW_CUSTOM_TARGET:-0}" != "1" ]; then
  err "Refusing non-default target '$TARGET' without DOMAINSCOUT_ALLOW_CUSTOM_TARGET=1"
  exit 2
fi

validate_source() {
  local missing=0
  [ -f "$SOURCE/package.json" ] || { err "Missing $SOURCE/package.json"; missing=1; }
  [ -f "$SOURCE/server/index.js" ] || { err "Missing $SOURCE/server/index.js"; missing=1; }
  [ -f "$SOURCE/public/index.html" ] || { err "Missing $SOURCE/public/index.html"; missing=1; }
  if [ "$missing" -eq 1 ]; then
    err "Source validation failed for $SOURCE"
    exit 2
  fi
  log "Source validated: $SOURCE"
}

validate_source

verify_source_syntax() {
  log "Running node --check on source/server/index.js"
  node --check "$SOURCE/server/index.js"
}

verify_source_syntax

# macOS rsync can deadlock its local sender/receiver pipe when a governed host
# runner itself captures output through nonblocking descriptors. Force the
# local transport to block normally and fail closed after bounded no-progress
# so backup, staging, installation, and rollback cannot hang indefinitely.
RSYNC_TRANSPORT=(
  --blocking-io
  --timeout=60
)

RSYNC_EXCLUDES=(
  --exclude=data
  --exclude=.env
  --exclude=node_modules
  --exclude=.git
)

BACKUP_EXCLUDES=(
  --exclude=data
  --exclude=.env
  --exclude=node_modules
  --exclude=.git
  --exclude=.source-commit
  --exclude='*.iconset'
  --exclude='build/icon-intermediates'
  --exclude='*.icns.build'
)

TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
PRIOR_SOURCE_COMMIT_MARKER="${BACKUP_ROOT}/${TIMESTAMP}.source-commit.prior"

perform_backup() {
  mkdir -p "$BACKUP_DIR"
  if [ -d "$TARGET" ]; then
    rsync -a "${RSYNC_TRANSPORT[@]}" "${BACKUP_EXCLUDES[@]}" "$TARGET"/ "$BACKUP_DIR"/
    if [ -f "$TARGET/.source-commit" ]; then
      cp "$TARGET/.source-commit" "$PRIOR_SOURCE_COMMIT_MARKER"
    fi
  fi
  log "Backup created at $BACKUP_DIR"
}

if [ "$CHECK_ONLY" = "1" ]; then
  log "Check-only mode: validation complete, no mutation performed."
  exit 0
fi

prepare_source_dependencies() {
  log "Preparing exact lockfile dependencies in source: $SOURCE"
  (cd "$SOURCE" && npm ci --silent)
}

run_source_tests() {
  log "Running npm test in source"
  (cd "$SOURCE" && npm test --silent)
}

if [ -n "$PREVALIDATED_COMMIT" ]; then
  case "$PREVALIDATED_COMMIT" in
    *[!0-9a-f]*|'') err "--prevalidated-commit must be a lowercase hexadecimal Git commit"; exit 2 ;;
  esac
  if [ "${#PREVALIDATED_COMMIT}" -ne 40 ]; then
    err "--prevalidated-commit must be a full 40-character Git commit"
    exit 2
  fi
  ACTUAL_SOURCE_COMMIT="$(cd "$SOURCE" && git rev-parse HEAD)"
  if [ "$ACTUAL_SOURCE_COMMIT" != "$PREVALIDATED_COMMIT" ]; then
    err "Prevalidated source commit mismatch: expected $PREVALIDATED_COMMIT, got $ACTUAL_SOURCE_COMMIT"
    exit 2
  fi
  log "Using exact prevalidated source commit: $PREVALIDATED_COMMIT"
else
  prepare_source_dependencies
  run_source_tests
fi

perform_backup

rollback() {
  err "Post-mutation failure detected; restoring backed-up code/config, preserving data."
  if [ -d "$BACKUP_DIR" ]; then
    rsync -a --delete "${RSYNC_TRANSPORT[@]}" "${BACKUP_EXCLUDES[@]}" "$BACKUP_DIR"/ "$TARGET"/
    if [ -f "$PRIOR_SOURCE_COMMIT_MARKER" ]; then
      cp "$PRIOR_SOURCE_COMMIT_MARKER" "$TARGET/.source-commit"
    else
      rm -f "$TARGET/.source-commit"
    fi
    err "Rollback complete from $BACKUP_DIR"
  fi
}

MUTATION_STARTED="0"
trap 'if [ "$MUTATION_STARTED" = "1" ]; then rollback; fi' ERR

MUTATION_STARTED="1"

if [ -n "${AGENTFORGE_SCRATCH_DIR:-}" ]; then
  case "$AGENTFORGE_SCRATCH_DIR" in
    /*) if [ -d "$AGENTFORGE_SCRATCH_DIR" ]; then SCRATCH_BASE="$AGENTFORGE_SCRATCH_DIR"; fi ;;
  esac
fi
if [ -z "${SCRATCH_BASE:-}" ]; then
  if [ -n "${TMPDIR:-}" ]; then
    SCRATCH_BASE="$TMPDIR"
  else
    SCRATCH_BASE="/tmp"
  fi
fi
STAGE_DIR="$(mktemp -d "${SCRATCH_BASE%/}/domainscout-stage.XXXXXX")"
cleanup_stage() { rm -rf "$STAGE_DIR"; }
trap 'cleanup_stage' EXIT

log "Staging source into temporary sibling: $STAGE_DIR"
rsync -a --delete "${RSYNC_TRANSPORT[@]}" "${RSYNC_EXCLUDES[@]}" "$SOURCE"/ "$STAGE_DIR"/

stop_owned_process() {
  local lockfile="$TARGET/data/server.lock.json"
  if [ ! -f "$lockfile" ]; then
    log "No server.lock.json found; nothing to stop."
    return 0
  fi
  local pid
  pid="$(node -e 'const fs=require("fs"); try { const value=String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).pid ?? ""); if (/^[1-9][0-9]*$/.test(value)) process.stdout.write(value); } catch {}' "$lockfile" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*)
      log "No valid positive integer PID recorded in lock file; nothing to stop."
      return 0
      ;;
  esac
  local cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2)}' || true)"
  if [ "$cwd" = "$TARGET" ]; then
    log "Stopping owned process PID $pid (cwd matches target exactly)"
    kill "$pid" || true
  else
    log "Refusing to stop PID $pid: cwd '$cwd' does not exactly match target '$TARGET'"
  fi
}

quit_app() {
  osascript -e 'tell application "DomainScout" to quit' >/dev/null 2>&1 &
  local osascript_pid=$!
  local attempts=0
  while kill -0 "$osascript_pid" >/dev/null 2>&1 && [ "$attempts" -lt 20 ]; do
    sleep 0.1
    attempts=$((attempts+1))
  done
  if kill -0 "$osascript_pid" >/dev/null 2>&1; then
    log "DomainScout quit Apple event exceeded 2 seconds; continuing without waiting on UI automation."
    kill "$osascript_pid" >/dev/null 2>&1 || true
  fi
  wait "$osascript_pid" >/dev/null 2>&1 || true
}

if [ "$DEFER_SERVICE_RESTART" != "1" ]; then
  stop_owned_process
else
  log "Service restart deferred to the authorized service-control lane."
fi
quit_app

sync_to_target() {
  mkdir -p "$TARGET"
  rsync -a --delete "${RSYNC_TRANSPORT[@]}" "${RSYNC_EXCLUDES[@]}" "$STAGE_DIR"/ "$TARGET"/
}

sync_to_target

(cd "$TARGET" && npm ci)

SOURCE_COMMIT="$(cd "$SOURCE" && git rev-parse HEAD)"
printf '%s\n' "$SOURCE_COMMIT" > "$TARGET/.source-commit"
node "$TARGET/scripts/source-manifest.js" create --source="$SOURCE" --target="$TARGET" >/dev/null

if [ "$REUSE_APP_BUNDLE" = "1" ]; then
  if [ -z "$APP_DIR" ] || [ ! -x "$APP_DIR/Contents/MacOS/DomainScout" ]; then
    err "A verified existing DomainScout app bundle is required with --reuse-app-bundle: $APP_DIR"
    exit 1
  fi
  CONFIG_FILE="$APP_DIR/Contents/Resources/DomainScoutConfig.plist"
  if [ ! -f "$CONFIG_FILE" ]; then
    err "Existing app configuration is missing: $CONFIG_FILE"
    exit 1
  fi
  CONFIG_ROOT="$(/usr/libexec/PlistBuddy -c 'Print :ProjectRoot' "$CONFIG_FILE" 2>/dev/null || true)"
  CONFIG_PORT="$(/usr/libexec/PlistBuddy -c 'Print :Port' "$CONFIG_FILE" 2>/dev/null || true)"
  CONFIG_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :BuildCommit' "$CONFIG_FILE" 2>/dev/null || true)"
  if [ "$CONFIG_ROOT" != "$TARGET" ] || [ "$CONFIG_PORT" != "$PORT" ]; then
    err "Existing app configuration does not match target '$TARGET' and port '$PORT'"
    exit 1
  fi
  if [ "$CONFIG_BUILD" != "$SOURCE_COMMIT" ]; then
    err "Existing app build '$CONFIG_BUILD' does not match source commit '$SOURCE_COMMIT'; rebuild the app bundle"
    exit 1
  fi
  log "Reusing verified existing app bundle: $APP_DIR"
fi

# A signed device-credential helper may be reused independently of the app
# bundle only when its source is byte-identical to the prior installed
# generation. This keeps routine releases independent of the host Swift
# toolchain while forcing a real rebuild whenever the security boundary
# changes. The prior commit marker is captured before the target is synced.
if [ -f "$PRIOR_SOURCE_COMMIT_MARKER" ]; then
  PRIOR_HELPER_COMMIT="$(tr -d '\r\n' < "$PRIOR_SOURCE_COMMIT_MARKER")"
  case "$PRIOR_HELPER_COMMIT" in
    *[!0-9a-f]*|'') PRIOR_HELPER_COMMIT="" ;;
  esac
  if [ "${#PRIOR_HELPER_COMMIT}" -eq 40 ] \
    && git -C "$SOURCE" cat-file -e "${PRIOR_HELPER_COMMIT}^{commit}" 2>/dev/null \
    && git -C "$SOURCE" diff --quiet "$PRIOR_HELPER_COMMIT" "$SOURCE_COMMIT" -- scripts/DomainScoutCredentialStore.swift; then
    REUSE_CREDENTIAL_HELPER="1"
    log "Reusing verified credential helper from source-identical prior generation."
  fi
fi

# Reuse establishes that the existing bundle is a valid rollback baseline. The
# exact release still has to run the installer so launchd definitions, verified
# bundled assets, and configuration are regenerated from this source commit.
if [ -x "$TARGET/scripts/install-macos-app.sh" ]; then
  INSTALLER_ARGS=()
  if [ "$DEFER_SERVICE_RESTART" = "1" ]; then
    INSTALLER_ARGS+=(--defer-service-reload)
  fi
  if [ -n "$APP_DIR" ]; then
    if [ "${#INSTALLER_ARGS[@]}" -gt 0 ]; then
      DOMAINSCOUT_USER_HOME="$USER_HOME" DOMAINSCOUT_RELEASE_COMMIT="$SOURCE_COMMIT" DOMAINSCOUT_REUSE_CREDENTIAL_HELPER="$REUSE_CREDENTIAL_HELPER" DOMAINSCOUT_ROOT="$TARGET" PORT="$PORT" DOMAINSCOUT_APP_DIR="$APP_DIR" "$TARGET/scripts/install-macos-app.sh" "${INSTALLER_ARGS[@]}"
    else
      DOMAINSCOUT_USER_HOME="$USER_HOME" DOMAINSCOUT_RELEASE_COMMIT="$SOURCE_COMMIT" DOMAINSCOUT_REUSE_CREDENTIAL_HELPER="$REUSE_CREDENTIAL_HELPER" DOMAINSCOUT_ROOT="$TARGET" PORT="$PORT" DOMAINSCOUT_APP_DIR="$APP_DIR" "$TARGET/scripts/install-macos-app.sh"
    fi
  else
    if [ "${#INSTALLER_ARGS[@]}" -gt 0 ]; then
      DOMAINSCOUT_USER_HOME="$USER_HOME" DOMAINSCOUT_RELEASE_COMMIT="$SOURCE_COMMIT" DOMAINSCOUT_REUSE_CREDENTIAL_HELPER="$REUSE_CREDENTIAL_HELPER" DOMAINSCOUT_ROOT="$TARGET" PORT="$PORT" "$TARGET/scripts/install-macos-app.sh" "${INSTALLER_ARGS[@]}"
    else
      DOMAINSCOUT_USER_HOME="$USER_HOME" DOMAINSCOUT_RELEASE_COMMIT="$SOURCE_COMMIT" DOMAINSCOUT_REUSE_CREDENTIAL_HELPER="$REUSE_CREDENTIAL_HELPER" DOMAINSCOUT_ROOT="$TARGET" PORT="$PORT" "$TARGET/scripts/install-macos-app.sh"
    fi
  fi
else
  err "Installer not found or not executable: $TARGET/scripts/install-macos-app.sh"
  exit 1
fi

if [ "$NO_OPEN" != "1" ]; then
  if [ -n "$APP_DIR" ]; then
    open -g "$APP_DIR" || true
  else
    open -g -a "DomainScout" || open -g "/Applications/DomainScout.app" || true
  fi
fi

poll_health() {
  local url="$1" attempts=30 i=0
  while [ "$i" -lt "$attempts" ]; do
    # A health route must not be able to strand the release while the desktop is
    # warming or a regression blocks the Node event loop. Keep every attempt
    # bounded so the existing rollback gate remains meaningful.
    if curl -fsS --connect-timeout 1 --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i+1))
    sleep 1
  done
  return 1
}

if [ "$DEFER_SERVICE_RESTART" != "1" ]; then
  poll_health "http://localhost:${PORT}/api/stats"
  # The full config projection intentionally performs expensive expired-market
  # diagnostics. Release readiness needs only the cheap server/config contract.
  poll_health "http://localhost:${PORT}/api/config-status?lightweight=1"
fi

verify_plist() {
  local plist
  if [ -n "$APP_DIR" ]; then
    plist="${APP_DIR}/Contents/Resources/DomainScoutConfig.plist"
  else
    plist="/Applications/DomainScout.app/Contents/Resources/DomainScoutConfig.plist"
  fi
  if [ ! -f "$plist" ]; then
    err "Plist not found: $plist"
    return 1
  fi
  if ! grep -q "$TARGET" "$plist"; then
    err "Plist does not reference target: $TARGET"
    return 1
  fi
}

verify_plist

MUTATION_STARTED="0"
log "Release complete. Source commit $SOURCE_COMMIT installed to $TARGET on port $PORT."
