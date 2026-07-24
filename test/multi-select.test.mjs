// CORE USER FLOW: multi-select changed files to mark them all viewed at once (#1).
//
// The reviewer builds a contiguous selection with Shift+Arrow (keyboard) or Shift+Click (mouse) in the Changes
// panel, then Space toggles Viewed for the whole run — if any is unviewed they all become viewed, and a second
// Space unviews them together.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

async function threeChangedFiles() {
  const { html } = await makeReviewHtml([
    { path: "a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
    { path: "c.ts", before: "export const c = 1;\n", after: "export const c = 2;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openDiffFor("a.ts"); // ensure the diff view + Changes panel are active
  return v;
}

test("Shift+Arrow builds a multi-selection and Space marks every selected file viewed, then unviews them (#1)", async () => {
  const v = await threeChangedFiles();
  v.window.focusTree(0);
  await v.settle(40);
  v.key("ArrowDown", { shiftKey: true });
  await v.settle(20);
  v.key("ArrowDown", { shiftKey: true });
  await v.settle(20);
  assert.ok(v.$all(".tree-selected").length >= 2, "shift+arrow highlights a multi-row selection");

  v.key(" ", { code: "Space" });
  await v.settle(30);
  assert.ok(v.window.isFileViewed("a.ts") && v.window.isFileViewed("b.ts") && v.window.isFileViewed("c.ts"),
    "Space marks every selected file viewed");

  v.key(" ", { code: "Space" });
  await v.settle(30);
  assert.ok(!v.window.isFileViewed("a.ts") && !v.window.isFileViewed("c.ts"),
    "a second Space unviews the whole selection together");
  v.close();
});

test("Shift+Click extends the selection without opening, and a plain click clears it (#1)", async () => {
  const v = await threeChangedFiles();
  const rows = v.window.treeRows().filter((r) => r.classList.contains("change-row"));
  assert.ok(rows.length >= 3, "three change rows are present");
  v.window.focusTree(0); // anchor on the first row
  await v.settle(30);
  v.click(rows[2]); // plain click resets selection + focus to row 2
  await v.settle(20);
  assert.equal(v.$all(".tree-selected").length, 0, "a plain click clears any multi-selection");

  // Shift+click from row 2 back to row 0 selects the range.
  rows[0].dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
  await v.settle(20);
  assert.ok(v.$all(".tree-selected").length >= 2, "shift+click extends a range selection");
  v.key(" ", { code: "Space" });
  await v.settle(30);
  assert.ok(v.window.isFileViewed("a.ts") && v.window.isFileViewed("c.ts"), "Space marks the shift+click range viewed");
  v.close();
});
