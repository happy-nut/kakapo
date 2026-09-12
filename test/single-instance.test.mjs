import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceRoot } from "../dist/git.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("workspace identity normalizes nested folders but keeps worktrees distinct", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-single-instance-"));
  try {
    const repo = join(base, "repo");
    const nested = join(repo, "packages", "app");
    const worktree = join(base, "feature-worktree");
    mkdirSync(nested, { recursive: true });
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Kakapo Test");
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo });
    git(repo, "worktree", "add", "-b", "feature/test", worktree);

    assert.equal(resolveWorkspaceRoot(nested), resolveWorkspaceRoot(repo));
    assert.notEqual(resolveWorkspaceRoot(worktree), resolveWorkspaceRoot(repo));
    assert.equal(resolveWorkspaceRoot(join(worktree, ".")), resolveWorkspaceRoot(worktree));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("desktop composition is one BrowserWindow per repository", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(source, /requestSingleInstanceLock\(\{ workspaceRoot: options\.root \}\)/);
  // A second launch in the SAME repository focuses the window already reviewing it; another repository gets
  // its own. That is the whole of the multi-window story now — no shell, no views, no detached hosts.
  assert.match(source, /function openOrFocusWorkspace/);
  assert.doesNotMatch(source, /new WebContentsView/, "a review is a window, not a view inside a shell");
  assert.doesNotMatch(source, /function activateWorkspace/, "there is no workspace to activate");
  assert.equal((source.match(/new BrowserWindow\(/g) || []).length, 1,
    "exactly one place makes a window, and it makes the review's own");
});
