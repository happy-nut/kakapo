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
  const root = mkdtempSync(join(tmpdir(), "monacori-perf-"));
  const userData = mkdtempSync(join(tmpdir(), "monacori-perf-data-"));
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
  assert.equal(existsSync(join(root, ".monacori")), false, "performance evidence never creates project-local state");
});
