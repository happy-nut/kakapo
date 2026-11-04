// The caret on a blank line in the diff.
//
// `position: absolute` with no offsets does not place anything — it keeps the element's STATIC position,
// and the static position of a span appended after the `<br>` that is a blank line's whole content is the
// line below the one the row shows. Measured in the real app on a 20px row: the 15px caret started 18px
// down and drew 13px of itself across the next row, which is the "the caret straddles the blank line"
// report. jsdom has no layout, so the geometry is not what is pinned here; what is pinned is the thing that
// produced it — whether the empty-line caret is PLACED (the shared .code-cursor-empty rule, which the
// source view has used all along) or merely taken out of the flow and left where it fell.
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
  // Line 3 is blank on both sides, so it is a real context row with an empty code cell — not diff2html's
  // aligned placeholder, which is a different element with its own styling.
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
  // The class carries position/left/top/transform together. An inline `position: absolute` on its own is
  // exactly the half-fix this replaces, so its absence is as much the assertion as the class's presence.
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
  // The shared rule insets by 10px for the source view, whose cell owns that padding. The diff's anchor is
  // the line container INSIDE an already-padded cell, so inheriting the inset would draw the caret a
  // character to the right of where the same file's other carets sit.
  const css = readFileSync(join(HERE, "..", "dist", "viewer.css"), "utf8");
  assert.match(css, /\.d2h-code-line-ctn\s*>\s*\.code-cursor-empty\s*\{[^}]*left:\s*0/);
});
