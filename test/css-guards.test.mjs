// Layout-level CSS invariants that jsdom can't exercise (it has no flexbox layout — offsetHeight is always
// 0), so they're guarded as text against the built stylesheet. These regressed real, user-visible behaviour
// (the diff stopped scrolling and the caret fell off-screen on big files), so treat a break here as serious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../dist/viewer.css", import.meta.url), "utf8");

// Return the declaration block of the FIRST rule whose selector text contains `needle`.
function ruleBodyContaining(needle) {
  const re = new RegExp("([^{}]*" + needle.replace(/[.#*\[\]]/g, "\\$&") + "[^{}]*)\\{([^}]*)\\}", "s");
  const m = css.match(re);
  return m ? m[2] : null;
}

function ruleBodyForExactSelector(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp("(^|})\\s*" + escaped + "\\s*\\{([^}]*)\\}", "s"));
  return m ? m[2] : null;
}

test("diff stays scrollable for a single big file: .d2h-file-wrapper keeps flex-shrink:0", () => {
  // The bug: #diff2html-container is a column flexbox and .d2h-file-wrapper has overflow:hidden, which makes
  // the flex item's min-height 0. With the default flex-shrink:1, a single shown file (showOnlyFile) shrinks
  // to the viewport height and overflow:hidden clips the rest — the diff can't scroll and the caret leaves
  // the screen near the bottom of a large file. flex-shrink:0 pins the wrapper to its content height.
  const wrapper = ruleBodyContaining(".d2h-file-wrapper");
  assert.ok(wrapper, ".d2h-file-wrapper rule must exist");
  assert.match(wrapper, /flex-shrink:\s*0\b/, "the fix: .d2h-file-wrapper must keep flex-shrink:0");

  // Guard the PRECONDITIONS too, so the test still means something if the layout is refactored: if overflow
  // stops being hidden, or the container stops being a column flexbox, the flex-shrink:0 may no longer be
  // load-bearing — but then this assertion forces a human to re-check rather than silently passing.
  assert.match(wrapper, /overflow:\s*hidden\b/, "precondition: wrapper still clips (overflow:hidden) — why shrink must be 0");
  const container = ruleBodyContaining("diff2html-container");
  assert.ok(container && /display:\s*flex/.test(css), "precondition: #diff2html-container is a flexbox");
  assert.match(css, /diff2html-container[^{}]*\{[^}]*flex-direction:\s*column/s, "precondition: container is a COLUMN flexbox");
});

test("a focused dock / settings overlay hides the file's blinking caret beneath it (single visible caret)", () => {
  // A focused merged/memo dock (or the settings overlay) owns the only caret. jsdom has no :has() and no
  // layout, so guard the rule as text: the file's .code-cursor must be display:none while the dock has focus
  // (or settings is up), so two carets can never blink across visible panels ("커서는 보이는 패널 통틀어 하나만").
  assert.match(css, /body:has\(\.dock-panel:focus-within\)\s*\.code-cursor[\s\S]{0,200}display:\s*none/, "a focused dock hides the file caret");
  assert.match(css, /body:has\(#settings-modal:not\(\.hidden\)\)\s*\.code-cursor/, "settings overlay covered");
});

test("the comment composer textarea restores its own caret (not transparent-inherited from the diff)", () => {
  // .mc-input is injected INSIDE #diff2html-container, which sets caret-color: transparent (the file view
  // uses a fake .code-cursor). caret-color inherits, so .mc-input must restore it — a focused textarea must
  // show its real caret. (The single-caret rule hides the FILE caret while composing, not the textarea's.)
  const input = ruleBodyContaining(".mc-input");
  assert.ok(input, ".mc-input rule must exist");
  assert.match(input, /caret-color:\s*var\(--text\)/, ".mc-input restores caret-color so the composer caret is visible");
});

test("source line-number gutter stays compact and internally aligned", () => {
  const body = ruleBodyContaining(".source-body");
  assert.ok(body, ".source-body rule must exist");
  assert.match(body, /--source-gutter-width:\s*56px\b/, "source gutter stays compact");

  const num = ruleBodyForExactSelector(".num");
  assert.ok(num, ".num rule must exist");
  assert.match(num, /width:\s*var\(--source-gutter-width\)/, "line-number cells use the shared gutter width");
  assert.match(num, /padding:\s*2px\s+6px\b/, "line-number padding does not re-widen the gutter");

  assert.match(
    css,
    /source-body:not\(\.empty\):not\(\.image-body\)[^{}]*\{[\s\S]*var\(--source-gutter-width\)/,
    "the gutter background/divider uses the same shared width",
  );
  assert.match(
    css,
    /\.source-table\s+\.mc-thread-cell[^{}]*\{[^}]*calc\(var\(--source-gutter-width\)\s*\+\s*10px\)/,
    "source comment rows stay aligned with the compact gutter",
  );
});

test("raw source rows never soft-wrap, keeping caret scroll math stable", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const rule = css.match(/\.source-body:not\(\.rendered-body\)\s+\.source-row\s*>\s*\.source-code\s*\{[^}]+\}/)?.[0] || "";
  assert.match(rule, /white-space:\s*pre\s*;/, "raw code behaves like an editor line, not a wrapping document");
  assert.match(rule, /overflow-wrap:\s*normal\s*;/, "long tokens use horizontal scrolling instead of growing row height");
});

test("shared Markdown typography preserves readable paragraph rhythm", () => {
  const paragraph = ruleBodyContaining(".markdown-body p");
  assert.ok(paragraph, "shared Markdown paragraph rule exists");
  assert.match(paragraph, /margin:\s*0\s+0\s+1\.1em/, "paragraphs retain a visible bottom gap");
  assert.doesNotMatch(css, /\.md-cell\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/, "source block rows no longer erase every block's bottom margin");
});
