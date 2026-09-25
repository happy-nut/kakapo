// The launcher's Worktrees section reads `git worktree list --porcelain` and decorates each row with the
// per-checkout state a reviewer actually asks for: what it is doing (HEAD subject), whether it has
// uncommitted work, and how far it has drifted from its upstream. The porcelain form is parsed rather than
// the human one because a worktree path may contain spaces — which is what the second checkout here is for.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBranchPullRequests, readWorktrees, shortWorktreePath } from "../dist/worktrees.js";

let root;
let spaced;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-worktrees-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Worktree Reviewer");
  git(root, "config", "user.email", "worktree@example.test");
  writeFileSync(join(root, "shared.txt"), "root\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-q", "-m", "root commit");

  // A second checkout whose path contains a space: `git worktree list` (without --porcelain) aligns its
  // columns with spaces, so this row is exactly the one that parses wrong if the human form is read.
  spaced = join(root, "..", `kakapo wt ${Date.now()}`);
  git(root, "worktree", "add", "-q", "-b", "feature/topic", spaced);
  writeFileSync(join(spaced, "topic.txt"), "topic\n");
  git(spaced, "add", "topic.txt");
  git(spaced, "commit", "-q", "-m", "topic work");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (spaced) rmSync(spaced, { recursive: true, force: true });
});

test("lists every checkout sharing the repository, current one first", async () => {
  const worktrees = await readWorktrees(root);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0].current, true, "the calling root anchors the list");
  assert.equal(worktrees[0].branch, "main");
  assert.equal(worktrees.filter((w) => w.current).length, 1);
  const topic = worktrees.find((w) => w.branch === "feature/topic");
  assert.ok(topic, "the added worktree is listed");
  assert.equal(topic.current, false);
  assert.equal(topic.path.includes(" "), true, "a path with a space survives parsing");
  assert.equal(topic.subject, "topic work", "the row says what the checkout was last doing");
  assert.equal(topic.shortHead.length, 8);
});

test("reports uncommitted tracked changes, and ignores untracked noise", async () => {
  const clean = (await readWorktrees(root)).find((w) => w.branch === "feature/topic");
  assert.equal(clean.dirty, false);

  // Build output and caches differ per worktree; counting them would mark every row dirty forever.
  writeFileSync(join(spaced, "untracked.log"), "noise\n");
  const stillClean = (await readWorktrees(root)).find((w) => w.branch === "feature/topic");
  assert.equal(stillClean.dirty, false, "untracked files are not uncommitted work");

  writeFileSync(join(spaced, "topic.txt"), "topic edited\n");
  const dirty = (await readWorktrees(root)).find((w) => w.branch === "feature/topic");
  assert.equal(dirty.dirty, true);
  git(spaced, "checkout", "-q", "--", "topic.txt");
  rmSync(join(spaced, "untracked.log"), { force: true });
});

test("counts drift against the branch's own upstream, and omits it when there is none", async () => {
  const noUpstream = (await readWorktrees(root)).find((w) => w.branch === "feature/topic");
  assert.equal(noUpstream.ahead, undefined);
  assert.equal(noUpstream.behind, undefined);

  // A local ref standing in for a remote branch. The remote itself has to exist in config before git will
  // accept it as tracking information, but nothing is ever fetched: origin points back at this same repo.
  git(root, "remote", "add", "origin", root);
  git(root, "update-ref", "refs/remotes/origin/topic", git(root, "rev-parse", "HEAD"));
  git(spaced, "branch", "-q", "--set-upstream-to=origin/topic");
  const tracked = (await readWorktrees(root)).find((w) => w.branch === "feature/topic");
  assert.equal(tracked.ahead, 1, "one commit the upstream does not have");
  assert.equal(tracked.behind, 0);
});

test("a removed worktree directory is listed as missing rather than dropped", async () => {
  const throwaway = join(root, "..", `kakapo wt gone ${Date.now()}`);
  git(root, "worktree", "add", "-q", "-b", "gone", throwaway);
  rmSync(throwaway, { recursive: true, force: true });
  const gone = (await readWorktrees(root)).find((w) => w.branch === "gone");
  assert.ok(gone, "the row survives so the reviewer can see why it is dead");
  assert.equal(gone.prunable, true);
  assert.equal(gone.dirty, false, "no working copy is read for a directory that is not there");
  git(root, "worktree", "prune");
});

// A list of worktrees is a list of near-identical paths: `~/repos/app/.claude/worktrees/<name>` over and
// over, where the only part that tells them apart is the last segment. An end ellipsis eats exactly that, so
// the middle is what gives way.
test("the display path keeps both ends and drops the middle", () => {
  const home = "/Users/dev";
  assert.equal(
    shortWorktreePath("/Users/dev/repos/app/.claude/worktrees/issue-1731-c87b33", home),
    "~/repos/…/worktrees/issue-1731-c87b33",
    "the name at the end is the whole point of the row",
  );
  // The distinguishing segment is not always last: here the checkout is named after the repo and the
  // worktree name sits one above it. Keeping two segments from each end holds on to both shapes.
  assert.equal(
    shortWorktreePath("/Users/dev/.codex/worktrees/repo-x/selection-rules/app", home),
    "~/.codex/…/selection-rules/app",
  );
  // Short enough to read whole: left alone rather than elided for the sake of it.
  assert.equal(shortWorktreePath("/Users/dev/repos/app", home), "~/repos/app");
  assert.equal(shortWorktreePath("/Users/dev/.codex/worktrees/selection-rules/app", home), "~/.codex/worktrees/selection-rules/app");
  assert.equal(shortWorktreePath("/Users/dev", home), "~");
  // A path outside home keeps its root; nothing is invented when there is no home to strip.
  assert.equal(shortWorktreePath("/srv/build/app", home), "/srv/build/app");
  assert.equal(shortWorktreePath("/a/b/c/d/e/f/g", ""), "/a/…/f/g");
  assert.equal(shortWorktreePath("", home), "");
});

test("every row carries a display path alongside the real one", async () => {
  const worktrees = await readWorktrees(root);
  for (const worktree of worktrees) {
    assert.ok(worktree.displayPath, `${worktree.path} has a display path`);
    assert.ok(worktree.displayPath.length <= worktree.path.length, "it is never longer than what it stands for");
  }
});

test("a non-repository answers with an empty list instead of throwing", async () => {
  const bare = mkdtempSync(join(tmpdir(), "kakapo-not-a-repo-"));
  assert.deepEqual(await readWorktrees(bare), []);
  rmSync(bare, { recursive: true, force: true });
});

test("pull-request lookup degrades to no badges when gh cannot answer", async () => {
  // This repository's only remote is a local path, so `gh` (installed or not, authenticated or not) has no
  // GitHub repository to ask about.
  // Every failure mode has to land on the same value: an empty map, never a throw and never a hang.
  assert.deepEqual(await readBranchPullRequests(root, 4000), {});
});
