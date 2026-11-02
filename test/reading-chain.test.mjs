// CORE: "which declaration is this line inside?" — the one question Sticky Lines and Focus Mode both ask.
//
// Both read enclosingSymbols(), so a wrong answer here shows up twice: the pinned header names declarations
// the reader is not inside, and Focus Mode dims the file around the wrong one. The bug this guards is a
// single clause that let a ONE-LINE symbol enclose everything below it forever.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

// documentSymbol answers carry a full range for a declaration that spans lines, and a degenerate one
// (end === start) for a `var`, a property or a one-line function. That difference is the whole input.
const SYMBOLS = [
  { name: "topVar", kind: "variable", lineIndex: 2, endLineIndex: 2 },
  { name: "Outer", kind: "class", lineIndex: 10, endLineIndex: 90 },
  { name: "oneLiner", kind: "variable", lineIndex: 12, endLineIndex: 12 },
  { name: "method", kind: "function", lineIndex: 20, endLineIndex: 40 },
  { name: "later", kind: "function", lineIndex: 60, endLineIndex: 70 },
];

async function withSymbols() {
  const v = await loadViewer(html);
  v.window.structureCache.set("src/a.ts", {
    generation: v.window.analysisGeneration(),
    value: { symbols: SYMBOLS },
  });
  return v;
}

const names = (rows) => Array.from(rows, (s) => s.name);

test("a line inside a declaration is enclosed by that declaration, outermost first", async () => {
  const v = await withSymbols();
  assert.deepEqual(names(v.window.enclosingSymbols("src/a.ts", 30)), ["Outer", "method"]);
  v.close();
});

test("a one-line symbol encloses its own line and nothing below it", async () => {
  const v = await withSymbols();
  // ON the line: it is what you are inside.
  assert.ok(names(v.window.enclosingSymbols("src/a.ts", 12)).includes("oneLiner"));
  // One line later it is already behind you. The clause used to read `endLineIndex === lineIndex`, which is
  // true of EVERY one-liner, so `topVar` and `oneLiner` answered for every line in the file: sticky lines
  // pinned the three nearest one-liners (siblings, not ancestors) and Focus Mode took the last of them as
  // the declaration to keep, dimming everything else — the caret's own line included.
  const at30 = names(v.window.enclosingSymbols("src/a.ts", 30));
  assert.ok(!at30.includes("oneLiner"), "a one-liner at 12 does not enclose line 30");
  assert.ok(!at30.includes("topVar"), "a top-level var at 2 does not enclose line 30");
  v.close();
});

test("a declaration that has ended does not enclose what follows it", async () => {
  const v = await withSymbols();
  assert.deepEqual(names(v.window.enclosingSymbols("src/a.ts", 65)), ["Outer", "later"]);
  v.close();
});

test("the sticky header pins the chain, and nothing when there is none", async () => {
  const v = await withSymbols();
  assert.deepEqual(names(v.window.enclosingSymbols("src/a.ts", 5)), [], "above every declaration");
  assert.deepEqual(names(v.window.enclosingSymbols("src/a.ts", 95)), [], "past the last one");
  v.close();
});
