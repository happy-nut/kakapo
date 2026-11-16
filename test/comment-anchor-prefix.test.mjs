// A comment carries its own anchor in its text, and only some surfaces knew.
//
// The composer prefills `@path#L42 ` into the body (openComposer) on purpose: the place is then something
// the writer can edit, which is how you say "while I'm here — this is about something else". The reader of
// that arrangement is `commentBodyWithoutAnchor`, which strips the prefix while it still matches the anchor
// and leaves it alone once the writer has changed it.
//
// The hand-off document asked it that way, and so did the dock card. The two surfaces a reviewer actually
// reads did not: the card on the line printed the record raw, so every comment began with its own path —
// the very two facts the head omits BECAUSE the card is sitting on them — and the handed-over list printed
// the path under the path, spending its 90-character budget before the reviewer's own words began.
//
// Nothing caught it because no test ever wrote a comment the way the composer hands it over: `writeAndSave`
// replaces the textarea's value, prefix and all. These tests type AFTER the prefill, the way a hand does.
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

/** A comment written the way the composer offers it: the prefilled anchor, then the reviewer's words. */
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

// An anchor the writer CHANGED is not a duplicate of anything — it is what they chose to say about where
// this is. The stripping has to stop at the first character that differs, or editing the prefix would be
// silently undone on screen.
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

    const row = v.$("#archive-panel .archive-row");
    assert.ok(row, "the hand-off put it in the list");
    // Where it was AND when it went: the list is sorted by hand-off time, and a reviewer coming back to it
    // is looking for a particular hand-off ("the one I sent last week"), not a particular line.
    assert.match(row.querySelector(".archive-where").textContent, /app\.ts:\d+ · \S/,
      "the first line is where it was and when it went");
    assert.equal(row.querySelector(".archive-text").textContent, WORDS,
      "and the second line is the comment, which is the only thing that tells two of them apart");
    // Reading one must not require taking it back, because the click is what takes it back.
    const title = row.getAttribute("title");
    assert.ok(title.startsWith(WORDS), "the whole comment is readable without clicking");
    assert.match(title, /\n\n\S/, "…with what the click does still spelled out under it");
  } finally {
    v.close();
  }
});

// Where a comment is includes the view it was written in — the record carries `view` for exactly that, and
// `revealComment` is where every other caller (F8's walk, an answer notification) reads it. The archive's
// own click handler went its own way to `openSourceAt`, so the one door into a handed-over comment was the
// one that did not lead back to where it came from: a comment written in the diff came back in the source
// view, at a line number that means a different line as soon as the comment sits on the old side.
//
// What is pinned here is the WIRING, because a jsdom page has no layout and reports the source view as the
// visible one whatever the review is doing — `view` on a comment written through clickFirstDiffLine comes
// out "source", so asserting on the landing would pass under any implementation. The landing itself was
// measured in the real app: a comment written in the diff at line 366, handed over and clicked back out of
// the archive, left the caret in the DIFF on line 366 (it used to open the source view).
test("the archive goes back through the one path that knows where a comment is", async () => {
  const { v } = await withPrefilledComment();
  try {
    v.window.kakapoClipboard = { write: () => {} };
    await v.openMergedView();
    (v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all")).click();
    await v.settle(60);
    const seq = v.window.archivedComments[0].seq;

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
