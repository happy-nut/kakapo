// Closing every terminal pane and reopening the panel must attach a fresh pane. ensurePanes() is a
// single-flight guard (two racing callers must not both spawn ordinal 1), but its settled promise was kept
// forever: with all panes closed, the next ⌃` found it resolved, created nothing, and the panel came back
// as an empty white rectangle — "the terminal is gone" on re-entering the workspace. xterm doesn't boot
// under jsdom, so this pins the reset in the source the way terminal-split.test.mjs does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

test("the last pane closing resets the ensurePanes single-flight guard", () => {
  const remove = client.match(/function removePaneRef\(p\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(remove, "removePaneRef exists — every pane removal (⌘W, `exit`, pty death) routes through it");
  assert.match(remove, /panes\.length === 0[\s\S]{0,120}panesReady = null/,
    "emptying the panel forgets the settled promise, so the next open builds a pane again");
});

test("ensurePanes still creates a pane when none survived", () => {
  const ensure = client.match(/function ensurePanes\(\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(ensure, "ensurePanes exists");
  assert.match(ensure, /if \(panes\.length === 0\) makePane\(\)/,
    "an empty panel gets one plain pane rather than staying blank");
});
