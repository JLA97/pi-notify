# pi-notify

Native terminal notifications for [Pi](https://github.com/earendil-works/pi-coding-agent) — know the moment Pi needs you, even when the window is in the background.

## When it notifies

| Trigger | Meaning | Notification |
| --- | --- | --- |
| `agent_settled` | A full run finished — no auto-retry, compaction, or queued follow-up left. Pi is ready for your next message. | `Pi — Ready for input` |
| `tool_execution_start` for a dialog tool (e.g. [`askUserQuestion`](https://github.com/JLA97/pi-ask-user-question)) | The run is paused mid-flight, a dialog is open, and Pi is blocked waiting for your answer. These pauses never fire `agent_settled`, so without this hook they stay silent. | `Pi — Waiting for your answer` |

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
| `PI_NOTIFY_WAIT_TOOLS` | `askUserQuestion` | Comma-separated list of tool names that count as "waiting for the human". Add your own dialog tools here. |
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
