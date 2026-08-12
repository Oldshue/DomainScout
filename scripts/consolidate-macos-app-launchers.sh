#!/usr/bin/env bash
set -euo pipefail

APP_NAME=""
BUNDLE_ID=""
CANONICAL_APP=""
DESKTOP_APP=""
LEGACY_APP=""
USER_HOME="${HOME}"
DEFAULTS_DOMAIN="com.apple.dock"
RESTART_DOCK="1"
for arg in "$@"; do
  case "$arg" in
    --app-name=*) APP_NAME="${arg#*=}" ;;
    --bundle-id=*) BUNDLE_ID="${arg#*=}" ;;
    --canonical-app=*) CANONICAL_APP="${arg#*=}" ;;
    --desktop-app=*) DESKTOP_APP="${arg#*=}" ;;
    --legacy-app=*) LEGACY_APP="${arg#*=}" ;;
    --user-home=*) USER_HOME="${arg#*=}" ;;
    --defaults-domain=*) DEFAULTS_DOMAIN="${arg#*=}" ;;
    --no-restart-dock) RESTART_DOCK="0" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

for value in "$APP_NAME" "$BUNDLE_ID" "$CANONICAL_APP" "$DESKTOP_APP" "$USER_HOME"; do
  if [ -z "$value" ]; then
    echo "Missing required launcher-consolidation argument" >&2
    exit 2
  fi
done
case "$CANONICAL_APP:$DESKTOP_APP:$USER_HOME" in
  /*:/*:/*) ;;
  *) echo "Launcher paths must be absolute" >&2; exit 2 ;;
esac
if [ "$CANONICAL_APP" = "/" ] || [ "$DESKTOP_APP" = "/" ] || [ "$USER_HOME" = "/" ]; then
  echo "Launcher paths must not be root" >&2
  exit 2
fi
if [ ! -d "$CANONICAL_APP" ]; then
  echo "Canonical app does not exist: $CANONICAL_APP" >&2
  exit 2
fi
CANONICAL_APP="$(cd -P "$CANONICAL_APP" >/dev/null 2>&1 && pwd)"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
RETIRE_ROOT="${USER_HOME}/Library/Application Support/${APP_NAME}/Retired Launchers"

unregister_app() {
  local app="$1"
  if [ -x "$LSREGISTER" ] && [ -e "$app" ]; then
    "$LSREGISTER" -u "$app" >/dev/null 2>&1 || true
  fi
}

if [ -L "$DESKTOP_APP" ]; then
  unregister_app "$DESKTOP_APP"
  unlink "$DESKTOP_APP"
elif [ -e "$DESKTOP_APP" ]; then
  unregister_app "$DESKTOP_APP"
  mkdir -p "$RETIRE_ROOT"
  RETIRED_APP="${RETIRE_ROOT}/${APP_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-$$.app.silo"
  mv "$DESKTOP_APP" "$RETIRED_APP"
  echo "Retired stale launcher: $RETIRED_APP"
fi
ln -s "$CANONICAL_APP" "$DESKTOP_APP"

if [ -n "$LEGACY_APP" ] && [ "$LEGACY_APP" != "$CANONICAL_APP" ]; then
  unregister_app "$LEGACY_APP"
  if [ -L "$LEGACY_APP" ]; then
    unlink "$LEGACY_APP"
  elif [ -e "$LEGACY_APP" ]; then
    mkdir -p "$RETIRE_ROOT"
    RETIRED_LEGACY="${RETIRE_ROOT}/${APP_NAME}-legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$.app.silo"
    mv "$LEGACY_APP" "$RETIRED_LEGACY"
    echo "Retired stale app bundle: $RETIRED_LEGACY"
  fi
  mkdir -p "$(dirname "$LEGACY_APP")"
  ln -s "$CANONICAL_APP" "$LEGACY_APP"
fi
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$CANONICAL_APP" >/dev/null 2>&1 || true
fi

if [ -x /usr/bin/osascript ]; then
  DOCK_ARGS=(
    -l JavaScript
    "$SCRIPT_DIR/consolidate-macos-dock.js"
    --app-name "$APP_NAME" \
    --bundle-id "$BUNDLE_ID" \
    --canonical-app "$CANONICAL_APP" \
    --defaults-domain "$DEFAULTS_DOMAIN"
  )
  if /usr/bin/osascript "${DOCK_ARGS[@]}"; then
    if [ "$RESTART_DOCK" = "1" ] && [ "$DEFAULTS_DOMAIN" = "com.apple.dock" ]; then
      /usr/bin/killall Dock >/dev/null 2>&1 || true
    fi
  else
    echo "Warning: Dock launcher could not be consolidated; Desktop launcher is current." >&2
  fi
else
  echo "Warning: osascript is unavailable; Desktop launcher is current but Dock was not changed." >&2
fi

echo "Canonical launcher: $CANONICAL_APP"
echo "Desktop launcher: $DESKTOP_APP"
