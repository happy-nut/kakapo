// CORE USER FLOW: navigating the review surface.
//
// A reviewer moves between the diff and the file's source, reads markdown/CSV the way it's meant to be
// read (rendered, with a real line gutter) or flips to raw text, and expects their comments to follow
// the file across views. These are the affordances that make the review usable; this file guards them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    {
      path: "blank.ts",
      before: "const a = 1;\n\nconst b = 2;\n",
      after: "const a = 1;\n\nconst b = 3;\n",
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

test("macOS Electron review markup opts into integrated native window chrome", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  assert.equal(v.document.body.classList.contains("native-app"), process.platform === "darwin");
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

test("double-click selects a complete word in both file and diff views", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  const sourceCell = v.$('#source-body .source-row[data-line-index="0"] .source-code');
  sourceCell.getBoundingClientRect = () => ({ left: 0, right: 500, top: 0, bottom: 20, width: 500, height: 20 });
  const sourceX = 10 + 8 * 7; // `export const`: inside `const` after the cell's 10px padding
  sourceCell.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: sourceX }));
  sourceCell.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 2, clientX: sourceX }));
  sourceCell.dispatchEvent(new v.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX: sourceX }));
  assert.equal(v.window.getSelection().toString(), "const", "file view preserves native-style word selection");

  await v.openDiffFor("src/app.ts");
  const wrapper = v.$('#diff2html-container .d2h-file-wrapper:not(.df-inactive)');
  const diffCell = Array.from(wrapper.querySelectorAll('.d2h-file-side-diff:last-child .d2h-code-line-ctn'))
    .find((cell) => cell.textContent.includes('export const y = 3'));
  assert.ok(diffCell, "working-tree diff line is visible");
  diffCell.getBoundingClientRect = () => ({ left: 0, right: 500, top: 0, bottom: 20, width: 500, height: 20 });
  const diffX = 8 * 7;
  diffCell.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: diffX }));
  diffCell.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 2, clientX: diffX }));
  diffCell.dispatchEvent(new v.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX: diffX }));
  assert.equal(v.window.getSelection().toString(), "const", "diff view preserves native-style word selection");
  v.close();
});

test("file view folds imports by default and Cmd+. toggles the caret's brace block", async () => {
  const { html: foldHtml } = await makeReviewHtml([
    {
      path: "src/fold.ts",
      before: "import { one } from './one';\nimport { two } from './two';\n\nfunction outer() {\n  const value = 1;\n  if (value) {\n    return one + two;\n  }\n}\n",
      after: "import { one } from './one';\nimport { two } from './two';\n\nfunction outer() {\n  const value = 2;\n  if (value) {\n    return one + two;\n  }\n}\n",
    },
  ]);
  const v = await loadViewer(foldHtml);
  await v.openSourceFile("src/fold.ts");

  const importFold = v.$("#source-body .source-fold-row [data-source-fold]");
  assert.ok(importFold, "the import header starts collapsed");
  assert.equal(importFold.dataset.foldKind, "imports");
  assert.equal(v.$('#source-body .source-row[data-line-index="1"]'), null, "the second import row is hidden");

  v.click(importFold);
  assert.ok(v.$('#source-body .source-row[data-line-index="1"]'), "clicking the fold opens every import line");

  await v.clickSourceLine(3); // function outer() {
  v.key(".", { metaKey: true, code: "Period" });
  await v.settle(40);
  assert.ok(v.$('#source-body .source-row.source-block-folded[data-line-index="3"]'), "Cmd+. folds the current brace range");
  assert.equal(v.$('#source-body .source-row[data-line-index="4"]'), null, "the block body is omitted while folded");

  v.key(".", { metaKey: true, code: "Period" });
  await v.settle(40);
  assert.ok(v.$('#source-body .source-row[data-line-index="4"]'), "Cmd+. on the marker unfolds the block");
  v.close();
});

