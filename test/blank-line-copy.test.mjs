import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/spaced.ts";
const LINES = ["const a = 1;", "", "const b = 2;", "", "", "const c = 3;", ""];
const SOURCE = LINES.join("\n") + "\n";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "const a = 0;\n", after: SOURCE }]));
});
after(cleanupFixtures);

async function open() {
  const v = await loadViewer(html);
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return v;
}

const cellAt = (v, line) => v.$(`.source-row[data-line-index="${line}"] .source-code`);

test("a blank line's cell is not empty, so its row survives being serialized", async () => {
  const v = await open();
  try {
    assert.equal(v.$all("#source-body .source-row").length, LINES.length + 1, "every line has a row");

    for (const line of [1, 3, 4]) {
      const cell = cellAt(v, line);
      assert.equal(cell.innerHTML, "<br>", `line ${line + 1} is blank and its cell holds a break`);
    }
    for (const line of [0, 2, 5]) {
      assert.equal(cellAt(v, line).querySelector("br"), null,
        `line ${line + 1} has code, so nothing is padded into it`);
    }
    assert.equal(cellAt(v, LINES.length).innerHTML, "",
      "the final row is left bare — its break would have no row to separate from");
  } finally {
    v.close();
  }
});

test("the break is invisible to everything that reads the line's text", async () => {
  const v = await open();
  try {
    const cell = cellAt(v, 1);
    assert.ok(cell.querySelector("br"), "precondition: the blank line is padded");
    assert.equal(v.window.sourceCellText(cell), "", "the line's own text is still empty");
    assert.equal(cell.textContent, "", "and so is textContent, which captureSourceRefreshCursor reads");
    assert.equal(v.window.sourceTextLengthBefore(cell, cell, cell.childNodes.length), 0,
      "a point past the break is still column 0");
    assert.equal((cell.textContent || "").length, 0, "the blank-line caret's own test still sees a blank line");
  } finally {
    v.close();
  }
});

test("⌘C with a caret and no selection copies the caret's line, the way IntelliJ does", async () => {
  const v = await open();
  try {
    v.window.setSourceCursor(FILE, 2, 0, false);
    await v.settle(20);
    const copied = [];
    const event = new v.window.Event("copy", { bubbles: true, cancelable: true });
    event.clipboardData = { setData: (type, value) => copied.push([type, value]) };
    v.window.document.dispatchEvent(event);
    assert.deepEqual(copied, [["text/plain", "const b = 2;\n"]],
      "the caret's line is put on the clipboard with its newline");
    assert.equal(event.defaultPrevented, true, "and the empty native copy is stopped");
  } finally {
    v.close();
  }
});

test("a real selection is left to the browser, which already copies it", async () => {
  const v = await open();
  try {
    v.window.setSourceCursor(FILE, 2, 0, false);
    await v.settle(20);
    const range = v.window.document.createRange();
    range.selectNodeContents(cellAt(v, 2));
    const selection = v.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const copied = [];
    const event = new v.window.Event("copy", { bubbles: true, cancelable: true });
    event.clipboardData = { setData: (type, value) => copied.push([type, value]) };
    v.window.document.dispatchEvent(event);
    assert.deepEqual(copied, [], "nothing is forced onto a copy that has a selection to carry");
    assert.equal(event.defaultPrevented, false, "the browser's own copy is left alone");
  } finally {
    v.close();
  }
});
