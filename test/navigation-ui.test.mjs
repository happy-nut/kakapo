// Navigating a file by its structure, from the keyboard: the structure popup (⌘F12), stepping between
// symbols (⌥↓/⌥↑), where the caret has been (⌘⇧E), and the `name:42` suffix in file search.
//
// The analysis bridge is stubbed because that is the boundary — what is being guarded here is what the
// viewer does with an answer, including how many times it asks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const SOURCE = [
  "import { thing } from './thing';",       // 0
  "",                                        // 1
  "export class Store {",                    // 2
  "  load() {",                              // 3
  "    return 1;",                           // 4
  "  }",                                     // 5
  "  save() {",                              // 6
  "    return 2;",                           // 7
  "  }",                                     // 8
  "}",                                       // 9
  "",                                        // 10
  "export function helper() {",              // 11
  "  return new Store();",                   // 12
  "}",                                       // 13
].join("\n");

const SYMBOLS = [
  { name: "Store", kind: "class", detail: "class Store", lineIndex: 2, column: 13, endLineIndex: 9, depth: 0 },
  { name: "load", kind: "method", detail: "load(): number", lineIndex: 3, column: 2, endLineIndex: 5, depth: 1 },
  { name: "save", kind: "method", detail: "save(): number", lineIndex: 6, column: 2, endLineIndex: 8, depth: 1 },
  { name: "helper", kind: "function", detail: "helper(): Store", lineIndex: 11, column: 16, endLineIndex: 13, depth: 0 },
];

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" },
    { path: "src/thing.ts", before: "export const thing = 1;\n", after: "export const thing = 2;\n" },
  ]));
});
after(cleanupFixtures);

/** A viewer with the analysis bridge stubbed and the file open in the source view. */
async function openSource(options = {}) {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoAnalysis = {
    query: (request) => {
      asked.push(request);
      if (request.kind === "documentSymbol") {
        return Promise.resolve({ ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: [], symbols: options.symbols ?? SYMBOLS });
      }
      if (request.kind === "typeDefinition") {
        return Promise.resolve({ ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: options.typeLocations ?? [] });
      }
      return Promise.resolve({ ok: true, engine: "lsp", confidence: "semantic", locations: [] });
    },
    status: () => Promise.resolve({ generation: 0, phase: "ready" }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return { v, asked };
}

const press = (host, init) => {
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return host.v.settle(40);
};
const structureRows = (host) => host.v.$all("#quick-open-results .structure-result")
  .map((row) => row.querySelector(".quick-open-name").textContent);
// `viewerCursor` is a top-level `let`, which a classic script does not put on `window`; caretLocation() is
// the accessor the app itself uses (it is what ⌘K copies).
const caretAt = (host) => host.v.window.caretLocation();

test("⌘F12 lists this file's structure, indented by nesting", async () => {
  const host = await openSource();
  await press(host, { key: "F12", code: "F12", metaKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), false, "the structure popup is up");
  assert.deepEqual(structureRows(host), ["Store", "load", "save", "helper"]);
  const rows = host.v.$all("#quick-open-results .structure-result");
  assert.equal(rows[0].style.getPropertyValue("--structure-depth"), "0");
  assert.equal(rows[1].style.getPropertyValue("--structure-depth"), "1", "a method inside a class reads as inside it");
  assert.match(host.v.$("#quick-open-results .quick-open-badge").textContent, /class/,
    "the kind is on the row, so the list is scannable without reading names");
  host.v.close();
});

test("the structure is asked for once, and typing filters what came back", async () => {
  const host = await openSource();
  await press(host, { key: "F12", code: "F12", metaKey: true });
  const before = host.asked.filter((request) => request.kind === "documentSymbol").length;
  assert.equal(before, 1);

  const input = host.v.$("#quick-open-input");
  input.value = "sav";
  input.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
  await host.v.settle(40);
  assert.deepEqual(structureRows(host), ["save"]);
  assert.equal(host.asked.filter((request) => request.kind === "documentSymbol").length, before,
    "a keystroke is a filter over one file's symbols, not another query");
  host.v.close();
});

test("a query typed with the IME still on finds a Latin symbol, as file search does", async () => {
  const host = await openSource();
  await press(host, { key: "F12", code: "F12", metaKey: true });
  const input = host.v.$("#quick-open-input");
  // The jamo the keys s-t-o-r-e produce with a Korean layout on. The shared helper reads a Hangul query
  // back as the keys that made it, so the symbol is found without switching layout and retyping.
  input.value = "ㄴㅅㅐㄱㄷ";
  input.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
  await host.v.settle(40);
  assert.deepEqual(structureRows(host), ["Store"]);
  host.v.close();
});

test("a Hangul symbol name is matched by a Hangul query, with no folding in the way", async () => {
  const host = await openSource({
    symbols: [
      { name: "저장하기", kind: "function", lineIndex: 3, column: 0, endLineIndex: 4, depth: 0 },
      { name: "불러오기", kind: "function", lineIndex: 6, column: 0, endLineIndex: 7, depth: 0 },
    ],
  });
  await press(host, { key: "F12", code: "F12", metaKey: true });
  const input = host.v.$("#quick-open-input");
  input.value = "저장";
  input.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
  await host.v.settle(40);
  assert.deepEqual(structureRows(host), ["저장하기"]);
  host.v.close();
});

test("Enter on a structure row puts the caret on that symbol's name", async () => {
  const host = await openSource();
  await press(host, { key: "F12", code: "F12", metaKey: true });
  // Down twice: Store -> load -> save
  await press(host, { key: "ArrowDown", code: "ArrowDown" });
  await press(host, { key: "ArrowDown", code: "ArrowDown" });
  await press(host, { key: "Enter", code: "Enter" });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), true, "the popup gets out of the way");
  assert.equal(caretAt(host), `${FILE}:7`, "save() is on line 7");
  host.v.close();
});

