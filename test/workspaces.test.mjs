import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedWorkspaceAsync, defaultBase, defaultBranch, removalRisk, removeManagedWorkspace, workspaceRecord } from "../dist/workspaces.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
test("managed worktree creation, risk detection, and safe removal", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-workspaces-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");
    assert.equal(defaultBase(repo), "main");
    // What the main checkout is expected to sit on, for the rail's off-trunk warning. The remote prefix comes
    // off — a worktree is on `main`, never on `origin/main` — and a repository that will not name a default
    // branch answers with nothing, because a drift you cannot name must not render as a warning.
    assert.equal(defaultBranch(repo), "main");
    sh(repo, "branch", "-m", "main", "trunk");
    assert.equal(defaultBranch(repo), "", "no origin/HEAD and no branch by a usual name -> no opinion");
    sh(repo, "branch", "-m", "trunk", "main");
    const ws = await createManagedWorkspaceAsync(repo, "My Task", { container: join(tmp, "managed") });
    assert.equal(ws.kind, "worktree");
    // The branch is a random pair, NOT the task name: that name is prose, often not in English, and it used to
    // land verbatim in a ref and a filesystem path. The pretty name survives as the alias instead.
    assert.match(ws.branch, /^kakapo\/[a-z]+-[a-z]+$/, "the worktree is named by a random pair");
    assert.equal(ws.alias, "My Task", "and the task name is kept as the alias");
    assert.equal(workspaceRecord(repo).kind, "main");
    writeFileSync(join(ws.path, "dirty.txt"), "x");
    assert.equal(removalRisk(ws).dirty, true);
    assert.throws(() => removeManagedWorkspace(ws), /uncommitted/);
    // A refused removal must leave the workspace whole. app-main now runs this BEFORE killing the
    // workspace's terminals precisely because it can fail, so "nothing happened" has to mean nothing.
    assert.ok(existsSync(ws.path), "a refused removal leaves the worktree on disk");
    assert.match(sh(repo, "worktree", "list"), new RegExp(ws.branch.replace("kakapo/", "")), "and leaves git still tracking it");

    // The hidden ask session's transcript lives outside the repository, keyed by a working directory that is
    // about to stop existing, and nothing else ever collects it.
    const config = mkdtempSync(join(tmpdir(), "kakapo-claude-"));
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const id = "0189bf3c-1c2e-4f9a-8b7d-2f0c5a6d4e11";
    const gitDir = sh(ws.path, "rev-parse", "--absolute-git-dir");
    mkdirSync(join(gitDir, "kakapo"), { recursive: true });
    writeFileSync(join(gitDir, "kakapo", "ask-session"), id + "\n");
    const project = join(config, "projects", "-some-slug");
    mkdirSync(join(project, id), { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), "{}\n");
    writeFileSync(join(project, "other-session.jsonl"), "{}\n");

    removeManagedWorkspace(ws, true, true);
    assert.equal(existsSync(join(project, `${id}.jsonl`)), false, "the workspace's own transcript goes with it");
    assert.equal(existsSync(join(project, id)), false, "and so does the session's state directory");
    assert.ok(existsSync(join(project, "other-session.jsonl")), "but nothing else in that project directory");
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(config, { recursive: true, force: true });
    // Deleting a workspace deletes the code. The tile disappearing is not the point of the action.
    assert.equal(existsSync(ws.path), false, "the worktree directory is gone from disk");
    assert.doesNotMatch(sh(repo, "worktree", "list"), /my-task/, "and git no longer tracks the worktree");
    assert.doesNotMatch(sh(repo, "branch", "--list"), /my-task/, "deleteBranch removed the branch too");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A workspace whose folder is deleted out from under kakapo answers nothing to `git rev-parse`, and empty
// answers used to read as "this is the project's main checkout": the rail labelled the dead path "main
// worktree", filed it under a project named after its own folder, and the delete guard ("the main checkout
// can only be closed") then refused to let you clean it up.
test("a workspace whose folder is gone is not mistaken for the project's main checkout", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-gone-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");
    const ws = await createManagedWorkspaceAsync(repo, "Doomed", { container: join(tmp, "managed") });
    assert.equal(workspaceRecord(ws.path).kind, "worktree");

    rmSync(ws.path, { recursive: true, force: true }); // deleted behind kakapo's back
    const record = workspaceRecord(ws.path);
    assert.notEqual(record.kind, "main", "an unreadable path claims nothing about being a main checkout");
    assert.equal(workspaceRecord(repo).kind, "main", "while the real main checkout still says so");
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
    assert.match(ws.branch, /^kakapo\/[a-z]+-[a-z]+$/);
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

// The dialog previews a slug and sends that same one back, so what was on screen is what gets created; and a
// description typed at creation is stored as the workspace's memo rather than a second field to keep in sync.
test("an explicit slug and description are honoured", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakapo-slug-"));
  try {
    const repo = join(tmp, "repo"); mkdirSync(repo);
    sh(repo, "init", "-b", "main"); sh(repo, "config", "user.email", "a@b.c"); sh(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "."); sh(repo, "commit", "-m", "init");

    const ws = await createManagedWorkspaceAsync(repo, "버그 픽스", {
      container: join(tmp, "managed"), slug: "quiet-heron", memo: "why this exists",
    });
    assert.equal(ws.branch, "kakapo/quiet-heron", "the previewed slug is the one created");
    assert.equal(ws.alias, "버그 픽스", "the Korean task name stays the display name");
    assert.equal(ws.memo, "why this exists");
    assert.ok(!ws.path.includes("버그"), "and never reaches the filesystem path");
    removeManagedWorkspace(ws, true, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Starting an agent for a fresh worktree and then stopping it on every command is the thing the worktree was
// created to make unnecessary, so both launch with their confirmation prompt off. The first word has to stay
// something agentForCommand answers to, or the workspace would run an agent its own tile could never badge.
test("each agent's launch command turns approvals off, and still names an agent kakapo recognises", async () => {
  const { AGENT_LAUNCH, agentForCommand } = await import("../dist/agent-resume.js");
  assert.deepEqual(Object.keys(AGENT_LAUNCH).sort(), ["claude", "codex"]);
  for (const [kind, command] of Object.entries(AGENT_LAUNCH)) {
    assert.equal(agentForCommand(command), kind, `${kind}'s launch line is still recognisably ${kind}`);
    assert.match(command, /--dangerously-/, `${kind} starts without asking per action`);
  }
});
