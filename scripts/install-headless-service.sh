#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PORT="${PORT:-3737}"
LABEL="${LABEL:-com.hamp.domainscout}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/DomainScout"

for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#*=}" ;;
    --label=*) LABEL="${arg#*=}"; PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist" ;;
  esac
done

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Could not find node. Install Node or pass NODE_BIN=/path/to/node." >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR"
chmod +x "${ROOT}/scripts/domainscout-service"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/domainscout-service</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>DOMAINSCOUT_HEADLESS</key>
    <string>1</string>
    <key>DISABLE_AUTH</key>
    <string>1</string>
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
LAUNCHD_DOMAIN="gui/${UID}"
if ! launchctl print "$LAUNCHD_DOMAIN" >/dev/null 2>&1; then
  LAUNCHD_DOMAIN="user/${UID}"
fi
launchctl bootout "$LAUNCHD_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST"
launchctl enable "${LAUNCHD_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${LAUNCHD_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

echo "Installed headless DomainScout service:"
echo "  Root: ${ROOT}"
echo "  Plist: ${PLIST}"
echo "  Port: ${PORT}"
echo "  Launchd domain: ${LAUNCHD_DOMAIN}"
echo "  Logs: ${LOG_DIR}"
