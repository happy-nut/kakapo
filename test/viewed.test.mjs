// CORE USER FLOW: marking a file "viewed" (Shift+,) and continuing the review with F7.
//
// A viewed file's diff body is hidden (display:none), so the caret must never be left stranded on it — that
// blanks the content area and makes F7 look stuck. Marking viewed auto-advances to the next unviewed change,
// and F7 skips viewed files. Guards the regression where viewing the file you were reading froze navigation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures, renderLazyBodies } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]));
});
after(cleanupFixtures);
const toggleViewed = (v) => v.key("<", { code: "Comma", shiftKey: true });

test("marking the current diff file viewed auto-advances to the next unviewed change", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);
  assert.equal(v.activeDiffFile(), "src/a.ts", "started reviewing a.ts");

  v.key(",", { code: "Comma" });
  await v.settle(40);
  assert.equal(v.activeDiffFile(), "src/a.ts", "an unmodified comma does not mark a review file");
  v.key("<", { metaKey: true, code: "Comma", shiftKey: true });
  await v.settle(40);
  assert.equal(v.activeDiffFile(), "src/a.ts", "the retired Cmd+Shift+, chord no longer marks a review file");
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
  assert.equal(viewedButton.dataset.keyhint, "⇧,", "the compact hint names the actual physical chord");
  assert.match(viewedButton.getAttribute("title"), /Shift\+,/, "the long hint names Shift+Comma without Cmd/Ctrl");
  viewedButton.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(20);
  assert.match(v.$("#mc-button-hint").textContent, /⇧,/, "the custom tooltip shows the corrected chord");
  assert.equal(viewedButton.hasAttribute("title"), false, "the native title bubble is suppressed while the custom hint owns hover");
  v.click(viewedButton);
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "mouse and keyboard viewed actions share the same advance rule");
  assert.ok(v.$('.d2h-file-wrapper:not(.df-inactive) .d2h-files-diff'), "the next diff body is visible");
  v.close();
});

test("explicitly selecting a previously viewed file opens that exact diff", async () => {
  const v = await loadViewer(html);
  v.window.setFileViewed("src/a.ts", true);

  await v.openDiffFor("src/a.ts");
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/a.ts", "a sidebar click never redirects to a different file");
  const activeBody = v.$('.d2h-file-wrapper:not(.df-inactive) .d2h-files-diff');
  assert.ok(activeBody, "the explicitly selected viewed diff body is present");
  assert.notEqual(v.window.getComputedStyle(activeBody).display, "none", "a viewed diff remains inspectable on demand");
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

test("viewed state survives restart for the same per-file diff", async () => {
  const storageKey = "kakapo-diff-viewed:/review.html";
  const first = await loadViewer(html);
  first.window.setFileViewed("src/a.ts", true);
  const persisted = first.window.localStorage.getItem(storageKey);
  const stored = JSON.parse(persisted || "{}");
  assert.equal(typeof stored["src/a.ts"], "string", "the reviewed patch is stored by its per-file signature");
  first.close();

  const reopened = await loadViewer(html, { seedStorage: { [storageKey]: persisted } });
  assert.equal(reopened.window.isFileViewed("src/a.ts"), true, "an unchanged reviewed patch remains viewed after restart");
  assert.ok(reopened.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), "the sidebar restores the visible check badge");
  reopened.close();
});

test("live refresh keeps unchanged viewed marks visible and reopens a file when its diff changes", async () => {
  const first = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]);
  const unrelated = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 3;\n" },
  ]);
  const changed = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 4;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 3;\n" },
  ]);
  const v = await loadViewer(first.html, { menuBridge: true });
  v.window.setFileViewed("src/a.ts", true);

  await v.pushDiffUpdate(unrelated.build.update);
  assert.equal(v.window.isFileViewed("src/a.ts"), true, "an unrelated file edit preserves the reviewed patch");
  assert.ok(v.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), "the rebuilt Changes tree still exposes the viewed state");

  await v.pushDiffUpdate(changed.build.update);
  assert.equal(v.window.isFileViewed("src/a.ts"), false, "editing the reviewed file puts its new diff back in the F7 queue");
  assert.equal(v.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), false, "the stale check badge is removed");
  v.close();
});

test("legacy path-only viewed booleans do not hide a newer diff", async () => {
  const storageKey = "kakapo-diff-viewed:/review.html";
  const v = await loadViewer(html, { seedStorage: { [storageKey]: JSON.stringify({ "src/a.ts": true }) } });
  assert.equal(v.window.isFileViewed("src/a.ts"), false, "ambiguous legacy marks are safely returned to review");
  assert.equal(v.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), false, "the file is visibly reviewable");
  v.close();
});

test("lazy F7 and direct selection include changed hidden config files", async () => {
  const review = await makeReviewHtml([
    { path: ".claude/settings.json", before: "{\n  \"enabled\": true\n}\n", after: "{\n  \"enabled\": true,\n  \"rules\": [\"review\"]\n}\n" },
    { path: ".gitignore", before: "node_modules/\n", after: "node_modules/\n.kakapo/\n" },
    { path: "docs/plan.md", before: "# Plan\nold\n", after: "# Plan\nnew\n" },
  ], { lazyLoad: true, app: true });
  const bodies = await renderLazyBodies(review.build);
  const storageKey = "kakapo-diff-viewed:/review.html";
  const v = await loadViewer(review.html, {
    seedStorage: { [storageKey]: JSON.stringify({ ".claude/settings.json": true, ".gitignore": true }) },
    getDiffBody: (index) => bodies[index] || "",
  });
  await v.settle(120);

  assert.equal(v.activeDiffFile(), ".claude/settings.json", "legacy viewed state cannot make F7 start after settings.json");
  v.key("F7"); // first press announces the file boundary
  v.key("F7"); // second press crosses it
  await v.settle(160);
  assert.equal(v.activeDiffFile(), ".gitignore", "F7 navigates into the changed .gitignore hunk");

  await v.openDiffFor(".claude/settings.json");
  await v.settle(120);
  const active = v.$('.d2h-file-wrapper:not(.df-inactive)');
  assert.equal(active.dataset.path, ".claude/settings.json", "explicit selection opens the hidden config path itself");
  assert.equal(active.querySelectorAll(".d2h-file-side-diff").length, 2, "the lazy side-by-side diff body is materialized");
  assert.match(active.textContent, /rules/, "the settings diff content is visible");
  v.close();
});

test("Shift+, marks the arrow-selected Changes row instead of the open file", async () => {
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
