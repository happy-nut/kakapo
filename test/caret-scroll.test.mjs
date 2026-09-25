// CORE USER FLOW: the caret stays on screen. scrolloffReveal keeps the caret's ROW in view vertically, which
// says nothing about where the caret sits along a long line — arrow right past the edge and the caret was
// gone while the keys kept working. revealCaretColumn is the horizontal half, shared by the diff view
// (.d2h-file-side-diff, one scroller per side) and the source view (.source-body).
//
// jsdom has no layout: every rect and every scroll dimension is zero. So the geometry is stubbed here, with
// the caret's rect derived from the scroller's live scrollLeft exactly as a real one would be — which is what
// makes the assertions meaningful: the numbers below are where the browser would actually leave the caret.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const WIDTH = 400;      // visible width of the pane
const CONTENT = 2000;   // scrollable content width
const MARGIN = 80;      // revealCaretColumn's lead: min(80, width/3)

// One viewer for every case here: revealCaretColumn touches only the elements it is handed, so a fresh jsdom
// per test bought nothing and cost minutes.
let v;
before(async () => {
  const { html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]);
  v = await loadViewer(html);
});
after(() => { if (v) v.close(); cleanupFixtures(); });

// A pane that scrolls horizontally, holding a caret at a fixed position in the CONTENT. The caret's viewport
// rect moves as the pane scrolls, which is the relationship the real code reads.
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
  // What the reader sees: the caret is on screen, with room ahead of it rather than flush against the rim.
  assert.equal(caret.getBoundingClientRect().right, WIDTH - MARGIN);
});

test("a caret left of the viewport pulls it back, and column 0 lands at the start of the line", () => {
  const { scroller, caret } = makePane();

  scroller.scrollLeft = 582;
  v.window.revealCaretColumn(caret.at(100));
  assert.equal(scroller.scrollLeft, 20);
  assert.equal(caret.getBoundingClientRect().left, MARGIN, "the caret is seated a lead in from the left edge");

  // Home / a caret at column 0 has nowhere further left to go: the pane must land on the start of the line,
  // not on a negative offset the browser would silently clamp anyway.
  v.window.revealCaretColumn(caret.at(0));
  assert.equal(scroller.scrollLeft, 0);
});

// Scrolloff, not follow — the same rule the vertical half already holds to. A view that slid on every
// keystroke while everything was plainly visible would be worse than one that never scrolled.
test("a caret comfortably inside the band moves nothing", () => {
  const { scroller, caret } = makePane();

  scroller.scrollLeft = 300;
  v.window.revealCaretColumn(caret.at(400)); // 100px in from the left edge, 298 from the right
  assert.equal(scroller.scrollLeft, 300, "still inside the margins on both sides");

  // And the boundary itself is not a trigger: exactly on the margin is still inside.
  v.window.revealCaretColumn(caret.at(380));
  assert.equal(scroller.scrollLeft, 300);
});

// Wrapped lines (line-wrap mode) clip instead of scrolling: .d2h-file-side-diff turns overflow-x: hidden and
// the source body wraps. Its content still measures wider than the box, so scrollWidth alone would say "this
// scrolls" and scrollLeft would obediently slide a pane the reader cannot scroll back.
test("a clipped pane is never scrolled sideways", () => {
  const { scroller, caret } = makePane({ overflowX: "hidden" });

  v.window.revealCaretColumn(caret.at(900));
  assert.equal(scroller.scrollLeft, 0);
});

test("a caret with nothing scrollable above it is left alone", () => {
  const { scroller, caret } = makePane({ contentWidth: WIDTH }); // content fits; no overflow

  v.window.revealCaretColumn(caret.at(900));
  assert.equal(scroller.scrollLeft, 0);
  // And the no-caret case, which happens on an empty document or between renders.
  assert.doesNotThrow(() => v.window.revealCaretColumn(null));
});
