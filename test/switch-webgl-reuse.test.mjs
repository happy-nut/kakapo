// Switching workspaces used to freeze the app for seconds after long uptime (field traces: 1.5–3.6s
// renderer stalls starting ~25ms after every workspace-activate, always with the terminal open). The cost
// was the re-show path replacing every pane's WebGL context on EVERY switch: getContext + shader compile +
// glyph-atlas rebuild are synchronous round-trips to the GPU process, and once that process carries a
// session's worth of surfaces they run seconds. xterm does not boot under jsdom, so this pins the chain:
// ask the context whether it is actually lost, replace only then, and keep the repaint for everyone else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

test("a healthy WebGL context survives a workspace switch", () => {
  const flush = client.match(/function flushHiddenOutput\(\)[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(flush, "flushHiddenOutput exists");
  assert.match(flush, /if \(paneWebglLost\(pane\.term\)\)/,
    "the replace is gated on the context actually being dead");
  const firstDispose = flush.indexOf("__kakapoWebgl.dispose");
  const gate = flush.indexOf("if (paneWebglLost(pane.term))");
  assert.ok(gate >= 0 && (firstDispose < 0 || gate < firstDispose),
    "every dispose on the switch path sits behind that gate — the unconditional per-switch GPU round-trip was the freeze");
});

test("a dead context is still detected and replaced — the garbage-frame fix stays intact", () => {
  const lost = client.match(/function paneWebglLost\(term\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(lost, "paneWebglLost exists");
  assert.match(lost, /if \(!addon\) return true/,
    "an addon nulled by its own loss event reads as lost");
  assert.match(lost, /isContextLost/,
    "otherwise the context itself is asked — the same GPU-channel signal whether or not the DOM event fired");
  assert.match(lost, /catch \(e\) \{ return true; \}/,
    "an unrecognisable addon shape falls back to lost, which is the old replace-always behaviour");
  assert.match(lost, /typeof gl\.isContextLost !== 'function'\) return true/,
    "…and so does a context without the probe");
  const flush = client.match(/function flushHiddenOutput\(\)[\s\S]*?\n  \}\n/)?.[0];
  assert.match(flush, /loadWebglRenderer\(pane\.term\)/, "a lost context still gets a fresh addon");
});

test("the repaint still runs for every pane, replaced or kept", () => {
  const flush = client.match(/function flushHiddenOutput\(\)[\s\S]*?\n  \}\n/)?.[0];
  assert.match(flush, /term\.write\('\\x1b\[3J\\x1b\[2J\\x1b\[H'\)/,
    "a held pane is cleared for tmux's authoritative repaint — cleared, not reset(), which would drop mouse tracking");
  assert.match(flush, /term\.refresh\(0, pane\.term\.rows - 1\)/, "a quiet pane redraws from its own buffer");
  assert.match(flush, /kakapoPty\.refresh\(\{ id: pane\.id \}\)/, "and tmux repaints the true screen either way");
});
