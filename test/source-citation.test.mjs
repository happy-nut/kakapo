import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/matrix.ts";
const SOURCE = ["const rows = [", "  1, 2, 3,", "3 4 5", "];", "export default rows;"].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "const rows = [];\n", after: SOURCE + "\n" }]));
});
after(cleanupFixtures);

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

test("the gutter is taken off when it is there, and nothing is when it is not", async () => {
  const v = await loadViewer(html);
  v.window.openSourceFile(FILE);
  await v.settle(40);
  const rows = v.$all("#source-body .source-row").slice(1, 3);
  const clean = (text) => v.window.cleanSelectedSourceText(text, rows);

  assert.equal(clean("  1, 2, 3,\n3 4 5"), "  1, 2, 3,\n3 4 5",
    "a real browser's selection has no gutter in it, so there is nothing to take off");
  assert.equal(clean("2\t  1, 2, 3,\n3\t3 4 5"), "  1, 2, 3,\n3 4 5",
    "and a selection that does carry the gutter loses the gutter, not the code");
  v.close();
});
