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

test("a floating overlay hides the file's blinking caret beneath it (single visible caret)", () => {
  // The merged-comments / prompt-memo / settings overlay owns the only caret while open. jsdom has no :has()
  // and no layout, so guard the rule as text: the file's .code-cursor must be display:none under each overlay
  // selector, so two carets can never blink across visible panels ("커서는 보이는 패널 통틀어 하나만").
  assert.match(css, /body:has\(#mc-modal\)\s*\.code-cursor[\s\S]{0,200}display:\s*none/, "merged overlay hides the file caret");
  assert.match(css, /body:has\(#mc-memo\)\s*\.code-cursor/, "prompt-memo overlay covered");
  assert.match(css, /body:has\(#settings-modal:not\(\.hidden\)\)\s*\.code-cursor/, "settings overlay covered");
});
