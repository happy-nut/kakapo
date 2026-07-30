// Characterization of the large-repo lazy build path — the hot path that partial-rebuild (ProjectIndex/
// ChangeSet) and diff-first-startup work will refactor. The rest of the suite exercises tiny fixtures
// (~2 files/30 lines) that never cross shouldLazyRender, so nothing pinned the lazy shape until now.
// These assert the invariants a refactor MUST preserve, not incidental HTML (which embeds the temp path).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, renderLazyBodies, cleanupFixtures } from "./helpers/fixture.mjs";
import { shouldLazyRender } from "../dist/render.js";
import { collectReviewSourceIndex } from "../dist/review-workspace.js";

after(cleanupFixtures);

const FILE_COUNT = 70;
const CHANGED = 40;

// 70 files (40 changed) — crosses shouldLazyRender via file count, and keeps 30 unchanged files tracked so
// we can assert the index spans the whole tree, not just the change set.
function bigFixture() {
  const files = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const before = Array.from({ length: 30 }, (_, l) => `line ${l} of file ${i}`).join("\n") + "\n";
    const after = i < CHANGED ? `${before}\n// changed ${i}\nexport const x${i} = ${i};\n` : before;
    files.push({ path: `src/mod${String(i).padStart(2, "0")}/file.ts`, before, after });
  }
  return files;
}

test("shouldLazyRender trips on a repo this size (the threshold the fixture is built to cross)", () => {
  assert.equal(shouldLazyRender(FILE_COUNT, 100), true, "70 files is over the lazy threshold");
  assert.equal(shouldLazyRender(3, 20), false, "a tiny change stays eager");
});

test("lazy build: bodies are deferred per changed file, the index spans the whole tree", async () => {
  const { build } = await makeReviewHtml(bigFixture(), { lazyLoad: true, app: true });

  assert.equal(build.lazyBodyDiffs.length, CHANGED, "one deferred diff body per changed file");
  assert.equal(build.lazySourceFiles.length, FILE_COUNT, "the source index covers every tracked file, not just the changed ones");
  assert.equal(build.lazySourceFiles.filter((f) => f.changed).length, CHANGED, "changed flag is set only on the changed files");
  assert.ok(build.lazySourceFiles.some((f) => !f.changed), "unchanged files stay in the index (partial-rebuild must preserve this)");
});

test("lazy build: the IPC update payload carries metadata only (content stripped)", async () => {
  const { build } = await makeReviewHtml(bigFixture(), { lazyLoad: true, app: true });
  const meta = build.update.sourceFilesMeta;
  assert.equal(meta.length, FILE_COUNT, "metadata for every file");
  assert.ok(meta.every((f) => f.content === "" && f.image === ""), "content/image are stripped from the on-the-wire payload");
});

test("lazy build: deferred bodies render highlighted diffs on demand", async () => {
  const { build } = await makeReviewHtml(bigFixture(), { lazyLoad: true, app: true });
  const bodies = await renderLazyBodies(build);
  assert.equal(bodies.length, CHANGED, "a body renders for each changed file");
  assert.ok(bodies.every((b) => b.includes("d2h")), "each rendered body is real diff2html markup");
});

test("V3: the app review references the client as an external kakapo-asset script; standalone inlines it", async () => {
  const files = [{ path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" }];
  const app = await makeReviewHtml(files, { app: true });
  const standalone = await makeReviewHtml(files, { app: false });

  // The app doc must NOT carry the ~514KB client inline — it references the immutably-cached, versioned asset
  // that the kakapo-asset:// handler serves once across windows. A blank review is the failure mode if this
  // tag is malformed, so pin its exact shape.
  assert.match(
    app.html,
    /<script src="kakapo-asset:\/\/app\/viewer\.client(?:\.min)?\.js\?v=[a-f0-9]+"><\/script>/,
    "app HTML references the external, cache-busted client",
  );
  // serve/standalone have no privileged scheme, so the client stays inline there.
  assert.ok(
    !standalone.html.includes("kakapo-asset://app/viewer.client"),
    "standalone/serve HTML has no external client reference",
  );
  // The payoff, checked against the bundle's own bytes: standalone carries the client inline, the app doc
  // does not. A distinctive slice from the bundle's middle avoids the markdown-it header it shares with no
  // one and any collision with the terminal island the app HTML also inlines.
  const client = readFileSync(new URL("../dist/viewer.client.min.js", import.meta.url), "utf8");
  const marker = client.slice(Math.floor(client.length / 2), Math.floor(client.length / 2) + 200);
  assert.ok(standalone.html.includes(marker), "standalone inlines the client bundle");
  assert.ok(!app.html.includes(marker), "the app doc does not inline the ~514KB client bundle");
});

test("diff-first: deferFullIndex indexes ONLY the changed files; the full index is a separate on-demand pass", async () => {
  const files = bigFixture();
  const { dir, build } = await makeReviewHtml(files, { lazyLoad: true, app: true, deferFullIndex: true });

  assert.equal(build.fullIndexDeferred, true, "a diff with changes defers the full index");
  assert.equal(build.lazySourceFiles.length, CHANGED, "the first paint carries only the changed files, not the whole tree");
  assert.ok(build.lazySourceFiles.every((f) => f.changed), "every source in the deferred build is a changed file");

  // The full index (what ensureFullProjectIndex materializes on the first project-index pull) spans the tree.
  const full = collectReviewSourceIndex({ root: dir, staged: false, includeUntracked: true, context: 12, ignoreWhitespace: false });
  assert.equal(full.length, FILE_COUNT, "the on-demand full index covers every tracked file");
  assert.equal(full.filter((f) => f.changed).length, CHANGED, "changed flags survive the full pass");
  assert.ok(full.some((f) => !f.changed), "the full index includes unchanged files the first paint omitted");
});

test("diff-first: a clean tree (no diff) builds the full index eagerly — nothing to defer", async () => {
  // No change → the source tree IS the content (initialReviewSources opens a README), so deferFullIndex must
  // fall back to a full build rather than paint an empty view first.
  const { build } = await makeReviewHtml(
    [{ path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 1;\n" }],
    { lazyLoad: true, app: true, deferFullIndex: true },
  );
  assert.equal(build.fullIndexDeferred, false, "no diff → no deferral");
  assert.ok(build.lazySourceFiles.some((f) => f.path === "src/a.ts"), "the unchanged file is indexed for the initial open");
});

test("build signature is deterministic and path-independent (the watch fast-path depends on this)", async () => {
  const files = bigFixture();
  const a = await makeReviewHtml(files, { lazyLoad: true, app: true });
  const b = await makeReviewHtml(files, { lazyLoad: true, app: true });
  assert.equal(a.build.signature, b.build.signature, "identical content in different temp dirs yields the same signature");
});
