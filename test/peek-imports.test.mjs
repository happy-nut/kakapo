import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/util.ts";
const SOURCE = [
  "export function formatBytes(bytes: number): string {",
  "  return String(bytes);",
  "}",
].join("\n");

const IMPORTER = "src/diff.ts";
const IMPORTER_SOURCE = [
  "import { formatBytes, hashText } from './util';",
  "export const label = formatBytes(12);",
].join("\n");

const PHP_FILE = "src/Report.php";
const PHP_SOURCE = [
  "<?php",
  "use App\\Util\\formatBytes;",
  "echo formatBytes(12);",
].join("\n");

let html;

before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export {};\n", after: SOURCE + "\n" },
    { path: IMPORTER, before: "export {};\n", after: IMPORTER_SOURCE + "\n" },
    { path: PHP_FILE, before: "<?php\n", after: PHP_SOURCE + "\n" },
  ], { app: true }));
});
after(cleanupFixtures);

const at = (path, lineIndex, text) => ({
  path,
  lineIndex,
  column: Math.max(0, text.indexOf("formatBytes")),
  text,
  name: "formatBytes",
});

const EMPTY = { ok: true, engine: "index", confidence: "heuristic", locations: [], symbols: [] };

async function showUsages(locations) {
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      if (request.kind !== "references") return EMPTY;
      return { ok: true, engine: "lsp", confidence: "semantic", server: "typescript-language-server", locations };
    },
  });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 0, 16, true, -1);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown",
    { bubbles: true, code: "F7", key: "F7", metaKey: true, altKey: true }));
  await v.settle(120);
  return v;
}

const rows = (v) => v.$all("#semantic-peek-results .semantic-peek-item").map((el) => el.getAttribute("title"));

test("the usages popup does not count the import lines that reach the symbol", async () => {
  const v = await showUsages([
    at(IMPORTER, 0, "import { formatBytes, hashText } from './util';"),
    at(IMPORTER, 1, "export const label = formatBytes(12);"),
    at(FILE, 0, "export function formatBytes(bytes: number): string {"),
  ]);
  assert.deepEqual(rows(v), ["src/diff.ts:2"],
    "naming a symbol in an import is how a file reaches it, not a place that uses it");
  v.close();
});

test("the import line is read as one in every language, not only in the ones with the word import",
  async () => {
    const v = await showUsages([
      at(PHP_FILE, 1, "use App\\Util\\formatBytes;"),
      at(PHP_FILE, 2, "echo formatBytes(12);"),
    ]);
    assert.deepEqual(rows(v), ["src/Report.php:3"], "PHP's `use` is an import and classifyUsage says so");
    v.close();
  });

test("a symbol whose every usage is an import still shows them, rather than reading as nowhere to go",
  async () => {
    const v = await showUsages([
      at(IMPORTER, 0, "import { formatBytes, hashText } from './util';"),
      at(PHP_FILE, 1, "use App\\Util\\formatBytes;"),
    ]);
    assert.deepEqual(rows(v), ["src/diff.ts:1", "src/Report.php:2"],
      "an empty list here would say the symbol is unused, which is a different and false answer");
    v.close();
  });
