// CORE USER FLOW: leaving review comments.
//
// A reviewer opens a changed file, selects a line, writes a question or change-request, and saves it.
// The comment must persist, show up as a card, survive reopening the app, and roll up into the merged
// prompt that gets handed back to the coding agent. This file guards that end to end — including the
// regression where clicking "Comment" in the source/markdown view saved nothing because the handler
// read the hidden diff-view textarea instead of the one on screen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

// One fixture, reused across tests. Each test loads its own viewer instance (fresh localStorage), so
// they stay isolated; only the immutable HTML string is shared.
let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    {
      path: "AGENTS.md",
      before: "# AGENTS\n\nGuidance for agents.\n\n## Project\n\nkakapo is a CLI.\n",
      after: "# AGENTS\n\nGuidance for agents.\n\n## Project\n\nkakapo is a small CLI.\n",
    },
    {
      path: "src/app.ts",
      before: "export function run() {\n  return 42;\n}\n",
      after: "export function run() {\n  return 43;\n}\n",
    },
    {
      path: "docs/runtime-arrow-wfa-plan.md.ts",
      before: Array.from({ length: 10 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n") + "\n",
      after: Array.from({ length: 10 }, (_, index) => `export const line${index + 1} = ${index === 9 ? 100 : index + 1};`).join("\n") + "\n",
    },
  ]));
});
after(cleanupFixtures);

test("source/markdown view: clicking Save persists the comment the user typed", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  assert.equal(v.visibleView(), "source");

  await v.clickSourceLine(4); // "## Project" block -> line 5
  await v.openComposer("q");
  await v.writeAndSave("why a CLI and not a library?");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.deepEqual(
    { kind: stored[0].kind, line: stored[0].line, text: stored[0].text },
    { kind: "q", line: 5, text: "why a CLI and not a library?" },
  );
  assert.deepEqual(v.visibleCardTexts(), ["why a CLI and not a library?"]);
  v.close();
});

test("plain source (code) view: clicking Save persists the comment", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");

  await v.clickSourceLine(1); // `return 43;` -> line 2
  await v.openComposer("q");
  await v.writeAndSave("should this be configurable?");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].path, "src/app.ts");
  assert.equal(stored[0].line, 2);
  assert.equal(stored[0].text, "should this be configurable?");
  v.close();
});

test("diff view: clicking Save persists the comment", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  assert.equal(v.visibleView(), "diff");

  await v.clickFirstDiffLine();
  await v.openComposer("q");
  await v.writeAndSave("diff-view comment");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "diff-view comment");
  assert.deepEqual(v.visibleCardTexts(), ["diff-view comment"]);
  v.close();
});

test("diff composer reserves both pane timelines and cancel removes stale layout immediately", async () => {
  const v = await loadViewer(html);
  v.window.addComment("q", "AGENTS.md", 5, "## Project", "unrelated saved comment");
  v.window.refreshComments();
  await v.openDiffFor("src/app.ts");
  const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const activeRight = wrapper.querySelectorAll(".d2h-file-side-diff")[1];
  const activeLine = Array.from(activeRight.querySelectorAll(".d2h-code-side-linenumber")).find((cell) => cell.textContent.trim());
  v.click(activeLine.closest("tr").querySelector(".d2h-code-side-line"));
  await v.settle(20);
  await v.openComposer("q");

  const sides = wrapper.querySelectorAll(".d2h-file-side-diff");
  assert.ok(sides[1].querySelector(".mc-comment-row[data-comment-slot]"), "the working-tree pane owns the interactive comment row");
  assert.ok(sides[0].querySelector(".mc-comment-spacer-row[data-comment-slot]"), "the base pane reserves the same timeline slot");
  assert.equal(sides[0].querySelector(".mc-composer"), null, "the base spacer never duplicates an interactive textarea");

  const oldStack = sides[0].querySelector(".mc-diff-layer-stack");
  oldStack.style.transform = "translate3d(0, 120px, 0)"; // model the stale correction from the reported regression
  wrapper.__asymmetricDiffState.offset = 120;
  const refreshed = [];
  const originalRefreshGutters = v.window.refreshLayeredDiffGutters;
  v.window.refreshLayeredDiffGutters = (target) => {
    refreshed.push(target);
    return originalRefreshGutters(target);
  };
  v.window.closeComposer();

  assert.equal(wrapper.querySelector(".mc-comment-row"), null, "cancel removes the comment row synchronously");
  assert.equal(wrapper.querySelector(".mc-comment-spacer-row"), null, "cancel removes its paired timeline slot synchronously");
  assert.equal(oldStack.style.transform, "", "cancel recomputes and clears a stale base-pane transform without waiting for scroll");
  assert.ok(refreshed.length > 0, "the changed diff refreshes its line-number layer");
  assert.ok(refreshed.every((target) => target === wrapper), "cancel never remeasures unrelated changed files");
  const unrelatedWrapper = Array.from(v.document.querySelectorAll('.d2h-file-wrapper')).find((candidate) => candidate.querySelector('.d2h-file-name')?.textContent.trim() === 'AGENTS.md');
  assert.ok(unrelatedWrapper?.querySelector('.mc-comment-row'), "the unrelated saved comment remains mounted instead of being rebuilt");
  v.close();
});

