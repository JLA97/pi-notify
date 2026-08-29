import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notifyExtension, {
  buildOSC777,
  buildOSC99Parts,
  isDisabled,
  macosNotificationScript,
  notify,
  parseWaitTools,
  pickBackend,
  windowsToastScript,
} from "../extensions/index.ts";

type Handler = (event?: unknown) => Promise<void> | void;

type CapturedHandlers = {
  events: string[];
  handlers: Map<string, Handler>;
};

function register(handlers: CapturedHandlers): ExtensionAPI {
  return {
    on(event: string, handler: Handler) {
      handlers.events.push(event);
      handlers.handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
}

/** Run `fn` with stdout.write captured, TMUX unset, and writes forced to stdout (no real notifications). */
function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const hadTmux = "TMUX" in process.env;
  const tmux = process.env.TMUX;
  const hadForce = "PI_NOTIFY_STDOUT_ONLY" in process.env;
  const force = process.env.PI_NOTIFY_STDOUT_ONLY;
  delete process.env.TMUX;
  process.env.PI_NOTIFY_STDOUT_ONLY = "1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
    if (hadTmux) process.env.TMUX = tmux;
    if (hadForce) process.env.PI_NOTIFY_STDOUT_ONLY = force;
    else delete process.env.PI_NOTIFY_STDOUT_ONLY;
  }
  return chunks;
}

test("extension registers agent_settled and tool_execution_start", () => {
  const captured: CapturedHandlers = { events: [], handlers: new Map() };
  notifyExtension(register(captured));
  assert.deepEqual([...captured.handlers.keys()].sort(), [
    "agent_settled",
    "tool_execution_start",
  ]);
});

test("extension registers nothing when disabled", () => {
  const captured: CapturedHandlers = { events: [], handlers: new Map() };
  const previous = process.env.PI_NOTIFY_DISABLE;
  process.env.PI_NOTIFY_DISABLE = "1";
  try {
    notifyExtension(register(captured));
  } finally {
    if (previous === undefined) delete process.env.PI_NOTIFY_DISABLE;
    else process.env.PI_NOTIFY_DISABLE = previous;
  }
  assert.equal(captured.events.length, 0);
});

test("agent_settled handler emits a notification", () => {
  const captured: CapturedHandlers = { events: [], handlers: new Map() };
  notifyExtension(register(captured));
  const chunks = captureStdout(() => void captured.handlers.get("agent_settled")!());
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /Pi/);
  assert.match(chunks[0]!, /Ready for input/);
});

test("tool_execution_start notifies only for configured wait tools", () => {
  const captured: CapturedHandlers = { events: [], handlers: new Map() };
  const previous = process.env.PI_NOTIFY_WAIT_TOOLS;
  process.env.PI_NOTIFY_WAIT_TOOLS = "askUserQuestion, myWizard";
  try {
    notifyExtension(register(captured));
  } finally {
    if (previous === undefined) delete process.env.PI_NOTIFY_WAIT_TOOLS;
    else process.env.PI_NOTIFY_WAIT_TOOLS = previous;
  }
  const handler = captured.handlers.get("tool_execution_start")!;

  let chunks = captureStdout(() => void handler({ toolName: "askUserQuestion", args: {} }));
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /Waiting for your answer/);

  chunks = captureStdout(() => void handler({ toolName: "myWizard", args: {} }));
  assert.equal(chunks.length, 1);

  chunks = captureStdout(() => void handler({ toolName: "bash", args: {} }));
  assert.equal(chunks.length, 0);
});

