// Does the work under review collide with what has landed on its base?
//
// Every case here is built as a real repository, because the whole feature is an assertion about what git
// itself would do. The three outcomes that matter are: both sides changed the same lines (a conflict), both
// sides changed the same file in different places (worth knowing, not a conflict), and a base that has not
// moved (nothing to say, and the cheap path).
//
// The important one is UNCOMMITTED work. kakapo exists to read changes an agent has just written, which are
// not commits yet, so `git merge-tree` — which compares two commits — is silent in precisely the case this
// has to answer. These tests leave the review side in the working tree on purpose.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectBaseDivergence } from "../dist/git-conflicts.js";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function run(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
const TEN_LINES = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

// A repository whose `origin-ish` branch has moved on, and whose working tree holds the review's changes.
// `baseEdit` and `ourEdit` each rewrite the file; the caller decides whether they touch the same lines.
function diverged({ baseEdit, ourEdit, extraBaseFile = false }) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-conflicts-"));
  dirs.push(root);
  run(root, ["init", "-qb", "main"]);
  run(root, ["config", "user.email", "t@t.t"]);
  run(root, ["config", "user.name", "t"]);
  write(root, "shared.txt", TEN_LINES);
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "base"]);

  run(root, ["checkout", "-qb", "origin-ish"]);
  write(root, "shared.txt", baseEdit);
  if (extraBaseFile) write(root, "only-base.txt", "base owns this\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "base side"]);

  run(root, ["checkout", "-q", "main"]);
  // The review's own side stays UNCOMMITTED, which is the shape kakapo is built to read.
  write(root, "shared.txt", ourEdit);
  return root;
}

const replaceLine = (n, text) => {
  const lines = TEN_LINES.split("\n");
  lines[n - 1] = text;
  return lines.join("\n");
};

test("both sides changing the same line is reported as a conflict, on uncommitted work", () => {
  const root = diverged({ baseEdit: replaceLine(1, "ONE-from-base"), ourEdit: replaceLine(1, "one-from-us") });
  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.ok(result, "a diverged base has something to say");
  assert.deepEqual(result.collisions.map((c) => [c.path, c.kind]), [["shared.txt", "conflict"]]);
  assert.deepEqual(result.collisions[0].lines, [1], "and names the line, in merge-base coordinates");
});

test("the same file changed in different places is reported, but not as a conflict", () => {
  const root = diverged({ baseEdit: replaceLine(1, "ONE-from-base"), ourEdit: replaceLine(10, "TEN-from-us") });
  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.deepEqual(result.collisions.map((c) => [c.path, c.kind]), [["shared.txt", "diverged"]]);
  assert.deepEqual(result.collisions[0].lines, [], "nothing collides, so no line is claimed to");
});

test("a base that has not moved costs one merge-base call and reports nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-conflicts-"));
  dirs.push(root);
  run(root, ["init", "-qb", "main"]);
  run(root, ["config", "user.email", "t@t.t"]);
  run(root, ["config", "user.name", "t"]);
  write(root, "shared.txt", TEN_LINES);
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "base"]);
  run(root, ["branch", "origin-ish"]);
  write(root, "shared.txt", replaceLine(4, "four-from-us"));

  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.ok(result, "it still answers");
  assert.deepEqual(result.collisions, [], "with nothing, because the base has landed nothing");
  assert.equal(result.mergeBase, run(root, ["rev-parse", "origin-ish"]), "the base IS the merge base here");
});

test("a file only the base changed is not reported — the reader is not being shown it", () => {
  const root = diverged({
    baseEdit: replaceLine(1, "ONE-from-base"),
    ourEdit: replaceLine(1, "one-from-us"),
    extraBaseFile: true,
  });
  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.deepEqual(result.collisions.map((c) => c.path), ["shared.txt"],
    "only.base.txt moved on the base, but it is not part of this review");
});

test("an insertion by both sides at the same point collides", () => {
  const lines = TEN_LINES.split("\n");
  const insertAfter3 = (text) => [...lines.slice(0, 3), text, ...lines.slice(3)].join("\n");
  const root = diverged({ baseEdit: insertAfter3("base inserted"), ourEdit: insertAfter3("we inserted") });
  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.deepEqual(result.collisions.map((c) => c.kind), ["conflict"],
    "two insertions in the same gap are a conflict, though neither replaces an existing line");
});

test("it declines to guess outside a repository, or with no files to look at", () => {
  const empty = mkdtempSync(join(tmpdir(), "kakapo-conflicts-"));
  dirs.push(empty);
  assert.equal(detectBaseDivergence(empty, "origin-ish", ["shared.txt"]), undefined, "no repository, no answer");
  const root = diverged({ baseEdit: replaceLine(1, "x"), ourEdit: replaceLine(1, "y") });
  assert.equal(detectBaseDivergence(root, "origin-ish", []), undefined, "no review files, nothing to compare");
  assert.equal(detectBaseDivergence(root, "", ["shared.txt"]), undefined, "no base, nothing to compare against");
});

