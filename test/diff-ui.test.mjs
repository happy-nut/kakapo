import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  const beforeLines = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`);
  const afterLines = beforeLines.slice();
  afterLines[2] = "const line3 = 300;";
  afterLines[27] = "const line28 = 2800;";
  ({ html } = await makeReviewHtml([
    { path: "src/review.ts", before: beforeLines.join("\n") + "\n", after: afterLines.join("\n") + "\n" },
  ], { app: true }));
});
after(cleanupFixtures);

test("IntelliJ-style diff chrome tracks review stops and opens the current source", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: { generation: 1, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openDiffFor("src/review.ts");
  await v.settle(80);

  assert.equal(v.$("#diff-before-path").textContent, "src/review.ts");
  assert.equal(v.$("#diff-after-path").textContent, "src/review.ts");
  assert.match(v.$("#diff-change-counter").textContent, /1 of 2/);
  assert.equal(v.window.getComputedStyle(v.$(".d2h-code-line-prefix")).display, "none", "patch +/- prefixes are hidden");

  v.click(v.$("#diff-next-change"));
  await v.settle(80);
  assert.match(v.$("#diff-change-counter").textContent, /2 of 2/, "the toolbar follows the same next-change stop as F7");

  v.click(v.$("#diff-open-source"));
  await v.settle(80);
  assert.equal(v.visibleView(), "source");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/review.ts");
  v.close();
});
