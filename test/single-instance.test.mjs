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

test("desktop composition uses one shell BrowserWindow, isolated views, and explicit detached windows", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(source, /requestSingleInstanceLock\(\{ workspaceRoot: options\.root \}\)/);
  assert.match(source, /new WebContentsView/);
  assert.match(source, /host\.contentView\.addChildView\(view\)/);
  assert.match(source, /function activateWorkspace/);
  assert.match(source, /kakapo:hub-create/);
  assert.match(source, /kakapo:workspace-state/);
  assert.match(source, /setWorkspaceHubOpen/);
  assert.match(source, /isDetached: \(\)/);
  assert.equal((source.match(/new BrowserWindow\(/g) || []).length, 2);
});

test("shutdown teardown does not erase the restore-on-launch workspace session", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  // The shell "close" event is the one point that precedes every review-view teardown; it must latch the flag.
  assert.match(source, /shellWindow\.on\("close",\s*\(\)\s*=>\s*\{\s*appQuitting = true;/);
  // The per-view teardown persist must be gated on that flag, otherwise quitting rewrites the saved list empty.
  assert.match(source, /if \(!appQuitting\) persistWorkspaceSession\(\);/);
  // A fresh shell window means we are running again, so the flag must reset (guards shell recreation).
  assert.match(source, /appQuitting = false;[^\n]*\n\s*shellWindow = new BrowserWindow\(/);
});
