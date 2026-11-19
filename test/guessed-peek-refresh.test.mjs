import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const SOURCE = [
  "export class Store {",
  "  load() {",
  "    return Store;",
  "  }",
  "}",
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" }], { app: true }));
});
after(cleanupFixtures);

const at = (lineIndex, text) => ({ path: FILE, lineIndex, column: Math.max(0, text.indexOf("Store")), text, name: "Store" });

const GUESSED = {
  ok: true,
  engine: "index",
  confidence: "heuristic",
  fallbackReason: "Still indexing",
  locations: [at(1, "  load() {"), at(2, "    return Store;")],
};
const SEMANTIC = {
  ok: true,
  engine: "lsp",
  confidence: "semantic",
  server: "typescript-language-server",
  locations: [at(0, "export class Store {")],
};

const EMPTY = { ok: true, engine: "index", confidence: "heuristic", locations: [], symbols: [] };

async function openPeekWhileIndexing(answers) {
  const asked = [];
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      if (request.kind !== "definition") return EMPTY;
      asked.push(request.kind);
      return answers.shift() ?? SEMANTIC;
    },
    analysisStatus: { generation: 0, phase: "indexing", updatedAt: new Date(0).toISOString() },
  });
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "indexing", updatedAt: new Date(0).toISOString() });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 2, 11, true, -1);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyB", key: "b", metaKey: true }));
  await v.settle(120);
  return { v, asked };
}

const peekOpen = (v) => {
  const panel = v.document.getElementById("semantic-peek");
  return Boolean(panel) && !panel.classList.contains("hidden");
};
const peekRows = (v) => v.$all("#semantic-peek-results .semantic-peek-item").map((el) => el.getAttribute("title"));
const peekMeta = (v) => (v.document.getElementById("semantic-peek-meta") || { textContent: "" }).textContent;

async function becomeReady(v) {
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "ready", updatedAt: new Date(1).toISOString() });
  await v.settle(150);
}

test("the guess really is what ⌘B shows while the index is all there is", async () => {
  const { v } = await openPeekWhileIndexing([GUESSED]);
  assert.ok(peekOpen(v), "a guessed answer with more than one candidate opens the peek");
  assert.deepEqual(peekRows(v), ["src/store.ts:2", "src/store.ts:3"],
    "both guessed candidates are listed, which is the state the report describes");
  assert.match(peekMeta(v), /heuristic/, "and the meta line says the answer is a guess");
});

test("when the server is ready the guess is replaced by what the server says", async () => {
  const { v, asked } = await openPeekWhileIndexing([GUESSED]);
  const before = asked.length;
  await becomeReady(v);
  assert.ok(asked.length > before, "becoming ready re-asks the question the guess answered");
  assert.ok(peekOpen(v), "the peek stays open rather than vanishing under the reader");
  assert.deepEqual(peekRows(v), ["src/store.ts:1"], "it now lists the declaration the server found");
  assert.match(peekMeta(v), /semantic/, "and says so, so the reader can tell the answer changed");
});

test("a peek the reader already closed is not reopened when the server becomes ready", async () => {
  const { v } = await openPeekWhileIndexing([GUESSED]);
  v.window.closeSemanticPeek();
  await v.settle(20);
  await becomeReady(v);
  assert.equal(peekOpen(v), false, "closing the peek withdraws the question with it");
});

test("a peek built from the server's own answer is not re-asked", async () => {
  const { v, asked } = await openPeekWhileIndexing([{ ...SEMANTIC, locations: GUESSED.locations }]);
  assert.ok(peekOpen(v), "two semantic candidates open the peek too");
  const before = asked.length;
  await becomeReady(v);
  assert.equal(asked.length, before, "there is nothing to improve on, so nothing is asked again");
  assert.deepEqual(peekRows(v), ["src/store.ts:2", "src/store.ts:3"], "and the list is left alone");
});

test("a guess the server cannot improve on closes with the failure it reports", async () => {
  const { v } = await openPeekWhileIndexing([GUESSED, { ...SEMANTIC, locations: [], noServer: true }]);
  assert.ok(peekOpen(v), "the guess opened the peek");
  await becomeReady(v);
  assert.equal(peekOpen(v), false, "an empty semantic answer is not left looking like a result");
});

test("a peek opened by a later answer does not inherit an earlier guess", async () => {
  const { v, asked } = await openPeekWhileIndexing([GUESSED]);
  v.window.closeSemanticPeek();
  await v.settle(20);
  v.window.openAnalysisUsages("Store", GUESSED.locations, null, "related");
  await v.settle(40);
  assert.ok(peekOpen(v), "a peek with no response of its own still opens");
  const before = asked.length;
  await becomeReady(v);
  assert.equal(asked.length, before,
    "the guessed question belonged to the answer that produced it, not to whatever peek is open now");
});
