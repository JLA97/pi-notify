/**
 * pi-notify
 *
 * Sends a native terminal notification when Pi is waiting for you:
 * - `agent_settled`: a full run finished (no retry / compaction / queued
 *   follow-up left) — Pi is ready for your next message.
 * - `tool_execution_start` for dialog tools (e.g. askUserQuestion): the run
 *   is paused mid-flight waiting for your answer. These pauses never fire
 *   `agent_settled`, so without this hook they would notify nothing.
 *
 * Terminal protocol support:
 * - macOS native (osascript): used when running inside tmux, which swallows
 *   OSC sequences unless allow-passthrough is enabled
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode (default)
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

/**
 * OSC sequences must reach the outer terminal. In fullscreen TUI mode the
 * app may own/wrap stdout, so write directly to the controlling tty and
 * fall back to stdout. Set PI_NOTIFY_STDOUT_ONLY=1 to force stdout (tests,
 * or piping into another consumer).
 */
export function writeForTerminal(chunk: string): void {
  if (process.env.PI_NOTIFY_STDOUT_ONLY === "1") {
    process.stdout.write(chunk);
    return;
  }
  try {
    const fd = fs.openSync("/dev/tty", "w");
    try {
      fs.writeSync(fd, chunk);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    process.stdout.write(chunk);
  }
}

/** Tools that block on a human-facing dialog. Override via PI_NOTIFY_WAIT_TOOLS. */
const DEFAULT_WAIT_TOOLS = ["askUserQuestion"];

export function parseWaitTools(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_WAIT_TOOLS];
  const tools = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : [...DEFAULT_WAIT_TOOLS];
}

export function isDisabled(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

export function buildOSC777(title: string, body: string): string {
  return `\x1b]777;notify;${title};${body}\x07`;
}

export function buildOSC99Parts(title: string, body: string): string[] {
  // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
  return [
    `\x1b]99;i=1:d=0;${title}\x1b\\`,
    `\x1b]99;i=1:p=body;${body}\x1b\\`,
  ];
}

export type NotifyBackend = "macos-notification" | "windows-toast" | "osc-99" | "osc-777";

export const BACKENDS: readonly NotifyBackend[] = [
  "macos-notification",
  "windows-toast",
  "osc-99",
  "osc-777",
];

export function pickBackend(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NotifyBackend {
  const forced = env.PI_NOTIFY_BACKEND as NotifyBackend | undefined;
  if (forced) {
    if (BACKENDS.includes(forced)) return forced;
    // Unknown override: ignore it rather than stay silent.
  }
  if (env.WT_SESSION) return "windows-toast";
  // tmux intercepts the pane's output, so OSC sequences written to stdout
  // never reach the outer terminal. Fall back to a native notification.
  if (env.TMUX && platform === "darwin") return "macos-notification";
  if (env.KITTY_WINDOW_ID) return "osc-99";
  return "osc-777";
}

/** Injectable IO so tests never touch the real stdout / child processes. */
export type NotifyIO = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  write?: (chunk: string) => void;
  execFile?: (file: string, args: string[]) => void;
};

function defaultExecFile(io: NotifyIO): (file: string, args: string[]) => void {
  return (
    io.execFile ??
    ((file: string, args: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFile: run } = require("child_process") as typeof import("child_process");
      run(file, args);
    })
  );
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function macosNotificationScript(title: string, body: string): string {
  return `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
}

export function notify(title: string, body: string, io: NotifyIO = {}): void {
  const env = io.env ?? process.env;
  const write = io.write ?? writeForTerminal;
  const backend = pickBackend(env, io.platform);

  if (backend === "windows-toast") {
    const execFile = defaultExecFile(io);
    execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
    return;
  }

  if (backend === "macos-notification") {
    const execFile = defaultExecFile(io);
    execFile("osascript", ["-e", macosNotificationScript(title, body)]);
    return;
  }

  if (backend === "osc-99") {
    for (const part of buildOSC99Parts(title, body)) write(part);
    return;
  }

  write(buildOSC777(title, body));
}

export default function (pi: ExtensionAPI): void {
  if (isDisabled(process.env.PI_NOTIFY_DISABLE)) return;

  const waitTools = new Set(parseWaitTools(process.env.PI_NOTIFY_WAIT_TOOLS));

  // `agent_end` fires after each low-level run; Pi may still retry, compact,
  // or continue with queued follow-ups. Notify only after the full run settles.
  pi.on("agent_settled", async () => {
    notify("Pi", "Ready for input");
  });

  // Tools that open a dialog and block waiting for the human (e.g.
  // askUserQuestion) pause the run without settling it, so the handler
  // above stays silent. Notify when such a tool starts waiting.
  pi.on("tool_execution_start", async (event) => {
    if (waitTools.has(event.toolName)) {
      notify("Pi", "Waiting for your answer");
    }
  });
}
