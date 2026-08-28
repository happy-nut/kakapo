// ===== Computer Use, self-contained: the agent sees and drives the desktop through macOS itself.
//
// The constraint this file exists for (issue #41) is not the capability — it is where the capability LIVES.
// Reading a window, walking an accessibility tree, capturing a screen and posting a click are all things
// macOS already does; what the reviewer refused was a separate app appearing to do them. So everything here
// goes through binaries the OS ships: `osascript -l JavaScript` reaches CGWindowList, System Events and
// CGEvent through the ObjC bridge, and `screencapture` writes the pixels. Nothing to install, nothing to
// launch, nothing whose lifecycle a user can notice. The OS permissions involved (Accessibility for the
// tree and the events, Screen Recording for window titles and capture) are macOS's to grant and prompt for,
// which is exactly the boundary the issue draws.
//
// Arguments never enter a script by string interpolation: every script is a fixed constant and every value
// crosses as argv (JSON where structured). Terminal output taught this codebase that lesson already — what
// an agent asks to click is as untrusted as what a command prints.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the tools ────────────────────────────────────────────────────────────────────────────────────
//
// Read and act are separate tools on purpose, and the act tool's description carries the rule, the same way
// kakapo_keep_word carries its own: a description is in the agent's context every turn, a policy document is
// not. Reading is free; changing the screen is only ever what the user's request already covers.

export const APPS_TOOL = {
  name: "kakapo_apps",
  description:
    "List the desktop's on-screen windows: app, window title, window id, and bounds in screen points. " +
    "macOS only. Read-only. Use the window id with kakapo_capture, and the app name with kakapo_ax. " +
    "Empty titles usually mean macOS Screen Recording permission has not been granted to the app this " +
    "agent runs in.",
  inputSchema: { type: "object", properties: {} },
} as const;

export const AX_TOOL = {
  name: "kakapo_ax",
  description:
    "Read an app's accessibility tree: one line per element with role, title, value, and its CENTER point " +
    "@(x,y) in screen points — the coordinate kakapo_act takes. macOS only. Read-only. Walks the app's " +
    "windows (not its menus). Large apps are slow to walk: keep `depth` small and use `window` to narrow " +
    "to one window when you can.",
  inputSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: "Process name as kakapo_apps reported it (e.g. \"Safari\")." },
      window: { type: "string", description: "Only windows whose title contains this substring." },
      depth: { type: "number", description: "How deep to walk (1–6, default 4). Deeper is slower." },
    },
    required: ["app"],
  },
} as const;

export const CAPTURE_TOOL = {
  name: "kakapo_capture",
  description:
    "Capture one window (by id from kakapo_apps) or the whole screen to a PNG, and return the file path — " +
    "read the image from there. macOS only. Read-only. On a retina display the image has more pixels than " +
    "the screen has points: take click coordinates from kakapo_ax positions, never from pixel offsets in " +
    "this image.",
  inputSchema: {
    type: "object",
    properties: {
      windowId: { type: "number", description: "Window id from kakapo_apps. Omit to capture the whole screen." },
    },
  },
} as const;

export const ACT_TOOL = {
  name: "kakapo_act",
  description:
    "Perform one input action on the desktop: click / doubleclick / rightclick at a point, type text into " +
    "the focused element, press a key (with modifiers), or scroll at a point. macOS only. THIS CHANGES THE " +
    "USER'S SCREEN: use it only for what the user's request already covers, never to explore — exploring is " +
    "what the read tools are for. Coordinates are screen points from kakapo_ax (an element's @(x,y) center). " +
    "To set a field's value: click it, select-all (key \"a\" with [\"command\"]), then type.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["click", "doubleclick", "rightclick", "type", "key", "scroll"] },
      x: { type: "number", description: "Screen-point x for click/scroll." },
      y: { type: "number", description: "Screen-point y for click/scroll." },
      text: { type: "string", description: "For `type`: the text, typed as keystrokes." },
      key: { type: "string", description: "For `key`: a single character, or one of: " + "return, tab, space, delete, escape, left, right, up, down, home, end, pageup, pagedown, f1–f12." },
      modifiers: { type: "array", items: { type: "string", enum: ["command", "shift", "option", "control"] }, description: "For `key`." },
      dx: { type: "number", description: "For `scroll`: horizontal lines (positive scrolls content left)." },
      dy: { type: "number", description: "For `scroll`: vertical lines (positive scrolls content up)." },
    },
    required: ["action"],
  },
} as const;

