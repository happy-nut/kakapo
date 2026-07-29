// First behavioral coverage for the watch tick. app-main's refreshIfChanged (the per-second rebuild loop)
// is executed by no test — it needs a live Electron main process — so its rebuild/skip/seed decision, the
// gate on the biggest main-thread cost, was unverified. The decision is now a pure function; pin it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWatchTick, shouldPushUpdate } from "../dist/watch-decision.js";

test("the first tick seeds the baseline instead of rebuilding", () => {
  // lastDiffSig is "" until the first tick — the initial build already produced the review, so an unchanged
  // repo must NOT rebuild ~1s after first paint.
  assert.deepEqual(decideWatchTick("", "abc"), { action: "seed", diffSig: "abc" });
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
