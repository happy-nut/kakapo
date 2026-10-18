// The surfaces this bounty touches, from the point of view of someone not watching the window.
//
// Navigation answers the keyboard with one small element in a corner: "looking for X…", "definition not
// found", "still reading the project". If that element is not a live region, the key press has no outcome at
// all for a screen reader — and whether semantic analysis is ready, which decides what those keys can even
// do, was equally silent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
let bigHtml;
const FILE = "src/app.ts";
const BIG_LINES = 4200;

before(async () => {
  const base = "export function helper() { return 1; }\nexport const used = helper();\n";
  ({ html } = await makeReviewHtml([{ path: FILE, before: base, after: base + "const extra = used;\n" }]));
  const big = Array.from({ length: BIG_LINES }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  ({ html: bigHtml } = await makeReviewHtml([{ path: "src/big.ts", before: big, after: big + "const tail = true;\n" }]));
});

after(cleanupFixtures);

test("what navigation says is announced, not just drawn", async () => {
  const v = await loadViewer(html);
  try {
    v.window.kakapoAnalysis = {
      query: () => Promise.resolve({ ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] }),
      diagnostics: () => Promise.resolve({ ok: true, generation: 0, diagnostics: [] }),
      status: () => Promise.resolve({ phase: "ready", generation: 0 }),
      onStatus: () => {},
    };
    await v.openSourceFile(FILE);
    await v.clickSourceLine(1);
    v.key("ArrowDown", { metaKey: true, code: "ArrowDown" });
    await v.settle(80);

    const hint = v.$(".mc-caret-hint");
    assert.ok(hint, "the hint exists once navigation has something to say");
    assert.equal(hint.getAttribute("role"), "status", "it is a status region");
    assert.equal(hint.getAttribute("aria-live"), "polite", "announced politely, not cutting across the reader");
    assert.ok((hint.textContent || "").trim(), "and it actually carries the message");
  } finally {
    v.close();
  }
});

test("the stand-in row for unpainted lines is not read as content", async () => {
  const v = await loadViewer(bigHtml, {
    seedSession: {
      "kakapo-diff-ui:/review.html": JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }),
    },
  });
  try {
    const spacer = v.$("#source-body .source-spacer");
    assert.ok(spacer, "a big file starts with a spacer standing in for the rest");
    assert.equal(
      spacer.getAttribute("aria-hidden"),
      "true",
      "one blank cell standing for thousands of lines is a scrollbar device, not a row to read",
    );
  } finally {
    v.close();
  }
});

// The chip lives only in the app build (standalone shows a version badge instead), so this reads the
// markup the app renders rather than booting one.
test("the analysis-status chip announces when semantic analysis becomes ready", () => {
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  const chip = render.split("\n").find((line) => line.includes('id="analysis-status"'));
  assert.ok(chip, "the app build renders an analysis-status chip");
  assert.match(chip, /role="status"/, "it is a status region");
  assert.match(chip, /aria-live="polite"/, "so a phase change is announced when it happens");
});