test("diff folds unchanged imports but leaves an import edit fully visible", async () => {
  const { html: unchangedImportHtml } = await makeReviewHtml([
    {
      path: "src/unchanged-import.ts",
      before: "import { one } from './one';\nimport { two } from './two';\n\nexport function total() {\n  return 1;\n}\n",
      after: "import { one } from './one';\nimport { two } from './two';\n\nexport function total() {\n  return 2;\n}\n",
    },
  ]);
  const folded = await loadViewer(unchangedImportHtml);
  await folded.openDiffFor("src/unchanged-import.ts");
  assert.equal(folded.$all(".mc-import-fold-row").length, 2, "both diff panes show one import fold marker");
  assert.ok(folded.$(".mc-import-fold-hidden"), "unchanged import rows after the marker are hidden");
  folded.click(folded.$(".mc-import-fold"));
  assert.equal(folded.$(".mc-import-fold-row"), null, "opening either marker expands imports in both panes");
  assert.equal(folded.$(".mc-import-fold-hidden"), null);
  folded.close();

  const { html: changedImportHtml } = await makeReviewHtml([
    {
      path: "src/changed-import.ts",
      before: "import { one } from './one';\nimport { two } from './two';\n\nexport const total = one + two;\n",
      after: "import { three } from './three';\nimport { two } from './two';\n\nexport const total = three + two;\n",
    },
  ]);
  const visible = await loadViewer(changedImportHtml);
  await visible.openDiffFor("src/changed-import.ts");
  assert.equal(visible.$(".mc-import-fold-row"), null, "a changed import keeps the dependency header open");
  assert.match(visible.$("#diff2html-container").textContent, /three/, "the changed import remains visible for review");
  visible.close();
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

test("source documents and merged prompts ship one audited Markdown renderer", () => {
  const js = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  assert.match(js, /markdown-it 14\.3\.0/, "the open-source parser is embedded in the viewer bundle");
  assert.match(js, /DOMPurify 3\.4\.12/, "the audited sanitizer is embedded beside the parser");
  assert.match(js, /function renderMarkdownHtml\(/, "read-only document surfaces share the common rendering entry point");
  assert.match(js, /kakapo-asset:\/\/app\/markdown-editor\.js/, "the inline memo editor is loaded only on demand");
  assert.doesNotMatch(js, /function renderInlineMd\(/, "the old regex-only Markdown renderer is gone");
});

test("markdown raw toggle switches to contiguous, every-line text", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("README.md");
  assert.equal(v.$("#render-toggle").dataset.keyhint, "⌥R", "the toolbar advertises the real shortcut");
  v.key("r", { altKey: true, code: "KeyR" });
  await v.settle();

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

  await v.clickRenderToggle();
  assert.equal(body.classList.contains("rendered-body"), true, "the toolbar button still toggles back to rendered mode");
  v.close();
});

test("line wrap is a checkbox-style Option+W toggle for raw file views", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  const toggle = v.$("#line-wrap-toggle");
  const body = v.$("#source-body");
  assert.ok(toggle && !toggle.classList.contains("hidden"), "raw code exposes the line-wrap checkbox");
  assert.equal(toggle.dataset.keyhint, "⌥W", "the checkbox advertises Option+W");
  assert.equal(toggle.getAttribute("role"), "checkbox");
  assert.equal(toggle.getAttribute("aria-checked"), "false");

  v.key("w", { altKey: true, code: "KeyW" });
  await v.settle();
  assert.ok(body.classList.contains("line-wrap"), "Option+W enables wrapping on the raw source body");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.ok(toggle.classList.contains("is-checked"), "the toolbar checkbox visibly reflects the state");

  await v.openSourceFile("README.md");
  assert.ok(body.classList.contains("rendered-body"), "Markdown still opens rendered");
  assert.equal(body.classList.contains("line-wrap"), false, "rendered documents do not inherit raw line wrapping");
  assert.ok(toggle.classList.contains("hidden"), "the raw-only option is hidden for a rendered document");

  await v.clickRenderToggle();
  assert.equal(body.classList.contains("rendered-body"), false);
  assert.ok(body.classList.contains("line-wrap"), "the persisted choice applies when Markdown switches to Raw");
  assert.equal(toggle.getAttribute("aria-checked"), "true");

  v.click(toggle);
  await v.settle();
  assert.equal(body.classList.contains("line-wrap"), false, "clicking the checkbox disables wrapping");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  v.close();
});

test("line wrap is available in side-by-side diff and shares the Option+W state", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");

  const toggle = v.$("#diff-line-wrap-toggle");
  const diff = v.$("#diff2html-container");
  assert.ok(toggle, "the diff toolbar exposes line wrapping without leaving review mode");
  assert.equal(toggle.dataset.keyhint, "⌥W");
  assert.equal(toggle.getAttribute("role"), "checkbox");
  assert.equal(toggle.getAttribute("aria-checked"), "false");

  v.key("w", { altKey: true, code: "KeyW" });
  await v.settle();
  assert.ok(diff.classList.contains("line-wrap"), "Option+W constrains the side-by-side diff to wrapped panes");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.ok(toggle.classList.contains("is-checked"));

  await v.openSourceFile("src/app.ts");
  assert.ok(v.$("#source-body").classList.contains("line-wrap"), "the same display preference follows into raw source");
  assert.equal(v.$("#line-wrap-toggle").getAttribute("aria-checked"), "true");

  await v.openDiffFor("src/app.ts");
  v.click(toggle);
  await v.settle();
  assert.equal(diff.classList.contains("line-wrap"), false, "the diff checkbox disables the shared mode");
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

test("source indexing is absent from the renderer (main-process analysis owns it)", async () => {
  const v = await loadViewer(html);
  assert.equal(v.$("#footer-progress"), null, "obsolete renderer index progress is not rendered");
  assert.equal(typeof v.window.symbolIndexWorker, "undefined", "no source-index worker is bundled in the UI");
  assert.equal(typeof v.window.setIndexProgress, "undefined", "renderer no longer owns index progress");
  v.close();
});

test("clean tree (no changes): opens the file view with the top-most README, not an empty diff", async () => {
  // before === after for every file ⇒ git diff is empty (nothing to review).
  const { html } = await makeReviewHtml([
    { path: "AAA/README.md", before: "# Nested\n", after: "# Nested\n" }, // sorts BEFORE the root README
    { path: "README.md", before: "# Root\n\nhello\n", after: "# Root\n\nhello\n" }, // the root README
  ]);
  const v = await loadViewer(html);
  assert.equal(v.visibleView(), "source", "file view is shown, not an empty diff pane");
  assert.equal(
    v.$("#source-viewer").dataset.openPath,
    "README.md",
    "the root README is opened, not the nested one that sorts first",
  );
  v.close();
});

test("markdown renders embedded HTML (GitHub-style), not escaped", async () => {
  const { html } = await makeReviewHtml([
    {
      path: "README.md",
      before: "# old\n",
      after: '<div align="center">\n<h1>Title</h1>\n<img src="https://example.com/b.png" alt="x">\n</div>\n\n## Section\n',
    },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("README.md");
  const body = v.$("#source-body");
  assert.ok(body.querySelector(".markdown-body h1"), "embedded <h1> is rendered, not escaped text");
  assert.ok(body.querySelector(".markdown-body img"), "embedded <img> is rendered");
  assert.ok(body.querySelector(".markdown-body h2"), "markdown (## Section) still renders alongside HTML");
  v.close();
});

test("markdown HTML is sanitized (scripts + event handlers stripped)", async () => {
  const { html } = await makeReviewHtml([
    {
      path: "README.md",
      before: "# old\n",
      after: '<div onclick="alert(1)">hi</div>\n<script>alert(2)</script>\n<img src="x" onerror="alert(3)">\n',
    },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("README.md");
  const body = v.$("#source-body");
  assert.equal(body.querySelector("script"), null, "<script> is removed");
  const div = body.querySelector(".markdown-body div");
  assert.equal(div && div.getAttribute("onclick"), null, "onclick is removed");
  const img = body.querySelector(".markdown-body img");
  assert.equal(img && img.getAttribute("onerror"), null, "onerror is removed");
  v.close();
});

test("F7 from the source view enters the diff (forward navigation works)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");

  v.key("F7"); // next change: from a changed file's source, land in its diff
  await v.settle(120);
  assert.equal(v.visibleView(), "diff", "F7 switched from the source view into the diff");
  v.close();
});

test("Shift+F7 is a distinct backward step, not a no-op that mirrors F7", async () => {
  // Regression: the source-view branch used to ignore shiftKey and always jump to the open file's own
  // hunk, so F7 and Shift+F7 behaved identically. Shift+F7 must fall through to prev-change navigation.
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  v.key("F7", { shiftKey: true });
  await v.settle(120);
  assert.equal(v.visibleView(), "diff", "Shift+F7 still navigates into the diff");
  v.close();
});

test("syntax highlighter tags function calls, PascalCase types, and decorators", async () => {
  const { html } = await makeReviewHtml([
    {
      path: "sample.py",
      before: "x = 1\n",
      after: "@cached\ndef run(self):\n    item: MyType = other\n",
    },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("sample.py");
  const body = v.$("#source-body");
  assert.ok(body.querySelector(".tok-decorator"), "@cached → decorator token");
  assert.ok(body.querySelector(".tok-function"), "run( → function-call token");
  assert.ok(body.querySelector(".tok-type"), "MyType → PascalCase type token");
  v.close();
});

test("header strip is free of meta clutter (no file/hunk counts, indexed ratio, or ISO timestamp)", async () => {
  // The reviewer found the file/hunk counts, the static "<embedded>/<total> indexed" ratio (which never
  // moves and reads as a frozen progress bar), and the raw generatedAt ISO string noisy and space-hungry.
  const v = await loadViewer(html);
  const strip = v.$(".review-status");
  assert.equal((strip?.textContent || "").trim(), "", "review-status carries no meta text");
  // Viewed is changed only from the selected Changes row; the toolbar stays free of duplicate state controls.
  assert.equal(v.$("#diff-viewed-toggle"), null, "the toolbar carries no Viewed pill");
  assert.equal(v.$("#footer-progress"), null, "renderer indexing progress is absent");
  v.close();
});

test("composing toggles body.mc-composing so the file caret is hidden while typing", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("c");
  assert.ok(
    v.window.document.body.classList.contains("mc-composing"),
    "opening the composer hides the file caret via body.mc-composing",
  );
  await v.writeAndSave("done");
  assert.equal(
    v.window.document.body.classList.contains("mc-composing"),
    false,
    "saving restores the file caret (mc-composing removed)",
  );
  v.close();
});

test("composer head labels the comment target with the canonical source reference", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); // line index 1 → display line 2
  await v.openComposer("c");
  const target = v.$(".mc-composer .mc-target");
  assert.ok(target, "composer head carries a target label");
  assert.equal(target.textContent, "@src/app.ts#L2", "shows the repository-relative path and line");
  v.close();
});

test("ArrowDown selects the comment box below the caret line (keyboard comment-box selection)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("c");
  await v.writeAndSave("pick me");
  // The saved comment box now sits right after line 0's source row.
  await v.clickSourceLine(0);
  v.key("ArrowDown");
  await v.settle(80);
  assert.ok(v.$(".mc-comment-row.mc-row-selected"), "ArrowDown selects the comment box");
  v.close();
});

test("leaving the composer unsaved (open another file) clears mc-composing — caret never stays hidden", async () => {
  // Regression: mc-composing was only removed on save/cancel, so leaving via any other path (open
  // another file, switch views) left it stuck and `body.mc-composing .code-cursor{display:none}` hid
  // every caret — making arrow navigation / comment-box selection look dead.
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("c");
  assert.ok(v.window.document.body.classList.contains("mc-composing"), "composing while open");
  await v.openSourceFile("README.md");
  assert.equal(
    v.window.document.body.classList.contains("mc-composing"),
    false,
    "mc-composing is cleared once the composer is no longer on screen",
  );
  v.close();
});

test("Cmd+0 focuses the Changes panel; arrow + Enter opens that file in the diff (delegated click)", async () => {
  // Regression: the Changes panel used per-element click listeners, which were lost when a watch tick
  // re-captured `links` — so Cmd+0 → arrow → Enter (row.click()) silently did nothing. The handler is
  // now delegated on #changes-panel (like #files-panel), so it survives re-capture.
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");
  v.key("0", { metaKey: true }); // Cmd+0 → focus the Changes panel
  await v.settle(80);
  v.key("ArrowDown");
  await v.settle(40);
  v.key("Enter"); // open the focused changed file
  await v.settle(120);
  assert.equal(v.visibleView(), "diff", "Enter on a Changes-panel row opens the diff view");
  v.close();
});

test("mouse file selection keeps the sidebar still and leaves keyboard focus on the clicked row", async () => {
  const v = await loadViewer(html);
  const filesTab = v.$('.tab[data-tab="files"]');
  v.click(filesTab);
  await v.settle(40);

  const file = v.$('.source-link[data-source-file="src/app.ts"]');
  let reveals = 0;
  file.scrollIntoView = () => { reveals += 1; };
  v.click(file);
  await v.settle(80);

  assert.equal(reveals, 0, "a clicked file never repositions its already-visible sidebar row");
  assert.equal(v.document.activeElement, file, "the clicked file owns real DOM focus");
  assert.ok(file.classList.contains("tree-focus"), "the clicked file owns the logical tree cursor");

  v.key("ArrowDown");
  await v.settle(40);
  assert.notEqual(v.$("#files-panel .tree-focus"), file, "arrow navigation continues from the clicked file");
  v.close();
});

test("mouse change selection focuses the clicked row without moving the sidebar", async () => {
  const v = await loadViewer(html);
  const change = v.$('.change-row[data-file="src/app.ts"]');
  const scroller = v.$('.sidebar-scroll');
  scroller.scrollTop = 137;
  v.click(change);
  await v.settle(80);

  assert.equal(scroller.scrollTop, 137, "opening the selected diff does not move the change list");
  assert.equal(v.document.activeElement, change, "the clicked change owns real DOM focus");
  assert.ok(change.classList.contains("tree-focus"), "the clicked change owns the logical tree cursor");
  v.close();
});

test("Cmd+0 focuses Changes from content, then toggles its sidebar without losing the diff", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  const button = v.$("#diff-sidebar-toggle");
  assert.ok(button, "the compact diff toolbar exposes a clickable sidebar control");

  v.key("0", { metaKey: true, code: "Digit0" });
  await v.settle(60);
  assert.equal(v.window.document.body.classList.contains("sidebar-collapsed"), false, "content focus does not collapse Changes");
  assert.ok(v.$(".change-row.tree-focus"), "Cmd+0 moves focus from the diff content to the Changes tree");
  assert.equal(v.visibleView(), "diff", "moving focus keeps the review surface in place");

  v.key("0", { metaKey: true, code: "Digit0" });
  await v.settle(60);
  assert.ok(v.window.document.body.classList.contains("sidebar-collapsed"), "a repeated press from the tree collapses it");
  assert.equal(button.getAttribute("aria-pressed"), "true", "the pressed state is accessible");
  assert.equal(v.$(".change-row.tree-focus"), null, "no hidden sidebar row keeps the logical cursor");
  assert.ok(v.$(".sidebar").hasAttribute("inert"), "the clipped sidebar leaves keyboard navigation during the close animation");
  assert.equal(v.$(".sidebar").getAttribute("aria-hidden"), "true", "the visually closing tree is hidden from accessibility navigation");
  assert.equal(v.visibleView(), "diff", "the review surface keeps its place");

  v.key("0", { metaKey: true, code: "Digit0" });
  await v.settle(60);
  assert.equal(v.window.document.body.classList.contains("sidebar-collapsed"), false, "the next press expands it");
  assert.ok(v.$(".change-row.tree-focus"), "expanding restores keyboard navigation to the changed file");
  assert.equal(v.$(".sidebar").hasAttribute("inert"), false, "the expanded sidebar is interactive again");

  button.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(20);
  assert.match(v.$("#mc-button-hint").textContent, /⌘0/, "hover names the shortcut");
  v.click(button);
  await v.settle(40);
  assert.ok(v.window.document.body.classList.contains("sidebar-collapsed"), "the icon performs the same action by mouse");
  v.close();
});

test("merged view: Opt+Enter on the active rendered comment offers review actions", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("removeme");
  v.key("?", { metaKey: true }); // Cmd+? → merged questions view
  await v.settle(80);
  const preview = v.$(".mc-merged-preview");
  assert.ok(preview, "one rendered merged document is present");
  assert.match(preview.textContent, /removeme/, "comment text is in the merged view");
  assert.ok(preview.querySelector(".mc-merged-comment-anchor.active"), "the first review stop is selected");
  preview.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(40);
  const dd = v.$("#mc-dropdown");
  assert.ok(dd, "custom dropdown appears on Opt+Enter");
  const items = [...dd.querySelectorAll(".mc-dropdown-item")];
  assert.equal(items.length, 2, "single caret offers navigate + remove");
  items.find((b) => /remove|지우기/i.test(b.textContent)).click();
  await v.settle(60);
  assert.equal(v.$(".mc-comment-row"), null, "comment box removed in sync (deleteComment → refreshComments)");
  v.close();
});

test("authoritative project refresh removes comments whose file was deleted", async () => {
  const v = await loadViewer(html);
  v.window.addComment("c", "src/app.ts", 1, "", "remove with file");
  v.window.addComment("c", "README.md", 1, "", "keep existing file");
  assert.equal(v.window.reviewComments.length, 2);

  v.window.installProjectIndex({
    sourceFilesMeta: [{ path: "README.md", name: "README.md", language: "markdown", content: "", size: 0, embedded: false, changed: false, changedLines: [], signature: "readme" }],
  });

  assert.equal(v.window.reviewComments.map((comment) => comment.path).join("|"), "README.md", "only the deleted file's comment is pruned");
  assert.equal(v.storedComments().map((comment) => comment.path).join("|"), "README.md", "the cleanup is persisted across app restarts");
  v.close();
});

test("desktop existence check removes deleted comments without pruning indexed-out config files", async () => {
  const v = await loadViewer(html, {
    existingPathsBridge: (paths) => Object.fromEntries(paths.map((path) => [path, path === ".claude/commands/kept.md"])),
  });
  v.window.addComment("c", "removed.md", 1, "", "remove missing file");
  v.window.addComment("c", ".claude/commands/kept.md", 1, "", "keep excluded but existing file");

  await v.openMergedView("c");
  await v.settle(40);

  assert.equal(v.window.reviewComments.map((comment) => comment.path).join("|"), ".claude/commands/kept.md", "main-process existence, not index membership, decides deletion");
  assert.match(v.$(".mc-merged-preview").textContent, /keep excluded but existing file/);
  assert.doesNotMatch(v.$(".mc-merged-preview").textContent, /remove missing file/);
  v.close();
});

test("merged view edits persist back to the code comment and navigation opens that exact location", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("original wording");
  await v.openMergedView("q");

  const preview = v.$(".mc-merged-preview");
  const heading = preview.querySelector(".mc-merged-comment-anchor");
  const body = heading.nextElementSibling;
  v.typeInto(body, "edited in the merged prompt");
  await v.settle(260);
  assert.equal(v.storedComments()[0].text, "edited in the merged prompt", "merged prose updates the persisted source comment");

  preview.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(30);
  const actions = [...v.$("#mc-dropdown").querySelectorAll(".mc-dropdown-item")];
  assert.equal(actions.length, 2, "Opt+Enter exposes exactly navigation and removal");
  const navigate = actions.find((item) => /location|위치로 이동/i.test(item.textContent));
  assert.ok(navigate, "the menu names location navigation explicitly");
  navigate.click();
  await v.settle(80);

  assert.equal(v.$("#mc-merged-panel"), null, "navigation closes the merged handoff");
  assert.equal(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex, "1", "the source caret lands on the comment line");
  assert.deepEqual(v.visibleCardTexts(), ["edited in the merged prompt"], "the code-location card shows the merged edit");
  v.close();
});