test("closing a comment composer removes the hovered button shortcut bubble", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("c");

  const input = v.visibleComposerInput();
  const save = input.closest(".mc-comment-row").querySelector(".mc-save");
  save.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  assert.equal(v.$("#mc-button-hint").classList.contains("hidden"), false, "hover shows the Comment shortcut");
  assert.equal(v.$("#mc-button-hint kbd").textContent, "⌘↵", "the tooltip advertises the real save shortcut instead of generic Enter");

  v.window.closeComposer();
  await v.settle(0);
  assert.equal(v.$("#mc-button-hint").classList.contains("hidden"), true, "the removed button cannot leave an orphan tooltip");
  v.close();
});
// Keyboard navigation of comment boxes (arrow-stop, edit, delete) lives in comment-nav.test.mjs.

test("Cmd+Enter saves from the focused composer", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSaveWithKeyboard("saved with the keyboard");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "saved with the keyboard");
  v.close();
});

test("empty/whitespace input saves nothing and closes the composer", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("   \n  "); // only whitespace

  assert.equal(v.storedComments().length, 0, "nothing persisted");
  assert.equal(v.$(".mc-composer"), null, "composer closed");
  v.close();
});

test("multiple comments on the same line accumulate as a thread", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");

  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("first");

  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("second");

  const stored = v.storedComments();
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((c) => c.text),
    ["first", "second"],
  );
  // both render on the same line, in order
  assert.deepEqual(v.visibleCardTexts(), ["first", "second"]);
  v.close();
});

test("comments persist across a reopen (restored from localStorage)", async () => {
  // Session 1: write a comment, snapshot storage.
  const v1 = await loadViewer(html);
  await v1.openSourceFile("AGENTS.md");
  await v1.clickSourceLine(4);
  await v1.openComposer("q");
  await v1.writeAndSave("persist me");
  const snapshot = v1.exportStorage();
  assert.ok(snapshot["kakapo-comments:/review.html"], "comment was persisted");
  v1.close();

  // Session 2: fresh viewer seeded with that storage (simulates relaunching the app).
  const v2 = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(v2.storedComments().length, 1, "comment restored into memory");
  await v2.openSourceFile("AGENTS.md");
  assert.deepEqual(v2.visibleCardTexts(), ["persist me"], "restored comment renders as a card");
  v2.close();
});

test("auto-focus lands on the on-screen composer, not the hidden duplicate", async () => {
  // In the source view the composer is injected into BOTH views; only the source one is visible.
  // Auto-focus must target it (this broke alongside the save bug — same root cause).
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.settle(400); // let the focus-retry interval (~300ms cap) settle

  const active = v.document.activeElement;
  assert.ok(active && active.classList.contains("mc-input"), "a composer textarea is focused");
  assert.ok(active.closest("#source-viewer"), "the focused textarea is in the visible source view");
  assert.equal(active.closest("#diff-view"), null, "not the hidden diff-view duplicate");
  v.close();
});

test("change-request comments are saved and labeled distinctly from questions", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("rename this section");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, "c");
  // the saved card carries a change-request kind class (mc-c), distinct from questions (mc-q)
  assert.ok(v.$("#source-body .mc-card.mc-c:not(.mc-composer)"), "rendered as a change-request card");
  v.close();
});

