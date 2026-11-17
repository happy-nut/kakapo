import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/value.ts";
const LINES = ["export const value = 1;", "export const stable = true;", "export const last = 0;"];

let html;
before(async () => {
  ({ html } = await makeReviewHtml(
    [{ path: FILE, before: "export const value = 0;\n", after: `${LINES.join("\n")}\n` }], { app: true }));
});
after(cleanupFixtures);

test("the blame gutter can repaint a cell it has already painted", async () => {
  const v = await loadViewer(html, { analysisBridge: () => null });
  v.window.openSourceFile(FILE);
  await v.settle(40);

  v.window.sourceBlamePath = FILE;
  v.window.sourceBlameLines = new v.window.Map(LINES.map((_, i) => [i + 1, {
    line: i + 1, hash: "abc123def456", author: "Ada Reviewer", date: "2026-05-30", summary: "add value",
  }]));

  const numbers = () => v.$all(`#source-body .source-row[data-line-index] > .num`)
    .map((cell) => {
      const span = cell.querySelector(".source-line-number");
      return (span ? span.textContent : cell.textContent).trim();
    });
  const WANT = ["1", "2", "3", "4"];
  assert.deepEqual(numbers(), WANT, "the gutter starts out showing the line numbers");

  v.window.applySourceBlameIfActive(FILE);
  assert.deepEqual(numbers(), WANT, "painting blame leaves the numbers alone");
  assert.ok(v.$(`#source-body .source-blame-entry`), "…and does paint an entry beside them");

  v.window.applySourceBlameIfActive(FILE);
  v.window.applySourceBlameIfActive(FILE);
  assert.deepEqual(numbers(), WANT, "repainting is idempotent");
  assert.equal(v.$all(`#source-body .source-row[data-line-index="0"] .source-blame-entry`).length, 1,
    "and leaves one entry per row, not one per pass");
  v.close();
});
