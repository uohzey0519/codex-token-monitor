# Codex Token Monitor

A local Codex usage monitor for `~/.codex/sessions`.

It includes a web dashboard and a tiny macOS menu bar item. Everything runs on
`127.0.0.1`; session data is read locally and is not uploaded anywhere.

## Features

- Daily, monthly, recent-window, and all-time token totals
- Estimated cost by pricing model, including cached input tokens
- Event-time accounting, so usage is grouped by when tokens were spent rather
  than by when a session file was created
- macOS menu bar display for today's estimated cost and total tokens
- Menu bar text color changes with the 5-hour primary usage window
- LaunchAgent install/uninstall scripts for start-on-login behavior

## Requirements

- macOS
- Node.js 20+
- Codex session files under `~/.codex/sessions`

## Install

```bash
git clone https://github.com/uohzey-ai/codex-token-monitor.git
cd codex-token-monitor
npm run install:macos
```

Open the dashboard:

```text
http://127.0.0.1:48731
```

The installer writes two LaunchAgents:

- `ai.codex.token-monitor`: local HTTP dashboard/API
- `ai.codex.token-menubar`: macOS menu bar helper

## Menu Bar

The menu bar item shows:

```text
$today_estimated_cost / today_total_tokens
```

By default it estimates with `gpt-5.5`. The text color follows the latest
5-hour primary window usage:

```text
mint -> honey -> peach -> rose
```

To choose another model at install time:

```bash
CODEX_TOKEN_MENU_MODEL=gpt-5.4 npm run install:macos
```

## Configuration

These environment variables are captured into the LaunchAgent plist during
installation:

```bash
HOST=127.0.0.1
PORT=48731
CODEX_SESSIONS_ROOT="$HOME/.codex/sessions"
CODEX_TOKEN_MENU_MODEL=gpt-5.5
```

Example:

```bash
PORT=49888 CODEX_TOKEN_MENU_MODEL=gpt-5.4 npm run install:macos
```

## Commands

```bash
npm start                  # run the local dashboard in the foreground
npm run install:macos      # install and start LaunchAgents
npm run uninstall:macos    # stop and remove LaunchAgents
npm run status:macos       # show LaunchAgent status
npm run check              # syntax-check server and menu bar helper
```

## Privacy

The app reads local JSONL files from your Codex sessions directory. It exposes
only a local HTTP server bound to `127.0.0.1` by default.

Cost numbers are estimates. They use the pricing table embedded in
`server.js`, and session logs may not always expose the exact model used for
each request.

## License

MIT
