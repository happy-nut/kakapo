// CORE USER FLOW: reaching and acting on review-comment boxes with the keyboard.
//
// A comment attached to a line is a selectable "stop" the caret lands on while arrowing through a file.
// Once a box is selected it can be deleted (Backspace), edited (e), or stepped off (arrow / Escape). This
// must behave identically in the diff view and the source view. Guards the regression where the diff view's
// caret handler had NO comment-box logic at all, so every diff comment — whether made by dragging a range
// or by a single-line caret — was unreachable by keyboard (and therefore un-editable via `e`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures, renderLazyBodies } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILES = [
  {
    path: "src/untouched.ts",
    before: "export const untouched = 1;\n",
    after: "export const untouched = 1;\n",
  },
  {
    path: "src/app.ts",
    before: "export function run() {\n  return 42;\n}\n",
    after: "export function run() {\n  const n = 43;\n  return n;\n}\n",
  },
];

let html, lazy;
before(async () => {
  html = (await makeReviewHtml(FILES)).html;
  const r = await makeReviewHtml(FILES, { lazyLoad: true });
  lazy = { html: r.html, bodies: await renderLazyBodies(r.build), sourceData: r.build.lazySourceData };
});
after(cleanupFixtures);

async function diffCommentOnFirstLine(v, text) {
  await v.openDiffFor("src/app.ts");
  await v.clickFirstDiffLine();
  await v.openComposer("q");
  await v.writeAndSave(text);
}

// ---------- diff view ----------
test("diff: ArrowDown lands on the comment box attached to the caret line", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  assert.deepEqual(v.visibleCardTexts(), ["q1"]);
  v.key("ArrowDown");
  await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected by ArrowDown");
  v.close();
});

test("diff: ArrowUp from the line below the comment re-selects the box", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20); // onto the box
  v.key("ArrowDown"); await v.settle(20); // step off, caret on the next code line
  assert.equal(v.selectedCommentBox(), null, "stepped off the box");
  v.key("ArrowUp"); await v.settle(20); // back up onto the box from below
  assert.ok(v.selectedCommentBox(), "box re-selected from below with ArrowUp");
  v.close();
});

test("diff: stepping off the box re-shows the caret and deselects", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "deselected after stepping off");
  assert.ok(v.diffCaretRow(), "caret is visible again on a code line");
  v.close();
});

test("diff: Escape deselects the box without deleting the comment", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("Escape"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "deselected by Escape");
  assert.equal(v.storedComments().length, 1, "comment is still there");
  v.close();
});

test("diff: Backspace deletes the selected comment", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "delete me");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("Backspace"); await v.settle(20);
  assert.equal(v.storedComments().length, 0, "Backspace deleted the selected comment");
  assert.equal(v.selectedCommentBox(), null, "selection cleared after delete");
  v.close();
});

test("diff: e opens the editor prefilled with the existing comment text", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "edit me");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("e"); await v.settle(40);
  const input = v.visibleComposerInput();
  assert.ok(input, "editor composer reopened");
  assert.equal(input.value, "edit me", "editor prefilled with existing text");
  v.close();
});

// Coming back UP onto a comment is how you reach one you have already read past. That entry used to land on
// the row's LAST card — the "Continue this thread" stub, which is an affordance, not a turn — so Backspace
// and `e` hit a card with nothing to delete or edit: the first press did nothing and the comment only went
// away on the second.
test("diff: ArrowUp onto a comment selects the comment itself, so one Backspace deletes it", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "delete me from below");
  v.key("ArrowDown"); await v.settle(20); // onto the comment
  v.key("ArrowDown"); await v.settle(20); // off the row, onto the next code line
  assert.equal(v.selectedCommentBox(), null, "stepped off the row");

  v.key("ArrowUp"); await v.settle(20);
  const selected = v.selectedCommentBox().querySelector(".mc-card-selected");
  assert.ok(selected, "entering from below selects the written turn");
  v.key("Backspace"); await v.settle(40);
  assert.equal(v.storedComments().length, 0, "one Backspace is enough");
  v.close();
});

