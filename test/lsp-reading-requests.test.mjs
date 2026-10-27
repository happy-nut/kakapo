// The two LSP requests kakapo never made, now that it does: `textDocument/foldingRange` behind folding and
// `textDocument/documentHighlight` behind the in-file highlight. Both are LAZY upgrades — the keystroke is
// answered from what the page already has (brace pairs, a regex scan) and the server's answer replaces it
// when it arrives — so what is asserted is that the question is asked, that the answer is used, and that a
// server which cannot answer leaves the old behaviour alone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/one.ts";
// Python-shaped on purpose: not a brace in it, so the brace walk finds nothing and every fold below can
// only have come from the server. This is the case that had no folding at all before.
const BODY = [
  "import os",
  "import sys",
  "",
  "def outer():",
  "    if os.sep:",
  "        return sys.path",
  "    return []",
  "",
  "value = outer()",
  "",
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([{ path: FILE, before: BODY, after: BODY }]));
});
after(cleanupFixtures);

/** A viewer whose analysis bridge records what was asked and answers from `answers[kind]`. */
async function openHost(answers) {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoAnalysis = {
    query: (request) => {
      asked.push(request);
      return Promise.resolve(Object.assign({
        ok: true, engine: "lsp", server: "pyright", confidence: "semantic", locations: [], symbols: [],
      }, answers[request.kind] || {}));
    },
    status: () => Promise.resolve({ generation: 0 }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return { v, asked };
}

test("a braceless file asks for folding ranges and folds on the server's answer", async () => {
  const { v, asked } = await openHost({
    foldingRange: { folds: [{ startLine: 3, endLine: 6, kind: "" }, { startLine: 4, endLine: 5, kind: "" }] },
  });
  v.window.setSourceCursor(FILE, 5, 8, false, -1);
  await v.settle(40);
  assert.ok(asked.some((r) => r.kind === "foldingRange" && r.path === FILE),
    `foldingRange was never asked for: ${asked.map((r) => r.kind).join(", ")}`);

  // ⌘. folds the INNERMOST region the caret is in. The server sends its ranges outermost-first, so a
  // reader of [0] would fold `def outer` instead of the `if` — the ordering trap this guards.
  v.key(".", { metaKey: true, code: "Period" });
  await v.settle(60);
  const folded = v.$all("#source-body [data-source-fold]").map((b) => b.dataset.foldStart ?? b.dataset.sourceFold);
  assert.ok(v.$("#source-body [data-source-fold]"), `nothing folded; buttons: ${JSON.stringify(folded)}`);
  const rows = v.$all("#source-body .source-row[data-line-index]").map((r) => Number(r.dataset.lineIndex));
  assert.ok(rows.includes(3), "the def line is still there — the innermost fold was the `if`, not the whole function");
  assert.ok(!rows.includes(5), "and the line inside the `if` is folded away");
  v.close();
});

test("a server with no folding ranges leaves the brace walk in charge", async () => {
  const { v, asked } = await openHost({ foldingRange: { fallbackReason: "pyright does not implement folding ranges" } });
  v.window.setSourceCursor(FILE, 5, 8, false, -1);
  await v.settle(40);
  assert.ok(asked.some((r) => r.kind === "foldingRange"), "it still asks");
  // The brace walk finds nothing in a braceless file, so ⌘. has no region to fold and must decline rather
  // than fold something arbitrary. (The import block above is folded by findImportRange, which is this
  // app's own and not a candidate — so row counts are not what distinguishes the two cases.)
  v.key(".", { metaKey: true, code: "Period" });
  await v.settle(40);
  const rows = v.$all("#source-body .source-row[data-line-index]").map((r) => Number(r.dataset.lineIndex));
  assert.ok(rows.includes(5), "the line the caret was on is still a row — nothing was folded over it");
  assert.ok(rows.includes(3) && rows.includes(6), "and neither end of the function went away");
  v.close();
});

test("⌘F7 answers at once, then takes the server's read/write labels when they land", async () => {
  const { v, asked } = await openHost({
    documentHighlight: {
      highlights: [
        { lineIndex: 3, startColumn: 4, endColumn: 9, kind: "write" },
        { lineIndex: 8, startColumn: 8, endColumn: 13, kind: "read" },
      ],
    },
  });
  v.window.setSourceCursor(FILE, 8, 9, false, -1); // on `outer()` in `value = outer()`
  await v.settle(20);
  v.key("F7", { metaKey: true, code: "F7" });
  await v.settle(80);
  assert.ok(asked.some((r) => r.kind === "documentHighlight" && r.path === FILE),
    `documentHighlight was never asked for: ${asked.map((r) => r.kind).join(", ")}`);
  // The hint names the counts, and the write count is the server's — the regex scan calls neither of
  // these a write, so a "1" here could not have come from it.
  const hint = v.window.document.querySelector(".mc-caret-hint");
  assert.ok(hint, "the hint that names the counts is up");
  assert.match(hint.textContent, /1/, `the server's one write is counted: ${hint.textContent}`);
  v.close();
});

test("the server's own tokens colour the line, and a line it says nothing about keeps the hand tokenizer", async () => {
  const { v, asked } = await openHost({
    semanticTokens: {
      tokens: [
        // `def outer():` — the hand tokenizer has no Python keywords, so a tok-keyword on line 3 could
        // only have come from the server.
        { lineIndex: 3, startColumn: 0, length: 3, type: "keyword" },
        { lineIndex: 3, startColumn: 4, length: 5, type: "function" },
      ],
    },
  });
  await v.settle(60);
  assert.ok(asked.some((r) => r.kind === "semanticTokens" && r.path === FILE),
    `semanticTokens was never asked for: ${asked.map((r) => r.kind).join(", ")}`);
  const row = v.$(`#source-body .source-row[data-line-index="3"] .source-code`);
  assert.ok(row, "the def line is rendered");
  assert.ok(row.querySelector(".tok-keyword"), `no server token drawn: ${row.innerHTML}`);
  assert.ok(row.querySelector(".tok-function"), `the function name is not coloured: ${row.innerHTML}`);
  // Every character is still there exactly once: the caret and the whitespace marker both count columns
  // in this text, so a dropped or doubled character is a navigation bug, not a colour one.
  assert.equal(row.textContent, "def outer():");
  v.close();
});

test("overlapping tokens are dropped, not nested — the text must stay the text", async () => {
  const { v } = await openHost({
    semanticTokens: {
      tokens: [
        { lineIndex: 3, startColumn: 0, length: 12, type: "keyword" },
        { lineIndex: 3, startColumn: 4, length: 5, type: "function" }, // inside the one above
      ],
    },
  });
  await v.settle(60);
  const row = v.$(`#source-body .source-row[data-line-index="3"] .source-code`);
  assert.equal(row.textContent, "def outer():", "the line reads the same whatever the server sent");
  assert.equal(row.querySelectorAll(".tok-function").length, 0, "the overlapping token was dropped");
  v.close();
});
