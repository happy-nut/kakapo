// CORE USER FLOW: marking a file "viewed" (Cmd/Ctrl+Shift+,) and continuing the review with F7.
//
// A viewed file's diff body is hidden (display:none), so the caret must never be left stranded on it — that
// blanks the content area and makes F7 look stuck. Marking viewed auto-advances to the next unviewed change,
// and F7 skips viewed files. Guards the regression where viewing the file you were reading froze navigation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]));
});
after(cleanupFixtures);
const toggleViewed = (v) => v.key("<", { metaKey: true, code: "Comma", shiftKey: true });

test("marking the current diff file viewed auto-advances to the next unviewed change", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);
  assert.equal(v.activeDiffFile(), "src/a.ts", "started reviewing a.ts");

  v.key("<");
  await v.settle(40);
  assert.equal(v.activeDiffFile(), "src/a.ts", "plain Shift+, does not mark a review file");
  toggleViewed(v);
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "auto-advanced to the next unviewed file (not stranded on a.ts)");
  v.close();
});

test("clicking the Viewed toolbar button advances instead of leaving an empty diff", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);

  const viewedButton = v.$("#diff-viewed-toggle");
  assert.equal(viewedButton.dataset.keyhint, "⌘⇧,", "the compact hint names the actual macOS physical chord");
  assert.match(viewedButton.getAttribute("title"), /Cmd\/Ctrl\+Shift\+,/, "the long hint includes the required Shift key");
  viewedButton.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(20);
  assert.match(v.$("#mc-button-hint").textContent, /⌘⇧,/, "the custom tooltip shows the corrected chord");
  assert.equal(viewedButton.hasAttribute("title"), false, "the native title bubble is suppressed while the custom hint owns hover");
  v.click(viewedButton);
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "mouse and keyboard viewed actions share the same advance rule");
  assert.ok(v.$('.d2h-file-wrapper:not(.df-inactive) .d2h-files-diff'), "the next diff body is visible");
  v.close();
});

test("opening a previously viewed file redirects to the next unviewed file", async () => {
  const v = await loadViewer(html);
  v.window.setFileViewed("src/a.ts", true);

  await v.openDiffFor("src/a.ts");
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "startup restore and sidebar activation cannot strand a viewed file");
  v.close();
});

test("when every file is viewed, marking the last stays put (content never goes blank)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);

  toggleViewed(v); // a.ts viewed -> advance to b.ts
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts");

  toggleViewed(v); // b.ts viewed -> nothing unviewed left -> stay on b.ts (no blank jump)
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "all viewed: stays on the last file instead of blanking");
  const activeBody = v.$('.d2h-file-wrapper:not(.df-inactive) .d2h-files-diff');
  assert.ok(activeBody, "the active reviewed file keeps its diff body");
  assert.notEqual(v.window.getComputedStyle(activeBody).display, "none", "review completion never produces an empty canvas");
  v.close();
});

test("F7 skips a viewed file instead of landing on its hidden body", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);
  toggleViewed(v); // a viewed -> auto-advance to b
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts");

  // From b, F7 must never drop back onto the viewed (hidden) a.ts.
  v.key("F7");
  await v.settle(140);
  assert.notEqual(v.activeDiffFile(), "src/a.ts", "F7 never lands on the viewed file a.ts");
  v.close();
});

test("F7 still opens the diff from Files view after every changed file is viewed", async () => {
  const v = await loadViewer(html);
  v.window.setFileViewed("src/a.ts", true);
  v.window.setFileViewed("src/b.ts", true);
  await v.openSourceFile("src/a.ts");
  assert.equal(v.visibleView(), "source", "started in the source view with a fully reviewed queue");

  v.key("F7");
  await v.settle(140);

  assert.equal(v.visibleView(), "diff", "F7 re-enters the diff even when no unviewed hunk remains");
  assert.equal(v.activeDiffFile(), "src/a.ts", "the reviewed source file opens at its own diff");
  const activeBody = v.$('.d2h-file-wrapper:not(.df-inactive) .d2h-files-diff');
  assert.ok(activeBody, "the reviewed diff body is present");
  assert.notEqual(v.window.getComputedStyle(activeBody).display, "none", "review completion does not hide the reopened diff");
  v.close();
});

test("Cmd+Shift+, marks the arrow-selected Changes row instead of the open file", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);

  // From diff content, Cmd+0 moves focus to the open file in Changes so arrow navigation is deterministic.
  v.key("0", { metaKey: true, code: "Digit0" });
  await v.settle(40);
  v.key("ArrowDown");
  await v.settle(40);
  assert.ok(v.$('.change-row[data-file="src/b.ts"]').classList.contains("tree-focus"), "b.ts is selected by the sidebar cursor");

  toggleViewed(v);
  await v.settle(80);
  assert.ok(v.$('.change-row[data-file="src/b.ts"]').classList.contains("viewed"), "selected b.ts is marked viewed");
  assert.equal(v.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), false, "open a.ts is untouched");
  assert.equal(v.activeDiffFile(), "src/a.ts", "marking a sidebar selection does not replace the open file");
  v.close();
});
