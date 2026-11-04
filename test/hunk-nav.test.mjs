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

test("stepping stays in the pane the reader is in, deletion or not", async () => {
  // IntelliJ's policy, read off its source rather than guessed. SimpleDiffChangesHolder.getValidChanges
  // puts the SAME change list in both sides (the side only sorts it), so a deletion is a stop whichever
  // pane you are in; MyPrevNextDifferenceIterable then reads getCurrentSide() throughout, and
  // scrollToChange moves both editors' carets without ever calling setCurrentSide — that belongs to the
  // explicit "focus opposite pane" action. So the caret does not change pane on F7, ever.
  //
  // This file used to assert the opposite ("work:line 13"), because kakapo preferred the working-tree side
  // and fell back to the base one. The fallback made the caret cross the gutter uninvited, which is what
  // it was reported as.
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  // The deletion is still the first stop — what changed is only where the caret stands for it: the
  // working-tree line the removed text collapsed onto.
  assert.equal(caret(v), "work:line 13", "the file opens on its first change, in the working-tree pane");

  v.key("F7");
  await v.settle(140);
  assert.equal(caret(v), "work:line 20 EDITED", "forward to the edit, same pane");

  v.key("F7", { shiftKey: true });
  await v.settle(140);
  assert.equal(caret(v), "work:line 13", "and back to the deletion, still the same pane");
  v.close();
});

test("a step always moves, including back off a collapsed deletion", async () => {
  // The caret no longer stands at the anchor's own row: a deletion parks it several rows later, on the
  // working-tree line the removed text collapsed onto. Any comparison of "is there a change before me"
  // that still measured the ANCHOR against the CARET then found the block the caret was already standing
  // for, so Shift+F7 stepped to where it already was and the walk stopped dead there. Every anchor is
  // compared at the row it would park on, and this is the assertion that says so: a press moves, or the
  // caret has left the file.
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  const start = caret(v);
  assert.equal(start, "work:line 13", "parked on the line the deletion collapsed onto");

  v.key("F7");
  await v.settle(140);
  const forward = caret(v);
  assert.notEqual(forward, start, "forward moved");

  v.key("F7", { shiftKey: true });
  await v.settle(140);
  assert.equal(caret(v), start, "and back again");

  // The press that used to stall: backward from the collapsed position. It has no earlier change in this
  // file, so it must announce the boundary rather than silently landing on itself.
  v.key("F7", { shiftKey: true });
  await v.settle(140);
  assert.ok(caret(v) !== start || hint(v) !== "",
    "the press either moved the caret or said why it did not");
  v.close();
});

test("the deletion is still a stop — only the pane the caret stands in changed", async () => {
  // The half that must not regress. Reading both sides for the ANCHORS is what makes a run of deleted
  // lines inside an otherwise-edited hunk reachable at all: with twelve lines of context one @@ routinely
  // holds several edits, and scanning the working-tree side alone meant F7 could walk a whole review
  // without once stopping at deleted code.
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  const wrapper = v.$('.d2h-file-wrapper:not(.df-inactive)');
  assert.equal(Array.from(v.window.changeBlockAnchors(wrapper)).length, 2,
    "the deleted run and the edit are two stops, as they were");
  v.close();
});

test("Shift+F7 enters the previous file at its last change, not its first", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/b-del-and-edit.ts");
  await v.settle(140);
  assert.equal(caret(v), "work:line 13", "at the first change of the second file");

  v.key("F7", { shiftKey: true }); // first press announces the file boundary
  await v.settle(140);
  assert.match(hint(v), /⇧F7/, "the boundary announcement fires backward too, naming the table's chord");
  assert.equal(caret(v), "work:line 13", "and the announcing press does not move the caret");

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
    ["work:line 5 EDITED", "work:line 9 EDITED", "work:line 13", "work:line 20 EDITED"],
    "forward visits every change block in both files",
  );
  assert.deepEqual(backward.slice().reverse(), forward, "backward visits exactly the same ones");
  v.close();
});

