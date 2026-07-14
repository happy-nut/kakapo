// CORE USER FLOW: merged prompts and the memo share one review-focused floating slot.
//
// The merged views and the memo open as large FLOATING panels (.dock-panel + a dim .dock-backdrop, ~90% of
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

test("merged view opens as a large floating panel (.dock-panel + backdrop), not the old inline dock/modal", async () => {
  const v = await loadViewer(html);
  await v.openMergedView("q");
  assert.ok(v.$("#mc-merged-panel.dock-panel"), "merged opens as a .dock-panel");
  assert.ok(v.$(".dock-backdrop"), "a dim backdrop sits behind the floating panel");
  assert.ok(v.window.document.body.classList.contains("floating-dock"), "body.floating-dock scopes the floating + maximize CSS");
  assert.equal(v.$("#mc-modal"), null, "not the old .mc-modal overlay");
  v.close();
});

test("memo toggles open then closed with its shortcut", async () => {
  const v = await loadViewer(html);
  await v.openMemo();
  assert.ok(v.$("#mc-memo-panel.dock-panel"), "memo dock open");
  await v.openMemo();
  assert.equal(v.$("#mc-memo-panel"), null, "a second press closes it (toggle)");
  v.close();
});

test("opening one dock closes the other (exclusive slot)", async () => {
  const v = await loadViewer(html);
  await v.openMergedView("q");
  assert.ok(v.$("#mc-merged-panel"), "merged open");
  await v.openMemo();
  assert.ok(v.$("#mc-memo-panel"), "memo open");
  assert.equal(v.$("#mc-merged-panel"), null, "merged closed when the memo took the slot");
  v.close();
});

test("Cmd/Ctrl+Shift+' maximizes the active dock and restores it (toggle)", async () => {
  const v = await loadViewer(html);
  await v.openMergedView("q");
  assert.equal(v.isDockMaximized(), false, "starts un-maximized");
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), true, "maximized");
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
  await v.openMergedView("q");
  v.toggleDockMax();
  await v.settle(20);
  assert.equal(v.isDockMaximized(), true);
  v.$("#mc-merged-panel .dock-close").click(); // close via the bar's Close button
  await v.settle(20);
  assert.equal(v.$("#mc-merged-panel"), null, "dock closed");
  assert.equal(v.isDockMaximized(), false, "maximized state cleared once nothing is docked");
  v.close();
});