test("merged view: Opt+Arrow steps between rendered comment headings", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("q");
  await v.writeAndSave("first comment");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("second comment");
  v.key("?", { metaKey: true }); // Cmd+? → merged questions view
  await v.settle(80);
  const preview = v.$(".mc-merged-preview");
  const headers = [...preview.querySelectorAll(".mc-merged-comment-anchor")];
  assert.equal(headers.length, 2, "two rendered comment headings are review stops");
  assert.equal(headers[0].classList.contains("active"), true, "the first stop starts selected");
  const optArrow = (key) => preview.dispatchEvent(new v.window.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
  optArrow("ArrowDown");
  assert.equal(headers[1].classList.contains("active"), true, "Opt+Down selects the second rendered heading");
  optArrow("ArrowUp");
  assert.equal(headers[0].classList.contains("active"), true, "Opt+Up selects the first rendered heading");
  v.close();
});

test("merged view: Opt+Enter resolves the comment section at the actual editing caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("q");
  await v.writeAndSave("keep first");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("remove second");
  await v.openMergedView("q");
  const preview = v.$(".mc-merged-preview");
  const headings = [...preview.querySelectorAll(".mc-merged-comment-anchor")];
  const secondBody = headings[1].nextElementSibling;
  const range = v.document.createRange();
  range.selectNodeContents(secondBody);
  range.collapse(true);
  const selection = v.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // ProseMirror may consume the key before it bubbles out of the selected paragraph. The dock-level capture
  // listener must still open the action menu for the comment containing the real editing caret.
  secondBody.addEventListener("keydown", (event) => event.stopPropagation());
  secondBody.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(30);
  const remove = [...v.$("#mc-dropdown").querySelectorAll(".mc-dropdown-item")].find((item) => /remove|지우기/i.test(item.textContent));
  remove.click();
  await v.settle(40);
  assert.equal(v.window.reviewComments.filter((c) => c.kind === "q").map((c) => c.text).join("|"), "keep first", "the caret's second comment was removed, not the initially active first one");
  v.close();
});

