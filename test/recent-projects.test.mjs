import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPreferences } from "../dist/app-preferences.js";
import { isLinkedWorktree } from "../dist/git.js";

const scratch = [];
test.after(() => { while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true }); });

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `kakapo-${prefix}-`));
  scratch.push(dir);
  return dir;
}

function repository() {
  const root = scratchDir("recents-repo");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@kakapo.local");
  git("config", "user.name", "kakapo test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { root, git };
}

function worktreeOf({ root, git }) {
  const linked = join(scratchDir("recents-wt"), "wt");
  git("worktree", "add", "-q", "-b", "feature", linked);
  return linked;
}

function preferences(belongs, userData = scratchDir("recents-userdata")) {
  return new AppPreferences(userData, belongs);
}

function recentPaths(prefs) {
  return prefs.readRecentProjects().map((project) => project.path);
}

test("a linked worktree is told apart from the checkout it came from", () => {
  const repo = repository();
  const linked = worktreeOf(repo);
  assert.equal(isLinkedWorktree(repo.root), false);
  assert.equal(isLinkedWorktree(linked), true,
    "a worktree's own git dir lives under the shared one, which is the only thing that distinguishes the two");
  assert.equal(isLinkedWorktree(scratchDir("recents-plain")), false,
    "a folder with no repository in it is not a worktree, and the welcome screen still offers it");
});

test("a submodule is a project of its own, although its .git is a file too", () => {
  const host = repository();
  const lib = repository();
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.root, "vendor"],
    { cwd: host.root, stdio: "pipe" });
  const vendor = join(host.root, "vendor");
  assert.equal(statSync(join(vendor, ".git")).isFile(), true,
    "the cheap test for a worktree is that .git is a file rather than a directory, and a submodule reads the same");
  assert.equal(isLinkedWorktree(vendor), false,
    "so the file case is the one that asks git, where a submodule's own git dir is also its common one");
});

test("the recent list drops worktrees and keeps every other folder", () => {
  const repo = repository();
  const linked = worktreeOf(repo);
  const plain = scratchDir("recents-plain");
  const prefs = preferences((path) => !isLinkedWorktree(path));

  prefs.recordRecentProject(repo.root);
  prefs.recordRecentProject(linked);
  prefs.recordRecentProject(plain);

  assert.deepEqual(recentPaths(prefs).sort(), [plain, repo.root].sort(),
    "the list shows a folder's name and path, and a worktree's say nothing about what it is for");
});

test("a worktree already in the list is swept on the next launch", () => {
  const repo = repository();
  const linked = worktreeOf(repo);
  const userData = scratchDir("recents-userdata");

  const asItWasWritten = preferences(() => true, userData);
  asItWasWritten.recordRecentProject(linked);
  asItWasWritten.recordRecentProject(repo.root);
  assert.deepEqual(recentPaths(asItWasWritten).sort(), [linked, repo.root].sort(),
    "the entries to sweep are the ones versions before this change wrote");

  const prefs = preferences((path) => !isLinkedWorktree(path), userData);
  prefs.pruneRecentProjects();
  assert.deepEqual(recentPaths(prefs), [repo.root],
    "a refusal that only applies to new entries leaves the list the user complained about untouched");
});
