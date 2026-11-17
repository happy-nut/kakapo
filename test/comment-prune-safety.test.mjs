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

    v.window.onThreadFilePush({ records: [] });
    await v.settle(10);
    assert.equal(v.window.reviewComments.length, 1, "a mid-save poll does not drop it on arrival");

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
