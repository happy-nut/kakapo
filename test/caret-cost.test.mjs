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
  const v = await loadViewer(html);
  try {
    v.window.openSourceFile("src/big.ts");
    await settle(200);

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