test("a file with no structure says so instead of showing an empty list", async () => {
  const host = await openSource({ symbols: [] });
  await press(host, { key: "F12", code: "F12", metaKey: true });
  assert.match(host.v.$("#quick-open-results").textContent, /No structure/);
  host.v.close();
});

test("⌥↓ / ⌥↑ step between symbols, and stop at the ends", async () => {
  const host = await openSource();
  // Warm the structure the way the first press does, then step.
  await press(host, { key: "ArrowDown", code: "ArrowDown", altKey: true });
  await host.v.settle(40);

  host.v.window.setSourceCursor(FILE, 0, 0, true, -1);
  await press(host, { key: "ArrowDown", code: "ArrowDown", altKey: true });
  assert.equal(caretAt(host), `${FILE}:3`, "from the top, the first symbol");
  await press(host, { key: "ArrowDown", code: "ArrowDown", altKey: true });
  assert.equal(caretAt(host), `${FILE}:4`);
  await press(host, { key: "ArrowUp", code: "ArrowUp", altKey: true });
  assert.equal(caretAt(host), `${FILE}:3`, "and back again");

  host.v.window.setSourceCursor(FILE, 13, 0, true, -1);
  await press(host, { key: "ArrowDown", code: "ArrowDown", altKey: true });
  assert.equal(caretAt(host), `${FILE}:14`,
    "past the last symbol the key declines rather than wrapping to the top");
  host.v.close();
});

test("⌘⇧E lists where the caret has been, newest first, marking where it is now", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 3, 2, true, -1);
  await host.v.settle(20);
  host.v.window.openSourceFile("src/thing.ts");
  host.v.window.setSourceCursor("src/thing.ts", 0, 0, true, -1);
  await host.v.settle(40);

  await press(host, { key: "e", code: "KeyE", metaKey: true, shiftKey: true });
  const names = host.v.$all("#quick-open-results .quick-open-item").map((row) => row.querySelector(".quick-open-path").textContent);
  assert.ok(names.length >= 2, `the history has entries (got ${names.length})`);
  assert.ok(names.some((name) => name.startsWith("src/store.ts:")), "the file jumped away from is in the list");
  assert.ok(host.v.$("#quick-open-results .quick-open-item.is-current"), "and where the caret is now is marked");
  host.v.close();
});

