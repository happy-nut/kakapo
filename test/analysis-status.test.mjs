import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

test("analysis trust status remains visible and explains live fallback", async () => {
  const perfMarks = [];
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: {
      generation: 4,
      phase: "ready",
      family: "typescript",
      server: "typescript-language-server",
      serverSource: "bundled",
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
    perfBridge: (name, details) => perfMarks.push({ name, details }),
  });
  await v.settle(40);
  const status = v.$("#analysis-status");
  assert.equal(status.dataset.phase, "ready");
  assert.equal(status.dataset.generation, "4");
  assert.match(status.title, /typescript-language-server \(bundled\)/);

  v.window.__analysisStatusCb({
    generation: 5,
    phase: "fallback",
    fallbackReason: "No language server is available for src/app.py",
    updatedAt: "2026-07-14T00:00:01.000Z",
  });
  assert.equal(status.dataset.phase, "fallback");
  assert.match(status.title, /No language server is available for src\/app\.py/);
  assert.ok(perfMarks.some((mark) => mark.name === "first-review-paint"));
  v.close();
});
