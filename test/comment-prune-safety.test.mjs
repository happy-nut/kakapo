// A file poll that arrived while a save was in flight used to be replayed afterwards. The held payload is
// the file as it was BEFORE the write, so replaying it replaced the comment that had just been saved with a
// snapshot that never had it. The sibling bug — existence being asked of the working tree when the review's
// right side is a revision — is main's question to answer, and is pinned in review-target-existence.test.mjs.
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

// Stands in for main: `write` resolves only when the test lets it, so a poll can be fired mid-save.
function installCommentsBridge(v, { onWrite } = {}) {
  const bridge = { writes: [], releases: [] };
  v.window.kakapoComments = {
    read: () => Promise.resolve({ path: "/tmp/comments.jsonl", exists: false, records: [], legacyNotes: [] }),
    write: (payload) => {
      bridge.writes.push(payload);
      if (onWrite) onWrite(payload);
      return new Promise((resolve) => { bridge.releases.push(() => resolve({ ok: true, arrived: [] })); });
    },
    onUpdate: () => {},
    onReveal: () => {},
  };
  return bridge;
}

async function addComment(v, text) {
  await v.clickFirstDiffLine();
  await v.openComposer();
  await v.writeAndSave(text);
}

test("a comment survives a file poll that arrives while its save is in flight", async () => {
  const v = await loadViewer(html);
  try {
    const bridge = installCommentsBridge(v);
    await addComment(v, "why this change?");
    assert.equal(v.window.reviewComments.length, 1, "the comment is in memory");

    // The poll ticks inside the save window and carries the file as it was before the write: empty.
    v.window.onThreadFilePush({ records: [] });
    await v.settle(10);
    assert.equal(v.window.reviewComments.length, 1, "a mid-save poll does not drop it on arrival");

    // …and the write lands. This is where the replay used to apply that empty snapshot.
    await v.settle(400);
    bridge.releases.forEach((release) => release());
    await v.settle(60);

    assert.equal(v.window.reviewComments.length, 1, "nor after the write settles");
    assert.equal(v.window.reviewComments[0].text, "why this change?");
    assert.ok(v.window.commentSeq >= 1, "and the id counter did not fall back with it");
  } finally {
    v.close();
  }
});
