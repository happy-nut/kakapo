// A blank line is in the copy.
//
// The source view is a real `<table>`, and a blank line used to render as `<td class="source-code"></td>`
// — a cell with no content whatsoever. Chromium's table-to-text serializer drops such a row WHOLE, taking
// its separator with it, and `.num` is `user-select: none`, so a blank line's row had nothing selectable
// anywhere. Measured in the real app on `src/analysis.ts`: 1761 lines selected, 1691 on the clipboard, and
// the 70 that went missing were exactly its 70 blank lines. Same shortfall on `src/lsp.ts` (98 of 98) and
// on `src/viewer/10-source-view.js` (55 of 55) — a copied function came back with its paragraphs run
// together, which is what sent a reader looking for the callers of something they could not paste.
//
// It reached the Cmd+K citation too, and worse: `cleanSelectedSourceText` pairs the serializer's lines
// with the selected ROWS by index, and on the mismatch it gives up and returns the text unpaired. A
// citation went out reading `src/analysis.ts:81-83` with two lines under it.
//
// What is pinned here is the DOM, not the clipboard. jsdom serializes a range over table rows as one run
// with no row separators at all — the one environment that resembles neither Chromium nor a file — so a
// `toString()` assertion here would pass whatever the cells held. The cell is what decides the
// serializer's answer, so the cell is what this asks about. The clipboard itself was verified over CDP in
// the real app: three whole files copy character for character.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/spaced.ts";
// Blank lines first, last-but-one, and between code — plus the empty final line every file ending in a
// newline has, which is the one row that must NOT be padded.
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
    // LINES has 7 entries and the content ends in a newline, so the view shows 8 rows: the last is the
    // empty line after the final newline.
    assert.equal(v.$all("#source-body .source-row").length, LINES.length + 1, "every line has a row");

    for (const line of [1, 3, 4]) {
      const cell = cellAt(v, line);
      assert.equal(cell.innerHTML, "<br>", `line ${line + 1} is blank and its cell holds a break`);
    }
    for (const line of [0, 2, 5]) {
      assert.equal(cellAt(v, line).querySelector("br"), null,
        `line ${line + 1} has code, so nothing is padded into it`);
    }
    // The table's last row has no row below to be separated from, and a break there is a newline Chromium
    // emits with nothing after it: a whole-file copy came back one line longer than the file.
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
    // Said out loud, so this cannot go green by there being nothing in the cell to be invisible.
    assert.ok(cell.querySelector("br"), "precondition: the blank line is padded");
    assert.equal(v.window.sourceCellText(cell), "", "the line's own text is still empty");
    assert.equal(cell.textContent, "", "and so is textContent, which captureSourceRefreshCursor reads");
    assert.equal(v.window.sourceTextLengthBefore(cell, cell, cell.childNodes.length), 0,
      "a point past the break is still column 0");
    // insertSourceCaret keys its out-of-flow blank-line caret on exactly this, so it must stay true.
    assert.equal((cell.textContent || "").length, 0, "the blank-line caret's own test still sees a blank line");
  } finally {
    v.close();
  }
});
