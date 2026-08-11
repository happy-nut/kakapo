// CORE USER FLOW: reaching and acting on review-comment boxes with the keyboard.
//
// A comment attached to a line is a selectable "stop" the caret lands on while arrowing through a file.
// Once a box is selected it can be deleted (Backspace), edited (e), or stepped off (arrow / Escape). This
// must behave identically in the diff view and the source view. Guards the regression where the diff view's
// caret handler had NO comment-box logic at all, so every diff comment — whether made by dragging a range
// or by a single-line caret — was unreachable by keyboard (and therefore un-editable via `e`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures, renderLazyBodies } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILES = [
  {
    path: "src/app.ts",
    before: "export function run() {\n  return 42;\n}\n",
    after: "export function run() {\n  const n = 43;\n  return n;\n}\n",
  },
];

let html, lazy;
before(async () => {
  html = (await makeReviewHtml(FILES)).html;
  const r = await makeReviewHtml(FILES, { lazyLoad: true });
  lazy = { html: r.html, bodies: await renderLazyBodies(r.build), sourceData: r.build.lazySourceData };
});
after(cleanupFixtures);

async function diffCommentOnFirstLine(v, text) {
  await v.openDiffFor("src/app.ts");
  await v.clickFirstDiffLine();
  await v.openComposer("q");
  await v.writeAndSave(text);
}

// ---------- diff view ----------
test("diff: ArrowDown lands on the comment box attached to the caret line", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  assert.deepEqual(v.visibleCardTexts(), ["q1"]);
  v.key("ArrowDown");
  await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected by ArrowDown");
  v.close();
});

test("diff: ArrowUp from the line below the comment re-selects the box", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20); // onto the box
  v.key("ArrowDown"); await v.settle(20); // step off, caret on the next code line
  assert.equal(v.selectedCommentBox(), null, "stepped off the box");
  v.key("ArrowUp"); await v.settle(20); // back up onto the box from below
  assert.ok(v.selectedCommentBox(), "box re-selected from below with ArrowUp");
  v.close();
});

test("diff: stepping off the box re-shows the caret and deselects", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "deselected after stepping off");
  assert.ok(v.diffCaretRow(), "caret is visible again on a code line");
  v.close();
});

test("diff: Escape deselects the box without deleting the comment", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("Escape"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "deselected by Escape");
  assert.equal(v.storedComments().length, 1, "comment is still there");
  v.close();
});

test("diff: Backspace deletes the selected comment", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "delete me");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("Backspace"); await v.settle(20);
  assert.equal(v.storedComments().length, 0, "Backspace deleted the selected comment");
  assert.equal(v.selectedCommentBox(), null, "selection cleared after delete");
  v.close();
});

test("diff: e opens the editor prefilled with the existing comment text", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "edit me");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("e"); await v.settle(40);
  const input = v.visibleComposerInput();
  assert.ok(input, "editor composer reopened");
  assert.equal(input.value, "edit me", "editor prefilled with existing text");
  v.close();
});

test("diff: ArrowDown on a line with NO comment just moves the caret (no false selection)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  await v.clickFirstDiffLine();
  const before = v.diffCaretLine();
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "no comment here -> nothing selected");
  assert.notEqual(v.diffCaretLine(), before, "caret advanced to the next line");
  v.close();
});

test("diff (lazy-LOAD): single-line comment is selectable and editable", async () => {
  const v = await loadViewer(lazy.html, { lazySourceData: lazy.sourceData, getDiffBody: (i) => lazy.bodies[i] || "" });
  await v.openDiffFor("src/app.ts");
  await v.settle(120);
  await v.clickFirstDiffLine();
  await v.openComposer("q");
  await v.writeAndSave("lazy edit");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected in lazy-LOAD mode (serve/Electron)");
  v.key("e"); await v.settle(40);
  assert.equal(v.visibleComposerInput().value, "lazy edit", "editor prefilled in lazy-LOAD mode");
  v.close();
});

// ---------- source view (must behave identically) ----------
test("source: ArrowDown selects the comment box (parity with diff)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("src q");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected in source view");
  v.close();
});

test("source: e opens the editor prefilled (parity with diff)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("src edit");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("e"); await v.settle(40);
  assert.equal(v.visibleComposerInput().value, "src edit", "editor prefilled in source view");
  v.close();
});

