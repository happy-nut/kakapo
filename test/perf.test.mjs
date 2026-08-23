import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
