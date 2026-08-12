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
BUILD_DIR="${ROOT}/build/macos-icon"
ICONSET="${BUILD_DIR}/DomainScout.iconset"
ICON_FILE="${APP_DIR}/Contents/Resources/DomainScout.icns"
CONFIG_FILE="${APP_DIR}/Contents/Resources/DomainScoutConfig.plist"
CREDENTIAL_HELPER_DIR="${APP_DIR}/Contents/Helpers"
CREDENTIAL_HELPER="${CREDENTIAL_HELPER_DIR}/DomainScoutCredentialStore"
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
mkdir -p "$CREDENTIAL_HELPER_DIR"

BUNDLED_APP_BINARY="${ROOT}/artifacts/macos-arm64/DomainScout"
BUNDLED_APP_ICON="${ROOT}/artifacts/macos-arm64/DomainScout.icns"
BUNDLED_CREDENTIAL_HELPER="${ROOT}/artifacts/macos-arm64/DomainScoutCredentialStore"
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

scoped_temp_file() {
  local label="$1"
  if [ -n "${AGENTFORGE_SCRATCH_DIR:-}" ] && [ -d "$AGENTFORGE_SCRATCH_DIR" ]; then
    mktemp "${AGENTFORGE_SCRATCH_DIR%/}/${label}.XXXXXX"
  else
    mktemp -t "$label"
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
if [ -n "${AGENTFORGE_SCRATCH_DIR:-}" ] && [ -d "$AGENTFORGE_SCRATCH_DIR" ]; then
  CREDENTIAL_TMP="$(mktemp "${AGENTFORGE_SCRATCH_DIR%/}/DomainScoutCredentialBuild.XXXXXX")"
else
  CREDENTIAL_TMP="$(mktemp -t DomainScoutCredentialBuild)"
fi
compile_credential_helper() {
  local output="$1" error_log sdk_path tool_root object item
  error_log="$(scoped_temp_file DomainScoutCredentialCompileError)"
  if "$SWIFTC" "$SWIFT_CREDENTIAL_SOURCE" -framework CryptoKit -O -o "$output" 2>"$error_log"; then
    return 0
  fi
  if ! grep -q "redefinition of module 'SwiftBridging'" "$error_log"; then
    cat "$error_log" >&2
    return 1
  fi

  # A partially upgraded Command Line Tools install can contain two module maps
  # for SwiftBridging. Build through a temporary resource view containing exactly
  # one map; system toolchain bytes remain untouched.
  tool_root="$(mktemp -d "${TMPDIR:-/tmp}/domainscout-swift-toolchain.XXXXXX")"
  mkdir -p "$tool_root/bin" "$tool_root/lib/swift" "$tool_root/include/swift"
  cp /Library/Developer/CommandLineTools/usr/bin/swift-frontend "$tool_root/bin/swift-frontend"
  for item in /Library/Developer/CommandLineTools/usr/lib/swift/*; do
    ln -s "$item" "$tool_root/lib/swift/$(basename "$item")"
  done
  cp /Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap "$tool_root/include/swift/module.modulemap"
  cp /Library/Developer/CommandLineTools/usr/include/swift/bridging "$tool_root/include/swift/bridging"
  sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
  object="$tool_root/DomainScoutCredentialStore.o"
  "$tool_root/bin/swift-frontend" -frontend -c -primary-file "$SWIFT_CREDENTIAL_SOURCE" \
    -target "$(uname -m)-apple-macosx15.0" -enable-objc-interop -sdk "$sdk_path" \
    -resource-dir "$tool_root/lib/swift" -module-name DomainScoutCredentialStore -O -o "$object"
  /Library/Developer/CommandLineTools/usr/bin/clang "$object" -O3 --sysroot "$sdk_path" \
    --target="$(uname -m)-apple-macosx15.0" -L /Library/Developer/CommandLineTools/usr/lib/swift/macosx \
    -L "$sdk_path/usr/lib/swift" -framework CryptoKit -o "$output"
}

if [ -f "$BUNDLED_CREDENTIAL_HELPER" ] && [ -f "$BUNDLED_APP_CHECKSUM" ]; then
  verify_bundled_asset "$BUNDLED_CREDENTIAL_HELPER" DomainScoutCredentialStore
  cp "$BUNDLED_CREDENTIAL_HELPER" "$CREDENTIAL_TMP"
else
  SWIFTC="$(command -v swiftc || true)"
  if [ -z "$SWIFTC" ] || [ ! -x "$SWIFTC" ]; then
    echo "Could not find a verified bundled credential helper or swiftc" >&2
    exit 1
  fi
  compile_credential_helper "$CREDENTIAL_TMP"
fi
chmod 700 "$CREDENTIAL_TMP"
/usr/bin/codesign --force --sign - "$CREDENTIAL_TMP"
/usr/bin/codesign --verify --strict "$CREDENTIAL_TMP"
SELF_TEST_ERROR="$(scoped_temp_file DomainScoutCredentialSelfTestError)"
if ! "$CREDENTIAL_TMP" self-test --service domainscout.install.self-test --account hamp 2>"$SELF_TEST_ERROR"; then
  if grep -q 'NSOSStatusErrorDomain Code=-25308' "$SELF_TEST_ERROR"; then
    echo "Credential helper compiled and signed; Secure Enclave self-test deferred because this installer process lacks interaction authority." >&2
  else
    cat "$SELF_TEST_ERROR" >&2
    exit 1
  fi
fi
mv -f "$CREDENTIAL_TMP" "$CREDENTIAL_HELPER"
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
  LAUNCHCTL_ERROR="$(scoped_temp_file DomainScoutLaunchctlError)"
  if launchctl bootstrap "gui/${UID}" "$PLIST" 2>"$LAUNCHCTL_ERROR"; then
    launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
    # bootstrap only registers an on-demand service; it does not run one whose
    # RunAtLoad/KeepAlive flags are intentionally disabled. Start the freshly
    # registered generation exactly once so the bounded release health gate and
    # the desktop can reach it without treating "loaded" as "running".
    launchctl kickstart -k "gui/${UID}/${LABEL}"
  elif grep -q 'Domain does not support specified action' "$LAUNCHCTL_ERROR"; then
    # Headless automation can run as the correct user without owning the active
    # Aqua bootstrap namespace. The signed app starts the same server directly
    # when opened, so preserve the complete install and let the GUI process own
    # activation instead of rolling the release back after all assets were built.
    echo "GUI launchd activation deferred to DomainScout.app because this installer process has no Aqua bootstrap authority." >&2
  else
    cat "$LAUNCHCTL_ERROR" >&2
    exit 1
  fi
fi
rm -f "${PLIST}.disabled"

"${ROOT}/scripts/consolidate-macos-app-launchers.sh" \
  "--app-name=DomainScout" \
  "--bundle-id=com.hamp.domainscout.launcher" \
  "--canonical-app=${APP_DIR}" \
  "--desktop-app=${DESKTOP_APP}" \
  "--legacy-app=$([ "$APP_DIR" = "$SYSTEM_APP_DIR" ] && printf '%s' "$USER_APP_DIR" || printf '%s' "$SYSTEM_APP_DIR")" \
  "--user-home=${USER_HOME}"

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
