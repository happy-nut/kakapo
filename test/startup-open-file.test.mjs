// The page comes up with a file already open — and every slice after that still initialises.
//
// This is the shape of a bug that took the whole app out and that no other test could see: the viewer
// bundle is one concatenated script, SLICE ORDER IS EXECUTION ORDER, and 05-keymap.js reopens the file
// you had open at its own top level. Anything that render touches which lives in a LATER slice is
// `undefined` at that moment — and a throw at slice 5 means slices 6..29 never run at all. The source
// view is slice 10, so the window comes up with a file tree, a toolbar, and no code in it, for every
// file, until the app is relaunched without a remembered file.
//
// Every other test opens its file by calling openSourceFile() after the page has fully loaded, which is
// precisely the case that cannot reproduce it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const OTHER = "src/other.ts";
const UI_STATE_KEY = "kakapo-diff-ui:/review.html";
const SOURCE = ["export class Store {", "  load() {", "    return 1;", "  }", "}"].join("\n");

let html;
before(async () => {
  // `openPath` is what the app passes for "the file this window had open"; it is also what
  // `kakapo <file>` passes. Either way the page opens it before the bundle has finished loading.
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" },
    { path: "src/store.test.ts", before: "", after: "import { Store } from './store';\n" },
    { path: OTHER, before: "export const other = 1;\n", after: "export const other = 2;\n" },
  ], { app: true, openPath: FILE }));
});
after(cleanupFixtures);

test("a review that opens a file at load paints that file's code", async () => {
  const v = await loadViewer(html);
  await v.settle(60);
  assert.equal(v.$("#source-viewer").dataset.openPath, FILE);
  const rows = v.$all("#source-body .source-row");
  assert.ok(rows.length >= 5, `the file's lines are painted: ${rows.length} rows`);
  assert.match(v.$("#source-body").textContent, /export class Store/);
  v.close();
});

test("and every slice after the one that opened it still ran", async () => {
  const v = await loadViewer(html);
  await v.settle(60);
  // One name from each slice that loads after 05-keymap.js. A throw in that slice's top-level code takes
  // all of them out at once, which is the failure this file exists for — and which reads, on screen, as
  // "the code stopped showing".
  for (const [slice, name] of [
    ["06-diff-caret", "setDiffCursor"],
    ["07-comments", "showCaretHint"],
    ["09-views-update", "applyViewedState"],
    ["10-source-view", "openSourceFile"],
    ["13-goto", "openGotoLine"],
    ["14-project-layout", "projectScopeOf"],
    ["15-semantic-navigation", "queryProjectAnalysis"],
    ["16-structure", "openFileStructure"],
    ["17-find-usages", "openFindUsages"],
    ["18-code-insight", "openProblemsView"],
    ["19-find-action", "openFindAction"],
  ]) {
    assert.equal(typeof v.window[name], "function", `${slice} did not initialise (${name})`);
  }
  v.close();
});

test("the file tree is marked, which is the other thing that render touches", async () => {
  const v = await loadViewer(html);
  await v.settle(60);
  // markProjectLayoutInTrees() runs at slice 14's top level, after the file was opened at slice 5's.
  // Both orders have to work: the one that classified the tab, and the one that marked the tree.
  const row = v.$('.source-link[data-source-file="src/store.test.ts"]');
  assert.ok(row && row.classList.contains("is-test-file"), "the test file is marked after a startup open");
  v.close();
});

// The worse version, and the one that actually shipped: the window comes back with the TABS it had.
// `renderSourceTabs` draws nothing at all for a single file — the breadcrumb already names it — so the
// tab strip, and everything the strip asks about each file, only runs once a second tab exists. That is
// why opening one file at load was not enough to catch this.
test("a review that restores SEVERAL tabs at load paints the code too", async () => {
  const { html: tabsHtml } = await makeReviewHtml([
    { path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" },
    { path: OTHER, before: "export const other = 1;\n", after: "export const other = 2;\n" },
  ], { app: true });
  const v = await loadViewer(tabsHtml, {
    seedSession: { [UI_STATE_KEY]: JSON.stringify({ view: "source", sourcePath: FILE, tabs: [FILE, OTHER] }) },
  });
  await v.settle(80);
  assert.equal(v.$all(".source-tab").length, 2, "both tabs are back");
  assert.ok(v.$all("#source-body .source-row").length >= 5, "and the open file's code is painted");
  assert.match(v.$("#source-body").textContent, /export class Store/);
  // The same slices as above: a throw while drawing the tab strip takes every one of them out.
  assert.equal(typeof v.window.openFindUsages, "function", "and the slices after it still ran");
  assert.equal(typeof v.window.openProblemsView, "function");
  v.close();
});
