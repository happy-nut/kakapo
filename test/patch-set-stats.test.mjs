import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parsePatchSetStats, readPatchSetStats } from "../dist/patch-sets.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("a plain commit's files and lines are counted", () => {
  const stats = parsePatchSetStats([SHA_A, "", "3\t1\tsrc/a.ts", "0\t2\tsrc/b.ts", ""].join("\n"));
  assert.deepEqual(stats[SHA_A], { files: 2, added: 3, removed: 3, paths: ["src/a.ts", "src/b.ts"] });
});

test("a binary file counts as a file and adds no lines", () => {
  const stats = parsePatchSetStats([SHA_A, "", "-\t-\tassets/icon.png", "4\t0\tsrc/a.ts", ""].join("\n"));
  assert.equal(stats[SHA_A].files, 2);
  assert.equal(stats[SHA_A].added, 4);
  assert.equal(stats[SHA_A].removed, 0);
  assert.ok(stats[SHA_A].paths.includes("assets/icon.png"));
});

test("a merge commit is present with nothing in it", () => {
  const stats = parsePatchSetStats([SHA_A, "", SHA_B, "", "1\t0\tsrc/a.ts", ""].join("\n"));
  assert.deepEqual(stats[SHA_A], { files: 0, added: 0, removed: 0, paths: [] });
  assert.equal(stats[SHA_B].files, 1);
});

test("a rename keeps git's own path form", () => {
  const stats = parsePatchSetStats([SHA_A, "", "0\t0\tsrc/{a => b}.ts", ""].join("\n"));
  assert.deepEqual(stats[SHA_A].paths, ["src/{a => b}.ts"]);
});

test("a path holding a tab keeps all of itself", () => {
  const stats = parsePatchSetStats([SHA_A, "", "1\t0\tsrc/od\td.ts", ""].join("\n"));
  assert.deepEqual(stats[SHA_A].paths, ["src/od\td.ts"]);
});

test("a line that is not a sha and not a numstat row is ignored", () => {
  const stats = parsePatchSetStats([SHA_A, "", "commit something", "2\t0\tsrc/a.ts", ""].join("\n"));
  assert.equal(stats[SHA_A].files, 1);
});

test("the real command answers for the branch's commits and no others", async () => {
  const repo = mkdtempSync(join(tmpdir(), "kakapo-patch-stats-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  try {
    git("init", "-qb", "main");
    git("config", "user.email", "t@kakapo.test");
    git("config", "user.name", "t");
    put("src/a.ts", "one\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    put("src/a.ts", "one\ntwo\n");
    git("add", "-A"); git("commit", "-qm", "first");
    const first = git("rev-parse", "HEAD");

    put("src/a.ts", "one\n");
    put("src/b.ts", "three\n");
    git("add", "-A"); git("commit", "-qm", "second");
    const second = git("rev-parse", "HEAD");

    const stats = await readPatchSetStats(repo, base, second);
    assert.deepEqual(Object.keys(stats).sort(), [first, second].sort(),
      "the base commit is the range's floor, not one of its patch sets");
    assert.deepEqual(stats[first], { files: 1, added: 1, removed: 0, paths: ["src/a.ts"] });
    assert.equal(stats[second].files, 2);
    assert.equal(stats[second].added, 1, "b.ts's one line");
    assert.equal(stats[second].removed, 1, "a.ts's second line went again");

    assert.deepEqual(await readPatchSetStats(repo, "0".repeat(40), second), {});
    assert.deepEqual(await readPatchSetStats(repo, "", second), {});
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