test("diff: ArrowDown on a line with NO comment just moves the caret (no false selection)", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  await v.clickFirstDiffLine();
  const before = v.diffCaretLine();
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "no comment here -> nothing selected");
  assert.notEqual(v.diffCaretLine(), before, "caret advanced to the next line");
  v.close();
});

test("diff (lazy-LOAD): single-line comment is selectable and editable", async () => {
  const v = await loadViewer(lazy.html, { lazySourceData: lazy.sourceData, getDiffBody: (i) => lazy.bodies[i] || "" });
  await v.openDiffFor("src/app.ts");
  await v.settle(120);
  await v.clickFirstDiffLine();
  await v.openComposer("q");
  await v.writeAndSave("lazy edit");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected in lazy-LOAD mode (serve/Electron)");
  v.key("e"); await v.settle(40);
  assert.equal(v.visibleComposerInput().value, "lazy edit", "editor prefilled in lazy-LOAD mode");
  v.close();
});

// ---------- source view (must behave identically) ----------
test("source: ArrowDown selects the comment box (parity with diff)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("src q");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox(), "box selected in source view");
  v.close();
});

test("source: e opens the editor prefilled (parity with diff)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("src edit");
  v.key("ArrowDown"); await v.settle(20);
  assert.ok(v.selectedCommentBox());
  v.key("e"); await v.settle(40);
  assert.equal(v.visibleComposerInput().value, "src edit", "editor prefilled in source view");
  v.close();
});

// ---------- stepping OFF the box has to clear whatever is in the way ----------
//
// The step off a selected box used to read exactly one sibling row and, if that row was not a line it could
// address, put the caret back where it started — so ArrowDown did nothing at all, with no hint why. Two
// rows that are routinely next to a comment box hit that: a code-vision note, which is painted ABOVE the
// line it annotates and is therefore the row below every box on the line before one; and, in the diff, any
// row belonging to the other pane's reality (a placeholder, a hunk header, a fold, a comment spacer).
test("source: stepping off a box clears a code-vision row and reaches the next line", async () => {
  const v = await loadViewer(html, {
    // A lens on line 2 (lineIndex 1) puts its row between the box on line 1 and line 2 itself.
    analysisBridge: (request) => {
      const base = { ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] };
      if (request.kind === "codeLens") return { ...base, lenses: [{ lineIndex: 1, title: "2 references" }] };
      return { ...base, hints: [], lenses: [] };
    },
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(1000).toISOString() },
  });
  await v.openSourceFile("src/app.ts");
  await v.settle(200);
  assert.ok(v.$("#source-body .code-vision-row"), "a lens row is painted (otherwise this test proves nothing)");
  await v.clickSourceLine(0);
  await v.openComposer("q");
  await v.writeAndSave("above the lens");
  v.key("ArrowDown"); await v.settle(20);
  const box = v.selectedCommentBox();
  assert.ok(box, "box selected");
  // Re-read the row here: saving a comment re-renders the body, so a lens element captured before the save
  // is a detached node and comparing against it would pass this test for the wrong reason.
  const below = box.nextElementSibling;
  assert.ok(below && below.classList.contains("code-vision-row"),
    `the lens row really is what the step has to walk past (got ${below && below.className})`);
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "stepped off the box");
  assert.equal(v.caretLine(), 2, "caret reached line 2 instead of falling back to line 1");
  v.close();
});

