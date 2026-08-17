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
    { kind: "c", line: 5, text: "why a CLI and not a library?" },
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
  // one review-comment kind: the card carries mc-c whether it asks a question or requests a change
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

// The hand-off to a terminal pane needs a visible way in: the "Send to terminal" button was dropped when the
// question/change-request panels were unified, leaving only an ⌥⏎ that was scoped to a focused card, so the
// pane picker looked like a feature that had been removed.
test("the merged panel hands the prompt to the terminal by button and by Opt+Enter", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("send me to a pane");

  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text), paneCount: () => 1 };

  await v.openMergedView();
  const button = v.$("#mc-merged-panel .mc-send-terminal");
  assert.ok(button && !button.disabled, "the merged panel offers Send to terminal");
  button.click();
  await v.settle(20);
  assert.equal(sent.length, 1, "clicking it stages the prompt in the pane picker");
  assert.match(sent[0], /send me to a pane/);

  await v.openMergedView();
  const panel = v.$("#mc-merged-panel");
  panel.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await v.settle(20);
  assert.equal(sent.length, 2, "Opt+Enter works from the panel, not only from a selected card");
  v.close();
});

// The document is already on disk in the workspace the agent is standing in, so sending a copy of it through
// the composer was sending the review twice. Once a comment carried a few quoted turns that copy ran to
// kilobytes — the exact pain that made this a path instead of a paste.
test("the terminal hand-off carries the request file's path, not the request", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("c");
  await v.writeAndSave("rename this to something honest");

  const sent = [];
  const written = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text), paneCount: () => 1 };
  v.window.annotationsPath = "/w/.git/kakapo/comments.jsonl"; // normally set by kakapoComments.read()
  v.window.kakapoComments = {
    writeRequest: (text) => { written.push(text); return Promise.resolve({ ok: true, path: "/w/.git/kakapo/request.md" }); },
  };

  await v.openMergedView();
  v.$("#mc-merged-panel .mc-send-terminal").click();
  await v.settle(20);

  assert.equal(sent.length, 1, "one hand-off staged in the pane picker");
  assert.match(sent[0], /\/w\/\.git\/kakapo\/request\.md$/, "what reaches the pane names the file");
  assert.doesNotMatch(sent[0], /rename this to something honest/, "…and does not repeat the review into it");
  assert.match(written[0], /rename this to something honest/, "the request itself went to the file");
  assert.match(written[0], /append ONE line per answer/, "answers-file instructions travel inside it, not in the pane");

  // No file to write to (a non-git root, or the CLI's browser viewer): the document still has to arrive.
  v.window.kakapoComments = { writeRequest: () => Promise.resolve({ ok: false }) };
  await v.openMergedView();
  v.$("#mc-merged-panel .mc-send-terminal").click();
  await v.settle(20);
  assert.match(sent[1], /rename this to something honest/, "with nowhere to park it, the document goes over as text");
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

// Backspace acts on the SELECTED turn, not on everything sharing the line: a thread's question, its
// follow-ups and the agent's notes all live in one row, and taking the whole conversation out on one keypress
// is not what "delete this comment" means. Cmd+Z still restores whatever that press removed.
test("Backspace removes the selected turn only, and Cmd+Z restores it", async () => {
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
  assert.deepEqual(v.storedComments().map((c) => c.text), ["second on this line"], "only the selected card is gone");

  v.key("z", { metaKey: true, code: "KeyZ" });
  await v.settle(20);
  assert.deepEqual(v.storedComments().map((c) => c.text).sort(), ["first on this line", "second on this line"], "undo brings it back");
  v.close();
});

// Arrow keys used to step off the whole row, so the second turn of a thread could be neither selected nor
// edited: `e` always reopened the first comment on the line.
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
  v.click(v.$("#source-body .mc-reply-stub"));
  await v.settle(40);
  await v.writeAndSave("the follow-up");
  await v.settle(60);

  v.window.selectCommentRow(v.$("#source-body .mc-comment-row"));
  await v.settle(20);
  assert.match(v.$("#source-body .mc-card-selected .mc-card-body")?.textContent || "", /the question/, "selection starts on the first turn");

  v.key("ArrowDown");
  await v.settle(20);
  assert.match(v.$("#source-body .mc-card-selected .mc-card-body")?.textContent || "", /the answer/, "ArrowDown steps to the next turn instead of off the row");

  v.key("ArrowDown");
  await v.settle(20);
  assert.match(v.$("#source-body .mc-card-selected .mc-card-body")?.textContent || "", /the follow-up/, "…and on to the one after it");

  v.key("e", { code: "KeyE" });
  await v.settle(60);
  assert.equal(v.visibleComposerInput()?.value, "the follow-up", "`e` edits the selected turn, not the first comment on the line");
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

