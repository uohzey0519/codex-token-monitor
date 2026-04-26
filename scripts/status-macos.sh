#!/usr/bin/env bash
set -euo pipefail

UID_VALUE="$(id -u)"

launchctl print "gui/$UID_VALUE/ai.codex.token-monitor" 2>/dev/null | sed -n '1,45p' || {
  echo "ai.codex.token-monitor is not loaded."
}

echo

launchctl print "gui/$UID_VALUE/ai.codex.token-menubar" 2>/dev/null | sed -n '1,45p' || {
  echo "ai.codex.token-menubar is not loaded."
}
