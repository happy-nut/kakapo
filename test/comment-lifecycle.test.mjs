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
