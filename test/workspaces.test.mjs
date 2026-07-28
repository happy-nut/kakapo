import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedWorkspace, createManagedWorkspaceAsync, defaultBase, removalRisk, removeManagedWorkspace, workspaceRecord } from "../dist/workspaces.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
test("managed worktree creation, risk detection, and safe removal", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-workspaces-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");
    assert.equal(defaultBase(repo), "main");
    const ws = createManagedWorkspace(repo, "My Task", { container: join(tmp, "managed") });
    assert.equal(ws.kind, "worktree"); assert.equal(ws.branch, "kakapo/my-task");
    assert.equal(workspaceRecord(repo).kind, "main");
    writeFileSync(join(ws.path, "dirty.txt"), "x");
    assert.equal(removalRisk(ws).dirty, true);
    assert.throws(() => removeManagedWorkspace(ws), /uncommitted/);
    removeManagedWorkspace(ws, true, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("async managed creation keeps fetch/worktree operations off the caller stack", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-workspaces-async-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");
    const pending = createManagedWorkspaceAsync(repo, "Async Task", { container: join(tmp, "managed") });
    assert.equal(typeof pending.then, "function");
    const ws = await pending;
    assert.equal(ws.branch, "kakapo/async-task");
    removeManagedWorkspace(ws, true, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("async managed creation can be cancelled before fetch creates a worktree", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-workspaces-cancel-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createManagedWorkspaceAsync(repo, "Cancelled Task", { container: join(tmp, "managed"), signal: controller.signal }),
      /cancelled/i,
    );
    assert.doesNotMatch(sh(repo, "branch", "--list"), /cancelled-task/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
