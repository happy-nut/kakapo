// CORE USER FLOW: navigating the review surface.
//
// A reviewer moves between the diff and the file's source, reads markdown/CSV the way it's meant to be
// read (rendered, with a real line gutter) or flips to raw text, and expects their comments to follow
// the file across views. These are the affordances that make the review usable; this file guards them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    {
      path: "README.md",
      before: "# Title\n\nIntro paragraph.\n\n## Section\n\nBody text here.\n",
      after: "# Title\n\nIntro paragraph.\n\n## Section\n\nUpdated body text.\n",
    },
    {
      path: "src/app.ts",
      before: "export const x = 1;\nexport const y = 2;\n",
      after: "export const x = 1;\nexport const y = 3;\n",
    },
    {
      path: "data.csv",
      before: "name,score\nalice,1\nbob,2\n",
      after: "name,score\nalice,1\nbob,3\n",
    },
  ]));
});
after(cleanupFixtures);

test("changes list and file tree include every changed file", async () => {
  const v = await loadViewer(html);
  for (const path of ["README.md", "src/app.ts", "data.csv"]) {
    assert.ok(v.$(`.change-row[data-file="${path}"]`), `changes list has ${path}`);
    assert.ok(v.$(`.source-link[data-source-file="${path}"]`), `file tree has ${path}`);
  }
  v.close();
});

test("switches from the source view to the diff view and back", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");

  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");

  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");
  v.close();
});

test("markdown opens rendered as sparse, line-numbered blocks", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("README.md");

  const body = v.$("#source-body");
  assert.ok(body.classList.contains("rendered-body"), "rendered (not raw) by default");
  assert.ok(v.$("#source-body .source-row.md-row"), "rows are markdown blocks");

  // Blocks are keyed by their start line, so indices are sparse — this is exactly what makes line
  // comments anchor correctly in the rendered view.
  const indices = v.sourceRowLineIndices();
  assert.deepEqual(indices, [0, 2, 4, 6], "one row per block, keyed by start line");
  v.close();
});

test("markdown raw toggle switches to contiguous, every-line text", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("README.md");
  await v.clickRenderToggle();

  const body = v.$("#source-body");
  assert.equal(body.classList.contains("rendered-body"), false, "raw mode drops rendered-body");
  assert.equal(v.$("#source-body .source-row.md-row"), null, "no markdown block rows in raw mode");

  // Raw text shows every physical line, contiguously (vs. the 4 sparse blocks when rendered).
  const indices = v.sourceRowLineIndices();
  assert.deepEqual(
    indices,
    indices.map((_, i) => i),
    "line indices are contiguous from 0 (one row per physical line)",
  );
  assert.ok(indices.length > 4, "raw shows more rows than the rendered block count");
  v.close();
});

test("CSV opens rendered as an aligned table with a row per record", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("data.csv");

  assert.ok(v.$("#source-body .source-row.csv-row"), "rows are CSV records");
  // header + alice + bob = 3 records (keyed 0,1,2)
  assert.deepEqual(v.sourceRowLineIndices(), [0, 1, 2]);
  assert.ok(v.$("#source-body .csv-row.csv-head"), "header row is marked");
  v.close();
});

test("a comment left in one view is visible after switching views", async () => {
  const v = await loadViewer(html);
  // leave a comment in the source view
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); // `export const y = 3;`
  await v.openComposer("q");
  await v.writeAndSave("follows across views");
  assert.deepEqual(v.visibleCardTexts(), ["follows across views"]);

  // switch to the diff view — the same comment must render there too
  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");
  assert.deepEqual(v.visibleCardTexts(), ["follows across views"]);
  v.close();
});

test("per-file comment count badge appears for a commented file", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("badge me");

  const badged = v.$(`.change-row[data-file="src/app.ts"] .mc-file-badge`);
  assert.ok(badged, "a count badge is injected next to the changed file");
  v.close();
});

test("Cmd+Down in the diff view jumps to the file's source (new/working-tree side)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");

  v.key("ArrowDown", { metaKey: true }); // Cmd/Ctrl+Down: diff caret -> open that file's source
  await v.settle(100);

  assert.equal(v.visibleView(), "source", "switched to the source view");
  assert.equal(v.$("#source-viewer")?.dataset.openPath, "src/app.ts");
  assert.match(
    v.$("#source-body").textContent,
    /export const y = 3/,
    "source shows the new (working-tree) content, not the old side",
  );
  v.close();
});

test("background-work progress shows a bar under the footer and hides when done", async () => {
  const v = await loadViewer(html);
  const foot = v.$("#footer-progress");
  assert.ok(foot, "footer progress element is rendered");
  assert.ok(foot.classList.contains("hidden"), "hidden when idle");
  assert.equal(typeof v.window.setIndexProgress, "function", "progress hook is reachable");

  v.window.setIndexProgress(3, 10);
  assert.equal(foot.classList.contains("hidden"), false, "shown while work runs");
  assert.equal(foot.firstElementChild.style.width, "30%");

  v.window.setIndexProgress(10, 10);
  assert.ok(foot.classList.contains("hidden"), "hidden again when done");
  v.close();
});

test("clean tree (no changes): opens the file view with README, not an empty diff", async () => {
  // before === after for every file ⇒ git diff is empty (nothing to review).
  const { html } = await makeReviewHtml([
    { path: "AAA.md", before: "# AAA\n", after: "# AAA\n" }, // sorts before README
    { path: "README.md", before: "# Readme\n\nhello\n", after: "# Readme\n\nhello\n" },
  ]);
  const v = await loadViewer(html);
  assert.equal(v.visibleView(), "source", "file view is shown, not an empty diff pane");
  assert.equal(v.$("#source-viewer").dataset.openPath, "README.md", "README is opened by default");
  v.close();
});
