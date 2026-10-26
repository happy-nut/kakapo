// Find in Files' scope — IntelliJ's scope dropdown: In Project, Project Production Files, Project Test
// Files, Module.
//
// Two halves, and both are asserted, because they can disagree in a way that looks like "no results":
// the prefixes that go WITH the query (ripgrep is asked for 500 matches, so a scope applied afterwards
// would cut the wrong 500 first) and the exact rule applied to what comes back, which knows about path
// conventions no glob can express.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchPaths, projectSearchMatchAllowed } from "../dist/search.js";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

// ---- the searcher's half -------------------------------------------------------------------------

test("a scope prefix narrows the matches, and a path that climbs out is not a prefix", () => {
  const match = (path) => ({ path, line: 1, column: 1, text: "x", matchText: "x" });
  assert.equal(projectSearchMatchAllowed(match("packages/ui/src/a.ts"), { includePaths: ["packages/ui"] }), true);
  assert.equal(projectSearchMatchAllowed(match("packages/data/src/a.ts"), { includePaths: ["packages/ui"] }), false);
  assert.equal(projectSearchMatchAllowed(match("packages/ui"), { includePaths: ["packages/ui"] }), true,
    "the prefix covers the directory itself, not only what is under it");
  assert.equal(projectSearchMatchAllowed(match("packages/uix/a.ts"), { includePaths: ["packages/ui"] }), false,
    "and it is a path prefix, not a string prefix");
  assert.equal(projectSearchMatchAllowed(match("packages/ui/test/a.ts"), { excludePaths: ["packages/ui/test"] }), false);

  assert.deepEqual(normalizeSearchPaths(["./a/", "/b", "a/", "c/../d", 7, ""]), ["a", "b"],
    "repo-relative, de-duplicated, and nothing that climbs out of the repository");
});

// ---- the page's half -----------------------------------------------------------------------------

const UI = "packages/ui/src/Button.ts";
const UI_TEST = "packages/ui/test/Button.test.ts";
const DATA = "packages/data/src/store.ts";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "pnpm-workspace.yaml", after: "packages:\n  - 'packages/*'\n" },
    { path: "packages/ui/package.json", after: JSON.stringify({ name: "@acme/ui" }) },
    { path: "packages/data/package.json", after: JSON.stringify({ name: "@acme/data" }) },
    { path: UI, before: "const target = 1;\n", after: "const target = 2;\n" },
    { path: UI_TEST, before: "// old\n", after: "// target under test\n" },
    // Unchanged on purpose: the "Changed files" scope has to have something to leave out.
    { path: DATA, before: "const target = 3;\n", after: "const target = 3;\n" },
  ]));
});
after(cleanupFixtures);

async function openSearch() {
  const v = await loadViewer(html);
  v.window.openSourceFile(UI);
  await v.settle(40);
  await v.openQuickOpenSection("content");
  return v;
}
const scopes = (v) => Array.from(v.$("#quick-open-scope").options, (option) => option.value);
const paths = (v) => v.$all("#quick-open-results .quick-open-item")
  .map((row) => row.querySelector(".quick-open-badge").textContent).sort();

async function search(v, query) {
  v.typeInto(v.$("#quick-open-input"), query);
  await v.settle(180);
}

test("the scopes offered are IntelliJ's, with the module named after the open file's module", async () => {
  const v = await openSearch();
  assert.deepEqual(scopes(v), ["all", "production", "tests", "module", "changed"]);
  assert.match(v.$("#quick-open-scope").textContent, /Module: @acme\/ui/);
  assert.equal(v.$("#quick-open-scope").value, "all", "In Project is where a search starts");
  v.close();
});

test("Production files leaves the tests out; Test files leaves everything else out", async () => {
  const v = await openSearch();
  await search(v, "target");
  assert.deepEqual(paths(v), [DATA, UI, UI_TEST], "every file first");

  v.window.setContentSearchScope("production");
  await v.settle(180);
  assert.deepEqual(paths(v), [DATA, UI], "a test file is not a production file");

  v.window.setContentSearchScope("tests");
  await v.settle(180);
  assert.deepEqual(paths(v), [UI_TEST]);
  v.close();
});

test("the module scope is the open file's module, and it moves with the open file", async () => {
  const v = await openSearch();
  v.window.setContentSearchScope("module");
  await search(v, "target");
  assert.deepEqual(paths(v), [UI, UI_TEST], "@acme/ui, tests and all");

  v.key("Escape");
  await v.settle(20);
  v.window.openSourceFile(DATA);
  await v.settle(40);
  await v.openQuickOpenSection("content");
  await search(v, "target");
  assert.match(v.$("#quick-open-scope").textContent, /Module: @acme\/data/);
  assert.deepEqual(paths(v), [DATA], "the scope follows the file, as IntelliJ's Module scope does");
  v.close();
});

test("Changed files is the review's own scope", async () => {
  const v = await openSearch();
  v.window.setContentSearchScope("changed");
  await search(v, "target");
  assert.deepEqual(paths(v), [UI, UI_TEST], "store.ts has the word and no change in it");
  v.close();
});

test("⌥S cycles the scope, and the prefixes that go with the query follow it", async () => {
  const v = await openSearch();
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyS", key: "s", altKey: true }));
  await v.settle(40);
  assert.equal(v.$("#quick-open-scope").value, "production", "the next scope round");
  assert.deepEqual(Array.from(v.window.projectScopePrefixes("production").exclude), ["packages/ui/test"],
    "and production is sent as the project minus its declared test roots");
  assert.deepEqual(Array.from(v.window.projectScopePrefixes("tests").include), ["packages/ui/test"]);
  assert.deepEqual(Array.from(v.window.projectScopePrefixes("module").include), ["packages/ui"]);
  assert.deepEqual(Array.from(v.window.projectScopePrefixes("changed").include), [],
    "and a scope no glob can express narrows nothing rather than nearly");
  v.close();
});

test("a single-module repository is not offered a module scope", async () => {
  const { html: plain } = await makeReviewHtml([
    { path: "src/index.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
  ]);
  const v = await loadViewer(plain);
  v.window.openSourceFile("src/index.ts");
  await v.settle(40);
  await v.openQuickOpenSection("content");
  assert.deepEqual(scopes(v), ["all", "production", "tests", "changed"],
    "it would be the whole project under another name");
  v.close();
});
