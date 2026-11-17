import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
const FILE = "src/app.ts";

before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});

after(cleanupFixtures);

async function withHandedOver(text) {
  const v = await loadViewer(html);
  v.window.kakapoClipboard = { write: () => {} };
  await v.clickFirstDiffLine();
  await v.openComposer();
  await v.writeAndSave(text);
  await v.openMergedView();
  (v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all")).click();
  await v.settle(60);
  return v;
}

const head = (v) => v.$("#archive-panel .archive-head");
const open = (v) => v.$("#archive-panel").classList.contains("is-open");

test("the drawer arrives closed, so a hand-off does not take the tree's room", async () => {
  const v = await withHandedOver("why this change?");
  try {
    assert.equal(v.window.archivedComments.length, 1, "precondition: something was handed over");
    const button = head(v);
    assert.ok(button, "the drawer has a header");
    assert.equal(button.tagName, "BUTTON", "the header is the control, not a label beside one");
    assert.equal(open(v), false, "and nothing is unfolded until the reviewer asks");
    assert.equal(button.getAttribute("aria-expanded"), "false", "which it says out loud");
    assert.match(button.textContent, /1/, "the count is readable while it is closed");
  } finally {
    v.close();
  }
});

test("the header opens and closes it, and says which it is", async () => {
  const v = await withHandedOver("why this change?");
  try {
    head(v).click();
    await v.settle(30);
    assert.equal(open(v), true, "one press unfolds it");
    assert.equal(head(v).getAttribute("aria-expanded"), "true");

    head(v).click();
    await v.settle(30);
    assert.equal(open(v), false, "the next press folds it back");
    assert.equal(head(v).getAttribute("aria-expanded"), "false");
  } finally {
    v.close();
  }
});

test("an open drawer stays open while the review changes under it", async () => {
  const v = await withHandedOver("why this change?");
  try {
    head(v).click();
    await v.settle(30);
    assert.equal(open(v), true, "precondition: the reviewer opened it");

    v.window.refreshComments();
    await v.settle(30);
    assert.equal(open(v), true, "a redraw does not fold it up again");
    assert.equal(head(v).getAttribute("aria-expanded"), "true");
  } finally {
    v.close();
  }
});

test("emptying the archive forgets that it was open", async () => {
  const v = await withHandedOver("why this change?");
  try {
    head(v).click();
    await v.settle(30);
    v.$("#archive-panel .archive-row").click();
    await v.settle(60);
    assert.ok(v.$("#archive-panel").classList.contains("hidden"), "precondition: the drawer is gone");

    await v.openMergedView();
    (v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all")).click();
    await v.settle(60);
    assert.equal(v.window.archivedComments.length, 1, "precondition: it was handed over again");
    assert.equal(open(v), false, "the next thing handed over arrives folded, like the first one did");
    assert.equal(head(v).getAttribute("aria-expanded"), "false");
  } finally {
    v.close();
  }
});
