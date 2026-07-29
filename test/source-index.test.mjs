// Unit coverage for the two seams split out of collectSourceFiles (the ProjectIndex/ChangeSet foundation for
// a future partial rebuild): computeChangeSet (pure, from the diff) and enumerateProjectPaths (the tree walk).
// Pinning these directly means the eventual "reindex only changed files" work can be verified in isolation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { computeChangeSet, enumerateProjectPaths } from "../dist/diff.js";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";

after(cleanupFixtures);

test("computeChangeSet: changed paths + added line numbers, /dev/null excluded", () => {
  const diffFiles = [
    { displayPath: "src/a.ts", hunks: [{ lines: [{ kind: "add", newLine: 3 }, { kind: "del", oldLine: 2 }, { kind: "add", newLine: 4 }] }] },
    { displayPath: "/dev/null", hunks: [] },
    { displayPath: "src/b.ts", hunks: [{ lines: [{ kind: "context", newLine: 1 }] }] },
  ];
  const { changed, changedLinesByPath } = computeChangeSet(diffFiles);
  assert.deepEqual([...changed].sort(), ["src/a.ts", "src/b.ts"], "/dev/null is not a changed path");
  assert.deepEqual(changedLinesByPath.get("src/a.ts"), [3, 4], "only added lines are recorded");
  assert.deepEqual(changedLinesByPath.get("src/b.ts"), [], "a file with no adds records an empty list");
});

test("enumerateProjectPaths: tracked + untracked source candidates, sorted, includes changed paths", async () => {
  const { dir } = await makeReviewHtml([
    { path: "src/keep.ts", before: "const a = 1;\n", after: "const a = 2;\n" }, // changed candidate
    { path: "lib/other.ts", before: "const b = 1;\n", after: "const b = 1;\n" }, // unchanged candidate
  ], { lazyLoad: true, app: true });

  const paths = enumerateProjectPaths(dir, new Set(["src/keep.ts"]));
  assert.ok(paths.includes("src/keep.ts"), "the changed file is enumerated");
  assert.ok(paths.includes("lib/other.ts"), "an unchanged source candidate is enumerated too (full-tree index)");
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)), "output is locale-sorted for stable order");
});
