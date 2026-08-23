// Which changed files are not worth reading (trivialChange, render-tree.ts). kakapo marks these viewed on
// arrival, so the cost of a wrong answer is asymmetric and these tests are written around that: a miss shows
// the reviewer one extra file, a FALSE POSITIVE hides a real change behind a tick they never made.
//
// Three cases carry the design. Two statements swapped produce exactly the same SET of added and removed
// lines as a reformat of those two lines — comparing sets calls it whitespace and buries a real edit. A
// Python dedent moves a statement out of its block with identical trimmed text, which is a different program
// and not a style change at all. And a pure move never reaches the function: git reports it with no hunks
// and parseUnifiedDiff drops it, so it is already absent from the review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../dist/diff.js";
import { trivialChange } from "../dist/render-tree.js";

const only = (patch) => parseUnifiedDiff(patch)[0];
const patch = (path, ...body) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");

test("a re-indented block is spacing", () => {
  assert.equal(trivialChange(only(patch("a.ts",
    "@@ -1,3 +1,3 @@",
    " keep();",
    "-  first();",
    "-  second();",
    "+    first();",
    "+    second();",
  ))), "spacing");
});

test("a formatter reflowing one call onto three lines is formatting", () => {
  assert.equal(trivialChange(only(patch("a.ts",
    "@@ -1,2 +1,4 @@",
    " keep();",
    "-run(alpha, beta, gamma);",
    "+run(",
    "+  alpha, beta, gamma",
    "+);",
  ))), "format");
});

test("a real edit is neither", () => {
  assert.equal(trivialChange(only(patch("a.ts",
    "@@ -1,2 +1,2 @@",
    " keep();",
    "-  run(1);",
    "+  run(2);",
  ))), undefined);
});

test("two statements swapped is NOT trivial — the same set, a different change", () => {
  assert.equal(trivialChange(only(patch("a.ts",
    "@@ -1,3 +1,3 @@",
    " keep();",
    "-  lock();",
    "-  write();",
    "+  write();",
    "+  lock();",
  ))), undefined);
});

test("a Python dedent is a different program, however identical the trimmed text", () => {
  assert.equal(trivialChange(only(patch("a.py",
    "@@ -1,3 +1,3 @@",
    " if ready:",
    "-    commit()",
    "+  commit()",
  ))), undefined);
});

test("a move that also edits the file is not trivial", () => {
  const renamed = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1,2 +1,2 @@",
    " keep();",
    "-  run(1);",
    "+  run(2);",
    "",
  ].join("\n");
  assert.equal(trivialChange(only(renamed)), undefined);
});

test("a new file is never trivial, however it is spaced", () => {
  const created = [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1,2 @@",
    "+  first();",
    "+  second();",
    "",
  ].join("\n");
  assert.equal(trivialChange(only(created)), undefined);
});

test("a pure move is dropped from the diff before it can be judged", () => {
  const moved = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(moved), []);
});
