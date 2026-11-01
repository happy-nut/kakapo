// Code Vision and inlay hints were painted by a JUMP into a file and by flipping one of their own
// switches — and by nothing else. Opening a file asked for neither, so a reader who clicked a file in the
// tree saw neither, in any language. Measured in the real app: twelve seconds after a Go file was on
// screen the decoration cache was still empty and nothing was drawn, while one hand-called repaint drew
// the two hints and, in the TypeScript file beside it, four reference lenses.
//
// The other half is timing. A file opened while its server is still starting is told, honestly, that
// nothing can judge it yet, and neither cache asks a second time — so the answers arrive and nobody is
// listening. The transition into "ready" is where that is worth asking again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

const FILE = "src/app.ts";
const AFTER = ["const total = 1;", "const label = 'two';", "const sum = total;", ""].join("\n");

/** The analyzer has already moved to generation 2 while the page still believes it is on 1. */
function bridgeAtGeneration(generation) {
  return (request) => {
    if (request.kind === "inlayHint") {
      return {
        ok: true, generation, engine: "lsp", confidence: "semantic", locations: [],
        hints: [{ lineIndex: 0, column: 11, label: ": number", kind: "type", paddingLeft: false, paddingRight: false }],
      };
    }
    if (request.kind === "codeLens") {
      return {
        ok: true, generation, engine: "lsp", confidence: "semantic", locations: [],
        lenses: [{ lineIndex: 0, title: "2 references" }],
      };
    }
    return { ok: true, generation, engine: "lsp", confidence: "semantic", locations: [] };
  };
}

async function openAtGenerationOne() {
  const { html } = await makeReviewHtml([{ path: FILE, before: "const total = 1;\n", after: AFTER }]);
  const v = await loadViewer(html, {
    analysisBridge: bridgeAtGeneration(2),
    analysisStatus: { generation: 1, phase: "indexing", updatedAt: new Date(1000).toISOString() },
  });
  await v.openSourceFile(FILE);
  await v.settle(120);
  return v;
}

test("opening a file draws its hints and lenses, without a jump or a switch", async () => {
  const { html } = await makeReviewHtml([{ path: FILE, before: "const total = 1;\n", after: AFTER }]);
  const v = await loadViewer(html, {
    analysisBridge: bridgeAtGeneration(0),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(1000).toISOString() },
  });
  await v.openSourceFile(FILE);
  await v.settle(150);
  const body = v.$("#source-body");
  assert.equal(body.querySelectorAll(".inlay-hint").length, 1, "the inferred type is drawn on the line it belongs to");
  assert.equal(body.querySelectorAll(".code-vision-row").length, 1, "and the lens sits above the declaration");
  v.close();
});

test("a file opened before its server could answer is asked again once the analyzer is ready", async () => {
  // While a server is starting the analyzer answers from the index, which has no hints and no lenses to
  // give — and the decoration cache drops that non-answer rather than remembering it as "this file has
  // none". Nothing a reader does asks again, so without the repaint below the file stays bare.
  // `app: true`: the analysis status chip is an Electron-only element, and it is what reports the
  // transition this test is about — a standalone review has no chip and no transition to report.
  const { html } = await makeReviewHtml([{ path: FILE, before: "const total = 1;\n", after: AFTER }], { app: true });
  let serverAnswering = false;
  const withServer = bridgeAtGeneration(0);
  const v = await loadViewer(html, {
    analysisBridge: (request) => (serverAnswering
      ? withServer(request)
      : { ok: true, generation: 0, engine: "index", confidence: "heuristic", locations: [], fallbackReason: "still starting" }),
    analysisStatus: { generation: 0, phase: "indexing", updatedAt: new Date(1000).toISOString() },
  });
  // The analyzer reports itself while the file is open, the way it does in the app.
  v.window.__analysisStatusCb({ generation: 0, phase: "indexing", updatedAt: new Date(1500).toISOString() });
  await v.openSourceFile(FILE);
  await v.settle(150);
  const body = v.$("#source-body");
  assert.equal(body.querySelectorAll(".inlay-hint").length, 0, "the index had nothing to draw");
  assert.equal(body.querySelectorAll(".code-vision-row").length, 0);

  serverAnswering = true;
  v.window.__analysisStatusCb({ generation: 0, phase: "ready", updatedAt: new Date(2000).toISOString() });
  await v.settle(150);
  assert.equal(body.querySelectorAll(".inlay-hint").length, 1, "the hint arrives when the server does");
  assert.equal(body.querySelectorAll(".code-vision-row").length, 1, "and so does the lens");
  v.close();
});

