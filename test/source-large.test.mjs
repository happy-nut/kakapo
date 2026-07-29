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

test("opening a large source file renders every line with correct content", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }) },
  });
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/big.ts", "the large file opened");
  assert.equal(v.$("#source-body").classList.contains("empty"), false, "body is painted, not the placeholder");

  const rows = v.$all("#source-body .source-row");
  assert.ok(rows.length >= LINES, `every line is in the DOM (got ${rows.length} of ${LINES}+)`);
  // Per-line content correctness — anchoring/caret/search all index rows by lineIndex, so a specific line
  // must carry its own text, not a neighbor's.
  const row100 = v.$('#source-body .source-row[data-line-index="100"]');
  assert.ok(row100, "the 101st line has its own row");
  assert.ok(row100.textContent.includes("v100"), `line 100 renders its own content (got: ${row100.textContent.trim().slice(0, 40)})`);
  v.close();
});