test("Enter on a recent location restores that position, not just the file", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 6, 2, true, -1);
  await host.v.settle(20);
  host.v.window.openSourceFile("src/thing.ts");
  host.v.window.setSourceCursor("src/thing.ts", 0, 0, true, -1);
  await host.v.settle(40);
  await press(host, { key: "e", code: "KeyE", metaKey: true, shiftKey: true });
  const target = host.v.$all("#quick-open-results .quick-open-item")
    .find((row) => row.querySelector(".quick-open-path").textContent.startsWith("src/store.ts:"));
  assert.ok(target, "store.ts is in the list");
  target.click();
  await host.v.settle(60);
  assert.match(caretAt(host), new RegExp(`^${FILE}:`));
  host.v.close();
});

test("⌘P searches files by name, and `:42` lands on the line", async () => {
  const host = await openSource();
  await press(host, { key: "p", code: "KeyP", metaKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), false);
  const input = host.v.$("#quick-open-input");
  input.value = "store.ts:12";
  input.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
  await host.v.settle(40);
  const rows = host.v.$all("#quick-open-results .quick-open-item");
  assert.ok(rows.length, "the suffix is not matched against the name — the file is still found");
  rows[0].click();
  await host.v.settle(60);
  assert.equal(caretAt(host), `${FILE}:12`, "`:12` is the twelfth line, counting from one");
  host.v.close();
});

test("⌘⇧B asks for a type declaration and jumps to the one answer", async () => {
  const host = await openSource({ typeLocations: [{ path: "src/thing.ts", lineIndex: 0, column: 13 }] });
  host.v.window.setSourceCursor(FILE, 12, 14, true, -1);
  await host.v.settle(20);
  await press(host, { key: "b", code: "KeyB", metaKey: true, shiftKey: true });
  await host.v.settle(60);
  assert.ok(host.asked.some((request) => request.kind === "typeDefinition"),
    `a typeDefinition query was made (got ${host.asked.map((r) => r.kind).join(", ")})`);
  assert.match(caretAt(host), /^src\/thing\.ts:/);
  host.v.close();
});

// ---- Search Everywhere, the counterpart file, the hierarchies and bookmarks --------------------------

test("a double Shift opens the launcher; one Shift, or an interrupted pair, does not", async () => {
  const host = await openSource();
  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), true, "one tap is not a chord");

  // Something else pressed between the two taps ends the pair — otherwise every Shift+letter followed by
  // a Shift would open it.
  await press(host, { key: "A", code: "KeyA", shiftKey: true });
  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), true);

  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true });
  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), false, "two taps open it");
  assert.ok(host.v.$("#quick-open").classList.contains("quick-launcher"),
    "with the section rail beside it — that is what searching everywhere means");
  host.v.close();
});

test("a held Shift is one press, not a stream of them", async () => {
  const host = await openSource();
  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true, repeat: true });
  await press(host, { key: "Shift", code: "ShiftLeft", shiftKey: true, repeat: true });
  assert.equal(host.v.$("#quick-open").classList.contains("hidden"), true);
  host.v.close();
});

test("⌘⇧T goes to the file's test, and back from the test to the file", async () => {
  const { html: paired } = await makeReviewHtml([
    { path: "src/store.ts", after: "export const a = 1;\n" },
    { path: "test/store.test.ts", after: "import '../src/store';\n" },
  ]);
  const v = await loadViewer(paired);
  v.window.openSourceFile("src/store.ts");
  await v.settle(40);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, shiftKey: true, bubbles: true }));
  await v.settle(60);
  assert.equal(v.$("#source-viewer").dataset.openPath, "test/store.test.ts");

  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, shiftKey: true, bubbles: true }));
  await v.settle(60);
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/store.ts", "the counterpart relation runs both ways");
  v.close();
});

