// Moving the caret must cost what moved, not what the file contains.
//
// It used to repaint every inlay hint and lens on every keypress, each one finding its row by an attribute
// scan over the whole table — 1,307 of those per keypress in a 1,920-line file, 40 ms a keystroke measured
// in the real app, 0.48 ms after. The caret does not invalidate a decoration: updateSourceCaret inserts and
// removes a caret span and touches no cell's contents.
//
// These are behavioural, not timing, tests: a stopwatch in jsdom would measure the runner's load. They pin
// the two things that made it slow — the decorations being thrown away, and the file being re-split — so a
// repaint that comes back fails here rather than in a benchmark nobody runs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const LINES = 400;
const body = Array.from({ length: LINES }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let html;
before(async () => { ({ html } = await makeReviewHtml([{ path: "src/big.ts", before: body, after: body.replace("v0 = 0", "v0 = 1") }])); });
after(cleanupFixtures);

// Decorations are painted from the analysis cache; seed it so there is something a caret move could throw
// away, then paint once.
function seedDecorations(v) {
  const hints = [];
  for (let i = 0; i < LINES; i += 2) hints.push({ lineIndex: i, column: 12, label: ": number", kind: "type" });
  v.window.decorationCacheMap().set("inlayHint\u0000src/big.ts", { generation: v.window.analysisGeneration(), value: hints });
  v.window.paintSourceDecorations();
}

test("moving the caret leaves every decoration where it was", async () => {
  const v = await loadViewer(html);
  try {
    v.window.openSourceFile("src/big.ts");
    await settle(120);
    seedDecorations(v);
    const painted = v.$("#source-body").querySelectorAll(".inlay-hint").length;
    assert.ok(painted > 50, `precondition: hints are painted (got ${painted})`);

    const before = v.$("#source-body").querySelectorAll(".inlay-hint")[0];
    for (let i = 0; i < 30; i++) v.window.moveSourceCursor(1, 0);
    await settle(80);

    assert.equal(v.$("#source-body").querySelectorAll(".inlay-hint").length, painted, "the same number of hints");
    assert.equal(v.$("#source-body").querySelectorAll(".inlay-hint")[0], before,
      "and the very same elements — a caret move that re-created them is the repaint coming back");
  } finally {
    v.close();
  }
});

test("the caret path splits the file into lines once, not once per keypress", async () => {
  const v = await loadViewer(html);
  try {
    v.window.openSourceFile("src/big.ts");
    await settle(120);
    // Count the splits of anything file-sized. The caret path used to do three per keypress: its own, the
    // import range's, and a line count's.
    v.window.__splits = 0;
    const realSplit = v.window.String.prototype.split;
    v.window.String.prototype.split = function (...args) { if (this.length > 1000) v.window.__splits += 1; return realSplit.apply(this, args); };
    try {
      for (let i = 0; i < 20; i++) v.window.moveSourceCursor(1, 0);
      await settle(80);
    } finally {
      v.window.String.prototype.split = realSplit;
    }
    assert.ok(v.window.__splits <= 2, `the file is re-split per keypress (${v.window.__splits} splits for 20 moves)`);
  } finally {
    v.close();
  }
});

test("stepping the caret does not read every row out of the DOM", async () => {
  // sourceVisibleLineIndex answers "which line is the next visual row" from the render's row model, and
  // says so in its own comment — scanning a 30k-line file's rows to move one line never made sense. But it
  // read that model off sourceFill, which is cleared the moment the last spacer is filled, so a FINISHED
  // file got exactly the scan the comment was avoiding: querySelectorAll over every row, per keypress. A
  // file small enough to render in one shot never had a sourceFill at all and always paid it.
  const v = await loadViewer(html);
  try {
    v.window.openSourceFile("src/big.ts");
    await settle(200); // let any progressive fill finish, which is when the model used to disappear

    let rowScans = 0;
    const real = v.window.Element.prototype.querySelectorAll;
    v.window.Element.prototype.querySelectorAll = function (sel) {
      if (String(sel).includes(".source-row[data-line-index]")) rowScans += 1;
      return real.call(this, sel);
    };
    try {
      for (let i = 0; i < 20; i++) v.window.moveSourceCursor(1, 0);
      await settle(80);
    } finally {
      v.window.Element.prototype.querySelectorAll = real;
    }
    assert.ok(rowScans <= 2, `the caret reads the whole row list per keypress (${rowScans} scans for 20 moves)`);
  } finally {
    v.close();
  }
});