// The reason both sides are read in merge-base coordinates, and the only test that can tell. Everywhere
// else in this file the two sides replace a line in place, so the old and new line numbers coincide and
// reading the wrong half of `@@ -a,b +c,d @@` gives the right answer by luck — which it did, until this
// case existed.
//
// Here our side inserts eight lines at the very top of the file. In merge-base coordinates that insertion
// sits at line 0 and the base's edit is at line 5: no overlap, so these two changes merge cleanly. Read in
// NEW-file coordinates our insertion occupies lines 1 through 8, which swallows the base's line 5 and
// reports a conflict that git would not have.
test("line numbers are compared in merge-base coordinates, not the working tree's", () => {
  const prefix = Array.from({ length: 8 }, (_, i) => `inserted ${i}`).join("\n");
  const root = diverged({
    baseEdit: replaceLine(5, "FIVE-from-base"),
    ourEdit: `${prefix}\n${TEN_LINES}`,
  });
  const result = detectBaseDivergence(root, "origin-ish", ["shared.txt"]);
  assert.deepEqual(result.collisions.map((c) => [c.path, c.kind]), [["shared.txt", "diverged"]],
    "an insertion above the base's edit does not collide with it");
  assert.deepEqual(result.collisions[0].lines, [], "and no line is named as conflicting");

  // The control for the control, so "diverged" above is a judgement and not this code's only answer: the
  // base rewrites a block of three lines and we insert INSIDE it. That is a collision in merge-base
  // coordinates and git conflicts on it too.
  const lines = TEN_LINES.split("\n");
  const inside = diverged({
    baseEdit: ["ONE-base", "TWO-base", "THREE-base", ...lines.slice(3)].join("\n"),
    ourEdit: [lines[0], "we inserted here", ...lines.slice(1)].join("\n"),
  });
  const collided = detectBaseDivergence(inside, "origin-ish", ["shared.txt"]);
  assert.deepEqual(collided.collisions.map((c) => c.kind), ["conflict"],
    "an insertion inside a block the base rewrote does collide");
});

// End to end: a review built on a base that has moved shows the badge on the row the reader decides from.
// Asserted against the built HTML rather than the detector, because threading the collisions through
// renderDiffHtml is its own mistake to make — and was: the detector was perfect while the tree rendered
// nothing, because `changesPanel` is the watch-update payload and the first paint renders its own tree.
//
// Every assertion here keys on the `data-i18n` marker, never on the class name. The stylesheet is inlined
// into this same document, so `.change-collision.cl-diverged` is present in every review ever built and a
// negative assertion against the class passes nothing and fails nothing useful.
const BADGE = { conflict: 'data-i18n="collision.conflict"', diverged: 'data-i18n="collision.diverged"' };

test("the review's Changes tree marks a colliding file", async () => {
  const { buildDiffReview } = await import("../dist/build.js");
  const build = (root) => buildDiffReview({
    root, base: "origin-ish", staged: false, includeUntracked: true, context: 3, title: "t",
  }).html;

  const conflict = build(diverged({ baseEdit: replaceLine(1, "ONE-from-base"), ourEdit: replaceLine(1, "one-from-us") }));
  assert.ok(conflict.includes(BADGE.conflict), "the conflicting file is badged, and translatably");
  assert.ok(!conflict.includes(BADGE.diverged), "and not also called merely diverged");

  const elsewhere = build(diverged({ baseEdit: replaceLine(1, "ONE-from-base"), ourEdit: replaceLine(10, "TEN-from-us") }));
  assert.ok(elsewhere.includes(BADGE.diverged), "a non-overlapping change is badged as diverged");
  assert.ok(!elsewhere.includes(BADGE.conflict), "and never as a conflict");

  // The ordinary case stays clean: nothing has landed on this base, so the row says nothing at all.
  const quiet = mkdtempSync(join(tmpdir(), "kakapo-conflicts-"));
  dirs.push(quiet);
  run(quiet, ["init", "-qb", "main"]);
  run(quiet, ["config", "user.email", "t@t.t"]);
  run(quiet, ["config", "user.name", "t"]);
  write(quiet, "shared.txt", TEN_LINES);
  run(quiet, ["add", "-A"]);
  run(quiet, ["commit", "-qm", "base"]);
  run(quiet, ["branch", "origin-ish"]);
  write(quiet, "shared.txt", replaceLine(4, "four-from-us"));
  const clean = build(quiet);
  assert.ok(clean.includes('class="file-link change-row'), "the review still has its changed row");
  assert.ok(!clean.includes(BADGE.conflict) && !clean.includes(BADGE.diverged),
    "with no badge, because nothing collides");
});
