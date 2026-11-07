// A big file paints a window and builds the rest as the reader reaches it.
//
// It used to finish every file regardless of where the reader was, and the rows are what a big file costs:
// measured in the real app on electron.d.ts (27,088 lines), the window alone is +25 MB and the whole file
// +1,093 MB, with the JS heap flat at 10 MB throughout — Blink's DOM and layout for 138,449 nodes, five per
// row, for rows nobody scrolled to. Rows are still never removed, so "not built yet" is the only new state,
// and that is what a spacer has always meant.
//
// jsdom has no layout, so every rect is zero and the viewport test reads "in reach" — a page that cannot
// measure itself fills eagerly, exactly as before. These tests give it rects so the lazy path is reachable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const LINES = 3000; // past sourceProgressiveLimits().minRows, so the progressive path engages at all
const body = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let html;

before(async () => {
  ({ html } = await makeReviewHtml([{ path: "src/big.ts", before: body(LINES), after: body(LINES).replace("v0 = 0", "v0 = 1") }]));
});
after(cleanupFixtures);

// Give the page just enough geometry for "is this spacer within reach" to mean something: a 900px viewport
// at the top, and a spacer wherever the test wants it.
function installLayout(v, { spacerTop = 90000 } = {}) {
  const win = v.window;
  Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, value: 900 });
  win.Element.prototype.getBoundingClientRect = function () {
    const spacer = this.classList && this.classList.contains("source-spacer");
    if (spacer) return { top: spacerTop, bottom: spacerTop + 500000, left: 0, right: 800, width: 800, height: 500000 };
    return { top: 0, bottom: 900, left: 0, right: 800, width: 800, height: 900 };
  };
}

const rowCount = (v) => v.$("#source-body").querySelectorAll(".source-row").length;
const spacer = (v) => v.$("#source-body").querySelector(".source-spacer");

// The row count once the fill has come to REST — unchanged across two turns.
//
// Asserting a partial count after a fixed sleep is a bet on the clock, and it is a bet these tests lost:
// the old eager fill reaches the end of this file too, just later, so under a loaded test runner it was
// still at 2,400 of 3,001 rows when the assertion ran and the test passed against the very code it was
// written to catch. What separates the two is where the fill STOPS, so that is what is measured.
async function restingRowCount(v) {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await settle(50);
    const now = rowCount(v);
    if (now === last) return now;
    last = now;
  }
  throw new Error(`the fill never came to rest (${last} rows)`);
}

test("a file far taller than the window stops at the window, and keeps a spacer for the rest", async () => {
  const v = await loadViewer(html);
  try {
    installLayout(v, { spacerTop: 90000 }); // 100 screens down: out of reach
    v.window.openSourceFile("src/big.ts");
    const resting = await restingRowCount(v);
    assert.ok(resting > 0 && resting < LINES, `stopped short of the whole file: ${resting} of ${LINES} rows`);
    assert.ok(spacer(v), "the rest is still a spacer");
    // LINES + 1: the file ends in a newline, so there is a last, empty row.
    assert.equal(Number(spacer(v).dataset.spacerTo), LINES + 1, "whose far end is the end of the file");
  } finally {
    v.close();
  }
});

test("scrolling towards what is not built builds it", async () => {
  const v = await loadViewer(html);
  try {
    installLayout(v, { spacerTop: 90000 });
    v.window.openSourceFile("src/big.ts");
    const parked = await restingRowCount(v);

    installLayout(v, { spacerTop: 400 }); // the reader has scrolled: the spacer is on screen now
    v.$("#source-body").dispatchEvent(new v.window.Event("scroll"));
    const grown = await restingRowCount(v);
    assert.ok(grown > parked, `scrolling built more rows (${parked} -> ${grown})`);
  } finally {
    v.close();
  }
});

test("a caret sent past the built region arrives on a real row", async () => {
  const v = await loadViewer(html);
  try {
    installLayout(v, { spacerTop: 90000 });
    v.window.openSourceFile("src/big.ts");
    assert.ok(await restingRowCount(v) < LINES, "precondition: the end of the file is not built");

    v.window.setSourceCursor("src/big.ts", LINES - 5, 0, true, -1);
    await settle(200);
    assert.ok(
      v.$("#source-body").querySelector(`.source-row[data-line-index="${LINES - 5}"]`),
      "the line a jump names exists once the jump lands on it",
    );
  } finally {
    v.close();
  }
});

// The regression that made the whole change pointless the first time: a decorator asked for the row of
// every item it wanted to draw on, and each miss finished the file. One red dot cost all 27,089 rows.
test("a decorator draws on the rows that are painted instead of building the file to draw on", async () => {
  const v = await loadViewer(html);
  try {
    installLayout(v, { spacerTop: 90000 });
    v.window.openSourceFile("src/big.ts");
    const parked = await restingRowCount(v);

    assert.equal(v.window.paintedSourceRow(LINES - 5), null, "an unbuilt row reads as absent...");
    assert.equal(rowCount(v), parked, "...and asking did not build the file");
    assert.ok(v.window.paintedSourceRow(0), "a painted row is still found");
  } finally {
    v.close();
  }
});
