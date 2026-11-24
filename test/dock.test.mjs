import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

async function openDockWithComment(count = 1) {
  const v = await loadViewer(html);
  for (let i = 0; i < count; i++) {
    v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", `comment ${i + 1}`, 1, 1, "new");
  }
  v.window.saveComments();
  await v.openMergedView();
  await v.settle(60);
  return v;
}

test("merged view opens as a focused floating panel (.dock-panel + backdrop), not the old inline dock/modal", async () => {
  const v = await loadViewer(html);
  await v.openMergedView();
  assert.ok(v.$("#mc-merged-panel.dock-panel"), "merged opens as a .dock-panel");
  assert.ok(v.$(".dock-backdrop"), "a dim backdrop sits behind the floating panel");
  assert.ok(v.window.document.body.classList.contains("floating-dock"), "body.floating-dock scopes the floating + maximize CSS");
  assert.equal(v.$("#mc-modal"), null, "not the old .mc-modal overlay");
  v.close();
});

test("Cmd/Ctrl+Shift+' maximizes the active dock and restores it (toggle)", async () => {
  const v = await loadViewer(html);
  await v.openMergedView();
  assert.equal(v.isDockMaximized(), false, "starts un-maximized");
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), true, "maximized");
  assert.equal(v.document.body.classList.contains("native-app"), false,
    "the integrated-title-bar layout is gone; rules scoped to it cannot run");
  const bar = v.$("#mc-merged-panel .dock-bar");
  assert.ok(bar, "a maximized panel still has its header bar");
  for (const button of bar.querySelectorAll("button")) {
    assert.ok(!button.disabled || button.classList.contains("mc-copy-all"),
      "its controls stay operable while maximized");
  }
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), false, "restored");
  v.close();
});

test("Cmd/Ctrl+Shift+' does nothing when no dock is open", async () => {
  const v = await loadViewer(html);
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), false, "no active dock -> nothing to maximize");
  v.close();
});

test("closing a maximized dock clears the maximized state", async () => {
  const v = await loadViewer(html);
  await v.openMergedView();
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), true);
  v.$("#mc-merged-panel .dock-close").click();
  await v.settle(20);
  assert.equal(v.$("#mc-merged-panel"), null, "dock closed");
  assert.equal(v.isDockMaximized(), false, "maximized state cleared once nothing is docked");
  v.close();
});

test("the merged dock copies the document without also opening the focused tree row's menu", async () => {
  const v = await loadViewer(html);
  let copied = null;
  v.window.kakapoClipboard = { write: (text) => { copied = text; return true; } };
  v.window.addComment("q", "src/app.ts", 1, "", "why this change?");
  await v.openDiffFor("src/app.ts");
  v.window.focusTree(v.window.treeRows().findIndex((row) => row.dataset.file));
  await v.openMergedView();
  await v.settle(20);
  v.$("#mc-merged-panel .mc-copy-all").click();
  await v.settle(30);
  assert.match(copied || "", /why this change\?/, "the comment leaves the panel");
  assert.equal(v.$("#mc-dropdown"), null, "and no tree row menu opens behind it");
  v.close();
});

test("Tab cannot leave the hand-off panel", async () => {
  const v = await openDockWithComment();
  try {
    const panel = v.$("#mc-merged-panel");
    assert.ok(panel, "the panel is up");
    assert.equal(panel.getAttribute("role"), "dialog", "it says what it is");
    assert.equal(panel.getAttribute("aria-modal"), "true", "and that it is modal");

    const tabbable = [...panel.querySelectorAll("button:not([disabled])")];
    assert.ok(tabbable.length >= 2, "the bar has controls to cycle between");

    tabbable[tabbable.length - 1].focus();
    panel.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(v.window.document.activeElement, tabbable[0], "Tab wrapped to the first control");

    panel.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(v.window.document.activeElement, tabbable[tabbable.length - 1],
      "Shift+Tab wrapped to the last control");
  } finally {
    v.close();
  }
});

test("Tab from a comment card lands in the panel, not behind it", async () => {
  const v = await openDockWithComment();
  try {
    const panel = v.$("#mc-merged-panel");
    const card = panel.querySelector(".mc-merged-card");
    assert.ok(card, "there is a card to start from");
    card.focus();
    panel.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Tab", bubbles: true, cancelable: true }));
    assert.ok(panel.contains(v.window.document.activeElement),
      "focus stayed inside the panel");
  } finally {
    v.close();
  }
});

test("the card list answers Home and End", async () => {
  const v = await openDockWithComment(4);
  try {
    const panel = v.$("#mc-merged-panel");
    const cards = [...panel.querySelectorAll(".mc-merged-card")];
    assert.ok(cards.length >= 3, `enough cards to move through (${cards.length})`);
    const press = (key) => cards[0].dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key, bubbles: true, cancelable: true }));

    cards[0].focus();
    press("End");
    assert.equal(v.window.document.activeElement, cards[cards.length - 1], "End reaches the last card");

    v.window.document.activeElement.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Home", bubbles: true, cancelable: true }));
    assert.equal(v.window.document.activeElement, cards[0], "Home comes back to the first");
  } finally {
    v.close();
  }
});

test("the review-comments shortcut toggles the panel instead of only opening it", async () => {
  const v = await loadViewer(html);
  v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", "why", 1, 1, "new");
  v.window.saveComments();

  v.window.SHORTCUT_ACTIONS.allComments();
  await v.settle(60);
  assert.ok(v.$("#mc-merged-panel"), "first press opens the panel");

  v.window.SHORTCUT_ACTIONS.allComments();
  await v.settle(60);
  assert.equal(v.$("#mc-merged-panel"), null, "second press closes it");
  assert.equal(v.window.document.body.classList.contains("dock-open"), false,
    "and releases the body state the open panel holds");

  v.window.SHORTCUT_ACTIONS.allComments();
  await v.settle(60);
  assert.ok(v.$("#mc-merged-panel"), "third press opens it again");
  v.close();
});

test("the menu's Review Comments item toggles too", async () => {
  const v = await loadViewer(html);
  v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", "why", 1, 1, "new");
  v.window.saveComments();
  v.window.toggleMergedView();
  await v.settle(60);
  assert.ok(v.$("#mc-merged-panel"), "opens");
  v.window.toggleMergedView();
  await v.settle(60);
  assert.equal(v.$("#mc-merged-panel"), null, "and closes");
  v.close();
});

test("the dock holds the menu's Edit keys only while nobody is typing, so ⌘V keeps working", async () => {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoApp = Object.assign({}, v.window.kakapoApp, {
    setIgnoreMenuShortcuts: (ignore) => asked.push(ignore),
  });
  v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", "why", 1, 1, "new");
  v.window.saveComments();
  await v.openMergedView();
  await v.settle(60);
  assert.deepEqual(asked, [true], "the open dock takes ⌘A from the menu");

  const field = v.window.document.getElementById("file-find-input");
  assert.ok(field, "the find box exists to focus");
  field.focus();
  v.window.document.dispatchEvent(new v.window.Event("focusin", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(asked, [true, false], "a caret in a field hands the menu keys back");
  assert.equal(v.window.menuChordsHeld, false, "and nothing is left holding them");

  field.blur();
  v.window.document.dispatchEvent(new v.window.Event("focusin", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(asked, [true, false, true], "leaving the field gives ⌘A back to the dock");
  v.close();
});