test("a status report that is not a transition into ready repaints nothing", async () => {
  // The analyzer re-reports its status on a timer; a repaint per report would re-ask for every open file
  // several times a minute, and each ask is a round trip to a language server.
  const v = await openAtGenerationOne();
  const asked = [];
  const inner = bridgeAtGeneration(2);
  v.window.kakapoAnalysis.query = (request) => { asked.push(request.kind); return Promise.resolve(inner(request)); };
  v.window.__analysisStatusCb({ generation: 1, phase: "indexing", updatedAt: new Date(3000).toISOString() });
  await v.settle(80);
  assert.deepEqual(asked, [], "still indexing, reported again, asks nothing again");
  v.close();
});

// Two hints on ONE line, which is the ordinary shape for a parameter and a return type.
//
// The offsets are positions in the LINE, and the walk that finds them counted the labels it had already
// inserted. So the second hint landed as many characters late as the first label was long — and the walk
// descended INTO that label, so it nested there as well: `(who: any): string` came out as
// `(who  : string: any)`. On a minified line carrying 1200 hints the drift ran to hundreds of characters
// and the labels landed mid-identifier, cutting `function` in half.
//
// The rendered TEXT is what is asserted, not the count or the order of the spans: the defect was visible
// to the reader as the wrong characters in the wrong places, and a test on the span list would have been
// green for `(who  : string: any)` too.
const SIGNATURE = ["export function greet(who) {", "  return who;", "}", ""].join("\n");

function twoHintBridge(request) {
  const base = { ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] };
  if (request.kind === "inlayHint") {
    return {
      ...base,
      hints: [
        // `(who` ends at column 25, `)` at 26 — a parameter type and a return type, in the order a server
        // sends them, which is ascending and is exactly the order that used to go wrong.
        { lineIndex: 0, column: 25, label: ": any", kind: "type", paddingLeft: false, paddingRight: false },
        { lineIndex: 0, column: 26, label: ": string", kind: "type", paddingLeft: false, paddingRight: false },
      ],
    };
  }
  if (request.kind === "codeLens") return { ...base, lenses: [] };
  return { ...base, hints: [], lenses: [] };
}

test("two hints on one line land where the server put them, and neither is inside the other", async () => {
  const { html } = await makeReviewHtml([{ path: FILE, before: "export function greet(who) {\n", after: SIGNATURE }]);
  const v = await loadViewer(html, {
    analysisBridge: twoHintBridge,
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(1000).toISOString() },
  });
  try {
    await v.openSourceFile(FILE);
    await v.settle(150);
    const cell = v.$("#source-body .source-row[data-line-index='0'] .source-code");
    assert.equal(cell.textContent, "export function greet(who: any): string {",
      "the line reads as the server described it");
    const hints = Array.from(cell.querySelectorAll(".inlay-hint"));
    assert.equal(hints.length, 2, "both hints are drawn");
    assert.ok(!hints.some((hint) => hint.parentNode.closest(".inlay-hint")),
      "and neither label is nested inside the other");
  } finally {
    v.close();
  }
});

// A lens row is inserted ABOVE the line it annotates, so a line carrying many declarations — every line of
// a minified file is one — put a screenful of rows between the reader and the code. 300 identical
// "0 references" rows, the first source row at y=5762. One row per line, listing what fits and counting
// the rest.
test("declarations that share a line share one lens row", async () => {
  const titles = Array.from({ length: 12 }, (_, i) => `${i} references`);
  const { html } = await makeReviewHtml([{ path: FILE, before: "export function greet(who) {\n", after: SIGNATURE }]);
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      const base = { ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] };
      if (request.kind === "codeLens") return { ...base, lenses: titles.map((title) => ({ lineIndex: 0, title })) };
      return { ...base, hints: [], lenses: [] };
    },
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(1000).toISOString() },
  });
  try {
    await v.openSourceFile(FILE);
    await v.settle(150);
    const rows = v.$all("#source-body .code-vision-row");
    assert.equal(rows.length, 1, "twelve declarations on one line get one row, not twelve");
    const text = rows[0].textContent;
    assert.ok(text.includes("0 references") && text.includes("2 references"), "it names the first few");
    assert.ok(!text.includes("11 references"), "it stops rather than listing all twelve");
    assert.match(text, /\b9\b/, "and says how many it left out — twelve less the three it named");
  } finally {
    v.close();
  }
});
