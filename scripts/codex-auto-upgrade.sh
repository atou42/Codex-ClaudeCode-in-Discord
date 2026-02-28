#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

LOCK_DIR="${TMPDIR:-/tmp}/codex-cli-auto-upgrade.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another upgrade run is in progress; skip."
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

BREW_BIN="${BREW_BIN:-$(command -v brew || true)}"
CODEX_CASK_NAME="${CODEX_CASK_NAME:-codex}"
BOT_LABEL="${BOT_LABEL:-com.atou.codex-discord-bot}"
UID_VALUE="$(id -u)"

if [[ -z "$BREW_BIN" ]]; then
  log "brew not found; cannot upgrade codex."
  exit 1
fi

if "$BREW_BIN" list --cask "$CODEX_CASK_NAME" >/dev/null 2>&1; then
  before_version="$("$BREW_BIN" list --cask --versions "$CODEX_CASK_NAME" | awk '{print $2}')"
else
  before_version="not-installed"
fi
log "codex before: ${before_version}"

if [[ "${CODEX_UPGRADE_SKIP_BREW_UPDATE:-0}" != "1" ]]; then
  log "running brew update..."
  "$BREW_BIN" update --quiet
fi

outdated="$("$BREW_BIN" outdated --cask "$CODEX_CASK_NAME" 2>/dev/null || true)"
if [[ -z "$outdated" ]]; then
  log "no codex update available."
  exit 0
fi

log "upgrading ${CODEX_CASK_NAME}..."
"$BREW_BIN" upgrade --cask "$CODEX_CASK_NAME"

after_version="$("$BREW_BIN" list --cask --versions "$CODEX_CASK_NAME" | awk '{print $2}')"
log "codex after: ${after_version}"

if [[ -n "$BOT_LABEL" ]]; then
  service_ref="gui/${UID_VALUE}/${BOT_LABEL}"
  if launchctl print "$service_ref" >/dev/null 2>&1; then
    log "restarting ${BOT_LABEL}..."
    launchctl kickstart -k "$service_ref"
    log "restart requested for ${BOT_LABEL}."
  else
    log "bot service ${BOT_LABEL} not found; skip restart."
  fi
fi

log "codex auto-upgrade run completed."
