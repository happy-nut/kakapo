// A -webkit-app-region: drag surface hands the mouse press to the WINDOW, so the page never sees the
// click. Anything inside one that responds to a click has to say no-drag — the failure that wrote this
// test was file tabs being <div>s whose only <button> was the ×, so the exemption covered closing a tab
// and not opening one, and clicking a tab silently did nothing.
//
// The review no longer declares a drag region anywhere: the toolbars that were one belonged to the
// integrated title bar, which went away with the shell window, and this window has a real title bar. So
// the invariant is now the stronger one — a drag region may not appear without every clickable thing in
// it opting out — and it is written that way rather than listing selectors that no longer exist.
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

test("nothing is inside a drag region without opting out of it", () => {
  const dragSelectors = [];
  for (const block of css.split("}")) {
    const [head, body] = block.split("{");
    if (!body || !/-webkit-app-region:\s*drag/.test(body)) continue;
    dragSelectors.push(...head.split(",").map((s) => s.trim()).filter(Boolean));
  }

  if (!dragSelectors.length) {
    // Nothing is a drag handle, so nothing has to be exempted. Said out loud so that a future rule
    // reintroducing one lands on the branch below rather than on a silently passing empty loop.
    assert.equal(dragSelectors.length, 0, "the review declares no drag region");
    return;
  }

  const exempt = noDragSelectors();
  for (const dragged of dragSelectors) {
    assert.ok(
      exempt.some((selector) => selector.includes(dragged)),
      `${dragged} is a drag handle, so the clickable things inside it must say no-drag`,
    );
  }
});
