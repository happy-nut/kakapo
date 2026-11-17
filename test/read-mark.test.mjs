// Where the reviewer stopped reading, and the three states in which there is nothing to offer.
//
// The feature is one row in the compare menu — "since you last read" — whose base is HEAD as it was when
// the reviewer last handed their review to an agent. The row is only ever as trustworthy as this function,
// because the failure it exists to prevent is silent: a base that is NOT an ancestor of HEAD still produces
// a diff, and that diff reads as the reviewer's own deletions. So the rebased-off case below is the point
// of the file, not an edge case — an agent working in a worktree amends and resets constantly, which is
// exactly how a mark stops being on the branch while still existing in the object database.
//
// Measured against a real repository: a claim about merge-base is not worth asserting against a mock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReadMark } from "../dist/patch-sets.js";

let root;
let first;
let second;
let abandoned;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (text, message) => {
  writeFileSync(join(root, "a.txt"), text);
  git("add", "a.txt");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-read-mark-"));
  git("init", "-q", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  first = commit("one\n", "one");
  second = commit("two\n", "two");
  // The agent's rewrite: a commit that was on the branch, then was not. It is still in the object database
  // (the reset leaves it reachable through the reflog), so "does this repository have it" is not the
  // question that saves us here — "is it still an ancestor of HEAD" is.
  abandoned = commit("three\n", "three");
  git("reset", "-q", "--hard", second);
  commit("three, rewritten\n", "three again");
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

test("a mark the branch has moved past reports how far", () => {
  const mark = resolveReadMark(root, first);
  assert.ok(mark);
  assert.equal(mark.sha, first);
  assert.equal(mark.shortSha, first.slice(0, 7));
  // first → second → "three again": two commits arrived while the reviewer was away.
  assert.equal(mark.commits, 2);
});

test("a mark at HEAD offers nothing — there is nothing new to read", () => {
  assert.equal(resolveReadMark(root, git("rev-parse", "HEAD")), undefined);
});

test("a mark the branch was rewritten away from offers nothing", () => {
  // The negative control this file exists for. Positive control first: the commit really IS still here, so
  // the refusal below is about ancestry and not about a missing object.
  assert.equal(git("cat-file", "-t", abandoned), "commit");
  assert.equal(resolveReadMark(root, abandoned), undefined);
});

test("a commit this repository does not have, and a mark that is not a sha, offer nothing", () => {
  assert.equal(resolveReadMark(root, "0".repeat(40)), undefined);
  assert.equal(resolveReadMark(root, "origin/main"), undefined);
  assert.equal(resolveReadMark(root, ""), undefined);
  assert.equal(resolveReadMark(root, undefined), undefined);
});
