#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/hamp/Desktop/Projects/DomainScout"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
PORT="${PORT:-3737}"
LABEL="com.hamp.domainscout"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
USER_APP_DIR="${HOME}/Applications/DomainScout.app"
SYSTEM_APP_DIR="/Applications/DomainScout.app"
if [ -w "/Applications" ]; then
  APP_DIR="$SYSTEM_APP_DIR"
else
  APP_DIR="$USER_APP_DIR"
fi
DESKTOP_APP="${HOME}/Desktop/DomainScout.app"
LOG_DIR="${HOME}/Library/Logs/DomainScout"
BUILD_DIR="${ROOT}/build/macos-icon"
ICONSET="${BUILD_DIR}/DomainScout.iconset"
ICON_FILE="${APP_DIR}/Contents/Resources/DomainScout.icns"
INSTALL_LOGIN_AGENT="${INSTALL_LOGIN_AGENT:-0}"
for arg in "$@"; do
  if [ "$arg" = "--login" ]; then INSTALL_LOGIN_AGENT=1; fi
done

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

mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"

cp "${ROOT}/scripts/domainscout-open" "${APP_DIR}/Contents/MacOS/DomainScout"
chmod +x "${APP_DIR}/Contents/MacOS/DomainScout"

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
</dict>
</plist>
PLIST

if [ "$INSTALL_LOGIN_AGENT" = "1" ]; then
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
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.err.log</string>
</dict>
</plist>
PLIST

  chmod 644 "$PLIST"
  launchctl bootout "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID}" "$PLIST"
  launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
else
  launchctl bootout "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
  if [ -f "$PLIST" ]; then mv "$PLIST" "${PLIST}.disabled"; fi
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
if [ "$INSTALL_LOGIN_AGENT" = "1" ]; then
  echo "  Login service: ${PLIST}"
else
  echo "  Login service: disabled"
fi
echo "  Logs: ${LOG_DIR}"
