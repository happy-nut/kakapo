// The six reading switches ported from IntelliJ (RENDER_TOGGLES in 01-core.js): Show Whitespaces, Show
// Indent Guides, Show Sticky Lines, Highlight Only Current Declaration, Essential Highlighting and Align
// Changes In Side-by-Side Diff. None of them changes the review — each decides how it is drawn — so what
// is asserted is the attribute on <html> the stylesheet reads, the persisted value, and, for the two that
// are not pure paint, the mark they leave in the DOM.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { markWhitespaceRuns } from "../dist/util.js";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/one.ts", before: "function a() {\n  return 1;\n}\n", after: "function a() {\n  return 2;  \n}\n" },
  ]));
});
after(cleanupFixtures);

const CHORDS = {
  showWhitespace: { key: "w", code: "KeyW" },
  indentGuides: { key: "i", code: "KeyI" },
  stickyLines: { key: "s", code: "KeyS" },
  focusMode: { key: "f", code: "KeyF" },
  essentialHighlighting: { key: "e", code: "KeyE" },
  alignChanges: { key: "a", code: "KeyA" },
};
const ATTR = {
  showWhitespace: "data-show-whitespace",
  indentGuides: "data-indent-guides",
  stickyLines: "data-sticky-lines",
  focusMode: "data-focus-mode",
  essentialHighlighting: "data-essential-highlighting",
  alignChanges: "data-align-changes",
};

test("every switch starts at its documented default and the attribute says so", async () => {
  const v = await loadViewer(html);
  const root = v.window.document.documentElement;
  // Three of them are off until asked for; sticky lines and alignment are how the app already read, and a
  // toggle that changed behaviour on arrival would be a different change.
  assert.equal(root.getAttribute("data-show-whitespace"), "off");
  assert.equal(root.getAttribute("data-indent-guides"), "off");
  assert.equal(root.getAttribute("data-focus-mode"), "off");
  assert.equal(root.getAttribute("data-essential-highlighting"), "off");
  assert.equal(root.getAttribute("data-sticky-lines"), "on");
  assert.equal(root.getAttribute("data-align-changes"), "on");
  v.window.close();
});

test("⇧⌥ chords flip each switch, and the choice is written down", async () => {
  const v = await loadViewer(html);
  const root = v.window.document.documentElement;
  for (const [name, chord] of Object.entries(CHORDS)) {
    const before = root.getAttribute(ATTR[name]);
    v.key(chord.key, { shiftKey: true, altKey: true, code: chord.code });
    await v.settle(20);
    const after = root.getAttribute(ATTR[name]);
    assert.notEqual(after, before, `${name}: ⇧⌥${chord.code.slice(3)} did not flip ${ATTR[name]}`);
    assert.ok(after === "on" || after === "off", `${name}: ${ATTR[name]} is on/off, got ${after}`);
    const stored = v.window.localStorage.getItem(
      name === "showWhitespace" ? "kakapo-show-whitespace"
        : name === "indentGuides" ? "kakapo-indent-guides"
          : name === "stickyLines" ? "kakapo-sticky-lines"
            : name === "focusMode" ? "kakapo-focus-mode"
              : name === "essentialHighlighting" ? "kakapo-essential-highlighting"
                : "kakapo-align-changes",
    );
    assert.equal(stored, after === "on" ? "1" : "0", `${name} persisted the wrong way round`);
  }
  v.window.close();
});

test("a stored choice is what the next window opens with", async () => {
  const v = await loadViewer(html, { seedStorage: { "kakapo-show-whitespace": "1", "kakapo-sticky-lines": "0" } });
  const root = v.window.document.documentElement;
  assert.equal(root.getAttribute("data-show-whitespace"), "on");
  assert.equal(root.getAttribute("data-sticky-lines"), "off");
  v.window.close();
});

// markWhitespaceRuns is the one definition both halves of the app render through (src/util.ts): the diff is
// built in main through highlight.ts, the source view in the viewer, and copy-viewer-assets.mjs emits this
// exact function into the bundle so there is never a second copy to drift.
test("the whitespace marker wraps the leading and trailing runs and nothing between them", async () => {
  const marked = markWhitespaceRuns("  const a = 1;  ");
  assert.match(marked, /^<span class="ws-lead" data-ws="spaces">  <\/span>/);
  assert.match(marked, /<span class="ws-trail" data-ws="spaces">  <\/span>$/);
  assert.equal(marked.match(/<span class="ws-/g).length, 2, "the gaps between tokens are not marked");
});

test("the marker says what the indentation is MADE of, which dots cannot show", async () => {
  assert.match(markWhitespaceRuns("\t\tx"), /class="ws-lead" data-ws="tabs"/);
  assert.match(markWhitespaceRuns("\t  x"), /class="ws-lead" data-ws="mixed"/);
  assert.match(markWhitespaceRuns("  x"), /class="ws-lead" data-ws="spaces"/);
});

test("a line of nothing but blanks is trailing, not leading — it is what was left behind", async () => {
  const marked = markWhitespaceRuns("    ");
  assert.match(marked, /^<span class="ws-trail"/);
  assert.equal(marked.match(/<span class="ws-/g).length, 1);
});

test("tags are stepped over, so highlighted code keeps its markup", async () => {
  const marked = markWhitespaceRuns('  <span class="hljs-keyword">return</span> 1;  ');
  assert.ok(marked.includes('<span class="hljs-keyword">return</span>'), "the highlight span survives intact");
  assert.match(marked, /^<span class="ws-lead"/);
  assert.match(marked, /<span class="ws-trail" data-ws="spaces">  <\/span>$/);
});

test("a line with no blanks at either end is returned untouched", async () => {
  assert.equal(markWhitespaceRuns("const a=1;"), "const a=1;");
  assert.equal(markWhitespaceRuns(""), "");
});

// The case that broke the first version: a highlighter is free to put the indentation OUTSIDE the span it
// opens for the code, so the leading run's first segment is blanks all the way through and the run has not
// ended — reading only the first text segment with a regex silently marked nothing at all.
test("a run that crosses a tag boundary is marked on both sides of it", async () => {
  const marked = markWhitespaceRuns('  <span class="hljs-keyword">  return</span>');
  assert.match(marked, /^<span class="ws-lead" data-ws="spaces">  <\/span>/, "the segment before the tag");
  assert.match(marked, /hljs-keyword"><span class="ws-lead" data-ws="spaces">  <\/span>return/, "and the one after it");
});

test("a blank-only line gives its blanks to the trailing run once, never to both", async () => {
  const marked = markWhitespaceRuns('  <span class="hljs-comment">  </span>');
  assert.equal(marked.match(/class="ws-lead"/g), null, "nothing here was ever indentation");
  assert.equal(marked.match(/class="ws-trail"/g).length, 2);
  assert.equal(marked.replace(/<[^>]*>/g, ""), "    ", "and not one blank was lost or doubled");
});