// F8 / Shift+F8 step between review comments the way F7 steps between changes — changes on one key, comments
// on the next one over. Cmd+F7 does the same and stays for muscle memory.
test("F8 and Shift+F8 walk the comments, mirroring F7 for changes", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("first comment");
  await v.settle(60);
  await v.clickSourceLine(2);
  await v.openComposer("q");
  await v.writeAndSave("second comment");
  await v.settle(60);
  assert.equal(v.storedComments().length, 2, "two comments to walk between");

  const cursorLine = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1);
  const [a, b] = v.storedComments().map((c) => c.line - 1).sort((x, y) => x - y);

  v.key("F8");
  await v.settle(80);
  const first = cursorLine();
  assert.ok(first === a || first === b, `F8 landed on a commented line (got ${first})`);

  v.key("F8");
  await v.settle(80);
  assert.notEqual(cursorLine(), first, "a second F8 steps to the other comment");

  v.key("F8", { shiftKey: true });
  await v.settle(80);
  assert.equal(cursorLine(), first, "Shift+F8 steps back");
  v.close();
});

// The diff shows one file at a time, everything else display:none. Stepping to a comment in ANOTHER file
// placed the caret inside that hidden wrapper: the chrome updated — the base-version label named the target —
// while the reader kept looking at the previous file and nothing appeared to happen.
test("F8 to a comment in another file switches the diff to that file", async () => {
  const { html: twoFiles } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]);
  const v = await loadViewer(twoFiles);
  const shownFile = () => {
    const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
    return wrapper ? (wrapper.querySelector(".d2h-file-name")?.textContent || "").trim() : null;
  };
  // clickFirstDiffLine() always takes the first wrapper in the DOM; this comment has to land in the file the
  // jump comes FROM being a different one, so click inside the file that is actually on screen.
  await v.openDiffFor("src/b.ts");
  assert.equal(shownFile(), "src/b.ts");
  const shown = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const numbered = Array.from(shown.querySelectorAll(".d2h-file-side-diff")).pop()
    .querySelectorAll(".d2h-code-side-linenumber");
  const cell = Array.from(numbered).find((n) => (n.textContent || "").trim() !== "").closest("tr");
  v.click(cell.querySelector(".d2h-code-line, .d2h-code-side-line"));
  await v.settle(30);
  await v.openComposer("q");
  await v.writeAndSave("why b?");
  await v.settle(60);
  assert.equal(v.storedComments()[0]?.path, "src/b.ts", "the comment is in the file we will jump back to");

  await v.openDiffFor("src/a.ts");
  await v.settle(60);
  assert.equal(shownFile(), "src/a.ts", "another file is what's on screen before the jump");

  v.key("F8");
  await v.settle(120);
  assert.equal(shownFile(), "src/b.ts", "F8 reveals the commented file, not just its name in the chrome");
  v.close();
});

// An agent's explanation and a reviewer's question are the same thing to someone walking a file: a note on
// a line. They used to be two keys — F8 for comments, a second one for notes — so F8 silently skipped every
// explanation the agent had left. One list now, sorted together, a note ahead of a comment on a line they
// share (the order the thread itself renders them in), and one key that walks all of it.
test("the comment navigation list contains both kinds", () => {
  const comments = readFileSync(new URL("../src/viewer/07-comments.js", import.meta.url), "utf8");
  assert.match(comments, /function sortedNavThread\(\)[\s\S]{0,400}sortedAnnotations\(\)/,
    "notes are merged into the navigation list");
  assert.match(comments, /function gotoComment[\s\S]{0,500}target\.seq != null/,
    "a comment navigates by seq, a note by its line");
});

// F8 stepped to the first note and then stopped dead. commentNavOrder ranks only files the DIFF contains —
// fine while every comment was anchored to a change, but an agent's codebase map anchors notes in files that
// are not part of the diff at all. Those all collapsed to rank Infinity, the current file came back unranked,
// and stepAnchor answered every press with list[0]. Every anchor needs a place in the order.
test("stepping keeps working through notes in files the diff does not contain", () => {
  const comments = readFileSync(new URL("../src/viewer/07-comments.js", import.meta.url), "utf8");
  assert.match(comments, /function navOrderFor\(list\)/, "the order is built from the list, not only from the diff");
  assert.match(comments, /extra\.sort\(\)\.forEach\(function \(path\) \{ order\[path\] = next\+\+; \}\)/,
    "files outside the diff get ranks of their own, in a stable order");
  assert.match(comments, /function stepAnchor\(delta, list\) \{\s*\n\s*var order = navOrderFor\(list\);/,
    "and stepping uses it, so the current file is rankable too");
});
