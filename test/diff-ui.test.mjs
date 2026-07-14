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
  const colorBefore = Array.from({ length: 36 }, (_, index) => `const colorLine${index + 1} = ${index + 1};`);
  const colorAfter = colorBefore.slice();
  colorAfter[2] = "const colorLine3 = 300;";
  colorAfter.splice(10, 1);
  colorAfter.splice(25, 0, "const inserted = true;");
  ({ html } = await makeReviewHtml([
    { path: "src/review.ts", before: beforeLines.join("\n") + "\n", after: afterLines.join("\n") + "\n" },
    { path: "src/colors.ts", before: colorBefore.join("\n") + "\n", after: colorAfter.join("\n") + "\n" },
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

test("paired hunk rows use center gutters and IntelliJ semantic colors", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: { generation: 1, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openDiffFor("src/colors.ts");
  await v.settle(80);

  const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const sides = wrapper.querySelectorAll(".d2h-file-side-diff");
  const oldRows = Array.from(sides[0].querySelectorAll("tr"));
  const newRows = Array.from(sides[1].querySelectorAll("tr"));
  const oldModified = oldRows.find((row) => row.textContent.includes("colorLine3 = 3"));
  const oldDeleted = oldRows.find((row) => row.textContent.includes("colorLine11 = 11"));
  const newAdded = newRows.find((row) => row.textContent.includes("inserted = true"));

  assert.ok(oldModified?.classList.contains("mc-diff-modified"), "a replacement is blue on the old side");
  assert.ok(newRows[oldRows.indexOf(oldModified)]?.classList.contains("mc-diff-modified"), "the replacement band crosses both panes");
  assert.ok(oldDeleted?.classList.contains("mc-diff-deleted"), "a pure deletion is neutral gray");
  assert.ok(newRows[oldRows.indexOf(oldDeleted)]?.classList.contains("mc-diff-deleted"), "the gray deletion band crosses the empty placeholder");
  assert.ok(newAdded?.classList.contains("mc-diff-added"), "a pure insertion is green");
  assert.ok(oldRows[newRows.indexOf(newAdded)]?.classList.contains("mc-diff-added"), "the green insertion band crosses the empty placeholder");
  assert.ok(wrapper.querySelectorAll("tr.mc-active-hunk").length > 2, "the current hunk is tracked across both panes");
  wrapper.querySelectorAll("tr.mc-diff-change").forEach((row) => {
    assert.notEqual(row.dataset.reviewHunkIndex, undefined, "every semantic change row carries its hunk id");
  });

  const oldNumber = sides[0].querySelector(".d2h-code-side-linenumber:not(.d2h-info)");
  const newNumber = sides[1].querySelector(".d2h-code-side-linenumber:not(.d2h-info)");
  const oldNumberStyle = v.window.getComputedStyle(oldNumber);
  const newNumberStyle = v.window.getComputedStyle(newNumber);
  assert.equal(oldNumber.parentElement.lastElementChild, oldNumber, "old line numbers are the last center-facing table cell");
  assert.equal(newNumber.parentElement.firstElementChild, newNumber, "new line numbers are the first center-facing table cell");
  assert.equal(oldNumberStyle.position, "relative");
  assert.equal(newNumberStyle.position, "relative");
  assert.equal(oldNumberStyle.zIndex, "3", "old gutter paints above long overflowing code");
  assert.equal(newNumberStyle.zIndex, "3", "new gutter paints above long overflowing code");
  assert.equal(oldNumberStyle.borderRightWidth, "0px", "the active hunk does not draw a blue center rail");
  assert.equal(newNumberStyle.borderLeftWidth, "0px", "the active hunk does not draw a blue center rail");

  const changeRow = v.$('.change-row[data-file="src/colors.ts"]');
  assert.equal(changeRow.querySelector(".diffstat"), null, "Changes rows omit added/deleted line totals");
  assert.equal(changeRow.querySelector(".status").textContent.trim(), "", "status uses no wide text label");
  assert.ok(changeRow.querySelector(".status-modified svg"), "modified state is a compact icon badge");
  v.close();
});
