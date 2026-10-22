// A changed file does not always have a change BLOCK. An empty file added, a pure rename, a mode change —
// git reports the file as changed, the sidebar lists it, and it has no hunks at all.
//
// Every sidebar row carries data-hunk = the index of its first hunk, and for one of these that is simply
// the NEXT file's first index — or one past the end when it is last. So the number named someone else's
// change, and setActive wraps an out-of-range index with a modulo back onto hunk 0. Clicking such a file
// opened a different one or did nothing, and F7 stepped straight past it: with the caret on the last real
// hunk it said "no more changes this way" while the sidebar plainly showed more files below.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "a-first.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "c-last.ts", before: "export const c = 1;\n", after: "export const c = 2;\n" },
  ]));
});
after(cleanupFixtures);

// The condition itself, built by hand: a row whose data-hunk names a hunk that belongs to another file.
// That is what render-tree produces for a file with no hunks of its own — firstHunk is assigned before the
// file's own (zero) hunks are counted, so it is the NEXT file's index, or one past the end when it is last.
// It cannot be produced through the fixture: git's diff of an added empty file still carries a hunk header,
// and the shapes that do not (a pure rename, a mode change) need git operations the fixture does not do.
// Verified in the running app on a real repository: empty-added.txt carried hunk 0, which is pic.png's.

test("every file in the diff is somewhere the review can go", () => {
  // Not "has a hunk" — "has a target". A file with no change block still has to be reachable.
  const wrappers = (v) => [...v.window.document.querySelectorAll("#diff2html-container .d2h-file-wrapper")]
    .map((w) => (w.dataset.path || (w.querySelector(".d2h-file-name") || {}).textContent || "").trim());
  return loadViewer(html).then((v) => {
    try {
      const targets = v.window.diffNavTargets();
      for (const path of wrappers(v)) {
        assert.ok(targets.some((t) => t.path === path), `${path} has a navigation target`);
      }

      // Now make one genuinely hunkless — git's own shapes for it need operations the fixture does not do,
      // so take the hunk rows away. Without this the "else" branch below is never reached and the claim
      // the test is making is only true by accident.
      const wrapper = v.window.diffWrapperByPath("c-last.ts");
      wrapper.querySelectorAll(".hunk, .hunk-peer").forEach((row) => row.classList.remove("hunk", "hunk-peer"));
      delete wrapper.dataset.hunkCount;
      const after = v.window.diffNavTargets().filter((t) => t.path === "c-last.ts");
      assert.equal(after.length, 1, "a file with no change block still gets exactly one target");
      assert.equal(after[0].hunk, -1, "and it is the file itself, not a hunk");
    } finally {
      v.close();
    }
  });
});

test("a row whose hunk number belongs to another file does not navigate by it", async () => {
  const v = await loadViewer(html);
  try {
    const first = v.$('.change-row[data-file="a-first.ts"]');
    const second = v.$('.change-row[data-file="c-last.ts"]');
    assert.ok(v.window.diffHunkForLink(first) >= 0, "an ordinary row resolves its own hunk");

    // Exactly what a hunkless file's row carries: the following file's first hunk.
    const borrowed = second.dataset.hunk;
    first.dataset.hunk = borrowed;
    assert.equal(v.window.diffHunkForLink(first), -1,
      "the number is rejected because that hunk is not this file's");

    // And out of range entirely, which is what the LAST file gets.
    first.dataset.hunk = String(v.window.hunkTotal() + 5);
    assert.equal(v.window.diffHunkForLink(first), -1, "an out-of-range number is rejected too");
  } finally {
    v.close();
  }
});

test("opening a file by path puts the review on that file", async () => {
  const v = await loadViewer(html);
  try {
    assert.equal(v.window.activateDiffFile("c-last.ts", false), true, "the file opens");
    await v.settle(120);
    assert.equal(v.$('.change-row[data-file="c-last.ts"]').classList.contains("active"), true,
      "its sidebar row is the active one");
    assert.match(v.$("#diff-breadcrumb")?.textContent ?? "", /c-last\.ts/, "and the breadcrumb names it");
    assert.equal(v.window.activateDiffFile("nothing-here.ts", false), false, "a path with no file says so");
  } finally {
    v.close();
  }
});
