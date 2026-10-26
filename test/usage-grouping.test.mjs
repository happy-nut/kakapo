// IntelliJ's usage-view grouping stack: the ranks, their two toolbars, and what the headers say.
//
// The stack is `UsageGroupingRulesDefaultRanks` in intellij-community — non-code 0, scope 100, usage type
// 200, module 300, directory 400, file 500 — and the ranks are the reason the ORDER is asserted here and
// not just the presence of each header: a module inside a usage type and a usage type inside a module are
// different answers, and this is the one test that would notice them swapping.
//
// The repository under review is a real two-module workspace with real test files, because the module and
// Production/Test groupings read the project's own declarations (src/project-layout.ts) rather than a
// stubbed layout. Only the analyzer is stubbed: which lines are usages is not what is being guarded.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const UI = "packages/ui/src/Button.ts";
const UI_TEST = "packages/ui/test/Button.test.ts";
const DATA = "packages/data/src/store.ts";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "pnpm-workspace.yaml", after: "packages:\n  - 'packages/*'\n" },
    { path: "packages/ui/package.json", after: JSON.stringify({ name: "@acme/ui" }) },
    { path: "packages/data/package.json", after: JSON.stringify({ name: "@acme/data" }) },
    { path: UI, before: "export const a = 1;\n", after: "export const a = 2;\nconst used = Store;\n" },
    { path: UI_TEST, after: "import { Store } from 'store';\n" },
    { path: DATA, before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]));
});
after(cleanupFixtures);

