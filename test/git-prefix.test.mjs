// The repository-relative prefix must come from git, not from path arithmetic.
//
// Review paths are relative to the folder the reviewer opened; every git spec (`<rev>:<path>`) is relative
// to the repository root. Bridging the two used to be `relative(repoRoot(root), root)` — two strings from
// two different authorities, Node's idea of the path and git's. They disagree whenever `root` reaches the
// repository through a symlink, which on macOS is the ordinary case for anything under `os.tmpdir()`:
// `/var` is a symlink to `/private/var`, so Node says `/var/folders/…/repo/pkg` while
// `rev-parse --show-toplevel` says `/private/var/folders/…/repo`, and `relative` between them returns
// `../../../../../../../../var/folders/…`. Pasted into a blob spec that resolves to nothing — and
// readTargetBlobSource's own error branch then reports every file in an A→B compare as "file is not
// present in this revision". Not a crash: a wrong answer wearing the shape of a real one.
//
// So the fixture is deliberate in two ways. The repository lives under os.tmpdir() (that is what makes the
// symlink reachable at all) and is opened from a SUBDIRECTORY (with no prefix there is nothing to get
// wrong). The root is passed exactly as mkdtemp handed it over, uncanonicalized — calling realpathSync on
// it here would erase the condition under test.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repoRoot, workspaceGitPrefix } from "../dist/git.js";
import { materializeDeferredSourceFile } from "../dist/diff.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A repository with one package subdirectory and one commit. Returns the RAW paths — not realpath'd.
function monorepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-prefix-"));
  dirs.push(root);
  run(root, ["init", "-qb", "main"]);
  run(root, ["config", "user.email", "t@t.t"]);
  run(root, ["config", "user.name", "t"]);
  const pkg = join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "server.ts"), "export const port = 8080;\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "pkg/server.ts"]);
  return { root, pkg, revision: run(root, ["rev-parse", "HEAD"]) };
}

// os.tmpdir() is a symlink on macOS and a real directory on most Linux CI. Where it is not a symlink the
// old arithmetic happens to agree with git, so the precondition assertion below would be vacuous — this is
// what decides whether the fixture actually reproduces the bug on the machine running it.
const TMP_IS_SYMLINKED = realpathSync.native(tmpdir()) !== tmpdir();

test("the prefix of a subdirectory is what git says it is, symlinked path or not", () => {
  const { root, pkg } = monorepo();

  assert.equal(workspaceGitPrefix(pkg), "pkg", "a subdirectory's prefix is its repo-relative path");
  assert.equal(workspaceGitPrefix(root), "", "the repository root has no prefix");

  // The control. Without it this test would pass on a platform where the fixture cannot reproduce the
  // bug, and look like evidence anyway. Asserting the OLD computation is broken here is what proves the
  // assertion above is load-bearing rather than a coincidence.
  if (TMP_IS_SYMLINKED) {
    const arithmetic = relative(repoRoot(pkg), pkg).replace(/\\/g, "/");
    assert.notEqual(arithmetic, "pkg", "fixture reproduces the symlink disagreement");
    assert.ok(arithmetic.startsWith(".."), `path arithmetic escapes the repository: ${arithmetic}`);
  }
});

test("an A→B compare opened from a subdirectory reads its files from the revision", () => {
  const { pkg, revision } = monorepo();

  const materialized = materializeDeferredSourceFile(
    pkg,
    { path: "server.ts", content: "", deferred: true, embedded: false },
    revision,
  );

  // The bug's signature was this exact string on every file in the review.
  assert.equal(materialized.skippedReason, undefined, "the file is not reported absent from the revision");
  assert.equal(materialized.content, "export const port = 8080;\n", "and its content comes from the revision");
  assert.equal(materialized.deferred, false);
});

test("a file genuinely missing from the revision is still reported absent", () => {
  const { pkg, revision } = monorepo();

  const materialized = materializeDeferredSourceFile(
    pkg,
    { path: "never-existed.ts", content: "", deferred: true, embedded: false },
    revision,
  );

  // The positive control for the assertion above: "not reported absent" only means something if something
  // still can be. An implementation that dropped the error branch would satisfy the previous test alone.
  assert.equal(materialized.skippedReason, "file is not present in this revision");
});
