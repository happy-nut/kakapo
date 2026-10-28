// Test code and modules, marked wherever this app lists a path.
//
// IntelliJ's answer to "which of these files is a test?" is never a separate view: a test source root has
// its own icon in the project tree, every row under it inherits it, and Go to File puts the module name on
// the right of every row. That is the division this guards — the same two facts said in the file tree, the
// changes tree, the file popup and the Problems list, from one classification (14-project-layout.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const UI = "packages/ui/src/Button.ts";
const UI_TEST = "packages/ui/test/Button.test.ts";
const DATA = "packages/data/src/store.ts";
const GENERATED = "packages/ui/generated/schema.ts";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "pnpm-workspace.yaml", after: "packages:\n  - 'packages/*'\n" },
    { path: "packages/ui/package.json", after: JSON.stringify({ name: "@acme/ui" }) },
    { path: "packages/data/package.json", after: JSON.stringify({ name: "@acme/data" }) },
    { path: UI, before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: UI_TEST, before: "// old\n", after: "// a check of Button\n" },
    { path: GENERATED, before: "export type A = 1;\n", after: "export type A = 2;\n" },
    { path: DATA, before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]));
});
after(cleanupFixtures);

const sourceRow = (v, path) => v.$(`.source-link[data-source-file="${path}"]`);
const changeRow = (v, path) => v.$(`.change-row[data-file="${path}"]`);
const dirRow = (v, path) => v.$(`.tree-dir[data-dir="${path}"]`);
const rowTags = (row) => Array.from(row.querySelectorAll(".row-tag"), (tag) => tag.textContent);

test("the file tree marks test code, generated code, and which directory is a module", async () => {
  const v = await loadViewer(html);
  assert.ok(sourceRow(v, UI_TEST).classList.contains("is-test-file"), "a file under a test root is test code");
  assert.ok(!sourceRow(v, UI).classList.contains("is-test-file"), "and its subject is not");
  assert.ok(sourceRow(v, GENERATED).classList.contains("is-generated-file"),
    "`generated/` is a generated root — IntelliJ's generated=\"true\" without the declaration");

  // The directory rows compact single-child chains, so a module root is not always a row of its own. The
  // badge goes on the row that OPENS the module either way.
  const uiRoot = dirRow(v, "packages/ui");
  assert.ok(uiRoot, "packages/ui is a row of its own, since it has more than one child");
  assert.equal(uiRoot.querySelector(".tree-module").textContent, "@acme/ui",
    "the module's name, from its own package.json");
  assert.equal(dirRow(v, "packages/ui/test").classList.contains("is-test-root"), true);
  assert.equal(dirRow(v, "packages/ui/src").classList.contains("is-test-root"), false);
  v.close();
});

test("the changes tree marks the same files the same way", async () => {
  const v = await loadViewer(html);
  assert.ok(changeRow(v, UI_TEST).classList.contains("is-test-file"));
  assert.ok(!changeRow(v, UI).classList.contains("is-test-file"));
  assert.ok(changeRow(v, GENERATED).classList.contains("is-generated-file"));
  v.close();
});

test("Go to File says which module a row is in, and which rows are tests", async () => {
  const v = await loadViewer(html);
  await v.openQuickOpenSection("all");
  v.typeInto(v.$("#quick-open-input"), "Button");
  await v.settle(60);
  const rows = v.$all("#quick-open-results .quick-open-item");
  assert.ok(rows.length >= 2, `both Buttons are listed: ${rows.length}`);
  const byPath = new Map(rows.map((row) => [row.querySelector(".quick-open-path").textContent, row]));
  assert.deepEqual(rowTags(byPath.get(UI)), ["@acme/ui"], "the module, which is the thing that tells them apart");
  assert.deepEqual(rowTags(byPath.get(UI_TEST)), ["Test", "@acme/ui"], "and the test, said before the module");
  v.close();
});

test("the Problems list carries the same two tags", async () => {
  const v = await loadViewer(html, {
    diagnosticsBridge: (path) => ({
      ok: true,
      available: true,
      diagnostics: path === UI_TEST
        ? [{ lineIndex: 0, column: 0, severity: "error", message: "expected", source: "ts" }]
        : [],
    }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, code: "Digit6", key: "6", metaKey: true }));
  await v.settle(160);
  const row = v.$("#quick-open-results .problem-result");
  assert.ok(row, "the one problem is listed");
  assert.deepEqual(rowTags(row), ["Test", "@acme/ui"], "a problem in a test file says so, as its row does everywhere else");
  v.close();
});

