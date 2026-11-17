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

test("every file in the diff is somewhere the review can go", () => {
  const wrappers = (v) => [...v.window.document.querySelectorAll("#diff2html-container .d2h-file-wrapper")]
    .map((w) => (w.dataset.path || (w.querySelector(".d2h-file-name") || {}).textContent || "").trim());
  return loadViewer(html).then((v) => {
    try {
      const targets = v.window.diffNavTargets();
      for (const path of wrappers(v)) {
        assert.ok(targets.some((t) => t.path === path), `${path} has a navigation target`);
      }

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

    const borrowed = second.dataset.hunk;
    first.dataset.hunk = borrowed;
    assert.equal(v.window.diffHunkForLink(first), -1,
      "the number is rejected because that hunk is not this file's");

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
