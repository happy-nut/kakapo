// IntelliJ's code analysis actions: Quick Documentation (F1), Expression Type (⌘⇧P), Show Error
// Description (⌘F1) and the Problems view (⌘6).
//
// Two layers. `normalizeHoverResult` is a pure function over three different wire shapes — servers in the
// bundle use all three — so it is tested as one against dist/. Everything above it goes through the viewer
// with the analysis bridge stubbed, because "the panel was empty" is a thing the page does, not the server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeHoverResult } from "../dist/lsp.js";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

// ---- the wire shapes -----------------------------------------------------------------------------

test("hover accepts all three shapes a server may answer with", () => {
  assert.equal(
    normalizeHoverResult({ contents: { kind: "markdown", value: "**Store**\nholds things" } }),
    "**Store**\nholds things",
    "MarkupContent: the current shape, passed through",
  );
  assert.equal(
    normalizeHoverResult({ contents: { language: "typescript", value: "class Store" } }),
    "```typescript\nclass Store\n```",
    "a MarkedString with a language becomes a fenced block — it IS the signature",
  );
  assert.equal(
    normalizeHoverResult({ contents: ["```ts\nclass Store\n```", { kind: "markdown", value: "Holds things." }] }),
    "```ts\nclass Store\n```\n\nHolds things.",
    "a list arrives when the signature and the doc are sent separately",
  );
  // Plaintext is code far more often than prose, and fencing it stops a leading `*` in a C comment from
  // being read as a bullet.
  assert.equal(normalizeHoverResult({ contents: { kind: "plaintext", value: "int x" } }), "```\nint x\n```");
});

test("hover drops what is empty and what is repeated", () => {
  assert.equal(normalizeHoverResult(null), "");
  assert.equal(normalizeHoverResult({}), "");
  assert.equal(normalizeHoverResult({ contents: [" ", { value: "   " }] }), "");
  assert.equal(
    normalizeHoverResult({ contents: ["class Store", "class Store"] }),
    "class Store",
    "tsserver answers the signature and then the same signature inside the doc",
  );
});

// ---- the caret actions and the Problems view ------------------------------------------------------

const FILE = "src/store.ts";
const OTHER = "src/thing.ts";
const SOURCE = ["export class Store {", "  load() {", "    return 1;", "  }", "}"].join("\n");

let html;
before(async () => {
  // `app: true`: Quick Documentation is one of the Electron-only panels (there is no language server to
  // ask in a standalone HTML review), so it is only in the markup when the app review is built.
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" },
    { path: OTHER, before: "export const thing = 1;\n", after: "export const thing = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

const HOVER = "```typescript\nclass Store\n```\n\nHolds the things.";

async function openSource(options = {}) {
  const asked = [];
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      asked.push(request);
      if (request.kind === "hover") {
        return { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: [], hover: options.hover ?? HOVER };
      }
      return { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] };
    },
    diagnosticsBridge: options.diagnostics ?? (() => ({ ok: true, available: true, diagnostics: [] })),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return { v, asked };
}

const press = (host, init) => {
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return host.v.settle(60);
};
const F1 = { code: "F1", key: "F1" };
// The caret hint is a floating element with no anchor in jsdom, so it may land in the toast stack.
const hintText = (host) => host.v.$all(".mc-caret-hint, .mc-toast").map((el) => el.textContent).join(" ");

test("F1 renders what the server says, as the markdown it is", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 0, 13, true, -1); // on `Store`
  await press(host, F1);

  const panel = host.v.$("#quick-doc");
  assert.equal(panel.classList.contains("hidden"), false, "the panel is up");
  assert.equal(host.v.$("#quick-doc-title").textContent, "Store");
  assert.equal(host.v.$("#quick-doc-body pre code").textContent.trim(), "class Store",
    "the fenced signature is a code block, not a paragraph");
  assert.match(host.v.$("#quick-doc-body").textContent, /Holds the things/);
  assert.match(host.v.$("#quick-doc-meta").textContent, /tsserver/, "and it says who answered");

  await press(host, F1);
  assert.equal(host.v.$("#quick-doc").classList.contains("hidden"), true, "the same key again closes it");
  host.v.close();
});

test("Escape closes the documentation panel", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 0, 13, true, -1);
  await press(host, F1);
  assert.equal(host.v.$("#quick-doc").classList.contains("hidden"), false);
  await press(host, { code: "Escape", key: "Escape" });
  assert.equal(host.v.$("#quick-doc").classList.contains("hidden"), true);
  host.v.close();
});

test("F1 with nothing under the caret asks no question at all", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 4, 0, true, -1); // the closing brace
  await press(host, F1);
  assert.equal(host.asked.filter((request) => request.kind === "hover").length, 0);
  assert.equal(host.v.$("#quick-doc").classList.contains("hidden"), true);
  host.v.close();
});

