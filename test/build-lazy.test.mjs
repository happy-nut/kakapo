// Characterization of the large-repo lazy build path — the hot path that partial-rebuild (ProjectIndex/
// ChangeSet) and diff-first-startup work will refactor. The rest of the suite exercises tiny fixtures
// (~2 files/30 lines) that never cross shouldLazyRender, so nothing pinned the lazy shape until now.
// These assert the invariants a refactor MUST preserve, not incidental HTML (which embeds the temp path).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, renderLazyBodies, cleanupFixtures } from "./helpers/fixture.mjs";
import { shouldLazyRender } from "../dist/render.js";

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

test("build signature is deterministic and path-independent (the watch fast-path depends on this)", async () => {
  const files = bigFixture();
  const a = await makeReviewHtml(files, { lazyLoad: true, app: true });
  const b = await makeReviewHtml(files, { lazyLoad: true, app: true });
  assert.equal(a.build.signature, b.build.signature, "identical content in different temp dirs yields the same signature");
});
