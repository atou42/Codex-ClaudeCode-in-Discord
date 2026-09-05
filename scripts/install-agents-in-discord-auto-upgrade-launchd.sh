#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

LABEL="${LABEL:-com.atou.agents-in-discord.auto-upgrade}"
SCHEDULE_HOUR="${SCHEDULE_HOUR:-8}"
SCHEDULE_MINUTE="${SCHEDULE_MINUTE:-30}"

if ! [[ "$SCHEDULE_HOUR" =~ ^[0-9]+$ ]] || ((SCHEDULE_HOUR < 0 || SCHEDULE_HOUR > 23)); then
  echo "invalid SCHEDULE_HOUR=${SCHEDULE_HOUR} (expected 0-23)" >&2
  exit 1
fi
if ! [[ "$SCHEDULE_MINUTE" =~ ^[0-9]+$ ]] || ((SCHEDULE_MINUTE < 0 || SCHEDULE_MINUTE > 59)); then
  echo "invalid SCHEDULE_MINUTE=${SCHEDULE_MINUTE} (expected 0-59)" >&2
  exit 1
fi

AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${AGENTS_DIR}/${LABEL}.plist"
UPGRADE_SCRIPT="${PROJECT_ROOT}/scripts/agent-cli-auto-upgrade.mjs"
STDOUT_PATH="${PROJECT_ROOT}/logs/agents-in-discord.auto-upgrade.log"
STDERR_PATH="${PROJECT_ROOT}/logs/agents-in-discord.auto-upgrade.err.log"
UID_VALUE="$(id -u)"
SERVICE_REF="gui/${UID_VALUE}/${LABEL}"

mkdir -p "${AGENTS_DIR}" "${PROJECT_ROOT}/logs"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>${UPGRADE_SCRIPT}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>LANG</key>
      <string>C.UTF-8</string>
      <key>LC_ALL</key>
      <string>C.UTF-8</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${SCHEDULE_HOUR}</integer>
      <key>Minute</key>
      <integer>${SCHEDULE_MINUTE}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${STDOUT_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_PATH}</string>
  </dict>
</plist>
EOF

chmod 644 "${PLIST_PATH}"

launchctl bootout "${SERVICE_REF}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST_PATH}"
launchctl enable "${SERVICE_REF}" >/dev/null 2>&1 || true
launchctl kickstart -k "${SERVICE_REF}"

echo "installed: ${PLIST_PATH}"
echo "service:   ${SERVICE_REF}"
echo "schedule:  daily at $(printf '%02d:%02d' "${SCHEDULE_HOUR}" "${SCHEDULE_MINUTE}")"
echo "logs:      ${STDOUT_PATH}"