test("comment tracking: follows a moved line; kept (never dropped) when the snapshot line vanishes", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\nexport const y = 2;\n", after: "export const x = 1;\nexport const y = 3;\n" },
  ]);
  const v = await loadViewer(html, { menuBridge: true });
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0); // caret on "export const x = 1;"
  await v.openComposer("q");
  await v.writeAndSave("track me");
  assert.equal(v.storedComments().length, 1, "comment saved");
  assert.equal(v.storedComments()[0].code, "export const x = 1;", "snapshot is the commented line");

  let seq = 0;
  const update = (path, content) => ({
    signature: "v" + ++seq,
    diffContainer: "", changesPanel: "", filesTree: "", reviewStatus: "",
    fileStates: [],
    sourceFilesMeta: [{ path, name: path.split("/").pop(), language: "typescript", content, size: content.length, embedded: true, changed: true, changedLines: [], signature: "sig" + seq }],
    httpEnvironments: {},
  });

  // (a) the file changed but the commented line just moved down two rows — the comment follows it
  await v.pushDiffUpdate(update("src/app.ts", "// added\n// lines\nexport const x = 1;\nexport const y = 3;\n"));
  assert.equal(v.storedComments().length, 1, "comment retained when its line is found");
  assert.equal(v.storedComments()[0].line, 3, "comment followed its snapshot line to row 3");
  assert.equal(v.$(".mc-toast"), null, "no toast while the comment is tracked");

  // (b) the commented line is gone from the new content — the comment is NOT dropped (user-authored comments
  // are never silently deleted); it stays at its last line with no toast. The × button removes a stale one.
  await v.pushDiffUpdate(update("src/app.ts", "export const z = 9;\nexport const w = 8;\n"));
  assert.equal(v.storedComments().length, 1, "comment kept even when its snapshot line vanished");
  assert.equal(v.$(".mc-toast"), null, "no toast — nothing was dropped");
  v.close();
});

