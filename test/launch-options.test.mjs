import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAUNCH_ONLY_OPTIONS, withoutLaunchOnly, applyLaunchOnly } from "../dist/launch-options.js";

const MAIN = resolve(import.meta.dirname, "..", "src", "app-main.ts");
const source = readFileSync(MAIN, "utf8");

const LAUNCH = {
  root: "/repo", explicitRoot: true, staged: false, includeUntracked: true, context: 12, watch: true,
  ignoreWhitespace: false, whitespace: "none", base: "main", baseLabel: "main",
  openPath: "src/a.ts", pullRequest: "https://github.com/o/r/pull/1",
};

test("the list names the options a launch can ask for", () => {
  assert.deepEqual([...LAUNCH_ONLY_OPTIONS].sort(), ["openPath", "pullRequest"],
    "these are the two the window has to be told about; a new one is only half wired until it is here");
  for (const key of LAUNCH_ONLY_OPTIONS) {
    assert.notEqual(LAUNCH[key], undefined, `this test's launch does not set ${key}, so it cannot see it `
      + "being dropped and every assertion below passes for the wrong reason");
  }
});

test("a second window inherits none of them", () => {
  const next = withoutLaunchOnly({ ...LAUNCH });
  for (const key of LAUNCH_ONLY_OPTIONS) {
    assert.equal(next[key], undefined, `${key} reached a window the launch did not ask it for`);
  }
  assert.equal(next.base, "main", "and everything that is not launch-only is carried over");
  assert.equal(next.context, 12);
});

test("the first window is given every one of them", () => {
  const first = { root: "/repo", explicitRoot: true };
  applyLaunchOnly(first, LAUNCH);
  for (const key of LAUNCH_ONLY_OPTIONS) {
    assert.equal(first[key], LAUNCH[key], `${key} was blanked for later windows and never handed to the `
      + "first one, so the argument parses and nothing happens");
  }
});

test("app-main does not blank or assign one of them by hand", () => {
  const byHand = [];
  for (const key of LAUNCH_ONLY_OPTIONS) {
    if (source.includes(`${key}: undefined`)) byHand.push(`makeOptions blanks ${key} by hand`);
    if (source.includes(`first.options.${key} =`)) byHand.push(`the first window is handed ${key} by hand`);
  }
  assert.deepEqual(byHand, [], "a hand-written spelling is a second list that drifts from LAUNCH_ONLY_OPTIONS "
    + "in src/launch-options.ts — call withoutLaunchOnly / applyLaunchOnly instead.");
  assert.ok(source.includes("withoutLaunchOnly(") && source.includes("applyLaunchOnly("),
    "app-main.ts calls neither helper, so this reader is checking a file that no longer does this work");
});
