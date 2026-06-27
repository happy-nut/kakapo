// Cmd+L (go to line) / Cmd+K (copy file:line) and the sidebar Opt+Enter row-action menu.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n", after: "export const x = 1;\nexport const y = 2;\nexport const z = 9;\n" },
    { path: "README.md", before: "# Hi\n", after: "# Hello\n" },
  ]));
});
after(cleanupFixtures);

test("caretLocation reports path:line and gotoLineJump moves the source caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  v.window.setSourceCursor("src/app.ts", 0, 0, false, -1); // line 1
  assert.equal(v.window.caretLocation(), "src/app.ts:1", "Cmd+K would copy line 1");
  v.window.gotoLineJump(3); // Cmd+L → line 3
  await v.settle(20);
  assert.equal(v.window.caretLocation(), "src/app.ts:3", "gotoLineJump moved the caret to line 3");
  v.window.gotoLineJump(999); // clamp to the last line (3 lines + a trailing empty line = 4)
  await v.settle(20);
  assert.equal(v.window.caretLocation(), "src/app.ts:4", "out-of-range line clamps to the last line");
  v.close();
});

test("Opt+Enter on a sidebar file row opens the action menu with Copy path", async () => {
  const v = await loadViewer(html);
  const row = v.$(".file-link[data-source-file]"); // a source-tree file row
  assert.ok(row, "the source tree has a file row");
  v.window.openTreeRowMenu(row);
  await v.settle(10);
  const dd = v.$("#mc-dropdown");
  assert.ok(dd, "the row-action dropdown opened");
  assert.match(dd.textContent, /Copy path/, "it offers Copy path");
  v.close();
});