test("after a commit removes the open diff file, a watch update lands on the new changes (not a blank pane)", async () => {
  // Regression: committing the file the diff was showing left `current` pointing at a vanished hunk index,
  // so the swapped-in diff rendered nothing and the breadcrumb kept the stale (committed-away) file.
  const first = await makeReviewHtml([
    { path: "gone.ts", before: "export const gone = 1;\n", after: "export const gone = 2;\n" },
  ]);
  const v = await loadViewer(first.html, { menuBridge: true });
  await v.openDiffFor("gone.ts");
  assert.equal(v.visibleView(), "diff", "starts in the diff view on gone.ts");
  assert.equal(v.activeDiffFile(), "gone.ts");

  // Simulate the watch tick after gone.ts is committed and two brand-new files now have changes.
  const second = await makeReviewHtml([
    { path: "fresh_a.ts", before: "export const a = 1;\n", after: "export const a = 9;\n" },
    { path: "fresh_b.ts", before: "export const b = 1;\n", after: "export const b = 9;\n" },
  ]);
  await v.pushDiffUpdate(second.build.update);

  const crumb = v.$("#diff-breadcrumb")?.textContent || "";
  assert.ok(!/gone\.ts/.test(crumb), "the committed-away file is gone from the breadcrumb");
  assert.ok(/fresh_a\.ts|fresh_b\.ts/.test(crumb), "breadcrumb re-anchored to a new changed file");
  const visible = v.$all(".d2h-file-wrapper").filter((w) => !w.classList.contains("df-inactive"));
  assert.ok(visible.length >= 1, "a new diff body is visible — the pane is not blank");
  v.close();
});

test("activity rail: icons navigate views, show shortcut tooltips, and reflect the active view", async () => {
  const v = await loadViewer(html, { menuBridge: true });
  const rail = v.$(".activity-rail");
  assert.ok(rail, "the activity rail is rendered");
  // Every navigable icon carries a shortcut in its hover tooltip (the IntelliJ-style nudge).
  const views = v.$all(".activity-rail .rail-btn[data-view]").map((b) => b.dataset.view);
  for (const view of ["changes", "files", "q", "c", "memo"]) {
    assert.ok(views.includes(view), `rail has a ${view} icon`);
  }
  assert.ok(
    v.$all(".activity-rail .rail-btn .rail-tip kbd").every((k) => k.textContent.trim().length > 0),
    "each rail tooltip names a shortcut",
  );
  assert.ok(v.$("#app-info-btn > svg"), "Settings uses the same SVG icon system as every other rail action");
  assert.equal(v.$("#app-info-btn .rail-gear"), null, "the optically smaller Unicode gear is gone");

  // Click navigates and the clicked icon becomes the active one.
  v.click(v.$('.activity-rail [data-view="changes"]'));
  await v.settle(60);
  assert.equal(v.visibleView(), "diff", "Changes icon shows the diff view");
  assert.ok(v.$('.activity-rail [data-view="changes"]').classList.contains("is-active"), "Changes icon is active");

  v.click(v.$('.activity-rail [data-view="files"]'));
  await v.settle(60);
  assert.equal(v.$("#files-panel").classList.contains("hidden"), false, "Files icon reveals the files panel");
  assert.ok(v.$('.activity-rail [data-view="files"]').classList.contains("is-active"), "Files icon is active");

  // Memo icon toggles the dock and lights/clears its own icon.
  v.click(v.$('.activity-rail [data-view="memo"]'));
  await v.settle(60);
  assert.ok(v.$("#mc-memo-panel"), "Memo icon opens the memo dock");
  assert.ok(v.$('.activity-rail [data-view="memo"]').classList.contains("is-active"), "Memo icon is active while open");
  v.click(v.$('.activity-rail [data-view="memo"]'));
  await v.settle(60);
  assert.equal(v.$("#mc-memo-panel"), null, "clicking Memo again closes the dock");
  assert.equal(v.$('.activity-rail [data-view="memo"]').classList.contains("is-active"), false, "Memo icon clears");
  v.close();
});

test("sidebar shows the current git branch", async () => {
  const v = await loadViewer(html);
  const chip = v.$(".brand-branch");
  assert.ok(chip && !chip.classList.contains("hidden"), "the branch chip is visible");
  assert.ok((v.$("#brand-branch-name")?.textContent || "").trim().length > 0, "it names a branch");
  assert.equal(v.$(".sidebar > .sidebar-brand")?.parentElement, v.$(".sidebar"), "project and branch live outside the scrolling tree");
  assert.equal(v.$(".sidebar-scroll .sidebar-brand"), null, "scrolling files cannot move the fixed project header");
  assert.equal(v.$(".brand-mark"), null, "the redundant KAKAPO label is omitted");
  v.close();
});

