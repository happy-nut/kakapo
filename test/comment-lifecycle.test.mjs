// CORE USER FLOW: comment state survives the iterative review loop (#4 "반복 리뷰에서 상태가 소실된다").
//
// The reviewer leaves change requests, sends the merged prompt, the agent edits, and kakapo is re-run on the
// new diff. Comments persist (localStorage) and re-anchor by their snapshot line. Beyond that, a comment whose
// anchored line changed in the new content is flagged "possibly addressed" — so the reviewer can see which of
// their requests the round closed — and is held out of the next merged prompt until reopened. This test seeds
// prior-round comments and drives a rebuild (remapComments) to assert that lifecycle.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

const FILE = "src/app.ts";
// The working tree AFTER the agent's next round: line 2 was fixed, line 3 is untouched.
const AFTER_V2 = ["const a = 1;", "const fixed = 1;", "const c = 3;", "const e = 5;", ""].join("\n");
const COMMENTS_KEY = "kakapo-comments:/review.html";

// Two change requests from the PREVIOUS round, restored from disk. c1's anchor line was edited by the agent
// (its snapshot "const broken = ;" is gone); c2's anchor line is unchanged.
const seededComments = [
  { seq: 1, kind: "c", path: FILE, line: 2, code: "const broken = ;", text: "fix the broken assignment",
    from: 2, to: 2, side: null, anchorCode: "const broken = ;", anchorPresent: true, addressed: false },
  { seq: 2, kind: "c", path: FILE, line: 3, code: "const c = 3;", text: "rename c to something clearer",
    from: 3, to: 3, side: null, anchorCode: "const c = 3;", anchorPresent: true, addressed: false },
];

async function loadNextRound() {
  const { html } = await makeReviewHtml([{ path: FILE, before: "const a = 1;\n", after: AFTER_V2 }]);
  const v = await loadViewer(html, { seedStorage: { [COMMENTS_KEY]: JSON.stringify(seededComments) } });
  await v.openSourceFile(FILE);
  v.window.remapComments(); // the rebuild pass that runs after a watch refresh / next-round build
  await v.settle(40);
  return v;
}

test("iterative review: a comment whose line the agent changed is flagged 'possibly addressed', an untouched one stays open", async () => {
  const v = await loadNextRound();
  const stored = v.storedComments();
  const c1 = stored.find((c) => c.seq === 1);
  const c2 = stored.find((c) => c.seq === 2);
  assert.equal(c1.addressed, true, "the request whose line was edited is marked possibly addressed");
  assert.equal(c2.addressed, false, "the request on an unchanged line stays open");

  const body = v.$("#source-body");
  assert.ok(body.querySelector(".mc-card.mc-addressed"), "the addressed comment renders struck-through with its tag");
  const openCards = Array.from(body.querySelectorAll(".mc-card")).filter((c) => !c.classList.contains("mc-addressed") && !c.classList.contains("mc-composer"));
  assert.ok(openCards.length >= 1, "the still-open comment renders normally");
  v.close();
});

test("iterative review: addressed comments drop out of the merged prompt, and reopening brings them back", async () => {
  const v = await loadNextRound();
  let merged = v.window.buildMergedText();
  assert.ok(!merged.includes("fix the broken assignment"), "the addressed request is held out of the next merged prompt");
  assert.ok(merged.includes("rename c to something clearer"), "the open request is still carried into the prompt");

  v.window.reopenComment(1);
  await v.settle(20);
  assert.equal(v.storedComments().find((c) => c.seq === 1).addressed, false, "reopening clears the addressed flag");
  merged = v.window.buildMergedText();
  assert.ok(merged.includes("fix the broken assignment"), "a reopened request returns to the merged prompt");
  v.close();
});

