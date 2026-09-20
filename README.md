# pi-notify

Native terminal notifications for [Pi](https://github.com/earendil-works/pi-coding-agent) — know the moment Pi needs you, even when the window is in the background.

## When it notifies

| Trigger | Meaning | Notification |
| --- | --- | --- |
| `agent_settled` | A full run finished — no auto-retry, compaction, or queued follow-up left. Pi is ready for your next message. | `Pi — Ready for input` |
| `ui_prompt_start` (pi 0.84.4+) | Any extension opened a blocking dialog (`ctx.ui` select/confirm/input/editor/custom) — the run is paused mid-flight and Pi is blocked waiting for your answer. These pauses never fire `agent_settled`, so without this hook they stay silent. Covers [`askUserQuestion`](https://github.com/JLA97/pi-ask-user-question) and every other dialog tool — no tool list to maintain. | `Pi — Waiting: <prompt title>` |
| `tool_execution_start` for a wait tool (fallback, default `askUserQuestion`) | Same pause, detected by tool name instead of the dialog itself. Used on pi versions without `ui_prompt_start` events, in no-UI environments, and for tools that block on a human without opening a `ctx.ui` dialog. | `Pi — Waiting for your answer` |

Rapid waiting notifications are coalesced: if both triggers fire for the same dialog, or a dialog opens within 2s of the previous one (e.g. a select followed by a follow-up input), you get one notification. A wait more than 2s after the last one always notifies.

## Terminal support

The backend is picked automatically from your environment:

| Environment | Backend | Terminals |
| --- | --- | --- |
| macOS (default) | macOS native notification (`osascript`) | any terminal, tmux included |
| `WT_SESSION` set (WSL) | Windows toast | Windows Terminal |
| `KITTY_WINDOW_ID` set (non-macOS) | OSC 99 | Kitty |
| Default (non-macOS) | OSC 777 | Ghostty, iTerm2, WezTerm, rxvt-unicode |

> **Why macOS defaults to native notifications:** they work inside tmux (which
> intercepts OSC sequences written to the pane) and regardless of the terminal's
> OSC support or its notification permission. If your terminal delivers OSC
> notifications and you prefer them (notification is attributed to the terminal,
> clicking can focus it), force it with `PI_NOTIFY_BACKEND=osc-777` (or `osc-99`).
> OSC writes go directly to `/dev/tty` when available, bypassing TUI-owned stdout.

## Install

```bash
pi install git:github.com/JLA97/pi-notify
```

Then restart Pi. To try it without installing:

```bash
pi -e git:github.com/JLA97/pi-notify
```

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PI_NOTIFY_WAIT_TOOLS` | `askUserQuestion` | Comma-separated tool names for the fallback trigger: tools that block waiting for the human. Dialog tools using `ctx.ui` are already covered by `ui_prompt_start`; add tools here only if they wait without opening a `ctx.ui` dialog. |
| `PI_NOTIFY_BACKEND` | auto | Force a backend: `macos-notification`, `windows-toast`, `osc-99`, or `osc-777`. |
| `PI_NOTIFY_DISABLE` | unset | Set to `1` or `true` to silence all notifications. |

## Development

```bash
npm install
npm test        # node --test via tsx
npm run typecheck
```

- `extensions/index.ts` is the extension entry; pure helpers (`pickBackend`, `buildOSC777`, …) are exported for testing.
- `tests/index.test.ts` injects stdout/child-process fakes, so tests never touch your real terminal.

## License

[MIT](LICENSE)
