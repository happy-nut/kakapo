// The review build runs in a worker thread so it never blocks the Electron main loop. These pin the worker
// contract: a worker build produces a snapshot equivalent to a direct build, writes the HTML file itself
// (the ~780KB string never crosses back), serves the full on-demand index, and correlates concurrent
// requests correctly. The main-process wiring that consumes this (buildReview/ensureFullProjectIndex) lives
// in app-main; the diff-first pull wiring is covered in diff-first.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ReviewBuilder } from "../dist/review-builder.js";
import { writeReviewWorkspace, collectReviewSourceIndex } from "../dist/review-workspace.js";

const dirs = [];
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-rb-"));
  dirs.push(dir);
  const git = (a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]); git(["config", "user.email", "p@p"]); git(["config", "user.name", "p"]); git(["config", "commit.gpgsign", "false"]);
  for (let i = 0; i < 60; i++) {
    const p = join(dir, `src/mod${i % 6}/file${i}.ts`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `export const v${i} = ${i};\n`);
  }
  git(["add", "-A"]); git(["commit", "-qm", "b"]);
  writeFileSync(join(dir, "src/mod0/file0.ts"), "// edited\nexport const c = 1;\n");
  return dir;
}
// review targets live OUTSIDE the repo (like the app's userData mirror) so a written file is not itself an
// untracked change that would perturb the very diff being built.
const out = mkdtempSync(join(tmpdir(), "kakapo-rb-out-"));
dirs.push(out);

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("worker build matches a direct build and writes the HTML file (no html in the snapshot)", async () => {
  const dir = makeRepo();
  const options = { root: dir, staged: false, includeUntracked: true, context: 12, ignoreWhitespace: false };
  const builder = new ReviewBuilder();
  const target = join(out, "worker.html");

  const snap = await builder.build(target, options, "t", true);
  const direct = writeReviewWorkspace(join(out, "direct.html"), options, "t", true);

  assert.equal(snap.signature, direct.signature, "worker signature matches direct build");
  assert.equal(snap.fullIndexDeferred, true, "diff-first deferral carried through the worker");
  assert.equal(snap.sourceFiles.length, direct.sourceFiles.length, "same changed-only source count");
  assert.ok(!("html" in snap), "the ~780KB HTML string does not cross back from the worker");
  assert.ok(existsSync(target) && readFileSync(target, "utf8").includes("kakapo-asset://app/viewer.client"), "the worker wrote a real review HTML file");
});

test("worker index returns the full tree; concurrent requests are correlated correctly", async () => {
  const dir = makeRepo();
  const options = { root: dir, staged: false, includeUntracked: true, context: 12, ignoreWhitespace: false };
  const builder = new ReviewBuilder();

  const [changed, full] = await Promise.all([
    builder.build(join(out, "c.html"), options, "t", true),
    builder.index(options),
  ]);
  assert.equal(full.length, collectReviewSourceIndex(options).length, "worker full index matches direct count");
  assert.ok(full.length > changed.sourceFiles.length, "full index is a superset of the changed-only set");

  // Many builds in flight at once must each resolve to their own correct result (id correlation).
  const results = await Promise.all(Array.from({ length: 8 }, (_, k) => builder.build(join(out, `r${k}.html`), options, "t", false)));
  assert.ok(results.every((r) => r.signature === results[0].signature && r.sourceFiles.length === full.length), "all concurrent full builds agree");
});
