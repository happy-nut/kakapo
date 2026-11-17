import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

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

  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why a CLI and not a library?");

  const stored = v.storedComments();
  assert.equal(stored.length, 1);
  assert.deepEqual(
    { kind: stored[0].kind, line: stored[0].line, text: stored[0].text },
    { kind: "c", line: 5, text: "why a CLI and not a library?" },
  );
  assert.deepEqual(v.visibleCardTexts(), ["why a CLI and not a library?"]);
  v.close();
});

test("plain source (code) view: clicking Save persists the comment", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  assert.equal(v.visibleView(), "source");

  await v.clickSourceLine(1);
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
  oldStack.style.transform = "translate3d(0, 120px, 0)";
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
  const saveChord = v.window.shortcutKeys("saveComment")[0];
  assert.ok(saveChord, "the table still has a chord for saving a comment");
  assert.equal(v.$("#mc-button-hint kbd").textContent, saveChord,
    "the tooltip advertises the real save shortcut instead of generic Enter");

  v.window.closeComposer();
  await v.settle(0);
  assert.equal(v.$("#mc-button-hint").classList.contains("hidden"), true, "the removed button cannot leave an orphan tooltip");
  v.close();
});

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
  await v.writeAndSave("   \n  ");

  assert.equal(v.storedComments().length, 0, "nothing persisted");
  assert.equal(v.$(".mc-composer"), null, "composer closed");
  v.close();
});

test("an untouched composer says what is missing instead of vanishing", async () => {
  const v = await loadViewer(html);
  try {
    await v.openSourceFile("AGENTS.md");
    await v.clickSourceLine(4);
    await v.openComposer("q");
    const box = v.visibleComposerInput();
    assert.ok(box, "the premise: a composer is open");
    assert.match(box.value, /^@/, "and it opened holding the anchor, not empty");

    await v.writeAndSave(box.value);
    assert.equal(v.storedComments().length, 0, "nothing persisted");
    assert.ok(v.$(".mc-composer"), "and the box is still there to write in");
  } finally {
    v.close();
  }
});

test("a second comment on the same line edits the first instead of piling up", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");

  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("first");

  await v.clickSourceLine(4);
  await v.openComposer("c");
  assert.equal(v.visibleComposerInput().value, "first", "the composer reopened on what is already there");
  await v.writeAndSave("first, revised");

  const stored = v.storedComments();
  assert.equal(stored.length, 1, "still one comment on this line");
  assert.deepEqual(stored.map((c) => c.text), ["first, revised"]);
  assert.deepEqual(v.visibleCardTexts(), ["first, revised"]);
  v.close();
});

test("comments persist across a reopen (restored from localStorage)", async () => {
  const v1 = await loadViewer(html);
  await v1.openSourceFile("AGENTS.md");
  await v1.clickSourceLine(4);
  await v1.openComposer("q");
  await v1.writeAndSave("persist me");
  const snapshot = v1.exportStorage();
  assert.ok(snapshot["kakapo-comments:/review.html"], "comment was persisted");
  v1.close();

  const v2 = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(v2.storedComments().length, 1, "comment restored into memory");
  await v2.openSourceFile("AGENTS.md");
  assert.deepEqual(v2.visibleCardTexts(), ["persist me"], "restored comment renders as a card");
  v2.close();
});

test("auto-focus lands on the on-screen composer, not the hidden duplicate", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.settle(400);

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
  assert.ok(v.$("#source-body .mc-card.mc-c:not(.mc-composer)"), "rendered as a review comment card");
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

test("the copied document is the comments and nothing else", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("rename this to something honest");

  const copied = [];
  v.window.reviewThreadPath = "/w/.git/kakapo/comments.jsonl";
  v.window.navigator.clipboard = { writeText: (text) => { copied.push(text); return Promise.resolve(); } };
  v.window.kakapoClipboard = { write: (text) => { copied.push(text); return true; } };

  await v.openMergedView();
  const button = v.$("#mc-merged-panel .mc-copy-all");
  assert.ok(button && !button.disabled, "the merged panel offers its hand-off action");
  button.click();
  await v.settle(20);

  assert.equal(copied.length, 1, "one document leaves the panel");
  assert.match(copied[0], /rename this to something honest/, "the review itself is in it");
  assert.doesNotMatch(copied[0], /append ONE line per answer/, "no answer instructions are prepended");
  assert.doesNotMatch(copied[0], /comments\.jsonl/, "and no file path either");
  assert.ok(copied[0].startsWith("@AGENTS.md#L"), "it opens on the first comment's anchor, not on a contract");
  v.close();
});

