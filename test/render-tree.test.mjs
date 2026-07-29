// Pure-unit characterization of render-tree.ts. This module had no direct test coverage, yet it holds the
// initial-open selection logic (initialReviewSources) that the review-open path and any future
// partial-rebuild work must preserve. Import the real compiled functions from dist/ and pin their contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialReviewSources, sourceFileMetadata } from "../dist/render-tree.js";

// Minimal SourceFile stand-ins — initialReviewSources only reads path/name/embedded/changed.
const src = (path, { embedded = true, changed = false } = {}) => ({
  path, name: path.split("/").pop(), embedded, changed,
});
// collectSourceFiles sorts by localeCompare, so a deep "backstage/…/README.md" precedes root "README.md".
const localeSorted = (files) => [...files].sort((a, b) => a.path.localeCompare(b.path));

test("initialReviewSources: a clean tree opens the ROOT README, not the lexicographically-first deep one", () => {
  const files = localeSorted([
    src("backstage/appintoss/fe/README.md"),
    src("backstage/README.md"),
    src("docs/README.md"),
    src("src/index.ts"),
    src("README.md"),
    src("zzz/README.md"),
  ]);
  const picked = initialReviewSources([], files);
  assert.equal(picked.length, 1, "one default file for a clean tree");
  assert.equal(picked[0].path, "README.md", "breadth-first: the shallowest README wins");
});

test("initialReviewSources: no root README -> shallowest wins, ties break lexicographically", () => {
  const files = localeSorted([src("b/README.md"), src("a/README.md"), src("a/b/c/README.md")]);
  assert.equal(initialReviewSources([], files)[0].path, "a/README.md");
});

test("initialReviewSources: changed files take priority over any README", () => {
  const diffFiles = [{ displayPath: "src/app.ts", oldPath: "src/app.ts", newPath: "src/app.ts", hunks: [] }];
  const files = [src("README.md"), src("src/app.ts", { changed: true })];
  const picked = initialReviewSources(diffFiles, files);
  assert.ok(picked.some((f) => f.path === "src/app.ts"), "returns the changed set");
  assert.ok(!picked.some((f) => f.path === "README.md"), "README is not the default when there are changes");
});

test("initialReviewSources: only embedded READMEs are eligible defaults", () => {
  const files = localeSorted([src("README.md", { embedded: false }), src("pkg/README.md", { embedded: true })]);
  assert.equal(initialReviewSources([], files)[0].path, "pkg/README.md", "the non-embedded root README is skipped");
});

test("sourceFileMetadata strips content and image but preserves the rest", () => {
  const meta = sourceFileMetadata({
    path: "a/b.ts", name: "b.ts", language: "typescript", content: "secret", image: "data:...",
    size: 42, changed: true, embedded: true, signature: "sig", changedLines: [1, 2],
  });
  assert.equal(meta.content, "", "content is stripped for the metadata-only payload");
  assert.equal(meta.image, "", "image is stripped");
  assert.equal(meta.path, "a/b.ts");
  assert.equal(meta.size, 42, "non-content fields survive");
  assert.deepEqual(meta.changedLines, [1, 2]);
});
