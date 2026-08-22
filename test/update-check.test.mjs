// Kakapo is left running for days with workspaces open — that is what the rail is for — so "is there a new
// version?" was asked exactly once, at page load, and answered with whatever was true when you last
// restarted. A release published afterwards stayed invisible: the gear never got its dot, and Settings
// went on saying you were up to date. Both checks now run on a timer, and the pieces that would quietly
// defeat a timer (a session cache with no age, a label built by appending) are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dock = read("src/viewer/08-dock.js");
const shell = read("src/shell-pages.ts");

test("the review window re-checks for a release instead of asking once at load", () => {
  assert.match(dock, /function checkForUpdate\(\)/, "the check is a named function, not a one-shot IIFE");
  assert.match(dock, /setInterval\(checkForUpdate, UPDATE_CHECK_MS\)/, "and it repeats on the interval");
  assert.match(dock, /var UPDATE_CHECK_MS = 6 \* 60 \* 60 \* 1000/, "six hours");
});

test("the session cache carries an age, so it cannot answer every later check with the same version", () => {
  // Without the age this is the bug the timer would have hidden: the first check writes the cache, and every
  // later one returns from it before ever reaching the network.
  assert.match(dock, /Date\.now\(\) - cachedAt < UPDATE_CHECK_MS\) return/, "a stale cache falls through to a fetch");
  assert.match(dock, /setItem\('kakapo-update-checked-at'/, "and every fetch stamps when it happened");
  assert.match(dock, /if \(cached\) apply\(cached\);/, "what is already known still paints immediately");
});

test("the rail's gear rebuilds its tooltip instead of appending to it", () => {
  // gear.dataset.tip = gear.dataset.tip + " v" + v grows by one version per check: "설정 v1 v1 v1".
  assert.match(shell, /gear\.dataset\.tip=T\.settingsTip\+/, "the tip is rebuilt from the captured caption");
  assert.doesNotMatch(shell, /gear\.dataset\.tip=gear\.dataset\.tip\+/, "never appended to itself");
  assert.match(shell, /setInterval\(check,6\*60\*60\*1000\)/, "the rail re-checks on the same six hours");
});
