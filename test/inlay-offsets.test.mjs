import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const FOLDED = "src/folded.ts";
const FOLDED_LINES = [
  "export function widen(value) {",
  "  const doubled = value * 2;",
  "  return doubled;",
  "}",
];
const LINES = [
  "const a = 1;",
  "    return cache.get(name);",
  "3 4 5",
  "};",
];
const HINTED = LINES[1];

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "const a = 0;\n", after: `${LINES.join("\n")}\n` },
    { path: FOLDED, before: "export function widen(v) { return v; }\n", after: `${FOLDED_LINES.join("\n")}\n` },
  ], { app: true }));
});
after(cleanupFixtures);

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
  for (const column of [0, 4, 11, 15, 20, HINTED.length]) {
    assert.equal(columnOf(v.window.caretDomPosition(1, column)), column,
      `the caret puts column ${column} at column ${column}`);
    assert.equal(columnOf(v.window.fileFindDomPoint(cell, column)), column,
      `a find match puts column ${column} at column ${column}`);
  }
  v.close();
});

test("a range reaching the end of a hinted line is still built", async () => {
  const { v, cell } = await withHint(1, 11, "obj:");
  const toEnd = v.window.fileFindRange(cell, 4, HINTED.length - 4);
  assert.ok(toEnd, "a range from column 4 to the end of the line builds");
  assert.equal(String(toEnd).replace(/obj:\s*/, ""), HINTED.slice(4),
    "…and covers the line's own characters");
  v.close();
});

test("copying a line whose first token is its line number survives a hint on it", async () => {
  const { v } = await withHint(2, 2, "n:");
  const rows = [v.$('.source-row[data-line-index="2"]')];
  assert.equal(v.window.cleanSelectedSourceText(LINES[2], rows), "3 4 5",
    "the line is quoted as it is, not with its first token eaten");
  v.close();
});

test("a highlight does not swallow a label sitting at its edge", async () => {
  const { v, cell } = await withHint(1, 11, "obj:");
  const atLabel = v.window.fileFindRange(cell, 11, 5);
  assert.ok(atLabel, "the range builds");
  assert.equal(String(atLabel), "cache", "it covers the word, not the label in front of it");

  const upToLabel = v.window.fileFindRange(cell, 4, 7);
  assert.ok(upToLabel, "that range builds too");
  assert.equal(String(upToLabel), "return ", "and stops before the label");
  v.close();
});

async function withFold() {
  const v = await loadViewer(html, { analysisBridge: () => null });
  v.window.openSourceFile(FOLDED);
  await v.settle(40);
  v.window.collapseAllSourceFolds();
  await v.settle(60);
  const row = v.$(".source-row.source-block-folded");
  return { v, row, cell: row && row.querySelector(".source-code") };
}

test("a collapsed fold's summary is not part of the line it hangs off", async () => {
  const { v, row, cell } = await withFold();
  try {
    assert.ok(row, "the block collapsed, so there is a summary drawn into a line");
    assert.ok(cell.querySelector(".mc-code-fold-button"), "…and it is inside the line's own cell");
    assert.notEqual(cell.textContent, FOLDED_LINES[0], "the painted cell is longer than the line");
    assert.equal(v.window.sourceCellText(cell), FOLDED_LINES[0], "…and the line's own text is the line");
  } finally {
    v.close();
  }
});

test("the last column of a folded line is the end of the line, not the start of the summary", async () => {
  const { v, row, cell } = await withFold();
  try {
    const line = Number(row.dataset.lineIndex);
    const end = v.window.caretDomPosition(line, v.window.sourceCellText(cell).length);
    assert.ok(end, "a point for the last column builds");
    const host = end.node.nodeType === 3 ? end.node.parentElement : end.node;
    assert.equal(host.closest(".mc-code-fold-button"), null,
      "the caret for the last column is not inside the fold's summary");
    assert.equal(v.window.sourceTextLengthBefore(cell, end.node, end.offset), FOLDED_LINES[0].length,
      "and reading that point back gives the line's last column");
  } finally {
    v.close();
  }
});
