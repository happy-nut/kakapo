import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, renderLazyBodies, cleanupFixtures } from "./helpers/fixture.mjs";
import { shouldLazyRender } from "../dist/render.js";
import { collectReviewSourceIndex } from "../dist/review-workspace.js";
import { materializeDeferredSourceFile } from "../dist/diff.js";

after(cleanupFixtures);

const FILE_COUNT = 70;
const CHANGED = 40;

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

  assert.match(
    app.html,
    /<script src="kakapo-asset:\/\/app\/viewer\.client(?:\.min)?\.js\?v=[a-f0-9]+"><\/script>/,
    "app HTML references the external, cache-busted client",
  );
  assert.ok(
    !standalone.html.includes("kakapo-asset://app/viewer.client"),
    "standalone/serve HTML has no external client reference",
  );
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

  const full = collectReviewSourceIndex({ root: dir, staged: false, includeUntracked: true, context: 12, ignoreWhitespace: false });
  assert.equal(full.length, FILE_COUNT, "the on-demand full index covers every tracked file");
  assert.equal(full.filter((f) => f.changed).length, CHANGED, "changed flags survive the full pass");
  assert.ok(full.some((f) => !f.changed), "the full index includes unchanged files the first paint omitted");
});

test("diff-first: a clean tree (no diff) builds the full index eagerly — nothing to defer", async () => {
  const { build } = await makeReviewHtml(
    [{ path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 1;\n" }],
    { lazyLoad: true, app: true, deferFullIndex: true },
  );
  assert.equal(build.fullIndexDeferred, false, "no diff → no deferral");
  assert.ok(build.lazySourceFiles.some((f) => f.path === "src/a.ts"), "the unchanged file is indexed for the initial open");
});

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_MIN = Buffer.from("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n", "utf8");

test("lazy build: images are deferred, not base64'd into the index", async () => {
  const files = [
    ...bigFixture(),
    { path: "assets/logo.png", before: PNG_1PX, after: PNG_1PX },
    { path: "assets/shot.jpg", before: PNG_1PX, after: PNG_1PX },
  ];
  const { dir, build } = await makeReviewHtml(files, { lazyLoad: true, app: true });

  const images = build.lazySourceFiles.filter((f) => f.path.startsWith("assets/"));
  assert.equal(images.length, 2, "both images are indexed");
  for (const file of images) {
    assert.equal(file.image, undefined, `${file.path} must not carry its bytes in the index`);
    assert.ok(file.deferred, `${file.path} must be marked deferred`);
    assert.ok(file.embedded, `${file.path} must be embedded so the viewer fetches it on open`);
  }

  const opened = materializeDeferredSourceFile(dir, images.find((f) => f.path.endsWith(".png")));
  assert.equal(opened.skippedReason, undefined, "a deferred image must not come back skipped");
  assert.equal(opened.deferred, false, "materializing clears the deferred flag");
  assert.equal(opened.image, `data:image/png;base64,${PNG_1PX.toString("base64")}`, "exact bytes round-trip");
});

test("a PDF is a previewable file, not a binary dead end", async () => {
  const { dir, build } = await makeReviewHtml(
    [...bigFixture(), { path: "docs/spec.pdf", before: PDF_MIN, after: PDF_MIN }],
    { lazyLoad: true, app: true },
  );
  const pdf = build.lazySourceFiles.find((f) => f.path === "docs/spec.pdf");
  assert.ok(pdf, "the PDF is indexed");
  assert.equal(pdf.skippedReason, undefined, "and not written off as a binary file");
  assert.ok(pdf.deferred && pdf.embedded, "it defers its bytes like an image, and is fetched on open");
  assert.equal(pdf.image, undefined, "so the index carries no base64");

  const opened = materializeDeferredSourceFile(dir, pdf);
  assert.equal(opened.skippedReason, undefined, "opening it does not re-run the binary sniff");
  assert.equal(opened.image, `data:application/pdf;base64,${PDF_MIN.toString("base64")}`, "exact bytes round-trip");

  const renderer = readFileSync(new URL("../src/viewer/11-render-http.js", import.meta.url), "utf8");
  assert.match(renderer, /data:application\/pdf'[\s\S]{0,120}renderPdfView/, "the preview branches on the mime it was given");
  assert.match(renderer, /<embed class="pdf-frame" type="application\/pdf"/, "into Chromium's own viewer");
  assert.match(renderer, /createObjectURL\(new Blob\(\[bytes\], \{ type: 'application\/pdf' \}\)\)/,
    "as a blob: URL — an <embed> with a data: URI is refused by the plugin loader");
  assert.match(readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8"),
    /spellcheck: false,[\s\S]{0,400}plugins: true/, "and the review view enables PDFium, or the embed is an empty box");
});

test("standalone build still inlines images — it has no IPC to fetch them through", async () => {
  const { build } = await makeReviewHtml(
    [{ path: "assets/logo.png", before: PNG_1PX, after: PNG_1PX }, { path: "src/a.ts", before: "a\n", after: "b\n" }],
    { lazyLoad: false, app: false },
  );
  assert.ok(
    build.html.includes(`data:image/png;base64,${PNG_1PX.toString("base64")}`),
    "a standalone review must carry its images inline — there is no get-source to fetch them later",
  );
});

test("build signature is deterministic and path-independent (the watch fast-path depends on this)", async () => {
  const files = bigFixture();
  const a = await makeReviewHtml(files, { lazyLoad: true, app: true });
  const b = await makeReviewHtml(files, { lazyLoad: true, app: true });
  assert.equal(a.build.signature, b.build.signature, "identical content in different temp dirs yields the same signature");
});
