// CORE USER FLOW: marking a file "viewed" (Shift+,) and continuing the review with F7.
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

test("marking the current diff file viewed auto-advances to the next unviewed change", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);
  assert.equal(v.activeDiffFile(), "src/a.ts", "started reviewing a.ts");

  v.key("<"); // Shift+, marks a.ts viewed
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "auto-advanced to the next unviewed file (not stranded on a.ts)");
  v.close();
});

test("when every file is viewed, marking the last stays put (content never goes blank)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);

  v.key("<"); // a.ts viewed -> advance to b.ts
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts");

  v.key("<"); // b.ts viewed -> nothing unviewed left -> stay on b.ts (no blank jump)
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts", "all viewed: stays on the last file instead of blanking");
  v.close();
});

test("F7 skips a viewed file instead of landing on its hidden body", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);
  v.key("<"); // a viewed -> auto-advance to b
  await v.settle(140);
  assert.equal(v.activeDiffFile(), "src/b.ts");

  // From b, F7 must never drop back onto the viewed (hidden) a.ts.
  v.key("F7");
  await v.settle(140);
  assert.notEqual(v.activeDiffFile(), "src/a.ts", "F7 never lands on the viewed file a.ts");
  v.close();
});

test("Cmd+< marks the arrow-selected Changes row instead of the open file", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a.ts");
  await v.settle(100);

  v.key("0", { metaKey: true, code: "Digit0" });
  await v.settle(40);
  v.key("ArrowDown");
  await v.settle(40);
  assert.ok(v.$('.change-row[data-file="src/b.ts"]').classList.contains("tree-focus"), "b.ts is selected by the sidebar cursor");

  v.key("<", { metaKey: true, code: "Comma", shiftKey: true });
  await v.settle(80);
  assert.ok(v.$('.change-row[data-file="src/b.ts"]').classList.contains("viewed"), "selected b.ts is marked viewed");
  assert.equal(v.$('.change-row[data-file="src/a.ts"]').classList.contains("viewed"), false, "open a.ts is untouched");
  assert.equal(v.activeDiffFile(), "src/a.ts", "marking a sidebar selection does not replace the open file");
  v.close();
});
