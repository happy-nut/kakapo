import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewDiffSignature } from "../dist/review-bodies.js";
import { decideWatchTick } from "../dist/watch-decision.js";
import { buildDiffReview } from "../dist/build.js";

let root;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-watch-"));
  git("init", "-q", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "line one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { } });

const options = () => ({ root, staged: false, includeUntracked: true, context: 3, ignoreWhitespace: false });
const signature = () => reviewDiffSignature(options(), undefined, undefined);

test("the diff signature moves when a tracked file's content moves", () => {
  writeFileSync(join(root, "a.txt"), "line one edited\n");
  const first = signature();
  writeFileSync(join(root, "a.txt"), "line one edited twice\n");
  assert.notEqual(signature(), first, "a one-word edit left the signature where it was");
});

test("a write that lands between the build and the first tick is still drawn", () => {
  writeFileSync(join(root, "a.txt"), "S1\n");
  const build = buildDiffReview({ ...options(), title: "t" });
  const baseline = build.watchSignature;
  assert.ok(baseline, "the build reported the tree it rendered");

  writeFileSync(join(root, "a.txt"), "S2\n");
  const tick = decideWatchTick(baseline, signature());
  assert.equal(tick.action, "rebuild", "the tick skipped a change the review had never drawn");
});

test("and a quiet repository still does not rebuild behind the reader", () => {
  writeFileSync(join(root, "a.txt"), "settled\n");
  const build = buildDiffReview({ ...options(), title: "t" });
  assert.deepEqual(decideWatchTick(build.watchSignature, signature()), { action: "skip" });
});