test("diff view: vertical wheel + PageUp/Down scroll the diff container", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  const c = v.$("#diff2html-container");
  assert.ok(c, "diff container present");
  // .d2h-file-side-diff is a horizontal scrollport that would swallow vertical wheel; the handler must
  // redirect vertical wheel to the container.
  c.scrollTop = 0;
  c.dispatchEvent(new v.window.WheelEvent("wheel", { deltaY: 180, deltaX: 0, bubbles: true, cancelable: true }));
  assert.equal(c.scrollTop, 180, "vertical wheel scrolls the diff container");
  // a wheel on the side-diff child bubbles up to the same container handler
  const side = v.$(".d2h-file-side-diff");
  if (side) {
    c.scrollTop = 0;
    side.dispatchEvent(new v.window.WheelEvent("wheel", { deltaY: 120, deltaX: 0, bubbles: true, cancelable: true }));
    assert.equal(c.scrollTop, 120, "wheel on the side-diff bubbles to the container");
  }
  // PageDown/PageUp (jsdom has no layout, so give the container a height to page by)
  Object.defineProperty(c, "clientHeight", { value: 400, configurable: true });
  c.scrollTop = 0;
  v.key("PageDown");
  const down = c.scrollTop;
  assert.ok(down > 0, "PageDown scrolls the diff down");
  v.key("PageUp");
  assert.ok(c.scrollTop < down, "PageUp scrolls the diff up");
  v.close();
});

test("Cmd+A in the diff/source view scopes the selection to that view, not the whole page", async () => {
  const v = await loadViewer(html);
  // Diff view: selection stays inside the diff container (not the sidebar).
  await v.openDiffFor("src/app.ts");
  v.key("a", { metaKey: true });
  let sel = v.window.getSelection();
  assert.ok(sel.rangeCount > 0, "a selection exists");
  let anc = sel.getRangeAt(0).commonAncestorContainer;
  anc = anc.nodeType === 1 ? anc : anc.parentElement;
  assert.ok(v.$("#diff2html-container").contains(anc), "diff Cmd+A stays within the diff container");
  assert.ok(!v.$(".sidebar").contains(anc), "the sidebar is not part of the selection");
  // Source view: selection stays inside the source body.
  await v.openSourceFile("src/app.ts");
  v.key("a", { metaKey: true });
  sel = v.window.getSelection();
  anc = sel.getRangeAt(0).commonAncestorContainer;
  anc = anc.nodeType === 1 ? anc : anc.parentElement;
  assert.ok(v.$("#source-body").contains(anc) || anc === v.$("#source-body"), "source Cmd+A stays within the source body");
  v.close();
});

test("a blank source line still shows the caret (regression: the empty cell skipped the caret span)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("blank.ts");
  // Place the caret on the blank line (index 1). reveal=false keeps it synchronous (no rAF for jsdom to miss).
  v.window.setSourceCursor("blank.ts", 1, 0, false, -1);
  const cl = v.$("#source-body .source-row.cursor-line");
  assert.ok(cl, "a row is the cursor line");
  assert.equal(cl.dataset.lineIndex, "1", "caret is on the blank line");
  assert.equal((cl.querySelector(".source-code").textContent || "").length, 0, "the cursor line is blank");
  assert.ok(cl.querySelector(".code-cursor"), "blank line still renders a caret span, not just the row background");
  v.close();
});

test("Cmd+1 from the diff opens the file you were viewing as source (not a stale source pane)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");
  v.key("1", { metaKey: true });
  assert.equal(v.visibleView(), "source", "Cmd+1 from the diff switches to the source view");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "and opens the diff's current file");
  v.close();
});

test("Cmd+1 focuses Files from content, then toggles its sidebar while preserving the source file", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");

  v.key("1", { metaKey: true, code: "Digit1" });
  await v.settle(60);
  assert.equal(v.window.document.body.classList.contains("sidebar-collapsed"), false, "content focus does not collapse Files");
  assert.ok(v.$(".source-link.tree-focus"), "Cmd+1 moves focus from the file content to the Files tree");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "the same source file stays open");

  v.key("1", { metaKey: true, code: "Digit1" });
  await v.settle(60);
  assert.ok(v.window.document.body.classList.contains("sidebar-collapsed"), "a repeated press from the tree collapses Files");
  assert.equal(v.$(".source-link.tree-focus"), null, "the hidden Files tree does not retain its cursor");

  v.key("1", { metaKey: true, code: "Digit1" });
  await v.settle(60);
  assert.equal(v.window.document.body.classList.contains("sidebar-collapsed"), false, "the next press expands Files");
  assert.ok(v.$(".source-link.tree-focus"), "expanding restores Files keyboard navigation");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "toggling never replaces the open file");

  v.click(v.$('.activity-rail [data-view="files"]'));
  await v.settle(60);
  assert.ok(v.window.document.body.classList.contains("sidebar-collapsed"), "Files icon uses the same collapse behavior");
  v.click(v.$('.activity-rail [data-view="files"]'));
  await v.settle(60);
  assert.equal(v.window.document.body.classList.contains("sidebar-collapsed"), false, "Files icon expands it again");
  v.close();
});

test("focus transitions flash only the destination panel and fade after about half a second", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  const source = v.$("#source-body");
  const sidebar = v.$(".sidebar");

  assert.equal(source.classList.contains("mc-panel-focus-flash"), false, "opening a file with the pointer does not flash the code panel");
  v.click(source.querySelector(".source-code")); // the pointer-selected tree now legitimately owns focus; return to content first

  v.key("1", { metaKey: true, code: "Digit1" });
  await v.settle(60);
  assert.ok(sidebar.classList.contains("mc-panel-focus-flash"), "moving the logical cursor identifies the file tree");
  assert.equal(source.classList.contains("mc-panel-focus-flash"), false, "the old panel is not left highlighted");
  await v.settle(620);
  assert.equal(sidebar.classList.contains("mc-panel-focus-flash"), false, "the tree effect also fades completely");

  v.key("Tab");
  v.key("ArrowDown");
  await v.settle(20);
  assert.ok(source.classList.contains("mc-panel-focus-flash"), "keyboard caret navigation identifies the code panel");
  await v.settle(620);
  assert.equal(source.classList.contains("mc-panel-focus-flash"), false, "the code-panel effect also fades completely");

  v.click(source.querySelector(".source-code"));
  await v.settle(20);
  assert.equal(source.classList.contains("mc-panel-focus-flash"), false, "a pointer click needs no redundant panel effect");
  assert.equal(source.getAttribute("data-mc-focus-panel"), "true", "the code scroller suppresses its persistent native focus outline");
  v.close();
});

