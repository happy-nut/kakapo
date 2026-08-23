import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewPerformanceTrace } from "../dist/perf.js";
import { workspacePerformanceDirectory } from "../dist/workspace-data.js";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("performance trace preserves bounded, inspectable local evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-perf-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-perf-data-"));
  roots.push(root);
  roots.push(userData);
  const trace = new ReviewPerformanceTrace(root, userData);
  trace.mark("window-created");
  trace.mark("first-review-paint", { lazy: true });

  const artifact = JSON.parse(readFileSync(join(workspacePerformanceDirectory(userData, root), "latest.json"), "utf8"));
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.root, root);
  assert.deepEqual(artifact.events.map((event) => event.name), ["window-created", "first-review-paint"]);
  assert.equal(artifact.events[1].details.lazy, true);
  assert.ok(artifact.events[1].elapsedMs >= artifact.events[0].elapsedMs);
  assert.equal(existsSync(join(root, ".kakapo")), false, "performance evidence never creates project-local state");
});

// Body HTML is about 17x the diff text it comes from, and main used to keep one for every file ever opened,
// per workspace, until the next rebuild. On a 1,352-file review that is ~1.8 GB — measured 2.1 GB of main
// heap for a single such workspace, and V8 aborting the app ("JavaScript heap out of memory") once a second
// one was activated. The cache is a budget now; re-rendering an evicted body costs one render of the file the
// reader just asked for.
test("the per-workspace diff-body cache is bounded, not a Map that only grows", async () => {
  const { ByteBudgetCache } = await import("../dist/util.js");
  const appMain = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(appMain, /bodyCache: ByteBudgetCache<string>/, "the state field is the bounded cache");
  assert.match(appMain, /BODY_CACHE_BYTES = \d[\d_]*/, "with a named budget");
  assert.doesNotMatch(appMain, /bodyCache: new Map\(\)/, "and no unbounded Map is left behind");

  // The budget evicts the OLDEST first and keeps what was just stored.
  const cache = new ByteBudgetCache(10, (value) => value.length);
  cache.set("a", "12345");
  cache.set("b", "12345");
  cache.set("c", "12345");
  assert.equal(cache.get("a"), undefined, "the oldest body is the one that goes");
  assert.equal(cache.get("c"), "12345", "the newest is kept");
  assert.ok(cache.stats().bytes <= 10, "and the budget holds");
  cache.clear();
  assert.equal(cache.stats().bytes, 0, "a rebuild can still empty it");
});

// The per-file diffs are the biggest thing a build makes — 106 MB of text for a 1,352-file compare — and main
// used to hold every byte, per open workspace, cloned across the worker boundary to get there. That is what
// put its heap in gigabyte territory and left GC storming through everything else. The build writes them down
// beside the review instead; main keeps a [start, length] index and reads one slice when a body is asked for.
test("a build's diff bodies live on disk, and main keeps only an index of them", async () => {
  const { writeReviewWorkspace, readReviewBody, reviewBodyCount, allReviewBodies } = await import("../dist/review-workspace.js");
  const dir = mkdtempSync(join(tmpdir(), "kakapo-bodies-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");

  const target = join(dir, "review", "app-review.html");
  const snapshot = writeReviewWorkspace(target, { root: dir, staged: false, includeUntracked: true, context: 12, ignoreWhitespace: false }, "Kakapo");

  assert.equal(typeof snapshot.bodies.file, "string", "the snapshot names the file");
  assert.equal(reviewBodyCount(snapshot.bodies), 2, "with one [start, length] pair per changed file");
  assert.equal(snapshot.bodyDiffs, undefined, "and carries no diff text of its own");
  assert.match(readReviewBody(snapshot.bodies, 0), /a\.ts/, "a slice read is that file's diff");
  assert.match(readReviewBody(snapshot.bodies, 1), /b\.ts/, "…and the next one is the next file's");
  assert.equal(readReviewBody(snapshot.bodies, 7), "", "an index past the end reads as nothing, never a throw");
  assert.equal(allReviewBodies(snapshot.bodies).length, 2, "the whole set is still available for folding context");
  rmSync(dir, { recursive: true, force: true });
});