// A comment on a DELETED line lives in the left pane. The step resolved every sibling against the right
// pane's row list, where no left-pane row has an index, so it answered "cannot address that" for the next
// code line as readily as for a placeholder: the commonest review comment there is could not be left with
// an arrow key at all.
test("diff: stepping off a box on a deleted line moves down that same pane", async () => {
  const { html: deletion } = await makeReviewHtml([
    { path: "src/keep.ts", before: "export const keep = 1;\n", after: "export const keep = 1;\n" },
    { path: "src/gone.ts", before: "const a = 1;\nconst gone = 2;\nconst b = 3;\n", after: "const a = 1;\nconst b = 3;\n" },
  ]);
  const v = await loadViewer(deletion);
  await v.openDiffFor("src/gone.ts");
  const left = v.$all("#diff2html-container .d2h-file-wrapper:not(.df-inactive) .d2h-file-side-diff")[0];
  const deleted = Array.from(left.querySelectorAll("tr")).find(
    (r) => (r.querySelector(".d2h-code-side-linenumber")?.textContent || "").trim() === "2",
  );
  assert.ok(deleted, "the deleted line has a row in the left pane");
  v.click(deleted.querySelector(".d2h-code-line, .d2h-code-side-line") || deleted);
  await v.settle(30);
  assert.equal(v.diffCaretLine(), 2, "caret is on the deleted line");
  await v.openComposer("q");
  await v.writeAndSave("why was this removed?");
  v.key("ArrowDown"); await v.settle(20);
  const box = v.selectedCommentBox();
  assert.ok(box, "box selected on the old side");
  assert.ok(left.contains(box), "the box is in the left pane, which is the point of this test");
  v.key("ArrowDown"); await v.settle(20);
  assert.equal(v.selectedCommentBox(), null, "stepped off the box");
  assert.equal(v.diffCaretLine(), 3, "caret moved to the next line of the pane it was already in");
  v.close();
});

// F8 / Shift+F8 step between review comments the way F7 steps between changes — changes on one key, comments
// on the next one over. Cmd+F7 does the same and stays for muscle memory.
test("F8 and Shift+F8 walk the comments, mirroring F7 for changes", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("first comment");
  await v.settle(60);
  await v.clickSourceLine(2);
  await v.openComposer("q");
  await v.writeAndSave("second comment");
  await v.settle(60);
  assert.equal(v.storedComments().length, 2, "two comments to walk between");

  // caretLine, not the source row: a comment on a changed line is shown in the diff now, whichever view the
  // walk started in (revealComment), so reading only the source view reads the view and not the step.
  const cursorLine = () => v.caretLine();
  const [a, b] = v.storedComments().map((c) => c.line).sort((x, y) => x - y);

  v.key("F8");
  await v.settle(80);
  const first = cursorLine();
  assert.ok(first === a || first === b, `F8 landed on a commented line (got ${first})`);

  v.key("F8");
  await v.settle(80);
  assert.notEqual(cursorLine(), first, "a second F8 steps to the other comment");

  v.key("F8", { shiftKey: true });
  await v.settle(80);
  assert.equal(cursorLine(), first, "Shift+F8 steps back");
  v.close();
});

// The diff shows one file at a time, everything else display:none. Stepping to a comment in ANOTHER file
// placed the caret inside that hidden wrapper: the chrome updated — the base-version label named the target —
// while the reader kept looking at the previous file and nothing appeared to happen.
test("F8 to a comment in another file switches the diff to that file", async () => {
  const { html: twoFiles } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]);
  const v = await loadViewer(twoFiles);
  const shownFile = () => {
    const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
    return wrapper ? (wrapper.querySelector(".d2h-file-name")?.textContent || "").trim() : null;
  };
  // clickFirstDiffLine() always takes the first wrapper in the DOM; this comment has to land in the file the
  // jump comes FROM being a different one, so click inside the file that is actually on screen.
  await v.openDiffFor("src/b.ts");
  assert.equal(shownFile(), "src/b.ts");
  const shown = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const numbered = Array.from(shown.querySelectorAll(".d2h-file-side-diff")).pop()
    .querySelectorAll(".d2h-code-side-linenumber");
  const cell = Array.from(numbered).find((n) => (n.textContent || "").trim() !== "").closest("tr");
  v.click(cell.querySelector(".d2h-code-line, .d2h-code-side-line"));
  await v.settle(30);
  await v.openComposer("q");
  await v.writeAndSave("why b?");
  await v.settle(60);
  assert.equal(v.storedComments()[0]?.path, "src/b.ts", "the comment is in the file we will jump back to");

  await v.openDiffFor("src/a.ts");
  await v.settle(60);
  assert.equal(shownFile(), "src/a.ts", "another file is what's on screen before the jump");

  v.key("F8");
  await v.settle(120);
  assert.equal(shownFile(), "src/b.ts", "F8 reveals the commented file, not just its name in the chrome");
  v.close();
});

