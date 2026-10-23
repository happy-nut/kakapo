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

const client = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");

let html;
let bigHtml;
let bigRowCount;
const FILE = "src/app.ts";
const BIG_LINES = 4200;

before(async () => {
  const base = "export function helper() { return 1; }\nexport const used = helper();\n";
  ({ html } = await makeReviewHtml([{ path: FILE, before: base, after: base + "const extra = used;\n" }]));
  const big = Array.from({ length: BIG_LINES }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  const bigAfter = big + "const tail = true;\n";
  // What the source view has to end up showing: one row per line, the trailing empty one included, the way
  // an editor does. Derived from the fixture rather than written out, so it cannot drift away from it.
  bigRowCount = bigAfter.split("\n").length;
  ({ html: bigHtml } = await makeReviewHtml([{ path: "src/big.ts", before: big, after: bigAfter }]));
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

// This used to open the file and assert that a spacer was sitting there. A spacer is not a state a big file
// is in — it is a state a big file is passing through: the chunk filler replaces it on a 16ms timer, and at
// 4200 lines two ticks finish the job. The assertion therefore had about 32ms of real time to win in, which
// it did on a quiet laptop and lost on a loaded CI runner. The invariant it was defending is not transient,
// so neither are the two halves of it below: the stand-in row's markup, and the end state it leads to.
test("the stand-in row for unpainted lines is not read as content", () => {
  const spacer = client.match(/<tr class="source-spacer"[^`]*?>/);
  assert.ok(spacer, "the viewer still stands in for unbuilt rows with a spacer row");
  assert.match(
    spacer[0],
    /aria-hidden="true"/,
    "one blank cell standing for thousands of lines is a scrollbar device, not a row to read",
  );
  // Every spacer comes from that one template, so there is no second way for an audible one to appear.
  assert.equal((client.match(/class="source-spacer"/g) || []).length, 1,
    "and it is written in exactly one place");
});

test("a big file ends up fully built, with no spacer left standing in for anything", async () => {
  const v = await loadViewer(bigHtml, {
    seedSession: {
      "kakapo-diff-ui:/review.html": JSON.stringify({ view: "source", sourcePath: "src/big.ts", tabs: ["src/big.ts"], hash: "" }),
    },
  });
  try {
    // Wait for the filler to finish rather than racing it. Reaching the end state is the property; how many
    // chunk ticks that took is not.
    const deadline = Date.now() + 10_000;
    while (v.$("#source-body .source-spacer") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(v.$("#source-body .source-spacer"), null, "the spacer is a temporary device, not content");
    assert.equal(v.$all("#source-body .source-row").length, bigRowCount,
      "and every line of the file is a real row by the end");
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
