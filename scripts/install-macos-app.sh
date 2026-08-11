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
SWIFT_APP_SOURCE="${ROOT}/scripts/DomainScoutApp.swift"
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
DESKTOP_APP="${USER_HOME}/Desktop/DomainScout.app"
LOG_DIR="${USER_HOME}/Library/Logs/DomainScout"
BUILD_DIR="${ROOT}/build/macos-icon"
ICONSET="${BUILD_DIR}/DomainScout.iconset"
ICON_FILE="${APP_DIR}/Contents/Resources/DomainScout.icns"
CONFIG_FILE="${APP_DIR}/Contents/Resources/DomainScoutConfig.plist"
INSTALL_LOGIN_AGENT="${INSTALL_LOGIN_AGENT:-0}"
BUILD_COMMIT="${DOMAINSCOUT_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')}"
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
chmod +x "${APP_DIR}/Contents/MacOS/DomainScout"

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

RUN_AT_LOAD_XML="<false/>"
KEEP_ALIVE_XML="<false/>"
if [ "$INSTALL_LOGIN_AGENT" = "1" ]; then
  RUN_AT_LOAD_XML="<true/>"
  KEEP_ALIVE_XML="<true/>"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>server/index.js</string>
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
if [ "$RELOAD_SERVICE" = "1" ]; then
  launchctl bootout "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID}" "$PLIST"
  launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
fi
rm -f "${PLIST}.disabled"

if [ "$INSTALL_LOGIN_AGENT" = "1" ] && [ "$RELOAD_SERVICE" = "1" ]; then
  launchctl kickstart -k "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
fi

if [ -L "$DESKTOP_APP" ]; then
  unlink "$DESKTOP_APP"
fi
if [ ! -e "$DESKTOP_APP" ]; then
  ln -s "$APP_DIR" "$DESKTOP_APP"
fi

touch "$APP_DIR"
qlmanage -r >/dev/null 2>&1 || true

echo "Installed DomainScout:"
echo "  App launcher: ${APP_DIR}"
echo "  Desktop icon: ${DESKTOP_APP}"
echo "  On-demand server: ${PLIST}"
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
