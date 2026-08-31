#!/usr/bin/env bash
set -euo pipefail

resolve_script_dir() {
  local src="${BASH_SOURCE[0]}"
  while [ -h "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)"
    src="$(readlink "$src")"
    case "$src" in
      /*) ;;
      *) src="${dir}/${src}" ;;
    esac
  done
  cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd
}

validate_domainscout_root() {
  local root="$1"
  if [ ! -f "${root}/package.json" ]; then
    echo "Invalid DomainScout root: missing package.json at ${root}" >&2
    return 1
  fi
  if [ ! -f "${root}/server/index.js" ]; then
    echo "Invalid DomainScout root: missing server/index.js at ${root}" >&2
    return 1
  fi
  if [ ! -f "${root}/public/index.html" ]; then
    echo "Invalid DomainScout root: missing public/index.html at ${root}" >&2
    return 1
  fi
  return 0
}

SCRIPT_DIR="$(resolve_script_dir)"
DEFAULT_ROOT="$(cd -P "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

if [ -n "${DOMAINSCOUT_ROOT:-}" ]; then
  RAW_ROOT="${DOMAINSCOUT_ROOT}"
else
  RAW_ROOT="${DEFAULT_ROOT}"
fi

if [ ! -d "$RAW_ROOT" ]; then
  echo "Invalid DomainScout root: '${RAW_ROOT}' is not a directory." >&2
  exit 1
fi

ROOT="$(cd -P "$RAW_ROOT" >/dev/null 2>&1 && pwd)"

if ! validate_domainscout_root "$ROOT"; then
  exit 1
fi

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
PORT="${PORT:-3737}"
LABEL="com.hamp.domainscout"
TLD_WORKER_LABEL="com.hamp.domainscout.tldworker"
UPDATER_LABEL="com.hamp.domainscout.updater"
USER_HOME="${DOMAINSCOUT_USER_HOME:-${HOME}}"
case "$USER_HOME" in
  /*) : ;;
  *) echo "Invalid DomainScout user home: must be absolute" >&2; exit 1 ;;
esac
if [ "$USER_HOME" = "/" ]; then
  echo "Invalid DomainScout user home: must not be root" >&2
  exit 1
fi
PLIST="${USER_HOME}/Library/LaunchAgents/${LABEL}.plist"
TLD_WORKER_PLIST="${USER_HOME}/Library/LaunchAgents/${TLD_WORKER_LABEL}.plist"
UPDATER_PLIST="${USER_HOME}/Library/LaunchAgents/${UPDATER_LABEL}.plist"
SWIFT_APP_SOURCE="${ROOT}/scripts/DomainScoutApp.swift"
SWIFT_CREDENTIAL_SOURCE="${ROOT}/scripts/DomainScoutCredentialStore.swift"
USER_APP_DIR="${USER_HOME}/Applications/DomainScout.app"
SYSTEM_APP_DIR="/Applications/DomainScout.app"
if [ -w "/Applications" ]; then
  APP_DIR="$SYSTEM_APP_DIR"
else
  APP_DIR="$USER_APP_DIR"
fi
if [ -n "${DOMAINSCOUT_APP_DIR:-}" ]; then
  case "$DOMAINSCOUT_APP_DIR" in
    /*) : ;;
    *)
      echo "Invalid DOMAINSCOUT_APP_DIR: must be an absolute path: ${DOMAINSCOUT_APP_DIR}" >&2
      exit 1
      ;;
  esac
  if [ "$DOMAINSCOUT_APP_DIR" = "/" ]; then
    echo "Invalid DOMAINSCOUT_APP_DIR: must not be the root filesystem slash" >&2
    exit 1
  fi
  APP_DIR="$DOMAINSCOUT_APP_DIR"
fi
# An explicit compatibility path may already be an alias to the canonical app.
# Resolve it before writing so a future release cannot recreate a second physical
# bundle beside the existing system installation.
if [ -d "$APP_DIR" ]; then
  APP_DIR="$(cd -P "$APP_DIR" >/dev/null 2>&1 && pwd)"
fi
DESKTOP_APP="${USER_HOME}/Desktop/DomainScout.app"
LOG_DIR="${USER_HOME}/Library/Logs/DomainScout"
UPDATER_STATE_DIR="${USER_HOME}/Library/Application Support/DomainScout/updater"
UPDATER_SCRIPT="${UPDATER_STATE_DIR}/update-from-release-channel.sh"
UPDATER_RUNNER="${UPDATER_STATE_DIR}/run-production-update.sh"
CURRENT_SERVER_RUNNER="${UPDATER_STATE_DIR}/run-current-server.sh"
HEADLESS_SUPERVISOR="${UPDATER_STATE_DIR}/headless-supervisor.sh"
BUILD_DIR="${ROOT}/build/macos-icon"
ICONSET="${BUILD_DIR}/DomainScout.iconset"
ICON_FILE="${APP_DIR}/Contents/Resources/DomainScout.icns"
CONFIG_FILE="${APP_DIR}/Contents/Resources/DomainScoutConfig.plist"
CREDENTIAL_HELPER_DIR="${APP_DIR}/Contents/Helpers"
CREDENTIAL_HELPER="${CREDENTIAL_HELPER_DIR}/DomainScoutCredentialStore"
INSTALL_LOGIN_AGENT="${INSTALL_LOGIN_AGENT:-0}"
BUILD_COMMIT="${DOMAINSCOUT_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')}"
REUSE_CREDENTIAL_HELPER="${DOMAINSCOUT_REUSE_CREDENTIAL_HELPER:-0}"
case "$REUSE_CREDENTIAL_HELPER" in
  0|1) : ;;
  *) echo "Invalid DOMAINSCOUT_REUSE_CREDENTIAL_HELPER: expected 0 or 1" >&2; exit 1 ;;
esac
CHECK_ONLY=0
RELOAD_SERVICE=1
for arg in "$@"; do
  if [ "$arg" = "--login" ]; then INSTALL_LOGIN_AGENT=1; fi
  if [ "$arg" = "--check" ]; then CHECK_ONLY=1; fi
  if [ "$arg" = "--defer-service-reload" ]; then RELOAD_SERVICE=0; fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  echo "Resolved DomainScout root: ${ROOT}"
  echo "Resolved DomainScout app path: ${APP_DIR}"
  exit 0
fi

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "Could not find node. Install Node or pass NODE_BIN=/path/to/node." >&2
  exit 1
fi

if [ "$APP_DIR" = "$SYSTEM_APP_DIR" ] && [ -L "$APP_DIR" ]; then
  unlink "$APP_DIR"
fi

mkdir -p "${USER_HOME}/Library/LaunchAgents" "$LOG_DIR" "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
mkdir -p "$CREDENTIAL_HELPER_DIR"
mkdir -p "$UPDATER_STATE_DIR"

BUNDLED_APP_BINARY="${ROOT}/artifacts/macos-arm64/DomainScout"
BUNDLED_APP_ICON="${ROOT}/artifacts/macos-arm64/DomainScout.icns"
BUNDLED_APP_CHECKSUM="${ROOT}/artifacts/macos-arm64/DomainScout.sha256"

verify_bundled_asset() {
  local file="$1" name="$2" expected actual
  expected="$(awk -v name="$name" '$2 == name { print $1; exit }' "$BUNDLED_APP_CHECKSUM")"
  actual="$(LC_ALL=C shasum -a 256 "$file" | awk '{ print $1 }')"
  if ! printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "Invalid bundled checksum for ${name}" >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Bundled ${name} checksum mismatch" >&2
    return 1
  fi
}

# The app binary cannot be overwritten while the app is running (build fails with
# "Text file busy"). Quit any running instance first.
osascript -e 'quit app "DomainScout"' >/dev/null 2>&1 || true
pkill -f "DomainScout.app/Contents/MacOS/DomainScout" >/dev/null 2>&1 || true
sleep 1

# Compile to a temp path, then move into place so a locked/failed compile never
# leaves a half-written or missing binary in the .app. Governed remote runs expose
# an authorized per-Run scratch directory; honor it instead of escaping into the
# host's private TMPDIR, which is intentionally outside the Action write scope.
if [ -n "${AGENTFORGE_SCRATCH_DIR:-}" ] && [ -d "$AGENTFORGE_SCRATCH_DIR" ]; then
  case "$AGENTFORGE_SCRATCH_DIR" in
    /*) TMP_BIN="$(mktemp "${AGENTFORGE_SCRATCH_DIR%/}/DomainScoutBuild.XXXXXX")" ;;
    *) echo "Ignoring non-absolute AGENTFORGE_SCRATCH_DIR" >&2; TMP_BIN="$(mktemp -t DomainScoutBuild)" ;;
  esac
else
  TMP_BIN="$(mktemp -t DomainScoutBuild)"
fi
if [ -f "$BUNDLED_APP_BINARY" ] && [ -f "$BUNDLED_APP_CHECKSUM" ]; then
  verify_bundled_asset "$BUNDLED_APP_BINARY" DomainScout
  cp "$BUNDLED_APP_BINARY" "$TMP_BIN"
else
  SWIFTC="$(command -v swiftc || xcrun --find swiftc 2>/dev/null || true)"
  if [ -z "$SWIFTC" ] || [ ! -x "$SWIFTC" ]; then
    echo "Could not find a verified bundled app or swiftc" >&2
    exit 1
  fi
  "$SWIFTC" "$SWIFT_APP_SOURCE" \
    -framework Cocoa \
    -framework WebKit \
    -O \
    -o "$TMP_BIN"
fi
mv -f "$TMP_BIN" "${APP_DIR}/Contents/MacOS/DomainScout"
# mktemp creates the staging file as 0600. `chmod +x` would preserve that
# restricted read mask and yield 0711, which LaunchServices can reject as
# kLSNoExecutableErr even though an interactive shell can execute it. Install
# a normal application executable mode explicitly so Finder, Dock, and `open`
# all resolve the bundle the same way.
chmod 755 "${APP_DIR}/Contents/MacOS/DomainScout"

# The provider credential helper stores only a hardware-encrypted Secure Enclave
# envelope under the user's Application Support directory. Its set operation reads
# the secret from stdin; no credential appears in argv, source, plist, or logs.
# A release owner may reuse the existing helper only after proving that its source
# is identical to the prior generation. The installer independently verifies the
# signed executable before trusting it. Secure Enclave operations are deliberately
# Aqua-session-bound on macOS, so the hardware self-test remains mandatory for a
# newly compiled helper and is not repeated from a headless release worker.
if [ "$REUSE_CREDENTIAL_HELPER" = "1" ]; then
  if [ ! -x "$CREDENTIAL_HELPER" ]; then
    echo "Verified credential-helper reuse requested but no executable helper is installed" >&2
    exit 1
  fi
  /usr/bin/codesign --verify --strict "$CREDENTIAL_HELPER"
  echo "Reusing source-identical signed credential helper; Secure Enclave runtime validation remains Aqua-session scoped."
else
  SWIFTC="$(command -v swiftc || true)"
  if [ -z "$SWIFTC" ] || [ ! -x "$SWIFTC" ]; then
    echo "Could not find swiftc required for the DomainScout device credential helper" >&2
    exit 1
  fi
  if [ -n "${AGENTFORGE_SCRATCH_DIR:-}" ] && [ -d "$AGENTFORGE_SCRATCH_DIR" ]; then
    CREDENTIAL_TMP="$(mktemp "${AGENTFORGE_SCRATCH_DIR%/}/DomainScoutCredentialBuild.XXXXXX")"
  else
    CREDENTIAL_TMP="$(mktemp -t DomainScoutCredentialBuild)"
  fi
  "$SWIFTC" "$SWIFT_CREDENTIAL_SOURCE" -framework CryptoKit -O -o "$CREDENTIAL_TMP"
  chmod 700 "$CREDENTIAL_TMP"
  /usr/bin/codesign --force --sign - "$CREDENTIAL_TMP"
  /usr/bin/codesign --verify --strict "$CREDENTIAL_TMP"
  "$CREDENTIAL_TMP" self-test --service domainscout.install.self-test --account hamp
  mv -f "$CREDENTIAL_TMP" "$CREDENTIAL_HELPER"
fi
chmod 700 "$CREDENTIAL_HELPER"

cat > "$CONFIG_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRoot</key>
  <string>${ROOT}</string>
  <key>NodeBin</key>
  <string>${NODE_BIN}</string>
  <key>Port</key>
  <integer>${PORT}</integer>
  <key>LogDir</key>
  <string>${LOG_DIR}</string>
  <key>BuildCommit</key>
  <string>${BUILD_COMMIT}</string>
</dict>
</plist>
PLIST

if [ -f "$BUNDLED_APP_ICON" ] && [ -f "$BUNDLED_APP_CHECKSUM" ]; then
  verify_bundled_asset "$BUNDLED_APP_ICON" DomainScout.icns
  cp "$BUNDLED_APP_ICON" "$ICON_FILE"
else
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  swift "${ROOT}/scripts/generate-macos-icon.swift" "${BUILD_DIR}/DomainScout-1024.png"
  sips -z 16 16     "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_16x16.png" >/dev/null
  sips -z 32 32     "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_16x16@2x.png" >/dev/null
  sips -z 32 32     "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_32x32.png" >/dev/null
  sips -z 64 64     "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_32x32@2x.png" >/dev/null
  sips -z 128 128   "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_128x128.png" >/dev/null
  sips -z 256 256   "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_128x128@2x.png" >/dev/null
  sips -z 256 256   "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_256x256.png" >/dev/null
  sips -z 512 512   "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_256x256@2x.png" >/dev/null
  sips -z 512 512   "${BUILD_DIR}/DomainScout-1024.png" --out "${ICONSET}/icon_512x512.png" >/dev/null
  cp "${BUILD_DIR}/DomainScout-1024.png" "${ICONSET}/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$ICON_FILE"
fi

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>DomainScout</string>
  <key>CFBundleIdentifier</key>
  <string>com.hamp.domainscout.launcher</string>
  <key>CFBundleName</key>
  <string>DomainScout</string>
  <key>CFBundleDisplayName</key>
  <string>DomainScout</string>
  <key>CFBundleIconFile</key>
  <string>DomainScout</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>BuildCommit</key>
  <string>${BUILD_COMMIT}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

# The release artifact is signed as a standalone Mach-O so its checksum can be
# verified before installation. Once that binary is placed inside a bundle with
# Info.plist and resources, the standalone signature is no longer a valid app
# signature. Seal the completed bundle in place so LaunchServices, Finder, and
# Dock all recognize the same executable and resource set.
/usr/bin/codesign --force --sign - "$APP_DIR"
/usr/bin/codesign --verify --deep --strict "$APP_DIR"

RUN_AT_LOAD_XML="<false/>"
KEEP_ALIVE_XML="<false/>"
if [ "$INSTALL_LOGIN_AGENT" = "1" ]; then
  RUN_AT_LOAD_XML="<true/>"
  KEEP_ALIVE_XML="<true/>"
fi

# One stable preflight owns the installed-code boundary. Every supervised server
# start first converges and verifies the tracked production source, then replaces
# itself with Node. The local HTTP service therefore cannot serve a marker-only,
# drifted, or superseded generation.
cat > "$CURRENT_SERVER_RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export DOMAINSCOUT_ROOT=$(printf '%q' "$ROOT")
export DOMAINSCOUT_USER_HOME=$(printf '%q' "$USER_HOME")
export DOMAINSCOUT_APP_DIR=$(printf '%q' "$APP_DIR")
export PORT=$(printf '%q' "$PORT")
if [ "\${DOMAINSCOUT_UPDATER_ACTIVE:-0}" != "1" ]; then
  $(printf '%q' "$UPDATER_SCRIPT")
fi
cd $(printf '%q' "$ROOT")
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$ROOT/server/index.js")
RUNNER
chmod 755 "$CURRENT_SERVER_RUNNER"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CURRENT_SERVER_RUNNER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOMAINSCOUT_SKIP_DB_MAINTENANCE</key>
    <string>1</string>
    <key>DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED</key>
    <string>0</string>
    <key>DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY</key>
    <string>0</string>
    <key>DOMAINSCOUT_TLD_ACCURACY_WORKER</key>
    <string>0</string>
    <key>DOMAINSCOUT_GODADDY_WORKER</key>
    <string>1</string>
    <key>DOMAINSCOUT_GODADDY_STARTUP_PREWARM</key>
    <string>1</string>
    <key>DOMAINSCOUT_GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS</key>
    <string>900000</string>
    <key>DOMAINSCOUT_GODADDY_SERVE_MAX_AGE_MS</key>
    <string>1800000</string>
    <key>DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT</key>
    <string>0</string>
    <key>DOMAINSCOUT_CREDENTIAL_HELPER</key>
    <string>${CREDENTIAL_HELPER}</string>
    <key>DOMAINSCOUT_FTS_SYNC_ENABLED</key>
    <string>0</string>
    <key>DOMAINSCOUT_CCTLD_INDEX_WORKER</key>
    <string>0</string>
    <key>DOMAINSCOUT_MARKET_SIBLING_AUTOSCAN</key>
    <string>0</string>
    <key>TLDS_WORKER_SCOPE</key>
    <string>auction</string>
    <key>TLDS_WORKER_BATCH</key>
    <string>25</string>
    <key>TLDS_WORKER_DNS_CONCURRENCY</key>
    <string>160</string>
  </dict>
  <key>RunAtLoad</key>
  ${RUN_AT_LOAD_XML}
  <key>KeepAlive</key>
  ${KEEP_ALIVE_XML}
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.err.log</string>
</dict>
</plist>
PLIST

chmod 644 "$PLIST"

# Keep exact extension coverage independent from desktop startup. This dedicated
# provider-neutral worker maintains complete IANA-root receipts in the background;
# the foreground server only reads atomically published completed receipts.
cat > "$TLD_WORKER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TLD_WORKER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>server/tlds-worker.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOMAINSCOUT_SKIP_DB_MAINTENANCE</key>
    <string>1</string>
    <key>TLDS_WORKER_USE_ZONE</key>
    <string>1</string>
    <key>TLDS_WORKER_SCOPE</key>
    <string>auction</string>
    <key>TLDS_WORKER_WINDOW_DAYS</key>
    <string>10</string>
    <key>TLDS_WORKER_DNS_CONCURRENCY</key>
    <string>160</string>
    <key>TLDS_WORKER_DNS_TIMEOUT_MS</key>
    <string>1500</string>
    <key>TLDS_WORKER_NAME_CONCURRENCY</key>
    <string>24</string>
    <key>TLDS_WORKER_FETCH</key>
    <string>200</string>
    <key>TLDS_WORKER_TLD_BATCH</key>
    <string>250</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/tlds-worker.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/tlds-worker.err.log</string>
</dict>
</plist>
PLIST
chmod 644 "$TLD_WORKER_PLIST"

# Production is the desired state for every installed device. The updater is a
# stable copy outside ROOT so replacing the application source cannot replace
# the script that is currently executing. It performs its own HTTPS, immutable
# commit, branch-ancestry, full-test, rollback, and receipt checks.
cp "${ROOT}/scripts/update-from-release-channel.sh" "$UPDATER_SCRIPT"
chmod 755 "$UPDATER_SCRIPT"
cat > "$UPDATER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${UPDATER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${UPDATER_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOMAINSCOUT_RELEASE_CHANNEL_URL</key>
    <string>https://domainscout-production-ea0f.up.railway.app/api/release-channel</string>
    <key>DOMAINSCOUT_RELEASE_REPOSITORY</key>
    <string>https://github.com/Oldshue/DomainScout.git</string>
    <key>DOMAINSCOUT_RELEASE_BRANCH</key>
    <string>master</string>
    <key>DOMAINSCOUT_ROOT</key>
    <string>${ROOT}</string>
    <key>DOMAINSCOUT_BACKUP_ROOT</key>
    <string>${USER_HOME}/DomainScout-backups</string>
    <key>DOMAINSCOUT_USER_HOME</key>
    <string>${USER_HOME}</string>
    <key>DOMAINSCOUT_APP_DIR</key>
    <string>${APP_DIR}</string>
    <key>DOMAINSCOUT_UPDATE_STATE_DIR</key>
    <string>${UPDATER_STATE_DIR}</string>
    <key>PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/updater.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/updater.err.log</string>
</dict>
</plist>
PLIST
chmod 644 "$UPDATER_PLIST"

# A Mac can have a durable per-user background session without an Aqua login
# domain (for example, an always-on Mac reached only through SSH). macOS exposes
# user/<uid> in that state but refuses third-party plist bootstrap there. Keep a
# production-shaped fallback beside the stable updater: cron starts it every
# minute, while exact pid/command checks make server supervision idempotent.
# The installer removes these entries automatically when an Aqua domain exists,
# so one device never has competing launchd and cron owners.
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'ROOT=%q\n' "$ROOT"
  printf 'NODE_BIN=%q\n' "$NODE_BIN"
  printf 'PORT=%q\n' "$PORT"
  printf 'LOG_DIR=%q\n' "$LOG_DIR"
  printf 'STATE_DIR=%q\n' "$UPDATER_STATE_DIR"
  printf 'CREDENTIAL_HELPER=%q\n' "$CREDENTIAL_HELPER"
  printf 'CURRENT_SERVER_RUNNER=%q\n' "$CURRENT_SERVER_RUNNER"
  cat <<'HEADLESS_SCRIPT'

mkdir -p "$LOG_DIR" "$STATE_DIR"

pid_matches() {
  local pid_file="$1" script_path="$2" pid command
  [ -f "$pid_file" ] || return 1
  pid="$(tr -d '\r\n' < "$pid_file")"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in *"$script_path"*) return 0 ;; *) return 1 ;; esac
}

adopt_exact_server() {
  local pid_file="$1" lockfile="${ROOT}/data/server.lock.json" pid command cwd
  [ -f "$lockfile" ] || return 1
  pid="$("$NODE_BIN" -e 'const fs=require("fs"); try { const value=String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).pid ?? ""); if (/^[1-9][0-9]*$/.test(value)) process.stdout.write(value); } catch {}' "$lockfile" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in *"$NODE_BIN ${ROOT}/server/index.js"*) : ;; *) return 1 ;; esac
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2)}' || true)"
  [ "$cwd" = "$ROOT" ] || return 1
  printf '%s\n' "$pid" > "$pid_file"
}

stop_one() {
  local name="$1" script_path="$2" pid_file pid
  pid_file="${STATE_DIR}/${name}.pid"
  if [ "$name" = "server" ] && ! pid_matches "$pid_file" "$script_path"; then
    adopt_exact_server "$pid_file" || true
  fi
  if pid_matches "$pid_file" "$script_path"; then
    pid="$(tr -d '\r\n' < "$pid_file")"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
  rm -f "$pid_file"
}

start_server() {
  local script_path="${ROOT}/server/index.js" pid_file="${STATE_DIR}/server.pid" pid
  if ! pid_matches "$pid_file" "$script_path"; then
    adopt_exact_server "$pid_file" || true
  fi
  if pid_matches "$pid_file" "$script_path"; then return 0; fi
  rm -f "$pid_file"
  (
    cd "$ROOT"
    exec nohup env \
      PORT="$PORT" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 \
      DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED=0 \
      DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY=0 \
      DOMAINSCOUT_TLD_ACCURACY_WORKER=0 \
      DOMAINSCOUT_GODADDY_WORKER=1 \
      DOMAINSCOUT_GODADDY_STARTUP_PREWARM=1 \
      DOMAINSCOUT_GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS=900000 \
      DOMAINSCOUT_GODADDY_SERVE_MAX_AGE_MS=1800000 \
      DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT=0 \
      DOMAINSCOUT_CREDENTIAL_HELPER="$CREDENTIAL_HELPER" \
      DOMAINSCOUT_FTS_SYNC_ENABLED=0 \
      DOMAINSCOUT_CCTLD_INDEX_WORKER=0 \
      DOMAINSCOUT_MARKET_SIBLING_AUTOSCAN=0 \
      TLDS_WORKER_SCOPE=auction \
      TLDS_WORKER_BATCH=25 \
      TLDS_WORKER_DNS_CONCURRENCY=160 \
      DOMAINSCOUT_UPDATER_ACTIVE="${DOMAINSCOUT_UPDATER_ACTIVE:-0}" \
      "$CURRENT_SERVER_RUNNER" >>"${LOG_DIR}/server.log" 2>>"${LOG_DIR}/server.err.log" </dev/null
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  sleep 1
  pid_matches "$pid_file" "$script_path"
}

start_tld_worker() {
  local script_path="${ROOT}/server/tlds-worker.js" pid_file="${STATE_DIR}/tlds-worker.pid" pid
  local -a maintenance_runner
  if pid_matches "$pid_file" "$script_path"; then return 0; fi
  rm -f "$pid_file"
  maintenance_runner=(/usr/bin/nice -n 20)
  if [ -x /usr/sbin/taskpolicy ]; then
    maintenance_runner=(/usr/sbin/taskpolicy -b -d throttle -c maintenance /usr/bin/nice -n 20)
  fi
  (
    cd "$ROOT"
    exec nohup "${maintenance_runner[@]}" env \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 \
      TLDS_WORKER_USE_ZONE=1 \
      TLDS_WORKER_SCOPE=auction \
      TLDS_WORKER_WINDOW_DAYS=10 \
      TLDS_WORKER_DNS_CONCURRENCY=160 \
      TLDS_WORKER_DNS_TIMEOUT_MS=1500 \
      TLDS_WORKER_NAME_CONCURRENCY=24 \
      TLDS_WORKER_FETCH=200 \
      TLDS_WORKER_TLD_BATCH=250 \
      "$NODE_BIN" "$script_path" >>"${LOG_DIR}/tlds-worker.log" 2>>"${LOG_DIR}/tlds-worker.err.log" </dev/null
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  sleep 1
  pid_matches "$pid_file" "$script_path"
}

start_wal_watchdog() {
  local script_path="${ROOT}/scripts/zone-wal-watchdog.sh" pid_file="${STATE_DIR}/wal-watchdog.pid" pid
  if pid_matches "$pid_file" "$script_path"; then return 0; fi
  rm -f "$pid_file"
  (
    cd "$ROOT"
    exec nohup env \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      DOMAINSCOUT_ROOT="$ROOT" \
      NODE_BIN="$NODE_BIN" \
      DOMAINSCOUT_WAL_WATCHDOG_INTERVAL_SECONDS=60 \
      /bin/bash "$script_path" >>"${LOG_DIR}/wal-watchdog.log" 2>>"${LOG_DIR}/wal-watchdog.err.log" </dev/null
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  sleep 1
  pid_matches "$pid_file" "$script_path"
}

case "${1:-start}" in
  start) ;;
  restart)
    stop_one server "${ROOT}/server/index.js"
    stop_one tlds-worker "${ROOT}/server/tlds-worker.js"
    stop_one wal-watchdog "${ROOT}/scripts/zone-wal-watchdog.sh"
    ;;
  stop)
    stop_one server "${ROOT}/server/index.js"
    stop_one tlds-worker "${ROOT}/server/tlds-worker.js"
    stop_one wal-watchdog "${ROOT}/scripts/zone-wal-watchdog.sh"
    exit 0
    ;;
  *) printf 'usage: %s [start|restart|stop]\n' "$0" >&2; exit 2 ;;
esac

start_server
start_tld_worker
start_wal_watchdog
HEADLESS_SCRIPT
} > "$HEADLESS_SUPERVISOR"
chmod 700 "$HEADLESS_SUPERVISOR"

{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'export PATH=%q\n' '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  printf 'export DOMAINSCOUT_RELEASE_CHANNEL_URL=%q\n' 'https://domainscout-production-ea0f.up.railway.app/api/release-channel'
  printf 'export DOMAINSCOUT_RELEASE_REPOSITORY=%q\n' 'https://github.com/Oldshue/DomainScout.git'
  printf 'export DOMAINSCOUT_RELEASE_BRANCH=%q\n' 'master'
  printf 'export DOMAINSCOUT_ROOT=%q\n' "$ROOT"
  printf 'export DOMAINSCOUT_BACKUP_ROOT=%q\n' "${USER_HOME}/DomainScout-backups"
  printf 'export DOMAINSCOUT_USER_HOME=%q\n' "$USER_HOME"
  printf 'export DOMAINSCOUT_APP_DIR=%q\n' "$APP_DIR"
  printf 'export DOMAINSCOUT_UPDATE_STATE_DIR=%q\n' "$UPDATER_STATE_DIR"
  printf 'export PORT=%q\n' "$PORT"
  printf 'exec %q >>%q 2>>%q\n' "$UPDATER_SCRIPT" "${LOG_DIR}/updater.log" "${LOG_DIR}/updater.err.log"
} > "$UPDATER_RUNNER"
chmod 700 "$UPDATER_RUNNER"

replace_headless_cron() {
  local mode="$1" current filtered supervisor_escaped updater_escaped
  current="$(crontab -l 2>/dev/null || true)"
  filtered="$(printf '%s\n' "$current" | awk '
    !/# domainscout-headless-services$/ && !/# domainscout-production-updater$/ { print }
  ')"
  if [ "$mode" = "install" ]; then
    printf -v supervisor_escaped '%q' "$HEADLESS_SUPERVISOR"
    printf -v updater_escaped '%q' "$UPDATER_RUNNER"
    {
      if [ -n "$filtered" ]; then printf '%s\n' "$filtered"; fi
      printf '* * * * * /bin/bash %s # domainscout-headless-services\n' "$supervisor_escaped"
      printf '* * * * * /bin/bash %s # domainscout-production-updater\n' "$updater_escaped"
    } | crontab -
  else
    if [ -n "$filtered" ]; then printf '%s\n' "$filtered" | crontab -; else crontab -r 2>/dev/null || true; fi
  fi
}

reload_gui_service() {
  local service_label="$1" service_plist="$2" kickstart="$3" attempt
  launchctl bootout "gui/${UID}/${service_label}" >/dev/null 2>&1 \
    || launchctl bootout "gui/${UID}" "$service_plist" >/dev/null 2>&1 \
    || true
  # bootout acknowledgement can precede the service disappearing from the
  # launchd domain. Re-bootstrap only after exact-label absence, otherwise
  # macOS intermittently returns opaque bootstrap I/O error 5.
  attempt=0
  while launchctl print "gui/${UID}/${service_label}" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 100 ]; then
      echo "Timed out unloading ${service_label} from gui/${UID}" >&2
      return 1
    fi
    sleep 0.1
  done
  launchctl bootstrap "gui/${UID}" "$service_plist"
  launchctl enable "gui/${UID}/${service_label}" >/dev/null 2>&1 || true
  if [ "$kickstart" = "1" ]; then
    launchctl kickstart -k "gui/${UID}/${service_label}"
  fi
}

if [ "$RELOAD_SERVICE" = "1" ]; then
  if launchctl print "gui/${UID}" >/dev/null 2>&1; then
    replace_headless_cron remove
    "$HEADLESS_SUPERVISOR" stop
    # bootstrap only registers an on-demand service; it does not run one whose
    # RunAtLoad/KeepAlive flags are intentionally disabled. Start the freshly
    # registered generation exactly once so the bounded release health gate and
    # the desktop can reach it without treating "loaded" as "running".
    reload_gui_service "$LABEL" "$PLIST" 1
    reload_gui_service "$TLD_WORKER_LABEL" "$TLD_WORKER_PLIST" 1
    if [ "${DOMAINSCOUT_UPDATER_ACTIVE:-0}" != "1" ]; then
      reload_gui_service "$UPDATER_LABEL" "$UPDATER_PLIST" 1
    else
      echo "Updater definition refreshed; the active updater owns this release and remains running."
    fi
  else
    if [ "${DOMAINSCOUT_UPDATER_ACTIVE:-0}" != "1" ]; then
      replace_headless_cron install
    else
      echo "Retaining existing headless cron entries during updater-owned release."
    fi
    "$HEADLESS_SUPERVISOR" restart
    if [ "${DOMAINSCOUT_UPDATER_ACTIVE:-0}" != "1" ]; then
      "$UPDATER_RUNNER"
    else
      echo "Headless updater definition refreshed; the active updater owns this release and remains running."
    fi
    echo "No Aqua launchd domain; installed persistent per-user cron supervision."
  fi
fi
rm -f "${PLIST}.disabled"
rm -f "${TLD_WORKER_PLIST}.disabled"
rm -f "${UPDATER_PLIST}.disabled"

if [ "${DOMAINSCOUT_UPDATER_ACTIVE:-0}" = "1" ]; then
  # A background release owns application code and service definitions, not the
  # user's Finder/Dock state. launchd jobs can run in an Aqua domain without the
  # Files & Folders grant needed to replace a Desktop alias; treating that optional
  # convenience step as transactional would roll back an otherwise healthy update.
  echo "Retaining existing Desktop and Dock launchers during updater-owned release."
else
  "${ROOT}/scripts/consolidate-macos-app-launchers.sh" \
    "--app-name=DomainScout" \
    "--bundle-id=com.hamp.domainscout.launcher" \
    "--canonical-app=${APP_DIR}" \
    "--desktop-app=${DESKTOP_APP}" \
    "--legacy-app=$([ "$APP_DIR" = "$SYSTEM_APP_DIR" ] && printf '%s' "$USER_APP_DIR" || printf '%s' "$SYSTEM_APP_DIR")" \
    "--user-home=${USER_HOME}"
fi

touch "$APP_DIR"
qlmanage -r >/dev/null 2>&1 || true

echo "Installed DomainScout:"
echo "  App launcher: ${APP_DIR}"
echo "  Desktop icon: ${DESKTOP_APP}"
echo "  On-demand server: ${PLIST}"
echo "  Production updater: ${UPDATER_PLIST}"
echo "  Headless updater runner: ${UPDATER_RUNNER}"
if [ "$INSTALL_LOGIN_AGENT" = "1" ]; then
  if [ "$RELOAD_SERVICE" = "1" ]; then
    echo "  Login service: enabled"
  else
    echo "  Login service: definition prepared; restart deferred"
  fi
else
  echo "  Login service: disabled"
fi
echo "  Logs: ${LOG_DIR}"
