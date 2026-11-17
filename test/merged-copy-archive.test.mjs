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

test("Cmd+Z brings the handed-over review back, and takes it out of the archive", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);
    assert.equal(v.window.reviewComments.length, 0);
    assert.equal(v.window.archivedComments.length, 1, "precondition: the hand-off filed it away");

    v.key("z", { metaKey: true, code: "KeyZ" });
    await v.settle(60);
    assert.equal(v.window.reviewComments.length, 1, "one undo restores the batch");
    assert.equal(v.window.reviewComments[0].text, "why this change?");
    assert.equal(v.window.archivedComments.length, 0,
      "a comment that is back in the review is not also still handed over");

    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);
    assert.equal(v.window.archivedComments.length, 1, "handed over twice is still one handed-over comment");
    assert.equal(v.$all("#archive-panel .archive-row").length, 1, "and the list shows it once");
  } finally {
    v.close();
  }
});

test("a failed clipboard write archives nothing", async () => {
  const v = await withComment("why this change?");
  try {
    await v.openMergedView();
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

test("a comment that arrives while the panel is open is in the hand-off", async () => {
  const v = await withComment("why this change?");
  try {
    const clipboard = installClipboard(v);
    await v.openMergedView();
    assert.equal(v.$all("#mc-merged-panel .mc-merged-card").length, 1, "the panel starts with the one comment");

    v.window.addComment("?", FILE, 1, "export const a = 2;", "and this one landed while you were reading",
      1, 1, "new");
    v.window.saveComments();
    v.window.refreshComments();
    await v.settle(60);

    assert.equal(v.$all("#mc-merged-panel .mc-merged-card").length, 2, "the panel followed the review");

    copyButton(v).click();
    await v.settle(60);
    assert.match(clipboard.text, /why this change\?/, "the first comment was handed over");
    assert.match(clipboard.text, /landed while you were reading/, "and so was the one that arrived after");
    assert.equal(v.window.reviewComments.length, 0, "both left the review with it, not just the one on screen");
  } finally {
    v.close();
  }
});

test("an arriving comment does not move the reviewer's place", async () => {
  const v = await withComment("first");
  try {
    await v.openMergedView();
    for (const text of ["second", "third"]) {
      v.window.addComment("?", FILE, 1, "export const a = 2;", text, 1, 1, "new");
    }
    v.window.saveComments();
    v.window.refreshComments();
    await v.settle(60);

    const cards = v.$all("#mc-merged-panel .mc-merged-card");
    assert.equal(cards.length, 3, "all three are on screen");
    cards[2].click();
    await v.settle(20);
    assert.ok(cards[2].classList.contains("selected"), "the reviewer is on the last card");

    v.window.addComment("?", FILE, 1, "export const a = 2;", "fourth", 1, 1, "new");
    v.window.saveComments();
    v.window.refreshComments();
    await v.settle(60);

    const after = v.$all("#mc-merged-panel .mc-merged-card");
    assert.equal(after.length, 4, "the new one is there");
    assert.equal(after.findIndex((c) => c.classList.contains("selected")), 2,
      "and the reviewer is still on the card they were reading, not sent back to the top");
  } finally {
    v.close();
  }
});

function pressOn(v, element, key, mods = {}) {
  element.dispatchEvent(new v.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

async function twoComments() {
  const v = await withComment("first question");
  v.window.addComment("?", FILE, 1, "export const a = 2;", "second question", 1, 1, "new");
  v.window.saveComments();
  v.window.refreshComments();
  await v.settle(60);
  return v;
}

test("Cmd+C on one card hands over that card and leaves the rest of the review", async () => {
  const v = await twoComments();
  try {
    const clipboard = installClipboard(v);
    await v.openMergedView();
    const cards = v.$all("#mc-merged-panel .mc-merged-card");
    assert.equal(cards.length, 2, "both comments are in the panel");

    cards[0].focus();
    pressOn(v, cards[0], "c", { metaKey: true });
    await v.settle(80);

    assert.match(clipboard.text, /first question/, "the card that was copied reached the clipboard");
    assert.doesNotMatch(clipboard.text, /second question/, "and only that card");
    assert.equal(v.window.reviewComments.length, 1, "the copied comment left the active review");
    assert.equal(v.window.reviewComments[0].text, "second question", "the one that was not copied stayed");
    assert.equal(v.window.archivedComments.length, 1, "kept, not deleted");
    assert.ok(v.$("#mc-merged-panel"), "the panel stays open — there is still a review to work through");
    assert.equal(v.$all("#mc-merged-panel .mc-merged-card").length, 1, "rebuilt without the card that left");
  } finally {
    v.close();
  }
});

test("Cmd+A then Cmd+C hands over the whole panel and empties it", async () => {
  const v = await twoComments();
  try {
    const clipboard = installClipboard(v);
    await v.openMergedView();
    const first = v.$("#mc-merged-panel .mc-merged-card");
    first.focus();
    pressOn(v, first, "a", { metaKey: true });
    await v.settle(20);
    assert.ok(v.$(".mc-merged-select-all"), "select-all is what Cmd+A puts the panel into");

    pressOn(v, first, "c", { metaKey: true });
    await v.settle(80);

    assert.match(clipboard.text, /first question/);
    assert.match(clipboard.text, /second question/, "the whole panel reached the clipboard");
    assert.equal(v.window.reviewComments.length, 0, "and the whole panel left the active review");
    assert.equal(v.window.archivedComments.length, 2, "kept, not deleted");
    assert.equal(v.$("#mc-merged-panel"), null, "the panel closes — there is nothing left in it");
  } finally {
    v.close();
  }
});

test("handing the review over records where the reviewer stopped reading", async () => {
  const v = await withComment("why this change?");
  try {
    installClipboard(v);
    let marks = 0;
    v.window.kakapoGit = { markRead: () => { marks += 1; return Promise.resolve({ ok: true }); } };

    await v.openMergedView();
    assert.equal(marks, 0, "opening the panel is not a hand-off");

    copyButton(v).click();
    await v.settle(60);
    assert.equal(marks, 1, "the hand-off set the mark");
  } finally {
    v.close();
  }
});

test("a hand-off whose mark cannot be written is still a hand-off", async () => {
  const v = await withComment("why this change?");
  try {
    const clipboard = installClipboard(v);
    v.window.kakapoGit = { markRead: () => { throw new Error("no repository"); } };

    await v.openMergedView();
    copyButton(v).click();
    await v.settle(60);

    assert.match(String(clipboard.text), /why this change\?/, "the review reached the clipboard");
    assert.equal(v.window.reviewComments.length, 0, "and left the active review as usual");
    assert.equal(v.window.archivedComments.length, 1, "filed away, not lost");
    assert.match(v.$("#mc-toasts").textContent, /archived|보관/i, "and said so, so the hand-off finished");
  } finally {
    v.close();
  }
});
