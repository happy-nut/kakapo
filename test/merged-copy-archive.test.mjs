// The merged hand-off panel's button is Copy AND ARCHIVE: a review handed to an agent is spent, so what
// went into the clipboard leaves the active review with it — kept, not deleted. The things that make that
// safe: whole threads go (no replies left pointing at a parent that is gone), a failed clipboard write
// archives nothing, Cmd+Z brings the batch back, and the sidebar can put any of it back later.
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

// jsdom has no clipboard; the viewer's own bridge is the first thing copyTextToClipboard tries, so a stub
// there is the honest stand-in for a working copy. Returns the clipboard so a test can read what was sent.
function installClipboard(v) {
  const clipboard = { text: null };
  v.window.kakapoClipboard = { write: (text) => { clipboard.text = String(text); } };
  return clipboard;
}

async function withComment(text) {
  const v = await loadViewer(html);
  await v.clickFirstDiffLine();
  await v.openComposer();
  await v.writeAndSave(text);
  return v;
}

const copyButton = (v) => v.$("#mc-merged-panel .mc-copy-all") || v.$(".mc-copy-all");

test("the button says what it does", async () => {
  const v = await withComment("why this change?");
  try {
    await v.openMergedView();
    const button = copyButton(v);
    assert.ok(button, "the hand-off panel has the button");
    assert.match(button.textContent, /archive|보관/i, "it is not labelled as a plain copy");
    assert.equal(button.disabled, false, "and it is live once there is something to hand over");
  } finally {
    v.close();
  }
});

test("copying hands the review over and files it away", async () => {
  const v = await withComment("why this change?");
  try {
    const clipboard = installClipboard(v);
    await v.openMergedView();
    assert.match(v.mergedModalText(), /why this change\?/, "the comment is in the document being handed over");

    copyButton(v).click();
    await v.settle(60);
    assert.match(clipboard.text, /why this change\?/, "the review reached the clipboard");
    await v.settle(60);

    assert.equal(v.window.reviewComments.length, 0, "the handed-over comment is out of the active review");
    assert.equal(v.window.archivedComments.length, 1, "but kept — handed over is not deleted");
    assert.ok(v.window.archivedComments[0].archivedAt, "and stamped with when it was handed over");
    assert.equal(v.$("#mc-merged-panel"), null, "the panel closes — there is nothing left in it");
  } finally {
    v.close();
  }
});

test("an agent's answer goes with the question it answered", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    // The agent answers in that thread and the reviewer writes back, so the follow-up is what gets handed
    // over while the question and the answer are its history.
    const root = v.window.reviewComments[0];
    const reply = (seq, by, replyTo, text) => ({
      seq, kind: "c", by, replyTo, path: root.path, line: root.line, code: "", anchorCode: "",
      from: root.from, to: root.to, side: root.side, title: "", addressed: false, anchorPresent: true, text,
    });
    v.window.reviewComments.push(reply(2, "agent", root.seq, "because the flag moved"));
    v.window.reviewComments.push(reply(3, "me", 2, "then update the docs too"));
    assert.equal(v.window.reviewComments.length, 3);

    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);

    // Joined rather than deep-equalled: `reviewComments` lives in the jsdom realm, and deepStrictEqual
    // compares prototypes, so a cross-realm [] never equals a Node-realm [].
    assert.equal(
      v.window.reviewComments.map((comment) => `${comment.seq}:${comment.by}`).join("|"),
      "",
      "the whole thread is filed, not just the cards that were in the document",
    );
  } finally {
    v.close();
  }
});

test("Cmd+Z brings the handed-over review back", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);
    assert.equal(v.window.reviewComments.length, 0);

    v.key("z", { metaKey: true, code: "KeyZ" });
    await v.settle(60);
    assert.equal(v.window.reviewComments.length, 1, "one undo restores the batch");
    assert.equal(v.window.reviewComments[0].text, "why this change?");
  } finally {
    v.close();
  }
});

test("a failed clipboard write archives nothing", async () => {
  const v = await withComment("why this change?");
  try {
    await v.openMergedView();
    // Every clipboard path the viewer has, refused: a copy that did not happen must not count as a hand-off.
    v.window.kakapoClipboard = { write: () => { throw new Error("no clipboard"); } };
    v.window.navigator.clipboard = undefined;
    v.document.execCommand = () => false;

    copyButton(v).click();
    await v.settle(60);

    assert.equal(v.window.reviewComments.length, 1, "the review is untouched");
    assert.equal(v.window.archivedComments.length, 0, "and nothing was filed away either");
    assert.ok(v.$("#mc-merged-panel"), "and the panel stays open so the reviewer can try again");
  } finally {
    v.close();
  }
});

test("a plain Cmd+A/Cmd+C copy is not a hand-off", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    await v.openMergedView();
    const host = v.$("#mc-merged-panel .mc-merged-editor-host");
    host.focus();
    v.key("a", { metaKey: true, code: "KeyA" });
    v.key("c", { metaKey: true, code: "KeyC" });
    await v.settle(60);

    assert.equal(v.window.reviewComments.length, 1, "asking for the text does not spend the review");
  } finally {
    v.close();
  }
});

// Archived is retrievable, which is the whole difference from deleted: the sidebar lists what was handed
// over and puts a thread back into the review.
test("the sidebar lists what was handed over and can put it back", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);

    const panel = v.$("#archive-panel");
    assert.ok(panel && !panel.classList.contains("hidden"), "the archive appears once something is in it");
    const rows = v.$all("#archive-panel .archive-row");
    assert.equal(rows.length, 1, "one row per handed-over thread");
    assert.match(rows[0].textContent, /why this change\?/, "the row says which review it was");

    rows[0].click();
    await v.settle(60);
    assert.equal(v.window.reviewComments.length, 1, "clicking it puts the thread back in the review");
    assert.equal(v.window.archivedComments.length, 0, "and takes it out of the archive");
    assert.ok(v.$("#archive-panel").classList.contains("hidden"), "an empty archive shows no drawer");
  } finally {
    v.close();
  }
});
