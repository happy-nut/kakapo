// CORE USER FLOW: merged prompts and the memo share one review-focused floating slot.
//
// The merged views and the memo open as focused FLOATING writing panels (.dock-panel + a dim .dock-backdrop,
// sized to the document width rather than the whole window),
// the window), sharing ONE slot — opening one closes the others — and Cmd/Ctrl+Shift+' maximizes the active
// panel to full screen. Guards that wiring: floating panel + backdrop, exclusive slot, toggle, maximize/restore.
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

// The keyboard tests below need a panel with cards in it: the dock's list behaviour only exists when the
// review has comments, and a card is the one thing in it the arrows move between.
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
  // What used to be asserted here was the TEXT of two `body.native-app.dock-maximized` rules. The app
  // stopped setting `native-app` when the integrated title bar went away — render.ts omits it on purpose
  // and views.test.mjs pins that — so those rules cannot match, and asserting they are still written down
  // meant this test defended dead CSS: it would have failed the cleanup rather than the regression.
  // What is worth pinning is what a maximized panel actually does, which is answerable from the DOM.
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
  v.$("#mc-merged-panel .dock-close").click(); // close via the bar's Close button
  await v.settle(20);
  assert.equal(v.$("#mc-merged-panel"), null, "dock closed");
  assert.equal(v.isDockMaximized(), false, "maximized state cleared once nothing is docked");
  v.close();
});

// A key the dock claimed is the dock's alone. ⌥⏎ closes the panel synchronously on its way out, so by the
// time it reached the window keymap "a dock is focused" was already false — and a file left selected in the
// ⌘2 Changes tree answered the same keystroke by popping its row menu.
test("the merged dock copies the document without also opening the focused tree row's menu", async () => {
  const v = await loadViewer(html);
  let copied = null;
  v.window.kakapoClipboard = { write: (text) => { copied = text; return true; } };
  v.window.addComment("q", "src/app.ts", 1, "", "why this change?");
  await v.openDiffFor("src/app.ts");
  v.window.focusTree(v.window.treeRows().findIndex((row) => row.dataset.file)); // a FILE selected in the ⌘2 Changes panel
  await v.openMergedView();
  await v.settle(20);
  v.$("#mc-merged-panel .mc-copy-all").click();
  await v.settle(30);
  assert.match(copied || "", /why this change\?/, "the comment leaves the panel");
  assert.equal(v.$("#mc-dropdown"), null, "and no tree row menu opens behind it");
  v.close();
});

// aria-modal is a promise about Tab, and four surfaces made it while none of them kept it: Tab walked out
// of the dock into the sidebar behind the dim backdrop — which is click-blocked, so what you reached could
// be seen, announced and focused, but not used, and the way back in was a mouse.
test("Tab cannot leave the hand-off panel", async () => {
  const v = await openDockWithComment();
  try {
    const panel = v.$("#mc-merged-panel");
    assert.ok(panel, "the panel is up");
    assert.equal(panel.getAttribute("role"), "dialog", "it says what it is");
    assert.equal(panel.getAttribute("aria-modal"), "true", "and that it is modal");

    const tabbable = [...panel.querySelectorAll("button:not([disabled])")];
    assert.ok(tabbable.length >= 2, "the bar has controls to cycle between");

    // From the last one, Tab wraps to the first rather than falling out of the panel.
    tabbable[tabbable.length - 1].focus();
    panel.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(v.window.document.activeElement, tabbable[0], "Tab wrapped to the first control");

    // And from the first, Shift+Tab wraps back to the last.
    panel.dispatchEvent(new v.window.KeyboardEvent("keydown",
      { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(v.window.document.activeElement, tabbable[tabbable.length - 1],
      "Shift+Tab wrapped to the last control");
  } finally {
    v.close();
  }
});

// A comment card is tabindex -1 — it is reached with the arrows, not with Tab — so Tab from one used to
// fall through to whatever followed the panel in document order, which is outside it.
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

// The arrows walk one card at a time, which is the whole keyboard route through a hand-off. At forty
// comments that is forty presses to reach the last one; History has had PageUp/PageDown since it shipped.
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
