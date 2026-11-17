import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWatchTick, shouldPushUpdate } from "../dist/watch-decision.js";

test("a tick with no baseline rebuilds rather than quietly adopting one", () => {
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
