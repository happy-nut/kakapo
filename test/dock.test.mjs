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

test("the worktree memo restores as one inline-rendered Markdown document and autosaves", async () => {
  const now = new Date().toISOString();
  const v = await loadViewer(html, {
    memoBridge: {
      version: 1,
      worktreePath: "/repo/worktrees/feature-a",
      body: "# Plan\n\nA real paragraph.",
      updatedAt: now,
    },
  });
  await v.openMemo();
  const editor = v.$("#mc-memo-panel .mc-inline-editor.markdown-body");
  assert.equal(editor.querySelector("h1")?.textContent, "Plan", "stored Markdown opens already rendered in the editable surface");
  assert.equal(v.$("#mc-memo-panel .mc-memo-preview"), null, "there is no side preview pane");
  assert.equal(v.$("#mc-memo-panel .mc-memo-sidebar"), null, "a single memo needs no note list");

  v.typeInto(editor, "Updated inline memo");
  await v.settle(260);
  assert.ok(v.window.__memoOperations.some((op) => op.kind === "write" && /Updated inline memo/.test(op.body)), "the edit autosaves through the app-data bridge");
  v.close();
});

test("opening and closing an unchanged note does not rewrite or reorder it", async () => {
  const now = new Date().toISOString();
  const v = await loadViewer(html, {
    memoBridge: { version: 1, worktreePath: "/repo/wt", body: "No edit", updatedAt: now },
  });
  await v.openMemo();
  await v.openMemo();
  await v.settle(30);
  assert.equal(v.window.__memoOperations.length, 0, "no CRUD call is made when content did not change");
  v.close();
});

test("the single Markdown memo can be cleared without a note-list workflow", async () => {
  const v = await loadViewer(html, { memoBridge: { version: 1, worktreePath: "/repo/wt", body: "Delete me", updatedAt: new Date().toISOString() } });
  await v.openMemo();
  v.$(".mc-memo-delete").click();
  await v.settle(20);
  assert.equal(v.$(".mc-inline-editor").textContent.trim(), "");
  assert.deepEqual(v.window.__memoOperations.map((op) => op.kind), ["delete"]);
  v.close();
});

test("merged prompts render as one sanitized Markdown document instead of a side-by-side preview", async () => {
  const v = await loadViewer(html);
  await v.openMergedView("q");
  const preview = v.$("#mc-merged-panel .mc-merged-preview.markdown-body");
  assert.ok(preview, "the merged prompt has one rendered document");
  assert.ok(preview.querySelector("h1"), "prompt headings are rendered as Markdown");
  assert.equal(preview.querySelector("script"), null, "the shared sanitizer remains active");
  assert.equal(v.$("#mc-merged-panel textarea"), null, "no raw source pane competes with the rendered document");
  v.close();
});

test("the merged prompt reuses the inline Markdown editor and Copy all reflects live edits", async () => {
  const v = await loadViewer(html);
  let copied = null;
  v.window.monacoriClipboard = { write: (text) => { copied = text; } };
  await v.openMergedView("q");
  const editor = v.$("#mc-merged-panel .mc-inline-editor.mc-merged-preview[contenteditable='true']");
  assert.ok(editor, "the merged prompt is the same inline-editable surface as the memo");
  v.typeInto(editor, "Edited handoff prompt");
  v.$("#mc-merged-panel .mc-copy-all").click();
  await v.settle(20);
  assert.match(copied, /Edited handoff prompt/, "Copy all uses the current edited document, not the initial snapshot");
  v.close();
});

test("Cmd/Ctrl+Shift+' maximizes the active dock and restores it (toggle)", async () => {
  const v = await loadViewer(html);
  await v.openMergedView("q");
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
