import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const WIDTH = 400;
const CONTENT = 2000;
const MARGIN = 80;

let v;
before(async () => {
  const { html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]);
  v = await loadViewer(html);
});
after(() => { if (v) v.close(); cleanupFixtures(); });

function makePane({ overflowX = "auto", contentWidth = CONTENT } = {}) {
  const scroller = v.document.createElement("div");
  scroller.style.overflowX = overflowX;
  v.document.body.appendChild(scroller);
  Object.defineProperty(scroller, "clientWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(scroller, "scrollWidth", { value: contentWidth, configurable: true });
  scroller.scrollLeft = 0;
  scroller.getBoundingClientRect = () => ({ left: 0, right: WIDTH, width: WIDTH, top: 0, bottom: 20, height: 20 });

  const caret = v.document.createElement("span");
  caret.className = "code-cursor";
  scroller.appendChild(caret);
  let contentX = 0;
  caret.at = (x) => { contentX = x; return caret; };
  caret.getBoundingClientRect = () => ({
    left: contentX - scroller.scrollLeft,
    right: contentX - scroller.scrollLeft + 2,
    width: 2, top: 0, bottom: 18, height: 18,
  });
  return { scroller, caret };
}

test("a caret past the right edge pulls the pane along, stopping with a lead in front of it", () => {
  const { scroller, caret } = makePane();

  v.window.revealCaretColumn(caret.at(900));
  assert.equal(scroller.scrollLeft, 582, "scrolled just far enough to seat the caret inside the margin");
  assert.equal(caret.getBoundingClientRect().right, WIDTH - MARGIN);
});

test("a caret left of the viewport pulls it back, and column 0 lands at the start of the line", () => {
  const { scroller, caret } = makePane();

  scroller.scrollLeft = 582;
  v.window.revealCaretColumn(caret.at(100));
  assert.equal(scroller.scrollLeft, 20);
  assert.equal(caret.getBoundingClientRect().left, MARGIN, "the caret is seated a lead in from the left edge");

  v.window.revealCaretColumn(caret.at(0));
  assert.equal(scroller.scrollLeft, 0);
});

test("a caret comfortably inside the band moves nothing", () => {
  const { scroller, caret } = makePane();

  scroller.scrollLeft = 300;
  v.window.revealCaretColumn(caret.at(400));
  assert.equal(scroller.scrollLeft, 300, "still inside the margins on both sides");

  v.window.revealCaretColumn(caret.at(380));
  assert.equal(scroller.scrollLeft, 300);
});

test("a clipped pane is never scrolled sideways", () => {
  const { scroller, caret } = makePane({ overflowX: "hidden" });

  v.window.revealCaretColumn(caret.at(900));
  assert.equal(scroller.scrollLeft, 0);
});

test("a caret with nothing scrollable above it is left alone", () => {
  const { scroller, caret } = makePane({ contentWidth: WIDTH });

  v.window.revealCaretColumn(caret.at(900));
  assert.equal(scroller.scrollLeft, 0);
  assert.doesNotThrow(() => v.window.revealCaretColumn(null));
});