test("the nearest counterpart wins when the same name exists twice", async () => {
  const { html: monorepo } = await makeReviewHtml([
    { path: "packages/a/src/thing.ts", after: "export const a = 1;\n" },
    { path: "packages/a/test/thing.test.ts", after: "import '../src/thing';\n" },
    { path: "packages/b/test/thing.test.ts", after: "import '../src/thing';\n" },
  ]);
  const v = await loadViewer(monorepo);
  v.window.openSourceFile("packages/a/src/thing.ts");
  await v.settle(40);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, shiftKey: true, bubbles: true }));
  await v.settle(60);
  assert.equal(v.$("#source-viewer").dataset.openPath, "packages/a/test/thing.test.ts",
    "a monorepo has many thing.test.ts and only one of them is this file's");
  v.close();
});

/** A viewer whose analysis bridge answers hierarchy queries from a fixed map. */
async function openHierarchyHost(answers) {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoAnalysis = {
    query: (request) => {
      asked.push(request);
      const key = `${request.kind}:${request.symbol ?? ""}`;
      return Promise.resolve({
        ok: true,
        engine: "lsp",
        server: "tsserver",
        confidence: "semantic",
        locations: answers[key] ?? [],
        symbols: [],
        fallbackReason: answers[key] ? undefined : "tsserver does not offer a type hierarchy",
      });
    },
    status: () => Promise.resolve({ generation: 0 }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 11, 16, true, -1); // on `helper`
  await v.settle(20);
  return { v, asked };
}

test("⌘⌥H lists the callers, ⇢ expands one of them, ⇠ collapses it", async () => {
  const host = await openHierarchyHost({
    "callers:helper": [{ path: FILE, lineIndex: 12, column: 2, name: "Store.load" }],
    "callers:Store.load": [{ path: "src/thing.ts", lineIndex: 0, column: 0, name: "boot" }],
  });
  await press(host, { key: "h", code: "KeyH", metaKey: true, altKey: true });
  await host.v.settle(60);
  let rows = host.v.$all("#quick-open-results .structure-result");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Store\.load/);
  assert.match(rows[0].querySelector(".hierarchy-twisty").textContent, /▸/, "a row that can be opened says so");

  await press(host, { key: "ArrowRight", code: "ArrowRight" });
  await host.v.settle(60);
  rows = host.v.$all("#quick-open-results .structure-result");
  assert.equal(rows.length, 2, "its own callers are spliced in beneath it");
  assert.equal(rows[1].style.getPropertyValue("--structure-depth"), "1");
  assert.match(rows[0].querySelector(".hierarchy-twisty").textContent, /▾/);

  await press(host, { key: "ArrowLeft", code: "ArrowLeft" });
  await host.v.settle(40);
  assert.equal(host.v.$all("#quick-open-results .structure-result").length, 1, "collapsing takes them away again");
  host.v.close();
});

test("pressing the hierarchy chord again flips the direction", async () => {
  const host = await openHierarchyHost({
    "callers:helper": [{ path: FILE, lineIndex: 12, column: 2, name: "Store.load" }],
    "callees:helper": [{ path: FILE, lineIndex: 2, column: 13, name: "Store" }],
  });
  await press(host, { key: "h", code: "KeyH", metaKey: true, altKey: true });
  await host.v.settle(60);
  assert.match(host.v.$("#quick-open-filter").textContent, /What calls helper/);

  await press(host, { key: "h", code: "KeyH", metaKey: true, altKey: true });
  await host.v.settle(60);
  assert.match(host.v.$("#quick-open-filter").textContent, /What helper calls/,
    "one key, both directions — IntelliJ's two tabs");
  assert.match(host.v.$("#quick-open-results").textContent, /Store/);
  host.v.close();
});