// An agent's explanation and a reviewer's question are the same thing to someone walking a file: a note on
// a line. They used to be two keys — F8 for comments, a second one for notes — so F8 silently skipped every
// explanation the agent had left. One list now, sorted together, a note ahead of a comment on a line they
// share (the order the thread itself renders them in), and one key that walks all of it.
test("the comment navigation list contains both kinds", () => {
  const comments = readFileSync(new URL("../src/viewer/07-comments.js", import.meta.url), "utf8");
  assert.match(comments, /function sortedNavThread\(\)\s*\{\s*\n\s*return sortedNavComments\(\);/,
    "notes and comments are one list, so the walk is just that list in file order");
  const revealBody = comments.slice(
    comments.indexOf("\nfunction revealComment(seq) {"),
    comments.indexOf("\n}\n", comments.indexOf("\nfunction revealComment(seq) {")),
  );
  assert.ok(revealBody.includes("navigateToCommentInDiff(target.seq)"),
    "and every card on it is reached by its own id — the same tail a notification click uses");
});

// F8 stepped to the first note and then stopped dead. commentNavOrder ranks only files the DIFF contains —
// fine while every comment was anchored to a change, but an agent's codebase map anchors notes in files that
// are not part of the diff at all. Those all collapsed to rank Infinity, the current file came back unranked,
// and stepAnchor answered every press with list[0]. Every anchor needs a place in the order.
test("stepping keeps working through notes in files the diff does not contain", () => {
  const comments = readFileSync(new URL("../src/viewer/07-comments.js", import.meta.url), "utf8");
  assert.match(comments, /function navOrderFor\(list\)/, "the order is built from the list, not only from the diff");
  assert.match(comments, /extra\.sort\(\)\.forEach\(function \(path\) \{ order\[path\] = next\+\+; \}\)/,
    "files outside the diff get ranks of their own, in a stable order");
  assert.match(comments, /function stepAnchor\(delta, list\) \{\s*\n\s*var order = navOrderFor\(list\);/,
    "and stepping uses it, so the current file is rankable too");
});

// One comment per thread. The "Continue this thread" box that used to sit under the last card is gone, so a
// thread holds exactly one turn of the reviewer's — and asking for a comment on a line that already has one
// re-opens THAT comment rather than starting a second beside it.
test("diff: a thread holds one comment; asking again edits it instead of adding another", async () => {
  const v = await loadViewer(html);
  await diffCommentOnFirstLine(v, "q1");
  assert.equal(v.storedComments().length, 1);

  // The caret is still on the commented line: ask again there.
  await v.openComposer("q");
  const box = v.visibleComposerInput();
  assert.ok(box, "the composer opened");
  assert.equal(box.value, "q1", "on the comment that is already there, not on an empty second one");
  await v.writeAndSave("q1 revised");
  assert.equal(v.storedComments().length, 1, "still one comment on this thread");
  assert.equal(v.storedComments()[0].text, "q1 revised", "the existing one was edited");

  v.key("ArrowDown"); await v.settle(20); // the comment
  v.key("ArrowDown"); await v.settle(20); // straight off the row: there is nothing else in the thread
  assert.equal(v.selectedCommentBox(), null, "the thread has one card and the arrows step past it");
  v.close();
});

// F8 went to the next note and then came BACK. Centring a thread row retries for a few frames, because the
// row can be built late (a long file, lazily rendered rows) — but the retry did not check that it was still
// the target anyone wanted. So a row that finally arrived two presses later dragged the view back to a note
// the reader had already left. jsdom has no scrollIntoView and no layout, so this is pinned at the source.
test("a thread-centring retry gives up as soon as a newer one is asked for", () => {
  const source = readFileSync(new URL("../src/viewer/07-comments.js", import.meta.url), "utf8");
  const fn = source.match(/function centerThreadRow\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "centerThreadRow is still a function");
  assert.match(fn, /var mine = token === undefined \? \+\+centerThreadTarget : token;/,
    "each fresh call claims the scroll; a retry carries the claim it was born with");
  assert.match(fn, /if \(mine !== centerThreadTarget\) return;/,
    "and a claim that has been superseded scrolls nothing");
  assert.match(fn, /centerThreadRow\(path, line, side, \(tries \|\| 0\) \+ 1, mine\)/,
    "the retry passes its own claim on, rather than minting a new one");
});

// "F8 moved to the file but the comment is nowhere." Going to a comment opened the file and placed the caret
// one frame later — but on a lazy review that frame is spent fetching, so setSourceCursor found no content,
// returned without doing anything, and the body then finished painting at the TOP of the file. The card was
// in the DOM the whole time, four hundred lines below the fold, with nothing ever coming back for it. Here
// the note sits at line 50 of a file whose content arrives on a delay, exactly as an IPC read does.
test("going to a comment waits for a lazily fetched file instead of placing the caret a frame early", async () => {
  const line = (n, head) => [`const head = ${head};`, ...Array.from({ length: n - 1 }, (_, i) => `const v${i + 2} = ${i + 2};`)].join("\n") + "\n";
  const files = [
    { path: "src/app.ts", before: "const a = 1;\n", after: "const a = 9;\n" },
    // Changed at line 1 only, so with the fixture's 12 lines of context no hunk reaches line 50: the walk
    // has to fall out of the diff and into the source view, which is where the race lives.
    { path: "src/far.ts", before: line(60, 1), after: line(60, 9) },
  ];
  const build = await makeReviewHtml(files, { lazyLoad: true, app: true });
  const bodies = await renderLazyBodies(build.build);
  const records = JSON.parse(build.build.lazySourceData || "[]");
  const v = await loadViewer(build.html, {
    lazySourceData: build.build.lazySourceData,
    getDiffBody: (i) => bodies[i] || "",
    sourceBridge: (path) => new Promise((resolve) => setTimeout(() => resolve({
      ...(records.find((r) => r.path === path) || { path }),
      content: readFileSync(new URL("file://" + build.dir + "/" + path), "utf8"),
      embedded: true,
      deferred: false,
    }), 60)),
  });
  await v.openSourceFile("src/app.ts"); // the reader is already browsing, so the index is here

  const seq = v.agentSays({ kind: "note", path: "src/far.ts", line: 50, group: 1, text: "far down a file that is still being fetched" });
  await v.settle(40);
  v.window.revealComment(seq);
  await v.settle(400);

  assert.equal(v.$("#source-viewer")?.dataset.openPath, "src/far.ts", "the file opened");
  assert.equal(v.$all("#source-body .source-row").length, 61, "and finished painting");
  assert.equal(v.caretLine(), 50, "the caret is on the commented line, not at the top of the file");
  assert.equal(v.$all(".mc-card.mc-ai").length, 1, "with the card on it");
  v.close();
});

// Two notes on ONE line. Notes accumulate in the repository's shared knowledge file, so a second explanation
// of the same code puts a second note on the same anchor — and the walk could not tell them apart, because a
// caret is a line and a line does not name a card. It always resolved to the first one, so stepping off the
// second computed its way back to the first and handed the second straight back: F8 pressed forever without
// moving, with the other note unreachable.
test("F8 steps between two notes that share one line, and still treats a thread as one stop", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\n", after: "const a = 9;\nconst b = 8;\nconst c = 7;\n" },
  ]);
  const v = await loadViewer(html);

  const first = v.agentSays({ kind: "note", group: 1, path: "src/app.ts", line: 1, title: "one", text: "first" });
  const second = v.agentSays({ kind: "note", group: 2, path: "src/app.ts", line: 1, title: "two", text: "second" });
  await v.settle(60);

  const seqOf = () => v.window.sortedNavThread().find((c) => c.seq === v.window.lastRevealedSeq)?.seq;
  v.window.revealComment(first);
  await v.settle(40);
  assert.equal(seqOf(), first, "the walk starts on the first of them");

  v.window.gotoComment(1);
  await v.settle(40);
  assert.equal(seqOf(), second, "F8 reaches the note behind it instead of standing still");

  v.window.gotoComment(1);
  await v.settle(40);
  assert.equal(seqOf(), first, "and comes back — two notes on one line are two stops");

  // A question and the answer to it DO share an anchor, and they are one conversation, so they stay one stop.
  v.window.addComment("q", "src/app.ts", 2, "const b = 8;", "why?");
  await v.settle(40);
  const question = v.storedComments().find((c) => c.text === "why?").seq;
  v.agentSays({ re: question, text: "because." });
  await v.settle(60);

  v.window.revealComment(question);
  await v.settle(40);
  v.window.gotoComment(1);
  await v.settle(40);
  assert.notEqual(seqOf(), question, "stepping off the question moves");
  assert.ok([first, second].includes(seqOf()), "…past its own answer, not onto it");
  v.close();
});

