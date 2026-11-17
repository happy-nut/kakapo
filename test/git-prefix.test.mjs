import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repoRoot, workspaceGitPrefix } from "../dist/git.js";
import { materializeDeferredSourceFile } from "../dist/diff.js";
import { listRevisionFiles, readRevisionBlobs } from "../dist/git-tree.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

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

const TMP_IS_SYMLINKED = realpathSync.native(tmpdir()) !== tmpdir();

test("the prefix of a subdirectory is what git says it is, symlinked path or not", () => {
  const { root, pkg } = monorepo();

  assert.equal(workspaceGitPrefix(pkg), "pkg", "a subdirectory's prefix is its repo-relative path");
  assert.equal(workspaceGitPrefix(root), "", "the repository root has no prefix");

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

  assert.equal(materialized.skippedReason, "file is not present in this revision");
});

test("a whole-tree read from a subdirectory is scoped to that subdirectory", async () => {
  const { pkg, revision } = monorepo();

  assert.deepEqual(listRevisionFiles(pkg, revision), ["server.ts"],
    "the revision's files come back relative to the opened subdirectory");

  const blobs = await readRevisionBlobs(pkg, revision, ["server.ts"]);
  assert.deepEqual(blobs.map((blob) => blob.path), ["server.ts"]);
  assert.deepEqual(blobs.map((blob) => blob.content), ["export const port = 8080;\n"]);
});
