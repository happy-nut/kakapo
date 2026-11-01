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

// ---- the Changes tree's order IS the diff body's order -----------------------------------------------
// The tree used to sort folders above files and then by name, which is how a PROJECT tree is laid out. In
// a tree of CHANGES that put `src/viewer/01-core.js` at the top because it is under a folder and
// `README.md` at the bottom because it is not — while the diff body, and therefore F7, started at
// README.md. Two orders for one list of files, with nothing on screen saying which one you were in.
const diffFile = (displayPath, hunks = 1) => ({
  displayPath,
  oldPath: displayPath,
  newPath: displayPath,
  hunks: Array.from({ length: hunks }, () => ({ lines: [] })),
});
/** The leaf rows the tree renders, in render order. */
const treeOrder = (html) => [...html.matchAll(/data-file="([^"]+)"/g)].map((m) => m[1]);

test("renderDiffTree lists files in the order the diff body has them, not folders-first", async () => {
  const { renderDiffTree } = await import("../dist/render-tree.js");
  // Exactly the shape that was wrong: a root file, a shallow file, and a deeper one under a folder.
  const files = [
    diffFile("README.md"),
    diffFile("src/i18n.ts"),
    diffFile("src/viewer/01-core.js"),
    diffFile("test/a.test.mjs"),
  ];
  const order = treeOrder(renderDiffTree(files));
  assert.deepEqual(order, files.map((f) => f.displayPath), "row N is the body's Nth file");
});

test("renderDiffTree: a folder takes the place of its FIRST changed file", async () => {
  const { renderDiffTree } = await import("../dist/render-tree.js");
  // src/viewer/* is split either side of src/zz.ts in the body; the folder must lead, because its first
  // file does — and src/zz.ts must still follow it rather than being pulled above by the name sort.
  const files = [
    diffFile("src/viewer/01-core.js"),
    diffFile("src/zz.ts"),
    diffFile("src/viewer/02-diff-nav.js"),
  ];
  const order = treeOrder(renderDiffTree(files));
  assert.equal(order[0], "src/viewer/01-core.js", "the folder leads because its first file does");
  assert.equal(order[order.length - 1], "src/zz.ts", "a later root file stays later");
});

test("renderDiffTree: a module groups its files but does not jump the queue", async () => {
  const { renderDiffTree } = await import("../dist/render-tree.js");
  // moduleEntryFor ignores a single module — one module is the project, not a grouping — so this needs two.
  const files = [diffFile("README.md"), diffFile("packages/ui/a.ts"), diffFile("packages/core/c.ts")];
  const modules = [
    { name: "@acme/ui", root: "packages/ui" },
    { name: "@acme/core", root: "packages/core" },
  ];
  const html = renderDiffTree(files, new Map(), modules);
  assert.match(html, /@acme\/ui/, "the node is named for the module, not the folder");
  assert.deepEqual(treeOrder(html), files.map((f) => f.displayPath),
    "the module sits where its first changed file does, so row N is still the body's Nth file");
});