export const COMPUTER_TOOLS = [APPS_TOOL, AX_TOOL, CAPTURE_TOOL, ACT_TOOL] as const;

// ── the scripts ──────────────────────────────────────────────────────────────────────────────────
// Fixed constants, run with `osascript -l JavaScript`; values arrive through argv. JXA's ObjC bridge is the
// whole trick: CGWindowList and CGEvent are C APIs no AppleScript dictionary exposes, and a compiled helper
// would be exactly the second binary this feature exists to avoid.

// kCGWindowListOptionOnScreenOnly(1) | kCGWindowListExcludeDesktopElements(16); layer 0 is normal windows.
// The C call answers with a raw CFArrayRef, which JXA hands over as a bare Ref: castRefToObject is what
// turns it back into the toll-free-bridged NSArray deepUnwrap can walk (measured: deepUnwrap on the Ref
// itself returns undefined, and CFBridgingRelease segfaults osascript outright).
export const WINDOWS_SCRIPT = `
function run() {
  ObjC.import('CoreGraphics');
  const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || [];
  const wins = info.filter(w => w.kCGWindowLayer === 0).map(w => ({
    id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '',
    x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height,
  }));
  let front = '';
  try { front = Application('System Events').processes.whose({ frontmost: true })[0].name(); } catch (e) {}
  return JSON.stringify({ front, wins });
}`;

// Each property read is one Apple Event, so the walk is capped twice: depth (argv) and a hard node budget.
// The element's CENTER is what goes in the line — it is the point an agent should hand to kakapo_act.
export const TREE_SCRIPT = `
function run(argv) {
  const want = JSON.parse(argv[0]);
  const MAX_NODES = 400;
  const proc = Application('System Events').processes.byName(want.app);
  const out = [];
  let count = 0, truncated = false;
  function grab(fn, fallback) { try { const v = fn(); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } }
  function walk(el, depth) {
    if (count >= MAX_NODES) { truncated = true; return; }
    const role = grab(() => el.role(), '?');
    const title = grab(() => el.title(), '') || grab(() => el.name(), '');
    let value = grab(() => el.value(), '');
    if (typeof value === 'string' && value.length > 80) value = value.slice(0, 80) + '…';
    const pos = grab(() => el.position(), null);
    const size = grab(() => el.size(), null);
    let at = '';
    if (pos && size) at = ' @(' + Math.round(pos[0] + size[0] / 2) + ',' + Math.round(pos[1] + size[1] / 2) + ') ' + size[0] + 'x' + size[1];
    out.push('  '.repeat(depth) + role + (title ? ' "' + title + '"' : '') + (value !== '' ? ' value=' + JSON.stringify(String(value)) : '') + at);
    count++;
    if (depth >= want.depth) return;
    const kids = grab(() => el.uiElements(), []);
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
  }
  const wins = proc.windows();
  for (let i = 0; i < wins.length; i++) {
    const title = grab(() => wins[i].name(), '');
    if (want.window && title.indexOf(want.window) === -1) continue;
    walk(wins[i], 0);
  }
  if (!out.length) return 'no windows matched';
  if (truncated) out.push('…truncated at ' + MAX_NODES + ' elements — narrow with window or a smaller depth');
  return out.join('\\n');
}`;