test("parseWaitTools defaults to askUserQuestion and honors overrides", () => {
  assert.deepEqual(parseWaitTools(undefined), ["askUserQuestion"]);
  assert.deepEqual(parseWaitTools("a, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(parseWaitTools(",,"), ["askUserQuestion"]);
});

test("isDisabled accepts 1/true only", () => {
  assert.equal(isDisabled("1"), true);
  assert.equal(isDisabled("true"), true);
  assert.equal(isDisabled("0"), false);
  assert.equal(isDisabled(undefined), false);
});

test("pickBackend routes by terminal environment", () => {
  assert.equal(pickBackend({ WT_SESSION: "x" } as NodeJS.ProcessEnv), "windows-toast");
  const linux = { KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv;
  assert.equal(pickBackend(linux, "linux"), "osc-99");
  assert.equal(pickBackend({} as NodeJS.ProcessEnv, "linux"), "osc-777");
});

test("pickBackend prefers native notifications on macOS", () => {
  // Works everywhere on macOS: tmux, plain terminal, missing OSC permissions.
  assert.equal(pickBackend({} as NodeJS.ProcessEnv, "darwin"), "macos-notification");
  const tmuxEnv = { TMUX: "/tmp/tmux-501/default" } as NodeJS.ProcessEnv;
  assert.equal(pickBackend(tmuxEnv, "darwin"), "macos-notification");
  // Non-macOS inside tmux: no better option, keep OSC and let the user override.
  assert.equal(pickBackend(tmuxEnv, "linux"), "osc-777");
});

test("pickBackend honors PI_NOTIFY_BACKEND override", () => {
  assert.equal(pickBackend({ PI_NOTIFY_BACKEND: "osc-99" } as NodeJS.ProcessEnv), "osc-99");
  // Forced backend wins even inside tmux on macOS.
  const env = { TMUX: "1", PI_NOTIFY_BACKEND: "osc-777" } as NodeJS.ProcessEnv;
  assert.equal(pickBackend(env, "darwin"), "osc-777");
  // Unknown backend name is ignored, routing proceeds normally.
  assert.equal(pickBackend({ PI_NOTIFY_BACKEND: "nope" } as NodeJS.ProcessEnv), "osc-777");
});

test("OSC 777 escapes into a single write", () => {
  const out = buildOSC777("Pi", "Ready for input");
  assert.equal(out, "\x1b]777;notify;Pi;Ready for input\x07");
});

test("OSC 99 emits title then body parts", () => {
  assert.deepEqual(buildOSC99Parts("Pi", "hi"), [
    "\x1b]99;i=1:d=0;Pi\x1b\\",
    "\x1b]99;i=1:p=body;hi\x1b\\",
  ]);
});

test("windows toast script embeds title and body", () => {
  const script = windowsToastScript("Pi", "Done");
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /'Done'/);
  assert.match(script, /'Pi'/);
});

test("notify writes OSC sequences without spawning processes", () => {
  const writes: string[] = [];
  const spawns: string[][] = [];
  const io = {
    env: {} as NodeJS.ProcessEnv,
    write: (chunk: string) => writes.push(chunk),
    execFile: (file: string, args: string[]) => spawns.push([file, ...args]),
  };

  notify("Pi", "Ready for input", { ...io, env: {} as NodeJS.ProcessEnv });
  assert.deepEqual(writes, ["\x1b]777;notify;Pi;Ready for input\x07"]);

  writes.length = 0;
  notify("Pi", "Ready for input", { ...io, env: { KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv });
  assert.equal(writes.length, 2);

  notify("Pi", "Ready for input", { ...io, env: { WT_SESSION: "x" } as NodeJS.ProcessEnv });
  assert.equal(writes.length, 2); // unchanged: windows path never writes stdout
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]![0], "powershell.exe");

  notify("Pi", "Waiting for your answer", {
    ...io,
    env: { TMUX: "1" } as NodeJS.ProcessEnv,
    platform: "darwin",
  });
  assert.equal(writes.length, 2); // macOS path never writes stdout either
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1]![0], "osascript");
  assert.deepEqual(spawns[1]!.slice(1), ["-e", 'display notification "Waiting for your answer" with title "Pi"']);
});

test("macosNotificationScript escapes quotes and backslashes", () => {
  const script = macosNotificationScript('Pi "pro"', 'a\\b "c"');
  assert.equal(
    script,
    'display notification "a\\\\b \\"c\\"" with title "Pi \\"pro\\""',
  );
});
