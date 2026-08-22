// CORE USER FLOW: selecting code with the mouse.
//
// Both code views paint a FAKE caret — a span spliced into the line's text nodes — and a click places it.
// A drag ENDS with a click, so the click handler was repainting the caret on top of the selection the drag
// had just made, re-splitting the very text nodes that selection was anchored in: dragging across code in
// the diff or in a source file left nothing selected. A click that arrives while a range is selected is the
// tail of a drag, not a request to move the caret.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILES = [
  {
    path: "src/app.ts",
    before: "export function run() {\n  return 42;\n}\n",
    after: "export function run(times) {\n  const total = times * 43;\n  return total;\n}\n",
  },
];

let html;
before(async () => { html = (await makeReviewHtml(FILES)).html; });
after(cleanupFixtures);

/** Select some text inside `cell`, the way a drag across it would. */
function selectInside(v, cell) {
  const walker = v.document.createTreeWalker(cell, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node && (node.nodeValue || "").trim().length < 2) node = walker.nextNode();
  if (!node) throw new Error("no text to select");
  const range = v.document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(3, node.nodeValue.length));
  const selection = v.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return String(selection);
}

test("diff: the click that ends a drag leaves the caret (and so the selection) alone", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  await v.clickFirstDiffLine();
  const cursorRow = () => v.document.querySelector("#diff2html-container .mc-diff-cursor-row");
  const placed = cursorRow();
  assert.ok(placed, "a click places the diff caret");

  const cell = Array.from(v.document.querySelectorAll("#diff2html-container .d2h-code-line-ctn"))
    .filter((ctn) => ctn.closest("tr") !== placed && (ctn.textContent || "").trim().length > 6)
    .pop();
  assert.ok(cell, "another code line to drag across");
  assert.ok(selectInside(v, cell).length > 0, "text is selected");

  v.click(cell);
  await v.settle(20);
  assert.equal(cursorRow(), placed, "a click carrying a selection does not move the caret");

  // Without a selection the same click still places the caret — the guard is about drags, not about clicks.
  v.window.getSelection().removeAllRanges();
  v.click(cell);
  await v.settle(20);
  assert.notEqual(cursorRow(), placed, "an ordinary click still moves the caret");
  v.close();
});

test("source: the click that ends a drag leaves the caret (and so the selection) alone", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(0);
  const cursorLine = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1);
  assert.equal(cursorLine(), 0, "a click places the source caret");

  const cell = v.document.querySelector('.source-row[data-line-index="1"] .source-code');
  assert.ok(selectInside(v, cell).length > 0, "text is selected");

  v.click(cell);
  await v.settle(20);
  assert.equal(cursorLine(), 0, "a click carrying a selection does not move the caret");

  v.window.getSelection().removeAllRanges();
  v.click(cell);
  await v.settle(20);
  assert.equal(cursorLine(), 1, "an ordinary click still moves the caret");
  v.close();
});

// A double click that turned into a drag: Chromium has already extended the selection word by word, and
// replacing that with the single word under the pointer threw the whole gesture away.
test("selectCodeWord keeps a selection wider than the word it would select", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  const cell = v.document.querySelector('.source-row[data-line-index="0"] .source-code');
  const text = cell.textContent || "";

  v.window.getSelection().removeAllRanges();
  assert.equal(v.window.selectCodeWord(cell, text, 2), true, "a plain double click selects the word");

  const range = v.document.createRange();
  range.selectNodeContents(cell);
  const selection = v.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const dragged = String(selection);
  assert.equal(v.window.selectCodeWord(cell, text, 2), false, "a wider selection is left as the user dragged it");
  assert.equal(String(v.window.getSelection()), dragged, "and it is exactly the range the drag made");
  v.close();
});
