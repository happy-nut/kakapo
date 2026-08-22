// The toolbars that sit in the window's title strip are -webkit-app-region: drag, so the WINDOW takes the
// mouse press and the page never sees the click. Anything in them that responds to a click has to say
// no-drag. The file tabs are <div>s whose only <button> is the × — so the exemption list covered closing a
// tab and not opening one, and clicking a tab silently did nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");

/** The selector list of every rule that hands interaction back to the page. Split on braces rather than
 *  matched with one regex: a selector-list pattern over a 3000-line stylesheet backtracks for minutes. */
function noDragSelectors() {
  const selectors = [];
  const blocks = css.split("}");
  for (const block of blocks) {
    const [head, body] = block.split("{");
    if (!body || !/-webkit-app-region:\s*no-drag/.test(body)) continue;
    selectors.push(...head.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return selectors;
}

test("every clickable thing in a title-strip toolbar opts out of the drag region", () => {
  const selectors = noDragSelectors();
  assert.ok(
    selectors.includes("body.native-app .source-tabs .source-tab"),
    "a file tab is clicked to open its file, so it cannot be part of the window's drag handle",
  );
  for (const bar of [".diff-toolbar", ".source-toolbar", ".source-tabs"]) {
    assert.ok(
      selectors.some((selector) => selector.includes(bar) && selector.endsWith("button")),
      `${bar} buttons opt out of the drag region`,
    );
  }
});
