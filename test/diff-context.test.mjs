import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";

let readReviewDiffContext;
let fixture;

before(async () => {
  ({ readReviewDiffContext } = await import("../dist/diff-context.js"));
  const beforeLines = Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1};`);
  const afterLines = beforeLines.slice();
  afterLines[1] = "const line2 = 200;";
  afterLines[25] = "const line26 = 2600;";
  fixture = await makeReviewHtml([
    { path: "src/context.ts", before: beforeLines.join("\n") + "\n", after: afterLines.join("\n") + "\n" },
  ], { context: 2, lazyLoad: true });
});
after(cleanupFixtures);

test("diff context reads the exact base and working-tree lines for a reviewed folded range", () => {
  const result = readReviewDiffContext({
    root: fixture.dir,
    staged: false,
    bodyDiffs: fixture.build.lazyBodyDiffs,
    request: { path: "src/context.ts", oldStart: 8, oldEnd: 10, newStart: 8, newEnd: 10 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.oldLines, ["const line8 = 8;", "const line9 = 9;", "const line10 = 10;"]);
  assert.deepEqual(result.newLines, result.oldLines, "an omitted gap is unchanged across both reviewed revisions");
});

test("staged review context comes from the index, not later unstaged worktree edits", () => {
  execFileSync("git", ["add", "src/context.ts"], { cwd: fixture.dir });
  const worktree = Array.from({ length: 30 }, (_, index) => index === 8 ? "const worktreeOnly = true;" : `const line${index + 1} = ${index + 1};`);
  worktree[1] = "const line2 = 200;";
  worktree[25] = "const line26 = 2600;";
  writeFileSync(join(fixture.dir, "src/context.ts"), worktree.join("\n") + "\n");

  const result = readReviewDiffContext({
    root: fixture.dir,
    staged: true,
    bodyDiffs: fixture.build.lazyBodyDiffs,
    request: { path: "src/context.ts", oldStart: 9, oldEnd: 9, newStart: 9, newEnd: 9 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.oldLines[0], "const line9 = 9;");
  assert.equal(result.newLines[0], "const line9 = 9;", "the working-tree-only text is excluded from a staged review");
});

test("diff context rejects paths outside the current review", () => {
  const result = readReviewDiffContext({
    root: fixture.dir,
    staged: false,
    bodyDiffs: fixture.build.lazyBodyDiffs,
    request: { path: "../secret", oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.oldLines, []);
  assert.deepEqual(result.newLines, []);
});