test("saved comments roll up into the merged agent prompt", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("merge me into the prompt");

  await v.openMergedView();
  const text = v.mergedModalText();
  assert.ok(text, "merged-view modal opened");
  assert.match(text, /merge me into the prompt/);
  assert.match(text, /@AGENTS\.md#L5/, "merged prompt uses the canonical file-line reference");
  assert.doesNotMatch(text, /Questions\s*\(\d+\)/, "the fluid comment count is omitted from the merged heading");
  v.close();
});

test("multi-line comments persist and render one canonical range without quoted source", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("docs/runtime-arrow-wfa-plan.md.ts");
  await v.clickSourceLine(2); // line 3
  v.key("ArrowDown", { shiftKey: true });
  v.key("ArrowDown", { shiftKey: true });
  v.key("ArrowDown", { shiftKey: true }); // selection: lines 3-6
  await v.settle(30);
  await v.openComposer("q");

  const expected = "@docs/runtime-arrow-wfa-plan.md.ts#L3-6";
  assert.equal(v.$(".mc-composer .mc-target")?.textContent, expected, "composer shows the complete selected range");
  await v.writeAndSave("explain the selected range");

  const stored = v.storedComments()[0];
  assert.deepEqual({ line: stored.line, from: stored.from, to: stored.to }, { line: 6, from: 3, to: 6 }, "the complete range survives persistence");
  assert.equal(v.$("#source-body .mc-card:not(.mc-composer) .mc-target")?.textContent, expected, "saved comment card keeps the same reference");

  const merged = v.window.buildMergedText();
  assert.match(merged, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "merged text keeps the canonical range");
  assert.doesNotMatch(merged, /^> /m, "merged text does not attach selected source as a blockquote");
  assert.doesNotMatch(merged, /export const line3 = 3/, "selected source text is omitted from the handoff");

  await v.openMergedView();
  assert.equal(v.$(".mc-merged-card .mc-target")?.textContent, expected, "rendered merged card uses the same reference");
  assert.equal(v.$(".mc-merged-preview blockquote"), null, "rendered merged view has no redundant source blockquote");
  v.close();
});

test("Electron bridge: saves onto a frozen (contextBridge) comments array", async () => {
  // Electron exposes persisted settings through contextBridge, which DEEP-FREEZES them. An empty
  // comments array already persisted is the minimal repro — reviewComments.push used to throw
  // "object is not extensible" here. (jsdom's localStorage path uses plain arrays and never hit it.)
  const v = await loadViewer(html, {
    electronSettings: { "kakapo-comments:/review.html": [] },
  });
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSaveWithKeyboard("saved under electron"); // pushes onto the frozen array

  assert.equal(v.storedComments().length, 1);
  assert.equal(v.storedComments()[0].text, "saved under electron");
  // it also went back through the settings bridge for cross-restart persistence
  assert.equal(v.electronWrites()["kakapo-comments:/review.html"]?.length, 1);
  v.close();
});

test("Electron bridge: appends to a frozen pre-existing thread, keeping both", async () => {
  const v = await loadViewer(html, {
    electronSettings: {
      "kakapo-comments:/review.html": [
        { seq: 1, kind: "q", path: "AGENTS.md", line: 5, code: "", text: "pre-existing" },
      ],
    },
  });
  await v.openSourceFile("AGENTS.md");
  assert.deepEqual(v.visibleCardTexts(), ["pre-existing"], "frozen comment restored + rendered");

  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSaveWithKeyboard("appended");

  assert.deepEqual(
    v.storedComments().map((c) => c.text),
    ["pre-existing", "appended"],
  );
  v.close();
});

test("composer disables OS autocorrect/spellcheck so it can't mangle code or swallow spaces after punctuation", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  const input = v.$(".mc-composer .mc-input");
  assert.ok(input, "composer textarea is present");
  assert.equal(input.getAttribute("spellcheck"), "false", "spellcheck is disabled");
  assert.equal(input.getAttribute("autocorrect"), "off", "macOS autocorrect is disabled");
  assert.equal(input.getAttribute("autocapitalize"), "off", "autocapitalize is disabled");
  v.close();
});

test("merged prompt: comments stay visible after opening then closing the merged view (#5)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("keep me");
  v.window.openMergedView();
  await v.settle(120); // let the inline editor initialize
  v.window.__kakapoCloseDocks();
  await v.settle(60);
  assert.equal(v.storedComments().length, 1, "comment still exists after closing the merged view");
  assert.ok(v.$all(".mc-card").length >= 1, "the comment card is re-rendered/visible after the dock closes");
  v.close();
});

