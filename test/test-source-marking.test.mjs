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

  // A module is a NODE, labelled with the module's name rather than its folder's — "@acme/ui" lives in
  // packages/ui — and it sits at the top of the tree, not under the packages/ folder it happens to be in.
  const uiRoot = dirRow(v, "packages/ui");
  assert.ok(uiRoot, "the module root is a row");
  assert.equal(uiRoot.dataset.module, "@acme/ui", "it says which module it is");
  assert.equal(uiRoot.querySelector(":scope > summary .path").textContent, "@acme/ui",
    "and is LABELLED with that name, from its own package.json, not with the folder's");
  assert.equal(uiRoot.style.getPropertyValue("--depth"), "0", "modules are the top of the tree");
  assert.equal(dirRow(v, "packages"), null, "so the folder they live in is not a row at all");
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


// IntelliJ's Project window makes the module the top node and hangs the content root's files under it, so
// a reviewer reads "which module changed" before "which folder". That is a different tree, not a label: in
// a monorepo the modules come out flat at the top under their own names, the packages/ folder they live in
// stops being a row, and what is left of each path hangs under its module.
//
// The two trees are built separately (render-tree.ts twice) and a third time in the viewer for the deferred
// tree, so the grouping decision is shared (moduleEntryFor) — the same file hanging under a module in one
// tree and under its raw path in another would be two answers to one question.
test("modules are the top of the tree, under their own names", async () => {
  const pkg = (name) => JSON.stringify({ name });
  const unchanged = (path, body) => ({ path, before: body, after: body });
  const { html: mono } = await makeReviewHtml([
    unchanged("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"),
    unchanged("packages/api/package.json", pkg("@acme/api")),
    unchanged("packages/web/package.json", pkg("@acme/web")),
    { path: "packages/api/src/deep/handler.ts", before: "export const h = 1;\n", after: "export const h = 2;\n" },
    { path: "packages/web/src/App.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "tools/build.ts", before: "export const z = 1;\n", after: "export const z = 2;\n" },
  ]);
  const v = await loadViewer(mono);
  const label = (row) => row?.querySelector(":scope > summary .path")?.textContent ?? null;
  const depth = (row) => row?.style.getPropertyValue("--depth") ?? null;

  for (const kind of ["changes-dir", "source-dir"]) {
    const api = v.$(`.tree-dir.${kind}[data-dir="packages/api"]`);
    assert.equal(label(api), "@acme/api", `${kind}: the module node carries the module's name`);
    assert.equal(depth(api), "0", `${kind}: and sits at the top of the tree`);
    assert.equal(v.$(`.tree-dir.${kind}[data-dir="packages"]`), null,
      `${kind}: the folder the modules live in is not a row — they were lifted out of it`);
    assert.equal(depth(v.$(`.tree-dir.${kind}[data-dir="tools"]`)), "0",
      `${kind}: a folder in no module stays where it was`);
  }

  // The chain below a module still folds — only the module node itself refuses to, or the top of the tree
  // would read "@acme/api/src/deep" and the module's name would be part of a path.
  assert.equal(label(v.$('.tree-dir.changes-dir[data-dir="packages/api/src/deep"]')), "src/deep",
    "the folders under a module fold into one row as they always did");

  // The module node is labelled, so it must not ALSO be badged with the same name.
  assert.equal(v.$(".tree-module"), null, "no badge repeats the name the node already carries");
  v.close();
});
