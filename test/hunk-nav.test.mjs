// F7 / Shift+F7 must visit the SAME changes in both directions. Two ways they did not:
//
// 1. A change block that exists only on the base side — a run of deleted lines inside a hunk that also
//    edits something — was not a stop at all. changeBlockAnchors scanned the working-tree side only, and
//    the caret entered a hunk at its first NEW-side change, which is past a leading deletion. So F7 walked
//    the whole review without ever landing on deleted code. The default context is 12 lines, so a hunk
//    holding several separate edits is the normal case, not an edge one.
// 2. Crossing a file backward entered it at its FIRST change, and the next Shift+F7 then left the file
//    again — every change after the first was unreachable going backward.
//
// Both are IntelliJ's semantics: its difference list is side-agnostic (PrevNextDifferenceIterable walks
// LineFragments, a pure deletion among them) and it enters a file backward at its last difference
// (ScrollToPolicy.LAST_CHANGE). Its DiffBundle also ships press.again.to.go.to.the.previous.file, so the
// file-boundary announcement is symmetric; kakapo's used to fire forward only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
// Two edits 4 lines apart: one @@ hunk, two change blocks, both on the working-tree side.
const twoBlocks = lines(30).replace("line 5\n", "line 5 EDITED\n").replace("line 9\n", "line 9 EDITED\n");
// A deletion block and an edit under one @@: the deletion exists on the base side only.
const delAndEdit = lines(30).replace("line 10\nline 11\nline 12\n", "").replace("line 20\n", "line 20 EDITED\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a-two-blocks.ts", before: lines(30), after: twoBlocks },
    { path: "src/b-del-and-edit.ts", before: lines(30), after: delAndEdit },
  ]));
});
after(() => cleanupFixtures());

/** The caret's row as "<side>:<code>" — side is base/work, code is the line it sits on. */
function caret(v) {
  const row = v.$(".mc-diff-cursor-row");
  if (!row) return null;
  const wrapper = row.closest(".d2h-file-wrapper");
  const sides = Array.from(wrapper.querySelectorAll(".d2h-file-side-diff"));
  const side = row.closest(".d2h-file-side-diff") === sides[0] ? "base" : "work";
  const ctn = row.querySelector(".d2h-code-line-ctn");
  return side + ":" + (ctn ? ctn.textContent.trim() : "");
}
function hint(v) {
  const el = v.$(".mc-caret-hint");
  return el && el.classList.contains("show") ? el.textContent.trim() : "";
}

test("a deletion-only block inside a hunk that also edits is a change block", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  const wrapper = v.$('.d2h-file-wrapper:not(.df-inactive)');
  assert.deepEqual(
    Array.from(v.window.changeBlockAnchors(wrapper)).length,
    2,
    "the deleted run and the edit are two stops, not one",
  );
  v.close();
});

test("F7 lands on deleted lines and then on the edit below them", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  assert.equal(caret(v), "base:line 10", "entering the file lands on the first change, which is the deletion");

  v.key("F7");
  await v.settle(140);
  assert.equal(caret(v), "work:line 20 EDITED", "F7 steps forward to the edit in the same hunk");

  v.key("F7", { shiftKey: true });
  await v.settle(140);
  assert.equal(caret(v), "base:line 10", "Shift+F7 comes back to the deletion");
  v.close();
});

test("Shift+F7 enters the previous file at its last change, not its first", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  assert.equal(caret(v), "base:line 10", "at the first change of the second file");

  v.key("F7", { shiftKey: true }); // first press announces the file boundary
  await v.settle(140);
  assert.match(hint(v), /Shift\+F7/, "the boundary announcement fires backward too");
  assert.equal(caret(v), "base:line 10", "and the announcing press does not move the caret");

  v.key("F7", { shiftKey: true }); // second press crosses
  await v.settle(200);
  assert.equal(v.activeDiffFile(), "src/a-two-blocks.ts");
  assert.equal(caret(v), "work:line 9 EDITED", "backward entry lands on the previous file's LAST change");

  v.key("F7", { shiftKey: true });
  await v.settle(140);
  assert.equal(caret(v), "work:line 5 EDITED", "and the next press reaches the one before it");
  v.close();
});

test("walking the review forward and backward visits the same changes", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/a-two-blocks.ts");
  await v.settle(140);

  const walk = async (shift) => {
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const at = caret(v);
      if (at && seen[seen.length - 1] !== at) seen.push(at);
      v.key("F7", shift ? { shiftKey: true } : {});
      await v.settle(160);
    }
    return seen;
  };
  const forward = await walk(false);
  const backward = await walk(true);
  assert.deepEqual(
    forward,
    ["work:line 5 EDITED", "work:line 9 EDITED", "base:line 10", "work:line 20 EDITED"],
    "forward visits every change block in both files",
  );
  assert.deepEqual(backward.slice().reverse(), forward, "backward visits exactly the same ones");
  v.close();
});
