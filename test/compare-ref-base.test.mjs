// What a picked branch is measured against.
//
// Reported from use: "I want to choose the remote branch to compare local against, and right now it's
// fixed." It was. `kakapo:set-compare-mode` screened every pick through `usableCompareBase`, which answers
// with merge-base(ref, HEAD) and answers `undefined` when that equals HEAD — so picking a ref holding
// commits you do not have (origin/main before you pull it: the most ordinary comparison there is) was
// refused by name, and could not be asked for at all.
//
// The fix is that the ref itself is the base. This file pins the reasoning that makes that safe rather than
// just the new behaviour, because the risk was never the new case — it was silently changing the old ones.
// Both halves are measured against a real repository: a claim about merge-base is not worth asserting
// against a mock of git.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usableCompareBase } from "../dist/patch-sets.js";

let root;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (text, message) => {
  writeFileSync(join(root, "a.txt"), text);
  git("add", "a.txt");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-compare-"));
  git("init", "-q", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  commit("one\n", "one");
  // `behind` stays at the first commit; HEAD moves on. `ahead` takes a commit of its own that HEAD will
  // never have, which is the shape of a remote-tracking ref you have not pulled.
  git("branch", "behind");
  commit("two\n", "two");
  git("checkout", "-q", "-b", "ahead");
  commit("theirs\n", "theirs");
  git("checkout", "-q", "-");
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

test("for an ancestor of HEAD, the ref and its merge-base are the same revision", () => {
  // The load-bearing claim. If this ever fails, making the ref the base DID change the answer for refs the
  // old screen accepted, and the comment in set-compare-mode is wrong.
  const ref = git("rev-parse", "behind");
  assert.equal(usableCompareBase(root, "behind"), ref,
    "merge-base(X, HEAD) is X exactly when X is an ancestor of HEAD");
});

test("a ref with commits HEAD does not have was refused, and has a diff to show", () => {
  // Both facts together are the finding. The screen said no...
  assert.equal(usableCompareBase(root, "ahead"), undefined,
    "this is the pick that could not be made — merge-base equals HEAD, so the screen answered undefined");
  // ...while git has a two-way answer sitting right there, which is what the reader was asking for.
  const diff = execFileSync("git", ["diff", "--name-only", "ahead"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "a.txt", "their commit and mine differ, and `git diff <ref>` says so");
});

test("and reducing that ref to its merge-base would have hidden exactly what was asked for", () => {
  // Why the reduction was the refusal's cause rather than a safeguard beside it: against the merge-base
  // there is nothing of theirs left to see, so the honest answer is not available in those terms at all.
  const mergeBase = git("merge-base", "ahead", "HEAD");
  const againstBase = execFileSync("git", ["diff", "--name-only", mergeBase], { cwd: root, encoding: "utf8" }).trim();
  const againstRef = execFileSync("git", ["diff", "--name-only", "ahead"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(mergeBase, git("rev-parse", "HEAD"), "the merge-base of an ahead ref is HEAD itself");
  assert.equal(againstBase, "", "so a diff against it is empty — the review would have shown nothing");
  assert.notEqual(againstRef, againstBase, "while the ref itself has the comparison the reader wanted");
});
