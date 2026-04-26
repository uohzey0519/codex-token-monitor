#!/usr/bin/env bash
set -euo pipefail

UID_VALUE="$(id -u)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
MONITOR_LABEL="ai.codex.token-monitor"
MENUBAR_LABEL="ai.codex.token-menubar"

launchctl bootout "gui/$UID_VALUE/$MONITOR_LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_VALUE/$MENUBAR_LABEL" 2>/dev/null || true
rm -f "$LAUNCH_AGENTS/$MONITOR_LABEL.plist"
rm -f "$LAUNCH_AGENTS/$MENUBAR_LABEL.plist"

echo "Codex Token Monitor LaunchAgents removed."
echo "Local logs, this repository, and ~/.codex/sessions were left untouched."