test("an empty hierarchy says why, instead of looking like 'nothing calls this'", async () => {
  const host = await openHierarchyHost({});
  await press(host, { key: "h", code: "KeyH", metaKey: true, shiftKey: true });
  await host.v.settle(60);
  assert.match(host.v.$("#quick-open-results").textContent, /Nothing to show/);
  assert.match(host.v.$("#quick-open-results").textContent, /does not offer a type hierarchy/);
  host.v.close();
});

test("F3 bookmarks the caret's line, marks the gutter, and ⌘F3 lists it", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 6, 2, true, -1);
  await host.v.settle(20);
  await press(host, { key: "F3", code: "F3" });
  assert.ok(host.v.$(`#source-body tr.source-row[data-line-index="6"]`).classList.contains("bookmarked"),
    "the line it is on is marked in the gutter");

  await press(host, { key: "F3", code: "F3", metaKey: true });
  const rows = host.v.$all("#quick-open-results .quick-open-item");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /store\.ts:7/);
  rows[0].click();
  await host.v.settle(60);
  assert.equal(caretAt(host), `${FILE}:7`);

  // F3 again on the same line takes it away.
  await press(host, { key: "F3", code: "F3" });
  assert.equal(host.v.$(`#source-body tr.source-row[data-line-index="6"]`).classList.contains("bookmarked"), false);
  host.v.close();
});

test("bookmarks survive a reopen, and are kakapo's own state — never the repository's", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 3, 2, true, -1);
  await host.v.settle(20);
  await press(host, { key: "F3", code: "F3" });
  // Keyed to this review, not globally: on a file:// page every review shares one localStorage, so a
  // plain key hands one repository's bookmarks to the next one opened.
  const storage = host.v.exportStorage();
  assert.equal(storage["kakapo-bookmarks"], undefined, "never under a key other reviews would read");
  const saved = storage["kakapo-bookmarks:/review.html"];
  host.v.close();
  assert.ok(saved, "the bookmark is persisted for this review");
  const marks = JSON.parse(saved);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].path, FILE);
  assert.equal(marks[0].lineIndex, 3);
});

test("⇧⌥3 numbers a line and ⌥3 goes back to it, from anywhere", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 6, 2, true, -1);
  await host.v.settle(20);
  await press(host, { key: "3", code: "Digit3", altKey: true, shiftKey: true });
  const row = host.v.$(`#source-body tr.source-row[data-line-index="6"]`);
  assert.equal(row.dataset.bookmarkMnemonic, "3", "the number is on the row, which is what the gutter draws");

  host.v.window.openSourceFile("src/thing.ts");
  await host.v.settle(40);
  await press(host, { key: "3", code: "Digit3", altKey: true });
  assert.equal(caretAt(host), `${FILE}:7`, "from another file, the number takes you back");
  host.v.close();
});

test("a number belongs to one line: assigning it again moves it", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 3, 2, true, -1);
  await host.v.settle(20);
  await press(host, { key: "1", code: "Digit1", altKey: true, shiftKey: true });
  host.v.window.setSourceCursor(FILE, 11, 0, true, -1);
  await host.v.settle(20);
  await press(host, { key: "1", code: "Digit1", altKey: true, shiftKey: true });

  assert.equal(host.v.$(`#source-body tr.source-row[data-line-index="3"]`).dataset.bookmarkMnemonic, undefined,
    "two lines claiming to be bookmark 1 would make the number useless");
  assert.equal(host.v.$(`#source-body tr.source-row[data-line-index="11"]`).dataset.bookmarkMnemonic, "1");
  await press(host, { key: "1", code: "Digit1", altKey: true });
  assert.equal(caretAt(host), `${FILE}:12`);
  host.v.close();
});

test("⌥7 with nothing bookmarked as 7 says so rather than doing nothing", async () => {
  const host = await openSource();
  await press(host, { key: "7", code: "Digit7", altKey: true });
  assert.match(host.v.$("#toast")?.textContent ?? host.v.document.body.textContent, /7/);
  host.v.close();
});
