// Navigating by structure: what a file's symbols are, and where a type is declared.
//
// Two layers are guarded here, and the split is deliberate. Normalizing the language server's answer is a
// pure function over two different wire shapes, so it is tested as one. Everything above it — which engine
// answered, what happens without a server, what a revision does — goes through ProjectAnalysis, because
// that is where "the popup was empty" would actually come from.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { lspSymbolKindName, normalizeDocumentSymbols } from "../dist/lsp.js";

const dirs = [];
function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-navigation-"));
  dirs.push(root);
  return root;
}
function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test("a hierarchical documentSymbol answer flattens in reading order, with depth", () => {
  const symbols = normalizeDocumentSymbols([
    {
      name: "Store",
      kind: 5,
      detail: "class Store",
      range: { start: { line: 2, character: 0 }, end: { line: 20, character: 1 } },
      selectionRange: { start: { line: 2, character: 13 } },
      children: [
        {
          name: "load",
          kind: 6,
          range: { start: { line: 4, character: 2 }, end: { line: 9, character: 3 } },
          selectionRange: { start: { line: 4, character: 2 } },
          children: [
            {
              name: "inner",
              kind: 12,
              range: { start: { line: 5, character: 4 }, end: { line: 7, character: 5 } },
              selectionRange: { start: { line: 5, character: 10 } },
            },
          ],
        },
      ],
    },
    {
      name: "helper",
      kind: 12,
      range: { start: { line: 22, character: 0 }, end: { line: 24, character: 1 } },
      selectionRange: { start: { line: 22, character: 9 } },
    },
  ]);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.kind, symbol.depth, symbol.lineIndex, symbol.endLineIndex]), [
    ["Store", "class", 0, 2, 20],
    ["load", "method", 1, 4, 9],
    ["inner", "function", 2, 5, 7],
    ["helper", "function", 0, 22, 24],
  ]);
  assert.equal(symbols[0].detail, "class Store", "the server's own summary comes along when it offers one");
  assert.equal(symbols[0].column, 13, "a jump lands on the NAME (selectionRange), not on the line's first column");
  assert.equal(symbols[3].detail, undefined, "and is absent rather than empty when it does not");
});

test("the flat SymbolInformation shape gets its nesting and order derived", () => {
  // Shaped like what typescript-language-server actually answers with: no children, no detail, a
  // containerName string, every symbol at the top level, and NOT in line order.
  const symbols = normalizeDocumentSymbols([
    { name: "makeStore", kind: 12, location: { range: { start: { line: 15, character: 16 }, end: { line: 17, character: 1 } } } },
    { name: "Store", kind: 5, location: { range: { start: { line: 2, character: 13 }, end: { line: 13, character: 1 } } } },
    { name: "bump", kind: 6, containerName: "Store", location: { range: { start: { line: 9, character: 2 }, end: { line: 12, character: 3 } } } },
    { name: "run", kind: 6, containerName: "Store", location: { range: { start: { line: 5, character: 2 }, end: { line: 7, character: 3 } } } },
  ]);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.depth, symbol.lineIndex]), [
    ["Store", 0, 2],
    ["run", 1, 5],
    ["bump", 1, 9],
    ["makeStore", 0, 15],
  ], "line order, and nesting from range containment — the reply carries neither");
});

test("two symbols spanning the same lines do not nest inside each other", () => {
  const symbols = normalizeDocumentSymbols([
    { name: "outer", kind: 5, location: { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 30 } } } },
    { name: "inner", kind: 12, location: { range: { start: { line: 4, character: 10 }, end: { line: 4, character: 20 } } } },
  ]);
  assert.deepEqual(symbols.map((symbol) => symbol.depth), [0, 0],
    "one of them would otherwise be reported as inside itself");
});

test("a malformed or empty answer is an empty structure, not a crash", () => {
  assert.deepEqual(normalizeDocumentSymbols(null), []);
  assert.deepEqual(normalizeDocumentSymbols({}), []);
  assert.deepEqual(normalizeDocumentSymbols([{ kind: 5 }]), [], "a symbol with no name is not one");
  const degenerate = normalizeDocumentSymbols([{ name: "x", kind: 99, range: {} }]);
  assert.deepEqual(degenerate, [{
    name: "x", detail: undefined, container: undefined, kind: "symbol",
    lineIndex: 0, column: 0, endLineIndex: 0, depth: 0,
  }]);
});

