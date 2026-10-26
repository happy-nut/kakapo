// Find Usages: what each usage IS (⌥F7's groups), and this file's occurrences of it (⌘F7, ⌘⌥↓/⌘⌥↑).
//
// Two layers, both in the page, so both are exercised through the viewer rather than through dist/: the
// classifier is a pure function over a line of text, and the grouped view is what the page does with an
// analyzer answer. The analysis bridge is stubbed — the boundary being guarded is the page's side of it.
//
// What these tests CANNOT see, and scripts/navigation-smoke.mjs can: a painted range. jsdom implements no
// CSS Custom Highlight API, so `CSS.highlights.set` is swallowed by the try/catch it is written inside and
// every assertion here would pass against a highlight that draws nothing. The marks and the row classes
// are asserted here; whether anything appears on screen is asserted in the real app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const PY_FILE = "app/thing.py";
const SOURCE = [
  "import { Store } from './store';",              // 0  import
  "",                                               // 1
  "let count = 0;",                                 // 2  declaration of count
  "",                                               // 3
  "export class Cache extends Store {",             // 4  extends
  "  make(): Store {",                              // 5  return type
  "    count = count + 1;",                         // 6  write, then read
  "    return new Store();",                        // 7  new
  "  }",                                            // 8
  "  // Store is cached here",                      // 9  comment
  "  label = 'Store failed';",                      // 10 string constant
  "  take(s: Store) { return s; }",                 // 11 parameter declaration
  "}",                                              // 12
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "let count = 0;\n", after: SOURCE + "\n" },
    { path: "src/store.test.ts", before: "", after: "import { Store } from './store';\n" },
    { path: PY_FILE, before: "", after: "# Store is the cache\nx = Store // 2\n" },
  ]));
});
after(cleanupFixtures);