test("header: the reveal button (⌥F1) focuses/centers the open file's row in the sidebar tree (#3)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  if (typeof v.window.clearTreeFocus === "function") v.window.clearTreeFocus();
  const btn = v.$("#brand-reveal");
  assert.ok(btn, "reveal button is present in the one-line header");
  v.click(btn);
  await v.settle(50);
  const focused = v.$(".tree-focus");
  assert.ok(focused, "a tree row is focused after reveal");
  assert.equal(focused.dataset.sourceFile || focused.dataset.file, "src/app.ts", "the open file's row is the revealed one");
  v.close();
});

test("Korean IME: the physical E key (code KeyE, key 'ㄷ') still triggers comment edit — shortcuts match on event.code", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("original text");
  const body = v.$("#source-body");
  if (body) { body.tabIndex = -1; body.focus(); } // ensure focus is not on a textarea so the caret handler runs
  const row = v.$(".mc-comment-row");
  assert.ok(row, "the comment box rendered in the source view");
  v.window.selectCommentRow(row);
  // Under a Korean IME the E key reports key='ㄷ' (composed Hangul) but code='KeyE'. The old key-only check
  // ('e'/'E') missed this; matching on event.code fixes it.
  v.key("ㄷ", { code: "KeyE" });
  await v.settle(50);
  const input = v.$(".mc-composer .mc-input");
  assert.ok(input, "edit composer opened despite the Hangul key value");
  assert.equal(input.value, "original text", "composer is pre-filled with the comment for editing");
  v.close();
});

// Undo (Cmd/Ctrl+Z): deleting a comment became one keystroke away from the merged panel's Enter->navigate+edit
// flow, so an accidental Backspace at the destination needs a safety net (see removeComments/
// undoLastCommentRemoval in 07-comments.js and the global handler in 05-keymap.js).
test("Cmd+Z restores a comment removed via the delete (×) button", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("please undo my removal");
  assert.equal(v.storedComments().length, 1);

  v.$(".mc-del").click();
  await v.settle(20);
  assert.equal(v.storedComments().length, 0, "the comment is removed");

  v.document.body.focus(); // not inside any native input/editor
  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.equal(v.storedComments().length, 1, "Cmd+Z restores it");
  assert.equal(v.storedComments()[0].text, "please undo my removal", "with its original text intact");
  v.close();
});

test("Cmd+Z restores every comment removed together by one Backspace on a shared row", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("first on this line");
  await v.openComposer("c");
  await v.writeAndSave("second on this line");
  assert.equal(v.storedComments().length, 2);

  const row = v.$(".mc-comment-row");
  v.window.selectCommentRow(row);
  v.key("Backspace");
  await v.settle(20);
  assert.equal(v.storedComments().length, 0, "Backspace on the selected row removes both comments on it");

  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.deepEqual(v.storedComments().map((c) => c.text).sort(), ["first on this line", "second on this line"], "one undo restores the whole batch");
  v.close();
});

test("Cmd+Z inside a real text input does not touch comments — native undo owns that key there", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("keep me");
  v.$(".mc-del").click();
  await v.settle(20);
  assert.equal(v.storedComments().length, 0);

  await v.openComposer("q"); // focus lands in a live <textarea>
  const input = v.visibleComposerInput();
  input.focus();
  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.equal(v.storedComments().length, 0, "Cmd+Z while a composer textarea is focused is left to the browser, not intercepted for comment undo");
  v.close();
});

// GitHub issue #9: the merged prompt panel is a single unified hand-off (no separate question/change-request
// panels), with the question section first so an agent answers questions (no edits) before touching code.
test("unified merged prompt: questions and change requests share one document, questions first, both contracts included", async () => {
  const v = await loadViewer(html);
  v.window.addComment("q", "AGENTS.md", 5, "", "why this wording?");
  v.window.addComment("c", "src/app.ts", 1, "", "simplify this");

  const merged = v.window.buildMergedText();
  const t = v.window.t;
  const qContractAt = merged.indexOf(t("mergePrompt.default.q"));
  const questionAt = merged.indexOf("why this wording?");
  const planContractAt = merged.indexOf(t("plan.contract"));
  const cContractAt = merged.indexOf(t("mergePrompt.default.c"));
  const changeAt = merged.indexOf("simplify this");
  assert.ok(
    qContractAt >= 0 && qContractAt < questionAt
      && questionAt < planContractAt && planContractAt < cContractAt
      && cContractAt < changeAt,
    "document order is: question contract -> questions -> plan contract -> change-request contract -> change requests",
  );
  v.close();
});