// Where you were is part of where the comment is. Going back used to prefer the diff whenever the diff could
// show the line at all, so a comment written while reading the whole file came back as two narrow hunk panes —
// the context it was made in taken away by the act of returning to it.
test("a comment comes back in the view it was written in, and survives the thread-file round trip", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\n", after: "const a = 9;\nconst b = 8;\n" },
  ]);
  const v = await loadViewer(html);
  const w = v.window;

  // Written while reading the FILE — on a changed line, so the diff could perfectly well show it.
  await v.openSourceFile("src/app.ts");
  assert.equal(w.isSourceViewerVisible(), true, "in the file view to start with");
  w.addComment("q", "src/app.ts", 1, "const a = 9;", "read the whole file to ask this");
  await v.settle(40);
  const fromFile = v.storedComments().find((c) => c.text === "read the whole file to ask this").seq;
  assert.equal(v.storedComments().find((c) => c.seq === fromFile).view, "source", "the view is recorded with the line");

  // Written in the DIFF, on the other changed line.
  w.showDiffView(false);
  await v.settle(40);
  assert.equal(w.isDiffViewVisible(), true);
  w.addComment("q", "src/app.ts", 2, "const b = 8;", "asked beside the change");
  await v.settle(40);
  const fromDiff = v.storedComments().find((c) => c.text === "asked beside the change").seq;
  assert.equal(v.storedComments().find((c) => c.seq === fromDiff).view, "diff");

  // From the diff, the file-view comment goes back to the file view — even though the diff has its line.
  w.revealComment(fromFile);
  await v.settle(80);
  assert.equal(w.isSourceViewerVisible(), true, "back to the file it was read in, not to the hunks");

  // …and the other one goes the other way, from wherever you are.
  w.revealComment(fromDiff);
  await v.settle(80);
  assert.equal(w.isDiffViewVisible(), true, "and a comment made beside the change comes back beside it");

  // Every save re-serialises the whole thread, so a field not written back is a field the next comment deletes.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, text: "an unrelated note, forcing a rewrite" });
  await v.settle(60);
  assert.equal(v.storedComments().find((c) => c.seq === fromFile).view, "source", "the view survives the round trip");
  assert.equal(v.storedComments().find((c) => c.seq === fromDiff).view, "diff");
  v.close();
});