test("every LSP symbol kind has a name, and an unknown one is not a blank", () => {
  assert.equal(lspSymbolKindName(5), "class");
  assert.equal(lspSymbolKindName(12), "function");
  assert.equal(lspSymbolKindName(22), "enum-member");
  assert.equal(lspSymbolKindName(26), "type-parameter");
  assert.equal(lspSymbolKindName(0), "symbol");
  assert.equal(lspSymbolKindName(undefined), "symbol");
  assert.equal(lspSymbolKindName(999), "symbol");
});

test("without a language server, a file's structure still comes from the index", async () => {
  const root = tempProject();
  const files = [{
    path: "src/worker.py",
    content: [
      "import os",
      "",
      "class Worker:",
      "    def execute(self):",
      "        return True",
      "",
      "def helper():",
      "    return 1",
      "",
    ].join("\n"),
  }];
  write(root, files[0].path, files[0].content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  const structure = await analysis.query({ kind: "documentSymbol", path: "src/worker.py" });
  assert.equal(structure.ok, true);
  assert.equal(structure.engine, "index");
  assert.equal(structure.confidence, "heuristic", "a name scan is heuristic, and says so");
  const named = structure.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.lineIndex]);
  assert.deepEqual(named, [["Worker", "class", 2], ["execute", "method", 3], ["helper", "function", 6]],
    "in the order the file reads, which is what a structure list is for");
  assert.equal(structure.symbols[1].depth, 1, "a method inside a class is indented one level");
  assert.equal(structure.symbols[2].depth, 0);
  assert.ok(structure.fallbackReason, "and it says why the server did not answer");
});

test("a file the index has never seen answers empty rather than inventing a structure", async () => {
  const root = tempProject();
  const analysis = new ProjectAnalysis(root, { files: [], resolveServer: () => undefined });
  const structure = await analysis.query({ kind: "documentSymbol", path: "src/missing.ts" });
  assert.equal(structure.ok, true);
  assert.deepEqual(structure.symbols, []);
});

test("documentSymbol requires a path, and says so instead of answering about nothing", async () => {
  const root = tempProject();
  const analysis = new ProjectAnalysis(root, { files: [], resolveServer: () => undefined });
  const structure = await analysis.query({ kind: "documentSymbol" });
  assert.equal(structure.ok, false);
  assert.match(structure.error, /source path is required/);
});