test("unified merged prompt: a kind with no open comments omits its contract entirely", async () => {
  const v = await loadViewer(html);
  v.window.addComment("c", "src/app.ts", 1, "", "only a change request");
  const t = v.window.t;

  const onlyC = v.window.buildMergedText();
  assert.ok(!onlyC.includes(t("mergePrompt.default.q")), "no question contract when there are no open questions");
  assert.ok(onlyC.includes(t("mergePrompt.default.c")) && onlyC.includes("only a change request"));

  v.window.addComment("q", "AGENTS.md", 5, "", "only a question");
  v.window.deleteComment(v.storedComments().find((c) => c.kind === "c").seq);
  const onlyQ = v.window.buildMergedText();
  assert.ok(!onlyQ.includes(t("plan.contract")) && !onlyQ.includes(t("mergePrompt.default.c")), "no plan/change-request contract when there are no open change requests");
  v.close();
});

test("unified merged prompt: one dock panel renders both a question and a change request together", async () => {
  const v = await loadViewer(html);
  v.window.addComment("q", "AGENTS.md", 5, "", "one open question");
  v.window.addComment("c", "src/app.ts", 1, "", "one open change request");

  await v.openMergedView();
  const panels = v.$all("#mc-merged-panel");
  assert.equal(panels.length, 1, "a single merged panel opens for both kinds");
  const text = v.mergedModalText();
  assert.match(text, /one open question/);
  assert.match(text, /one open change request/);
  v.close();
});

// Regression: the plan/change-request contract prose sits BETWEEN the last question and the first change
// request in the unified document. The now-removed reconcileMergedComments used to treat everything between
// two comment headings as belonging to the earlier one, so on close that structural preamble (and, on a
// second close, a second copy of it) got silently absorbed into the last question's text instead of being
// left as inert document scaffolding.
test("unified merged prompt: closing/reopening never absorbs the plan/change-request contract into the last question's text", async () => {
  const v = await loadViewer(html);
  v.window.addComment("q", "AGENTS.md", 5, "", "one open question");
  await v.openMergedView();
  await v.settle(150);

  v.window.addComment("c", "src/app.ts", 1, "", "one open change request");
  v.window.openMergedView(); // closes+reconciles the q-only session, then rebuilds with both kinds
  await v.settle(150);
  v.window.addComment("c", "src/app.ts", 2, "", "second change request");
  v.window.openMergedView(); // closes+reconciles the two-item session, then rebuilds with three
  await v.settle(150);

  const stored = v.storedComments();
  assert.equal(stored.length, 3, "no comment was dropped across the reopen cycles");
  assert.equal(stored.find((c) => c.kind === "q").text, "one open question", "the question's text stays exactly what was typed — no contract prose absorbed into it");
  assert.deepEqual(
    stored.filter((c) => c.kind === "c").map((c) => c.text),
    ["one open change request", "second change request"],
    "both change requests keep their own short text untouched",
  );

  const merged = v.window.buildMergedText();
  assert.equal((merged.match(/Before changing any code, write a short implementation PLAN/g) || []).length, 1, "the plan contract appears exactly once, not duplicated into the question");
  v.close();
});

// An agent's answer belongs in the thread at the comment's own line, where you asked the question — not in
// the merged hand-off panel, where a multi-paragraph reply buries the requests you're there to scan and send.
// The merged card says only that an answer exists.
test("an agent's answer renders in the thread but is only flagged in the merged panel", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");

  const seq = v.storedComments()[0].seq;
  v.window.applyAnswersUpdate([{ seq, answer: "Because it ships as one binary.", answeredAt: "2026-08-08T00:00:00Z" }]);
  await v.settle(60);

  const thread = v.$("#source-body .mc-card:not(.mc-composer) .mc-answer-body");
  assert.equal(thread?.textContent, "Because it ships as one binary.", "the thread card carries the full answer");

  await v.openMergedView();
  const card = v.$(".mc-merged-card");
  assert.ok(card, "merged card rendered");
  assert.equal(card.querySelector(".mc-answer-body"), null, "the answer body is NOT repeated in the merged panel");
  assert.ok(card.querySelector(".mc-answered-tag"), "merged card is flagged as answered instead");
  assert.match(card.querySelector(".mc-card-body").textContent, /why is this a CLI\?/, "the request itself still shows");
  v.close();
});