// The agent's usual order is: read the comment, CHANGE the code, then answer. The change moves the comment —
// remapComments follows its anchor text to the new line — but an answer carries no anchor text of its own, so
// it stayed on the line the question used to be on. The thread came apart: a lone answer card sitting at a
// line it has nothing to do with, and a question somewhere else with nothing under it.
test("an answer follows the question it answers when the agent's own edit moves it", async () => {
  const moved = ["const inserted = 0;", "const alsoInserted = 1;", "const a = 1;", "const c = 3;", ""].join("\n");
  const thread = [
    { seq: 1, kind: "c", path: FILE, line: 2, code: "const c = 3;", text: "rename c to something clearer",
      from: 2, to: 2, side: null, anchorCode: "const c = 3;", anchorPresent: true, addressed: false },
    // A reply carries no anchor of its own — it lives wherever its parent lives (openReplyComposer copies it,
    // commentToRecord omits path/line whenever they still match).
    { seq: 2, kind: "c", by: "agent", replyTo: 1, path: FILE, line: 2, code: "", anchorCode: "",
      from: 2, to: 2, side: null, text: "renamed.", anchorPresent: false, addressed: false },
  ];
  const { html } = await makeReviewHtml([{ path: FILE, before: "const a = 1;\n", after: moved }]);
  const v = await loadViewer(html, { seedStorage: { [COMMENTS_KEY]: JSON.stringify(thread) } });
  await v.openSourceFile(FILE);
  v.window.remapComments();
  await v.settle(40);

  const [question, answer] = v.storedComments().sort((a, b) => a.seq - b.seq);
  assert.equal(question.line, 4, "the question followed its anchor two lines down");
  assert.equal(answer.line, question.line, "and the answer went with it instead of staying on line 2");
  assert.equal(v.window.commentsAt(FILE, question.line).length, 2, "so both turns still render as one thread");
  v.close();
});

// The same loop, read in the DIFF and never opened in the source view — which is how the product is meant
// to be used, and where it quietly stopped working. A file seen only in the diff sits in sourceByPath with
// `content: ''`, and both the anchor check and the remap bailed on exactly that: the card stayed on line 3
// while the code it was about moved to line 6, and the hand-off text went on saying `@file#L3` — pointing
// the agent at a line nobody meant. Opening the file once in the source view fixed it, which is why it went
// unnoticed.
//
// Two conclusions, two standards of evidence. The diff's rendered rows can establish that an anchor is
// HERE, so a comment follows its code; they can never establish that one is GONE, because a diff prints
// hunks and not files — a line outside a hunk is not a line that was deleted. Marking such a comment
// "possibly addressed" would be a wrong answer about the reviewer's own words, so it is held back until
// the whole file is in hand.
const SHIFTED = ["// x", "// y", "// z", "const a = 1;", "const b = 2;", "keep = 1;", ""].join("\n");

async function loadDiffOnlyRound(comments) {
  const { html } = await makeReviewHtml([
    { path: FILE, before: ["const a = 1;", "const b = 2;", "keep = 1;", ""].join("\n"), after: SHIFTED },
  ]);
  const v = await loadViewer(html, { seedStorage: { [COMMENTS_KEY]: JSON.stringify(comments) } });
  await v.openDiffFor(FILE); // the diff, and only the diff — the source view is never opened
  // The state under test is: diff rows rendered, source body empty. In the real app that is produced by
  // lazy loading — the reviewer never opened the file, so its body was never fetched. jsdom cannot reach
  // it that way (a lazy body is materialized over IPC, and `{ lazyLoad: true }` here leaves BOTH the body
  // and the diff rows empty, which would make these tests pass by having nothing to read at all). So the
  // builder embeds as usual and the body is emptied here, leaving exactly the pair the app has.
  v.window.eval(`sourceByPath.get(${JSON.stringify(FILE)}).content = ''`);
  assert.ok(v.window.eval(`diffRowsOf(diffSideTable(diffWrapperByPath(${JSON.stringify(FILE)}), 'new')).length`) > 0,
    "the premise: the diff's rows are on screen even though the body is not loaded");
  v.window.remapComments();
  await v.settle(40);
  return v;
}