// A comment can name a file this review does not have. An agent writes a note about a path that was never
// in the diff; a reply arrives orphaned and carries no path at all. `revealComment` reported success for
// those because it had found the RECORD, so F8 chose one, nothing opened, the caret did not move — and the
// next press, which works out where it is FROM the caret, chose the same one again. One such note made
// every real comment in the review unreachable from the keyboard, in both directions, with the same
// sentence on screen each time and no surface saying which record was eating the key.
test("stepping walks past a comment whose file this review does not have", async () => {
  const v = await loadViewer(html);
  try {
    await diffCommentOnFirstLine(v, "a real one");
    const real = v.window.reviewComments[0];
    assert.ok(real, "the premise: there is one reachable comment");

    // The shape an agent writes into comments.jsonl, naming a file nobody has.
    v.window.reviewComments.push({
      seq: 99, kind: "note", by: "agent", path: "src/does-not-exist.ts", line: 3,
      from: 3, to: 3, side: null, code: "", anchorCode: "", text: "about a file that is not here",
    });
    v.window.refreshComments();
    await v.settle(30);
    assert.equal(v.window.commentIsReachable({ path: "src/does-not-exist.ts" }), false, "and it is not reachable");
    assert.equal(v.window.commentIsReachable(real), true, "while the real one is");

    // Six presses in each direction: the walk must keep landing on the reachable comment rather than
    // stopping on the one it cannot open.
    for (const delta of [1, 1, 1, -1, -1, -1]) {
      v.window.gotoComment(delta);
      await v.settle(20);
      assert.equal(v.window.lastRevealedSeq, real.seq,
        `after stepping ${delta > 0 ? "forward" : "back"} the walk is on the comment it can show`);
    }
  } finally {
    v.close();
  }
});