test("an unanswered comment carries no answered flag in the merged panel", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("still open");

  await v.openMergedView();
  assert.equal(v.$(".mc-merged-card .mc-answered-tag"), null, "no flag until an answer actually arrives");
  v.close();
});

// REGRESSION: an agent round that answers AND edits can remove every comment's anchor line at once, so
// remapComments flags them ALL "possibly addressed" and mergedBlocks filters them all out — the merged panel
// came up blank while the reviewer could still see their comments in the code, with nothing saying why.
test("a merged panel emptied by the addressed heuristic explains itself and can be undone", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("rename this");
  await v.settle(60);

  // What the heuristic does after the agent's edit removes the anchored line.
  const seq = v.storedComments()[0].seq;
  const comment = v.window.reviewComments.find((c) => c.seq === seq);
  comment.anchorPresent = true;
  comment.addressed = true;

  await v.openMergedView();
  assert.equal(v.$(".mc-merged-card"), null, "the flagged comment is filtered out of the hand-off, as designed");
  const note = v.$(".mc-merged-empty-note");
  assert.ok(note, "the blank panel says why it is blank instead of looking like lost work");
  assert.match(note.textContent, /1/, "it names how many comments were flagged");

  v.$(".mc-merged-reopen-all").click();
  await v.settle(80);
  assert.ok(v.$(".mc-merged-card"), "reopening puts the comment back into the hand-off");
  assert.equal(v.$(".mc-merged-empty-note"), null, "and the notice is gone");
  assert.match(v.window.buildMergedText(), /rename this/, "the reopened comment is in the outgoing prompt");
  v.close();
});

test("a genuinely empty review shows no addressed-comments notice", async () => {
  const v = await loadViewer(html);
  await v.openMergedView();
  assert.equal(v.$(".mc-merged-empty-note"), null, "nothing to explain when there are no comments at all");
  v.close();
});

// GitHub-style: an answer ends a turn, not the conversation. Reply from the card, and the follow-up travels
// with the exchange it continues — the answers checklist is rewritten every round, so a bare "why that way?"
// would otherwise reach the agent with the question it refers to stripped off.
test("a reply continues the thread and carries the earlier exchange to the agent", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(60);

  const seq = v.storedComments()[0].seq;
  v.window.applyAnswersUpdate([{ seq, answer: "It ships as one binary.", answeredAt: "2026-08-08T00:00:00Z" }]);
  await v.settle(60);

  const replyBtn = v.$("#source-body .mc-card:not(.mc-composer) .mc-reply");
  assert.ok(replyBtn, "an answered card offers a reply, so the exchange isn't a dead end");
  replyBtn.click();
  await v.settle(60);
  assert.ok(v.visibleComposerInput(), "reply composer opened without re-selecting the code line");
  await v.writeAndSave("then why not a library too?");
  await v.settle(60);

  const stored = v.storedComments();
  assert.equal(stored.length, 2, "the reply is its own comment");
  const reply = stored[1];
  assert.equal(reply.replyTo, seq, "linked to the comment it answers");
  assert.equal(reply.kind, "q", "a follow-up to a question is still a question");
  assert.equal(reply.line, stored[0].line, "and stays anchored to the same line, so it renders as one thread");

  const merged = v.window.buildMergedText();
  assert.match(merged, /> why is this a CLI\?/, "the hand-off quotes the original question");
  assert.match(merged, /> .*It ships as one binary\./, "...and the answer it got");
  assert.match(merged, /then why not a library too\?/, "...before the follow-up itself");
  v.close();
});

test("a plain comment carries no thread context", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("standalone question");
  await v.settle(60);

  assert.equal(v.storedComments()[0].replyTo, null, "no parent");
  assert.doesNotMatch(v.window.buildMergedText(), /^> /m, "and nothing quoted ahead of it");
  v.close();
});