test("a comment follows its code with nothing but the diff on screen", async () => {
  const v = await loadDiffOnlyRound([
    { seq: 1, kind: "c", path: FILE, line: 3, code: "keep = 1;", text: "this one moved",
      from: 3, to: 3, side: null, anchorCode: "keep = 1;", anchorPresent: true, addressed: false },
  ]);
  try {
    const c1 = v.storedComments().find((c) => c.seq === 1);
    assert.equal(c1.line, 6, "three lines were inserted above it, so it is on line 6 now");
    assert.equal(c1.from, 6, "and its range moved with it");
    assert.equal(c1.to, 6);
    assert.ok(!c1.addressed, "its code is still there, so nothing was addressed");
  } finally {
    v.close();
  }
});

test("an anchor the diff cannot see is not reported as addressed", async () => {
  const v = await loadDiffOnlyRound([
    { seq: 2, kind: "c", path: FILE, line: 2, code: "const ghost = 0;", text: "about a line this diff does not print",
      from: 2, to: 2, side: null, anchorCode: "const ghost = 0;", anchorPresent: true, addressed: false },
  ]);
  try {
    const c2 = v.storedComments().find((c) => c.seq === 2);
    assert.ok(!c2.addressed,
      "absent from the printed hunks is not absent from the file — only the whole file can say that");
    assert.equal(c2.line, 2, "and with nothing to follow, it stays where the reviewer left it");
  } finally {
    v.close();
  }
});

// Following a comment is a claim about the FILE, and the diff only shows hunks. "The nearest line that
// still reads `}`" among the printed rows is not the nearest `}` in the file, and a comment anchored to
// something as common as a closing brace, on a line far outside any hunk, followed that text across the
// gap: line 3 to line 46, a brace belonging to another function. The moved line is written to disk and is
// what the hand-off text hands the agent — so the wrong answer leaves the app. Not moving at all, which
// is what this replaced, was better.
//
// The rule that makes a move sound: the comment's own line is printed (otherwise we cannot even see that
// it left), and there is no gap between there and the candidate (a gap is exactly where a nearer match
// would hide). Everything else waits for the whole file.
test("a comment does not follow its anchor across ground the diff never printed", async () => {
  const head = ["function head() {", "  ONE();", "}"];
  const filler = Array.from({ length: 40 }, (_, i) => `const pad${i} = ${i};`);
  const tail = (call) => ["function tail() {", `  ${call}();`, "}"];
  const body = (call) => [...head, ...filler, ...tail(call), ""].join("\n");
  // Context 2, and the only change is at line 45 — so the hunk is the tail, and line 3 is off screen.
  const { html } = await makeReviewHtml(
    [{ path: FILE, before: body("TWO"), after: body("THREE") }], { context: 2 },
  );
  const v = await loadViewer(html, {
    seedStorage: {
      [COMMENTS_KEY]: JSON.stringify([
        { seq: 3, kind: "c", path: FILE, line: 3, code: "}", text: "about the head's closing brace",
          from: 3, to: 3, side: null, anchorCode: "}", anchorPresent: true, addressed: false },
      ]),
    },
  });
  try {
    await v.openDiffFor(FILE);
    v.window.eval(`sourceByPath.get(${JSON.stringify(FILE)}).content = ''`);
    const printed = v.window.eval(`JSON.stringify(diffRowsOf(diffSideTable(diffWrapperByPath(${JSON.stringify(FILE)}), 'new')).map(diffLineNumber).filter(function (n) { return n != null; }))`);
    const lines = JSON.parse(printed);
    assert.ok(!lines.includes(3), `the premise: line 3 is not printed (printed ${lines[0]}…${lines[lines.length - 1]})`);
    assert.ok(lines.includes(46), "the premise: another `}` IS printed, at line 46");

    v.window.remapComments();
    await v.settle(40);
    const c3 = v.storedComments().find((c) => c.seq === 3);
    assert.equal(c3.line, 3, "it stays where the reviewer left it rather than jumping to a brace it never meant");
    assert.ok(!c3.addressed, "and nothing was concluded about it either");
  } finally {
    v.close();
  }
});
