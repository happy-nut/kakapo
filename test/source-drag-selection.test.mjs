// Dragging a selection past the end of a short file.
//
// The bug: the source view is a real <table>, and Chromium maps a point below a table to
// `(container, 0)` — the START of the scroll container. That position sorts before the drag's anchor, so
// the browser reversed its own selection and the highlight covered line 1 down to wherever the drag
// started, instead of running to the end of the file.
//
// jsdom has no layout and no native drag selection, so what it CAN hold still is the correction itself:
// given the parked focus Chromium produces and a pointer below the rows, does the page put the focus at
// the end of the last row. The rects are stubbed for that reason. That a real drag produces this focus in
// the first place is checked in a real browser — scripts/navigation-smoke.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/short.ts";
const SOURCE = Array.from({ length: 8 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "const line1 = 1;\n", after: SOURCE + "\n" }]));
});
after(cleanupFixtures);

/** The open source view, with the rows given a geometry: row i occupies y = 100 + 20i .. 120 + 20i. */
async function openFile(v) {
  v.window.openSourceFile(FILE);
  await v.settle(60);
  const rows = v.$all("#source-body .source-row");
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: 100 + index * 20, bottom: 120 + index * 20, left: 0, right: 500, width: 500, height: 20 });
  });
  return rows;
}

/** The selection Chromium leaves behind when the pointer goes below the table: focus parked on the body. */
function parkFocusOnBody(v, anchorRow) {
  const selection = v.window.getSelection();
  const anchor = anchorRow.querySelector(".source-code");
  const text = anchor.textContent ? firstTextNode(anchor) : anchor;
  const range = v.document.createRange();
  range.setStart(text, 2);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  selection.extend(v.$("#source-body"), 0);
  return selection;
}

function firstTextNode(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) return node;
    const inner = firstTextNode(node);
    if (inner) return inner;
  }
  return null;
}

const drag = (v, clientY) => {
  v.document.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientY }));
  v.document.dispatchEvent(new v.window.Event("selectionchange"));
};
const lineOf = (node) => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const row = el && el.closest ? el.closest(".source-row") : null;
  return row ? Number(row.dataset.lineIndex) + 1 : null;
};

test("a pointer below the last row puts the focus at the end of the file, not the start of it", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  const selection = parkFocusOnBody(v, rows[1]);
  assert.equal(lineOf(selection.focusNode), null, "this is the focus Chromium parks on the container");

  drag(v, 400); // well below row 8, which ends at y=260
  assert.equal(lineOf(selection.focusNode), rows.length, "the focus is on the last row now");
  assert.equal(lineOf(selection.anchorNode), 2, "and the anchor has not moved");
  v.close();
});

test("the corrected selection actually has text in it — which is what ⌘C copies", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  // The worst version of the bug, and the one that reads as "copying is broken" rather than as "the
  // selection is wrong": drag from the very start of line 1 and Chromium parks the focus at the start of
  // the container, which is the SAME position. The selection is not collapsed and its text is "".
  const selection = v.window.getSelection();
  const range = v.document.createRange();
  range.setStart(firstTextNode(rows[0].querySelector(".source-code")), 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  selection.extend(v.$("#source-body"), 0);
  // In Chromium that selection's text is "" — not collapsed, and nothing to copy, which is why this read
  // as "⌘C is broken" rather than as "the selection is wrong". jsdom serializes a range across table rows
  // differently (it does not honour `user-select: none`, so it even picks up the gutter), so the premise
  // is only measurable in a real browser; what is held here is the outcome.
  drag(v, 400);
  assert.equal(lineOf(selection.focusNode), rows.length);
  assert.ok(selection.toString().includes("line8"), "the whole file is in the selection now");
  assert.ok(selection.toString().length > 50, selection.toString().slice(0, 40));
  v.close();
});

test("a pointer above the first row puts it at the start, which is the same bug the other way up", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  const selection = parkFocusOnBody(v, rows[5]);

  drag(v, 10); // above row 1, which starts at y=100
  assert.equal(lineOf(selection.focusNode), 1);
  assert.equal(selection.focusOffset, 0, "at the very start of it");
  v.close();
});

test("a drag that is behaving is left alone", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  const selection = v.window.getSelection();
  const range = v.document.createRange();
  range.setStart(firstTextNode(rows[1].querySelector(".source-code")), 2);
  range.setEnd(firstTextNode(rows[4].querySelector(".source-code")), 3);
  selection.removeAllRanges();
  selection.addRange(range);

  // The pointer is below the rows, but the focus is on one of them: the browser is coping, and a
  // correction here would drag the selection to the end of the file under the reader's hand.
  drag(v, 400);
  assert.equal(lineOf(selection.focusNode), 5);
  assert.equal(selection.focusOffset, 3);
  v.close();
});

test("with no button held there is no drag to correct", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  const selection = parkFocusOnBody(v, rows[1]);
  // A plain move over the page, and then a selection change from somewhere else entirely.
  v.document.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, buttons: 0, clientY: 400 }));
  v.document.dispatchEvent(new v.window.Event("selectionchange"));
  assert.equal(lineOf(selection.focusNode), null, "the focus is where it was");
  v.close();
});

test("the correction ends with the mouse button", async () => {
  const v = await loadViewer(html);
  const rows = await openFile(v);
  const selection = parkFocusOnBody(v, rows[1]);
  v.document.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientY: 400 }));
  v.document.dispatchEvent(new v.window.MouseEvent("mouseup", { bubbles: true }));
  v.document.dispatchEvent(new v.window.Event("selectionchange"));
  assert.equal(lineOf(selection.focusNode), null,
    "a selectionchange after the drag is over is somebody else's — ⌘A, a find, a click");
  v.close();
});
