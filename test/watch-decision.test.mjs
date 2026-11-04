// First behavioral coverage for the watch tick. app-main's refreshIfChanged (the per-second rebuild loop)
// is executed by no test — it needs a live Electron main process — so its rebuild/skip decision, the gate on
// the biggest main-thread cost, was unverified. The decision is now a pure function; pin it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWatchTick, shouldPushUpdate } from "../dist/watch-decision.js";

test("a tick with no baseline rebuilds rather than quietly adopting one", () => {
  // This assertion is the inverse of the one it replaces, which read: "the first tick seeds the baseline
  // instead of rebuilding", { action: "seed" }. That was right about the cost it avoided and wrong about
  // what it cost: recording the tree as the baseline without drawing it means a write that landed since the
  // build is never shown, and every later tick compares equal and skips it for good. The baseline now
  // arrives from the build that rendered the review, so the no-baseline case is not a normal state — and
  // when a state is not supposed to happen, the safe answer is the one that shows the reader the truth.
  assert.deepEqual(decideWatchTick("", "abc"), { action: "rebuild", diffSig: "abc" });
});

test("an unchanged diff skips — the common case, no rebuild", () => {
  assert.deepEqual(decideWatchTick("abc", "abc"), { action: "skip" });
});

test("a changed diff rebuilds and adopts the new baseline", () => {
  assert.deepEqual(decideWatchTick("abc", "def"), { action: "rebuild", diffSig: "def" });
});

test("the renderer is pushed an update only when the review signature changed", () => {
  assert.equal(shouldPushUpdate("sig1", "sig2"), true);
  assert.equal(shouldPushUpdate("sig1", "sig1"), false, "same signature -> no wasted diff-update IPC");
});