// Crossing files the reader has already ticked off, out loud.
//
// The walk skips viewed files on purpose: a viewed file's diff body is display:none, so stopping in one
// would show an empty pane. It did it in silence, and ticking files off as you read is the normal way to
// use this app — so F7 routinely jumped several entries down the sidebar with nothing on screen to say
// why. Measured in the running app: with three files marked, F7 went from README.md straight to
// src/analysis.ts and said nothing. The crossing is right; the silence was the defect.
//
// Names chosen against the MEASURED order, not an assumed one. The tree sorts by path, so these four
// walk as four, one, three, two — the first version of this test marked the last two and then asserted
// that stepping forward landed past them, which it cannot, because there is nothing past them.
const SKIP_FILES = [
  { path: "src/one.ts", before: lines(20), after: lines(20).replace("line 3\n", "line 3 EDITED\n") },
  { path: "src/two.ts", before: lines(20), after: lines(20).replace("line 4\n", "line 4 EDITED\n") },
  { path: "src/three.ts", before: lines(20), after: lines(20).replace("line 5\n", "line 5 EDITED\n") },
  { path: "src/four.ts", before: lines(20), after: lines(20).replace("line 6\n", "line 6 EDITED\n") },
];
const markViewed = (v, paths) => v.window.eval(`(function(){
  [].slice.call(document.querySelectorAll('.change-row[data-file]')).forEach(function (r) {
    if (${JSON.stringify(paths)}.indexOf(r.getAttribute('data-file')) < 0) return;
    var box = r.querySelector('.viewed-box');
    if (box) box.click();
  });
})()`);
const walkFrom = (v, path, delta) => JSON.parse(v.window.eval(`(function(){
  var from = diffNavTargets().filter(function (x) { return x.path === ${JSON.stringify(path)}; })[0];
  return JSON.stringify(nextUnviewedTarget(from.hunk, from.path, ${delta}));
})()`));

// The premise the whole complaint rests on, asserted rather than assumed: the order F7 walks IS the order
// the sidebar lists. If these ever diverge, every finding about "skipping" means something else.
test("the walk order is the sidebar order", async () => {
  const { html: many } = await makeReviewHtml(SKIP_FILES);
  const v = await loadViewer(many);
  try {
    const walk = JSON.parse(v.window.eval(`JSON.stringify(diffNavTargets().map(function(x){return x.path;}))`));
    const rows = JSON.parse(v.window.eval(
      `JSON.stringify([].slice.call(document.querySelectorAll('.change-row[data-file]')).map(function(r){return r.getAttribute('data-file');}))`));
    assert.deepEqual(walk, rows, "F7 visits files in the order the sidebar shows them");
  } finally {
    v.close();
  }
});

test("the walk reports how many viewed files it crossed", async () => {
  const { html: many } = await makeReviewHtml(SKIP_FILES);
  const v = await loadViewer(many);
  try {
    markViewed(v, ["src/one.ts", "src/three.ts"]); // the two in the MIDDLE of four, one, three, two
    const walked = walkFrom(v, "src/four.ts", 1);
    assert.equal(walked.path, "src/two.ts", "the walk landed past both viewed files");
    assert.equal(walked.skipped, 2, "and it counted them");
  } finally {
    v.close();
  }
});

test("crossing nothing reports nothing", async () => {
  // The other half: without this, a fix that always announced would read as correct above.
  const { html: many } = await makeReviewHtml(SKIP_FILES);
  const v = await loadViewer(many);
  try {
    const walked = walkFrom(v, "src/four.ts", 1);
    assert.equal(walked.path, "src/one.ts", "an ordinary step went to the very next file");
    assert.equal(walked.skipped, 0, "and crossed nothing");
  } finally {
    v.close();
  }
});

test("it counts files, not change blocks", async () => {
  // A viewed file with several change blocks is ONE thing skipped. Counting targets would say two for a
  // file the reader sees as one row, and the sentence is about sidebar rows.
  const { html: multi } = await makeReviewHtml([
    { path: "src/aaa.ts", before: lines(30), after: lines(30).replace("line 2\n", "line 2 EDITED\n") },
    { path: "src/mmm-busy.ts", before: lines(30), after: twoBlocks },
    { path: "src/zzz.ts", before: lines(30), after: lines(30).replace("line 7\n", "line 7 EDITED\n") },
  ]);
  const v = await loadViewer(multi);
  try {
    // The invariant the count rests on: one entry per file, however many change blocks that file holds.
    // Stepping BETWEEN blocks happens earlier, inside next(); this list is the file queue. If it ever
    // becomes one entry per block, `skipped` starts counting blocks and the sentence stops being true.
    const entries = JSON.parse(v.window.eval(
      `JSON.stringify(diffNavTargets().filter(function(x){return x.path==='src/mmm-busy.ts';}).length)`));
    assert.equal(entries, 1, "the busy file is one entry in the walk, not one per change block");
    markViewed(v, ["src/mmm-busy.ts"]);
    const walked = walkFrom(v, "src/aaa.ts", 1);
    assert.equal(walked.path, "src/zzz.ts", "the busy viewed file was crossed");
    assert.equal(walked.skipped, 1, "one FILE, however many change blocks it holds");
  } finally {
    v.close();
  }
});
