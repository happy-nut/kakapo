import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGitBlame } from "../dist/git-log.js";

let root;
let firstHash;

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(message, date) {
  git("add", ".");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git("rev-parse", "HEAD");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-blame-"));
  git("init", "-q");
  git("config", "user.name", "Ada Reviewer");
  git("config", "user.email", "ada@example.test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\nexport const stable = true;\n");
  firstHash = commit("add value", "2026-05-30T00:30:00+09:00");
  git("tag", "review-base");
  writeFileSync(join(root, "src", "value.ts"), "export const value = 2;\nexport const stable = true;\n");
  commit("change value", "2026-06-01T00:30:00+09:00");
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("file blame returns line-addressable date, author, summary, and commit", () => {
  const blame = readGitBlame(root, "src/value.ts");
  assert.equal(blame.length, 2);
  assert.deepEqual(blame.map((line) => line.line), [1, 2]);
  assert.equal(blame[0].author, "Ada Reviewer");
  assert.equal(blame[0].date, "2026-06-01");
  assert.equal(blame[0].summary, "change value");
  assert.match(blame[0].hash, /^[0-9a-f]{40}$/);
  assert.equal(blame[1].date, "2026-05-30");
});

test("file blame can attribute the exact base revision used by a side-by-side review", () => {
  const blame = readGitBlame(root, "src/value.ts", firstHash);
  assert.equal(blame.length, 2);
  assert.equal(blame[0].date, "2026-05-30");
  assert.equal(blame[0].summary, "add value");
  assert.equal(blame[0].hash, firstHash);
  assert.equal(readGitBlame(root, "src/value.ts", "review-base")[0].hash, firstHash, "named review bases resolve to an immutable commit");
});

test("file blame rejects paths outside the workspace and untracked files", () => {
  writeFileSync(join(root, "scratch.ts"), "export const scratch = true;\n");
  assert.deepEqual(readGitBlame(root, "../value.ts"), []);
  assert.deepEqual(readGitBlame(root, "scratch.ts"), []);
});