// CGEvent numerics, spelled out because JXA does not export the enums: mouse down/up left(1,2) right(3,4),
// moved(5); field 1 is kCGMouseEventClickState (what makes two clicks a double-click); tap 0 posts at the
// HID level; scroll unit 1 is lines. `type` and `key` go through System Events keystroke/keyCode, which is
// what respects the user's keyboard layout.
export const ACT_SCRIPT = `
function run(argv) {
  const a = JSON.parse(argv[0]);
  ObjC.import('CoreGraphics');
  const se = Application('System Events');
  const post = (ev) => $.CGEventPost(0, ev);
  const mouse = (type, button, clickState) => {
    const ev = $.CGEventCreateMouseEvent($(), type, { x: a.x, y: a.y }, button);
    $.CGEventSetIntegerValueField(ev, 1, clickState);
    post(ev);
  };
  if (a.action === 'click' || a.action === 'doubleclick' || a.action === 'rightclick') {
    const right = a.action === 'rightclick';
    const clicks = a.action === 'doubleclick' ? 2 : 1;
    for (let i = 1; i <= clicks; i++) {
      mouse(right ? 3 : 1, right ? 1 : 0, i);
      mouse(right ? 4 : 2, right ? 1 : 0, i);
      if (i < clicks) delay(0.06);
    }
  } else if (a.action === 'scroll') {
    post($.CGEventCreateMouseEvent($(), 5, { x: a.x, y: a.y }, 0));
    delay(0.02);
    post($.CGEventCreateScrollWheelEvent($(), 1, 2, a.dy || 0, a.dx || 0));
  } else if (a.action === 'type') {
    // Not keystroke: System Events speaks the keyboard layout, which has no key for 한글. The event carries
    // the text itself — one code point per down/up pair, its UTF-16 units riding along (a surrogate pair is
    // two units in one event) — so what arrives is the string, on any layout, with no IME in the way.
    for (const ch of a.text) {
      const down = $.CGEventCreateKeyboardEvent($(), 0, true);
      $.CGEventKeyboardSetUnicodeString(down, ch.length, ch);
      post(down);
      const up = $.CGEventCreateKeyboardEvent($(), 0, false);
      $.CGEventKeyboardSetUnicodeString(up, ch.length, ch);
      post(up);
      delay(0.004);
    }
  } else if (a.action === 'key') {
    const using = (a.modifiers || []).map(m => m + ' down');
    if (a.code !== undefined) se.keyCode(a.code, using.length ? { using } : undefined);
    else se.keystroke(a.key, using.length ? { using } : undefined);
  }
  return 'done';
}`;

// System Events key codes for the named keys an agent actually asks for. A single character skips this map
// and goes through keystroke, so the layout owns it.
export const KEY_CODES: Record<string, number> = {
  return: 36, tab: 48, space: 49, delete: 51, escape: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

// ── validation, before anything spawns ───────────────────────────────────────────────────────────
// A bad argument must fail here, in-process: an osascript that runs at all may already have moved the mouse.

type Outcome = { ok: boolean; message: string };
const MODIFIERS = new Set(["command", "shift", "option", "control"]);

export function validateAct(input: Record<string, unknown>): { act?: Record<string, unknown>; error?: string } {
  const action = typeof input.action === "string" ? input.action : "";
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (action === "click" || action === "doubleclick" || action === "rightclick" || action === "scroll") {
    if (!num(input.x) || !num(input.y)) return { error: `\`${action}\` needs finite \`x\` and \`y\` in screen points` };
    if (action === "scroll" && !num(input.dx) && !num(input.dy)) return { error: "`scroll` needs `dx` and/or `dy`" };
    return { act: { action, x: input.x, y: input.y, dx: num(input.dx) ? input.dx : 0, dy: num(input.dy) ? input.dy : 0 } };
  }
  if (action === "type") {
    if (typeof input.text !== "string" || !input.text) return { error: "`type` needs non-empty `text`" };
    return { act: { action, text: input.text } };
  }
  if (action === "key") {
    const key = typeof input.key === "string" ? input.key : "";
    const modifiers = Array.isArray(input.modifiers) ? input.modifiers.filter((m): m is string => typeof m === "string") : [];
    const bad = modifiers.find((m) => !MODIFIERS.has(m));
    if (bad) return { error: `unknown modifier "${bad}" — command, shift, option or control` };
    if ([...key].length === 1) return { act: { action, key, modifiers } };
    const code = KEY_CODES[key.toLowerCase()];
    if (code === undefined) return { error: `unknown key "${key}" — a single character, or one of: ${Object.keys(KEY_CODES).join(", ")}` };
    return { act: { action, code, modifiers } };
  }
  return { error: `unknown action "${action}" — click, doubleclick, rightclick, type, key or scroll` };
}

// ── running the OS ───────────────────────────────────────────────────────────────────────────────

// Overridable seam for tests; the default really spawns. The permission translation lives here because every
// capability fails the same way: macOS refuses the whole script, with the app that HOSTS this process (the
// terminal, or Kakapo itself) named in System Settings as the one to grant.
type Exec = (file: string, args: string[], timeoutMs: number) => string;
const realExec: Exec = (file, args, timeoutMs) =>
  execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });

