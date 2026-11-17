import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/app.ts";
const WORDS = "why is this cast here?";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

async function withPrefilledComment() {
  const v = await loadViewer(html);
  await v.clickFirstDiffLine();
  await v.openComposer();
  const input = v.visibleComposerInput();
  const prefill = input.value;
  assert.match(prefill, /^@\S+#L\d+ $/, "precondition: the composer prefills the anchor and a space");
  await v.writeAndSave(prefill + WORDS);
  return { v, prefill };
}

test("the card on the line shows the comment, not the path it is already sitting on", async () => {
  const { v, prefill } = await withPrefilledComment();
  try {
    const stored = v.window.reviewComments[0];
    assert.equal(stored.text, prefill + WORDS, "the record keeps the anchor — it is the writer's to edit");

    const body = v.$(".mc-card:not(.mc-merged-card) .mc-card-body");
    assert.ok(body, "the comment is on screen");
    assert.equal(body.textContent, WORDS, "and reads as what was written, without the path in front of it");
    assert.doesNotMatch(body.textContent, /@src\/app\.ts/, "no anchor in the body");
  } finally {
    v.close();
  }
});

test("an anchor the writer edited stays in the body", async () => {
  const v = await loadViewer(html);
  try {
    await v.clickFirstDiffLine();
    await v.openComposer();
    await v.writeAndSave("@docs/why.md#L1 the real question is over here");
    const body = v.$(".mc-card:not(.mc-merged-card) .mc-card-body");
    assert.equal(body.textContent, "@docs/why.md#L1 the real question is over here",
      "a reference that is not this card's anchor is the reviewer's own words");
  } finally {
    v.close();
  }
});

test("the handed-over list shows the words, not the path twice", async () => {
  const { v } = await withPrefilledComment();
  try {
    v.window.kakapoClipboard = { write: () => {} };
    await v.openMergedView();
    (v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all")).click();
    await v.settle(60);

    v.$("#archive-panel .archive-head").click();
    await v.settle(30);
    const row = v.$("#archive-panel .archive-row");
    assert.ok(row, "the hand-off put it in the list");
    assert.match(row.querySelector(".archive-where").textContent, /app\.ts:\d+ · \S/,
      "the first line is where it was and when it went");
    assert.equal(row.querySelector(".archive-text").textContent, WORDS,
      "and the second line is the comment, which is the only thing that tells two of them apart");
    const title = row.getAttribute("title");
    assert.ok(title.startsWith(WORDS), "the whole comment is readable without clicking");
    assert.match(title, /\n\n\S/, "…with what the click does still spelled out under it");
  } finally {
    v.close();
  }
});

test("the archive goes back through the one path that knows where a comment is", async () => {
  const { v } = await withPrefilledComment();
  try {
    v.window.kakapoClipboard = { write: () => {} };
    await v.openMergedView();
    (v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all")).click();
    await v.settle(60);
    const seq = v.window.archivedComments[0].seq;
    v.$("#archive-panel .archive-head").click();
    await v.settle(30);

    const asked = [];
    const real = v.window.revealComment;
    v.window.revealComment = (n) => { asked.push(n); return real.call(v.window, n); };
    try {
      v.$("#archive-panel .archive-row").click();
      await v.settle(80);
    } finally {
      v.window.revealComment = real;
    }

    assert.equal(v.window.reviewComments.length, 1, "it is back in the review");
    assert.deepEqual(asked, [seq], "and the jump went through revealComment, which reads the comment's own view");
  } finally {
    v.close();
  }
});
