// A workspace off screen is a hidden PAGE, and Chromium throttles a hidden renderer: bytes written to xterm
// there queue up unparsed. An agent mid-turn leaves megabytes in that queue (a perf trace recorded 11.8 MB),
// and switching back pays for all of it in one task — the terminal half of "switching workspaces freezes".
// xterm does not boot under jsdom, so this pins the chain instead: hold instead of write, paint the most
// recent screenful on arrival, and let tmux repaint the pane's true current screen over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const client = read("src/viewer/19-terminal.js");
const preload = read("src/preload.cts");
const terminalIpc = read("src/app-terminal-ipc.ts");

test("a hidden pane holds its output instead of writing it into xterm", () => {
  const onData = client.match(/window\.kakapoPty\.onData\(function \(msg\)[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(onData, "the pty data handler is still where the writes happen");
  assert.match(onData, /document\.visibilityState === 'hidden'/, "a hidden page is recognised on the write path");
  assert.match(onData, /holdHiddenOutput\(panes\[k\]\); return;/,
    "…and the write is skipped rather than queued into a renderer that cannot parse it");
  assert.match(onData, /panes\[k\]\.lastOutputAt = Date\.now\(\)/,
    "activity is still recorded — a held pane is still a working one (the rail's running dot)");
});

test("what a hidden pane keeps is the FACT of output, not the bytes", () => {
  const hold = client.match(/function holdHiddenOutput\(pane\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(hold, "holdHiddenOutput exists");
  assert.match(hold, /pane\.hiddenHeld = true/, "it records that something arrived");
  assert.doesNotMatch(client, /HIDDEN_KEEP_BYTES/,
    "and keeps no tail: a tail was wrapped for the width tmux had while away, and pouring it into a pane that "
    + "came back at another width broke the layout until the session restarted");
});

test("arriving fits the grid first, then has tmux repaint the real screen", () => {
  const flush = client.match(/function flushHiddenOutput\(\)[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(flush, "flushHiddenOutput exists");
  assert.match(flush, /scheduleFitAll\(\);[\s\S]{0,200}requestAnimationFrame/,
    "the resize goes first — it is what tells tmux the grid to wrap to");
  assert.match(flush, /term\.reset\(\)/, "the pane is cleared rather than left holding a screen drawn for another size");
  assert.match(flush, /kakapoPty\.refresh\(\{ id: pane\.id \}\)/, "and tmux paints what is actually there");
  assert.match(client, /visibilitychange[\s\S]{0,120}flushHiddenOutput\(\)/, "becoming visible is what runs it");
});

test("the refresh request reaches tmux", () => {
  assert.match(preload, /refresh: \(msg: \{ id: number \}\)[\s\S]{0,80}"kakapo:pty-refresh"/,
    "the bridge exposes it");
  const handler = terminalIpc.match(/ipc\.on\("kakapo:pty-refresh"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "main handles it");
  assert.match(handler, /termSessions\?\.get\(msg\?\.id\)/, "against that pane's own tmux session");
  assert.match(handler, /"refresh-client", "-t", session/, "with the command that redraws a client's screen");
});

// Attaching on ARRIVAL was tried and reverted: it does not make the wait smaller, it moves it onto the
// switch, where it is worse — every workspace passed through paid an xterm boot before it would draw. What
// survives is the part that was right: ONE in-flight attach, so the panel and anything else asking cannot
// each spawn a pane, land on the same tmux ordinal, and mirror one session across two panes.
test("the panel attaches through a single in-flight path, so no two panes share a session", () => {
  const ensure = client.match(/function ensurePanes\(\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(ensure, "there is one attach path");
  assert.match(ensure, /if \(!panesReady\)/, "and it is memoised, so a second caller joins the first");
  assert.match(ensure, /if \(panes\.length === 0\) makePane\(\)/, "one plain pane when no session survived");
  assert.match(client, /setConnecting\(true\);\s*\n\s*ensurePanes\(\)/, "the panel goes through it too");
  // The declaration reads `function restorePanes()`; every other occurrence outside a comment is a caller.
  const callers = client.split("\n")
    .filter((line) => line.includes("restorePanes()") && !line.trim().startsWith("//") && !line.includes("function restorePanes"))
    .length;
  assert.equal(callers, 1, "restorePanes is CALLED from exactly one place — a second caller is how two panes land on one session");
});