function permissionHint(error: unknown): string {
  const text = String((error as { stderr?: string; message?: string })?.stderr || (error as Error)?.message || error);
  // "could not create image" is screencapture's whole way of saying Screen Recording was refused.
  const denied = /not allowed assistive access|not authorized|could not create image|보조 접근|-25211|-1719|1002/.test(text);
  return denied
    ? `macOS refused: ${text.trim()}\nGrant Accessibility (and Screen Recording for capture/titles) to the app this agent runs in: System Settings > Privacy & Security.`
    : `failed: ${text.trim()}`;
}

function jxa(exec: Exec, script: string, arg: unknown, timeoutMs: number): Outcome {
  if (process.platform !== "darwin") return { ok: false, message: "computer use is macOS-only for now" };
  try {
    const args = ["-l", "JavaScript", "-e", script];
    if (arg !== undefined) args.push(JSON.stringify(arg));
    return { ok: true, message: exec("osascript", args, timeoutMs).trim() };
  } catch (error) {
    return { ok: false, message: permissionHint(error) };
  }
}

export function listWindows(exec: Exec = realExec): Outcome {
  const result = jxa(exec, WINDOWS_SCRIPT, undefined, 10_000);
  if (!result.ok) return result;
  try {
    const { front, wins } = JSON.parse(result.message) as { front: string; wins: { id: number; app: string; title: string; x: number; y: number; w: number; h: number }[] };
    const lines = wins.map((w) => `${w.id}  ${w.app}${w.title ? ` — "${w.title}"` : ""}  ${w.w}x${w.h} at (${w.x},${w.y})${w.app === front ? "  [frontmost]" : ""}`);
    return { ok: true, message: lines.length ? lines.join("\n") : "no on-screen windows" };
  } catch {
    return { ok: false, message: `unexpected window list: ${result.message.slice(0, 200)}` };
  }
}

export function readTree(input: Record<string, unknown>, exec: Exec = realExec): Outcome {
  const app = typeof input.app === "string" ? input.app.trim() : "";
  if (!app) return { ok: false, message: "`app` is required — the process name as kakapo_apps lists it" };
  const depth = Math.min(6, Math.max(1, typeof input.depth === "number" && Number.isFinite(input.depth) ? Math.round(input.depth) : 4));
  const window = typeof input.window === "string" ? input.window : "";
  return jxa(exec, TREE_SCRIPT, { app, depth, window }, 60_000);
}

export function captureScreen(input: Record<string, unknown>, exec: Exec = realExec): Outcome {
  if (process.platform !== "darwin") return { ok: false, message: "computer use is macOS-only for now" };
  if (input.windowId !== undefined && (typeof input.windowId !== "number" || !Number.isFinite(input.windowId))) {
    return { ok: false, message: "`windowId` must be a number from kakapo_apps" };
  }
  const file = join(mkdtempSync(join(tmpdir(), "kakapo-capture-")), "screen.png");
  // -x no sound, -o no window shadow; the window id comes from CGWindowList so tmux-quoting never applies.
  const args = input.windowId !== undefined ? ["-x", "-o", "-l", String(input.windowId), file] : ["-x", file];
  try {
    exec("screencapture", args, 15_000);
    return { ok: true, message: `${file}\nRead the image from that path. Retina pixels ≠ screen points: click coordinates come from kakapo_ax, not from this image.` };
  } catch (error) {
    return { ok: false, message: permissionHint(error) };
  }
}

export function act(input: Record<string, unknown>, exec: Exec = realExec): Outcome {
  const { act: validated, error } = validateAct(input);
  if (error) return { ok: false, message: error };
  return jxa(exec, ACT_SCRIPT, validated, 15_000);
}

// One entry for the RPC switch: answers only for its own tools, so mcp-server stays a one-line caller.
export function handleComputerCall(name: string, args: Record<string, unknown>): Outcome | undefined {
  if (name === APPS_TOOL.name) return listWindows();
  if (name === AX_TOOL.name) return readTree(args);
  if (name === CAPTURE_TOOL.name) return captureScreen(args);
  if (name === ACT_TOOL.name) return act(args);
  return undefined;
}
