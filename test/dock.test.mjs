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
  const css = Array.from(v.document.querySelectorAll("style"), (style) => style.textContent || "").join("\n");
  assert.match(css, /body\.native-app\.dock-maximized\s+\.dock-bar\s*\{[^}]*padding-left:\s*var\(--native-title-safe-left\)/, "full-screen writing panels keep their title beyond the macOS traffic lights");
  assert.match(css, /body\.native-app\.dock-maximized\s+\.dock-bar\s+button,[\s\S]{0,180}-webkit-app-region:\s*no-drag/, "full-screen writing-panel buttons stay clickable");
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
// ⌘0 Changes tree answered the same keystroke by popping its row menu.
test("the merged dock copies the document without also opening the focused tree row's menu", async () => {
  const v = await loadViewer(html);
  let copied = null;
  v.window.kakapoClipboard = { write: (text) => { copied = text; return true; } };
  v.window.addComment("q", "src/app.ts", 1, "", "why this change?");
  await v.openDiffFor("src/app.ts");
  v.window.focusTree(v.window.treeRows().findIndex((row) => row.dataset.file)); // a FILE selected in the ⌘0 Changes panel
  await v.openMergedView();
  await v.settle(20);
  v.$("#mc-merged-panel .mc-copy-all").click();
  await v.settle(30);
  assert.match(copied || "", /why this change\?/, "the comment leaves the panel");
  assert.equal(v.$("#mc-dropdown"), null, "and no tree row menu opens behind it");
  v.close();
});
