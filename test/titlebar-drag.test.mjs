import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");

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
