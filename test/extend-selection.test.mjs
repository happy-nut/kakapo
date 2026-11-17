import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const LINES = [
  "export class Store {",
  "  load(name) {",
  "    return cache.get(name);",
  "  }",
  "}",
];
const SOURCE = LINES.join("\n");

const CARET = { line: 2, column: 21 };
const CHAIN = [
  { startLine: 2, startCharacter: 21, endLine: 2, endCharacter: 25 },
  { startLine: 2, startCharacter: 20, endLine: 2, endCharacter: 26 },
  { startLine: 2, startCharacter: 11, endLine: 2, endCharacter: 26 },
  { startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 27 },
  { startLine: 1, startCharacter: 2, endLine: 3, endCharacter: 3 },
  { startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 1 },
];

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "export class Store {}\n", after: `${SOURCE}\n` }], { app: true }));
});
after(cleanupFixtures);

async function openSource(chain = CHAIN) {
  const asked = [];
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      if (request.kind !== "selectionRange") return null;
      asked.push({ path: request.path, line: request.line, column: request.column });
      return { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: [], selection: chain };
    },
  });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, CARET.line, CARET.column);
  await v.settle(20);
  return { v, asked };
}

const grow = async (v) => { v.key("ArrowUp", { code: "ArrowUp", altKey: true }); await v.settle(60); };
const shrink = async (v) => { v.key("ArrowDown", { code: "ArrowDown", altKey: true }); await v.settle(60); };
const selected = (v) => String(v.window.getSelection() || "");

test("each press grows the selection to the next construct out", async () => {
  const { v, asked } = await openSource();
  assert.equal(selected(v), "", "nothing is selected before the first press");

  await grow(v);
  assert.equal(selected(v), "name", "the word under the caret");
  assert.deepEqual(asked, [{ path: FILE, line: CARET.line, column: CARET.column }],
    "asked once, at the caret");

  await grow(v);
  assert.equal(selected(v), "(name)");
  await grow(v);
  assert.equal(selected(v), "cache.get(name)");
  await grow(v);
  assert.equal(selected(v), "return cache.get(name);");

  assert.equal(asked.length, 1, `one request for the whole walk: ${JSON.stringify(asked)}`);
  v.close();
});

test("a press back in walks the same chain down, and past the start clears it", async () => {
  const { v } = await openSource();
  await grow(v); await grow(v); await grow(v);
  assert.equal(selected(v), "cache.get(name)");

  await shrink(v);
  assert.equal(selected(v), "(name)");
  await shrink(v);
  assert.equal(selected(v), "name");
  await shrink(v);
  assert.equal(selected(v), "", "back to no selection at all");
  v.close();
});

// Checked by the range's ENDPOINTS, not by its text. In the app the line-number gutter is excluded from
// a selection by `.num { user-select: none }` (viewer.css); jsdom's Selection.toString() does not apply
// CSS, so across lines it returns the gutter numbers too — an artifact of the harness that would make a
// text assertion here test jsdom rather than the app.
test("a multi-line construct selects from its first line to its last", async () => {
  const { v } = await openSource();
  const rowOf = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const row = el && el.closest && el.closest(".source-row");
    return row ? Number(row.dataset.lineIndex) : -1;
  };
  const span = () => {
    const sel = v.window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return { from: rowOf(range.startContainer), to: rowOf(range.endContainer) };
  };

  for (let i = 0; i < 5; i += 1) await grow(v);
  assert.deepEqual(span(), { from: 1, to: 3 }, "the whole method, `load(name) {` through its closing brace");
  await grow(v);
  assert.deepEqual(span(), { from: 0, to: 4 }, "then the whole class");
  v.close();
});

test("moving the caret starts a new walk", async () => {
  const { v, asked } = await openSource();
  await grow(v); await grow(v);
  assert.equal(selected(v), "(name)");

  v.window.setSourceCursor(FILE, 0, 13);
  await v.settle(20);
  await grow(v);
  assert.equal(asked.length, 2, "the server is asked again");
  assert.deepEqual(asked[1], { path: FILE, line: 0, column: 13 }, "…about the new caret");
  v.close();
});

test("nothing happens where the server has no chain to give", async () => {
  const { v } = await openSource([]);
  await grow(v);
  assert.equal(selected(v), "", "no selection invented from an empty answer");
  v.close();
});

test("shrink with no walk in progress leaves a hand-made selection alone", async () => {
  const { v } = await openSource();
  v.window.setSourceCursor(FILE, 2, 11);
  await v.settle(20);
  v.key("ArrowRight", { code: "ArrowRight", shiftKey: true });
  v.key("ArrowRight", { code: "ArrowRight", shiftKey: true });
  await v.settle(40);
  const byHand = selected(v);
  assert.ok(byHand.length > 0, `⇧→ selected something: ${JSON.stringify(byHand)}`);
  await shrink(v);
  assert.equal(selected(v), byHand, "⌥↓ left it exactly as it was");
  v.close();
});

test("the guard sees a far end that is still a spacer, and flushing clears it", async () => {
  const LONG = ["export class Big {"];
  for (let i = 0; i < 1200; i += 1) LONG.push(`  step${i}() { return ${i}; }`);
  LONG.push("}");
  const path = "src/big.ts";
  const { html: big } = await makeReviewHtml(
    [{ path, before: "export class Big {}\n", after: `${LONG.join("\n")}\n` }], { app: true });
  const v = await loadViewer(big, { analysisBridge: () => null });
  const last = LONG.length - 1;
  const wholeClass = { startLine: 0, startCharacter: 0, endLine: last, endCharacter: 1 };

  v.window.openSourceFile(path);
  assert.ok(v.$all(".source-spacer").length > 0, "the file really is painted in a window");
  assert.equal(Boolean(v.$(`.source-row[data-line-index="${last}"]`)), false, "…and the far end is not in it");
  assert.equal(v.window.sourceSelectionIsWhole(wholeClass), false,
    "so a selection to the last line cannot be drawn yet");

  v.window.flushSourceRows();
  assert.equal(v.window.sourceSelectionIsWhole(wholeClass), true, "finishing the file makes both ends real");
  v.close();
});

test("a line's inlay hints do not shift its columns", async () => {
  const { v } = await openSource();
  const line = LINES[2];
  const cell = v.$('.source-row[data-line-index="2"] .source-code');
  assert.equal(cell.textContent, line, "the cell starts out as the line itself");

  v.window.insertInlayHint(cell, 21, "key:", "parameter", false, true);
  assert.notEqual(cell.textContent, line, "…and now carries text the line does not have");

  for (const column of [0, 4, 11, 20, 21, 25, line.length]) {
    const at = v.window.caretDomPosition(2, column);
    assert.ok(at, `column ${column} resolves`);
    const before = v.window.sourceTextLengthBefore(cell, at.node, at.offset);
    assert.equal(before, column, `column ${column} is still column ${column} with a hint in the way`);
  }

  await grow(v);
  const range = v.window.getSelection().getRangeAt(0);
  assert.equal(v.window.sourceTextLengthBefore(cell, range.startContainer, range.startOffset), 21,
    "the selection starts at the column the server named");
  assert.equal(v.window.sourceTextLengthBefore(cell, range.endContainer, range.endOffset), 25,
    "…and ends at the one it named, with the hint counted as part of neither");
  v.close();
});