/** A viewer with the analysis bridge stubbed; `references` answers with whatever the test hands it. */
async function openSource(references = []) {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoAnalysis = {
    query: (request) => {
      asked.push(request);
      if (request.kind === "references") {
        return Promise.resolve({ ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: references });
      }
      return Promise.resolve({ ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] });
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
const F7 = { code: "F7", key: "F7" };
const DOWN = { code: "ArrowDown", key: "ArrowDown" };
const UP = { code: "ArrowUp", key: "ArrowUp" };

/** One usage location, as an analyzer answers it: the line's text and the column the name starts at. */
function at(path, lineIndex, text, name) {
  return { path, lineIndex, column: text.indexOf(name), text, name };
}
const groups = (host) => host.v.$all("#quick-open-results .usage-group")
  .map((row) => row.textContent.trim());
// Only the usage-TYPE headers. The list is nested now (17-find-usages.js groups by file as well, which is
// IntelliJ's default), so "which headers are there" has to name the rank it is asking about.
const typeGroups = (host) => host.v.$all('#quick-open-results .usage-group[data-usage-group="type"]')
  .map((row) => row.querySelector(".usage-group-name").textContent.trim());
const rows = (host) => host.v.$all("#quick-open-results .usage-result")
  .map((row) => row.dataset.usageType);

// ---- the classifier ------------------------------------------------------------------------------

test("a usage is classified from the line it is on, with IntelliJ's own type names", async () => {
  const host = await openSource();
  const classify = (line, name = "Store", path = FILE) =>
    host.v.window.classifyUsage(name, line, line.indexOf(name), path);

  assert.equal(classify("import { Store } from './store';"), "import");
  assert.equal(classify("export { Store } from './x';"), "import");
  assert.equal(classify("class Cache extends Store {"), "extends");
  assert.equal(classify("class Cache(Store):"), "extends", "Python says it with parentheses");
  assert.equal(classify("impl Display for Store {"), "extends", "and Rust with `impl … for`");
  assert.equal(classify("class Cache : Store() {"), "extends", "and Kotlin with a colon");
  assert.equal(classify("class Cache extends Base with Store {"), "extends", "and Scala with `with`");
  assert.equal(classify("#[derive(Store)]"), "annotation", "a Rust attribute is its annotation");
  assert.equal(classify("    return new Store();"), "new");
  assert.equal(classify("@Store"), "annotation");
  assert.equal(classify("if (x instanceof Store) {"), "instanceof");
  assert.equal(classify("isinstance(x, Store)"), "instanceof");
  assert.equal(classify("const s = value as Store;"), "cast");
  assert.equal(classify("const m: Map<string, Store> = new Map();"), "type.parameter");
  assert.equal(classify("  take(s: Store) { return s; }"), "parameter.declaration");
  assert.equal(classify("  make(): Store {"), "return");
  assert.equal(classify("  let s: Store = load();"), "local.declaration");
  assert.equal(classify("export class Store {"), "declaration",
    "a declaration is not a usage — tsserver answers `references` with it anyway");
  assert.equal(classify("let count = 0;", "count"), "declaration");
  assert.equal(classify("export const subject = Store;"), "read",
    "…but the keyword there declares `subject`, and Store is read");
  assert.equal(classify("count = 1;", "count"), "write");
  assert.equal(classify("count += 1;", "count"), "write");
  assert.equal(classify("count++;", "count"), "write");
  assert.equal(classify("if (count === 1) {", "count"), "read", "=== is a comparison, not a write");
  assert.equal(classify("  return count + 1;", "count"), "read");
  // A call site has no usage type of its own in IntelliJ either — it shows as Unclassified rather than as
  // a "Value read", which is what a call is not.
  assert.equal(classify("  load(Store);", "load"), "unclassified");
  assert.equal(classify("  items.map(count => count * 2);", "count"), "read",
    "`=>` is an arrow, not an assignment — the parameter is not a write");
  assert.equal(classify("  if (count < 3) {", "count"), "read", "and `<` is a comparison, not a generic call");
  assert.equal(classify("  load<Store>(1);", "load"), "unclassified", "a generic call still is one");
  host.v.close();
});

test("a comment and a string are told apart from code, per language", async () => {
  const host = await openSource();
  const classify = (line, name, path) => host.v.window.classifyUsage(name, line, line.indexOf(name), path);

  assert.equal(classify("  // Store is cached here", "Store", FILE), "comment");
  assert.equal(classify("  label = 'Store failed';", "Store", FILE), "string.constant");
  // The case a `line.indexOf('//')` gets wrong: the slashes are inside a string, so what follows them is
  // not a comment. This is why the zone scan walks the line with a quote state.
  assert.equal(classify('  fetch("http://api/Store");', "Store", FILE), "string.constant");
  assert.equal(classify('  const u = "http://api" + Store;', "Store", FILE), "read",
    "…and after the string closes, code again");
  host.v.close();
});

test("`#` is a comment in Python and not in TypeScript, and `//` the other way round", async () => {
  const host = await openSource();
  const classify = (line, path) => host.v.window.classifyUsage("Store", line, line.indexOf("Store"), path);

  assert.equal(classify("# Store is the cache", PY_FILE), "comment");
  assert.equal(classify("x = Store // 2", PY_FILE), "read", "`//` is floor division in Python");
  assert.equal(classify("# Store is the cache", FILE), "read", "`#` is not a comment in TypeScript");
  host.v.close();
});

// ---- ⌥F7: the grouped view -----------------------------------------------------------------------

test("⌥F7 groups the usages by what they are, non-code usages last", async () => {
  const host = await openSource([
    at(FILE, 0, "import { Store } from './store';", "Store"),
    at(FILE, 4, "export class Cache extends Store {", "Store"),
    at(FILE, 7, "    return new Store();", "Store"),
    at(FILE, 9, "  // Store is cached here", "Store"),
    at(FILE, 10, "  label = 'Store failed';", "Store"),
    at("src/store.test.ts", 0, "import { Store } from './store';", "Store"),
  ]);
  host.v.window.setSourceCursor(FILE, 5, 10, true, -1); // on `Store` in make()'s return type
  await press(host, { ...F7, altKey: true });

  assert.deepEqual(rows(host), ["import", "import", "extends", "new", "string.constant", "comment"],
    "the code groups in IntelliJ's order, then the two that are not code");
  const headers = groups(host);
  assert.match(headers.join("|"), /Non-code usages/, "with the non-code divider between them");
  assert.match(headers[0], /^Usage in import2$/, "a header carries its own count");
  assert.match(host.v.$("#quick-open-filter").textContent, /6 usages in 2 files/);
  host.v.close();
});

test("a header is not a row: the arrows and Enter only ever see usages", async () => {
  const host = await openSource([
    at(FILE, 0, "import { Store } from './store';", "Store"),
    at(FILE, 7, "    return new Store();", "Store"),
  ]);
  host.v.window.setSourceCursor(FILE, 4, 27, true, -1);
  await press(host, { ...F7, altKey: true });
  assert.deepEqual(host.v.$all("#quick-open-results .usage-result").map((row) => row.dataset.index),
    ["0", "1"], "data-index counts usages, skipping the two headers between them");

  await press(host, DOWN);
  await press(host, { code: "Enter", key: "Enter" });
  assert.equal(host.v.window.caretLocation(), `${FILE}:8`, "Enter opened the second usage, not a header");
  host.v.close();
});

test("a list that is nothing but call sites gets no heading at all", async () => {
  const host = await openSource([
    at(FILE, 7, "    return Store();", "Store"),
    at(FILE, 11, "  Store(s);", "Store"),
  ]);
  host.v.window.setSourceCursor(FILE, 5, 10, true, -1);
  await press(host, { ...F7, altKey: true });
  assert.deepEqual(rows(host), ["unclassified", "unclassified"], "a call has no usage type");
  assert.deepEqual(typeGroups(host), [], "and IntelliJ gives an untyped usage no node of its own either");
  assert.deepEqual(groups(host).length, 1, "the file it is in is still a header — that is the file grouping");
  host.v.close();
});

test("the declaration the caret is on is not one of its own usages", async () => {
  const host = await openSource([
    at(FILE, 2, "let count = 0;", "count"),
    at(FILE, 6, "    count = count + 1;", "count"),
  ]);
  host.v.window.setSourceCursor(FILE, 2, 4, true, -1); // on `count` in `let count = 0;`
  await press(host, { ...F7, altKey: true });
  assert.deepEqual(rows(host), ["write"], "the line the caret is already on is dropped");
  host.v.close();
});

test("⌥P drops the comments, the strings and the tests — and puts them back", async () => {
  const host = await openSource([
    at(FILE, 7, "    return new Store();", "Store"),
    at(FILE, 9, "  // Store is cached here", "Store"),
    at(FILE, 10, "  label = 'Store failed';", "Store"),
    at("src/store.test.ts", 0, "import { Store } from './store';", "Store"),
  ]);
  host.v.window.setSourceCursor(FILE, 5, 10, true, -1);
  await press(host, { ...F7, altKey: true });
  assert.equal(rows(host).length, 4);

  await press(host, { code: "KeyP", key: "p", altKey: true });
  assert.deepEqual(rows(host), ["new"], "the comment, the string and the test file are noise");
  assert.equal(host.v.$("#quick-open-exclude-noise").getAttribute("aria-pressed"), "true",
    "and the toggle it borrows from Find in Files says so");
  assert.match(host.v.$("#quick-open-filter").textContent, /1 usages in 1 files/);

  await press(host, { code: "KeyP", key: "p", altKey: true });
  assert.equal(rows(host).length, 4, "pressed again, they are back");
  host.v.close();
});

test("nothing found says so, with the reason the analyzer gave", async () => {
  const v = await loadViewer(html);
  v.window.kakapoAnalysis = {
    query: () => Promise.resolve({ ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: "tsserver is still indexing" }),
    status: () => Promise.resolve({ generation: 0, phase: "indexing" }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 5, 10, true, -1);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, ...F7, altKey: true }));
  await v.settle(40);
  assert.match(v.$("#quick-open-results").textContent, /No usages of Store/);
  assert.match(v.$("#quick-open-results").textContent, /still indexing/,
    "an empty answer and an answer that could not be given are different things");
  v.close();
});