test("multi-line comments persist and render one canonical range without quoted source", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("docs/runtime-arrow-wfa-plan.md.ts");
  await v.clickSourceLine(2);
  v.key("ArrowDown", { shiftKey: true });
  v.key("ArrowDown", { shiftKey: true });
  v.key("ArrowDown", { shiftKey: true });
  await v.settle(30);
  await v.openComposer("q");

  const expected = "@docs/runtime-arrow-wfa-plan.md.ts#L3-6";
  assert.equal(v.$(".mc-composer .mc-input")?.value, expected + " ", "composer prefills the complete selected range");
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
  const v = await loadViewer(html, {
    electronSettings: { "kakapo-comments:/review.html": [] },
  });
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSaveWithKeyboard("saved under electron");

  assert.equal(v.storedComments().length, 1);
  assert.equal(v.storedComments()[0].text, "saved under electron");
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

  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
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
  await v.settle(120);
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
  if (body) { body.tabIndex = -1; body.focus(); }
  const row = v.$(".mc-comment-row");
  assert.ok(row, "the comment box rendered in the source view");
  v.window.selectCommentRow(row);
  v.key("ㄷ", { code: "KeyE" });
  await v.settle(50);
  const input = v.$(".mc-composer .mc-input");
  assert.ok(input, "edit composer opened despite the Hangul key value");
  assert.equal(input.value, "original text", "composer is pre-filled with the comment for editing");
  v.close();
});

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

  v.document.body.focus();
  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.equal(v.storedComments().length, 1, "Cmd+Z restores it");
  assert.equal(v.storedComments()[0].text, "please undo my removal", "with its original text intact");
  v.close();
});

test("Backspace removes the selected turn only, and Cmd+Z restores it", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("first on this line");
  await v.clickSourceLine(2);
  await v.openComposer("c");
  await v.writeAndSave("second on this line");
  assert.equal(v.storedComments().length, 2);

  const row = v.$(".mc-comment-row");
  v.window.selectCommentRow(row);
  v.key("Backspace");
  await v.settle(20);
  assert.deepEqual(v.storedComments().map((c) => c.text), ["second on this line"], "only the selected card is gone");

  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.deepEqual(v.storedComments().map((c) => c.text).sort(), ["first on this line", "second on this line"], "undo brings it back");
  v.close();
});

test("Backspace on the first card in a thread takes the conversation with it, and one Cmd+Z brings it back", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("c");
  await v.writeAndSave("why is this here?");
  const seq = v.storedComments()[0].seq;
  v.agentSays({ re: seq, text: "because of X." });
  await v.settle(60);
  assert.equal(v.storedComments().length, 2, "the question and the answer to it");

  const row = v.$(".mc-comment-row");
  v.window.selectCommentRow(row);
  v.key("Backspace");
  await v.settle(20);
  assert.deepEqual(v.storedComments(), [], "the answer goes with the question it answers");

  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.equal(v.storedComments().length, 2, "one undo restores the whole thread, not just the question");

  v.window.selectCommentRow(v.$(".mc-comment-row"));
  v.key("ArrowDown");
  await v.settle(20);
  v.key("Backspace");
  await v.settle(20);
  assert.deepEqual(v.storedComments().map((c) => c.text), ["why is this here?"], "the answer alone is gone");
  v.close();
});

test("arrows walk the turns inside a thread, and `e` edits the one selected", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("the question");
  await v.settle(40);

  const seq = v.storedComments()[0].seq;
  v.agentSays({ re: seq, text: "the answer" });
  await v.settle(60);

  v.window.selectCommentRow(v.$("#source-body .mc-comment-row"));
  await v.settle(20);
  assert.match(v.$("#source-body .mc-card-selected .mc-card-body")?.textContent || "", /the question/, "selection starts on the first turn");

  v.key("ArrowDown");
  await v.settle(20);
  assert.match(v.$("#source-body .mc-card-selected .mc-card-body")?.textContent || "", /the answer/, "ArrowDown steps to the agent's turn instead of off the row");

  v.key("ArrowUp");
  await v.settle(20);
  v.key("e", { code: "KeyE" });
  await v.settle(60);
  assert.equal(v.visibleComposerInput()?.value, "the question", "`e` edits the selected turn");
  v.close();
});