test("⌘⇧P puts the signature on one line, from the same answer", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 0, 13, true, -1);
  await press(host, { code: "KeyP", key: "p", metaKey: true, shiftKey: true });
  assert.match(hintText(host), /class Store/);
  assert.doesNotMatch(hintText(host), /Holds the things/, "the prose is F1's job, not this one's");
  host.v.close();
});

test("⌘⇧P says so when the server has nothing", async () => {
  const host = await openSource({ hover: "" });
  host.v.window.setSourceCursor(FILE, 0, 13, true, -1);
  await press(host, { code: "KeyP", key: "p", metaKey: true, shiftKey: true });
  assert.match(hintText(host), /No type for Store/);
  host.v.close();
});

test("⌘F1 reads out the problem on the caret's line", async () => {
  const host = await openSource({
    diagnostics: (path) => ({
      ok: true,
      available: true,
      diagnostics: path === FILE
        ? [{ lineIndex: 1, column: 2, endLineIndex: 1, endColumn: 6, severity: "error", message: "Property 'load' is declared but never read", source: "ts" }]
        : [],
    }),
  });
  host.v.window.setSourceCursor(FILE, 1, 2, true, -1);
  await host.v.settle(60);
  await press(host, { ...F1, metaKey: true });
  assert.match(hintText(host), /ts: Property 'load' is declared but never read/);

  host.v.window.setSourceCursor(FILE, 2, 4, true, -1);
  await press(host, { ...F1, metaKey: true });
  assert.match(hintText(host), /No problem on this line/);
  host.v.close();
});

// ---- ⌘6 ------------------------------------------------------------------------------------------

const problemRows = (host) => host.v.$all("#quick-open-results .problem-result")
  .map((row) => [row.dataset.severity, row.querySelector(".problem-message").textContent]);

test("⌘6 asks every file in the review and lists what came back, errors first", async () => {
  const host = await openSource({
    diagnostics: (path) => ({
      ok: true,
      available: true,
      diagnostics: path === FILE
        ? [{ lineIndex: 1, column: 2, severity: "warning", message: "unused", source: "ts" }]
        : [{ lineIndex: 0, column: 0, severity: "error", message: "cannot find name", source: "ts" }],
    }),
  });
  await press(host, { code: "Digit6", key: "6", metaKey: true });
  await host.v.settle(120);

  assert.deepEqual(problemRows(host), [["error", "cannot find name"], ["warning", "unused"]],
    "the error sorts above the warning, whichever file it is in");
  assert.ok(host.v.window.__diagnosticsRequests.includes(FILE) && host.v.window.__diagnosticsRequests.includes(OTHER),
    "both files were asked — the point of this view is that it is not the open file");
  assert.match(host.v.$("#quick-open-filter").textContent, /2 problems \(1 errors\) in 2 files/);

  await press(host, { code: "KeyE", key: "e", altKey: true });
  assert.deepEqual(problemRows(host), [["error", "cannot find name"]], "⌥E leaves the errors");
  host.v.close();
});

test("info and hint are collected and not listed, as everywhere else in this app", async () => {
  const host = await openSource({
    diagnostics: () => ({
      ok: true,
      available: true,
      diagnostics: [
        { lineIndex: 0, column: 0, severity: "info", message: "consider renaming", source: "ts" },
        { lineIndex: 1, column: 0, severity: "hint", message: "unreachable", source: "ts" },
      ],
    }),
  });
  await press(host, { code: "Digit6", key: "6", metaKey: true });
  await host.v.settle(120);
  assert.deepEqual(problemRows(host), [],
    "the gutter shows only errors and warnings; a list that disagreed would be a second answer");
  host.v.close();
});

test("a file no server covers is counted, not reported as clean", async () => {
  // USER_FLOWS Flow 6: an empty answer for a file that could not be analysed is the misleading version.
  const host = await openSource({
    diagnostics: (path) => (path === FILE
      ? { ok: true, available: false, diagnostics: [] }
      : { ok: true, available: true, diagnostics: [] }),
  });
  await press(host, { code: "Digit6", key: "6", metaKey: true });
  await host.v.settle(120);
  const results = host.v.$("#quick-open-results").textContent;
  assert.match(results, /No problems in this review/);
  assert.match(results, /1 files have no language server/, "…and why that is not the whole truth");
  assert.match(host.v.$("#quick-open-filter").textContent, /1 not checked/);
  host.v.close();
});

test("⌘6 twice closes the list, as the chord that opened it does everywhere here", async () => {
  const host = await openSource();
  await press(host, { code: "Digit6", key: "6", metaKey: true });
  await host.v.settle(80);
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), false);
  await press(host, { code: "Digit6", key: "6", metaKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), true);
  host.v.close();
});
