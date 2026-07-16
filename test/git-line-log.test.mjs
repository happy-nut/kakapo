import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGitLineLog } from "../dist/git-log.js";

let root;

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(message) {
  git("add", ".");
  git("commit", "-q", "-m", message);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-line-log-"));
  git("init", "-q");
  git("config", "user.name", "Line Reviewer");
  git("config", "user.email", "line@example.test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\nexport const stable = true;\n");
  commit("add value");
  writeFileSync(join(root, "src", "value.ts"), "export const value = 2;\nexport const stable = true;\n");
  commit("change value");
  writeFileSync(join(root, "src", "value.ts"), "export const value = 2;\nexport const stable = false;\n");
  commit("change other line");
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("line log follows only commits that changed the selected line", () => {
  const commits = readGitLineLog(root, { path: "src/value.ts", line: 1 });
  assert.deepEqual(commits.map((commit) => commit.subject), ["change value", "add value"]);
  assert.ok(commits.every((commit) => commit.author === "Line Reviewer"));
  const nestedWorkspace = readGitLineLog(join(root, "src"), { path: "value.ts", line: 1 });
  assert.deepEqual(nestedWorkspace.map((commit) => commit.subject), ["change value", "add value"], "monorepo subfolders keep workspace-relative paths");
});

test("line log rejects paths outside the workspace and untracked files", () => {
  writeFileSync(join(root, "scratch.ts"), "export const scratch = true;\n");
  assert.deepEqual(readGitLineLog(root, { path: "../value.ts", line: 1 }), []);
  assert.deepEqual(readGitLineLog(root, { path: "scratch.ts", line: 1 }), []);
  assert.deepEqual(readGitLineLog(root, { path: "src/value.ts", line: 0 }), []);
});