// `sourceByPath` is not the review's file list on the desktop. A lazy review seeds the page with the
// CHANGED files and fetches the rest only when the Files tab is first opened — which is not where F8 is
// pressed, because a lazy review opens on the diff. Asked before that fetch, "does the review have this
// file" answered no for every unchanged one, so the walk dropped the reviewer's own comments and told
// them the review has none of their files. An apparent miss is a reason to FETCH and ask again, which is
// what openPathReference does a few lines away for the same reason.
test("stepping reaches a comment on a file the lazy review has not fetched yet", async () => {
  const UNCHANGED = "src/untouched.ts";
  const v = await loadViewer(lazy.html, {
    lazySourceData: lazy.sourceData,
    getDiffBody: (index) => lazy.bodies[index] || "",
    // The index holds the whole project; the page starts with only what changed.
    projectIndexBridge: () => ({
      sourceFilesMeta: [
        { path: "src/app.ts", name: "app.ts", content: "", embedded: true },
        { path: UNCHANGED, name: "untouched.ts", content: "", embedded: true },
      ],
      filesTree: "",
    }),
  });
  try {
    assert.equal(v.window.eval(`sourceByPath.has(${JSON.stringify(UNCHANGED)})`), false,
      "the premise: the page has not been told about the unchanged file yet");

    v.window.reviewComments.push({
      seq: 77, kind: "c", by: "me", path: UNCHANGED, line: 1, from: 1, to: 1, side: null,
      code: "", anchorCode: "", text: "about a file this review did not change",
    });
    v.window.refreshComments();
    await v.settle(20);

    // Two presses inside one round trip. stepAnchor reads the LIVE caret, so both would run afterwards
    // from the same position and land on the same comment — the second press looking like it did nothing
    // while actually having been spent. One fetch, one step; the index is loaded by the time the reader
    // can press again, and every press after that is immediate.
    // Count the LANDINGS, not the requests: ensureProjectIndex memoizes its promise, so the request count
    // is 1 either way and an assertion on it watches nothing. What the guard decides is how many steps
    // run when the fetch resolves.
    v.window.eval(`window.__reveals = 0; var __reveal = revealComment;
      revealComment = function (seq) { window.__reveals += 1; return __reveal(seq); };`);
    v.window.gotoComment(1);
    v.window.gotoComment(1);
    await v.settle(80); // the index fetch is a round trip
    assert.equal(v.window.lastRevealedSeq, 77,
      "the walk fetched the index and found the file, rather than declaring it absent");
    assert.equal(v.window.__reveals, 1,
      "one fetch, one step — stepAnchor reads the live caret, so two deferred steps land on the same place");
  } finally {
    v.close();
  }
});

// And when something IS reachable, the press does not wait for that fetch. The index walk is the whole
// repository — the work a diff-first launch exists to defer — and one comment on an unchanged file is
// enough to look like a miss, so holding the key press for it put a repo walk in front of a caret move
// that had somewhere to go all along. Land now, fetch for the presses after.
test("a press that has somewhere to go does not wait for the index", async () => {
  const v = await loadViewer(lazy.html, {
    lazySourceData: lazy.sourceData,
    getDiffBody: (index) => lazy.bodies[index] || "",
    projectIndexBridge: () => ({ sourceFilesMeta: [], filesTree: "" }),
  });
  try {
    await v.openDiffFor("src/app.ts");
    await v.clickFirstDiffLine();
    await v.openComposer("q");
    await v.writeAndSave("reachable, on a file the diff has");
    const real = v.window.reviewComments[0];
    assert.ok(real, "the premise: one comment sits on a changed file");

    // …beside one that looks unreachable until the index arrives.
    v.window.reviewComments.push({
      seq: 88, kind: "c", by: "me", path: "src/untouched.ts", line: 1, from: 1, to: 1, side: null,
      code: "", anchorCode: "", text: "on a file the page has not been told about",
    });
    v.window.refreshComments();
    await v.settle(20);

    v.window.lastRevealedSeq = 0;
    v.window.gotoComment(1);
    // No settle: the point is that the caret moved on the press, not after a round trip.
    assert.equal(v.window.lastRevealedSeq, real.seq, "it landed without waiting for the index");
    // The press started a fetch for the NEXT one; let it land before the window goes, or its continuation
    // runs against a torn-down document and the suite reports an unhandled rejection from a passing test.
    await v.settle(80);
  } finally {
    v.close();
  }
});

