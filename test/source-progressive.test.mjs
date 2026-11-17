import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const LINES = 3000;
const body = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let html;

before(async () => {
  ({ html } = await makeReviewHtml([{ path: "src/big.ts", before: body(LINES), after: body(LINES).replace("v0 = 0", "v0 = 1") }]));
});
after(cleanupFixtures);

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
    installLayout(v, { spacerTop: 90000 });
    v.window.openSourceFile("src/big.ts");
    const resting = await restingRowCount(v);
    assert.ok(resting > 0 && resting < LINES, `stopped short of the whole file: ${resting} of ${LINES} rows`);
    assert.ok(spacer(v), "the rest is still a spacer");
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

    installLayout(v, { spacerTop: 400 });
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

test("Select All reaches the end of a file whose rows are not all painted", async () => {
  const v = await loadViewer(html);
  try {
    installLayout(v, { spacerTop: 90000 });
    v.window.openSourceFile("src/big.ts");
    const parked = await restingRowCount(v);
    assert.ok(parked < LINES, `precondition: the file is not fully painted (${parked} of ${LINES})`);
    assert.ok(spacer(v), "precondition: a spacer stands in for the rest");

    assert.equal(v.window.selectAllInView(), true, "Select All found a target");

    assert.ok(
      v.$("#source-body").querySelector(`.source-row[data-line-index="${LINES - 1}"]`),
      "the file's last line is in the document that Select All just selected",
    );
    assert.equal(spacer(v), null, "and nothing is left standing in for rows that were never painted");
  } finally {
    v.close();
  }
});
