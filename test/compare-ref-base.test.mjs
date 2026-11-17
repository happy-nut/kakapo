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
  git("branch", "behind");
  commit("two\n", "two");
  git("checkout", "-q", "-b", "ahead");
  commit("theirs\n", "theirs");
  git("checkout", "-q", "-");
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { } });

test("for an ancestor of HEAD, the ref and its merge-base are the same revision", () => {
  const ref = git("rev-parse", "behind");
  assert.equal(usableCompareBase(root, "behind"), ref,
    "merge-base(X, HEAD) is X exactly when X is an ancestor of HEAD");
});

test("a ref with commits HEAD does not have was refused, and has a diff to show", () => {
  assert.equal(usableCompareBase(root, "ahead"), undefined,
    "this is the pick that could not be made — merge-base equals HEAD, so the screen answered undefined");
  const diff = execFileSync("git", ["diff", "--name-only", "ahead"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "a.txt", "their commit and mine differ, and `git diff <ref>` says so");
});

test("and reducing that ref to its merge-base would have hidden exactly what was asked for", () => {
  const mergeBase = git("merge-base", "ahead", "HEAD");
  const againstBase = execFileSync("git", ["diff", "--name-only", mergeBase], { cwd: root, encoding: "utf8" }).trim();
  const againstRef = execFileSync("git", ["diff", "--name-only", "ahead"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(mergeBase, git("rev-parse", "HEAD"), "the merge-base of an ahead ref is HEAD itself");
  assert.equal(againstBase, "", "so a diff against it is empty — the review would have shown nothing");
  assert.notEqual(againstRef, againstBase, "while the ref itself has the comparison the reader wanted");
});
