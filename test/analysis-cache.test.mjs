// The symbol scan, kept between launches — and the three ways keeping it could be WRONG rather than slow.
//
// buildProjectIndex re-scans every line on every launch: measured, 228 ms for 294 files, 2,661 ms for 3,513,
// 2,517 ms for 5,551, with the scan itself ~90% of it. An agent writes in a worktree, the reviewer opens
// kakapo there, and that scan runs again for a tree that moved in a dozen files.
//
// A cache of derived values is only as good as its invalidation, and a stale symbol record is a jump into a
// line that no longer says what it said — the failure this repository treats as worse than slow. So the
// assertions here are about identity and invalidation, not speed:
//
//   1. the rehydrated index says EXACTLY what the scan said (every field of every record)
//   2. text that moved is re-scanned
//   3. the key carries the extension, because that is the only thing about a path the scan reads
//   4. records produced by a different scanner are not served at all
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSymbolCache } from "../dist/analysis-cache.js";
import { buildRegexSymbolIndexChunked } from "../dist/analysis-index.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function cacheFile() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-symcache-"));
  dirs.push(dir);
  return join(dir, "symbols", "index.json");
}

// Every field of every record, in a stable order: the point is that a served record is indistinguishable
// from a scanned one, so nothing about it may be approximated.
const fingerprint = (index) => index.symbols
  .map((s) => [s.path, s.lineIndex, s.column, s.name, s.symbolKind, s.declaration, s.text, s.container ?? ""].join("\u0000"))
  .sort()
  .join("\n");

const FILES = [
  {
    path: "src/thing.ts",
    content: [
      "// a comment mentioning class Ghost",
      "export class Thing {",
      "  run(): void {}",
      "}",
      "export function helper(x) { return x; }",
      "const literal = \"class AlsoNotReal\";",
      "",
      "export type Id = string;",
    ].join("\n"),
  },
  {
    path: "src/other.py",
    content: ["class Holder:", "    def method(self):", "        pass", "", "def free():", "    pass"].join("\n"),
  },
];

test("a served index is identical to a scanned one, field for field", async () => {
  const file = cacheFile();
  const cold = openSymbolCache(file);
  const scanned = await buildRegexSymbolIndexChunked(FILES, undefined, cold);
  assert.deepEqual(cold.stats(), { hits: 0, misses: FILES.length });
  assert.ok(scanned.symbols.length >= 5, `fixture should produce symbols, got ${scanned.symbols.length}`);

  // A second launch: a new cache object over the file the first one wrote.
  const warm = openSymbolCache(file);
  const served = await buildRegexSymbolIndexChunked(FILES, undefined, warm);
  assert.deepEqual(warm.stats(), { hits: FILES.length, misses: 0 });
  assert.equal(fingerprint(served), fingerprint(scanned));
  // The by-name map and the content map have to come back too, not just the flat list.
  assert.deepEqual([...served.definitions.keys()].sort(), [...scanned.definitions.keys()].sort());
  assert.deepEqual([...served.files.keys()].sort(), [...scanned.files.keys()].sort());
});

test("text that moved is scanned again", async () => {
  const file = cacheFile();
  await buildRegexSymbolIndexChunked(FILES, undefined, openSymbolCache(file));

  const edited = [{ ...FILES[0], content: FILES[0].content.replace("class Thing", "class Renamed") }, FILES[1]];
  const warm = openSymbolCache(file);
  const index = await buildRegexSymbolIndexChunked(edited, undefined, warm);
  // One file's text is new, the other's is not.
  assert.deepEqual(warm.stats(), { hits: 1, misses: 1 });
  assert.ok(index.definitions.has("Renamed"), "the edited declaration is indexed");
  assert.equal(index.definitions.has("Thing"), false, "the replaced declaration is gone");
});

test("the key carries the extension, so the same text at another path is reused but at another language is not", async () => {
  const file = cacheFile();
  const python = FILES[1];
  const cold = openSymbolCache(file);
  const scanned = await buildRegexSymbolIndexChunked([python], undefined, cold);

  // Same text, different path: this is the worktree case — a sibling checkout holds the same bytes
  // elsewhere, and a path-keyed store would miss every one of them.
  const moved = openSymbolCache(file);
  const movedIndex = await buildRegexSymbolIndexChunked([{ path: "pkg/moved.py", content: python.content }], undefined, moved);
  assert.deepEqual(moved.stats(), { hits: 1, misses: 0 });
  assert.equal(movedIndex.symbols.length, scanned.symbols.length);
  assert.ok(movedIndex.symbols.every((s) => s.path === "pkg/moved.py"), "records belong to the file being indexed");

  // Same text, different extension: the scan masks comments and strings by extension and gives .py a
  // container pass, so the records are NOT the same — a key that ignored the extension would serve these.
  // Asserted on the records rather than on their count, which is 3 either way: `def method(self)` inside a
  // class is a METHOD of Holder in .py and a bare function in .ts, which is the difference that would be
  // served wrongly.
  const crossed = openSymbolCache(file);
  const asTypeScript = await buildRegexSymbolIndexChunked([{ path: "src/same.ts", content: python.content }], undefined, crossed);
  assert.deepEqual(crossed.stats(), { hits: 0, misses: 1 });
  const shape = (index) => index.symbols.map((s) => [s.name, s.symbolKind, s.container ?? ""]);
  assert.deepEqual(shape(scanned), [["Holder", "class", ""], ["method", "method", "Holder"], ["free", "function", ""]]);
  assert.deepEqual(shape(asTypeScript), [["Holder", "class", ""], ["method", "function", ""], ["free", "function", ""]]);
});

test("records from another scanner, or a corrupt store, are not served", async () => {
  const file = cacheFile();
  await buildRegexSymbolIndexChunked(FILES, undefined, openSymbolCache(file));
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.ok(stored.scanner && stored.scanner.length >= 8, "the store names the scanner that produced it");

  // Exactly what editing a declaration pattern does: same entries, different scanner.
  writeFileSync(file, JSON.stringify({ ...stored, scanner: "a-different-scanner" }));
  const foreign = openSymbolCache(file);
  await buildRegexSymbolIndexChunked(FILES, undefined, foreign);
  assert.deepEqual(foreign.stats(), { hits: 0, misses: FILES.length }, "a foreign scanner's records are ignored wholesale");

  writeFileSync(file, "{ this is not json");
  const broken = openSymbolCache(file);
  const index = await buildRegexSymbolIndexChunked(FILES, undefined, broken);
  assert.deepEqual(broken.stats(), { hits: 0, misses: FILES.length });
  assert.ok(index.symbols.length > 0, "a corrupt store degrades to a full scan, it does not throw");
});
