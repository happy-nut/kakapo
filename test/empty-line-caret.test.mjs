import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let v;
before(async () => {
  const { html } = await makeReviewHtml([
    {
      path: "src/a.ts",
      before: "export const one = 1;\nexport const two = 2;\n\nexport const three = 3;\n",
      after: "export const one = 1;\nexport const two = 22;\n\nexport const three = 3;\n",
    },
  ]);
  v = await loadViewer(html);
});
after(() => { if (v) v.close(); cleanupFixtures(); });

function emptyRowIndex() {
  const wrapper = v.window.diffWrapperByPath("src/a.ts");
  const rows = v.window.diffRowsOf(v.window.diffSideTable(wrapper, "new"));
  for (let i = 1; i < rows.length; i += 1) {
    if (!rows[i].querySelector(".d2h-code-line-ctn")) continue;
    if (v.window.diffLineText(rows[i]).length === 0) return { wrapper, rows, index: i };
  }
  throw new Error("fixture has no empty code row");
}

test("the caret on a blank diff line is placed, not left at its static position", () => {
  const { wrapper, index } = emptyRowIndex();
  v.window.setDiffCursor("src/a.ts", "new", index, 0, false);
  const row = v.window.diffRowAt(wrapper, "new", index);
  const caret = row.querySelector(".code-cursor");
  assert.ok(caret, "a blank line still gets a caret");
  assert.ok(caret.classList.contains("code-cursor-empty"), "blank-line caret uses the shared placed-caret class");
  assert.equal(caret.style.position, "", "placement comes from the stylesheet, not an inline position");
});

test("a line with code keeps its inline caret", () => {
  const wrapper = v.window.diffWrapperByPath("src/a.ts");
  const rows = v.window.diffRowsOf(v.window.diffSideTable(wrapper, "new"));
  const index = rows.findIndex((row, i) => i > 0 && v.window.diffLineText(row).length > 0);
  v.window.setDiffCursor("src/a.ts", "new", index, 0, false);
  const caret = v.window.diffRowAt(wrapper, "new", index).querySelector(".code-cursor");
  assert.ok(caret, "a code line gets a caret");
  assert.equal(caret.classList.contains("code-cursor-empty"), false,
    "a caret inside real text is positioned by the text itself");
});

test("the stylesheet starts the diff's blank-line caret at column 0", () => {
  const css = readFileSync(join(HERE, "..", "dist", "viewer.css"), "utf8");
  assert.match(css, /\.d2h-code-line-ctn\s*>\s*\.code-cursor-empty\s*\{[^}]*left:\s*0/);
});
