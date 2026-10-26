// A citation quotes the code that was selected.
//
// Cmd+K copies "path:12-18" and the selected lines in a fence, for pasting into a review comment or
// handing to an agent. Its whole value is that the quote is exact, which is why this bug mattered more
// than its size: the gutter stripper matched a line of CODE whose first token happened to be its own
// line number, so line 3 of a data file reading `3 4 5` was quoted as `4 5` — the wrong code under the
// right line number, with nothing on screen to say so.
//
// Measured in a real Chromium before it was written down: `getSelection().toString()` was `"3 4 5"` and
// the citation payload carried `"4 5"`. The gutter is `user-select: none`, so Chromium never put a line
// number in that selection at all and there was nothing to strip in the first place.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/matrix.ts";
// Line 3 is `3 4 5`; line 2 is `  1, 2, 3,`. Both start with a token that could be read as a gutter.
const SOURCE = ["const rows = [", "  1, 2, 3,", "3 4 5", "];", "export default rows;"].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "const rows = [];\n", after: SOURCE + "\n" }]));
});
after(cleanupFixtures);

/** Select whole rows the way a drag down the file does, then ask for the citation. */
async function citationFor(v, fromLine, toLine) {
  v.window.openSourceFile(FILE);
  await v.settle(40);
  const rows = v.$all("#source-body .source-row");
  const range = v.window.document.createRange();
  range.setStartBefore(rows[fromLine - 1].querySelector(".source-code"));
  range.setEndAfter(rows[toLine - 1].querySelector(".source-code"));
  const selection = v.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return v.window.sourceSelectionCitation();
}

test("a line whose first token is its own line number is quoted whole", async () => {
  const v = await loadViewer(html);
  const citation = await citationFor(v, 3, 3);
  assert.ok(citation, "there is a citation for a selection inside the file");
  assert.equal(citation.reference, FILE + ":3");
  assert.match(citation.payload, /\n3 4 5\n/, `the quoted code is the line itself:\n${citation.payload}`);
  assert.doesNotMatch(citation.payload, /\n4 5\n/, "and not the line with its first token eaten");
  v.close();
});

// The two shapes of selected text, given straight to the cleaner.
//
// Not through a jsdom selection: jsdom serializes a range over table rows as one run with no newline
// between them and no separator between the gutter cell and the code cell, so its `toString()` is the
// one thing here that does NOT resemble either real environment. What the cleaner has to get right is
// the text, and these are the two texts it is handed.
test("the gutter is taken off when it is there, and nothing is when it is not", async () => {
  const v = await loadViewer(html);
  v.window.openSourceFile(FILE);
  await v.settle(40);
  const rows = v.$all("#source-body .source-row").slice(1, 3); // lines 2 and 3
  const clean = (text) => v.window.cleanSelectedSourceText(text, rows);

  assert.equal(clean("  1, 2, 3,\n3 4 5"), "  1, 2, 3,\n3 4 5",
    "a real browser's selection has no gutter in it, so there is nothing to take off");
  assert.equal(clean("2\t  1, 2, 3,\n3\t3 4 5"), "  1, 2, 3,\n3 4 5",
    "and a selection that does carry the gutter loses the gutter, not the code");
  v.close();
});
