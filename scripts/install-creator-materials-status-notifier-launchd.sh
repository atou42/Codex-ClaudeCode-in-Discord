#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LABEL="com.atou.agents-in-discord.creator-materials-status"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
SERVICE_REF="gui/$(id -u)/${LABEL}"
NODE_BIN="/opt/homebrew/bin/node"
NOTIFIER_SCRIPT="${PROJECT_ROOT}/scripts/creator-materials-status-notifier.mjs"
STDOUT_PATH="${PROJECT_ROOT}/logs/creator-materials-status-notifier.log"
STDERR_PATH="${PROJECT_ROOT}/logs/creator-materials-status-notifier.err.log"

[[ -x "${NODE_BIN}" ]] || { printf 'missing Node executable: %s\n' "${NODE_BIN}" >&2; exit 1; }
[[ -f "${NOTIFIER_SCRIPT}" ]] || { printf 'missing notifier script: %s\n' "${NOTIFIER_SCRIPT}" >&2; exit 1; }
command -v cohub >/dev/null 2>&1 || { printf 'cohub is not available in PATH\n' >&2; exit 1; }

mkdir -p "${PLIST_DIR}" "${PROJECT_ROOT}/logs"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${NOTIFIER_SCRIPT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>LANG</key>
      <string>C.UTF-8</string>
      <key>LC_ALL</key>
      <string>C.UTF-8</string>
    </dict>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${STDOUT_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_PATH}</string>
  </dict>
</plist>
EOF

chmod 600 "${PLIST_PATH}"
/usr/bin/plutil -lint "${PLIST_PATH}" >/dev/null
/bin/launchctl bootout "${SERVICE_REF}" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
/bin/launchctl enable "${SERVICE_REF}" >/dev/null
/bin/launchctl kickstart -k "${SERVICE_REF}"

printf 'installed: %s\n' "${PLIST_PATH}"
printf 'service: %s\n' "${SERVICE_REF}"
printf 'interval: 300 seconds\n'
