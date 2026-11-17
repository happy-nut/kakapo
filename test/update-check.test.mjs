import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dock = read("src/viewer/08-dock.js");

test("the review window re-checks for a release instead of asking once at load", () => {
  assert.match(dock, /function checkForUpdate\(\)/, "the check is a named function, not a one-shot IIFE");
  assert.match(dock, /setInterval\(checkForUpdate, UPDATE_CHECK_MS\)/, "and it repeats on the interval");
  assert.match(dock, /var UPDATE_CHECK_MS = 6 \* 60 \* 60 \* 1000/, "six hours");
});

test("the session cache carries an age, so it cannot answer every later check with the same version", () => {
  assert.match(dock, /Date\.now\(\) - cachedAt < UPDATE_CHECK_MS\) return/, "a stale cache falls through to a fetch");
  assert.match(dock, /setItem\('kakapo-update-checked-at'/, "and every fetch stamps when it happened");
  assert.match(dock, /if \(cached\) apply\(cached\);/, "what is already known still paints immediately");
});
