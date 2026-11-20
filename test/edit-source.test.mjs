import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const { SHORTCUTS } = await import("../dist/shortcuts.js");

after(cleanupFixtures);

const CMD_DOWN = { key: "ArrowDown", code: "ArrowDown", metaKey: true };

async function twoChangedFiles() {
  const { html } = await makeReviewHtml([
    { path: "a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openDiffFor("a.ts");
  return v;
}

test("⌘↓ is EditSource, the key IntelliJ gives it, and not a second key for the declaration", () => {
  const holders = SHORTCUTS.filter((s) => s.keys.includes("⌘↓")).map((s) => s.id);
  assert.deepEqual(holders, ["editSource"], "one action owns ⌘↓");
  assert.deepEqual(SHORTCUTS.find((s) => s.id === "editSource").keys, ["⌘↓", "F4"],
    "both of IntelliJ's own keys for EditSource");
  assert.deepEqual(SHORTCUTS.find((s) => s.id === "goToDef").keys, ["⌘B"],
    "GotoDeclaration is meta B alone in IntelliJ's Mac keymap");
});

test("⌘↓ opens the source of the row selected in the tree", async () => {
  const v = await twoChangedFiles();
  v.window.focusTree(0);
  await v.until(() => v.$(".tree-selected, .tree-focus-row") !== null, 1000);

  const rows = v.window.treeRows();
  const index = rows.findIndex((r) => (r.dataset.file || "") === "b.ts");
  assert.ok(index >= 0, "b.ts has a row in the tree");
  v.window.focusTree(index);
  await v.settle(40);

  v.key("ArrowDown", CMD_DOWN);
  const opened = await v.until(() => v.window.activeDiffPath() === "b.ts", 2000);
  assert.ok(opened, `⌘↓ opened the selected row, got ${v.window.activeDiffPath()}`);
  v.close();
});

test("⌘↓ in the diff opens the source of the line at the caret", async () => {
  const v = await twoChangedFiles();
  v.window.clearTreeFocus();
  await v.settle(40);
  assert.ok(v.window.isDiffViewVisible(), "the review opens on the diff");

  v.key("ArrowDown", CMD_DOWN);
  const opened = await v.until(() => v.window.isSourceViewerVisible() && v.window.sourceOpenPath() === "a.ts", 2500);
  assert.ok(opened, `⌘↓ opened the diff file's source, got ${v.window.sourceOpenPath()}`);
  v.close();
});

test("⌘↓ declines in the editor, where IntelliJ's EditSource is disabled", async () => {
  const v = await twoChangedFiles();
  v.window.clearTreeFocus();
  v.window.openSourceFile("a.ts");
  await v.until(() => v.window.isSourceViewerVisible() && !v.window.isDiffViewVisible(), 2500);

  let asked = 0;
  const real = v.window.goToDefinitionUnderCursor;
  v.window.goToDefinitionUnderCursor = () => { asked += 1; };
  const declined = v.window.SHORTCUT_ACTIONS.editSource(new v.window.KeyboardEvent("keydown", CMD_DOWN), 0);
  v.window.goToDefinitionUnderCursor = real;

  assert.equal(asked, 0, "⌘↓ never asks for a declaration");
  assert.equal(declined, false, "and declines the key so nothing else is suppressed");
  v.close();
});