// ---- ⌘F7 and ⌘⌥↓/⌘⌥↑: this file's occurrences ----------------------------------------------------

test("⌘F7 marks this file's occurrences, writes apart from reads, comments and strings left out", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 6, 4, true, -1); // on `count`
  await press(host, { ...F7, metaKey: true });

  // Array.from, not .map: an array read off the jsdom window has that realm's prototype, and
  // deepEqual compares prototypes — see test/README or reference_jsdom_cross_realm_assert.
  const marks = Array.from(host.v.window.usageMarks, (mark) => [mark.lineIndex, mark.write]);
  assert.deepEqual(marks, [[2, true], [6, true], [6, false]],
    "the declaration, the assignment and the read — and the write flag on the two assignments");
  assert.ok(host.v.$all(".usage-mark-row").length >= 1, "the rows carry the mark class");

  await press(host, { ...F7, metaKey: true });
  assert.equal(host.v.window.usageMarks.length, 0, "the same key again puts the highlight away");
  host.v.close();
});

test("a name inside a comment or a string is not an occurrence", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 4, 27, true, -1); // on `Store`
  await press(host, { ...F7, metaKey: true });
  const lines = Array.from(host.v.window.usageMarks, (mark) => mark.lineIndex);
  assert.ok(!lines.includes(9), "line 9 is a comment mentioning Store");
  assert.ok(!lines.includes(10), "line 10 has it inside a string");
  assert.deepEqual(lines, [0, 4, 5, 7, 11], "the five code occurrences, in reading order");
  host.v.close();
});

test("⌘⌥↓ and ⌘⌥↑ walk the occurrences and wrap, without the highlight being up first", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 0, 9, true, -1); // on `Store` in the import
  await press(host, { ...DOWN, metaKey: true, altKey: true });
  assert.equal(host.v.window.caretLocation(), `${FILE}:5`, "the next one, with no ⌘F7 first");
  await press(host, { ...DOWN, metaKey: true, altKey: true });
  assert.equal(host.v.window.caretLocation(), `${FILE}:6`);
  await press(host, { ...UP, metaKey: true, altKey: true });
  assert.equal(host.v.window.caretLocation(), `${FILE}:5`, "and back");

  host.v.window.setSourceCursor(FILE, 11, 11, true, -1); // the last occurrence
  await press(host, { ...DOWN, metaKey: true, altKey: true });
  assert.equal(host.v.window.caretLocation(), `${FILE}:1`, "past the last one it wraps, as IntelliJ does");
  host.v.close();
});

test("Escape takes the highlight down, and nothing else", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 6, 4, true, -1);
  await press(host, { ...F7, metaKey: true });
  assert.ok(host.v.window.usageMarks.length > 0);
  await press(host, { code: "Escape", key: "Escape" });
  assert.equal(host.v.window.usageMarks.length, 0);
  assert.equal(host.v.$all(".usage-mark-row").length, 0, "and the rows lose the mark class with them");
  host.v.close();
});

test("⌘F7 with the caret on nothing declines the key instead of swallowing it", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 3, 0, true, -1); // an empty line
  await press(host, { ...F7, metaKey: true });
  assert.equal(host.v.window.usageMarks.length, 0);
  host.v.close();
});
