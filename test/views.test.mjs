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
  assert.ok(body.querySelector(".md-html h1"), "embedded <h1> is rendered, not escaped text");
  assert.ok(body.querySelector(".md-html img"), "embedded <img> is rendered");
  assert.ok(body.querySelector(".md-h"), "markdown (## Section) still renders alongside HTML");
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
  const div = body.querySelector(".md-html div");
  assert.equal(div && div.getAttribute("onclick"), null, "onclick is removed");
  const img = body.querySelector(".md-html img");
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
  // The two things that must survive: the viewed toggle (a separate button) and the footer progress bar
  // (the single, intended home for background-indexing progress).
  assert.ok(v.$("#diff-viewed-toggle"), "viewed toggle button is still present");
  assert.ok(v.$("#footer-progress"), "footer progress bar remains for indexing progress");
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

test("composer head labels the comment target as file:line", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); // line index 1 → display line 2
  await v.openComposer("c");
  const target = v.$(".mc-composer .mc-target");
  assert.ok(target, "composer head carries a target label");
  assert.match(target.textContent, /^app\.ts:\d+$/, "shows basename:line (e.g. app.ts:2)");
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

test("merged view: Opt+Enter opens a custom dropdown; Remove deletes the comment and syncs the box", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("removeme");
  v.key("?", { metaKey: true }); // Cmd+? → merged questions view
  await v.settle(80);
  const area = v.$(".mc-modal-text");
  assert.ok(area, "merged view textarea present");
  assert.match(area.value, /removeme/, "comment text is in the merged view");
  const pos = area.value.indexOf("removeme");
  area.selectionStart = area.selectionEnd = pos; // caret inside the comment block
  area.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
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

test("merged view: caret is interactive (not readOnly) and Opt+Arrow steps between comment headers", async () => {
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
  const area = v.$(".mc-modal-text");
  assert.ok(area, "merged view textarea present");
  // readOnly hides the caret in Chromium — the merged view must NOT be readOnly so the caret is visible
  assert.equal(area.readOnly, false, "merged textarea is interactive (caret visible), edits blocked via beforeinput");
  const headers = [];
  let idx = area.value.indexOf("### ");
  while (idx !== -1) { headers.push(idx); idx = area.value.indexOf("### ", idx + 1); }
  assert.equal(headers.length, 2, "two comment headers present");
  const optArrow = (key) => area.dispatchEvent(new v.window.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
  area.selectionStart = area.selectionEnd = 0;
  optArrow("ArrowDown");
  assert.equal(area.selectionStart, headers[0], "Opt+Down jumps the caret to the first comment header");
  optArrow("ArrowDown");
  assert.equal(area.selectionStart, headers[1], "Opt+Down again jumps to the second comment header");
  optArrow("ArrowUp");
  assert.equal(area.selectionStart, headers[0], "Opt+Up jumps back to the first comment header");
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
  const toast = v.window.document.querySelector("#mc-toasts .mc-toast");
  assert.ok(toast && /F7/.test(toast.textContent), "first F7 shows the last-change announcement");

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
  v.close();
});

test("viewed marks persist by path as a plain boolean (survive restart like comments)", async () => {
  const v = await loadViewer(html);
  v.window.setFileViewed("src/app.ts", true);
  assert.equal(v.window.isFileViewed("src/app.ts"), true, "mark reads back as viewed");
  // Stored as boolean true keyed by path — NOT the file signature. Signature-keyed storage silently cleared
  // every viewed mark on any re-generation that changed the hash; a boolean survives restarts like comments.
  const state = v.window.loadViewedState();
  assert.equal(state["src/app.ts"], true, "stored as boolean true, not a signature string");
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

test("merged view: select-all Opt+Enter lists send-to-terminal first then remove, and there's no header send button", async () => {
  const v = await loadViewer(html);
  // Mock an open terminal so the send-to-terminal dropdown item is offered.
  let sent = null;
  v.window.__monacoriTerminal = { isOpen: () => true, enterSendMode: (text) => { sent = text; } };
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("shipit");
  v.key("?", { metaKey: true }); // Cmd+? → merged questions view
  await v.settle(80);
  const area = v.$(".mc-modal-text");
  assert.ok(area, "merged view textarea present");
  // Send-to-terminal is no longer a header button — it moved into the Opt+Enter dropdown.
  assert.equal(v.$(".mc-send-term"), null, "no send-to-terminal header button in the merged view");

  // Select-all + Opt+Enter offers send-to-terminal (whole text) FIRST, then remove-all.
  area.selectionStart = 0;
  area.selectionEnd = area.value.length;
  area.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(40);
  const items = [...v.$("#mc-dropdown").querySelectorAll(".mc-dropdown-item")];
  assert.equal(items.length, 2, "select-all offers send-to-terminal + remove-all");
  assert.match(items[0].textContent, /terminal|터미널/i, "send-to-terminal is the FIRST item (before remove-all)");
  assert.match(items[1].textContent, /remove|지우기/i, "remove-all is second");

  // Choosing send hands the whole merged text to the terminal and closes the modal.
  items[0].click();
  await v.settle(40);
  assert.ok(sent && /shipit/.test(sent), "send-to-terminal received the merged text");
  assert.equal(v.$("#mc-modal"), null, "modal closed after send");
  v.close();
});

test("floating overlay swallows global shortcuts (F7) until it closes — one focus, one caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  await v.openComposer("q");
  await v.writeAndSave("note");
  v.key("?", { metaKey: true }); // Cmd+? opens the merged questions overlay
  await v.settle(80);
  assert.ok(v.$("#mc-modal"), "merged overlay open");

  let navs = 0;
  const orig = v.window.setActive;
  v.window.setActive = function () { navs += 1; return orig.apply(this, arguments); };
  v.key("F7"); // a global nav shortcut, dispatched underneath the overlay
  await v.settle(40);
  assert.equal(navs, 0, "F7 is swallowed while the overlay owns focus (no navigating a hidden panel)");
  assert.ok(v.$("#mc-modal"), "overlay stays open — only Esc/close dismisses it, not a nav key");

  v.$("#mc-modal").remove(); // close the overlay
  v.key("F7");
  await v.settle(40);
  v.window.setActive = orig;
  assert.ok(navs >= 1, "F7 navigates again once the overlay is closed");
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

  // (b) a.ts itself changed → the source view IS re-rendered
  await v.pushDiffUpdate(mkUpdate("a-new-sig", "const a = 99;\n"));
  v.window.openSourceFile = orig;
  assert.ok(opens >= 1, "editing the open file does re-render its source view");
  v.close();
});