test("Cmd+1 opens a changed tool-config file even when its directory is excluded from the project index", async () => {
  const { html: hiddenChangeHtml } = await makeReviewHtml([
    {
      path: ".claude/commands/review.md",
      before: "# Review\n\nOld guidance.\n",
      after: "# Review\n\nUpdated guidance.\n",
    },
  ]);
  const v = await loadViewer(hiddenChangeHtml);
  await v.openDiffFor(".claude/commands/review.md");
  v.key("1", { metaKey: true });
  await v.settle(40);

  assert.equal(v.visibleView(), "source", "the shortcut always leaves the diff for the file view");
  assert.equal(v.$("#source-viewer").dataset.openPath, ".claude/commands/review.md");
  assert.match(v.$("#source-body").textContent, /Updated guidance/, "changed hidden config stays reviewable as source");
  v.close();
});

test("global shortcuts require an exact modifier set (Cmd+Shift+1 must not act like Cmd+1)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");
  v.key("1", { metaKey: true, shiftKey: true }); // an extra Shift → not the Cmd+1 binding
  assert.equal(v.visibleView(), "diff", "Cmd+Shift+1 leaves the view untouched");
  v.key("1", { metaKey: true }); // exact combo still works
  assert.equal(v.visibleView(), "source", "Cmd+1 alone switches to the source view");
  v.close();
});

test("a selected comment box keeps the caret visible (어떤 경우에도 커서는 가려지면 안 됨)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  v.window.addComment("q", "src/app.ts", 1, "", "a question"); // comment on line 1 (row index 0)
  v.window.refreshComments();
  v.window.setSourceCursor("src/app.ts", 0, 0, false, -1); // caret on row index 0
  v.key("ArrowDown"); // steps onto the comment box on that line and selects it
  assert.ok(v.$("#source-body .mc-comment-row.mc-row-selected"), "the comment box is selected");
  assert.ok(v.$("#source-body .code-cursor"), "the caret is STILL visible (regression: selecting the box used to remove it)");
  v.close();
});

test("e on a selected comment box opens the composer prefilled and edits in place", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  v.window.addComment("q", "src/app.ts", 1, "", "original text");
  v.window.refreshComments();
  v.window.setSourceCursor("src/app.ts", 0, 0, false, -1);
  v.key("ArrowDown"); // select the box
  v.key("e"); // edit
  const ta = v.$("#source-body .mc-composer .mc-input");
  assert.ok(ta, "the composer opened");
  assert.equal(ta.value, "original text", "composer is prefilled with the existing comment text");
  ta.value = "edited text";
  v.window.saveComposer(ta);
  const comments = v.window.reviewComments.filter((c) => c.path === "src/app.ts");
  assert.equal(comments.length, 1, "still exactly one comment — edited in place, not duplicated");
  assert.equal(comments[0].text, "edited text", "the comment text was updated");
  v.close();
});

test("F7 across a file boundary sets the diff caret once (no first-line → change double jump)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  // src/app.ts has one change block, so the caret already sits at the file's last change. The FIRST F7 now
  // announces ("last change — press F7 again") instead of crossing, giving a beat to mark-viewed: the caret
  // must NOT move.
  let calls = 0;
  let orig = v.window.setDiffCursor;
  v.window.setDiffCursor = function () { calls += 1; return orig.apply(this, arguments); };
  v.key("F7");
  await new Promise((r) => setTimeout(r, 30));
  v.window.setDiffCursor = orig;
  assert.equal(calls, 0, "first F7 announces the last change; caret stays put");
  const hint = v.window.document.querySelector(".mc-caret-hint");
  assert.ok(hint && /F7/.test(hint.textContent), "first F7 shows the last-change announcement (inline caret hint)");

  // The SECOND consecutive F7 crosses to the next file, setting the caret exactly ONCE (focusDiffRow ->
  // the change). Before the skipCursor fix, showOnlyFile's ensureDiffCursor also fired, landing the caret
  // on the file's first code row first — a visible 146L→21L double jump.
  calls = 0;
  orig = v.window.setDiffCursor;
  v.window.setDiffCursor = function () { calls += 1; return orig.apply(this, arguments); };
  v.key("F7");
  await new Promise((r) => setTimeout(r, 30));
  v.window.setDiffCursor = orig;
  assert.equal(calls, 1, "caret set once via focusDiffRow; ensureDiffCursor skipped");
  assert.ok(hint && !hint.classList.contains("show"), "the last-change hint clears once the caret crosses to the next file (never covers it)");
  v.close();
});

test("viewed marks persist by path with the exact reviewed diff signature", async () => {
  const v = await loadViewer(html);
  v.window.setFileViewed("src/app.ts", true);
  assert.equal(v.window.isFileViewed("src/app.ts"), true, "mark reads back as viewed");
  // The per-file signature is stable across restarts and unrelated repository refreshes, while a new edit
  // to this path produces a new signature and correctly puts that patch back in the review queue.
  const state = v.window.loadViewedState();
  assert.equal(state["src/app.ts"], v.window.currentFileSignature("src/app.ts"), "stored against the current per-file diff");
  v.close();
});