// F8 and Shift-F8 are one deferral and two intents.
//
// A press that cannot land waits for the project index, and the latch that holds it answers every press
// during the wait with the same sentence rather than swallowing it — right, because stepAnchor reads the
// live caret and two deferred steps would land on one comment. But the latch kept the FIRST press's
// direction, which makes it right for a repeat and wrong for a reversal: press F8, wait out a 1.6 s repo
// walk, change your mind, press Shift-F8, and the jump that finally arrives goes forwards. The press being
// waited for is "go to a comment"; its direction is whatever was asked last.
//
// Its own fixture, with TWO unchanged files, because the direction only shows up with two places to go.
// They have to be files the REVIEW has and the lazy page has not fetched yet — a comment on a file outside
// the review is something main filters out before the renderer sees it (notesForWorkspace), and reaching
// for one here hangs the page rather than failing it, which is a worse test than no test.
const PAIR_FILES = [
  { path: "src/pair-a.ts", before: "export const a = 1;\n", after: "export const a = 1;\n" },
  { path: "src/pair-b.ts", before: "export const b = 2;\n", after: "export const b = 2;\n" },
  {
    path: "src/pair-changed.ts",
    before: "export function run() {\n  return 1;\n}\n",
    after: "export function run() {\n  return 2;\n}\n",
  },
];
let pair;
before(async () => {
  const r = await makeReviewHtml(PAIR_FILES, { lazyLoad: true });
  pair = { html: r.html, bodies: await renderLazyBodies(r.build), sourceData: r.build.lazySourceData };
});

// Where a sequence of presses lands when every one of them has to wait for the index. Returns the seq, so
// two sequences can be compared — asserting on one alone would pass if the direction were ignored and the
// forward step happened to land in the same place.
async function deferredLanding(deltas) {
  const v = await loadViewer(pair.html, {
    lazySourceData: pair.sourceData,
    getDiffBody: (index) => pair.bodies[index] || "",
    // The index holds the whole project; the lazy page starts with only what changed.
    projectIndexBridge: () => ({
      sourceFilesMeta: PAIR_FILES.map((f) => ({
        path: f.path, name: f.path.split("/").pop(), content: "", embedded: true,
      })),
      filesTree: "",
    }),
  });
  try {
    for (const [seq, path] of [[81, "src/pair-a.ts"], [82, "src/pair-b.ts"]]) {
      v.window.reviewComments.push({
        seq, kind: "c", by: "me", path, line: 1, from: 1, to: 1, side: null,
        code: "", anchorCode: "", text: `on ${path}`,
      });
    }
    v.window.refreshComments();
    await v.settle(20);
    assert.equal(v.window.eval(`sourceByPath.has("src/pair-a.ts")`), false,
      "the premise: neither file has been fetched, so every press defers");
    for (const delta of deltas) v.window.gotoComment(delta);
    await v.settle(120); // the index fetch is a round trip
    return v.window.lastRevealedSeq;
  } finally {
    v.close();
  }
}

test("changing direction during the index wait changes where the press lands", async () => {
  const reversed = await deferredLanding([1, -1]);
  const repeated = await deferredLanding([1, 1]);
  assert.ok(reversed, "the reversal landed somewhere");
  assert.ok(repeated, "so did the repeat");
  assert.notEqual(reversed, repeated,
    "the waiting press took the direction asked last, not the one asked first");
});
