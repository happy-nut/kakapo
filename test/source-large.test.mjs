// Safety net for the large-file source view — the exact surface a future virtualization (V1) will change,
// and the one the suite never exercised (its other fixtures are ~30 lines). Pins that opening a big file
// renders its lines with correct per-line content (what comment anchoring / caret / search all rely on),
// so the windowing rework can be verified against a real large input instead of by eye.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const UI_KEY = "kakapo-diff-ui:/review.html"; // uiStateKey = 'kakapo-diff-ui:' + location.pathname
const LINES = 4200; // over shouldLazyRender's 4000-line threshold — a genuinely large source file

let html;
before(async () => {
  const base = Array.from({ length: LINES }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  ({ html } = await makeReviewHtml([{ path: "src/big.ts", before: base, after: base + "const tail = true;\n" }]));
});
after(cleanupFixtures);

// A big file paints the rows around the caret first and fills the rest in afterwards, because rendering was
// 85-93% of the wait when following a definition (measured: a 30k-line destination took 782ms end to end,
// of which the language server was 62ms). Both halves of that contract matter — the first paint has to be
// small, and the file still has to end up complete and per-line correct, because comments, the caret,
// search and find all index rows by lineIndex.
test("a large source file paints a window first and still ends up complete", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }) },
  });
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/big.ts", "the large file opened");
  assert.equal(v.$("#source-body").classList.contains("empty"), false, "body is painted, not the placeholder");

  const firstPaint = v.$all("#source-body .source-row").length;
  assert.ok(firstPaint > 0, "something is on screen immediately");
  assert.ok(firstPaint < LINES, `the first paint is a window, not the whole file (got ${firstPaint} of ${LINES})`);
  assert.ok(v.$("#source-body .source-spacer"), "and the rest is held by an exact-height spacer");

  // The spacer stands for the rows that are missing, so the body keeps the height it will finally have —
  // nothing shifts under the reader when a spacer becomes real rows.
  const spacer = v.$("#source-body .source-spacer");
  const held = Number(spacer.dataset.spacerTo) - Number(spacer.dataset.spacerFrom);
  assert.ok(held > 0, "the spacer says how many rows it stands for");
  assert.match(spacer.getAttribute("style") || "", /height:\s*\d+px/, "with a height, so the scrollbar is honest");

  // …and the fill finishes on its own.
  for (let i = 0; i < 400 && v.$("#source-body .source-spacer"); i += 1) await v.settle(10);
  assert.equal(v.$("#source-body .source-spacer"), null, "the fill completes without being asked");

  const rows = v.$all("#source-body .source-row");
  assert.ok(rows.length >= LINES, `every line ends up in the DOM (got ${rows.length} of ${LINES}+)`);
  // Per-line content correctness — anchoring/caret/search all index rows by lineIndex, so a specific line
  // must carry its own text, not a neighbor's. Checked near both ends, since the fill works outward.
  for (const line of [0, 100, 2500, LINES - 1]) {
    const row = v.$(`#source-body .source-row[data-line-index="${line}"]`);
    assert.ok(row, `line ${line} has its own row`);
    assert.ok(
      row.textContent.includes(`v${line}`),
      `line ${line} renders its own content (got: ${row.textContent.trim().slice(0, 40)})`,
    );
  }
  v.close();
});

// Anything that needs a row the fill has not reached yet asks for the whole file first, so no caller has to
// learn about a row that might not exist. The worst case is exactly the old behaviour.
test("asking for an unpainted row completes the file synchronously", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }) },
  });
  assert.ok(v.$("#source-body .source-spacer"), "the file starts windowed");
  v.window.flushSourceRows();
  assert.equal(v.$("#source-body .source-spacer"), null, "one flush and there is nothing outstanding");
  assert.ok(
    v.$all("#source-body .source-row").length >= LINES,
    "every line is present the moment someone needs one",
  );
  v.close();
});
