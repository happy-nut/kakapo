// Computer use without a second app (issue #41): the agent sees and drives the desktop through macOS's own
// binaries — osascript's ObjC bridge and screencapture — reached as MCP tools on kakapo's existing server.
//
// Nothing here may talk to the real OS: every runner is the injected seam, and the first assertion on every
// acting path is that a bad argument fails BEFORE anything would spawn — an osascript that runs at all may
// already have moved the mouse. The scripts themselves are fixed constants fed values through argv, and that
// is tested as a contract: what an agent asks to click is as untrusted as what a command prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACT_SCRIPT, ACT_TOOL, APPS_TOOL, AX_TOOL, CAPTURE_TOOL, COMPUTER_TOOLS, KEY_CODES, TREE_SCRIPT,
  WINDOWS_SCRIPT, act, captureScreen, listWindows, readTree, validateAct,
} from "../dist/computer-use.js";
import { handleRpc } from "../dist/mcp-server.js";

const darwin = process.platform === "darwin";
const neverExec = () => { throw new Error("exec must not be reached"); };
function recorder(reply = "done") {
  const calls = [];
  const exec = (file, args, timeoutMs) => { calls.push({ file, args, timeoutMs }); return reply; };
  return { calls, exec };
}

test("the four tools ride the same server, and the act tool carries its own rule", () => {
  const listed = handleRpc({ id: 1, method: "tools/list" }, process.cwd()).result.tools.map((t) => t.name);
  for (const tool of COMPUTER_TOOLS) assert.ok(listed.includes(tool.name), `${tool.name} is listed`);
  // Read and act are split on purpose, and the policy lives in the description — the one place that is in
  // the agent's context on every turn.
  assert.match(ACT_TOOL.description, /only for what the user's request already covers/);
  for (const tool of [APPS_TOOL, AX_TOOL, CAPTURE_TOOL]) assert.match(tool.description, /Read-only/);
  // Coordinates have one source of truth, stated on both sides of the seam: the tree hands out centers in
  // screen points, the capture warns off pixel offsets.
  assert.match(AX_TOOL.description, /CENTER point/);
  assert.match(CAPTURE_TOOL.description, /never from pixel offsets/);
});

test("a bad action fails in-process, before anything could spawn", () => {
  for (const input of [
    {},
    { action: "drag" },
    { action: "click" },
    { action: "click", x: 10 },
    { action: "click", x: Infinity, y: 5 },
    { action: "scroll", x: 1, y: 1 },
    { action: "type" },
    { action: "type", text: "" },
    { action: "key", key: "return", modifiers: ["hyper"] },
    { action: "key", key: "definitely-not-a-key" },
  ]) {
    assert.equal(validateAct(input).act, undefined, JSON.stringify(input));
    const outcome = act(input, neverExec);
    assert.equal(outcome.ok, false, JSON.stringify(input));
  }
});

test("good actions validate into exactly what the script will read", () => {
  assert.deepEqual(validateAct({ action: "click", x: 10, y: 20 }).act, { action: "click", x: 10, y: 20, dx: 0, dy: 0 });
  assert.deepEqual(validateAct({ action: "type", text: "안녕" }).act, { action: "type", text: "안녕" });
  // A named key travels as its System Events key code; a single character keeps the user's keyboard layout.
  assert.deepEqual(validateAct({ action: "key", key: "return" }).act, { action: "key", code: 36, modifiers: [] });
  assert.deepEqual(validateAct({ action: "key", key: "a", modifiers: ["command"] }).act, { action: "key", key: "a", modifiers: ["command"] });
  assert.deepEqual(validateAct({ action: "scroll", x: 5, y: 6, dy: -3 }).act, { action: "scroll", x: 5, y: 6, dx: 0, dy: -3 });
});

test("the named keys an agent reaches for are all in the map", () => {
  for (const key of ["return", "tab", "escape", "delete", "space", "left", "right", "up", "down", "pageup", "pagedown", "f12"]) {
    assert.equal(typeof KEY_CODES[key], "number", key);
  }
});

test("values reach the scripts through argv, never by building script text", () => {
  // The scripts are fixed constants that parse argv — no caller interpolates a value into script source, so
  // there is nothing an app name like `"; do shell script "..."` can escape from.
  for (const script of [TREE_SCRIPT, ACT_SCRIPT]) assert.match(script, /JSON\.parse\(argv\[0\]\)/);
  for (const script of [WINDOWS_SCRIPT, TREE_SCRIPT, ACT_SCRIPT]) assert.ok(!script.includes("${"), "no template holes");
});

test("capture validates its window id without touching the OS", () => {
  const outcome = captureScreen({ windowId: "42" }, neverExec);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /number/);
});

test("the tree needs an app name before it will walk anything", () => {
  const outcome = readTree({}, neverExec);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /`app` is required/);
});

test(darwin ? "on macOS the seam records exactly the spawn each tool makes" : "off macOS every tool says so instead of spawning", () => {
  if (!darwin) {
    for (const outcome of [listWindows(neverExec), readTree({ app: "Safari" }, neverExec), captureScreen({}, neverExec), act({ action: "click", x: 1, y: 2 }, neverExec)]) {
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /macOS-only/);
    }
    return;
  }
  // act: the fixed script plus one JSON argv — and the script text is the constant, untouched by the input.
  const clicks = recorder();
  act({ action: "click", x: 10, y: 20 }, clicks.exec);
  assert.deepEqual(clicks.calls[0].args, ["-l", "JavaScript", "-e", ACT_SCRIPT, JSON.stringify({ action: "click", x: 10, y: 20, dx: 0, dy: 0 })]);
  assert.equal(clicks.calls[0].file, "osascript");

  // tree: depth is clamped into 1–6 whatever the agent sent.
  const walks = recorder("AXWindow");
  readTree({ app: "Safari", depth: 99 }, walks.exec);
  assert.deepEqual(JSON.parse(walks.calls[0].args[4]), { app: "Safari", depth: 6, window: "" });

  // capture: a window id becomes -l, no id means the whole screen; both are silent (-x) and the path is
  // handed back to read the image from.
  const shots = recorder("");
  const windowed = captureScreen({ windowId: 42 }, shots.exec);
  const whole = captureScreen({}, shots.exec);
  assert.equal(shots.calls[0].file, "screencapture");
  assert.deepEqual(shots.calls[0].args.slice(0, 4), ["-x", "-o", "-l", "42"]);
  assert.equal(shots.calls[1].args[0], "-x");
  assert.match(windowed.message, /\.png/);
  assert.match(whole.message, /kakapo_ax, not from this image/);

  // windows: the CGWindowList JSON is reshaped into one line per window with the frontmost marked.
  const wins = recorder(JSON.stringify({ front: "Safari", wins: [{ id: 7, app: "Safari", title: "GitHub", x: 0, y: 25, w: 1200, h: 800 }] }));
  const outcome = listWindows(wins.exec);
  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /^7 {2}Safari — "GitHub" {2}1200x800 at \(0,25\) {2}\[frontmost\]$/);
});

test("a denied permission comes back as instructions, not as a stack trace", () => {
  if (!darwin) return;
  const denied = () => { const error = new Error("execution error: osascript is not allowed assistive access. (-25211)"); throw error; };
  const outcome = act({ action: "click", x: 1, y: 2 }, denied);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /System Settings > Privacy & Security/);
});