// GitHub issue #9: the merged prompt panel is a single unified hand-off. Questions and change requests used
// to be two kinds in two sections; they are one comment now, so the document is one contract and one list.
test("unified merged prompt: every open comment shares one document behind one contract", async () => {
  const v = await loadViewer(html);
  v.window.addComment("c", "AGENTS.md", 5, "", "why this wording?");
  v.window.addComment("c", "src/app.ts", 1, "", "simplify this");

  const merged = v.window.buildMergedText();
  const t = v.window.t;
  const planContractAt = merged.indexOf(t("plan.contract"));
  const contractAt = merged.indexOf(t("mergePrompt.default.c"));
  const askAt = merged.indexOf("why this wording?");
  const changeAt = merged.indexOf("simplify this");
  assert.ok(
    planContractAt >= 0 && planContractAt < contractAt && contractAt < askAt && askAt < changeAt,
    "document order is: plan contract -> review-comment contract -> the comments, in review order",
  );
  assert.equal(merged.indexOf(t("mergePrompt.default.c"), contractAt + 1), -1, "one contract, not one per comment");
  v.close();
});

test("unified merged prompt: no open comments means no contract at all", async () => {
  const v = await loadViewer(html);
  const t = v.window.t;
  assert.ok(!v.window.buildMergedText().includes(t("mergePrompt.default.c")), "an empty review is a blank scratch document");

  v.window.addComment("c", "src/app.ts", 1, "", "only this one");
  assert.ok(v.window.buildMergedText().includes(t("mergePrompt.default.c")), "the contract appears once there is something to hand off");

  v.window.deleteComment(v.storedComments()[0].seq);
  assert.ok(!v.window.buildMergedText().includes(t("plan.contract")), "and goes away again with the last comment");
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

// The thread file is written on every comment change, not only when the hand-off panel sends a prompt. A
// follow-up typed afterwards used to live only inside the app: an agent re-reading the file found the round
// it was handed and nothing past it, so the reply was unanswerable.
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
  await v.settle(400); // the write is debounced
  assert.deepEqual(Array.from(writes.at(-1)?.records ?? [], (r) => r.text), ["why is this a CLI?"],
    "the question is in the file already");

  v.agentSays({ re: v.storedComments()[0].seq, text: "It ships as one binary." });
  await v.settle(60);
  v.click(v.$("#source-body .mc-reply-stub"));
  await v.settle(40);
  await v.writeAndSave("then why not a library too?");
  await v.settle(400);

  const records = Array.from(writes.at(-1).records);
  assert.deepEqual(records.map((r) => r.text),
    ["why is this a CLI?", "It ships as one binary.", "then why not a library too?"],
    "…and so is every turn after it, in order");
  assert.equal(records[1].by, "agent", "each line says who wrote it");
  assert.equal(records[2].re, records[1].id, "and what it continues — the last turn, not the first");
  assert.equal(records[2].path, undefined, "a reply inherits its parent's anchor instead of repeating it");
  v.close();
});

// An agent answering a comment is the most precise "it finished" signal kakapo has, so it rides the same
// notification path the terminal bell already uses. What it must not do is announce old answers: reopening a
// review re-reads the whole file, and every one of those would otherwise arrive as news.
test("an agent's answer raises a notification, but re-reading the thread does not", async () => {
  const v = await loadViewer(html);
  const bells = [];
  v.window.kakapoPty = { bell: (msg) => bells.push(msg) };
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
  // Clicking the notification has to land ON that exchange; "an answer arrived" is little use in a review of
  // fifty comments without "here". Main sends the seq straight back (kakapo:comments-reveal).
  const answered = v.storedComments().find((c) => c.by === "agent");
  assert.equal(bells[0].seq, answered.seq, "the notification names the turn it is about");
  await v.openSourceFile("src/app.ts"); // look away, the way you would have while it worked
  await v.settle(40);
  assert.equal(v.window.revealComment(answered.seq), true, "and that id is enough to go back to it");
  await v.settle(80);
  assert.equal(v.$("#source-viewer").dataset.openPath, "AGENTS.md", "the file the exchange is in is open again");

  // The same list arriving again (a poll tick, a workspace switch, a reload) is not a second answer.
  v.window.applyThreadRecords(v.window.reviewComments.map(v.window.commentToRecord));
  await v.settle(60);
  assert.equal(bells.length, 1, "an unchanged thread stays quiet");

  // The setting lives in the Electron settings bridge, the same one the terminal bell reads.
  v.window.kakapoSettings = { all: { "kakapo-terminal-bell-notify": false } };
  v.agentSays({ re: v.storedComments()[0].seq, text: "one more thing" });
  await v.settle(60);
  assert.equal(bells.length, 1, "and the setting turns it off");
  v.close();
});

// Every thread ends in the box for its next turn, attached under the last card the way GitHub puts "Write a
// reply" under a comment. It used to appear only once the thread was already an exchange, so a comment you
// had just written offered no way onward except finding the ↩ button in its header.
test("a thread keeps a box open for the next turn, from the very first comment", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("why is this a CLI?");
  await v.settle(60);
  assert.ok(v.$("#source-body .mc-reply-stub"), "the box for the next turn is there as soon as the comment is");

  v.agentSays({ re: v.storedComments()[0].seq, text: "It ships as one binary." });
  await v.settle(60);
  const stub = v.$("#source-body .mc-reply-stub");
  assert.ok(stub, "…and it is still there after the agent answers, at the end of the thread");

  v.click(stub);
  await v.settle(60);
  assert.ok(v.visibleComposerInput(), "clicking it opens the composer, without hunting for the ↩ button");
  await v.writeAndSave("then why not a library too?");
  await v.settle(60);
  const stored = v.storedComments();
  assert.equal(stored.length, 3, "the question, the agent's answer, and what you typed");
  assert.equal(stored[2].replyTo, stored[1].seq, "…continuing the thread rather than starting a new one");
  v.close();
});

