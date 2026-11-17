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
  abandoned = commit("three\n", "three");
  git("reset", "-q", "--hard", second);
  commit("three, rewritten\n", "three again");
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { } });

test("a mark the branch has moved past reports how far", () => {
  const mark = resolveReadMark(root, first);
  assert.ok(mark);
  assert.equal(mark.sha, first);
  assert.equal(mark.shortSha, first.slice(0, 7));
  assert.equal(mark.commits, 2);
});

test("a mark at HEAD offers nothing — there is nothing new to read", () => {
  assert.equal(resolveReadMark(root, git("rev-parse", "HEAD")), undefined);
});

test("a mark the branch was rewritten away from offers nothing", () => {
  assert.equal(git("cat-file", "-t", abandoned), "commit");
  assert.equal(resolveReadMark(root, abandoned), undefined);
});

test("a commit this repository does not have, and a mark that is not a sha, offer nothing", () => {
  assert.equal(resolveReadMark(root, "0".repeat(40)), undefined);
  assert.equal(resolveReadMark(root, "origin/main"), undefined);
  assert.equal(resolveReadMark(root, ""), undefined);
  assert.equal(resolveReadMark(root, undefined), undefined);
});