test("the merged hand-off prints a comment's reference once, not twice", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  const prefilled = v.visibleComposerInput().value;
  assert.match(prefilled, /^@AGENTS\.md#L5\s/, "the composer still prefills the anchor for the writer to keep or delete");
  v.typeInto(v.visibleComposerInput(), prefilled + "why is this a CLI?");
  v.click(v.$(".mc-comment-row .mc-save"));
  await v.settle(60);

  const merged = v.window.buildMergedText();
  assert.equal((merged.match(/@AGENTS\.md#L5/g) || []).length, 1, "the reference appears exactly once");
  assert.match(merged, /^@AGENTS\.md#L5$/m, "on its own line above the comment");
  assert.doesNotMatch(merged, /^#/m, "no markdown heading syntax in front of it");
  assert.match(merged, /^why is this a CLI\?$/m, "with the body left as what the writer actually said");

  v.close();
});

test("an edited reference in the body survives into the hand-off", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  v.typeInto(v.visibleComposerInput(), "@AGENTS.md#L99 while I am here — why?");
  v.click(v.$(".mc-comment-row .mc-save"));
  await v.settle(60);

  const merged = v.window.buildMergedText();
  assert.match(merged, /^@AGENTS\.md#L5$/m, "the line above says where the comment hangs");
  assert.match(merged, /@AGENTS\.md#L99 while I am here/, "and the body keeps the reference the writer chose");
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

  await v.openComposer("q");
  const input = v.visibleComposerInput();
  input.focus();
  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.equal(v.storedComments().length, 0, "Cmd+Z while a composer textarea is focused is left to the browser, not intercepted for comment undo");
  v.close();
});

test("unified merged document: every open comment shares one document, in review order", async () => {
  const v = await loadViewer(html);
  v.window.addComment("c", "AGENTS.md", 5, "", "why this wording?");
  v.window.addComment("c", "src/app.ts", 1, "", "simplify this");

  const merged = v.window.buildMergedText();
  const askAt = merged.indexOf("why this wording?");
  const changeAt = merged.indexOf("simplify this");
  assert.ok(askAt >= 0 && askAt < changeAt, "the comments are there, in review order");
  assert.ok(merged.startsWith("@AGENTS.md#L"), "and nothing leads them");
  v.close();
});

test("unified merged document: no open comments means an empty document", async () => {
  const v = await loadViewer(html);
  assert.equal(v.window.buildMergedText(), "", "an empty review copies nothing");

  v.window.addComment("c", "src/app.ts", 1, "", "only this one");
  assert.match(v.window.buildMergedText(), /only this one/, "and carries a comment once there is one");

  v.window.deleteComment(v.storedComments()[0].seq);
  assert.equal(v.window.buildMergedText(), "", "and empties again with the last comment");
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

test("unified merged prompt: closing/reopening never absorbs the plan/change-request contract into the last question's text", async () => {
  const v = await loadViewer(html);
  v.window.addComment("q", "AGENTS.md", 5, "", "one open question");
  await v.openMergedView();
  await v.settle(150);

  v.window.addComment("c", "src/app.ts", 1, "", "one open change request");
  v.window.openMergedView();
  await v.settle(150);
  v.window.addComment("c", "src/app.ts", 2, "", "second change request");
  v.window.openMergedView();
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
  assert.doesNotMatch(merged, /Before changing any code, write a short implementation PLAN/, "no contract prose is prepended");
  assert.match(merged, /one open question/, "just the comments the reviewer wrote");
  v.close();
});

test("a follow-up reaches the thread file without reopening the hand-off panel", async () => {
  const v = await loadViewer(html);
  const writes = [];
  v.window.kakapoComments = {
    write: (payload) => { writes.push(payload); return Promise.resolve({ ok: true, path: "/x/comments.jsonl" }); },
  };
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(400);
  assert.deepEqual(Array.from(writes.at(-1)?.records ?? [], (r) => r.text), ["why is this a CLI?"],
    "the question is in the file already");

  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI, and not a library?");
  await v.settle(400);

  const records = Array.from(writes.at(-1).records);
  assert.deepEqual(records.map((r) => r.text), ["why is this a CLI, and not a library?"],
    "the file carries the revision, not the text it replaced");
  assert.equal(records[0].by, undefined, "…still recorded as the reviewer's own line");
  v.close();
});

test("an agent's answer raises a notification, but re-reading the thread does not", async () => {
  const v = await loadViewer(html);
  const bells = [];
  v.window.document.hasFocus = () => false;
  v.window.Notification = function (title, options) { bells.push({ title, ...options }); };
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(60);
  assert.equal(bells.length, 0, "the reviewer's own comment is not an event");

  v.agentSays({ re: v.storedComments()[0].seq, text: "It ships as one binary.\nMore below." });
  await v.settle(60);
  assert.equal(bells.length, 1, "the answer is");
  assert.match(bells[0].body, /It ships as one binary\./, "with enough of it to know what landed");
  const answered = v.storedComments().find((c) => c.by === "agent");
  await v.openSourceFile("src/app.ts");
  await v.settle(40);
  assert.equal(v.window.revealComment(answered.seq), true, "and that id is enough to go back to it");
  await v.settle(80);
  const shown = v.window.isDiffViewVisible()
    ? v.window.diffWrapperPathKey(v.diffCaretRow()?.closest(".d2h-file-wrapper"))
    : v.$("#source-viewer").dataset.openPath;
  assert.equal(shown, "AGENTS.md", "the file the exchange is in is on screen again");

  v.window.applyThreadRecords(v.window.reviewComments.map(v.window.commentToRecord));
  await v.settle(60);
  assert.equal(bells.length, 1, "an unchanged thread stays quiet");

  v.window.kakapoSettings = { all: { "kakapo-answer-notify": false } };
  v.agentSays({ re: v.storedComments()[0].seq, text: "one more thing" });
  await v.settle(60);
  assert.equal(bells.length, 1, "and the setting turns it off");
  v.close();
});

test("a thread holds one comment of the reviewer's, plus the agent's answer", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(60);
  assert.equal(v.$("#source-body .mc-reply-stub"), null, "no box invites a second turn");

  v.agentSays({ re: v.storedComments()[0].seq, text: "It ships as one binary." });
  await v.settle(60);
  assert.deepEqual(v.visibleCardTexts().map((t) => t.trim()), ["why is this a CLI?", "It ships as one binary."],
    "the answer still lands in the thread");
  assert.equal(v.$("#source-body .mc-reply-stub"), null, "…and still nothing invites a reply to it");
  assert.equal(v.storedComments().length, 2, "two cards, and no third to write");
  v.close();
});

test("a diagram in an agent's answer is rendered, in a review with no notes at all", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("how does the hand-off flow?");
  await v.settle(60);

  const passes = [];
  v.window.renderMermaidDiagrams = function (root) { passes.push(root); };
  v.agentSays({ re: v.storedComments()[0].seq, text: "Like this:\n\n```mermaid\ngraph TD\n  A-->B\n```\n" });
  await v.settle(60);

  assert.ok(v.$("#source-body .mc-card.mc-ai .explain-mermaid"), "the fence became a diagram placeholder in the reply");
  assert.ok(passes.length, "…and a render pass ran over it instead of leaving it on 'loading…'");
  v.close();
});

test("an agent's answer renders in the thread and takes the exchange out of the hand-off", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");

  const seq = v.storedComments()[0].seq;
  v.agentSays({ re: seq, text: "Because it ships as **one binary**.\n\n1. warm start\n2. comparison\n" });
  await v.settle(60);

  const thread = v.$("#source-body .mc-card.mc-ai .mc-ai-body");
  assert.ok(thread, "the answer is its own card in the thread");
  assert.match(thread.textContent, /Because it ships as one binary\./, "the answer text is there");
  assert.equal(thread.querySelector("strong")?.textContent, "one binary", "…with its markdown rendered, not escaped");
  assert.equal(thread.querySelectorAll("ol > li").length, 2, "…including lists");
  assert.doesNotMatch(thread.textContent, /\*\*/, "no raw markdown syntax leaks through");

  await v.openMergedView();
  assert.equal(v.$all(".mc-merged-card").length, 0, "the answered exchange is not in the hand-off at all");
  assert.doesNotMatch(v.window.buildMergedText(), /why is this a CLI\?/, "…nor in the document it builds");
  assert.match(v.$(".mc-merged-empty-note").textContent, /answer/i, "and the empty panel says why it is empty");
  v.close();
});

test("an answered comment drops out of the hand-off and stays out", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  assert.match(v.window.buildMergedText(), /why is this a CLI\?/, "an open comment is handed over");

  const seq = v.storedComments()[0].seq;
  v.agentSays({ re: seq, text: "Because it ships as one binary." });
  await v.settle(60);

  const merged = v.window.buildMergedText();
  assert.equal(merged, "", "answered: neither the question nor the answer goes back");
  v.close();
});

test("an unrelated open comment still goes over while another thread is answered", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  v.agentSays({ re: v.storedComments()[0].seq, text: "One binary." });
  await v.settle(60);

  await v.clickSourceLine(6);
  await v.openComposer("q");
  await v.writeAndSave("still open");
  await v.settle(60);

  const merged = v.window.buildMergedText();
  assert.match(merged, /still open/, "the unanswered comment is handed over");
  assert.doesNotMatch(merged, /why is this a CLI\?/, "the answered one is not");
  v.close();
});

test("a merged panel emptied by the addressed heuristic explains itself and can be undone", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("rename this");
  await v.settle(60);

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

test("a genuinely empty review says how to write a comment, and claims nothing was addressed", async () => {
  const v = await loadViewer(html);
  await v.openMergedView();
  const note = v.$(".mc-merged-empty-note");
  assert.ok(note, "the blank panel says where comments come from");
  assert.ok(note.querySelector("kbd"), "naming the key that writes one");
  assert.equal(v.$(".mc-merged-reopen-all"), null, "and offers nothing to reopen, because nothing was written");
  v.close();
});

test("nothing offers the reviewer a second turn in a thread", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(60);

  const seq = v.storedComments()[0].seq;
  v.agentSays({ re: seq, text: "It ships as one binary." });
  await v.settle(60);

  assert.equal(v.$("#source-body .mc-reply-stub"), null, "no waiting box");
  assert.equal(v.$("#source-body .mc-reply"), null, "and no reply button in any card header");
  v.window.selectCommentRow(v.$("#source-body .mc-comment-row"));
  v.key("ArrowDown");
  v.key("Enter");
  await v.settle(60);
  assert.ok(!v.visibleComposerInput(), "and Enter on the last card opens nothing");
  assert.equal(v.storedComments().length, 2, "the thread is still just the question and its answer");
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
  assert.doesNotMatch(v.window.buildMergedText(), /Continues/, "and no history line ahead of it");
  v.close();
});

test("a saved card drops the location it is already sitting on", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  assert.match(v.$(".mc-composer .mc-input").value, /^@src\/app\.ts#L\d+\s/, "the composer still says where this will attach, before it exists — as text you can delete");

  await v.writeAndSave("why this line");
  const card = v.$("#source-body .mc-card:not(.mc-composer)");
  assert.match(card.textContent, /why this line/, "the comment is saved and on screen");
  assert.equal(card.querySelector(".mc-target"), null, "but its header no longer repeats the line it sits on");

  await v.openMergedView();
  assert.ok(v.$(".mc-merged-card .mc-target"), "the dock still labels every card — there the code is not beside it");
  v.close();
});

test("a comment with no path is never swept away as a missing file", async () => {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoFile = {
    existingPaths: (paths) => {
      asked.push(...paths);
      return Promise.resolve(Object.fromEntries(paths.map((p) => [p, p === "AGENTS.md"])));
    },
  };
  v.window.applyThreadRecords([
    { id: 1, by: "me", path: "AGENTS.md", line: 5, text: "a placed comment" },
    { id: 2, re: 99, by: "agent", text: "an answer whose question is nowhere" },
  ]);
  await v.settle(40);
  assert.equal(v.storedComments().find((c) => c.seq === 2)?.path, "", "the unplaceable answer has no path, as before");

  await v.window.verifyCommentFilesExist();
  await v.settle(40);
  assert.ok(!asked.includes(""), "an empty path is never presented as a file to check");
  assert.equal(v.storedComments().length, 2, "and nothing is deleted for not knowing where it goes");
  v.close();
});

test("a base-pane comment on a deleted file survives the merged panel's missing-file prune", async () => {
  const { html: withDeletion } = await makeReviewHtml([
    { path: "src/gone.ts", before: "export const gone = 1;\nexport const also = 2;\n" },
    { path: "src/app.ts", before: "export function run() {\n  return 42;\n}\n", after: "export function run() {\n  return 43;\n}\n" },
  ]);
  const v = await loadViewer(withDeletion);
  v.window.addComment("c", "src/gone.ts", 1, "export const gone = 1;", "why remove this?", 1, 1, "old", "export const gone = 1;");
  v.window.refreshComments();
  await v.settle(20);
  assert.equal(v.window.commentFileIsKnownMissing("src/gone.ts"), true, "precondition: the deleted file reads as missing from the working tree");

  await v.openMergedView();
  assert.equal(v.storedComments().length, 1, "the comment is not deleted from disk on the way in");
  assert.match(v.window.buildMergedText(), /why remove this\?/, "and it reaches the agent in the hand-off document");
  assert.ok(v.$(".mc-merged-card"), "the panel shows its card rather than coming up blank");
  v.close();
});

test("the missing-file prune still removes working-tree comments, per comment and not per path", async () => {
  const { html: withDeletion } = await makeReviewHtml([
    { path: "src/gone.ts", before: "export const gone = 1;\n" },
    { path: "src/app.ts", before: "export function run() {\n  return 42;\n}\n", after: "export function run() {\n  return 43;\n}\n" },
  ]);
  const v = await loadViewer(withDeletion);
  v.window.addComment("c", "src/gone.ts", 1, "export const gone = 1;", "base side", 1, 1, "old", "export const gone = 1;");
  v.window.addComment("c", "src/gone.ts", 1, "export const gone = 1;", "working-tree side", 1, 1, "new", "export const gone = 1;");
  await v.settle(20);

  assert.equal(v.window.pruneCommentsForMissingFiles(), 1, "exactly the one that lost its anchor");
  assert.deepEqual(v.storedComments().map((c) => c.text), ["base side"], "the base-pane comment on the same file stays");
  v.close();
});

test("one file failing to render cannot strand every other file's comments", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  v.window.addComment("c", "src/app.ts", 2, "  return 43;", "why 43?");
  v.window.refreshComments();
  await v.settle(40);
  assert.deepEqual(v.visibleCardTexts(), ["why 43?"], "precondition: the comment renders normally");

  const wrappers = v.$all("#diff2html-container .d2h-file-wrapper");
  assert.ok(wrappers.length > 1, "precondition: the review has more than one file");
  Object.defineProperty(wrappers[0], "__mcDiffCommentRenderKey", {
    get() { throw new Error("boom"); },
    configurable: true,
  });
  v.window.addComment("c", "src/app.ts", 2, "  return 43;", "and the answer to it");
  v.window.refreshComments();
  await v.settle(40);
  assert.ok(v.visibleCardTexts().includes("and the answer to it"),
    "the second comment reaches the screen even though an earlier file's render blew up");
  v.close();
});

test("a file that could not be painted does not record itself as painted", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/app.ts");
  v.window.addComment("c", "src/app.ts", 2, "  return 43;", "paint me");
  const wrapper = v.$all("#diff2html-container .d2h-file-wrapper")
    .find((w) => w.querySelector(".d2h-file-name")?.textContent.trim() === "src/app.ts");
  const body = wrapper.querySelector(".d2h-files-diff");
  const parked = body.parentNode;
  body.remove();
  v.window.refreshComments();
  await v.settle(40);
  assert.ok(!String(wrapper.__mcDiffCommentRenderKey).includes("paint me"),
    "the unpaintable pass must not record itself as having painted this comment");

  parked.appendChild(body);
  v.window.refreshComments();
  await v.settle(40);
  assert.ok(v.visibleCardTexts().includes("paint me"), "the retry paints it instead of trusting a stale key");
  v.close();
});

test("the anchor the composer prefills is not a comment", async () => {
  const v = await loadViewer(html);
  try {
    const before = v.window.reviewComments.length;
    const path = "src/app.ts";
    const label = v.window.commentTargetLabel({ path, line: 2, from: 2, to: 2 });
    assert.match(label, /^@/, "the premise: the composer's prefill is an @-reference");

    v.window.addComment("c", path, 2, "  return 43;", label + " ", 2, 2, null, "  return 43;");
    assert.equal(v.window.reviewComments.length, before, "an untouched composer saves nothing");

    v.window.addComment("c", path, 2, "  return 43;", label + " rename this", 2, 2, null, "  return 43;");
    assert.equal(v.window.reviewComments.length, before + 1, "and one that was typed into still saves");
    const saved = v.window.reviewComments[v.window.reviewComments.length - 1];
    assert.equal(saved.text, label + " rename this",
      "with the anchor kept exactly as written — editing it is how a reviewer redirects a comment");

    v.window.updateComment(saved.seq, label + "   ");
    assert.ok(!v.window.reviewComments.some((c) => c.seq === saved.seq),
      "editing one down to just its anchor removes it, as editing it down to nothing does");
  } finally {
    v.close();
  }
});
