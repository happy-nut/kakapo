// Switching workspaces re-renders the rail, and the rail's tiles are git-derived. Computing them the only
// synchronous way — spawnSync git — costs ~5ms per call and ~45ms for `status --porcelain` on a real repo,
// times every open workspace AND every pinned project. On the Electron main process that is frozen UI at the
// exact moment the user is interacting, which is what made switching hitch. gitAsync is the seam that lets a
// tile revalidate without blocking; this pins its contract (same output as git(), same "" on failure) and
// proves it actually yields the thread while a slow command runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitAsync } from "../dist/git.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-gitasync-"));
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "first");
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("gitAsync returns exactly what the blocking git() returns", async () => {
  const repo = makeRepo();
  try {
    for (const args of [["branch", "--show-current"], ["status", "--porcelain"], ["rev-parse", "--show-toplevel"]]) {
      assert.equal(await gitAsync(repo.root, args), git(repo.root, args), args.join(" "));
    }
    // ...including once there is something to report, so the dirty-count path is covered.
    writeFileSync(join(repo.root, "b.txt"), "two\n");
    assert.equal(await gitAsync(repo.root, ["status", "--porcelain"]), git(repo.root, ["status", "--porcelain"]));
    assert.match(await gitAsync(repo.root, ["status", "--porcelain"]), /b\.txt/);
  } finally {
    repo.cleanup();
  }
});

test("a failing command resolves to empty, so callers need no error branch", async () => {
  const repo = makeRepo();
  try {
    assert.equal(await gitAsync(repo.root, ["rev-parse", "--verify", "does-not-exist"]), "");
    assert.equal(await gitAsync(repo.root, ["definitely-not-a-git-command"]), "");
    assert.equal(await gitAsync(join(repo.root, "nope"), ["status"]), "");
  } finally {
    repo.cleanup();
  }
});

test("gitAsync leaves the event loop free while git runs — the whole point of the seam", async () => {
  const repo = makeRepo();
  try {
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 1);
    await gitAsync(repo.root, ["status", "--porcelain"]);
    clearInterval(ticker);
    assert.ok(ticks > 0, `event loop kept running during the git call (ticks=${ticks})`);

    // The contrast: the blocking call cannot be interrupted, so no timer fires while it runs.
    let blockedTicks = 0;
    const blockedTicker = setInterval(() => { blockedTicks++; }, 1);
    git(repo.root, ["status", "--porcelain"]);
    clearInterval(blockedTicker);
    assert.equal(blockedTicks, 0, "spawnSync blocks the thread outright — that is the cost being avoided");
  } finally {
    repo.cleanup();
  }
});
