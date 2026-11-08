// An inlay hint is the server's text, drawn INSIDE the line's markup. It is not part of the line, and
// everything that converts between a column and a place in the DOM has to agree about that.
//
// Six readers did that conversion and one of them knew — insertInlayHint, which filters the labels out of
// its own walk and whose comment spells out the drift that follows if you do not. The other five counted
// the labels, so on any line carrying one:
//
//   * ⌥↑ on `startLine` selected `Math.trun` (caretDomPosition);
//   * a ⌘F match was highlighted at whatever sat that far along the PAINTED text (fileFindDomPoint);
//   * a click on a wrapped line reported a column past the end (estimateColumnFromClick);
//   * copying `3 4 5` gave `4 5`, defeating the guard written to stop exactly that (stripLineNumberGutter);
//   * a multi-line diagnostic clamped its end past the last column and drew no squiggle (18-diagnostics);
//   * a usage mark measured its offset with the labels and resolved it without them (17-find-usages).
//
// They now share one walk (sourceTextWalker / sourceCellText). This file is the guard: it puts a label in
// a line and asks each reader what a column means.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const LINES = [
  "const a = 1;",                  // 0
  "    return cache.get(name);",   // 1  <- the hinted line
  "3 4 5",                         // 2  <- first token is its own line number
  "};",                            // 3
];
const HINTED = LINES[1];

let html;
before(async () => {
  ({ html } = await makeReviewHtml(
    [{ path: FILE, before: "const a = 0;\n", after: `${LINES.join("\n")}\n` }], { app: true }));
});
after(cleanupFixtures);

/** The viewer with `label` drawn into line `line` at `column`, as a language server would. */
async function withHint(line, column, label) {
  const v = await loadViewer(html, { analysisBridge: () => null });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  const cell = v.$(`.source-row[data-line-index="${line}"] .source-code`);
  v.window.insertInlayHint(cell, column, label, "parameter", false, true);
  return { v, cell };
}

test("the cell carries the label, and the line does not", async () => {
  const { v, cell } = await withHint(1, 11, "obj:");
  assert.notEqual(cell.textContent, HINTED, "the painted cell is longer than the line");
  assert.equal(v.window.sourceCellText(cell), HINTED, "…and the line's own text is the line");
  v.close();
});

test("every column-to-DOM reader means the same column", async () => {
  const { v, cell } = await withHint(1, 11, "obj:");
  const columnOf = (point) => (point ? v.window.sourceTextLengthBefore(cell, point.node, point.offset) : null);
  // Columns on both sides of the label, and the last one, which is where an off-by-anything shows up.
  for (const column of [0, 4, 11, 15, 20, HINTED.length]) {
    assert.equal(columnOf(v.window.caretDomPosition(1, column)), column,
      `the caret puts column ${column} at column ${column}`);
    assert.equal(columnOf(v.window.fileFindDomPoint(cell, column)), column,
      `a find match puts column ${column} at column ${column}`);
  }
  v.close();
});

// 18-diagnostics clamps a multi-line range to the end of its first line, measured from the container. A
// length measured with the label in it runs off the end of the line, fileFindDomPoint answers null, and
// the squiggle is simply not drawn.
test("a range reaching the end of a hinted line is still built", async () => {
  const { v, cell } = await withHint(1, 11, "obj:");
  const toEnd = v.window.fileFindRange(cell, 4, HINTED.length - 4);
  assert.ok(toEnd, "a range from column 4 to the end of the line builds");
  assert.equal(String(toEnd).replace(/obj:\s*/, ""), HINTED.slice(4),
    "…and covers the line's own characters");
  v.close();
});

// The guard in stripLineNumberGutter exists because `^\s*<n>\s+` also eats a line of CODE whose first
// token is its own line number. The guard asks the row what it holds — and with a label in the row it
// stopped recognising the line, so the regex ran after all.
test("copying a line whose first token is its line number survives a hint on it", async () => {
  const { v } = await withHint(2, 2, "n:");
  const rows = [v.$('.source-row[data-line-index="2"]')];
  assert.equal(v.window.cleanSelectedSourceText(LINES[2], rows), "3 4 5",
    "the line is quoted as it is, not with its first token eaten");
  v.close();
});

// A label sitting exactly at the edge of a range is the case the offsets alone do not settle. Both sides
// of that seam are the same column; the label is between them. A CSS custom highlight paints whatever its
// range covers and, unlike a text selection, takes no notice of `user-select: none` — so ⌘F7 marked
// `x: startLine` where the server had named `startLine`. Watched in the running app first.
test("a highlight does not swallow a label sitting at its edge", async () => {
  const { v, cell } = await withHint(1, 11, "obj:"); // immediately before `cache`
  const atLabel = v.window.fileFindRange(cell, 11, 5); // `cache`
  assert.ok(atLabel, "the range builds");
  assert.equal(String(atLabel), "cache", "it covers the word, not the label in front of it");

  // …and the other edge: a range ENDING where a label begins must not reach across it either.
  const upToLabel = v.window.fileFindRange(cell, 4, 7); // `return `
  assert.ok(upToLabel, "that range builds too");
  assert.equal(String(upToLabel), "return ", "and stops before the label");
  v.close();
});