test("Go to Type Declaration falls back to the declarations the index knows", async () => {
  const root = tempProject();
  const files = [
    { path: "src/store.ts", content: "export interface Store {\n  load(): void;\n}\n" },
    { path: "src/use.ts", content: 'import { Store } from "./store";\n\nconst store: Store = make();\n' },
  ];
  for (const file of files) write(root, file.path, file.content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  const type = await analysis.query({ kind: "typeDefinition", path: "src/use.ts", line: 2, column: 13, symbol: "Store" });
  assert.equal(type.ok, true);
  assert.deepEqual(type.locations.map((item) => [item.path, item.lineIndex]), [["src/store.ts", 0]]);
  assert.equal(type.engine, "index", "with no server it is the name index answering, graded heuristic");
});

// ---- the two hierarchies ---------------------------------------------------------------------------
// Without a language server these are read off declaration TEXT, which is a heuristic and says so. What
// is guarded here is that the heuristic answers at all for the languages whose syntax carries the
// relationship on the line, and that the one direction it cannot do declines by name instead of
// answering "nothing".

test("supertypes and subtypes are read off the declaration line when no server can answer", async () => {
  const root = tempProject();
  const files = [
    { path: "src/base.ts", content: "export abstract class Base {\n  run(): void {}\n}\n" },
    { path: "src/mixin.ts", content: "export interface Loggable {\n  log(): void;\n}\n" },
    { path: "src/child.ts", content: "import { Base } from './base';\nexport class Child extends Base implements Loggable {\n  log() {}\n}\n" },
    { path: "src/worker.py", content: "class Worker(Base):\n    def run(self):\n        return 1\n" },
  ];
  for (const file of files) write(root, file.path, file.content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  const supers = await analysis.query({ kind: "supertypes", path: "src/child.ts", line: 1, column: 20, symbol: "Child" });
  assert.equal(supers.engine, "index");
  assert.equal(supers.confidence, "heuristic");
  const superPaths = supers.locations.map((item) => item.path).sort();
  assert.deepEqual(superPaths, ["src/base.ts", "src/mixin.ts"],
    "both what it extends and what it implements are supertypes");

  const subs = await analysis.query({ kind: "subtypes", path: "src/base.ts", line: 0, column: 22, symbol: "Base" });
  const subPaths = subs.locations.map((item) => item.path).sort();
  assert.deepEqual(subPaths, ["src/child.ts", "src/worker.py"],
    "a Python `class Worker(Base):` is a subtype too — the relationship is on the line in both languages");
});

test("a subtype search does not report the type as its own subtype", async () => {
  const root = tempProject();
  const files = [{ path: "src/a.ts", content: "export class Alone {\n  make(): Alone { return this; }\n}\n" }];
  write(root, files[0].path, files[0].content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });
  const subs = await analysis.query({ kind: "subtypes", path: "src/a.ts", line: 0, column: 13, symbol: "Alone" });
  assert.deepEqual(subs.locations, []);
});

test("callers fall back to references; callees decline by name rather than answering nothing", async () => {
  const root = tempProject();
  const files = [
    { path: "src/lib.ts", content: "export function target() {\n  return helper();\n}\nexport function helper() { return 1; }\n" },
    { path: "src/call.ts", content: "import { target } from './lib';\nexport function run() {\n  return target();\n}\n" },
  ];
  for (const file of files) write(root, file.path, file.content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  const callers = await analysis.query({ kind: "callers", path: "src/lib.ts", line: 0, column: 16, symbol: "target" });
  assert.equal(callers.engine, "index");
  assert.ok(callers.locations.some((item) => item.path === "src/call.ts"), "the call site is found as a reference");

  const callees = await analysis.query({ kind: "callees", path: "src/lib.ts", line: 0, column: 16, symbol: "target" });
  assert.deepEqual(callees.locations, []);
  assert.match(callees.fallbackReason, /cannot tell a call from a mention/,
    "an empty list with no reason is how a reader concludes the function calls nothing");
});

// ---- shapes real servers actually send --------------------------------------------------------------
// Each of these was measured against the bundled server named in it, and each one is a bug this suite
// did not catch until the server was asked (scripts/navigation-smoke.mjs and the probe behind it).

test("a server that reports NAME-only ranges still gets nesting, from containerName", () => {
  // Eclipse JDT LS: every symbol's location.range covers its name, not its body, so containment finds
  // nothing and a Java class and its methods looked like siblings.
  const symbols = normalizeDocumentSymbols([
    { name: "Store", kind: 5, location: { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } } },
    { name: "run()", kind: 6, containerName: "Store", location: { range: { start: { line: 1, character: 13 }, end: { line: 1, character: 16 } } } },
    { name: "bump()", kind: 6, containerName: "Store", location: { range: { start: { line: 5, character: 13 }, end: { line: 5, character: 17 } } } },
  ]);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.depth]), [["Store", 0], ["run()", 1], ["bump()", 1]]);
});

test("containerName is only a fallback: it never overrides what the ranges say", () => {
  // A container in another file (which containerName may name) must not nest anything when the ranges
  // in THIS file already describe the structure.
  const symbols = normalizeDocumentSymbols([
    { name: "Outer", kind: 5, range: { start: { line: 0, character: 6 }, end: { line: 9, character: 1 } }, selectionRange: { start: { line: 0, character: 6 } } },
    { name: "inner", kind: 6, containerName: "SomethingElse", range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } }, selectionRange: { start: { line: 2, character: 2 } } },
  ]);
  assert.deepEqual(symbols.map((symbol) => symbol.depth), [0, 1], "containment answered, so containerName is not consulted");
});

test("Rust types are indexed, and `impl Trait for Type` is read as the relationship it is", async () => {
  const root = tempProject();
  const files = [{
    path: "src/lib.rs",
    content: [
      "pub trait Runnable {",
      "    fn run(&self) -> i32;",
      "}",
      "",
      "pub struct Store;",
      "",
      "impl Runnable for Store {",
      "    fn run(&self) -> i32 {",
      "        1",
      "    }",
      "}",
      "",
    ].join("\n"),
  }];
  write(root, files[0].path, files[0].content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  // `pub` was missing from the index's modifier list, so neither of these was indexed at all.
  const definition = await analysis.query({ kind: "definition", path: "src/lib.rs", line: 6, column: 22, symbol: "Store" });
  assert.deepEqual(definition.locations.map((item) => item.lineIndex), [4], "`pub struct Store` is a declaration");

  // rust-analyzer offers no type hierarchy, so this is the path Rust actually takes.
  const supers = await analysis.query({ kind: "supertypes", path: "src/lib.rs", line: 4, column: 11, symbol: "Store" });
  assert.deepEqual(supers.locations.map((item) => item.lineIndex), [0], "the trait it implements, from the impl block");
  const subs = await analysis.query({ kind: "subtypes", path: "src/lib.rs", line: 0, column: 10, symbol: "Runnable" });
  assert.deepEqual(subs.locations.map((item) => item.lineIndex), [4], "and back the other way");
});