test("the caret peek says which module each location is in", async () => {
  // The peek panel is Electron-only markup, so this one needs the app review: without it openSemanticPeek
  // falls back to the ⌘B popup, which is a different surface.
  const { html: appHtml } = await makeReviewHtml([
    { path: "pnpm-workspace.yaml", after: "packages:\n  - 'packages/*'\n" },
    { path: "packages/ui/package.json", after: JSON.stringify({ name: "@acme/ui" }) },
    { path: "packages/data/package.json", after: JSON.stringify({ name: "@acme/data" }) },
    { path: UI, before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: DATA, before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  v.window.openSourceFile(UI);
  await v.settle(40);
  // The peek is the ⌘B/⌥G panel. Called directly: what is being guarded is the row, not the question.
  v.window.openSemanticPeek("Button", [
    { path: UI, lineIndex: 0, column: 0, text: "export const a = 2;" },
    { path: DATA, lineIndex: 0, column: 0, text: "export const b = 2;" },
  ], { ok: true, engine: "lsp", confidence: "semantic" }, "references");
  await v.settle(40);
  const tags = v.$all("#semantic-peek .semantic-peek-item .row-tag").map((tag) => tag.textContent);
  assert.deepEqual(tags, ["@acme/ui", "@acme/data"],
    "two rows that would otherwise differ only by a line number");
  assert.equal(v.$("#semantic-peek .row-tag.is-test"), null,
    "and not the test tag — the peek marks those rows itself");
  v.close();
});

test("the editor tab is tinted too, except while it is the active one", async () => {
  const v = await loadViewer(html);
  v.window.openSourceFile(UI);
  await v.settle(40);
  v.window.openSourceFile(UI_TEST);
  await v.settle(40);
  const tab = (path) => v.$(`.source-tab[data-tab-path="${path}"]`);
  assert.ok(tab(UI_TEST).classList.contains("is-test-file"), "the test file's tab says so");
  assert.ok(!tab(UI).classList.contains("is-test-file"));
  // The active tab keeps its own background: "this is the one on screen" outranks "this is test code".
  assert.ok(tab(UI_TEST).classList.contains("active"));
  v.close();
});

test("a single-module repository gets no module tags at all", async () => {
  const { html: plain } = await makeReviewHtml([
    { path: "src/index.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "test/index.test.ts", before: "// old\n", after: "// a check\n" },
  ]);
  const v = await loadViewer(plain);
  await v.openQuickOpenSection("all");
  v.typeInto(v.$("#quick-open-input"), "index");
  await v.settle(60);
  const tags = v.$all("#quick-open-results .row-tag").map((tag) => tag.textContent);
  assert.deepEqual(tags, ["Test"], "the test is still marked; the one module is not a division");
  assert.equal(v.$(".tree-module"), null, "and no directory is badged with it either");
  v.close();
});

test("a watch refresh that moves a test root re-marks the trees", async () => {
  const v = await loadViewer(html);
  assert.ok(sourceRow(v, UI_TEST).classList.contains("is-test-file"));
  // The same review, told that `packages/ui/src` is now the test root and `test` is not. Nothing but the
  // layout changed, so if the marking were done once at render this assertion would fail.
  v.window.setProjectLayout({
    modules: [{ name: "@acme/ui", root: "packages/ui" }, { name: "@acme/data", root: "packages/data" }],
    testRoots: ["packages/ui/src"],
    generatedRoots: [],
    source: "intellij",
  });
  await v.settle(20);
  assert.ok(sourceRow(v, UI).classList.contains("is-test-file"), "the new root's files are test code");
  assert.ok(dirRow(v, "packages/ui/src").classList.contains("is-test-root"));
  assert.ok(!dirRow(v, "packages/ui/test").classList.contains("is-test-root"),
    "and the old root is not a root any more");
  // `Button.test.ts` is still a test by the path convention, which is the fallback and still applies.
  assert.ok(sourceRow(v, UI_TEST).classList.contains("is-test-file"));
  v.close();
});

// A registry-level guard rather than another rendered list: the failure this protects against is the NEXT
// list, written months from now, that prints a path and forgets to say which module it is in. Every slice
// that prints a row's location has to go through the one tagger, or name itself here as an exception.
test("every viewer list that prints a path says which module it is", () => {
  const dir = join(import.meta.dirname, "..", "src", "viewer");
  // Exceptions, each for a reason: the structure popup lists one file's symbols (there is no second module
  // to tell it from), Find Action lists commands with no file at all, the layout slice IS the tagger, and
  // the usage view says both facts through its own grouping — the module is a header there, and the test
  // tag is printed on the row only while the Production/Test grouping is off.
  const exempt = new Set(["16-structure.js", "19-find-action.js", "14-project-layout.js", "17-find-usages.js"]);
  const missing = readdirSync(dir).filter((file) => file.endsWith(".js")).filter((file) => {
    const source = readFileSync(join(dir, file), "utf8");
    return source.includes('class="quick-open-path"') && !source.includes("projectRowTagsHtml");
  }).filter((file) => !exempt.has(file));
  assert.deepEqual(missing, [], "these print a row's path without tagging its module");
  // …and the one exception that is NOT exempt must stay tagged: 16-structure.js holds the hierarchies and
  // recent locations as well as the structure popup, and those two do list other files.
  const structure = readFileSync(join(dir, "16-structure.js"), "utf8");
  assert.equal((structure.match(/projectRowTagsHtml/g) ?? []).length, 3,
    "recent locations, the hierarchies and the bookmarks — the three lists in that slice that leave the open file");
});


// A module root is not always a row. Both trees collapse a single-child directory chain into one row
// ("packages/api/src"), so a module whose root holds one changed folder has no row at its root at all —
// and matching the root against data-dir lost that module's name and its icon completely, while a sibling
// module with two changed folders kept both. A module disappeared from the sidebar for being small.
//
// The two trees collapse DIFFERENTLY: the changes tree holds only what changed, the source tree also holds
// the module's unchanged package.json, so the same module opens at a different row in each. That is why the
// row is resolved per tree rather than once for the document.
test("a module whose root collapsed into the path above it still says which module it is", async () => {
  const pkg = (name) => JSON.stringify({ name });
  const unchanged = (path, body) => ({ path, before: body, after: body });
  const { html: collapsed } = await makeReviewHtml([
    unchanged("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"),
    unchanged("packages/api/package.json", pkg("@acme/api")),
    unchanged("packages/web/package.json", pkg("@acme/web")),
    { path: "packages/api/src/handler.ts", before: "export const h = 1;\n", after: "export const h = 2;\n" },
    { path: "packages/web/src/App.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "packages/web/test/App.test.ts", before: "// old\n", after: "// a check of App\n" },
  ]);
  const v = await loadViewer(collapsed);
  const ownBadge = (row) => row?.querySelector(":scope > summary > .tree-module")?.textContent ?? null;
  const ownMark = (row) => Boolean(row?.querySelector(":scope > summary .folder-mark"));

  // @acme/api changed one folder, so the changes tree collapsed its root away entirely.
  assert.equal(v.$('.tree-dir.changes-dir[data-dir="packages/api"]'), null,
    "precondition: the changes tree has no row at the module root — the chain swallowed it");
  const apiChanges = v.$('.tree-dir.changes-dir[data-dir="packages/api/src"]');
  assert.equal(ownBadge(apiChanges), "@acme/api", "the collapsed row names the module it opens");
  assert.ok(ownMark(apiChanges), "and carries IntelliJ's module mark on its folder");
  assert.ok(apiChanges.classList.contains("has-module"),
    "and opens the third grid track, or the badge wraps onto its own line");

  // The source tree kept the root as a row (the unchanged package.json is a second child), so the SAME
  // module is marked one level higher there. Resolving once for the document would mark only one of them.
  const apiSource = v.$('.tree-dir.source-dir[data-dir="packages/api"]');
  assert.equal(ownBadge(apiSource), "@acme/api", "the source tree marks the root itself");
  assert.equal(ownBadge(v.$('.tree-dir.source-dir[data-dir="packages/api/src"]')), null,
    "and not the folder inside it as well");

  // The module that did not collapse is unchanged by any of this, and a test root still wins its folder.
  assert.equal(ownBadge(v.$('.tree-dir.changes-dir[data-dir="packages/web"]')), "@acme/web");
  assert.equal(ownBadge(v.$('.tree-dir.changes-dir[data-dir="packages"]')), null,
    "the folder ABOVE two modules is not one of them");
  const webTest = v.$('.tree-dir.changes-dir[data-dir="packages/web/test"]');
  assert.ok(webTest.classList.contains("is-test-root"), "a test root inside a module is still a test root");
  assert.equal(ownBadge(webTest), null, "and is not relabelled with the module's name");
  v.close();
});