test("applySetActive scrolls a file-crossing change inline, not via scheduleDiffScroll (146→21 stale-offset guard)", () => {
  // Timing/layout regression jsdom can't exercise (no real scrollTop), so guard the code SHAPE against the
  // built client. On an F7 file crossing, showOnlyFile display:none's the previous file but the scroll
  // container keeps its old (large) scrollTop. The change must be scrolled into view in THIS frame; routing
  // it through scheduleDiffScroll's extra rAF painted the previous file's scrollTop for one frame — the
  // 146→21 jump the user hit twice. Verified live in a real browser (Preview: first frame scrollTop 0 vs a
  // stale 1223); this stops the inline scroll from silently reverting to the deferred path.
  const js = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  const m = js.match(/function applySetActive\b[\s\S]*?(?=\nfunction showOnlyFile\b)/);
  assert.ok(m, "applySetActive body found");
  const body = m[0];
  assert.match(body, /\.scrollIntoView\(/, "applySetActive must scroll the change into view inline");
  // Match the CALL form `scheduleDiffScroll(` so this guard's own prose ("scheduleDiffScroll's extra rAF")
  // doesn't trip it — only an actual deferred-scroll call should fail the test.
  assert.doesNotMatch(body, /scheduleDiffScroll\(/, "applySetActive must NOT defer the crossing scroll via scheduleDiffScroll's rAF");
});

test("remapComments never drops a comment, even one anchored to a deleted/old-side line", async () => {
  const v = await loadViewer(html);
  // src/app.ts: `export const y = 2;` -> `export const y = 3;`. The old line text is GONE from the new
  // content, so a comment anchored to it (old-side, or a since-deleted line) can never match — remapComments
  // used to silently drop it, losing the user's comment even when they considered the file unchanged. It must
  // now survive (left at its line); only the × button deletes a comment.
  v.window.reviewComments.length = 0;
  v.window.addComment("c", "src/app.ts", 2, "export const y = 2;", "comment on the old/deleted line");
  v.window.addComment("q", "src/app.ts", 1, "export const x = 1;", "comment on an unchanged line");
  const before = v.window.reviewComments.length;
  assert.equal(before, 2, "two comments added");
  v.window.remapComments();
  assert.equal(v.window.reviewComments.length, 2, "remap dropped nothing");
  assert.ok(
    v.window.reviewComments.some((c) => c.code === "export const y = 2;"),
    "the old-side comment (its code absent from new content) is kept, not dropped"
  );
  v.close();
});

test("merged view copies grounded evidence and keeps only review actions in the comment menu", async () => {
  const v = await loadViewer(html);
  let copied = null;
  v.window.kakapoClipboard = { write: (text) => { copied = text; } };
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("shipit");
  v.key("?", { metaKey: true }); // Cmd+? → merged questions view
  await v.settle(80);
  const preview = v.$(".mc-merged-preview");
  assert.ok(preview, "merged view renders as one document");
  const copyAll = v.$(".mc-copy-all");
  assert.ok(copyAll, "the review handoff exposes a Copy all action");
  copyAll.click();
  await v.settle(20);
  assert.match(copied, /shipit/, "Copy all writes the complete grounded review text");
  assert.ok(v.$("#mc-merged-panel"), "copying keeps the evidence visible for inspection");

  // Opt+Enter stays review-only on the selected rendered comment stop.
  preview.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(40);
  const items = [...v.$("#mc-dropdown").querySelectorAll(".mc-dropdown-item")];
  assert.equal(items.length, 2, "the comment stop offers navigate + remove only");
  const remove = items.find((item) => /remove|지우기/i.test(item.textContent));
  assert.ok(remove, "one action removes the selected comment");

  remove.click();
  await v.settle(40);
  assert.equal(v.$("#mc-merged-panel"), null, "the empty merged view closes after removal");
  v.close();
});

test("a focused merged dock swallows global shortcuts (F7) until focus leaves it — one focus, one caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("q");
  await v.writeAndSave("note");
  v.key("?", { metaKey: true }); // Cmd+? opens the merged questions dock (rendered document takes focus)
  await v.settle(80);
  assert.ok(v.$("#mc-merged-panel"), "merged dock open");

  let navs = 0;
  const orig = v.window.setActive;
  v.window.setActive = function () { navs += 1; return orig.apply(this, arguments); };
  v.key("F7"); // a global nav shortcut, dispatched while the dock owns focus
  await v.settle(40);
  assert.equal(navs, 0, "F7 is swallowed while the dock owns focus (no navigating behind it)");
  assert.ok(v.$("#mc-merged-panel"), "dock stays open — only Esc/close dismisses it, not a nav key");

  v.$("#mc-merged-panel").remove(); // close the dock (focus returns to <body>)
  v.key("F7");
  await v.settle(40);
  v.window.setActive = orig;
  assert.ok(navs >= 1, "F7 navigates again once the dock no longer owns focus");
  v.close();
});

test("watch update doesn't re-render the open source view when that file didn't change", async () => {
  const { html, build } = await makeReviewHtml([
    { path: "a.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
    { path: "b.ts", before: "const b = 1;\n", after: "const b = 2;\n" },
  ]);
  const v = await loadViewer(html, { menuBridge: true });
  await v.openSourceFile("a.ts");
  assert.equal(v.visibleView(), "source");

  const aSig = build.update.fileStates.find((f) => f.path === "a.ts").signature; // current signature of the OPEN file
  let seq = 0;
  const mkUpdate = (aSignature, aContent) => ({
    signature: "build-" + ++seq,
    diffContainer: "", changesPanel: "", filesTree: "", reviewStatus: "",
    // a.ts keeps/loses its signature; b.ts always "changes" — but b.ts is NOT the open file.
    fileStates: [{ path: "a.ts", signature: aSignature }, { path: "b.ts", signature: "b" + seq }],
    sourceFilesMeta: [
      { path: "a.ts", name: "a.ts", language: "typescript", content: aContent, size: aContent.length, embedded: true, changed: aSignature !== aSig, changedLines: [], signature: aSignature },
      { path: "b.ts", name: "b.ts", language: "typescript", content: "const b = 3;\n", size: 12, embedded: true, changed: true, changedLines: [], signature: "bx" + seq },
    ],
    httpEnvironments: {},
  });

  // Spy source-view re-renders (openSourceFile is the only thing that repaints #source-body here).
  let opens = 0;
  const orig = v.window.openSourceFile;
  v.window.openSourceFile = function () { opens += 1; return orig.apply(this, arguments); };

  // (a) only b.ts changed → a.ts (open) signature unchanged → source view must NOT be re-rendered (no flicker)
  await v.pushDiffUpdate(mkUpdate(aSig, "const a = 2;\n"));
  assert.equal(opens, 0, "an unrelated file's edit does not re-render the open a.ts source view");
  assert.match(v.$("#source-body").textContent, /const a = 2/, "i18n refresh does not overwrite the live source body with its initial placeholder");

  // (b) a.ts itself changed → the source view IS re-rendered
  await v.pushDiffUpdate(mkUpdate("a-new-sig", "const a = 99;\n"));
  v.window.openSourceFile = orig;
  assert.ok(opens >= 1, "editing the open file does re-render its source view");
  v.close();
});

test("caret scroll-off keeps a full 15% viewport margin at both edges", async () => {
  const { html: oneFile } = await makeReviewHtml([
    { path: "scroll.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
  ]);
  const v = await loadViewer(oneFile);
  const scroller = v.document.createElement("div");
  const row = v.document.createElement("div");
  let rowTop = 190;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 1000 });
  Object.defineProperty(row, "offsetHeight", { configurable: true, value: 20 });
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 1100 });
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 20 });

  scroller.scrollTop = 500;
  v.window.scrolloffReveal(row, scroller, 0.15);
  assert.equal(scroller.scrollTop, 440, "top-edge caret is moved down to the 15% band");

  rowTop = 1030;
  scroller.scrollTop = 500;
  v.window.scrolloffReveal(row, scroller, 0.15);
  assert.equal(scroller.scrollTop, 600, "bottom-edge caret is moved up to the 15% band");
  v.close();
});

test("scrollbars become visible during scrolling and hide again after idle", async () => {
  const v = await loadViewer(html);
  const scroller = v.$("#source-body");
  scroller.dispatchEvent(new v.window.Event("scroll"));
  assert.ok(scroller.classList.contains("mc-scroll-active"), "scroll activity reveals the thumb immediately");
  await v.settle(1020);
  assert.equal(scroller.classList.contains("mc-scroll-active"), false, "the thumb fades after the idle timeout");
  v.close();
});
