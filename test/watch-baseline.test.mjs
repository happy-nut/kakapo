// The change the reviewer never saw.
//
// Reported from use: "sometimes a change doesn't seem to be reflected." The watcher is a per-second tick that
// hashes the diff and skips when the hash matches the last one it recorded. The hash was never the problem —
// it moves on a one-character edit, which the first assertion below holds it to. What was wrong is WHEN the
// baseline got recorded: every rebuild trigger cleared it, and the next tick then recorded whatever the tree
// said at that moment and returned without rebuilding. A write that landed between the build's own read and
// that tick was therefore absorbed into the baseline and never drawn, and because every later tick then
// compared equal, the review stayed one write out of date until some further change happened to move the hash.
//
// Written against the real functions and a real repository, not against a mock of the sequence: the defect
// was in the COMPOSITION of two pieces that are each correct alone, so a test of either one alone is green
// while a reviewer reads a stale diff. The build now hands its own reading over as the baseline
// (DiffReviewBuild.watchSignature), which is what the last two tests here pin.
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
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

const options = () => ({ root, staged: false, includeUntracked: true, context: 3, ignoreWhitespace: false });
const signature = () => reviewDiffSignature(options(), undefined, undefined);

test("the diff signature moves when a tracked file's content moves", () => {
  // The floor everything else stands on. An unstaged edit has no blob yet, so `git diff --raw` prints zeros
  // for that side and would not move on its own — reviewDiffSignature stats the paths raw names for exactly
  // that reason. If this ever fails, the watcher is blind and no baseline discipline can save it.
  writeFileSync(join(root, "a.txt"), "line one edited\n");
  const first = signature();
  writeFileSync(join(root, "a.txt"), "line one edited twice\n");
  assert.notEqual(signature(), first, "a one-word edit left the signature where it was");
});

test("a write that lands between the build and the first tick is still drawn", () => {
  // The reported symptom, as a sequence. S1 is what the build read and rendered; S2 lands before the first
  // tick — an agent's next write, a save in another editor.
  writeFileSync(join(root, "a.txt"), "S1\n");
  const build = buildDiffReview({ ...options(), title: "t" });
  const baseline = build.watchSignature;
  assert.ok(baseline, "the build reported the tree it rendered");

  writeFileSync(join(root, "a.txt"), "S2\n");
  const tick = decideWatchTick(baseline, signature());
  assert.equal(tick.action, "rebuild", "the tick skipped a change the review had never drawn");
});

test("and a quiet repository still does not rebuild behind the reader", () => {
  // The property the old seeding existed to protect, and the reason this fix is not simply "rebuild more".
  // An untouched tree hashes to what the build recorded, so the tick after first paint does nothing.
  writeFileSync(join(root, "a.txt"), "settled\n");
  const build = buildDiffReview({ ...options(), title: "t" });
  assert.deepEqual(decideWatchTick(build.watchSignature, signature()), { action: "skip" });
});
