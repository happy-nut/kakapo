import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

const FILE = "src/app.ts";
const AFTER = ["const total = 1;", "const label = 'two';", "const sum = total;", ""].join("\n");

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
  const { html } = await makeReviewHtml([{ path: FILE, before: "const total = 1;\n", after: AFTER }], { app: true });
  let serverAnswering = false;
  const withServer = bridgeAtGeneration(0);
  const v = await loadViewer(html, {
    analysisBridge: (request) => (serverAnswering
      ? withServer(request)
      : { ok: true, generation: 0, engine: "index", confidence: "heuristic", locations: [], fallbackReason: "still starting" }),
    analysisStatus: { generation: 0, phase: "indexing", updatedAt: new Date(1000).toISOString() },
  });
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
  const v = await openAtGenerationOne();
  const asked = [];
  const inner = bridgeAtGeneration(2);
  v.window.kakapoAnalysis.query = (request) => { asked.push(request.kind); return Promise.resolve(inner(request)); };
  v.window.__analysisStatusCb({ generation: 1, phase: "indexing", updatedAt: new Date(3000).toISOString() });
  await v.settle(80);
  assert.deepEqual(asked, [], "still indexing, reported again, asks nothing again");
  v.close();
});

const SIGNATURE = ["export function greet(who) {", "  return who;", "}", ""].join("\n");

function twoHintBridge(request) {
  const base = { ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] };
  if (request.kind === "inlayHint") {
    return {
      ...base,
      hints: [
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
