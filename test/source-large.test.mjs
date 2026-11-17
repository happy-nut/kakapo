import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const UI_KEY = "kakapo-diff-ui:/review.html";
const LINES = 4200;

let html;
before(async () => {
  const base = Array.from({ length: LINES }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  ({ html } = await makeReviewHtml([{ path: "src/big.ts", before: base, after: base + "const tail = true;\n" }]));
});
after(cleanupFixtures);

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

  const spacer = v.$("#source-body .source-spacer");
  const held = Number(spacer.dataset.spacerTo) - Number(spacer.dataset.spacerFrom);
  assert.ok(held > 0, "the spacer says how many rows it stands for");
  assert.match(spacer.getAttribute("style") || "", /height:\s*\d+px/, "with a height, so the scrollbar is honest");

  for (let i = 0; i < 400 && v.$("#source-body .source-spacer"); i += 1) await v.settle(10);
  assert.equal(v.$("#source-body .source-spacer"), null, "the fill completes without being asked");

  const rows = v.$all("#source-body .source-row");
  assert.ok(rows.length >= LINES, `every line ends up in the DOM (got ${rows.length} of ${LINES}+)`);
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

test("asking for an unpainted row completes the file synchronously", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }) },
  });
  v.window.flushSourceRows();
  v.window.openSourceFile("src/big.ts");
  assert.ok(v.$("#source-body .source-spacer"), "the file starts windowed");

  v.window.flushSourceRows();
  assert.equal(v.$("#source-body .source-spacer"), null, "one flush and there is nothing outstanding");
  assert.ok(
    v.$all("#source-body .source-row").length >= LINES,
    "every line is present the moment someone needs one",
  );
  v.close();
});
