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
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode (default)
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export type NotifyBackend = "windows-toast" | "osc-99" | "osc-777";

export function pickBackend(env: NodeJS.ProcessEnv): NotifyBackend {
  if (env.WT_SESSION) return "windows-toast";
  if (env.KITTY_WINDOW_ID) return "osc-99";
  return "osc-777";
}

/** Injectable IO so tests never touch the real stdout / child processes. */
export type NotifyIO = {
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  execFile?: (file: string, args: string[]) => void;
};

export function notify(title: string, body: string, io: NotifyIO = {}): void {
  const env = io.env ?? process.env;
  const write = io.write ?? ((chunk: string) => process.stdout.write(chunk));
  const backend = pickBackend(env);

  if (backend === "windows-toast") {
    const execFile =
      io.execFile ??
      ((file: string, args: string[]) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execFile: run } = require("child_process") as typeof import("child_process");
        run(file, args);
      });
    execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
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
