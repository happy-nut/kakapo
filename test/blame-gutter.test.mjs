// The blame gutter paints the author and date into the line-number cell, beside the number. It repaints
// often — sourceRowsCompleted re-runs it as each chunk of a big file arrives, and again whenever a toggle
// or new rows change the table — so it has to be able to paint a cell it has already painted.
//
// It could not. It took the number to re-draw from the CELL's text, which by then held the entry it had
// written there itself, and wrote the lot back as the number: the gutter read `2026-08-11happy-nut1–7`
// where it means `1–7`, and grew by one date and author on every pass. Watched in the running app, where
// three passes gave three copies.
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

  // The state showSourceBlame would have left behind, without needing a git repository here: this test is
  // about the painting, and readGitBlame has its own tests (git-blame.test.mjs).
  v.window.sourceBlamePath = FILE;
  v.window.sourceBlameLines = new v.window.Map(LINES.map((_, i) => [i + 1, {
    line: i + 1, hash: "abc123def456", author: "Ada Reviewer", date: "2026-05-30", summary: "add value",
  }]));

  // Before blame paints, the number is the cell's own text; afterwards it lives in its own span. Read
  // both ways so the assertion is about the NUMBER rather than about which pass painted it.
  const numbers = () => v.$all(`#source-body .source-row[data-line-index] > .num`)
    .map((cell) => {
      const span = cell.querySelector(".source-line-number");
      return (span ? span.textContent : cell.textContent).trim();
    });
  // Four rows, not three: the file ends in a newline, so it has an empty last line like any other file.
  const WANT = ["1", "2", "3", "4"];
  assert.deepEqual(numbers(), WANT, "the gutter starts out showing the line numbers");

  v.window.applySourceBlameIfActive(FILE);
  assert.deepEqual(numbers(), WANT, "painting blame leaves the numbers alone");
  assert.ok(v.$(`#source-body .source-blame-entry`), "…and does paint an entry beside them");

  // The pass that used to double it, and the one that used to treble it.
  v.window.applySourceBlameIfActive(FILE);
  v.window.applySourceBlameIfActive(FILE);
  assert.deepEqual(numbers(), WANT, "repainting is idempotent");
  assert.equal(v.$all(`#source-body .source-row[data-line-index="0"] .source-blame-entry`).length, 1,
    "and leaves one entry per row, not one per pass");
  v.close();
});
