// The comparison base is selectable again (gap #5): the default still diffs the working tree against an
// automatic base, but --base <ref> reviews it against any branch/tag/commit (so an already-committed AI
// feature branch can be reviewed whole) and --staged reviews the index against HEAD. These tests exercise
// buildDiffReview + validateReviewBase directly, which is exactly what parseArgs wires the flags into.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDiffReview } from "../dist/cli.js";
import { validateReviewBase } from "../dist/git.js";

const dirs = [];
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-base-"));
  dirs.push(root);
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@kakapo.test"]);
  git(["config", "user.name", "kakapo test"]);
  git(["config", "commit.gpgsign", "false"]);
  return { root, git };
}
function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
function review(root, extra) {
  return buildDiffReview({ staged: false, includeUntracked: true, context: 12, title: "t", lazyLoad: false, root, ...extra });
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

test("validateReviewBase accepts real refs and rejects typos and unsafe values", () => {
  const { root, git } = tempRepo();
  write(root, "a.ts", "one\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  assert.equal(validateReviewBase(root, "HEAD"), "HEAD");
  assert.throws(() => validateReviewBase(root, "no-such-branch"), /not a commit/);
  assert.throws(() => validateReviewBase(root, "oops; rm -rf /"), /Invalid --base/);
});

test("--base reviews already-committed changes that the default working-tree diff hides", () => {
  const { root, git } = tempRepo();
  write(root, "svc.ts", "const value = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  // The agent commits its change; the working tree is clean afterwards.
  write(root, "svc.ts", "const value = 2; // AGENT_EDIT\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);

  const def = review(root, { base: "HEAD" }); // working tree vs HEAD — clean, nothing to review
  assert.equal(def.files, 0, "the default working-tree diff shows nothing for a committed change");

  const branch = review(root, { base: "HEAD~1" }); // review the committed change against its parent
  assert.equal(branch.files, 1, "--base surfaces the committed change");
  assert.match(branch.html, /AGENT_EDIT/, "the committed edit appears in the review");
});

test("--staged reviews the index against HEAD, excluding unstaged edits", () => {
  const { root, git } = tempRepo();
  write(root, "a.ts", "a1\n");
  write(root, "b.ts", "b1\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  write(root, "a.ts", "a2 STAGED\n");
  git(["add", "a.ts"]);        // staged
  write(root, "b.ts", "b2 UNSTAGED\n"); // left in the working tree only

  // The changed-file COUNT is the true diff signal (the standalone HTML also embeds browsable source, so a
  // string can leak in outside the diff). Staged sees only the indexed file; the working tree sees both.
  const staged = review(root, { staged: true });
  assert.equal(staged.files, 1, "staged review shows only the one indexed file");
  assert.match(staged.html, /STAGED/, "and that file is the staged change");

  const worktree = review(root, { base: "HEAD" });
  assert.equal(worktree.files, 2, "the working-tree diff shows both the staged and the unstaged file");
});