// A diagram in an ANSWER is an agent-written markdown body exactly like a note is. The Mermaid render pass
// used to run only when the review also had notes, so in a review with none the diagram sat on "loading…"
// forever.
test("a diagram in an agent's answer is rendered, in a review with no notes at all", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSave("how does the hand-off flow?");
  await v.settle(60);

  const passes = [];
  v.window.renderMermaidDiagrams = function (root) { passes.push(root); }; // the real one needs the lazy-loaded lib
  v.agentSays({ re: v.storedComments()[0].seq, text: "Like this:\n\n```mermaid\ngraph TD\n  A-->B\n```\n" });
  await v.settle(60);

  assert.equal(v.window.annotationList().length, 0, "no agent notes in this review — only a reply");
  assert.ok(v.$("#source-body .mc-card.mc-ai .explain-mermaid"), "the fence became a diagram placeholder in the reply");
  assert.ok(passes.length, "…and a render pass ran over it instead of leaving it on 'loading…'");
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
  // An agent writes markdown; escaping it put "**one binary**" and the list markers on screen literally.
  v.agentSays({ re: seq, text: "Because it ships as **one binary**.\n\n1. warm start\n2. comparison\n" });
  await v.settle(60);

  const thread = v.$("#source-body .mc-card.mc-ai .mc-ai-body");
  assert.ok(thread, "the answer is its own card in the thread");
  assert.match(thread.textContent, /Because it ships as one binary\./, "the answer text is there");
  assert.equal(thread.querySelector("strong")?.textContent, "one binary", "…with its markdown rendered, not escaped");
  assert.equal(thread.querySelectorAll("ol > li").length, 2, "…including lists");
  assert.doesNotMatch(thread.textContent, /\*\*/, "no raw markdown syntax leaks through");

  await v.openMergedView();
  const card = v.$(".mc-merged-card");
  assert.ok(card, "merged card rendered");
  assert.equal(v.$all('.mc-merged-card').length, 1, 'the agent own reply is not an item in the hand-off');
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
  v.agentSays({ re: seq, text: "It ships as one binary." });
  await v.settle(60);

  const replyBtn = v.$("#source-body .mc-reply-stub");
  assert.ok(replyBtn, "an answered thread ends in the box for its next turn, so the exchange isn't a dead end");
  replyBtn.click();
  await v.settle(60);
  assert.ok(v.visibleComposerInput(), "reply composer opened without re-selecting the code line");
  await v.writeAndSave("then why not a library too?");
  await v.settle(60);

  const stored = v.storedComments();
  assert.equal(stored.length, 3, "the question, the agent's answer, and the follow-up");
  const reply = stored[2];
  assert.equal(reply.replyTo, stored[1].seq, "linked to the answer it follows");
  assert.equal(reply.kind, "c", "a follow-up is the same one review-comment kind as what it continues");
  assert.equal(reply.line, stored[0].line, "and stays anchored to the same line, so it renders as one thread");

  // The exchange reaches the agent as ids into the thread file, not as quoted text: a third round would
  // otherwise re-send the question and the agent's own answer alongside every other comment in the review.
  const merged = v.window.buildMergedText();
  assert.match(merged, new RegExp(`#${stored[0].seq}, #${stored[1].seq}`), "the hand-off names the turns it continues");
  assert.doesNotMatch(merged, /It ships as one binary\./, "…without re-sending the agent its own answer");
  assert.equal((merged.match(/why is this a CLI\?/g) || []).length, 1,
    "the question appears once, as its own open item — not a second time quoted under the follow-up");
  assert.match(merged, /then why not a library too\?/, "and the follow-up itself is inline");
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

// A card rendered inline is already sitting on the line it is about, in the file it is about. Repeating
// "@path#L42" in its header restates the two things the reader can see, and takes up to 62% of the head
// doing it. The range case above keeps its label, because a card anchored at one line cannot show ten.
test("a saved card drops the location it is already sitting on", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  assert.ok(v.$(".mc-composer .mc-target"), "the composer still says where this will attach, before it exists");

  await v.writeAndSave("why this line");
  const card = v.$("#source-body .mc-card:not(.mc-composer)");
  assert.match(card.textContent, /why this line/, "the comment is saved and on screen");
  assert.equal(card.querySelector(".mc-target"), null, "but its header no longer repeats the line it sits on");

  await v.openMergedView();
  assert.ok(v.$(".mc-merged-card .mc-target"), "the dock still labels every card — there the code is not beside it");
  v.close();
});
