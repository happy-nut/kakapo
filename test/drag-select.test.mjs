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

function selectInside(v, cell) {
  const walker = v.document.createTreeWalker(cell, 4);
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

test("a selection can be dragged out of the diff, as it can out of the source view", async () => {
  const v = await loadViewer(html);
  try {
    const started = {};
    for (const id of ["diff2html-container", "source-body"]) {
      const host = v.window.document.getElementById(id);
      assert.ok(host, `${id} is on the page`);
      const target = host.querySelector(".d2h-code-line-ctn, .source-code") || host;
      // jsdom has no DragEvent constructor, and none is needed: the listener under test only ever calls
      // preventDefault, so what reaches it is a cancelable event of the right type.
      const Ctor = v.window.DragEvent || v.window.Event;
      const event = new Ctor("dragstart", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      started[id] = !event.defaultPrevented;
    }
    assert.equal(started["diff2html-container"], true, "the diff lets a drag start");
    assert.equal(started["source-body"], true, "and so does the source view — they agree now");
  } finally {
    v.close();
  }
});

test("the diff still refuses to be typed into, pasted into or dropped onto", async () => {
  const v = await loadViewer(html);
  try {
    const host = v.window.document.getElementById("diff2html-container");
    const target = host.querySelector(".d2h-code-line-ctn") || host;
    for (const type of ["beforeinput", "paste", "drop"]) {
      const event = new v.window.Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, `${type} is still refused`);
    }
  } finally {
    v.close();
  }
});
