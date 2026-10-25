// The navigation requests asked of a REAL language server.
//
// This file exists because its absence let a bug through. test/navigation.test.mjs checks the normalizer
// against payloads written by hand from the LSP spec, and the hierarchical `DocumentSymbol[]` shape I wrote
// is not what typescript-language-server sends: it answers with the flat `SymbolInformation[]`, every
// symbol at the top level and in an order of its own. The hand-written test passed; the structure popup
// showed a TypeScript file with no nesting and `makeStore` listed before the class declared above it.
//
// So the shapes are derived rather than trusted (see normalizeDocumentSymbols), and the derivation is
// checked here, against the server that actually ships.
//
// The suite already spawns real servers (test/language-server-bundles.test.mjs). This one uses the
// TypeScript server, which comes from node_modules rather than the platform bundle, so it is present
// wherever the package installed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { resolveLanguageServer } from "../dist/lsp.js";

// ONE project and ONE server for the whole file. A language server's cold start is the cost here (a
// fresh tsserver plus its workspace scan is most of a minute), so four tests that each started their own
// turned a check into a reason not to run the suite.
let project = null;

const SOURCES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
    include: ["src"],
  }),
  "src/base.ts": [
    "export interface Loggable {",
    "  log(): void;",
    "}",
    "",
    "export abstract class Base implements Loggable {",
    "  abstract run(): number;",
    "  log(): void {}",
    "}",
    "",
  ].join("\n"),
  "src/store.ts": [
    "import { Base } from './base';",            // 1
    "",                                           // 2
    "export class Store extends Base {",          // 3
    "  private total = 0;",                        // 4
    "",                                           // 5
    "  run(): number {",                           // 6
    "    return this.bump();",                     // 7
    "  }",                                        // 8
    "",                                           // 9
    "  bump(): number {",                          // 10
    "    this.total += 1;",                        // 11
    "    return this.total;",                      // 12
    "  }",                                        // 13
    "}",                                          // 14
    "",                                           // 15
    "export function makeStore(): Store {",        // 16
    "  return new Store();",                       // 17
    "}",                                          // 18
    "",
  ].join("\n"),
  "src/use.ts": [
    "import { makeStore } from './store';",       // 1
    "",                                           // 2
    "export function boot(): number {",            // 3
    "  const store = makeStore();",                // 4
    "  return store.run();",                       // 5
    "}",                                          // 6
    "",
  ].join("\n"),
};

before(() => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-nav-lsp-"));
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (!resolveLanguageServer(root, "src/store.ts")) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  const files = ["src/base.ts", "src/store.ts", "src/use.ts"].map((path) => ({ path, content: SOURCES[path] }));
  project = { root, analysis: new ProjectAnalysis(root, { files }) };
});

after(async () => {
  if (!project) return;
  // The server is a child process; leaving it running keeps the test runner alive (see the comment in
  // test/helpers/dom.mjs about a single forgotten handle holding the whole suite open).
  await project.analysis.dispose?.();
  rmSync(project.root, { recursive: true, force: true });
  project = null;
});

test("the real server's file structure is nested and in line order, whatever shape it answers in", async (t) => {
  if (!project) { t.skip("no TypeScript language server installed"); return; }
  const structure = await project.analysis.query({ kind: "documentSymbol", path: "src/store.ts" });
  assert.equal(structure.engine, "lsp", `answered by the server (${structure.fallbackReason ?? ""})`);
  assert.equal(structure.confidence, "semantic");

  const shown = structure.symbols.map((symbol) => `${"  ".repeat(symbol.depth)}${symbol.name}`);
  assert.deepEqual(shown, [
    "Store",
    "  total",
    "  run",
    "  bump",
    "makeStore",
  ], "the class first with its members under it, then the function declared after it");

  const store = structure.symbols[0];
  assert.equal(store.kind, "class");
  assert.equal(store.lineIndex, 2, "a jump lands on the line the name is on");
  assert.equal(store.endLineIndex, 13, "and the span covers the whole body, which is what ⌥↓ steps past");
});

test("the real server resolves a type declaration from a value", async (t) => {
  if (!project) { t.skip("no TypeScript language server installed"); return; }
  // `store` on use.ts:4 — its type is Store, declared in store.ts.
  const type = await project.analysis.query({ kind: "typeDefinition", path: "src/use.ts", line: 3, column: 8, symbol: "store" });
  assert.equal(type.engine, "lsp", type.fallbackReason ?? "");
  assert.deepEqual(type.locations.map((item) => [item.path, item.lineIndex]), [["src/store.ts", 2]]);
});

test("the real server answers both directions of the call hierarchy", async (t) => {
  if (!project) { t.skip("no TypeScript language server installed"); return; }
  const callers = await project.analysis.query({ kind: "callers", path: "src/store.ts", line: 9, column: 2, symbol: "bump" });
  assert.equal(callers.engine, "lsp", callers.fallbackReason ?? "");
  assert.ok(callers.locations.some((item) => item.path === "src/store.ts" && item.lineIndex === 5),
    `run() calls bump() (got ${JSON.stringify(callers.locations.map((l) => [l.path, l.lineIndex]))})`);
  assert.ok(callers.locations.every((item) => item.name), "each row is named, which is what the tree shows");

  const callees = await project.analysis.query({ kind: "callees", path: "src/store.ts", line: 5, column: 2, symbol: "run" });
  assert.equal(callees.engine, "lsp", callees.fallbackReason ?? "");
  assert.ok(callees.locations.some((item) => item.lineIndex === 9), "run() calls bump()");
});

// The designed behaviour for a capability the server does not have. tsserver has no type hierarchy, and
// what matters is that this is REPORTED and then answered heuristically — not returned as an empty list,
// which a reader would take to mean the class extends nothing.
test("a request the real server does not implement is named, and the heuristic answers instead", async (t) => {
  if (!project) { t.skip("no TypeScript language server installed"); return; }
  const supers = await project.analysis.query({ kind: "supertypes", path: "src/store.ts", line: 2, column: 13, symbol: "Store" });
  assert.equal(supers.engine, "index");
  assert.equal(supers.confidence, "heuristic");
  assert.match(supers.fallbackReason, /does not offer a type hierarchy/);
  assert.deepEqual(supers.locations.map((item) => item.path), ["src/base.ts"],
    "`class Store extends Base` is on the line, so the declaration scan can still answer");

  const subs = await project.analysis.query({ kind: "subtypes", path: "src/base.ts", line: 4, column: 22, symbol: "Base" });
  assert.deepEqual(subs.locations.map((item) => item.path), ["src/store.ts"]);
});
