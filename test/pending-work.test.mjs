// The rail's "working" spinner for agents whose output has gone quiet: an agent waiting on a background
// shell or a scheduled wake-up redraws nothing, so the only signal is its own status footer. These screens
// are verbatim shapes captured from live Claude Code panes — the discriminators under test are (1) the "·"
// separator that footer tallies carry and transcript prose does not, and (2) only the bottom lines count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenShowsPendingWork } from "../dist/util.js";

test("footer tallying a background shell reads as pending", () => {
  const screen = [
    "✳ Brewed for 5m 21s · 1 shell still running",
    "",
    "────────────────────────────────",
    "› ",
    "────────────────────────────────",
    "  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent",
    "",
  ].join("\n");
  assert.equal(screenShowsPendingWork(screen), true);
});

test("idle footer's agent-tab hint is not pending work", () => {
  const screen = [
    "  Ran 1 shell command",
    "",
    "────────────────────────────────",
    "❯ ",
    "────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
  ].join("\n");
  assert.equal(screenShowsPendingWork(screen), false);
});

test("transcript prose about shell commands above the input box does not match", () => {
  const screen = [
    "  Searched for 1 pattern, ran 3 shell commands",
    "  Ran 1 shell command",
    "",
    "────────────────────────────────",
    "❯ ",
    "────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(screenShowsPendingWork(screen), false);
});

test("trailing blank rows of a short session do not push the footer out of reach", () => {
  const screen = [
    "────────────────────────────────",
    "› ",
    "────────────────────────────────",
    "  ⏵⏵ bypass permissions on · 2 shells",
    "", "", "", "", "",
  ].join("\n");
  assert.equal(screenShowsPendingWork(screen), true);
});
