#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_VALUE="$(id -u)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
MONITOR_LABEL="ai.codex.token-monitor"
MENUBAR_LABEL="ai.codex.token-menubar"
MONITOR_PLIST="$LAUNCH_AGENTS/$MONITOR_LABEL.plist"
MENUBAR_PLIST="$LAUNCH_AGENTS/$MENUBAR_LABEL.plist"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-48731}"
CODEX_SESSIONS_ROOT="${CODEX_SESSIONS_ROOT:-$HOME/.codex/sessions}"
CODEX_TOKEN_MENU_MODEL="${CODEX_TOKEN_MENU_MODEL:-gpt-5.5}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required. Install Node, then rerun: npm run install:macos" >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ is required, found $("$NODE_BIN" -v)." >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS"

cat > "$MONITOR_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$MONITOR_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>$HOST</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>CODEX_SESSIONS_ROOT</key>
    <string>$CODEX_SESSIONS_ROOT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/codex-token-monitor.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codex-token-monitor.err</string>
</dict>
</plist>
PLIST

cat > "$MENUBAR_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$MENUBAR_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>-l</string>
    <string>JavaScript</string>
    <string>$ROOT/menubar/CodexTokenMenuBar.jxa</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_TOKEN_MENU_MODEL</key>
    <string>$CODEX_TOKEN_MENU_MODEL</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/codex-token-menubar.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codex-token-menubar.err</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$UID_VALUE/$MONITOR_LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_VALUE/$MENUBAR_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_VALUE" "$MONITOR_PLIST"
launchctl bootstrap "gui/$UID_VALUE" "$MENUBAR_PLIST"
launchctl kickstart -k "gui/$UID_VALUE/$MONITOR_LABEL"
launchctl kickstart -k "gui/$UID_VALUE/$MENUBAR_LABEL"

echo "Codex Token Monitor installed."
echo "Dashboard: http://$HOST:$PORT"
echo "Menu bar model: $CODEX_TOKEN_MENU_MODEL"