async function openUsages(references) {
  const v = await loadViewer(html);
  v.window.kakapoAnalysis = {
    query: (request) => Promise.resolve(request.kind === "references"
      ? { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: references }
      : { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] }),
    status: () => Promise.resolve({ generation: 0, phase: "ready" }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile(UI);
  await v.settle(40);
  // Line 1 of the open file, away from every stubbed usage line: the caret's own line is filtered out.
  v.window.setSourceCursor(UI, 1, 13, true, -1);
  const host = { v };
  await press(host, { code: "F7", key: "F7", altKey: true });
  await v.settle(60);
  return host;
}

const press = (host, init) => {
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return host.v.settle(50);
};
/** Every header, as `rank:depth:label` — the shape of the tree in one line per node. */
const headers = (host) => host.v.$all("#quick-open-results .usage-group").map((row) => [
  row.dataset.usageGroup,
  Number(row.style.getPropertyValue("--depth") || 0),
  row.querySelector(".usage-group-name").textContent.trim(),
]);
const headersOf = (host, rank) => headers(host).filter((row) => row[0] === rank).map((row) => row[2]);
// The DISTINCT labels at one rank. A nested rank repeats: the module rule runs inside every usage-type
// group, so "Module: @acme/ui" is drawn once under each type that has a usage in it — which is what a
// tree does and what IntelliJ draws.
const labelsAt = (host, rank) => Array.from(new Set(headersOf(host, rank))).sort();
const rowTypes = (host) => host.v.$all("#quick-open-results .usage-result").map((row) => row.dataset.usageType);
const chip = (host, name) => host.v.$(`.quick-open-usage-chip[data-usage-toggle="${name}"]`);
const pressed = (host, name) => chip(host, name).getAttribute("aria-pressed") === "true";

const usage = (path, lineIndex, text) => ({ path, lineIndex, column: text.indexOf("Store"), text, name: "Store" });
// One usage of each kind that the groupings divide: production and test, both modules, read/write/import.
const MIXED = [
  usage(UI, 3, "  const value = Store;"),           // @acme/ui, production, read
  usage(UI, 4, "  Store = next;"),                  // @acme/ui, production, write
  usage(UI_TEST, 0, "import { Store } from 'store';"), // @acme/ui, test, import
  usage(DATA, 2, "  return Store;"),                // @acme/data, production, read
  usage(DATA, 3, "  // Store holds it"),            // @acme/data, non-code
];

test("the groupings nest in IntelliJ's rank order, outermost first", async () => {
  const host = await openUsages(MIXED);
  // Everything on at once, so the full stack is visible. ⌘⌥S and ⌘⌥P are the two that are off by default.
  await press(host, { code: "KeyS", key: "s", metaKey: true, altKey: true });
  await press(host, { code: "KeyP", key: "p", metaKey: true, altKey: true });

  const ranks = headers(host).map((row) => row[0]);
  const firstOf = (rank) => ranks.indexOf(rank);
  assert.ok(firstOf("scope") < firstOf("type"), `scope(100) is outside usage type(200): ${ranks.join(" ")}`);
  assert.ok(firstOf("type") < firstOf("module"), `usage type(200) is outside module(300): ${ranks.join(" ")}`);
  assert.ok(firstOf("module") < firstOf("directory"), `module(300) is outside directory(400): ${ranks.join(" ")}`);
  assert.ok(firstOf("directory") < firstOf("file"), `directory(400) is outside file(500): ${ranks.join(" ")}`);

  // And the nesting is drawn, not merely ordered: each rank sits one step deeper than the one above it.
  const depthOf = (rank) => headers(host).filter((row) => row[0] === rank)[0][1];
  assert.deepEqual(
    [depthOf("scope"), depthOf("type"), depthOf("module"), depthOf("directory"), depthOf("file")],
    [0, 1, 2, 3, 4],
  );
  host.v.close();
});

test("Production/Test is off by default, and ⌘⌥S divides the answer with IntelliJ's own labels", async () => {
  const host = await openUsages(MIXED);
  assert.equal(pressed(host, "scope"), false, "isGroupByScope is false in UsageViewSettings, so it is here");
  assert.deepEqual(headersOf(host, "scope"), []);

  await press(host, { code: "KeyS", key: "s", metaKey: true, altKey: true });
  assert.equal(pressed(host, "scope"), true, "and the chip says so");
  assert.deepEqual(headersOf(host, "scope").slice(0, 2), ["Production", "Test"],
    "list.item.production and list.item.test, production first — UsageScopeGroup's own codes");
  assert.deepEqual(labelsAt(host, "scope"), ["Production", "Test"]);
  host.v.close();
});

test("the module grouping is on by default and names the module the file belongs to", async () => {
  const host = await openUsages(MIXED);
  assert.equal(pressed(host, "module"), true, "isGroupByModule is true in UsageViewSettings");
  assert.deepEqual(labelsAt(host, "module"), ["Module: @acme/data", "Module: @acme/ui"],
    "node.group.module is `Module:{0}`, and the name is the one the workspace manifest gives");

  await press(host, { code: "KeyM", key: "m", metaKey: true, altKey: true });
  assert.equal(pressed(host, "module"), false);
  assert.deepEqual(headersOf(host, "module"), [], "and the division is gone, with the rows still there");
  assert.equal(rowTypes(host).length, 5);
  host.v.close();
});

test("a one-module repository gets no module header, however the toggle is set", async () => {
  const { html: plain } = await makeReviewHtml([
    { path: "src/store.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]);
  const v = await loadViewer(plain);
  v.window.kakapoAnalysis = {
    query: (request) => Promise.resolve(request.kind === "references"
      ? { ok: true, engine: "lsp", confidence: "semantic", locations: [usage("src/store.ts", 3, "  return Store;")] }
      : { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] }),
    status: () => Promise.resolve({ generation: 0, phase: "ready" }),
    diagnostics: () => Promise.resolve({ ok: true, diagnostics: [] }),
    onStatus: () => {},
  };
  v.window.openSourceFile("src/store.ts");
  await v.settle(40);
  v.window.setSourceCursor("src/store.ts", 0, 13, true, -1);
  const host = { v };
  await press(host, { code: "F7", key: "F7", altKey: true });
  await v.settle(60);
  assert.equal(host.v.window.projectHasModules(), false);
  assert.equal(pressed(host, "module"), true, "the toggle is still on");
  assert.deepEqual(headersOf(host, "module"), [], "but a header every row is under divides nothing");
  v.close();
});

test("⌘⌥⇧M flattens the modules, and is not a choice while the module grouping is off", async () => {
  const host = await openUsages(MIXED);
  assert.equal(pressed(host, "flatten"), true, "isFlattenModules is true in UsageViewSettings");
  assert.equal(chip(host, "flatten").disabled, false);

  await press(host, { code: "KeyM", key: "m", metaKey: true, altKey: true }); // module grouping off
  assert.equal(chip(host, "flatten").disabled, true, "flattening is a property of a grouping that is off");
  assert.ok(chip(host, "flatten").classList.contains("unavailable"));

  await press(host, { code: "KeyM", key: "m", metaKey: true, altKey: true }); // and back on
  await press(host, { code: "KeyM", key: "M", metaKey: true, shiftKey: true, altKey: true });
  assert.equal(pressed(host, "flatten"), false);
  // This workspace declares no module groups (`group=` in modules.xml), so unflattening adds no level —
  // the honest outcome, and the module headers are untouched.
  assert.deepEqual(headersOf(host, "moduleGroup"), []);
  assert.deepEqual(labelsAt(host, "module"), ["Module: @acme/data", "Module: @acme/ui"]);
  host.v.close();
});

test("⌘⌥T turns the usage types off; the file grouping keeps the rows findable", async () => {
  const host = await openUsages(MIXED);
  assert.ok(headersOf(host, "type").length >= 2, "usage types are on by default");
  await press(host, { code: "KeyT", key: "t", metaKey: true, altKey: true });
  assert.deepEqual(headersOf(host, "type"), []);
  assert.ok(headersOf(host, "file").length >= 2, "isGroupByFileStructure is true, so a file is still a node");
  host.v.close();
});

test("⌘⌥P adds the directory, and the file header drops to the bare name under it", async () => {
  const host = await openUsages(MIXED);
  assert.ok(headersOf(host, "file").some((label) => label.includes("/")),
    "without a directory header the file node carries the whole path");
  await press(host, { code: "KeyP", key: "p", metaKey: true, altKey: true });
  assert.deepEqual(labelsAt(host, "directory"), ["Directory: packages/data/src", "Directory: packages/ui/src", "Directory: packages/ui/test"],
    "directory.0 is `Directory:{0}`");
  assert.ok(headersOf(host, "file").every((label) => !label.includes("/")),
    "and the path is now said once, above, so the file node is the name — IntelliJ's short file path");
  host.v.close();
});

// ---- the tree itself ------------------------------------------------------------------------------

test("a group node folds, and what it folds away is out of reach of the arrows too", async () => {
  const host = await openUsages(MIXED);
  const before = rowTypes(host).length;
  const node = host.v.$all("#quick-open-results .usage-group").filter((row) => row.dataset.usageGroup === "type")[0];
  assert.equal(node.querySelector(".usage-twisty").textContent, "▾");
  const folded = Number(node.querySelector(".usage-group-count").textContent.replace(/\D/g, ""));

  node.click();
  await host.v.settle(40);
  const after = host.v.$all("#quick-open-results .usage-group").filter((row) => row.dataset.usageGroup === "type")[0];
  assert.equal(after.querySelector(".usage-twisty").textContent, "▸", "the twisty says which way it is");
  assert.equal(after.getAttribute("aria-expanded"), "false");
  assert.equal(after.querySelector(".usage-group-count").textContent, `(${folded} usages)`,
    "a folded node still says how much is under it — that is what the count is for");
  assert.equal(rowTypes(host).length, before - folded);
  // The rows are gone from the list the arrows walk, not merely hidden: the index space is rebuilt from
  // what the tree hands back, so it is 0..n-1 over the rows that are actually on screen and Enter can
  // never reach one that is folded away.
  const indices = host.v.$all("#quick-open-results .usage-result").map((row) => Number(row.dataset.index));
  assert.deepEqual(indices, indices.map((_, at) => at));

  after.click();
  await host.v.settle(40);
  assert.equal(rowTypes(host).length, before, "and it comes back");
  host.v.close();
});

test("Collapse all and Expand all fold the whole tree", async () => {
  const host = await openUsages(MIXED);
  const rows = rowTypes(host).length;
  host.v.$('[data-usage-tree="collapse"]').click();
  await host.v.settle(40);
  assert.equal(rowTypes(host).length, 0, "nothing is left but the outermost nodes");
  assert.ok(host.v.$all("#quick-open-results .usage-group").length > 0);
  assert.ok(host.v.$all("#quick-open-results .usage-group").every((row) => row.classList.contains("is-collapsed")));

  host.v.$('[data-usage-tree="expand"]').click();
  await host.v.settle(40);
  assert.equal(rowTypes(host).length, rows);
  host.v.close();
});

test("a node carries IntelliJ's icon for what it is, and a usage-type node carries none", async () => {
  const host = await openUsages(MIXED);
  await press(host, { code: "KeyS", key: "s", metaKey: true, altKey: true }); // scope grouping on
  const nodes = host.v.$all("#quick-open-results .usage-group");
  const byRank = (rank) => nodes.filter((row) => row.dataset.usageGroup === rank);
  const testScope = byRank("scope").filter((row) => row.dataset.usageKey === "test")[0];
  assert.ok(testScope.querySelector(".usage-group-icon .folder-mark"), "the test scope wears the test folder mark");
  assert.ok(byRank("module")[0].querySelector(".usage-group-icon .folder-mark"), "and a module its own");
  assert.equal(byRank("type")[0].querySelector(".usage-group-icon"), null,
    "a usage-type node has no icon in IntelliJ either");
  assert.ok(byRank("file")[0].querySelector(".usage-group-icon"), "a file node takes the file tree's type icon");
  host.v.close();
});

test("the occurrence is picked out of the line it sits on", async () => {
  const host = await openUsages(MIXED);
  const hits = host.v.$all("#quick-open-results .usage-hit").map((hit) => hit.textContent);
  assert.ok(hits.length >= 3, `the usage itself is marked in each row: ${hits.length}`);
  assert.ok(hits.every((hit) => hit === "Store"), JSON.stringify(hits));
  // And the rest of the line is still there around it.
  const row = host.v.$("#quick-open-results .usage-result .usage-result-code");
  assert.match(row.textContent, /Store/);
  assert.ok(row.textContent.length > "Store".length, "the mark did not eat the line");
  host.v.close();
});

// ---- the filtering toolbar ------------------------------------------------------------------------

test("⌘⌥R, ⌘⌥W and ⌘⌥I hide read accesses, write accesses and imports", async () => {
  const host = await openUsages(MIXED);
  assert.deepEqual([pressed(host, "read"), pressed(host, "write"), pressed(host, "imports")], [true, true, true],
    "all three start on, as they do in IntelliJ");
  assert.ok(rowTypes(host).includes("read") && rowTypes(host).includes("write") && rowTypes(host).includes("import"));

  await press(host, { code: "KeyR", key: "r", metaKey: true, altKey: true });
  assert.ok(!rowTypes(host).includes("read"), `ReadAccessFilteringRule: ${rowTypes(host).join(" ")}`);
  assert.ok(rowTypes(host).includes("write"), "and nothing else went with it");

  await press(host, { code: "KeyW", key: "w", metaKey: true, altKey: true });
  assert.ok(!rowTypes(host).includes("write"));

  await press(host, { code: "KeyI", key: "i", metaKey: true, altKey: true });
  assert.ok(!rowTypes(host).includes("import"));
  // What is left is the comment: non-code, which has its own toggle (⌥P) and is not an access.
  assert.deepEqual(rowTypes(host), ["comment"]);
  host.v.close();
});

test("a filter that hides every usage says so, instead of saying there are none", async () => {
  const host = await openUsages(MIXED);
  for (const key of ["KeyR", "KeyW", "KeyI"]) {
    await press(host, { code: key, key: key.slice(3).toLowerCase(), metaKey: true, altKey: true });
  }
  await press(host, { code: "KeyP", key: "p", altKey: true }); // and the non-code toggle
  assert.equal(host.v.$all("#quick-open-results .usage-result").length, 0);
  assert.match(host.v.$("#quick-open-results").textContent, /All 5 usages are hidden by the filters/,
    "\"no usages\" when there are five and a filter is hiding them is the wrong answer");
  host.v.close();
});

test("a chip is the same toggle as its chord", async () => {
  const host = await openUsages(MIXED);
  chip(host, "scope").click();
  await host.v.settle(40);
  assert.equal(pressed(host, "scope"), true);
  assert.deepEqual(labelsAt(host, "scope"), ["Production", "Test"]);
  chip(host, "read").click();
  await host.v.settle(40);
  assert.ok(!rowTypes(host).includes("read"));
  host.v.close();
});

// ---- test code, marked ----------------------------------------------------------------------------

test("a test usage is marked as one before any grouping is turned on", async () => {
  const host = await openUsages(MIXED);
  const tagged = host.v.$all("#quick-open-results .usage-result.is-test");
  assert.equal(tagged.length, 1, "one of the five usages is in a test file");
  assert.equal(tagged[0].querySelector(".usage-result-tag").textContent, "Test");
  assert.match(host.v.$("#quick-open-filter").textContent, /1 in tests/,
    "and the count line says how much of the answer is test code");

  await press(host, { code: "KeyS", key: "s", metaKey: true, altKey: true });
  assert.equal(host.v.$("#quick-open-results .usage-result.is-test .usage-result-tag"), null,
    "with the Test header above it, the row saying it again is noise");
  host.v.close();
});

test("⌥P still drops the tests and the non-code usages together", async () => {
  const host = await openUsages(MIXED);
  await press(host, { code: "KeyP", key: "p", altKey: true });
  assert.deepEqual(rowTypes(host).sort(), ["read", "read", "write"]);
  assert.equal(host.v.$all("#quick-open-results .usage-result.is-test").length, 0);
  host.v.close();
});
